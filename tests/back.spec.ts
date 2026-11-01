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

async function dropPdf(window: Page, pdfPath: string, fileName: string): Promise<void> {
  const bytes = await readFile(pdfPath);
  await window.evaluate(
    ({ base64, name }) => {
      const binary = atob(base64);
      const data = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        data[index] = binary.charCodeAt(index);
      }
      const file = new File([data], name, { type: 'application/pdf' });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const target = [...document.querySelectorAll('body *')].find((element) => element.textContent === 'Drop a PDF');
      if (!target) {
        throw new Error('missing drop target');
      }
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    },
    { base64: bytes.toString('base64'), name: fileName },
  );
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

test('Back from an open book returns to the launchpad and keeps the book folder', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const book = path.join(dir, 'saved-book');
  await writePartialBook(book);
  const { app, window } = await launch(dir);
  try {
    await expect(window.getByRole('button', { name: 'Back' })).toHaveCount(0);
    await expect(window.getByRole('button', { name: 'Open book' })).toBeVisible();
    await chooseDirectory(app, window, book, 'Open book');
    await expect(window.getByRole('region', { name: 'Viewer' })).toBeVisible();
    await expect(window.getByRole('heading', { name: 'Flush the log before memory' })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Back' })).toBeVisible();
    await window.getByRole('button', { name: 'Back' }).click();
    await expect(window.getByText('Drop a PDF')).toBeVisible();
    await expect(window.getByRole('button', { name: 'Open book' })).toBeVisible();
    await expect(window.getByRole('heading', { name: 'Flush the log before memory' })).toHaveCount(0);
    await expect(window.getByRole('region', { name: 'Viewer' })).toHaveCount(0);
    await expect(window.getByRole('button', { name: 'Back' })).toHaveCount(0);
    await expect(window).toHaveTitle('Book Distiller');
    expect(await readFile(path.join(book, 'book-manifest.json'), 'utf8')).toContain('"title": "Distiller Booklet"');
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Back from the checklist returns to the launchpad', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const folder = path.join(dir, 'output');
  await mkdir(folder);
  const { app, window } = await launch(dir);
  try {
    await expect(window.getByText('Drop a PDF')).toBeVisible();
    await dropPdf(window, booklet, 'booklet.pdf');
    await saveKey(window);
    await chooseDirectory(app, window, folder, 'Choose a folder');
    await openSettings(window);
    await expect(window.getByText(folder)).toBeVisible();
    await window.getByRole('button', { name: 'Start' }).click();
    await expect(window.getByRole('dialog', { name: 'Slices' })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Back' })).toBeVisible();
    await window.getByRole('button', { name: 'Back' }).click();
    await expect(window.getByText('Drop a PDF')).toBeVisible();
    await expect(window.getByRole('dialog', { name: 'Slices' })).toHaveCount(0);
    await expect(window.getByRole('button', { name: 'Back' })).toHaveCount(0);
    await expect(window).toHaveTitle('Book Distiller');
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
