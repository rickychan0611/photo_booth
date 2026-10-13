import { normalizePoseGuide } from './poseTypes';
import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, nativeImage, session, shell } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { exec, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import ffmpegStatic from 'ffmpeg-static';
import { captureCanonStill, connectCanon, getCanonLiveViewFrame, prepareCanonCapture, releaseCanonFocus, stopCanonService } from './canon';
import { generateElevenLabsSpeech, listStoredPoses, registerPoseStorage, replaceStoredPoses } from './poseStorage';
import { registerPoseAi } from './poseAi';
import { applyCloudPoseLibrary, applyCloudSnapshot, cloudFingerprint, cloudProfileId, cloudSyncConfigured, fetchCloudSnapshot, pushCloudSnapshot } from './cloudSync';
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
  Gallery,
  GalleryUploadStatus,
  HostVoiceGenerateResult,
  CanonStillCrop,
  CloudSyncStatus,
  SaveImageRequest,
  SaveImageResult,
  SaveVideoRequest,
  SaveVideoResult,
  SavedPhoto,
  TemplateAssetRole,
  TemplateDesign,
  TemplateLayout,
  TemplateStyleId,
  TemplateUploadRequest,
  WorkflowShotSettings
} from './types';

let guestWindow: BrowserWindow | null = null;
let pendingPosePreview: unknown = null;
let adminWindow: BrowserWindow | null = null;
let lastFinalPath = '';
let galleryUploadStatus: GalleryUploadStatus = { state: 'idle', message: 'No active upload.', active: 0 };

const PRINT_PREVIEW_WIDTH = 1200;
const PRINT_PREVIEW_HEIGHT = 1800;
const TEMPLATE_WIDTH = 1200;
const TEMPLATE_HEIGHT = 1800;
const LANDSCAPE_TEMPLATE_WIDTH = 1800;
const LANDSCAPE_TEMPLATE_HEIGHT = 1200;
const STYLE4_HALFCUT_PRINTER = 'DS-RX1-HalfCut';
const PRINTER_ALIASES = new Map<string, string>([['DS-RX1-HaflCut', STYLE4_HALFCUT_PRINTER]]);

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const defaultEventFolder = () => path.join(app.getPath('pictures'), 'Photo Booth');
const projectConfigFolder = () => path.join(app.getAppPath(), 'config');
const PROJECT_ASSET_PREFIX = 'project-asset:';
const projectAssetsRoot = () => app.isPackaged
  ? path.join(process.resourcesPath, 'project-assets')
  : path.join(app.getAppPath(), 'public', 'project-assets');
const resolveProjectAssetPath = (value: string) => {
  if (!value.startsWith(PROJECT_ASSET_PREFIX)) return value;
  const relative = value.slice(PROJECT_ASSET_PREFIX.length).replace(/^[/\\]+/, '');
  const resolved = path.resolve(projectAssetsRoot(), relative);
  const root = path.resolve(projectAssetsRoot());
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error('Invalid project asset path.');
  return resolved;
};
const projectAssetToken = (value: string) => {
  const root = path.resolve(projectAssetsRoot());
  const resolved = path.resolve(value);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return value;
  return `${PROJECT_ASSET_PREFIX}${path.relative(root, resolved).split(path.sep).join('/')}`;
};
const reusableAssetsFolder = (settings: AppSettings, category: string) =>
  isDev ? path.join(projectAssetsRoot(), category) : path.join(settings.eventFolder, category);
const sharedSettingsPath = () => app.isPackaged
  ? path.join(process.resourcesPath, 'project-config', 'settings.shared.json')
  : path.join(projectConfigFolder(), 'settings.shared.json');
const localSettingsPath = () => isDev
  ? path.join(projectConfigFolder(), 'settings.local.json')
  : path.join(app.getPath('userData'), 'settings.json');
const legacySettingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const settingsBackupPath = () => `${localSettingsPath()}.bak`;
const settingsTempPath = () => `${localSettingsPath()}.tmp`;
const cloudSyncStatePath = () => path.join(app.getPath('userData'), 'cloud-sync-state.json');
const portableSettingsToken = {
  eventFolder: '${EVENT_FOLDER}',
  appUserData: '${APP_USER_DATA}',
  projectAssets: '${PROJECT_ASSETS}',
  pictures: '${PICTURES}',
  home: '${HOME}'
} as const;

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
  },
  poseGenerator: {
    provider: 'openai',
    providers: {
      openai: { apiUrl: 'https://api.openai.com/v1/responses', model: 'gpt-5.6-luna' },
      gemini: { apiUrl: 'https://generativelanguage.googleapis.com/v1beta/interactions', model: 'gemini-3.8-flash' },
      xai: { apiUrl: 'https://api.x.ai/v1/responses', model: 'grok-4.7' }
    }
  }
});

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
    people: defaultAudioCue('people', "Who's joining screen", "Who's joining the photo? Tell me who's here, then choose your pose style."),
    intro: defaultAudioCue('intro', 'Intro screen', "Let's take pictures."),
    select: defaultAudioCue('select', 'Photo selection screen', 'Please choose your favorite pictures to print.'),
    thanks: defaultAudioCue('thanks', 'Finish screen', 'Thank you. Please pick up your print.'),
    shot0: defaultAudioCue('shot0', 'Picture 1 message', 'Pose challenge!'),
    shot1: defaultAudioCue('shot1', 'Picture 2 message', 'Next one!'),
    shot2: defaultAudioCue('shot2', 'Picture 3 message', 'Looking good, now do this!'),
    shot3: defaultAudioCue('shot3', 'Picture 4 message', 'Last one! Now...'),
    shot4: defaultAudioCue('shot4', 'Picture 5 message', 'New pose!'),
    shot5: defaultAudioCue('shot5', 'Picture 6 message', 'Big smile!'),
    shot6: defaultAudioCue('shot6', 'Picture 7 message', 'Something silly!'),
    shot7: defaultAudioCue('shot7', 'Picture 8 message', 'Strike a pose!'),
    shot8: defaultAudioCue('shot8', 'Picture 9 message', 'One more!'),
    shot9: defaultAudioCue('shot9', 'Picture 10 message', 'Change it up!'),
    shot10: defaultAudioCue('shot10', 'Picture 11 message', 'Almost there!'),
    shot11: defaultAudioCue('shot11', 'Picture 12 message', 'Final pose!'),
    countdown3: defaultAudioCue('countdown3', 'Countdown 3', '3'),
    countdown2: defaultAudioCue('countdown2', 'Countdown 2', '2'),
    countdown1: defaultAudioCue('countdown1', 'Countdown 1', '1'),
    button: defaultAudioCue('button', 'Button press sound', '', 'sfx', 'off'),
    shutter: defaultAudioCue('shutter', 'Camera shutter sound', '', 'sfx', 'off'),
    backgroundMusic: defaultAudioCue('backgroundMusic', 'Background music loop', '', 'music', 'off', true)
  }
});

const defaultWorkflowShots = (): WorkflowShotSettings[] => [
  { message: 'Pose challenge!', cameraBeforeMessageMs: 0, messageMs: 1000, cameraBeforeCountdownMs: 2000 },
  { message: 'Next one!', cameraBeforeMessageMs: 0, messageMs: 1000, cameraBeforeCountdownMs: 2000 },
  { message: 'Looking good, now do this!', cameraBeforeMessageMs: 0, messageMs: 1400, cameraBeforeCountdownMs: 2000 },
  { message: 'Last one! Now...', cameraBeforeMessageMs: 0, messageMs: 1200, cameraBeforeCountdownMs: 2000 },
  { message: 'New Pose!', cameraBeforeMessageMs: 0, messageMs: 1000, cameraBeforeCountdownMs: 2000 },
  { message: 'Big Smile!', cameraBeforeMessageMs: 0, messageMs: 1000, cameraBeforeCountdownMs: 2000 },
  { message: 'Something Silly!', cameraBeforeMessageMs: 0, messageMs: 1000, cameraBeforeCountdownMs: 2000 },
  { message: 'Strike A Pose!', cameraBeforeMessageMs: 0, messageMs: 1000, cameraBeforeCountdownMs: 2000 },
  { message: 'One More!', cameraBeforeMessageMs: 0, messageMs: 1000, cameraBeforeCountdownMs: 2000 },
  { message: 'Change It Up!', cameraBeforeMessageMs: 0, messageMs: 1000, cameraBeforeCountdownMs: 2000 },
  { message: 'Almost There!', cameraBeforeMessageMs: 0, messageMs: 1000, cameraBeforeCountdownMs: 2000 },
  { message: 'Final Pose!', cameraBeforeMessageMs: 0, messageMs: 1000, cameraBeforeCountdownMs: 2000 }
];

