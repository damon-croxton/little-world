import { formationSize, combatFormationSlot, updateCombatFormation } from './formations.js';
export { formationSize, combatFormationSlot, updateCombatFormation } from './formations.js';
import { clamp, distance, emit } from '../shared.js';
import { MILITARY_ROLES, availableMilitary, countMilitary, applyMilitaryCasualties, unitStats } from './military.js';
import { visibleToGroup, lineOfSight, localGroupController } from './knowledge.js';
import { moveAlongRoute, isSegmentTraversable, invalidateNavigation, assessBreachRoute } from './navigation.js';
import { ledgerAdd, SURVIVAL_NEEDS } from './economy.js';
import { factionController, settlementController, groupController } from './control.js';
import { DEFENSE_STATS, defenseAmmoCost, assignDefenses } from './defenses.js';

// Tactical decisions are made by squads, while every rendered slot is one real
// trained citizen. Wounds are pooled within a role; each complete health unit
// removes exactly one citizen through the military ledger. There are no victory
// dice, invented soldiers, or visual attacks unrelated to actual damage orders.
export const COMBAT_LIMITS = Object.freeze({ effects: 512, pending: 256, infantryFrontage: 18, rangedFrontage: 24, localTargets: 6, effectSeconds: 2.8 });
const aliveHome = p => p && p.population > 0 && p.health > 0 && !['camp', 'ruin'].includes(p.status);
export const canFight = g => !!g && g.kind === 'army' && !g.finished && !g.disabled && g.size > 0 && !['retreating', 'returning', 'disabled'].includes(g.phase);
const factionOf = (s, id) => s.factions.find(f => f.id === id);
const ownerOf = (s, entity) => 'population' in entity ? settlementController(s, entity) : entity.kind === 'worker' ? factionController(s, localGroupController(s, entity)) : groupController(s, entity);
const homeOf = (s, g) => s.settlements.find(p => p.id === g.originId);
const hostile = (s, a, b) => { a = factionController(s, a); b = factionController(s, b); return a !== b && factionOf(s, a)?.relations?.[b]?.status === 'hostile'; };
const clock = s => Number.isFinite(s.time) ? s.time : s.tick;
const amount = x => Math.max(0, Math.floor(Number.isFinite(x) ? x : 0));
const liveStructure = b => b && b.progress >= 1 && !b.destroyed && (b.hp ?? b.health ?? 1) > 0;
const ECONOMIC_TARGETS = new Set(['farm', 'power', 'storage', 'workshop', 'barracks', 'range', 'fabricator', 'launcher', 'brooder', 'spitter']);
const CARGO_KEYS = ['food', 'water', 'energy', 'materials'];

function permittedTarget(s, source, target, targetHome = null) {
  const a = ownerOf(s, source), b = ownerOf(s, targetHome || target), relation = factionOf(s, a)?.relations?.[b]?.status;
  return a !== b && !['allied', 'trade'].includes(relation) && (hostile(s, a, b) || source.kind === 'army' && source.targetId === (targetHome || target).id);
}
function strikeStillHostile(s, strike, target) {
  const group = s.groups.find(g => g.id === strike.sourceId), home = s.settlements.find(p => p.id === (strike.sourceHomeId || strike.sourceId));
  const sourceOwner = group ? ownerOf(s, group) : home ? settlementController(s, home) : factionController(s, strike.factionId);
  const targetOwner = ownerOf(s, target), relation = factionOf(s, sourceOwner)?.relations?.[targetOwner]?.status;
  // A launched order never authorizes damage to a newly friendly/capitulated
  // body or building. Native appearance is unrelated to current command.
  return sourceOwner !== targetOwner && !['allied', 'trade'].includes(relation) && (hostile(s, sourceOwner, targetOwner) ||
    strike.declaredTarget && sourceOwner === strike.factionId && targetOwner === strike.targetFactionId);
}

