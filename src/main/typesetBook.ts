import { NodeCompiler } from '@myriaddreamin/typst-ts-node-compiler';
import type { Chapter, ChapterBlock } from './compose';

function typstString(value: string): string {
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r\n/g, '\\n')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\n')}"`;
}

function content(value: string): string {
  return `#${typstString(value)}`;
}

function rawBlock(language: string, source: string): string {
  if (language === '') {
    return `#raw(block: true, ${typstString(source)})`;
  }
  return `#raw(block: true, lang: ${typstString(language)}, ${typstString(source)})`;
}

function calloutLabel(kind: 'added' | 'current-practice' | 'added-example'): string {
  if (kind === 'added') {
    return 'Added';
  }
  if (kind === 'current-practice') {
    return 'Current practice';
  }
  return 'Added example';
}

function renderBlock(block: ChapterBlock): string {
  if (block.type === 'prose') {
    return `#par[${content(block.text)}]\n`;
  }
  if (block.type === 'code') {
    const lines = [rawBlock(block.language, block.source)];
    if (block.caption !== undefined) {
      lines.push(`#par[${content(block.caption)}]`);
    }
    return `${lines.join('\n')}\n`;
  }
  const lines = [
    `#block(width: 100%, inset: 10pt, stroke: 0.5pt + luma(160), fill: luma(248))[`,
    `  #strong[${content(calloutLabel(block.kind))}] — ${content(block.title)}`,
    `  #par[${content(block.text)}]`,
  ];
  if (block.code) {
    lines.push(`  ${rawBlock(block.code.language, block.code.source)}`);
  }
  lines.push(`]\n`);
  return `${lines.join('\n')}`;
}

function groupedChapters(chapters: Chapter[]): Array<{ title: string; parts: Chapter[] }> {
  const groups: Array<{ title: string; parts: Chapter[] }> = [];
  for (const chapter of chapters) {
    const last = groups[groups.length - 1];
    if (last && last.title === chapter.title) {
      last.parts.push(chapter);
    } else {
      groups.push({ title: chapter.title, parts: [chapter] });
    }
  }
  return groups;
}

function typstSource(title: string, chapters: Chapter[]): string {
  const parts: string[] = [
    `#set page(width: 7in, height: 9.25in, margin: (x: 0.75in, top: 0.85in, bottom: 0.75in), numbering: none)`,
    `#set text(font: "Libertinus Serif", size: 11pt)`,
    `#show raw: set text(font: "Libertinus Mono", size: 9pt)`,
    `#set par(justify: true)`,
    `#let book-title = ${typstString(title)}`,
    `#align(center + horizon)[#text(size: 22pt, weight: "bold")[#book-title]]`,
    `#pagebreak()`,
    `#outline(title: "Contents")`,
    `#pagebreak()`,
    `#set page(`,
    `  numbering: "1",`,
    `  header: context {`,
    `    let prior = query(selector(heading.where(level: 1)).before(here()))`,
    `    let current = if prior.len() > 0 { prior.last().body } else { [] }`,
    `    grid(`,
    `      columns: (1fr, 1fr),`,
    `      align(left)[#text(size: 9pt)[#book-title]],`,
    `      align(right)[#text(size: 9pt)[#current]],`,
    `    )`,
    `  },`,
    `  footer: context {`,
    `    align(center)[#counter(page).display()]`,
    `  },`,
    `)`,
    `#counter(page).update(1)`,
  ];
  for (const group of groupedChapters(chapters)) {
    parts.push(`= ${content(group.title)}`);
    const split = group.parts.length > 1;
    for (const [index, chapter] of group.parts.entries()) {
      if (split) {
        parts.push(`== ${content(`Part ${index + 1}`)}`);
      }
      for (const block of chapter.blocks) {
        parts.push(renderBlock(block));
      }
    }
  }
  return `${parts.join('\n')}\n`;
}

export function typesetBook(title: string, chapters: Chapter[]): Buffer {
  const compiler = NodeCompiler.create();
  const compiled = compiler.compile({ mainFileContent: typstSource(title, chapters) });
  if (compiled.hasError() || compiled.result === null) {
    const error = compiled.takeError() ?? compiled.takeDiagnostics();
    const detail = error?.shortDiagnostics
      ? JSON.stringify(error.shortDiagnostics)
      : 'typst compilation failed';
    throw new Error(detail);
  }
  const pdf = compiler.pdf(compiled.result);
  if (pdf.subarray(0, 4).toString('utf8') !== '%PDF') {
    throw new Error('typst compilation did not produce a PDF');
  }
  return pdf;
}
