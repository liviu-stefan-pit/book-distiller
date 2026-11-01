import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelParameterValue } from '../modelSelection';
import { setComposedPdf } from './bookManifest';
import {
  agentConcurrency,
  beginSession,
  cancelWasRequested,
  sendOnSlot,
  summarizeSlot,
  type RunResultLike,
} from './heldAgent';
import { typesetBook } from './typesetBook';

export type ChapterCode = { language: string; source: string };

export type ChapterFigure = { caption: string; page: number; file: string };

export type ChapterBlock =
  | { type: 'prose'; text: string }
  | { type: 'code'; language: string; source: string; caption?: string }
  | ({ type: 'figure' } & ChapterFigure)
  | {
      type: 'callout';
      kind: 'added' | 'current-practice' | 'added-example';
      title: string;
      text: string;
      code?: ChapterCode;
    };

export type Chapter = {
  schemaVersion: 1;
  sectionId: string;
  title: string;
  pageStart: number;
  pageEnd: number;
  boardHash: string;
  blocks: ChapterBlock[];
};

export type ComposeSectionState = 'queued' | 'reviewing' | 'done' | 'failed';

export type ComposeSection = {
  id: string;
  title: string;
  pageStart: number;
  pageEnd: number;
  state: ComposeSectionState;
};

export type ComposeProgress = {
  phase: 'reviewing' | 'typesetting' | 'done' | 'cancelled' | 'failed';
  pagesDone: number;
  pagesTotal: number;
  activeTitles: string[];
  failedTitles: string[];
  sections: ComposeSection[];
};

export type ComposeInput = {
  folderPath: string;
  modelId: string;
  modelParams: ModelParameterValue[];
};

type BoardCode = ChapterCode;

type Target = {
  id: string;
  title: string;
  pageStart: number;
  pageEnd: number;
  boardHash: string;
  boardText: string;
  code: BoardCode[];
  figures: ChapterFigure[];
};

type Failure = 'shape' | 'network' | 'cancelled';

type Rejection = { failure: Failure; detail?: string };

type Outcome = { chapter: Chapter } | Rejection;

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

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function pageSpan(target: Pick<Target, 'pageStart' | 'pageEnd'>): number {
  return target.pageEnd - target.pageStart + 1;
}

function readChapterCode(value: unknown): ChapterCode | undefined {
  if (!isRecord(value) || typeof value.language !== 'string' || typeof value.source !== 'string') {
    return undefined;
  }
  return { language: value.language, source: value.source };
}

function readChapterFigure(value: unknown): ChapterFigure | undefined {
  if (
    !isRecord(value) ||
    typeof value.caption !== 'string' ||
    typeof value.page !== 'number' ||
    !Number.isInteger(value.page) ||
    typeof value.file !== 'string'
  ) {
    return undefined;
  }
  return { caption: value.caption, page: value.page, file: value.file };
}

function readBlock(value: unknown): ChapterBlock | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return undefined;
  }
  if (value.type === 'prose') {
    return typeof value.text === 'string' ? { type: 'prose', text: value.text } : undefined;
  }
  if (value.type === 'code') {
    if (typeof value.language !== 'string' || typeof value.source !== 'string') {
      return undefined;
    }
    const block: ChapterBlock = { type: 'code', language: value.language, source: value.source };
    if (value.caption !== undefined) {
      if (typeof value.caption !== 'string') {
        return undefined;
      }
      block.caption = value.caption;
    }
    return block;
  }
  if (value.type === 'figure') {
    const figure = readChapterFigure(value);
    return figure ? { type: 'figure', ...figure } : undefined;
  }
  if (value.type !== 'callout') {
    return undefined;
  }
  if (
    (value.kind !== 'added' && value.kind !== 'current-practice' && value.kind !== 'added-example') ||
    typeof value.title !== 'string' ||
    typeof value.text !== 'string'
  ) {
    return undefined;
  }
  const block: ChapterBlock = {
    type: 'callout',
    kind: value.kind,
    title: value.title,
    text: value.text,
  };
  if (value.code !== undefined) {
    const code = readChapterCode(value.code);
    if (!code) {
      return undefined;
    }
    block.code = code;
  }
  return block;
}

