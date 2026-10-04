import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type CSSProperties } from 'react';
import type { AppSettings } from '../types';
import { resolvePoseAsset } from './assets';
import { createPoseAudioHooks } from './audio';
import { ScenePlayer } from './ScenePlayer';
import type { PlaybackResult } from './PosePlayer';
import type { PoseFraming, PoseScene, SceneFrame } from './types';

export type PoseGuideHandle = {
  play(pose: PoseScene, signal: AbortSignal, framing: PoseFraming): Promise<PlaybackResult>;
  dismiss(): Promise<void>;
  stop(): void;
  hide(): void;
};

const preload = (url: string, signal: AbortSignal) => new Promise<boolean>((resolve) => {
  if (signal.aborted) return resolve(false);
  const image = new Image();
  const done = (loaded: boolean) => {
    image.onload = null;
    image.onerror = null;
    signal.removeEventListener('abort', abort);
    resolve(loaded);
  };
  const abort = () => done(false);
  image.onload = () => done(true);
  image.onerror = () => done(false);
  signal.addEventListener('abort', abort, { once: true });
  image.src = url;
});

export const PoseGuideOverlay = forwardRef<PoseGuideHandle, {
  settings: AppSettings;
  countdown: number | null;
  capturing: boolean;
  photoNumber: number;
  photoCount: number;
}>(function PoseGuideOverlay({ settings, countdown, capturing, photoNumber, photoCount }, ref) {
  const playerRef = useRef<ScenePlayer | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [caption, setCaption] = useState('');
  const [image, setImage] = useState<{ src: string; alt: string; accent: string; scale: number; offsetX: number; offsetY: number } | null>(null);
  const [visible, setVisible] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [pulse, setPulse] = useState(false);
  const [framing, setFraming] = useState<PoseFraming>('full');
  const hideImmediately = () => { setVisible(false); setExiting(false); setPulse(false); };

  useImperativeHandle(ref, () => ({
    async play(pose, signal, nextFraming) {
      if (!playerRef.current || signal.aborted || !pose.visual) return 'failed';
      const src = await resolvePoseAsset(pose.visual.assetPath);
      if (!src || signal.aborted) return signal.aborted ? 'cancelled' : 'failed';
      const loaded = await preload(src, signal);
      if (!loaded || signal.aborted) return signal.aborted ? 'cancelled' : 'failed';
      const nextImage = { src, alt: pose.visual.alt, accent: pose.visual.accent, scale: pose.visual.scale ?? 1, offsetX: pose.visual.offsetX ?? 0, offsetY: pose.visual.offsetY ?? 0 };
      setImage(nextImage);
      setCaption(pose.animation.captions[0]?.text ?? pose.instruction);
      setFraming(nextFraming);
      setExiting(false);
      setVisible(true);
      return playerRef.current.play(pose, { signal });
    },
    async dismiss() {
      playerRef.current?.stop();
      setExiting(true);
      await new Promise(resolve => window.setTimeout(resolve, 250));
      hideImmediately();
    },
    stop() { playerRef.current?.stop(); hideImmediately(); },
    hide() { hideImmediately(); }
  }), []);

  useEffect(() => {
    const paint = (frame: SceneFrame) => {
      setCaption(current => current === frame.caption ? current : frame.caption);
      const pulsing = frame.elapsedMs >= 1500 && frame.elapsedMs < 2000;
      setPulse(current => current === pulsing ? current : pulsing);
    };
    const player = new ScenePlayer(paint, createPoseAudioHooks(() => settingsRef.current));
    playerRef.current = player;
    return () => { player.dispose(); playerRef.current = null; };
  }, []);

  const hidden = !visible || capturing || countdown !== null;
  return (
    <div
      className={`pose-guide pose-guide--photo${hidden ? ' pose-guide--hidden' : ''}${exiting ? ' pose-guide--exiting' : ''}${pulse ? ' pose-guide--pulse' : ''}`}
      aria-hidden={hidden}
      data-framing={framing}
      style={{ '--pose-accent': image?.accent ?? '#fff', '--pose-scale': image?.scale ?? 1, '--pose-offset-x': `${image?.offsetX ?? 0}px`, '--pose-offset-y': `${image?.offsetY ?? 0}px` } as CSSProperties}
    >
      <div className="pose-guide-progress">Photo {photoNumber} of {photoCount}</div>
      {image ? <div className="pose-guide-art"><img className="pose-guide-cutout" src={image.src} alt={image.alt} draggable={false} /></div> : null}
      <div className="pose-guide-caption" role="status" aria-live="polite">{caption}</div>
      <div className="pose-guide-pips" aria-hidden="true"><i /><i /><i /><i /></div>
    </div>
  );
});
