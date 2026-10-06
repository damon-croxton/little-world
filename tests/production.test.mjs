import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MILITARY_ROLES, MILITARY_BUILDINGS, unitStats, initializeMilitary, countMilitary,
  queueTraining, advanceTraining, cancelTraining, trainingCount, trainingCost,
  allocateMilitary, availableMilitary, applyMilitaryCasualties, applyHomeCasualties,
  demobilizeMilitary, returnMilitary, militaryBuildingPlan,
} from '../src/sim/military.js';
import { RESOURCES, initializeLedger, ledgerResidual } from '../src/sim/economy.js';
import { DEFENSE_STATS, assignDefenses, defenseCost, defenseAmmoCost } from '../src/sim/defenses.js';

function fixture(species = 'human', role = 'infantry') {
  const faction = { id: 'f0', name: 'Test society', species, traits: { aggression: .5 }, modifiers: {}, knowledge: {}, history: [] };
  const spec = unitStats(species, role);
  const home = { id: 's0', factionId: faction.id, name: 'Test colony', x: 0, z: 0, population: 100,
    health: 100, wellbeing: 1, shortageDays: 0, status: 'active', stock: { food: 1000, water: 1000, energy: 1000, materials: 1000 }, capacity: 1000,
    assigned: { civilianAway: 0, workers: 0, researchers: 6, construction: 10, infrastructure: 4, military: 0, training: 0 },
    buildings: [{ id: 'b0', kind: spec.building, x: 0, z: 0, progress: 1, hp: 160, maxHp: 160 }], availableWorkers: 66 };
  initializeMilitary(home, { infantry: 10, ranged: 4 });
  const state = { seed: 'production-test', tick: 1, step: 10, time: 1, nextId: 1, events: [], factions: [faction], settlements: [home], groups: [], nodes: [], tradeOffers: [], stats: { deaths: 0 } };
  initializeLedger(state);
  return { state, home, faction, spec };
}
function assertConserved(state) {
  for (const value of Object.values(ledgerResidual(state))) assert.ok(Math.abs(value) < 1e-7, `resource residual ${value}`);
}
function atTick(state, tick) { state.tick = tick; state.step = tick * 10; state.time = tick; }

test('each species has distinct paid melee and ranged producers and role-specific equipment', () => {
  const producers = new Set();
  for (const species of ['human', 'machine', 'hive']) for (const role of MILITARY_ROLES) {
    const { state, home, faction, spec } = fixture(species, role);
    const before = { ...home.stock }, population = home.population, soldiers = home.soldiers;
    const expected = trainingCost(faction, role, 3);
    producers.add(spec.building);
    const job = queueTraining(state, home, faction, role, 3);
    assert.ok(job, `${species}/${role} cannot train`);
    assert.equal(job.role, role);
    assert.equal(job.duration, spec.trainingCycles);
    assert.ok(spec.trainingCycles >= 10, 'instant training');
    assert.equal(home.population, population);
    assert.equal(home.soldiers, soldiers);
    assert.equal(home.assigned.training, 3);
    for (const kind of RESOURCES) {
      assert.ok(Math.abs(before[kind] - home.stock[kind] - expected[kind]) < 1e-8);
      assert.equal(state.resourceLedger[kind].training, expected[kind]);
    }
    assertConserved(state);
  }
  assert.equal(producers.size, 6);
  assert.equal(Object.keys(MILITARY_BUILDINGS).length, 6);
  assert.ok(unitStats('human', 'ranged').range > unitStats('human', 'infantry').range * 3);
});

test('incomplete, missing, destroyed and wrong-species buildings cannot produce units', () => {
  for (const variant of ['incomplete', 'missing', 'destroyed', 'zero-hp', 'wrong-species']) {
    const { state, home, faction } = fixture();
    if (variant === 'incomplete') home.buildings[0].progress = .99;
    if (variant === 'missing') home.buildings = [];
    if (variant === 'destroyed') home.buildings[0].destroyed = true;
    if (variant === 'zero-hp') home.buildings[0].hp = 0;
    if (variant === 'wrong-species') home.buildings[0].kind = 'brooder';
    const before = structuredClone(home);
    assert.equal(queueTraining(state, home, faction, 'infantry', 3), null, variant);
    assert.deepEqual(home, before);
    assertConserved(state);
  }
});

