const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022, esModuleInterop:true}}).outputText, filename);
const pack = require('../scripts/meme-pose-pack.cjs');
const {validateScene} = require('../electron/poseValidation.ts');
const {sceneMatches} = require('../src/pose/scenes.ts');

test('all 40 meme poses validate and accept every gender at each supported group size', () => {
  assert.equal(pack.length, 40);
  assert.equal(new Set(pack.map(pose => pose.scene.id)).size, 40);
  for (const {scene} of pack) {
    validateScene(scene);
    for (let count = scene.compatibility.minPeople; count <= scene.compatibility.maxPeople; count++) {
      for (const [men,women,boys,girls] of [[count,0,0,0],[0,count,0,0],[0,0,count,0],[0,0,0,count],[Math.floor(count/2),count-Math.floor(count/2),0,0]]) {
        const style = count === 1 ? 'solo' : 'group';
        for (const framing of scene.compatibility.framing) assert.ok(sceneMatches(scene, {men,women,boys,girls,style}, framing), `${scene.id}, count ${count}, ${framing}`);
      }
    }
    assert.equal(sceneMatches(scene, {men:scene.compatibility.maxPeople+1,women:0,boys:0,girls:0,style:'group'},'full'),false);
  }
});