function initialize(s) {
  s.combatEvents ??= []; s.pendingCombat ??= []; s.nextCombatId ??= 1;
  const time = clock(s);
  s.combatEvents = s.combatEvents.filter(e => time <= e.expiresAt);
}
function effect(s, event) {
  const e = { id: `c${s.nextCombatId++}`, tick: s.tick, time: clock(s), ...event };
  e.expiresAt ??= Math.max(e.time, e.impactTime ?? e.time) + COMBAT_LIMITS.effectSeconds;
  s.combatEvents.push(e);
  if (s.combatEvents.length > COMBAT_LIMITS.effects) s.combatEvents.splice(0, s.combatEvents.length - COMBAT_LIMITS.effects);
  return e;
}
function status(entity) {
  return entity.combat ??= { active: false, yaw: 0, nextAttack: { infantry: 0, ranged: 0 }, wounds: { infantry: 0, ranged: 0 }, roleAttacks: {} };
}
function combatant(s, entity, isHome = false) {
  const home = isHome ? entity : homeOf(s, entity), faction = factionOf(s, isHome ? settlementController(s, entity) : groupController(s, entity));
  const species = factionOf(s, entity.factionId)?.species || faction?.species;
  if (!home || !faction) return null;
  const units = isHome ? { ...availableMilitary(s, home) } : entity.units;
  if (isHome) units.ranged = Math.max(0, units.ranged - (home.assigned?.towerCrew || 0));
  if (!units) return null;
  return { entity, home, faction, species, units, isHome, id: entity.id, x: isHome ? entity.combat?.x ?? entity.x : entity.x, z: isHome ? entity.combat?.z ?? entity.z : entity.z };
}
function frontRole(c) { return c.units.infantry > 0 ? 'infantry' : 'ranged'; }
function roleStart(c, role) { return role === 'infantry' ? 0 : amount(c.units.infantry); }
function unitPosition(c, index) { return combatFormationSlot(c.entity, index, { units: c.units, x: c.x, z: c.z }); }
function targetPosition(c, ordinal = 0) {
  const role = frontRole(c), n = amount(c.units[role]);
  return n ? unitPosition(c, roleStart(c, role) + ordinal % Math.min(n, formationSize(c.units).columns)) : { x: c.x, z: c.z, role: null, index: -1 };
}
function nearestTargetPosition(points, from) {
  let best = points[0], score = Infinity;
  for (const p of points) { const d = (from.x - p.x) ** 2 + (from.z - p.z) ** 2; if (d < score) { best = p; score = d; } }
  return best;
}
function fireScale(c) {
  const e = c.entity, level = c.faction.tech?.level || 0;
  return (c.isHome ? .94 : .5 + clamp(e.supply ?? 90, 0, 100) * .005) * (c.isHome ? .94 : .5 + clamp(e.morale ?? 85, 0, 100) * .005) * (1 + level * .035);
}
function sees(s, source, target, range = 18, height = .9) {
  return visibleToGroup(s, { ...source, factionId: ownerOf(s, source), commandFactionId: ownerOf(s, source), kind: source.kind || 'army' }, target, range) && lineOfSight(s, source, target, { maxRange: range, fromHeight: height, toHeight: .7, blockWater: true, factionId: ownerOf(s, source) });
}
function broken(g) { return (g.morale ?? 85) < 37 || (g.supply ?? 100) < 18 || g.size < Math.max(1, (g.cohesionSize ?? g.initialSize ?? g.size) * .58); }
function withdraw(s, g, hooks, reason = 'Field losses broke the expedition’s cohesion.') {
  if (!canFight(g)) return;
  Object.assign(status(g), { active: false, intent: 'retreat', reason, decisionUntil: clock(s) + 12 });
  if (hooks.retreat) hooks.retreat(s, g, reason, true);
  else {
    const home = homeOf(s, g); g.phase = 'retreating'; g.reason = reason;
    if (home) { g.targetX = home.x; g.targetZ = home.z; }
    s.stats.retreats = (s.stats.retreats || 0) + 1;
  }
  effect(s, { type: 'retreat', sourceId: g.id, factionId: groupController(s, g), x: g.x, z: g.z, count: g.size, expiresAt: clock(s) + 1.5 });
}
function terminate(s, target, hooks) {
  const g = target.entity;
  if (target.isHome) return;
  if (!g.size || g.finished) {
    status(g).active = false;
    if (!g.combat.lossReported) {
      g.combat.lossReported = true;
      emit(s, 'loss', `${target.faction.name} lost its ${g.initialSize ?? 0}-soldier expedition in combat.`, groupController(s, g), { groupId: g.id });
    }
  } else if (broken(g)) withdraw(s, g, hooks);
}
function impact(s, strike, hooks) {
  if (strike.targetKind === 'structure') {
    const home = s.settlements.find(p => p.id === strike.homeId), building = home?.buildings?.find(b => b.id === strike.targetId);
    if (!liveStructure(building) || !strikeStillHostile(s, strike, home)) return;
    const rays = strike.rays || [], clear = rays.filter(ray => lineOfSight(s, ray.from, ray.to, { fromHeight: ray.from.height ?? .6, toHeight: ray.to.height ?? .7, blockWater: true, factionId: strike.factionId }));
    if (rays.length && !clear.length) { effect(s, { type: 'miss', sourceId: strike.sourceId, targetId: building.id, factionId: strike.factionId, x: building.x, z: building.z }); return; }
    const old = building.hp ?? building.health ?? building.maxHp ?? 300;
    building.hp = Math.max(0, old - strike.damage * (rays.length ? clear.length / rays.length : 1)); building.lastHitTime = clock(s);
    effect(s, { type: 'impact', sourceId: strike.sourceId, targetId: building.id, factionId: settlementController(s, home), nativeFactionId: home.factionId, x: building.x, z: building.z, height: .9, damage: old - building.hp, structure: true });
    s.stats.structureDamage = (s.stats.structureDamage || 0) + old - building.hp;
    if (building.hp === 0) {
      building.destroyed = true; building.destroyedTick = s.tick; building.active = false; building.operational = false;
      invalidateNavigation(s); assignDefenses(s, home, factionOf(s, home.factionId));
      s.stats.structuresDestroyed = (s.stats.structuresDestroyed || 0) + 1;
      effect(s, { type: 'collapse', sourceId: strike.sourceId, targetId: building.id, factionId: settlementController(s, home), nativeFactionId: home.factionId, x: building.x, z: building.z, structureKind: building.kind, expiresAt: clock(s) + 2.4 });
      emit(s, 'breach', `${home.name} lost a ${building.kind}; its structure and function are destroyed.`, settlementController(s, home), { settlementId: home.id, buildingId: building.id, attackerId: strike.factionId, nativeFactionId: home.factionId });
    }
    return;
  }
  const entity = strike.targetKind === 'settlement' ? s.settlements.find(p => p.id === strike.targetId) : s.groups.find(g => g.id === strike.targetId);
  if (!entity || entity.finished || !strikeStillHostile(s, strike, entity) || (strike.targetKind === 'settlement' && !aliveHome(entity))) return;
  const target = combatant(s, entity, strike.targetKind === 'settlement');
  if (!target || !countMilitary(target.units)) return;
  const role = strike.targetRole;
  // A departed rank cannot leave a wound debt for later recruits. A volley that
  // was already launched may land during a retreat, but cannot target anew.
  if (!target.units[role] || distance(target, strike.aim) > formationSize(target.units).depth + 5) return;
  const cs = status(entity); cs.wounds ??= { infantry: 0, ranged: 0 };
  const spec = unitStats(target.species, role, target.faction), armor = clamp(spec.armor * (target.faction.modifiers?.defense || 1), 0, .6);
  const rays = strike.rays || [];
  const clearRays = rays.filter(ray => {
    if (!lineOfSight(s, ray.from, ray.to, { fromHeight: ray.from.height ?? .6, toHeight: ray.to.height ?? .45, blockWater: true, factionId: strike.factionId })) return false;
    const current = Number.isInteger(ray.targetIndex) && ray.targetIndex < countMilitary(target.units) ? unitPosition(target, ray.targetIndex) : null;
    return current && current.role === role && distance(current, ray.to) <= 1.2;
  });
  if (rays.length && !clearRays.length) { effect(s, { type: 'miss', sourceId: strike.sourceId, targetId: entity.id, factionId: strike.factionId, x: strike.aim.x, z: strike.aim.z }); return; }
  const dealt = strike.damage * (1 - armor) * (rays.length ? clearRays.length / rays.length : 1);
  cs.wounds[role] = (cs.wounds[role] || 0) + dealt;
  const beforeCount = target.units[role], complete = Math.floor(cs.wounds[role] / spec.health), requested = Math.min(beforeCount, complete);
  const deaths = [];
  for (let i = 0; i < requested; i++) deaths.push(unitPosition(target, roleStart(target, role) + target.units[role] - 1 - i));
  const lost = applyMilitaryCasualties(s, target.home, target.isHome ? null : entity, requested, { role });
  cs.wounds[role] -= complete * spec.health;
  if (!target.units[role] || lost >= beforeCount || (target.isHome && Math.max(0, availableMilitary(s, target.home)[role] - (role === 'ranged' ? target.home.assigned?.towerCrew || 0 : 0)) === 0)) cs.wounds[role] = 0;
  cs.lastHitTime = clock(s); cs.exchangeStartedAt ??= clock(s); cs.lastHitRole = role; cs.hitIndices = strike.targetIndices || [];
  effect(s, { type: 'impact', sourceId: strike.sourceId, targetId: entity.id, factionId: ownerOf(s, entity), x: strike.aim.x, z: strike.aim.z, height: .4, role, damage: dealt, deaths: lost });
  if (lost) {
    s.stats.combatDeaths = (s.stats.combatDeaths || 0) + lost;
    cs.lastCasualtyTime = clock(s);
    effect(s, { type: 'casualty', sourceId: strike.sourceId, targetId: entity.id, factionId: ownerOf(s, entity), species: target.species, role, count: lost, positions: deaths.slice(0, lost), expiresAt: clock(s) + 2.2 });
    if (target.isHome) entity.defenseMorale = Math.max(0, (entity.defenseMorale ?? 90) - lost * 110 / Math.max(12, (entity.combat?.initialGarrison ?? countMilitary(target.units) + lost)));
    if (!target.isHome) entity.morale = Math.max(0, (entity.morale ?? 85) - lost * 90 / Math.max(20, entity.initialSize ?? 50));
  }
  terminate(s, target, hooks);
}

