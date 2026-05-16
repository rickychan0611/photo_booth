import type { AppSettings, Gallery, SaveImageRequest, SaveImageResult } from './types';

const fallbackSettings: AppSettings = {
  eventName: 'AVIEBELLE PHOTO BOOTH',
  eventFolder: 'Browser preview',
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
};

const settingsKey = 'aviebelle-preview-settings';
const gallery: Gallery = { originals: [], finals: [] };

export function installMockApi() {
  if (window.photoBooth) return;

  const readSettings = (): AppSettings => {
    const raw = window.localStorage.getItem(settingsKey);
    if (!raw) return fallbackSettings;
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      ...fallbackSettings,
      ...parsed,
      template: { ...fallbackSettings.template, ...(parsed.template ?? {}) },
      workflow: {
        ...fallbackSettings.workflow,
        ...(parsed.workflow ?? {}),
        shots: fallbackSettings.workflow.shots.map((shot, index) => ({
          ...shot,
          ...(parsed.workflow?.shots?.[index] ?? {})
        }))
      },
      printPicker: { ...fallbackSettings.printPicker, ...(parsed.printPicker ?? {}) },
      printCalibration: { ...fallbackSettings.printCalibration, ...(parsed.printCalibration ?? {}) }
    };
  };

  const writeSettings = (settings: AppSettings) => {
    window.localStorage.setItem(settingsKey, JSON.stringify(settings));
    return settings;
  };

  window.photoBooth = {
    getSettings: async () => readSettings(),
    updateSettings: async (partial: Partial<AppSettings>) => {
      const current = readSettings();
      return writeSettings({
        ...current,
        ...partial,
        template: { ...current.template, ...(partial.template ?? {}) },
        workflow: {
          ...current.workflow,
          ...(partial.workflow ?? {}),
          shots: partial.workflow?.shots ?? current.workflow.shots
        },
        printPicker: { ...current.printPicker, ...(partial.printPicker ?? {}) },
        printCalibration: { ...current.printCalibration, ...(partial.printCalibration ?? {}) }
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
    openAdmin: async () => {
      window.open(`${window.location.origin}?window=admin`, '_blank');
      return true;
    },
    openGuest: async () => {
      window.open(window.location.origin, '_blank');
      return true;
    },
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
    listPrinters: async () => [],
    saveImage: async (request: SaveImageRequest): Promise<SaveImageResult> => {
      const name = `${request.filenamePrefix ?? request.kind}-${Date.now()}.png`;
      const saved = { name, path: name, type: request.kind, createdAt: new Date().toISOString() };
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
