// Residents occupy one place; serving soldiers and funded trainees also need
// quarters for their equipment. This is capacity demand, never extra people.
export const housingDemand = home => Math.max(0, home.population || 0) + Math.max(0, home.soldiers || 0) + (home.trainingQueue || []).reduce((sum, job) => sum + job.size, 0);
export function refreshHousing(home, faction) {
  const live = (home.buildings || []).filter(b => b.progress >= 1 && !b.destroyed && (b.hp == null || b.hp > 0));
  const modifier = Math.max(.25, Math.min(4, faction?.modifiers?.capacity ?? 1));
  home.housingCapacity = Math.round((live.some(b => b.kind === 'hub') ? 16 : 0) * modifier + live.filter(b => b.kind === 'housing').length * 28 * modifier);
  home.carryingCapacity = home.housingCapacity;
  return home.housingCapacity;
}
