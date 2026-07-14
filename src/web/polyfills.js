// Polyfills for WebKit 16.4–17.x (older Macs; see also the copy prepended to
// build/pdf.worker.mjs — workers don't inherit these). pdf.js v6 calls both
// APIs on the document-open path: Promise.withResolvers needs Safari 17.4,
// URL.parse needs Safari 18. Classic script on purpose — it runs before the
// deferred module scripts (pdf.mjs, viewer.mjs, nobloat.js).
// Parse floor stays Safari 16.4 (static class blocks in pdf.js can't be
// polyfilled), i.e. macOS 12 Monterey with Software Update applied.
if (!Promise.withResolvers) {
  Promise.withResolvers = function () {
    let resolve, reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}
if (!URL.parse) {
  URL.parse = function (url, base) {
    try {
      return new URL(url, base);
    } catch {
      return null;
    }
  };
}
