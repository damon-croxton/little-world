// Seed, civilisation count and one whole-world biome define a repeatable world.
// Six remains supported for existing scenarios, while ordinary worlds use 3–5.
export const MIN_CIV_COUNT = 3;
export const MAX_CIV_COUNT = 6;
export const BIOME_CHOICES = Object.freeze(['random', 'meadow', 'desert', 'alien']);
export const BIOME_LABELS = Object.freeze({ random: 'Seed choice', meadow: 'Grassland', desert: 'Desert', alien: 'Alien meadow' });
export const DEFAULT_CONFIG = Object.freeze({ civCount: 4, biome: 'random' });

export function normalizeConfig(options = {}) {
  const value = Number(options?.civCount ?? options?.factionCount ?? DEFAULT_CONFIG.civCount);
  const civCount = Number.isFinite(value) ? Math.max(MIN_CIV_COUNT, Math.min(MAX_CIV_COUNT, Math.round(value))) : DEFAULT_CONFIG.civCount;
  const biome = BIOME_CHOICES.includes(options?.biome) ? options.biome : DEFAULT_CONFIG.biome;
  return { civCount, biome };
}
