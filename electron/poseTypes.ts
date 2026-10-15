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
export type SceneFrame = { caption: string; elapsedMs: number };
export type PoseCatalog = { poses: PoseScene[]; errors: string[] };
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
export type PoseGuideSettings = { enabled: boolean; selectionEnabled?: boolean; groupCapacity?: number; defaultComposition?: GuestComposition };
export function normalizePoseGuide(value: Partial<PoseGuideSettings> | undefined): PoseGuideSettings {
  const capacity = Math.max(1, Math.min(30, Math.round(Number(value?.groupCapacity) || 12)));
  const group = value?.defaultComposition;
  const total = group ? group.men + group.women + group.boys + group.girls : 0;
  const valid = group && ['men', 'women', 'boys', 'girls'].every(key => Number.isInteger(group[key as 'men']) && group[key as 'men'] >= 0) && total >= 1 && total <= capacity;
  let composition: GuestComposition = valid ? { ...group } : { men: 1, women: 0, boys: 0, girls: 0, style: 'solo' };
  if (composition.men + composition.women + composition.boys + composition.girls === 1) composition.style = 'solo';
  else if (composition.style === 'solo' || !['solo', 'couple', 'friends', 'family', 'group'].includes(composition.style) || (composition.style === 'couple' && (composition.men + composition.women !== 2 || composition.boys + composition.girls > 0))) composition.style = 'group';
  return { enabled: value?.enabled !== false, selectionEnabled: value?.selectionEnabled !== false, groupCapacity: capacity, defaultComposition: composition };
}
