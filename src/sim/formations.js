import { distance } from '../shared.js';
import { terrainAt } from '../world.js';
import { MILITARY_ROLES, countMilitary, unitStats } from './military.js';
import { isSegmentTraversable, lineOfSight, navigationDiagnostics } from './navigation.js';
import { settlementController, groupController } from './control.js';
import { getSoldiers } from './soldiers.js';

const amount = x => Math.max(0, Math.floor(Number.isFinite(x) ? x : 0));
const ownerOf = (s, entity) => 'population' in entity ? settlementController(s, entity) : groupController(s, entity);
const rolesOf = entity => entity.units || entity.combat?.units || { infantry: amount(entity.size ?? entity.soldiers), ranged: 0 };
const baseOf = (entity, options) => ({ x: options.x ?? entity.combat?.x ?? entity.x, z: options.z ?? entity.combat?.z ?? entity.z });
const BODY_SPACE = .46, BODY_RADIUS = .16, CELL = .8;
const collisionWorlds = new WeakMap();
const segmentCaches = new WeakMap();
const sq = (a, b) => (a.x - b.x) ** 2 + (a.z - b.z) ** 2;
const cellKey = (x, z) => (x + 8192) * 16384 + z + 8192;
const pointKey = p => cellKey(Math.floor(p.x / CELL), Math.floor(p.z / CELL));
const shortestAngle = angle => Math.atan2(Math.sin(angle), Math.cos(angle));

