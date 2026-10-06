import assert from 'node:assert/strict';
import { mkdir, stat } from 'node:fs/promises';
import { configuration, launch, boot, environment, observeErrors, output, save, waitForRenderedFrames, sampleFrames, frameSummary, observeSelectedCrewReturn, selectedCrewEvidence, TOUCH_VIEWPORTS, touchContextOptions } from './browser-v2.mjs';

// Only the public deterministic harness operations reset()/advance()/step() and
// observer camera/actions are used. No showcase population, node or cargo edits.
const config = configuration();
const report = { at: new Date().toISOString(), tier: config.tier, quality: config.quality, url: config.url,
  scope: { developedCycle: config.lastCycle, actualPopulationUnmodified: true, videoRequested: config.video,
    omitted: config.tier === 'ci' ? ['Cycle 3000/high-quality late-world stress is the separate QA_TIER=full tier.'] : [] },
  errors: [], warnings: [], checks: [], states: {}, performance: {}, screenshots: [], pairs: {}, video: null };
let browser, page;
const persist = () => save(config, 'visual-report.json', report);
const button = (action, value) => page.locator(`[data-action="${action}"]${value === undefined ? '' : `[data-value="${value}"]`}`);
const settle = (ms = 500) => page.waitForTimeout(ms);
async function check(name, fn) {
  try { const details = await fn(); report.checks.push({ name, passed: true, details }); console.log(`PASS ${name}`); }
  catch (error) { report.checks.push({ name, passed: false, error: error.stack }); console.error(`FAIL ${name}: ${error.message}`); }
  await persist();
}
async function camera() { return page.evaluate(() => ({ position: littleworld.camera.position.toArray(), target: littleworld.controls.target.toArray(), fov: littleworld.camera.fov, viewport: { width: innerWidth, height: innerHeight } })); }
async function pin(spec, id) {
  await page.evaluate(({ spec, id }) => { const w = littleworld; w.actions.setCinematic(false); w.actions.follow(null); if (id) w.select(id); w.camera.position.fromArray(spec.position); w.controls.target.fromArray(spec.target); w.controls.update(); }, { spec, id });
  await waitForRenderedFrames(page);
}
async function pause() { if (!await page.evaluate(() => littleworld.view.paused)) await button('pause').click(); await settle(); }
async function shot(name) {
  const path = output(config, `visual-${name}.png`); await page.screenshot({ path });
  const evidence = { name, path, camera: await camera(), ...await page.evaluate(() => ({ seed: littleworld.state.seed, tick: littleworld.state.tick, step: littleworld.state.step, paused: littleworld.view.paused, quality: littleworld.view.quality, selection: littleworld.view.selectedId, diagnostics: littleworld.diagnostics })) };
  report.screenshots.push(evidence); console.log(`SCREENSHOT ${path}`); await persist(); return evidence;
}
async function snapshot(name) {
  const value = await page.evaluate(async () => {
    const w = littleworld, { ledgerResidual, inventory } = await import(new URL('./src/sim/economy.js', location.href).href);
    return { tick: w.state.tick, step: w.state.step, time: w.state.time, outcome: w.state.outcome || null, diagnostics: w.diagnostics,
      settlements: w.state.settlements.map(s => ({ id: s.id, name: s.name, species: w.state.factions.find(f => f.id === s.factionId)?.species, population: s.population, radius: s.radius, buildings: s.buildings.length, completed: s.buildings.filter(b => b.progress >= 1).length, x: s.x, z: s.z, stocks: s.stock, assigned: s.assigned, status: s.status, occupiedBy: s.occupiedBy || null })),
      nodes: w.state.nodes.map(n => ({ id: n.id, kind: n.kind, subtype: n.subtype, x: n.x, z: n.z, amount: n.amount, maxAmount: n.maxAmount })),
      ledger: w.state.resourceLedger, inventory: inventory(w.state), residual: ledgerResidual(w.state), stats: w.state.stats };
  });
  report.states[name] = value; console.log(`STATE ${name} cycle=${value.tick} population=${value.diagnostics.totalPopulation}`); await persist(); return value;
}
async function advance(cycles) {
  const start = Date.now(); await page.evaluate(cycles => littleworld.advance(cycles), cycles); await settle();
  console.log(`ADVANCED ${cycles} naturally simulated cycles in ${Date.now() - start}ms`);
  if (await page.locator('.world-outcome').isVisible()) {
    await shot('natural-victory-result');
    const before = await page.evaluate(() => ({ step: littleworld.state.step, outcome: { ...littleworld.state.outcome } }));
    await button('keep-watching').click(); await button('pause').click();
    const after = await page.evaluate(() => ({ step: littleworld.state.step, paused: littleworld.view.paused }));
    assert.equal(after.paused, true);
    report.victoryDismissals ||= []; report.victoryDismissals.push({ ...before, pausedAtStep: after.step, trackedContinuedPulses: after.step - before.step });
    await settle();
  }
}
async function layouts(name) {
  return page.evaluate(name => {
    const selectors = ['.atlas-brand', '.time-console', '.faction-index', '.inspector', '.world-chronicle', '.observation-tools'];
    const rects = selectors.flatMap(selector => { const e = document.querySelector(selector); if (!e?.getClientRects().length) return []; const r = e.getBoundingClientRect(); return [{ selector, x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }]; });
    const overlaps = []; for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) { const a = rects[i], b = rects[j], width = Math.min(a.right, b.right) - Math.max(a.x, b.x), height = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y); if (width > 4 && height > 4) overlaps.push({ a: a.selector, b: b.selector, width, height }); }
    return { name, width: innerWidth, height: innerHeight, horizontalOverflow: document.documentElement.scrollWidth > innerWidth, overlaps, rects };
  }, name);
}
async function measure(name, options) {
  const frames = await sampleFrames(page, options), summary = frameSummary(frames);
  const path = output(config, `visual-${name}-frames.json`);
  await save(config, `visual-${name}-frames.json`, { purpose: name, frameSource: 'Actual instanceMatrix render buffers plus identity-matched renderer samples and analytical shader limb offsets', frames });
  report.performance[name] = { ...summary, quality: frames[0]?.quality, paused: frames[0]?.paused, speed: frames[0]?.speed, startCycle: frames[0]?.tick, endCycle: frames.at(-1)?.tick, rawFrames: path, camera: await camera() };
  await persist(); return { frames, summary };
}
function sameCamera(a, b) { assert.deepEqual(a.camera.viewport, b.camera.viewport); assert.equal(a.camera.fov, b.camera.fov); for (const key of ['position', 'target']) for (let i = 0; i < 3; i++) assert.ok(Math.abs(a.camera[key][i] - b.camera[key][i]) < 1e-7, 'Before/after observer camera differs'); }

