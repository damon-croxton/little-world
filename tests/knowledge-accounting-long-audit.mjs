import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runBalance } from './balance.mjs';
import { DOMINATION_SEEDS, summarizeDomination } from './domination.mjs';

// Standalone, sequential natural-world audit. No fixture edits, population boosts,
// stop-at-victory shortcut, or excluded unfinished worlds affect these results.
const cycles = Number(process.env.AI_AUDIT_CYCLES || 2000);
const civCount = Number(process.env.AI_AUDIT_CIVS || 4);
const directory = path.resolve(process.env.AI_AUDIT_DIR || 'screenshots/ai-readability-audit');
const selectedSeeds = process.argv.slice(2).length ? process.argv.slice(2) : DOMINATION_SEEDS;
const resultPath = path.join(directory, 'long-results.jsonl');
mkdirSync(directory, { recursive: true });
writeFileSync(resultPath, '');
function sourceHash() {
  const files = readdirSync('src', { recursive: true }).filter(name => /\.(js|css)$/.test(name)).sort();
  const digest = createHash('sha256');
  for (const filename of files) digest.update(filename.replaceAll('\\', '/')).update('\0').update(readFileSync(path.join('src', filename)));
  return digest.digest('hex');
}
const metadata = { runtime: process.version, startedAt: new Date().toISOString(), sourceSha256: sourceHash(), cycles, civCount, auditEveryCycles: 10,
  requestedSeeds: selectedSeeds, stopAtVictory: false, runtimeScope: 'Same Node runtime only; Chrome outcomes must be checked separately.' };
writeFileSync(path.join(directory, 'long-metadata.json'), JSON.stringify(metadata, null, 2));
const results = [];
for (const seed of selectedSeeds) {
  let result, finalState;
  try {
    const balance = runBalance(seed, cycles, 10, { civCount, stopAtVictory: false }, state => { finalState = state; });
    result = { ok: true, ...balance, finalStateSha256: createHash('sha256').update(JSON.stringify(finalState)).digest('hex') };
  } catch (error) {
    result = { ok: false, seed, ...error.auditPartial, error: error.stack };
    if (finalState) writeFileSync(path.join(directory, `failed-${seed.replace(/[^a-z0-9_-]/gi, '_')}-cycle${finalState.tick}.json`), JSON.stringify(finalState));
    process.exitCode = 1;
  }
  results.push(result); appendFileSync(resultPath, `${JSON.stringify(result)}\n`);
  const currentHash = sourceHash(), summary = { ...metadata, completedAt: new Date().toISOString(), sourceUnchangedDuringAudit: currentHash === metadata.sourceSha256,
    finalSourceSha256: currentHash, completedSeeds: results.length, ...summarizeDomination(results) };
  writeFileSync(path.join(directory, 'long-summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ seed, ok: result.ok, cycle: result.completedCycles, elapsedMs: result.elapsedMs,
    winner: result.victory?.species ?? null, wonAt: result.victory?.wonAt ?? null, conflict: result.checkpoints?.at(-1)?.conflict, error: result.error ?? null }));
}
