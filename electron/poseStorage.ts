import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { app, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { validateScene } from './poseValidation';
import type { PoseCatalog, PoseScene } from './poseTypes';

const directory = () => path.join(app.getPath('userData'), 'pose-library');
const safeId = (id: string) => { if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) throw new Error('Invalid pose ID.'); return id; };
const posePath = (id: string) => path.join(directory(), `${safeId(id)}.json`);
const MAX_JSON = 2 * 1024 * 1024;
let writes: Promise<unknown> = Promise.resolve();
function serialized<T>(work: () => Promise<T>): Promise<T> { const result = writes.then(work); writes = result.catch(() => undefined); return result; }
export async function listStoredPoses(): Promise<PoseCatalog> {
  await writes;
  await fs.mkdir(directory(), { recursive: true });
  const poses: PoseScene[] = [], errors: string[] = [];
  for (const name of (await fs.readdir(directory())).filter(name => name.endsWith('.json')).sort()) {
    try {
      const file = path.join(directory(), name); const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size > MAX_JSON) throw new Error('Not a bounded JSON file.');
      const pose = validateScene(JSON.parse(await fs.readFile(file, 'utf8')));
      if (name !== `${pose.id}.json`) throw new Error('Pose ID does not match filename.');
      poses.push(pose);
    } catch (error) { errors.push(`${name}: ${String(error)}`); }
  }
  return { poses, errors };
}
export function saveStoredPose(value: unknown) {
  const pose = validateScene(value), text = `${JSON.stringify(pose, null, 2)}\n`;
  if (Buffer.byteLength(text) > MAX_JSON) throw new Error('Pose JSON is too large.');
  return serialized(async () => {
    await fs.mkdir(directory(), { recursive: true });
    const target = posePath(pose.id), temporary = `${target}.${crypto.randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, text, { flag: 'wx' }); await fs.rename(temporary, target); }
    finally { await fs.rm(temporary, { force: true }); }
    return pose;
  });
}
export function deleteStoredPose(id: string) { const target = posePath(id); return serialized(async () => { await fs.rm(target, { force: true }); return true; }); }
function adminOnly(event: IpcMainInvokeEvent) {
  if (new URL(event.sender.getURL()).searchParams.get('window') !== 'admin') throw new Error('Open the admin window to edit poses.');
}
export function registerPoseStorage() {
  ipcMain.handle('poses:list', () => listStoredPoses());
  ipcMain.handle('poses:save', (event, value: unknown) => { adminOnly(event); return saveStoredPose(value); });
  ipcMain.handle('poses:delete', (event, id: string) => { adminOnly(event); return deleteStoredPose(id); });
  ipcMain.handle('poses:export', async (event, value: unknown) => {
    adminOnly(event); const pose = validateScene(value);
    const result = await dialog.showSaveDialog({ title: 'Export pose JSON', defaultPath: `${pose.id}.json`, filters: [{ name: 'Pose JSON', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return false;
    await fs.writeFile(result.filePath, `${JSON.stringify(pose, null, 2)}\n`, 'utf8'); return true;
  });
  ipcMain.handle('poses:image-import', async event => {
    adminOnly(event);
    const result = await dialog.showOpenDialog({ title: 'Choose pose cutout', properties: ['openFile'], filters: [{ name: 'WebP', extensions: ['webp'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    const source = result.filePaths[0], stat = await fs.stat(source);
    if (!stat.isFile() || stat.size > 15 * 1024 * 1024 || path.extname(source).toLowerCase() !== '.webp') throw new Error('Choose a WebP image smaller than 15 MB.');
    const images = path.join(directory(), 'images'); await fs.mkdir(images, { recursive: true });
    const filePath = path.join(images, `${crypto.randomUUID()}.webp`); await fs.copyFile(source, filePath);
    return { filePath, name: path.basename(source) };
  });
  ipcMain.handle('poses:audio-import', async event => {
    adminOnly(event);
    const result = await dialog.showOpenDialog({ title: 'Choose pose narration', properties: ['openFile'], filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    const source = result.filePaths[0], stat = await fs.stat(source), extension = path.extname(source).toLowerCase();
    if (!stat.isFile() || stat.size > 50 * 1024 * 1024 || !['.mp3', '.wav', '.ogg', '.m4a'].includes(extension)) throw new Error('Choose an audio file smaller than 50 MB.');
    const audioDirectory = path.join(directory(), 'audio'); await fs.mkdir(audioDirectory, { recursive: true });
    const filePath = path.join(audioDirectory, `${crypto.randomUUID()}${extension}`); await fs.copyFile(source, filePath);
    return { filePath, name: path.basename(source) };
  });
}