async function harvestingVideo() {
  // Separate fresh real simulation keeps the video short. Setup advances naturally
  // only until an actual working party exists; all filmed work then runs by clock.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, recordVideo: { dir: output(config, 'videos'), size: { width: 1440, height: 900 } } });
  const film = await context.newPage(); film.setDefaultTimeout(30000); observeErrors(film, report);
  const started = Date.now(), video = film.video();
  const evidence = { status: 'recording', provenance: 'Fresh seeded simulation, deterministic natural setup, live 1x work, paused worksite, then live 1x selected-crew return. The observer pauses immediately after the selected crew finishes to retain its own delivery receipt. Only ordinary observer speed/pause/follow actions change during filming. No inserted state or showcase fixtures.', returnObservationLimitMs: 120000, chapters: [], observations: [] };
  report.video = evidence;
  const chapter = async (label) => { evidence.chapters.push({ label, wallMsSincePage: Date.now() - started, ...await film.evaluate(() => ({ tick: littleworld.state.tick, step: littleworld.state.step, speed: littleworld.view.speed, paused: littleworld.view.paused })) }); };
  const observation = async (nodeId, groupId, originId) => film.evaluate(({ nodeId, groupId, originId }) => {
    const w = littleworld, node = w.state.nodes.find(n => n.id === nodeId), group = w.state.groups.find(g => g.id === groupId), origin = w.state.settlements.find(s => s.id === originId);
    return { wallMs: performance.now(), tick: w.state.tick, step: w.state.step, speed: w.view.speed, paused: w.view.paused, followId: w.view.followId, node: { id: node.id, kind: node.kind, amount: node.amount }, group: group ? { id: group.id, phase: group.phase, x: group.x, z: group.z, carrying: { ...group.carrying }, extractedTotal: group.extractedTotal, size: group.size } : null, origin: origin ? { id: origin.id, x: origin.x, z: origin.z, deliveryDetails: origin.deliveryDetails ? { ...origin.deliveryDetails } : null } : null, ledger: { ...w.state.resourceLedger[node.kind] }, samples: w.getMotionSamples().filter(s => s.groupId === groupId) };
  }, { nodeId, groupId, originId });
  try {
    await boot(film, config); await film.evaluate(seed => littleworld.reset(seed), config.seed);
    const target = await film.evaluate(() => { const w = littleworld; for (let cycle = 0; cycle < 240; cycle++) { w.step(1); const groups = w.state.groups.filter(g => g.kind === 'worker' && g.phase === 'working' && g.workProgress < .55 && w.state.nodes.find(n => n.id === g.targetId)?.amount > 40); if (groups.length) { const g = groups[0], node = w.state.nodes.find(n => n.id === g.targetId); return { groupId: g.id, originId: g.originId, nodeId: node.id, x: node.x, z: node.z, cycle: w.state.tick }; } } return null; });
    assert.ok(target, 'No naturally working party found during first 240 cycles'); evidence.target = target;
    await film.evaluate(t => { const w = littleworld; w.select(t.groupId); w.actions.setCinematic(false); w.actions.follow(null); w.camera.position.set(t.x + 17, 22, t.z + 22); w.controls.target.set(t.x, 2, t.z); w.controls.update(); }, target);
    await waitForRenderedFrames(film); evidence.observations.push(await observation(target.nodeId, target.groupId, target.originId));
    await film.locator('[data-action="speed"][data-value="1"]').click(); await chapter('Working team, live 1x');
    for (let i = 0; i < 6; i++) { await film.waitForTimeout(1000); evidence.observations.push(await observation(target.nodeId, target.groupId, target.originId)); }
    await film.locator('[data-action="pause"]').click(); await waitForRenderedFrames(film); const frozenA = await observation(target.nodeId, target.groupId, target.originId); await chapter('Paused worksite, frozen people and resource state'); await film.waitForTimeout(1200); const frozenB = await observation(target.nodeId, target.groupId, target.originId);
    assert.equal(frozenA.step, frozenB.step); assert.deepEqual(frozenA.samples, frozenB.samples);
    // Follow the actual selected crew before resuming; keep every rendered
    // return frame so another crew's global delivery cannot satisfy this check.
    await film.locator('[data-action="follow"]').click(); await film.waitForTimeout(1800); await waitForRenderedFrames(film);
    assert.equal(await film.evaluate(() => littleworld.view.followId), target.groupId);
    const initial = evidence.observations[0];
    // At 16x one slow software-rendered frame can skip the whole return and
    // overwrite its receipt. Film all remaining work and travel at ordinary 1x.
    // The in-page observer pauses on completion before any protocol round trip.
    const returning = film.evaluate(observeSelectedCrewReturn, { ...target, videoStarted: started, maximumMs: evidence.returnObservationLimitMs });
    await film.locator('[data-action="speed"][data-value="1"]').click(); await chapter('Followed selected crew, remaining work and return at live 1x');
    evidence.returnFrames = await returning;
    const returnStart = evidence.returnFrames.find(f => f.group?.phase === 'returning');
    if (returnStart) evidence.chapters.push({ label: 'Selected crew visibly returns at 1x', wallMsSincePage: returnStart.wallMsSincePage, tick: returnStart.tick, step: returnStart.step, speed: 1, paused: false });
    Object.assign(evidence, selectedCrewEvidence(evidence.returnFrames, target.groupId));
    evidence.observations.push(await observation(target.nodeId, target.groupId, target.originId));
    assert.equal(await film.evaluate(() => littleworld.view.paused), true, 'Return observer did not pause immediately on completion or timeout');
    assert.ok(evidence.returnFrames.every(f => f.speed === 1), 'Selected crew return must remain at live 1x');
    await waitForRenderedFrames(film);
    await film.evaluate(id => littleworld.select(id), target.nodeId); await film.locator('[data-action="tab"][data-value="record"]').click(); await chapter('Real extraction, delivery and conservation ledger'); await film.waitForTimeout(1800);
    const end = await observation(target.nodeId, target.groupId, target.originId); evidence.observations.push(end);
    evidence.ledgerText = await film.locator('.ledger-list').innerText();
    evidence.extractedDelta = end.ledger.extracted - initial.ledger.extracted;
    evidence.deliveredDelta = end.ledger.delivered - initial.ledger.delivered;
    evidence.cargoObserved = evidence.observations.some(o => Object.values(o.group?.carrying || {}).some(n => n > 0));
    evidence.workingLimbSamples = evidence.observations.flatMap(o => o.samples).filter(s => s.visible && s.working > 0).length;
    evidence.selectedTeamFinished = evidence.selectedTeamFinished && !end.group;
    assert.ok(evidence.extractedDelta > 0, 'No extraction observed'); assert.ok(evidence.deliveredDelta > 0, 'No real delivery observed'); assert.ok(evidence.selectedTeamFinished, 'Selected crew did not finish its real return'); assert.ok(evidence.selectedDelivery, 'No origin deliveryDetails receipt proves that this selected crew delivered'); assert.equal(evidence.selectedDelivery.groupId, target.groupId); assert.ok(evidence.visibleReturningFrames > 0, 'Selected crew return was not visibly sampled while its camera followed it'); assert.ok(evidence.cargoObserved, 'No carried resources observed'); assert.ok(evidence.workingLimbSamples > 0, 'Working people were not sampled in the camera frustum');
    await film.screenshot({ path: output(config, 'visual-harvesting-ledger.png') });
    evidence.status = 'captured';
  } catch (error) { evidence.status = 'failed'; evidence.error = error.stack; throw error; }
  finally {
    await context.close();
    if (video) { const file = output(config, 'littleworld-harvesting.webm'); await video.saveAs(file); evidence.path = file; evidence.bytes = (await stat(file)).size; }
    evidence.wallMs = Date.now() - started; await persist();
  }
  return { path: evidence.path, bytes: evidence.bytes, target: evidence.target, extractedDelta: evidence.extractedDelta, deliveredDelta: evidence.deliveredDelta, cargoObserved: evidence.cargoObserved, selectedTeamFinished: evidence.selectedTeamFinished, selectedDelivery: evidence.selectedDelivery, visibleReturningFrames: evidence.visibleReturningFrames };
}

