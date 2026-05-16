import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { exec } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import type { AppSettings, Gallery, SaveImageRequest, SaveImageResult, SavedPhoto } from './types';

let guestWindow: BrowserWindow | null = null;
let adminWindow: BrowserWindow | null = null;
let lastFinalPath = '';

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);

const defaultEventFolder = () => path.join(app.getPath('pictures'), 'Aviebelle Photo Booth');
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

const defaultSettings = (): AppSettings => ({
  eventName: 'AVIEBELLE PHOTO BOOTH',
  eventFolder: defaultEventFolder(),
  cameraId: '',
  mirrorPreview: true,
  defaultPrinter: '',
  adminPassword: '',
  template: {
    eventName: 'AVIEBELLE PHOTO BOOTH',
    logoPath: '',
    framePath: ''
  },
  workflow: {
    introMessage: "Let's take 4 pictures!",
    introMs: 2000,
    shots: [
      { message: 'Get Ready!', cameraBeforeMessageMs: 3000, messageMs: 2000, cameraBeforeCountdownMs: 3000 },
      { message: 'Smile!', cameraBeforeMessageMs: 3000, messageMs: 2000, cameraBeforeCountdownMs: 3000 },
      { message: 'Switch It Up!', cameraBeforeMessageMs: 3000, messageMs: 2000, cameraBeforeCountdownMs: 3000 },
      { message: 'Final Pose!', cameraBeforeMessageMs: 3000, messageMs: 2000, cameraBeforeCountdownMs: 3000 }
    ]
  },
  printPicker: {
    showSingle: true,
    showGrid: true,
    showAi: true,
    showFuture: true
  },
  printCalibration: {
    offsetXIn: -0.04,
    offsetYIn: -0.08,
    bleedXIn: 0.08,
    bleedYIn: 0.14
  }
});

async function ensureEventFolders(eventFolder: string) {
  await fs.mkdir(path.join(eventFolder, 'originals'), { recursive: true });
  await fs.mkdir(path.join(eventFolder, 'finals'), { recursive: true });
}

