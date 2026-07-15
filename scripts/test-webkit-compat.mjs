// WebKit compatibility test for the polyfill layer.
//
// pdf.js v6 calls runtime APIs that only recent WebKit ships (see the table
// in src/web/polyfills.js). v1.2.0 shipped with an incomplete polyfill set
// and every document open failed on macOS with "getOrInsertComputed is not
// a function". This test makes that class of bug impossible to miss again:
// it DELETES all of those APIs from the Node realm (simulating Safari 16.4,
// the parse floor), installs our polyfills, and then opens and reads a real
// PDF through pdf.mjs + pdf.worker.mjs. If pdf.js uses a modern API we
// forgot to polyfill, this fails.
//
// Runs in three self-spawned modes so each polyfill copy is verified alone:
//   main    deleted APIs -> eval src/web/polyfills.js -> unit asserts ->
//           full document open (fake worker runs in-process)
//   worker  deleted APIs -> import src/build/pdf.worker.mjs, whose prepended
//           polyfill block must install everything -> unit asserts
//   (no arg) spawns both.
//
// Usage: node scripts/test-webkit-compat.mjs

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2];

if (!mode) {
  for (const m of ["main", "worker"]) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), m], {
      stdio: "inherit",
    });
    if (r.status !== 0) {
      console.error(`FAIL: ${m} mode exited with ${r.status}`);
      process.exit(1);
    }
  }
  console.log("webkit-compat: all modes passed");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 1. Simulate Safari 16.4: delete every API newer than the parse floor.
// ---------------------------------------------------------------------------
const IterProto = Object.getPrototypeOf(
  Object.getPrototypeOf([][Symbol.iterator]())
);
const deletions = [
  [Promise, "withResolvers"],
  [Promise, "try"],
  [URL, "parse"],
  [Map.prototype, "getOrInsert"],
  [Map.prototype, "getOrInsertComputed"],
  [WeakMap.prototype, "getOrInsert"],
  [WeakMap.prototype, "getOrInsertComputed"],
  [Set.prototype, "intersection"],
  [Math, "sumPrecise"],
  [Uint8Array.prototype, "toBase64"],
  [Uint8Array, "fromBase64"],
  [Uint8Array.prototype, "toHex"],
  [Uint8Array, "fromHex"],
  [AbortSignal, "any"],
  [Response.prototype, "bytes"],
  [Blob.prototype, "bytes"],
  [ReadableStream.prototype, Symbol.asyncIterator],
  [ReadableStream.prototype, "values"],
  ...[
    "map", "filter", "flatMap", "take", "drop",
    "some", "every", "find", "forEach", "reduce", "toArray",
  ].map(name => [IterProto, name]),
];
for (const [obj, name] of deletions) {
  delete obj[name];
}

// ---------------------------------------------------------------------------
// 2. Install the polyfills the way the app does.
// ---------------------------------------------------------------------------
if (mode === "main") {
  // viewer.html loads polyfills.js as a classic script before any module.
  vm.runInThisContext(
    readFileSync(join(root, "src/web/polyfills.js"), "utf8"),
    { filename: "polyfills.js" }
  );
} else {
  // Workers rely solely on the block prepended to pdf.worker.mjs.
  await import(pathToFileURL(join(root, "src/build/pdf.worker.mjs")).href);
}

// ---------------------------------------------------------------------------
// 3. Unit-assert every polyfill exists and behaves.
// ---------------------------------------------------------------------------
function assert(cond, label) {
  if (!cond) {
    console.error(`FAIL [${mode}]: ${label}`);
    process.exit(1);
  }
}

for (const [obj, name] of deletions) {
  assert(typeof obj[name] === "function", `missing polyfill: ${String(name)}`);
}

