const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText, filename);
const { pushCloudSnapshot, fetchCloudSnapshot, applyCloudSnapshot, applyCloudPoseLibrary } = require('../electron/cloudSync.ts');

test('a cloud profile restores settings, templates, portable MP3s and pose images on another computer', async t => {
  const folder = await fsp.mkdtemp(path.join(os.tmpdir(), 'booth-cloud-'));
  t.after(() => fsp.rm(folder, { recursive: true, force: true }));
  const files = { 'voice.mp3': Buffer.from('voice audio'), 'frame.png': Buffer.from('template frame'), 'pose.webp': Buffer.from('pose image') };
  for (const [name, bytes] of Object.entries(files)) await fsp.writeFile(path.join(folder, name), bytes);
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const objects = new Map();
  let uploaded;
  let uploadCount = 0;
  global.fetch = async (url, request) => {
    if (url.includes('/storage/')) {
      if (request.method === 'POST') { objects.set(url, Buffer.from(request.body)); uploadCount++; return new Response(''); }
      assert.ok(objects.has(url), 'download uses the uploaded object');
      return new Response(objects.get(url));
    }
    uploaded = JSON.parse(request.body).payload;
    return Response.json([{ revision: 1, updated_at: 'today', payload: uploaded }]);
  };
  const settings = {
    eventName: 'Wedding', eventFolder: folder, eventId: 'event', boothSecret: 'secret',
    supabaseUrl: 'https://example.test', supabasePublishableKey: 'publishable', webApiBaseUrl: 'https://event.test',
    cameraId: 'camera', cameraControls: { brightness: 12 }, mirrorPreview: false,
    defaultPrinter: 'Printer', printCalibration: { leftBleedIn: .2 }, adminPassword: 'admin',
    ai: { providers: { openai: { apiKey: 'test-ai-key' } } },
    audio: { cues: { welcome: { filePath: 'project-asset:voice.mp3' } } },
    workflow: { shots: [{ audioCue: { filePath: 'project-asset:voice.mp3' } }] },
    template: { layouts: [{ id: 'layout', printerName: 'Printer' }], designs: [{ framePath: path.join(folder, 'frame.png') }] }
  };
  const pose = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/poses/accusation-circle-four.json'), 'utf8'));
  pose.audio = { filePath: 'project-asset:voice.mp3' };
  pose.visual.assetPath = 'pose-guides/test.webp';
  await pushCloudSnapshot(settings, { poses: [pose], deletedPoseIds: ['deleted'] }, {
    resolveAssetPath: value => value.startsWith('project-asset:') ? path.join(folder, value.slice('project-asset:'.length))
      : value.startsWith('pose-guides/') ? path.join(folder, 'pose.webp') : value,
    narrationSettings: { voiceId: 'voice', apiKey: 'test-narration-key' }
  });
  assert.equal(uploaded.version, 3);
  assert.equal(uploadCount, 3, 'repeated audio is uploaded once');
  assert.equal(uploaded.settings.boothSecret, undefined);
  assert.equal(uploaded.narrationSettings.apiKey, 'test-narration-key');
  assert.match(uploaded.poses[0].visual.assetPath, /^cloud-asset:/);
  const destination = { ...settings, eventFolder: path.join(folder, 'second-computer'), cameraId: 'other', adminPassword: 'other' };
  const restored = await applyCloudSnapshot(destination, uploaded);
  const restoredPoses = await applyCloudPoseLibrary(destination, uploaded);
  for (const key of ['eventName', 'webApiBaseUrl', 'cameraId', 'cameraControls', 'mirrorPreview', 'defaultPrinter', 'printCalibration', 'adminPassword', 'ai']) {
    assert.deepEqual(restored[key], settings[key], key);
  }
  assert.equal(restored.eventFolder, destination.eventFolder);
  assert.equal(restored.template.layouts[0].printerName, 'Printer');
  assert.deepEqual(await fsp.readFile(restored.audio.cues.welcome.filePath), files['voice.mp3']);
  assert.deepEqual(await fsp.readFile(restored.workflow.shots[0].audioCue.filePath), files['voice.mp3']);
  assert.deepEqual(await fsp.readFile(restored.template.designs[0].framePath), files['frame.png']);
  assert.deepEqual(await fsp.readFile(restoredPoses.poses[0].visual.assetPath), files['pose.webp']);
  assert.deepEqual(await fsp.readFile(restoredPoses.poses[0].audio.filePath), files['voice.mp3']);
  assert.deepEqual(restoredPoses.deletedPoseIds, ['deleted']);
});

