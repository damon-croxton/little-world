import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createSimulation } from '../src/sim/core.js';
import { stepCombat, initializeSoldierPositions } from '../src/sim/combat.js';
import { getSoldiers } from '../src/sim/soldiers.js';
import { terrainAt } from '../src/world.js';
import { lineOfSight, navigationDiagnostics, invalidateNavigation } from '../src/sim/navigation.js';
import { setMilitary, recruitMilitary, bindArmy } from './roster-fixtures.mjs';
import { auditState } from './balance.mjs';
import { initializeLedger } from '../src/sim/economy.js';

let field;
function fixture(count = 12, role = 'ranged') {
  const s = createSimulation('combat-physical-contract', { civCount: 3 });
  s.groups = []; s.nodes = [];
  for (const home of s.settlements) { home.buildings = []; home.assigned = {}; home.population = 900; setMilitary(s, home); }
  for (const faction of s.factions) {
    faction.species = 'human';
    for (const other of s.factions) if (other !== faction) faction.relations[other.id] = { status: 'hostile', trust: 0 };
  }
  if (!field) outer: for (let z = -72; z < 72; z += 6) for (let x = -72; x < 72; x += 6) {
    let clear = true;
    for (let dz = -12; dz <= 12 && clear; dz += 2) for (let dx = -12; dx <= 12; dx += 2) if (!terrainAt(x + dx, z + dz, s.seed).traversable) { clear = false; break; }
    if (clear && lineOfSight(s, { x: x - 8, z }, { x: x + 8, z }, { fromHeight: .6, toHeight: .6 })) { field = { x, z }; break outer; }
  }
  assert.ok(field);
  const armies = [];
  for (const [index, home] of s.settlements.entries()) {
    home.x = field.x + 50 + index * 20; home.z = field.z + 50;
    if (index > 1) continue;
    const units = { infantry: role === 'infantry' ? count : 0, ranged: role === 'ranged' ? count : 0 };
    recruitMilitary(s, home, units);
    const army = { id: `test-${index}`, kind: 'army', factionId: home.factionId, originId: home.id, units, size: count, initialSize: count,
      x: field.x + (index ? 3 : -3), z: field.z, phase: 'outbound', morale: 100, supply: 100, speed: 0 };
    bindArmy(s, home, army); s.groups.push(army); armies.push(army);
  }
  initializeSoldierPositions(s);
  return { s, a: armies[0], b: armies[1] };
}
function pulse(s) { s.step++; s.time = s.step / 10; s.tick = Math.floor(s.time); stepCombat(s, .1); }

test('world soldiers keep independent weapon clocks and every launch names its exact target', () => {
  const { s, a } = fixture(8), soldiers = getSoldiers(s, a), ready = soldiers[3];
  for (const body of soldiers) body.attackReadyAt = body === ready ? 0 : 20;
  pulse(s);
  const shots = s.pendingCombat.filter(shot => shot.sourceId === a.id);
  assert.equal(shots.length, 1); assert.equal(shots[0].sourceSoldierId, ready.id);
  assert.ok(shots[0].targetSoldierId); assert.equal(shots[0].rays.length, 1);
  assert.ok(ready.attackReadyAt > s.time); assert.ok(soldiers.filter(body => body !== ready).every(body => body.attackReadyAt === 20));
});

test('a physically eligible ranged formation exceeds the former 24-soldier volley cap', () => {
  const { s, a } = fixture(60);
  pulse(s);
  const shots = s.pendingCombat.filter(shot => shot.sourceId === a.id);
  assert.ok(shots.length > 24, `Only ${shots.length} individually ready archers fired`);
  assert.equal(new Set(shots.map(shot => shot.sourceSoldierId)).size, shots.length);
  assert.ok(shots.every(shot => shot.damage > 0 && shot.targetSoldierId));
});

test('a wounded member withdraws independently without removing its physical target or identity', () => {
  const { s, a } = fixture(12, 'infantry'), soldiers = getSoldiers(s, a), wounded = soldiers[0], before = { x: wounded.x, z: wounded.z };
  wounded.hp = wounded.maxHp * .25;
  pulse(s);
  assert.equal(wounded.action, 'withdraw'); assert.equal(wounded.reasonCode, 'wounded-withdrawal');
  assert.equal(a.phase, 'engaging'); assert.ok(soldiers.some(body => body !== wounded && body.action !== 'withdraw'));
  assert.ok(getSoldiers(s, a).includes(wounded)); assert.ok(a.formationSlots.infantry.includes(wounded));
  assert.ok(Math.hypot(wounded.x - before.x, wounded.z - before.z) <= .4);
  assert.equal(wounded.hp, wounded.maxHp * .25, 'movement healed or reassigned the wounded citizen');
});

test('physical targets stay stable while viable and faster escape receives an explicit pursuit refusal', () => {
  const { s, a, b } = fixture(8, 'infantry');
  for (const body of getSoldiers(s, b)) { body.vx = 20; body.vz = 0; }
  pulse(s);
  assert.ok(getSoldiers(s, a).some(body => body.reasonCode === 'pursuit-refused'));
  assert.ok(s.individualCombatMetrics.pursuitRefusals > 0);
  for (let i = 0; i < 5; i++) pulse(s);
  assert.ok(getSoldiers(s, a).every(body => !body.intercept || body.intercept.time <= 3));
});

test('an unreachable wounded withdrawal stores finite state and cannot teleport through cover', () => {
  const { s, a } = fixture(1, 'infantry'), home = s.settlements.find(town => town.id === a.originId), body = getSoldiers(s, a)[0];
  Object.assign(home, { x: field.x + 8, z: field.z });
  home.buildings.push({ id: 'blocked-withdrawal-home', kind: 'wall', x: home.x, z: home.z, length: 8, width: 3, wallHeight: 8, progress: 1, hp: 500 });
  invalidateNavigation(s); initializeLedger(s);
  body.hp = body.maxHp * .2;
  const before = { x: body.x, z: body.z, hp: body.hp };
  for (let i = 0; i < 3; i++) {
    pulse(s);
    assert.equal(body.action, 'withdraw');
    assert.equal(a.combat.withdrawalRoute.reachable, false);
    assert.equal(a.combat.withdrawalRoute.reason, 'blocked-target');
    assert.equal(a.combat.withdrawalRoute.length, null);
    assert.deepEqual(a.combat.withdrawalRoute.waypoints, []);
    assert.deepEqual({ x: body.x, z: body.z, hp: body.hp }, before);
    auditState(s);
  }
});

test('240 world soldiers use the shared physical navigation and bounded local index', t => {
  const { s } = fixture(120), before = navigationDiagnostics(s), start = performance.now();
  for (let i = 0; i < 30; i++) pulse(s);
  const elapsed = performance.now() - start, after = navigationDiagnostics(s);
  assert.equal(s.individualCombatMetrics.living + s.stats.combatDeaths, 240);
  assert.ok(s.pendingCombat.every(shot => shot.sourceSoldierId && shot.targetSoldierId));
  assert.ok((after.pathSearches ?? after.searches ?? 0) - (before.pathSearches ?? before.searches ?? 0) < 30, 'individual soldiers launched global route searches');
  t.diagnostic(`240 canonical world soldiers / 30 combat pulses: ${elapsed.toFixed(1)}ms (${(elapsed / 30).toFixed(2)}ms/pulse); local candidate checks last pulse ${s.individualCombatMetrics.candidateChecks}`);
});
