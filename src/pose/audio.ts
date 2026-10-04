import { playAudioCueObject, stopAudioCue } from '../audio';
import type { AppSettings } from '../types';
import type { PoseAudioHooks } from './types';

const CUE_ID = 'pose-narration';

export function createPoseAudioHooks(getSettings: () => AppSettings): PoseAudioHooks {
  let dataUrl = '';
  let generation = 0;
  return {
    async prepare(pose, signal) {
      const token = ++generation;
      dataUrl = '';
      if (!pose.audio?.filePath || !getSettings().audio.enabled || signal.aborted) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: () => void = () => undefined;
      try {
        // A missing or slow local file must never hold up the shooting session.
        const result = await Promise.race([
          window.photoBooth.getAudioDataUrl(pose.audio.filePath),
          new Promise<string>((resolve) => {
            timer = setTimeout(() => resolve(''), 1500);
            onAbort = () => resolve('');
            signal.addEventListener('abort', onAbort, { once: true });
          })
        ]);
        if (token === generation && !signal.aborted) dataUrl = result;
      } catch (error) { console.warn('Pose narration unavailable; continuing silently.', error); }
      finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); }
    },
    start(pose) {
      if (!dataUrl || !pose.audio?.filePath) return;
      return playAudioCueObject(getSettings(), {
        id: CUE_ID, label: pose.name, mode: 'mp3', channel: 'voice', text: pose.instruction,
        filePath: pose.audio.filePath, loop: false, volume: 1, enabled: true, updatedAt: ''
      }, pose.instruction, dataUrl);
    },
    stop() { ++generation; dataUrl = ''; stopAudioCue(CUE_ID); }
  };
}
