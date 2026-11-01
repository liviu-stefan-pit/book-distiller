import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openSettings, parameterizedCatalog } from './boardLaunch';

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
    await expect(window.getByText('Choose a PDF')).toBeVisible();
    await expect(window.getByRole('button', { name: 'Start' })).toBeVisible();
    await expect(window.getByLabel('Cursor key')).toHaveCount(0);
    await expect(window.getByRole('combobox', { name: 'Model' })).toHaveCount(0);
    await expect(window.getByRole('button', { name: 'Choose a folder' })).toHaveCount(0);
    await expect(window.getByRole('region', { name: 'Viewer' })).toHaveCount(0);
    await openSettings(window);
    await expect(window.getByLabel('Cursor key')).toBeVisible();
    await openSettings(window);
    await window.getByLabel('Cursor key').fill(secret);
    await openSettings(window);
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
    await openSettings(window);
    await expect(window.getByLabel('Cursor key')).toBeVisible();
    await openSettings(window);
    await window.getByLabel('Cursor key').fill(secret);
    await openSettings(window);
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
    await openSettings(window);
    await window.getByLabel('Cursor key').fill(secret);
    await openSettings(window);
    await window.getByRole('button', { name: 'Save' }).click();
    await openSettings(window);
    await window.getByRole('combobox', { name: 'Model' }).selectOption('north-model');
    await openSettings(window);
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
    await openSettings(window);
    await window.getByLabel('Cursor key').fill(secret);
    await openSettings(window);
    await window.getByRole('button', { name: 'Save' }).click();
    await openSettings(window);
    await window.getByRole('combobox', { name: 'Model' }).selectOption('north-model');
    await writeFile(catalogFile, JSON.stringify({ error: 'That key was refused.' }));
    await openSettings(window);
    await window.getByRole('button', { name: 'Replace key' }).click();
    await expect(window.getByLabel('Cursor key')).toBeVisible();
    await openSettings(window);
    await window.getByLabel('Cursor key').fill('cursor-test-key-beta');
    await openSettings(window);
    await window.getByRole('button', { name: 'Save' }).click();
    await expect(window.getByText('That key was refused.')).toBeVisible();
    await expect(window.getByRole('option', { name: 'north-model' })).toHaveCount(1);
    await expect(window.getByRole('option', { name: 'south-model' })).toHaveCount(1);
    await openSettings(window);
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
  const broken = path.join(dir, 'broken');
  await mkdir(userData);
  await mkdir(occupied);
  await writeFile(path.join(occupied, 'notes.txt'), 'hello');
  await mkdir(empty);
  await mkdir(broken);
  await writeFile(path.join(broken, 'book-manifest.json'), '{');
  const { app, window } = await launchApp(userData, catalogFile);
  const start = window.getByRole('button', { name: 'Start' });
  const unreadable = 'This book folder could not be read.';
  try {
    await expect(start).toBeDisabled();
    await window.locator('input[type=file]').setInputFiles(path.join(process.cwd(), 'fixtures/booklet.pdf'));
    await expect(window.getByText('Distiller Booklet')).toBeVisible();
    await expect(start).toBeDisabled();
    await openSettings(window);
    await window.getByLabel('Cursor key').fill(secret);
    await openSettings(window);
    await window.getByRole('button', { name: 'Save' }).click();
    await expect(start).toBeDisabled();

    await app.evaluate(({ dialog }, chosen: string) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] });
    }, empty);
    await openSettings(window);
    await window.getByRole('button', { name: 'Choose a folder' }).click();
    await openSettings(window);
    await expect(window.getByText(empty)).toBeVisible();
    await expect(start).toBeDisabled();

    await app.evaluate(({ dialog }, chosen: string) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] });
    }, occupied);
    await openSettings(window);
    await window.getByRole('button', { name: 'Choose a folder' }).click();
    await expect(window.getByText(unreadable)).toHaveCount(0);
    await openSettings(window);
    await expect(window.getByText(occupied)).toBeVisible();
    await expect(start).toBeDisabled();

    await openSettings(window);
    await window.getByRole('combobox', { name: 'Model' }).selectOption('north-model');
    await expect(start).toBeEnabled();

    await app.evaluate(({ dialog }, chosen: string) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] });
    }, broken);
    await openSettings(window);
    await window.getByRole('button', { name: 'Choose a folder' }).click();
    await expect(window.getByText(unreadable)).toBeVisible();
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
      await openSettings(first.window);
      await first.window.getByLabel('Cursor key').fill(secret);
      await openSettings(first.window);
      await first.window.getByRole('button', { name: 'Save' }).click();
      await openSettings(first.window);
      await first.window.getByRole('combobox', { name: 'Model' }).selectOption('north-model');
      await first.app.evaluate(({ dialog }, chosen: string) => {
        dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] });
      }, folder);
      await openSettings(first.window);
      await first.window.getByRole('button', { name: 'Choose a folder' }).click();
      await openSettings(first.window);
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
      await openSettings(second.window);
      await expect(second.window.getByText(folder)).toBeVisible();
      await openSettings(second.window);
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
      await openSettings(first.window);
      await first.window.getByLabel('Cursor key').fill(secret);
      await openSettings(first.window);
      await first.window.getByRole('button', { name: 'Save' }).click();
      await openSettings(first.window);
      await first.window.getByRole('combobox', { name: 'Model' }).selectOption('north-model');
      await first.app.evaluate(({ dialog }, chosen: string) => {
        dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] });
      }, folder);
      await openSettings(first.window);
      await first.window.getByRole('button', { name: 'Choose a folder' }).click();
      await openSettings(first.window);
      await expect(first.window.getByText(folder)).toBeVisible();
    } finally {
      await first.app.close();
    }
    const second = await launchApp(userData, catalogFile, { BOOK_DISTILLER_SESSION_DELAY_MS: '2000' });
    try {
      await openSettings(second.window);
      await expect(second.window.getByRole('button', { name: 'Choose a folder' })).toBeVisible();
      await second.app.evaluate(({ dialog }, chosen: string) => {
        dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] });
      }, other);
      await openSettings(second.window);
      await second.window.getByRole('button', { name: 'Choose a folder' }).click();
      await openSettings(second.window);
      await expect(second.window.getByRole('button', { name: 'Replace key' })).toBeVisible();
      await openSettings(second.window);
      await expect(second.window.getByText(other)).toBeVisible();
      await openSettings(second.window);
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
      await openSettings(first.window);
      await first.window.getByLabel('Cursor key').fill(secret);
      await openSettings(first.window);
      await first.window.getByRole('button', { name: 'Save' }).click();
      await openSettings(first.window);
      await first.window.getByRole('combobox', { name: 'Model' }).selectOption('north-model');
      await first.app.evaluate(({ dialog }, chosen: string) => {
        dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] });
      }, folder);
      await openSettings(first.window);
      await first.window.getByRole('button', { name: 'Choose a folder' }).click();
      await openSettings(first.window);
      await expect(first.window.getByText(folder)).toBeVisible();
    } finally {
      await first.app.close();
    }
    await writeFile(catalogFile, JSON.stringify({ error: 'That key was refused.' }));
    const second = await launchApp(userData, catalogFile, { BOOK_DISTILLER_SESSION_DELAY_MS: '2000' });
    try {
      await openSettings(second.window);
      await second.window.getByLabel('Cursor key').fill('cursor-test-key-beta');
      await openSettings(second.window);
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
      await openSettings(first.window);
      await first.window.getByLabel('Cursor key').fill(secret);
      await openSettings(first.window);
      await first.window.getByRole('button', { name: 'Save' }).click();
      await openSettings(first.window);
      await first.window.getByRole('combobox', { name: 'Model' }).selectOption('north-model');
      await first.app.evaluate(({ dialog }, chosen: string) => {
        dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] });
      }, folder);
      await openSettings(first.window);
      await first.window.getByRole('button', { name: 'Choose a folder' }).click();
      await openSettings(first.window);
      await expect(first.window.getByText(folder)).toBeVisible();
    } finally {
      await first.app.close();
    }
    const second = await launchApp(userData, catalogFile, { BOOK_DISTILLER_SESSION: 'fail' });
    try {
      await openSettings(second.window);
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
    await openSettings(first.window);
    await first.window.getByLabel('Cursor key').fill(secret);
    await openSettings(first.window);
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
    await openSettings(second.window);
    await expect(second.window.getByLabel('Cursor key')).toBeVisible();
    await expect(second.window.getByRole('button', { name: 'Forget key' })).toHaveCount(0);
  } finally {
    await second.app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function readStoredSelection(userData: string): Promise<{ modelId?: string; modelParams?: unknown }> {
  return JSON.parse(await readFile(path.join(userData, 'settings.json'), 'utf8')) as {
    modelId?: string;
    modelParams?: unknown;
  };
}

test('a parameterized model shows its effort and fast controls at the default variant', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const catalogFile = path.join(dir, 'catalog.json');
  await writeFile(catalogFile, JSON.stringify(parameterizedCatalog));
  const userData = path.join(dir, 'user-data');
  await mkdir(userData);
  const { app, window } = await launchApp(userData, catalogFile);
  try {
    await openSettings(window);
    await window.getByLabel('Cursor key').fill(secret);
    await openSettings(window);
    await window.getByRole('button', { name: 'Save' }).click();
    await openSettings(window);
    await expect(window.getByRole('option', { name: 'Effort Model' })).toHaveCount(1);
    await expect(window.getByRole('option', { name: 'Plain Model' })).toHaveCount(1);
    await window.getByRole('combobox', { name: 'Model' }).selectOption('effort-model');
    const effort = window.getByRole('combobox', { name: 'Effort', exact: true });
    const fast = window.getByRole('checkbox', { name: 'Fast' });
    await expect(effort).toHaveValue('high');
    await expect(effort.getByRole('option', { name: 'Low' })).toHaveCount(1);
    await expect(effort.getByRole('option', { name: 'High' })).toHaveCount(1);
    await expect(fast).toBeChecked();
    await openSettings(window);
    await window.getByRole('combobox', { name: 'Model' }).selectOption('plain-model');
    await expect(window.getByRole('combobox', { name: 'Effort', exact: true })).toHaveCount(0);
    await expect(window.getByRole('checkbox', { name: 'Fast' })).toHaveCount(0);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a relaunch remembers the chosen effort and fast values', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const catalogFile = path.join(dir, 'catalog.json');
  await writeFile(catalogFile, JSON.stringify(parameterizedCatalog));
  const userData = path.join(dir, 'user-data');
  await mkdir(userData);
  const first = await launchApp(userData, catalogFile);
  try {
    try {
      await openSettings(first.window);
      await first.window.getByLabel('Cursor key').fill(secret);
      await openSettings(first.window);
      await first.window.getByRole('button', { name: 'Save' }).click();
      await openSettings(first.window);
      await first.window.getByRole('combobox', { name: 'Model' }).selectOption('effort-model');
      await first.window.getByRole('combobox', { name: 'Effort', exact: true }).selectOption('low');
      await first.window.getByRole('checkbox', { name: 'Fast' }).uncheck();
      await expect.poll(async () => (await readStoredSelection(userData)).modelParams).toEqual([
        { id: 'effort', value: 'low' },
        { id: 'fast', value: 'false' },
      ]);
    } finally {
      await first.app.close();
    }
    const second = await launchApp(userData, catalogFile);
    try {
      await openSettings(second.window);
      await expect(second.window.getByRole('combobox', { name: 'Model' })).toHaveValue('effort-model');
      await expect(second.window.getByRole('combobox', { name: 'Effort', exact: true })).toHaveValue('low');
      await expect(second.window.getByRole('checkbox', { name: 'Fast' })).not.toBeChecked();
    } finally {
      await second.app.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('saved params that the catalog does not allow fall back to the default variant', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const catalogFile = path.join(dir, 'catalog.json');
  const userData = path.join(dir, 'user-data');
  await writeFile(catalogFile, JSON.stringify(parameterizedCatalog));
  await mkdir(userData);
  await writeFile(
    path.join(userData, 'settings.json'),
    JSON.stringify({
      modelId: 'effort-model',
      modelParams: [
        { id: 'effort', value: 'nope' },
        { id: 'fast', value: 'maybe' },
      ],
      folderPath: '',
    }),
  );
  await writeFile(path.join(userData, 'memory-vault.json'), JSON.stringify({ key: secret }));
  const { app, window } = await launchApp(userData, catalogFile);
  try {
    await openSettings(window);
    await expect(window.getByRole('combobox', { name: 'Model' })).toHaveValue('effort-model');
    await expect(window.getByRole('combobox', { name: 'Effort', exact: true })).toHaveValue('high');
    await expect(window.getByRole('checkbox', { name: 'Fast' })).toBeChecked();
    await expect.poll(async () => (await readStoredSelection(userData)).modelParams).toEqual([
      { id: 'effort', value: 'high' },
      { id: 'fast', value: 'true' },
    ]);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
