import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { boot, output } from './browser-v2.mjs';

export async function debugDownloadSmoke({ page, check, config, expectedCommit }) {
  async function download(current, name, touch = false) {
    const before = await current.evaluate(() => JSON.stringify(littleworld.state));
    const pending = current.waitForEvent('download');
    const button = current.locator('[data-action="download-debug"]');
    if (touch) await button.tap(); else await button.click();
    const file = await pending; assert.equal(await file.failure(), null);
    const target = output(config, name + (file.suggestedFilename().endsWith('.gz') ? '.json.gz' : '.json'));
    await file.saveAs(target);
    const bytes = await readFile(target), json = file.suggestedFilename().endsWith('.gz') ? gunzipSync(bytes) : bytes;
    const report = JSON.parse(json.toString());
    assert.equal(report.format, 'littleworld-diagnostic'); assert.equal(report.schemaVersion, 1);
    assert.equal(report.build.commit, expectedCommit); assert.equal(report.containsHiddenWorldInformation, true);
    assert.ok(report.snapshot.soldiers.length > 0); assert.ok(json.length <= 4 * 1024 * 1024);
    assert.equal(await current.evaluate(() => JSON.stringify(littleworld.state)), before);
    assert.match(await current.locator('[data-slot="debug-status"]').textContent(), /report ready/);
    assert.equal(await current.locator('[data-slot="debug-download"]').getAttribute('download'), file.suggestedFilename());
    return { name: file.suggestedFilename(), fileBytes: bytes.length, jsonBytes: json.length, captureMs: report.recorder.captureMs,
      schemaVersion: report.schemaVersion, commit: report.build.commit, sourceStep: report.world.step, history: report.history.length };
  }
  await check('Desktop debug button downloads a bounded, exact-build diagnostic without altering the world or uploading data', async () => {
    await page.locator('[data-action="settings"]').click();
    const requests = [], listen = request => { if (/^https?:/.test(request.url())) requests.push(request.url()); };
    page.on('request', listen);
    try { const result = await download(page, 'debug-desktop'); assert.deepEqual(requests, []); console.log(JSON.stringify({ debugDownload: { ...result, source: 'desktop', exportHttpRequests: 0 } })); return result; }
    finally { page.off('request', listen); await page.locator('[data-action="settings"]').click(); }
  });
  await check('Touch mobile saves plain JSON when compression is unavailable and retains a manual save link', async () => {
    // Only one software-rendered world at a time: the desktop assertions are
    // complete, and the following combat checks deliberately use fresh fixtures.
    await page.goto('about:blank');
    const context = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, acceptDownloads: true });
    const mobile = await context.newPage();
    const errors = []; mobile.on('pageerror', error => errors.push(error.message));
    try {
      await boot(mobile, config); await mobile.evaluate(() => { globalThis.CompressionStream = undefined; });
      await mobile.locator('[data-action="settings"]').tap();
      await mobile.locator('[data-action="download-debug"]').scrollIntoViewIfNeeded();
      const rect = await mobile.locator('[data-action="download-debug"]').boundingBox();
      assert.ok(rect && rect.x >= 0 && rect.x + rect.width <= 390 && rect.height >= 42);
      const result = await download(mobile, 'debug-mobile', true); assert.match(result.name, /\.json$/);
      const savedAgain = mobile.waitForEvent('download'); await mobile.locator('[data-slot="debug-download"]').tap();
      assert.equal((await savedAgain).suggestedFilename(), result.name);
      await mobile.screenshot({ path: output(config, 'debug-mobile-settings.png') });
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ debugDownload: { ...result, source: 'mobile', touchEmulated: true, manualSaveWorks: true, errors } }));
      return { ...result, touchEmulated: true, bounds: rect, manualSaveWorks: true };
    } finally { await context.close(); await boot(page, config); }
  });
}