test('one paid queue reserves actual unassigned citizens and cannot reserve builders, field crews or researchers twice', () => {
  const { state, home, faction } = fixture();
  state.groups.push({ id: 'workers', originId: home.id, kind: 'worker', size: 58 });
  home.assigned.civilianAway = home.assigned.workers = 58;
  home.availableWorkers = 8;
  assert.equal(queueTraining(state, home, faction, 'infantry', 2), null, 'overbooked citizens');
  state.groups[0].size = 42;
  const before = { ...home.stock };
  assert.ok(queueTraining(state, home, faction, 'infantry', 4));
  assert.equal(trainingCount(home), 4);
  assert.equal(home.availableWorkers, 20);
  assert.equal(home.population, home.soldiers + 42 + home.assigned.training + 6 + 10 + 4 + home.availableWorkers);
  const paid = { ...home.stock };
  assert.equal(queueTraining(state, home, faction, 'infantry', 2), null, 'two jobs in one producer');
  assert.deepEqual(home.stock, paid);
  assert.ok(before.materials > paid.materials);
  assertConserved(state);
});

test('training finishes after finite simulation time exactly once without minting population', () => {
  const { state, home, faction, spec } = fixture();
  const population = home.population, soldiers = home.soldiers;
  const job = queueTraining(state, home, faction, 'infantry', 5);
  const paidStock = { ...home.stock }, paidLedger = structuredClone(state.resourceLedger);
  atTick(state, job.startedTick + spec.trainingCycles - 1);
  assert.equal(advanceTraining(state, home, faction), 0);
  assert.equal(home.soldiers, soldiers);
  assert.equal(home.assigned.training, 5);
  atTick(state, state.tick + 1);
  assert.equal(advanceTraining(state, home, faction), 5);
  assert.equal(home.soldiers, soldiers + 5);
  assert.equal(home.military.infantry, 15);
  assert.equal(home.population, population);
  assert.equal(home.workers + home.soldiers, population);
  assert.equal(home.assigned.training, 0);
  assert.equal(home.trainingQueue.length, 0);
  assert.equal(advanceTraining(state, home, faction), 0);
  atTick(state, state.tick + 100);
  assert.equal(advanceTraining(state, home, faction), 0);
  assert.equal(home.soldiers, soldiers + 5);
  assert.equal(state.stats.trained, 5);
  assert.deepEqual(home.stock, paidStock);
  assert.deepEqual(state.resourceLedger, paidLedger);
  assertConserved(state);
});

test('unfunded training changes nothing and keeps survival reserves available', () => {
  const { state, home, faction } = fixture();
  home.stock.materials = 1;
  initializeLedger(state);
  const before = structuredClone(home);
  assert.equal(queueTraining(state, home, faction, 'infantry', 3), null);
  assert.deepEqual(home, before);
  assert.equal(state.stats.trainingStarted, undefined);
  assertConserved(state);
});

test('siege and scarcity pause training progress without replaying missed work afterward', () => {
  const { state, home, faction } = fixture();
  const job = queueTraining(state, home, faction, 'infantry', 2);
  atTick(state, 6); home.contestedUntil = 6;
  advanceTraining(state, home, faction);
  assert.equal(job.remaining, job.duration);
  atTick(state, 7); home.wellbeing = .5;
  advanceTraining(state, home, faction);
  assert.equal(job.remaining, job.duration);
  atTick(state, 8); home.wellbeing = 1;
  advanceTraining(state, home, faction);
  assert.equal(job.remaining, job.duration - 1);
  assert.equal(home.assigned.training, 2);
});

test('cancelled or destroyed production releases surviving trainees and never completes or refunds twice', () => {
  for (const variant of ['cancel', 'removed', 'destroyed', 'camp']) {
    const { state, home, faction } = fixture();
    const job = queueTraining(state, home, faction, 'infantry', 4);
    const before = { population: home.population, soldiers: home.soldiers, stock: { ...home.stock }, ledger: structuredClone(state.resourceLedger) };
    if (variant === 'cancel') assert.equal(cancelTraining(state, home, job.id), 4);
    if (variant === 'removed') home.buildings = [];
    if (variant === 'destroyed') home.buildings[0].hp = 0;
    if (variant === 'camp') home.status = 'camp';
    atTick(state, 40); advanceTraining(state, home, faction);
    assert.equal(home.population, before.population);
    assert.equal(home.soldiers, before.soldiers);
    assert.equal(home.trainingQueue.length, 0);
    assert.equal(home.assigned.training, 0);
    assert.equal(cancelTraining(state, home, job.id), 0);
    assert.equal(state.stats.trainingCancelled, 4);
    assert.deepEqual(home.stock, before.stock);
    assert.deepEqual(state.resourceLedger, before.ledger);
    assertConserved(state);
  }
});

