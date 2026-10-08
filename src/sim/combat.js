import { relationStatus } from './diplomacy.js';
import { refreshHousing } from './housing.js';
import { formationSize, combatFormationSlot, updateCombatFormation } from './formations.js';
export { formationSize, combatFormationSlot, updateCombatFormation } from './formations.js';
import { clamp, distance, emit } from '../shared.js';
import { MILITARY_ROLES, availableMilitary, countMilitary, unitStats } from './military.js';
import { lineOfSight, localGroupController } from './knowledge.js';
import { moveAlongRoute, isSegmentTraversable, invalidateNavigation, assessBreachRoute } from './navigation.js';
import { ledgerAdd, survivalNeeds } from './economy.js';
import { factionController, settlementController, groupController } from './control.js';
import { DEFENSE_STATS, defenseAmmoCost, assignDefenses } from './defenses.js';
import { getSoldiers, getSoldier, applySoldierDamage } from './soldiers.js';
import { stepIndividualCombat } from './individual-combat.js';
import { applyCivilianDamage, civilianHealth } from './civilians.js';

// Strategic groups share routes and orders. Every serving soldier owns its
// position, target, weapon clock and health; render budgets never limit damage.
export const COMBAT_LIMITS = Object.freeze({ effects: 512, localTargets: 6, effectSeconds: 2.8 });
const aliveHome = p => p && p.population > 0 && p.health > 0 && !['camp', 'ruin'].includes(p.status);
export const canFight = g => !!g && g.kind === 'army' && !g.finished && !g.disabled && g.size > 0 && !['retreating', 'disabled'].includes(g.phase);
const factionOf = (s, id) => s.factions.find(f => f.id === id);
const ownerOf = (s, entity) => 'population' in entity ? settlementController(s, entity) : entity.kind === 'worker' ? factionController(s, localGroupController(s, entity)) : groupController(s, entity);
const homeOf = (s, g) => s.settlements.find(p => p.id === g.originId);
const hostile = (s, a, b) => { a = factionController(s, a); b = factionController(s, b); return a !== b && relationStatus(s, factionOf(s, a), b) === 'hostile'; };
const clock = s => Number.isFinite(s.time) ? s.time : s.tick;
const amount = x => Math.max(0, Math.floor(Number.isFinite(x) ? x : 0));
const liveStructure = b => b && b.progress >= 1 && !b.destroyed && (b.hp ?? b.health ?? 1) > 0;
const ECONOMIC_TARGETS = new Set(['hub', 'housing', 'farm', 'power', 'storage', 'workshop', 'barracks', 'range', 'fabricator', 'launcher', 'brooder', 'spitter']);
const CARGO_KEYS = ['food', 'water', 'energy', 'materials'];
const observationCaches = new WeakMap();