async function readSettings(): Promise<AppSettings> {
  const fallback = defaultSettings();
  try {
    const raw = await fs.readFile(settingsPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    const merged: AppSettings = {
      ...fallback,
      ...parsed,
      template: {
        ...fallback.template,
        ...(parsed.template ?? {})
      },
      workflow: {
        ...fallback.workflow,
        ...(parsed.workflow ?? {}),
        shots: fallback.workflow.shots.map((shot, index) => ({
          ...shot,
          ...(parsed.workflow?.shots?.[index] ?? {})
        }))
      },
      printPicker: {
        ...fallback.printPicker,
        ...(parsed.printPicker ?? {})
      },
      printCalibration: {
        ...fallback.printCalibration,
        ...(parsed.printCalibration ?? {})
      }
    };
    await ensureEventFolders(merged.eventFolder);
    return merged;
  } catch {
    await writeSettings(fallback);
    return fallback;
  }
}

async function writeSettings(settings: AppSettings): Promise<AppSettings> {
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await ensureEventFolders(settings.eventFolder);
  await fs.writeFile(settingsPath(), `${JSON.stringify(settings, null, 2)}${os.EOL}`, 'utf8');
  return settings;
}

async function createWindow(kind: 'guest' | 'admin') {
  const win = new BrowserWindow({
    width: kind === 'guest' ? 1280 : 1120,
    height: kind === 'guest' ? 800 : 760,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    title: kind === 'guest' ? 'Aviebelle Photo Booth' : 'Aviebelle Admin',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const target = isDev
    ? `${process.env.VITE_DEV_SERVER_URL}?window=${kind}`
    : `file://${path.join(__dirname, '..', 'dist', 'index.html')}?window=${kind}`;

  await win.loadURL(target);
  if (kind === 'guest') guestWindow = win;
  if (kind === 'admin') adminWindow = win;
  if (kind === 'guest') {
    win.on('enter-full-screen', notifyGuestFullscreen);
    win.on('leave-full-screen', notifyGuestFullscreen);
  }
  win.on('closed', () => {
    if (kind === 'guest') guestWindow = null;
    if (kind === 'admin') {
      adminWindow = null;
      guestWindow?.close();
      if (process.platform !== 'darwin') app.quit();
    }
  });
}

function setGuestFullscreen(fullscreen: boolean) {
  if (!guestWindow) return false;
  guestWindow.setKiosk(false);
  guestWindow.setFullScreen(fullscreen);
  guestWindow.webContents.send('guest:fullscreen-changed', fullscreen);
  if (fullscreen) guestWindow.focus();
  return true;
}

function isGuestFullscreen() {
  return Boolean(guestWindow?.isFullScreen());
}

function notifyGuestFullscreen() {
  if (!guestWindow) return;
  guestWindow.webContents.send('guest:fullscreen-changed', guestWindow.isFullScreen());
}

async function listGallery(): Promise<Gallery> {
  const settings = await readSettings();
  await ensureEventFolders(settings.eventFolder);

  const readDir = async (folder: string, type: SavedPhoto['type']): Promise<SavedPhoto[]> => {
    const dir = path.join(settings.eventFolder, folder);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const photos = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && /\.(png|jpe?g)$/i.test(entry.name))
        .map(async (entry) => {
          const filePath = path.join(dir, entry.name);
          const stat = await fs.stat(filePath);
          return {
            name: entry.name,
            path: filePath,
            type,
            createdAt: stat.birthtime.toISOString()
          };
        })
    );
    return photos.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  };

  return {
    originals: await readDir('originals', 'original'),
    finals: await readDir('finals', 'final')
  };
}

function dataUrlToBuffer(dataUrl: string): Buffer {
  const base64 = dataUrl.split(',')[1];
  if (!base64) throw new Error('Invalid image data.');
  return Buffer.from(base64, 'base64');
}

async function imageFileToDataUrl(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  const extension = path.extname(filePath).toLowerCase();
  const mimeType = extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : 'image/png';
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

function photoName(prefix = 'photo') {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${prefix}-${timestamp}.png`;
}

async function printImage(imagePath: string, printerName?: string) {
  if (!imagePath) return { ok: false, error: 'No image selected for printing.' };
  const settings = await readSettings();
  const calibration = settings.printCalibration;
  const imageUrl = pathToFileURL(imagePath).toString();
  const printHtmlPath = path.join(app.getPath('temp'), `aviebelle-print-${Date.now()}.html`);
  const printWindow = new BrowserWindow({
    width: 1239,
    height: 1845,
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });

  const html = `
    <!doctype html>
    <html>
      <head>
        <style>
          @page { size: 4.13in 6.15in; margin: 0; }
          * { box-sizing: border-box; }
          html, body {
            margin: 0;
            padding: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
            background: #fff;
          }
          body {
            position: fixed;
            inset: 0;
          }
          img {
            position: fixed;
            left: ${calibration.offsetXIn}in;
            top: ${calibration.offsetYIn}in;
            width: calc(100% + ${calibration.bleedXIn}in);
            height: calc(100% + ${calibration.bleedYIn}in);
            object-fit: cover;
            display: block;
            margin: 0;
            padding: 0;
          }
        </style>
      </head>
      <body>
        <img id="print-image" src="${imageUrl}" />
        <script>
          const image = document.getElementById('print-image');
          if (image.complete) {
            document.title = 'ready';
          } else {
            image.onload = () => { document.title = 'ready'; };
            image.onerror = () => { document.title = 'error'; };
          }
        </script>
      </body>
    </html>`;

  await fs.writeFile(printHtmlPath, html, 'utf8');
  await printWindow.loadFile(printHtmlPath);
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 3000);
    printWindow.webContents.on('page-title-updated', (_event, title) => {
      if (title === 'ready' || title === 'error') {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  return new Promise<{ ok: boolean; error?: string }>((resolve) => {
    printWindow.webContents.print(
      {
        silent: false,
        deviceName: printerName || undefined,
        printBackground: true,
        pageSize: { width: 104902, height: 156210 },
        margins: { marginType: 'none' },
        scaleFactor: 100
      },
      (success, failureReason) => {
        printWindow.close();
        void fs.rm(printHtmlPath, { force: true });
        resolve(success ? { ok: true } : { ok: false, error: failureReason || 'Print canceled.' });
      }
    );
  });
}

function modalParent() {
  return adminWindow ?? guestWindow;
}

app.whenReady().then(async () => {
  await readSettings();
  await createWindow('admin');

  ipcMain.handle('settings:get', readSettings);
  ipcMain.handle('settings:update', async (_event, partial: Partial<AppSettings>) => {
    const current = await readSettings();
    const next: AppSettings = {
      ...current,
      ...partial,
      template: {
        ...current.template,
        ...(partial.template ?? {})
      },
      workflow: {
        ...current.workflow,
        ...(partial.workflow ?? {}),
        shots: partial.workflow?.shots ?? current.workflow.shots
      },
      printPicker: {
        ...current.printPicker,
        ...(partial.printPicker ?? {})
      },
      printCalibration: {
        ...current.printCalibration,
        ...(partial.printCalibration ?? {})
      }
    };
    return writeSettings(next);
  });
  ipcMain.handle('dialog:choose-folder', async () => {
    const parent = modalParent();
    const options = { properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> };
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    return result.canceled ? '' : result.filePaths[0];
  });
  ipcMain.handle('dialog:choose-image', async () => {
    const parent = modalParent();
    const options = {
      properties: ['openFile'] as Array<'openFile'>,
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
    };
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    return result.canceled ? '' : result.filePaths[0];
  });
  ipcMain.handle('window:open-admin', async () => {
    if (adminWindow) {
      adminWindow.focus();
      return true;
    }
    await createWindow('admin');
    return true;
  });
  ipcMain.handle('window:open-guest', async () => {
    if (guestWindow) {
      guestWindow.show();
      guestWindow.focus();
      return true;
    }
    await createWindow('guest');
    return true;
  });
  ipcMain.handle('guest:set-fullscreen', (_event, fullscreen: boolean) => setGuestFullscreen(fullscreen));
  ipcMain.handle('guest:is-fullscreen', () => isGuestFullscreen());
  ipcMain.handle('printers:list', async () => {
    const win = adminWindow ?? guestWindow;
    return win ? win.webContents.getPrintersAsync() : [];
  });
  ipcMain.handle('image:save', async (_event, request: SaveImageRequest): Promise<SaveImageResult> => {
    const settings = await readSettings();
    await ensureEventFolders(settings.eventFolder);
    const folder = request.kind === 'original' ? 'originals' : 'finals';
    const name = photoName(request.filenamePrefix ?? request.kind);
    const filePath = path.join(settings.eventFolder, folder, name);
    await fs.writeFile(filePath, dataUrlToBuffer(request.dataUrl));
    if (request.kind === 'final') lastFinalPath = filePath;
    return { path: filePath, name };
  });
  ipcMain.handle('image:data-url', async (_event, filePath: string) => imageFileToDataUrl(filePath));
  ipcMain.handle('gallery:list', listGallery);
  ipcMain.handle('file:open', async (_event, filePath: string) => {
    if (!filePath) return false;
    await shell.openPath(filePath);
    return true;
  });
  ipcMain.handle('file:export', async (_event, filePath: string) => {
    const parent = modalParent();
    const options = { defaultPath: path.basename(filePath) };
    const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return '';
    await fs.copyFile(filePath, result.filePath);
    return result.filePath;
  });
  ipcMain.handle('file:delete', async (_event, filePath: string) => {
    await fs.unlink(filePath);
    return true;
  });
  ipcMain.handle('print:image', async (_event, imagePath?: string) => {
    const settings = await readSettings();
    return printImage(imagePath || lastFinalPath, settings.defaultPrinter);
  });
  ipcMain.handle('printer:settings', async () => {
    if (process.platform === 'win32') {
      exec('rundll32 printui.dll,PrintUIEntry /s');
      return true;
    }
    return false;
  });

  app.on('activate', () => {
    if (!adminWindow) void createWindow('admin');
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !adminWindow) app.quit();
});
