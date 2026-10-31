import { createRequire } from 'node:module';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readCursorKey } from './cursorKey';

const nodeRequire = createRequire(import.meta.url);

GlobalWorkerOptions.workerSrc = pathToFileURL(
  nodeRequire.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

const keepEveryTechnicalDetail =
  'It keeps every technical rule, number, threshold, mechanism, edge case, and warning.';

export type BoardPoint = {
  kind: string;
  title: string;
  explanation: string;
  page: number;
  example?: { text: string; page: number };
};

export type BoardCode = {
  title: string;
  language: string;
  page: number;
  source: string;
  notes: Array<{ lines: string; why: string }>;
};

export type Board = {
  schemaVersion: number;
  sectionId: string;
  sectionTitle: string;
  pageStart: number;
  pageEnd: number;
  points: BoardPoint[];
  code: BoardCode[];
};

export type DistillSlice = {
  id: string;
  title: string;
  pageStart: number;
  pageEnd: number;
  checked: boolean;
  status: 'queued' | 'writing' | 'done' | 'failed';
  modelId?: string;
  failureReason?: string;
  board?: Board;
};

export type DistillInput = {
  folderPath: string;
  pdfPath: string;
  title: string;
  modelId: string;
  pdfBytes: Uint8Array;
  slices: Array<
    Pick<DistillSlice, 'id' | 'title' | 'pageStart' | 'pageEnd' | 'checked'> &
      Partial<Pick<DistillSlice, 'status' | 'modelId' | 'failureReason' | 'board'>>
  >;
};

export type DistillResult = {
  slices: DistillSlice[];
};

export type OpenBookResult =
  | {
      status: 'opened';
      pdfPath: string;
      title: string;
      pdfMissing: boolean;
      pdfBytes: Uint8Array;
      slices: DistillSlice[];
    }
  | { status: 'empty' }
  | { status: 'refused'; message: string };

const unreadableBook = 'This book folder could not be read.';

let replyIndex = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function matchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function firstJsonObject(text: string): unknown {
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{') {
      continue;
    }
    const end = matchingBrace(text, start);
    if (end === -1) {
      continue;
    }
    try {
      return JSON.parse(text.slice(start, end + 1)) as unknown;
    } catch {
      continue;
    }
  }
  return undefined;
}

function isNetworkReply(text: string): boolean {
  try {
    const value = JSON.parse(text.trim()) as unknown;
    return isRecord(value) && value.error === 'network' && !('schemaVersion' in value);
  } catch {
    return false;
  }
}

function readPoint(value: unknown): BoardPoint | 'shape' {
  if (
    !isRecord(value) ||
    typeof value.kind !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.explanation !== 'string' ||
    typeof value.page !== 'number' ||
    (value.kind !== 'must-remember' && value.kind !== 'mechanics' && value.kind !== 'useful-later')
  ) {
    return 'shape';
  }
  const point: BoardPoint = {
    kind: value.kind,
    title: value.title,
    explanation: value.explanation,
    page: value.page,
  };
  if (!('example' in value) || value.example === undefined) {
    return point;
  }
  if (!isRecord(value.example) || typeof value.example.text !== 'string' || typeof value.example.page !== 'number') {
    return 'shape';
  }
  point.example = { text: value.example.text, page: value.example.page };
  return point;
}

function readCode(value: unknown): BoardCode | 'shape' {
  if (
    !isRecord(value) ||
    typeof value.title !== 'string' ||
    typeof value.language !== 'string' ||
    typeof value.source !== 'string' ||
    typeof value.page !== 'number'
  ) {
    return 'shape';
  }
  const notes: BoardCode['notes'] = [];
  if (value.notes !== undefined) {
    if (!Array.isArray(value.notes)) {
      return 'shape';
    }
    for (const note of value.notes) {
      if (!isRecord(note) || typeof note.lines !== 'string' || typeof note.why !== 'string') {
        return 'shape';
      }
      notes.push({ lines: note.lines, why: note.why });
    }
  }
  return {
    title: value.title,
    language: value.language,
    page: value.page,
    source: value.source,
    notes,
  };
}

