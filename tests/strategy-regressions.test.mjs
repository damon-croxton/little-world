import test from 'node:test';
import assert from 'node:assert/strict';
import { createSimulation } from '../src/sim/core.js';
import { stepStrategy } from '../src/sim/strategy.js';
import { initializeMilitary, deployMilitary, getSoldiers } from '../src/sim/military.js';
import { stepCombat } from '../src/sim/combat.js';
import { stepProgression } from '../src/sim/progression.js';
import { emptyResources, initializeLedger, ledgerResidual, RESOURCES } from '../src/sim/economy.js';

function fixture(seed, tick = 20) {
  const state = createSimulation(seed);
  state.tick = tick;
  state.step = tick * 10;
  state.time = tick;
  for (const faction of state.factions) {
    faction.lastScout = tick;
    faction.lastArmy = tick;
    faction.lastProposal = tick;
  }
  return state;
}

// These explicit fixtures alter census deliberately before the ledger baseline.
// They are tests only, never used to inflate browser or natural-run evidence.
function finalizeFixture(state) {
  const armies = state.groups.filter(party => party.kind === 'army' && !party.finished).map(party => ({ party, size: party.size }));
  for (const home of state.settlements) initializeMilitary(home, { infantry: home.soldiers, ranged: 0 }, { state });
  for (const { party, size } of armies) {
    party.size = size; party.units = { infantry: size, ranged: 0 }; delete party.soldierIds;
    deployMilitary(state, state.settlements.find(home => home.id === party.originId), party);
    placeSoldiers(state, party);
  }
  initializeLedger(state);
}

function placeSoldiers(state, party, point = party) {
  const soldiers = getSoldiers(state, party), columns = Math.ceil(Math.sqrt(soldiers.length)), rows = Math.ceil(soldiers.length / columns);
  for (const [i, soldier] of soldiers.entries()) {
    soldier.positioned = true;
    soldier.x = soldier.prevX = point.x + (i % columns - (columns - 1) / 2) * .7;
    soldier.z = soldier.prevZ = point.z + (Math.floor(i / columns) - (rows - 1) / 2) * .7;
  }
}
function strategyPulse(state, dt = .1) {
  state.step++; state.tick = Math.floor(state.step / 10); state.time = state.step / 10;
  for (const faction of state.factions) { faction.lastScout = state.tick; faction.lastArmy = state.tick; }
  stepStrategy(state, dt);
}

function hostile(a, b) {
  a.relations[b.id] = { status: 'hostile', trust: 0, lastTrade: 0 };
  b.relations[a.id] = { status: 'hostile', trust: 0, lastTrade: 0 };
}

function group(id, faction, home, kind, size, position = home, cargo = {}) {
  return {
    id, kind, size, initialSize: size, factionId: faction.id, originId: home.id,
    x: position.x, z: position.z, prevX: position.x, prevZ: position.z,
    targetX: position.x + 20, targetZ: position.z, targetId: null,
    phase: 'outbound', speed: 0, supply: 100, morale: 90, createdTick: 20,
    carrying: { ...emptyResources(), ...cargo }, observations: [],
  };
}

const cargoTotal = g => RESOURCES.reduce((sum, kind) => sum + (g.carrying[kind] || 0), 0);
const population = state => state.settlements.reduce((sum, home) => sum + home.population, 0);

function assertConserved(state) {
  for (const [kind, residual] of Object.entries(ledgerResidual(state))) {
    assert.ok(Math.abs(residual) < 1e-6, `${kind} conservation residual ${residual}`);
  }
}

test('destroyed and retreating armies cannot initiate attacks or intercept caravans', () => {
  for (const destroyed of [true, false]) {
    const state = fixture(`regression-terminal-army-${destroyed}`);
    const [a, b] = state.factions, [ha, hb] = state.settlements;
    hostile(a, b);
    ha.soldiers = destroyed ? 0 : 10;
    hb.population = 240; hb.soldiers = 200;
    const army = group('test-army-a', a, ha, 'army', ha.soldiers, ha);
    army.phase = destroyed ? 'engaging' : 'retreating'; army.finished = destroyed;
    const caravan = group('test-caravan', b, hb, 'trader', 8, ha, { food: 100 });
    state.groups = [army, group('test-army-b', b, hb, 'army', 100, ha), group('test-army-c', b, hb, 'army', 100, ha), caravan];
    finalizeFixture(state);
    const initialPopulation = population(state);
    strategyPulse(state);
    assert.ok(!state.events.some(event => event.type === 'battle' && event.groupId === army.id), 'a terminal army started a battle');
    assert.equal(caravan.phase, 'outbound', 'a terminal army turned a caravan back');
    assert.equal(caravan.carrying.food, 100);
    assert.ok(!(state.pendingCombat || []).some(hit => hit.sourceId === army.id));
    assert.equal(population(state), initialPopulation - state.stats.deaths);
    assertConserved(state);
  }
});

