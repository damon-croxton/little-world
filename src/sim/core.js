import { hashSeed, random, clamp, distance, emit } from '../shared.js';
import { generateWorld, terrainAt, heightAt } from '../world.js';
import { createFactions, stepProgression } from './progression.js';
import { stepStrategy } from './strategy.js';
import { RESOURCES, emptyResources, initializeLedger, inventory, ledgerAdd, canAfford, spend, depositCargo, discardCargo, ledgerResidual } from './economy.js';

export const SIM_DT = .1;
const PULSES = 10, MAX_SETTLEMENTS = 48, MAX_GROUPS = 480, MAX_POPULATION = 4000;
const PROFILES = {
  human: { needs: { food: .018, water: .020, energy: .003, materials: .0008 }, birth: { food: 1.5, water: .5, energy: .3, materials: 1.2 }, growth: .005, staple: 'food' },
  machine: { needs: { food: 0, water: .008, energy: .032, materials: .006 }, birth: { food: 0, water: .4, energy: 4, materials: 3.5 }, growth: .0032, staple: 'energy' },
  hive: { needs: { food: .026, water: .015, energy: .002, materials: .001 }, birth: { food: 2.5, water: .6, energy: .2, materials: .6 }, growth: .0065, staple: 'food' },
};
const BUILDING_COST = {
  housing: { materials: 40, energy: 8 }, storage: { materials: 70, energy: 14 }, workshop: { materials: 80, energy: 30 },
  farm: { materials: 35, energy: 6 }, power: { materials: 55, energy: 20 }, barracks: { materials: 65, energy: 10 },
  lab: { materials: 80, energy: 40 }, hub: { materials: 100, energy: 30 },
};
const active = s => s.population > 0 && s.status !== 'camp' && s.status !== 'ruin';
const alive = s => s.population > 0 && s.status !== 'ruin';
const factionOf = (s, home) => s.factions.find(f => f.id === home.factionId);
const profile = f => PROFILES[f.species] || PROFILES.human;
const modifier = (f, key) => clamp(f.modifiers?.[key] ?? 1, .25, 4);
const buildingCount = (s, kind) => s.buildings.filter(b => b.kind === kind && b.progress >= 1).length;
const needsFor = (s, f, present = s.homePresent ?? s.population) => {
  const n = profile(f).needs;
  return { food: n.food * present, water: n.water * present / modifier(f, 'waterEfficiency'), energy: n.energy * present / modifier(f, 'energyEfficiency'), materials: n.materials * present / modifier(f, 'materialEfficiency') };
};

function buildingRecord(state, home, kind, progress = 0) {
  const index = home.buildings.length, angle = index * 2.399963229728653 + (hashSeed(home.id + state.seed) % 100) / 100;
  const radius = index === 0 ? 0 : 2.85 * Math.sqrt(index);
  let x = home.x + Math.cos(angle) * radius, z = home.z + Math.sin(angle) * radius;
  if (heightAt(x, z, state.seed) < -.3) { x = home.x + Math.cos(angle + 1.5) * radius; z = home.z + Math.sin(angle + 1.5) * radius; }
  const b = { id: `b${state.nextId++}`, kind, x, z, rotation: angle + Math.PI / 2, progress, createdTick: state.tick, completedTick: progress >= 1 ? state.tick : null };
  home.radius = Math.max(home.radius, radius + 3.2);
  home.roads.push({ from: { x: home.x, z: home.z }, to: { x, z } });
  return b;
}

function refreshBuildings(home, f) {
  const completed = home.buildings.filter(b => b.progress >= 1);
  home.housingCapacity = Math.min(MAX_POPULATION, Math.round((40 + completed.filter(b => b.kind === 'housing').length * 40) * modifier(f, 'capacity')));
  home.carryingCapacity = home.housingCapacity;
  home.capacity = Math.round((500 + completed.filter(b => b.kind === 'storage').length * 600) * modifier(f, 'capacity'));
  home.level = clamp(1 + Math.floor(Math.log2(Math.max(1, home.population / 100))), 1, 6);
  home.infrastructureWorkers = home.status === 'camp' ? 0 : Math.min(Math.floor(home.workers * .22), completed.filter(b => b.kind === 'farm' || b.kind === 'power').length * 4);
}

