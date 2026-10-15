/** Shares file reads and decoded previews between preloading and mounted cards. */
export function createPreviewImageCache(read: (path: string) => Promise<string>, decode: (src: string) => Promise<void>, capacity = 64) {
  const entries = new Map<string, { src: string; pending: Promise<string> }>();
  const keyFor = (path: string, version: string) => JSON.stringify([path, version]);
  return {
    peek(path: string, version = '') { return entries.get(keyFor(path, version))?.src ?? ''; },
    load(path: string, version = ''): Promise<string> {
      if (!path) return Promise.resolve('');
      const key = keyFor(path, version);
      const cached = entries.get(key);
      if (cached) return cached.pending;
      const entry = { src: '', pending: Promise.resolve('') };
      entry.pending = Promise.resolve().then(() => read(path)).then(async src => {
        if (!src) throw new Error('Preview image is unavailable.');
        await decode(src);
        entry.src = src;
        return src;
      }).catch(() => {
        if (entries.get(key) === entry) entries.delete(key);
        return '';
      });
      entries.set(key, entry);
      if (entries.size > capacity) entries.delete(entries.keys().next().value!);
      return entry.pending;
    }
  };
}

export const previewImages = createPreviewImageCache(
  path => window.photoBooth.getImageDataUrl(path),
  async src => {
    const image = new Image();
    image.src = src;
    await image.decode();
  }
);
