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

const chapterHeading = /^chapter\s+\d+/i;
const indexLetter = /^[A-Z](?:\s*,\s*[A-Z])?$/;

function isChapterHeading(title: string): boolean {
  return chapterHeading.test(title.trim());
}

function isIndexLetter(title: string): boolean {
  return indexLetter.test(title.trim());
}

function findChapters(nodes: HeadingNode[]): HeadingNode[] {
  const chapters: HeadingNode[] = [];
  const walk = (list: HeadingNode[]): void => {
    for (const node of list) {
      if (isChapterHeading(node.title)) {
        chapters.push(node);
      } else {
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return chapters.sort((left, right) => left.page - right.page);
}

function hasChapter(node: HeadingNode): boolean {
  return node.children.some((child) => isChapterHeading(child.title) || hasChapter(child));
}

function reachesBeyond(node: HeadingNode): boolean {
  return node.children.some((child) => child.page > node.page + headingPageLimit);
}

function collectMarks(nodes: HeadingNode[]): Array<{ title: string; page: number }> {
  const marks: Array<{ title: string; page: number }> = [];
  const visit = (node: HeadingNode): void => {
    if (isChapterHeading(node.title)) {
      return;
    }
    if (!isIndexLetter(node.title)) {
      marks.push({ title: node.title, page: node.page });
    }
    if (hasChapter(node) || reachesBeyond(node)) {
      for (const child of node.children) {
        visit(child);
      }
    }
  };
  for (const node of nodes) {
    visit(node);
  }
  marks.sort((left, right) => left.page - right.page);
  const unique: Array<{ title: string; page: number }> = [];
  for (const mark of marks) {
    const previous = unique[unique.length - 1];
    if (!previous || previous.page !== mark.page) {
      unique.push(mark);
    }
  }
  return unique;
}

function nextOutsidePage(nodes: HeadingNode[], chapter: HeadingNode): number | null {
  let next: number | null = null;
  const consider = (page: number): void => {
    if (page > chapter.page && (next === null || page < next)) {
      next = page;
    }
  };
  const walk = (list: HeadingNode[]): void => {
    for (const node of list) {
      if (node === chapter) {
        continue;
      }
      consider(node.page);
      walk(node.children);
    }
  };
  walk(nodes);
  return next;
}

function chapterDrafts(chapter: HeadingNode, end: number): Draft[] {
  const children = chapter.children
    .filter((child) => child.page >= chapter.page && child.page <= end)
    .sort((left, right) => left.page - right.page);
  const sections: HeadingNode[] = [];
  for (const child of children) {
    const previous = sections[sections.length - 1];
    if (!previous || child.page > previous.page) {
      sections.push(child);
    }
  }
  if (sections.length === 0) {
    return chunk(chapter.title, chapter.page, end, true);
  }
  const drafts: Draft[] = [];
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index];
    const sectionEnd = index + 1 < sections.length ? sections[index + 1].page - 1 : end;
    const sectionStart = index === 0 ? chapter.page : section.page;
    if (sectionEnd >= sectionStart) {
      drafts.push(...chunk(section.title, sectionStart, sectionEnd, true));
    }
  }
  return drafts;
}

function pageCovered(spans: Array<{ start: number; end: number }>, page: number): boolean {
  return spans.some((span) => page >= span.start && page <= span.end);
}

const outsideFurniture = [
  ...frontMatterTitles,
  'cover',
  'copyright',
  'packt',
  'contributors',
  'contents',
  'introduction',
  'about the',
];

function isOutsideFurniture(title: string): boolean {
  if (title.startsWith('Pages ')) {
    return true;
  }
  const normalized = title.trim().toLowerCase();
  return outsideFurniture.some((name) => {
    if (!normalized.startsWith(name)) {
      return false;
    }
    const next = normalized.charAt(name.length);
    return next === '' || !/\p{L}/u.test(next);
  });
}

function outsideGap(
  marks: Array<{ title: string; page: number }>,
  gapStart: number,
  gapEnd: number,
): Draft[] {
  const points = marks.filter((mark) => mark.page >= gapStart && mark.page <= gapEnd);
  if (points.length === 0 || points[0].page > gapStart) {
    const titleEnd = points.length === 0 ? gapEnd : points[0].page - 1;
    points.unshift({
      title: `Pages ${gapStart}\u2013${titleEnd}`,
      page: gapStart,
    });
  }
  const drafts: Draft[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const start = points[index].page;
    const end = index + 1 < points.length ? points[index + 1].page - 1 : gapEnd;
    if (end >= start) {
      drafts.push(...chunk(points[index].title, start, end, !isOutsideFurniture(points[index].title)));
    }
  }
  return drafts;
}

function outsideDrafts(
  marks: Array<{ title: string; page: number }>,
  spans: Array<{ start: number; end: number }>,
  pageCount: number,
): Draft[] {
  const drafts: Draft[] = [];
  let page = 1;
  while (page <= pageCount) {
    if (pageCovered(spans, page)) {
      page += 1;
      continue;
    }
    let gapEnd = page;
    while (gapEnd < pageCount && !pageCovered(spans, gapEnd + 1)) {
      gapEnd += 1;
    }
    drafts.push(...outsideGap(marks, page, gapEnd));
    page = gapEnd + 1;
  }
  return drafts;
}

function chapterBookDrafts(nodes: HeadingNode[], chapters: HeadingNode[], pageCount: number): Draft[] {
  const spans = chapters
    .map((chapter) => {
      const next = nextOutsidePage(nodes, chapter);
      return { chapter, start: chapter.page, end: next === null ? pageCount : next - 1 };
    })
    .filter((span) => span.end >= span.start);
  const drafts = [
    ...outsideDrafts(
      collectMarks(nodes),
      spans.map((span) => ({ start: span.start, end: span.end })),
      pageCount,
    ),
    ...spans.flatMap((span) => chapterDrafts(span.chapter, span.end)),
  ];
  drafts.sort((left, right) => left.pageStart - right.pageStart || left.pageEnd - right.pageEnd);
  return drafts;
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
    const nodes = await readHeadings(pdf, outline);
    const chapters = findChapters(nodes);
    if (chapters.length === 0) {
      return withIds(outlineDrafts(nodes, pdf.numPages));
    }
    return withIds(chapterBookDrafts(nodes, chapters, pdf.numPages));
  } finally {
    await task.destroy();
  }
}
