import { setMilitary, recruitMilitary, bindArmy } from './roster-fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshHousing } from '../src/sim/housing.js';
import { createSimulation } from '../src/sim/core.js';
import { terrainAt } from '../src/world.js';
import { stepCombat } from '../src/sim/combat.js';
import { stepStrategy } from '../src/sim/strategy.js';
import { countMilitary, queueTraining, advanceTraining, unitStats } from '../src/sim/military.js';
import { lineOfSight, invalidateNavigation } from '../src/sim/navigation.js';
import { emptyResources, initializeLedger, ledgerResidual, RESOURCES } from '../src/sim/economy.js';

// Controlled fixtures use actual seeded clear terrain. They exercise physical
// tactical outcomes and are not natural-run balance or population evidence.
function fixture() {
  const s = createSimulation('combat-physical-contract', { civCount: 3 });
  s.groups = []; s.nodes = []; s.events = [];
  for (const home of s.settlements) {
    home.buildings = []; home.assigned = {}; home.population = 300; home.homePresent = 300; home.availableWorkers = 300;
    home.stock = Object.fromEntries(RESOURCES.map(key => [key, 500])); setMilitary(s, home);
  }
  const [a, b] = s.factions;
  a.relations[b.id] = { status: 'hostile', trust: 0 }; b.relations[a.id] = { status: 'hostile', trust: 0 };
  let center;
  outer: for (let z = -72; z < 72; z += 6) for (let x = -72; x < 72; x += 6) {
    const points = [];
    for (let dz = -10; dz <= 10; dz += 2) for (let dx = -10; dx <= 10; dx += 2) points.push({ x: x + dx, z: z + dz });
    if (points.every(p => terrainAt(p.x, p.z, s.seed).traversable) && lineOfSight(s, { x: x - 7, z }, { x: x + 7, z }, { fromHeight: .6, toHeight: .6 })) { center = { x, z }; break outer; }
  }
  assert.ok(center);
  for (const [i, home] of s.settlements.entries()) Object.assign(home, { x: center.x + 80 + i * 25, z: center.z + 60 });
  initializeLedger(s);
  return { s, center, a, b, ha: s.settlements[0], hb: s.settlements[1] };
}
const point = (center, x = 0, z = 0) => ({ x: center.x + x, z: center.z + z });
function army(s, home, id, size, position, extras = {}) {
  const units = extras.units || { infantry: size, ranged: 0 };
  recruitMilitary(s, home, units);
  const g = { id, kind: 'army', factionId: home.factionId, originId: home.id, units: { ...units }, size, initialSize: size,
    ...position, prevX: position.x, prevZ: position.z, targetX: position.x, targetZ: position.z, targetId: null, phase: 'outbound', speed: 0,
    morale: 100, supply: 100, carrying: emptyResources(), ...extras };
  bindArmy(s, home, g); s.groups.push(g); return g;
}
function pulse(s, strategy = false) {
  s.step++; s.time = s.step / 10; s.tick = Math.floor(s.time);
  for (const f of s.factions) { f.lastScout = s.tick; f.lastArmy = s.tick; }
  if (strategy) stepStrategy(s, .1); else stepCombat(s, .1);
}
function conserved(s) { for (const [key, residual] of Object.entries(ledgerResidual(s))) assert.ok(Math.abs(residual) < 1e-7, `${key}: ${residual}`); }