test('intercepting several caravans respects cargo already carried by the army', () => {
  const state = fixture('regression-interception-capacity');
  const [a, b] = state.factions, [ha, hb] = state.settlements;
  hostile(a, b);
  ha.population = 150;
  ha.soldiers = 50;
  const army = group('test-army', a, ha, 'army', 50, ha, { food: 20 });
  const caravans = [1, 2].map(i => group(`test-caravan-${i}`, b, hb, 'trader', 8, ha, { food: 100 }));
  state.groups = [army, ...caravans];
  finalizeFixture(state);
  stepStrategy(state, 0);
  assert.equal(cargoTotal(army), army.size * 1.2);
  assert.equal(caravans.reduce((sum, g) => sum + cargoTotal(g), 0), 160);
  assertConserved(state);
});

test('delayed battle casualties remove proportional cargo without inventing deaths or losing inventory', () => {
  const state = fixture('regression-casualty-cargo');
  const [a, b] = state.factions, [ha, hb] = state.settlements;
  hostile(a, b);
  ha.population = 160; ha.soldiers = 50;
  hb.population = 160; hb.soldiers = 80;
  const army = group('test-army-a', a, ha, 'army', 50, ha, { food: 60 });
  state.groups = [army, group('test-army-b', b, hb, 'army', 80, ha)];
  const initialPopulation = population(state); finalizeFixture(state);
  stepCombat(state, 0);
  assert.equal(army.size, 50, 'zero elapsed time caused casualties');
  for (let pulse = 0; pulse < 400 && army.size === 50; pulse++) strategyPulse(state);
  assert.ok(army.size > 0 && army.size < 50, 'actual strikes never caused casualties');
  assert.ok(Math.abs(army.carrying.food - 60 * army.size / 50) < 1e-8);
  assert.ok(Math.abs(state.resourceLedger.food.lost - (60 - army.carrying.food)) < 1e-8);
  assert.equal(population(state), initialPopulation - state.stats.deaths);
  for (const home of [ha, hb]) assert.ok(home.soldiers >= 0 && home.soldiers <= home.population);
  assertConserved(state);
});

function raidFixture(seed, civiliansAway = 0, carried = 0) {
  const state = fixture(seed);
  const [a, b] = state.factions, [ha, hb] = state.settlements;
  hostile(a, b);
  ha.population = 150;
  ha.soldiers = 40;
  hb.population = 200;
  hb.soldiers = 0;
  for (const kind of RESOURCES) hb.stock[kind] = 500;
  const army = group('test-raider', a, ha, 'army', 40, hb, { materials: carried });
  army.targetId = hb.id;
  army.phase = 'engaging';
  state.groups = [army];
  for (let remaining = civiliansAway, index = 0; remaining > 0; index++) {
    const size = Math.min(20, remaining);
    state.groups.push(group(`test-away-worker-${index}`, b, hb, 'worker', size, ha));
    remaining -= size;
  }
  finalizeFixture(state);
  return { state, army, target: hb };
}

test('home militia strength excludes civilians physically away with field parties', () => {
  const defended = raidFixture('regression-physical-militia', 0);
  const evacuated = raidFixture('regression-physical-militia', 180);
  stepStrategy(defended.state, .1);
  stepStrategy(evacuated.state, .1);
  const defense = state => state.events.find(e => e.type === 'battle' && e.groupId === 'test-raider').defenderPower;
  assert.ok(defense(evacuated.state) > 0);
  assert.ok(defense(evacuated.state) < defense(defended.state) * .15, 'absent civilians still defend their home');
  assertConserved(defended.state);
  assertConserved(evacuated.state);
});

