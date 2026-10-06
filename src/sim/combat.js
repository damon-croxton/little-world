import { clamp, distance, emit } from '../shared.js';
import { terrainAt } from '../world.js';
import { MILITARY_ROLES, availableMilitary, countMilitary, applyMilitaryCasualties, unitStats } from './military.js';
import { visibleToGroup, lineOfSight } from './knowledge.js';
import { moveAlongRoute, isSegmentTraversable, isPointTraversable, invalidateNavigation } from './navigation.js';
import { ledgerAdd, SURVIVAL_NEEDS } from './economy.js';
import { factionController, settlementController, groupController } from './control.js';
import { DEFENSE_STATS, defenseAmmoCost, assignDefenses } from './defenses.js';

// Tactical decisions are made by squads, while every rendered slot is one real
// trained citizen. Wounds are pooled within a role; each complete health unit
// removes exactly one citizen through the military ledger. There are no victory
// dice, invented soldiers, or visual attacks unrelated to actual damage orders.
export const COMBAT_LIMITS = Object.freeze({ effects: 512, pending: 256, infantryFrontage: 18, rangedFrontage: 24, effectSeconds: 2.8 });
const aliveHome = p => p && p.population > 0 && p.health > 0 && !['camp', 'ruin'].includes(p.status);
export const canFight = g => !!g && g.kind === 'army' && !g.finished && !g.disabled && g.size > 0 && !['retreating', 'returning', 'disabled'].includes(g.phase);
const factionOf = (s, id) => s.factions.find(f => f.id === id);
const ownerOf = (s, entity) => 'population' in entity ? settlementController(s, entity) : groupController(s, entity);
const homeOf = (s, g) => s.settlements.find(p => p.id === g.originId);
const hostile = (s, a, b) => { a = factionController(s, a); b = factionController(s, b); return a !== b && factionOf(s, a)?.relations?.[b]?.status === 'hostile'; };
const clock = s => Number.isFinite(s.time) ? s.time : s.tick;
const amount = x => Math.max(0, Math.floor(Number.isFinite(x) ? x : 0));
const liveStructure = b => b && ['wall', 'gate', 'tower'].includes(b.kind) && b.progress >= 1 && !b.destroyed && (b.hp ?? b.health ?? 1) > 0;
const rolesOf = entity => entity.units || entity.combat?.units || { infantry: amount(entity.size ?? entity.soldiers), ranged: 0 };
const baseOf = (entity, options) => ({ x: options.x ?? entity.combat?.x ?? entity.x, z: options.z ?? entity.combat?.z ?? entity.z });

export function formationSize(units) {
  const total = countMilitary(units), columns = Math.min(12, Math.max(3, Math.ceil(Math.sqrt(Math.max(1, total) * .85))));
  const infantryRows = Math.ceil(amount(units?.infantry) / columns), rangedRows = Math.ceil(amount(units?.ranged) / columns);
  return { total, columns, infantryRows, rangedRows, depth: Math.max(1, infantryRows + rangedRows) * .58 + (infantryRows && rangedRows ? .42 : 0), width: columns * .62 };
}

// This is the single slot contract used by firing, casualties, and crowd meshes.
// Infantry occupy the front ranks; ranged bodies stand behind the same front.
export function combatFormationSlot(entity, index, options = {}) {
  const units = options.units || rolesOf(entity), shape = formationSize(units), base = baseOf(entity, options);
  const yaw = options.yaw ?? entity.combat?.yaw ?? Math.atan2((entity.targetX ?? base.x) - base.x, (entity.targetZ ?? base.z) - base.z);
  const role = index < amount(units.infantry) ? 'infantry' : 'ranged';
  const ordinal = role === 'infantry' ? index : index - amount(units.infantry);
  const physical = entity.formationSlots?.[role]?.[ordinal];
  if (physical && options.physical !== false) {
    const alpha = options.alpha ?? 1;
    return { x: (physical.prevX ?? physical.x) + (physical.x - (physical.prevX ?? physical.x)) * alpha, z: (physical.prevZ ?? physical.z) + (physical.z - (physical.prevZ ?? physical.z)) * alpha, yaw, role, index, physical: true };
  }
  const roleCount = amount(units[role]), row = Math.floor(ordinal / shape.columns), rowCount = Math.min(shape.columns, roleCount - row * shape.columns);
  const side = (ordinal % shape.columns - (rowCount - 1) / 2) * .62;
  const rank = role === 'infantry' ? row : shape.infantryRows + row;
  const forward = shape.depth / 2 - .29 - rank * .58 - (role === 'ranged' && shape.infantryRows ? .42 : 0);
  return { x: base.x + side * Math.cos(yaw) + forward * Math.sin(yaw), z: base.z - side * Math.sin(yaw) + forward * Math.cos(yaw), yaw, role, index, side, forward };
}

