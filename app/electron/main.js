const { app, BrowserWindow, shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

const DEV_GATEWAY_SCRIPT = path.resolve(__dirname, '..', '..', 'engine', 'gateway.py');
const DEV_PYTHON_CANDIDATES = [
  process.env.PYTHON_GATEWAY,
  path.resolve(__dirname, '..', '..', '.venv', 'bin', 'python.exe'),
  path.resolve(__dirname, '..', '..', '.venv', 'Scripts', 'python.exe'),
];

let gatewayProcess = null;

function firstExisting(paths) {
  return paths.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

function portOpen(host, port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let finished = false;

    const done = (value) => {
      if (finished) {
        return;
      }
      finished = true;
      try {
        socket.destroy();
      } catch (_) {
        // Ignore shutdown errors.
      }
      resolve(value);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

function resolveGatewayExecutable() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'gateway', 'gateway.exe');
  }
  return null;
}

async function ensureGatewayRunning() {
  if (await portOpen('127.0.0.1', 8765)) {
    return;
  }

  const packagedGateway = resolveGatewayExecutable();
  if (packagedGateway && fs.existsSync(packagedGateway)) {
    gatewayProcess = spawn(packagedGateway, [], {
      cwd: path.dirname(packagedGateway),
      stdio: 'inherit',
      windowsHide: true,
    });
  } else {
    const pythonExe = firstExisting(DEV_PYTHON_CANDIDATES) || 'python';
    gatewayProcess = spawn(pythonExe, [DEV_GATEWAY_SCRIPT], {
      cwd: path.resolve(__dirname, '..', '..'),
      stdio: 'inherit',
      windowsHide: true,
    });
  }

  gatewayProcess.on('error', (error) => {
    console.error('[main] Gateway start failed:', error.message);
  });

  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await portOpen('127.0.0.1', 8765)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function createMainWindow() {
  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1100,
    minHeight: 700,
    autoHideMenuBar: true,
    title: 'He Thong Canh Bao Lu',
    icon: path.join(__dirname, '..', 'public', 'favicon.ico'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const indexPath = path.join(__dirname, '..', 'build', 'index.html');
  window.loadFile(indexPath);

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(async () => {
  await ensureGatewayRunning();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (gatewayProcess && !gatewayProcess.killed) {
      try {
        gatewayProcess.kill();
      } catch (_) {
        // Ignore shutdown errors.
      }
    }
    app.quit();
  }
});
