import test from 'node:test';
import assert from 'node:assert/strict';
import { createSimulation, stepSimulation } from '../src/sim/core.js';
import { SimulationClock, SIM_DT } from '../src/clock.js';
import { generateWorld, terrainAt, WORLD_RADIUS } from '../src/world.js';
import { initializeLedger, RESOURCES } from '../src/sim/economy.js';
import { auditState, population } from './balance.mjs';

test('world seeds deterministically generate traversable starts and finite resources at V2 scale', () => {
  const a = generateWorld('qa-world'), b = generateWorld('qa-world'), c = generateWorld('qa-other');
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.starts, c.starts);
  assert.equal(WORLD_RADIUS, 150);
  assert.equal(a.starts.length, 6);
  assert.ok(a.nodes.length >= 300 && a.nodes.length <= 500);
  assert.equal(new Set(a.nodes.map(n => n.id)).size, a.nodes.length);
  for (const start of a.starts) {
    assert.ok(terrainAt(start.x, start.z, 'qa-world').traversable);
    for (const kind of ['food', 'water', 'energy', 'materials']) assert.ok(a.nodes.some(n => n.kind === kind && Math.hypot(n.x - start.x, n.z - start.z) < 30), `start lacks nearby ${kind}`);
  }
  for (const node of a.nodes) {
    assert.ok(node.amount > 0 && node.amount <= node.maxAmount);
    if (['ore', 'salvage', 'crystal'].includes(node.subtype)) assert.equal(node.regeneration, 0);
  }
});

test('batched pulses and separate pulses have exactly equal state', () => {
  const a = createSimulation('qa-determinism'), b = createSimulation('qa-determinism');
  stepSimulation(a, 2500);
  for (let pulse = 0; pulse < 2500; pulse++) stepSimulation(b, 1);
  assert.deepEqual(a, b);
  auditState(a);
  assert.equal(a.step, 2500);
  assert.equal(a.tick, 250);
  assert.equal(a.time, 250);
});

test('10 Hz clock is frame independent and retains fractional time through pauses', () => {
  assert.equal(SIM_DT, .1);
  const execute = deltas => {
    const state = createSimulation('qa-clock'), clock = new SimulationClock();
    for (const delta of deltas) clock.advance(delta, 1, false, n => stepSimulation(state, n));
    return { state, clock };
  };
  const frames = execute(Array(1200).fill(1 / 60));
  const coarse = execute(Array(80).fill(.25));
  assert.equal(frames.state.step, 200);
  assert.deepEqual(frames.state, coarse.state);
  const stateBefore = structuredClone(frames.state);
  frames.clock.advance(.035, 1, false, n => stepSimulation(frames.state, n));
  const remainder = frames.clock.remainder;
  frames.clock.advance(12, 100, true, n => stepSimulation(frames.state, n));
  assert.equal(frames.clock.remainder, remainder);
  assert.deepEqual(frames.state, stateBefore);
  assert.ok(Math.abs(frames.clock.alpha - .35) < 1e-8);
  const accelerated = createSimulation('qa-clock'), clock = new SimulationClock();
  for (let i = 0; i < 120; i++) clock.advance(1 / 60, 10, false, n => stepSimulation(accelerated, n));
  assert.deepEqual(accelerated, coarse.state);
});

test('continuous groups move on subcycle pulses and preserve previous positions', () => {
  const state = createSimulation('qa-motion');
  stepSimulation(state, 300);
  const before = new Map(state.groups.map(g => [g.id, { x: g.x, z: g.z, phase: g.phase }]));
  stepSimulation(state, 1);
  let moved = 0;
  for (const group of state.groups) {
    const old = before.get(group.id);
    if (!old) continue;
    assert.equal(group.prevX, old.x, `${group.id} prevX`);
    assert.equal(group.prevZ, old.z, `${group.id} prevZ`);
    if (Math.hypot(group.x - old.x, group.z - old.z) > 1e-8) moved++;
  }
  assert.ok(moved > 0, 'all physical movement froze between whole cycles');
  assert.equal(state.tick, 30);
  assert.equal(state.time, 30.1);
});

test('initial population consists of hundreds of actual individuals and all commitments fit it', () => {
  const state = createSimulation('first-light');
  assert.equal(state.settlements.length, 6);
  assert.ok(population(state) >= 480 && population(state) <= 720);
  for (const home of state.settlements) {
    assert.ok(home.buildings.length >= 8 && home.buildings.length <= 12);
    assert.ok(home.radius >= 7);
  }
  auditState(state);
});

test('first 300 cycles preserve inventories, population bounds, and prior intelligence at every cycle', () => {
  const state = createSimulation('qa-accounting');
  const initial = population(state);
  for (let cycle = 0; cycle < 300; cycle++) {
    stepSimulation(state, 10);
    auditState(state);
    assert.equal(population(state), initial + state.stats.births - state.stats.deaths);
  }
  assert.ok(Object.values(state.resourceLedger).some(l => l.extracted > 0), 'no physical extraction');
  assert.ok(Object.values(state.resourceLedger).some(l => l.delivered > 0), 'no cargo reached home');
});

