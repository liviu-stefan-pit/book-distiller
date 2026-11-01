import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const nodeRequire = createRequire(import.meta.url);

/** file URL of the PDF.js worker. Inside an asar, point at the unpacked copy. */
export function pdfWorkerSrc(): string {
  const resolved = nodeRequire.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
  const unpacked = resolved.includes('app.asar.unpacked')
    ? resolved
    : resolved.replace('app.asar', 'app.asar.unpacked');
  return pathToFileURL(unpacked).href;
}
