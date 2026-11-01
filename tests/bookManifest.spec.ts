import { expect, test } from '@playwright/test';
import { composedPdfReady, nextManifestText, setComposedPdf } from '../src/main/bookManifest';

function manifest(extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      pdfPath: '/tmp/book.pdf',
      title: 'Compose Booklet',
      slices: [],
      ...extra,
    },
    null,
    2,
  )}\n`;
}

test('a rewrite keeps composedPdf when the previous text has the exact field', () => {
  const previous = manifest({ composedPdf: 'composed.pdf' });
  const next = nextManifestText(previous, {
    schemaVersion: 1,
    pdfPath: '/tmp/book.pdf',
    title: 'Compose Booklet',
    slices: [{ id: 'a', title: 'A', pageStart: 1, pageEnd: 1, checked: true, status: 'done' }],
  });
  expect(next).toContain('"composedPdf": "composed.pdf"');
  expect(JSON.parse(next).slices).toHaveLength(1);
});

test('composedPdfReady is false when the file is absent', () => {
  expect(composedPdfReady(manifest({ composedPdf: 'composed.pdf' }), false)).toBe(false);
});

test('setComposedPdf writes the composed.pdf field', () => {
  const next = setComposedPdf(manifest());
  expect(JSON.parse(next).composedPdf).toBe('composed.pdf');
  expect(next).toContain('"composedPdf": "composed.pdf"');
});