function queueStrike(s, source, target, role, shots, damage, type = role === 'ranged' ? 'projectile' : 'melee', extra = {}) {
  if (!shots.length || s.pendingCombat.length >= COMBAT_LIMITS.pending) return false;
  const targetHome = extra.targetKind === 'structure' ? s.settlements.find(p => p.id === extra.homeId) : null;
  if (!permittedTarget(s, { ...source.entity, commandFactionId: source.faction.id }, target.entity, targetHome)) return false;
  const now = clock(s), travel = type === 'melee' ? .12 : clamp(Math.max(...shots.map(p => distance(p.from, p.to))) / 20, .18, .65);
  const e = effect(s, { type, sourceId: source.id, targetId: target.id, factionId: source.faction.id, species: source.species, role, shots, count: shots.length, impactTime: now + travel, ...extra });
  s.pendingCombat.push({ id: e.id, sourceId: source.id, targetId: target.id, targetKind: target.isHome ? 'settlement' : 'group', factionId: source.faction.id,
    targetFactionId: ownerOf(s, targetHome || target.entity), declaredTarget: source.entity.kind === 'army' && source.entity.targetId === (targetHome || target.entity).id,
    rays: shots.map(p => ({ from: { ...p.from }, to: { ...p.to }, targetIndex: p.targetIndex })), targetRole: frontRole(target), targetIndices: shots.map(p => p.targetIndex).filter(Number.isInteger), damage, aim: { ...targetPosition(target) }, impactTime: now + travel, ...extra });
  const cs = status(source.entity); cs.exchangeStartedAt ??= now; cs.roleAttacks ??= {};
  const previous = cs.roleAttacks[role]?.time === now ? cs.roleAttacks[role] : null;
  cs.roleAttacks[role] = { time: now, impactTime: Math.max(now + travel, previous?.impactTime || 0), count: (previous?.count || 0) + shots.length,
    targetId: previous?.targetId || target.id, targetIds: [...(previous?.targetIds || []), target.id], indices: [...(previous?.indices || []), ...shots.map(p => p.sourceIndex)] };
  s.stats.attacks = (s.stats.attacks || 0) + shots.length;
  if (type === 'projectile') s.stats.projectiles = (s.stats.projectiles || 0) + shots.length;
  return true;
}

