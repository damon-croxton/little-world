import test from 'node:test';
import assert from 'node:assert/strict';
import { createSimulation, stepSimulation, SIM_LIMITS } from '../src/sim/core.js';
import { initializeLedger, ledgerResidual, RESOURCES } from '../src/sim/economy.js';
import { auditState, population } from './balance.mjs';

function holdResearchAndScouts(state) {
  for (const f of state.factions) {
    f.lastScout = state.tick + 1000;
    f.knowledge = Object.fromEntries(Object.entries(f.knowledge).filter(([, k]) => k.kind === 'settlement'));
  }
}

test('full housing stops births and surplus residential construction without deleting inhabitants', () => {
  const state = createSimulation('regression-housing-cap');
  const home = state.settlements[0];
  holdResearchAndScouts(state);
  home.population = SIM_LIMITS.populationPerSettlement;
  while (home.buildings.filter(b => b.kind === 'housing').length < 24) {
    home.buildings.push({ ...home.buildings[1], id: `housing-fixture-${home.buildings.length}`, kind: 'housing' });
  }
  for (const kind of RESOURCES) home.stock[kind] = 1000;
  initializeLedger(state);
  const houses = home.buildings.filter(b => b.kind === 'housing').length;
  stepSimulation(state, 200);
  assert.equal(home.population, SIM_LIMITS.populationPerSettlement);
  assert.equal(home.housingCapacity, SIM_LIMITS.populationPerSettlement);
  assert.equal(home.buildings.filter(b => b.kind === 'housing').length, houses);
  assert.ok(home.buildings.some(b => b.kind === 'storage' && b.createdTick > 0), 'a full settlement did not redirect construction to needed storage');
  auditState(state);
});

test('colonists cannot found a site from depleted historical resource reports', () => {
  const state = createSimulation('regression-depleted-founding');
  state.tick = 400; state.step = 4000; state.time = 400;
  const home = state.settlements[0], faction = state.factions[0];
  holdResearchAndScouts(state);
  home.population = 400; home.lastExpansion = 0;
  for (const kind of RESOURCES) home.stock[kind] = 1000;
  for (const node of state.nodes) faction.knowledge[node.id] = {
    id: node.id, kind: 'resource', resourceKind: node.kind, x: node.x, z: node.z,
    observedTick: 400, reportedTick: 400, confidence: 1, amountEstimate: 0, abundanceEstimate: 0, richnessEstimate: node.richness,
  };
  initializeLedger(state);
  stepSimulation(state, 100);
  assert.equal(state.stats.expansions, 0);
  assert.ok(!state.groups.some(g => g.kind === 'colonist' && g.factionId === faction.id));
  auditState(state);
});

test('harvesting teams prepay finite journey rations and cannot live forever on a blocked return route', () => {
  const state = createSimulation('regression-stranded-workers');
  stepSimulation(state, 10);
  const worker = state.groups.find(g => g.kind === 'worker');
  assert.ok(worker);
  assert.ok(worker.provisionCycles >= 12);
  assert.ok(Object.values(worker.provisions).some(value => value > 0));
  const size = worker.size;
  worker.phase = 'returning'; worker.x = 149; worker.z = 149;
  worker.prevX = 149; worker.prevZ = 149; worker.provisionCycles = 1;
  const initial = population(state), deaths = state.stats.deaths, births = state.stats.births;
  stepSimulation(state, 1800);
  assert.ok((state.groups.find(g => g.id === worker.id)?.size || 0) < size, 'an exhausted, stranded workforce stayed immortal');
  assert.ok(state.stats.fieldDeaths > 0);
  assert.equal(population(state), initial + state.stats.births - births - (state.stats.deaths - deaths));
  auditState(state);
});

test('unrecorded subsystem inventory loss is exposed rather than relabelled as research', () => {
  const state = createSimulation('regression-no-ledger-autofill');
  state.tick = 23; state.step = 230; state.time = 23;
  holdResearchAndScouts(state);
  for (const home of state.settlements) for (const kind of RESOURCES) home.stock[kind] = 1000;
  const faction = state.factions[0], home = state.settlements[0];
  let progress = 0, injected = false;
  // Deliberately instrument one funded research update with an unknown sink.
  // The old compatibility bridge silently booked this as extra research cost.
  Object.defineProperty(faction.tech, 'progress', { enumerable: true, configurable: true,
    get: () => progress,
    set: value => { progress = value; if (!injected && value > 0) { home.stock.energy -= 7; injected = true; } },
  });
  initializeLedger(state);
  stepSimulation(state, 10);
  assert.ok(injected, 'fixture never reached the funded research step');
  assert.ok(Math.abs(ledgerResidual(state).energy + 7) < 1e-7);
  assert.equal(state.resourceLedger.energy.research, 8);
  assert.throws(() => auditState(state), /energy conservation residual/);
});