// One shared local index includes both armies and deployed garrisons. It knows
// physical bodies, never enemy orders or hidden combat strength. Updating it as
// each soldier moves also prevents later squads walking through earlier ones.
function physicalWorld(s) {
  const stamp = `${s.step ?? s.tick ?? 0}:${s.time ?? 0}`;
  let world = collisionWorlds.get(s);
  if (world?.stamp === stamp && world.groups === s.groups && world.homes === s.settlements) return world;
  world = { stamp, groups: s.groups, homes: s.settlements, bins: new Map(), records: new Map() };
  collisionWorlds.set(s, world);
  for (const entity of [...(s.groups || []), ...(s.settlements || [])]) {
    if (!entity.formationSlots || entity.finished || entity.militaryReturned || (!('population' in entity) && entity.kind !== 'army')) continue;
    const units = rolesOf(entity);
    for (const role of MILITARY_ROLES) for (let i = 0; i < Math.min(amount(units[role]), entity.formationSlots[role]?.length || 0); i++) addBody(world, entity, role, i, entity.formationSlots[role][i]);
  }
  return world;
}
function addBody(world, entity, role, ordinal, body) {
  let record = world.records.get(body);
  if (!record) { record = { entity, role, ordinal, body }; world.records.set(body, record); }
  Object.assign(record, { entity, role, ordinal });
  record.key = pointKey(body);
  record.cellX = Math.floor(body.x / CELL); record.cellZ = Math.floor(body.z / CELL);
  if (!world.bins.has(record.key)) world.bins.set(record.key, new Set());
  world.bins.get(record.key).add(record);
}
function removeBody(world, body) { const record = world.records.get(body); if (record) world.bins.get(record.key)?.delete(record); }
function liveBody(record) {
  const { entity, role, ordinal, body } = record;
  return body.alive !== false && !entity.finished && !entity.militaryReturned && entity.formationSlots?.[role]?.[ordinal] === body;
}
function nearby(world, point, radius, visit, candidates = null) {
  const x0 = Math.floor((point.x - radius) / CELL), x1 = Math.floor((point.x + radius) / CELL), z0 = Math.floor((point.z - radius) / CELL), z1 = Math.floor((point.z + radius) / CELL);
  if (candidates) {
    // Filtering one larger ordered rectangle preserves exactly the original
    // cell/Set traversal order for each smaller steering query.
    for (const record of candidates) if (record.cellX >= x0 && record.cellX <= x1 && record.cellZ >= z0 && record.cellZ <= z1 && liveBody(record) && visit(record) === false) return false;
    return true;
  }
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) for (const record of world.bins.get(cellKey(x, z)) || []) if (liveBody(record) && visit(record) === false) return false;
  return true;
}
function cachedSegments(s, body, physical, version) {
  let cache = segmentCaches.get(s);
  if (!cache || cache.version !== version || cache.seed !== s.seed) {
    cache = { version, seed: s.seed, bodies: new WeakMap() }; segmentCaches.set(s, cache);
  }
  let entry = cache.bodies.get(body);
  if (!entry) { entry = { x: body.x, z: body.z, factionId: physical.factionId, radius: physical.radius, ready: false, points: new Map() }; cache.bodies.set(body, entry); }
  else if (entry.x !== body.x || entry.z !== body.z || entry.factionId !== physical.factionId || entry.radius !== physical.radius) {
    entry.x = body.x; entry.z = body.z; entry.factionId = physical.factionId; entry.radius = physical.radius; entry.ready = false; entry.points.clear();
  } else entry.ready = true;
  // Moving bodies retain the direct path. Stationary bodies can reuse exact
  // failed steering/anchor rays until position or wall permissions change.
  if (!entry.ready) return point => isSegmentTraversable(s, body, point, physical);
  return point => {
    const key = `${point.x}:${point.z}`;
    if (entry.points.has(key)) return entry.points.get(key);
    const clear = isSegmentTraversable(s, body, point, physical);
    entry.points.set(key, clear);
    if (entry.points.size > 128) entry.points.delete(entry.points.keys().next().value);
    return clear;
  };
}
function pointClear(world, point, self, spacing = BODY_SPACE) {
  return nearby(world, point, spacing, record => record.body === self || sq(point, record.body) >= spacing * spacing - 1e-9);
}
function relativeClosest(dx, dz, vx, vz) {
  const v2 = vx * vx + vz * vz, t = v2 ? Math.max(0, Math.min(1, -(dx * vx + dz * vz) / v2)) : 0;
  return (dx + vx * t) ** 2 + (dz + vz * t) ** 2;
}
function stepClear(world, body, point, candidates = null) {
  const vx = point.x - body.x, vz = point.z - body.z, radius = Math.hypot(vx, vz) + BODY_SPACE + .65;
  return nearby(world, body, radius, record => {
    const peer = record.body; if (peer === body) return true;
    const before = sq(body, peer), minimum = Math.min(BODY_SPACE * BODY_SPACE, before);
    // The swept segment prevents tunnelling. The relative segment checks the
    // same interpolation alpha for soldiers already advanced in this pulse.
    if (relativeClosest(body.x - peer.x, body.z - peer.z, vx, vz) < minimum - 1e-8) return false;
    if (record.movedStamp === world.stamp) {
      const px = peer.prevX ?? peer.x, pz = peer.prevZ ?? peer.z;
      const start = (body.x - px) ** 2 + (body.z - pz) ** 2;
      if (relativeClosest(body.x - px, body.z - pz, vx - peer.x + px, vz - peer.z + pz) < Math.min(BODY_SPACE * BODY_SPACE, start) - 1e-8) return false;
    }
    return true;
  }, candidates);
}

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
    const alpha = Math.max(0, Math.min(1, options.alpha ?? 1)), physicalYaw = physical.yaw ?? yaw, oldYaw = physical.prevYaw ?? physicalYaw;
    return { x: (physical.prevX ?? physical.x) + (physical.x - (physical.prevX ?? physical.x)) * alpha, z: (physical.prevZ ?? physical.z) + (physical.z - (physical.prevZ ?? physical.z)) * alpha,
      yaw: oldYaw + shortestAngle(physicalYaw - oldYaw) * alpha, role, index, physical: true, soldierId: physical.id,
      movementDistance: Math.hypot(physical.x - (physical.prevX ?? physical.x), physical.z - (physical.prevZ ?? physical.z)) };
  }
  const roleCount = amount(units[role]), row = Math.floor(ordinal / shape.columns), rowCount = Math.min(shape.columns, roleCount - row * shape.columns);
  const side = (ordinal % shape.columns - (rowCount - 1) / 2) * .62;
  const rank = role === 'infantry' ? row : shape.infantryRows + row;
  const forward = shape.depth / 2 - .29 - rank * .58 - (role === 'ranged' && shape.infantryRows ? .42 : 0);
  return { x: base.x + side * Math.cos(yaw) + forward * Math.sin(yaw), z: base.z - side * Math.sin(yaw) + forward * Math.cos(yaw), yaw, role, index, side, forward };
}