function readBoard(value: unknown): Board | 'shape' | undefined {
  if (!isRecord(value) || !Array.isArray(value.points)) {
    return undefined;
  }
  const points: BoardPoint[] = [];
  for (const item of value.points) {
    const point = readPoint(item);
    if (point === 'shape') {
      return 'shape';
    }
    points.push(point);
  }
  const code = readCodeList(value.code);
  if (code === 'shape') {
    return 'shape';
  }
  return {
    schemaVersion: typeof value.schemaVersion === 'number' ? value.schemaVersion : 0,
    sectionId: typeof value.sectionId === 'string' ? value.sectionId : '',
    sectionTitle: typeof value.sectionTitle === 'string' ? value.sectionTitle : '',
    pageStart: typeof value.pageStart === 'number' ? value.pageStart : 0,
    pageEnd: typeof value.pageEnd === 'number' ? value.pageEnd : 0,
    points,
    code,
  };
}

function readCodeList(value: unknown): BoardCode[] | 'shape' {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return 'shape';
  }
  const code: BoardCode[] = [];
  for (const item of value) {
    const block = readCode(item);
    if (block === 'shape') {
      return 'shape';
    }
    code.push(block);
  }
  return code;
}

function interpret(text: string): { board: Board } | { failure: 'network' | 'shape' } {
  if (isNetworkReply(text)) {
    return { failure: 'network' };
  }
  const board = readBoard(firstJsonObject(text));
  if (board === undefined || board === 'shape') {
    return { failure: 'shape' };
  }
  return { board };
}

function instructions(): string {
  return [
    keepEveryTechnicalDetail,
    "It keeps the book's own example on the point it illustrates.",
    'It copies every required listing verbatim and adds short line notes; those notes are the agent\u2019s words.',
    'It leaves out conversational filler, anecdotes that teach no rule, historical trivia, and repeated intros.',
    'It cites the PDF page from the page stamps.',
    'It adds no example the book did not write.',
    'Reply with only the board JSON.',
    'schemaVersion is 1.',
    'Each point kind is must-remember, mechanics, or useful-later.',
    'example is present only when the book illustrates that point.',
  ].join('\n');
}

type PdfTextItem = {
  str?: string;
  transform?: number[];
  fontName?: string;
};

type BuiltLine = {
  text: string;
  y: number;
  monospaceChars: boolean;
  otherChars: boolean;
};

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function pageInside(page: number, pageStart: number, pageEnd: number): boolean {
  return Number.isInteger(page) && page >= pageStart && page <= pageEnd;
}

function shapeRejects(board: Board, pageStart: number, pageEnd: number): boolean {
  if (board.schemaVersion !== 1) {
    return true;
  }
  const pages = [board.pageStart, board.pageEnd];
  for (const point of board.points) {
    pages.push(point.page);
    if (point.example) {
      pages.push(point.example.page);
    }
  }
  for (const block of board.code) {
    pages.push(block.page);
  }
  return pages.some((page) => !pageInside(page, pageStart, pageEnd));
}

function listingsMatch(board: Board, listings: string[]): boolean {
  const source = collapseWhitespace(board.code.map((block) => block.source).join('\n'));
  return listings.every((listing) => source.includes(collapseWhitespace(listing)));
}

async function readSlice(
  bytes: Uint8Array,
  pageStart: number,
  pageEnd: number,
): Promise<{ text: string; listings: string[] }> {
  const task = getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  const pdf = await task.promise;
  try {
    const pages: string[] = [];
    const listings: string[] = [];
    let run: string[] = [];
    const flush = (): void => {
      if (run.length > 0) {
        listings.push(run.join('\n'));
        run = [];
      }
    };
    for (let pageNumber = pageStart; pageNumber <= pageEnd; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const styles = content.styles as Record<string, { fontFamily?: string }>;
      const lines: BuiltLine[] = [];
      for (const item of content.items as PdfTextItem[]) {
        if (typeof item.str !== 'string') {
          continue;
        }
        const y = item.transform?.[5] ?? 0;
        const monospace = styles[item.fontName ?? '']?.fontFamily === 'monospace';
        const last = lines[lines.length - 1];
        if (!last || Math.abs(y - last.y) > 2) {
          lines.push({
            text: item.str,
            y,
            monospaceChars: item.str.trim() !== '' && monospace,
            otherChars: item.str.trim() !== '' && !monospace,
          });
        } else {
          last.text += item.str;
          if (item.str.trim() !== '') {
            if (monospace) {
              last.monospaceChars = true;
            } else {
              last.otherChars = true;
            }
          }
        }
      }
      const pageLines: string[] = [];
      for (const line of lines) {
        if (line.text.trim() === '') {
          flush();
          continue;
        }
        pageLines.push(line.text);
        if (line.monospaceChars && !line.otherChars) {
          run.push(line.text.trim());
        } else {
          flush();
        }
      }
      pages.push(`--- PAGE ${pageNumber} ---\n${pageLines.join('\n')}`);
    }
    flush();
    return { text: `${pages.join('\n')}\n`, listings };
  } finally {
    await task.destroy();
  }
}

