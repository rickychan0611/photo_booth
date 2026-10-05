import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { app } from 'electron';
import type { CanonConnectResult, CanonStillCrop } from './types';

type CanonResponse = {
  ok: boolean;
  id?: number | null;
  ready?: boolean;
  connected?: boolean;
  model?: string;
  path?: string;
  dataUrl?: string;
  width?: number;
  height?: number;
  error?: string;
};

type Pending = {
  resolve: (value: CanonResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

let proc: ChildProcessWithoutNullStreams | null = null;
let starting: Promise<void> | null = null;
let nextId = 0;
const pending = new Map<number, Pending>();

const projectRoot = () => app.getAppPath();

const scriptPath = () =>
  app.isPackaged
    ? path.join(process.resourcesPath, 'python', 'canon_service.py')
    : path.join(projectRoot(), 'python', 'canon_service.py');

const edsdkDir = () => {
  const packaged = path.join(process.resourcesPath, 'edsdk');
  if (app.isPackaged && fs.existsSync(path.join(packaged, 'EDSDK.dll'))) return packaged;
  return path.join(projectRoot(), 'EDSDK_v13.20.21_Windows', 'EDSDK_64', 'Dll');
};

const parseLine = (line: string): CanonResponse | null => {
  try {
    return JSON.parse(line) as CanonResponse;
  } catch {
    console.warn('[canon]', line);
    return null;
  }
};

const rejectPending = (error: Error) => {
  for (const [id, item] of pending) {
    clearTimeout(item.timer);
    item.reject(error);
    pending.delete(id);
  }
};

const pythonLaunch = async (): Promise<{ command: string; prefix: string[] }> => {
  const attempts = [
    { command: 'py', prefix: ['-3'] },
    { command: 'python', prefix: [] as string[] },
    { command: 'python3', prefix: [] as string[] }
  ];
  for (const attempt of attempts) {
    const usable = await new Promise<boolean>((resolve) => {
      const child = spawn(attempt.command, [...attempt.prefix, '-c', 'import sys; raise SystemExit(0 if sys.maxsize > 2**32 else 1)'], {
        windowsHide: true
      });
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
    });
    if (usable) return attempt;
  }
  throw new Error('64-bit Python was not found. Install Python 3, then run: py -3 -m pip install pillow');
};

const ensureStarted = async () => {
  if (proc && proc.exitCode === null && !proc.killed) return;
  if (starting) return starting;
  starting = (async () => {
    const dllDir = edsdkDir();
    if (!fs.existsSync(path.join(dllDir, 'EDSDK.dll'))) {
      throw new Error('Canon EDSDK.dll was not found next to the app.');
    }
    const script = scriptPath();
    if (!fs.existsSync(script)) throw new Error('Canon Python service is missing.');
    const python = await pythonLaunch();
    const child = spawn(python.command, [...python.prefix, script], {
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        CANON_EDSDK_DIR: dllDir
      }
    });
    proc = child;
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) console.warn('[canon]', text);
    });
    const rl = readline.createInterface({ input: child.stdout });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Canon service did not start.')), 15000);
      const finish = (error?: Error) => {
        clearTimeout(timer);
        rl.off('line', onLine);
        if (error) reject(error);
        else resolve();
      };
      const onExit = () => finish(new Error('Canon service stopped before it was ready.'));
      const onLine = (line: string) => {
        const message = parseLine(line);
        if (!message) return;
        child.off('exit', onExit);
        if (message.ok && message.ready) finish();
        else finish(new Error(message.error || 'Canon service failed to start.'));
      };
      child.once('exit', onExit);
      child.once('error', (error) => finish(error));
      rl.on('line', onLine);
    });
    rl.on('line', (line) => {
      const message = parseLine(line);
      if (!message || message.id == null) return;
      const waiter = pending.get(message.id);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      pending.delete(message.id);
      waiter.resolve(message);
    });
    child.on('exit', () => {
      if (proc === child) proc = null;
      rejectPending(new Error('Canon service stopped.'));
    });
  })().finally(() => {
    starting = null;
  });
  try {
    await starting;
  } catch (error) {
    proc?.kill();
    proc = null;
    throw error;
  }
};

const request = async (body: Record<string, unknown>, timeoutMs: number) => {
  await ensureStarted();
  if (!proc || !proc.stdin) throw new Error('Canon service is not running.');
  const id = ++nextId;
  const response = new Promise<CanonResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Canon camera timed out.'));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
  });
  proc.stdin.write(`${JSON.stringify({ ...body, id })}\n`);
  const message = await response;
  if (!message.ok) throw new Error(message.error || 'Canon command failed.');
  return message;
};

export const connectCanon = async (): Promise<CanonConnectResult> => {
  try {
    const message = await request({ cmd: 'connect' }, 20000);
    return { ok: true, model: message.model || 'Canon EOS' };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not connect to the Canon camera.' };
  }
};

export const captureCanonStill = async (crop: CanonStillCrop) => {
  const dest = path.join(os.tmpdir(), 'photo-booth-canon');
  fs.mkdirSync(dest, { recursive: true });
  const message = await request({ cmd: 'take', dest, crop }, 35000);
  if (!message.path) throw new Error('Canon camera did not return a photo.');
  return { path: message.path, width: message.width ?? 0, height: message.height ?? 0 };
};

export const getCanonLiveViewFrame = async () => {
  const message = await request({ cmd: 'live_frame' }, 5000);
  return message.dataUrl ?? '';
};

export const prepareCanonCapture = async () => {
  await request({ cmd: 'prepare_capture' }, 5000);
};

export const releaseCanonFocus = async () => {
  await request({ cmd: 'release_focus' }, 5000);
};

export const stopCanonService = () => {
  const child = proc;
  if (!child) return;
  try {
    child.stdin.write(`${JSON.stringify({ cmd: 'shutdown', id: 0 })}\n`);
  } catch {
    child.kill();
  }
  setTimeout(() => {
    if (child.exitCode === null) child.kill();
  }, 1000);
};
