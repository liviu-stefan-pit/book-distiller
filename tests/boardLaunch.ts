import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const electronPath = require('electron') as string;

export const secret = 'cursor-test-key-alpha';
export const example = 'During the outage the log still held the write, and memory did not.';

export async function openSettings(window: Page): Promise<void> {
  const dialog = window.getByRole('dialog', { name: 'Settings' });
  if (!(await dialog.isVisible())) {
    await window.getByRole('button', { name: 'Settings' }).click();
  }
  await expect(dialog).toBeVisible();
}

export function numberedRuleBoard(): unknown {
  return {
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
        example: { text: example, page: 2 },
      },
    ],
    code: [],
  };
}

export async function launchReady(
  dir: string,
  extraEnv: Record<string, string>,
): Promise<{ app: ElectronApplication; window: Page; folder: string }> {
  const userData = path.join(dir, 'user-data');
  const catalogFile = path.join(dir, 'catalog.json');
  const folder = path.join(dir, 'book');
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
  await window.locator('input[type=file]').setInputFiles(path.join(process.cwd(), 'fixtures/booklet.pdf'));
  await expect(window.getByText('Distiller Booklet')).toBeVisible();
  await openSettings(window);
  await window.getByLabel('Cursor key').fill(secret);
  await openSettings(window);
  await window.getByRole('button', { name: 'Save' }).click();
  await openSettings(window);
  await window.getByRole('combobox', { name: 'Model' }).selectOption('north-model');
  await app.evaluate(({ dialog }, chosen: string) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] });
  }, folder);
  await openSettings(window);
  await window.getByRole('button', { name: 'Choose a folder' }).click();
  await openSettings(window);
  await expect(window.getByText(folder)).toBeVisible();
  await window.getByRole('button', { name: 'Start' }).click();
  await expect(window.getByRole('dialog', { name: 'Slices' })).toBeVisible();
  await expect(window.getByRole('button', { name: 'Confirm' })).toBeEnabled();
  return { app, window, folder };
}
