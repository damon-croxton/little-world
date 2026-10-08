import { relationStatus, freeForAll } from './diplomacy.js';
import { WORLD_RADIUS, heightAt, terrainAt, terrainFeatures, isTerrainTraversable } from '../world.js';
import { factionController, settlementController, groupController } from './control.js';

// Physical, deterministic routing. Routes never look at resource amounts, enemy
// census, or faction intelligence. Callers choose goals from their own reports.
export const NAV_CELL_SIZE = 3;
export const NAV_MAX_EXPANSIONS = 12000;
const GRID_SIDE = Math.floor(WORLD_RADIUS * 2 / NAV_CELL_SIZE) + 1;
const GRID_COUNT = GRID_SIDE * GRID_SIDE;
const SIGHT_SIDE = WORLD_RADIUS * 4 + 1, SIGHT_OFFSET = WORLD_RADIUS * 2;
const SAMPLE_SPACING = .85;
const staticCache = new Map();
const footprintCaches = new Map();
const stateCache = new WeakMap();
const directions = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]];
const footprintDirections = [[1, 0], [-1, 0], [0, 1], [0, -1], [.70710678, .70710678], [-.70710678, .70710678], [.70710678, -.70710678], [-.70710678, -.70710678]];
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const mix = (a, b, t) => a + (b - a) * t;
const finitePoint = p => p && Number.isFinite(p.x) && Number.isFinite(p.z);
const pointKey = p => `${p.x.toFixed(2)},${p.z.toFixed(2)}`;

function cellPoint(index) {
  return { x: (index % GRID_SIDE) * NAV_CELL_SIZE - WORLD_RADIUS, z: Math.floor(index / GRID_SIDE) * NAV_CELL_SIZE - WORLD_RADIUS };
}
function cellAt(point) {
  const ix = clamp(Math.round((point.x + WORLD_RADIUS) / NAV_CELL_SIZE), 0, GRID_SIDE - 1);
  const iz = clamp(Math.round((point.z + WORLD_RADIUS) / NAV_CELL_SIZE), 0, GRID_SIDE - 1);
  return iz * GRID_SIDE + ix;
}
function staticNavigation(seed) {
  const key = String(seed ?? 'littleworld');
  let nav = staticCache.get(key);
  if (nav) return nav;
  const walkable = new Uint8Array(GRID_COUNT), movement = new Float32Array(GRID_COUNT), heights = new Float32Array(GRID_COUNT);
  for (let i = 0; i < GRID_COUNT; i++) {
    const p = cellPoint(i), ground = terrainAt(p.x, p.z, key);
    walkable[i] = ground.traversable ? 1 : 0; movement[i] = ground.movement; heights[i] = ground.height;
  }
  // Edge validity is memoized lazily. A* never clips a diagonal across a cliff
  // corner, and short physical samples catch river banks between cell centers.
  nav = { seed: key, walkable, movement, heights, edges: new Int8Array(GRID_COUNT * 8), heightCache: new Float64Array(SIGHT_SIDE * SIGHT_SIDE), heightKnown: new Uint8Array(SIGHT_SIDE * SIGHT_SIDE), paths: new Map(), features: terrainFeatures(key) };
  staticCache.set(key, nav);
  if (staticCache.size > 8) staticCache.delete(staticCache.keys().next().value);
  return nav;
}
function localState(state) {
  let value = stateCache.get(state);
  if (!value || value.seed !== (state.terrainSeed || state.seed)) {
    value = { seed: (state.terrainSeed || state.seed), wallStamp: null, walls: [], wallBins: new Map(), version: 0, paths: new Map(), searches: 0, cacheHits: 0 };
    stateCache.set(state, value);
  }
  return value;
}

