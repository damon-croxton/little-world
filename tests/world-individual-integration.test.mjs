import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createCrowds } from '../src/render/crowds.js';
import { createSimulation, stepSimulation } from '../src/sim/core.js';
import { initializeMilitary, syncMilitary, allocateMilitary, deployMilitary, returnMilitary, queueTraining, advanceTraining, cancelTraining, unitStats, applyHomeCasualties } from '../src/sim/military.js';
import { getSoldier, getSoldiers, applySoldierDamage, createSoldierRecords, syncSoldierCounts, touchSoldiers } from '../src/sim/soldiers.js';
import { initializeLedger, ledgerResidual, emptyResources, RESOURCES } from '../src/sim/economy.js';
import { occupySettlement } from '../src/sim/conquest.js';
import { factionView, initializeKnowledge, stepKnowledge, knowledgeCell, observeGroup, reportObservations } from '../src/sim/knowledge.js';
import { stepCombat } from '../src/sim/combat.js';
import { terrainAt } from '../src/world.js';
import { lineOfSight } from '../src/sim/navigation.js';
import { auditIndividualState } from './world-individual-audit.mjs';

function fixture() {
  const state = createSimulation('world-individual-integration', { civCount: 3 });
  state.groups = []; state.nodes = []; state.tradeOffers = []; state.events = [];
  for (const home of state.settlements) {
    home.population = 200; home.homePresent = 200; home.health = 100; home.wellbeing = 1; home.status = 'active';
    home.buildings = []; home.assigned = {}; home.trainingQueue = [];
    home.stock = Object.fromEntries(RESOURCES.map(kind => [kind, 1000])); home.capacity = 1000;
    initializeMilitary(home, { infantry: 0, ranged: 0 }, { state, faction: state.factions.find(f => f.id === home.factionId) });
  }
  for (const a of state.factions) for (const b of state.factions) if (a !== b) a.relations[b.id] = { status: 'hostile', trust: 0 };
  initializeLedger(state);
  return state;
}
function seedMilitary(state, home, units) {
  initializeMilitary(home, units, { state, faction: state.factions.find(f => f.id === home.factionId) });
}
function army(state, home, id, units, point = home) {
  const group = { id, kind: 'army', factionId: home.factionId, commandFactionId: home.factionId, originId: home.id, units: { ...units },
    size: units.infantry + units.ranged, initialSize: units.infantry + units.ranged, x: point.x, z: point.z, prevX: point.x, prevZ: point.z,
    targetX: point.x, targetZ: point.z, speed: 0, phase: 'outbound', morale: 100, supply: 100, carrying: emptyResources(), capacity: 20, createdTick: state.tick };
  deployMilitary(state, home, group); state.groups.push(group); return group;
}
function at(state, tick) { state.tick = tick; state.step = tick * 10; state.time = tick; }
function pulse(state) { state.step++; state.tick = Math.floor(state.step / 10); state.time = state.step / 10; stepCombat(state, .1); }
function clearSite(state) {
  for (let z = -60; z <= 60; z += 6) for (let x = -60; x <= 60; x += 6) {
    const points = [];
    for (let dz = -8; dz <= 8; dz += 2) for (let dx = -8; dx <= 8; dx += 2) points.push({ x: x + dx, z: z + dz });
    if (points.every(p => terrainAt(p.x, p.z, state.seed).traversable) && lineOfSight(state, { x: x - 7, z }, { x: x + 7, z }, { fromHeight: .65, toHeight: .65 })) return { x, z };
  }
  assert.fail('Fixture requires real traversable land with clear sight');
}
function place(soldier, point, extras = {}) { Object.assign(soldier, { x: point.x, z: point.z, prevX: point.x, prevZ: point.z, positioned: true, vx: 0, vz: 0, attackReadyAt: 1e6, ...extras }); }
function resourceConserved(state) { for (const residual of Object.values(ledgerResidual(state))) assert.ok(Math.abs(residual) < 1e-7, `resource residual ${residual}`); }

