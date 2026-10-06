// Pure Node checks for the portable harness. These never launch a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { configuration, frameSummary, waitForRenderedFrames, observeSelectedCrewReturn, selectedCrewEvidence, TOUCH_VIEWPORTS, touchContextOptions } from './browser-v2.mjs';

function pageContext(world, onFrame = () => {}) {
  let frameRequests = 0;
  return {
    get frameRequests() { return frameRequests; },
    evaluate(fn, argument) {
      return runInNewContext(`(${fn.toString()})(argument)`, {
        argument, window: { littleworld: world }, performance, Date, setTimeout, clearTimeout,
        requestAnimationFrame: callback => { const index = ++frameRequests; return setTimeout(() => { onFrame(index); callback(performance.now()); }, 0); },
        cancelAnimationFrame: clearTimeout,
      });
    },
  };
}

test('browser configuration preserves hosted subpaths and chooses portable Chromium', () => {
  const config = configuration({ BASE_URL: 'https://example.test/little-world', QA_SEED: 'water & stone' });
  const url = new URL(config.url);
  assert.equal(url.pathname, '/little-world/');
  assert.equal(url.searchParams.get('seed'), 'water & stone');
  assert.equal(config.civCount, 4);
  assert.equal(url.searchParams.get('civs'), '4');
  assert.equal(config.quality, 'low');
  assert.equal(url.searchParams.get('quality'), 'low');
  assert.equal(config.lastCycle, 1200);
  assert.equal(config.launchOptions.channel, undefined);
  assert.equal(config.launchOptions.executablePath, undefined);
  assert.ok(config.launchOptions.args.every(arg => !arg.includes('d3d11')));
});

test('browser configuration makes full and software rendering explicit', () => {
  const config = configuration({ QA_TIER: 'full', QA_SOFTWARE_RENDERING: '1', BROWSER_ARGS: '["--example-test-flag"]' });
  assert.equal(config.lastCycle, 3000);
  assert.equal(config.quality, 'high');
  assert.equal(new URL(config.url).searchParams.get('quality'), 'high');
  assert.ok(config.launchOptions.args.includes('--use-angle=swiftshader'));
  assert.ok(config.launchOptions.args.includes('--example-test-flag'));
  assert.throws(() => configuration({ BROWSER_CHANNEL: 'chrome', BROWSER_EXECUTABLE_PATH: '/tmp/chrome' }), /Choose/);
  assert.throws(() => configuration({ BROWSER_ARGS: '"--invalid"' }), /JSON array/);
  assert.throws(() => configuration({ QA_TIER: 'tiny' }), /QA_TIER/);
});

test('camera synchronization ignores stale animation callbacks and multiple compositor passes', async () => {
  const world = { renderer: { info: { render: { frame: 10 } } } };
  const renderFrames = [10, 10, 15, 15, 22];
  const page = pageContext(world, index => { world.renderer.info.render.frame = renderFrames[index - 1]; });
  const result = await waitForRenderedFrames(page, { minimumFrames: 2, maximumMs: 1000 });
  assert.equal(page.frameRequests, 5);
  assert.equal(result.frames, 2);
  assert.equal(result.firstRenderFrame, 10);
  assert.equal(result.lastRenderFrame, 22);
});

test('camera synchronization fails within its bound when rendering never updates', async () => {
  const page = pageContext({ renderer: { info: { render: { frame: 10 } } } });
  await assert.rejects(waitForRenderedFrames(page, { maximumMs: 30 }), /Timed out waiting for 2 rendered frames; observed 0/);
  await assert.rejects(waitForRenderedFrames(page, { minimumFrames: 0 }), /positive frame count/);
});

test('frame summary separates identity-matched positions from actual matrix movement', () => {
  const base = { tick: 1, step: 10, calls: 2, triangles: 30 };
  const frame = (wallMs, x, tick = 1) => ({ ...base, tick, wallMs, samples: [{ id: 'person', x, y: 0, z: 0, visible: true, working: 0 }], meshSamples: [{ id: 'person', meshUuid: 'mesh', instanceIndex: 0, x, y: 0, z: 0 }] });
  const moving = frameSummary([frame(0, 0), frame(20, 1), frame(40, 2, 2)]);
  assert.equal(moving.sameCyclePositionChanges, 1);
  assert.equal(moving.sameCycleRenderMatrixChanges, 1);
  assert.equal(moving.meanMs, 20);
  assert.equal(moving.derivedFps, 50);
  const frozen = frameSummary([frame(0, 2), frame(20, 2)]);
  assert.equal(frozen.sameCyclePositionChanges, 0);
  assert.equal(frozen.sameCycleRenderMatrixChanges, 0);
});


