// Sequential natural-state visual evidence. Never changes simulation entities or ledgers.
// Example (PowerShell): $env:QA_PHASE='before'; $env:BASE_URL='https://damon-croxton.github.io/little-world/'; node tests/ai-readability-browser.mjs
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { configuration, launch, boot, environment, observeErrors, save, output, waitForRenderedFrames } from './browser-v2.mjs';

const phase = process.env.QA_PHASE || 'after';
assert.ok(['before', 'after'].includes(phase), 'QA_PHASE must be before or after');
const baselineSha = '1ce023fe0214ccb97e6935d64e7684084b33dc55';
const config = configuration({ ...process.env, BASE_URL: process.env.BASE_URL || (phase === 'before' ? 'https://damon-croxton.github.io/little-world/' : 'http://127.0.0.1:4174/'), BROWSER_CHANNEL: process.env.BROWSER_CHANNEL || 'chrome', QA_QUALITY: process.env.QA_QUALITY || 'high', QA_OUTPUT_DIR: process.env.QA_OUTPUT_DIR || `screenshots/ai-readability-${phase}` });
const report = { phase, status: 'running', startedAt: new Date().toISOString(), scope: 'Natural first-light four-civilization Chrome run; only observer controls, deterministic paused advancement and ordinary real-time 1x simulation. No injected troops, buildings, resources, paths or RNG.', errors: [], warnings: [], screenshots: [], videos: [], checkpoints: [], search: [] };
const videoSeconds = Math.min(30, Math.max(4, Number(process.env.QA_VIDEO_SECONDS || 12)));
const searchLimit = Math.min(1500, Math.max(200, Number(process.env.QA_BATTLE_LIMIT || 700)));
const overviewCycle = Math.min(3000, Math.max(300, Number(process.env.QA_OVERVIEW_CYCLE || 600)));
await mkdir(config.outputDir, { recursive: true });
let browser, page;
const watchdog = setTimeout(() => { report.failure = 'Evidence run exceeded the 10-minute wall-time limit'; browser?.close().catch(() => {}); }, 600000);
const persist = () => save(config, 'report.json', report);
const progress = message => console.log(`[${phase}] ${message}`);

async function state() {
  return page.evaluate(() => {
    const w = littleworld, s = w.state;
    return { seed: s.seed, cycle: s.tick, step: s.step, simulationTime: s.time, paused: w.view.paused, speed: w.view.speed, camera: w.camera.position.toArray(), target: w.controls.target.toArray(), quality: w.view.quality, perspective: w.view.perspective, diagnostics: w.diagnostics, stats: s.stats, populationLedger: s.populationLedger, resourceLedger: s.resourceLedger };
  });
}
async function settle() { await waitForRenderedFrames(page, { minimumFrames: 3, maximumMs: 30000 }); }
async function advanceTo(cycle) {
  const result = await page.evaluate(async cycle => {
    const w = littleworld;
    if (!w.view.paused) w.actions.togglePause();
    return w.advance(Math.max(0, cycle - w.state.tick));
  }, cycle);
  assert.equal(result.completed, true);
  await settle();
}
async function pin({ x, z, id, distance = 26, camera, target }) {
  await page.evaluate(({ x, z, id, distance, camera, target }) => {
    const w = littleworld;
    w.actions.follow(null);
    if (id) w.select(id);
    if (camera && target) { w.camera.position.fromArray(camera); w.controls.target.fromArray(target); }
    else { w.camera.position.set(x + distance * .8, distance * .78 + 4, z + distance); w.controls.target.set(x, 3, z); }
    w.controls.update();
  }, { x, z, id, distance, camera, target });
  await settle();
}
async function screenshot(name, details = {}) {
  const filename = `${phase}-${name}.png`;
  await page.screenshot({ path: output(config, filename) });
  const checkpoint = { name, file: filename, ...details, ...await state() };
  report.screenshots.push(checkpoint); report.checkpoints.push(checkpoint);
  await persist(); progress(`Captured ${name} at cycle ${checkpoint.cycle}`);
  return checkpoint;
}

