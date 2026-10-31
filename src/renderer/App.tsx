import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import type { Board, DistillSlice } from '../main/distill';
import type { PdfDecision } from '../main/inspectPdf';
import type { Slice } from '../main/slicePdf';

function pageRange(start: number, end: number): string {
  if (start === end) {
    return `${start}`;
  }
  return `${start}\u2013${end}`;
}

function pagePhrase(start: number, end: number): string {
  if (start === end) {
    return `page ${start}`;
  }
  return `pages ${start}\u2013${end}`;
}

function writingLine(slice: DistillSlice): string {
  const again = slice.attempt === 2 ? ' again' : '';
  return `Writing ${slice.title}${again}, ${pagePhrase(slice.pageStart, slice.pageEnd)}`;
}

function unfinishedLine(done: number, failed: number, left: number): string {
  const parts = [
    done > 0 ? `${done} done` : '',
    failed > 0 ? `${failed} failed` : '',
    left > 0 ? `${left} left` : '',
  ].filter((part) => part !== '');
  return parts.join(' \u00b7 ');
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
            <p className="caption">{block.language}</p>
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
      <div className="drawer-nav">
        <button type="button" onClick={() => onPage(Math.max(pageStart, page - 1))}>
          Previous
        </button>
        <button type="button" onClick={() => onPage(Math.min(pageEnd, page + 1))}>
          Next
        </button>
      </div>
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
  const [bookPath, setBookPath] = useState('');
  const [folderMessage, setFolderMessage] = useState('');
  const [openMessage, setOpenMessage] = useState('');
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
  const [queueKind, setQueueKind] = useState<'run' | 'redo' | null>(null);
  const [redoFailure, setRedoFailure] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const keyLocked = useRef(false);
  const folderChosen = useRef(false);
  const picked = useRef(false);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const settingsPanel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return window.bookDistiller.onMaximized(setMaximized);
  }, []);

  useEffect(() => {
    if (!settingsOpen) {
      return;
    }
    const closeOnOutside = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (settingsPanel.current?.contains(target) || settingsButton.current?.contains(target)) {
        return;
      }
      setSettingsOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutside);
    return () => document.removeEventListener('pointerdown', closeOnOutside);
  }, [settingsOpen]);

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

  const writingId = study.find((slice) => slice.status === 'writing')?.id;
  useEffect(() => {
    if (!writingId) {
      return;
    }
    document.getElementById(`slice-${writingId}`)?.scrollIntoView({ block: 'nearest' });
  }, [writingId]);

  async function openFile(file: File): Promise<void> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const filePath = window.bookDistiller.pathForFile(file);
    const opened = await window.bookDistiller.inspectPdf(bytes, file.name, filePath);
    setPdfPath(filePath);
    setPdfBytes(bytes);
    setPdfMissing(false);
    setShowMissingPdf(false);
    setBookPath('');
    setOpenMessage('');
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

  async function showBook(folder: string): Promise<string> {
    const opened = await window.bookDistiller.openBook(folder);
    if (opened.status === 'refused') {
      return opened.message;
    }
    if (opened.status !== 'opened') {
      return 'This book folder could not be read.';
    }
    setBookPath(folder);
    setFolderMessage('');
    setOpenMessage('');
    setPdfPath(opened.pdfPath);
    setPdfBytes(opened.pdfMissing ? null : opened.pdfBytes);
    setBookTitle(opened.title);
    setPdfMissing(opened.pdfMissing);
    setShowMissingPdf(false);
    setShowAllSlices(true);
    setStudy(opened.slices);
    setDrawer(null);
    setQueueRunning(false);
    setQueueKind(null);
    const first = opened.slices.find((slice) => slice.status === 'done' && slice.board);
    setOpenId(first ? first.id : null);
    picked.current = true;
    setScreen('study');
    return '';
  }

  async function chooseFolder(): Promise<void> {
    const choice = await window.bookDistiller.chooseFolder();
    if (choice.status === 'refused') {
      folderChosen.current = true;
      setFolderPath('');
      setFolderMessage(choice.message);
      return;
    }
    if (choice.status === 'book') {
      const message = await showBook(choice.folderPath);
      if (message !== '') {
        setFolderMessage(message);
      }
      return;
    }
    if (choice.status !== 'chosen') {
      return;
    }
    folderChosen.current = true;
    setFolderPath(choice.folderPath);
    setFolderMessage('');
  }

  async function openSavedBook(): Promise<void> {
    const choice = await window.bookDistiller.chooseBook();
    if (choice.status === 'refused') {
      setOpenMessage(choice.message);
      return;
    }
    if (choice.status !== 'book') {
      return;
    }
    const message = await showBook(choice.folderPath);
    if (message !== '') {
      setOpenMessage(message);
    }
  }

  function toggleStudy(id: string): void {
    const next = study.map((slice) => (slice.id === id ? { ...slice, checked: !slice.checked } : slice));
    setStudy(next);
    if (bookPath !== '') {
      void window.bookDistiller.setChecks(
        bookPath,
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
    let resolved = '';
    try {
      resolved = await window.bookDistiller.resolveBookFolder(folderPath, pdfPath, decision.title);
    } catch {
      setFolderMessage('Could not create a book folder.');
      return;
    }
    setBookPath(resolved);
    setDrawer(null);
    picked.current = false;
    setOpenId(null);
    setBookTitle(decision.title);
    setShowAllSlices(false);
    setQueueRunning(true);
    setQueueKind('run');
    setScreen('study');
    setStudy(slices.map((slice) => ({ ...slice, status: 'queued' })));
    try {
      const result = await window.bookDistiller.distill({
        folderPath: resolved,
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
      setQueueKind(null);
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
    setQueueKind('run');
    try {
      const result = await window.bookDistiller.distill({
        folderPath: bookPath,
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
      setQueueKind(null);
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
    setQueueKind('redo');
    try {
      const result = await window.bookDistiller.redo(
        {
          folderPath: bookPath,
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
      setQueueKind(null);
    }
  }

  function toggleSlice(id: string): void {
    setSlices((current) =>
      current.map((slice) => (slice.id === id ? { ...slice, checked: !slice.checked } : slice)),
    );
  }

  function onDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setDragOver(false);
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
  const checkedSlices = study.filter((slice) => slice.checked);
  const doneCount = checkedSlices.filter((slice) => slice.status === 'done').length;
  const failedCount = checkedSlices.filter((slice) => slice.status === 'failed').length;
  const leftCount = checkedSlices.filter(
    (slice) => slice.status === 'queued' || slice.status === 'writing',
  ).length;
  const writingSlice = study.find((slice) => slice.status === 'writing');
  const redoing = queueKind === 'redo' && openSlice !== undefined;
  const showRun = checkedSlices.length > 0 && (queueRunning || failedCount > 0 || leftCount > 0);
  const runLine = writingSlice
    ? writingLine(writingSlice)
    : redoing && openSlice
      ? `Writing ${openSlice.title} again`
      : unfinishedLine(doneCount, failedCount, leftCount);

  const heading =
    screen === 'study' && bookTitle !== ''
      ? bookTitle
      : screen === 'study' && decision?.accepted
        ? decision.title
        : 'Book Distiller';

  return (
    <main className={screen === 'study' ? 'app viewer-mode' : 'app'}>
      <header className="topbar">
        <h1>{heading}</h1>
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
        <button
          type="button"
          className="settings-button"
          aria-label="Settings"
          ref={settingsButton}
          onClick={() => setSettingsOpen((open) => !open)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <path
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
            />
            <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
          </svg>
        </button>
        <div className="window-controls">
          <button type="button" aria-label="Minimize" onClick={() => window.bookDistiller.minimizeWindow()}>
            <span className="glyph min" />
          </button>
          <button
            type="button"
            aria-label={maximized ? 'Restore' : 'Maximize'}
            onClick={() => window.bookDistiller.toggleMaximizeWindow()}
          >
            <span className={maximized ? 'glyph restore' : 'glyph max'} />
          </button>
          <button type="button" className="close" aria-label="Close" onClick={() => window.bookDistiller.closeWindow()}>
            <span className="glyph close-x" />
          </button>
        </div>
      </header>
      {settingsOpen ? (
        <div className="overlay settings-flyout">
          <div className="sheet" role="dialog" aria-label="Settings" ref={settingsPanel}>
            <button type="button" onClick={() => void chooseFolder()}>
              Choose a folder
            </button>
            {folderPath !== '' ? <p>{folderPath}</p> : null}
            {bookPath !== '' && bookPath !== folderPath ? <p>{bookPath}</p> : null}
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
          </div>
        </div>
      ) : null}
      {screen === 'launchpad' || screen === 'checklist' ? (
        <div className="home">
          <div
            className={dragOver ? 'drop over' : 'drop'}
            onDragOver={(event) => {
              event.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
                return;
              }
              setDragOver(false);
            }}
            onDrop={onDrop}
          >
            <p>Drop a PDF</p>
            <label>
              Choose a PDF
              <input type="file" accept="application/pdf,.pdf" onChange={onChoose} />
            </label>
          </div>
          <button type="button" onClick={() => void openSavedBook()}>
            Open book
          </button>
          {openMessage !== '' ? <p className="notice">{openMessage}</p> : null}
          {decision?.accepted ? (
            <>
              <p>{decision.title}</p>
              <p className="meta">{decision.pageCount === 1 ? '1 page' : `${decision.pageCount} pages`}</p>
            </>
          ) : null}
          {decision && !decision.accepted ? <p className="notice">{decision.message}</p> : null}
          <button type="button" className="primary" disabled={!startEnabled} onClick={() => void start()}>
            Start
          </button>
        </div>
      ) : null}
      {screen === 'checklist' ? (
        <div className="overlay">
          <div className="sheet" role="dialog" aria-label="Slices">
            <ul className="checklist">
              {slices.map((slice) => (
                <li key={slice.id}>
                  <label>
                    <input type="checkbox" checked={slice.checked} onChange={() => toggleSlice(slice.id)} />
                    {slice.title} <span>{pageRange(slice.pageStart, slice.pageEnd)}</span>
                  </label>
                </li>
              ))}
            </ul>
            <button type="button" className="primary" disabled={!confirmEnabled} onClick={() => void confirm()}>
              Confirm
            </button>
          </div>
        </div>
      ) : null}
      {screen === 'study' ? (
        <div className="viewer" role="region" aria-label="Viewer">
          {showMissingPdf ? <p className="notice">The PDF is missing.</p> : null}
          {showRun ? (
            <div className="run" role="status">
              <p>{runLine}</p>
              {queueRunning ? (
                <>
                  <p className="count">
                    {doneCount} of {checkedSlices.length}
                  </p>
                  <progress
                    value={doneCount}
                    max={checkedSlices.length}
                    aria-label={`${doneCount} of ${checkedSlices.length}`}
                  />
                </>
              ) : null}
            </div>
          ) : null}
          <div className={drawer && pdfBytes ? 'workspace with-page' : 'workspace'}>
            <ul>
              {study
                .filter((slice) => showAllSlices || slice.checked)
                .map((slice) => (
                  <li
                    key={slice.id}
                    id={`slice-${slice.id}`}
                    className={
                      [slice.id === openId ? 'is-open' : '', slice.status === 'writing' ? 'is-writing' : '']
                        .filter((name) => name !== '')
                        .join(' ') || undefined
                    }
                  >
                    {!queueRunning && slice.status !== 'done' ? (
                      <input type="checkbox" checked={slice.checked} onChange={() => toggleStudy(slice.id)} />
                    ) : null}
                    <button type="button" title={slice.title} onClick={() => openDone(slice)}>
                      {slice.title}
                    </button>
                    <div className="meta">
                      <span className="range">{pageRange(slice.pageStart, slice.pageEnd)}</span>
                      {slice.status === 'queued' ? <span className="status">queued</span> : null}
                      {slice.status === 'writing' ? <span className="status">writing</span> : null}
                      {slice.status === 'done' ? <span className="status done">done</span> : null}
                      {slice.status === 'failed' ? (
                        <span className="status failed">failed {slice.failureReason}</span>
                      ) : null}
                    </div>
                  </li>
                ))}
            </ul>
            <div className="reading">
              {openSlice?.status === 'done' && openSlice.board ? (
                <BoardView
                  board={openSlice.board}
                  onPage={(page) => {
                    if (pdfMissing) {
                      setShowMissingPdf(true);
                      setDrawer(null);
                      return;
                    }
                    setShowMissingPdf(false);
                    setDrawer({ page, pageStart: openSlice.pageStart, pageEnd: openSlice.pageEnd });
                  }}
                />
              ) : writingSlice ? (
                <div className="waiting">
                  <p>{writingLine(writingSlice)}</p>
                  <p>The board opens here when this section is ready.</p>
                </div>
              ) : null}
            </div>
            {drawer && pdfBytes ? (
              <PageDrawer
                pdfBytes={pdfBytes}
                page={drawer.page}
                pageStart={drawer.pageStart}
                pageEnd={drawer.pageEnd}
                onPage={(page) => setDrawer({ ...drawer, page })}
              />
            ) : null}
          </div>
        </div>
      ) : null}
    </main>
  );
}
