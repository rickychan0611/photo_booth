import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AppSettings, BoothSession, QueueSnapshot, UploadedWebAsset, WebPhotoAssetUpload } from './types';

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, '');

export const isWebQueueConfigured = (settings: AppSettings) =>
  Boolean(settings.webApiBaseUrl.trim() && settings.eventId.trim());

export const isRealtimeConfigured = (settings: AppSettings) =>
  Boolean(settings.supabaseUrl.trim() && settings.supabasePublishableKey.trim() && settings.eventId.trim());

export function webApiUrl(settings: AppSettings, path: string) {
  return `${trimTrailingSlash(settings.webApiBaseUrl || 'http://localhost:3000')}${path}`;
}

export function publicWebUrl(settings: AppSettings, path: string) {
  if (/^https?:\/\//i.test(path)) return path;
  return `${trimTrailingSlash(settings.webApiBaseUrl || 'http://localhost:3000')}${path.startsWith('/') ? path : `/${path}`}`;
}

async function parseResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `Request failed: ${response.status}`);
  }
  return body as T;
}

export async function fetchQueueSnapshot(settings: AppSettings) {
  const url = webApiUrl(settings, `/api/queue?eventId=${encodeURIComponent(settings.eventId)}`);
  const response = await fetch(url);
  return parseResponse<QueueSnapshot>(response);
}

export async function validateBoothCode(settings: AppSettings, accessCode: string) {
  const response = await fetch(webApiUrl(settings, '/api/booth/validate-code'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventId: settings.eventId, accessCode })
  });

  return parseResponse<{ ticket: BoothSession['ticket']; galleryUrl: string }>(response);
}

export async function createBoothGallerySession(settings: AppSettings): Promise<BoothSession> {
  const response = await fetch(webApiUrl(settings, '/api/tickets/manual'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventId: settings.eventId, paymentMethod: 'manual_other' })
  });
  const data = await parseResponse<{ ticket: BoothSession['ticket']; galleryUrl: string }>(response);
  return {
    ticket: data.ticket,
    galleryUrl: data.galleryUrl
  };
}

export async function completeBoothSession(settings: AppSettings, ticketId: string) {
  const response = await fetch(webApiUrl(settings, '/api/booth/complete-session'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventId: settings.eventId, ticketId })
  });

  return parseResponse<{ ticket: BoothSession['ticket'] }>(response);
}

export async function uploadSessionAssets(
  settings: AppSettings,
  session: BoothSession,
  assets: WebPhotoAssetUpload[]
) {
  if (!settings.boothSecret.trim()) {
    throw new Error('Booth secret is missing.');
  }

  const uploaded = await Promise.all(
    assets.map(async (asset) => {
      const formData = new FormData();
      formData.set('eventId', settings.eventId);
      formData.set('ticketId', session.ticket.id);
      formData.set('kind', asset.kind);
      formData.set('filename', asset.filename);
      if (asset.width) formData.set('width', String(asset.width));
      if (asset.height) formData.set('height', String(asset.height));
      formData.set('file', dataUrlToBlob(asset.dataUrl, asset.contentType), asset.filename);

      const response = await fetch(webApiUrl(settings, '/api/uploads/direct'), {
        method: 'POST',
        headers: {
          'x-booth-secret': settings.boothSecret
        },
        body: formData
      });

      try {
        return await parseResponse<{ asset: UploadedWebAsset }>(response);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown upload error';
        throw new Error(`${asset.kind} upload failed: ${message}`);
      }
    })
  );

  return { assets: uploaded.map((result) => result.asset) };
}

export function createQueueRealtimeClient(settings: AppSettings): SupabaseClient | null {
  if (!isRealtimeConfigured(settings)) return null;
  return createClient(settings.supabaseUrl, settings.supabasePublishableKey);
}

function dataUrlToBlob(dataUrl: string, fallbackContentType: string) {
  const [metadata, base64 = ''] = dataUrl.split(',');
  const contentType = metadata.match(/data:(.*?);base64/)?.[1] || fallbackContentType;
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: contentType });
}
