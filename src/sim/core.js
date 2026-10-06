import { normalizeConfig } from '../config.js';
import { hashSeed, random, clamp, distance, emit } from '../shared.js';
import { generateWorld, terrainAt } from '../world.js';
import { createFactions, stepProgression } from './progression.js';
import { stepStrategy } from './strategy.js';
import { settlementController, groupController } from './control.js';
import { moveAlongRoute, findPath, isPointTraversable } from './navigation.js';
import { initializeKnowledge, stepKnowledge, visibleToGroup, observationFor, reportObservations, knownReports, knownResourceNodes } from './knowledge.js';
import { DEFENSE_STATS, defenseCost, defenseBuildingPlan, assignDefenses, canCompleteDefense } from './defenses.js';
import { initializeMilitary, syncMilitary, refreshExileBases, militaryContext, trainingCount, advanceTraining, planTraining, militaryBuildingPlan, MILITARY_BUILDINGS, applyHomeCasualties, demobilizeMilitary, cancelTraining } from './military.js';
import { RESOURCES, SURVIVAL_NEEDS, emptyResources, initializeLedger, initializeFactionAdvantages, ledgerAdd, canAfford, spend, depositCargo, discardCargo, ledgerResidual } from './economy.js';

export const SIM_DT = .1;
const PULSES = 10;
// Explicit observer-workload limits constrain new commitments; no census or
// resource stock is truncated when a limit is reached.
export const SIM_LIMITS = Object.freeze({ settlements: 48, groups: 480, populationPerSettlement: 900, activeSettlementsPerFaction: 4 });
const { settlements: MAX_SETTLEMENTS, groups: MAX_GROUPS, populationPerSettlement: MAX_POPULATION } = SIM_LIMITS;
const PROFILES = {
  human: { needs: SURVIVAL_NEEDS.human, birth: { food: 1.5, water: .5, energy: .3, materials: 1.2 }, growth: .005, staple: 'food' },
  machine: { needs: SURVIVAL_NEEDS.machine, birth: { food: 0, water: .4, energy: 4, materials: 3.5 }, growth: .0032, staple: 'energy' },
  hive: { needs: SURVIVAL_NEEDS.hive, birth: { food: 2.5, water: .6, energy: .2, materials: .6 }, growth: .0065, staple: 'food' },
};
const BUILDING_COST = {
  housing: { materials: 40, energy: 8 }, storage: { materials: 70, energy: 14 }, workshop: { materials: 80, energy: 30 },
  farm: { materials: 35, energy: 6 }, power: { materials: 55, energy: 20 },
  lab: { materials: 80, energy: 40 }, hub: { materials: 100, energy: 30 },
};
const active = s => s.population > 0 && s.status !== 'camp' && s.status !== 'ruin';
const alive = s => s.population > 0 && s.status !== 'ruin';
const factionOf = (s, home) => s.factions.find(f => f.id === home.factionId);
const profile = f => PROFILES[f.species] || PROFILES.human;
const modifier = (f, key) => clamp(f.modifiers?.[key] ?? 1, .25, 4);
const buildingCount = (s, kind) => s.buildings.filter(b => b.kind === kind && b.progress >= 1 && !b.destroyed && (b.hp == null || b.hp > 0)).length;
const needsFor = (s, f, present = s.homePresent ?? s.population) => {
  const n = profile(f).needs;
  return { food: n.food * present, water: n.water * present / modifier(f, 'waterEfficiency'), energy: n.energy * present / modifier(f, 'energyEfficiency'), materials: n.materials * present / modifier(f, 'materialEfficiency') };
};

function buildingRecord(state, home, kind, progress = 0, placement = null) {
  const index = home.buildings.length, angle = index * 2.399963229728653 + (hashSeed(home.id + state.seed) % 100) / 100;
  const radius = index === 0 ? 0 : 2.85 * Math.sqrt(index);
  let x = home.x + Math.cos(angle) * radius, z = home.z + Math.sin(angle) * radius;
  if (!placement && !isPointTraversable(state, { x, z }, { factionId: home.factionId })) {
    let found = false;
    for (let offset = 1; offset <= 48; offset++) {
      const reach = Math.max(0, radius - Math.floor(offset / 16) * 2.5), bearing = angle + offset * 2.399963229728653;
      const candidate = { x: home.x + Math.cos(bearing) * reach, z: home.z + Math.sin(bearing) * reach };
      if (!isPointTraversable(state, candidate, { factionId: home.factionId }) || home.buildings.some(existing => !existing.destroyed && distance(candidate, existing) < 2)) continue;
      x = candidate.x; z = candidate.z; found = true; break;
    }
    if (!found) return null;
  }
  const b = { id: `b${state.nextId++}`, kind, x, z, rotation: angle + Math.PI / 2, progress, hp: 160, maxHp: 160, createdTick: state.tick, completedTick: progress >= 1 ? state.tick : null, ...(placement || {}) };
  if (DEFENSE_STATS[kind]) { b.maxHp = Math.round(DEFENSE_STATS[kind].maxHp * (factionOf(state, home)?.advantages?.fortificationHp || 1)); b.hp = b.maxHp; }
  home.radius = Math.max(home.radius, Math.hypot(b.x - home.x, b.z - home.z) + 3.2);
  home.roads.push({ from: { x: home.x, z: home.z }, to: { x: b.x, z: b.z } });
  return b;
}

function refreshBuildings(home, f) {
  const completed = home.buildings.filter(b => b.progress >= 1 && !b.destroyed && (b.hp == null || b.hp > 0));
  home.housingCapacity = Math.min(MAX_POPULATION, Math.round((40 + completed.filter(b => b.kind === 'housing').length * 40) * modifier(f, 'capacity')));
  home.carryingCapacity = home.housingCapacity;
  home.capacity = Math.round((500 + completed.filter(b => b.kind === 'storage').length * 600) * modifier(f, 'capacity'));
  home.level = clamp(1 + Math.floor(Math.log2(Math.max(1, home.population / 100))), 1, 6);
  home.infrastructureWorkers = home.status === 'camp' ? 0 : Math.min(Math.floor(home.workers * .22), completed.filter(b => b.kind === 'power' || (b.kind === 'farm' && f.species !== 'machine')).length * 4);
}

