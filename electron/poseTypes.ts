export type Timed = { timeMs: number };
export type PoseSpeechTiming = { version: 1; audioDurationMs: number; captions: Array<Timed & { text: string }> };
export type PoseAudio = { filePath: string; startMs?: number; markers?: Array<Timed & { id: string }>; speechTiming?: PoseSpeechTiming };

export interface PoseAudioHooks {
  prepare(pose: PoseScene, signal: AbortSignal): Promise<void>;
  start(pose: PoseScene): void | Promise<void>;
  stop(): void;
  position?(): { timeMs: number; ended: boolean } | null;
}

export interface PlaybackClock {
  now(): number;
  request(callback: (time: number) => void): number;
  cancel(id: number): void;
}

export type PoseStyle = 'solo' | 'couple' | 'friends' | 'family' | 'group';
export const POSE_CATEGORIES = ['friends', 'family', 'lovers'] as const;
export type PoseCategory = typeof POSE_CATEGORIES[number];
export const POSE_CATEGORY_LABELS: Record<PoseCategory, string> = {
  friends: 'Friends',
  family: 'Family',
  lovers: 'Lovers'
};
export const POSE_CATEGORY_STYLES = { friends: 'friends', family: 'family', lovers: 'couple' } as const;
export type PoseFraming = 'full' | 'half';
export type GuestComposition = { men: number; women: number; boys: number; girls: number; style: PoseStyle | '' };
export type ParticipantRole = 'men' | 'women' | 'boys' | 'girls' | 'adult' | 'child' | 'any';
export type PoseRole = { role: ParticipantRole; repeatable: boolean };
export type PoseScene = {
  schemaVersion: 2;
  id: string;
  name: string;
  category: string;
  tags: string[];
  instruction: string;
  compatibility: { minPeople: number; maxPeople: number | null; styles: PoseStyle[]; framing: PoseFraming[]; childSafe: boolean };
  roles: PoseRole[];
  animation: {
    durationMs: number;
    captions: Array<Timed & { text: string; markerId?: string; markerOffsetMs?: number }>;
  };
  audio?: PoseAudio;
  visual?: {
    kind: 'photo-cutout';
    assetPath: string;
    alt: string;
    accent: string;
    scale?: number;
    offsetX?: number;
    offsetY?: number;
  };
};

export function poseCategories(scene: PoseScene): PoseCategory[] {
  const { styles, maxPeople } = scene.compatibility;
  if (maxPeople === 1 || scene.category.trim().toLowerCase() === 'solo' ||
      scene.tags.some(tag => tag.trim().toLowerCase() === 'solo') ||
      (scene.roles.length === 1 && !scene.roles[0].repeatable)) return [];
  return POSE_CATEGORIES.filter(category =>
    styles.includes(POSE_CATEGORY_STYLES[category]) || (category === 'friends' && styles.includes('group'))
  );
}
export type SceneFrame = { caption: string; elapsedMs: number };
export type StoredPoseLibrary = { poses: PoseScene[]; deletedPoseIds?: string[] };
export type PoseCatalog = StoredPoseLibrary & { errors: string[] };
export type PoseAiProvider = 'openai' | 'gemini' | 'xai';
export type PoseAiGenerateRequest = { description: string; provider?: PoseAiProvider };
export type PoseAiGenerateResult = { scene: PoseScene; provider: PoseAiProvider; model: string };
export type PoseNarrationModel = 'eleven_v4_turbo' | 'eleven_flash_v2_5' | 'eleven_multilingual_v2' | 'eleven_v3';
export type PoseNarrationSettings = {
  configured: boolean;
  voiceId: string;
  modelId: PoseNarrationModel;
  stability: number;
  similarityBoost: number;
  style: number;
  speed: number;
  direction: string;
};
export type PoseNarrationSettingsUpdate = Omit<PoseNarrationSettings, 'configured'> & { apiKey?: string };
export type PoseNarrationGenerateRequest = { poseId: string; text: string; captions?: string[] };
export type PoseNarrationGenerateResult = { filePath: string; name: string; cached: boolean; speechTiming?: PoseSpeechTiming };
export type PoseGuideSettings = { enabled: boolean; selectionEnabled: boolean; defaultCategory: PoseCategory };
type LegacyPoseGuideSettings = { defaultComposition?: GuestComposition };
export function normalizePoseGuide(value: (Partial<PoseGuideSettings> & LegacyPoseGuideSettings) | undefined): PoseGuideSettings {
  const legacyStyle = value?.defaultComposition?.style;
  const defaultCategory = POSE_CATEGORIES.find(category => category === value?.defaultCategory)
    ?? (legacyStyle === 'family' ? 'family' : legacyStyle === 'couple' ? 'lovers' : 'friends');
  return { enabled: value?.enabled !== false, selectionEnabled: value?.selectionEnabled !== false, defaultCategory };
}
