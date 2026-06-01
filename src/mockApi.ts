import type { AiQueueItem, AppSettings, Gallery, SaveImageRequest, SaveImageResult } from './types';

const fallbackSettings: AppSettings = {
  eventName: 'PHOTO BOOTH',
  eventFolder: 'Browser preview',
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
  silentPrint: false,
  adminPassword: '',
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
      template: {
        ...fallbackSettings.template,
        ...(parsed.template ?? {}),
        faceAssetPacks: parsed.template?.faceAssetPacks ?? fallbackSettings.template.faceAssetPacks,
        designs: (parsed.template?.designs ?? fallbackSettings.template.designs).map((design) => ({
          ...design,
          faceTrackingEnabled: Boolean(design.faceTrackingEnabled),
          faceAssetPackId: design.faceAssetPackId ?? ''
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
    uploadTemplate: async () => null,
    deleteTemplate: async () => true,
    updateTemplate: async (design) => design,
    updateTemplateAsset: async () => null,
    uploadFaceAsset: async () => readSettings(),
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
    saveGuideTemplate: async (styleId) => `Browser preview - ${styleId}-blank-guide.png`,
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
        styleId: request.styleId,
        designId: request.designId,
        printerName: request.printerName
      };
      if (request.kind === 'original') gallery.originals.unshift(saved);
      if (request.kind === 'final') gallery.finals.unshift(saved);
      return { name, path: name };
    },
    getImageDataUrl: async () => '',
    listGallery: async () => gallery,
    openFile: async () => true,
    exportFile: async (filePath: string) => filePath,
    deleteFile: async () => true,
    printImage: async () => ({ ok: true }),
    openPrinterSettings: async () => false
  };
}
