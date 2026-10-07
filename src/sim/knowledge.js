import { hashSeed, clamp, distance } from '../shared.js';
import { WORLD_RADIUS } from '../world.js';
import { lineOfSight as navigationLineOfSight } from './navigation.js';
import { factionController, settlementController, groupController } from './control.js';
import { isServingSoldier, getSoldier, getSoldiers, soldierCounts } from './soldiers.js';

// Sight belongs to physical homes, civilian parties and authoritative soldiers.
// There are three deliberately separate information layers:
//   visibility: what any surviving friendly observer can currently see;
//   visualMemory: last-seen places, useful to an observer but not a command feed;
//   knowledge / commandExplored: reports which have actually reached home.
export const KNOWLEDGE_GRID = Object.freeze({ cellSize: 5, width: Math.ceil(WORLD_RADIUS * 2 / 5), height: Math.ceil(WORLD_RADIUS * 2 / 5), minX: -WORLD_RADIUS, minZ: -WORLD_RADIUS, updatePulses: 5 });
const CELL_COUNT = KNOWLEDGE_GRID.width * KNOWLEDGE_GRID.height;
const alive = o => o && !o.finished && (o.size ?? o.population ?? 1) > 0 && o.status !== 'ruin';
const getFaction = (state, faction) => typeof faction === 'string' ? state.factions.find(f => f.id === faction) : faction;
const finitePoint = p => p && Number.isFinite(p.x) && Number.isFinite(p.z);
// Biological identity is retained under occupation. A native town under enemy
// control must still be inspected locally and reported like any other contact.
const commandOwned = (state, factionId, object) => ('population' in object ? settlementController(state, object) : object.commandFactionId ? groupController(state, object) : object.factionId) === factionId;
const emptyStock = () => ({ food: 0, water: 0, energy: 0, materials: 0 });
const clone = value => value == null ? value : structuredClone(value);
const viewCache = new WeakMap();
const rasterCache = new WeakMap();
const sensorCache = new WeakMap();
const observationIndexes = new WeakMap();
const soldierVisionCache = new WeakMap();
const renderWorldIds = new WeakMap();
let nextRenderWorldId = 1;
function renderWorldId(state) {
  if (!renderWorldIds.has(state)) renderWorldIds.set(state, nextRenderWorldId++);
  return renderWorldIds.get(state);
}

// Physical soldiers extend local sight without giving a distant capital their
// observations. The hash is shared by view filtering and the sparse fog union.
function soldierVision(state) {
  const stamp = `${state.step ?? state.tick}:${state.soldierRevision || 0}:${state.navigationRevision || 0}`;
  const prior = soldierVisionCache.get(state);
  if (prior?.stamp === stamp) return prior;
  const groups = new Map((state.groups || []).map(group => [group.id, group])), byFaction = new Map(), span = 15;
  for (const home of state.settlements || []) for (const soldier of home.soldierRoster || []) {
    if (!isServingSoldier(soldier) || !soldier.positioned) continue;
    const group = soldier.groupId ? groups.get(soldier.groupId) : null;
    if (soldier.groupId && (!group || group.finished)) continue;
    const owner = group ? localGroupController(state, group) : settlementController(state, home);
    if (!byFaction.has(owner)) byFaction.set(owner, { observers: [], bins: new Map() });
    const entry = byFaction.get(owner), source = { id: soldier.id, x: soldier.x, z: soldier.z, factionId: owner, commandFactionId: owner, kind: 'army', size: 1, sightRadius: 15 };
    const sensor = { source, group, home: group ? null : home };
    entry.observers.push(sensor);
    const key = `${Math.floor(source.x / span)}:${Math.floor(source.z / span)}`;
    if (!entry.bins.has(key)) entry.bins.set(key, []);
    entry.bins.get(key).push(sensor);
  }
  const value = { stamp, byFaction, groups, span }; soldierVisionCache.set(state, value); return value;
}

function soldierWitness(state, factionId, point, index = soldierVision(state)) {
  const bins = index.byFaction.get(factionId)?.bins;
  if (!bins || !finitePoint(point)) return null;
  const { span } = index, r = 15;
  for (let z = Math.floor((point.z - r) / span); z <= Math.floor((point.z + r) / span); z++) for (let x = Math.floor((point.x - r) / span); x <= Math.floor((point.x + r) / span); x++) {
    for (const sensor of bins.get(`${x}:${z}`) || []) if (visibleToGroup(state, sensor.source, point, r)) return sensor;
  }
  return null;
}

function extendSoldierSight(state, faction, visibility, index) {
  const observers = index.byFaction.get(faction.id)?.observers || [];
  const candidates = new Set(), { minX, minZ, cellSize, width, height } = KNOWLEDGE_GRID;
  for (const { source } of observers) {
    const r = source.sightRadius;
    for (let z = Math.max(0, Math.floor((source.z - r - minZ) / cellSize)); z <= Math.min(height - 1, Math.floor((source.z + r - minZ) / cellSize)); z++) {
      for (let x = Math.max(0, Math.floor((source.x - r - minX) / cellSize)); x <= Math.min(width - 1, Math.floor((source.x + r - minX) / cellSize)); x++) {
        const cell = z * width + x; if (!visibility.visible[cell]) candidates.add(cell);
      }
    }
  }
  for (const cell of candidates) {
    const witness = soldierWitness(state, faction.id, knowledgeCellPoint(cell), index);
    if (!witness) continue;
    visibility.visible[cell] = visibility.explored[cell] = 1;
    if (witness.group) { witness.group.explorationMask ??= new Uint8Array(CELL_COUNT); witness.group.explorationMask[cell] = 1; }
    else visibility.commandExplored[cell] = 1;
  }
}

