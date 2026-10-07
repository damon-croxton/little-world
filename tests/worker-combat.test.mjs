import test from 'node:test';
import assert from 'node:assert/strict';
import { createSimulation, stepSimulation } from '../src/sim/core.js';
import { stepCombat } from '../src/sim/combat.js';
import { stepStrategy } from '../src/sim/strategy.js';
import { CIVILIAN_HEALTH, civilianHealth, applyCivilianDamage } from '../src/sim/civilians.js';
import { getSoldiers } from '../src/sim/soldiers.js';
import { emptyResources, initializeLedger, ledgerResidual, RESOURCES } from '../src/sim/economy.js';
import { invalidateNavigation, isSegmentTraversable } from '../src/sim/navigation.js';
import { factionView, initializeKnowledge, stepKnowledge } from '../src/sim/knowledge.js';
import { setMilitary, recruitMilitary, bindArmy } from './roster-fixtures.mjs';

function fixture() {
  const s = createSimulation('worker-contact-contract', { civCount: 3 });
  const center = s.terrain.districts.find(d => d.kind === 'expansion');
  const [ha, hb] = s.settlements, [a, b] = s.factions;
  s.groups = []; s.nodes = []; s.events = [];
  for (const home of s.settlements) { home.buildings = []; setMilitary(s, home); }
  for (const f of s.factions) { f.lastScout = 100; f.lastArmy = 100; f.knowledge = {}; }
  a.relations[b.id] = { status: 'hostile', trust: 0 }; b.relations[a.id] = { status: 'hostile', trust: 0 };
  const p = (x = 0, z = 0) => ({ x: center.x + x, z: center.z + z });
  const crew = (extras = {}) => {
    const worker = { id: 'exposed-workers', kind: 'worker', factionId: b.id, originId: hb.id, size: 12, initialSize: 12, phase: 'working',
      ...p(3), prevX: p(3).x, prevZ: p(3).z, targetId: 'worksite', targetX: p(3).x, targetZ: p(3).z, speed: 2.65,
      capacity: 72, cargoCapacity: 72, carrying: emptyResources(), supply: 100, provisionCycles: 100, createdTick: 0, morale: 100,
      observations: [], extractedTotal: 0, workTime: 0, ...extras };
    s.groups.push(worker); return worker;
  };
  const army = (count = 4, role = 'infantry', home = ha, extras = {}) => {
    const units = { infantry: 0, ranged: 0, [role]: count }; recruitMilitary(s, home, units);
    const g = { id: `raider-${s.groups.length}`, kind: 'army', factionId: home.factionId, originId: home.id, units, size: count, initialSize: count,
      ...p(), prevX: center.x, prevZ: center.z, targetX: p(16).x, targetZ: p(16).z, targetId: null, phase: 'outbound', speed: 2.8,
      supply: 100, morale: 100, carrying: emptyResources(), createdTick: 0, observations: [], ...extras };
    bindArmy(s, home, g); s.groups.push(g); return g;
  };
  return { s, a, b, ha, hb, p, crew, army };
}
function pulse(s, count = 1) { for (let i = 0; i < count; i++) { s.step++; s.time = s.step / 10; s.tick = Math.floor(s.time); stepCombat(s, .1); } }
function conserved(s) { for (const [key, value] of Object.entries(ledgerResidual(s))) assert.ok(Math.abs(value) < 1e-7, `${key} residual ${value}`); }

test('crew damage consumes per-person health, census and proportional cargo exactly once', () => {
  const { s, crew, hb, ha } = fixture(), worker = crew({ carrying: { food: 36, water: 12, energy: 12, materials: 12 } });
  hb.occupiedBy = ha.factionId;
  initializeLedger(s); const nativePopulation = hb.population, occupierPopulation = ha.population;
  assert.equal(civilianHealth(worker), 12 * CIVILIAN_HEALTH);
  assert.deepEqual(applyCivilianDamage(s, worker, CIVILIAN_HEALTH * 2 + 5), { damage: 69, deaths: 2 });
  assert.equal(worker.size, 10); assert.equal(worker.civilianWounds, 5); assert.equal(civilianHealth(worker), 315);
  assert.equal(hb.population, nativePopulation - 2); assert.equal(hb.workers + hb.soldiers, hb.population); assert.equal(ha.population, occupierPopulation);
  assert.equal(worker.capacity, 60); assert.equal(worker.cargoCapacity, 60);
  assert.deepEqual(worker.carrying, { food: 30, water: 10, energy: 10, materials: 10 }); conserved(s);
  const result = applyCivilianDamage(s, worker, 100000);
  assert.equal(result.damage, 315); assert.equal(result.deaths, 10); assert.equal(worker.size, 0); assert.equal(worker.finished, true);
  assert.equal(hb.population, nativePopulation - 12); assert.equal(s.stats.workerCombatDeaths, 12);
  assert.deepEqual(worker.carrying, emptyResources()); assert.equal(worker.capacity, 0); conserved(s);
  assert.deepEqual(applyCivilianDamage(s, worker, 100000), { damage: 0, deaths: 0 }); assert.equal(hb.population, nativePopulation - 12);
});

