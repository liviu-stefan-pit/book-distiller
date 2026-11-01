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

/** One model with an Effort select and a Fast flag, whose default variant is high and fast, and one plain model. */
export const parameterizedCatalog = {
  models: [
    {
      id: 'effort-model',
      displayName: 'Effort Model',
      parameters: [
        {
          id: 'effort',
          displayName: 'Effort',
          values: [
            { value: 'low', displayName: 'Low' },
            { value: 'high', displayName: 'High' },
          ],
        },
        { id: 'fast', displayName: 'Fast', values: [{ value: 'false' }, { value: 'true' }] },
      ],
      variants: [
        {
          params: [
            { id: 'effort', value: 'low' },
            { id: 'fast', value: 'false' },
          ],
          displayName: 'Low',
        },
        {
          params: [
            { id: 'effort', value: 'high' },
            { id: 'fast', value: 'true' },
          ],
          displayName: 'High fast',
          isDefault: true,
        },
      ],
    },
    { id: 'plain-model', displayName: 'Plain Model', parameters: [], variants: [] },
  ],
};

export type ReadyOptions = {
  /** The catalog file body. Defaults to the north and south string models. */
  catalog?: unknown;
  /** The model to choose. Defaults to north-model. */
  modelId?: string;
  /** Runs right after the model is chosen, with Settings open. */
  afterModel?: (window: Page) => Promise<void>;
};

export async function launchReady(
  dir: string,
  extraEnv: Record<string, string>,
  options: ReadyOptions = {},
): Promise<{ app: ElectronApplication; window: Page; folder: string }> {
  const userData = path.join(dir, 'user-data');
  const catalogFile = path.join(dir, 'catalog.json');
  const output = path.join(dir, 'book');
  const folder = path.join(output, 'Distiller Booklet');
  await mkdir(userData);
  await mkdir(output);
  await writeFile(catalogFile, JSON.stringify(options.catalog ?? { models: ['north-model', 'south-model'] }));
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
  await window.locator('input[type=file]').setInputFiles(path.join(process.cwd(), 'fixtures/booklet.pdf'));
  await expect(window.getByText('Distiller Booklet')).toBeVisible();
  await openSettings(window);
  await window.getByLabel('Cursor key').fill(secret);
  await openSettings(window);
  await window.getByRole('button', { name: 'Save' }).click();
  await openSettings(window);
  await window.getByRole('combobox', { name: 'Model' }).selectOption(options.modelId ?? 'north-model');
  if (options.afterModel) {
    await options.afterModel(window);
  }
  await app.evaluate(({ dialog }, chosen: string) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] });
  }, output);
  await openSettings(window);
  await window.getByRole('button', { name: 'Choose a folder' }).click();
  await openSettings(window);
  await expect(window.getByText(output)).toBeVisible();
  await window.getByRole('button', { name: 'Start' }).click();
  await expect(window.getByRole('dialog', { name: 'Slices' })).toBeVisible();
  await expect(window.getByRole('button', { name: 'Confirm' })).toBeEnabled();
  return { app, window, folder };
}
