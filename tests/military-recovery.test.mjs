import test from 'node:test';
import assert from 'node:assert/strict';
import { createSimulation, stepSimulation } from '../src/sim/core.js';
import { initializeMilitary, recoverMilitary, trainingCost, trainingReserves, allocateMilitary, deployMilitary, returnMilitary } from '../src/sim/military.js';
import { getSoldier, applySoldierDamage } from '../src/sim/soldiers.js';
import { initializeLedger, ledgerResidual, RESOURCES } from '../src/sim/economy.js';
import { auditIndividualState } from './world-individual-audit.mjs';

function fixture(species = 'human', count = 1) {
  const state = createSimulation('joined-screen', { civCount: 3 });
  Object.assign(state, { tick: 100, time: 100, step: 1000, groups: [], nodes: [], tradeOffers: [] });
  const faction = state.factions.find(f => f.species === species), home = state.settlements.find(h => h.factionId === faction.id);
  Object.assign(home, { population: 100, homePresent: 100, availableWorkers: 80, health: 100, wellbeing: 1, shortageDays: 0, status: 'active', radius: 8 });
  home.stock = Object.fromEntries(RESOURCES.map(key => [key, 1000]));
  initializeMilitary(home, { infantry: count, ranged: 0 }, { state, faction });
  for (const body of home.soldierRoster) Object.assign(body, { x: home.x, z: home.z, positioned: true, hp: body.maxHp * .25, withdrawing: true, attackReadyAt: 103.7, cooldown: 1.2 });
  initializeLedger(state);
  return { state, home, faction, body: home.soldierRoster[0] };
}
function cycle(state, home) { state.tick++; state.time++; state.step += 10; return recoverMilitary(state, home); }
function conserved(state) {
  for (const residual of Object.values(ledgerResidual(state))) assert.ok(Math.abs(residual) < 1e-7, `Resource residual ${residual}`);
  auditIndividualState(state);
}

for (const species of ['human', 'machine', 'hive']) test(`${species} veterans receive gradual paid home recovery without changing identity, census or weapon clocks`, () => {
  const { state, home, faction, body } = fixture(species), hp = body.hp, stock = { ...home.stock }, population = home.population;
  const position = { x: body.x, z: body.z }, cost = trainingCost(faction, body.role);
  const report = recoverMilitary(state, home);
  assert.equal(report.treated, 1); assert.equal(body.hp, hp + body.maxHp * .02);
  for (const key of RESOURCES) {
    assert.ok(Math.abs(stock[key] - home.stock[key] - cost[key] * .4 * .02) < 1e-10);
    assert.ok(Math.abs(state.resourceLedger[key].consumed - cost[key] * .4 * .02) < 1e-10);
  }
  const after = { ...home.stock };
  recoverMilitary(state, home);
  assert.deepEqual(home.stock, after, 'repeated call in the same cycle charged twice');
  assert.equal(body.hp, hp + body.maxHp * .02);
  while (body.hp < body.maxHp * .73 - 1e-7) cycle(state, home);
  assert.equal(body.withdrawing, true); assert.equal(allocateMilitary(state, home, 1).infantry, 0);
  for (let i = 0; i < 2 && body.withdrawing; i++) cycle(state, home);
  assert.equal(body.withdrawing, false); assert.equal(state.stats.recoveredSoldiers, 1);
  assert.equal(allocateMilitary(state, home, 1).infantry, 1, 'recovered veteran cannot reinforce');
  assert.equal(getSoldier(state, body.id), body); assert.equal(home.population, population); assert.equal(home.soldiers, 1);
  assert.deepEqual({ x: body.x, z: body.z }, position); assert.equal(body.attackReadyAt, 103.7); assert.equal(body.cooldown, 1.2);
  for (let i = 0; i < 20; i++) cycle(state, home);
  assert.equal(body.hp, body.maxHp); assert.equal(state.stats.recoveredSoldiers, 1);
  conserved(state);
});

