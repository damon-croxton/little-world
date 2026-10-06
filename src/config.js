// A seed controls geography; settings only choose how many civilizations use it.
// Six remains supported for existing scenarios, while ordinary worlds use 3–5.
export const MIN_CIV_COUNT = 3;
export const MAX_CIV_COUNT = 6;
export const DEFAULT_CONFIG = Object.freeze({ civCount: 4 });

export function normalizeConfig(options = {}) {
  const value = Number(options?.civCount ?? options?.factionCount ?? DEFAULT_CONFIG.civCount);
  const civCount = Number.isFinite(value) ? Math.max(MIN_CIV_COUNT, Math.min(MAX_CIV_COUNT, Math.round(value))) : DEFAULT_CONFIG.civCount;
  return { civCount };
}
