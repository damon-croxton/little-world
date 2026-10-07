import test from 'node:test';
import assert from 'node:assert/strict';
import { createSimulation } from '../src/sim/core.js';
import { stepStrategy } from '../src/sim/strategy.js';
import { initializeMilitary, availableMilitary, countMilitary, applyMilitaryCasualties, deployMilitary, getSoldiers } from '../src/sim/military.js';
import { initializeLedger, ledgerResidual, RESOURCES } from '../src/sim/economy.js';
import { visibleToGroup } from '../src/sim/knowledge.js';

// Controlled command/ledger scenarios; these are not natural balance evidence.
function fixture() {
  const state = createSimulation('joined-screen', { civCount: 3 });
  Object.assign(state, { tick: 400, step: 4000, time: 400, groups: [], nodes: [], events: [] });
  for (const [i, home] of state.settlements.entries()) {
    Object.assign(home, { x: -100 + i * 55, z: -120, buildings: [], assigned: {}, population: 400, homePresent: 400, availableWorkers: 200 });
    initializeMilitary(home, { infantry: i ? 0 : 90, ranged: i ? 0 : 30 }, { state });
    for (const key of RESOURCES) home.stock[key] = 1000;
  }
  for (const faction of state.factions) {
    Object.assign(faction, { lastScout: 400, lastArmy: 400, knowledge: {} });
    for (const other of state.factions) if (other !== faction) faction.relations[other.id] = { status: 'hostile', trust: 0 };
  }
  const [faction] = state.factions, [home, target, other] = state.settlements;
  Object.assign(faction.traits, { aggression: .9, cooperation: .1 }); faction.lastArmy = 0;
  return { state, faction, home, target, other };
}
function report(faction, target, soldiers = 20) {
  faction.knowledge[target.id] = { id: target.id, kind: 'settlement', ownerId: target.factionId, x: target.x, z: target.z,
    observedTick: 390, reportedTick: 395, confidence: .9, status: 'active', populationEstimate: 100, soldiersEstimate: soldiers, healthEstimate: 100 };
}
function placeSoldiers(state, group, point = group) {
  const soldiers = getSoldiers(state, group), columns = Math.ceil(Math.sqrt(soldiers.length)), rows = Math.ceil(soldiers.length / columns);
  for (const [i, soldier] of soldiers.entries()) {
    soldier.positioned = true;
    soldier.x = soldier.prevX = point.x + (i % columns - (columns - 1) / 2) * .7;
    soldier.z = soldier.prevZ = point.z + (Math.floor(i / columns) - (rows - 1) / 2) * .7;
  }
}
function party(state, home, id, size, point = home, units = { infantry: size, ranged: 0 }) {
  const group = { id, factionId: home.factionId, originId: home.id, kind: 'army', size, initialSize: size, units,
    x: point.x, z: point.z, prevX: point.x, prevZ: point.z, targetX: point.x + 10, targetZ: point.z, phase: 'outbound',
    speed: 0, supply: 100, morale: 95, createdTick: 300, campaign: true, carrying: Object.fromEntries(RESOURCES.map(key => [key, 0])), observations: [] };
  deployMilitary(state, home, group); placeSoldiers(state, group);
  state.groups.push(group); return group;
}
function conserved(state) {
  for (const [key, residual] of Object.entries(ledgerResidual(state))) assert.ok(Math.abs(residual) < 1e-6, `${key}: ${residual}`);
  for (const home of state.settlements) {
    const deployed = state.groups.filter(g => g.kind === 'army' && !g.finished && g.originId === home.id);
    for (const role of ['infantry', 'ranged']) assert.ok(deployed.reduce((n, g) => n + g.units[role], 0) <= home.military[role]);
    assert.equal(home.population, home.soldiers + home.workers);
  }
}
const ownArmies = (state, faction) => state.groups.filter(g => g.kind === 'army' && g.factionId === faction.id);