test('only funded completed training creates new retained identities, once per citizen', () => {
  const state = fixture();
  for (const home of state.settlements) {
    const faction = state.factions.find(f => f.id === home.factionId), spec = unitStats(faction, 'ranged');
    seedMilitary(state, home, { infantry: 2, ranged: 1 });
    const original = [...home.soldierRoster], population = home.population;
    home.buildings.push({ id: `${home.id}-producer`, kind: spec.building, progress: 1, hp: 160, maxHp: 160, x: home.x, z: home.z });
    const job = queueTraining(state, home, faction, 'ranged', 3, { reserves: {} }); assert.ok(job);
    assert.deepEqual(home.soldierRoster, original, 'queued civilians became soldiers before completing training');
    at(state, job.startedTick + job.duration - 1); assert.equal(advanceTraining(state, home, faction), 0);
    at(state, job.startedTick + job.duration); assert.equal(advanceTraining(state, home, faction), 3);
    assert.equal(advanceTraining(state, home, faction), 0); assert.equal(home.population, population);
    assert.equal(home.soldierRoster.length, original.length + 3);
    for (const record of original) assert.equal(getSoldier(state, record.id), record);
    const recruits = home.soldierRoster.filter(record => !original.includes(record));
    assert.ok(recruits.every(record => record.trainingJobId === job.id && record.hp === record.maxHp && record.species === faction.species));
    const cancelled = queueTraining(state, home, faction, 'ranged', 2, { reserves: {} }); assert.ok(cancelled);
    cancelTraining(state, home, cancelled.id); at(state, state.tick + cancelled.duration); assert.equal(advanceTraining(state, home, faction), 0);
    assert.equal(home.soldierRoster.length, original.length + 3);
    home.military.infantry = 999; home.soldiers = 999; syncMilitary(state, home);
    assert.equal(home.soldiers, 6); assert.equal(home.soldierRoster.length, 6, 'count synchronization minted identities');
  }
  auditIndividualState(state); resourceConserved(state);
});

test('two deployments are disjoint and return/redeployment retain each wound, clock and identity', () => {
  const state = fixture(), home = state.settlements[0]; seedMilitary(state, home, { infantry: 6, ranged: 4 });
  const original = [...home.soldierRoster], first = army(state, home, 'identity-first', allocateMilitary(state, home, 4));
  const second = army(state, home, 'identity-second', allocateMilitary(state, home, 4));
  assert.equal(new Set([...first.soldierIds, ...second.soldierIds]).size, 8);
  const wounded = getSoldiers(state, first)[0]; applySoldierDamage(state, wounded.id, 17); wounded.attackReadyAt = 83.25;
  const hp = wounded.hp, references = getSoldiers(state, first);
  for (const soldier of references) place(soldier, home, { attackReadyAt: soldier.attackReadyAt });
  assert.equal(returnMilitary(state, home, first), true); assert.equal(returnMilitary(state, home, first), false);
  state.groups = state.groups.filter(group => !group.finished);
  const next = army(state, home, 'identity-next', allocateMilitary(state, home, 6));
  assert.ok(next.soldierIds.includes(wounded.id)); assert.equal(getSoldier(state, wounded.id), wounded);
  assert.equal(wounded.hp, hp); assert.equal(wounded.attackReadyAt, 83.25);
  assert.equal(home.soldierRoster.length, original.length); assert.equal(home.population, 200);
  for (const soldier of original) assert.equal(getSoldier(state, soldier.id), soldier);
  auditIndividualState(state);
});

test('an exact casualty debits population and cargo once without moving its wound onto a peer', () => {
  const state = fixture(), home = state.settlements[0]; seedMilitary(state, home, { infantry: 3, ranged: 1 });
  const group = army(state, home, 'casualty-identities', { infantry: 3, ranged: 1 });
  group.carrying.food = 20; initializeLedger(state);
  const [victim, peer] = getSoldiers(state, group); applySoldierDamage(state, peer.id, 11); const peerHp = peer.hp;
  assert.equal(applySoldierDamage(state, victim.id, victim.hp + 100).killed, true);
  assert.equal(applySoldierDamage(state, victim.id, 100).damage, 0);
  assert.equal(home.population, 199); assert.equal(home.soldiers, 3); assert.equal(group.size, 3);
  assert.equal(state.stats.deaths, 1); assert.equal(state.stats.militaryDeaths, 1);
  assert.equal(group.carrying.food, 15); assert.equal(group.capacity, 15); assert.equal(peer.hp, peerHp);
  assert.equal(getSoldier(state, victim.id), victim); assert.equal(victim.status, 'dead');
  assert.ok(!getSoldiers(state, group).includes(victim)); auditIndividualState(state); resourceConserved(state);
});

