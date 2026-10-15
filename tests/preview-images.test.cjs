const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText, filename);
};
const { createPreviewImageCache } = require('../src/previewImages.ts');

test('preloading and mounted cards share one read and wait for decoding', async () => {
  let reads = 0;
  let finishDecode;
  const cache = createPreviewImageCache(async () => { reads++; return 'image'; }, () => new Promise(resolve => { finishDecode = resolve; }));
  const preload = cache.load('template.png', 'v1');
  assert.equal(cache.load('template.png', 'v1'), preload);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1);
  assert.equal(cache.peek('template.png', 'v1'), '');
  finishDecode();
  assert.equal(await preload, 'image');
  assert.equal(cache.peek('template.png', 'v1'), 'image');
  assert.equal(await cache.load('template.png', 'v1'), 'image');
  assert.equal(reads, 1);
});

test('editing a preview reloads its image while empty paths do not read files', async () => {
  let reads = 0;
  const cache = createPreviewImageCache(async () => `image-${++reads}`, async () => {});
  assert.equal(await cache.load(''), '');
  assert.equal(reads, 0);
  assert.equal(await cache.load('same-path', 'v1'), 'image-1');
  assert.equal(await cache.load('same-path', 'v2'), 'image-2');
  assert.equal(cache.peek('same-path', 'v2'), 'image-2');
});

test('failed or missing previews can be retried without blocking other images', async () => {
  let fail = true;
  const cache = createPreviewImageCache(async path => path === 'missing' ? '' : 'image', async () => { if (fail) throw Error('decode failed'); });
  assert.equal(await cache.load('missing'), '');
  assert.equal(await cache.load('preview'), '');
  fail = false;
  assert.equal(await cache.load('preview'), 'image');
});

test('the cache bounds retained previews', async () => {
  const cache = createPreviewImageCache(async path => path, async () => {}, 2);
  await cache.load('one');
  await cache.load('two');
  await cache.load('three');
  assert.equal(cache.peek('one'), '');
  assert.equal(cache.peek('three'), 'three');
});
