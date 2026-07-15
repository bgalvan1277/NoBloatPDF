// Verifies a smoke-test screenshot actually shows a rendered PDF page.
//
// The v1.2.0 smoke test took screenshots but only checked the process was
// alive, so the "couldn't open document" error dialog sailed through CI.
// A rendered PDF page is a large pure-white region; the failure state is a
// gray empty viewer plus a light-gray dialog, neither of which reaches the
// near-white threshold. So: decode the PNG (pure Node, no deps) and require
// a minimum fraction of near-white pixels.
//
// Usage: node scripts/check-smoke-screenshot.mjs <window.png> [minFraction]

import { readFileSync } from "node:fs";
import zlib from "node:zlib";

const [file, minArg] = process.argv.slice(2);
const minFraction = Number(minArg ?? "0.2");
const buf = readFileSync(file);

if (buf.readUInt32BE(0) !== 0x89504e47) {
  throw new Error("not a PNG");
}

let width, height, bitDepth, colorType, interlace;
const idat = [];
for (let off = 8; off < buf.length; ) {
  const len = buf.readUInt32BE(off);
  const type = buf.toString("ascii", off + 4, off + 8);
  const data = buf.subarray(off + 8, off + 8 + len);
  if (type === "IHDR") {
    width = data.readUInt32BE(0);
    height = data.readUInt32BE(4);
    bitDepth = data[8];
    colorType = data[9];
    interlace = data[12];
  } else if (type === "IDAT") {
    idat.push(data);
  } else if (type === "IEND") {
    break;
  }
  off += 12 + len;
}
if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
  throw new Error(
    `unsupported PNG layout: depth=${bitDepth} color=${colorType} interlace=${interlace}`
  );
}
const channels = colorType === 6 ? 4 : 3;
const raw = zlib.inflateSync(Buffer.concat(idat));
const stride = width * channels;

// Undo PNG scanline filters (spec section 9: none/sub/up/average/paeth).
const px = Buffer.alloc(height * stride);
for (let y = 0; y < height; y++) {
  const filter = raw[y * (stride + 1)];
  const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
  const out = y * stride;
  const prev = (y - 1) * stride;
  for (let x = 0; x < stride; x++) {
    const a = x >= channels ? px[out + x - channels] : 0;
    const b = y > 0 ? px[prev + x] : 0;
    const c = x >= channels && y > 0 ? px[prev + x - channels] : 0;
    let v = line[x];
    switch (filter) {
      case 1:
        v += a;
        break;
      case 2:
        v += b;
        break;
      case 3:
        v += (a + b) >> 1;
        break;
      case 4: {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        break;
      }
    }
    px[out + x] = v & 0xff;
  }
}

let white = 0;
const total = width * height;
for (let i = 0; i < total; i++) {
  const o = i * channels;
  if (px[o] >= 250 && px[o + 1] >= 250 && px[o + 2] >= 250) {
    white++;
  }
}
const fraction = white / total;
console.log(
  `${file}: ${width}x${height}, near-white fraction ${(fraction * 100).toFixed(1)}% ` +
  `(minimum ${(minFraction * 100).toFixed(0)}%)`
);
if (fraction < minFraction) {
  console.error(
    "FAIL: no large white region; the PDF page did not render (error dialog or blank viewer)."
  );
  process.exit(1);
}
console.log("OK: rendered PDF page detected.");
