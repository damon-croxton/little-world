// Portable browser QA support. This module never starts a browser on import.
// Run only in an authorised browser-test environment (for example GitHub Actions).
// Existing app harness API is used to reset/advance deterministic simulation and
// move the observer camera. No test writes populations, resources, RNG or ledgers.
import { chromium } from '@playwright/test';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

export function configuration(env = process.env) {
  const base = new URL(env.BASE_URL || 'http://127.0.0.1:4174/');
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('BASE_URL must be HTTP(S)');
  if (!base.pathname.endsWith('/') && !base.pathname.endsWith('.html')) base.pathname += '/';
  const seed = env.QA_SEED || 'first-light';
  base.searchParams.set('seed', seed);
  base.searchParams.delete('evolve');
  const civCount = Number(env.QA_CIVS || 4);
  if (!Number.isInteger(civCount) || civCount < 3 || civCount > 6) throw new Error('QA_CIVS must be an integer from 3 through 6');
  base.searchParams.set('civs', String(civCount));
  const tier = env.QA_TIER || 'ci';
  if (!['ci', 'full'].includes(tier)) throw new Error('QA_TIER must be ci or full');
  const quality = env.QA_QUALITY || (tier === 'full' ? 'high' : 'low');
  if (!['low', 'high'].includes(quality)) throw new Error('QA_QUALITY must be low or high');
  const args = env.BROWSER_ARGS ? JSON.parse(env.BROWSER_ARGS) : [];
  if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) throw new Error('BROWSER_ARGS must be a JSON array of strings');
  const software = env.QA_SOFTWARE_RENDERING === '1';
  const launchOptions = {
    headless: env.HEADLESS !== '0',
    args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', ...(software ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : []), ...args],
    ...(env.BROWSER_CHANNEL ? { channel: env.BROWSER_CHANNEL } : {}),
    ...(env.BROWSER_EXECUTABLE_PATH ? { executablePath: env.BROWSER_EXECUTABLE_PATH } : {}),
  };
  if (launchOptions.channel && launchOptions.executablePath) throw new Error('Choose BROWSER_CHANNEL or BROWSER_EXECUTABLE_PATH, not both');
  return { url: base.href, seed, civCount, tier, quality, software, launchOptions, outputDir: env.QA_OUTPUT_DIR || 'screenshots', lastCycle: tier === 'full' ? 3000 : 1200, video: env.QA_VIDEO !== '0' };
}

