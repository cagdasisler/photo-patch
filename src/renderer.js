'use strict';

// Photo Patch: copy a box from a picture and paste it over another spot.
// Pasted pieces are layers drawn on top of the untouched original picture, so
// they hide the pixels underneath instead of erasing them. Move or remove a
// piece at any time and the original shows through again.

const MIN_ZOOM = 0.02;
const MAX_ZOOM = 32;
const HISTORY_LIMIT = 200;
const ACCENT_LIGHT = '#aab3ff';

const stage = document.getElementById('stage');
const scene = document.getElementById('scene');
const overlay = document.getElementById('overlay');
const sceneCtx = scene.getContext('2d');
const overlayCtx = overlay.getContext('2d');
const emptyState = document.getElementById('empty');
const panel = document.getElementById('panel');
const piecesBtn = document.getElementById('pieces-btn');
const pieceList = document.getElementById('piece-list');
const piecesEmpty = document.getElementById('pieces-empty');
const pieceCount = document.getElementById('piece-count');
const hintEl = document.getElementById('hint');
const cursorEl = document.getElementById('cursor-pos');
const sizeEl = document.getElementById('image-size');
const titleName = document.getElementById('title-name');
const titleDirty = document.getElementById('title-dirty');
const zoomLabel = document.getElementById('zoom-label');
const toastEl = document.getElementById('toast');
const pieceBar = document.getElementById('piece-bar');
const pieceLightButton = pieceBar.querySelector('[data-action="piece-light"]');
const lightOptions = document.getElementById('light-options');
const lightStrength = document.getElementById('light-strength');
const lightStrengthValue = document.getElementById('light-strength-value');
const pieceShadowsButton = pieceBar.querySelector('[data-action="piece-shadows"]');
const shortcutsEl = document.getElementById('shortcuts');
const shortcutsBtn = document.getElementById('shortcuts-btn');
const themeBtn = document.getElementById('theme-btn');
// The rail holds every tool; "Peek at the original" lives in the pieces fly-out.
const toolbarButtons = Object.fromEntries(
  [...document.querySelectorAll('.rail [data-action], #panel [data-action="original"]')].map((b) => [b.dataset.action, b]),
);

const ICON_X = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

const state = {
  image: null, // ImageBitmap of the original picture; never modified
  name: '',
  path: '',
  lastSavePath: '',
  // { id, kind, src: canvas, x, y, w, h, light, context } drawn in order on top of the image, src stretched to
  // w × h; light: re-lit to match where it sits; context: src plus its surroundings where it was copied
  pieces: [],
  activeId: null,
  hoverId: null,
  selection: null, // { x, y, w, h } in picture pixels
  clipboard: null, // { kind, src, context, x, y, w, h, pastes, light? }
  showOriginal: false,
  matchLight: false, // new pastes match the light where they're put
  dirty: false,
};

const view = { scale: 1, ox: 0, oy: 0, fit: true }; // screen = picture * scale + offset
const history = { undo: [], redo: [] };
const pointer = { over: false, x: 0, y: 0, sx: 0, sy: 0 }; // last pointer position in picture and screen pixels
let drag = null;
let spaceHeld = false;
let nextPieceId = 1;
let lastNudgeAt = 0;
let antsOffset = 0;
let toastTimer = 0;

function makeChecker(base, square) {
  const tile = document.createElement('canvas');
  tile.width = tile.height = 16;
  const g = tile.getContext('2d');
  g.fillStyle = base;
  g.fillRect(0, 0, 16, 16);
  g.fillStyle = square;
  g.fillRect(0, 0, 8, 8);
  g.fillRect(8, 8, 8, 8);
  return sceneCtx.createPattern(tile, 'repeat');
}

