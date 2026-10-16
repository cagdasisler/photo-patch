'use strict';

// Copies the PDF libraries from node_modules into src/vendor/, so the app and the
// web version load them from their own files (offline, no CDN). Run after updating
// pdfjs-dist or pdf-lib: `npm run vendor`.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const modules = path.join(root, 'node_modules');
const vendor = path.join(root, 'src', 'vendor');

const copies = [
  // pdf.js: reads and draws PDF pages.
  ['pdfjs-dist/build/pdf.min.mjs', 'pdfjs/pdf.min.mjs'],
  ['pdfjs-dist/build/pdf.worker.min.mjs', 'pdfjs/pdf.worker.min.mjs'],
  ['pdfjs-dist/cmaps', 'pdfjs/cmaps'], // text in Chinese, Japanese and Korean PDFs
  ['pdfjs-dist/standard_fonts', 'pdfjs/standard_fonts'], // fonts a PDF names but doesn't include
  ['pdfjs-dist/wasm', 'pdfjs/wasm'], // JPEG 2000 and JBIG2 scans, color profiles
  ['pdfjs-dist/iccs', 'pdfjs/iccs'],
  ['pdfjs-dist/LICENSE', 'pdfjs/LICENSE'],
  // pdf-lib: writes the edited PDF.
  ['pdf-lib/dist/pdf-lib.min.js', 'pdf-lib/pdf-lib.min.js'],
  ['pdf-lib/LICENSE.md', 'pdf-lib/LICENSE.md'],
];

fs.rmSync(vendor, { recursive: true, force: true });
for (const [from, to] of copies) {
  fs.cpSync(path.join(modules, from), path.join(vendor, to), {
    recursive: true,
    filter: (file) => !path.basename(file).startsWith('quickjs'), // runs a PDF's own scripts; not used
  });
}

const versions = ['pdfjs-dist', 'pdf-lib'].map((name) => {
  const { version } = JSON.parse(fs.readFileSync(path.join(modules, name, 'package.json'), 'utf8'));
  return `${name} ${version}`;
});
fs.writeFileSync(path.join(vendor, 'VERSIONS.txt'), `${versions.join('\n')}\n`);
console.log(`Copied ${versions.join(' and ')} into src/vendor/`);