function makeSettlement(state, faction, point, population, founding = false) {
  const names = { human: ['Hearth', 'Crossing', 'Haven', 'Terrace', 'Vale'], machine: ['Foundry', 'Relay', 'Array', 'Forge', 'Nexus'], hive: ['Cradle', 'Bloom', 'Chorus', 'Root', 'Canopy'] };
  const ordinal = state.settlements.filter(s => s.factionId === faction.id).length;
  const s = { id: `s${state.nextSettlementId++}`, factionId: faction.id, lastFactionId: faction.id, name: `${faction.name.split(' ')[0]} ${(names[faction.species] || names.human)[ordinal % 5]}`,
    x: point.x, z: point.z, population, soldiers: 0, military: { infantry: 0, ranged: 0 }, trainingQueue: [], workers: 0,
    stock: founding ? emptyResources() : { food: faction.species === 'machine' ? 0 : 220, water: 260, energy: faction.species === 'machine' ? 280 : 180, materials: 180 },
    capacity: 1100, level: 1, health: 100, status: 'active', active: true, radius: 4, growth: 0,
    buildings: [], roads: [], worksites: [], construction: null, housingCapacity: 200, carryingCapacity: 200,
    assigned: {}, availableWorkers: 0, homePresent: population, infrastructureWorkers: 0,
    lastProduction: emptyResources(), lastConsumption: emptyResources(), lastDelivery: emptyResources(), deliveryAccumulator: emptyResources(), net: emptyResources(), labor: {},
    foundedTick: state.tick, lastExpansion: state.tick, lastUpgrade: state.tick, lastWorker: -100, lastBirth: state.tick, lastGrowthEvent: state.tick,
    shortageDays: 0, starvation: 0, wellbeing: 1, economyReasons: [], lastCycleStock: null };
  const kinds = founding ? ['hub', 'housing', 'housing', 'storage', faction.species === 'machine' ? 'power' : 'farm']
    : ['hub', 'housing', 'housing', 'housing', 'housing', 'storage', 'workshop', 'farm', 'power'];
  for (const kind of kinds) { const building = buildingRecord(state, s, kind, 1); if (building) s.buildings.push(building); }
  const militia = founding ? 0 : 10 + Math.floor(faction.traits.aggression * 6);
  initializeMilitary(s, { infantry: militia - Math.floor(militia * .3), ranged: Math.floor(militia * .3) });
  s.startingMilitia = { ...s.military };
  refreshBuildings(s, faction); s.lastCycleStock = { ...s.stock };
  return s;
}

function observeHome(state, f, home, survey = false) {
  const controllerId = settlementController(state, home), controller = state.factions.find(candidate => candidate.id === controllerId) || f;
  const native = controller.id === home.factionId;
  controller.knowledge[home.id] = { id: home.id, kind: 'settlement', x: home.x, z: home.z, ownerId: controller.id,
    nativeFactionId: home.factionId, ownerSpecies: controller.species, nativeSpecies: f.species, reportedAtSettlementId: home.id, occupiedBy: home.occupiedBy || null,
    populationEstimate: native ? home.population : home.homePresent ?? home.population,
    soldiersEstimate: native ? home.soldiers : Math.max(0, home.soldiers - (home.assigned?.military || 0)),
    observedTick: state.tick, reportedTick: state.tick, status: home.status, confidence: 1 };
  if (survey) for (const node of state.nodes) if (visibleToGroup(state, home, node, 30)) {
    controller.knowledge[node.id] = { ...observationFor(state, controller, node), reportedTick: state.tick, reportedTime: state.time, reportedAtSettlementId: home.id, reportMethod: 'home-sight' };
  }
}

export function createSimulation(seed = 'littleworld', options = {}) {
  const config = normalizeConfig(options);
  const key = String(seed || 'littleworld').slice(0, 160), world = generateWorld(key, config);
  const s = { seed: key, config, rng: hashSeed(key), tick: 0, step: 0, time: 0, nextId: 1, nextSettlementId: 0, factions: [], settlements: [], groups: [], nodes: world.nodes, bounds: world.bounds, events: [], tradeOffers: [],
    stats: { births: 0, deaths: 0, discoveries: 0, reports: 0, raids: 0, battles: 0, retreats: 0, trades: 0, breakthroughs: 0, expeditions: 0, deliveries: 0, expansions: 0, abandonments: 0, refugeeTransfers: 0, rebuilt: 0, collapses: 0, buildings: 0, harvested: 0 }, terrain: { seed: key, obstacles: world.obstacles, passes: world.passes }, season: { name: 'Bloom', phase: 0, fertility: 1, water: 1 } };
  s.factions = createFactions(s, config.civCount);
  const offset = hashSeed(key + ':settlement-geography') % world.starts.length;
  for (const [i, f] of s.factions.entries()) {
    initializeFactionAdvantages(s, f, i);
    f.status = 'active'; f.knowledge ||= {}; f.history ||= []; f.relations ||= {}; f.experience ||= { exploration: 0, combat: 0, trade: 0 };
    const home = makeSettlement(s, f, world.starts[(i + offset) % world.starts.length], 96 + Math.floor(random(s) * 17));
    s.settlements.push(home); observeHome(s, f, home, true); f.intent = `Establish ${home.name}; survey deposits and assign real harvesting teams.`;
    emit(s, 'founding', `${f.name} establish ${home.name} with ${home.population} individuals, including ${home.soldiers} already-trained militia, and ${home.buildings.length} civic buildings.`, f.id, { settlementId: home.id });
  }
  for (const node of s.nodes) { node.maxAmount ??= node.amount; node.regeneration ??= 0; node.radius ??= 2.5; }
  initializeLedger(s); updateAssignments(s); updateSummaries(s); initializeKnowledge(s); stepKnowledge(s, { force: true });
  return s;
}

function updateAssignments(state) {
  refreshExileBases(state);
  const researchers = Object.fromEntries(state.factions.map(f => [f.id, Math.max(0, Math.floor(f.researchWorkers || 0))]));
  for (const home of state.settlements) {
    const f = factionOf(state, home), a = { workers: 0, scouts: 0, traders: 0, colonists: 0, military: 0, civilianAway: 0, researchers: 0, construction: 0, infrastructure: 0, training: 0, towerCrew: 0 };
    for (const g of state.groups) if (g.originId === home.id && !g.finished && g.size > 0) {
      if (g.kind === 'army') a.military += g.size; else if (g.kind === 'worker') a.workers += g.size; else if (g.kind === 'scout') a.scouts += g.size; else if (g.kind === 'trader') a.traders += g.size; else if (g.kind === 'colonist') a.colonists += g.size;
    }
    a.civilianAway = a.workers + a.scouts + a.traders + a.colonists;
    home.population = Math.max(0, Math.floor(home.population));
    syncMilitary(state, home);
    home.workers = Math.max(0, home.population - home.soldiers); home.homePresent = Math.max(0, home.population - a.civilianAway - a.military);
    a.training = trainingCount(home);
    let available = Math.max(0, home.workers - a.civilianAway - a.training);
    if (f && active(home)) {
      refreshBuildings(home, f); a.infrastructure = Math.min(available, home.infrastructureWorkers || 0); available -= a.infrastructure;
      const researchHere = !home.occupiedBy && (!f.researchHomeId || f.researchHomeId === home.id);
      a.researchers = researchHere ? Math.min(researchers[f.id] || 0, 6 + buildingCount(home, 'lab') * 8, Math.max(0, available - 8)) : 0;
      researchers[f.id] -= a.researchers; available -= a.researchers;
      a.construction = home.construction ? Math.min(home.construction.workers || 12, Math.max(0, available - 8)) : 0; available -= a.construction;
    }
    home.assigned = a; home.availableWorkers = available; if (f) assignDefenses(state, home, f);
  }
}

