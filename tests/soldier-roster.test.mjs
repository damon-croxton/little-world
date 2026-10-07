import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initializeMilitary, syncMilitary, availableMilitary, allocateMilitary, deployMilitary,
  returnMilitary, demobilizeMilitary, applyMilitaryCasualties, applyHomeCasualties,
  getSoldiers, getSoldier, applySoldierDamage, militaryAtHome,
  queueTraining, advanceTraining, unitStats,
} from '../src/sim/military.js';
import { initializeLedger, ledgerResidual } from '../src/sim/economy.js';

function fixture(species = 'human', units = { infantry: 8, ranged: 4 }) {
  const faction = { id: 'native', name: 'Native', species, traits: { aggression: .5 }, modifiers: {}, advantages: { infantryDamage: 1.15, rangedRange: 1.2 }, knowledge: {}, history: [] };
  const home = { id: 'home', name: 'Home', factionId: faction.id, x: 5, z: 7, radius: 8, population: 100,
    health: 100, wellbeing: 1, status: 'active', buildings: [], assigned: {},
    stock: { food: 1000, water: 1000, energy: 1000, materials: 1000 } };
  const state = { factions: [faction], settlements: [home], groups: [], nodes: [], tradeOffers: [], events: [],
    tick: 1, step: 10, time: 1, nextId: 1, stats: { deaths: 0 } };
  initializeMilitary(home, units, { state, faction });
  initializeLedger(state);
  return { state, home, faction };
}

function expedition(state, home, id, size) {
  const group = { id, kind: 'army', factionId: home.factionId, originId: home.id, units: allocateMilitary(state, home, size),
    size, initialSize: size, x: home.x, z: home.z, phase: 'outbound', carrying: { food: 0, water: 0, energy: 0, materials: 0 } };
  deployMilitary(state, home, group);
  state.groups.push(group);
  return group;
}

function conserved(state) {
  for (const residual of Object.values(ledgerResidual(state))) assert.ok(Math.abs(residual) < 1e-8);
}

test('initial soldiers have unique persistent native identities and seeded species statistics', () => {
  const { state, home, faction } = fixture('machine');
  const roster = home.soldierRoster;
  assert.equal(new Set(roster.map(soldier => soldier.id)).size, 12);
  assert.ok(roster.every(soldier => soldier.species === 'machine' && soldier.nativeFactionId === faction.id && soldier.originId === home.id));
  assert.equal(roster[0].maxHp, unitStats('machine', 'infantry', faction).health);
  assert.equal(roster[0].stats.damage, unitStats('machine', 'infantry', faction).damage);
  assert.equal(roster.at(-1).stats.range, unitStats('machine', 'ranged', faction).range);
  const ids = roster.map(soldier => soldier.id);
  for (let index = 0; index < 5; index++) syncMilitary(state, home);
  assert.equal(home.soldierRoster, roster);
  assert.deepEqual(roster.map(soldier => soldier.id), ids);
  const restored = structuredClone(state);
  assert.equal(getSoldier(restored, ids[0]), restored.settlements[0].soldierRoster[0]);
  assert.equal(home.workers + home.soldiers, home.population);
});

test('funded training adds records only on completion and keeps old soldiers wounded', () => {
  const { state, home, faction } = fixture('hive');
  const spec = unitStats(faction.species, 'ranged', faction);
  home.buildings.push({ id: 'producer', kind: spec.building, progress: 1, hp: 160 });
  const veteran = home.soldierRoster[0], oldIds = new Set(home.soldierRoster.map(soldier => soldier.id));
  applySoldierDamage(state, veteran, 22);
  veteran.attackReadyAt = 19; veteran.targetId = 'remembered-target';
  const job = queueTraining(state, home, faction, 'ranged', 3);
  assert.ok(job);
  assert.equal(home.soldierRoster.length, oldIds.size);
  state.tick += job.duration; state.time = state.tick;
  assert.equal(advanceTraining(state, home, faction), 3);
  const recruits = home.soldierRoster.filter(soldier => !oldIds.has(soldier.id));
  assert.equal(recruits.length, 3);
  assert.ok(recruits.every(soldier => soldier.trainingJobId === job.id && soldier.source === 'training' && soldier.species === 'hive' && soldier.hp === spec.health));
  assert.equal(veteran.hp, veteran.maxHp - 22);
  assert.equal(veteran.attackReadyAt, 19); assert.equal(veteran.targetId, 'remembered-target');
  assert.equal(advanceTraining(state, home, faction), 0);
  assert.equal(home.population, 100); assert.equal(home.soldiers, 15);
  conserved(state);
});

