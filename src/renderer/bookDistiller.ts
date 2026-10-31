import type { PdfDecision } from '../main/inspectPdf';

export interface BookDistillerApi {
  inspectPdf: (data: Uint8Array, fileName: string) => Promise<PdfDecision>;
}

declare global {
  interface Window {
    bookDistiller: BookDistillerApi;
  }
}
