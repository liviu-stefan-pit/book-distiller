import { expect, test } from '@playwright/test';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchReady, numberedRuleBoard } from './boardLaunch';

function wrongSchemaBoard(): unknown {
  return {
    schemaVersion: 2,
    sectionId: 'a-listing',
    sectionTitle: 'A listing',
    pageStart: 3,
    pageEnd: 4,
    points: [],
    code: [],
  };
}

test('a valid preface board is skipped while a later slice is still writing', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const agentFile = path.join(dir, 'agent.json');
  const agentLog = path.join(dir, 'agent.log');
  const wrong = wrongSchemaBoard();
  await writeFile(
    agentFile,
    JSON.stringify({
      replies: [JSON.stringify(numberedRuleBoard()), JSON.stringify(wrong), JSON.stringify(wrong)],
    }),
  );
  const { app, window, folder } = await launchReady(dir, {
    BOOK_DISTILLER_AGENT_FILE: agentFile,
    BOOK_DISTILLER_AGENT_LOG: agentLog,
    BOOK_DISTILLER_WORK_ROOT: path.join(dir, 'work'),
    BOOK_DISTILLER_AGENT_DELAY_MS: '2000',
  });
  try {
    const preface = {
      schemaVersion: 1,
      sectionId: 'preface',
      sectionTitle: 'Preface',
      pageStart: 1,
      pageEnd: 1,
      points: [],
      code: [],
    };
    await mkdir(path.join(folder, 'boards'), { recursive: true });
    await writeFile(path.join(folder, 'boards', 'preface.board.json'), `${JSON.stringify(preface, null, 2)}\n`);
    await window.getByRole('listitem').filter({ hasText: 'Preface' }).getByRole('checkbox').click();
    await window.getByRole('button', { name: 'Confirm' }).click();
    const listing = window.getByRole('listitem').filter({ hasText: 'A listing' });
    await expect(listing).toContainText('writing');
    await expect(window.getByRole('heading', { name: 'Flush the log before memory' })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Launchpad' })).toHaveCount(0);
    await window.getByRole('button', { name: 'Preface' }).click();
    await expect(window.getByText('Those pages had no technical content.', { exact: true })).toBeVisible();
    await expect(listing).toContainText('writing');
    await expect(window.getByRole('listitem').filter({ hasText: 'A numbered rule' })).toContainText('done');
    await expect(listing).toContainText('failed');
    await expect(listing).toContainText('shape');
    await readFile(path.join(folder, 'boards', 'a-numbered-rule.board.json'), 'utf8');
    await expect(access(path.join(folder, 'boards', 'a-listing.board.json'))).rejects.toThrow();
    expect((await readFile(agentLog, 'utf8')).trim().split(/\n/)).toEqual([
      '{"modelId":"north-model","sectionId":"a-numbered-rule"}',
      '{"modelId":"north-model","sectionId":"a-listing"}',
      '{"modelId":"north-model","sectionId":"a-listing"}',
    ]);
    const manifest = JSON.parse(await readFile(path.join(folder, 'book-manifest.json'), 'utf8')) as {
      slices: Array<{ id: string; status: string; modelId?: string; failureReason?: string }>;
    };
    const stored = Object.fromEntries(manifest.slices.map((slice) => [slice.id, slice]));
    expect(stored.preface?.status).toBe('done');
    expect(stored['a-numbered-rule']?.status).toBe('done');
    expect(stored['a-numbered-rule']?.modelId).toBe('north-model');
    expect(stored['a-listing']?.status).toBe('failed');
    expect(stored['a-listing']?.failureReason).toBe('shape');
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('cancel stops the in-flight slice and leaves the finished board', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const agentFile = path.join(dir, 'agent.json');
  await writeFile(agentFile, JSON.stringify({ replies: [JSON.stringify(numberedRuleBoard())] }));
  const { app, window, folder } = await launchReady(dir, {
    BOOK_DISTILLER_AGENT_FILE: agentFile,
    BOOK_DISTILLER_WORK_ROOT: path.join(dir, 'work'),
    BOOK_DISTILLER_AGENT_DELAY_MS: '2000',
  });
  try {
    await window.getByRole('button', { name: 'Confirm' }).click();
    const listing = window.getByRole('listitem').filter({ hasText: 'A listing' });
    await expect(listing).toContainText('writing');
    await window.getByRole('button', { name: 'Cancel' }).click();
    await expect(listing).toContainText('failed');
    await expect(listing).toContainText('cancelled');
    await readFile(path.join(folder, 'boards', 'a-numbered-rule.board.json'), 'utf8');
    await expect(access(path.join(folder, 'boards', 'a-listing.board.json'))).rejects.toThrow();
    await expect(window.getByRole('button', { name: 'Launchpad' })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('cancel after a valid reply drops that slice and leaves the next one queued', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const agentFile = path.join(dir, 'agent.json');
  const agentLog = path.join(dir, 'agent.log');
  await writeFile(agentFile, JSON.stringify({ replies: [JSON.stringify(numberedRuleBoard())] }));
  const { app, window, folder } = await launchReady(dir, {
    BOOK_DISTILLER_AGENT_FILE: agentFile,
    BOOK_DISTILLER_AGENT_LOG: agentLog,
    BOOK_DISTILLER_WORK_ROOT: path.join(dir, 'work'),
    BOOK_DISTILLER_AFTER_REPLY_DELAY_MS: '2000',
  });
  try {
    await window.getByRole('button', { name: 'Confirm' }).click();
    const rule = window.getByRole('listitem').filter({ hasText: 'A numbered rule' });
    await expect(rule).toContainText('writing');
    await expect
      .poll(async () => {
        try {
          return await readFile(agentLog, 'utf8');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return '';
          }
          throw error;
        }
      })
      .toContain('"sectionId":"a-numbered-rule"');
    await expect(rule).toContainText('writing');
    await window.getByRole('button', { name: 'Cancel' }).click();
    await expect(rule).toContainText('failed');
    await expect(rule).toContainText('cancelled');
    await expect(access(path.join(folder, 'boards', 'a-numbered-rule.board.json'))).rejects.toThrow();
    await expect(window.getByRole('listitem').filter({ hasText: 'A listing' })).toContainText('queued');
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('cancel during the first slice leaves the rest queued and returns to the launchpad', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-'));
  const agentFile = path.join(dir, 'agent.json');
  const agentLog = path.join(dir, 'agent.log');
  await writeFile(agentFile, JSON.stringify({ replies: [JSON.stringify(numberedRuleBoard())] }));
  const { app, window, folder } = await launchReady(dir, {
    BOOK_DISTILLER_AGENT_FILE: agentFile,
    BOOK_DISTILLER_AGENT_LOG: agentLog,
    BOOK_DISTILLER_WORK_ROOT: path.join(dir, 'work'),
    BOOK_DISTILLER_AGENT_DELAY_MS: '2000',
  });
  try {
    await window.getByRole('listitem').filter({ hasText: 'Preface' }).getByRole('checkbox').click();
    await window.getByRole('button', { name: 'Confirm' }).click();
    const preface = window.getByRole('listitem').filter({ hasText: 'Preface' });
    await expect(preface).toContainText('writing');
    await window.getByRole('button', { name: 'Cancel' }).click();
    await expect(preface).toContainText('failed');
    await expect(preface).toContainText('cancelled');
    await expect(access(path.join(folder, 'boards', 'preface.board.json'))).rejects.toThrow();
    await expect(window.getByRole('listitem').filter({ hasText: 'A numbered rule' })).toContainText('queued');
    await expect(window.getByRole('listitem').filter({ hasText: 'A listing' })).toContainText('queued');
    await window.getByRole('button', { name: 'Launchpad' }).click();
    await expect(window.getByText('Drop a PDF')).toBeVisible();
    let log = '';
    try {
      log = await readFile(agentLog, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    expect(log.includes('"sectionId":"a-numbered-rule"')).toBe(false);
    expect(log.includes('"sectionId":"a-listing"')).toBe(false);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
