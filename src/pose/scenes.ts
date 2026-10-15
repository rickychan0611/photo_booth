import bundledScenes from './poses/scenes.json';
import photoAssets from './poses/photo-assets.json';
import narrationAssets from './poses/narration-assets.json';
import { validateScene } from './validation';
import { fitPoseToNarration } from './timing';
import type { GuestComposition, ParticipantRole, PoseFraming, PoseRole, PoseScene, SceneFrame } from './types';

export const EMPTY_COMPOSITION: GuestComposition = { men: 0, women: 0, boys: 0, girls: 0, style: 'group' };
export const totalPeople = (group: GuestComposition) => group.men + group.women + group.boys + group.girls;
export function validateComposition(group: GuestComposition, capacity = 30) {
  if (['men', 'women', 'boys', 'girls'].some(key => !Number.isInteger(group[key as 'men']) || group[key as 'men'] < 0) || totalPeople(group) < 1 || totalPeople(group) > capacity) throw new Error('Choose at least one person, within the group capacity.');
  if (!['solo', 'couple', 'friends', 'family', 'group'].includes(group.style)) throw new Error('Choose a pose style.');
  if (group.style === 'couple' && (group.men + group.women !== 2 || group.boys + group.girls !== 0)) throw new Error('Couple poses are for two adults.');
  if ((totalPeople(group) === 1) !== (group.style === 'solo')) throw new Error('Solo style needs one person.');
  return group;
}
export function slotGeometry(slot: { width: number; height: number; rotation?: number }) {
  const rotated = slot.rotation === 90 || slot.rotation === 270;
  return { width: rotated ? slot.height : slot.width, height: rotated ? slot.width : slot.height };
}
export function slotFraming(slot: { width: number; height: number; rotation?: number }): PoseFraming {
  const { width, height } = slotGeometry(slot);
  return height > width ? 'full' : 'half';
}

export function captionAt(scene: PoseScene, elapsedMs: number): SceneFrame {
  const time = Math.max(0, Math.min(scene.animation.durationMs, elapsedMs));
  const captions = scene.animation.captions.map(caption => ({
    text: caption.text,
    timeMs: caption.markerId ? (scene.audio?.markers?.find(marker => marker.id === caption.markerId)?.timeMs ?? caption.timeMs) + (caption.markerOffsetMs ?? 0) : caption.timeMs
  }));
  return { caption: [...captions].reverse().find(item => item.timeMs <= time)?.text ?? '', elapsedMs: time };
}

const accept: Record<ParticipantRole, Array<'men' | 'women' | 'boys' | 'girls'>> = {
  men: ['men'], women: ['women'], boys: ['boys'], girls: ['girls'], adult: ['men', 'women'], child: ['boys', 'girls'], any: ['men', 'women', 'boys', 'girls']
};
function expandedRoles(scene: PoseScene, total: number): PoseRole[] | null {
  if (total < scene.roles.length) return null;
  const result = [...scene.roles];
  const repeat = scene.roles.filter(role => role.repeatable);
  while (result.length < total) {
    if (!repeat.length) return null;
    result.push(repeat[(result.length - scene.roles.length) % repeat.length]);
  }
  return result;
}
export function sceneMatches(scene: PoseScene, group: GuestComposition, framing: PoseFraming, relaxIdentity = false) {
  const count = totalPeople(group), rules = scene.compatibility;
  if (count < rules.minPeople || (rules.maxPeople !== null && count > rules.maxPeople) || !group.style || !rules.styles.includes(group.style) || !rules.framing.includes(framing)) return false;
  if (relaxIdentity) return true;
  if ((group.boys + group.girls > 0) && !rules.childSafe) return false;
  const roles = expandedRoles(scene, count)?.map(role => role.role).sort((a, b) => accept[a].length - accept[b].length);
  if (!roles) return false;
  const remaining = { men: group.men, women: group.women, boys: group.boys, girls: group.girls };
  const match = (index: number): boolean => {
    if (index === roles.length) return true;
    for (const type of accept[roles[index]]) if (remaining[type] > 0) {
      remaining[type]--; if (match(index + 1)) return true; remaining[type]++;
    }
    return false;
  };
  return match(0);
}
export class RandomSceneSelector {
  private bags = new Map<string, PoseScene[]>();
  private previous = '';
  constructor(private catalog: PoseScene[], private random: () => number = Math.random) {}
  private pool(group: GuestComposition, framing: PoseFraming, relaxIdentity: boolean) {
    const matches = (scene: PoseScene) => sceneMatches(scene, group, framing, relaxIdentity);
    let candidates = this.catalog.filter(scene => matches(scene) && !scene.tags.includes('fallback'));
    if (!candidates.length) candidates = this.catalog.filter(scene => matches(scene) && scene.tags.includes('fallback'));
    return candidates;
  }
  next(group: GuestComposition, framing: PoseFraming): PoseScene | null {
    let candidates = this.pool(group, framing, false);
    if (!candidates.length) candidates = this.pool(group, framing, true);
    if (!candidates.length) return null;
    const key = candidates.map(scene => scene.id).sort().join('|');
    let bag = this.bags.get(key);
    if (!bag?.length) {
      bag = [...candidates];
      for (let index = bag.length - 1; index > 0; index--) { const other = Math.floor(Math.max(0, Math.min(.999999, this.random())) * (index + 1)); [bag[index], bag[other]] = [bag[other], bag[index]]; }
      this.bags.set(key, bag);
    }
    if (bag.length > 1 && bag.at(-1)?.id === this.previous) [bag[0], bag[bag.length - 1]] = [bag[bag.length - 1], bag[0]];
    const selected = bag.pop()!; this.previous = selected.id;
    return structuredClone(selected);
  }
}

const photoAssetsById = new Map(photoAssets.map(asset => [asset.id, asset]));
function withPhotoCutout(scene: PoseScene): PoseScene {
  const asset = photoAssetsById.get(scene.id);
  if (!asset) return scene;
  return validateScene({
    ...scene,
    visual: {
      kind: 'photo-cutout',
      assetPath: asset.assetPath,
      alt: asset.alt,
      accent: asset.accent
    }
  });
}

export function withNarration(scene: PoseScene): PoseScene {
  if (scene.audio?.filePath) return validateScene(fitPoseToNarration(scene));
  const narration = (narrationAssets as Record<string, { filePath: string; durationMs: number; cues: string[] }>)[scene.id];
  if (!narration) return validateScene(fitPoseToNarration(scene));
  return validateScene(fitPoseToNarration({ ...scene,
    audio: { filePath: narration.filePath, startMs: 0, markers: [] },
    animation: { durationMs: narration.durationMs + 1000, captions: narration.cues.map(text => ({ text, timeMs: 0 })) }
  }, narration.durationMs));
}
export const BUNDLED_SCENES: PoseScene[] = bundledScenes.map(scene => validateScene(scene)).map(withPhotoCutout);
export const PHOTO_GUIDE_SCENES = BUNDLED_SCENES.filter(scene => scene.visual?.kind === 'photo-cutout');
