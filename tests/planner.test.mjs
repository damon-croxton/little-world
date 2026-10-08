import test from 'node:test';
import assert from 'node:assert/strict';
import { createSimulation } from '../src/sim/core.js';
import { planStrategy } from '../src/sim/planner.js';
import { initializeMilitary, deployMilitary, getSoldiers } from '../src/sim/military.js';
import { strengthRows } from '../src/strength-chart.js';

function fixture() {
  const s = createSimulation('joined-screen', { civCount: 3 });
  Object.assign(s, { tick: 400, time: 400, step: 4000, groups: [] });
  const [f] = s.factions, [h, target] = s.settlements;
  Object.assign(h, { x: -100, z: -120, buildings: [], population: 200, shortageDays: 0, health: 100 });
  Object.assign(target, { x: -40, z: -120 });
  initializeMilitary(h, { infantry: 60, ranged: 10 }, { state: s });
  f.knowledge = { [target.id]: { id: target.id, kind: 'settlement', ownerId: target.factionId, x: target.x, z: target.z, status: 'active', soldiersEstimate: 20, observedTick: 398, reportedTick: 399, confidence: .9 } };
  const hooks = { planningWorld: state => ({ ...state, walls: [], settlements: state.settlements.filter(p => p === h) }), returnHome(state, g, reason) { g.phase = 'retreating'; g.targetX = h.x; g.targetZ = h.z; g.reason = reason; } };
  const plan = () => planStrategy(s, f, [h], hooks);
  const advance = n => { s.tick += n; s.time += n; s.step += n * 10; };
  const army = (id, size, point = h) => {
    const g = { id, kind: 'army', factionId: f.id, originId: h.id, size, units: { infantry: size, ranged: 0 }, phase: 'outbound', campaign: true, supply: 100, x: point.x, z: point.z, targetId: target.id, targetX: target.x, targetZ: target.z, carrying: { food: 7 } };
    deployMilitary(s, h, g); s.groups.push(g);
    for (const b of getSoldiers(s, g)) Object.assign(b, { x: point.x, z: point.z, positioned: true });
    return g;
  };
  return { s, f, h, target, plan, advance, army };
}

test('bounded plans defend an observed home threat and preserve identities and wounds', () => {
  const { s, h, plan, advance } = fixture(); h.defensePlan={reserve:6,reason:'A fresh home threat requires guards.'};
  s.groups.push({ id: 'working', kind: 'worker', factionId: h.factionId, originId: h.id, size: 12, phase: 'working', targetId: 'ore', x: h.x + 12, z: h.z });
  const bodies = h.soldierRoster.slice(), wounded = bodies[1]; wounded.hp = wounded.maxHp * .25;
  const before = bodies.map(b => [b.id, b.hp, b.attackReadyAt]);
  const first = plan(); assert.ok(bodies.some(b => b.order.role === 'guard-worksite'));
  assert.equal(wounded.order.role, 'recover'); assert.ok(bodies.every(b => b.order?.objectiveId));
  advance(3); assert.equal(plan(), first, 'expensive planning ran inside its four-cycle interval');
  advance(1); assert.equal(plan().reviews, 2);
  assert.deepEqual(bodies.map(b => [b.id, b.hp, b.attackReadyAt]), before);
  assert.ok(bodies.every(b => h.soldierRoster.includes(b)));
});

test('shared assault waits for actual soldier arrivals and commits supplied parties together', () => {
  const { s, h, target, plan, advance, army } = fixture();
  const a = army('a', 20), b = army('b', 20), identities = h.soldierRoster.slice();
  const cargo = JSON.stringify(s.groups.map(g => g.carrying));
  const operation = plan().operation; assert.equal(operation.phase, 'assemble');
  assert.equal(a.operationId, b.operationId); assert.deepEqual(a.strategicHold, b.strategicHold);
  Object.assign(a, { x: operation.x, z: operation.z }); Object.assign(b, { x: operation.x, z: operation.z });
  advance(4); assert.equal(plan().operation.phase, 'assemble', 'route centres counted as arrived troops');
  for (const g of [a, b]) for (const body of getSoldiers(s, g)) Object.assign(body, { x: operation.x, z: operation.z });
  advance(4); assert.equal(plan().operation.phase, 'assault'); assert.equal(s.stats.coordinatedAssaults, 1);
  for (const g of [a, b]) { assert.equal(g.strategicHold, null); assert.equal(g.targetX, target.x); assert.equal(g.targetZ, target.z); }
  assert.equal(JSON.stringify(s.groups.map(g => g.carrying)), cargo);
  assert.ok(identities.every(b => h.soldierRoster.includes(b))); assert.equal(h.population, 200);
});