export async function launch(config) { return chromium.launch(config.launchOptions); }
export function output(config, filename) { return path.join(config.outputDir, filename); }
export async function save(config, filename, report) {
  await mkdir(config.outputDir, { recursive: true });
  await writeFile(output(config, filename), JSON.stringify(report, null, 2));
}
export function observeErrors(page, report) {
  page.on('pageerror', e => report.errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') report.errors.push(m.text()); if (m.type() === 'warning') report.warnings.push(m.text()); });
  page.on('response', response => { if (response.status() >= 400) report.errors.push(`HTTP ${response.status()} ${response.url()}`); });
  page.on('requestfailed', request => report.errors.push(`Request failed: ${request.url()} ${request.failure()?.errorText}`));
}
export async function boot(page, config) {
  await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.littleworld || /WebGL could not start/.test(document.body.innerText), null, { timeout: 60000 });
  const failure = await page.evaluate(() => !window.littleworld ? document.querySelector('#boot')?.innerText : null);
  if (failure) throw new Error(`Application boot failed: ${failure}`);
  await page.evaluate(quality => { const w = window.littleworld; if (!w.view.paused) w.actions.togglePause(); w.actions.setQuality(quality); }, config.quality);
  await page.waitForFunction(() => littleworld.diagnostics.representedIndividuals > 0);
}
export async function environment(page, browser, config) {
  return { browser: browser.version(), platform: process.platform, launch: config.launchOptions, tier: config.tier, quality: config.quality, civCount: config.civCount, url: config.url,
    gpu: await page.evaluate(() => { const gl = littleworld.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info'); return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); }),
    measurementLimit: 'Headless browser on this runner only. Frame timings are not foreground hardware performance or a cross-device guarantee.' };
}

// Executed in page context, after the app requestAnimationFrame has rendered.
// Motion samples include shader-derived limb displacement. instanceMatrix reads
// below are separate literal render-buffer evidence, not simulation positions.
export function renderedFrame() {
  const w = window.littleworld, samples = w.getMotionSamples(), meshSamples = [], meshes = new Map();
  w.scene.traverse(o => { if (o.isInstancedMesh && o.visible && o.count && o.geometry?.attributes?.crowdMotion) meshes.set(o.uuid, o); });
  const push = (mesh, i, id) => { const matrix = Array.from(mesh.instanceMatrix.array.subarray(i * 16, i * 16 + 16)); const motion = mesh.geometry.attributes.crowdMotion; meshSamples.push({ id, meshUuid: mesh.uuid, mesh: mesh.name, instanceIndex: i, x: matrix[12], y: matrix[13], z: matrix[14], matrix, motion: Array.from(motion.array.subarray(i * motion.itemSize, (i + 1) * motion.itemSize)) }); };
  for (const sample of samples.filter(s => s.visible && s.meshUuid && Number.isInteger(s.instanceIndex)).slice(0, 48)) { const mesh = meshes.get(sample.meshUuid); if (mesh && sample.instanceIndex < mesh.count) push(mesh, sample.instanceIndex, sample.id); }
  if (!meshSamples.length) for (const mesh of meshes.values()) { for (let i = 0; i < Math.min(mesh.count, 4); i++) push(mesh, i, null); if (meshSamples.length >= 48) break; }
  return { wallMs: performance.now(), tick: w.state.tick, step: w.state.step, time: w.state.time, alpha: w.clock.alpha, paused: w.view.paused, speed: w.view.speed, quality: w.view.quality, calls: w.renderer.info.render.calls, triangles: w.renderer.info.render.triangles, samples, meshSamples };
}

export function frameSummary(frames) {
  const pairs = frames.slice(1).map((frame, i) => {
    const previous = frames[i], old = new Map(previous.samples.map(s => [s.id, s])), oldMeshes = new Map(previous.meshSamples.map(s => [s.id || `${s.meshUuid}:${s.instanceIndex}`, s]));
    let positionsChanged = 0, visiblePositionsChanged = 0, workingLimbsChanged = 0, renderMatricesChanged = 0;
    for (const sample of frame.samples) {
      const prior = old.get(sample.id); if (!prior) continue;
      if (Math.hypot(sample.x - prior.x, sample.y - prior.y, sample.z - prior.z) > 1e-7) { positionsChanged++; if (sample.visible && prior.visible) visiblePositionsChanged++; }
      if (sample.visible && sample.working > 0 && JSON.stringify(sample.toolMotion) !== JSON.stringify(prior.toolMotion)) workingLimbsChanged++;
    }
    for (const sample of frame.meshSamples) { const prior = oldMeshes.get(sample.id || `${sample.meshUuid}:${sample.instanceIndex}`); if (prior && Math.hypot(sample.x - prior.x, sample.y - prior.y, sample.z - prior.z) > 1e-7) renderMatricesChanged++; }
    return { dtMs: frame.wallMs - previous.wallMs, sameCycle: frame.tick === previous.tick, samePulse: frame.step === previous.step, positionsChanged, visiblePositionsChanged, workingLimbsChanged, renderMatricesChanged };
  });
  const times = pairs.map(p => p.dtMs).sort((a, b) => a - b), meanMs = times.reduce((n, x) => n + x, 0) / times.length;
  return { frames: frames.length, meanMs, derivedFps: 1000 / meanMs, p50Ms: times[Math.floor(times.length * .5)], p95Ms: times[Math.floor(times.length * .95)], maxMs: times.at(-1), maxDrawCalls: Math.max(...frames.map(f => f.calls)), maxTriangles: Math.max(...frames.map(f => f.triangles)), sameCyclePositionChanges: pairs.filter(p => p.sameCycle && p.visiblePositionsChanged > 0).length, sameCycleRenderMatrixChanges: pairs.filter(p => p.sameCycle && p.renderMatricesChanged > 0).length, pairs };
}
export async function sampleFrames(page, { durationMs = 4000, minimumFrames = 12, maximumMs = 20000 } = {}) {
  // Passing serialised code here does not change app state; only observes frames.
  return page.evaluate(async ({ source, durationMs, minimumFrames, maximumMs }) => {
    const read = (0, eval)(`(${source})`), frames = [], start = performance.now();
    do { await new Promise(requestAnimationFrame); frames.push(read()); } while ((performance.now() - start < durationMs || frames.length < minimumFrames) && performance.now() - start < maximumMs);
    return frames;
  }, { source: renderedFrame.toString(), durationMs, minimumFrames, maximumMs });
}

export function selectedCrewEvidence(frames, groupId) {
  return {
    selectedDelivery: frames.map(frame => frame.deliveryDetails).find(receipt => receipt?.groupId === groupId && receipt.amount > 0) || null,
    selectedTeamFinished: frames.length > 0 && frames.at(-1).group === null,
    visibleReturningFrames: frames.filter(frame => frame.group?.id === groupId && frame.group.phase === 'returning' && frame.followId === groupId && frame.samples.some(sample => sample.groupId === groupId && sample.visible)).length,
  };
}

// A resized desktop page is not a touch-device test: coarse-pointer CSS needs a
// new context with real touch/mobile emulation, including wide phone landscape.
export const TOUCH_VIEWPORTS = Object.freeze([
  Object.freeze({ name: 'portrait', width: 390, height: 844 }),
  Object.freeze({ name: 'landscape', width: 844, height: 390 }),
]);
export function touchContextOptions(viewport) {
  if (!Number.isInteger(viewport?.width) || !Number.isInteger(viewport?.height) || viewport.width <= 0 || viewport.height <= 0) throw new Error('Touch viewport needs positive integer dimensions');
  return { viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1, hasTouch: true, isMobile: true };
}