function permittedTarget(s, source, target, targetHome = null) {
  const a = ownerOf(s, source), b = ownerOf(s, targetHome || target), relation = relationStatus(s, factionOf(s, a), b);
  const campaignOwner = source.kind === 'army' && factionOf(s, a)?.knowledge?.[source.targetId]?.ownerId;
  return a !== b && !['allied', 'trade'].includes(relation) && (hostile(s, a, b) || source.kind === 'army' && (source.targetId === (targetHome || target).id || source.campaign && (source.missionEnemyId || campaignOwner) === b));
}
function strikeStillHostile(s, strike, target) {
  const group = s.groups.find(g => g.id === strike.sourceId), home = s.settlements.find(p => p.id === (strike.sourceHomeId || strike.sourceId));
  const sourceOwner = group ? ownerOf(s, group) : home ? settlementController(s, home) : factionController(s, strike.factionId);
  const targetOwner = ownerOf(s, target), relation = relationStatus(s, factionOf(s, sourceOwner), targetOwner);
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
  return entity.combat ??= { active: false, yaw: 0, roleAttacks: {} };
}
function combatant(s, entity, isHome = false) {
  const home = isHome ? entity : homeOf(s, entity), faction = factionOf(s, isHome ? settlementController(s, entity) : groupController(s, entity));
  const species = factionOf(s, entity.factionId)?.species || faction?.species;
  if (!home || !faction) return null;
  const units = isHome ? { ...availableMilitary(s, home) } : entity.units;
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
function physicalObservation(s, source, target, range = 18, height = .9) {
  let cache = observationCaches.get(s);
  const stamp = `${s.step}:${clock(s)}`;
  if (cache?.stamp !== stamp) { cache = { stamp, observations: new Map(), bodies: new Map(), bounds: new Map() }; observationCaches.set(s, cache); }
  const key = `${source.id}:${target.id}:${range}:${height}`;
  if (cache.observations.has(key)) return cache.observations.get(key);
  const bodies = entity => {
    if (!cache.bodies.has(entity.id)) cache.bodies.set(entity.id, getSoldiers(s, entity));
    return cache.bodies.get(entity.id);
  };
  const observers = source.kind === 'army' || 'population' in source ? bodies(source) : [source];
  if (!cache.bounds.has(source.id)) {
    const bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
    for (const body of observers) { bounds.minX = Math.min(bounds.minX, body.x); bounds.maxX = Math.max(bounds.maxX, body.x); bounds.minZ = Math.min(bounds.minZ, body.z); bounds.maxZ = Math.max(bounds.maxZ, body.z); }
    cache.bounds.set(source.id, bounds);
  }
  const bounds = cache.bounds.get(source.id);
  const owner = ownerOf(s, source), visible = [], units = { infantry: 0, ranged: 0 };
  let nearest = Infinity;
  const witness = point => {
    if (point.x < bounds.minX - range || point.x > bounds.maxX + range || point.z < bounds.minZ - range || point.z > bounds.maxZ + range) return false;
    for (const body of observers) {
      if (Math.abs(body.x - point.x) > range || Math.abs(body.z - point.z) > range) continue;
      const d = distance(body, point);
      if (d <= range && lineOfSight(s, body, point, { maxRange: range, fromHeight: height, toHeight: .7, blockWater: true, factionId: owner })) { nearest = Math.min(nearest, d); return true; }
    }
    return false;
  };
  if (target.kind === 'army' || 'population' in target) for (const body of bodies(target)) if (witness(body)) { visible.push(body); units[body.role]++; }
  const pointVisible = target.kind !== 'army' && witness(target);
  const result = { visible: pointVisible || visible.length > 0, soldiers: visible, units, distance: nearest,
    x: visible.length ? visible.reduce((n, body) => n + body.x, 0) / visible.length : target.x,
    z: visible.length ? visible.reduce((n, body) => n + body.z, 0) / visible.length : target.z };
  cache.observations.set(key, result); return result;
}
function sees(s, source, target, range = 18, height = .9) {
  return physicalObservation(s, source, target, range, height).visible;
}
function broken(g) { return (g.morale ?? 85) < 37 || (g.supply ?? 100) < (g.stagingPurpose === 'resupply' ? 8 : 18) || (!g.campaign || (g.morale ?? 85) < 55) && g.size < Math.max(1, (g.cohesionSize ?? g.initialSize ?? g.size) * .58); }
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
  if (strike.targetKind === 'worker') {
    const worker = s.groups.find(g => g.id === strike.targetId && g.kind === 'worker' && !g.finished && g.size > 0);
    if (!worker || !strikeStillHostile(s, strike, worker)) return;
    const ray = strike.rays?.[0], aim = ray?.to ?? strike.aim;
    if (!ray || !lineOfSight(s, ray.from, aim, { fromHeight: .6, toHeight: .45, blockWater: true, factionId: strike.factionId }) || distance(worker, aim) > (strike.projectile ? .7 : 1.2)) {
      effect(s, { type: 'miss', sourceId: strike.sourceId, targetId: worker.id, sourceSoldierId: strike.sourceSoldierId, factionId: strike.factionId, x: aim?.x ?? worker.x, z: aim?.z ?? worker.z }); return;
    }
    const hpBefore = civilianHealth(worker), result = applyCivilianDamage(s, worker, strike.damage), home = homeOf(s, worker);
    if (!result.damage) return;
    worker.lastHitTime = clock(s); worker.lastAttackerId = strike.sourceId;
    worker.phase = 'returning'; worker.activity = 'fleeing'; worker.targetX = home.x; worker.targetZ = home.z;
    worker.reason = 'Hostile troops attacked this crew; surviving workers are seeking protection.';
    effect(s, { type: 'impact', sourceId: strike.sourceId, targetId: worker.id, sourceSoldierId: strike.sourceSoldierId, factionId: ownerOf(s, worker), x: worker.x, z: worker.z, height: .4, damage: result.damage, deaths: result.deaths, hpBefore, hpAfter: civilianHealth(worker) });
    if (result.deaths) effect(s, { type: 'casualty', sourceId: strike.sourceId, targetId: worker.id, sourceSoldierId: strike.sourceSoldierId, factionId: ownerOf(s, worker), species: factionOf(s, worker.factionId)?.species, x: worker.x, z: worker.z, count: result.deaths, positions: [{ x: worker.x, z: worker.z }], expiresAt: clock(s) + 2.2 });
    return;
  }
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
      refreshHousing(home, factionOf(s, home.factionId));
      invalidateNavigation(s); assignDefenses(s, home, factionOf(s, home.factionId));
      s.stats.structuresDestroyed = (s.stats.structuresDestroyed || 0) + 1;
      effect(s, { type: 'collapse', sourceId: strike.sourceId, targetId: building.id, factionId: settlementController(s, home), nativeFactionId: home.factionId, x: building.x, z: building.z, structureKind: building.kind, expiresAt: clock(s) + 2.4 });
      emit(s, 'breach', `${home.name} lost a ${building.kind}; its structure and function are destroyed.`, settlementController(s, home), { settlementId: home.id, buildingId: building.id, attackerId: strike.factionId, nativeFactionId: home.factionId });
    }
    return;
  }
  const soldier = getSoldier(s, strike.targetSoldierId);
  if (!soldier?.alive || soldier.hp <= 0) return;
  const entity = soldier.groupId ? s.groups.find(g => g.id === soldier.groupId) : s.settlements.find(p => p.id === soldier.originId);
  if (!entity || !strikeStillHostile(s, strike, entity)) return;
  const target = combatant(s, entity, 'population' in entity);
  if (!target) return;
  const ray = strike.rays?.[0], aim = ray?.to ?? strike.aim;
  if (!ray || !lineOfSight(s, ray.from, aim, { fromHeight: ray.from.height ?? .6, toHeight: aim.height ?? .45, blockWater: true, factionId: strike.factionId }) || distance(soldier, aim) > (strike.projectile ? .7 : 1.2)) {
    effect(s, { type: 'miss', sourceId: strike.sourceId, targetId: entity.id, sourceSoldierId: strike.sourceSoldierId, targetSoldierId: soldier.id, factionId: strike.factionId, x: aim?.x ?? soldier.x, z: aim?.z ?? soldier.z }); return;
  }
  const spec = unitStats(soldier.species || target.species, soldier.role, target.faction), armor = clamp(spec.armor * (target.faction.modifiers?.defense || 1), 0, .6);
  const position = { x: soldier.x, z: soldier.z, yaw: soldier.yaw, soldierId: soldier.id }, hpBefore = soldier.hp;
  const result = applySoldierDamage(s, soldier, strike.damage * (1 - armor), { cause: 'combat', sourceSoldierId: strike.sourceSoldierId, sourceId: strike.sourceId });
  if (!result.damage) return;
  soldier.lastHitTime = clock(s);
  const cs = status(entity); cs.lastHitTime = clock(s); cs.exchangeStartedAt ??= clock(s); cs.lastHitRole = soldier.role;
  effect(s, { type: 'impact', sourceId: strike.sourceId, targetId: entity.id, sourceSoldierId: strike.sourceSoldierId, shooterSoldierId: strike.sourceSoldierId, targetSoldierId: soldier.id,
    factionId: ownerOf(s, entity), x: soldier.x, z: soldier.z, height: .4, role: soldier.role, damage: result.damage, hpBefore, hpAfter: soldier.hp, deaths: Number(result.killed) });
  if (result.killed) {
    s.stats.combatDeaths = (s.stats.combatDeaths || 0) + 1; cs.lastCasualtyTime = clock(s);
    effect(s, { type: 'casualty', sourceId: strike.sourceId, targetId: entity.id, sourceSoldierId: strike.sourceSoldierId, targetSoldierId: soldier.id,
      factionId: ownerOf(s, entity), species: target.species, role: soldier.role, count: 1, positions: [position], expiresAt: clock(s) + 2.2 });
    if (target.isHome) entity.defenseMorale = Math.max(0, (entity.defenseMorale ?? 90) - 110 / Math.max(12, cs.initialGarrison ?? countMilitary(target.units) + 1));
    else entity.morale = Math.max(0, (entity.morale ?? 85) - 90 / Math.max(20, entity.initialSize ?? 50));
  }
  terminate(s, target, hooks);
}

