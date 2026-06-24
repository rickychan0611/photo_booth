import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, nativeImage, session, shell } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { exec, execFile, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import ffmpegStatic from 'ffmpeg-static';
import type {
  AiGenerateRequest,
  AiGenerateResult,
  AiPreset,
  AiProvider,
  AiQueueItem,
  AudioCue,
  AppSettings,
  BackgroundGalleryUploadRequest,
  BackgroundGalleryUploadResult,
  BackgroundVideoUploadRequest,
  ColorFilterPreset,
  ColorFilterValues,
  FaceAsset,
  FaceAssetPack,
  FaceAssetPlacement,
  Gallery,
  GalleryUploadStatus,
  HostVoiceGenerateResult,
  SaveImageRequest,
  SaveImageResult,
  SaveVideoRequest,
  SaveVideoResult,
  SavedPhoto,
  TemplateAssetRole,
  TemplateDesign,
  TemplateLayout,
  TemplateStyleId,
  TemplateUploadRequest
} from './types';

let guestWindow: BrowserWindow | null = null;
let adminWindow: BrowserWindow | null = null;
let facePreviewWindow: BrowserWindow | null = null;
let lastFinalPath = '';
let galleryUploadStatus: GalleryUploadStatus = { state: 'idle', message: 'No active upload.', active: 0 };

const PRINT_PREVIEW_WIDTH = 1239;
const PRINT_PREVIEW_HEIGHT = 1845;
const TEMPLATE_WIDTH = 2478;
const TEMPLATE_HEIGHT = 3690;
const LANDSCAPE_TEMPLATE_WIDTH = TEMPLATE_HEIGHT;
const LANDSCAPE_TEMPLATE_HEIGHT = TEMPLATE_WIDTH;
const STYLE4_HALFCUT_PRINTER = 'DS-RX1-HalfCut';
const PRINTER_ALIASES = new Map<string, string>([['DS-RX1-HaflCut', STYLE4_HALFCUT_PRINTER]]);

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

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

const neutralColorFilter = (): ColorFilterValues => ({
  intensity: 100,
  brightness: 0,
  contrast: 0,
  saturation: 0,
  warmth: 0,
  tint: 0,
  hue: 0,
  fade: 0,
  highlights: 0,
  shadows: 0,
  vignette: 0,
  blur: 0
});

const defaultColorFilterPresets = (): ColorFilterPreset[] => {
  const now = '';
  const preset = (id: string, name: string, filter: ColorFilterValues): ColorFilterPreset => ({
    id,
    name,
    active: true,
    thumbnailPath: '',
    filter: { ...neutralColorFilter(), ...filter },
    createdAt: now,
    updatedAt: now
  });
  return [
    preset('golden-hour-glow', 'Golden Hour Glow', { intensity: 75, brightness: 8, contrast: 12, saturation: 10, warmth: 22, tint: 4, hue: 2, fade: 5, highlights: -10, shadows: 8, vignette: 12, blur: 0 }),
    preset('clean-bright-blogger', 'Clean Bright Blogger', { intensity: 60, brightness: 18, contrast: 5, saturation: 6, warmth: 4, tint: 0, hue: 0, fade: 3, highlights: -18, shadows: 14, vignette: 4, blur: 0 }),
    preset('moody-street', 'Moody Street', { intensity: 80, brightness: -6, contrast: 24, saturation: -8, warmth: -6, tint: 3, hue: -2, fade: 12, highlights: -22, shadows: -10, vignette: 20, blur: 0 }),
    preset('soft-pastel-dream', 'Soft Pastel Dream', { intensity: 65, brightness: 12, contrast: -10, saturation: -12, warmth: 6, tint: 8, hue: 1, fade: 25, highlights: -12, shadows: 18, vignette: 6, blur: 2 }),
    preset('vintage-film', 'Vintage Film', { intensity: 85, brightness: -2, contrast: 10, saturation: -6, warmth: 14, tint: 6, hue: 3, fade: 30, highlights: -20, shadows: 10, vignette: 18, blur: 1 }),
    preset('cool-urban-blue', 'Cool Urban Blue', { intensity: 70, brightness: 4, contrast: 16, saturation: -4, warmth: -18, tint: -6, hue: -5, fade: 8, highlights: 0, shadows: 0, vignette: 0, blur: 0 })
  ];
};

const defaultAudioCue = (
  id: string,
  label: string,
  text: string,
  channel: AppSettings['audio']['cues'][string]['channel'] = 'voice',
  mode: AppSettings['audio']['cues'][string]['mode'] = channel === 'voice' ? 'host' : 'off',
  loop = false
): AppSettings['audio']['cues'][string] => ({
  id,
  label,
  mode,
  channel,
  text,
  filePath: '',
  loop,
  volume: 1,
  enabled: true,
  updatedAt: ''
});

const defaultAudioSettings = (): AppSettings['audio'] => ({
  enabled: true,
  masterVolume: 0.85,
  voiceVolume: 1,
  musicVolume: 0.35,
  sfxVolume: 0.8,
  enableHostVoice: true,
  voiceEngine: 'kokoro',
  voiceName: 'af_heart',
  speed: 1.08,
  volume: 1,
  welcomeRepeatSeconds: 10,
  cues: {
    welcome: defaultAudioCue('welcome', 'Welcome idle loop', 'Welcome. Touch start to begin.', 'voice', 'host', true),
    style: defaultAudioCue('style', 'Choose style screen', 'Please choose a style.'),
    design: defaultAudioCue('design', 'Choose design screen', 'Please choose a design.'),
    intro: defaultAudioCue('intro', 'Intro screen', "Let's take pictures."),
    select: defaultAudioCue('select', 'Photo selection screen', 'Please choose your favorite pictures to print.'),
    thanks: defaultAudioCue('thanks', 'Finish screen', 'Thank you. Please pick up your print.'),
    shot0: defaultAudioCue('shot0', 'Picture 1 message', 'Get ready!'),
    shot1: defaultAudioCue('shot1', 'Picture 2 message', 'Smile!'),
    shot2: defaultAudioCue('shot2', 'Picture 3 message', 'Switch it up!'),
    shot3: defaultAudioCue('shot3', 'Picture 4 message', 'Final pose!'),
    countdown3: defaultAudioCue('countdown3', 'Countdown 3', '3'),
    countdown2: defaultAudioCue('countdown2', 'Countdown 2', '2'),
    countdown1: defaultAudioCue('countdown1', 'Countdown 1', '1'),
    button: defaultAudioCue('button', 'Button press sound', '', 'sfx', 'off'),
    shutter: defaultAudioCue('shutter', 'Camera shutter sound', '', 'sfx', 'off'),
    backgroundMusic: defaultAudioCue('backgroundMusic', 'Background music loop', '', 'music', 'off', true)
  }
});

const defaultWorkflowShots = (): AppSettings['workflow']['shots'] => [
  { message: 'Get Ready!', cameraBeforeMessageMs: 3000, messageMs: 2000, cameraBeforeCountdownMs: 3000 },
  { message: 'Smile!', cameraBeforeMessageMs: 3000, messageMs: 2000, cameraBeforeCountdownMs: 3000 },
  { message: 'Switch It Up!', cameraBeforeMessageMs: 3000, messageMs: 2000, cameraBeforeCountdownMs: 3000 },
  { message: 'Final Pose!', cameraBeforeMessageMs: 3000, messageMs: 2000, cameraBeforeCountdownMs: 3000 }
];

const defaultTemplateShotAudioCue = (scopeId: string, index: number, text: string): AppSettings['audio']['cues'][string] => ({
  id: `${scopeId}-shot-${index}`,
  label: `Picture ${index + 1} voice`,
  mode: 'host',
  channel: 'voice',
  text,
  filePath: '',
  loop: false,
  volume: 1,
  enabled: true,
  updatedAt: ''
});

const defaultTemplateScreenCue = (
  scopeId: string,
  cueId: 'intro' | 'select' | 'thanks',
  label: string,
  text: string
): AppSettings['audio']['cues'][string] => ({
  id: `${scopeId}-${cueId}`,
  label,
  mode: 'host',
  channel: 'voice',
  text,
  filePath: '',
  loop: false,
  volume: 1,
  enabled: true,
  updatedAt: ''
});

const defaultTemplateWorkflow = (shotCount = 1): TemplateLayout['workflowDefaults'] => ({
  introMessage: `Let's take ${shotCount} picture${shotCount === 1 ? '' : 's'}!`,
  introMs: 2000,
  printAutoSelectMs: 20000,
  thankYouMessage: 'THANK YOU!',
  thankYouMs: 3000,
  screenCues: {
    intro: defaultTemplateScreenCue('template', 'intro', 'Intro screen voice', "Let's take pictures."),
    select: defaultTemplateScreenCue('template', 'select', 'Photo selection voice', 'Please choose your favorite pictures to print.'),
    thanks: defaultTemplateScreenCue('template', 'thanks', 'Finish screen voice', 'Thank you. Please pick up your print.')
  },
  shots: Array.from({ length: Math.max(1, shotCount) }, (_item, index) => {
    const shot = { ...(defaultWorkflowShots()[index] ?? defaultWorkflowShots()[defaultWorkflowShots().length - 1]) };
    return { ...shot, audioCue: defaultTemplateShotAudioCue('template', index, shot.message) };
  })
});

const templateDimensions = (orientation: TemplateLayout['orientation']) =>
  orientation === 'landscape'
    ? { width: LANDSCAPE_TEMPLATE_WIDTH, height: LANDSCAPE_TEMPLATE_HEIGHT }
    : { width: TEMPLATE_WIDTH, height: TEMPLATE_HEIGHT };

const defaultSettings = (): AppSettings => ({
  eventName: 'PHOTO BOOTH',
  eventFolder: defaultEventFolder(),
  webApiBaseUrl: 'http://localhost:3000',
  supabaseUrl: '',
  supabasePublishableKey: '',
  eventId: '',
  boothSecret: '',
  staffControlQueueMode: false,
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
  printerEnabled: true,
  silentPrint: false,
  adminPassword: '',
  beautyFilter: {
    enabledMode: 'print',
    previewTimeoutMs: 30000
  },
  ai: defaultAiSettings(),
  audio: defaultAudioSettings(),
  template: {
    eventName: 'PHOTO BOOTH',
    logoPath: '',
    framePath: '',
    styleVersion: 3,
    selectedTemplateId: '',
    selectedStyleId: 'style1',
    selectedDesignId: '',
    layouts: [],
    aiPresets: [],
    faceAssetPacks: [],
    colorFilterExamplePath: '',
    colorFilterPresetVersion: 2,
    colorFilterPresets: defaultColorFilterPresets(),
    designs: []
  },
  workflow: {
    introMessage: "Let's take 4 pictures!",
    introMs: 2000,
    printAutoSelectMs: 20000,
    thankYouMessage: 'THANK YOU!',
    thankYouMs: 3000,
    shots: defaultWorkflowShots()
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
  await fs.mkdir(path.join(eventFolder, 'videos'), { recursive: true });
  await fs.mkdir(path.join(eventFolder, 'templates'), { recursive: true });
  await fs.mkdir(path.join(eventFolder, 'templates', 'custom'), { recursive: true });
  await fs.mkdir(path.join(eventFolder, 'face-assets'), { recursive: true });
  await fs.mkdir(path.join(eventFolder, 'audio'), { recursive: true });
  await fs.mkdir(path.join(eventFolder, 'ai-presets'), { recursive: true });
  await fs.mkdir(path.join(eventFolder, 'color-filters'), { recursive: true });
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
    const isLegacyTemplateStyle = (parsed.template?.styleVersion ?? 0) < 2;
    const merged: AppSettings = {
      ...fallback,
      ...parsed,
      defaultPrinter: normalizePrinterName(parsed.defaultPrinter ?? fallback.defaultPrinter),
      beautyFilter: normalizeBeautyFilterSettings(parsed.beautyFilter),
      ai: normalizeAiSettings(parsed.ai),
      audio: normalizeAudioSettings(parsed.audio),
      template: {
        ...fallback.template,
        ...(parsed.template ?? {}),
        styleVersion: 3,
        selectedTemplateId: String(parsed.template?.selectedTemplateId ?? ''),
        selectedStyleId: normalizeTemplateStyleId(String(parsed.template?.selectedStyleId ?? fallback.template.selectedStyleId), isLegacyTemplateStyle),
        layouts: (parsed.template?.layouts ?? []).map((layout) => normalizeTemplateLayout(layout)),
        aiPresets: (parsed.template?.aiPresets ?? fallback.template.aiPresets).map(normalizeAiPreset),
        faceAssetPacks: (parsed.template?.faceAssetPacks ?? fallback.template.faceAssetPacks).map(normalizeFaceAssetPack),
        colorFilterExamplePath: String(parsed.template?.colorFilterExamplePath ?? fallback.template.colorFilterExamplePath),
        colorFilterPresetVersion: 2,
        colorFilterPresets: migrateColorFilterPresets(parsed.template?.colorFilterPresets, parsed.template?.colorFilterPresetVersion),
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
      printerEnabled: parsed.printerEnabled !== false,
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
    beautyFilter: normalizeBeautyFilterSettings(settings.beautyFilter),
    ai: normalizeAiSettings(settings.ai),
    audio: normalizeAudioSettings(settings.audio),
    template: {
      ...settings.template,
      styleVersion: 3,
      layouts: (settings.template.layouts ?? []).map(normalizeTemplateLayout),
      aiPresets: settings.template.aiPresets.map(normalizeAiPreset),
      faceAssetPacks: settings.template.faceAssetPacks.map(normalizeFaceAssetPack),
      colorFilterExamplePath: String(settings.template.colorFilterExamplePath ?? ''),
      colorFilterPresetVersion: 2,
      colorFilterPresets: normalizeColorFilterPresets(settings.template.colorFilterPresets),
      designs: settings.template.designs.map((design) => normalizeTemplateDesign(design))
    },
    stylePrinters: normalizeStylePrinters(settings.stylePrinters),
    printerEnabled: settings.printerEnabled !== false,
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
  const isGuestWindow = kind === 'guest';
  const win = new BrowserWindow({
    width: isGuestWindow ? 720 : kind === 'facePreview' ? 980 : 1120,
    height: isGuestWindow ? 1280 : kind === 'facePreview' ? 680 : 760,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    title: isGuestWindow ? 'Photo Booth' : kind === 'facePreview' ? 'Face Asset Preview' : 'Admin',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (isGuestWindow) {
    win.setAspectRatio(9 / 16);
  }

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
      return JSON.parse(raw) as Partial<Pick<SavedPhoto, 'templateId' | 'styleId' | 'designId' | 'printerName' | 'galleryUrl' | 'phoneNumber'>>;
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
            templateId: metadata.templateId,
            styleId: metadata.styleId,
            designId: metadata.designId,
            printerName: metadata.printerName ? normalizePrinterName(metadata.printerName) : undefined,
            galleryUrl: metadata.galleryUrl,
            phoneNumber: metadata.phoneNumber
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

async function audioFileToDataUrl(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  const extension = path.extname(filePath).toLowerCase();
  const mimeType =
    extension === '.wav'
      ? 'audio/wav'
      : extension === '.m4a'
        ? 'audio/mp4'
        : extension === '.ogg'
          ? 'audio/ogg'
          : 'audio/mpeg';
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

const execFileAsync = (
  file: string,
  args: string[],
  options: { input?: string; cwd?: string } = {}
): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = execFile(file, args, { cwd: options.cwd, windowsHide: true }, (error) => {
      if (error) reject(error);
      else resolve();
    });
    if (options.input) {
      child.stdin?.write(options.input);
      child.stdin?.end();
    }
  });

const appResourcePath = (...parts: string[]) =>
  isDev ? path.join(app.getAppPath(), ...parts) : path.join(process.resourcesPath, ...parts);

const eventTtsPath = (settings: AppSettings, ...parts: string[]) => path.join(settings.eventFolder, 'audio', 'tts', ...parts);

const hostVoiceHash = (settings: AppSettings, cue: AppSettings['audio']['cues'][string], text: string) =>
  crypto
    .createHash('sha1')
    .update(JSON.stringify({
      engine: settings.audio.voiceEngine,
      voiceName: settings.audio.voiceName,
      speed: settings.audio.speed,
      text,
      cueId: cue.id
    }))
    .digest('hex')
    .slice(0, 14);

const hostVoiceOutputPath = (settings: AppSettings, cue: AppSettings['audio']['cues'][string], text: string) =>
  path.join(
    settings.eventFolder,
    'audio',
    'generated',
    settings.audio.voiceEngine,
    safeTemplateName(settings.audio.voiceName || 'voice'),
    `${safeAudioCueId(cue.id)}-${hostVoiceHash(settings, cue, text)}.wav`
  );

const resolveTtsExecutable = async (settings: AppSettings) => {
  const engine = settings.audio.voiceEngine;
  const executableName = engine === 'kokoro' ? 'kokoro-tts.exe' : 'piper.exe';
  const candidates = [
    eventTtsPath(settings, engine, executableName),
    eventTtsPath(settings, engine, '.venv', 'Scripts', executableName),
    appResourcePath('tts', engine, executableName),
    appResourcePath('tts', engine, '.venv', 'Scripts', executableName),
    appResourcePath('extraResources', 'tts', engine, '.venv', 'Scripts', executableName),
    appResourcePath('extraResources', 'tts', engine, executableName)
  ];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  throw new Error(`${engine} executable not found. Place ${executableName} under resources/tts/${engine}/ or ${eventTtsPath(settings, engine)}.`);
};

const resolvePiperModel = async (settings: AppSettings) => {
  const voice = settings.audio.voiceName || 'en_US-lessac-medium';
  const candidates = [
    eventTtsPath(settings, 'piper', 'voices', `${voice}.onnx`),
    appResourcePath('tts', 'piper', 'voices', `${voice}.onnx`),
    appResourcePath('extraResources', 'tts', 'piper', 'voices', `${voice}.onnx`)
  ];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  throw new Error(`Piper voice model not found: ${voice}.onnx`);
};

const resolveKokoroWorkingDir = async (settings: AppSettings) => {
  const candidates = [
    eventTtsPath(settings, 'kokoro'),
    appResourcePath('tts', 'kokoro'),
    appResourcePath('extraResources', 'tts', 'kokoro')
  ];
  for (const candidate of candidates) {
    if (
      (await fileExists(candidate)) &&
      (await fileExists(path.join(candidate, 'kokoro-v1.0.onnx'))) &&
      (await fileExists(path.join(candidate, 'voices-v1.0.bin')))
    ) return candidate;
  }
  throw new Error('Kokoro model files not found. Put kokoro-v1.0.onnx and voices-v1.0.bin in resources/tts/kokoro or eventFolder/audio/tts/kokoro.');
};

async function synthesizeHostVoice(settings: AppSettings, text: string, outputPath: string) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const executable = await resolveTtsExecutable(settings);
  if (settings.audio.voiceEngine === 'piper') {
    const modelPath = await resolvePiperModel(settings);
    const lengthScale = String(Math.max(0.35, Math.min(2.5, 1 / Math.max(0.1, settings.audio.speed))));
    await execFileAsync(executable, ['--model', modelPath, '--output_file', outputPath, '--length_scale', lengthScale], { input: text });
    return;
  }

  const workingDir = await resolveKokoroWorkingDir(settings);
  const inputPath = path.join(path.dirname(outputPath), `${safeAudioCueId(path.basename(outputPath, '.wav'))}.txt`);
  await fs.writeFile(inputPath, text, 'utf8');
  await execFileAsync(executable, [
    inputPath,
    outputPath,
    '--voice',
    settings.audio.voiceName || 'af_heart',
    '--speed',
    String(settings.audio.speed)
  ], { cwd: workingDir });
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
  const templateId = design.templateId || styleId;
  return {
    ...design,
    templateId,
    styleId,
    previewPath: migrateLegacy ? migrateLegacyTemplatePath(previewPath, originalStyleId) : previewPath,
    framePath: migrateLegacy ? migrateLegacyTemplatePath(framePath, originalStyleId) : framePath,
    faceTrackingEnabled: Boolean(design.faceTrackingEnabled),
    faceAssetPackId: design.faceAssetPackId ?? '',
    videoRecordingEnabled: Boolean(design.videoRecordingEnabled),
    workflowOverrideEnabled: Boolean(design.workflowOverrideEnabled),
    workflowOverride: design.workflowOverride
      ? normalizeTemplateWorkflow(design.workflowOverride, Math.max(1, design.workflowOverride.shots?.length ?? 1))
      : undefined
  };
};

const normalizeRotation = (value: unknown): 0 | 90 | 180 | 270 =>
  value === 90 || value === 180 || value === 270 ? value : 0;

const normalizeTemplateWorkflow = (
  workflow: Partial<TemplateLayout['workflowDefaults']> | undefined,
  shotCount: number
): TemplateLayout['workflowDefaults'] => {
  const fallback = defaultTemplateWorkflow(shotCount);
  const sourceShots = workflow?.shots ?? [];
  const screenCues = {
    intro: normalizeAudioCue(
      {
        ...defaultTemplateScreenCue('template', 'intro', 'Intro screen voice', workflow?.introMessage ?? fallback.introMessage),
        ...(workflow?.screenCues?.intro ?? {})
      },
      defaultTemplateScreenCue('template', 'intro', 'Intro screen voice', workflow?.introMessage ?? fallback.introMessage)
    ),
    select: normalizeAudioCue(
      {
        ...defaultTemplateScreenCue('template', 'select', 'Photo selection voice', 'Please choose your favorite pictures to print.'),
        ...(workflow?.screenCues?.select ?? {})
      },
      defaultTemplateScreenCue('template', 'select', 'Photo selection voice', 'Please choose your favorite pictures to print.')
    ),
    thanks: normalizeAudioCue(
      {
        ...defaultTemplateScreenCue('template', 'thanks', 'Finish screen voice', workflow?.thankYouMessage ?? fallback.thankYouMessage),
        ...(workflow?.screenCues?.thanks ?? {})
      },
      defaultTemplateScreenCue('template', 'thanks', 'Finish screen voice', workflow?.thankYouMessage ?? fallback.thankYouMessage)
    )
  };
  return {
    ...fallback,
    ...(workflow ?? {}),
    introMessage: workflow?.introMessage ?? fallback.introMessage,
    thankYouMessage: workflow?.thankYouMessage ?? fallback.thankYouMessage,
    introMs: finiteNumber(workflow?.introMs, fallback.introMs),
    printAutoSelectMs: finiteNumber(workflow?.printAutoSelectMs, fallback.printAutoSelectMs),
    thankYouMs: finiteNumber(workflow?.thankYouMs, fallback.thankYouMs),
    screenCues,
    shots: Array.from({ length: Math.max(1, shotCount) }, (_item, index) => {
      const fallbackShot = fallback.shots[Math.min(index, fallback.shots.length - 1)];
      const sourceShot = sourceShots[index] ?? {};
      const sourceCue = sourceShot.audioCue;
      const message = sourceShot.message ?? fallbackShot.message;
      return {
        ...fallbackShot,
        ...sourceShot,
        audioCue: normalizeAudioCue(
          {
            ...defaultTemplateShotAudioCue('template', index, message),
            ...(sourceCue ?? {}),
            label: sourceCue?.label || `Picture ${index + 1} voice`,
            channel: 'voice',
            text: sourceCue?.text ?? message
          },
          defaultTemplateShotAudioCue('template', index, message)
        )
      };
    })
  };
};

const normalizeTemplateLayout = (layout: TemplateLayout): TemplateLayout => {
  const orientation = layout.orientation === 'landscape' ? 'landscape' : 'portrait';
  const dimensions = templateDimensions(orientation);
  const photoWindows = (layout.photoWindows ?? []).map((slot, index) => ({
    x: finiteNumber(slot.x, dimensions.width * 0.1),
    y: finiteNumber(slot.y, dimensions.height * 0.1),
    width: Math.max(40, finiteNumber(slot.width, dimensions.width / 3)),
    height: Math.max(40, finiteNumber(slot.height, dimensions.height / 3)),
    sourceIndex: index,
    cropY: slot.cropY === 'top' ? 'top' as const : 'center' as const,
    rotation: normalizeRotation(slot.rotation)
  }));
  const shotCount = Math.max(1, photoWindows.length);
  return {
    ...layout,
    id: layout.id || `template-${Date.now()}`,
    name: layout.name?.trim() || 'Template',
    orientation,
    paperWidth: dimensions.width,
    paperHeight: dimensions.height,
    photoWindows,
    workflowDefaults: normalizeTemplateWorkflow(layout.workflowDefaults, shotCount),
    printerName: normalizePrinterName(layout.printerName ?? ''),
    createdAt: layout.createdAt || new Date().toISOString(),
    updatedAt: layout.updatedAt || new Date().toISOString()
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

const normalizeAudioCue = (
  cue: Partial<AppSettings['audio']['cues'][string]> | undefined,
  fallback: AppSettings['audio']['cues'][string]
): AppSettings['audio']['cues'][string] => {
  const rawMode = cue ? String((cue as { mode?: unknown }).mode ?? '') : '';
  const legacyMode = rawMode === 'tts' ? 'host' : rawMode;
  const mode = legacyMode === 'mp3' || legacyMode === 'host' || legacyMode === 'off' ? legacyMode : fallback.mode;
  const channel = cue?.channel === 'music' || cue?.channel === 'sfx' || cue?.channel === 'voice' ? cue.channel : fallback.channel;
  return {
    ...fallback,
    ...(cue ?? {}),
    id: fallback.id,
    label: cue?.label || fallback.label,
    mode,
    channel,
    text: cue?.text ?? fallback.text,
    filePath: cue?.filePath ?? '',
    loop: cue?.loop ?? fallback.loop,
    volume: Math.min(1, Math.max(0, finiteNumber(cue?.volume, fallback.volume))),
    enabled: cue?.enabled !== false,
    updatedAt: cue?.updatedAt ?? ''
  };
};

const normalizeAudioSettings = (settings?: Partial<AppSettings['audio']>): AppSettings['audio'] => {
  const fallback = defaultAudioSettings();
  const legacy = settings as Partial<AppSettings['audio']> & { ttsVoiceName?: string; ttsRate?: number };
  const cues = Object.fromEntries(
    Object.entries(fallback.cues).map(([id, cue]) => [id, normalizeAudioCue(settings?.cues?.[id], cue)])
  );
  Object.entries(settings?.cues ?? {}).forEach(([id, cue]) => {
    if (!cues[id]) cues[id] = normalizeAudioCue(cue, defaultAudioCue(id, cue.label || id, cue.text || ''));
  });
  return {
    ...fallback,
    ...(settings ?? {}),
    enabled: settings?.enabled !== false,
    masterVolume: Math.min(1, Math.max(0, finiteNumber(settings?.masterVolume, fallback.masterVolume))),
    voiceVolume: Math.min(1, Math.max(0, finiteNumber(settings?.voiceVolume, fallback.voiceVolume))),
    musicVolume: Math.min(1, Math.max(0, finiteNumber(settings?.musicVolume, fallback.musicVolume))),
    sfxVolume: Math.min(1, Math.max(0, finiteNumber(settings?.sfxVolume, fallback.sfxVolume))),
    enableHostVoice: settings?.enableHostVoice !== false,
    voiceEngine: settings?.voiceEngine === 'piper' ? 'piper' : 'kokoro',
    voiceName: settings?.voiceName ?? legacy.ttsVoiceName ?? fallback.voiceName,
    speed: Math.min(2, Math.max(0.5, finiteNumber(settings?.speed ?? legacy.ttsRate, fallback.speed))),
    volume: Math.min(1, Math.max(0, finiteNumber(settings?.volume, fallback.volume))),
    welcomeRepeatSeconds: Math.min(60, Math.max(3, finiteNumber(settings?.welcomeRepeatSeconds, fallback.welcomeRepeatSeconds))),
    cues
  };
};

const normalizeAiPreset = (preset: AiPreset): AiPreset => ({
  ...preset,
  referenceImages: preset.referenceImages ?? []
});

const finiteRange = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

const normalizeColorFilterValues = (filter: Partial<ColorFilterValues> | undefined): ColorFilterValues => {
  const fallback = neutralColorFilter();
  return {
    intensity: finiteRange(filter?.intensity, fallback.intensity, 0, 100),
    brightness: finiteRange(filter?.brightness, fallback.brightness, -50, 50),
    contrast: finiteRange(filter?.contrast, fallback.contrast, -50, 50),
    saturation: finiteRange(filter?.saturation, fallback.saturation, -50, 50),
    warmth: finiteRange(filter?.warmth, fallback.warmth, -50, 50),
    tint: finiteRange(filter?.tint, fallback.tint, -50, 50),
    hue: finiteRange(filter?.hue, fallback.hue, -180, 180),
    fade: finiteRange(filter?.fade, fallback.fade, 0, 50),
    highlights: finiteRange(filter?.highlights, fallback.highlights, -50, 50),
    shadows: finiteRange(filter?.shadows, fallback.shadows, -50, 50),
    vignette: finiteRange(filter?.vignette, fallback.vignette, 0, 50),
    blur: finiteRange(filter?.blur, fallback.blur, 0, 20)
  };
};

const normalizeColorFilterPreset = (preset: Partial<ColorFilterPreset>): ColorFilterPreset => {
  const now = new Date().toISOString();
  return {
    id: String(preset.id || `color-filter-${Date.now()}`),
    name: String(preset.name || 'Color Filter'),
    active: preset.active !== false,
    thumbnailPath: String(preset.thumbnailPath || ''),
    filter: normalizeColorFilterValues(preset.filter),
    createdAt: String(preset.createdAt || now),
    updatedAt: String(preset.updatedAt || now)
  };
};

const normalizeColorFilterPresets = (presets: Partial<ColorFilterPreset>[] | undefined) => {
  if (!presets) return defaultColorFilterPresets();
  return presets
    .map(normalizeColorFilterPreset)
    .filter((preset) => preset.id !== 'silver-soft' || Boolean(preset.updatedAt));
};

const migrateColorFilterPresets = (
  presets: Partial<ColorFilterPreset>[] | undefined,
  version: number | undefined
) => {
  const normalized = normalizeColorFilterPresets(presets);
  if ((version ?? 0) >= 2) return normalized;
  const existingIds = new Set(normalized.map((preset) => preset.id));
  return [
    ...normalized,
    ...defaultColorFilterPresets().filter((preset) => !existingIds.has(preset.id))
  ];
};

const normalizeBeautyFilterSettings = (settings: Partial<AppSettings['beautyFilter']> | undefined): AppSettings['beautyFilter'] => ({
  enabledMode: settings?.enabledMode === 'off' || settings?.enabledMode === 'live' ? settings.enabledMode : 'print',
  previewTimeoutMs: finiteRange(settings?.previewTimeoutMs, 30000, 5000, 120000)
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

const copyTemplateAsset = async (sourcePath: string, designFolder: string, role: TemplateAssetRole, layout?: TemplateLayout) => {
  if (role === 'frame') {
    const size = await getImageSize(sourcePath);
    const expected = templateDimensions(layout?.orientation ?? 'portrait');
    if (size.width !== expected.width || size.height !== expected.height) {
      throw new Error(`Print frame must be ${expected.width} x ${expected.height}. This file is ${size.width} x ${size.height}.`);
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
  const layout = settings.template.layouts.map(normalizeTemplateLayout).find((item) => item.id === request.templateId);
  if (!layout) throw new Error('Template layout not found.');
  const now = new Date().toISOString();
  const id = `design-${Date.now()}`;
  const name = request.name?.trim() || path.parse(frameSourcePath).name || 'Template';
  const designFolder = path.join(settings.eventFolder, 'templates', 'custom', request.templateId, `${id}-${safeTemplateName(name)}`);
  await fs.mkdir(designFolder, { recursive: true });
  const framePath = await copyTemplateAsset(frameSourcePath, designFolder, 'frame', layout);

  const design: TemplateDesign = {
    id,
    templateId: request.templateId,
    name,
    previewPath: framePath,
    framePath,
    active: true,
    usesAi: false,
    aiPresetId: '',
    faceTrackingEnabled: false,
    faceAssetPackId: '',
    videoRecordingEnabled: false,
    createdAt: now,
    updatedAt: now
  };
  await writeSettings({
    ...settings,
    template: {
      ...settings.template,
      selectedTemplateId: request.templateId,
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
  const layout = settings.template.layouts.map(normalizeTemplateLayout).find((item) => item.id === design.templateId);
  if (!layout) throw new Error('Template layout not found.');
  const sourcePath = await chooseTemplateAsset(role);
  if (!sourcePath) return null;
  const designFolder = path.dirname(design.framePath || design.previewPath);
  await fs.mkdir(designFolder, { recursive: true });
  const assetPath = await copyTemplateAsset(sourcePath, designFolder, role, layout);
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

async function updateTemplateLayout(layout: TemplateLayout) {
  const settings = await readSettings();
  const now = new Date().toISOString();
  const normalized = normalizeTemplateLayout({
    ...layout,
    updatedAt: now,
    createdAt: layout.createdAt || now
  });
  const layouts = settings.template.layouts.map(normalizeTemplateLayout);
  const nextLayouts = layouts.some((item) => item.id === normalized.id)
    ? layouts.map((item) => (item.id === normalized.id ? normalized : item))
    : [...layouts, normalized];
  return writeSettings({
    ...settings,
    template: {
      ...settings.template,
      selectedTemplateId: normalized.id,
      layouts: nextLayouts
    }
  });
}

async function deleteTemplateLayout(templateId: string) {
  const settings = await readSettings();
  const designs = settings.template.designs.map((item) => normalizeTemplateDesign(item));
  const removedDesigns = designs.filter((item) => item.templateId === templateId);
  await fs.rm(path.join(settings.eventFolder, 'templates', 'custom', templateId), { force: true, recursive: true });
  for (const design of removedDesigns) {
    const folder = path.dirname(design.framePath || design.previewPath);
    if (folder) await fs.rm(folder, { force: true, recursive: true }).catch(() => undefined);
  }
  return writeSettings({
    ...settings,
    template: {
      ...settings.template,
      selectedTemplateId: settings.template.selectedTemplateId === templateId ? '' : settings.template.selectedTemplateId,
      selectedDesignId: removedDesigns.some((design) => design.id === settings.template.selectedDesignId) ? '' : settings.template.selectedDesignId,
      layouts: settings.template.layouts.map(normalizeTemplateLayout).filter((item) => item.id !== templateId),
      designs: designs.filter((item) => item.templateId !== templateId)
    }
  });
}

async function saveGuideTemplate(templateId: string, dataUrl: string) {
  const settings = await readSettings();
  await ensureEventFolders(settings.eventFolder);
  const layout = settings.template.layouts.map(normalizeTemplateLayout).find((item) => item.id === templateId);
  if (!layout) throw new Error('Template layout not found.');
  const filePath = path.join(settings.eventFolder, 'templates', `${safeTemplateName(layout.name)}-blank-guide.png`);
  await fs.writeFile(filePath, dataUrlToBuffer(dataUrl));
  await shell.showItemInFolder(filePath);
  return filePath;
}

type PortableTemplateDesign = Omit<TemplateDesign, 'id' | 'templateId' | 'previewPath' | 'framePath' | 'filePath' | 'styleId'> & {
  originalId?: string;
  previewName?: string;
  frameName?: string;
  previewDataUrl: string;
  frameDataUrl: string;
};

type PortableTemplatePackage = {
  version: 1;
  exportedAt: string;
  template: Omit<TemplateLayout, 'id'> & { originalId?: string };
  designs: PortableTemplateDesign[];
};

const stripWorkflowAudioPaths = (workflow: TemplateLayout['workflowDefaults']): TemplateLayout['workflowDefaults'] => ({
  ...workflow,
  screenCues: Object.fromEntries(
    Object.entries(workflow.screenCues ?? {}).map(([key, cue]) => [key, cue ? { ...cue, filePath: '' } : cue])
  ) as TemplateLayout['workflowDefaults']['screenCues'],
  shots: workflow.shots.map((shot) => ({
    ...shot,
    audioCue: shot.audioCue ? { ...shot.audioCue, filePath: '' } : undefined
  }))
});

async function exportTemplatePackage(templateId: string) {
  const settings = await readSettings();
  const layout = settings.template.layouts.map(normalizeTemplateLayout).find((item) => item.id === templateId);
  if (!layout) throw new Error('Template layout not found.');
  const designs = settings.template.designs.map((item) => normalizeTemplateDesign(item)).filter((item) => item.templateId === templateId);
  const portableDesigns = await Promise.all(
    designs.map(async (design) => {
      const {
        id,
        templateId: _templateId,
        styleId: _styleId,
        previewPath,
        framePath,
        filePath: _filePath,
        ...rest
      } = design;
      return {
        ...rest,
        workflowOverride: rest.workflowOverride ? stripWorkflowAudioPaths(rest.workflowOverride) : undefined,
        originalId: id,
        previewName: path.basename(previewPath || framePath),
        frameName: path.basename(framePath || previewPath),
        previewDataUrl: await imageFileToDataUrl(previewPath || framePath),
        frameDataUrl: await imageFileToDataUrl(framePath || previewPath)
      };
    })
  );
  const { id: originalId, ...template } = { ...layout, workflowDefaults: stripWorkflowAudioPaths(layout.workflowDefaults) };
  const portable: PortableTemplatePackage = {
    version: 1,
    exportedAt: new Date().toISOString(),
    template: { ...template, originalId },
    designs: portableDesigns
  };
  const parent = modalParent();
  const result = parent
    ? await dialog.showSaveDialog(parent, {
        defaultPath: `${safeTemplateName(layout.name)}.json`,
        filters: [{ name: 'Photo Booth Template', extensions: ['json'] }]
      })
    : await dialog.showSaveDialog({
        defaultPath: `${safeTemplateName(layout.name)}.json`,
        filters: [{ name: 'Photo Booth Template', extensions: ['json'] }]
      });
  if (result.canceled || !result.filePath) return { ok: false };
  await fs.writeFile(result.filePath, JSON.stringify(portable, null, 2), 'utf8');
  return { ok: true, filePath: result.filePath };
}

const assertDataUrl = (value: unknown, label: string) => {
  if (typeof value !== 'string' || !value.startsWith('data:image/')) throw new Error(`${label} is missing image data.`);
  return value;
};

async function writeImportedAsset(dataUrl: string, folder: string, filename: string, layout: TemplateLayout, role: TemplateAssetRole) {
  await fs.mkdir(folder, { recursive: true });
  const filePath = path.join(folder, filename);
  await fs.writeFile(filePath, dataUrlToBuffer(dataUrl));
  if (role === 'frame') {
    const size = await getImageSize(filePath);
    if (size.width !== layout.paperWidth || size.height !== layout.paperHeight) {
      await fs.rm(filePath, { force: true }).catch(() => undefined);
      throw new Error(`Imported print frame must be ${layout.paperWidth} x ${layout.paperHeight}. This file is ${size.width} x ${size.height}.`);
    }
  }
  return filePath;
}

async function importTemplatePackage() {
  const parent = modalParent();
  const result = parent
    ? await dialog.showOpenDialog(parent, {
        properties: ['openFile'],
        filters: [{ name: 'Photo Booth Template', extensions: ['json'] }]
      })
    : await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'Photo Booth Template', extensions: ['json'] }]
      });
  if (result.canceled || !result.filePaths[0]) return readSettings();

  const raw = await fs.readFile(result.filePaths[0], 'utf8');
  const parsed = JSON.parse(raw) as Partial<PortableTemplatePackage>;
  if (parsed.version !== 1 || !parsed.template || !Array.isArray(parsed.designs)) {
    throw new Error('Template JSON is not a supported Photo Booth template export.');
  }

  const settings = await readSettings();
  await ensureEventFolders(settings.eventFolder);
  const now = new Date().toISOString();
  const templateId = `template-${Date.now()}`;
  const layout = normalizeTemplateLayout({
    ...(parsed.template as TemplateLayout),
    id: templateId,
    name: `${parsed.template.name || 'Imported Template'}`,
    createdAt: now,
    updatedAt: now
  });
  const folder = path.join(settings.eventFolder, 'templates', 'custom', templateId);
  const importedDesigns: TemplateDesign[] = [];
  const activeAiPresetIds = new Set(settings.template.aiPresets.map((preset) => preset.id));
  const activeFacePackIds = new Set(settings.template.faceAssetPacks.map((pack) => pack.id));

  for (const [index, design] of parsed.designs.entries()) {
    const designId = `design-${Date.now()}-${index}`;
    const designName = design.name?.trim() || `Design ${index + 1}`;
    const designFolder = path.join(folder, `${designId}-${safeTemplateName(designName)}`);
    const frameDataUrl = assertDataUrl(design.frameDataUrl, 'Print frame');
    const previewDataUrl = assertDataUrl(design.previewDataUrl || design.frameDataUrl, 'Preview');
    const framePath = await writeImportedAsset(frameDataUrl, designFolder, 'frame.png', layout, 'frame');
    const previewPath = await writeImportedAsset(previewDataUrl, designFolder, 'preview.png', layout, 'preview');
    const hasAiPreset = Boolean(design.aiPresetId && activeAiPresetIds.has(design.aiPresetId));
    const hasFacePack = Boolean(design.faceAssetPackId && activeFacePackIds.has(design.faceAssetPackId));
    importedDesigns.push(normalizeTemplateDesign({
      ...design,
      id: designId,
      templateId,
      name: designName,
      previewPath,
      framePath,
      active: design.active !== false,
      usesAi: Boolean(design.usesAi && hasAiPreset),
      aiPresetId: hasAiPreset ? design.aiPresetId : '',
      faceTrackingEnabled: Boolean(design.faceTrackingEnabled && hasFacePack),
      faceAssetPackId: hasFacePack ? design.faceAssetPackId : '',
      videoRecordingEnabled: Boolean(design.videoRecordingEnabled),
      createdAt: now,
      updatedAt: now
    } as TemplateDesign));
  }

  return writeSettings({
    ...settings,
    template: {
      ...settings.template,
      selectedTemplateId: templateId,
      selectedDesignId: importedDesigns[0]?.id ?? settings.template.selectedDesignId,
      layouts: [...settings.template.layouts.map(normalizeTemplateLayout), layout],
      designs: [...settings.template.designs.map((item) => normalizeTemplateDesign(item)), ...importedDesigns]
    }
  });
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
    templateId: request.templateId ?? '',
    styleId: request.styleId,
    designId: request.designId,
    printerName: request.printerName ? normalizePrinterName(request.printerName) : '',
    galleryUrl: request.galleryUrl ?? '',
    phoneNumber: request.phoneNumber ?? '',
    createdAt: new Date().toISOString()
  };
  await fs.writeFile(filePath.replace(/\.(png|jpe?g)$/i, '.json'), `${JSON.stringify(metadata, null, 2)}${os.EOL}`, 'utf8');
}

async function updatePhotoMetadata(filePath: string, partial: Record<string, unknown>) {
  if (!filePath) return false;
  const metadataPath = filePath.replace(/\.(png|jpe?g)$/i, '.json');
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8')) as Record<string, unknown>;
  } catch {
    metadata = { name: path.basename(filePath), createdAt: new Date().toISOString() };
  }
  metadata = { ...metadata, ...partial };
  await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}${os.EOL}`, 'utf8');
  return true;
}

async function updatePhotoGalleryUrl(filePath: string, galleryUrl: string) {
  if (!filePath || !galleryUrl) return false;
  return updatePhotoMetadata(filePath, { galleryUrl });
}

async function updatePhotoPhoneNumber(filePath: string, phoneNumber: string) {
  if (!filePath || !phoneNumber) return false;
  return updatePhotoMetadata(filePath, { phoneNumber });
}

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, '');

function webApiUrl(settings: AppSettings, apiPath: string) {
  return `${trimTrailingSlash(settings.webApiBaseUrl || 'http://localhost:3000')}${apiPath}`;
}

function publicWebUrl(settings: AppSettings, galleryPath: string) {
  if (/^https?:\/\//i.test(galleryPath)) return galleryPath;
  return `${trimTrailingSlash(settings.webApiBaseUrl || 'http://localhost:3000')}${galleryPath.startsWith('/') ? galleryPath : `/${galleryPath}`}`;
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof body === 'object' && body && 'error' in body ? String((body as { error?: unknown }).error) : '';
    throw new Error(message || `Request failed: ${response.status}`);
  }
  return body as T;
}

function setGalleryUploadStatus(partial: Partial<GalleryUploadStatus>) {
  galleryUploadStatus = { ...galleryUploadStatus, ...partial };
  adminWindow?.webContents.send('gallery:upload-status', galleryUploadStatus);
  guestWindow?.webContents.send('gallery:upload-status', galleryUploadStatus);
  console.log(`[gallery-upload] ${galleryUploadStatus.state}: ${galleryUploadStatus.message}`);
}

function compressedJpegFromFile(filePath: string, maxLongEdge: number, quality: number) {
  const image = nativeImage.createFromPath(filePath);
  if (image.isEmpty()) throw new Error(`Could not read final photo: ${filePath}`);
  const size = image.getSize();
  const longEdge = Math.max(size.width, size.height, 1);
  const scale = Math.min(1, maxLongEdge / longEdge);
  const resized = image.resize({
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
    quality: 'good',
  });
  const resizedSize = resized.getSize();
  return {
    buffer: resized.toJPEG(quality),
    width: resizedSize.width,
    height: resizedSize.height,
  };
}

async function uploadGalleryBuffer(
  settings: AppSettings,
  ticketId: string,
  asset: {
    kind: 'layout' | 'thumbnail' | 'video';
    filename: string;
    contentType: string;
    buffer: Buffer;
    width: number;
    height: number;
  }
) {
  const formData = new FormData();
  formData.set('eventId', settings.eventId);
  formData.set('ticketId', ticketId);
  formData.set('kind', asset.kind);
  formData.set('filename', asset.filename);
  formData.set('width', String(asset.width));
  formData.set('height', String(asset.height));
  formData.set('file', new Blob([new Uint8Array(asset.buffer)], { type: asset.contentType }), asset.filename);

  console.log(`[gallery-upload] POST ${asset.kind} ${asset.filename} ${asset.buffer.byteLength} bytes`);
  const response = await fetch(webApiUrl(settings, '/api/uploads/direct'), {
    method: 'POST',
    headers: {
      'x-booth-secret': settings.boothSecret,
    },
    body: formData,
  });

  return parseJsonResponse<{ asset: unknown }>(response);
}

async function completeBackgroundBoothSession(
  settings: AppSettings,
  ticketId: string,
  phoneNumber?: string,
  marketingConsent?: boolean
) {
  const response = await fetch(webApiUrl(settings, '/api/booth/complete-session'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventId: settings.eventId, ticketId, phoneNumber, marketingConsent }),
  });
  return parseJsonResponse<{ ticket: unknown }>(response);
}

async function uploadFinalPhotoInBackground(
  request: BackgroundGalleryUploadRequest
): Promise<BackgroundGalleryUploadResult> {
  galleryUploadStatus.active += 1;
  setGalleryUploadStatus({ state: 'uploading', message: `Uploading ${path.basename(request.finalPath)}...`, lastError: undefined });
  try {
    const settings = await readSettings();
    if (!settings.webApiBaseUrl || !settings.eventId || !settings.boothSecret) {
      throw new Error('Web API, event ID, or booth secret is missing.');
    }

    const baseName = path.basename(request.finalPath).replace(/\.[^.]+$/, '');
    const layout = compressedJpegFromFile(request.finalPath, 2200, 88);
    const thumbnail = compressedJpegFromFile(request.finalPath, 720, 78);

    await uploadGalleryBuffer(settings, request.ticketId, {
      kind: 'layout',
      filename: `${baseName}.jpg`,
      contentType: 'image/jpeg',
      ...layout,
    });
    await uploadGalleryBuffer(settings, request.ticketId, {
      kind: 'thumbnail',
      filename: `${baseName}-thumbnail.jpg`,
      contentType: 'image/jpeg',
      ...thumbnail,
    });

    await completeBackgroundBoothSession(settings, request.ticketId, request.phoneNumber, request.marketingConsent);
    const onlineGalleryUrl = publicWebUrl(settings, request.galleryUrl);
    await updatePhotoMetadata(request.finalPath, {
      galleryUrl: onlineGalleryUrl,
      phoneNumber: request.phoneNumber ?? ''
    });
    galleryUploadStatus.active = Math.max(0, galleryUploadStatus.active - 1);
    setGalleryUploadStatus({
      state: galleryUploadStatus.active > 0 ? 'uploading' : 'done',
      message: `Uploaded ${path.basename(request.finalPath)}.`,
      lastGalleryUrl: onlineGalleryUrl,
      lastError: undefined,
    });
    return { ok: true, galleryUrl: onlineGalleryUrl };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Gallery upload failed.';
    galleryUploadStatus.active = Math.max(0, galleryUploadStatus.active - 1);
    setGalleryUploadStatus({
      state: galleryUploadStatus.active > 0 ? 'uploading' : 'failed',
      message,
      lastError: message,
    });
    return {
      ok: false,
      error: message,
    };
  }
}

const VIDEO_MAX_LONG_EDGE = 1280;
const VIDEO_CRF = 26;

const resolveFfmpegPath = () => {
  if (!ffmpegStatic) return '';
  // When packaged, ffmpeg-static lives inside app.asar but the binary must be
  // run from the unpacked copy (configured via electron-builder asarUnpack).
  return ffmpegStatic.replace('app.asar', 'app.asar.unpacked');
};

function transcodeToMp4(inputPath: string, outputPath: string) {
  return new Promise<void>((resolve, reject) => {
    const ffmpegPath = resolveFfmpegPath();
    if (!ffmpegPath) {
      reject(new Error('ffmpeg binary not available.'));
      return;
    }
    // Downscale the longer edge to VIDEO_MAX_LONG_EDGE (keeping aspect, even
    // dimensions) and encode H.264/AAC with faststart for broad playback.
    const scaleFilter =
      `scale='if(gt(a,1),min(${VIDEO_MAX_LONG_EDGE},iw),-2)':'if(gt(a,1),-2,min(${VIDEO_MAX_LONG_EDGE},ih))'`;
    const args = [
      '-y',
      '-i', inputPath,
      '-vf', scaleFilter,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', String(VIDEO_CRF),
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      outputPath
    ];
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
    });
  });
}

async function nextVideoName(eventFolder: string) {
  try {
    const entries = await fs.readdir(path.join(eventFolder, 'videos'), { withFileTypes: true });
    const numbers = entries
      .filter((entry) => entry.isFile() && /^\d+\.mp4$/i.test(entry.name))
      .map((entry) => Number.parseInt(path.parse(entry.name).name, 10))
      .filter((value) => Number.isFinite(value));
    const nextNumber = numbers.length > 0 ? Math.max(...numbers) + 1 : 1;
    return String(nextNumber);
  } catch {
    return String(Date.now());
  }
}

async function saveSessionVideoData(request: SaveVideoRequest): Promise<SaveVideoResult> {
  const settings = await readSettings();
  await ensureEventFolders(settings.eventFolder);
  const videosFolder = path.join(settings.eventFolder, 'videos');
  const safeBase = request.baseName?.trim().replace(/[^\w-]+/g, '') || (await nextVideoName(settings.eventFolder));
  const webmPath = path.join(videosFolder, `${safeBase}.webm`);
  const mp4Path = path.join(videosFolder, `${safeBase}.mp4`);
  const buffer = Buffer.from(request.data instanceof Uint8Array ? request.data : new Uint8Array(request.data));
  console.log(`[video] received recording ${buffer.byteLength} bytes -> ${webmPath}`);
  await fs.writeFile(webmPath, buffer);
  try {
    console.log(`[video] transcoding ${path.basename(webmPath)} -> ${path.basename(mp4Path)} (ffmpeg: ${resolveFfmpegPath() || 'MISSING'})`);
    await transcodeToMp4(webmPath, mp4Path);
    await fs.rm(webmPath, { force: true });
    console.log(`[video] saved ${mp4Path}`);
    return { path: mp4Path, name: path.basename(mp4Path) };
  } catch (error) {
    // Keep the raw webm if transcoding fails so the recording is not lost.
    console.warn('[video] transcode failed; keeping raw webm.', error);
    return { path: webmPath, name: path.basename(webmPath) };
  }
}

async function uploadSessionVideoInBackground(
  request: BackgroundVideoUploadRequest
): Promise<BackgroundGalleryUploadResult> {
  galleryUploadStatus.active += 1;
  setGalleryUploadStatus({ state: 'uploading', message: `Uploading ${path.basename(request.videoPath)}...`, lastError: undefined });
  try {
    const settings = await readSettings();
    if (!settings.webApiBaseUrl || !settings.eventId || !settings.boothSecret) {
      throw new Error('Web API, event ID, or booth secret is missing.');
    }
    const buffer = await fs.readFile(request.videoPath);
    const isMp4 = /\.mp4$/i.test(request.videoPath);
    console.log(`[video-upload] POST video ${path.basename(request.videoPath)} ${buffer.byteLength} bytes`);
    await uploadGalleryBuffer(settings, request.ticketId, {
      kind: 'video',
      filename: path.basename(request.videoPath),
      contentType: isMp4 ? 'video/mp4' : 'video/webm',
      buffer,
      width: 0,
      height: 0,
    });
    console.log(`[video-upload] uploaded ${path.basename(request.videoPath)}`);
    galleryUploadStatus.active = Math.max(0, galleryUploadStatus.active - 1);
    setGalleryUploadStatus({
      state: galleryUploadStatus.active > 0 ? 'uploading' : 'done',
      message: `Uploaded ${path.basename(request.videoPath)}.`,
      lastError: undefined,
    });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Video upload failed.';
    console.warn('[video-upload] failed', message);
    galleryUploadStatus.active = Math.max(0, galleryUploadStatus.active - 1);
    setGalleryUploadStatus({
      state: galleryUploadStatus.active > 0 ? 'uploading' : 'failed',
      message,
      lastError: message,
    });
    return { ok: false, error: message };
  }
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

async function uploadColorFilterImage(presetId: string, role: 'thumbnail' | 'example') {
  const sourcePath = await chooseTemplateAsset('preview');
  if (!sourcePath) return readSettings();
  const settings = await readSettings();
  const now = new Date().toISOString();
  const extension = path.extname(sourcePath).toLowerCase() || '.png';
  const folder = path.join(settings.eventFolder, 'color-filters');
  await fs.mkdir(folder, { recursive: true });
  const targetPath = role === 'example'
    ? path.join(folder, `example-${Date.now()}${extension}`)
    : path.join(folder, `${presetId}-${Date.now()}${extension}`);
  await fs.copyFile(sourcePath, targetPath);
  if (role === 'example') {
    return writeSettings({
      ...settings,
      template: {
        ...settings.template,
        colorFilterExamplePath: targetPath
      }
    });
  }
  const presets = normalizeColorFilterPresets(settings.template.colorFilterPresets);
  if (!presets.some((preset) => preset.id === presetId)) throw new Error('Color preset not found.');
  return writeSettings({
    ...settings,
    template: {
      ...settings.template,
      colorFilterPresets: presets.map((preset) =>
        preset.id === presetId
          ? { ...preset, thumbnailPath: targetPath, updatedAt: now }
          : preset
      )
    }
  });
}

async function saveGeneratedColorFilterThumbnails(thumbnails: Array<{ presetId: string; dataUrl: string }>) {
  const settings = await readSettings();
  const presets = normalizeColorFilterPresets(settings.template.colorFilterPresets);
  const now = new Date().toISOString();
  const folder = path.join(settings.eventFolder, 'color-filters');
  await fs.mkdir(folder, { recursive: true });
  const nextPaths = new Map<string, string>();
  for (const thumbnail of thumbnails) {
    if (!presets.some((preset) => preset.id === thumbnail.presetId)) continue;
    const targetPath = path.join(folder, `${thumbnail.presetId}-generated-${Date.now()}.png`);
    await fs.writeFile(targetPath, dataUrlToBuffer(thumbnail.dataUrl));
    nextPaths.set(thumbnail.presetId, targetPath);
  }
  if (nextPaths.size === 0) return settings;
  return writeSettings({
    ...settings,
    template: {
      ...settings.template,
      colorFilterPresets: presets.map((preset) =>
        nextPaths.has(preset.id)
          ? { ...preset, thumbnailPath: nextPaths.get(preset.id) ?? preset.thumbnailPath, updatedAt: now }
          : preset
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

const chooseAudioFile = async () => {
  const parent = modalParent();
  const options = {
    properties: ['openFile'] as Array<'openFile'>,
    filters: [{ name: 'Audio Files', extensions: ['mp3', 'wav', 'm4a', 'ogg'] }]
  };
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  return result.canceled ? '' : result.filePaths[0] ?? '';
};

const safeAudioCueId = (value: string) =>
  value
    .trim()
    .replace(/[^a-z0-9-_]/gi, '-')
    .replace(/-+/g, '-')
    .toLowerCase() || 'cue';

async function uploadAudioCue(cueId: string) {
  const sourcePath = await chooseAudioFile();
  if (!sourcePath) return readSettings();
  const settings = await readSettings();
  const audio = normalizeAudioSettings(settings.audio);
  const cue = audio.cues[cueId] ?? defaultAudioCue(cueId, cueId, '');
  const now = new Date().toISOString();
  const extension = path.extname(sourcePath).toLowerCase() || '.mp3';
  const targetPath = path.join(settings.eventFolder, 'audio', `${safeAudioCueId(cueId)}-${Date.now()}${extension}`);
  await ensureEventFolders(settings.eventFolder);
  await fs.copyFile(sourcePath, targetPath);
  return writeSettings({
    ...settings,
    audio: normalizeAudioSettings({
      ...audio,
      cues: {
        ...audio.cues,
        [cueId]: {
          ...cue,
          mode: 'mp3',
          filePath: targetPath,
          updatedAt: now
        }
      }
    })
  });
}

async function removeAudioCue(cueId: string) {
  const settings = await readSettings();
  const audio = normalizeAudioSettings(settings.audio);
  const cue = audio.cues[cueId];
  if (cue?.filePath) await fs.rm(cue.filePath, { force: true });
  return writeSettings({
    ...settings,
    audio: normalizeAudioSettings({
      ...audio,
      cues: {
        ...audio.cues,
        [cueId]: {
          ...(cue ?? defaultAudioCue(cueId, cueId, '')),
          mode: 'off',
          filePath: '',
          updatedAt: new Date().toISOString()
        }
      }
    })
  });
}

async function uploadStandaloneAudioCue(cue: AudioCue): Promise<AudioCue | null> {
  const sourcePath = await chooseAudioFile();
  if (!sourcePath) return null;
  const settings = await readSettings();
  await ensureEventFolders(settings.eventFolder);
  const now = new Date().toISOString();
  const extension = path.extname(sourcePath).toLowerCase() || '.mp3';
  const targetPath = path.join(settings.eventFolder, 'audio', 'template-cues', `${safeAudioCueId(cue.id)}-${Date.now()}${extension}`);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.copyFile(sourcePath, targetPath);
  return normalizeAudioCue(
    {
      ...cue,
      mode: 'mp3',
      filePath: targetPath,
      updatedAt: now
    },
    defaultAudioCue(cue.id, cue.label || cue.id, cue.text || '')
  );
}

async function clearStandaloneAudioCue(cue: AudioCue): Promise<AudioCue> {
  if (cue.filePath) await fs.rm(cue.filePath, { force: true }).catch(() => undefined);
  return normalizeAudioCue(
    {
      ...cue,
      mode: 'off',
      filePath: '',
      updatedAt: new Date().toISOString()
    },
    defaultAudioCue(cue.id, cue.label || cue.id, cue.text || '')
  );
}

async function generateStandaloneHostVoiceCue(cue: AudioCue): Promise<HostVoiceGenerateResult> {
  const settings = await readSettings();
  const audio = normalizeAudioSettings(settings.audio);
  const normalizedCue = normalizeAudioCue(cue, defaultAudioCue(cue.id, cue.label || cue.id, cue.text || ''));
  const text = normalizedCue.text.trim();
  if (!text) return { ok: false, settings, cue: normalizedCue, error: 'Cue text is empty.' };
  if (!audio.enableHostVoice) return { ok: false, settings, cue: normalizedCue, error: 'Host voice is disabled.' };
  try {
    const generatedPath = hostVoiceOutputPath({ ...settings, audio }, normalizedCue, text);
    if (!(await fileExists(generatedPath))) await synthesizeHostVoice({ ...settings, audio }, text, generatedPath);
    return {
      ok: true,
      settings,
      generatedPath,
      cue: normalizeAudioCue(
        {
          ...normalizedCue,
          mode: 'host',
          filePath: generatedPath,
          updatedAt: new Date().toISOString()
        },
        normalizedCue
      )
    };
  } catch (error) {
    return { ok: false, settings, cue: normalizedCue, error: error instanceof Error ? error.message : 'Host voice generation failed.' };
  }
}

async function generateHostVoiceCue(cueId: string): Promise<HostVoiceGenerateResult> {
  const settings = await readSettings();
  const audio = normalizeAudioSettings(settings.audio);
  const cue = audio.cues[cueId];
  if (!cue) return { ok: false, settings, error: 'Audio cue not found.' };
  const text = cue.text.trim();
  if (!text) return { ok: false, settings, error: 'Cue text is empty.' };
  if (!audio.enableHostVoice) return { ok: false, settings, error: 'Host voice is disabled.' };
  try {
    const generatedPath = hostVoiceOutputPath({ ...settings, audio }, cue, text);
    if (!(await fileExists(generatedPath))) await synthesizeHostVoice({ ...settings, audio }, text, generatedPath);
    const nextSettings = await writeSettings({
      ...settings,
      audio: normalizeAudioSettings({
        ...audio,
        cues: {
          ...audio.cues,
          [cueId]: {
            ...cue,
            mode: 'host',
            filePath: generatedPath,
            updatedAt: new Date().toISOString()
          }
        }
      })
    });
    return { ok: true, settings: nextSettings, generatedPath };
  } catch (error) {
    return { ok: false, settings, error: error instanceof Error ? error.message : 'Host voice generation failed.' };
  }
}

async function generateAllHostVoiceCues(): Promise<HostVoiceGenerateResult> {
  let settings = await readSettings();
  const audio = normalizeAudioSettings(settings.audio);
  const voiceCueIds = Object.values(audio.cues)
    .filter((cue) => cue.channel === 'voice' && cue.enabled && cue.text.trim())
    .map((cue) => cue.id);
  if (voiceCueIds.length === 0) return { ok: false, settings, error: 'No enabled voice cues with text.' };
  for (const cueId of voiceCueIds) {
    const result = await generateHostVoiceCue(cueId);
    settings = result.settings;
    if (!result.ok) return result;
  }
  return { ok: true, settings };
}

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
    templateId: request.templateId,
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
      templateId: working.templateId,
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
    if (!settings.printerEnabled) return { item: working, dataUrl, saved, fallback: false };
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
  if (!settings.printerEnabled) return { ok: true };
  const calibration = settings.printCalibration;
  const resolvedPrinterName = await resolvePrinterName(printerName, settings.defaultPrinter);
  if (silent && (printerName || settings.defaultPrinter) && !resolvedPrinterName) {
    return { ok: false, error: `Printer not found: ${printerName || settings.defaultPrinter}` };
  }
  const printImage = nativeImage.createFromPath(imagePath);
  const printSize = printImage.getSize();
  const isLandscape = printSize.width > printSize.height;
  const pageSize = isLandscape ? '6.15in 4.13in' : '4.13in 6.15in';
  const imageUrl = pathToFileURL(imagePath).toString();
  const printHtmlPath = path.join(app.getPath('temp'), `print-${Date.now()}.html`);
  const printWindow = new BrowserWindow({
    width: silent ? (isLandscape ? PRINT_PREVIEW_HEIGHT : PRINT_PREVIEW_WIDTH) : 720,
    height: silent ? (isLandscape ? PRINT_PREVIEW_WIDTH : PRINT_PREVIEW_HEIGHT) : 520,
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
          @page { size: ${pageSize}; margin: 0; }
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

  // Allow the guest renderer to capture its own window (composite video) and
  // microphone via getDisplayMedia/getUserMedia without showing a picker.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ['window', 'screen'] })
        .then((sources) => {
          const guestTitle = guestWindow?.getTitle();
          const match =
            (guestTitle ? sources.find((source) => source.name === guestTitle) : undefined) ?? sources[0];
          callback(match ? { video: match } : {});
        })
        .catch(() => callback({}));
    },
    { useSystemPicker: false }
  );
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === 'media' || permission === 'display-capture') {
      callback(true);
      return;
    }
    callback(true);
  });

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
      audio: normalizeAudioSettings({
        ...current.audio,
        ...(partial.audio ?? {}),
        cues: {
          ...current.audio.cues,
          ...(partial.audio?.cues ?? {})
        }
      }),
      beautyFilter: normalizeBeautyFilterSettings({
        ...current.beautyFilter,
        ...(partial.beautyFilter ?? {})
      }),
      template: {
        ...current.template,
        ...(partial.template ?? {}),
        layouts: (partial.template?.layouts ?? current.template.layouts).map(normalizeTemplateLayout),
        aiPresets: (partial.template?.aiPresets ?? current.template.aiPresets).map(normalizeAiPreset),
        faceAssetPacks: (partial.template?.faceAssetPacks ?? current.template.faceAssetPacks).map(normalizeFaceAssetPack),
        colorFilterExamplePath: String(partial.template?.colorFilterExamplePath ?? current.template.colorFilterExamplePath ?? ''),
        colorFilterPresetVersion: 2,
        colorFilterPresets: normalizeColorFilterPresets(partial.template?.colorFilterPresets ?? current.template.colorFilterPresets),
        designs: (partial.template?.designs ?? current.template.designs).map((design) => normalizeTemplateDesign(design))
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
  ipcMain.handle('audio:upload-cue', async (_event, cueId: string) => uploadAudioCue(cueId));
  ipcMain.handle('audio:remove-cue', async (_event, cueId: string) => removeAudioCue(cueId));
  ipcMain.handle('audio:upload-template-cue', async (_event, cue: AudioCue) => uploadStandaloneAudioCue(cue));
  ipcMain.handle('audio:remove-template-cue', async (_event, cue: AudioCue) => clearStandaloneAudioCue(cue));
  ipcMain.handle('audio:generate-host-cue', async (_event, cueId: string) => generateHostVoiceCue(cueId));
  ipcMain.handle('audio:generate-template-host-cue', async (_event, cue: AudioCue) => generateStandaloneHostVoiceCue(cue));
  ipcMain.handle('audio:generate-all-host-cues', async () => generateAllHostVoiceCues());
  ipcMain.handle('template:upload', async (_event, request: TemplateUploadRequest) => uploadTemplate(request));
  ipcMain.handle('template:update', async (_event, design: TemplateDesign) => updateTemplate(design));
  ipcMain.handle('template-layout:update', async (_event, layout: TemplateLayout) => updateTemplateLayout(layout));
  ipcMain.handle('template-layout:delete', async (_event, templateId: string) => deleteTemplateLayout(templateId));
  ipcMain.handle('template-layout:export', async (_event, templateId: string) => exportTemplatePackage(templateId));
  ipcMain.handle('template-layout:import', async () => importTemplatePackage());
  ipcMain.handle('template:update-asset', async (_event, designId: string, role: TemplateAssetRole) => updateTemplateAsset(designId, role));
  ipcMain.handle('template:delete', async (_event, designId: string) => deleteTemplate(designId));
  ipcMain.handle('face-asset-pack:update', async (_event, pack: FaceAssetPack) => updateFaceAssetPack(pack));
  ipcMain.handle('face-asset-pack:delete', async (_event, packId: string) => deleteFaceAssetPack(packId));
  ipcMain.handle('face-asset:upload', async (_event, packId: string) => uploadFaceAsset(packId));
  ipcMain.handle('face-asset:remove', async (_event, packId: string, assetId: string) => removeFaceAsset(packId, assetId));
  ipcMain.handle('ai:preset-image-upload', async (_event, presetId: string) => copyAiPresetImage(presetId));
  ipcMain.handle('ai:preset-image-remove', async (_event, presetId: string, imageId: string) => removeAiPresetImage(presetId, imageId));
  ipcMain.handle('color-filter:upload-thumbnail', async (_event, presetId: string) => uploadColorFilterImage(presetId, 'thumbnail'));
  ipcMain.handle('color-filter:upload-example', async () => uploadColorFilterImage('', 'example'));
  ipcMain.handle('color-filter:save-generated-thumbnails', async (_event, thumbnails: Array<{ presetId: string; dataUrl: string }>) =>
    saveGeneratedColorFilterThumbnails(thumbnails)
  );
  ipcMain.handle('ai:queue-list', async () => readAiQueue());
  ipcMain.handle('ai:queue-retry', async (_event, itemId: string) => processAiQueueItem(itemId, true));
  ipcMain.handle('ai:queue-print', async (_event, itemId: string) => printAiQueueItem(itemId));
  ipcMain.handle('ai:generate-final', async (_event, request: AiGenerateRequest) => {
    const item = await createAiQueueItem(request);
    void processAiQueueItem(item.id);
    return { item, fallback: false };
  });
  ipcMain.handle('template:save-guide', async (_event, templateId: string, dataUrl: string) => saveGuideTemplate(templateId, dataUrl));
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
  ipcMain.handle('image:update-gallery-url', async (_event, filePath: string, galleryUrl: string) => {
    return updatePhotoGalleryUrl(filePath, galleryUrl);
  });
  ipcMain.handle('image:update-phone-number', async (_event, filePath: string, phoneNumber: string) => {
    return updatePhotoPhoneNumber(filePath, phoneNumber);
  });
  ipcMain.handle('image:data-url', async (_event, filePath: string) => imageFileToDataUrl(filePath));
  ipcMain.handle('audio:data-url', async (_event, filePath: string) => audioFileToDataUrl(filePath));
  ipcMain.handle('image:size', async (_event, filePath: string) => getImageSize(filePath));
  ipcMain.handle('gallery:list', listGallery);
  ipcMain.handle('gallery:upload-final', async (_event, request: BackgroundGalleryUploadRequest) => {
    void uploadFinalPhotoInBackground(request);
    return { ok: true, galleryUrl: request.galleryUrl };
  });
  ipcMain.handle('video:save-and-transcode', async (_event, request: SaveVideoRequest): Promise<SaveVideoResult> => {
    return saveSessionVideoData(request);
  });
  ipcMain.handle('gallery:upload-video', async (_event, request: BackgroundVideoUploadRequest) => {
    void uploadSessionVideoInBackground(request);
    return { ok: true };
  });
  ipcMain.handle('gallery:upload-status', () => galleryUploadStatus);
  ipcMain.handle('file:open', async (_event, filePath: string) => {
    if (!filePath) return false;
    await shell.openPath(filePath);
    return true;
  });
  ipcMain.handle('url:open', async (_event, url: string) => {
    if (!url || !/^https?:\/\//i.test(url)) return false;
    await shell.openExternal(url);
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
