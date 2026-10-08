import test from 'node:test';
import assert from 'node:assert/strict';
import { createSimulation } from '../src/sim/core.js';
import { createSoldierRecords, syncSoldierCounts } from '../src/sim/soldiers.js';
import { unitStats } from '../src/sim/military.js';
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

test('an unharassed all-in campaign releases fit tower troops without inventing soldiers', () => {
  const { state, faction, home, target } = fixture(); report(faction, target);
  const roster = home.soldierRoster.slice(), identities = new Set(roster.map(soldier => soldier.id));
  home.assigned.towerCrew = 25; initializeLedger(state);
  stepStrategy(state, 0);
  const army = ownArmies(state, faction)[0]; assert.ok(army);
  assert.equal(countMilitary(availableMilitary(state, home)), 0);
  assert.equal(home.defensePlan.reserve, 0); assert.equal(army.releaseTowerCrew, true); assert.equal(army.size, 120);
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
  assert.equal(home.defensePlan.reserve, 0); assert.equal(countMilitary(availableMilitary(state, home)), 120);
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
  assert.equal(home.defensePlan.reserve, 0); assert.deepEqual(faction.campaignOrders, {});
  conserved(state);
});

test('nearby achievable campaigns take priority over weaker cross-map targets', () => {
  const { state, faction, target, other } = fixture();
  report(faction, target, 55); report(faction, other, 1); initializeLedger(state);
  stepStrategy(state, 0);
  assert.equal(ownArmies(state, faction)[0]?.targetId, target.id);
  conserved(state);
});