const migratePoseChallengeMessage = (index: number, message: string) => {
  const legacy = ['Get Ready!', 'Smile!', 'Switch It Up!', 'Final Pose!'];
  const current = defaultWorkflowShots()[index]?.message;
  return current && message.trim().toLowerCase() === legacy[index]?.toLowerCase() ? current : message;
};

const defaultWorkflowSettings = (): AppSettings['workflow'] => ({
  introMessage: "Let's take pictures!",
  introMs: 2000,
  printAutoSelectMs: 20000,
  thankYouMessage: 'THANK YOU!',
  thankYouMs: 3000,
  shots: defaultWorkflowShots()
});

const normalizeWorkflowSettings = (
  workflow?: Partial<AppSettings['workflow']>
): AppSettings['workflow'] => {
  const fallback = defaultWorkflowSettings();
  const sourceShots = workflow?.shots?.length ? workflow.shots : workflow?.photo ? [workflow.photo] : [];
  const { photo: _legacyPhoto, shots: _sourceShots, ...current } = workflow ?? {};
  return {
    ...fallback,
    ...current,
    shots: fallback.shots.map((shot, index) => {
      const source = sourceShots[index] ?? {};
      return { ...shot, ...source, message: migratePoseChallengeMessage(index, source.message ?? shot.message) };
    })
  };
};

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
  cameraSource: 'capture-card',
  canonEnabled: false,
  canonFraming: 'cover',
  mirrorPreview: true,
  poseGuide: normalizePoseGuide(undefined),
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
    designs: []
  },
  workflow: defaultWorkflowSettings(),
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

const eventStoredPath = (eventFolder: string, candidatePath: string) => {
  if (!candidatePath) return '';
  if (candidatePath.startsWith(PROJECT_ASSET_PREFIX)) return candidatePath;
  const projectRelative = path.relative(path.resolve(projectAssetsRoot()), path.resolve(candidatePath));
  if (!projectRelative.startsWith('..') && !path.isAbsolute(projectRelative)) return candidatePath;
  const relative = path.relative(path.resolve(eventFolder), path.resolve(candidatePath));
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? candidatePath : '';
};

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

