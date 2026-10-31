import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { inspectPdf } from './inspectPdf';

function createWindow(): void {
  const window = new BrowserWindow({
    width: 960,
    height: 720,
    backgroundColor: '#121212',
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
  ipcMain.handle('inspect-pdf', (_event, data: Uint8Array, fileName: string) => inspectPdf(data, fileName));
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});
