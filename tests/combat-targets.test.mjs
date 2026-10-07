import { setMilitary, recruitMilitary, bindArmy } from './roster-fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSimulation } from '../src/sim/core.js';
import { terrainAt } from '../src/world.js';
import { stepCombat, updateCombatFormation, COMBAT_LIMITS } from '../src/sim/combat.js';
import { countMilitary } from '../src/sim/military.js';
import { occupySettlement } from '../src/sim/conquest.js';
import { lineOfSight, invalidateNavigation } from '../src/sim/navigation.js';
import { emptyResources, initializeLedger, ledgerResidual, RESOURCES } from '../src/sim/economy.js';

// These controlled encounters exercise real terrain, physical slots and the
// actual population/resource ledgers; they are not natural-run balance claims.
function fixture() {
  const s = createSimulation('combat-physical-contract', { civCount: 3 });
  s.groups = []; s.nodes = []; s.events = [];
  for (const home of s.settlements) {
    home.buildings = []; home.assigned = {}; home.population = 300; home.homePresent = 300; home.availableWorkers = 300;
    home.stock = Object.fromEntries(RESOURCES.map(key => [key, 500])); setMilitary(s, home);
  }
  for (const a of s.factions) for (const b of s.factions) if (a !== b) a.relations[b.id] = { status: 'hostile', trust: 0 };
  let center;
  outer: for (let z = -72; z < 72; z += 6) for (let x = -72; x < 72; x += 6) {
    const points = [];
    for (let dz = -10; dz <= 10; dz += 2) for (let dx = -10; dx <= 10; dx += 2) points.push({ x: x + dx, z: z + dz });
    if (points.every(p => terrainAt(p.x, p.z, s.terrainSeed || s.seed).traversable) && lineOfSight(s, { x: x - 7, z }, { x: x + 7, z }, { fromHeight: .6, toHeight: .6 })) { center = { x, z }; break outer; }
  }
  assert.ok(center);
  for (const [i, home] of s.settlements.entries()) Object.assign(home, { x: center.x + 80 + i * 25, z: center.z + 60 });
  initializeLedger(s);
  return { s, center, a: s.factions[0], b: s.factions[1], c: s.factions[2], ha: s.settlements[0], hb: s.settlements[1], hc: s.settlements[2] };
}
const point = (center, x = 0, z = 0) => ({ x: center.x + x, z: center.z + z });
function army(s, home, id, units, position, extras = {}) {
  recruitMilitary(s, home, units);
  const size = countMilitary(units), g = { id, kind: 'army', factionId: home.factionId, originId: home.id, units: { ...units }, size, initialSize: size,
    ...position, prevX: position.x, prevZ: position.z, targetX: position.x, targetZ: position.z, targetId: null, phase: 'outbound', speed: 0,
    morale: 100, supply: 100, carrying: emptyResources(), ...extras };
  bindArmy(s, home, g); s.groups.push(g); return g;
}
function pulse(s) { s.step++; s.time = s.step / 10; s.tick = Math.floor(s.time); stepCombat(s, .1); }
function attackEvents(s, sourceId) { return s.combatEvents.filter(e => ['melee', 'projectile'].includes(e.type) && e.sourceId === sourceId); }

test('capture between launch and impact cancels damage to newly controlled structures', () => {
  const { s, center, ha, hb, a } = fixture();
  const farm = { id: 'captured-farm', kind: 'farm', ...point(center, 3), progress: 1, hp: 160 }; hb.buildings.push(farm);
  const g = army(s, ha, 'archers', { infantry: 0, ranged: 16 }, point(center, -4));
  pulse(s); assert.ok(s.pendingCombat.some(hit => hit.targetId === farm.id));
  Object.assign(hb, point(center, 4)); assert.equal(occupySettlement(s, hb, g), true); assert.equal(hb.occupiedBy, a.id);
  for (let i = 0; i < 12; i++) pulse(s);
  assert.equal(farm.hp, 160, 'the former attacker damaged its newly controlled farm');
  assert.ok(!s.combatEvents.some(e => e.type === 'impact' && e.targetId === farm.id));
});

test('captured mission walls cannot be selected by a stale hostile objective', () => {
  const { s, center, ha, hb, a } = fixture(); Object.assign(hb, point(center, 4)); hb.occupiedBy = a.id;
  const wall = { id: 'now-friendly-wall', kind: 'wall', ...center, rotation: Math.PI / 2, length: 20, width: 1, progress: 1, hp: 240, wallHeight: 4 };
  hb.buildings.push(wall); invalidateNavigation(s);
  const g = army(s, ha, 'stale-breacher', { infantry: 30, ranged: 0 }, point(center, -1.8), { targetId: hb.id, targetX: hb.x, targetZ: hb.z });
  for (let i = 0; i < 20; i++) pulse(s);
  assert.notEqual(g.combat.targetId, wall.id); assert.equal(wall.hp, 240);
  assert.ok(!attackEvents(s, g.id).some(e => e.targetId === wall.id));
});