function readBlocks(value: unknown): ChapterBlock[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const blocks: ChapterBlock[] = [];
  for (const item of value) {
    const block = readBlock(item);
    if (!block) {
      return undefined;
    }
    blocks.push(block);
  }
  return blocks;
}

type JudgedBlock =
  | { status: 'block'; block: ChapterBlock }
  | { status: 'prose' | 'code' | 'callout' | 'figure' | 'shape' };

function readJudgedBlock(value: unknown): JudgedBlock {
  if (
    !isRecord(value) ||
    (value.type !== 'prose' && value.type !== 'code' && value.type !== 'callout' && value.type !== 'figure')
  ) {
    return { status: 'shape' };
  }
  const block = readBlock(value);
  if (block) {
    return { status: 'block', block };
  }
  return { status: value.type };
}

function readStoredChapter(value: unknown): Chapter | undefined {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.sectionId !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.pageStart !== 'number' ||
    typeof value.pageEnd !== 'number' ||
    typeof value.boardHash !== 'string'
  ) {
    return undefined;
  }
  const blocks = readBlocks(value.blocks);
  if (!blocks) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    sectionId: value.sectionId,
    title: value.title,
    pageStart: value.pageStart,
    pageEnd: value.pageEnd,
    boardHash: value.boardHash,
    blocks,
  };
}

function chapterSources(blocks: ChapterBlock[]): Set<string> {
  const sources = new Set<string>();
  for (const block of blocks) {
    if (block.type === 'code') {
      sources.add(block.source);
    } else if (block.type === 'callout' && block.code) {
      sources.add(block.code.source);
    }
  }
  return sources;
}

function keepBoardCode(blocks: ChapterBlock[], code: BoardCode[]): ChapterBlock[] {
  const kept = [...blocks];
  const sources = chapterSources(kept);
  for (const item of code) {
    if (sources.has(item.source)) {
      continue;
    }
    kept.push({ type: 'code', language: item.language, source: item.source });
    sources.add(item.source);
  }
  return kept;
}

function keepBoardFigures(blocks: ChapterBlock[], figures: ChapterFigure[]): ChapterBlock[] {
  const kept = [...blocks];
  const files = new Set(kept.flatMap((block) => (block.type === 'figure' ? [block.file] : [])));
  for (const figure of figures) {
    if (files.has(figure.file)) {
      continue;
    }
    kept.push({ type: 'figure', caption: figure.caption, page: figure.page, file: figure.file });
    files.add(figure.file);
  }
  return kept;
}

function readStoredSlice(
  value: unknown,
): { id: string; title: string; pageStart: number; pageEnd: number; status: string } | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.pageStart !== 'number' ||
    typeof value.pageEnd !== 'number'
  ) {
    return undefined;
  }
  return {
    id: value.id,
    title: value.title,
    pageStart: value.pageStart,
    pageEnd: value.pageEnd,
    status: typeof value.status === 'string' ? value.status : 'queued',
  };
}

function readBoardPayload(
  value: unknown,
): { points: unknown[]; code: BoardCode[]; figures: ChapterFigure[] } | undefined {
  if (!isRecord(value) || !Array.isArray(value.points)) {
    return undefined;
  }
  if (value.code !== undefined && !Array.isArray(value.code)) {
    return undefined;
  }
  const code: BoardCode[] = [];
  for (const item of Array.isArray(value.code) ? value.code : []) {
    if (isRecord(item) && typeof item.language === 'string' && typeof item.source === 'string') {
      code.push({ language: item.language, source: item.source });
    }
  }
  const figures: ChapterFigure[] = [];
  for (const item of Array.isArray(value.figures) ? value.figures : []) {
    const figure = readChapterFigure(item);
    if (figure) {
      figures.push(figure);
    }
  }
  return { points: value.points, code, figures };
}

async function loadBoard(
  folderPath: string,
  sectionId: string,
): Promise<
  { bytes: Buffer; text: string; code: BoardCode[]; figures: ChapterFigure[]; empty: boolean } | undefined
