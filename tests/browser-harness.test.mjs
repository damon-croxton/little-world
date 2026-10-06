// Pure Node checks for the portable harness. These never launch a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { configuration, frameSummary, selectedCrewEvidence, TOUCH_VIEWPORTS, touchContextOptions } from './browser-v2.mjs';

test('browser configuration preserves hosted subpaths and chooses portable Chromium', () => {
  const config = configuration({ BASE_URL: 'https://example.test/little-world', QA_SEED: 'water & stone' });
  const url = new URL(config.url);
  assert.equal(url.pathname, '/little-world/');
  assert.equal(url.searchParams.get('seed'), 'water & stone');
  assert.equal(config.civCount, 4);
  assert.equal(url.searchParams.get('civs'), '4');
  assert.equal(config.quality, 'low');
  assert.equal(config.lastCycle, 1200);
  assert.equal(config.launchOptions.channel, undefined);
  assert.equal(config.launchOptions.executablePath, undefined);
  assert.ok(config.launchOptions.args.every(arg => !arg.includes('d3d11')));
});

test('browser configuration makes full and software rendering explicit', () => {
  const config = configuration({ QA_TIER: 'full', QA_SOFTWARE_RENDERING: '1', BROWSER_ARGS: '["--example-test-flag"]' });
  assert.equal(config.lastCycle, 3000);
  assert.equal(config.quality, 'high');
  assert.ok(config.launchOptions.args.includes('--use-angle=swiftshader'));
  assert.ok(config.launchOptions.args.includes('--example-test-flag'));
  assert.throws(() => configuration({ BROWSER_CHANNEL: 'chrome', BROWSER_EXECUTABLE_PATH: '/tmp/chrome' }), /Choose/);
  assert.throws(() => configuration({ BROWSER_ARGS: '"--invalid"' }), /JSON array/);
  assert.throws(() => configuration({ QA_TIER: 'tiny' }), /QA_TIER/);
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
