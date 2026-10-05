const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');

require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  module._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
};
const { PosePlayer } = require('../src/pose/PosePlayer.ts');
const { captionAt, PHOTO_GUIDE_SCENES } = require('../src/pose/scenes.ts');
const { validateScene } = require('../src/pose/validation.ts');
const { createPoseAudioHooks } = require('../src/pose/audio.ts');
const { fitSceneToNarration } = require('../src/pose/editor/operations.ts');
const pose = PHOTO_GUIDE_SCENES.find(scene => scene.id === 'peace-and-wink');
const copy = () => structuredClone(pose);
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
class Clock {
  value = 0; id = 0; pending = new Map();
  now = () => this.value;
  request = (callback) => { this.pending.set(++this.id, callback); return this.id; };
  cancel = (id) => this.pending.delete(id);
  advance(ms) {
    this.value += ms;
    const callbacks = [...this.pending.values()]; this.pending.clear();
    callbacks.forEach((callback) => callback(this.value));
  }
}

test('photo guides teach on the scene clock and hold the final caption', () => {
  assert.equal(pose.animation.durationMs, 7000);
  assert.equal(captionAt(pose, -100).elapsedMs, 0);
  assert.equal(captionAt(pose, 0).caption, pose.animation.captions[0].text);
  assert.notEqual(captionAt(pose, 600).caption, captionAt(pose, 0).caption);
  assert.equal(captionAt(pose, 7000).caption, pose.animation.captions.at(-1).text);
  assert.equal(captionAt(pose, 9000).elapsedMs, 7000);
});

test('narration automatically sets pose duration and evenly spaces captions', () => {
  const scene = copy();
  scene.audio = { filePath: 'C:\\poses\\peace.mp3', startMs: 700, markers: [{ id: 'old', timeMs: 900 }] };
  scene.animation.captions = [
    { timeMs: 0, text: 'Turn slightly', markerId: 'old', markerOffsetMs: -900 },
    { timeMs: 800, text: 'Lift your hand' },
    { timeMs: 2400, text: 'Wink and smile' }
  ];
  const fitted = fitSceneToNarration(scene, 5000);
  assert.equal(fitted.animation.durationMs, 6000);
  assert.deepEqual(fitted.animation.captions.map(caption => caption.timeMs), [0, 2500, 5000]);
  assert.equal(fitted.audio.startMs, 0);
  assert.deepEqual(fitted.audio.markers, []);
  assert.equal('markerId' in fitted.animation.captions[0], false);
});

test('validation rejects malformed cutout scenes before they can play', () => {
  const mutations = [
    p => p.schemaVersion = 1,
    p => p.animation.durationMs = NaN,
    p => p.animation.captions[0].timeMs = 1,
    p => p.animation.captions = [],
    p => p.roles = [],
    p => p.visual.assetPath = 'https://example.com/pose.webp',
    p => p.audio = { filePath: 'https://example.com/voice.mp3' }
  ];
  for (const mutate of mutations) { const item = copy(); mutate(item); assert.throws(() => validateScene(item), /Invalid pose/); }
});

test('player completes precisely at duration without an additional hold', async () => {
  const clock = new Clock(), frames = [];
  const player = new PosePlayer({ clock, onFrame: frame => frames.push(frame) });
  const result = player.play(pose);
  clock.advance(6999); assert.equal(frames.at(-1).elapsedMs, 6999); assert.equal(clock.pending.size, 1);
  clock.advance(1); assert.equal(await result, 'completed'); assert.equal(clock.pending.size, 0);
  assert.equal(frames.at(-1).elapsedMs, 7000);
});

test('stop and abort cancel playback and reset clears the caption', async () => {
  const clock = new Clock(), frames = [], signal = new AbortController();
  const player = new PosePlayer({ clock, onFrame: frame => frames.push(frame) });
  const first = player.play(pose, { signal: signal.signal }); clock.advance(1200); signal.abort();
  assert.equal(await first, 'cancelled');
  const count = frames.length; clock.advance(10000); assert.equal(frames.length, count);
  const second = player.play(pose); player.reset(); assert.equal(await second, 'cancelled');
  assert.equal(frames.at(-1).caption, '');
  assert.equal(frames.at(-1).elapsedMs, 0);
  assert.equal(await player.play(pose, { signal: signal.signal }), 'cancelled');
});

test('pose replacement cancels the previous run and starts at the first caption', async () => {
  const clock = new Clock(), frames = [];
  const next = PHOTO_GUIDE_SCENES.find(scene => scene.id === 'runway-cross-step');
  const player = new PosePlayer({ clock, onFrame: frame => frames.push(frame) });
  const first = player.play(pose); clock.advance(2000);
  const second = player.play(next);
  assert.equal(await first, 'cancelled');
  assert.equal(frames.at(-1).caption, next.animation.captions[0].text);
  clock.advance(next.animation.durationMs); assert.equal(await second, 'completed');
});

