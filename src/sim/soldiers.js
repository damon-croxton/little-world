import { RESOURCES, ledgerAdd } from './economy.js';

// Settlements retain their citizens' military records even when those citizens
// are away, dead, or demobilized. Groups reference these records; they never own
// a second copy of a soldier's health, position, or weapon clock.
export const SOLDIER_ROLES = Object.freeze(['infantry', 'ranged']);
const integer = value => Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
export const isServingSoldier = soldier => soldier?.status === 'serving' && soldier.alive !== false && soldier.hp > 0;
const indices = new WeakMap();
export function touchSoldiers(state) {
  if (state) state.soldierRevision = (state.soldierRevision || 0) + 1;
}

function soldierIndex(state) {
  const homes = state.settlements || [];
  let cached = indices.get(state);
  if (!cached || cached.homes !== homes || cached.rosters.length !== homes.length || homes.some((home, index) => cached.rosters[index]?.roster !== home.soldierRoster || cached.rosters[index]?.length !== home.soldierRoster?.length)) {
    cached = { homes, rosters: homes.map(home => ({ roster: home.soldierRoster, length: home.soldierRoster?.length })), byId: new Map() };
    for (const home of homes) for (const soldier of home.soldierRoster || []) cached.byId.set(soldier.id, soldier);
    indices.set(state, cached);
  }
  return cached.byId;
}

export function getSoldier(state, id) {
  return soldierIndex(state).get(typeof id === 'object' ? id?.id : id) || null;
}

// A scoped visual group can carry an explicitly projected roster because its
// origin settlement may be outside the observer's knowledge. This is read-only;
// simulation groups use soldierIds pointing into the native settlement roster.
export function getSoldiers(state, entity, options = {}) {
  if (!entity) return [];
  const home = 'population' in entity;
  let records;
  if (home) records = (entity.soldierRoster || []).filter(soldier => soldier.groupId == null);
  else if (Array.isArray(entity.soldierRoster)) records = entity.soldierRoster;
  else {
    const index = soldierIndex(state);
    records = (entity.soldierIds || []).map(id => index.get(id)).filter(soldier => soldier && soldier.groupId === entity.id);
  }
  if (!options.includeInactive) records = records.filter(isServingSoldier);
  if (home && options.excludeTowerCrew) {
    const hasAssignedCrew = (entity.buildings || []).some(building => Array.isArray(building.crewSoldierIds)) || records.some(soldier => soldier.towerId);
    let remaining = hasAssignedCrew ? 0 : integer(entity.assigned?.towerCrew);
    records = records.filter(soldier => !soldier.towerId && (soldier.role !== 'ranged' || !remaining || (--remaining, false)));
  }
  return records;
}

export function soldierCounts(records) {
  const counts = { infantry: 0, ranged: 0 };
  for (const soldier of records) if (isServingSoldier(soldier) && soldier.role in counts) counts[soldier.role]++;
  return counts;
}

export function syncGroupSoldiers(state, group) {
  group.units = soldierCounts(getSoldiers(state, group));
  group.size = group.units.infantry + group.units.ranged;
  return group.units;
}

export function syncSoldierCounts(state, home) {
  home.military = soldierCounts(home.soldierRoster || []);
  home.soldiers = home.military.infantry + home.military.ranged;
  home.workers = Math.max(0, integer(home.population) - home.soldiers);
  home.trainingQueue ||= [];
  for (const group of state?.groups || []) if (group.kind === 'army' && group.originId === home.id && !group.militaryReturned && !group.finished) syncGroupSoldiers(state, group);
  return home.military;
}

