import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AppSettings } from './types';
import { validateScene } from './poseValidation';
import type { PoseScene, StoredPoseLibrary } from './poseTypes';
import type { PoseNarrationSettingsUpdate } from './poseTypes';

const SYNC_TABLE = 'booth_sync_profiles';
const SYNC_BUCKET = 'booth-sync';
const ASSET_TOKEN = 'cloud-asset:';

export type CloudSnapshot = {
  version: 1 | 2 | 3;
  settings: Partial<AppSettings>;
  poses?: PoseScene[];
  deletedPoseIds?: string[];
  narrationSettings?: PoseNarrationSettingsUpdate;
};

export type CloudSnapshotRow = {
  revision: number;
  updated_at: string;
  payload: CloudSnapshot;
};

const sha256 = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const trimSlash = (value: string) => value.replace(/\/+$/, '');

export const cloudProfileId = (settings: AppSettings) => sha256(`${settings.eventId.trim()}:${settings.boothSecret}`);
const secretHash = (settings: AppSettings) => sha256(settings.boothSecret);

export function cloudSyncConfigured(settings: AppSettings) {
  return Boolean(
    settings.supabaseUrl.trim() &&
    settings.supabasePublishableKey.trim() &&
    settings.eventId.trim() &&
    settings.boothSecret.trim()
  );
}

const headers = (settings: AppSettings, extra: Record<string, string> = {}) => ({
  apikey: settings.supabasePublishableKey,
  Authorization: `Bearer ${settings.supabasePublishableKey}`,
  'x-booth-sync-secret': settings.boothSecret,
  ...extra
});

async function responseError(response: Response) {
  const body = await response.text().catch(() => '');
  return new Error(body || `Cloud sync request failed (${response.status}).`);
}

function sharedSettings(settings: AppSettings): Partial<AppSettings> {
  const shared = clone(settings) as Partial<AppSettings>;
  delete (shared as unknown as Record<string, unknown>).cloudSyncEnabled;
  for (const key of [
    'eventFolder', 'supabaseUrl', 'supabasePublishableKey', 'eventId', 'boothSecret'
  ] as Array<keyof AppSettings>) delete shared[key];

  return shared;
}

export function cloudFingerprint(settings: AppSettings, library: StoredPoseLibrary) {
  const { poses, deletedPoseIds } = library;
  return sha256(JSON.stringify({ settings: sharedSettings(settings), poses, deletedPoseIds: deletedPoseIds?.length ? deletedPoseIds : undefined }));
}

function isAssetPath(key: string | undefined, value: string) {
  if (!key || !value || value.startsWith(ASSET_TOKEN) || /^https?:\/\//i.test(value)) return false;
  return key === 'assetPath' || key === 'path' || key === 'filePath' || key === 'framePath' || key === 'previewPath' || key === 'guestPreviewPath' || key === 'logoPath';
}

function contentType(filePath: string) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.mp3': return 'audio/mpeg';
    case '.wav': return 'audio/wav';
    case '.ogg': return 'audio/ogg';
    default: return 'application/octet-stream';
  }
}

const objectUrl = (settings: AppSettings, objectPath: string) => {
  const encoded = objectPath.split('/').map(encodeURIComponent).join('/');
  return `${trimSlash(settings.supabaseUrl)}/storage/v1/object/${SYNC_BUCKET}/${encoded}`;
};

const assetFilename = (objectPath: string) => {
  const extension = path.extname(objectPath).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin';
  return `${sha256(objectPath)}${extension}`;
};

function cloudAssetIndex(value: unknown, index = new Map<string, string>()): Map<string, string> {
  if (typeof value === 'string' && value.startsWith(ASSET_TOKEN)) {
    index.set(assetFilename(value.slice(ASSET_TOKEN.length)), value);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) cloudAssetIndex(item, index);
  }
  return index;
}

async function storedCloudAssetIndex(settings: AppSettings) {
  const index = new Map<string, string>();
  const list = async (prefix: string) => {
    const entries: Array<{ name: string; id: string | null }> = [];
    for (let offset = 0; ; offset += 1000) {
      const response = await fetch(`${trimSlash(settings.supabaseUrl)}/storage/v1/object/list/${SYNC_BUCKET}`, {
        method: 'POST',
        headers: headers(settings, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } })
      });
      if (!response.ok) throw await responseError(response);
      const page = await response.json() as typeof entries;
      entries.push(...page);
      if (page.length < 1000) return entries;
    }
  };
  const owner = secretHash(settings);
  // Previous events under the same secret may still own cached files referenced
  // by the current setup. Find exact object identities, never similar filenames.
  for (const folder of await list(owner)) {
    if (folder.id) continue;
    const prefix = `${owner}/${folder.name}`;
    for (const asset of await list(prefix)) {
      if (!asset.id) continue;
      const objectPath = `${prefix}/${asset.name}`;
      index.set(assetFilename(objectPath), `${ASSET_TOKEN}${objectPath}`);
    }
  }
  return index;
}

