// Runs inside the OS's own JavaScriptCore shell (jsc), AFTER
// src/web/polyfills.js, to prove that on this macOS the JS builtins pdf.js
// 6.1 calls all exist, natively or via our polyfills. WKWebView shares this
// engine, so a miss here is exactly the "getOrInsertComputed is not a
// function" class of failure that shipped in v1.2.0.
// DOM-side APIs (URL, AbortSignal, Response, Blob, ReadableStream) are not
// present in bare jsc and are covered by scripts/test-webkit-compat.mjs.
/* eslint-disable no-var */
var missing = [];
function need(label, value) {
  if (typeof value !== "function") {
    missing.push(label);
  }
}
need("Promise.withResolvers", Promise.withResolvers);
need("Promise.try", Promise.try);
need("Map.prototype.getOrInsert", Map.prototype.getOrInsert);
need("Map.prototype.getOrInsertComputed", Map.prototype.getOrInsertComputed);
need("WeakMap.prototype.getOrInsert", WeakMap.prototype.getOrInsert);
need("WeakMap.prototype.getOrInsertComputed", WeakMap.prototype.getOrInsertComputed);
need("Set.prototype.intersection", Set.prototype.intersection);
need("Math.sumPrecise", Math.sumPrecise);
need("Uint8Array.prototype.toBase64", Uint8Array.prototype.toBase64);
need("Uint8Array.fromBase64", Uint8Array.fromBase64);
need("Uint8Array.prototype.toHex", Uint8Array.prototype.toHex);
need("Uint8Array.fromHex", Uint8Array.fromHex);
var iterProto = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
["map", "filter", "some", "every", "find", "take", "drop", "flatMap", "forEach", "reduce", "toArray"].forEach(
  function (name) {
    need("Iterator." + name, iterProto[name]);
  }
);
if (missing.length) {
  throw new Error("APIs missing in this JavaScriptCore even after polyfills: " + missing.join(", "));
}
print("jsc builtin check OK: all pdf.js-required builtins present");
