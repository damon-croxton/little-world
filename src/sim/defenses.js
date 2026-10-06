import { distance } from '../shared.js';
import { terrainAt } from '../world.js';
import { availableMilitary } from './military.js';

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

export function defenseBuildingPlan(state, home, faction) {
  if (home.occupiedBy || faction.defeatedBy || state.tick < 70 || home.population < 90 || home.health < 72 || home.shortageDays > 0 || home.wellbeing < .98) return null;
  const defenses = home.buildings.filter(building => DEFENSE_STATS[building.kind] && !building.destroyed && building.hp > 0);
  const towers = defenses.filter(building => building.kind === 'tower').length;
  // Keep a small, affordable fortification. Growth and extraction retain the
  // majority of labour/materials; placement cannot become unlimited tower spam.
  const budget = home.population >= 360 ? 9 : home.population >= 180 ? 6 : 3;
  if (defenses.length >= budget || state.tick - (home.lastDefenseStarted ?? -100) < 24) return null;
  const objective = knownObjective(state, home, faction);
  if (!objective) return null;
  const desiredTowers = Math.min(home.population >= 300 ? 3 : 2, Math.floor(home.military.ranged / 3));
  let kind = !towers && desiredTowers > 0 ? 'tower' : defenses.length % 3 === 2 && towers < desiredTowers ? 'tower' : 'wall';
  if (defenses.length === 4 && objective.priority === 'pass') kind = 'gate';
  const angle = Math.atan2(objective.z - home.z, objective.x - home.x);
  // Separated arcs leave generous traversable corridors even if no gate has
  // yet been funded. Never generate a closed ring of hostile/friendly walls.
  const offsets = [0, -.6, .6, -1.3, 1.3, -2.1, 2.1, Math.PI, .24];
  const radius = Math.min(24, Math.max(12, Math.sqrt(home.buildings.length) * 3.25));
  for (let attempt = 0; attempt < offsets.length; attempt++) {
    const index = (defenses.length + attempt) % offsets.length, bearing = angle + offsets[index];
    const x = home.x + Math.cos(bearing) * radius, z = home.z + Math.sin(bearing) * radius;
    if (!terrainAt(x, z, state.seed).traversable || home.buildings.some(building => !building.destroyed && Math.hypot(building.x - x, building.z - z) < (DEFENSE_STATS[building.kind] ? 6 : 3.5))) continue;
    const stats = DEFENSE_STATS[kind];
    return { kind, x, z, rotation: -bearing + Math.PI / 2, length: stats.length, width: stats.width,
      gateWidth: stats.gateWidth || 0, isGate: kind === 'gate', maxHp: stats.maxHp, hp: stats.maxHp,
      targetReportId: objective.id, placementReason: objective.reason, defensiveObjective: objective.priority };
  }
  return null;
}

// A scaffold is walkable while builders are working. It cannot suddenly become
// a solid wall around a passing party: the last construction step waits until
// its actual collision footprint is clear. This is physical occupancy, not an
// intelligence-dependent planning decision or an automatic troop relocation.
export function canCompleteDefense(state, building) {
  if (!['wall', 'gate'].includes(building.kind)) return true;
  const dx = Math.cos(building.rotation || 0), dz = -Math.sin(building.rotation || 0);
  const half = (building.length || DEFENSE_STATS[building.kind].length) * .5;
  const clearance = (building.width || 1) * .5 + .55;
  for (const group of state.groups || []) {
    if (group.finished || !(group.size > 0)) continue;
    const px = group.x - building.x, pz = group.z - building.z;
    const along = Math.max(-half, Math.min(half, px * dx + pz * dz));
    if (Math.hypot(px - dx * along, pz - dz * along) <= clearance) return false;
  }
  return true;
}