function attack(s, source, targets, role) {
  if (!source || !source.units[role]) return;
  targets = targets.filter(target => target && countMilitary(target.units) && permittedTarget(s, source.entity, target.entity)).slice(0, COMBAT_LIMITS.localTargets);
  if (!targets.length) return;
  const cs = status(source.entity); cs.nextAttack ??= { infantry: 0, ranged: 0 };
  if (clock(s) + 1e-8 < (cs.nextAttack[role] ?? 0)) return;
  const spec = unitStats(source.species, role, source.faction), n = amount(source.units[role]), limit = role === 'infantry' ? COMBAT_LIMITS.infantryFrontage : COMBAT_LIMITS.rangedFrontage;
  const contacts = targets.map(target => {
    const front = frontRole(target), start = roleStart(target, front);
    return { target, points: Array.from({ length: amount(target.units[front]) }, (_, i) => unitPosition(target, start + i)) };
  });
  const volleys = new Map(), start = roleStart(source, role); let count = 0;
  // Only the squad's bounded, locally observed contact list is considered.
  // A body fires once per role cooldown, even when its neighbours face a
  // different faction or a second attacking formation.
  for (let ordinal = 0; ordinal < n && count < limit; ordinal++) {
    const from = unitPosition(source, start + ordinal); let selected = null, nearest = Infinity;
    for (const { target, points } of contacts) {
      const to = nearestTargetPosition(points, from), d = distance(from, to);
      if (d >= nearest || d > spec.range || !lineOfSight(s, from, to, { maxRange: spec.range, fromHeight: .7, toHeight: .65, blockWater: true, factionId: source.faction.id })) continue;
      if (role === 'infantry' && !isSegmentTraversable(s, from, to, { factionId: source.faction.id, radius: .1 })) continue;
      selected = { target, to }; nearest = d;
    }
    if (!selected) continue;
    const { target, to } = selected;
    if (!volleys.has(target)) volleys.set(target, []);
    volleys.get(target).push({ from: { x: from.x, z: from.z, height: .58 }, to: { x: to.x, z: to.z, height: .45 }, sourceIndex: start + ordinal, targetIndex: to.index }); count++;
  }
  for (const [target, shots] of volleys) if (queueStrike(s, source, target, role, shots, shots.length * spec.damage * fireScale(source))) cs.nextAttack[role] = clock(s) + spec.cooldown;
}

