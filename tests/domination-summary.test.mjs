import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMINATION_SEEDS, summarizeDomination } from './domination.mjs';

test('domination report preserves failed and unfinished runs rather than hiding pacing failures', () => {
  const result = (seed, tick, species = 'human') => ({ seed, ok: true, maximum: { population: 1000 }, victory: tick == null ? null : { wonAt: tick, species, advantage: 'fixture' } });
  const s = summarizeDomination([result('early', 400), result('target', 800, 'machine'), result('late', 1800, 'hive'), result('unfinished', null), { seed: 'failed', ok: false, error: 'invariant failure' }]);
  assert.equal(s.tested, 5); assert.equal(s.victories, 3); assert.equal(s.noWinnerByLimit, 1); assert.equal(s.invariantFailed, 1);
  assert.equal(s.victoryRateAmongAllRuns, .6);
  assert.equal(s.earlyVictories, 1); assert.equal(s.targetWindowVictories, 1); assert.equal(s.lateVictories, 1);
  assert.deepEqual(s.winningCycles, { minimum: 400, median: 800, maximum: 1800 });
  assert.deepEqual(s.nominalWallSecondsAt2x, { minimum: 200, median: 400, maximum: 900 });
  assert.deepEqual(s.winnerSpecies, { human: 1, machine: 1, hive: 1 });
  assert.equal(s.seeds.length, 5);
});

test('domination seed set is fixed and an empty winner set reports no timing estimate', () => {
  assert.equal(DOMINATION_SEEDS.length, 20); assert.equal(new Set(DOMINATION_SEEDS).size, 20);
  const s = summarizeDomination([{ seed: 'no-winner', ok: true, maximum: { population: 400 }, victory: null }]);
  assert.equal(s.victories, 0); assert.equal(s.noWinnerByLimit, 1);
  assert.deepEqual(s.winningCycles, { minimum: null, median: null, maximum: null });
});