test('deployment, role casualties, cargo loss and return preserve exact military population', () => {
  const { state, home } = fixture();
  const units = allocateMilitary(state, home, 10);
  assert.equal(countMilitary(units), 10);
  const group = { id: 'army', originId: home.id, kind: 'army', units, size: 10, carrying: { food: 10, water: 0, energy: 0, materials: 0 }, capacity: 12, cargoCapacity: 12 };
  home.stock.food -= 10;
  state.groups.push(group);
  const original = { ...units };
  assert.equal(home.soldiers, 14);
  assert.equal(countMilitary(availableMilitary(state, home)), 4);
  assert.equal(countMilitary(allocateMilitary(state, home, 100)), 4);
  const lost = applyMilitaryCasualties(state, home, group, 3, { role: 'infantry' });
  assert.equal(lost, 3);
  assert.equal(group.units.infantry, original.infantry - 3);
  assert.equal(group.units.ranged, original.ranged);
  assert.equal(group.size, 7);
  assert.equal(group.carrying.food, 7);
  assert.ok(Math.abs(group.capacity - 8.4) < 1e-8);
  assert.equal(home.population, 97);
  assert.equal(home.soldiers, 11);
  assert.equal(state.stats.deaths, 3);
  assertConserved(state);
  assert.equal(returnMilitary(state, home, group), true);
  assert.equal(returnMilitary(state, home, group), false);
  assert.equal(home.soldiers, 11);
  assert.equal(countMilitary(availableMilitary(state, home)), 11);
  assert.equal(applyMilitaryCasualties(state, home, group, 50), 0, 'returned party killed twice');
});

test('home scarcity cancels unsupported trainees and never kills citizens already deployed elsewhere', () => {
  const { state, home, faction } = fixture();
  initializeMilitary(home, { infantry: 8, ranged: 2 });
  home.population = 18;
  home.assigned = { researchers: 0, construction: 0, infrastructure: 0 };
  state.groups.push({ id: 'workers', originId: home.id, kind: 'worker', size: 5 }, { id: 'army', originId: home.id, kind: 'army', size: 8, units: { infantry: 6, ranged: 2 } });
  assert.ok(queueTraining(state, home, faction, 'infantry', 3, { civilianReserve: 0, reserves: {} }));
  assert.equal(applyHomeCasualties(state, home, 10), 5);
  assert.equal(home.population, 13);
  assert.equal(home.soldiers, 8);
  assert.equal(home.workers, 5);
  assert.equal(trainingCount(home), 0);
  assert.equal(state.groups[1].size, 8);
  assert.equal(state.stats.deaths, 5);
  assert.equal(applyHomeCasualties(state, home, 10), 0);
  assertConserved(state);
});

test('tower crew reserves existing ranged troops and cannot be duplicated into dispatch', () => {
  const { state, home, faction } = fixture();
  home.buildings.push({ id: 'tower', kind: 'tower', progress: 1, hp: DEFENSE_STATS.tower.maxHp, maxHp: DEFENSE_STATS.tower.maxHp });
  assert.equal(assignDefenses(state, home, faction), 2);
  assert.equal(home.assigned.towerCrew, 2);
  assert.equal(home.buildings[1].operational, true);
  const units = allocateMilitary(state, home, 100);
  assert.deepEqual(units, { infantry: 10, ranged: 2 });
  assert.equal(home.population, 100);
  home.buildings[1].hp = 0;
  assert.equal(assignDefenses(state, home, faction), 0);
  assert.equal(home.buildings[1].operational, false);
  assert.deepEqual(allocateMilitary(state, home, 100), home.military);
  for (const species of ['human', 'machine', 'hive']) {
    assert.ok(defenseCost(species, 'wall').materials > 0);
    assert.ok(Object.values(defenseAmmoCost(species)).reduce((a, b) => a + b, 0) > 0);
  }
});

test('demobilization releases only home soldiers and production planning replaces a destroyed producer', () => {
  const { state, home, faction } = fixture();
  state.groups.push({ id: 'army', originId: home.id, kind: 'army', size: 8, units: { infantry: 6, ranged: 2 } });
  assert.equal(demobilizeMilitary(state, home, 100), 6);
  assert.deepEqual(home.military, { infantry: 6, ranged: 2 });
  assert.equal(home.population, 100);
  atTick(state, 50);
  home.buildings[0].hp = 0;
  assert.equal(militaryBuildingPlan(state, home, faction), 'barracks');
});