// Each actual combat body stays on physical ground. Squad decisions remain
// batched, but a center crossing a narrow pass cannot drag its flank through a
// river or wall. Local steering needs no per-person global route search.
export function updateCombatFormation(s, entity, units, dt = .1, options = {}) {
  const center = { x: options.x ?? entity.x, z: options.z ?? entity.z };
  const yaw = options.yaw ?? entity.combat?.yaw ?? Math.atan2((entity.targetX ?? center.x) - center.x, (entity.targetZ ?? center.z) - center.z);
  entity.formationSlots ??= { infantry: [], ranged: [] };
  const bins = new Map(), cell = .6, key = (x, z) => (x + 8192) * 16384 + z + 8192, keyOf = p => key(Math.floor(p.x / cell), Math.floor(p.z / cell));
  const insert = p => { const key = keyOf(p); if (!bins.has(key)) bins.set(key, new Set()); bins.get(key).add(p); };
  const remove = p => bins.get(keyOf(p))?.delete(p);
  const neighbors = p => { const result = [], x = Math.floor(p.x / cell), z = Math.floor(p.z / cell); for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) result.push(...(bins.get(key(x + dx, z + dz)) || [])); return result; };
  const clearance = p => { const x = Math.floor(p.x / cell), z = Math.floor(p.z / cell); for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) for (const q of bins.get(key(x + dx, z + dz)) || []) if ((p.x - q.x) ** 2 + (p.z - q.z) ** 2 < .1849) return false; return true; };
  for (const role of MILITARY_ROLES) for (const p of entity.formationSlots[role] || []) insert(p);
  let index = 0;
  for (const role of MILITARY_ROLES) {
    const count = amount(units[role]), slots = entity.formationSlots[role] ??= [];
    slots.length = Math.min(slots.length, count);
    for (let ordinal = 0; ordinal < count; ordinal++, index++) {
      const desired = combatFormationSlot(entity, index, { units, ...center, yaw, physical: false });
      let body = slots[ordinal];
      if (!body) {
        // Newly represented deployment slots start on connected home ground;
        // an obstructed rank forms up rather than appearing beyond a wall.
        let point = desired;
        if (!isSegmentTraversable(s, center, desired, { factionId: ownerOf(s, entity), radius: .12 }) || !clearance(desired)) {
          point = center;
          for (let t = .8; t >= .05; t -= .15) {
            const test = { x: center.x + (desired.x - center.x) * t, z: center.z + (desired.z - center.z) * t };
            if (clearance(test) && isSegmentTraversable(s, center, test, { factionId: ownerOf(s, entity), radius: .08 })) { point = test; break; }
          }
        }
        if (!clearance(point)) {
          let best = null, bestScore = Infinity;
          for (let ring = 1; ring <= 20 && !best; ring++) for (let k = 0; k < 16; k++) {
            const angle = k * Math.PI / 8 + index * .37, r = ring * .55;
            const candidate = { x: center.x + Math.cos(angle) * r, z: center.z + Math.sin(angle) * r };
            if (!clearance(candidate) || !isSegmentTraversable(s, center, candidate, { factionId: ownerOf(s, entity), radius: .08 })) continue;
            const score = distance(candidate, desired); if (score < bestScore) { best = candidate; bestScore = score; }
          }
          if (best) point = best;
        }
        body = slots[ordinal] = { x: point.x, z: point.z, prevX: point.x, prevZ: point.z }; insert(body);
      }
      body.prevX = body.x; body.prevZ = body.z;
      const dx = desired.x - body.x, dz = desired.z - body.z, remaining = Math.hypot(dx, dz);
      if (remaining < .025 || !(dt > 0)) continue;
      if (body.movementStep == null || (s.step ?? s.tick) - body.movementStep >= 5) { body.movementFactor = terrainAt(body.x, body.z, s.seed).movement; body.movementStep = s.step ?? s.tick; }
      const pace = (options.speed ?? entity.speed ?? 3) * Math.max(.18, body.movementFactor), step = Math.min(remaining, Math.max(.8, pace + .9) * dt);
      remove(body);
      let rx = 0, rz = 0;
      for (const peer of neighbors(body)) { const d = distance(body, peer); if (d < .57 && d > .001) { rx += (body.x - peer.x) / d * (.57 - d) * 2; rz += (body.z - peer.z) / d * (.57 - d) * 2; } }
      const heading = Math.atan2(dz + rz, dx + rx);
      let next = null, score = -Infinity;
      for (const turn of [0, .55, -.55, 1.1, -1.1, 1.6, -1.6]) {
        const point = { x: body.x + Math.cos(heading + turn) * step, z: body.z + Math.sin(heading + turn) * step };
        if (!clearance(point) || !isSegmentTraversable(s, body, point, { factionId: ownerOf(s, entity), radius: .08 })) continue;
        const progress = remaining - distance(point, desired) - Math.abs(turn) * .01;
        if (progress > score) { score = progress; next = point; }
        if (turn === 0 && rx === 0 && rz === 0) break;
      }
      if (next) { body.x = next.x; body.z = next.z; }
      insert(body);
    }
  }
  entity.formationRevision = (entity.formationRevision || 0) + 1;
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
function nearestTargetPosition(c, from) {
  const role = frontRole(c), start = roleStart(c, role), count = Math.min(amount(c.units[role]), formationSize(c.units).columns);
  let best = targetPosition(c), score = Infinity;
  for (let i = 0; i < count; i++) { const p = unitPosition(c, start + i), d = distance(from, p); if (d < score) { best = p; score = d; } }
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
  status(g).active = false;
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
    if (!liveStructure(building)) return;
    const old = building.hp ?? building.health ?? building.maxHp ?? 300;
    building.hp = Math.max(0, old - strike.damage); building.lastHitTime = clock(s);
    effect(s, { type: 'impact', sourceId: strike.sourceId, targetId: building.id, factionId: home.factionId, x: building.x, z: building.z, height: .9, damage: old - building.hp, structure: true });
    s.stats.structureDamage = (s.stats.structureDamage || 0) + old - building.hp;
    if (building.hp === 0) {
      building.destroyed = true; building.destroyedTick = s.tick; building.active = false; building.operational = false;
      invalidateNavigation(s); assignDefenses(s, home, factionOf(s, home.factionId));
      s.stats.structuresDestroyed = (s.stats.structuresDestroyed || 0) + 1;
      effect(s, { type: 'collapse', sourceId: strike.sourceId, targetId: building.id, factionId: home.factionId, x: building.x, z: building.z, structureKind: building.kind, expiresAt: clock(s) + 2.4 });
      emit(s, 'breach', `${home.name} lost a ${building.kind}; the broken structure no longer blocks or fires.`, home.factionId, { settlementId: home.id, buildingId: building.id, attackerId: strike.factionId });
    }
    return;
  }
  const entity = strike.targetKind === 'settlement' ? s.settlements.find(p => p.id === strike.targetId) : s.groups.find(g => g.id === strike.targetId);
  if (!entity || entity.finished || (strike.targetKind === 'settlement' && !aliveHome(entity))) return;
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
  const now = clock(s), travel = type === 'melee' ? .12 : clamp(Math.max(...shots.map(p => distance(p.from, p.to))) / 20, .18, .65);
  const e = effect(s, { type, sourceId: source.id, targetId: target.id, factionId: source.faction.id, species: source.species, role, shots, count: shots.length, impactTime: now + travel, ...extra });
  s.pendingCombat.push({ id: e.id, sourceId: source.id, targetId: target.id, targetKind: target.isHome ? 'settlement' : 'group', factionId: source.faction.id,
    rays: shots.map(p => ({ from: { ...p.from }, to: { ...p.to }, targetIndex: p.targetIndex })), targetRole: frontRole(target), targetIndices: shots.map(p => p.targetIndex).filter(Number.isInteger), damage, aim: { ...targetPosition(target) }, impactTime: now + travel, ...extra });
  const cs = status(source.entity); cs.exchangeStartedAt ??= now; cs.roleAttacks ??= {}; cs.roleAttacks[role] = { time: now, impactTime: now + travel, count: shots.length, targetId: target.id, indices: shots.map(p => p.sourceIndex) };
  s.stats.attacks = (s.stats.attacks || 0) + shots.length;
  if (type === 'projectile') s.stats.projectiles = (s.stats.projectiles || 0) + shots.length;
  return true;
}

