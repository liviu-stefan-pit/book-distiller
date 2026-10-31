import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const electronPath = require('electron') as string;
const readable = 'This page has enough letters to count as readable text.';

type PdfOutline = {
  addItem(title: string): PdfOutline;
};

type PdfDoc = {
  font(name: string): PdfDoc;
  fontSize(size: number): PdfDoc;
  text(text: string, options?: { width: number }): PdfDoc;
  addPage(): PdfDoc;
  outline: PdfOutline;
  pipe(out: NodeJS.WritableStream): void;
  end(): void;
  on(event: 'error', listener: (error: Error) => void): void;
};

const PDFDocument = require('pdfkit') as new (options?: { margin?: number }) => PdfDoc;

async function launchApp(
  dir: string,
  extraEnv: Record<string, string> = {},
): Promise<{ app: ElectronApplication; window: Page; folder: string }> {
  const userData = path.join(dir, 'user-data');
  const catalogFile = path.join(dir, 'catalog.json');
  const folder = path.join(dir, 'output');
  await mkdir(userData);
  await mkdir(folder);
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
  return { app, window, folder };
}

async function saveKeyAndModel(window: Page): Promise<void> {
  await window.getByLabel('Cursor key').fill('cursor-test-key-alpha');
  await window.getByRole('button', { name: 'Save' }).click();
  await window.getByRole('combobox', { name: 'Model' }).selectOption('north-model');
}

async function chooseLaunchFolder(app: ElectronApplication, window: Page, folder: string): Promise<void> {
  await app.evaluate(({ dialog }, chosen: string) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] });
  }, folder);
  await window.getByRole('button', { name: 'Choose a folder' }).click();
}

async function openChecklist(app: ElectronApplication, window: Page, folder: string): Promise<void> {
  await saveKeyAndModel(window);
  await chooseLaunchFolder(app, window, folder);
  await expect(window.getByText(folder)).toBeVisible();
  await window.getByRole('button', { name: 'Start' }).click();
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

function writePdf(filePath: string, write: (doc: PdfDoc) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 72 });
    const out = createWriteStream(filePath);
    out.on('finish', () => resolve());
    out.on('error', reject);
    doc.on('error', reject);
    doc.pipe(out);
    write(doc);
    doc.end();
  });
}

function writePage(doc: PdfDoc, text = readable): void {
  doc.font('Times-Roman').fontSize(12).text(text, { width: 468 });
}

function writeFollowingPages(doc: PdfDoc, count: number, text = readable): void {
  for (let index = 0; index < count; index += 1) {
    doc.addPage();
    writePage(doc, text);
  }
}

function addTextPages(doc: PdfDoc, count: number, text: string): void {
  writePage(doc, text);
  if (count > 1) {
    writeFollowingPages(doc, count - 1, text);
  }
}

async function expectSlice(row: Locator, title: string, start: number, end: number, checked: boolean): Promise<void> {
  await expect(row).toContainText(title);
  await expect(row).toContainText(`${start}\u2013${end}`);
  const box = row.getByRole('checkbox');
  if (checked) {
    await expect(box).toBeChecked();
  } else {
    await expect(box).not.toBeChecked();
  }
}

