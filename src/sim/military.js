import { settlementController } from './control.js';
import { clamp, emit } from '../shared.js';
import { RESOURCES, SURVIVAL_NEEDS, canAfford, spend } from './economy.js';
import { SOLDIER_ROLES, createSoldierRecords, getSoldiers, soldierCounts, syncSoldierCounts, syncGroupSoldiers, killSoldier, touchSoldiers } from './soldiers.js';
export { getSoldiers, getSoldier, applySoldierDamage, militaryAtHome } from './soldiers.js';

// Every military count is a subset of an existing settlement population. Home
// totals include expeditions; deployment moves a role, never creates a body.
export const MILITARY_ROLES = SOLDIER_ROLES;
export const emptyMilitary = () => ({ infantry: 0, ranged: 0 });
const integer = value => Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
export const countMilitary = units => MILITARY_ROLES.reduce((sum, role) => sum + integer(units?.[role]), 0);
const isActive = home => home.population > 0 && !['camp', 'ruin'].includes(home.status);
const speciesOf = faction => faction?.species || 'human';

export const MILITARY_BUILDINGS = Object.freeze({
  barracks: { species: 'human', role: 'infantry', name: 'Muster Hall', cost: { materials: 65, energy: 12 } },
  range: { species: 'human', role: 'ranged', name: 'Field Range', cost: { materials: 75, energy: 18 } },
  fabricator: { species: 'machine', role: 'infantry', name: 'Frame Forge', cost: { materials: 70, energy: 24 } },
  launcher: { species: 'machine', role: 'ranged', name: 'Arc Foundry', cost: { materials: 85, energy: 32 } },
  brooder: { species: 'hive', role: 'infantry', name: 'Guard Cradle', cost: { materials: 55, food: 25, energy: 8 } },
  spitter: { species: 'hive', role: 'ranged', name: 'Quill Nursery', cost: { materials: 65, food: 30, energy: 12 } },
});
export const MILITARY_UNITS = Object.freeze({
  human: {
    infantry: { name: 'Vanguard', building: 'barracks', cost: { food: 2.4, water: .6, energy: .6, materials: 2.8 }, trainingCycles: 12, health: 100, damage: 11, range: 1.8, speed: 3.1, armor: .12, cooldown: 1.15 },
    ranged: { name: 'Trail archer', building: 'range', cost: { food: 2, water: .6, energy: 1, materials: 3.8 }, trainingCycles: 18, health: 75, damage: 8, range: 9, speed: 2.85, armor: .03, cooldown: 1.8 },
  },
  machine: {
    infantry: { name: 'Brace walker', building: 'fabricator', cost: { water: .5, energy: 4.4, materials: 3.5 }, trainingCycles: 15, health: 120, damage: 12, range: 1.9, speed: 2.7, armor: .2, cooldown: 1.35 },
    ranged: { name: 'Arc caster', building: 'launcher', cost: { water: .7, energy: 5.5, materials: 4.2 }, trainingCycles: 20, health: 85, damage: 10, range: 10, speed: 2.5, armor: .08, cooldown: 2.05 },
  },
  hive: {
    infantry: { name: 'Shellguard', building: 'brooder', cost: { food: 3.5, water: .8, energy: .2, materials: 1.8 }, trainingCycles: 10, health: 90, damage: 9, range: 1.65, speed: 3.4, armor: .1, cooldown: 1 },
    ranged: { name: 'Quill bearer', building: 'spitter', cost: { food: 4.2, water: 1, energy: .4, materials: 2.7 }, trainingCycles: 16, health: 70, damage: 7, range: 8.5, speed: 3, armor: .02, cooldown: 1.55 },
  },
});

export function unitStats(species, role, faction = null) {
  if (species && typeof species === 'object') { faction = species; species = faction.species; }
  const base = (MILITARY_UNITS[species] || MILITARY_UNITS.human)[role];
  if (!base) return null;
  if (!faction?.advantages) return base;
  const advantages = faction.advantages;
  return { ...base, damage: base.damage * (advantages[`${role}Damage`] || 1),
    range: base.range * (role === 'ranged' ? advantages.rangedRange || 1 : 1),
    trainingCycles: Math.max(4, Math.ceil(base.trainingCycles / (advantages.trainingRate || 1))) };
}

