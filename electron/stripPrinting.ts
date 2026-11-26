/** Duplicate raw four-byte pixels without resampling or changing channel order. */
export function duplicateStripBitmap(source: Buffer, width: number, height: number): Buffer {
  if (width < 1 || height < 1 || source.length !== width * height * 4) {
    throw new Error('Invalid strip bitmap.');
  }
  const rowBytes = width * 4;
  const sheet = Buffer.alloc(source.length * 2);
  for (let y = 0; y < height; y++) {
    source.copy(sheet, y * rowBytes * 2, y * rowBytes, (y + 1) * rowBytes);
    source.copy(sheet, y * rowBytes * 2 + rowBytes, y * rowBytes, (y + 1) * rowBytes);
  }
  return sheet;
}

export const DEFAULT_SIZE_PRINTERS = { '4x6': 'DS-RX1', '2x6': 'DS-RX1-HalfCut' };

export function printerForPaperSize(
  settings: { sizePrinters?: Partial<typeof DEFAULT_SIZE_PRINTERS> },
  paperSize?: '4x6' | '2x6'
): string {
  const size = paperSize === '2x6' ? '2x6' : '4x6';
  return settings.sizePrinters?.[size]?.trim() || DEFAULT_SIZE_PRINTERS[size];
}
