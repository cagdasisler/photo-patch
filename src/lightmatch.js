'use strict';

// Match light: makes a pasted piece look lit the way the spot it sits on is lit.
//
// Light multiplies a surface's own color, so the work happens in linear light on a
// log scale, where a change of lighting is a smooth field h added to the piece:
//
//   result = piece × exp(h)
//
// Along the piece's edges, h is the difference between how the surroundings where
// the piece now sits are lit and how the surroundings where it was copied were lit,
// per color channel: a sunny, warm edge brightens and warms that side, a cool shaded
// edge darkens and cools it. Inside, h is the smoothest surface that meets those
// edges (a harmonic membrane, the idea behind seamless cloning and the healing
// brush). Only the ring around the piece is trusted: the pixels underneath are
// usually what the piece is there to hide.
//
// Because the change is a multiplication, texture keeps its relative contrast, so a
// piece moved into sunlight gets brighter highlights and deeper texture, not a gray
// wash. Darkening also hides the piece's camera grain, so matching grain is put back.
//
// Pieces with see-through parts (signatures, ink) are treated as ink on the surface
// instead: they multiply with what's underneath, so they darken in shade and pick
// up the paper's tint and texture.
//
// Everything works on plain { width, height, data } pixel objects, so it runs the
// same in the page and in tests.

