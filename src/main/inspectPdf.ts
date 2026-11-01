import { basename } from 'node:path';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { pdfWorkerSrc } from './pdfWorker';

GlobalWorkerOptions.workerSrc = pdfWorkerSrc();

export type PdfDecision =
  | { accepted: true; title: string; pageCount: number }
  | { accepted: false; message: string };

const textPageLetters = 40;
const minimumTextPageRatio = 0.8;

function letterCount(text: string): number {
  return text.match(/\p{L}/gu)?.length ?? 0;
}

export async function inspectPdf(bytes: Uint8Array, fileName: string): Promise<PdfDecision> {
  const task = getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  const pdf = await task.promise;
  try {
    let textPages = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items.map((item) => ('str' in item ? item.str : '')).join('');
      if (letterCount(text) >= textPageLetters) {
        textPages += 1;
      }
    }

    if (pdf.numPages === 0 || textPages / pdf.numPages < minimumTextPageRatio) {
      return { accepted: false, message: 'This PDF has too little text to read.' };
    }

    const metadata = await pdf.getMetadata();
    const info = metadata.info;
    const rawTitle = info && typeof info === 'object' && 'Title' in info ? info.Title : '';
    const title =
      typeof rawTitle === 'string' && rawTitle.trim() !== '' ? rawTitle.trim() : basename(fileName);
    return { accepted: true, title, pageCount: pdf.numPages };
  } finally {
    await task.destroy();
  }
}
