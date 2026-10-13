export function isBundledPoseAsset(assetPath: string) {
  return /^pose-guides\/[a-z0-9-]+\.webp$/.test(assetPath);
}

export async function resolvePoseAsset(assetPath: string): Promise<string> {
  if (isBundledPoseAsset(assetPath)) return new URL(assetPath, window.location.href).href;
  if (assetPath.startsWith('project-asset:')) {
    return new URL(`project-assets/${assetPath.slice('project-asset:'.length).replace(/^[/\\]+/, '')}`, window.location.href).href;
  }
  if (assetPath.startsWith('browser-pose-image-')) return localStorage.getItem(assetPath) ?? '';
  try { return await window.photoBooth.getImageDataUrl(assetPath); }
  catch { return ''; }
}