function makeSettlement(state, faction, point, population, founding = false) {
  const names = { human: ['Hearth', 'Crossing', 'Haven', 'Terrace', 'Vale'], machine: ['Foundry', 'Relay', 'Array', 'Forge', 'Nexus'], hive: ['Cradle', 'Bloom', 'Chorus', 'Root', 'Canopy'] };
  const ordinal = state.settlements.filter(s => s.factionId === faction.id).length;
  const s = { id: `s${state.nextSettlementId++}`, factionId: faction.id, lastFactionId: faction.id, name: `${faction.name.split(' ')[0]} ${(names[faction.species] || names.human)[ordinal % 5]}`,
    x: point.x, z: point.z, population, soldiers: founding ? 0 : 10 + Math.floor(faction.traits.aggression * 8), workers: 0,
    stock: founding ? emptyResources() : { food: faction.species === 'machine' ? 0 : 220, water: 260, energy: faction.species === 'machine' ? 280 : 180, materials: 180 },
    capacity: 1100, level: 1, health: 100, status: 'active', active: true, radius: 4, growth: 0,
    buildings: [], roads: [], worksites: [], construction: null, housingCapacity: 200, carryingCapacity: 200,
    assigned: {}, availableWorkers: 0, homePresent: population, infrastructureWorkers: 0,
    lastProduction: emptyResources(), lastConsumption: emptyResources(), lastDelivery: emptyResources(), deliveryAccumulator: emptyResources(), net: emptyResources(), labor: {},
    foundedTick: state.tick, lastExpansion: state.tick, lastUpgrade: state.tick, lastWorker: -100, lastBirth: state.tick, lastGrowthEvent: state.tick,
    shortageDays: 0, starvation: 0, wellbeing: 1, economyReasons: [], lastCycleStock: null };
  const kinds = founding ? ['hub', 'housing', 'housing', 'storage', faction.species === 'machine' ? 'power' : 'farm']
    : ['hub', 'housing', 'housing', 'housing', 'housing', 'storage', 'workshop', 'farm', 'power', 'barracks'];
  for (const kind of kinds) s.buildings.push(buildingRecord(state, s, kind, 1));
  s.workers = population - s.soldiers; refreshBuildings(s, faction); s.lastCycleStock = { ...s.stock };
  return s;
}

function observeHome(state, f, home, survey = false) {
  f.knowledge[home.id] = { id: home.id, kind: 'settlement', x: home.x, z: home.z, ownerId: f.id, populationEstimate: home.population, soldiersEstimate: home.soldiers, observedTick: state.tick, reportedTick: state.tick, status: home.status, confidence: 1 };
  if (survey) for (const node of state.nodes) if (distance(home, node) <= 30) {
    f.knowledge[node.id] = { id: node.id, kind: 'resource', resourceKind: node.kind, x: node.x, z: node.z, ownerId: null, amountEstimate: Math.round(node.amount), abundanceEstimate: Math.round(node.amount), richnessEstimate: node.richness, observedTick: state.tick, reportedTick: state.tick, confidence: 1 };
  }
}

