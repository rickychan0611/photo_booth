import { createBlankTemplateLayout, templateDimensions } from './template';
import type { TemplateLayout, TemplateOrientation, TemplateSlot } from './types';

export const SLOT_MAP_LIMITS = {
  blackChannelMax: 80,
  minDimension: 100,
  maxPixels: 12_000_000,
  minSlots: 1,
  maxSlots: 4,
  minSlotSide: 10,
  minFillRatio: 0.95
};

export type RasterImage = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
};

export type DetectedPhotoSlot = TemplateSlot & {
  blackPixels: number;
};

type SlotMapLimits = typeof SLOT_MAP_LIMITS;

export class SlotMapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlotMapError';
  }
}

const flattenedChannel = (channel: number, alpha: number) => channel * alpha + 255 * (1 - alpha);

export const detectPhotoSlots = (image: RasterImage, limits: SlotMapLimits = SLOT_MAP_LIMITS): DetectedPhotoSlot[] => {
  const { width, height, data } = image;
  if (width < limits.minDimension || height < limits.minDimension) {
    throw new SlotMapError(`The map must be at least ${limits.minDimension} × ${limits.minDimension} pixels. This file is ${width} × ${height}.`);
  }
  if (width * height > limits.maxPixels) {
    throw new SlotMapError(`The map is too large. Maximum size is ${limits.maxPixels / 1_000_000} megapixels. This file is ${width} × ${height}.`);
  }

  const pixelCount = width * height;
  const black = new Uint8Array(pixelCount);
  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * 4;
    const alpha = data[offset + 3] / 255;
    const red = flattenedChannel(data[offset], alpha);
    const green = flattenedChannel(data[offset + 1], alpha);
    const blue = flattenedChannel(data[offset + 2], alpha);
    if (red < limits.blackChannelMax && green < limits.blackChannelMax && blue < limits.blackChannelMax) black[index] = 1;
  }

  const visited = new Uint8Array(pixelCount);
  const stack = new Int32Array(pixelCount);
  const tinyLimit = Math.max(16, Math.floor((width * height) / 10000));
  const slots: DetectedPhotoSlot[] = [];
  let rejected = 0;

  for (let start = 0; start < pixelCount; start += 1) {
    if (!black[start] || visited[start]) continue;
    let top = 0;
    stack[top] = start;
    top += 1;
    visited[start] = 1;
    let count = 0;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    while (top > 0) {
      top -= 1;
      const index = stack[top];
      const x = index % width;
      const y = (index / width) | 0;
      count += 1;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (x > 0) pushNeighbor(black, visited, stack, index - 1, top, (next) => { top = next; });
      if (x + 1 < width) pushNeighbor(black, visited, stack, index + 1, top, (next) => { top = next; });
      if (y > 0) pushNeighbor(black, visited, stack, index - width, top, (next) => { top = next; });
      if (y + 1 < height) pushNeighbor(black, visited, stack, index + width, top, (next) => { top = next; });
    }

    if (count < tinyLimit) continue;
    const regionWidth = maxX - minX + 1;
    const regionHeight = maxY - minY + 1;
    const fill = count / (regionWidth * regionHeight);
    const solid = regionWidth >= limits.minSlotSide && regionHeight >= limits.minSlotSide && fill >= limits.minFillRatio;
    if (!solid) {
      rejected += 1;
      continue;
    }
    slots.push({
      x: minX,
      y: minY,
      width: regionWidth,
      height: regionHeight,
      sourceIndex: 0,
      rotation: 0,
      cropY: 'center',
      blackPixels: count
    });
  }

  if (rejected > 0) {
    throw new SlotMapError(
      rejected === 1
        ? 'One black shape is not a solid rectangle. Use filled rectangles, leave white gaps between them, and leave out outlines, text, and artwork.'
        : `${rejected} black shapes are not solid rectangles. Use filled rectangles, leave white gaps between them, and leave out outlines, text, and artwork.`
    );
  }
  if (slots.length < limits.minSlots) {
    throw new SlotMapError('No photo slots found. Paint solid black rectangles on a white canvas.');
  }
  if (slots.length > limits.maxSlots) {
    throw new SlotMapError(`Found ${slots.length} photo slots. This booth accepts ${limits.minSlots}–${limits.maxSlots}.`);
  }

  slots.sort((a, b) => a.y - b.y || a.x - b.x);
  return slots.map((slot, index) => ({ ...slot, sourceIndex: index }));
};

