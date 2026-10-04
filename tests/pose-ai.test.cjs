const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const { compilePoseAiPlan, generatePoseFromDescription, validatePoseAiPlan } = require('../electron/poseAiCore.ts');
const { validateScene } = require('../electron/poseValidation.ts');
const { captionAt } = require('../src/pose/scenes.ts');

const plan = () => ({
  name: 'Peaceful lean', category: 'cute', tags: ['solo', 'peace'], instruction: 'Lean left, lift a peace sign, smile and wink.', introCaption: 'Start standing', durationMs: 4000,
  compatibility: { minPeople: 1, maxPeople: 1, styles: ['solo'], framing: ['full', 'half'], childSafe: true },
  roles: [{ role: 'any', repeatable: false }],
  captions: [
    { progress: .4, text: 'Lift your right hand' },
    { progress: 1, text: 'Lean, smile and wink' }
  ]
});

const settings = provider => ({ ai: {
  poseGenerator: { provider, providers: {
    openai: { apiUrl: 'https://api.openai.test/v1/responses', model: 'openai-text' },
    gemini: { apiUrl: 'https://gemini.test/v1beta/interactions', model: 'gemini-text' },
    xai: { apiUrl: 'https://api.x.test/v1/responses', model: 'xai-text' }
  } },
  providers: {
    openai: { enabled: true, apiKey: 'openai-key' }, gemini: { enabled: true, apiKey: 'gemini-key' }, xai: { enabled: true, apiKey: 'xai-key' }
  }
} });

test('AI plan compiles into a validated cutout scene with timed captions', () => {
  const scene = compilePoseAiPlan(plan(), 'openai');
  assert.equal(validateScene(scene), scene);
  assert.match(scene.id, /^ai-peaceful-lean-/);
  assert.equal(scene.participants, undefined);
  assert.deepEqual(scene.roles, [{ role: 'any', repeatable: false }]);
  assert.deepEqual(scene.animation.captions.map(caption => caption.timeMs), [0, 800, 2000]);
  assert.equal(captionAt(scene, 4000).caption, captionAt(scene, 2000).caption);
  assert.ok(scene.tags.includes('ai-generated'));
});

test('AI plan validation rejects unordered captions and empty instructions', () => {
  const unordered = plan(); unordered.captions[1].progress = .3;
  assert.throws(() => validatePoseAiPlan(unordered), /unordered/);
  const blank = plan(); blank.captions[0].text = ' ';
  assert.throws(() => validatePoseAiPlan(blank), /invalid caption/);
});

test('flexible AI group plans receive a repeatable role and remain valid', () => {
  const group = plan(); group.compatibility = { minPeople: 4, maxPeople: 0, styles: ['group'], framing: ['full'], childSafe: true };
  group.roles[0].repeatable = false;
  const scene = compilePoseAiPlan(group, 'gemini');
  assert.equal(scene.compatibility.maxPeople, null);
  assert.equal(scene.roles[0].repeatable, true);
  assert.doesNotThrow(() => validateScene(scene));
});

for (const provider of ['openai', 'gemini', 'xai']) test(`${provider} adapter requests structured output and returns a validated preview`, async () => {
  let request;
  const fetcher = async (url, init) => {
    request = { url: String(url), init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ output_text: JSON.stringify(plan()) }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const result = await generatePoseFromDescription({ description: 'Lean left with a right-hand peace sign and wink.', provider }, settings(provider), fetcher);
  assert.equal(result.provider, provider);
  assert.equal(result.model, `${provider}-text`);
  assert.doesNotThrow(() => validateScene(result.scene));
  assert.ok(request.body.response_format || request.body.text?.format);
  if (provider === 'gemini') assert.equal(request.init.headers['x-goog-api-key'], 'gemini-key');
  else assert.match(request.init.headers.Authorization, /^Bearer /);
});

test('generation rejects missing credentials, provider errors and malformed JSON', async () => {
  const missing = settings('openai'); missing.ai.providers.openai.apiKey = '';
  await assert.rejects(generatePoseFromDescription({ description: 'Raise both hands and smile brightly.' }, missing, async () => { throw new Error('must not call'); }), /API key is missing/);
  await assert.rejects(generatePoseFromDescription({ description: 'Raise both hands and smile brightly.' }, settings('openai'), async () => new Response(JSON.stringify({ error: { message: 'quota reached' } }), { status: 429 })), /quota reached/);
  await assert.rejects(generatePoseFromDescription({ description: 'Raise both hands and smile brightly.' }, settings('openai'), async () => new Response(JSON.stringify({ output_text: 'not-json' }), { status: 200 })), /invalid JSON/);
});
