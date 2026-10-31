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

function radiusAtMost8(radius: string): boolean {
  return radius
    .split(' ')
    .filter((part) => part.length > 0)
    .every((part) => Number.parseFloat(part) <= 8);
}

test('the window uses a solid dark surface', async () => {
  const { app, window } = await launchApp();
  try {
    await expect(window.getByText('Drop a PDF')).toBeVisible();
    const surface = await window.evaluate(() => {
      const root = document.getElementById('root');
      const label = [...document.querySelectorAll('body *')].find((element) => element.textContent === 'Drop a PDF');
      const target = label?.closest('.drop') ?? null;
      const button = document.querySelector('button');
      if (!root || !target || !button) {
        throw new Error('missing surface');
      }
      function read(element: Element): { radius: string; blur: string; background: string } {
        const style = getComputedStyle(element);
        return {
          radius: style.borderRadius,
          blur: style.backdropFilter,
          background: style.backgroundColor,
        };
      }
      return { root: read(root), drop: read(target), button: read(button) };
    });
    expect(['rgb(9, 9, 11)', 'rgba(9, 9, 11, 1)']).toContain(surface.root.background);
    expect(surface.root.blur).not.toContain('blur');
    for (const item of [surface.drop, surface.button]) {
      expect(radiusAtMost8(item.radius)).toBe(true);
      expect(item.blur).not.toContain('blur');
    }
  } finally {
    await app.close();
  }
});
