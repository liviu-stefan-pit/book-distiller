import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
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

test('the launchpad shows viking-night page, text, and heading colors', async () => {
  const { app, window } = await launchApp();
  try {
    await expect(window.getByRole('heading', { level: 1 })).toBeVisible();
    const colors = await window.evaluate(() => {
      const heading = document.querySelector('h1');
      if (!heading) {
        throw new Error('missing heading');
      }
      const body = getComputedStyle(document.body);
      return {
        background: body.backgroundColor,
        color: body.color,
        heading: getComputedStyle(heading).color,
      };
    });
    expect(colors.background).toBe('rgb(22, 29, 34)');
    expect(colors.color).toBe('rgb(231, 226, 214)');
    expect(colors.heading).toBe('rgb(235, 203, 139)');
  } finally {
    await app.close();
  }
});
