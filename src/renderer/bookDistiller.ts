import type { FolderChoice } from '../main/bookFolder';
import type { SaveKeyResult, Session } from '../main/cursorKey';
import type { ComposeInput, ComposeProgress } from '../main/compose';
import type { DistillInput, DistillResult, DistillSlice, OpenBookResult, RedoResult } from '../main/distill';
import type { PdfDecision } from '../main/inspectPdf';
import type { ModelParameterValue, ModelSelection } from '../modelSelection';
import type { Slice } from '../main/slicePdf';

export interface BookDistillerApi {
  pathForFile: (file: File) => string;
  inspectPdf: (data: Uint8Array, fileName: string, pdfPath: string) => Promise<PdfDecision>;
  slicePdf: (data: Uint8Array) => Promise<Slice[]>;
  chooseFolder: () => Promise<FolderChoice>;
  chooseBook: () => Promise<FolderChoice>;
  resolveBookFolder: (outputPath: string, pdfPath: string, title: string) => Promise<string>;
  saveKey: (apiKey: string) => Promise<SaveKeyResult>;
  forgetKey: () => Promise<void>;
  session: () => Promise<Session>;
  chooseModel: (modelId: string, modelParams: ModelParameterValue[]) => Promise<ModelSelection>;
  openBook: (folderPath: string) => Promise<OpenBookResult>;
  setChecks: (folderPath: string, checks: Array<{ id: string; checked: boolean }>) => Promise<void>;
  distill: (input: DistillInput, runId: number) => Promise<DistillResult>;
  redo: (input: DistillInput, sectionId: string, runId: number) => Promise<RedoResult>;
  compose: (input: ComposeInput, runId: number) => Promise<ComposeProgress>;
  openComposedPdf: (folderPath: string) => Promise<string>;
  readFigure: (folderPath: string, file: string) => Promise<string>;
  cancelDistill: () => Promise<void>;
  minimizeWindow: () => void;
  toggleMaximizeWindow: () => void;
  closeWindow: () => void;
  onMaximized: (listener: (maximized: boolean) => void) => () => void;
  onTokenTotal: (listener: (total: number | null) => void) => () => void;
  onDistillProgress: (listener: (runId: number, slices: DistillSlice[]) => void) => () => void;
  onComposeProgress: (listener: (runId: number, progress: ComposeProgress) => void) => () => void;
}

declare global {
  interface Window {
    bookDistiller: BookDistillerApi;
  }
}
