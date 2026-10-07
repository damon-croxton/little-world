// Only consume the supplied observer projection. A foreign row never derives
// totals (or its scale) from visible fragments of a hidden civilisation.
export function strengthRows(state, identities = state.factions || []) {
  const viewer = state.viewer?.mode === 'faction' ? state.viewer.factionId : null;
  const rows = identities.map(identity => {
    if (viewer && identity.id !== viewer) return { id: identity.id, known: false, workers: null, military: null, total: null };
    const faction = state.factions.find(f => f.id === identity.id), homes = state.settlements.filter(h => h.factionId === identity.id);
    const population = Number.isFinite(faction?.economy?.population) ? faction.economy.population : homes.reduce((n, h) => n + (h.population || 0), 0);
    const military = Number.isFinite(faction?.economy?.soldiers) ? faction.economy.soldiers : homes.reduce((n, h) => n + (h.soldiers || 0), 0);
    return { id: identity.id, known: true, workers: Math.max(0, population - military), military: Math.max(0, military), total: Math.max(0, population) };
  });
  const maximum = Math.max(1, ...rows.filter(r => r.known).map(r => r.total));
  return rows.map(r => ({ ...r, workerPercent: r.known ? r.workers / maximum * 100 : null, militaryPercent: r.known ? r.military / maximum * 100 : null }));
}
