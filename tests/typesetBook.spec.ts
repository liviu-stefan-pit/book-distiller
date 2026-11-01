import { expect, test } from '@playwright/test';
import { createCanvas } from '@napi-rs/canvas';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Chapter } from '../src/main/compose';
import { typesetBook } from '../src/main/typesetBook';

test('typesetBook compiles a tiny chapter to a PDF buffer', () => {
  const chapter: Chapter = {
    schemaVersion: 1,
    sectionId: 'one',
    title: 'Chapter # one',
    pageStart: 2,
    pageEnd: 3,
    boardHash: 'abc',
    blocks: [
      { type: 'prose', text: 'A write is durable only after the log is on disk. Note the # hash.' },
      { type: 'code', language: 'csharp', source: 'log.Flush();', caption: 'Flush the log' },
      {
        type: 'callout',
        kind: 'added',
        title: 'WAL',
        text: 'Current stores also keep a write-ahead log.',
      },
    ],
  };
  const pdf = typesetBook('Title with # hash', [chapter]);
  expect(Buffer.isBuffer(pdf)).toBe(true);
  expect(pdf.subarray(0, 4).toString('utf8')).toBe('%PDF');
});

function figureChapter(file: string): Chapter {
  return {
    schemaVersion: 1,
    sectionId: 'write-ahead-log',
    title: 'Write-ahead log',
    pageStart: 4,
    pageEnd: 4,
    boardHash: 'abc',
    blocks: [
      { type: 'prose', text: 'A write is durable only after the log is on disk.' },
      { type: 'figure', caption: 'Write path "#1"', page: 4, file },
    ],
  };
}

test('typesetBook draws a figure from the book folder and still prints a missing one', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'book-distiller-typeset-'));
  try {
    await mkdir(path.join(dir, 'figures'), { recursive: true });
    const canvas = createCanvas(400, 300);
    const context = canvas.getContext('2d');
    context.fillStyle = '#3366aa';
    context.fillRect(0, 0, 400, 300);
    context.fillStyle = '#ffffff';
    context.fillRect(40, 40, 120, 80);
    await writeFile(path.join(dir, 'figures', 'write-ahead-log-1.jpg'), canvas.toBuffer('image/jpeg', 90));

    const drawn = typesetBook('Figures', [figureChapter('figures/write-ahead-log-1.jpg')], dir);
    expect(drawn.subarray(0, 4).toString('utf8')).toBe('%PDF');

    const missing = typesetBook('Figures', [figureChapter('figures/write-ahead-log-2.jpg')], dir);
    expect(missing.subarray(0, 4).toString('utf8')).toBe('%PDF');
    expect(drawn.byteLength).toBeGreaterThan(missing.byteLength);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