function pointSegmentDistance(p, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z, d2 = dx * dx + dz * dz;
  const t = d2 ? clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / d2, 0, 1) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.z - a.z - t * dz);
}
function segmentsDistance(a, b, c, d) {
  const cross = (p, q, r) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  const ca = cross(a, b, c), da = cross(a, b, d), ac = cross(c, d, a), bc = cross(c, d, b);
  if (ca * da <= 0 && ac * bc <= 0 && Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) <= Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) + 1e-9 && Math.max(Math.min(a.z, b.z), Math.min(c.z, d.z)) <= Math.min(Math.max(a.z, b.z), Math.max(c.z, d.z)) + 1e-9) return 0;
  return Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d), pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b));
}
function wallAlive(wall) {
  return (wall.record.progress ?? 1) >= 1 && (wall.record.hp ?? wall.record.health ?? 1) > 0 && !wall.record.destroyed;
}
// Endpoints are authoritative for joined defenses; legacy center/yaw records
// retain the same Three.js local +X -> world -Z orientation convention.
export function wallGeometry(record) {
  const nominalLength = Math.max(.1, record.length ?? 7), angle = record.rotation ?? 0;
  const from = record.from ?? record.wallStart ?? record.a ?? { x: record.x - Math.cos(angle) * nominalLength * .5, z: record.z + Math.sin(angle) * nominalLength * .5 };
  const to = record.to ?? record.wallEnd ?? record.b ?? { x: record.x + Math.cos(angle) * nominalLength * .5, z: record.z - Math.sin(angle) * nominalLength * .5 };
  if (!finitePoint(from) || !finitePoint(to)) return null;
  return { from, to, x: (from.x + to.x) * .5, z: (from.z + to.z) * .5, length: distance(from, to), rotation: -Math.atan2(to.z - from.z, to.x - from.x), width: record.width ?? 1 };
}
function refreshWalls(state) {
  const value = localState(state);
  const stamp = `${state.step ?? state.tick ?? 0}:${state.navigationRevision ?? 0}:${freeForAll(state)}`;
  if (value.wallStamp === stamp && value.settlements === state.settlements && value.looseWalls === state.walls) return value;
  value.wallStamp = stamp; value.settlements = state.settlements; value.looseWalls = state.walls;
  const walls = [];
  const add = (record, ownerId) => {
    if (!['wall', 'gate'].includes(record.kind) || (record.progress ?? 1) < 1 || (record.hp ?? record.health ?? 1) <= 0 || record.destroyed) return;
    const geometry = wallGeometry(record);
    if (!geometry) return;
    walls.push({ id: record.id, record, ownerId: ownerId ?? record.factionId, ...geometry, height: record.wallHeight ?? record.height ?? 3 });
  };
  for (const home of state.settlements ?? []) for (const record of home.buildings ?? []) add(record, state.factions ? settlementController(state, home) : home.occupiedBy || home.factionId);
  for (const record of state.walls ?? []) add(record, state.factions ? factionController(state, record.factionId) : record.factionId);
  const permissions = (state.factions ?? []).map(f => `${f.id}>${f.defeatedBy ?? ''}:${Object.entries(f.relations ?? {}).filter(([, relation]) => relation.status === 'allied').map(([id]) => id).sort().join(',')}`).join(';');
  const signature = `${state.navigationRevision ?? 0}:${freeForAll(state)}:${permissions}:` + walls.map(w => `${w.id}:${w.ownerId}:${pointKey(w.from)}:${pointKey(w.to)}:${w.width}:${w.record.kind}:${w.record.gateWidth ?? 5}:${!!(w.record.open || w.record.gateOpen)}:${!!w.record.isGate}`).join('|');
  value.walls = walls;
  if (signature !== value.wallSignature) {
    value.wallSignature = signature; value.version++; value.paths.clear();
    value.wallBins.clear();
    for (const wall of walls) {
      const pad = wall.width * .5 + 1;
      for (let x = Math.floor((Math.min(wall.from.x, wall.to.x) - pad) / 12); x <= Math.floor((Math.max(wall.from.x, wall.to.x) + pad) / 12); x++) for (let z = Math.floor((Math.min(wall.from.z, wall.to.z) - pad) / 12); z <= Math.floor((Math.max(wall.from.z, wall.to.z) + pad) / 12); z++) {
        const key = `${x},${z}`;
        if (!value.wallBins.has(key)) value.wallBins.set(key, []);
        value.wallBins.get(key).push(wall);
      }
    }
  } else {
    // Keep references current when callers replace otherwise identical records.
    const map = new Map(walls.map(w => [w.id, w]));
    for (const list of value.wallBins.values()) for (let i = 0; i < list.length; i++) list[i] = map.get(list[i].id) ?? list[i];
  }
  return value;
}
export function invalidateNavigation(state) {
  state.navigationRevision = (state.navigationRevision ?? 0) + 1;
}
function friendlyGate(state, wall, factionId) {
  const b = wall.record;
  if (!(b.isGate || b.kind === 'gate')) return false;
  if (b.open || b.gateOpen) return true;
  if (!factionId) return false;
  factionId = state.factions ? factionController(state, factionId) : factionId;
  if (wall.ownerId === factionId) return true;
  const f = state.factions?.find(f => f.id === factionId);
  return relationStatus(state, f, wall.ownerId) === 'allied';
}
function wallParts(state, wall, factionId) {
  if (!friendlyGate(state, wall, factionId)) return [[wall.from, wall.to]];
  const span = distance(wall.from, wall.to), gap = Math.min(span, wall.record.gateWidth ?? 5), halfGap = gap / Math.max(.001, span) * .5;
  return [[wall.from, { x: mix(wall.from.x, wall.to.x, .5 - halfGap), z: mix(wall.from.z, wall.to.z, .5 - halfGap) }], [{ x: mix(wall.from.x, wall.to.x, .5 + halfGap), z: mix(wall.from.z, wall.to.z, .5 + halfGap) }, wall.to]].filter(([a, b]) => distance(a, b) > .001);
}
export function blockingWallParts(state, record, ownerId, factionId) {
  const geometry = wallGeometry(record);
  return geometry ? wallParts(state, { record, ownerId, ...geometry }, factionId) : [];
}
function candidateWalls(state, from, to) {
  const nav = refreshWalls(state), walls = new Set();
  for (let x = Math.floor((Math.min(from.x, to.x) - 1) / 12); x <= Math.floor((Math.max(from.x, to.x) + 1) / 12); x++) for (let z = Math.floor((Math.min(from.z, to.z) - 1) / 12); z <= Math.floor((Math.max(from.z, to.z) + 1) / 12); z++) for (const wall of nav.wallBins.get(`${x},${z}`) ?? []) walls.add(wall);
  return walls;
}
function wallsBlock(state, from, to, options) {
  if (options.ignoreWalls) return false;
  for (const wall of candidateWalls(state, from, to)) {
    if (!wallAlive(wall) || wall.id === options.ignoreWallId) continue;
    for (const [a, b] of wallParts(state, wall, options.factionId)) if (segmentsDistance(from, to, a, b) <= wall.width * .5 + (options.radius ?? .3)) return true;
  }
  return false;
}
function terrainFootprint(seed, point, radius) {
  let cache = footprintCaches.get(seed);
  if (!cache) {
    footprintCaches.set(seed, cache = new Map());
    if (footprintCaches.size > 8) footprintCaches.delete(footprintCaches.keys().next().value);
  }
  // Exact coordinates, not rounded cells: banks can change within one step.
  // Local steering tests the same starting footprint in several directions;
  // static route edges likewise share endpoints. Cache only immutable terrain.
  const key = `${point.x}:${point.z}:${radius}`;
  if (cache.has(key)) return cache.get(key);
  const clear = footprintDirections.every(([dx, dz]) => isTerrainTraversable(point.x + dx * radius, point.z + dz * radius, seed));
  cache.set(key, clear);
  if (cache.size > 8192) cache.delete(cache.keys().next().value);
  return clear;
}
function terrainSegment(seed, from, to, radius = 0) {
  // A body occupies the same footprint when stationary or changing direction.
  // The former sideways-only strip could end with its toes over a bank and
  // then reject every turn, stranding a real soldier after the squad moved on.
  if (radius > 0 && (!terrainFootprint(seed, from, radius) || !terrainFootprint(seed, to, radius))) return false;
  const d = distance(from, to), steps = Math.max(1, Math.ceil(d / SAMPLE_SPACING));
  const nx = d ? -(to.z - from.z) / d * radius : radius, nz = d ? (to.x - from.x) / d * radius : 0;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, x = mix(from.x, to.x, t), z = mix(from.z, to.z, t);
    if (!isTerrainTraversable(x, z, seed)) return false;
    if (radius > 0 && (!isTerrainTraversable(x + nx, z + nz, seed) || !isTerrainTraversable(x - nx, z - nz, seed))) return false;
  }
  return true;
}
export function isSegmentTraversable(state, from, to, options = {}) {
  if (!finitePoint(from) || !finitePoint(to)) return false;
  return terrainSegment((state.terrainSeed || state.seed), from, to, options.radius ?? 0) && !wallsBlock(state, from, to, options);
}
export function isPointTraversable(state, point, options = {}) {
  return isSegmentTraversable(state, point, point, options);
}