// Capture the actual WebGL canvas directly. The bytes are never sped up or retimed.
// Lightweight RAF observations avoid traversing every mesh on every captured frame.
async function record(name, details = {}) {
  const filename = `${phase}-${name}-1x.webm`;
  const result = await page.evaluate(async ({ durationMs }) => {
    const w = littleworld, canvas = w.renderer.domElement;
    const stream = canvas.captureStream(30), chunks = [], frames = [];
    const preferred = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    const mimeType = preferred.find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error('No supported WebM recorder');
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6000000 });
    const done = new Promise((resolve, reject) => { recorder.onstop = resolve; recorder.onerror = reject; });
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    const start = { cycle: w.state.tick, step: w.state.step, simulationTime: w.state.time, stats: { ...w.state.stats }, camera: w.camera.position.toArray(), target: w.controls.target.toArray() };
    let request, finish = false;
    const started = performance.now();
    const sample = () => {
      frames.push({ ms: performance.now() - started, renderFrame: w.renderer.info.render.frame, cycle: w.state.tick, step: w.state.step, paused: w.view.paused, speed: w.view.speed, calls: w.renderer.info.render.calls, triangles: w.renderer.info.render.triangles, combatEvents: w.state.combatEvents?.length || 0 });
      if (!finish) request = requestAnimationFrame(sample);
    };
    recorder.start(500); w.actions.setSpeed(1); request = requestAnimationFrame(sample);
    await new Promise(resolve => setTimeout(resolve, durationMs));
    finish = true; cancelAnimationFrame(request);
    const actualWallMs = performance.now() - started;
    const end = { cycle: w.state.tick, step: w.state.step, simulationTime: w.state.time, stats: { ...w.state.stats }, performance: w.view.performance, diagnostics: w.diagnostics };
    if (!w.view.paused) w.actions.togglePause();
    recorder.stop(); await done; stream.getTracks().forEach(track => track.stop());
    const blob = new Blob(chunks, { type: mimeType });
    const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject; reader.readAsDataURL(blob); });
    return { data, bytes: blob.size, mimeType, actualWallMs, start, end, frames };
  }, { durationMs: videoSeconds * 1000 });
  await writeFile(output(config, filename), Buffer.from(result.data, 'base64'));
  delete result.data;
  const intervals = result.frames.slice(1).map((f, i) => f.ms - result.frames[i].ms).sort((a, b) => a - b);
  const summary = { renderedSamples: result.frames.length, meanFrameMs: intervals.reduce((s, v) => s + v, 0) / intervals.length, p50FrameMs: intervals[Math.floor(intervals.length * .5)], p95FrameMs: intervals[Math.floor(intervals.length * .95)], maxDrawCalls: Math.max(...result.frames.map(f => f.calls)), maxTriangles: Math.max(...result.frames.map(f => f.triangles)), advancingFrames: result.frames.filter(f => f.speed === 1 && !f.paused).length, simulatedSecondsPerWallSecond: (result.end.simulationTime - result.start.simulationTime) / (result.actualWallMs / 1000) };
  assert.ok(result.end.step > result.start.step, `${name} simulation did not advance`);
  assert.ok(result.frames.every(f => f.speed === 1 && !f.paused), `${name} changed playback rate or paused during capture`);
  report.videos.push({ name, file: filename, playback: 'Actual canvas capture at ordinary 1x; no retiming; UI is omitted by canvas capture.', ...details, ...result, summary });
  await persist(); progress(`Recorded ${name}, cycles ${result.start.cycle}–${result.end.cycle}, ${result.bytes} bytes`);
}

