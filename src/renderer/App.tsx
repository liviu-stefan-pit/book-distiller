import { useState, type ChangeEvent, type DragEvent } from 'react';
import type { PdfDecision } from '../main/inspectPdf';

export function App() {
  const [decision, setDecision] = useState<PdfDecision | null>(null);

  async function openFile(file: File): Promise<void> {
    const next = await window.bookDistiller.inspectPdf(new Uint8Array(await file.arrayBuffer()), file.name);
    setDecision(next);
    document.title = next.accepted ? next.title : 'Book Distiller';
  }

  function onDrop(event: DragEvent<HTMLParagraphElement>): void {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file) {
      void openFile(file);
    }
  }

  function onChoose(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    if (file) {
      void openFile(file);
    }
  }

  return (
    <main>
      <h1>Book Distiller</h1>
      <p onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
        Drop a PDF
      </p>
      <label>
        Choose a PDF
        <input type="file" accept="application/pdf,.pdf" onChange={onChoose} />
      </label>
      {decision?.accepted ? (
        <>
          <p>{decision.title}</p>
          <p>{decision.pageCount === 1 ? '1 page' : `${decision.pageCount} pages`}</p>
        </>
      ) : null}
      {decision && !decision.accepted ? <p>{decision.message}</p> : null}
    </main>
  );
}