async function uploadAsset(settings: AppSettings, filePath: string) {
  const data = await fs.readFile(filePath);
  const extension = path.extname(filePath).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin';
  const objectPath = `${secretHash(settings)}/${settings.eventId}/${sha256(data)}${extension}`;
  const response = await fetch(objectUrl(settings, objectPath), {
    method: 'POST',
    headers: headers(settings, { 'Content-Type': contentType(filePath), 'x-upsert': 'true' }),
    body: data
  });
  if (!response.ok) throw await responseError(response);
  return `${ASSET_TOKEN}${objectPath}`;
}

type AssetUploader = (filePath: string) => Promise<string>;

function cachedAssetTransfer(transfer: AssetUploader): AssetUploader {
  const pending = new Map<string, Promise<string>>();
  const lanes: Promise<unknown>[] = Array.from({ length: 4 }, () => Promise.resolve());
  let nextLane = 0;
  return (value) => {
    let result = pending.get(value);
    if (!result) {
      const lane = nextLane++ % lanes.length;
      result = lanes[lane].then(() => transfer(value));
      lanes[lane] = result.catch(() => undefined);
      pending.set(value, result);
    }
    return result;
  };
}

async function replaceLocalAssetsWithCloud(value: unknown, upload: AssetUploader, key?: string): Promise<unknown> {
  if (typeof value === 'string') {
    if (!isAssetPath(key, value)) return value;
    return upload(value);
  }
  if (Array.isArray(value)) return Promise.all(value.map((item) => replaceLocalAssetsWithCloud(item, upload)));
  if (value && typeof value === 'object') {
    const entries = await Promise.all(Object.entries(value).map(async ([entryKey, item]) => [entryKey, await replaceLocalAssetsWithCloud(item, upload, entryKey)] as const));
    return Object.fromEntries(entries);
  }
  return value;
}

async function downloadAsset(settings: AppSettings, token: string) {
  const objectPath = token.slice(ASSET_TOKEN.length);
  const response = await fetch(objectUrl(settings, objectPath), { headers: headers(settings) });
  if (!response.ok) throw await responseError(response);
  const data = Buffer.from(await response.arrayBuffer());
  const targetFolder = path.join(settings.eventFolder, 'cloud-sync-assets');
  const targetPath = path.join(targetFolder, assetFilename(objectPath));
  await fs.mkdir(targetFolder, { recursive: true });
  await fs.writeFile(targetPath, data);
  return targetPath;
}

async function replaceCloudAssetsWithLocal(value: unknown, download: AssetUploader): Promise<unknown> {
  if (typeof value === 'string' && value.startsWith(ASSET_TOKEN)) return download(value);
  if (Array.isArray(value)) return Promise.all(value.map((item) => replaceCloudAssetsWithLocal(item, download)));
  if (value && typeof value === 'object') {
    const entries = await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await replaceCloudAssetsWithLocal(item, download)] as const));
    return Object.fromEntries(entries);
  }
  return value;
}

export async function fetchCloudSnapshot(settings: AppSettings): Promise<CloudSnapshotRow | null> {
  const id = cloudProfileId(settings);
  const url = `${trimSlash(settings.supabaseUrl)}/rest/v1/${SYNC_TABLE}?id=eq.${encodeURIComponent(id)}&select=revision,updated_at,payload`;
  const response = await fetch(url, { headers: headers(settings) });
  if (!response.ok) throw await responseError(response);
  const rows = await response.json() as CloudSnapshotRow[];
  return rows[0] ?? null;
}

