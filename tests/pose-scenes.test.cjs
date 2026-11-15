const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const { BUNDLED_SCENES, PHOTO_GUIDE_SCENES, sceneMatches, captionAt, slotFraming, slotGeometry, validateComposition } = require('../src/pose/scenes.ts');
const { validateScene } = require('../src/pose/validation.ts');
const photoPromptManifest = require('../src/pose/poses/photo-prompts-rest.json');
const photoAssets = require('../src/pose/poses/photo-assets.json');
const { addStep, moveStep, deleteStep, resizeScene, alignStep, moveMarker } = require('../src/pose/editor/operations.ts');
const { POSE_CATEGORIES, normalizePoseGuide, poseCategories } = require('../electron/poseTypes.ts');
const { BUNDLED_POSE_LIBRARY, loadPhotoGuideCatalog } = require('../src/pose/repository.ts');
const libraryOrder = require('../src/pose/poses/library-order.json');
const { PoseRotation } = require('../src/pose/rotation.ts');
const solo = () => structuredClone(BUNDLED_SCENES[0]);
const group = (men, women, boys, girls, style = 'group') => ({ men, women, boys, girls, style });

test('every bundled scene validates as cutout metadata without a rig', () => {
  for (const scene of BUNDLED_SCENES) {
    assert.equal(scene.schemaVersion, 2);
    assert.equal(scene.participants, undefined);
    assert.ok(scene.roles.length >= 1);
    assert.deepEqual(validateScene(JSON.parse(JSON.stringify(scene))), scene);
    assert.equal(captionAt(scene, 999999).elapsedMs, scene.animation.durationMs);
    assert.equal(captionAt(scene, 0).caption, scene.animation.captions[0].text);
  }
});
test('playful library covers every category with four-second teaching and a held final caption', () => {
  const library = BUNDLED_SCENES.filter(scene => scene.tags.includes('playful-library'));
  assert.equal(library.length, 87);
  assert.deepEqual([...new Set(library.map(scene => scene.category))].sort(), ['couple', 'cute', 'family', 'friends', 'funny', 'glamour', 'group', 'kids', 'party', 'professional', 'solo', 'wedding']);
  assert.ok(library.filter(scene => ['funny', 'party', 'friends', 'kids'].includes(scene.category)).length > library.filter(scene => ['professional'].includes(scene.category)).length);
  for (const scene of library) {
    assert.equal(scene.animation.durationMs, 7000);
    assert.deepEqual(scene.animation.captions.map(caption => caption.timeMs), [0, 500, 1000, 1500]);
    assert.equal(scene.animation.captions.some(caption => caption.text === 'Find your mark'), false);
    assert.equal(captionAt(scene, 4000).caption, captionAt(scene, 2000).caption);
  }
});
test('photo guide catalog contains a packaged cutout for every bundled scene', () => {
  assert.equal(PHOTO_GUIDE_SCENES.length, BUNDLED_SCENES.length);
  assert.equal(new Set(PHOTO_GUIDE_SCENES.map(scene => scene.id)).size, BUNDLED_SCENES.length);
  assert.equal(photoAssets.length, BUNDLED_SCENES.length);
  assert.deepEqual(photoAssets.map(asset => asset.id).sort(), BUNDLED_SCENES.map(scene => scene.id).sort());
  for (const scene of PHOTO_GUIDE_SCENES) {
    assert.equal(scene.visual.kind, 'photo-cutout');
    assert.equal(scene.animation.durationMs, 7000);
    assert.equal(scene.visual.assetPath, `pose-guides/${scene.id}.webp`);
    assert.ok(fs.statSync(require('node:path').join(__dirname, '..', 'public', scene.visual.assetPath)).size > 10000);
    assert.doesNotThrow(() => validateScene(structuredClone(scene)));
  }
  assert.ok(PHOTO_GUIDE_SCENES.some(scene => scene.compatibility.styles.includes('family')));
  assert.ok(PHOTO_GUIDE_SCENES.some(scene => scene.compatibility.minPeople >= 5));
  assert.ok(PHOTO_GUIDE_SCENES.some(scene => scene.compatibility.framing.includes('full')));
  assert.ok(PHOTO_GUIDE_SCENES.some(scene => scene.compatibility.framing.includes('half')));
});
test('photo prompt manifest covers every non-pilot library scene exactly once', () => {
  const pilot = new Set(photoPromptManifest.pilotExcluded);
  const source = require('../src/pose/poses/scenes.json');
  const expected = source.filter(scene => !pilot.has(scene.id) && !scene.tags.includes('creative-pack') && !scene.tags.includes('meme-pack-2026')).map(scene => scene.id).sort();
  const actual = photoPromptManifest.jobs.map(job => job.poseId).sort();
  assert.deepEqual(actual, expected);
  for (const job of photoPromptManifest.jobs) {
    assert.equal(job.title, job.title.toUpperCase());
    assert.ok(job.prompt.includes(`\"${job.title}\"`));
    assert.ok(job.prompt.includes(job.instruction));
    assert.ok(job.assetFile.startsWith('pose-guides/'));
  }
});
test('slot orientation handles mixed slots and 90/270-degree rotations', () => {
  assert.equal(slotFraming({ width: 600, height: 900 }), 'full');
  assert.equal(slotFraming({ width: 900, height: 600 }), 'half');
  assert.equal(slotFraming({ width: 600, height: 900, rotation: 90 }), 'half');
  assert.equal(slotFraming({ width: 900, height: 600, rotation: 270 }), 'full');
  assert.deepEqual(slotGeometry({ width: 900, height: 600, rotation: 180 }), { width: 900, height: 600 });
  assert.equal(slotFraming({ width: 600, height: 600 }), 'half');
});
test('guest choices reject zero, negative, fractions, excess and incompatible couple style', () => {
  assert.throws(() => validateComposition(group(0, 0, 0, 0)));
  assert.throws(() => validateComposition(group(-1, 3, 0, 0)));
  assert.throws(() => validateComposition(group(1.5, 1, 0, 0)));
  assert.throws(() => validateComposition(group(5, 5, 0, 0), 4));
  assert.throws(() => validateComposition(group(1, 0, 1, 0, 'couple')));
  assert.deepEqual(validateComposition(group(0, 2, 0, 0, 'couple')), group(0, 2, 0, 0, 'couple'));
});
test('role matching supports same-gender couples, families, children and flexible 4+', () => {
  const couple = BUNDLED_SCENES.find(scene => scene.id === 'couple-heart');
  assert.ok(sceneMatches(couple, group(0, 2, 0, 0, 'couple'), 'half'));
  assert.ok(sceneMatches(couple, group(2, 0, 0, 0, 'couple'), 'full'));
  assert.ok(!sceneMatches(couple, group(1, 1, 0, 0, 'friends'), 'full'));
  assert.ok(!sceneMatches(couple, group(0, 0, 1, 1, 'couple'), 'full'));
  for (const count of [2, 3, 4, 5, 12, 20]) {
    assert.ok(BUNDLED_SCENES.some(scene => sceneMatches(scene, group(count - 1, 0, 1, 0, 'family'), 'half', true)));
  }
});
test('multi-person scenes keep one shared caption clock and separate roles', () => {
  const scene = BUNDLED_SCENES.find(scene => scene.id === 'friends-peace');
  assert.equal(scene.roles.length, 2);
  assert.equal(captionAt(scene, 7000).elapsedMs, 7000);
  assert.equal(captionAt(scene, 7000).caption, scene.animation.captions.at(-1).text);
});
test('teaching captions add, move and delete safely; collisions and duration truncation fail', () => {
  const added = addStep(solo(), 3500); assert.ok(added.animation.captions.some(frame => frame.timeMs === 3500));
  const moved = moveStep(added, 3500, 3700); assert.ok(moved.animation.captions.some(frame => frame.timeMs === 3700));
  assert.ok(!deleteStep(moved, 3700).animation.captions.some(frame => frame.timeMs === 3700));
  assert.throws(() => moveStep(added, 3500, 1500));
  assert.throws(() => resizeScene(solo(), 1000, false));
  const stretched = resizeScene(solo(), 14000, true);
  assert.equal(stretched.animation.captions.at(-1).timeMs, 3000);
  assert.equal(stretched.animation.captions[1].timeMs, 1000);
});
test('narration markers align captions, move together and stay anchored during stretch', () => {
  const pose = solo(); pose.audio = { filePath: 'local.wav', markers: [{ id: 'raise', timeMs: 2500 }] };
  const linked = alignStep(pose, 2200, 'raise');
  const withCaption = addStep(pose, 2200);
  const aligned = alignStep(withCaption, 2200, 'raise');
  assert.equal(aligned.animation.captions.find(frame => frame.markerId === 'raise').timeMs, 2500);
  const moved = moveMarker(aligned, 0, 2800);
  assert.equal(moved.animation.captions.find(frame => frame.markerId === 'raise').timeMs, 2800);
  const stretched = resizeScene(moved, 12000, true);
  assert.equal(stretched.audio.markers[0].timeMs, 2800);
  assert.equal(stretched.animation.captions.find(frame => frame.markerId === 'raise').timeMs, 2800);
  assert.doesNotThrow(() => validateScene(linked));
});
test('validation rejects malformed roles, identities and remote assets', () => {
  let pose = solo(); pose.roles[0].role = 'robot'; assert.throws(() => validateScene(pose));
  pose = solo(); pose.id = '../escape'; assert.throws(() => validateScene(pose));
  pose = solo(); pose.roles = []; assert.throws(() => validateScene(pose));
  pose = solo(); pose.compatibility.childSafe = 'yes'; assert.throws(() => validateScene(pose));
  pose = solo(); pose.audio = { filePath: 'https://remote/audio.wav' }; assert.throws(() => validateScene(pose));
});
test('photo catalog preserves authored compatibility and holds the final caption', () => {
  const pose = (id) => PHOTO_GUIDE_SCENES.find(scene => scene.id === id);
  assert.deepEqual(pose('peace-and-wink').compatibility.framing, ['full', 'half']);
  assert.deepEqual(pose('action-movie-diamond').compatibility.framing, ['full', 'half']);
  assert.deepEqual(pose('secret-and-shock').compatibility.styles, ['friends', 'couple']);
  assert.deepEqual(pose('back-to-back-agents').compatibility.framing, ['full', 'half']);
  assert.equal(pose('family-superhero-team').compatibility.minPeople, 3);
  assert.equal(pose('family-superhero-team').compatibility.maxPeople, null);
  assert.deepEqual(pose('family-superhero-team').compatibility.framing, ['full', 'half']);
  assert.equal(pose('many-armed-idol').compatibility.minPeople, 5);
  for (const scene of PHOTO_GUIDE_SCENES) {
    assert.equal(scene.animation.durationMs, 7000);
    assert.equal(scene.animation.captions.at(-1).timeMs, 1500);
    assert.equal(captionAt(scene, 4000).caption, captionAt(scene, 2000).caption);
  }
});
test('creative pack covers lovers, friends, families, and large groups by framing', () => {
  const pack = BUNDLED_SCENES.filter(scene => scene.tags.includes('creative-pack'));
  const count = (audience, framing) => pack.filter(scene => scene.tags.includes(`audience-${audience}`) && scene.compatibility.framing[0] === framing).length;
  assert.equal(count('lovers', 'full'), 10); assert.equal(count('lovers', 'half'), 10);
  assert.equal(count('women-2', 'full'), 10); assert.equal(count('women-2', 'half'), 10);
  assert.equal(count('women-3', 'full'), 10); assert.equal(count('women-3', 'half'), 10);
  assert.equal(count('women-4', 'full'), 10); assert.equal(count('women-4', 'half'), 10);
  assert.equal(count('men-2', 'full'), 5); assert.equal(count('men-2', 'half'), 5);
  assert.equal(count('men-3', 'full'), 5); assert.equal(count('men-3', 'half'), 5);
  assert.equal(count('family-3', 'full'), 7); assert.equal(count('family-3', 'half'), 7);
  assert.equal(count('family-4', 'full'), 7); assert.equal(count('family-4', 'half'), 7);
  assert.equal(count('group-5', 'full'), 20); assert.equal(count('group-5', 'half'), 20);
  for (const audience of ['family-3', 'family-4']) for (const framing of ['full', 'half']) {
    assert.equal(pack.filter(scene => scene.tags.includes(`audience-${audience}`) && scene.tags.includes('with-kids') && scene.compatibility.framing[0] === framing).length, 4);
  }
  const moods = new Set(pack.map(scene => scene.tags.find(tag => tag.startsWith('mood-'))));
  assert.deepEqual([...moods].sort(), ['mood-challenge', 'mood-cool', 'mood-crazy', 'mood-cute', 'mood-funny', 'mood-sweet']);
  const lovers = pack.filter(scene => scene.id === 'lovers-full-slow-dance')[0];
  assert.equal(sceneMatches(lovers, group(1, 1, 0, 0, 'couple'), 'full'), true);
  assert.equal(sceneMatches(lovers, group(0, 2, 0, 0, 'couple'), 'half'), false);
  const women = pack.find(scene => scene.id === 'women-2-half-cheek-squish');
  assert.equal(sceneMatches(women, group(0, 2, 0, 0, 'friends'), 'half'), true);
  assert.equal(sceneMatches(women, group(2, 0, 0, 0, 'friends'), 'half'), false);
  const kids = pack.find(scene => scene.id === 'family-3-full-parent-swing');
  assert.equal(sceneMatches(kids, group(1, 1, 1, 0, 'family'), 'full'), true);
  assert.equal(sceneMatches(kids, group(2, 1, 0, 0, 'family'), 'full'), false);
  const crowd = pack.find(scene => scene.id === 'group-5-half-cheek-pile');
  assert.equal(sceneMatches(crowd, group(2, 2, 1, 1, 'group'), 'half'), true);
  assert.equal(sceneMatches(crowd, group(2, 2, 0, 0, 'group'), 'half'), false);
});
test('legacy fixed-event settings migrate to pose categories', () => {
  assert.deepEqual(normalizePoseGuide({ enabled: true }), { enabled: true, selectionEnabled: true, defaultCategory: 'friends' });
  assert.equal(normalizePoseGuide({ defaultComposition: group(1, 1, 0, 0, 'couple') }).defaultCategory, 'lovers');
  assert.equal(normalizePoseGuide({ defaultComposition: group(1, 0, 1, 0, 'family') }).defaultCategory, 'family');
  assert.equal(normalizePoseGuide({ defaultComposition: group(1, 0, 0, 0, 'solo') }).defaultCategory, 'friends');
  assert.deepEqual(
    normalizePoseGuide({ selectionEnabled: false, defaultCategory: 'friends', defaultComposition: group(0, 2, 0, 0, 'couple') }),
    { enabled: true, selectionEnabled: false, defaultCategory: 'friends' }
  );
});