export function createSimulation(seed = 'littleworld') {
  const key = String(seed || 'littleworld').slice(0, 160), world = generateWorld(key);
  const s = { seed: key, rng: hashSeed(key), tick: 0, step: 0, time: 0, nextId: 1, nextSettlementId: 0, factions: [], settlements: [], groups: [], nodes: world.nodes, bounds: world.bounds, events: [], tradeOffers: [],
    stats: { births: 0, deaths: 0, discoveries: 0, reports: 0, raids: 0, battles: 0, retreats: 0, trades: 0, breakthroughs: 0, expeditions: 0, deliveries: 0, expansions: 0, abandonments: 0, refugeeTransfers: 0, rebuilt: 0, collapses: 0, buildings: 0, harvested: 0 }, terrain: { seed: key }, season: { name: 'Bloom', phase: 0, fertility: 1, water: 1 } };
  s.factions = createFactions(s, Math.min(6, world.starts.length));
  const offset = hashSeed(key + ':settlement-geography') % world.starts.length;
  for (const [i, f] of s.factions.entries()) {
    f.status = 'active'; f.knowledge ||= {}; f.history ||= []; f.relations ||= {}; f.experience ||= { exploration: 0, combat: 0, trade: 0 };
    const home = makeSettlement(s, f, world.starts[(i + offset) % world.starts.length], 96 + Math.floor(random(s) * 17));
    s.settlements.push(home); observeHome(s, f, home, true); f.intent = `Establish ${home.name}; survey deposits and assign real harvesting teams.`;
    emit(s, 'founding', `${f.name} establish ${home.name} with ${home.population} individuals and ${home.buildings.length} buildings.`, f.id, { settlementId: home.id });
  }
  for (const node of s.nodes) { node.maxAmount ??= node.amount; node.regeneration ??= 0; node.radius ??= 2.5; }
  initializeLedger(s); updateAssignments(s); updateSummaries(s);
  return s;
}

function updateAssignments(state) {
  const researchers = Object.fromEntries(state.factions.map(f => [f.id, Math.max(0, Math.floor(f.researchWorkers || 0))]));
  for (const home of state.settlements) {
    const f = factionOf(state, home), a = { workers: 0, scouts: 0, traders: 0, colonists: 0, military: 0, civilianAway: 0, researchers: 0, construction: 0, infrastructure: 0 };
    for (const g of state.groups) if (g.originId === home.id && !g.finished && g.size > 0) {
      if (g.kind === 'army') a.military += g.size; else if (g.kind === 'worker') a.workers += g.size; else if (g.kind === 'scout') a.scouts += g.size; else if (g.kind === 'trader') a.traders += g.size; else if (g.kind === 'colonist') a.colonists += g.size;
    }
    a.civilianAway = a.workers + a.scouts + a.traders + a.colonists;
    home.population = Math.max(0, Math.floor(home.population));
    home.soldiers = clamp(Math.floor(home.soldiers || 0), a.military, Math.max(a.military, home.population - a.civilianAway));
    home.workers = Math.max(0, home.population - home.soldiers); home.homePresent = Math.max(0, home.population - a.civilianAway - a.military);
    let available = Math.max(0, home.workers - a.civilianAway);
    if (f && active(home)) {
      refreshBuildings(home, f); a.infrastructure = Math.min(available, home.infrastructureWorkers || 0); available -= a.infrastructure;
      const researchHere = !f.researchHomeId || f.researchHomeId === home.id;
      a.researchers = researchHere ? Math.min(researchers[f.id] || 0, 6 + buildingCount(home, 'lab') * 8, Math.max(0, available - 8)) : 0;
      researchers[f.id] -= a.researchers; available -= a.researchers;
      a.construction = home.construction ? Math.min(home.construction.workers || 12, Math.max(0, available - 8)) : 0; available -= a.construction;
    }
    home.assigned = a; home.availableWorkers = available;
  }
}

function move(state, group, target, arrival = 1) {
  const d = distance(group, target); if (d <= arrival) return true;
  if (group.movementFactor == null || state.step % 5 === 0) group.movementFactor = terrainAt(group.x, group.z, state.seed).movement;
  const pace = group.speed * (group.movementFactor || .8) * SIM_DT, angle = Math.atan2(target.z - group.z, target.x - group.x), amount = Math.min(d - arrival * .5, pace);
  for (const offset of [0, .5, -.5, 1.05, -1.05, 1.5, -1.5]) {
    const x = group.x + Math.cos(angle + offset) * amount, z = group.z + Math.sin(angle + offset) * amount;
    if (heightAt(x, z, state.seed) < -.3) continue;
    group.x = x; group.z = z; group.stuckTime = 0; return distance(group, target) <= arrival;
  }
  group.stuckTime = (group.stuckTime || 0) + SIM_DT; return false;
}

