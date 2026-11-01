import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { access, appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chooseExistingBook, chooseOutputFolder, resolveBookFolder } from './bookFolder';
import { composedPdfReady } from './bookManifest';
import { composeBook, type ComposeInput } from './compose';
import { forgetCursorKey, loadSession, rememberFolder, rememberModel, saveCursorKey } from './cursorKey';
import { distillQueue, openBook, redoSlice, requestCancel, writeChecks, type DistillInput } from './distill';
import { disposeAgent, hasHeldState, onTokenTotal } from './heldAgent';
import { inspectPdf } from './inspectPdf';
import type { ModelParameterValue } from '../modelSelection';
import { slicePdf } from './slicePdf';

const noComposedPdf = 'This book has no composed PDF.';

async function openComposedPdf(folderPath: string): Promise<string> {
  const pdfPath = join(folderPath, 'composed.pdf');
  let fileExists = false;
  try {
    await access(pdfPath);
    fileExists = true;
  } catch {
    fileExists = false;
  }
  let manifestText: string;
  try {
    manifestText = await readFile(join(folderPath, 'book-manifest.json'), 'utf8');
  } catch {
    return noComposedPdf;
  }
  if (!composedPdfReady(manifestText, fileExists)) {
    return noComposedPdf;
  }
  const openLog = process.env.BOOK_DISTILLER_OPEN_LOG;
  if (openLog) {
    await appendFile(openLog, `${pdfPath}\n`, 'utf8');
    return '';
  }
  return shell.openPath(pdfPath);
}

const userData = process.env.BOOK_DISTILLER_USER_DATA;
if (userData) {
  app.setPath('userData', userData);
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 960,
    height: 720,
    backgroundColor: '#131314',
    roundedCorners: true,
    frame: false,
    thickFrame: true,
    resizable: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const tellMaximized = (maximized: boolean): void => {
    window.webContents.send('window-maximized', maximized);
  };
  window.on('maximize', () => tellMaximized(true));
  window.on('unmaximize', () => tellMaximized(false));

  void window.loadFile(join(import.meta.dirname, '../renderer/index.html'));
}

void app.whenReady().then(() => {
  onTokenTotal((total) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('token-total', total);
    }
  });
  ipcMain.handle('inspect-pdf', (_event, data: Uint8Array, fileName: string) => inspectPdf(data, fileName));
  ipcMain.handle('slice-pdf', (_event, data: Uint8Array) => slicePdf(data));
  ipcMain.handle('choose-folder', async () => {
    const choice = await chooseOutputFolder();
    if (choice.status === 'chosen') {
      await rememberFolder(choice.folderPath);
    } else if (choice.status === 'refused') {
      await rememberFolder('');
    }
    return choice;
  });
  ipcMain.handle('choose-book', () => chooseExistingBook());
  ipcMain.handle('resolve-book-folder', (_event, outputPath: string, pdfPath: string, title: string) =>
    resolveBookFolder(outputPath, pdfPath, title),
  );
  ipcMain.handle('save-key', async (_event, apiKey: string) => {
    const result = await saveCursorKey(apiKey);
    if (result.status === 'saved') {
      await disposeAgent('key');
    }
    return result;
  });
  ipcMain.handle('forget-key', async () => {
    await forgetCursorKey();
    await disposeAgent('key');
  });
  ipcMain.handle('session', () => loadSession());
  ipcMain.handle('choose-model', (_event, modelId: string, modelParams: ModelParameterValue[]) =>
    rememberModel(modelId, modelParams),
  );
  ipcMain.handle('open-book', (_event, folderPath: string) => openBook(folderPath));
  ipcMain.handle(
    'set-checks',
    (_event, folderPath: string, checks: Array<{ id: string; checked: boolean }>) =>
      writeChecks(folderPath, checks),
  );
  ipcMain.handle('redo', (_event, input: DistillInput, sectionId: string) => redoSlice(input, sectionId));
  ipcMain.handle('distill', (event, input: DistillInput) =>
    distillQueue(input, (slices) => {
      event.sender.send('distill-progress', slices);
    }),
  );
  ipcMain.handle('compose', (event, input: ComposeInput) =>
    composeBook(input, (progress) => {
      event.sender.send('compose-progress', progress);
    }),
  );
  ipcMain.handle('open-composed-pdf', (_event, folderPath: string) => openComposedPdf(folderPath));
  ipcMain.handle('cancel-distill', () => requestCancel());
  ipcMain.on('window-minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.on('window-toggle-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) {
      return;
    }
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  });
  ipcMain.on('window-close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});

let quitDisposed = false;

app.on('before-quit', (event) => {
  if (quitDisposed || !hasHeldState()) {
    return;
  }
  event.preventDefault();
  quitDisposed = true;
  const settled = Promise.race([
    disposeAgent('quit'),
    new Promise<void>((resolve) => setTimeout(resolve, 5000)),
  ]);
  void settled.finally(() => app.quit());
});
