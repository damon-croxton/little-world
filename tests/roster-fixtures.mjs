import { updateCombatFormation } from '../src/sim/formations.js';
export { initializeSoldierPositions as positionMilitary } from '../src/sim/combat.js';
import { initializeMilitary, deployMilitary, unitStats } from '../src/sim/military.js';
import { getSoldiers, createSoldierRecords, syncSoldierCounts } from '../src/sim/soldiers.js';
import { refreshHousing, housingDemand } from '../src/sim/housing.js';

// Training/ownership fixtures explicitly supply completed quarters; they do
// not bypass the runtime housing gate by editing its derived capacity.
export function houseExistingPopulation(home, faction, spare = 24) {
  let index = 0;
  while (refreshHousing(home, faction) < housingDemand(home) + spare) {
    home.buildings.push({ id: `${home.id}:fixture-house:${index}`, kind: 'housing', progress: 1, hp: 160, maxHp: 160, x: home.x + 3 * index++, z: home.z + 16 });
  }
}

// Explicit scenario construction only. Runtime code never repairs counts into
// soldiers; these helpers give legacy test scenarios actual citizen records.
export function setMilitary(state, home, units = { infantry: 0, ranged: 0 }) {
  const faction = state.factions.find(candidate => candidate.id === home.factionId);
  return initializeMilitary(home, units, { state, faction });
}

export function recruitMilitary(state, home, units) {
  const faction = state.factions.find(candidate => candidate.id === home.factionId);
  const statsByRole = Object.fromEntries(['infantry', 'ranged'].map(role => [role, unitStats(faction, role)]));
  const records = createSoldierRecords(home, units, { state, faction, statsByRole, source: 'fixture' });
  syncSoldierCounts(state, home);
  return records;
}

export function bindArmy(state, home, group) {
  deployMilitary(state, home, group);
  // A field fixture is a deliberate scenario placement, before its first pulse.
  // Formation initialization then spreads these bodies on connected terrain.
  for (const soldier of getSoldiers(state, group)) {
    soldier.x = group.x ?? home.x ?? 0; soldier.z = group.z ?? home.z ?? 0;
    soldier.prevX = group.prevX ?? soldier.x; soldier.prevZ = group.prevZ ?? soldier.z;
  }
  updateCombatFormation(state, group, group.units, 0);
  return group;
}