function deployBody(s, world, desired, center, yaw, physical) {
  let point = null;
  const valid = candidate => pointClear(world, candidate) && isSegmentTraversable(s, center, candidate, physical);
  if (valid(desired)) point = desired;
  // Fill connected space around the intended rank. The fixed lattice is a
  // placement search, not animation noise; no body receives a random offset.
  for (let ring = 1; ring <= 24 && !point; ring++) {
    let best = Infinity;
    for (let side = -ring; side <= ring; side++) for (const forward of [-ring, ring]) {
      const candidate = { x: desired.x + side * .5 * Math.cos(yaw) + forward * .5 * Math.sin(yaw), z: desired.z - side * .5 * Math.sin(yaw) + forward * .5 * Math.cos(yaw) };
      const score = sq(candidate, desired) + sq(candidate, center) * .03;
      if (score < best && valid(candidate)) { point = candidate; best = score; }
    }
    for (let forward = -ring + 1; forward < ring; forward++) for (const side of [-ring, ring]) {
      const candidate = { x: desired.x + side * .5 * Math.cos(yaw) + forward * .5 * Math.sin(yaw), z: desired.z - side * .5 * Math.sin(yaw) + forward * .5 * Math.cos(yaw) };
      const score = sq(candidate, desired) + sq(candidate, center) * .03;
      if (score < best && valid(candidate)) { point = candidate; best = score; }
    }
  }
  // A physically full deployment area cannot invent room. Retain a bounded
  // connected fallback; ordinary legal deployments always find a lattice slot.
  point ??= center;
  return { x: point.x, z: point.z, prevX: point.x, prevZ: point.z, yaw, prevYaw: yaw };
}