test('ordinary simulation physically builds both producer classes and trains both roles from conserved stores', async () => {
  const { createSimulation, stepSimulation } = await import('../src/sim/core.js');
  const state = createSimulation('first-light');
  const initialPopulation = state.settlements.reduce((sum, home) => sum + home.population, 0);
  assert.ok(state.settlements.every(home => home.buildings.every(building => !MILITARY_BUILDINGS[building.kind])), 'starting producer bypasses paid construction');
  for (let cycle = 0; cycle < 120; cycle++) {
    stepSimulation(state, 10);
    for (const home of state.settlements) {
      assert.equal(home.soldiers, countMilitary(home.military));
      for (const job of home.trainingQueue) {
        const producer = home.buildings.find(building => building.id === job.buildingId);
        assert.ok(producer?.progress >= 1 && producer.hp > 0);
        assert.equal(producer.kind, unitStats(state.factions.find(f => f.id === home.factionId).species, job.role).building);
      }
    }
  }
  assert.ok(state.stats.infantryTrained > 0);
  assert.ok(state.stats.rangedTrained > 0);
  for (const faction of state.factions) {
    const home = state.settlements.find(candidate => candidate.factionId === faction.id);
    for (const role of MILITARY_ROLES) {
      const producer = home.buildings.find(building => building.kind === unitStats(faction.species, role).building);
      assert.ok(producer?.progress >= 1 && producer.createdTick > 0 && producer.completedTick > producer.createdTick, `${faction.species} ${role} producer did not physically finish`);
    }
  }
  assert.equal(state.settlements.reduce((sum, home) => sum + home.population, 0), initialPopulation + state.stats.births - state.stats.deaths);
  assert.ok(state.resourceLedger.materials.construction > 0);
  assert.ok(state.resourceLedger.materials.training > 0);
  assertConserved(state);
});

test('abandonment cancels paid courses and marks unfinished producers lost so rebuilding is not permanently blocked', async () => {
  const { createSimulation, stepSimulation } = await import('../src/sim/core.js');
  const { spend } = await import('../src/sim/economy.js');
  const state = createSimulation('production-abandonment'), home = state.settlements[0], faction = state.factions[0];
  const infantry = unitStats(faction.species, 'infantry'), ranged = unitStats(faction.species, 'ranged');
  for (const kind of RESOURCES) home.stock[kind] = 1000;
  home.buildings.push({ id: 'fixture-infantry-producer', kind: infantry.building, x: home.x, z: home.z, progress: 1, hp: 160, maxHp: 160 });
  initializeLedger(state);
  const order = queueTraining(state, home, faction, 'infantry', 3);
  assert.ok(order);
  const cost = MILITARY_BUILDINGS[ranged.building].cost;
  spend(state, home, cost, 'construction');
  const unfinished = { id: 'fixture-ranged-producer', kind: ranged.building, x: home.x + 2, z: home.z, progress: .2, hp: 160, maxHp: 160, fundedCost: { ...cost } };
  home.buildings.push(unfinished);
  home.construction = { buildingId: unfinished.id, kind: unfinished.kind, workers: 10, progress: .2, cost, startedTick: state.tick };
  home.defeat = { reason: 'A regression fixture breaches the settlement', attackerId: state.factions[1].id };
  stepSimulation(state, 10);
  assert.equal(home.status, 'camp');
  assert.equal(home.trainingQueue.length, 0);
  assert.equal(home.construction, null);
  assert.equal(unfinished.destroyed, true);
  assert.equal(unfinished.hp, 0);
  assert.equal(home.soldiers, 0, 'home militia were not demobilized among displaced civilians');
  assertConserved(state);
  home.status = 'active'; home.health = 100; home.shortageDays = 0; home.wellbeing = 1;
  atTick(state, 200);
  assert.equal(militaryBuildingPlan(state, home, faction), ranged.building);
});

test('a wall cannot become solid around a passing party, and its completion never moves the party', async () => {
  const { canCompleteDefense } = await import('../src/sim/defenses.js');
  const wall = { kind: 'wall', x: 20, z: 30, rotation: Math.PI / 2, length: 7, width: 1 };
  const party = { id: 'passing-scout', kind: 'scout', size: 4, x: 20.5, z: 32 };
  const state = { groups: [party] }, before = { ...party };
  assert.equal(canCompleteDefense(state, wall), false);
  assert.deepEqual(party, before);
  party.x = 22;
  assert.equal(canCompleteDefense(state, wall), true);
  assert.equal(canCompleteDefense(state, { ...wall, kind: 'tower' }), true);
});