export function initializeMilitary(home, units = emptyMilitary(), options = {}) {
  const faction = options.faction || options.state?.factions?.find(candidate => candidate.id === home.factionId) || { id: home.factionId, species: home.nativeSpecies || 'human' };
  // Explicit setup is the sole reset operation. Runtime synchronization never
  // reads an edited aggregate as permission to create replacement citizens.
  home.soldierRoster = [];
  touchSoldiers(options.state);
  home.militaryRosterVersion = 1;
  home.nativeSpecies = faction.species || 'human';
  createSoldierRecords(home, units, { ...options, faction,
    statsByRole: Object.fromEntries(MILITARY_ROLES.map(role => [role, unitStats(home.nativeSpecies, role, faction)])) });
  return syncSoldierCounts(options.state, home);
}

// This derives the legacy aggregate only. It deliberately does not repair an
// impossible census by minting military roles or quietly deleting citizens.
export function syncMilitary(state, home) {
  return syncSoldierCounts(state, home);
}

export function deployedMilitary(state, home) {
  return soldierCounts((home.soldierRoster || []).filter(soldier => soldier.groupId != null));
}

export function availableMilitary(state, home) {
  syncMilitary(state, home);
  return soldierCounts(getSoldiers(state, home));
}

// Wounded returnees remain serving members of the home garrison and census.
// A new expedition can only order bodies able to follow its outward march;
// the individual planner otherwise preserves their homeward withdrawal.
const expeditionSoldiers = (state, home) => getSoldiers(state, home, { excludeTowerCrew: true })
  .filter(soldier => !soldier.withdrawing && soldier.hp / soldier.maxHp > (soldier.role === 'ranged' ? .38 : .30));

function splitUnits(available, requested, preferredRole) {
  const result = emptyMilitary(), total = countMilitary(available);
  let count = Math.min(integer(requested), total);
  if (preferredRole && MILITARY_ROLES.includes(preferredRole)) {
    result[preferredRole] = Math.min(count, integer(available[preferredRole]));
    return result;
  }
  if (!count) return result;
  // Largest remainder, with stable role ordering, preserves composition exactly.
  const shares = MILITARY_ROLES.map(role => ({ role, exact: count * integer(available[role]) / total }));
  for (const share of shares) result[share.role] = Math.floor(share.exact);
  let remainder = count - countMilitary(result);
  shares.sort((a, b) => (b.exact % 1) - (a.exact % 1) || MILITARY_ROLES.indexOf(a.role) - MILITARY_ROLES.indexOf(b.role));
  for (const share of shares) if (remainder && result[share.role] < available[share.role]) { result[share.role]++; remainder--; }
  return result;
}

// Register the returned composition on a new army immediately after this call.
// The unchanged home total already includes these soldiers throughout travel.
export function allocateMilitary(state, home, size) {
  syncMilitary(state, home);
  const available = soldierCounts(expeditionSoldiers(state, home));
  return splitUnits(available, size);
}

// Allocation is a composition quote. Deployment claims actual, disjoint IDs
// atomically before the newly constructed group is added to the world.
export function deployMilitary(state, home, group) {
  if (!home || !group || group.kind !== 'army' || group.originId !== home.id || group.militaryReturned || group.finished) return 0;
  if (Array.isArray(group.soldierIds)) { syncGroupSoldiers(state, group); return group.size; }
  const available = expeditionSoldiers(state, home);
  const requested = group.units || splitUnits(soldierCounts(available), group.size);
  const selected = MILITARY_ROLES.flatMap(role => available.filter(soldier => soldier.role === role).slice(0, integer(requested[role])));
  group.soldierIds = selected.map(soldier => soldier.id);
  for (const soldier of selected) {
    soldier.groupId = group.id;
    soldier.commandFactionId = group.commandFactionId || group.factionId || home.factionId;
  }
  if (selected.length) touchSoldiers(state);
  syncGroupSoldiers(state, group);
  refreshReservations(state, home);
  return group.size;
}

export function trainingCount(home) {
  return (home.trainingQueue || []).reduce((sum, job) => sum + integer(job.size), 0);
}

function availableCivilians(state, home) {
  const away = (state.groups || []).reduce((sum, group) => sum + (group.originId === home.id && group.kind !== 'army' && !group.finished ? integer(group.size) : 0), 0);
  const assigned = home.assigned || {};
  return Math.max(0, home.population - home.soldiers - away - trainingCount(home) - integer(assigned.infrastructure) - integer(assigned.researchers) - integer(assigned.construction));
}

function refreshReservations(state, home) {
  syncMilitary(state, home);
  home.assigned ||= {};
  home.assigned.training = trainingCount(home);
  home.availableWorkers = availableCivilians(state, home);
}