function staticEdge(nav, fromIndex, dir) {
  const cacheIndex = fromIndex * 8 + dir;
  if (nav.edges[cacheIndex]) return nav.edges[cacheIndex] === 1;
  const [dx, dz] = directions[dir], x = fromIndex % GRID_SIDE, z = Math.floor(fromIndex / GRID_SIDE), xx = x + dx, zz = z + dz;
  let valid = xx >= 0 && xx < GRID_SIDE && zz >= 0 && zz < GRID_SIDE;
  const toIndex = zz * GRID_SIDE + xx;
  valid &&= !!nav.walkable[toIndex];
  if (valid && dx && dz) valid = !!nav.walkable[z * GRID_SIDE + xx] && !!nav.walkable[zz * GRID_SIDE + x];
  if (valid) valid = terrainSegment(nav.seed, cellPoint(fromIndex), cellPoint(toIndex), .16);
  nav.edges[cacheIndex] = valid ? 1 : -1;
  return valid;
}
class Heap {
  constructor() { this.items = []; }
  push(item) {
    let i = this.items.length; this.items.push(item);
    while (i > 0) { const p = (i - 1) >> 1; if (this.items[p].score < item.score || (this.items[p].score === item.score && this.items[p].index <= item.index)) break; this.items[i] = this.items[p]; i = p; } this.items[i] = item;
  }
  pop() {
    const first = this.items[0], tail = this.items.pop();
    if (!this.items.length) return first;
    let i = 0;
    while (i * 2 + 1 < this.items.length) {
      let child = i * 2 + 1;
      if (child + 1 < this.items.length && (this.items[child + 1].score < this.items[child].score || (this.items[child + 1].score === this.items[child].score && this.items[child + 1].index < this.items[child].index))) child++;
      if (tail.score < this.items[child].score || (tail.score === this.items[child].score && tail.index <= this.items[child].index)) break;
      this.items[i] = this.items[child]; i = child;
    }
    this.items[i] = tail; return first;
  }
}
function endpointCells(state, nav, point, options) {
  const center = cellAt(point), cx = center % GRID_SIDE, cz = Math.floor(center / GRID_SIDE), result = [];
  for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
    const x = cx + dx, z = cz + dz;
    if (x < 0 || z < 0 || x >= GRID_SIDE || z >= GRID_SIDE) continue;
    const index = z * GRID_SIDE + x;
    if (!nav.walkable[index]) continue;
    const p = cellPoint(index), d = distance(point, p);
    if (d > 7.2 || !isSegmentTraversable(state, point, p, options)) continue;
    result.push({ index, distance: d });
  }
  return result.sort((a, b) => a.distance - b.distance || a.index - b.index).slice(0, 8);
}
function approachTargets(state, target, options) {
  if (isPointTraversable(state, target, options)) return [target];
  const arrival = Math.max(0, options.arrival ?? 0), targets = [];
  if (arrival <= 0) return targets;
  for (const fraction of [.78, .96]) for (let i = 0; i < 16; i++) {
    const angle = i / 16 * Math.PI * 2, candidate = { x: target.x + Math.cos(angle) * arrival * fraction, z: target.z + Math.sin(angle) * arrival * fraction };
    if (isPointTraversable(state, candidate, options)) targets.push(candidate);
  }
  return targets;
}
function simplifyPath(state, start, points, options) {
  const result = [], count = points.length;
  let current = start, index = 0;
  while (index < count) {
    let next = index;
    // A bounded look-ahead prevents smoothing from becoming quadratic on a
    // long coast route. Every accepted shortcut is checked physically.
    for (let i = Math.min(count - 1, index + 18); i > index; i--) if (isSegmentTraversable(state, current, points[i], options)) { next = i; break; }
    current = points[next]; result.push({ x: current.x, z: current.z }); index = next + 1;
  }
  return result;
}
export function findPath(state, from, to, options = {}) {
  if (!finitePoint(from) || !finitePoint(to)) return { reachable: false, waypoints: [], length: Infinity, reason: 'invalid-endpoint' };
  const settings = { radius: .16, ...options }, nav = staticNavigation((state.terrainSeed || state.seed)), dynamic = refreshWalls(state);
  // All route types, including direct local hauling, are cached before any
  // terrain sampling. This is important when a town repeatedly scores the same
  // reported resource routes during its economic decisions.
  const key = `${pointKey(from)}>${pointKey(to)}:${settings.factionId ?? ''}:${settings.arrival ?? 0}:${settings.radius}:${!!settings.ignoreWalls}:${settings.ignoreWallId ?? ''}:${dynamic.version}:${options.maxExpansions ?? NAV_MAX_EXPANSIONS}`;
  const cached = dynamic.paths.get(key);
  if (cached) { dynamic.cacheHits++; return { ...cached, waypoints: cached.waypoints.map(p => ({ ...p })) }; }
  const remember = result => {
    dynamic.paths.set(key, result);
    if (dynamic.paths.size > 512) dynamic.paths.delete(dynamic.paths.keys().next().value);
    return { ...result, waypoints: result.waypoints.map(p => ({ ...p })) };
  };
  const targets = approachTargets(state, to, settings);
  if (!isPointTraversable(state, from, settings)) return remember({ reachable: false, waypoints: [], length: Infinity, reason: 'blocked-start' });
  if (!targets.length) return remember({ reachable: false, waypoints: [], length: Infinity, reason: 'blocked-target' });
  for (const target of targets) if (isSegmentTraversable(state, from, target, settings)) return remember({ reachable: true, waypoints: [{ x: target.x, z: target.z }], length: distance(from, target), reason: 'direct' });
  const starts = endpointCells(state, nav, from, settings), goals = new Map();
  for (const target of targets) for (const cell of endpointCells(state, nav, target, settings)) if (!goals.has(cell.index) || cell.distance < goals.get(cell.index).distance) goals.set(cell.index, { ...cell, target });
  if (!starts.length || !goals.size) return { reachable: false, waypoints: [], length: Infinity, reason: 'isolated-endpoint' };
  dynamic.searches++;
  const costs = new Float64Array(GRID_COUNT); costs.fill(Infinity);
  const parents = new Int32Array(GRID_COUNT); parents.fill(-1);
  const closed = new Uint8Array(GRID_COUNT), heap = new Heap();
  for (const cell of starts) { costs[cell.index] = cell.distance; heap.push({ index: cell.index, score: cell.distance + distance(cellPoint(cell.index), to) }); }
  let found = -1, expansions = 0;
  while (heap.items.length && expansions < (options.maxExpansions ?? NAV_MAX_EXPANSIONS)) {
    const current = heap.pop().index;
    if (closed[current]) continue;
    closed[current] = 1; expansions++;
    if (goals.has(current)) { found = current; break; }
    const point = cellPoint(current);
    for (let dir = 0; dir < directions.length; dir++) {
      if (!staticEdge(nav, current, dir)) continue;
      const [dx, dz] = directions[dir], next = current + dz * GRID_SIDE + dx;
      if (closed[next]) continue;
      const nextPoint = cellPoint(next);
      if (wallsBlock(state, point, nextPoint, settings)) continue;
      if (settings.radius > .16 && !terrainSegment((state.terrainSeed || state.seed), point, nextPoint, settings.radius)) continue;
      const cost = costs[current] + NAV_CELL_SIZE * (dx && dz ? Math.SQRT2 : 1) / Math.max(.4, (nav.movement[current] + nav.movement[next]) * .5);
      if (cost >= costs[next]) continue;
      costs[next] = cost; parents[next] = current;
      heap.push({ index: next, score: cost + distance(nextPoint, to) });
    }
  }
  let result;
  if (found < 0) result = { reachable: false, waypoints: [], length: Infinity, reason: expansions >= (options.maxExpansions ?? NAV_MAX_EXPANSIONS) ? 'search-budget' : 'unreachable', expansions };
  else {
    const goal = goals.get(found).target, points = [{ x: goal.x, z: goal.z }];
    for (let index = found; index !== -1; index = parents[index]) points.push(cellPoint(index));
    points.reverse();
    const waypoints = simplifyPath(state, from, points, settings);
    let previous = from, length = 0;
    for (const point of waypoints) { length += distance(previous, point); previous = point; }
    result = { reachable: true, waypoints, length, reason: 'routed', expansions };
  }
  return remember(result);
}

