// Persist generated narration as complete library entries, preserving saved edits.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const { BUNDLED_SCENES, withNarration } = require('../src/pose/scenes.ts');
const { validateScene } = require('../electron/poseValidation.ts');
const root = path.resolve(__dirname, '..');
const library = path.join(root, 'config', 'poses');
const projectAssets = path.join(root, 'public', 'project-assets');
const resolveAsset = value => value?.startsWith('project-asset:')
  ? path.join(projectAssets, value.slice('project-asset:'.length).replace(/^[/\\]+/, ''))
  : value;
const backup = path.join(process.env.APPDATA, 'photo-booth', 'pose-library', 'audio', `save-backup-${Date.now()}`);
fs.mkdirSync(backup, { recursive: true });
let saved = 0;
const packFilter = process.argv.find(arg => arg.startsWith('--pack='))?.slice('--pack='.length);
const selected = BUNDLED_SCENES.filter(scene => !packFilter || scene.tags.includes(packFilter));
if (!selected.length) throw new Error(`No poses found for pack ${packFilter}`);
for (const bundled of selected) {
  const target = path.join(library, `${bundled.id}.json`);
  const original = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  const scene = validateScene(withNarration(original ? validateScene(JSON.parse(original)) : bundled));
  if (!scene.audio?.filePath || !fs.existsSync(resolveAsset(scene.audio.filePath))) throw new Error(`Missing narration for ${scene.id}`);
  if (original !== null) fs.writeFileSync(path.join(backup, path.basename(target)), original);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(scene, null, 2) + '\n', { flag: 'wx' });
  if ((fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null) !== original) throw new Error(`Pose ${scene.id} changed during save`);
  fs.renameSync(temporary, target);
  saved++;
}
const entries = fs.readdirSync(library).filter(name => name.endsWith('.json') && name !== 'elevenlabs.json');
for (const name of entries) {
  const scene = validateScene(JSON.parse(fs.readFileSync(path.join(library, name), 'utf8')));
  if (packFilter && !scene.tags.includes(packFilter)) continue;
  if (!scene.audio?.filePath || !fs.existsSync(resolveAsset(scene.audio.filePath))) throw new Error(`Missing saved narration: ${scene.id}`);
}
console.log(JSON.stringify({ savedBundled: saved, totalSaved: entries.length, backup }));