let temporaryWorkRoot: string | undefined;

async function prepareWorkspace(sectionId: string, text: string): Promise<string> {
  const configured = process.env.BOOK_DISTILLER_WORK_ROOT;
  const rooted = configured !== undefined && configured !== '';
  const root = rooted ? configured : await mkdtemp(join(tmpdir(), 'book-distiller-work-'));
  temporaryWorkRoot = rooted ? undefined : root;
  const dir = join(root, sectionId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'slice.txt'), text, 'utf8');
  await writeFile(join(dir, 'instructions.md'), `${instructions()}\n`, 'utf8');
  return dir;
}

async function releaseTemporaryWorkspace(): Promise<void> {
  const root = temporaryWorkRoot;
  temporaryWorkRoot = undefined;
  if (root) {
    await rm(root, { recursive: true, force: true });
  }
}

async function nextReply(modelId: string, sectionId: string, workspace: string, prompt: string): Promise<string> {
  const logPath = process.env.BOOK_DISTILLER_AGENT_LOG;
  if (logPath) {
    await appendFile(logPath, `${JSON.stringify({ modelId, sectionId })}\n`, 'utf8');
  }
  const agentFile = process.env.BOOK_DISTILLER_AGENT_FILE;
  if (agentFile) {
    const body = JSON.parse(await readFile(agentFile, 'utf8')) as { replies?: unknown };
    const replies = Array.isArray(body.replies) ? body.replies : [];
    const reply = replies[replyIndex];
    replyIndex += 1;
    return typeof reply === 'string' ? reply : '';
  }
  const apiKey = await readCursorKey();
  const { Agent } = await import('@cursor/sdk');
  const result = await Agent.prompt(prompt, {
    apiKey,
    model: { id: modelId },
    local: { cwd: workspace },
  });
  return typeof result.result === 'string' ? result.result : '';
}

function noteFor(board: Board): string {
  if (board.points.length === 0 && board.code.length === 0) {
    const pages = board.pageStart === board.pageEnd ? `${board.pageStart}` : `${board.pageStart}–${board.pageEnd}`;
    return `# ${board.sectionTitle}\n\nPage ${pages}\n\nThose pages had no technical content.\n`;
  }
  const lines = [`# ${board.sectionTitle}`, ''];
  const groups: Array<[string, string]> = [
    ['must-remember', 'Must remember'],
    ['mechanics', 'Mechanics'],
    ['useful-later', 'Useful later'],
  ];
  for (const [kind, heading] of groups) {
    lines.push(`## ${heading}`, '');
    for (const point of board.points) {
      if (point.kind !== kind) {
        continue;
      }
      lines.push(point.title, '', point.explanation, '', `Page ${point.page}`, '');
      if (point.example) {
        lines.push(point.example.text, '', `Page ${point.example.page}`, '');
      }
    }
  }
  lines.push('## Code', '');
  for (const block of board.code) {
    lines.push(block.title, '', block.language, '', `Page ${block.page}`, '', block.source, '');
    for (const item of block.notes) {
      lines.push(item.lines, '', item.why, '');
    }
  }
  return `${lines.join('\n').trim()}\n`;
}

let cancelRequested = false;

export function requestCancel(): void {
  cancelRequested = true;
}

function agentDelayMs(): number {
  const raw = process.env.BOOK_DISTILLER_AGENT_DELAY_MS;
  if (raw === undefined || !/^[0-9]+$/.test(raw)) {
    return 0;
  }
  const delay = Number(raw);
  return Number.isSafeInteger(delay) ? delay : 0;
}

