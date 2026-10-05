import type {
  AudioCue,
  PrintCalibrationSettings,
  TemplateDesign,
  TemplateLayout,
  TemplateOrientation,
  TemplateSlot,
  TemplateStyleDefinition,
  TemplateStyleId,
  TemplateWorkflowSettings,
  WorkflowShotSettings
} from './types';

// 4×6 inch design canvas at 300 dpi. Print output uses the same pixels.
export const TEMPLATE_WIDTH = 1200;
export const TEMPLATE_HEIGHT = 1800;
export const LANDSCAPE_TEMPLATE_WIDTH = 1800;
export const LANDSCAPE_TEMPLATE_HEIGHT = 1200;
export const PRINT_WIDTH = TEMPLATE_WIDTH;
export const PRINT_HEIGHT = TEMPLATE_HEIGHT;
export const LANDSCAPE_PRINT_WIDTH = LANDSCAPE_TEMPLATE_WIDTH;
export const LANDSCAPE_PRINT_HEIGHT = LANDSCAPE_TEMPLATE_HEIGHT;

const TEMPLATE_DPI = 300;
const DEFAULT_PRINT_CALIBRATION: PrintCalibrationSettings = {
  leftBleedIn: 0.16,
  rightBleedIn: 0.16,
  topBleedIn: 0.08,
  bottomBleedIn: 0.26
};

export const DEFAULT_WORKFLOW_SHOTS: WorkflowShotSettings[] = [
  { message: 'Pose challenge!', cameraBeforeMessageMs: 0, messageMs: 1000, cameraBeforeCountdownMs: 2000 },
  { message: 'Next one!', cameraBeforeMessageMs: 0, messageMs: 1000, cameraBeforeCountdownMs: 2000 },
  { message: 'Looking good, now do this!', cameraBeforeMessageMs: 0, messageMs: 1400, cameraBeforeCountdownMs: 2000 },
  { message: 'Last one! Now...', cameraBeforeMessageMs: 0, messageMs: 1200, cameraBeforeCountdownMs: 2000 }
];

const migratePoseChallengeMessage = (index: number, message: string) => {
  const legacy = ['Get Ready!', 'Smile!', 'Switch It Up!', 'Final Pose!'];
  const current = DEFAULT_WORKFLOW_SHOTS[index]?.message;
  return current && message.trim().toLowerCase() === legacy[index]?.toLowerCase() ? current : message;
};

export const defaultTemplateShotAudioCue = (scopeId: string, index: number, text: string): AudioCue => ({
  id: `${scopeId}-shot-${index}`,
  label: `Picture ${index + 1} voice`,
  mode: 'host',
  channel: 'voice',
  text,
  filePath: '',
  loop: false,
  volume: 1,
  enabled: true,
  updatedAt: ''
});

export const defaultTemplateScreenCue = (
  scopeId: string,
  cueId: 'intro' | 'select' | 'thanks',
  label: string,
  text: string
): AudioCue => ({
  id: `${scopeId}-${cueId}`,
  label,
  mode: 'host',
  channel: 'voice',
  text,
  filePath: '',
  loop: false,
  volume: 1,
  enabled: true,
  updatedAt: ''
});

export const defaultTemplateWorkflow = (shotCount = 1): TemplateWorkflowSettings => ({
  introMessage: `Let's take ${shotCount} picture${shotCount === 1 ? '' : 's'}!`,
  introMs: 2000,
  printAutoSelectMs: 20000,
  thankYouMessage: 'THANK YOU!',
  thankYouMs: 3000,
  screenCues: {
    intro: defaultTemplateScreenCue('template', 'intro', 'Intro screen voice', "Let's take pictures."),
    select: defaultTemplateScreenCue('template', 'select', 'Photo selection voice', 'Please choose your favorite pictures to print.'),
    thanks: defaultTemplateScreenCue('template', 'thanks', 'Finish screen voice', 'Thank you. Please pick up your print.')
  },
  shots: Array.from({ length: Math.max(1, shotCount) }, (_item, index) => {
      const shot = { ...(DEFAULT_WORKFLOW_SHOTS[index] ?? DEFAULT_WORKFLOW_SHOTS[DEFAULT_WORKFLOW_SHOTS.length - 1]) };
      return { ...shot, audioCue: defaultTemplateShotAudioCue('template', index, shot.message) };
    })
});

export const templateDimensions = (orientation: TemplateOrientation) =>
  orientation === 'landscape'
    ? { width: LANDSCAPE_TEMPLATE_WIDTH, height: LANDSCAPE_TEMPLATE_HEIGHT }
    : { width: TEMPLATE_WIDTH, height: TEMPLATE_HEIGHT };

export const templatePrintDimensions = (orientation: TemplateOrientation) =>
  orientation === 'landscape'
    ? { width: LANDSCAPE_PRINT_WIDTH, height: LANDSCAPE_PRINT_HEIGHT }
    : { width: PRINT_WIDTH, height: PRINT_HEIGHT };