// What shows behind see-through pixels, and the picture's drop shadow, per theme.
const backdrop = {
  light: { checker: makeChecker('#ffffff', '#e3e5ea'), shadow: 'rgba(20, 24, 40, 0.22)' },
  dark: { checker: makeChecker('#3a3d42', '#2c2e33'), shadow: 'rgba(0, 0, 0, 0.55)' },
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const activePiece = () => state.pieces.find((p) => p.id === state.activeId) || null;

/* ------------------------------------------------------------------------ */
/* Drawing                                                                  */
/* ------------------------------------------------------------------------ */

function syncCanvasSize(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(stage.clientWidth * dpr));
  const h = Math.max(1, Math.round(stage.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return dpr;
}

// Draws the picture as it will be saved: the original, then every piece on top
// (or only the first `count` pieces, to see what lies under a piece).
function drawComposite(g, offsetX, offsetY, withPieces, count = state.pieces.length) {
  g.drawImage(state.image, -offsetX, -offsetY);
  if (!withPieces) return;
  const smoothing = g.imageSmoothingEnabled;
  for (let i = 0; i < count; i++) {
    const p = state.pieces[i];
    const img = pieceImage(p, i);
    // A resized piece looks jagged without smoothing, even when zoomed in.
    g.imageSmoothingEnabled = smoothing || p.w !== img.width || p.h !== img.height;
    g.drawImage(img, p.x - offsetX, p.y - offsetY, p.w, p.h);
  }
  g.imageSmoothingEnabled = smoothing;
}

/* ------------------------------------------------------------------------ */
/* Match light                                                              */
/* ------------------------------------------------------------------------ */

// A piece with `light` on is drawn re-lit to match the spot it sits on (see
// lightmatch.js). That depends on what's underneath, so the re-lit version is
// kept per piece and redone when the piece, or a piece under it, changes.
const lightCache = new Map(); // piece id → { key, canvas, fast, cost, at, stamp, gain, warmth, ink }
const canvasIds = new WeakMap();
let nextCanvasId = 1;
let lightStamp = 0;
let lightRefreshTimer = 0;
let adjustingStrength = false; // the strength slider is being dragged

function canvasId(c) {
  if (!canvasIds.has(c)) canvasIds.set(c, nextCanvasId++);
  return canvasIds.get(c);
}

// Everything a piece's re-lit look depends on: the piece itself, and the pieces
// under it that reach into its surroundings (with how they look right now).
function lightKey(p, index) {
  const m = LightMatch.MARGIN;
  const parts = [p.x, p.y, p.w, p.h, canvasId(p.src), p.strength ?? 1, p.shadows ? 1 : 0];
  for (let i = 0; i < index; i++) {
    const q = state.pieces[i];
    if (q.x >= p.x + p.w + m || q.y >= p.y + p.h + m || q.x + q.w <= p.x - m || q.y + q.h <= p.y - m) continue;
    parts.push(q.id, q.x, q.y, q.w, q.h, canvasId(q.src), q.light ? lightCache.get(q.id)?.stamp : 0);
  }
  return parts.join(',');
}

function readPixels(canvas) {
  return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
}

function blankCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d', { willReadFrequently: true }).imageSmoothingQuality = 'high';
  return c;
}

function relight(p, index, key, fast) {
  const started = performance.now();
  const m = LightMatch.MARGIN;
  const { w, h } = p;

  const patch = blankCanvas(w, h);
  patch.getContext('2d').drawImage(p.src, 0, 0, w, h);
  const under = blankCanvas(w + 2 * m, h + 2 * m);
  drawComposite(under.getContext('2d'), p.x - m, p.y - m, true, index);
  let source = null;
  if (p.context) {
    // Where it was copied from, stretched along with the piece if it was resized.
    const kx = w / p.src.width;
    const ky = h / p.src.height;
    source = blankCanvas(w + 2 * m, h + 2 * m);
    source.getContext('2d').drawImage(p.context, m - m * kx, m - m * ky, p.context.width * kx, p.context.height * ky);
  }

  const result = LightMatch.match(readPixels(patch), readPixels(under), source && readPixels(source), {
    seed: p.id,
    fast,
    strength: p.strength ?? 1,
    under: Boolean(p.shadows),
  });
  let canvas = null;
  if (result) {
    canvas = blankCanvas(w, h);
    canvas.getContext('2d').putImageData(new ImageData(result.image.data, w, h), 0, 0);
  }
  const now = performance.now();
  return {
    key,
    canvas,
    fast,
    cost: now - started,
    at: now,
    stamp: ++lightStamp,
    gain: result ? result.gain : 1,
    warmth: result ? result.warmth : 0,
    ink: Boolean(result?.ink),
  };
}

// What to draw for a piece: its own pixels, or its re-lit version.
function pieceImage(p, index) {
  if (!p.light) return p.src;
  const key = lightKey(p, index);
  const live = drag?.kind === 'move' || drag?.kind === 'resize' || adjustingStrength;
  const cached = lightCache.get(p.id);
  if (cached && cached.key === key && (live || !cached.fast)) return cached.canvas || p.src;
  // While dragging, a piece that's slow to re-light keeps its last look for a
  // moment, so the drag stays smooth; it catches up when the pointer rests.
  if (cached && live && performance.now() - cached.at < cached.cost * 2) {
    clearTimeout(lightRefreshTimer);
    lightRefreshTimer = setTimeout(render, Math.max(40, cached.cost * 2));
    return cached.canvas || p.src;
  }
  const entry = relight(p, index, key, live && p.w * p.h > 250000);
  lightCache.set(p.id, entry);
  return entry.canvas || p.src;
}

function describeLight(p) {
  const e = lightCache.get(p.id);
  if (p.strength === 0) return 'Strength is at 0%, so this piece keeps its own light.';
  if (!e || !e.canvas) return 'There’s nothing around this piece to match its light to.';
  if (e.ink) return 'The ink now takes on the light and color of what’s under it.';
  const changes = [];
  if (e.gain > 1.08) changes.push(`${e.gain < 1.95 ? Math.round((e.gain - 1) * 100) + '%' : e.gain.toFixed(1) + '×'} brighter`);
  else if (e.gain < 0.92) changes.push(`${Math.round((1 - e.gain) * 100)}% darker`);
  if (e.warmth > 0.06) changes.push('warmer');
  else if (e.warmth < -0.06) changes.push('cooler');
  return changes.length ? `Matched to the light here: ${changes.join(', ')}.` : 'Matched to the light here. It was already close.';
}

// The toolbar switch: whether new pastes match the light. Flipping it also
// applies to the piece that's selected right now.
function setMatchLight(on) {
  state.matchLight = on;
  try {
    localStorage.setItem('match-light', on ? '1' : '0');
  } catch {
    // Not remembered, but it still applies for this session.
  }
  const active = activePiece();
  if (active && active.kind !== 'signature' && Boolean(active.light) !== on && !state.showOriginal) {
    setPieceLight(active, on);
    return;
  }
  refreshUI();
  showToast(on ? 'Match light is on. Pasted pieces take on the light of the spot you put them.' : 'Match light is off. Pasted pieces keep their own light.');
}

function setPieceLight(piece, on) {
  pushUndo(snapshot());
  piece.light = on;
  setDirty(true);
  refreshUI();
  showToast(on ? describeLight(piece) : 'This piece keeps its own light again.');
}

function toggleActiveLight() {
  const active = activePiece();
  if (!active || state.showOriginal) {
    setMatchLight(!state.matchLight);
    return;
  }
  setPieceLight(active, !active.light);
}

function toggleActiveShadows() {
  const active = activePiece();
  if (!active?.light) return;
  pushUndo(snapshot());
  active.shadows = !active.shadows;
  setDirty(true);
  refreshUI();
  showToast(
    active.shadows
      ? 'Now also taking on the sun spots and shadows under this piece. If something dark was under it, turn Shadows off.'
      : 'Back to matching the light around this piece only.',
  );
}

// The strength slider: one undo step per drag of it, a quick preview while it
// moves, and the full-quality look when it's let go.
lightStrength.addEventListener('input', () => {
  const active = activePiece();
  if (!active?.light) return;
  if (!adjustingStrength) {
    pushUndo(snapshot());
    adjustingStrength = true;
  }
  active.strength = Number(lightStrength.value) / 100;
  lightStrengthValue.textContent = `${lightStrength.value}%`;
  setDirty(true);
  render();
});

let strengthByPointer = false;
lightStrength.addEventListener('pointerdown', () => {
  strengthByPointer = true;
});

lightStrength.addEventListener('change', () => {
  adjustingStrength = false;
  if (strengthByPointer) lightStrength.blur(); // hand Space and the arrow keys back to the editor
  strengthByPointer = false;
  refreshUI();
  const active = activePiece();
  if (active?.light) showToast(describeLight(active));
});

function renderScene() {
  const dpr = syncCanvasSize(scene);
  const g = sceneCtx;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, scene.width, scene.height);
  const img = state.image;
  if (!img) return;

  const { scale, ox, oy } = view;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const { checker, shadow } = backdrop[Theme.current()];
  g.save();
  g.shadowColor = shadow;
  g.shadowBlur = 28;
  g.fillStyle = checker;
  g.fillRect(ox, oy, img.width * scale, img.height * scale);
  g.restore();

  g.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * ox, dpr * oy);
  g.imageSmoothingEnabled = scale < 2;
  g.imageSmoothingQuality = 'high';
  g.save();
  g.beginPath();
  g.rect(0, 0, img.width, img.height);
  g.clip();
  drawComposite(g, 0, 0, !state.showOriginal);
  g.restore();
}

