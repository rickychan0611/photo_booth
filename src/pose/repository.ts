import { BUNDLED_SCENES, PHOTO_GUIDE_SCENES, withNarration } from './scenes';
import libraryOrder from './poses/library-order.json';
import { validateScene } from './validation';
import { poseCategories, type PoseCatalog, type PoseScene } from './types';

const isActiveGuide = (pose: PoseScene) => pose.visual?.kind === 'photo-cutout' && poseCategories(pose).length > 0;
const libraryPositions = new Map(libraryOrder.map((id, index) => [id, index]));
const position = (pose: PoseScene) => libraryPositions.get(pose.id) ?? libraryPositions.size;
const orderedPhotoGuides = (poses: PoseScene[]) =>
  poses.filter(isActiveGuide).sort((a, b) => position(a) - position(b));
export const BUNDLED_POSE_LIBRARY = orderedPhotoGuides(PHOTO_GUIDE_SCENES);

export async function loadPoseCatalog(): Promise<PoseCatalog> {
  try {
    const custom = await window.photoBooth.listPoses();
    const poses = new Map(BUNDLED_SCENES.map(pose => [pose.id, pose]));
    const overrides = new Map<string, PoseScene>();
    const errors = [...custom.errors];
    for (const candidate of custom.poses) try {
      const scene = validateScene(candidate);
      overrides.set(scene.id, scene);
    } catch (error) { errors.push(String(error)); }
    for (const id of [...overrides.keys()].sort()) poses.set(id, overrides.get(id)!);
    for (const id of custom.deletedPoseIds ?? []) poses.delete(id);
    return { poses: [...poses.values()].map(withNarration), errors };
  } catch (error) { return { poses: BUNDLED_SCENES.map(withNarration), errors: [`Custom poses unavailable: ${String(error)}`] }; }
}

export async function loadPhotoGuideCatalog(): Promise<PoseCatalog> {
  const catalog = await loadPoseCatalog();
  const poses = orderedPhotoGuides(catalog.poses);
  return { poses, errors: catalog.errors };
}
