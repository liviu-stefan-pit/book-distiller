import { expect, test } from '@playwright/test';
import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { example, launchReady, numberedRuleBoard, secret } from './boardLaunch';

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
    await readFile(path.join(folder, 'boards', 'a-numbered-rule.board.json'), 'utf8');
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
    await expect(window.getByText('wal.append(key, val)?;')).toBeVisible();
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
