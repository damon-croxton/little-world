import { distance } from '../shared.js';
import { predictIntercept } from '../battle/sim.js';
import { unitStats } from './military.js';
import { getSoldiers } from './soldiers.js';
import { combatFormationSlot, updateCombatFormation } from './formations.js';
import { findPath, isSegmentTraversable, lineOfSight } from './navigation.js';

const now = s => s.time ?? s.tick;
const alive = body => body?.alive && body.hp > 0 && body.status === 'serving';
const squareDistance = (a, b) => (a.x - b.x) ** 2 + (a.z - b.z) ** 2;

// Every live body is indexed. The cell size bounds local work, not participation:
// no frontage, faction, squad, projectile, or attacker limit changes combat.
class SoldierIndex {
  constructor(records, metrics) {
    this.cells = new Map(); this.byId = new Map(); this.metrics = metrics;
    for (const record of records) {
      const key = `${Math.floor(record.body.x / 5)}:${Math.floor(record.body.z / 5)}`;
      if (!this.cells.has(key)) this.cells.set(key, []);
      this.cells.get(key).push(record); this.byId.set(record.body.id, record);
    }
  }
  near(point, radius) {
    const result = [], r2 = radius * radius;
    for (let z = Math.floor((point.z - radius) / 5); z <= Math.floor((point.z + radius) / 5); z++) {
      for (let x = Math.floor((point.x - radius) / 5); x <= Math.floor((point.x + radius) / 5); x++) {
        for (const record of this.cells.get(`${x}:${z}`) || []) {
          this.metrics.candidateChecks++;
          if (squareDistance(point, record.body) <= r2) result.push(record);
        }
      }
    }
    return result;
  }
}

function visible(s, record, other, adapter, radius = 15) {
  if (!alive(other?.body) || record.context === other.context || distance(record.body, other.body) > radius || !adapter.permitted(record.context, other.context)) return false;
  return lineOfSight(s, record.body, other.body, { maxRange: radius, factionId: record.context.faction.id, fromHeight: .75, toHeight: .65, blockWater: true });
}

function select(s, record, index, adapter, restricted) {
  const { body, context, spec } = record, time = now(s), old = index.byId.get(body.targetId);
  if (!context.hostileNearby) return { target: null, reason: body.targetId ? 'target-lost' : 'no-local-contact' };
  const range = restricted ? spec.range : 15;
  const legal = other => other && !(body.ignoredTargetId === other.body.id && body.ignoreTargetUntil > time) && visible(s, record, other, adapter, range);
  const oldLegal = legal(old);
  // Reconsider at a staggered bounded frequency; hits and launches still check
  // current life, ownership, range, terrain, and walls on every pulse.
  if (oldLegal && (distance(body, old.body) <= spec.range + .4 || time < (body.nextTargetAt ?? 0))) return { target: old, reason: 'keep-target' };
  body.nextTargetAt = time + .4;
  const urgentRange = body.role === 'ranged' ? 3.5 : 1.8;
  const candidates = index.near(body, oldLegal ? urgentRange : range).filter(other => other.context !== context && adapter.permitted(context, other.context));
  candidates.sort((a, b) => squareDistance(body, a.body) - squareDistance(body, b.body) || a.body.id.localeCompare(b.body.id));
  const nearest = candidates.find(legal), best = nearest ? distance(body, nearest.body) : Infinity;
  if (oldLegal) {
    const urgent = nearest && nearest !== old && best < (body.role === 'ranged' ? 3.5 : 1.8) && distance(body, old.body) > spec.range + .4;
    if (!urgent) return { target: old, reason: 'keep-target' };
    return { target: nearest, reason: 'immediate-threat' };
  }
  const focusRecord = index.byId.get(context.entity.combat.focusSoldierId);
  const focus = body.role === 'ranged' && focusRecord && distance(body, focusRecord.body) <= spec.range + 2.5 && legal(focusRecord) ? focusRecord : null;
  if (focus) return { target: focus, reason: 'focus-fire' };
  return { target: nearest, reason: body.targetId ? !old || !alive(old.body) ? 'target-dead' : 'target-lost' : 'acquire-visible-target' };
}

