import { expect, test } from '@playwright/test';
import { createCanvas } from '@napi-rs/canvas';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { composeBook, type Chapter, type ComposeProgress } from '../src/main/compose';
import { disposeAgent, requestCancel } from '../src/main/heldAgent';
import { resetStandInAgent } from '../src/main/standInAgent';

type AgentEvent = { event: string };

type SliceSpec = {
  id: string;
  title: string;
  pageStart: number;
  pageEnd: number;
  status: 'queued' | 'writing' | 'done' | 'failed';
  board: unknown;
};

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function emptyBoard(): unknown {
  return {
    schemaVersion: 1,
    sectionId: 'preface',
    sectionTitle: 'Preface',
    pageStart: 1,
    pageEnd: 1,
    points: [],
    code: [],
  };
}

function ruleBoard(): unknown {
  return {
    schemaVersion: 1,
    sectionId: 'a-numbered-rule',
    sectionTitle: 'A numbered rule',
    pageStart: 2,
    pageEnd: 3,
    points: [
      {
        kind: 'must-remember',
        title: 'Flush the log before memory',
        explanation: 'A write is durable only after the log is on disk.',
        page: 2,
      },
    ],
    code: [
      {
        title: 'Flush',
        language: 'csharp',
        page: 2,
        source: 'log.Flush();',
        notes: [],
      },
    ],
  };
}

function listingBoard(): unknown {
  return {
    schemaVersion: 1,
    sectionId: 'a-listing',
    sectionTitle: 'A listing',
    pageStart: 4,
    pageEnd: 4,
    points: [
      {
        kind: 'mechanics',
        title: 'Copy the listing',
        explanation: 'The listing keeps its spelling.',
        page: 4,
      },
    ],
    code: [
      {
        title: 'Listing',
        language: 'csharp',
        page: 4,
        source: 'return value;',
        notes: [],
      },
    ],
  };
}

function validChapter(sectionId: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    sectionId,
    title: 'model title',
    pageStart: 99,
    pageEnd: 99,
    boardHash: 'model-hash',
    blocks: [{ type: 'prose', text: 'A write is durable only after the log is on disk.' }],
  });
}

function titledBoard(id: string, title: string, pageStart: number, pageEnd: number): unknown {
  return {
    schemaVersion: 1,
    sectionId: id,
    sectionTitle: title,
    pageStart,
    pageEnd,
    points: [
      {
        kind: 'must-remember',
        title: 'Fake the collaborator',
        explanation: 'A fake stands in for a slow collaborator.',
        page: pageStart,
      },
    ],
    code: [],
  };
}

function chapterWithCallout(): string {
  return JSON.stringify({
    schemaVersion: 1,
    blocks: [
      { type: 'prose', text: 'A write is durable only after the log is on disk.' },
      { type: 'code', language: 'csharp', source: 'log.Flush();' },
      {
        type: 'callout',
        kind: 'current-practice',
        title: 'Flush still matters',
        text: 'Durable writes still flush the log.',
      },
    ],
  });
}

function chapterWithVariantCallout(): string {
  return JSON.stringify({
    schemaVersion: 1,
    blocks: [
      { type: 'prose', text: 'A write is durable only after the log is on disk.' },
      { type: 'code', language: 'csharp', source: 'log.Flush();' },
      { type: 'callout', variant: 'current-practice', text: 'Prefer a newer flush.' },
    ],
  });
}

function proseMissingText(): string {
  return JSON.stringify({
    schemaVersion: 1,
    blocks: [{ type: 'prose' }, { type: 'code', language: 'csharp', source: 'log.Flush();' }],
  });
}

