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
    const w = littleworld, { heightAt } = await import(new URL('./src/world.js', location.href).href), y = heightAt(x, z, w.state.terrainSeed || w.state.seed);
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
// Persistent soldiers are selected from their actual visible mesh instances.
// Use the same first-hit geometry as the pointer code; an army centre or broad
// party proxy cannot stand in for a selectable individual body.
async function exposedArmyBodies(armyIds) {
  return page.evaluate(async armyIds => {
    const THREE = await import('three'), w = littleworld, armies = new Set(armyIds);
    const wanted = new Map(w.state.settlements.flatMap(home => home.soldierRoster || [])
      .filter(person => person.status === 'serving' && person.alive && person.hp > 0 && armies.has(person.groupId))
      .map(person => [person.id, person.groupId]));
    const crowds = w.renderers.crowds, all = [...w.renderers.buildings.getPickables(), ...crowds.getPickables()];
    const ray = new THREE.Raycaster(), matrix = new THREE.Matrix4(), points = [];
    const canvas = w.renderer.domElement, rect = canvas.getBoundingClientRect();
    for (const mesh of crowds.getPickables()) {
      if (!mesh.isInstancedMesh || !mesh.visible || !mesh.userData.crowdSelectionIds) continue;
      for (let index = 0; index < mesh.count; index++) {
        const id = mesh.userData.crowdSelectionIds[index]; if (!wanted.has(id)) continue;
        mesh.getMatrixAt(index, matrix);
        for (const height of [.45, .65, .25, .85]) {
          const p = new THREE.Vector3(0, height, 0).applyMatrix4(matrix).applyMatrix4(mesh.matrixWorld).project(w.camera);
          const x = rect.left + (p.x * .5 + .5) * rect.width, y = rect.top + (-p.y * .5 + .5) * rect.height;
          if (p.z < -1 || p.z > 1 || x < 8 || x >= innerWidth - 8 || y < 8 || y >= innerHeight - 8 || document.elementFromPoint(x, y) !== canvas) continue;
          ray.setFromCamera(new THREE.Vector2(p.x, p.y), w.camera);
          const hit = ray.intersectObjects(all, true)[0];
          const frontId = hit && (crowds.resolvePick(hit) || w.renderers.buildings.resolvePick?.(hit) || hit.object.userData.buildingId || hit.object.userData.groupId || hit.object.userData.settlementId);
          if (frontId !== id || !hit.object.isInstancedMesh) continue;
          points.push({ id, groupId: wanted.get(id), x, y, meshUuid: mesh.uuid, instanceIndex: index,
            frontId, frontMeshUuid: hit.object.uuid, frontInstanceIndex: hit.instanceId, frontIsInstancedMesh: true, matrix: Array.from(matrix.elements) });
          break;
        }
      }
    }
    return points;
  }, armyIds);
}

