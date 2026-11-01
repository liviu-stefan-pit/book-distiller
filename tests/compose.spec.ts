import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { numberedRuleBoard, openSettings, secret } from './boardLaunch';

const require = createRequire(import.meta.url);
const electronPath = require('electron') as string;
const booklet = path.resolve(process.cwd(), 'fixtures/booklet.pdf');

const chapterReply = JSON.stringify({
  schemaVersion: 1,
  blocks: [{ type: 'prose', text: 'Flush the log before changing memory.' }],
});

type SliceSpec = {
  id: string;
  title: string;
  pageStart: number;
  pageEnd: number;
  board: unknown;
};

function listingBoard(): unknown {
  return {
    schemaVersion: 1,
    sectionId: 'a-listing',
    sectionTitle: 'A listing',
    pageStart: 3,
    pageEnd: 4,
    points: [
      {
        kind: 'mechanics',
        title: 'Copy the listing',
        explanation: 'The listing keeps its spelling.',
        page: 3,
      },
    ],
    code: [],
  };
}

function ruleSlice(): SliceSpec {
  return {
    id: 'a-numbered-rule',
    title: 'A numbered rule',
    pageStart: 2,
    pageEnd: 2,
    board: numberedRuleBoard(),
  };
}

function listingSlice(): SliceSpec {
  return {
    id: 'a-listing',
    title: 'A listing',
    pageStart: 3,
    pageEnd: 4,
    board: listingBoard(),
  };
}

async function launch(
  dir: string,
  extraEnv: Record<string, string> = {},
): Promise<{ app: ElectronApplication; window: Page }> {
  const userData = path.join(dir, 'user-data');
  const catalogFile = path.join(dir, 'catalog.json');
  await mkdir(userData, { recursive: true });
  await writeFile(catalogFile, JSON.stringify({ models: ['north-model', 'south-model'] }));
  const app = await electron.launch({
    executablePath: electronPath,
    args: [path.join(process.cwd(), 'out/main/index.js')],
    env: {
      ...process.env,
      BOOK_DISTILLER_VAULT: 'memory',
      BOOK_DISTILLER_USER_DATA: userData,
      BOOK_DISTILLER_CATALOG_FILE: catalogFile,
      // Tests that script one reply order or watch one writing slice need a single worker.
      BOOK_DISTILLER_AGENT_CONCURRENCY: '1',
      ...extraEnv,
    },
  });
  const window = await app.firstWindow();
  return { app, window };
}

async function saveKey(window: Page): Promise<void> {
  await openSettings(window);
  await window.getByLabel('Cursor key').fill(secret);
  await openSettings(window);
  await window.getByRole('button', { name: 'Save' }).click();
  await openSettings(window);
  await window.getByRole('combobox', { name: 'Model' }).selectOption('north-model');
}

async function closeSettings(window: Page): Promise<void> {
  const dialog = window.getByRole('dialog', { name: 'Settings' });
  if (await dialog.isVisible()) {
    await window.getByRole('button', { name: 'Settings' }).click();
  }
  await expect(dialog).toHaveCount(0);
}

async function chooseDirectory(app: ElectronApplication, window: Page, folder: string, name: string): Promise<void> {
  await app.evaluate(({ dialog }, chosen: string) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] });
  }, folder);
  if (name === 'Choose a folder') {
    await openSettings(window);
  }
  await window.getByRole('button', { name }).click();
}

async function logText(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

function sendCount(text: string): number {
  return text
    .trim()
    .split(/\n/)
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { event?: string })
    .filter((item) => item.event === 'send').length;
}

