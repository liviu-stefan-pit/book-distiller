import { useEffect, useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from 'react';
import type { ComposeProgress, ComposeSection } from '../main/compose';
import type { Board, DistillSlice } from '../main/distill';
import type { PdfDecision } from '../main/inspectPdf';
import type { Slice } from '../main/slicePdf';
import {
  defaultParams,
  isFlagParameter,
  resolveSelection,
  type CatalogModel,
  type ModelParameterValue,
} from '../modelSelection';
import { highlightSource, notedLineNumbers, type Token } from './highlight';

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

function composeStatusLine(progress: ComposeProgress): string {
  if (progress.phase === 'typesetting') {
    return 'Setting the type';
  }
  if (progress.phase === 'done' && progress.pagesDone > 0) {
    return 'The book is ready.';
  }
  if (progress.phase === 'failed') {
    return 'The type could not be set.';
  }
  if (progress.phase === 'cancelled') {
    return 'Cancelled.';
  }
  if (progress.activeTitles.length === 1) {
    return `Reviewing ${progress.activeTitles[0]}`;
  }
  if (progress.activeTitles.length > 1) {
    return `Reviewing ${progress.activeTitles.length} sections`;
  }
  return '';
}

function composePagesLine(pagesDone: number, pagesTotal: number): string {
  return `${pagesDone} of ${pagesTotal} pages`;
}

function composeElapsed(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  if (total < 60) {
    return `${total}s`;
  }
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
}

function composeSectionWord(state: ComposeSection['state']): string {
  if (state === 'reviewing') {
    return 'Reviewing';
  }
  if (state === 'done') {
    return 'Done';
  }
  if (state === 'failed') {
    return 'Failed';
  }
  return 'Waiting';
}

function composeRunTokens(total: number | null, baseline: number | null): number | null {
  if (total === null) {
    return null;
  }
  if (baseline === null) {
    return total;
  }
  return Math.max(0, total - baseline);
}

function boardHasContent(board: Board | undefined): boolean {
  return board !== undefined && (board.points.length > 0 || board.code.length > 0);
}

function unfinishedLine(done: number, failed: number, left: number): string {
  const parts = [
    done > 0 ? `${done} done` : '',
    failed > 0 ? `${failed} failed` : '',
    left > 0 ? `${left} left` : '',
  ].filter((part) => part !== '');
  return parts.join(' \u00b7 ');
}

function proseParagraphs(text: string): string[] {
  return text
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .split(/\n[ \t]*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

function inlineNodes(text: string): ReactNode {
  if (!text.includes('`')) {
    return text;
  }
  const nodes: ReactNode[] = [];
  const pattern = /`([^`]+)`/g;
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    if (start > last) {
      nodes.push(text.slice(last, start));
    }
    nodes.push(<code key={index} className="inline-code">{match[1]}</code>);
    index += 1;
    last = start + match[0].length;
  }
  if (last < text.length) {
    nodes.push(text.slice(last));
  }
  return nodes.length > 0 ? nodes : text;
}

function Prose({ text }: { text: string }) {
  return proseParagraphs(text).map((paragraph, index) => <p key={index}>{inlineNodes(paragraph)}</p>);
}

function PageChip({ page, onPage }: { page: number; onPage: (page: number) => void }) {
  return (
    <button type="button" className="page-chip" onClick={() => onPage(page)}>{`Page ${page}`}</button>
  );
}

function PointArticle({
  point,
  onPage,
}: {
  point: Board['points'][number];
  onPage: (page: number) => void;
}) {
  const example = point.example;
  return (
    <article>
      <h3>{point.title}</h3>
      <Prose text={point.explanation} />
      <PageChip page={point.page} onPage={onPage} />
      {example ? (
        <aside className="example">
          <Prose text={example.text} />
          <PageChip page={example.page} onPage={onPage} />
        </aside>
      ) : null}
    </article>
  );
}

function SourceLine({ tokens, noted }: { tokens: Token[]; noted: boolean }) {
  const className = noted ? 'line is-noted' : 'line';
  return (
    <span className={className}>{tokens.map((token, index) => (
      <span key={index} className={`tok-${token.kind}`}>{token.text}</span>
    ))}</span>
  );
}

function CodeListing({
  block,
  onPage,
}: {
  block: Board['code'][number];
  onPage: (page: number) => void;
}) {
  const lines = highlightSource(block.source, block.language);
  const noted = notedLineNumbers(block.notes);
  return (
    <article className="listing">
      <h3>{block.title}</h3>
      <div className="listing-meta">
        <span className="language">{block.language}</span>
        <PageChip page={block.page} onPage={onPage} />
      </div>
      <pre><code>{lines.map((tokens, index) => (
        <SourceLine key={index} tokens={tokens} noted={noted.has(index + 1)} />
      ))}</code></pre>
      {block.notes.length > 0 ? (
        <ul className="notes">
          {block.notes.map((note, index) => (
            <li key={`${note.lines}-${index}`}>{`${note.lines} \u2014 ${note.why}`}</li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

function BoardView({ board, onPage }: { board: Board; onPage: (page: number) => void }) {
  if (board.points.length === 0 && board.code.length === 0) {
    return <p>Those pages had no technical content.</p>;
  }
  const remembered = board.points.filter((point) => point.kind === 'must-remember');
  const mechanics = board.points.filter((point) => point.kind === 'mechanics');
  const later = board.points.filter((point) => point.kind === 'useful-later');
  return (
    <div className="board" key={board.sectionId}>
      <div className="masthead">
        <h2>{board.sectionTitle}</h2>
        <p className="pages">{pageRange(board.pageStart, board.pageEnd)}</p>
      </div>
      {remembered.length > 0 ? (
        <section className="summary" aria-label="Must remember">
          <p className="eyebrow">Must remember</p>
          {remembered.map((point, index) => (
            <PointArticle key={`${point.kind}-${point.title}-${point.page}-${index}`} point={point} onPage={onPage} />
          ))}
        </section>
      ) : null}
      {mechanics.length > 0 ? (
        <section className="mechanics">
          <h2>Mechanics</h2>
          {mechanics.map((point, index) => (
            <PointArticle key={`${point.kind}-${point.title}-${point.page}-${index}`} point={point} onPage={onPage} />
          ))}
        </section>
      ) : null}
      {later.length > 0 ? (
        <details className="later">
          <summary><span>Useful later</span><span className="count">{later.length}</span></summary>
          {later.map((point, index) => (
            <PointArticle key={`${point.kind}-${point.title}-${point.page}-${index}`} point={point} onPage={onPage} />
          ))}
        </details>
      ) : null}
      {board.code.length > 0 ? (
        <section className="code">
          <h2>Code</h2>
          {board.code.map((block, index) => (
            <CodeListing key={`${block.title}-${block.page}-${index}`} block={block} onPage={onPage} />
          ))}
        </section>
      ) : null}
    </div>
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
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [modelId, setModelId] = useState('');
  const [modelParams, setModelParams] = useState<ModelParameterValue[]>([]);
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
  const [tokenTotal, setTokenTotal] = useState<number | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeRunning, setComposeRunning] = useState(false);
  const [composeCancelling, setComposeCancelling] = useState(false);
  const [composeProgress, setComposeProgress] = useState<ComposeProgress | null>(null);
  const [hasComposedPdf, setHasComposedPdf] = useState(false);
  const [composePdfMessage, setComposePdfMessage] = useState('');
  const keyLocked = useRef(false);
  const [composeElapsedMs, setComposeElapsedMs] = useState(0);
  const composeTokenBaseline = useRef<number | null>(null);
  const composeStartedAt = useRef(0);
  const composeSectionList = useRef<HTMLUListElement>(null);
  const folderChosen = useRef(false);
  const picked = useRef(false);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const settingsPanel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return window.bookDistiller.onMaximized(setMaximized);
  }, []);

  useEffect(() => {
    return window.bookDistiller.onTokenTotal(setTokenTotal);
  }, []);

  useEffect(() => {
    if (!queueRunning) {
      setCancelling(false);
    }
  }, [queueRunning]);

  useEffect(() => {
    if (!composeRunning) {
      setComposeCancelling(false);
    }
  }, [composeRunning]);

  const composePhase = composeProgress?.phase;
  const composeReviewingId = composeProgress?.sections.find((section) => section.state === 'reviewing')?.id ?? null;

  useEffect(() => {
    if (!composeOpen) {
      return;
    }
    setComposeElapsedMs(Date.now() - composeStartedAt.current);
    if (composePhase === 'done' || composePhase === 'failed' || composePhase === 'cancelled') {
      return;
    }
    const timer = window.setInterval(() => {
      setComposeElapsedMs(Date.now() - composeStartedAt.current);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [composeOpen, composePhase]);

  useEffect(() => {
    if (!composeOpen || composeReviewingId === null) {
      return;
    }
    const row = Array.from(composeSectionList.current?.children ?? []).find(
      (child) => child.getAttribute('data-section-id') === composeReviewingId,
    );
    row?.scrollIntoView({ block: 'nearest' });
  }, [composeOpen, composeReviewingId]);

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
          setModels(session.models);
          setModelId(session.modelId);
          setModelParams(session.modelParams);
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
    return window.bookDistiller.onComposeProgress((progress) => {
      setComposeProgress(progress);
      if (progress.phase === 'done' && progress.pagesDone > 0) {
        setHasComposedPdf(true);
      }
    });
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
    setHasComposedPdf(false);
    setComposeOpen(false);
    setComposeRunning(false);
    setComposeProgress(null);
    setComposePdfMessage('');
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
    setModels(result.models);
    setModelId(result.modelId);
    setModelParams(result.modelParams);
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
    setModels([]);
    setModelId('');
    setModelParams([]);
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
    setHasComposedPdf(opened.composedPdf);
    setComposeOpen(false);
    setComposeRunning(false);
    setComposeProgress(null);
    setComposePdfMessage('');
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
    setHasComposedPdf(false);
    setComposeOpen(false);
    setComposeProgress(null);
    setComposePdfMessage('');
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
        modelParams,
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
        modelParams,
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
          failureDetail: slice.failureDetail,
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
          modelParams,
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
        setRedoFailure(result.failureDetail ? `${result.failure}: ${result.failureDetail}` : result.failure);
      }
    } finally {
      setQueueRunning(false);
      setQueueKind(null);
    }
  }

  async function startCompose(): Promise<void> {
    setComposePdfMessage('');
    setComposeCancelling(false);
    composeTokenBaseline.current = tokenTotal;
    composeStartedAt.current = Date.now();
    setComposeElapsedMs(0);
    setComposeProgress({
      phase: 'reviewing',
      pagesDone: 0,
      pagesTotal: 0,
      activeTitles: [],
      failedTitles: [],
      sections: [],
    });
    setComposeOpen(true);
    setComposeRunning(true);
    try {
      const result = await window.bookDistiller.compose({
        folderPath: bookPath,
        modelId,
        modelParams,
      });
      setComposeProgress(result);
      if (result.phase === 'done' && result.pagesDone > 0) {
        setHasComposedPdf(true);
      }
    } catch {
      setComposeProgress((current) => ({
        phase: 'failed',
        pagesDone: current?.pagesDone ?? 0,
        pagesTotal: current?.pagesTotal ?? 0,
        activeTitles: [],
        failedTitles: current?.failedTitles ?? [],
        sections: current?.sections ?? [],
      }));
    } finally {
      setComposeRunning(false);
    }
  }

  function closeCompose(): void {
    setComposeOpen(false);
    setComposeCancelling(false);
  }

  async function revealComposedPdf(): Promise<void> {
    const message = await window.bookDistiller.openComposedPdf(bookPath);
    setComposePdfMessage(message);
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
  const chosenModel = models.find((model) => model.id === modelId);
  const resolvedParams = chosenModel ? resolveSelection(models, modelId, modelParams).modelParams : [];
  const startEnabled = decision?.accepted === true && hasKey && modelId !== '' && folderPath !== '';
  const canContinue = study.some(
    (slice) => slice.checked && (slice.status === 'failed' || slice.status === 'queued'),
  );
  const canCompose = study.some((slice) => slice.status === 'done' && boardHasContent(slice.board));
  const openSlice = study.find((slice) => slice.id === openId);
  const canRedo = openSlice?.status === 'done' && openSlice.board !== undefined;
  const checkedSlices = study.filter((slice) => slice.checked);
  const doneCount = checkedSlices.filter((slice) => slice.status === 'done').length;
  const failedCount = checkedSlices.filter((slice) => slice.status === 'failed').length;
  const leftCount = checkedSlices.filter(
    (slice) => slice.status === 'queued' || slice.status === 'writing',
  ).length;
  const writingSlices = study.filter((slice) => slice.status === 'writing');
  const writingSlice = writingSlices[0];
  // One writing slice is named. Several are counted, never named by the first one alone.
  const writingStatus =
    writingSlices.length > 1 ? `Writing ${writingSlices.length} slices` : writingSlice ? writingLine(writingSlice) : '';
  const redoing = queueKind === 'redo' && openSlice !== undefined;
  const showRun =
    !composeRunning && checkedSlices.length > 0 && (queueRunning || failedCount > 0 || leftCount > 0);
  const composeBusy =
    composeProgress !== null &&
    (composeProgress.phase === 'reviewing' || composeProgress.phase === 'typesetting');
  const composeFinished =
    composeProgress !== null &&
    (composeProgress.phase === 'done' ||
      composeProgress.phase === 'failed' ||
      composeProgress.phase === 'cancelled');
  const composeReady = composeProgress !== null && composeProgress.phase === 'done' && composeProgress.pagesDone > 0;
  const composeTokens = composeOpen ? composeRunTokens(tokenTotal, composeTokenBaseline.current) : null;
  const composePages = composeProgress
    ? composePagesLine(composeProgress.pagesDone, composeProgress.pagesTotal)
    : composePagesLine(0, 0);
  const composeMeta = [
    ...(composeProgress && composeProgress.pagesTotal > 0
      ? [
          composePages,
          `${composeProgress.sections.filter((section) => section.state === 'done').length} of ${composeProgress.sections.length} sections`,
        ]
      : []),
    ...(composeTokens !== null ? [`${composeTokens.toLocaleString('en-US')} tokens`] : []),
    composeElapsed(composeElapsedMs),
  ].join(' \u00b7 ');
  const runLine = writingSlice
    ? writingStatus
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
          <button
            type="button"
            disabled={cancelling}
            onClick={() => {
              setCancelling(true);
              void window.bookDistiller.cancelDistill();
            }}
          >
            {cancelling ? 'Cancelling' : 'Cancel'}
          </button>
        ) : null}
        {screen === 'study' && !queueRunning && !composeRunning && canContinue ? (
          <button type="button" onClick={() => void continueBook()}>
            Continue
          </button>
        ) : null}
        {screen === 'study' && !queueRunning && !composeRunning && canRedo ? (
          <button type="button" onClick={() => void redoOpen()}>
            Redo
          </button>
        ) : null}
        {screen === 'study' &&
        !queueRunning &&
        !composeRunning &&
        hasKey &&
        modelId !== '' &&
        canCompose ? (
          <button type="button" onClick={() => void startCompose()}>
            Compose
          </button>
        ) : null}
        {screen === 'study' && !composeRunning && hasComposedPdf ? (
          <button type="button" onClick={() => void revealComposedPdf()}>
            Open PDF
          </button>
        ) : null}
        {screen === 'study' && redoFailure !== '' ? <span>{redoFailure}</span> : null}
        {tokenTotal !== null ? (
          <span className="token-total">{`${tokenTotal.toLocaleString('en-US')} tokens`}</span>
        ) : null}
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
      {screen === 'study' && !composeOpen && composePdfMessage !== '' ? (
        <p className="notice">{composePdfMessage}</p>
      ) : null}
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
            {models.length > 0 ? (
              <>
                <label>
                  Model
                  <select
                    value={modelId}
                    onChange={(event) => {
                      keyLocked.current = true;
                      const next = event.target.value;
                      const model = models.find((item) => item.id === next);
                      const params = model ? defaultParams(model) : [];
                      setModelId(next);
                      setModelParams(params);
                      void window.bookDistiller.chooseModel(next, params);
                    }}
                  >
                    <option value=""></option>
                    {models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.displayName}
                      </option>
                    ))}
                  </select>
                </label>
                {chosenModel?.parameters.map((parameter) => {
                  const current = resolvedParams.find((item) => item.id === parameter.id)?.value ?? '';
                  const change = (value: string): void => {
                    keyLocked.current = true;
                    const next = resolveSelection(
                      models,
                      modelId,
                      resolvedParams.map((item) => (item.id === parameter.id ? { id: item.id, value } : item)),
                    );
                    setModelParams(next.modelParams);
                    void window.bookDistiller.chooseModel(next.modelId, next.modelParams);
                  };
                  if (isFlagParameter(parameter)) {
                    return (
                      <label key={parameter.id} className="flag">
                        <input
                          type="checkbox"
                          checked={current === 'true'}
                          onChange={(event) => change(event.target.checked ? 'true' : 'false')}
                        />
                        {parameter.displayName ?? 'Fast'}
                      </label>
                    );
                  }
                  return (
                    <label key={parameter.id}>
                      {parameter.displayName ?? parameter.id}
                      <select value={current} onChange={(event) => change(event.target.value)}>
                        {parameter.values.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.displayName ?? option.value}
                          </option>
                        ))}
                      </select>
                    </label>
                  );
                })}
              </>
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
      {composeOpen && composeProgress ? (
        <div className="overlay">
          <div className="sheet compose" role="dialog" aria-label="Compose">
            <div className="compose-head">
              <h2>Compose</h2>
              {bookTitle !== '' ? <p className="compose-book">{bookTitle}</p> : null}
            </div>
            <div role="status">
              <p className="compose-status">{composeStatusLine(composeProgress)}</p>
            </div>
            <p className="compose-meta">{composeMeta}</p>
            {composeProgress.pagesTotal > 0 ? (
              <progress
                value={composeProgress.pagesDone}
                max={composeProgress.pagesTotal}
                aria-label={composePages}
              />
            ) : null}
            {composeProgress.sections.length > 0 ? (
              <ul className="compose-sections" ref={composeSectionList} aria-label="Sections">
                {composeProgress.sections.map((section) => (
                  <li
                    key={section.id}
                    className={`compose-section ${section.state}`}
                    data-section-id={section.id}
                  >
                    <span className="compose-section-title">{section.title}</span>
                    <span className="compose-section-pages">{`${section.pageStart}\u2013${section.pageEnd}`}</span>
                    <span className="compose-section-state">{composeSectionWord(section.state)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className={composeBusy ? 'compose-footer busy' : 'compose-footer'}>
              {composeBusy ? (
                <button
                  type="button"
                  disabled={composeCancelling}
                  onClick={() => {
                    setComposeCancelling(true);
                    void window.bookDistiller.cancelDistill();
                  }}
                >
                  {composeCancelling ? 'Cancelling' : 'Cancel'}
                </button>
              ) : null}
              {composeFinished ? (
                <>
                  <button type="button" onClick={closeCompose}>
                    Close
                  </button>
                  {composeReady ? (
                    <button type="button" className="primary" onClick={() => void revealComposedPdf()}>
                      Open PDF
                    </button>
                  ) : null}
                </>
              ) : null}
            </div>
            {composePdfMessage !== '' ? <p className="notice">{composePdfMessage}</p> : null}
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
                        <span className="status failed">
                          failed {slice.failureReason}
                          {slice.failureDetail ? `: ${slice.failureDetail}` : ''}
                        </span>
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
                  <p>{writingStatus}</p>
                  <p>
                    {writingSlices.length > 1
                      ? 'A board opens here when its section is ready.'
                      : 'The board opens here when this section is ready.'}
                  </p>
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
