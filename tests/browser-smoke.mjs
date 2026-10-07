// The same bounded acceptance command runs against the built preview and Pages.
// It uses real input and a fresh world, without bulk simulation or video capture.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import os from 'node:os';
import { configuration, launch, boot, environment, observeErrors, waitForRenderedFrames, output, save } from './browser-v2.mjs';
import { battleSmoke } from './battle-smoke.mjs';

const require = createRequire(import.meta.url);
const browserRegistry = JSON.parse(await readFile(path.join(path.dirname(require.resolve('playwright-core/package.json')), 'browsers.json'), 'utf8'));
const pinnedBrowser = browserRegistry.browsers.find(b => b.name === 'chromium-headless-shell').browserVersion;
const expectedCommit = process.env.EXPECTED_COMMIT || process.env.GITHUB_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.match(expectedCommit, /^[a-f0-9]{40}$/);
const config = configuration({ ...process.env, BASE_URL: process.env.BASE_URL || 'http://127.0.0.1:4176/little-world/', QA_OUTPUT_DIR: process.env.QA_OUTPUT_DIR || 'screenshots/smoke', QA_QUALITY: 'low', QA_VIDEO: '0' });
const diagnostic = process.env.QA_BROWSER_PARITY === 'diagnostic';
const report = { startedAt: new Date().toISOString(), expectedCommit, url: config.url, node: process.version, v8: process.versions.v8, platform: process.platform, kernel: os.release(), architecture: process.arch, scope: 'Built artifact; pinned Playwright Chromium; fresh-world real mouse/keyboard input. No long audit or video.', deadlineMs: 180000, checks: [], errors: [], warnings: [], markerAttempts: [] };
const started = performance.now();
let browser, page, timer;
await mkdir(config.outputDir, { recursive: true });
async function check(name, fn) {
  const before = performance.now();
  try { const evidence = await fn(); report.checks.push({ name, passed: true, elapsedMs: performance.now() - before, evidence }); }
  catch (error) { report.checks.push({ name, passed: false, elapsedMs: performance.now() - before, error: error.message }); throw error; }
}
const button = action => page.locator(`[data-action="${action}"]`).first();
const rendered = () => waitForRenderedFrames(page, { minimumFrames: 2, maximumMs: 15000 });
async function accept() {
  browser = await launch(config);
  report.browserLock = { playwright: require('@playwright/test/package.json').version, expected: pinnedBrowser, actual: browser.version(), matches: browser.version() === pinnedBrowser, diagnostic, executableOverride: config.launchOptions.executablePath || null };
  assert.ok(report.browserLock.matches || diagnostic, `Browser differs from lockfile: expected ${pinnedBrowser}, got ${browser.version()}. Install the locked Playwright browser. QA_BROWSER_PARITY=diagnostic is evidence only, not release acceptance.`);
  page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(15000);
  await check('Exact built commit is available', async () => {
    report.markerBudgetMs = ['127.0.0.1', 'localhost'].includes(new URL(config.url).hostname) ? 5000 : 90000;
    const deadline = performance.now() + report.markerBudgetMs;
    do {
      const marker = new URL('build.json', config.url); marker.search = `?verify=${expectedCommit}-${Date.now()}`;
      const response = await page.request.get(marker.href, { timeout: 10000 });
      const value = response.ok() ? await response.json() : null;
      report.markerAttempts.push({ status: response.status(), commit: value?.commit ?? null });
      if (value?.commit === expectedCommit) { report.build = value; break; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    } while (performance.now() < deadline);
    assert.equal(report.build?.commit, expectedCommit, 'Built/public marker does not match the exact commit');
    return report.build;
  });
  observeErrors(page, report);
  await check('Actual built WebGL application boots', async () => {
    await boot(page, config); await rendered();
    assert.equal(await page.title(), 'LittleWorld V2 — A living frontier');
    assert.equal(await page.locator('#app canvas').count(), 1);
    assert.equal(await page.locator('.faction-entry').count(), config.civCount);
    report.environment = await environment(page, browser, config);
    return report.environment;
  });
  const initial = await page.evaluate(() => JSON.stringify(littleworld.state));
  await check('Faction click selects its home, focuses the camera and scopes fog', async () => {
    await page.locator('.faction-entry[data-value="f1"]').click();
    await page.waitForFunction(() => { const w = littleworld, h = w.shownState.settlements.find(h => h.id === w.view.selectedId); return w.view.perspective === 'f1' && h && Math.hypot(w.controls.target.x - h.x, w.controls.target.z - h.z) < 1; });
    await rendered();
    const facts = await page.evaluate(() => ({ selected: littleworld.view.selectedId, viewer: littleworld.shownState.viewer.factionId, foreignCensus: littleworld.shownState.factions.filter(f => f.id !== 'f1').map(f => f.economy.population), fog: littleworld.diagnostics.fog.active }));
    assert.equal(facts.selected, 's1'); assert.equal(facts.viewer, 'f1'); assert.equal(facts.fog, true);
    assert.ok(facts.foreignCensus.every(value => value === null));
    assert.equal(await page.evaluate(() => JSON.stringify(littleworld.state)), initial);
    return facts;
  });
  await check('Settings restore world perspective without changing simulation', async () => {
    await button('settings').click(); await page.locator('#atlas-perspective').selectOption('omniscient'); await button('settings').click(); await rendered();
    assert.equal(await page.evaluate(() => littleworld.view.perspective), 'omniscient');
    assert.equal(await page.evaluate(() => JSON.stringify(littleworld.state)), initial);
  });
  await check('Main world renders and inspects persistent recruited soldier identities', async () => {
    const facts = await page.evaluate(() => {
      const w = littleworld, canonical = w.state.settlements.flatMap(home => home.soldierRoster).filter(body => body.status === 'serving' && body.alive);
      const projected = w.shownState.soldiers.filter(body => body.status === 'serving' && body.alive);
      const visible = w.getMotionSamples().filter(sample => sample.soldierId && sample.visible);
      const selected = visible[0]?.soldierId;
      if (selected) w.select(selected);
      return { canonical: canonical.map(body => body.id).sort(), projected: projected.map(body => body.id).sort(), selected, visible: visible.map(sample => sample.soldierId), militaryModels: w.diagnostics.crowds.militaryIndividuals };
    });
    assert.ok(facts.canonical.length && facts.selected, 'No actual initial soldier was rendered');
    assert.deepEqual(facts.projected, facts.canonical); assert.equal(facts.militaryModels, facts.canonical.length);
    assert.ok(facts.visible.every(id => facts.canonical.includes(id)));
    await rendered(); assert.equal(await page.evaluate(() => littleworld.view.selectedId), facts.selected);
    assert.match(await page.locator('.soldier-detail').innerText(), /Health/);
    assert.equal(await page.evaluate(() => JSON.stringify(littleworld.state)), initial, 'Soldier inspection changed the world');
    return { serving: facts.canonical.length, selected: facts.selected, visible: facts.visible.length, militaryModels: facts.militaryModels };
  });
  await check('An exposed building canvas click opens its own details', async () => {
    const points = await page.evaluate(async () => {
      const THREE = await import('three'), w = littleworld, ray = new THREE.Raycaster();
      const all = [...w.renderers.buildings.getPickables(), ...w.renderers.crowds.getPickables()];
      return w.renderers.buildings.getPickables().map(o => {
        const p = o.position.clone().setFromMatrixPosition(o.matrixWorld).project(w.camera), x = (p.x * .5 + .5) * innerWidth, y = (-p.y * .5 + .5) * innerHeight;
        ray.setFromCamera(new THREE.Vector2(p.x, p.y), w.camera); const hit = ray.intersectObjects(all, true)[0];
        return { id: o.userData.buildingId, front: hit?.object?.userData.buildingId, x, y, visible: p.z < 1 && document.elementFromPoint(x, y)?.tagName === 'CANVAS' };
      }).filter(p => p.id && p.id === p.front && p.visible && p.x > 230 && p.x < 930 && p.y > 135 && p.y < 650);
    });
    assert.ok(points.length, 'No exposed natural building is available');
    const target = points[0]; await page.mouse.click(target.x, target.y); await rendered();
    assert.equal(await page.evaluate(() => littleworld.view.selectedId), target.id);
    assert.match(await page.locator('.inspector').innerText(), /condition|integrity|construction/i);
    return target;
  });
  await check('Pointer drag moves the camera while the world stays paused', async () => {
    const before = await page.evaluate(() => littleworld.camera.position.toArray());
    await page.mouse.move(560, 410); await page.mouse.down(); await page.mouse.move(620, 440, { steps: 5 }); await page.mouse.up(); await rendered();
    assert.notDeepEqual(await page.evaluate(() => littleworld.camera.position.toArray()), before);
    assert.equal(await page.evaluate(() => JSON.stringify(littleworld.state)), initial);
  });
  await check('Mouse resume and pause advance then freeze the simulation', async () => {
    const before = await page.evaluate(() => littleworld.state.step);
    await page.locator('[data-action="speed"][data-value="2"]').click();
    // Choosing a speed starts playback through the real control action.
    await page.waitForFunction(step => littleworld.state.step > step, before);
    const framePulses = await page.evaluate(() => new Promise(resolve => {
      const counts = []; let previous = littleworld.state.step;
      const sample = () => { const step = littleworld.state.step; counts.push(step - previous); previous = step; if (counts.length < 10) requestAnimationFrame(sample); else resolve(counts); };
      requestAnimationFrame(sample);
    }));
    assert.ok(framePulses.every(count => count >= 0 && count <= 4), 'A frame exceeded the responsive catch-up pulse limit');
    await button('pause').click(); await rendered();
    const paused = await page.evaluate(() => ({ step: littleworld.state.step, paused: littleworld.view.paused }));
    assert.ok(paused.step > before && paused.paused); await rendered();
    assert.equal(await page.evaluate(() => littleworld.state.step), paused.step);
    return { before, ...paused, framePulses, nominalSpeed: 2 };
  });
  await check('Space input toggles the world clock from the canvas', async () => {
    await page.locator('#app canvas').focus(); const before = await page.evaluate(() => littleworld.state.step);
    await page.keyboard.press('Space'); await page.waitForFunction(step => littleworld.state.step > step, before); await page.keyboard.press('Space'); await rendered();
    assert.equal(await page.evaluate(() => littleworld.view.paused), true);
  });
  await check('Weighted census and real model counts agree', async () => {
    const d = await page.evaluate(() => littleworld.diagnostics), c = d.crowds;
    assert.ok(d.totalPopulation > 0); assert.equal(d.representedIndividuals, d.totalPopulation);
    assert.equal(c.populationAccountingDelta, 0); assert.equal(c.visibleIndividuals + c.culledIndividuals + c.housedIndividuals, d.totalPopulation);
    assert.equal(c.drawnModels, c.visibleIndividuals - c.visibleWorkerIndividuals + c.drawnWorkerModels);
    assert.equal(c.drawnWorkerModels, c.visibleWorkerCrews);
    return { people: d.totalPopulation, models: c.drawnModels, workers: c.visibleWorkerIndividuals, crews: c.drawnWorkerModels };
  });
  await page.screenshot({ path: output(config, 'smoke.png') });
  await battleSmoke({ page, check, screenshotPath: output(config, 'battle-smoke.png') });
  await check('No runtime, module or HTTP errors', async () => assert.deepEqual(report.errors, []));
}
try {
  await Promise.race([accept(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Smoke exceeded its 180-second total budget')), report.deadlineMs); })]);
  report.status = diagnostic ? 'diagnostic-passed' : 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = error.stack; process.exitCode = 1;
  if (page) try { await page.screenshot({ path: output(config, 'smoke-failure.png'), timeout: 5000 }); } catch {}
} finally {
  clearTimeout(timer); await browser?.close(); report.elapsedMs = performance.now() - started; report.completedAt = new Date().toISOString();
  await save(config, 'smoke-report.json', report);
}
console.log(JSON.stringify({ status: report.status, checks: report.checks.length, elapsedMs: report.elapsedMs, expectedCommit, browserLock: report.browserLock, failure: report.failure, report: output(config, 'smoke-report.json') }));
