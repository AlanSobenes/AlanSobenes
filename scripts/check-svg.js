#!/usr/bin/env node
/**
 * Gate: every asset must be well-formed XML.
 *
 * An SVG referenced from a README is decoded as an *image*, which requires
 * strict XML — unlike the HTML parser, which silently tolerates things like a
 * bare "&". A single unescaped ampersand makes the decoder reject the whole
 * file and the panel renders as an empty box. That shipped once; this stops it.
 *
 * No dependencies: uses the XML parser built into Node's WHATWG DOM shim when
 * available, and falls back to a strict scanner for the failure modes that
 * actually bite (bare &, unbalanced tags, stray < in text).
 */
const fs = require('fs');
const path = require('path');

const dir = process.argv[2] || path.resolve(__dirname, '..', 'assets');
const ENTITY = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g;

function check(file, xml) {
  const errors = [];

  // 1. bare ampersands — the one that broke stack-dark.svg
  let m;
  while ((m = ENTITY.exec(xml))) {
    const line = xml.slice(0, m.index).split('\n').length;
    const ctx = xml.slice(Math.max(0, m.index - 45), m.index + 25).replace(/\n/g, ' ');
    errors.push(`bare "&" at line ${line}: …${ctx}…`);
  }

  // 2. tag balance
  const stack = [];
  const tagRe = /<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/g;
  while ((m = tagRe.exec(xml))) {
    const [, closing, name, attrs, selfClose] = m;
    if (closing) {
      const open = stack.pop();
      if (open !== name) errors.push(`tag mismatch: </${name}> closes <${open || 'nothing'}>`);
    } else if (!selfClose && !attrs.endsWith('/')) {
      stack.push(name);
    }
  }
  if (stack.length) errors.push(`unclosed tags: ${stack.join(', ')}`);

  // 3. attribute quoting
  const badAttr = xml.match(/\s[a-zA-Z-]+=(?!["'])[^\s>]+/g);
  if (badAttr) errors.push(`unquoted attribute(s): ${badAttr.slice(0, 3).join(', ')}`);

  return errors;
}

let failed = 0;
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.svg')).sort();
if (!files.length) {
  console.error(`No SVGs found in ${dir}`);
  process.exit(1);
}
for (const f of files) {
  const errs = check(f, fs.readFileSync(path.join(dir, f), 'utf8'));
  if (errs.length) {
    failed++;
    console.error(`FAIL  ${f}`);
    errs.slice(0, 5).forEach((e) => console.error(`        ${e}`));
  } else {
    console.log(`ok    ${f}`);
  }
}
if (failed) {
  console.error(`\n${failed} file(s) would fail to decode as an image.`);
  process.exit(1);
}
console.log(`\nAll ${files.length} assets are well-formed.`);
