'use strict';

// Draws build/icon.png (256×256) with no dependencies: a dashed "selection"
// square and a solid "pasted piece" holding a tiny landscape.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const SAMPLES = 4; // supersampling per axis, for smooth edges

const BLUE = [46, 107, 255];
const VIOLET = [139, 77, 255];

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

function roundRectDistance(px, py, x0, y0, x1, y1, r) {
  const qx = Math.abs(px - (x0 + x1) / 2) - ((x1 - x0) / 2 - r);
  const qy = Math.abs(py - (y0 + y1) / 2) - ((y1 - y0) / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function inTriangle(px, py, [ax, ay], [bx, by], [cx, cy]) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

// Dashed outline of the square 50..146; dashes are laid out so every corner is covered.
function onDashedOutline(px, py) {
  const lo = 50;
  const hi = 146;
  const half = 4;
  if (Math.abs(roundRectDistance(px, py, lo, lo, hi, hi, 5)) > half) return false;
  const nearHorizontal = Math.min(Math.abs(py - lo), Math.abs(py - hi)) <= Math.min(Math.abs(px - lo), Math.abs(px - hi));
  const along = Math.min(hi - lo, Math.max(0, (nearHorizontal ? px : py) - lo));
  return along % 21 < 12;
}

// Returns a premultiplied RGBA sample for one point.
function sample(px, py) {
  let out = [0, 0, 0, 0];
  const over = (rgb, a) => {
    out = [rgb[0] * a + out[0] * (1 - a), rgb[1] * a + out[1] * (1 - a), rgb[2] * a + out[2] * (1 - a), a + out[3] * (1 - a)];
  };

  if (roundRectDistance(px, py, 12, 12, 244, 244, 56) <= 0) {
    over(mix(BLUE, VIOLET, clamp01((px + py - 24) / 464)), 1);
  }
  if (onDashedOutline(px, py)) over([255, 255, 255], 0.92);

  const shadow = roundRectDistance(px, py, 104, 108, 214, 218, 18);
  if (shadow < 16) over([18, 8, 64], 0.32 * clamp01(1 - Math.max(0, shadow) / 16));

  if (roundRectDistance(px, py, 98, 100, 208, 210, 18) <= 0) over([255, 255, 255], 1);

  if (roundRectDistance(px, py, 109, 111, 197, 199, 9) <= 0) {
    over([226, 234, 255], 1);
    if (Math.hypot(px - 174, py - 136) <= 11) over([255, 181, 71], 1);
    if (inTriangle(px, py, [104, 204], [140, 150], [180, 204])) over(BLUE, 1);
    if (inTriangle(px, py, [146, 204], [174, 166], [204, 204])) over(VIOLET, 1);
  }
  return out;
}

function render() {
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const s = sample(x + (sx + 0.5) / SAMPLES, y + (sy + 0.5) / SAMPLES);
          for (let i = 0; i < 4; i++) acc[i] += s[i];
        }
      }
      const n = SAMPLES * SAMPLES;
      const a = acc[3] / n;
      const o = (y * SIZE + x) * 4;
      for (let i = 0; i < 3; i++) rgba[o + i] = a > 0 ? Math.round(acc[i] / n / a) : 0;
      rgba[o + 3] = Math.round(a * 255);
    }
  }
  return rgba;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let y = 0; y < SIZE; y++) rgba.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outFile = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, encodePng(render()));
console.log(`Wrote ${outFile}`);
