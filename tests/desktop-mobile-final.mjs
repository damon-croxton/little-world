// Supplemental local Chrome QA. CDP touch emulation is not physical-device QA.
import assert from 'node:assert/strict';
import { configuration, launch, boot, environment, observeErrors, save, output, TOUCH_VIEWPORTS, touchContextOptions } from './browser-v2.mjs';

const config = configuration({ ...process.env, QA_OUTPUT_DIR: 'screenshots' });
const report = { at: new Date().toISOString(), scope: 'Installed headless Chrome; portrait and landscape coarse-pointer touch emulation with native CDP touch input. No physical iPhone claim.', checks: [], errors: [], warnings: [], screenshots: [] };
let browser, page, currentDevice;
const button = (action, value) => page.locator(`[data-action="${action}"]${value === undefined ? '' : `[data-value="${value}"]`}`);
const settle = () => page.waitForTimeout(350);
const state = () => page.evaluate(() => ({ step: littleworld.state.step, tick: littleworld.state.tick, seed: littleworld.state.seed, civs: littleworld.state.factions.length, paused: littleworld.view.paused, speed: littleworld.view.speed, selected: littleworld.view.selectedId, overlay: littleworld.view.overlay, camera: littleworld.camera.position.toArray(), target: littleworld.controls.target.toArray(), scroll: [scrollX, scrollY] }));
async function shot(name) {
  const path = output(config, `mobile-final-${currentDevice}-${name}.png`);
  await page.screenshot({ path });
  report.screenshots.push({ path, state: await state() });
}
async function check(name, fn) {
  try { report.checks.push({ name: `${currentDevice}: ${name}`, status: 'passed', detail: await fn() }); console.log(`PASS ${currentDevice}: ${name}`); }
  catch (error) { report.checks.push({ name: `${currentDevice}: ${name}`, status: 'failed', error: error.stack }); console.log(`FAIL ${currentDevice}: ${name}: ${error.message}`); await shot(`failure-${report.checks.length}`).catch(() => {}); }
  await save(config, 'mobile-final-report.json', report);
}
async function fits(selector, viewport) {
  const box = await page.locator(selector).boundingBox();
  assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, `${selector} clipped: ${JSON.stringify(box)}`);
  return box;
}
function sameCamera(before, after) {
  assert.ok(Math.hypot(...after.camera.map((x, i) => x - before.camera[i])) < .001, 'Panel touch moved world camera');
  assert.ok(Math.hypot(...after.target.map((x, i) => x - before.target[i])) < .001, 'Panel touch moved camera target');
  assert.equal(after.step, before.step, 'Paused panel interaction advanced simulation');
  assert.deepEqual(after.scroll, [0, 0], 'Panel interaction scrolled page');
}
try {
  browser = await launch(config);
  for (const viewport of TOUCH_VIEWPORTS) {
    currentDevice = viewport.name;
    const context = await browser.newContext(touchContextOptions(viewport));
    try {
      page = await context.newPage(); page.setDefaultTimeout(12000); observeErrors(page, report);
      await boot(page, config); await page.waitForTimeout(1200);
      report.environment ??= await environment(page, browser, config);
      const client = await context.newCDPSession(page);
      const dispatch = (type, points) => client.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, i) => ({ id: i + 1, x: p.x, y: p.y, radiusX: 6, radiusY: 6, force: 1 })) });
      const swipe = async (from, to) => {
        await dispatch('touchStart', [from]);
        for (let i = 1; i <= 8; i++) { await dispatch('touchMove', [{ x: from.x + (to.x - from.x) * i / 8, y: from.y + (to.y - from.y) * i / 8 }]); await page.waitForTimeout(30); }
        await dispatch('touchEnd', []); await settle();
      };
      await check('collapsed layout and fixed canvas', async () => {
        for (const selector of ['.faction-index', '.inspector', '.world-chronicle', '.observation-tools']) assert.equal(await page.locator(selector).isVisible(), false);
        for (const selector of ['.time-console', '.mobile-toolbar', '#app canvas']) await fits(selector, viewport);
        const css = await page.evaluate(() => ({ coarse: matchMedia('(pointer: coarse)').matches, touchPoints: navigator.maxTouchPoints, bodyOverscroll: getComputedStyle(document.body).overscrollBehavior, canvasTouchAction: getComputedStyle(document.querySelector('#app canvas')).touchAction, documentWidth: document.documentElement.scrollWidth, documentHeight: document.documentElement.scrollHeight, width: innerWidth, height: innerHeight }));
        assert.equal(css.coarse, true); assert.ok(css.touchPoints > 0); assert.equal(css.canvasTouchAction, 'none'); assert.equal(css.bodyOverscroll, 'none'); assert.equal(css.documentWidth, viewport.width); assert.equal(css.documentHeight, viewport.height);
        await shot('collapsed'); return css;
      });
      await check('touch pause and all five speed buttons', async () => {
        const before = await state(); await button('pause').tap(); await page.waitForTimeout(550); assert.ok((await state()).step > before.step); await button('pause').tap();
        const results = [];
        for (const speed of [1, 2, 4, 16, 32]) { await button('speed', speed).tap(); const start = await state(); assert.equal(start.speed, speed); assert.equal(start.paused, false); await page.waitForTimeout(400); await button('pause').tap(); const end = await state(); assert.ok(end.step > start.step); assert.equal(end.paused, true); results.push({ speed, pulses: end.step - start.step }); }
        const frozen = await state(); await page.waitForTimeout(500); assert.equal((await state()).step, frozen.step); return results;
      });
      await check('native slider taps apply only on Reset and restore collapsed menus', async () => {
        const results = [];
        for (const civs of [3, 5, 6, 4]) {
          await button('settings').tap(); await settle(); await fits('#atlas-settings', viewport);
          const input = page.locator('#atlas-civs'); await input.scrollIntoViewIfNeeded(); const box = await input.boundingBox();
          await page.touchscreen.tap(box.x + 8 + (box.width - 16) * (civs - 3) / 3, box.y + box.height / 2); await settle();
          assert.equal(await input.inputValue(), String(civs)); assert.equal(await page.locator('[data-slot="civ-count"]').innerText(), String(civs));
          const oldCount = (await state()).civs; assert.notEqual(oldCount, civs);
          await page.locator('#atlas-seed').fill(`mobile-final-${viewport.name}-${civs}`); if (civs === 5) await shot('settings');
          await page.locator('.seed-form button[type="submit"]').tap(); await settle();
          const after = await state(); assert.equal(after.civs, civs); assert.equal(after.tick, 0); assert.equal(after.step, 0); assert.equal(after.paused, true); assert.equal(after.seed, `mobile-final-${viewport.name}-${civs}`);
          assert.equal(await page.locator('#atlas-settings').isVisible(), false); assert.equal(await page.locator('.faction-index').isVisible(), false); assert.equal(await page.locator('.inspector').isVisible(), false);
          results.push({ requested: civs, previous: oldCount, actual: after.civs, step: after.step });
        }
        return results;
      });
      await check('Societies selects real colony; Inspect scroll remains contained', async () => {
        await button('mobile-panel', 'factions').tap(); await settle(); await fits('#atlas-inhabitants', viewport); await shot('societies');
        const colony = page.locator('.faction-entry').last(); const id = await colony.getAttribute('data-value'); await colony.tap(); await settle(); assert.equal((await state()).selected, id);
        // Selecting a colony already opens Inspect; another tap would close it.
        assert.equal(await button('mobile-panel', 'inspector').getAttribute('aria-pressed'), 'true'); assert.equal(await page.locator('#atlas-inhabitants').isVisible(), false); await fits('#atlas-inspector', viewport); await shot('inspect');
        const scroller = page.locator('.selection-body'); const box = await scroller.boundingBox(); assert.ok(box.height > 30, `Inspector scroll area unusably small: ${JSON.stringify(box)}`);
        const start = await state(); const scrollBefore = await scroller.evaluate(el => ({ top: el.scrollTop, height: el.clientHeight, content: el.scrollHeight })); assert.ok(scrollBefore.content > scrollBefore.height);
        const from = { x: box.x + box.width / 2, y: box.y + box.height * .8 }, to = { x: from.x, y: box.y + box.height * .2 };
        await swipe(from, to); const scrollAfter = await scroller.evaluate(el => el.scrollTop); assert.ok(scrollAfter > scrollBefore.top, 'Inspector did not scroll on native touch swipe');
        for (let i = 0; i < 5; i++) await swipe(from, to);
        const end = await state(); sameCamera(start, end); await shot('inspect-scrolled');
        await page.locator('#atlas-inspector [data-action="close-mobile-panel"]').tap(); assert.equal(await page.locator('#atlas-inspector').isVisible(), false);
        return { selected: id, scrollBefore, scrollAfter, afterCloseScrollTop: await scroller.evaluate(el => el.scrollTop), pageScroll: end.scroll, cameraStationary: true };
      });
      await check('Views overlay taps and Map collapse restore overview', async () => {
        await button('mobile-panel', 'views').tap(); await settle(); await fits('.observation-tools', viewport);
        for (const overlay of ['territory', 'knowledge', 'routes', 'resources', 'none']) { await button('overlay', overlay).tap(); assert.equal((await state()).overlay, overlay); assert.equal(await button('overlay', overlay).getAttribute('aria-pressed'), 'true'); }
        await shot('views'); await button('overview').tap(); await page.waitForTimeout(1000);
        assert.equal(await page.locator('.observation-tools').isVisible(), false); assert.equal(await page.locator('.inspector').isVisible(), false); assert.equal(await page.locator('.faction-index').isVisible(), false); return state();
      });
      await check('settings scroll and boundary swipes do not move camera or page', async () => {
        await button('settings').tap(); await settle(); const panel = page.locator('#atlas-settings'); const box = await panel.boundingBox(); const start = await state();
        const before = await panel.evaluate(el => ({ top: el.scrollTop, height: el.clientHeight, content: el.scrollHeight }));
        // Blank panel margin avoids touching the native range or select controls.
        const from = { x: box.x + 5, y: box.y + box.height * .85 }, to = { x: from.x, y: box.y + box.height * .2 };
        for (let i = 0; i < 5; i++) await swipe(from, to);
        const end = await state(), after = await panel.evaluate(el => el.scrollTop); sameCamera(start, end); if (before.content > before.height) assert.ok(after > before.top, 'Scrollable settings did not move on touch');
        await shot('settings-scrolled'); await button('settings').tap(); return { before, after, cameraStationary: true, pageScroll: end.scroll };
      });
      await client.detach();
    } finally { await context.close(); }
  }
  assert.deepEqual(report.errors, []);
} catch (error) { report.fatal = error.stack; console.error(error); }
finally {
  await browser?.close(); report.browserClosed = true; report.passed = report.checks.filter(c => c.status === 'passed').length; report.failed = report.checks.filter(c => c.status === 'failed').length; report.status = report.fatal ? 'aborted' : 'completed'; await save(config, 'mobile-final-report.json', report); console.log(JSON.stringify({ passed: report.passed, failed: report.failed, fatal: report.fatal, browserClosed: true, report: output(config, 'mobile-final-report.json') }));
}
if (report.failed || report.fatal) process.exitCode = 1;