async function inspectArmyThroughSoldier(armyIds) {
  let points = await exposedArmyBodies(armyIds);
  if (!points.length) {
    const candidates = await page.evaluate(ids => {
      const w = littleworld, armies = new Set(ids), center = w.controls.target;
      return w.state.settlements.flatMap(home => home.soldierRoster || [])
        .filter(person => person.status === 'serving' && person.alive && person.hp > 0 && armies.has(person.groupId))
        .sort((a, b) => Math.hypot(a.x - center.x, a.z - center.z) - Math.hypot(b.x - center.x, b.z - center.z))
        .slice(0, 8).map(person => ({ id: person.id, x: person.x, z: person.z }));
    }, armyIds);
    for (const candidate of candidates) {
      for (const side of [1, -1]) {
        await pin(candidate.x, candidate.z, 17, side); points = await exposedArmyBodies(armyIds);
        if (points.length) break;
      }
      if (points.length) break;
    }
  }
  assert.ok(points.length, 'No exposed natural soldier instance could be inspected by an actual canvas click');
  const point = points[0]; await page.mouse.click(point.x, point.y); await settle();
  const selected = await page.evaluate(async () => {
    const w = littleworld, s = w.state, { groupController } = await import(new URL('./src/sim/control.js', location.href).href);
    const body = s.settlements.flatMap(home => home.soldierRoster || []).find(person => person.id === w.view.selectedId);
    const group = body && s.groups.find(party => party.id === body.groupId), native = body && s.factions.find(f => f.id === (body.nativeFactionId || body.factionId));
    const controller = group && s.factions.find(f => f.id === groupController(s, group));
    const rows = Object.fromEntries([...document.querySelectorAll('.soldier-detail .identity-reading > div')]
      .map(row => [row.querySelector('dt').innerText, row.querySelector('dd').innerText]));
    return { selectedId: w.view.selectedId, body: body ? { id: body.id, groupId: body.groupId, nativeFactionId: body.nativeFactionId || body.factionId, role: body.role, species: body.species } : null,
      group: group ? { id: group.id, soldierIds: [...group.soldierIds], units: { ...group.units }, nativeFactionId: group.factionId, controllerId: groupController(s, group) } : null,
      nativeName: native?.name, controllerName: controller?.name, rows, inspector: document.querySelector('.inspector').innerText,
      sample: w.getMotionSamples().find(person => person.soldierId === w.view.selectedId) || null };
  });
  assert.equal(selected.selectedId, point.id, 'Canvas click selected a different soldier');
  assert.equal(selected.body?.id, point.id); assert.equal(selected.body.groupId, point.groupId);
  assert.equal(selected.group?.id, point.groupId); assert.ok(selected.group.soldierIds.includes(point.id));
  assert.equal(selected.body.nativeFactionId, selected.group.nativeFactionId);
  assert.equal(await page.locator('.soldier-detail').count(), 1);
  assert.equal(selected.rows.Identity, point.id); assert.equal(selected.rows['Controlled by'], selected.controllerName);
  assert.ok(selected.rows['Native identity']?.startsWith(`${selected.nativeName} · `));
  assert.match(selected.inspector, /Health/); assert.match(selected.inspector, /Weapon/);
  assert.ok(selected.sample?.visible, 'Selected soldier has no visible rendered model');
  assert.equal(selected.sample.representedCount, 1); assert.equal(selected.sample.badgeText, null);
  await shot('natural-soldier-inspection');
  const partyButton = page.locator('.soldier-detail button[data-action="select"]').filter({ hasText: 'Inspect army party' });
  assert.equal(await partyButton.count(), 1); assert.equal(await partyButton.getAttribute('data-value'), point.groupId);
  await partyButton.click(); await settle();
  const party = await page.evaluate(() => {
    const rows = Object.fromEntries([...document.querySelectorAll('.selection-body > .identity-reading > div')]
      .map(row => [row.querySelector('dt').innerText, row.querySelector('dd').innerText]));
    return { selectedId: littleworld.view.selectedId, rows, composition: document.querySelector('.party-detail .military-composition')?.innerText,
      inspector: document.querySelector('.inspector').innerText };
  });
  assert.equal(party.selectedId, point.groupId, 'The soldier inspector did not navigate to its exact army');
  assert.equal(await page.locator('.party-detail').count(), 1);
  assert.equal(party.rows['Controlled by'], selected.controllerName);
  assert.ok(party.rows['Native identity']?.startsWith(`${selected.nativeName} · `));
  assert.ok(party.composition?.includes(`${selected.group.units.infantry} infantry`));
  assert.ok(party.composition?.includes(`${selected.group.units.ranged} ranged`));
  return { point, selected, party };
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
    const inspected = await inspectArmyThroughSoldier(battle.armies.map(group => group.id));
    report.checks.push({ name: 'Natural soldier canvas click and inspector party button expose exact identity, army composition and command', observed: inspected });
  }
  report.checks.push({ name: 'Natural simultaneous combat observed', observed: battle }); await shot('natural-battle'); await recordBattle(); await shot('natural-battle-end');
  assert.deepEqual(report.errors, []);
  if (!baseline) { report.finalSourceSha256 = await sourceHash(); assert.equal(report.finalSourceSha256, report.sourceSha256, 'Application source changed during browser evidence'); }
  report.status = baseline ? 'baseline-observed' : 'passed';
} catch (error) { report.status = 'failed'; report.failure = error.stack; process.exitCode = 1; try { await shot('failure'); } catch {} }
finally { report.completedAt = new Date().toISOString(); await save(config, 'interaction-campaign-report.json', report); await browser.close(); }
console.log(JSON.stringify({ status: report.status, report: output(config, 'interaction-campaign-report.json'), checks: report.checks.length, failure: report.failure }));