function localTargets(options) {
  const descriptors = (options.localTargets || []).filter(t => t && Number.isFinite(t.x) && Number.isFinite(t.z));
  const preferred = descriptors.find(t => t.id === options.primaryTargetId);
  // The primary contact sets the squad's march; each body can still face a
  // different locally observed attacker on its own side of the formation.
  const targets = (preferred ? [preferred, ...descriptors.filter(t => t !== preferred)] : descriptors).slice(0, 6);
  const points = [], structures = [];
  for (const target of targets) {
    if (target.kind === 'structure') { structures.push(target); continue; }
    const slots = target.entity?.formationSlots ?? target.formationSlots, units = target.units ?? target.entity?.units ?? target.entity?.combat?.units;
    let present = false, index = 0;
    const frontRole = amount(units?.infantry) ? 'infantry' : 'ranged';
    for (const role of MILITARY_ROLES) for (let i = 0; i < amount(units?.[role]); i++, index++) {
      const point = slots?.[role]?.[i];
      if (point && role === frontRole) { points.push({ point, id: target.id, role, ordinal: i, index }); present = true; }
    }
    if (!present) points.push({ point: target, id: target.id, role: null, ordinal: 0, index: -1 });
  }
  return { points, structures };
}
function nearestContacts(targets, body) {
  const nearest = [];
  const add = target => {
    const d2 = sq(body, target.point);
    if (d2 > 24 * 24 || (nearest.length === 6 && d2 >= nearest[5].d2)) return;
    let i = nearest.length;
    while (i && nearest[i - 1].d2 > d2) i--;
    nearest.splice(i, 0, { ...target, d2 }); if (nearest.length > 6) nearest.pop();
  };
  for (const target of targets.points) add(target);
  for (const target of targets.structures) {
    const wall = target.entity ?? target, angle = wall.rotation ?? 0, half = (wall.length ?? 7) * .5;
    if (!['wall', 'gate'].includes(target.structureKind ?? wall.structureKind ?? wall.kind)) {
      add({ point: { x: target.x, z: target.z, id: target.id }, id: target.id, structure: true, width: (target.radius ?? wall.radius ?? .6) * 2, index: -1 });
      continue;
    }
    const a = wall.from ?? wall.wallStart ?? { x: target.x - Math.cos(angle) * half, z: target.z + Math.sin(angle) * half };
    const b = wall.to ?? wall.wallEnd ?? { x: target.x + Math.cos(angle) * half, z: target.z - Math.sin(angle) * half };
    const dx = b.x - a.x, dz = b.z - a.z, d2 = dx * dx + dz * dz, t = d2 ? Math.max(0, Math.min(1, ((body.x - a.x) * dx + (body.z - a.z) * dz) / d2)) : 0;
    add({ point: { x: a.x + t * dx, z: a.z + t * dz, id: target.id }, id: target.id, structure: true, width: wall.width ?? 1, index: -1 });
  }
  return nearest;
}
function attackLane(s, from, target, role, range, physical) {
  if (!lineOfSight(s, from, target.point, { factionId: physical.factionId, fromHeight: .7, toHeight: .65, maxRange: range, blockWater: true, ignoreWallId: target.structure ? target.id : undefined })) return false;
  return role !== 'infantry' || isSegmentTraversable(s, from, target.point, { ...physical, radius: .08, ignoreWallId: target.structure ? target.id : undefined });
}
function contactGoal(s, world, body, role, spec, targets, center, shape, physical, reservations) {
  const contacts = nearestContacts(targets, body);
  if (!contacts.length) return null;
  const ranged = role === 'ranged', low = ranged ? spec.range * (body.contactHolding ? .59 : .70) : BODY_SPACE + .05, high = ranged ? spec.range * .9 : spec.range * .93;
  // Once a reachable attack position is occupied, hold it. This dead band and
  // target hysteresis keep local movement purposeful instead of constant jitter.
  const held = contacts.find(t => t.id === body.contactId && t.index === body.contactIndex) ?? contacts[0];
  if ((!ranged || contacts[0].d2 >= low * low) && held.d2 >= low * low && held.d2 <= high * high && attackLane(s, body, held, role, spec.range, physical)) {
    body.contactId = held.id; body.contactIndex = held.index; body.facingX = held.point.x; body.facingZ = held.point.z;
    body.contactHolding = true;
    return body;
  }
  body.contactHolding = false;
  const leash = Math.max(7, shape.depth * .5 + shape.width * .35 + 4);
  let best = null, score = Infinity, selected = null;
  for (const target of contacts) {
    if (ranged && contacts[0].d2 < low * low && target !== contacts[0]) continue;
    const reach = ranged ? spec.range * .74 : Math.max((target.width || 0) * .5 + BODY_RADIUS + .08, spec.range * .7);
    const angle = Math.atan2(body.z - target.point.z, body.x - target.point.x);
    for (const turn of [0, .38, -.38, .76, -.76, 1.14, -1.14, 1.52, -1.52]) {
      const point = { x: target.point.x + Math.cos(angle + turn) * reach, z: target.point.z + Math.sin(angle + turn) * reach };
      const candidateScore = sq(body, point) + Math.abs(turn) * .15 + (target.id === body.contactId && target.index === body.contactIndex ? -.18 : 0);
      if (candidateScore >= score || sq(point, center) > leash * leash || !pointClear(world, point, body, BODY_SPACE + .02)) continue;
      if (reservations.some(p => sq(p, point) < .25) || !isSegmentTraversable(s, body, point, physical) || !attackLane(s, point, target, role, spec.range, physical)) continue;
      score = candidateScore; best = point; selected = target;
    }
    if (best && score < .25) break;
  }
  const target = selected ?? contacts[0];
  body.contactId = target.id; body.contactIndex = target.index; body.facingX = target.point.x; body.facingZ = target.point.z;
  if (best) { reservations.push(best); return best; }
  // A packed front can advance toward its nearest contact and steer around
  // shoulders. Obstacles still veto every movement segment below.
  const d = Math.sqrt(target.d2) || 1, reach = ranged ? spec.range * .74 : spec.range * .7;
  const fallback = { x: target.point.x + (body.x - target.point.x) / d * reach, z: target.point.z + (body.z - target.point.z) / d * reach };
  const spread = distance(fallback, center);
  if (spread > leash) { fallback.x = center.x + (fallback.x - center.x) / spread * leash; fallback.z = center.z + (fallback.z - center.z) / spread * leash; }
  return fallback;
}

