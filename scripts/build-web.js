'use strict';

// Builds the web version into web-dist/: the app's own src/ files, minus the Electron
// main and preload scripts, plus web/ (a browser window.api and the web-only extras).
// Run with `npm run web:build`; Vercel runs it too (see vercel.json).

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'web-dist');
const DESKTOP_ONLY = new Set(['main.js', 'preload.js']);
const RELEASES_API = 'https://api.github.com/repos/cagdasisler/photo-patch/releases/latest';
const RELEASES_PAGE = 'https://github.com/cagdasisler/photo-patch/releases/latest';

// The download buttons link straight to the newest installer, so redeploy after a release.
// Without GitHub (offline build), they fall back to the Releases page.
async function latestRelease() {
  const fallback = { page: RELEASES_PAGE };
  try {
    const res = await fetch(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const release = await res.json();
    const asset = (kind) => {
      const a = release.assets.find((x) => x.name.includes(`-${kind}-`) && x.name.endsWith('.exe'));
      return a && { name: a.name, url: a.browser_download_url, size: a.size };
    };
    return {
      ...fallback,
      version: release.tag_name.replace(/^v/, ''),
      setup: asset('Setup'),
      portable: asset('Portable'),
    };
  } catch (err) {
    console.warn(`build-web: couldn't look up the latest release (${err.message}); linking to the Releases page.`);
    return fallback;
  }
}

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
  ['drag and drop one anywhere in this window', 'drag and drop one anywhere on this page'],
];

(async () => {
  const release = await latestRelease();
  // Data, not code, so the page's script-src 'self' policy allows it.
  const releaseJson = JSON.stringify(release).replace(/</g, '\\u003c');
  edits.push([
    '<script src="renderer.js"></script>',
    `<script src="renderer.js"></script>
  <script id="app-release" type="application/json">${releaseJson}</script>
  <script src="web-shell.js"></script>`,
  ]);

  const indexPath = path.join(out, 'index.html');
  let html = fs.readFileSync(indexPath, 'utf8');
  for (const [find, replace] of edits) {
    if (!html.includes(find)) throw new Error(`build-web: "${find}" is no longer in src/index.html`);
    html = html.replace(find, replace);
  }
  fs.writeFileSync(indexPath, html);

  console.log(`Web version built in ${path.relative(root, out)}/ (app ${release.version ? `v${release.version}` : 'link: Releases page'})`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
