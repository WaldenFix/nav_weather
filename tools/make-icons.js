// Renders the app icon (same shapes as icon.svg) to PNGs for iOS and the web manifest.
// Zero dependencies: `node tools/make-icons.js`
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const BLUE = [0x1d, 0x4e, 0xd8];
const WHITE = [0xff, 0xff, 0xff];
const YELLOW = [0xfa, 0xcc, 0x15];
const ARROW = [[20, 44], [32, 14], [44, 44], [32, 37]];

// Colour of a point in the 64x64 icon space, or null if transparent.
function sample(x, y, { rounded, scale }) {
  // Maskable icons shrink the artwork so it survives the OS crop.
  const cx = 32 + (x - 32) / scale;
  const cy = 32 + (y - 32) / scale;
  if (Math.hypot(cx - 46, cy - 18) <= 7) return YELLOW;
  if (inPolygon(cx, cy, ARROW)) return WHITE;
  if (rounded && !inRoundedRect(x, y, 64, 14)) return null;
  return BLUE;
}

function inPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inRoundedRect(x, y, size, r) {
  const dx = Math.max(r - x, 0, x - (size - r));
  const dy = Math.max(r - y, 0, y - (size - r));
  return dx * dx + dy * dy <= r * r;
}

function render(size, opts) {
  const SS = 4; // 4x4 supersampling for smooth edges
  const rows = [];
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 4); // filter byte + RGBA
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sample(((px + (sx + 0.5) / SS) / size) * 64, ((py + (sy + 0.5) / SS) / size) * 64, opts);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
        }
      }
      const o = 1 + px * 4;
      if (a) {
        row[o] = Math.round(r / a);
        row[o + 1] = Math.round(g / a);
        row[o + 2] = Math.round(b / a);
      }
      row[o + 3] = Math.round((a / (SS * SS)) * 255);
    }
    rows.push(row);
  }
  return png(size, Buffer.concat(rows));
}

function png(size, raw) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = path.join(__dirname, '..', 'icons');
fs.mkdirSync(out, { recursive: true });
const icons = {
  // iOS rounds the corners itself, so its icon is a full square.
  'apple-touch-icon.png': [180, { rounded: false, scale: 1 }],
  'icon-192.png': [192, { rounded: true, scale: 1 }],
  'icon-512.png': [512, { rounded: true, scale: 1 }],
  'icon-maskable-512.png': [512, { rounded: false, scale: 0.8 }],
};
for (const [name, [size, opts]] of Object.entries(icons)) {
  fs.writeFileSync(path.join(out, name), render(size, opts));
  console.log(`icons/${name}`);
}