function focus(s, context, index, adapter) {
  const cs = context.entity.combat, time = now(s);
  if (!context.hostileNearby) { cs.focusSoldierId = null; return; }
  if (time < (cs.nextFocusAt ?? 0)) return;
  cs.nextFocusAt = time + .6;
  const ranged = context.records.filter(r => r.body.role === 'ranged' && !r.body.towerId);
  if (!ranged.length) { cs.focusSoldierId = null; return; }
  const old = index.byId.get(cs.focusSoldierId);
  if (old && ranged.some(r => visible(s, r, old, adapter, r.spec.range + 2.5))) return;
  let best = null, score = Infinity;
  for (const target of index.near(context, 20)) {
    if (!adapter.permitted(context, target.context)) continue;
    const next = distance(context, target.body) + target.body.hp / target.body.maxHp * 3;
    if (next >= score || !ranged.some(r => visible(s, r, target, adapter, r.spec.range + 2.5))) continue;
    score = next; best = target;
  }
  cs.focusSoldierId = best?.body.id ?? null;
}

function withdrawalGoal(s, record, threat) {
  const { body, context } = record, cs = context.entity.combat, home = context.home;
  let goal = home;
  if (context.isHome) {
    const from = threat?.body ?? context.objective ?? { x: home.x + 1, z: home.z };
    const gap = Math.max(.1, distance(home, from));
    goal = { x: home.x + (home.x - from.x) / gap * 3, z: home.z + (home.z - from.z) / gap * 3 };
  }
  if (isSegmentTraversable(s, body, goal, { factionId: context.faction.id, radius: .16 })) return goal;
  // One homeward route per army is shared by all wounded members. No soldier
  // starts its own world A* search and a blocked retreat never teleports it.
  if (!cs.withdrawalRoute || now(s) >= (cs.withdrawalRouteUntil ?? 0)) {
    const route = findPath(s, body, goal, { factionId: context.faction.id, radius: .16, maxExpansions: 1500 });
    // Infinity is useful inside pathfinding, but persistent simulation records
    // represent a failed route explicitly without a nonfinite numeric value.
    cs.withdrawalRoute = { ...route, length: Number.isFinite(route.length) ? route.length : null };
    cs.withdrawalRouteUntil = now(s) + 5;
  }
  const points = cs.withdrawalRoute.waypoints || [];
  for (let i = points.length - 1; i >= 0; i--) if (distance(body, points[i]) > .2 && isSegmentTraversable(s, body, points[i], { factionId: context.faction.id, radius: .16 })) return points[i];
  return body;
}