function reportWorker(state, g, f) {
  for (const observation of g.observations || []) { const prior = f.knowledge[observation.id]; if (!prior || prior.observedTick <= observation.observedTick) f.knowledge[observation.id] = { ...observation, reportedTick: state.tick }; }
  if (g.salvageSamples > 0) f.experience.salvage = (f.experience.salvage || 0) + g.salvageSamples;
}

function returnWorker(state, g, home) {
  g.phase = 'returning'; g.targetX = home.x; g.targetZ = home.z; g.activity = 'hauling';
  const node = state.nodes.find(n => n.id === g.targetId);
  if (node) g.observations = [{ id: node.id, kind: 'resource', resourceKind: node.kind, x: node.x, z: node.z, ownerId: null, amountEstimate: Math.round(node.amount), abundanceEstimate: Math.round(node.amount), richnessEstimate: node.richness, observedTick: state.tick, reportedTick: null, confidence: .96 }];
}

function processWorkers(state, indexes) {
  const remove = new Set();
  for (const g of state.groups) {
    if (g.kind !== 'worker' && g.kind !== 'colonist') continue;
    const home = indexes.homes.get(g.originId), f = indexes.factions.get(g.factionId);
    if (!home || !f || home.population <= 0) { discardCargo(state, g); remove.add(g.id); continue; }
    g.supply = Math.max(0, g.supply - .12 * SIM_DT);
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
      if (!move(state, g, node, Math.max(1, node.radius * .55))) { if (g.stuckTime > 18 || state.time - g.createdTick > 260) returnWorker(state, g, home); continue; }
      g.phase = 'working'; g.activity = `harvesting ${node.subtype || node.kind}`; g.workTime = 0;
    }
    if (g.phase === 'working') {
      const rate = g.size * (.52 + node.richness * .18) * (.8 + f.traits.industry * .5) * (1 + (f.tech.level || 0) * .06);
      const load = RESOURCES.reduce((n, k) => n + (g.carrying[k] || 0), 0), extracted = Math.max(0, Math.min(node.amount, g.capacity - load, rate * SIM_DT));
      node.amount -= extracted; g.carrying[node.kind] += extracted; g.extractedTotal += extracted; g.workTime += SIM_DT;
      g.workProgress = (load + extracted) / g.capacity; g.workRemaining = Math.max(0, (g.capacity - load - extracted) / Math.max(.1, rate));
      ledgerAdd(state, node.kind, 'extracted', extracted); state.stats.harvested += extracted;
      if (f.species === 'machine' && node.kind === 'materials') g.salvageSamples = (g.salvageSamples || 0) + extracted;
      if (g.workProgress >= .999 || node.amount < .01 || g.supply < 15) returnWorker(state, g, home);
    }
  }
  if (remove.size) state.groups = state.groups.filter(g => !remove.has(g.id));
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
  for (const node of dispatch.knownNodes.get(f.id)) {
    const known = f.knowledge[node.id]; if (!known || known.reportedTick == null || known.reportedTick > state.tick || distance(home, known) > 65) continue;
    if (f.species === 'machine' && node.kind === 'food') continue;
    const estimate = known.amountEstimate ?? known.abundanceEstimate ?? 100;
    if (estimate < 5 && (node.regeneration <= 0 || state.tick - known.observedTick < 80)) continue;
    const traffic = dispatch.traffic.get(node.id) || 0;
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
  const costs = { [profile(f).staple]: size * .12, water: size * .10 }; if (!canAfford(home, costs)) return;
  spend(state, home, costs, 'consumed'); const capacity = size * 6 * modifier(f, 'carryCapacity');
  state.groups.push({ id: `g${state.nextId++}`, factionId: f.id, originId: home.id, kind: 'worker', size, x: home.x, z: home.z, prevX: home.x, prevZ: home.z,
    targetX: best.node.x, targetZ: best.node.z, targetId: best.node.id, phase: 'outbound', speed: f.species === 'machine' ? 2.8 : 2.65, supply: 100, morale: 90,
    capacity, cargoCapacity: capacity, carrying: emptyResources(), observations: [], resourceKind: best.node.kind, createdTick: state.tick,
    workProgress: 0, workRemaining: 0, workTime: 0, extractedTotal: 0, reason: `${size} individuals assigned to a reported ${best.node.subtype || best.node.kind} deposit; supplies enter storage only after return.`, activity: 'travelling' });
  home.assigned.workers += size; home.assigned.civilianAway += size; home.availableWorkers -= size; home.lastWorker = state.tick; state.stats.expeditions++;
  dispatch.traffic.set(best.node.id, (dispatch.traffic.get(best.node.id) || 0) + 1);
}