function deviceBox(r, dpr) {
  return {
    x0: Math.round((view.ox + r.x * view.scale) * dpr),
    y0: Math.round((view.oy + r.y * view.scale) * dpr),
    x1: Math.round((view.ox + (r.x + r.w) * view.scale) * dpr),
    y1: Math.round((view.oy + (r.y + r.h) * view.scale) * dpr),
  };
}

// Strokes a box in device pixels; `grow` pushes the line outward so it doesn't cover the piece.
function strokeBox(g, b, lineWidth, color, { dash = [], offset = 0, grow = 0 } = {}) {
  g.save();
  g.lineWidth = lineWidth;
  g.strokeStyle = color;
  g.setLineDash(dash);
  g.lineDashOffset = offset;
  g.strokeRect(
    b.x0 - grow + lineWidth / 2,
    b.y0 - grow + lineWidth / 2,
    Math.max(0, b.x1 - b.x0 + grow * 2 - lineWidth),
    Math.max(0, b.y1 - b.y0 + grow * 2 - lineWidth),
  );
  g.restore();
}

function drawLabel(g, b, text, dpr) {
  g.save();
  g.font = `600 ${12 * dpr}px "Segoe UI", system-ui, sans-serif`;
  const padX = 7 * dpr;
  const h = 22 * dpr;
  const w = g.measureText(text).width + padX * 2;
  let x = b.x1 - w;
  let y = b.y1 + 6 * dpr;
  if (y + h > overlay.height) y = b.y1 - h - 6 * dpr;
  x = clamp(x, 4 * dpr, overlay.width - w - 4 * dpr);
  y = clamp(y, 4 * dpr, overlay.height - h - 4 * dpr);
  g.fillStyle = 'rgba(12, 13, 15, 0.86)';
  g.beginPath();
  g.roundRect(x, y, w, h, 5 * dpr);
  g.fill();
  g.fillStyle = '#fff';
  g.textBaseline = 'middle';
  g.fillText(text, x + padX, y + h / 2 + dpr * 0.5);
  g.restore();
}

// The square on the active piece's bottom-right corner that resizes it.
const HANDLE_OFFSET = 3; // screen pixels outside the piece, matching the outline
const HANDLE_HIT = 9; // how close the pointer must be, in screen pixels

function drawResizeHandle(g, b, lw) {
  const half = 5 * lw;
  const cx = b.x1 + HANDLE_OFFSET * lw;
  const cy = b.y1 + HANDLE_OFFSET * lw;
  g.save();
  g.fillStyle = '#fff';
  g.strokeStyle = 'rgba(0, 0, 0, 0.75)';
  g.lineWidth = 1.5 * lw;
  g.beginPath();
  g.roundRect(cx - half, cy - half, half * 2, half * 2, 2 * lw);
  g.fill();
  g.stroke();
  g.restore();
}

function onResizeHandle(piece, sx, sy) {
  const hx = view.ox + (piece.x + piece.w) * view.scale + HANDLE_OFFSET;
  const hy = view.oy + (piece.y + piece.h) * view.scale + HANDLE_OFFSET;
  return Math.abs(sx - hx) <= HANDLE_HIT && Math.abs(sy - hy) <= HANDLE_HIT;
}

function renderOverlay() {
  const dpr = syncCanvasSize(overlay);
  const g = overlayCtx;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, overlay.width, overlay.height);
  if (!state.image) return;
  const lw = Math.max(1, Math.round(dpr));

  if (!state.showOriginal) {
    // Outlines sit just outside the piece, with a dark edge so they show on any photo.
    const hover = state.pieces.find((p) => p.id === state.hoverId && p.id !== state.activeId);
    if (hover) {
      const b = deviceBox(hover, dpr);
      strokeBox(g, b, 3 * lw, 'rgba(0, 0, 0, 0.55)', { grow: 3 * lw });
      strokeBox(g, b, lw, ACCENT_LIGHT, { dash: [4 * lw, 3 * lw], grow: 2 * lw });
    }

    const active = activePiece();
    if (active) {
      const b = deviceBox(active, dpr);
      strokeBox(g, b, 4 * lw, 'rgba(0, 0, 0, 0.7)', { grow: 4 * lw });
      strokeBox(g, b, 2 * lw, '#fff', { grow: 3 * lw });
      drawResizeHandle(g, b, lw);
      if (drag?.kind === 'move') drawLabel(g, b, `${active.x}, ${active.y}`, dpr);
      if (drag?.kind === 'resize') drawLabel(g, b, `${active.w} × ${active.h}`, dpr);
    }
  }

  const sel = state.selection;
  if (sel) {
    const b = deviceBox(sel, dpr);
    g.fillStyle = 'rgba(109, 123, 255, 0.14)';
    g.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    strokeBox(g, b, lw, '#000');
    strokeBox(g, b, lw, '#fff', { dash: [5 * lw, 5 * lw], offset: -antsOffset * lw });
    if (drag?.kind === 'select') drawLabel(g, b, `${sel.w} × ${sel.h}`, dpr);
  }
}

function render() {
  renderScene();
  renderOverlay();
  updatePopovers();
}

// The part of the stage between the hint line at the top and the file name at the bottom.
function viewport() {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  return { left: 20, top: 66, right: Math.max(w - 20, 120), bottom: Math.max(h - 38, 140) };
}

