// Generate the PWA icons (no deps): a Bitmark indigo-gradient square with the ◆
// brand mark, rendered straight to PNG. Run: node make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const STOPS = [[0, [0x0f, 0x0c, 0x29]], [0.55, [0x30, 0x2b, 0x63]], [1, [0x24, 0x24, 0x3e]]];
const LAV = [0x9c, 0x95, 0xf0];
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
function grad(t) { for (let i = 1; i < STOPS.length; i++) if (t <= STOPS[i][0]) { const [t0, c0] = STOPS[i - 1], [t1, c1] = STOPS[i]; return mix(c0, c1, (t - t0) / (t1 - t0)); } return STOPS.at(-1)[1]; }

// diamond coverage at (x,y) with 2x2 supersampling → smooth edges
function diamond(x, y, w, r) {
  const cx = w / 2, cy = w / 2; let inside = 0;
  for (const dx of [0.25, 0.75]) for (const dy of [0.25, 0.75]) {
    const d = Math.abs((x + dx) - cx) / r + Math.abs((y + dy) - cy) / r;
    if (d <= 1) inside++;
  }
  return inside / 4;
}

function draw(w, rFrac) {
  const r = w * rFrac, px = new Uint8Array(w * w * 4);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
    const bg = grad((x + y) / (2 * (w - 1)));
    const a = diamond(x, y, w, r);
    const c = a > 0 ? mix(bg, LAV, a) : bg;
    const o = (y * w + x) * 4; px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255;
  }
  return px;
}

function crc32(buf) { let crc = ~0; for (let i = 0; i < buf.length; i++) { crc ^= buf[i]; for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return ~crc >>> 0; }
function chunk(type, data) { const t = Buffer.from(type, 'ascii'); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([t, data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([len, body, crc]); }
function png(w, px) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(w, 4); ihdr[8] = 8; ihdr[9] = 6;   // 8-bit RGBA
  const raw = Buffer.alloc(w * (w * 4 + 1));
  for (let y = 0; y < w; y++) { raw[y * (w * 4 + 1)] = 0; px.subarray(y * w * 4, (y + 1) * w * 4).forEach((v, i) => { raw[y * (w * 4 + 1) + 1 + i] = v; }); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

for (const [name, w, rFrac] of [['icon-192.png', 192, 0.30], ['icon-512.png', 512, 0.30], ['icon-180.png', 180, 0.30]]) {
  writeFileSync(new URL('./' + name, import.meta.url), png(w, draw(w, rFrac)));
  console.log('wrote', name);
}
