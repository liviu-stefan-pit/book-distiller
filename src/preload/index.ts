import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { FolderChoice } from '../main/bookFolder';
import type { SaveKeyResult, Session } from '../main/cursorKey';
import type { DistillInput, DistillResult, DistillSlice, OpenBookResult, RedoResult } from '../main/distill';
import type { PdfDecision } from '../main/inspectPdf';
import type { Slice } from '../main/slicePdf';

contextBridge.exposeInMainWorld('bookDistiller', {
  pathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  inspectPdf: (data: Uint8Array, fileName: string, pdfPath: string): Promise<PdfDecision> =>
    ipcRenderer.invoke('inspect-pdf', data, fileName, pdfPath),
  slicePdf: (data: Uint8Array): Promise<Slice[]> => ipcRenderer.invoke('slice-pdf', data),
  chooseFolder: (): Promise<FolderChoice> => ipcRenderer.invoke('choose-folder'),
  saveKey: (apiKey: string): Promise<SaveKeyResult> => ipcRenderer.invoke('save-key', apiKey),
  forgetKey: (): Promise<void> => ipcRenderer.invoke('forget-key'),
  session: (): Promise<Session> => ipcRenderer.invoke('session'),
  chooseModel: (modelId: string): Promise<void> => ipcRenderer.invoke('choose-model', modelId),
  openBook: (folderPath: string): Promise<OpenBookResult> => ipcRenderer.invoke('open-book', folderPath),
  setChecks: (folderPath: string, checks: Array<{ id: string; checked: boolean }>): Promise<void> =>
    ipcRenderer.invoke('set-checks', folderPath, checks),
  distill: (input: DistillInput): Promise<DistillResult> => ipcRenderer.invoke('distill', input),
  redo: (input: DistillInput, sectionId: string): Promise<RedoResult> =>
    ipcRenderer.invoke('redo', input, sectionId),
  cancelDistill: (): Promise<void> => ipcRenderer.invoke('cancel-distill'),
  minimizeWindow: (): void => {
    ipcRenderer.send('window-minimize');
  },
  toggleMaximizeWindow: (): void => {
    ipcRenderer.send('window-toggle-maximize');
  },
  closeWindow: (): void => {
    ipcRenderer.send('window-close');
  },
  onMaximized: (listener: (maximized: boolean) => void): (() => void) => {
    const wrapped = (_event: unknown, maximized: boolean): void => {
      listener(maximized);
    };
    ipcRenderer.on('window-maximized', wrapped);
    return () => {
      ipcRenderer.removeListener('window-maximized', wrapped);
    };
  },
  onDistillProgress: (listener: (slices: DistillSlice[]) => void): (() => void) => {
    const wrapped = (_event: unknown, slices: DistillSlice[]): void => {
      listener(slices);
    };
    ipcRenderer.on('distill-progress', wrapped);
    return () => {
      ipcRenderer.removeListener('distill-progress', wrapped);
    };
  },
});