// Places a pop-over beside a box (picture pixels), flipping sides when there's no room.
function placePopover(el, r, prefer) {
  el.hidden = false;
  const vp = viewport();
  const gap = 12;
  const x0 = view.ox + r.x * view.scale;
  const y0 = view.oy + r.y * view.scale;
  const y1 = view.oy + (r.y + r.h) * view.scale;
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  let top = prefer === 'below' ? y1 + gap : y0 - h - gap;
  if (prefer === 'below' && top + h > vp.bottom) top = y0 - h - gap;
  if (prefer === 'above' && top < vp.top) top = y1 + gap;
  el.style.left = `${Math.round(clamp(x0, vp.left, vp.right - w))}px`;
  el.style.top = `${Math.round(clamp(top, vp.top, vp.bottom - h))}px`;
}

function updatePopovers() {
  const active = activePiece();
  const changing = drag?.kind === 'move' || drag?.kind === 'resize';
  if (state.image && active && !state.showOriginal && !changing) placePopover(pieceBar, active, 'above');
  else pieceBar.hidden = true;
}

// Marching ants around the selection.
setInterval(() => {
  if (!state.selection || document.hidden) return;
  antsOffset = (antsOffset + 1) % 10;
  renderOverlay();
}, 90);

/* ------------------------------------------------------------------------ */
/* UI state                                                                 */
/* ------------------------------------------------------------------------ */

function setEnabled(action, enabled) {
  toolbarButtons[action].disabled = !enabled;
}

function refreshUI() {
  const hasImage = Boolean(state.image);
  const active = activePiece();
  if (state.pieces.length === 0) state.showOriginal = false;

  const sel = state.selection;
  setEnabled('save', hasImage);
  setEnabled('undo', history.undo.length > 0);
  setEnabled('redo', history.redo.length > 0);
  setEnabled('original', hasImage && state.pieces.length > 0);
  setEnabled('copy', hasImage && Boolean(sel || active));
  setEnabled('paste', hasImage && Boolean(state.clipboard));
  setEnabled('pieces', hasImage);
  if (!hasImage) setPiecesOpen(false);

  // Light up the button for the next step.
  toolbarButtons.open.classList.toggle('next', !hasImage);
  toolbarButtons.copy.classList.toggle('next', Boolean(sel) && drag?.kind !== 'select');
  toolbarButtons.paste.classList.toggle('next', Boolean(state.clipboard && !sel && !active));

  pieceCount.hidden = state.pieces.length === 0;
  toolbarButtons.original.setAttribute('aria-pressed', String(state.showOriginal));
  toolbarButtons['match-light'].setAttribute('aria-pressed', String(state.matchLight));
  pieceLightButton.setAttribute('aria-pressed', String(Boolean(active?.light)));
  lightOptions.hidden = !active?.light;
  if (active?.light) {
    const percent = Math.round((active.strength ?? 1) * 100);
    lightStrength.value = String(percent);
    lightStrengthValue.textContent = `${percent}%`;
    // Ink has no light pattern of its own to swap, so Shadows is for photo pieces.
    pieceShadowsButton.hidden = active.kind === 'signature';
    pieceShadowsButton.setAttribute('aria-pressed', String(Boolean(active.shadows)));
  }
  if (!active) pieceBar.hidden = true;
  for (const id of lightCache.keys()) if (!state.pieces.some((p) => p.id === id)) lightCache.delete(id);

  document.body.classList.toggle('has-image', hasImage);
  emptyState.hidden = hasImage;
  updateZoomLabel();
  renderPieceList();
  updateHint();
  updateCursor();
  render();
}

function updateZoomLabel() {
  zoomLabel.textContent = state.image ? `${Math.round(view.scale * 100)}%` : '';
}

function updateTitle() {
  const name = state.image ? `${state.dirty ? '• ' : ''}${state.name} — ` : '';
  document.title = `${name}Photo Patch`;
  titleName.textContent = state.image ? shortName(state.name) : '';
  titleDirty.hidden = !(state.image && state.dirty);
}

// Long camera names get cut in the middle, so the start and the extension both stay readable.
function shortName(name, max = 44) {
  if (name.length <= max) return name;
  const tail = Math.floor(max / 2);
  return `${name.slice(0, max - tail - 1)}…${name.slice(-tail)}`;
}

function setDirty(value) {
  if (state.dirty === value) return;
  state.dirty = value;
  window.api.setDirty(value);
  updateTitle();
}

function updateHint() {
  const sel = state.selection;
  let text;
  if (!state.image) text = 'Open a picture to begin.';
  else if (state.showOriginal) text = 'Showing the original picture. Your pasted pieces are hidden, not deleted. Press H to bring them back.';
  else if (drag?.kind === 'select' && sel) text = `Selecting ${sel.w} × ${sel.h} px. Hold Shift for a perfect square.`;
  else if (drag?.kind === 'move') text = 'Release to drop the piece here.';
  else if (drag?.kind === 'resize') text = 'Release to keep this size.';
  else if (activePiece()) text = 'Drag to move it, or drag the corner square to resize. Arrow keys nudge it. Delete removes it.';
  else if (sel) text = 'Box selected. Click Copy on the left, or press Ctrl+C.';
  else if (state.clipboard) text = 'Point where you want the copy and press Ctrl+V, or click Paste on the left.';
  else text = 'Drag on the picture to select the part you want to copy.';
  hintEl.textContent = text;
}

function updateCursor() {
  let cursor = 'default';
  if (state.image) {
    if (drag?.kind === 'pan') cursor = 'grabbing';
    else if (spaceHeld) cursor = 'grab';
    else if (drag?.kind === 'resize' || (!drag && pointer.over && overResizeHandle())) cursor = 'nwse-resize';
    else if (drag?.kind === 'move' || (state.hoverId !== null && !drag && pointer.over)) cursor = 'move';
    else cursor = 'crosshair';
  }
  overlay.style.cursor = cursor;
}

function overResizeHandle() {
  const active = activePiece();
  return Boolean(active && !state.showOriginal && onResizeHandle(active, pointer.sx, pointer.sy));
}

function showToast(message, kind = 'info') {
  toastEl.textContent = message;
  toastEl.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.className = `toast ${kind}`;
  }, 3200);
}

