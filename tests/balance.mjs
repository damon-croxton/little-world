import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createSimulation, stepSimulation, SIM_LIMITS } from '../src/sim/core.js';
import { inventory, ledgerResidual, RESOURCES } from '../src/sim/economy.js';
import { groupController } from '../src/sim/control.js';
import { sovereignHomes, settlementController, viableArmy } from '../src/sim/conquest.js';
import { MILITARY_ROLES, countMilitary, trainingCount, unitStats } from '../src/sim/military.js';

export const DEFAULT_SEEDS = ['first-light', 'tidal-garden', 'iron-valley', 'amber-dawn', 'winter-circuit', 'moss-and-machine'];

export function population(state) {
  return state.settlements.reduce((sum, home) => sum + home.population, 0);
}

export function auditState(state, label = `${state.seed} cycle ${state.tick}`) {
  const ids = new Set();
  const addId = (id, type) => {
    assert.ok(id && !ids.has(id), `${label}: duplicate/missing ${type} id ${id}`);
    ids.add(id);
  };
  const finite = (value, path, seen = new Set()) => {
    if (typeof value === 'number') assert.ok(Number.isFinite(value), `${label}: nonfinite ${path}=${value}`);
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) finite(child, `${path}.${key}`, seen);
  };
  finite(state, 'state');
  assert.equal(state.tick, Math.floor(state.step / 10), `${label}: cycle/pulse mismatch`);
  assert.equal(state.time, state.step / 10, `${label}: simulation time mismatch`);
  assert.ok(state.groups.length <= SIM_LIMITS.groups, `${label}: group budget exceeded`);
  assert.ok(state.settlements.length <= SIM_LIMITS.settlements, `${label}: settlement history budget exceeded`);
  for (const node of state.nodes) {
    addId(node.id, 'node');
    assert.ok(node.amount >= -1e-8 && node.amount <= node.maxAmount + 1e-8, `${label}: deposit ${node.id} amount=${node.amount}/${node.maxAmount}`);
  }
  for (const home of state.settlements) {
    addId(home.id, 'settlement');
    assert.ok(Number.isInteger(home.population) && home.population >= 0, `${label}: invalid population ${home.id}=${home.population}`);
    assert.ok(Number.isInteger(home.soldiers) && home.soldiers >= 0 && home.soldiers <= home.population, `${label}: invalid soldiers ${home.id}=${home.soldiers}/${home.population}`);
    assert.ok(home.military, `${label}: missing role census ${home.id}`);
    for (const role of MILITARY_ROLES) assert.ok(Number.isInteger(home.military[role]) && home.military[role] >= 0, `${label}: invalid ${home.id} ${role}`);
    assert.equal(countMilitary(home.military), home.soldiers, `${label}: role/soldier census ${home.id}`);
    const deployed = state.groups.filter(g => g.originId === home.id && !g.finished).reduce((sum, g) => sum + g.size, 0);
    assert.ok(deployed <= home.population, `${label}: ghost individuals ${home.id}: deployed ${deployed} > population ${home.population}`);
    const army = state.groups.filter(g => g.originId === home.id && g.kind === 'army' && !g.finished).reduce((sum, g) => sum + g.size, 0);
    for (const role of MILITARY_ROLES) {
      const roleAway = state.groups.filter(g => g.originId === home.id && g.kind === 'army' && !g.finished).reduce((sum, g) => sum + (g.units?.[role] || 0), 0);
      assert.ok(roleAway <= home.military[role], `${label}: overdeployed ${role} ${home.id}: ${roleAway}/${home.military[role]}`);
    }
    const trainees = trainingCount(home), queuedBuildings = new Set();
    assert.ok(trainees + home.soldiers + deployed - army <= home.population, `${label}: trainees lack civilian bodies ${home.id}`);
    for (const job of home.trainingQueue) {
      addId(job.id, 'training order');
      assert.equal(job.nativeFactionId, home.factionId, `${label}: training changed native identity ${job.id}`);
      assert.ok(state.factions.some(f => f.id === job.commandFactionId), `${label}: training names unknown command ${job.id}`);
      assert.ok(MILITARY_ROLES.includes(job.role) && Number.isInteger(job.size) && job.size > 0, `${label}: invalid training order ${job.id}`);
      assert.ok(!queuedBuildings.has(job.buildingId), `${label}: duplicate producer reservation ${job.buildingId}`); queuedBuildings.add(job.buildingId);
      assert.ok(job.remaining >= 0 && job.remaining <= job.duration && job.duration > 0 && job.progress >= 0 && job.progress <= 1, `${label}: invalid training clock ${job.id}`);
      assert.ok(job.startedTick <= job.lastAdvancedTick && job.lastAdvancedTick <= state.tick, `${label}: invalid training timeline ${job.id}`);
      const producer = home.buildings.find(b => b.id === job.buildingId);
      assert.ok(producer, `${label}: missing training producer ${job.buildingId}`);
      assert.equal(producer.kind, unitStats(state.factions.find(f => f.id === home.factionId)?.species, job.role).building, `${label}: wrong-species/role training producer ${job.id}`);
      assert.ok(RESOURCES.some(kind => (job.cost?.[kind] || 0) > 0), `${label}: free training ${job.id}`);
    }
    assert.ok(army <= home.soldiers, `${label}: deployed soldiers ${home.id} ${army} > ${home.soldiers}`);
    assert.ok(home.population <= SIM_LIMITS.populationPerSettlement, `${label}: settlement population budget exceeded: ${home.id}`);
    if (state.step % 10 === 0) {
      assert.equal(home.workers + home.soldiers, home.population, `${label}: civilian/military census ${home.id}`);
      assert.equal(home.homePresent + deployed, home.population, `${label}: present/away census ${home.id}`);
      assert.equal(home.assigned.military, army, `${label}: military assignment ${home.id}`);
      const civilianAway = deployed - army;
      assert.equal(home.assigned.civilianAway, civilianAway, `${label}: away civilian assignment ${home.id}`);
      assert.equal(home.assigned.training, trainees, `${label}: training assignment ${home.id}`);
      assert.ok(home.assigned.towerCrew <= home.military.ranged, `${label}: tower crew exceeds trained ranged census ${home.id}`);
      const committed = civilianAway + home.soldiers + home.assigned.researchers + home.assigned.construction + home.assigned.infrastructure + home.assigned.training + home.availableWorkers;
      assert.equal(committed, home.population, `${label}: double-booked or unassigned workforce ${home.id}`);
      for (const [kind, value] of Object.entries(home.assigned)) assert.ok(Number.isInteger(value) && value >= 0, `${label}: invalid assignment ${home.id}/${kind}`);
      for (const b of home.buildings || []) assert.ok((b.workersAssigned || 0) >= 0 && (b.workersAssigned || 0) <= 4, `${label}: infrastructure crew capacity ${home.id}/${b.id}`);
    }
    for (const kind of RESOURCES) assert.ok(home.stock[kind] >= -1e-8 && home.stock[kind] <= home.capacity + 1e-8, `${label}: ${home.id} ${kind} stock=${home.stock[kind]}/${home.capacity}`);
    for (const building of home.buildings || []) {
      addId(building.id, 'building');
      assert.ok(building.progress >= 0 && building.progress <= 1, `${label}: building ${building.id} progress ${building.progress}`);
      assert.ok(building.x >= state.bounds.minX && building.x <= state.bounds.maxX && building.z >= state.bounds.minZ && building.z <= state.bounds.maxZ, `${label}: building out of world ${building.id}`);
    }
  }
  for (const group of state.groups) {
    addId(group.id, 'group');
    assert.ok(Number.isInteger(group.size) && group.size > 0, `${label}: invalid group size ${group.id}=${group.size}`);
    const home = state.settlements.find(h => h.id === group.originId);
    assert.ok(home, `${label}: orphan group ${group.id}/${group.originId}`);
    assert.equal(group.factionId, home.factionId, `${label}: group ${group.id} native identity differs from origin`);
    if (group.commandFactionId) assert.ok(state.factions.some(f => f.id === group.commandFactionId), `${label}: group ${group.id} names unknown political command`);
    assert.ok(group.x >= state.bounds.minX && group.x <= state.bounds.maxX && group.z >= state.bounds.minZ && group.z <= state.bounds.maxZ, `${label}: group ${group.id} outside world`);
    for (const kind of RESOURCES) assert.ok((group.carrying?.[kind] || 0) >= -1e-8, `${label}: negative cargo ${group.id}/${kind}`);
    if (group.kind === 'worker' && !group.refugees) {
      const cargo = RESOURCES.reduce((sum, kind) => sum + (group.carrying?.[kind] || 0), 0);
      assert.ok(cargo <= group.capacity + 1e-7, `${label}: overloaded worker ${group.id} cargo=${cargo}/${group.capacity}`);
    }
    if (group.kind === 'army') {
      assert.ok(group.units, `${label}: army has no role census ${group.id}`);
      for (const role of MILITARY_ROLES) assert.ok(Number.isInteger(group.units[role]) && group.units[role] >= 0, `${label}: invalid army role ${group.id}/${role}`);
      assert.equal(countMilitary(group.units), group.size, `${label}: army role/size mismatch ${group.id}`);
      const cargo = RESOURCES.reduce((sum, kind) => sum + (group.carrying?.[kind] || 0), 0);
      assert.ok(cargo <= group.size * 1.2 + 1e-7, `${label}: overloaded army ${group.id}`);
    }
    if (group.kind === 'trader') {
      const cargo = RESOURCES.reduce((sum, kind) => sum + (group.carrying?.[kind] || 0), 0);
      assert.ok(cargo <= group.capacity + 1e-7, `${label}: overloaded caravan ${group.id}`);
    }
    if (group.kind === 'army' && group.intelligence) {
      const orderTick = group.missionOrderTick ?? group.createdTick;
      assert.ok(Number.isFinite(orderTick) && group.createdTick <= orderTick && orderTick <= state.tick, `${label}: invalid army mission order time ${group.id}`);
      assert.ok(orderTick - group.intelligence.observedTick <= 230 && group.intelligence.confidence >= .3, `${label}: army ${group.id} ordered on stale intelligence`);
      assert.ok(group.intelligence.observedTick <= group.intelligence.reportedTick && group.intelligence.reportedTick <= orderTick, `${label}: army ${group.id} mission preceded its report`);
    }
  }
  if (state.stats.trainingStarted != null) assert.equal(state.stats.trainingStarted, (state.stats.trained || 0) + (state.stats.trainingCancelled || 0) + state.settlements.reduce((sum, home) => sum + trainingCount(home), 0), `${label}: unaccounted training order completion/cancellation`);
  for (const faction of state.factions) {
    assert.ok(faction.tech.level >= 0 && faction.tech.level <= 4, `${label}: technology level bounds ${faction.id}`);
    assert.equal(new Set(faction.tech.unlocked).size, faction.tech.level, `${label}: duplicated/unfunded technologies ${faction.id}`);
    for (const report of Object.values(faction.knowledge)) {
      assert.ok(report.observedTick >= 0 && report.observedTick <= report.reportedTick && report.reportedTick <= state.tick, `${label}: impossible report timeline ${faction.id}/${report.id}`);
      assert.ok(report.confidence >= 0 && report.confidence <= 1, `${label}: report confidence ${faction.id}/${report.id}`);
    }
    for (const relation of Object.values(faction.relations)) assert.ok(relation.trust >= 0 && relation.trust <= 100, `${label}: diplomacy trust bounds ${faction.id}`);
  }
  for (const event of state.events) if (event.type === 'mobilize') {
    assert.ok(Number.isFinite(event.reportTick) && event.observationTick <= event.reportTick && event.reportTick <= event.tick, `${label}: mobilisation lacks prior returned report ${event.id}`);
  }
  const factionIds = new Set(state.factions.map(f => f.id));
  for (const home of state.settlements) if (home.occupiedBy) {
    assert.ok(factionIds.has(home.occupiedBy), `${label}: occupied settlement has unknown controller ${home.id}`);
    assert.notEqual(home.occupiedBy, home.factionId, `${label}: settlement redundantly occupies itself ${home.id}`);
  }
  for (const faction of state.factions) if (faction.defeatedBy) {
    assert.ok(factionIds.has(faction.defeatedBy), `${label}: defeat names nonexistent faction ${faction.id}`);
    assert.notEqual(faction.defeatedBy, faction.id, `${label}: faction defeated itself ${faction.id}`);
    const visited = new Set([faction.id]); let controller = faction.defeatedBy;
    while (controller) {
      assert.ok(!visited.has(controller), `${label}: cyclic sovereignty chain for ${faction.id}`);
      visited.add(controller); controller = state.factions.find(f => f.id === controller)?.defeatedBy;
    }
  }
  if (state.step % 10 === 0) {
    const exileCommands = new Set();
    for (const home of state.settlements) if (home.exileBaseFor) {
      assert.ok(factionIds.has(home.exileBaseFor), `${label}: unknown exile command ${home.id}`);
      assert.ok(!exileCommands.has(home.exileBaseFor), `${label}: multiple exile bases for ${home.exileBaseFor}`); exileCommands.add(home.exileBaseFor);
      assert.equal(settlementController(state, home), home.exileBaseFor, `${label}: exile base not physically held ${home.id}`);
      assert.ok(!state.settlements.some(h => h.factionId === home.exileBaseFor && !h.occupiedBy && h.population > 0 && h.health > 0 && !['camp', 'ruin'].includes(h.status)), `${label}: exile privilege continued after native home restored`);
    }
  }
  if (state.outcome?.status === 'victory') {
    assert.ok(factionIds.has(state.outcome.winnerId), `${label}: victory names nonexistent faction`);
    assert.ok(Number.isFinite(state.outcome.wonAt) && state.outcome.wonAt >= 0 && state.outcome.wonAt <= state.time, `${label}: invalid victory time`);
    assert.ok(Number.isInteger(state.outcome.tick) && state.outcome.tick >= 0 && state.outcome.tick <= state.tick, `${label}: invalid victory cycle`);
    assert.ok(!state.factions.find(f => f.id === state.outcome.winnerId).defeatedBy, `${label}: defeated faction declared winner`);
    for (const home of state.settlements) if (home.population > 0 && !['camp', 'ruin'].includes(home.status)) assert.equal(settlementController(state, home), state.outcome.winnerId, `${label}: victory while independent territory remains ${home.id}`);
    for (const group of state.groups) if (viableArmy(group)) {
      assert.equal(groupController(state, group), state.outcome.winnerId, `${label}: victory while viable independent army remains ${group.id}`);
    }
  }
  const deathCauses = ['combatDeaths', 'fieldDeaths', 'strategicFieldDeaths', 'homeScarcityDeaths'].reduce((sum, cause) => sum + (state.stats[cause] || 0), 0);
  assert.equal(deathCauses, state.stats.deaths, `${label}: death causes do not partition actual population losses`);
  const residual = ledgerResidual(state);
  for (const kind of RESOURCES) {
    const ledger = state.resourceLedger[kind];
    const tolerance = Math.max(1e-6, ledger.initial * 1e-9);
    assert.ok(Math.abs(residual[kind]) <= tolerance, `${label}: ${kind} conservation residual ${residual[kind]} (tolerance ${tolerance})`);
    for (const [key, value] of Object.entries(ledger)) if (key !== 'tradeNet') assert.ok(value >= -1e-8, `${label}: negative ledger ${kind}.${key}`);
  }
  return residual;
}

