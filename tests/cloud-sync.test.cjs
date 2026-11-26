const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(require.resolve('../electron/main.ts'), 'utf8');
const start = source.indexOf('async function performCloudDownload()');
const end = source.indexOf('app.whenReady().then', start);
const code = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText;

function harness(overrides = {}) {
  const calls = [];
  const local = { eventId: 'event', localCamera: 'camera' };
  const library = { poses: [{ id: 'kept' }], deletedPoseIds: ['removed'] };
  const remote = { revision: 5, updated_at: '2026-11-25', payload: { version: 2, ...library } };
  const context = {
    cloudSyncRunning: null,
    readSettings: async () => local,
    cloudSyncConfigured: () => true,
    publishCloudSyncStatus: status => { calls.push(['status', status]); return status; },
    fetchCloudSnapshot: async () => { calls.push(['fetch']); return remote; },
    pushCloudSnapshot: async (...args) => { calls.push(['push', ...args]); return remote; },
    listStoredPoses: async () => library,
    applyCloudSnapshot: async () => ({ ...local, downloaded: true }),
    applyCloudPoseLibrary: async () => library,
    replaceStoredPoses: async (...args) => { calls.push(['replacePoses', ...args]); },
    normalizeLoadedSettings: value => value,
    writeSettings: async value => { calls.push(['writeSettings', value]); return value; },
    writeCloudSyncState: async value => { calls.push(['writeState', value]); },
    cloudProfileId: () => 'profile',
    cloudFingerprint: () => 'fingerprint',
    ...overrides
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  return { context, calls, local, library };
}

test('download applies cloud poses and deletions without uploading', async () => {
  const { context, calls } = harness();
  const result = await context.runCloudTransfer('download');
  assert.equal(result.state, 'synced');
  assert.equal(calls.filter(c => c[0] === 'push').length, 0);
  assert.deepEqual(calls.find(c => c[0] === 'replacePoses').slice(1), [[{ id: 'kept' }], ['removed']]);
  assert.equal(calls.find(c => c[0] === 'writeSettings')[1].downloaded, true);
});

test('missing cloud profile never uploads or replaces local data', async () => {
  const { context, calls } = harness({ fetchCloudSnapshot: async () => null });
  assert.equal((await context.runCloudTransfer('download')).state, 'error');
  assert.equal(calls.some(c => ['push', 'replacePoses', 'writeSettings'].includes(c[0])), false);
});

test('explicit upload sends the local library including deletions without downloading', async () => {
  const { context, calls, local, library } = harness();
  assert.equal((await context.runCloudTransfer('upload')).state, 'synced');
  assert.deepEqual(calls.find(c => c[0] === 'push').slice(1), [local, library]);
  assert.equal(calls.some(c => ['fetch', 'replacePoses', 'writeSettings'].includes(c[0])), false);
});

test('unconfigured transfers and download failures never upload', async () => {
  for (const direction of ['upload', 'download']) {
    const { context, calls } = harness({ cloudSyncConfigured: () => false });
    assert.equal((await context.runCloudTransfer(direction)).state, 'error');
    assert.equal(calls.some(c => ['push', 'fetch'].includes(c[0])), false);
  }
  const { context, calls } = harness({ fetchCloudSnapshot: async () => { throw new Error('offline'); } });
  assert.equal((await context.runCloudTransfer('download')).state, 'error');
  assert.equal(calls.some(c => c[0] === 'push'), false);
});

test('overlapping button presses do not start a second transfer', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { context, calls } = harness({ fetchCloudSnapshot: async () => { await gate; return null; } });
  const downloading = context.runCloudTransfer('download');
  assert.equal(context.runCloudTransfer('upload'), downloading);
  release();
  await downloading;
  assert.equal(calls.some(c => c[0] === 'push'), false);
  assert.equal(context.cloudSyncRunning, null);
});

test('settings and pose edits have no automatic cloud transfer hook', () => {
  const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
  const settingsWriter = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'writeSettings');
  assert.ok(settingsWriter);
  assert.doesNotMatch(settingsWriter.getText(ast), /cloud|Cloud/);
  assert.match(source, /registerPoseStorage\(\)/);
  assert.doesNotMatch(source, /scheduleCloudSave|cloudSaveDelay|cloud-sync:now/);
});