test('visible defenders immediately interrupt committed worker and production raids', () => {
  for (const kind of ['worker', 'structure']) {
    const { s, center, ha, hb } = fixture();
    const raider = army(s, ha, 'a-raider', 30, point(center, -3));
    let target;
    if (kind === 'worker') {
      target = { id: 'exposed-crew', kind: 'worker', factionId: hb.factionId, originId: hb.id, size: 8, phase: 'working', ...point(center, 4), carrying: { ...emptyResources(), food: 20 } }; s.groups.push(target);
    } else { target = { id: 'exposed-farm', kind: 'farm', ...point(center, 4), progress: 1, hp: 160 }; hb.buildings.push(target); }
    pulse(s); assert.equal(raider.combat.targetId, target.id); assert.ok(raider.combat.decisionUntil > s.time);
    const defender = army(s, hb, 'b-defender', 25, point(center, 1, -2));
    pulse(s);
    assert.equal(raider.combat.targetId, defender.id); assert.equal(raider.combat.intent, 'intercept');
    assert.match(raider.combat.reason, /interrupting/);
    assert.ok(!s.pendingCombat.some(hit => hit.sourceId === raider.id && hit.targetId === target.id), 'interrupted target received a new strike');
  }
});

test('a severely outmatched army commits to one retreat without launching attacks or re-engaging', () => {
  const { s, center, ha, hb } = fixture();
  const small = army(s, ha, 'a-small', 12, point(center, -3));
  army(s, hb, 'b-large', 70, point(center, 3));
  pulse(s);
  assert.equal(small.phase, 'retreating'); assert.equal(small.combat.intent, 'retreat'); assert.ok(small.combat.strengthRatio < .43);
  assert.match(small.combat.reason, /Visible defenders/);
  for (let i = 0; i < 50; i++) pulse(s);
  assert.equal(small.phase, 'retreating'); assert.equal(s.stats.retreats, 1);
  assert.ok(!s.combatEvents.some(e => ['melee', 'projectile'].includes(e.type) && e.sourceId === small.id));
});

test('a defender on the near side interrupts a useful wall breach immediately', () => {
  const { s, center, ha, hb } = fixture();
  Object.assign(hb, point(center, 4));
  const wall = { id: 'useful-wall', kind: 'wall', ...center, rotation: Math.PI / 2, length: 20, width: 1, progress: 1, hp: 240, wallHeight: 4 };
  hb.buildings.push(wall); invalidateNavigation(s);
  const g = army(s, ha, 'a-breacher', 30, point(center, -1.8), { targetId: hb.id, targetX: hb.x, targetZ: hb.z });
  pulse(s); assert.equal(g.combat.targetId, wall.id); assert.equal(g.combat.intent, 'breach');
  const defender = army(s, hb, 'b-defender', 25, point(center, -4, -3));
  const existingWallStrikes = s.pendingCombat.filter(p => p.targetId === wall.id).map(p => p.id);
  pulse(s);
  assert.equal(g.combat.targetId, defender.id); assert.equal(g.combat.intent, 'intercept');
  assert.ok(s.pendingCombat.filter(p => p.targetId === wall.id).every(p => existingWallStrikes.includes(p.id)), 'breach kept issuing damage orders after defender interruption');
});

test('nearby visible support changes an otherwise losing local decision; distant support does not', () => {
  const run = near => {
    const { s, center, ha, hb } = fixture();
    const small = army(s, ha, 'a-small', 12, point(center, -3));
    army(s, hb, 'b-enemy', 60, point(center, 3));
    army(s, ha, 'c-support', 65, point(center, near ? -5 : -55, -2));
    pulse(s); return small;
  };
  const supported = run(true), isolated = run(false);
  assert.equal(isolated.phase, 'retreating'); assert.equal(isolated.combat.supportStrength, 0);
  assert.equal(supported.phase, 'engaging'); assert.ok(supported.combat.supportStrength > 20);
  assert.ok(supported.combat.strengthRatio > isolated.combat.strengthRatio);
});

test('lower morale changes local strength and comparable targets do not jitter', () => {
  const { s, center, ha, hb } = fixture();
  const main = army(s, ha, 'a-main', 70, point(center, -3));
  const first = army(s, hb, 'b-first', 15, point(center, 3));
  const second = army(s, hb, 'c-second', 15, point(center, 3.5, 2));
  pulse(s); const initial = main.combat.targetId, strong = main.combat.localStrength;
  main.morale = 50;
  for (let i = 0; i < 40; i++) {
    second.x = center.x + (i % 2 ? 2.7 : 3.5); first.x = center.x + 3;
    pulse(s); assert.equal(main.combat.targetId, initial);
  }
  assert.ok(main.combat.localStrength < strong * .85);
});

