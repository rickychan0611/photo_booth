import type { PoseScene, PoseSpeechTiming } from './poseTypes';

export type SpeechCharacter = { text: string; start: number; end: number };
export const normalizeSpeech = (text: string) => text.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

export function timingFromCharacters(captions: string[], characters: SpeechCharacter[], audioDurationMs: number): PoseSpeechTiming {
  if (!captions.length || captions.length > 64 || !Number.isFinite(audioDurationMs) || audioDurationMs <= 0 || audioDurationMs > 119000) throw new Error('Invalid narration duration or captions.');
  const letters: Array<{ text: string; timeMs: number }> = [];
  let previous = -1;
  for (const character of characters) {
    if (typeof character.text !== 'string' || !Number.isFinite(character.start) || !Number.isFinite(character.end) || character.start < 0 || character.end < character.start || character.start < previous) throw new Error('Invalid speech alignment timestamps.');
    previous = character.start;
    for (const text of normalizeSpeech(character.text)) letters.push({ text, timeMs: Math.round(character.start * 1000) });
  }
  const transcript = letters.map(letter => letter.text).join('');
  let cursor = 0, lastTime = -1;
  const timed = captions.map((text, index) => {
    const phrase = normalizeSpeech(text);
    const position = phrase ? transcript.indexOf(phrase, cursor) : -1;
    if (position < 0) throw new Error(`Caption does not match the spoken transcript: ${text}`);
    cursor = position + phrase.length;
    const timeMs = index === 0 ? 0 : letters[position].timeMs;
    if (timeMs <= lastTime || timeMs > audioDurationMs) throw new Error(`Invalid or overlapping caption timing: ${text}`);
    lastTime = timeMs;
    return { timeMs, text };
  });
  return { version: 1, audioDurationMs, captions: timed };
}

export function hasMatchingSpeechTiming(scene: PoseScene) {
  const timing = scene.audio?.speechTiming;
  return timing?.version === 1 && timing.captions.length === scene.animation.captions.length &&
    timing.captions.every((caption, index) => normalizeSpeech(caption.text) === normalizeSpeech(scene.animation.captions[index].text));
}

export function applySpeechTiming(scene: PoseScene, timing: PoseSpeechTiming): PoseScene {
  const result = structuredClone(scene);
  result.animation = { durationMs: timing.audioDurationMs + 1000, captions: timing.captions.map(caption => ({ ...caption })) };
  if (!result.audio) throw new Error('Narration audio is required for speech timing.');
  result.audio = { ...result.audio, startMs: 0, markers: [], speechTiming: structuredClone(timing) };
  return result;
}