test('unsupported rally withdraws at its finite deadline instead of attacking indefinitely', () => {
  const { s, f, target, plan, advance, army } = fixture(); const g = army('small', 10);
  const op = plan().operation; Object.assign(g, { x: op.x, z: op.z });
  for (const body of getSoldiers(s, g)) Object.assign(body, { x: op.x, z: op.z });
  advance(op.assembleDeadline - s.tick); plan();
  assert.equal(g.phase, 'retreating'); assert.equal(g.operationId, null); assert.equal(f.unreachableTargets[target.id], s.tick);
  assert.equal(s.stats.coordinatedAssaults || 0, 0);
});

test('a sufficient arrived force commits at the rally deadline despite distant reinforcements', () => {
  const { s, plan, advance, army } = fixture();
  const lead = army('lead', 35), late = army('late', 25), op = plan().operation;
  Object.assign(lead, { x: op.x, z: op.z });
  for (const body of getSoldiers(s, lead)) Object.assign(body, { x: op.x, z: op.z });
  advance(4); assert.equal(plan().operation.phase, 'assemble', 'cohesion wait ended before the deadline');
  assert.ok(op.assembled >= op.required); assert.ok(op.assembled < (lead.size + late.size) * .8);
  const latePositions = getSoldiers(s, late).map(body => [body.id, body.x, body.z, body.hp]);
  advance(op.assembleDeadline - s.tick); assert.equal(plan().operation.phase, 'assault');
  assert.equal(lead.strategicHold, null); assert.equal(s.stats.coordinatedAssaults, 1);
  assert.deepEqual(getSoldiers(s, late).map(body => [body.id, body.x, body.z, body.hp]), latePositions, 'deadline moved or healed the late reinforcements');
});

test('production rally follows the furthest supplied army on the selected objective', () => {
  const { h, target, plan, army } = fixture();
  const unrelated = army('unrelated', 10, { x: h.x - 25, z: h.z }); unrelated.targetId = 'other-front';
  army('rear', 10, { x: h.x + 18, z: h.z });
  const lead = army('lead', 10, { x: h.x + 32, z: h.z });
  const depot = army('resupplying', 10, { x: target.x - 2, z: h.z }); depot.stagingTargetId = 'depot';
  const empty = army('depleted', 10, { x: target.x - 1, z: h.z }); empty.supply = 30;
  plan();
  assert.equal(h.productionRally.frontGroupId, lead.id);
  assert.equal(h.productionRally.targetId, target.id);
  assert.ok(h.productionRally.destinationX > h.x && h.productionRally.destinationX < lead.x);
});

test('a stalled objective gets one route retry then a physical retreat and finite target cooldown', () => {
  const { s, f, target, plan, advance, army } = fixture(); const g = army('stuck', 10);
  g.campaign = false; g.navigation = { stale: true }; plan();
  advance(16); plan(); assert.equal(g.navigation, null); assert.equal(g.objectiveProgress.retries, 1);
  assert.equal(g.phase, 'outbound'); advance(16); plan();
  assert.equal(g.phase, 'retreating'); assert.equal(f.unreachableTargets[target.id], s.tick); assert.equal(s.stats.objectiveRecoveries, 1);
});

test('unseen enemy strength and buildings cannot change faction plans or the shared rally', () => {
  const a = fixture(), b = fixture(); a.army('a', 40); b.army('a', 40);
  b.target.population = 9000; initializeMilitary(b.target, { infantry: 900, ranged: 400 }, { state: b.s });
  b.target.buildings.push({ id: 'hidden-fort', kind: 'wall', x: -75, z: -120, hp: 900, progress: 1, length: 50 });
  assert.deepEqual(a.plan(), b.plan()); assert.deepEqual(a.s.groups[0].strategicHold, b.s.groups[0].strategicHold);
});

test('comparison bars share an honest scale while foreign census and scale remain unknown', () => {
  const state = { factions: [{ id: 'a', economy: { population: 100, soldiers: 20 } }, { id: 'b', economy: { population: 200, soldiers: 50 } }], settlements: [] };
  const world = strengthRows(state); assert.deepEqual(world.map(r => [r.workers, r.military, r.workerPercent, r.militaryPercent]), [[80,20,40,10],[150,50,75,25]]);
  state.viewer = { mode: 'faction', factionId: 'a' };
  const scoped = strengthRows(state); assert.equal(scoped[0].workerPercent, 80); assert.equal(scoped[1].known, false);
  assert.equal(scoped[1].workers, null); assert.equal(scoped[1].militaryPercent, null);
  state.factions[1].economy.population = 900000; assert.deepEqual(strengthRows(state), scoped);
  delete state.viewer; state.factions[1].economy = { population: 0, soldiers: 0 };
  assert.equal(strengthRows(state)[1].total, 0); assert.equal(strengthRows(state)[1].workerPercent, 0);
});
