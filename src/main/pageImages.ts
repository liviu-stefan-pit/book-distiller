import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCanvas, DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';

const nodeRequire = createRequire(import.meta.url);

GlobalWorkerOptions.workerSrc = pathToFileURL(
  nodeRequire.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

export type RenderedPage = {
  jpeg: Buffer;
  width: number;
  height: number;
};

function ensureDomCanvasGlobals(): void {
  const globals = globalThis as Record<string, unknown>;
  if (globals.DOMMatrix === undefined) {
    globals.DOMMatrix = DOMMatrix;
  }
  if (globals.Path2D === undefined) {
    globals.Path2D = Path2D;
  }
  if (globals.ImageData === undefined) {
    globals.ImageData = ImageData;
  }
}

export async function renderPageImages(
  bytes: Uint8Array,
  pageStart: number,
  pageEnd: number,
  directory: string,
): Promise<RenderedPage[]> {
  ensureDomCanvasGlobals();
  const task = getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  try {
    const pdf = await task.promise;
    const pages: RenderedPage[] = [];
    for (let pageNumber = pageStart; pageNumber <= pageEnd; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const unscaled = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: 1200 / unscaled.width });
      const width = Math.max(1, Math.floor(viewport.width));
      const height = Math.max(1, Math.floor(viewport.height));
      const canvas = createCanvas(width, height);
      const canvasContext = canvas.getContext('2d');
      if (!canvasContext) {
        throw new Error(`Page ${pageNumber} has no canvas context.`);
      }
      await page.render({ canvas, canvasContext, viewport }).promise;
      const jpeg = canvas.toBuffer('image/jpeg', 80);
      await writeFile(join(directory, `page-${pageNumber}.jpg`), jpeg);
      pages.push({ jpeg, width: canvas.width, height: canvas.height });
    }
    return pages;
  } finally {
    await task.destroy();
  }
}
