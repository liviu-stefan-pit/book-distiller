import { expect, test } from '@playwright/test';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { agentConcurrency } from '../src/main/heldAgent';
import { launchReady, numberedRuleBoard, openSettings, parameterizedCatalog } from './boardLaunch';

type AgentEvent = {
  event: string;
  agentId?: number;
  cwd?: string;
  modelId?: string;
  modelParams?: Array<{ id: string; value: string }>;
  prompt?: string;
  kind?: string;
};

function listingBoard(): unknown {
  return {
    schemaVersion: 1,
    sectionId: 'a-listing',
    sectionTitle: 'A listing',
    pageStart: 3,
    pageEnd: 4,
    points: [],
    code: [],
  };
}

function prefaceBoard(): unknown {
  return {
    schemaVersion: 1,
    sectionId: 'preface',
    sectionTitle: 'Preface',
    pageStart: 1,
    pageEnd: 1,
    points: [],
    code: [],
  };
}

// Overlapping agents send in no fixed order, so each section gets its own reply.
function sectionReplies(): Record<string, string> {
  return {
    preface: JSON.stringify(prefaceBoard()),
    'a-numbered-rule': JSON.stringify(numberedRuleBoard()),
    'a-listing': JSON.stringify(listingBoard()),
  };
}

async function events(file: string): Promise<AgentEvent[]> {
  try {
    const text = await readFile(file, 'utf8');
    return text
      .trim()
      .split(/\n/)
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as AgentEvent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function names(list: AgentEvent[]): string[] {
  return list.map((item) => item.event);
}

function agentIds(list: AgentEvent[], event: string): number[] {
  return list
    .filter((item) => item.event === event)
    .map((item) => item.agentId ?? -1)
    .sort((a, b) => a - b);
}

function forAgent(list: AgentEvent[], agentId: number): string[] {
  return names(list.filter((item) => item.agentId === agentId));
}

test('the pool width is 6 unless the override is an integer, which is clamped to 1 through 6', () => {
  expect(agentConcurrency(undefined)).toBe(6);
  expect(agentConcurrency('')).toBe(6);
  expect(agentConcurrency('abc')).toBe(6);
  expect(agentConcurrency('2.5')).toBe(6);
  expect(agentConcurrency('1')).toBe(1);
  expect(agentConcurrency('3')).toBe(3);
  expect(agentConcurrency('6')).toBe(6);
  expect(agentConcurrency('9')).toBe(6);
  expect(agentConcurrency('0')).toBe(1);
  expect(agentConcurrency('-4')).toBe(1);
});

test('at width 1 one agent serves both slices and ends on its latest total', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const standIn = path.join(dir, 'stand-in.json');
  const log = path.join(dir, 'agent-events.log');
  await writeFile(
    standIn,
    JSON.stringify({
      replies: [JSON.stringify(numberedRuleBoard()), JSON.stringify(listingBoard())],
      usage: [1000, 1200, 2500, 2700],
    }),
  );
  const { app, window, folder } = await launchReady(dir, {
    BOOK_DISTILLER_STANDIN_AGENT: standIn,
    BOOK_DISTILLER_AGENT_EVENTS: log,
    BOOK_DISTILLER_AGENT_CONCURRENCY: '1',
  });
  try {
    await expect(window.getByText(/tokens$/)).toHaveCount(0);
    await window.getByRole('button', { name: 'Confirm' }).click();
    await expect(window.getByRole('listitem').filter({ hasText: 'A numbered rule' })).toContainText('done');
    await expect(window.getByRole('listitem').filter({ hasText: 'A listing' })).toContainText('done');
    await expect(window.getByText('2,700 tokens', { exact: true })).toBeVisible();
    await readFile(path.join(folder, 'boards', 'a-listing.board.json'), 'utf8');
    const seen = await events(log);
    expect(names(seen)).toEqual(['create', 'send', 'summarize', 'send', 'summarize']);
    expect(new Set(seen.map((item) => item.agentId)).size).toBe(1);
    expect(seen[0]?.modelId).toBe('north-model');
    const sends = seen.filter((item) => item.event === 'send');
    expect(sends.map((item) => item.modelId)).toEqual(['north-model', 'north-model']);
    for (const item of sends) {
      expect(item.prompt?.toLowerCase()).toContain('stands alone');
    }
    await openSettings(window);
    await window.getByRole('button', { name: 'Forget key' }).click();
    await expect(window.getByText(/tokens$/)).toHaveCount(0);
    await expect.poll(async () => names(await events(log))).toEqual([
      'create',
      'send',
      'summarize',
      'send',
      'summarize',
      'dispose',
    ]);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('create and every send carry the chosen model params', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const standIn = path.join(dir, 'stand-in.json');
  const log = path.join(dir, 'agent-events.log');
  await writeFile(
    standIn,
    JSON.stringify({ replies: [JSON.stringify(numberedRuleBoard()), JSON.stringify(listingBoard())] }),
  );
  const { app, window } = await launchReady(
    dir,
    {
      BOOK_DISTILLER_STANDIN_AGENT: standIn,
      BOOK_DISTILLER_AGENT_EVENTS: log,
      BOOK_DISTILLER_AGENT_CONCURRENCY: '1',
    },
    {
      catalog: parameterizedCatalog,
      modelId: 'effort-model',
      afterModel: async (page) => {
        await page.getByRole('combobox', { name: 'Effort', exact: true }).selectOption('low');
        await page.getByRole('checkbox', { name: 'Fast' }).uncheck();
        await expect(page.getByRole('combobox', { name: 'Effort', exact: true })).toHaveValue('low');
        await expect(page.getByRole('checkbox', { name: 'Fast' })).not.toBeChecked();
      },
    },
  );
  try {
    await window.getByRole('button', { name: 'Confirm' }).click();
    await expect(window.getByRole('listitem').filter({ hasText: 'A numbered rule' })).toContainText('done');
    await expect(window.getByRole('listitem').filter({ hasText: 'A listing' })).toContainText('done');
    const seen = await events(log);
    const chosen = [
      { id: 'effort', value: 'low' },
      { id: 'fast', value: 'false' },
    ];
    const created = seen.filter((item) => item.event === 'create');
    const sends = seen.filter((item) => item.event === 'send');
    expect(created).toHaveLength(1);
    expect(sends).toHaveLength(2);
    for (const item of [...created, ...sends]) {
      expect(item.modelId).toBe('effort-model');
      expect(item.modelParams).toEqual(chosen);
    }
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('two slices start two agents in two directories and the total is the sum of their latest usage', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const standIn = path.join(dir, 'stand-in.json');
  const log = path.join(dir, 'agent-events.log');
  await writeFile(
    standIn,
    JSON.stringify({
      sectionReplies: sectionReplies(),
      perAgentUsage: [
        [1000, 1500],
        [2000, 2700],
      ],
    }),
  );
  const { app, window, folder } = await launchReady(dir, {
    BOOK_DISTILLER_STANDIN_AGENT: standIn,
    BOOK_DISTILLER_AGENT_EVENTS: log,
    BOOK_DISTILLER_AGENT_CONCURRENCY: '6',
  });
  try {
    await expect(window.getByText(/tokens$/)).toHaveCount(0);
    await window.getByRole('button', { name: 'Confirm' }).click();
    await expect(window.getByRole('listitem').filter({ hasText: 'A numbered rule' })).toContainText('done');
    await expect(window.getByRole('listitem').filter({ hasText: 'A listing' })).toContainText('done');
    await expect(window.getByText('4,200 tokens', { exact: true })).toBeVisible();
    await readFile(path.join(folder, 'boards', 'a-numbered-rule.board.json'), 'utf8');
    await readFile(path.join(folder, 'boards', 'a-listing.board.json'), 'utf8');
    await expect.poll(async () => agentIds(await events(log), 'summarize')).toHaveLength(2);
    const seen = await events(log);
    const creates = seen.filter((item) => item.event === 'create');
    expect(creates).toHaveLength(2);
    const ids = agentIds(seen, 'create');
    expect(new Set(ids).size).toBe(2);
    const cwds = creates.map((item) => item.cwd ?? '');
    expect(new Set(cwds).size).toBe(2);
    for (const cwd of cwds) {
      expect(cwd).not.toBe('');
    }
    for (const id of ids) {
      expect(forAgent(seen, id)).toEqual(['create', 'send', 'summarize']);
    }
    for (const item of seen.filter((entry) => entry.event === 'send')) {
      expect(item.prompt?.toLowerCase()).toContain('stands alone');
    }
    await openSettings(window);
    await window.getByRole('button', { name: 'Forget key' }).click();
    await expect(window.getByText(/tokens$/)).toHaveCount(0);
    await expect.poll(async () => agentIds(await events(log), 'dispose')).toEqual(ids);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('two slices write at once, Cancel stops both runs, and a third slice stays queued', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const standIn = path.join(dir, 'stand-in.json');
  const log = path.join(dir, 'agent-events.log');
  await writeFile(
    standIn,
    JSON.stringify({
      sectionReplies: sectionReplies(),
      hangSends: [0, 1],
      cancelDelayMs: 1000,
    }),
  );
  const { app, window } = await launchReady(dir, {
    BOOK_DISTILLER_STANDIN_AGENT: standIn,
    BOOK_DISTILLER_AGENT_EVENTS: log,
    BOOK_DISTILLER_AGENT_CONCURRENCY: '2',
  });
  try {
    const preface = window.getByRole('listitem').filter({ hasText: 'Preface' });
    const rule = window.getByRole('listitem').filter({ hasText: 'A numbered rule' });
    const listing = window.getByRole('listitem').filter({ hasText: 'A listing' });
    await preface.getByRole('checkbox').click();
    await window.getByRole('button', { name: 'Confirm' }).click();
    await expect(window.getByRole('status')).toContainText('Writing 2 slices');
    await expect(window.locator('.reading')).toContainText('Writing 2 slices');
    await expect(window.getByRole('status')).not.toContainText('Writing Preface');
    await expect(preface).toContainText('writing');
    await expect(rule).toContainText('writing');
    await expect(listing).toContainText('queued');
    await expect.poll(async () => agentIds(await events(log), 'send')).toHaveLength(2);
    await window.getByRole('button', { name: 'Cancel' }).click();
    await expect(window.getByRole('button', { name: 'Cancelling' })).toBeVisible();
    await expect(preface).toContainText('cancelled');
    await expect(rule).toContainText('cancelled');
    await expect(window.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
    await expect(listing).toContainText('queued');
    const seen = await events(log);
    const ids = agentIds(seen, 'create');
    expect(ids).toHaveLength(2);
    expect(agentIds(seen, 'cancel')).toEqual(ids);
    expect(agentIds(seen, 'send')).toEqual(ids);
    expect(names(seen)).not.toContain('dispose');
    expect(names(seen)).not.toContain('summarize');
    await window.getByRole('button', { name: 'Continue' }).click();
    await expect(preface).toContainText('done');
    await expect(rule).toContainText('done');
    await expect(listing).toContainText('done');
    expect(agentIds(await events(log), 'create')).toEqual(ids);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('cancel stops the live run, shows Cancelling, and Continue reuses the same agent', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const standIn = path.join(dir, 'stand-in.json');
  const log = path.join(dir, 'agent-events.log');
  await writeFile(
    standIn,
    JSON.stringify({
      replies: ['', JSON.stringify(numberedRuleBoard()), JSON.stringify(listingBoard())],
      hangSends: [0],
      cancelDelayMs: 1500,
    }),
  );
  const { app, window } = await launchReady(dir, {
    BOOK_DISTILLER_STANDIN_AGENT: standIn,
    BOOK_DISTILLER_AGENT_EVENTS: log,
    BOOK_DISTILLER_AGENT_CONCURRENCY: '1',
  });
  try {
    await window.getByRole('button', { name: 'Confirm' }).click();
    const rule = window.getByRole('listitem').filter({ hasText: 'A numbered rule' });
    await expect(rule).toContainText('writing');
    await expect.poll(async () => names(await events(log))).toContain('send');
    await window.getByRole('button', { name: 'Cancel' }).click();
    await expect(window.getByRole('button', { name: 'Cancelling' })).toBeVisible();
    await expect(rule).toContainText('failed');
    await expect(rule).toContainText('cancelled');
    await expect(window.getByRole('button', { name: 'Cancelling' })).toHaveCount(0);
    await expect(window.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
    expect(names(await events(log))).toEqual(['create', 'send', 'cancel']);
    await window.getByRole('button', { name: 'Continue' }).click();
    await expect(rule).toContainText('done');
    await expect.poll(async () => names(await events(log))).toEqual([
      'create',
      'send',
      'cancel',
      'send',
      'summarize',
      'send',
      'summarize',
    ]);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a send that throws disposes only that agent and its worker creates a replacement', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const standIn = path.join(dir, 'stand-in.json');
  const log = path.join(dir, 'agent-events.log');
  await writeFile(
    standIn,
    JSON.stringify({
      sectionReplies: sectionReplies(),
      throwOnSend: [0],
      perAgentUsage: [[1000, 1100], [2000, 2100], [4000, 4100]],
    }),
  );
  const { app, window } = await launchReady(dir, {
    BOOK_DISTILLER_STANDIN_AGENT: standIn,
    BOOK_DISTILLER_AGENT_EVENTS: log,
    BOOK_DISTILLER_AGENT_CONCURRENCY: '2',
  });
  try {
    await window.getByRole('button', { name: 'Confirm' }).click();
    await expect(window.getByRole('listitem').filter({ hasText: 'A numbered rule' })).toContainText('done');
    await expect(window.getByRole('listitem').filter({ hasText: 'A listing' })).toContainText('done');
    await expect.poll(async () => agentIds(await events(log), 'summarize')).toHaveLength(2);
    const seen = await events(log);
    expect(agentIds(seen, 'create')).toHaveLength(3);
    const disposed = agentIds(seen, 'dispose');
    expect(disposed).toHaveLength(1);
    const thrown = disposed[0] ?? -1;
    expect(forAgent(seen, thrown)).toEqual(['create', 'send', 'dispose']);
    await openSettings(window);
    await window.getByRole('button', { name: 'Forget key' }).click();
    await expect(window.getByText(/tokens$/)).toHaveCount(0);
    await expect.poll(async () => agentIds(await events(log), 'dispose')).toHaveLength(3);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a workspace that cannot be deleted does not reject the queue', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const standIn = path.join(dir, 'stand-in.json');
  const log = path.join(dir, 'agent-events.log');
  await writeFile(
    standIn,
    JSON.stringify({
      replies: ['', JSON.stringify(numberedRuleBoard()), JSON.stringify(listingBoard())],
      throwOnSend: [0],
    }),
  );
  const { app, window } = await launchReady(dir, {
    BOOK_DISTILLER_STANDIN_AGENT: standIn,
    BOOK_DISTILLER_AGENT_EVENTS: log,
    BOOK_DISTILLER_AGENT_CONCURRENCY: '1',
    BOOK_DISTILLER_WORKSPACE_DELETE_FAIL: '1',
    BOOK_DISTILLER_WORK_ROOT: '',
  });
  let lockedWorkspace = '';
  try {
    await window.getByRole('button', { name: 'Confirm' }).click();
    await expect(window.getByRole('listitem').filter({ hasText: 'A numbered rule' })).toContainText('done');
    await expect(window.getByRole('listitem').filter({ hasText: 'A listing' })).toContainText('done');
    const seen = await events(log);
    expect(names(seen).filter((name) => name === 'create')).toHaveLength(2);
    expect(names(seen)).toContain('dispose');
    lockedWorkspace = seen[0]?.cwd ?? '';
    expect(lockedWorkspace).not.toBe('');
    await access(lockedWorkspace);
    await openSettings(window);
    await window.getByRole('button', { name: 'Forget key' }).click();
    await expect.poll(async () => names(await events(log)).filter((name) => name === 'dispose')).toHaveLength(2);
    await expect(window.getByRole('button', { name: 'Forget key' })).toHaveCount(0);
    await access(lockedWorkspace);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
    if (lockedWorkspace !== '') {
      await rm(path.dirname(lockedWorkspace), { recursive: true, force: true });
    }
  }
});

test('quitting the app disposes every agent that was created', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const standIn = path.join(dir, 'stand-in.json');
  const log = path.join(dir, 'agent-events.log');
  await writeFile(standIn, JSON.stringify({ sectionReplies: sectionReplies() }));
  const { app, window } = await launchReady(dir, {
    BOOK_DISTILLER_STANDIN_AGENT: standIn,
    BOOK_DISTILLER_AGENT_EVENTS: log,
    BOOK_DISTILLER_AGENT_CONCURRENCY: '2',
  });
  try {
    await window.getByRole('button', { name: 'Confirm' }).click();
    await expect(window.getByRole('listitem').filter({ hasText: 'A numbered rule' })).toContainText('done');
    await expect(window.getByRole('listitem').filter({ hasText: 'A listing' })).toContainText('done');
    await expect.poll(async () => agentIds(await events(log), 'summarize')).toHaveLength(2);
    expect(names(await events(log))).not.toContain('dispose');
    const created = agentIds(await events(log), 'create');
    expect(created).toHaveLength(2);
    await app.close();
    expect(agentIds(await events(log), 'dispose')).toEqual(created);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
