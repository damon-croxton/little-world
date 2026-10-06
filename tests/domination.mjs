import { pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_SEEDS, runBalance } from './balance.mjs';

// The list is fixed before inspecting winners. Failed or unfinished worlds stay
// in the denominator; winner timing never silently excludes the no-winner rate.
export const DOMINATION_SEEDS = Object.freeze([...DEFAULT_SEEDS, ...Array.from({ length: 14 }, (_, i) => `domination-${String(i + 1).padStart(2, '0')}`)]);
const distribution = values => {
  if (!values.length) return { minimum: null, median: null, maximum: null };
  const sorted = [...values].sort((a, b) => a - b), i = Math.floor(sorted.length / 2);
  return { minimum: sorted[0], median: sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2, maximum: sorted.at(-1) };
};
export function summarizeDomination(results) {
  const passed = results.filter(r => r.ok), won = passed.filter(r => r.victory), failures = results.filter(r => !r.ok);
  const counts = (key, values) => Object.fromEntries(values.map(value => [value, won.filter(r => r.victory[key] === value).length]));
  return {
    tested: results.length, invariantPassed: passed.length, invariantFailed: failures.length,
    victories: won.length, noWinnerByLimit: passed.length - won.length,
    victoryRateAmongAllRuns: results.length ? won.length / results.length : null,
    targetCycles: [600, 1200], targetNominalWallMinutesAt2x: [5, 10],
    earlyVictories: won.filter(r => r.victory.wonAt < 600).length,
    targetWindowVictories: won.filter(r => r.victory.wonAt >= 600 && r.victory.wonAt <= 1200).length,
    lateVictories: won.filter(r => r.victory.wonAt > 1200).length,
    winningCycles: distribution(won.map(r => r.victory.wonAt)),
    nominalWallSecondsAt2x: distribution(won.map(r => r.victory.wonAt / 2)),
    winnerSpecies: counts('species', ['human', 'machine', 'hive']),
    winnerAdvantages: counts('advantage', [...new Set(won.map(r => r.victory.advantage))]),
    peakActualPopulation: distribution(passed.map(r => r.maximum.population)),
    seeds: results.map(r => ({ seed: r.seed, ok: r.ok, completedCycles: r.completedCycles, victory: r.victory || null, peakPopulation: r.maximum?.population, firstContact: r.firstEventCycles?.contact ?? null, firstMobilisation: r.firstEventCycles?.mobilize ?? null, firstBattle: r.firstEventCycles?.battle ?? null, conflict: r.checkpoints?.at(-1)?.conflict, deathCauses: r.checkpoints?.at(-1)?.deathCauses, error: r.error || null })),
    timingScope: 'Nominal observer pacing at2x, not measured browser/phone throughput. Winner-only timing distribution is accompanied by all-run victory rate and failed/unfinished counts.',
    browserVerification: 'Not run by this Node audit.',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cycles = Number(process.env.DOMINATION_CYCLES || 2000), civCount = Number(process.env.DOMINATION_CIVS || 4);
  const seeds = process.argv.slice(2).length ? process.argv.slice(2) : DOMINATION_SEEDS;
  const results = [];
  for (const seed of seeds) {
    let result;
    try {
      const saveState = process.env.DOMINATION_STATE_DIR ? state => {
        mkdirSync(process.env.DOMINATION_STATE_DIR, { recursive: true });
        writeFileSync(path.join(process.env.DOMINATION_STATE_DIR, `${seed.replace(/[^a-z0-9_-]/gi, '_')}-civs${state.factions.length}-cycle${state.tick}.json`), JSON.stringify(state));
      } : null;
      result = { ok: true, ...runBalance(seed, cycles, 10, { civCount, stopAtVictory: true }, saveState) };
    } catch (error) { result = { ok: false, seed, ...error.auditPartial, error: error.stack }; process.exitCode = 1; }
    results.push(result); console.log(JSON.stringify({ type: 'seed', ...result }));
    if (process.env.DOMINATION_SUMMARY_PATH) {
      mkdirSync(path.dirname(process.env.DOMINATION_SUMMARY_PATH), { recursive: true });
      writeFileSync(process.env.DOMINATION_SUMMARY_PATH, JSON.stringify(summarizeDomination(results), null, 2));
    }
  }
  console.log(JSON.stringify({ type: 'summary', ...summarizeDomination(results) }));
}
