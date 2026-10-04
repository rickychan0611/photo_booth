import { PosePlayer } from './PosePlayer';
import type { PlaybackClock, PoseAudioHooks, PoseScene, SceneFrame } from './types';

export class ScenePlayer {
  private player: PosePlayer;
  constructor(onFrame: (frame: SceneFrame) => void, audio?: PoseAudioHooks, clock?: PlaybackClock) {
    this.player = new PosePlayer({
      audio,
      clock,
      onFrame,
      onError: error => console.warn('Scene playback failed.', error)
    });
  }
  play(scene: PoseScene, options: { signal?: AbortSignal } = {}) {
    this.player.stop();
    if (scene.visual?.kind !== 'photo-cutout') return Promise.resolve('failed' as const);
    return this.player.play(scene, options);
  }
  stop() { this.player.stop(); }
  reset() { this.player.reset(); }
  dispose() { this.player.dispose(); }
}
