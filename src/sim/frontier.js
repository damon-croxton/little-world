import { distance } from '../shared.js';
import { knownReports } from './knowledge.js';
import { settlementController, groupController } from './control.js';
import { getSoldiers } from './soldiers.js';

// Command planning uses delivered snapshots only. Friendly coverage is actual
// living military, never a settlement population or an invented escort count.
export function frontierContext(state, faction) {
  const reports = knownReports(state, faction, { maxAge: 240, minConfidence: .35, includeOwn: false });
  const threats = reports.filter(report => report.ownerId && !['allied', 'trade'].includes(faction.relations?.[report.ownerId]?.status) &&
    (report.kind === 'settlement' && !['camp', 'ruin'].includes(report.status) || report.kind === 'group' && report.groupKind === 'army' &&
      state.tick - report.observedTick <= 24 && faction.relations?.[report.ownerId]?.status === 'hostile'));
  const homes = state.settlements.filter(home => home.population > 0 && !['camp', 'ruin'].includes(home.status) && settlementController(state, home) === faction.id);
  const coverage = [];
  for (const entity of [...homes, ...state.groups.filter(group => group.kind === 'army' && !group.finished && groupController(state, group) === faction.id)]) {
    for (const soldier of getSoldiers(state, entity)) {
      if (soldier.withdrawing || soldier.hp / soldier.maxHp <= .3) continue;
      coverage.push({ x: soldier.x, z: soldier.z, strength: soldier.hp / soldier.maxHp, radius: soldier.towerId ? 22 : 16 });
    }
  }
  const reinforcements = homes.filter(home => home.health >= 75 && !home.shortageDays && getSoldiers(state, home, { excludeTowerCrew: true }).filter(soldier => !soldier.withdrawing && soldier.hp / soldier.maxHp > .38).length >= 18);
  return { threats, homes, coverage, reinforcements };
}

export function assessFrontier(context, point) {
  let pressure = 0, clearance = 120, siteBlocked = false, routeBlocked = false;
  for (const threat of context.threats) {
    const d = distance(point, threat), town = threat.kind === 'settlement';
    const strength = Math.max(4, town ? threat.soldiersEstimate ?? (threat.populationEstimate || 40) * .22 : threat.sizeEstimate ?? threat.soldiersEstimate ?? 8);
    clearance = Math.min(clearance, d);
    pressure += strength * Math.max(0, 1 - d / (town ? 80 : 48));
    siteBlocked ||= d < (town ? 42 : 26);
    routeBlocked ||= d < (town ? 26 : 18);
  }
  const coverage = context.coverage.reduce((sum, defender) => sum + (distance(point, defender) <= defender.radius ? defender.strength : 0), 0);
  const reinforcementDistance = Math.min(180, ...(context.reinforcements || context.homes).map(home => distance(home, point)));
  return { pressure, coverage, uncovered: Math.max(0, pressure - coverage), clearance, reinforcementDistance, reinforcementCycles: Math.ceil(reinforcementDistance / 2.1), siteBlocked, routeBlocked };
}

// Sample every segment, including its interior: a two-waypoint route may pass
// directly through an observed army even when both endpoints are safe.
export function assessFrontierRoute(context, origin, route) {
  let previous = origin, peak = 0, blocked = false;
  for (const point of route.waypoints || []) {
    const steps = Math.max(1, Math.ceil(distance(previous, point) / 8));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, assessment = assessFrontier(context, { x: previous.x + (point.x - previous.x) * t, z: previous.z + (point.z - previous.z) * t });
      peak = Math.max(peak, assessment.uncovered); blocked ||= assessment.routeBlocked;
    }
    previous = point;
  }
  return { peak, blocked };
}

export function frontierAssets(state, faction, context) {
  const assets = new Map();
  for (const group of state.groups) {
    if (!['worker', 'colonist'].includes(group.kind) || group.finished || group.size <= 0 || groupController(state, group) !== faction.id || ['returning', 'retreating'].includes(group.phase)) continue;
    const origin = context.homes.find(home => home.id === group.originId);
    const escort = group.kind === 'colonist', point = escort ? group : { x: group.targetX ?? group.x, z: group.targetZ ?? group.z };
    if (!origin || !escort && distance(origin, point) < 24) continue;
    const id = escort ? group.id : group.targetId || group.id;
    const asset = assets.get(id) || { id, kind: escort ? 'escort' : 'worksite', x: point.x, z: point.z, people: 0, originId: origin.id };
    asset.people += group.size; assets.set(id, asset);
  }
  for (const home of context.homes) if (home.foundedTick > 0 || home.population < 80 && context.homes.length > 1) {
    assets.set(home.id, { id: home.id, kind: 'outpost', x: home.x, z: home.z, people: home.population, originId: home.id });
  }
  return [...assets.values()].map(asset => {
    const assessment = assessFrontier(context, asset), need = Math.min(12, Math.max(4, Math.ceil(asset.people * .25 + assessment.pressure * .45)));
    return { ...asset, assessment, need, priority: (asset.kind === 'escort' ? 12 : asset.kind === 'outpost' ? 10 : 0) + asset.people * .4 + assessment.uncovered * 1.2 + assessment.reinforcementDistance * .12 - assessment.coverage * 3 };
  }).filter(asset => asset.assessment.coverage < asset.need).sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
}
