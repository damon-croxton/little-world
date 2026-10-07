import { distance } from '../shared.js';
import { settlementController, groupController } from './control.js';
import { knownReports } from './knowledge.js';
import { getSoldiers } from './soldiers.js';
import { findPath, isSegmentTraversable } from './navigation.js';

const ready = body => !body.withdrawing && body.hp > body.maxHp * .4;
const live = g => !g.finished && !g.disabled && g.size > 0;
const hostile = (f, id) => id && id !== f.id && !['allied', 'trade'].includes(f.relations?.[id]?.status);
const now = s => s.time ?? s.tick;

function defensiveRoles(s, f, homes, groups) {
  for (const home of homes) {
    const crews = groups.filter(g => g.kind === 'worker' && g.phase === 'working' && distance(home, g) < 20);
    const priority = crews.sort((a, b) => b.size - a.size || a.id.localeCompare(b.id))[0];
    const reach = priority ? Math.min(10, distance(home, priority) * .65) : 0;
    const d = priority ? Math.max(1, distance(home, priority)) : 1;
    const post = priority ? { x: home.x + (priority.x - home.x) / d * reach, z: home.z + (priority.z - home.z) / d * reach } : home;
    const clear = isSegmentTraversable(s, home, post, { factionId: f.id, radius: .2 });
    const guarding = getSoldiers(s, home);
    for (const [i, body] of guarding.entries()) {
      const recovery = !ready(body), outer = !recovery && !body.towerId && clear && priority && i % 2 === 0;
      body.order = { role: recovery ? 'recover' : body.towerId ? 'tower-guard' : outer ? 'guard-worksite' : 'home-reserve',
        objectiveId: outer ? priority.targetId || priority.id : home.id, x: outer ? post.x : home.x, z: outer ? post.z : home.z };
    }
  }
}

function recoverProgress(s, f, g, hooks) {
  const objective = `${g.targetId}:${g.operationId || ''}:${g.strategicHold ? 'rally' : 'march'}`;
  const goal = { x: g.targetX, z: g.targetZ };
  if (!Number.isFinite(goal.x) || !Number.isFinite(goal.z)) return;
  const gap = distance(g, goal), previous = g.objectiveProgress;
  if (!previous || previous.objective !== objective) g.objectiveProgress = { objective, bestGap: gap, at: now(s), retries: 0 };
  const progress = g.objectiveProgress;
  const shooting = g.combat?.active && getSoldiers(s, g).some(b => now(s) - (b.lastAttackTime ?? -100) < 4);
  if (gap < progress.bestGap - 1 || shooting || g.strategicHold && gap < 8) { progress.bestGap = gap; progress.at = now(s); }
  if (['returning', 'retreating'].includes(g.phase) || now(s) - progress.at < 16 && (g.stuckTime || 0) < 6) return;
  if (!progress.retries) {
    g.navigation = null; g.stuckTime = 0; progress.retries = 1; progress.at = now(s);
    g.reason = 'The objective has stalled; checking a fresh physical approach once.';
  } else {
    (f.unreachableTargets ||= {})[g.targetId] = s.tick;
    g.strategicHold = null; g.operationId = null;
    hooks.returnHome(s, g, 'No useful progress after a route retry; preserving the force and reassessing another objective.', true);
    s.stats.objectiveRecoveries = (s.stats.objectiveRecoveries || 0) + 1;
  }
}

