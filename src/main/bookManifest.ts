const COMPOSED_PDF = 'composed.pdf';
const COMPOSED_PDF_FIELD = '"composedPdf": "composed.pdf"';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function previousOriginPath(previousText: string): string | undefined {
  try {
    const parsed = JSON.parse(previousText) as unknown;
    return isRecord(parsed) && typeof parsed.originPath === 'string' ? parsed.originPath : undefined;
  } catch {
    return undefined;
  }
}

export function nextManifestText(
  previousText: string,
  nextManifest: Record<string, unknown>,
): string {
  const body: Record<string, unknown> = { ...nextManifest };
  if (body.originPath === undefined) {
    const origin = previousOriginPath(previousText);
    if (origin !== undefined) {
      body.originPath = origin;
    }
  }
  if (previousText.includes(COMPOSED_PDF_FIELD)) {
    body.composedPdf = COMPOSED_PDF;
  }
  return `${JSON.stringify(body, null, 2)}\n`;
}

export function setComposedPdf(manifestText: string): string {
  const parsed = JSON.parse(manifestText) as unknown;
  if (!isRecord(parsed)) {
    throw new Error('book manifest is not an object');
  }
  return `${JSON.stringify({ ...parsed, composedPdf: COMPOSED_PDF }, null, 2)}\n`;
}

export function composedPdfReady(manifestText: string, fileExists: boolean): boolean {
  if (!fileExists) {
    return false;
  }
  try {
    const parsed = JSON.parse(manifestText) as unknown;
    return isRecord(parsed) && parsed.composedPdf === COMPOSED_PDF;
  } catch {
    return false;
  }
}
