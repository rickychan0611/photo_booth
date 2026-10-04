import type { PoseScene } from './poseTypes';

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const fail = (message: string): never => { throw new Error(`Invalid pose: ${message}`); };
const validPoseAsset = (value: string) => /^pose-guides\/[a-z0-9-]+\.webp$/.test(value)
  || /^browser-pose-image-[0-9a-f-]{8,}$/i.test(value)
  || (/^(?:[A-Za-z]:[\\/]|\/)/.test(value) && !value.includes('..') && /\.webp$/i.test(value) && !/^https?:/i.test(value));

export function validateScene(value: unknown): PoseScene {
  if (!record(value) || value.schemaVersion !== 2) fail('scene version');
  const scene = value as unknown as PoseScene;
  for (const key of ['id', 'name', 'category', 'instruction'] as const) if (typeof scene[key] !== 'string' || !scene[key].trim()) fail(`missing ${key}`);
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(scene.id)) fail('safe scene id');
  if (!Array.isArray(scene.tags) || scene.tags.some(tag => typeof tag !== 'string')) fail('tags');
  if (!record(scene.compatibility) || !Array.isArray(scene.compatibility.styles) || !scene.compatibility.styles.length || scene.compatibility.styles.some(style => !['solo', 'couple', 'friends', 'family', 'group'].includes(style))) fail('styles');
  if (typeof scene.compatibility.childSafe !== 'boolean') fail('child compatibility');
  if (!Array.isArray(scene.compatibility.framing) || !scene.compatibility.framing.length || scene.compatibility.framing.some(frame => !['full', 'half'].includes(frame))) fail('framing');
  if (!Number.isInteger(scene.compatibility.minPeople) || !finite(scene.compatibility.minPeople, 1, 30)) fail('minimum people');
  if (scene.compatibility.maxPeople !== null && (!Number.isInteger(scene.compatibility.maxPeople) || !finite(scene.compatibility.maxPeople, scene.compatibility.minPeople, 30))) fail('maximum people');
  if (!Array.isArray(scene.roles) || !scene.roles.length || scene.roles.length > 12) fail('roles');
  for (const role of scene.roles) {
    if (!record(role) || !['men', 'women', 'boys', 'girls', 'adult', 'child', 'any'].includes(role.role) || typeof role.repeatable !== 'boolean') fail('role');
  }
  if (scene.compatibility.maxPeople === null && !scene.roles.some(role => role.repeatable)) fail('flexible scene needs repeatable role');
  if (!record(scene.animation) || !finite(scene.animation.durationMs, 1, 120000)) fail('durationMs');
  const end = scene.animation.durationMs;
  if (!Array.isArray(scene.animation.captions) || !scene.animation.captions.length || scene.animation.captions.length > 64) fail('captions');
  let last = -1;
  for (const caption of scene.animation.captions) {
    if (!record(caption) || !finite(caption.timeMs, 0, end) || caption.timeMs <= last || typeof caption.text !== 'string' || !caption.text.trim()) fail('caption timestamps');
    last = caption.timeMs;
  }
  if (scene.animation.captions[0].timeMs !== 0) fail('captions must start at zero');
  if (scene.visual !== undefined) {
    if (!record(scene.visual) || scene.visual.kind !== 'photo-cutout') fail('scene visual');
    if (typeof scene.visual.assetPath !== 'string' || !validPoseAsset(scene.visual.assetPath)) fail('scene visual asset');
    if (typeof scene.visual.alt !== 'string' || !scene.visual.alt.trim()) fail('scene visual alt');
    if (typeof scene.visual.accent !== 'string' || !/^#[0-9a-f]{6}$/i.test(scene.visual.accent)) fail('scene visual accent');
    if (scene.visual.scale !== undefined && !finite(scene.visual.scale, 0.6, 1.4)) fail('scene visual scale');
    if (scene.visual.offsetX !== undefined && !finite(scene.visual.offsetX, -120, 120)) fail('scene visual offset');
    if (scene.visual.offsetY !== undefined && !finite(scene.visual.offsetY, -80, 80)) fail('scene visual offset');
  }
  if (scene.audio !== undefined) {
    if (!record(scene.audio) || typeof scene.audio.filePath !== 'string' || /^https?:/i.test(scene.audio.filePath)) fail('audio must be local');
    if (scene.audio.startMs !== undefined && !finite(scene.audio.startMs, 0, end)) fail('audio startMs');
    const markers = scene.audio.markers ?? [];
    if (!Array.isArray(markers) || markers.length > 64) fail('audio markers');
    let markerTime = -1;
    for (const marker of markers) {
      if (!record(marker) || typeof marker.id !== 'string' || !marker.id.trim() || !finite(marker.timeMs, 0, end) || marker.timeMs <= markerTime) fail('audio marker');
      markerTime = marker.timeMs;
    }
    if (new Set(markers.map(marker => marker.id)).size !== markers.length) fail('duplicate audio marker');
  }
  for (const caption of scene.animation.captions) {
    if (caption.markerId !== undefined && (!scene.audio?.markers?.some(marker => marker.id === caption.markerId) || !finite(caption.markerOffsetMs ?? 0, -120000, 120000))) fail('caption marker');
    if (caption.markerId && caption.timeMs !== scene.audio!.markers!.find(marker => marker.id === caption.markerId)!.timeMs + (caption.markerOffsetMs ?? 0)) fail('caption marker timing');
  }
  return scene;
}
