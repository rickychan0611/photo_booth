import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AppSettings } from './types';
import { validateScene } from './poseValidation';
import type { PoseScene } from './poseTypes';

const SYNC_TABLE = 'booth_sync_profiles';
const SYNC_BUCKET = 'booth-sync';
const ASSET_TOKEN = 'cloud-asset:';

export type CloudSnapshot = {
  version: 1 | 2;
  settings: Partial<AppSettings>;
  poses?: PoseScene[];
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
    'eventFolder', 'webApiBaseUrl', 'supabaseUrl', 'supabasePublishableKey', 'eventId', 'boothSecret',
    'cameraId', 'cameraSource', 'canonEnabled', 'canonFraming', 'mirrorPreview',
    'cameraRotation', 'cameraPreviewOverlay', 'cameraControls', 'defaultPrinter', 'stylePrinters',
    'printerEnabled', 'silentPrint', 'printCalibration', 'adminPassword'
  ] as Array<keyof AppSettings>) delete shared[key];

  if (shared.ai) {
    for (const provider of Object.values(shared.ai.providers)) provider.apiKey = '';
  }
  if (shared.template) {
    shared.template.layouts = shared.template.layouts.map((layout) => ({ ...layout, printerName: '' }));
  }
  return shared;
}

export function cloudFingerprint(settings: AppSettings, poses: PoseScene[] = []) {
  return sha256(JSON.stringify({ settings: sharedSettings(settings), poses }));
}

function isAssetPath(key: string | undefined, value: string) {
  if (!key || !value || value.startsWith(ASSET_TOKEN) || /^https?:\/\//i.test(value)) return false;
  return key === 'path' || key === 'filePath' || key === 'framePath' || key === 'previewPath' || key === 'guestPreviewPath' || key === 'logoPath';
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

async function replaceLocalAssetsWithCloud(value: unknown, settings: AppSettings, key?: string): Promise<unknown> {
  if (typeof value === 'string') {
    if (!isAssetPath(key, value)) return value;
    try {
      const stat = await fs.stat(value);
      return stat.isFile() ? await uploadAsset(settings, value) : '';
    } catch {
      return '';
    }
  }
  if (Array.isArray(value)) return Promise.all(value.map((item) => replaceLocalAssetsWithCloud(item, settings)));
  if (value && typeof value === 'object') {
    const entries = await Promise.all(Object.entries(value).map(async ([entryKey, item]) => [entryKey, await replaceLocalAssetsWithCloud(item, settings, entryKey)] as const));
    return Object.fromEntries(entries);
  }
  return value;
}

async function downloadAsset(settings: AppSettings, token: string) {
  const objectPath = token.slice(ASSET_TOKEN.length);
  const response = await fetch(objectUrl(settings, objectPath), { headers: headers(settings) });
  if (!response.ok) throw await responseError(response);
  const data = Buffer.from(await response.arrayBuffer());
  const extension = path.extname(objectPath).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin';
  const targetFolder = path.join(settings.eventFolder, 'cloud-sync-assets');
  const targetPath = path.join(targetFolder, `${sha256(objectPath)}${extension}`);
  await fs.mkdir(targetFolder, { recursive: true });
  await fs.writeFile(targetPath, data);
  return targetPath;
}

async function replaceCloudAssetsWithLocal(value: unknown, settings: AppSettings): Promise<unknown> {
  if (typeof value === 'string' && value.startsWith(ASSET_TOKEN)) return downloadAsset(settings, value);
  if (Array.isArray(value)) return Promise.all(value.map((item) => replaceCloudAssetsWithLocal(item, settings)));
  if (value && typeof value === 'object') {
    const entries = await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await replaceCloudAssetsWithLocal(item, settings)] as const));
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

export async function pushCloudSnapshot(settings: AppSettings, poses: PoseScene[] = []): Promise<CloudSnapshotRow> {
  const prepared = await replaceLocalAssetsWithCloud(sharedSettings(settings), settings) as Partial<AppSettings>;
  const preparedPoses = await replaceLocalAssetsWithCloud(poses, settings) as PoseScene[];
  const revision = Date.now();
  const payload: CloudSnapshot = { version: 2, settings: prepared, poses: preparedPoses };
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
  if (![1, 2].includes(snapshot.version) || !snapshot.settings) throw new Error('This cloud settings version is not supported.');
  const remote = await replaceCloudAssetsWithLocal(snapshot.settings, local) as Partial<AppSettings>;
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

export async function applyCloudPoseLibrary(local: AppSettings, snapshot: CloudSnapshot): Promise<PoseScene[] | null> {
  if (snapshot.version < 2 || !snapshot.poses) return null;
  const poses = await replaceCloudAssetsWithLocal(snapshot.poses, local) as PoseScene[];
  return poses.map(validateScene);
}