function soldierViews(state, factionId = null, currentlySeen = null, actorIds = null) {
  const groups = new Map((state.groups || []).map(group => [group.id, group])), result = [];
  const now = state.time ?? state.tick;
  const physical = ['id', 'factionId', 'nativeFactionId', 'species', 'role', 'status', 'alive', 'x', 'z', 'prevX', 'prevZ', 'yaw', 'prevYaw', 'vx', 'vz', 'positioned', 'elevation', 'lastAttackTime', 'lastHitTime', 'diedTime'];
  for (const home of state.settlements || []) for (const soldier of home.soldierRoster || []) {
    if (soldier.status === 'demobilized' || soldier.status === 'dead' && now - (soldier.diedTime ?? -Infinity) > 20) continue;
    const group = soldier.groupId && groups.get(soldier.groupId), owner = group ? localGroupController(state, group) : settlementController(state, home);
    const owned = !factionId || owner === factionId;
    if (!owned && (!soldier.positioned || !currentlySeen(soldier))) continue;
    const copy = owned ? Object.fromEntries(Object.entries(soldier).filter(([key]) => !key.startsWith('_')))
      : Object.fromEntries(physical.filter(key => key in soldier).map(key => [key, soldier[key]]));
    Object.assign(copy, { kind: 'soldier', commandFactionId: owner, controllerId: owner,
      originId: owned || actorIds?.has(home.id) ? home.id : null,
      groupId: !soldier.groupId ? null : owned || actorIds?.has(soldier.groupId) ? soldier.groupId : null,
      knowledgeView: owned ? 'owned' : 'visible' });
    if (copy.stats) copy.stats = { ...copy.stats, cost: { ...copy.stats.cost } };
    if (copy.order) copy.order = { ...copy.order };
    result.push(copy);
  }
  return result;
}

export function lineOfSight(state, from, to, options = {}) {
  return finitePoint(from) && finitePoint(to) && navigationLineOfSight(state, from, to, options);
}

export function sightRadius(source) {
  if (Number.isFinite(source.sightRadius)) return clamp(source.sightRadius, 1, 48);
  if ('population' in source) return source.status === 'camp' ? 16 : Math.min(42, Math.max(30, (source.radius || 8) + 12));
  if (source.kind === 'tower' || source.kind === 'watchtower') return 26;
  return source.kind === 'scout' ? 18 : source.kind === 'army' ? 15 : 11;
}

export function visibleToGroup(state, group, target, radius = sightRadius(group)) {
  if (!alive(group) || !finitePoint(target) || distance(group, target) > radius) return false;
  return lineOfSight(state, group, target, { maxRange: radius, fromHeight: group.kind === 'tower' ? 4.5 : 1.8, toHeight: 'population' in target ? 2 : 1.2, factionId: group.commandFactionId ? groupController(state, group) : group.factionId });
}

export function knowledgeCell(point) {
  if (!finitePoint(point)) return -1;
  const x = Math.floor((point.x - KNOWLEDGE_GRID.minX) / KNOWLEDGE_GRID.cellSize), z = Math.floor((point.z - KNOWLEDGE_GRID.minZ) / KNOWLEDGE_GRID.cellSize);
  return x < 0 || z < 0 || x >= KNOWLEDGE_GRID.width || z >= KNOWLEDGE_GRID.height ? -1 : z * KNOWLEDGE_GRID.width + x;
}

export function knowledgeCellPoint(index) {
  return { x: KNOWLEDGE_GRID.minX + (index % KNOWLEDGE_GRID.width + .5) * KNOWLEDGE_GRID.cellSize, z: KNOWLEDGE_GRID.minZ + (Math.floor(index / KNOWLEDGE_GRID.width) + .5) * KNOWLEDGE_GRID.cellSize };
}

function freshVisibility() {
  return { ...KNOWLEDGE_GRID, visible: new Uint8Array(CELL_COUNT), explored: new Uint8Array(CELL_COUNT), commandExplored: new Uint8Array(CELL_COUNT), visibleIds: {}, current: {}, visualMemory: {}, sources: [], version: 0, reportVersion: 0, updatedStep: -1, updatedTick: -1 };
}

export function initializeKnowledge(state, { reset = false } = {}) {
  for (const f of state.factions) {
    if (reset) { f.knowledge = {}; f.seenObjects = {}; }
    f.knowledge ??= {};
    f.seenObjects ??= {};
    if (reset || !f.visibility || f.visibility.visible?.length !== CELL_COUNT) f.visibility = freshVisibility();
  }
  if (reset) {
    state.pendingReports = [];
    for (const g of state.groups || []) { g.observations = []; delete g.explorationMask; delete g.lastTransmission; }
    state.knowledgeStep = -1;
    viewCache.delete(state); rasterCache.delete(state); sensorCache.delete(state); soldierVisionCache.delete(state);
  }
  return state;
}

function sourceRecord(object, kind = object.kind) {
  return { id: object.id, x: object.x, z: object.z, factionId: object.factionId, commandFactionId: object.commandFactionId, kind: kind || 'settlement', sightRadius: sightRadius(object), size: object.size, population: object.population, status: object.status };
}

export function localGroupController(state, group) {
  if (group.commandFactionId) return groupController(state, group);
  const home = state.settlements.find(h => h.id === group.originId);
  if (!home || group.kind !== 'worker') return group.factionId;
  const controller = settlementController(state, home);
  if (controller === group.factionId) return controller;
  // Occupation does not reveal distant surviving native armies, scouts or crews.
  // A working party only becomes a locally inspected captive asset when actually
  // within the occupied settlement's sight and communicating distance.
  return visibleToGroup(state, { ...home, factionId: controller }, group, sightRadius(home)) ? controller : group.factionId;
}

function nativeGroupAccess(state, group, factionId) {
  return group.factionId === factionId && (!group.commandFactionId || groupController(state, group) === factionId);
}

