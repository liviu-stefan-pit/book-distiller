import { expect, test } from '@playwright/test';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { requiredListings } from '../src/main/listings';
import { slicePdf, type Slice } from '../src/main/slicePdf';

const pdfPath = path.join(process.cwd(), 'fixtures', 'books', 'C#_9_and_.NET_5_(2020).pdf');

test.setTimeout(120_000);

type SliceRow = {
  title: string;
  pageStart: number;
  pageEnd: number;
  checked: boolean;
};

const opening: SliceRow[] = [
  { title: 'Cover', pageStart: 1, pageEnd: 2, checked: false },
  { title: 'Copyright', pageStart: 3, pageEnd: 3, checked: false },
  { title: 'Packt Page', pageStart: 4, pageEnd: 4, checked: false },
  { title: 'Contributors', pageStart: 5, pageEnd: 7, checked: false },
  { title: 'Table of Contents', pageStart: 8, pageEnd: 13, checked: false },
  { title: 'Table of Contents', pageStart: 14, pageEnd: 19, checked: false },
  { title: 'Table of Contents', pageStart: 20, pageEnd: 25, checked: false },
  { title: 'Table of Contents', pageStart: 26, pageEnd: 27, checked: false },
  { title: 'Preface', pageStart: 28, pageEnd: 33, checked: false },
  { title: 'Setting up your development environment', pageStart: 34, pageEnd: 39, checked: true },
  { title: 'Setting up your development environment', pageStart: 40, pageEnd: 40, checked: true },
  { title: 'Understanding .NET', pageStart: 41, pageEnd: 46, checked: true },
  { title: 'Understanding .NET', pageStart: 47, pageEnd: 49, checked: true },
  { title: 'Building console apps using Visual Studio Code', pageStart: 50, pageEnd: 53, checked: true },
  { title: 'Downloading solution code from the GitHub repository', pageStart: 54, pageEnd: 54, checked: true },
  { title: 'Looking for help', pageStart: 55, pageEnd: 59, checked: true },
  { title: 'Practicing and exploring', pageStart: 60, pageEnd: 60, checked: true },
  { title: 'Summary', pageStart: 61, pageEnd: 61, checked: true },
];

function row(slice: Slice): SliceRow {
  return {
    title: slice.title,
    pageStart: slice.pageStart,
    pageEnd: slice.pageEnd,
    checked: slice.checked,
  };
}

let bytesPromise: Promise<Uint8Array> | undefined;
let slicesPromise: Promise<Slice[]> | undefined;

async function loadBytes(): Promise<Uint8Array> {
  try {
    await access(pdfPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      test.skip(true, pdfPath);
    }
    throw error;
  }
  bytesPromise ??= readFile(pdfPath).then((buffer) => new Uint8Array(buffer));
  return bytesPromise;
}

async function loadSlices(): Promise<Slice[]> {
  const bytes = await loadBytes();
  slicesPromise ??= slicePdf(bytes);
  return slicesPromise;
}

test('pages 1 through 61 are the opening slices', async () => {
  const slices = await loadSlices();
  const actual = slices
    .filter((slice) => slice.pageStart <= 61 && slice.pageEnd >= 1)
    .map(row);
  console.log(JSON.stringify(actual));
  expect(actual).toEqual(opening);
});

test('no slice is titled Understanding .NET Framework', async () => {
  const slices = await loadSlices();
  const actual = slices.filter((slice) => slice.title === 'Understanding .NET Framework').map(row);
  console.log(JSON.stringify(actual));
  expect(actual).toEqual([]);
});

test('every page through the last slice end is covered once', async () => {
  const slices = await loadSlices();
  const counts = new Map<number, number>();
  let max = 0;
  for (const slice of slices) {
    max = Math.max(max, slice.pageEnd);
    for (let page = slice.pageStart; page <= slice.pageEnd; page += 1) {
      counts.set(page, (counts.get(page) ?? 0) + 1);
    }
  }
  const covered = Array.from({ length: max }, (_, index) => counts.get(index + 1) ?? 0);
  const actual = slices
    .filter((slice) => {
      for (let page = slice.pageStart; page <= slice.pageEnd; page += 1) {
        if ((counts.get(page) ?? 0) !== 1) {
          return true;
        }
      }
      return false;
    })
    .map(row);
  console.log(JSON.stringify(actual));
  expect(covered).toEqual(Array.from({ length: max }, () => 1));
});

test('page 3 and page 34 listings omit the running header', async () => {
  const bytes = await loadBytes();
  const page3 = (await requiredListings(bytes, 3, 3)).map((line) => line.trim());
  console.log(JSON.stringify(page3));
  expect(page3).not.toContain('www.packt.com');
  const page34 = (await requiredListings(bytes, 34, 34)).map((line) => line.trim());
  console.log(JSON.stringify(page34));
  expect(page34).not.toContain('01');
});
