import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import type { Board, DistillSlice } from '../main/distill';
import type { PdfDecision } from '../main/inspectPdf';
import type { Slice } from '../main/slicePdf';

function pageRange(start: number, end: number): string {
  return `${start}\u2013${end}`;
}

const pointKinds = [
  ['must-remember', 'Must remember'],
  ['mechanics', 'Mechanics'],
  ['useful-later', 'Useful later'],
] as const;

function BoardView({ board, onPage }: { board: Board; onPage: (page: number) => void }) {
  if (board.points.length === 0 && board.code.length === 0) {
    return <p>Those pages had no technical content.</p>;
  }
  return (
    <>
      {pointKinds.map(([kind, heading]) => (
        <section key={kind}>
          <h2>{heading}</h2>
          {board.points
            .filter((point) => point.kind === kind)
            .map((point) => {
              const example = point.example;
              return (
                <article key={`${point.kind}-${point.title}-${point.page}`}>
                  <h3>{point.title}</h3>
                  <p>{point.explanation}</p>
                  <p>
                    <button type="button" onClick={() => onPage(point.page)}>
                      Page {point.page}
                    </button>
                  </p>
                  {example ? (
                    <p>
                      {example.text}{' '}
                      <button type="button" onClick={() => onPage(example.page)}>
                        Page {example.page}
                      </button>
                    </p>
                  ) : null}
                </article>
              );
            })}
        </section>
      ))}
      <section>
        <h2>Code</h2>
        {board.code.map((block) => (
          <article key={`${block.title}-${block.page}`}>
            <h3>{block.title}</h3>
            <p>{block.language}</p>
            <p>
              <button type="button" onClick={() => onPage(block.page)}>
                Page {block.page}
              </button>
            </p>
            <pre>{block.source}</pre>
            {block.notes.map((note) => (
              <p key={`${note.lines}-${note.why}`}>
                {note.lines} {note.why}
              </p>
            ))}
          </article>
        ))}
      </section>
    </>
  );
}

function PageDrawer({
  pdfBytes,
  page,
  pageStart,
  pageEnd,
  onPage,
}: {
  pdfBytes: Uint8Array;
  page: number;
  pageStart: number;
  pageEnd: number;
  onPage: (page: number) => void;
}) {
  const frameRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const frame = frameRef.current;
    const canvas = canvasRef.current;
    if (!frame || !canvas) {
      return;
    }
    let cancelled = false;
    let destroyed = false;
    const bytes = pdfBytes.slice();
    let loading: { destroy: () => Promise<void> } | undefined;
    const destroy = (): void => {
      if (destroyed || !loading) {
        return;
      }
      destroyed = true;
      void loading.destroy();
    };
    void (async () => {
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const worker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
      (globalThis as { pdfjsWorker?: { WorkerMessageHandler: unknown } }).pdfjsWorker = {
        WorkerMessageHandler: worker.WorkerMessageHandler,
      };
      const opened = pdfjs.getDocument({ data: bytes, verbosity: 0 });
      loading = opened;
      try {
        const pdf = await opened.promise;
        if (cancelled) {
          return;
        }
        const pdfPage = await pdf.getPage(page);
        const width = frame.clientWidth;
        const unscaled = pdfPage.getViewport({ scale: 1 });
        const viewport = pdfPage.getViewport({ scale: width > 0 ? width / unscaled.width : 1 });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const context = canvas.getContext('2d');
        if (!context || cancelled) {
          return;
        }
        await pdfPage.render({ canvas, canvasContext: context, viewport }).promise;
      } finally {
        destroy();
      }
    })();
    return () => {
      cancelled = true;
      destroy();
    };
  }, [pdfBytes, page]);

  return (
    <aside className="drawer" aria-label={`Page ${page}`} ref={frameRef}>
      <canvas ref={canvasRef} />
      <button type="button" onClick={() => onPage(Math.max(pageStart, page - 1))}>
        Previous
      </button>
      <button type="button" onClick={() => onPage(Math.min(pageEnd, page + 1))}>
        Next
      </button>
    </aside>
  );
}

