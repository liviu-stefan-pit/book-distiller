import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { requiredListings } from '../src/main/listings';
import { example, launchReady, numberedRuleBoard, openSettings, secret } from './boardLaunch';

const electronPath = createRequire(import.meta.url)('electron') as string;

async function workspaceText(dir: string): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  const parts: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      parts.push(await workspaceText(full));
    } else if (!entry.name.endsWith('.jpg')) {
      parts.push(await readFile(full, 'utf8'));
    }
  }
  return parts.join('\n');
}

test('confirm writes the checked numbered-rule slice', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const agentFile = path.join(dir, 'agent.json');
  const agentLog = path.join(dir, 'agent.log');
  await writeFile(agentFile, JSON.stringify({ replies: [`Board follows.\n${JSON.stringify(numberedRuleBoard())}`] }));
  const { app, window, folder } = await launchReady(dir, {
    BOOK_DISTILLER_AGENT_FILE: agentFile,
    BOOK_DISTILLER_AGENT_LOG: agentLog,
    BOOK_DISTILLER_WORK_ROOT: path.join(dir, 'work'),
  });
  try {
    await window.getByRole('listitem').filter({ hasText: 'A listing' }).getByRole('checkbox').click();
    await window.getByRole('button', { name: 'Confirm' }).click();
    await expect(window.getByRole('region', { name: 'Viewer' })).toBeVisible();
    await expect(window.getByText('Flush the log before memory')).toBeVisible();
    await expect(window.getByText(example)).toBeVisible();
    const board = await readFile(path.join(folder, 'boards', 'a-numbered-rule.board.json'), 'utf8');
    expect(Object.keys(JSON.parse(board) as Record<string, unknown>)).not.toContain('figures');
    await readFile(path.join(folder, 'notes', 'a-numbered-rule.md'), 'utf8');
    await expect(access(path.join(folder, 'boards', 'a-listing.board.json'))).rejects.toThrow();
    expect((await readFile(agentLog, 'utf8')).trim()).toBe(
      '{"modelId":"north-model","sectionId":"a-numbered-rule"}',
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function listingBoard(source: string): unknown {
  return {
    schemaVersion: 1,
    sectionId: 'a-listing',
    sectionTitle: 'A listing',
    pageStart: 3,
    pageEnd: 4,
    points: [
      {
        kind: 'mechanics',
        title: 'Append the log before memory',
        explanation: 'The listing writes the log, then memory.',
        page: 3,
      },
    ],
    code: [
      {
        title: 'put',
        language: 'rust',
        page: 3,
        source,
        notes: [{ lines: '1', why: 'The log is appended before memory changes.' }],
      },
    ],
  };
}

test('the slice workspace holds the stamped text and the extraction instructions', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const agentFile = path.join(dir, 'agent.json');
  const work = path.join(dir, 'work');
  await writeFile(agentFile, JSON.stringify({ replies: [JSON.stringify(numberedRuleBoard())] }));
  const { app, window } = await launchReady(dir, {
    BOOK_DISTILLER_AGENT_FILE: agentFile,
    BOOK_DISTILLER_WORK_ROOT: work,
  });
  try {
    await window.getByRole('button', { name: 'Confirm' }).click();
    await expect(window.getByText(example)).toBeVisible();
    const text = await workspaceText(path.join(work, 'a-numbered-rule'));
    expect(text).toContain('--- PAGE 2 ---');
    expect(text).toContain('1. Flush the log before changing memory.');
    expect(text).toContain(
      'It keeps every technical rule, number, threshold, mechanism, edge case, and warning.',
    );
    expect(text.includes(secret)).toBe(false);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a reply that omits a listing is accepted on the first call and kept', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const agentFile = path.join(dir, 'agent.json');
  const agentLog = path.join(dir, 'agent.log');
  const work = path.join(dir, 'work');
  await writeFile(agentFile, JSON.stringify({ replies: [JSON.stringify(listingBoard('wal.append(key, val)?;'))] }));
  const { app, window, folder } = await launchReady(dir, {
    BOOK_DISTILLER_AGENT_FILE: agentFile,
    BOOK_DISTILLER_AGENT_LOG: agentLog,
    BOOK_DISTILLER_WORK_ROOT: work,
  });
  try {
    await window.getByRole('listitem').nth(1).getByRole('checkbox').click();
    await window.getByRole('button', { name: 'Confirm' }).click();
    await expect(window.getByText('wal.append(key, val)?;', { exact: true })).toBeVisible();
    await readFile(path.join(folder, 'boards', 'a-listing.board.json'), 'utf8');
    expect((await readFile(agentLog, 'utf8')).trim().split(/\n/)).toEqual([
      '{"modelId":"north-model","sectionId":"a-listing"}',
    ]);
    const section = path.join(work, 'a-listing');
    const names = (await readdir(section)).filter((name) => name.endsWith('.jpg')).sort();
    expect(names).toEqual(['page-3.jpg', 'page-4.jpg']);
    for (const name of names) {
      const jpeg = await readFile(path.join(section, name));
      expect(jpeg.subarray(0, 2).toString('hex')).toBe('ffd8');
      expect(jpeg.byteLength).toBeGreaterThan(100);
    }
    const imageLine = 'The attached images are PDF pages 3 through 4, in order. Image 1 is PDF page 3.';
    const prompt = await readFile(path.join(section, 'attempt-1.md'), 'utf8');
    expect(prompt).toContain(imageLine);
    expect(await readFile(path.join(section, 'instructions.md'), 'utf8')).toContain(imageLine);
    await expect(access(path.join(section, 'attempt-2.md'))).rejects.toThrow();
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('an omitted listing is accepted and kept', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const agentFile = path.join(dir, 'agent.json');
  await writeFile(
    agentFile,
    JSON.stringify({
      replies: [
        JSON.stringify(listingBoard('wal.append(key, val)?;')),
        JSON.stringify(listingBoard('wal.append(key, val)?;')),
      ],
    }),
  );
  const { app, window, folder } = await launchReady(dir, {
    BOOK_DISTILLER_AGENT_FILE: agentFile,
    BOOK_DISTILLER_WORK_ROOT: path.join(dir, 'work'),
  });
  try {
    await window.getByRole('listitem').nth(1).getByRole('checkbox').click();
    await window.getByRole('button', { name: 'Confirm' }).click();
    await expect(window.getByRole('region', { name: 'Viewer' })).toBeVisible();
    const row = window.getByRole('listitem').filter({ hasText: 'A listing' });
    await expect(row).toContainText('done');
    await expect(row).not.toContainText('failed');
    await expect(row).not.toContainText('missing listing');
    await readFile(path.join(folder, 'boards', 'a-listing.board.json'), 'utf8');
    await readFile(path.join(folder, 'notes', 'a-listing.md'), 'utf8');
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a wrong schema version fails the slice as shape', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const agentFile = path.join(dir, 'agent.json');
  const wrong = { ...(numberedRuleBoard() as Record<string, unknown>), schemaVersion: 2 };
  await writeFile(agentFile, JSON.stringify({ replies: [JSON.stringify(wrong), JSON.stringify(wrong)] }));
  const { app, window, folder } = await launchReady(dir, {
    BOOK_DISTILLER_AGENT_FILE: agentFile,
    BOOK_DISTILLER_WORK_ROOT: path.join(dir, 'work'),
  });
  try {
    await window.getByRole('listitem').nth(2).getByRole('checkbox').click();
    await window.getByRole('button', { name: 'Confirm' }).click();
    await expect(window.getByRole('region', { name: 'Viewer' })).toBeVisible();
    const row = window.getByRole('listitem');
    await expect(row).toContainText('failed');
    await expect(row).toContainText('shape');
    await expect(access(path.join(folder, 'boards', 'a-numbered-rule.board.json'))).rejects.toThrow();
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('an empty technical slice says those pages had no technical content', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const agentFile = path.join(dir, 'agent.json');
  const empty = {
    schemaVersion: 1,
    sectionId: 'a-numbered-rule',
    sectionTitle: 'A numbered rule',
    pageStart: 2,
    pageEnd: 2,
    points: [],
    code: [],
  };
  await writeFile(agentFile, JSON.stringify({ replies: [JSON.stringify(empty)] }));
  const { app, window, folder } = await launchReady(dir, {
    BOOK_DISTILLER_AGENT_FILE: agentFile,
    BOOK_DISTILLER_WORK_ROOT: path.join(dir, 'work'),
  });
  try {
    await window.getByRole('listitem').nth(2).getByRole('checkbox').click();
    await window.getByRole('button', { name: 'Confirm' }).click();
    await expect(window.getByText('Those pages had no technical content.', { exact: true })).toBeVisible();
    await readFile(path.join(folder, 'boards', 'a-numbered-rule.board.json'), 'utf8');
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('opening another done slice closes the page drawer', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const agentFile = path.join(dir, 'agent.json');
  await writeFile(
    agentFile,
    JSON.stringify({
      replies: [
        JSON.stringify(numberedRuleBoard()),
        JSON.stringify(listingBoard('wal.append(key, val)?;\nmem.put(key, val);')),
      ],
    }),
  );
  const { app, window } = await launchReady(dir, {
    BOOK_DISTILLER_AGENT_FILE: agentFile,
    BOOK_DISTILLER_WORK_ROOT: path.join(dir, 'work'),
  });
  try {
    await window.getByRole('button', { name: 'Confirm' }).click();
    await expect(window.getByRole('heading', { name: 'Append the log before memory' })).toBeVisible();
    await window.getByRole('button', { name: 'Page 3' }).first().click();
    await expect(window.getByRole('complementary', { name: 'Page 3' })).toBeVisible();
    await window.getByRole('button', { name: 'A numbered rule' }).click();
    await expect(window.getByRole('heading', { name: 'Flush the log before memory' })).toBeVisible();
    await expect(window.getByRole('complementary', { name: 'Page 3' })).toHaveCount(0);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a page citation opens that page and previous and next stay inside the slice', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const agentFile = path.join(dir, 'agent.json');
  await writeFile(agentFile, JSON.stringify({ replies: [JSON.stringify(numberedRuleBoard())] }));
  const { app, window } = await launchReady(dir, {
    BOOK_DISTILLER_AGENT_FILE: agentFile,
    BOOK_DISTILLER_WORK_ROOT: path.join(dir, 'work'),
  });
  try {
    await window.getByRole('button', { name: 'Confirm' }).click();
    await window.getByRole('button', { name: 'Page 2' }).first().click();
    const drawer = window.getByRole('complementary', { name: 'Page 2' });
    await expect(drawer).toBeVisible();
    await expect
      .poll(() => drawer.locator('canvas').evaluate((element) => (element as HTMLCanvasElement).width))
      .toBeGreaterThan(100);
    const fitted = await drawer.evaluate((element) => {
      const canvas = element.querySelector('canvas');
      if (!canvas) {
        return false;
      }
      return Math.abs(canvas.getBoundingClientRect().width - element.clientWidth) < 2;
    });
    expect(fitted).toBe(true);
    await drawer.getByRole('button', { name: 'Previous' }).click();
    await drawer.getByRole('button', { name: 'Next' }).click();
    await expect(window.getByRole('complementary', { name: 'Page 2' })).toBeVisible();
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a point with only a kind fails as shape', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const agentFile = path.join(dir, 'agent.json');
  const incomplete = {
    schemaVersion: 1,
    sectionId: 'a-numbered-rule',
    sectionTitle: 'A numbered rule',
    pageStart: 2,
    pageEnd: 2,
    points: [{ kind: 'must-remember' }],
    code: [],
  };
  await writeFile(agentFile, JSON.stringify({ replies: [JSON.stringify(incomplete), JSON.stringify(incomplete)] }));
  const { app, window, folder } = await launchReady(dir, {
    BOOK_DISTILLER_AGENT_FILE: agentFile,
    BOOK_DISTILLER_WORK_ROOT: path.join(dir, 'work'),
  });
  try {
    await window.getByRole('listitem').nth(2).getByRole('checkbox').click();
    await window.getByRole('button', { name: 'Confirm' }).click();
    await expect(window.getByRole('region', { name: 'Viewer' })).toBeVisible();
    const row = window.getByRole('listitem');
    await expect(row).toContainText('failed');
    await expect(row).toContainText('shape');
    await expect(window.getByText('Those pages had no technical content.')).toHaveCount(0);
    await expect(access(path.join(folder, 'boards', 'a-numbered-rule.board.json'))).rejects.toThrow();
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a point kind outside the three kinds fails as shape', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const agentFile = path.join(dir, 'agent.json');
  const summary = {
    schemaVersion: 1,
    sectionId: 'a-numbered-rule',
    sectionTitle: 'A numbered rule',
    pageStart: 2,
    pageEnd: 2,
    points: [
      {
        kind: 'summary',
        title: 'A summary the book did not classify',
        explanation: 'This kind is not one of the three.',
        page: 2,
      },
    ],
    code: [],
  };
  await writeFile(agentFile, JSON.stringify({ replies: [JSON.stringify(summary), JSON.stringify(summary)] }));
  const { app, window, folder } = await launchReady(dir, {
    BOOK_DISTILLER_AGENT_FILE: agentFile,
    BOOK_DISTILLER_WORK_ROOT: path.join(dir, 'work'),
  });
  try {
    await window.getByRole('listitem').nth(2).getByRole('checkbox').click();
    await window.getByRole('button', { name: 'Confirm' }).click();
    await expect(window.getByRole('region', { name: 'Viewer' })).toBeVisible();
    const row = window.getByRole('listitem');
    await expect(row).toContainText('failed');
    await expect(row).toContainText('shape');
    await expect(window.getByText('A summary the book did not classify')).toHaveCount(0);
    await expect(access(path.join(folder, 'boards', 'a-numbered-rule.board.json'))).rejects.toThrow();
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a code entry without a title fails as shape', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const agentFile = path.join(dir, 'agent.json');
  const board = listingBoard('wal.append(key, val)?;\nmem.put(key, val);') as {
    code: Array<Record<string, unknown>>;
  };
  delete board.code[0].title;
  await writeFile(agentFile, JSON.stringify({ replies: [JSON.stringify(board), JSON.stringify(board)] }));
  const { app, window, folder } = await launchReady(dir, {
    BOOK_DISTILLER_AGENT_FILE: agentFile,
    BOOK_DISTILLER_WORK_ROOT: path.join(dir, 'work'),
  });
  try {
    await window.getByRole('listitem').nth(1).getByRole('checkbox').click();
    await window.getByRole('button', { name: 'Confirm' }).click();
    await expect(window.getByRole('region', { name: 'Viewer' })).toBeVisible();
    const row = window.getByRole('listitem');
    await expect(row).toContainText('failed');
    await expect(row).toContainText('shape');
    await expect(access(path.join(folder, 'boards', 'a-listing.board.json'))).rejects.toThrow();
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('the numbered-rule instructions name the page images and leave out filler', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const agentFile = path.join(dir, 'agent.json');
  const work = path.join(dir, 'work');
  await writeFile(agentFile, JSON.stringify({ replies: [JSON.stringify(numberedRuleBoard())] }));
  const { app, window } = await launchReady(dir, {
    BOOK_DISTILLER_AGENT_FILE: agentFile,
    BOOK_DISTILLER_WORK_ROOT: work,
  });
  try {
    await window.getByRole('button', { name: 'Confirm' }).click();
    await expect(window.getByText(example)).toBeVisible();
    const text = await workspaceText(path.join(work, 'a-numbered-rule'));
    expect(text).toContain('The attached images are PDF pages 2 through 2, in order. Image 1 is PDF page 2.');
    expect(text).toContain(
      'The image is the authority for what the page means. The text layer is the authority for code spelling when it agrees with the image.',
    );
    expect(text).toContain(
      "Include the book's code when that code teaches, with its page, language, and short line notes. Those notes are the agent's words. Copy that code from the text layer when the text matches the page, and from the image otherwise.",
    );
    expect(text).not.toContain('It copies every required listing verbatim');
    expect(text).toContain(
      'It leaves out conversational filler, anecdotes that teach no rule, historical trivia, and repeated intros.',
    );
    expect(text).toContain(
      'A figure is a diagram, table, or picture on the page that teaches, not a code listing and not ordinary prose. figures is an array. Each figure has caption, page, and crop. caption is the book\'s caption when the page has one, otherwise a short name of the picture. page is the PDF page index. crop is the picture\'s box on that page image, from the top left, as fractions x, y, width, and height, each from 0 to 1. Omit figures when the slice has no such picture.',
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a shape failure retries and keeps the valid numbered-rule board', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const agentFile = path.join(dir, 'agent.json');
  const agentLog = path.join(dir, 'agent.log');
  const incomplete = {
    schemaVersion: 1,
    sectionId: 'a-numbered-rule',
    sectionTitle: 'A numbered rule',
    pageStart: 2,
    pageEnd: 2,
    points: [{ kind: 'must-remember' }],
    code: [],
  };
  await writeFile(
    agentFile,
    JSON.stringify({ replies: [JSON.stringify(incomplete), JSON.stringify(numberedRuleBoard())] }),
  );
  const { app, window, folder } = await launchReady(dir, {
    BOOK_DISTILLER_AGENT_FILE: agentFile,
    BOOK_DISTILLER_AGENT_LOG: agentLog,
    BOOK_DISTILLER_WORK_ROOT: path.join(dir, 'work'),
  });
  try {
    await window.getByRole('listitem').nth(2).getByRole('checkbox').click();
    await window.getByRole('button', { name: 'Confirm' }).click();
    await expect(window.getByText('Flush the log before memory')).toBeVisible();
    await expect(window.getByText(example)).toBeVisible();
    await readFile(path.join(folder, 'boards', 'a-numbered-rule.board.json'), 'utf8');
    expect((await readFile(agentLog, 'utf8')).trim().split(/\n/)).toEqual([
      '{"modelId":"north-model","sectionId":"a-numbered-rule"}',
      '{"modelId":"north-model","sectionId":"a-numbered-rule"}',
    ]);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

type RejectCase = {
  name: string;
  slice: number;
  reply: string;
  detail: string;
  sectionId: string;
};

function numberedRuleWith(change: Record<string, unknown>): string {
  return JSON.stringify({ ...(numberedRuleBoard() as Record<string, unknown>), ...change });
}

function listingWithoutCodeTitle(): string {
  const board = listingBoard('wal.append(key, val)?;\nmem.put(key, val);') as {
    code: Array<Record<string, unknown>>;
  };
  delete board.code[0].title;
  return JSON.stringify(board);
}

const rejectCases: RejectCase[] = [
  {
    name: 'a page outside the slice',
    slice: 2,
    reply: numberedRuleWith({
      points: [
        {
          kind: 'must-remember',
          title: 'Flush the log before memory',
          explanation: 'A write is durable only after the log is on disk.',
          page: 9,
        },
      ],
    }),
    detail: 'page 9 outside 2-2',
    sectionId: 'a-numbered-rule',
  },
  {
    name: 'a reply with no JSON object',
    slice: 2,
    reply: 'I could not produce a board for these pages.',
    detail: 'no board json',
    sectionId: 'a-numbered-rule',
  },
  {
    name: 'a wrong schema version',
    slice: 2,
    reply: numberedRuleWith({ schemaVersion: 2 }),
    detail: 'schema version',
    sectionId: 'a-numbered-rule',
  },
  {
    name: 'a point with only a kind',
    slice: 2,
    reply: numberedRuleWith({ points: [{ kind: 'must-remember' }] }),
    detail: 'bad point',
    sectionId: 'a-numbered-rule',
  },
  {
    name: 'a code block without a title',
    slice: 1,
    reply: listingWithoutCodeTitle(),
    detail: 'bad code',
    sectionId: 'a-listing',
  },
];

for (const rejected of rejectCases) {
  test(`${rejected.name} records why the reply was rejected`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
    const agentFile = path.join(dir, 'agent.json');
    await writeFile(agentFile, JSON.stringify({ replies: [rejected.reply, rejected.reply] }));
    const { app, window, folder } = await launchReady(dir, {
      BOOK_DISTILLER_AGENT_FILE: agentFile,
      BOOK_DISTILLER_WORK_ROOT: path.join(dir, 'work'),
    });
    try {
      await window.getByRole('listitem').nth(rejected.slice).getByRole('checkbox').click();
      await window.getByRole('button', { name: 'Confirm' }).click();
      await expect(window.getByRole('region', { name: 'Viewer' })).toBeVisible();
      const row = window.getByRole('listitem');
      await expect(row).toContainText(`failed shape: ${rejected.detail}`);
      const manifest = JSON.parse(await readFile(path.join(folder, 'book-manifest.json'), 'utf8')) as {
        slices: Array<{ id: string; status: string; failureReason?: string; failureDetail?: string }>;
      };
      const stored = manifest.slices.find((slice) => slice.id === rejected.sectionId);
      expect(stored?.status).toBe('failed');
      expect(stored?.failureReason).toBe('shape');
      expect(stored?.failureDetail).toBe(rejected.detail);
      expect(await readFile(path.join(folder, 'rejects', `${rejected.sectionId}.txt`), 'utf8')).toBe(
        rejected.reply,
      );
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('the prompt carries a filled skeleton and the page-stamp rule, and the retry names the rejection', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const agentFile = path.join(dir, 'agent.json');
  const work = path.join(dir, 'work');
  const outside = numberedRuleWith({ pageEnd: 14 });
  await writeFile(agentFile, JSON.stringify({ replies: [outside, numberedRuleWith({ schemaVersion: 2 })] }));
  const { app, window } = await launchReady(dir, {
    BOOK_DISTILLER_AGENT_FILE: agentFile,
    BOOK_DISTILLER_WORK_ROOT: work,
  });
  try {
    await window.getByRole('listitem').nth(2).getByRole('checkbox').click();
    await window.getByRole('button', { name: 'Confirm' }).click();
    await expect(window.getByRole('region', { name: 'Viewer' })).toBeVisible();
    await expect(window.getByRole('listitem')).toContainText('failed shape: schema version');
    const first = await readFile(path.join(work, 'a-numbered-rule', 'attempt-1.md'), 'utf8');
    expect(first).toContain('"schemaVersion": 1');
    expect(first).toContain('"sectionId": "a-numbered-rule"');
    expect(first).toContain('"sectionTitle": "A numbered rule"');
    expect(first).toContain('"pageStart": 2');
    expect(first).toContain('"pageEnd": 2');
    expect(first).toContain('"points": []');
    expect(first).toContain('"code": []');
    expect(first).toContain(
      'Every page is a JSON number taken from a line --- PAGE N ---. A bracketed printed page such as [ 14 ] is not a citation.',
    );
    expect(first).toContain(
      'A point has kind, title, explanation, and page. It has no text field. example, when present, is an object with text and page.',
    );
    expect(first).toContain(
      'A code block has title, language, page, source, and notes. notes is an array of objects with lines and why.',
    );
    expect(first).toContain('Field shape, not content to copy:');
    expect(first).not.toContain('The previous reply was rejected:');
    const second = await readFile(path.join(work, 'a-numbered-rule', 'attempt-2.md'), 'utf8');
    expect(second).toContain(first.trimEnd());
    expect(second).toContain('The previous reply was rejected: page 14 outside 2-2. Reply with only the board JSON.');
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a later accepted board leaves no reject file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const agentFile = path.join(dir, 'agent.json');
  const bad = numberedRuleWith({ points: [{ kind: 'must-remember' }] });
  await writeFile(agentFile, JSON.stringify({ replies: [bad, bad, JSON.stringify(numberedRuleBoard())] }));
  const { app, window, folder } = await launchReady(dir, {
    BOOK_DISTILLER_AGENT_FILE: agentFile,
    BOOK_DISTILLER_WORK_ROOT: path.join(dir, 'work'),
  });
  try {
    await window.getByRole('listitem').nth(2).getByRole('checkbox').click();
    await window.getByRole('button', { name: 'Confirm' }).click();
    await expect(window.getByRole('region', { name: 'Viewer' })).toBeVisible();
    await expect(window.getByRole('listitem')).toContainText('failed shape: bad point');
    await readFile(path.join(folder, 'rejects', 'a-numbered-rule.txt'), 'utf8');
    await window.getByRole('button', { name: 'Continue' }).click();
    await expect(window.getByText(example)).toBeVisible();
    await expect(access(path.join(folder, 'rejects', 'a-numbered-rule.txt'))).rejects.toThrow();
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

const bookletBytes = async (): Promise<Uint8Array> =>
  new Uint8Array(await readFile(path.join(process.cwd(), 'fixtures/booklet.pdf')));

async function detectedListing(): Promise<string> {
  const found = await requiredListings(await bookletBytes(), 3, 4);
  expect(found.length).toBeGreaterThan(0);
  return found[0];
}

async function distillListingSlice(source: string): Promise<{
  dir: string;
  folder: string;
  app: ElectronApplication;
  window: Page;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const agentFile = path.join(dir, 'agent.json');
  await writeFile(agentFile, JSON.stringify({ replies: [JSON.stringify(listingBoard(source))] }));
  const { app, window, folder } = await launchReady(dir, {
    BOOK_DISTILLER_AGENT_FILE: agentFile,
    BOOK_DISTILLER_WORK_ROOT: path.join(dir, 'work'),
  });
  await window.getByRole('listitem').nth(1).getByRole('checkbox').click();
  await window.getByRole('button', { name: 'Confirm' }).click();
  await expect(window.getByRole('region', { name: 'Viewer' })).toBeVisible();
  await expect(window.getByRole('listitem').filter({ hasText: 'A listing' })).toContainText('done');
  return { dir, folder, app, window };
}

test('a board that keeps the detected listing shows it without an omitted mark', async () => {
  const listing = await detectedListing();
  const { dir, folder, app, window } = await distillListingSlice(listing);
  try {
    await expect(window.getByText('Listings on the page', { exact: true })).toBeVisible();
    await expect(window.locator('.page-listings pre')).toHaveText(listing);
    await expect(window.getByText('Omitted', { exact: true })).toHaveCount(0);
    await readFile(path.join(folder, 'boards', 'a-listing.board.json'), 'utf8');
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a board that drops the detected listing marks it omitted and the slice stays done', async () => {
  const listing = await detectedListing();
  const { dir, folder, app, window } = await distillListingSlice('unrelated();');
  try {
    await expect(window.getByText('Listings on the page', { exact: true })).toBeVisible();
    await expect(window.locator('.page-listings pre')).toHaveText(listing);
    await expect(window.getByText('Omitted', { exact: true })).toBeVisible();
    const row = window.getByRole('listitem').filter({ hasText: 'A listing' });
    await expect(row).toContainText('done');
    await expect(row).not.toContainText('failed');
    const board = await readFile(path.join(folder, 'boards', 'a-listing.board.json'), 'utf8');
    expect(board).not.toContain('Omitted');
    expect(board).not.toContain('Listings on the page');
    expect(await readFile(path.join(folder, 'book-manifest.json'), 'utf8')).not.toContain('Listings on the page');

    await app.close();
    const reopened = await reopenBook(dir, folder);
    try {
      await expect(reopened.window.getByText('Listings on the page', { exact: true })).toBeVisible();
      await expect(reopened.window.getByText('Omitted', { exact: true })).toBeVisible();
    } finally {
      await reopened.app.close();
    }
  } finally {
    await app.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test('a slice with no monospace listing shows no listings section', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const agentFile = path.join(dir, 'agent.json');
  await writeFile(agentFile, JSON.stringify({ replies: [JSON.stringify(numberedRuleBoard())] }));
  const { app, window } = await launchReady(dir, {
    BOOK_DISTILLER_AGENT_FILE: agentFile,
    BOOK_DISTILLER_WORK_ROOT: path.join(dir, 'work'),
  });
  try {
    await window.getByRole('button', { name: 'Confirm' }).click();
    await expect(window.getByText(example)).toBeVisible();
    await expect(window.getByText('Listings on the page')).toHaveCount(0);
    await expect(window.getByText('Omitted', { exact: true })).toHaveCount(0);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('an empty board still shows the detected listing as omitted', async () => {
  const listing = await detectedListing();
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const agentFile = path.join(dir, 'agent.json');
  const empty = { ...(listingBoard('') as Record<string, unknown>), points: [], code: [] };
  await writeFile(agentFile, JSON.stringify({ replies: [JSON.stringify(empty)] }));
  const { app, window } = await launchReady(dir, {
    BOOK_DISTILLER_AGENT_FILE: agentFile,
    BOOK_DISTILLER_WORK_ROOT: path.join(dir, 'work'),
  });
  try {
    await window.getByRole('listitem').nth(1).getByRole('checkbox').click();
    await window.getByRole('button', { name: 'Confirm' }).click();
    await expect(window.getByText('Those pages had no technical content.', { exact: true })).toBeVisible();
    await expect(window.getByText('Listings on the page', { exact: true })).toBeVisible();
    await expect(window.locator('.page-listings pre')).toHaveText(listing);
    await expect(window.getByText('Omitted', { exact: true })).toBeVisible();
    await expect(window.getByRole('listitem').filter({ hasText: 'A listing' })).toContainText('done');
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function reopenBook(dir: string, folder: string): Promise<{ app: ElectronApplication; window: Page }> {
  const userData = path.join(dir, 'user-data-reopen');
  await mkdir(userData);
  const app = await electron.launch({
    executablePath: electronPath,
    args: [path.join(process.cwd(), 'out/main/index.js')],
    env: {
      ...process.env,
      BOOK_DISTILLER_VAULT: 'memory',
      BOOK_DISTILLER_USER_DATA: userData,
      BOOK_DISTILLER_CATALOG_FILE: path.join(dir, 'catalog.json'),
      BOOK_DISTILLER_AGENT_CONCURRENCY: '1',
    },
  });
  const window = await app.firstWindow();
  await app.evaluate(({ dialog }, chosen: string) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] });
  }, folder);
  await openSettings(window);
  await window.getByRole('button', { name: 'Choose a folder' }).click();
  await expect(window.getByRole('region', { name: 'Viewer' })).toBeVisible();
  return { app, window };
}

function figureReply(figures: unknown[], content: { points?: unknown[]; code?: unknown[] } = {}): string {
  return JSON.stringify({ ...(listingBoard('wal.append(key, val)?;') as Record<string, unknown>), ...content, figures });
}

const fullPage = { x: 0, y: 0, width: 1, height: 1 };

async function distillFigureSlice(
  ...replies: string[]
): Promise<{ dir: string; folder: string; app: ElectronApplication; window: Page }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const agentFile = path.join(dir, 'agent.json');
  await writeFile(agentFile, JSON.stringify({ replies }));
  const { app, window, folder } = await launchReady(dir, {
    BOOK_DISTILLER_AGENT_FILE: agentFile,
    BOOK_DISTILLER_WORK_ROOT: path.join(dir, 'work'),
  });
  await window.getByRole('listitem').nth(1).getByRole('checkbox').click();
  await window.getByRole('button', { name: 'Confirm' }).click();
  await expect(window.getByRole('region', { name: 'Viewer' })).toBeVisible();
  await expect(window.getByRole('listitem').filter({ hasText: 'A listing' })).toContainText('done');
  return { dir, folder, app, window };
}

test('a full-page figure is cropped into the book folder, the note, and the board', async () => {
  const { dir, folder, app, window } = await distillFigureSlice(
    figureReply([{ caption: 'Write path', page: 4, crop: fullPage }]),
  );
  try {
    const jpeg = await readFile(path.join(folder, 'figures', 'a-listing-1.jpg'));
    expect(jpeg.subarray(0, 2).toString('hex')).toBe('ffd8');
    expect(jpeg.byteLength).toBeGreaterThan(100);

    const boardText = await readFile(path.join(folder, 'boards', 'a-listing.board.json'), 'utf8');
    const board = JSON.parse(boardText) as { schemaVersion: number; figures?: unknown };
    expect(board.schemaVersion).toBe(1);
    expect(board.figures).toEqual([{ caption: 'Write path', page: 4, file: 'figures/a-listing-1.jpg' }]);
    expect(boardText).not.toContain('crop');
    expect(boardText).not.toContain('data:');
    expect(boardText).not.toContain('base64');

    const note = await readFile(path.join(folder, 'notes', 'a-listing.md'), 'utf8');
    expect(note).toContain('## Figures');
    expect(note).toContain('Write path');
    expect(note).toContain('Page 4');
    expect(note).toContain('../figures/a-listing-1.jpg');

    const figures = window.getByRole('region', { name: 'Figures' });
    await expect(figures.getByRole('heading', { name: 'Figures' })).toBeVisible();
    await expect(figures.getByText('Write path', { exact: true })).toBeVisible();
    const image = figures.getByRole('img', { name: 'Write path' });
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(100);
    const order = await window.locator('.board > section').evaluateAll((sections) =>
      sections.map((section) => section.getAttribute('aria-label') ?? section.className),
    );
    expect(order.indexOf('Figures')).toBeGreaterThan(order.indexOf('code'));
    expect(order.indexOf('Figures')).toBeLessThan(order.indexOf('Listings on the page'));
    await figures.getByRole('button', { name: 'Page 4' }).click();
    await expect(window.getByRole('complementary', { name: 'Page 4' })).toBeVisible();

    await app.close();
    const reopened = await reopenBook(dir, folder);
    try {
      await reopened.window.getByRole('button', { name: 'A listing' }).click();
      const again = reopened.window.getByRole('region', { name: 'Figures' });
      await expect(again.getByText('Write path', { exact: true })).toBeVisible();
      await expect(again.getByRole('img', { name: 'Write path' })).toBeVisible();
    } finally {
      await reopened.app.close();
    }
  } finally {
    await app.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test('a figure crop with zero width is dropped and the board is still accepted', async () => {
  const { dir, folder, app, window } = await distillFigureSlice(
    figureReply([{ caption: 'Write path', page: 4, crop: { x: 0, y: 0, width: 0, height: 1 } }]),
  );
  try {
    await expect(window.getByRole('heading', { name: 'Append the log before memory' })).toBeVisible();
    await expect(access(path.join(folder, 'figures', 'a-listing-1.jpg'))).rejects.toThrow();
    const board = JSON.parse(await readFile(path.join(folder, 'boards', 'a-listing.board.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(Object.keys(board)).not.toContain('figures');
    await expect(window.getByRole('region', { name: 'Figures' })).toHaveCount(0);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a redo removes that section\'s older figure files and keeps another section\'s', async () => {
  const { dir, folder, app, window } = await distillFigureSlice(
    figureReply([{ caption: 'Write path', page: 4, crop: fullPage }]),
    figureReply([]),
  );
  try {
    await readFile(path.join(folder, 'figures', 'a-listing-1.jpg'));
    await writeFile(path.join(folder, 'figures', 'a-listing-9.jpg'), 'stale');
    await writeFile(path.join(folder, 'figures', 'a-listing-extra-1.jpg'), 'another section');
    await window.getByRole('button', { name: 'Redo' }).click();
    await expect(window.getByRole('region', { name: 'Figures' })).toHaveCount(0);
    await expect(window.getByRole('heading', { name: 'Append the log before memory' })).toBeVisible();
    await expect(access(path.join(folder, 'figures', 'a-listing-1.jpg'))).rejects.toThrow();
    await expect(access(path.join(folder, 'figures', 'a-listing-9.jpg'))).rejects.toThrow();
    expect(await readFile(path.join(folder, 'figures', 'a-listing-extra-1.jpg'), 'utf8')).toBe('another section');
    expect(await readFile(path.join(folder, 'boards', 'a-listing.board.json'), 'utf8')).not.toContain('"figures"');
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a redo that recrops the same figure index shows the new image', async () => {
  const { dir, folder, app, window } = await distillFigureSlice(
    figureReply([{ caption: 'Write path', page: 4, crop: fullPage }]),
    figureReply([{ caption: 'Write path', page: 4, crop: { x: 0, y: 0, width: 0.5, height: 0.25 } }]),
  );
  try {
    const image = window.getByRole('region', { name: 'Figures' }).getByRole('img', { name: 'Write path' });
    const size = (): Promise<string> =>
      image.evaluate((element) => {
        const img = element as HTMLImageElement;
        return `${img.naturalWidth}x${img.naturalHeight}`;
      });
    await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(100);
    const before = await size();
    const figureFile = path.join(folder, 'figures', 'a-listing-1.jpg');
    const firstCrop = await readFile(figureFile);
    await window.getByRole('button', { name: 'Redo' }).click();
    await expect
      .poll(async () => {
        try {
          return (await readFile(figureFile)).equals(firstCrop);
        } catch {
          return true;
        }
      })
      .toBe(false);
    await expect(window.getByRole('button', { name: 'Redo' })).toBeEnabled();
    await expect.poll(size).not.toBe(before);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a board whose only content is a figure does not say the pages had no technical content', async () => {
  const { dir, folder, app, window } = await distillFigureSlice(
    figureReply([{ caption: 'Write path', page: 3, crop: { x: 0.1, y: 0.1, width: 0.5, height: 0.4 } }], {
      points: [],
      code: [],
    }),
  );
  try {
    await expect(window.getByRole('region', { name: 'Figures' }).getByText('Write path', { exact: true })).toBeVisible();
    await expect(window.getByText('Those pages had no technical content.')).toHaveCount(0);
    const note = await readFile(path.join(folder, 'notes', 'a-listing.md'), 'utf8');
    expect(note).not.toContain('Those pages had no technical content.');
    expect(note).toContain('../figures/a-listing-1.jpg');
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('search lists an unchecked slice that the run hides', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const agentFile = path.join(dir, 'agent.json');
  await writeFile(agentFile, JSON.stringify({ replies: [JSON.stringify(numberedRuleBoard())] }));
  const { app, window } = await launchReady(dir, {
    BOOK_DISTILLER_AGENT_FILE: agentFile,
    BOOK_DISTILLER_WORK_ROOT: path.join(dir, 'work'),
  });
  try {
    await window.getByRole('listitem').filter({ hasText: 'A listing' }).getByRole('checkbox').click();
    await window.getByRole('button', { name: 'Confirm' }).click();
    await expect(window.getByText(example)).toBeVisible();
    await expect(window.getByRole('button', { name: 'A listing' })).toHaveCount(0);
    await window.getByRole('textbox', { name: 'Search' }).fill('a listing');
    await expect(window.getByRole('button', { name: 'A listing' })).toBeVisible();
    await expect(window.getByRole('button', { name: 'A numbered rule' })).toHaveCount(0);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
