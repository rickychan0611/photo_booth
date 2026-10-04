import bundledScenes from './poses/scenes.json';
import { validateScene } from './validation';
import type { GuestComposition, ParticipantRole, PoseFraming, PoseRole, PoseScene, PoseStyle, SceneFrame } from './types';

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

const cutout = (assetPath: string, alt: string, accent: string): NonNullable<PoseScene['visual']> => ({ kind: 'photo-cutout', assetPath, alt, accent });
const PHOTO_PILOT: Record<string, { visual: NonNullable<PoseScene['visual']>; framing?: PoseFraming[]; styles?: PoseStyle[] }> = {
  'peace-and-wink': { visual: cutout('pose-guides/peace-power.webp', 'A smiling guest points at the camera while making a peace sign and winking.', '#1769ff'), framing: ['half'] },
  'runway-cross-step': { visual: cutout('pose-guides/runway-step.webp', 'A confident guest crosses one leg in front while posing with one hand on the hip.', '#ff168f') },
  'superhero-landing': { visual: cutout('pose-guides/hero-landing.webp', 'A guest holds a low superhero landing pose with one arm raised.', '#ef2929') },
  'vogue-geometry': { visual: cutout('pose-guides/vogue-angles.webp', 'A guest creates strong fashion angles with both arms around the face.', '#7d22c9') },
  'back-to-back-agents': { visual: cutout('pose-guides/back-to-back.webp', 'Two guests stand back-to-back and pose like playful secret agents.', '#ffd21a') },
  'forehead-touch': { visual: cutout('pose-guides/sweet-moment.webp', 'Two guests smile with their foreheads gently touching.', '#ff665f') },
  'secret-and-shock': { visual: cutout('pose-guides/secret-shock.webp', 'One friend whispers while the other reacts with exaggerated surprise.', '#ff8214'), styles: ['friends'] },
  'anime-squad-three': { visual: cutout('pose-guides/anime-squad.webp', 'Three guests form a dramatic triangular hero team.', '#08cbe8') },
  'family-superhero-team': { visual: cutout('pose-guides/family-power.webp', 'A family forms a cheerful superhero team with children in front.', '#ffd21a') },
  'emotion-explosion-four': { visual: cutout('pose-guides/emotion-explosion.webp', 'Four friends crowd together with four exaggerated facial expressions.', '#8227d9') },
  'action-movie-diamond': { visual: cutout('pose-guides/action-diamond.webp', 'Four guests overlap in a dramatic action-movie diamond formation.', '#ef2929'), framing: ['full'] },
  'many-armed-idol': { visual: cutout('pose-guides/many-arms.webp', 'Six friends overlap to create a playful many-armed illusion.', '#0a9f9f') }
};
function withPhotoPilot(scene: PoseScene): PoseScene {
  const pilot = PHOTO_PILOT[scene.id];
  if (!pilot) return scene;
  return validateScene({ ...scene, visual: pilot.visual, compatibility: { ...scene.compatibility, ...(pilot.framing ? { framing: pilot.framing } : {}), ...(pilot.styles ? { styles: pilot.styles } : {}) } });
}

export const BUNDLED_SCENES: PoseScene[] = bundledScenes.map(scene => validateScene(scene)).map(withPhotoPilot);
export const PHOTO_GUIDE_SCENES = BUNDLED_SCENES.filter(scene => scene.visual?.kind === 'photo-cutout');