export const createBlankTemplateLayout = (name = 'New Template', orientation: TemplateOrientation = 'portrait'): TemplateLayout => {
  const now = new Date().toISOString();
  const { width, height } = templateDimensions(orientation);
  const windowWidth = width / 3;
  const windowHeight = windowWidth * (orientation === 'landscape' ? 4 / 6 : 6 / 4);
  return {
    id: `template-${Date.now()}`,
    name,
    orientation,
    paperWidth: width,
    paperHeight: height,
    photoWindows: [
      {
        x: (width - windowWidth) / 2,
        y: (height - windowHeight) / 2,
        width: windowWidth,
        height: windowHeight,
        sourceIndex: 0,
        rotation: 0
      }
    ],
    photosToTake: 1,
    active: true,
    guestPreviewPath: '',
    workflowDefaults: defaultTemplateWorkflow(1),
    printerName: '',
    createdAt: now,
    updatedAt: now
  };
};

// Number of photos the guest takes for a template. Always at least the number
// of photo slots (you cannot fill more slots than photos taken) and capped to a
// sensible maximum. When it exceeds the slot count the guest picks which shots
// to use before the frame is applied.
export const MAX_PHOTOS_TO_TAKE = 12;
export const normalizePhotosToTake = (photosToTake: number | undefined, slotCount: number) => {
  const slots = Math.max(1, slotCount);
  const requested = Number.isFinite(photosToTake) ? Math.round(photosToTake as number) : slots;
  return Math.min(MAX_PHOTOS_TO_TAKE, Math.max(slots, requested));
};

export const normalizeTemplateLayoutForClient = (layout: TemplateLayout): TemplateLayout => {
  const orientation = layout.orientation === 'landscape' ? 'landscape' : 'portrait';
  const dimensions = templateDimensions(orientation);
  const sourceWidth = finite(layout.paperWidth, 0);
  const sourceHeight = finite(layout.paperHeight, 0);
  const scaleX = sourceWidth > 0 ? dimensions.width / sourceWidth : 1;
  const scaleY = sourceHeight > 0 ? dimensions.height / sourceHeight : 1;
  const photoWindows = (layout.photoWindows ?? []).map((slot, index) => {
    let x = (Number.isFinite(slot.x) ? slot.x * scaleX : dimensions.width * 0.1);
    let y = (Number.isFinite(slot.y) ? slot.y * scaleY : dimensions.height * 0.1);
    let width = Math.max(1, Number.isFinite(slot.width) ? slot.width * scaleX : dimensions.width / 3);
    let height = Math.max(1, Number.isFinite(slot.height) ? slot.height * scaleY : dimensions.height / 3);
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    if (x + width > dimensions.width) width = Math.max(1, dimensions.width - x);
    if (y + height > dimensions.height) height = Math.max(1, dimensions.height - y);
    return {
      x,
      y,
      width,
      height,
      sourceIndex: index,
      cropY: slot.cropY === 'top' ? 'top' as const : 'center' as const,
      rotation: normalizeRotation(slot.rotation)
    };
  });
  const photosToTake = normalizePhotosToTake(layout.photosToTake, photoWindows.length);
  const workflowDefaults = normalizeTemplateWorkflow(layout.workflowDefaults, photosToTake);
  return {
    ...layout,
    id: layout.id || `template-${Date.now()}`,
    name: layout.name?.trim() || 'Template',
    orientation,
    paperWidth: dimensions.width,
    paperHeight: dimensions.height,
    photoWindows,
    photosToTake,
    active: layout.active !== false,
    guestPreviewPath: layout.guestPreviewPath ?? '',
    workflowDefaults,
    printerName: layout.printerName ?? '',
    createdAt: layout.createdAt || new Date().toISOString(),
    updatedAt: layout.updatedAt || new Date().toISOString()
  };
};