test('campaign dispatch keeps a real home reserve and all staffed tower troops', () => {
  const { state, faction, home, target } = fixture(); report(faction, target);
  const roster = home.soldierRoster.slice(), identities = new Set(roster.map(soldier => soldier.id));
  home.assigned.towerCrew = 25; initializeLedger(state);
  stepStrategy(state, 0);
  const army = ownArmies(state, faction)[0]; assert.ok(army);
  assert.ok(countMilitary(availableMilitary(state, home)) >= Math.ceil(home.soldiers * .30));
  assert.ok(availableMilitary(state, home).ranged >= 25);
  assert.equal(army.size, countMilitary(army.units)); assert.ok(army.routeSupplyBudget > 18);
  assert.equal(army.soldierIds.length, army.size); assert.equal(new Set(army.soldierIds).size, army.size);
  assert.ok(army.soldierIds.every(id => identities.has(id)), 'dispatch invented a soldier');
  assert.deepEqual(home.soldierRoster, roster, 'dispatch replaced the original citizen records');
  assert.ok(getSoldiers(state, army).every(soldier => roster.includes(soldier)));
  conserved(state);
});

test('wounded home soldiers retain their reserve while another healthy home can fund the campaign', () => {
  const { state, faction, home, target, other } = fixture(); report(faction, target);
  for (const [index, soldier] of home.soldierRoster.entries()) {
    if (index % 2) soldier.hp = soldier.maxHp * (soldier.role === 'ranged' ? .38 : .30);
    else soldier.withdrawing = true;
    soldier.attackReadyAt = 407; soldier.cooldown = 1.4;
  }
  other.factionId = faction.id;
  initializeMilitary(other, { infantry: 90, ranged: 30 }, { state });
  const wounds = home.soldierRoster.map(soldier => ({ id: soldier.id, hp: soldier.hp, attackReadyAt: soldier.attackReadyAt, cooldown: soldier.cooldown }));
  const stock = { ...home.stock }; initializeLedger(state); stepStrategy(state, 0);
  const army = ownArmies(state, faction)[0]; assert.ok(army, 'an unready home prevented the other home from launching');
  assert.equal(army.originId, other.id); assert.equal(army.targetId, target.id);
  assert.equal(army.size, countMilitary(army.units)); assert.equal(faction.campaignOrders[army.id].size, army.size);
  assert.equal(home.defensePlan.reserve, 36); assert.equal(countMilitary(availableMilitary(state, home)), 120);
  assert.equal(home.population, 400); assert.equal(home.soldiers, 120); assert.deepEqual(home.stock, stock);
  assert.ok(home.soldierRoster.every(soldier => soldier.groupId == null && soldier.status === 'serving'));
  assert.deepEqual(home.soldierRoster.map(soldier => ({ id: soldier.id, hp: soldier.hp, attackReadyAt: soldier.attackReadyAt, cooldown: soldier.cooldown })), wounds);
  conserved(state);
});

test('wounded reserves cannot make an undersized expedition appear able to challenge a reported defender', () => {
  const { state, faction, home, target } = fixture(); report(faction, target, 80);
  for (const soldier of home.soldierRoster.slice(20)) soldier.withdrawing = true;
  const stock = { ...home.stock }; initializeLedger(state); stepStrategy(state, 0);
  assert.equal(ownArmies(state, faction).length, 0);
  assert.deepEqual(home.stock, stock); assert.equal(countMilitary(availableMilitary(state, home)), 120);
  assert.equal(home.defensePlan.reserve, 36); assert.deepEqual(faction.campaignOrders, {});
  conserved(state);
});

test('nearby achievable campaigns take priority over weaker cross-map targets', () => {
  const { state, faction, target, other } = fixture();
  report(faction, target, 55); report(faction, other, 1); initializeLedger(state);
  stepStrategy(state, 0);
  assert.equal(ownArmies(state, faction)[0]?.targetId, target.id);
  conserved(state);
});

test('locally observed attackers retain home troops and prevent a new foreign march', () => {
  const { state, faction, home, target } = fixture(); report(faction, target);
  initializeMilitary(target, { infantry: 80, ranged: 0 });
  const enemy = party(state, target, 'visible-attackers', 80, { x: home.x + 10, z: home.z });
  assert.ok(visibleToGroup(state, home, enemy)); initializeLedger(state);
  stepStrategy(state, 0);
  assert.equal(ownArmies(state, faction).length, 0);
  assert.equal(home.defensePlan.observedThreat, 80); assert.ok(home.defensePlan.reserve >= 80);
  conserved(state);
});

