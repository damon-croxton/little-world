import { normalizeConfig } from './config.js';

// Terrain is pure in its explicit terrain key (seed + count + map version).
// The public seed and simulation RNG remain unchanged. Plain seed geometry is
// retained for isolated terrain fixtures; generated worlds use the versioned key.
const cache = new Map();
const MAP_PREFIX = '@uniform-v2:';
export const BALANCED_DISTRICT = Object.freeze({ radius: 20, shoulder: 10, starterRadius: 92, expansionRadius: 44, resourceDistance: 16, fertility: .8, movement: 1, approachWidth: 8 });
export const BALANCED_SUPPLIES = Object.freeze({
  start: { food: 1400, water: 1400, energy: 1800, materials: 1200 },
  expansion: { food: 1800, water: 1800, energy: 2200, materials: 1600 },
  regeneration: { food: .4, water: 1.6, energy: .6, materials: .085 }, richness: .7,
});
export function worldBiome(seed, options = {}) {
  const biome = normalizeConfig(options).biome;
  return biome === 'random' ? ['meadow', 'desert', 'alien'][hashSeed(`biome:${seed}`) % 3] : biome;
}
export function worldTerrainSeed(seed, options = {}) { return `${MAP_PREFIX}${normalizeConfig(options).civCount}:${worldBiome(seed, options)}:${String(seed)}`; }
function terrainIdentity(value) {
  const text = String(value), match = text.startsWith(MAP_PREFIX) && text.slice(MAP_PREFIX.length).match(/^([3-6]):(meadow|desert|alien):([\s\S]*)$/);
  if (match) return { seed: match[3], civCount: Number(match[1]), biome: match[2] };
  const legacy = text.match(/^@balanced-v1:([3-6]):([\s\S]*)$/);
  return legacy ? { seed: legacy[2], civCount: Number(legacy[1]), biome: null } : { seed: text, civCount: null, biome: null };
}
function balancedLayout(rotation, count) {
  if (!count) return { districts: [], approaches: [], balanceBins: new Map() };
  const districts = [], approaches = [], balanceBins = new Map();
  const bin = (shape, minX, maxX, minZ, maxZ) => {
    for (let x = Math.floor(minX / 32); x <= Math.floor(maxX / 32); x++) for (let z = Math.floor(minZ / 32); z <= Math.floor(maxZ / 32); z++) {
      const key = `${x},${z}`; if (!balanceBins.has(key)) balanceBins.set(key, []); balanceBins.get(key).push(shape);
    }
  };
  for (let i = 0; i < count; i++) {
    const angle = i / count * Math.PI * 2 + Math.PI / 6 + rotation;
    for (const kind of ['start', 'expansion']) {
      const reach = kind === 'start' ? BALANCED_DISTRICT.starterRadius : BALANCED_DISTRICT.expansionRadius;
      const area = { id: `${kind}-${i}`, kind, slot: i, x: Math.cos(angle) * reach, z: Math.sin(angle) * reach, angle, radius: BALANCED_DISTRICT.radius };
      districts.push(area); bin(area, area.x - 30, area.x + 30, area.z - 30, area.z + 30);
    }
    const from = districts.at(-2), approach = { id: `approach-${i}`, kind: 'approach', x: from.x, z: from.z, dx: -from.x, dz: -from.z, length2: from.x ** 2 + from.z ** 2, radius: BALANCED_DISTRICT.approachWidth / 2 };
    approaches.push(approach); bin(approach, Math.min(0, from.x) - 14, Math.max(0, from.x) + 14, Math.min(0, from.z) - 14, Math.max(0, from.z) + 14);
  }
  return { districts, approaches, balanceBins };
}
function balanceAt(x, z, p) {
  let strongest = null;
  for (const area of p.balanceBins.get(`${Math.floor(x / 32)},${Math.floor(z / 32)}`) || []) {
    const t = area.kind === 'approach' ? clamp(((x - area.x) * area.dx + (z - area.z) * area.dz) / area.length2) : 0;
    const d = Math.hypot(x - area.x - (area.dx || 0) * t, z - area.z - (area.dz || 0) * t);
    if (d <= area.radius) return { area, weight: 1, core: true };
    const weight = 1 - smooth(area.radius, area.radius + BALANCED_DISTRICT.shoulder, d);
    if (weight > (strongest?.weight || 0)) strongest = { area, weight, core: d <= area.radius + 1e-8 };
  }
  return strongest;
}
export function balancedDistrictAt(x, z, seed) { const found = balanceAt(x, z, parameters(seed)); return found?.core ? found.area : null; }