// A tactical estimate uses only geometry the caller already knows. Hidden
// buildings cannot influence its choice; real movement still uses the complete
// physical world. Removing a candidate must actually open a shorter route that
// crosses it, and its damage cost must beat a reasonable detour.
export function assessBreachRoute(state, from, goal, candidates = [], options = {}) {
  const maxCandidates = clamp(Math.floor(options.maxCandidates ?? 3), 0, 6);
  const maxExpansions = clamp(Math.floor(options.maxExpansions ?? 512), 1, 2048);
  const factionId = state.factions ? factionController(state, options.factionId) : options.factionId;
  const faction = state.factions?.find(f => f.id === factionId);
  const known = candidates.map(candidate => {
    const record = candidate.building ?? candidate.record ?? candidate;
    const owner = candidate.home ? candidate.home.occupiedBy || candidate.home.factionId : candidate.ownerId ?? record.factionId;
    const ownerId = state.factions ? factionController(state, owner) : owner;
    const geometry = wallGeometry(record);
    return { source: candidate, record, ownerId, geometry };
  }).filter(w => w.record.id && ['wall', 'gate'].includes(w.record.kind) && w.geometry && (w.record.progress ?? 1) >= 1 && !w.record.destroyed && (w.record.hp ?? w.record.health ?? 1) > 0)
    .sort((a, b) => String(a.record.id).localeCompare(String(b.record.id)));
  const knownState = { seed: (state.terrainSeed || state.seed), config: state.config, factions: state.factions, settlements: [], walls: known.map(w => ({ ...w.record, factionId: w.ownerId })), navigationRevision: 0 };
  const routeOptions = { factionId, radius: options.radius ?? .16, arrival: options.arrival ?? .5, maxExpansions };
  const route = findPath(knownState, from, goal, routeOptions);
  const result = { action: route.reachable ? (route.reason === 'direct' ? 'advance' : 'detour') : 'unreachable', wallId: null, wall: null, route,
    detourLength: route.length, breachLength: Infinity, savedSeconds: 0, reason: route.reachable ? 'A usable route avoids unnecessary damage' : 'No known route found within the bounded search', assessedCandidates: 0, expansions: route.expansions ?? 0 };
  if (!finitePoint(from) || !finitePoint(goal) || route.reason === 'direct' || route.reason === 'search-budget' || !(options.breachDps > 0)) return result;
  const speed = Math.max(.1, options.speed ?? 2.8), minSaved = Math.max(0, options.minSavedSeconds ?? 3), maxDetourRatio = Math.max(1, options.maxDetourRatio ?? 1.22);
  const relevant = known.filter(w => w.ownerId !== factionId && relationStatus(knownState, faction, w.ownerId) !== 'allied' && !friendlyGate(knownState, { record: w.record, ownerId: w.ownerId }, factionId))
    .sort((a, b) => segmentsDistance(from, goal, a.geometry.from, a.geometry.to) - segmentsDistance(from, goal, b.geometry.from, b.geometry.to) || pointSegmentDistance(from, a.geometry.from, a.geometry.to) - pointSegmentDistance(from, b.geometry.from, b.geometry.to) || String(a.record.id).localeCompare(String(b.record.id)))
    .slice(0, maxCandidates);
  for (const wall of relevant) {
    result.assessedCandidates++;
    const opened = findPath(knownState, from, goal, { ...routeOptions, ignoreWallId: wall.record.id });
    result.expansions += opened.expansions ?? 0;
    if (!opened.reachable) continue;
    let previous = from, crosses = false;
    for (const point of opened.waypoints) {
      if (segmentsDistance(previous, point, wall.geometry.from, wall.geometry.to) <= wall.geometry.width * .5 + routeOptions.radius) crosses = true;
      previous = point;
    }
    if (!crosses || (route.reachable && route.length <= opened.length * maxDetourRatio)) continue;
    const breachSeconds = Math.max(0, wall.record.hp ?? wall.record.health ?? wall.record.maxHp ?? 300) / options.breachDps;
    const savedSeconds = route.reachable ? (route.length - opened.length) / speed - breachSeconds : Infinity;
    if (savedSeconds < minSaved || (result.wallId && savedSeconds <= result.savedSeconds)) continue;
    Object.assign(result, { action: 'breach', wallId: wall.record.id, wall: wall.source, breachLength: opened.length, savedSeconds, breachSeconds,
      reason: route.reachable ? 'Breaking this visible obstruction saves time over the detour' : 'This known obstruction seals the approach; breaking it opens a route' });
  }
  return result;
}