function infrastructure(state, home, f) {
  home.lastProduction = emptyResources(); home.labor = {}; if (!active(home) || (home.contestedUntil || 0) >= state.tick) return;
  let workers = home.assigned.infrastructure;
  const terrain = terrainAt(home.x, home.z, state.seed), factor = .55 + (terrain.fertility || .5) * .75;
  for (const b of home.buildings) {
    if (b.progress < 1 || !['farm', 'power'].includes(b.kind) || workers <= 0) continue;
    const crew = Math.min(4, workers); workers -= crew; b.workersAssigned = crew;
    const kind = b.kind === 'farm' ? 'food' : 'energy'; if (f.species === 'machine' && kind === 'food') { b.workersAssigned = 0; continue; }
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
      home.population -= deaths; home.starvation -= deaths; state.stats.deaths += deaths;
      home.soldiers = Math.min(home.soldiers, Math.max(home.assigned.military, home.population - home.assigned.civilianAway));
      if (state.tick - (home.lastMortalityEvent || -30) > 28) { emit(state, 'shortage', `${home.name} is losing inhabitants after ${home.shortageDays} cycles of ${missing.join(' and ')} shortage.`, f.id, { settlementId: home.id, deaths }); home.lastMortalityEvent = state.tick; }
    }
  } else home.starvation = Math.max(0, home.starvation - .1);
  home.missingResources = missing;
}

function grow(state, home, f) {
  if (!active(home) || home.health < 65 || home.wellbeing < .98 || (home.contestedUntil || 0) >= state.tick || home.population >= home.housingCapacity) return;
  const p = profile(f), needs = needsFor(home, f), costs = { ...p.birth }; costs.materials /= modifier(f, 'materialEfficiency');
  const reserves = Object.fromEntries(RESOURCES.map(k => [k, needs[k] * 12]));
  if (!canAfford(home, costs, reserves)) { home.growth = Math.min(.99, home.growth); return; }
  const space = clamp(1 - home.population / home.housingCapacity, .10, .75);
  home.growth += p.growth * home.population * space * modifier(f, 'growth') * (f.species === 'machine' ? modifier(f, 'replication') : 1);
  let births = 0;
  while (home.growth >= 1 && births < 12 && home.population < home.housingCapacity && canAfford(home, costs, reserves)) { spend(state, home, costs, 'consumed'); home.population++; home.growth--; births++; state.stats.births++; }
  if (births && state.tick - home.lastGrowthEvent > 75) { emit(state, 'growth', `${home.name} now supports ${home.population} individuals in ${buildingCount(home, 'housing')} residential buildings; new life consumes real reserves.`, f.id, { settlementId: home.id }); home.lastGrowthEvent = state.tick; }
}