{
  const m = new Map();
  let calls = 0;
  const v1 = m.getOrInsertComputed("k", () => (calls++, "v"));
  const v2 = m.getOrInsertComputed("k", () => (calls++, "other"));
  assert(v1 === "v" && v2 === "v" && calls === 1, "getOrInsertComputed semantics");
  assert(m.getOrInsert("x", 7) === 7 && m.getOrInsert("x", 9) === 7, "getOrInsert semantics");
}
{
  const { promise, resolve } = Promise.withResolvers();
  resolve(42);
  assert((await promise) === 42, "withResolvers semantics");
}
{
  let sync = true;
  const p = Promise.try(() => { assert(sync, "Promise.try runs sync"); return 1; });
  sync = false;
  assert((await p) === 1, "Promise.try resolves");
  const rejected = await Promise.try(() => { throw new Error("x"); }).then(() => false, () => true);
  assert(rejected, "Promise.try catches sync throw");
}
assert(URL.parse("not a url", undefined) === null, "URL.parse invalid -> null");
assert(URL.parse("https://example.com/a").pathname === "/a", "URL.parse valid");
{
  const i = new Set([1, 2, 3]).intersection(new Set([2, 3, 4]));
  assert(i.size === 2 && i.has(2) && i.has(3), "Set.intersection semantics");
}
{
  assert(Math.sumPrecise([0.1, 0.2, 0.3]) > 0.59, "Math.sumPrecise sums");
  assert(Math.sumPrecise([1e100, 1, -1e100]) === 1, "Math.sumPrecise is compensated");
}
{
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252]);
  const b64 = bytes.toBase64();
  const round = Uint8Array.fromBase64(b64);
  assert(
    round.length === bytes.length && round.every((b, i) => b === bytes[i]),
    "Uint8Array base64 round trip"
  );
  assert(new Uint8Array([251, 255]).toBase64({ alphabet: "base64url" }).includes("-"), "base64url alphabet");
  assert(new Uint8Array([0, 15, 255]).toHex() === "000fff", "toHex semantics");
  const hexRound = Uint8Array.fromHex("000fff");
  assert(hexRound.length === 3 && hexRound[2] === 255, "fromHex semantics");
}
{
  const c1 = new AbortController();
  const any = AbortSignal.any([c1.signal, new AbortController().signal]);
  assert(!any.aborted, "AbortSignal.any starts unaborted");
  c1.abort(new Error("stop"));
  assert(any.aborted && any.reason?.message === "stop", "AbortSignal.any propagates abort + reason");
}
{
  const got = await new Blob([new Uint8Array([9, 8])]).bytes();
  assert(got instanceof Uint8Array && got[0] === 9 && got[1] === 8, "Blob.bytes");
  const rb = await new Response(new Uint8Array([5])).bytes();
  assert(rb instanceof Uint8Array && rb[0] === 5, "Response.bytes");
}
{
  const m = new Map([["a", 1], ["b", 2], ["c", 3]]);
  assert(m.values().some(v => v === 2), "iterator some");
  assert(m.keys().find(k => k === "c") === "c", "iterator find");
  const arr = m.values().map(v => v * 10).filter(v => v > 10).toArray();
  assert(arr.length === 2 && arr[0] === 20 && arr[1] === 30, "iterator map/filter chain");
  assert(m.values().drop(1).take(1).toArray()[0] === 2, "iterator drop/take");
  assert(m.values().reduce((a, v) => a + v, 0) === 6, "iterator reduce");
}
{
  const rs = new ReadableStream({
    start(controller) {
      controller.enqueue("a");
      controller.enqueue("b");
      controller.close();
    },
  });
  const chunks = [];
  for await (const chunk of rs) {
    chunks.push(chunk);
  }
  assert(chunks.join("") === "ab", "ReadableStream async iteration");
}

if (mode === "worker") {
  console.log("webkit-compat [worker]: prepended polyfill block OK");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 4. Open a real document through pdf.js, the path that failed in v1.2.0.
//    MessageHandler.sendWithPromise uses getOrInsertComputed on every
//    document open, so getDocument succeeding proves that path.
// ---------------------------------------------------------------------------
// Minimal DOM shims so the modern (non-legacy) pdf.js build imports in Node.
// Test-only; every browser we support has these natively.
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

const { getDocument, GlobalWorkerOptions } = await import(
  pathToFileURL(join(root, "src/build/pdf.mjs")).href
);
GlobalWorkerOptions.workerSrc = pathToFileURL(
  join(root, "src/build/pdf.worker.mjs")
).href;

// pdf.js reports recoverable problems (like a failed font load) only as
// console warnings; capture them so they fail the test.
const warnings = [];
const origLog = console.log;
console.log = (...args) => {
  const s = args.join(" ");
  if (s.startsWith("Warning:")) {
    warnings.push(s);
  }
  origLog(...args);
};

const content = "BT /F1 32 Tf 72 700 Td (compat test page) Tj ET";
const objs = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
  `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
];
let pdf = "%PDF-1.4\n";
const offsets = [];
objs.forEach((body, i) => {
  offsets.push(pdf.length);
  pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
});
const xref = pdf.length;
pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
  offsets.map(o => String(o).padStart(10, "0") + " 00000 n \n").join("") +
  `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

const task = getDocument({
  data: new TextEncoder().encode(pdf),
  // Plain filesystem path: pdf.js's Node factory reads it with fs.readFile.
  standardFontDataUrl: join(root, "src/web/standard_fonts") + "/",
});
const doc = await task.promise;
assert(doc.numPages === 1, "document opened with 1 page");
const page = await doc.getPage(1);
const text = (await page.getTextContent()).items.map(i => i.str).join("");
assert(text.includes("compat test page"), `text extracted (got: "${text}")`);
const opList = await page.getOperatorList();
assert(opList.fnArray.length > 0, "operator list produced (font/render path)");
assert(
  !warnings.some(w => w.includes("Unable to load font data")),
  `standard font data loaded without warnings (got: ${warnings.join(" | ")})`
);
// Generic net: pdf.js downgrades many internal errors to warnings, and a
// missing-API TypeError surfacing that way is exactly the bug class this
// test exists for (that's how Math.sumPrecise was caught).
const missingApi = warnings.filter(
  w => /is not a function|is not defined|undefined is not/.test(w)
);
assert(missingApi.length === 0, `no missing-API warnings (got: ${missingApi.join(" | ")})`);
await task.destroy();

console.log("webkit-compat [main]: polyfills carry a full document open + text + oplist");
