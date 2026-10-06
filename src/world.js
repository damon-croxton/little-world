// Pure terrain contract. Every surface and resource is derived from the seed;
// render time and simulation random state never enter these functions.
const cache = new Map();
export const WORLD_RADIUS = 150;
export const LAND_SCALE = 3.25;
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
    const r = 70 + rand() * 24;
    return { x: Math.cos(a) * r, z: Math.sin(a) * r };
  });
  const p = { hash, phase, starts, offset: rand() * 200 };
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
  const p = parameters(seed), r = Math.hypot(x, z), a = Math.atan2(z, x);
  const shore = shoreRadius(a, p);
  if (r > shore + 3.5) return -3.8;
  const n1 = noise(x * .055 + p.offset, z * .055, p.hash);
  const n2 = noise(x * .16, z * .16 + p.offset, p.hash + 37);
  const n3 = noise(x * .4, z * .4, p.hash + 91);
  let h = 1.35 + n1 * 4.1 + n2 * .85 + n3 * .14;
  // Back-country peaks frame the settlements without hiding the playable plain.
  h += Math.exp(-((x + 17) ** 2 / 48 + (z + 30) ** 2 / 35)) * 4.2;
  h += Math.exp(-((x - 25) ** 2 / 58 + (z + 19) ** 2 / 44)) * 3.1;
  h += Math.exp(-((x + 29) ** 2 / 38 + (z - 10) ** 2 / 50)) * 2.1;
  const valley = 1 - smooth(.65, 2.9, Math.abs(x - riverX(z, p)));
  const riverLength = 1 - smooth(34, 40, Math.abs(z));
  h = mix(h, .06 + n3 * .08, valley * riverLength);
  // Broad level clearings are part of the world itself, shared by all renderers.
  for (const start of p.starts) {
    const d = Math.hypot(worldX - start.x, worldZ - start.z);
    if (d < 16) h = mix(h, 2.2, 1 - smooth(9, 16, d));
  }
  return mix(-3.8, h, 1 - smooth(shore - 3.2, shore + 3.5, r));
}

export function terrainAt(x, z, seed = 'littleworld') {
  const height = heightAt(x, z, seed), biome = biomeAt(x, z, seed);
  const dx = heightAt(x + .7, z, seed) - heightAt(x - .7, z, seed);
  const dz = heightAt(x, z + .7, seed) - heightAt(x, z - .7, seed);
  const roughness = clamp(Math.hypot(dx, dz) / 2.7);
  const water = height < .32;
  return {
    height, biome, roughness, water, traversable: height > -.3 && Math.abs(x) < WORLD_RADIUS && Math.abs(z) < WORLD_RADIUS,
    movement: clamp((water ? .57 : 1) - roughness * .55 - (biome === 'desert' ? .08 : 0), .3, 1),
    fertility: water ? .12 : clamp(({ meadow: .83, desert: .22, alien: .66 }[biome]) - roughness * .28)
  };
}

export function generateWorld(seed = 'littleworld') {
  const p = parameters(seed), rand = randomGenerator(p.hash ^ 0x4C1F0123);
  const nodes = [], starts = p.starts.map(start => ({ ...start }));
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
      let x, z;
      for (let attempt = 0; attempt < 60; attempt++) {
        const angle = j / 8 * Math.PI * 2 + rand() * .4 + attempt * .381, radius = (j < 4 ? 14 : 20) + rand() * 3.8;
        x = start.x + Math.cos(angle) * radius; z = start.z + Math.sin(angle) * radius;
        if (heightAt(x, z, seed) > .55 && Math.hypot(x, z) < 128) break;
      }
      add(kinds[j % 4], x, z, true);
    }
  }
  // Rich frontier clusters make travel and shared borders meaningful. Their
  // locations remain unknown until physical reconnaissance reports them.
  const clusters = Array.from({ length: 9 }, (_, i) => {
    const angle = i / 9 * Math.PI * 2 + rand() * .4, radius = 27 + rand() * 85;
    return { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius };
  });
  for (let attempt = 0; nodes.length < 420 && attempt < 8000; attempt++) {
    const angle = rand() * Math.PI * 2, radius = Math.sqrt(rand()) * 128;
    let x = Math.cos(angle) * radius, z = Math.sin(angle) * radius;
    if (attempt % 3 === 0) {
      const cluster = clusters[Math.floor(rand() * clusters.length)], spread = Math.sqrt(rand()) * 17;
      x = cluster.x + Math.cos(angle) * spread; z = cluster.z + Math.sin(angle) * spread;
    }
    if (heightAt(x, z, seed) < .6 || Math.hypot(x, z) > 132 || starts.some(s => Math.hypot(s.x - x, s.z - z) < 12)) continue;
    if (nodes.some(n => Math.hypot(n.x - x, n.z - z) < 5.3)) continue;
    add(kinds[Math.floor(rand() * kinds.length)], x, z);
  }
  return { nodes, starts, bounds: { minX: -WORLD_RADIUS, maxX: WORLD_RADIUS, minZ: -WORLD_RADIUS, maxZ: WORLD_RADIUS } };
}
