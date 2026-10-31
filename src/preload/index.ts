import { contextBridge, ipcRenderer } from 'electron';
import type { PdfDecision } from '../main/inspectPdf';

contextBridge.exposeInMainWorld('bookDistiller', {
  inspectPdf: (data: Uint8Array, fileName: string): Promise<PdfDecision> =>
    ipcRenderer.invoke('inspect-pdf', data, fileName),
});
