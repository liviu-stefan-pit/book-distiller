import { dialog } from 'electron';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export type FolderChoice =
  | { status: 'chosen'; folderPath: string }
  | { status: 'book'; folderPath: string }
  | { status: 'canceled' }
  | { status: 'refused'; message: string };

const unreadable = 'This book folder could not be read.';
const reserved = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

export async function chooseOutputFolder(): Promise<FolderChoice> {
  const folderPath = await pickDirectory();
  if (folderPath === undefined) {
    return { status: 'canceled' };
  }
  return acceptOutputFolder(folderPath);
}

export async function chooseExistingBook(): Promise<FolderChoice> {
  const folderPath = await pickDirectory();
  if (folderPath === undefined) {
    return { status: 'canceled' };
  }
  const manifest = await peekManifest(folderPath);
  if (manifest.kind !== 'ready') {
    return { status: 'refused', message: unreadable };
  }
  return { status: 'book', folderPath };
}

export async function resolveBookFolder(outputPath: string, pdfPath: string, title: string): Promise<string> {
  await mkdir(outputPath, { recursive: true });
  const own = await peekManifest(outputPath);
  if (own.kind === 'ready' && matchesBook(own, pdfPath)) {
    return outputPath;
  }
  const existing = await findChildBook(outputPath, pdfPath, title);
  if (existing !== undefined) {
    return existing;
  }
  const base = bookFolderName(title);
  for (let index = 1; index < 1000; index += 1) {
    const name = index === 1 ? base : `${base} (${index})`;
    const candidate = join(outputPath, name);
    if (await canUseBookDirectory(candidate, pdfPath)) {
      await mkdir(candidate, { recursive: true });
      return candidate;
    }
  }
  throw new Error('Could not create a book folder.');
}

async function pickDirectory(): Promise<string | undefined> {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (result.canceled || result.filePaths[0] === undefined) {
    return undefined;
  }
  return result.filePaths[0];
}

async function acceptOutputFolder(folderPath: string): Promise<FolderChoice> {
  try {
    const info = await stat(folderPath);
    if (!info.isDirectory()) {
      return { status: 'refused', message: unreadable };
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
    return { status: 'book', folderPath };
  }
  return { status: 'chosen', folderPath };
}

function bookFolderName(title: string): string {
  const cleaned = title
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  const limited = Array.from(cleaned).slice(0, 80).join('').replace(/[. ]+$/g, '').trim();
  const stem = limited.split('.')[0] ?? limited;
  if (limited === '' || reserved.has(stem.toLowerCase())) {
    return 'Book';
  }
  return limited;
}

async function findChildBook(outputPath: string, pdfPath: string, title: string): Promise<string | undefined> {
  const entries = await readdir(outputPath, { withFileTypes: true });
  const matches: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const manifest = await peekManifest(join(outputPath, entry.name));
    if (manifest.kind === 'ready' && matchesBook(manifest, pdfPath)) {
      matches.push(entry.name);
    }
  }
  if (matches.length === 0) {
    return undefined;
  }
  const preferred = bookFolderName(title);
  matches.sort((left, right) => left.localeCompare(right));
  const exact = matches.find((name) => name === preferred);
  return join(outputPath, exact ?? matches[0] ?? preferred);
}

async function canUseBookDirectory(folderPath: string, pdfPath: string): Promise<boolean> {
  try {
    const info = await stat(folderPath);
    if (!info.isDirectory()) {
      return false;
    }
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    return code === 'ENOENT';
  }
  const manifest = await peekManifest(folderPath);
  if (manifest.kind === 'ready') {
    return matchesBook(manifest, pdfPath);
  }
  if (manifest.kind === 'invalid') {
    return false;
  }
  const entries = await readdir(folderPath);
  if (entries.length === 0) {
    return true;
  }
  return entries.includes('boards') || entries.includes('notes');
}

async function peekManifest(
  folderPath: string,
): Promise<{ kind: 'absent' } | { kind: 'invalid' } | { kind: 'ready'; pdfPath: string; originPath?: string }> {
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
    const manifest = JSON.parse(text) as { schemaVersion?: unknown; pdfPath?: unknown; originPath?: unknown };
    if (manifest.schemaVersion !== 1 || typeof manifest.pdfPath !== 'string') {
      return { kind: 'invalid' };
    }
    return {
      kind: 'ready',
      pdfPath: manifest.pdfPath,
      ...(typeof manifest.originPath === 'string' ? { originPath: manifest.originPath } : {}),
    };
  } catch {
    return { kind: 'invalid' };
  }
}

function matchesBook(manifest: { pdfPath: string; originPath?: string }, pdfPath: string): boolean {
  if (samePath(manifest.pdfPath, pdfPath)) {
    return true;
  }
  return manifest.originPath !== undefined && samePath(manifest.originPath, pdfPath);
}

function samePath(left: string, right: string): boolean {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}