const normalizeLoadedSettings = (parsed: Partial<AppSettings>, fallback = defaultSettings()): AppSettings => {
  const isLegacyTemplateStyle = (parsed.template?.styleVersion ?? 0) < 2;
  return {
    ...fallback,
    ...parsed,
    defaultPrinter: normalizePrinterName(parsed.defaultPrinter ?? fallback.defaultPrinter),
    beautyFilter: normalizeBeautyFilterSettings(parsed.beautyFilter),
    ai: normalizeAiSettings(parsed.ai),
    audio: normalizeAudioSettings(parsed.audio),
    template: {
      ...fallback.template,
      ...omitRetiredTemplateFields(parsed.template ?? {}),
      styleVersion: 3,
      selectedTemplateId: String(parsed.template?.selectedTemplateId ?? ''),
      selectedStyleId: normalizeTemplateStyleId(String(parsed.template?.selectedStyleId ?? fallback.template.selectedStyleId), isLegacyTemplateStyle),
      layouts: (parsed.template?.layouts ?? []).map((layout) => normalizeTemplateLayout(layout)),
      aiPresets: (parsed.template?.aiPresets ?? fallback.template.aiPresets).map(normalizeAiPreset),
      designs: (parsed.template?.designs ?? fallback.template.designs).map((design) =>
        normalizeTemplateDesign(design, isLegacyTemplateStyle)
      )
    },
    workflow: normalizeWorkflowSettings(parsed.workflow),
    poseGuide: normalizePoseGuide(parsed.poseGuide),
    printPicker: {
      ...fallback.printPicker,
      ...(parsed.printPicker ?? {})
    },
    cameraControls: {
      ...fallback.cameraControls,
      ...(parsed.cameraControls ?? {})
    },
    cameraPreviewOverlay: normalizeCameraPreviewOverlay(parsed.cameraPreviewOverlay),
    cameraSource: parsed.cameraSource === 'canon-usb'
      ? 'canon-usb'
      : parsed.cameraSource === 'capture-card'
        ? 'capture-card'
        : parsed.canonEnabled === true
          ? 'canon-usb'
          : 'capture-card',
    canonEnabled: parsed.canonEnabled === true || parsed.cameraSource === 'canon-usb',
    canonFraming: parsed.canonFraming === 'contain' ? 'contain' : 'cover',
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
};

type LocalSettingsOverlay = Partial<AppSettings> & { layoutPrinters?: Record<string, string> };

const localSettingKeys: Array<keyof AppSettings> = [
  'eventFolder',
  'supabaseUrl',
  'supabasePublishableKey',
  'eventId',
  'boothSecret',
  'cameraId',
  'cameraSource',
  'canonEnabled',
  'canonFraming',
  'cameraRotation',
  'cameraPreviewOverlay',
  'cameraControls',
  'defaultPrinter',
  'stylePrinters',
  'printerEnabled',
  'silentPrint',
  'printCalibration',
  'adminPassword'
];

const readJsonObject = async (filePath: string): Promise<Record<string, unknown>> =>
  JSON.parse(await fs.readFile(filePath, 'utf8')) as Record<string, unknown>;

async function readOptionalJsonObject(filePath: string): Promise<Record<string, unknown>> {
  try {
    return await readJsonObject(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

function mergeSettingsLayers(shared: Partial<AppSettings>, local: LocalSettingsOverlay): Partial<AppSettings> {
  const merged = {
    ...shared,
    ...local,
    ai: {
      ...(shared.ai ?? {}),
      ...(local.ai ?? {}),
      providers: {
        openai: { ...(shared.ai?.providers?.openai ?? {}), ...(local.ai?.providers?.openai ?? {}) },
        gemini: { ...(shared.ai?.providers?.gemini ?? {}), ...(local.ai?.providers?.gemini ?? {}) },
        xai: { ...(shared.ai?.providers?.xai ?? {}), ...(local.ai?.providers?.xai ?? {}) }
      }
    },
    template: {
      ...(shared.template ?? {}),
      ...(local.template ?? {})
    }
  } as Partial<AppSettings>;
  if (merged.template?.layouts && local.layoutPrinters) {
    merged.template.layouts = merged.template.layouts.map((layout) => ({
      ...layout,
      printerName: local.layoutPrinters?.[layout.id] ?? layout.printerName
    }));
  }
  return merged;
}

function splitSettingsLayers(settings: AppSettings) {
  const shared = cloneJson(settings) as AppSettings;
  const local: LocalSettingsOverlay = {};
  const sharedRecord = shared as unknown as Record<string, unknown>;
  const localRecord = local as unknown as Record<string, unknown>;
  for (const key of localSettingKeys) {
    localRecord[key] = cloneJson(settings[key]);
    delete sharedRecord[key];
  }
  local.ai = {
    ...defaultAiSettings(),
    providers: {
      openai: { ...defaultAiSettings().providers.openai, apiKey: settings.ai.providers.openai.apiKey },
      gemini: { ...defaultAiSettings().providers.gemini, apiKey: settings.ai.providers.gemini.apiKey },
      xai: { ...defaultAiSettings().providers.xai, apiKey: settings.ai.providers.xai.apiKey }
    }
  };
  localRecord.ai = {
    providers: {
      openai: { apiKey: settings.ai.providers.openai.apiKey },
      gemini: { apiKey: settings.ai.providers.gemini.apiKey },
      xai: { apiKey: settings.ai.providers.xai.apiKey }
    }
  };
  shared.ai.providers.openai.apiKey = '';
  shared.ai.providers.gemini.apiKey = '';
  shared.ai.providers.xai.apiKey = '';
  local.layoutPrinters = Object.fromEntries(settings.template.layouts.map((layout) => [layout.id, layout.printerName]));
  shared.template.layouts = shared.template.layouts.map((layout) => ({ ...layout, printerName: '' }));
  return { shared, local };
}

async function readSettingsFile(filePath: string): Promise<AppSettings> {
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = mapJsonStrings(JSON.parse(raw) as JsonValue, value => resolveProjectAssetPath(value)) as unknown as Partial<AppSettings>;
  const merged = dropStaleHostVoiceFiles(normalizeLoadedSettings(parsed));
  merged.template.logoPath = eventStoredPath(merged.eventFolder, merged.template.logoPath);
  if ((parsed.template?.styleVersion ?? 0) < 2) await migrateLegacyTemplateFolders(merged.eventFolder);
  await ensureEventFolders(merged.eventFolder);
  return merged;
}

async function readSettings(): Promise<AppSettings> {
  if (isDev) {
    try {
      const shared = mapJsonStrings(await readJsonObject(sharedSettingsPath()) as JsonValue, value => resolveProjectAssetPath(value)) as unknown as Partial<AppSettings>;
      const local = await readOptionalJsonObject(localSettingsPath()) as LocalSettingsOverlay;
      const merged = dropStaleHostVoiceFiles(normalizeLoadedSettings(mergeSettingsLayers(shared, local)));
      merged.template.logoPath = eventStoredPath(merged.eventFolder, merged.template.logoPath);
      await ensureEventFolders(merged.eventFolder);
      return merged;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try {
        const legacy = await readSettingsFile(legacySettingsPath());
        return writeSettings(legacy);
      } catch {
        return writeSettings(defaultSettings());
      }
    }
  }
  try {
    return await readSettingsFile(localSettingsPath());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        return writeSettings(await readSettingsFile(sharedSettingsPath()));
      } catch {
        return writeSettings(defaultSettings());
      }
    }
    console.warn('Could not read settings.json; trying backup.', error);
    try {
      const recovered = await readSettingsFile(settingsBackupPath());
      await writeSettings(recovered);
      return recovered;
    } catch (backupError) {
      console.error('Could not recover settings from backup. Keeping existing settings files untouched.', backupError);
      return defaultSettings();
    }
  }
}

async function writeSettings(settings: AppSettings): Promise<AppSettings> {
  const normalized: AppSettings = {
    ...settings,
    defaultPrinter: normalizePrinterName(settings.defaultPrinter),
    beautyFilter: normalizeBeautyFilterSettings(settings.beautyFilter),
    ai: normalizeAiSettings(settings.ai),
    audio: normalizeAudioSettings(settings.audio),
    workflow: normalizeWorkflowSettings(settings.workflow),
    poseGuide: normalizePoseGuide(settings.poseGuide),
    template: {
      ...omitRetiredTemplateFields(settings.template),
      logoPath: eventStoredPath(settings.eventFolder, settings.template.logoPath),
      styleVersion: 3,
      layouts: (settings.template.layouts ?? []).map(normalizeTemplateLayout),
      aiPresets: settings.template.aiPresets.map(normalizeAiPreset),
      designs: settings.template.designs.map((design) => normalizeTemplateDesign(design))
    },
    stylePrinters: normalizeStylePrinters(settings.stylePrinters),
    printerEnabled: settings.printerEnabled !== false,
    printCalibration: normalizePrintCalibration(settings.printCalibration)
  };
  const cleaned = dropStaleHostVoiceFiles(normalized);
  await ensureEventFolders(cleaned.eventFolder);
  await fs.mkdir(path.dirname(localSettingsPath()), { recursive: true });
  if (isDev) {
    const { shared, local } = splitSettingsLayers(cleaned);
    const portableShared = mapJsonStrings(shared as unknown as JsonValue, value => projectAssetToken(value));
    await fs.mkdir(path.dirname(sharedSettingsPath()), { recursive: true });
    await fs.writeFile(sharedSettingsPath(), `${JSON.stringify(portableShared, null, 2)}${os.EOL}`, 'utf8');
    await fs.writeFile(localSettingsPath(), `${JSON.stringify(local, null, 2)}${os.EOL}`, 'utf8');
  } else {
    const serialized = `${JSON.stringify(cleaned, null, 2)}${os.EOL}`;
    await fs.writeFile(settingsTempPath(), serialized, 'utf8');
    if (await fileExists(localSettingsPath())) {
      await fs.copyFile(localSettingsPath(), settingsBackupPath());
    }
    await fs.rename(settingsTempPath(), localSettingsPath());
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('settings:changed', cleaned);
  }
  scheduleCloudSave();
  return cleaned;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const cloneJson = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const normalizePathForCompare = (value: string) => path.normalize(value).toLowerCase();

const pathStartsWith = (value: string, base: string) => {
  const normalizedValue = normalizePathForCompare(value);
  const normalizedBase = normalizePathForCompare(base);
  return normalizedValue === normalizedBase || normalizedValue.startsWith(`${normalizedBase}${path.sep}`);
};

const portableJoin = (token: string, absolutePath: string, basePath: string) => {
  const relative = path.relative(basePath, absolutePath);
  return relative ? `${token}${path.sep}${relative}` : token;
};

const replacePathPrefixes = (
  value: string,
  replacements: Array<{ base: string; token: string }>
) => {
  const match = replacements
    .filter(({ base }) => base && pathStartsWith(value, base))
    .sort((a, b) => b.base.length - a.base.length)[0];
  return match ? portableJoin(match.token, value, match.base) : value;
};

const mapJsonStrings = (value: JsonValue, mapper: (value: string, key?: string) => string, key?: string): JsonValue => {
  if (typeof value === 'string') return mapper(value, key);
  if (Array.isArray(value)) return value.map((item) => mapJsonStrings(item, mapper));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [entryKey, mapJsonStrings(entryValue, mapper, entryKey)])
    );
  }
  return value;
};

const portableSettingsForExport = (settings: AppSettings): AppSettings => {
  const exported = cloneJson(settings) as unknown as JsonValue;
  const home = app.getPath('home');
  const pictures = app.getPath('pictures');
  const userData = app.getPath('userData');
  const eventFolder = settings.eventFolder;
  return mapJsonStrings(
    exported,
    (value, key) =>
      replacePathPrefixes(
        value,
        key === 'eventFolder'
          ? [
              { base: pictures, token: portableSettingsToken.pictures },
              { base: home, token: portableSettingsToken.home }
            ]
          : [
              { base: eventFolder, token: portableSettingsToken.eventFolder },
              { base: userData, token: portableSettingsToken.appUserData },
              { base: projectAssetsRoot(), token: portableSettingsToken.projectAssets },
              { base: pictures, token: portableSettingsToken.pictures },
              { base: home, token: portableSettingsToken.home }
            ]
      )
  ) as unknown as AppSettings;
};

const expandPortablePath = (value: string, eventFolder: string) => {
  const replacements = [
    { token: portableSettingsToken.eventFolder, base: eventFolder },
    { token: portableSettingsToken.appUserData, base: app.getPath('userData') },
    { token: portableSettingsToken.projectAssets, base: projectAssetsRoot() },
    { token: portableSettingsToken.pictures, base: app.getPath('pictures') },
    { token: portableSettingsToken.home, base: app.getPath('home') }
  ];
  const match = replacements.find(({ token }) => value === token || value.startsWith(`${token}${path.sep}`) || value.startsWith(`${token}/`));
  if (!match) return value;
  const suffix = value.slice(match.token.length).replace(/^[/\\]/, '');
  return suffix ? path.join(match.base, suffix) : match.base;
};

const expandPortableSettingsForImport = (settings: Partial<AppSettings>): Partial<AppSettings> => {
  const imported = cloneJson(settings) as unknown as JsonValue;
  const source = imported as Partial<AppSettings>;
  const eventFolder =
    typeof source.eventFolder === 'string'
      ? expandPortablePath(source.eventFolder, defaultEventFolder())
      : defaultEventFolder();
  const expanded = mapJsonStrings(imported, (value) => expandPortablePath(value, eventFolder)) as unknown as Partial<AppSettings>;
  expanded.eventFolder = eventFolder;
  return expanded;
};

