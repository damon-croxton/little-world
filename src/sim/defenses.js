import { distance } from '../shared.js';
import { terrainAt } from '../world.js';
import { availableMilitary } from './military.js';
import { findPath, isSegmentTraversable, wallGeometry, blockingWallParts } from './navigation.js';
import { settlementController, groupController } from './control.js';

// Original, species-specific geometry is a renderer concern. These structures
// are physical funded records: incomplete/destroyed defenses never fire or
// obstruct navigation. Tower operators remain existing ranged military roles.
export const DEFENSE_STATS = Object.freeze({
  wall: { name: 'Perimeter wall', maxHp: 300, length: 7, width: 1, cost: { materials: 32, energy: 4 } },
  gate: { name: 'Controlled gate', maxHp: 240, length: 9, width: 1, gateWidth: 5, cost: { materials: 42, energy: 7 } },
  tower: { name: 'Watch tower', maxHp: 220, length: 3, width: 3, requiredCrew: 2, range: 15, damage: 32, cooldown: 2, cost: { materials: 68, energy: 18 } },
});

export function defenseCost(species, kind) {
  const base = DEFENSE_STATS[kind];
  if (!base) return null;
  const cost = { ...base.cost };
  if (species === 'machine') { cost.materials *= 1.1; cost.energy *= 1.5; }
  if (species === 'hive') { cost.food = cost.materials * .3; cost.materials *= .75; cost.energy *= .6; }
  return cost;
}

export function defenseAmmoCost(species) {
  return species === 'machine' ? { energy: .55, materials: .04 }
    : species === 'hive' ? { food: .25, water: .05 } : { materials: .12, energy: .05 };
}

export function isStandingDefense(building) {
  return !!DEFENSE_STATS[building.kind] && building.progress >= 1 && !building.destroyed && building.hp > 0;
}

export function assignDefenses(state, home, faction) {
  const active = home.population > 0 && !home.occupiedBy && !['camp', 'ruin'].includes(home.status);
  let ranged = active ? availableMilitary(state, home).ranged : 0;
  let crew = 0;
  for (const building of home.buildings || []) {
    if (!DEFENSE_STATS[building.kind]) continue;
    building.maxHp ??= DEFENSE_STATS[building.kind].maxHp;
    building.hp ??= building.maxHp;
    if (building.kind !== 'tower') continue;
    building.requiredCrew = DEFENSE_STATS.tower.requiredCrew;
    building.crewAssigned = active && isStandingDefense(building) ? Math.min(building.requiredCrew, ranged) : 0;
    ranged -= building.crewAssigned; crew += building.crewAssigned;
    building.operational = active && isStandingDefense(building) && building.crewAssigned === building.requiredCrew;
    building.inactiveReason = !active ? 'Settlement inactive' : !isStandingDefense(building) ? 'Construction unfinished or tower destroyed' : !building.operational ? 'Two trained ranged operators required' : null;
  }
  home.assigned ||= {};
  home.assigned.towerCrew = crew;
  return crew;
}

function freshKnown(faction, state) {
  return Object.values(faction.knowledge || {}).filter(report => report.reportedTick != null && report.reportedTick <= state.tick && report.observedTick <= report.reportedTick && state.tick - report.observedTick <= 240 && (report.confidence ?? 1) >= .35);
}

function knownObjective(state, home, faction) {
  const reports = freshKnown(faction, state);
  const hostile = reports.filter(report => report.kind === 'settlement' && report.ownerId && report.ownerId !== faction.id && report.status !== 'ruin' && distance(home, report) < 100)
    .sort((a, b) => distance(home, a) - distance(home, b))[0];
  if (hostile && (faction.relations?.[hostile.ownerId]?.status === 'hostile' || faction.traits?.aggression > .65)) {
    return { ...hostile, priority: 'threat', reason: 'Faces a fresh reported rival approach' };
  }
  const pass = reports.filter(report => report.kind === 'terrain' && report.terrainKind === 'pass' && distance(home, report) <= 45)
    .sort((a, b) => distance(home, a) - distance(home, b))[0];
  if (pass) return { ...pass, priority: 'pass', reason: 'Guards a surveyed narrow approach' };
  const resources = reports.filter(report => report.kind === 'resource' && (report.amountEstimate ?? report.abundanceEstimate ?? 0) > 160 && distance(home, report) >= 7 && distance(home, report) <= 34);
  resources.sort((a, b) => {
    const score = report => (report.resourceKind === 'materials' || report.resourceKind === (faction.species === 'machine' ? 'energy' : 'water') ? 1.5 : 1) * (report.richnessEstimate ?? .5) / (8 + distance(home, report));
    return score(b) - score(a) || String(a.id).localeCompare(String(b.id));
  });
  return resources.length ? { ...resources[0], priority: 'resource', reason: `Protects the reported ${resources[0].resourceKind} harvesting route` } : null;
}

