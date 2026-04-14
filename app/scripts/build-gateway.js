const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const appDir = path.resolve(__dirname, '..');
const repoDir = path.resolve(appDir, '..');
const pythonCandidates = [
  process.env.PYTHON_GATEWAY,
  path.join(repoDir, '.venv', 'bin', 'python.exe'),
  path.join(repoDir, '.venv', 'Scripts', 'python.exe'),
];

function firstExisting(paths) {
  return paths.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

const pythonExe = firstExisting(pythonCandidates) || 'python';
const gatewayScript = path.join(repoDir, 'engine', 'gateway.py');
const outputDir = path.join(appDir, 'resources', 'gateway');
const boardsDir = path.join(repoDir, 'firmware-develop', 'boards');

fs.mkdirSync(outputDir, { recursive: true });

const args = [
  '-m',
  'PyInstaller',
  '--noconfirm',
  '--clean',
  '--onefile',
  '--name',
  'gateway',
  '--distpath',
  outputDir,
  '--workpath',
  path.join(appDir, '.pyinstaller-work'),
  '--specpath',
  path.join(appDir, '.pyinstaller-spec'),
  '--add-data',
  `${boardsDir};firmware-develop/boards`,
  gatewayScript,
];

const result = spawnSync(pythonExe, args, {
  stdio: 'inherit',
  cwd: repoDir,
  shell: false,
});

if (result.status !== 0) {
  process.exit(result.status || 1);
}