function queueStrike(s, source, target, role, shots, damage, type = role === 'ranged' ? 'projectile' : 'melee', extra = {}) {
  if (!shots.length) return false;
  const targetHome = extra.targetKind === 'structure' ? s.settlements.find(p => p.id === extra.homeId) : null;
  const sourceEntity = source.entity.kind === 'tower' ? s.settlements.find(p => p.id === extra.sourceHomeId) : source.entity;
  if (!sourceEntity || !permittedTarget(s, sourceEntity, target.entity, targetHome)) return false;
  const now = clock(s), travel = type === 'melee' ? .1 : Math.max(.12, distance(shots[0].from, shots[0].to) / 24);
  const shot = shots[0], sourceSoldierId = extra.sourceSoldierId ?? shot.sourceSoldierId, targetSoldierId = extra.targetSoldierId ?? shot.targetSoldierId;
  const identities = { sourceSoldierId, shooterSoldierId: sourceSoldierId, targetSoldierId };
  const e = effect(s, { type, sourceId: source.id, targetId: target.id, factionId: source.faction.id, species: source.species, role, shots, count: shots.length, impactTime: now + travel, ...identities, ...extra });
  s.pendingCombat.push({ id: e.id, sourceId: source.id, sourceHomeId: source.home?.id, targetId: target.id, targetKind: target.isHome ? 'settlement' : 'group', factionId: source.faction.id,
    targetFactionId: ownerOf(s, targetHome || target.entity), declaredTarget: source.entity.kind === 'army' && (source.entity.targetId === (targetHome || target.entity).id || source.entity.campaign && permittedTarget(s, source.entity, target.entity, targetHome)),
    rays: shots.map(p => ({ from: { ...p.from }, to: { ...p.to }, targetSoldierId: p.targetSoldierId })), targetRole: extra.targetRole ?? role,
    damage, aim: { ...shots[0].to }, projectile: type === 'projectile', impactTime: now + travel, ...identities, ...extra });
  const cs = status(source.entity); cs.exchangeStartedAt ??= now; cs.roleAttacks ??= {};
  const previous = cs.roleAttacks[role]?.time === now ? cs.roleAttacks[role] : null;
  cs.roleAttacks[role] = { time: now, impactTime: Math.max(now + travel, previous?.impactTime || 0), count: (previous?.count || 0) + shots.length,
    targetId: previous?.targetId || target.id, targetIds: [...new Set([...(previous?.targetIds || []), target.id])], indices: [...(previous?.indices || []), ...shots.map(p => p.sourceIndex)], soldierIds: [...(previous?.soldierIds || []), sourceSoldierId].filter(Boolean) };
  s.stats.attacks = (s.stats.attacks || 0) + shots.length;
  if (type === 'projectile') s.stats.projectiles = (s.stats.projectiles || 0) + shots.length;
  return true;
}

function soldierAttack(s, source, target) {
  const { body, context, spec, ordinal } = source, aim = { x: target.body.x, z: target.body.z, height: .45 };
  if (body.role === 'ranged') {
    let duration = Math.max(.12, distance(body, aim) / 24);
    for (let i = 0; i < 3; i++) { aim.x = target.body.x + (target.body.vx || 0) * duration; aim.z = target.body.z + (target.body.vz || 0) * duration; duration = Math.max(.12, distance(body, aim) / 24); }
    if (!lineOfSight(s, body, aim, { factionId: context.faction.id, fromHeight: .6, toHeight: .45, blockWater: true })) { aim.x = target.body.x; aim.z = target.body.z; }
  }
  const shots = [{ from: { x: body.x, z: body.z, height: .6 }, to: aim, sourceIndex: ordinal, targetIndex: target.ordinal, sourceSoldierId: body.id, shooterSoldierId: body.id, targetSoldierId: target.body.id }];
  return queueStrike(s, context, target.context, body.role, shots, spec.damage * fireScale(context), body.role === 'ranged' ? 'projectile' : 'melee', { sourceSoldierId: body.id, targetSoldierId: target.body.id, targetRole: target.body.role });
}