const pointAlong = (origin, axis, amount) => ({ x: origin.x + axis.x * amount, z: origin.z + axis.z * amount });
function segmentDistance(point, from, to) {
  const dx = to.x - from.x, dz = to.z - from.z, length2 = dx * dx + dz * dz;
  const t = length2 ? Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.z - from.z) * dz) / length2)) : 0;
  return Math.hypot(point.x - from.x - dx * t, point.z - from.z - dz * t);
}
function screenSegment(anchor, side, rank = 0) {
  const forward = anchor.approach, axis = { x: -forward.z, z: forward.x }, halfGate = DEFENSE_STATS.gate.length * .5;
  const topologySlot = side ? `${side < 0 ? 'left' : 'right'}-${rank}` : 'gate';
  const node = (sign, index) => {
    const origin = pointAlong(anchor, axis, sign * halfGate);
    // A shallow return shelters the flanks without ever closing behind town.
    const wing = { x: axis.x * sign * Math.sqrt(1 - .18 ** 2) - forward.x * .18, z: axis.z * sign * Math.sqrt(1 - .18 ** 2) - forward.z * .18 };
    return pointAlong(origin, wing, index * DEFENSE_STATS.wall.length);
  };
  const from = side ? node(side, rank - 1) : node(-1, 0), to = side ? node(side, rank) : node(1, 0);
  const kind = side ? 'wall' : 'gate', stats = DEFENSE_STATS[kind];
  const join = (sign, index) => `${anchor.topologyId}:${sign < 0 ? 'left' : 'right'}:${index}`;
  return { kind, ...wallGeometry({ from, to, width: stats.width }), from, to, gateWidth: stats.gateWidth || 0, isGate: kind === 'gate',
    maxHp: stats.maxHp, hp: stats.maxHp, topologyId: anchor.topologyId, topologySlot,
    joins: { from: side ? join(side, rank - 1) : join(-1, 0), to: side ? join(side, rank) : join(1, 0) },
    approach: { ...forward }, targetReportId: anchor.targetReportId, defensiveObjective: anchor.defensiveObjective,
    placementReason: `${anchor.placementReason}; ${side ? 'extends the joined screen while leaving the rear open' : 'keeps a controlled friendly passage through the defended approach'}` };
}
function footprintClear(state, home, plan) {
  if (plan.kind === 'tower') return terrainAt(plan.x, plan.z, state.seed).traversable && !home.buildings.some(b => !b.destroyed && distance(b, plan) < 3.5);
  // Check the full wall footprint, not just its center on a riverbank.
  if (!isSegmentTraversable(state, plan.from, plan.to, { radius: .8, ignoreWalls: true })) return false;
  return !home.buildings.some(b => !b.destroyed && b.topologyId !== plan.topologyId && segmentDistance(b, plan.from, plan.to) < (DEFENSE_STATS[b.kind] ? 2.5 : 3.5));
}
function preservesFriendlyRoutes(state, home, faction, plans, anchor) {
  const buildings = [...home.buildings, ...plans.map((p, i) => ({ ...p, id: `${p.topologyId}:planned:${i}`, progress: 1 }))];
  const projected = { ...state, settlements: (state.settlements || [home]).map(p => p.id === home.id ? { ...p, buildings } : p) };
  const options = { factionId: faction.id, radius: .35, maxExpansions: 1024, arrival: .5 };
  const outside = pointAlong(anchor, anchor.approach, 5);
  if (!findPath(projected, home, outside, options).reachable) return false;
  // Known extraction destinations and real friendly parties are the routes a
  // new segment must preserve. No hidden rival information enters placement.
  const destinations = freshKnown(faction, state).filter(r => r.kind === 'resource' && distance(home, r) < 40)
    .sort((a, b) => distance(home, a) - distance(home, b) || String(a.id).localeCompare(String(b.id))).slice(0, 8);
  for (const group of state.groups || []) if (!group.finished && group.size > 0 && groupController(state, group) === faction.id && (group.originId === home.id || distance(group, home) < 35)) destinations.push(group);
  for (const destination of destinations) {
    const from = destination.kind === 'resource' ? home : destination, to = destination.kind === 'resource' ? destination : home;
    if (!findPath(projected, from, to, options).reachable && findPath(state, from, to, options).reachable) return false;
  }
  return true;
}

