import type { AppSettings, AudioChannel, AudioCue } from './types';

const activeAudio = new Map<string, HTMLAudioElement>();
const activeLoopTimers = new Map<string, number>();
const activeLoopTimerChannels = new Map<string, AudioChannel>();
const cueTokens = new Map<string, number>();
const preparedAudio = new Map<string, { key: string; audio: Promise<HTMLAudioElement | undefined> }>();

// Load and decode screen narration while the guest is still taking photos.
export const preloadAudioCue = (settings: AppSettings, cue: AudioCue | undefined) => {
  if (!settings.audio.enabled || !cue?.enabled || !cue.filePath ||
      (cue.mode !== 'mp3' && cue.mode !== 'host') ||
      (cue.mode === 'host' && !settings.audio.enableHostVoice)) return Promise.resolve(undefined);
  const key = JSON.stringify([cue.filePath, cue.updatedAt]);
  const existing = preparedAudio.get(cue.id);
  if (existing?.key === key) return existing.audio;
  const audio = window.photoBooth.getAudioDataUrl(cue.filePath).then(dataUrl => {
    if (!dataUrl) return undefined;
    const element = new Audio(dataUrl);
    element.preload = 'auto';
    element.load();
    return element;
  }).catch(error => {
    if (preparedAudio.get(cue.id)?.key === key) preparedAudio.delete(cue.id);
    console.warn('Audio cue could not preload.', error);
    return undefined;
  });
  preparedAudio.set(cue.id, { key, audio });
  return audio;
};

const invalidateCue = (cueId: string) => {
  const token = (cueTokens.get(cueId) ?? 0) + 1;
  cueTokens.set(cueId, token);
  return token;
};

const isCueCurrent = (cueId: string, token: number) => cueTokens.get(cueId) === token;

const channelVolume = (settings: AppSettings, channel: AudioChannel) => {
  if (channel === 'music') return settings.audio.musicVolume;
  if (channel === 'sfx') return settings.audio.sfxVolume;
  return settings.audio.voiceVolume * settings.audio.volume;
};

const cueVolume = (settings: AppSettings, cue: AudioCue) =>
  Math.min(1, Math.max(0, settings.audio.masterVolume * channelVolume(settings, cue.channel) * cue.volume));

// Editor transport shares the existing cue registry, channel levels and cleanup.
export function seekAudioCue(id: string, seconds: number) { const audio = activeAudio.get(id); if (audio && Number.isFinite(seconds)) audio.currentTime = Math.max(0, Math.min(Number.isFinite(audio.duration) ? audio.duration : seconds, seconds)); }
export function pauseAudioCue(id: string) { activeAudio.get(id)?.pause(); }
export function getAudioCueElement(id: string) { return activeAudio.get(id) ?? null; }
export async function resumeAudioCue(id: string) { await activeAudio.get(id)?.play(); }

export const stopAudioCue = (cueId: string) => {
  invalidateCue(cueId);
  const timer = activeLoopTimers.get(cueId);
  if (timer) {
    window.clearTimeout(timer);
    activeLoopTimers.delete(cueId);
    activeLoopTimerChannels.delete(cueId);
  }
  const audio = activeAudio.get(cueId);
  if (audio) {
    audio.pause();
    audio.src = '';
    activeAudio.delete(cueId);
  }
};

export const stopAudioChannel = (channel: AudioChannel) => {
  activeLoopTimers.forEach((_timer, cueId) => {
    if (activeLoopTimerChannels.get(cueId) === channel) stopAudioCue(cueId);
  });
  activeAudio.forEach((audio, cueId) => {
    if (audio.dataset.channel === channel) stopAudioCue(cueId);
  });
};

export const stopAllAudio = () => {
  [...activeAudio.keys()].forEach(stopAudioCue);
};

export const playAudioCueObject = async (settings: AppSettings, cue: AudioCue | undefined, fallbackText = '', preparedDataUrl?: string) => {
  const cueId = cue?.id ?? '';
  if (!settings.audio.enabled || !cue?.enabled || cue.mode === 'off') {
    if (cue?.channel === 'voice') stopAudioChannel('voice');
    else stopAudioCue(cueId);
    return;
  }
  const existingAudio = activeAudio.get(cueId);
  if (existingAudio && cue.loop && existingAudio.dataset.filePath === cue.filePath) {
    existingAudio.volume = cueVolume(settings, cue);
    return;
  }
  if (cue.channel === 'voice') stopAudioChannel('voice');
  else stopAudioCue(cueId);
  const token = invalidateCue(cueId);
  if (cue.mode === 'host' && (!settings.audio.enableHostVoice || !cue.filePath)) return;

  if ((cue.mode === 'mp3' || cue.mode === 'host') && cue.filePath) {
    const prepared = preparedAudio.get(cueId);
    const preloaded = !preparedDataUrl && prepared?.key === JSON.stringify([cue.filePath, cue.updatedAt])
      ? await prepared.audio : undefined;
    if (preloaded && preparedAudio.get(cueId) === prepared) preparedAudio.delete(cueId);
    if (!isCueCurrent(cueId, token)) return;
    const dataUrl = preloaded ? undefined : preparedDataUrl ?? await window.photoBooth.getAudioDataUrl(cue.filePath);
    if (!isCueCurrent(cueId, token)) return;
    if (!preloaded && !dataUrl) return;
    const audio = preloaded ?? new Audio(dataUrl);
    const useRepeatTimer = cueId === 'welcome' && cue.loop;
    audio.loop = cue.loop && !useRepeatTimer;
    audio.volume = cueVolume(settings, cue);
    audio.dataset.channel = cue.channel;
    audio.dataset.filePath = cue.filePath;
    activeAudio.set(cueId, audio);
    audio.addEventListener('ended', () => {
      if (!isCueCurrent(cueId, token)) return;
      activeAudio.delete(cueId);
      if (useRepeatTimer) {
        const timer = window.setTimeout(() => {
          if (!isCueCurrent(cueId, token)) return;
          activeLoopTimers.delete(cueId);
          activeLoopTimerChannels.delete(cueId);
          void playAudioCue(settings, cueId, fallbackText);
        }, Math.max(3, settings.audio.welcomeRepeatSeconds) * 1000);
        activeLoopTimers.set(cueId, timer);
        activeLoopTimerChannels.set(cueId, cue.channel);
      }
    });
    try {
      await audio.play();
      if (!isCueCurrent(cueId, token)) {
        audio.pause();
        audio.src = '';
        if (activeAudio.get(cueId) === audio) activeAudio.delete(cueId);
      }
    } catch (error) {
      console.warn('Audio cue could not play.', error);
      activeAudio.delete(cueId);
    }
    return;
  }
};

export const playAudioCue = async (settings: AppSettings, cueId: string, fallbackText = '') =>
  playAudioCueObject(settings, settings.audio.cues[cueId], fallbackText);