function plan(s, record, index, adapter) {
  const { body, context, spec, ordinal } = record, time = now(s), entity = context.entity;
  if (body.hp / body.maxHp <= (body.role === 'ranged' ? .38 : .30)) { body.withdrawing = true; body.withdrawSince ??= time; }
  if (body.towerId && context.isHome && !body.withdrawing) {
    const tower = context.home.buildings?.find(b => b.id === body.towerId && !b.destroyed);
    if (tower) {
      const crewIndex = Math.max(0, tower.crewSoldierIds?.indexOf(body.id) ?? 0), side = crewIndex % 2 ? 1 : -1;
      const goal = { x: tower.x + side * .42, z: tower.z + Math.floor(crewIndex / 2) * .5 };
      Object.assign(body, { action: 'operate-tower', reasonCode: 'tower-assignment', targetId: null });
      return { ...record, target: null, goal, speed: spec.speed, facing: null };
    }
  }
  const retreat = !context.isHome && ['retreating', 'disabled'].includes(entity.phase);
  const chosen = select(s, record, index, adapter, retreat || body.withdrawing || !!entity.strategicHold), was = body.targetId;
  let target = chosen.target, action = 'advance', reason = 'squad-objective', speed = spec.speed, intercept = null;
  let goal = combatFormationSlot(entity, ordinal, { units: context.units, x: context.x, z: context.z, yaw: entity.combat.yaw, physical: false });
  if (context.isHome && !entity.combat.active && body.order && !body.withdrawing && !body.towerId) {
    goal = combatFormationSlot(entity, ordinal, { units: context.units, x: body.order.x, z: body.order.z, yaw: entity.combat.yaw, physical: false });
    reason = body.order.role;
  }
  if (target && !retreat && !body.withdrawing && distance(body, target.body) > spec.range + .35) {
    const gap = distance(body, target.body);
    if (body.pursuit?.targetId !== target.body.id) body.pursuit = { targetId: target.body.id, since: time, progressAt: time, bestGap: gap, x: body.x, z: body.z };
    if (gap < body.pursuit.bestGap - .4) { body.pursuit.bestGap = gap; body.pursuit.progressAt = time; }
    const radial = ((target.body.x - body.x) * (target.body.vx || 0) + (target.body.z - body.z) * (target.body.vz || 0)) / gap;
    const impossible = radial >= speed * .99 && !predictIntercept({ ...body, speed, attackRange: spec.range }, target.body, 4);
    if (impossible || time - body.pursuit.since > 8 || time - body.pursuit.progressAt > 3.2 || distance(body, body.pursuit) > 16 || distance(body, context) > 22) {
      body.ignoredTargetId = target.body.id; body.ignoreTargetUntil = time + 5; body.pursuit = null;
      target = null; chosen.reason = impossible ? 'faster-enemy-escaping' : 'pursuit-leash'; reason = 'pursuit-refused';
      s.individualCombatMetrics.pursuitRefusals++;
    }
  } else body.pursuit = null;
  if (retreat || body.withdrawing) {
    goal = body.withdrawing ? withdrawalGoal(s, record, target) : goal;
    action = 'withdraw'; reason = body.withdrawing ? 'wounded-withdrawal' : 'retreat-order'; speed *= body.withdrawing ? .86 : 1;
  } else if (target) {
    const gap = distance(body, target.body);
    if (body.role === 'ranged') {
      const threats = index.near(body, 7.3).filter(other => other.context !== context && adapter.permitted(context, other.context));
      threats.sort((a, b) => squareDistance(body, a.body) - squareDistance(body, b.body) || a.body.id.localeCompare(b.body.id));
      const threat = threats.find(other => visible(s, record, other, adapter, 7.3));
      body.spacing = !!threat && distance(body, threat.body) < (body.spacing ? 7.3 : 5.8);
      if (body.spacing) {
        const d = Math.max(.1, distance(body, threat.body));
        goal = { x: body.x + (body.x - threat.body.x) / d * 3.5, z: body.z + (body.z - threat.body.z) / d * 3.5 }; action = 'space'; reason = 'ranged-spacing';
      } else if (gap <= spec.range - .7) { goal = body; action = 'attack'; reason = 'hold-range'; }
      else { goal = target.body; action = 'pursue'; reason = 'direct-pursuit'; }
    } else if (gap <= spec.range - .13) { goal = body; action = 'attack'; reason = 'melee-contact'; }
    else {
      const candidate = predictIntercept({ ...body, speed, attackRange: spec.range }, target.body, 3);
      if (candidate && distance(candidate, context) <= 22 && isSegmentTraversable(s, body, candidate, { factionId: context.faction.id, radius: .16 })) {
        goal = candidate; intercept = candidate; action = 'intercept'; reason = 'feasible-intercept';
      } else { goal = target.body; action = 'pursue'; reason = 'direct-pursuit'; }
    }
  } else if (context.objective && entity.combat.active && reason !== 'pursuit-refused') {
    const objective = context.objective, to = objective.kind === 'structure' ? adapter.structureContact(objective, body) : objective;
    const reach = ['structure', 'worker'].includes(objective.kind) ? spec.range * .8 : 1.2;
    const d = distance(body, to);
    goal = d > reach ? { x: to.x + (body.x - to.x) / Math.max(.01, d) * reach, z: to.z + (body.z - to.z) / Math.max(.01, d) * reach } : body;
    action = d > reach ? 'advance' : 'hold'; reason = objective.kind === 'structure' ? 'structure-assault' : 'squad-objective';
  } else if (!context.isHome) speed = Math.max(spec.speed, (entity.speed ?? spec.speed) + .9);
  body.targetId = target?.body.id ?? null; body.targetReason = chosen.reason;
  if (was !== body.targetId) { body.targetSince = time; s.individualCombatMetrics.targetChanges++; }
  Object.assign(body, { action, reasonCode: reason, reason, intercept });
  return { ...record, target, goal, speed, facing: target?.body ?? (context.objective && entity.combat.active ? context.objective : null) };
}

