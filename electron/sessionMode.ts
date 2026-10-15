import type { AudioCue, WorkflowShotSettings } from './types';

export type SessionMode = 'fun' | 'normal';
export const NORMAL_PHOTO_MESSAGE = 'Look at the camera and smile!';
export const MODE_NARRATION = 'Choose your photo experience. Tap Fun Pose Challenge for playful guided poses, or Normal Mode for classic photos.';

export const needsGroupSelection = (mode: SessionMode, selectionEnabled: boolean) => mode === 'fun' && selectionEnabled;

export const modeAudioDefaults = (): Record<string, AudioCue> => Object.fromEntries([
  ['mode', 'Choose mode screen', MODE_NARRATION],
  ...Array.from({ length: 12 }, (_, index) => [`normalShot${index}`, `Normal Mode photo ${index + 1} voice`, NORMAL_PHOTO_MESSAGE])
].map(([id, label, text]) => [id, { id, label, text, mode: 'host', channel: 'voice', filePath: '', loop: false, volume: 1, enabled: true, updatedAt: '' }]));

export function photoForMode(shot: WorkflowShotSettings, cues: Record<string, AudioCue>, index: number, mode: SessionMode): WorkflowShotSettings {
  return {
    ...shot,
    message: mode === 'normal' ? shot.normalMessage ?? NORMAL_PHOTO_MESSAGE : shot.message,
    audioCue: mode === 'normal' ? cues[`normalShot${index}`] : cues[`shot${index}`] ?? shot.audioCue
  };
}