export function snapshot(state) {
  const living = state.settlements.filter(h => h.population > 0 && !['ruin', 'camp'].includes(h.status));
  const totalPopulation = population(state);
  const workerIndividuals = state.groups.filter(g => g.kind === 'worker').reduce((sum, g) => sum + g.size, 0);
  const assigned = state.settlements.reduce((sum, h) => sum + ['civilianAway', 'military', 'researchers', 'construction', 'infrastructure', 'training'].reduce((n, key) => n + (h.assigned?.[key] || 0), 0), 0);
  return {
    cycle: state.tick,
    outcome: state.outcome ? { ...state.outcome } : null,
    sovereignFactions: state.factions.filter(f => !f.defeatedBy && sovereignHomes(state, f.id).length).length,
    occupiedSettlements: state.settlements.filter(h => h.occupiedBy).map(h => ({ id: h.id, nativeFactionId: h.factionId, controllerId: settlementController(state, h), population: h.population })),
    civCount: state.factions.length,
    population: totalPopulation,
    colonies: living.length,
    settlementStatuses: Object.fromEntries(['active', 'camp', 'ruin'].map(status => [status, state.settlements.filter(h => h.status === status).length])),
    populationBySpecies: Object.fromEntries(['human', 'machine', 'hive'].map(species => [species, state.settlements.filter(h => state.factions.find(f => f.id === h.factionId)?.species === species).reduce((n, h) => n + h.population, 0)])),
    shortageColonies: living.filter(h => h.shortageDays >= 18).length,
    sites: state.settlements.length,
    groups: state.groups.length,
    workerIndividuals,
    navigation: {
      blockedGroups: state.groups.filter(g => g.navigation?.reachable === false).length,
      overAgeGroups: state.groups.filter(g => state.time - g.createdTick > 240).length,
      oldestMissionCycles: Math.max(0, ...state.groups.map(g => state.time - g.createdTick)),
      failedReasons: Object.fromEntries([...new Set(state.groups.filter(g => g.navigation?.reachable === false).map(g => g.navigation.reason))].map(reason => [reason, state.groups.filter(g => g.navigation?.reachable === false && g.navigation.reason === reason).length])),
      stranded: state.groups.filter(g => state.time - g.createdTick > 240 || g.navigation?.reachable === false).map(g => ({ id: g.id, factionId: g.factionId, kind: g.kind, size: g.size, age: state.time - g.createdTick, phase: g.phase, supply: g.supply, reason: g.navigation?.reason, from: { x: g.x, z: g.z }, to: { x: g.targetX, z: g.targetZ } })),
    },
    assigned,
    largestColony: Math.max(...living.map(h => h.population), 0),
    largestRadius: Math.max(...living.map(h => h.radius || 0), 0),
    buildings: state.settlements.reduce((sum, h) => sum + (h.buildings?.length || 0), 0),
    completedBuildings: state.settlements.reduce((sum, h) => sum + (h.buildings?.filter(b => b.progress >= 1).length || 0), 0),
    factionDetails: state.factions.map(f => ({ id: f.id, name: f.name, species: f.species, advantage: f.advantages?.id || null, status: f.status, defeatedBy: f.defeatedBy || null, population: f.economy.population, technology: f.tech.level, collapsedTick: f.collapsedTick ?? null, settlements: state.settlements.filter(h => h.factionId === f.id).map(h => ({ id: h.id, population: h.population, status: h.status, health: h.health, occupiedBy: h.occupiedBy || null, shortageCycles: h.shortageDays, missing: h.missingResources || [], ruinReason: h.ruinReason || null, defeatedBy: h.defeatedBy || null })) })),
    factionsAlive: state.factions.filter(f => state.settlements.some(h => h.factionId === f.id && h.population > 0)).length,
    techLevels: state.factions.map(f => f.tech.level),
    stats: { ...state.stats },
    conflict: {
      contacts: state.stats.contacts || 0,
      mobilisations: state.stats.mobilisations || 0,
      battles: state.stats.battles || 0,
      attacks: state.stats.attacks || 0,
      projectiles: state.stats.projectiles || 0,
      towerShots: state.stats.towerShots || 0,
      combatDeaths: state.stats.combatDeaths || 0,
      retreats: state.stats.retreats || 0,
      raids: state.stats.raids || 0,
      sieges: state.stats.sieges || 0,
      breaches: state.stats.breaches || 0,
      captures: state.stats.captures || 0,
      capitulations: state.stats.capitulations || 0,
      surrenders: state.stats.surrenders || 0,
      structuresDestroyed: state.stats.structuresDestroyed || 0,
      structureDamage: state.stats.structureDamage || 0,
    },
    deathCauses: {
      combat: state.stats.combatDeaths || 0,
      workerColonistFieldAttrition: state.stats.fieldDeaths || 0,
      strategicFieldAttrition: state.stats.strategicFieldDeaths || 0,
      homeScarcity: state.stats.homeScarcityDeaths || 0,
      unclassified: state.stats.deaths - (state.stats.combatDeaths || 0) - (state.stats.fieldDeaths || 0) - (state.stats.strategicFieldDeaths || 0) - (state.stats.homeScarcityDeaths || 0),
    },
    military: Object.fromEntries(MILITARY_ROLES.map(role => [role, state.settlements.reduce((sum, home) => sum + (home.military?.[role] || 0), 0)])),
    trainees: state.settlements.reduce((sum, home) => sum + trainingCount(home), 0),
    defenses: Object.fromEntries(['wall', 'gate', 'tower'].map(kind => [kind, state.settlements.reduce((sum, home) => sum + home.buildings.filter(b => b.kind === kind && b.progress >= 1 && !b.destroyed && b.hp > 0).length, 0)])),
    training: Object.fromEntries(RESOURCES.map(k => [k, state.resourceLedger[k].training || 0])),
    stock: inventory(state, false),
    ledgerResidual: ledgerResidual(state),
    extracted: Object.fromEntries(RESOURCES.map(k => [k, state.resourceLedger[k].extracted])),
    consumed: Object.fromEntries(RESOURCES.map(k => [k, state.resourceLedger[k].consumed])),
    construction: Object.fromEntries(RESOURCES.map(k => [k, state.resourceLedger[k].construction])),
    research: Object.fromEntries(RESOURCES.map(k => [k, state.resourceLedger[k].research])),
    produced: Object.fromEntries(RESOURCES.map(k => [k, state.resourceLedger[k].produced])),
  };
}

