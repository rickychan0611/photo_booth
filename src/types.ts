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
};

export type BeautyFilterMode = 'off' | 'print' | 'live';

export type BeautyFilterSettings = {
  enabledMode: BeautyFilterMode;
  previewTimeoutMs: number;
};

export type ColorFilterValues = {
  intensity: number;
  brightness: number;
  contrast: number;
  saturation: number;
  warmth: number;
  tint: number;
  hue: number;
  fade: number;
  highlights: number;
  shadows: number;
  vignette: number;
  blur: number;
};

export type ColorFilterPreset = {
  id: string;
  name: string;
  active: boolean;
  thumbnailPath: string;
  filter: ColorFilterValues;
  createdAt: string;
  updatedAt: string;
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
  faceTrackingEnabled: boolean;
  faceAssetPackId: string;
  videoRecordingEnabled: boolean;
  workflowOverrideEnabled?: boolean;
  workflowOverride?: TemplateWorkflowSettings;
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
  selectedTemplateId: string;
  selectedStyleId?: TemplateStyleId;
  selectedDesignId: string;
  layouts: TemplateLayout[];
  aiPresets: AiPreset[];
  faceAssetPacks: FaceAssetPack[];
  colorFilterExamplePath: string;
  colorFilterPresetVersion?: number;
  colorFilterPresets: ColorFilterPreset[];
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

export type QueueTicket = {
  id: string;
  event_id: string;
  queue_number: number;
  access_code?: string | null;
  access_code_last4?: string | null;
  status: 'waiting' | 'active' | 'skipped' | 'cancelled' | 'used';
  payment_status: 'paid' | 'pending' | 'refunded' | 'failed';
  payment_method: string;
  gallery_token_lookup?: string;
  marketing_consent?: boolean | null;
};

export type QueueEvent = {
  id: string;
  name: string;
  status: string;
  current_queue_number: number;
  next_queue_number: number;
};

export type QueueSnapshot = {
  event: QueueEvent;
  tickets: QueueTicket[];
  nowServing: QueueTicket | null;
  nextUp: QueueTicket[];
  missedButAccepted: QueueTicket[];
};

export type BoothSession = {
  ticket: QueueTicket;
  galleryUrl: string;
};

export type UploadedWebAsset = {
  id: string;
  kind: string;
  r2_key?: string;
  content_type?: string;
  size_bytes?: number | null;
  width?: number | null;
  height?: number | null;
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

export type BackgroundGalleryUploadResult = {
  ok: boolean;
  galleryUrl?: string;
  error?: string;
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

export type GalleryUploadStatus = {
  state: 'idle' | 'uploading' | 'done' | 'failed';
  message: string;
  active: number;
  lastGalleryUrl?: string;
  lastError?: string;
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
