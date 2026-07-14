// Flattens native CSS nesting in src/web/viewer.css IN PLACE using
// postcss-nesting (spec-compliant expansion). Old WebKit (< Safari 16.5,
// e.g. stock macOS 12 Monterey) drops nested rules wholesale — toolbar icons
// were the visible casualty. Flat CSS behaves identically on modern engines.
//
// Run ONCE after vendoring a new pdf.js viewer.css, BEFORE
// gen-lightdark-fallback.mjs (the fallback extractor reads viewer.css):
//   node scripts/denest-viewer-css.mjs && node scripts/gen-lightdark-fallback.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import postcssNesting from 'postcss-nesting';

const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'web', 'viewer.css');
const src = readFileSync(file, 'utf8');

const result = await postcss([postcssNesting({ edition: '2024-02' })]).process(src, {
  from: file,
  map: false,
});

// Nesting-free sanity check: no style rule may still contain a child rule.
let nested = 0;
result.root.walkRules((rule) => {
  if (rule.parent?.type === 'rule') nested++;
});
if (nested > 0) throw new Error(`${nested} rules still nested after transform`);

writeFileSync(file, result.css);
console.log(`flattened viewer.css: ${src.length} -> ${result.css.length} bytes, 0 nested rules left`);