export function runBalance(seed, cycles = 5000, interval = 10, options = {}, onComplete = null) {
  assert.ok(Number.isInteger(cycles) && cycles > 0, 'cycles must be a positive integer');
  assert.ok(Number.isInteger(interval) && interval > 0, 'audit interval must be a positive integer');
  const started = performance.now();
  const state = createSimulation(seed, options);
  const initialPopulation = population(state);
  const checkpoints = [snapshot(state)];
  const wanted = new Set([100, 300, 500, 600, 900, 1200, 1600, 2000, 2400, 3000, 4000, cycles, ...Array.from({ length: Math.floor(cycles / 200) }, (_, i) => (i + 1) * 200)]);
  const seenEvents = new Set();
  const events = {}, firstEventCycles = {};
  const maximum = { population: population(state), colonies: state.settlements.length, groups: 0, workerIndividuals: 0, armyIndividuals: 0, armySize: 0, armyGroups: 0 };
  const abort = error => {
    if (onComplete) onComplete(state);
    error.auditPartial = { completedCycles: state.tick, maximum: { ...maximum }, events: { ...events }, firstEventCycles: { ...firstEventCycles }, checkpoints: [...checkpoints, snapshot(state)] };
    throw error;
  };
  const verify = () => {
    try {
      auditState(state);
      assert.equal(population(state), initialPopulation + state.stats.births - state.stats.deaths, `${seed} cycle ${state.tick}: unexplained population creation or loss`);
    } catch (error) { abort(error); }
  };
  verify();
  while (state.tick < cycles && !(options.stopAtVictory && state.outcome?.status === 'victory')) {
    try { stepSimulation(state, Math.min(interval, cycles - state.tick) * 10); } catch (error) { abort(error); }
    verify();
    for (const event of state.events) if (!seenEvents.has(event.id)) {
      seenEvents.add(event.id);
      events[event.type] = (events[event.type] || 0) + 1;
      firstEventCycles[event.type] ??= event.tick;
    }
    maximum.population = Math.max(maximum.population, population(state));
    maximum.colonies = Math.max(maximum.colonies, state.settlements.filter(h => h.population > 0 && !['ruin', 'camp'].includes(h.status)).length);
    maximum.groups = Math.max(maximum.groups, state.groups.length);
    maximum.workerIndividuals = Math.max(maximum.workerIndividuals, state.groups.filter(g => g.kind === 'worker').reduce((sum, g) => sum + g.size, 0));
    const armies = state.groups.filter(g => g.kind === 'army');
    maximum.armyGroups = Math.max(maximum.armyGroups, armies.length);
    maximum.armyIndividuals = Math.max(maximum.armyIndividuals, armies.reduce((sum, g) => sum + g.size, 0));
    maximum.armySize = Math.max(maximum.armySize, ...armies.map(g => g.size), 0);
    if (wanted.has(state.tick)) checkpoints.push(snapshot(state));
  }
  if (checkpoints.at(-1)?.cycle !== state.tick) checkpoints.push(snapshot(state));
  if (onComplete) onComplete(state);
  const winner = state.factions.find(f => f.id === state.outcome?.winnerId);
  const victory = winner ? { winnerId: winner.id, name: winner.name, species: winner.species, advantage: winner.advantages?.id || null, wonAt: state.outcome.wonAt, tick: state.outcome.tick, nominalWallSecondsAt2x: state.outcome.wonAt / 2, withinTarget600To1200Cycles: state.outcome.wonAt >= 600 && state.outcome.wonAt <= 1200 } : null;
  return { seed, civCount: state.factions.length, cycles, completedCycles: state.tick, stoppedAtVictory: !!(options.stopAtVictory && victory), victory, elapsedMs: Math.round(performance.now() - started), auditEveryCycles: interval, maximum, events, firstEventCycles, checkpoints };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cycles = Number(process.env.BALANCE_CYCLES || 5000);
  const interval = Number(process.env.BALANCE_INTERVAL || 10);
  const options = { ...(process.env.BALANCE_CIVS == null ? {} : { civCount: Number(process.env.BALANCE_CIVS) }), stopAtVictory: process.env.BALANCE_STOP_AT_VICTORY === '1' };
  const seeds = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_SEEDS;
  for (const seed of seeds) {
    try {
      const saveState = process.env.BALANCE_STATE_DIR ? state => { mkdirSync(process.env.BALANCE_STATE_DIR, { recursive: true }); writeFileSync(path.join(process.env.BALANCE_STATE_DIR, `${String(seed).replace(/[^a-z0-9_-]/gi, '_')}-civs${state.factions.length}-cycle${state.tick}.json`), JSON.stringify(state)); } : null;
      console.log(JSON.stringify({ ok: true, ...runBalance(seed, cycles, interval, options, saveState) }));
    }
    catch (error) { console.error(JSON.stringify({ ok: false, seed, error: error.stack })); process.exitCode = 1; }
  }
}