// Called only by explicit initialization and completed, funded training. Count
// synchronization and rendering must never call this to repair an aggregate.
export function createSoldierRecords(home, units, options = {}) {
  const state = options.state, faction = options.faction;
  home.soldierRoster ||= [];
  home.nextSoldierId = Math.max(1, integer(home.nextSoldierId));
  const species = faction?.species || home.nativeSpecies || 'human';
  const created = [];
  for (const role of SOLDIER_ROLES) for (let index = 0; index < integer(units?.[role]); index++) {
    const spec = options.statsByRole?.[role];
    if (!spec) throw new Error(`Missing ${species}/${role} soldier statistics`);
    const soldier = {
      id: `${home.id}:soldier:${home.nextSoldierId++}`, originId: home.id,
      factionId: home.factionId, nativeFactionId: home.factionId,
      commandFactionId: faction?.id || home.factionId, species, role,
      status: 'serving', alive: true, groupId: null, hp: spec.health, maxHp: spec.health,
      cooldown: 0, attackReadyAt: 0, targetId: null,
      x: home.x ?? 0, z: home.z ?? 0, prevX: home.x ?? 0, prevZ: home.z ?? 0,
      yaw: 0, prevYaw: 0, positioned: false,
      createdTick: state?.tick ?? 0, createdTime: state?.time ?? state?.tick ?? 0,
      source: options.source || 'initial', trainingJobId: options.trainingJobId || null,
      stats: { ...spec, cost: { ...spec.cost } },
    };
    home.soldierRoster.push(soldier); created.push(soldier);
  }
  if (created.length) touchSoldiers(state);
  return created;
}

function refreshLabor(state, home) {
  syncSoldierCounts(state, home);
  const away = (state.groups || []).reduce((sum, group) => sum + (group.originId === home.id && group.kind !== 'army' && !group.finished ? integer(group.size) : 0), 0);
  const assigned = home.assigned || (home.assigned = {});
  assigned.training = (home.trainingQueue || []).reduce((sum, job) => sum + integer(job.size), 0);
  home.availableWorkers = Math.max(0, home.population - home.soldiers - away - assigned.training - integer(assigned.infrastructure) - integer(assigned.researchers) - integer(assigned.construction));
}

export function killSoldier(state, soldierOrId, details = {}) {
  // Resolve canonical identity even when a caller passes a visual copy.
  const soldier = getSoldier(state, soldierOrId);
  if (!soldier || soldier.status !== 'serving' || soldier.alive === false) return false;
  const home = state.settlements.find(candidate => candidate.id === soldier.originId);
  if (!home) return false;
  const group = soldier.groupId && state.groups?.find(candidate => candidate.id === soldier.groupId);
  if (group) {
    const size = getSoldiers(state, group, { includeInactive: true }).filter(body => body.status === 'serving' && body.alive !== false).length;
    const fraction = 1 / Math.max(1, size);
    for (const kind of RESOURCES) {
      const cargo = (group.carrying?.[kind] || 0) * fraction;
      if (group.carrying) group.carrying[kind] -= cargo;
      ledgerAdd(state, kind, 'lost', cargo);
    }
    if (group.capacity != null) group.capacity *= 1 - fraction;
    if (group.cargoCapacity != null) group.cargoCapacity *= 1 - fraction;
  }
  soldier.hp = 0; soldier.alive = false; soldier.status = 'dead';
  soldier.diedTick = state.tick; soldier.diedTime = state.time ?? state.tick;
  soldier.deathCause = details.cause || 'military';
  soldier.killedById = details.sourceSoldierId || details.sourceId || null;
  touchSoldiers(state);
  home.population -= 1;
  state.stats ||= {};
  state.stats.deaths = (state.stats.deaths || 0) + 1;
  state.stats.militaryDeaths = (state.stats.militaryDeaths || 0) + 1;
  if (group) { syncGroupSoldiers(state, group); if (!group.size) group.finished = true; }
  refreshLabor(state, home);
  return true;
}

// Damage is already resolved for armor by the combat caller. A late projectile
// keeps its exact target ID; a dead or demobilized citizen cannot be hit again.
export function applySoldierDamage(state, soldierOrId, damage, details = {}) {
  const soldier = getSoldier(state, soldierOrId);
  if (!isServingSoldier(soldier) || !(damage > 0) || !Number.isFinite(damage)) return { damage: 0, killed: false, soldier };
  const dealt = Math.min(soldier.hp, damage);
  soldier.hp -= dealt;
  soldier.lastHitTime = state.time ?? state.tick;
  touchSoldiers(state);
  const killed = soldier.hp <= 0 && killSoldier(state, soldier, details);
  return { damage: dealt, killed, soldier };
}

export function militaryAtHome(state, home, group) {
  if (!home || !group) return false;
  const soldiers = getSoldiers(state, group);
  if (!soldiers.length) return false;
  const radius = Math.max(3, home.radius || 8);
  return soldiers.every(soldier => soldier.positioned && Math.hypot(soldier.x - home.x, soldier.z - home.z) <= radius);
}
