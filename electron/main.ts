import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { exec } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import type {
  AiGenerateRequest,
  AiGenerateResult,
  AiPreset,
  AiProvider,
  AiQueueItem,
  AppSettings,
  FaceAsset,
  FaceAssetPack,
  FaceAssetPlacement,
  Gallery,
  SaveImageRequest,
  SaveImageResult,
  SavedPhoto,
  TemplateAssetRole,
  TemplateDesign,
  TemplateStyleId,
  TemplateUploadRequest
} from './types';

let guestWindow: BrowserWindow | null = null;
let adminWindow: BrowserWindow | null = null;
let facePreviewWindow: BrowserWindow | null = null;
let lastFinalPath = '';

const PRINT_PREVIEW_WIDTH = 1239;
const PRINT_PREVIEW_HEIGHT = 1845;
const STYLE4_HALFCUT_PRINTER = 'DS-RX1-HalfCut';
const PRINTER_ALIASES = new Map<string, string>([['DS-RX1-HaflCut', STYLE4_HALFCUT_PRINTER]]);

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);

const defaultEventFolder = () => path.join(app.getPath('pictures'), 'Photo Booth');
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

const defaultAiSettings = (): AppSettings['ai'] => ({
  provider: 'openai',
  systemPrompt: 'Create a polished photo booth AI edit. Keep the guest recognizable and preserve a clean print-ready composition.',
  thinkingLevel: 'low',
  providers: {
    openai: {
      enabled: true,
      apiKey: '',
      apiUrl: 'https://api.openai.com/v1/images/edits',
      model: 'gpt-image-2',
      size: '1024x1536',
      quality: 'low'
    },
    gemini: {
      enabled: false,
      apiKey: '',
      apiUrl: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
      model: 'gemini-3.1-flash-image-preview'
    },
    xai: {
      enabled: false,
      apiKey: '',
      apiUrl: 'https://api.x.ai/v1/images/edits',
      model: 'grok-imagine-image-quality'
    }
  }
});

const defaultSettings = (): AppSettings => ({
  eventName: 'PHOTO BOOTH',
  eventFolder: defaultEventFolder(),
  cameraId: '',
  mirrorPreview: true,
  cameraRotation: 0,
  cameraPreviewOverlay: 'none',
  cameraControls: {},
  defaultPrinter: '',
  stylePrinters: {
    style1: 'DS-RX1',
    style2: 'DS-RX1',
    style3: 'DS-RX1',
    style4: STYLE4_HALFCUT_PRINTER
  },
  silentPrint: false,
  adminPassword: '',
  ai: defaultAiSettings(),
  template: {
    eventName: 'PHOTO BOOTH',
    logoPath: '',
    framePath: '',
    styleVersion: 2,
    selectedStyleId: 'style1',
    selectedDesignId: '',
    aiPresets: [],
    faceAssetPacks: [],
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
    leftBleedIn: 0.16,
    rightBleedIn: 0.16,
    topBleedIn: 0.08,
    bottomBleedIn: 0.26
  }
});