test('start opens the booklet checklist with the slicer cuts', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const { app, window, folder } = await launchApp(dir);
  try {
    await expect(window.getByText('Drop a PDF')).toBeVisible();
    await dropPdf(window, path.join(process.cwd(), 'fixtures/booklet.pdf'), 'booklet.pdf');
    await openChecklist(app, window, folder);
    const rows = window.getByRole('listitem');
    await expect(rows).toHaveCount(3);
    await expectSlice(rows.nth(0), 'Preface', 1, 1, false);
    await expectSlice(rows.nth(1), 'A numbered rule', 2, 2, true);
    await expectSlice(rows.nth(2), 'A listing', 3, 4, true);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a heading longer than 6 pages splits into chunks of 6', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const { app, window, folder } = await launchApp(dir);
  try {
    const pdfPath = path.join(dir, 'chapter.pdf');
    await writePdf(pdfPath, (doc) => {
      doc.outline.addItem('Chapter');
      addTextPages(doc, 8, readable);
    });
    await expect(window.getByText('Choose a PDF')).toBeVisible();
    await window.locator('input[type=file]').setInputFiles(pdfPath);
    await openChecklist(app, window, folder);
    const rows = window.getByRole('listitem');
    await expect(rows).toHaveCount(2);
    await expectSlice(rows.nth(0), 'Chapter', 1, 6, true);
    await expectSlice(rows.nth(1), 'Chapter', 7, 8, true);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a longer heading splits on its children before chunking', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const { app, window, folder } = await launchApp(dir);
  try {
    const pdfPath = path.join(dir, 'children.pdf');
    await writePdf(pdfPath, (doc) => {
      const guide = doc.outline.addItem('Guide');
      writePage(doc);
      writeFollowingPages(doc, 2);
      doc.addPage();
      guide.addItem('Left');
      writePage(doc);
      writeFollowingPages(doc, 5);
      doc.addPage();
      guide.addItem('Right');
      writePage(doc);
      writeFollowingPages(doc, 6);
      doc.addPage();
      const short = doc.outline.addItem('Short');
      writePage(doc);
      doc.addPage();
      short.addItem('Detail');
      writePage(doc);
      writeFollowingPages(doc, 2);
    });
    await expect(window.getByText('Choose a PDF')).toBeVisible();
    await window.locator('input[type=file]').setInputFiles(pdfPath);
    await openChecklist(app, window, folder);
    const rows = window.getByRole('listitem');
    await expect(rows).toHaveCount(5);
    await expectSlice(rows.nth(0), 'Guide', 1, 3, true);
    await expectSlice(rows.nth(1), 'Left', 4, 9, true);
    await expectSlice(rows.nth(2), 'Right', 10, 15, true);
    await expectSlice(rows.nth(3), 'Right', 16, 16, true);
    await expectSlice(rows.nth(4), 'Short', 17, 20, true);
    await expect(window.getByText('Detail')).toHaveCount(0);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('pages outside the outline start unchecked and stay within 6 pages', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const { app, window, folder } = await launchApp(dir);
  try {
    const pdfPath = path.join(dir, 'gap.pdf');
    await writePdf(pdfPath, (doc) => {
      addTextPages(doc, 8, readable);
      doc.addPage();
      doc.outline.addItem('Body');
      writePage(doc);
      writeFollowingPages(doc, 1);
    });
    await expect(window.getByText('Choose a PDF')).toBeVisible();
    await window.locator('input[type=file]').setInputFiles(pdfPath);
    await openChecklist(app, window, folder);
    const rows = window.getByRole('listitem');
    await expect(rows).toHaveCount(3);
    await expectSlice(rows.nth(0), `Pages 1\u20136`, 1, 6, false);
    await expectSlice(rows.nth(1), `Pages 7\u20138`, 7, 8, false);
    await expectSlice(rows.nth(2), 'Body', 9, 10, true);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a PDF with no outline becomes 4-page windows', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const { app, window, folder } = await launchApp(dir);
  try {
    const pdfPath = path.join(dir, 'windows.pdf');
    await writePdf(pdfPath, (doc) => {
      writePage(doc, `Foreword ${readable}`);
      writeFollowingPages(doc, 3);
      doc.addPage();
      writePage(doc, `Bibliography ${readable}`);
      writeFollowingPages(doc, 3);
      doc.addPage();
      writePage(doc);
    });
    await expect(window.getByText('Choose a PDF')).toBeVisible();
    await window.locator('input[type=file]').setInputFiles(pdfPath);
    await openChecklist(app, window, folder);
    const rows = window.getByRole('listitem');
    await expect(rows).toHaveCount(3);
    await expectSlice(rows.nth(0), `Pages 1\u20134`, 1, 4, false);
    await expectSlice(rows.nth(1), `Pages 5\u20138`, 5, 8, false);
    await expectSlice(rows.nth(2), `Pages 9\u20139`, 9, 9, true);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('front matter starts unchecked and a technical heading starts checked', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const { app, window, folder } = await launchApp(dir);
  try {
    const pdfPath = path.join(dir, 'front-matter.pdf');
    const headings = [
      'Preface',
      'Foreword',
      'Acknowledgments',
      'About the Author',
      'Table of Contents',
      'Bibliography',
      'Glossary',
      'Index of terms',
      'Appendix A',
      'A numbered rule',
    ];
    await writePdf(pdfPath, (doc) => {
      headings.forEach((heading, index) => {
        if (index > 0) {
          doc.addPage();
        }
        doc.outline.addItem(heading);
        writePage(doc);
      });
    });
    await expect(window.getByText('Choose a PDF')).toBeVisible();
    await window.locator('input[type=file]').setInputFiles(pdfPath);
    await openChecklist(app, window, folder);
    const rows = window.getByRole('listitem');
    await expect(rows).toHaveCount(headings.length);
    for (const [index, heading] of headings.entries()) {
      await expectSlice(rows.nth(index), heading, index + 1, index + 1, heading === 'A numbered rule');
    }
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('slices keep separate checkboxes when their ids would collide', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const { app, window, folder } = await launchApp(dir);
  try {
    const pdfPath = path.join(dir, 'ids.pdf');
    await writePdf(pdfPath, (doc) => {
      doc.outline.addItem('Chapter');
      writePage(doc);
      doc.addPage();
      doc.outline.addItem('Chapter 7');
      writePage(doc);
      writeFollowingPages(doc, 4);
      doc.addPage();
      doc.outline.addItem('Chapter');
      writePage(doc);
    });
    await expect(window.getByText('Choose a PDF')).toBeVisible();
    await window.locator('input[type=file]').setInputFiles(pdfPath);
    await openChecklist(app, window, folder);
    const rows = window.getByRole('listitem');
    await expect(rows).toHaveCount(3);
    await rows.nth(2).getByRole('checkbox').click();
    await expectSlice(rows.nth(0), 'Chapter', 1, 1, true);
    await expectSlice(rows.nth(1), 'Chapter 7', 2, 6, true);
    await expectSlice(rows.nth(2), 'Chapter', 7, 7, false);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('toggling a slice leaves the page range the slicer chose', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const { app, window, folder } = await launchApp(dir);
  try {
    await expect(window.getByText('Drop a PDF')).toBeVisible();
    await dropPdf(window, path.join(process.cwd(), 'fixtures/booklet.pdf'), 'booklet.pdf');
    await openChecklist(app, window, folder);
    const preface = window.getByRole('listitem').nth(0);
    const rule = window.getByRole('listitem').nth(1);
    await preface.getByRole('checkbox').click();
    await rule.getByRole('checkbox').click();
    await expectSlice(preface, 'Preface', 1, 1, true);
    await expectSlice(rule, 'A numbered rule', 2, 2, false);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('confirm shows the first board in Study and creates a missing folder', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const notes = path.join(dir, 'notes');
  const agentFile = path.join(dir, 'agent.json');
  const board = {
    schemaVersion: 1,
    sectionId: 'a-numbered-rule',
    sectionTitle: 'A numbered rule',
    pageStart: 2,
    pageEnd: 2,
    points: [
      {
        kind: 'must-remember',
        title: 'Flush the log before memory',
        explanation: 'A write is durable only after the log is on disk.',
        page: 2,
        example: { text: 'During the outage the log still held the write, and memory did not.', page: 2 },
      },
    ],
    code: [],
  };
  await writeFile(agentFile, JSON.stringify({ replies: [`Board follows.\n${JSON.stringify(board)}`] }));
  const { app, window } = await launchApp(dir, {
    BOOK_DISTILLER_AGENT_FILE: agentFile,
    BOOK_DISTILLER_WORK_ROOT: path.join(dir, 'work'),
  });
  const urls: string[] = [];
  window.on('request', (request) => urls.push(request.url()));
  try {
    await app.evaluate(() => {
      const http = process.getBuiltinModule('http');
      const https = process.getBuiltinModule('https');
      const fail = (kind: string) => () => {
        throw new Error(`unexpected ${kind}`);
      };
      http.request = fail('http.request') as typeof http.request;
      http.get = fail('http.get') as typeof http.get;
      https.request = fail('https.request') as typeof https.request;
      https.get = fail('https.get') as typeof https.get;
      globalThis.fetch = fail('fetch') as typeof fetch;
    });
    await expect(window.getByText('Choose a PDF')).toBeVisible();
    await window.locator('input[type=file]').setInputFiles(path.join(process.cwd(), 'fixtures/booklet.pdf'));
    await saveKeyAndModel(window);
    await chooseLaunchFolder(app, window, notes);
    await expect(window.getByText(notes)).toBeVisible();
    await access(notes);
    await window.getByRole('button', { name: 'Start' }).click();
    const rows = window.getByRole('listitem');
    await rows.nth(1).getByRole('checkbox').click();
    await rows.nth(2).getByRole('checkbox').click();
    await expect(window.getByRole('button', { name: 'Confirm' })).toBeDisabled();
    await rows.nth(1).getByRole('checkbox').click();
    await expect(window.getByRole('button', { name: 'Confirm' })).toBeEnabled();
    await window.getByRole('button', { name: 'Confirm' }).click();
    await expect(window.getByRole('heading', { name: 'Study' })).toBeVisible();
    const studied = window.getByRole('listitem');
    await expect(studied).toHaveCount(1);
    await expect(studied.nth(0)).toContainText('A numbered rule');
    await expect(studied.nth(0)).toContainText('2\u20132');
    await expect(studied.nth(0)).toContainText('Flush the log before memory');
    await expect(studied.nth(0)).toContainText('During the outage the log still held the write, and memory did not.');
    expect(urls.filter((url) => url.startsWith('http://') || url.startsWith('https://'))).toEqual([]);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a folder is refused unless it is empty or already this book', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const occupied = path.join(dir, 'occupied');
  const empty = path.join(dir, 'empty');
  const book = path.join(dir, 'book');
  const booklet = path.resolve(process.cwd(), 'fixtures/booklet.pdf');
  await mkdir(occupied);
  await writeFile(path.join(occupied, 'notes.txt'), 'hello');
  await mkdir(empty);
  await mkdir(book);
  await writeFile(
    path.join(book, 'book-manifest.json'),
    JSON.stringify({ schemaVersion: 1, pdfPath: booklet }),
  );
  await writeFile(path.join(book, 'extra.txt'), 'kept');
  const agentLog = path.join(dir, 'agent.log');
  const { app, window } = await launchApp(dir, { BOOK_DISTILLER_AGENT_LOG: agentLog });
  const start = window.getByRole('button', { name: 'Start' });
  try {
    await expect(window.getByText('Choose a PDF')).toBeVisible();
    await window.locator('input[type=file]').setInputFiles(booklet);
    await saveKeyAndModel(window);
    await expect(start).toBeDisabled();
    const refusal = "Choose an empty folder or this book's folder.";

    await chooseLaunchFolder(app, window, occupied);
    await expect(window.getByText(refusal)).toBeVisible();
    await expect(start).toBeDisabled();

    await chooseLaunchFolder(app, window, empty);
    await expect(window.getByText(refusal)).toHaveCount(0);
    await expect(window.getByText(empty)).toBeVisible();
    await expect(start).toBeEnabled();

    await chooseLaunchFolder(app, window, book);
    await expect(window.getByRole('heading', { name: 'Study' })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Confirm' })).toHaveCount(0);
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