export function App() {
  const [decision, setDecision] = useState<PdfDecision | null>(null);
  const [pdfPath, setPdfPath] = useState('');
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const [study, setStudy] = useState<DistillSlice[]>([]);
  const [drawer, setDrawer] = useState<{ page: number; pageStart: number; pageEnd: number } | null>(null);
  const [slices, setSlices] = useState<Slice[]>([]);
  const [folderPath, setFolderPath] = useState('');
  const [folderMessage, setFolderMessage] = useState('');
  const [draftKey, setDraftKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [modelIds, setModelIds] = useState<string[]>([]);
  const [modelId, setModelId] = useState('');
  const [keyMessage, setKeyMessage] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [bookTitle, setBookTitle] = useState('');
  const [showAllSlices, setShowAllSlices] = useState(false);
  const [pdfMissing, setPdfMissing] = useState(false);
  const [showMissingPdf, setShowMissingPdf] = useState(false);
  const [screen, setScreen] = useState<'launchpad' | 'checklist' | 'study'>('launchpad');
  const [queueRunning, setQueueRunning] = useState(false);
  const [redoFailure, setRedoFailure] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const keyLocked = useRef(false);
  const folderChosen = useRef(false);
  const picked = useRef(false);

  useEffect(() => {
    let current = true;
    void window.bookDistiller
      .session()
      .then((session) => {
        if (!current) {
          return;
        }
        if (!keyLocked.current) {
          setHasKey(session.hasKey);
          setModelIds(session.modelIds);
          setModelId(session.modelId);
        }
        if (!folderChosen.current) {
          setFolderPath(session.folderPath);
        }
      })
      .catch(() => {
        if (!current || keyLocked.current) {
          return;
        }
        setKeyMessage('The saved key could not be read.');
      });
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    return window.bookDistiller.onDistillProgress((next) => {
      setStudy(next);
      if (picked.current) {
        return;
      }
      const latest = [...next].reverse().find((slice) => slice.status === 'done' && slice.board);
      if (latest) {
        setOpenId((current) => {
          if (current !== latest.id) {
            setDrawer(null);
          }
          return latest.id;
        });
      }
    });
  }, []);

  async function openFile(file: File): Promise<void> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const filePath = window.bookDistiller.pathForFile(file);
    const opened = await window.bookDistiller.inspectPdf(bytes, file.name, filePath);
    setPdfPath(filePath);
    setPdfBytes(bytes);
    setPdfMissing(false);
    setShowMissingPdf(false);
    setDecision(opened);
    setSlices([]);
    setStudy([]);
    setOpenId(null);
    picked.current = false;
    setDrawer(null);
    setScreen('launchpad');
    document.title = opened.accepted ? opened.title : 'Book Distiller';
  }

  async function start(): Promise<void> {
    if (!pdfBytes) {
      return;
    }
    setSlices(await window.bookDistiller.slicePdf(pdfBytes));
    setScreen('checklist');
  }

  async function saveKey(): Promise<void> {
    const result = await window.bookDistiller.saveKey(draftKey);
    if (result.status === 'error') {
      setKeyMessage(result.message);
      return;
    }
    keyLocked.current = true;
    setDraftKey('');
    setHasKey(true);
    setReplacing(false);
    setModelIds(result.modelIds);
    setModelId((current) => (result.modelIds.includes(current) ? current : ''));
    setKeyMessage('');
  }

  function beginReplace(): void {
    keyLocked.current = true;
    setDraftKey('');
    setReplacing(true);
    setKeyMessage('');
  }

  async function forgetKey(): Promise<void> {
    keyLocked.current = true;
    await window.bookDistiller.forgetKey();
    setDraftKey('');
    setHasKey(false);
    setReplacing(false);
    setModelIds([]);
    setModelId('');
    setKeyMessage('');
  }

  async function chooseFolder(): Promise<void> {
    const choice = await window.bookDistiller.chooseFolder();
    if (choice.status === 'refused') {
      folderChosen.current = true;
      setFolderPath('');
      setFolderMessage(choice.message);
      return;
    }
    if (choice.status !== 'chosen') {
      return;
    }
    folderChosen.current = true;
    const opened = await window.bookDistiller.openBook(choice.folderPath);
    if (opened.status === 'opened') {
      setFolderPath(choice.folderPath);
      setFolderMessage('');
      setPdfPath(opened.pdfPath);
      setPdfBytes(opened.pdfMissing ? null : opened.pdfBytes);
      setBookTitle(opened.title);
      setPdfMissing(opened.pdfMissing);
      setShowMissingPdf(false);
      setShowAllSlices(true);
      setStudy(opened.slices);
      setDrawer(null);
      setQueueRunning(false);
      const first = opened.slices.find((slice) => slice.status === 'done' && slice.board);
      setOpenId(first ? first.id : null);
      picked.current = true;
      setScreen('study');
      return;
    }
    if (opened.status === 'refused') {
      setFolderPath('');
      setFolderMessage(opened.message);
      return;
    }
    setFolderPath(choice.folderPath);
    setFolderMessage('');
  }

  function toggleStudy(id: string): void {
    const next = study.map((slice) => (slice.id === id ? { ...slice, checked: !slice.checked } : slice));
    setStudy(next);
    if (folderPath !== '') {
      void window.bookDistiller.setChecks(
        folderPath,
        next.map((slice) => ({ id: slice.id, checked: slice.checked })),
      );
    }
  }

  function openDone(slice: DistillSlice): void {
    if (slice.status !== 'done' || !slice.board) {
      return;
    }
    picked.current = true;
    setDrawer(null);
    setOpenId(slice.id);
  }

  async function confirm(): Promise<void> {
    if (!decision || !decision.accepted || !pdfBytes) {
      return;
    }
    setDrawer(null);
    picked.current = false;
    setOpenId(null);
    setBookTitle(decision.title);
    setShowAllSlices(false);
    setQueueRunning(true);
    setScreen('study');
    setStudy(slices.map((slice) => ({ ...slice, status: 'queued' })));
    try {
      const result = await window.bookDistiller.distill({
        folderPath,
        pdfPath,
        title: decision.title,
        modelId,
        pdfBytes,
        slices,
      });
      setStudy(result.slices);
      if (!picked.current) {
        const latest = [...result.slices].reverse().find((slice) => slice.status === 'done' && slice.board);
        setOpenId(latest ? latest.id : null);
      }
    } finally {
      setQueueRunning(false);
    }
  }

  async function continueBook(): Promise<void> {
    if (pdfMissing) {
      setShowMissingPdf(true);
      return;
    }
    let title = bookTitle;
    if (title === '' && decision?.accepted) {
      title = decision.title;
    }
    setQueueRunning(true);
    try {
      const result = await window.bookDistiller.distill({
        folderPath,
        pdfPath,
        title,
        modelId,
        pdfBytes: pdfBytes ?? new Uint8Array(),
        slices: study.map((slice) => ({
          id: slice.id,
          title: slice.title,
          pageStart: slice.pageStart,
          pageEnd: slice.pageEnd,
          checked: slice.checked,
          status: slice.status,
          modelId: slice.modelId,
          failureReason: slice.failureReason,
          board: slice.board,
        })),
      });
      setStudy(result.slices);
    } finally {
      setQueueRunning(false);
    }
  }

  async function redoOpen(): Promise<void> {
    if (!openId) {
      return;
    }
    if (pdfMissing) {
      setShowMissingPdf(true);
      return;
    }
    let title = bookTitle;
    if (title === '' && decision?.accepted) {
      title = decision.title;
    }
    const sectionId = openId;
    setRedoFailure('');
    setQueueRunning(true);
    try {
      const result = await window.bookDistiller.redo(
        {
          folderPath,
          pdfPath,
          title,
          modelId,
          pdfBytes: pdfBytes ?? new Uint8Array(),
          slices: study.map((slice) => ({
            id: slice.id,
            title: slice.title,
            pageStart: slice.pageStart,
            pageEnd: slice.pageEnd,
            checked: slice.checked,
          })),
        },
        sectionId,
      );
      if (result.status === 'replaced') {
        setStudy(result.slices);
        setOpenId(sectionId);
        return;
      }
      if (result.failure) {
        setRedoFailure(result.failure);
      }
    } finally {
      setQueueRunning(false);
    }
  }

  function toggleSlice(id: string): void {
    setSlices((current) =>
      current.map((slice) => (slice.id === id ? { ...slice, checked: !slice.checked } : slice)),
    );
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

  const confirmEnabled = slices.some((slice) => slice.checked);
  const startEnabled = decision?.accepted === true && hasKey && modelId !== '' && folderPath !== '';
  const canContinue = study.some(
    (slice) => slice.checked && (slice.status === 'failed' || slice.status === 'queued'),
  );
  const openSlice = study.find((slice) => slice.id === openId);
  const canRedo = openSlice?.status === 'done' && openSlice.board !== undefined;

  return (
    <main>
      <h1>{screen === 'study' ? 'Study' : 'Book Distiller'}</h1>
      {screen === 'launchpad' ? (
        <>
          <p onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
            Drop a PDF
          </p>
          <label>
            Choose a PDF
            <input type="file" accept="application/pdf,.pdf" onChange={onChoose} />
          </label>
          <button type="button" onClick={() => void chooseFolder()}>
            Choose a folder
          </button>
          {folderPath !== '' ? <p>{folderPath}</p> : null}
          {folderMessage !== '' ? <p className="notice">{folderMessage}</p> : null}
          {hasKey && !replacing ? (
            <button type="button" onClick={beginReplace}>
              Replace key
            </button>
          ) : (
            <>
              <label>
                Cursor key
                <input value={draftKey} onChange={(event) => setDraftKey(event.target.value)} />
              </label>
              <button type="button" onClick={() => void saveKey()}>
                Save
              </button>
            </>
          )}
          {hasKey ? (
            <button type="button" onClick={() => void forgetKey()}>
              Forget key
            </button>
          ) : null}
          {modelIds.length > 0 ? (
            <label>
              Model
              <select
                value={modelId}
                onChange={(event) => {
                  keyLocked.current = true;
                  const next = event.target.value;
                  setModelId(next);
                  void window.bookDistiller.chooseModel(next);
                }}
              >
                <option value=""></option>
                {modelIds.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {keyMessage !== '' ? <p className="notice">{keyMessage}</p> : null}
          {decision?.accepted ? (
            <>
              <p>{decision.title}</p>
              <p>{decision.pageCount === 1 ? '1 page' : `${decision.pageCount} pages`}</p>
            </>
          ) : null}
          {decision && !decision.accepted ? <p className="notice">{decision.message}</p> : null}
          <button type="button" disabled={!startEnabled} onClick={() => void start()}>
            Start
          </button>
        </>
      ) : null}
      {screen === 'checklist' ? (
        <>
          <ul>
            {slices.map((slice) => (
              <li key={slice.id}>
                <label>
                  <input type="checkbox" checked={slice.checked} onChange={() => toggleSlice(slice.id)} />
                  {slice.title} <span>{pageRange(slice.pageStart, slice.pageEnd)}</span>
                </label>
              </li>
            ))}
          </ul>
          <button type="button" disabled={!confirmEnabled} onClick={() => void confirm()}>
            Confirm
          </button>
        </>
      ) : null}
      {screen === 'study' ? (
        <ul>
          {study
            .filter((slice) => showAllSlices || slice.checked)
            .map((slice) => (
              <li key={slice.id}>
                {!queueRunning && slice.status !== 'done' ? (
                  <input type="checkbox" checked={slice.checked} onChange={() => toggleStudy(slice.id)} />
                ) : null}
                <button type="button" onClick={() => openDone(slice)}>
                  {slice.title}
                </button>{' '}
                <span>{pageRange(slice.pageStart, slice.pageEnd)}</span>
                {slice.id === openId && slice.status === 'done' && slice.board ? (
                  <BoardView
                    board={slice.board}
                    onPage={(page) => {
                      if (pdfMissing) {
                        setShowMissingPdf(true);
                        setDrawer(null);
                        return;
                      }
                      setShowMissingPdf(false);
                      setDrawer({ page, pageStart: slice.pageStart, pageEnd: slice.pageEnd });
                    }}
                  />
                ) : null}
                {slice.status === 'queued' ? ' queued' : null}
                {slice.status === 'writing' ? ' writing' : null}
                {slice.status === 'done' ? ' done' : null}
                {slice.status === 'failed' ? ` failed ${slice.failureReason}` : null}
              </li>
            ))}
        </ul>
      ) : null}
      {screen === 'study' && queueRunning ? (
        <button type="button" onClick={() => void window.bookDistiller.cancelDistill()}>
          Cancel
        </button>
      ) : null}
      {screen === 'study' && !queueRunning && canContinue ? (
        <button type="button" onClick={() => void continueBook()}>
          Continue
        </button>
      ) : null}
      {screen === 'study' && !queueRunning && canRedo ? (
        <button type="button" onClick={() => void redoOpen()}>
          Redo
        </button>
      ) : null}
      {screen === 'study' && redoFailure !== '' ? <span>{redoFailure}</span> : null}
      {screen === 'study' && !queueRunning ? (
        <button type="button" onClick={() => setScreen('launchpad')}>
          Launchpad
        </button>
      ) : null}
      {screen === 'study' && showMissingPdf ? <p>The PDF is missing.</p> : null}
      {screen === 'study' && drawer && pdfBytes ? (
        <PageDrawer
          pdfBytes={pdfBytes}
          page={drawer.page}
          pageStart={drawer.pageStart}
          pageEnd={drawer.pageEnd}
          onPage={(page) => setDrawer({ ...drawer, page })}
        />
      ) : null}
    </main>
  );
}