// One faction plan is reconsidered at most every four simulation cycles. It
// reads owned logistics and dated observations, never remote enemy truth.
export function planStrategy(s, f, homes, hooks) {
  if (f.strategy && s.tick < f.strategy.nextReview) return f.strategy;
  const old = f.strategy, groups = s.groups.filter(g => live(g) && groupController(s, g) === f.id);
  const armies = groups.filter(g => g.kind === 'army');
  defensiveRoles(s, f, homes, groups);
  const reports = knownReports(s, f, { maxAge: 180, minConfidence: .35 });
  const held = new Set(s.settlements.filter(h => settlementController(s, h) === f.id).map(h => h.id));
  const candidates = reports.filter(k => !held.has(k.id) && k.kind === 'settlement' && hostile(f, k.ownerId) && !['camp', 'ruin'].includes(k.status) && s.tick - (f.unreachableTargets?.[k.id] ?? -100) >= 45);
  const distanceHome = k => Math.min(...homes.map(h => distance(h, k)));
  candidates.sort((a, b) => (distanceHome(a) + (a.soldiersEstimate ?? 30) * .7 + (s.tick - a.observedTick) * .12) - (distanceHome(b) + (b.soldiersEstimate ?? 30) * .7 + (s.tick - b.observedTick) * .12));
  const retained = candidates.find(k => k.id === old?.targetId);
  const activeTarget = old?.operation && candidates.find(k => k.id === old.operation.targetId);
  const target = activeTarget || (retained && s.tick - old.chosenAt < 60 ? retained : candidates[0]);
  const recovering = homes.every(h => h.shortageDays > 3 || h.health < 45);
  const resources = reports.filter(k => k.kind === 'resource' && (k.amountEstimate ?? 0) >= 80).sort((a, b) => distanceHome(a) - distanceHome(b));
  const resource = (old && s.tick - old.chosenAt < 60 && resources.find(k => k.id === old.targetId)) || resources[0];
  const mode = recovering ? 'recover' : target ? 'campaign' : homes.some(h => h.population >= 120) && resource ? 'expand' : resource ? 'secure-resources' : 'survey';
  const strategy = f.strategy = { mode, targetId: target?.id ?? resource?.id ?? null, chosenAt: old && old.targetId === (target?.id ?? resource?.id) ? old.chosenAt : s.tick,
    observedTick: target?.observedTick ?? resource?.observedTick ?? null, intelAge: target ? s.tick - target.observedTick : null, nextReview: s.tick + 4,
    operation: old?.operation ?? null, reviews: (old?.reviews || 0) + 1,
    reason: recovering ? 'Restore reliable supplies before new offensives.' : target ? 'Concentrate a supplied force against the selected reported rival.' : resource ? 'Protect harvesting and reserve a viable workforce for surveyed expansion.' : 'Guard the home while scouts find resources and rivals.' };
  if (strategy.operation && (!candidates.some(k => k.id === strategy.operation.targetId) || !armies.some(g => g.targetId === strategy.operation.targetId && !['returning', 'retreating'].includes(g.phase)))) {
    for (const g of armies) if (g.operationId === strategy.operation.id) { g.strategicHold = null; g.operationId = null; g.targetX = g.missionTargetX; g.targetZ = g.missionTargetZ; }
    strategy.operation = null;
  }
  const campaign = armies.filter(g => g.campaign && !['returning', 'retreating'].includes(g.phase) && !g.stagingTargetId && g.supply > 40);
  const focus = target && campaign.filter(g => g.targetId === target.id);
  if (focus?.length && !strategy.operation) {
    const origin = homes.find(h => h.id === focus[0].originId) || homes[0], d = Math.max(1, distance(origin, target));
    const fraction = Math.max(0, (d - 28) / d), rally = { x: origin.x + (target.x - origin.x) * fraction, z: origin.z + (target.z - origin.z) * fraction };
    const route = findPath(hooks.planningWorld(s, f), origin, rally, { factionId: f.id, maxExpansions: 800 });
    if (route.reachable) strategy.operation = { id: `${f.id}:${target.id}:${s.tick}`, targetId: target.id, x: rally.x, z: rally.z, targetX: target.x, targetZ: target.z,
      phase: 'assemble', createdTick: s.tick, assembleDeadline: s.tick + Math.max(45, Math.ceil(route.length / 1.6) + 20), required: Math.max(12, Math.ceil((target.soldiersEstimate ?? 20) * 1.25 + 6)), memberIds: [] };
    else (f.unreachableTargets ||= {})[target.id] = s.tick;
  }
  const op = strategy.operation;
  if (op) {
    const members = campaign.filter(g => g.targetId === op.targetId);
    op.memberIds = members.map(g => g.id);
    const observed = candidates.find(k => k.id === op.targetId);
    if (observed) op.required = Math.max(12, Math.ceil((observed.soldiersEstimate ?? 20) * 1.25 + 6));
    let assembled = 0;
    for (const g of members) {
      g.operationId = op.id; g.rallyGroupId = null; g.missionTargetX = op.targetX; g.missionTargetZ = op.targetZ;
      const bodies = getSoldiers(s, g).filter(ready);
      if (distance(g, op) < 9 && bodies.filter(b => distance(b, op) < 12).length >= bodies.length * .8) assembled += bodies.length;
      if (op.phase === 'assemble') {
        g.strategicHold = { x: op.x, z: op.z, kind: 'rally' };
        if (!g.combat?.active) { g.targetX = op.x; g.targetZ = op.z; g.phase = 'outbound'; }
        g.reason = 'Assembling at the shared forward rally; defenders and paid return supplies remain protected.';
      }
    }
    op.assembled = assembled;
    const committedStrength = members.reduce((sum, g) => sum + getSoldiers(s, g).filter(ready).length, 0);
    if (op.phase === 'assemble' && assembled >= op.required && assembled >= committedStrength * .8) {
      op.phase = 'assault'; op.committedTick = s.tick; s.stats.coordinatedAssaults = (s.stats.coordinatedAssaults || 0) + 1;
    }
    if (op.phase === 'assemble' && s.tick >= op.assembleDeadline && assembled < op.required) {
      (f.unreachableTargets ||= {})[op.targetId] = s.tick;
      for (const g of members) { g.strategicHold = null; g.operationId = null; hooks.returnHome(s, g, 'The rally cannot field a supported assault; preserving the force for another plan.', true); }
      op.phase = 'reassess';
    }
    if (op.phase === 'assault') for (const g of members) {
      g.strategicHold = null;
      if (!g.combat?.active) { g.targetX = op.targetX; g.targetZ = op.targetZ; }
      g.reason = 'The assembled force is committing together against the reported objective.';
    }
  }
  for (const g of armies) {
    recoverProgress(s, f, g, hooks);
    const role = g.phase === 'retreating' || g.phase === 'returning' ? 'recover' : g.strategicHold?.kind === 'protect' ? 'field-guard' : g.strategicHold ? 'rally' : g.missionKind === 'harassment' ? 'raid' : g.campaign ? 'assault' : 'field-guard';
    g.strategicRole = role;
    for (const body of getSoldiers(s, g)) body.order = { role: ready(body) ? role : 'recover', objectiveId: g.targetId ?? g.originId, x: g.targetX, z: g.targetZ };
  }
  strategy.workforce = {};
  for (const g of groups.filter(g => g.kind !== 'army')) {
    g.strategicRole = g.kind === 'worker' ? 'harvest' : g.kind === 'colonist' ? 'expand' : g.kind === 'scout' ? 'survey' : 'transport';
    // Existing paid jobs keep their target until completion or their own
    // reachable/affordable fallback. Planning never reallocates their cargo.
    strategy.workforce[g.strategicRole] = (strategy.workforce[g.strategicRole] || 0) + g.size;
  }
  strategy.roles = {};
  for (const home of homes) for (const body of home.soldierRoster || []) if (body.status === 'serving' && body.alive) strategy.roles[body.order?.role || 'home-reserve'] = (strategy.roles[body.order?.role || 'home-reserve'] || 0) + 1;
  f.intent = strategy.reason;
  return strategy;
}
