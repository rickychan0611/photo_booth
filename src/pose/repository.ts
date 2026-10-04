import { BUNDLED_SCENES, PHOTO_GUIDE_SCENES } from './scenes';
import { validateScene } from './validation';
import type { PoseCatalog } from './types';

export async function loadPoseCatalog(): Promise<PoseCatalog> {
  try {
    const custom = await window.photoBooth.listPoses();
    const poses = [...BUNDLED_SCENES]; const errors = [...custom.errors];
    for (const candidate of custom.poses) try { const scene = validateScene(candidate); if (!poses.some(pose => pose.id === scene.id)) poses.push(scene); else errors.push(`Duplicate pose ID: ${scene.id}`); } catch (error) { errors.push(String(error)); }
    return { poses, errors };
  } catch (error) { return { poses: [...BUNDLED_SCENES], errors: [`Custom poses unavailable: ${String(error)}`] }; }
}

export async function loadPhotoGuideCatalog(): Promise<PoseCatalog> {
  const catalog = await loadPoseCatalog();
  const customImages = catalog.poses.filter(pose => pose.visual?.kind === 'photo-cutout');
  const poses = [...PHOTO_GUIDE_SCENES];
  for (const pose of customImages) if (!poses.some(item => item.id === pose.id)) poses.push(pose);
  return { poses, errors: catalog.errors };
}
