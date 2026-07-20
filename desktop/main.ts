import path from 'node:path';
import { app, BrowserWindow, dialog, shell } from 'electron';
import { startProjectProvenanceServer, type ProjectProvenanceServer } from '../server/index.js';

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
app.setAppUserModelId('dev.nilhan.projectprovenance');

let mainWindow: BrowserWindow | null = null;
let localServer: ProjectProvenanceServer | null = null;

function focusMainWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function createMainWindow(): Promise<void> {
  if (!localServer) {
    const packagedSeed = path.join(process.resourcesPath, 'seed-inventory.json');
    localServer = await startProjectProvenanceServer({
      port: 0,
      dataDirectory: path.join(app.getPath('userData'), 'inventory'),
      distDirectory: path.join(app.getAppPath(), 'dist'),
      defaultRoots: ['D:\\'],
      seedInventoryPath: app.isPackaged ? packagedSeed : path.join(app.getAppPath(), 'examples', 'seed-inventory.json'),
    });
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    title: 'Project Provenance',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://github.com/')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== `${localServer?.url}/`) event.preventDefault();
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  await mainWindow.loadURL(localServer.url);
}

app.on('second-instance', focusMainWindow);
app.whenReady().then(async () => {
  await createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createMainWindow();
  });
}).catch((error: unknown) => {
  console.error('Project Provenance failed to start:', error);
  dialog.showErrorBox('Project Provenance could not start', error instanceof Error ? error.message : 'The local application service failed to start.');
  app.quit();
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  if (localServer) void localServer.close().catch(() => undefined);
});
