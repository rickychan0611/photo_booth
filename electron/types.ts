import type { PoseGuideSettings } from './poseTypes';
export type TemplateStyleId = 'style1' | 'style2' | 'style3' | 'style4';

export type TemplateOrientation = 'portrait' | 'landscape';

export type TemplateSlot = {
  x: number;
  y: number;
  width: number;
  height: number;
  sourceIndex: number;
  cropY?: 'center' | 'top';
  rotation?: 0 | 90 | 180 | 270;
};

export type TemplateStyleDefinition = {
  id: TemplateStyleId;
  name: string;
  shotCount: number;
  selectCount: number;
  printCopies: number;
  slots: TemplateSlot[];
};

export type TemplatePhotoWindow = TemplateSlot;

export type TemplateWorkflowSettings = {
  introMessage: string;
  introMs: number;
  printAutoSelectMs: number;
  thankYouMessage: string;
  thankYouMs: number;
  screenCues?: Partial<Record<'intro' | 'select' | 'thanks', AudioCue>>;
  shots: WorkflowShotSettings[];
};

export type TemplateLayout = {
  id: string;
  name: string;
  orientation: TemplateOrientation;
  paperWidth: number;
  paperHeight: number;
  photoWindows: TemplatePhotoWindow[];
  photosToTake?: number;
  active: boolean;
  guestPreviewPath: string;
  workflowDefaults: TemplateWorkflowSettings;
  printerName: string;
  createdAt: string;
  updatedAt: string;
};

