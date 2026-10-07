import { distance } from '../shared.js';
import { terrainAt } from '../world.js';
import { getSoldiers, isServingSoldier, touchSoldiers } from './soldiers.js';
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
  const priorCrew = (home.buildings || []).filter(b => b.kind === 'tower').map(b => (b.crewSoldierIds || []).join(',')).join('|');
  const available = getSoldiers(state, home).filter(soldier => soldier.role === 'ranged' && !soldier.withdrawing);
  const byId = new Map(available.map(soldier => [soldier.id, soldier]));
  const assigned = new Set();
  let crew = 0;
  // Keep surviving operators at their post. Assignment reserves an existing
  // soldier; combat moves that soldier to the tower before it can operate.
  for (const building of home.buildings || []) if (building.kind === 'tower') {
    building.crewSoldierIds = active && isStandingDefense(building)
      ? (building.crewSoldierIds || []).filter(id => byId.has(id) && !assigned.has(id)).slice(0, DEFENSE_STATS.tower.requiredCrew).filter(id => !assigned.has(id) && (assigned.add(id), true))
      : [];
  }
  for (const soldier of home.soldierRoster || []) if (!assigned.has(soldier.id)) soldier.towerId = null;
  for (const building of home.buildings || []) {
    if (!DEFENSE_STATS[building.kind]) continue;
    building.maxHp ??= DEFENSE_STATS[building.kind].maxHp;
    building.hp ??= building.maxHp;
    if (building.kind !== 'tower') continue;
    building.requiredCrew = DEFENSE_STATS.tower.requiredCrew;
    if (active && isStandingDefense(building)) {
      const candidates = available.filter(soldier => !assigned.has(soldier.id))
        .sort((a, b) => distance(a, building) - distance(b, building) || a.id.localeCompare(b.id));
      for (const soldier of candidates) {
        if (building.crewSoldierIds.length >= building.requiredCrew) break;
        building.crewSoldierIds.push(soldier.id); assigned.add(soldier.id);
      }
    }
    for (const id of building.crewSoldierIds) byId.get(id).towerId = building.id;
    building.crewAssigned = building.crewSoldierIds.length;
    crew += building.crewAssigned;
    building.operational = active && isStandingDefense(building) && building.crewAssigned === building.requiredCrew;
    building.inactiveReason = !active ? 'Settlement inactive' : !isStandingDefense(building) ? 'Construction unfinished or tower destroyed' : !building.operational ? 'Two trained ranged operators required' : null;
  }
  home.assigned ||= {};
  home.assigned.towerCrew = crew;
  if (priorCrew !== (home.buildings || []).filter(b => b.kind === 'tower').map(b => b.crewSoldierIds.join(',')).join('|')) touchSoldiers(state);
  return crew;
}

function freshKnown(faction, state) {
  return Object.values(faction.knowledge || {}).filter(report => report.reportedTick != null && report.reportedTick <= state.tick && report.observedTick <= report.reportedTick && state.tick - report.observedTick <= 240 && (report.confidence ?? 1) >= .35);
}