test('a locally reachable departing army physically returns to reinforce an outmatched home', () => {
  const { state, faction, home, target } = fixture(); report(faction, target);
  const army = party(state, home, 'departing', 60, { x: home.x + 5, z: home.z }); army.targetId = target.id;
  initializeMilitary(target, { infantry: 80, ranged: 0 });
  party(state, target, 'visible-attackers', 80, { x: home.x + 15, z: home.z }); initializeLedger(state);
  const available = countMilitary(availableMilitary(state, home));
  stepStrategy(state, 0);
  assert.equal(army.phase, 'returning'); assert.equal(army.targetX, home.x);
  assert.equal(countMilitary(availableMilitary(state, home)), available, 'recall teleported the soldiers home');
  assert.equal(state.stats.defenseRecalls, 1); conserved(state);
});

test('unseen threats and unreturned scout sightings cannot alter home reserves or campaign orders', () => {
  const { state, faction, home, target } = fixture(); report(faction, target);
  initializeMilitary(target, { infantry: 15, ranged: 0 });
  const hidden = party(state, target, 'unseen-army', 15, { x: target.x, z: target.z + 8 });
  state.groups.push({ id: 'unreturned-scout', factionId: faction.id, originId: home.id, kind: 'scout', size: 4,
    x: hidden.x - 2, z: hidden.z, targetX: hidden.x + 10, targetZ: hidden.z, speed: 0, phase: 'outbound', supply: 100, morale: 95, observations: [], carrying: {} });
  assert.ok(!visibleToGroup(state, home, hidden)); assert.ok(visibleToGroup(state, state.groups[1], hidden));
  const altered = structuredClone(state), hiddenOther = altered.groups[0];
  initializeMilitary(altered.settlements[1], { infantry: 150, ranged: 0 }, { state: altered });
  Object.assign(hiddenOther, { size: 150, initialSize: 150, units: { infantry: 150, ranged: 0 }, supply: 5, morale: 5 });
  delete hiddenOther.soldierIds;
  deployMilitary(altered, altered.settlements[1], hiddenOther); placeSoldiers(altered, hiddenOther);
  for (const s of [state, altered]) { initializeLedger(s); stepStrategy(s, 0); conserved(s); }
  const orders = s => { const { id, ...order } = ownArmies(s, s.factions[0])[0]; return order; };
  assert.deepEqual(orders(altered), orders(state)); assert.deepEqual(altered.settlements[0].defensePlan, home.defensePlan);
});

test('two simultaneous campaigns reserve distinct soldiers while civilian commitments and cargo stay unchanged', () => {
  const { state, faction, home, target, other } = fixture(); report(faction, target); report(faction, other);
  state.groups.push({ id: 'workers', kind: 'worker', factionId: faction.id, originId: home.id, size: 20, x: home.x, z: home.z,
    phase: 'working', carrying: { food: 25, water: 0, energy: 0, materials: 0 } });
  const civilianBefore = structuredClone(state.groups[0]), population = home.population; initializeLedger(state);
  stepStrategy(state, 0); faction.lastArmy = 0; stepStrategy(state, 0);
  const armies = ownArmies(state, faction);
  assert.equal(armies.length, 2); assert.equal(new Set(armies.map(g => g.targetId)).size, 2);
  assert.ok(countMilitary(availableMilitary(state, home)) >= home.defensePlan.reserve);
  assert.equal(home.population, population); assert.deepEqual(state.groups.find(g => g.id === 'workers'), civilianBefore);
  faction.lastArmy = 0; stepStrategy(state, 0); assert.equal(ownArmies(state, faction).length, 2, 'force cap was exceeded'); conserved(state);
});

test('a returned stronger-defender report can fund a separate reinforcement within the home reserve', () => {
  const { state, faction, home, target } = fixture();
  initializeMilitary(home, { infantry: 200, ranged: 0 }); report(faction, target, 100);
  const first = party(state, home, 'prior-expedition', 80, { x: home.x + 35, z: home.z }); first.targetId = target.id;
  initializeLedger(state); stepStrategy(state, 0);
  const reinforcement = ownArmies(state, faction).find(g => g !== first);
  assert.ok(reinforcement); assert.equal(reinforcement.targetId, target.id); assert.equal(reinforcement.reinforcement, true);
  assert.ok(countMilitary(availableMilitary(state, home)) >= home.defensePlan.reserve); conserved(state);
});

