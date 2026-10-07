// Natural main-world evidence. Run only after the shared QA runner is quiet.
// No soldiers, armies, resources, ownership, wounds, or RNG values are injected.
// Bulk stepping is confined to scene preparation; capture uses the real 1x clock.
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import {
  configuration, launch, boot, environment, observeErrors, waitForRenderedFrames,
  output, save, TOUCH_VIEWPORTS, touchContextOptions,
} from './browser-v2.mjs';

const config = configuration({ ...process.env, QA_OUTPUT_DIR: process.env.QA_OUTPUT_DIR || 'screenshots/world-individual-browser' });
const maximumCycle = Number(process.env.QA_WORLD_MAX_CYCLE || 600);
assert.ok(Number.isInteger(maximumCycle) && maximumCycle >= 40 && maximumCycle <= 1200);
const captureMs = 18000;
const touchOnly = process.env.QA_WORLD_TOUCH_ONLY;
if (touchOnly) assert.ok(TOUCH_VIEWPORTS.some(viewport => viewport.name === touchOnly), 'Unknown touch viewport');
const report = {
  startedAt: new Date().toISOString(), seed: config.seed, civCount: config.civCount,
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  scope: 'Real main-world seeded simulation, persistent soldier instanced-mesh canvas picks, native touch emulation, and 18 wall seconds of unretimed 1x canvas capture. No injected game entities or damage.',
  limitations: 'This headless runner and its actual GPU/software renderer only. Touch emulation is not physical-device testing. Slow rendering may advance fewer simulation seconds than wall seconds; both are reported.',
  runner: { node: process.version, platform: process.platform, architecture: process.arch, kernel: os.release() },
  errors: [], warnings: [], checks: [], preparation: [], screenshots: [], videos: [], mobile: [],
};
let browser, page, battle;
const sourceHash = async () => {
  const hash = createHash('sha256');
  const names = (await readdir('src', { recursive: true })).filter(name => /\.(js|css)$/.test(name)).map(name => `src/${name}`);
  for (const name of [...names, 'index.html', 'package-lock.json'].sort()) hash.update(name).update('\0').update(await readFile(name));
  return hash.digest('hex');
};
const settle = current => waitForRenderedFrames(current, { minimumFrames: 3, maximumMs: 30000 });
const button = (current, action, value) => current.locator(`[data-action="${action}"]${value === undefined ? '' : `[data-value="${value}"]`}`).first();
async function check(name, action) {
  try { const evidence = await action(); report.checks.push({ name, passed: true, evidence }); return evidence; }
  catch (error) { report.checks.push({ name, passed: false, error: error.message }); throw error; }
}

// This snapshot reads canonical native rosters, never render-only slot ordinals.
function inspectWorld() {
  const w = littleworld, s = w.state, all = s.settlements.flatMap(home => home.soldierRoster || []);
  const body = person => ({ id: person.id, originId: person.originId, groupId: person.groupId, role: person.role, species: person.species,
    status: person.status, alive: person.alive, hp: person.hp, maxHp: person.maxHp, attackReadyAt: person.attackReadyAt,
    cooldown: person.cooldown, targetId: person.targetId, action: person.action, reasonCode: person.reasonCode,
    x: person.x, z: person.z, prevX: person.prevX, prevZ: person.prevZ, positioned: person.positioned, towerId: person.towerId });
  const live = all.filter(person => person.status === 'serving' && person.alive && person.hp > 0);
  const events = (s.combatEvents || []).filter(event => ['projectile', 'melee', 'impact', 'casualty'].includes(event.type));
  const hit = [...events].reverse().find(event => event.sourceSoldierId && event.targetSoldierId && ['projectile', 'melee'].includes(event.type) && event.time >= s.time - 1.1);
  const selected = all.find(person => person.id === w.view.selectedId);
  return { tick: s.tick, step: s.step, time: s.time, paused: w.view.paused, speed: w.view.speed, selectedId: w.view.selectedId,
    selected: selected ? body(selected) : null, stats: { ...s.stats }, population: s.settlements.reduce((sum, home) => sum + home.population, 0),
    liveSoldiers: live.length, retainedRecords: all.length, militaryTotal: s.settlements.reduce((sum, home) => sum + home.soldiers, 0),
    armies: s.groups.filter(group => group.kind === 'army').map(group => ({ id: group.id, size: group.size, x: group.x, z: group.z, phase: group.phase, soldierIds: [...(group.soldierIds || [])], combat: group.combat?.active })),
    hit: hit ? { id: hit.id, time: hit.time, type: hit.type, sourceSoldierId: hit.sourceSoldierId, targetSoldierId: hit.targetSoldierId, shot: hit.shots?.[0] } : null,
    soldiers: live.map(body), recentEvents: events.slice(-32), diagnostics: w.diagnostics,
    inspector: document.querySelector('.inspector')?.innerText || '', camera: w.camera.position.toArray(), cameraTarget: w.controls.target.toArray() };
}

