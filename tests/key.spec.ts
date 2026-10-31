import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const electronPath = require('electron') as string;
const secret = 'cursor-test-key-alpha';

async function launchApp(
  userData: string,
  catalogFile: string,
  extraEnv: Record<string, string> = {},
): Promise<{ app: ElectronApplication; window: Page }> {
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

test('a saved key lists the catalog models and hides the key', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const catalogFile = path.join(dir, 'catalog.json');
  await writeFile(catalogFile, JSON.stringify({ models: ['north-model', 'south-model'] }));
  const userData = path.join(dir, 'user-data');
  await mkdir(userData);
  const { app, window } = await launchApp(userData, catalogFile);
  try {
    await expect(window.getByText('Drop a PDF')).toBeVisible();
    await expect(window.getByLabel('Cursor key')).toBeVisible();
    await window.getByLabel('Cursor key').fill(secret);
    await window.getByRole('button', { name: 'Save' }).click();
    await expect(window.getByRole('option', { name: 'north-model' })).toHaveCount(1);
    await expect(window.getByRole('option', { name: 'south-model' })).toHaveCount(1);
    await expect(window.getByRole('button', { name: 'Replace key' })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Forget key' })).toBeVisible();
    await expect(window.getByLabel('Cursor key')).toHaveCount(0);
    const leaked = await window.evaluate((key) => {
      const values = [...document.querySelectorAll('input, textarea')].map((element) =>
        element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : '',
      );
      return document.documentElement.outerHTML.includes(key) || values.some((value) => value.includes(key));
    }, secret);
    expect(leaked).toBe(false);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a refused key stays in the paste field and shows the error', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const catalogFile = path.join(dir, 'catalog.json');
  await writeFile(catalogFile, JSON.stringify({ error: 'That key was refused.' }));
  const userData = path.join(dir, 'user-data');
  await mkdir(userData);
  const { app, window } = await launchApp(userData, catalogFile);
  try {
    await expect(window.getByLabel('Cursor key')).toBeVisible();
    await window.getByLabel('Cursor key').fill(secret);
    await window.getByRole('button', { name: 'Save' }).click();
    await expect(window.getByText('That key was refused.')).toBeVisible();
    await expect(window.getByLabel('Cursor key')).toHaveValue(secret);
    await expect(window.getByRole('button', { name: 'Replace key' })).toHaveCount(0);
    await expect(window.getByRole('option', { name: 'north-model' })).toHaveCount(0);
    await expect(window.getByRole('option', { name: 'south-model' })).toHaveCount(0);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('forget key brings back the paste field and removes the models', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const catalogFile = path.join(dir, 'catalog.json');
  await writeFile(catalogFile, JSON.stringify({ models: ['north-model', 'south-model'] }));
  const userData = path.join(dir, 'user-data');
  await mkdir(userData);
  const { app, window } = await launchApp(userData, catalogFile);
  try {
    await window.getByLabel('Cursor key').fill(secret);
    await window.getByRole('button', { name: 'Save' }).click();
    await window.getByRole('combobox', { name: 'Model' }).selectOption('north-model');
    await window.getByRole('button', { name: 'Forget key' }).click();
    await expect(window.getByLabel('Cursor key')).toBeVisible();
    await expect(window.getByLabel('Cursor key')).toHaveValue('');
    await expect(window.getByRole('option', { name: 'north-model' })).toHaveCount(0);
    await expect(window.getByRole('option', { name: 'south-model' })).toHaveCount(0);
    await expect(window.getByRole('button', { name: 'Replace key' })).toHaveCount(0);
    await expect(window.getByRole('button', { name: 'Forget key' })).toHaveCount(0);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a refused replacement keeps the saved models and the chosen model', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const catalogFile = path.join(dir, 'catalog.json');
  await writeFile(catalogFile, JSON.stringify({ models: ['north-model', 'south-model'] }));
  const userData = path.join(dir, 'user-data');
  await mkdir(userData);
  const { app, window } = await launchApp(userData, catalogFile);
  try {
    await window.getByLabel('Cursor key').fill(secret);
    await window.getByRole('button', { name: 'Save' }).click();
    await window.getByRole('combobox', { name: 'Model' }).selectOption('north-model');
    await writeFile(catalogFile, JSON.stringify({ error: 'That key was refused.' }));
    await window.getByRole('button', { name: 'Replace key' }).click();
    await expect(window.getByLabel('Cursor key')).toBeVisible();
    await window.getByLabel('Cursor key').fill('cursor-test-key-beta');
    await window.getByRole('button', { name: 'Save' }).click();
    await expect(window.getByText('That key was refused.')).toBeVisible();
    await expect(window.getByRole('option', { name: 'north-model' })).toHaveCount(1);
    await expect(window.getByRole('option', { name: 'south-model' })).toHaveCount(1);
    await expect(window.getByRole('combobox', { name: 'Model' })).toHaveValue('north-model');
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('start stays off until the pdf, key, model, and folder are set', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const catalogFile = path.join(dir, 'catalog.json');
  await writeFile(catalogFile, JSON.stringify({ models: ['north-model', 'south-model'] }));
  const userData = path.join(dir, 'user-data');
  const occupied = path.join(dir, 'occupied');
  const empty = path.join(dir, 'empty');
  await mkdir(userData);
  await mkdir(occupied);
  await writeFile(path.join(occupied, 'notes.txt'), 'hello');
  await mkdir(empty);
  const { app, window } = await launchApp(userData, catalogFile);
  const start = window.getByRole('button', { name: 'Start' });
  const refusal = "Choose an empty folder or this book's folder.";
  try {
    await expect(start).toBeDisabled();
    await window.locator('input[type=file]').setInputFiles(path.join(process.cwd(), 'fixtures/booklet.pdf'));
    await expect(window.getByText('Distiller Booklet')).toBeVisible();
    await expect(start).toBeDisabled();
    await window.getByLabel('Cursor key').fill(secret);
    await window.getByRole('button', { name: 'Save' }).click();
    await expect(start).toBeDisabled();

    await app.evaluate(({ dialog }, chosen: string) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] });
    }, empty);
    await window.getByRole('button', { name: 'Choose a folder' }).click();
    await expect(window.getByText(empty)).toBeVisible();
    await expect(start).toBeDisabled();

    await app.evaluate(({ dialog }, chosen: string) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] });
    }, occupied);
    await window.getByRole('button', { name: 'Choose a folder' }).click();
    await expect(window.getByText(refusal)).toBeVisible();
    await expect(start).toBeDisabled();

    await app.evaluate(({ dialog }, chosen: string) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] });
    }, empty);
    await window.getByRole('button', { name: 'Choose a folder' }).click();
    await expect(window.getByText(refusal)).toHaveCount(0);
    await expect(window.getByText(empty)).toBeVisible();
    await expect(start).toBeDisabled();

    await window.getByRole('combobox', { name: 'Model' }).selectOption('north-model');
    await expect(start).toBeEnabled();

    await app.evaluate(({ dialog }, chosen: string) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] });
    }, occupied);
    await window.getByRole('button', { name: 'Choose a folder' }).click();
    await expect(window.getByText(refusal)).toBeVisible();
    await expect(start).toBeDisabled();
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a relaunch remembers the folder and model without reading the catalog', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const catalogFile = path.join(dir, 'catalog.json');
  const userData = path.join(dir, 'user-data');
  const folder = path.join(dir, 'notes');
  const booklet = path.join(process.cwd(), 'fixtures/booklet.pdf');
  await writeFile(catalogFile, JSON.stringify({ models: ['north-model', 'south-model'] }));
  await mkdir(userData);
  await mkdir(folder);
  const first = await launchApp(userData, catalogFile);
  try {
    try {
      await first.window.getByLabel('Cursor key').fill(secret);
      await first.window.getByRole('button', { name: 'Save' }).click();
      await first.window.getByRole('combobox', { name: 'Model' }).selectOption('north-model');
      await first.app.evaluate(({ dialog }, chosen: string) => {
        dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] });
      }, folder);
      await first.window.getByRole('button', { name: 'Choose a folder' }).click();
      await expect(first.window.getByText(folder)).toBeVisible();
    } finally {
      await first.app.close();
    }
    await rm(catalogFile);
    const second = await launchApp(userData, catalogFile);
    try {
      await expect(second.window.getByText('Drop a PDF')).toBeVisible();
      await dropPdf(second.window, booklet, 'booklet.pdf');
      await expect(second.window.getByText('Distiller Booklet')).toBeVisible();
      await expect(second.window.getByText(folder)).toBeVisible();
      await expect(second.window.getByRole('combobox', { name: 'Model' })).toHaveValue('north-model');
      await expect(second.window.getByRole('button', { name: 'Start' })).toBeEnabled();
      const leaked = await second.window.evaluate((key) => {
        const values = [...document.querySelectorAll('input, textarea')].map((element) =>
          element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : '',
        );
        return document.documentElement.outerHTML.includes(key) || values.some((value) => value.includes(key));
      }, secret);
      expect(leaked).toBe(false);
    } finally {
      await second.app.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('choosing a folder while the session loads keeps the saved key and model', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const catalogFile = path.join(dir, 'catalog.json');
  const userData = path.join(dir, 'user-data');
  const folder = path.join(dir, 'notes');
  const other = path.join(dir, 'other');
  await writeFile(catalogFile, JSON.stringify({ models: ['north-model', 'south-model'] }));
  await mkdir(userData);
  await mkdir(folder);
  await mkdir(other);
  const first = await launchApp(userData, catalogFile);
  try {
    try {
      await first.window.getByLabel('Cursor key').fill(secret);
      await first.window.getByRole('button', { name: 'Save' }).click();
      await first.window.getByRole('combobox', { name: 'Model' }).selectOption('north-model');
      await first.app.evaluate(({ dialog }, chosen: string) => {
        dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] });
      }, folder);
      await first.window.getByRole('button', { name: 'Choose a folder' }).click();
      await expect(first.window.getByText(folder)).toBeVisible();
    } finally {
      await first.app.close();
    }
    const second = await launchApp(userData, catalogFile, { BOOK_DISTILLER_SESSION_DELAY_MS: '2000' });
    try {
      await expect(second.window.getByRole('button', { name: 'Choose a folder' })).toBeVisible();
      await second.app.evaluate(({ dialog }, chosen: string) => {
        dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] });
      }, other);
      await second.window.getByRole('button', { name: 'Choose a folder' }).click();
      await expect(second.window.getByRole('button', { name: 'Replace key' })).toBeVisible();
      await expect(second.window.getByText(other)).toBeVisible();
      await expect(second.window.getByRole('combobox', { name: 'Model' })).toHaveValue('north-model');
      const leaked = await second.window.evaluate((key) => {
        const values = [...document.querySelectorAll('input, textarea')].map((element) =>
          element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : '',
        );
        return document.documentElement.outerHTML.includes(key) || values.some((value) => value.includes(key));
      }, secret);
      expect(leaked).toBe(false);
    } finally {
      await second.app.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a refused save during session load keeps the stored key and shows the error', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const catalogFile = path.join(dir, 'catalog.json');
  const userData = path.join(dir, 'user-data');
  const folder = path.join(dir, 'notes');
  await writeFile(catalogFile, JSON.stringify({ models: ['north-model', 'south-model'] }));
  await mkdir(userData);
  await mkdir(folder);
  const first = await launchApp(userData, catalogFile);
  try {
    try {
      await first.window.getByLabel('Cursor key').fill(secret);
      await first.window.getByRole('button', { name: 'Save' }).click();
      await first.window.getByRole('combobox', { name: 'Model' }).selectOption('north-model');
      await first.app.evaluate(({ dialog }, chosen: string) => {
        dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] });
      }, folder);
      await first.window.getByRole('button', { name: 'Choose a folder' }).click();
      await expect(first.window.getByText(folder)).toBeVisible();
    } finally {
      await first.app.close();
    }
    await writeFile(catalogFile, JSON.stringify({ error: 'That key was refused.' }));
    const second = await launchApp(userData, catalogFile, { BOOK_DISTILLER_SESSION_DELAY_MS: '2000' });
    try {
      await second.window.getByLabel('Cursor key').fill('cursor-test-key-beta');
      await second.window.getByRole('button', { name: 'Save' }).click();
      await expect(second.window.getByText('That key was refused.')).toBeVisible();
      await expect(second.window.getByRole('button', { name: 'Replace key' })).toBeVisible();
      await expect(second.window.getByRole('button', { name: 'Forget key' })).toBeVisible();
      await expect(second.window.getByRole('option', { name: 'north-model' })).toHaveCount(1);
      await expect(second.window.getByRole('option', { name: 'south-model' })).toHaveCount(1);
      await expect(second.window.getByText('That key was refused.')).toBeVisible();
    } finally {
      await second.app.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a failed session read shows that the saved key could not be read', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const catalogFile = path.join(dir, 'catalog.json');
  const userData = path.join(dir, 'user-data');
  const folder = path.join(dir, 'notes');
  await writeFile(catalogFile, JSON.stringify({ models: ['north-model', 'south-model'] }));
  await mkdir(userData);
  await mkdir(folder);
  const first = await launchApp(userData, catalogFile);
  try {
    try {
      await first.window.getByLabel('Cursor key').fill(secret);
      await first.window.getByRole('button', { name: 'Save' }).click();
      await first.window.getByRole('combobox', { name: 'Model' }).selectOption('north-model');
      await first.app.evaluate(({ dialog }, chosen: string) => {
        dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] });
      }, folder);
      await first.window.getByRole('button', { name: 'Choose a folder' }).click();
      await expect(first.window.getByText(folder)).toBeVisible();
    } finally {
      await first.app.close();
    }
    const second = await launchApp(userData, catalogFile, { BOOK_DISTILLER_SESSION: 'fail' });
    try {
      await expect(second.window.getByText('The saved key could not be read.')).toBeVisible();
    } finally {
      await second.app.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a settings failure after the vault write leaves no key', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const catalogFile = path.join(dir, 'catalog.json');
  const userData = path.join(dir, 'user-data');
  await writeFile(catalogFile, JSON.stringify({ models: ['north-model', 'south-model'] }));
  await mkdir(userData);
  const first = await launchApp(userData, catalogFile, { BOOK_DISTILLER_SETTINGS_FAIL: '1' });
  try {
    await first.window.getByLabel('Cursor key').fill(secret);
    await first.window.getByRole('button', { name: 'Save' }).click();
    await expect(first.window.getByText('The key could not be saved.')).toBeVisible();
    await expect(first.window.getByRole('button', { name: 'Forget key' })).toHaveCount(0);
  } finally {
    await first.app.close();
  }
  const second = await launchApp(userData, catalogFile);
  try {
    await expect
      .poll(() => second.window.evaluate(async () => (await window.bookDistiller.session()).hasKey))
      .toBe(false);
    await expect(second.window.getByLabel('Cursor key')).toBeVisible();
    await expect(second.window.getByRole('button', { name: 'Forget key' })).toHaveCount(0);
  } finally {
    await second.app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