// Reserve a stable, small approach lane for a whole work party. This spreads
// simultaneous crews without creating bodies, teleporting, or running body A*.
export function arrivalLane(state, group, target, arrival) {
  const targetKey = String(target.id ?? pointKey(target)), dynamic = refreshWalls(state);
  if (group.arrivalLane?.targetKey === targetKey && group.arrivalLane.topologyVersion === dynamic.version) return group.arrivalLane;
  if (group.arrivalLane?.targetKey === targetKey && isPointTraversable(state, group.arrivalLane, { factionId: group.factionId, radius: .16 })) {
    group.arrivalLane.topologyVersion = dynamic.version; return group.arrivalLane;
  }
  let hash = 2166136261;
  for (const char of String(group.id ?? group.originId ?? 'party')) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  const phase = (hash >>> 0) / 4294967296 * Math.PI * 2;
  const radius = Math.max(.3, arrival * .68), peers = (state.groups ?? []).filter(peer => peer !== group && peer.phase !== 'returning' && peer.arrivalLane?.targetKey === targetKey).map(peer => peer.arrivalLane);
  let best = null, bestScore = -Infinity;
  for (let i = 0; i < 12; i++) {
    const angle = phase + i / 12 * Math.PI * 2, candidate = { x: target.x + Math.cos(angle) * radius, z: target.z + Math.sin(angle) * radius };
    if (!isSegmentTraversable(state, candidate, target, { factionId: group.factionId, radius: .16 })) continue;
    const separation = peers.length ? Math.min(...peers.map(peer => distance(peer, candidate))) : radius;
    const score = separation - i * .0001;
    if (score > bestScore) { best = candidate; bestScore = score; }
  }
  // If surrounding terrain is constrained, use the real centre rather than a
  // fabricated safe point across a wall. Ordinary pathfinding can then fail.
  const point = best ?? { x: target.x, z: target.z };
  return group.arrivalLane = { ...point, targetKey, topologyVersion: dynamic.version };
}