test('journey ration planning pays for terrain travel and a real harvesting interval', async () => {
  const { estimateJourneyCycles } = await import('../src/sim/core.js');
  const { terrainFeatures } = await import('../src/world.js');
  const { findPath, moveAlongRoute } = await import('../src/sim/navigation.js');
  const state = { seed: 'navigation-river', step: 0, tick: 0, time: 0, groups: [], settlements: [], factions: [] };
  const ford = terrainFeatures(state.seed).passes.find(pass => pass.kind === 'ford');
  const origin = { x: ford.x - 13, z: ford.z }, target = { x: ford.x + 13, z: ford.z };
  const route = findPath(state, origin, target, { arrival: .1 });
  assert.ok(route.reachable);
  const speed = 2.65, workCycles = 14;
  const budget = estimateJourneyCycles(state, origin, route, speed, workCycles);
  const party = { ...origin, kind: 'worker', size: 8, speed };
  let outboundTime = null;
  for (let pulse = 0; pulse < 3000; pulse++) {
    state.step++; state.time = state.step / 10; state.tick = Math.floor(state.time);
    if (moveAlongRoute(state, party, outboundTime == null ? target : origin, { speed, dt: .1, arrival: .1 })) {
      if (outboundTime == null) outboundTime = state.time; else break;
    }
  }
  assert.ok(Math.hypot(party.x - origin.x, party.z - origin.z) <= .1);
  assert.ok(budget >= state.time + workCycles, `${budget} prepaid cycles cannot cover ${state.time} travel + ${workCycles} work`);
  assert.equal(estimateJourneyCycles(state, origin, { reachable: false, waypoints: [] }, speed), null);
});

test('home scarcity records an explicit death cause without duplicating total mortality', async () => {
  const { createSimulation, stepSimulation } = await import('../src/sim/core.js');
  const state = createSimulation('production-scarcity-cause');
  state.nodes = [];
  for (const home of state.settlements) {
    home.buildings = home.buildings.filter(building => !['farm', 'power'].includes(building.kind));
    for (const kind of RESOURCES) home.stock[kind] = 0;
  }
  initializeLedger(state);
  const initial = state.settlements.reduce((sum, home) => sum + home.population, 0);
  stepSimulation(state, 350);
  assert.ok(state.stats.homeScarcityDeaths > 0);
  assert.equal(state.stats.deaths, state.stats.homeScarcityDeaths);
  assert.equal(state.settlements.reduce((sum, home) => sum + home.population, 0), initial - state.stats.homeScarcityDeaths);
  assertConserved(state);
});

test('seeded capability profiles are distinct, reproducible and independent of species', async () => {
  const { initializeFactionAdvantages, FACTION_ADVANTAGE_PROFILES } = await import('../src/sim/economy.js');
  const make = () => ({ seed: 'advantage-replay', rng: 123, factions: Array.from({ length: 6 }, (_, index) => ({ id: `f${index}`, species: 'human' })) });
  const a = make(), b = make();
  a.factions.forEach((faction, index) => initializeFactionAdvantages(a, faction, index));
  b.factions.forEach((faction, index) => { faction.species = index % 2 ? 'machine' : 'hive'; initializeFactionAdvantages(b, faction, index); });
  assert.deepEqual(a.factions.map(f => f.advantages), b.factions.map(f => f.advantages));
  assert.equal(new Set(a.factions.map(f => f.advantages.id)).size, 6);
  assert.equal(a.rng, 123, 'capability selection consumed the simulation random stream');
  assert.ok(FACTION_ADVANTAGE_PROFILES.every(profile => profile.strength && profile.tradeoff && profile.gathering >= 1 && profile.gathering <= 2));
});

test('military capabilities change paid course time and real weapon reach without adding people', async () => {
  const { FACTION_ADVANTAGE_PROFILES } = await import('../src/sim/economy.js');
  const { state, home, faction, spec } = fixture('human', 'ranged');
  faction.advantages = { ...FACTION_ADVANTAGE_PROFILES.find(profile => profile.id === 'longwatch') };
  const effective = unitStats(faction, 'ranged');
  assert.equal(effective.range, spec.range * 1.28);
  assert.equal(effective.damage, spec.damage * 1.16);
  assert.equal(effective.trainingCycles, Math.ceil(spec.trainingCycles / .82));
  assert.ok(trainingCost(faction, 'ranged', 3).materials > spec.cost.materials * 3);
  const population = home.population;
  const course = queueTraining(state, home, faction, 'ranged', 3);
  assert.equal(course.duration, effective.trainingCycles);
  assert.equal(home.population, population);
  assertConserved(state);
});