export function trainingCost(faction, role, size = 1) {
  const spec = unitStats(speciesOf(faction), role);
  if (!spec) return null;
  const efficiency = clamp(faction?.modifiers?.materialEfficiency ?? 1, .25, 4);
  return Object.fromEntries(RESOURCES.map(kind => [kind, (spec.cost[kind] || 0) * integer(size) * (faction?.advantages?.unitCost || 1) / (kind === 'materials' ? efficiency : 1)]));
}

export function trainingReserves(home, faction, cycles = 12) {
  const needs = SURVIVAL_NEEDS[speciesOf(faction)] || SURVIVAL_NEEDS.human;
  return Object.fromEntries(RESOURCES.map(kind => [kind, kind === 'materials' ? 12 : needs[kind] * home.population * cycles]));
}

// A sovereign whose native capitals are all occupied may retain one physical
// command base in a held foreign settlement. Citizenship/species never change;
// only the political command of paid local auxiliaries is explicit.
export function commandFactionForHome(state, home) {
  if (!isActive(home) || !(home.health > 0)) return null;
  const controllerId = settlementController(state, home);
  const controller = state.factions.find(faction => faction.id === controllerId);
  if (!controller || controller.defeatedBy) return null;
  if (home.factionId === controllerId && !home.occupiedBy) return controllerId;
  if (state.settlements.some(candidate => isActive(candidate) && candidate.health > 0 && candidate.factionId === controllerId && !candidate.occupiedBy)) return null;
  const held = state.settlements.filter(candidate => isActive(candidate) && candidate.health > 0 && settlementController(state, candidate) === controllerId);
  const producers = candidate => candidate.buildings.filter(building => MILITARY_BUILDINGS[building.kind] && building.progress >= 1 && !building.destroyed && (building.hp == null || building.hp > 0)).length;
  held.sort((a, b) => producers(b) - producers(a) || b.population - a.population || a.id.localeCompare(b.id));
  return held[0]?.id === home.id ? controllerId : null;
}

export function refreshExileBases(state) {
  for (const home of state.settlements) {
    const commanderId = commandFactionForHome(state, home);
    home.exileBaseFor = commanderId && commanderId !== home.factionId ? commanderId : null;
  }
}

export function militaryContext(state, home, fallback = null) {
  const commandId = commandFactionForHome(state, home);
  if (!commandId) return null;
  const native = state.factions.find(faction => faction.id === home.factionId) || fallback;
  const commander = state.factions.find(faction => faction.id === commandId);
  if (!native || !commander) return null;
  return { ...native, id: commander.id, traits: commander.traits, advantages: commander.advantages, defeatedBy: null };
}

export function queueTraining(state, home, faction, role, size = 1, options = {}) {
  syncMilitary(state, home);
  faction = militaryContext(state, home, faction);
  if (!faction) return null;
  const exile = faction.id !== home.factionId;
  const spec = unitStats(speciesOf(faction), role, faction), count = integer(size);
  if (!spec || !count || !isActive(home) || (home.contestedUntil ?? -1) >= state.tick || home.health < (exile ? 1 : 45)) return null;
  const building = home.buildings.find(b => b.kind === spec.building && b.progress >= 1 && !b.destroyed && (b.hp == null || b.hp > 0) && !(home.trainingQueue || []).some(job => job.buildingId === b.id));
  if (!building || count > 6 || availableCivilians(state, home) < count + (options.civilianReserve ?? 12)) return null;
  const cost = trainingCost(faction, role, count);
  if (!canAfford(home, cost, options.reserves ?? trainingReserves(home, faction))) return null;
  spend(state, home, cost, 'training');
  const job = { id: `q${state.nextId++}`, buildingId: building.id, commandFactionId: faction.id, nativeFactionId: home.factionId, role, size: count, cost,
    startedTick: state.tick, lastAdvancedTick: state.tick, duration: spec.trainingCycles, remaining: spec.trainingCycles, progress: 0 };
  home.trainingQueue.push(job);
  refreshReservations(state, home);
  state.stats.trainingStarted = (state.stats.trainingStarted || 0) + count;
  home.lastTrainingOrder = { id: job.id, commandFactionId: faction.id, nativeFactionId: home.factionId, role, size: count, tick: state.tick, buildingId: building.id };
  return job;
}