async function screenshot(current, name) {
  await settle(current);
  const file = `${name}.png`;
  await current.screenshot({ path: output(config, file) });
  const evidence = await current.evaluate(() => ({ tick: littleworld.state.tick, step: littleworld.state.step, time: littleworld.state.time,
    paused: littleworld.view.paused, selectedId: littleworld.view.selectedId, inspector: document.querySelector('.inspector')?.innerText || '' }));
  report.screenshots.push({ file, ...evidence });
}

async function pin(current, point, distance = 19, side = 1) {
  await current.evaluate(async ({ point, distance, side }) => {
    const w = littleworld, { heightAt } = await import(new URL('./src/world.js', location.href).href);
    const y = heightAt(point.x, point.z, w.state.seed);
    w.actions.follow(null);
    w.camera.position.set(point.x + distance * .7 * side, y + distance * .8, point.z + distance * side);
    w.controls.target.set(point.x, y + .6, point.z); w.controls.update();
  }, { point, distance, side });
  await settle(current);
}

// The current application raycasts actual crowd instances. Project each body's
// instance matrix, then require the same first-hit ID as the real pointer code.
// Group centers and retired broad army proxies are not selection evidence.
async function exposedBodies(current, requestedIds, requireInstance = true) {
  return current.evaluate(async ({ requestedIds, requireInstance }) => {
    const THREE = await import('three'), w = littleworld, wanted = new Set(requestedIds);
    const crowds = w.renderers.crowds, all = [...w.renderers.buildings.getPickables(), ...crowds.getPickables()];
    const ray = new THREE.Raycaster(), matrix = new THREE.Matrix4(), hits = [];
    const canvas = w.renderer.domElement, rect = canvas.getBoundingClientRect();
    for (const mesh of crowds.getPickables()) {
      if (!mesh.isInstancedMesh || !mesh.visible || !mesh.userData.crowdSelectionIds) continue;
      for (let index = 0; index < mesh.count; index++) {
        const id = mesh.userData.crowdSelectionIds[index]; if (!wanted.has(id)) continue;
        mesh.getMatrixAt(index, matrix);
        for (const height of [.45, .65, .25, .85]) {
          const point = new THREE.Vector3(0, height, 0).applyMatrix4(matrix).applyMatrix4(mesh.matrixWorld).project(w.camera);
          const x = rect.left + (point.x * .5 + .5) * rect.width, y = rect.top + (-point.y * .5 + .5) * rect.height;
          if (point.z < -1 || point.z > 1 || x < 8 || x >= innerWidth - 8 || y < 8 || y >= innerHeight - 8 || document.elementFromPoint(x, y) !== canvas) continue;
          ray.setFromCamera(new THREE.Vector2(point.x, point.y), w.camera);
          const hit = ray.intersectObjects(all, true)[0];
          const frontId = hit && (crowds.resolvePick(hit) || w.renderers.buildings.resolvePick?.(hit) || hit.object.userData.buildingId || hit.object.userData.groupId || hit.object.userData.settlementId);
          if (frontId === id && (!requireInstance || hit.object.isInstancedMesh)) {
            hits.push({ id, x, y, meshUuid: mesh.uuid, instanceIndex: index, frontMeshUuid: hit.object.uuid, frontInstanceIndex: hit.instanceId,
              frontIsInstancedMesh: Boolean(hit.object.isInstancedMesh),
              matrix: Array.from(matrix.elements), geometry: { vertices: mesh.geometry.attributes.position.count, indices: mesh.geometry.index?.count || 0 } });
            break;
          }
        }
      }
    }
    return hits;
  }, { requestedIds, requireInstance });
}