// Tactical callers supply only locally visible targets. Soldiers use bounded
// local candidate positions and their squad's existing route; none run A*.
export function updateCombatFormation(s, entity, units, dt = .1, options = {}) {
  const soldiers = getSoldiers(s, entity, { excludeTowerCrew: options.excludeTowerCrew ?? false });
  // Slots are a view of the serving roster, never a source of replacement bodies.
  const previous = entity.formationSlots, next = { infantry: [], ranged: [] };
  for (const body of soldiers) next[body.role].push(body);
  const sameMembership = previous && MILITARY_ROLES.every(role => previous[role]?.length === next[role].length && previous[role].every((body, i) => body === next[role][i]));
  if (!sameMembership) entity.formationSlots = next;
  if (!(dt > 0) && sameMembership && soldiers.every(body => body.positioned)) return;
  const center = { x: options.x ?? entity.x, z: options.z ?? entity.z };
  const yaw = options.yaw ?? entity.combat?.yaw ?? Math.atan2((entity.targetX ?? center.x) - center.x, (entity.targetZ ?? center.z) - center.z);
  const shape = formationSize(units), physical = { factionId: ownerOf(s, entity), radius: BODY_RADIUS };
  const faction = s.factions?.find(f => f.id === physical.factionId), species = s.factions?.find(f => f.id === entity.factionId)?.species ?? faction?.species;
  const targets = options.contact ? localTargets(options) : null, reservations = [];
  // A short history of the squad's actual connected route lets a lagging flank
  // find the entrance after its center has already passed through a narrow gate.
  // This is shared physical history, not a route search for each soldier.
  if (!entity.formationTrail || (dt > 0 && distance(entity.formationTrail.at(-1), center) >= .45)) {
    entity.formationTrail ??= [];
    entity.formationTrail.push({ ...center });
    if (entity.formationTrail.length > 48) entity.formationTrail.shift();
  }
  const world = physicalWorld(s);
  if (!sameMembership) for (const role of MILITARY_ROLES) {
    const members = new Set(entity.formationSlots[role]);
    for (const body of previous?.[role] || []) if (!members.has(body)) removeBody(world, body);
  }
  const topologyVersion = dt > 0 ? navigationDiagnostics(s).topologyVersion : 0;
  let index = 0, changed = false;
  for (const role of MILITARY_ROLES) {
    const slots = entity.formationSlots[role], count = slots.length, spec = unitStats(species, role, faction);
    for (let i = count; i < slots.length; i++) removeBody(world, slots[i]);
    if (slots.length > count) { slots.length = count; changed = true; }
    for (let ordinal = 0; ordinal < count; ordinal++, index++) {
      let body = slots[ordinal];
      const plan = options.individualPlans?.get(body.id);
      const rank = body.positioned && plan ? plan.goal : combatFormationSlot(entity, index, { units, ...center, yaw, physical: false });
      if (!body.positioned) { removeBody(world, body); Object.assign(body, deployBody(s, world, rank, center, yaw, physical), { positioned: true }); addBody(world, entity, role, ordinal, body); changed = true; }
      else if (!world.records.has(body)) addBody(world, entity, role, ordinal, body);
      else Object.assign(world.records.get(body), { entity, role, ordinal });
      if (!(dt > 0)) continue;
      body.prevX = body.x; body.prevZ = body.z; body.prevYaw = body.yaw ?? yaw;
      body.vx = 0; body.vz = 0;
      const traversable = cachedSegments(s, body, physical, topologyVersion);
      let desired = plan?.goal ?? (targets ? contactGoal(s, world, body, role, spec, targets, center, shape, physical, reservations) : null);
      const inContact = plan ? !!plan.facing : !!desired;
      desired ??= rank;
      if (!inContact || plan) {
        delete body.contactId; delete body.contactIndex; delete body.contactHolding; delete body.facingX; delete body.facingZ;
        // Follow the shared route through a pass before spreading back into a
        // rank. Only already-computed squad waypoints can be used here.
        if (sq(body, desired) > .04 && !traversable(desired)) {
          const route = entity.navigation, anchors = [center, ...entity.formationTrail.slice().reverse(), ...(route?.waypoints || []).slice(Math.max(0, (route?.index || 0) - 1), (route?.index || 0) + 1)];
          const anchor = anchors.find(point => sq(body, point) > .04 && traversable(point));
          if (anchor) desired = anchor;
        }
      }
      const dx = desired.x - body.x, dz = desired.z - body.z, remaining = Math.hypot(dx, dz);
      const facing = plan?.facing ? Math.atan2(plan.facing.x - body.x, plan.facing.z - body.z) : inContact ? Math.atan2(body.facingX - body.x, body.facingZ - body.z) : yaw;
      body.yaw = Number.isFinite(facing) ? facing : yaw;
      if (remaining < .035) { world.records.get(body).movedStamp = world.stamp; changed = true; continue; }
      const pulse = s.step ?? s.tick ?? 0;
      if (body.movementStep == null || pulse < body.movementStep || pulse - body.movementStep >= 5) { body.movementFactor = terrainAt(body.x, body.z, s.seed).movement; body.movementStep = pulse; }
      const pace = plan?.speed ?? (inContact ? spec.speed : (options.speed ?? entity.speed ?? spec.speed) + .9);
      const step = Math.min(remaining, Math.max(0, pace * Math.max(.18, body.movementFactor)) * Math.min(dt, .1));
      const candidates = [];
      nearby(world, body, step + BODY_SPACE + .65 + 1e-9, record => { candidates.push(record); });
      let rx = 0, rz = 0;
      nearby(world, body, .72, record => {
        const peer = record.body, d2 = sq(body, peer);
        if (peer !== body && d2 > .000001 && d2 < .72 ** 2) { const d = Math.sqrt(d2), force = (.72 - d) * .8 / d; rx += (body.x - peer.x) * force; rz += (body.z - peer.z) * force; }
      }, candidates);
      const heading = Math.atan2(dz / remaining + rz, dx / remaining + rx), side = body.steerSide ?? (ordinal % 2 ? -1 : 1);
      let next = null, score = -step * .05;
      for (const fraction of [1, .5]) {
        for (const turn of [0, .45 * side, -.45 * side, .9 * side, -.9 * side, 1.35 * side, -1.35 * side, 1.65 * side, -1.65 * side]) {
          const point = { x: body.x + Math.cos(heading + turn) * step * fraction, z: body.z + Math.sin(heading + turn) * step * fraction };
          const progress = remaining - distance(point, desired) - Math.abs(turn) * .012;
          if (progress <= score || !stepClear(world, body, point, candidates) || !traversable(point)) continue;
          score = progress; next = point;
          if (turn === 0) break;
        }
        if (next) break;
      }
      if (next) {
        removeBody(world, body);
        body.x = next.x; body.z = next.z;
        if (!inContact) body.yaw = Math.atan2(body.x - body.prevX, body.z - body.prevZ);
        const cross = dx * (body.z - body.prevZ) - dz * (body.x - body.prevX);
        if (Math.abs(cross) > .001) body.steerSide = Math.sign(cross);
        addBody(world, entity, role, ordinal, body);
      }
      world.records.get(body).movedStamp = world.stamp; changed = true;
      body.vx = (body.x - body.prevX) / dt; body.vz = (body.z - body.prevZ) / dt;
    }
  }
  if (changed) entity.formationRevision = (entity.formationRevision || 0) + 1;
}
