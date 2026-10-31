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
    parts.push(entry.isDirectory() ? await workspaceText(full) : await readFile(full, 'utf8'));
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
    await expect(window.getByRole('heading', { name: 'Study' })).toBeVisible();
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

test('a missing listing is sent once more and the corrected board is kept', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const agentFile = path.join(dir, 'agent.json');
  const agentLog = path.join(dir, 'agent.log');
  await writeFile(
    agentFile,
    JSON.stringify({
      replies: [
        JSON.stringify(listingBoard('wal.append(key, val)?;')),
        JSON.stringify(listingBoard('wal.append(key, val)?;\nmem.put(key, val);')),
      ],
    }),
  );
  const { app, window, folder } = await launchReady(dir, {
    BOOK_DISTILLER_AGENT_FILE: agentFile,
    BOOK_DISTILLER_AGENT_LOG: agentLog,
    BOOK_DISTILLER_WORK_ROOT: path.join(dir, 'work'),
  });
  try {
    await window.getByRole('listitem').nth(1).getByRole('checkbox').click();
    await window.getByRole('button', { name: 'Confirm' }).click();
    await expect(window.getByText('wal.append(key, val)?;')).toBeVisible();
    await expect(window.getByText('mem.put(key, val);')).toBeVisible();
    await readFile(path.join(folder, 'boards', 'a-listing.board.json'), 'utf8');
    expect((await readFile(agentLog, 'utf8')).trim().split(/\n/)).toEqual([
      '{"modelId":"north-model","sectionId":"a-listing"}',
      '{"modelId":"north-model","sectionId":"a-listing"}',
    ]);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('two omitted listings fail the slice without a board or a note', async () => {
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
    await expect(window.getByRole('heading', { name: 'Study' })).toBeVisible();
    const row = window.getByRole('listitem');
    await expect(row).toContainText('failed');
    await expect(row).toContainText('missing listing');
    await expect(access(path.join(folder, 'boards', 'a-listing.board.json'))).rejects.toThrow();
    await expect(access(path.join(folder, 'notes', 'a-listing.md'))).rejects.toThrow();
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
    await expect(window.getByRole('heading', { name: 'Study' })).toBeVisible();
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
    await expect(window.getByRole('heading', { name: 'Study' })).toBeVisible();
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
    await expect(window.getByRole('heading', { name: 'Study' })).toBeVisible();
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
    await expect(window.getByRole('heading', { name: 'Study' })).toBeVisible();
    const row = window.getByRole('listitem');
    await expect(row).toContainText('failed');
    await expect(row).toContainText('shape');
    await expect(row).not.toContainText('missing listing');
    await expect(access(path.join(folder, 'boards', 'a-listing.board.json'))).rejects.toThrow();
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('the numbered-rule instructions include the listing and filler sentences', async () => {
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
    expect(text).toContain(
      'It copies every required listing verbatim and adds short line notes; those notes are the agent\u2019s words.',
    );
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
