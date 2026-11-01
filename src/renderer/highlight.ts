export type TokenKind = 'plain' | 'comment' | 'string' | 'number' | 'keyword';

export type Token = {
  text: string;
  kind: TokenKind;
};

type Lang = {
  keywords: ReadonlySet<string>;
  slash: boolean;
  hash: boolean;
  dash: boolean;
};

function lang(words: string, slash: boolean, hash: boolean, dash: boolean): Lang {
  return { keywords: new Set(words.split(' ')), slash, hash, dash };
}

const RUST = lang(
  'fn let mut const impl struct enum trait pub use mod if else match for while loop return self where async await move ref type',
  true,
  false,
  false,
);
const CSHARP = lang(
  'class struct interface public private protected internal static void int string bool var new return if else for foreach while namespace using async await',
  true,
  false,
  false,
);
const JS = lang(
  'function const let var class return if else for while import export async await new this type interface extends',
  true,
  false,
  false,
);
const PYTHON = lang(
  'def class return if elif else for while import from as with lambda yield async await not and or in is',
  false,
  true,
  false,
);
const SQL = lang(
  'select from where join left right inner outer on group by order having insert into values update set delete create table and or not null',
  true,
  true,
  true,
);
const JAVA = lang(
  'class public private protected static void int new return if else for while import package',
  true,
  false,
  false,
);
const GO = lang(
  'func package import var const type struct interface return if else for range go defer',
  true,
  false,
  false,
);
const C_FAMILY = lang(
  'int void char return if else for while struct class public private',
  true,
  false,
  false,
);

function resolveLang(language: string): Lang | null {
  switch (language.trim().toLowerCase()) {
    case 'rust':
      return RUST;
    case 'c#':
    case 'csharp':
    case 'cs':
      return CSHARP;
    case 'javascript':
    case 'js':
    case 'typescript':
    case 'ts':
      return JS;
    case 'python':
    case 'py':
      return PYTHON;
    case 'sql':
      return SQL;
    case 'java':
      return JAVA;
    case 'go':
      return GO;
    case 'c':
    case 'cpp':
    case 'c++':
      return C_FAMILY;
    default:
      return null;
  }
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isIdentStart(ch: string): boolean {
  return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_';
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}

function startsToken(line: string, i: number, rules: Lang): boolean {
  const c = line.charAt(i);
  const next = line.charAt(i + 1);
  if (rules.slash && c === '/' && (next === '/' || next === '*')) return true;
  if (rules.hash && c === '#') return true;
  if (rules.dash && c === '-' && next === '-') return true;
  if (c === '"' || c === "'") return true;
  if (isDigit(c) && !isIdentPart(line.charAt(i - 1))) return true;
  if (isIdentStart(c)) return true;
  return false;
}

function tokenizeLine(line: string, rules: Lang, block: { open: boolean }): Token[] {
  const tokens: Token[] = [];
  const n = line.length;
  let i = 0;

  while (i < n) {
    if (block.open) {
      const close = line.indexOf('*/', i);
      if (close < 0) {
        tokens.push({ text: line.slice(i), kind: 'comment' });
        break;
      }
      tokens.push({ text: line.slice(i, close + 2), kind: 'comment' });
      i = close + 2;
      block.open = false;
      continue;
    }

    const c = line.charAt(i);
    const next = line.charAt(i + 1);

    if (rules.slash && c === '/' && next === '/') {
      tokens.push({ text: line.slice(i), kind: 'comment' });
      break;
    }

    if (rules.slash && c === '/' && next === '*') {
      const close = line.indexOf('*/', i + 2);
      if (close < 0) {
        tokens.push({ text: line.slice(i), kind: 'comment' });
        block.open = true;
        break;
      }
      tokens.push({ text: line.slice(i, close + 2), kind: 'comment' });
      i = close + 2;
      continue;
    }

    if (rules.hash && c === '#') {
      tokens.push({ text: line.slice(i), kind: 'comment' });
      break;
    }

    if (rules.dash && c === '-' && next === '-') {
      tokens.push({ text: line.slice(i), kind: 'comment' });
      break;
    }

    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        if (line.charAt(j) === '\\') {
          j = Math.min(j + 2, n);
          continue;
        }
        if (line.charAt(j) === c) {
          j += 1;
          break;
        }
        j += 1;
      }
      tokens.push({ text: line.slice(i, j), kind: 'string' });
      i = j;
      continue;
    }

    if (isDigit(c) && !isIdentPart(line.charAt(i - 1))) {
      let j = i + 1;
      while (j < n && isDigit(line.charAt(j))) j += 1;
      if (line.charAt(j) === '.' && isDigit(line.charAt(j + 1))) {
        j += 2;
        while (j < n && isDigit(line.charAt(j))) j += 1;
      }
      tokens.push({ text: line.slice(i, j), kind: 'number' });
      i = j;
      continue;
    }

    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(line.charAt(j))) j += 1;
      const text = line.slice(i, j);
      tokens.push({
        text,
        kind: rules.keywords.has(text) ? 'keyword' : 'plain',
      });
      i = j;
      continue;
    }

    let j = i + 1;
    while (j < n && !startsToken(line, j, rules)) j += 1;
    tokens.push({ text: line.slice(i, j), kind: 'plain' });
    i = j;
  }

  return tokens;
}

/** One token array per source line, including a final empty line if the source ends with a newline. Unknown or empty language: every token kind is 'plain', still split into lines. */
export function highlightSource(source: string, language: string): Token[][] {
  const lines = source.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const rules = resolveLang(language);
  if (!rules) {
    return lines.map((line) => (line === '' ? [] : [{ text: line, kind: 'plain' }]));
  }
  const block = { open: false };
  return lines.map((line) => tokenizeLine(line, rules, block));
}

const MAX_RANGE = 500;
const LINE_REF = /(\d+)\s*[-\u2013\u2014]\s*(\d+)|\d+/g;

function parseLineNumber(raw: string): number | null {
  if (raw.length > 15) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  return n;
}

/** 1-based line numbers mentioned by note `lines` strings. */
export function notedLineNumbers(notes: Array<{ lines: string }>): Set<number> {
  const found = new Set<number>();
  for (const note of notes) {
    LINE_REF.lastIndex = 0;
    for (const match of note.lines.matchAll(LINE_REF)) {
      const at = match.index;
      const endAt = at + match[0].length;
      if (isIdentPart(note.lines.charAt(at - 1)) || isIdentPart(note.lines.charAt(endAt))) {
        continue;
      }
      const startRaw = match[1];
      const endRaw = match[2];
      if (startRaw !== undefined && endRaw !== undefined) {
        const start = parseLineNumber(startRaw);
        const end = parseLineNumber(endRaw);
        if (start === null || end === null || end < start) continue;
        const count = end - start > MAX_RANGE - 1 ? MAX_RANGE : end - start + 1;
        for (let offset = 0; offset < count; offset += 1) found.add(start + offset);
        continue;
      }
      const single = parseLineNumber(match[0]);
      if (single !== null) found.add(single);
    }
  }
  return found;
}