await mkdir(config.outputDir, { recursive: true });
try {
  browser = await launch(config); page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }); page.setDefaultTimeout(60000); observeErrors(page, report);
  await boot(page, config); report.environment = await environment(page, browser, config);
  await page.evaluate(seed => littleworld.reset(seed), config.seed); await settle(1000);
  // Use the actual application's current overview, rather than old hardcoded sea framing.
  await page.evaluate(() => littleworld.actions.overview?.(true)); await settle(500); const overview = await camera();
  await pin(overview); const initial = await snapshot('initial'); const initialOverview = await shot('initial-overview');
  report.layoutDesktop = await layouts('desktop');
  const human = initial.settlements.find(s => s.id === 's0'); assert.ok(human);
  const colonyCamera = { position: [human.x + 34, 35, human.z + 44], target: [human.x, 3, human.z] };
  await pin(colonyCamera, human.id); const initialColony = await shot('initial-human-same-camera');
  await advance(1200); await pin(overview); const developed = await snapshot('cycle1200'); const developedOverview = await shot('cycle1200-overview');
  await pin(colonyCamera, human.id); const developedColony = await shot('cycle1200-human-same-camera');
  report.pairs.colony = { before: initialColony, after: developedColony }; report.pairs.overview = { before: initialOverview, after: developedOverview };
  await check('Same-camera settlement records natural development or conquest', async () => { sameCamera(initialColony, developedColony); sameCamera(initialOverview, developedOverview); const before = initial.settlements.find(s => s.id === human.id), after = developed.settlements.find(s => s.id === human.id); assert.ok(after.population > before.population || after.completed > before.completed || after.occupiedBy || ['camp','ruin'].includes(after.status), 'the seeded colony shows no natural development or conflict outcome'); assert.ok(developed.stats.births > 0 && developed.stats.buildings > 0, 'world development must be paid and simulated'); return { before, after, outcome: developed.outcome }; });
  if (config.tier === 'full') { await advance(1800); await pin(overview); await snapshot('cycle3000'); await shot('cycle3000-overview'); await pin(colonyCamera, human.id); await shot('cycle3000-human-same-camera'); }
  const latest = report.states[`cycle${config.lastCycle}`];
  await check('Natural overview measures actual population and domination outcome without showcase actors', async () => { assert.ok(latest.diagnostics.totalPopulation > 0, 'no actual surviving population'); assert.equal(latest.diagnostics.visibleIndividuals, latest.diagnostics.totalPopulation, 'overview failed to show every actual surviving individual'); return { ...latest.diagnostics, outcome: latest.outcome, populationThreshold: null, note: 'Domination pacing can stop autonomous growth early; population is measured, never inflated to meet a visual threshold.' }; });
  await check('Every actual individual is represented exactly once', async () => { for (const s of Object.values(report.states)) { assert.equal(s.diagnostics.totalPopulation, s.diagnostics.representedIndividuals); assert.equal(s.diagnostics.crowds.populationAccountingDelta, 0); assert.equal(s.diagnostics.crowds.visibleIndividuals + s.diagnostics.crowds.culledIndividuals, s.diagnostics.totalPopulation); } return Object.fromEntries(Object.entries(report.states).map(([key, value]) => [key, { actual: value.diagnostics.totalPopulation, represented: value.diagnostics.representedIndividuals, visible: value.diagnostics.visibleIndividuals }])); });
  await check('Natural resource ledger conserves all four resources', async () => { for (const s of Object.values(report.states)) for (const [kind, residual] of Object.entries(s.residual)) assert.ok(Math.abs(residual) < Math.max(1e-6, s.ledger[kind].initial * 1e-9), `${kind} residual ${residual}`); return Object.fromEntries(Object.entries(report.states).map(([key, value]) => [key, value.residual])); });

  // Active and paused timings are intentionally separate, at the same camera and
  // quality. Paused frames must not be described as simulation throughput.
  await pin(colonyCamera, human.id); await button('speed', 1).click();
  const active = await measure('active-1x', { durationMs: 4500, minimumFrames: 14 });
  await check('1x rendered people move between frames within a single cycle', async () => { assert.ok(active.summary.sameCyclePositionChanges >= 5, `Only ${active.summary.sameCyclePositionChanges} same-cycle visible position changes`); assert.ok(active.summary.sameCycleRenderMatrixChanges >= 3, `Only ${active.summary.sameCycleRenderMatrixChanges} same-cycle render-buffer changes`); assert.ok(active.frames.every(f => !f.paused && f.speed === 1)); assert.ok(active.frames.at(-1).step > active.frames[0].step); return active.summary; });
  await check('Visible motion identities correlate with literal render-buffer transforms', async () => { let correlated = 0; for (const frame of active.frames) { const byId = new Map(frame.samples.map(s => [s.id, s])); for (const matrix of frame.meshSamples) { const sample = byId.get(matrix.id); if (!sample) continue; assert.equal(sample.meshUuid, matrix.meshUuid); assert.equal(sample.instanceIndex, matrix.instanceIndex); assert.ok(Math.abs(sample.x - matrix.x) < 1e-4); assert.ok(Math.abs(sample.z - matrix.z) < 1e-4); if (Number.isFinite(sample.groundY)) assert.ok(Math.abs(sample.groundY - matrix.y) < 1e-4); correlated++; } } assert.ok(correlated > 0, 'No identity-correlated literal render matrices'); return { correlated, positionTolerance: 1e-4, note: 'Matrix Y is the body origin; motion sample Y also includes the analytical GPU bob.' }; });
  await pause(); const paused = await measure('paused', { durationMs: 1600, minimumFrames: 10 });
  await check('Pause freezes cycles, interpolation, render matrices and working limb poses', async () => { const a = paused.frames[0]; for (const b of paused.frames.slice(1)) { assert.equal(b.step, a.step); assert.equal(b.time, a.time); assert.equal(b.alpha, a.alpha); assert.deepEqual(b.samples, a.samples); assert.deepEqual(b.meshSamples, a.meshSamples); } assert.ok(a.samples.length > 0 && a.meshSamples.length > 0); return { frames: paused.frames.length, cycle: a.tick, people: a.samples.length, actualRenderMatrices: a.meshSamples.length, camera: await camera() }; });
  if (config.tier === 'full') { await page.evaluate(() => littleworld.actions.setQuality('low')); await settle(); await measure('paused-low', { durationMs: 1600, minimumFrames: 10 }); await page.evaluate(quality => littleworld.actions.setQuality(quality), config.quality); }

  report.depletion = latest.nodes.map(node => { const before = initial.nodes.find(n => n.id === node.id); return { ...node, initial: before.amount, netDepletion: before.amount - node.amount }; }).sort((a, b) => b.netDepletion - a.netDepletion);
  const depleted = report.depletion.find(n => n.kind === 'materials' && n.netDepletion > 1) || report.depletion.find(n => n.netDepletion > 1);
  await check('Resource depletion has same-camera before/after pixels and real ledger', async () => {
    assert.ok(depleted, 'No natural resource depletion found');
    const spec = { position: [depleted.x + 15, 20, depleted.z + 19], target: [depleted.x, 2, depleted.z] };
    await pin(spec, depleted.id); await button('tab', 'life').click(); const after = await shot('resource-depleted-same-camera'); await button('tab', 'record').click(); const ledger = await shot('resource-depleted-ledger');
    await page.evaluate(seed => littleworld.reset(seed), config.seed); await settle(); await pin(spec, depleted.id); await button('tab', 'life').click(); const before = await shot('resource-initial-same-camera');
    sameCamera(before, after); report.pairs.resource = { before, after, ledger, node: depleted }; return { id: depleted.id, initial: depleted.initial, after: depleted.amount, netDepletion: depleted.netDepletion };
  });
  await pin(overview); await page.setViewportSize({ width: 1024, height: 768 }); await settle(); report.layoutCompact = await layouts('compact'); await shot('compact');
  await page.close();
  report.layoutTouch = [];
  for (const viewport of TOUCH_VIEWPORTS) {
    const context = await browser.newContext(touchContextOptions(viewport));
    try {
      page = await context.newPage(); observeErrors(page, report); await boot(page, config); await settle();
      const layout = await layouts(`touch-${viewport.name}`);
      layout.touch = await page.evaluate(() => ({ coarse: matchMedia('(pointer: coarse)').matches, maxTouchPoints: navigator.maxTouchPoints }));
      report.layoutTouch.push(layout); await shot(`touch-${viewport.name}`);
    } finally { await context.close(); }
  }
  await check('Desktop panels do not overlap', async () => { assert.deepEqual(report.layoutDesktop.overlaps, []); return report.layoutDesktop; });
  await check('Compact and real touch portrait/landscape contexts have no horizontal overflow', async () => { assert.equal(report.layoutCompact.horizontalOverflow, false); for (const layout of report.layoutTouch) { assert.equal(layout.horizontalOverflow, false); assert.equal(layout.touch.coarse, true); assert.ok(layout.touch.maxTouchPoints > 0); } return { compact: report.layoutCompact, touch: report.layoutTouch }; });
  if (config.video) await check('Real harvesting video includes cargo, pause and ledger', harvestingVideo);
  else report.checks.push({ name: 'Real harvesting video', skipped: true, reason: 'QA_VIDEO=0 explicitly disables video capture.' });
  await check('No page, module, HTTP or WebGL runtime errors', async () => { assert.deepEqual(report.errors, []); });
} catch (error) { report.failure = error.stack; console.error(error); }
finally { report.status = report.failure ? 'aborted' : report.checks.some(c => c.passed === false) ? 'failed' : 'completed'; await persist(); await browser?.close(); }
console.log('RESULT', JSON.stringify({ status: report.status, errors: report.errors, failure: report.failure, checks: report.checks.map(({ name, passed, skipped }) => ({ name, passed, skipped })), report: output(config, 'visual-report.json') }, null, 2));
if (report.failure || report.errors.length || report.checks.some(c => c.passed === false)) process.exitCode = 1;