test('one real ranged weapon wounds an empty twelve-worker crew once without count-multiplied damage', () => {
  const { s, crew, army } = fixture(), raider = army(1, 'ranged'), worker = crew();
  raider.carrying.materials = 1.2; // Full loot capacity must not make labor immune.
  initializeLedger(s); pulse(s);
  assert.equal(raider.combat.targetId, worker.id); assert.equal(raider.combat.intent, 'raid');
  assert.equal(s.pendingCombat.length, 1); const strike = { ...s.pendingCombat[0] }, shooter = getSoldiers(s, raider)[0];
  assert.equal(strike.targetKind, 'worker'); assert.equal(strike.sourceSoldierId, shooter.id); assert.equal(worker.size, 12);
  assert.equal(civilianHealth(worker), 384, 'launch must not damage before impact');
  pulse(s, 4);
  assert.equal(civilianHealth(worker), 384 - strike.damage); assert.equal(worker.size, 12);
  assert.equal(s.stats.attacks, 1); assert.ok(shooter.attackReadyAt > s.time); assert.equal(worker.phase, 'returning'); conserved(s);
});

test('individual melee strikes progressively kill represented workers and release no extra population', () => {
  const { s, crew, army, hb, p } = fixture(), raider = army(5), worker = crew({ ...p(1.2), carrying: { ...emptyResources(), food: 48 } });
  initializeLedger(s); const before = hb.population;
  for (let i = 0; i < 90 && !worker.finished; i++) pulse(s);
  assert.ok(s.stats.workerCombatDeaths > 0, 'close military contact must cause actual crew casualties');
  assert.equal(before - hb.population, 12 - worker.size);
  const hits = s.combatEvents.filter(e => e.type === 'impact' && e.targetId === worker.id);
  assert.ok(hits.every(e => e.damage <= getSoldiers(s, raider)[0].attackDamage + 1e-7), 'a hit multiplied damage by the crew count');
  assert.ok(worker.size >= 0); conserved(s);
  if (worker.finished) { stepStrategy(s, 0); assert.ok(!s.groups.includes(worker), 'dead crew remained in the authoritative group list'); }
});

test('a newly allied or occupied worker crew cancels its in-flight hostile projectile', () => {
  for (const change of ['alliance', 'occupation']) {
    const { s, crew, army, a, b, hb } = fixture(), worker = crew(), raider = army(1, 'ranged');
    pulse(s); assert.ok(s.pendingCombat.some(hit => hit.targetId === worker.id));
    if (change === 'alliance') { a.relations[b.id].status = 'allied'; b.relations[a.id].status = 'allied'; }
    else { Object.assign(hb, { x: worker.x, z: worker.z, occupiedBy: a.id }); }
    pulse(s, 5); assert.equal(civilianHealth(worker), 384); assert.ok(!s.pendingCombat.some(hit => hit.sourceId === raider.id));
  }
});

test('a worker behind opaque enemy cover neither attracts a raid nor takes damage', () => {
  const { s, crew, army, hb, p } = fixture(), worker = crew({ ...p(5) }), raider = army(1, 'ranged', undefined, { ...p(-5) });
  hb.buildings.push({ id: 'screen', kind: 'wall', ...p(), rotation: Math.PI / 2, length: 30, width: 1, progress: 1, hp: 500, wallHeight: 4 });
  invalidateNavigation(s); pulse(s, 5);
  assert.notEqual(raider.combat.targetId, worker.id); assert.equal(civilianHealth(worker), 384);
  assert.ok(!s.pendingCombat.some(hit => hit.targetId === worker.id));
});

