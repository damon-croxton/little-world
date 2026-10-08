import { matchValue } from '../config.js';

// These affect commitment timing and labor allocation, never combat damage,
// scouting knowledge, route safety, construction costs or the paid cargo gate.
export function expansionRequirements(owner) {
  const focus = matchValue(owner, 'economyFocus');
  return { population: Math.round(120 / Math.sqrt(focus)), cooldown: Math.round(120 / focus) };
}

export function offensiveCooldown(faction, reinforcing = false) {
  const base = reinforcing ? 12 : 70 + Math.round((1 - faction.traits.aggression) * 55);
  return Math.max(8, Math.round(base / matchValue(faction, 'aggressionScale')));
}
