import * as THREE from 'three';
import { writeFile } from 'node:fs/promises';
import { createSimulation, stepSimulation } from '../src/sim/core.js';
import { createCrowds } from '../src/render/crowds.js';
import { overviewFrame } from '../src/render/overview.js';
import { SimulationClock, SIM_DT } from '../src/clock.js';

// This is a reproducible CPU/geometry benchmark, NOT a browser FPS test.
// Every individual is grown by the real simulation. There are no showcase
// population edits, and active frames really advance the 10 Hz simulation.
const seed = process.env.LW_SEED || 'first-light';
const cycles = (process.env.LW_CYCLES || '1200,3000').split(',').map(Number).filter(n => Number.isInteger(n) && n >= 0).sort((a, b) => a - b);
const state = createSimulation(seed), report = { at: new Date().toISOString(), seed, runtime: process.version, scope: 'Node CPU + geometry only; excludes WebGL/GPU, landscape, buildings, DOM and display refresh', samples: [] };
const summary = values => { const sorted = [...values].sort((a, b) => a - b); return { meanMs: values.reduce((sum, n) => sum + n, 0) / values.length, p50Ms: sorted[Math.floor(sorted.length * .5)], p95Ms: sorted[Math.floor(sorted.length * .95)] }; };
for (const cycle of cycles) {
  const simulationStart = performance.now(); stepSimulation(state, Math.max(0, cycle * 10 - state.step));
  const generationMs = performance.now() - simulationStart;
  for (const mode of ['paused', 'animated-render-only', 'active-1x']) {
    // Independent copies start at the same naturally evolved instant.
    const sampleState = structuredClone(state), scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(40, 1.6, .2, 1800), framing = overviewFrame(1.6);
    camera.position.copy(framing.position); camera.lookAt(framing.target.x, framing.target.y, framing.target.z); scene.userData.camera = camera;
    const crowds = createCrowds(THREE, scene), clock = new SimulationClock(), duration = [], simDuration = [], samples = 120;
    for (let i = 0; i < 30; i++) crowds.update(sampleState, sampleState.time + i / 60, 's0', (i % 6) / 6);
    const startStep = sampleState.step;
    for (let i = 0; i < samples; i++) {
      const start = performance.now();
      if (mode === 'active-1x') clock.advance(1 / 60, 1, false, n => stepSimulation(sampleState, n));
      const simulated = performance.now();
      const time = mode === 'animated-render-only' ? state.time + i / 60 : mode === 'active-1x' ? sampleState.time - SIM_DT + clock.alpha * SIM_DT : state.time;
      crowds.update(sampleState, time, 's0', mode === 'active-1x' ? clock.alpha : mode === 'paused' ? 1 : (i % 6) / 6);
      duration.push(performance.now() - start); simDuration.push(simulated - start);
    }
    const d = crowds.diagnostics;
    const record = { cycle, mode, samples, generationMs, ...summary(duration), simulationCpu: summary(simDuration), simulatedPulses: sampleState.step - startStep, totalPopulation: d.totalPopulation, representedIndividuals: d.representedIndividuals, visibleIndividuals: d.visibleIndividuals, crowdTriangles: d.triangleEstimate, crowdDraws: d.drawCallsEstimate, geometryOnly: true };
    if (record.totalPopulation !== record.representedIndividuals || record.visibleIndividuals !== record.totalPopulation) throw new Error('Population representation or overview visibility mismatch');
    if (mode === 'active-1x' && record.simulatedPulses !== 20) throw new Error('Active measurement did not advance two seconds at 1x');
    report.samples.push(record); console.log(JSON.stringify(record)); crowds.dispose();
  }
}
if (process.env.LW_REPORT) await writeFile(process.env.LW_REPORT, JSON.stringify(report, null, 2));
