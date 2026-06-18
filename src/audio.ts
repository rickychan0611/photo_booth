import type { AppSettings, AudioChannel, AudioCue } from './types';

const activeAudio = new Map<string, HTMLAudioElement>();
const activeLoopTimers = new Map<string, number>();
const activeLoopTimerChannels = new Map<string, AudioChannel>();
const cueTokens = new Map<string, number>();

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

export const playAudioCueObject = async (settings: AppSettings, cue: AudioCue | undefined, fallbackText = '') => {
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
    const dataUrl = await window.photoBooth.getAudioDataUrl(cue.filePath);
    if (!isCueCurrent(cueId, token)) return;
    if (!dataUrl) return;
    const audio = new Audio(dataUrl);
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