async function pickSoldier(current, candidates, { touch = false, focalPoint = null } = {}) {
  let points = await exposedBodies(current, candidates.map(person => person.id));
  for (const candidate of candidates.slice(0, 8)) {
    if (!points.length) for (const side of [1, -1]) {
      await pin(current, focalPoint || candidate, touch ? 12 : 17, side);
      points = await exposedBodies(current, candidates.map(person => person.id));
      if (points.length) break;
    }
    const point = points.find(point => point.id === candidate.id) || points[0];
    if (!point) continue;
    if (touch) await current.touchscreen.tap(point.x, point.y); else await current.mouse.click(point.x, point.y);
    await settle(current);
    const selected = await current.evaluate(inspectWorld);
    if (selected.selectedId !== point.id) { points = points.filter(candidate => candidate.id !== point.id); continue; }
    assert.equal(await current.locator('.soldier-detail').count(), 1);
    assert.ok(selected.inspector.includes(point.id));
    assert.match(selected.inspector, /Health/); assert.match(selected.inspector, /Weapon/);
    const sample = await current.evaluate(id => littleworld.getMotionSamples().find(person => person.soldierId === id), point.id);
    assert.ok(sample?.visible, 'Selected real soldier has no visible model sample');
    assert.equal(sample.representedCount, 1); assert.equal(sample.badgeText, null);
    return { point, selected: selected.selected, inspector: selected.inspector, sample };
  }
  throw new Error('No exposed persistent soldier instance could be selected through the actual canvas');
}

async function recordNaturalBattle(current) {
  // The recording owns no simulation loop: only the app requestAnimationFrame
  // advances its normal 1x clock. Observers read snapshots at most 10 times/sec.
  const result = await current.evaluate(async durationMs => {
    const w = littleworld, stream = w.renderer.domElement.captureStream(30), chunks = [], frames = [], events = new Map();
    const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error('No WebM MediaRecorder format is supported');
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6000000 });
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    const stopped = new Promise((resolve, reject) => { recorder.onstop = resolve; recorder.onerror = reject; });
    const initialIds = new Set((w.state.combatEvents || []).map(event => event.id));
    const tracked = new Set(w.state.settlements.flatMap(home => home.soldierRoster || []).filter(person => person.status === 'serving' && (person.id === w.view.selectedId || Math.hypot(person.x - w.controls.target.x, person.z - w.controls.target.z) < 24)).map(person => person.id));
    const body = person => ({ id: person.id, groupId: person.groupId, status: person.status, hp: person.hp, maxHp: person.maxHp,
      attackReadyAt: person.attackReadyAt, cooldown: person.cooldown, targetId: person.targetId, action: person.action,
      reasonCode: person.reasonCode, x: person.x, z: person.z, prevX: person.prevX, prevZ: person.prevZ });
    const snapshot = () => ({ tick: w.state.tick, step: w.state.step, time: w.state.time, stats: { ...w.state.stats },
      population: w.state.settlements.reduce((sum, home) => sum + home.population, 0),
      soldiers: w.state.settlements.flatMap(home => home.soldierRoster || []).map(body) });
    const start = snapshot(), began = performance.now(); let request, lastSample = -Infinity, active = true;
    const sample = () => {
      const now = performance.now(), s = w.state;
      if (now - lastSample >= 95) {
        lastSample = now;
        const people = s.settlements.flatMap(home => home.soldierRoster || []);
        frames.push({ wallMs: now - began, tick: s.tick, step: s.step, time: s.time, speed: w.view.speed, paused: w.view.paused,
          selectedId: w.view.selectedId, renderedFrame: w.renderer.info.render.frame,
          soldiers: people.filter(person => tracked.has(person.id)).map(body),
          selectedModel: w.getMotionSamples().find(person => person.soldierId === w.view.selectedId) || null,
          calls: w.renderer.info.render.calls, triangles: w.renderer.info.render.triangles });
        for (const event of s.combatEvents || []) if (!initialIds.has(event.id)) events.set(event.id, { ...event });
      }
      if (active) request = requestAnimationFrame(sample);
    };
    recorder.start(500); w.actions.setSpeed(1); request = requestAnimationFrame(sample);
    await new Promise(resolve => setTimeout(resolve, durationMs));
    active = false; cancelAnimationFrame(request);
    const wallMs = performance.now() - began, end = snapshot();
    if (!w.view.paused) w.actions.togglePause();
    recorder.stop(); await stopped; stream.getTracks().forEach(track => track.stop());
    const blob = new Blob(chunks, { type: mimeType });
    const data = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.readAsDataURL(blob); });
    return { data, bytes: blob.size, mimeType, wallMs, start, end, frames, events: [...events.values()], trackedIds: [...tracked] };
  }, captureMs);
  const file = 'natural-individual-battle-1x.webm';
  await writeFile(output(config, file), Buffer.from(result.data, 'base64')); delete result.data;
  result.simulatedSeconds = result.end.time - result.start.time;
  result.simulatedSecondsPerWallSecond = result.simulatedSeconds / (result.wallMs / 1000);
  result.playback = 'Original canvas MediaRecorder output; normal app speed 1x; no postprocessing, retiming, entity injection, or bulk stepping during recording.';
  report.videos.push({ file, ...result });
  assert.ok(result.bytes > 10000); assert.ok(result.wallMs >= captureMs - 250);
  assert.ok(result.frames.length >= 10); assert.ok(result.frames.every(frame => frame.speed === 1 && !frame.paused));
  assert.ok(result.simulatedSeconds > 0, 'The normal clock did not advance during capture');
  assert.ok(result.events.some(event => event.sourceSoldierId && ['projectile', 'melee', 'impact'].includes(event.type)), 'No identity-linked combat occurred during the natural capture');
  return { file, wallMs: result.wallMs, simulatedSeconds: result.simulatedSeconds, frames: result.frames.length,
    exactCombatEvents: result.events.filter(event => event.sourceSoldierId && event.targetSoldierId).length,
    deaths: result.end.stats.deaths - result.start.stats.deaths };
}