test('home scarcity preserves away military identities and intact civilian worker/scout crews', () => {
  const state = fixture(), home = state.settlements[0]; seedMilitary(state, home, { infantry: 8, ranged: 2 }); home.population = 20;
  const group = army(state, home, 'scarcity-army', { infantry: 6, ranged: 2 });
  const before = getSoldiers(state, group).map(record => [record, record.hp]);
  const worker = { id: 'scarcity-workers', originId: home.id, factionId: home.factionId, kind: 'worker', size: 5 };
  const scout = { id: 'scarcity-scout', originId: home.id, factionId: home.factionId, kind: 'scout', size: 3 };
  state.groups.push(worker, scout);
  assert.equal(applyHomeCasualties(state, home, 100), 4); assert.equal(home.population, 16); assert.equal(home.soldiers, 8);
  assert.equal(worker.size, 5); assert.equal(scout.size, 3); assert.equal(worker.soldierIds, undefined); assert.equal(scout.soldierIds, undefined);
  for (const [record, hp] of before) { assert.equal(getSoldier(state, record.id), record); assert.equal(record.hp, hp); }
  assert.equal(applyHomeCasualties(state, home, 100), 0); auditIndividualState(state);
});

test('occupation demobilizes only present identities and preserves native citizens deployed elsewhere', () => {
  const state = fixture(), [home, invaderHome] = state.settlements;
  seedMilitary(state, home, { infantry: 4, ranged: 2 }); seedMilitary(state, invaderHome, { infantry: 2, ranged: 0 });
  const away = army(state, home, 'capture-away', { infantry: 2, ranged: 1 });
  const local = [...getSoldiers(state, home)], deployed = [...getSoldiers(state, away)];
  const invader = army(state, invaderHome, 'capture-invader', { infantry: 2, ranged: 0 }, home);
  for (const soldier of getSoldiers(state, invader)) place(soldier, home);
  const census = state.settlements.reduce((n, town) => n + town.population, 0), deaths = state.stats.deaths;
  assert.equal(occupySettlement(state, home, invader), true);
  assert.ok(local.every(record => record.status === 'demobilized' && record.alive));
  assert.ok(deployed.every(record => record.status === 'serving' && record.groupId === away.id));
  assert.equal(home.soldiers, 3); assert.equal(state.stats.deaths, deaths);
  assert.equal(state.settlements.reduce((n, town) => n + town.population, 0), census);
  assert.ok(home.soldierRoster.every(record => record.nativeFactionId === home.factionId)); auditIndividualState(state);
});

test('a launched projectile never switches to a surviving peer after its exact victim dies', () => {
  const state = fixture(), [sourceHome, targetHome] = state.settlements, center = clearSite(state);
  seedMilitary(state, sourceHome, { infantry: 0, ranged: 3 }); seedMilitary(state, targetHome, { infantry: 2, ranged: 0 });
  const source = army(state, sourceHome, 'projectile-source', { infantry: 0, ranged: 3 }, center);
  const target = army(state, targetHome, 'projectile-target', { infantry: 2, ranged: 0 }, { x: center.x + 6, z: center.z });
  const shooter = getSoldiers(state, source)[0], [victim, peer] = getSoldiers(state, target);
  getSoldiers(state, source).slice(1).forEach((soldier, i) => place(soldier, { x: center.x - 1, z: center.z + (i ? 2 : -2) }));
  place(shooter, center, { attackReadyAt: 0 }); place(victim, { x: center.x + 6, z: center.z }); place(peer, { x: center.x + 6, z: center.z + 3 });
  pulse(state);
  const shot = state.pendingCombat.find(strike => strike.sourceSoldierId === shooter.id);
  assert.ok(shot, `the individually eligible archer did not launch: ${JSON.stringify({ action: shooter.action, reason: shooter.reasonCode, phase: source.phase, combat: source.combat, pending: state.pendingCombat })}`); assert.equal(shot.targetSoldierId, victim.id);
  applySoldierDamage(state, victim.id, victim.hp); const hp = peer.hp; shooter.attackReadyAt = 1e6;
  for (let i = 0; i < 10; i++) pulse(state);
  assert.equal(peer.hp, hp, 'dead target ordinal redirected its delayed damage'); assert.equal(state.stats.deaths, 1);
  auditIndividualState(state);
});

