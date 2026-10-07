// Actual prototype rendering and ordinary seeded combat. This suite never edits
// HP, unit placement, ownership or orders to manufacture a demonstration.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { configuration, launch, observeErrors } from './browser-v2.mjs';
const config = configuration({ ...process.env, BASE_URL: process.env.BASE_URL || 'http://127.0.0.1:4176/little-world/', QA_QUALITY: 'low' });
const url = new URL('battle.html?seed=crossing', config.url);
const dir = process.env.QA_OUTPUT_DIR || 'screenshots/battle-browser';
await mkdir(dir, { recursive: true });
const report = { startedAt: new Date().toISOString(), url: url.href, scope: 'Actual 24-vs-24 browser render and unmodified seeded fight; normal 1x video with no retiming. Local system-browser evidence is diagnostic, not locked-browser acceptance.', sourceCommit: process.env.QA_SOURCE_SHA || null, errors: [], warnings: [], checks: [], screenshots: [], videos: [] };
const browser = await launch(config), page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
observeErrors(page, report); page.setDefaultTimeout(15000);
async function rendered() { const frame = await page.evaluate(() => littleworldBattle.renderer.info.render.frame); await page.waitForFunction(f => littleworldBattle.renderer.info.render.frame >= f + 2, frame); }
async function shot(name) { await page.screenshot({ path: `${dir}/${name}.png` }); report.screenshots.push({ file: `${name}.png`, ...(await page.evaluate(() => ({ time: littleworldBattle.state.time, selected: littleworldBattle.view.selectedId, perspective: littleworldBattle.view.perspective }))) }); }
try {
  await page.goto(url.href, { waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => window.littleworldBattle?.state?.units?.length > 0); await rendered();
  report.sourceFiles = {};
  for (const file of ['battle.html', 'src/battle/sim.js', 'src/battle/main.js', 'src/battle/render.js', 'src/battle/style.css']) {
    const response = await page.request.get(new URL(file, config.url).href);
    assert.ok(response.ok(), `Missing served prototype source: ${file}`);
    report.sourceFiles[file] = createHash('sha256').update(await response.body()).digest('hex');
  }
  report.environment = await page.evaluate(() => { const w = littleworldBattle, gl = w.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info'); return { userAgent: navigator.userAgent, gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), viewport: [innerWidth, innerHeight] }; });
  report.environment.browser = browser.version(); report.environment.launch = config.launchOptions;
  await shot('battle-opening');
  const discovery = await page.evaluate(async () => {
    const w = littleworldBattle, { stepBattle } = await import(new URL('./src/battle/sim.js', location.href).href);
    w.actions.reset('crossing', { perSide: 24 });
    for (let i = 0; i < 1200 && !w.state.outcome; i++) stepBattle(w.state, .1);
    const death = w.state.events.find(e => e.type === 'death');
    if (!death) throw Error('The ordinary seed produced no casualty within the bounded window.');
    return { finalTime: w.state.time, outcome: w.state.outcome, metrics: w.state.metrics, firstDeath: death,
      firstWithdrawal: w.state.events.find(e => e.type === 'decision' && e.action === 'withdraw'),
      deaths: w.state.events.filter(e => e.type === 'death').map(e => ({ time: e.time, targetId: e.targetId, sourceId: e.sourceId })),
      units: w.state.units.map(u => ({ id: u.id, team: u.team, hp: u.hp, alive: u.alive })) };
  });
  report.naturalDiscovery = discovery;
  const victimId = discovery.firstDeath.targetId, startTime = Math.max(0, discovery.firstDeath.time - 5);
  await page.evaluate(({ startTime, victimId }) => {
    const w = littleworldBattle; w.actions.reset('crossing', { perSide: 24 }); w.stepPulses(Math.floor(startTime * 10));
    const unit = w.state.units.find(u => u.id === victimId);
    if (!unit?.alive) throw Error('The natural casualty replay did not preserve its living identity before the hit.');
    const dx = unit.x - w.controls.target.x, dz = unit.z - w.controls.target.z;
    w.camera.position.x += dx; w.camera.position.z += dz; w.controls.target.x = unit.x; w.controls.target.z = unit.z;
    w.camera.zoom *= 1.45; w.camera.updateProjectionMatrix(); w.controls.update();
  }, { startTime, victimId });
  await rendered();
  const point = await page.evaluate(id => littleworldBattle.projectUnit(id), victimId);
  assert.ok(point && point.visible !== false);
  await page.mouse.click(point.x, point.y); await rendered();
  assert.equal(await page.locator('#unit-inspector').getAttribute('data-selected-id'), victimId);
  await shot('battle-selected-before-impact');
  const clip = await page.evaluate(async victimId => {
    const w = littleworldBattle, stream = w.renderer.domElement.captureStream(30), chunks = [], frames = [];
    const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8'].find(t => MediaRecorder.isTypeSupported(t));
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5000000 });
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    const done = new Promise((resolve, reject) => { recorder.onstop = resolve; recorder.onerror = reject; });
    const began = performance.now(), start = w.state.time, firstEvent = w.state.events.length; let stopped = false, request;
    const sample = () => {
      const victim = w.state.units.find(u => u.id === victimId);
      frames.push({ wallMs: performance.now() - began, time: w.state.time, speed: w.view.speed, paused: w.view.paused, selected: w.view.selectedId,
        victim: { id: victim.id, hp: victim.hp, alive: victim.alive, x: victim.x, z: victim.z },
        live: w.state.units.filter(u => u.alive).length, withdrawing: w.state.units.filter(u => u.alive && u.withdrawing).map(u => u.id),
        diagnostics: w.diagnostics() });
      if (!stopped) request = requestAnimationFrame(sample);
    };
    recorder.start(500); w.actions.setSpeed(1); if (w.view.paused) w.actions.togglePause(); request = requestAnimationFrame(sample);
    await new Promise(resolve => setTimeout(resolve, 19000)); stopped = true; cancelAnimationFrame(request);
    const wallMs = performance.now() - began, end = w.state.time; if (!w.view.paused) w.actions.togglePause();
    recorder.stop(); await done; stream.getTracks().forEach(t => t.stop());
    const blob = new Blob(chunks, { type: mimeType });
    const data = await new Promise(resolve => { const r = new FileReader(); r.onload = () => resolve(r.result.split(',')[1]); r.readAsDataURL(blob); });
    return { mimeType, bytes: blob.size, start, end, wallMs, frames, events: w.state.events.slice(firstEvent), data };
  }, victimId);
  await writeFile(`${dir}/battle-individual-combat-1x.webm`, Buffer.from(clip.data, 'base64')); delete clip.data;
  report.videos.push({ file: 'battle-individual-combat-1x.webm', ...clip });
  assert.ok(clip.end > clip.start); assert.ok(clip.frames.every(f => f.speed === 1));
  assert.ok(clip.events.some(e => e.type === 'death' && e.targetId === victimId), 'The selected real casualty was not observed in the actual video window');
  const victim = await page.evaluate(id => littleworldBattle.state.units.find(u => u.id === id), victimId);
  assert.equal(victim.hp, 0); assert.equal(victim.alive, false);
  assert.equal(await page.locator('#unit-inspector').getAttribute('data-selected-id'), victimId);
  report.checks.push({ name: 'Selected casualty retains the exact individual ID and reaches zero HP during actual 1x capture', passed: true, victimId });
  await shot('battle-selected-casualty');
  await page.locator('#battle-reset').click(); await page.locator('#battle-perspective').selectOption('blue'); await rendered();
  const hidden = await page.evaluate(() => littleworldBattle.shownState.units.filter(u => u.team === 'red').length);
  assert.equal(hidden, 0); await shot('battle-blue-sight');
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  const touch = await mobile.newPage(); observeErrors(touch, report);
  await touch.goto(url.href, { waitUntil: 'domcontentloaded' }); await touch.waitForFunction(() => window.littleworldBattle?.state?.units?.length > 0);
  await touch.locator('#battle-pause').tap(); await touch.waitForFunction(() => littleworldBattle.state.time > .2); await touch.locator('#battle-pause').tap();
  assert.equal(await touch.evaluate(() => littleworldBattle.view.paused), true);
  assert.ok(await touch.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await touch.screenshot({ path: `${dir}/battle-mobile-portrait.png` }); report.screenshots.push({ file: 'battle-mobile-portrait.png', width: 390, height: 844, scope: 'Touch browser emulation, not physical phone' });
  await mobile.close(); assert.deepEqual(report.errors, []); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.failure = error.stack; process.exitCode = 1; try { await page.screenshot({ path: `${dir}/battle-failure.png` }); } catch {} }
finally { await browser.close(); report.completedAt = new Date().toISOString(); await writeFile(`${dir}/battle-browser-report.json`, JSON.stringify(report, null, 2)); }
console.log(JSON.stringify({ status: report.status, checks: report.checks, videos: report.videos.map(v => ({ file: v.file, start: v.start, end: v.end, frames: v.frames.length, wallMs: v.wallMs })), failure: report.failure, errors: report.errors, report: `${dir}/battle-browser-report.json` }));
