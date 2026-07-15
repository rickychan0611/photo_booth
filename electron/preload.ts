import { contextBridge, ipcRenderer } from 'electron';
import type {
  AiGenerateRequest,
  AiGenerateResult,
  AiQueueItem,
  AppSettings,
  AudioCue,
  BackgroundGalleryUploadRequest,
  BackgroundGalleryUploadResult,
  BackgroundVideoUploadRequest,
  FaceAssetPack,
  Gallery,
  GalleryUploadStatus,
  HostVoiceGenerateResult,
  TemplateAssetRole,
  TemplateDesign,
  TemplateExportResult,
  TemplateLayout,
  TemplateUploadRequest,
  SaveImageRequest,
  SaveImageResult,
  SaveVideoRequest,
  SaveVideoResult
} from './types';

const api = {
  getSettings: () => ipcRenderer.invoke('settings:get') as Promise<AppSettings>,
  updateSettings: (settings: Partial<AppSettings>) =>
    ipcRenderer.invoke('settings:update', settings) as Promise<AppSettings>,
  exportSettings: () =>
    ipcRenderer.invoke('settings:export') as Promise<{ ok: boolean; filePath?: string; error?: string }>,
  importSettings: () =>
    ipcRenderer.invoke('settings:import') as Promise<{ ok: boolean; filePath?: string; settings?: AppSettings; error?: string }>,
  chooseFolder: () => ipcRenderer.invoke('dialog:choose-folder') as Promise<string>,
  chooseImage: () => ipcRenderer.invoke('dialog:choose-image') as Promise<string>,
  uploadAudioCue: (cueId: string) =>
    ipcRenderer.invoke('audio:upload-cue', cueId) as Promise<AppSettings>,
  removeAudioCue: (cueId: string) =>
    ipcRenderer.invoke('audio:remove-cue', cueId) as Promise<AppSettings>,
  uploadTemplateAudioCue: (cue: AudioCue) =>
    ipcRenderer.invoke('audio:upload-template-cue', cue) as Promise<AudioCue | null>,
  removeTemplateAudioCue: (cue: AudioCue) =>
    ipcRenderer.invoke('audio:remove-template-cue', cue) as Promise<AudioCue>,
  generateHostVoiceCue: (cueId: string) =>
    ipcRenderer.invoke('audio:generate-host-cue', cueId) as Promise<HostVoiceGenerateResult>,
  generateTemplateHostVoiceCue: (cue: AudioCue) =>
    ipcRenderer.invoke('audio:generate-template-host-cue', cue) as Promise<HostVoiceGenerateResult>,
  generateAllHostVoiceCues: () =>
    ipcRenderer.invoke('audio:generate-all-host-cues') as Promise<HostVoiceGenerateResult>,
  uploadTemplate: (request: TemplateUploadRequest) =>
    ipcRenderer.invoke('template:upload', request) as Promise<TemplateDesign | null>,
  deleteTemplate: (designId: string) => ipcRenderer.invoke('template:delete', designId) as Promise<boolean>,
  updateTemplate: (design: TemplateDesign) => ipcRenderer.invoke('template:update', design) as Promise<TemplateDesign>,
  updateTemplateLayout: (layout: TemplateLayout) =>
    ipcRenderer.invoke('template-layout:update', layout) as Promise<AppSettings>,
  uploadTemplateLayoutPreview: (templateId: string) =>
    ipcRenderer.invoke('template-layout:upload-preview', templateId) as Promise<AppSettings>,
  deleteTemplateLayout: (templateId: string) =>
    ipcRenderer.invoke('template-layout:delete', templateId) as Promise<AppSettings>,
  exportTemplate: (templateId: string) =>
    ipcRenderer.invoke('template-layout:export', templateId) as Promise<TemplateExportResult>,
  importTemplate: () => ipcRenderer.invoke('template-layout:import') as Promise<AppSettings>,
  updateTemplateAsset: (designId: string, role: TemplateAssetRole) =>
    ipcRenderer.invoke('template:update-asset', designId, role) as Promise<TemplateDesign | null>,
  uploadFaceAsset: (packId: string) =>
    ipcRenderer.invoke('face-asset:upload', packId) as Promise<AppSettings>,
  uploadFaceAssetPackPreview: (packId: string) =>
    ipcRenderer.invoke('face-asset-pack:upload-preview', packId) as Promise<AppSettings>,
  removeFaceAsset: (packId: string, assetId: string) =>
    ipcRenderer.invoke('face-asset:remove', packId, assetId) as Promise<AppSettings>,
  deleteFaceAssetPack: (packId: string) =>
    ipcRenderer.invoke('face-asset-pack:delete', packId) as Promise<AppSettings>,
  updateFaceAssetPack: (pack: FaceAssetPack) =>
    ipcRenderer.invoke('face-asset-pack:update', pack) as Promise<AppSettings>,
  uploadAiPresetImage: (presetId: string) =>
    ipcRenderer.invoke('ai:preset-image-upload', presetId) as Promise<AppSettings>,
  removeAiPresetImage: (presetId: string, imageId: string) =>
    ipcRenderer.invoke('ai:preset-image-remove', presetId, imageId) as Promise<AppSettings>,
  uploadColorFilterThumbnail: (presetId: string) =>
    ipcRenderer.invoke('color-filter:upload-thumbnail', presetId) as Promise<AppSettings>,
  uploadColorFilterExample: () =>
    ipcRenderer.invoke('color-filter:upload-example') as Promise<AppSettings>,
  saveGeneratedColorFilterThumbnails: (thumbnails: Array<{ presetId: string; dataUrl: string }>) =>
    ipcRenderer.invoke('color-filter:save-generated-thumbnails', thumbnails) as Promise<AppSettings>,
  listAiQueue: () => ipcRenderer.invoke('ai:queue-list') as Promise<AiQueueItem[]>,
  retryAiQueueItem: (itemId: string) => ipcRenderer.invoke('ai:queue-retry', itemId) as Promise<AiGenerateResult>,
  printAiQueueItem: (itemId: string) => ipcRenderer.invoke('ai:queue-print', itemId) as Promise<AiQueueItem>,
  generateAiFinal: (request: AiGenerateRequest) =>
    ipcRenderer.invoke('ai:generate-final', request) as Promise<AiGenerateResult>,
  getImageSize: (filePath: string) => ipcRenderer.invoke('image:size', filePath) as Promise<{ width: number; height: number }>,
  saveGuideTemplate: (templateId: string, dataUrl: string) =>
    ipcRenderer.invoke('template:save-guide', templateId, dataUrl) as Promise<string>,
  openAdmin: () => ipcRenderer.invoke('window:open-admin') as Promise<boolean>,
  openGuest: () => ipcRenderer.invoke('window:open-guest') as Promise<boolean>,
  openGuestPickerPreview: () => ipcRenderer.invoke('window:open-guest-picker-preview') as Promise<boolean>,
  openFaceAssetPreview: (packId: string) =>
    ipcRenderer.invoke('window:open-face-asset-preview', packId) as Promise<boolean>,
  capturePage: (rect?: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke('window:capture-page', rect) as Promise<string>,
  setGuestFullscreen: (fullscreen: boolean) =>
    ipcRenderer.invoke('guest:set-fullscreen', fullscreen) as Promise<boolean>,
  isGuestFullscreen: () => ipcRenderer.invoke('guest:is-fullscreen') as Promise<boolean>,
  onGuestFullscreenChanged: (callback: (fullscreen: boolean) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, fullscreen: boolean) => callback(fullscreen);
    ipcRenderer.on('guest:fullscreen-changed', listener);
    return () => {
      ipcRenderer.removeListener('guest:fullscreen-changed', listener);
    };
  },
  onOpenGuestPickerPreview: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('guest:open-picker-preview', listener);
    return () => {
      ipcRenderer.removeListener('guest:open-picker-preview', listener);
    };
  },
  listPrinters: () => ipcRenderer.invoke('printers:list') as Promise<Electron.PrinterInfo[]>,
  saveImage: (request: SaveImageRequest) => ipcRenderer.invoke('image:save', request) as Promise<SaveImageResult>,
  updatePhotoGalleryUrl: (filePath: string, galleryUrl: string) =>
    ipcRenderer.invoke('image:update-gallery-url', filePath, galleryUrl) as Promise<boolean>,
  updatePhotoPhoneNumber: (filePath: string, phoneNumber: string) =>
    ipcRenderer.invoke('image:update-phone-number', filePath, phoneNumber) as Promise<boolean>,
  getImageDataUrl: (filePath: string) => ipcRenderer.invoke('image:data-url', filePath) as Promise<string>,
  getAudioDataUrl: (filePath: string) => ipcRenderer.invoke('audio:data-url', filePath) as Promise<string>,
  listGallery: () => ipcRenderer.invoke('gallery:list') as Promise<Gallery>,
  uploadFinalGallery: (request: BackgroundGalleryUploadRequest) =>
    ipcRenderer.invoke('gallery:upload-final', request) as Promise<BackgroundGalleryUploadResult>,
  saveSessionVideo: (request: SaveVideoRequest) =>
    ipcRenderer.invoke('video:save-and-transcode', request) as Promise<SaveVideoResult>,
  uploadSessionVideo: (request: BackgroundVideoUploadRequest) =>
    ipcRenderer.invoke('gallery:upload-video', request) as Promise<BackgroundGalleryUploadResult>,
  getGalleryUploadStatus: () => ipcRenderer.invoke('gallery:upload-status') as Promise<GalleryUploadStatus>,
  onGalleryUploadStatus: (callback: (status: GalleryUploadStatus) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: GalleryUploadStatus) => callback(status);
    ipcRenderer.on('gallery:upload-status', listener);
    return () => {
      ipcRenderer.removeListener('gallery:upload-status', listener);
    };
  },
  openFile: (filePath: string) => ipcRenderer.invoke('file:open', filePath) as Promise<boolean>,
  openUrl: (url: string) => ipcRenderer.invoke('url:open', url) as Promise<boolean>,
  exportFile: (filePath: string) => ipcRenderer.invoke('file:export', filePath) as Promise<string>,
  deleteFile: (filePath: string) => ipcRenderer.invoke('file:delete', filePath) as Promise<boolean>,
  printImage: (imagePath?: string, printerName?: string) =>
    ipcRenderer.invoke('print:image', imagePath, printerName) as Promise<{ ok: boolean; error?: string }>,
  openPrinterSettings: () => ipcRenderer.invoke('printer:settings') as Promise<boolean>
};

contextBridge.exposeInMainWorld('photoBooth', api);

export type PhotoBoothApi = typeof api;
