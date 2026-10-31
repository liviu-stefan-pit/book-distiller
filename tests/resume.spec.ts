import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { numberedRuleBoard, openSettings, secret } from './boardLaunch';

const require = createRequire(import.meta.url);
const electronPath = require('electron') as string;
const booklet = path.resolve(process.cwd(), 'fixtures/booklet.pdf');

async function launch(
  dir: string,
  extraEnv: Record<string, string>,
): Promise<{ app: ElectronApplication; window: Page }> {
  const userData = path.join(dir, 'user-data');
  const catalogFile = path.join(dir, 'catalog.json');
  await mkdir(userData);
  await writeFile(catalogFile, JSON.stringify({ models: ['north-model', 'south-model'] }));
  const app = await electron.launch({
    executablePath: electronPath,
    args: [path.join(process.cwd(), 'out/main/index.js')],
    env: {
      ...process.env,
      BOOK_DISTILLER_VAULT: 'memory',
      BOOK_DISTILLER_USER_DATA: userData,
      BOOK_DISTILLER_CATALOG_FILE: catalogFile,
      ...extraEnv,
    },
  });
  const window = await app.firstWindow();
  return { app, window };
}

async function chooseFolder(app: ElectronApplication, window: Page, folder: string): Promise<void> {
  await app.evaluate(({ dialog }, chosen: string) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] });
  }, folder);
  await openSettings(window);
  await window.getByRole('button', { name: 'Choose a folder' }).click();
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