function renderPieceList() {
  pieceCount.textContent = String(state.pieces.length);
  piecesEmpty.hidden = state.pieces.length > 0;
  const items = state.pieces.map((p, index) => {
    const li = document.createElement('li');
    li.className = `piece${p.kind === 'signature' ? ' signature' : ''}${p.id === state.activeId ? ' active' : ''}`;
    li.dataset.id = String(p.id);

    const thumb = document.createElement('canvas');
    thumb.width = thumb.height = 88;
    const tg = thumb.getContext('2d');
    const k = Math.min(88 / p.w, 88 / p.h);
    tg.imageSmoothingQuality = 'high';
    tg.drawImage(pieceImage(p, index), (88 - p.w * k) / 2, (88 - p.h * k) / 2, p.w * k, p.h * k);

    const info = document.createElement('div');
    info.className = 'piece-info';
    const title = document.createElement('strong');
    title.textContent = p.kind === 'signature' ? 'Signature' : `Piece ${p.id}`;
    const meta = document.createElement('span');
    meta.textContent = `${p.w} × ${p.h} px · at ${p.x}, ${p.y}${p.light ? ' · light matched' : ''}`;
    info.append(title, meta);

    const remove = document.createElement('button');
    remove.className = 'icon-btn';
    remove.dataset.remove = String(p.id);
    remove.title = 'Remove this piece (the original shows again)';
    remove.setAttribute('aria-label', `Remove piece ${p.id}`);
    remove.innerHTML = ICON_X;

    li.append(thumb, info, remove);
    return li;
  });
  pieceList.replaceChildren(...items.reverse()); // newest (top-most) first
}

/* ------------------------------------------------------------------------ */
/* View: zoom and pan                                                       */
/* ------------------------------------------------------------------------ */

function fitToView() {
  if (!state.image) return;
  const pad = 12;
  const vp = viewport();
  const cw = vp.right - vp.left - pad * 2;
  const ch = vp.bottom - vp.top - pad * 2;
  const { width: iw, height: ih } = state.image;
  const scale = clamp(Math.min(cw / iw, ch / ih, 1), MIN_ZOOM, MAX_ZOOM);
  view.scale = scale;
  view.ox = Math.round((vp.left + vp.right - iw * scale) / 2);
  view.oy = Math.round((vp.top + vp.bottom - ih * scale) / 2);
  view.fit = true;
  updateZoomLabel();
  render();
}

function zoomTo(scale, sx, sy) {
  if (!state.image) return;
  if (sx === undefined) {
    const vp = viewport();
    sx = (vp.left + vp.right) / 2;
    sy = (vp.top + vp.bottom) / 2;
  }
  scale = clamp(scale, MIN_ZOOM, MAX_ZOOM);
  const ix = (sx - view.ox) / view.scale;
  const iy = (sy - view.oy) / view.scale;
  view.scale = scale;
  view.ox = sx - ix * scale;
  view.oy = sy - iy * scale;
  view.fit = false;
  updateZoomLabel();
  render();
}

const zoomBy = (factor, sx, sy) => zoomTo(view.scale * factor, sx, sy);

new ResizeObserver(() => (view.fit ? fitToView() : render())).observe(stage);
window.addEventListener('resize', () => render());

/* ------------------------------------------------------------------------ */
/* History                                                                  */
/* ------------------------------------------------------------------------ */

function snapshot() {
  return { pieces: state.pieces.map((p) => ({ ...p })), activeId: state.activeId };
}

function pushUndo(snap) {
  history.undo.push(snap);
  if (history.undo.length > HISTORY_LIMIT) history.undo.shift();
  history.redo.length = 0;
}

function restore(snap) {
  state.pieces = snap.pieces.map((p) => ({ ...p }));
  state.activeId = state.pieces.some((p) => p.id === snap.activeId) ? snap.activeId : null;
  state.hoverId = null;
  setDirty(true);
  refreshUI();
}

function undo() {
  if (drag || history.undo.length === 0) return;
  history.redo.push(snapshot());
  restore(history.undo.pop());
}

function redo() {
  if (drag || history.redo.length === 0) return;
  history.undo.push(snapshot());
  restore(history.redo.pop());
}

/* ------------------------------------------------------------------------ */
/* Editing                                                                  */
/* ------------------------------------------------------------------------ */

function copySelection() {
  if (!state.image) return;
  const sel = state.selection;
  const active = activePiece();

  if (!sel && active) {
    const { kind, src, context, x, y, w, h } = active;
    state.clipboard = { kind, src, context, x, y, w, h, pastes: 0 };
    showToast('Copied this piece. Press Ctrl+V to paste another one.');
    refreshUI();
    return;
  }
  if (!sel) {
    showToast('First drag a box around the part you want to copy.');
    return;
  }

  // Copy exactly what is visible inside the box, including any pieces already pasted there,
  // and a little of what's around it, which Match light uses to keep the grain in step.
  const m = LightMatch.MARGIN;
  const context = document.createElement('canvas');
  context.width = sel.w + 2 * m;
  context.height = sel.h + 2 * m;
  drawComposite(context.getContext('2d'), sel.x - m, sel.y - m, !state.showOriginal);
  const src = document.createElement('canvas');
  src.width = sel.w;
  src.height = sel.h;
  src.getContext('2d').drawImage(context, -m, -m);
  state.clipboard = { kind: 'patch', src, context, x: sel.x, y: sel.y, w: sel.w, h: sel.h, pastes: 0 };
  showToast(`Copied ${sel.w} × ${sel.h} px. Point where you want it and press Ctrl+V.`);
  refreshUI();
}

function pastePiece(atPointer) {
  if (!state.image) return;
  const clip = state.clipboard;
  if (!clip) {
    showToast('Nothing copied yet. Select an area and press Ctrl+C first.');
    return;
  }

  const { width: iw, height: ih } = state.image;
  let x;
  let y;
  if (atPointer && pointer.over) {
    x = Math.round(pointer.x - clip.w / 2);
    y = Math.round(pointer.y - clip.h / 2);
  } else {
    // Step away from where it was copied, toward the side with more room.
    clip.pastes += 1;
    const step = Math.max(12, Math.round(24 / view.scale)) * clip.pastes;
    x = clip.x + (clip.x + clip.w / 2 < iw / 2 ? step : -step);
    y = clip.y + (clip.y + clip.h / 2 < ih / 2 ? step : -step);
  }
  x = clamp(x, 0, Math.max(0, iw - clip.w));
  y = clamp(y, 0, Math.max(0, ih - clip.h));

  const light = clip.light ?? (clip.kind !== 'signature' && state.matchLight);
  const piece = addPiece({ kind: clip.kind, src: clip.src, context: clip.context, x, y, w: clip.w, h: clip.h, light });
  showToast(light ? `Pasted. ${describeLight(piece)}` : 'Pasted. Drag it to exactly where you want it.');
}