> {
  try {
    const bytes = await readFile(join(folderPath, 'boards', `${sectionId}.board.json`));
    const text = bytes.toString('utf8');
    const payload = readBoardPayload(JSON.parse(text) as unknown);
    if (!payload) {
      return undefined;
    }
    return {
      bytes,
      text,
      code: payload.code,
      figures: payload.figures,
      empty: payload.points.length === 0 && payload.code.length === 0 && payload.figures.length === 0,
    };
  } catch {
    return undefined;
  }
}

async function loadBook(folderPath: string): Promise<{ title: string; targets: Target[] }> {
  let text: string;
  try {
    text = await readFile(join(folderPath, 'book-manifest.json'), 'utf8');
  } catch {
    return { title: '', targets: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { title: '', targets: [] };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.slices)) {
    return { title: '', targets: [] };
  }
  const targets: Target[] = [];
  for (const item of parsed.slices) {
    const slice = readStoredSlice(item);
    if (!slice || slice.status !== 'done') {
      continue;
    }
    const board = await loadBoard(folderPath, slice.id);
    if (!board || board.empty) {
      continue;
    }
    targets.push({
      id: slice.id,
      title: slice.title,
      pageStart: slice.pageStart,
      pageEnd: slice.pageEnd,
      boardHash: sha256Hex(board.bytes),
      boardText: board.text,
      code: board.code,
      figures: board.figures,
    });
  }
  return {
    title: typeof parsed.title === 'string' ? parsed.title : '',
    targets,
  };
}

async function loadMatchingChapter(
  folderPath: string,
  sectionId: string,
  boardHash: string,
): Promise<Chapter | undefined> {
  try {
    const text = await readFile(join(folderPath, 'composed', `${sectionId}.chapter.json`), 'utf8');
    const chapter = readStoredChapter(JSON.parse(text) as unknown);
    if (!chapter || chapter.boardHash !== boardHash) {
      return undefined;
    }
    return chapter;
  } catch {
    return undefined;
  }
}

async function writeChapter(folderPath: string, chapter: Chapter): Promise<void> {
  await mkdir(join(folderPath, 'composed'), { recursive: true });
  await writeFile(
    join(folderPath, 'composed', `${chapter.sectionId}.chapter.json`),
    `${JSON.stringify(chapter, null, 2)}\n`,
    'utf8',
  );
}

const standsAlone =
  'This section stands alone. Ignore any earlier section or reply in this conversation, and use only the board and rules below. Reply with only the chapter JSON. Files or images in the workspace are not a source.';

function reviewPrompt(target: Target, previous: Rejection | undefined): string {
  const skeleton = JSON.stringify(
    {
      schemaVersion: 1,
      sectionId: target.id,
      title: target.title,
      pageStart: target.pageStart,
      pageEnd: target.pageEnd,
      boardHash: target.boardHash,
      blocks: [],
    },
    null,
    2,
  );
  const specimen = JSON.stringify(
    {
      blocks: [
        { type: 'prose', text: 'placeholder text' },
        { type: 'code', language: 'placeholder language', source: 'placeholder source' },
        {
          type: 'callout',
          kind: 'added',
          title: 'placeholder title',
          text: 'placeholder text',
          code: { language: 'placeholder language', source: 'placeholder source' },
        },
      ],
    },
    null,
    2,
  );
  const rules = [
    'Rewrite the board into continuous chapter prose. Keep every rule, number, warning, and mechanism.',
    'Copy each board code listing into a code block with the source spelling unchanged.',
    'Keep each board figure as a figure block with the same caption, page, and file. Do not invent a figure.',
    'Additions are only callout blocks: added (important gap), current-practice (a better technique used now), added-example (an extra example). Never blend an addition into prose as if the original book said it.',
    'Omit an addition the reviewer cannot state confidently. Do not invent a citation.',
    'Reply with only the chapter JSON. schemaVersion is 1. Text only. No images.',
    'blocks is a non-empty array of prose, code, callout, and figure objects.',
    'A prose block has text. A code block has language and source. A callout has type callout, kind added, current-practice, or added-example, plus title and text. Optional callout code is an object with language and source. A figure block has type figure, caption, page, and file.',
  ].join('\n');
  const prompt =
    `${standsAlone}\n\n${rules}\n\nFill in this JSON skeleton:\n\`\`\`json\n${skeleton}\n\`\`\`\n\n` +
    `Field shape, not content to copy:\n\`\`\`json\n${specimen}\n\`\`\`\n\n` +
    `Board:\n\`\`\`json\n${target.boardText}\n\`\`\``;
  if (!previous) {
    return prompt;
  }
  return `${prompt}\n\nThe previous reply was rejected: ${previous.detail ?? previous.failure}. Reply with only the chapter JSON.`;
}

