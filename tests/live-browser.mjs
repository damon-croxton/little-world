// Validate the deployed artifact, including real WebGL boot, from a network that
// can reach GitHub Pages. This is cloud software-renderer evidence, not phone/PC performance.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { configuration, launch, boot, environment, observeErrors, output, save, waitForRenderedFrames } from './browser-v2.mjs';

const expectedCommit = process.env.EXPECTED_COMMIT || process.env.GITHUB_SHA;
assert.match(expectedCommit || '', /^[0-9a-f]{40}$/, 'Supply the exact EXPECTED_COMMIT or GITHUB_SHA');
assert.ok(process.env.BASE_URL, 'Supply the deployed BASE_URL');
const config = configuration();
const report = { expectedCommit, url: config.url, startedAt: new Date().toISOString(), status: 'running', errors: [], warnings: [], markerAttempts: [] };
await mkdir(config.outputDir, { recursive: true });
let browser, page;
try {
  browser = await launch(config);
  page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const deadline = Date.now() + 120000;
  do {
    const markerURL = new URL('build.json', config.url);
    markerURL.search = `?verify=${expectedCommit}-${Date.now()}`;
    try {
      const response = await page.request.get(markerURL.href, { timeout: 15000 });
      const marker = response.ok() ? await response.json() : null;
      report.markerAttempts.push({ at: new Date().toISOString(), status: response.status(), marker });
      if (marker?.commit === expectedCommit) { report.build = marker; break; }
    } catch (error) { report.markerAttempts.push({ at: new Date().toISOString(), error: error.message }); }
    if (Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 3000));
  } while (Date.now() < deadline);
  assert.equal(report.build?.commit, expectedCommit, 'Public build marker did not reach the exact deployed commit');
  observeErrors(page, report);
  await boot(page, config);
  await waitForRenderedFrames(page);
  assert.equal(await page.title(), 'LittleWorld V2 — A living frontier');
  report.environment = await environment(page, browser, config);
  const firstStep = await page.evaluate(() => littleworld.state.step);
  await page.locator('[data-action="pause"]').click();
  await page.waitForFunction(firstStep => littleworld.state.step > firstStep, firstStep, { timeout: 60000 });
  await page.locator('[data-action="pause"]').click();
  await waitForRenderedFrames(page);
  report.observation = await page.evaluate(() => ({ step: littleworld.state.step, paused: littleworld.view.paused, diagnostics: littleworld.diagnostics }));
  const { diagnostics } = report.observation;
  assert.ok(report.observation.step > firstStep && report.observation.paused, 'Live controls failed to advance and pause');
  assert.ok(diagnostics.totalPopulation > 0);
  assert.equal(diagnostics.representedIndividuals, diagnostics.totalPopulation);
  const crowds = diagnostics.crowds;
  assert.equal(crowds.drawnModels, crowds.visibleIndividuals - crowds.visibleWorkerIndividuals + crowds.drawnWorkerModels);
  assert.equal(crowds.drawnWorkerModels, crowds.visibleWorkerCrews);
  await page.screenshot({ path: output(config, 'live-boot.png') });
  assert.deepEqual(report.errors, [], 'Public browser emitted runtime or asset errors');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = error.stack; process.exitCode = 1;
  console.error(error);
} finally {
  report.completedAt = new Date().toISOString();
  await save(config, 'live-browser-report.json', report);
  await browser?.close();
}
console.log(JSON.stringify({ status: report.status, expectedCommit, liveCommit: report.build?.commit, report: output(config, 'live-browser-report.json'), failure: report.failure }));