async function waitForReply(): Promise<boolean> {
  const delay = agentDelayMs();
  if (delay > 0) {
    await new Promise((resolve) => {
      setTimeout(resolve, delay);
    });
  }
  return !cancelRequested;
}

function afterReplyDelayMs(): number {
  const raw = process.env.BOOK_DISTILLER_AFTER_REPLY_DELAY_MS;
  if (raw === undefined || !/^[0-9]+$/.test(raw)) {
    return 0;
  }
  const delay = Number(raw);
  return Number.isSafeInteger(delay) ? delay : 0;
}

async function waitAfterReply(): Promise<void> {
  const delay = afterReplyDelayMs();
  if (delay > 0) {
    await new Promise((resolve) => {
      setTimeout(resolve, delay);
    });
  }
}

async function loadValidBoard(
  folderPath: string,
  sectionId: string,
  pageStart: number,
  pageEnd: number,
  listings: string[] | undefined,
): Promise<Board | undefined> {
  try {
    const text = await readFile(join(folderPath, 'boards', `${sectionId}.board.json`), 'utf8');
    const board = readBoard(JSON.parse(text) as unknown);
    if (board === undefined || board === 'shape' || shapeRejects(board, pageStart, pageEnd)) {
      return undefined;
    }
    if (listings !== undefined && !listingsMatch(board, listings)) {
      return undefined;
    }
    return board;
  } catch {
    return undefined;
  }
}

let manifestChain: Promise<void> = Promise.resolve();

function queueManifest(task: () => Promise<void>): Promise<void> {
  const run = manifestChain.then(task, task);
  manifestChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function writeManifest(input: DistillInput, slices: DistillSlice[]): Promise<void> {
  const body = `${JSON.stringify(
      {
        schemaVersion: 1,
        pdfPath: input.pdfPath,
        title: input.title,
        slices: slices.map((slice) => {
          const stored: Record<string, unknown> = {
            id: slice.id,
            title: slice.title,
            pageStart: slice.pageStart,
            pageEnd: slice.pageEnd,
            checked: slice.checked,
            status: slice.status,
          };
          if (slice.status === 'done' && slice.modelId) {
            stored.modelId = slice.modelId;
          }
          if (slice.status === 'failed' && slice.failureReason) {
            stored.failureReason = slice.failureReason;
          }
          return stored;
        }),
      },
      null,
      2,
    )}\n`;
  await queueManifest(() => writeFile(join(input.folderPath, 'book-manifest.json'), body, 'utf8'));
}

type StoredSlice = {
  id: string;
  title: string;
  pageStart: number;
  pageEnd: number;
  checked: boolean;
  status: string;
  modelId?: string;
  failureReason?: string;
};

function readStoredSlice(value: unknown): StoredSlice | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.pageStart !== 'number' ||
    typeof value.pageEnd !== 'number' ||
    typeof value.checked !== 'boolean'
  ) {
    return undefined;
  }
  const slice: StoredSlice = {
    id: value.id,
    title: value.title,
    pageStart: value.pageStart,
    pageEnd: value.pageEnd,
    checked: value.checked,
    status: typeof value.status === 'string' ? value.status : 'queued',
  };
  if (typeof value.modelId === 'string') {
    slice.modelId = value.modelId;
  }
  if (typeof value.failureReason === 'string') {
    slice.failureReason = value.failureReason;
  }
  return slice;
}

function readStoredManifest(
  value: unknown,
): { pdfPath: string; title: string; slices: StoredSlice[] } | 'invalid' {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.pdfPath !== 'string') {
    return 'invalid';
  }
  const slices: StoredSlice[] = [];
  if (Array.isArray(value.slices)) {
    for (const item of value.slices) {
      const slice = readStoredSlice(item);
      if (slice) {
        slices.push(slice);
      }
    }
  }
  return {
    pdfPath: value.pdfPath,
    title: typeof value.title === 'string' ? value.title : '',
    slices,
  };
}