function attack(s, source, target, role) {
  if (!source || !target || !source.units[role] || !countMilitary(target.units)) return;
  const cs = status(source.entity); cs.nextAttack ??= { infantry: 0, ranged: 0 };
  if (clock(s) + 1e-8 < (cs.nextAttack[role] ?? 0)) return;
  const spec = unitStats(source.species, role, source.faction), n = amount(source.units[role]), limit = role === 'infantry' ? COMBAT_LIMITS.infantryFrontage : COMBAT_LIMITS.rangedFrontage;
  const shots = [], start = roleStart(source, role), frontier = Math.min(n, role === 'infantry' ? formationSize(source.units).columns * 2 : n);
  for (let i = 0; i < Math.min(frontier, limit); i++) {
    const ordinal = role === 'ranged' ? Math.floor(i * frontier / Math.min(frontier, limit)) : i;
    const from = unitPosition(source, start + ordinal), to = nearestTargetPosition(target, from);
    if (distance(from, to) > spec.range || !lineOfSight(s, from, to, { maxRange: spec.range, fromHeight: .7, toHeight: .65, blockWater: true, factionId: source.faction.id })) continue;
    if (role === 'infantry' && !isSegmentTraversable(s, from, to, { factionId: source.faction.id, radius: .1 })) continue;
    shots.push({ from: { x: from.x, z: from.z, height: .58 }, to: { x: to.x, z: to.z, height: .45 }, sourceIndex: start + ordinal, targetIndex: to.index });
  }
  if (queueStrike(s, source, target, role, shots, shots.length * spec.damage * fireScale(source))) cs.nextAttack[role] = clock(s) + spec.cooldown;
}

