const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sharedPath = path.join(root, 'config', 'settings.shared.json');
const posesDir = path.join(root, 'config', 'poses');
const assetsDir = path.join(root, 'public', 'project-assets');
const narrationPath = path.join(root, 'src', 'pose', 'poses', 'narration-assets.json');
const errors = [];
const referenced = new Set();
const secretKeys = new Set(['apiKey', 'boothSecret', 'adminPassword', 'supabasePublishableKey', 'encryptedApiKey']);
const forbiddenFolders = new Set(['originals', 'finals', 'videos', 'thumbs', 'ai-queue']);
const forbiddenExtensions = new Set(['.mp4', '.webm', '.mov', '.avi']);

function readJson(file) {
  if (!fs.existsSync(file)) {
    errors.push(`Missing required file: ${path.relative(root, file)}`);
    return {};
  }
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { errors.push(`Invalid JSON ${path.relative(root, file)}: ${error.message}`); return {}; }
}

function inspect(value, location, key = '') {
  if (typeof value === 'string') {
    if (secretKeys.has(key) && value.trim()) errors.push(`Secret value committed at ${location}.${key}`);
    if (/^[a-zA-Z]:[\\/]/.test(value) || /^\\\\/.test(value)) errors.push(`Absolute machine path at ${location}.${key}: ${value}`);
    if (value.startsWith('project-asset:')) {
      const relative = value.slice('project-asset:'.length).replace(/^[/\\]+/, '');
      const target = path.resolve(assetsDir, relative);
      if (target !== assetsDir && !target.startsWith(`${assetsDir}${path.sep}`)) errors.push(`Unsafe project asset token at ${location}.${key}`);
      else if (!fs.existsSync(target) || !fs.statSync(target).isFile()) errors.push(`Missing project asset at ${location}.${key}: ${value}`);
      else referenced.add(target);
    }
    return;
  }
  if (Array.isArray(value)) return value.forEach((item, index) => inspect(item, `${location}[${index}]`, key));
  if (value && typeof value === 'object') {
    for (const [entryKey, item] of Object.entries(value)) inspect(item, location, entryKey);
  }
}

function walk(folder) {
  if (!fs.existsSync(folder)) return [];
  const files = [];
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const target = path.join(folder, entry.name);
    if (entry.isDirectory()) files.push(...walk(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

inspect(readJson(sharedPath), 'settings');
inspect(readJson(narrationPath), 'narration');
for (const file of walk(posesDir).filter(file => path.extname(file).toLowerCase() === '.json')) {
  inspect(readJson(file), `pose:${path.basename(file)}`);
}

const assets = walk(assetsDir);
for (const file of assets) {
  const relative = path.relative(assetsDir, file);
  const parts = relative.toLowerCase().split(path.sep);
  const extension = path.extname(file).toLowerCase();
  if (parts.some(part => forbiddenFolders.has(part))) errors.push(`User-output folder committed under project assets: ${relative}`);
  if (forbiddenExtensions.has(extension)) errors.push(`Video committed under project assets: ${relative}`);
  if (fs.statSync(file).size >= 95 * 1024 * 1024) errors.push(`File is too large for normal GitHub storage: ${relative}`);
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(JSON.stringify({
  sharedSettings: path.relative(root, sharedPath),
  poses: walk(posesDir).filter(file => path.extname(file).toLowerCase() === '.json').length,
  assets: assets.length,
  referencedAssets: referenced.size
}));
