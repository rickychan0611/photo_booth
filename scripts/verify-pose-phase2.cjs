// Isolated Electron verification: fake camera, private settings/photos, no printing.
const { _electron } = require(process.env.POSE_PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, '.cache', 'pose-phase2');
const profile = path.join(artifacts, `profile-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });
const framePath = path.join(profile, 'frame.png');
fs.writeFileSync(framePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'));
const layout = { id: 'test', name: 'Mixed slots', orientation: 'portrait', paperWidth: 1200, paperHeight: 1800, photoWindows: [{ x: 100, y: 30, width: 600, height: 900, sourceIndex: 0 }, { x: 100, y: 1000, width: 900, height: 600, sourceIndex: 1 }], photosToTake: 2, active: true, guestPreviewPath: '', printerName: '', createdAt: '', updatedAt: '' };
const poseAiPlan = { name: 'AI peace lean', category: 'cute', tags: ['solo', 'peace'], instruction: 'Lean left, lift a peace sign, smile and wink.', introCaption: 'Start standing', durationMs: 7000, compatibility: { minPeople: 1, maxPeople: 1, styles: ['solo'], framing: ['full', 'half'], childSafe: true }, roles: [{ role: 'any', repeatable: false }], captions: [{ progress: .5, text: 'Lift your right hand' }, { progress: 1, text: 'Lean, smile and wink' }] };
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ eventFolder: path.join(profile, 'event'), webApiBaseUrl: '', printerEnabled: false, canonEnabled: false, mirrorPreview: true, cameraRotation: 0, poseGuide: { enabled: true }, audio: { enabled: false }, template: { styleVersion: 3, layouts: [layout], designs: [{ id: 'test-design', templateId: 'test', name: 'Mixed slots', active: true, previewPath: framePath, framePath, usesAi: false, videoRecordingEnabled: false }] }, workflow: { introMs: 0, printAutoSelectMs: 120000, shots: Array.from({ length: 12 }, () => ({ message: 'Legacy', messageMs: 20, cameraBeforeMessageMs: 0, cameraBeforeCountdownMs: 20 })) } }));
const launcher = path.join(profile, 'launcher.cjs');
fs.writeFileSync(launcher, `const {app}=require('electron');app.setPath('userData',${JSON.stringify(profile)});require(${JSON.stringify(path.join(root, 'dist-electron/main.js'))});`);
const env = { ...process.env, VITE_DEV_SERVER_URL: '' }; delete env.ELECTRON_RUN_AS_NODE;
const results = [], errors = [];
let trace = [];
const passed = (name, details = {}) => { results.push({ test: name, result: 'pass', ...details }); console.log(name); };
async function regressions(app, admin, guest) {
  const count = async () => (await admin.evaluate(() => window.photoBooth.listGallery())).originals.length;
  const configure = async (canon = false, recording = false, shots = 1) => {
    await admin.evaluate(async ({canon, recording, shots}) => { const settings = await window.photoBooth.getSettings(); await window.photoBooth.updateSettings({ canonEnabled: canon, poseGuide: { enabled: true, selectionEnabled: false, defaultComposition: { men: 1, women: 1, boys: 1, girls: 2, style: 'family' } }, template: { ...settings.template, layouts: settings.template.layouts.map(layout => ({ ...layout, photoWindows: layout.photoWindows.slice(0,1), photosToTake: shots })), designs: settings.template.designs.map(design => ({ ...design, videoRecordingEnabled: recording })) } }); }, {canon, recording, shots});
    await guest.reload(); await guest.waitForSelector('.welcome-start-button');
  };
  await configure();
  await app.evaluate(({ipcMain, BrowserWindow}) => {
    global.fallbackChecks = []; ipcMain.removeHandler('window:capture-page');
    ipcMain.handle('window:capture-page', async (event, rect) => {
      const status = await event.sender.executeJavaScript(`({hidden: getComputedStyle(document.querySelector('.pose-guide')).visibility === 'hidden', countdown: !!document.querySelector('.countdown')})`);
      global.fallbackChecks.push(status); return (await BrowserWindow.fromWebContents(event.sender).webContents.capturePage(rect)).toDataURL();
    });
  });
  await guest.locator('.welcome-start-button').click(); await guest.waitForSelector('.pose-guide[data-pose-id]');
  await guest.evaluate(() => Object.defineProperty(document.querySelector('.capture-screen video'), 'videoWidth', {get: () => 0, configurable: true}));
  await guest.waitForSelector('.thanks-screen', {timeout: 18000});
  assert.equal(await count(), 1); assert.deepEqual(await app.evaluate(() => global.fallbackChecks), [{hidden:true, countdown:false}]);
  passed('Five-person fixed event skips questions; screenshot fallback excludes guide and countdown');

  await configure(); await guest.locator('.welcome-start-button').click(); await guest.waitForSelector('.pose-guide[data-pose-id]');
  await guest.locator('.guest-back-button').click(); await guest.waitForSelector('.welcome-start-button'); await guest.waitForTimeout(500);
  assert.equal(await count(), 1); passed('Cancel group demonstration prevents capture');
  await guest.locator('.welcome-start-button').click(); await guest.waitForFunction(() => document.querySelector('.countdown')?.textContent === '1', {timeout: 15000});
  await guest.locator('.guest-back-button').click(); await guest.waitForSelector('.welcome-start-button'); await guest.waitForTimeout(1100);
  assert.equal(await count(), 1); passed('Cancel final countdown prevents capture');

  await configure(true);
  const still = await guest.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width=600;canvas.height=900;return canvas.toDataURL(); });
  await app.evaluate(({ipcMain}, dataUrl) => {
    global.pendingStill = null; global.stillChecks=[]; ipcMain.removeHandler('canon:capture');
    ipcMain.handle('canon:capture', async event => { global.stillChecks.push(await event.sender.executeJavaScript(`({hidden: getComputedStyle(document.querySelector('.pose-guide')).visibility === 'hidden', playing: !document.querySelector('.capture-screen video').paused})`)); return new Promise(resolve => global.pendingStill=()=>resolve({dataUrl,width:600,height:900})); });
  }, still);
  await guest.locator('.welcome-start-button').click();
  for (let retry=0;retry<150;retry++) { if (await app.evaluate(() => !!global.pendingStill)) break; await guest.waitForTimeout(100); }
  assert.equal(await app.evaluate(() => !!global.pendingStill), true);
  await guest.locator('.guest-back-button').click(); await guest.waitForSelector('.welcome-start-button'); await app.evaluate(() => global.pendingStill()); await guest.waitForTimeout(500);
  assert.equal(await count(), 1); assert.deepEqual(await app.evaluate(() => global.stillChecks), [{hidden:true, playing:true}]);
  passed('Cancel pending simulated USB still discards stale result; preview stays separate');

  await configure(false,true,2);
  await app.evaluate(({ipcMain}) => { global.recorded=0;ipcMain.removeHandler('video:save-and-transcode');ipcMain.handle('video:save-and-transcode', async (_event, request)=>{global.recorded=request.data.byteLength;return {path:'',name:''};}); });
  await guest.evaluate(() => { window.recordingStarts=0; navigator.mediaDevices.getDisplayMedia=async()=>{window.recordingStarts++;return navigator.mediaDevices.getUserMedia({video:true,audio:false});}; });
  await guest.locator('.welcome-start-button').click(); await guest.waitForSelector('.select-screen', {timeout: 35000});
  assert.equal(await count(), 3); assert.equal(await guest.evaluate(() => window.recordingStarts),1);
  for(let retry=0;retry<30;retry++){if(await app.evaluate(()=>global.recorded>0))break;await guest.waitForTimeout(100);}
  assert.ok(await app.evaluate(()=>global.recorded>0));
  passed('Five-person multi-shot session and MediaRecorder lifecycle operate together');
}
async function main() {
  const app = await _electron.launch({ executablePath: require('electron'), args: [launcher, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'], env });
  try {
    const admin = await app.firstWindow(); admin.on('pageerror', error => errors.push(error.message));
    await admin.waitForSelector('.admin-sidebar');
    const open = app.waitForEvent('window'); await admin.evaluate(() => window.photoBooth.openGuest()); const guest = await open;
    guest.on('pageerror', error => errors.push(error.message));
    await guest.route(/^https?:\/\//, route => route.abort());
    await app.evaluate(({BrowserWindow}) => { for (const win of BrowserWindow.getAllWindows()) { if (win.webContents.getURL().includes('window=guest')) win.setContentSize(540, 960); else win.setContentSize(1440, 1000); } });
    if (process.env.POSE_REGRESSIONS_ONLY) {
      await regressions(app, admin, guest); assert.deepEqual(errors, []);
      fs.writeFileSync(path.join(artifacts,'verification-regressions.json'),JSON.stringify({results,errors,profile},null,2));
      return;
    }
    if (!process.env.POSE_EDITOR_ONLY) {
    await guest.waitForSelector('.welcome-start-button'); await guest.locator('.welcome-start-button').click();
    await guest.waitForSelector('.guest-composition-screen');
    assert.equal(await guest.locator('.people-continue').isDisabled(), true);
    await guest.getByRole('button', { name: 'Add one woman', exact: true }).click();
    await guest.getByRole('button', { name: 'Add one boy', exact: true }).click();
    await guest.getByRole('button', { name: 'Family', exact: true }).click();
    assert.equal(await guest.getByRole('button', { name: 'Couple', exact: true }).count(), 0);
    const screen = await guest.evaluate(() => {
      const upper = document.querySelector('.guest-composition-upper').getBoundingClientRect();
      const buttons = [...document.querySelectorAll('.guest-composition-upper button')].map(button => button.getBoundingClientRect().bottom);
      return { upperBottom: upper.bottom, lastButtonBottom: Math.max(...buttons), half: innerHeight / 2, total: document.querySelector('.people-total').textContent };
    });
    assert.ok(screen.lastButtonBottom <= screen.half, JSON.stringify(screen));
    assert.equal(screen.total, '2 people ready');
    await guest.screenshot({ path: path.join(artifacts, 'people-screen.png') });
    passed('Guest counters/styles fit entirely in upper half; children exclude Couple', screen);
    await guest.locator('.guest-back-button').click(); await guest.waitForSelector('.welcome-start-button');
    await guest.locator('.welcome-start-button').click(); await guest.waitForSelector('.guest-composition-screen');
    assert.equal(await guest.locator('.people-total').textContent(), '2 people ready');
    passed('Back retains guest draft without starting photography');

    // Trace the real countdown and capture loop with unmodified clocks.
    await guest.evaluate(() => {
      window.phase2Trace = []; window.phase2Last = ''; window.phase2Frames = []; let last = 0;
      const observer = new MutationObserver(() => {
        const guide = document.querySelector('.pose-guide'); if (!guide) return;
        const item = { photo: document.querySelector('.pose-guide-progress')?.textContent, pose: guide.dataset.poseId, framing: guide.dataset.framing, countdown: document.querySelector('.countdown')?.textContent, hidden: guide.classList.contains('pose-guide--hidden') || guide.hasAttribute('data-hidden'), ms: performance.now() };
        const key = JSON.stringify({ ...item, ms: 0 }); if (key !== window.phase2Last) { window.phase2Last = key; window.phase2Trace.push(item); }
      }); observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
      requestAnimationFrame(function tick(now) { if (document.querySelector('.capture-screen')) { if (last) window.phase2Frames.push(now - last); last = now; } else last = 0; requestAnimationFrame(tick); });
    });
    await guest.locator('.people-continue').click();
    await guest.waitForFunction(() => document.querySelector('.pose-guide')?.dataset.framing === 'full');
    await guest.waitForTimeout(3200); await guest.screenshot({ path: path.join(artifacts, 'group-full.png') });
    await guest.waitForFunction(() => document.querySelector('.pose-guide')?.dataset.framing === 'half', { timeout: 18000 });
    await guest.waitForTimeout(3000); await guest.screenshot({ path: path.join(artifacts, 'group-half.png') });
    await guest.waitForSelector('.thanks-screen', { timeout: 22000 });
    trace = await guest.evaluate(() => window.phase2Trace);
    for (const [number, framing] of [[1, 'full'], [2, 'half']]) {
      const events = trace.filter(item => item.photo === `Photo ${number} of 2` && item.framing === framing);
      assert.ok(events.some(item => !item.countdown && !item.hidden));
      assert.deepEqual([...new Set(events.map(item => item.countdown).filter(Boolean))], ['3', '2', '1']);
      assert.ok(events.find(item => item.countdown === '1').hidden);
    }
    const first = trace.find(item => item.photo === 'Photo 1 of 2' && item.pose)?.pose;
    const second = trace.find(item => item.photo === 'Photo 2 of 2' && item.framing === 'half' && !item.hidden)?.pose;
    assert.notEqual(first, second);
    const gallery = await admin.evaluate(() => window.photoBooth.listGallery()); assert.equal(gallery.originals.length, 2);
    const ratios = await admin.evaluate(async paths => Promise.all(paths.map(async file => { const url = await window.photoBooth.getImageDataUrl(file); const image = new Image(); image.src = url; await image.decode(); return image.width / image.height; })), gallery.originals.map(photo => photo.path));
    assert.ok(ratios.some(ratio => Math.abs(ratio - 2/3) < .01)); assert.ok(ratios.some(ratio => Math.abs(ratio - 1.5) < .01));
    const frames = (await guest.evaluate(() => window.phase2Frames)).sort((a,b)=>a-b);
    passed('Offline family session randomly chooses distinct poses, follows mixed slots and captures both crops', { first, second, ratios, medianFrameMs: frames[Math.floor(frames.length*.5)], p95FrameMs: frames[Math.floor(frames.length*.95)] });

    }
    await admin.getByRole('button', { name: 'Workflow', exact: true }).click();
    const guideToggle = admin.getByRole('checkbox', { name: 'Animated pose guide', exact: true });
    const guideToggleBox = await guideToggle.boundingBox();
    const guideTitleBox = await admin.locator('.admin-card-toggle-title span').boundingBox();
    assert.ok(guideToggleBox.width <= 18 && guideToggleBox.height <= 18 && guideToggleBox.x < guideTitleBox.x);
    passed('Workflow pose-guide checkbox is compact and aligned left of its title', { width: guideToggleBox.width, height: guideToggleBox.height });
    await admin.getByRole('button', { name: 'Poses', exact: true }).click(); await admin.waitForSelector('.pose-editor');
    assert.equal(await admin.locator('.pose-library-list button').count(), 255);
    await admin.getByLabel('Search poses', { exact: true }).fill('anime');
    assert.ok(await admin.locator('.pose-library-list button').count() >= 2);
    await admin.getByLabel('Search poses', { exact: true }).fill('');
    await admin.getByLabel('Pose category', { exact: true }).selectOption('funny');
    assert.equal(await admin.locator('.pose-library-list button').count(), 15);
    await admin.getByLabel('Pose category', { exact: true }).selectOption('all');
    const firstPoseName = await admin.locator('.pose-library-list button strong').first().evaluate(element => { const style = getComputedStyle(element); const box = element.getBoundingClientRect(); return { text: element.textContent, display: style.display, color: style.color, opacity: style.opacity, width: box.width, height: box.height }; });
    assert.ok(firstPoseName.text && firstPoseName.width > 0 && firstPoseName.height > 0);
    const firstThumb = await admin.locator('.pose-gallery-thumb').first().evaluate(element => { const box = element.getBoundingClientRect(); const image = element.querySelector('img'); return { width: box.width, height: box.height, fit: image ? getComputedStyle(image).objectFit : '' }; });
    assert.ok(Math.abs(firstThumb.width - 180) < 1 && Math.abs(firstThumb.height - 180) < 1 && firstThumb.fit === 'contain');
    passed('Pose library search and category filters cover the bundled catalog', { firstPoseName, firstThumb });
    await admin.locator('.pose-library-list button').first().click();
    const previewTop = await admin.locator('.pose-editor-preview').evaluate(element => element.getBoundingClientRect().top);
    await admin.locator('.admin-panel').evaluate(element => { element.scrollTop = 700; }); await admin.waitForTimeout(100);
    const stickyPreviewTop = await admin.locator('.pose-editor-preview').evaluate(element => element.getBoundingClientRect().top);
    await admin.locator('.admin-panel').evaluate(element => { element.scrollTop = 1000; }); await admin.waitForTimeout(100);
    const fartherPreviewTop = await admin.locator('.pose-editor-preview').evaluate(element => element.getBoundingClientRect().top);
    assert.ok(stickyPreviewTop < previewTop && Math.abs(stickyPreviewTop - fartherPreviewTop) < 3, `Preview did not stay pinned: ${previewTop} -> ${stickyPreviewTop} -> ${fartherPreviewTop}`);
    await admin.locator('.admin-panel').evaluate(element => { element.scrollTop = 0; });
    await admin.evaluate(async () => { const settings = await window.photoBooth.getSettings(); await window.photoBooth.updateSettings({ ai: { ...settings.ai, providers: { ...settings.ai.providers, openai: { ...settings.ai.providers.openai, enabled: true, apiKey: 'pose-test-key' } }, poseGenerator: { ...settings.ai.poseGenerator, provider: 'openai', providers: { ...settings.ai.poseGenerator.providers, openai: { apiUrl: 'https://openai.test/v1/responses', model: 'pose-test-model' } } } } }); });
    await app.evaluate(({}, plan) => { global.poseAiOriginalFetch = global.fetch; global.fetch = async (url, init) => String(url).startsWith('https://openai.test/') ? new Response(JSON.stringify({ output_text: JSON.stringify(plan) }), { status: 200, headers: { 'content-type': 'application/json' } }) : global.poseAiOriginalFetch(url, init); }, poseAiPlan);
    await admin.locator('summary').filter({ hasText: 'AI Pose Generator' }).click();
    await admin.getByLabel('Pose description', { exact: true }).fill('Girl leaning left with a right-hand peace sign, a big smile, and a left-eye wink.');
    await admin.getByRole('button', { name: 'Generate preview', exact: true }).click();
    await admin.waitForFunction(() => document.querySelector('.pose-editor-message')?.textContent.includes('AI draft ready'));
    assert.equal(await admin.getByLabel('Name', { exact: true }).inputValue(), 'AI peace lean');
    assert.equal(await admin.getByLabel('Animation position', { exact: true }).inputValue(), '7000');
    await admin.screenshot({ path: path.join(artifacts, 'pose-ai-generator.png'), fullPage: true });
    await admin.getByRole('button', { name: 'Save pose', exact: true }).click();
    await admin.waitForFunction(() => document.querySelector('.pose-editor-message')?.textContent.includes('Pose saved'));
    const aiPose = (await admin.evaluate(() => window.photoBooth.listPoses())).poses.find(pose => pose.name === 'AI peace lean');
    assert.ok(aiPose && aiPose.tags.includes('ai-generated'));
    await admin.evaluate(id => window.photoBooth.deletePose(id), aiPose.id);
    await app.evaluate(() => { global.fetch = global.poseAiOriginalFetch; delete global.poseAiOriginalFetch; });
    await admin.getByRole('button', { name: 'Back', exact: true }).click();
    await admin.locator('.pose-library-list button').filter({ hasText: 'Peace and Wink' }).first().click();
    passed('AI description generates a validated immediate preview that saves offline', { id: aiPose.id });
    await admin.getByLabel('Scale', { exact: true }).fill('1.2'); await admin.getByLabel('Scale', { exact: true }).press('Tab');
    await admin.getByLabel('Total seconds', { exact: true }).fill('6'); await admin.getByLabel('Total seconds', { exact: true }).press('Tab');
    await admin.getByRole('button', { name: 'Stretch animation', exact: true }).click();
    await admin.getByLabel('Name', { exact: true }).fill('Smoke custom pose'); await admin.getByLabel('Name', { exact: true }).press('Tab');
    await admin.getByRole('button', { name: 'Save pose', exact: true }).click();
    await admin.waitForFunction(() => document.querySelector('.pose-editor-message')?.textContent.includes('Pose saved'));
    let stored = await admin.evaluate(() => window.photoBooth.listPoses()); assert.equal(stored.poses.length, 1);
    assert.equal(stored.poses[0].animation.durationMs, 6000);
    const storedId = stored.poses[0].id;
    await admin.screenshot({ path: path.join(artifacts, 'pose-editor.png'), fullPage: true });
    await admin.reload(); await admin.waitForSelector('.admin-sidebar');
    await admin.getByRole('button', { name: 'Poses', exact: true }).click();
    await admin.locator('.pose-library-list button').filter({ hasText: 'Smoke custom pose' }).click();
    assert.equal(await admin.getByLabel('Total seconds', { exact: true }).inputValue(), '6');
    passed('Cutout scale and duration changes survive reload', { storedId });

    // Synthetic local WAV exercises transport and marker authoring, not voice generation.
    const wavPath = path.join(profile, 'narration-test.wav'), rate = 8000, samples = rate * 2;
    const wav = Buffer.alloc(44 + samples * 2); wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40); fs.writeFileSync(wavPath, wav);
    await app.evaluate(({dialog}, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, wavPath);
    await admin.evaluate(async () => { const settings = await window.photoBooth.getSettings(); await window.photoBooth.updateSettings({ audio: { ...settings.audio, enabled: true } }); });
    await admin.locator('summary').filter({ hasText: 'Narration' }).click();
    await admin.getByRole('button', { name: 'Assign audio file', exact: true }).click();
    await admin.waitForFunction(() => document.querySelector('.pose-editor-settings')?.textContent.includes('2.0s audio'));
    await admin.evaluate(() => { const original = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function() { if (this.tagName === 'AUDIO') window.editorAudio = this; return original.call(this); }; });
    await admin.getByRole('button', { name: 'Play', exact: true }).click();
    await admin.waitForFunction(() => window.editorAudio && !window.editorAudio.paused);
    await admin.getByRole('button', { name: 'Pause', exact: true }).click();
    assert.equal(await admin.evaluate(() => window.editorAudio.paused), true);
    await admin.getByLabel('Animation position', {exact: true}).evaluate(input => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '1600'); input.dispatchEvent(new Event('input', {bubbles:true})); input.dispatchEvent(new Event('change', {bubbles:true})); });
    await admin.waitForFunction(() => document.querySelector('input[aria-label="Animation position"]').value === '1600');
    await admin.waitForTimeout(150);
    assert.ok(Math.abs(await admin.evaluate(() => window.editorAudio.currentTime) - 1.6) < .1);
    await admin.getByRole('button', { name: 'Add marker at current time', exact: true }).click();
    await admin.getByLabel('Teaching frame', {exact: true}).selectOption('1500');
    await admin.getByRole('button', { name: 'Align current step', exact: true }).click();
    await admin.getByRole('button', { name: 'Save pose', exact: true }).click();
    await admin.waitForFunction(() => document.querySelector('.pose-editor-message')?.textContent.includes('Pose saved'));
    const narrated = (await admin.evaluate(() => window.photoBooth.listPoses())).poses[0];
    assert.ok(narrated.audio.filePath.startsWith(path.join(profile, 'pose-library', 'audio')));
    assert.equal(narrated.audio.markers[0].timeMs, 1600);
    assert.ok(narrated.animation.captions.some(caption => caption.timeMs === 1600));
    assert.ok(narrated.animation.captions.some(caption => caption.markerId === narrated.audio.markers[0].id));
    passed('Local audio import, natural-speed play/pause/seek and synchronized step markers');

    await app.evaluate(({ dialog }, output) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: output }); }, path.join(profile, 'exported.json'));
    await admin.getByRole('button', { name: 'Export JSON', exact: true }).click();
    await admin.waitForFunction(() => document.querySelector('.pose-editor-message')?.textContent.includes('JSON exported'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'exported.json'), 'utf8')).id, storedId);
    await assert.rejects(admin.evaluate(() => window.photoBooth.deletePose('../outside')));
    fs.writeFileSync(path.join(profile, 'pose-library', 'malformed.json'), '{bad json');
    stored = await admin.evaluate(() => window.photoBooth.listPoses()); assert.equal(stored.poses.length, 1); assert.equal(stored.errors.length, 1);
    await admin.evaluate(id => window.photoBooth.deletePose(id), storedId);
    assert.equal((await admin.evaluate(() => window.photoBooth.listPoses())).poses.length, 0);
    passed('JSON export/delete, unsafe IDs and malformed files handled without damaging bundled poses');

    // Guide-off path bypasses all new questions and retains existing timing.
    await admin.evaluate(async () => { const settings = await window.photoBooth.getSettings(); await window.photoBooth.updateSettings({ poseGuide: { enabled: false }, template: { ...settings.template, layouts: settings.template.layouts.map(layout => ({ ...layout, photoWindows: layout.photoWindows.slice(0, 1), photosToTake: 1 })) } }); });
    await guest.reload(); await guest.waitForSelector('.welcome-start-button'); await guest.locator('.welcome-start-button').click();
    await guest.waitForSelector('.capture-screen'); assert.equal(await guest.locator('.guest-composition-screen').count(), 0); assert.equal(await guest.locator('.pose-guide').count(), 0);
    await guest.waitForSelector('.thanks-screen', { timeout: 12000 });
    assert.equal((await admin.evaluate(() => window.photoBooth.listGallery())).originals.length, process.env.POSE_EDITOR_ONLY ? 1 : 3);
    passed('Guide disabled bypasses guest selection and captures with legacy workflow');
    assert.deepEqual(errors, []); passed('No renderer errors', { errors });
    fs.writeFileSync(path.join(artifacts, 'verification.json'), JSON.stringify({ results, trace, profile }, null, 2));
    console.log(JSON.stringify(results, null, 2));
  } finally { await app.close(); }
}
main().catch(error => { console.error(error); fs.writeFileSync(path.join(artifacts, 'failed.json'), JSON.stringify({ error: String(error), results, errors }, null, 2)); process.exitCode = 1; });
