const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');
const ffmpeg = require('ffmpeg-static');

require.extensions['.ts'] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText, filename);
};
const { enqueueVideoJob, runVideoProcess, sessionVideoOutroArgs } = require('../electron/videoProcessing.ts');

test('background jobs wait their turn and continue after a failure', async () => {
  const events = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const first = enqueueVideoJob(async () => { events.push('first'); await gate; events.push('finished'); });
  const second = enqueueVideoJob(async () => { events.push('second'); throw new Error('failed job'); });
  const rejected = assert.rejects(second, /failed job/);
  const third = enqueueVideoJob(async () => { events.push('third'); return 'saved'; });
  await Promise.resolve();
  assert.deepEqual(events, ['first']);
  release();
  await first;
  await rejected;
  assert.equal(await third, 'saved');
  assert.deepEqual(events, ['first', 'finished', 'second', 'third']);
});

test('process launch and encoding errors do not block later jobs', async () => {
  await assert.rejects(enqueueVideoJob(() => runVideoProcess('', [])), /not available/);
  await assert.rejects(enqueueVideoJob(() => runVideoProcess('missing-photo-booth-ffmpeg.exe', [])), /ENOENT/);
  await assert.rejects(enqueueVideoJob(() => runVideoProcess(ffmpeg, ['-invalid-photo-booth-option'])), /Video processing failed/);
  await enqueueVideoJob(() => runVideoProcess(ffmpeg, ['-version']));
});

test('real session videos keep the photo, optional logo, audio, and 24fps at 720x1280', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-booth-video-test-'));
  const photo = path.join(folder, 'photo.png');
  const logo = path.join(folder, 'logo.png');
  try {
    await runVideoProcess(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=360x640', '-frames:v', '1', '-threads', '1', photo]);
    await runVideoProcess(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=100x100', '-frames:v', '1', '-threads', '1', logo]);
    for (const withAudio of [false, true]) {
      const source = path.join(folder, `source-${withAudio}.webm`);
      const output = path.join(folder, `final-${withAudio}.mp4`);
      const inputArgs = ['-y', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=30'];
      if (withAudio) inputArgs.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000');
      // Non-square source pixels also exercise concat's aspect-ratio handling.
      inputArgs.push('-t', '1', '-vf', 'setsar=4/3', '-c:v', 'libvpx', '-threads', '1', '-c:a', 'libopus', source);
      await runVideoProcess(ffmpeg, inputArgs);
      await enqueueVideoJob(() => runVideoProcess(ffmpeg, sessionVideoOutroArgs(source, photo, withAudio ? logo : '', output)));
      const decoded = spawnSync(ffmpeg, ['-nostdin', '-threads', '1', '-i', output, '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true });
      assert.equal(decoded.status, 0, decoded.stderr);
      assert.match(decoded.stderr, /Video: h264/);
      assert.match(decoded.stderr, /720x1280/);
      assert.match(decoded.stderr, /24 fps/);
      assert.match(decoded.stderr, /SAR 1:1/);
      if (withAudio) assert.match(decoded.stderr, /Audio: aac/);
      else assert.doesNotMatch(decoded.stderr, /Audio:/);
      const duration = decoded.stderr.match(/Duration: 00:00:(\d+\.\d+)/);
      assert.ok(duration, decoded.stderr);
      assert.ok(Math.abs(Number(duration[1]) - (withAudio ? 8.5 : 6)) < 0.15, duration[0]);
      assert.ok(fs.statSync(output).size > 1000);
    }
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