export const normalizeTemplateWorkflow = (
  workflow: Partial<TemplateWorkflowSettings> | undefined,
  shotCount: number
): TemplateWorkflowSettings => {
  const fallback = defaultTemplateWorkflow(shotCount);
  const sourceShots = workflow?.shots ?? [];
  const screenCues = {
    intro: {
      ...defaultTemplateScreenCue('template', 'intro', 'Intro screen voice', workflow?.introMessage ?? fallback.introMessage),
      ...(workflow?.screenCues?.intro ?? {})
    },
    select: {
      ...defaultTemplateScreenCue('template', 'select', 'Photo selection voice', 'Please choose your favorite pictures to print.'),
      ...(workflow?.screenCues?.select ?? {})
    },
    thanks: {
      ...defaultTemplateScreenCue('template', 'thanks', 'Finish screen voice', workflow?.thankYouMessage ?? fallback.thankYouMessage),
      ...(workflow?.screenCues?.thanks ?? {})
    }
  };
  return {
    ...fallback,
    ...(workflow ?? {}),
    introMessage: workflow?.introMessage ?? fallback.introMessage,
    thankYouMessage: workflow?.thankYouMessage ?? fallback.thankYouMessage,
    introMs: finite(workflow?.introMs, fallback.introMs),
    printAutoSelectMs: finite(workflow?.printAutoSelectMs, fallback.printAutoSelectMs),
    thankYouMs: finite(workflow?.thankYouMs, fallback.thankYouMs),
    screenCues,
    shots: Array.from({ length: Math.max(1, shotCount) }, (_item, index) => {
      const fallbackShot = fallback.shots[Math.min(index, fallback.shots.length - 1)];
      const sourceShot = sourceShots[index] ?? {};
      const sourceCue = sourceShot.audioCue;
      const message = migratePoseChallengeMessage(index, sourceShot.message ?? fallbackShot.message);
      return {
        ...fallbackShot,
        ...sourceShot,
        message,
        audioCue: {
          ...defaultTemplateShotAudioCue('template', index, message),
          ...(sourceCue ?? {}),
          label: sourceCue?.label || `Picture ${index + 1} voice`,
          channel: 'voice',
          text: sourceCue?.text ?? message
        }
      };
    })
  };
};

// Deprecated fixed-style exports are kept so old metadata can still be read.
export const TEMPLATE_STYLES: TemplateStyleDefinition[] = [];

export const getTemplateStyle = (_styleId: TemplateStyleId): TemplateStyleDefinition => ({
  id: 'style1',
  name: 'Legacy Style',
  shotCount: 1,
  selectCount: 1,
  printCopies: 1,
  slots: [createBlankTemplateLayout().photoWindows[0]]
});

export const getPrimarySlot = (layout: TemplateLayout | null | undefined, selectedCount = 0) => {
  const windows = layout?.photoWindows ?? [];
  return windows[Math.min(selectedCount, Math.max(0, windows.length - 1))] ?? createBlankTemplateLayout().photoWindows[0];
};

const finite = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const normalizeRotation = (value: unknown): 0 | 90 | 180 | 270 =>
  value === 90 || value === 180 || value === 270 ? value : 0;

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });

const fillImage = (
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  width: number,
  height: number,
  cropY: TemplateSlot['cropY'] = 'center'
) => {
  const scale = Math.max(width / image.width, height / image.height);
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  const drawY = cropY === 'top' ? y : y + (height - drawHeight) / 2;
  ctx.drawImage(image, x + (width - drawWidth) / 2, drawY, drawWidth, drawHeight);
};

const fillImageClipped = (
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  slot: TemplateSlot
) => {
  ctx.save();
  ctx.beginPath();
  ctx.rect(slot.x, slot.y, slot.width, slot.height);
  ctx.clip();
  ctx.translate(slot.x + slot.width / 2, slot.y + slot.height / 2);
  ctx.rotate(((slot.rotation ?? 0) * Math.PI) / 180);
  const rotated = (slot.rotation ?? 0) === 90 || (slot.rotation ?? 0) === 270;
  const drawWidth = rotated ? slot.height : slot.width;
  const drawHeight = rotated ? slot.width : slot.height;
  fillImage(ctx, image, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight, slot.cropY);
  ctx.restore();
};

type TemplatedPrintImageOptions = {
  maxLongEdge?: number;
};

const outputPrintDimensions = (orientation: TemplateOrientation, maxLongEdge?: number) => {
  const base = templatePrintDimensions(orientation);
  if (!maxLongEdge || maxLongEdge <= 0) return base;
  const scale = Math.min(1, maxLongEdge / Math.max(base.width, base.height));
  return {
    width: Math.max(1, Math.round(base.width * scale)),
    height: Math.max(1, Math.round(base.height * scale))
  };
};

const scaleSlotForPrint = (
  slot: TemplateSlot,
  layout: TemplateLayout,
  target = templatePrintDimensions(layout.orientation)
): TemplateSlot => {
  const source = { width: layout.paperWidth, height: layout.paperHeight };
  return {
    ...slot,
    x: (slot.x / source.width) * target.width,
    y: (slot.y / source.height) * target.height,
    width: (slot.width / source.width) * target.width,
    height: (slot.height / source.height) * target.height
  };
};

const createPrintCanvas = (orientation: TemplateOrientation, maxLongEdge?: number) => {
  const { width, height } = outputPrintDimensions(orientation, maxLongEdge);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available.');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  return { canvas, ctx };
};