test('a settlement raid shares the same carrying limit as prior intercepted cargo', () => {
  const { state, army } = raidFixture('regression-raid-capacity', 0, 40);
  army.engagedDays = 4;
  stepStrategy(state, .1);
  assert.equal(state.stats.raids, 1);
  assert.equal(army.phase, 'returning');
  assert.ok(cargoTotal(army) <= army.size * 1.2 + 1e-8);
  assertConserved(state);
});

test('damage to an undefended settlement does not bank whole casualties for a future garrison', () => {
  const { state, target } = raidFixture('regression-defender-damage-backlog');
  stepStrategy(state, .1);
  assert.equal(target.soldiers, 0);
  assert.ok((target.combat?.wounds?.infantry || 0) < 1 && (target.combat?.wounds?.ranged || 0) < 1, 'undefended settlement banked damage against future recruits');
  assertConserved(state);
});

test('an existing settlement contact cannot apply raid pressure or loot with zero elapsed time', () => {
  const { state, target, army } = raidFixture('regression-paused-raid', 0, 40);
  army.engagedDays = 4;
  army.combat = { active: true, targetKind: 'settlement', targetId: target.id, holding: true };
  const stock = { ...target.stock }, health = target.health, cargo = { ...army.carrying }, raids = state.stats.raids;
  stepStrategy(state, 0);
  assert.equal(target.health, health); assert.deepEqual(target.stock, stock); assert.deepEqual(army.carrying, cargo);
  assert.equal(army.engagedDays, 4); assert.equal(state.stats.raids, raids);
  assert.equal((state.pendingCombat || []).length, 0);
  assertConserved(state);
});

test('scouts, researchers, and two due exchanges cannot reserve the same civilians', () => {
  const state = fixture('regression-civilian-reservations', 24);
  delete state.config.diplomacy; // Legacy barter still conserves real civilians.
  const [a, b, c] = state.factions, [ha, hb, hc] = state.settlements;
  a.lastScout = 0;
  for (const home of state.settlements) for (const kind of RESOURCES) home.stock[kind] = 1000;
  Object.assign(ha, { population: 100, soldiers: 10, workers: 90, availableWorkers: 24,
    assigned: { workers: 58, scouts: 0, traders: 0, colonists: 0, military: 0, civilianAway: 58, researchers: 0, construction: 0, infrastructure: 8 } });
  state.groups = [20, 20, 18].map((size, i) => group(`test-worker-${i}`, a, ha, 'worker', size));
  for (const faction of [b, c]) {
    a.relations[faction.id] = { status: 'neutral', trust: 60, lastTrade: 0 };
    faction.relations[a.id] = { status: 'neutral', trust: 60, lastTrade: 0 };
  }
  state.tradeOffers = [hb, hc].map((home, i) => ({ id: `test-offer-${i}`, factionId: a.id, partnerId: home.factionId,
    originId: ha.id, targetId: home.id, exportKind: 'food', importKind: 'materials', amount: 160, dueTick: 24, createdTick: 0 }));
  ha.stock.food -= 320;
  finalizeFixture(state);
  stepStrategy(state, 0);
  const scout = state.groups.find(g => g.kind === 'scout' && g.originId === ha.id);
  assert.ok(scout);
  assert.equal(ha.availableWorkers, 24 - scout.size);
  stepProgression(state);
  const away = state.groups.filter(g => g.originId === ha.id && !g.finished).reduce((sum, g) => sum + g.size, 0);
  const committed = away + ha.soldiers + ha.assigned.infrastructure + a.researchWorkers + (ha.assigned.construction || 0);
  assert.ok(a.researchWorkers >= 6, 'fixture did not reserve researchers');
  assert.equal(ha.assigned.researchers, a.researchWorkers);
  assert.ok(committed <= ha.population, `${committed} commitments for ${ha.population} people`);
  assert.equal(committed + ha.availableWorkers, ha.population);
  assert.ok(state.tradeOffers.length >= 1, 'both crews departed despite insufficient unreserved labor');
  assertConserved(state);
});

