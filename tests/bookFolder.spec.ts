import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { createWriteStream } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { numberedRuleBoard, openSettings, secret } from './boardLaunch';

const require = createRequire(import.meta.url);
const electronPath = require('electron') as string;
const booklet = path.resolve(process.cwd(), 'fixtures/booklet.pdf');

type PdfDoc = {
  font(name: string): PdfDoc;
  fontSize(size: number): PdfDoc;
  text(text: string, options?: { width: number }): PdfDoc;
  pipe(out: NodeJS.WritableStream): void;
  end(): void;
  on(event: 'error', listener: (error: Error) => void): void;
};

const PDFDocument = require('pdfkit') as new (options?: {
  margin?: number;
  info?: { Title?: string };
}) => PdfDoc;

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

async function chooseDirectory(app: ElectronApplication, window: Page, folder: string, name: string): Promise<void> {
  await app.evaluate(({ dialog }, chosen: string) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] });
  }, folder);
  if (name === 'Choose a folder') {
    await openSettings(window);
  }
  await window.getByRole('button', { name }).click();
}

async function logText(agentLog: string): Promise<string> {
  try {
    return await readFile(agentLog, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

function writePdf(filePath: string, title: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 72, info: { Title: title } });
    const out = createWriteStream(filePath);
    out.on('finish', () => resolve());
    out.on('error', reject);
    doc.on('error', reject);
    doc.pipe(out);
    doc.font('Times-Roman').fontSize(12).text('This page has enough letters to count as readable text.', { width: 468 });
    doc.end();
  });
}

function emptyBoard(): unknown {
  return {
    schemaVersion: 1,
    sectionId: 'pages-1-1',
    sectionTitle: 'Pages 1\u20131',
    pageStart: 1,
    pageEnd: 1,
    points: [],
    code: [],
  };
}