async function events(file: string): Promise<AgentEvent[]> {
  try {
    const text = await readFile(file, 'utf8');
    return text
      .trim()
      .split(/\n/)
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as AgentEvent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function names(list: AgentEvent[]): string[] {
  return list.map((item) => item.event);
}

function count(list: AgentEvent[], event: string): number {
  return list.filter((item) => item.event === event).length;
}

async function writeBook(
  dir: string,
  slices: SliceSpec[],
): Promise<{ folder: string; hashes: Record<string, string> }> {
  const folder = path.join(dir, 'book');
  await mkdir(path.join(folder, 'boards'), { recursive: true });
  const hashes: Record<string, string> = {};
  for (const slice of slices) {
    const body = `${JSON.stringify(slice.board, null, 2)}\n`;
    const boardPath = path.join(folder, 'boards', `${slice.id}.board.json`);
    await writeFile(boardPath, body, 'utf8');
    hashes[slice.id] = sha256(Buffer.from(body, 'utf8'));
  }
  await writeFile(
    path.join(folder, 'book-manifest.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        pdfPath: path.join(folder, 'missing.pdf'),
        title: 'Compose Booklet',
        slices: slices.map((slice) => ({
          id: slice.id,
          title: slice.title,
          pageStart: slice.pageStart,
          pageEnd: slice.pageEnd,
          checked: true,
          status: slice.status,
        })),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return { folder, hashes };
}

async function withCompose<T>(
  dir: string,
  script: unknown,
  body: (log: string) => Promise<T>,
): Promise<T> {
  resetStandInAgent();
  const standIn = path.join(dir, 'stand-in.json');
  const log = path.join(dir, 'agent-events.log');
  const previous = {
    standIn: process.env.BOOK_DISTILLER_STANDIN_AGENT,
    events: process.env.BOOK_DISTILLER_AGENT_EVENTS,
    concurrency: process.env.BOOK_DISTILLER_AGENT_CONCURRENCY,
    workRoot: process.env.BOOK_DISTILLER_WORK_ROOT,
  };
  await writeFile(standIn, JSON.stringify(script), 'utf8');
  process.env.BOOK_DISTILLER_STANDIN_AGENT = standIn;
  process.env.BOOK_DISTILLER_AGENT_EVENTS = log;
  process.env.BOOK_DISTILLER_AGENT_CONCURRENCY = '1';
  process.env.BOOK_DISTILLER_WORK_ROOT = path.join(dir, 'work');
  try {
    return await body(log);
  } finally {
    await disposeAgent('quit');
    const restore = (name: string, value: string | undefined): void => {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    };
    restore('BOOK_DISTILLER_STANDIN_AGENT', previous.standIn);
    restore('BOOK_DISTILLER_AGENT_EVENTS', previous.events);
    restore('BOOK_DISTILLER_AGENT_CONCURRENCY', previous.concurrency);
    restore('BOOK_DISTILLER_WORK_ROOT', previous.workRoot);
  }
}

test('an empty board produces no chapter and no send', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-compose-'));
  try {
    const { folder } = await writeBook(dir, [
      {
        id: 'preface',
        title: 'Preface',
        pageStart: 1,
        pageEnd: 1,
        status: 'done',
        board: emptyBoard(),
      },
    ]);
    const result = await withCompose(dir, { replies: [validChapter('preface')] }, async (log) => {
      const progress = await composeBook(
        { folderPath: folder, modelId: 'north-model', modelParams: [] },
        () => undefined,
      );
      return { progress, log };
    });
    expect(result.progress).toEqual({
      phase: 'done',
      pagesDone: 0,
      pagesTotal: 0,
      activeTitles: [],
      failedTitles: [],
      sections: [],
    });
    await expect(access(path.join(folder, 'composed', 'preface.chapter.json'))).rejects.toThrow();
    await expect(access(path.join(folder, 'composed.pdf'))).rejects.toThrow();
    expect(names(await events(result.log))).not.toContain('send');
    expect(names(await events(result.log))).not.toContain('create');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a valid stand-in reply writes the chapter and page counts', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-compose-'));
  try {
    const { folder, hashes } = await writeBook(dir, [
      {
        id: 'a-numbered-rule',
        title: 'A numbered rule',
        pageStart: 2,
        pageEnd: 3,
        status: 'done',
        board: ruleBoard(),
      },
      {
        id: 'queued-later',
        title: 'Queued later',
        pageStart: 10,
        pageEnd: 12,
        status: 'queued',
        board: listingBoard(),
      },
    ]);
    const seen: ComposeProgress[] = [];
    const result = await withCompose(
      dir,
      { sectionReplies: { 'a-numbered-rule': validChapter('a-numbered-rule') } },
      async () =>
        composeBook({ folderPath: folder, modelId: 'north-model', modelParams: [] }, (progress) => {
          seen.push({
            ...progress,
            activeTitles: [...progress.activeTitles],
            failedTitles: [...progress.failedTitles],
          });
        }),
    );
    expect(result.phase).toBe('done');
    expect(result.pagesDone).toBe(2);
    expect(result.pagesTotal).toBe(2);
    expect(result.failedTitles).toEqual([]);
    const chapter = JSON.parse(
      await readFile(path.join(folder, 'composed', 'a-numbered-rule.chapter.json'), 'utf8'),
    ) as Chapter;
    expect(chapter.schemaVersion).toBe(1);
    expect(chapter.sectionId).toBe('a-numbered-rule');
    expect(chapter.title).toBe('A numbered rule');
    expect(chapter.pageStart).toBe(2);
    expect(chapter.pageEnd).toBe(3);
    expect(chapter.boardHash).toBe(hashes['a-numbered-rule']);
    expect(chapter.blocks.some((block) => block.type === 'prose')).toBe(true);
    expect(
      chapter.blocks.some((block) => block.type === 'code' && block.source === 'log.Flush();'),
    ).toBe(true);
    expect(seen.some((item) => item.pagesDone === 2 && item.pagesTotal === 2)).toBe(true);
    expect(
      seen.some(
        (item) =>
          item.phase === 'typesetting' &&
          item.pagesDone === 2 &&
          item.pagesTotal === 2 &&
          item.activeTitles.length === 0,
      ),
    ).toBe(true);
    const composedPdf = await readFile(path.join(folder, 'composed.pdf'));
    expect(composedPdf.subarray(0, 4).toString('utf8')).toBe('%PDF');
    expect(await readFile(path.join(folder, 'book-manifest.json'), 'utf8')).toContain(
      '"composedPdf": "composed.pdf"',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a second compose on an unchanged board does not send again', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-compose-'));
  try {
    const { folder } = await writeBook(dir, [
      {
        id: 'a-numbered-rule',
        title: 'A numbered rule',
        pageStart: 2,
        pageEnd: 3,
        status: 'done',
        board: ruleBoard(),
      },
    ]);
    await withCompose(
      dir,
      { sectionReplies: { 'a-numbered-rule': validChapter('a-numbered-rule') } },
      async (log) => {
        const input = { folderPath: folder, modelId: 'north-model', modelParams: [] };
        await composeBook(input, () => undefined);
        const afterFirst = await events(log);
        expect(count(afterFirst, 'create')).toBeGreaterThan(0);
        expect(count(afterFirst, 'send')).toBeGreaterThan(0);
        const second = await composeBook(input, () => undefined);
        expect(second.phase).toBe('done');
        expect(second.pagesDone).toBe(2);
        const afterSecond = await events(log);
        expect(count(afterSecond, 'create')).toBe(count(afterFirst, 'create'));
        expect(count(afterSecond, 'send')).toBe(count(afterFirst, 'send'));
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a shape-invalid reply is sent once more then fails without a chapter', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-compose-'));
  try {
    const { folder } = await writeBook(dir, [
      {
        id: 'a-numbered-rule',
        title: 'A numbered rule',
        pageStart: 2,
        pageEnd: 3,
        status: 'done',
        board: ruleBoard(),
      },
    ]);
    const result = await withCompose(
      dir,
      { sectionReplies: { 'a-numbered-rule': '#set page(width: 6in)\n= Not a chapter\n' } },
      async (log) => {
        const progress = await composeBook(
          { folderPath: folder, modelId: 'north-model', modelParams: [] },
          () => undefined,
        );
        return { progress, log };
      },
    );
    expect(result.progress.phase).toBe('done');
    expect(result.progress.pagesDone).toBe(0);
    expect(result.progress.failedTitles).toEqual(['A numbered rule']);
    await expect(access(path.join(folder, 'composed', 'a-numbered-rule.chapter.json'))).rejects.toThrow();
    await expect(access(path.join(folder, 'composed.pdf'))).rejects.toThrow();
    expect(count(await events(result.log), 'send')).toBe(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cancel leaves a written chapter and resolves cancelled', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-compose-'));
  try {
    const { folder } = await writeBook(dir, [
      {
        id: 'a-numbered-rule',
        title: 'A numbered rule',
        pageStart: 2,
        pageEnd: 3,
        status: 'done',
        board: ruleBoard(),
      },
      {
        id: 'a-listing',
        title: 'A listing',
        pageStart: 4,
        pageEnd: 4,
        status: 'done',
        board: listingBoard(),
      },
    ]);
    const firstChapter = path.join(folder, 'composed', 'a-numbered-rule.chapter.json');
    const result = await withCompose(
      dir,
      {
        sectionReplies: {
          'a-numbered-rule': validChapter('a-numbered-rule'),
          'a-listing': validChapter('a-listing'),
        },
        hangSends: [1],
      },
      async () => {
        const running = composeBook(
          { folderPath: folder, modelId: 'north-model', modelParams: [] },
          () => undefined,
        );
        await expect
          .poll(async () => {
            try {
              await readFile(firstChapter, 'utf8');
              return true;
            } catch {
              return false;
            }
          })
          .toBe(true);
        await requestCancel();
        return running;
      },
    );
    expect(result.phase).toBe('cancelled');
    await readFile(firstChapter, 'utf8');
    await expect(access(path.join(folder, 'composed', 'a-listing.chapter.json'))).rejects.toThrow();
    await expect(access(path.join(folder, 'composed.pdf'))).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a sentence then a chapter with a callout is accepted on the retry', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-compose-'));
  try {
    const { folder } = await writeBook(dir, [
      {
        id: 'a-numbered-rule',
        title: 'A numbered rule',
        pageStart: 2,
        pageEnd: 3,
        status: 'done',
        board: ruleBoard(),
      },
    ]);
    const result = await withCompose(
      dir,
      {
        sectionReplies: {
          'a-numbered-rule': [
            'I will confirm that format before writing the JSON.',
            chapterWithCallout(),
          ],
        },
      },
      async (log) => {
        const progress = await composeBook(
          { folderPath: folder, modelId: 'north-model', modelParams: [] },
          () => undefined,
        );
        return { progress, log };
      },
    );
    expect(result.progress.phase).toBe('done');
    expect(count(await events(result.log), 'send')).toBe(2);
    const chapter = JSON.parse(
      await readFile(path.join(folder, 'composed', 'a-numbered-rule.chapter.json'), 'utf8'),
    ) as Chapter;
    expect(chapter.blocks).toContainEqual({
      type: 'callout',
      kind: 'current-practice',
      title: 'Flush still matters',
      text: 'Durable writes still flush the log.',
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a chapter with a variant callout is written on the retry without that callout', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-compose-'));
  try {
    const bad = chapterWithVariantCallout();
    const { folder } = await writeBook(dir, [
      {
        id: 'a-numbered-rule',
        title: 'A numbered rule',
        pageStart: 2,
        pageEnd: 3,
        status: 'done',
        board: ruleBoard(),
      },
    ]);
    const result = await withCompose(
      dir,
      { sectionReplies: { 'a-numbered-rule': [bad, bad] } },
      async (log) => {
        const progress = await composeBook(
          { folderPath: folder, modelId: 'north-model', modelParams: [] },
          () => undefined,
        );
        return { progress, log };
      },
    );
    expect(count(await events(result.log), 'send')).toBe(2);
    const chapter = JSON.parse(
      await readFile(path.join(folder, 'composed', 'a-numbered-rule.chapter.json'), 'utf8'),
    ) as Chapter;
    expect(chapter.blocks).toEqual([
      { type: 'prose', text: 'A write is durable only after the log is on disk.' },
      { type: 'code', language: 'csharp', source: 'log.Flush();' },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an invalid prose block on both attempts writes no chapter', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-compose-'));
  try {
    const { folder } = await writeBook(dir, [
      {
        id: 'a-numbered-rule',
        title: 'A numbered rule',
        pageStart: 2,
        pageEnd: 3,
        status: 'done',
        board: ruleBoard(),
      },
    ]);
    const result = await withCompose(
      dir,
      { sectionReplies: { 'a-numbered-rule': proseMissingText() } },
      async (log) => {
        const progress = await composeBook(
          { folderPath: folder, modelId: 'north-model', modelParams: [] },
          () => undefined,
        );
        return { progress, log };
      },
    );
    expect(result.progress.phase).toBe('done');
    expect(result.progress.pagesDone).toBe(0);
    expect(result.progress.failedTitles).toEqual(['A numbered rule']);
    await expect(access(path.join(folder, 'composed', 'a-numbered-rule.chapter.json'))).rejects.toThrow();
    expect(count(await events(result.log), 'send')).toBe(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a chapter that drops a board figure gets it back before the PDF is typeset', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-compose-'));
  try {
    const figure = { caption: 'Write path', page: 2, file: 'figures/a-numbered-rule-1.jpg' };
    const { folder } = await writeBook(dir, [
      {
        id: 'a-numbered-rule',
        title: 'A numbered rule',
        pageStart: 2,
        pageEnd: 3,
        status: 'done',
        board: { ...(ruleBoard() as Record<string, unknown>), figures: [figure] },
      },
    ]);
    const canvas = createCanvas(300, 200);
    const context = canvas.getContext('2d');
    context.fillStyle = '#336699';
    context.fillRect(0, 0, 300, 200);
    await mkdir(path.join(folder, 'figures'), { recursive: true });
    await writeFile(path.join(folder, figure.file), canvas.toBuffer('image/jpeg', 90));
    const result = await withCompose(
      dir,
      { sectionReplies: { 'a-numbered-rule': validChapter('a-numbered-rule') } },
      async () =>
        composeBook({ folderPath: folder, modelId: 'north-model', modelParams: [] }, () => undefined),
    );
    expect(result.phase).toBe('done');
    const chapter = JSON.parse(
      await readFile(path.join(folder, 'composed', 'a-numbered-rule.chapter.json'), 'utf8'),
    ) as Chapter;
    expect(chapter.blocks).toContainEqual({ type: 'figure', ...figure });
    expect(chapter.blocks.filter((block) => block.type === 'figure')).toHaveLength(1);
    const composedPdf = await readFile(path.join(folder, 'composed.pdf'));
    expect(composedPdf.subarray(0, 4).toString('utf8')).toBe('%PDF');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('two chunks with the same title do not share failed or reviewing', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-compose-'));
  try {
    const { folder } = await writeBook(dir, [
      {
        id: 'faking-collaborators',
        title: 'Faking Collaborators',
        pageStart: 44,
        pageEnd: 49,
        status: 'done',
        board: titledBoard('faking-collaborators', 'Faking Collaborators', 44, 49),
      },
      {
        id: 'faking-collaborators-50',
        title: 'Faking Collaborators',
        pageStart: 50,
        pageEnd: 51,
        status: 'done',
        board: titledBoard('faking-collaborators-50', 'Faking Collaborators', 50, 51),
      },
    ]);
    const seen: ComposeProgress[] = [];
    const result = await withCompose(
      dir,
      {
        sectionReplies: {
          'faking-collaborators': 'not chapter json',
          'faking-collaborators-50': validChapter('faking-collaborators-50'),
        },
      },
      async () =>
        composeBook({ folderPath: folder, modelId: 'north-model', modelParams: [] }, (progress) => {
          seen.push({
            ...progress,
            activeTitles: [...progress.activeTitles],
            failedTitles: [...progress.failedTitles],
            sections: progress.sections.map((section) => ({ ...section })),
          });
        }),
    );
    expect(result.failedTitles).toEqual(['Faking Collaborators']);
    expect(result.sections).toEqual([
      {
        id: 'faking-collaborators',
        title: 'Faking Collaborators',
        pageStart: 44,
        pageEnd: 49,
        state: 'failed',
      },
      {
        id: 'faking-collaborators-50',
        title: 'Faking Collaborators',
        pageStart: 50,
        pageEnd: 51,
        state: 'done',
      },
    ]);
    expect(
      seen.some((item) => {
        const first = item.sections.find((section) => section.id === 'faking-collaborators');
        const second = item.sections.find((section) => section.id === 'faking-collaborators-50');
        return first?.state === 'reviewing' && second?.state === 'reviewing';
      }),
    ).toBe(false);
    expect(
      seen.some((item) => {
        const first = item.sections.find((section) => section.id === 'faking-collaborators');
        const second = item.sections.find((section) => section.id === 'faking-collaborators-50');
        return first?.state === 'reviewing' && second?.state === 'queued';
      }),
    ).toBe(true);
    await readFile(path.join(folder, 'composed', 'faking-collaborators-50.chapter.json'), 'utf8');
    await expect(access(path.join(folder, 'composed', 'faking-collaborators.chapter.json'))).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
