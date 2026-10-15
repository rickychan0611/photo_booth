const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText, filename);

test('new narration requests timestamps, saves aligned captions, and reuses the cached result', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-narration-tests-'));
  assert.ok(path.resolve(folder).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.mkdirSync(path.join(folder, 'pose-library'));
  fs.writeFileSync(path.join(folder, 'pose-library', 'elevenlabs.json'), JSON.stringify({ voiceId: 'test-voice-123', modelId: 'eleven_v3' }));
  const originalLoad = Module._load, originalFetch = global.fetch, originalKey = process.env.ELEVENLABS_API_KEY;
  Module._load = function(name, ...args) {
    if (name === 'electron') return { app: { isPackaged: false, getPath: () => folder, getAppPath: () => folder }, dialog: {}, ipcMain: {}, safeStorage: {} };
    return originalLoad.call(this, name, ...args);
  };
  const { generateElevenLabsSpeech } = require('../electron/poseStorage.ts');
  Module._load = originalLoad;
  const buffer = Buffer.alloc(44 + 64000);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24); buffer.writeUInt32LE(32000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(64000, 40);
  let requests = 0;
  process.env.ELEVENLABS_API_KEY = 'test-key';
  global.fetch = async (url, options) => {
    requests++;
    assert.match(url, /\/text-to-speech\/test-voice-123\/with-timestamps\?/);
    assert.equal(JSON.parse(options.body).model_id, 'eleven_v3');
    const characters = [...'One. Two.'];
    return { ok: true, json: async () => ({ audio_base64: buffer.toString('base64'), normalized_alignment: {
      characters, character_start_times_seconds: characters.map((_, i) => i / 20), character_end_times_seconds: characters.map((_, i) => (i + 1) / 20)
    } }) };
  };
  try {
    const first = await generateElevenLabsSpeech('test-pose', 'One. Two.', folder, ['One', 'Two']);
    assert.equal(first.cached, false);
    assert.equal(first.speechTiming.audioDurationMs, 2000);
    assert.deepEqual(first.speechTiming.captions.map(caption => caption.timeMs), [0, 250]);
    const again = await generateElevenLabsSpeech('test-pose', 'One. Two.', folder, ['One', 'Two']);
    assert.equal(again.cached, true);
    assert.deepEqual(again.speechTiming, first.speechTiming);
    assert.equal(requests, 1);
  } finally {
    Module._load = originalLoad; global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = originalKey;
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
