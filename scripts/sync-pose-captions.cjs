// Reuse every saved recording and persist speech-aligned captions. Safe to resume.
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const root = path.resolve(__dirname, '..');
app.setAppPath(root);
app.setPath('userData', path.join(process.env.APPDATA, 'photo-booth'));
const { syncPoseNarration, saveStoredPose } = require('../electron/poseStorage.ts');
const { hasMatchingSpeechTiming } = require('../electron/poseAlignment.ts');
const reportFile = path.join(root, 'output', 'pose-caption-sync.json');
const backup = path.join(app.getPath('userData'), 'pose-library', 'caption-backups', String(Date.now()));
function reportSave(report) {
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  const temporary = `${reportFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(report, null, 2) + '\n');
  fs.renameSync(temporary, reportFile);
}
app.whenReady().then(async () => {
  const folder = path.join(root, 'config', 'poses');
  let jobs = fs.readdirSync(folder).filter(name => name.endsWith('.json')).sort();
  const limit = Number(process.argv.find(arg => arg.startsWith('--limit='))?.split('=')[1]);
  if (limit > 0) jobs = jobs.slice(0, limit);
  const report = { startedAt: new Date().toISOString(), total: jobs.length, backup, completed: [], skipped: [], failed: [] };
  fs.mkdirSync(backup, { recursive: true });
  let cursor = 0, fatal = false;
  async function worker() {
    while (!fatal && cursor < jobs.length) {
      const name = jobs[cursor++], file = path.join(folder, name);
      try {
        const original = fs.readFileSync(file, 'utf8'), scene = JSON.parse(original);
        if (hasMatchingSpeechTiming(scene)) { report.skipped.push(scene.id); continue; }
        let synced;
        for (let attempt = 0; attempt < 3; attempt++) {
          try { synced = await syncPoseNarration(scene); break; }
          catch (error) {
            if (!/429|502|503|504|fetch failed|timed out|could not be decoded/i.test(error.message) || attempt === 2) throw error;
            await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
          }
        }
        if (fs.readFileSync(file, 'utf8') !== original) throw new Error('Pose was edited during sync; recording preserved. Retry this pose.');
        fs.writeFileSync(path.join(backup, name), original, { flag: 'wx' });
        await saveStoredPose(synced);
        report.completed.push(scene.id);
        console.log(`[${report.completed.length + report.skipped.length}/${jobs.length}] ${scene.id}`);
      } catch (error) {
        report.failed.push({ file: name, error: error.message });
        console.error(`${name}: ${error.message}`);
        if (/401|402|403|quota_exceeded|invalid_api_key|API key|could not be decrypted/.test(error.message)) fatal = true;
      } finally { reportSave(report); }
    }
  }
  await Promise.all(Array.from({ length: 3 }, worker));
  report.finishedAt = new Date().toISOString();
  reportSave(report);
  console.log(JSON.stringify({ completed: report.completed.length, skipped: report.skipped.length, failed: report.failed.length, unprocessed: jobs.length - cursor, reportFile }));
  app.exit(report.failed.length || fatal ? 1 : 0);
}).catch(error => { console.error(error.message); app.exit(1); });
