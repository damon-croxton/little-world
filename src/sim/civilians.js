import { ledgerAdd, RESOURCES } from './economy.js';

// A field crew has one rendered representative, but each living civilian has
// this much health. Damage is applied once per real weapon strike. The remainder
// records the wounded member rather than turning an N-person badge into one HP.
export const CIVILIAN_HEALTH = 32;

export function civilianHealth(group) {
  return Math.max(0, group.size * CIVILIAN_HEALTH - (group.civilianWounds || 0));
}

export function applyCivilianDamage(state, group, damage) {
  const home = state.settlements.find(town => town.id === group.originId);
  if (!home || group.finished || group.kind !== 'worker' || !(group.size > 0) || !(damage > 0)) return { damage: 0, deaths: 0 };
  const applied = Math.min(civilianHealth(group), damage), wounds = (group.civilianWounds || 0) + applied;
  const deaths = Math.min(group.size, Math.floor((wounds + 1e-9) / CIVILIAN_HEALTH));
  group.civilianWounds = Math.max(0, wounds - deaths * CIVILIAN_HEALTH);
  if (deaths) {
    const survivors = (group.size - deaths) / group.size;
    for (const key of RESOURCES) {
      const lost = (group.carrying?.[key] || 0) * (1 - survivors);
      if (lost) { group.carrying[key] -= lost; ledgerAdd(state, key, 'lost', lost); }
    }
    if (group.capacity != null) group.capacity *= survivors;
    if (group.cargoCapacity != null) group.cargoCapacity *= survivors;
    group.size -= deaths; home.population -= deaths;
    home.workers = Math.max(0, home.population - home.soldiers);
    state.stats.deaths = (state.stats.deaths || 0) + deaths;
    state.stats.combatDeaths = (state.stats.combatDeaths || 0) + deaths;
    state.stats.workerCombatDeaths = (state.stats.workerCombatDeaths || 0) + deaths;
    if (!group.size) { group.finished = true; group.civilianWounds = 0; }
  }
  return { damage: applied, deaths };
}