function construction(state, home, f) {
  if (!active(home) || (home.contestedUntil || 0) >= state.tick) return;
  if (home.construction) {
    const b = home.buildings.find(b => b.id === home.construction.buildingId); if (!b) { home.construction = null; return; }
    b.progress = Math.min(1, b.progress + home.assigned.construction / (100 + (BUILDING_COST[b.kind]?.materials || 40))); home.construction.progress = b.progress;
    if (b.progress >= 1) {
      b.completedTick = state.tick; home.construction = null; state.stats.buildings++;
      if (state.tick - (home.lastBuildingEvent || -40) > 35) { emit(state, 'building', `${home.name} completed a ${b.kind}; ${home.buildings.length} structures now occupy a ${Math.round(home.radius * 2)}-unit footprint.`, f.id, { settlementId: home.id, buildingId: b.id }); home.lastBuildingEvent = state.tick; }
      refreshBuildings(home, f);
    }
    return;
  }
  if (home.buildings.length >= 110 || home.availableWorkers < 12 || home.health < 45) return;
  let kind = null;
  if (home.population > home.housingCapacity * .69) kind = 'housing';
  else if (home.capacity < home.population * 5 + 300) kind = 'storage';
  else if (state.tick > 35 && buildingCount(home, 'lab') < Math.max(1, Math.ceil(home.population / 240))) kind = 'lab';
  else if (f.species !== 'machine' && buildingCount(home, 'farm') < Math.ceil(home.population / 140)) kind = 'farm';
  else if (buildingCount(home, 'power') < Math.ceil(home.population / (f.species === 'machine' ? 100 : 280))) kind = 'power';
  else if (buildingCount(home, 'workshop') < Math.ceil(home.population / 200)) kind = 'workshop';
  else if (buildingCount(home, 'barracks') < Math.ceil(home.soldiers / 120)) kind = 'barracks';
  if (!kind) return;
  const cost = { ...BUILDING_COST[kind] }, needs = needsFor(home, f); cost.materials /= modifier(f, 'materialEfficiency');
  if (!canAfford(home, cost, { food: needs.food * 8, water: needs.water * 8, energy: needs.energy * 8, materials: 15 })) return;
  spend(state, home, cost, 'construction'); const building = buildingRecord(state, home, kind); home.buildings.push(building);
  home.construction = { buildingId: building.id, kind, workers: clamp(Math.floor(home.population * .07), 10, 28), progress: 0, cost, startedTick: state.tick };
}

function train(state, home, f) {
  if (!active(home) || state.tick % 4 !== 0 || (home.contestedUntil || 0) >= state.tick) return;
  const share = clamp(home.militaryTarget ?? (.10 + f.traits.aggression * .09), .08, .32), desired = Math.floor(home.population * share), deployed = home.assigned.military;
  if (home.soldiers > Math.max(desired, deployed)) { home.soldiers -= Math.min(4, home.soldiers - Math.max(desired, deployed)); return; }
  const n = Math.min(Math.ceil(home.population * .012), desired - home.soldiers, Math.max(0, home.availableWorkers - 12)), cost = { materials: n * .7, [profile(f).staple]: n * .8 };
  if (n > 0 && canAfford(home, cost, { water: home.population * .08 })) { spend(state, home, cost, 'consumed'); home.soldiers += n; }
}