export function moveAlongRoute(state, group, target, options = {}) {
  const dt = Math.max(0, options.dt ?? .1), requestedArrival = Math.max(.02, options.arrival ?? .45), factionId = options.factionId ?? groupController(state, group);
  if (!finitePoint(group) || !finitePoint(target)) return false;
  let arrival = requestedArrival;
  if (options.spreadArrival) { target = arrivalLane(state, group, target, requestedArrival); arrival = Math.min(.38, requestedArrival * .22); }
  // Proximity cannot complete a trip through a wall. The same collision test
  // protects cargo delivery and melee, including the last sub-step.
  if (distance(group, target) <= arrival && isSegmentTraversable(state, group, target, { factionId, radius: 0, ignoreWallId: options.ignoreWallId })) { group.stuck = 0; group.stuckTime = 0; return true; }
  const dynamic = refreshWalls(state), key = `${arrival}:${factionId}:${dynamic.version}:${options.ignoreWallId ?? ''}`;
  let route = group.navigation;
  const now = state.time ?? (state.step ?? 0) * .1;
  const movedGoal = route?.goal ? distance(route.goal, target) : Infinity;
  const finishedRoute = route?.reachable && route.index >= route.waypoints.length - 1 && route.waypoints.length && distance(group, route.waypoints.at(-1)) < .3;
  const targetChanged = movedGoal > NAV_CELL_SIZE && (now >= (route?.replanAfter ?? 0) || movedGoal > 12);
  if (!route || route.key !== key || targetChanged || (finishedRoute && movedGoal > .2) || (!route.reachable && now >= route.retryAt)) {
    const result = findPath(state, group, target, { factionId, arrival, radius: .16, ignoreWallId: options.ignoreWallId });
    route = group.navigation = { key, goal: { x: target.x, z: target.z }, reachable: result.reachable, waypoints: result.waypoints, index: 0, length: Number.isFinite(result.length) ? result.length : null, reason: result.reason, retryAt: now + 5, replanAfter: now + .75 };
  } else if (route.reachable && movedGoal > .02 && movedGoal <= NAV_CELL_SIZE && route.index === route.waypoints.length - 1 && distance(group, target) < 8 && isSegmentTraversable(state, group, target, { factionId, radius: .16, ignoreWallId: options.ignoreWallId })) {
    // A nearby moving target only adjusts the final, physically verified leg.
    // Small pursuit changes never cause a full A* search every pulse.
    route.waypoints[route.waypoints.length - 1] = { x: target.x, z: target.z };
    route.goal = { x: target.x, z: target.z };
  }
  if (!route.reachable || !route.waypoints.length) { group.stuck = (group.stuck || 0) + dt; group.stuckTime = (group.stuckTime || 0) + dt; return false; }
  while (route.index < route.waypoints.length - 1 && distance(group, route.waypoints[route.index]) < 1e-7) route.index++;
  const point = route.waypoints[route.index], remaining = distance(group, point);
  const sampleStep = state.step ?? Math.floor(now * 10);
  if (group.movementFactor == null || group.movementSampleStep == null || sampleStep < group.movementSampleStep || sampleStep - group.movementSampleStep >= 5) {
    group.movementFactor = terrainAt(group.x, group.z, (state.terrainSeed || state.seed)).movement; group.movementSampleStep = sampleStep;
  }
  const pace = Math.max(0, options.speed ?? group.speed ?? 2.8) * group.movementFactor;
  const amount = Math.min(remaining, pace * dt), fraction = remaining ? amount / remaining : 0;
  const next = { x: mix(group.x, point.x, fraction), z: mix(group.z, point.z, fraction) };
  // Movement and replanning need identical footing. A narrower movement body
  // could enter a bank sliver that every subsequent .16-radius route rejected.
  if (amount > 0 && isSegmentTraversable(state, group, next, { factionId, radius: .16, ignoreWallId: options.ignoreWallId })) {
    group.x = next.x; group.z = next.z; group.travelled = (group.travelled || 0) + amount; group.stuck = 0; group.stuckTime = 0;
    if (remaining <= amount + .001 && route.index < route.waypoints.length - 1) route.index++;
  } else {
    group.stuck = (group.stuck || 0) + dt; group.stuckTime = (group.stuckTime || 0) + dt;
    if (group.stuckTime >= .8) { route.reachable = false; route.retryAt = now + .6; }
  }
  return distance(group, target) <= arrival && isSegmentTraversable(state, group, target, { factionId, radius: 0, ignoreWallId: options.ignoreWallId });
}

