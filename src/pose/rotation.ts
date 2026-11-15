import type { PlaybackResult } from './PosePlayer';
import { poseCategories, type PoseCategory, type PoseScene } from './types';

type CursorStorage = Pick<Storage, 'getItem' | 'setItem'>;
const unavailableStorageCursors = new Map<string, string>();
const kioskStorage: CursorStorage = {
  getItem(key) {
    return unavailableStorageCursors.get(key) ?? window.localStorage.getItem(key);
  },
  setItem(key, id) {
    try {
      window.localStorage.setItem(key, id);
      unavailableStorageCursors.delete(key);
    } catch {
      unavailableStorageCursors.set(key, id);
    }
  }
};

export class PoseRotation {
  private readonly poses: PoseScene[];
  private readonly key: string;
  private index: number;

  constructor(catalog: PoseScene[], category: PoseCategory, private storage = kioskStorage) {
    this.poses = catalog.filter(pose => poseCategories(pose).includes(category));
    this.key = `photo-booth.pose-rotation.v1.${category}`;
    let lastId: string | null = null;
    try { lastId = storage.getItem(this.key); } catch { /* Start at the first guide if the cursor is unavailable. */ }
    const nextIndex = this.poses.findIndex(pose => pose.id === lastId) + 1;
    this.index = nextIndex < this.poses.length ? nextIndex : 0;
  }

  current(): PoseScene | undefined {
    return this.poses[this.index];
  }

  finish(result: PlaybackResult) {
    const pose = this.current();
    if (!pose || result === 'cancelled') return;
    this.index = (this.index + 1) % this.poses.length;
    try { this.storage.setItem(this.key, pose.id); } catch { /* Keep rotating for this session. */ }
  }
}