test('a gathering advantage removes proportionally more real deposit into cargo, with no remote storage credit', async () => {
  const { createSimulation, stepSimulation } = await import('../src/sim/core.js');
  const a = createSimulation('production-gathering-bonus');
  const home = a.settlements[0], faction = a.factions[0], node = a.nodes.find(n => n.kind === 'materials');
  faction.advantages.gathering = 1;
  a.groups = [{ id: 'gathering-fixture', factionId: faction.id, originId: home.id, kind: 'worker', phase: 'working', size: 10,
    x: node.x, z: node.z, targetId: node.id, targetX: node.x, targetZ: node.z, speed: 2.65, supply: 100, provisionCycles: 100, createdTick: 0,
    carrying: { food: 0, water: 0, energy: 0, materials: 0 }, capacity: 100, cargoCapacity: 100, extractedTotal: 0, workTime: 0, resourceKind: 'materials', observations: [] }];
  initializeLedger(a);
  const b = structuredClone(a); b.factions[0].advantages.gathering = 1.65;
  const stock = home.stock.materials;
  stepSimulation(a, 1); stepSimulation(b, 1);
  assert.ok(Math.abs(b.groups[0].extractedTotal - a.groups[0].extractedTotal * 1.65) < 1e-9);
  assert.equal(a.settlements[0].stock.materials, stock);
  assert.equal(b.settlements[0].stock.materials, stock);
  assertConserved(a); assertConserved(b);
});

test('occupied producers cancel paid courses and cannot recruit for an eliminated controller', () => {
  const { state, home, faction } = fixture();
  assert.ok(queueTraining(state, home, faction, 'infantry', 4));
  home.occupiedBy = 'victor';
  atTick(state, 20);
  assert.equal(advanceTraining(state, home, faction), 0);
  assert.equal(home.trainingQueue.length, 0);
  assert.equal(queueTraining(state, home, faction, 'infantry', 4), null);
  assert.equal(militaryBuildingPlan(state, home, faction), null);
  assert.equal(home.population, 100);
  assertConserved(state);
});

test('resource claims arise from physical harvesting and paper ownership alone never blocks contested extraction', async () => {
  const { createSimulation, stepSimulation } = await import('../src/sim/core.js');
  const state = createSimulation('production-resource-claims'), home = state.settlements[0], rival = state.settlements[1];
  const node = state.nodes.slice().sort((a, b) => Math.hypot(a.x - home.x, a.z - home.z) - Math.hypot(b.x - home.x, b.z - home.z))[0];
  const worker = { id: 'claim-worker', factionId: home.factionId, originId: home.id, kind: 'worker', phase: 'working', size: 8,
    x: node.x, z: node.z, targetId: node.id, targetX: node.x, targetZ: node.z, speed: 2.65, supply: 100, provisionCycles: 100, createdTick: 0,
    carrying: { food: 0, water: 0, energy: 0, materials: 0 }, capacity: 100, cargoCapacity: 100, extractedTotal: 0, workTime: 0, resourceKind: node.kind, observations: [] };
  state.groups = [worker]; initializeLedger(state);
  const unclaimed = structuredClone(state);
  stepSimulation(unclaimed, 1);
  const claimed = unclaimed.nodes.find(candidate => candidate.id === node.id);
  assert.equal(claimed.claimedBy, home.factionId);
  assert.equal(claimed.claimSettlementId, home.id);
  node.claimedBy = rival.factionId; node.claimSettlementId = rival.id;
  stepSimulation(state, 1);
  assert.ok(worker.extractedTotal > 0, 'an unsupported paper claim prevented physical gathering');
  assert.equal(node.claimedBy, rival.factionId, 'unarmed rival workers erased an existing claim');
  assertConserved(state); assertConserved(unclaimed);
});

