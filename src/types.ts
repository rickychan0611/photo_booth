export type TemplateStyleId = 'style1' | 'style2' | 'style3' | 'style4';

export type TemplateSlot = {
  x: number;
  y: number;
  width: number;
  height: number;
  sourceIndex: number;
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
  negativePrompt: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
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
  designs: TemplateDesign[];
};

export type AppSettings = {
  eventName: string;
  eventFolder: string;
  cameraId: string;
  mirrorPreview: boolean;
  cameraRotation: CameraRotation;
  cameraControls: CameraControlSettings;
  defaultPrinter: string;
  stylePrinters: StylePrinterSettings;
  silentPrint: boolean;
  adminPassword: string;
  template: TemplateSettings;
  workflow: WorkflowSettings;
  printPicker: PrintPickerSettings;
  printCalibration: PrintCalibrationSettings;
};

export type StylePrinterSettings = {
  style1: string;
  style2: string;
  style3: string;
  style4: string;
};

export type CameraRotation = 0 | 90 | 180 | 270;

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
  offsetXIn: number;
  offsetYIn: number;
  bleedXIn: number;
  bleedYIn: number;
};

export type SavedPhoto = {
  name: string;
  path: string;
  thumbPath?: string;
  type: 'original' | 'final';
  createdAt: string;
};

export type Gallery = {
  originals: SavedPhoto[];
  finals: SavedPhoto[];
};

export type SaveImageRequest = {
  dataUrl: string;
  kind: 'original' | 'final';
  filenamePrefix?: string;
};

export type SaveImageResult = {
  path: string;
  name: string;
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