test('thirty individually eligible soldiers strike two hostile factions without the old frontage cap', () => {
  const state = fixture(), [own, leftHome, rightHome] = state.settlements, center = clearSite(state);
  seedMilitary(state, own, { infantry: 30, ranged: 0 });
  seedMilitary(state, leftHome, { infantry: 15, ranged: 0 }); seedMilitary(state, rightHome, { infantry: 15, ranged: 0 });
  const source = army(state, own, 'all-eligible', { infantry: 30, ranged: 0 }, { x: center.x - .6, z: center.z });
  const left = army(state, leftHome, 'faction-left', { infantry: 15, ranged: 0 }, { x: center.x + .6, z: center.z - 3.75 });
  const right = army(state, rightHome, 'faction-right', { infantry: 15, ranged: 0 }, { x: center.x + .6, z: center.z + 3.75 });
  getSoldiers(state, source).forEach((soldier, i) => place(soldier, { x: center.x - .6, z: center.z - 7.25 + i * .5 }, { attackReadyAt: 0 }));
  [...getSoldiers(state, left), ...getSoldiers(state, right)].forEach((soldier, i) => place(soldier, { x: center.x + .6, z: center.z - 7.25 + i * .5 }));
  pulse(state);
  const attacks = state.combatEvents.filter(event => event.type === 'melee' && event.sourceId === source.id);
  assert.equal(new Set(attacks.map(event => event.sourceSoldierId)).size, 30, 'eligible bodies were throttled by a role/group frontage budget');
  assert.deepEqual(new Set(attacks.map(event => event.targetId)), new Set([left.id, right.id]));
  assert.equal(new Set(attacks.map(event => event.targetSoldierId)).size, 30);
  auditIndividualState(state);
});

test('individual weapon clocks bound pending work by real shooters without dropping eligible attacks', () => {
  const state = fixture(), [own, enemy] = state.settlements, center = clearSite(state);
  seedMilitary(state, own, { infantry: 0, ranged: 3 }); seedMilitary(state, enemy, { infantry: 2, ranged: 0 });
  const source = army(state, own, 'clock-source', { infantry: 0, ranged: 3 }, center);
  const target = army(state, enemy, 'clock-target', { infantry: 2, ranged: 0 }, { x: center.x + 6, z: center.z });
  getSoldiers(state, source).forEach((soldier, i) => place(soldier, { x: center.x, z: center.z + i - 1 }, { attackReadyAt: 0 }));
  getSoldiers(state, target).forEach((soldier, i) => place(soldier, { x: center.x + 6, z: center.z + i * 2 - 1 }, { hp: 10000, maxHp: 10000 }));
  const seen = new Set(), lastLaunch = new Map(); let attacks = 0;
  for (let i = 0; i < 70; i++) {
    pulse(state);
    const pendingShooters = state.pendingCombat.map(strike => strike.sourceSoldierId);
    assert.equal(new Set(pendingShooters).size, pendingShooters.length, 'one soldier accrued duplicate pending strikes inside its cooldown');
    assert.ok(state.pendingCombat.length <= 5, 'pending work exceeded the fixture\'s five real soldiers');
    for (const strike of state.pendingCombat) assert.ok(strike.impactTime > state.time && strike.impactTime - state.time <= .65 + 1e-8);
    for (const event of state.combatEvents.filter(event => ['projectile', 'melee'].includes(event.type))) {
      if (seen.has(event.id)) continue; seen.add(event.id); attacks++;
      const soldier = getSoldier(state, event.sourceSoldierId), previous = lastLaunch.get(soldier.id);
      if (previous != null) assert.ok(event.time - previous >= soldier.stats.cooldown - 1e-8, 'individual fired before its weapon recovered');
      lastLaunch.set(soldier.id, event.time);
    }
  }
  assert.ok(attacks >= 6, 'fixture did not exercise repeated independent cooldowns'); auditIndividualState(state);
});