function addPiece(fields) {
  pushUndo(snapshot());
  const piece = { id: nextPieceId++, ...fields };
  state.pieces.push(piece);
  state.activeId = piece.id;
  state.selection = null;
  state.showOriginal = false;
  setDirty(true);
  refreshUI();
  return piece;
}

// Puts a signature (a transparent canvas) on the picture at a sensible size:
// under the pointer if it's over the picture, otherwise in the middle of the view.
function placeSignature(src) {
  if (!state.image) {
    showToast('Open a picture first, then add your signature.');
    return;
  }
  const { width: iw, height: ih } = state.image;
  const vp = viewport();
  const visibleW = (vp.right - vp.left) / view.scale;
  let w = Math.min(src.width, iw * 0.35, visibleW * 0.35);
  let h = (w * src.height) / src.width;
  if (h > ih * 0.35) {
    h = ih * 0.35;
    w = (h * src.width) / src.height;
  }
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));

  const cx = pointer.over ? pointer.x : ((vp.left + vp.right) / 2 - view.ox) / view.scale;
  const cy = pointer.over ? pointer.y : ((vp.top + vp.bottom) / 2 - view.oy) / view.scale;
  const x = clamp(Math.round(cx - w / 2), 0, Math.max(0, iw - w));
  const y = clamp(Math.round(cy - h / 2), 0, Math.max(0, ih - h));

  addPiece({ kind: 'signature', src, x, y, w, h });
  showToast('Signature added. Drag it into place, and drag the corner square to resize.');
}

function removePiece(id) {
  if (!state.pieces.some((p) => p.id === id)) return;
  pushUndo(snapshot());
  state.pieces = state.pieces.filter((p) => p.id !== id);
  if (state.activeId === id) state.activeId = null;
  if (state.hoverId === id) state.hoverId = null;
  setDirty(true);
  refreshUI();
  showToast('Piece removed. The original is showing there again.');
}

function removeActivePiece() {
  const active = activePiece();
  if (!active || state.showOriginal) {
    showToast('Click a pasted piece first, then remove it.');
    return;
  }
  removePiece(active.id);
}

function nudgeActive(dx, dy) {
  const active = activePiece();
  if (!active || state.showOriginal) return;
  const now = performance.now();
  if (now - lastNudgeAt > 800) pushUndo(snapshot()); // one undo step per burst of key presses
  lastNudgeAt = now;
  active.x += dx;
  active.y += dy;
  setDirty(true);
  refreshUI();
}

function duplicateActive() {
  const active = activePiece();
  if (!active) return;
  const { kind, src, context, x, y, w, h, light } = active;
  state.clipboard = { kind, src, context, x, y, w, h, pastes: 0, light: Boolean(light) };
  pastePiece(false);
}

// The two fly-outs share the space next to the rail, so opening one closes the other.
function toggleShortcuts(open = shortcutsEl.hidden) {
  shortcutsEl.hidden = !open;
  shortcutsBtn.setAttribute('aria-expanded', String(open));
  if (open) setPiecesOpen(false);
}

function setPiecesOpen(open) {
  panel.hidden = !open;
  piecesBtn.setAttribute('aria-expanded', String(open));
  if (open) toggleShortcuts(false);
}

function selectAll() {
  if (!state.image) return;
  state.selection = { x: 0, y: 0, w: state.image.width, h: state.image.height };
  state.activeId = null;
  refreshUI();
}

function deselect() {
  state.selection = null;
  state.activeId = null;
  refreshUI();
}

function toggleOriginal() {
  if (!state.image || state.pieces.length === 0) return;
  state.showOriginal = !state.showOriginal;
  state.hoverId = null;
  refreshUI();
}

/* ------------------------------------------------------------------------ */
/* Files                                                                    */
/* ------------------------------------------------------------------------ */

function confirmDiscard() {
  return !state.dirty || window.confirm('Your edits haven’t been saved. Open a different picture anyway?');
}

async function decodeImage(blob) {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    return createImageBitmap(blob);
  }
}

async function loadImage(blob, name, filePath) {
  let bitmap;
  try {
    bitmap = await decodeImage(blob);
  } catch {
    showToast(`Couldn’t open “${name}”. Try a PNG, JPG, WebP, GIF or BMP picture.`, 'error');
    return;
  }
  if (!confirmDiscard()) {
    bitmap.close();
    return;
  }

  Object.assign(state, {
    image: bitmap,
    name,
    path: filePath || '',
    lastSavePath: '',
    pieces: [],
    activeId: null,
    hoverId: null,
    selection: null,
    showOriginal: false,
  });
  history.undo.length = 0;
  history.redo.length = 0;
  nextPieceId = 1;
  drag = null;
  sizeEl.textContent = `${bitmap.width} × ${bitmap.height} px`;
  setDirty(false);
  updateTitle();
  refreshUI(); // shows the panel first, so fitting knows how much room is left
  fitToView();
}

async function openImageDialog() {
  const file = await window.api.openImage();
  if (file) await loadImage(new Blob([file.data]), file.name, file.path);
}

function suggestedSavePath() {
  if (state.lastSavePath) return state.lastSavePath;
  const base = state.name.replace(/\.[^.]+$/, '') || 'picture';
  const folder = state.path ? state.path.slice(0, state.path.length - state.name.length) : '';
  return `${folder}${base}-edited.png`;
}

async function saveImage() {
  if (!state.image || drag) return;
  const filePath = await window.api.chooseSavePath(suggestedSavePath());
  if (!filePath) return;

  const ext = filePath.split('.').pop().toLowerCase();
  const type = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
  const { width, height } = state.image;
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const g = out.getContext('2d');
  g.imageSmoothingQuality = 'high';
  if (type === 'image/jpeg') {
    g.fillStyle = '#fff'; // JPEG has no transparency
    g.fillRect(0, 0, width, height);
  }
  drawComposite(g, 0, 0, true);

  try {
    const blob = await new Promise((resolve, reject) => {
      out.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), type, 0.95);
    });
    await window.api.writeFile(filePath, new Uint8Array(await blob.arrayBuffer()));
  } catch {
    showToast('Couldn’t save the picture there. Try a different folder or name.', 'error');
    return;
  }
  state.lastSavePath = filePath;
  setDirty(false);
  showToast(`Saved ${filePath.split(/[\\/]/).pop()}`);
}

