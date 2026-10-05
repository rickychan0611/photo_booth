import { captionAt } from '../scenes';
import { validateScene } from '../validation';
import type { PoseScene } from '../types';

export const cloneScene = (scene: PoseScene) => structuredClone(scene);
export function fitSceneToNarration(scene: PoseScene, narrationMs: number) {
  const result = cloneScene(scene);
  const audioDurationMs = Math.max(1, Math.round(narrationMs));
  result.animation.durationMs = Math.min(120000, audioDurationMs + 1000);
  const lastCaptionMs = Math.min(audioDurationMs, result.animation.durationMs - 1);
  const count = result.animation.captions.length;
  result.animation.captions.forEach((caption, index) => {
    caption.timeMs = count === 1 ? 0 : Math.round(lastCaptionMs * index / (count - 1));
    delete caption.markerId;
    delete caption.markerOffsetMs;
  });
  if (result.audio) {
    result.audio.startMs = 0;
    result.audio.markers = [];
  }
  return validateScene(result);
}
export function addStep(scene: PoseScene, timeMs: number) {
  if (timeMs <= 0 || timeMs > scene.animation.durationMs) throw new Error('Choose a time after the starting frame.');
  const result = cloneScene(scene);
  result.animation.captions = [...result.animation.captions.filter(caption => caption.timeMs !== timeMs), { timeMs, text: captionAt(scene, timeMs).caption }].sort((a, b) => a.timeMs - b.timeMs);
  return validateScene(result);
}
export function deleteStep(scene: PoseScene, timeMs: number) {
  if (timeMs === 0) throw new Error('The starting frame cannot be deleted.');
  const result = cloneScene(scene);
  result.animation.captions = result.animation.captions.filter(frame => frame.timeMs !== timeMs);
  return validateScene(result);
}
export function moveStep(scene: PoseScene, from: number, to: number) {
  if (from === 0 || to <= 0) throw new Error('The starting frame is fixed at zero.');
  const result = cloneScene(scene);
  result.animation.captions.forEach(frame => { if (frame.timeMs === from) { frame.timeMs = to; delete frame.markerId; delete frame.markerOffsetMs; } });
  result.animation.captions.sort((a, b) => a.timeMs - b.timeMs);
  return validateScene(result);
}
export function resizeScene(scene: PoseScene, durationMs: number, stretch: boolean) {
  const result = cloneScene(scene), ratio = durationMs / scene.animation.durationMs;
  result.animation.durationMs = durationMs;
  if (stretch) {
    for (const frame of result.animation.captions) if (!frame.markerId) frame.timeMs = Math.round(frame.timeMs * ratio);
    result.animation.captions.sort((a, b) => a.timeMs - b.timeMs);
  }
  return validateScene(result);
}
export function alignStep(scene: PoseScene, timeMs: number, markerId: string) {
  const marker = scene.audio?.markers?.find(item => item.id === markerId); if (!marker) throw new Error('Choose an audio marker.');
  const source = scene.animation.captions.some(caption => caption.timeMs === timeMs) ? scene : addStep(scene, timeMs);
  const result = moveStep(source, timeMs, marker.timeMs);
  const caption = result.animation.captions.find(item => item.timeMs === marker.timeMs);
  if (caption) { caption.markerId = markerId; caption.markerOffsetMs = 0; }
  return validateScene(result);
}
export function moveMarker(scene: PoseScene, index: number, timeMs: number) {
  const result = cloneScene(scene), marker = result.audio?.markers?.[index]; if (!marker) return result;
  const old = marker.timeMs;
  const linked = result.animation.captions.some(caption => caption.markerId === marker.id);
  const shifted = linked && old > 0 && timeMs > 0 ? moveStep(result, old, timeMs) : result;
  shifted.audio!.markers![index].timeMs = timeMs;
  shifted.audio!.markers!.sort((a, b) => a.timeMs - b.timeMs);
  shifted.animation.captions.forEach(caption => { if (caption.markerId === marker.id || (linked && caption.timeMs === timeMs)) { caption.markerId = marker.id; caption.markerOffsetMs = 0; caption.timeMs = timeMs; } });
  return validateScene(shifted);
}