function startEngagement(s, g, target, hooks) {
  const cs = status(g), first = !cs.active || cs.targetId !== target.id;
  cs.active = true; cs.targetId = target.id; cs.targetKind = target.kind === 'army' ? 'group' : target.kind === 'structure' ? 'structure' : 'settlement';
  cs.targetHomeId = target.homeId ?? null; cs.lastContactTime = clock(s);
  cs.yaw = Math.atan2(target.x - g.x, target.z - g.z); g.phase = 'engaging';
  if (first) {
    cs.engagedAt = clock(s); cs.originalSize = g.size; delete cs.exchangeStartedAt;
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
  if (!g.combat?.active) return;
  g.combat.active = false;
  if (g.phase === 'engaging') g.phase = 'outbound';
}
function acquire(s, g, hooks) {
  if (!canFight(g)) { if (g.combat) g.combat.active = false; return null; }
  if (broken(g)) { withdraw(s, g, hooks); return null; }
  const oldHome = g.combat?.targetKind === 'structure' && s.settlements.find(t => t.id === g.combat.targetHomeId);
  const oldBuilding = oldHome?.buildings?.find(b => b.id === g.combat.targetId);
  const old = g.combat?.active && (g.combat.targetKind === 'group' ? s.groups.find(t => t.id === g.combat.targetId) : oldBuilding ? { ...oldBuilding, structureKind: oldBuilding.kind, kind: 'structure', homeId: oldHome.id, factionId: settlementController(s, oldHome) } : s.settlements.find(t => t.id === g.combat.targetId));
  if (old && (old.kind === 'army' ? canFight(old) : old.kind === 'structure' ? liveStructure(oldBuilding) : aliveHome(old)) && hostile(s, groupController(s, g), old.kind === 'army' ? groupController(s, old) : old.kind === 'structure' ? old.factionId : settlementController(s, old)) && sees(s, g, old, 18)) return old;
  const candidates = s.groups.filter(t => canFight(t) && groupController(s, t) !== groupController(s, g) && hostile(s, groupController(s, g), groupController(s, t)) && sees(s, g, t, 15));
  candidates.sort((a, b) => distance(g, a) - distance(g, b) || a.id.localeCompare(b.id));
  let target = candidates[0];
  if (!target && g.targetId) {
    const town = s.settlements.find(t => t.id === g.targetId);
    const owner = town ? settlementController(s, town) : null;
    const relation = factionOf(s, groupController(s, g))?.relations?.[owner]?.status;
    if (aliveHome(town) && owner !== groupController(s, g) && !['allied', 'trade'].includes(relation)) {
      if (sees(s, g, town, 18)) target = town;
      else {
        const walls = (town.buildings || []).filter(b => liveStructure(b) && ['wall', 'gate'].includes(b.kind) && !b.open && visibleToGroup(s, g, b, 15));
        walls.sort((a, b) => distance(g, a) - distance(g, b) || a.id.localeCompare(b.id));
        if (walls[0]) target = { ...walls[0], structureKind: walls[0].kind, kind: 'structure', homeId: town.id, factionId: owner };
      }
    }
  }
  if (target) { startEngagement(s, g, target, hooks); return target; }
  clearEngagement(g); return null;
}
function setGarrison(s, town, attacker, dt) {
  const cs = status(town), yaw = Math.atan2(attacker.x - town.x, attacker.z - town.z), reach = Math.min(7, (town.radius ?? 8) * .5);
  const point = { x: town.x + Math.sin(yaw) * reach, z: town.z + Math.cos(yaw) * reach };
  cs.active = true; cs.initialGarrison ??= countMilitary(availableMilitary(s, town)); cs.targetId = attacker.id; cs.targetKind = 'group'; cs.yaw = yaw;
  cs.x ??= town.x; cs.z ??= town.z; cs.prevX = cs.x; cs.prevZ = cs.z;
  const travel = { x: cs.x, z: cs.z, factionId: settlementController(s, town), speed: 2.6 };
  moveAlongRoute(s, travel, point, { dt, speed: 2.6, arrival: .2 });
  cs.x = travel.x; cs.z = travel.z;
  cs.units = { ...availableMilitary(s, town) }; cs.units.ranged = Math.max(0, cs.units.ranged - (town.assigned?.towerCrew || 0)); cs.lastContactTime = clock(s);
  updateCombatFormation(s, town, cs.units, dt, { x: cs.x, z: cs.z, yaw: cs.yaw, speed: 2.6 });
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
function assaultObstacle(s, source, town) {
  const g = source.entity, cs = status(g), now = clock(s);
  if (!source.units.infantry || now < (cs.nextAttack?.infantry ?? 0)) return false;
  // Only physically observed nearby obstructions are attacked. Unseen walls
  // cannot become remote targets merely because the simulation stores them.
  const candidates = (town.buildings || []).filter(b => liveStructure(b) && ['wall', 'gate'].includes(b.kind) && !b.open && visibleToGroup(s, g, b, 12));
  candidates.sort((a, b) => distance(g, a) - distance(g, b) || a.id.localeCompare(b.id));
  const spec = unitStats(source.species, 'infantry', source.faction), shots = [];
  let obstacle;
  for (const b of candidates) {
    const half = (b.length ?? 7) / 2, dx = Math.cos(b.rotation ?? 0), dz = -Math.sin(b.rotation ?? 0);
    for (let i = 0; i < Math.min(source.units.infantry, formationSize(source.units).columns * 2, COMBAT_LIMITS.infantryFrontage); i++) {
      const from = unitPosition(source, i), t = clamp((from.x - b.x) * dx + (from.z - b.z) * dz, -half, half), to = { x: b.x + dx * t, z: b.z + dz * t, height: .7 };
      if (distance(from, to) <= spec.range + .5) shots.push({ from: { ...from, height: .6 }, to, sourceIndex: i });
    }
    if (shots.length) { obstacle = b; break; }
  }
  if (!obstacle) return false;
  const fake = { id: obstacle.id, units: { infantry: 1, ranged: 0 }, x: obstacle.x, z: obstacle.z, entity: obstacle, faction: factionOf(s, town.factionId) };
  if (queueStrike(s, source, fake, 'infantry', shots, shots.length * spec.damage * fireScale(source), 'melee', { targetKind: 'structure', homeId: town.id })) {
    cs.nextAttack.infantry = now + spec.cooldown; cs.obstacleId = obstacle.id; return true;
  }
  return false;
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
      if (queueStrike(s, source, target, 'ranged', shots, tower.damage ?? DEFENSE_STATS.tower.damage, 'projectile', { tower: true })) {
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
  const engagements = [];
  for (const g of s.groups.filter(canFight).sort((a, b) => a.id.localeCompare(b.id))) {
    const target = acquire(s, g, hooks); if (!target) continue;
    if (target.kind !== 'army' && target.kind !== 'structure' && (!target.combat?.active || distance(g, target) < distance(s.groups.find(a => a.id === target.combat.targetId) || g, target))) setGarrison(s, target, g, dt);
    engagements.push([g, target]);
  }
  for (const [g, entity] of engagements) {
    if (!canFight(g)) continue;
    const source = combatant(s, g);
    if (entity.kind === 'structure') {
      if (!source) continue;
      const town = s.settlements.find(h => h.id === entity.homeId);
      const target = { id: entity.id, entity, home: town, faction: factionOf(s, entity.factionId), units: { infantry: 0, ranged: 0 }, x: entity.x, z: entity.z, isHome: false };
      advance(s, source, target, dt); updateCombatFormation(s, g, g.units, dt, { yaw: g.combat.yaw }); assaultObstacle(s, source, town); continue;
    }
    const target = combatant(s, entity, entity.kind !== 'army');
    if (!source || !target) continue;
    advance(s, source, target, dt);
    updateCombatFormation(s, g, g.units, dt, { yaw: g.combat.yaw });
    const blocked = target.isHome && assaultObstacle(s, source, target.home);
    for (const role of MILITARY_ROLES) if (!(blocked && role === 'infantry')) attack(s, source, target, role);
  }
  for (const home of s.settlements) if (home.combat?.active && aliveHome(home)) {
    const enemy = s.groups.find(g => g.id === home.combat.targetId);
    if (!canFight(enemy) || !sees(s, { ...home, ...home.combat, commandFactionId: settlementController(s, home), kind: 'army' }, enemy, 18)) continue;
    const source = combatant(s, home, true), target = combatant(s, enemy);
    if (source && target) for (const role of MILITARY_ROLES) attack(s, source, target, role);
  }
  fireTowers(s);
  for (const g of s.groups) if (g.kind === 'army' && !g.finished && !g.disabled && !g.combat?.active && g.units) {
    const dx = g.x - (g.prevX ?? g.x), dz = g.z - (g.prevZ ?? g.z), yaw = g.combat?.active ? g.combat.yaw : Math.hypot(dx, dz) > .0001 ? Math.atan2(dx, dz) : Math.atan2((g.targetX ?? g.x) - g.x, (g.targetZ ?? g.z) - g.z);
    updateCombatFormation(s, g, g.units, dt, { yaw });
  }
  s.combatActive = engagements.length;
}