async function touchEvidence(viewport) {
  const context = await browser.newContext(touchContextOptions(viewport));
  const current = await context.newPage(); current.setDefaultTimeout(20000); observeErrors(current, report);
  try {
    await boot(current, config);
    await current.evaluate(({ seed, civs }) => { littleworld.reset(seed, { civCount: civs }); littleworld.actions.setPerspective('omniscient'); }, { seed: config.seed, civs: config.civCount });
    await settle(current);
    const layout = await current.evaluate(() => ({ coarse: matchMedia('(pointer: coarse)').matches, touchPoints: navigator.maxTouchPoints,
      width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth, documentHeight: document.documentElement.scrollHeight,
      canvasTouchAction: getComputedStyle(littleworld.renderer.domElement).touchAction }));
    assert.ok(layout.coarse && layout.touchPoints > 0); assert.equal(layout.canvasTouchAction, 'none');
    assert.equal(layout.documentWidth, viewport.width); assert.equal(layout.documentHeight, viewport.height);
    await button(current, 'speed', 1).tap();
    const startStep = await current.evaluate(() => littleworld.state.step);
    await current.waitForFunction(step => littleworld.state.step > step, startStep);
    await button(current, 'pause').tap(); await settle(current);
    const pausedStep = await current.evaluate(() => littleworld.state.step); await settle(current);
    assert.equal(await current.evaluate(() => littleworld.state.step), pausedStep);
    // Recreate the same naturally evolved seed through the public application
    // reset/advance API, rather than injecting the desktop world's state.
    await current.evaluate(async ({ seed, civs, cycles }) => { littleworld.reset(seed, { civCount: civs }); await littleworld.advance(cycles); }, { seed: config.seed, civs: config.civCount, cycles: battle.tick });
    await settle(current);
    const world = await current.evaluate(inspectWorld), point = battle.focalPoint;
    await pin(current, point, 12);
    const candidates = world.soldiers.filter(person => Math.hypot(person.x - point.x, person.z - point.z) < 22).sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp);
    const picked = await pickSoldier(current, candidates, { touch: true, focalPoint: point });
    assert.equal(await button(current, 'mobile-panel', 'inspector').getAttribute('aria-pressed'), 'true');
    const panel = await current.locator('.inspector').boundingBox();
    assert.ok(panel && panel.x >= 0 && panel.y >= 0 && panel.x + panel.width <= viewport.width + 1 && panel.y + panel.height <= viewport.height + 1);
    await screenshot(current, `mobile-${viewport.name}-soldier`);
    const navigation = current.locator('.soldier-detail [data-action="select"]').first();
    assert.ok(await navigation.count(), 'Selected soldier has no party/home navigation');
    const client = await context.newCDPSession(current);
    const scrollBody = current.locator('.selection-body'), scrollBox = await scrollBody.boundingBox();
    assert.ok(scrollBox && scrollBox.height > 25, 'Touch inspector has no usable scroll area');
    const beforeScroll = await current.evaluate(() => ({ camera: littleworld.camera.position.toArray(), target: littleworld.controls.target.toArray(), scroll: [scrollX, scrollY] }));
    const dispatch = (type, points) => client.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((point, index) => ({ id: index + 1, ...point, radiusX: 5, radiusY: 5, force: 1 })) });
    const scrollMetrics = await scrollBody.evaluate(element => ({ height: element.clientHeight, contentHeight: element.scrollHeight }));
    // Short landscape panels need more gestures to traverse the same details.
    // Keep real native swipes and the final visibility assertion; size the
    // gesture budget from the content instead of assuming six is sufficient.
    const maximumSwipes = Math.ceil(scrollMetrics.contentHeight / (scrollMetrics.height * .35)) + 2;
    let swipes = 0;
    for (; swipes < maximumSwipes; swipes++) {
      const navBox = await navigation.boundingBox();
      if (navBox && navBox.y >= scrollBox.y && navBox.y + navBox.height <= scrollBox.y + scrollBox.height) break;
      const x = scrollBox.x + scrollBox.width * .55, from = scrollBox.y + scrollBox.height * .8, to = scrollBox.y + scrollBox.height * .2;
      await dispatch('touchStart', [{ x, y: from }]);
      for (let index = 1; index <= 8; index++) await dispatch('touchMove', [{ x, y: from + (to - from) * index / 8 }]);
      await dispatch('touchEnd', []); await settle(current);
    }
    await client.detach();
    const navBox = await navigation.boundingBox();
    assert.ok(navBox && navBox.y >= scrollBox.y - 1 && navBox.y + navBox.height <= scrollBox.y + scrollBox.height + 1, 'Soldier navigation remained outside the touch scroll area');
    const afterScroll = await current.evaluate(() => ({ camera: littleworld.camera.position.toArray(), target: littleworld.controls.target.toArray(), scroll: [scrollX, scrollY] }));
    assert.deepEqual(afterScroll.scroll, [0, 0]);
    assert.ok(Math.hypot(...afterScroll.camera.map((value, index) => value - beforeScroll.camera[index])) < .001, 'Inspector swipe moved the world camera');
    const navigationId = await navigation.getAttribute('data-value');
    await screenshot(current, `mobile-${viewport.name}-navigation`);
    await navigation.tap(); await settle(current);
    assert.equal(await current.evaluate(() => littleworld.view.selectedId), navigationId);
    await current.locator('.inspector [data-action="close-mobile-panel"]').tap();
    await button(current, 'mobile-panel', 'views').tap();
    await button(current, 'overlay', 'routes').tap();
    assert.equal(await current.evaluate(() => littleworld.view.overlay), 'routes');
    await button(current, 'overview').tap(); await settle(current);
    await screenshot(current, `mobile-${viewport.name}-controls`);
    const evidence = { viewport, layout, touchClock: { startStep, pausedStep }, picked, panel, navigationId, nativeInspectorSwipes: swipes, maximumSwipes, scrollMetrics, beforeScroll, afterScroll };
    report.mobile.push(evidence); return evidence;
  } finally { await context.close(); }
}

