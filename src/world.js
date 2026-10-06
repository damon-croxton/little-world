import { normalizeConfig } from './config.js';

// Pure terrain contract: the surface depends only on the seed. Resource
// placement also uses the selected start count; render time and simulation
// random state never enter these functions.
const cache = new Map();
export const WORLD_RADIUS = 180;
export const LAND_SCALE = 4;
export const RESOURCE_RADIUS = WORLD_RADIUS * .88;
export const WORLD_RESOURCE_SITES = 520;
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;

function hashSeed(value) {
  let h = 2166136261;
  for (const c of String(value)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}
function randomGenerator(seed) {
  let a = seed >>> 0;
  return () => { a += 0x6D2B79F5; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function parameters(seed) {
  const key = String(seed);
  if (cache.has(key)) return cache.get(key);
  const hash = hashSeed(key), rand = randomGenerator(hash);
  const phase = rand() * Math.PI * 2;
  const rotation = (rand() - .5) * .2;
  const starts = Array.from({ length: 6 }, (_, i) => {
    const a = i / 6 * Math.PI * 2 + Math.PI / 6 + rotation;
    const r = 80 + rand() * 27;
    return { x: Math.cos(a) * r, z: Math.sin(a) * r };
  });
  const offset = rand() * 200;
  const shift = Math.sin(phase) * 5;
  // The raised ridges are physical mesh features, not invisible collision boxes.
  // Gaps cut all the way through each ridge form useful mountain passes.
  const ridges = [
    { id: 'ridge-west', kind: 'cliff', x: -75, z: -35 + shift, angle: -.16, length: 90, width: 10, height: 6.3, gaps: [-19, 20] },
    { id: 'ridge-east', kind: 'cliff', x: 73, z: 35 - shift, angle: .22, length: 92, width: 11, height: 6.8, gaps: [-20, 20] },
  ];
  for (const ridge of ridges) { ridge.cos = Math.cos(ridge.angle); ridge.sin = Math.sin(ridge.angle); }
  const fords = [-78 + shift, 2 + shift, 78 + shift].map((z, i) => ({ id: `ford-${i}`, kind: 'ford', x: riverX(z / LAND_SCALE, { phase }) * LAND_SCALE, z, width: 11, axis: 'east-west' }));
  const passes = [...fords, ...ridges.flatMap(ridge => ridge.gaps.map((along, i) => ({
    id: `${ridge.id}-pass-${i}`, kind: 'mountain-pass', x: ridge.x + Math.cos(ridge.angle) * along,
    z: ridge.z + Math.sin(ridge.angle) * along, width: 10, axis: ridge.angle + Math.PI / 2, obstacleId: ridge.id,
  })))];
  const p = { hash, phase, starts, offset, rotation, ridges, fords, passes };

  if (cache.size > 16) cache.delete(cache.keys().next().value);
  cache.set(key, p);
  return p;
}
function lattice(x, z, seed) {
  let h = Math.imul(x, 374761393) + Math.imul(z, 668265263) + seed;
  h = Math.imul(h ^ h >>> 13, 1274126177);
  return ((h ^ h >>> 16) >>> 0) / 4294967295;
}
function noise(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  return mix(mix(lattice(ix, iz, seed), lattice(ix + 1, iz, seed), u), mix(lattice(ix, iz + 1, seed), lattice(ix + 1, iz + 1, seed), u), v);
}
function shoreRadius(a, p) { return 42.5 + 2.0 * Math.sin(a * 3 + p.phase) + 1.5 * Math.sin(a * 7 - p.phase * .6); }
function riverX(z, p) { return -2.3 + 3.9 * Math.sin(z * .105 + p.phase * .15) + 1.3 * Math.sin(z * .24); }
function ridgeAmount(x, z, ridge) {
  const dx = x - ridge.x, dz = z - ridge.z;
  if (Math.abs(dx) > ridge.length * .5 + ridge.width || Math.abs(dz) > ridge.width + Math.abs(ridge.sin) * ridge.length * .5) return 0;
  const along = dx * ridge.cos + dz * ridge.sin;
  const across = -dx * ridge.sin + dz * ridge.cos;
  let amount = (1 - smooth(ridge.width * .5 - 1.2, ridge.width * .5 + 1.2, Math.abs(across))) * (1 - smooth(ridge.length * .5 - 3, ridge.length * .5 + 1, Math.abs(along)));
  for (const gap of ridge.gaps) amount *= smooth(5, 7, Math.abs(along - gap));
  return amount;
}


export function biomeAt(x, z, seed = 'littleworld') {
  x /= LAND_SCALE; z /= LAND_SCALE;
  const p = parameters(seed);
  const warp = (noise(x * .085, z * .085, p.hash) - .5) * 7;
  if (z < -3.5 + x * .16 + warp) return 'alien';
  return x > 3 + z * .07 + warp ? 'desert' : 'meadow';
}

export function heightAt(x, z, seed = 'littleworld') {
  const worldX = x, worldZ = z;
  x /= LAND_SCALE; z /= LAND_SCALE;
  const p = parameters(seed), r = Math.hypot(x, z), interior = r < 35.8;
  const shore = interior ? 42.5 : Math.min(shoreRadius(Math.atan2(z, x), p), WORLD_RADIUS / LAND_SCALE - 2);
  if (r > shore + 3.5) return -3.8;
  const n1 = noise(x * .055 + p.offset, z * .055, p.hash);
  const n2 = noise(x * .16, z * .16 + p.offset, p.hash + 37);
  const n3 = noise(x * .4, z * .4, p.hash + 91);
  let h = 1.35 + n1 * 4.1 + n2 * .85 + n3 * .14;
  // Back-country peaks frame the settlements without hiding the playable plain.
  h += Math.exp(-((x + 17) ** 2 / 48 + (z + 30) ** 2 / 35)) * 4.2;
  h += Math.exp(-((x - 25) ** 2 / 58 + (z + 19) ** 2 / 44)) * 3.1;
  h += Math.exp(-((x + 29) ** 2 / 38 + (z - 10) ** 2 / 50)) * 2.1;
  // Broad level clearings are part of the world itself, shared by all renderers.
  for (const start of p.starts) {
    if (Math.abs(worldX - start.x) >= 16 || Math.abs(worldZ - start.z) >= 16) continue;
    const d = Math.hypot(worldX - start.x, worldZ - start.z);
    if (d < 16) h = mix(h, 2.2, 1 - smooth(9, 16, d));
  }
  // Outside this analytic envelope, the river contributes exactly zero.
  if (x > -11.6 && x < 7 && Math.abs(z) < 40) {
    const riverLength = 1 - smooth(34, 40, Math.abs(z));
    // Three broad stone-bottomed fords have shallower, wider bank ramps.
    let ford = 0;
    for (const crossing of p.fords) ford = Math.max(ford, 1 - smooth(crossing.width * .5, crossing.width * .5 + 3, Math.abs(worldZ - crossing.z)));
    const valley = 1 - smooth(.65, mix(2.9, 4.1, ford), Math.abs(x - riverX(z, p)));
    h = mix(h, mix(-1.15, .13, ford) + n3 * .04, valley * riverLength);
  }
  for (const ridge of p.ridges) h += ridge.height * ridgeAmount(worldX, worldZ, ridge);
  return interior ? h : mix(-3.8, h, 1 - smooth(shore - 3.2, shore + 3.5, r));
}

function passAt(x, z, p) {
  for (const pass of p.passes) {
    if (pass.kind === 'ford') {
      if (Math.abs(z - pass.z) < pass.width * .5 && Math.abs(x - riverX(z / LAND_SCALE, p) * LAND_SCALE) < 11) return pass;
    } else if (Math.hypot(x - pass.x, z - pass.z) < pass.width * .65) return pass;
  }
  return null;
}

export function terrainAt(x, z, seed = 'littleworld') {
  const p = parameters(seed), height = heightAt(x, z, seed), biome = biomeAt(x, z, seed);
  const dx = heightAt(x + .7, z, seed) - heightAt(x - .7, z, seed);
  const dz = heightAt(x, z + .7, seed) - heightAt(x, z - .7, seed);
  const slope = Math.hypot(dx, dz) / 1.4, roughness = clamp(slope / 1.9);
  const water = height < .32, deepWater = height < -.3;
  const cliff = slope > 1.15 || p.ridges.some(ridge => ridgeAmount(x, z, ridge) > .12);
  const blockedBy = Math.abs(x) >= WORLD_RADIUS || Math.abs(z) >= WORLD_RADIUS ? 'world-edge' : deepWater ? 'deep-water' : cliff ? 'cliff' : null;
  const pass = passAt(x, z, p);
  return {
    height, biome, roughness, slope, water, deepWater, cliff, blockedBy, traversable: blockedBy === null,
    passId: pass?.id ?? null,
    movement: blockedBy ? 0 : clamp((water ? .61 : 1) - roughness * .46 - (biome === 'desert' ? .08 : 0), .32, 1),
    fertility: water ? .12 : clamp(({ meadow: .83, desert: .22, alien: .66 }[biome]) - roughness * .28)
  };
}

// A conservative analytic shortcut for broad, low-relief interior ground.
// Outside the coast, river, cliff envelopes and clearing shoulders, the seeded
// noise/peak slope bound is below .7 and ground is at least1.35 high. Boundary
// areas still use exactly the full terrainAt test; collision is never weakened.
export function isTerrainTraversable(x, z, seed = 'littleworld') {
  if (!Number.isFinite(x) || !Number.isFinite(z) || Math.abs(x) >= WORLD_RADIUS || Math.abs(z) >= WORLD_RADIUS) return false;
  const p = parameters(seed);
  const safeInterior = 35.8 * LAND_SCALE - 1, riverMargin = 4.2 * LAND_SCALE + .7;
  let ordinary = x * x + z * z < safeInterior * safeInterior;
  ordinary &&= x < -7.5 * LAND_SCALE - riverMargin || x > 2.9 * LAND_SCALE + riverMargin || Math.abs(x - riverX(z / LAND_SCALE, p) * LAND_SCALE) > riverMargin;
  if (ordinary) for (const ridge of p.ridges) {
    const dx = x - ridge.x, dz = z - ridge.z;
    const along = dx * ridge.cos + dz * ridge.sin, across = -dx * ridge.sin + dz * ridge.cos;
    if (Math.abs(along) < ridge.length * .5 + 4 && Math.abs(across) < ridge.width * .5 + 3) { ordinary = false; break; }
  }
  if (ordinary) for (const start of p.starts) {
    if (Math.abs(x - start.x) >= 17 || Math.abs(z - start.z) >= 17) continue;
    const d = Math.hypot(x - start.x, z - start.z);
    if (d > 8 && d < 17) { ordinary = false; break; }
  }
  return ordinary || terrainAt(x, z, seed).traversable;
}

// Physical terrain only. This reveals no resource, settlement or faction data.
export function terrainFeatures(seed = 'littleworld') {
  const p = parameters(seed);
  return {
    obstacles: p.ridges.map(r => ({ ...r, gaps: [...r.gaps] })),
    passes: p.passes.map(p => ({ ...p })),
  };
}

function usableWorksite(x, z, seed) {
  if (!isTerrainTraversable(x, z, seed)) return false;
  for (let i = 0; i < 8; i++) {
    const angle = i * Math.PI / 4;
    if (!isTerrainTraversable(x + Math.cos(angle) * 2.8, z + Math.sin(angle) * 2.8, seed)) return false;
  }
  return true;
}

function clearSegment(from, to, seed) {
  const d = Math.hypot(to.x - from.x, to.z - from.z), steps = Math.max(1, Math.ceil(d / 1.2));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (!terrainAt(mix(from.x, to.x, t), mix(from.z, to.z, t), seed).traversable) return false;
  }
  return true;
}

// Count-specific starts use the same physical island. A natural clearing is
// chosen near each evenly spaced bearing, instead of taking adjacent sites
// from the old six-start array. Every candidate fits a real settlement disk.
export function startingPositions(seed = 'littleworld', options = {}) {
  const p = parameters(seed), { civCount } = normalizeConfig(options), starts = [];
  for (let i = 0; i < civCount; i++) {
    const bearing = i / civCount * Math.PI * 2 + Math.PI / 6 + p.rotation;
    let best = null;
    for (const turn of [0, .07, -.07, .14, -.14, .21, -.21, .28, -.28]) for (const radius of [92, 98, 86, 104, 80, 110]) {
      const x = Math.cos(bearing + turn) * radius, z = Math.sin(bearing + turn) * radius;
      if (starts.some(s => Math.hypot(s.x - x, s.z - z) < 52)) continue;
      let valid = true, roughness = 0;
      for (let j = 0; j < 17; j++) {
        const r = j === 16 ? 0 : 13, a = j / 16 * Math.PI * 2;
        const ground = terrainAt(x + Math.cos(a) * r, z + Math.sin(a) * r, seed);
        if (!ground.traversable || ground.height < .65 || ground.slope > .4) { valid = false; break; }
        roughness += ground.roughness;
      }
      if (!valid) continue;
      const score = Math.abs(turn) * 18 + Math.abs(radius - 92) * .08 + roughness;
      if (!best || score < best.score) best = { x, z, score };
    }
    // Wide angular search is a deterministic fallback for unusual shoreline
    // noise; it never fabricates a point on water or a steep face.
    if (!best) for (let attempt = 0; attempt < 240; attempt++) {
      const angle = bearing + ((attempt % 15) - 7) * .035, radius = 76 + Math.floor(attempt / 15) * 2;
      const candidate = { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius };
      if (starts.some(s => Math.hypot(s.x - candidate.x, s.z - candidate.z) < 45)) continue;
      if (Array.from({ length: 16 }, (_, j) => ({ x: candidate.x + Math.cos(j / 16 * Math.PI * 2) * 12, z: candidate.z + Math.sin(j / 16 * Math.PI * 2) * 12 })).every(point => terrainAt(point.x, point.z, seed).traversable && heightAt(point.x, point.z, seed) > .65)) { best = candidate; break; }
    }
    if (!best) throw new Error(`Unable to place civilization ${i + 1} on seed ${seed}`);
    starts.push({ x: best.x, z: best.z });
  }
  return starts;
}

export function generateWorld(seed = 'littleworld', options = {}) {
  const config = normalizeConfig(options), p = parameters(seed), rand = randomGenerator(p.hash ^ 0x4C1F0123);
  const nodes = [], starts = startingPositions(seed, config);
  const kinds = ['food', 'water', 'energy', 'materials'];
  const subtypeFor = (kind, biome) => {
    if (kind === 'water') return 'spring';
    if (kind === 'food') return biome === 'alien' ? 'biomass' : 'crop';
    if (kind === 'energy') return biome === 'alien' || rand() < .45 ? 'crystal' : 'solar';
    const choice = rand();
    return biome === 'meadow' && choice < .55 ? 'forest' : choice > .68 ? 'salvage' : 'ore';
  };
  const add = (kind, x, z, nearHome = false, subtype = null) => {
    const biome = biomeAt(x, z, seed);
    const affinity = (kind === 'food' && biome === 'meadow') || (kind === 'energy' && biome === 'alien') || (kind === 'materials' && biome === 'desert');
    const richness = Math.min(1, .35 + rand() * .45 + (affinity ? .18 : 0));
    subtype ||= subtypeFor(kind, biome);
    const maxAmount = nearHome ? 900 + Math.round(richness * 1700) : 1600 + Math.round(richness * 4400);
    const regeneration = ({ forest: .17, crop: .8, biomass: .9, spring: 3.4, solar: 1.2, ore: 0, crystal: 0, salvage: 0 }[subtype]) * (.65 + richness * .65);
    nodes.push({ id: `n${nodes.length}`, kind, subtype, x, z, amount: maxAmount, maxAmount, richness, biome, regeneration, radius: 2.2 + richness * 2.3 });
  };
  for (const start of starts) {
    for (let j = 0; j < 8; j++) {
      let x, z, placed = false;
      for (let attempt = 0; attempt < 120; attempt++) {
        const angle = j / 8 * Math.PI * 2 + rand() * .4 + attempt * .381, radius = (j < 4 ? 14 : 20) + rand() * 3.8;
        x = start.x + Math.cos(angle) * radius; z = start.z + Math.sin(angle) * radius;
        if (heightAt(x, z, seed) > .55 && Math.hypot(x, z) < RESOURCE_RADIUS && usableWorksite(x, z, seed) && clearSegment(start, { x, z }, seed)) { placed = true; break; }
      }
      if (!placed) { const angle = j / 8 * Math.PI * 2; x = start.x + Math.cos(angle) * 9; z = start.z + Math.sin(angle) * 9; }
      add(kinds[j % 4], x, z, true);
    }
  }
  // Rich frontier clusters make travel and shared borders meaningful. Their
  // locations remain unknown until physical reconnaissance reports them.
  const clusters = Array.from({ length: 11 }, (_, i) => {
    const angle = i / 11 * Math.PI * 2 + rand() * .4, radius = 32 + rand() * 110;
    return { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius };
  });
  for (let attempt = 0; nodes.length < WORLD_RESOURCE_SITES && attempt < 8000; attempt++) {
    const angle = rand() * Math.PI * 2, radius = Math.sqrt(rand()) * RESOURCE_RADIUS;
    let x = Math.cos(angle) * radius, z = Math.sin(angle) * radius;
    if (attempt % 3 === 0) {
      const cluster = clusters[Math.floor(rand() * clusters.length)], spread = Math.sqrt(rand()) * 20;
      x = cluster.x + Math.cos(angle) * spread; z = cluster.z + Math.sin(angle) * spread;
    }
    if (!terrainAt(x, z, seed).traversable || heightAt(x, z, seed) < .6 || Math.hypot(x, z) > RESOURCE_RADIUS || starts.some(s => Math.hypot(s.x - x, s.z - z) < 12)) continue;
    // Keep the whole worksite on connected, usable ground, rather than placing
    // deposits on a tiny bank ledge that a route cannot physically approach.
    if (!usableWorksite(x, z, seed)) continue;
    if (nodes.some(n => Math.hypot(n.x - x, n.z - z) < 5.3)) continue;
    add(kinds[Math.floor(rand() * kinds.length)], x, z);
  }
  return { nodes, starts, config, ...terrainFeatures(seed), bounds: { minX: -WORLD_RADIUS, maxX: WORLD_RADIUS, minZ: -WORLD_RADIUS, maxZ: WORLD_RADIUS } };
}