async function writePartialBook(folder: string): Promise<void> {
  await mkdir(path.join(folder, 'boards'), { recursive: true });
  await writeFile(
    path.join(folder, 'boards', 'a-numbered-rule.board.json'),
    `${JSON.stringify(numberedRuleBoard(), null, 2)}\n`,
  );
  await writeFile(
    path.join(folder, 'book-manifest.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        pdfPath: booklet,
        title: 'Distiller Booklet',
        slices: [
          {
            id: 'preface',
            title: 'Preface',
            pageStart: 1,
            pageEnd: 1,
            checked: true,
            status: 'failed',
            failureReason: 'shape',
          },
          {
            id: 'a-numbered-rule',
            title: 'A numbered rule',
            pageStart: 2,
            pageEnd: 2,
            checked: true,
            status: 'done',
            modelId: 'north-model',
          },
          {
            id: 'a-listing',
            title: 'A listing',
            pageStart: 3,
            pageEnd: 4,
            checked: true,
            status: 'writing',
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

test('a non-empty output folder gets a book folder before the model is called', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const output = path.join(dir, 'notes');
  const book = path.join(output, 'Distiller Booklet');
  const agentFile = path.join(dir, 'agent.json');
  const agentLog = path.join(dir, 'agent.log');
  await mkdir(output);
  await writeFile(path.join(output, 'notes.txt'), 'hello');
  await writeFile(agentFile, JSON.stringify({ replies: [JSON.stringify(numberedRuleBoard())] }));
  const { app, window } = await launch(dir, {
    BOOK_DISTILLER_AGENT_FILE: agentFile,
    BOOK_DISTILLER_AGENT_LOG: agentLog,
    BOOK_DISTILLER_WORK_ROOT: path.join(dir, 'work'),
    BOOK_DISTILLER_AGENT_DELAY_MS: '2000',
  });
  try {
    await window.locator('input[type=file]').setInputFiles(booklet);
    await saveKey(window);
    await chooseDirectory(app, window, output, 'Choose a folder');
    await window.getByRole('button', { name: 'Start' }).click();
    await window.getByRole('listitem').filter({ hasText: 'A listing' }).getByRole('checkbox').click();
    await window.getByRole('button', { name: 'Confirm' }).click();
    const manifestPath = path.join(book, 'book-manifest.json');
    await expect
      .poll(async () => {
        let manifest = '';
        try {
          manifest = await readFile(manifestPath, 'utf8');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return 'missing';
          }
          throw error;
        }
        if ((await logText(agentLog)) !== '') {
          return 'called';
        }
        return manifest.includes('"queued"') ? 'ready' : 'waiting';
      })
      .toBe('ready');
    await expect(access(path.join(output, 'book-manifest.json'))).rejects.toThrow();
    expect(await readFile(path.join(output, 'notes.txt'), 'utf8')).toBe('hello');
    await expect(window.getByRole('heading', { name: 'Flush the log before memory' })).toBeVisible();
    await readFile(path.join(book, 'boards', 'a-numbered-rule.board.json'), 'utf8');
    await openSettings(window);
    await expect(window.getByText(output, { exact: true })).toBeVisible();
    await expect(window.getByText(book, { exact: true })).toBeVisible();
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('the same PDF reuses its book folder and skips a valid board', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const output = path.join(dir, 'notes');
  const book = path.join(output, 'Renamed Book');
  const agentFile = path.join(dir, 'agent.json');
  const agentLog = path.join(dir, 'agent.log');
  await mkdir(path.join(book, 'boards'), { recursive: true });
  await writeFile(path.join(output, 'notes.txt'), 'hello');
  await writeFile(
    path.join(book, 'book-manifest.json'),
    `${JSON.stringify({ schemaVersion: 1, pdfPath: booklet, title: 'Distiller Booklet', slices: [] }, null, 2)}\n`,
  );
  await writeFile(
    path.join(book, 'boards', 'a-numbered-rule.board.json'),
    `${JSON.stringify(numberedRuleBoard(), null, 2)}\n`,
  );
  await writeFile(agentFile, JSON.stringify({ replies: [JSON.stringify(numberedRuleBoard())] }));
  const { app, window } = await launch(dir, {
    BOOK_DISTILLER_AGENT_FILE: agentFile,
    BOOK_DISTILLER_AGENT_LOG: agentLog,
    BOOK_DISTILLER_WORK_ROOT: path.join(dir, 'work'),
  });
  try {
    await window.locator('input[type=file]').setInputFiles(booklet);
    await saveKey(window);
    await chooseDirectory(app, window, output, 'Choose a folder');
    await window.getByRole('button', { name: 'Start' }).click();
    await window.getByRole('listitem').filter({ hasText: 'A listing' }).getByRole('checkbox').click();
    await window.getByRole('button', { name: 'Confirm' }).click();
    await expect(window.getByRole('listitem').filter({ hasText: 'A numbered rule' })).toContainText('done');
    expect(await logText(agentLog)).toBe('');
    await expect(access(path.join(output, 'Distiller Booklet'))).rejects.toThrow();
    await readFile(path.join(book, 'boards', 'a-numbered-rule.board.json'), 'utf8');
    await expect(access(path.join(output, 'book-manifest.json'))).rejects.toThrow();
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Open book shows a partial folder and Continue finishes the failed slice', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const book = path.join(dir, 'saved-book');
  const agentFile = path.join(dir, 'agent.json');
  const agentLog = path.join(dir, 'agent.log');
  await writePartialBook(book);
  await writeFile(agentFile, JSON.stringify({ replies: [JSON.stringify({
    schemaVersion: 1,
    sectionId: 'preface',
    sectionTitle: 'Preface',
    pageStart: 1,
    pageEnd: 1,
    points: [],
    code: [],
  })] }));
  const { app, window } = await launch(dir, {
    BOOK_DISTILLER_AGENT_FILE: agentFile,
    BOOK_DISTILLER_AGENT_LOG: agentLog,
    BOOK_DISTILLER_WORK_ROOT: path.join(dir, 'work'),
  });
  try {
    await expect(window.getByRole('button', { name: 'Open book' })).toBeVisible();
    await chooseDirectory(app, window, book, 'Open book');
    await expect(window.getByRole('region', { name: 'Viewer' })).toBeVisible();
    await expect(window.getByRole('heading', { name: 'Flush the log before memory' })).toBeVisible();
    await expect(window.getByRole('listitem').filter({ hasText: 'Preface' })).toContainText('failed');
    expect(await logText(agentLog)).toBe('');
    await saveKey(window);
    await window.getByRole('listitem').filter({ hasText: 'A listing' }).getByRole('checkbox').click();
    await window.getByRole('button', { name: 'Continue' }).click();
    await expect(window.getByRole('listitem').filter({ hasText: 'Preface' })).toContainText('done');
    const log = await readFile(agentLog, 'utf8');
    expect(log).toContain('"sectionId":"preface"');
    expect(log).not.toContain('"sectionId":"a-listing"');
    expect(log).not.toContain('"sectionId":"a-numbered-rule"');
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a title with a Windows-illegal character still saves the board', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const output = path.join(dir, 'notes');
  const pdfPath = path.join(dir, 'design-data.pdf');
  const agentFile = path.join(dir, 'agent.json');
  await mkdir(output);
  await writeFile(path.join(output, 'notes.txt'), 'hello');
  await writePdf(pdfPath, 'Design: Data?');
  await writeFile(agentFile, JSON.stringify({ replies: [JSON.stringify(emptyBoard())] }));
  const { app, window } = await launch(dir, {
    BOOK_DISTILLER_AGENT_FILE: agentFile,
    BOOK_DISTILLER_WORK_ROOT: path.join(dir, 'work'),
  });
  try {
    await window.locator('input[type=file]').setInputFiles(pdfPath);
    await expect(window.getByText('Design: Data?')).toBeVisible();
    await saveKey(window);
    await chooseDirectory(app, window, output, 'Choose a folder');
    await window.getByRole('button', { name: 'Start' }).click();
    await window.getByRole('button', { name: 'Confirm' }).click();
    await expect(window.getByText('Those pages had no technical content.')).toBeVisible();
    const names = await readdir(output);
    expect(names).toContain('Design Data');
    expect(names.some((name) => name.includes(':') || name.includes('?'))).toBe(false);
    await readFile(path.join(output, 'Design Data', 'boards', 'pages-1-1.board.json'), 'utf8');
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('an output folder that is already this book keeps the files there', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const userData = path.join(dir, 'user-data');
  const book = path.join(dir, 'saved-book');
  const agentFile = path.join(dir, 'agent.json');
  const agentLog = path.join(dir, 'agent.log');
  await mkdir(path.join(book, 'boards'), { recursive: true });
  await writeFile(
    path.join(book, 'book-manifest.json'),
    `${JSON.stringify({ schemaVersion: 1, pdfPath: booklet, title: 'Distiller Booklet', slices: [] }, null, 2)}\n`,
  );
  await writeFile(
    path.join(book, 'boards', 'a-numbered-rule.board.json'),
    `${JSON.stringify(numberedRuleBoard(), null, 2)}\n`,
  );
  await mkdir(userData);
  await writeFile(
    path.join(userData, 'settings.json'),
    JSON.stringify({
      modelId: 'north-model',
      modelIds: ['north-model', 'south-model'],
      folderPath: book,
    }),
  );
  await writeFile(path.join(userData, 'memory-vault.json'), JSON.stringify({ key: secret }));
  await writeFile(agentFile, JSON.stringify({ replies: [] }));
  const { app, window } = await launch(dir, {
    BOOK_DISTILLER_AGENT_FILE: agentFile,
    BOOK_DISTILLER_AGENT_LOG: agentLog,
    BOOK_DISTILLER_WORK_ROOT: path.join(dir, 'work'),
  });
  try {
    await window.locator('input[type=file]').setInputFiles(booklet);
    await expect(window.getByRole('button', { name: 'Start' })).toBeEnabled();
    await window.getByRole('button', { name: 'Start' }).click();
    await window.getByRole('listitem').filter({ hasText: 'A listing' }).getByRole('checkbox').click();
    await window.getByRole('button', { name: 'Confirm' }).click();
    await expect(window.getByRole('listitem').filter({ hasText: 'A numbered rule' })).toContainText('done');
    expect(await logText(agentLog)).toBe('');
    const entries = await readdir(book, { withFileTypes: true });
    expect(entries.some((entry) => entry.isDirectory() && entry.name === 'Distiller Booklet')).toBe(false);
    await readFile(path.join(book, 'boards', 'a-numbered-rule.board.json'), 'utf8');
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a taken book name uses the next folder', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const output = path.join(dir, 'notes');
  const taken = path.join(output, 'Distiller Booklet');
  const book = path.join(output, 'Distiller Booklet (2)');
  const agentFile = path.join(dir, 'agent.json');
  await mkdir(taken, { recursive: true });
  await writeFile(path.join(taken, 'readme.txt'), 'leave me');
  await writeFile(agentFile, JSON.stringify({ replies: [JSON.stringify(numberedRuleBoard())] }));
  const { app, window } = await launch(dir, {
    BOOK_DISTILLER_AGENT_FILE: agentFile,
    BOOK_DISTILLER_WORK_ROOT: path.join(dir, 'work'),
  });
  try {
    await window.locator('input[type=file]').setInputFiles(booklet);
    await saveKey(window);
    await chooseDirectory(app, window, output, 'Choose a folder');
    await window.getByRole('button', { name: 'Start' }).click();
    await window.getByRole('listitem').filter({ hasText: 'A listing' }).getByRole('checkbox').click();
    await window.getByRole('button', { name: 'Confirm' }).click();
    await expect(window.getByRole('heading', { name: 'Flush the log before memory' })).toBeVisible();
    await readFile(path.join(book, 'boards', 'a-numbered-rule.board.json'), 'utf8');
    expect(await readFile(path.join(taken, 'readme.txt'), 'utf8')).toBe('leave me');
    await expect(access(path.join(taken, 'book-manifest.json'))).rejects.toThrow();
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function confirmDropped(
  dir: string,
  output: string,
  dropped: string,
  agentFile: string,
  agentLog: string,
  settingsSaved = false,
): Promise<void> {
  const { app, window } = await launch(dir, {
    BOOK_DISTILLER_AGENT_FILE: agentFile,
    BOOK_DISTILLER_AGENT_LOG: agentLog,
    BOOK_DISTILLER_WORK_ROOT: path.join(dir, 'work'),
  });
  try {
    await window.locator('input[type=file]').setInputFiles(dropped);
    if (!settingsSaved) {
      await saveKey(window);
      await chooseDirectory(app, window, output, 'Choose a folder');
    }
    await window.getByRole('button', { name: 'Start' }).click();
    await window.getByRole('listitem').filter({ hasText: 'A listing' }).getByRole('checkbox').click();
    await window.getByRole('button', { name: 'Confirm' }).click();
    await expect(window.getByRole('listitem').filter({ hasText: 'A numbered rule' })).toContainText('done');
  } finally {
    await app.close();
  }
}

test('Confirm keeps source.pdf in the book folder and the same PDF reuses it', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const output = path.join(dir, 'notes');
  const dropped = path.join(dir, 'dropped.pdf');
  const agentFile = path.join(dir, 'agent.json');
  const agentLog = path.join(dir, 'agent.log');
  await mkdir(output);
  await copyFile(booklet, dropped);
  await writeFile(agentFile, JSON.stringify({ replies: [JSON.stringify(numberedRuleBoard())] }));
  try {
    await confirmDropped(dir, output, dropped, agentFile, agentLog);
    const names = await readdir(output);
    expect(names).toEqual(['Distiller Booklet']);
    const book = path.join(output, 'Distiller Booklet');
    expect((await readFile(path.join(book, 'source.pdf'))).equals(await readFile(dropped))).toBe(true);
    const manifest = JSON.parse(await readFile(path.join(book, 'book-manifest.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.pdfPath).toBe(path.join(book, 'source.pdf'));
    expect(manifest.originPath).toBe(dropped);

    await writeFile(agentFile, JSON.stringify({ replies: [] }));
    await confirmDropped(dir, output, dropped, agentFile, agentLog, true);
    expect(await readdir(output)).toEqual(['Distiller Booklet']);
    const again = JSON.parse(await readFile(path.join(book, 'book-manifest.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(again.pdfPath).toBe(path.join(book, 'source.pdf'));
    expect(again.originPath).toBe(dropped);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a dropped file named source.pdf outside the book folder keeps originPath and is reused', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const output = path.join(dir, 'notes');
  const dropped = path.join(dir, 'downloads', 'source.pdf');
  const agentFile = path.join(dir, 'agent.json');
  const agentLog = path.join(dir, 'agent.log');
  await mkdir(output);
  await mkdir(path.dirname(dropped));
  await copyFile(booklet, dropped);
  await writeFile(agentFile, JSON.stringify({ replies: [JSON.stringify(numberedRuleBoard())] }));
  try {
    await confirmDropped(dir, output, dropped, agentFile, agentLog);
    expect(await readdir(output)).toEqual(['Distiller Booklet']);
    const book = path.join(output, 'Distiller Booklet');
    const manifest = JSON.parse(await readFile(path.join(book, 'book-manifest.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(manifest.pdfPath).toBe(path.join(book, 'source.pdf'));
    expect(manifest.originPath).toBe(dropped);

    await writeFile(agentFile, JSON.stringify({ replies: [] }));
    await confirmDropped(dir, output, dropped, agentFile, agentLog, true);
    expect(await readdir(output)).toEqual(['Distiller Booklet']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a moved book folder opens its cited page without the dropped PDF', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const output = path.join(dir, 'notes');
  const moved = path.join(dir, 'elsewhere', 'moved-book');
  const dropped = path.join(dir, 'dropped.pdf');
  const agentFile = path.join(dir, 'agent.json');
  const agentLog = path.join(dir, 'agent.log');
  await mkdir(output);
  await mkdir(path.dirname(moved));
  await copyFile(booklet, dropped);
  await writeFile(agentFile, JSON.stringify({ replies: [JSON.stringify(numberedRuleBoard())] }));
  try {
    await confirmDropped(dir, output, dropped, agentFile, agentLog);
    await rename(path.join(output, 'Distiller Booklet'), moved);
    await rm(dropped);
    const { app, window } = await launch(dir);
    try {
      await chooseDirectory(app, window, moved, 'Open book');
      await expect(window.getByRole('heading', { name: 'Flush the log before memory' })).toBeVisible();
      await window.getByRole('button', { name: 'Page 2' }).first().click();
      const drawer = window.getByRole('complementary', { name: 'Page 2' });
      await expect(drawer).toBeVisible();
      await expect
        .poll(() => drawer.locator('canvas').evaluate((element) => (element as HTMLCanvasElement).width))
        .toBeGreaterThan(100);
      await expect(window.getByText('The PDF is missing.')).toHaveCount(0);
    } finally {
      await app.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a book folder with no source.pdf and a missing pdfPath still says the PDF is missing', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const book = path.join(dir, 'saved-book');
  await writePartialBook(book);
  const manifestPath = path.join(book, 'book-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { pdfPath: string };
  manifest.pdfPath = path.join(dir, 'missing.pdf');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const { app, window } = await launch(dir);
  try {
    await chooseDirectory(app, window, book, 'Open book');
    await expect(window.getByRole('heading', { name: 'Flush the log before memory' })).toBeVisible();
    await expect(window.getByText('The PDF is missing.')).toHaveCount(0);
    await window.getByRole('button', { name: 'Page 2' }).first().click();
    await expect(window.getByText('The PDF is missing.')).toBeVisible();
    await expect(access(path.join(book, 'source.pdf'))).rejects.toThrow();
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('choosing a book folder keeps the output folder', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const output = path.join(dir, 'notes');
  const book = path.join(dir, 'saved-book');
  await mkdir(output);
  await writeFile(path.join(output, 'notes.txt'), 'hello');
  await mkdir(book);
  await writeFile(
    path.join(book, 'book-manifest.json'),
    JSON.stringify({ schemaVersion: 1, pdfPath: booklet, title: 'Distiller Booklet', slices: [] }),
  );
  const first = await launch(dir);
  try {
    await first.window.locator('input[type=file]').setInputFiles(booklet);
    await saveKey(first.window);
    await chooseDirectory(first.app, first.window, output, 'Choose a folder');
    await openSettings(first.window);
    await expect(first.window.getByText(output, { exact: true })).toBeVisible();
    await chooseDirectory(first.app, first.window, book, 'Choose a folder');
    await expect(first.window.getByRole('region', { name: 'Viewer' })).toBeVisible();
  } finally {
    await first.app.close();
  }
  const second = await launch(dir);
  try {
    await expect(second.window.getByText('Drop a PDF')).toBeVisible();
    await openSettings(second.window);
    await expect(second.window.getByText(output, { exact: true })).toBeVisible();
    await expect(second.window.getByText(book, { exact: true })).toHaveCount(0);
  } finally {
    await second.app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