test('a wounded individual withdraws while its healthy peer keeps fighting and remains a hittable victim', () => {
  const state = fixture(), [own, enemy] = state.settlements, center = clearSite(state);
  seedMilitary(state, own, { infantry: 1, ranged: 1 }); seedMilitary(state, enemy, { infantry: 2, ranged: 0 });
  const source = army(state, own, 'wounded-source', { infantry: 1, ranged: 1 }, center);
  const target = army(state, enemy, 'wounded-target', { infantry: 2, ranged: 0 }, { x: center.x + 4, z: center.z });
  const archer = getSoldiers(state, source).find(body => body.role === 'ranged'), infantry = getSoldiers(state, source).find(body => body.role === 'infantry');
  const [wounded, healthy] = getSoldiers(state, target);
  place(archer, center, { attackReadyAt: 0 }); place(infantry, { x: center.x + 5, z: center.z + 6 });
  place(wounded, { x: center.x + 6, z: center.z }, { hp: wounded.maxHp * .2 });
  place(healthy, { x: center.x + 6, z: center.z + 6 }, { attackReadyAt: 0 });
  const initialHp = wounded.hp; pulse(state);
  assert.equal(wounded.withdrawing, true); assert.equal(wounded.action, 'withdraw'); assert.ok(!healthy.withdrawing);
  assert.ok(state.combatEvents.some(event => event.sourceSoldierId === healthy.id && event.type === 'melee'));
  assert.ok(state.pendingCombat.some(strike => strike.sourceSoldierId === archer.id && strike.targetSoldierId === wounded.id));
  for (let i = 0; i < 8; i++) pulse(state);
  assert.ok(wounded.hp < initialHp, 'withdrawal made the exact wounded soldier immune to the already launched shot');
  auditIndividualState(state);
});

test('hidden rear ranks cannot change a visible field force\'s strength estimate or retreat order', () => {
  const state = fixture(), [own, enemy] = state.settlements, center = clearSite(state);
  seedMilitary(state, own, { infantry: 30, ranged: 0 }); seedMilitary(state, enemy, { infantry: 10, ranged: 0 });
  const source = army(state, own, 'observing-army', { infantry: 30, ranged: 0 }, { x: center.x - 3, z: center.z });
  const target = army(state, enemy, 'observed-army', { infantry: 10, ranged: 0 }, { x: center.x + 3, z: center.z });
  getSoldiers(state, source).forEach((body, i) => place(body, { x: center.x - 4 + (i % 5) * .5, z: center.z - 1.25 + Math.floor(i / 5) * .5 }));
  getSoldiers(state, target).forEach((body, i) => place(body, { x: center.x + 3 + (i % 2) * .5, z: center.z - 1 + Math.floor(i / 2) * .5 }));
  const altered = structuredClone(state), remoteHome = altered.settlements[1], remoteGroup = altered.groups.find(group => group.id === target.id);
  const faction = altered.factions.find(candidate => candidate.id === remoteHome.factionId);
  const reinforcements = createSoldierRecords(remoteHome, { infantry: 80, ranged: 0 }, { state: altered, faction,
    statsByRole: Object.fromEntries(['infantry', 'ranged'].map(role => [role, unitStats(faction, role)])) });
  for (const [i, body] of reinforcements.entries()) { body.groupId = remoteGroup.id; place(body, { x: center.x + 80 + (i % 10), z: center.z + Math.floor(i / 10) }); remoteGroup.soldierIds.push(body.id); }
  syncSoldierCounts(altered, remoteHome);
  pulse(state); pulse(altered);
  const base = state.groups.find(group => group.id === source.id), changed = altered.groups.find(group => group.id === source.id);
  assert.equal(changed.combat.enemyStrength, base.combat.enemyStrength, 'unseen bodies changed local estimated enemy strength');
  assert.equal(changed.phase, base.phase); assert.equal(changed.combat.intent, base.combat.intent);
  assert.equal(changed.combat.targetId, base.combat.targetId); auditIndividualState(altered);
});

