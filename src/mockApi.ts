import { createBlankTemplateLayout, normalizeTemplateLayoutForClient } from './template';
import type { AiQueueItem, AppSettings, AudioCue, Gallery, SaveImageRequest, SaveImageResult, TemplateLayout } from './types';

const fallbackSettings: AppSettings = {
  eventName: 'PHOTO BOOTH',
  eventFolder: 'Browser preview',
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
    style4: 'DS-RX1-HalfCut'
  },
  printerEnabled: true,
  silentPrint: false,
  adminPassword: '',
  beautyFilter: {
    enabledMode: 'print',
    previewTimeoutMs: 30000
  },
  ai: {
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
  },
  audio: {
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
      welcome: { id: 'welcome', label: 'Welcome idle loop', mode: 'host', channel: 'voice', text: 'Welcome. Touch start to begin.', filePath: '', loop: true, volume: 1, enabled: true, updatedAt: '' },
      style: { id: 'style', label: 'Choose style screen', mode: 'host', channel: 'voice', text: 'Please choose a style.', filePath: '', loop: false, volume: 1, enabled: true, updatedAt: '' },
      design: { id: 'design', label: 'Choose design screen', mode: 'host', channel: 'voice', text: 'Please choose a design.', filePath: '', loop: false, volume: 1, enabled: true, updatedAt: '' },
      intro: { id: 'intro', label: 'Intro screen', mode: 'host', channel: 'voice', text: "Let's take pictures.", filePath: '', loop: false, volume: 1, enabled: true, updatedAt: '' },
      select: { id: 'select', label: 'Photo selection screen', mode: 'host', channel: 'voice', text: 'Please choose your favorite pictures to print.', filePath: '', loop: false, volume: 1, enabled: true, updatedAt: '' },
      thanks: { id: 'thanks', label: 'Finish screen', mode: 'host', channel: 'voice', text: 'Thank you. Please pick up your print.', filePath: '', loop: false, volume: 1, enabled: true, updatedAt: '' },
      shot0: { id: 'shot0', label: 'Picture 1 message', mode: 'host', channel: 'voice', text: 'Get ready!', filePath: '', loop: false, volume: 1, enabled: true, updatedAt: '' },
      shot1: { id: 'shot1', label: 'Picture 2 message', mode: 'host', channel: 'voice', text: 'Smile!', filePath: '', loop: false, volume: 1, enabled: true, updatedAt: '' },
      shot2: { id: 'shot2', label: 'Picture 3 message', mode: 'host', channel: 'voice', text: 'Switch it up!', filePath: '', loop: false, volume: 1, enabled: true, updatedAt: '' },
      shot3: { id: 'shot3', label: 'Picture 4 message', mode: 'host', channel: 'voice', text: 'Final pose!', filePath: '', loop: false, volume: 1, enabled: true, updatedAt: '' },
      countdown3: { id: 'countdown3', label: 'Countdown 3', mode: 'host', channel: 'voice', text: '3', filePath: '', loop: false, volume: 1, enabled: true, updatedAt: '' },
      countdown2: { id: 'countdown2', label: 'Countdown 2', mode: 'host', channel: 'voice', text: '2', filePath: '', loop: false, volume: 1, enabled: true, updatedAt: '' },
      countdown1: { id: 'countdown1', label: 'Countdown 1', mode: 'host', channel: 'voice', text: '1', filePath: '', loop: false, volume: 1, enabled: true, updatedAt: '' },
      button: { id: 'button', label: 'Button press sound', mode: 'off', channel: 'sfx', text: '', filePath: '', loop: false, volume: 1, enabled: true, updatedAt: '' },
      shutter: { id: 'shutter', label: 'Camera shutter sound', mode: 'off', channel: 'sfx', text: '', filePath: '', loop: false, volume: 1, enabled: true, updatedAt: '' },
      backgroundMusic: { id: 'backgroundMusic', label: 'Background music loop', mode: 'off', channel: 'music', text: '', filePath: '', loop: true, volume: 1, enabled: true, updatedAt: '' }
    }
  },
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
    colorFilterPresets: [
      { id: 'golden-hour-glow', name: 'Golden Hour Glow', active: true, thumbnailPath: '', filter: { intensity: 75, brightness: 8, contrast: 12, saturation: 10, warmth: 22, tint: 4, hue: 2, fade: 5, highlights: -10, shadows: 8, vignette: 12, blur: 0 }, createdAt: '', updatedAt: '' },
      { id: 'clean-bright-blogger', name: 'Clean Bright Blogger', active: true, thumbnailPath: '', filter: { intensity: 60, brightness: 18, contrast: 5, saturation: 6, warmth: 4, tint: 0, hue: 0, fade: 3, highlights: -18, shadows: 14, vignette: 4, blur: 0 }, createdAt: '', updatedAt: '' },
      { id: 'moody-street', name: 'Moody Street', active: true, thumbnailPath: '', filter: { intensity: 80, brightness: -6, contrast: 24, saturation: -8, warmth: -6, tint: 3, hue: -2, fade: 12, highlights: -22, shadows: -10, vignette: 20, blur: 0 }, createdAt: '', updatedAt: '' },
      { id: 'soft-pastel-dream', name: 'Soft Pastel Dream', active: true, thumbnailPath: '', filter: { intensity: 65, brightness: 12, contrast: -10, saturation: -12, warmth: 6, tint: 8, hue: 1, fade: 25, highlights: -12, shadows: 18, vignette: 6, blur: 2 }, createdAt: '', updatedAt: '' },
      { id: 'vintage-film', name: 'Vintage Film', active: true, thumbnailPath: '', filter: { intensity: 85, brightness: -2, contrast: 10, saturation: -6, warmth: 14, tint: 6, hue: 3, fade: 30, highlights: -20, shadows: 10, vignette: 18, blur: 1 }, createdAt: '', updatedAt: '' },
      { id: 'cool-urban-blue', name: 'Cool Urban Blue', active: true, thumbnailPath: '', filter: { intensity: 70, brightness: 4, contrast: 16, saturation: -4, warmth: -18, tint: -6, hue: -5, fade: 8, highlights: 0, shadows: 0, vignette: 0, blur: 0 }, createdAt: '', updatedAt: '' }
    ],
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
};

