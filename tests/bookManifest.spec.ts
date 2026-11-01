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

test('a rewrite keeps originPath when the next manifest has none', () => {
  const previous = manifest({ originPath: '/tmp/dropped.pdf' });
  const next = nextManifestText(previous, {
    schemaVersion: 1,
    pdfPath: '/tmp/book/source.pdf',
    title: 'Compose Booklet',
    slices: [],
  });
  expect(JSON.parse(next).originPath).toBe('/tmp/dropped.pdf');
  const replaced = nextManifestText(previous, {
    schemaVersion: 1,
    pdfPath: '/tmp/book/source.pdf',
    originPath: '/tmp/other.pdf',
    title: 'Compose Booklet',
    slices: [],
  });
  expect(JSON.parse(replaced).originPath).toBe('/tmp/other.pdf');
});

test('composedPdfReady is false when the file is absent', () => {
  expect(composedPdfReady(manifest({ composedPdf: 'composed.pdf' }), false)).toBe(false);
});

test('setComposedPdf writes the composed.pdf field', () => {
  const next = setComposedPdf(manifest());
  expect(JSON.parse(next).composedPdf).toBe('composed.pdf');
  expect(next).toContain('"composedPdf": "composed.pdf"');
});