function startEngagement(s, g, target, hooks) {
  const cs = status(g), first = !cs.active || cs.targetId !== target.id;
  cs.active = true; cs.targetId = target.id; cs.targetKind = target.kind === 'army' ? 'group' : ['worker', 'scout', 'structure'].includes(target.kind) ? target.kind : 'settlement';
  cs.targetHomeId = target.homeId ?? null; cs.lastContactTime = clock(s);
  cs.yaw = Math.atan2(target.x - g.x, target.z - g.z); g.phase = 'engaging';
  if (first) {
    cs.engagedAt = clock(s); cs.decisionUntil = clock(s) + 2.4; cs.originalSize = g.size; delete cs.exchangeStartedAt;
    if (cs.targetKind === 'group') {
      const other = status(target), already = other.active && other.targetId === g.id;
      if (!already) {
        s.stats.battles = (s.stats.battles || 0) + 1;
        const af = factionOf(s, groupController(s, g)), bf = factionOf(s, groupController(s, target));
        af.experience.combat++; bf.experience.combat++;
        emit(s, 'battle', `${af.name} and ${bf.name} made local contact; infantry close while ranged ranks exchange fire.`, af.id, { groupId: g.id, otherGroupId: target.id });
      }
    }
  }
  if (cs.targetKind === 'structure') hooks.hostility?.(s, factionOf(s, groupController(s, g)), factionOf(s, groupController(s, target)));
  if (cs.targetKind === 'settlement') {
    target.contestedUntil = s.tick + 2;
    hooks.hostility?.(s, factionOf(s, groupController(s, g)), factionOf(s, settlementController(s, target)));
  }
}
function clearEngagement(g) {
  if (g.combat) { g.combat.active = false; g.combat.localTargetIds = []; }
  if (g.phase === 'engaging') g.phase = 'outbound';
}
// Estimates describe this squad's visible neighbourhood. Reports never become
// live enemy counts, and reinforcements outside this squad's sight do not count.
function strength(c, separation = 0, observedEnemy = false) {
  if (!c) return 0;
  let total = 0;
  for (const role of MILITARY_ROLES) {
    const spec = unitStats(c.species, role, observedEnemy ? null : c.faction);
    const range = role === 'ranged' && separation > 3 && separation < spec.range + 4 ? 1.2 : 1;
    total += amount(c.units[role]) * Math.sqrt(spec.health * spec.damage / spec.cooldown) / 30 * range;
  }
  // A visible uniform and body count do not disclose private supply, morale,
  // upgrades, or a settlement's morale ledger. Enemy estimates use type stats.
  if (observedEnemy) return total;
  const morale = c.isHome ? clamp(c.entity.defenseMorale ?? 90, 0, 100) / 100 : clamp(c.entity.morale ?? 85, 0, 100) / 100;
  return total * fireScale(c) * (.65 + morale * .35);
}
function structureTarget(s, home, building) {
  return { ...building, structureKind: building.kind, kind: 'structure', homeId: home.id, factionId: settlementController(s, home) };
}
function localSituation(s, g) {
  const owner = groupController(s, g), source = combatant(s, g), threats = [], walls = [], structures = [], workers = [], scouts = [];
  let support = 0, objective = null;
  const foe = id => hostile(s, owner, id);
  for (const other of s.groups) {
    if (other === g || other.finished || !sees(s, g, other, 18)) continue;
    const id = ownerOf(s, other), d = distance(g, other);
    if (canFight(other)) {
      const power = strength(combatant(s, other), d, foe(id));
      if (foe(id)) {
        const range = other.units?.ranged ? unitStats(factionOf(s, other.factionId)?.species, 'ranged').range : 2;
        const urgent = d < Math.max(7, range + 2) || other.combat?.active && other.combat.targetId === g.id;
        threats.push({ target: other, power, urgent, score: 30 - d + (urgent ? 14 : 0) + (other.combat?.targetId === g.id ? 6 : 0) });
      } else if (id === owner || factionOf(s, owner)?.relations?.[id]?.status === 'allied') support += power * clamp(1 - d / 20, .1, .85);
    } else if (other.kind === 'worker' && other.size > 0 && foe(id) && d <= 10 && clock(s) >= (other.raidedUntil ?? 0)) workers.push(other);
    else if (other.kind === 'scout' && other.size > 0 && other.phase === 'outbound' && foe(id) && d <= 8) scouts.push(other);
  }
  for (const home of s.settlements) {
    const visible = sees(s, g, home, 18);
    const ownerId = settlementController(s, home), relation = factionOf(s, owner)?.relations?.[ownerId]?.status;
    // Only the commanded destination can initiate a new conflict.
    const enemy = permittedTarget(s, g, home);
    if (visible && aliveHome(home)) {
      if (enemy) {
        if (home.id === g.targetId) objective = home;
        const defender = combatant(s, home, true), power = strength(defender, distance(g, home), true);
        if (power > 0) threats.push({ target: home, power, urgent: distance(g, defender) < 10, score: 22 - distance(g, defender) + (home.combat?.targetId === g.id ? 8 : 0) });
      } else if (ownerId === owner || relation === 'allied') support += strength(combatant(s, home, true)) * clamp(1 - distance(g, home) / 18, 0, .7);
    }
    for (const building of home.buildings || []) {
      if (!visibleToGroup(s, g, building, 16) || !liveStructure(building)) continue;
      if (['wall', 'gate'].includes(building.kind)) { walls.push({ building, home }); continue; }
      if (!enemy || !sees(s, g, building, 16)) continue;
      if (building.kind === 'tower' && building.operational && distance(g, building) <= (building.range ?? DEFENSE_STATS.tower.range)) {
        threats.push({ target: structureTarget(s, home, building), power: 7, urgent: true, score: 25 - distance(g, building) });
      } else if (ECONOMIC_TARGETS.has(building.kind)) structures.push(structureTarget(s, home, building));
    }
  }
  const own = strength(source), enemy = threats.reduce((n, t) => n + t.power, 0);
  return { source, threats, walls, structures, workers, scouts, objective, own, support, enemy, ratio: enemy ? (own + support) / enemy : null };
}
function routeDecision(s, g, local, goal) {
  if (!goal || !local.walls.length) return null;
  const cs = status(g), now = clock(s), key = `${goal.id ?? 'mission'}:${Math.round(goal.x)}:${Math.round(goal.z)}:${local.walls.map(w => w.building.id).join(',')}`;
  if (cs.routeDecisionKey !== key || now >= (cs.routeDecisionUntil ?? 0)) {
    const spec = unitStats(local.source.species, 'infantry', local.source.faction);
    const breachDps = Math.min(amount(g.units.infantry), COMBAT_LIMITS.infantryFrontage) * spec.damage * fireScale(local.source) / spec.cooldown;
    const assessment = assessBreachRoute(s, g, goal, local.walls, { factionId: groupController(s, g), speed: Math.max(.5, g.speed ?? 2.8), breachDps, maxCandidates: 3, maxExpansions: 500 });
    cs.routeDecision = { action: assessment.action, wallId: assessment.wallId ?? null, reason: assessment.reason, savedSeconds: Number.isFinite(assessment.savedSeconds) ? assessment.savedSeconds : null };
    cs.routeDecisionKey = key; cs.routeDecisionUntil = now + 2;
  }
  return cs.routeDecision;
}
function chooseStable(candidates, cs, now) {
  candidates.sort((a, b) => b.score - a.score || a.target.id.localeCompare(b.target.id));
  const best = candidates[0], old = candidates.find(c => c.target.id === cs.targetId);
  if (old && (now < (cs.decisionUntil ?? 0) || !best || best.score < old.score + 7)) return old;
  return best;
}
function acquire(s, g, hooks) {
  if (!canFight(g)) { if (g.combat) g.combat.active = false; return null; }
  if (broken(g)) { withdraw(s, g, hooks); return null; }
  const cs = status(g), now = clock(s), local = localSituation(s, g);
  if (!local.source) return null;
  Object.assign(cs, { localStrength: +local.own.toFixed(1), supportStrength: +local.support.toFixed(1), enemyStrength: +local.enemy.toFixed(1), strengthRatio: local.ratio == null ? null : +local.ratio.toFixed(2) });
  if (local.ratio != null && local.ratio < .43 && local.threats.some(t => t.urgent)) {
    withdraw(s, g, hooks, `Visible defenders outweigh this force and nearby support (${cs.strengthRatio}× local strength).`); return null;
  }
  const urgent = local.threats.filter(t => t.urgent), priorEconomic = cs.active && ['structure', 'worker'].includes(cs.targetKind);
  const selected = chooseStable(urgent.length ? urgent : local.threats, cs, now);
  let target = selected?.target, intent = 'engage', reason = 'Engaging the most immediate visible local threat.';
  if (selected && priorEconomic && target.id !== cs.targetId) { intent = 'intercept'; reason = 'Visible defenders threaten the raiders; interrupting the economic or wall attack.'; }
  if (!selected) {
    const cargo = CARGO_KEYS.reduce((n, key) => n + (g.carrying?.[key] || 0), 0);
    const economic = local.workers.filter(worker => cargo < g.size * 1.2 - .1 && CARGO_KEYS.some(key => (worker.carrying?.[key] || 0) > 0)).map(worker => ({ target: worker, score: 23 - distance(g, worker) }));
    if (!local.objective || distance(g, local.objective) > 4) for (const building of local.structures) if (distance(g, building) < 10) economic.push({ target: building, score: 17 - distance(g, building) });
    for (const scout of local.scouts) economic.push({ target: scout, score: 25 - distance(g, scout) });
    target = chooseStable(economic, cs, now)?.target || local.objective;
    if (target?.kind === 'worker') { intent = 'raid'; reason = 'Seizing an exposed crew’s carried supplies while no visible defender threatens contact.'; }
    else if (target?.kind === 'scout') { intent = 'intercept'; reason = 'Intercepting a locally visible hostile scouting party before it can continue its survey.'; }
    else if (target?.kind === 'structure') { intent = 'raid'; reason = `Disabling the exposed ${target.structureKind} while local defenders are absent.`; }
    else { intent = 'advance'; reason = 'Pressing the observed settlement after checking its local defenders.'; }
  }
  const goal = target || (Number.isFinite(g.missionTargetX ?? g.targetX) && Number.isFinite(g.missionTargetZ ?? g.targetZ) ? { x: g.missionTargetX ?? g.targetX, z: g.missionTargetZ ?? g.targetZ } : null);
  const route = !selected?.urgent ? routeDecision(s, g, local, goal) : null;
  if (route?.action === 'breach') {
    const obstacle = local.walls.find(w => w.building.id === route.wallId && permittedTarget(s, g, w.home));
    if (obstacle && g.units.infantry > 0) { target = structureTarget(s, obstacle.home, obstacle.building); intent = 'breach'; reason = route.reason; }
  } else if (route?.action === 'detour') { intent = 'detour'; reason = route.reason; }
  if (target) {
    startEngagement(s, g, target, hooks);
    if (!(cs.intent === 'intercept' && now < cs.decisionUntil && intent === 'engage')) { cs.intent = intent; cs.reason = reason; }
    const contacts = [target, ...local.threats.slice().sort((a, b) => b.score - a.score || a.target.id.localeCompare(b.target.id)).map(t => t.target).filter(t => t.id !== target.id)].slice(0, COMBAT_LIMITS.localTargets);
    cs.localTargetIds = contacts.map(t => t.id);
    return { target, contacts };
  }
  clearEngagement(g); cs.intent = route?.action === 'detour' ? 'detour' : 'advance'; cs.reason = route?.reason || 'Following reported coordinates; no hostile contact is locally visible.';
  return null;
}
function setGarrison(s, town, attackers, dt) {
  const attacker = attackers[0];
  const cs = status(town), yaw = Math.atan2(attacker.x - town.x, attacker.z - town.z), reach = Math.min(7, (town.radius ?? 8) * .5);
  const point = { x: town.x + Math.sin(yaw) * reach, z: town.z + Math.cos(yaw) * reach };
  cs.active = true; cs.initialGarrison ??= countMilitary(availableMilitary(s, town)); cs.targetId = attacker.id; cs.targetKind = 'group'; cs.yaw = yaw;
  cs.localTargetIds = attackers.map(g => g.id);
  cs.x ??= town.x; cs.z ??= town.z; cs.prevX = cs.x; cs.prevZ = cs.z;
  const travel = { x: cs.x, z: cs.z, factionId: settlementController(s, town), speed: 2.6 };
  moveAlongRoute(s, travel, point, { dt, speed: 2.6, arrival: .2 });
  cs.x = travel.x; cs.z = travel.z;
  cs.units = { ...availableMilitary(s, town) }; cs.units.ranged = Math.max(0, cs.units.ranged - (town.assigned?.towerCrew || 0)); cs.lastContactTime = clock(s);
  updateCombatFormation(s, town, cs.units, dt, { x: cs.x, z: cs.z, yaw: cs.yaw, speed: 2.6,
    localTargets: attackers.map(g => ({ id: g.id, kind: g.kind === 'scout' ? 'scout' : 'group', x: g.x, z: g.z, units: g.units, entity: g })), primaryTargetId: attacker.id, contact: true });
}
function advance(s, source, target, dt) {
  const g = source.entity, cs = status(g);
  cs.yaw = Math.atan2(target.x - g.x, target.z - g.z); cs.x = g.x; cs.z = g.z;
  const a = formationSize(source.units), b = formationSize(target.units), contact = a.depth / 2 + b.depth / 2 + (source.units.infantry ? 1.05 : unitStats(source.species, 'ranged', source.faction).range * .65);
  const separation = distance(source, target);
  if (separation > contact + .15 && g.speed !== 0) {
    const destination = { x: target.x - Math.sin(cs.yaw) * contact, z: target.z - Math.cos(cs.yaw) * contact };
    moveAlongRoute(s, g, destination, { dt, speed: (g.speed ?? 2.8) * .85, arrival: .15, factionId: source.faction.id });
    cs.x = g.x; cs.z = g.z; source.x = g.x; source.z = g.z;
  }
  cs.holding = separation <= contact + .15;
}
function structureContact(building, from) {
  let point = building;
  const wall = ['wall', 'gate'].includes(building.kind ?? building.structureKind);
  if (wall) {
    const half = (building.length ?? 7) / 2, dx = Math.cos(building.rotation ?? 0), dz = -Math.sin(building.rotation ?? 0);
    const a = building.from ?? building.wallStart ?? { x: building.x - dx * half, z: building.z - dz * half };
    const b = building.to ?? building.wallEnd ?? { x: building.x + dx * half, z: building.z + dz * half };
    const vx = b.x - a.x, vz = b.z - a.z, t = clamp(((from.x - a.x) * vx + (from.z - a.z) * vz) / Math.max(.001, vx * vx + vz * vz), 0, 1);
    point = { x: a.x + vx * t, z: a.z + vz * t };
  }
  const d = Math.max(.001, distance(point, from)), radius = Math.min(d, wall ? (building.width ?? 1) / 2 + .06 : 1.1);
  return { x: point.x + (from.x - point.x) / d * radius, z: point.z + (from.z - point.z) / d * radius, height: .7 };
}
function assaultStructure(s, source, target) {
  const town = s.settlements.find(h => h.id === target.homeId), building = town?.buildings?.find(b => b.id === target.id);
  if (!liveStructure(building) || !permittedTarget(s, source.entity, town)) return;
  const cs = status(source.entity), now = clock(s), wall = ['wall', 'gate'].includes(building.kind);
  cs.nextAttack ??= { infantry: 0, ranged: 0 };
  for (const role of MILITARY_ROLES) {
    if (!source.units[role] || wall && role !== 'infantry' || now < (cs.nextAttack[role] ?? 0)) continue;
    const spec = unitStats(source.species, role, source.faction), shots = [], start = roleStart(source, role), limit = role === 'infantry' ? COMBAT_LIMITS.infantryFrontage : COMBAT_LIMITS.rangedFrontage;
    for (let i = 0; i < source.units[role] && shots.length < limit; i++) {
      const from = unitPosition(source, start + i), to = structureContact(building, from);
      if (distance(from, to) > spec.range || !lineOfSight(s, from, to, { fromHeight: .65, toHeight: .7, factionId: source.faction.id, blockWater: true })) continue;
      if (role === 'infantry' && !isSegmentTraversable(s, from, to, { factionId: source.faction.id, radius: .02 })) continue;
      shots.push({ from: { ...from, height: .6 }, to, sourceIndex: start + i });
    }
    const fake = { id: building.id, units: { infantry: 0, ranged: 0 }, x: building.x, z: building.z, entity: building, faction: factionOf(s, town.factionId) };
    if (queueStrike(s, source, fake, role, shots, shots.length * spec.damage * fireScale(source), role === 'ranged' ? 'projectile' : 'melee', { targetKind: 'structure', homeId: town.id })) {
      cs.nextAttack[role] = now + spec.cooldown; cs.obstacleId = wall ? building.id : null;
    }
  }
}
function raidWorker(s, source, worker) {
  const g = source.entity, home = homeOf(s, worker);
  if (!home || !permittedTarget(s, source.entity, worker) || clock(s) < (worker.raidedUntil ?? 0)) return;
  let contact = false;
  for (let i = 0; i < countMilitary(source.units) && !contact; i++) {
    const from = unitPosition(source, i);
    contact = distance(from, worker) <= 2.2 && isSegmentTraversable(s, from, worker, { factionId: source.faction.id, radius: .1 });
  }
  if (!contact) return;
  g.carrying ??= {};
  let room = Math.max(0, g.size * 1.2 - CARGO_KEYS.reduce((n, key) => n + (g.carrying[key] || 0), 0)), loot = 0;
  for (const key of CARGO_KEYS) {
    const taken = Math.min(room, worker.carrying?.[key] || 0);
    if (!taken) continue;
    worker.carrying[key] -= taken; g.carrying[key] = (g.carrying[key] || 0) + taken; room -= taken; loot += taken;
  }
  if (!loot) return;
  worker.phase = 'returning'; worker.targetX = home.x; worker.targetZ = home.z; worker.activity = 'hauling'; worker.raidedUntil = clock(s) + 35;
  worker.reason = 'A hostile army seized carried supplies at close range; the surviving crew is walking home.';
  status(g).reason = `Seized ${Math.round(loot)} carried supplies; the intact worker crew is returning home.`;
  s.stats.raids = (s.stats.raids || 0) + 1; s.stats.workerRaids = (s.stats.workerRaids || 0) + 1;
  emit(s, 'raid', `${source.faction.name} seized ${Math.round(loot)} supplies from a field crew; all ${worker.size} workers escaped toward home.`, source.faction.id, { groupId: g.id, otherGroupId: worker.id, loot });
  clearEngagement(g);
}
function interceptScout(s, source, scout, hooks) {
  const home = homeOf(s, scout);
  if (!home || scout.finished || scout.phase !== 'outbound' || !permittedTarget(s, source.entity, scout)) return;
  let contact = false;
  for (let i = 0; i < countMilitary(source.units) && !contact; i++) {
    const from = unitPosition(source, i);
    contact = distance(from, scout) <= 2.2 && isSegmentTraversable(s, from, scout, { factionId: source.faction.id, radius: .1 });
  }
  if (!contact) return;
  const reason = 'Hostile troops intercepted the scouting party; its intact crew is carrying its observations home.';
  if (hooks.retreat) hooks.retreat(s, scout, reason, false);
  else { scout.phase = 'returning'; scout.targetX = home.x; scout.targetZ = home.z; scout.reason = reason; }
  scout.interceptedAt = clock(s); scout.interceptedBy = source.id;
  s.stats.scoutInterceptions = (s.stats.scoutInterceptions || 0) + 1;
  emit(s, 'intercept', `${source.faction.name} intercepted a hostile scouting party; all ${scout.size} scouts are returning with their own reports.`, source.faction.id, { groupId: source.id, otherGroupId: scout.id, count: scout.size });
  if (!source.isHome) clearEngagement(source.entity);
}
function formationContact(s, source, targets, dt) {
  const role = frontRole(source), spec = unitStats(source.species, role, source.faction);
  updateCombatFormation(s, source.entity, source.units, dt, { yaw: source.entity.combat.yaw,
    localTargets: targets.map(target => ({ id: target.id, kind: target.entity.kind === 'army' ? 'group' : target.entity.kind || 'settlement', x: target.x, z: target.z, units: target.units, entity: target.entity, radius: target.entity.kind === 'structure' ? 1.1 : .45 })),
    primaryTargetId: targets[0]?.id, contact: true, engageRange: spec.range });
}
function fireTowers(s) {
  const armies = s.groups.filter(canFight);
  for (const home of s.settlements) {
    if (!aliveHome(home)) continue;
    const faction = factionOf(s, settlementController(s, home)), species = factionOf(s, home.factionId)?.species || faction.species;
    for (const tower of home.buildings || []) {
      if (tower.kind !== 'tower' || !liveStructure(tower) || !tower.operational || clock(s) < (tower.nextAttackTime ?? 0)) continue;
      const range = tower.range ?? DEFENSE_STATS.tower.range;
      const candidates = armies.filter(g => hostile(s, settlementController(s, home), groupController(s, g)) && sees(s, { ...tower, factionId: settlementController(s, home) }, g, range, 4));
      candidates.sort((a, b) => distance(tower, a) - distance(tower, b) || a.id.localeCompare(b.id));
      const g = candidates[0]; if (!g) continue;
      const costs = defenseAmmoCost(species), needs = SURVIVAL_NEEDS[species];
      if (Object.entries(costs).some(([key, value]) => (home.stock[key] || 0) < value + (key === 'materials' ? 0 : (needs?.[key] || 0) * home.population * 2))) { tower.fireBlocked = 'Ammunition would consume the survival reserve'; continue; }
      if (s.pendingCombat.length >= COMBAT_LIMITS.pending) continue;
      const target = combatant(s, g); if (!target || !countMilitary(target.units)) continue;
      const to = targetPosition(target), source = { id: tower.id, entity: tower, faction, species };
      const shots = [{ from: { x: tower.x, z: tower.z, height: species === 'human' ? 3.73 : 4.03 }, to: { x: to.x, z: to.z, height: .45 }, sourceIndex: 0, targetIndex: to.index }];
      if (queueStrike(s, source, target, 'ranged', shots, tower.damage ?? DEFENSE_STATS.tower.damage, 'projectile', { tower: true, sourceHomeId: home.id })) {
        for (const [key, value] of Object.entries(costs)) { home.stock[key] -= value; ledgerAdd(s, key, 'consumed', value); }
        tower.nextAttackTime = clock(s) + (tower.cooldown ?? DEFENSE_STATS.tower.cooldown); tower.lastAttackTime = clock(s); tower.fireBlocked = null;
        s.stats.towerShots = (s.stats.towerShots || 0) + 1;
      }
    }
  }
}

