import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';

const nodeRequire = createRequire(import.meta.url);

GlobalWorkerOptions.workerSrc = pathToFileURL(
  nodeRequire.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

type PdfTextItem = {
  str?: string;
  transform?: number[];
  fontName?: string;
};

type BuiltLine = {
  text: string;
  y: number;
  monospaceChars: boolean;
  otherChars: boolean;
};

function ignorableListing(line: string): boolean {
  const text = line.trim();
  if (/^\d+$/.test(text)) {
    return true;
  }
  if (/^https?:\/\/\S+$/i.test(text)) {
    return true;
  }
  if (/^www\.\S+$/i.test(text)) {
    return true;
  }
  return /^[a-z0-9-]+\.(com|org|net|io|dev)(?:\/\S*)?$/i.test(text);
}

export async function readSlice(
  bytes: Uint8Array,
  pageStart: number,
  pageEnd: number,
): Promise<{ text: string; listings: string[] }> {
  const task = getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  const pdf = await task.promise;
  try {
    const pages: string[] = [];
    const listings: string[] = [];
    let run: string[] = [];
    const flush = (): void => {
      if (run.length === 1 && ignorableListing(run[0])) {
        run = [];
        return;
      }
      if (run.length > 0) {
        listings.push(run.join('\n'));
        run = [];
      }
    };
    for (let pageNumber = pageStart; pageNumber <= pageEnd; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const styles = content.styles as Record<string, { fontFamily?: string }>;
      const lines: BuiltLine[] = [];
      for (const item of content.items as PdfTextItem[]) {
        if (typeof item.str !== 'string') {
          continue;
        }
        const y = item.transform?.[5] ?? 0;
        const monospace = styles[item.fontName ?? '']?.fontFamily === 'monospace';
        const last = lines[lines.length - 1];
        if (!last || Math.abs(y - last.y) > 2) {
          lines.push({
            text: item.str,
            y,
            monospaceChars: item.str.trim() !== '' && monospace,
            otherChars: item.str.trim() !== '' && !monospace,
          });
        } else {
          last.text += item.str;
          if (item.str.trim() !== '') {
            if (monospace) {
              last.monospaceChars = true;
            } else {
              last.otherChars = true;
            }
          }
        }
      }
      const pageLines: string[] = [];
      for (const line of lines) {
        if (line.text.trim() === '') {
          flush();
          continue;
        }
        pageLines.push(line.text);
        if (line.monospaceChars && !line.otherChars) {
          run.push(line.text.trim());
        } else {
          flush();
        }
      }
      pages.push(`--- PAGE ${pageNumber} ---\n${pageLines.join('\n')}`);
    }
    flush();
    return { text: `${pages.join('\n')}\n`, listings };
  } finally {
    await task.destroy();
  }
}

export async function requiredListings(
  bytes: Uint8Array,
  pageStart: number,
  pageEnd: number,
): Promise<string[]> {
  return (await readSlice(bytes, pageStart, pageEnd)).listings;
}