test('close hostile scout contact returns the intact party without delivering its reports', () => {
  const { s, center, ha, hb, b } = fixture();
  const guard = army(s, ha, 'guard', { infantry: 12, ranged: 0 }, point(center, -1));
  const scout = { id: 'enemy-scout', kind: 'scout', factionId: b.id, originId: hb.id, size: 4, phase: 'outbound', ...point(center, 1),
    targetX: center.x + 20, targetZ: center.z, carrying: { ...emptyResources(), food: 2 }, observations: [{ id: 'unreported-place', x: 18, z: 22, kind: 'settlement', observedTick: 0 }] };
  s.groups.push(scout); initializeLedger(s); const before = structuredClone({ reports: b.knowledge, observations: scout.observations, cargo: scout.carrying, population: hb.population });
  for (let i = 0; i < 30 && scout.phase === 'outbound'; i++) pulse(s);
  assert.equal(scout.phase, 'returning'); assert.equal(scout.targetX, hb.x); assert.equal(scout.size, 4); assert.equal(hb.population, before.population);
  assert.deepEqual(scout.observations, before.observations); assert.deepEqual(b.knowledge, before.reports); assert.deepEqual(scout.carrying, before.cargo);
  assert.equal(s.stats.scoutInterceptions, 1); assert.ok(s.events.some(e => e.type === 'intercept' && e.otherGroupId === scout.id));
  for (let i = 0; i < 30; i++) pulse(s);
  assert.equal(s.stats.scoutInterceptions, 1); assert.equal(guard.combat.active, false);
  for (const residual of Object.values(ledgerResidual(s))) assert.ok(Math.abs(residual) < 1e-7);
});

test('one mixed army attacks separate locally reachable enemies in the same pulse', () => {
  const { s, center, ha, hb, hc } = fixture();
  const main = army(s, ha, 'a-main', { infantry: 20, ranged: 20 }, center);
  const left = army(s, hb, 'b-left', { infantry: 12, ranged: 0 }, point(center, -3));
  const right = army(s, hc, 'c-right', { infantry: 12, ranged: 0 }, point(center, 3));
  pulse(s);
  const targets = new Set(attackEvents(s, main.id).map(e => e.targetId));
  assert.ok(targets.has(left.id) && targets.has(right.id), 'the whole army fired only at its single primary target');
  for (const role of ['infantry', 'ranged']) {
    const events = attackEvents(s, main.id).filter(e => e.role === role), ids = events.flatMap(e => e.shots.map(p => p.sourceSoldierId));
    assert.equal(new Set(ids).size, ids.length, 'a soldier attacked two targets during one role cooldown');
    assert.ok(ids.length <= main.units[role]);
    assert.ok(ids.every(id => main.soldierIds.includes(id)), 'a strike lacked an existing shooter identity');
  }
});

test('nearby native-looking enemy troops are still hostile under another controller', () => {
  const { s, center, ha, hb, a, b } = fixture();
  const main = army(s, ha, 'a-native', { infantry: 12, ranged: 12 }, point(center, -3));
  const auxiliary = army(s, ha, 'b-captured-native', { infantry: 12, ranged: 12 }, point(center, 3), { commandFactionId: b.id });
  pulse(s); assert.equal(main.combat.targetId, auxiliary.id);
  assert.ok(attackEvents(s, auxiliary.id).every(e => e.factionId === b.id));
  assert.ok(attackEvents(s, main.id).every(e => e.factionId === a.id));
});

test('pending troop damage is cancelled when a target capitulates or the factions become allies', () => {
  for (const change of ['capitulation', 'alliance', 'command']) {
    const { s, center, ha, hb, a, b } = fixture();
    const source = army(s, ha, 'a-firing', { infantry: 0, ranged: 20 }, point(center, -3));
    const target = army(s, hb, 'b-target', { infantry: 0, ranged: 20 }, point(center, 3));
    pulse(s); assert.ok(s.pendingCombat.some(hit => hit.sourceId === source.id && hit.targetId === target.id));
    const count = target.size;
    if (change === 'capitulation') b.defeatedBy = a.id;
    else if (change === 'command') source.commandFactionId = b.id;
    else { a.relations[b.id].status = 'allied'; b.relations[a.id].status = 'allied'; }
    for (let i = 0; i < 10; i++) pulse(s);
    assert.equal(target.size, count, change);
    assert.ok(!s.combatEvents.some(e => e.type === 'impact' && e.targetId === target.id), change);
  }
});

test('pending captured-tower shots recheck the tower settlement controller', () => {
  const { s, center, ha, hb, a } = fixture(); Object.assign(hb, point(center, 3));
  const tower = { id: 'captured-tower', kind: 'tower', ...point(center, 2), progress: 1, hp: 300, operational: true, range: 18, crewAssigned: 2 };
  hb.buildings.push(tower); setMilitary(s, hb, { infantry: 0, ranged: 2 });
  const target = army(s, ha, 'a-outside', { infantry: 0, ranged: 20 }, point(center, -3));
  pulse(s); assert.ok(s.pendingCombat.some(hit => hit.sourceId === tower.id && hit.targetId === target.id));
  assert.equal(occupySettlement(s, hb, target), true); assert.equal(hb.occupiedBy, a.id);
  const count = target.size;
  for (let i = 0; i < 10; i++) pulse(s);
  assert.equal(target.size, count); assert.ok(!s.combatEvents.some(e => e.type === 'impact' && e.sourceId === tower.id));
});

