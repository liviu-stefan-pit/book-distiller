import { dialog } from 'electron';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export type FolderChoice =
  | { status: 'chosen'; folderPath: string }
  | { status: 'canceled' }
  | { status: 'refused'; message: string };

const refusal = "Choose an empty folder or this book's folder.";
const unreadable = 'This book folder could not be read.';

export async function chooseBookFolder(pdfPath: string): Promise<FolderChoice> {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (result.canceled || result.filePaths[0] === undefined) {
    return { status: 'canceled' };
  }
  return acceptBookFolder(result.filePaths[0], pdfPath);
}

async function acceptBookFolder(folderPath: string, pdfPath: string): Promise<FolderChoice> {
  try {
    const info = await stat(folderPath);
    if (!info.isDirectory()) {
      return { status: 'refused', message: refusal };
    }
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code !== 'ENOENT') {
      throw error;
    }
    await mkdir(folderPath, { recursive: true });
    return { status: 'chosen', folderPath };
  }

  const manifest = await peekManifest(folderPath);
  if (manifest.kind === 'invalid') {
    return { status: 'refused', message: unreadable };
  }
  if (manifest.kind === 'ready') {
    if (pdfPath !== '' && !samePath(manifest.pdfPath, pdfPath)) {
      return { status: 'refused', message: refusal };
    }
    return { status: 'chosen', folderPath };
  }
  const entries = await readdir(folderPath);
  if (entries.length === 0) {
    return { status: 'chosen', folderPath };
  }
  return { status: 'refused', message: refusal };
}

async function peekManifest(
  folderPath: string,
): Promise<{ kind: 'absent' } | { kind: 'invalid' } | { kind: 'ready'; pdfPath: string }> {
  let text: string;
  try {
    text = await readFile(join(folderPath, 'book-manifest.json'), 'utf8');
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') {
      return { kind: 'absent' };
    }
    return { kind: 'invalid' };
  }
  try {
    const manifest = JSON.parse(text) as { schemaVersion?: unknown; pdfPath?: unknown };
    if (manifest.schemaVersion !== 1 || typeof manifest.pdfPath !== 'string') {
      return { kind: 'invalid' };
    }
    return { kind: 'ready', pdfPath: manifest.pdfPath };
  } catch {
    return { kind: 'invalid' };
  }
}

function samePath(left: string, right: string): boolean {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}