async function battleCandidate() {
  return page.evaluate(() => {
    const s = littleworld.state;
    const events = [...(s.combatEvents || [])].reverse();
    for (const event of events) {
      if (event.type !== 'projectile' || !event.shots?.length || event.impactTime < s.time - .1) continue;
      const source = s.groups.find(g => g.id === event.sourceId), target = s.groups.find(g => g.id === event.targetId);
      if (!(source && source.kind !== 'worker') && !(target && target.kind !== 'worker')) continue;
      const shot = event.shots[0];
      return { event, source, target, x: (shot.from.x + shot.to.x) / 2, z: (shot.from.z + shot.to.z) / 2, cycle: s.tick, projectileDistance: Math.hypot(shot.from.x - shot.to.x, shot.from.z - shot.to.z) };
    }
    return null;
  });
}

try {
  browser = await launch(config);
  page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(30000); observeErrors(page, report);
  const buildURL = new URL('build.json', config.url); buildURL.search = `?evidence=${Date.now()}`;
  const buildResponse = await page.request.get(buildURL.href, { timeout: 30000 });
  if (buildResponse.ok()) report.build = await buildResponse.json();
  else report.build = { status: buildResponse.status(), available: false };
  if (phase === 'before') assert.ok(JSON.stringify(report.build).includes(baselineSha), `Public baseline is not ${baselineSha}: ${JSON.stringify(report.build)}`);
  await boot(page, config);
  report.environment = await environment(page, browser, config);
  await page.evaluate(({ seed, civCount }) => { const w = littleworld; if (!w.view.paused) w.actions.togglePause(); w.reset(seed, { civCount }); w.actions.setPerspective('omniscient'); w.actions.overview(true); }, config);
  await settle(); await persist(); progress(`Booted ${report.environment.browser}; ${report.environment.gpu}`);

  await advanceTo(100);
  const crew = await page.evaluate(() => {
    const workers = littleworld.state.groups.filter(g => g.kind === 'worker' && g.size > 0);
    workers.sort((a, b) => (b.phase === 'working') - (a.phase === 'working') || b.size - a.size || a.id.localeCompare(b.id));
    return workers[0] || null;
  });
  assert.ok(crew, 'No natural worker crew at cycle 100');
  await pin({ ...crew, distance: 15 });
  const workerRendered = await page.evaluate(id => littleworld.getMotionSamples().filter(s => s.groupId === id), crew.id);
  report.worker = { crew, renderedSamples: workerRendered, expectedRealCrewSize: crew.size };
  await screenshot('worker-close-cycle100', { crewId: crew.id, realCrewSize: crew.size });
  await record('worker-close', { crewId: crew.id, realCrewSizeAtStart: crew.size });

  let battle = await battleCandidate();
  while (!battle && await page.evaluate(() => littleworld.state.tick) < searchLimit) {
    await page.evaluate(() => littleworld.step(1));
    battle = await battleCandidate();
    if (await page.evaluate(() => littleworld.state.tick % 50 === 0)) {
      const brief = await page.evaluate(() => ({ cycle: littleworld.state.tick, combatEvents: littleworld.state.combatEvents?.length || 0, militaryGroups: littleworld.state.groups.filter(g => g.kind !== 'worker').length, stats: littleworld.state.stats }));
      report.search.push(brief); await persist(); progress(`Searching natural battle at cycle ${brief.cycle}`);
    }
  }
  if (battle) {
    const inspectedArmy = battle.source?.kind === 'army' ? battle.source : battle.target?.kind === 'army' ? battle.target : null;
    await pin({ ...battle, id: inspectedArmy?.id || battle.event.sourceId, distance: Math.max(22, Math.min(40, battle.projectileDistance * .7)) });
    report.battle = battle;
    await screenshot('natural-battle-close', { event: battle.event, searchLimit });
    await record('natural-battle-close', { seed: config.seed, naturallyFoundAtCycle: battle.cycle });
    await screenshot('natural-battle-close-end');
  } else {
    report.exceptions ??= [];
    report.exceptions.push(`No military projectile exchange found by cycle ${searchLimit}; no synthetic replacement was used.`);
  }

  await advanceTo(overviewCycle);
  await page.evaluate(() => littleworld.actions.overview(true)); await settle();
  await screenshot(`overview-cycle${overviewCycle}`);
  await record('developed-overview', { requestedCheckpointCycle: overviewCycle });
  const home = await page.evaluate(() => littleworld.state.settlements.map(h => ({ id: h.id, x: h.x, z: h.z, population: h.population, buildings: h.buildings.filter(b => ['wall', 'gate', 'tower'].includes(b.kind) && b.hp > 0) })).sort((a, b) => b.buildings.length - a.buildings.length)[0]);
  await pin({ ...home, distance: 42 });
  await screenshot('fortifications-close', { home });
  const gate = home.buildings.find(b => b.kind === 'gate' && b.progress >= 1 && !b.destroyed && b.from && b.to);
  if (phase === 'after' && gate) {
    const length = Math.hypot(gate.to.x - gate.from.x, gate.to.z - gate.from.z), side = { x: (gate.to.x - gate.from.x) / length, z: (gate.to.z - gate.from.z) / length };
    const forward = gate.approach || { x: side.z, z: -side.x };
    await pin({ id: home.id, camera: [gate.x + forward.x * 30 + side.x * 12, 28, gate.z + forward.z * 30 + side.z * 12], target: [gate.x, 3, gate.z] });
    await screenshot('gate-passage-quarter', { gateId: gate.id, endpoints: { from: gate.from, to: gate.to }, passageWidth: gate.gateWidth });
  }

  if (phase === 'after' && process.env.QA_BASELINE_REPORT) {
    const prior = JSON.parse(await readFile(process.env.QA_BASELINE_REPORT, 'utf8'));
    assert.equal(prior.status, 'completed', 'Matched comparison requires completed baseline evidence');
    assert.ok(JSON.stringify(prior.build).includes(baselineSha), 'Matched comparison requires the exact public baseline SHA');
    assert.equal(prior.environment.civCount, config.civCount, 'Matched comparison requires the same civilization count');
    assert.equal(prior.screenshots[0].seed, config.seed, 'Matched comparison requires the same seed');
    report.baselineReference = { file: process.env.QA_BASELINE_REPORT, build: prior.build, checkpoints: prior.screenshots.map(s => ({ name: s.name, cycle: s.cycle, camera: s.camera, target: s.target })) };
    // A fresh seeded natural run reproduces exact before cycle/camera checkpoints.
    // Simulation outcomes can legitimately differ after AI/navigation changes.
    await page.evaluate(({ seed, civCount }) => { const w = littleworld; if (!w.view.paused) w.actions.togglePause(); w.reset(seed, { civCount }); w.actions.setPerspective('omniscient'); }, config);
    for (const checkpoint of prior.screenshots.filter(s => s.name !== 'natural-battle-close-end').sort((a, b) => a.cycle - b.cycle)) {
      await advanceTo(checkpoint.cycle);
      await pin({ camera: checkpoint.camera, target: checkpoint.target, id: checkpoint.crewId || checkpoint.home?.id || checkpoint.event?.sourceId });
      await screenshot(`matched-${checkpoint.name}`, { comparison: 'Exact baseline seed, cycle, quality and camera coordinates; natural state may differ after simulation changes.', baselineFile: checkpoint.file });
    }
  }
  report.final = await state();
  assert.equal(report.final.diagnostics.totalPopulation, report.final.diagnostics.representedIndividuals, 'Census must be fully represented including culled groups');
  assert.deepEqual(report.errors, [], 'Browser errors');
  report.status = report.exceptions?.length ? 'completed-with-exceptions' : 'completed';
} catch (error) {
  report.status = 'failed'; report.failure = error.stack; console.error(error);
} finally {
  clearTimeout(watchdog);
  report.completedAt = new Date().toISOString();
  if (browser) await browser.close();
  report.browserClosed = true; await persist();
}
console.log(JSON.stringify({ status: report.status, report: output(config, 'report.json'), browserClosed: report.browserClosed, videos: report.videos.map(v => ({ name: v.name, file: v.file, startCycle: v.start.cycle, endCycle: v.end.cycle, ...v.summary })), exceptions: report.exceptions, failure: report.failure }));
if (report.status === 'failed') process.exitCode = 1;