// Equipment and provisions were committed when the order was placed. A lost
// producer or cancelled course releases surviving trainees, but creates no
// refund resources and cannot later finish the already removed order.
export function cancelTraining(state, home, jobId = null, reason = 'Training cancelled') {
  const cancelled = (home.trainingQueue || []).filter(job => jobId == null || job.id === jobId);
  if (!cancelled.length) return 0;
  const ids = new Set(cancelled.map(job => job.id));
  home.trainingQueue = home.trainingQueue.filter(job => !ids.has(job.id));
  const count = cancelled.reduce((sum, job) => sum + job.size, 0);
  home.lastTrainingCancelled = { tick: state.tick, reason, size: count, ids: [...ids] };
  state.stats.trainingCancelled = (state.stats.trainingCancelled || 0) + count;
  refreshReservations(state, home);
  return count;
}

export function advanceTraining(state, home, faction) {
  syncMilitary(state, home);
  faction = militaryContext(state, home, faction);
  if (!faction) { cancelTraining(state, home, null, 'The settlement cannot operate its training buildings'); return 0; }
  const exile = faction.id !== home.factionId;
  let completed = 0;
  for (const job of [...home.trainingQueue]) {
    if ((job.commandFactionId || home.factionId) !== faction.id) { cancelTraining(state, home, job.id, 'Political command changed before the course finished'); continue; }
    const building = home.buildings.find(b => b.id === job.buildingId);
    const spec = unitStats(speciesOf(faction), job.role);
    if (!building || building.destroyed || (building.hp != null && building.hp <= 0) || building.progress < 1 || building.kind !== spec?.building) {
      cancelTraining(state, home, job.id, 'The training building was lost or is unfinished'); continue;
    }
    const elapsed = Math.max(0, state.tick - job.lastAdvancedTick);
    job.lastAdvancedTick = state.tick;
    // Training pauses when a siege, hunger or damage prevents safe instruction.
    if (!elapsed || (home.contestedUntil ?? -1) >= state.tick || home.health < (exile ? 1 : 35) || home.wellbeing < .85) continue;
    job.remaining = Math.max(0, job.remaining - elapsed);
    job.progress = 1 - job.remaining / job.duration;
    if (job.remaining > 0) continue;
    home.trainingQueue = home.trainingQueue.filter(candidate => candidate.id !== job.id);
    createSoldierRecords(home, { [job.role]: job.size }, { state, faction, source: 'training', trainingJobId: job.id,
      statsByRole: { [job.role]: unitStats(speciesOf(faction), job.role, faction) } });
    completed += job.size;
    state.stats.trained = (state.stats.trained || 0) + job.size;
    state.stats[`${job.role}Trained`] = (state.stats[`${job.role}Trained`] || 0) + job.size;
    home.lastTraining = { id: job.id, commandFactionId: faction.id, nativeFactionId: home.factionId, role: job.role, size: job.size, buildingId: building.id, tick: state.tick, startedTick: job.startedTick };
    if (state.tick - (home.lastTrainingEvent ?? -50) >= 45) {
      emit(state, 'training', `${home.name} trained ${job.size} ${spec.name.toLowerCase()}${job.size === 1 ? '' : 's'} in its ${MILITARY_BUILDINGS[building.kind].name}; existing citizens completed their funded course.`, faction.id, { settlementId: home.id, buildingId: building.id, role: job.role, trained: job.size });
      home.lastTrainingEvent = state.tick;
    }
  }
  refreshReservations(state, home);
  return completed;
}

export function militaryTarget(home, faction) {
  const share = clamp(home.militaryTarget ?? (.28 + (faction.traits?.aggression || 0) * .10), .12, .40);
  return Math.min(Math.floor(home.population * share), Math.max(0, home.population - 24));
}

export function militaryBuildingPlan(state, home, faction) {
  faction = militaryContext(state, home, faction);
  if (!faction || state.tick < 12 || home.population < 55 || home.health < (faction.id !== home.factionId ? 1 : 60) || home.shortageDays > 0) return null;
  const specs = MILITARY_UNITS[speciesOf(faction)] || MILITARY_UNITS.human;
  // Both first producers are useful even before population growth increases the
  // military target: initial militia do not count as free production capacity.
  for (const role of MILITARY_ROLES) if (!home.buildings.some(b => b.kind === specs[role].building && !b.destroyed && (b.hp == null || b.hp > 0))) return specs[role].building;
  const desired = militaryTarget(home, faction), queued = trainingCount(home);
  if (desired > 70 && home.soldiers + queued < desired * .75) {
    for (const role of MILITARY_ROLES) if (home.buildings.filter(b => b.kind === specs[role].building && !b.destroyed && (b.hp == null || b.hp > 0)).length < Math.min(3, Math.ceil(desired / 100))) return specs[role].building;
  }
  return null;
}