test('locally observed attackers retain enough fit home troops while the surplus can march', () => {
  const { state, faction, home, target } = fixture(); report(faction, target);
  initializeMilitary(target, { infantry: 80, ranged: 0 });
  const enemy = party(state, target, 'visible-attackers', 80, { x: home.x + 10, z: home.z });
  assert.ok(visibleToGroup(state, home, enemy)); initializeLedger(state);
  stepStrategy(state, 0);
  assert.equal(ownArmies(state, faction).length, 1);
  assert.ok(countMilitary(availableMilitary(state,home)) >= home.defensePlan.reserve);
  assert.equal(ownArmies(state,faction)[0].size,32);
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

test('unseen threats and unreturned worker sightings cannot alter home reserves or campaign orders', () => {
  const { state, faction, home, target } = fixture(); report(faction, target);
  initializeMilitary(target, { infantry: 15, ranged: 0 });
  const hidden = party(state, target, 'unseen-army', 15, { x: target.x, z: target.z + 8 });
  state.groups.push({ id: 'unreturned-worker', factionId: faction.id, originId: home.id, kind: 'worker', size: 4,
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

test('one focused campaign concentrates available soldiers while civilian commitments and cargo stay unchanged', () => {
  const { state, faction, home, target, other } = fixture(); report(faction, target); report(faction, other);
  state.groups.push({ id: 'workers', kind: 'worker', factionId: faction.id, originId: home.id, size: 20, x: home.x, z: home.z,
    phase: 'working', carrying: { food: 25, water: 0, energy: 0, materials: 0 } });
  state.groups[0].strategicRole = 'harvest';
  const civilianBefore = structuredClone(state.groups[0]), population = home.population; initializeLedger(state);
  stepStrategy(state, 0); faction.lastArmy = 0; stepStrategy(state, 0);
  const armies = ownArmies(state, faction);
  assert.equal(armies.length, 1); assert.equal(armies[0].targetId, target.id);
  assert.equal(armies[0].size, 120); assert.equal(new Set(armies[0].soldierIds).size, 120);
  assert.ok(countMilitary(availableMilitary(state, home)) >= home.defensePlan.reserve);
  assert.equal(home.population, population); assert.deepEqual(state.groups.find(g => g.id === 'workers'), civilianBefore);
  faction.lastArmy = 0; stepStrategy(state, 0); assert.equal(ownArmies(state, faction).length, 1, 'the protected reserve was dispatched'); conserved(state);
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

function destructionFixture() {
  const data = fixture(), { state, faction, home, target, other } = data;
  Object.assign(target, { x: -60, health: 5, population: 100, homePresent: 100 }); target.workers = 100;
  Object.assign(other, { x: -35 }); report(faction, target, 0); report(faction, other, 10); faction.lastArmy = 400;
  const army = party(state, home, 'campaign', 40, target);
  Object.assign(army, { targetId: target.id, targetX: target.x, targetZ: target.z, phase: 'engaging', speed: 2.9,
    supply: 60, siegeMode: true, siegeDays: 5, engagedDays: 5, initialGarrison: 0 });
  target.siege = { groupId: army.id, active: true }; initializeLedger(state);
  return { ...data, army };
}

test('troops finish a contacted undefended town before chasing an incidental third-party worker', () => {
  const { state, faction, home, target, other } = fixture(); faction.lastArmy = 400;
  Object.assign(target, { health: 10, population: 100, homePresent: 100, workers: 100 });
  const army = party(state, home, 'focus-finish', 24, target);
  Object.assign(army, { targetId: target.id, targetX: target.x, targetZ: target.z, missionTargetX: target.x, missionTargetZ: target.z, phase: 'engaging', speed: 2.9 });
  state.groups.push({ id: 'incidental-worker', kind: 'worker', factionId: other.factionId, originId: other.id, size: 12, initialSize: 12,
    x: target.x + 12, z: target.z, prevX: target.x + 12, prevZ: target.z, phase: 'working', supply: 100, morale: 90, capacity: 72, carrying: { food: 0, water: 0, energy: 0, materials: 0 } });
  initializeLedger(state);
  for (let i = 0; i < 30; i++) {
    state.step++; state.time = state.step / 10; state.tick = Math.floor(state.time);
    for (const f of state.factions) { f.lastScout = state.tick; f.lastArmy = state.tick; }
    stepStrategy(state, .1);
  }
  assert.equal(target.razed, true); assert.equal(target.health, 0);
  assert.equal(state.stats.settlementDamage, 10); assert.equal(army.size, 24);
  assert.ok(army.supply < 100 && army.supply > 85); conserved(state);
});

test('destroying an exposed settlement preserves identities and follows a nearby report using existing supplies', () => {
  const {state,faction,target,other,army}=destructionFixture(), stock={...target.stock}, population=target.population;
  army.supply=100;stepStrategy(state,.1);
  assert.equal(target.razed,true);assert.equal(target.health,0);assert.equal(target.occupiedBy,undefined);
  assert.equal(target.factionId,state.factions[1].id);assert.equal(target.population,population);
  assert.equal(army.phase,'outbound');assert.equal(army.targetId,other.id);assert.ok(army.supply<100);
  assert.deepEqual(target.stock,stock,'destroyed stores secretly funded the attacker');conserved(state);
});

test('a force without spare follow-up supplies returns after destruction without refilling from enemy stores', () => {
  const {state,target,army}=destructionFixture();
  army.supply=35;stepStrategy(state,.1);
  assert.equal(target.razed,true);assert.equal(target.occupiedBy,undefined);assert.equal(army.phase,'returning');
  assert.ok(army.supply<35);assert.equal(state.stats.captures||0,0);conserved(state);
});

function advance(state, cycles = .1) {
  state.step += Math.round(cycles * 10); state.time = state.step / 10; state.tick = Math.floor(state.time);
  for (const f of state.factions) { f.lastScout = state.tick; f.lastArmy = state.tick; }
  stepStrategy(state, cycles);
}

test('a supplied campaign kills an incidental defender, resumes its march, and destroys the undefended objective', () => {
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
  for (let pulse = 0; pulse < 500 && !target.razed; pulse++) {
    advance(state);
    if (!defender.size || defender.finished) lostDefender = true;
    if (lostDefender && army.phase === 'outbound' && army.targetId === target.id) resumedMarch = true;
    if (!target.razed) assert.ok(!['returning', 'retreating'].includes(army.phase), `campaign abandoned its live objective: ${army.reason}`);
  }
  assert.ok(lostDefender, 'fixture never killed its incidental defender'); assert.ok(resumedMarch, 'campaign never resumed its reported march');
  assert.equal(target.razed, true); assert.ok(target.health === 0); conserved(state);
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
  for (const current of [state, retreating]) { initializeLedger(current); stepStrategy(current, 0); conserved(current); assert.equal(ownArmies(current, current.factions[0]).length, 2); assert.ok(current.factions[0].campaignOrders[army.id]); }
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
  assert.deepEqual(missing.groups.map(g=>g.id), state.groups.filter(g=>g.id!==army.id).map(g=>g.id), 'unseen loss changed the normal reinforcement order');
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

test('an empty settlement cannot be pressured or destroyed by a route centre whose soldiers are still elsewhere', () => {
  const { state, faction, home, target, army } = destructionFixture();
  placeSoldiers(state, army, home);
  const health = target.health, stock = { ...target.stock }; initializeLedger(state);
  stepStrategy(state, .1);
  assert.notEqual(target.occupiedBy, faction.id); assert.equal(target.health, health); assert.deepEqual(target.stock, stock);
  assert.equal(army.siegeDays, 5); assert.equal(army.engagedDays, 5);
  conserved(state);
});

test('a second campaign cannot raid or damage a settlement destroyed earlier in the same pulse', () => {
  const { state, faction, home, target, army } = destructionFixture();
  const second = party(state, home, 'second-campaign', 40, target);
  Object.assign(second, { targetId: target.id, targetX: target.x, targetZ: target.z, phase: 'engaging', speed: 2.9,
    supply: 60, siegeMode: true, siegeDays: 5, engagedDays: 5, initialGarrison: 0 }); initializeLedger(state);
  stepStrategy(state, .1);
  assert.equal(target.razed,true); assert.equal(target.health,0); assert.equal(target.occupiedBy,undefined);
  assert.equal(second.siegeDays, 5, 'second army pressed a destroyed target'); assert.equal(second.engagedDays, 5);
  assert.equal(state.stats.settlementsDestroyed, 1); conserved(state);
});


test('a smaller affordable campaign still meets the reported strength floor and pays exact rations', () => {
  const { state, faction, home, target } = fixture(); report(faction, target, 20);
  home.stock.food = 50; home.stock.water = 45; initializeLedger(state);
  stepStrategy(state, 0); const army = ownArmies(state, faction)[0];
  assert.ok(army, 'large preferred force masked the affordable alternative');
  assert.ok(army.size < 84 && army.size >= 17); assert.ok(home.stock.food >= 20 && home.stock.water >= 20);
  conserved(state);
});

test('a supplied winning army exploits a known nearby work party below the old arbitrary return thresholds', () => {
  const {state,faction,home,target}=fixture();faction.lastArmy=400;
  const army=party(state,home,'local-victor',24,{x:home.x+35,z:home.z});
  Object.assign(army,{speed:2.9,campaign:true,missionKind:'harassment',targetId:'finished-raid',targetX:army.x,targetZ:army.z,missionTargetX:army.x,missionTargetZ:army.z,supply:55,morale:60});
  const worker={id:'nearby-labor',kind:'worker',factionId:target.factionId,originId:target.id,size:12,x:army.x+6,z:army.z,phase:'working',carrying:{food:0,water:0,energy:0,materials:0}};state.groups.push(worker);
  faction.knowledge[worker.id]={id:worker.id,kind:'group',groupKind:'worker',ownerId:worker.factionId,x:worker.x,z:worker.z,sizeEstimate:12,observedTick:400,reportedTick:400,confidence:1};
  initializeLedger(state);stepStrategy(state,0);
  assert.equal(army.targetId,worker.id);assert.ok(!['returning','retreating'].includes(army.phase));assert.equal(army.originId,home.id);conserved(state);
});

test('a low-supply offensive physically visits a funded forward depot without healing or returning to its origin', () => {
  const {state,faction,home,target,other}=fixture();faction.lastArmy=400;
  other.factionId=faction.id;other.x=home.x+30;other.z=home.z;initializeMilitary(other,{infantry:0,ranged:0},{state});
  const army=party(state,home,'forward-refill',40,{x:home.x+35,z:home.z});
  Object.assign(army,{speed:2.9,targetId:target.id,targetX:target.x,targetZ:target.z,missionTargetX:target.x,missionTargetZ:target.z,supply:20,morale:80});
  const wounded=getSoldiers(state,army)[0];wounded.hp=wounded.maxHp*.7;const hp=wounded.hp,stock={...other.stock};initializeLedger(state);
  stepStrategy(state,0);assert.equal(army.stagingPurpose,'resupply');assert.equal(army.stagingTargetId,other.id);assert.equal(army.targetX,other.x);assert.deepEqual(other.stock,stock,'remote depot paid before physical arrival');
  for(let i=0;i<100&&army.stagingTargetId;i++)advance(state);
  assert.equal(army.stagingTargetId,null);assert.ok(army.supply>95);assert.equal(army.targetX,target.x);assert.equal(wounded.hp,hp);assert.ok(RESOURCES.some(k=>other.stock[k]<stock[k]));conserved(state);
});

test('new recruits stage at a purposeful rally and depart together as paid frontline reinforcements', () => {
  const {state,faction,home,target}=fixture();report(faction,target);initializeLedger(state);stepStrategy(state,0);
  const main=ownArmies(state,faction)[0];assert.equal(main.size,120);Object.assign(main,{x:home.x+30,z:home.z});placeSoldiers(state,main);
  const add=n=>{const bodies=createSoldierRecords(home,{infantry:n,ranged:0},{state,faction,source:'controlled-rally-fixture',statsByRole:{infantry:unitStats(faction,'infantry'),ranged:unitStats(faction,'ranged')}});syncSoldierCounts(state,home);return bodies;};
  const first=add(4);Object.assign(state,{tick:416,step:4160,time:416});stepStrategy(state,0);
  assert.equal(ownArmies(state,faction).length,1,'recruits trickled into a separate four-person attack');assert.equal(home.productionRally.kind,'frontline');
  assert.ok(first.every(body=>body.order.role==='production-rally'&&body.groupId==null));assert.ok(Math.hypot(home.productionRally.x-home.x,home.productionRally.z-home.z)>0);
  const rest=add(4);Object.assign(state,{tick:432,step:4320,time:432});stepStrategy(state,0);
  const reinforcement=ownArmies(state,faction).find(g=>g.id!==main.id);assert.ok(reinforcement);assert.equal(reinforcement.size,8);assert.equal(reinforcement.reinforcement,true);
  assert.deepEqual(new Set(reinforcement.soldierIds),new Set([...first,...rest].map(body=>body.id)));assert.equal(home.population,400);conserved(state);
});


test('a supplied twelve-soldier force destroys an exposed base without an occupation timer; emergency supply still recalls it',()=>{
  for(const supply of [100,18]){
    const {state,faction,home,target}=fixture();faction.lastArmy=400;
    Object.assign(home,{x:target.x-10,z:target.z});
    Object.assign(target,{population:50,homePresent:50,health:30});
    const army=party(state,home,'finish-exposed',12,target);
    Object.assign(army,{targetId:target.id,targetX:target.x,targetZ:target.z,missionTargetX:target.x,missionTargetZ:target.z,phase:'engaging',speed:2.9,supply});
    initializeLedger(state);
    for(let pulse=0;pulse<240&&!target.razed&&!['returning','retreating'].includes(army.phase);pulse++)advance(state);
    if(supply===100){assert.equal(army.finishPlan?.accepted,true);assert.equal(target.razed,true,JSON.stringify({health:target.health,phase:army.phase,reason:army.reason,plan:army.finishPlan}));assert.equal(target.occupiedBy,undefined);assert.ok(army.finishPlan.estimatedCycles>2);}
    else {assert.equal(target.occupiedBy,undefined);assert.equal(army.phase,'retreating');assert.match(army.reason,/suppl|reserve/i);}
    conserved(state);
  }
});

test('destruction clears funded structures without converting surviving civilians or field soldiers',async()=>{
  const {stepSimulation}=await import('../src/sim/core.js');
  const {state,faction,target,army}=destructionFixture();
  target.buildings=[{id:'doomed-farm',kind:'farm',x:target.x,z:target.z,progress:1,hp:160,maxHp:160}];
  const native=target.factionId,population=target.population;
  stepStrategy(state,.1);
  assert.equal(target.razed,true);assert.equal(target.health,0);assert.equal(target.occupiedBy,undefined);
  assert.equal(target.buildings[0].hp,0);assert.equal(target.buildings[0].destroyed,true);
  assert.equal(target.population,population);assert.equal(target.factionId,native);assert.equal(state.stats.captures||0,0);
  assert.equal(army.factionId,faction.id);assert.equal(target.trainingQueue.length,0);
  stepSimulation(state,10);
  assert.equal(target.status,'camp');assert.equal(target.factionId,native);assert.equal(target.occupiedBy,undefined);
  assert.ok(target.population<=population);assert.equal(state.stats.settlementsDestroyed,1);conserved(state);
});

test('three supplied soldiers damage a nearly destroyed outpost immediately, without a capture wait',()=>{
  const {state,faction,home,target}=fixture();faction.lastArmy=400;
  Object.assign(home,{x:target.x-10,z:target.z});Object.assign(target,{population:5,homePresent:5,health:.1});
  const army=party(state,home,'small-destruction',3,target);
  Object.assign(army,{targetId:target.id,targetX:target.x,targetZ:target.z,phase:'engaging',speed:2.9});
  initializeLedger(state);stepStrategy(state,.1);
  assert.equal(target.razed,true);assert.equal(army.siegeDays,1);assert.equal(target.population,5);assert.equal(target.occupiedBy,undefined);conserved(state);
});

test('funded settlers can reuse a razed plot without inheriting its displaced native population',async()=>{
  const {stepSimulation}=await import('../src/sim/core.js');
  const {state,faction,home,target}=fixture();faction.lastArmy=400;
  Object.assign(target,{status:'camp',health:12,razed:true});
  const original=home.population,native=target.population,cargo={food:20,water:20,energy:40,materials:180};
  for(const [key,value] of Object.entries(cargo))home.stock[key]-=value;
  state.groups.push({id:'rebuilding-party',kind:'colonist',originId:home.id,factionId:faction.id,size:24,x:target.x,z:target.z,prevX:target.x,prevZ:target.z,
    targetX:target.x,targetZ:target.z,targetId:target.id,phase:'outbound',speed:2.25,supply:100,morale:88,provisionCycles:100,createdTick:400,carrying:cargo,observations:[]});
  initializeLedger(state);stepSimulation(state,1);
  const founded=state.settlements.find(h=>h.id!==target.id&&h.x===target.x&&h.z===target.z);
  assert.ok(founded);assert.equal(founded.factionId,faction.id);assert.equal(founded.population,24);
  assert.equal(home.population,original-24);assert.equal(target.population,native);assert.equal(target.factionId,state.factions[1].id);
  assert.equal(target.occupiedBy,undefined);assert.ok(!state.groups.some(g=>g.id==='rebuilding-party'));conserved(state);
});