test('each field recipient reports only the enemy bodies its own observers saw', () => {
  const state = fixture(), [own, enemy] = state.settlements, center = clearSite(state);
  seedMilitary(state, own, { infantry: 2, ranged: 0 }); seedMilitary(state, enemy, { infantry: 10, ranged: 0 });
  const front = army(state, own, 'front-reporter', { infantry: 1, ranged: 0 }, { x: center.x - 8, z: center.z });
  const flank = army(state, own, 'flank-reporter', { infantry: 1, ranged: 0 }, { x: center.x + 7, z: center.z });
  const target = army(state, enemy, 'reported-army', { infantry: 10, ranged: 0 }, { x: center.x - 3, z: center.z });
  place(getSoldiers(state, front)[0], front); place(getSoldiers(state, flank)[0], flank);
  getSoldiers(state, target).forEach((body, i) => place(body, { x: center.x - 3 + (i % 2) * .1, z: center.z + Math.floor(i / 2) * .1 }));
  const altered = structuredClone(state), remoteHome = altered.settlements[1], remoteGroup = altered.groups.find(group => group.id === target.id);
  const faction = altered.factions.find(candidate => candidate.id === remoteHome.factionId);
  const rear = createSoldierRecords(remoteHome, { infantry: 80, ranged: 0 }, { state: altered, faction,
    statsByRole: Object.fromEntries(['infantry', 'ranged'].map(role => [role, unitStats(faction, role)])) });
  for (const body of rear) { body.groupId = remoteGroup.id; place(body, { x: center.x + 7.75, z: center.z }); remoteGroup.soldierIds.push(body.id); }
  syncSoldierCounts(altered, remoteHome);
  const read = (candidate, direct) => {
    touchSoldiers(candidate); initializeKnowledge(candidate, { reset: true });
    if (direct) for (const group of candidate.groups.filter(group => group.factionId === own.factionId)) observeGroup(candidate, group);
    else stepKnowledge(candidate, { force: true });
    return [front, flank].map(group => candidate.groups.find(record => record.id === group.id).observations.find(record => record.id === target.id));
  };
  for (const direct of [false, true]) {
    const [base] = read(state, direct), [limited, expanded] = read(altered, direct);
    assert.ok(base && limited && expanded, 'both field observers must actually see the enemy front');
    assert.equal(limited.sizeEstimate, base.sizeEstimate, `${direct ? 'observeGroup' : 'stepKnowledge'} exposed hidden rear ranks to the front recipient`);
    assert.ok(expanded.sizeEstimate > limited.sizeEstimate, 'the second recipient did not record its locally visible rear ranks');
    const commander = altered.factions.find(record => record.id === own.factionId);
    assert.equal(commander.knowledge[target.id], undefined, 'field sight reached command before transmission');
    reportObservations(altered, commander, [limited], { method: 'return', group: altered.groups.find(record => record.id === front.id) });
    assert.equal(commander.knowledge[target.id].sizeEstimate, base.sizeEstimate, 'transmission expanded a carried report from hidden state');
  }
});

test('faction projection excludes hidden soldier records and hidden per-soldier effect references', () => {
  const state = createSimulation('individual-fog-reference', { civCount: 4 }), own = state.factions[0], home = state.settlements[0];
  const remote = state.settlements.find(town => town.factionId !== own.id && Math.hypot(town.x - home.x, town.z - home.z) > 70);
  assert.ok(remote); const hidden = remote.soldierRoster[0], visible = home.soldierRoster[0];
  hidden.targetId = 'hidden-private-order'; hidden.attackReadyAt = 987654;
  state.combatEvents = [{ id: 'visible-hit-hidden-source', type: 'impact', sourceId: remote.id, sourceSoldierId: hidden.id, shooterSoldierId: hidden.id,
    targetId: home.id, targetSoldierId: visible.id, factionId: own.id, x: home.x, z: home.z, time: 0, tick: 0, expiresAt: 2, damage: 1 },
  { id: 'visible-position-hidden-identity', type: 'casualty', positions: [{ x: home.x, z: home.z, soldierId: hidden.id, sourceId: hidden.id }],
    count: 1, factionId: own.id, time: 0, tick: 0, expiresAt: 2 }];
  initializeKnowledge(state, { reset: true }); stepKnowledge(state, { force: true });
  const view = factionView(state, own.id), serialized = JSON.stringify(view);
  assert.ok(!serialized.includes(hidden.id), 'hidden exact identity crossed the faction boundary');
  assert.ok(!serialized.includes('hidden-private-order')); assert.ok(!serialized.includes('987654'));
  assert.ok(view.combatEvents.some(event => event.id === 'visible-hit-hidden-source'), 'visible effect disappeared while filtering its hidden source');
  const casualty = view.combatEvents.find(event => event.id === 'visible-position-hidden-identity');
  assert.ok(casualty, 'visible casualty position disappeared while filtering its hidden identity');
  assert.equal(casualty.positions[0].soldierId, null); assert.equal(casualty.positions[0].sourceId, null);
  assert.ok(!JSON.stringify(factionView(state, 'nonexistent-faction')).includes(hidden.id));
});