test('a garrison fights two local factions even while their armies target each other', () => {
  const { s, center, ha, hb, hc } = fixture(); Object.assign(ha, center); setMilitary(s, ha, { infantry: 16, ranged: 16 });
  const left = army(s, hb, 'b-left', { infantry: 14, ranged: 14 }, point(center, -3));
  const right = army(s, hc, 'c-right', { infantry: 14, ranged: 14 }, point(center, 3));
  pulse(s);
  assert.equal(left.combat.targetId, right.id); assert.equal(right.combat.targetId, left.id);
  assert.ok(ha.combat.active, 'the garrison ignored local armies until they selected its settlement');
  const firedAt = new Set(attackEvents(s, ha.id).map(e => e.targetId));
  assert.ok(firedAt.has(left.id) && firedAt.has(right.id), 'the garrison reserved every soldier for one attacker');
  assert.deepEqual(new Set(ha.combat.localTargetIds), new Set([left.id, right.id]));
});

test('scouts behind cover and friendly scouts are not intercepted; dangerous armies take priority', () => {
  for (const condition of ['covered', 'friendly', 'defender']) {
    const { s, center, ha, hb, a, b } = fixture();
    const guard = army(s, ha, 'guard', { infantry: 24, ranged: 0 }, point(center, -2));
    const scout = { id: 'scout', kind: 'scout', factionId: condition === 'friendly' ? a.id : b.id, originId: hb.id, size: 4, phase: 'outbound', ...point(center, 2) };
    s.groups.push(scout);
    if (condition === 'covered') { hb.buildings.push({ id: 'screen', kind: 'wall', ...center, rotation: Math.PI / 2, length: 24, width: 1, progress: 1, hp: 300, wallHeight: 12 }); invalidateNavigation(s); }
    if (condition === 'defender') army(s, hb, 'defender', { infantry: 20, ranged: 0 }, point(center, -5));
    pulse(s); assert.equal(scout.phase, 'outbound'); assert.notEqual(guard.combat.targetId, scout.id); assert.equal(s.stats.scoutInterceptions || 0, 0);
    if (condition === 'defender') assert.equal(guard.combat.targetId, 'defender');
  }
});

test('losing a local contact resumes the original mission without an automatic return', () => {
  const { s, center, ha, hb } = fixture();
  const main = army(s, ha, 'a-march', { infantry: 24, ranged: 0 }, point(center, -3), { targetId: hb.id, targetX: hb.x, targetZ: hb.z });
  const local = army(s, hb, 'b-contact', { infantry: 10, ranged: 0 }, point(center, 3));
  pulse(s); assert.equal(main.combat.targetId, local.id);
  local.finished = true;
  pulse(s); assert.equal(main.phase, 'outbound'); assert.equal(main.combat.active, false); assert.equal(main.targetId, hb.id); assert.equal(main.targetX, hb.x); assert.equal(main.targetZ, hb.z);
});

test('contact lists stay bounded and unseen remote forces do not alter local volleys', () => {
  const { s, center, ha, hb } = fixture();
  const main = army(s, ha, 'a-main', { infantry: 60, ranged: 30 }, center);
  for (let i = 0; i < 9; i++) army(s, hb, `b-local-${i}`, { infantry: 3, ranged: 0 }, point(center, Math.cos(i) * 6, Math.sin(i) * 6));
  const alternate = structuredClone(s);
  army(alternate, alternate.settlements[1], 'hidden-remote', { infantry: 100, ranged: 100 }, point(center, 80, 80));
  pulse(s); pulse(alternate);
  assert.equal(main.combat.localTargetIds.length, COMBAT_LIMITS.localTargets);
  assert.deepEqual(main.combat, alternate.groups[0].combat);
  assert.deepEqual(attackEvents(s, main.id), attackEvents(alternate, main.id));
});

test('physical formation contacts include both locally supplied flanks', () => {
  const { s, center, ha, hb, hc } = fixture();
  const main = army(s, ha, 'main', { infantry: 30, ranged: 0 }, center);
  const left = army(s, hb, 'left', { infantry: 12, ranged: 0 }, point(center, -3));
  const right = army(s, hc, 'right', { infantry: 12, ranged: 0 }, point(center, 3));
  for (const g of [main, left, right]) updateCombatFormation(s, g, g.units, 0);
  updateCombatFormation(s, main, main.units, .1, { contact: true, primaryTargetId: left.id,
    localTargets: [left, right].map(g => ({ id: g.id, kind: 'group', x: g.x, z: g.z, units: g.units, entity: g })) });
  const ids = new Set(main.formationSlots.infantry.map(p => p.contactId));
  assert.ok(ids.has(left.id) && ids.has(right.id));
});
