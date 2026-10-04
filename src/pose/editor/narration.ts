export async function readNarration(filePath: string) {
  const dataUrl = await window.photoBooth.getAudioDataUrl(filePath);
  if (!dataUrl) throw new Error('Narration file is unavailable. Preview will be silent.');
  const audio = new Audio();
  const durationMs = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Narration metadata timed out.')); }, 5000);
    const cleanup = () => { clearTimeout(timer); audio.onloadedmetadata = null; audio.onerror = null; audio.src = ''; };
    audio.onloadedmetadata = () => { const duration = audio.duration * 1000; cleanup(); Number.isFinite(duration) && duration > 0 ? resolve(Math.round(duration)) : reject(new Error('Unknown narration duration.')); };
    audio.onerror = () => { cleanup(); reject(new Error('Narration cannot be played.')); };
    audio.src = dataUrl;
  });
  return { dataUrl, durationMs };
}
