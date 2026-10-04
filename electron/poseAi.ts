import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { AppSettings } from './types';
import type { PoseAiGenerateRequest } from './poseTypes';
import { generatePoseFromDescription } from './poseAiCore';

function adminOnly(event: IpcMainInvokeEvent) {
  if (new URL(event.sender.getURL()).searchParams.get('window') !== 'admin') throw new Error('Open the admin window to generate poses.');
}

export function registerPoseAi(readSettings: () => Promise<AppSettings>) {
  ipcMain.handle('poses:generate', async (event, request: PoseAiGenerateRequest) => {
    adminOnly(event);
    return generatePoseFromDescription(request, await readSettings());
  });
}
