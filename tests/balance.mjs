import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createSimulation, stepSimulation } from '../src/sim/core.js';
import { inventory, ledgerResidual, RESOURCES } from '../src/sim/economy.js';

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
  for (const node of state.nodes) {
    addId(node.id, 'node');
    assert.ok(node.amount >= -1e-8 && node.amount <= node.maxAmount + 1e-8, `${label}: deposit ${node.id} amount=${node.amount}/${node.maxAmount}`);
  }
  for (const home of state.settlements) {
    addId(home.id, 'settlement');
    assert.ok(Number.isInteger(home.population) && home.population >= 0, `${label}: invalid population ${home.id}=${home.population}`);
    assert.ok(Number.isInteger(home.soldiers) && home.soldiers >= 0 && home.soldiers <= home.population, `${label}: invalid soldiers ${home.id}=${home.soldiers}/${home.population}`);
    const deployed = state.groups.filter(g => g.originId === home.id && !g.finished).reduce((sum, g) => sum + g.size, 0);
    assert.ok(deployed <= home.population, `${label}: ghost individuals ${home.id}: deployed ${deployed} > population ${home.population}`);
    const army = state.groups.filter(g => g.originId === home.id && g.kind === 'army' && !g.finished).reduce((sum, g) => sum + g.size, 0);
    assert.ok(army <= home.soldiers, `${label}: deployed soldiers ${home.id} ${army} > ${home.soldiers}`);
    for (const kind of RESOURCES) assert.ok(home.stock[kind] >= -1e-8 && home.stock[kind] <= home.capacity + 1e-8, `${label}: ${home.id} ${kind} stock=${home.stock[kind]}/${home.capacity}`);
    for (const building of home.buildings || []) {
      assert.ok(building.progress >= 0 && building.progress <= 1, `${label}: building ${building.id} progress ${building.progress}`);
      assert.ok(Math.abs(building.x) <= 150 && Math.abs(building.z) <= 150, `${label}: building out of world ${building.id}`);
    }
  }
  for (const group of state.groups) {
    addId(group.id, 'group');
    assert.ok(Number.isInteger(group.size) && group.size > 0, `${label}: invalid group size ${group.id}=${group.size}`);
    const home = state.settlements.find(h => h.id === group.originId);
    assert.ok(home, `${label}: orphan group ${group.id}/${group.originId}`);
    assert.equal(group.factionId, home.factionId, `${label}: group ${group.id} ownership differs from origin`);
    assert.ok(Math.abs(group.x) <= 150 && Math.abs(group.z) <= 150, `${label}: group ${group.id} outside world`);
    for (const kind of RESOURCES) assert.ok((group.carrying?.[kind] || 0) >= -1e-8, `${label}: negative cargo ${group.id}/${kind}`);
    if (group.kind === 'worker' && !group.refugees) {
      const cargo = RESOURCES.reduce((sum, kind) => sum + (group.carrying?.[kind] || 0), 0);
      assert.ok(cargo <= group.capacity + 1e-7, `${label}: overloaded worker ${group.id} cargo=${cargo}/${group.capacity}`);
    }
    if (group.kind === 'army' && group.intelligence) {
      assert.ok(group.intelligence.observedTick <= group.intelligence.reportedTick && group.intelligence.reportedTick <= group.createdTick, `${label}: army ${group.id} preceded its report`);
    }
  }
  for (const event of state.events) if (event.type === 'mobilize') {
    assert.ok(Number.isFinite(event.reportTick) && event.observationTick <= event.reportTick && event.reportTick <= event.tick, `${label}: mobilisation lacks prior returned report ${event.id}`);
  }
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
  const assigned = state.settlements.reduce((sum, h) => sum + ['civilianAway', 'military', 'researchers', 'construction', 'infrastructure'].reduce((n, key) => n + (h.assigned?.[key] || 0), 0), 0);
  return {
    cycle: state.tick,
    population: totalPopulation,
    colonies: living.length,
    sites: state.settlements.length,
    groups: state.groups.length,
    workerIndividuals,
    assigned,
    largestColony: Math.max(...living.map(h => h.population), 0),
    largestRadius: Math.max(...living.map(h => h.radius || 0), 0),
    buildings: state.settlements.reduce((sum, h) => sum + (h.buildings?.length || 0), 0),
    completedBuildings: state.settlements.reduce((sum, h) => sum + (h.buildings?.filter(b => b.progress >= 1).length || 0), 0),
    factionsAlive: state.factions.filter(f => state.settlements.some(h => h.factionId === f.id && h.population > 0)).length,
    techLevels: state.factions.map(f => f.tech.level),
    stats: { ...state.stats },
    stock: inventory(state, false),
    ledgerResidual: ledgerResidual(state),
    extracted: Object.fromEntries(RESOURCES.map(k => [k, state.resourceLedger[k].extracted])),
    produced: Object.fromEntries(RESOURCES.map(k => [k, state.resourceLedger[k].produced])),
  };
}

export function runBalance(seed, cycles = 5000, interval = 10) {
  const started = performance.now();
  const state = createSimulation(seed);
  const initialPopulation = population(state);
  const checkpoints = [snapshot(state)];
  const wanted = new Set([100, 500, 1200, 2400, 4000, cycles]);
  const seenEvents = new Set();
  const events = {};
  const maximum = { population: population(state), colonies: state.settlements.length, groups: 0, workerIndividuals: 0, armyIndividuals: 0, armySize: 0, armyGroups: 0 };
  auditState(state);
  while (state.tick < cycles) {
    stepSimulation(state, Math.min(interval, cycles - state.tick) * 10);
    auditState(state);
    assert.equal(population(state), initialPopulation + state.stats.births - state.stats.deaths, `${seed} cycle ${state.tick}: unexplained population creation or loss`);
    for (const event of state.events) if (!seenEvents.has(event.id)) {
      seenEvents.add(event.id);
      events[event.type] = (events[event.type] || 0) + 1;
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
  return { seed, cycles, elapsedMs: Math.round(performance.now() - started), auditEveryCycles: interval, maximum, events, checkpoints };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cycles = Number(process.env.BALANCE_CYCLES || 5000);
  const interval = Number(process.env.BALANCE_INTERVAL || 10);
  const seeds = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_SEEDS;
  for (const seed of seeds) {
    try { console.log(JSON.stringify({ ok: true, ...runBalance(seed, cycles, interval) })); }
    catch (error) { console.error(JSON.stringify({ ok: false, seed, error: error.stack })); process.exitCode = 1; }
  }
}
