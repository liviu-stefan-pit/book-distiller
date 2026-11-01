import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelParameterValue } from '../modelSelection';
import { readCursorKey } from './cursorKey';
import {
  acquireSlotWorkspace,
  agentConcurrency,
  beginSession,
  cancelWasRequested,
  requestCancel as cancelHeldRun,
  sendOnSlot,
  summarizeSlot,
} from './heldAgent';
import { readSlice } from './listings';
import { renderPageImages, type RenderedPage } from './pageImages';

const keepEveryTechnicalDetail =
  'It keeps every technical rule, number, threshold, mechanism, edge case, and warning.';

const pageStampRule =
  'Every page is a JSON number taken from a line --- PAGE N ---. A bracketed printed page such as [ 14 ] is not a citation.';

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
  attempt?: number;
  modelId?: string;
  failureReason?: string;
  failureDetail?: string;
  board?: Board;
};

export type DistillInput = {
  folderPath: string;
  pdfPath: string;
  title: string;
  modelId: string;
  modelParams: ModelParameterValue[];
  pdfBytes: Uint8Array;
  slices: Array<
    Pick<DistillSlice, 'id' | 'title' | 'pageStart' | 'pageEnd' | 'checked'> &
      Partial<Pick<DistillSlice, 'status' | 'modelId' | 'failureReason' | 'failureDetail' | 'board'>>
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

function readBoard(value: unknown): Board | 'bad point' | 'bad code' | undefined {
  if (!isRecord(value) || !Array.isArray(value.points)) {
    return undefined;
  }
  const points: BoardPoint[] = [];
  for (const item of value.points) {
    const point = readPoint(item);
    if (point === 'shape') {
      return 'bad point';
    }
    points.push(point);
  }
  const code = readCodeList(value.code);
  if (code === 'shape') {
    return 'bad code';
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

type Failure = 'shape' | 'network' | 'cancelled';

type Rejection = { failure: Failure; detail?: string; reply: string };

type Outcome = { board: Board } | Rejection;

type AgentReply = { text: string; status?: string; errorMessage?: string };

function interpret(text: string): { board: Board } | { failure: 'network' | 'shape'; detail?: string } {
  if (isNetworkReply(text)) {
    return { failure: 'network' };
  }
  const board = readBoard(firstJsonObject(text));
  if (board === undefined) {
    return { failure: 'shape', detail: 'no board json' };
  }
  if (typeof board === 'string') {
    return { failure: 'shape', detail: board };
  }
  return { board };
}

const pointFieldRule =
  'A point has kind, title, explanation, and page. It has no text field. example, when present, is an object with text and page.';
const codeFieldRule =
  'A code block has title, language, page, source, and notes. notes is an array of objects with lines and why.';

function instructions(pageStart: number, pageEnd: number): string {
  return [
    keepEveryTechnicalDetail,
    "It keeps the book's own example on the point it illustrates.",
    `The attached images are PDF pages ${pageStart} through ${pageEnd}, in order. Image 1 is PDF page ${pageStart}.`,
    'The image is the authority for what the page means. The text layer is the authority for code spelling when it agrees with the image.',
    "Include the book's code when that code teaches, with its page, language, and short line notes. Those notes are the agent's words. Copy that code from the text layer when the text matches the page, and from the image otherwise.",
    'It leaves out conversational filler, anecdotes that teach no rule, historical trivia, and repeated intros.',
    'Cite the PDF page index from the --- PAGE N --- stamps and from the image order. A printed folio in the corner is not a citation.',
    pageStampRule,
    'It adds no example the book did not write.',
    'Reply with only the board JSON.',
    'schemaVersion is 1.',
    'Each point kind is must-remember, mechanics, or useful-later.',
    'example is present only when the book illustrates that point.',
    pointFieldRule,
    codeFieldRule,
  ].join('\n');
}

function pageInside(page: number, pageStart: number, pageEnd: number): boolean {
  return Number.isInteger(page) && page >= pageStart && page <= pageEnd;
}

function shapeDetail(board: Board, pageStart: number, pageEnd: number): string | undefined {
  if (board.schemaVersion !== 1) {
    return 'schema version';
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
  const outside = pages.find((page) => !pageInside(page, pageStart, pageEnd));
  return outside === undefined ? undefined : `page ${outside} outside ${pageStart}-${pageEnd}`;
}

function shapeRejects(board: Board, pageStart: number, pageEnd: number): boolean {
  return shapeDetail(board, pageStart, pageEnd) !== undefined;
}

type SliceWorkspace = { dir: string; release: () => Promise<void> };

const keepWorkspace = async (): Promise<void> => undefined;

// The fake reply file keeps one directory per section, and the call that made a temporary root releases it.
// A real agent keeps one stable directory per pool slot for the agent's whole life.
async function sliceDirectory(slot: number, sectionId: string): Promise<SliceWorkspace> {
  if (!process.env.BOOK_DISTILLER_AGENT_FILE) {
    return { dir: await acquireSlotWorkspace(slot), release: keepWorkspace };
  }
  const configured = process.env.BOOK_DISTILLER_WORK_ROOT;
  const rooted = configured !== undefined && configured !== '';
  const root = rooted ? configured : await mkdtemp(join(tmpdir(), 'book-distiller-work-'));
  const dir = join(root, sectionId);
  await mkdir(dir, { recursive: true });
  if (rooted) {
    return { dir, release: keepWorkspace };
  }
  return {
    dir,
    release: async () => {
      try {
        await rm(root, { recursive: true, force: true });
      } catch {
        // A locked directory stays in place; it must not reject the queue.
      }
    },
  };
}

async function prepareWorkspace(
  slot: number,
  sectionId: string,
  text: string,
  pageStart: number,
  pageEnd: number,
): Promise<SliceWorkspace> {
  const workspace = await sliceDirectory(slot, sectionId);
  try {
    await writeFile(join(workspace.dir, 'slice.txt'), text, 'utf8');
    await writeFile(join(workspace.dir, 'instructions.md'), `${instructions(pageStart, pageEnd)}\n`, 'utf8');
  } catch (error) {
    await workspace.release();
    throw error;
  }
  return workspace;
}

async function nextReply(
  slot: number,
  modelId: string,
  modelParams: ModelParameterValue[],
  sectionId: string,
  prompt: string,
  images: RenderedPage[],
): Promise<AgentReply> {
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
    return { text: typeof reply === 'string' ? reply : '' };
  }
  const apiKey = await readCursorKey();
  const result = await sendOnSlot(slot, apiKey, modelId, modelParams, {
    text: prompt,
    images: images.map((image) => ({
      data: image.jpeg.toString('base64'),
      mimeType: 'image/jpeg',
      dimension: { width: image.width, height: image.height },
    })),
  });
  return {
    text: typeof result.result === 'string' ? result.result : '',
    status: result.status,
    ...(result.error?.message ? { errorMessage: result.error.message } : {}),
  };
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

export const requestCancel = cancelHeldRun;

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
  return !cancelWasRequested();
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
): Promise<Board | undefined> {
  try {
    const text = await readFile(join(folderPath, 'boards', `${sectionId}.board.json`), 'utf8');
    const board = readBoard(JSON.parse(text) as unknown);
    if (board === undefined || typeof board === 'string' || shapeRejects(board, pageStart, pageEnd)) {
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
          if (slice.status === 'failed' && slice.failureDetail) {
            stored.failureDetail = slice.failureDetail;
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
  failureDetail?: string;
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
  if (typeof value.failureDetail === 'string') {
    slice.failureDetail = value.failureDetail;
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
      ...(item.failureDetail ? { failureDetail: item.failureDetail } : {}),
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
    const board = await loadValidBoard(folderPath, item.id, item.pageStart, item.pageEnd);
    slices.push(reopenedSlice(item, board));
  }
  await writeManifest(
    {
      folderPath,
      pdfPath: stored.pdfPath,
      title: stored.title,
      modelId: '',
      modelParams: [],
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
  await rm(join(input.folderPath, 'rejects', `${sliceId}.txt`), { force: true });
  await writeManifest(input, slices);
}

async function writeReject(folderPath: string, sectionId: string, rejection: Rejection): Promise<void> {
  const text = rejection.reply !== '' ? rejection.reply : (rejection.detail ?? '');
  if (text === '') {
    return;
  }
  await mkdir(join(folderPath, 'rejects'), { recursive: true });
  await writeFile(join(folderPath, 'rejects', `${sectionId}.txt`), text, 'utf8');
}

const standsAlone =
  'This slice stands alone. Ignore any earlier slice, page, or reply in this conversation, and use only the pages, text, and rules below.';

function attemptPrompt(
  target: Pick<DistillSlice, 'id' | 'title' | 'pageStart' | 'pageEnd'>,
  text: string,
  previous: Rejection | undefined,
): string {
  const skeleton = JSON.stringify(
    {
      schemaVersion: 1,
      sectionId: target.id,
      sectionTitle: target.title,
      pageStart: target.pageStart,
      pageEnd: target.pageEnd,
      points: [],
      code: [],
    },
    null,
    2,
  );
  const specimen = JSON.stringify(
    {
      points: [
        {
          kind: 'must-remember',
          title: 'placeholder title',
          explanation: 'placeholder explanation',
          page: target.pageStart,
          example: { text: 'placeholder example', page: target.pageStart },
        },
      ],
      code: [
        {
          title: 'placeholder title',
          language: 'placeholder language',
          page: target.pageStart,
          source: 'placeholder source',
          notes: [{ lines: 'placeholder lines', why: 'placeholder why' }],
        },
      ],
    },
    null,
    2,
  );
  const prompt =
    `${standsAlone}\n\n${instructions(target.pageStart, target.pageEnd)}\n\nFill in this JSON skeleton:\n\`\`\`json\n${skeleton}\n\`\`\`\n\n` +
    `Field shape, not content to copy:\n\`\`\`json\n${specimen}\n\`\`\`\n\n${text}`;
  if (!previous) {
    return prompt;
  }
  const why = previous.detail ?? previous.failure;
  if (why === 'bad point') {
    return `${prompt}\n\nThe previous reply was rejected: bad point. ${pointFieldRule} Reply with only the board JSON.`;
  }
  if (why === 'bad code') {
    return `${prompt}\n\nThe previous reply was rejected: bad code. ${codeFieldRule} Reply with only the board JSON.`;
  }
  return `${prompt}\n\nThe previous reply was rejected: ${why}. Reply with only the board JSON.`;
}

function judgeReply(
  reply: AgentReply,
  target: Pick<DistillSlice, 'pageStart' | 'pageEnd'>,
): Outcome {
  const text = reply.text;
  if (reply.status === 'error') {
    const detail = reply.errorMessage ?? 'agent run failed';
    return { failure: 'network', detail, reply: text !== '' ? text : detail };
  }
  if (reply.status === 'cancelled') {
    return { failure: 'cancelled', reply: text };
  }
  const interpreted = interpret(text);
  if (!('board' in interpreted)) {
    return { ...interpreted, reply: text };
  }
  const detail = shapeDetail(interpreted.board, target.pageStart, target.pageEnd);
  if (detail !== undefined) {
    return { failure: 'shape', detail, reply: text };
  }
  return { board: interpreted.board };
}

async function askAgent(
  input: DistillInput,
  slot: number,
  target: Pick<DistillSlice, 'id' | 'title' | 'pageStart' | 'pageEnd'>,
  read: { text: string; listings: string[] },
  workspace: string,
  beforeSecondAttempt: () => void,
): Promise<Outcome> {
  const ask = async (attempt: number, previous: Rejection | undefined): Promise<Outcome> => {
    try {
      const prompt = attemptPrompt(target, read.text, previous);
      await writeFile(join(workspace, `attempt-${attempt}.md`), prompt, 'utf8');
      if (!(await waitForReply())) {
        return { failure: 'cancelled', reply: '' };
      }
      const images = await renderPageImages(input.pdfBytes, target.pageStart, target.pageEnd, workspace);
      const reply = await nextReply(slot, input.modelId, input.modelParams, target.id, prompt, images);
      await waitAfterReply();
      if (cancelWasRequested()) {
        return { failure: 'cancelled', reply: reply.text };
      }
      return judgeReply(reply, target);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { failure: 'network', detail, reply: detail };
    }
  };
  let outcome = await ask(1, undefined);
  if (!('board' in outcome) && outcome.failure !== 'cancelled') {
    beforeSecondAttempt();
    outcome = await ask(2, outcome);
  }
  if (!('board' in outcome)) {
    await writeReject(input.folderPath, target.id, outcome);
  }
  return outcome;
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

// The clear between slices: compact that slot's agent context once a slice is settled.
// The fake reply file has no agent, and a cancelled queue does not wait on a summary.
// Resolves true when the user cancelled the summary itself.
async function settleSlice(slot: number): Promise<boolean> {
  if (process.env.BOOK_DISTILLER_AGENT_FILE || cancelWasRequested()) {
    return false;
  }
  return summarizeSlot(slot);
}

export async function distillQueue(
  input: DistillInput,
  onProgress: (slices: DistillSlice[]) => void,
): Promise<DistillResult> {
  if (input.pdfBytes.byteLength === 0) {
    input = { ...input, pdfBytes: new Uint8Array(await readFile(input.pdfPath)) };
  }
  beginSession();
  const slices: DistillSlice[] = input.slices.map((slice) => ({
    ...slice,
    status: slice.status ?? 'queued',
  }));
  const notify = (): void => {
    onProgress(slices.map((slice) => ({ ...slice })));
  };
  await mkdir(input.folderPath, { recursive: true });
  await writeManifest(input, slices);

  const wanted = (slice: DistillSlice): boolean => slice.checked && slice.status !== 'done';
  let cursor = 0;
  // Synchronous, so two workers never take the same slice. Failed slices are claimed; done ones are not.
  const claim = (): DistillSlice | undefined => {
    while (cursor < slices.length) {
      const next = slices[cursor];
      cursor += 1;
      if (next && wanted(next)) {
        return next;
      }
    }
    return undefined;
  };

  // One worker owns one pool slot, and so one warm agent, for the whole queue.
  const runWorker = async (slot: number): Promise<void> => {
    for (;;) {
      if (cancelWasRequested()) {
        return;
      }
      const target = claim();
      if (!target) {
        return;
      }
      const existing = await loadValidBoard(input.folderPath, target.id, target.pageStart, target.pageEnd);
      if (existing) {
        target.status = 'done';
        target.board = existing;
        await writeManifest(input, slices);
        notify();
        continue;
      }
      const read = await readSlice(input.pdfBytes, target.pageStart, target.pageEnd);
      target.status = 'writing';
      target.attempt = 1;
      notify();
      const workspace = await prepareWorkspace(slot, target.id, read.text, target.pageStart, target.pageEnd);
      let stop = false;
      try {
        const outcome = await askAgent(input, slot, target, read, workspace.dir, () => {
          target.attempt = 2;
          notify();
        });
        if (!('board' in outcome)) {
          target.status = 'failed';
          delete target.attempt;
          target.failureReason = outcome.failure;
          if (outcome.detail) {
            target.failureDetail = outcome.detail;
          } else {
            delete target.failureDetail;
          }
          await writeManifest(input, slices);
          notify();
          stop = outcome.failure === 'cancelled';
        } else {
          target.status = 'done';
          delete target.attempt;
          delete target.failureDetail;
          target.modelId = input.modelId;
          target.board = outcome.board;
          await writeAccepted(input, slices, target.id, outcome.board);
          notify();
        }
      } finally {
        await workspace.release();
        if (await settleSlice(slot)) {
          stop = true;
        }
      }
      if (stop) {
        return;
      }
    }
  };

  const workers = Math.min(agentConcurrency(), slices.filter(wanted).length);
  const settled = await Promise.allSettled(Array.from({ length: workers }, (_unused, slot) => runWorker(slot)));
  for (const item of settled) {
    if (item.status === 'rejected') {
      throw item.reason;
    }
  }
  return { slices };
}

export type RedoResult =
  | { status: 'kept'; failure?: Failure; failureDetail?: string }
  | { status: 'replaced'; slices: DistillSlice[] };

// A redo is one slice on pool slot 0, then a summary of that slot.
export async function redoSlice(input: DistillInput, sectionId: string): Promise<RedoResult> {
  beginSession();
  if (input.pdfBytes.byteLength === 0) {
    input = { ...input, pdfBytes: new Uint8Array(await readFile(input.pdfPath)) };
  }
  const target = input.slices.find((slice) => slice.id === sectionId);
  if (!target) {
    return { status: 'kept' };
  }
  const slot = 0;
  const read = await readSlice(input.pdfBytes, target.pageStart, target.pageEnd);
  const workspace = await prepareWorkspace(slot, target.id, read.text, target.pageStart, target.pageEnd);
  try {
    const outcome = await askAgent(input, slot, target, read, workspace.dir, () => undefined);
    if (!('board' in outcome)) {
      return {
        status: 'kept',
        failure: outcome.failure,
        ...(outcome.detail ? { failureDetail: outcome.detail } : {}),
      };
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
    await workspace.release();
    await settleSlice(slot);
  }
}
