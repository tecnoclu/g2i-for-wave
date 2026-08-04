import { app, shell, BrowserWindow } from 'electron';
import { join } from 'path';
import dotenv from 'dotenv';
import { autoUpdater } from 'electron-updater';
import { startProxyServer } from './server';
import { initSessionDb, closeSessionDb } from './db/session';
import crypto from 'crypto';

// Initialize dotenv securely from the .env file in the root directory
// This is strictly a backend operation; the keys are NOT exposed to the renderer.
dotenv.config({ path: join(__dirname, '../../.env') });

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false // Sandbox off to allow preload to use Node.js if needed
    }
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: 'deny' };
  });

  // Load the remote URL for development or the local html file for production.
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  // 1. Check for application updates automatically in production packaged builds
  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify().catch(err => {
      console.warn('[AutoUpdater] Failed to check for updates:', err.message);
    });
  }

  // 2. Initialize Session DB with a unique ID for this instance/session
  const sessionId = crypto.randomUUID();
  initSessionDb(sessionId);

  // 3. Start Secure Proxy Server for Wave API
  const configPath = join(__dirname, '../../config.local.json');
  const port = 3001;
  startProxyServer(port, configPath);

  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    closeSessionDb();
    app.quit();
  }
});