const proseDetail = 'a prose block needs text';
const codeDetail = 'a code block needs language and source';
const calloutDetail = 'a callout needs kind, title, and text';

function judgeBlocks(items: unknown[], attempt: number): ChapterBlock[] | string {
  if (items.length === 0) {
    return 'empty blocks';
  }
  const blocks: ChapterBlock[] = [];
  let omittedCallout = false;
  for (const item of items) {
    const read = readJudgedBlock(item);
    if (read.status === 'block') {
      blocks.push(read.block);
      continue;
    }
    if (read.status === 'callout') {
      omittedCallout = true;
      continue;
    }
    if (read.status === 'figure') {
      // The board's figures are reattached after review, so a malformed one is only dropped.
      continue;
    }
    if (read.status === 'prose') {
      return proseDetail;
    }
    if (read.status === 'code') {
      return codeDetail;
    }
    return 'invalid block';
  }
  if (!omittedCallout) {
    return blocks;
  }
  const hasBody = blocks.some((block) => block.type === 'prose' || block.type === 'code');
  if (attempt === 2 && hasBody) {
    return blocks;
  }
  return calloutDetail;
}

function judgeReply(reply: RunResultLike, target: Target, attempt: number): Outcome {
  const text = typeof reply.result === 'string' ? reply.result : '';
  if (reply.status === 'error') {
    return { failure: 'network', detail: reply.error?.message ?? 'agent run failed' };
  }
  if (reply.status === 'cancelled') {
    return { failure: 'cancelled' };
  }
  if (isNetworkReply(text)) {
    return { failure: 'network' };
  }
  const parsed = firstJsonObject(text);
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.blocks)) {
    return { failure: 'shape', detail: 'no chapter json' };
  }
  const judged = judgeBlocks(parsed.blocks, attempt);
  if (typeof judged === 'string') {
    return { failure: 'shape', detail: judged };
  }
  return {
    chapter: {
      schemaVersion: 1,
      sectionId: target.id,
      title: target.title,
      pageStart: target.pageStart,
      pageEnd: target.pageEnd,
      boardHash: target.boardHash,
      blocks: keepBoardFigures(keepBoardCode(judged, target.code), target.figures),
    },
  };
}

// The vault module imports Electron's app, which the in-process stand-in tests cannot load.
async function readApiKey(): Promise<string> {
  if (process.env.BOOK_DISTILLER_STANDIN_AGENT) {
    return 'stand-in';
  }
  const { readCursorKey } = await import('./cursorKey');
  return readCursorKey();
}

async function askAgent(
  input: ComposeInput,
  slot: number,
  target: Target,
  beforeSecondAttempt: () => void,
): Promise<Outcome> {
  const ask = async (attempt: number, previous: Rejection | undefined): Promise<Outcome> => {
    try {
      const result = await sendOnSlot(slot, await readApiKey(), input.modelId, input.modelParams, {
        text: reviewPrompt(target, previous),
      });
      if (cancelWasRequested()) {
        return { failure: 'cancelled' };
      }
      return judgeReply(result, target, attempt);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { failure: 'network', detail };
    }
  };
  let outcome = await ask(1, undefined);
  if (!('chapter' in outcome) && outcome.failure !== 'cancelled') {
    beforeSecondAttempt();
    outcome = await ask(2, outcome);
  }
  return outcome;
}

async function settleSection(slot: number): Promise<boolean> {
  if (process.env.BOOK_DISTILLER_AGENT_FILE || cancelWasRequested()) {
    return false;
  }
  return summarizeSlot(slot);
}

