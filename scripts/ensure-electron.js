const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const electronDir = path.join(__dirname, '..', 'node_modules', 'electron');

function getPlatformPath() {
  switch (process.platform) {
    case 'darwin':
      return 'Electron.app/Contents/MacOS/Electron';
    case 'win32':
      return 'electron.exe';
    default:
      return 'electron';
  }
}

function isElectronInstalled() {
  const platformPath = getPlatformPath();
  const distDir = path.join(electronDir, 'dist');
  const pathTxt = path.join(electronDir, 'path.txt');
  const electronBinary = path.join(distDir, platformPath);

  try {
    const { version } = require(path.join(electronDir, 'package.json'));
    const distVersion = fs
      .readFileSync(path.join(distDir, 'version'), 'utf8')
      .replace(/^v/, '')
      .trim();

    return (
      distVersion === version &&
      fs.readFileSync(pathTxt, 'utf8').trim() === platformPath &&
      fs.existsSync(electronBinary)
    );
  } catch {
    return false;
  }
}

async function installElectron() {
  if (!fs.existsSync(electronDir)) {
    return;
  }

  if (isElectronInstalled()) {
    return;
  }

  console.log('Electron binary missing — installing with fallback extractor...');

  const { version } = require(path.join(electronDir, 'package.json'));
  const { downloadArtifact } = require('@electron/get');
  const platformPath = getPlatformPath();
  const distDir = path.join(electronDir, 'dist');
  const pathTxt = path.join(electronDir, 'path.txt');

  const zipPath = await downloadArtifact({
    version,
    artifactName: 'electron',
    platform: process.platform,
    arch: process.arch,
    checksums: require(path.join(electronDir, 'checksums.json')),
  });

  if (fs.existsSync(distDir)) {
    try {
      fs.rmSync(distDir, { recursive: true, force: true });
    } catch {
      // Electron may be running; extract on top of existing files instead.
    }
  }
  fs.mkdirSync(distDir, { recursive: true });

  if (process.platform === 'win32') {
    const psZip = zipPath.replace(/'/g, "''");
    const psDist = distDir.replace(/'/g, "''");
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -Path '${psZip}' -DestinationPath '${psDist}' -Force`,
      ],
      { stdio: 'inherit' }
    );
  } else {
    execFileSync('unzip', ['-q', '-o', zipPath, '-d', distDir], { stdio: 'inherit' });
  }

  const srcTypeDef = path.join(distDir, 'electron.d.ts');
  const targetTypeDef = path.join(electronDir, 'electron.d.ts');
  if (fs.existsSync(srcTypeDef)) {
    fs.renameSync(srcTypeDef, targetTypeDef);
  }

  fs.writeFileSync(pathTxt, platformPath);
  console.log('Electron installed successfully.');
}

installElectron().catch((err) => {
  console.error('Failed to install Electron:', err);
  process.exit(1);
});