test('two expeditions and stable tower crews claim disjoint existing citizens', () => {
  const { state, home } = fixture();
  const crew = home.soldierRoster.filter(soldier => soldier.role === 'ranged').slice(0, 2);
  crew.forEach(soldier => { soldier.towerId = 'tower'; });
  home.buildings.push({ id: 'tower', kind: 'tower', crewSoldierIds: crew.map(soldier => soldier.id) });
  home.assigned.towerCrew = 2;
  const first = expedition(state, home, 'first', 6), second = expedition(state, home, 'second', 6);
  assert.equal(first.size, 6); assert.equal(second.size, 4);
  assert.equal(new Set([...first.soldierIds, ...second.soldierIds, ...crew.map(soldier => soldier.id)]).size, 12);
  assert.deepEqual(getSoldiers(state, home).map(soldier => soldier.id), crew.map(soldier => soldier.id));
  assert.deepEqual(allocateMilitary(state, home, 100), { infantry: 0, ranged: 0 });
  assert.equal(home.soldiers, 12); assert.equal(home.population, 100);
});

test('exact-ID damage preserves unrelated wounds and debits death and cargo once', () => {
  const { state, home } = fixture();
  const group = expedition(state, home, 'army', 6);
  group.carrying.food = 12; group.capacity = group.cargoCapacity = 18;
  home.stock.food -= 12;
  const [wounded, killed] = getSoldiers(state, group);
  applySoldierDamage(state, wounded, 17);
  const result = applySoldierDamage(state, killed.id, killed.maxHp + 10, { cause: 'combat', sourceSoldierId: 'enemy-body' });
  assert.equal(result.killed, true); assert.equal(result.damage, killed.maxHp);
  assert.equal(killed.status, 'dead'); assert.equal(killed.killedById, 'enemy-body');
  assert.equal(wounded.hp, wounded.maxHp - 17);
  assert.equal(group.size, 5); assert.equal(home.population, 99); assert.equal(home.soldiers, 11);
  assert.equal(group.carrying.food, 10); assert.equal(group.capacity, 15); assert.equal(group.cargoCapacity, 15);
  assert.equal(state.stats.deaths, 1); assert.equal(state.stats.militaryDeaths, 1);
  assert.equal(applySoldierDamage(state, killed, 500).killed, false);
  assert.equal(state.stats.deaths, 1); assert.ok(home.soldierRoster.includes(killed));
  conserved(state);
});

test('physical return keeps the same wounded objects, positions, clocks and targets', () => {
  const { state, home } = fixture();
  const group = expedition(state, home, 'army', 5), bodies = getSoldiers(state, group);
  const wounded = bodies[0]; applySoldierDamage(state, wounded, 21);
  wounded.attackReadyAt = 72; wounded.cooldown = .8; wounded.targetId = 'known-enemy';
  for (const soldier of bodies) Object.assign(soldier, { positioned: true, x: home.x + 1, z: home.z, prevX: home.x + .9, prevZ: home.z });
  bodies.at(-1).x = home.x + 30;
  assert.equal(militaryAtHome(state, home, group), false);
  bodies.at(-1).x = home.x + 2;
  assert.equal(militaryAtHome(state, home, group), true);
  const before = bodies.map(soldier => ({ ...soldier }));
  assert.equal(returnMilitary(state, home, group), true);
  assert.equal(returnMilitary(state, home, group), false);
  for (const [index, soldier] of bodies.entries()) {
    assert.equal(getSoldier(state, soldier.id), soldier);
    assert.deepEqual(soldier, { ...before[index], groupId: null });
  }
  assert.equal(wounded.hp, wounded.maxHp - 21);
  assert.equal(getSoldiers(state, home).length, 12);
  assert.equal(home.population, 100); assert.equal(home.soldiers, 12);
});

