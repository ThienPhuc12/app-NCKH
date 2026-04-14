const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');

const appDir = path.resolve(__dirname, '..');
const repoDir = path.resolve(appDir, '..');

function firstExisting(paths) {
  for (const p of paths) {
    if (p && fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

const pythonCandidates = [
  process.env.PYTHON_GATEWAY,
  path.join(repoDir, '.venv', 'bin', 'python.exe'),
  path.join(repoDir, '.venv', 'Scripts', 'python.exe'),
  path.join(repoDir, '.venv-win', 'Scripts', 'python.exe'),
];

const pythonExe = firstExisting(pythonCandidates) || 'python';
const gatewayScript = path.join(repoDir, 'engine', 'gateway.py');
const reactScriptsJs = path.join(appDir, 'node_modules', 'react-scripts', 'bin', 'react-scripts.js');

function isPortOpen(host, port, timeoutMs = 600) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        socket.destroy();
      } catch (_) {
        // no-op
      }
      resolve(value);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

async function main() {
  console.log(`[start] Python: ${pythonExe}`);
  console.log(`[start] Gateway: ${gatewayScript}`);

  const gatewayAlreadyRunning = await isPortOpen('127.0.0.1', 8765);

  let gateway = null;
  if (gatewayAlreadyRunning) {
    console.log('[start] Gateway already running on ws://127.0.0.1:8765, reusing existing process.');
  } else {
    gateway = spawn(pythonExe, [gatewayScript], {
      cwd: repoDir,
      stdio: 'inherit',
      shell: false,
      windowsHide: false,
    });

    gateway.on('error', (err) => {
      console.error('[start] Failed to start gateway:', err.message);
    });
  }

  const web = spawn(process.execPath, [reactScriptsJs, 'start'], {
    cwd: appDir,
    stdio: 'inherit',
    shell: false,
    windowsHide: false,
    env: process.env,
  });

  web.on('error', (err) => {
    console.error('[start] Failed to start web app:', err.message);
  });

  let shuttingDown = false;

  function shutdown(code = 0) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    try {
      if (gateway && !gateway.killed) {
        gateway.kill('SIGTERM');
      }
    } catch (_) {
      // Ignore cleanup errors.
    }

    try {
      if (web && !web.killed) {
        web.kill('SIGTERM');
      }
    } catch (_) {
      // Ignore cleanup errors.
    }

    process.exit(code);
  }

  web.on('exit', (code) => {
    shutdown(code || 0);
  });

  if (gateway) {
    gateway.on('exit', (code) => {
      if (!shuttingDown && code && code !== 0) {
        console.error(`[start] Gateway exited with code ${code}.`);
      }
    });
  }

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
}

main().catch((err) => {
  console.error('[start] Startup failed:', err.message);
  process.exit(1);
});