export function stepCombat(s, dt = .1, hooks = {}) {
  initialize(s);
  if (!(dt > 0)) return;
  const time = clock(s);
  if (s.lastCombatTime === time) return; s.lastCombatTime = time;
  const due = s.pendingCombat.filter(p => p.impactTime <= time + 1e-8);
  s.pendingCombat = s.pendingCombat.filter(p => p.impactTime > time + 1e-8);
  for (const strike of due) impact(s, strike, hooks);
  if (due.length || s.groups.some(g => canFight(g))) for (const home of s.settlements) if (home.buildings?.some(b => b.kind === 'tower')) assignDefenses(s, home, factionOf(s, home.factionId));
  for (const town of s.settlements) if (town.combat) town.combat.active = false;
  for (const g of s.groups) if (g.kind === 'army' && !g.finished && g.units && !g.formationSlots) updateCombatFormation(s, g, g.units, 0);
  const engagements = [], garrisons = new Map();
  for (const g of s.groups.filter(canFight).sort((a, b) => a.id.localeCompare(b.id))) {
    const engagement = acquire(s, g, hooks); if (engagement) engagements.push([g, engagement]);
  }
  // A home guards its own locally visible neighbourhood even when an invader
  // has selected a crew, a building or another army as its primary target.
  const contacts = s.groups.filter(g => canFight(g) || g.kind === 'scout' && !g.finished && g.size > 0 && g.phase === 'outbound');
  for (const town of s.settlements) {
    if (!aliveHome(town) || !countMilitary(availableMilitary(s, town))) continue;
    const attackers = contacts.filter(g => permittedTarget(s, town, g) && sees(s, town, g, 18));
    attackers.sort((a, b) => (a.kind === 'scout') - (b.kind === 'scout') || distance(a, town) - distance(b, town) || a.id.localeCompare(b.id));
    if (attackers.length) { const local = attackers.slice(0, COMBAT_LIMITS.localTargets); garrisons.set(town.id, local); setGarrison(s, town, local, dt); }
  }
  for (const [g, { target: entity, contacts: local }] of engagements) {
    if (!canFight(g)) continue;
    const source = combatant(s, g);
    if (['structure', 'worker', 'scout'].includes(entity.kind)) {
      if (!source) continue;
      const town = s.settlements.find(h => h.id === entity.homeId);
      const target = { id: entity.id, entity, home: town, faction: factionOf(s, entity.factionId), units: { infantry: 0, ranged: 0 }, x: entity.x, z: entity.z, isHome: false };
      advance(s, source, target, dt); formationContact(s, source, [target], dt);
      if (entity.kind === 'worker') raidWorker(s, source, entity); else if (entity.kind === 'scout') interceptScout(s, source, entity, hooks); else assaultStructure(s, source, entity);
      continue;
    }
    const target = combatant(s, entity, entity.kind !== 'army');
    if (!source || !target) continue;
    const targets = local.filter(t => t.kind === 'army' || 'population' in t).map(t => combatant(s, t, 'population' in t)).filter(Boolean);
    advance(s, source, target, dt);
    formationContact(s, source, targets, dt);
    for (const role of MILITARY_ROLES) attack(s, source, targets, role);
  }
  for (const home of s.settlements) if (home.combat?.active && aliveHome(home)) {
    const source = combatant(s, home, true), local = (garrisons.get(home.id) || []).filter(g => sees(s, { ...home, ...home.combat, commandFactionId: settlementController(s, home), kind: 'army' }, g, 18));
    if (!source) continue;
    const targets = local.filter(canFight).map(g => combatant(s, g)).filter(Boolean);
    for (const role of MILITARY_ROLES) attack(s, source, targets, role);
    if (!targets.length) for (const scout of local.filter(g => g.kind === 'scout')) interceptScout(s, source, scout, hooks);
  }
  fireTowers(s);
  for (const g of s.groups) if (g.kind === 'army' && !g.finished && !g.disabled && !g.combat?.active && g.units) {
    const dx = g.x - (g.prevX ?? g.x), dz = g.z - (g.prevZ ?? g.z), yaw = g.combat?.active ? g.combat.yaw : Math.hypot(dx, dz) > .0001 ? Math.atan2(dx, dz) : Math.atan2((g.targetX ?? g.x) - g.x, (g.targetZ ?? g.z) - g.z);
    updateCombatFormation(s, g, g.units, dt, { yaw });
  }
  s.combatActive = engagements.length;
}