// Terrain heights for repeated field-of-view rays use a fine, seeded lattice.
// The cache contains only immutable geography and cannot leak world entities.
function sightHeight(nav, x, z) {
  const ix = Math.round(x * 2) + SIGHT_OFFSET, iz = Math.round(z * 2) + SIGHT_OFFSET;
  if (ix < 0 || iz < 0 || ix >= SIGHT_SIDE || iz >= SIGHT_SIDE) return heightAt(x, z, nav.seed);
  const key = iz * SIGHT_SIDE + ix;
  if (!nav.heightKnown[key]) { nav.heightCache[key] = heightAt((ix - SIGHT_OFFSET) * .5, (iz - SIGHT_OFFSET) * .5, nav.seed); nav.heightKnown[key] = 1; }
  return nav.heightCache[key];
}
export function lineOfSight(state, from, to, options = {}) {
  if (!finitePoint(from) || !finitePoint(to)) return false;
  const d = distance(from, to);
  if (d > (options.maxRange ?? Infinity)) return false;
  const nav = staticNavigation((state.terrainSeed || state.seed)), fromY = (from.y ?? sightHeight(nav, from.x, from.z)) + (options.fromHeight ?? 1.4), toY = (to.y ?? sightHeight(nav, to.x, to.z)) + (options.toHeight ?? 1.2);
  const steps = Math.max(1, Math.ceil(d / 1.1));
  for (let i = 1; i < steps; i++) {
    const t = i / steps, x = mix(from.x, to.x, t), z = mix(from.z, to.z, t), ground = sightHeight(nav, x, z);
    if (ground > mix(fromY, toY, t) + .08 || (options.blockWater && ground < -.3)) return false;
  }
  if (!options.ignoreWalls) for (const wall of candidateWalls(state, from, to)) {
    if (!wallAlive(wall) || wall.id === options.ignoreWallId || wall.id === to.id || wall.id === from.id) continue;
    for (const [a, b] of wallParts(state, wall, options.factionId)) {
      if (segmentsDistance(from, to, a, b) > wall.width * .5) continue;
      const middle = { x: (a.x + b.x) * .5, z: (a.z + b.z) * .5 }, t = d ? clamp(((middle.x - from.x) * (to.x - from.x) + (middle.z - from.z) * (to.z - from.z)) / (d * d), 0, 1) : 0;
      if (heightAt(middle.x, middle.z, (state.terrainSeed || state.seed)) + wall.height > mix(fromY, toY, t)) return false;
    }
  }
  return true;
}
export function knownChokepoints(state, factionId, isExplored) {
  if (typeof isExplored !== 'function') return [];
  const passes = state.terrain?.passes ?? terrainFeatures((state.terrainSeed || state.seed)).passes;
  return passes.filter(pass => isExplored(state, factionId, pass)).map(pass => ({ ...pass }));
}
export function navigationDiagnostics(state) {
  const nav = refreshWalls(state);
  return { searches: nav.searches, cacheHits: nav.cacheHits, cachedRoutes: nav.paths.size, wallSegments: nav.walls.length, topologyVersion: nav.version, gridCellSize: NAV_CELL_SIZE };
}