function startEngagement(s, g, target, hooks) {
  const cs = status(g), first = !cs.active || cs.targetId !== target.id;
  if (g.phase === 'returning') cs.resumePhase = 'returning';
  cs.active = true; cs.targetId = target.id; cs.targetKind = target.kind === 'army' ? 'group' : ['worker', 'scout', 'structure'].includes(target.kind) ? target.kind : 'settlement';
  cs.targetHomeId = target.homeId ?? null; cs.lastContactTime = clock(s);
  cs.yaw = Math.atan2(target.x - g.x, target.z - g.z); g.phase = 'engaging';
  if (first) {
    cs.engagedAt = clock(s); cs.decisionUntil = clock(s) + 2.4; cs.originalSize = g.size; delete cs.exchangeStartedAt;
    if (cs.targetKind === 'group') {
      hooks.hostility?.(s, factionOf(s, groupController(s, g)), factionOf(s, groupController(s, target)));
      const other = status(target), already = other.active && other.targetId === g.id;
      if (!already) {
        s.stats.battles = (s.stats.battles || 0) + 1;
        const af = factionOf(s, groupController(s, g)), bf = factionOf(s, groupController(s, target));
        af.experience.combat++; bf.experience.combat++;
        emit(s, 'battle', `${af.name} and ${bf.name} made local contact; infantry close while ranged ranks exchange fire.`, af.id, { groupId: g.id, otherGroupId: target.id });
      }
    }
  }
  if (['structure', 'worker'].includes(cs.targetKind)) hooks.hostility?.(s, factionOf(s, groupController(s, g)), factionOf(s, ownerOf(s, target)));
  if (cs.targetKind === 'settlement') {
    target.contestedUntil = s.tick + 2;
    hooks.hostility?.(s, factionOf(s, groupController(s, g)), factionOf(s, settlementController(s, target)));
  }
}
function clearEngagement(g) {
  if (g.combat) { g.combat.active = false; g.combat.localTargetIds = []; }
  if (g.phase === 'engaging') g.phase = g.combat?.resumePhase || 'outbound';
  if (g.combat) g.combat.resumePhase = null;
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
    const observed = physicalObservation(s, g, other, 18), id = ownerOf(s, other), d = observed.distance;
    if (other.kind === 'army' && !other.finished && other.size > 0) {
      const target = { ...other, x: observed.x, z: observed.z, units: observed.units, combat: status(other) };
      const power = strength(combatant(s, target), d, true);
      if (permittedTarget(s, g, other)) {
        const range = observed.units.ranged ? unitStats(factionOf(s, other.factionId)?.species, 'ranged').range : 2;
        const protecting = g.strategicHold?.kind === 'protect';
        const urgent = d < Math.max(7, range + 2) || protecting && distance(target, g.strategicHold) < 18;
        threats.push({ target, power, urgent, score: 30 - d + (urgent ? 14 : 0) });
      } else if (id === owner || relationStatus(s, factionOf(s, owner), id) === 'allied') support += power * clamp(1 - d / 20, .1, .85);
    } else if (other.kind === 'worker' && other.size > 0 && permittedTarget(s, g, other) && d <= 16 && (status(g).ignoredWorkerId !== other.id || clock(s) >= status(g).ignoreWorkerUntil)) workers.push(other);
    else if (other.kind === 'scout' && other.size > 0 && (other.size === 1 || other.phase === 'outbound') && foe(id) && d <= 18 && (status(g).ignoredScoutId !== other.id || clock(s) >= status(g).ignoreScoutUntil)) scouts.push(other);
  }
  for (const home of s.settlements) {
    const observed = physicalObservation(s, g, home, 18), visible = observed.visible;
    const ownerId = settlementController(s, home), relation = relationStatus(s, factionOf(s, owner), ownerId);
    // Only the commanded destination can initiate a new conflict.
    const enemy = permittedTarget(s, g, home);
    if (visible && aliveHome(home)) {
      if (enemy) {
        if (home.id === g.targetId) objective = home;
        const defender = combatant(s, home, true), power = defender ? strength({ ...defender, units: observed.units }, observed.distance, true) : 0;
        if (power > 0) threats.push({ target: home, power, urgent: observed.distance < 10, score: 22 - observed.distance });
      } else if (ownerId === owner || relation === 'allied') {
        const defender = combatant(s, home, true);
        if (defender) support += strength({ ...defender, units: observed.units }, observed.distance, true) * clamp(1 - observed.distance / 18, 0, .7);
      }
    }
    for (const building of home.buildings || []) {
      if (!liveStructure(building) || !sees(s, g, building, 16)) continue;
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
    const breachDps = amount(g.units.infantry) * spec.damage * fireScale(local.source) / spec.cooldown;
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
  Object.assign(cs, { assessedAt: now, localStrength: +local.own.toFixed(1), supportStrength: +local.support.toFixed(1), enemyStrength: +local.enemy.toFixed(1), strengthRatio: local.ratio == null ? null : +local.ratio.toFixed(2) });
  if (local.ratio != null && local.ratio < .43 && local.threats.some(t => t.urgent)) {
    withdraw(s, g, hooks, `Visible defenders outweigh this force and nearby support (${cs.strengthRatio}× local strength).`); return null;
  }
  const urgent = local.threats.filter(t => t.urgent), priorEconomic = cs.active && ['structure', 'worker'].includes(cs.targetKind);
  const heldThreats = g.strategicHold?.kind === 'protect' ? urgent.filter(threat => distance(threat.target, g.strategicHold) < 22 || distance(threat.target, g) < 7) : urgent;
  const selected = chooseStable(g.strategicHold ? heldThreats : urgent.length ? urgent : local.threats, cs, now);
  let target = selected?.target, intent = 'engage', reason = 'Engaging the most immediate visible local threat.';
  if (selected && priorEconomic && target.id !== cs.targetId) { intent = 'intercept'; reason = 'Visible defenders threaten the raiders; interrupting the economic or wall attack.'; }
  if (!selected && !g.strategicHold && g.phase !== 'returning' && cs.resumePhase !== 'returning') {
    const economic = local.workers.map(worker => ({ target: worker, score: 27 + Math.min(12, worker.size) * .7 + Math.min(8, CARGO_KEYS.reduce((n, key) => n + (worker.carrying?.[key] || 0), 0) * .12) - distance(g, worker) }));
    if (!local.objective || distance(g, local.objective) > 4 || cs.targetKind === 'structure') for (const building of local.structures) if (distance(g, building) < 10) economic.push({ target: building, score: (building.structureKind === 'hub' ? 52 : building.structureKind === 'housing' ? 29 : 17) - distance(g, building) });
    for (const scout of local.scouts) economic.push({ target: scout, score: 48 - distance(g, scout) });
    // Once fit bodies reach their commanded, undefended civic centre, finish
    // the objective instead of abandoning it for an incidental crew or scout.
    // Threat selection above and the strategic supply/retreat budgets still win.
    const civicContact = local.objective && local.enemy === 0 && getSoldiers(s, g).some(body =>
      !body.withdrawing && body.hp / body.maxHp > .4 && distance(body, local.objective) <= 5 &&
      isSegmentTraversable(s, body, local.objective, { factionId: ownerOf(s, g), radius: .16 }));
    target = civicContact ? local.objective : chooseStable(economic, cs, now)?.target || local.objective;
    if (target?.kind === 'worker') { intent = 'raid'; reason = 'Attacking exposed labor and supplies while no visible defender threatens contact.'; }
    else if (target?.kind === 'scout') { intent = 'intercept'; reason = 'Intercepting a locally visible hostile scouting party before it can continue its survey.'; }
    else if (target?.kind === 'structure') { intent = 'raid'; reason = `Disabling the exposed ${target.structureKind} while local defenders are absent.`; }
    else { intent = 'advance'; reason = 'Pressing the observed settlement after checking its local defenders.'; }
  }
  if (target?.kind === 'worker') {
    const gap = getSoldiers(s, g).reduce((nearest, body) => Math.min(nearest, distance(body, target)), Infinity);
    if (cs.workerPursuit?.targetId !== target.id) cs.workerPursuit = { targetId: target.id, since: now, progressAt: now, gap, x: g.x, z: g.z };
    const chase = cs.workerPursuit;
    if (gap < chase.gap - .4 || target.lastHitTime >= now - .3 && target.lastAttackerId === g.id) { chase.gap = gap; chase.progressAt = now; }
    if (now - chase.since > 10 || now - chase.progressAt > 3.5 || distance(g, chase) > 20) {
      cs.ignoredWorkerId = target.id; cs.ignoreWorkerUntil = now + 18; cs.workerPursuit = null;
      target = null; intent = 'advance'; reason = 'The crew escaped the useful raid window; resuming the supplied objective.';
      if (g.missionKind === 'harassment') {
        if (g.campaign && hooks.continueObjective?.(s, g)) { clearEngagement(g); return null; }
        reason = 'The worker raid made no further useful progress; preserving the force and returning with its observations.';
        if (hooks.retreat) hooks.retreat(s, g, reason, false);
        else { const home = homeOf(s, g); g.phase = 'returning'; if (home) { g.targetX = home.x; g.targetZ = home.z; } }
        clearEngagement(g); cs.intent = 'return'; cs.reason = reason; return null;
      }
    }
  } else cs.workerPursuit = null;
  if (target?.kind === 'scout') {
    const gap = distance(g, target);
    if (cs.scoutPursuit?.id !== target.id) cs.scoutPursuit = { id: target.id, since: now, progressAt: now, gap, x: g.x, z: g.z };
    const chase = cs.scoutPursuit;
    if (gap < chase.gap - .4) { chase.gap = gap; chase.progressAt = now; }
    const escaping = Math.hypot(target.x - (target.prevX ?? target.x), target.z - (target.prevZ ?? target.z)) > .01 && (target.speed || 0) > (g.speed || 2.8) * 1.15 && gap > 3;
    if (escaping || now - chase.since > 2.5 || now - chase.progressAt > 1.2 || distance(g, chase) > 6) {
      cs.ignoredScoutId = target.id; cs.ignoreScoutUntil = now + 15; cs.scoutPursuit = null;
      target = null; intent = 'advance'; reason = 'Scout pursuit cannot close quickly; resuming the useful march.';
    }
  } else cs.scoutPursuit = null;
  const goal = target || (Number.isFinite(g.missionTargetX ?? g.targetX) && Number.isFinite(g.missionTargetZ ?? g.targetZ) ? { x: g.missionTargetX ?? g.targetX, z: g.missionTargetZ ?? g.targetZ } : null);
  const route = !g.strategicHold && !selected?.urgent && g.phase !== 'returning' && cs.resumePhase !== 'returning' ? routeDecision(s, g, local, goal) : null;
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
  clearEngagement(g); cs.intent = route?.action === 'detour' ? 'detour' : 'advance'; cs.reason = route?.reason || reason;
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
  cs.units = { ...availableMilitary(s, town) }; cs.lastContactTime = clock(s);

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
  const { body, context, spec, ordinal } = source, town = s.settlements.find(h => h.id === target.homeId), building = town?.buildings?.find(b => b.id === target.id);
  if (!liveStructure(building) || !permittedTarget(s, context.entity, town) || ['wall', 'gate'].includes(building.kind) && body.role !== 'infantry') return false;
  const to = structureContact(building, body);
  if (distance(body, to) > spec.range || !lineOfSight(s, body, to, { fromHeight: .65, toHeight: .7, factionId: context.faction.id, blockWater: true })) return false;
  if (body.role === 'infantry' && !isSegmentTraversable(s, body, to, { factionId: context.faction.id, radius: .02 })) return false;
  const fake = { id: building.id, entity: building, faction: factionOf(s, town.factionId) };
  const shot = { from: { x: body.x, z: body.z, height: .6 }, to, sourceIndex: ordinal, sourceSoldierId: body.id, shooterSoldierId: body.id };
  return queueStrike(s, context, fake, body.role, [shot], spec.damage * fireScale(context), body.role === 'ranged' ? 'projectile' : 'melee', { targetKind: 'structure', homeId: town.id, sourceSoldierId: body.id });
}

function raidWorker(s, source, worker) {
  const g = source.entity, home = homeOf(s, worker);
  if (!home || worker.finished || !worker.size || !permittedTarget(s, source.entity, worker) || clock(s) < (worker.raidedUntil ?? 0)) return;
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
  status(g).reason = `Seized ${Math.round(loot)} carried supplies; the surviving crew is fleeing.`;
  s.stats.raids = (s.stats.raids || 0) + 1; s.stats.workerRaids = (s.stats.workerRaids || 0) + 1;
  emit(s, 'raid', `${source.faction.name} seized ${Math.round(loot)} supplies from a field crew; ${worker.size} workers are fleeing toward home.`, source.faction.id, { groupId: g.id, otherGroupId: worker.id, loot });
}
function attackWorker(s, source, worker, hooks) {
  const { body, context, spec, ordinal } = source;
  if (worker.finished || !worker.size || !permittedTarget(s, context.entity, worker) || distance(body, worker) > spec.range) return false;
  if (!lineOfSight(s, body, worker, { fromHeight: .6, toHeight: .45, factionId: context.faction.id, blockWater: true })) return false;
  if (body.role === 'infantry' && !isSegmentTraversable(s, body, worker, { factionId: context.faction.id, radius: .1 })) return false;
  const aim = { x: worker.x, z: worker.z, height: .45 };
  if (body.role === 'ranged') {
    const travel = Math.max(.12, distance(body, worker) / 24);
    aim.x += (worker.x - (worker.prevX ?? worker.x)) * 10 * travel;
    aim.z += (worker.z - (worker.prevZ ?? worker.z)) * 10 * travel;
  }
  const shot = { from: { x: body.x, z: body.z, height: .6 }, to: aim, sourceIndex: ordinal, sourceSoldierId: body.id, shooterSoldierId: body.id };
  const fired = queueStrike(s, context, { id: worker.id, entity: worker }, body.role, [shot], spec.damage * fireScale(context), body.role === 'ranged' ? 'projectile' : 'melee', { targetKind: 'worker', sourceSoldierId: body.id });
  if (fired && !hostile(s, context.faction.id, ownerOf(s, worker))) hooks.hostility?.(s, context.faction, factionOf(s, ownerOf(s, worker)));
  return fired;
}
function interceptScout(s, source, scout, hooks) {
  const home = homeOf(s, scout);
  if (!home || scout.finished || !permittedTarget(s, source.entity, scout)) return;
  if (scout.size !== 1 && scout.phase !== 'outbound') return;
  let contact = false;
  for (let i = 0; i < countMilitary(source.units) && !contact; i++) {
    const from = unitPosition(source, i);
    contact = distance(from, scout) <= 2.2 && isSegmentTraversable(s, from, scout, { factionId: source.faction.id, radius: .1 });
  }
  if (!contact) return;
  if (scout.size === 1 && hooks.casualties) {
    hooks.casualties(s, scout, 1);
    scout.interceptedAt = clock(s); scout.interceptedBy = source.id;
    s.stats.scoutInterceptions = (s.stats.scoutInterceptions || 0) + 1;
    effect(s, { type: 'casualty', sourceId: source.id, targetId: scout.id, factionId: ownerOf(s, scout), x: scout.x, z: scout.z, count: 1 });
    emit(s, 'intercept', `${source.faction.name} caught a hostile scout; its live sight has ended.`, source.faction.id, { groupId: source.id, otherGroupId: scout.id, count: 1 });
    return;
  }
  const reason = 'Hostile troops intercepted the scouting party; its intact crew is carrying its observations home.';
  if (hooks.retreat) hooks.retreat(s, scout, reason, false);
  else { scout.phase = 'returning'; scout.targetX = home.x; scout.targetZ = home.z; scout.reason = reason; }
  scout.interceptedAt = clock(s); scout.interceptedBy = source.id;
  s.stats.scoutInterceptions = (s.stats.scoutInterceptions || 0) + 1;
  emit(s, 'intercept', `${source.faction.name} intercepted a hostile scouting party; all ${scout.size} scouts are returning with their own reports.`, source.faction.id, { groupId: source.id, otherGroupId: scout.id, count: scout.size });
  if (!source.isHome) clearEngagement(source.entity);
}

// A scout is one civilian in the field. It may ambush only a tiny, locally
// visible work party, and abandons that opportunity as soon as defenders appear.
function scoutOpportunities(s, hooks) {
  if (!hooks.casualties) return;
  for (const scout of s.groups) {
    if (scout.kind !== 'scout' || scout.size !== 1 || scout.finished || scout.phase !== 'outbound') continue;
    const restore = () => { if (scout.surveyDestination) { Object.assign(scout, scout.surveyDestination); delete scout.surveyDestination; } scout.fieldRaidTargetId = null; };
    const danger = [...s.groups.filter(g => g.kind === 'army' && !g.finished), ...s.settlements].some(other => {
      if (!permittedTarget(s, scout, other)) return false;
      const observed = physicalObservation(s, scout, other, 18);
      return observed.visible && countMilitary(observed.units) > 0 || (other.buildings || []).some(b => b.kind === 'tower' && liveStructure(b) && sees(s, scout, b, 18));
    });
    if (danger && scout.surveyPurpose === 'economic') {
      restore(); const home = homeOf(s, scout), reason = 'Visible defenders make this economic survey unsafe; preserving the scout and its observations.';
      if (hooks.retreat) hooks.retreat(s, scout, reason, false);
      else if (home) Object.assign(scout, { phase: 'returning', targetX: home.x, targetZ: home.z, reason });
      continue;
    }
    if (danger || scout.supply < 55 || scout.morale < 65 || clock(s) < (scout.nextHarassAt ?? 0)) { restore(); continue; }
    const worker = s.groups.filter(g => g.kind === 'worker' && !g.finished && g.size > 0 && g.size <= 2 && permittedTarget(s, scout, g) && sees(s, scout, g, 8))
      .sort((a, b) => distance(scout, a) - distance(scout, b))[0];
    if (!worker) { restore(); continue; }
    scout.surveyDestination ??= { targetX: scout.targetX, targetZ: scout.targetZ };
    scout.fieldRaidTargetId = worker.id; scout.targetX = worker.x; scout.targetZ = worker.z;
    scout.reason = 'A single scout is approaching a small exposed work party; no defender is locally visible.';
    if (distance(scout, worker) > 1.5 || !isSegmentTraversable(s, scout, worker, { factionId: ownerOf(s, scout), radius: .1 })) continue;
    const lost = hooks.casualties(s, worker, 1);
    if (lost) { s.stats.scoutRaids = (s.stats.scoutRaids || 0) + 1; effect(s, { type: 'casualty', sourceId: scout.id, targetId: worker.id, factionId: ownerOf(s, worker), x: worker.x, z: worker.z, count: lost }); }
    scout.nextHarassAt = clock(s) + 12; restore();
  }
}
function fireTowers(s, field) {
  for (const home of s.settlements) {
    if (!aliveHome(home)) continue;
    const faction = factionOf(s, settlementController(s, home)), species = factionOf(s, home.factionId)?.species || faction.species;
    for (const tower of home.buildings || []) {
      if (tower.kind !== 'tower' || !liveStructure(tower) || !tower.operational || clock(s) < (tower.nextAttackTime ?? 0)) continue;
      const crew = getSoldiers(s, home).filter(body => body.towerId === tower.id && !body.withdrawing && distance(body, tower) <= 1.6 && clock(s) >= (body.attackReadyAt ?? 0));
      if (crew.length < (tower.requiredCrew ?? DEFENSE_STATS.tower.requiredCrew)) { tower.fireBlocked = 'Assigned operators are moving or recovering their weapon'; continue; }
      const range = tower.range ?? DEFENSE_STATS.tower.range;
      const candidates = field.index.near(tower, range).filter(record => record.body.alive && hostile(s, faction.id, record.context.faction.id) && lineOfSight(s, tower, record.body, { maxRange: range, fromHeight: 4, toHeight: .65, factionId: faction.id, blockWater: true }));
      candidates.sort((a, b) => distance(tower, a.body) - distance(tower, b.body) || a.body.id.localeCompare(b.body.id));
      const target = candidates[0]; if (!target) continue;
      const costs = defenseAmmoCost(species), needs = survivalNeeds(factionOf(s, home.factionId));
      if (Object.entries(costs).some(([key, value]) => (home.stock[key] || 0) < value + (key === 'materials' ? 0 : (needs?.[key] || 0) * home.population * 2))) { tower.fireBlocked = 'Ammunition would consume the survival reserve'; continue; }
      const operator = crew[0], source = { id: tower.id, entity: tower, home, faction, species };
      const shots = [{ from: { x: tower.x, z: tower.z, height: species === 'human' ? 3.73 : 4.03 }, to: { x: target.body.x, z: target.body.z, height: .45 }, sourceIndex: 0, targetIndex: target.ordinal, sourceSoldierId: operator.id, shooterSoldierId: operator.id, targetSoldierId: target.body.id }];
      if (queueStrike(s, source, target.context, 'ranged', shots, tower.damage ?? DEFENSE_STATS.tower.damage, 'projectile', { tower: true, sourceHomeId: home.id, sourceSoldierId: operator.id, targetSoldierId: target.body.id })) {
        for (const [key, value] of Object.entries(costs)) { home.stock[key] -= value; ledgerAdd(s, key, 'consumed', value); }
        tower.nextAttackTime = clock(s) + (tower.cooldown ?? DEFENSE_STATS.tower.cooldown); tower.lastAttackTime = clock(s); tower.fireBlocked = null;
        for (const body of crew) { body.lastAttackTime = clock(s); body.attackReadyAt = Math.max(body.attackReadyAt || 0, tower.nextAttackTime); body.cooldown = body.attackReadyAt - clock(s); }
        s.stats.towerShots = (s.stats.towerShots || 0) + 1;
      }
    }
  }
}

export function initializeSoldierPositions(s) {
  for (const home of s.settlements) {
    if (!aliveHome(home)) continue;
    const cs = status(home); cs.units = { ...availableMilitary(s, home) };
    updateCombatFormation(s, home, cs.units, 0, { x: cs.x ?? home.x, z: cs.z ?? home.z });
  }
  for (const g of s.groups) if (g.kind === 'army' && !g.finished && !g.militaryReturned) {
    status(g); updateCombatFormation(s, g, g.units, 0);
  }
}

export function stepCombat(s, dt = .1, hooks = {}) {
  initialize(s); initializeSoldierPositions(s);
  if (!(dt > 0)) return;
  const time = clock(s);
  if (s.lastCombatTime === time) return; s.lastCombatTime = time;
  const due = s.pendingCombat.filter(p => p.impactTime <= time + 1e-8);
  s.pendingCombat = s.pendingCombat.filter(p => p.impactTime > time + 1e-8);
  for (const strike of due) impact(s, strike, hooks);
  scoutOpportunities(s, hooks);
  for (const home of s.settlements) if (home.buildings?.some(b => b.kind === 'tower')) assignDefenses(s, home, factionOf(s, home.factionId));
  for (const town of s.settlements) if (town.combat) town.combat.active = false;
  const engagements = [], objectives = new Map();
  for (const g of s.groups.filter(canFight).sort((a, b) => a.id.localeCompare(b.id))) {
    const engagement = acquire(s, g, hooks);
    if (engagement) { engagements.push([g, engagement]); objectives.set(g.id, engagement.target); }
  }
  const contacts = s.groups.filter(g => g.kind === 'army' && !g.finished && g.size > 0 || g.kind === 'scout' && !g.finished && g.size > 0 && g.phase === 'outbound');
  for (const town of s.settlements) {
    if (!aliveHome(town) || !countMilitary(availableMilitary(s, town))) continue;
    const attackers = contacts.flatMap(g => {
      if (!permittedTarget(s, town, g)) return [];
      const observed = physicalObservation(s, town, g, 18);
      if (!observed.visible) return [];
      return [g.kind === 'army' ? { ...g, x: observed.x, z: observed.z, units: observed.units, combat: status(g) } : g];
    });
    attackers.sort((a, b) => (a.kind === 'scout') - (b.kind === 'scout') || distance(a, town) - distance(b, town) || a.id.localeCompare(b.id));
    if (attackers.length) { setGarrison(s, town, attackers, dt); objectives.set(town.id, attackers[0]); }
    else if (town.combat) { town.combat.x = town.x; town.combat.z = town.z; }
  }
  for (const [g, { target: entity }] of engagements) {
    if (!canFight(g)) continue;
    const source = combatant(s, g);
    const target = entity.kind === 'army' || 'population' in entity ? combatant(s, entity, 'population' in entity) : { entity, units: { infantry: 0, ranged: 0 }, x: entity.x, z: entity.z };
    if (source && target) advance(s, source, target, dt);
  }
  const contexts = [];
  for (const entity of [...s.groups.filter(g => g.kind === 'army' && !g.finished && !g.militaryReturned), ...s.settlements.filter(aliveHome)]) {
    const context = combatant(s, entity, 'population' in entity); if (!context) continue;
    const cs = status(entity), dx = entity.x - (entity.prevX ?? entity.x), dz = entity.z - (entity.prevZ ?? entity.z);
    if (!cs.active) cs.yaw = Math.hypot(dx, dz) > .0001 ? Math.atan2(dx, dz) : Math.atan2((entity.targetX ?? entity.x) - entity.x, (entity.targetZ ?? entity.z) - entity.z);
    context.objective = objectives.get(entity.id);
    // A rally order preserves the march, but does not make an exposed crew
    // already inside a soldier's weapon reach untouchable. These contacts never
    // become pursuit goals and cannot bypass the normal individual weapon clock.
    if (entity.strategicHold && canFight(entity)) context.economicContacts = s.groups.filter(worker => worker.kind === 'worker' && !worker.finished && worker.size > 0 && permittedTarget(s, entity, worker) && sees(s, entity, worker, 16));
    if (context.economicContacts && !(entity.combat?.enemyStrength > 0)) for (const home of s.settlements) {
      if (!permittedTarget(s, entity, home)) continue;
      for (const b of home.buildings || []) if (ECONOMIC_TARGETS.has(b.kind) && liveStructure(b) && sees(s, entity, b, 16)) context.economicContacts.push(structureTarget(s, home, b));
    }
    contexts.push(context);
  }
  const field = stepIndividualCombat(s, contexts, dt, {
    permitted: (source, target) => permittedTarget(s, source.entity, target.entity), structureContact,
    damageScale: fireScale,
    attack: (source, target) => soldierAttack(s, source, target), attackStructure: (source, target) => assaultStructure(s, source, target),
    attackWorker: (source, target) => attackWorker(s, source, target, hooks),
  });
  for (const [g, { target }] of engagements) {
    const source = combatant(s, g); if (!source || !canFight(g)) continue;
    if (target.kind === 'worker') raidWorker(s, source, target);
    else if (target.kind === 'scout') interceptScout(s, source, target, hooks);
  }
  for (const town of s.settlements) if (objectives.get(town.id)?.kind === 'scout') interceptScout(s, combatant(s, town, true), objectives.get(town.id), hooks);
  fireTowers(s, field);
  s.combatActive = engagements.length;
}