function move(state, group, target, arrival = 1) {
  return moveAlongRoute(state, group, target, { dt: SIM_DT, speed: group.speed, arrival, factionId: group.movementFactionId || groupController(state, group), spreadArrival: group.kind === 'worker' && group.phase === 'outbound' });
}

function reportWorker(state, g, f) {
  const home = state.settlements.find(candidate => candidate.id === g.originId);
  f = home ? state.factions.find(candidate => candidate.id === settlementController(state, home)) || f : f;
  reportObservations(state, f, g.observations, { method: 'worker-return', group: g });
  if (g.salvageSamples > 0) f.experience.salvage = (f.experience.salvage || 0) + g.salvageSamples;
}

function returnWorker(state, g, home) {
  g.phase = 'returning'; g.targetX = home.x; g.targetZ = home.z; g.activity = 'hauling';
  const node = state.nodes.find(n => n.id === g.targetId);
  if (node && visibleToGroup(state, g, node)) {
    const observation = observationFor(state, g.factionId, node);
    g.observations ||= [];
    const prior = g.observations.findIndex(report => report.id === node.id);
    if (prior < 0) g.observations.push(observation); else g.observations[prior] = observation;
  }
}

function visibleResourceThreat(state, group, controllerId) {
  const hostile = otherId => otherId && otherId !== controllerId && !['allied', 'trade'].includes(state.factions.find(f => f.id === controllerId)?.relations?.[otherId]?.status);
  for (const army of state.groups) {
    if (army.kind !== 'army' || army.finished || army.surrendered || army.size < 4) continue;
    const owner = groupController(state, army);
    if (hostile(owner) && visibleToGroup(state, group, army)) return { controllerId: owner, groupId: army.id, settlementId: army.originId };
  }
  for (const town of state.settlements) {
    const owner = settlementController(state, town); if (!hostile(owner) || distance(group, town) > (town.radius || 12) + 12) continue;
    for (const tower of town.buildings) if (tower.kind === 'tower' && tower.operational && tower.progress >= 1 && tower.hp > 0 && visibleToGroup(state, group, tower)) return { controllerId: owner, buildingId: tower.id, settlementId: town.id };
  }
  return null;
}

function claimResource(state, node, controllerId, homeId, securedBy = null) {
  const changed = node.claimedBy !== controllerId || node.claimSettlementId !== homeId;
  node.claimedBy = controllerId; node.claimSettlementId = homeId; node.claimedTick = state.tick;
  if (securedBy) node.securedBy = securedBy;
  if (changed) state.stats.resourceClaims = (state.stats.resourceClaims || 0) + 1;
}

function refreshResourceClaims(state) {
  const homes = new Map(state.settlements.map(home => [home.id, home]));
  const armies = new Map(state.groups.filter(group => group.kind === 'army' && !group.finished && !group.surrendered && group.size > 0).map(group => [group.id, group]));
  for (const node of state.nodes) if (node.claimSettlementId) {
    const guard = armies.get(node.securedBy);
    if (guard && distance(guard, node) <= 15) { node.claimedBy = groupController(state, guard); continue; }
    const home = homes.get(node.claimSettlementId);
    if (home?.population > 0) node.claimedBy = settlementController(state, home);
    else { node.claimedBy = null; node.claimSettlementId = null; node.securedBy = null; }
  }
}

function processWorkers(state, indexes) {
  const remove = new Set();
  for (const g of state.groups) {
    if (g.kind !== 'worker' && g.kind !== 'colonist') continue;
    const home = indexes.homes.get(g.originId), f = indexes.factions.get(g.factionId);
    if (!home || !f || home.population <= 0) { discardCargo(state, g); remove.add(g.id); continue; }
    g.movementFactionId = settlementController(state, home);
    const missionAge = state.time - g.createdTick;
    g.supply = g.provisionCycles ? Math.max(0, 100 * (1 - missionAge / g.provisionCycles)) : Math.max(0, g.supply - .12 * SIM_DT);
    // A failed return route cannot make an off-site workforce immortal. Supplies
    // were paid on departure; exhausted teams lose people and unsupported cargo.
    if (g.supply <= 0 && state.step % PULSES === 0) {
      g.starvation = (g.starvation || 0) + Math.max(.025, g.size * .006);
      const deaths = Math.min(g.size, Math.floor(g.starvation));
      if (deaths) {
        const fraction = deaths / g.size;
        for (const kind of RESOURCES) { const lost = (g.carrying[kind] || 0) * fraction; g.carrying[kind] -= lost; ledgerAdd(state, kind, 'lost', lost); }
        if (g.capacity != null) { g.capacity *= 1 - fraction; g.cargoCapacity = g.capacity; }
        g.size -= deaths; home.population -= deaths; g.starvation -= deaths; state.stats.deaths += deaths; state.stats.fieldDeaths = (state.stats.fieldDeaths || 0) + deaths;
        if (!g.size) { discardCargo(state, g); remove.add(g.id); continue; }
      }
    }
    if (g.kind === 'colonist' && g.phase !== 'returning') {
      if (move(state, g, { x: g.targetX, z: g.targetZ }, 1.2)) { const founded = foundOutpost(state, g, home, f, remove); if (founded) indexes.homes.set(founded.id, founded); }
      else if (g.stuckTime > 18 || state.time - g.createdTick > 300) { g.phase = 'returning'; g.reason = 'The founding route became unsafe; settlers are returning with their supplies.'; }
      continue;
    }
    if (g.phase === 'returning') {
      if (!move(state, g, home, Math.min(3, home.radius * .28))) continue;
      const delivered = depositCargo(state, home, g); if (g.observations?.length) reportWorker(state, g, f);
      if (delivered > .1) {
        state.stats.deliveries++; home.deliveryDetails = { tick: state.tick, kind: g.resourceKind, amount: delivered, groupId: g.id };
        if (state.tick - (home.lastDeliveryEvent ?? -30) > 28) { emit(state, 'supply', `${g.size} workers deliver ${Math.round(delivered)} ${g.resourceKind || 'supplies'} to ${home.name}; their cargo was harvested at the field site.`, f.id, { settlementId: home.id, groupId: g.id, amount: delivered }); home.lastDeliveryEvent = state.tick; }
      }
      discardCargo(state, g); remove.add(g.id); continue;
    }
    const node = indexes.nodes.get(g.targetId); if (!node) { returnWorker(state, g, home); continue; }
    if (g.phase === 'outbound') {
      if (g.supply < 35) { returnWorker(state, g, home); continue; }
      if (!move(state, g, node, Math.max(1, node.radius * .55))) { if (g.stuckTime > 18 || state.time - g.createdTick > 260) returnWorker(state, g, home); continue; }
      g.phase = 'working'; g.activity = `harvesting ${node.subtype || node.kind}`; g.workTime = 0;
    }
    if (g.phase === 'working') {
      // A paper claim is not an invisible force field. Only a physically seen
      // armed rival can turn these civilians back from a contested worksite.
      if (g.lastSecurityCheck == null || state.step % 10 === 0) {
        g.lastSecurityCheck = state.step;
        const threat = visibleResourceThreat(state, g, settlementController(state, home));
        if (threat) {
          claimResource(state, node, threat.controllerId, threat.settlementId, threat.groupId || threat.buildingId);
          g.resourceDispute = { nodeId: node.id, controllerId: threat.controllerId, observedTick: state.tick };
          state.stats.resourceDisputes = (state.stats.resourceDisputes || 0) + 1;
          returnWorker(state, g, home); g.reason = 'A locally visible armed rival secured the resource; this crew is carrying its observations home.'; continue;
        }
      }
      const rate = g.size * (.52 + node.richness * .18) * (.8 + f.traits.industry * .5) * (1 + (f.tech.level || 0) * .06) * (f.advantages?.gathering || 1);
      const load = RESOURCES.reduce((n, k) => n + (g.carrying[k] || 0), 0), extracted = Math.max(0, Math.min(node.amount, g.capacity - load, rate * SIM_DT));
      if (extracted > 0 && !node.claimedBy) claimResource(state, node, settlementController(state, home), home.id);
      node.amount -= extracted; g.carrying[node.kind] += extracted; g.extractedTotal += extracted; g.workTime += SIM_DT;
      g.workProgress = (load + extracted) / g.capacity; g.workRemaining = Math.max(0, (g.capacity - load - extracted) / Math.max(.1, rate));
      ledgerAdd(state, node.kind, 'extracted', extracted); state.stats.harvested += extracted;
      if (f.species === 'machine' && node.kind === 'materials') g.salvageSamples = (g.salvageSamples || 0) + extracted;
      if (g.workProgress >= .999 || node.amount < .01 || g.supply < 15) returnWorker(state, g, home);
    }
  }
  if (remove.size) state.groups = state.groups.filter(g => !remove.has(g.id));
}

