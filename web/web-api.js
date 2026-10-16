'use strict';

// Browser stand-in for preload.js: the same window.api the desktop app gets from Electron,
// built on web features, so renderer.js and signatures.js run unchanged.
// Everything stays in the visitor's browser; no picture is ever uploaded.
(() => {
  const OPEN_ACCEPT = 'image/*,application/pdf,.png,.jpg,.jpeg,.jfif,.webp,.gif,.bmp,.avif,.pdf';
  const SAVE_TYPES = {
    png: { label: 'PNG picture (best quality)', mime: 'image/png', exts: ['.png'] },
    jpg: { label: 'JPEG picture (smaller file)', mime: 'image/jpeg', exts: ['.jpg', '.jpeg'] },
    webp: { label: 'WebP picture', mime: 'image/webp', exts: ['.webp'] },
    pdf: { label: 'PDF document', mime: 'application/pdf', exts: ['.pdf'] },
  };
  const MAX_SIGNATURES = 50;
  const MAX_SIGNATURE_CHARS = 8 * 1024 * 1024;

  let dirty = false;
  // Files picked in the browser's save dialog, by the name handed back to the editor.
  const saveHandles = new Map();

  const baseName = (path) => String(path || '').split(/[\\/]/).pop();
  const extensionOf = (name) => (/\.([^.]+)$/.exec(name)?.[1] || '').toLowerCase();

  /* ---------- Open ---------- */

  function openImage() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = OPEN_ACCEPT;
      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        resolve(file ? { name: file.name, path: '', data: await file.arrayBuffer() } : null);
      });
      input.addEventListener('cancel', () => resolve(null));
      input.click();
    });
  }

  /* ---------- Save ---------- */

  // Chrome and Edge have a real "Save as" dialog. Other browsers get a small one of ours
  // to pick the name and format, and the picture goes to their downloads folder.
  async function chooseSavePath(suggestedPath) {
    const suggested = baseName(suggestedPath) || 'edited.png';
    if (typeof window.showSaveFilePicker === 'function') {
      try {
        // The suggested file's type comes first, so the picker starts on it (PDF for a PDF).
        const ext = extensionOf(suggested);
        const types = Object.values(SAVE_TYPES).sort(
          (a, b) => b.exts.includes('.' + ext) - a.exts.includes('.' + ext),
        );
        const handle = await window.showSaveFilePicker({
          suggestedName: suggested,
          types: types.map(({ label, mime, exts }) => ({ description: label, accept: { [mime]: exts } })),
        });
        // The editor picks the format from the extension, and writes PNG for anything else.
        saveHandles.set(handle.name, handle);
        return handle.name;
      } catch (err) {
        if (err?.name === 'AbortError') return null;
        // Blocked (e.g. inside a frame): fall through to the download dialog.
      }
    }
    return askForDownloadName(suggested);
  }

  async function writeFile(name, bytes) {
    const handle = saveHandles.get(name);
    if (handle) {
      const writable = await handle.createWritable();
      await writable.write(bytes);
      await writable.close();
      return;
    }
    const type = SAVE_TYPES[extensionOf(name) === 'jpeg' ? 'jpg' : extensionOf(name)]?.mime || 'image/png';
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  let saveDialog = null;

  function buildSaveDialog() {
    const d = document.createElement('dialog');
    d.className = 'sign-dialog web-save-dialog';
    d.setAttribute('aria-labelledby', 'web-save-title');
    d.innerHTML = `
      <form method="dialog">
        <header class="sign-head">
          <h2 id="web-save-title">Save your edits</h2>
        </header>
        <div class="web-save-body">
          <label class="web-field">
            <span>File name</span>
            <input name="name" class="text-input" type="text" spellcheck="false" autocomplete="off" required>
          </label>
          <label class="web-field">
            <span>Format</span>
            <select name="format" class="text-input">
              ${Object.entries(SAVE_TYPES).map(([ext, t]) => `<option value="${ext}">${t.label}</option>`).join('')}
            </select>
          </label>
          <p class="muted web-save-note">The picture goes to your browser’s downloads folder.</p>
        </div>
        <footer class="sign-foot">
          <span class="spacer"></span>
          <button type="submit" class="btn" value="cancel" formnovalidate>Cancel</button>
          <button type="submit" class="primary" value="save">Download</button>
        </footer>
      </form>`;
    // Typing a name must not trigger editor shortcuts (H, Delete, arrows…).
    d.addEventListener('keydown', (e) => e.stopPropagation());
    document.body.append(d);
    return d;
  }

  function askForDownloadName(suggested) {
    saveDialog ||= buildSaveDialog();
    const form = saveDialog.querySelector('form');
    const ext = extensionOf(suggested);
    form.elements.name.value = suggested.replace(/\.[^.]+$/, '');
    form.elements.format.value = SAVE_TYPES[ext] ? ext : ext === 'jpeg' ? 'jpg' : 'png';
    saveDialog.returnValue = '';
    saveDialog.showModal();
    form.elements.name.select();

    return new Promise((resolve) => {
      saveDialog.addEventListener(
        'close',
        () => {
          if (saveDialog.returnValue !== 'save') return resolve(null);
          const base = form.elements.name.value.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\.(png|jpe?g|webp|pdf)$/i, '') || 'edited';
          const name = `${base}.${form.elements.format.value}`;
          saveHandles.delete(name);
          resolve(name);
        },
        { once: true },
      );
    });
  }

  /* ---------- Saved signatures (IndexedDB: room for big uploads, unlike localStorage) ---------- */

  function db() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('photo-patch', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function kv(mode, run) {
    const conn = await db();
    try {
      return await new Promise((resolve, reject) => {
        const tx = conn.transaction('kv', mode);
        const req = run(tx.objectStore('kv'));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
    } finally {
      conn.close();
    }
  }

  function isSignature(entry) {
    return (
      entry !== null &&
      typeof entry === 'object' &&
      typeof entry.id === 'string' &&
      entry.id.length <= 64 &&
      typeof entry.dataUrl === 'string' &&
      entry.dataUrl.startsWith('data:image/png;base64,') &&
      entry.dataUrl.length <= MAX_SIGNATURE_CHARS &&
      Number.isFinite(entry.createdAt)
    );
  }

  async function loadSignatures() {
    try {
      const list = await kv('readonly', (store) => store.get('signatures'));
      return Array.isArray(list) ? list.filter(isSignature).slice(0, MAX_SIGNATURES) : [];
    } catch {
      return [];
    }
  }

  async function saveSignatures(list) {
    if (!Array.isArray(list) || list.length > MAX_SIGNATURES || !list.every(isSignature)) {
      throw new Error('Invalid signature list.');
    }
    const clean = list.map(({ id, dataUrl, createdAt }) => ({ id, dataUrl, createdAt }));
    await kv('readwrite', (store) => store.put(clean, 'signatures'));
  }

  /* ---------- Window ---------- */

  window.addEventListener('beforeunload', (event) => {
    if (dirty) event.preventDefault();
  });

  // The browser's own toolbar takes the page color on phones and installed web apps.
  function setTitleBarColors(color) {
    if (!/^#[0-9a-f]{6}$/i.test(color)) return;
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'theme-color';
      document.head.append(meta);
    }
    meta.content = color;
  }

  window.api = {
    openImage,
    startupImage: async () => null,
    chooseSavePath,
    writeFile,
    setDirty: (value) => {
      dirty = Boolean(value);
    },
    setTitleBarColors,
    loadSignatures,
    saveSignatures,
    pathForFile: () => '',
  };
})();