export function defenseBuildingPlan(state, home, faction) {
  if (home.occupiedBy || faction.defeatedBy || state.tick < 70 || home.population < 90 || home.health < 72 || home.shortageDays > 0 || home.wellbeing < .98) return null;
  const defenses = home.buildings.filter(building => DEFENSE_STATS[building.kind] && !building.destroyed && building.hp > 0);
  // Keep a small, affordable fortification. Growth and extraction retain the
  // majority of labour/materials; placement cannot become unlimited tower spam.
  const budget = home.population >= 360 ? 9 : home.population >= 180 ? 6 : 3;
  if (defenses.length >= budget || state.tick - (home.lastDefenseStarted ?? -100) < 24) return null;
  const anchor = defenses.find(b => b.kind === 'gate' && b.topologyId && b.approach) || home.buildings.find(b => b.kind === 'gate' && b.topologyId && b.approach);
  if (!anchor) {
    const objective = knownObjective(state, home, faction);
    if (!objective) return null;
    const route = findPath(state, home, objective, { factionId: faction.id, arrival: 2, maxExpansions: 1024 });
    if (!route.reachable || route.length < 8) return null;
    const desired = Math.min(24, Math.max(12, Math.sqrt(home.buildings.length) * 3.25), route.length * .65);
    for (const adjustment of [0, 3, -3, 6, -6]) {
      let remaining = Math.max(6, Math.min(route.length - 3, desired + adjustment)), previous = home;
      for (const next of route.waypoints) {
        const length = distance(previous, next);
        if (length < remaining) { remaining -= length; previous = next; continue; }
        const approach = { x: (next.x - previous.x) / length, z: (next.z - previous.z) / length };
        const base = { ...pointAlong(previous, approach, remaining), approach, topologyId: `${home.id}:defense-screen`,
          targetReportId: objective.id, defensiveObjective: objective.priority, placementReason: objective.reason };
        const plans = [screenSegment(base, 0), screenSegment(base, -1, 1), screenSegment(base, 1, 1)];
        if (plans.every(p => footprintClear(state, home, p)) && preservesFriendlyRoutes(state, home, faction, plans, base)) return plans[0];
        break;
      }
    }
    return null;
  }
  if (anchor.destroyed || anchor.hp <= 0) {
    const replacement = screenSegment(anchor, 0);
    return footprintClear(state, home, replacement) && preservesFriendlyRoutes(state, home, faction, [replacement], anchor) ? replacement : null;
  }
  // The funded gate fixes a stable blueprint even when the current report
  // changes. Always join an existing segment; no disconnected outer fragments.
  const desiredTowers = Math.min(home.population >= 300 ? 2 : 1, Math.floor((home.military?.ranged || 0) / 3));
  const slots = [[-1, 1], [1, 1], [-1, 'tower'], [-1, 2], [1, 2], [1, 'tower'], [-1, 3], [1, 3]];
  for (const [side, rank] of slots) {
    const sideName = side < 0 ? 'left' : 'right', slot = `${sideName}-${rank}`;
    if (defenses.some(b => b.topologyId === anchor.topologyId && b.topologySlot === slot)) continue;
    let plan;
    if (rank === 'tower') {
      if (defenses.filter(b => b.kind === 'tower').length >= desiredTowers) continue;
      if (!defenses.some(b => b.topologyId === anchor.topologyId && b.topologySlot === `${sideName}-1`)) continue;
      const axis = { x: -anchor.approach.z, z: anchor.approach.x }, point = pointAlong(pointAlong(anchor, axis, side * 6.5), anchor.approach, -4);
      plan = { ...point, kind: 'tower', ...DEFENSE_STATS.tower, hp: DEFENSE_STATS.tower.maxHp, rotation: 0, topologyId: anchor.topologyId, topologySlot: slot,
        targetReportId: anchor.targetReportId, defensiveObjective: anchor.defensiveObjective, placementReason: 'Covers the controlled gate and joined defensive screen' };
    } else {
      if (rank > 1 && !defenses.some(b => b.topologyId === anchor.topologyId && b.topologySlot === `${sideName}-${rank - 1}`)) continue;
      plan = screenSegment(anchor, side, rank);
    }
    if (footprintClear(state, home, plan) && (plan.kind === 'tower' || preservesFriendlyRoutes(state, home, faction, [plan], anchor))) return plan;
  }
  return null;
}

// A scaffold is walkable while builders are working. It cannot suddenly become
// a solid wall around a passing party: the last construction step waits until
// its actual collision footprint is clear. This is physical occupancy, not an
// intelligence-dependent planning decision or an automatic troop relocation.
export function canCompleteDefense(state, building) {
  if (!['wall', 'gate'].includes(building.kind)) return true;
  const home = state.settlements?.find(p => p.buildings?.includes(building));
  const ownerId = home ? (state.factions ? settlementController(state, home) : home.occupiedBy || home.factionId) : building.factionId;
  const clearance = (building.width || 1) * .5 + .55;
  for (const entity of [...(state.groups || []), ...(state.settlements || [])]) {
    if (entity.finished || !(entity.size > 0 || entity.population > 0)) continue;
    const factionId = state.factions ? ('population' in entity ? settlementController(state, entity) : groupController(state, entity)) : entity.factionId;
    const parts = blockingWallParts(state, building, ownerId, factionId);
    const bodies = [entity, ...Object.values(entity.formationSlots || {}).flat()];
    for (const point of bodies) for (const [from, to] of parts) if (segmentDistance(point, from, to) <= clearance) return false;
  }
  return true;
}