export async function createTemplatedPrintImage(
  photoDataUrls: string[],
  layout: TemplateLayout,
  design?: TemplateDesign | null,
  templateDataUrl?: string,
  options: TemplatedPrintImageOptions = {}
) {
  const photoLayerDataUrl = await createTemplatedPhotoLayer(photoDataUrls, layout, options);
  return createTemplatedPrintImageFromLayer(photoLayerDataUrl, layout, design, templateDataUrl, options);
}

export async function createTemplatedPhotoLayer(
  photoDataUrls: string[],
  layout: TemplateLayout,
  options: TemplatedPrintImageOptions = {}
) {
  const normalizedLayout = normalizeTemplateLayoutForClient(layout);
  const { canvas, ctx } = createPrintCanvas(normalizedLayout.orientation, options.maxLongEdge);
  const photos = await Promise.all(photoDataUrls.slice(0, normalizedLayout.photoWindows.length).map((dataUrl) => loadImage(dataUrl)));

  normalizedLayout.photoWindows.forEach((slot) => {
    const photo = photos[slot.sourceIndex];
    if (photo) fillImageClipped(ctx, photo, scaleSlotForPrint(slot, normalizedLayout, canvas));
  });

  return canvas.toDataURL('image/png');
}

export async function createTemplatedPrintImageFromLayer(
  photoLayerDataUrl: string,
  layout: TemplateLayout,
  design?: TemplateDesign | null,
  templateDataUrl?: string,
  options: TemplatedPrintImageOptions = {}
) {
  const normalizedLayout = normalizeTemplateLayoutForClient(layout);
  const { canvas, ctx } = createPrintCanvas(normalizedLayout.orientation, options.maxLongEdge);
  if (design && templateDataUrl) {
    const frame = await loadImage(templateDataUrl);
    ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
  } else {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  const photoLayer = await loadImage(photoLayerDataUrl);
  ctx.drawImage(photoLayer, 0, 0, canvas.width, canvas.height);

  return canvas.toDataURL('image/png');
}

const bleedPixelsFromCalibration = (calibration: PrintCalibrationSettings) => {
  const left = Math.max(0, calibration.leftBleedIn) * TEMPLATE_DPI;
  const top = Math.max(0, calibration.topBleedIn) * TEMPLATE_DPI;
  const right = Math.max(0, calibration.rightBleedIn) * TEMPLATE_DPI;
  const bottom = Math.max(0, calibration.bottomBleedIn) * TEMPLATE_DPI;
  return { left, top, right, bottom };
};

export async function createGuideTemplateImage(
  layout: TemplateLayout,
  calibration: PrintCalibrationSettings = DEFAULT_PRINT_CALIBRATION
) {
  const normalizedLayout = normalizeTemplateLayoutForClient(layout);
  const canvas = document.createElement('canvas');
  canvas.width = normalizedLayout.paperWidth;
  canvas.height = normalizedLayout.paperHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available.');
  const bleed = bleedPixelsFromCalibration(calibration);

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#d8d8d8';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(
    bleed.left,
    bleed.top,
    canvas.width - bleed.left - bleed.right,
    canvas.height - bleed.top - bleed.bottom
  );

  normalizedLayout.photoWindows.forEach((slot) => {
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillRect(slot.x, slot.y, slot.width, slot.height);
    ctx.restore();

    ctx.fillStyle = '#111111';
    ctx.font = '300 38px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const labelY = slot.y + slot.height + 18;
    if (labelY < canvas.height - 260) {
      ctx.fillText(`PHOTO ${slot.sourceIndex + 1}  ${Math.round(slot.width)} x ${Math.round(slot.height)}  x ${Math.round(slot.x)} y ${Math.round(slot.y)}`, slot.x + slot.width / 2, labelY);
    }
  });

  ctx.fillStyle = '#111111';
  ctx.font = '300 38px Arial';
  ctx.textAlign = 'center';
  ctx.fillText(
    `Grey crop guide: L ${Math.round(bleed.left)} / T ${Math.round(bleed.top)} / R ${Math.round(bleed.right)} / B ${Math.round(bleed.bottom)} px`,
    canvas.width / 2,
    canvas.height - 105
  );
  return canvas.toDataURL('image/png');
}

export async function createFinalImage(photoDataUrl: string) {
  return createTemplatedPrintImage([photoDataUrl], createBlankTemplateLayout('Single'));
}

export async function createSinglePrintImage(photoDataUrl: string) {
  return createTemplatedPrintImage([photoDataUrl], createBlankTemplateLayout('Single'));
}

export async function createGridPrintImage(photoDataUrls: string[]) {
  const layout = createBlankTemplateLayout('Grid');
  const width = layout.paperWidth / 2;
  const height = layout.paperHeight / 2;
  layout.photoWindows = [0, 1, 2, 3].map((index) => ({
    x: (index % 2) * width,
    y: Math.floor(index / 2) * height,
    width,
    height,
    sourceIndex: index,
    rotation: 0
  }));
  return createTemplatedPrintImage(photoDataUrls, layout);
}