async function ensureEventFolders(eventFolder: string) {
  await fs.mkdir(path.join(eventFolder, 'originals'), { recursive: true });
  await fs.mkdir(path.join(eventFolder, 'finals'), { recursive: true });
  await fs.mkdir(path.join(eventFolder, 'originals', 'thumbs'), { recursive: true });
  await fs.mkdir(path.join(eventFolder, 'finals', 'thumbs'), { recursive: true });
  await fs.mkdir(path.join(eventFolder, 'templates'), { recursive: true });
  await fs.mkdir(path.join(eventFolder, 'face-assets'), { recursive: true });
  await fs.mkdir(path.join(eventFolder, 'ai-presets'), { recursive: true });
  await fs.mkdir(path.join(eventFolder, 'ai-queue'), { recursive: true });
  await fs.mkdir(path.join(eventFolder, 'ai-queue', 'inputs'), { recursive: true });
  await fs.mkdir(path.join(eventFolder, 'ai-queue', 'results'), { recursive: true });
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
      defaultPrinter: normalizePrinterName(parsed.defaultPrinter ?? fallback.defaultPrinter),
      ai: normalizeAiSettings(parsed.ai),
      template: {
        ...fallback.template,
        ...(parsed.template ?? {}),
        styleVersion: 2,
        selectedStyleId: normalizeTemplateStyleId(String(parsed.template?.selectedStyleId ?? fallback.template.selectedStyleId), isLegacyTemplateStyle),
        aiPresets: (parsed.template?.aiPresets ?? fallback.template.aiPresets).map(normalizeAiPreset),
        faceAssetPacks: (parsed.template?.faceAssetPacks ?? fallback.template.faceAssetPacks).map(normalizeFaceAssetPack),
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
      cameraPreviewOverlay: normalizeCameraPreviewOverlay(parsed.cameraPreviewOverlay),
      stylePrinters: normalizeStylePrinters({
        ...fallback.stylePrinters,
        ...(parsed.stylePrinters ?? {})
      }),
      printCalibration: normalizePrintCalibration({
        ...fallback.printCalibration,
        ...(parsed.printCalibration ?? {})
      })
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
  const normalized = {
    ...settings,
    defaultPrinter: normalizePrinterName(settings.defaultPrinter),
    ai: normalizeAiSettings(settings.ai),
    template: {
      ...settings.template,
      aiPresets: settings.template.aiPresets.map(normalizeAiPreset),
      faceAssetPacks: settings.template.faceAssetPacks.map(normalizeFaceAssetPack),
      designs: settings.template.designs.map((design) => normalizeTemplateDesign(design))
    },
    stylePrinters: normalizeStylePrinters(settings.stylePrinters),
    printCalibration: normalizePrintCalibration(settings.printCalibration)
  };
  await ensureEventFolders(normalized.eventFolder);
  await fs.writeFile(settingsPath(), `${JSON.stringify(normalized, null, 2)}${os.EOL}`, 'utf8');
  return normalized;
}

type AppWindowKind = 'guest' | 'admin' | 'facePreview';

function windowUrl(kind: AppWindowKind, extraQuery = '') {
  const query = `window=${kind}${extraQuery ? `&${extraQuery}` : ''}`;
  return isDev
    ? `${process.env.VITE_DEV_SERVER_URL}?${query}`
    : `file://${path.join(__dirname, '..', 'dist', 'index.html')}?${query}`;
}

async function createWindow(kind: AppWindowKind, extraQuery = '') {
  const win = new BrowserWindow({
    width: kind === 'guest' ? 1280 : kind === 'facePreview' ? 980 : 1120,
    height: kind === 'guest' ? 800 : kind === 'facePreview' ? 680 : 760,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    title: kind === 'guest' ? 'Photo Booth' : kind === 'facePreview' ? 'Face Asset Preview' : 'Admin',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  await win.loadURL(windowUrl(kind, extraQuery));
  if (kind === 'guest') guestWindow = win;
  if (kind === 'admin') adminWindow = win;
  if (kind === 'facePreview') facePreviewWindow = win;
  if (kind === 'guest') {
    win.on('enter-full-screen', notifyGuestFullscreen);
    win.on('leave-full-screen', notifyGuestFullscreen);
  }
  win.on('closed', () => {
    if (kind === 'guest') guestWindow = null;
    if (kind === 'facePreview') facePreviewWindow = null;
    if (kind === 'admin') {
      adminWindow = null;
      facePreviewWindow?.close();
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

  const readPhotoMetadata = async (filePath: string) => {
    const metadataPath = filePath.replace(/\.(png|jpe?g)$/i, '.json');
    try {
      const raw = await fs.readFile(metadataPath, 'utf8');
      return JSON.parse(raw) as Partial<Pick<SavedPhoto, 'styleId' | 'designId' | 'printerName'>>;
    } catch {
      return {};
    }
  };

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
          const metadata = type === 'final' ? await readPhotoMetadata(filePath) : {};
          return {
            name: entry.name,
            path: filePath,
            thumbPath: hasThumb ? thumbPath : undefined,
            type,
            createdAt: stat.birthtime.toISOString(),
            styleId: metadata.styleId,
            designId: metadata.designId,
            printerName: metadata.printerName ? normalizePrinterName(metadata.printerName) : undefined
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
    framePath: migrateLegacy ? migrateLegacyTemplatePath(framePath, originalStyleId) : framePath,
    faceTrackingEnabled: Boolean(design.faceTrackingEnabled),
    faceAssetPackId: design.faceAssetPackId ?? ''
  };
};

const normalizeFaceAssetPlacement = (placement: unknown): FaceAssetPlacement => {
  if (placement === 'hat' || placement === 'nose' || placement === 'mouth' || placement === 'face') return placement;
  return 'glasses';
};

const finiteNumber = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const normalizeFaceAsset = (asset: FaceAsset): FaceAsset => ({
  ...asset,
  name: asset.name?.trim() || 'Face asset',
  path: asset.path ?? '',
  placement: normalizeFaceAssetPlacement(asset.placement),
  scale: finiteNumber(asset.scale, 1),
  xOffset: finiteNumber(asset.xOffset, 0),
  yOffset: finiteNumber(asset.yOffset, 0),
  rotation: finiteNumber(asset.rotation, 0),
  opacity: Math.min(1, Math.max(0, finiteNumber(asset.opacity, 1))),
  active: asset.active !== false,
  order: finiteNumber(asset.order, 0),
  createdAt: asset.createdAt || new Date().toISOString(),
  updatedAt: asset.updatedAt || new Date().toISOString()
});

const normalizeFaceAssetPack = (pack: FaceAssetPack): FaceAssetPack => ({
  ...pack,
  name: pack.name?.trim() || 'Face Asset Pack',
  active: pack.active !== false,
  assignPerFace: pack.assignPerFace === true,
  assets: (pack.assets ?? []).map(normalizeFaceAsset),
  createdAt: pack.createdAt || new Date().toISOString(),
  updatedAt: pack.updatedAt || new Date().toISOString()
});

const normalizeAiProvider = (provider: string | undefined): AiProvider => {
  if (provider === 'gemini' || provider === 'xai') return provider;
  return 'openai';
};

const normalizeThinkingLevel = (level: unknown): AppSettings['ai']['thinkingLevel'] => {
  if (level === 'none' || level === 'medium' || level === 'high') return level;
  return 'low';
};

const normalizeAiSettings = (settings?: Partial<AppSettings['ai']>): AppSettings['ai'] => {
  const fallback = defaultAiSettings();
  return {
    ...fallback,
    ...(settings ?? {}),
    provider: normalizeAiProvider(settings?.provider),
    thinkingLevel: normalizeThinkingLevel(settings?.thinkingLevel),
    providers: {
      openai: { ...fallback.providers.openai, ...(settings?.providers?.openai ?? {}) },
      gemini: { ...fallback.providers.gemini, ...(settings?.providers?.gemini ?? {}) },
      xai: { ...fallback.providers.xai, ...(settings?.providers?.xai ?? {}) }
    }
  };
};

const normalizeAiPreset = (preset: AiPreset): AiPreset => ({
  ...preset,
  referenceImages: preset.referenceImages ?? []
});

const normalizePrinterName = (printerName = '') => PRINTER_ALIASES.get(printerName) ?? printerName;

const normalizeCameraPreviewOverlay = (value: unknown): AppSettings['cameraPreviewOverlay'] => {
  if (value === 'style1' || value === 'style2' || value === 'style3' || value === 'style4') return value;
  if (value === 'portrait-tv') return 'style1';
  if (value === 'landscape') return 'style2';
  return 'none';
};

const normalizeStylePrinters = (stylePrinters: AppSettings['stylePrinters']): AppSettings['stylePrinters'] => ({
  style1: normalizePrinterName(stylePrinters.style1),
  style2: normalizePrinterName(stylePrinters.style2),
  style3: normalizePrinterName(stylePrinters.style3),
  style4: normalizePrinterName(stylePrinters.style4)
});

const normalizePrintCalibration = (calibration: Partial<AppSettings['printCalibration']>): AppSettings['printCalibration'] => ({
  leftBleedIn:
    typeof calibration.leftBleedIn === 'number'
      ? calibration.leftBleedIn
      : typeof calibration.offsetXIn === 'number'
        ? Math.max(0, -calibration.offsetXIn)
        : 0.16,
  rightBleedIn:
    typeof calibration.rightBleedIn === 'number'
      ? calibration.rightBleedIn
      : typeof calibration.bleedXIn === 'number' && typeof calibration.offsetXIn === 'number'
        ? Math.max(0, calibration.bleedXIn + calibration.offsetXIn)
        : 0.16,
  topBleedIn:
    typeof calibration.topBleedIn === 'number'
      ? calibration.topBleedIn
      : typeof calibration.offsetYIn === 'number'
        ? Math.max(0, -calibration.offsetYIn)
        : 0.08,
  bottomBleedIn:
    typeof calibration.bottomBleedIn === 'number'
      ? calibration.bottomBleedIn
      : typeof calibration.bleedYIn === 'number' && typeof calibration.offsetYIn === 'number'
        ? Math.max(0, calibration.bleedYIn + calibration.offsetYIn)
        : 0.26
});

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
    faceTrackingEnabled: false,
    faceAssetPackId: '',
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

async function writePhotoMetadata(filePath: string, request: SaveImageRequest) {
  if (request.kind !== 'final') return;
  const metadata = {
    name: path.basename(filePath),
    styleId: request.styleId,
    designId: request.designId,
    printerName: request.printerName ? normalizePrinterName(request.printerName) : '',
    createdAt: new Date().toISOString()
  };
  await fs.writeFile(filePath.replace(/\.(png|jpe?g)$/i, '.json'), `${JSON.stringify(metadata, null, 2)}${os.EOL}`, 'utf8');
}

async function saveImageData(request: SaveImageRequest): Promise<SaveImageResult> {
  const settings = await readSettings();
  await ensureEventFolders(settings.eventFolder);
  const folder = request.kind === 'original' ? 'originals' : 'finals';
  const name = await photoName(settings.eventFolder);
  const filePath = path.join(settings.eventFolder, folder, name);
  const buffer = dataUrlToBuffer(request.dataUrl);
  await fs.writeFile(filePath, buffer);
  await writeThumbnail(buffer, settings.eventFolder, folder, name);
  await writePhotoMetadata(filePath, request);
  if (request.kind === 'final') lastFinalPath = filePath;
  return { path: filePath, name };
}

const aiQueuePath = (eventFolder: string) => path.join(eventFolder, 'ai-queue', 'queue.json');

async function readAiQueue(settings?: AppSettings): Promise<AiQueueItem[]> {
  settings = settings ?? await readSettings();
  await ensureEventFolders(settings.eventFolder);
  try {
    const raw = await fs.readFile(aiQueuePath(settings.eventFolder), 'utf8');
    return JSON.parse(raw) as AiQueueItem[];
  } catch {
    return [];
  }
}

async function writeAiQueue(items: AiQueueItem[], settings?: AppSettings) {
  settings = settings ?? await readSettings();
  await ensureEventFolders(settings.eventFolder);
  await fs.writeFile(aiQueuePath(settings.eventFolder), `${JSON.stringify(items, null, 2)}${os.EOL}`, 'utf8');
}

async function updateAiQueueItem(item: AiQueueItem, settings?: AppSettings) {
  settings = settings ?? await readSettings();
  const queue = await readAiQueue(settings);
  const next = queue.some((queueItem) => queueItem.id === item.id)
    ? queue.map((queueItem) => (queueItem.id === item.id ? item : queueItem))
    : [item, ...queue];
  await writeAiQueue(next, settings);
  return item;
}

async function copyAiPresetImage(presetId: string) {
  const sourcePath = await chooseTemplateAsset('preview');
  if (!sourcePath) return null;
  const settings = await readSettings();
  const presets = settings.template.aiPresets.map(normalizeAiPreset);
  const preset = presets.find((item) => item.id === presetId);
  if (!preset) throw new Error('AI preset not found.');
  const now = new Date().toISOString();
  const id = `ref-${Date.now()}`;
  const extension = path.extname(sourcePath).toLowerCase() || '.png';
  const folder = path.join(settings.eventFolder, 'ai-presets', presetId);
  await fs.mkdir(folder, { recursive: true });
  const targetPath = path.join(folder, `${id}${extension}`);
  await fs.copyFile(sourcePath, targetPath);
  const referenceImage = { id, path: targetPath, name: path.basename(sourcePath), createdAt: now };
  return writeSettings({
    ...settings,
    template: {
      ...settings.template,
      aiPresets: presets.map((item) =>
        item.id === presetId
          ? { ...item, referenceImages: [...item.referenceImages, referenceImage], updatedAt: now }
          : item
      )
    }
  });
}

async function removeAiPresetImage(presetId: string, imageId: string) {
  const settings = await readSettings();
  const presets = settings.template.aiPresets.map(normalizeAiPreset);
  const preset = presets.find((item) => item.id === presetId);
  const image = preset?.referenceImages.find((item) => item.id === imageId);
  if (image) await fs.rm(image.path, { force: true });
  const now = new Date().toISOString();
  return writeSettings({
    ...settings,
    template: {
      ...settings.template,
      aiPresets: presets.map((item) =>
        item.id === presetId
          ? { ...item, referenceImages: item.referenceImages.filter((reference) => reference.id !== imageId), updatedAt: now }
          : item
      )
    }
  });
}

const chooseFaceAssetImage = async () => {
  const parent = modalParent();
  const options = {
    properties: ['openFile'] as Array<'openFile'>,
    filters: [{ name: 'Transparent PNG Face Asset', extensions: ['png'] }]
  };
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  return result.canceled ? '' : result.filePaths[0] ?? '';
};

async function updateFaceAssetPack(pack: FaceAssetPack) {
  const settings = await readSettings();
  const now = new Date().toISOString();
  const normalized = normalizeFaceAssetPack({ ...pack, updatedAt: now });
  const packs = settings.template.faceAssetPacks.map(normalizeFaceAssetPack);
  const nextPacks = packs.some((item) => item.id === normalized.id)
    ? packs.map((item) => (item.id === normalized.id ? normalized : item))
    : [...packs, normalized];
  return writeSettings({
    ...settings,
    template: {
      ...settings.template,
      faceAssetPacks: nextPacks
    }
  });
}

async function deleteFaceAssetPack(packId: string) {
  const settings = await readSettings();
  const packs = settings.template.faceAssetPacks.map(normalizeFaceAssetPack);
  const pack = packs.find((item) => item.id === packId);
  if (pack) await fs.rm(path.join(settings.eventFolder, 'face-assets', packId), { force: true, recursive: true });
  return writeSettings({
    ...settings,
    template: {
      ...settings.template,
      faceAssetPacks: packs.filter((item) => item.id !== packId),
      designs: settings.template.designs.map((design) =>
        design.faceAssetPackId === packId
          ? normalizeTemplateDesign({ ...design, faceTrackingEnabled: false, faceAssetPackId: '', updatedAt: new Date().toISOString() })
          : normalizeTemplateDesign(design)
      )
    }
  });
}

async function uploadFaceAsset(packId: string) {
  const sourcePath = await chooseFaceAssetImage();
  if (!sourcePath) return readSettings();
  const settings = await readSettings();
  const packs = settings.template.faceAssetPacks.map(normalizeFaceAssetPack);
  const pack = packs.find((item) => item.id === packId);
  if (!pack) throw new Error('Face asset pack not found.');
  const now = new Date().toISOString();
  const id = `face-asset-${Date.now()}`;
  const folder = path.join(settings.eventFolder, 'face-assets', packId);
  await fs.mkdir(folder, { recursive: true });
  const targetPath = path.join(folder, `${id}.png`);
  await fs.copyFile(sourcePath, targetPath);
  const asset: FaceAsset = {
    id,
    name: path.parse(sourcePath).name || 'Face asset',
    path: targetPath,
    placement: 'glasses',
    scale: 1,
    xOffset: 0,
    yOffset: 0,
    rotation: 0,
    opacity: 1,
    active: true,
    order: pack.assets.length,
    createdAt: now,
    updatedAt: now
  };
  return writeSettings({
    ...settings,
    template: {
      ...settings.template,
      faceAssetPacks: packs.map((item) =>
        item.id === packId ? { ...item, assets: [...item.assets, asset], updatedAt: now } : item
      )
    }
  });
}

async function removeFaceAsset(packId: string, assetId: string) {
  const settings = await readSettings();
  const packs = settings.template.faceAssetPacks.map(normalizeFaceAssetPack);
  const pack = packs.find((item) => item.id === packId);
  const asset = pack?.assets.find((item) => item.id === assetId);
  if (asset) await fs.rm(asset.path, { force: true });
  const now = new Date().toISOString();
  return writeSettings({
    ...settings,
    template: {
      ...settings.template,
      faceAssetPacks: packs.map((item) =>
        item.id === packId
          ? { ...item, assets: item.assets.filter((candidate) => candidate.id !== assetId), updatedAt: now }
          : item
      )
    }
  });
}

const dataUrlMimeType = (dataUrl: string) => dataUrl.match(/^data:([^;,]+)/)?.[1] ?? 'image/png';

const fileToInlineImage = async (filePath: string) => {
  const dataUrl = await imageFileToDataUrl(filePath);
  return {
    dataUrl,
    mimeType: dataUrlMimeType(dataUrl),
    base64: dataUrl.split(',')[1] ?? ''
  };
};

const responseUrlToDataUrl = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`AI image download failed: ${response.status}`);
  const mimeType = response.headers.get('content-type')?.split(';')[0] || 'image/png';
  const buffer = Buffer.from(await response.arrayBuffer());
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
};

const aiPromptText = (settings: AppSettings, preset: AiPreset) =>
  [
    settings.ai.systemPrompt,
    settings.ai.thinkingLevel === 'none'
      ? ''
      : `Thinking level: ${settings.ai.thinkingLevel}. Briefly plan the edit before generating, prioritize preserving identity, frame integrity, and print quality.`,
    preset.prompt
  ]
    .filter(Boolean)
    .join('\n\n');

async function requestOpenAiImage(settings: AppSettings, preset: AiPreset, inputPath: string) {
  const provider = settings.ai.providers.openai;
  const input = await fileToInlineImage(inputPath);
  const references = await Promise.all(preset.referenceImages.map((image) => fileToInlineImage(image.path)));
  const form = new FormData();
  form.append('model', provider.model);
  form.append('prompt', aiPromptText(settings, preset));
  form.append('size', provider.size || '1024x1536');
  form.append('quality', provider.quality || 'low');
  form.append('output_format', 'png');
  for (const image of [input, ...references]) {
    form.append('image[]', new Blob([Buffer.from(image.base64, 'base64')], { type: image.mimeType }), 'image.png');
  }
  const response = await fetch(provider.apiUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${provider.apiKey}` },
    body: form
  });
  const body = await response.json() as { data?: Array<{ b64_json?: string; url?: string }>; error?: { message?: string } };
  if (!response.ok) throw new Error(body.error?.message || `OpenAI request failed: ${response.status}`);
  const image = body.data?.[0];
  if (image?.b64_json) return `data:image/png;base64,${image.b64_json}`;
  if (image?.url) return responseUrlToDataUrl(image.url);
  throw new Error('OpenAI did not return an image.');
}

async function requestGeminiImage(settings: AppSettings, preset: AiPreset, inputPath: string) {
  const provider = settings.ai.providers.gemini;
  const input = await fileToInlineImage(inputPath);
  const references = await Promise.all(preset.referenceImages.map((image) => fileToInlineImage(image.path)));
  const apiUrl = provider.apiUrl.includes('{model}')
    ? provider.apiUrl.replace('{model}', encodeURIComponent(provider.model))
    : provider.apiUrl;
  const parts = [
    { text: aiPromptText(settings, preset) },
    ...[input, ...references].map((image) => ({
      inline_data: {
        mime_type: image.mimeType,
        data: image.base64
      }
    }))
  ];
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': provider.apiKey
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
    })
  });
  const body = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string }; inline_data?: { data?: string; mime_type?: string } }> } }>;
    error?: { message?: string };
  };
  if (!response.ok) throw new Error(body.error?.message || `Gemini request failed: ${response.status}`);
  const output = body.candidates?.[0]?.content?.parts?.find((part) => part.inlineData?.data || part.inline_data?.data);
  const inlineData = output?.inlineData;
  const inlineDataSnake = output?.inline_data;
  const imageData = inlineData?.data ?? inlineDataSnake?.data;
  if (!imageData) throw new Error('Gemini did not return an image.');
  return `data:${inlineData?.mimeType ?? inlineDataSnake?.mime_type ?? 'image/png'};base64,${imageData}`;
}

async function requestXaiImage(settings: AppSettings, preset: AiPreset, inputPath: string) {
  if (preset.referenceImages.length > 0) {
    throw new Error('Grok image edit currently supports the framed input only. Use OpenAI or Gemini for reference images.');
  }
  const provider = settings.ai.providers.xai;
  const input = await fileToInlineImage(inputPath);
  const response = await fetch(provider.apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`
    },
    body: JSON.stringify({
      model: provider.model,
      prompt: aiPromptText(settings, preset),
      image: { url: input.dataUrl, type: 'image_url' }
    })
  });
  const body = await response.json() as { data?: Array<{ b64_json?: string; url?: string }>; error?: { message?: string } };
  if (!response.ok) throw new Error(body.error?.message || `xAI request failed: ${response.status}`);
  const image = body.data?.[0];
  if (image?.b64_json) return `data:image/png;base64,${image.b64_json}`;
  if (image?.url) return responseUrlToDataUrl(image.url);
  throw new Error('xAI did not return an image.');
}

async function requestAiImage(settings: AppSettings, preset: AiPreset, providerName: AiProvider, inputPath: string) {
  const provider = settings.ai.providers[providerName];
  if (!provider.enabled) throw new Error(`${providerName} is not enabled.`);
  if (!provider.apiKey.trim()) throw new Error(`${providerName} API key is missing.`);
  if (!provider.apiUrl.trim()) throw new Error(`${providerName} API URL is missing.`);
  if (!provider.model.trim()) throw new Error(`${providerName} model is missing.`);
  if (providerName === 'gemini') return requestGeminiImage(settings, preset, inputPath);
  if (providerName === 'xai') return requestXaiImage(settings, preset, inputPath);
  return requestOpenAiImage(settings, preset, inputPath);
}

async function createAiQueueItem(request: AiGenerateRequest) {
  const settings = await readSettings();
  await ensureEventFolders(settings.eventFolder);
  const now = new Date().toISOString();
  const id = `ai-job-${Date.now()}`;
  const inputPath = path.join(settings.eventFolder, 'ai-queue', 'inputs', `${id}.png`);
  await fs.writeFile(inputPath, dataUrlToBuffer(request.dataUrl));
  const item: AiQueueItem = {
    id,
    status: 'queued',
    styleId: request.styleId,
    designId: request.designId,
    presetId: request.presetId,
    provider: settings.ai.provider,
    inputPath,
    resultPath: '',
    finalPath: '',
    printerName: request.printerName ? normalizePrinterName(request.printerName) : '',
    error: '',
    createdAt: now,
    updatedAt: now,
    retryCount: 0
  };
  await updateAiQueueItem(item, settings);
  return item;
}

async function processAiQueueItem(itemId: string, isRetry = false): Promise<AiGenerateResult> {
  const settings = await readSettings();
  const queue = await readAiQueue(settings);
  const item = queue.find((queueItem) => queueItem.id === itemId);
  if (!item) throw new Error('AI queue item not found.');
  let working: AiQueueItem = {
    ...item,
    status: 'generating',
    error: '',
    updatedAt: new Date().toISOString(),
    retryCount: isRetry ? item.retryCount + 1 : item.retryCount
  };
  await updateAiQueueItem(working, settings);

  try {
    const preset = settings.template.aiPresets.map(normalizeAiPreset).find((candidate) => candidate.id === item.presetId);
    if (!preset) throw new Error('AI preset not found.');
    working = {
      ...working,
      status: 'requested',
      requestedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await updateAiQueueItem(working, settings);
    const dataUrl = await requestAiImage(settings, preset, working.provider, working.inputPath);
    const resultPath = path.join(settings.eventFolder, 'ai-queue', 'results', `${working.id}.png`);
    const buffer = dataUrlToBuffer(dataUrl);
    await fs.writeFile(resultPath, buffer);
    working = {
      ...working,
      status: 'done',
      resultPath,
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString()
    };
    await updateAiQueueItem(working, settings);
    const saved = await saveImageData({
      dataUrl,
      kind: 'final',
      filenamePrefix: 'final',
      styleId: working.styleId,
      designId: working.designId,
      printerName: working.printerName
    });
    working = {
      ...working,
      finalPath: saved.path,
      status: 'done',
      error: '',
      updatedAt: new Date().toISOString()
    };
    await updateAiQueueItem(working, settings);
    void printImage(saved.path, working.printerName, settings.silentPrint).then(async (printResult) => {
      const latestSettings = await readSettings();
      const currentQueue = await readAiQueue(latestSettings);
      const currentItem = currentQueue.find((queueItem) => queueItem.id === working.id) ?? working;
      await updateAiQueueItem(
        {
          ...currentItem,
          status: printResult.ok ? 'printed' : 'print_failed',
          error: printResult.ok ? '' : printResult.error || 'Print failed.',
          updatedAt: new Date().toISOString()
        },
        latestSettings
      );
    });
    return { item: working, dataUrl, saved, fallback: false };
  } catch (error) {
    working = {
      ...working,
      status: 'failed',
      error: error instanceof Error ? error.message : 'AI generation failed.',
      updatedAt: new Date().toISOString()
    };
    await updateAiQueueItem(working, settings);
    return { item: working, fallback: true };
  }
}

async function printAiQueueItem(itemId: string) {
  const settings = await readSettings();
  const queue = await readAiQueue(settings);
  const item = queue.find((queueItem) => queueItem.id === itemId);
  if (!item) throw new Error('AI queue item not found.');
  const imagePath = item.finalPath || item.resultPath;
  if (!imagePath) throw new Error('AI queue item has no result to print.');
  const printResult = await printImage(imagePath, item.printerName, settings.silentPrint);
  const updated: AiQueueItem = {
    ...item,
    status: printResult.ok ? 'printed' : 'print_failed',
    error: printResult.ok ? '' : printResult.error || 'Print failed.',
    updatedAt: new Date().toISOString()
  };
  await updateAiQueueItem(updated, settings);
  return updated;
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

async function listPrintersForPrint() {
  const win = adminWindow ?? guestWindow;
  return win ? win.webContents.getPrintersAsync() : [];
}

const normalizePrinterKey = (value = '') => value.toLowerCase().replace(/[\s_-]+/g, '');

async function resolvePrinterName(requestedPrinter = '', fallbackPrinter = '') {
  const requested = normalizePrinterName(requestedPrinter.trim());
  const fallback = normalizePrinterName(fallbackPrinter.trim());
  const preferred = requested || fallback;
  if (!preferred) return '';

  const printers = await listPrintersForPrint();
  if (printers.length === 0) return preferred;

  const findPrinter = (printerName: string) => {
    const target = normalizePrinterName(printerName);
    const targetKey = normalizePrinterKey(target);
    return printers.find((printer) => {
      const name = printer.name ?? '';
      const displayName = printer.displayName ?? '';
      return (
        name === target ||
        displayName === target ||
        normalizePrinterKey(name) === targetKey ||
        normalizePrinterKey(displayName) === targetKey
      );
    });
  };

  const preferredPrinter = findPrinter(preferred);
  if (preferredPrinter) return preferredPrinter.name;

  if (fallback && fallback !== preferred) {
    const fallbackMatch = findPrinter(fallback);
    if (fallbackMatch) return fallbackMatch.name;
  }

  return '';
}

async function printImage(imagePath: string, printerName?: string, silent = false) {
  if (!imagePath) return { ok: false, error: 'No image selected for printing.' };
  const settings = await readSettings();
  const calibration = settings.printCalibration;
  const resolvedPrinterName = await resolvePrinterName(printerName, settings.defaultPrinter);
  if (silent && (printerName || settings.defaultPrinter) && !resolvedPrinterName) {
    return { ok: false, error: `Printer not found: ${printerName || settings.defaultPrinter}` };
  }
  const imageUrl = pathToFileURL(imagePath).toString();
  const printHtmlPath = path.join(app.getPath('temp'), `print-${Date.now()}.html`);
  const printWindow = new BrowserWindow({
    width: silent ? PRINT_PREVIEW_WIDTH : 520,
    height: silent ? PRINT_PREVIEW_HEIGHT : 720,
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
            left: 0;
            top: 0;
            width: 100%;
            height: 100%;
            object-fit: fill;
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
        deviceName: resolvedPrinterName || undefined,
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

  ipcMain.handle('settings:get', readSettings);
  ipcMain.handle('settings:update', async (_event, partial: Partial<AppSettings>) => {
    const current = await readSettings();
    const next: AppSettings = {
      ...current,
      ...partial,
      ai: normalizeAiSettings({
        ...current.ai,
        ...(partial.ai ?? {}),
        providers: {
          openai: { ...current.ai.providers.openai, ...(partial.ai?.providers?.openai ?? {}) },
          gemini: { ...current.ai.providers.gemini, ...(partial.ai?.providers?.gemini ?? {}) },
          xai: { ...current.ai.providers.xai, ...(partial.ai?.providers?.xai ?? {}) }
        }
      }),
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
      cameraPreviewOverlay: normalizeCameraPreviewOverlay(partial.cameraPreviewOverlay ?? current.cameraPreviewOverlay),
      stylePrinters: {
        ...current.stylePrinters,
        ...(partial.stylePrinters ?? {})
      },
      printCalibration: normalizePrintCalibration({
        ...current.printCalibration,
        ...(partial.printCalibration ?? {})
      })
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
  ipcMain.handle('face-asset-pack:update', async (_event, pack: FaceAssetPack) => updateFaceAssetPack(pack));
  ipcMain.handle('face-asset-pack:delete', async (_event, packId: string) => deleteFaceAssetPack(packId));
  ipcMain.handle('face-asset:upload', async (_event, packId: string) => uploadFaceAsset(packId));
  ipcMain.handle('face-asset:remove', async (_event, packId: string, assetId: string) => removeFaceAsset(packId, assetId));
  ipcMain.handle('ai:preset-image-upload', async (_event, presetId: string) => copyAiPresetImage(presetId));
  ipcMain.handle('ai:preset-image-remove', async (_event, presetId: string, imageId: string) => removeAiPresetImage(presetId, imageId));
  ipcMain.handle('ai:queue-list', async () => readAiQueue());
  ipcMain.handle('ai:queue-retry', async (_event, itemId: string) => processAiQueueItem(itemId, true));
  ipcMain.handle('ai:queue-print', async (_event, itemId: string) => printAiQueueItem(itemId));
  ipcMain.handle('ai:generate-final', async (_event, request: AiGenerateRequest) => {
    const item = await createAiQueueItem(request);
    void processAiQueueItem(item.id);
    return { item, fallback: false };
  });
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
  ipcMain.handle('window:open-face-asset-preview', async (_event, packId: string) => {
    const query = `packId=${encodeURIComponent(packId)}`;
    if (facePreviewWindow) {
      await facePreviewWindow.loadURL(windowUrl('facePreview', query));
      facePreviewWindow.show();
      facePreviewWindow.focus();
      return true;
    }
    await createWindow('facePreview', query);
    return true;
  });
  ipcMain.handle(
    'window:capture-page',
    async (event, rect?: { x: number; y: number; width: number; height: number }) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) throw new Error('Window not found.');
      const bounds = rect
        ? {
            x: Math.max(0, Math.round(rect.x)),
            y: Math.max(0, Math.round(rect.y)),
            width: Math.max(1, Math.round(rect.width)),
            height: Math.max(1, Math.round(rect.height))
          }
        : undefined;
      const image = bounds ? await win.webContents.capturePage(bounds) : await win.webContents.capturePage();
      return image.toDataURL();
    }
  );
  ipcMain.handle('guest:set-fullscreen', (_event, fullscreen: boolean) => setGuestFullscreen(fullscreen));
  ipcMain.handle('guest:is-fullscreen', () => isGuestFullscreen());
  ipcMain.handle('printers:list', async () => {
    const win = adminWindow ?? guestWindow;
    return win ? win.webContents.getPrintersAsync() : [];
  });
  ipcMain.handle('image:save', async (_event, request: SaveImageRequest): Promise<SaveImageResult> => {
    return saveImageData(request);
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
    await fs.rm(filePath.replace(/\.(png|jpe?g)$/i, '.json'), { force: true });
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

  await createWindow('admin');

  app.on('activate', () => {
    if (!adminWindow) void createWindow('admin');
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !adminWindow) app.quit();
});
