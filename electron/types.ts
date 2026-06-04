export type TemplateStyleId = 'style1' | 'style2' | 'style3' | 'style4';

export type TemplateSlot = {
  x: number;
  y: number;
  width: number;
  height: number;
  sourceIndex: number;
  cropY?: 'center' | 'top';
};

export type TemplateStyleDefinition = {
  id: TemplateStyleId;
  name: string;
  shotCount: number;
  selectCount: number;
  printCopies: number;
  slots: TemplateSlot[];
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
};

export type AiQueueStatus = 'queued' | 'generating' | 'requested' | 'done' | 'failed' | 'printed' | 'print_failed';

export type AiQueueItem = {
  id: string;
  status: AiQueueStatus;
  styleId: TemplateStyleId;
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
  styleId: TemplateStyleId;
  name: string;
  filePath?: string;
  previewPath: string;
  framePath: string;
  active: boolean;
  usesAi: boolean;
  aiPresetId: string;
  faceTrackingEnabled: boolean;
  faceAssetPackId: string;
  createdAt: string;
  updatedAt: string;
};

export type FaceAssetPlacement = 'glasses' | 'hat' | 'nose' | 'mouth' | 'face';

export type FaceAsset = {
  id: string;
  name: string;
  path: string;
  placement: FaceAssetPlacement;
  scale: number;
  xOffset: number;
  yOffset: number;
  rotation: number;
  opacity: number;
  active: boolean;
  order: number;
  createdAt: string;
  updatedAt: string;
};

export type FaceAssetPack = {
  id: string;
  name: string;
  active: boolean;
  assignPerFace: boolean;
  assets: FaceAsset[];
  createdAt: string;
  updatedAt: string;
};

export type TemplateSettings = {
  eventName: string;
  logoPath: string;
  framePath: string;
  styleVersion: number;
  selectedStyleId: TemplateStyleId;
  selectedDesignId: string;
  aiPresets: AiPreset[];
  faceAssetPacks: FaceAssetPack[];
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
  mirrorPreview: boolean;
  cameraRotation: CameraRotation;
  cameraPreviewOverlay: CameraPreviewOverlay;
  cameraControls: CameraControlSettings;
  defaultPrinter: string;
  stylePrinters: StylePrinterSettings;
  silentPrint: boolean;
  adminPassword: string;
  ai: AiSettings;
  audio: AudioSettings;
  template: TemplateSettings;
  workflow: WorkflowSettings;
  printPicker: PrintPickerSettings;
  printCalibration: PrintCalibrationSettings;
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
  message: string;
  cameraBeforeMessageMs: number;
  messageMs: number;
  cameraBeforeCountdownMs: number;
};

export type WorkflowSettings = {
  introMessage: string;
  introMs: number;
  printAutoSelectMs: number;
  thankYouMessage: string;
  thankYouMs: number;
  shots: WorkflowShotSettings[];
};

export type PrintPickerSettings = {
  showSingle: boolean;
  showGrid: boolean;
  showAi: boolean;
  showFuture: boolean;
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
  styleId?: TemplateStyleId;
  designId?: string;
  printerName?: string;
  galleryUrl?: string;
};

export type Gallery = {
  originals: SavedPhoto[];
  finals: SavedPhoto[];
};

export type SaveImageRequest = {
  dataUrl: string;
  kind: 'original' | 'final';
  filenamePrefix?: string;
  styleId?: TemplateStyleId;
  designId?: string;
  printerName?: string;
  galleryUrl?: string;
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
  styleId: TemplateStyleId;
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
  styleId: TemplateStyleId;
  name?: string;
};

export type TemplateAssetRole = 'preview' | 'frame';