const cursorStorage = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};

test('each category rotates through every matching pose in catalog order and wraps', () => {
  const storage = cursorStorage();
  for (const category of POSE_CATEGORIES) {
    const expected = BUNDLED_POSE_LIBRARY.filter(pose => poseCategories(pose).includes(category)).map(pose => pose.id);
    assert.ok(expected.length > 1);
    const seen = expected.map(() => {
      const rotation = new PoseRotation(BUNDLED_POSE_LIBRARY, category, storage);
      const id = rotation.current().id;
      rotation.finish('completed');
      return id;
    });
    assert.equal(new Set(seen).size, seen.length);
    assert.deepEqual(seen, expected);
    assert.equal(new PoseRotation(BUNDLED_POSE_LIBRARY, category, storage).current().id, expected[0]);
  }
});

test('the library order covers every bundled guide and separates similar poses in each rotation', () => {
  const expected = PHOTO_GUIDE_SCENES.filter(pose => poseCategories(pose).length).map(pose => pose.id).sort();
  assert.deepEqual([...libraryOrder].sort(), expected);
  assert.deepEqual(BUNDLED_POSE_LIBRARY.map(pose => pose.id), libraryOrder);
  for (const [category, first, second] of [
    ['friends', 'back-to-back-agents', 'meme-back-to-back-agents'],
    ['friends', 'women-2-half-matching-peace', 'women-3-half-peace-crown'],
    ['family', 'family-3-full-family-jump', 'family-4-full-reunion-jump'],
    ['lovers', 'lovers-full-proposal-gasp', 'lovers-half-proposal-face']
  ]) {
    const order = BUNDLED_POSE_LIBRARY.filter(pose => poseCategories(pose).includes(category)).map(pose => pose.id);
    assert.ok(order.includes(first) && order.includes(second));
    const gap = Math.abs(order.indexOf(first) - order.indexOf(second));
    assert.ok(Math.min(gap, order.length - gap) >= 4, `${first} and ${second} are too close in ${category}`);
  }
});