export const WORLD_RADIUS = 180;
export const LAND_SCALE = 4;
export const RESOURCE_RADIUS = WORLD_RADIUS * .88;
export const WORLD_RESOURCE_SITES = 160;
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
  const identity = terrainIdentity(key), hash = hashSeed(identity.seed), rand = randomGenerator(hash);
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
  const p = { hash, biome: identity.biome, phase, starts, offset, rotation, ridges, fords, passes, ...balancedLayout(rotation, identity.civCount) };

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
  if (p.biome) return p.biome;
  const warp = (noise(x * .085, z * .085, p.hash) - .5) * 7;
  if (z < -3.5 + x * .16 + warp) return 'alien';
  return x > 3 + z * .07 + warp ? 'desert' : 'meadow';
}

export function heightAt(x, z, seed = 'littleworld') {
  const worldX = x, worldZ = z;
  x /= LAND_SCALE; z /= LAND_SCALE;
  const p = parameters(seed), balanced = balanceAt(worldX, worldZ, p);
  if (balanced?.core) return 2.2;
  const r = Math.hypot(x, z), interior = r < 35.8;
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
  const surface = interior ? h : mix(-3.8, h, 1 - smooth(shore - 3.2, shore + 3.5, r));
  return balanced ? mix(surface, 2.2, balanced.weight) : surface;
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
  const p = parameters(seed), height = heightAt(x, z, seed), biome = biomeAt(x, z, seed), balanced = balancedDistrictAt(x, z, seed);
  const dx = heightAt(x + .7, z, seed) - heightAt(x - .7, z, seed);
  const dz = heightAt(x, z + .7, seed) - heightAt(x, z - .7, seed);
  const slope = Math.hypot(dx, dz) / 1.4, roughness = clamp(slope / 1.9);
  const water = height < .32, deepWater = height < -.3;
  const cliff = !balanced && (slope > 1.15 || p.ridges.some(ridge => ridgeAmount(x, z, ridge) > .12));
  const blockedBy = Math.abs(x) >= WORLD_RADIUS || Math.abs(z) >= WORLD_RADIUS ? 'world-edge' : deepWater ? 'deep-water' : cliff ? 'cliff' : null;
  const pass = passAt(x, z, p);
  return {
    height, biome, roughness, slope, water, deepWater, cliff, blockedBy, traversable: blockedBy === null,
    passId: pass?.id ?? null,
    balancedDistrict: balanced ? { id: balanced.id, kind: balanced.kind } : null,
    movement: blockedBy ? 0 : balanced ? BALANCED_DISTRICT.movement : clamp((water ? .61 : 1) - roughness * .46 - (biome === 'desert' ? .08 : 0), .32, 1),
    fertility: balanced ? BALANCED_DISTRICT.fertility : water ? .12 : clamp(({ meadow: .83, desert: .22, alien: .66 }[biome]) - roughness * .28)
  };
}

