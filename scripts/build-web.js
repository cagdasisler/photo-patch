'use strict';

// Builds the web version into web-dist/: the app's own src/ files, minus the Electron
// main and preload scripts, plus web/ (a browser window.api and the web-only extras).
// Run with `npm run web:build`; Vercel runs it too (see vercel.json).

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'web-dist');
const DESKTOP_ONLY = new Set(['main.js', 'preload.js']);

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(root, 'src'), out, {
  recursive: true,
  filter: (from) => !DESKTOP_ONLY.has(path.relative(path.join(root, 'src'), from)),
});
fs.cpSync(path.join(root, 'web'), out, { recursive: true });
fs.copyFileSync(path.join(root, 'build', 'icon.png'), path.join(out, 'icon.png'));

const DESCRIPTION =
  'Copy a box from a picture and paste it over another spot: cover a blemish, hide something in the background, or add a signature. Free, and your pictures never leave your device.';

const edits = [
  [
    '<meta charset="utf-8">',
    `<meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${DESCRIPTION}">
  <meta property="og:title" content="Photo Patch">
  <meta property="og:description" content="${DESCRIPTION}">
  <meta name="theme-color" content="#eef0f4">
  <link rel="icon" type="image/png" href="icon.png">
  <link rel="apple-touch-icon" href="icon.png">`,
  ],
  ['<script src="theme.js"></script>', '<script src="theme.js"></script>\n  <script src="web-api.js"></script>'],
  [
    '<link rel="stylesheet" href="signatures.css">',
    '<link rel="stylesheet" href="signatures.css">\n  <link rel="stylesheet" href="web.css">',
  ],
  ['<script src="renderer.js"></script>', '<script src="renderer.js"></script>\n  <script src="web-shell.js"></script>'],
  ['drag and drop one anywhere in this window', 'drag and drop one anywhere on this page'],
];

const indexPath = path.join(out, 'index.html');
let html = fs.readFileSync(indexPath, 'utf8');
for (const [find, replace] of edits) {
  if (!html.includes(find)) throw new Error(`build-web: "${find}" is no longer in src/index.html`);
  html = html.replace(find, replace);
}
fs.writeFileSync(indexPath, html);

console.log(`Web version built in ${path.relative(root, out)}/`);
