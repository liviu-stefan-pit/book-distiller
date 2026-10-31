import { expect, test } from '@playwright/test';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { slicePdf, type Slice } from '../src/main/slicePdf';

const pdfPath = path.join(process.cwd(), 'fixtures', 'books', 'WPF Pro WPF 4.5 in C#, 4th Edition .pdf');

test.setTimeout(120_000);

function rows(list: Slice[]): Array<{ title: string; pageStart: number; pageEnd: number; checked: boolean }> {
  return list.map((slice) => ({
    title: slice.title,
    pageStart: slice.pageStart,
    pageEnd: slice.pageEnd,
    checked: slice.checked,
  }));
}

function covering(list: Slice[], pageStart: number, pageEnd: number): Slice[] {
  return list.filter((slice) => slice.pageStart <= pageEnd && slice.pageEnd >= pageStart);
}

async function skipIfMissing(): Promise<void> {
  try {
    await access(pdfPath);
  } catch {
    test.skip(true, `missing ${pdfPath}`);
  }
}

let slices: Slice[] = [];

test.beforeAll(async () => {
  test.setTimeout(120_000);
  try {
    await access(pdfPath);
  } catch {
    return;
  }
  slices = await slicePdf(new Uint8Array(await readFile(pdfPath)));
});

test('The Evolution of Windows Graphics is checked on pages 6 and 7', async () => {
  await skipIfMissing();
  const found = slices.filter((slice) => slice.title === 'The Evolution of Windows Graphics');
  console.log(JSON.stringify(rows(found)));
  expect(rows(found)).toContainEqual({
    title: 'The Evolution of Windows Graphics',
    pageStart: 6,
    pageEnd: 7,
    checked: true,
  });
});

test('pages 31 through 42 are two checked Properties and Events in XAML slices', async () => {
  await skipIfMissing();
  const found = covering(slices, 31, 42);
  console.log(JSON.stringify(rows(found)));
  expect(rows(found)).toEqual([
    { title: 'Properties and Events in XAML', pageStart: 31, pageEnd: 36, checked: true },
    { title: 'Properties and Events in XAML', pageStart: 37, pageEnd: 42, checked: true },
  ]);
  const banned = slices.filter(
    (slice) => slice.title === 'Markup Extensions' || slice.title === 'The Full Eight-Ball Example',
  );
  console.log(JSON.stringify(rows(banned)));
  expect(rows(banned)).toEqual([]);
});

test('pages 1027 through 1067 are unchecked Index slices and letter titles are absent', async () => {
  await skipIfMissing();
  const letters = slices.filter((slice) => slice.title === 'A' || slice.title === 'B');
  console.log(JSON.stringify(rows(letters)));
  expect(rows(letters)).toEqual([]);
  const found = covering(slices, 1027, 1067);
  console.log(JSON.stringify(rows(found)));
  expect(rows(found)).toEqual([
    { title: 'Index', pageStart: 1027, pageEnd: 1032, checked: false },
    { title: 'Index', pageStart: 1033, pageEnd: 1038, checked: false },
    { title: 'Index', pageStart: 1039, pageEnd: 1044, checked: false },
    { title: 'Index', pageStart: 1045, pageEnd: 1050, checked: false },
    { title: 'Index', pageStart: 1051, pageEnd: 1056, checked: false },
    { title: 'Index', pageStart: 1057, pageEnd: 1062, checked: false },
    { title: 'Index', pageStart: 1063, pageEnd: 1067, checked: false },
  ]);
});

test('pages 1088 through 1095 are the four unchecked back-matter slices', async () => {
  await skipIfMissing();
  const found = covering(slices, 1088, 1095);
  console.log(JSON.stringify(rows(found)));
  expect(rows(found)).toEqual([
    { title: 'About the Author', pageStart: 1088, pageEnd: 1088, checked: false },
    { title: 'About the Technical Reviewer', pageStart: 1089, pageEnd: 1089, checked: false },
    { title: 'Acknowledgments', pageStart: 1090, pageEnd: 1090, checked: false },
    { title: 'Introduction', pageStart: 1091, pageEnd: 1095, checked: false },
  ]);
});

test('every page from 1 through the last slice end is in exactly one slice', async () => {
  await skipIfMissing();
  const maxEnd = slices.reduce((max, slice) => Math.max(max, slice.pageEnd), 0);
  const counts = new Array<number>(maxEnd + 1).fill(0);
  for (const slice of slices) {
    for (let page = Math.max(slice.pageStart, 1); page <= slice.pageEnd && page <= maxEnd; page += 1) {
      counts[page] += 1;
    }
  }
  const badPages: number[] = [];
  for (let page = 1; page <= maxEnd; page += 1) {
    if (counts[page] !== 1) {
      badPages.push(page);
    }
  }
  const badSlices = slices.filter((slice) =>
    badPages.some((page) => page >= slice.pageStart && page <= slice.pageEnd),
  );
  console.log(JSON.stringify(rows(badSlices)));
  expect(maxEnd).toBeGreaterThan(0);
  expect(badPages).toEqual([]);
});
