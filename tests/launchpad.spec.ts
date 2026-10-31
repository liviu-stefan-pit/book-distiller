import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const electronPath = require('electron') as string;

async function launchApp(): Promise<{ app: ElectronApplication; window: Page }> {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [path.join(process.cwd(), 'out/main/index.js')],
  });
  const window = await app.firstWindow();
  return { app, window };
}

function relativeLuminance(rgb: string): number {
  const match = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) {
    throw new Error(`expected an rgb color, got ${rgb}`);
  }
  const channels = [match[1], match[2], match[3]].map((channel) => {
    const value = Number(channel) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
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

test('dropping the booklet shows its title and page count', async () => {
  const { app, window } = await launchApp();
  try {
    await expect(window.getByText('Drop a PDF')).toBeVisible();
    await dropPdf(window, path.join(process.cwd(), 'fixtures/booklet.pdf'), 'booklet.pdf');
    await expect(window.getByText('Distiller Booklet')).toBeVisible();
    await expect(window.getByText('4 pages')).toBeVisible();
    await expect(window).toHaveTitle('Distiller Booklet');
  } finally {
    await app.close();
  }
});

test('a PDF with too few text pages shows the incompatible file message', async () => {
  const { app, window } = await launchApp();
  try {
    await expect(window.getByText('Drop a PDF')).toBeVisible();
    await dropPdf(window, path.join(process.cwd(), 'fixtures/mostly-page-numbers.pdf'), 'mostly-page-numbers.pdf');
    await expect(window.getByText('This file is incompatible.')).toBeVisible();
    await expect(window.getByText('Scanned Notes')).toHaveCount(0);
    await expect(window.getByText(/\d+ pages?/)).toHaveCount(0);
    await expect(window).toHaveTitle('Book Distiller');
  } finally {
    await app.close();
  }
});

test('an accepted PDF with no title shows the file name', async () => {
  const { app, window } = await launchApp();
  try {
    await expect(window.getByText('Drop a PDF')).toBeVisible();
    await dropPdf(window, path.join(process.cwd(), 'fixtures/untitled.pdf'), 'untitled.pdf');
    await expect(window.getByText('untitled.pdf')).toBeVisible();
    await expect(window.getByText('1 page')).toBeVisible();
    await expect(window).toHaveTitle('untitled.pdf');
  } finally {
    await app.close();
  }
});

test('choosing the booklet shows its title and page count', async () => {
  const { app, window } = await launchApp();
  try {
    await expect(window.getByText('Choose a PDF')).toBeVisible();
    await window.locator('input[type=file]').setInputFiles(path.join(process.cwd(), 'fixtures/booklet.pdf'));
    await expect(window.getByText('Distiller Booklet')).toBeVisible();
    await expect(window.getByText('4 pages')).toBeVisible();
    await expect(window).toHaveTitle('Distiller Booklet');
  } finally {
    await app.close();
  }
});

test('starting the app opens one dark English launchpad', async () => {
  const { app, window } = await launchApp();
  try {
    expect(app.windows()).toHaveLength(1);
    await expect(window.locator('html')).toHaveAttribute('lang', 'en');
    await expect(window).toHaveTitle('Book Distiller');
    await expect(window.getByText('Drop a PDF')).toBeVisible();
    const background = await window.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(relativeLuminance(background)).toBeLessThan(0.05);
  } finally {
    await app.close();
  }
});
