// Historical Phase 1 smoke test (fixed-cycle assumptions). For current Phase 2
// use scripts/verify-pose-phase2.cjs instead.
// Optional desktop smoke test. Supply Playwright through POSE_PLAYWRIGHT_MODULE
// or install it in your development environment. Production has no dependency on it.
const { _electron } = require(process.env.POSE_PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, '.cache', 'pose-check');
const profile = path.join(artifacts, `profile-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });
const framePath = path.join(artifacts, 'transparent-frame.png');
fs.writeFileSync(framePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'));
const layout = {
  id: 'pose-test', name: 'Pose test', orientation: 'portrait', paperWidth: 1200, paperHeight: 1800,
  photoWindows: [{ x: 0, y: 0, width: 1200, height: 1800, sourceIndex: 0 }], photosToTake: 4,
  active: true, guestPreviewPath: '', printerName: '', createdAt: '', updatedAt: ''
};
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({
  eventFolder: path.join(profile, 'event'), webApiBaseUrl: '', eventId: '', printerEnabled: false,
  canonEnabled: false, mirrorPreview: true, cameraRotation: 0, poseGuide: { enabled: true },
  audio: { enabled: false }, beautyFilter: { enabledMode: 'off' },
  template: { styleVersion: 3, layouts: [layout], designs: [{ id: 'pose-test-design', templateId: layout.id, name: 'Pose test', active: true, previewPath: framePath, framePath, usesAi: false, videoRecordingEnabled: false }] },
  workflow: { introMs: 0, printAutoSelectMs: 120000, shots: Array.from({ length: 12 }, () => ({ message: 'Legacy instruction', cameraBeforeMessageMs: 0, messageMs: 20, cameraBeforeCountdownMs: 20 })) }
}));
const launcher = path.join(artifacts, 'launcher.cjs');
fs.writeFileSync(launcher, `const { app } = require('electron');\napp.setPath('userData', ${JSON.stringify(profile)});\nrequire(${JSON.stringify(path.join(root, 'dist-electron', 'main.js'))});\n`);

async function advanced(app, admin, guest, results) {
  const configure = async (canonEnabled, recording = false, shotCount = 1, poseId) => {
    await admin.evaluate(async ({ canonEnabled, recording, shotCount, poseId }) => {
      const settings = await window.photoBooth.getSettings();
      await window.photoBooth.updateSettings({
        canonEnabled, poseGuide: { enabled: true },
        workflow: { ...settings.workflow, shots: settings.workflow.shots.map(shot => ({ ...shot, poseId })) },
        template: { ...settings.template, layouts: settings.template.layouts.map(layout => ({ ...layout, photosToTake: shotCount })), designs: settings.template.designs.map(design => ({ ...design, videoRecordingEnabled: recording })) }
      });
    }, { canonEnabled, recording, shotCount, poseId });
    await guest.reload(); await guest.waitForSelector('.welcome-start-button');
  };
  const countPhotos = () => admin.evaluate(async () => (await window.photoBooth.listGallery()).originals.length);

  await configure(false);
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    global.poseCaptureChecks = [];
    ipcMain.removeHandler('window:capture-page');
    ipcMain.handle('window:capture-page', async (event, rect) => {
      const status = await event.sender.executeJavaScript(`(() => { const root = document.querySelector('.pose-guide'); return { hidden: getComputedStyle(root).visibility === 'hidden', countdown: !!document.querySelector('.countdown') }; })()`);
      global.poseCaptureChecks.push(status);
      return (await BrowserWindow.fromWebContents(event.sender).webContents.capturePage(rect)).toDataURL();
    });
  });
  await guest.locator('.welcome-start-button').click();
  await guest.waitForFunction(() => document.querySelector('.pose-guide-caption')?.textContent === 'Raise your right hand');
  await guest.evaluate(() => Object.defineProperty(document.querySelector('.capture-screen video'), 'videoWidth', { get: () => 0, configurable: true }));
  await guest.waitForSelector('.thanks-screen', { timeout: 18000 });
  assert.equal(await countPhotos(), 1);
  const checks = await app.evaluate(() => global.poseCaptureChecks);
  assert.deepEqual(checks, [{ hidden: true, countdown: false }]);
  results.push({ test: 'Forced screenshot fallback hides pose graphics before screenshot', result: 'pass' });

  await configure(true);
  const fakeStill = await guest.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 900;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#517268'; ctx.fillRect(0, 0, 600, 900);
    return canvas.toDataURL('image/png');
  });
  await app.evaluate(({ ipcMain }, dataUrl) => {
    global.poseCanonChecks = []; global.posePendingCanon = null;
    ipcMain.removeHandler('canon:capture');
    ipcMain.handle('canon:capture', async (event, crop) => {
      const status = await event.sender.executeJavaScript(`(() => { const root = document.querySelector('.pose-guide'); const video = document.querySelector('.capture-screen video'); return { hidden: getComputedStyle(root).visibility === 'hidden', previewPlaying: !video.paused && video.videoWidth > 0 }; })()`);
      global.poseCanonChecks.push({ ...status, crop });
      return new Promise(resolve => global.posePendingCanon = () => resolve({ dataUrl, width: 600, height: 900 }));
    });
  }, fakeStill);
  await guest.locator('.welcome-start-button').click();
  await guest.waitForFunction(() => document.querySelector('.pose-guide')?.getAttribute('data-hidden') === 'true', { timeout: 18000 });
  // Wait until the simulated USB operation is actually pending.
  for (let retry = 0; retry < 20; retry++) {
    if (await app.evaluate(() => !!global.posePendingCanon)) break;
    await guest.waitForTimeout(100);
  }
  assert.equal(await app.evaluate(() => !!global.posePendingCanon), true);
  await guest.locator('.guest-back-button').click(); await guest.waitForSelector('.welcome-start-button');
  await app.evaluate(() => global.posePendingCanon());
  await guest.waitForTimeout(600);
  assert.equal(await countPhotos(), 1);
  const canonChecks = await app.evaluate(() => global.poseCanonChecks);
  assert.equal(canonChecks[0].hidden, true); assert.equal(canonChecks[0].previewPlaying, true);
  assert.ok(canonChecks[0].crop.width > 0 && canonChecks[0].crop.height > 0);
  results.push({ test: 'Cancel pending simulated Canon capture discards stale result; HDMI preview remains separate', result: 'pass' });

  await configure(false, true, 6, 'invalid-pose-id');
  await app.evaluate(({ ipcMain }) => {
    global.poseRecordedBytes = 0;
    ipcMain.removeHandler('video:save-and-transcode');
    ipcMain.handle('video:save-and-transcode', async (_event, request) => {
      global.poseRecordedBytes = request.data.byteLength;
      return { path: '', name: '' };
    });
  });
  // Exercise real MediaRecorder lifecycle with a simulated recording source;
  // screen-source permission/driver behavior and MP4 transcoding remain unchanged.
  await guest.evaluate(() => {
    window.poseDisplayCalls = 0;
    navigator.mediaDevices.getDisplayMedia = async () => {
      window.poseDisplayCalls++;
      return navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 360 }, audio: false });
    };
    window.posePreviewChecks = [];
    const observer = new MutationObserver(() => {
      const text = document.querySelector('.pose-guide-progress')?.textContent;
      const video = document.querySelector('.capture-screen video');
      if (text && !window.posePreviewChecks.some(item => item.photo === text)) window.posePreviewChecks.push({ photo: text, playing: !video.paused });
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  await guest.locator('.welcome-start-button').click();
  await guest.waitForFunction(() => document.querySelector('.pose-guide-caption')?.textContent === 'Open your arms');
  await guest.waitForSelector('.select-screen', { timeout: 85000 });
  assert.equal(await countPhotos(), 7);
  assert.equal(await guest.locator('.select-grid button').count(), 6);
  assert.equal(await guest.evaluate(() => window.poseDisplayCalls), 1);
  assert.ok(await app.evaluate(() => global.poseRecordedBytes > 0));
  const previews = await guest.evaluate(() => window.posePreviewChecks.filter(item => item.photo.endsWith('of 6')));
  assert.equal(previews.length, 6); assert.ok(previews.every(item => item.playing));
  results.push({ test: 'Six-shot session, invalid-ID Freestyle fallback, continuous preview and MediaRecorder lifecycle', result: 'pass' });
}

async function main() {
  const env = { ...process.env, VITE_DEV_SERVER_URL: '' };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: [launcher, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
    env
  });
  const errors = [], results = [];
  let guest;
  try {
    const admin = await app.firstWindow();
    admin.on('pageerror', error => errors.push(error.message));
    await admin.waitForFunction(() => !!window.photoBooth && document.body?.innerText.includes('Event'));
    const initial = await admin.evaluate(() => window.photoBooth.getSettings());
    assert.equal(initial.poseGuide.enabled, true);
    const guestOpened = app.waitForEvent('window');
    await admin.evaluate(() => window.photoBooth.openGuest());
    guest = await guestOpened;
    guest.on('pageerror', error => errors.push(error.message));
    await guest.route(/^https?:\/\//, route => route.abort());
    await guest.waitForSelector('.welcome-start-button');

    if (process.env.POSE_CHECK_SETTINGS_ONLY) {
      await admin.evaluate(async () => {
        const settings = await window.photoBooth.getSettings();
        await window.photoBooth.updateSettings({ template: { ...settings.template, layouts: settings.template.layouts.map(layout => ({ ...layout, photosToTake: 1 })) } });
      });
      await guest.locator('.welcome-start-button').click();
      await guest.waitForFunction(() => document.querySelector('.pose-guide-caption')?.textContent === 'Raise your right hand');
      await admin.evaluate(() => window.photoBooth.updateSettings({ poseGuide: { enabled: false } }));
      await guest.waitForFunction(() => document.querySelector('.countdown')?.textContent === '3', { timeout: 14000 });
      assert.equal(await guest.locator('.pose-guide').count(), 1);
      await guest.waitForSelector('.thanks-screen', { timeout: 15000 });
      assert.equal((await admin.evaluate(() => window.photoBooth.listGallery())).originals.length, 1);
      await guest.locator('.guest-back-button').click(); await guest.waitForSelector('.welcome-start-button');
      await guest.locator('.welcome-start-button').click(); await guest.waitForSelector('.capture-screen');
      assert.equal(await guest.locator('.pose-guide').count(), 0);
      await guest.waitForSelector('.thanks-screen', { timeout: 15000 });
      assert.equal((await admin.evaluate(() => window.photoBooth.listGallery())).originals.length, 2);
      assert.deepEqual(errors, []);
      results.push({ test: 'Admin change during demonstration applies next session, without interrupting capture', result: 'pass' });
      fs.writeFileSync(path.join(artifacts, 'verification-settings.json'), JSON.stringify({ results, errors }, null, 2));
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    if (process.env.POSE_CHECK_ADVANCED_ONLY) {
      await advanced(app, admin, guest, results);
      assert.deepEqual(errors, []);
      fs.writeFileSync(path.join(artifacts, 'verification-advanced.json'), JSON.stringify({ results, errors }, null, 2));
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    // Measure the real DOM sequence without driving or changing the animation clock.
    await guest.evaluate(() => {
      window.poseCheck = { events: [], previous: '', frames: [], lastFrame: 0 };
      const observe = () => {
        const root = document.querySelector('.pose-guide');
        const photo = document.querySelector('.pose-guide-progress')?.textContent ?? '';
        const caption = document.querySelector('.pose-guide-caption')?.textContent ?? '';
        const countdown = document.querySelector('.countdown')?.textContent ?? '';
        const key = [photo, caption, countdown].join('|');
        if (key !== window.poseCheck.previous && (root || countdown)) {
          window.poseCheck.previous = key;
          window.poseCheck.events.push({ ms: performance.now(), photo, caption, countdown, hidden: !root || root.hasAttribute('data-hidden') || root.classList.contains('pose-guide--hidden') });
        }
      };
      new MutationObserver(observe).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'data-hidden'] });
      const frames = now => {
        if (document.querySelector('.capture-screen')) {
          if (window.poseCheck.lastFrame) window.poseCheck.frames.push(now - window.poseCheck.lastFrame);
          window.poseCheck.lastFrame = now;
        } else window.poseCheck.lastFrame = 0;
        requestAnimationFrame(frames);
      };
      requestAnimationFrame(frames);
    });

    await guest.locator('.welcome-start-button').click();
    await guest.waitForFunction(() => document.querySelector('.pose-guide-caption')?.textContent === 'Tilt your head, smile and wink!', { timeout: 15000 });
    await guest.screenshot({ path: path.join(artifacts, 'peace-wink.png') });
    await guest.waitForFunction(() => document.querySelector('.countdown')?.textContent === '3', { timeout: 10000 });
    await guest.screenshot({ path: path.join(artifacts, 'countdown.png') });
    await guest.waitForSelector('.select-screen', { timeout: 65000 });
    const trace = await guest.evaluate(() => window.poseCheck);
    for (let shot = 1; shot <= 4; shot++) {
      const photo = `Photo ${shot} of 4`;
      const events = trace.events.filter(event => event.photo === photo);
      const start = events.find(event => !event.hidden && event.caption && !event.countdown);
      const three = events.find(event => event.countdown === '3');
      assert.ok(start && three, `Missing demonstration/countdown for ${photo}`);
      assert.ok(three.ms - start.ms >= 7800 && three.ms - start.ms < 9500, `${photo} duration was ${three.ms - start.ms}`);
      assert.deepEqual([...new Set(events.map(e => e.countdown).filter(Boolean))], ['3', '2', '1']);
      assert.ok(events.find(event => event.countdown === '1').hidden);
    }
    const gallery = await admin.evaluate(() => window.photoBooth.listGallery());
    assert.equal(gallery.originals.length, 4);
    assert.equal(await guest.locator('.select-grid button').count(), 4);
    const intervals = trace.frames.sort((a, b) => a - b);
    results.push({ test: 'Four guided shots, offline captions/countdown, capture and selection', result: 'pass', originals: gallery.originals.length, medianFrameMs: intervals[Math.floor(intervals.length * .5)], p95FrameMs: intervals[Math.floor(intervals.length * .95)] });

    const back = () => guest.locator('.guest-back-button').click();
    await back(); await guest.waitForSelector('.welcome-start-button');
    await guest.locator('.welcome-start-button').click();
    await guest.waitForFunction(() => document.querySelector('.pose-guide-caption')?.textContent === 'Raise your right hand');
    await back(); await guest.waitForSelector('.welcome-start-button');
    await guest.waitForTimeout(1000);
    assert.equal((await admin.evaluate(() => window.photoBooth.listGallery())).originals.length, 4);
    results.push({ test: 'Cancel during demonstration prevents capture', result: 'pass' });

    await guest.locator('.welcome-start-button').click();
    await guest.waitForFunction(() => document.querySelector('.countdown')?.textContent === '1', { timeout: 16000 });
    await back(); await guest.waitForSelector('.welcome-start-button');
    await guest.waitForTimeout(1200);
    assert.equal((await admin.evaluate(() => window.photoBooth.listGallery())).originals.length, 4);
    results.push({ test: 'Cancel during final countdown second prevents capture', result: 'pass' });

    await admin.evaluate(async () => {
      const current = await window.photoBooth.getSettings();
      await window.photoBooth.updateSettings({ poseGuide: { enabled: false }, template: { ...current.template, layouts: current.template.layouts.map(layout => ({ ...layout, photosToTake: 1 })) } });
    });
    await guest.locator('.welcome-start-button').click();
    await guest.waitForSelector('.capture-screen');
    assert.equal(await guest.locator('.pose-guide').count(), 0);
    await guest.waitForSelector('.thanks-screen', { timeout: 15000 });
    assert.equal((await admin.evaluate(() => window.photoBooth.listGallery())).originals.length, 5);
    results.push({ test: 'Guide disabled uses legacy workflow and still captures', result: 'pass' });
    assert.deepEqual(errors, []);
    results.push({ test: 'Electron renderer errors', result: 'pass', errors });
    fs.writeFileSync(path.join(artifacts, 'verification.json'), JSON.stringify({ results, trace }, null, 2));
    console.log(JSON.stringify(results, null, 2));
  } finally { await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