/* ------------------------------------------------------------------------ */
/* Pointer input                                                            */
/* ------------------------------------------------------------------------ */

function pieceAt(x, y) {
  if (state.showOriginal) return null;
  for (let i = state.pieces.length - 1; i >= 0; i--) {
    const p = state.pieces[i];
    if (x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h) return p;
  }
  return null;
}

function eventPoint(e) {
  const r = overlay.getBoundingClientRect();
  const sx = e.clientX - r.left;
  const sy = e.clientY - r.top;
  return { sx, sy, x: (sx - view.ox) / view.scale, y: (sy - view.oy) / view.scale };
}

function updateCursorReadout(p) {
  const inside = state.image && p.x >= 0 && p.y >= 0 && p.x < state.image.width && p.y < state.image.height;
  cursorEl.textContent = inside ? `${Math.floor(p.x)}, ${Math.floor(p.y)}` : '';
}

overlay.addEventListener('pointerdown', (e) => {
  if (!state.image || drag) return;
  const p = eventPoint(e);

  if (e.button === 1 || e.button === 2 || (e.button === 0 && spaceHeld)) {
    e.preventDefault();
    drag = { kind: 'pan', sx: p.sx, sy: p.sy, ox: view.ox, oy: view.oy };
  } else if (e.button === 0) {
    const active = activePiece();
    const hit = e.ctrlKey ? null : pieceAt(p.x, p.y);
    if (active && !e.ctrlKey && !state.showOriginal && onResizeHandle(active, p.sx, p.sy)) {
      drag = { kind: 'resize', piece: active, startX: p.x, startY: p.y, fromW: active.w, fromH: active.h, before: snapshot(), moved: false };
    } else if (hit) {
      state.activeId = hit.id;
      state.selection = null;
      drag = { kind: 'move', piece: hit, startX: p.x, startY: p.y, fromX: hit.x, fromY: hit.y, before: snapshot(), moved: false };
    } else {
      const { width: iw, height: ih } = state.image;
      state.activeId = null;
      state.selection = null;
      drag = { kind: 'select', ax: clamp(Math.round(p.x), 0, iw), ay: clamp(Math.round(p.y), 0, ih) };
    }
  } else {
    return;
  }
  overlay.setPointerCapture(e.pointerId);
  refreshUI();
});

overlay.addEventListener('pointermove', (e) => {
  if (!state.image) return;
  const p = eventPoint(e);
  pointer.over = true;
  pointer.x = p.x;
  pointer.y = p.y;
  pointer.sx = p.sx;
  pointer.sy = p.sy;
  updateCursorReadout(p);

  if (!drag) {
    const hit = spaceHeld || e.ctrlKey ? null : pieceAt(p.x, p.y);
    const hoverId = hit ? hit.id : null;
    if (hoverId !== state.hoverId) {
      state.hoverId = hoverId;
      renderOverlay();
    }
    updateCursor();
    return;
  }

  if (drag.kind === 'pan') {
    view.ox = drag.ox + (p.sx - drag.sx);
    view.oy = drag.oy + (p.sy - drag.sy);
    view.fit = false;
    render();
  } else if (drag.kind === 'move') {
    const nx = drag.fromX + Math.round(p.x - drag.startX);
    const ny = drag.fromY + Math.round(p.y - drag.startY);
    if (nx !== drag.piece.x || ny !== drag.piece.y) {
      drag.piece.x = nx;
      drag.piece.y = ny;
      drag.moved = true;
      render();
    }
  } else if (drag.kind === 'resize') {
    // Follow the pointer along the piece's diagonal, so it grows without stretching.
    const { fromW, fromH } = drag;
    const t = ((p.x - drag.startX) * fromW + (p.y - drag.startY) * fromH) / (fromW * fromW + fromH * fromH);
    const k = Math.max(1 + t, Math.min(1, 8 / Math.min(fromW, fromH)));
    const w = Math.max(1, Math.round(fromW * k));
    const h = Math.max(1, Math.round(fromH * k));
    if (w !== drag.piece.w || h !== drag.piece.h) {
      drag.piece.w = w;
      drag.piece.h = h;
      drag.moved = true;
      render();
    }
  } else if (drag.kind === 'select') {
    const { width: iw, height: ih } = state.image;
    let bx = clamp(Math.round(p.x), 0, iw);
    let by = clamp(Math.round(p.y), 0, ih);
    if (e.shiftKey) {
      const size = Math.min(Math.abs(bx - drag.ax), Math.abs(by - drag.ay));
      bx = drag.ax + Math.sign(bx - drag.ax) * size;
      by = drag.ay + Math.sign(by - drag.ay) * size;
    }
    const w = Math.abs(bx - drag.ax);
    const h = Math.abs(by - drag.ay);
    state.selection = w > 0 && h > 0 ? { x: Math.min(bx, drag.ax), y: Math.min(by, drag.ay), w, h } : null;
    renderOverlay();
    updateHint();
  }
});

function endDrag() {
  if (!drag) return;
  const changed = (drag.kind === 'move' || drag.kind === 'resize') && drag.moved ? drag.piece : null;
  if (changed) {
    pushUndo(drag.before);
    setDirty(true);
  }
  drag = null;
  clearTimeout(lightRefreshTimer);
  refreshUI();
  if (changed?.light) showToast(describeLight(changed));
}

overlay.addEventListener('pointerup', endDrag);
overlay.addEventListener('pointercancel', endDrag);
overlay.addEventListener('lostpointercapture', endDrag);

overlay.addEventListener('pointerleave', () => {
  pointer.over = false;
  cursorEl.textContent = '';
  if (!drag && state.hoverId !== null) {
    state.hoverId = null;
    renderOverlay();
  }
});

