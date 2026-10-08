import test from 'node:test';
import assert from 'node:assert/strict';
import { createSimulation, launchWorkers } from '../src/sim/core.js';
import { initializeMilitary } from '../src/sim/military.js';
import { initializeLedger, ledgerResidual, emptyResources } from '../src/sim/economy.js';

function fixture() {
  const s = createSimulation('labor-jobs', { civCount: 3 }), [home] = s.settlements, [f] = s.factions;
  Object.assign(s, { tick: 200, step: 2000, time: 200, groups: [] });
  initializeMilitary(home, { infantry: 0, ranged: 0 }, { state: s });
  Object.assign(home, { population: 100, workers: 100, availableWorkers: 34, capacity: 3000, assigned: { workers: 66, civilianAway: 66 } });
  for (const key of Object.keys(home.stock)) home.stock[key] = 300;
  const node = { id: 'known-materials', kind: 'materials', x: home.x + 8, z: home.z, radius: 2, amount: 500, maxAmount: 500, regeneration: 0, richness: 1 };
  s.nodes = [node]; f.knowledge = { [node.id]: { ...node, kind: 'resource', resourceKind: node.kind, amountEstimate: 500, observedTick: 200, reportedTick: 200, confidence: 1 } };
  for (const [i, size] of [22, 22, 22].entries()) s.groups.push({ id: `committed-${i}`, kind: 'worker', originId: home.id, factionId: f.id, size, phase: 'working', resourceKind: 'water', targetId: 'water-site', capacity: size * 6, carrying: emptyResources() });
  const dispatch = { traffic: new Map(), knownNodes: new Map([[f.id, [node]]]) };
  initializeLedger(s); return { s, home, f, node, dispatch };
}

test('spare civilians beyond the old 66% cap take a real funded job while retaining the home reserve', () => {
  const { s, home, f, dispatch } = fixture(); const before = home.stock.materials;
  launchWorkers(s, home, f, dispatch);
  const crew = s.groups.at(-1); assert.equal(crew.targetId, 'known-materials'); assert.ok(crew.provisionCycles > 0);
  assert.ok(home.assigned.workers > 66); assert.ok(home.availableWorkers >= 12);
  assert.equal(home.assigned.civilianAway + home.availableWorkers, home.workers);
  assert.equal(home.laborPlan.dispatched, crew.size); assert.ok(Math.abs(home.stock.materials - (before - crew.provisions.materials)) < 1e-9);
  for (const residual of Object.values(ledgerResidual(s))) assert.ok(Math.abs(residual) < 1e-7);
});

test('full stores, exhausted reports, unsafe jobs and real home commitments produce honest idle reasons', () => {
  for (const kind of ['full', 'depleted', 'danger', 'reserve']) {
    const { s, home, f, node, dispatch } = fixture();
    if (kind === 'full') home.stock.materials = home.capacity;
    if (kind === 'depleted') f.knowledge[node.id].amountEstimate = 0;
    if (kind === 'reserve') home.availableWorkers = 12;
    if (kind === 'danger') f.knowledge.enemy = { id: 'enemy', kind: 'group', groupKind: 'army', ownerId: s.factions[1].id, x: node.x, z: node.z, sizeEstimate: 10, observedTick: 200, reportedTick: 200, confidence: 1 };
    launchWorkers(s, home, f, dispatch);
    assert.equal(s.groups.length, 3);
    assert.match(home.laborPlan.reason, { full: /Storage/, depleted: /depleted/, danger: /hostile/, reserve: /reserve/ }[kind]);
  }
});


test('a safe job is reconsidered after its delivered marching-threat report expires', () => {
  const { s, home, f, node, dispatch } = fixture();
  f.knowledge.enemy = { id: 'enemy', kind: 'group', groupKind: 'army', ownerId: s.factions[1].id, x: node.x, z: node.z, sizeEstimate: 10, observedTick: 200, reportedTick: 200, confidence: 1 };
  launchWorkers(s, home, f, dispatch); assert.equal(s.groups.length, 3);
  s.tick = 225;
  launchWorkers(s, home, f, { traffic: new Map(), knownNodes: dispatch.knownNodes });
  assert.equal(s.groups.length, 4); assert.equal(s.groups.at(-1).targetId, node.id);
});