function captureFixture() {
  const data = fixture(), { state, faction, home, target, other } = data;
  Object.assign(target, { x: -60, health: 5, population: 100, homePresent: 100 }); target.workers = 100;
  Object.assign(other, { x: -20 }); report(faction, target, 0); report(faction, other, 10); faction.lastArmy = 400;
  const army = party(state, home, 'campaign', 40, target);
  Object.assign(army, { targetId: target.id, targetX: target.x, targetZ: target.z, phase: 'engaging', speed: 2.9,
    supply: 60, siegeMode: true, siegeDays: 5, engagedDays: 5, initialGarrison: 0 });
  target.siege = { groupId: army.id, active: true }; initializeLedger(state);
  return { ...data, army };
}

test('occupying an undefended settlement continues toward the next returned report with paid route supplies', () => {
  const { state, faction, target, other, army } = captureFixture(), stock = { ...target.stock };
  stepStrategy(state, .1);
  assert.equal(target.occupiedBy, faction.id); assert.equal(army.phase, 'outbound'); assert.equal(army.targetId, other.id);
  assert.ok(army.expectedTravelCycles > 0 && army.routeSupplyBudget > 18); assert.ok(army.supply >= 90);
  assert.ok(RESOURCES.some(key => target.stock[key] < stock[key])); assert.equal(state.stats.campaignLegs, 1); conserved(state);
});

test('an exhausted captured depot cannot sustain another campaign leg', () => {
  const { state, faction, target, army } = captureFixture();
  for (const key of RESOURCES) target.stock[key] = 0; initializeLedger(state);
  stepStrategy(state, .1);
  assert.equal(target.occupiedBy, faction.id); assert.equal(army.phase, 'returning');
  assert.ok(army.supply < 60); assert.equal(state.stats.campaignLegs || 0, 0); conserved(state);
});

function advance(state, cycles = .1) {
  state.step += Math.round(cycles * 10); state.time = state.step / 10; state.tick = Math.floor(state.time);
  for (const f of state.factions) { f.lastScout = state.tick; f.lastArmy = state.tick; }
  stepStrategy(state, cycles);
}

test('a supplied campaign kills an incidental defender, resumes its march, and occupies the undefended objective', () => {
  const { state, faction, home, target } = fixture(); faction.lastArmy = 400;
  Object.assign(target, { x: -40, population: 100, homePresent: 100 }); initializeMilitary(target, { infantry: 1, ranged: 0 });
  const army = party(state, home, 'sustained-campaign', 60, { x: -68, z: -120 }, { infantry: 40, ranged: 20 });
  Object.assign(army, { targetId: target.id, targetX: target.x, targetZ: target.z,
    missionTargetX: target.x, missionTargetZ: target.z, speed: 2.9, supply: 90, phase: 'engaging',
    combat: { active: true, targetKind: 'group', targetId: 'incidental-defender' } });
  const defender = party(state, target, 'incidental-defender', 1, { x: -66, z: -120 });
  // Start at the tail of an incidental skirmish: one named archer's previously
  // fired shot is arriving at the named wounded defender. Its real ledger
  // death must release the incidental target and preserve the campaign.
  const archer = getSoldiers(state, army).find(soldier => soldier.role === 'ranged'), wounded = getSoldiers(state, defender)[0];
  wounded.hp = 1;
  state.pendingCombat = [{ id: 'previous-shot', sourceId: army.id, sourceSoldierId: archer.id, targetId: defender.id, targetKind: 'group',
    targetSoldierId: wounded.id, factionId: faction.id, targetFactionId: defender.factionId, targetRole: 'infantry', damage: archer.stats.damage,
    projectile: true, rays: [{ from: { x: archer.x, z: archer.z, height: .6 }, to: { x: wounded.x, z: wounded.z, height: .45 }, targetSoldierId: wounded.id }],
    aim: { x: wounded.x, z: wounded.z }, impactTime: state.time + .1 }];
  initializeLedger(state); let resumedMarch = false, lostDefender = false;
  for (let pulse = 0; pulse < 500 && target.occupiedBy !== faction.id; pulse++) {
    advance(state);
    if (!defender.size || defender.finished) lostDefender = true;
    if (lostDefender && army.phase === 'outbound' && army.targetId === target.id) resumedMarch = true;
    if (target.occupiedBy !== faction.id) assert.ok(!['returning', 'retreating'].includes(army.phase), `campaign abandoned its live objective: ${army.reason}`);
  }
  assert.ok(lostDefender, 'fixture never killed its incidental defender'); assert.ok(resumedMarch, 'campaign never resumed its reported march');
  assert.equal(target.occupiedBy, faction.id); assert.ok(army.siegeDays >= 6); conserved(state);
});