export function planTraining(state, home, faction) {
  faction = militaryContext(state, home, faction);
  if (!faction || state.tick % 4 || home.shortageDays > 0 || home.health < (faction.id !== home.factionId ? 1 : 60)) return;
  syncMilitary(state, home);
  const desired = militaryTarget(home, faction), queued = trainingCount(home);
  if (home.soldiers > desired + 4) demobilizeMilitary(state, home, Math.min(3, home.soldiers - desired));
  const remaining = desired - home.soldiers - queued;
  if (remaining <= 0) return;
  const desiredRanged = Math.round(desired * .36);
  const counts = { ...home.military };
  for (const job of home.trainingQueue) counts[job.role] += job.size;
  const priorities = counts.ranged < desiredRanged ? ['ranged', 'infantry'] : ['infantry', 'ranged'];
  let open = remaining;
  for (const role of priorities) {
    const target = role === 'ranged' ? desiredRanged : desired - desiredRanged;
    const count = Math.min(6, open, Math.max(0, target - counts[role]), Math.max(0, availableCivilians(state, home) - 12));
    if (count && queueTraining(state, home, faction, role, count)) open -= count;
  }
}

export function demobilizeMilitary(state, home, amount, options = {}) {
  const ids = options.soldierIds ? new Set(options.soldierIds) : null;
  const available = getSoldiers(state, home).filter(soldier => !ids || ids.has(soldier.id));
  const removed = splitUnits(soldierCounts(available), amount);
  for (const role of MILITARY_ROLES) for (const soldier of available.filter(candidate => candidate.role === role).slice(0, removed[role])) {
    soldier.status = 'demobilized'; soldier.demobilizedTick = state.tick;
    soldier.demobilizedTime = state.time ?? state.tick;
    soldier.towerId = null;
  }
  if (countMilitary(removed)) touchSoldiers(state);
  refreshReservations(state, home);
  return countMilitary(removed);
}

export function applyMilitaryCasualties(state, home, group, amount, options = {}) {
  if (!home || (group && (group.finished || group.militaryReturned))) return 0;
  syncMilitary(state, home);
  const ids = options.soldierIds ? new Set(options.soldierIds) : null;
  const available = getSoldiers(state, group || home).filter(soldier => !ids || ids.has(soldier.id));
  const lost = splitUnits(soldierCounts(available), amount, options.role);
  let count = 0;
  for (const role of MILITARY_ROLES) for (const soldier of available.filter(candidate => candidate.role === role).slice(0, lost[role])) {
    if (killSoldier(state, soldier, options)) count++;
  }
  refreshReservations(state, home);
  return count;
}

export function returnMilitary(state, home, group) {
  if (!home || !group || group.militaryReturned) return false;
  for (const soldier of getSoldiers(state, group)) soldier.groupId = null;
  touchSoldiers(state);
  group.militaryReturned = true;
  group.finished = true;
  refreshReservations(state, home);
  return true;
}

// Scarcity first kills actual civilians present, including trainees if no other
// civilian survives. Only remaining home garrison can be lost after that; away
// groups remain protected from a second, settlement-side mortality debit.
export function applyHomeCasualties(state, home, amount) {
  syncMilitary(state, home);
  const awayCivilians = (state.groups || []).reduce((sum, group) => sum + (group.originId === home.id && group.kind !== 'army' && !group.finished ? integer(group.size) : 0), 0);
  const civilianPresent = Math.max(0, home.population - home.soldiers - awayCivilians);
  const civiliansLost = Math.min(integer(amount), civilianPresent);
  const civilianSurvivors = civilianPresent - civiliansLost;
  // Cancel newest courses until all reserved trainees have surviving bodies.
  while (trainingCount(home) > civilianSurvivors && home.trainingQueue.length) {
    cancelTraining(state, home, home.trainingQueue.at(-1).id, 'Scarcity reduced the available civilian population');
  }
  home.population -= civiliansLost;
  state.stats.deaths += civiliansLost;
  const militaryLost = applyMilitaryCasualties(state, home, null, integer(amount) - civiliansLost);
  refreshReservations(state, home);
  return civiliansLost + militaryLost;
}