function knownObjective(state, home, faction) {
  const reports = freshKnown(faction, state);
  const hostile = reports.filter(report => report.kind === 'settlement' && report.ownerId && report.ownerId !== faction.id && report.status !== 'ruin' && distance(home, report) < 180)
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

function perimeterBlueprint(state, home, faction, objective, civicRadius) {
  const bearing = objective ? Math.atan2(objective.z - home.z, objective.x - home.x) : 0;
  const baseRadius = Math.max(12, Math.ceil(civicRadius + 6));
  for (const adjustment of [0, 3, 6]) {
    const radius = baseRadius + adjustment, count = Math.min(64, Math.max(12, Math.ceil(2 * Math.PI * radius / 8))), angle = Math.PI * 2 / count;
    const vertices = [];
    for (let i = 0; i < count; i++) {
      const turn = bearing + (i - .5) * angle;
      let vertex = null;
      for (const inset of [0, -2, 2, -4, 4]) {
        const reach = Math.max(civicRadius + 4, radius + inset), point = { x: home.x + Math.cos(turn) * reach, z: home.z + Math.sin(turn) * reach };
        if (!terrainAt(point.x, point.z, state.seed).traversable || home.buildings.some(b => !b.destroyed && !DEFENSE_STATS[b.kind] && distance(b, point) < 4)) continue;
        if (vertices.length && !isSegmentTraversable(state, vertices.at(-1), point, { radius: .8, ignoreWalls: true })) continue;
        vertex = point; break;
      }
      if (!vertex) break;
      vertices.push(vertex);
    }
    if (vertices.length !== count) continue;
    const gates = new Set([0, Math.floor(count / 2)]);
    // Additional gates follow surveyed extraction routes, not hidden deposits.
    for (const resource of freshKnown(faction, state).filter(k => k.kind === 'resource' && distance(home, k) > radius).sort((a, b) => distance(home, a) - distance(home, b)).slice(0, 6)) {
      const turn = (Math.atan2(resource.z - home.z, resource.x - home.x) - bearing + Math.PI * 4) % (Math.PI * 2);
      const slot = Math.round(turn / angle) % count;
      if (gates.size < 4 && [...gates].every(i => Math.min(Math.abs(i - slot), count - Math.abs(i - slot)) >= 3)) gates.add(slot);
    }
    const topologyId = `${home.id}:perimeter:${state.tick}:${radius}`;
    const plans = vertices.map((from, i) => {
      const to = vertices[(i + 1) % count], kind = gates.has(i) ? 'gate' : 'wall', stats = DEFENSE_STATS[kind];
      const geometry = wallGeometry({ from, to, width: stats.width }), approach = { x: (geometry.x - home.x) / radius, z: (geometry.z - home.z) / radius };
      return { kind, ...geometry, from, to, gateWidth: kind === 'gate' ? Math.min(5, geometry.length - 1.5) : 0, isGate: kind === 'gate',
        maxHp: stats.maxHp, hp: stats.maxHp, topologyId, topologySlot: `ring-${i}`, perimeter: true,
        joins: { from: `${topologyId}:v${i}`, to: `${topologyId}:v${(i + 1) % count}` }, approach,
        targetReportId: objective?.id ?? home.id, defensiveObjective: 'perimeter',
        placementReason: kind === 'gate' ? 'Keeps a controlled route through the enclosing perimeter' : 'Extends the connected perimeter around the civic footprint' };
    });
    if (plans.every(plan => footprintClear(state, home, plan)) && preservesFriendlyRoutes(state, home, faction, plans, plans[0])) return { radius, civicRadius, topologyId, plans, createdTick: state.tick };
  }
  return null;
}

export function defenseBuildingPlan(state, home, faction) {
  if (home.occupiedBy || faction.defeatedBy || state.tick < 70 || home.population < 90 || home.health < 72 || home.shortageDays > 0 || home.wellbeing < .98) return null;
  if (state.tick - (home.lastDefenseStarted ?? -100) < 24 || state.tick < (home.perimeterRetryAt ?? 0)) return null;
  const objective = knownObjective(state, home, faction);
  const civicRadius = Math.max(4, ...home.buildings.filter(b => !b.destroyed && !DEFENSE_STATS[b.kind]).map(b => distance(home, b)));
  let blueprint = home.perimeterPlan;
  if (!blueprint || civicRadius > blueprint.radius - 3) {
    blueprint = perimeterBlueprint(state, home, faction, objective, civicRadius);
    if (!blueprint) { home.perimeterRetryAt = state.tick + 40; return null; }
    home.perimeterPlan = blueprint;
  }
  const standing = home.buildings.filter(b => !b.destroyed && b.hp > 0), count = blueprint.plans.length;
  const occupied = new Set(standing.filter(b => b.topologyId === blueprint.topologyId).map(b => b.topologySlot));
  // Repair holes first, otherwise grow adjacent wings from the threatened gate
  // until they meet at the rear. Every segment is a paid construction project.
  const repairs = blueprint.plans.filter(p => !occupied.has(p.topologySlot) && home.buildings.some(b => b.topologyId === p.topologyId && b.topologySlot === p.topologySlot && (b.destroyed || b.hp <= 0)));
  const order = Array.from({ length: count }, (_, i) => i).sort((a, b) => (objective?.priority === 'threat' && occupied.size ? distance(blueprint.plans[a], objective) - distance(blueprint.plans[b], objective) : Math.min(a, count - a) - Math.min(b, count - b)) || a - b);
  const plans = [...repairs, ...order.map(i => blueprint.plans[i])];
  for (const plan of plans) {
    if (occupied.has(plan.topologySlot)) continue;
    const i = blueprint.plans.indexOf(plan);
    if (occupied.size && !repairs.includes(plan) && !occupied.has(`ring-${(i + count - 1) % count}`) && !occupied.has(`ring-${(i + 1) % count}`)) continue;
    if (footprintClear(state, home, plan) && preservesFriendlyRoutes(state, home, faction, [plan], blueprint.plans[0])) return { ...plan, from: { ...plan.from }, to: { ...plan.to }, joins: { ...plan.joins } };
  }
  const towerLimit = Math.min(home.population >= 300 ? 2 : 1, Math.floor((home.military?.ranged || 0) / 3));
  if (standing.filter(b => b.kind === 'tower').length >= towerLimit) return null;
  for (const gate of blueprint.plans.filter(p => p.kind === 'gate')) {
    const point = pointAlong(gate, gate.approach, -4);
    const plan = { ...point, kind: 'tower', ...DEFENSE_STATS.tower, hp: DEFENSE_STATS.tower.maxHp, rotation: 0,
      topologyId: blueprint.topologyId, topologySlot: `${gate.topologySlot}-tower`, targetReportId: gate.targetReportId, defensiveObjective: 'perimeter', placementReason: 'Covers a useful gate through the completed perimeter' };
    if (footprintClear(state, home, plan)) return plan;
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
  // Persistent bodies may trail their army or withdraw independently. Their
  // actual positions keep a scaffold open even when its route anchor passed.
  for (const origin of state.settlements || []) for (const soldier of origin.soldierRoster || []) {
    if (!isServingSoldier(soldier) || !soldier.positioned) continue;
    const group = soldier.groupId && state.groups?.find(g => g.id === soldier.groupId);
    const factionId = group ? groupController(state, group) : settlementController(state, origin);
    for (const [from, to] of blockingWallParts(state, building, ownerId, factionId)) if (segmentDistance(soldier, from, to) <= clearance) return false;
  }
  for (const entity of [...(state.groups || []), ...(state.settlements || [])]) {
    if (entity.finished || !(entity.size > 0 || entity.population > 0)) continue;
    const factionId = state.factions ? ('population' in entity ? settlementController(state, entity) : groupController(state, entity)) : entity.factionId;
    const parts = blockingWallParts(state, building, ownerId, factionId);
    const bodies = [entity, ...Object.values(entity.formationSlots || {}).flat()];
    for (const point of bodies) for (const [from, to] of parts) if (segmentDistance(point, from, to) <= clearance) return false;
  }
  return true;
}