test('home treatment cannot heal a deployed soldier, a distant returnee or a dead citizen', () => {
  const { state, home, body } = fixture(); body.withdrawing = false; body.hp = body.maxHp;
  const group = { id: 'returning-veteran', kind: 'army', originId: home.id, factionId: home.factionId, units: { infantry: 1, ranged: 0 } };
  deployMilitary(state, home, group); state.groups.push(group);
  body.hp = body.maxHp * .25; body.withdrawing = true;
  const hp = body.hp, stock = { ...home.stock };
  assert.equal(recoverMilitary(state, home).treated, 0); assert.equal(body.hp, hp);
  returnMilitary(state, home, group); state.groups = [];
  body.x = home.x + 30;
  assert.equal(cycle(state, home).treated, 0); assert.equal(body.hp, hp);
  body.x = home.x;
  assert.equal(cycle(state, home).treated, 1);
  assert.equal(body.hp, hp + body.maxHp * .02);
  applySoldierDamage(state, body, body.maxHp);
  const spent = { ...home.stock };
  assert.equal(cycle(state, home).treated, 0); assert.equal(body.hp, 0); assert.equal(body.status, 'dead');
  assert.deepEqual(home.stock, spent); assert.notDeepEqual(home.stock, stock);
  conserved(state);
});

test('combat, recent attacks, shortages and depleted reserves all pause treatment', () => {
  const blockers = [
    ({ home }) => { home.combat = { active: true }; },
    ({ state, home }) => { home.contestedUntil = state.tick + 3; },
    ({ home }) => { home.health = 44; },
    ({ home }) => { home.shortageDays = 1; },
    ({ home }) => { home.wellbeing = .9; },
    ({ state, body }) => { body.lastHitTime = state.time - 7.9; },
    ({ state, body }) => { body.lastAttackTime = state.time - 7.9; },
    ({ body }) => { body.positioned = false; },
    ({ home, faction }) => { home.stock = trainingReserves(home, faction, 12); },
  ];
  for (const block of blockers) {
    const value = fixture(); block(value); initializeLedger(value.state);
    const hp = value.body.hp, stock = { ...value.home.stock };
    assert.equal(recoverMilitary(value.state, value.home).treated, 0, block.toString());
    assert.equal(value.body.hp, hp); assert.deepEqual(value.home.stock, stock); assert.equal(value.body.withdrawing, true);
    conserved(value.state);
  }
});

test('treatment capacity rotates among wounded identities and respects civilian survival reserves', () => {
  const { state, home } = fixture('human', 12), before = home.soldierRoster.map(body => body.hp);
  assert.equal(recoverMilitary(state, home).treated, 6);
  assert.equal(cycle(state, home).treated, 6);
  assert.ok(home.soldierRoster.every((body, i) => body.hp === before[i] + body.maxHp * .02));
  conserved(state);
});

test('unseen enemies cannot alter treatment, and an occupied native home cannot restore its former army', () => {
  const ordinary = fixture(), hidden = fixture();
  const enemy = hidden.state.settlements[1];
  initializeMilitary(enemy, { infantry: 300, ranged: 0 }, { state: hidden.state });
  enemy.population = 400; enemy.workers = 100; enemy.x += 200; enemy.z += 200;
  assert.deepEqual(recoverMilitary(ordinary.state, ordinary.home), recoverMilitary(hidden.state, hidden.home));
  assert.equal(ordinary.body.hp, hidden.body.hp); assert.deepEqual(ordinary.home.stock, hidden.home.stock);
  const occupied = fixture(); occupied.home.occupiedBy = occupied.state.factions[1].id;
  const hp = occupied.body.hp, stock = { ...occupied.home.stock };
  assert.equal(recoverMilitary(occupied.state, occupied.home).treated, 0);
  assert.equal(occupied.body.hp, hp); assert.deepEqual(occupied.home.stock, stock);
  conserved(occupied.state);
});

test('the ordinary economic cycle funds recovery after survival journeys', () => {
  const { state, home, body } = fixture();
  for (const faction of state.factions) faction.lastCampaign = state.tick;
  const hp = body.hp;
  stepSimulation(state, 10);
  assert.equal(home.militaryRecovery.tick, state.tick);
  assert.equal(home.militaryRecovery.treated, 1);
  assert.ok(body.hp > hp); assert.equal(body.withdrawing, true);
  conserved(state);
});