export async function pushCloudSnapshot(settings: AppSettings, library: StoredPoseLibrary, options: {
  resolveAssetPath?: (value: string) => string;
  narrationSettings?: PoseNarrationSettingsUpdate;
} = {}): Promise<CloudSnapshotRow> {
  // Reuse uploads across template previews, workflow cues, and pose audio.
  let recoveryIndex: Promise<Map<string, string>> | undefined;
  let storageIndex: Promise<Map<string, string>> | undefined;
  const transfer = cachedAssetTransfer(async (filePath) => {
    try {
      return await uploadAsset(settings, filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // Cached filenames identify the original cloud object independently of the
      // Windows username or event folder. Never substitute audio by cue position.
      const filename = filePath.replace(/\\/g, '/').match(/(?:^|\/)cloud-sync-assets\/([a-f0-9]{64}\.[a-z0-9]+)$/i)?.[1];
      if (!filename) throw error;
      recoveryIndex ??= fetchCloudSnapshot(settings).then(row => cloudAssetIndex(row?.payload));
      let token = (await recoveryIndex).get(filename);
      if (!token) {
        storageIndex ??= storedCloudAssetIndex(settings);
        token = (await storageIndex).get(filename);
      }
      if (!token) throw new Error('The local file is missing and its original cloud copy is not in this profile. Restore the file or select a replacement before uploading.');
      // Download just the missing file; keep the user's current settings and edits.
      await downloadAsset(settings, token);
      return token;
    }
  });
  const upload: AssetUploader = (value) => {
    const filePath = options.resolveAssetPath?.(value) ?? value;
    return transfer(filePath).catch((error) => {
        throw new Error(`Could not upload asset "${value}": ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  const prepared = await replaceLocalAssetsWithCloud(sharedSettings(settings), upload) as Partial<AppSettings>;
  const preparedPoses = await replaceLocalAssetsWithCloud(library.poses, upload) as PoseScene[];
  const revision = Date.now();
  const payload: CloudSnapshot = { version: 3, settings: prepared, poses: preparedPoses, deletedPoseIds: library.deletedPoseIds, narrationSettings: options.narrationSettings };
  const response = await fetch(`${trimSlash(settings.supabaseUrl)}/rest/v1/${SYNC_TABLE}?on_conflict=id`, {
    method: 'POST',
    headers: headers(settings, {
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation'
    }),
    body: JSON.stringify({
      id: cloudProfileId(settings),
      event_id: settings.eventId,
      sync_token_hash: secretHash(settings),
      revision,
      payload
    })
  });
  if (!response.ok) throw await responseError(response);
  const rows = await response.json() as CloudSnapshotRow[];
  return rows[0] ?? { revision, updated_at: new Date().toISOString(), payload };
}

export async function applyCloudSnapshot(local: AppSettings, snapshot: CloudSnapshot) {
  if (![1, 2, 3].includes(snapshot.version) || !snapshot.settings) throw new Error('This cloud settings version is not supported.');
  const remote = await replaceCloudAssetsWithLocal(snapshot.settings, cachedAssetTransfer(token => downloadAsset(local, token))) as Partial<AppSettings>;
  if (snapshot.version >= 3) {
    return {
      ...local, ...remote,
      // Use this computer's storage location and the connection used to fetch the profile.
      eventFolder: local.eventFolder,
      supabaseUrl: local.supabaseUrl,
      supabasePublishableKey: local.supabasePublishableKey,
      eventId: local.eventId,
      boothSecret: local.boothSecret
    };
  }
  const localPrinters = new Map(local.template.layouts.map((layout) => [layout.id, layout.printerName]));
  const merged: AppSettings = {
    ...local,
    ...remote,
    eventFolder: local.eventFolder,
    webApiBaseUrl: local.webApiBaseUrl,
    supabaseUrl: local.supabaseUrl,
    supabasePublishableKey: local.supabasePublishableKey,
    eventId: local.eventId,
    boothSecret: local.boothSecret,
    cameraId: local.cameraId,
    cameraSource: local.cameraSource,
    canonEnabled: local.canonEnabled,
    canonFraming: local.canonFraming,
    mirrorPreview: local.mirrorPreview,
    cameraRotation: local.cameraRotation,
    cameraPreviewOverlay: local.cameraPreviewOverlay,
    cameraControls: local.cameraControls,
    defaultPrinter: local.defaultPrinter,
    sizePrinters: local.sizePrinters,
    stylePrinters: local.stylePrinters,
    printerEnabled: local.printerEnabled,
    silentPrint: local.silentPrint,
    printCalibration: local.printCalibration,
    adminPassword: local.adminPassword,
    ai: {
      ...(remote.ai ?? local.ai),
      providers: {
        openai: { ...(remote.ai?.providers.openai ?? local.ai.providers.openai), apiKey: local.ai.providers.openai.apiKey },
        gemini: { ...(remote.ai?.providers.gemini ?? local.ai.providers.gemini), apiKey: local.ai.providers.gemini.apiKey },
        xai: { ...(remote.ai?.providers.xai ?? local.ai.providers.xai), apiKey: local.ai.providers.xai.apiKey }
      }
    },
    template: {
      ...(remote.template ?? local.template),
      layouts: (remote.template?.layouts ?? local.template.layouts).map((layout) => ({
        ...layout,
        printerName: localPrinters.get(layout.id) ?? ''
      }))
    }
  };
  return merged;
}

export async function applyCloudPoseLibrary(local: AppSettings, snapshot: CloudSnapshot): Promise<StoredPoseLibrary | null> {
  if (snapshot.version < 2 || !snapshot.poses) return null;
  const poses = await replaceCloudAssetsWithLocal(snapshot.poses, cachedAssetTransfer(token => downloadAsset(local, token))) as PoseScene[];
  return { poses: poses.map(validateScene), deletedPoseIds: snapshot.deletedPoseIds };
}
