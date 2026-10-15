const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText, filename);
const { timingFromCharacters, hasMatchingSpeechTiming, applySpeechTiming } = require('../electron/poseAlignment.ts');
const { alignSpeechFile } = require('../electron/speechAlignmentApi.ts');
const { validateScene } = require('../electron/poseValidation.ts');
const { PHOTO_GUIDE_SCENES } = require('../src/pose/scenes.ts');

function characters(text) {
  return [...text].map((text, i) => ({ text, start: i / 20, end: (i + 1) / 20 }));
}

test('phrases match real speech timestamps despite punctuation, casing and repeated words', () => {
  const text = 'Smile! Smile again. Turn left.';
  const timing = timingFromCharacters(['smile', 'Smile again!', 'Turn left'], characters(text), 3000);
  assert.deepEqual(timing.captions.map(caption => caption.timeMs), [0, 350, 1000]);
});

test('unmatched phrases and invalid or overlapping provider timestamps fail explicitly', () => {
  assert.throws(() => timingFromCharacters(['Never spoken'], characters('Smile'), 1000), /does not match/);
  assert.throws(() => timingFromCharacters(['Smile'], [{ text: 'Smile', start: NaN, end: 1 }], 1000), /Invalid/);
  assert.throws(() => timingFromCharacters(['A', 'B'], [{ text: 'A', start: 0, end: 0 }, { text: 'B', start: 0, end: 1 }], 1000), /overlapping/);
});

test('saved measured timing validates and does not change pose compatibility or audio path', () => {
  const scene = structuredClone(PHOTO_GUIDE_SCENES[0]);
  scene.audio = { filePath: 'project-asset:audio/test.mp3' };
  const timing = { version: 1, audioDurationMs: 5000, captions: scene.animation.captions.map((caption, index) => ({ text: caption.text, timeMs: index * 1000 })) };
  const synced = validateScene(applySpeechTiming(scene, timing));
  assert.equal(synced.animation.durationMs, 6000);
  assert.equal(synced.audio.filePath, scene.audio.filePath);
  assert.deepEqual(synced.compatibility, scene.compatibility);
  assert.equal(hasMatchingSpeechTiming(synced), true);
  synced.animation.captions[1].text = 'New instruction';
  assert.equal(hasMatchingSpeechTiming(synced), false);
  synced.audio.speechTiming.captions[1].timeMs = -1;
  assert.throws(() => validateScene(synced), /speech caption timing/);
});

test('alignment reuses cached timestamps and invalidates them when audio bytes change', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-caption-tests-'));
  assert.ok(path.resolve(folder).startsWith(path.resolve(os.tmpdir()) + path.sep));
  const file = path.join(folder, 'speech.wav');
  const buffer = Buffer.alloc(44 + 64000);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24); buffer.writeUInt32LE(32000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(64000, 40); fs.writeFileSync(file, buffer);
  const originalFetch = global.fetch;
  let requests = 0;
  global.fetch = async (url, options) => {
    requests++;
    assert.equal(url, 'https://api.elevenlabs.io/v1/forced-alignment');
    assert.equal(options.body.get('text'), 'One. Two.');
    return { ok: true, json: async () => ({ characters: characters('One. Two.') }) };
  };
  try {
    const first = await alignSpeechFile(file, 'One. Two.', ['One', 'Two'], 'test-key');
    assert.equal(first.audioDurationMs, 2000);
    assert.deepEqual(await alignSpeechFile(file, 'One. Two.', ['One', 'Two'], 'test-key'), first);
    assert.equal(requests, 1);
    buffer[100] = 1; fs.writeFileSync(file, buffer);
    await alignSpeechFile(file, 'One. Two.', ['One', 'Two'], 'test-key');
    assert.equal(requests, 2);
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