function expeditionFixture(observedTick, reportedTick) {
  const state = fixture('regression-returned-intelligence', 400);
  const [a, b] = state.factions, [ha, hb] = state.settlements;
  hostile(a, b);
  a.lastArmy = 0;
  a.traits.aggression = .9;
  a.traits.cooperation = .1;
  Object.assign(ha, { population: 400, soldiers: 120, workers: 280, availableWorkers: 200 });
  for (const kind of RESOURCES) ha.stock[kind] = 500;
  a.knowledge = { [hb.id]: { id: hb.id, kind: 'settlement', ownerId: b.id, x: ha.x + 10, z: ha.z,
    observedTick, reportedTick, confidence: .9, status: 'active', populationEstimate: 100, soldiersEstimate: 20, healthEstimate: 100 } };
  finalizeFixture(state);
  return { state, faction: a, home: ha, target: hb };
}

test('stale or undelivered foreign intelligence cannot mobilize an expedition', () => {
  for (const [observedTick, reportedTick] of [[169, 395], [390, null], [390, 401]]) {
    const { state, faction } = expeditionFixture(observedTick, reportedTick);
    stepStrategy(state, 0);
    assert.ok(!state.groups.some(g => g.kind === 'army' && g.factionId === faction.id), `mobilized from report ${observedTick}/${reportedTick}`);
    assert.ok(!state.events.some(e => e.type === 'mobilize' && e.factionId === faction.id));
    assertConserved(state);
  }
});

test('an eligible expedition mobilizes from a genuinely prior returned report and pays provisions', () => {
  const { state, faction, home, target } = expeditionFixture(390, 395);
  const stock = { ...home.stock };
  stepStrategy(state, 0);
  const army = state.groups.find(g => g.kind === 'army' && g.factionId === faction.id);
  assert.ok(army, 'a fresh, returned, affordable hostile report did not mobilize');
  assert.equal(army.targetId, target.id);
  assert.equal(army.intelligence.observedTick, 390);
  assert.equal(army.intelligence.reportedTick, 395);
  assert.ok(army.intelligence.reportedTick < army.createdTick);
  assert.ok(army.size <= home.soldiers);
  assert.ok(home.stock.food < stock.food && home.stock.water < stock.water);
  const event = state.events.find(e => e.type === 'mobilize' && e.groupId === army.id);
  assert.equal(event.reportTick, 395);
  assert.equal(event.observationTick, 390);
  assertConserved(state);
});

test('observations carried by a travelling scout reach faction knowledge only after physical return', () => {
  const { state, faction, home, target } = expeditionFixture(390, null);
  const observation = { ...faction.knowledge[target.id] };
  faction.knowledge = {};
  const scout = group('test-report-courier', faction, home, 'scout', 4, { x: home.x + 20, z: home.z });
  Object.assign(scout, { phase: 'returning', targetX: home.x, targetZ: home.z, createdTick: 390,
    observations: [observation] });
  state.groups = [scout];
  finalizeFixture(state);
  stepStrategy(state, 0);
  assert.equal(faction.knowledge[target.id], undefined);
  assert.ok(!state.groups.some(g => g.kind === 'army' && g.factionId === faction.id));
  assert.equal(state.stats.reports, 0);

  // A second state transition brings the same courier physically home. A
  // cooldown holds mobilisation until a later cycle, separating the events.
  state.tick = 401;
  state.step = 4010;
  state.time = 401;
  faction.lastArmy = 401;
  scout.x = home.x;
  scout.z = home.z;
  stepStrategy(state, 0);
  assert.ok(!state.groups.includes(scout));
  assert.equal(faction.knowledge[target.id].observedTick, 390);
  assert.equal(faction.knowledge[target.id].reportedTick, 401);
  assert.equal(state.stats.reports, 1);

  state.tick = 402;
  state.step = 4020;
  state.time = 402;
  faction.lastArmy = 0;
  stepStrategy(state, 0);
  const army = state.groups.find(g => g.kind === 'army' && g.factionId === faction.id);
  assert.ok(army, 'the returned courier report never enabled mobilisation');
  assert.equal(army.intelligence.reportedTick, 401);
  assert.equal(army.createdTick, 402);
  assertConserved(state);
});

