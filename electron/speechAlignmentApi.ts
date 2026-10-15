import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { timingFromCharacters, type SpeechCharacter } from './poseAlignment';
import type { PoseSpeechTiming } from './poseTypes';

export async function narrationDuration(filePath: string): Promise<number> {
  if (!ffmpeg) throw new Error('Audio decoder is unavailable.');
  return new Promise((resolve, reject) => {
    const process = spawn(ffmpeg!.replace('app.asar', 'app.asar.unpacked'), ['-hide_banner', '-i', filePath, '-f', 'null', '-'], { windowsHide: true });
    let output = '';
    const timeout = setTimeout(() => { process.kill(); reject(new Error('Audio decoding timed out.')); }, 30000);
    process.stderr.on('data', data => { if (output.length < 100000) output += data.toString(); });
    process.on('error', error => { clearTimeout(timeout); reject(error); });
    process.on('close', code => {
      clearTimeout(timeout);
      const match = output.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
      if (code !== 0 || !match) return reject(new Error('Narration file could not be decoded.'));
      resolve(Math.round((Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000));
    });
  });
}

async function cachePath(filePath: string, text: string, captions: string[]) {
  const buffer = await fs.readFile(filePath);
  if (!buffer.length || buffer.length > 50 * 1024 * 1024) throw new Error('Invalid narration file size.');
  const digest = crypto.createHash('sha256').update(buffer).update(JSON.stringify({ text, captions, version: 1 })).digest('hex').slice(0, 20);
  return { buffer, target: `${filePath}.sync-${digest}.json` };
}

export async function saveSpeechTiming(filePath: string, text: string, captions: string[], timing: PoseSpeechTiming) {
  const { target } = await cachePath(filePath, text, captions);
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, JSON.stringify(timing, null, 2) + '\n', { flag: 'wx' }); await fs.rename(temporary, target); }
  finally { await fs.rm(temporary, { force: true }); }
}

export async function alignSpeechFile(filePath: string, text: string, captions: string[], apiKey: string): Promise<PoseSpeechTiming> {
  const { target, buffer } = await cachePath(filePath, text, captions);
  try {
    const cached = JSON.parse(await fs.readFile(target, 'utf8')) as PoseSpeechTiming;
    if (cached.version === 1 && cached.audioDurationMs > 0 && cached.audioDurationMs <= 119000 &&
      cached.captions.length === captions.length && cached.captions.every((caption, index) => caption.text === captions[index] && Number.isFinite(caption.timeMs) && caption.timeMs >= 0 && caption.timeMs <= cached.audioDurationMs && (index === 0 ? caption.timeMs === 0 : caption.timeMs > cached.captions[index - 1].timeMs))) return cached;
  } catch { /* Missing or stale alignment is recreated. */ }
  const audioDurationMs = await narrationDuration(filePath);
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buffer)], { type: path.extname(filePath).toLowerCase() === '.mp3' ? 'audio/mpeg' : 'application/octet-stream' }), path.basename(filePath));
  form.append('text', text);
  const response = await fetch('https://api.elevenlabs.io/v1/forced-alignment', {
    method: 'POST', headers: { 'xi-api-key': apiKey }, body: form, signal: AbortSignal.timeout(90000)
  });
  if (!response.ok) throw new Error(`ElevenLabs caption alignment failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
  const data = await response.json() as { characters?: SpeechCharacter[] };
  if (!Array.isArray(data.characters)) throw new Error('ElevenLabs returned no character alignment.');
  const timing = timingFromCharacters(captions, data.characters, audioDurationMs);
  await saveSpeechTiming(filePath, text, captions, timing);
  return timing;
}
