import type { PlaybackClock, PoseAudioHooks, PoseScene, SceneFrame } from './types';
import { captionAt } from './scenes';

export type PlaybackResult = 'completed' | 'cancelled' | 'failed';
const browserClock: PlaybackClock = {
  now: () => performance.now(), request: (callback) => requestAnimationFrame(callback), cancel: (id) => cancelAnimationFrame(id)
};

export class PosePlayer {
  private frameId: number | null = null;
  private finish: ((result: PlaybackResult) => void) | null = null;
  private controller: AbortController | null = null;
  private generation = 0;
  constructor(private options: {
    onFrame(frame: SceneFrame): void;
    onError?(error: unknown): void;
    onAudioMarker?(id: string): void;
    audio?: PoseAudioHooks;
    clock?: PlaybackClock;
  }) {}

  async play(pose: PoseScene, options: { signal?: AbortSignal } = {}): Promise<PlaybackResult> {
    this.stop();
    const token = ++this.generation;
    if (options.signal?.aborted) return 'cancelled';
    const controller = new AbortController();
    this.controller = controller;
    const abort = () => this.stop();
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      this.options.onFrame(captionAt(pose, 0));
      if (pose.audio?.filePath) {
        let abortPrepare: () => void = () => undefined;
        try {
          await Promise.race([
            this.options.audio?.prepare(pose, controller.signal),
            new Promise<void>((resolve) => {
              abortPrepare = resolve;
              controller.signal.addEventListener('abort', abortPrepare, { once: true });
            })
          ]);
        }
        catch (error) { this.options.onError?.(error); }
        finally { controller.signal.removeEventListener('abort', abortPrepare); }
      }
      if (token !== this.generation || controller.signal.aborted) return 'cancelled';
      const clock = this.options.clock ?? browserClock;
      const start = clock.now();
      let audioStarted = false;
      const markers = new Set<string>();
      return await new Promise<PlaybackResult>((resolve) => {
        this.finish = resolve;
        const tick = () => {
          if (token !== this.generation || controller.signal.aborted) return;
          try {
            const elapsed = Math.min(pose.animation.durationMs, Math.max(0, clock.now() - start));
            if (!audioStarted && pose.audio?.filePath && elapsed >= (pose.audio.startMs ?? 0)) {
              audioStarted = true;
              void Promise.resolve(this.options.audio?.start(pose)).catch((error) => this.options.onError?.(error));
            }
            for (const marker of pose.audio?.markers ?? []) if (elapsed >= marker.timeMs && !markers.has(marker.id)) {
              markers.add(marker.id); this.options.onAudioMarker?.(marker.id);
            }
            this.options.onFrame(captionAt(pose, elapsed));
            if (token !== this.generation || controller.signal.aborted) return;
            if (elapsed >= pose.animation.durationMs) this.complete('completed');
            else this.frameId = clock.request(tick);
          } catch (error) { this.options.onError?.(error); this.complete('failed'); }
        };
        tick();
      });
    } catch (error) {
      this.options.onError?.(error);
      this.complete('failed');
      return 'failed';
    } finally {
      options.signal?.removeEventListener('abort', abort);
      if (this.controller === controller) this.controller = null;
    }
  }
  private complete(result: PlaybackResult) {
    const clock = this.options.clock ?? browserClock;
    if (this.frameId !== null) clock.cancel(this.frameId);
    this.frameId = null;
    this.options.audio?.stop();
    const finish = this.finish;
    this.finish = null;
    finish?.(result);
  }
  stop() {
    ++this.generation;
    this.controller?.abort();
    this.controller = null;
    this.complete('cancelled');
  }
  reset() {
    this.stop();
    this.options.onFrame({ caption: '', elapsedMs: 0 });
  }
  dispose() { this.stop(); }
}
