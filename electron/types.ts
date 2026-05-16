export type TemplateSettings = {
  eventName: string;
  logoPath: string;
  framePath: string;
};

export type AppSettings = {
  eventName: string;
  eventFolder: string;
  cameraId: string;
  mirrorPreview: boolean;
  defaultPrinter: string;
  adminPassword: string;
  template: TemplateSettings;
  workflow: WorkflowSettings;
  printPicker: PrintPickerSettings;
  printCalibration: PrintCalibrationSettings;
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
