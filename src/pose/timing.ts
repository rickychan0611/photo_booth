import type { PoseScene } from './types';
import { applySpeechTiming, hasMatchingSpeechTiming } from '../../electron/poseAlignment';

/** Aligned recordings keep their measured timings; older audio uses a temporary estimate. */
export function fitPoseToNarration(scene: PoseScene, narrationMs?: number): PoseScene {
  if (hasMatchingSpeechTiming(scene)) return applySpeechTiming(scene, scene.audio!.speechTiming!);
  const result = structuredClone(scene);
  if (result.audio) delete result.audio.speechTiming;
  if (!result.audio && !narrationMs) return result;
  const durationMs = Math.max(1, Math.min(119000, Math.round(narrationMs || scene.animation.durationMs - 1000)));
  result.animation.durationMs = durationMs + 1000;
  const count = result.animation.captions.length;
  result.animation.captions.forEach((caption, index) => {
    caption.timeMs = count === 1 ? 0 : Math.round(durationMs * index / (count - 1));
    delete caption.markerId;
    delete caption.markerOffsetMs;
  });
  if (result.audio) { result.audio.startMs = 0; result.audio.markers = []; }
  return result;
}
