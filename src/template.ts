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
  x: number,
  y: number,
  width: number,
  height: number
) => {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, width, height);
  ctx.clip();
  fillImage(ctx, image, x, y, width, height);
  ctx.restore();
};

const fitImage = (
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  width: number,
  height: number
) => {
  const scale = Math.min(width / image.width, height / image.height);
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  ctx.drawImage(image, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
};

const createPrintCanvas = () => {
  const canvas = document.createElement('canvas');
  canvas.width = 1239;
  canvas.height = 1845;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available.');
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return { canvas, ctx };
};

export async function createFinalImage(photoDataUrl: string) {
  return createSinglePrintImage(photoDataUrl);
}

export async function createSinglePrintImage(photoDataUrl: string) {
  const { canvas, ctx } = createPrintCanvas();
  const photo = await loadImage(photoDataUrl);
  fillImage(ctx, photo, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}

export async function createGridPrintImage(photoDataUrls: string[]) {
  const { canvas, ctx } = createPrintCanvas();
  const photos = await Promise.all(photoDataUrls.slice(0, 4).map((dataUrl) => loadImage(dataUrl)));
  const cellWidth = canvas.width / 2;
  const cellHeight = canvas.height / 2;

  photos.forEach((photo, index) => {
    const col = index % 2;
    const row = Math.floor(index / 2);
    const x = col * cellWidth;
    const y = row * cellHeight;
    fillImageClipped(ctx, photo, x, y, cellWidth, cellHeight);
  });

  return canvas.toDataURL('image/png');
}