test('a nearby supplied campaign continues below 45 percent while a depleted force preserves its real return reserve', () => {
  for (const supply of [40, 18]) {
    const { state, faction, home, target } = fixture(); faction.lastArmy = 400;
    const army = party(state, home, 'return-budget', 40, { x: home.x + 5, z: home.z });
    Object.assign(army, { targetId: target.id, targetX: target.x, targetZ: target.z, supply, speed: 2.9 }); initializeLedger(state);
    stepStrategy(state, 0);
    assert.ok(army.returnSupplyPlan.reserve < 40);
    assert.equal(army.phase, supply === 40 ? 'outbound' : 'retreating');
    if (supply === 18) assert.equal(army.targetX, home.x);
    conserved(state);
  }
});

test('remote withdrawal cannot silently release a campaign commitment and trigger another force', () => {
  const { state, faction, home, target } = fixture(); report(faction, target, 20);
  const army = party(state, home, 'remote-commitment', 50, { x: home.x + 40, z: home.z }); army.targetId = target.id;
  const retreating = structuredClone(state); retreating.groups[0].phase = 'retreating';
  for (const current of [state, retreating]) { initializeLedger(current); stepStrategy(current, 0); conserved(current); assert.equal(ownArmies(current, current.factions[0]).length, 1); }
  assert.deepEqual(retreating.settlements[0].stock, state.settlements[0].stock);
});

test('unreported remote casualties cannot reduce home reserves or enlarge a reinforcement', () => {
  const { state, faction, home, target } = fixture(); report(faction, target, 100);
  initializeMilitary(home, { infantry: 200, ranged: 0 });
  const army = party(state, home, 'remote-losses', 80, { x: home.x + 35, z: home.z }); army.targetId = target.id;
  assert.ok(!visibleToGroup(state, home, army)); initializeLedger(state);
  const casualties = structuredClone(state); applyMilitaryCasualties(casualties, casualties.settlements[0], casualties.groups[0], 20, { role: 'infantry' });
  for (const current of [state, casualties]) { stepStrategy(current, 0); conserved(current); }
  const order = current => { const { id, ...mission } = current.groups.find(g => g.id !== army.id && g.kind === 'army'); return mission; };
  assert.deepEqual(casualties.settlements[0].defensePlan, home.defensePlan);
  assert.deepEqual(order(casualties), order(state));
});

test('an entire unseen army loss and removal retain its departure commitment until the finite report deadline', () => {
  const { state, faction, home, target } = fixture(); report(faction, target, 20);
  const army = party(state, home, 'missing-army', 50, { x: home.x + 40, z: home.z }); army.targetId = target.id;
  faction.lastArmy = 400; initializeLedger(state); stepStrategy(state, 0);
  const missing = structuredClone(state); applyMilitaryCasualties(missing, missing.settlements[0], missing.groups[0], 50, { role: 'infantry' });
  missing.groups = []; // The normal cleanup removes a fully destroyed party.
  for (const current of [state, missing]) { current.factions[0].lastArmy = 0; stepStrategy(current, 0); conserved(current); }
  assert.deepEqual(missing.factions[0].campaignOrders, faction.campaignOrders);
  assert.deepEqual(missing.settlements[0].defensePlan, home.defensePlan);
  assert.equal(missing.groups.length, 0, 'unseen loss immediately summoned a replacement');
  const deadline = faction.campaignOrders[army.id].expiresTick;
  Object.assign(missing, { tick: deadline + 1, time: deadline + 1, step: (deadline + 1) * 10 });
  missing.factions[0].lastScout = missing.tick; stepStrategy(missing, 0);
  assert.equal(missing.factions[0].campaignOrders[army.id], undefined);
  assert.ok(ownArmies(missing, missing.factions[0]).length > 0, 'expired uncertainty permanently prevented a replacement'); conserved(missing);
});

test('a physical army return releases its recorded departure commitment', () => {
  const { state, faction, home, target } = fixture(); faction.lastArmy = 400;
  const army = party(state, home, 'returned-army', 30, { x: home.x + 4, z: home.z }); army.targetId = target.id;
  initializeLedger(state); stepStrategy(state, 0); assert.ok(faction.campaignOrders[army.id]);
  Object.assign(army, { phase: 'returning', x: home.x, z: home.z, targetX: home.x, targetZ: home.z });
  placeSoldiers(state, army, home);
  stepStrategy(state, 0); assert.equal(faction.campaignOrders[army.id], undefined);
  assert.equal(ownArmies(state, faction).length, 0); conserved(state);
});