export function stepIndividualCombat(s, contexts, dt, adapter) {
  s.individualCombatMetrics ??= { candidateChecks: 0, targetChanges: 0, pursuitRefusals: 0, living: 0, attacks: 0 };
  const metrics = s.individualCombatMetrics; metrics.candidateChecks = 0;
  const records = [];
  for (const context of contexts) {
    updateCombatFormation(s, context.entity, context.units, 0, { x: context.x, z: context.z });
    context.records = [];
    let ordinal = 0;
    for (const body of getSoldiers(s, context.entity).filter(alive).sort((a, b) => (a.role === 'ranged') - (b.role === 'ranged'))) {
      const record = { body, context, ordinal: ordinal++, spec: unitStats(body.species || context.species, body.role, context.faction) };
      body.stats = { ...record.spec, damage: record.spec.damage * (adapter.damageScale?.(context) ?? 1) };
      body.attackDamage = body.stats.damage; body.attackRange = record.spec.range; body.attackCooldown = record.spec.cooldown;
      context.records.push(record); records.push(record);
    }
  }
  metrics.living = records.length;
  const index = new SoldierIndex(records, metrics);
  // Broad-phase bounds only skip impossible queries. They never authorize a
  // target; every actual contact still needs the individual observer's LOS.
  for (const context of contexts) context.extent = context.records.reduce((radius, r) => Math.max(radius, distance(context, r.body)), 0);
  for (const context of contexts) context.hostileNearby = contexts.some(other => other !== context && other.records.length && adapter.permitted(context, other) && distance(context, other) <= context.extent + other.extent + 15);
  for (const context of contexts) focus(s, context, index, adapter);
  const plans = records.map(record => plan(s, record, index, adapter));
  const grouped = new Map(contexts.map(context => [context, new Map()]));
  for (const p of plans) grouped.get(p.context).set(p.body.id, p);
  for (const context of contexts) {
    updateCombatFormation(s, context.entity, context.units, dt, { x: context.x, z: context.z, yaw: context.entity.combat.yaw, individualPlans: grouped.get(context) });
    context.entity.combat.holding = context.records.some(r => context.objective && distance(r.body, context.objective) <= 3 && isSegmentTraversable(s, r.body, context.objective, { factionId: context.faction.id, radius: .1 }));
  }
  for (const p of plans) {
    const { body, target, context, spec } = p;
    body.cooldown = Math.max(0, (body.attackReadyAt ?? 0) - now(s));
    if (!alive(body) || body.towerId || context.entity.disabled || ['retreating', 'disabled'].includes(context.entity.phase) || now(s) < (body.attackReadyAt ?? 0)) continue;
    if (target && visible(s, p, target, adapter, spec.range) && (body.role !== 'infantry' || isSegmentTraversable(s, body, target.body, { factionId: context.faction.id, radius: .1 }))) {
      if (adapter.attack(p, target)) { body.attackReadyAt = now(s) + spec.cooldown; body.lastAttackTime = now(s); metrics.attacks++; }
    } else if (!body.withdrawing && !['retreating', 'returning'].includes(context.entity.phase) && context.objective?.kind === 'structure') {
      if (adapter.attackStructure(p, context.objective)) { body.attackReadyAt = now(s) + spec.cooldown; body.lastAttackTime = now(s); metrics.attacks++; }
    } else if (!target && !body.withdrawing && !['retreating', 'returning'].includes(context.entity.phase) && context.objective?.kind === 'worker') {
      if (adapter.attackWorker?.(p, context.objective)) { body.attackReadyAt = now(s) + spec.cooldown; body.lastAttackTime = now(s); metrics.attacks++; }
    }
    body.cooldown = Math.max(0, (body.attackReadyAt ?? 0) - now(s));
  }
  return { records, index: new SoldierIndex(records, metrics) };
}
