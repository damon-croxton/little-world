import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createSimulation, stepSimulation } from '../src/sim/core.js';
import { getSoldier, getSoldiers, isServingSoldier, soldierCounts } from '../src/sim/soldiers.js';
import { auditState, population } from './balance.mjs';

// Independent census check: none of the expected totals come from the roster
// synchronizer. Historical object references also detect replacement/resurrection.
export function auditIndividualState(state, history = new Map()) {
  const ids = new Set(), deployed = new Set();
  let serving = 0, retained = 0, dead = 0, demobilized = 0, wounded = 0, withdrawing = 0, withdrawingDeployed = 0;
  const label = `${state.seed} cycle ${state.tick}`;
  for (const home of state.settlements) {
    assert.ok(Array.isArray(home.soldierRoster), `${label}: missing canonical roster ${home.id}`);
    const counts = { infantry: 0, ranged: 0 };
    for (const soldier of home.soldierRoster) {
      retained++;
      assert.ok(soldier.id && !ids.has(soldier.id), `${label}: duplicate soldier ${soldier.id}`); ids.add(soldier.id);
      assert.equal(getSoldier(state, soldier.id), soldier, `${label}: noncanonical lookup ${soldier.id}`);
      assert.equal(soldier.originId, home.id); assert.equal(soldier.nativeFactionId, home.factionId);
      assert.equal(soldier.factionId, home.factionId);
      assert.equal(soldier.species, state.factions.find(f => f.id === home.factionId).species);
      assert.ok(['infantry', 'ranged'].includes(soldier.role));
      assert.ok(Number.isFinite(soldier.hp) && soldier.hp >= 0 && soldier.hp <= soldier.maxHp);
      for (const key of ['x', 'z', 'prevX', 'prevZ', 'attackReadyAt']) assert.ok(Number.isFinite(soldier[key]), `${label}: invalid ${soldier.id}.${key}`);
      const previous = history.get(soldier.id);
      if (previous) {
        assert.equal(soldier, previous.record, `${label}: replaced persistent record ${soldier.id}`);
        assert.equal(soldier.role, previous.role, `${label}: reassigned a soldier's role ${soldier.id}`);
        if (previous.terminal) assert.equal(soldier.status, previous.terminal, `${label}: resurrected retired record ${soldier.id}`);
      }
      if (isServingSoldier(soldier)) {
        serving++; counts[soldier.role]++;
        if (soldier.hp < soldier.maxHp) wounded++;
        if (soldier.withdrawing) { withdrawing++; if (soldier.groupId != null) withdrawingDeployed++; }
        if (soldier.groupId != null) {
          const group = state.groups.find(g => g.id === soldier.groupId);
          assert.ok(group && group.kind === 'army' && !group.finished && !group.militaryReturned, `${label}: orphan serving soldier ${soldier.id}/${soldier.groupId}`);
          assert.equal(group.originId, home.id); assert.ok(group.soldierIds.includes(soldier.id));
        }
      } else if (soldier.status === 'dead') {
        dead++; assert.equal(soldier.alive, false); assert.equal(soldier.hp, 0);
      } else { demobilized++; assert.equal(soldier.status, 'demobilized', `${label}: unknown terminal status ${soldier.id}`); }
      history.set(soldier.id, { record: soldier, role: soldier.role, terminal: isServingSoldier(soldier) ? null : soldier.status });
    }
    assert.deepEqual(counts, home.military, `${label}: home roles disagree with retained serving identities ${home.id}`);
    assert.equal(counts.infantry + counts.ranged, home.soldiers);
    assert.ok(home.soldiers <= home.population);
  }
  for (const [id] of history) assert.ok(ids.has(id), `${label}: deleted military history ${id}`);
  for (const group of state.groups) {
    if (group.kind !== 'army' || group.finished || group.militaryReturned) continue;
    assert.ok(Array.isArray(group.soldierIds), `${label}: army lacks exact membership ${group.id}`);
    assert.equal(new Set(group.soldierIds).size, group.soldierIds.length, `${label}: duplicate army membership ${group.id}`);
    const records = getSoldiers(state, group);
    assert.equal(records.length, group.size, `${label}: army census ${group.id}`);
    assert.deepEqual(soldierCounts(records), group.units, `${label}: army role census ${group.id}`);
    for (const soldier of records) {
      assert.ok(!deployed.has(soldier.id), `${label}: soldier deployed twice ${soldier.id}`); deployed.add(soldier.id);
      assert.equal(soldier.groupId, group.id); assert.equal(getSoldier(state, soldier.id), soldier);
    }
    for (const slot of Object.values(group.formationSlots || {}).flat()) {
      if (isServingSoldier(slot)) assert.equal(getSoldier(state, slot.id), slot, `${label}: formation keeps a second soldier copy ${slot.id}`);
    }
  }
  return { serving, retained, dead, demobilized, wounded, withdrawing, withdrawingDeployed, withdrawingHome: withdrawing - withdrawingDeployed, deployed: deployed.size };
}

const percentile = (values, fraction) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))] : null;
const measureCounts = state => ({ population: population(state), soldiers: state.settlements.reduce((n, home) => n + home.soldiers, 0),
  armies: state.groups.filter(group => group.kind === 'army').length, groups: state.groups.length,
  activeCombatants: [...state.groups.filter(group => group.kind === 'army' && group.combat?.active), ...state.settlements.filter(home => home.combat?.active)]
    .reduce((n, entity) => n + getSoldiers(state, entity, { excludeTowerCrew: 'population' in entity }).length, 0) });
