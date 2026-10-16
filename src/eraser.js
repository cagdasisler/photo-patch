'use strict';

// Erase: removes what stands out from the background inside a box, and fills the
// gap so the background looks like it was always there.
//
// The ring of pixels around the box tells us what the background is. Usually most
// of it is one surface (paper, a wall, skin), lit unevenly, so the background is
// modelled as a smooth color surface fitted to the ring, ignoring whatever in the
// ring doesn't fit it (the neighbouring letters, say). Pixels inside the box that
// stand clearly off that surface are the object; its soft, anti-aliased rim comes
// along with it. Everything else in the box is left exactly as it was.
//
// The gap is filled in two layers, like a healing brush: the light, a smooth
// membrane that meets the surroundings at every edge, and the grain, real texture
// borrowed from clean background nearby, so the fill isn't a flat painted patch.
//
// When the ring has no one background (a busy photo), the whole box is filled
// the same way from everything around it.
//
// Works on plain { width, height, data } pixel objects, like lightmatch.js.

const Eraser = (() => {
  const MIN_BACKGROUND = 24; // fewer clean pixels around the box than this, and there's nothing to go on
  const BACKGROUND_SHARE = 0.4; // the ring is one background when this much of it fits the surface
  const PLAIN_NOISE = 14; // and that surface is plain: paper, a wall or skin, not grass or gravel
  const STRONG = 4.5; // × the background's own noise: surely part of the object
  const WEAK = 2.5; // × noise: part of the object if it touches a sure part (soft edges)
  const MIN_STRONG = 18; // color distances, 0–441
  const MIN_WEAK = 9;
  const RIM = 3; // pixels grown around the object, to catch the faint halo text leaves
  const CLEAR = 3; // and how far beyond that the fill starts trusting the background
  const SPECK = 6; // smaller than this and faint, a spot is noise (a full stop is bigger or darker)

  const sq = (v) => v * v;

  function random(seed) {
    let a = seed >>> 0 || 1;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function quantile(values, count, q) {
    if (count === 0) return 0;
    const sorted = values.slice(0, count).sort();
    return sorted[Math.min(count - 1, Math.floor(q * count))];
  }

  /* ---------------------------------------------------------------------- */
  /* The background: a smooth color surface                                 */
  /* ---------------------------------------------------------------------- */

  // Least-squares quadratic surface (1, u, v, u², uv, v²) per channel through the
  // listed pixels. A little ridge keeps it tame when the ring is lopsided (a box
  // against the picture's edge).
  function fitSurface(ch, list, W, H) {
    const A = Array.from({ length: 6 }, () => new Float64Array(6));
    const y = Array.from({ length: 3 }, () => new Float64Array(6));
    const b = new Float64Array(6);
    const n = list.length;
    for (const i of list) {
      const u = (2 * (i % W)) / W - 1;
      const v = (2 * Math.floor(i / W)) / H - 1;
      b[0] = 1;
      b[1] = u;
      b[2] = v;
      b[3] = u * u;
      b[4] = u * v;
      b[5] = v * v;
      for (let r = 0; r < 6; r++) {
        for (let c = r; c < 6; c++) A[r][c] += b[r] * b[c];
        for (let k = 0; k < 3; k++) y[k][r] += b[r] * ch[k][i];
      }
    }
    for (let r = 0; r < 6; r++) for (let c = 0; c < r; c++) A[r][c] = A[c][r];
    for (let r = 1; r < 6; r++) A[r][r] += n * (r < 3 ? 1e-3 : 1e-2);
    return solve(A, y);
  }

  // Gaussian elimination with partial pivoting, three right-hand sides at once.
  function solve(A, ys) {
    const n = A.length;
    const M = A.map((row, r) => [...row, ...ys.map((y) => y[r])]);
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      const d = M[c][c] || 1e-12;
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = M[r][c] / d;
        if (f) for (let k = c; k < M[r].length; k++) M[r][k] -= f * M[c][k];
      }
    }
    return ys.map((_, k) => M.map((row, r) => row[n + k] / (M[r][r] || 1e-12)));
  }

  function evalSurface(coef, W, H) {
    const out = [new Float32Array(W * H), new Float32Array(W * H), new Float32Array(W * H)];
    for (let py = 0, i = 0; py < H; py++) {
      const v = (2 * py) / H - 1;
      for (let px = 0; px < W; px++, i++) {
        const u = (2 * px) / W - 1;
        for (let k = 0; k < 3; k++) {
          const c = coef[k];
          out[k][i] = c[0] + c[1] * u + c[2] * v + c[3] * u * u + c[4] * u * v + c[5] * v * v;
        }
      }
    }
    return out;
  }

  // The most common color among the marked pixels, found on a coarse 3-D
  // histogram so a gentle gradient still reads as one color.
  function dominantColor(ch, use, N) {
    const counts = new Uint32Array(32768);
    const bin = (i) => ((ch[0][i] >> 3) << 10) | ((ch[1][i] >> 3) << 5) | (ch[2][i] >> 3);
    for (let i = 0; i < N; i++) if (use[i]) counts[bin(i)]++;
    let best = 0;
    let bestScore = -1;
    for (let k = 0; k < 32768; k++) {
      if (!counts[k]) continue;
      const r = k >> 10;
      const g = (k >> 5) & 31;
      const bl = k & 31;
      let score = 0;
      for (let dr = -1; dr <= 1; dr++)
        for (let dg = -1; dg <= 1; dg++)
          for (let db = -1; db <= 1; db++) {
            const rr = r + dr;
            const gg = g + dg;
            const bb = bl + db;
            if (rr >= 0 && rr < 32 && gg >= 0 && gg < 32 && bb >= 0 && bb < 32) score += counts[(rr << 10) | (gg << 5) | bb];
          }
      if (score > bestScore) {
        bestScore = score;
        best = k;
      }
    }
    return [(best >> 10) * 8 + 4, ((best >> 5) & 31) * 8 + 4, (best & 31) * 8 + 4];
  }

  /* ---------------------------------------------------------------------- */
  /* Filling                                                                */
  /* ---------------------------------------------------------------------- */

  // The mask grown by `steps` pixels (4-neighbour steps, so roughly diamond-shaped).
  function grow(mask, W, H, steps) {
    let a = mask;
    for (let s = 0; s < steps; s++) {
      const b = Uint8Array.from(a);
      for (let y = 0, i = 0; y < H; y++)
        for (let x = 0; x < W; x++, i++) {
          if (a[i]) continue;
          if ((x > 0 && a[i - 1]) || (x < W - 1 && a[i + 1]) || (y > 0 && a[i - W]) || (y < H - 1 && a[i + W])) b[i] = 1;
        }
      a = b;
    }
    return a;
  }

  // Box blur run twice (close to a Gaussian). The window is cut off at the edges
  // rather than padded, which is fine here: it's always used as a ratio of two blurs.
  function blur(src, W, H, r) {
    const sums = new Float64Array((W + 1) * (H + 1)); // 2-D prefix sums, one spare row and column
    let a = src;
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 0; y < H; y++) {
        let run = 0;
        const row = y * W;
        const above = y * (W + 1);
        const here = above + W + 1;
        for (let x = 0; x < W; x++) {
          run += a[row + x];
          sums[here + x + 1] = sums[above + x + 1] + run;
        }
      }
      const out = new Float32Array(W * H);
      for (let y = 0; y < H; y++) {
        const top = Math.max(0, y - r) * (W + 1);
        const bottom = Math.min(H, y + r + 1) * (W + 1);
        for (let x = 0; x < W; x++) {
          const left = Math.max(0, x - r);
          const right = Math.min(W, x + r + 1);
          out[y * W + x] = sums[bottom + right] - sums[top + right] - sums[bottom + left] + sums[top + left];
        }
      }
      a = out;
    }
    return a;
  }

  // Fills the pixels with no weight from the ones that have it, coarse to fine
  // (pull-push), so every gap gets a smooth first guess however big it is.
  function pullPush(vals, weight, W, H) {
    const levels = [{ w: W, h: H, v: vals.map((c) => Float32Array.from(c)), wt: Float32Array.from(weight) }];
    while (levels[levels.length - 1].w > 1 || levels[levels.length - 1].h > 1) {
      const f = levels[levels.length - 1];
      const w = Math.ceil(f.w / 2);
      const h = Math.ceil(f.h / 2);
      const v = [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)];
      const wt = new Float32Array(w * h);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          let sw = 0;
          const s = [0, 0, 0];
          for (let dy = 0; dy < 2; dy++)
            for (let dx = 0; dx < 2; dx++) {
              const fx = 2 * x + dx;
              const fy = 2 * y + dy;
              if (fx >= f.w || fy >= f.h) continue;
              const j = fy * f.w + fx;
              const q = f.wt[j];
              sw += q;
              for (let k = 0; k < 3; k++) s[k] += q * f.v[k][j];
            }
          const i = y * w + x;
          wt[i] = Math.min(1, sw);
          for (let k = 0; k < 3; k++) v[k][i] = sw > 0 ? s[k] / sw : 0;
        }
      levels.push({ w, h, v, wt });
    }
    for (let l = levels.length - 2; l >= 0; l--) {
      const f = levels[l];
      const c = levels[l + 1];
      for (let y = 0; y < f.h; y++) {
        const cy = Math.min(c.h - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
        const y0 = Math.floor(cy);
        const y1 = Math.min(c.h - 1, y0 + 1);
        const ty = cy - y0;
        for (let x = 0; x < f.w; x++) {
          const i = y * f.w + x;
          const q = f.wt[i];
          if (q >= 1) continue;
          const cx = Math.min(c.w - 1, Math.max(0, (x + 0.5) / 2 - 0.5));
          const x0 = Math.floor(cx);
          const x1 = Math.min(c.w - 1, x0 + 1);
          const tx = cx - x0;
          for (let k = 0; k < 3; k++) {
            const cv = c.v[k];
            const up =
              (1 - ty) * ((1 - tx) * cv[y0 * c.w + x0] + tx * cv[y0 * c.w + x1]) +
              ty * ((1 - tx) * cv[y1 * c.w + x0] + tx * cv[y1 * c.w + x1]);
            f.v[k][i] = q * f.v[k][i] + (1 - q) * up;
          }
        }
      }
    }
    return levels[0].v;
  }

  // Relaxes the gap toward the smoothest surface that meets its edges (a harmonic
  // membrane). Pixels that are neither known nor in the gap don't pull on it.
  function relax(field, known, hole, holeList, W, H, iterations) {
    const OMEGA = 1.8;
    for (let it = 0; it < iterations; it++) {
      for (let n = 0; n < holeList.length; n++) {
        const i = holeList[n];
        const x = i % W;
        let cnt = 0;
        let s0 = 0;
        let s1 = 0;
        let s2 = 0;
        const add = (j) => {
          if (!known[j] && !hole[j]) return;
          s0 += field[0][j];
          s1 += field[1][j];
          s2 += field[2][j];
          cnt++;
        };
        if (x > 0) add(i - 1);
        if (x < W - 1) add(i + 1);
        if (i >= W) add(i - W);
        if (i < W * (H - 1)) add(i + W);
        if (!cnt) continue;
        field[0][i] += OMEGA * (s0 / cnt - field[0][i]);
        field[1][i] += OMEGA * (s1 / cnt - field[1][i]);
        field[2][i] += OMEGA * (s2 / cnt - field[2][i]);
      }
    }
  }

  // Grain for the gap, block by block: each block borrows the texture of a clean
  // stretch of background nearby, shifted as a whole so the grain keeps its shape.
  function borrowGrain(grain, known, hole, box, W, H, block, rand) {
    const out = [new Float32Array(W * H), new Float32Array(W * H), new Float32Array(W * H)];
    const knownList = [];
    for (let i = 0; i < W * H; i++) if (known[i]) knownList.push(i);
    const reach = Math.max(W, H);
    let last = null;
    for (let by = box.y; by < box.y + box.h; by += block) {
      for (let bx = box.x; bx < box.x + box.w; bx += block) {
        const cells = [];
        for (let y = by; y < Math.min(by + block, box.y + box.h); y++)
          for (let x = bx; x < Math.min(bx + block, box.x + box.w); x++) if (hole[y * W + x]) cells.push(x, y);
        if (!cells.length) continue;
        const score = (dx, dy) => {
          let ok = 0;
          for (let n = 0; n < cells.length; n += 2) {
            const sx = cells[n] + dx;
            const sy = cells[n + 1] + dy;
            if (sx >= 0 && sy >= 0 && sx < W && sy < H && known[sy * W + sx]) ok++;
          }
          return ok;
        };
        const want = cells.length / 2;
        let best = last;
        let bestScore = last ? score(last[0], last[1]) : -1;
        for (let t = 0; t < 80 && bestScore < want; t++) {
          const dx = Math.round((rand() * 2 - 1) * reach);
          const dy = Math.round((rand() * 2 - 1) * reach);
          if (Math.abs(dx) < block && Math.abs(dy) < block) continue;
          const s = score(dx, dy);
          if (s > bestScore) {
            bestScore = s;
            best = [dx, dy];
          }
        }
        last = bestScore === want ? best : null;
        for (let n = 0; n < cells.length; n += 2) {
          const i = cells[n + 1] * W + cells[n];
          let j = -1;
          if (best) {
            const sx = cells[n] + best[0];
            const sy = cells[n + 1] + best[1];
            if (sx >= 0 && sy >= 0 && sx < W && sy < H && known[sy * W + sx]) j = sy * W + sx;
          }
          if (j < 0) j = knownList[Math.floor(rand() * knownList.length)];
          for (let k = 0; k < 3; k++) out[k][i] = grain[k][j];
        }
      }
    }
    return out;
  }

  /* ---------------------------------------------------------------------- */
  /* Structure: rebuilding the gap from real patches (PatchMatch)           */
  /* ---------------------------------------------------------------------- */

  // The light-and-grain fill can't continue a pattern: a ruled line, a table
  // border, mortar between bricks. So the gap is then rebuilt from 7×7 patches of
  // the surroundings, coarse to fine: each patch that touches the gap is matched
  // to the most similar patch outside it (PatchMatch: random guesses, spread to
  // neighbours, refined), and the gap is repainted from those matches until it
  // settles. The final pass gives each pixel the value from its single best
  // patch rather than an average, so the grain stays as crisp as the original.
  const R = 3; // patch radius
  const SIDE = 2 * R + 1;
  const TRUST = 0.77; // per pixel into the gap

  // How far each gap pixel is from the nearest pixel outside it (city-block).
  function depth(hole, W, H) {
    const d = new Int32Array(W * H);
    const far = W + H;
    for (let y = 0, i = 0; y < H; y++)
      for (let x = 0; x < W; x++, i++) {
        if (!hole[i]) continue;
        d[i] = Math.min(x > 0 ? d[i - 1] + 1 : far, y > 0 ? d[i - W] + 1 : far);
      }
    for (let y = H - 1, i = W * H - 1; y >= 0; y--)
      for (let x = W - 1; x >= 0; x--, i--) {
        if (!hole[i]) continue;
        d[i] = Math.min(d[i], x < W - 1 ? d[i + 1] + 1 : far, y < H - 1 ? d[i + W] + 1 : far);
      }
    return d;
  }

  function half(level) {
    const { W, H, img, hole } = level;
    const w = Math.ceil(W / 2);
    const h = Math.ceil(H / 2);
    const out = new Float32Array(w * h * 3);
    const gap = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let n = 0;
        const i = y * w + x;
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++) {
            const fx = 2 * x + dx;
            const fy = 2 * y + dy;
            if (fx >= W || fy >= H) continue;
            const j = fy * W + fx;
            for (let k = 0; k < 3; k++) out[3 * i + k] += img[3 * j + k];
            if (hole[j]) gap[i] = 1;
            n++;
          }
        for (let k = 0; k < 3; k++) out[3 * i + k] /= n;
      }
    return { W: w, H: h, img: out, hole: gap };
  }

  // Patch centres to fill (patches touching the gap) and to copy from (patches
  // clear of it), both kept a patch radius inside the picture.
  function prepare(level) {
    const { W, H, hole } = level;
    const sums = new Int32Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) {
      let run = 0;
      for (let x = 0; x < W; x++) {
        run += hole[y * W + x];
        sums[(y + 1) * (W + 1) + x + 1] = sums[y * (W + 1) + x + 1] + run;
      }
    }
    const targets = [];
    const sources = [];
    const usable = new Uint8Array(W * H);
    for (let y = R; y < H - R; y++)
      for (let x = R; x < W - R; x++) {
        const a = (y - R) * (W + 1) + x - R;
        const b = (y + R + 1) * (W + 1) + x - R;
        const n = sums[b + SIDE] - sums[b] - sums[a + SIDE] + sums[a];
        if (n) targets.push(y * W + x);
        else {
          usable[y * W + x] = 1;
          sources.push(y * W + x);
        }
      }
    level.targets = Int32Array.from(targets);
    level.sources = Int32Array.from(sources);
    level.usable = usable;
    // How much a patch's vote counts: fully when centred on known pixels, less
    // the deeper into the gap its centre is, so what the edges know leads.
    const d = depth(hole, W, H);
    level.trust = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) level.trust[i] = TRUST ** d[i];
  }

  // Sum of squared differences between two patches, given up on past `cap`.
  function patchDistance(img, W, t, s, cap) {
    let d = 0;
    for (let dy = -R; dy <= R; dy++) {
      let a = 3 * (t + dy * W - R);
      let b = 3 * (s + dy * W - R);
      for (let k = 0; k < 3 * SIDE; k++, a++, b++) {
        const e = img[a] - img[b];
        d += e * e;
      }
      if (d >= cap) return d;
    }
    return d;
  }

  function search(level, nn, nd, rounds, rand) {
    const { W, H, img, targets, sources, usable } = level;
    for (let round = 0; round < rounds; round++) {
      const forward = round % 2 === 0;
      const step = forward ? 1 : -1;
      for (let n = forward ? 0 : targets.length - 1; n >= 0 && n < targets.length; n += step) {
        const t = targets[n];
        let best = nn[t];
        let bestD = nd[t];
        const tryAt = (s) => {
          if (s === best || !usable[s]) return;
          const d = patchDistance(img, W, t, s, bestD);
          if (d < bestD) {
            best = s;
            bestD = d;
          }
        };
        // Neighbours' matches, shifted along: patterns continue.
        const left = t - step;
        const up = t - step * W;
        if (nn[left] >= 0) tryAt(nn[left] + step);
        if (nn[up] >= 0) tryAt(nn[up] + step * W);
        // Random guesses ever closer to the best so far.
        const bx = best % W;
        const by = (best - bx) / W;
        for (let r = Math.max(W, H); r >= 1; r >>= 1) {
          const x = Math.round(bx + (rand() * 2 - 1) * r);
          const y = Math.round(by + (rand() * 2 - 1) * r);
          if (x >= R && y >= R && x < W - R && y < H - R) tryAt(y * W + x);
        }
        if (best < 0) tryAt(sources[Math.floor(rand() * sources.length)]);
        nn[t] = best;
        nd[t] = bestD;
      }
    }
  }

  function measure(level, nn, nd) {
    const { W, img, targets } = level;
    for (const t of targets) nd[t] = nn[t] >= 0 ? patchDistance(img, W, t, nn[t], Infinity) : Infinity;
  }

  // Repaints the gap from the matched patches: the average of every patch over
  // each pixel, weighted by trust, or on the last pass each pixel's single best
  // patch. (Weighting by how well patches match instead would starve the patches
  // at the gap's edge, which match worst but are the ones carrying a pattern in.)
  function repaint(level, nn, nd, sharp) {
    const { W, H, img, hole, targets } = level;
    const N = W * H;
    const sum = new Float32Array(3 * N);
    const weight = new Float32Array(N);
    const best = new Float32Array(N).fill(Infinity);
    for (const t of targets) {
      const s = nn[t];
      if (s < 0) continue;
      const w = level.trust[t];
      for (let dy = -R; dy <= R; dy++)
        for (let dx = -R; dx <= R; dx++) {
          const p = t + dy * W + dx;
          if (!hole[p]) continue;
          const q = s + dy * W + dx;
          if (sharp) {
            if (nd[t] >= best[p]) continue;
            best[p] = nd[t];
            for (let k = 0; k < 3; k++) sum[3 * p + k] = img[3 * q + k];
            weight[p] = 1;
          } else {
            for (let k = 0; k < 3; k++) sum[3 * p + k] += w * img[3 * q + k];
            weight[p] += w;
          }
        }
    }
    for (let p = 0; p < N; p++)
      if (hole[p] && weight[p] > 0) for (let k = 0; k < 3; k++) img[3 * p + k] = sum[3 * p + k] / weight[p];
  }

  // Rebuilds the gap in `img` (3 floats per pixel, already holding a first
  // guess) in place.
  function rebuild(img, hole, W, H, rand) {
    const levels = [{ W, H, img, hole }];
    // Coarse levels let a pattern bridge a long gap: as many as it takes to
    // shrink the gap's longest side to within one patch's reach.
    let x0 = W;
    let y0 = H;
    let x1 = 0;
    let y1 = 0;
    for (let y = 0, i = 0; y < H; y++)
      for (let x = 0; x < W; x++, i++)
        if (hole[i]) {
          x0 = Math.min(x0, x);
          x1 = Math.max(x1, x);
          y0 = Math.min(y0, y);
          y1 = Math.max(y1, y);
        }
    const reach = Math.max(x1 - x0, y1 - y0) + 1;
    while (reach >> levels.length > R + 1) {
      const last = levels[levels.length - 1];
      if (Math.min(last.W, last.H) / 2 < 2 * SIDE) break;
      levels.push(half(last));
    }
    let prev = null;
    for (let l = levels.length - 1; l >= 0; l--) {
      const level = levels[l];
      prepare(level);
      const N = level.W * level.H;
      const nn = new Int32Array(N).fill(-1);
      const nd = new Float32Array(N).fill(Infinity);
      if (!level.sources.length || !level.targets.length) {
        prev = null;
        continue;
      }
      // Start from the coarser level's matches, scaled up, or from random ones.
      for (const t of level.targets) {
        let s = -1;
        if (prev) {
          const x = t % level.W;
          const y = (t - x) / level.W;
          const c = prev.nn[Math.min(prev.H - 1, y >> 1) * prev.W + Math.min(prev.W - 1, x >> 1)];
          if (c >= 0) {
            const cx = c % prev.W;
            const cy = (c - cx) / prev.W;
            const sx = 2 * cx + (x & 1);
            const sy = 2 * cy + (y & 1);
            if (sx < level.W && sy < level.H && level.usable[sy * level.W + sx]) s = sy * level.W + sx;
          }
        }
        nn[t] = s >= 0 ? s : level.sources[Math.floor(rand() * level.sources.length)];
      }
      measure(level, nn, nd);
      if (prev) repaint(level, nn, nd, false);
      const passes = l === levels.length - 1 ? 10 : l === 0 ? 2 : 4;
      for (let pass = 0; pass < passes; pass++) {
        measure(level, nn, nd);
        search(level, nn, nd, 2, rand);
        repaint(level, nn, nd, l === 0 && pass === passes - 1);
      }
      prev = { W: level.W, H: level.H, nn };
      // Carry the result down as the next level's first guess.
      if (l > 0) {
        const fine = levels[l - 1];
        for (let y = 0; y < fine.H; y++)
          for (let x = 0; x < fine.W; x++) {
            const i = y * fine.W + x;
            if (!fine.hole[i]) continue;
            const c = Math.min(level.H - 1, y >> 1) * level.W + Math.min(level.W - 1, x >> 1);
            // The coarse level's shape; the fine level's own patches bring the grain back.
            for (let k = 0; k < 3; k++) fine.img[3 * i + k] = level.img[3 * c + k];
          }
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Erase                                                                  */
  /* ---------------------------------------------------------------------- */

  // `pixels` is the box plus whatever surroundings the caller could give; `box`
  // is where the box sits in it. Returns the box's new pixels, or null when there
  // is too little around the box to tell what the background is.
  function erase(pixels, box, { seed = 1 } = {}) {
    const { width: W, height: H, data } = pixels;
    const N = W * H;
    const ch = [new Float32Array(N), new Float32Array(N), new Float32Array(N)];
    for (let i = 0; i < N; i++) {
      ch[0][i] = data[4 * i];
      ch[1][i] = data[4 * i + 1];
      ch[2][i] = data[4 * i + 2];
    }
    const ring = new Uint8Array(N);
    let ringCount = 0;
    for (let y = 0, i = 0; y < H; y++)
      for (let x = 0; x < W; x++, i++) {
        const inside = x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
        if (!inside) {
          ring[i] = 1;
          ringCount++;
        }
      }
    if (ringCount < MIN_BACKGROUND) return null;

    // Find the background: start from the ring's most common color, then fit a
    // surface to the pixels near it, and refit to the pixels near the surface. A
    // smooth surface doesn't need every pixel, so big rings are fitted on a grid.
    const step = Math.max(1, Math.floor(Math.sqrt(ringCount / 20000)));
    const grid = [];
    for (let y = 0; y < H; y += step) for (let x = 0; x < W; x += step) if (ring[y * W + x]) grid.push(y * W + x);
    const c0 = dominantColor(ch, ring, N);
    const offBy = (i, c) => Math.sqrt(sq(ch[0][i] - c[0]) + sq(ch[1][i] - c[1]) + sq(ch[2][i] - c[2]));
    let fitted = grid.filter((i) => offBy(i, c0) < 40);
    let coef = null;
    let noise = 0; // the background's typical distance from its surface
    let spread = 0; // and its far tail: grain and JPEG noise run well past the typical
    for (let round = 0; round < 5 && fitted.length >= MIN_BACKGROUND; round++) {
      coef = fitSurface(ch, fitted, W, H);
      const at = (i) => {
        const u = (2 * (i % W)) / W - 1;
        const v = (2 * Math.floor(i / W)) / H - 1;
        return coef.map((c) => c[0] + c[1] * u + c[2] * v + c[3] * u * u + c[4] * u * v + c[5] * v * v);
      };
      const off = new Float32Array(grid.length);
      const sample = new Float32Array(grid.length);
      grid.forEach((i, n) => (off[n] = offBy(i, at(i))));
      const inFit = new Set(fitted);
      let n = 0;
      grid.forEach((i, k) => inFit.has(i) && (sample[n++] = off[k]));
      noise = Math.max(2, quantile(sample, n, 0.5));
      // The tail, from everything that isn't clearly ink or another object.
      n = 0;
      for (let k = 0; k < grid.length; k++) if (off[k] < 8 * noise) sample[n++] = off[k];
      spread = quantile(sample, n, 0.995);
      const limit = Math.max(3 * noise, 8);
      fitted = grid.filter((_, k) => off[k] < limit);
    }

    const known = new Uint8Array(N);
    const hole = new Uint8Array(N);
    const plain = coef && noise <= PLAIN_NOISE && fitted.length >= MIN_BACKGROUND && fitted.length >= BACKGROUND_SHARE * grid.length;
    let surface = null;
    const dist = new Float32Array(N);
    if (plain) {
      surface = evalSurface(coef, W, H);
      for (let i = 0; i < N; i++) dist[i] = Math.sqrt(sq(ch[0][i] - surface[0][i]) + sq(ch[1][i] - surface[1][i]) + sq(ch[2][i] - surface[2][i]));
    }

    if (plain) {
      // The object: sure pixels, the soft pixels touching them, and a thin rim.
      const strong = Math.max(STRONG * noise, 1.4 * spread, MIN_STRONG);
      const weak = Math.max(WEAK * noise, spread, MIN_WEAK);
      let object = new Uint8Array(N); // 1: object, 2: looked at and let go
      const stack = [];
      const members = [];
      for (let seed = 0; seed < N; seed++) {
        if (object[seed] || dist[seed] <= strong) continue;
        object[seed] = 1;
        stack.push(seed);
        members.length = 0;
        let peak = 0;
        while (stack.length) {
          const i = stack.pop();
          members.push(i);
          peak = Math.max(peak, dist[i]);
          const x = i % W;
          const y = (i - x) / W;
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx;
              const ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
              const j = ny * W + nx;
              if (!object[j] && dist[j] > weak) {
                object[j] = 1;
                stack.push(j);
              }
            }
        }
        // A tiny speck barely over the line is grain or JPEG noise, not a mark.
        if (members.length < SPECK && peak < 2 * strong) for (const i of members) object[i] = 2;
      }
      for (let i = 0; i < N; i++) object[i] = object[i] === 1 ? 1 : 0;
      object = grow(object, W, H, RIM);
      // Right next to ink, JPEG leaves bright ringing that isn't the paper's real
      // grain, so the fill learns only from background a little way off (when
      // there's enough of it: tiny, dense text may leave too little).
      const near = grow(object, W, H, CLEAR);
      let clear = 0;
      for (let i = 0; i < N; i++) if (!near[i]) clear++;
      const keepClear = clear >= 4 * MIN_BACKGROUND;
      for (let i = 0; i < N; i++) {
        if (object[i]) {
          if (!ring[i]) hole[i] = 1;
        } else if (!keepClear || !near[i]) known[i] = 1;
      }
    } else {
      // No one background to go by: fill the whole box from all around it.
      surface = evalSurface(fitSurface(ch, grid, W, H), W, H);
      for (let i = 0; i < N; i++) {
        if (ring[i]) known[i] = 1;
        else hole[i] = 1;
      }
    }

    const holeList = [];
    for (let i = 0; i < N; i++) if (hole[i]) holeList.push(i);
    let knownCount = 0;
    for (let i = 0; i < N; i++) knownCount += known[i];
    if (!holeList.length) return { image: null, removed: 0, whole: !plain };
    if (knownCount < MIN_BACKGROUND) return null;

    // Split what's known into its light (smooth) and its grain (fine detail),
    // both measured from the background surface.
    const radius = plain ? 3 : 5;
    const weight = new Float32Array(N);
    for (let i = 0; i < N; i++) weight[i] = known[i];
    const den = blur(weight, W, H, radius);
    const residual = [0, 1, 2].map((k) => {
      const r = new Float32Array(N);
      for (let i = 0; i < N; i++) r[i] = known[i] ? ch[k][i] - surface[k][i] : 0;
      return r;
    });
    const smooth = residual.map((r) => {
      const num = blur(r, W, H, radius);
      for (let i = 0; i < N; i++) num[i] = den[i] > 1e-3 ? num[i] / den[i] : 0;
      return num;
    });
    const grain = residual.map((r, k) => {
      const g = new Float32Array(N);
      for (let i = 0; i < N; i++) if (known[i]) g[i] = r[i] - smooth[k][i];
      return g;
    });

    const light = pullPush(smooth, weight, W, H);
    for (let k = 0; k < 3; k++) for (let i = 0; i < N; i++) if (known[i]) light[k][i] = smooth[k][i];
    relax(light, known, hole, holeList, W, H, 60);
    const rand = random(seed);
    const borrowed = borrowGrain(grain, known, hole, box, W, H, plain ? 16 : 24, rand);

    // Then rebuild any pattern through the gap, working with the light evened
    // out (measured from the background surface) so patches from a sunnier or
    // shadier spot still fit.
    const img = new Float32Array(3 * N);
    for (let i = 0; i < N; i++)
      for (let k = 0; k < 3; k++) img[3 * i + k] = hole[i] ? light[k][i] + borrowed[k][i] : ch[k][i] - surface[k][i];
    rebuild(img, hole, W, H, rand);

    let alpha = 0;
    let alphaCount = 0;
    for (let i = 0; i < N; i++)
      if (known[i]) {
        alpha += data[4 * i + 3];
        alphaCount++;
      }
    alpha = Math.round(alpha / alphaCount);

    const out = new Uint8ClampedArray(box.w * box.h * 4);
    for (let y = 0; y < box.h; y++)
      for (let x = 0; x < box.w; x++) {
        const i = (box.y + y) * W + box.x + x;
        const o = 4 * (y * box.w + x);
        if (hole[i]) {
          for (let k = 0; k < 3; k++) out[o + k] = Math.round(surface[k][i] + img[3 * i + k]);
          out[o + 3] = alpha;
        } else {
          for (let k = 0; k < 4; k++) out[o + k] = data[4 * i + k];
        }
      }
    return { image: { width: box.w, height: box.h, data: out }, removed: holeList.length, whole: !plain };
  }

  return { erase };
})();

