import { BUNDLED_SCENES, withNarration } from './scenes';
import { validateScene } from './validation';
import type { PoseCatalog } from './types';

export async function loadPoseCatalog(): Promise<PoseCatalog> {
  try {
    const custom = await window.photoBooth.listPoses();
    const poses = [...BUNDLED_SCENES]; const errors = [...custom.errors];
    for (const candidate of custom.poses) try {
      const scene = validateScene(candidate);
      const index = poses.findIndex(pose => pose.id === scene.id);
      if (index < 0) poses.push(scene);
      else poses[index] = scene;
    } catch (error) { errors.push(String(error)); }
    return { poses: poses.map(withNarration), errors };
  } catch (error) { return { poses: BUNDLED_SCENES.map(withNarration), errors: [`Custom poses unavailable: ${String(error)}`] }; }
}

export async function loadPhotoGuideCatalog(): Promise<PoseCatalog> {
  const catalog = await loadPoseCatalog();
  const poses = catalog.poses.filter(pose => pose.visual?.kind === 'photo-cutout');
  return { poses, errors: catalog.errors };
}