test('a physically visible armed rival secures a worksite and civilians bring their report home', async () => {
  const { createSimulation, stepSimulation } = await import('../src/sim/core.js');
  const state = createSimulation('production-guarded-resource'), home = state.settlements[0], rival = state.settlements[1];
  const node = state.nodes.slice().sort((a, b) => Math.hypot(a.x - home.x, a.z - home.z) - Math.hypot(b.x - home.x, b.z - home.z))[0];
  const worker = { id: 'guarded-worker', factionId: home.factionId, originId: home.id, kind: 'worker', phase: 'working', size: 8,
    x: node.x, z: node.z, targetId: node.id, targetX: node.x, targetZ: node.z, speed: 2.65, supply: 100, provisionCycles: 100, createdTick: 0,
    carrying: { food: 0, water: 0, energy: 0, materials: 0 }, capacity: 100, cargoCapacity: 100, extractedTotal: 0, workTime: 0, resourceKind: node.kind, observations: [] };
  const army = { id: 'claim-guard', factionId: rival.factionId, originId: rival.id, kind: 'army', size: 6, initialSize: 6, units: { infantry: 6, ranged: 0 },
    x: node.x + .5, z: node.z, targetX: rival.x, targetZ: rival.z, targetId: rival.id, phase: 'returning', speed: 2.8, supply: 100, morale: 90,
    carrying: { food: 0, water: 0, energy: 0, materials: 0 }, observations: [], createdTick: 0 };
  state.groups = [worker, army]; initializeLedger(state);
  stepSimulation(state, 1);
  assert.equal(worker.phase, 'returning');
  assert.equal(worker.extractedTotal, 0);
  assert.equal(node.claimedBy, rival.factionId);
  assert.equal(worker.resourceDispute.controllerId, rival.factionId);
  assert.ok(worker.observations.some(observation => observation.id === node.id), 'local claim observation was not carried home');
  assert.equal(state.stats.resourceDisputes, 1);
  assertConserved(state);
});

test('conquest changes physical resource control and command reporting while preserving civilian species and stocks', async () => {
  const { createSimulation, stepSimulation } = await import('../src/sim/core.js');
  const { occupySettlement } = await import('../src/sim/conquest.js');
  const state = createSimulation('production-conquest-claims'), home = state.settlements[0], victorHome = state.settlements[1];
  const native = state.factions[0], victor = state.factions[1], nativeSpecies = native.species, node = state.nodes[0];
  node.claimedBy = native.id; node.claimSettlementId = home.id; node.claimedTick = 0;
  const units = allocateMilitary(state, victorHome, 6);
  const army = { id: 'occupation-fixture', factionId: victor.id, originId: victorHome.id, kind: 'army', size: countMilitary(units), initialSize: countMilitary(units), units,
    x: home.x, z: home.z, targetX: victorHome.x, targetZ: victorHome.z, targetId: victorHome.id, phase: 'returning', speed: 2.8, supply: 100, morale: 90,
    carrying: { food: 0, water: 0, energy: 0, materials: 0 }, observations: [], createdTick: 0 };
  state.groups = [army]; initializeLedger(state);
  const census = state.settlements.reduce((sum, town) => sum + town.population, 0), stores = { ...home.stock }, remoteStores = { ...victorHome.stock };
  assert.equal(occupySettlement(state, home, army), true);
  assert.equal(home.factionId, native.id);
  assert.equal(native.species, nativeSpecies);
  assert.equal(state.settlements.reduce((sum, town) => sum + town.population, 0), census);
  assert.deepEqual(home.stock, stores);
  assert.deepEqual(victorHome.stock, remoteStores);
  stepSimulation(state, 10);
  assert.equal(node.claimedBy, victor.id);
  assert.equal(home.occupiedBy, victor.id);
  assert.equal(native.status, 'capitulated');
  assert.equal(victor.knowledge[home.id].ownerId, victor.id);
  assert.equal(victor.knowledge[home.id].nativeFactionId, native.id);
  assert.equal(native.knowledge[home.id].reportedTick, 0, 'occupied home remotely refreshed its former commander');
  assert.equal(home.assigned.researchers, 0);
  assert.equal(home.trainingQueue.length, 0);
  assert.ok(victor.economy.controlledPopulation >= victorHome.population + home.population);
  assertConserved(state);
});

function exileFixture() {
  const result = fixture('hive', 'infantry'), { state, home, faction } = result;
  const commander = { id: 'f1', name: 'Exiled humans', species: 'human', traits: { aggression: .7 }, modifiers: {}, advantages: { trainingRate: 1.55, unitCost: 1.05 }, knowledge: {}, history: [] };
  const nativeHome = { ...structuredClone(home), id: 's1', factionId: commander.id, name: 'Lost human capital', population: 80, occupiedBy: faction.id,
    buildings: [{ id: 'human-producer', kind: 'barracks', x: 10, z: 0, progress: 1, hp: 160, maxHp: 160 }], x: 10 };
  initializeMilitary(home, { infantry: 0, ranged: 0 }); initializeMilitary(nativeHome, { infantry: 0, ranged: 0 });
  home.occupiedBy = commander.id;
  state.factions.push(commander); state.settlements.push(nativeHome);
  initializeLedger(state);
  return { ...result, commander, nativeHome };
}