test('an arrived army centre waits for its surviving soldiers before returning cargo, reports, and identities', () => {
  const { state, faction, home, target } = fixture(); faction.lastArmy = state.tick;
  const army = party(state, home, 'straggling-return', 30, home);
  Object.assign(army, { phase: 'returning', targetId: target.id, targetX: home.x, targetZ: home.z,
    carrying: { food: 10, water: 0, energy: 0, materials: 0 }, observations: [{ id: target.id, kind: 'settlement', ownerId: target.factionId,
      x: target.x, z: target.z, observedTick: 390, reportedTick: null, confidence: .9, status: 'active', populationEstimate: 100, soldiersEstimate: 0 }] });
  const soldiers = getSoldiers(state, army), wounded = soldiers[0], ids = army.soldierIds.slice();
  wounded.hp = 41; wounded.cooldown = 1.25; wounded.attackReadyAt = 403;
  wounded.x = wounded.prevX = home.x + 25;
  const stock = home.stock.food, available = countMilitary(availableMilitary(state, home)); initializeLedger(state);
  stepStrategy(state, 0);
  assert.ok(state.groups.includes(army)); assert.equal(home.stock.food, stock);
  assert.equal(countMilitary(availableMilitary(state, home)), available);
  assert.ok(faction.campaignOrders[army.id]); assert.equal(faction.knowledge[target.id], undefined);
  assert.equal(state.stats.reports, 0); assert.equal(wounded.groupId, army.id);
  placeSoldiers(state, army, home);
  stepStrategy(state, 0);
  assert.ok(!state.groups.includes(army)); assert.equal(home.stock.food, stock + 10);
  assert.equal(faction.campaignOrders[army.id], undefined); assert.equal(faction.knowledge[target.id].reportedTick, state.tick);
  assert.equal(countMilitary(availableMilitary(state, home)), available + soldiers.length);
  assert.deepEqual(army.soldierIds, ids); assert.ok(soldiers.every(soldier => home.soldierRoster.includes(soldier) && soldier.groupId == null));
  assert.equal(wounded.hp, 41); assert.equal(wounded.cooldown, 1.25); assert.equal(wounded.attackReadyAt, 403);
  conserved(state);
});

test('a tactical engagement still preserves the paid supply needed for the physical return march', () => {
  const { state, faction, home, target } = fixture(); faction.lastArmy = state.tick;
  const army = party(state, home, 'engaged-return-reserve', 40, { x: home.x + 5, z: home.z });
  Object.assign(army, { phase: 'engaging', targetId: target.id, targetX: target.x, targetZ: target.z, speed: 2.9, supply: 18 });
  initializeLedger(state); stepStrategy(state, 0);
  assert.equal(army.phase, 'retreating'); assert.equal(army.targetX, home.x);
  assert.ok(army.returnSupplyPlan.reserve >= 21); assert.match(army.reason, /supply reserve/);
  conserved(state);
});

test('an empty settlement cannot be pressured or captured by a route centre whose soldiers are still elsewhere', () => {
  const { state, faction, home, target, army } = captureFixture();
  placeSoldiers(state, army, home);
  const health = target.health, stock = { ...target.stock }; initializeLedger(state);
  stepStrategy(state, .1);
  assert.notEqual(target.occupiedBy, faction.id); assert.equal(target.health, health); assert.deepEqual(target.stock, stock);
  assert.equal(army.siegeDays, 5); assert.equal(army.engagedDays, 5);
  conserved(state);
});

test('a second campaign cannot raid or damage a settlement captured earlier in the same pulse', () => {
  const { state, faction, home, target, army } = captureFixture();
  const second = party(state, home, 'second-campaign', 40, target);
  Object.assign(second, { targetId: target.id, targetX: target.x, targetZ: target.z, phase: 'engaging', speed: 2.9,
    supply: 60, siegeMode: true, siegeDays: 5, engagedDays: 5, initialGarrison: 0 }); initializeLedger(state);
  stepStrategy(state, .1);
  assert.equal(target.occupiedBy, faction.id); assert.equal(army.siegeDays, 0, 'first army did not continue its next leg');
  assert.equal(second.siegeDays, 5, 'second army pressed its newly friendly target'); assert.equal(second.engagedDays, 5);
  assert.equal(state.stats.captures, 1); conserved(state);
});
