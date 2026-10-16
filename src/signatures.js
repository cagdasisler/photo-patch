'use strict';

// Signatures: draw, type or upload a signature, keep it for later, and hand it
// to the editor as a transparent canvas. The editor places it on the picture as
// a piece, so it can be moved, resized, undone and removed like any other.
//
// The editor connects with Signatures.init({ hasImage, place, toast }) and opens
// the dialog with Signatures.open().

const Signatures = (() => {
  const MAX_SAVED = 50; // keep in step with MAX_SIGNATURES in main.js
  const UPLOAD_MAX_SIDE = 1600;
  const TYPE_SIZE = 140;
  const HANDWRITING_FONTS = [
    'Segoe Script',
    'Ink Free',
    'Lucida Handwriting',
    'Brush Script MT',
    'Freestyle Script',
    'Segoe Print',
    'Gabriola',
  ];
  const ICON_X = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
  const ICON_PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg>';

  const dialog = document.getElementById('sign-dialog');
  const pad = document.getElementById('sig-pad');
  const padCtx = pad.getContext('2d');
  const padWrap = document.getElementById('pad-wrap');
  const widthInput = document.getElementById('sig-width');
  const textInput = document.getElementById('sig-text');
  const fontChoices = document.getElementById('font-choices');
  const uploadCanvas = document.getElementById('sig-upload');
  const uploadNote = document.getElementById('upload-note');
  const cleanInput = document.getElementById('sig-clean');
  const keepInput = document.getElementById('sig-keep');
  const foot = document.getElementById('sign-foot');
  const useButton = dialog.querySelector('[data-sign="use"]');
  const savedEmpty = document.getElementById('saved-empty');
  const savedNote = document.getElementById('saved-note');
  const savedHint = document.getElementById('saved-hint');
  const savedList = document.getElementById('sig-dialog-list');

  const s = {
    saved: [], // { id, dataUrl, createdAt }, newest first
    tab: 'draw',
    ink: '#111111',
    strokes: [], // each stroke is a list of { x, y, p } in pad pixels
    current: null,
    fonts: null, // [{ label, css }], found on first use
    font: 0,
    uploadSource: null, // the uploaded picture, before cleaning
    uploadResult: null, // what will be used, after cleaning
  };

  let editor = {
    hasImage: () => false,
    place: () => {},
    toast: () => {},
  };

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /* ---------------------------------------------------------------------- */
  /* Canvas helpers                                                         */
  /* ---------------------------------------------------------------------- */

  // Crops a canvas to its visible ink plus a little margin; null when it's empty.
  function trimCanvas(canvas, margin = 6) {
    const { width: w, height: h } = canvas;
    if (!w || !h) return null;
    const d = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (d[(y * w + x) * 4 + 3] > 8) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return null;
    x0 = Math.max(0, x0 - margin);
    y0 = Math.max(0, y0 - margin);
    x1 = Math.min(w - 1, x1 + margin);
    y1 = Math.min(h - 1, y1 + margin);
    const out = document.createElement('canvas');
    out.width = x1 - x0 + 1;
    out.height = y1 - y0 + 1;
    out.getContext('2d').drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
    return out;
  }

  async function canvasFromDataUrl(dataUrl) {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    return c;
  }

  /* ---------------------------------------------------------------------- */
  /* Draw                                                                   */
  /* ---------------------------------------------------------------------- */

  // Smooth strokes: each segment curves through the midpoints between samples.
  // A pen's pressure makes the line thicker or thinner; a mouse draws evenly.
  function drawStrokes(g) {
    const base = Number(widthInput.value) * 2;
    g.save();
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.strokeStyle = s.ink;
    g.fillStyle = s.ink;
    for (const pts of s.strokes) {
      if (pts.length === 1) {
        g.beginPath();
        g.arc(pts[0].x, pts[0].y, (base * (0.55 + pts[0].p * 0.9)) / 2, 0, Math.PI * 2);
        g.fill();
        continue;
      }
      let from = pts[0];
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i];
        const next = pts[i + 1];
        const to = next ? { x: (p.x + next.x) / 2, y: (p.y + next.y) / 2 } : p;
        g.lineWidth = base * (0.55 + p.p * 0.9);
        g.beginPath();
        g.moveTo(from.x, from.y);
        g.quadraticCurveTo(p.x, p.y, to.x, to.y);
        g.stroke();
        from = to;
      }
    }
    g.restore();
  }

  function renderPad() {
    padCtx.clearRect(0, 0, pad.width, pad.height);
    drawStrokes(padCtx);
    padWrap.classList.toggle('has-ink', s.strokes.length > 0);
  }

  function padPoint(e) {
    const r = pad.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) * pad.width) / r.width,
      y: ((e.clientY - r.top) * pad.height) / r.height,
      p: e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5,
    };
  }

  pad.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    pad.setPointerCapture(e.pointerId);
    s.current = [padPoint(e)];
    s.strokes.push(s.current);
    renderPad();
    updateUI();
  });

  pad.addEventListener('pointermove', (e) => {
    if (!s.current) return;
    const events = e.getCoalescedEvents?.() || [];
    for (const ev of events.length ? events : [e]) s.current.push(padPoint(ev));
    renderPad();
  });

  const endStroke = () => {
    s.current = null;
  };
  pad.addEventListener('pointerup', endStroke);
  pad.addEventListener('pointercancel', endStroke);
  pad.addEventListener('lostpointercapture', endStroke);

  widthInput.addEventListener('input', renderPad);

  function drawnSignature() {
    if (s.strokes.length === 0) return null;
    const c = document.createElement('canvas');
    c.width = pad.width;
    c.height = pad.height;
    drawStrokes(c.getContext('2d'));
    return trimCanvas(c);
  }

  /* ---------------------------------------------------------------------- */
  /* Type                                                                   */
  /* ---------------------------------------------------------------------- */

  // A font is installed if text set in it measures differently from the fallback.
  function fontInstalled(name) {
    const g = document.createElement('canvas').getContext('2d');
    const sample = 'Signature Wqy 0123';
    return ['monospace', 'serif'].some((fallback) => {
      g.font = `40px ${fallback}`;
      const plain = g.measureText(sample).width;
      g.font = `40px "${name}", ${fallback}`;
      return g.measureText(sample).width !== plain;
    });
  }

  function availableFonts() {
    if (!s.fonts) {
      s.fonts = HANDWRITING_FONTS.filter(fontInstalled).map((name) => ({ label: name, css: `"${name}", cursive` }));
      if (s.fonts.length === 0) s.fonts = [{ label: 'Handwriting', css: 'cursive' }];
    }
    return s.fonts;
  }

  function renderFontChoices() {
    const text = textInput.value.trim() || 'Your name';
    const buttons = availableFonts().map((font, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'font-choice';
      b.dataset.font = String(i);
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(i === s.font));
      b.title = font.label;
      b.style.fontFamily = font.css;
      b.style.color = s.ink;
      b.textContent = text;
      return b;
    });
    fontChoices.replaceChildren(...buttons);
  }

  function typedSignature() {
    const text = textInput.value.trim();
    if (!text) return null;
    const font = `${TYPE_SIZE}px ${availableFonts()[s.font].css}`;
    const c = document.createElement('canvas');
    const g = c.getContext('2d');
    g.font = font;
    // Script fonts swash well past their measured width, so leave generous room.
    c.width = Math.ceil(g.measureText(text).width + TYPE_SIZE * 2);
    c.height = TYPE_SIZE * 2.4;
    g.font = font;
    g.fillStyle = s.ink;
    g.textBaseline = 'middle';
    g.fillText(text, TYPE_SIZE, c.height / 2);
    return trimCanvas(c);
  }

  textInput.addEventListener('input', () => {
    renderFontChoices();
    updateUI();
  });

  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      useSignature();
    }
  });

  /* ---------------------------------------------------------------------- */
  /* Upload                                                                 */
  /* ---------------------------------------------------------------------- */

  // Makes light paper see-through and keeps the darker ink, so a photo or scan
  // of a signature sits cleanly on top of another picture.
  function removePaper(canvas) {
    const g = canvas.getContext('2d');
    const img = g.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    const pixels = d.length / 4;
    const lum = new Uint8Array(pixels);
    const histogram = new Uint32Array(256);
    let seeThrough = 0;
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      lum[j] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
      if (d[i + 3] < 128) seeThrough++;
      else histogram[lum[j]]++;
    }
    if (seeThrough > pixels * 0.1) return; // already has a see-through background

    // Paper covers most of the picture, so the middle brightness is the paper's.
    let paper = 255;
    for (let v = 0, seen = 0; v < 256; v++) {
      seen += histogram[v];
      if (seen >= (pixels - seeThrough) / 2) {
        paper = v;
        break;
      }
    }
    const hi = Math.max(40, paper - 30);
    const lo = Math.max(0, hi - 80);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      d[i + 3] = Math.round(d[i + 3] * clamp((hi - lum[j]) / (hi - lo), 0, 1));
    }
    g.putImageData(img, 0, 0);
  }

  function renderUpload() {
    s.uploadResult = null;
    if (s.uploadSource) {
      const c = document.createElement('canvas');
      c.width = s.uploadSource.width;
      c.height = s.uploadSource.height;
      c.getContext('2d').drawImage(s.uploadSource, 0, 0);
      if (cleanInput.checked) removePaper(c);
      s.uploadResult = trimCanvas(c, 2);
    }
    const result = s.uploadResult;
    uploadCanvas.hidden = !result;
    if (result) {
      uploadCanvas.width = result.width;
      uploadCanvas.height = result.height;
      uploadCanvas.getContext('2d').drawImage(result, 0, 0);
      uploadNote.textContent = '';
    } else if (s.uploadSource) {
      uploadNote.textContent = 'No signature found in that picture. Try turning off “Remove the paper background”.';
    } else {
      uploadNote.textContent = 'Use a photo or scan of your signature on plain paper.';
    }
    uploadNote.hidden = Boolean(result);
    updateUI();
  }

  async function chooseUpload() {
    const file = await window.api.openImage();
    if (!file) return;
    let bitmap;
    try {
      bitmap = await createImageBitmap(new Blob([file.data]), { imageOrientation: 'from-image' });
    } catch {
      s.uploadSource = null;
      renderUpload();
      uploadNote.textContent = `Couldn’t open “${file.name}”. Try a PNG or JPG picture.`;
      return;
    }
    const k = Math.min(1, UPLOAD_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bitmap.width * k));
    c.height = Math.max(1, Math.round(bitmap.height * k));
    c.getContext('2d').drawImage(bitmap, 0, 0, c.width, c.height);
    bitmap.close();
    s.uploadSource = c;
    renderUpload();
  }

  cleanInput.addEventListener('change', renderUpload);

  /* ---------------------------------------------------------------------- */
  /* Saved signatures                                                       */
  /* ---------------------------------------------------------------------- */

  function renderSaved() {
    const items = s.saved.map((entry) => {
      const li = document.createElement('li');
      li.className = 'sig-item';

      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'sig-thumb';
      pick.dataset.useSaved = entry.id;
      pick.title = 'Add this signature to the picture';
      const img = document.createElement('img');
      img.src = entry.dataUrl;
      img.alt = 'Saved signature';
      img.draggable = false;
      pick.append(img);

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'icon-btn sig-del';
      del.dataset.deleteSaved = entry.id;
      del.title = 'Delete this saved signature';
      del.setAttribute('aria-label', 'Delete saved signature');
      del.innerHTML = ICON_X;

      li.append(pick, del);
      return li;
    });

    // The last tile starts a new signature on the Draw tab.
    const add = document.createElement('li');
    add.className = 'sig-item';
    const addButton = document.createElement('button');
    addButton.type = 'button';
    addButton.className = 'sig-thumb sig-new';
    addButton.dataset.sign = 'new';
    addButton.title = 'Draw, type or upload a new signature';
    addButton.innerHTML = `${ICON_PLUS}<span>New signature</span>`;
    add.append(addButton);

    savedList.replaceChildren(...items, add);
    savedEmpty.hidden = s.saved.length > 0;
  }

  async function persist() {
    try {
      await window.api.saveSignatures(s.saved);
      return true;
    } catch {
      editor.toast('Couldn’t save your signatures to disk.', 'error');
      return false;
    }
  }

  async function keep(canvas) {
    if (s.saved.length >= MAX_SAVED) {
      editor.toast(`You can keep up to ${MAX_SAVED} signatures. Delete one to save another.`, 'error');
      return;
    }
    const entry = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      dataUrl: canvas.toDataURL('image/png'),
      createdAt: Date.now(),
    };
    s.saved.unshift(entry);
    if (!(await persist())) s.saved = s.saved.filter((x) => x !== entry);
    renderSaved();
  }

  async function placeSaved(id) {
    const entry = s.saved.find((x) => x.id === id);
    if (!entry) return;
    if (!editor.hasImage()) {
      editor.toast('Open a picture first, then click a signature to add it.');
      return;
    }
    let canvas;
    try {
      canvas = await canvasFromDataUrl(entry.dataUrl);
    } catch {
      editor.toast('That saved signature couldn’t be loaded.', 'error');
      return;
    }
    if (dialog.open) dialog.close();
    editor.place(canvas);
  }

  async function deleteSaved(id) {
    if (!window.confirm('Delete this saved signature? Signatures already placed on the picture stay.')) return;
    const before = s.saved;
    s.saved = s.saved.filter((x) => x.id !== id);
    if (!(await persist())) s.saved = before;
    renderSaved();
    updateUI();
  }

  savedList.addEventListener('click', (e) => {
    const del = e.target.closest('[data-delete-saved]');
    if (del) {
      deleteSaved(del.dataset.deleteSaved);
      return;
    }
    const pick = e.target.closest('[data-use-saved]');
    if (pick) placeSaved(pick.dataset.useSaved);
  });

  /* ---------------------------------------------------------------------- */
  /* Dialog                                                                 */
  /* ---------------------------------------------------------------------- */

  function hasContent() {
    if (s.tab === 'draw') return s.strokes.length > 0;
    if (s.tab === 'type') return textInput.value.trim() !== '';
    if (s.tab === 'upload') return Boolean(s.uploadResult);
    return false;
  }

  function updateUI() {
    for (const tab of dialog.querySelectorAll('[data-tab]')) {
      tab.setAttribute('aria-selected', String(tab.dataset.tab === s.tab));
    }
    for (const panel of dialog.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== s.tab;
    for (const swatch of dialog.querySelectorAll('[data-ink]')) {
      swatch.setAttribute('aria-pressed', String(swatch.dataset.ink === s.ink));
    }
    for (const b of dialog.querySelectorAll('[data-sign="undo-stroke"], [data-sign="clear"]')) {
      b.disabled = s.strokes.length === 0;
    }

    const hasImage = editor.hasImage();
    foot.hidden = s.tab === 'saved';
    useButton.disabled = !hasContent();
    useButton.textContent = hasImage ? 'Add to picture' : 'Save signature';
    // Without a picture there's nowhere to put it, so saving is the only option.
    keepInput.disabled = !hasImage;
    if (!hasImage) keepInput.checked = true;
    savedNote.hidden = hasImage || s.saved.length === 0;
    savedHint.hidden = !hasImage || s.saved.length === 0;
  }

  function currentSignature() {
    if (s.tab === 'draw') return drawnSignature();
    if (s.tab === 'type') return typedSignature();
    if (s.tab === 'upload') return s.uploadResult;
    return null;
  }

  async function useSignature() {
    if (!hasContent()) return;
    const canvas = currentSignature();
    if (!canvas) return;
    const hasImage = editor.hasImage();
    if (keepInput.checked || !hasImage) await keep(canvas);
    dialog.close();
    if (hasImage) editor.place(canvas);
    else editor.toast('Signature saved. Open a picture, then click it to add it.');
  }

  function setTab(tab) {
    s.tab = tab;
    updateUI();
    if (tab === 'type') textInput.focus();
  }

  dialog.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]');
    if (tab) {
      setTab(tab.dataset.tab);
      return;
    }
    const swatch = e.target.closest('[data-ink]');
    if (swatch) {
      s.ink = swatch.dataset.ink;
      renderPad();
      renderFontChoices();
      updateUI();
      return;
    }
    const font = e.target.closest('[data-font]');
    if (font) {
      s.font = Number(font.dataset.font);
      renderFontChoices();
      updateUI();
      return;
    }
    const command = e.target.closest('[data-sign]')?.dataset.sign;
    if (command === 'close') dialog.close();
    else if (command === 'use') useSignature();
    else if (command === 'new') setTab('draw');
    else if (command === 'choose-file') chooseUpload();
    else if (command === 'undo-stroke') {
      s.strokes.pop();
      renderPad();
      updateUI();
    } else if (command === 'clear') {
      s.strokes = [];
      renderPad();
      updateUI();
    }
  });

  function open() {
    if (dialog.open) return;
    s.tab = s.saved.length > 0 ? 'saved' : 'draw';
    s.strokes = [];
    s.current = null;
    s.uploadSource = null;
    textInput.value = '';
    renderPad();
    renderFontChoices();
    renderUpload();
    dialog.showModal();
    updateUI();
  }

  function init(hooks) {
    editor = { ...editor, ...hooks };
    window.api
      .loadSignatures()
      .then((list) => {
        s.saved = Array.isArray(list) ? list : [];
      })
      .catch(() => {})
      .finally(() => {
        renderSaved();
        updateUI();
      });
  }

  return {
    init,
    open,
    isOpen: () => dialog.open,
  };
})();