export async function composeBook(
  input: ComposeInput,
  onProgress: (progress: ComposeProgress) => void,
): Promise<ComposeProgress> {
  beginSession();
  const { title, targets } = await loadBook(input.folderPath);
  const pagesTotal = targets.reduce((sum, target) => sum + pageSpan(target), 0);
  const active: Array<{ id: string; title: string }> = [];
  const failedTitles: string[] = [];
  const failedIds = new Set<string>();
  let pagesDone = 0;
  let usableThisRun = 0;
  // A section is finished once its chapter was accepted this run or skipped on a matching hash.
  const finishedIds = new Set<string>();

  const sectionState = (target: Target): ComposeSectionState => {
    if (failedIds.has(target.id)) {
      return 'failed';
    }
    if (active.some((item) => item.id === target.id)) {
      return 'reviewing';
    }
    return finishedIds.has(target.id) ? 'done' : 'queued';
  };

  const emit = (phase: ComposeProgress['phase'] = 'reviewing'): ComposeProgress => {
    const activeTitles = active.map((item) => item.title);
    const progress: ComposeProgress = {
      phase,
      pagesDone,
      pagesTotal,
      activeTitles,
      failedTitles: [...failedTitles],
      sections: targets.map((target) => ({
        id: target.id,
        title: target.title,
        pageStart: target.pageStart,
        pageEnd: target.pageEnd,
        state: sectionState(target),
      })),
    };
    onProgress(progress);
    return progress;
  };

  let cursor = 0;
  const claim = (): Target | undefined => {
    while (cursor < targets.length) {
      const next = targets[cursor];
      cursor += 1;
      if (next) {
        return next;
      }
    }
    return undefined;
  };

  const runWorker = async (slot: number): Promise<void> => {
    for (;;) {
      if (cancelWasRequested()) {
        return;
      }
      const target = claim();
      if (!target) {
        return;
      }
      const existing = await loadMatchingChapter(input.folderPath, target.id, target.boardHash);
      if (existing) {
        usableThisRun += 1;
        pagesDone += pageSpan(target);
        finishedIds.add(target.id);
        emit();
        continue;
      }
      active.push({ id: target.id, title: target.title });
      emit();
      let stop = false;
      try {
        const outcome = await askAgent(input, slot, target, () => {
          emit();
        });
        const index = active.findIndex((item) => item.id === target.id);
        if (index !== -1) {
          active.splice(index, 1);
        }
        if (!('chapter' in outcome)) {
          if (outcome.failure !== 'cancelled') {
            failedIds.add(target.id);
            failedTitles.push(target.title);
          }
          emit();
          stop = outcome.failure === 'cancelled';
        } else {
          await writeChapter(input.folderPath, outcome.chapter);
          usableThisRun += 1;
          pagesDone += pageSpan(target);
          finishedIds.add(target.id);
          emit();
        }
      } finally {
        if (await settleSection(slot)) {
          stop = true;
        }
      }
      if (stop) {
        return;
      }
    }
  };

  const workers = Math.min(agentConcurrency(), targets.length);
  const settled = await Promise.allSettled(Array.from({ length: workers }, (_unused, slot) => runWorker(slot)));
  for (const item of settled) {
    if (item.status === 'rejected') {
      throw item.reason;
    }
  }
  if (cancelWasRequested()) {
    return emit('cancelled');
  }
  if (usableThisRun === 0) {
    return emit('done');
  }
  active.splice(0, active.length);
  emit('typesetting');
  const chapters: Chapter[] = [];
  for (const target of targets) {
    const chapter = await loadMatchingChapter(input.folderPath, target.id, target.boardHash);
    if (chapter) {
      chapters.push(chapter);
    }
  }
  const dest = join(input.folderPath, 'composed.pdf');
  let existed = false;
  try {
    await access(dest);
    existed = true;
  } catch {
    existed = false;
  }
  try {
    const pdf = typesetBook(title, chapters, input.folderPath);
    if (pdf.subarray(0, 4).toString('utf8') !== '%PDF') {
      throw new Error('typeset did not produce a PDF');
    }
    await writeFile(dest, pdf);
    const manifestPath = join(input.folderPath, 'book-manifest.json');
    await writeFile(manifestPath, setComposedPdf(await readFile(manifestPath, 'utf8')), 'utf8');
    return emit('done');
  } catch {
    if (!existed) {
      await rm(dest, { force: true });
    }
    return emit('failed');
  }
}
