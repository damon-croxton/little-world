import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createBattle, stepBattle, battleSummary } from '../src/battle/sim.js';

// Run this separately from node --test. These are ordinary seeded battles:
// no edited HP, placements, terrain, orders, or stop-at-first-victory shortcut.
export const BATTLE_AUDIT_SEEDS = ['crossing', 'redoubt', 'switchback', 'sandstone', 'last-light'];
const EPSILON = 1e-7;
const rounded = value => Math.round(value * 1000) / 1000;
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const briefUnit = unit => ({ id: unit.id, team: unit.team, role: unit.role,
  x: rounded(unit.x), z: rounded(unit.z), hp: unit.hp, maxHp: unit.maxHp,
  alive: unit.alive, action: unit.action, reason: unit.reason, targetId: unit.targetId,
  reasonCode: unit.reasonCode, withdrawing: unit.withdrawing, attackReadyAt: rounded(unit.attackReadyAt) });

function remember(examples, key, example, limit = 3) {
  if (examples[key].length < limit) examples[key].push(example);
}

export function auditNaturalBattle(seed, { seconds = 120, dt = .1, perSide = 24 } = {}) {
  assert.ok(seconds > 0 && seconds <= 120, 'natural audit must remain within 120 simulated seconds');
  const started = performance.now();
  const state = createBattle(seed, { perSide });
  const unitsById = new Map(state.units.map(unit => [unit.id, unit]));
  assert.equal(unitsById.size, perSide * 2, 'stable individual IDs must be unique');
  const originalReferences = new Map(unitsById);
  const ledger = new Map(state.units.map(unit => [unit.id, unit.hp]));
  const initialUnits = new Map(state.units.map(unit => [unit.id, briefUnit(unit)]));
  const damageByTarget = new Map(), lastShot = new Map(), deathEvents = new Set();
  const shotsById = new Map(), resolvedShots = new Set();
  const targetChanges = new Map(), actionCounts = {}, reasonCounts = {};
  const concurrency = { maximumShotsInOnePulse: 0, maximumShootersPerTeam: { blue: 0, red: 0 },
    maximumTargetsInOnePulse: 0, peakExample: null };
  const examples = { damage: [], withdrawalWithPeer: [], spacing: [], focusFire: [],
    pursuit: [], feasibleIntercept: [], retreatHit: [], retreatDeath: [], targetChanges: [] };
  const counts = { shots: 0, impacts: 0, misses: 0, deaths: 0, decisions: 0, targetChanges: 0,
    withdrawalWithPeerFrames: 0, spacingFrames: 0, focusFireFrames: 0,
    pursuitFrames: 0, feasibleInterceptDecisions: 0, retreatHits: 0, retreatDeaths: 0 };
  const checkpoints = [], casualtyTimeline = [];
  let eventCursor = state.events.length;
  let previousEventId = eventCursor ? state.events.at(-1).id : null;
  const iterations = Math.ceil(seconds / dt);
  for (let tick = 0; tick < iterations; tick++) {
    const before = new Map(state.units.map(unit => [unit.id, { hp: unit.hp,
      x: unit.x, z: unit.z, withdrawing: unit.withdrawing, action: unit.action }]));
    stepBattle(state, dt);
    assert.equal(state.units.length, originalReferences.size, `${seed}: units disappeared or were synthesized`);
    for (const unit of state.units) {
      assert.equal(originalReferences.get(unit.id), unit, `${seed}: individual ${unit.id} was replaced`);
      assert.ok(Number.isFinite(unit.x) && Number.isFinite(unit.z) && Number.isFinite(unit.hp), `${seed}: nonfinite unit ${unit.id}`);
      assert.ok(unit.hp >= 0 && unit.hp <= unit.maxHp, `${seed}: invalid HP ${unit.id}`);
      assert.equal(unit.alive, unit.hp > 0, `${seed}: life state disagrees with HP ${unit.id}`);
      if (!before.get(unit.id).hp) {
        assert.equal(unit.hp, 0, `${seed}: dead individual ${unit.id} was revived`);
        assert.equal(unit.x, before.get(unit.id).x, `${seed}: casualty ${unit.id} moved`);
        assert.equal(unit.z, before.get(unit.id).z, `${seed}: casualty ${unit.id} moved`);
      }
    }
    assert.ok(state.events.length >= eventCursor, `${seed}: combat ledger was truncated`);
    const frameShots = [];
    for (const event of state.events.slice(eventCursor)) {
      assert.ok(event.id != null, `${seed}: event lacks a stable ID`);
      if (previousEventId != null) assert.ok(event.id > previousEventId, `${seed}: event IDs are not monotonic`);
      previousEventId = event.id;
      const source = unitsById.get(event.sourceId ?? event.unitId);
      const target = unitsById.get(event.targetId);
      if (event.type === 'shot') {
        counts.shots++;
        assert.ok(source && target, `${seed}: shot has unknown source or target`);
        assert.ok(event.shotId != null && !shotsById.has(event.shotId), `${seed}: shot ID is missing or reused`);
        shotsById.set(event.shotId, event);
        assert.notEqual(source.team, target.team, `${seed}: friendly strike ${source.id} -> ${target.id}`);
        assert.ok(ledger.get(source.id) > 0 && ledger.get(target.id) > 0, `${seed}: a dead individual attacked or was selected for a new shot`);
        // Units finish movement before launch; shot.targetX/Z is the ballistic
        // lead point, while this frame's individual position is its launch range.
        assert.ok(Math.hypot(target.x - event.sourceX, target.z - event.sourceZ) <= source.attackRange + EPSILON,
          `${seed}: ${source.id} attacked beyond its individual weapon range`);
        const prior = lastShot.get(source.id);
        if (prior != null) assert.ok(event.time - prior + EPSILON >= source.attackCooldown,
          `${seed}: ${source.id} fired at ${event.time} only ${event.time - prior}s after prior shot; cooldown ${source.attackCooldown}`);
        lastShot.set(source.id, event.time);
        frameShots.push(event);
      } else if (event.type === 'impact') {
        counts.impacts++;
        assert.ok(source && target, `${seed}: impact has unknown source or target`);
        assert.notEqual(source.team, target.team, `${seed}: friendly impact`);
        const shot = shotsById.get(event.shotId);
        assert.ok(shot && shot.sourceId === source.id && shot.targetId === target.id,
          `${seed}: impact does not match an actual shot at the same individual`);
        assert.ok(!resolvedShots.has(event.shotId), `${seed}: one shot damaged more than once`);
        resolvedShots.add(event.shotId);
        assert.ok(event.time + EPSILON >= shot.time + shot.duration, `${seed}: impact preceded weapon travel time`);
        assert.equal(event.damage, Math.min(shot.damage, event.hpBefore), `${seed}: impact changed the individual's weapon damage`);
        assert.ok(event.damage > 0, `${seed}: nonpositive damage event`);
        assert.ok(Math.abs(ledger.get(target.id) - event.hpBefore) < EPSILON,
          `${seed}: HP ledger mismatch before impact on ${target.id}`);
        assert.ok(Math.abs(event.hpBefore - event.hpAfter - event.damage) < EPSILON,
          `${seed}: actual damage does not match exact HP change on ${target.id}`);
        assert.ok(event.hpAfter >= 0, `${seed}: impact exceeded remaining HP`);
        ledger.set(target.id, event.hpAfter);
        damageByTarget.set(target.id, (damageByTarget.get(target.id) || 0) + event.damage);
        remember(examples, 'damage', { time: event.time, sourceId: source.id,
          targetId: target.id, damage: event.damage, hpBefore: event.hpBefore, hpAfter: event.hpAfter });
        if (event.targetAction === 'withdraw') {
          counts.retreatHits++;
          remember(examples, 'retreatHit', { ...event, unit: briefUnit(target) });
        }
      } else if (event.type === 'miss') {
        counts.misses++;
        assert.equal(event.damage, 0, `${seed}: missed projectile inflicted damage`);
        const shot = shotsById.get(event.shotId);
        assert.ok(shot?.projectile && shot.sourceId === event.sourceId && shot.targetId === event.targetId,
          `${seed}: miss does not match an actual projectile at the same individual`);
        assert.ok(!resolvedShots.has(event.shotId), `${seed}: one shot resolved more than once`);
        resolvedShots.add(event.shotId);
      } else if (event.type === 'death') {
        const dead = unitsById.get(event.targetId ?? event.unitId);
        assert.ok(dead, `${seed}: death refers to no individual`);
        assert.ok(!deathEvents.has(dead.id), `${seed}: duplicate death for ${dead.id}`);
        assert.equal(ledger.get(dead.id), 0, `${seed}: death before exact HP reaches zero`);
        deathEvents.add(dead.id); counts.deaths++;
        casualtyTimeline.push({ time: event.time, id: dead.id, team: dead.team,
          role: dead.role, sourceId: event.sourceId, x: rounded(dead.x), z: rounded(dead.z) });
        if (event.targetAction === 'withdraw' || event.previousAction === 'withdraw') {
          counts.retreatDeaths++;
          remember(examples, 'retreatDeath', { ...event, unit: briefUnit(dead) });
        }
      } else if (event.type === 'decision') {
        counts.decisions++;
        assert.ok(typeof event.reason === 'string' && event.reason.length, `${seed}: decision lacks a reason`);
        reasonCounts[event.reason] = (reasonCounts[event.reason] || 0) + 1;
        if (event.intercept) {
          assert.ok(source && target, `${seed}: predicted interception lacks an individual`);
          const prediction = event.intercept;
          assert.ok(prediction.time > 0 && prediction.time <= 3, `${seed}: prediction exceeds its bounded horizon`);
          assert.ok(Math.abs(prediction.x - event.targetX - event.targetVX * prediction.time) < EPSILON &&
            Math.abs(prediction.z - event.targetZ - event.targetVZ * prediction.time) < EPSILON,
          `${seed}: interception point does not project the observed velocity`);
          assert.ok(Math.hypot(prediction.x - event.sourceX, prediction.z - event.sourceZ) <=
            event.pursuerSpeed * prediction.time + source.attackRange + EPSILON,
          `${seed}: soldier cannot physically reach the claimed interception`);
          counts.feasibleInterceptDecisions++;
          remember(examples, 'feasibleIntercept', { ...event, verifiedReach: rounded(event.pursuerSpeed * prediction.time + source.attackRange) });
        }
        if (event.oldTargetId !== event.targetId) {
          counts.targetChanges++;
          assert.ok(source, `${seed}: target change has no individual`);
          assert.notEqual(event.reason, 'keep-target', `${seed}: target changed while its decision claimed continuity`);
          if (event.targetId != null) {
            assert.ok(target, `${seed}: target change names unknown individual`);
            assert.notEqual(source.team, target.team, `${seed}: individual selected friendly target`);
          }
          targetChanges.set(source.id, (targetChanges.get(source.id) || 0) + 1);
          remember(examples, 'targetChanges', { ...event, unit: briefUnit(source) }, 12);
        }
      }
    }
    eventCursor = state.events.length;
    for (const unit of state.units) {
      assert.ok(Math.abs(unit.hp - ledger.get(unit.id)) < EPSILON,
        `${seed}: ${unit.id} HP changed without an exact impact ledger entry`);
      assert.equal(!unit.alive, deathEvents.has(unit.id), `${seed}: casualty/death ledger mismatch ${unit.id}`);
      if (!unit.alive) continue;
      actionCounts[unit.action] = (actionCounts[unit.action] || 0) + 1;
      if (unit.withdrawing && unit.hp < unit.maxHp) {
        const peer = state.units.find(other => other.alive && other.team === unit.team && !other.withdrawing &&
          other.hp / other.maxHp >= .5 && unitsById.get(other.targetId)?.alive &&
          ['attack', 'pursue', 'space', 'intercept'].includes(other.action) && distance(unit, other) < 12);
        if (peer) {
          counts.withdrawalWithPeerFrames++;
          remember(examples, 'withdrawalWithPeer', { time: state.time, wounded: briefUnit(unit), fightingPeer: briefUnit(peer) });
        }
      }
      if (unit.role === 'ranged' && (unit.action === 'space' || unit.reasonCode === 'ranged-spacing')) {
        counts.spacingFrames++;
        remember(examples, 'spacing', { time: state.time, unit: briefUnit(unit), target: unitsById.has(unit.targetId) ? briefUnit(unitsById.get(unit.targetId)) : null });
      }
      if (unit.action === 'pursue' || unit.action === 'intercept') {
        counts.pursuitFrames++;
        remember(examples, 'pursuit', { time: state.time, unit: briefUnit(unit), target: unitsById.has(unit.targetId) ? briefUnit(unitsById.get(unit.targetId)) : null });
      }
    }
    const targetShooters = new Map();
    if (frameShots.length > concurrency.maximumShotsInOnePulse) {
      concurrency.maximumShotsInOnePulse = frameShots.length;
      const xs = frameShots.map(event => event.sourceX), zs = frameShots.map(event => event.sourceZ);
      concurrency.peakExample = { time: state.time, shots: frameShots.map(event => ({ sourceId: event.sourceId,
        targetId: event.targetId, role: event.role, x: rounded(event.sourceX), z: rounded(event.sourceZ) })),
      shooterSpan: { x: rounded(Math.max(...xs) - Math.min(...xs)), z: rounded(Math.max(...zs) - Math.min(...zs)) } };
    }
    concurrency.maximumTargetsInOnePulse = Math.max(concurrency.maximumTargetsInOnePulse,
      new Set(frameShots.map(event => event.targetId)).size);
    for (const team of ['blue', 'red']) concurrency.maximumShootersPerTeam[team] = Math.max(
      concurrency.maximumShootersPerTeam[team], new Set(frameShots.filter(event => unitsById.get(event.sourceId).team === team)
        .map(event => event.sourceId)).size);
    for (const event of frameShots) {
      if (unitsById.get(event.sourceId).role !== 'ranged') continue;
      const key = event.targetId;
      if (!targetShooters.has(key)) targetShooters.set(key, []);
      targetShooters.get(key).push(event.sourceId);
    }
    for (const [targetId, sourceIds] of targetShooters) if (sourceIds.length >= 2) {
      counts.focusFireFrames++;
      remember(examples, 'focusFire', { time: state.time, targetId, sourceIds });
    }
    if (((tick + 1) % Math.round(10 / dt) === 0 || tick === iterations - 1) && checkpoints.at(-1)?.time !== rounded(state.time)) {
      checkpoints.push({ time: rounded(state.time), alive: Object.fromEntries(['blue', 'red'].map(team =>
        [team, state.units.filter(unit => unit.team === team && unit.alive).length])),
      wounded: state.units.filter(unit => unit.alive && unit.hp < unit.maxHp).length,
      withdrawing: state.units.filter(unit => unit.alive && unit.withdrawing).length,
      shots: counts.shots, impacts: counts.impacts, deaths: counts.deaths });
    }
  }
  assert.ok(counts.shots > 0 && counts.impacts > 0 && counts.deaths > 0, `${seed}: natural run never reached lethal combat`);
  const casualtyId = casualtyTimeline[0]?.id;
  const casualty = unitsById.get(casualtyId);
  return { seed, perSide, requestedHorizonSeconds: seconds, simulatedSeconds: rounded(state.time), elapsedMs: rounded(performance.now() - started),
    untouchedNaturalSetup: true, stopAtVictory: false, counts, checkpoints, actionCounts, decisionReasonCounts: reasonCounts,
    targetChangesByUnit: Object.fromEntries(targetChanges), examples, casualtyTimeline, concurrency,
    combatParticipation: Object.fromEntries(['blue', 'red'].map(team => [team, {
      individualsThatFired: [...lastShot.keys()].filter(id => unitsById.get(id).team === team).length,
      initialIndividuals: state.units.filter(unit => unit.team === team).length,
      byRole: Object.fromEntries(['infantry', 'ranged', 'scout'].map(role => [role,
        [...lastShot.keys()].filter(id => unitsById.get(id).team === team && unitsById.get(id).role === role).length])) }])),
    verifiedInvariants: { friendlyShots: 0, friendlyImpacts: 0, cooldownViolations: 0,
      unexplainedHpChanges: 0, duplicateDeaths: 0, replacedIndividualIdentities: 0 },
    selectedCasualtyIdentity: casualty ? { id: casualtyId, initial: initialUnits.get(casualtyId),
      firstDeath: casualtyTimeline[0], final: briefUnit(casualty),
      sameObjectRetained: originalReferences.get(casualtyId) === casualty,
      totalActualDamage: damageByTarget.get(casualtyId),
      impactTrace: state.events.filter(event => event.type === 'impact' && event.targetId === casualtyId).map(event =>
        ({ time: event.time, shotId: event.shotId, sourceId: event.sourceId, targetId: event.targetId,
          damage: event.damage, hpBefore: event.hpBefore, hpAfter: event.hpAfter, targetAction: event.targetAction })) } : null,
    finalSummary: battleSummary(state), metrics: state.metrics };
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

export function benchmarkBattle({ totals = [48, 96, 192], dt = .1, steps = 100, trials = 3 } = {}) {
  return totals.map(total => {
    assert.ok(total <= 384 && total > 0 && total % 2 === 0, 'benchmark population must stay bounded');
    const warmState = createBattle('crossing', { perSide: total / 2 });
    assert.equal(warmState.units.length, total, 'benchmark must actually create the reported population');
    for (let i = 0; i < 100 && !warmState.metrics.shots; i++) stepBattle(warmState, dt);
    assert.ok(warmState.metrics.shots > 0, 'benchmark must reach the opening engagement');
    const timings = [], results = [];
    for (let trial = 0; trial < trials; trial++) {
      const state = structuredClone(warmState);
      const cpuStart = process.cpuUsage(), start = performance.now();
      for (let i = 0; i < steps; i++) {
        const before = performance.now(); stepBattle(state, dt); timings.push(performance.now() - before);
      }
      const wallMs = performance.now() - start, cpu = process.cpuUsage(cpuStart);
      results.push({ wallMs: rounded(wallMs), cpuMs: rounded((cpu.user + cpu.system) / 1000),
        simulatedSeconds: rounded(steps * dt), simulationSecondsPerWallSecond: rounded(steps * dt * 1000 / wallMs),
        finalAlive: state.units.filter(unit => unit.alive).length });
    }
    return { runtime: 'Node CPU simulation only; no browser, rendering, GPU, or FPS measurement',
      totalUnits: total, perSide: total / 2, warmupSimulatedSeconds: rounded(warmState.time),
      aliveAtMeasuredStart: warmState.units.filter(unit => unit.alive).length, stepsPerTrial: steps, trials: results,
      stepMs: { median: rounded(percentile(timings, .5)), p95: rounded(percentile(timings, .95)), max: rounded(Math.max(...timings)) } };
  });
}

export function runBattleAudit({ seeds = BATTLE_AUDIT_SEEDS, benchmark = true } = {}) {
  const source = readFileSync(new URL('../src/battle/sim.js', import.meta.url));
  const report = { kind: 'individual-battle-natural-audit', generatedAt: new Date().toISOString(),
    runtime: process.version, platform: `${process.platform}/${process.arch}`,
    sourceSha256: createHash('sha256').update(source).digest('hex'),
    scope: 'Untouched seeded 24v24 battles, stepped for a requested horizon of 120 simulated seconds (the simulation freezes at a terminal result). Controlled micro tests are separate. CPU measurements are not GPU FPS.',
    battles: seeds.map(seed => auditNaturalBattle(seed)), benchmarks: benchmark ? benchmarkBattle() : [] };
  report.behaviorCoverage = Object.fromEntries(['withdrawalWithPeerFrames', 'spacingFrames', 'focusFireFrames', 'pursuitFrames', 'feasibleInterceptDecisions', 'retreatHits', 'retreatDeaths']
    .map(key => [key, report.battles.reduce((sum, battle) => sum + battle.counts[key], 0)]));
  report.finalSourceSha256 = createHash('sha256').update(readFileSync(new URL('../src/battle/sim.js', import.meta.url))).digest('hex');
  report.sourceUnchangedDuringAudit = report.sourceSha256 === report.finalSourceSha256;
  assert.ok(report.sourceUnchangedDuringAudit, 'simulation source changed during the audit; rerun on a stable revision');
  for (const key of ['withdrawalWithPeerFrames', 'spacingFrames', 'focusFireFrames', 'pursuitFrames', 'feasibleInterceptDecisions', 'retreatHits']) {
    assert.ok(report.behaviorCoverage[key] > 0, `ordinary seeded fights did not demonstrate ${key}`);
  }
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const outputIndex = process.argv.indexOf('--output');
  const report = runBattleAudit({ benchmark: !process.argv.includes('--no-benchmark') });
  if (outputIndex >= 0) {
    assert.ok(process.argv[outputIndex + 1], '--output needs a filename');
    writeFileSync(process.argv[outputIndex + 1], `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ output: process.argv[outputIndex + 1], seeds: report.battles.length,
      behaviorCoverage: report.behaviorCoverage, benchmarks: report.benchmarks }, null, 2));
  } else console.log(JSON.stringify(report, null, 2));
}