test('hidden remote census, queues and structures do not change local target or strength', () => {
  const { s, center, ha, hb } = fixture();
  army(s, ha, 'a-main', 30, point(center, -3)); army(s, hb, 'b-contact', 25, point(center, 3));
  const alternate = structuredClone(s), remote = alternate.settlements.find(p => p.id === hb.id);
  remote.population = 800; recruitMilitary(alternate, remote, { infantry: 625, ranged: 100 });
  remote.buildings.push({ id: 'secret-farm', kind: 'farm', x: remote.x, z: remote.z, progress: 1, hp: 160 });
  remote.trainingQueue = [{ id: 'secret-course', role: 'ranged', size: 40 }];
  const knowledge = structuredClone(s.factions[0].knowledge);
  pulse(s); pulse(alternate);
  assert.deepEqual(alternate.groups[0].combat, s.groups[0].combat);
  assert.deepEqual(s.factions[0].knowledge, knowledge, 'local contact instantly delivered strategic intelligence');
});

test('worker contact transfers bounded real cargo and returns the intact workforce without ledger loss', () => {
  const { s, center, ha, hb } = fixture();
  const raider = army(s, ha, 'a-raider', 12, point(center, -1));
  raider.carrying.materials = 10;
  const worker = { id: 'loaded-crew', kind: 'worker', factionId: hb.factionId, originId: hb.id, size: 8, phase: 'working', ...point(center, 1), carrying: { ...emptyResources(), food: 40 }, capacity: 48 };
  s.groups.push(worker); initializeLedger(s);
  const population = hb.population, workers = hb.workers;
  for (let i = 0; i < 30 && !s.stats.workerRaids; i++) pulse(s);
  assert.equal(s.stats.workerRaids, 1); assert.equal(worker.phase, 'returning'); assert.equal(worker.targetX, hb.x);
  assert.equal(worker.size, 8); assert.equal(hb.population, population); assert.equal(hb.workers, workers);
  assert.ok(Math.abs(raider.carrying.food - 4.4) < 1e-7); assert.ok(Math.abs(worker.carrying.food - 35.6) < 1e-7);
  for (let i = 0; i < 20; i++) pulse(s);
  assert.equal(s.stats.workerRaids, 1); conserved(s);
});

test('an exposed training building receives delayed damage and its destruction cancels the paid course', () => {
  const { s, center, ha, hb, b } = fixture();
  const building = { id: 'exposed-producer', kind: unitStats(b.species, 'infantry').building, ...point(center, 1.5), progress: 1, hp: 30, maxHp: 30 };
  hb.buildings.push(building, ...Array.from({ length: 12 }, (_, i) => ({ id: `funded-housing-${i}`, kind: 'housing', x: hb.x + i * 3, z: hb.z + 20, progress: 1, hp: 160 })));
  refreshHousing(hb, b);
  army(s, ha, 'a-raider', 18, point(center, -1));
  initializeLedger(s);
  const job = queueTraining(s, hb, b, 'infantry', 3); assert.ok(job);
  const population = hb.population, paid = { ...hb.stock };
  pulse(s); assert.equal(building.hp, 30, 'strike launch applied damage before physical impact');
  for (let i = 0; i < 60 && !building.destroyed; i++) pulse(s);
  assert.equal(building.destroyed, true); assert.equal(building.hp, 0); assert.equal(s.stats.structuresDestroyed, 1);
  assert.ok(s.combatEvents.some(e => e.type === 'collapse' && e.targetId === building.id));
  advanceTraining(s, hb, b);
  assert.equal(hb.trainingQueue.length, 0); assert.equal(hb.soldiers, 0); assert.equal(hb.population, population); assert.deepEqual(hb.stock, paid); conserved(s);
});

