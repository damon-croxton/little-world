import { distance, emit } from '../shared.js';
import { availableMilitary, countMilitary, cancelTraining, demobilizeMilitary } from './military.js';
import { invalidateNavigation } from './navigation.js';
import { observationFor, reportObservations, sightRadius, visibleToGroup } from './knowledge.js';

// Control and biological identity are separate. Conquest changes sovereignty
// over actual places and stores; it never deletes civilians, changes species,
// creates soldiers, or teleports captured inventory to a distant capital.
export { factionController, settlementController, groupController } from './control.js';
import { factionController, settlementController, groupController } from './control.js';
export const viableArmy = group => group.kind === 'army' && !group.finished && !group.disabled && group.size >= 8 && (group.morale ?? 85) >= 30 && (group.supply ?? 100) >= 12 && group.phase !== 'retreating' && !group.surrendered;
export function sovereignHomes(state, factionId) {
  return state.settlements.filter(p => p.population > 0 && p.health > 0 && !['camp', 'ruin'].includes(p.status) && settlementController(state, p) === factionId);
}

export function occupySettlement(state, home, army) {
  if (!home || !army || army.finished || army.size <= 0 || !home.population || distance(home, army) > Math.max(24, (home.radius || 8) + 8)) return false;
  const victorId = groupController(state, army), previous = settlementController(state, home);
  if (!victorId || victorId === previous) return false;
  const victor = state.factions.find(f => f.id === victorId), native = state.factions.find(f => f.id === home.factionId);
  const surrender = countMilitary(availableMilitary(state, home));
  cancelTraining(state, home, null, 'The settlement surrendered; surviving trainees returned to civilian life');
  demobilizeMilitary(state, home, surrender);
  home.occupiedBy = victorId === home.factionId ? null : victorId;
  home.occupation = { controllerId: victorId, previousControllerId: previous, sinceTick: state.tick, byGroupId: army.id, surrenderedSoldiers: surrender };
  home.defenseMorale = 0; home.contestedUntil = state.tick; home.siege = home.siege ? { ...home.siege, active: false, endedTick: state.tick, outcome: 'occupied' } : null;
  if (home.combat) home.combat.active = false;
  home.health = Math.max(1, home.health);
  delete home.defeat;
  for (const b of home.buildings || []) if (b.kind === 'tower') { b.operational = false; b.crewAssigned = 0; }
  home.assigned ??= {}; home.assigned.towerCrew = 0;
  for (const group of state.groups) if (group.originId === home.id && group.kind === 'colonist' && !group.finished) {
    group.phase = 'returning'; group.targetX = home.x; group.targetZ = home.z; group.reason = 'The founding expedition returns to its occupied home.';
  }
  invalidateNavigation(state);
  state.stats.captures = (state.stats.captures || 0) + 1;
  state.stats.surrenders = (state.stats.surrenders || 0) + surrender;
  victor.experience.combat += 4;
  // Captured charts are already delivered historical reports, never live
  // remote scout observations or hidden positions. Their age is preserved.
  const charts = Object.values(native?.knowledge || {}).filter(k => k.kind !== 'group' && k.reportedTick != null && k.reportedTick <= state.tick && k.observedTick <= k.reportedTick && (k.reportedAtSettlementId === home.id || visibleToGroup(state, { ...home, factionId: victorId }, k, sightRadius(home)))).map(k => ({ ...k }));
  reportObservations(state, victor, [...charts, observationFor(state, victor, home)], { method: 'captured-charts', homeId: home.id });
  const present = Math.max(0, home.population - state.groups.reduce((n, g) => n + (g.originId === home.id && !g.finished ? g.size : 0), 0));
  emit(state, 'capture', `${victor.name} took control of ${home.name}. ${present} present surviving ${native?.species === 'machine' ? 'machines' : native?.species === 'hive' ? 'hive individuals' : 'people'} remain at their home; its stores are held there.`, victorId,
    { settlementId: home.id, groupId: army.id, previousControllerId: previous, occupiedBy: home.occupiedBy, surrenderedSoldiers: surrender, presentPopulation: present });
  return true;
}

export function updateConquest(state) {
  state.outcome ??= { status: 'ongoing', winnerId: null, wonAt: null };
  if (state.outcome.status === 'victory') return state.outcome;
  for (const faction of state.factions) {
    if (faction.defeatedBy || sovereignHomes(state, faction.id).length) continue;
    const homes = state.settlements.filter(p => p.factionId === faction.id && p.population > 0), held = homes.filter(p => p.occupiedBy);
    if (!held.length) continue;
    const army = state.groups.find(g => groupController(state, g) === faction.id && viableArmy(g));
    if (army) {
      // A surviving field army gets a real chance to liberate a lost home.
      if (army.phase === 'returning') {
        const target = held.slice().sort((a, b) => distance(army, a) - distance(army, b))[0];
        army.phase = 'outbound'; army.missionOrderTick = state.tick; army.intelligence = { observedTick: state.tick, reportedTick: state.tick, confidence: 1, reportMethod: 'own-home-status' }; army.targetId = target.id; army.targetX = target.x; army.targetZ = target.z; army.liberation = true;
        if (army.combat) army.combat.active = false;
        army.reason = 'The last field army is returning to liberate its occupied home.';
      }
      continue;
    }
    const controllers = new Map();
    for (const home of held) { const id = settlementController(state, home); controllers.set(id, (controllers.get(id) || 0) + home.population); }
    const winner = [...controllers].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
    if (!winner || winner === faction.id) continue;
    faction.defeatedBy = winner; faction.defeatedAt = state.tick; faction.status = 'capitulated'; faction.researchWorkers = 0; faction.researchHomeId = null;
    faction.intent = 'Capitulated after losing its independent settlements and viable field armies.';
    for (const group of state.groups) if ((group.commandFactionId || group.factionId) === faction.id && group.kind === 'army' && !group.finished) {
      group.surrendered = true; group.phase = 'returning'; if (group.combat) group.combat.active = false;
      const home = state.settlements.find(p => p.id === group.originId);
      if (home) { group.targetX = home.x; group.targetZ = home.z; }
      group.reason = 'The surviving soldiers are physically returning after their civilisation capitulated.';
    }
    state.stats.capitulations = (state.stats.capitulations || 0) + 1;
    emit(state, 'capitulation', `${faction.name} capitulated. Its surviving inhabitants remain, while ${state.factions.find(f => f.id === winner)?.name} controls its occupied territory.`, winner, { defeatedId: faction.id, controllerId: winner });
  }
  const sovereigns = state.factions.filter(f => !f.defeatedBy && (sovereignHomes(state, f.id).length || state.groups.some(g => groupController(state, g) === f.id && viableArmy(g))));
  if (sovereigns.length === 1 && state.factions.length > 1 && state.settlements.every(p => p.population <= 0 || ['camp', 'ruin'].includes(p.status) || settlementController(state, p) === sovereigns[0].id)) {
    const winner = sovereigns[0];
    state.outcome = { status: 'victory', winnerId: winner.id, wonAt: state.time ?? state.tick, tick: state.tick, reason: 'All remaining independent settlements and viable opposing armies have been defeated.' };
    emit(state, 'victory', `${winner.name} controls the world. Military conquest ended the last independent opposition; surviving inhabitants and held stores remain in their actual settlements.`, winner.id, { winnerId: winner.id, wonAt: state.outcome.wonAt });
  }
  return state.outcome;
}