// Rations cover the physical route, including slow fords and slopes, rather
// than a straight-line distance at an assumed speed. The same terrain model
// controls motion; the finite extra margin covers harvesting and minor detours.
export function estimateJourneyCycles(state, from, route, speed, workCycles = 12) {
  if (!route?.reachable || !(speed > 0)) return null;
  let previous = from, travelCycles = 0;
  for (const point of route.waypoints) {
    const length = distance(previous, point), samples = Math.max(1, Math.ceil(length / 1.5));
    for (let sample = 0; sample < samples; sample++) {
      const t = (sample + .5) / samples;
      const x = previous.x + (point.x - previous.x) * t, z = previous.z + (point.z - previous.z) * t;
      const movement = Math.max(.15, terrainAt(x, z, state.seed).movement);
      travelCycles += length / samples / (speed * movement);
    }
    previous = point;
  }
  return Math.ceil(travelCycles * 2 * 1.2 + Math.max(0, workCycles) + 12);
}

function launchWorkers(state, home, f, dispatch) {
  if (!alive(home) || state.groups.length >= MAX_GROUPS - 12) return;
  const minTeam = home.status === 'camp' ? 3 : 8, desired = Math.floor(home.workers * (home.status === 'camp' ? .7 : .66));
  if (home.assigned.workers >= desired || home.availableWorkers < minTeam + 5) return;
  const reservingColonists = home.population >= 280 && state.tick - home.lastExpansion > 260 && !state.groups.some(g => g.kind === 'colonist' && g.originId === home.id);
  if (reservingColonists && home.availableWorkers < 65 && home.assigned.workers > home.workers * .35) return;
  const needs = needsFor(home, f, home.population), committed = emptyResources();
  for (const g of state.groups) if (g.kind === 'worker' && g.originId === home.id && !g.refugees) {
    const expected = g.phase === 'returning' ? g.carrying[g.resourceKind] || 0 : Math.max(g.capacity * .7, g.carrying[g.resourceKind] || 0);
    if (g.resourceKind in committed) committed[g.resourceKind] += expected;
  }
  let best = null;
  const commander = state.factions.find(candidate => candidate.id === settlementController(state, home)) || f;
  for (const node of dispatch.knownNodes.get(commander.id) || []) {
    const known = commander.knowledge[node.id]; if (!known || known.reportedTick == null || known.reportedTick > state.tick || distance(home, known) > 65) continue;
    if (f.species === 'machine' && node.kind === 'food') continue;
    const estimate = known.amountEstimate ?? known.abundanceEstimate ?? 100;
    if (estimate < 5 && (node.regeneration <= 0 || state.tick - known.observedTick < 80)) continue;
    const traffic = dispatch.traffic.get(`${f.id}:${node.id}`) || 0;
    if (traffic >= 3 || home.stock[node.kind] + committed[node.kind] >= home.capacity * .91) continue;
    const investment = node.kind === 'materials' ? Math.max(1.8, home.population * .007) : node.kind === 'energy' ? home.population * .006 : node.kind === profile(f).staple ? home.population * .009 : 0;
    const buffer = Math.max(80, (needs[node.kind] + investment) * 75);
    const sample = f.species === 'machine' && node.kind === 'materials' && (f.experience.salvage || 0) < 30 ? 1.5 : 1;
    const shortage = buffer / Math.max(15, home.stock[node.kind] + committed[node.kind]);
    const score = shortage * sample * (.6 + (known.richnessEstimate ?? .55)) / (12 + distance(home, known)) / (1 + traffic * .35);
    if (!best || score > best.score) best = { node, score };
  }
  if (!best) return;
  const size = Math.min(24, Math.max(minTeam, Math.floor(home.population * .11)), home.availableWorkers - 5, desired - home.assigned.workers);
  if (size < minTeam) return;
  const route = findPath(state, home, best.node, { factionId: settlementController(state, home), arrival: Math.max(1, best.node.radius * .55) });
  if (!route.reachable) return;
  const speed = f.species === 'machine' ? 2.8 : 2.65, capacity = size * 6 * modifier(f, 'carryCapacity') * (f.advantages?.hauling || 1);
  const expectedRate = size * (.52 + best.node.richness * .18) * (.8 + f.traits.industry * .5) * (1 + (f.tech.level || 0) * .06) * (f.advantages?.gathering || 1);
  const journeyCycles = estimateJourneyCycles(state, home, route, speed, capacity / Math.max(.1, expectedRate));
  const costs = needsFor(home, f, size);
  for (const k of RESOURCES) costs[k] *= journeyCycles;
  if (!canAfford(home, costs)) return;
  spend(state, home, costs, 'consumed');
  state.groups.push({ id: `g${state.nextId++}`, factionId: f.id, originId: home.id, kind: 'worker', size, x: home.x, z: home.z, prevX: home.x, prevZ: home.z,
    targetX: best.node.x, targetZ: best.node.z, targetId: best.node.id, phase: 'outbound', speed, supply: 100, morale: 90,
    capacity, cargoCapacity: capacity, provisionCycles: journeyCycles, plannedRouteLength: route.length, plannedWorkCycles: capacity / Math.max(.1, expectedRate), provisions: costs, carrying: emptyResources(), observations: [], resourceKind: best.node.kind, createdTick: state.tick,
    workProgress: 0, workRemaining: 0, workTime: 0, extractedTotal: 0, reason: `${size} individuals assigned to a reported ${best.node.subtype || best.node.kind} deposit; supplies enter storage only after return.`, activity: 'travelling' });
  home.assigned.workers += size; home.assigned.civilianAway += size; home.availableWorkers -= size; home.lastWorker = state.tick; state.stats.expeditions++;
  const trafficKey = `${f.id}:${best.node.id}`; dispatch.traffic.set(trafficKey, (dispatch.traffic.get(trafficKey) || 0) + 1);
}

