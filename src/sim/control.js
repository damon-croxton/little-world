// Pure sovereignty lookup shared by movement, sight, economy and combat.
export function factionController(state, factionOrId) {
  let id = typeof factionOrId === 'string' ? factionOrId : factionOrId?.id;
  const visited = new Set();
  while (id && !visited.has(id)) {
    visited.add(id);
    const next = state.factions.find(f => f.id === id)?.defeatedBy;
    if (!next || next === id) break;
    id = next;
  }
  return id;
}
export function settlementController(state, home) {
  return factionController(state, home.occupiedBy || home.factionId);
}

// Native identity owns the demographic ledger and body shape; political command
// owns orders, diplomacy, reports and weapon doctrine. Public views may already
// supply the verified effective controller without the hidden allegiance chain.
export function groupController(state, group) {
  return group.controllerId || factionController(state, group.commandFactionId || group.factionId);
}