test('a partially visible foreign garrison preserves the scoped civilian census without exposing hidden military reserves', () => {
  const state = fixture(), [ownHome, enemyHome] = state.settlements, own = state.factions[0], center = clearSite(state);
  seedMilitary(state, ownHome, { infantry: 1, ranged: 0 }); seedMilitary(state, enemyHome, { infantry: 10, ranged: 0 });
  Object.assign(enemyHome, { x: center.x + 3, z: center.z });
  const observer = army(state, ownHome, 'garrison-observer', { infantry: 1, ranged: 0 }, { x: center.x - 3, z: center.z });
  place(getSoldiers(state, observer)[0], observer);
  const [seen, ...hidden] = getSoldiers(state, enemyHome);
  place(seen, enemyHome, { hp: 37, attackReadyAt: 987654, targetId: 'private-garrison-order' });
  hidden.forEach(body => place(body, { x: center.x + 100, z: center.z + 50 }));
  const altered = structuredClone(state), changedHome = altered.settlements[1], enemyFaction = altered.factions.find(f => f.id === changedHome.factionId);
  const extra = createSoldierRecords(changedHome, { infantry: 80, ranged: 0 }, { state: altered, faction: enemyFaction,
    statsByRole: Object.fromEntries(['infantry', 'ranged'].map(role => [role, unitStats(enemyFaction, role)])) });
  extra.forEach(body => place(body, { x: center.x + 100, z: center.z + 50 }));
  changedHome.population += extra.length; changedHome.homePresent += extra.length; syncSoldierCounts(altered, changedHome);
  const project = candidate => { touchSoldiers(candidate); initializeKnowledge(candidate, { reset: true }); stepKnowledge(candidate, { force: true }); return factionView(candidate, own.id); };
  const view = project(state), changed = project(altered), visibleHome = view.settlements.find(home => home.id === enemyHome.id), changedVisible = changed.settlements.find(home => home.id === enemyHome.id);
  assert.ok(visibleHome && changedVisible, 'observer never saw the foreign settlement');
  assert.equal(visibleHome.soldiers, 1); assert.equal(visibleHome.workers, 190); assert.equal(visibleHome.population, 191); assert.equal(visibleHome.homePresent, 191);
  assert.deepEqual(visibleHome.military, { infantry: 1, ranged: 0 });
  for (const key of ['population', 'homePresent', 'workers', 'soldiers', 'populationEstimate', 'soldiersEstimate']) assert.equal(changedVisible[key], visibleHome[key], `hidden military changed scoped ${key}`);
  assert.equal(view.soldiers.filter(body => body.originId === enemyHome.id).length, 1);
  const shown = view.soldiers.find(body => body.id === seen.id);
  for (const key of ['hp', 'maxHp', 'attackReadyAt', 'targetId']) assert.equal(shown[key], undefined, `foreign soldier exposed private ${key}`);
  const serialized = JSON.stringify(changed);
  for (const body of [...hidden, ...extra]) assert.ok(!serialized.includes(body.id), `hidden soldier ${body.id} crossed projection`);
  assert.ok(!serialized.includes('private-garrison-order'));
  const scene = new THREE.Scene(), crowds = createCrowds(THREE, scene);
  try {
    crowds.update(view, state.time, null, 1);
    assert.equal(crowds.diagnostics.homePresentBySettlement[enemyHome.id], 191);
    assert.equal(crowds.diagnostics.militaryIndividuals, 2);
    assert.equal(crowds.diagnostics.populationAccountingDelta, 0);
    assert.equal(crowds.diagnostics.representedIndividuals, crowds.diagnostics.totalPopulation);
  } finally { crowds.dispose(); }
});