const armyPhases = state => state.groups.filter(group => group.kind === 'army').reduce((counts, group) => { counts[group.phase] = (counts[group.phase] || 0) + 1; return counts; }, {});

export function runWorldIndividualAudit(seed, { cycles = 1200, civCount = 4, auditEveryCycles = 10, onCheckpoint = null } = {}) {
  assert.ok(Number.isInteger(cycles) && cycles > 0); assert.ok(Number.isInteger(auditEveryCycles) && auditEveryCycles > 0);
  const state = createSimulation(seed, { civCount }), initial = population(state), history = new Map();
  const batches = [], singlePulses = [], checkpoints = [], peak = measureCounts(state), started = performance.now();
  const verify = () => {
    try {
      auditState(state); auditIndividualState(state, history);
      assert.equal(population(state), initial + state.stats.births - state.stats.deaths, `${seed}: unexplained population change`);
    } catch (error) {
      error.auditPartial = { completedCycles: state.tick, elapsedMs: performance.now() - started, peak, checkpoints, countsAtFailure: measureCounts(state), armyPhases: armyPhases(state), stats: { ...state.stats } };
      throw error;
    }
  };
  verify();
  const sampleCycles = new Set([100, 2000, 5000, cycles, ...Array.from({ length: Math.floor(cycles / 300) }, (_, i) => (i + 1) * 300)]);
  while (state.tick < cycles) {
    const next = Math.min(cycles, state.tick + auditEveryCycles), pulses = (next - state.tick) * 10;
    if (sampleCycles.has(next)) {
      const local = [];
      for (let i = 0; i < pulses; i++) { const start = performance.now(); stepSimulation(state, 1); local.push(performance.now() - start); }
      singlePulses.push(...local);
      checkpoints.push({ cycle: state.tick, ...measureCounts(state), armyPhases: armyPhases(state), roster: auditIndividualState(state, history), singlePulseSamples: local.length, singlePulseMedianMs: percentile(local, .5), singlePulseP95Ms: percentile(local, .95),
        captures: state.stats.captures || 0, combatDeaths: state.stats.combatDeaths || 0, trained: state.stats.trained || 0 });
      onCheckpoint?.(checkpoints.at(-1));
    } else {
      const start = performance.now(); stepSimulation(state, pulses); batches.push((performance.now() - start) / pulses);
    }
    verify();
    for (const [key, value] of Object.entries(measureCounts(state))) peak[key] = Math.max(peak[key], value);
  }
  return { seed, cycles: state.tick, civCount, auditEveryCycles, stopAtVictory: false, elapsedMs: performance.now() - started, peak, checkpoints,
    roster: auditIndividualState(state, history), outcome: state.outcome, stats: { ...state.stats },
    batchAverageMsPerPulse: { samples: batches.length, median: percentile(batches, .5), p95: percentile(batches, .95), description: 'Percentiles of each batch duration divided by pulses; these are not single-pulse percentiles.' },
    singlePulseMs: { samples: singlePulses.length, median: percentile(singlePulses, .5), p95: percentile(singlePulses, .95), description: 'Individually timed pulses in the listed checkpoint windows.' },
    timingScope: 'Node simulation only, including stepSimulation setup. Audit costs excluded from pulse samples. Run without competing CPU work for performance comparison; no browser claims.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const seeds = process.argv.slice(2).length ? process.argv.slice(2) : ['first-light', 'tidal-garden', 'iron-valley'];
  const cycles = Number(process.env.WORLD_INDIVIDUAL_CYCLES || 1200), civCount = Number(process.env.WORLD_INDIVIDUAL_CIVS || 4);
  const sourceHash = () => {
    const digest = createHash('sha256');
    for (const name of readdirSync('src', { recursive: true }).filter(name => /\.js$/.test(name)).sort()) digest.update(name).update('\0').update(readFileSync(path.join('src', name)));
    return digest.digest('hex');
  };
  const results = [], sourceSha256 = sourceHash(), startedAt = new Date().toISOString();
  for (const seed of seeds) {
    try { const result = { ok: true, ...runWorldIndividualAudit(seed, { cycles, civCount, onCheckpoint: checkpoint => console.log(JSON.stringify({ type: 'checkpoint', seed, ...checkpoint })) }) }; results.push(result); console.log(JSON.stringify(result)); }
    catch (error) { const result = { ok: false, seed, cycles, ...error.auditPartial, error: error.stack }; results.push(result); console.error(JSON.stringify(result)); process.exitCode = 1; }
    if (process.env.WORLD_INDIVIDUAL_REPORT) {
      const finalSourceSha256 = sourceHash(); mkdirSync(path.dirname(process.env.WORLD_INDIVIDUAL_REPORT), { recursive: true });
      writeFileSync(process.env.WORLD_INDIVIDUAL_REPORT, JSON.stringify({ runtime: process.version, startedAt, completedAt: new Date().toISOString(), sourceSha256, finalSourceSha256, sourceUnchangedDuringAudit: sourceSha256 === finalSourceSha256, results }, null, 2));
    }
  }
}
