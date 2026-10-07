// One bounded naturally populated fixture; not a long match or hardware claim.
import { performance } from 'node:perf_hooks';
import { writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createSimulation, stepSimulation } from '../src/sim/core.js';
import { createDebugRecorder, encodeDebugReport } from '../src/debug-report.js';
const started = performance.now(), state = createSimulation('first-light', { civCount: 6 });
stepSimulation(state, 2000);
const fixtureMs = performance.now() - started, before = JSON.stringify(state), times = [], view = { paused: false, speed: 2, quality: 'low' };
let sampleNow = 0; const recorder = createDebugRecorder({ now: () => sampleNow }); recorder.reset(state, view);
for (let i = 0; i < 40; i++) {
  sampleNow += 2000; state.step++; const start = performance.now(); recorder.sample(state, view); times.push(performance.now() - start);
}
state.step -= 40; assert.equal(JSON.stringify(state), before);
const captureStart = performance.now(), report = recorder.capture(state, view, { version: '0.2.0', commit: 'benchmark-candidate' });
const captureMs = performance.now() - captureStart, encodingStart = performance.now(), file = await encodeDebugReport(report), encodingMs = performance.now() - encodingStart;
assert.equal(JSON.stringify(state), before);
times.sort((a, b) => a - b);
const result = { scope: 'Node cloud fixture, six factions naturally evolved 200 cycles. Forty forced diagnostic samples; no simulation/render concurrency. Not physical-device performance.',
  fixtureMs, cycles: state.tick, population: state.settlements.reduce((n,h)=>n+h.population,0), groups: state.groups.length,
  soldiers: state.settlements.reduce((n,h)=>n+(h.soldierRoster?.length||0),0), meanSampleMs: times.reduce((n,v)=>n+v,0)/times.length,
  p95SampleMs: times[Math.floor(times.length*.95)], maxSampleMs: times.at(-1), captureMs, encodingMs, jsonBytes: file.jsonBytes, fileBytes: file.blob.size,
  recorder: recorder.stats(), truncation: report.truncation, elapsedMs: performance.now()-started };
await mkdir('screenshots/debug-report', {recursive:true}); await writeFile('screenshots/debug-report/benchmark.json', JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
