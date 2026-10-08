import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SimulationClock } from '../src/clock.js';
import { createSimulation, stepSimulation } from '../src/sim/core.js';
import { housingDemand, refreshHousing } from '../src/sim/housing.js';
import { queueTraining, unitStats } from '../src/sim/military.js';
import { createEntities } from '../src/render/entities.js';
import { ledgerResidual } from '../src/sim/economy.js';
import { initializeLedger } from '../src/sim/economy.js';
import { stepStrategy, dispatchHarassment } from '../src/sim/strategy.js';
import { setMilitary } from './roster-fixtures.mjs';

test('busy frames yield after a bounded pulse budget without advancing uncomputed time', () => {
  const clock = new SimulationClock(); let cpu = 0, simulated = 0;
  const count = clock.advance(20, 32, false, n => { simulated += n * .1; cpu += 6; }, { maxPulses: 4, budgetMs: 8, maxBacklogSeconds: .5, now: () => cpu });
  assert.equal(count, 2); assert.equal(simulated, .2); assert.ok(Math.abs(clock.remainder - .3) < 1e-8);
  assert.equal(clock.droppedRequestedSeconds, 639.5);
  assert.equal(clock.advance(0, 1, false, () => {}, { maxPulses: 1 }), 1);
  const before = clock.remainder; assert.equal(clock.advance(10, 32, true, () => assert.fail()), 0); assert.equal(clock.remainder, before);
});

test('housing destruction immediately removes capacity and blocks unfunded quarters', () => {
  const s = createSimulation('first-light'), home = s.settlements[0], faction = s.factions.find(f => f.id === home.factionId);
  const spec = unitStats(faction.species, 'infantry');
  home.buildings.push({ id: 'test-producer', kind: spec.building, x: home.x + 20, z: home.z, hp: 160, progress: 1 });
  const before = refreshHousing(home, faction), population = home.population;
  const house = home.buildings.find(b => b.kind === 'housing'); house.destroyed = true; house.hp = 0;
  assert.equal(refreshHousing(home, faction), before - 28);
  assert.ok(housingDemand(home) > home.housingCapacity);
  assert.equal(queueTraining(s, home, faction, 'infantry', 1), null);
  assert.equal(home.population, population, 'a demolished house does not invent a casualty');
  house.destroyed = false; house.hp = 160; refreshHousing(home, faction);
  assert.ok(queueTraining(s, home, faction, 'infantry', 1));
  for (const residual of Object.values(ledgerResidual(s))) assert.ok(Math.abs(residual) < 1e-7);
});

test('destroyed housing is absent from rendering and its exact plot is reused', () => {
  const s = createSimulation('first-light'), home = s.settlements[0], faction = s.factions.find(f => f.id === home.factionId);
  const house = home.buildings.find(b => b.kind === 'housing'); house.destroyed = true; house.hp = 0;
  refreshHousing(home, faction);
  const scene = new THREE.Scene(), renderer = createEntities(THREE, scene);
  renderer.update(s); assert.ok(!renderer.getPickables().some(p => p.userData.buildingId === house.id)); renderer.dispose();
  stepSimulation(s, 20);
  const replacement = home.buildings.find(b => b.id !== house.id && b.kind === 'housing' && !b.destroyed && b.x === house.x && b.z === house.z);
  assert.ok(replacement, 'AI funds replacement housing on the freed plot');
  assert.ok(replacement.fundedCost.materials > 0);
});

test('scarcer starts retain every survival resource and each dispatched scout is one citizen', () => {
  const s = createSimulation('first-light');
  assert.equal(s.nodes.length, 160);
  for (let i = 0; i < s.factions.length; i++) assert.deepEqual(new Set(s.nodes.slice(i * 4, i * 4 + 4).map(n => n.kind)), new Set(['food', 'water', 'energy', 'materials']));
  assert.ok(s.nodes.every(n => n.maxAmount < 3200 * s.config.resourceScale));
  stepSimulation(s, 220);
  const scouts = s.groups.filter(g => g.kind === 'scout'); assert.ok(scouts.length);
  assert.ok(scouts.every(g => g.size === 1 && g.initialSize === 1));
  for (const residual of Object.values(ledgerResidual(s))) assert.ok(Math.abs(residual) < 1e-7);
});

test('a single scout attacks only a tiny exposed party and visible protection cancels the opportunity', () => {
  for (const protectedParty of [false, true]) {
    const s = createSimulation('first-light'), [home, enemy] = s.settlements, [own, rival] = s.factions;
    own.relations[rival.id] = { status: 'hostile', trust: 0 }; rival.relations[own.id] = { status: 'hostile', trust: 0 };
    const scout = { id: 'single-scout', kind: 'scout', factionId: own.id, originId: home.id, x: home.x + 2, z: home.z, targetX: home.x + 30, targetZ: home.z, speed: 0, size: 1, initialSize: 1, supply: 100, morale: 90, phase: 'outbound', carrying: {}, observations: [] };
    const worker = { id: 'exposed-workers', kind: 'worker', factionId: rival.id, originId: enemy.id, x: home.x + 3, z: home.z, size: 2, phase: 'working', carrying: { water: 4 }, capacity: 12 };
    if (protectedParty) enemy.buildings.push({ id: 'visible-protection', kind: 'tower', x: home.x + 6, z: home.z, hp: 220, progress: 1 });
    s.groups = [scout, worker]; s.time = 10.1; s.tick = 10; s.step = 101; initializeLedger(s);
    const before = enemy.population; stepStrategy(s, .1);
    assert.equal(worker.size, protectedParty ? 2 : 1); assert.equal(enemy.population, before - (protectedParty ? 0 : 1));
    assert.equal(scout.size, 1); assert.equal(scout.fieldRaidTargetId, null);
    for (const residual of Object.values(ledgerResidual(s))) assert.ok(Math.abs(residual) < 1e-7);
  }
});

test('a fresh delivered worker report can launch a small paid harassment party with a home reserve', () => {
  const s = createSimulation('first-light'), home = s.settlements[0], f = s.factions[0], enemy = s.factions[1];
  s.tick = 100; s.time = 100; s.step = 1000; f.relations[enemy.id] = { status: 'hostile', trust: 0 };
  setMilitary(s, home, { infantry: 28, ranged: 4 });
  f.knowledge['reported-work-party'] = { id: 'reported-work-party', kind: 'group', groupKind: 'worker', ownerId: enemy.id, x: home.x + 8, z: home.z, sizeEstimate: 3, observedTick: 100, reportedTick: 100, confidence: 1 };
  const people = home.population, stock = { ...home.stock }; dispatchHarassment(s, f, [home]);
  const party = s.groups.find(g => g.missionKind === 'harassment'); assert.ok(party);
  assert.ok(party.size >= 4 && party.size <= 8); assert.equal(party.soldierIds.length, party.size);
  assert.equal(home.population, people); assert.ok(home.soldiers - party.size >= party.homeReserve);
  assert.ok(Object.keys(stock).some(k => home.stock[k] < stock[k]));
  for (const residual of Object.values(ledgerResidual(s))) assert.ok(Math.abs(residual) < 1e-7);
});
