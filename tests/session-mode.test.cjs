const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');

require.extensions['.ts'] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText, filename);
};
const { needsGroupSelection, photoForMode, modeAudioDefaults, NORMAL_PHOTO_MESSAGE } = require('../electron/sessionMode.ts');

test('only Fun mode asks for a group, respecting the event group setting', () => {
  assert.equal(needsGroupSelection('fun', true), true);
  assert.equal(needsGroupSelection('fun', false), false);
  assert.equal(needsGroupSelection('normal', true), false);
  assert.equal(needsGroupSelection('normal', false), false);
});

test('legacy game messages and voice files survive while normal mode gets independent defaults', () => {
  const gameCue = { ...modeAudioDefaults().normalShot0, id: 'shot0', text: 'Custom challenge!', filePath: 'existing.mp3' };
  const cues = { ...modeAudioDefaults(), shot0: gameCue };
  const legacy = { message: 'Custom challenge!', cameraBeforeMessageMs: 500, messageMs: 1500, cameraBeforeCountdownMs: 2000 };
  const fun = photoForMode(legacy, cues, 0, 'fun');
  const normal = photoForMode(legacy, cues, 0, 'normal');
  assert.equal(fun.message, legacy.message);
  assert.equal(fun.audioCue, gameCue);
  assert.equal(normal.message, NORMAL_PHOTO_MESSAGE);
  assert.equal(normal.audioCue.id, 'normalShot0');
  assert.equal(normal.audioCue.filePath, '');
  assert.equal(normal.cameraBeforeMessageMs, fun.cameraBeforeMessageMs);
  assert.equal(normal.messageMs, fun.messageMs);
  assert.equal(normal.cameraBeforeCountdownMs, fun.cameraBeforeCountdownMs);
  assert.equal(legacy.normalMessage, undefined);
});

test('switching modes and editing a normal script cannot reuse a game voice', () => {
  const cues = modeAudioDefaults();
  cues.normalShot11 = { ...cues.normalShot11, text: 'A relaxed final photo.', filePath: 'normal-final.mp3' };
  cues.shot11 = { ...cues.normalShot11, id: 'shot11', text: 'Final challenge!', filePath: 'game-final.mp3' };
  const shot = { message: 'Final challenge!', normalMessage: 'A relaxed final photo.', messageMs: 1000 };
  assert.equal(photoForMode(shot, cues, 11, 'fun').audioCue.filePath, 'game-final.mp3');
  assert.equal(photoForMode(shot, cues, 11, 'normal').audioCue.filePath, 'normal-final.mp3');
  assert.equal(photoForMode(shot, cues, 11, 'normal').message, 'A relaxed final photo.');
  delete cues.normalShot11;
  assert.equal(photoForMode(shot, cues, 11, 'normal').audioCue, undefined);
});

test('new voice defaults include the mode screen and all twelve normal photo slots', () => {
  const cues = modeAudioDefaults();
  assert.equal(Object.keys(cues).length, 13);
  assert.match(cues.mode.text, /Tap Fun Pose Challenge/);
  for (let i = 0; i < 12; i++) {
    assert.equal(cues[`normalShot${i}`].text, NORMAL_PHOTO_MESSAGE);
    assert.equal(cues[`normalShot${i}`].channel, 'voice');
  }
  cues.normalShot0.text = 'Edited';
  assert.equal(modeAudioDefaults().normalShot0.text, NORMAL_PHOTO_MESSAGE);
});