function infrastructure(state, home, f) {
  home.lastProduction = emptyResources(); home.labor = {};
  for (const b of home.buildings) b.workersAssigned = 0;
  if (!active(home) || (home.contestedUntil || 0) >= state.tick) return;
  let workers = home.assigned.infrastructure;
  const terrain = terrainAt(home.x, home.z, state.seed), factor = .55 + (terrain.fertility || .5) * .75;
  for (const b of home.buildings) {
    if (b.progress < 1 || b.destroyed || (b.hp != null && b.hp <= 0) || !['farm', 'power'].includes(b.kind) || workers <= 0) continue;
    const kind = b.kind === 'farm' ? 'food' : 'energy'; if (f.species === 'machine' && kind === 'food') continue;
    const crew = Math.min(4, workers); workers -= crew; b.workersAssigned = crew;
    const desired = crew * (kind === 'food' ? .32 * factor * state.season.fertility : .35 * (terrain.biome === 'desert' ? 1.3 : 1)) * modifier(f, 'production');
    const perWater = kind === 'food' ? .16 : .015, paidFraction = Math.min(1, home.stock.water / Math.max(.01, crew * perWater));
    const amount = Math.min(home.capacity - home.stock[kind], desired * paidFraction); if (amount <= 0) continue;
    spend(state, home, { water: crew * perWater * amount / Math.max(.001, desired) }, 'consumed'); home.stock[kind] += amount; home.lastProduction[kind] += amount;
    ledgerAdd(state, kind, 'produced', amount); home.labor[kind] = (home.labor[kind] || 0) + crew;
  }
}

function consume(state, home, f) {
  const needs = needsFor(home, f), missing = []; let fulfillment = 1; home.lastConsumption = emptyResources();
  for (const k of RESOURCES) {
    const amount = Math.min(home.stock[k], needs[k]); home.stock[k] -= amount; home.lastConsumption[k] = amount; ledgerAdd(state, k, 'consumed', amount);
    if (needs[k] > .00001) { const ratio = amount / needs[k]; fulfillment = Math.min(fulfillment, ratio); if (ratio < .95) missing.push(k); }
  }
  home.wellbeing = fulfillment; home.shortageDays = fulfillment < .85 ? home.shortageDays + 1 : Math.max(0, home.shortageDays - 2);
  if (fulfillment < .98) home.health -= (1 - fulfillment) * .35;
  else if (active(home) && home.health < 100 && (home.contestedUntil || 0) < state.tick && home.availableWorkers >= 4) {
    const repair = Math.min(100 - home.health, .08 + home.availableWorkers * .001), cost = { materials: repair * 2, energy: repair * .5 };
    if (canAfford(home, cost, { food: needs.food * 8, water: needs.water * 8, energy: needs.energy * 8 })) { spend(state, home, cost, 'construction'); home.health += repair; }
  }
  home.health = clamp(home.health, home.population > 0 ? .1 : 0, 100);
  if (home.shortageDays >= 18) {
    const deployed = home.assigned.civilianAway + home.assigned.military, present = Math.max(0, home.population - deployed);
    home.starvation += (1 - fulfillment) * Math.max(.08, present * .004);
    const deaths = Math.min(present, Math.floor(home.starvation));
    if (deaths > 0) {
      const lost = applyHomeCasualties(state, home, deaths); home.starvation -= lost; state.stats.homeScarcityDeaths = (state.stats.homeScarcityDeaths || 0) + lost;
      if (state.tick - (home.lastMortalityEvent || -30) > 28) { emit(state, 'shortage', `${home.name} is losing inhabitants after ${home.shortageDays} cycles of ${missing.join(' and ')} shortage.`, f.id, { settlementId: home.id, deaths }); home.lastMortalityEvent = state.tick; }
    }
  } else home.starvation = Math.max(0, home.starvation - .1);
  home.missingResources = missing;
}

function grow(state, home, f) {
  if (!active(home) || home.health < 65 || home.wellbeing < .98 || (home.contestedUntil || 0) >= state.tick || home.population >= home.housingCapacity) return;
  const p = profile(f), needs = needsFor(home, f, home.population), costs = { ...p.birth }; costs.materials /= modifier(f, 'materialEfficiency');
  const reserves = Object.fromEntries(RESOURCES.map(k => [k, needs[k] * 48]));
  if (!canAfford(home, costs, reserves)) { home.growth = Math.min(.99, home.growth); return; }
  const space = clamp(1 - home.population / home.housingCapacity, 0, .75);
  home.growth += p.growth * home.population * space * modifier(f, 'growth') * (f.species === 'machine' ? modifier(f, 'replication') : 1);
  let births = 0;
  while (home.growth >= 1 && births < 12 && home.population < home.housingCapacity && canAfford(home, costs, reserves)) { spend(state, home, costs, 'consumed'); home.population++; home.growth--; births++; state.stats.births++; }
  if (births && state.tick - home.lastGrowthEvent > 75) { emit(state, 'growth', `${home.name} now supports ${home.population} individuals in ${buildingCount(home, 'housing')} residential buildings; new life consumes real reserves.`, f.id, { settlementId: home.id }); home.lastGrowthEvent = state.tick; }
}