function sourcesFor(state, factionId) {
  const sources = [];
  for (const home of state.settlements || []) {
    const controller = settlementController(state, home);
    if ((home.factionId !== factionId && controller !== factionId) || !alive(home) || (home.homePresent ?? home.population) <= 0) continue;
    const commandHome = controller === factionId ? home : null;
    sources.push({ source: { ...sourceRecord(home, 'settlement'), factionId }, home: commandHome });
    for (const b of home.buildings || []) if (['tower', 'watchtower'].includes(b.kind) && b.progress >= 1 && !b.destroyed && (b.hp ?? b.health ?? 1) > 0 &&
      (b.crewSoldierIds || []).filter(id => { const soldier = getSoldier(state, id); return isServingSoldier(soldier) && !soldier.groupId && !soldier.withdrawing && soldier.positioned && distance(soldier, b) <= 1.6; }).length >= (b.requiredCrew || 2)) {
      sources.push({ source: { id: b.id, factionId, kind: 'tower', x: b.x, z: b.z, size: 1, sightRadius: 26 }, home: commandHome });
    }
  }
  for (const g of state.groups || []) {
    if (!alive(g)) continue;
    const controller = localGroupController(state, g);
    if (!nativeGroupAccess(state, g, factionId) && controller !== factionId) continue;
    let source = { ...sourceRecord(g), factionId };
    if (g.kind === 'army' && Array.isArray(g.soldierIds)) {
      // A route anchor ahead of its marching troops is not a physical observer.
      const soldiers = soldierVision(state).byFaction.get(controller)?.observers.filter(sensor => sensor.group?.id === g.id) || [];
      const witness = soldiers.reduce((best, sensor) => !best || distance(sensor.source, g) < distance(best.source, g) ? sensor : best, null);
      if (!witness) continue;
      source = { ...source, x: witness.source.x, z: witness.source.z };
    }
    sources.push({ source, group: controller === factionId ? g : null });
  }
  return sources;
}

function rasterSight(state, source, target, explored, command, personal, obstructionKey) {
  let cache = rasterCache.get(state); if (!cache) { cache = new Map(); rasterCache.set(state, cache); }
  const signature = `${state.seed}:${source.x}:${source.z}:${source.sightRadius}:${source.kind}:${source.factionId}:${obstructionKey}`;
  const cacheKey = `${source.factionId}:${source.id}`;
  let cached = cache.get(cacheKey);
  if (cached?.signature !== signature) {
    const cells = [], { width, height, minX, minZ, cellSize } = KNOWLEDGE_GRID, radius = source.sightRadius;
    const left = Math.max(0, Math.floor((source.x - radius - minX) / cellSize)), right = Math.min(width - 1, Math.floor((source.x + radius - minX) / cellSize));
    const top = Math.max(0, Math.floor((source.z - radius - minZ) / cellSize)), bottom = Math.min(height - 1, Math.floor((source.z + radius - minZ) / cellSize));
    for (let z = top; z <= bottom; z++) for (let x = left; x <= right; x++) {
      const index = z * width + x;
      if (visibleToGroup(state, source, knowledgeCellPoint(index), radius)) cells.push(index);
    }
    const local = knowledgeCell(source); if (local >= 0 && !cells.includes(local)) cells.push(local);
    cached = { signature, cells }; cache.set(cacheKey, cached);
    if (cache.size > 1024) cache.delete(cache.keys().next().value);
  }
  for (const index of cached.cells) { target[index] = explored[index] = 1; if (command) command[index] = 1; if (personal) personal[index] = 1; }
}

function obstructionKey(state) {
  const walls = [];
  const add = (b, ownerId) => {
    if (!['wall', 'gate'].includes(b.kind) || (b.progress ?? 1) < 1 || b.destroyed || (b.hp ?? b.health ?? 1) <= 0) return;
    const a = b.from || b.a, z = b.to || b.b;
    walls.push(`${b.id}:${b.factionId ?? ownerId}:${b.x}:${b.z}:${b.rotation}:${b.length}:${b.width}:${b.wallHeight ?? b.height}:${b.gateWidth}:${!!b.isGate}:${b.open || b.gateOpen || false}:${a?.x}:${a?.z}:${z?.x}:${z?.z}`);
  };
  for (const home of state.settlements || []) for (const b of home.buildings || []) add(b, home.factionId);
  for (const b of state.walls || []) add(b, b.factionId);
  return `${state.navigationRevision || 0}|${walls.join(',')}`;
}

function sourceSightCache(state, source, blockers) {
  let cache = sensorCache.get(state); if (!cache) { cache = new Map(); sensorCache.set(state, cache); }
  const cacheKey = `${source.factionId}:${source.id}`;
  let record = cache.get(cacheKey);
  if (!record || record.x !== source.x || record.z !== source.z || record.radius !== source.sightRadius || record.kind !== source.kind || record.factionId !== source.factionId || record.blockers !== blockers || record.seed !== (state.terrainSeed || state.seed)) {
    record = { x: source.x, z: source.z, radius: source.sightRadius, kind: source.kind, factionId: source.factionId, blockers, seed: state.terrainSeed || state.seed, targets: new Map() }; cache.set(cacheKey, record);
    if (cache.size > 1024) cache.delete(cache.keys().next().value);
  }
  return record;
}
function cachedSourceSight(state, source, object, cache) {
  let record = cache.targets.get(object.id);
  const settlement = 'population' in object;
  if (!record || record.x !== object.x || record.z !== object.z || record.settlement !== settlement) {
    record = { x: object.x, z: object.z, settlement, visible: visibleToGroup(state, source, object) }; cache.targets.set(object.id, record);
    if (cache.targets.size > 256) cache.targets.delete(cache.targets.keys().next().value);
  }
  return record.visible;
}

