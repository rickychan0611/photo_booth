const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { PNG } = require('pngjs');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText, filename);
const templates = require('../src/template.ts');
const maps = require('../src/templateMap.ts');
const { duplicateStripBitmap, printerForPaperSize } = require('../electron/stripPrinting.ts');

// Load actual main-process functions without starting the kiosk or touching its settings.
const main = ts.createSourceFile('main.ts', fs.readFileSync(path.join(__dirname, '../electron/main.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
function mainFunctions(names, context) {
  const nodes = main.statements.filter(node =>
    ts.isFunctionDeclaration(node) && names.includes(node.name?.text) ||
    ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => names.includes(declaration.name.getText(main))));
  const source = nodes.map(node => node.getText(main)).join('\n');
  assert.equal(nodes.length, names.length);
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return vm.runInNewContext(`${js}\n({${names.join(',')}})`, context);
}

test('vertical maps keep 2x6 proportions and scale slot coordinates', () => {
  assert.equal(maps.paperSizeForMap(600, 1800), '2x6');
  assert.equal(maps.paperSizeForMap(1200, 3600), '2x6');
  assert.equal(maps.paperSizeForMap(1800, 600), '4x6');
  assert.equal(maps.paperSizeForMap(1200, 1800), '4x6');
  const data = new Uint8ClampedArray(200 * 600 * 4).fill(255);
  for (let y = 30; y < 180; y++) for (let x = 20; x < 180; x++) {
    const offset = (y * 200 + x) * 4;
    data[offset] = data[offset + 1] = data[offset + 2] = 0;
  }
  const slots = maps.detectPhotoSlots({ width: 200, height: 600, data });
  const strip = templates.normalizeTemplateLayoutForClient(maps.layoutFromDetectedSlots('Strip', 200, 600, slots));
  assert.equal(strip.paperSize, '2x6');
  assert.equal(strip.paperWidth, 600);
  assert.equal(strip.paperHeight, 1800);
  assert.equal(strip.photosToTake, 1);
  assert.deepEqual(strip.photoWindows[0], { x: 60, y: 90, width: 480, height: 450, sourceIndex: 0, rotation: 0, cropY: 'center' });
  assert.equal(templates.normalizeTemplateLayoutForClient({ ...strip, orientation: 'landscape' }).orientation, 'portrait');
  const legacy = templates.normalizeTemplateLayoutForClient(templates.createBlankTemplateLayout('Legacy', 'landscape'));
  assert.equal(legacy.paperSize, '4x6');
  assert.equal(legacy.paperWidth, 1800);
  assert.equal(legacy.paperHeight, 1200);
});

test('strip composition and reduced previews use the single strip canvas', async () => {
  const canvases = [];
  const oldDocument = global.document, oldImage = global.Image;
  global.Image = class { set src(value) { this.onload(); } };
  global.document = { createElement: () => {
    const canvas = { width: 0, height: 0, getContext: () => ({ clearRect() {}, drawImage() {}, fillRect() {} }), toDataURL: () => `${canvas.width}x${canvas.height}` };
    canvases.push(canvas); return canvas;
  }};
  try {
    const layout = { ...templates.createBlankTemplateLayout(), paperSize: '2x6', photoWindows: [] };
    assert.equal(await templates.createTemplatedPhotoLayer([], layout), '600x1800');
    assert.equal(await templates.createTemplatedPrintImageFromLayer('photo', layout), '600x1800');
    assert.equal(await templates.createTemplatedPhotoLayer([], layout, { maxLongEdge: 900 }), '300x900');
  } finally { global.document = oldDocument; global.Image = oldImage; }
});

test('each print-sheet row contains two exact copies without a gap', () => {
  const source = Buffer.from(Array.from({ length: 5 * 7 * 4 }, (_, i) => i % 256));
  const sheet = duplicateStripBitmap(source, 5, 7);
  for (let y = 0; y < 7; y++) {
    const row = source.subarray(y * 20, (y + 1) * 20);
    assert.deepEqual(sheet.subarray(y * 40, y * 40 + 20), row);
    assert.deepEqual(sheet.subarray(y * 40 + 20, (y + 1) * 40), row);
  }
  assert.throws(() => duplicateStripBitmap(Buffer.alloc(1), 5, 7), /Invalid/);
});

test('size routing ignores legacy template printer choices and supports machine settings', () => {
  assert.equal(printerForPaperSize({}, '2x6'), 'DS-RX1-HalfCut');
  assert.equal(printerForPaperSize({}), 'DS-RX1');
  assert.equal(printerForPaperSize({ sizePrinters: { '2x6': 'Other half-cut queue' } }, '2x6'), 'Other half-cut queue');
});

function nativeImageStub() {
  const wrap = png => ({
    getSize: () => ({ width: png.width, height: png.height }),
    toBitmap: () => png.data,
    toPNG: () => PNG.sync.write(png),
    toJPEG: () => PNG.sync.write(png)
  });
  return { createFromBuffer: buffer => wrap(PNG.sync.read(buffer)), createFromBitmap: (buffer, size) => wrap({ ...size, data: buffer }) };
}

test('saving, restart gallery listing, upload selection, legacy fallback and missing strips', async () => {
  const folder = await fsp.mkdtemp(path.join(os.tmpdir(), 'booth-strip-'));
  const uploads = [];
  let sequence = 0;
  const settings = { eventFolder: folder, webApiBaseUrl: 'https://example.test', eventId: 'event', boothSecret: 'test', template: { layouts: [{ id: 'strip', paperSize: '2x6' }] }, sizePrinters: { '4x6': 'DS-RX1', '2x6': 'DS-RX1-HalfCut' } };
  const context = { Buffer, path, os, fs: fsp, console, nativeImage: nativeImageStub(), duplicateStripBitmap, printerForPaperSize,
    readSettings: async () => settings,
    ensureEventFolders: async () => { for (const dir of ['originals', 'finals']) await fsp.mkdir(path.join(folder, dir), { recursive: true }); },
    photoName: async (_, extension) => `${++sequence}${extension}`,
    imageExtensionFromDataUrl: () => '.png', dataUrlToBuffer: url => Buffer.from(url.split(',')[1], 'base64'),
    writeThumbnail: async () => {}, lastFinalPath: '', normalizePrinterName: value => value,
    fileExists: async file => !!await fsp.stat(file).catch(() => false),
    galleryUploadStatus: { active: 0 }, setGalleryUploadStatus() {},
    compressedJpegFromFile: file => { const png = PNG.sync.read(fs.readFileSync(file)); return { width: png.width, height: png.height }; },
    uploadGalleryBuffer: async (_, __, upload) => uploads.push(upload),
    completeBackgroundBoothSession: async () => {}, publicWebUrl: (_, url) => url,
  };
  const names = ['saveImageData', 'writePhotoMetadata', 'readFinalMetadata', 'updatePhotoMetadata', 'uploadFinalPhotoInBackground', 'listGallery', 'deletePhotoFile'];
  try {
    const api = mainFunctions(names, context);
    const png = new PNG({ width: 600, height: 1800 });
    for (let i = 0; i < png.data.length; i++) png.data[i] = i % 251;
    const original = PNG.sync.write(png);
    const saved = await api.saveImageData({ kind: 'final', dataUrl: `data:image/png;base64,${original.toString('base64')}`, templateId: 'strip', printerName: 'wrong legacy queue' });
    const sheet = PNG.sync.read(await fsp.readFile(saved.path));
    assert.equal(sheet.width, 1200); assert.equal(sheet.height, 1800);
    assert.deepEqual(PNG.sync.read(await fsp.readFile(saved.uploadPath)).data, png.data);
    for (let y = 0; y < 1800; y++) {
      const row = png.data.subarray(y * 2400, (y + 1) * 2400);
      assert.deepEqual(sheet.data.subarray(y * 4800, y * 4800 + 2400), row);
      assert.deepEqual(sheet.data.subarray(y * 4800 + 2400, (y + 1) * 4800), row);
    }
    // Simulate a fresh process after the template has been deleted.
    settings.template.layouts = [];
    const restarted = mainFunctions(names, context);
    const gallery = await restarted.listGallery();
    assert.equal(gallery.finals.length, 1);
    assert.equal(gallery.finals[0].path, saved.path);
    assert.equal(gallery.finals[0].printerName, 'DS-RX1-HalfCut');
    assert.equal(gallery.finals[0].uploadPath, saved.uploadPath);
    assert.equal((await restarted.uploadFinalPhotoInBackground({ finalPath: saved.path, ticketId: 'ticket', galleryUrl: '/gallery' })).ok, true);
    assert.deepEqual(uploads.map(item => [item.kind, item.width, item.height]), [['layout', 600, 1800], ['thumbnail', 600, 1800]]);
    const metadata = await restarted.readFinalMetadata(saved.path);
    assert.equal(metadata.galleryUrl, '/gallery');
    assert.equal(metadata.paperSize, '2x6');
    uploads.length = 0;
    const legacyPath = path.join(folder, 'finals', 'legacy.png');
    await fsp.writeFile(legacyPath, PNG.sync.write(sheet));
    assert.equal((await restarted.uploadFinalPhotoInBackground({ finalPath: legacyPath, ticketId: 'ticket', galleryUrl: '/old' })).ok, true);
    assert.equal(uploads[0].width, 1200);
    const companion = await fsp.readFile(saved.uploadPath);
    await fsp.rm(saved.uploadPath);
    assert.equal((await restarted.uploadFinalPhotoInBackground({ finalPath: saved.path, ticketId: 'ticket', galleryUrl: '/gallery' })).ok, false);
    await fsp.writeFile(saved.uploadPath, companion);
    await restarted.deletePhotoFile(saved.path);
    assert.equal(fs.existsSync(saved.path), false);
    assert.equal(fs.existsSync(saved.uploadPath), false);
    assert.equal(fs.existsSync(saved.path.replace('.png', '.json')), false);
    await assert.rejects(restarted.saveImageData({ kind: 'final', paperSize: '2x6', dataUrl: `data:image/png;base64,${PNG.sync.write(sheet).toString('base64')}` }), /600 × 1800/);
  } finally { await fsp.rm(folder, { recursive: true, force: true }); }
});

test('silent printer resolution cannot fall back to the regular queue', async () => {
  const context = { normalizePrinterName: x => x === 'DS-RX1-HaflCut' ? 'DS-RX1-HalfCut' : x, normalizePrinterKey: x => x.toLowerCase(), listPrintersForPrint: async () => [{ name: 'DS-RX1' }] };
  const api = mainFunctions(['resolvePrinterName'], context);
  assert.equal(await api.resolvePrinterName('DS-RX1-HalfCut', 'DS-RX1'), '');
  assert.equal(await api.resolvePrinterName('DS-RX1'), 'DS-RX1');
  context.listPrintersForPrint = async () => [{ name: 'DS-RX1-HalfCut' }];
  assert.equal(await api.resolvePrinterName('DS-RX1-HaflCut'), 'DS-RX1-HalfCut');
  context.listPrintersForPrint = async () => [];
  assert.equal(await api.resolvePrinterName('DS-RX1-HalfCut'), '');
});

test('strip design validation rejects 4x6 backgrounds', async () => {
  const context = { templateDimensions: templates.templateDimensions, getImageSize: async () => ({ width: 1200, height: 1800 }), requiredDesignSize: layout => templates.templateDimensions(layout.orientation, layout.paperSize) };
  const api = mainFunctions(['assertDesignImageSize', 'requiredDesignSize'], context);
  await assert.rejects(api.assertDesignImageSize('frame.png', { orientation: 'portrait', paperSize: '2x6' }), /600 × 1800/);
  context.getImageSize = async () => ({ width: 600, height: 1800 });
  await api.assertDesignImageSize('strip.png', { orientation: 'portrait', paperSize: '2x6' });
});


test('saved printer survives template changes, and silent jobs use one calibrated sheet', async () => {
  let printed, html, closed = false;
  const settings = { printerEnabled: true, sizePrinters: { '2x6': 'new queue', '4x6': 'DS-RX1' } };
  const context = {
    readSettings: async () => settings,
    readFinalMetadata: async () => ({ paperSize: '2x6', printerName: 'DS-RX1-HalfCut' }),
    resolvePrinterName: async name => name === 'DS-RX1-HalfCut' ? name : '',
    nativeImage: { createFromPath: () => ({ getSize: () => ({ width: 1200, height: 1800 }) }) },
    app: { getPath: () => os.tmpdir() }, path, pathToFileURL: require('node:url').pathToFileURL,
    fs: { writeFile: async (_, data) => { html = data; }, rm: async () => {} },
    PRINT_PREVIEW_WIDTH: 1200, PRINT_PREVIEW_HEIGHT: 1800,
    setTimeout: callback => { queueMicrotask(callback); return 1; }, clearTimeout() {},
    BrowserWindow: class {
      webContents = { on() {}, print: (options, callback) => { printed = options; callback(true); } };
      async loadFile() {} setAlwaysOnTop() {} close() { closed = true; }
    }
  };
  const api = mainFunctions(['printImage'], context);
  assert.equal((await api.printImage('sheet.png', 'wrong fallback', true)).ok, true);
  assert.equal(printed.deviceName, 'DS-RX1-HalfCut');
  assert.equal(printed.silent, true);
  assert.equal(printed.scaleFactor, 100);
  assert.equal(printed.landscape, false);
  assert.equal(printed.pageSize.width, 104902);
  assert.equal(printed.pageSize.height, 156210);
  assert.match(html, /size: 4in 6in/);
  assert.equal(closed, true);
  printed = undefined;
  context.resolvePrinterName = async () => '';
  const failed = await api.printImage('sheet.png', undefined, true);
  assert.equal(failed.ok, false);
  assert.match(failed.error, /Printer not found: DS-RX1-HalfCut/);
  assert.equal(printed, undefined);
});


test('Electron normalization keeps strip dimensions through settings reloads', () => {
  const api = mainFunctions(['normalizeTemplateLayout'], {
    templateDimensions: templates.templateDimensions,
    finiteNumber: (value, fallback) => Number.isFinite(value) ? value : fallback,
    normalizeRotation: value => value || 0,
    normalizeTemplateWorkflow: workflow => workflow,
    normalizePrinterName: name => name
  });
  const strip = maps.layoutFromDetectedSlots('Strip', 600, 1800, [{ x: 20, y: 30, width: 560, height: 400, sourceIndex: 0 }]);
  const normalized = api.normalizeTemplateLayout({ ...strip, orientation: 'landscape' });
  assert.equal(normalized.orientation, 'portrait');
  assert.equal(normalized.paperSize, '2x6');
  assert.equal(normalized.paperWidth, 600);
  assert.equal(normalized.photoWindows[0].width, 560);
});

test('AI jobs keep strip size, normalize the provider image, save paired output, and report print failures', async () => {
  let item, resize, saveRequest, printRequest;
  const settings = { eventFolder: '/test', ai: { provider: 'openai' }, printerEnabled: true, silentPrint: true,
    sizePrinters: { '4x6': 'DS-RX1', '2x6': 'DS-RX1-HalfCut' }, template: { layouts: [{ id: 'strip', paperSize: '2x6' }], aiPresets: [{ id: 'preset' }] } };
  const context = {
    path, fs: { writeFile: async () => {} }, printerForPaperSize,
    readSettings: async () => settings, ensureEventFolders: async () => {},
    dataUrlToBuffer: () => Buffer.from('image'), updateAiQueueItem: async value => { item = value; }, readAiQueue: async () => [item],
    normalizeAiPreset: value => value, requestAiImage: async () => 'provider-image',
    nativeImage: { createFromDataURL: () => ({ isEmpty: () => false, resize: options => { resize = options; return { toDataURL: () => 'normalized-strip' }; } }) },
    saveImageData: async request => { saveRequest = request; return { path: '/finals/1.png', uploadPath: '/finals/uploads/1.png', name: '1.png' }; },
    printImage: async (...args) => { printRequest = args; return { ok: false, error: 'Printer not found: DS-RX1-HalfCut' }; },
  };
  const api = mainFunctions(['createAiQueueItem', 'processAiQueueItem', 'printAiQueueItem'], context);
  await api.createAiQueueItem({ templateId: 'strip', designId: 'design', presetId: 'preset', dataUrl: 'input' });
  assert.equal(item.paperSize, '2x6'); assert.equal(item.printerName, 'DS-RX1-HalfCut');
  settings.template.layouts = [];
  const result = await api.processAiQueueItem(item.id);
  assert.equal(resize.width, 600); assert.equal(resize.height, 1800);
  assert.equal(saveRequest.paperSize, '2x6'); assert.equal(saveRequest.dataUrl, 'normalized-strip');
  assert.equal(result.saved.uploadPath, '/finals/uploads/1.png');
  assert.equal(result.item.status, 'print_failed'); assert.equal(result.fallback, false);
  assert.equal(result.dataUrl, 'normalized-strip');
  assert.deepEqual(printRequest, ['/finals/1.png', 'DS-RX1-HalfCut', true]);
  await api.printAiQueueItem(item.id);
  assert.equal(printRequest[0], '/finals/1.png');
  // A raw result without a final must be saved as a sheet before reprinting.
  item.finalPath = ''; item.resultPath = '/raw/1.png';
  context.imageFileToDataUrl = async () => 'normalized-strip';
  await api.printAiQueueItem(item.id);
  assert.equal(saveRequest.paperSize, '2x6');
  assert.equal(printRequest[0], '/finals/1.png');
});