test('physical soldier sight clears local fog and carries field observations without revealing the empty route anchor', () => {
  const state = fixture(), own = state.factions[0], home = state.settlements[0], center = clearSite(state);
  assert.ok(state.settlements.every(town => Math.hypot(town.x - center.x, town.z - center.z) > 35), 'field fixture must be outside settlement sight');
  let anchor;
  for (let z = -140; z <= 140 && !anchor; z += 20) for (let x = -140; x <= 140; x += 20) {
    const point = { x, z };
    if (Math.hypot(x - center.x, z - center.z) > 75 && state.settlements.every(town => Math.hypot(town.x - x, town.z - z) > 40)) { anchor = point; break; }
  }
  assert.ok(anchor); seedMilitary(state, home, { infantry: 1, ranged: 0 });
  const group = army(state, home, 'body-sight-group', { infantry: 1, ranged: 0 }, anchor), soldier = getSoldiers(state, group)[0];
  place(soldier, center);
  state.nodes = [{ id: 'seen-by-real-body', kind: 'materials', x: center.x + 1, z: center.z, amount: 100, maxAmount: 100, richness: 1, radius: 1 },
    { id: 'unseen-at-empty-anchor', kind: 'materials', x: anchor.x + 1, z: anchor.z, amount: 100, maxAmount: 100, richness: 1, radius: 1 }];
  touchSoldiers(state); initializeKnowledge(state, { reset: true }); stepKnowledge(state, { force: true });
  assert.equal(own.visibility.visible[knowledgeCell(soldier)], 1, 'actual soldier remained covered by the fog grid');
  assert.equal(own.visibility.visible[knowledgeCell(anchor)], 0, 'empty route anchor revealed terrain');
  assert.equal(own.visibility.commandExplored[knowledgeCell(soldier)], 0, 'field sight teleported into home command knowledge');
  assert.equal(group.explorationMask[knowledgeCell(soldier)], 1);
  assert.ok(group.observations.some(observation => observation.id === 'seen-by-real-body'));
  assert.ok(!group.observations.some(observation => observation.id === 'unseen-at-empty-anchor'));
  assert.equal(own.knowledge['seen-by-real-body'], undefined);
  const view = factionView(state, own.id);
  assert.ok(view.nodes.some(node => node.id === 'seen-by-real-body'));
  assert.ok(!view.nodes.some(node => node.id === 'unseen-at-empty-anchor'));
});

test('a hidden enemy is removed from retained own targeting, pursuit, ignored-target and death references', () => {
  const state = fixture(), [ownHome, enemyHome] = state.settlements, own = state.factions[0], center = clearSite(state);
  seedMilitary(state, ownHome, { infantry: 1, ranged: 0 }); seedMilitary(state, enemyHome, { infantry: 1, ranged: 0 });
  const group = army(state, ownHome, 'reference-owner', { infantry: 1, ranged: 0 }, center);
  const enemy = army(state, enemyHome, 'reference-enemy', { infantry: 1, ranged: 0 }, { x: center.x + 3, z: center.z });
  const soldier = getSoldiers(state, group)[0], target = getSoldiers(state, enemy)[0]; place(soldier, center); place(target, enemy);
  soldier.targetId = target.id; soldier.ignoredTargetId = target.id; soldier.killedById = target.id; soldier.pursuit = { targetId: target.id, since: 0 };
  group.combat = { active: true, focusSoldierId: target.id };
  touchSoldiers(state); initializeKnowledge(state, { reset: true }); stepKnowledge(state, { force: true });
  assert.ok(factionView(state, own.id).soldiers.some(record => record.id === target.id), 'fixture never exposed the enemy body');
  const hiddenPoint = { x: center.x + 100, z: center.z + 40 };
  assert.ok(Math.hypot(ownHome.x - hiddenPoint.x, ownHome.z - hiddenPoint.z) > 35);
  Object.assign(enemy, hiddenPoint); place(target, hiddenPoint); touchSoldiers(state); stepKnowledge(state, { force: true });
  const view = factionView(state, own.id), shown = view.soldiers.find(record => record.id === soldier.id);
  assert.ok(!view.soldiers.some(record => record.id === target.id));
  assert.equal(shown.targetId, null); assert.equal(shown.ignoredTargetId, null); assert.equal(shown.killedById, null); assert.equal(shown.pursuit.targetId, null);
  assert.equal(view.groups.find(record => record.id === group.id).combat.focusSoldierId, null);
  assert.ok(!JSON.stringify(view).includes(target.id), 'hidden retained reference leaked elsewhere in the scoped view');
});

test('natural developing world keeps one roster and preserves population over batched and single pulses', () => {
  const state = createSimulation('world-individual-natural', { civCount: 4 }), initial = state.settlements.reduce((n, home) => n + home.population, 0), history = new Map();
  auditIndividualState(state, history);
  for (let cycle = 0; cycle < 80; cycle++) {
    if (cycle % 2) stepSimulation(state, 10); else for (let i = 0; i < 10; i++) stepSimulation(state, 1);
    auditIndividualState(state, history);
    assert.equal(state.settlements.reduce((n, home) => n + home.population, 0), initial + state.stats.births - state.stats.deaths);
  }
  assert.ok(state.stats.trained > 0, 'natural fixture completed no paid training');
});