function construction(state, home, f) {
  if (!active(home) || (home.contestedUntil || 0) >= state.tick) return;
  if (home.construction) {
    const b = home.buildings.find(b => b.id === home.construction.buildingId); if (!b || b.destroyed || (b.hp != null && b.hp <= 0)) { home.construction = null; return; }
    const nextProgress = Math.min(1, b.progress + home.assigned.construction / (100 + ((BUILDING_COST[b.kind] || MILITARY_BUILDINGS[b.kind]?.cost || DEFENSE_STATS[b.kind]?.cost)?.materials || 40)));
    const occupied = nextProgress >= 1 && !canCompleteDefense(state, b);
    b.progress = occupied ? Math.min(.999, nextProgress) : nextProgress;
    home.construction.progress = b.progress;
    home.construction.blockedReason = occupied ? 'Waiting for passing parties to clear the wall footprint' : null;
    if (b.progress >= 1) {
      b.completedTick = state.tick; home.construction = null; state.stats.buildings++;
      if (state.tick - (home.lastBuildingEvent || -40) > 35) { emit(state, 'building', `${home.name} completed a ${MILITARY_BUILDINGS[b.kind]?.name || DEFENSE_STATS[b.kind]?.name || b.kind}; ${home.buildings.length} structures now occupy a ${Math.round(home.radius * 2)}-unit footprint.`, f.id, { settlementId: home.id, buildingId: b.id }); home.lastBuildingEvent = state.tick; }
      refreshBuildings(home, f);
    }
    return;
  }
  if (home.buildings.length >= 110 || home.availableWorkers < 12 || home.health < (home.exileBaseFor ? 1 : 45)) return;
  let kind = null;
  const militaryKind = militaryBuildingPlan(state, home, f), defensePlan = defenseBuildingPlan(state, home, f);
  if (home.housingCapacity < MAX_POPULATION && home.population > home.housingCapacity * .80) kind = 'housing';
  else if (home.capacity < home.population * 5 + 300) kind = 'storage';
  else if (militaryKind && home.wellbeing >= .98) kind = militaryKind;
  else if (!home.occupiedBy && state.tick > 35 && buildingCount(home, 'lab') < Math.max(1, Math.ceil(home.population / 240))) kind = 'lab';
  else if (f.species !== 'machine' && buildingCount(home, 'farm') < Math.ceil(home.population / 100)) kind = 'farm';
  else if (buildingCount(home, 'power') < Math.ceil(home.population / (f.species === 'machine' ? 65 : 280))) kind = 'power';
  else if (buildingCount(home, 'workshop') < Math.ceil(home.population / 200)) kind = 'workshop';
  else if (defensePlan) kind = defensePlan.kind;
  if (!kind) return;
  const cost = { ...(BUILDING_COST[kind] || MILITARY_BUILDINGS[kind]?.cost || defenseCost(f.species, kind)) }, needs = needsFor(home, f); cost.materials /= modifier(f, 'materialEfficiency');
  const commandContext = MILITARY_BUILDINGS[kind] && home.exileBaseFor ? militaryContext(state, home, f) : f;
  for (const resource of Object.keys(cost)) cost[resource] *= commandContext?.advantages?.constructionCost || 1;
  if (!canAfford(home, cost, { food: needs.food * 8, water: needs.water * 8, energy: needs.energy * 8, materials: 15 })) return;
  const building = buildingRecord(state, home, kind, 0, DEFENSE_STATS[kind] ? defensePlan : null); if (!building) return;
  spend(state, home, cost, 'construction'); building.fundedCost = { ...cost }; home.buildings.push(building);
  if (DEFENSE_STATS[kind]) home.lastDefenseStarted = state.tick;
  home.construction = { buildingId: building.id, kind, workers: clamp(Math.floor(home.population * .07), 10, 28), progress: 0, cost, startedTick: state.tick };
}

function planFounding(state, home, f) {
  if (!active(home) || home.occupiedBy || f.defeatedBy || state.settlements.length >= MAX_SETTLEMENTS || state.groups.length >= MAX_GROUPS - 6 || home.population < 280 || state.tick - home.lastExpansion < 280 || home.health < 75) return;
  if (state.settlements.filter(s => s.factionId === f.id && active(s)).length >= SIM_LIMITS.activeSettlementsPerFaction || state.groups.some(g => g.kind === 'colonist' && g.factionId === f.id)) return;
  const size = clamp(Math.floor(home.population * .18), 48, 80); if (home.availableWorkers < size + 12) return;
  const reports = knownReports(state, f, { kind: 'resource', maxAge: 360, minConfidence: .25 }).filter(k => (k.amountEstimate ?? k.abundanceEstimate ?? 0) >= 80);
  const knownHomes = knownReports(state, f, { kind: 'settlement', maxAge: 500, minConfidence: .2 });
  let best = null;
  for (const k of reports) {
    if (k.kind !== 'resource' || k.reportedTick == null || k.reportedTick > state.tick) continue;
    const d = distance(home, k); if (d < 35 || d > 95 || state.settlements.some(s => s.factionId === f.id && alive(s) && distance(s, k) < Math.max(32, s.radius + 15)) || knownHomes.some(s => s.ownerId !== f.id && s.status !== 'ruin' && distance(s, k) < Math.max(32, (s.radius || 8) + 15))) continue;
    if (state.groups.some(g => g.kind === 'colonist' && g.factionId === f.id && Math.hypot(g.targetX - k.x, g.targetZ - k.z) < 32)) continue;
    const terrain = terrainAt(k.x, k.z, state.seed); if (!terrain.traversable || terrain.height < .4 || terrain.roughness > .65) continue;
    const resources = reports.filter(n => distance(n, k) < 28), types = new Set(resources.map(n => n.resourceKind));
    if (!types.has('water') || !types.has('materials') || !types.has(profile(f).staple)) continue;
    const reported = Object.fromEntries(RESOURCES.map(kind => [kind, resources.filter(n => n.resourceKind === kind).reduce((sum, n) => sum + (n.amountEstimate ?? n.abundanceEstimate ?? 0), 0)]));
    if (reported.materials < 1200 || reported.water < 1200 || reported[profile(f).staple] < 1200) continue;
    const score = resources.length + terrain.fertility * 4 - d * .04; if (!best || score > best.score) best = { ...k, score };
  }
  if (!best) return;
  const cargo = { food: f.species === 'machine' ? 0 : size * 1.4, water: size * 1.6, energy: f.species === 'machine' ? size * 1.8 : 60, materials: 170 }, needs = needsFor(home, f);
  if (!canAfford(home, cargo, Object.fromEntries(RESOURCES.map(k => [k, needs[k] * 18])))) return;
  for (const k of RESOURCES) home.stock[k] -= cargo[k];
  state.groups.push({ id: `g${state.nextId++}`, factionId: f.id, originId: home.id, kind: 'colonist', size, x: home.x, z: home.z, prevX: home.x, prevZ: home.z,
    targetX: best.x, targetZ: best.z, targetId: best.id, phase: 'outbound', speed: 2.25, supply: 100, morale: 88, carrying: cargo, observations: [], createdTick: state.tick,
    reason: `${size} settlers carry construction materials and provisions to a returned survey site.`, resourceKind: 'founding supplies' });
  home.lastExpansion = state.tick; emit(state, 'colonists', `${size} settlers leave ${home.name} with real stores; the new outpost exists only when they arrive.`, f.id, { settlementId: home.id }); updateAssignments(state);
}