export type AiPreset = {
  id: string;
  name: string;
  prompt: string;
  referenceImages: AiReferenceImage[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type AiReferenceImage = {
  id: string;
  path: string;
  name: string;
  createdAt: string;
};

export type AiProvider = 'openai' | 'gemini' | 'xai';

export type AiProviderConfig = {
  enabled: boolean;
  apiKey: string;
  apiUrl: string;
  model: string;
  size?: string;
  quality?: string;
};

export type AiSettings = {
  provider: AiProvider;
  systemPrompt: string;
  thinkingLevel: 'none' | 'low' | 'medium' | 'high';
  providers: Record<AiProvider, AiProviderConfig>;
  poseGenerator: {
    provider: AiProvider;
    providers: Record<AiProvider, Pick<AiProviderConfig, 'apiUrl' | 'model'>>;
  };
};

export type BeautyFilterMode = 'off' | 'print' | 'live';

export type BeautyFilterSettings = {
  enabledMode: BeautyFilterMode;
  previewTimeoutMs: number;
};

export type AiQueueStatus = 'queued' | 'generating' | 'requested' | 'done' | 'failed' | 'printed' | 'print_failed';

export type AiQueueItem = {
  id: string;
  status: AiQueueStatus;
  templateId: string;
  styleId?: TemplateStyleId;
  designId: string;
  presetId: string;
  provider: AiProvider;
  inputPath: string;
  resultPath: string;
  finalPath: string;
  printerName: string;
  error: string;
  createdAt: string;
  updatedAt: string;
  requestedAt?: string;
  completedAt?: string;
  retryCount: number;
};

export type TemplateDesign = {
  id: string;
  templateId: string;
  styleId?: TemplateStyleId;
  name: string;
  filePath?: string;
  previewPath: string;
  framePath: string;
  active: boolean;
  usesAi: boolean;
  aiPresetId: string;
  videoRecordingEnabled: boolean;
  workflowOverrideEnabled?: boolean;
  workflowOverride?: TemplateWorkflowSettings;
  createdAt: string;
  updatedAt: string;
};

export type TemplateSettings = {
  eventName: string;
  logoPath: string;
  framePath: string;
  styleVersion: number;
  selectedTemplateId: string;
  selectedStyleId?: TemplateStyleId;
  selectedDesignId: string;
  layouts: TemplateLayout[];
  aiPresets: AiPreset[];
  designs: TemplateDesign[];
};

export type AppSettings = {
  eventName: string;
  eventFolder: string;
  webApiBaseUrl: string;
  supabaseUrl: string;
  supabasePublishableKey: string;
  eventId: string;
  boothSecret: string;
  staffControlQueueMode: boolean;
  cameraId: string;
  /** Source used for the live mirror and session video. */
  cameraSource: 'capture-card' | 'canon-usb';
  /** Full-resolution USB still capture through the Canon SDK. */
  canonEnabled: boolean;
  /** How the capture-card picture sits inside the Canon still. */
  canonFraming: 'cover' | 'contain';
  mirrorPreview: boolean;
  poseGuide: PoseGuideSettings;
  cameraRotation: CameraRotation;
  cameraPreviewOverlay: CameraPreviewOverlay;
  cameraControls: CameraControlSettings;
  defaultPrinter: string;
  stylePrinters: StylePrinterSettings;
  printerEnabled: boolean;
  silentPrint: boolean;
  adminPassword: string;
  beautyFilter: BeautyFilterSettings;
  ai: AiSettings;
  audio: AudioSettings;
  template: TemplateSettings;
  workflow: WorkflowSettings;
  printPicker: PrintPickerSettings;
  printCalibration: PrintCalibrationSettings;
};

export type CloudSyncStatus = {
  state: 'disabled' | 'idle' | 'syncing' | 'synced' | 'error';
  message: string;
  lastSyncedAt?: string;
};

export type AudioCueMode = 'off' | 'mp3' | 'host';

export type AudioChannel = 'voice' | 'music' | 'sfx';

export type AudioCue = {
  id: string;
  label: string;
  mode: AudioCueMode;
  channel: AudioChannel;
  text: string;
  filePath: string;
  loop: boolean;
  volume: number;
  enabled: boolean;
  updatedAt: string;
};

export type AudioSettings = {
  enabled: boolean;
  masterVolume: number;
  voiceVolume: number;
  musicVolume: number;
  sfxVolume: number;
  enableHostVoice: boolean;
  voiceEngine: 'kokoro' | 'piper';
  voiceName: string;
  speed: number;
  volume: number;
  welcomeRepeatSeconds: number;
  cues: Record<string, AudioCue>;
};

export type HostVoiceGenerateResult = {
  ok: boolean;
  settings: AppSettings;
  generatedPath?: string;
  cue?: AudioCue;
  error?: string;
};

export type StylePrinterSettings = {
  style1: string;
  style2: string;
  style3: string;
  style4: string;
};

export type CameraRotation = 0 | 90 | 180 | 270;

export type CameraPreviewOverlay = 'none' | TemplateStyleId;

export type CameraControlSettings = {
  brightness?: number;
  contrast?: number;
  saturation?: number;
  sharpness?: number;
  exposureCompensation?: number;
  zoom?: number;
};

export type WorkflowShotSettings = {
  poseId?: string;
  message: string;
  cameraBeforeMessageMs: number;
  messageMs: number;
  cameraBeforeCountdownMs: number;
  audioCue?: AudioCue;
};

export type WorkflowSettings = {
  introMessage: string;
  introMs: number;
  printAutoSelectMs: number;
  thankYouMessage: string;
  thankYouMs: number;
  shots: WorkflowShotSettings[];
  /** Compatibility with the temporary shared-photo settings format. */
  photo?: WorkflowShotSettings;
};

export type PrintPickerSettings = {
  showSingle: boolean;
  showGrid: boolean;
  showAi: boolean;
  showFuture: boolean;
};

export type CanonStillCrop = {
  x: number;
  y: number;
  width: number;
  height: number;
  frameWidth: number;
  frameHeight: number;
  videoWidth: number;
  videoHeight: number;
  rotation: 0 | 90 | 180 | 270;
  mirror: boolean;
  framing: 'cover' | 'contain';
  slotAspect: number;
  cropY: 'center' | 'top';
};

export type CanonConnectResult = {
  ok: boolean;
  model?: string;
  error?: string;
};

export type CanonCaptureResult = {
  dataUrl: string;
  width: number;
  height: number;
};

export type PrintCalibrationSettings = {
  leftBleedIn: number;
  rightBleedIn: number;
  topBleedIn: number;
  bottomBleedIn: number;
  offsetXIn?: number;
  offsetYIn?: number;
  bleedXIn?: number;
  bleedYIn?: number;
};

export type SavedPhoto = {
  name: string;
  path: string;
  thumbPath?: string;
  type: 'original' | 'final';
  createdAt: string;
  templateId?: string;
  styleId?: TemplateStyleId;
  designId?: string;
  printerName?: string;
  galleryUrl?: string;
  phoneNumber?: string;
};

export type Gallery = {
  originals: SavedPhoto[];
  finals: SavedPhoto[];
};

export type SaveImageRequest = {
  dataUrl: string;
  kind: 'original' | 'final';
  filenamePrefix?: string;
  templateId?: string;
  styleId?: TemplateStyleId;
  designId?: string;
  printerName?: string;
  galleryUrl?: string;
  phoneNumber?: string;
};

export type SaveImageResult = {
  path: string;
  name: string;
};

export type WebPhotoAssetUpload = {
  kind: 'original' | 'layout' | 'thumbnail';
  filename: string;
  contentType: string;
  dataUrl: string;
  width?: number;
  height?: number;
};

export type BackgroundGalleryUploadRequest = {
  ticketId: string;
  galleryUrl: string;
  finalPath: string;
  phoneNumber?: string;
  marketingConsent?: boolean;
};

export type SaveVideoRequest = {
  data: ArrayBuffer | Uint8Array;
  baseName?: string;
  ticketId?: string;
};

export type SaveVideoResult = {
  path: string;
  name: string;
};

export type BackgroundVideoUploadRequest = {
  ticketId: string;
  videoPath: string;
};

export type BackgroundGalleryUploadResult = {
  ok: boolean;
  galleryUrl?: string;
  error?: string;
};

export type GalleryUploadStatus = {
  state: 'idle' | 'uploading' | 'done' | 'failed';
  message: string;
  active: number;
  lastGalleryUrl?: string;
  lastError?: string;
};

export type AiGenerateRequest = {
  dataUrl: string;
  templateId: string;
  styleId?: TemplateStyleId;
  designId: string;
  presetId: string;
  printerName?: string;
};

export type AiGenerateResult = {
  item: AiQueueItem;
  dataUrl?: string;
  saved?: SaveImageResult;
  fallback: boolean;
};

export type Capture = {
  dataUrl: string;
  path: string;
  name: string;
};

export type PrintLayout = 'single' | 'grid' | 'ai' | 'future';

export type TemplateUploadRequest = {
  templateId: string;
  name?: string;
};

export type TemplateAssetRole = 'preview' | 'frame';

export type TemplateExportResult = {
  ok: boolean;
  filePath?: string;
  error?: string;
};
