'use strict';

const { app, BrowserWindow, dialog, ipcMain, Menu, screen } = require('electron');
const fs = require('fs/promises');
const path = require('path');

const OPEN_EXTENSIONS = ['png', 'jpg', 'jpeg', 'jfif', 'webp', 'gif', 'bmp', 'avif'];
const SAVE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'];
const MAX_SIGNATURES = 50;
const MAX_SIGNATURE_CHARS = 8 * 1024 * 1024;

let mainWindow = null;
let hasUnsavedChanges = false;
// Only paths the user picked in the save dialog may be written to.
const approvedSavePaths = new Set();

function extensionOf(filePath) {
  return path.extname(filePath).slice(1).toLowerCase();
}

// Supports "Open with → Photo Patch" and dropping a picture on the .exe.
function startupImagePath() {
  const args = process.argv.slice(app.isPackaged ? 1 : 2);
  return args.find((arg) => OPEN_EXTENSIONS.includes(extensionOf(arg))) || null;
}

async function readImageFile(filePath) {
  const data = await fs.readFile(filePath);
  return { name: path.basename(filePath), path: filePath, data };
}

// Saved signatures live next to the app's other data, so they survive restarts and updates.
const signaturesFile = () => path.join(app.getPath('userData'), 'signatures.json');

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

function createWindow() {
  const { width: areaW, height: areaH } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: Math.min(1320, areaW - 40),
    height: Math.min(880, areaH - 40),
    minWidth: 760,
    minHeight: 520,
    title: 'Photo Patch',
    backgroundColor: '#16171a',
    show: false,
    icon: app.isPackaged ? undefined : path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Dropping a file on the window must never navigate away from the editor.
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  mainWindow.on('close', (event) => {
    if (!hasUnsavedChanges) return;
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Close without saving', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Unsaved changes',
      message: 'Your edited picture hasn’t been saved.',
      detail: 'If you close now, the pieces you pasted will be lost.',
    });
    if (choice === 1) event.preventDefault();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

ipcMain.handle('open-image', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Open a picture',
    properties: ['openFile'],
    filters: [
      { name: 'Pictures', extensions: OPEN_EXTENSIONS },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (canceled || filePaths.length === 0) return null;
  return readImageFile(filePaths[0]);
});

ipcMain.handle('startup-image', async () => {
  const filePath = startupImagePath();
  if (!filePath) return null;
  return readImageFile(filePath).catch(() => null);
});

ipcMain.handle('choose-save-path', async (_event, suggestedPath) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Save edited picture',
    defaultPath: suggestedPath || 'edited.png',
    filters: [
      { name: 'PNG picture (best quality)', extensions: ['png'] },
      { name: 'JPEG picture (smaller file)', extensions: ['jpg', 'jpeg'] },
      { name: 'WebP picture', extensions: ['webp'] },
    ],
  });
  if (canceled || !filePath) return null;
  const finalPath = SAVE_EXTENSIONS.includes(extensionOf(filePath)) ? filePath : `${filePath}.png`;
  approvedSavePaths.add(finalPath);
  return finalPath;
});

ipcMain.handle('write-file', async (_event, filePath, bytes) => {
  if (!approvedSavePaths.has(filePath)) throw new Error('That location was not chosen in the save dialog.');
  await fs.writeFile(filePath, Buffer.from(bytes));
});

ipcMain.handle('load-signatures', async () => {
  try {
    const list = JSON.parse(await fs.readFile(signaturesFile(), 'utf8'));
    return Array.isArray(list) ? list.filter(isSignature).slice(0, MAX_SIGNATURES) : [];
  } catch {
    return [];
  }
});

ipcMain.handle('save-signatures', async (_event, list) => {
  if (!Array.isArray(list) || list.length > MAX_SIGNATURES || !list.every(isSignature)) {
    throw new Error('Invalid signature list.');
  }
  const clean = list.map(({ id, dataUrl, createdAt }) => ({ id, dataUrl, createdAt }));
  const file = signaturesFile();
  const temp = `${file}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Write then swap, so a crash mid-write can't wipe the saved signatures.
  await fs.writeFile(temp, JSON.stringify(clean));
  await fs.rename(temp, file);
});

ipcMain.on('set-dirty', (_event, value) => {
  hasUnsavedChanges = Boolean(value);
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
});

app.on('window-all-closed', () => app.quit());