function reopenedSlice(item: StoredSlice, board: Board | undefined): DistillSlice {
  const base = {
    id: item.id,
    title: item.title,
    pageStart: item.pageStart,
    pageEnd: item.pageEnd,
    checked: item.checked,
  };
  if (board) {
    return {
      ...base,
      status: 'done',
      ...(item.modelId ? { modelId: item.modelId } : {}),
      board,
    };
  }
  if (item.status === 'failed') {
    return {
      ...base,
      status: 'failed',
      ...(item.failureReason ? { failureReason: item.failureReason } : {}),
    };
  }
  return { ...base, status: 'queued' };
}

export async function openBook(folderPath: string): Promise<OpenBookResult> {
  let text: string;
  try {
    text = await readFile(join(folderPath, 'book-manifest.json'), 'utf8');
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') {
      return { status: 'empty' };
    }
    return { status: 'refused', message: unreadableBook };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { status: 'refused', message: unreadableBook };
  }
  const stored = readStoredManifest(parsed);
  if (stored === 'invalid') {
    return { status: 'refused', message: unreadableBook };
  }
  let pdfBytes = new Uint8Array();
  let pdfMissing = false;
  try {
    pdfBytes = new Uint8Array(await readFile(stored.pdfPath));
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code !== 'ENOENT') {
      throw error;
    }
    pdfMissing = true;
  }
  const slices: DistillSlice[] = [];
  for (const item of stored.slices) {
    const listings = pdfMissing
      ? undefined
      : (await readSlice(pdfBytes, item.pageStart, item.pageEnd)).listings;
    const board = await loadValidBoard(folderPath, item.id, item.pageStart, item.pageEnd, listings);
    slices.push(reopenedSlice(item, board));
  }
  await writeManifest(
    {
      folderPath,
      pdfPath: stored.pdfPath,
      title: stored.title,
      modelId: '',
      pdfBytes,
      slices: [],
    },
    slices,
  );
  return {
    status: 'opened',
    pdfPath: stored.pdfPath,
    title: stored.title,
    pdfMissing,
    pdfBytes,
    slices,
  };
}

async function writeAccepted(
  input: DistillInput,
  slices: DistillSlice[],
  sliceId: string,
  board: Board,
): Promise<void> {
  await mkdir(join(input.folderPath, 'boards'), { recursive: true });
  await mkdir(join(input.folderPath, 'notes'), { recursive: true });
  await writeFile(
    join(input.folderPath, 'boards', `${sliceId}.board.json`),
    `${JSON.stringify(board, null, 2)}\n`,
    'utf8',
  );
  await writeFile(join(input.folderPath, 'notes', `${sliceId}.md`), noteFor(board), 'utf8');
  await writeManifest(input, slices);
}

export async function writeChecks(
  folderPath: string,
  checks: Array<{ id: string; checked: boolean }>,
): Promise<void> {
  await queueManifest(async () => {
    const manifestPath = join(folderPath, 'book-manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      slices?: Array<{ id?: unknown; checked?: boolean }>;
    };
    if (!Array.isArray(manifest.slices)) {
      return;
    }
    const byId = new Map(checks.map((item) => [item.id, item.checked]));
    for (const slice of manifest.slices) {
      if (typeof slice.id === 'string' && byId.has(slice.id)) {
        slice.checked = byId.get(slice.id) === true;
      }
    }
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  });
}