function prefaceBoard(): unknown {
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

async function saveKey(window: Page): Promise<void> {
  await openSettings(window);
  await window.getByLabel('Cursor key').fill(secret);
  await openSettings(window);
  await window.getByRole('button', { name: 'Save' }).click();
  await openSettings(window);
  await window.getByRole('combobox', { name: 'Model' }).selectOption('north-model');
}

test('reopen without a call', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const folder = path.join(dir, 'book');
  const agentFile = path.join(dir, 'agent.json');
  const agentLog = path.join(dir, 'agent.log');
  await mkdir(folder);
  await writePartialBook(folder);
  await writeFile(agentFile, JSON.stringify({ replies: [] }));
  const { app, window } = await launch(dir, {
    BOOK_DISTILLER_AGENT_FILE: agentFile,
    BOOK_DISTILLER_AGENT_LOG: agentLog,
    BOOK_DISTILLER_WORK_ROOT: path.join(dir, 'work'),
  });
  try {
    await expect(window.getByText('Choose a PDF')).toBeVisible();
    await chooseFolder(app, window, folder);
    await expect(window.getByRole('region', { name: 'Viewer' })).toBeVisible();
    await expect(window.getByRole('heading', { name: 'Flush the log before memory' })).toBeVisible();
    await expect(window.getByRole('listitem').filter({ hasText: 'A numbered rule' })).toContainText('done');
    await expect(window.getByRole('listitem').filter({ hasText: 'A numbered rule' }).getByRole('checkbox')).toHaveCount(0);
    const preface = window.getByRole('listitem').filter({ hasText: 'Preface' });
    await expect(preface).toContainText('failed');
    const listing = window.getByRole('listitem').filter({ hasText: 'A listing' });
    await expect(listing.getByRole('checkbox')).toBeChecked();
    await expect(listing).not.toContainText('writing');
    await expect(listing).not.toContainText('done');
    let log = '';
    try {
      log = await readFile(agentLog, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    expect(log).toBe('');
    const manifest = JSON.parse(await readFile(path.join(folder, 'book-manifest.json'), 'utf8')) as {
      slices: Array<{ id: string; status: string }>;
    };
    expect(manifest.slices.find((slice) => slice.id === 'a-listing')?.status).not.toBe('done');
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Continue picks up the failed slice', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const folder = path.join(dir, 'book');
  const agentFile = path.join(dir, 'agent.json');
  const agentLog = path.join(dir, 'agent.log');
  await mkdir(folder);
  await writePartialBook(folder);
  await writeFile(agentFile, JSON.stringify({ replies: [JSON.stringify(prefaceBoard())] }));
  const { app, window } = await launch(dir, {
    BOOK_DISTILLER_AGENT_FILE: agentFile,
    BOOK_DISTILLER_AGENT_LOG: agentLog,
    BOOK_DISTILLER_WORK_ROOT: path.join(dir, 'work'),
  });
  try {
    await expect(window.getByText('Choose a PDF')).toBeVisible();
    await saveKey(window);
    await chooseFolder(app, window, folder);
    await expect(window.getByRole('region', { name: 'Viewer' })).toBeVisible();
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

async function writeNumberedRuleBook(folder: string): Promise<void> {
  const note = '# A numbered rule\n\nFlush the log before memory\n';
  await mkdir(path.join(folder, 'boards'), { recursive: true });
  await mkdir(path.join(folder, 'notes'), { recursive: true });
  await writeFile(
    path.join(folder, 'boards', 'a-numbered-rule.board.json'),
    `${JSON.stringify(numberedRuleBoard(), null, 2)}\n`,
  );
  await writeFile(path.join(folder, 'notes', 'a-numbered-rule.md'), note);
  await writeFile(
    path.join(folder, 'book-manifest.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        pdfPath: booklet,
        title: 'Distiller Booklet',
        slices: [
          {
            id: 'a-numbered-rule',
            title: 'A numbered rule',
            pageStart: 2,
            pageEnd: 2,
            checked: true,
            status: 'done',
            modelId: 'north-model',
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

function schemaTwoBoard(): unknown {
  return { ...(numberedRuleBoard() as Record<string, unknown>), schemaVersion: 2 };
}

test('a failed redo keeps the open board', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const folder = path.join(dir, 'book');
  const agentFile = path.join(dir, 'agent.json');
  const agentLog = path.join(dir, 'agent.log');
  const boardPath = path.join(folder, 'boards', 'a-numbered-rule.board.json');
  const notePath = path.join(folder, 'notes', 'a-numbered-rule.md');
  await mkdir(folder);
  await writeNumberedRuleBook(folder);
  await writeFile(
    agentFile,
    JSON.stringify({ replies: [JSON.stringify(schemaTwoBoard()), JSON.stringify(schemaTwoBoard())] }),
  );
  const { app, window } = await launch(dir, {
    BOOK_DISTILLER_AGENT_FILE: agentFile,
    BOOK_DISTILLER_AGENT_LOG: agentLog,
    BOOK_DISTILLER_WORK_ROOT: path.join(dir, 'work'),
  });
  try {
    await expect(window.getByText('Choose a PDF')).toBeVisible();
    await chooseFolder(app, window, folder);
    await expect(window.getByRole('heading', { name: 'Flush the log before memory' })).toBeVisible();
    const boardBefore = await readFile(boardPath);
    const noteBefore = await readFile(notePath);
    await window.getByRole('button', { name: 'Redo' }).click();
    await expect.poll(async () => {
      try {
        return (await readFile(agentLog, 'utf8')).trim().split('\n').length;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return 0;
        }
        throw error;
      }
    }).toBe(2);
    await expect(window.getByRole('heading', { name: 'Flush the log before memory' })).toBeVisible();
    expect(await readFile(boardPath)).toEqual(boardBefore);
    expect(await readFile(notePath)).toEqual(noteBefore);
    expect(noteBefore.toString('utf8').includes('Flush the log before memory')).toBe(true);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('redo replaces the board only after it validates', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const folder = path.join(dir, 'book');
  const agentFile = path.join(dir, 'agent.json');
  const boardPath = path.join(folder, 'boards', 'a-numbered-rule.board.json');
  const notePath = path.join(folder, 'notes', 'a-numbered-rule.md');
  const replacement = numberedRuleBoard() as { points: Array<{ title: string }> };
  replacement.points[0].title = 'Durability comes from the log';
  await mkdir(folder);
  await writeNumberedRuleBook(folder);
  await writeFile(agentFile, JSON.stringify({ replies: [JSON.stringify(replacement)] }));
  const { app, window } = await launch(dir, {
    BOOK_DISTILLER_AGENT_FILE: agentFile,
    BOOK_DISTILLER_WORK_ROOT: path.join(dir, 'work'),
    BOOK_DISTILLER_AGENT_DELAY_MS: '2000',
  });
  try {
    await expect(window.getByText('Choose a PDF')).toBeVisible();
    await chooseFolder(app, window, folder);
    await expect(window.getByRole('heading', { name: 'Flush the log before memory' })).toBeVisible();
    await window.getByRole('button', { name: 'Redo' }).click();
    await expect(window.getByRole('heading', { name: 'Flush the log before memory' })).toBeVisible();
    await expect(window.getByRole('heading', { name: 'Durability comes from the log' })).toHaveCount(0);
    expect(await readFile(boardPath, 'utf8')).toContain('Flush the log before memory');
    await expect(window.getByRole('heading', { name: 'Durability comes from the log' })).toBeVisible();
    expect(await readFile(boardPath, 'utf8')).toContain('Durability comes from the log');
    const note = await readFile(notePath, 'utf8');
    expect(note).toContain('Durability comes from the log');
    expect(note).not.toContain('Flush the log before memory');
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('cancel during redo keeps the open board and shows cancelled', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const folder = path.join(dir, 'book');
  const agentFile = path.join(dir, 'agent.json');
  const agentLog = path.join(dir, 'agent.log');
  const boardPath = path.join(folder, 'boards', 'a-numbered-rule.board.json');
  const replacement = numberedRuleBoard() as { points: Array<{ title: string }> };
  replacement.points[0].title = 'Durability comes from the log';
  await mkdir(folder);
  await writeNumberedRuleBook(folder);
  await writeFile(agentFile, JSON.stringify({ replies: [JSON.stringify(replacement)] }));
  const { app, window } = await launch(dir, {
    BOOK_DISTILLER_AGENT_FILE: agentFile,
    BOOK_DISTILLER_AGENT_LOG: agentLog,
    BOOK_DISTILLER_WORK_ROOT: path.join(dir, 'work'),
    BOOK_DISTILLER_AFTER_REPLY_DELAY_MS: '2000',
  });
  try {
    await expect(window.getByText('Choose a PDF')).toBeVisible();
    await chooseFolder(app, window, folder);
    await expect(window.getByRole('heading', { name: 'Flush the log before memory' })).toBeVisible();
    await window.getByRole('button', { name: 'Redo' }).click();
    await expect
      .poll(async () => {
        try {
          return await readFile(agentLog, 'utf8');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return '';
          }
          throw error;
        }
      })
      .toContain('"sectionId":"a-numbered-rule"');
    await expect(window.getByRole('status')).toContainText('Writing A numbered rule again');
    await expect(window.getByRole('heading', { name: 'Flush the log before memory' })).toBeVisible({
      timeout: 1000,
    });
    await window.getByRole('button', { name: 'Cancel' }).click();
    await expect(window.getByRole('heading', { name: 'Flush the log before memory' })).toBeVisible();
    await expect(window.getByRole('heading', { name: 'Durability comes from the log' })).toHaveCount(0);
    expect(await readFile(boardPath, 'utf8')).toContain('Flush the log before memory');
    await expect(window.getByText('cancelled', { exact: true })).toBeVisible();
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a bad schema is refused and a schema-2 board is not done', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const badManifest = path.join(dir, 'bad-manifest');
  const badBoard = path.join(dir, 'bad-board');
  const boardPath = path.join(badBoard, 'boards', 'a-numbered-rule.board.json');
  await mkdir(badManifest);
  await writeFile(
    path.join(badManifest, 'book-manifest.json'),
    `${JSON.stringify({ schemaVersion: 2, pdfPath: booklet, title: 'Distiller Booklet', slices: [] }, null, 2)}\n`,
  );
  await mkdir(path.join(badBoard, 'boards'), { recursive: true });
  await writeFile(boardPath, `${JSON.stringify(schemaTwoBoard(), null, 2)}\n`);
  await writeFile(
    path.join(badBoard, 'book-manifest.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        pdfPath: booklet,
        title: 'Distiller Booklet',
        slices: [
          {
            id: 'a-numbered-rule',
            title: 'A numbered rule',
            pageStart: 2,
            pageEnd: 2,
            checked: true,
            status: 'done',
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  const { app, window } = await launch(dir, {});
  try {
    await expect(window.getByText('Choose a PDF')).toBeVisible();
    await chooseFolder(app, window, badManifest);
    await expect(window.getByText('This book folder could not be read.')).toBeVisible();
    await expect(window.getByRole('region', { name: 'Viewer' })).toHaveCount(0);
    await expect(window.getByText('Choose a PDF')).toBeVisible();
    await chooseFolder(app, window, badBoard);
    await expect(window.getByRole('region', { name: 'Viewer' })).toBeVisible();
    await expect(window.getByRole('listitem').filter({ hasText: 'A numbered rule' })).not.toContainText('done');
    expect(JSON.parse(await readFile(boardPath, 'utf8')).schemaVersion).toBe(2);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing PDF still opens the board', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const folder = path.join(dir, 'book');
  await mkdir(folder);
  await writeNumberedRuleBook(folder);
  const manifestPath = path.join(folder, 'book-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { pdfPath: string };
  manifest.pdfPath = path.join(dir, 'missing.pdf');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const { app, window } = await launch(dir, {});
  try {
    await expect(window.getByText('Choose a PDF')).toBeVisible();
    await chooseFolder(app, window, folder);
    await expect(window.getByRole('heading', { name: 'Flush the log before memory' })).toBeVisible();
    await expect(window.getByText('The PDF is missing.')).toHaveCount(0);
    await window.getByRole('button', { name: 'Page 2' }).first().click();
    await expect(window.getByText('The PDF is missing.')).toBeVisible();
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Continue keeps the done board and the unchecked failure', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const folder = path.join(dir, 'book');
  const agentFile = path.join(dir, 'agent.json');
  await mkdir(folder);
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
            failureReason: 'network',
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
            checked: false,
            status: 'failed',
            failureReason: 'shape',
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(agentFile, JSON.stringify({ replies: [JSON.stringify(prefaceBoard())] }));
  const { app, window } = await launch(dir, {
    BOOK_DISTILLER_AGENT_FILE: agentFile,
    BOOK_DISTILLER_WORK_ROOT: path.join(dir, 'work'),
    BOOK_DISTILLER_AGENT_DELAY_MS: '2000',
  });
  try {
    await expect(window.getByText('Choose a PDF')).toBeVisible();
    await saveKey(window);
    await chooseFolder(app, window, folder);
    await expect(window.getByRole('heading', { name: 'Flush the log before memory' })).toBeVisible();
    await window.getByRole('button', { name: 'Continue' }).click();
    const preface = window.getByRole('listitem').filter({ hasText: 'Preface' });
    await expect(preface).toContainText('writing');
    await expect(window.getByRole('heading', { name: 'Flush the log before memory' })).toBeVisible();
    await expect(preface).toContainText('writing');
    await expect(preface).toContainText('done');
    const manifest = JSON.parse(await readFile(path.join(folder, 'book-manifest.json'), 'utf8')) as {
      slices: Array<{ id: string; status: string; modelId?: string; failureReason?: string }>;
    };
    const stored = Object.fromEntries(manifest.slices.map((slice) => [slice.id, slice]));
    expect(stored['a-numbered-rule']?.status).toBe('done');
    expect(stored['a-numbered-rule']?.modelId).toBe('north-model');
    expect(stored['a-listing']?.status).toBe('failed');
    expect(stored['a-listing']?.failureReason).toBe('shape');
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('reopen opens the stored PDF page', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const folder = path.join(dir, 'book');
  await mkdir(folder);
  await writeNumberedRuleBook(folder);
  const { app, window } = await launch(dir, {});
  try {
    await expect(window.getByText('Choose a PDF')).toBeVisible();
    await chooseFolder(app, window, folder);
    await expect(window.getByRole('heading', { name: 'Flush the log before memory' })).toBeVisible();
    await window.getByRole('button', { name: 'Page 2' }).first().click();
    const drawer = window.getByRole('complementary', { name: 'Page 2' });
    await expect(drawer).toBeVisible();
    await expect
      .poll(() => drawer.locator('canvas').evaluate((element) => (element as HTMLCanvasElement).width))
      .toBeGreaterThan(100);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing PDF keeps the board and does not continue', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const folder = path.join(dir, 'book');
  const agentFile = path.join(dir, 'agent.json');
  const agentLog = path.join(dir, 'agent.log');
  const boardPath = path.join(folder, 'boards', 'a-numbered-rule.board.json');
  await mkdir(folder);
  await writeNumberedRuleBook(folder);
  const manifest = JSON.parse(await readFile(path.join(folder, 'book-manifest.json'), 'utf8')) as {
    pdfPath: string;
    slices: Array<Record<string, unknown>>;
  };
  manifest.pdfPath = path.join(dir, 'missing.pdf');
  manifest.slices.unshift({
    id: 'preface',
    title: 'Preface',
    pageStart: 1,
    pageEnd: 1,
    checked: true,
    status: 'failed',
    failureReason: 'shape',
  });
  await writeFile(path.join(folder, 'book-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(agentFile, JSON.stringify({ replies: [JSON.stringify(prefaceBoard())] }));
  const { app, window } = await launch(dir, {
    BOOK_DISTILLER_AGENT_FILE: agentFile,
    BOOK_DISTILLER_AGENT_LOG: agentLog,
    BOOK_DISTILLER_WORK_ROOT: path.join(dir, 'work'),
  });
  try {
    await expect(window.getByText('Choose a PDF')).toBeVisible();
    await chooseFolder(app, window, folder);
    await expect(window.getByRole('heading', { name: 'Flush the log before memory' })).toBeVisible();
    const boardBefore = await readFile(boardPath);
    await window.getByRole('button', { name: 'Redo' }).click();
    await expect(window.getByRole('heading', { name: 'Flush the log before memory' })).toBeVisible();
    expect(await readFile(boardPath)).toEqual(boardBefore);
    await expect(window.getByText('The PDF is missing.')).toBeVisible();
    await window.getByRole('button', { name: 'Continue' }).click();
    let log = '';
    try {
      log = await readFile(agentLog, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    expect(log).toBe('');
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
