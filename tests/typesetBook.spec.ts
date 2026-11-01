import { expect, test } from '@playwright/test';
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
