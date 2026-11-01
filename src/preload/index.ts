import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { FolderChoice } from '../main/bookFolder';
import type { SaveKeyResult, Session } from '../main/cursorKey';
import type { ComposeInput, ComposeProgress } from '../main/compose';
import type { DistillInput, DistillResult, DistillSlice, OpenBookResult, RedoResult } from '../main/distill';
import type { PdfDecision } from '../main/inspectPdf';
import type { ModelParameterValue, ModelSelection } from '../modelSelection';
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
  chooseBook: (): Promise<FolderChoice> => ipcRenderer.invoke('choose-book'),
  resolveBookFolder: (outputPath: string, pdfPath: string, title: string): Promise<string> =>
    ipcRenderer.invoke('resolve-book-folder', outputPath, pdfPath, title),
  saveKey: (apiKey: string): Promise<SaveKeyResult> => ipcRenderer.invoke('save-key', apiKey),
  forgetKey: (): Promise<void> => ipcRenderer.invoke('forget-key'),
  session: (): Promise<Session> => ipcRenderer.invoke('session'),
  chooseModel: (modelId: string, modelParams: ModelParameterValue[]): Promise<ModelSelection> =>
    ipcRenderer.invoke('choose-model', modelId, modelParams),
  openBook: (folderPath: string): Promise<OpenBookResult> => ipcRenderer.invoke('open-book', folderPath),
  setChecks: (folderPath: string, checks: Array<{ id: string; checked: boolean }>): Promise<void> =>
    ipcRenderer.invoke('set-checks', folderPath, checks),
  distill: (input: DistillInput, runId: number): Promise<DistillResult> =>
    ipcRenderer.invoke('distill', input, runId),
  redo: (input: DistillInput, sectionId: string, runId: number): Promise<RedoResult> =>
    ipcRenderer.invoke('redo', input, sectionId, runId),
  compose: (input: ComposeInput, runId: number): Promise<ComposeProgress> =>
    ipcRenderer.invoke('compose', input, runId),
  openComposedPdf: (folderPath: string): Promise<string> => ipcRenderer.invoke('open-composed-pdf', folderPath),
  readFigure: (folderPath: string, file: string): Promise<string> =>
    ipcRenderer.invoke('read-figure', folderPath, file),
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
  onTokenTotal: (listener: (total: number | null) => void): (() => void) => {
    const wrapped = (_event: unknown, total: number | null): void => {
      listener(total);
    };
    ipcRenderer.on('token-total', wrapped);
    return () => {
      ipcRenderer.removeListener('token-total', wrapped);
    };
  },
  onDistillProgress: (listener: (runId: number, slices: DistillSlice[]) => void): (() => void) => {
    const wrapped = (_event: unknown, runId: number, slices: DistillSlice[]): void => {
      listener(runId, slices);
    };
    ipcRenderer.on('distill-progress', wrapped);
    return () => {
      ipcRenderer.removeListener('distill-progress', wrapped);
    };
  },
  onComposeProgress: (listener: (runId: number, progress: ComposeProgress) => void): (() => void) => {
    const wrapped = (_event: unknown, runId: number, progress: ComposeProgress): void => {
      listener(runId, progress);
    };
    ipcRenderer.on('compose-progress', wrapped);
    return () => {
      ipcRenderer.removeListener('compose-progress', wrapped);
    };
  },
});
