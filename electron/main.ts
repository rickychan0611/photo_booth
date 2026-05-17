import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { exec } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import type { AppSettings, Gallery, SaveImageRequest, SaveImageResult, SavedPhoto, TemplateAssetRole, TemplateDesign, TemplateStyleId, TemplateUploadRequest } from './types';

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
  cameraRotation: 0,
  cameraControls: {},
  defaultPrinter: '',
  stylePrinters: {
    style1: 'DS-RX1',
    style2: 'DS-RX1',
    style3: 'DS-RX1',
    style4: 'DS-RX1-HaflCut'
  },
  silentPrint: false,
  adminPassword: '',
  template: {
    eventName: 'AVIEBELLE PHOTO BOOTH',
    logoPath: '',
    framePath: '',
    styleVersion: 2,
    selectedStyleId: 'style1',
    selectedDesignId: '',
    aiPresets: [],
    designs: []
  },
  workflow: {
    introMessage: "Let's take 4 pictures!",
    introMs: 2000,
    printAutoSelectMs: 20000,
    thankYouMessage: 'THANK YOU!',
    thankYouMs: 3000,
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
  await fs.mkdir(path.join(eventFolder, 'originals', 'thumbs'), { recursive: true });
  await fs.mkdir(path.join(eventFolder, 'finals', 'thumbs'), { recursive: true });
  await fs.mkdir(path.join(eventFolder, 'templates'), { recursive: true });
  for (const styleId of ['style1', 'style2', 'style3', 'style4']) {
    await fs.mkdir(path.join(eventFolder, 'templates', styleId), { recursive: true });
  }
}

async function moveFolderIfPossible(source: string, target: string) {
  if (!(await fileExists(source)) || (await fileExists(target))) return;
  try {
    await fs.rename(source, target);
  } catch {
    await fs.cp(source, target, { recursive: true, force: false });
  }
}

async function migrateLegacyTemplateFolders(eventFolder: string) {
  const templatesFolder = path.join(eventFolder, 'templates');
  await moveFolderIfPossible(path.join(templatesFolder, 'style4'), path.join(templatesFolder, 'style3'));
  await moveFolderIfPossible(path.join(templatesFolder, 'style5'), path.join(templatesFolder, 'style4'));
}