function objectBuckets(state) {
  const buckets = new Map(), span = 20;
  for (const object of [...(state.settlements || []), ...(state.nodes || []), ...(state.groups || []), ...(state.terrain?.passes || state.passes || [])]) {
    if (!finitePoint(object) || object.finished || ('size' in object && object.size <= 0)) continue;
    const key = `${Math.floor(object.x / span)}:${Math.floor(object.z / span)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(object);
  }
  return { buckets, span };
}

function nearbyObjects(index, source) {
  const objects = [], { span, buckets } = index, r = source.sightRadius;
  for (let z = Math.floor((source.z - r) / span); z <= Math.floor((source.z + r) / span); z++) for (let x = Math.floor((source.x - r) / span); x <= Math.floor((source.x + r) / span); x++) {
    objects.push(...(buckets.get(`${x}:${z}`) || []));
  }
  return objects;
}

// Measurement error is stable within a cycle and never consumes the simulation's
// random stream. Seeing or switching an observer view cannot change future life.
export function observationFor(state, faction, object, { sources = null } = {}) {
  const f = getFaction(state, faction), ownerId = 'population' in object ? settlementController(state, object) : object.claimedBy ? factionController(state, object.claimedBy) : object.commandFactionId ? groupController(state, object) : object.factionId || null;
  const nativeOwn = !!f && object.factionId === f.id, own = nativeOwn && (!object.commandFactionId || ownerId === f.id) || (!!f && ownerId === f.id);
  const kind = 'population' in object ? 'settlement' : 'size' in object ? 'group' : ['ford', 'mountain-pass'].includes(object.kind) || object.terrainKind === 'pass' ? 'terrain' : 'resource';
  const visibleMilitary = !own && (kind === 'settlement' || object.kind === 'army') ? visibleSoldiersAt(state, f, object, sources).length : null;
  const error = own || kind === 'resource' ? 1 : .84 + (hashSeed(`${state.seed}:${f?.id}:${object.id}:${state.tick}`) % 3201) / 10000;
  const o = { id: object.id, kind, x: object.x, z: object.z, ownerId, nativeOwnerId: object.factionId || null, observedTick: state.tick, observedTime: state.time ?? state.tick, reportedTick: null, confidence: own ? 1 : kind === 'resource' ? .98 : .88 };
  if (kind === 'terrain') Object.assign(o, { terrainKind: 'pass', passKind: object.kind, name: object.name || (object.kind === 'ford' ? 'Surveyed ford' : 'Surveyed mountain pass'), width: object.width, axis: object.axis, confidence: 1 });
  else if (kind === 'resource') Object.assign(o, { resourceKind: object.kind, subtype: object.subtype, balancedDistrict: object.balancedDistrict ?? null, foundingSite: object.foundingSite ? { ...object.foundingSite } : null, amountEstimate: Math.round(object.amount), abundanceEstimate: Math.round(object.amount), richnessEstimate: object.richness, regenerationEstimate: object.regeneration || 0, claimedBy: ownerId, claimSettlementId: object.claimSettlementId || null, radius: object.radius || 2.5 });
  else if (kind === 'settlement') Object.assign(o, { name: object.name, populationEstimate: Math.max(0, Math.round((nativeOwn ? object.population : visibleMilitary != null ? presentCensus(state, object).workers + visibleMilitary : presentCensus(state, object).population) * error)), soldiersEstimate: Math.max(0, Math.round((nativeOwn ? object.soldiers : visibleMilitary ?? presentCensus(state, object).soldiers) * error)), healthEstimate: Math.round(clamp(object.health * error, 0, 100)), status: object.status || 'active', occupiedBy: object.occupiedBy || null, controllerId: ownerId, radius: object.radius || 8, ownerSpecies: state.factions.find(a => a.id === ownerId)?.species, nativeSpecies: state.factions.find(a => a.id === object.factionId)?.species });
  else Object.assign(o, { groupKind: object.kind, unitType: object.unitType, sizeEstimate: Math.max(0, Math.round((visibleMilitary ?? object.size) * error)), phase: object.phase });
  return o;
}

// Body accounting is read at the render pulse, not from the whole-cycle job
// assignment cache. Deaths reduce both the home ledger and the affected party;
// finishing a return removes its departure without creating another person.
function presentCensus(state, home) {
  let away = 0, armyAway = 0;
  const deployed = { infantry: 0, ranged: 0 };
  for (const group of state.groups || []) {
    if (group.originId !== home.id || group.finished || !(group.size > 0)) continue;
    away += group.size;
    if (group.kind !== 'army') continue;
    armyAway += group.size;
    deployed.infantry += group.units?.infantry ?? group.size;
    deployed.ranged += group.units?.ranged || 0;
  }
  const population = Math.max(0, home.population - away);
  const military = home.military ? { infantry: Math.max(0, (home.military.infantry || 0) - deployed.infantry), ranged: Math.max(0, (home.military.ranged || 0) - deployed.ranged) } : undefined;
  const soldiers = Math.min(population, military ? military.infantry + military.ranged : Math.max(0, (home.soldiers || 0) - armyAway));
  return { population, soldiers, workers: Math.max(0, population - soldiers), military };
}

// Normally the simulation pulse invalidates a view. This small group-based key
// also catches a physical casualty/return or a paused QA mutation at that same
// pulse. It never observes per-person data or changes faction intelligence.
function censusRevision(state) {
  const homes = (state.settlements || []).map(home => {
    const queues = (home.trainingQueue || []).map(job => `${job.id}:${job.commandFactionId}:${job.progress}:${job.remaining}`).join(',');
    return `${home.id}:${home.population}:${home.soldiers}:${home.military?.infantry}:${home.military?.ranged}:${home.occupiedBy}:${home.exileBaseFor}:${queues}`;
  }).join('|');
  const parties = (state.groups || []).map(g => `${g.id}:${g.originId}:${g.commandFactionId}:${g.kind}:${g.finished ? 1 : 0}:${g.size}:${g.units?.infantry}:${g.units?.ranged}`).join('|');
  return homes + ';' + parties;
}

function visibleSoldiersAt(state, faction, entity, sources = null) {
  const f = getFaction(state, faction);
  if (!f) return [];
  if (commandOwned(state, f.id, entity)) return getSoldiers(state, entity);
  const base = sources || sourcesFor(state, f.id).map(entry => entry.source), index = soldierVision(state);
  return getSoldiers(state, entity).filter(body => body.positioned && (base.some(source => visibleToGroup(state, source, body)) || (!sources && soldierWitness(state, f.id, body, index))));
}

function visualSnapshot(state, f, object, observation, sources = null) {
  if (observation.kind === 'terrain') return { ...observation, renderKind: 'terrain', knowledgeView: 'visible' };
  const combat = object.combat ? { active: object.combat.active, x: object.combat.x, z: object.combat.z, yaw: object.combat.yaw, lastHitTime: object.combat.lastHitTime, prevX: object.combat.prevX, prevZ: object.combat.prevZ } : undefined;
  if (observation.kind === 'resource') return { ...observation, kind: object.kind, resourceKind: object.kind, amount: object.amount, maxAmount: object.maxAmount, richness: object.richness, regeneration: object.regeneration, displayRadius: object.displayRadius, renderKind: 'resource', knowledgeView: 'visible' };
  const visibleMilitary = observation.kind === 'settlement' || object.kind === 'army' ? visibleSoldiersAt(state, f, object) : null;
  const visualCount = visibleMilitary ? visibleMilitary.length : object.size;
  if (observation.kind === 'group') return { ...observation, factionId: object.factionId, commandFactionId: object.commandFactionId, controllerId: localGroupController(state, object), kind: object.kind, size: visualCount, initialSize: visualCount, x: object.x, z: object.z, prevX: object.prevX ?? object.x, prevZ: object.prevZ ?? object.z, unitType: object.unitType, combat, units: visibleMilitary ? soldierCounts(visibleMilitary) : object.units ? clone(object.units) : undefined, phase: object.phase, activity: object.activity, heading: object.heading, formation: object.formation, renderKind: 'group', knowledgeView: 'visible', originId: null, targetId: null, targetX: object.x, targetZ: object.z, carrying: emptyStock() };
  const local = presentCensus(state, object);
  if (visibleMilitary) { local.soldiers = visibleMilitary.length; local.military = soldierCounts(visibleMilitary); local.population = local.workers + local.soldiers; }
  // Actual present individuals may be drawn in line of sight, but a visible town
  // does not disclose away crews, hidden stores, jobs, queues or global census.
  return { ...observation, factionId: object.factionId, lastFactionId: object.lastFactionId, occupiedBy: object.occupiedBy || null, controllerId: settlementController(state, object), combat, military: local.military, population: local.population, soldiers: local.soldiers, workers: local.workers, homePresent: local.population, health: object.health, radius: object.radius, level: object.level, buildings: (object.buildings || []).filter(b => sources ? sources.some(source => visibleToGroup(state, source, b)) || !!soldierWitness(state, f.id, b) : isVisible(state, f.id, b)).map(b => ({ id: b.id, kind: b.kind, x: b.x, z: b.z, rotation: b.rotation, progress: b.progress, health: b.health, hp: b.hp, maxHp: b.maxHp, destroyed: b.destroyed, width: b.width, isGate: b.isGate, gateWidth: b.gateWidth, operational: b.operational, crewAssigned: b.crewAssigned, wallEnd: clone(b.wallEnd), wallStart: clone(b.wallStart), from: clone(b.from), to: clone(b.to), length: b.length, open: b.open, gateOpen: b.gateOpen, topologyId: b.topologyId, topologySlot: b.topologySlot, joins: clone(b.joins) })), roads: [], worksites: [], assigned: {}, stock: emptyStock(), construction: null, renderKind: 'settlement', knowledgeView: 'visible' };
}

function rememberObservation(group, observation) {
  group.observations ??= [];
  let cache = observationIndexes.get(group);
  if (!cache || cache.array !== group.observations || cache.length !== group.observations.length) {
    cache = { array: group.observations, length: group.observations.length, indexes: new Map(group.observations.map((o, index) => [o.id, index])) }; observationIndexes.set(group, cache);
  }
  const index = cache.indexes.get(observation.id);
  if (index == null) { cache.indexes.set(observation.id, group.observations.length); group.observations.push({ ...observation }); cache.length++; }
  else if ((group.observations[index].observedTime ?? group.observations[index].observedTick) <= (observation.observedTime ?? observation.observedTick)) group.observations[index] = { ...observation };
}

export function reportObservations(state, faction, observations = [], { method = 'return', group = null, explorationMask = group?.explorationMask, homeId = null } = {}) {
  const f = getFaction(state, faction);
  if (!f) return { fresh: 0, settlements: 0, oldest: state.tick };
  if (!f.visibility || !f.knowledge) initializeKnowledge(state);
  const origin = group && state.settlements.find(home => home.id === group.originId);
  const receiver = homeId || (origin && settlementController(state, origin) === f.id ? origin.id : null) || (method === 'relay' ? state.settlements.find(home => alive(home) && settlementController(state, home) === f.id)?.id : null);
  let fresh = 0, settlements = 0, oldest = state.tick;
  for (const o of observations) {
    if (!o || !Number.isFinite(o.observedTick) || o.observedTick > state.tick || (Number.isFinite(o.observedTime) && o.observedTime > (state.time ?? state.tick))) continue;
    const previous = f.knowledge[o.id];
    if (previous && (previous.observedTime ?? previous.observedTick) >= (o.observedTime ?? o.observedTick)) continue;
    const age = Math.max(0, state.tick - o.observedTick);
    f.knowledge[o.id] = { ...o, reportedTick: state.tick, reportedTime: state.time ?? state.tick, reportMethod: method, reportedAtSettlementId: receiver, confidence: clamp((o.confidence ?? .8) - age * .0025, .12, 1) };
    fresh++; if (o.kind === 'settlement') settlements++; oldest = Math.min(oldest, o.observedTick);
    if (o.kind !== 'group') f.visibility.visualMemory[o.id] = { ...o };
    const cell = knowledgeCell(o); if (cell >= 0) f.visibility.commandExplored[cell] = f.visibility.explored[cell] = 1;
  }
  if (explorationMask?.length === CELL_COUNT) for (let i = 0; i < CELL_COUNT; i++) if (explorationMask[i]) f.visibility.commandExplored[i] = f.visibility.explored[i] = 1;
  if (fresh || explorationMask?.length === CELL_COUNT) { f.visibility.reportVersion = (f.visibility.reportVersion || 0) + 1; viewCache.get(state)?.delete(f.id); }
  return { fresh, settlements, oldest };
}

export function observeGroup(state, group) {
  if (!alive(group)) return [];
  const f = getFaction(state, localGroupController(state, group)); if (!f) return [];
  initializeKnowledge(state);
  const sources = group.kind === 'army' && Array.isArray(group.soldierIds)
    ? (soldierVision(state).byFaction.get(f.id)?.observers || []).filter(sensor => sensor.group?.id === group.id).map(sensor => sensor.source)
    : [sourceRecord(group)];
  const result = [], seen = new Set(), index = objectBuckets(state);
  for (const source of sources) for (const object of nearbyObjects(index, source)) {
    if (seen.has(object.id) || object.id === group.id || commandOwned(state, f.id, object) || !visibleToGroup(state, source, object)) continue;
    seen.add(object.id);
    const o = observationFor(state, f, object, { sources }); rememberObservation(group, o); result.push(o);
  }
  return result;
}

export function stepKnowledge(state, { force = false } = {}) {
  initializeKnowledge(state);
  const step = state.step ?? state.tick * 10;
  if (!force && (state.knowledgeStep === step || step % KNOWLEDGE_GRID.updatePulses !== 0)) return false;
  const index = objectBuckets(state), blockers = obstructionKey(state), bodySight = soldierVision(state);
  for (const f of state.factions) {
    const v = f.visibility, sources = sourcesFor(state, f.id), readings = new Map();
    const receivers = new Map(), receiverKey = entry => entry.group?.id || entry.home?.id || `observer:${entry.source.id}`;
    for (const entry of [...sources, ...(bodySight.byFaction.get(f.id)?.observers || [])]) {
      const key = receiverKey(entry);
      if (!receivers.has(key)) receivers.set(key, []);
      receivers.get(key).push(entry.source);
    }
    const readFor = (object, entry) => {
      const recipient = receiverKey(entry), key = `${recipient}|${object.id}`;
      if (!readings.has(key)) readings.set(key, observationFor(state, f, object, { sources: receivers.get(recipient) }));
      return readings.get(key);
    };
    const factionBlockers = `${blockers}|${Object.entries(f.relations || {}).map(([id, r]) => `${id}:${r.status}`).join(',')}`;
    v.visible.fill(0); v.visibleIds = {}; v.current = {}; v.sources = sources.map(s => s.source);
    for (const { source, home, group } of sources) {
      if (group) group.explorationMask ??= new Uint8Array(CELL_COUNT);
      rasterSight(state, source, v.visible, v.explored, home || group?.kind === 'scout' ? v.commandExplored : null, group?.explorationMask, factionBlockers);
      const sightCache = sourceSightCache(state, source, factionBlockers);
      for (const object of nearbyObjects(index, source)) {
        if (commandOwned(state, f.id, object)) { v.visibleIds[object.id] = true; continue; }
        if (!cachedSourceSight(state, source, object, sightCache)) continue;
        v.visibleIds[object.id] = true;
        const o = readFor(object, { source, home, group });
        if (!v.current[object.id]) v.current[object.id] = { observation: o, object };
        if (o.kind !== 'group') v.visualMemory[object.id] = { ...o };
        if (group) rememberObservation(group, o);
        if (home) reportObservations(state, f, [o], { method: 'home-sight', homeId: home.id });
        else if (group?.kind === 'scout') reportObservations(state, f, [o], { method: 'scout-sight', group, explorationMask: null });
      }
    }
    extendSoldierSight(state, f, v, bodySight);
    // Each command recipient records only what its actual soldiers saw. Deduped
    // local bucket queries avoid rescanning the entire world for each body.
    const witnessed = new Map();
    for (const { source, home, group } of bodySight.byFaction.get(f.id)?.observers || []) {
      const recipient = group || home;
      if (!recipient) continue;
      if (!witnessed.has(recipient.id)) witnessed.set(recipient.id, new Set());
      const seen = witnessed.get(recipient.id);
      for (const object of nearbyObjects(index, source)) {
        if (seen.has(object.id)) continue;
        if (commandOwned(state, f.id, object)) { v.visibleIds[object.id] = true; seen.add(object.id); continue; }
        if (!visibleToGroup(state, source, object)) continue;
        seen.add(object.id); v.visibleIds[object.id] = true;
        const o = readFor(object, { source, home, group });
        if (!v.current[object.id]) v.current[object.id] = { observation: o, object };
        if (o.kind !== 'group') v.visualMemory[object.id] = { ...o };
        if (group) rememberObservation(group, o);
        else reportObservations(state, f, [o], { method: 'home-sight', homeId: home.id });
      }
    }
    // Replace every transient truth reference with an independent visual record.
    for (const entry of Object.values(v.current)) entry.object = visualSnapshot(state, f, entry.object, entry.observation);
    // Mobile sightings are not permanent place memory. Expire ancient reports
    // and cap their ledger so repeated caravan generations cannot grow it forever.
    const unitReports = Object.values(f.knowledge).filter(k => k.kind === 'group').sort((a, b) => b.observedTick - a.observedTick || a.id.localeCompare(b.id));
    for (let i = 0; i < unitReports.length; i++) if (i >= 256 || state.tick - unitReports[i].observedTick > 240) delete f.knowledge[unitReports[i].id];
    v.updatedStep = step; v.updatedTick = state.tick; v.version++;
  }
  state.knowledgeStep = step;
  return true;
}

export function isVisible(state, faction, pointOrObject) {
  const f = getFaction(state, faction);
  if (!f || !finitePoint(pointOrObject)) return false;
  if (alive(pointOrObject) && ('size' in pointOrObject ? nativeGroupAccess(state, pointOrObject, f.id) || localGroupController(state, pointOrObject) === f.id : pointOrObject.factionId === f.id)) return true;
  const sources = f.visibility?.sources || sourcesFor(state, f.id).map(s => s.source);
  return sources.some(source => visibleToGroup(state, source, pointOrObject)) || !!soldierWitness(state, f.id, pointOrObject);
}

// Planning uses only terrain actually surveyed by homes, live scouts or
// delivered field maps. Live scout sight never exposes cells outside its LOS.
export function isExplored(state, faction, point) {
  const f = getFaction(state, faction), cell = knowledgeCell(point);
  return cell >= 0 && !!f?.visibility?.commandExplored[cell];
}

export function knownReports(state, faction, { kind, maxAge = Infinity, minConfidence = 0, includeOwn = true } = {}) {
  const f = getFaction(state, faction);
  if (!f) return [];
  return Object.values(f.knowledge || {}).filter(k => (!kind || k.kind === kind) && (includeOwn || k.ownerId !== f.id) && k.reportedTick != null && k.reportedTick <= state.tick && k.observedTick <= state.tick && state.tick - k.observedTick <= maxAge && (k.confidence ?? 0) >= minConfidence);
}

export function knownResourceNodes(state, faction, options = {}) {
  return knownReports(state, faction, { ...options, kind: 'resource' }).map(k => ({ id: k.id, kind: k.resourceKind, subtype: k.subtype, claimedBy: k.claimedBy || k.ownerId || null, claimSettlementId: k.claimSettlementId || null, x: k.x, z: k.z, radius: k.radius ?? 2.5, amount: k.amountEstimate ?? k.abundanceEstimate ?? 0, richness: k.richnessEstimate ?? .5, regeneration: k.regenerationEstimate ?? 0, knowledge: k }));
}

function publicFaction(f, known = true) {
  return { id: f.id, name: known ? f.name : 'Uncontacted society', species: f.species, color: f.color, knowledgeView: 'reported', knowledge: {}, relations: {}, history: [], tech: { level: null, unlocked: [], breakthroughs: [] }, economy: { population: null, workers: null, soldiers: null, settlements: null, stock: emptyStock() }, traits: {}, status: 'unknown', intent: 'Its plans and stores are unknown.' };
}

function pointOfEffect(effect) { return finitePoint(effect) ? effect : finitePoint(effect.position) ? effect.position : null; }

export function factionView(state, factionId = null) {
  let cache = viewCache.get(state);
  if (!cache) { cache = new Map(); viewCache.set(state, cache); }
  if (!factionId || factionId === 'omniscient') {
    const signature = `${state.step ?? state.tick}:${state.soldierRevision || 0}:${censusRevision(state)}`;
    const prior = cache.get('omniscient');
    if (prior?.signature === signature) return prior.view;
    const view = { ...state, soldiers: soldierViews(state), renderWorldId: renderWorldId(state) };
    cache.set('omniscient', { signature, view }); return view;
  }
  const f = getFaction(state, factionId);
  if (!f) return { seed: state.seed, terrainSeed: state.terrainSeed, tick: state.tick, step: state.step, time: state.time, config: state.config, season: state.season, bounds: state.bounds, factions: [], settlements: [], groups: [], soldiers: [], nodes: [], knownPlaces: [], events: [], projectiles: [], combatEffects: [], stats: {}, tradeOffers: [], renderWorldId: renderWorldId(state), viewer: { mode: 'faction', factionId, invalid: true } };
  const v = f.visibility || freshVisibility();
  const signature = `${state.step ?? state.tick}:${state.soldierRevision || 0}:${v.version}:${v.reportVersion || 0}:${state.combatEvents?.length || 0}:${censusRevision(state)}`;
  const cached = cache.get(f.id);
  if (cached?.signature === signature) return cached.view;
  const settlements = [], groups = [], nodes = [], currentIds = new Set();
  const liveSources = sourcesFor(state, f.id).map(s => s.source);
  const bodySight = soldierVision(state);
  const currentlySeen = point => liveSources.some(source => visibleToGroup(state, source, point)) || !!soldierWitness(state, f.id, point, bodySight);
  const actors = new Map([...(state.settlements || []), ...(state.groups || [])].map(actor => [actor.id, actor]));
  for (const home of state.settlements || []) {
    const controllerId = settlementController(state, home);
    if (home.factionId === f.id) {
      // A native census includes citizens serving a foreign commander. Their
      // remote military party is not an intelligence source for the old polity,
      // and must not be drawn again as phantom residents at its native home.
      let commandedAway = 0, militaryAway = 0;
      const foreignRoles = { infantry: 0, ranged: 0 };
      for (const g of state.groups || []) if (g.originId === home.id && alive(g) && g.commandFactionId && groupController(state, g) !== f.id) {
        commandedAway += g.size;
        if (g.kind === 'army') { militaryAway += g.size; foreignRoles.infantry += g.units?.infantry ?? g.size; foreignRoles.ranged += g.units?.ranged || 0; }
      }
      const nativeView = { ...home, controllerId, trainingQueue: (home.trainingQueue || []).filter(job => (job.commandFactionId || home.factionId) === f.id).map(job => ({ ...job })), knowledgeControl: controllerId === f.id ? 'owned' : 'native-captive' };
      if (controllerId !== f.id) {
        nativeView.assigned = { ...home.assigned, training: nativeView.trainingQueue.reduce((sum, job) => sum + (job.size || 0), 0) };
        delete nativeView.militaryTarget; delete nativeView.trainingStatus; delete nativeView.lastTraining; delete nativeView.lastTrainingOrder; delete nativeView.lastTrainingCancelled; delete nativeView.lastTrainingEvent;
        if (home.exileBaseFor) nativeView.economyReasons = ['The native inhabitants remain here. Military courses and orders belong to the controlling civilisation.'];
      }
      if (commandedAway) {
        nativeView.population = Math.max(0, home.population - commandedAway);
        nativeView.soldiers = Math.max(0, home.soldiers - militaryAway);
        nativeView.workers = Math.max(0, nativeView.population - nativeView.soldiers);
        nativeView.homePresent = presentCensus(state, home).population;
        if (home.military) nativeView.military = { infantry: Math.max(0, home.military.infantry - foreignRoles.infantry), ranged: Math.max(0, home.military.ranged - foreignRoles.ranged) };
      }
      settlements.push(nativeView); currentIds.add(home.id);
    } else if (controllerId === f.id) {
      const local = visualSnapshot(state, f, home, observationFor(state, f, home), liveSources);
      settlements.push({ ...local, stock: { ...home.stock }, capacity: home.capacity, housingCapacity: home.housingCapacity, carryingCapacity: home.carryingCapacity, wellbeing: home.wellbeing, exileBaseFor: home.exileBaseFor === f.id ? f.id : null, trainingQueue: (home.trainingQueue || []).filter(job => job.commandFactionId === f.id).map(job => ({ ...job })), knowledgeControl: 'occupied' }); currentIds.add(home.id);
    }
  }
  const shownHomeIds = new Set(settlements.map(home => home.id));
  for (const g of state.groups || []) if (!g.finished) {
    const controllerId = localGroupController(state, g);
    if (nativeGroupAccess(state, g, f.id)) { groups.push({ ...g, controllerId, knowledgeControl: controllerId === f.id ? 'owned' : 'native-captive' }); currentIds.add(g.id); }
    else if (controllerId === f.id) { groups.push({ ...g, originId: null, observedHomeId: shownHomeIds.has(g.originId) ? g.originId : null, controllerId, knowledgeControl: 'occupied' }); currentIds.add(g.id); }
  }
  for (const [id, entry] of Object.entries(v.current)) {
    let record = entry.object;
    if (!v.visibleIds[id] || currentIds.has(id)) continue;
    // Already-sighted bodies are rendered at their current physical positions at
    // 10 Hz. This pure observer read neither discovers new targets nor publishes
    // field reports. A lost current contact disappears immediately; static masks
    // and remembered-place observations still update at the bounded sight cadence.
    if (record.renderKind === 'group' || record.renderKind === 'settlement') {
      const actor = actors.get(id);
      if (!actor || actor.finished || ('size' in actor && actor.size <= 0) || !currentlySeen(actor)) continue;
      record = visualSnapshot(state, f, actor, observationFor(state, f, actor), liveSources);
    }
    currentIds.add(id);
    if (record.renderKind === 'settlement') settlements.push(record);
    else if (record.renderKind === 'group') groups.push(record);
    else if (record.renderKind === 'resource') nodes.push(record);
  }
  const memories = { ...v.visualMemory };
  for (const report of knownReports(state, f)) if (report.kind !== 'group' && (!memories[report.id] || memories[report.id].observedTick < report.observedTick)) memories[report.id] = report;
  const knownPlaces = Object.values(memories).filter(k => !currentIds.has(k.id)).map(k => ({ ...clone(k), knowledgeView: 'remembered', age: Math.max(0, state.tick - k.observedTick) }));
  const soldiers = soldierViews(state, f.id, currentlySeen, currentIds);
  const soldierIds = new Set(soldiers.map(soldier => soldier.id));
  const knownIds = new Set([...currentIds, ...soldierIds]);
  // A copy may describe its own orders, but cannot identify a body that has
  // left sight. Never expose canonical ledgers or formation aliases to a view.
  const cleanReferences = value => {
    if (Array.isArray(value)) return value.map(cleanReferences);
    if (!value || typeof value !== 'object' || ArrayBuffer.isView(value)) return value;
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (['soldierRoster', 'soldierIds', 'formationSlots', 'crewSoldierIds'].includes(key) || key.startsWith('_')) continue;
      if ((key.endsWith('SoldierId') || ['soldierId', 'targetId', 'sourceId', 'ignoredTargetId', 'ignoredWorkerId', 'ignoredScoutId', 'lastAttackerId', 'killedById'].includes(key)) && typeof item === 'string') result[key] = knownIds.has(item) ? item : null;
      else result[key] = cleanReferences(item);
    }
    return result;
  };
  for (let i = 0; i < soldiers.length; i++) soldiers[i] = cleanReferences(soldiers[i]);
  for (const collection of [settlements, groups]) for (let i = 0; i < collection.length; i++) collection[i] = cleanReferences(collection[i]);
  for (const group of groups) if (group.kind === 'army' && group.knowledgeView === 'visible') {
    const visible = soldiers.filter(soldier => soldier.groupId === group.id && soldier.alive && soldier.status === 'serving');
    group.units = { infantry: visible.filter(soldier => soldier.role === 'infantry').length, ranged: visible.filter(soldier => soldier.role === 'ranged').length };
    group.size = group.initialSize = visible.length;
  }
  const identities = new Set([f.id]);

  for (const record of [...settlements, ...groups, ...nodes, ...knownPlaces, ...soldiers]) { if (record.factionId || record.ownerId) identities.add(record.factionId || record.ownerId); if (record.controllerId) identities.add(record.controllerId); if (record.nativeOwnerId) identities.add(record.nativeOwnerId); }
  for (const k of knownReports(state, f)) if (k.ownerId) identities.add(k.ownerId);
  const filterEffects = effects => (effects || []).filter(effect => { const point = pointOfEffect(effect); return point && currentlySeen(point); }).map(cleanReferences);
  const nativeHomeIds = new Set((state.settlements || []).filter(home => home.factionId === f.id).map(home => home.id));
  const visibleCells = v.visible.reduce((a, b) => a + b, 0), exploredCells = v.explored.reduce((a, b) => a + b, 0);
  const combatEvents = [];
  for (const event of state.combatEvents || []) {
    if ((event.expiresAt ?? Infinity) < (state.time ?? state.tick)) continue;
    const safe = { ...event };
    if (event.shots) {
      const t = clamp(((state.time ?? state.tick) - event.time) / Math.max(.001, event.impactTime - event.time), 0, 1);
      safe.shots = event.shots.filter(shot => currentlySeen({ x: shot.from.x + (shot.to.x - shot.from.x) * t, z: shot.from.z + (shot.to.z - shot.from.z) * t }));
      safe.count = safe.shots.length;
      if (!safe.shots.length) continue;
    } else if (event.positions) {
      safe.positions = event.positions.filter(point => currentlySeen(point));
      safe.count = safe.positions.length;
      if (!safe.count) continue;
    } else {
      const point = pointOfEffect(event);
      if (!point || !currentlySeen(point)) continue;
    }
    if (!currentIds.has(safe.sourceId)) safe.sourceId = null;
    if (!currentIds.has(safe.targetId)) safe.targetId = null;
    combatEvents.push(cleanReferences(safe));
  }
  const view = {
    seed: state.seed, terrainSeed: state.terrainSeed, tick: state.tick, step: state.step, time: state.time, config: state.config, bounds: state.bounds, season: state.season, outcome: state.outcome,
    factions: state.factions.filter(a => identities.has(a.id)).map(a => a.id === f.id ? a : publicFaction(a)), settlements, groups, soldiers, nodes, knownPlaces,
    visibleNodeIds: nodes.map(n => n.id), combatEvents, projectiles: filterEffects(state.projectiles), combatEffects: filterEffects(state.combatEffects),
    events: (state.events || []).filter(e => e.factionId === f.id || e.defeatedId === f.id || e.type === 'victory' || (e.type === 'capture' && (e.previousControllerId === f.id || nativeHomeIds.has(e.settlementId))) || (e.otherFactionId === f.id && !e.pending && ['trade', 'diplomacy'].includes(e.type))),
    tradeOffers: (state.tradeOffers || []).filter(o => o.factionId === f.id), stats: {}, terrain: { seed: state.terrainSeed || state.seed, biome: state.terrain?.biome }, renderWorldId: renderWorldId(state),
    viewer: { mode: 'faction', factionId, visibleCells, exploredCells, totalCells: CELL_COUNT, reportCount: knownReports(state, f).length, staleCount: knownPlaces.length, version: v.version, updatedTick: v.updatedTick },
  };
  cache.set(f.id, { signature, view });
  return view;
}