test('an unrelated visible wall is not attacked on an open approach to the mission', () => {
  const { s, center, ha, hb } = fixture();
  Object.assign(hb, point(center, 6));
  const wall = { id: 'irrelevant-wall', kind: 'wall', ...point(center, -3, 8), rotation: 0, length: 8, width: 1, progress: 1, hp: 30 };
  hb.buildings.push(wall); invalidateNavigation(s);
  const g = army(s, ha, 'a-march', 20, point(center, -3), { targetId: hb.id, targetX: hb.x, targetZ: hb.z });
  for (let i = 0; i < 20; i++) pulse(s);
  assert.notEqual(g.combat.targetId, wall.id); assert.equal(wall.hp, 30);
  assert.ok(!s.pendingCombat.some(p => p.targetId === wall.id));
});

test('new local defenders interrupt settlement pressure before the next strategic raid', () => {
  const { s, center, ha, hb } = fixture();
  Object.assign(hb, point(center, 2));
  const g = army(s, ha, 'a-raider', 40, center, { targetId: hb.id, targetX: hb.x, targetZ: hb.z, engagedDays: 4 });
  pulse(s); assert.equal(g.combat.targetKind, 'settlement');
  army(s, hb, 'b-relief', 40, point(center, -2, 2), { targetId: ha.id, targetX: ha.x, targetZ: ha.z });
  s.step = 9; s.time = .9;
  const health = hb.health, stock = { ...hb.stock };
  pulse(s, true);
  assert.equal(g.combat.targetKind, 'group'); assert.equal(g.engagedDays, 4); assert.equal(hb.health, health); assert.deepEqual(hb.stock, stock);
});

test('one garrison advances once per pulse toward the closest of simultaneous attackers', () => {
  const { s, center, ha, hb } = fixture();
  Object.assign(hb, center); setMilitary(s, hb, { infantry: 20, ranged: 0 });
  hb.combat = { x: hb.x, z: hb.z, active: false };
  army(s, ha, 'a-far', 40, point(center, -7));
  army(s, ha, 'b-near', 40, point(center, -3));
  const onlyNear = structuredClone(s); onlyNear.groups = onlyNear.groups.filter(g => g.id === 'b-near');
  pulse(s); pulse(onlyNear);
  const expected = onlyNear.settlements.find(p => p.id === hb.id).combat;
  assert.equal(hb.combat.targetId, 'b-near'); assert.equal(hb.combat.x, expected.x); assert.equal(hb.combat.z, expected.z);
});

test('cover completed during a structural projectile flight blocks its pending damage', () => {
  const { s, center, ha, hb } = fixture();
  const farm = { id: 'covered-farm', kind: 'farm', ...point(center, 3), progress: 1, hp: 160 };
  hb.buildings.push(farm);
  const g = army(s, ha, 'a-archers', 16, point(center, -4), { units: { infantry: 0, ranged: 16 } });
  pulse(s); assert.ok(s.pendingCombat.some(hit => hit.sourceId === g.id && hit.targetId === farm.id));
  hb.buildings.push({ id: 'late-cover', kind: 'wall', ...center, rotation: Math.PI / 2, length: 24, width: 1, progress: 1, hp: 300, wallHeight: 12 });
  invalidateNavigation(s);
  for (let i = 0; i < 15; i++) pulse(s);
  assert.equal(farm.hp, 160); assert.ok(s.combatEvents.some(event => event.type === 'miss' && event.targetId === farm.id));
});

test('an empty provisional engagement resumes its reported march instead of getting stuck', () => {
  const { s, center, ha, hb } = fixture();
  const g = army(s, ha, 'a-march', 20, center, { phase: 'engaging', targetId: hb.id, targetX: hb.x, targetZ: hb.z });
  pulse(s);
  assert.equal(g.phase, 'outbound'); assert.equal(g.combat.active, false); assert.equal(g.combat.intent, 'advance');
  assert.equal(g.targetX, hb.x); assert.equal(g.targetZ, hb.z);
});