async function readSettings(): Promise<AppSettings> {
  const fallback = defaultSettings();
  try {
    const raw = await fs.readFile(settingsPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    const isLegacyTemplateStyle = parsed.template?.styleVersion !== 2;
    const merged: AppSettings = {
      ...fallback,
      ...parsed,
      template: {
        ...fallback.template,
        ...(parsed.template ?? {}),
        styleVersion: 2,
        selectedStyleId: normalizeTemplateStyleId(String(parsed.template?.selectedStyleId ?? fallback.template.selectedStyleId), isLegacyTemplateStyle),
        aiPresets: parsed.template?.aiPresets ?? fallback.template.aiPresets,
        designs: (parsed.template?.designs ?? fallback.template.designs).map((design) =>
          normalizeTemplateDesign(design, isLegacyTemplateStyle)
        )
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
      cameraControls: {
        ...fallback.cameraControls,
        ...(parsed.cameraControls ?? {})
      },
      stylePrinters: {
        ...fallback.stylePrinters,
        ...(parsed.stylePrinters ?? {})
      },
      printCalibration: {
        ...fallback.printCalibration,
        ...(parsed.printCalibration ?? {})
      }
    };
    if (isLegacyTemplateStyle) await migrateLegacyTemplateFolders(merged.eventFolder);
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

function windowUrl(kind: 'guest' | 'admin', extraQuery = '') {
  const query = `window=${kind}${extraQuery ? `&${extraQuery}` : ''}`;
  return isDev
    ? `${process.env.VITE_DEV_SERVER_URL}?${query}`
    : `file://${path.join(__dirname, '..', 'dist', 'index.html')}?${query}`;
}

async function createWindow(kind: 'guest' | 'admin', extraQuery = '') {
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

  await win.loadURL(windowUrl(kind, extraQuery));
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
          const thumbPath = path.join(dir, 'thumbs', entry.name);
          const stat = await fs.stat(filePath);
          const hasThumb = await fileExists(thumbPath);
          return {
            name: entry.name,
            path: filePath,
            thumbPath: hasThumb ? thumbPath : undefined,
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

async function fileExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function imageFileToDataUrl(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  const extension = path.extname(filePath).toLowerCase();
  const mimeType = extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : 'image/png';
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

async function getImageSize(filePath: string) {
  const image = nativeImage.createFromPath(filePath);
  if (image.isEmpty()) throw new Error('Image cannot be read.');
  return image.getSize();
}

const safeTemplateName = (value: string) =>
  value
    .trim()
    .replace(/[^a-z0-9-_ ]/gi, '')
    .replace(/\s+/g, '-')
    .toLowerCase() || 'template';

const migrateLegacyStyleId = (styleId: string): TemplateStyleId => {
  if (styleId === 'style5') return 'style4';
  if (styleId === 'style4') return 'style3';
  if (styleId === 'style3') return 'style3';
  if (styleId === 'style2') return 'style2';
  return 'style1';
};

const normalizeTemplateStyleId = (styleId: string, migrateLegacy: boolean): TemplateStyleId => {
  if (migrateLegacy) return migrateLegacyStyleId(styleId);
  if (styleId === 'style4') return 'style4';
  if (styleId === 'style3') return 'style3';
  if (styleId === 'style2') return 'style2';
  return 'style1';
};

const migrateLegacyTemplatePath = (filePath: string, originalStyleId: string) => {
  if (!filePath) return filePath;
  if (originalStyleId === 'style5') return filePath.replace(/([\\/])templates\1style5\1/i, '$1templates$1style4$1');
  if (originalStyleId === 'style4') return filePath.replace(/([\\/])templates\1style4\1/i, '$1templates$1style3$1');
  return filePath;
};

const normalizeTemplateDesign = (design: TemplateDesign, migrateLegacy = false): TemplateDesign => {
  const originalStyleId = String(design.styleId);
  const styleId = normalizeTemplateStyleId(originalStyleId, migrateLegacy);
  const legacyPath = design.filePath ?? '';
  const previewPath = design.previewPath || legacyPath;
  const framePath = design.framePath || legacyPath;
  return {
    ...design,
    styleId,
    previewPath: migrateLegacy ? migrateLegacyTemplatePath(previewPath, originalStyleId) : previewPath,
    framePath: migrateLegacy ? migrateLegacyTemplatePath(framePath, originalStyleId) : framePath
  };
};

const chooseTemplateAsset = async (role: TemplateAssetRole) => {
  const parent = modalParent();
  const options = {
    properties: ['openFile'] as Array<'openFile'>,
    filters: [
      role === 'frame'
        ? { name: 'Transparent PNG Frame', extensions: ['png'] }
        : { name: 'Preview Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }
    ]
  };
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  return result.canceled ? '' : result.filePaths[0] ?? '';
};

const copyTemplateAsset = async (sourcePath: string, designFolder: string, role: TemplateAssetRole) => {
  if (role === 'frame') {
    const size = await getImageSize(sourcePath);
    if (size.width !== 2478 || size.height !== 3690) {
      throw new Error(`Print frame must be 2478 x 3690. This file is ${size.width} x ${size.height}.`);
    }
  }
  const extension = role === 'frame' ? '.png' : path.extname(sourcePath).toLowerCase() || '.png';
  const targetPath = path.join(designFolder, `${role}${extension}`);
  await fs.copyFile(sourcePath, targetPath);
  return targetPath;
};

async function uploadTemplate(request: TemplateUploadRequest): Promise<TemplateDesign | null> {
  const frameSourcePath = await chooseTemplateAsset('frame');
  if (!frameSourcePath) return null;

  const settings = await readSettings();
  await ensureEventFolders(settings.eventFolder);
  const now = new Date().toISOString();
  const id = `${request.styleId}-${Date.now()}`;
  const name = request.name?.trim() || path.parse(frameSourcePath).name || 'Template';
  const designFolder = path.join(settings.eventFolder, 'templates', request.styleId, `${id}-${safeTemplateName(name)}`);
  await fs.mkdir(designFolder, { recursive: true });
  const framePath = await copyTemplateAsset(frameSourcePath, designFolder, 'frame');

  const design: TemplateDesign = {
    id,
    styleId: request.styleId,
    name,
    previewPath: framePath,
    framePath,
    active: true,
    usesAi: false,
    aiPresetId: '',
    createdAt: now,
    updatedAt: now
  };
  await writeSettings({
    ...settings,
    template: {
      ...settings.template,
      selectedStyleId: request.styleId,
      selectedDesignId: design.id,
      designs: [...settings.template.designs.map((item) => normalizeTemplateDesign(item)), design]
    }
  });
  return design;
}

async function updateTemplate(design: TemplateDesign) {
  const settings = await readSettings();
  const updated = normalizeTemplateDesign({ ...design, updatedAt: new Date().toISOString() });
  await writeSettings({
    ...settings,
    template: {
      ...settings.template,
      designs: settings.template.designs.map((item) => normalizeTemplateDesign(item)).map((item) => (item.id === design.id ? updated : item))
    }
  });
  return updated;
}

async function updateTemplateAsset(designId: string, role: TemplateAssetRole) {
  const settings = await readSettings();
  const designs = settings.template.designs.map((item) => normalizeTemplateDesign(item));
  const design = designs.find((item) => item.id === designId);
  if (!design) return null;
  const sourcePath = await chooseTemplateAsset(role);
  if (!sourcePath) return null;
  const designFolder = path.dirname(design.framePath || design.previewPath);
  await fs.mkdir(designFolder, { recursive: true });
  const assetPath = await copyTemplateAsset(sourcePath, designFolder, role);
  const updated = normalizeTemplateDesign({
    ...design,
    previewPath: role === 'preview' ? assetPath : design.previewPath || assetPath,
    framePath: role === 'frame' ? assetPath : design.framePath,
    updatedAt: new Date().toISOString()
  });
  await writeSettings({
    ...settings,
    template: {
      ...settings.template,
      designs: designs.map((item) => (item.id === designId ? updated : item))
    }
  });
  return updated;
}

async function deleteTemplate(designId: string) {
  const settings = await readSettings();
  const designs = settings.template.designs.map((item) => normalizeTemplateDesign(item));
  const design = designs.find((item) => item.id === designId);
  if (design) await fs.rm(path.dirname(design.framePath || design.previewPath), { force: true, recursive: true });
  await writeSettings({
    ...settings,
    template: {
      ...settings.template,
      selectedDesignId: settings.template.selectedDesignId === designId ? '' : settings.template.selectedDesignId,
      designs: designs.filter((item) => item.id !== designId)
    }
  });
  return true;
}

async function saveGuideTemplate(styleId: TemplateStyleId, dataUrl: string) {
  const settings = await readSettings();
  await ensureEventFolders(settings.eventFolder);
  const filePath = path.join(settings.eventFolder, 'templates', `${styleId}-blank-guide.png`);
  await fs.writeFile(filePath, dataUrlToBuffer(dataUrl));
  await shell.showItemInFolder(filePath);
  return filePath;
}

async function writeThumbnail(sourceBuffer: Buffer, eventFolder: string, folder: 'originals' | 'finals', name: string) {
  const image = nativeImage.createFromBuffer(sourceBuffer);
  if (image.isEmpty()) return;
  const size = image.getSize();
  const maxHeight = 360;
  const maxWidth = 360;
  const scale = Math.min(maxWidth / size.width, maxHeight / size.height, 1);
  const thumbnail = image.resize({
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
    quality: 'good'
  });
  await fs.writeFile(path.join(eventFolder, folder, 'thumbs', name), thumbnail.toPNG());
}

async function photoName(eventFolder: string) {
  const readNumericNames = async (folder: string) => {
    try {
      const entries = await fs.readdir(path.join(eventFolder, folder), { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && /^\d+\.png$/i.test(entry.name))
        .map((entry) => Number.parseInt(path.parse(entry.name).name, 10))
        .filter((value) => Number.isFinite(value));
    } catch {
      return [];
    }
  };
  const numbers = [...(await readNumericNames('originals')), ...(await readNumericNames('finals'))];
  const nextNumber = numbers.length > 0 ? Math.max(...numbers) + 1 : 1;
  return `${nextNumber}.png`;
}

async function printImage(imagePath: string, printerName?: string, silent = false) {
  if (!imagePath) return { ok: false, error: 'No image selected for printing.' };
  const settings = await readSettings();
  const calibration = settings.printCalibration;
  const imageUrl = pathToFileURL(imagePath).toString();
  const printHtmlPath = path.join(app.getPath('temp'), `aviebelle-print-${Date.now()}.html`);
  const printWindow = new BrowserWindow({
    width: silent ? 2478 : 520,
    height: silent ? 3690 : 720,
    show: false,
    autoHideMenuBar: true,
    title: 'Print Photo',
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
  if (!silent) {
    printWindow.setAlwaysOnTop(true, 'screen-saver');
    printWindow.show();
    printWindow.focus();
  }
  return new Promise<{ ok: boolean; error?: string }>((resolve) => {
    printWindow.webContents.print(
      {
        silent,
        deviceName: printerName || undefined,
        printBackground: true,
        pageSize: { width: 104902, height: 156210 },
        margins: { marginType: 'none' },
        scaleFactor: 100
      },
      (success, failureReason) => {
        printWindow.setAlwaysOnTop(false);
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
      cameraControls: {
        ...current.cameraControls,
        ...(partial.cameraControls ?? {})
      },
      stylePrinters: {
        ...current.stylePrinters,
        ...(partial.stylePrinters ?? {})
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
  ipcMain.handle('template:upload', async (_event, request: TemplateUploadRequest) => uploadTemplate(request));
  ipcMain.handle('template:update', async (_event, design: TemplateDesign) => updateTemplate(design));
  ipcMain.handle('template:update-asset', async (_event, designId: string, role: TemplateAssetRole) => updateTemplateAsset(designId, role));
  ipcMain.handle('template:delete', async (_event, designId: string) => deleteTemplate(designId));
  ipcMain.handle('template:save-guide', async (_event, styleId: TemplateStyleId, dataUrl: string) => saveGuideTemplate(styleId, dataUrl));
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
  ipcMain.handle('window:open-guest-picker-preview', async () => {
    if (guestWindow) {
      guestWindow.show();
      guestWindow.focus();
      guestWindow.webContents.send('guest:open-picker-preview');
      return true;
    }
    await createWindow('guest', 'preview=picker');
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
    const name = await photoName(settings.eventFolder);
    const filePath = path.join(settings.eventFolder, folder, name);
    const buffer = dataUrlToBuffer(request.dataUrl);
    await fs.writeFile(filePath, buffer);
    await writeThumbnail(buffer, settings.eventFolder, folder, name);
    if (request.kind === 'final') lastFinalPath = filePath;
    return { path: filePath, name };
  });
  ipcMain.handle('image:data-url', async (_event, filePath: string) => imageFileToDataUrl(filePath));
  ipcMain.handle('image:size', async (_event, filePath: string) => getImageSize(filePath));
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
    const thumbPath = path.join(path.dirname(filePath), 'thumbs', path.basename(filePath));
    await fs.rm(thumbPath, { force: true });
    return true;
  });
  ipcMain.handle('print:image', async (_event, imagePath?: string, printerName?: string) => {
    const settings = await readSettings();
    return printImage(imagePath || lastFinalPath, printerName || settings.defaultPrinter, settings.silentPrint);
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