await mkdir(config.outputDir, { recursive: true });
report.sourceSha256 = await sourceHash();
try {
  browser = await launch(config);
  if (touchOnly) {
    const prior = JSON.parse(await readFile(output(config, 'initial-world-individual-browser-report.json'), 'utf8'));
    assert.equal(prior.sourceSha256, report.sourceSha256, 'Focused touch recovery requires identical application source');
    assert.equal(prior.finalSourceSha256, report.sourceSha256);
    assert.deepEqual(prior.errors, []);
    assert.ok(prior.battle && prior.videos.length && prior.checks.slice(0, 5).every(check => check.passed));
    report.priorAttempt = { startedAt: prior.startedAt, completedAt: prior.completedAt, status: prior.status, failure: prior.failure,
      report: 'initial-world-individual-browser-report.json', reusedUnchangedApplicationEvidence: true };
    for (const key of ['environment', 'battle', 'afterCapture', 'preparation', 'screenshots', 'videos', 'mobile']) report[key] = prior[key];
    report.checks = prior.checks.filter(check => check.passed);
    battle = prior.battle;
  } else {
  page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(30000); observeErrors(page, report);
  await boot(page, config); report.environment = await environment(page, browser, config);
  report.environment.renderingLabel = config.software || /swiftshader|llvmpipe|software/i.test(report.environment.gpu) ? 'Software rendering; wall-clock evidence only' : 'Runner GPU rendering; no cross-device performance claim';
  await page.evaluate(({ seed, civs }) => { littleworld.reset(seed, { civCount: civs }); littleworld.actions.setPerspective('omniscient'); littleworld.step(40); }, { seed: config.seed, civs: config.civCount });
  await settle(page);
  await check('Natural worker crews retain counted badges and exact population accounting', async () => {
    const workers = await page.evaluate(() => littleworld.state.groups.filter(group => group.kind === 'worker' && group.size > 1).map(group => ({ id: group.id, x: group.x, z: group.z, size: group.size })));
    assert.ok(workers.length);
    let found;
    for (const worker of workers.slice(0, 12)) {
      await pin(page, worker, 14);
      const points = await exposedBodies(page, [worker.id], false); if (!points.length) continue;
      await page.mouse.click(points[0].x, points[0].y); await settle(page);
      if (await page.evaluate(id => littleworld.view.selectedId === id, worker.id)) { found = { worker, point: points[0] }; break; }
    }
    assert.ok(found, 'No exposed real worker crew could be selected');
    const evidence = await page.evaluate(id => ({ samples: littleworld.getMotionSamples().filter(person => person.groupId === id), diagnostics: littleworld.diagnostics, inspector: document.querySelector('.inspector').innerText }), found.worker.id);
    const worker = evidence.samples.find(person => person.kind === 'worker');
    assert.ok(worker?.visible); assert.equal(worker.representedCount, found.worker.size); assert.equal(worker.badgeText, `${found.worker.size}×`);
    assert.equal(evidence.diagnostics.crowds.populationAccountingDelta, 0);
    assert.equal(evidence.diagnostics.representedIndividuals, evidence.diagnostics.totalPopulation);
    await screenshot(page, 'natural-worker-counted-badge');
    return { ...found, ...evidence };
  });
  await check('A natural battle produces orders between persistent soldier identities', async () => {
    while (await page.evaluate(() => littleworld.state.tick) < maximumCycle) {
      await page.evaluate(() => littleworld.step(5));
      const sample = await page.evaluate(inspectWorld);
      report.preparation.push({ tick: sample.tick, time: sample.time, liveSoldiers: sample.liveSoldiers, armySizes: sample.armies.map(group => ({ id: group.id, size: group.size, phase: group.phase })), hit: sample.hit, stats: sample.stats });
      if (sample.hit?.shot && sample.soldiers.some(person => person.id === sample.hit.sourceSoldierId) && sample.soldiers.some(person => person.id === sample.hit.targetSoldierId)) {
        const { from, to } = sample.hit.shot;
        battle = { ...sample, focalPoint: { x: (from.x + to.x) / 2, z: (from.z + to.z) / 2 } }; break;
      }
      if (sample.tick % 50 === 0) { console.log(`Natural preparation cycle ${sample.tick}`); await save(config, 'world-individual-browser-report.json', report); }
    }
    assert.ok(battle, `No natural exact-ID battle found by cycle ${maximumCycle}; no replacement fixture was injected`);
    assert.equal(battle.liveSoldiers, battle.militaryTotal);
    report.battle = battle;
    return { tick: battle.tick, hit: battle.hit, liveSoldiers: battle.liveSoldiers, armies: battle.armies };
  });
  await pin(page, battle.focalPoint, 20);
  const candidates = battle.soldiers.filter(person => Math.hypot(person.x - battle.focalPoint.x, person.z - battle.focalPoint.z) < 20)
    .sort((a, b) => Number(b.id === battle.hit.targetSoldierId) - Number(a.id === battle.hit.targetSoldierId) || a.hp / a.maxHp - b.hp / b.maxHp);
  await check('Actual soldier body click shows its identity, health, and weapon clock', () => pickSoldier(page, candidates, { focalPoint: battle.focalPoint }));
  await screenshot(page, 'natural-battle-opening-selected-soldier');
  await check('Eighteen wall seconds of normal 1x battle capture', () => recordNaturalBattle(page));
  await screenshot(page, 'natural-battle-capture-end');
  const after = await page.evaluate(inspectWorld);
  report.afterCapture = after;
  if (after.selected?.status === 'dead') await screenshot(page, 'natural-selected-fallen-soldier');
  else if (after.selected && after.selected.hp < after.selected.maxHp) await screenshot(page, 'natural-selected-wounded-soldier');
  else {
    const wounded = after.soldiers.filter(person => person.hp < person.maxHp && Math.hypot(person.x - battle.focalPoint.x, person.z - battle.focalPoint.z) < 25);
    if (wounded.length) {
      report.naturalWoundPick = await pickSoldier(page, wounded, { focalPoint: battle.focalPoint });
      await screenshot(page, 'natural-wounded-soldier-inspection');
    } else report.optionalWoundScreenshot = 'No exposed surviving wound or selected death arose naturally during this capture.';
  }
  await check('Post-capture soldier, worker, and population counts agree', async () => {
    assert.equal(after.liveSoldiers, after.militaryTotal);
    assert.equal(after.diagnostics.crowds.populationAccountingDelta, 0);
    assert.equal(after.diagnostics.crowds.militaryIndividuals, after.liveSoldiers);
    assert.equal(after.diagnostics.crowds.unpositionedSoldiers, 0);
    return { liveSoldiers: after.liveSoldiers, diagnostics: after.diagnostics };
  });
  await page.close(); page = null;
  }
  for (const viewport of TOUCH_VIEWPORTS.filter(viewport => !touchOnly || viewport.name === touchOnly)) await check(`Native touch ${viewport.width}×${viewport.height}: soldier inspection and controls`, () => touchEvidence(viewport));
  for (const viewport of TOUCH_VIEWPORTS) assert.ok(report.checks.some(check => check.passed && check.name === `Native touch ${viewport.width}×${viewport.height}: soldier inspection and controls`), `Missing passing touch evidence for ${viewport.name}`);
  assert.deepEqual(report.errors, []);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = error.stack; process.exitCode = 1;
  if (page) try { await screenshot(page, 'world-individual-failure'); } catch {}
} finally {
  report.finalSourceSha256 = await sourceHash();
  report.sourceUnchanged = report.sourceSha256 === report.finalSourceSha256;
  if (!report.sourceUnchanged) { report.status = 'failed'; report.sourceFailure = 'Application source changed during evidence capture'; process.exitCode = 1; }
  await browser?.close(); report.completedAt = new Date().toISOString();
  await save(config, 'world-individual-browser-report.json', report);
}
console.log(JSON.stringify({ status: report.status, sourceUnchanged: report.sourceUnchanged, checks: report.checks.length,
  screenshots: report.screenshots.length, videos: report.videos.length, failure: report.failure, report: output(config, 'world-individual-browser-report.json') }));