function planFounding(state, home, f) {
  if (!active(home) || state.settlements.length >= MAX_SETTLEMENTS || state.groups.length >= MAX_GROUPS - 6 || home.population < 280 || state.tick - home.lastExpansion < 280 || home.health < 75) return;
  if (state.settlements.filter(s => s.factionId === f.id && active(s)).length >= 8 || state.groups.some(g => g.kind === 'colonist' && g.factionId === f.id)) return;
  const size = clamp(Math.floor(home.population * .18), 48, 80); if (home.availableWorkers < size + 12) return;
  let best = null;
  for (const k of Object.values(f.knowledge)) {
    if (k.kind !== 'resource' || k.reportedTick == null || k.reportedTick > state.tick) continue;
    const d = distance(home, k); if (d < 35 || d > 95 || state.settlements.some(s => alive(s) && distance(s, k) < Math.max(32, s.radius + 15))) continue;
    if (state.groups.some(g => g.kind === 'colonist' && Math.hypot(g.targetX - k.x, g.targetZ - k.z) < 32)) continue;
    const terrain = terrainAt(k.x, k.z, state.seed); if (terrain.height < .4 || terrain.roughness > .65) continue;
    const resources = Object.values(f.knowledge).filter(n => n.kind === 'resource' && distance(n, k) < 28), types = new Set(resources.map(n => n.resourceKind));
    if (!types.has('water') || !types.has('materials') || !types.has(profile(f).staple)) continue;
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
      home.status = 'camp'; home.active = false; home.ruinedTick = state.tick; home.ruinReason = home.defeat?.reason || 'Sustained resource deprivation'; home.defeatedBy = home.defeat?.attackerId || null; home.health = 12; home.growth = 0; home.construction = null;
      for (const k of RESOURCES) { const lost = home.stock[k] * .72; home.stock[k] -= lost; ledgerAdd(state, k, 'lost', lost); }
      for (const g of state.groups) if (g.originId === home.id) { g.phase = 'returning'; g.targetX = home.x; g.targetZ = home.z; g.reason = 'The permanent settlement was lost; returning to the survivors.'; }
      state.stats.abandonments++; emit(state, 'abandonment', `${home.name} is lost; ${home.population} survivors are displaced among its ruined buildings.`, f.id, { settlementId: home.id });
    }
    delete home.defeat;
  }
  if (home.status === 'camp' && home.population > 0) {
    home.soldiers = state.groups.reduce((n, g) => n + (g.originId === home.id && g.kind === 'army' && !g.finished ? g.size : 0), 0);
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
  if (home.population <= 0 && home.status !== 'ruin') { home.status = 'ruin'; home.active = false; home.health = 0; home.soldiers = 0; home.ruinedTick ??= state.tick; home.ruinReason ||= 'The last inhabitants died or sought refuge.'; emit(state, 'ruin', `${home.name} stands empty.`, f.id, { settlementId: home.id }); }
}

function cycleEconomy(state) {
  const phase = (state.tick % 600) / 600; state.season = { phase, name: phase < .5 ? 'Bloom' : 'Dry season', fertility: 1 + Math.sin(phase * Math.PI * 2) * .12, water: 1 + Math.cos(phase * Math.PI * 2) * .1 };
  for (const n of state.nodes) { const regenerated = Math.max(0, Math.min(n.maxAmount - n.amount, n.regeneration * (n.kind === 'water' ? state.season.water : 1))); n.amount += regenerated; ledgerAdd(state, n.kind, 'regenerated', regenerated); }
  updateAssignments(state);
  for (const home of state.settlements) { const f = factionOf(state, home); if (!f || !alive(home)) continue; infrastructure(state, home, f); consume(state, home, f); grow(state, home, f); construction(state, home, f); train(state, home, f); }
  updateAssignments(state);
  const dispatch = { traffic: new Map(), knownNodes: new Map(state.factions.map(f => [f.id, state.nodes.filter(n => f.knowledge[n.id])])) };
  for (const g of state.groups) if (g.kind === 'worker' && g.phase !== 'returning') dispatch.traffic.set(g.targetId, (dispatch.traffic.get(g.targetId) || 0) + 1);
  for (const home of state.settlements) { const f = factionOf(state, home); if (!f || !alive(home)) continue; if (state.tick % 10 === 0) planFounding(state, home, f); for (let n = 0; n < 4; n++) launchWorkers(state, home, f, dispatch); }
}

function progressionWithLedger(state) {
  const before = inventory(state, false), recorded = Object.fromEntries(RESOURCES.map(k => [k, state.resourceLedger[k].research + state.resourceLedger[k].consumed + state.resourceLedger[k].lost]));
  stepProgression(state); const after = inventory(state, false);
  // Explicit subsystem entries win. The compatibility bridge records only any
  // remaining inventory sink while progression is upgraded independently.
  for (const k of RESOURCES) { const l = state.resourceLedger[k], explicitlyRecorded = l.research + l.consumed + l.lost - recorded[k]; ledgerAdd(state, k, 'research', Math.max(0, before[k] - after[k] - explicitlyRecorded)); }
}