test('visible escorts interrupt a labor attack and superior protection forces withdrawal', () => {
  const { s, crew, army, hb, p } = fixture(), raider = army(4), worker = crew({ ...p(8) });
  pulse(s); assert.equal(raider.combat.targetId, worker.id);
  const guard = army(24, 'infantry', hb, { ...p(5), id: 'visible-escort' });
  pulse(s); assert.equal(raider.phase, 'retreating'); assert.ok(raider.combat.strengthRatio < .43);
  assert.ok(!s.combatEvents.some(hit => hit.sourceId === raider.id && hit.targetId === worker.id && hit.time === s.time && ['melee', 'projectile'].includes(hit.type)));
  assert.equal(guard.combat.targetId, raider.id);
});

test('a crew pursuit without closing or damage ends and retains the original mission', () => {
  const { s, crew, army, p } = fixture(), raider = army(1, 'infantry', undefined, { speed: 0, targetId: 'original-order' }), worker = crew({ ...p(14) });
  const body = getSoldiers(s, raider)[0];
  for (let i = 0; i < 40; i++) { Object.assign(body, p()); pulse(s); }
  assert.equal(raider.combat.ignoredWorkerId, worker.id); assert.ok(raider.combat.ignoreWorkerUntil > s.time);
  assert.equal(raider.targetId, 'original-order'); assert.equal(raider.phase, 'outbound');
});

test('travelling workers flee a visible single attacker and avoid running through it toward home', () => {
  const { s, crew, army, hb, p } = fixture(); Object.assign(hb, p(-12));
  const worker = crew({ ...p(), prevX: p().x, prevZ: p().z, phase: 'outbound', targetX: p(12).x, targetZ: p(12).z });
  const raider = army(1, 'infantry', undefined, { ...p(-4), speed: 0 }), body = getSoldiers(s, raider)[0];
  const before = { x: worker.x, z: worker.z }, gap = Math.hypot(worker.x - body.x, worker.z - body.z);
  initializeLedger(s); stepSimulation(s, 1);
  assert.equal(worker.phase, 'returning'); assert.equal(worker.activity, 'fleeing'); assert.ok(worker.escapeWaypoint);
  assert.ok(Math.hypot(worker.x - body.prevX, worker.z - body.prevZ) >= gap - .01);
  assert.ok(Math.hypot(worker.x - before.x, worker.z - before.z) <= worker.speed * .1 + 1e-7);
  assert.ok(isSegmentTraversable(s, before, worker, { factionId: worker.factionId, radius: .1 })); conserved(s);
});

test('an unseen remote army does not change a travelling worker’s route or phase', () => {
  const { s, crew, army, p } = fixture(), worker = crew({ ...p(), phase: 'returning' });
  const alternative = structuredClone(s); army(20, 'infantry', undefined, { ...p(70) });
  initializeLedger(s); initializeLedger(alternative); stepSimulation(s, 1); stepSimulation(alternative, 1);
  const other = alternative.groups.find(g => g.id === worker.id);
  assert.deepEqual({ x: worker.x, z: worker.z, phase: worker.phase, escape: worker.escapeWaypoint }, { x: other.x, z: other.z, phase: other.phase, escape: other.escapeWaypoint });
});

test('nearby home defenders respond to a visible raid while native labor remains accounted for', () => {
  const { s, crew, army, hb, p } = fixture(); Object.assign(hb, p(9)); setMilitary(s, hb, { infantry: 8, ranged: 4 });
  const worker = crew({ ...p(5) }), raider = army(10);
  pulse(s); assert.equal(hb.combat.active, true); assert.equal(hb.combat.targetId, raider.id);
  assert.notEqual(raider.combat.targetId, worker.id); assert.equal(worker.size, 12);
  assert.ok(getSoldiers(s, hb).some(body => body.targetId || body.action === 'advance' || body.action === 'pursue'));
});

test('hidden crew pursuit and attacker identities are withheld by faction projections', () => {
  const { s, crew, army, a, b, p } = fixture(), raider = army(1), worker = crew();
  pulse(s); raider.combat.ignoredWorkerId = worker.id; worker.lastAttackerId = raider.id;
  initializeKnowledge(s, { reset: true }); stepKnowledge(s, { force: true });
  assert.ok(factionView(s, a.id).groups.some(g => g.id === worker.id));
  Object.assign(worker, p(100, 40)); s.step++; stepKnowledge(s, { force: true });
  const own = factionView(s, a.id).groups.find(g => g.id === raider.id);
  assert.equal(own.combat.workerPursuit.targetId, null); assert.equal(own.combat.ignoredWorkerId, null);
  const crewView = factionView(s, b.id).groups.find(g => g.id === worker.id);
  assert.equal(crewView.lastAttackerId, null);
});