const pushNeighbor = (
  black: Uint8Array,
  visited: Uint8Array,
  stack: Int32Array,
  index: number,
  top: number,
  setTop: (top: number) => void
) => {
  if (!black[index] || visited[index]) return;
  visited[index] = 1;
  stack[top] = index;
  setTop(top + 1);
};

export const orientationForMap = (width: number, height: number): TemplateOrientation =>
  width > height ? 'landscape' : 'portrait';

export const scaleSlotsToDesign = (
  slots: TemplateSlot[],
  mapWidth: number,
  mapHeight: number,
  orientation: TemplateOrientation = orientationForMap(mapWidth, mapHeight)
): { paperWidth: number; paperHeight: number; photoWindows: TemplateSlot[] } => {
  const { width: paperWidth, height: paperHeight } = templateDimensions(orientation);
  const scaleX = paperWidth / mapWidth;
  const scaleY = paperHeight / mapHeight;
  const photoWindows = slots.map((slot, index) => {
    let x = Math.round(slot.x * scaleX);
    let y = Math.round(slot.y * scaleY);
    let width = Math.max(1, Math.round(slot.width * scaleX));
    let height = Math.max(1, Math.round(slot.height * scaleY));
    x = Math.max(0, Math.min(x, paperWidth - 1));
    y = Math.max(0, Math.min(y, paperHeight - 1));
    width = Math.min(width, paperWidth - x);
    height = Math.min(height, paperHeight - y);
    return {
      x,
      y,
      width,
      height,
      sourceIndex: index,
      rotation: 0 as const,
      cropY: slot.cropY === 'top' ? 'top' as const : 'center' as const
    };
  });
  return { paperWidth, paperHeight, photoWindows };
};

export const layoutFromDetectedSlots = (
  name: string,
  mapWidth: number,
  mapHeight: number,
  slots: TemplateSlot[]
): TemplateLayout => {
  const orientation = orientationForMap(mapWidth, mapHeight);
  const scaled = scaleSlotsToDesign(slots, mapWidth, mapHeight, orientation);
  const layout = createBlankTemplateLayout(name.trim() || 'Template', orientation);
  return {
    ...layout,
    orientation,
    paperWidth: scaled.paperWidth,
    paperHeight: scaled.paperHeight,
    photoWindows: scaled.photoWindows,
    photosToTake: scaled.photoWindows.length
  };
};

export const renderSlotMapThumbnail = (
  layout: Pick<TemplateLayout, 'paperWidth' | 'paperHeight' | 'photoWindows'>,
  maxEdge = 360
) => {
  const aspect = layout.paperWidth / layout.paperHeight;
  const width = aspect >= 1 ? maxEdge : Math.max(1, Math.round(maxEdge * aspect));
  const height = aspect >= 1 ? Math.max(1, Math.round(maxEdge / aspect)) : maxEdge;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not draw the template thumbnail.');
  ctx.fillStyle = '#161616';
  ctx.fillRect(0, 0, width, height);
  const border = Math.max(2, Math.round(Math.min(width, height) * 0.02));
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = border;
  ctx.strokeRect(border / 2, border / 2, width - border, height - border);
  const scaleX = width / layout.paperWidth;
  const scaleY = height / layout.paperHeight;
  ctx.lineWidth = Math.max(1, Math.round(border * 0.65));
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${Math.max(12, Math.round(Math.min(width, height) * 0.08))}px sans-serif`;
  layout.photoWindows.forEach((slot, index) => {
    const x = slot.x * scaleX;
    const y = slot.y * scaleY;
    const slotWidth = slot.width * scaleX;
    const slotHeight = slot.height * scaleY;
    ctx.strokeRect(x, y, slotWidth, slotHeight);
    ctx.fillText(String(index + 1), x + slotWidth / 2, y + slotHeight / 2);
  });
  return canvas.toDataURL('image/png');
};

export const loadRasterFromFile = (file: File) =>
  new Promise<RasterImage>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) {
        URL.revokeObjectURL(url);
        reject(new Error('Could not read the template map.'));
        return;
      }
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0);
      const raster = ctx.getImageData(0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve({ width: raster.width, height: raster.height, data: raster.data });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read the template map. Use a PNG.'));
    };
    image.src = url;
  });