test('withdrawing and severely wounded returnees remain home without being remobilized or healed', () => {
  const { state, home } = fixture();
  const previous = expedition(state, home, 'previous', 12), bodies = getSoldiers(state, previous);
  const infantry = bodies.filter(soldier => soldier.role === 'infantry'), ranged = bodies.filter(soldier => soldier.role === 'ranged');
  infantry[0].hp = infantry[0].maxHp * .30;
  infantry[1].withdrawing = true; infantry[1].hp = infantry[1].maxHp * .8;
  ranged[0].hp = ranged[0].maxHp * .38;
  const wounded = [infantry[0], infantry[1], ranged[0]];
  for (const soldier of wounded) { soldier.attackReadyAt = 42; soldier.cooldown = 1.4; soldier.targetId = 'last-visible-opponent'; }
  returnMilitary(state, home, previous);
  const before = wounded.map(soldier => ({ ...soldier })), roster = home.soldierRoster.slice();
  assert.deepEqual(availableMilitary(state, home), { infantry: 8, ranged: 4 });
  assert.deepEqual(allocateMilitary(state, home, 100), { infantry: 6, ranged: 3 });
  // Even a caller supplying an obsolete composition cannot bypass readiness.
  const next = { id: 'next', kind: 'army', factionId: home.factionId, originId: home.id, size: 12, units: { infantry: 8, ranged: 4 } };
  assert.equal(deployMilitary(state, home, next), 9); state.groups.push(next);
  assert.ok(wounded.every(soldier => !next.soldierIds.includes(soldier.id) && soldier.groupId == null));
  assert.deepEqual(getSoldiers(state, home).map(soldier => soldier.id), wounded.map(soldier => soldier.id));
  for (const [index, soldier] of wounded.entries()) assert.deepEqual(soldier, before[index]);
  assert.ok(home.soldierRoster.every((soldier, index) => soldier === roster[index]));
  assert.deepEqual(home.military, { infantry: 8, ranged: 4 }); assert.equal(home.soldiers, 12);
  assert.equal(home.population, 100); assert.equal(home.workers, 88); assert.equal(state.stats.deaths, 0);
  assert.deepEqual(home.trainingQueue, []); conserved(state);
});

test('surrender demobilizes exact returned soldiers and leaves another expedition serving', () => {
  const { state, home } = fixture();
  const returned = expedition(state, home, 'returned', 4), away = expedition(state, home, 'away', 4);
  const originalReserve = getSoldiers(state, home).map(soldier => soldier.id);
  returnMilitary(state, home, returned);
  assert.equal(demobilizeMilitary(state, home, returned.size, { soldierIds: returned.soldierIds }), 4);
  assert.ok(returned.soldierIds.every(id => getSoldier(state, id).status === 'demobilized' && getSoldier(state, id).alive));
  assert.ok(originalReserve.every(id => getSoldier(state, id).status === 'serving'));
  assert.equal(getSoldiers(state, away).length, 4);
  assert.equal(home.population, 100); assert.equal(home.soldiers, 8); assert.equal(state.stats.deaths, 0);
  assert.equal(applySoldierDamage(state, returned.soldierIds[0], 1000).killed, false);
  assert.equal(demobilizeMilitary(state, home, 100), 4);
  assert.equal(getSoldiers(state, away).length, 4);
});

test('home starvation removes actual civilians then local soldiers and protects every away body', () => {
  const { state, home } = fixture('human', { infantry: 8, ranged: 2 });
  home.population = 18;
  const army = expedition(state, home, 'army', 8);
  state.groups.push({ id: 'workers', kind: 'worker', originId: home.id, size: 5 });
  const awayIds = [...army.soldierIds];
  assert.equal(applyHomeCasualties(state, home, 100), 5);
  assert.equal(home.population, 13); assert.equal(home.soldiers, 8); assert.equal(home.workers, 5);
  assert.equal(state.stats.deaths, 5); assert.equal(state.stats.militaryDeaths, 2);
  assert.ok(awayIds.every(id => getSoldier(state, id).status === 'serving'));
  assert.equal(applyHomeCasualties(state, home, 100), 0);
});

test('tampering with aggregate counts neither remints dead IDs nor grants new deployment', () => {
  const { state, home } = fixture();
  const victim = home.soldierRoster[0];
  applySoldierDamage(state, victim, 1000);
  home.military = { infantry: 900, ranged: 900 }; home.soldiers = 1800;
  syncMilitary(state, home);
  assert.deepEqual(home.military, { infantry: 7, ranged: 4 });
  assert.equal(home.soldierRoster.length, 12); assert.equal(victim.status, 'dead');
  const group = expedition(state, home, 'army', 1000);
  group.units.infantry = 1000; group.size = 1004;
  syncMilitary(state, home);
  assert.equal(group.size, 11); assert.equal(group.soldierIds.length, 11);
  assert.deepEqual(availableMilitary(state, home), { infantry: 0, ranged: 0 });
  assert.equal(applyMilitaryCasualties(state, home, group, 1000), 11);
  assert.equal(group.size, 0); assert.equal(group.finished, true);
  assert.equal(home.soldiers, 0); assert.equal(home.population, 88);
  assert.equal(home.soldierRoster.length, 12);
});