function strandedFixture(kind, supply = 100) {
  const state = fixture(`regression-stranded-${kind}`, 600);
  const [faction] = state.factions, [home, foreignHome] = state.settlements;
  faction.knowledge = {};
  home.population = 150;
  home.soldiers = kind === 'army' ? 40 : 10;
  const position = { x: home.x * .55, z: home.z * .55 };
  assert.ok(Math.hypot(position.x - home.x, position.z - home.z) > 10);
  const party = group(`test-stranded-${kind}`, faction, home, kind, kind === 'army' ? 40 : kind === 'scout' ? 4 : 8,
    position, { food: 12, materials: 6 });
  Object.assign(party, { phase: 'returning', targetX: home.x, targetZ: home.z, createdTick: 0, supply,
    observations: [{ id: foreignHome.id, kind: 'settlement', ownerId: foreignHome.factionId,
      x: foreignHome.x, z: foreignHome.z, observedTick: 100, reportedTick: null, confidence: .8,
      populationEstimate: 100, soldiersEstimate: 20, status: 'active' }] });
  if (kind === 'trader') party.provisionCycles = 120;
  state.groups = [party];
  finalizeFixture(state);
  return { state, faction, home, foreignHome, party, position };
}

function advanceStrandedCycle(state) {
  state.tick++;
  state.step = state.tick * 10;
  state.time = state.tick;
  // Isolate the stranded party from unrelated automatic dispatches.
  for (const faction of state.factions) {
    faction.lastScout = state.tick;
    faction.lastArmy = state.tick;
  }
  stepStrategy(state, 0);
}

test('a strategic party stranded beyond 480 cycles cannot remotely return cargo or intelligence', () => {
  for (const kind of ['army', 'scout', 'trader']) {
    const { state, faction, home, foreignHome, party, position } = strandedFixture(kind);
    const initialStock = { ...home.stock }, initialPopulation = population(state);
    for (let cycle = 0; cycle < 3; cycle++) {
      advanceStrandedCycle(state);
      assert.ok(state.groups.includes(party), `${kind} disappeared alive after a timeout`);
      assert.ok(party.size > 0 && !party.finished, `${kind} finished without physically returning`);
      assert.equal(party.x, position.x);
      assert.equal(party.z, position.z);
      assert.deepEqual(home.stock, initialStock, `${kind} delivered remote cargo`);
      assert.equal(faction.knowledge[foreignHome.id], undefined, `${kind} delivered a remote observation`);
      assert.equal(state.stats.reports, 0);
      assert.equal(population(state), initialPopulation - state.stats.deaths);
      assertConserved(state);
    }
    assert.ok(!state.events.some(event => event.groupId === party.id && ['return', 'report'].includes(event.type)));
  }
});

test('an exhausted stranded caravan loses actual people and proportional cargo without a remote rescue', () => {
  const { state, faction, home, foreignHome, party, position } = strandedFixture('trader', 0);
  const initialSize = party.size, initialPopulation = population(state), initialHomePopulation = home.population;
  const initialStock = { ...home.stock }, initialCargo = { ...party.carrying }, initialSoldiers = home.soldiers;
  for (let cycle = 0; cycle < 256 && party.size === initialSize && !party.finished; cycle++) {
    advanceStrandedCycle(state);
    assert.equal(party.x, position.x);
    assert.equal(party.z, position.z);
    assert.deepEqual(home.stock, initialStock, 'stranded cargo appeared in home storage');
    assert.equal(faction.knowledge[foreignHome.id], undefined);
    assert.equal(state.stats.reports, 0);
    assertConserved(state);
  }
  const deaths = initialSize - party.size;
  assert.ok(deaths > 0, 'an exhausted caravan suffered no real attrition');
  assert.equal(state.stats.deaths, deaths);
  assert.equal(home.population, initialHomePopulation - deaths);
  assert.equal(population(state), initialPopulation - deaths);
  assert.equal(home.soldiers, initialSoldiers, 'civilian attrition removed stationed soldiers');
  for (const kind of RESOURCES) {
    const remaining = initialCargo[kind] * party.size / initialSize;
    assert.ok(Math.abs(party.carrying[kind] - remaining) < 1e-8, `${kind} cargo was not lost proportionally`);
    assert.ok(Math.abs(state.resourceLedger[kind].lost - (initialCargo[kind] - remaining)) < 1e-8);
  }
  if (party.size > 0) {
    assert.ok(state.groups.includes(party));
    assert.ok(!party.finished, 'surviving caravan members magically returned home');
  } else assert.ok(!state.groups.includes(party));
  assert.ok(!state.events.some(event => event.groupId === party.id && event.type === 'return'));
  assertConserved(state);
});
