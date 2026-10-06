import { chromium } from '@playwright/test';
import { createSimulation, stepSimulation, getSummary } from '../src/sim/core.js';
import { writeFile } from 'node:fs/promises';

const seed = 'first-light';
const url = process.env.BASE_URL || 'http://127.0.0.1:4174/';
const differences = function differences(a, b, tolerance = 0, path = '', out = []) {
  if (out.length >= 15 || Object.is(a, b)) return out;
  if (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tolerance) return out;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) differences(a[key], b[key], tolerance, `${path}.${key}`, out);
  } else out.push({ path, node: a, browser: b, delta: typeof a === 'number' && typeof b === 'number' ? b - a : undefined });
  return out;
};
const plain = value => JSON.parse(JSON.stringify(value));
const report = { seed, url, node: process.versions, checkpoints: [] };
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  report.browser = browser.version();
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  if (process.env.AUDIT_MODE === 'narrow') {
    await page.goto(`${url}src/shared.js`);
    const node = createSimulation(seed); stepSimulation(node, 1500);
    const pick = state => ({ step: state.step, groups: state.groups.map(g => ({ id: g.id, phase: g.phase, x: g.x, z: g.z, formationSlots: g.formationSlots, units: g.units, combat: g.combat })) });
    const baseline = plain(pick(node)), snapshots = [];
    for (let pulse = 1501; pulse <= 1750; pulse++) { stepSimulation(node, 1); snapshots.push(plain(pick(node))); }
    report.narrow = await page.evaluate(async ({ seed, baseline, snapshots, diffSource, pickSource }) => {
      const { createSimulation, stepSimulation } = await import('/src/sim/core.js');
      const differences = (0, eval)(`(${diffSource})`), pick = (0, eval)(`(${pickSource})`);
      const state = createSimulation(seed); stepSimulation(state, 1500);
      const baselineDifferences = differences(baseline, JSON.parse(JSON.stringify(pick(state))), 1e-7);
      let previous = JSON.parse(JSON.stringify(pick(state)));
      for (const node of snapshots) {
        stepSimulation(state, 1); const browser = JSON.parse(JSON.stringify(pick(state))), diff = differences(node, browser, 1e-7);
        if (diff.length) return { baselineDifferences, firstPulse: state.step, differences: diff, node, browser, browserBefore: previous };
        previous = browser;
      }
      return { baselineDifferences, firstPulse: null };
    }, { seed, baseline, snapshots, diffSource: differences.toString(), pickSource: pick.toString() });
    const first = report.narrow;
    if (first.firstPulse) first.nodeBefore = first.firstPulse === 1501 ? baseline : snapshots[first.firstPulse - 1502];
    console.log('NARROW', JSON.stringify({ firstPulse: first.firstPulse, baselineDifferences: first.baselineDifferences, differences: first.differences }));
    await writeFile(process.env.AUDIT_OUTPUT || 'tests/desktop-determinism-audit-report.json', JSON.stringify(report, null, 2));
  } else {
  await page.goto(`${url}?seed=${seed}&civs=4&quality=low`);
  await page.waitForFunction(() => window.littleworld);
  const initial = await page.evaluate(async seed => {
    const api = await import('/src/sim/core.js'); window.auditCore = api;
    if (!littleworld.view.paused) littleworld.actions.togglePause();
    littleworld.reset(seed); window.auditPure = api.createSimulation(seed);
    return { pure: JSON.parse(JSON.stringify(auditPure)), live: JSON.parse(JSON.stringify(littleworld.state)) };
  }, seed);
  let node = createSimulation(seed);
  report.initialNodeBrowser = differences(plain(node), initial.pure);
  report.initialPureLive = differences(initial.pure, initial.live);
  console.log('INITIAL', JSON.stringify({ nodeBrowser: report.initialNodeBrowser, pureLive: report.initialPureLive }));
  const render = await page.evaluate(async () => {
    const before = JSON.stringify(littleworld.state);
    for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame);
    return { unchanged: before === JSON.stringify(littleworld.state), step: littleworld.state.step };
  });
  report.pausedRendering = render; console.log('PAUSED_RENDER', JSON.stringify(render));
  for (let cycle = 25; cycle <= 1200; cycle += 25) {
    stepSimulation(node, 250);
    const snapshot = await page.evaluate(() => {
      auditCore.stepSimulation(auditPure, 250); littleworld.step(25);
      return { pure: JSON.parse(JSON.stringify(auditPure)), live: JSON.parse(JSON.stringify(littleworld.state)) };
    });
    const nodeBrowser = differences(plain(node), snapshot.pure, 1e-7);
    const pureLive = differences(snapshot.pure, snapshot.live);
    const entry = { cycle, node: getSummary(node), pure: { tick: snapshot.pure.tick, stats: snapshot.pure.stats, population: snapshot.pure.settlements.reduce((n, s) => n + s.population, 0) }, live: { tick: snapshot.live.tick, stats: snapshot.live.stats, population: snapshot.live.settlements.reduce((n, s) => n + s.population, 0) } };
    report.checkpoints.push(entry);
    if (!report.firstNodeBrowser && nodeBrowser.length) { report.firstNodeBrowser = { cycle, differences: nodeBrowser }; console.log('FIRST_NODE_BROWSER', JSON.stringify(report.firstNodeBrowser)); }
    if (!report.firstPureLive && pureLive.length) { report.firstPureLive = { cycle, differences: pureLive }; console.log('FIRST_PURE_LIVE', JSON.stringify(report.firstPureLive)); }
    if (cycle % 200 === 0) console.log('CHECKPOINT', cycle, entry.node.population, entry.pure.population, entry.live.population);
  }
  report.advance = await page.evaluate(async seed => {
    littleworld.reset(seed); const result = await littleworld.advance(1200);
    return { result, summary: auditCore.getSummary(littleworld.state), pureLive: JSON.stringify(auditPure) === JSON.stringify(littleworld.state) };
  }, seed);
  console.log('ADVANCE', JSON.stringify(report.advance));
  report.last = report.checkpoints.at(-1);
  await writeFile(process.env.AUDIT_OUTPUT || 'tests/desktop-determinism-audit-report.json', JSON.stringify(report, null, 2));
  }
} finally { await browser.close(); }