test('a real worker depletes a finite node into cargo and credits storage only on physical return', () => {
  const state = createSimulation('qa-physical-cargo');
  stepSimulation(state, 10);
  const worker = state.groups.find(g => g.kind === 'worker');
  assert.ok(worker, 'no worker launched');
  const home = state.settlements.find(h => h.id === worker.originId);
  const node = state.nodes.find(n => n.id === worker.targetId);
  // A nearly exhausted natural target isolates the last-unit boundary case.
  node.amount = 1;
  node.regeneration = 0;
  state.groups = [worker];
  for (const faction of state.factions) faction.knowledge = Object.fromEntries(Object.entries(faction.knowledge).filter(([, k]) => k.kind === 'settlement'));
  initializeLedger(state);
  let extracted = false, delivered = false, observedOutbound = false, observedHauling = false;
  const initialDelivered = state.resourceLedger[node.kind].delivered;
  for (let pulse = 0; pulse < 1500; pulse++) {
    const g = state.groups.find(g => g.id === worker.id);
    if (!g) break;
    const old = { x: g.x, z: g.z, phase: g.phase, extracted: g.extractedTotal, cargo: g.carrying[node.kind], stock: home.stock[node.kind], amount: node.amount, step: state.step };
    if (g.phase === 'outbound') {
      observedOutbound = true;
      assert.equal(g.carrying[node.kind], 0);
    }
    if (g.phase === 'returning' && g.carrying[node.kind] > 0) observedHauling = true;
    stepSimulation(state, 1);
    const now = state.groups.find(candidate => candidate.id === worker.id);
    if (now && now.extractedTotal > old.extracted) {
      const amount = now.extractedTotal - old.extracted;
      extracted = true;
      assert.ok(Math.hypot(now.x - node.x, now.z - node.z) <= node.radius + 1e-8);
      assert.ok(Math.abs(old.amount - node.amount - amount) < 1e-8, 'extraction did not debit deposit');
      assert.ok(Math.abs(now.carrying[node.kind] - old.cargo - amount) < 1e-8, 'extraction did not enter cargo');
      if (state.step % 10 !== 0) assert.equal(home.stock[node.kind], old.stock, 'remote extraction credited home storage');
    }
    if (!now) {
      assert.equal(old.phase, 'returning');
      assert.ok(old.cargo > 0);
      assert.ok(Math.hypot(old.x - home.x, old.z - home.z) <= Math.min(3, home.radius * .28) + worker.speed * .1 + 1e-8, 'cargo arrived while workers remained far from home');
      assert.ok(Math.abs(state.resourceLedger[node.kind].delivered - initialDelivered - 1) < 1e-8);
      assert.equal(home.deliveryDetails.groupId, worker.id);
      delivered = true;
      break;
    }
  }
  assert.ok(observedOutbound && extracted && observedHauling && delivered, 'missing outbound/work/haul/delivery phase');
  assert.equal(node.amount, 0);
  assert.equal(worker.extractedTotal, 1);
  auditState(state);
});

test('without deposits or productive infrastructure there is no free resource production', () => {
  const state = createSimulation('qa-no-free-production');
  state.nodes = [];
  state.groups = [];
  for (const home of state.settlements) {
    home.buildings = home.buildings.filter(b => !['farm', 'power'].includes(b.kind));
    home.stock.materials = 0; // Prevent the ordinary funded construction system replacing them.
  }
  for (const faction of state.factions) faction.knowledge = Object.fromEntries(Object.entries(faction.knowledge).filter(([, k]) => k.kind === 'settlement'));
  initializeLedger(state);
  stepSimulation(state, 200);
  for (const kind of RESOURCES) {
    assert.equal(state.resourceLedger[kind].produced, 0);
    assert.equal(state.resourceLedger[kind].extracted, 0);
    assert.equal(state.resourceLedger[kind].regenerated, 0);
  }
  auditState(state);
});

test('empty stocks and no physical supply prevent births and self-funded growth', () => {
  const state = createSimulation('qa-empty-economy');
  state.nodes = [];
  state.groups = [];
  for (const home of state.settlements) {
    home.buildings = home.buildings.filter(b => !['farm', 'power'].includes(b.kind));
    for (const kind of RESOURCES) home.stock[kind] = 0;
  }
  initializeLedger(state);
  const initial = population(state);
  stepSimulation(state, 500);
  assert.equal(state.stats.births, 0);
  assert.ok(population(state) <= initial);
  for (const kind of RESOURCES) assert.equal(state.resourceLedger[kind].produced, 0);
  auditState(state);
});