test('rotation has separate cursors, retries interruptions, and advances past failures', () => {
  const storage = cursorStorage();
  const crossCategory = structuredClone(BUNDLED_POSE_LIBRARY[0]);
  crossCategory.compatibility.styles = ['friends', 'group', 'family', 'couple'];
  crossCategory.compatibility.framing = ['half'];
  const next = { ...crossCategory, id: 'next', compatibility: { ...crossCategory.compatibility, framing: ['full'] } };
  const catalog = [crossCategory, next];
  assert.deepEqual(poseCategories(crossCategory), ['friends', 'family', 'lovers']);

  const friends = new PoseRotation(catalog, 'friends', storage);
  friends.finish('cancelled');
  assert.equal(new PoseRotation(catalog, 'friends', storage).current().id, crossCategory.id);
  friends.finish('failed');
  assert.equal(friends.current().id, next.id);
  assert.equal(new PoseRotation(catalog, 'friends', storage).current().id, next.id);
  assert.equal(new PoseRotation(catalog, 'family', storage).current().id, crossCategory.id);
  assert.equal(new PoseRotation(catalog, 'lovers', storage).current().id, crossCategory.id);

  assert.equal(new PoseRotation([{ ...next, id: 'new-first' }, next], 'friends', storage).current().id, 'new-first');
  const empty = new PoseRotation([], 'friends', storage);
  empty.finish('failed');
  assert.equal(empty.current(), undefined);
});