async function writeBook(folder: string, slices: SliceSpec[]): Promise<void> {
  await mkdir(path.join(folder, 'boards'), { recursive: true });
  for (const slice of slices) {
    await writeFile(
      path.join(folder, 'boards', `${slice.id}.board.json`),
      `${JSON.stringify(slice.board, null, 2)}\n`,
    );
  }
  await writeFile(
    path.join(folder, 'book-manifest.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        pdfPath: booklet,
        title: 'Distiller Booklet',
        slices: slices.map((slice) => ({
          id: slice.id,
          title: slice.title,
          pageStart: slice.pageStart,
          pageEnd: slice.pageEnd,
          checked: true,
          status: 'done',
          modelId: 'north-model',
        })),
      },
      null,
      2,
    )}\n`,
  );
}

async function openReadyBook(
  app: ElectronApplication,
  window: Page,
  folder: string,
): Promise<void> {
  await saveKey(window);
  await closeSettings(window);
  await chooseDirectory(app, window, folder, 'Open book');
  await expect(window.getByRole('region', { name: 'Viewer' })).toBeVisible();
}

test('Compose is absent on the launchpad and writes the PDF the reader can open', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-compose-ui-'));
  const book = path.join(dir, 'saved-book');
  const standIn = path.join(dir, 'stand-in.json');
  const eventsLog = path.join(dir, 'agent-events.log');
  const openLog = path.join(dir, 'open-pdf.log');
  const composedPdf = path.join(book, 'composed.pdf');
  await writeBook(book, [ruleSlice()]);
  await writeFile(
    standIn,
    JSON.stringify({
      sectionReplies: { 'a-numbered-rule': chapterReply },
      usage: [1500],
    }),
  );
  const env = {
    BOOK_DISTILLER_STANDIN_AGENT: standIn,
    BOOK_DISTILLER_AGENT_EVENTS: eventsLog,
    BOOK_DISTILLER_WORK_ROOT: path.join(dir, 'work'),
    BOOK_DISTILLER_OPEN_LOG: openLog,
  };
  const first = await launch(dir, env);
  try {
    await expect(first.window.getByRole('button', { name: 'Compose' })).toHaveCount(0);
    await openReadyBook(first.app, first.window, book);
    await expect(first.window.getByRole('button', { name: 'Compose' })).toBeVisible();
    await first.window.getByRole('button', { name: 'Compose' }).click();
    const sheet = first.window.getByRole('dialog', { name: 'Compose' });
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('The book is ready.');
    await expect(sheet).toContainText('1 of 1 pages');
    await expect(sheet).toContainText('1,500 tokens');
    await expect(sheet.getByRole('listitem').filter({ hasText: 'A numbered rule' })).toContainText('Done');
    const pdf = await readFile(composedPdf);
    expect(pdf.subarray(0, 4).toString('utf8')).toBe('%PDF');
    expect(await readFile(path.join(book, 'book-manifest.json'), 'utf8')).toContain(
      '"composedPdf": "composed.pdf"',
    );
    const afterFirst = sendCount(await logText(eventsLog));
    expect(afterFirst).toBeGreaterThan(0);
    await sheet.getByRole('button', { name: 'Close' }).click();
    await expect(sheet).toHaveCount(0);
    await expect(first.window.getByRole('button', { name: 'Open PDF' })).toBeVisible();
    await first.window.getByRole('button', { name: 'Open PDF' }).click();
    await expect.poll(async () => logText(openLog)).toContain(composedPdf);
    await first.window.getByRole('button', { name: 'Compose' }).click();
    await expect(first.window.getByRole('dialog', { name: 'Compose' })).toContainText('The book is ready.');
    expect(sendCount(await logText(eventsLog))).toBe(afterFirst);
  } finally {
    await first.app.close();
  }
  const relaunchLog = path.join(dir, 'agent-events-relaunch.log');
  const second = await launch(dir, {
    ...env,
    BOOK_DISTILLER_AGENT_EVENTS: relaunchLog,
  });
  try {
    await chooseDirectory(second.app, second.window, book, 'Open book');
    await expect(second.window.getByRole('button', { name: 'Open PDF' })).toBeVisible();
    expect(sendCount(await logText(relaunchLog))).toBe(0);
  } finally {
    await second.app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a first reply that is not chapter JSON is retried then the book is ready', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-compose-ui-'));
  const book = path.join(dir, 'saved-book');
  const standIn = path.join(dir, 'stand-in.json');
  const eventsLog = path.join(dir, 'agent-events.log');
  await writeBook(book, [ruleSlice()]);
  await writeFile(standIn, JSON.stringify({ replies: ['not chapter json', chapterReply] }));
  const { app, window } = await launch(dir, {
    BOOK_DISTILLER_STANDIN_AGENT: standIn,
    BOOK_DISTILLER_AGENT_EVENTS: eventsLog,
    BOOK_DISTILLER_WORK_ROOT: path.join(dir, 'work'),
  });
  try {
    await openReadyBook(app, window, book);
    await window.getByRole('button', { name: 'Compose' }).click();
    const sheet = window.getByRole('dialog', { name: 'Compose' });
    await expect(sheet).toContainText('The book is ready.');
    expect(sendCount(await logText(eventsLog))).toBe(2);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Cancel keeps the first chapter and does not publish the PDF', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-compose-ui-'));
  const book = path.join(dir, 'saved-book');
  const standIn = path.join(dir, 'stand-in.json');
  const eventsLog = path.join(dir, 'agent-events.log');
  const firstChapter = path.join(book, 'composed', 'a-numbered-rule.chapter.json');
  const secondChapter = path.join(book, 'composed', 'a-listing.chapter.json');
  await writeBook(book, [ruleSlice(), listingSlice()]);
  await writeFile(
    standIn,
    JSON.stringify({
      sectionReplies: {
        'a-numbered-rule': chapterReply,
        'a-listing': chapterReply,
      },
      hangSends: [1],
    }),
  );
  const { app, window } = await launch(dir, {
    BOOK_DISTILLER_STANDIN_AGENT: standIn,
    BOOK_DISTILLER_AGENT_EVENTS: eventsLog,
    BOOK_DISTILLER_WORK_ROOT: path.join(dir, 'work'),
  });
  try {
    await openReadyBook(app, window, book);
    await window.getByRole('button', { name: 'Compose' }).click();
    const sheet = window.getByRole('dialog', { name: 'Compose' });
    await expect
      .poll(async () => {
        try {
          await readFile(firstChapter, 'utf8');
          return sendCount(await logText(eventsLog));
        } catch {
          return 0;
        }
      })
      .toBe(2);
    await sheet.getByRole('button', { name: 'Cancel' }).click();
    await expect(sheet).toContainText('Cancelled.');
    await readFile(firstChapter, 'utf8');
    await expect(access(secondChapter)).rejects.toThrow();
    await expect(access(path.join(book, 'composed.pdf'))).rejects.toThrow();
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
