import type { PrintCalibrationSettings, TemplateDesign, TemplateSlot, TemplateStyleDefinition, TemplateStyleId } from './types';

export const TEMPLATE_WIDTH = 2478;
export const TEMPLATE_HEIGHT = 3690;
export const PRINT_WIDTH = 1239;
export const PRINT_HEIGHT = 1845;
const TEMPLATE_DPI = TEMPLATE_WIDTH / 4.13;
const DEFAULT_PRINT_CALIBRATION: PrintCalibrationSettings = {
  leftBleedIn: 0.16,
  rightBleedIn: 0.16,
  topBleedIn: 0.08,
  bottomBleedIn: 0.26
};

// Shrinks every photo area by this factor (10% smaller in each dimension) to
// give thicker borders. Width and height scale equally, so the aspect ratio is
// preserved — that keeps the live-view guide and capture crop perfectly aligned
// with the final print.
const PHOTO_AREA_SCALE = 0.9;

const shrinkSlot = (slot: TemplateSlot, scale = PHOTO_AREA_SCALE): TemplateSlot => {
  const width = slot.width * scale;
  const height = slot.height * scale;
  return {
    ...slot,
    x: slot.x + (slot.width - width) / 2,
    y: slot.y + (slot.height - height) / 2,
    width,
    height
  };
};

const safeSlot = (slot: TemplateSlot, insetX = 60, insetY = 60): TemplateSlot =>
  shrinkSlot({
    ...slot,
    x: slot.x + insetX,
    y: slot.y + insetY,
    width: slot.width - insetX * 2,
    height: slot.height - insetY * 2
  });

export const TEMPLATE_STYLES: TemplateStyleDefinition[] = [
  {
    id: 'style1',
    name: 'Style 1',
    shotCount: 4,
    selectCount: 1,
    printCopies: 1,
    slots: [safeSlot({ x: 120, y: 120, width: 2238, height: 2950, sourceIndex: 0 })]
  },
  {
    id: 'style2',
    name: 'Style 2',
    shotCount: 4,
    selectCount: 2,
    printCopies: 1,
    slots: [
      safeSlot({ x: 120, y: 120, width: 2238, height: 1430, sourceIndex: 0, cropY: 'top' }),
      safeSlot({ x: 120, y: 1630, width: 2238, height: 1430, sourceIndex: 1, cropY: 'top' })
    ]
  },
  {
    id: 'style3',
    name: 'Style 3',
    shotCount: 4,
    selectCount: 4,
    printCopies: 1,
    slots: [
      safeSlot({ x: 80, y: 80, width: 1139, height: 1485, sourceIndex: 0 }),
      safeSlot({ x: 1259, y: 80, width: 1139, height: 1485, sourceIndex: 1 }),
      safeSlot({ x: 80, y: 1605, width: 1139, height: 1485, sourceIndex: 2 }),
      safeSlot({ x: 1259, y: 1605, width: 1139, height: 1485, sourceIndex: 3 })
    ]
  },
  {
    id: 'style4',
    name: 'Style 4',
    shotCount: 4,
    selectCount: 4,
    printCopies: 2,
    slots: [
      safeSlot({ x: 55, y: 60, width: 1159, height: 720, sourceIndex: 0, cropY: 'top' }, 60, 40),
      safeSlot({ x: 55, y: 800, width: 1159, height: 720, sourceIndex: 1, cropY: 'top' }, 60, 40),
      safeSlot({ x: 55, y: 1540, width: 1159, height: 720, sourceIndex: 2, cropY: 'top' }, 60, 40),
      safeSlot({ x: 55, y: 2280, width: 1159, height: 720, sourceIndex: 3, cropY: 'top' }, 60, 40),
      safeSlot({ x: 1264, y: 60, width: 1159, height: 720, sourceIndex: 0, cropY: 'top' }, 60, 40),
      safeSlot({ x: 1264, y: 800, width: 1159, height: 720, sourceIndex: 1, cropY: 'top' }, 60, 40),
      safeSlot({ x: 1264, y: 1540, width: 1159, height: 720, sourceIndex: 2, cropY: 'top' }, 60, 40),
      safeSlot({ x: 1264, y: 2280, width: 1159, height: 720, sourceIndex: 3, cropY: 'top' }, 60, 40)
    ]
  }
];

export const getTemplateStyle = (styleId: TemplateStyleId) =>
  TEMPLATE_STYLES.find((style) => style.id === styleId) ?? TEMPLATE_STYLES[0];

export const getPrimarySlot = (styleId: TemplateStyleId, selectedCount = 0) => {
  const style = getTemplateStyle(styleId);
  return style.slots[Math.min(selectedCount, style.selectCount - 1)] ?? style.slots[0];
};

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
  fillImage(ctx, image, slot.x, slot.y, slot.width, slot.height, slot.cropY);
  ctx.restore();
};

const scaleSlotForPrint = (slot: TemplateSlot): TemplateSlot => ({
  ...slot,
  x: (slot.x / TEMPLATE_WIDTH) * PRINT_WIDTH,
  y: (slot.y / TEMPLATE_HEIGHT) * PRINT_HEIGHT,
  width: (slot.width / TEMPLATE_WIDTH) * PRINT_WIDTH,
  height: (slot.height / TEMPLATE_HEIGHT) * PRINT_HEIGHT
});

const createPrintCanvas = () => {
  const canvas = document.createElement('canvas');
  canvas.width = PRINT_WIDTH;
  canvas.height = PRINT_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available.');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  return { canvas, ctx };
};

export async function createTemplatedPrintImage(
  photoDataUrls: string[],
  styleId: TemplateStyleId,
  design?: TemplateDesign | null,
  templateDataUrl?: string
) {
  const style = getTemplateStyle(styleId);
  const { canvas, ctx } = createPrintCanvas();
  const photos = await Promise.all(photoDataUrls.slice(0, style.selectCount).map((dataUrl) => loadImage(dataUrl)));

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  style.slots.forEach((slot) => {
    const photo = photos[slot.sourceIndex];
    if (photo) fillImageClipped(ctx, photo, scaleSlotForPrint(slot));
  });

  if (design && templateDataUrl) {
    const frame = await loadImage(templateDataUrl);
    ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
  }

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
  styleId: TemplateStyleId,
  calibration: PrintCalibrationSettings = DEFAULT_PRINT_CALIBRATION
) {
  const style = getTemplateStyle(styleId);
  const canvas = document.createElement('canvas');
  canvas.width = TEMPLATE_WIDTH;
  canvas.height = TEMPLATE_HEIGHT;
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

  style.slots.forEach((slot, index) => {
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
      ctx.fillText(`PHOTO ${slot.sourceIndex + 1}  ${slot.width} x ${slot.height}  x ${slot.x} y ${slot.y}`, slot.x + slot.width / 2, labelY);
    }
    if (style.id === 'style4' && index >= 4) {
      ctx.font = '300 32px Arial';
      if (labelY + 44 < canvas.height - 260) {
        ctx.fillText('DUPLICATE STRIP', slot.x + slot.width / 2, labelY + 44);
      }
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
  return createTemplatedPrintImage([photoDataUrl], 'style1');
}

export async function createSinglePrintImage(photoDataUrl: string) {
  return createTemplatedPrintImage([photoDataUrl], 'style1');
}

export async function createGridPrintImage(photoDataUrls: string[]) {
  return createTemplatedPrintImage(photoDataUrls, 'style3');
}
