import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { app, dialog, ipcMain, safeStorage, type IpcMainInvokeEvent } from 'electron';
import { validateScene } from './poseValidation';
import type { PoseCatalog, PoseNarrationGenerateRequest, PoseNarrationModel, PoseNarrationSettings, PoseNarrationSettingsUpdate, PoseScene } from './poseTypes';

const directory = () => path.join(app.getPath('userData'), 'pose-library');
const safeId = (id: string) => { if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) throw new Error('Invalid pose ID.'); return id; };
const posePath = (id: string) => path.join(directory(), `${safeId(id)}.json`);
const MAX_JSON = 2 * 1024 * 1024;
const narrationConfigPath = () => path.join(directory(), 'elevenlabs.json');
const narrationModels = new Set<PoseNarrationModel>(['eleven_v4_turbo', 'eleven_flash_v2_5', 'eleven_multilingual_v2', 'eleven_v3']);
type StoredNarrationSettings = Omit<PoseNarrationSettings, 'configured'> & { encryptedApiKey?: string };
const narrationDefaults: StoredNarrationSettings = { voiceId: '0S5oIfi8zOZixuSj8K6n', modelId: 'eleven_v4_turbo', stability: .5, similarityBoost: .75, style: .2, speed: 1, direction: '[energetic] [happy] [Make it upbeat, fun]' };
let writes: Promise<unknown> = Promise.resolve();
function serialized<T>(work: () => Promise<T>): Promise<T> { const result = writes.then(work); writes = result.catch(() => undefined); return result; }
export async function listStoredPoses(): Promise<PoseCatalog> {
  await writes;
  await fs.mkdir(directory(), { recursive: true });
  const poses: PoseScene[] = [], errors: string[] = [];
  for (const name of (await fs.readdir(directory())).filter(name => name.endsWith('.json') && name !== path.basename(narrationConfigPath())).sort()) {
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
export function replaceStoredPoses(values: unknown[]) {
  const poses = values.map(validateScene);
  const ids = new Set(poses.map(pose => pose.id));
  if (ids.size !== poses.length) throw new Error('The synced pose library contains duplicate IDs.');
  const serializedPoses = poses.map(pose => {
    const text = `${JSON.stringify(pose, null, 2)}\n`;
    if (Buffer.byteLength(text) > MAX_JSON) throw new Error(`Pose ${pose.id} is too large.`);
    return { pose, text };
  });
  return serialized(async () => {
    await fs.mkdir(directory(), { recursive: true });
    for (const { pose, text } of serializedPoses) {
      const target = posePath(pose.id), temporary = `${target}.${crypto.randomUUID()}.tmp`;
      try { await fs.writeFile(temporary, text, { flag: 'wx' }); await fs.rename(temporary, target); }
      finally { await fs.rm(temporary, { force: true }); }
    }
    for (const name of await fs.readdir(directory())) {
      if (!name.endsWith('.json') || name === path.basename(narrationConfigPath())) continue;
      const id = name.slice(0, -'.json'.length);
      if (!ids.has(id)) await fs.rm(path.join(directory(), name), { force: true });
    }
    return poses;
  });
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
const bounded = (value: unknown, fallback: number, min: number, max: number) => {
  const number = Number(value); return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};
async function readNarrationSettings(): Promise<StoredNarrationSettings> {
  try {
    const raw = JSON.parse(await fs.readFile(narrationConfigPath(), 'utf8')) as Partial<StoredNarrationSettings>;
    return {
      voiceId: typeof raw.voiceId === 'string' ? raw.voiceId.trim() : '',
      modelId: narrationModels.has(raw.modelId as PoseNarrationModel) ? raw.modelId as PoseNarrationModel : narrationDefaults.modelId,
      stability: bounded(raw.stability, narrationDefaults.stability, 0, 1),
      similarityBoost: bounded(raw.similarityBoost, narrationDefaults.similarityBoost, 0, 1),
      style: bounded(raw.style, narrationDefaults.style, 0, 1),
      speed: bounded(raw.speed, narrationDefaults.speed, .7, 1.2),
      direction: typeof raw.direction === 'string' ? raw.direction.trim().slice(0, 240) : narrationDefaults.direction,
      ...(typeof raw.encryptedApiKey === 'string' ? { encryptedApiKey: raw.encryptedApiKey } : {})
    };
  } catch { return { ...narrationDefaults }; }
}
function publicNarrationSettings(settings: StoredNarrationSettings): PoseNarrationSettings {
  const { encryptedApiKey, ...publicSettings } = settings;
  return { ...publicSettings, configured: Boolean(encryptedApiKey || process.env.ELEVENLABS_API_KEY) };
}
async function saveNarrationSettings(update: PoseNarrationSettingsUpdate): Promise<PoseNarrationSettings> {
  const current = await readNarrationSettings();
  if (!narrationModels.has(update.modelId)) throw new Error('Choose a supported ElevenLabs model.');
  const voiceId = update.voiceId.trim();
  if (voiceId && !/^[A-Za-z0-9_-]{10,100}$/.test(voiceId)) throw new Error('Voice ID is invalid.');
  let encryptedApiKey = current.encryptedApiKey;
  if (update.apiKey !== undefined) {
    const apiKey = update.apiKey.trim();
    if (!apiKey) encryptedApiKey = undefined;
    else {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows credential encryption is unavailable. Set ELEVENLABS_API_KEY instead.');
      encryptedApiKey = safeStorage.encryptString(apiKey).toString('base64');
    }
  }
  const next: StoredNarrationSettings = {
    voiceId, modelId: update.modelId,
    stability: bounded(update.stability, .5, 0, 1), similarityBoost: bounded(update.similarityBoost, .75, 0, 1),
    style: bounded(update.style, .2, 0, 1), speed: bounded(update.speed, 1, .7, 1.2),
    direction: String(update.direction ?? '').trim().slice(0, 240),
    ...(encryptedApiKey ? { encryptedApiKey } : {})
  };
  await fs.mkdir(directory(), { recursive: true });
  const target = narrationConfigPath(), temporary = `${target}.${crypto.randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx' }); await fs.rename(temporary, target); }
  finally { await fs.rm(temporary, { force: true }); }
  return publicNarrationSettings(next);
}
function narrationApiKey(settings: StoredNarrationSettings) {
  if (process.env.ELEVENLABS_API_KEY?.trim()) return process.env.ELEVENLABS_API_KEY.trim();
  if (!settings.encryptedApiKey) throw new Error('Add your ElevenLabs API key first.');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows credential encryption is unavailable.');
  try { return safeStorage.decryptString(Buffer.from(settings.encryptedApiKey, 'base64')); }
  catch { throw new Error('The saved ElevenLabs API key could not be decrypted. Save it again.'); }
}
export async function getElevenLabsSettings() { return publicNarrationSettings(await readNarrationSettings()); }
export async function updateElevenLabsSettings(update: PoseNarrationSettingsUpdate) { return saveNarrationSettings(update); }
export async function generateElevenLabsSpeech(id: string, rawText: string, outputDirectory = path.join(directory(), 'audio', 'elevenlabs')) {
  const safeSpeechId = safeId(id), text = String(rawText ?? '').trim();
  if (!text || text.length > 2000) throw new Error('Narration must contain 1–2,000 characters.');
  const settings = await readNarrationSettings(), apiKey = narrationApiKey(settings);
  if (!settings.voiceId) throw new Error('Add an ElevenLabs voice ID first.');
  const digest = crypto.createHash('sha1').update(JSON.stringify({ id: safeSpeechId, text, ...publicNarrationSettings(settings) })).digest('hex').slice(0, 14);
  const filePath = path.join(outputDirectory, `${safeSpeechId}-${digest}.mp3`);
  try { const stat = await fs.stat(filePath); if (stat.isFile() && stat.size > 0) return { filePath, name: path.basename(filePath), cached: true }; } catch { /* generate */ }
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(settings.voiceId)}?output_format=mp3_44100_128`, {
    method: 'POST', headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text: [settings.direction, text].filter(Boolean).join(' '), model_id: settings.modelId, voice_settings: { stability: settings.stability, similarity_boost: settings.similarityBoost, style: settings.style, speed: settings.speed, use_speaker_boost: true } })
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 600);
    throw new Error(`ElevenLabs generation failed (${response.status}): ${detail}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > 25 * 1024 * 1024) throw new Error('ElevenLabs returned an invalid audio file.');
  await fs.mkdir(outputDirectory, { recursive: true });
  const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, buffer, { flag: 'wx' }); await fs.rename(temporary, filePath); }
  finally { await fs.rm(temporary, { force: true }); }
  return { filePath, name: path.basename(filePath), cached: false };
}
async function generatePoseNarration(request: PoseNarrationGenerateRequest) {
  return generateElevenLabsSpeech(request.poseId, request.text);
}
export function registerPoseStorage(onLibraryChanged?: () => void) {
  ipcMain.handle('poses:list', () => listStoredPoses());
  ipcMain.handle('poses:save', async (event, value: unknown) => { adminOnly(event); const pose = await saveStoredPose(value); onLibraryChanged?.(); return pose; });
  ipcMain.handle('poses:delete', async (event, id: string) => { adminOnly(event); const deleted = await deleteStoredPose(id); onLibraryChanged?.(); return deleted; });
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
  ipcMain.handle('poses:narration-settings:get', async event => { adminOnly(event); return getElevenLabsSettings(); });
  ipcMain.handle('poses:narration-settings:set', async (event, value: PoseNarrationSettingsUpdate) => { adminOnly(event); return updateElevenLabsSettings(value); });
  ipcMain.handle('poses:narration-generate', async (event, value: PoseNarrationGenerateRequest) => { adminOnly(event); return generatePoseNarration(value); });
}