function updateSummaries(state) {
  for (const home of state.settlements) {
    const f = factionOf(state, home); if (!f) continue;
    home.worksites = [...new Set(state.groups.filter(g => g.kind === 'worker' && g.originId === home.id && !g.refugees).map(g => g.targetId))];
    home.economyReasons = [ `${home.homePresent} individuals at home; ${home.assigned.workers || 0} harvesting, ${home.assigned.military || 0} soldiers deployed, ${home.assigned.colonists || 0} settlers travelling.`,
      `${home.assigned.infrastructure || 0} infrastructure workers; ${home.assigned.construction || 0} builders; ${home.assigned.researchers || 0} researchers.`,
      home.status === 'camp' ? 'Displaced survivors depend on actual field harvests, returned cargo and relief to rebuild.' : `${home.buildings.filter(b => b.progress >= 1).length} completed buildings; housing for ${home.housingCapacity}; footprint radius ${Math.round(home.radius)}.`,
      home.missingResources?.length ? `Insufficient ${home.missingResources.join(', ')}: growth is suspended and prolonged shortages cause deaths.` : 'Deposits are finite. Cargo enters stores only when teams reach home; farms and power infrastructure report separate production.' ];
    observeHome(state, f, home);
  }
  for (const f of state.factions) {
    const homes = state.settlements.filter(s => s.factionId === f.id), pop = homes.reduce((n, s) => n + s.population, 0), status = homes.some(active) ? 'active' : pop > 0 ? 'displaced' : 'collapsed';
    if (f.status !== status && status === 'collapsed') { f.collapsedTick = state.tick; state.stats.collapses++; emit(state, 'collapse', `${f.name} has no surviving individuals or settlements.`, f.id); }
    f.status = status; if (status !== 'active') { f.researchWorkers = 0; f.intent = status === 'collapsed' ? 'Collapsed; its ruins preserve the history.' : 'Displaced survivors are gathering supplies or travelling to refuge.'; }
    f.economy = { population: pop, workers: homes.reduce((n, s) => n + s.workers, 0), soldiers: homes.reduce((n, s) => n + s.soldiers, 0), fieldWorkers: homes.reduce((n, s) => n + (s.assigned.workers || 0), 0), settlements: homes.filter(active).length, camps: homes.filter(s => s.status === 'camp').length,
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
  updateAssignments(state); updateSummaries(state);
}

export function stepSimulation(state, steps = 1) {
  const count = Math.max(0, Math.floor(Number.isFinite(steps) ? steps : 0));
  const indexes = { homes: new Map(state.settlements.map(s => [s.id, s])), nodes: new Map(state.nodes.map(n => [n.id, n])), factions: new Map(state.factions.map(f => [f.id, f])) };
  for (let i = 0; i < count; i++) {
    state.step++; state.time = state.step / PULSES; state.tick = Math.floor(state.step / PULSES);
    for (const g of state.groups) { g.prevX = g.x; g.prevZ = g.z; }
    processWorkers(state, indexes); if (state.step % PULSES === 0) cycleEconomy(state);
    stepStrategy(state, SIM_DT); if (state.step % PULSES === 0) { progressionWithLedger(state); finalizeCycle(state); }
  }
  return state;
}

export function getSummary(state) {
  return { seed: state.seed, cycle: state.tick, step: state.step, time: state.time, population: state.settlements.reduce((n, s) => n + s.population, 0), settlements: state.settlements.filter(active).length,
    buildings: state.settlements.reduce((n, s) => n + s.buildings.length, 0), fieldWorkers: state.groups.filter(g => g.kind === 'worker').reduce((n, g) => n + g.size, 0), groups: state.groups.length, stats: { ...state.stats }, ledgerResidual: ledgerResidual(state),
    factions: state.factions.map(f => ({ id: f.id, name: f.name, species: f.species, status: f.status, population: f.economy?.population || 0, level: f.tech.level, intent: f.intent })) };
}
