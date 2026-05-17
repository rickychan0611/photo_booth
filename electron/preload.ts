import { contextBridge, ipcRenderer } from 'electron';
import type { AppSettings, Gallery, TemplateAssetRole, TemplateDesign, TemplateStyleId, TemplateUploadRequest, SaveImageRequest, SaveImageResult } from './types';

const api = {
  getSettings: () => ipcRenderer.invoke('settings:get') as Promise<AppSettings>,
  updateSettings: (settings: Partial<AppSettings>) =>
    ipcRenderer.invoke('settings:update', settings) as Promise<AppSettings>,
  chooseFolder: () => ipcRenderer.invoke('dialog:choose-folder') as Promise<string>,
  chooseImage: () => ipcRenderer.invoke('dialog:choose-image') as Promise<string>,
  uploadTemplate: (request: TemplateUploadRequest) =>
    ipcRenderer.invoke('template:upload', request) as Promise<TemplateDesign | null>,
  deleteTemplate: (designId: string) => ipcRenderer.invoke('template:delete', designId) as Promise<boolean>,
  updateTemplate: (design: TemplateDesign) => ipcRenderer.invoke('template:update', design) as Promise<TemplateDesign>,
  updateTemplateAsset: (designId: string, role: TemplateAssetRole) =>
    ipcRenderer.invoke('template:update-asset', designId, role) as Promise<TemplateDesign | null>,
  getImageSize: (filePath: string) => ipcRenderer.invoke('image:size', filePath) as Promise<{ width: number; height: number }>,
  saveGuideTemplate: (styleId: TemplateStyleId, dataUrl: string) =>
    ipcRenderer.invoke('template:save-guide', styleId, dataUrl) as Promise<string>,
  openAdmin: () => ipcRenderer.invoke('window:open-admin') as Promise<boolean>,
  openGuest: () => ipcRenderer.invoke('window:open-guest') as Promise<boolean>,
  openGuestPickerPreview: () => ipcRenderer.invoke('window:open-guest-picker-preview') as Promise<boolean>,
  setGuestFullscreen: (fullscreen: boolean) =>
    ipcRenderer.invoke('guest:set-fullscreen', fullscreen) as Promise<boolean>,
  isGuestFullscreen: () => ipcRenderer.invoke('guest:is-fullscreen') as Promise<boolean>,
  onGuestFullscreenChanged: (callback: (fullscreen: boolean) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, fullscreen: boolean) => callback(fullscreen);
    ipcRenderer.on('guest:fullscreen-changed', listener);
    return () => {
      ipcRenderer.removeListener('guest:fullscreen-changed', listener);
    };
  },
  onOpenGuestPickerPreview: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('guest:open-picker-preview', listener);
    return () => {
      ipcRenderer.removeListener('guest:open-picker-preview', listener);
    };
  },
  listPrinters: () => ipcRenderer.invoke('printers:list') as Promise<Electron.PrinterInfo[]>,
  saveImage: (request: SaveImageRequest) => ipcRenderer.invoke('image:save', request) as Promise<SaveImageResult>,
  getImageDataUrl: (filePath: string) => ipcRenderer.invoke('image:data-url', filePath) as Promise<string>,
  listGallery: () => ipcRenderer.invoke('gallery:list') as Promise<Gallery>,
  openFile: (filePath: string) => ipcRenderer.invoke('file:open', filePath) as Promise<boolean>,
  exportFile: (filePath: string) => ipcRenderer.invoke('file:export', filePath) as Promise<string>,
  deleteFile: (filePath: string) => ipcRenderer.invoke('file:delete', filePath) as Promise<boolean>,
  printImage: (imagePath?: string, printerName?: string) =>
    ipcRenderer.invoke('print:image', imagePath, printerName) as Promise<{ ok: boolean; error?: string }>,
  openPrinterSettings: () => ipcRenderer.invoke('printer:settings') as Promise<boolean>
};

contextBridge.exposeInMainWorld('photoBooth', api);

export type PhotoBoothApi = typeof api;
