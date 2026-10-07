// Actual observer interaction and natural battle evidence; no injected entities.
import assert from 'node:assert/strict';
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { configuration, launch, boot, environment, observeErrors, waitForRenderedFrames, output, save } from './browser-v2.mjs';
import { combatTargetScenarios } from './combat-target-browser-scenarios.mjs';

const baseline = process.env.QA_BASELINE === '1';
const config = configuration({ ...process.env, QA_OUTPUT_DIR: process.env.QA_OUTPUT_DIR || 'screenshots/interaction-campaign' });
const report = { baseline, startedAt: new Date().toISOString(), scope: 'Real canvas/menu clicks and natural seeded simulation. No entity, resource, ownership or RNG edits. Software rendering timings are not hardware performance.', errors: [], warnings: [], checks: [], screenshots: [], videos: [], timeline: [] };
async function sourceHash() { const hash = createHash('sha256'); for (const name of (await readdir('src', { recursive: true })).filter(n => /\.(js|css)$/.test(n)).sort()) hash.update(name).update('\0').update(await readFile(`src/${name}`)); return hash.digest('hex'); }
if (!baseline) report.sourceSha256 = await sourceHash();
report.sourceCommit = process.env.QA_SOURCE_SHA || process.env.GITHUB_SHA || null;
await mkdir(config.outputDir, { recursive: true });
const browser = await launch(config), page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(30000); observeErrors(page, report);
const settle = () => waitForRenderedFrames(page, { minimumFrames: 3 });
const observe = () => page.evaluate(() => ({ tick: littleworld.state.tick, perspective: littleworld.view.perspective, selectedId: littleworld.view.selectedId, camera: littleworld.camera.position.toArray(), target: littleworld.controls.target.toArray(), inspector: document.querySelector('.inspector').innerText }));
async function shot(name) { const file = `${baseline ? 'before' : 'after'}-${name}.png`; await page.screenshot({ path: output(config, file) }); report.screenshots.push({ file, ...await observe() }); }
async function pin(x, z, distance = 24, side = 1) {
  await page.evaluate(async ({ x, z, distance, side }) => {
    const w = littleworld, { heightAt } = await import(new URL('./src/world.js', location.href).href), y = heightAt(x, z, w.state.seed);
    w.actions.follow(null); w.camera.position.set(x + distance * .75 * side, y + distance * .8, z + distance * side); w.controls.target.set(x, y + 1, z); w.controls.update();
  }, { x, z, distance, side }); await settle();
}
async function projectedPick(kind) {
  return page.evaluate(async kind => {
    const THREE = await import('three');
    const w = littleworld, proxies = kind === 'building' ? w.renderers.buildings.getPickables() : w.renderers.crowds.getPickables();
    const ray = new THREE.Raycaster(), all = [...w.renderers.buildings.getPickables(), ...w.renderers.crowds.getPickables()];
    return proxies.map(o => { const p = o.position.clone().setFromMatrixPosition(o.matrixWorld).project(w.camera); const x = (p.x * .5 + .5) * innerWidth, y = (-p.y * .5 + .5) * innerHeight;
      ray.setFromCamera(new THREE.Vector2(p.x, p.y), w.camera); const hit = ray.intersectObjects(all, true)[0];
      const frontId = hit && (w.renderers.crowds.resolvePick?.(hit) || hit.object.userData.buildingId || hit.object.userData.groupId || hit.object.userData.settlementId);
      return { id: o.userData.buildingId || o.userData.groupId, frontId, homeId: o.userData.settlementId, x, y, clear: document.elementFromPoint(x, y)?.tagName === 'CANVAS', depth: p.z };
    }).filter(p => p.id && p.id === p.frontId && p.clear && p.depth < 1 && p.x > 240 && p.x < 1260 && p.y > 150 && p.y < 850);
  }, kind);
}
async function recordBattle() {
  const result = await page.evaluate(async () => {
    const w = littleworld, stream = w.renderer.domElement.captureStream(30), chunks = [], frames = [];
    const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t));
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6000000 });
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    const done = new Promise((resolve, reject) => { recorder.onstop = resolve; recorder.onerror = reject; });
    const start = { tick: w.state.tick, time: w.state.time, stats: { ...w.state.stats } }, began = performance.now(); let request, stopped = false;
    const sample = () => { frames.push({ ms: performance.now() - began, tick: w.state.tick, speed: w.view.speed, paused: w.view.paused, engagements: w.state.groups.filter(g => g.combat?.active).map(g => ({ id: g.id, factionId: g.commandFactionId || g.factionId, targetId: g.combat.targetId, localTargetIds: g.combat.localTargetIds, roleAttacks: g.combat.roleAttacks })) }); if (!stopped) request = requestAnimationFrame(sample); };
    recorder.start(500); w.actions.setSpeed(1); request = requestAnimationFrame(sample);
    await new Promise(resolve => setTimeout(resolve, 12000)); stopped = true; cancelAnimationFrame(request);
    const wallMs = performance.now() - began, end = { tick: w.state.tick, time: w.state.time, stats: { ...w.state.stats } };
    if (!w.view.paused) w.actions.togglePause(); recorder.stop(); await done; stream.getTracks().forEach(t => t.stop());
    const blob = new Blob(chunks, { type: mimeType });
    const data = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.readAsDataURL(blob); });
    return { data, bytes: blob.size, mimeType, wallMs, start, end, frames };
  });
  assert.ok(result.end.time > result.start.time); assert.ok(result.frames.every(f => f.speed === 1 && !f.paused));
  const file = `${baseline ? 'before' : 'after'}-natural-battle-1x.webm`;
  await writeFile(output(config, file), Buffer.from(result.data, 'base64')); delete result.data;
  report.videos.push({ file, playback: 'Actual normal 1x canvas capture; no retiming', ...result });
}
try {
  await boot(page, config); report.environment = await environment(page, browser, config);
  if (!baseline) report.controlledCombat = await page.evaluate(async source => {
    const scenarios = (0, eval)(`(${source})`), moduleRoot = new URL('./src/', location.href).href;
    return scenarios({ moduleRoot });
  }, combatTargetScenarios.toString());
  const initial = await page.evaluate(() => JSON.stringify(littleworld.state));
  const before = await observe(); await page.locator('.faction-entry').nth(1).click(); await settle();
  const factionClick = { before, after: await observe(), expectedFaction: 'f1' };
  assert.equal(await page.evaluate(() => JSON.stringify(littleworld.state)), initial, 'Observer click mutated simulation');
  if (!baseline) {
    assert.equal(factionClick.after.perspective, 'f1');
    await page.waitForFunction(() => { const w = littleworld, h = w.shownState.settlements.find(h => h.id === w.view.selectedId); return h && Math.hypot(w.controls.target.x - h.x, w.controls.target.z - h.z) < 1; });
    factionClick.after = await observe();
    assert.equal(await page.locator('.faction-entry').count(), config.civCount, 'Faction menu lost observer choices under fog');
  }
  report.checks.push({ name: 'Civilisation click focuses camera and selects its fog perspective', observed: factionClick });
  await shot('faction-click');
  await page.evaluate(() => { littleworld.actions.setPerspective('omniscient'); littleworld.actions.follow(null); littleworld.step(100); });
  const home = await page.evaluate(() => { const h = littleworld.state.settlements[0]; return { x: h.x, z: h.z }; }); await pin(home.x, home.z, 22);
  const buildingPoints = await projectedPick('building'); assert.ok(buildingPoints.length, 'No exposed building to click');
  let building;
  for (const p of buildingPoints.slice(0, 10)) { await page.mouse.click(p.x, p.y); await settle(); const selected = await observe(); if (baseline || selected.selectedId === p.id) { building = { intended: p, observed: selected }; break; } }
  assert.ok(building, 'Actual building canvas clicks did not select a building');
  if (!baseline) { assert.equal(building.observed.selectedId, building.intended.id); assert.match(building.observed.inspector, /condition|integrity|health|construction/i); }
  report.checks.push({ name: 'Building canvas selection resolves actual building details', observed: building }); await shot('building-inspection');
  // A screen projection can be behind a nearer building. Find an actually
  // exposed natural crew before testing its real click; never move entities.
  const workers = await page.evaluate(() => littleworld.state.groups.filter(g => g.kind === 'worker' && g.size > 0).sort((a, b) => Number(b.phase === 'working') - Number(a.phase === 'working')).slice(0, 12).map(g => ({ id: g.id, x: g.x, z: g.z, size: g.size })));
  let group, target;
  for (const candidate of workers) {
    for (const side of [1, -1]) { await pin(candidate.x, candidate.z, 15, side); target = (await projectedPick('group')).find(p => p.id === candidate.id); if (target) break; }
    if (target) { group = candidate; break; }
  }
  assert.ok(target, 'No exposed natural worker could be prepared for an actual canvas click');
  await page.mouse.click(target.x, target.y); await settle(); const worker = await observe(); assert.equal(worker.selectedId, group.id); assert.match(worker.inspector, /worker|crew|cargo/i);
  report.checks.push({ name: 'Unit canvas selection exposes real group details', observed: { group, worker } }); await shot('unit-inspection');
  await page.evaluate(() => { littleworld.reset('first-light', { civCount: 4 }); littleworld.actions.setPerspective('omniscient'); });
  let battle = null;
  for (let cycle = 5; cycle <= 450; cycle += 5) {
    const sample = await page.evaluate(() => {
      const w = littleworld; w.step(5); const s = w.state, armies = s.groups.filter(g => g.kind === 'army');
      const engagements = armies.filter(g => g.combat?.active).map(g => ({ id: g.id, factionId: g.commandFactionId || g.factionId, target: g.combat.targetId, localTargetIds: g.combat.localTargetIds, x: g.x, z: g.z }));
      const hit = [...(s.combatEvents || [])].reverse().find(e => ['projectile', 'melee'].includes(e.type) && e.shots?.length);
      return { tick: s.tick, armies: armies.map(g => ({ id: g.id, factionId: g.commandFactionId || g.factionId, size: g.size, target: g.targetId, phase: g.phase })), engagements, hit: hit ? { sourceId: hit.sourceId, targetId: hit.targetId, shot: hit.shots[0] } : null };
    });
    report.timeline.push(sample);
    if (sample.hit && sample.engagements.length >= 2) { battle = sample; break; }
  }
  assert.ok(battle, 'No natural battle with simultaneous engaging armies found within 450 cycles');
  const { from, to } = battle.hit.shot; await pin((from.x + to.x) / 2, (from.z + to.z) / 2, 22);
  if (!baseline) {
    const armyIds = new Set(battle.armies.map(g => g.id)); let inspectedArmy = null;
    for (const point of (await projectedPick('group')).filter(p => armyIds.has(p.id))) {
      await page.mouse.click(point.x, point.y); await settle(); const selected = await observe();
      if (armyIds.has(selected.selectedId)) { inspectedArmy = selected; break; }
    }
    assert.ok(inspectedArmy, 'No visible natural army could be inspected by an actual canvas click');
    assert.match(inspectedArmy.inspector, /infantry|ranged|soldier/i);
    assert.match(inspectedArmy.inspector, /controlled by|native identity/i);
    report.checks.push({ name: 'Natural army canvas click exposes its force and command identity', observed: inspectedArmy });
  }
  report.checks.push({ name: 'Natural simultaneous combat observed', observed: battle }); await shot('natural-battle'); await recordBattle(); await shot('natural-battle-end');
  assert.deepEqual(report.errors, []);
  if (!baseline) { report.finalSourceSha256 = await sourceHash(); assert.equal(report.finalSourceSha256, report.sourceSha256, 'Application source changed during browser evidence'); }
  report.status = baseline ? 'baseline-observed' : 'passed';
} catch (error) { report.status = 'failed'; report.failure = error.stack; process.exitCode = 1; try { await shot('failure'); } catch {} }
finally { report.completedAt = new Date().toISOString(); await save(config, 'interaction-campaign-report.json', report); await browser.close(); }
console.log(JSON.stringify({ status: report.status, report: output(config, 'interaction-campaign-report.json'), checks: report.checks.length, failure: report.failure }));
