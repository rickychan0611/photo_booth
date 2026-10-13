import { contextBridge, ipcRenderer } from 'electron';
import type { PoseAiGenerateRequest, PoseAiGenerateResult, PoseCatalog, PoseNarrationGenerateRequest, PoseNarrationGenerateResult, PoseNarrationSettings, PoseNarrationSettingsUpdate, PoseScene } from './poseTypes';
import type {
  AiGenerateRequest,
  AiGenerateResult,
  AiQueueItem,
  AppSettings,
  AudioCue,
  BackgroundGalleryUploadRequest,
  BackgroundGalleryUploadResult,
  BackgroundVideoUploadRequest,
  Gallery,
  GalleryUploadStatus,
  HostVoiceGenerateResult,
  TemplateAssetRole,
  TemplateDesign,
  TemplateExportResult,
  TemplateLayout,
  TemplateUploadRequest,
  CanonConnectResult,
  CanonStillCrop,
  CloudSyncStatus,
  SaveImageRequest,
  SaveImageResult,
  SaveVideoRequest,
  SaveVideoResult
} from './types';

const api = {
  listPoses: () => ipcRenderer.invoke('poses:list') as Promise<PoseCatalog>,
  savePose: (pose: PoseScene) => ipcRenderer.invoke('poses:save', pose) as Promise<PoseScene>,
  deletePose: (id: string) => ipcRenderer.invoke('poses:delete', id) as Promise<boolean>,
  exportPose: (pose: PoseScene) => ipcRenderer.invoke('poses:export', pose) as Promise<boolean>,
  importPoseAudio: () => ipcRenderer.invoke('poses:audio-import') as Promise<{ filePath: string; name: string } | null>,
  importPoseImage: () => ipcRenderer.invoke('poses:image-import') as Promise<{ filePath: string; name: string } | null>,
  generatePose: (request: PoseAiGenerateRequest) => ipcRenderer.invoke('poses:generate', request) as Promise<PoseAiGenerateResult>,
  getPoseNarrationSettings: () => ipcRenderer.invoke('poses:narration-settings:get') as Promise<PoseNarrationSettings>,
  updatePoseNarrationSettings: (settings: PoseNarrationSettingsUpdate) => ipcRenderer.invoke('poses:narration-settings:set', settings) as Promise<PoseNarrationSettings>,
  generatePoseNarration: (request: PoseNarrationGenerateRequest) => ipcRenderer.invoke('poses:narration-generate', request) as Promise<PoseNarrationGenerateResult>,
  getSettings: () => ipcRenderer.invoke('settings:get') as Promise<AppSettings>,
  updateSettings: (settings: Partial<AppSettings>) =>
    ipcRenderer.invoke('settings:update', settings) as Promise<AppSettings>,
  onSettingsChanged: (callback: (settings: AppSettings) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, settings: AppSettings) => callback(settings);
    ipcRenderer.on('settings:changed', listener);
    return () => {
      ipcRenderer.removeListener('settings:changed', listener);
    };
  },
  getCloudSyncStatus: () => ipcRenderer.invoke('cloud-sync:status') as Promise<CloudSyncStatus>,
  syncCloudNow: () => ipcRenderer.invoke('cloud-sync:now') as Promise<CloudSyncStatus>,
  onCloudSyncStatus: (callback: (status: CloudSyncStatus) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: CloudSyncStatus) => callback(status);
    ipcRenderer.on('cloud-sync:status', listener);
    return () => {
      ipcRenderer.removeListener('cloud-sync:status', listener);
    };
  },
  exportSettings: () =>
    ipcRenderer.invoke('settings:export') as Promise<{ ok: boolean; filePath?: string; error?: string }>,
  importSettings: () =>
    ipcRenderer.invoke('settings:import') as Promise<{ ok: boolean; filePath?: string; settings?: AppSettings; error?: string }>,
  chooseFolder: () => ipcRenderer.invoke('dialog:choose-folder') as Promise<string>,
  chooseImage: () => ipcRenderer.invoke('dialog:choose-image') as Promise<string>,
  uploadEventIdleLogo: () => ipcRenderer.invoke('event:upload-idle-logo') as Promise<AppSettings | null>,
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
  saveTemplateSlotPreview: (templateId: string, dataUrl: string) =>
    ipcRenderer.invoke('template-layout:save-slot-preview', templateId, dataUrl) as Promise<AppSettings>,
  deleteTemplateLayout: (templateId: string) =>
    ipcRenderer.invoke('template-layout:delete', templateId) as Promise<AppSettings>,
  exportTemplate: (templateId: string) =>
    ipcRenderer.invoke('template-layout:export', templateId) as Promise<TemplateExportResult>,
  importTemplate: () => ipcRenderer.invoke('template-layout:import') as Promise<AppSettings>,
  updateTemplateAsset: (designId: string, role: TemplateAssetRole) =>
    ipcRenderer.invoke('template:update-asset', designId, role) as Promise<TemplateDesign | null>,
  uploadAiPresetImage: (presetId: string) =>
    ipcRenderer.invoke('ai:preset-image-upload', presetId) as Promise<AppSettings>,
  removeAiPresetImage: (presetId: string, imageId: string) =>
    ipcRenderer.invoke('ai:preset-image-remove', presetId, imageId) as Promise<AppSettings>,
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
  previewPoseOnGuest: (preview: unknown) => ipcRenderer.invoke('window:preview-pose', preview) as Promise<boolean>,
  takePosePreview: () => ipcRenderer.invoke('guest:take-pose-preview') as Promise<unknown>,
  setGuestCameraPaused: (paused: boolean) => ipcRenderer.invoke('guest:set-camera-paused', paused) as Promise<boolean>,
  onGuestCameraPaused: (callback: (paused: boolean) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, paused: boolean) => callback(paused);
    ipcRenderer.on('guest:camera-paused', listener);
    return () => { ipcRenderer.removeListener('guest:camera-paused', listener); };
  },
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
  onPreviewPose: (callback: (preview: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, preview: unknown) => callback(preview);
    ipcRenderer.on('guest:preview-pose', listener);
    return () => {
      ipcRenderer.removeListener('guest:preview-pose', listener);
    };
  },
  listPrinters: () => ipcRenderer.invoke('printers:list') as Promise<Electron.PrinterInfo[]>,
  saveImage: (request: SaveImageRequest) => ipcRenderer.invoke('image:save', request) as Promise<SaveImageResult>,
  canonConnect: () => ipcRenderer.invoke('canon:connect') as Promise<CanonConnectResult>,
  canonLiveFrame: () => ipcRenderer.invoke('canon:live-frame') as Promise<string>,
  canonPrepareCapture: () => ipcRenderer.invoke('canon:prepare-capture') as Promise<void>,
  canonReleaseFocus: () => ipcRenderer.invoke('canon:release-focus') as Promise<void>,
  canonCapture: (crop: CanonStillCrop) =>
    ipcRenderer.invoke('canon:capture', crop) as Promise<{ dataUrl: string; width: number; height: number }>,
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
  appendSessionVideoOutro: (request: { videoPath: string; finalImagePath: string; logoPath?: string }) =>
    ipcRenderer.invoke('video:append-outro', request) as Promise<SaveVideoResult>,
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
