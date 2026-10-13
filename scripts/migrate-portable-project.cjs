// Copies reusable Photo Booth settings/assets into Git-tracked project folders.
// Existing AppData and event files are never modified or deleted.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const appData = path.join(process.env.APPDATA || '', 'photo-booth');
const sourceSettings = path.join(appData, 'settings.json');
const configDir = path.join(root, 'config');
const posesDir = path.join(configDir, 'poses');
const assetsDir = path.join(root, 'public', 'project-assets');
const manifestPath = path.join(root, 'src', 'pose', 'poses', 'narration-assets.json');
const prefix = 'project-asset:';
const excludedParts = new Set(['originals', 'finals', 'videos', 'thumbs', 'ai-queue']);
const copied = [];
const missing = [];

if (!fs.existsSync(sourceSettings)) throw new Error(`Settings not found: ${sourceSettings}`);
fs.mkdirSync(configDir, { recursive: true });
fs.mkdirSync(posesDir, { recursive: true });
fs.mkdirSync(assetsDir, { recursive: true });

const clone = value => JSON.parse(JSON.stringify(value));
const safePart = value => value.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'asset';
const within = (candidate, parent) => {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};
const tokenFor = target => `${prefix}${path.relative(assetsDir, target).split(path.sep).join('/')}`;

function destinationFor(source, hint = 'misc') {
  const normalized = path.normalize(source);
  const parts = normalized.split(path.sep);
  const lowered = parts.map(part => part.toLowerCase());
  for (const category of ['templates', 'audio', 'ai-presets', 'face-assets', 'color-filters', 'branding']) {
    const index = lowered.lastIndexOf(category);
    if (index >= 0) return path.join(assetsDir, category, ...parts.slice(index + 1).map(safePart));
  }
  if (hint === 'pose-narration') return path.join(assetsDir, 'pose-narration', safePart(path.basename(source)));
  if (hint === 'pose-images') return path.join(assetsDir, 'pose-images', safePart(path.basename(source)));
  const digest = crypto.createHash('sha1').update(normalized.toLowerCase()).digest('hex').slice(0, 10);
  return path.join(assetsDir, safePart(hint), `${digest}-${safePart(path.basename(source))}`);
}

function copyAsset(source, hint) {
  if (!source || typeof source !== 'string' || source.startsWith(prefix) || !path.isAbsolute(source)) return source;
  if (within(source, assetsDir)) return tokenFor(source);
  const lowerParts = path.normalize(source).toLowerCase().split(path.sep);
  if (lowerParts.some(part => excludedParts.has(part))) return source;
  if (fs.existsSync(source) && !fs.statSync(source).isFile()) return source;
  if (!fs.existsSync(source)) {
    missing.push(source);
    return source;
  }
  const target = destinationFor(source, hint);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!fs.existsSync(target) || fs.statSync(target).size !== fs.statSync(source).size) fs.copyFileSync(source, target);
  copied.push(target);
  return tokenFor(target);
}

function mapAssets(value, key = '') {
  if (typeof value === 'string') {
    const hint = key === 'referenceImages' ? 'ai-presets' : key.toLowerCase().includes('logo') ? 'branding' : 'misc';
    return copyAsset(value, hint);
  }
  if (Array.isArray(value)) return value.map(item => mapAssets(item, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([entryKey, item]) => [entryKey, mapAssets(item, entryKey)]));
  }
  return value;
}

function copyTree(source, target) {
  if (!fs.existsSync(source)) return;
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, safePart(entry.name));
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      if (!fs.existsSync(to) || fs.statSync(to).size !== fs.statSync(from).size) fs.copyFileSync(from, to);
      copied.push(to);
    }
  }
}

function splitSettings(settings) {
  const shared = clone(settings);
  const local = {};
  const localKeys = [
    'eventFolder', 'supabaseUrl', 'supabasePublishableKey', 'eventId', 'boothSecret',
    'cameraId', 'cameraSource', 'canonEnabled', 'canonFraming', 'cameraRotation',
    'cameraPreviewOverlay', 'cameraControls', 'defaultPrinter', 'stylePrinters',
    'printerEnabled', 'silentPrint', 'printCalibration', 'adminPassword'
  ];
  for (const key of localKeys) {
    local[key] = clone(settings[key]);
    delete shared[key];
  }
  local.ai = { providers: {} };
  for (const provider of ['openai', 'gemini', 'xai']) {
    local.ai.providers[provider] = { apiKey: settings.ai?.providers?.[provider]?.apiKey || '' };
    if (shared.ai?.providers?.[provider]) shared.ai.providers[provider].apiKey = '';
  }
  local.layoutPrinters = Object.fromEntries((settings.template?.layouts || []).map(layout => [layout.id, layout.printerName || '']));
  if (shared.template?.layouts) shared.template.layouts = shared.template.layouts.map(layout => ({ ...layout, printerName: '' }));
  return { shared, local };
}

const rawSettings = JSON.parse(fs.readFileSync(sourceSettings, 'utf8'));
for (const category of ['templates', 'audio', 'ai-presets', 'face-assets', 'color-filters', 'branding']) {
  copyTree(path.join(rawSettings.eventFolder, category), path.join(assetsDir, category));
}
const current = mapAssets(rawSettings);
const { shared, local } = splitSettings(current);
fs.writeFileSync(path.join(configDir, 'settings.shared.json'), `${JSON.stringify(shared, null, 2)}\n`);
fs.writeFileSync(path.join(configDir, 'settings.local.json'), `${JSON.stringify(local, null, 2)}\n`);

const sourcePoseDir = path.join(appData, 'pose-library');
if (fs.existsSync(sourcePoseDir)) {
  for (const name of fs.readdirSync(sourcePoseDir).filter(name => name.endsWith('.json') && name !== 'elevenlabs.json')) {
    const pose = JSON.parse(fs.readFileSync(path.join(sourcePoseDir, name), 'utf8'));
    if (pose.audio?.filePath) pose.audio.filePath = copyAsset(pose.audio.filePath, 'pose-narration');
    if (pose.visual?.assetPath) pose.visual.assetPath = copyAsset(pose.visual.assetPath, 'pose-images');
    fs.writeFileSync(path.join(posesDir, name), `${JSON.stringify(pose, null, 2)}\n`);
  }
}

if (fs.existsSync(manifestPath)) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const item of Object.values(manifest)) {
    if (item && item.filePath) item.filePath = copyAsset(item.filePath, 'pose-narration');
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

const report = {
  migratedAt: new Date().toISOString(),
  copiedFiles: new Set(copied).size,
  poseFiles: fs.readdirSync(posesDir).filter(name => name.endsWith('.json')).length,
  missingFiles: [...new Set(missing)]
};
fs.writeFileSync(path.join(configDir, 'portable-migration-report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ copiedFiles: report.copiedFiles, poseFiles: report.poseFiles, missingFiles: report.missingFiles.length }));
