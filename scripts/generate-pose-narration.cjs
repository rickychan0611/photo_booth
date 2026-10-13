// Run with: node_modules/.bin/electron scripts/generate-pose-narration.cjs
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { app } = require('electron');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const root = path.resolve(__dirname, '..');
app.setPath('userData', path.join(process.env.APPDATA, 'photo-booth'));
const library = path.join(app.getPath('userData'), 'pose-library');
const manifestPath = path.join(root, 'src/pose/poses/narration-assets.json');
const reportPath = path.join(library, 'audio', 'narration-batch-report.json');
const { generateElevenLabsSpeech } = require('../electron/poseStorage.ts');
const { validateScene } = require('../electron/poseValidation.ts');
const ffmpeg = require('ffmpeg-static');
function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(tmp, file); break; }
    catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 20) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}
function duration(file) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-i', file, '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true });
  const match = result.stderr?.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
  if (result.status !== 0 || !match) throw new Error('MP3 could not be decoded');
  return Math.round((Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000);
}
function scriptFor(scene) {
  let cues = scene.animation.captions.map(c => c.text.trim().replace(/\s+/g, ' ')).filter(t => t && !/^(find your mark|get ready|start|begin|posing challenge|new caption)[.!]?$/i.test(t));
  cues = [...new Set(cues)];
  if (!cues.length) cues = [scene.instruction || scene.visual?.alt].filter(Boolean);
  if (!cues.length) throw new Error('No pose instructions available');
  return { cues, text: cues.map((cue, i) => cue.replace(/[.!?]+$/, '') + (i === cues.length - 1 ? '!' : '.')).join(' ') };
}
app.whenReady().then(async () => {
  const assets = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
  const jobs = require('../src/pose/poses/scenes.json').map(scene => ({ scene, bundled: true }));
  for (const name of fs.readdirSync(library).filter(n => n.endsWith('.json') && n !== 'elevenlabs.json')) {
    const file = path.join(library, name);
    const scene = validateScene(JSON.parse(fs.readFileSync(file, 'utf8')));
    const index = jobs.findIndex(job => job.scene.id === scene.id);
    if (index < 0) jobs.push({ scene, file });
    else jobs[index] = { scene, file };
  }
  const report = { startedAt: new Date().toISOString(), total: jobs.length, completed: [], skipped: [], failed: [] };
  const backup = path.join(library, 'audio', `narration-backup-${Date.now()}`);
  let cursor = 0, fatal = false;
  async function worker() {
    while (cursor < jobs.length && !fatal) {
      const job = jobs[cursor++], { scene } = job;
      try {
        const existing = job.bundled ? assets[scene.id] : scene.audio;
        if (existing?.filePath && fs.existsSync(existing.filePath)) {
          duration(existing.filePath); report.skipped.push(scene.id); continue;
        }
        const script = scriptFor(scene);
        let generated;
        for (let attempt = 0; attempt < 4; attempt++) {
          try { generated = await generateElevenLabsSpeech(scene.id, script.text); break; }
          catch (error) {
            if (!/429|502|503|504|fetch failed/i.test(error.message) || attempt === 3) throw error;
            await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
          }
        }
        const durationMs = duration(generated.filePath);
        if (job.bundled) {
          assets[scene.id] = { filePath: generated.filePath, durationMs, script: script.text, cues: script.cues };
          atomic(manifestPath, assets);
        } else {
          const current = JSON.parse(fs.readFileSync(job.file, 'utf8'));
          if (JSON.stringify(current) !== JSON.stringify(scene)) throw new Error('Pose changed during generation; cached MP3 preserved for next run');
          fs.mkdirSync(backup, { recursive: true }); fs.copyFileSync(job.file, path.join(backup, path.basename(job.file)));
          current.audio = { filePath: generated.filePath, startMs: 0, markers: [] };
          current.animation.durationMs = Math.min(120000, durationMs + 1000);
          current.animation.captions = script.cues.map((text, i) => ({ text, timeMs: script.cues.length === 1 ? 0 : Math.round(durationMs * i / (script.cues.length - 1)) }));
          atomic(job.file, validateScene(current));
        }
        report.completed.push(scene.id);
        console.log(`[${report.completed.length + report.skipped.length}/${jobs.length}] ${scene.id}${generated.cached ? ' (cached)' : ''}`);
      } catch (error) {
        report.failed.push({ id: scene.id, error: error.message }); console.error(`${scene.id}: ${error.message}`);
        if (/401|quota_exceeded|402|invalid_api_key/.test(error.message)) fatal = true;
      } finally { atomic(reportPath, report); }
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  report.finishedAt = new Date().toISOString(); atomic(reportPath, report);
  console.log(JSON.stringify({ completed: report.completed.length, skipped: report.skipped.length, failed: report.failed.length, unprocessed: jobs.length - cursor }));
  app.exit(report.failed.length || fatal ? 1 : 0);
}).catch(error => { console.error(error.message); app.exit(1); });
