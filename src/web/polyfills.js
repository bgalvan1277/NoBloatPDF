// Polyfills for WebKit older than what pdf.js v6 assumes. Keep in sync with
// the copy prepended to build/pdf.worker.mjs (workers don't inherit these).
// Classic script on purpose: it runs before the deferred module scripts
// (pdf.mjs, viewer.mjs, nobloat.js).
//
// Parse floor stays Safari 16.4 (static class blocks in pdf.js can't be
// polyfilled), i.e. macOS 12 Monterey with Software Update applied. Every
// runtime API pdf.js 6.1 uses beyond that floor is covered here, with the
// Safari version that ships it natively:
//   Set.prototype.intersection                 17.0
//   Promise.withResolvers, AbortSignal.any     17.4
//   URL.parse                                  18.0
//   Promise.try, Uint8Array base64 and hex
//   conversion, Response/Blob.bytes            18.2
//   Iterator helpers (.map/.some/... on
//   Map/Set iterators)                         18.4
//   Map/WeakMap getOrInsertComputed,
//   Math.sumPrecise,
//   ReadableStream async iteration             26+
// The last group means even current-macOS WebKit needs these; the
// getOrInsertComputed gap is what broke document open on macOS 15 (v1.2.0).
(function () {
  "use strict";
  const def = (obj, name, fn) =>
    Object.defineProperty(obj, name, { value: fn, writable: true, configurable: true });

  if (!Promise.withResolvers) {
    def(Promise, "withResolvers", function () {
      let resolve, reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    });
  }

  if (!Promise.try) {
    def(Promise, "try", function (fn, ...args) {
      return new Promise(resolve => resolve(fn(...args)));
    });
  }

  if (typeof URL !== "undefined" && !URL.parse) {
    def(URL, "parse", function (url, base) {
      try {
        return new URL(url, base);
      } catch {
        return null;
      }
    });
  }

  for (const C of [Map, WeakMap]) {
    if (!C.prototype.getOrInsert) {
      def(C.prototype, "getOrInsert", function (key, value) {
        if (!this.has(key)) {
          this.set(key, value);
        }
        return this.get(key);
      });
    }
    if (!C.prototype.getOrInsertComputed) {
      def(C.prototype, "getOrInsertComputed", function (key, callback) {
        if (!this.has(key)) {
          this.set(key, callback(key));
        }
        return this.get(key);
      });
    }
  }

  if (!Set.prototype.intersection) {
    def(Set.prototype, "intersection", function (other) {
      const result = new Set();
      for (const value of this) {
        if (other.has(value)) {
          result.add(value);
        }
      }
      return result;
    });
  }

  if (!Uint8Array.prototype.toBase64) {
    def(Uint8Array.prototype, "toBase64", function (options) {
      let s = "";
      for (let i = 0; i < this.length; i += 0x8000) {
        s += String.fromCharCode.apply(null, this.subarray(i, i + 0x8000));
      }
      s = btoa(s);
      if (options?.alphabet === "base64url") {
        s = s.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
      }
      return s;
    });
  }
  if (!Uint8Array.fromBase64) {
    def(Uint8Array, "fromBase64", function (str, options) {
      if (options?.alphabet === "base64url") {
        str = str.replaceAll("-", "+").replaceAll("_", "/");
      }
      const bin = atob(str);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i);
      }
      return bytes;
    });
  }

  if (!Math.sumPrecise) {
    // Neumaier compensated summation, plenty for pdf.js's uses (glyph and
    // buffer sizes, text widths, column widths).
    def(Math, "sumPrecise", function (values) {
      let sum = 0, compensation = 0;
      for (const value of values) {
        const t = sum + value;
        compensation +=
          Math.abs(sum) >= Math.abs(value) ? sum - t + value : value - t + sum;
        sum = t;
      }
      return sum + compensation;
    });
  }

  if (!Uint8Array.prototype.toHex) {
    def(Uint8Array.prototype, "toHex", function () {
      let s = "";
      for (let i = 0; i < this.length; i++) {
        s += this[i].toString(16).padStart(2, "0");
      }
      return s;
    });
  }
  if (!Uint8Array.fromHex) {
    def(Uint8Array, "fromHex", function (str) {
      if (str.length % 2 !== 0) {
        throw new SyntaxError("string should be an even number of characters");
      }
      const bytes = new Uint8Array(str.length / 2);
      for (let i = 0; i < bytes.length; i++) {
        const byte = Number.parseInt(str.slice(2 * i, 2 * i + 2), 16);
        if (Number.isNaN(byte)) {
          throw new SyntaxError("invalid hex digit");
        }
        bytes[i] = byte;
      }
      return bytes;
    });
  }

  if (typeof AbortSignal !== "undefined" && !AbortSignal.any) {
    def(AbortSignal, "any", function (signals) {
      const controller = new AbortController();
      for (const signal of signals) {
        if (signal.aborted) {
          controller.abort(signal.reason);
          break;
        }
        signal.addEventListener("abort", () => controller.abort(signal.reason), {
          once: true,
          signal: controller.signal,
        });
      }
      return controller.signal;
    });
  }

  const bytesFromBuffer = async function () {
    return new Uint8Array(await this.arrayBuffer());
  };
  if (typeof Response !== "undefined" && !Response.prototype.bytes) {
    def(Response.prototype, "bytes", bytesFromBuffer);
  }
  if (typeof Blob !== "undefined" && !Blob.prototype.bytes) {
    def(Blob.prototype, "bytes", bytesFromBuffer);
  }

  // Iterator helpers. Generator methods returning generators keeps chained
  // calls working, because generator objects inherit from %IteratorPrototype%.
  const IterProto = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
  if (!IterProto.map) {
    def(IterProto, "map", function* (fn) {
      let i = 0;
      for (const v of this) {
        yield fn(v, i++);
      }
    });
    def(IterProto, "filter", function* (fn) {
      let i = 0;
      for (const v of this) {
        if (fn(v, i++)) {
          yield v;
        }
      }
    });
    def(IterProto, "flatMap", function* (fn) {
      let i = 0;
      for (const v of this) {
        yield* fn(v, i++);
      }
    });
    def(IterProto, "take", function* (n) {
      if (n <= 0) {
        return;
      }
      let i = 0;
      for (const v of this) {
        yield v;
        if (++i >= n) {
          return;
        }
      }
    });
    def(IterProto, "drop", function* (n) {
      let i = 0;
      for (const v of this) {
        if (i++ >= n) {
          yield v;
        }
      }
    });
    def(IterProto, "some", function (fn) {
      let i = 0;
      for (const v of this) {
        if (fn(v, i++)) {
          return true;
        }
      }
      return false;
    });
    def(IterProto, "every", function (fn) {
      let i = 0;
      for (const v of this) {
        if (!fn(v, i++)) {
          return false;
        }
      }
      return true;
    });
    def(IterProto, "find", function (fn) {
      let i = 0;
      for (const v of this) {
        if (fn(v, i++)) {
          return v;
        }
      }
      return undefined;
    });
    def(IterProto, "forEach", function (fn) {
      let i = 0;
      for (const v of this) {
        fn(v, i++);
      }
    });
    def(IterProto, "reduce", function (fn, ...initial) {
      let acc, started = false;
      if (initial.length) {
        acc = initial[0];
        started = true;
      }
      let i = 0;
      for (const v of this) {
        if (started) {
          acc = fn(acc, v, i);
        } else {
          acc = v;
          started = true;
        }
        i++;
      }
      if (!started) {
        throw new TypeError("reduce of empty iterator with no initial value");
      }
      return acc;
    });
    def(IterProto, "toArray", function () {
      return [...this];
    });
  }

  if (
    typeof ReadableStream !== "undefined" &&
    !ReadableStream.prototype[Symbol.asyncIterator]
  ) {
    const values = function ({ preventCancel = false } = {}) {
      const reader = this.getReader();
      return {
        async next() {
          try {
            const result = await reader.read();
            if (result.done) {
              reader.releaseLock();
            }
            return result;
          } catch (e) {
            reader.releaseLock();
            throw e;
          }
        },
        async return(value) {
          if (preventCancel) {
            reader.releaseLock();
          } else {
            const cancel = reader.cancel(value);
            reader.releaseLock();
            await cancel;
          }
          return { done: true, value };
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    };
    def(ReadableStream.prototype, "values", values);
    def(ReadableStream.prototype, Symbol.asyncIterator, values);
  }
})();
