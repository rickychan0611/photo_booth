import type { TemplateDesign, TemplateSlot, TemplateStyleDefinition, TemplateStyleId } from './types';

export const PRINT_WIDTH = 2478;
export const PRINT_HEIGHT = 3690;

export const TEMPLATE_STYLES: TemplateStyleDefinition[] = [
  {
    id: 'style1',
    name: 'Style 1',
    shotCount: 4,
    selectCount: 1,
    printCopies: 1,
    slots: [{ x: 120, y: 120, width: 2238, height: 2950, sourceIndex: 0 }]
  },
  {
    id: 'style2',
    name: 'Style 2',
    shotCount: 4,
    selectCount: 2,
    printCopies: 1,
    slots: [
      { x: 120, y: 120, width: 2238, height: 1430, sourceIndex: 0 },
      { x: 120, y: 1630, width: 2238, height: 1430, sourceIndex: 1 }
    ]
  },
  {
    id: 'style3',
    name: 'Style 3',
    shotCount: 4,
    selectCount: 4,
    printCopies: 1,
    slots: [
      { x: 80, y: 80, width: 1139, height: 1485, sourceIndex: 0 },
      { x: 1259, y: 80, width: 1139, height: 1485, sourceIndex: 1 },
      { x: 80, y: 1605, width: 1139, height: 1485, sourceIndex: 2 },
      { x: 1259, y: 1605, width: 1139, height: 1485, sourceIndex: 3 }
    ]
  },
  {
    id: 'style4',
    name: 'Style 4',
    shotCount: 4,
    selectCount: 4,
    printCopies: 2,
    slots: [
      { x: 50, y: 60, width: 1139, height: 660, sourceIndex: 0 },
      { x: 50, y: 800, width: 1139, height: 660, sourceIndex: 1 },
      { x: 50, y: 1540, width: 1139, height: 660, sourceIndex: 2 },
      { x: 50, y: 2280, width: 1139, height: 660, sourceIndex: 3 },
      { x: 1289, y: 60, width: 1139, height: 660, sourceIndex: 0 },
      { x: 1289, y: 800, width: 1139, height: 660, sourceIndex: 1 },
      { x: 1289, y: 1540, width: 1139, height: 660, sourceIndex: 2 },
      { x: 1289, y: 2280, width: 1139, height: 660, sourceIndex: 3 }
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
  height: number
) => {
  const scale = Math.max(width / image.width, height / image.height);
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  ctx.drawImage(image, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
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
  fillImage(ctx, image, slot.x, slot.y, slot.width, slot.height);
  ctx.restore();
};

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
    if (photo) fillImageClipped(ctx, photo, slot);
  });

  if (design && templateDataUrl) {
    const frame = await loadImage(templateDataUrl);
    ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
  }

  return canvas.toDataURL('image/png');
}

export async function createGuideTemplateImage(styleId: TemplateStyleId) {
  const style = getTemplateStyle(styleId);
  const { canvas, ctx } = createPrintCanvas();
  ctx.fillStyle = '#f3f3f3';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(90, 90, canvas.width - 180, canvas.height - 180);

  style.slots.forEach((slot, index) => {
    ctx.fillStyle = '#111111';
    ctx.fillRect(slot.x, slot.y, slot.width, slot.height);
    ctx.strokeStyle = '#ff00ff';
    ctx.lineWidth = 10;
    ctx.strokeRect(slot.x, slot.y, slot.width, slot.height);
    ctx.fillStyle = '#ffffff';
    ctx.font = '300 78px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`PHOTO ${slot.sourceIndex + 1}`, slot.x + slot.width / 2, slot.y + slot.height / 2);
    ctx.font = '300 36px Arial';
    ctx.fillText(`${slot.width} x ${slot.height}`, slot.x + slot.width / 2, slot.y + slot.height / 2 + 82);
    ctx.fillText(`x ${slot.x}  y ${slot.y}`, slot.x + slot.width / 2, slot.y + slot.height / 2 + 132);
    if (style.id === 'style4' && index >= 4) {
      ctx.font = '300 32px Arial';
      ctx.fillText('DUPLICATE STRIP', slot.x + slot.width / 2, slot.y + slot.height - 46);
    }
  });

  ctx.fillStyle = '#111111';
  ctx.font = '300 64px Arial';
  ctx.textAlign = 'center';
  ctx.fillText(`${style.name.toUpperCase()} GUIDE - 2478 x 3690`, canvas.width / 2, canvas.height - 170);
  ctx.font = '300 38px Arial';
  ctx.fillText('Export your final frame as a transparent PNG with clear photo holes.', canvas.width / 2, canvas.height - 105);
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