export async function distillQueue(
  input: DistillInput,
  onProgress: (slices: DistillSlice[]) => void,
): Promise<DistillResult> {
  if (input.pdfBytes.byteLength === 0) {
    input = { ...input, pdfBytes: new Uint8Array(await readFile(input.pdfPath)) };
  }
  cancelRequested = false;
  const slices: DistillSlice[] = input.slices.map((slice) => ({
    ...slice,
    status: slice.status ?? 'queued',
  }));
  const notify = (): void => {
    onProgress(slices.map((slice) => ({ ...slice })));
  };
  for (const target of slices) {
    if (!target.checked || target.status === 'done') {
      continue;
    }
    const read = await readSlice(input.pdfBytes, target.pageStart, target.pageEnd);
    const existing = await loadValidBoard(
      input.folderPath,
      target.id,
      target.pageStart,
      target.pageEnd,
      read.listings,
    );
    if (existing) {
      target.status = 'done';
      target.board = existing;
      await writeManifest(input, slices);
      notify();
      continue;
    }
    target.status = 'writing';
    notify();
    const workspace = await prepareWorkspace(target.id, read.text);
    try {
      const prompt = `${instructions()}\n\n${read.text}`;
      const ask = async (): Promise<
        { board: Board } | { failure: 'shape' | 'missing listing' | 'network' | 'cancelled' }
      > => {
        try {
          if (!(await waitForReply())) {
            return { failure: 'cancelled' };
          }
          const reply = await nextReply(input.modelId, target.id, workspace, prompt);
          await waitAfterReply();
          if (cancelRequested) {
            return { failure: 'cancelled' };
          }
          const interpreted = interpret(reply);
          if (!('board' in interpreted)) {
            return interpreted;
          }
          if (shapeRejects(interpreted.board, target.pageStart, target.pageEnd)) {
            return { failure: 'shape' };
          }
          if (!listingsMatch(interpreted.board, read.listings)) {
            return { failure: 'missing listing' };
          }
          return interpreted;
        } catch {
          return { failure: 'network' };
        }
      };
      let outcome = await ask();
      if (!('board' in outcome) && outcome.failure !== 'cancelled') {
        outcome = await ask();
      }
      if (!('board' in outcome)) {
        target.status = 'failed';
        target.failureReason = outcome.failure;
        await writeManifest(input, slices);
        notify();
        if (outcome.failure === 'cancelled') {
          break;
        }
        continue;
      }
      target.status = 'done';
      target.modelId = input.modelId;
      target.board = outcome.board;
      await writeAccepted(input, slices, target.id, outcome.board);
      notify();
    } finally {
      await releaseTemporaryWorkspace();
    }
  }
  return { slices };
}

export type RedoResult =
  | { status: 'kept'; failure?: 'shape' | 'missing listing' | 'network' | 'cancelled' }
  | { status: 'replaced'; slices: DistillSlice[] };

export async function redoSlice(input: DistillInput, sectionId: string): Promise<RedoResult> {
  cancelRequested = false;
  if (input.pdfBytes.byteLength === 0) {
    input = { ...input, pdfBytes: new Uint8Array(await readFile(input.pdfPath)) };
  }
  const target = input.slices.find((slice) => slice.id === sectionId);
  if (!target) {
    return { status: 'kept' };
  }
  const read = await readSlice(input.pdfBytes, target.pageStart, target.pageEnd);
  const workspace = await prepareWorkspace(target.id, read.text);
  try {
    const prompt = `${instructions()}\n\n${read.text}`;
    const ask = async (): Promise<
      { board: Board } | { failure: 'shape' | 'missing listing' | 'network' | 'cancelled' }
    > => {
      try {
        if (!(await waitForReply())) {
          return { failure: 'cancelled' };
        }
        const reply = await nextReply(input.modelId, target.id, workspace, prompt);
        await waitAfterReply();
        if (cancelRequested) {
          return { failure: 'cancelled' };
        }
        const interpreted = interpret(reply);
        if (!('board' in interpreted)) {
          return interpreted;
        }
        if (shapeRejects(interpreted.board, target.pageStart, target.pageEnd)) {
          return { failure: 'shape' };
        }
        if (!listingsMatch(interpreted.board, read.listings)) {
          return { failure: 'missing listing' };
        }
        return interpreted;
      } catch {
        return { failure: 'network' };
      }
    };
    let outcome = await ask();
    if (!('board' in outcome) && outcome.failure !== 'cancelled') {
      outcome = await ask();
    }
    if (!('board' in outcome)) {
      return { status: 'kept', failure: outcome.failure };
    }
    const board = outcome.board;
    const opened = await openBook(input.folderPath);
    if (opened.status !== 'opened') {
      return { status: 'kept' };
    }
    const slices = opened.slices.map((slice) => {
      if (slice.id !== sectionId) {
        return slice;
      }
      return {
        id: slice.id,
        title: slice.title,
        pageStart: slice.pageStart,
        pageEnd: slice.pageEnd,
        checked: slice.checked,
        status: 'done' as const,
        modelId: input.modelId,
        board,
      };
    });
    await writeAccepted(input, slices, sectionId, board);
    return { status: 'replaced', slices };
  } finally {
    await releaseTemporaryWorkspace();
  }
}