test('audio starts at authored time; markers fire once; completion and cancellation stop audio', async () => {
  const clock = new Clock(), calls = [], markers = [];
  const audioPose = copy(); audioPose.audio = { filePath: 'C:/poses/peace.wav', startMs: 500, markers: [{ timeMs: 1000, id: 'raise' }] };
  const player = new PosePlayer({ clock, onFrame: () => {}, onAudioMarker: id => markers.push(id), audio: { prepare: async () => calls.push('prepare'), start: () => calls.push('start'), stop: () => calls.push('stop') } });
  const result = player.play(audioPose); await flush();
  assert.deepEqual(calls, ['stop', 'prepare']);
  clock.advance(500); assert.equal(calls.at(-1), 'start');
  clock.advance(500); clock.advance(500); assert.deepEqual(markers, ['raise']);
  clock.advance(6500); assert.equal(await result, 'completed'); assert.equal(calls.at(-1), 'stop');
  const cancelled = player.play(audioPose); await flush(); clock.advance(500); player.stop();
  assert.equal(await cancelled, 'cancelled'); assert.equal(calls.at(-1), 'stop');
});

test('cancellation resolves even when an audio preload never returns', async () => {
  const audioPose = copy(); audioPose.audio = { filePath: 'C:/missing.wav' };
  const player = new PosePlayer({ clock: new Clock(), onFrame: () => {}, audio: { prepare: () => new Promise(() => {}), start: () => assert.fail('Cancelled audio started'), stop: () => {} } });
  const pending = player.play(audioPose); player.stop();
  assert.equal(await pending, 'cancelled');
});

test('missing narration and rendering errors do not leave dangling animation frames', async () => {
  const clock = new Clock(), errors = [];
  const item = copy(); item.audio = { filePath: 'C:/missing.wav' };
  const player = new PosePlayer({ clock, onFrame: () => {}, onError: error => errors.push(error), audio: { prepare: async () => { throw Error('missing file'); }, start: () => {}, stop: () => {} } });
  const pending = player.play(item); await flush(); clock.advance(8000);
  assert.equal(await pending, 'completed'); assert.equal(errors.length, 1);
  const broken = new PosePlayer({ clock, onFrame: () => { throw Error('render failed'); } });
  assert.equal(await broken.play(pose), 'failed'); assert.equal(clock.pending.size, 0);
});

test('photo guides advance scene captions without a skeleton', async () => {
  const { ScenePlayer } = require('../src/pose/ScenePlayer.ts');
  const clock = new Clock(), frames = [];
  const player = new ScenePlayer(frame => frames.push(frame), undefined, clock);
  const pending = player.play(pose);
  await flush();
  assert.equal(frames.at(-1).caption, pose.animation.captions[0].text);
  assert.equal('participants' in frames.at(-1), false);
  clock.advance(1500);
  assert.equal(frames.at(-1).caption, pose.animation.captions.find(item => item.timeMs === 1500).text);
  clock.advance(5500);
  assert.equal(await pending, 'completed');
  assert.equal(frames.at(-1).elapsedMs, 7000);
  assert.equal(frames.at(-1).caption, pose.animation.captions.at(-1).text);
  player.dispose();
  const bare = structuredClone(pose); delete bare.visual;
  assert.equal(await new ScenePlayer(() => {}, undefined, new Clock()).play(bare), 'failed');
});

test('local audio adapter tolerates missing files, preloads once, and stops stale narration', async () => {
  const settings = { audio: { enabled: true, masterVolume: 1, voiceVolume: 1, musicVolume: 1, sfxVolume: 1, volume: 1 } };
  const item = copy(); item.audio = { filePath: 'C:/poses/narration.wav' };
  let reads = 0, played = 0, paused = 0;
  global.window = { photoBooth: { getAudioDataUrl: async () => { reads++; return ''; } } };
  const hooks = createPoseAudioHooks(() => settings);
  await hooks.prepare(item, new AbortController().signal); await hooks.start(item); hooks.stop();
  assert.equal(played, 0);
  global.Audio = class { dataset = {}; volume = 1; src = ''; addEventListener() {} async play() { played++; } pause() { paused++; } };
  window.photoBooth.getAudioDataUrl = async () => { reads++; return 'data:audio/wav;base64,AA=='; };
  await hooks.prepare(item, new AbortController().signal); await hooks.start(item); hooks.stop();
  assert.equal(reads, 2); assert.equal(played, 1); assert.equal(paused, 1);
  let complete;
  window.photoBooth.getAudioDataUrl = () => new Promise(resolve => complete = resolve);
  const controller = new AbortController();
  const pending = hooks.prepare(item, controller.signal); controller.abort(); hooks.stop(); await pending;
  complete('data:audio/wav;base64,AA=='); await flush(); await hooks.start(item);
  assert.equal(played, 1);
  delete global.window; delete global.Audio;
});