const settingsKey = 'preview-settings';
const gallery: Gallery = { originals: [], finals: [] };
const aiQueue: AiQueueItem[] = [];
let photoSequence = 0;

const normalizePrinterName = (printerName = '') =>
  printerName === 'DS-RX1-HaflCut' ? 'DS-RX1-HalfCut' : printerName;

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

const normalizeCameraPreviewOverlay = (value: unknown): AppSettings['cameraPreviewOverlay'] => {
  if (value === 'style1' || value === 'style2' || value === 'style3' || value === 'style4') return value;
  if (value === 'portrait-tv') return 'style1';
  if (value === 'landscape') return 'style2';
  return 'none';
};

export function installMockApi() {
  if (window.photoBooth) return;

  const readSettings = (): AppSettings => {
    const raw = window.localStorage.getItem(settingsKey);
    if (!raw) return fallbackSettings;
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      ...fallbackSettings,
      ...parsed,
      ai: {
        ...fallbackSettings.ai,
        ...(parsed.ai ?? {}),
        thinkingLevel:
          parsed.ai?.thinkingLevel === 'none' || parsed.ai?.thinkingLevel === 'medium' || parsed.ai?.thinkingLevel === 'high'
            ? parsed.ai.thinkingLevel
            : 'low',
        providers: {
          openai: { ...fallbackSettings.ai.providers.openai, ...(parsed.ai?.providers?.openai ?? {}) },
          gemini: { ...fallbackSettings.ai.providers.gemini, ...(parsed.ai?.providers?.gemini ?? {}) },
          xai: { ...fallbackSettings.ai.providers.xai, ...(parsed.ai?.providers?.xai ?? {}) }
        }
      },
      audio: {
        ...fallbackSettings.audio,
        ...(parsed.audio ?? {}),
        cues: {
          ...fallbackSettings.audio.cues,
          ...(parsed.audio?.cues ?? {})
        }
      },
      template: {
        ...fallbackSettings.template,
        ...(parsed.template ?? {}),
        styleVersion: 3,
        selectedTemplateId: parsed.template?.selectedTemplateId ?? '',
        layouts: (parsed.template?.layouts ?? []).map((layout) => normalizeTemplateLayoutForClient(layout)),
        faceAssetPacks: parsed.template?.faceAssetPacks ?? fallbackSettings.template.faceAssetPacks,
        designs: (parsed.template?.designs ?? fallbackSettings.template.designs).map((design) => ({
          ...design,
          templateId: design.templateId ?? design.styleId ?? '',
          faceTrackingEnabled: Boolean(design.faceTrackingEnabled),
          faceAssetPackId: design.faceAssetPackId ?? '',
          videoRecordingEnabled: Boolean(design.videoRecordingEnabled),
          workflowOverrideEnabled: Boolean(design.workflowOverrideEnabled)
        }))
      },
      workflow: {
        ...fallbackSettings.workflow,
        ...(parsed.workflow ?? {}),
        shots: fallbackSettings.workflow.shots.map((shot, index) => ({
          ...shot,
          ...(parsed.workflow?.shots?.[index] ?? {})
        }))
      },
      printPicker: { ...fallbackSettings.printPicker, ...(parsed.printPicker ?? {}) },
      cameraControls: { ...fallbackSettings.cameraControls, ...(parsed.cameraControls ?? {}) },
      cameraPreviewOverlay: normalizeCameraPreviewOverlay((parsed as { cameraPreviewOverlay?: unknown }).cameraPreviewOverlay),
      stylePrinters: normalizeStylePrinters({ ...fallbackSettings.stylePrinters, ...(parsed.stylePrinters ?? {}) }),
      printCalibration: normalizePrintCalibration({ ...fallbackSettings.printCalibration, ...(parsed.printCalibration ?? {}) })
    };
  };

  const writeSettings = (settings: AppSettings) => {
    const normalized = {
      ...settings,
      defaultPrinter: normalizePrinterName(settings.defaultPrinter),
      stylePrinters: normalizeStylePrinters(settings.stylePrinters),
      printCalibration: normalizePrintCalibration(settings.printCalibration)
    };
    window.localStorage.setItem(settingsKey, JSON.stringify(normalized));
    return normalized;
  };

  window.photoBooth = {
    getSettings: async () => readSettings(),
    updateSettings: async (partial: Partial<AppSettings>) => {
      const current = readSettings();
      return writeSettings({
        ...current,
        ...partial,
        template: { ...current.template, ...(partial.template ?? {}) },
        ai: {
          ...current.ai,
          ...(partial.ai ?? {}),
          providers: {
            openai: { ...current.ai.providers.openai, ...(partial.ai?.providers?.openai ?? {}) },
            gemini: { ...current.ai.providers.gemini, ...(partial.ai?.providers?.gemini ?? {}) },
            xai: { ...current.ai.providers.xai, ...(partial.ai?.providers?.xai ?? {}) }
          }
        },
        audio: {
          ...current.audio,
          ...(partial.audio ?? {}),
          cues: {
            ...current.audio.cues,
            ...(partial.audio?.cues ?? {})
          }
        },
        workflow: {
          ...current.workflow,
          ...(partial.workflow ?? {}),
          shots: partial.workflow?.shots ?? current.workflow.shots
        },
        printPicker: { ...current.printPicker, ...(partial.printPicker ?? {}) },
        cameraControls: { ...current.cameraControls, ...(partial.cameraControls ?? {}) },
        cameraPreviewOverlay:
          partial.cameraPreviewOverlay === undefined
            ? current.cameraPreviewOverlay
            : normalizeCameraPreviewOverlay((partial as { cameraPreviewOverlay?: unknown }).cameraPreviewOverlay),
        stylePrinters: { ...current.stylePrinters, ...(partial.stylePrinters ?? {}) },
        printCalibration: normalizePrintCalibration({ ...current.printCalibration, ...(partial.printCalibration ?? {}) })
      });
    },
    exportSettings: async () => ({ ok: false, error: 'Settings export is available in Electron.' }),
    importSettings: async () => ({ ok: false, error: 'Settings import is available in Electron.' }),
    chooseFolder: async () => {
      const picker = (window as Window & { showDirectoryPicker?: () => Promise<{ name: string }> }).showDirectoryPicker;
      if (!picker) return 'Browser preview - open Electron for native folder picker';
      try {
        const handle = await picker();
        return `Browser preview - ${handle.name}`;
      } catch {
        return '';
      }
    },
    chooseImage: async () => '',
    uploadAudioCue: async () => readSettings(),
    removeAudioCue: async () => readSettings(),
    uploadTemplateAudioCue: async (cue: AudioCue) => cue,
    removeTemplateAudioCue: async (cue: AudioCue) => ({ ...cue, mode: 'off', filePath: '', updatedAt: new Date().toISOString() }),
    generateHostVoiceCue: async () => ({ ok: false, settings: readSettings(), error: 'Host voice generation is only available in Electron.' }),
    generateTemplateHostVoiceCue: async (cue: AudioCue) => ({
      ok: true,
      settings: readSettings(),
      cue: { ...cue, mode: 'host', filePath: `Browser preview - ${cue.id}.wav`, updatedAt: new Date().toISOString() },
      generatedPath: `Browser preview - ${cue.id}.wav`
    }),
    generateAllHostVoiceCues: async () => ({ ok: false, settings: readSettings(), error: 'Host voice generation is only available in Electron.' }),
    uploadTemplate: async (request) => {
      const current = readSettings();
      const layout = current.template.layouts.find((item) => item.id === request.templateId);
      if (!layout) return null;
      const design = {
        id: `design-${Date.now()}`,
        templateId: request.templateId,
        name: request.name || 'Browser Preview Design',
        previewPath: '',
        framePath: '',
        active: true,
        usesAi: false,
        aiPresetId: '',
        faceTrackingEnabled: false,
        faceAssetPackId: '',
        videoRecordingEnabled: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      writeSettings({
        ...current,
        template: {
          ...current.template,
          selectedTemplateId: request.templateId,
          selectedDesignId: design.id,
          designs: [...current.template.designs, design]
        }
      });
      return design;
    },
    deleteTemplate: async (designId) => {
      const current = readSettings();
      writeSettings({
        ...current,
        template: {
          ...current.template,
          designs: current.template.designs.filter((design) => design.id !== designId)
        }
      });
      return true;
    },
    updateTemplate: async (design) => {
      const current = readSettings();
      writeSettings({
        ...current,
        template: {
          ...current.template,
          designs: current.template.designs.map((item) => (item.id === design.id ? design : item))
        }
      });
      return design;
    },
    updateTemplateLayout: async (layout) => {
      const current = readSettings();
      const normalized = normalizeTemplateLayoutForClient(layout);
      const layouts = current.template.layouts.some((item) => item.id === normalized.id)
        ? current.template.layouts.map((item) => (item.id === normalized.id ? normalized : item))
        : [...current.template.layouts, normalized];
      return writeSettings({
        ...current,
        template: { ...current.template, selectedTemplateId: normalized.id, layouts }
      });
    },
    deleteTemplateLayout: async (templateId) => {
      const current = readSettings();
      return writeSettings({
        ...current,
        template: {
          ...current.template,
          selectedTemplateId: current.template.selectedTemplateId === templateId ? '' : current.template.selectedTemplateId,
          layouts: current.template.layouts.filter((layout) => layout.id !== templateId),
          designs: current.template.designs.filter((design) => design.templateId !== templateId)
        }
      });
    },
    exportTemplate: async (templateId) => ({ ok: true, filePath: `Browser preview - ${templateId}.json` }),
    importTemplate: async () => {
      const current = readSettings();
      const layout = createBlankTemplateLayout('Imported Browser Template');
      return writeSettings({
        ...current,
        template: { ...current.template, selectedTemplateId: layout.id, layouts: [...current.template.layouts, layout] }
      });
    },
    updateTemplateAsset: async () => null,
    uploadFaceAsset: async () => readSettings(),
    uploadFaceAssetPackPreview: async () => readSettings(),
    removeFaceAsset: async () => readSettings(),
    deleteFaceAssetPack: async (packId: string) => {
      const current = readSettings();
      return writeSettings({
        ...current,
        template: {
          ...current.template,
          faceAssetPacks: current.template.faceAssetPacks.filter((pack) => pack.id !== packId),
          designs: current.template.designs.map((design) =>
            design.faceAssetPackId === packId ? { ...design, faceTrackingEnabled: false, faceAssetPackId: '' } : design
          )
        }
      });
    },
    updateFaceAssetPack: async (pack) => {
      const current = readSettings();
      const packs = current.template.faceAssetPacks.some((item) => item.id === pack.id)
        ? current.template.faceAssetPacks.map((item) => (item.id === pack.id ? pack : item))
        : [...current.template.faceAssetPacks, pack];
      return writeSettings({ ...current, template: { ...current.template, faceAssetPacks: packs } });
    },
    uploadAiPresetImage: async () => readSettings(),
    removeAiPresetImage: async () => readSettings(),
    uploadColorFilterThumbnail: async () => readSettings(),
    uploadColorFilterExample: async () => readSettings(),
    saveGeneratedColorFilterThumbnails: async () => readSettings(),
    listAiQueue: async () => aiQueue,
    retryAiQueueItem: async (itemId: string) => {
      const item = aiQueue.find((queueItem) => queueItem.id === itemId);
      if (!item) throw new Error('AI queue item not found.');
      item.status = 'failed';
      item.retryCount += 1;
      item.updatedAt = new Date().toISOString();
      return { item, fallback: true };
    },
    printAiQueueItem: async (itemId: string) => {
      const item = aiQueue.find((queueItem) => queueItem.id === itemId);
      if (!item) throw new Error('AI queue item not found.');
      item.status = 'printed';
      item.updatedAt = new Date().toISOString();
      return item;
    },
    generateAiFinal: async (request) => {
      const item: AiQueueItem = {
        id: `ai-job-${Date.now()}`,
        status: 'failed',
        templateId: request.templateId,
        styleId: request.styleId,
        designId: request.designId,
        presetId: request.presetId,
        provider: readSettings().ai.provider,
        inputPath: 'Browser preview AI input',
        resultPath: '',
        finalPath: '',
        printerName: request.printerName ?? '',
        error: 'AI generation is only available in Electron.',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        requestedAt: new Date().toISOString(),
        retryCount: 0
      };
      aiQueue.unshift(item);
      return { item, fallback: true };
    },
    getImageSize: async () => ({ width: 2478, height: 3690 }),
    saveGuideTemplate: async (templateId) => `Browser preview - ${templateId}-blank-guide.png`,
    openAdmin: async () => {
      window.open(`${window.location.origin}?window=admin`, '_blank');
      return true;
    },
    openGuest: async () => {
      window.open(window.location.origin, '_blank');
      return true;
    },
    openGuestPickerPreview: async () => {
      window.open(`${window.location.origin}?preview=picker`, '_blank');
      return true;
    },
    openFaceAssetPreview: async (packId: string) => {
      window.open(`${window.location.origin}?window=facePreview&packId=${encodeURIComponent(packId)}`, '_blank');
      return true;
    },
    capturePage: async () => '',
    setGuestFullscreen: async (fullscreen: boolean) => {
      if (fullscreen && !document.fullscreenElement) await document.documentElement.requestFullscreen();
      if (!fullscreen && document.fullscreenElement) await document.exitFullscreen();
      return true;
    },
    isGuestFullscreen: async () => Boolean(document.fullscreenElement),
    onGuestFullscreenChanged: (callback: (fullscreen: boolean) => void) => {
      const listener = () => callback(Boolean(document.fullscreenElement));
      document.addEventListener('fullscreenchange', listener);
      return () => document.removeEventListener('fullscreenchange', listener);
    },
    onOpenGuestPickerPreview: () => () => undefined,
    listPrinters: async () => [],
    saveImage: async (request: SaveImageRequest): Promise<SaveImageResult> => {
      photoSequence += 1;
      const name = `${photoSequence}.png`;
      const saved = {
        name,
        path: name,
        thumbPath: name,
        type: request.kind,
        createdAt: new Date().toISOString(),
        templateId: request.templateId,
        styleId: request.styleId,
        designId: request.designId,
        printerName: request.printerName,
        phoneNumber: request.phoneNumber
      };
      if (request.kind === 'original') gallery.originals.unshift(saved);
      if (request.kind === 'final') gallery.finals.unshift(saved);
      return { name, path: name };
    },
    updatePhotoGalleryUrl: async (filePath: string, galleryUrl: string) => {
      const photo = gallery.finals.find((item) => item.path === filePath);
      if (photo) photo.galleryUrl = galleryUrl;
      return true;
    },
    updatePhotoPhoneNumber: async (filePath: string, phoneNumber: string) => {
      const photo = gallery.finals.find((item) => item.path === filePath);
      if (photo) photo.phoneNumber = phoneNumber;
      return true;
    },
    getImageDataUrl: async () => '',
    getAudioDataUrl: async () => '',
    listGallery: async () => gallery,
    uploadFinalGallery: async (request) => {
      const photo = gallery.finals.find((item) => item.path === request.finalPath);
      const galleryUrl = `http://localhost:3000${request.galleryUrl}`;
      if (photo) {
        photo.galleryUrl = galleryUrl;
        photo.phoneNumber = request.phoneNumber;
      }
      return { ok: true, galleryUrl };
    },
    getGalleryUploadStatus: async () => ({ state: 'idle', message: 'No active upload.', active: 0 } as const),
    onGalleryUploadStatus: () => () => undefined,
    saveSessionVideo: async () => ({ path: '', name: '' }),
    uploadSessionVideo: async () => ({ ok: true }),
    openFile: async () => true,
    openUrl: async () => true,
    exportFile: async (filePath: string) => filePath,
    deleteFile: async () => true,
    printImage: async () => ({ ok: true }),
    openPrinterSettings: async () => false
  };
}
