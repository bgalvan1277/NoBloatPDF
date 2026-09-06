// Verifies a PDF written by Combine Files: opens it through the app's own
// pdf.js build in Node and requires the expected page count and page sizes,
// text on the text pages, and an image on the image pages. Used by the macOS
// CI smoke test after launching the installed app with
// `--combine <out.pdf> <files…>`.
//
// Usage: node scripts/check-combined-pdf.mjs <combined.pdf> '<JSON page sizes>'
//   e.g. '[[612,792],[612,792],[612,792],[792,528],[609,792],[609,792]]'

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [file, expectedArg] = process.argv.slice(2);
if (!file || !expectedArg) {
  console.error("usage: check-combined-pdf.mjs <combined.pdf> '<JSON page sizes>'");
  process.exit(2);
}
const expected = JSON.parse(expectedArg);

// Minimal DOM shim so the modern pdf.js build imports in Node (test only).
if (typeof globalThis.DOMMatrix === "undefined") {
  globalThis.DOMMatrix = class DOMMatrix {
    constructor(init) {
      [this.a, this.b, this.c, this.d, this.e, this.f] =
        Array.isArray(init) && init.length === 6 ? init : [1, 0, 0, 1, 0, 0];
    }
    scale(x, y = x) {
      return new DOMMatrix([this.a * x, this.b * x, this.c * y, this.d * y, this.e, this.f]);
    }
    translate(x, y) {
      return new DOMMatrix([
        this.a, this.b, this.c, this.d,
        this.e + this.a * x + this.c * y,
        this.f + this.b * x + this.d * y,
      ]);
    }
  };
}

const { getDocument, GlobalWorkerOptions, OPS } = await import(
  pathToFileURL(join(root, "src/build/pdf.mjs")).href
);
GlobalWorkerOptions.workerSrc = pathToFileURL(join(root, "src/build/pdf.worker.mjs")).href;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const task = getDocument({
  data: new Uint8Array(readFileSync(file)),
  standardFontDataUrl: join(root, "src/web/standard_fonts") + "/",
});
const doc = await task.promise;
console.log(`${file}: ${doc.numPages} pages`);
if (doc.numPages !== expected.length) {
  fail(`expected ${expected.length} pages, got ${doc.numPages}`);
}
for (let i = 1; i <= doc.numPages; i++) {
  const page = await doc.getPage(i);
  const [x0, y0, x1, y1] = page.view;
  const size = [Math.round(x1 - x0), Math.round(y1 - y0)];
  const text = (await page.getTextContent()).items.map((t) => t.str).join("");
  const ops = await page.getOperatorList();
  const images = ops.fnArray.filter((f) => f === OPS.paintImageXObject).length;
  console.log(`page ${i}: ${size[0]}x${size[1]} text="${text}" images=${images}`);
  const want = expected[i - 1];
  if (size[0] !== want[0] || size[1] !== want[1]) {
    fail(`page ${i}: expected ${want[0]}x${want[1]}, got ${size[0]}x${size[1]}`);
  }
  // Text pages carry text and no image; image pages carry exactly one image.
  if (text.length === 0 && images !== 1) fail(`page ${i}: expected one image on an image page`);
  if (text.length > 0 && images !== 0) fail(`page ${i}: unexpected image on a text page`);
}
await task.destroy();
console.log("OK: combined PDF has the expected pages.");