function foundOutpost(state, g, origin, f, remove) {
  if (state.settlements.length >= MAX_SETTLEMENTS || state.settlements.some(s => alive(s) && Math.hypot(s.x - g.targetX, s.z - g.targetZ) < 25)) { g.phase = 'returning'; g.reason = 'The proposed site is occupied; settlers are returning.'; return; }
  const cost = { materials: 110, energy: 30 }; if (g.carrying.materials < cost.materials || g.carrying.energy < cost.energy) { g.phase = 'returning'; return; }
  const home = makeSettlement(state, f, { x: g.targetX, z: g.targetZ }, g.size, true); origin.population -= g.size;
  for (const k of RESOURCES) { const paid = cost[k] || 0; ledgerAdd(state, k, 'construction', paid); home.stock[k] = g.carrying[k] - paid; g.carrying[k] = 0; }
  state.settlements.push(home); state.stats.expansions++; remove.add(g.id); observeHome(state, f, home, true); home.lastCycleStock = { ...home.stock };
  emit(state, 'expansion', `${g.size} settlers reach the survey site and found ${home.name}; carried materials become ${home.buildings.length} initial structures.`, f.id, { settlementId: home.id, originId: origin.id });
  return home;
}

function campLifecycle(state, home, f) {
  if (home.defeat || (active(home) && home.shortageDays > 100 && home.health < 12)) {
    if (home.status !== 'camp' && home.status !== 'ruin') {
      home.status = 'camp'; home.active = false; home.ruinedTick = state.tick; home.ruinReason = home.defeat?.reason || 'Sustained resource deprivation'; home.defeatedBy = home.defeat?.attackerId || null; home.health = 12; home.growth = 0;
      if (home.construction) {
        const unfinished = home.buildings.find(building => building.id === home.construction.buildingId);
        if (unfinished && unfinished.progress < 1) { unfinished.destroyed = true; unfinished.hp = 0; unfinished.destroyedTick = state.tick; }
      }
      home.construction = null; cancelTraining(state, home, null, 'Settlement abandoned');
      for (const k of RESOURCES) { const lost = home.stock[k] * .72; home.stock[k] -= lost; ledgerAdd(state, k, 'lost', lost); }
      for (const g of state.groups) if (g.originId === home.id) { g.phase = 'returning'; g.targetX = home.x; g.targetZ = home.z; g.reason = 'The permanent settlement was lost; returning to the survivors.'; }
      state.stats.abandonments++; emit(state, 'abandonment', `${home.name} is lost; ${home.population} survivors are displaced among its ruined buildings.`, f.id, { settlementId: home.id });
    }
    delete home.defeat;
  }
  if (home.status === 'camp' && home.population > 0) {
    demobilizeMilitary(state, home, home.soldiers); cancelTraining(state, home, null, 'Settlement displaced');
    const destination = state.settlements.filter(s => s.factionId === f.id && s.id !== home.id && active(s) && s.housingCapacity - s.population >= 24).sort((a, b) => distance(home, a) - distance(home, b))[0];
    if (destination && state.tick - (home.lastEvacuation || -100) >= 20 && state.groups.length < MAX_GROUPS - 2) {
      const away = state.groups.reduce((n, g) => n + (g.originId === home.id ? g.size : 0), 0), size = Math.min(24, Math.max(0, home.population - away), destination.housingCapacity - destination.population);
      if (size > 0) {
        home.population -= size; destination.population += size; home.lastEvacuation = state.tick;
        state.groups.push({ id: `g${state.nextId++}`, factionId: f.id, originId: destination.id, refugeeOriginId: home.id, refugees: true, kind: 'worker', size, x: home.x, z: home.z, prevX: home.x, prevZ: home.z,
          targetX: destination.x, targetZ: destination.z, targetId: destination.id, phase: 'returning', speed: 2.2, supply: 100, morale: 55, carrying: emptyResources(), observations: [], createdTick: state.tick,
          resourceKind: 'relief supplies', reason: `${size} displaced individuals travel to ${destination.name}.` }); state.stats.refugeeTransfers += size;
      }
    }
    const costs = { materials: 180, energy: 50, water: 40, [profile(f).staple]: 80 };
    if (state.tick - home.ruinedTick > 100 && home.population >= 24 && home.wellbeing > .98 && canAfford(home, costs)) { spend(state, home, costs, 'construction'); home.status = 'active'; home.active = true; home.health = 45; home.shortageDays = 0; home.starvation = 0; state.stats.rebuilt++; emit(state, 'rebuilding', `${home.name} uses returned supplies to rebuild permanent shelter.`, f.id, { settlementId: home.id }); }
  }
  if (home.population <= 0 && home.status !== 'ruin') { home.status = 'ruin'; home.active = false; home.health = 0; demobilizeMilitary(state, home, home.soldiers); cancelTraining(state, home, null, 'Settlement empty'); home.ruinedTick ??= state.tick; home.ruinReason ||= 'The last inhabitants died or sought refuge.'; emit(state, 'ruin', `${home.name} stands empty.`, f.id, { settlementId: home.id }); }
}

