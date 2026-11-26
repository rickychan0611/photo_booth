// Run after: vite build --outDir .cache/strip-preview
// Usage: electron tests/strip-electron-smoke.cjs
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = require('typescript');
const { PNG } = require('pngjs');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText, filename);
const { duplicateStripBitmap } = require('../electron/stripPrinting.ts');
const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, '.cache', 'strip-qa');
fs.mkdirSync(artifacts, { recursive: true });
app.setPath('userData', path.join(artifacts, 'electron-user-data'));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 1100, show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
  const failures = [];
  win.webContents.on('console-message', event => { if (event.level === 'error' && !/Content Security Policy|file:|ERR_FILE_NOT_FOUND/.test(event.message)) failures.push(event.message); });
  await win.loadFile(path.join(root, '.cache/strip-preview/index.html'), { query: { window: 'admin' } });
  async function poll(code) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await win.webContents.executeJavaScript(code)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error(`UI did not reach expected state: ${code}`);
  }
  async function screenshot(name) {
    await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await new Promise(resolve => setTimeout(resolve, 150));
    await fs.promises.writeFile(path.join(artifacts, name), (await win.webContents.capturePage()).toPNG());
  }
  async function click(label) {
    await win.webContents.executeJavaScript(`(() => { const button = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(label)}); if (!button) throw Error('Missing button: '+${JSON.stringify(label)}); button.click(); })()`);
  }
  await poll('!!window.photoBooth && !!document.querySelector(".admin-sidebar")');
  await win.webContents.executeJavaScript(`(async () => {
    const settings = await window.photoBooth.getSettings();
    await window.photoBooth.updateSettings({ template: { ...settings.template, layouts: [], designs: [] }, printerEnabled: false });
  })()`);
  await win.reload();
  await poll('!!document.querySelector(".admin-sidebar")');
  await click('Template');
  await poll('!!document.querySelector("input[type=file][accept*=png]")');
  await win.webContents.executeJavaScript(`(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 1800;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0,0,600,1800);
    ctx.fillStyle = '#000'; [80,590,1100].forEach(y => ctx.fillRect(40,y,520,400));
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const transfer = new DataTransfer(); transfer.items.add(new File([blob], 'Strip QA.png', { type: 'image/png' }));
    const input = document.querySelector('input[type=file][accept*=png]'); input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await poll('document.body.textContent.includes("Background designs must be 600 × 1800")');
  const layout = await win.webContents.executeJavaScript('(async () => (await window.photoBooth.getSettings()).template.layouts[0])()');
  assert.equal(layout.paperSize, '2x6'); assert.equal(layout.paperWidth, 600); assert.equal(layout.photoWindows.length, 3);
  await click('Edit layout');
  await poll('!!document.querySelector(".template-paper.strip")');
  const editor = await win.webContents.executeJavaScript(`(() => { const paper = document.querySelector('.template-paper'); const box = paper.getBoundingClientRect(); return { ratio: box.width / box.height, rotateDisabled: [...document.querySelectorAll('button')].find(b => b.textContent.includes('Rotate paper')).disabled }; })()`);
  assert.ok(Math.abs(editor.ratio - 1 / 3) < .005); assert.equal(editor.rotateDisabled, true);
  await screenshot('strip-editor.png');
  await click('Cancel');
  await click('Printer');
  await poll('document.body.textContent.includes("Automatic template printers")');
  const queues = await win.webContents.executeJavaScript(`(async () => (await window.photoBooth.getSettings()).sizePrinters)()`);
  assert.equal(queues['4x6'], 'DS-RX1'); assert.equal(queues['2x6'], 'DS-RX1-HalfCut');
  await screenshot('printer-routing.png');
  const dataUrl = await win.webContents.executeJavaScript(`(() => {
    const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 1800;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#f8f5ec'; ctx.fillRect(0,0,600,1800);
    ctx.fillStyle = '#162f3d'; [80,590,1100].forEach((y,i) => {ctx.fillRect(40,y,520,400); ctx.fillStyle = '#fff'; ctx.font = '60px sans-serif'; ctx.fillText('PHOTO '+(i+1),140,y+220); ctx.fillStyle = '#162f3d';});
    ctx.fillStyle = '#162f3d'; ctx.font = '40px sans-serif'; ctx.fillText('STRIP QA',200,1680); return canvas.toDataURL('image/png');
  })()`);
  const strip = nativeImage.createFromDataURL(dataUrl);
  const sheet = nativeImage.createFromBitmap(duplicateStripBitmap(strip.toBitmap(), 600, 1800), { width: 1200, height: 1800 });
  const decoded = PNG.sync.read(sheet.toPNG()), single = PNG.sync.read(strip.toPNG());
  for (let y = 0; y < 1800; y++) {
    const row = single.data.subarray(y * 2400, (y+1)*2400);
    assert.deepEqual(decoded.data.subarray(y*4800,y*4800+2400),row);
    assert.deepEqual(decoded.data.subarray(y*4800+2400,(y+1)*4800),row);
  }
  fs.writeFileSync(path.join(artifacts, 'single-strip.png'), strip.toPNG());
  fs.writeFileSync(path.join(artifacts, 'print-sheet.png'), sheet.toPNG());
  const saved = await win.webContents.executeJavaScript(`window.photoBooth.saveImage({ kind: 'final', templateId: ${JSON.stringify(layout.id)}, dataUrl: ${JSON.stringify(dataUrl)} })`);
  assert.ok(saved.uploadPath);
  const sizes = await win.webContents.executeJavaScript(`(async () => {
    const getSize = async path => { const image = new Image(); image.src = await window.photoBooth.getImageDataUrl(path); await image.decode(); return [image.naturalWidth,image.naturalHeight]; };
    return [await getSize(${JSON.stringify(saved.path)}), await getSize(${JSON.stringify(saved.uploadPath)})];
  })()`);
  assert.deepEqual(sizes, [[1200,1800],[600,1800]]);
  await click('Gallery');
  await poll('document.querySelectorAll(".gallery-card").length === 1');
  await poll('document.querySelector(".gallery-card img")?.naturalWidth === 1200');
  await screenshot('gallery-sheet.png');
  assert.deepEqual(failures, []);
  console.log('PASS: actual 2x6 map import, editor dimensions, printer settings, native image duplication, saved pair and gallery sheet. Screenshots: .cache/strip-qa');
  win.destroy(); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
