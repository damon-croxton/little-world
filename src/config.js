// Seed, civilisation count and one whole-world biome define a repeatable world.
// Six remains supported for existing scenarios, while ordinary worlds use 3–5.
export const MIN_CIV_COUNT = 3;
export const MAX_CIV_COUNT = 6;
export const BIOME_CHOICES = Object.freeze(['random', 'meadow', 'desert', 'alien']);
export const BIOME_LABELS = Object.freeze({ random: 'Seed choice', meadow: 'Grassland', desert: 'Desert', alien: 'Alien meadow' });
export const MATCH_SETTINGS_VERSION = 1;
export const MATCH_SETTINGS = Object.freeze({
  resourceScale: { label: 'Resource reserves', min: .5, max: 2, step: .05, default: 1.25,
    help: 'More reserves make deposits last longer. Harvest speed and regeneration stay the same.' },
  upkeepScale: { label: 'Upkeep & hardship', min: .5, max: 1.5, step: .05, default: .85,
    help: 'Scales daily needs, journey rations and losses from starvation. Combat damage stays the same.' },
  aggressionScale: { label: 'Aggression', min: .5, max: 1.5, step: .05, default: 1,
    help: 'Higher values send offensive campaigns and reinforcements more often. Personalities and local threat checks still apply.' },
  economyFocus: { label: 'Economic focus', min: .75, max: 1.5, step: .05, default: 1.15,
    help: 'Higher values retain more civilian workers and consider outposts earlier. Founding still needs supplies, surveyed resources and a safe route.' },
});
export const DEFAULT_CONFIG = Object.freeze({ civCount: 4, biome: 'random', matchVersion: MATCH_SETTINGS_VERSION,
  ...Object.fromEntries(Object.entries(MATCH_SETTINGS).map(([key, setting]) => [key, setting.default])) });

export function matchValue(owner, key) {
  return owner?.config?.[key] ?? owner?.matchSettings?.[key] ?? owner?.[key] ?? DEFAULT_CONFIG[key];
}

export function normalizeConfig(options = {}) {
  const value = Number(options?.civCount ?? options?.factionCount ?? DEFAULT_CONFIG.civCount);
  const civCount = Number.isFinite(value) ? Math.max(MIN_CIV_COUNT, Math.min(MAX_CIV_COUNT, Math.round(value))) : DEFAULT_CONFIG.civCount;
  const biome = BIOME_CHOICES.includes(options?.biome) ? options.biome : DEFAULT_CONFIG.biome;
  const settings = Object.fromEntries(Object.entries(MATCH_SETTINGS).map(([key, spec]) => {
    const raw = options?.[key], value = raw == null || raw === '' || typeof raw === 'boolean' ? NaN : Number(raw);
    return [key, Number.isFinite(value) ? +Math.max(spec.min, Math.min(spec.max, Math.round(value / spec.step) * spec.step)).toFixed(2) : spec.default];
  }));
  return { civCount, biome, matchVersion: MATCH_SETTINGS_VERSION, ...settings };
}