overlay.addEventListener('mousedown', (e) => {
  if (e.button === 1) e.preventDefault(); // no auto-scroll on middle click
});
overlay.addEventListener('contextmenu', (e) => e.preventDefault());

overlay.addEventListener(
  'wheel',
  (e) => {
    if (!state.image) return;
    e.preventDefault();
    const p = eventPoint(e);
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    zoomBy(Math.exp(-dy * 0.0015), p.sx, p.sy);
  },
  { passive: false },
);

/* ------------------------------------------------------------------------ */
/* Buttons, sidebar, keyboard, drag-and-drop                                */
/* ------------------------------------------------------------------------ */

const actions = {
  open: openImageDialog,
  save: saveImage,
  copy: copySelection,
  paste: () => pastePiece(false),
  remove: removeActivePiece,
  duplicate: duplicateActive,
  sign: () => {
    if (!drag) Signatures.open();
  },
  done: deselect,
  undo,
  redo,
  original: toggleOriginal,
  'match-light': () => setMatchLight(!state.matchLight),
  'piece-light': toggleActiveLight,
  'piece-shadows': toggleActiveShadows,
  shortcuts: () => toggleShortcuts(),
  pieces: () => setPiecesOpen(panel.hidden),
  theme: () => {
    Theme.toggle();
    syncTheme();
    render();
  },
};

function syncTheme() {
  const label = Theme.current() === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  themeBtn.title = label;
  themeBtn.setAttribute('aria-label', label);
  // Windows draws the min/max/close buttons, so hand it the canvas colors.
  const css = getComputedStyle(document.documentElement);
  window.api.setTitleBarColors(css.getPropertyValue('--bg').trim(), css.getPropertyValue('--muted').trim());
}

document.addEventListener('click', (e) => {
  const button = e.target.closest('[data-action]');
  if (button && !button.disabled) actions[button.dataset.action]?.();
  if (!shortcutsEl.hidden && !e.target.closest('#shortcuts, #shortcuts-btn')) toggleShortcuts(false);
});

// Keep focus off toolbar buttons so Space and the arrow keys always reach the editor.
document.querySelectorAll('[data-action]').forEach((b) => b.addEventListener('mousedown', (e) => e.preventDefault()));

pieceList.addEventListener('click', (e) => {
  const remove = e.target.closest('[data-remove]');
  if (remove) {
    removePiece(Number(remove.dataset.remove));
    return;
  }
  const item = e.target.closest('.piece');
  if (!item) return;
  state.activeId = Number(item.dataset.id);
  state.selection = null;
  state.showOriginal = false;
  refreshUI();
});

pieceList.addEventListener('mouseover', (e) => {
  const item = e.target.closest('.piece');
  const id = item ? Number(item.dataset.id) : null;
  if (id !== state.hoverId) {
    state.hoverId = id;
    renderOverlay();
  }
});

pieceList.addEventListener('mouseleave', () => {
  state.hoverId = null;
  renderOverlay();
});

const ARROWS = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] };

window.addEventListener('keydown', (e) => {
  if (Signatures.isOpen()) return; // typing a name must not trigger editor shortcuts
  const mod = e.ctrlKey || e.metaKey;
  if (e.target === lightStrength && !mod && e.key !== 'Escape') return; // arrows move the slider, not the piece
  const key = e.key.toLowerCase();
  let handled = true;

  if (key === ' ') {
    if (!spaceHeld) {
      spaceHeld = true;
      updateCursor();
    }
  } else if (mod && key === 'o') openImageDialog();
  else if (mod && key === 's') saveImage();
  else if (!state.image) handled = false;
  else if (mod && key === 'c') copySelection();
  else if (mod && key === 'v') pastePiece(true);
  else if (mod && key === 'z' && !e.shiftKey) undo();
  else if (mod && (key === 'y' || key === 'z')) redo();
  else if (mod && key === 'a') selectAll();
  else if (mod && (key === '=' || key === '+')) zoomBy(1.25);
  else if (mod && key === '-') zoomBy(0.8);
  else if (mod && key === '0') fitToView();
  else if (mod && key === '1') zoomTo(1);
  else if (key === 'delete' || key === 'backspace') removeActivePiece();
  else if (key === 'escape' && !shortcutsEl.hidden) toggleShortcuts(false);
  else if (key === 'escape' && !panel.hidden && !state.selection && !activePiece()) setPiecesOpen(false);
  else if (key === 'escape') deselect();
  else if (key === '?') toggleShortcuts();
  else if (key === 'h' && !mod && !e.altKey) toggleOriginal();
  else if (key === 'l' && !mod && !e.altKey && !drag) toggleActiveLight();
  else if (ARROWS[key] && activePiece()) {
    const step = e.shiftKey ? 10 : 1;
    nudgeActive(ARROWS[key][0] * step, ARROWS[key][1] * step);
  } else handled = false;

  if (handled) e.preventDefault();
});

window.addEventListener('keyup', (e) => {
  if (e.key === ' ') {
    spaceHeld = false;
    updateCursor();
    e.preventDefault();
  }
});

window.addEventListener('blur', () => {
  spaceHeld = false;
  updateCursor();
});

const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

for (const type of ['dragenter', 'dragover']) {
  window.addEventListener(type, (e) => {
    e.preventDefault();
    if (hasFiles(e) && !Signatures.isOpen()) document.body.classList.add('dropping');
  });
}

window.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) document.body.classList.remove('dropping');
});

window.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dropping');
  if (Signatures.isOpen()) return;
  const file = [...(e.dataTransfer?.files || [])].find(
    (f) => f.type.startsWith('image/') || /\.(png|jpe?g|jfif|webp|gif|bmp|avif)$/i.test(f.name),
  );
  if (!file) {
    showToast('That doesn’t look like a picture.', 'error');
    return;
  }
  loadImage(file, file.name, window.api.pathForFile(file));
});

/* ------------------------------------------------------------------------ */
/* Start                                                                    */
/* ------------------------------------------------------------------------ */

Signatures.init({
  hasImage: () => Boolean(state.image),
  place: placeSignature,
  toast: showToast,
});
syncTheme();
try {
  state.matchLight = localStorage.getItem('match-light') === '1';
} catch {
  // Start with Match light off.
}
refreshUI();
window.api.startupImage().then((file) => {
  if (file) loadImage(new Blob([file.data]), file.name, file.path);
});