// A conservative analytic shortcut for broad, low-relief interior ground.
// Outside the coast, river, cliff envelopes and clearing shoulders, the seeded
// noise/peak slope bound is below .7 and ground is at least1.35 high. Boundary
// areas still use exactly the full terrainAt test; collision is never weakened.
export function isTerrainTraversable(x, z, seed = 'littleworld') {
  if (!Number.isFinite(x) || !Number.isFinite(z) || Math.abs(x) >= WORLD_RADIUS || Math.abs(z) >= WORLD_RADIUS) return false;
  const p = parameters(seed);
  const balanced = balanceAt(x, z, p);
  if (balanced) return balanced.core || terrainAt(x, z, seed).traversable;
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
    districts: p.districts.map(p => ({ ...p })),
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

// Count-specific balanced clearings are part of the physical terrain key.
export function startingPositions(seed = 'littleworld', options = {}) {
  const p = parameters(worldTerrainSeed(seed, options));
  return p.districts.filter(d => d.kind === 'start').map(({ x, z }) => ({ x, z }));
}

export function generateWorld(seed = 'littleworld', options = {}) {
  const config = normalizeConfig(options), p = parameters(worldTerrainSeed(seed, config)), rand = randomGenerator(p.hash ^ 0x4C1F0123);
  const nodes = [], starts = startingPositions(seed, config), terrainSeed = worldTerrainSeed(seed, config);
  const districts = parameters(terrainSeed).districts;
  const kinds = ['food', 'water', 'energy', 'materials'];
  const subtypeFor = (kind, biome) => {
    if (kind === 'water') return 'spring';
    if (kind === 'food') return biome === 'alien' ? 'biomass' : 'crop';
    if (kind === 'energy') return biome === 'alien' || rand() < .45 ? 'crystal' : 'solar';
    const choice = rand();
    return biome === 'meadow' && choice < .55 ? 'forest' : choice > .68 ? 'salvage' : 'ore';
  };
  const add = (kind, x, z, nearHome = false, subtype = null) => {
    const biome = biomeAt(x, z, terrainSeed);
    const affinity = (kind === 'food' && biome === 'meadow') || (kind === 'energy' && biome === 'alien') || (kind === 'materials' && biome === 'desert');
    const richness = Math.min(1, .35 + rand() * .45 + (affinity ? .18 : 0));
    subtype ||= subtypeFor(kind, biome);
    const maxAmount = nearHome ? 500 + Math.round(richness * 900) : 900 + Math.round(richness * 2200);
    const regeneration = ({ forest: .17, crop: .8, biomass: .9, spring: 3.4, solar: 1.2, ore: 0, crystal: 0, salvage: 0 }[subtype]) * (.65 + richness * .65) * .45;
    nodes.push({ id: `n${nodes.length}`, kind, subtype, x, z, amount: maxAmount, maxAmount, richness, biome, regeneration, radius: 2.2 + richness * 2.3 });
  };
  // Matched resource sets have the same yield/replenishment despite their
  // biome-specific art. Energy covers machine upkeep; food covers hive upkeep.
  // Starter nodes remain first, preserving stable starter-node ordering.
  for (const kind of ['start', 'expansion']) for (const area of districts.filter(d => d.kind === kind)) {
    for (const [j, resource] of kinds.entries()) {
      const angle = area.angle + j / 4 * Math.PI * 2, x = area.x + Math.cos(angle) * BALANCED_DISTRICT.resourceDistance, z = area.z + Math.sin(angle) * BALANCED_DISTRICT.resourceDistance;
      const subtype = subtypeFor(resource, biomeAt(x, z, terrainSeed)), amount = BALANCED_SUPPLIES[kind][resource];
      nodes.push({ id: `n${nodes.length}`, kind: resource, subtype, x, z, amount, maxAmount: amount, richness: BALANCED_SUPPLIES.richness,
        biome: biomeAt(x, z, terrainSeed), regeneration: BALANCED_SUPPLIES.regeneration[resource], radius: 2.2 + BALANCED_SUPPLIES.richness * 2.3,
        balancedDistrict: area.id, foundingSite: kind === 'expansion' ? { id: area.id, x: area.x, z: area.z } : null });
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
    if (!terrainAt(x, z, terrainSeed).traversable || heightAt(x, z, terrainSeed) < .6 || Math.hypot(x, z) > RESOURCE_RADIUS || districts.some(d => Math.hypot(d.x - x, d.z - z) < (d.kind === 'start' ? 36 : 28))) continue;
    // Keep the whole worksite on connected, usable ground, rather than placing
    // deposits on a tiny bank ledge that a route cannot physically approach.
    if (!usableWorksite(x, z, terrainSeed)) continue;
    if (nodes.some(n => Math.hypot(n.x - x, n.z - z) < 5.3)) continue;
    add(kinds[Math.floor(rand() * kinds.length)], x, z);
  }
  // Scale finite reserves after placement so sliders never consume RNG draws
  // or change terrain, resource kinds, scenery, yields or balanced approaches.
  for (const node of nodes) node.amount = node.maxAmount = Math.round(node.maxAmount * config.resourceScale);
  return { nodes, starts, config, biome: worldBiome(seed, config), terrainSeed, ...terrainFeatures(terrainSeed), bounds: { minX: -WORLD_RADIUS, maxX: WORLD_RADIUS, minZ: -WORLD_RADIUS, maxZ: WORLD_RADIUS } };
}