test('unreadable files and rejected asset uploads never publish an incomplete profile', async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const folder = await fsp.mkdtemp(path.join(os.tmpdir(), 'booth-cloud-failure-'));
  t.after(() => fsp.rm(folder, { recursive: true, force: true }));
  const asset = path.join(folder, 'voice.mp3');
  const settings = { eventId: 'event', boothSecret: 'secret', supabaseUrl: 'https://example.test', audio: { filePath: asset } };
  const calls = [];
  global.fetch = async url => { calls.push(url); return new Response('Storage denied', { status: 403 }); };
  await assert.rejects(pushCloudSnapshot(settings, { poses: [] }), /Could not upload asset/);
  assert.equal(calls.length, 0);
  await fsp.writeFile(asset, 'audio');
  await assert.rejects(pushCloudSnapshot(settings, { poses: [] }), /Storage denied/);
  assert.equal(calls.length, 1);
  assert.ok(calls.every(url => url.includes('/storage/')));
});

test('old shared profiles keep local hardware and credentials when restored', async () => {
  const local = {
    eventFolder: 'local-folder', cameraId: 'local-camera', adminPassword: 'local-password',
    ai: { providers: { openai: { apiKey: 'local-key' }, gemini: { apiKey: '' }, xai: { apiKey: '' } } },
    template: { layouts: [{ id: 'layout', printerName: 'Local printer' }] }
  };
  const restored = await applyCloudSnapshot(local, {
    version: 2, settings: { eventName: 'Old event', template: { layouts: [{ id: 'layout', printerName: '' }] } }
  });
  assert.equal(restored.eventName, 'Old event');
  assert.equal(restored.cameraId, 'local-camera');
  assert.equal(restored.adminPassword, 'local-password');
  assert.equal(restored.ai.providers.openai.apiKey, 'local-key');
  assert.equal(restored.template.layouts[0].printerName, 'Local printer');
});

test('a fresh upload replaces the old profile and sync gets the newest settings and MP3 bytes', async t => {
  const folder = await fsp.mkdtemp(path.join(os.tmpdir(), 'booth-fresh-upload-'));
  t.after(() => fsp.rm(folder, { recursive: true, force: true }));
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const objects = new Map();
  let profile;
  global.fetch = async (url, request) => {
    if (url.includes('/storage/')) {
      if (request.method === 'POST') {
        objects.set(url, Buffer.from(request.body));
        return new Response('');
      }
      assert.equal(request.cache, 'no-store');
      return new Response(objects.get(url));
    }
    if (request.method === 'POST') {
      const body = JSON.parse(request.body);
      profile = { revision: body.revision, payload: body.payload };
    } else {
      assert.equal(request.cache, 'no-store');
    }
    return Response.json(profile ? [profile] : []);
  };
  const filePath = path.join(folder, 'voice.mp3');
  const source = { eventId: 'event', boothSecret: 'secret', supabaseUrl: 'https://example.test', eventFolder: folder,
    eventName: 'Old event', audio: { filePath }, template: { designs: [{ id: 'old-design' }] } };
  assert.equal(await fetchCloudSnapshot(source), null, 'empty cloud has no profile');
  await fsp.writeFile(filePath, 'old voice');
  await pushCloudSnapshot(source, { poses: [], deletedPoseIds: ['old-deletion'] });
  await fsp.writeFile(filePath, 'brand new voice');
  source.eventName = 'New event';
  source.template.designs = [{ id: 'new-design' }];
  await pushCloudSnapshot(source, { poses: [], deletedPoseIds: [] });
  const remote = await fetchCloudSnapshot(source);
  const target = { ...source, eventFolder: path.join(folder, 'different-windows-user'), eventName: 'Stale local event' };
  const restored = await applyCloudSnapshot(target, remote.payload);
  assert.equal(restored.eventName, 'New event');
  assert.deepEqual(restored.template.designs, [{ id: 'new-design' }]);
  assert.deepEqual(remote.payload.deletedPoseIds, []);
  assert.equal(await fsp.readFile(restored.audio.filePath, 'utf8'), 'brand new voice');
  assert.ok(restored.audio.filePath.startsWith(target.eventFolder));
});

test('upload never reads old cloud data to replace a missing local cached file', async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const folder = await fsp.mkdtemp(path.join(os.tmpdir(), 'booth-local-only-upload-'));
  t.after(() => fsp.rm(folder, { recursive: true, force: true }));
  global.fetch = async () => { assert.fail('a missing local file must not trigger a cloud read or write'); };
  await assert.rejects(pushCloudSnapshot({ eventId: 'event', boothSecret: 'secret', supabaseUrl: 'https://example.test',
    audio: { filePath: path.join(folder, 'cloud-sync-assets', 'a'.repeat(64) + '.mp3') } }, { poses: [] }), /ENOENT/);
});