test('harvesting proof requires the selected crew receipt and visible followed return', () => {
  const returning = { group: { id: 'crew-1', phase: 'returning' }, followId: 'crew-1', samples: [{ groupId: 'crew-1', visible: true }], deliveryDetails: null };
  const differentCrew = { group: null, followId: null, samples: [], deliveryDetails: { groupId: 'crew-2', amount: 80 } };
  const misleading = selectedCrewEvidence([returning, differentCrew], 'crew-1');
  assert.equal(misleading.selectedDelivery, null, 'Another crew cannot satisfy selected delivery');
  assert.equal(misleading.selectedTeamFinished, true);
  assert.equal(misleading.visibleReturningFrames, 1);
  const delivered = { ...differentCrew, deliveryDetails: { groupId: 'crew-1', amount: 60 } };
  const proof = selectedCrewEvidence([returning, delivered], 'crew-1');
  assert.deepEqual(proof.selectedDelivery, { groupId: 'crew-1', amount: 60 });
  assert.equal(selectedCrewEvidence([{ ...returning, followId: null }, delivered], 'crew-1').visibleReturningFrames, 0);
});

test('return observer pauses on selected crew completion before another frame can replace its receipt', async () => {
  const home = { id: 'home', deliveryDetails: null }, crew = { id: 'crew-1', phase: 'working', x: 1, z: 1, carrying: { materials: 60 } };
  const world = { state: { groups: [crew], settlements: [home], tick: 12, step: 128 }, view: { paused: false, speed: 1, followId: crew.id }, camera: { position: { toArray: () => [1, 2, 3] } }, controls: { target: { toArray: () => [0, 0, 0] } }, getMotionSamples: () => world.state.groups.map(g => ({ groupId: g.id, visible: true })) };
  let pauses = 0;
  world.actions = { togglePause: () => { pauses++; world.view.paused = !world.view.paused; } };
  const page = pageContext(world, index => {
    world.state.step++;
    if (index === 2) crew.phase = 'returning';
    if (index === 3) { world.state.groups = []; home.deliveryDetails = { groupId: crew.id, amount: 60 }; }
    if (index > 3) home.deliveryDetails = { groupId: 'crew-2', amount: 80 };
  });
  const frames = await page.evaluate(observeSelectedCrewReturn, { groupId: crew.id, originId: home.id, videoStarted: Date.now(), maximumMs: 1000 });
  assert.equal(page.frameRequests, 3);
  assert.equal(pauses, 1);
  assert.equal(world.view.paused, true);
  home.deliveryDetails.groupId = 'crew-2';
  const proof = selectedCrewEvidence(frames, crew.id);
  assert.equal(proof.selectedDelivery.groupId, crew.id, 'Receipt evidence must retain its value at delivery');
  assert.equal(proof.selectedTeamFinished, true);
  assert.equal(proof.visibleReturningFrames, 1);
  assert.ok(frames.every(frame => frame.speed === 1));
});

test('return observer pauses at its time limit without claiming a finished delivery', async () => {
  const crew = { id: 'crew-1', phase: 'working', carrying: {} };
  const world = { state: { groups: [crew], settlements: [] }, view: { paused: false, speed: 1 }, camera: { position: { toArray: () => [] } }, controls: { target: { toArray: () => [] } }, getMotionSamples: () => [] };
  world.actions = { togglePause: () => { world.view.paused = !world.view.paused; } };
  const frames = await pageContext(world).evaluate(observeSelectedCrewReturn, { groupId: crew.id, originId: 'home', videoStarted: Date.now(), maximumMs: 30 });
  assert.equal(world.view.paused, true);
  assert.equal(selectedCrewEvidence(frames, crew.id).selectedTeamFinished, false);
  assert.equal(selectedCrewEvidence(frames, crew.id).selectedDelivery, null);
});

test('browser civilization controls cover normal counts and reject invalid fixture settings', () => {
  for (const civCount of [3, 4, 5, 6]) {
    const config = configuration({ QA_CIVS: String(civCount) });
    assert.equal(config.civCount, civCount);
    assert.equal(new URL(config.url).searchParams.get('civs'), String(civCount));
  }
  for (const invalid of ['2', '7', 'NaN', '4.5']) assert.throws(() => configuration({ QA_CIVS: invalid }), /QA_CIVS/);
});


test('mobile QA enables actual touch context for portrait and wide landscape', () => {
  assert.deepEqual(TOUCH_VIEWPORTS.map(v => [v.width, v.height]), [[390, 844], [844, 390]]);
  for (const viewport of TOUCH_VIEWPORTS) {
    const options = touchContextOptions(viewport);
    assert.equal(options.hasTouch, true); assert.equal(options.isMobile, true);
    assert.deepEqual(options.viewport, { width: viewport.width, height: viewport.height });
  }
  assert.throws(() => touchContextOptions({ width: 0, height: 390 }), /positive integer/);
});