test('active catalog excludes legacy solo guides and keeps override and custom order', async () => {
  const original = BUNDLED_POSE_LIBRARY[0];
  const deleted = BUNDLED_POSE_LIBRARY[1];
  const legacySolo = PHOTO_GUIDE_SCENES.find(pose => pose.id === 'meme-six-seven');
  const soloOverride = { ...legacySolo, id: 'custom-solo' };
  const mockWindow = global.window;
  global.window = {
    photoBooth: {
      listPoses: async () => ({
        poses: [{ ...original, id: 'custom-z' }, soloOverride, { ...original, name: 'Override' }, { ...original, id: 'custom-a' }],
        deletedPoseIds: [deleted.id],
        errors: []
      })
    }
  };
  try {
    const { poses, errors } = await loadPhotoGuideCatalog();
    assert.deepEqual(errors, []);
    assert.equal(BUNDLED_POSE_LIBRARY.length, 260);
    assert.equal(poses.length, 261);
    assert.equal(poses[0].id, original.id);
    assert.equal(poses[0].name, 'Override');
    assert.deepEqual(poses.slice(-2).map(pose => pose.id), ['custom-a', 'custom-z']);
    assert.ok(legacySolo.compatibility.styles.includes('group'));
    assert.ok(!poses.some(pose => [legacySolo.id, soloOverride.id, 'peace-and-wink', deleted.id].includes(pose.id)));
    assert.ok(poses.every(pose => poseCategories(pose).length));
  } finally {
    if (mockWindow === undefined) delete global.window;
    else global.window = mockWindow;
  }
});