type AppWindowKind = 'guest' | 'admin';

function windowUrl(kind: AppWindowKind, extraQuery = '') {
  const query = `window=${kind}${extraQuery ? `&${extraQuery}` : ''}`;
  return isDev
    ? `${process.env.VITE_DEV_SERVER_URL}?${query}`
    : `file://${path.join(__dirname, '..', 'dist', 'index.html')}?${query}`;
}

async function createWindow(kind: AppWindowKind, extraQuery = '') {
  const isGuestWindow = kind === 'guest';
  const win = new BrowserWindow({
    width: isGuestWindow ? 720 : 1120,
    height: isGuestWindow ? 1280 : 760,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    title: isGuestWindow ? 'Photo Booth' : 'Admin',
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
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[${kind} renderer] stopped: ${details.reason}`);
  });
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

function imageExtensionFromDataUrl(dataUrl: string): '.jpg' | '.png' {
  const mimeType = /^data:([^;,]+)/i.exec(dataUrl)?.[1]?.toLowerCase();
  return mimeType === 'image/jpeg' || mimeType === 'image/jpg' ? '.jpg' : '.png';
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
  const resolved = resolveProjectAssetPath(filePath);
  const buffer = await fs.readFile(resolved);
  const extension = path.extname(resolved).toLowerCase();
  const mimeType = extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : 'image/png';
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

async function audioFileToDataUrl(filePath: string): Promise<string> {
  const resolved = resolveProjectAssetPath(filePath);
  const buffer = await fs.readFile(resolved);
  const extension = path.extname(resolved).toLowerCase();
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

const hasStaleHostVoiceFile = (_settings: AppSettings, cue: AppSettings['audio']['cues'][string]) =>
  cue.mode === 'host' && /[\\/]audio[\\/]generated[\\/](?:kokoro|piper)[\\/]/i.test(cue.filePath);

const dropStaleHostVoiceFiles = (settings: AppSettings): AppSettings => {
  const entries = Object.entries(settings.audio.cues);
  if (!entries.some(([, cue]) => hasStaleHostVoiceFile(settings, cue))) return settings;
  return {
    ...settings,
    audio: {
      ...settings.audio,
      cues: Object.fromEntries(
        entries.map(([id, cue]) => [id, hasStaleHostVoiceFile(settings, cue) ? { ...cue, filePath: '' } : cue])
      )
    }
  };
};

async function getImageSize(filePath: string) {
  const image = nativeImage.createFromPath(resolveProjectAssetPath(filePath));
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

const omitRetiredTemplateFields = (template: object): AppSettings['template'] => {
  const {
    faceAssetPacks: _faceAssetPacks,
    colorFilterExamplePath: _colorFilterExamplePath,
    colorFilterPresetVersion: _colorFilterPresetVersion,
    colorFilterPresets: _colorFilterPresets,
    ...rest
  } = template as Record<string, unknown>;
  return rest as AppSettings['template'];
};

const omitRetiredDesignFields = (design: TemplateDesign): TemplateDesign => {
  const { faceTrackingEnabled: _faceTrackingEnabled, faceAssetPackId: _faceAssetPackId, ...rest } =
    design as TemplateDesign & { faceTrackingEnabled?: boolean; faceAssetPackId?: string };
  return rest;
};

const normalizeTemplateDesign = (design: TemplateDesign, migrateLegacy = false): TemplateDesign => {
  const originalStyleId = String(design.styleId);
  const styleId = normalizeTemplateStyleId(originalStyleId, migrateLegacy);
  const legacyPath = design.filePath ?? '';
  const previewPath = design.previewPath || legacyPath;
  const framePath = design.framePath || legacyPath;
  const templateId = design.templateId || styleId;
  return {
    ...omitRetiredDesignFields(design),
    templateId,
    styleId,
    previewPath: migrateLegacy ? migrateLegacyTemplatePath(previewPath, originalStyleId) : previewPath,
    framePath: migrateLegacy ? migrateLegacyTemplatePath(framePath, originalStyleId) : framePath,
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
      const message = migratePoseChallengeMessage(index, sourceShot.message ?? fallbackShot.message);
      return {
        ...fallbackShot,
        ...sourceShot,
        message,
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
  const sourceWidth = finiteNumber(layout.paperWidth, 0);
  const sourceHeight = finiteNumber(layout.paperHeight, 0);
  const scaleX = sourceWidth > 0 ? dimensions.width / sourceWidth : 1;
  const scaleY = sourceHeight > 0 ? dimensions.height / sourceHeight : 1;
  const photoWindows = (layout.photoWindows ?? []).map((slot, index) => {
    let x = Number.isFinite(slot.x) ? slot.x * scaleX : dimensions.width * 0.1;
    let y = Number.isFinite(slot.y) ? slot.y * scaleY : dimensions.height * 0.1;
    let width = Math.max(1, Number.isFinite(slot.width) ? slot.width * scaleX : dimensions.width / 3);
    let height = Math.max(1, Number.isFinite(slot.height) ? slot.height * scaleY : dimensions.height / 3);
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    if (x + width > dimensions.width) width = Math.max(1, dimensions.width - x);
    if (y + height > dimensions.height) height = Math.max(1, dimensions.height - y);
    return {
      x,
      y,
      width,
      height,
      sourceIndex: index,
      cropY: slot.cropY === 'top' ? 'top' as const : 'center' as const,
      rotation: normalizeRotation(slot.rotation)
    };
  });
  const shotCount = Math.max(1, photoWindows.length);
  const requestedPhotos = Number.isFinite(layout.photosToTake) ? Math.round(layout.photosToTake as number) : shotCount;
  const photosToTake = Math.min(12, Math.max(shotCount, requestedPhotos));
  return {
    ...layout,
    id: layout.id || `template-${Date.now()}`,
    name: layout.name?.trim() || 'Template',
    orientation,
    paperWidth: dimensions.width,
    paperHeight: dimensions.height,
    photoWindows,
    photosToTake,
    active: layout.active !== false,
    guestPreviewPath: layout.guestPreviewPath ?? '',
    workflowDefaults: normalizeTemplateWorkflow(layout.workflowDefaults, photosToTake),
    printerName: normalizePrinterName(layout.printerName ?? ''),
    createdAt: layout.createdAt || new Date().toISOString(),
    updatedAt: layout.updatedAt || new Date().toISOString()
  };
};

const finiteNumber = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

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
    },
    poseGenerator: {
      provider: normalizeAiProvider(settings?.poseGenerator?.provider),
      providers: {
        openai: { ...fallback.poseGenerator.providers.openai, ...(settings?.poseGenerator?.providers?.openai ?? {}) },
        gemini: { ...fallback.poseGenerator.providers.gemini, ...(settings?.poseGenerator?.providers?.gemini ?? {}) },
        xai: { ...fallback.poseGenerator.providers.xai, ...(settings?.poseGenerator?.providers?.xai ?? {}) }
      }
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
    if (id === 'facePack' || cues[id]) return;
    cues[id] = normalizeAudioCue(cue, defaultAudioCue(id, cue.label || id, cue.text || ''));
  });
  const legacyPoseOpenings: Record<string, { old: string; next: string }> = {
    shot0: { old: 'Get ready!', next: 'Pose challenge!' },
    shot1: { old: 'Smile!', next: 'Next one!' },
    shot2: { old: 'Switch it up!', next: 'Looking good, now do this!' },
    shot3: { old: 'Final pose!', next: 'Last one! Now...' }
  };
  Object.entries(legacyPoseOpenings).forEach(([id, wording]) => {
    if (cues[id]?.text.trim().toLowerCase() !== wording.old.toLowerCase()) return;
    cues[id] = { ...cues[id], text: wording.next, filePath: '', updatedAt: '' };
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

const requiredDesignSize = (layout?: TemplateLayout) =>
  templateDimensions(layout?.orientation === 'landscape' ? 'landscape' : 'portrait');

const assertDesignImageSize = async (filePath: string, layout?: TemplateLayout) => {
  const size = await getImageSize(filePath);
  const expected = requiredDesignSize(layout);
  if (size.width !== expected.width || size.height !== expected.height) {
    throw new Error(`Background must be ${expected.width} × ${expected.height}. This file is ${size.width} × ${size.height}.`);
  }
};

const copyTemplateAsset = async (sourcePath: string, designFolder: string, role: TemplateAssetRole, layout?: TemplateLayout) => {
  if (role === 'frame' || role === 'preview') {
    await assertDesignImageSize(sourcePath, layout);
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
  const designFolder = path.join(reusableAssetsFolder(settings, 'templates'), 'custom', request.templateId, `${id}-${safeTemplateName(name)}`);
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

async function saveTemplateSlotPreview(templateId: string, dataUrl: string) {
  assertDataUrl(dataUrl, 'Template thumbnail');
  const settings = await readSettings();
  const layouts = settings.template.layouts.map(normalizeTemplateLayout);
  const layout = layouts.find((item) => item.id === templateId);
  if (!layout) throw new Error('Template layout not found.');
  const folder = path.join(reusableAssetsFolder(settings, 'templates'), 'custom', templateId);
  await fs.mkdir(folder, { recursive: true });
  const targetPath = path.join(folder, 'guest-preview.png');
  await fs.writeFile(targetPath, dataUrlToBuffer(dataUrl));
  return writeSettings({
    ...settings,
    template: {
      ...settings.template,
      layouts: layouts.map((item) =>
        item.id === templateId ? { ...item, guestPreviewPath: targetPath, updatedAt: new Date().toISOString() } : item
      )
    }
  });
}

async function uploadTemplateLayoutPreview(templateId: string) {
  const sourcePath = await chooseTemplateAsset('preview');
  if (!sourcePath) return readSettings();
  const settings = await readSettings();
  const layouts = settings.template.layouts.map(normalizeTemplateLayout);
  const layout = layouts.find((item) => item.id === templateId);
  if (!layout) throw new Error('Template layout not found.');
  const now = new Date().toISOString();
  const extension = path.extname(sourcePath).toLowerCase() || '.png';
  const folder = path.join(reusableAssetsFolder(settings, 'templates'), 'custom', templateId);
  await fs.mkdir(folder, { recursive: true });
  const targetPath = path.join(folder, `guest-preview${extension}`);
  await fs.copyFile(sourcePath, targetPath);
  return writeSettings({
    ...settings,
    template: {
      ...settings.template,
      layouts: layouts.map((item) =>
        item.id === templateId ? { ...item, guestPreviewPath: targetPath, updatedAt: now } : item
      )
    }
  });
}

async function deleteTemplateLayout(templateId: string) {
  const settings = await readSettings();
  const designs = settings.template.designs.map((item) => normalizeTemplateDesign(item));
  const removedDesigns = designs.filter((item) => item.templateId === templateId);
  await fs.rm(path.join(reusableAssetsFolder(settings, 'templates'), 'custom', templateId), { force: true, recursive: true });
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
  const filePath = path.join(reusableAssetsFolder(settings, 'templates'), `${safeTemplateName(layout.name)}-blank-guide.png`);
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
  if (role === 'frame' || role === 'preview') {
    try {
      await assertDesignImageSize(filePath, layout);
    } catch (error) {
      await fs.rm(filePath, { force: true }).catch(() => undefined);
      throw error;
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
  const folder = path.join(reusableAssetsFolder(settings, 'templates'), 'custom', templateId);
  const importedDesigns: TemplateDesign[] = [];
  const activeAiPresetIds = new Set(settings.template.aiPresets.map((preset) => preset.id));

  for (const [index, design] of parsed.designs.entries()) {
    const designId = `design-${Date.now()}-${index}`;
    const designName = design.name?.trim() || `Design ${index + 1}`;
    const designFolder = path.join(folder, `${designId}-${safeTemplateName(designName)}`);
    const frameDataUrl = assertDataUrl(design.frameDataUrl, 'Print frame');
    const previewDataUrl = assertDataUrl(design.previewDataUrl || design.frameDataUrl, 'Preview');
    const framePath = await writeImportedAsset(frameDataUrl, designFolder, 'frame.png', layout, 'frame');
    const previewPath = await writeImportedAsset(previewDataUrl, designFolder, 'preview.png', layout, 'preview');
    const hasAiPreset = Boolean(design.aiPresetId && activeAiPresetIds.has(design.aiPresetId));
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
  const thumbnailBuffer = /\.jpe?g$/i.test(name) ? thumbnail.toJPEG(85) : thumbnail.toPNG();
  await fs.writeFile(path.join(eventFolder, folder, 'thumbs', name), thumbnailBuffer);
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

const VIDEO_TRANSCODE_THREADS = 1;
const VIDEO_UPLOAD_MAX_ATTEMPTS = 3;
const VIDEO_UPLOAD_RETRY_DELAY_MS = 2000;
const VIDEO_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
type VideoTranscodeProfile = { maxLongEdge: number; crf: number; audioBitrate: string };
const VIDEO_TRANSCODE_PROFILES = [
  { maxLongEdge: 1280, crf: 22, audioBitrate: '112k' },
  { maxLongEdge: 960, crf: 25, audioBitrate: '96k' },
  { maxLongEdge: 854, crf: 28, audioBitrate: '64k' },
  { maxLongEdge: 640, crf: 30, audioBitrate: '64k' }
] satisfies VideoTranscodeProfile[];
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const resolveFfmpegPath = () => {
  if (!ffmpegStatic) return '';
  // When packaged, ffmpeg-static lives inside app.asar but the binary must be
  // run from the unpacked copy (configured via electron-builder asarUnpack).
  return ffmpegStatic.replace('app.asar', 'app.asar.unpacked');
};

function transcodeToMp4(inputPath: string, outputPath: string, profile: VideoTranscodeProfile = VIDEO_TRANSCODE_PROFILES[0]) {
  return new Promise<void>((resolve, reject) => {
    const ffmpegPath = resolveFfmpegPath();
    if (!ffmpegPath) {
      reject(new Error('ffmpeg binary not available.'));
      return;
    }
    // Downscale the longer edge to the selected profile (keeping aspect, even
    // dimensions) and encode H.264/AAC with faststart for broad playback.
    const scaleFilter =
      `fps=24,scale='if(gt(a,1),min(${profile.maxLongEdge},iw),-2)':'if(gt(a,1),-2,min(${profile.maxLongEdge},ih))'`;
    const args = [
      '-y',
      '-i', inputPath,
      '-vf', scaleFilter,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', String(profile.crf),
      '-pix_fmt', 'yuv420p',
      '-r', '24',
      '-video_track_timescale', '24000',
      '-tag:v', 'avc1',
      '-c:a', 'aac',
      '-b:a', profile.audioBitrate,
      '-threads', String(VIDEO_TRANSCODE_THREADS),
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

const formatMegabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

async function prepareVideoForUpload(inputPath: string, statusName = path.basename(inputPath)) {
  const initialSize = (await fs.stat(inputPath)).size;
  if (/\.mp4$/i.test(inputPath) && initialSize <= VIDEO_UPLOAD_MAX_BYTES) return inputPath;

  let lastSize = initialSize;
  let lastOutput = '';

  for (let index = 0; index < VIDEO_TRANSCODE_PROFILES.length; index += 1) {
    const profile = VIDEO_TRANSCODE_PROFILES[index];
    const outputPath = path.join(os.tmpdir(), `photo-booth-upload-${Date.now()}-${profile.maxLongEdge}p.mp4`);
    setGalleryUploadStatus({
      state: 'uploading',
      message: `Compressing ${statusName} (${index + 1}/${VIDEO_TRANSCODE_PROFILES.length})...`,
      lastError: undefined
    });
    console.log(
      `[video] transcode profile ${index + 1}/${VIDEO_TRANSCODE_PROFILES.length}: ` +
      `${profile.maxLongEdge}px crf ${profile.crf} audio ${profile.audioBitrate}`
    );
    await transcodeToMp4(inputPath, outputPath, profile);
    if (lastOutput) await fs.rm(lastOutput, { force: true });
    lastOutput = outputPath;
    lastSize = (await fs.stat(outputPath)).size;
    console.log(`[video] compressed upload copy ${lastSize} bytes`);
    if (lastSize <= VIDEO_UPLOAD_MAX_BYTES) return outputPath;
  }

  if (lastOutput) await fs.rm(lastOutput, { force: true });
  throw new Error(`Video is ${formatMegabytes(lastSize)} after compression, over upload limit ${formatMegabytes(VIDEO_UPLOAD_MAX_BYTES)}.`);
}

async function nextVideoName(eventFolder: string) {
  try {
    const entries = await fs.readdir(path.join(eventFolder, 'videos'), { withFileTypes: true });
    const numbers = entries
      .filter((entry) => entry.isFile() && /^\d+\.(mp4|webm)$/i.test(entry.name))
      .map((entry) => Number.parseInt(path.parse(entry.name).name, 10))
      .filter((value) => Number.isFinite(value));
    const nextNumber = numbers.length > 0 ? Math.max(...numbers) + 1 : 1;
    return String(nextNumber);
  } catch {
    return String(Date.now());
  }
}

async function saveSessionVideoData(request: SaveVideoRequest): Promise<SaveVideoResult> {
  const webmPath = path.join(os.tmpdir(), `photo-booth-recording-${Date.now()}.webm`);
  const buffer = Buffer.from(request.data instanceof Uint8Array ? request.data : new Uint8Array(request.data));
  console.log(`[video] received recording ${buffer.byteLength} bytes -> ${webmPath}`);
  await fs.writeFile(webmPath, buffer);
  return { path: webmPath, name: path.basename(webmPath) };
}

async function appendSessionVideoOutro(videoPath: string, finalImagePath: string, logoPath = '') {
  if (!(await fileExists(videoPath))) throw new Error('Session video was not found.');
  if (!(await fileExists(finalImagePath))) throw new Error('Final photo was not found.');
  const usableLogo = logoPath && await fileExists(logoPath) ? logoPath : '';
  const settings = await readSettings();
  await ensureEventFolders(settings.eventFolder);
  const outputPath = path.join(settings.eventFolder, 'videos', `${await nextVideoName(settings.eventFolder)}.mp4`);
  const args = ['-y', '-i', videoPath, '-loop', '1', '-framerate', '24', '-t', '5', '-i', finalImagePath];
  if (usableLogo) args.push('-loop', '1', '-framerate', '24', '-t', '2.5', '-i', usableLogo);

  const canvas = "scale=1080:1920:force_original_aspect_ratio=decrease:flags=lanczos,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1";
  const filters = [
    `[0:v]${canvas},fps=24,setpts=PTS-STARTPTS[v0]`,
    '[1:v]split=2[photoBg][photoFg]',
    '[photoBg]scale=90:160:force_original_aspect_ratio=increase,crop=90:160,gblur=sigma=22,scale=1080:1920:flags=bicubic,eq=brightness=-0.24:saturation=1.15[photoBgReady]',
    '[photoFg]scale=1000:1800:force_original_aspect_ratio=decrease[photoFgReady]',
    `[photoBgReady][photoFgReady]overlay=(W-w)/2:(H-h)/2,zoompan=z='min(zoom+0.00042,1.05)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1080x1920:fps=24,fade=t=in:st=0:d=0.35,fade=t=out:st=4.5:d=0.5,setpts=PTS-STARTPTS[v1]`
  ];
  if (usableLogo) {
    filters.push(
      `[2:v]scale=650:650:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=24,fade=t=in:st=0:d=0.4,fade=t=out:st=2:d=0.5,setpts=PTS-STARTPTS[v2]`,
      '[v0][v1][v2]concat=n=3:v=1:a=0[outv]'
    );
  } else {
    filters.push('[v0][v1]concat=n=2:v=1:a=0[outv]');
  }
  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[outv]', '-map', '0:a?',
    '-af', `apad=pad_dur=${usableLogo ? '7.5' : '5'}`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '16',
    '-pix_fmt', 'yuv420p', '-r', '24', '-video_track_timescale', '24000', '-tag:v', 'avc1',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart', outputPath
  );

  await new Promise<void>((resolve, reject) => {
    const ffmpegPath = resolveFfmpegPath();
    if (!ffmpegPath) return reject(new Error('ffmpeg binary not available.'));
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Could not add video outro (${code}): ${stderr.slice(-700)}`));
    });
  });
  await fs.rm(videoPath, { force: true });
  console.log(`[video] saved ${outputPath}`);
  return outputPath;
}

async function uploadSessionVideoInBackground(
  request: BackgroundVideoUploadRequest
): Promise<BackgroundGalleryUploadResult> {
  galleryUploadStatus.active += 1;
  setGalleryUploadStatus({ state: 'uploading', message: `Preparing ${path.basename(request.videoPath)}...`, lastError: undefined });
  try {
    const settings = await readSettings();
    if (!settings.webApiBaseUrl || !settings.eventId || !settings.boothSecret) {
      throw new Error('Web API, event ID, or booth secret is missing.');
    }
    const uploadPath = await prepareVideoForUpload(request.videoPath);
    const uploadIsTemporary = uploadPath !== request.videoPath;
    const buffer = await fs.readFile(uploadPath);
    if (uploadIsTemporary) await fs.rm(uploadPath, { force: true });
    if (buffer.byteLength > VIDEO_UPLOAD_MAX_BYTES) {
      throw new Error(`Video is ${formatMegabytes(buffer.byteLength)}, over upload limit ${formatMegabytes(VIDEO_UPLOAD_MAX_BYTES)}.`);
    }
    const filename = `${path.parse(request.videoPath).name}.mp4`;
    let lastUploadError: unknown = null;
    for (let attempt = 1; attempt <= VIDEO_UPLOAD_MAX_ATTEMPTS; attempt += 1) {
      setGalleryUploadStatus({
        state: 'uploading',
        message: `Uploading ${filename} (${attempt}/${VIDEO_UPLOAD_MAX_ATTEMPTS})...`,
        lastError: undefined
      });
      try {
        console.log(`[video-upload] POST video ${filename} ${buffer.byteLength} bytes (attempt ${attempt}/${VIDEO_UPLOAD_MAX_ATTEMPTS})`);
        await uploadGalleryBuffer(settings, request.ticketId, {
          kind: 'video',
          filename,
          contentType: 'video/mp4',
          buffer,
          width: 0,
          height: 0,
        });
        lastUploadError = null;
        break;
      } catch (error) {
        lastUploadError = error;
        const message = error instanceof Error ? error.message : 'Video upload failed.';
        console.warn(`[video-upload] attempt ${attempt}/${VIDEO_UPLOAD_MAX_ATTEMPTS} failed`, message);
        if (attempt < VIDEO_UPLOAD_MAX_ATTEMPTS) {
          setGalleryUploadStatus({
            state: 'uploading',
            message: `Video upload failed. Retrying ${attempt + 1}/${VIDEO_UPLOAD_MAX_ATTEMPTS}...`,
            lastError: message
          });
          await sleep(VIDEO_UPLOAD_RETRY_DELAY_MS * attempt);
        }
      }
    }
    if (lastUploadError) throw lastUploadError;
    console.log(`[video-upload] uploaded ${path.basename(uploadPath)}`);
    galleryUploadStatus.active = Math.max(0, galleryUploadStatus.active - 1);
    setGalleryUploadStatus({
      state: galleryUploadStatus.active > 0 ? 'uploading' : 'done',
      message: `Uploaded ${path.basename(uploadPath)}.`,
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
  const name = await photoName(settings.eventFolder, imageExtensionFromDataUrl(request.dataUrl));
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
  const folder = path.join(reusableAssetsFolder(settings, 'ai-presets'), presetId);
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
  const targetPath = path.join(reusableAssetsFolder(settings, 'audio'), `${safeAudioCueId(cueId)}-${Date.now()}${extension}`);
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
  const targetPath = path.join(reusableAssetsFolder(settings, 'audio'), 'template-cues', `${safeAudioCueId(cue.id)}-${Date.now()}${extension}`);
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
  if (!audio.enableHostVoice) return { ok: false, settings, cue: normalizedCue, error: 'Generated voice is disabled.' };
  try {
    const generated = await generateElevenLabsSpeech(safeAudioCueId(normalizedCue.id), text, path.join(reusableAssetsFolder(settings, 'audio'), 'generated', 'elevenlabs'));
    const generatedPath = generated.filePath;
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
    return { ok: false, settings, cue: normalizedCue, error: error instanceof Error ? error.message : 'ElevenLabs generation failed.' };
  }
}

async function generateHostVoiceCue(cueId: string): Promise<HostVoiceGenerateResult> {
  const settings = await readSettings();
  const audio = normalizeAudioSettings(settings.audio);
  const cue = audio.cues[cueId];
  if (!cue) return { ok: false, settings, error: 'Audio cue not found.' };
  const text = cue.text.trim();
  if (!text) return { ok: false, settings, error: 'Cue text is empty.' };
  if (!audio.enableHostVoice) return { ok: false, settings, error: 'Generated voice is disabled.' };
  try {
    const generated = await generateElevenLabsSpeech(safeAudioCueId(cue.id), text, path.join(reusableAssetsFolder(settings, 'audio'), 'generated', 'elevenlabs'));
    const generatedPath = generated.filePath;
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
    return { ok: false, settings, error: error instanceof Error ? error.message : 'ElevenLabs generation failed.' };
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

async function photoName(eventFolder: string, extension: '.jpg' | '.png') {
  const readNumericNames = async (folder: string) => {
    try {
      const entries = await fs.readdir(path.join(eventFolder, folder), { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && /^\d+\.(?:png|jpe?g)$/i.test(entry.name))
        .map((entry) => Number.parseInt(path.parse(entry.name).name, 10))
        .filter((value) => Number.isFinite(value));
    } catch {
      return [];
    }
  };
  const numbers = [...(await readNumericNames('originals')), ...(await readNumericNames('finals'))];
  const nextNumber = numbers.length > 0 ? Math.max(...numbers) + 1 : 1;
  return `${nextNumber}${extension}`;
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
  const pageSize = isLandscape ? '6in 4in' : '4in 6in';
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

type StoredCloudSyncState = {
  profileId: string;
  cloudRevision: number;
  localFingerprint: string;
  lastSyncedAt: string;
};

let cloudSyncStatus: CloudSyncStatus = {
  state: 'idle',
  message: 'Cloud sync is ready.'
};
let cloudSyncRunning: Promise<CloudSyncStatus> | null = null;
let cloudSaveDelay: NodeJS.Timeout | null = null;
let applyingCloudSettings = false;

function publishCloudSyncStatus(status: CloudSyncStatus) {
  cloudSyncStatus = status;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('cloud-sync:status', status);
  }
  return status;
}

async function readCloudSyncState(): Promise<StoredCloudSyncState | null> {
  try {
    return JSON.parse(await fs.readFile(cloudSyncStatePath(), 'utf8')) as StoredCloudSyncState;
  } catch {
    return null;
  }
}

async function writeCloudSyncState(state: StoredCloudSyncState) {
  await fs.writeFile(cloudSyncStatePath(), `${JSON.stringify(state, null, 2)}${os.EOL}`, 'utf8');
}

async function performCloudSync(): Promise<CloudSyncStatus> {
  const local = await readSettings();
  if (!cloudSyncConfigured(local)) {
    return publishCloudSyncStatus({
      state: 'error',
      message: 'Add the Supabase URL, publishable key, Event ID, and booth secret before syncing.'
    });
  }

  publishCloudSyncStatus({ state: 'syncing', message: 'Syncing event settings, templates, and poses…' });
  try {
    const localPoses = (await listStoredPoses()).poses;
    const profileId = cloudProfileId(local);
    const stored = await readCloudSyncState();
    const state = stored?.profileId === profileId ? stored : null;
    const remote = await fetchCloudSnapshot(local);
    const localFingerprint = cloudFingerprint(local, localPoses);

    if (!remote) {
      const pushed = await pushCloudSnapshot(local, localPoses);
      const lastSyncedAt = pushed.updated_at || new Date().toISOString();
      await writeCloudSyncState({ profileId, cloudRevision: pushed.revision, localFingerprint, lastSyncedAt });
      return publishCloudSyncStatus({ state: 'synced', message: 'Cloud profile created from this computer.', lastSyncedAt });
    }

    if (!state) {
      const materialized = await applyCloudSnapshot(local, remote.payload);
      const cloudPoses = await applyCloudPoseLibrary(local, remote.payload);
      if (cloudPoses) await replaceStoredPoses(cloudPoses);
      applyingCloudSettings = true;
      const saved = await writeSettings(normalizeLoadedSettings(materialized, local));
      applyingCloudSettings = false;
      const lastSyncedAt = remote.updated_at || new Date().toISOString();
      await writeCloudSyncState({ profileId, cloudRevision: remote.revision, localFingerprint: cloudFingerprint(saved, cloudPoses ?? localPoses), lastSyncedAt });
      return publishCloudSyncStatus({ state: 'synced', message: 'Downloaded the shared event profile.', lastSyncedAt });
    }

    const localChanged = localFingerprint !== state.localFingerprint;
    const cloudChanged = remote.revision !== state.cloudRevision;
    if (cloudChanged) {
      const materialized = await applyCloudSnapshot(local, remote.payload);
      const cloudPoses = await applyCloudPoseLibrary(local, remote.payload);
      if (cloudPoses) await replaceStoredPoses(cloudPoses);
      applyingCloudSettings = true;
      const saved = await writeSettings(normalizeLoadedSettings(materialized, local));
      applyingCloudSettings = false;
      const lastSyncedAt = remote.updated_at || new Date().toISOString();
      await writeCloudSyncState({ profileId, cloudRevision: remote.revision, localFingerprint: cloudFingerprint(saved, cloudPoses ?? localPoses), lastSyncedAt });
      return publishCloudSyncStatus({ state: 'synced', message: 'Downloaded changes from another computer.', lastSyncedAt });
    }

    if (localChanged) {
      const pushed = await pushCloudSnapshot(local, localPoses);
      const lastSyncedAt = pushed.updated_at || new Date().toISOString();
      await writeCloudSyncState({ profileId, cloudRevision: pushed.revision, localFingerprint, lastSyncedAt });
      return publishCloudSyncStatus({ state: 'synced', message: cloudChanged ? 'Synced this computer’s newer changes.' : 'Uploaded local changes.', lastSyncedAt });
    }

    const lastSyncedAt = remote.updated_at || state.lastSyncedAt;
    await writeCloudSyncState({ ...state, cloudRevision: remote.revision, lastSyncedAt });
    return publishCloudSyncStatus({ state: 'synced', message: 'Everything is up to date.', lastSyncedAt });
  } catch (error) {
    applyingCloudSettings = false;
    const message = error instanceof Error ? error.message : String(error);
    return publishCloudSyncStatus({ state: 'error', message: `Cloud sync failed: ${message}` });
  }
}

async function performCloudSave(): Promise<CloudSyncStatus> {
  const local = await readSettings();
  if (!cloudSyncConfigured(local)) return cloudSyncStatus;

  publishCloudSyncStatus({ state: 'syncing', message: 'Saving changes to the cloud…' });
  try {
    const localPoses = (await listStoredPoses()).poses;
    const profileId = cloudProfileId(local);
    const stored = await readCloudSyncState();
    const state = stored?.profileId === profileId ? stored : null;
    const remote = await fetchCloudSnapshot(local);
    const localFingerprint = cloudFingerprint(local, localPoses);

    if (remote && (!state || remote.revision !== state.cloudRevision)) {
      return publishCloudSyncStatus({
        state: 'error',
        message: 'Another computer has newer cloud changes. Press Sync now before editing further.'
      });
    }
    if (state && localFingerprint === state.localFingerprint) {
      return publishCloudSyncStatus({ state: 'synced', message: 'Everything is saved to the cloud.', lastSyncedAt: state.lastSyncedAt });
    }

    const pushed = await pushCloudSnapshot(local, localPoses);
    const lastSyncedAt = pushed.updated_at || new Date().toISOString();
    await writeCloudSyncState({ profileId, cloudRevision: pushed.revision, localFingerprint, lastSyncedAt });
    return publishCloudSyncStatus({ state: 'synced', message: 'Changes saved to the cloud.', lastSyncedAt });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return publishCloudSyncStatus({ state: 'error', message: `Cloud save failed: ${message}` });
  }
}

function runCloudSync() {
  if (cloudSyncRunning) return cloudSyncRunning;
  cloudSyncRunning = performCloudSync().finally(() => { cloudSyncRunning = null; });
  return cloudSyncRunning;
}

function scheduleCloudSave() {
  if (!app.isReady() || applyingCloudSettings) return;
  if (cloudSaveDelay) clearTimeout(cloudSaveDelay);
  cloudSaveDelay = setTimeout(() => {
    cloudSaveDelay = null;
    if (cloudSyncRunning) {
      scheduleCloudSave();
      return;
    }
    cloudSyncRunning = performCloudSave().finally(() => { cloudSyncRunning = null; });
  }, 1200);
}

app.whenReady().then(async () => {
  registerPoseStorage(scheduleCloudSave);
  registerPoseAi(readSettings);
  await readSettings();

  // Allow the guest renderer to capture its own window (composite video) and
  // microphone via getDisplayMedia/getUserMedia without showing a picker.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ['window', 'screen'] })
        .then((sources) => {
          const guestSourceId = guestWindow?.getMediaSourceId();
          const match = guestSourceId ? sources.find((source) => source.id === guestSourceId) : undefined;
          if (!match) console.warn('[video] guest window capture source not found.');
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
  ipcMain.handle('cloud-sync:status', () => cloudSyncStatus);
  ipcMain.handle('cloud-sync:now', () => runCloudSync());
  ipcMain.handle('settings:update', async (_event, partial: Partial<AppSettings>) => {
    const current = await readSettings();
    const next: AppSettings = {
      ...current,
      ...partial,
      poseGuide: normalizePoseGuide({ ...current.poseGuide, ...partial.poseGuide }),
      ai: normalizeAiSettings({
        ...current.ai,
        ...(partial.ai ?? {}),
        providers: {
          openai: { ...current.ai.providers.openai, ...(partial.ai?.providers?.openai ?? {}) },
          gemini: { ...current.ai.providers.gemini, ...(partial.ai?.providers?.gemini ?? {}) },
          xai: { ...current.ai.providers.xai, ...(partial.ai?.providers?.xai ?? {}) }
        },
        poseGenerator: {
          ...current.ai.poseGenerator,
          ...(partial.ai?.poseGenerator ?? {}),
          providers: {
            openai: { ...current.ai.poseGenerator.providers.openai, ...(partial.ai?.poseGenerator?.providers?.openai ?? {}) },
            gemini: { ...current.ai.poseGenerator.providers.gemini, ...(partial.ai?.poseGenerator?.providers?.gemini ?? {}) },
            xai: { ...current.ai.poseGenerator.providers.xai, ...(partial.ai?.poseGenerator?.providers?.xai ?? {}) }
          }
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
        ...omitRetiredTemplateFields(current.template),
        ...omitRetiredTemplateFields(partial.template ?? {}),
        layouts: (partial.template?.layouts ?? current.template.layouts).map(normalizeTemplateLayout),
        aiPresets: (partial.template?.aiPresets ?? current.template.aiPresets).map(normalizeAiPreset),
        designs: (partial.template?.designs ?? current.template.designs).map((design) => normalizeTemplateDesign(design))
      },
      workflow: normalizeWorkflowSettings({
        ...current.workflow,
        ...(partial.workflow ?? {}),
        shots: partial.workflow?.shots ?? current.workflow.shots
      }),
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
  ipcMain.handle('settings:export', async () => {
    const current = await readSettings();
    const parent = modalParent();
    const options = {
      defaultPath: path.join(current.eventFolder || defaultEventFolder(), 'settings.json'),
      filters: [{ name: 'Photo Booth Settings', extensions: ['json'] }]
    };
    const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { ok: false, error: 'Export cancelled.' };
    const portable = portableSettingsForExport(current);
    await fs.writeFile(result.filePath, `${JSON.stringify(portable, null, 2)}${os.EOL}`, 'utf8');
    return { ok: true, filePath: result.filePath };
  });
  ipcMain.handle('settings:import', async () => {
    const parent = modalParent();
    const options = {
      properties: ['openFile'] as Array<'openFile'>,
      filters: [{ name: 'Photo Booth Settings', extensions: ['json'] }]
    };
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return { ok: false, error: 'Import cancelled.' };
    const raw = await fs.readFile(result.filePaths[0], 'utf8');
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    const expanded = expandPortableSettingsForImport(parsed);
    const normalized = normalizeLoadedSettings(expanded);
    const saved = await writeSettings(normalized);
    return { ok: true, filePath: result.filePaths[0], settings: saved };
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
  ipcMain.handle('event:upload-idle-logo', async () => {
    const parent = modalParent();
    const options = {
      properties: ['openFile'] as Array<'openFile'>,
      filters: [{ name: 'Logo Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
    };
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    const sourcePath = result.canceled ? '' : result.filePaths[0] ?? '';
    if (!sourcePath) return null;

    const settings = await readSettings();
    const brandingFolder = reusableAssetsFolder(settings, 'branding');
    await fs.mkdir(brandingFolder, { recursive: true });
    const extension = path.extname(sourcePath).toLowerCase() || '.png';
    const targetPath = path.join(brandingFolder, `idle-logo-${Date.now()}${extension}`);
    await fs.copyFile(sourcePath, targetPath);
    return writeSettings({
      ...settings,
      template: { ...settings.template, logoPath: targetPath }
    });
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
  ipcMain.handle('template-layout:upload-preview', async (_event, templateId: string) => uploadTemplateLayoutPreview(templateId));
  ipcMain.handle('template-layout:save-slot-preview', async (_event, templateId: string, dataUrl: string) =>
    saveTemplateSlotPreview(templateId, dataUrl)
  );
  ipcMain.handle('template-layout:delete', async (_event, templateId: string) => deleteTemplateLayout(templateId));
  ipcMain.handle('template-layout:export', async (_event, templateId: string) => exportTemplatePackage(templateId));
  ipcMain.handle('template-layout:import', async () => importTemplatePackage());
  ipcMain.handle('template:update-asset', async (_event, designId: string, role: TemplateAssetRole) => updateTemplateAsset(designId, role));
  ipcMain.handle('template:delete', async (_event, designId: string) => deleteTemplate(designId));
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
  ipcMain.handle('window:preview-pose', async (_event, preview: unknown) => {
    pendingPosePreview = preview;
    if (guestWindow) {
      guestWindow.show();
      guestWindow.focus();
      guestWindow.webContents.send('guest:preview-pose', preview);
      return true;
    }
    await createWindow('guest', 'preview=pose');
    return true;
  });
  ipcMain.handle('guest:take-pose-preview', () => {
    const preview = pendingPosePreview;
    pendingPosePreview = null;
    return preview;
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
  ipcMain.handle('guest:set-camera-paused', (_event, paused: boolean) => {
    guestWindow?.webContents.send('guest:camera-paused', Boolean(paused));
    return true;
  });
  ipcMain.handle('printers:list', async () => {
    const win = adminWindow ?? guestWindow;
    return win ? win.webContents.getPrintersAsync() : [];
  });
  ipcMain.handle('image:save', async (_event, request: SaveImageRequest): Promise<SaveImageResult> => {
    return saveImageData(request);
  });
  ipcMain.handle('canon:connect', () => connectCanon());
  ipcMain.handle('canon:live-frame', () => getCanonLiveViewFrame());
  ipcMain.handle('canon:prepare-capture', () => prepareCanonCapture());
  ipcMain.handle('canon:release-focus', () => releaseCanonFocus());
  ipcMain.handle('canon:capture', async (_event, crop: CanonStillCrop) => {
    const captured = await captureCanonStill(crop);
    const dataUrl = await imageFileToDataUrl(captured.path);
    await fs.unlink(captured.path).catch(() => undefined);
    return { dataUrl, width: captured.width, height: captured.height };
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
  ipcMain.handle('video:append-outro', async (_event, request: { videoPath: string; finalImagePath: string; logoPath?: string }) => {
    const outputPath = await appendSessionVideoOutro(request.videoPath, request.finalImagePath, request.logoPath ?? '');
    return { path: outputPath, name: path.basename(outputPath) };
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

app.on('will-quit', () => {
  if (cloudSaveDelay) clearTimeout(cloudSaveDelay);
  stopCanonService();
});
