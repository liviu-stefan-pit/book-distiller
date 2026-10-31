import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';

const nodeRequire = createRequire(import.meta.url);

GlobalWorkerOptions.workerSrc = pathToFileURL(
  nodeRequire.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

export type Slice = {
  id: string;
  title: string;
  pageStart: number;
  pageEnd: number;
  checked: boolean;
};

const headingPageLimit = 6;
const windowPageLimit = 4;

const frontMatterTitles = [
  'preface',
  'foreword',
  'acknowledgments',
  'about the author',
  'table of contents',
  'bibliography',
  'glossary',
  'index',
  'appendix',
];

type OutlineItem = {
  title: string;
  dest: unknown;
  items?: OutlineItem[];
};

type PdfFile = {
  numPages: number;
  getOutline(): Promise<OutlineItem[] | null>;
  getDestination(id: string): Promise<unknown[] | null>;
  getPageIndex(ref: object): Promise<number>;
  getPage(pageNumber: number): Promise<{
    getTextContent(): Promise<{ items: Array<{ str?: string }> }>;
  }>;
};

type Draft = {
  title: string;
  pageStart: number;
  pageEnd: number;
  checked: boolean;
};

function isFrontMatter(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  return frontMatterTitles.some((name) => {
    if (!normalized.startsWith(name)) {
      return false;
    }
    const next = normalized.charAt(name.length);
    return next === '' || !/\p{L}/u.test(next);
  });
}

function slug(title: string): string {
  const base = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return base === '' ? 'slice' : base;
}

function chunk(title: string, start: number, end: number, checked: boolean): Draft[] {
  const drafts: Draft[] = [];
  for (let page = start; page <= end; page += headingPageLimit) {
    drafts.push({
      title,
      pageStart: page,
      pageEnd: Math.min(page + headingPageLimit - 1, end),
      checked,
    });
  }
  return drafts;
}

function withIds(drafts: Draft[]): Slice[] {
  const used = new Set<string>();
  return drafts.map((draft) => {
    const base = slug(draft.title);
    let id = used.has(base) ? `${base}-${draft.pageStart}` : base;
    while (used.has(id)) {
      id = `${id}-${draft.pageStart}`;
    }
    used.add(id);
    return { id, ...draft };
  });
}

async function destinationPage(pdf: PdfFile, dest: unknown): Promise<number | null> {
  const resolved = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
  const target = Array.isArray(resolved) ? resolved[0] : undefined;
  if (typeof target !== 'object' || target === null) {
    return null;
  }
  return (await pdf.getPageIndex(target)) + 1;
}

type HeadingNode = {
  title: string;
  page: number;
  children: HeadingNode[];
};

async function readHeadings(pdf: PdfFile, items: OutlineItem[]): Promise<HeadingNode[]> {
  const headings: HeadingNode[] = [];
  for (const item of items) {
    const page = await destinationPage(pdf, item.dest);
    if (page === null) {
      continue;
    }
    headings.push({
      title: item.title,
      page,
      children: await readHeadings(pdf, item.items ?? []),
    });
  }
  return headings.sort((left, right) => left.page - right.page);
}

function headingDrafts(node: HeadingNode, start: number, end: number): Draft[] {
  if (end < start) {
    return [];
  }
  const checked = !isFrontMatter(node.title);
  if (end - start + 1 <= headingPageLimit) {
    return chunk(node.title, start, end, checked);
  }
  const children = node.children.filter((child) => child.page >= start && child.page <= end);
  if (children.length === 0) {
    return chunk(node.title, start, end, checked);
  }
  const drafts: Draft[] = [];
  let cursor = start;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    const childEnd = index + 1 < children.length ? children[index + 1].page - 1 : end;
    if (child.page > cursor) {
      drafts.push(...chunk(node.title, cursor, child.page - 1, checked));
    }
    if (childEnd >= child.page) {
      drafts.push(...headingDrafts(child, child.page, childEnd));
      cursor = childEnd + 1;
    }
  }
  if (cursor <= end) {
    drafts.push(...chunk(node.title, cursor, end, checked));
  }
  return drafts;
}

async function pageTexts(pdf: PdfFile): Promise<string[]> {
  const texts: string[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    texts.push(content.items.map((item) => item.str ?? '').join(''));
  }
  return texts;
}

function windowDrafts(texts: string[]): Draft[] {
  const drafts: Draft[] = [];
  for (let start = 1; start <= texts.length; start += windowPageLimit) {
    const end = Math.min(start + windowPageLimit - 1, texts.length);
    const text = texts.slice(start - 1, end).join('');
    drafts.push({
      title: `Pages ${start}\u2013${end}`,
      pageStart: start,
      pageEnd: end,
      checked: !isFrontMatter(text),
    });
  }
  return drafts;
}

function gapDrafts(start: number, end: number): Draft[] {
  return chunk('Pages', start, end, false).map((draft) => ({
    ...draft,
    title: `Pages ${draft.pageStart}\u2013${draft.pageEnd}`,
  }));
}

function outlineDrafts(nodes: HeadingNode[], pageCount: number): Draft[] {
  const drafts: Draft[] = [];
  let cursor = 1;
  for (let index = 0; index < nodes.length; index += 1) {
    const start = nodes[index].page;
    if (start > cursor) {
      drafts.push(...gapDrafts(cursor, start - 1));
    }
    const end = index + 1 < nodes.length ? nodes[index + 1].page - 1 : pageCount;
    drafts.push(...headingDrafts(nodes[index], start, end));
    cursor = Math.max(cursor, end + 1);
  }
  if (cursor <= pageCount) {
    drafts.push(...gapDrafts(cursor, pageCount));
  }
  return drafts;
}

export async function slicePdf(bytes: Uint8Array): Promise<Slice[]> {
  const task = getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  const pdf = (await task.promise) as PdfFile;
  try {
    const outline = await pdf.getOutline();
    if (!outline || outline.length === 0) {
      return withIds(windowDrafts(await pageTexts(pdf)));
    }
    return withIds(outlineDrafts(await readHeadings(pdf, outline), pdf.numPages));
  } finally {
    await task.destroy();
  }
}