const LightMatch = (() => {
  const MARGIN = 40; // pixels of surroundings the caller passes around the piece
  const EPS = 0.004; // keeps logs of near-black pixels from blowing up
  const MAX_GRID = 192; // the light field is smooth, so it is solved on at most this many points a side
  const MIN_SIDE = 4;
  const MAX_SHIFT = 3; // largest brightness change on the log scale (about 20×)
  const MAX_TINT = 0.6; // largest warm–cool change on the log scale
  const MAX_GREEN = 0.12; // largest green–magenta change light makes
  const MAX_GREEN_JUMP = 0.25; // more than this, and it's a different material
  const MAX_GRAIN = 8;

  const toLinear = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    toLinear[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }

  const ENCODE_STEPS = 4096;
  const toSrgb = new Float32Array(ENCODE_STEPS + 1);
  for (let i = 0; i <= ENCODE_STEPS; i++) {
    const v = i / ENCODE_STEPS;
    toSrgb[i] = 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /* ---------------------------------------------------------------------- */
  /* The ring around the piece                                              */
  /* ---------------------------------------------------------------------- */

  // Edge pixels of a w×h box, clockwise from the top-left corner, each with the
  // direction pointing out of the box (corners point out diagonally).
  function perimeter(w, h) {
    const pts = [];
    const add = (x, y) => pts.push({ x, y, nx: x === 0 ? -1 : x === w - 1 ? 1 : 0, ny: y === 0 ? -1 : y === h - 1 ? 1 : 0 });
    for (let x = 0; x < w; x++) add(x, 0);
    for (let y = 1; y < h; y++) add(w - 1, y);
    for (let x = w - 2; x >= 0; x--) add(x, h - 1);
    for (let y = h - 2; y >= 1; y--) add(0, y);
    return pts;
  }

  // Index into perimeter() of an edge pixel.
  function perimeterIndex(x, y, w, h) {
    if (y === 0) return x;
    if (x === w - 1) return w - 1 + y;
    if (y === h - 1) return 2 * (w - 1) + (h - 1) - x;
    return 2 * (w - 1) + 2 * (h - 1) - y;
  }

  // Typical linear color of a short band of pixels at each edge point, `depth`
  // pixels deep: inward from the edge pixel when `from` is 0, otherwise outward
  // starting `from` pixels outside the piece. The piece's pixel (x, y) is at
  // (x + offset, y + offset) in `img`. A median, so a thin line running along the
  // edge (a seam, a crack, grout) doesn't pass for shadow. Transparent or missing
  // pixels don't count; a point with too few left is marked unusable. Only points
  // marked in `only` are looked at, when it's given.
  function bandMeans(img, offset, pts, depth, from, only = null) {
    const { width: W, height: H, data } = img;
    const n = pts.length;
    const mean = new Float32Array(n * 3);
    const ok = new Uint8Array(n);
    const band = [new Float32Array(depth), new Float32Array(depth), new Float32Array(depth)];
    for (let i = 0; i < n; i++) {
      if (only && !only[i]) continue;
      const p = pts[i];
      let count = 0;
      for (let k = 0; k < depth; k++) {
        const step = from > 0 ? from + k : -k;
        const X = p.x + offset + p.nx * step;
        const Y = p.y + offset + p.ny * step;
        if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
        const j = (Y * W + X) * 4;
        if (data[j + 3] < 128) continue;
        band[0][count] = toLinear[data[j]];
        band[1][count] = toLinear[data[j + 1]];
        band[2][count] = toLinear[data[j + 2]];
        count++;
      }
      if (count * 2 < depth) continue;
      ok[i] = 1;
      for (let c = 0; c < 3; c++) {
        const sorted = band[c].subarray(0, count).sort();
        mean[i * 3 + c] = count % 2 ? sorted[count >> 1] : (sorted[count / 2 - 1] + sorted[count / 2]) / 2;
      }
    }
    return { mean, ok };
  }

  // The lighting change wanted at each edge point, per channel, on the log scale.
  //
  // Real light changes color along the warm–cool line (sun and shade, lamps and
  // daylight, sunsets), barely ever toward green or magenta. So the change is split
  // into brightness, warm–cool and green–magenta: a big green–magenta jump means
  // the surroundings there are a different thing (grass, a bin, a shirt), not
  // different light, and that edge point is left out, to be filled in from the rest.
  function edgeShift(dst, src, n) {
    const shift = new Float32Array(n * 3);
    const ok = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (!dst.ok[i] || !src.ok[i]) continue;
      const r = Math.log(dst.mean[i * 3] + EPS) - Math.log(src.mean[i * 3] + EPS);
      const g = Math.log(dst.mean[i * 3 + 1] + EPS) - Math.log(src.mean[i * 3 + 1] + EPS);
      const b = Math.log(dst.mean[i * 3 + 2] + EPS) - Math.log(src.mean[i * 3 + 2] + EPS);
      const avg = (r + g + b) / 3;
      const greenness = g - avg;
      if (Math.abs(greenness) > MAX_GREEN_JUMP) continue;
      ok[i] = 1;
      const level = clamp(avg, -MAX_SHIFT, MAX_SHIFT);
      const warm = clamp((r - b) / 2, -MAX_TINT, MAX_TINT);
      const green = clamp(greenness, -MAX_GREEN, MAX_GREEN) / 2;
      shift[i * 3] = level + warm - green;
      shift[i * 3 + 1] = level + 2 * green;
      shift[i * 3 + 2] = level - warm - green;
    }
    return { shift, ok };
  }

  // Smooths the edge values around the loop. A median first throws out short
  // runs that disagree with their neighbors (a stick, a stone, the tip of the
  // thing being covered); a light blur then evens out texture.
  function smoothAroundLoop(values, ok, n, radius, sigma) {
    const med = new Float32Array(n * 3);
    const window = new Float32Array(radius * 2 + 1);
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < n; i++) {
        if (!ok[i]) continue;
        let m = 0;
        for (let k = -radius; k <= radius; k++) {
          const j = (((i + k) % n) + n) % n;
          if (ok[j]) window[m++] = values[j * 3 + c];
        }
        const sorted = window.subarray(0, m).sort();
        med[i * 3 + c] = m % 2 ? sorted[m >> 1] : (sorted[m / 2 - 1] + sorted[m / 2]) / 2;
      }
    }

    const reach = Math.ceil(sigma * 3);
    const weights = [];
    for (let k = -reach; k <= reach; k++) weights.push(Math.exp((-k * k) / (2 * sigma * sigma)));
    const out = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      if (!ok[i]) continue;
      let wsum = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let k = -reach; k <= reach; k++) {
        const j = (((i + k) % n) + n) % n;
        if (!ok[j]) continue;
        const wk = weights[k + reach];
        wsum += wk;
        r += med[j * 3] * wk;
        g += med[j * 3 + 1] * wk;
        b += med[j * 3 + 2] * wk;
      }
      out[i * 3] = r / wsum;
      out[i * 3 + 1] = g / wsum;
      out[i * 3 + 2] = b / wsum;
    }
    return out;
  }

  /* ---------------------------------------------------------------------- */
  /* The membrane                                                           */
  /* ---------------------------------------------------------------------- */

  // Solves for the smooth lighting field on a coarse gw×gh grid laid over the
  // piece. Edge nodes take the averaged edge values under them; edge nodes with no
  // usable surroundings (the piece hangs off the picture) are left free, so the
  // field just carries on smoothly there. Solved coarse to fine: each level starts
  // from the one below it, so a few sweeps per level are enough.
  function solveField(w, h, shift, ok, gw, gh) {
    const n = ok.length;
    // Prefix sums around the loop, so any stretch of edge can be averaged at once.
    const sum = new Float64Array((n + 1) * 3);
    const cnt = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      cnt[i + 1] = cnt[i] + ok[i];
      for (let c = 0; c < 3; c++) sum[(i + 1) * 3 + c] = sum[i * 3 + c] + (ok[i] ? shift[i * 3 + c] : 0);
    }
    const rangeSum = (a, b, c) => sum[b * 3 + c] - sum[a * 3 + c]; // over [a, b)
    const loopAverage = (center, half, out) => {
      let a = center - half;
      let b = center + half + 1;
      let count = 0;
      const acc = [0, 0, 0];
      const take = (lo, hi) => {
        count += cnt[hi] - cnt[lo];
        for (let c = 0; c < 3; c++) acc[c] += rangeSum(lo, hi, c);
      };
      if (b - a >= n) {
        take(0, n);
        b = a + n;
      } else if (a < 0) {
        take(a + n, n);
        take(0, b);
      } else if (b > n) {
        take(a, n);
        take(0, b - n);
      } else {
        take(a, b);
      }
      if (count < (b - a) / 3 || count === 0) return false;
      for (let c = 0; c < 3; c++) out[c] = acc[c] / count;
      return true;
    };

    const levels = [];
    for (let lw = gw, lh = gh; ; lw = Math.max(2, Math.ceil(lw / 2)), lh = Math.max(2, Math.ceil(lh / 2))) {
      levels.push([lw, lh]);
      if (Math.max(lw, lh) <= 12) break;
    }
    levels.reverse();

    let prev = null;
    const tmp = [0, 0, 0];
    for (let li = 0; li < levels.length; li++) {
      const [lw, lh] = levels[li];
      const field = new Float32Array(lw * lh * 3);
      const fixed = new Uint8Array(lw * lh);
      const sx = (w - 1) / (lw - 1);
      const sy = (h - 1) / (lh - 1);

      let anyFixed = false;
      const mean = [0, 0, 0];
      let fixedCount = 0;
      for (let y = 0; y < lh; y++) {
        for (let x = 0; x < lw; x++) {
          if (x !== 0 && y !== 0 && x !== lw - 1 && y !== lh - 1) continue;
          const fx = Math.round(x * sx);
          const fy = Math.round(y * sy);
          const half = Math.floor((x === 0 || x === lw - 1 ? sy : sx) / 2);
          if (!loopAverage(perimeterIndex(fx, fy, w, h), half, tmp)) continue;
          const k = y * lw + x;
          fixed[k] = 1;
          anyFixed = true;
          fixedCount++;
          for (let c = 0; c < 3; c++) {
            field[k * 3 + c] = tmp[c];
            mean[c] += tmp[c];
          }
        }
      }
      if (!anyFixed) return null;

      if (prev) {
        // Start from the coarser solution, stretched to this size.
        const [pw, ph, pf] = prev;
        for (let y = 0; y < lh; y++) {
          const py = (y * (ph - 1)) / (lh - 1);
          const y0 = Math.min(ph - 2, Math.floor(py));
          const ty = py - y0;
          for (let x = 0; x < lw; x++) {
            const k = y * lw + x;
            if (fixed[k]) continue;
            const px = (x * (pw - 1)) / (lw - 1);
            const x0 = Math.min(pw - 2, Math.floor(px));
            const tx = px - x0;
            for (let c = 0; c < 3; c++) {
              const a = pf[(y0 * pw + x0) * 3 + c];
              const b = pf[(y0 * pw + x0 + 1) * 3 + c];
              const d = pf[((y0 + 1) * pw + x0) * 3 + c];
              const e = pf[((y0 + 1) * pw + x0 + 1) * 3 + c];
              field[k * 3 + c] = (a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty;
            }
          }
        }
      } else {
        for (let k = 0; k < lw * lh; k++) {
          if (!fixed[k]) for (let c = 0; c < 3; c++) field[k * 3 + c] = mean[c] / fixedCount;
        }
      }

      const sweeps = Math.min(600, 24 << Math.min(5, levels.length - 1 - li));
      relax(field, fixed, lw, lh, sweeps);
      prev = [lw, lh, field];
    }
    return prev;
  }

  // A smooth membrane softens a hard shadow line running across the piece. But
  // shadows and sunbeams are mostly straight, so if there is one direction along
  // which the light on opposite edges agrees, carry the light straight across in
  // that direction instead: a shadow line that enters on one edge and leaves on
  // another continues, sharp, between them. How sure we are decides how much of
  // this replaces the membrane (none at all when the light is even, or patchy
  // like leaf shadows).
  function directedField(w, h, shift, ok, solved) {
    const [fw, fh, field] = solved;
    const n = ok.length;
    const luma = new Float32Array(n);
    for (let i = 0; i < n; i++) luma[i] = 0.2126 * shift[i * 3] + 0.7152 * shift[i * 3 + 1] + 0.0722 * shift[i * 3 + 2];

    // A shadow line crosses the edge twice, a sunbeam four times. More light/dark
    // changes than that around the edge is patchy light (leaves, clouds), where
    // straight lines would only draw streaks.
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < n; i++) {
      if (!ok[i]) continue;
      lo = Math.min(lo, luma[i]);
      hi = Math.max(hi, luma[i]);
    }
    if (!(hi - lo > 0.1)) return null;
    let side = 0;
    let changes = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) {
        if (!ok[i]) continue;
        const t = (luma[i] - lo) / (hi - lo);
        const now = t > 0.65 ? 1 : t < 0.35 ? -1 : side;
        if (pass === 1 && side !== 0 && now !== side) changes++;
        side = now;
      }
    }
    if (changes > 4) return null;

    // Where a line from (x, y) going (dx, dy) leaves the piece: returns the edge
    // point and leaves the distance to it in `reach`.
    let reach = 0;
    const hit = (x, y, dx, dy) => {
      const tx = dx > 1e-9 ? (w - 1 - x) / dx : dx < -1e-9 ? -x / dx : Infinity;
      const ty = dy > 1e-9 ? (h - 1 - y) / dy : dy < -1e-9 ? -y / dy : Infinity;
      let X;
      let Y;
      if (tx <= ty) {
        reach = tx;
        X = dx > 0 ? w - 1 : 0;
        Y = Math.round(y + tx * dy);
        Y = Y < 0 ? 0 : Y > h - 1 ? h - 1 : Y;
      } else {
        reach = ty;
        Y = dy > 0 ? h - 1 : 0;
        X = Math.round(x + ty * dx);
        X = X < 0 ? 0 : X > w - 1 ? w - 1 : X;
      }
      return perimeterIndex(X, Y, w, h);
    };

    // How much the two ends of each line disagree, for lines through a spread of
    // points inside the piece.
    const samples = [];
    const sn = 13;
    for (let j = 1; j < sn; j++) for (let i = 1; i < sn; i++) samples.push([(i * (w - 1)) / sn, (j * (h - 1)) / sn]);
    const disagreement = (angle) => {
      const dx = Math.cos(angle);
      const dy = Math.sin(angle);
      let sum = 0;
      let count = 0;
      for (const [x, y] of samples) {
        const a = hit(x, y, dx, dy);
        const b = hit(x, y, -dx, -dy);
        if (!ok[a] || !ok[b]) continue;
        const d = luma[a] - luma[b];
        sum += d * d;
        count++;
      }
      return count >= samples.length / 4 ? sum / count : Infinity;
    };

    const scores = [];
    let best = 0;
    for (let k = 0; k < 60; k++) {
      scores.push(disagreement((k * Math.PI) / 60));
      if (scores[k] < scores[best]) best = k;
    }
    let angle = (best * Math.PI) / 60;
    let low = scores[best];
    for (let k = -5; k <= 5; k++) {
      const a = angle + (k * Math.PI) / 360;
      const s = disagreement(a);
      if (s < low) {
        low = s;
        angle = a;
      }
    }
    const finite = scores.filter(Number.isFinite).sort((a, b) => a - b);
    if (finite.length < 10 || !Number.isFinite(low)) return null;
    const typical = finite[finite.length >> 1];
    // Light varies by at least ~10% across the edges, and one direction explains
    // it far better than a typical one.
    const sure = clamp((typical - 0.004) / 0.02, 0, 1) * clamp(1 - low / (0.45 * typical), 0, 1);
    if (sure < 0.05) return null;

    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const out = new Float32Array(field);
    for (let gy = 0; gy < fh; gy++) {
      for (let gx = 0; gx < fw; gx++) {
        const x = (gx * (w - 1)) / (fw - 1);
        const y = (gy * (h - 1)) / (fh - 1);
        const a = hit(x, y, dx, dy);
        const ta = reach;
        const b = hit(x, y, -dx, -dy);
        const tb = reach;
        const k = (gy * fw + gx) * 3;
        for (let c = 0; c < 3; c++) {
          let v;
          if (ok[a] && ok[b]) v = (shift[a * 3 + c] * tb + shift[b * 3 + c] * ta) / (ta + tb || 1);
          else if (ok[a]) v = shift[a * 3 + c];
          else if (ok[b]) v = shift[b * 3 + c];
          else continue;
          out[k + c] = field[k + c] + sure * (v - field[k + c]);
        }
      }
    }
    return [fw, fh, out];
  }

  // Red-black over-relaxation: each free node moves toward the average of its
  // neighbors on the grid (a free edge node just uses the neighbors it has).
  function relax(field, fixed, w, h, sweeps) {
    const omega = Math.min(1.9, 2 / (1 + Math.sin(Math.PI / Math.max(w, h))));
    for (let s = 0; s < sweeps; s++) {
      for (let parity = 0; parity < 2; parity++) {
        for (let y = 0; y < h; y++) {
          for (let x = (y + parity) & 1; x < w; x += 2) {
            const k = y * w + x;
            if (fixed[k]) continue;
            let n = 0;
            let r = 0;
            let g = 0;
            let b = 0;
            if (x > 0) {
              const j = (k - 1) * 3;
              r += field[j];
              g += field[j + 1];
              b += field[j + 2];
              n++;
            }
            if (x < w - 1) {
              const j = (k + 1) * 3;
              r += field[j];
              g += field[j + 1];
              b += field[j + 2];
              n++;
            }
            if (y > 0) {
              const j = (k - w) * 3;
              r += field[j];
              g += field[j + 1];
              b += field[j + 2];
              n++;
            }
            if (y < h - 1) {
              const j = (k + w) * 3;
              r += field[j];
              g += field[j + 1];
              b += field[j + 2];
              n++;
            }
            const i = k * 3;
            field[i] += omega * (r / n - field[i]);
            field[i + 1] += omega * (g / n - field[i + 1]);
            field[i + 2] += omega * (b / n - field[i + 2]);
          }
        }
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Grain                                                                  */
  /* ---------------------------------------------------------------------- */

  // Camera grain level, in 0–255 steps, from a 3×3 filter that cancels smooth
  // shading and straight edges (Immerkær). The median keeps texture and edges from
  // counting as grain.
  // Brightness of each pixel, 0–255; see-through pixels are NaN.
  function lumaOf(img) {
    const { width: w, height: h, data } = img;
    const luma = new Float32Array(w * h);
    for (let p = 0, i = 0; p < w * h; p++, i += 4) {
      luma[p] = data[i + 3] < 128 ? NaN : 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    return luma;
  }

  function grainLevel(img, include, maxSamples = 40000) {
    const { width: W, height: H } = img;
    const L = lumaOf(img);
    const total = Math.max(1, (W - 2) * (H - 2));
    const stride = Math.max(1, Math.round(Math.sqrt(total / maxSamples)));
    const values = new Float32Array(Math.ceil((W - 2) / stride + 1) * Math.ceil((H - 2) / stride + 1));
    let count = 0;
    for (let y = 1; y < H - 1; y += stride) {
      for (let x = 1; x < W - 1; x += stride) {
        if (!include(x, y)) continue;
        const a = (y - 1) * W + x;
        const b = a + W;
        const c = b + W;
        const v = L[a - 1] - 2 * L[a] + L[a + 1] - 2 * L[b - 1] + 4 * L[b] - 2 * L[b + 1] + L[c - 1] - 2 * L[c] + L[c + 1];
        if (v === v) values[count++] = v < 0 ? -v : v;
      }
    }
    if (count < 32) return NaN;
    const sorted = values.subarray(0, count).sort();
    // For pure noise the filter's output spread is 6× the noise; the median of
    // its size is 0.6745 of that spread.
    return sorted[sorted.length >> 1] / (6 * 0.6745);
  }

  // Repeatable noise: the same piece gets the same grain every time it's drawn.
  function hash(x, y, seed) {
    let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 2147483647)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  function gaussian(x, y, seed) {
    // Four uniforms add up to a close-enough bell curve, scaled to a spread of 1.
    return (hash(x, y, seed) + hash(x, y, seed + 1) + hash(x, y, seed + 2) + hash(x, y, seed + 3) - 2) * 1.7320508;
  }

  // Edge-preserving smoothing: each pixel averages with nearby pixels of similar
  // brightness, so grain fades while texture and edges stay.
  function smoothGrain(img, grain) {
    const { width: w, height: h, data } = img;
    const luma = lumaOf(img);
    const near = new Float32Array(256);
    const range = Math.max(1, grain * 2.5);
    for (let d = 0; d < 256; d++) near[d] = Math.exp((-d * d) / (2 * range * range));
    const space = new Float32Array(25);
    for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) space[(j + 2) * 5 + i + 2] = Math.exp(-(i * i + j * j) / (2 * 1.2 * 1.2));

    const out = new Uint8ClampedArray(data);
    for (let y = 0; y < h; y++) {
      const j0 = Math.max(-2, -y);
      const j1 = Math.min(2, h - 1 - y);
      for (let x = 0; x < w; x++) {
        const i0 = Math.max(-2, -x);
        const i1 = Math.min(2, w - 1 - x);
        const p = y * w + x;
        const center = luma[p];
        let wsum = 0;
        let r = 0;
        let g = 0;
        let b = 0;
        for (let j = j0; j <= j1; j++) {
          const row = p + j * w;
          const srow = (j + 2) * 5 + 2;
          for (let i = i0; i <= i1; i++) {
            const q = row + i;
            const d = luma[q] - center;
            const wt = space[srow + i] * near[d < 0 ? (-d < 255 ? -d | 0 : 255) : d < 255 ? d | 0 : 255];
            const k = q * 4;
            r += data[k] * wt;
            g += data[k + 1] * wt;
            b += data[k + 2] * wt;
            wsum += wt;
          }
        }
        const k = p * 4;
        out[k] = r / wsum;
        out[k + 1] = g / wsum;
        out[k + 2] = b / wsum;
      }
    }
    return { width: w, height: h, data: out };
  }

  // Brightening a piece also brightens its grain, and darkening hides it. Keep the
  // piece as grainy, compared with its surroundings, as it was where it was copied:
  // smooth extra grain away, or add matching grain back.
  function matchGrain(result, patch, dest, source, seed, strength) {
    const { width: w, height: h, data } = result;
    const inRing = (x, y) => x < MARGIN || y < MARGIN || x >= w + MARGIN || y >= h + MARGIN;
    const everywhere = () => true;
    const there = grainLevel(dest, inRing);
    const before = grainLevel(patch, everywhere);
    const now = grainLevel(result, everywhere);
    const sourceRing = source ? grainLevel(source, inRing) : NaN;
    if (!(there > 0.2 && before > 0.2 && now > 0.2)) return;
    let target = sourceRing > 0.2 ? there * clamp(before / sourceRing, 0.5, 2) : before;
    target = before + strength * (target - before);
    target = clamp(target, now * 0.35, now + MAX_GRAIN);

    if (now > target * 1.1) {
      const smoothed = smoothGrain(result, now);
      const after = grainLevel(smoothed, everywhere);
      if (!(after < now)) return;
      const mix = clamp((now - target) / (now - after), 0, 1);
      for (let i = 0; i < data.length; i += 4) {
        for (let c = 0; c < 3; c++) data[i + c] += mix * (smoothed.data[i + c] - data[i + c]);
      }
    } else if (now < target * 0.9) {
      const add = Math.sqrt(target * target - now * now);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const v = gaussian(x, y, seed) * add;
          const i = (y * w + x) * 4;
          data[i] += v;
          data[i + 1] += v;
          data[i + 2] += v;
        }
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Light and shadow under the piece                                       */
  /* ---------------------------------------------------------------------- */

  // Square max (or min) filter over valid cells, row pass then column pass.
  function squareFilter(src, valid, w, h, radius, pickMax) {
    const pass = (from, horizontal) => {
      const to = new Float32Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let best = pickMax ? -Infinity : Infinity;
          for (let k = -radius; k <= radius; k++) {
            const X = horizontal ? x + k : x;
            const Y = horizontal ? y : y + k;
            if (X < 0 || Y < 0 || X >= w || Y >= h || !valid[Y * w + X]) continue;
            const v = from[Y * w + X];
            if (pickMax ? v > best : v < best) best = v;
          }
          to[y * w + x] = Number.isFinite(best) ? best : from[y * w + x];
        }
      }
      return to;
    };
    return pass(pass(src, true), false);
  }

  // The pattern of light and shadow under the piece (dappled sun, a shadow that
  // falls entirely inside it), as a brightness change on the log scale relative to
  // the smooth light its edges already account for. Small dark things (text,
  // cracks, a stain) are closed over, so they don't pass for shadow; light and
  // shadow shapes bigger than that are kept. Returns a lookup by piece pixel, or
  // null if the piece is too small to have a pattern.
  function lightUnder(dest, w, h) {
    const { width: W, height: H, data } = dest;
    const short = Math.min(w, h);
    const b = Math.max(1, Math.round(short / 64));
    const bw = Math.ceil(W / b);
    const bh = Math.ceil(H / b);

    // Each block's brightness: the upper-middle of its pixels, leaning toward the
    // surface rather than marks on it.
    const level = new Float32Array(bw * bh);
    const valid = new Uint8Array(bw * bh);
    const values = new Float32Array(b * b);
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        let count = 0;
        for (let y = by * b; y < Math.min(H, (by + 1) * b); y++) {
          for (let x = bx * b; x < Math.min(W, (bx + 1) * b); x++) {
            const j = (y * W + x) * 4;
            if (data[j + 3] < 128) continue;
            values[count++] = Math.log(0.2126 * toLinear[data[j]] + 0.7152 * toLinear[data[j + 1]] + 0.0722 * toLinear[data[j + 2]] + EPS);
          }
        }
        if (count * 2 < b * b) continue;
        const sorted = values.subarray(0, count).sort();
        level[by * bw + bx] = sorted[Math.min(count - 1, Math.floor(count * 0.75))];
        valid[by * bw + bx] = 1;
      }
    }

    // Close over small dark marks: spread the bright, then shrink it back.
    const reach = Math.max(1, Math.round(Math.max(3, short / 20) / b));
    let closed = squareFilter(squareFilter(level, valid, bw, bh, reach, true), valid, bw, bh, reach, false);
    // A touch of blur, so shadow edges stay crisp but not blocky.
    const soft = new Float32Array(closed);
    for (let y = 1; y < bh - 1; y++) {
      for (let x = 1; x < bw - 1; x++) {
        const k = y * bw + x;
        if (!valid[k] || !valid[k - 1] || !valid[k + 1] || !valid[k - bw] || !valid[k + bw]) continue;
        soft[k] = (4 * closed[k] + closed[k - 1] + closed[k + 1] + closed[k - bw] + closed[k + bw]) / 8;
      }
    }
    closed = soft;

    // The blocks over the piece itself.
    const x0 = Math.ceil(MARGIN / b - 0.5);
    const y0 = Math.ceil(MARGIN / b - 0.5);
    const x1 = Math.min(bw - 1, Math.floor((MARGIN + w) / b - 0.5 - 1e-6));
    const y1 = Math.min(bh - 1, Math.floor((MARGIN + h) / b - 0.5 - 1e-6));
    const rw = x1 - x0 + 1;
    const rh = y1 - y0 + 1;
    if (rw < 3 || rh < 3) return null;

    // The smooth light the edges already explain: a membrane over the edge blocks.
    const smooth = new Float32Array(rw * rh);
    const fixed = new Uint8Array(rw * rh);
    let edgeSum = 0;
    let edgeCount = 0;
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        if (x !== 0 && y !== 0 && x !== rw - 1 && y !== rh - 1) continue;
        const k = (y + y0) * bw + x + x0;
        if (!valid[k]) continue;
        fixed[y * rw + x] = 1;
        smooth[y * rw + x] = closed[k];
        edgeSum += closed[k];
        edgeCount++;
      }
    }
    if (!edgeCount) return null;
    for (let k = 0; k < rw * rh; k++) if (!fixed[k]) smooth[k] = edgeSum / edgeCount;
    const omega = Math.min(1.9, 2 / (1 + Math.sin(Math.PI / Math.max(rw, rh))));
    for (let s = 0; s < 400; s++) {
      for (let parity = 0; parity < 2; parity++) {
        for (let y = 0; y < rh; y++) {
          for (let x = (y + parity) & 1; x < rw; x += 2) {
            const k = y * rw + x;
            if (fixed[k]) continue;
            let sum = 0;
            let n = 0;
            if (x > 0) (sum += smooth[k - 1]), n++;
            if (x < rw - 1) (sum += smooth[k + 1]), n++;
            if (y > 0) (sum += smooth[k - rw]), n++;
            if (y < rh - 1) (sum += smooth[k + rw]), n++;
            smooth[k] += omega * (sum / n - smooth[k]);
          }
        }
      }
    }

    const pattern = new Float32Array(rw * rh);
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        const k = (y + y0) * bw + x + x0;
        if (valid[k]) pattern[y * rw + x] = clamp(closed[k] - smooth[y * rw + x], -MAX_SHIFT, MAX_SHIFT);
      }
    }
    return (px, py) => {
      const u = clamp((px + MARGIN) / b - 0.5 - x0, 0, rw - 1);
      const v = clamp((py + MARGIN) / b - 0.5 - y0, 0, rh - 1);
      const ux = Math.min(rw - 2, Math.floor(u));
      const vy = Math.min(rh - 2, Math.floor(v));
      const tx = u - ux;
      const ty = v - vy;
      const k = vy * rw + ux;
      return (pattern[k] * (1 - tx) + pattern[k + 1] * tx) * (1 - ty) + (pattern[k + rw] * (1 - tx) + pattern[k + rw + 1] * tx) * ty;
    };
  }

  // The piece alone, laid out like the surroundings images (MARGIN of see-through
  // pixels around it), for when there are no surroundings from where it came.
  function padded(patch) {
    const { width: w, height: h } = patch;
    const W = w + 2 * MARGIN;
    const data = new Uint8ClampedArray(W * (h + 2 * MARGIN) * 4);
    for (let y = 0; y < h; y++) data.set(patch.data.subarray(y * w * 4, (y + 1) * w * 4), ((y + MARGIN) * W + MARGIN) * 4);
    return { width: W, height: h + 2 * MARGIN, data };
  }

  // How much each color channel changes per step brighter, read from the edges:
  // where sun and shade both touch the piece, the sunny parts are warmer, and by
  // exactly how much shows here. Used to color the light under the piece.
  function colorPerLevel(shift, ok) {
    let n = 0;
    let ml = 0;
    const mc = [0, 0, 0];
    for (let i = 0; i < ok.length; i++) {
      if (!ok[i]) continue;
      ml += (shift[i * 3] + shift[i * 3 + 1] + shift[i * 3 + 2]) / 3;
      for (let c = 0; c < 3; c++) mc[c] += shift[i * 3 + c];
      n++;
    }
    if (n < 8) return [1, 1, 1];
    ml /= n;
    for (let c = 0; c < 3; c++) mc[c] /= n;
    const cov = [0, 0, 0];
    let vl = 0;
    for (let i = 0; i < ok.length; i++) {
      if (!ok[i]) continue;
      const l = (shift[i * 3] + shift[i * 3 + 1] + shift[i * 3 + 2]) / 3 - ml;
      for (let c = 0; c < 3; c++) cov[c] += l * (shift[i * 3 + c] - mc[c]);
      vl += l * l;
    }
    if (vl < n * 0.01) return [1, 1, 1]; // even light all round: no color to read
    return cov.map((v) => clamp(v / vl, 0.4, 1.6));
  }

  /* ---------------------------------------------------------------------- */
  /* Matching                                                               */
  /* ---------------------------------------------------------------------- */

  function seeThroughShare(patch) {
    const d = patch.data;
    let clear = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] < 250) clear++;
    return clear / (d.length / 4);
  }

  // Ink on a surface: the surface's color multiplies the ink, so dark ink stays
  // dark, and ink in shade or on tinted paper darkens and takes on the tint.
  function matchInk(patch, dest, strength) {
    const { width: w, height: h } = patch;
    const out = new Uint8ClampedArray(patch.data);
    const W = dest.width;
    const keep = 255 / strength - 255; // how much of the ink's own color stays
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const j = ((y + MARGIN) * W + x + MARGIN) * 4;
        if (dest.data[j + 3] < 128) continue;
        out[i] = (patch.data[i] * (dest.data[j] + keep) * strength) / 255;
        out[i + 1] = (patch.data[i + 1] * (dest.data[j + 1] + keep) * strength) / 255;
        out[i + 2] = (patch.data[i + 2] * (dest.data[j + 2] + keep) * strength) / 255;
      }
    }
    return { image: { width: w, height: h, data: out }, gain: 1, warmth: 0, ink: true };
  }

  // patch:  the piece's pixels, w×h.
  // dest:   what is underneath where the piece now sits, with MARGIN pixels of
  //         surroundings on every side ((w + 2·MARGIN) × (h + 2·MARGIN)); pixels
  //         off the picture are transparent.
  // source: the same for where the piece was copied from, or null if it didn't
  //         come from this picture; used to keep its grain in step.
  // seed:     picks the grain pattern.
  // fast:     skip grain matching, for live previews while dragging.
  // strength: 0–1, how far to go toward the new light.
  // under:    also take on the light and shadow pattern under the piece.
  //
  // Returns { image, gain, warmth }: the matched pixels, how much brighter it got
  // on average (2 = twice as bright), and how much warmer (positive) or cooler.
  function match(patch, dest, source, { seed = 1, fast = false, strength = 1, under = false } = {}) {
    const { width: w, height: h } = patch;
    if (w < MIN_SIDE || h < MIN_SIDE || !(strength > 0)) return null;
    strength = Math.min(1, strength);
    if (seeThroughShare(patch) > 0.02) return matchInk(patch, dest, strength);

    const pts = perimeter(w, h);
    const n = pts.length;
    const short = Math.min(w, h);
    const depth = clamp(Math.round(short * 0.08), 3, Math.min(12, MARGIN));

    // How the new surroundings are lit, against how the piece's own outermost
    // pixels are lit: those are what end up next to the surroundings. (The piece's
    // old surroundings could hold anything, like the very thing being covered.)
    const there = bandMeans(dest, MARGIN, pts, depth, 1);
    const here = bandMeans(patch, 0, pts, depth, 0);
    const edge = edgeShift(there, here, n);

    // Where something else sits right against the piece (often the end of the
    // very thing being covered, sticking out), look past it, farther out, for the
    // surface and the light falling on it.
    const blocked = new Uint8Array(n);
    for (let from = depth + 1; from + depth - 1 <= MARGIN; from += depth) {
      let any = false;
      for (let i = 0; i < n; i++) {
        blocked[i] = there.ok[i] && here.ok[i] && !edge.ok[i] ? 1 : 0;
        any ||= blocked[i] === 1;
      }
      if (!any) break;
      const past = edgeShift(bandMeans(dest, MARGIN, pts, depth, from, blocked), here, n);
      for (let i = 0; i < n; i++) {
        if (!blocked[i] || !past.ok[i]) continue;
        edge.ok[i] = 1;
        for (let c = 0; c < 3; c++) edge.shift[i * 3 + c] = past.shift[i * 3 + c];
      }
    }
    const sigma = clamp(short * 0.04, 1.5, 24);
    const smooth = smoothAroundLoop(edge.shift, edge.ok, n, Math.min(32, Math.round(sigma * 1.5)), sigma);

    const step = Math.max(1, Math.max(w, h) / MAX_GRID);
    const gw = Math.max(2, Math.round((w - 1) / step) + 1);
    const gh = Math.max(2, Math.round((h - 1) / step) + 1);
    const solved = solveField(w, h, smooth, edge.ok, gw, gh);
    if (!solved) return null; // nothing around it to match
    // With the light under the piece in play, that pattern already carries any
    // shadow lines, so the plain membrane is the base to add it to.
    const [fw, fh, field] = (!under && directedField(w, h, smooth, edge.ok, solved)) || solved;

    if (under) {
      // Swap the light pattern the piece brought with it for the one where it now
      // sits: take away its own sun spots and shadows, add the new ones.
      const there = lightUnder(dest, w, h);
      const own = lightUnder(source || padded(patch), w, h);
      if (there) {
        const color = colorPerLevel(smooth, edge.ok);
        for (let gy = 0; gy < fh; gy++) {
          for (let gx = 0; gx < fw; gx++) {
            const x = (gx * (w - 1)) / (fw - 1);
            const y = (gy * (h - 1)) / (fh - 1);
            const d = there(x, y) - (own ? own(x, y) : 0);
            const k = (gy * fw + gx) * 3;
            for (let c = 0; c < 3; c++) field[k + c] += d * color[c];
          }
        }
      }
    }
    if (strength < 1) for (let i = 0; i < field.length; i++) field[i] *= strength;

    const gains = new Float32Array(field.length);
    for (let i = 0; i < field.length; i++) gains[i] = Math.exp(field[i]);

    // Where each pixel falls on the coarse grid.
    const col0 = new Int32Array(w);
    const colT = new Float32Array(w);
    for (let x = 0; x < w; x++) {
      const f = (x * (fw - 1)) / (w - 1);
      col0[x] = Math.min(fw - 2, Math.floor(f));
      colT[x] = f - col0[x];
    }

    // Light each pixel: its own color in linear light, times the gain where it
    // sits (blended from the four nearest grid points).
    const src = patch.data;
    const out = new Uint8ClampedArray(w * h * 4);
    const top = ENCODE_STEPS;
    for (let y = 0; y < h; y++) {
      const f = (y * (fh - 1)) / (h - 1);
      const y0 = Math.min(fh - 2, Math.floor(f));
      const ty = f - y0;
      const row0 = y0 * fw;
      const row1 = row0 + fw;
      for (let x = 0; x < w; x++) {
        const x0 = col0[x];
        const tx = colT[x];
        const a = (1 - tx) * (1 - ty);
        const b = tx * (1 - ty);
        const c = (1 - tx) * ty;
        const d = tx * ty;
        const g00 = (row0 + x0) * 3;
        const g10 = (row1 + x0) * 3;
        const i = (y * w + x) * 4;
        const r = toLinear[src[i]] * (gains[g00] * a + gains[g00 + 3] * b + gains[g10] * c + gains[g10 + 3] * d);
        const g = toLinear[src[i + 1]] * (gains[g00 + 1] * a + gains[g00 + 4] * b + gains[g10 + 1] * c + gains[g10 + 4] * d);
        const bl = toLinear[src[i + 2]] * (gains[g00 + 2] * a + gains[g00 + 5] * b + gains[g10 + 2] * c + gains[g10 + 5] * d);
        out[i] = toSrgb[r >= 1 ? top : (r * top + 0.5) | 0];
        out[i + 1] = toSrgb[g >= 1 ? top : (g * top + 0.5) | 0];
        out[i + 2] = toSrgb[bl >= 1 ? top : (bl * top + 0.5) | 0];
        out[i + 3] = src[i + 3];
      }
    }
    const result = { width: w, height: h, data: out };

    if (!fast) matchGrain(result, patch, dest, source, seed, strength);

    // Soften the outermost pixel or two, so the piece's edge doesn't draw a line.
    const feather = clamp(Math.round(short / 60), 1, 3);
    for (let dist = 0; dist < feather; dist++) {
      const t = (dist + 1) / (feather + 1);
      const keep = t * t * (3 - 2 * t);
      const fade = (x, y) => {
        out[(y * w + x) * 4 + 3] *= keep;
      };
      for (let x = dist; x < w - dist; x++) {
        fade(x, dist);
        fade(x, h - 1 - dist);
      }
      for (let y = dist + 1; y < h - 1 - dist; y++) {
        fade(dist, y);
        fade(w - 1 - dist, y);
      }
    }

    // Overall change, for telling the person what happened.
    let lr = 0;
    let lb = 0;
    let lum = 0;
    for (let i = 0; i < field.length; i += 3) {
      lr += field[i];
      lb += field[i + 2];
      lum += 0.2126 * field[i] + 0.7152 * field[i + 1] + 0.0722 * field[i + 2];
    }
    const nodes = field.length / 3;
    return { image: result, gain: Math.exp(lum / nodes), warmth: (lr - lb) / nodes, ink: false };
  }

  return { MARGIN, match };
})();
