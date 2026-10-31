import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { chooseBookFolder } from './bookFolder';
import { forgetCursorKey, loadSession, rememberFolder, rememberModel, saveCursorKey } from './cursorKey';
import { distillQueue, openBook, redoSlice, requestCancel, writeChecks, type DistillInput } from './distill';
import { inspectPdf } from './inspectPdf';
import { slicePdf } from './slicePdf';

const userData = process.env.BOOK_DISTILLER_USER_DATA;
if (userData) {
  app.setPath('userData', userData);
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 960,
    height: 720,
    backgroundColor: '#161D22',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  void window.loadFile(join(import.meta.dirname, '../renderer/index.html'));
}

void app.whenReady().then(() => {
  let openPdfPath = '';
  ipcMain.handle('inspect-pdf', (_event, data: Uint8Array, fileName: string, pdfPath: string) => {
    openPdfPath = pdfPath;
    return inspectPdf(data, fileName);
  });
  ipcMain.handle('slice-pdf', (_event, data: Uint8Array) => slicePdf(data));
  ipcMain.handle('choose-folder', async () => {
    const choice = await chooseBookFolder(openPdfPath);
    if (choice.status === 'chosen') {
      await rememberFolder(choice.folderPath);
    } else if (choice.status === 'refused') {
      await rememberFolder('');
    }
    return choice;
  });
  ipcMain.handle('save-key', (_event, apiKey: string) => saveCursorKey(apiKey));
  ipcMain.handle('forget-key', () => forgetCursorKey());
  ipcMain.handle('session', () => loadSession());
  ipcMain.handle('choose-model', (_event, modelId: string) => rememberModel(modelId));
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
  ipcMain.handle('cancel-distill', () => {
    requestCancel();
  });
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});