test('one exiled sovereign base recruits paid native auxiliaries without converting species or population', async () => {
  const { refreshExileBases, commandFactionForHome, militaryContext } = await import('../src/sim/military.js');
  const { state, home, faction, commander } = exileFixture();
  refreshExileBases(state);
  assert.equal(home.exileBaseFor, commander.id);
  assert.equal(commandFactionForHome(state, home), commander.id);
  assert.equal(militaryContext(state, home).species, 'hive');
  const before = { population: home.population, food: home.stock.food, materials: home.stock.materials };
  const job = queueTraining(state, home, faction, 'infantry', 4);
  assert.ok(job);
  assert.equal(job.commandFactionId, commander.id);
  assert.equal(job.nativeFactionId, faction.id);
  assert.equal(job.buildingId, 'b0');
  assert.equal(job.duration, Math.ceil(unitStats('hive', 'infantry').trainingCycles / 1.55));
  assert.ok(Math.abs(job.cost.food - unitStats('hive', 'infantry').cost.food * 4 * 1.05) < 1e-8);
  assert.ok(home.stock.food < before.food && home.stock.materials < before.materials);
  atTick(state, job.startedTick + job.duration);
  assert.equal(advanceTraining(state, home, faction), 4);
  assert.equal(home.population, before.population);
  assert.equal(home.factionId, faction.id);
  assert.equal(faction.species, 'hive');
  assert.deepEqual(home.military, { infantry: 4, ranged: 0 });
  assert.equal(home.trainingQueue.length, 0);
  assertConserved(state);
});

test('exile permission is limited to one held base and ends when a native capital is restored', async () => {
  const { refreshExileBases, commandFactionForHome } = await import('../src/sim/military.js');
  const { state, home, faction, commander, nativeHome } = exileFixture();
  const second = { ...structuredClone(home), id: 's2', population: 70, buildings: [{ ...home.buildings[0], id: 'second-producer' }] };
  state.settlements.push(second); initializeLedger(state);
  refreshExileBases(state);
  assert.equal(state.settlements.filter(town => town.exileBaseFor === commander.id).length, 1);
  assert.equal(commandFactionForHome(state, second), null);
  assert.equal(queueTraining(state, second, faction, 'infantry', 4), null);
  const job = queueTraining(state, home, faction, 'infantry', 4); assert.ok(job);
  nativeHome.occupiedBy = null;
  refreshExileBases(state);
  assert.equal(home.exileBaseFor, null);
  atTick(state, 50);
  assert.equal(advanceTraining(state, home, faction), 0);
  assert.equal(home.trainingQueue.length, 0);
  assert.equal(home.soldiers, 0);
  assert.equal(commandFactionForHome(state, nativeHome), commander.id);
  assertConserved(state);
});

test('exile training locks political command and cancels rather than delivering recruits to a new occupier', async () => {
  const { state, home, faction, commander } = exileFixture();
  const job = queueTraining(state, home, faction, 'infantry', 4); assert.ok(job);
  const third = { ...structuredClone(commander), id: 'f2', name: 'New occupier' }; state.factions.push(third);
  home.occupiedBy = third.id;
  atTick(state, 80);
  assert.equal(advanceTraining(state, home, faction), 0);
  assert.equal(home.soldiers, 0);
  assert.equal(home.population, 100);
  assert.equal(state.stats.trainingCancelled, 4);
  assert.equal(home.trainingQueue.length, 0);
  assertConserved(state);
});

test('defeated native identity remains inactive while its actual citizens can serve a surviving exile controller', async () => {
  const { state, home, faction, commander, nativeHome } = exileFixture();
  const third = { ...structuredClone(commander), id: 'f2', name: 'Other sovereign' }; state.factions.push(third);
  nativeHome.occupiedBy = third.id; faction.defeatedBy = commander.id; faction.status = 'capitulated';
  const job = queueTraining(state, home, faction, 'infantry', 3);
  assert.ok(job); assert.equal(job.commandFactionId, commander.id);
  atTick(state, 40); advanceTraining(state, home, faction);
  assert.equal(faction.status, 'capitulated'); assert.equal(faction.defeatedBy, commander.id);
  assert.equal(home.factionId, faction.id); assert.equal(home.military.infantry, 3);
  assertConserved(state);
});