function cycleEconomy(state) {
  const phase = (state.tick % 600) / 600; state.season = { phase, name: phase < .5 ? 'Bloom' : 'Dry season', fertility: 1 + Math.sin(phase * Math.PI * 2) * .12, water: 1 + Math.cos(phase * Math.PI * 2) * .1 };
  for (const n of state.nodes) { const regenerated = Math.max(0, Math.min(n.maxAmount - n.amount, n.regeneration * (n.kind === 'water' ? state.season.water : 1))); n.amount += regenerated; ledgerAdd(state, n.kind, 'regenerated', regenerated); }
  updateAssignments(state);
  for (const home of state.settlements) { const f = factionOf(state, home); if (!f || !alive(home)) continue; infrastructure(state, home, f); consume(state, home, f); grow(state, home, f); construction(state, home, f); advanceTraining(state, home, f); planTraining(state, home, f); }
  updateAssignments(state);
  const dispatch = { traffic: new Map(), knownNodes: new Map(state.factions.map(f => [f.id, knownResourceNodes(state, f)])) };
  for (const g of state.groups) if (g.kind === 'worker' && g.phase !== 'returning') dispatch.traffic.set(`${g.factionId}:${g.targetId}`, (dispatch.traffic.get(`${g.factionId}:${g.targetId}`) || 0) + 1);
  const homes = state.settlements.filter(alive), first = state.tick % Math.max(1, homes.length);
  const order = [...homes.slice(first), ...homes.slice(0, first)];
  for (const home of order) { const f = factionOf(state, home); if (f && state.tick % 10 === 0) planFounding(state, home, f); }
  // Allocate one team per settlement per pass, rotating first access each cycle.
  // A busy mature capital must not monopolize the global group budget.
  for (let pass = 0; pass < 4; pass++) for (const home of order) { const f = factionOf(state, home); if (f) launchWorkers(state, home, f, dispatch); }
}

function updateSummaries(state) {
  for (const home of state.settlements) {
    const f = factionOf(state, home); if (!f) continue;
    home.worksites = [...new Set(state.groups.filter(g => g.kind === 'worker' && g.originId === home.id && !g.refugees).map(g => g.targetId))];
    home.economyReasons = [ `${home.homePresent} individuals at home; ${home.assigned.workers || 0} harvesting, ${home.assigned.military || 0} soldiers deployed, ${home.assigned.colonists || 0} settlers travelling.`,
      `${home.assigned.infrastructure || 0} infrastructure workers; ${home.assigned.construction || 0} builders; ${home.assigned.researchers || 0} researchers; ${home.assigned.training || 0} trainees in paid courses.`,
      home.status === 'camp' ? 'Displaced survivors depend on actual field harvests, returned cargo and relief to rebuild.' : `${home.buildings.filter(b => b.progress >= 1).length} completed buildings; housing for ${home.housingCapacity}; footprint radius ${Math.round(home.radius)}.`,
      home.missingResources?.length ? `Insufficient ${home.missingResources.join(', ')}: growth is suspended and prolonged shortages cause deaths.` : 'Deposits are finite. Cargo enters stores only when teams reach home; farms and power infrastructure report separate production.' ];
    observeHome(state, f, home);
  }
  for (const f of state.factions) {
    const homes = state.settlements.filter(s => s.factionId === f.id), pop = homes.reduce((n, s) => n + s.population, 0), status = f.defeatedBy ? 'capitulated' : homes.some(active) ? 'active' : pop > 0 ? 'displaced' : 'collapsed';
    if (f.status !== status && status === 'collapsed') { f.collapsedTick = state.tick; state.stats.collapses++; emit(state, 'collapse', `${f.name} has no surviving individuals or settlements.`, f.id); }
    f.status = status; if (status !== 'active') { f.researchWorkers = 0; f.intent = status === 'collapsed' ? 'Collapsed; its ruins preserve the history.' : status === 'capitulated' ? 'Capitulated; surviving civilians sustain their homes under the conquering civilisation’s control.' : 'Displaced survivors are gathering supplies or travelling to refuge.'; }
    f.economy = { population: pop, sovereignSettlements: homes.filter(home => active(home) && !home.occupiedBy).length, controlledSettlements: state.settlements.filter(home => active(home) && settlementController(state, home) === f.id).length, controlledPopulation: state.settlements.reduce((sum, home) => sum + (settlementController(state, home) === f.id ? home.population : 0), 0), workers: homes.reduce((n, s) => n + s.workers, 0), military: { infantry: homes.reduce((n, s) => n + s.military.infantry, 0), ranged: homes.reduce((n, s) => n + s.military.ranged, 0) }, training: homes.reduce((n, s) => n + trainingCount(s), 0), soldiers: homes.reduce((n, s) => n + s.soldiers, 0), fieldWorkers: homes.reduce((n, s) => n + (s.assigned.workers || 0), 0), settlements: homes.filter(active).length, camps: homes.filter(s => s.status === 'camp').length,
      stock: Object.fromEntries(RESOURCES.map(k => [k, homes.reduce((n, s) => n + s.stock[k], 0)])) };
  }
}

function finalizeCycle(state) {
  for (const home of state.settlements) {
    const f = factionOf(state, home); if (f) campLifecycle(state, home, f);
    home.lastDelivery = { ...home.deliveryAccumulator }; home.deliveryAccumulator = emptyResources();
    for (const k of RESOURCES) { if (home.stock[k] < 0 && home.stock[k] > -1e-8) home.stock[k] = 0; home.net[k] = home.stock[k] - (home.lastCycleStock?.[k] || 0); }
    home.lastCycleStock = { ...home.stock };
  }
  refreshResourceClaims(state); updateAssignments(state); updateSummaries(state);
}

export function stepSimulation(state, steps = 1) {
  const count = Math.max(0, Math.floor(Number.isFinite(steps) ? steps : 0));
  const indexes = { homes: new Map(state.settlements.map(s => [s.id, s])), nodes: new Map(state.nodes.map(n => [n.id, n])), factions: new Map(state.factions.map(f => [f.id, f])) };
  for (let i = 0; i < count; i++) {
    state.step++; state.time = state.step / PULSES; state.tick = Math.floor(state.step / PULSES);
    for (const g of state.groups) { g.prevX = g.x; g.prevZ = g.z; }
    processWorkers(state, indexes); stepKnowledge(state); if (state.step % PULSES === 0) cycleEconomy(state);
    stepStrategy(state, SIM_DT); if (state.step % PULSES === 0) { stepProgression(state); finalizeCycle(state); }
  }
  return state;
}

export function getSummary(state) {
  return { seed: state.seed, cycle: state.tick, step: state.step, time: state.time, population: state.settlements.reduce((n, s) => n + s.population, 0), settlements: state.settlements.filter(active).length,
    buildings: state.settlements.reduce((n, s) => n + s.buildings.length, 0), fieldWorkers: state.groups.filter(g => g.kind === 'worker').reduce((n, g) => n + g.size, 0), groups: state.groups.length, stats: { ...state.stats }, ledgerResidual: ledgerResidual(state),
    factions: state.factions.map(f => ({ id: f.id, name: f.name, species: f.species, status: f.status, population: f.economy?.population || 0, level: f.tech.level, intent: f.intent })) };
}
