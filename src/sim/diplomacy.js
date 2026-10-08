// New matches are strict free-for-all. Missing mode preserves the retained
// legacy snapshot/fixture mechanics; the public match controls cannot select it.
export const freeForAll = state => state.config?.diplomacy === 'free-for-all';

export function relationStatus(state, faction, otherId) {
  if (faction?.id === otherId) return 'own';
  return freeForAll(state) && otherId ? 'hostile' : faction?.relations?.[otherId]?.status ?? 'unknown';
}

export function enforceHostility(state) {
  if (!freeForAll(state)) return;
  // Change existing contact ledgers only. The rule must not reveal an unseen
  // society, settlement, army, or another faction's intelligence.
  for (const faction of state.factions) for (const [id, relation] of Object.entries(faction.relations || {})) {
    if (id === faction.id || relation.status === 'unknown') continue;
    relation.status = 'hostile'; relation.trust = 0; delete relation.truceUntil;
  }
}
