import { setMilitary, bindArmy, positionMilitary } from './roster-fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createCrowds } from '../src/render/crowds.js';
import { overviewFrame } from '../src/render/overview.js';
import { WORLD_RADIUS } from '../src/world.js';
import { createSimulation, stepSimulation } from '../src/sim/core.js';

function sceneAtOverview(aspect = 1.6) {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(40, aspect, .2, 1800), frame = overviewFrame(aspect);
  camera.position.copy(frame.position); camera.lookAt(frame.target.x, frame.target.y, frame.target.z); camera.updateMatrixWorld();
  scene.userData.camera = camera;
  return { scene, camera };
}
// Small explicit contract fixture, never used in the app or performance proof.
// Covers every deployment type and all three species without a long sim run.
function categories() {
  const factions = ['human', 'machine', 'hive'].map((species, i) => ({ id: `f${i}`, species, color: ['#f1a066', '#85ccbc', '#c4a2db'][i] }));
  const settlements = factions.map((f, i) => ({ id: `s${i}`, factionId: f.id, x: i * 30 - 30, z: 0, population: 100, health: 100, status: 'active', soldiers: 10, radius: 9, assigned: { researchers: 3, construction: 2, infrastructure: 4 }, buildings: [
    { id: `b${i}a`, kind: 'hub', x: i * 30 - 30, z: 0, progress: 1 },
    { id: `b${i}b`, kind: 'housing', x: i * 30 - 27, z: 3, progress: .7 },
    { id: `b${i}c`, kind: 'lab', x: i * 30 - 33, z: 3, progress: 1 }
  ] }));
  const groups = settlements.flatMap((s, i) => ['worker', 'army', 'scout', 'trader', 'colonist'].map((kind, j) => ({ id: `g${i}:${j}`, originId: s.id, factionId: s.factionId, kind, size: [6, 4, 3, 2, 5][j], x: s.x + j, z: 18, prevX: s.x + j - .1, prevZ: 17.9, targetX: s.x + 15, targetZ: 20, phase: kind === 'worker' ? 'working' : 'outbound', carrying: 6, capacity: 24, targetId: 'n0' })));
  const state = { seed: 'render-contract', step: 100, tick: 10, time: 10, factions, settlements, groups: [], nodes: [{ id: 'n0', x: 0, z: 18, radius: 3, amount: 100 }] };
  for (const home of settlements) {
    setMilitary(state, home, { infantry: 10, ranged: 0 });
    const army = groups.find(group => group.kind === 'army' && group.originId === home.id);
    army.units = { infantry: army.size, ranged: 0 }; bindArmy(state, home, army);
  }
  state.groups = groups; positionMilitary(state); return state;
}
function visibleMeshes(scene) { const meshes = []; scene.traverse(o => { if (o.isInstancedMesh && o.visible && o.count) meshes.push(o); }); return meshes; }

for (const aspect of [390 / 844, 1024 / 768, 1.6, 16 / 9, 2.4]) test(`overview fits the living island at aspect ${aspect}`, () => {
  const { camera } = sceneAtOverview(aspect);
  let minX = Infinity, maxX = -Infinity;
  for (let i = 0; i < 128; i++) for (const y of [-4, 12]) {
    const a = i / 128 * Math.PI * 2, p = new THREE.Vector3(Math.cos(a) * WORLD_RADIUS, y, Math.sin(a) * WORLD_RADIUS).project(camera);
    assert.ok(Math.abs(p.x) <= .920001 && p.y >= -.800001 && p.y <= .740001, `${p.x}, ${p.y}`);
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
  }
  if (aspect === 1.6) assert.ok(maxX - minX > 1.5, 'desktop island should fill substantially more than the old overview');
});

test('population categories retain exact weighted census with one model per worker crew', () => {
  const { scene } = sceneAtOverview(), state = categories(), before = structuredClone(state), crowds = createCrowds(THREE, scene);
  crowds.update(state, 10, 's0', .5);
  const d = crowds.diagnostics;
  assert.equal(d.totalPopulation, 300); assert.equal(d.representedIndividuals, 300); assert.equal(d.visibleIndividuals, 300);
  assert.equal(d.homePresentIndividuals, 240); assert.equal(d.groupIndividuals, 60); assert.equal(d.workerIndividuals, 18); assert.equal(d.armyIndividuals, 12);
  assert.equal(d.representedWorkerIndividuals, 18); assert.equal(d.visibleWorkerIndividuals, 18);
  assert.equal(d.workerCrewCount, 3); assert.equal(d.visibleWorkerCrews, 3); assert.equal(d.drawnWorkerModels, 3);
  assert.equal(d.workerBadgeCount, 0); assert.equal(d.workerBadgeLodCulled, 3);
  assert.equal(d.militaryIndividuals, 30); assert.equal(d.visibleMilitaryIndividuals, 30);
  assert.equal(d.populationAccountingDelta, 0); assert.equal(d.overviewIndividuals, 300);
  assert.equal(d.drawnModels, 285); assert.equal(d.instances, d.drawnModels);
  assert.equal(d.drawnModels, d.visibleIndividuals - d.visibleWorkerIndividuals + d.drawnWorkerModels);
  assert.equal(visibleMeshes(scene).reduce((n, m) => n + m.count, 0), d.drawnModels);
  assert.ok(d.triangleEstimate <= d.drawnModels * 112 + d.workerBadgeCount * 2, `${d.triangleEstimate} crowd triangles`);
  const species = new Map();
  for (const mesh of visibleMeshes(scene)) {
    const geometry = mesh.geometry;
    assert.ok(geometry.index, 'indexed crowd template');
    assert.ok(geometry.attributes.position.count < geometry.index.count, 'reuse vertices');
    geometry.computeBoundingBox(); const size = geometry.boundingBox.getSize(new THREE.Vector3());
    assert.ok(size.x > .25 && size.y > .6 && size.z > .3, 'actual 3D articulated silhouette');
    const parts = new Set(geometry.attributes.crowdPart.array);
    for (const p of [1, 2, 5, 6, 7]) assert.ok(parts.has(p), `missing articulated/equipment part ${p}`);
    for (const attribute of [mesh.instanceMatrix, mesh.instanceColor, geometry.attributes.crowdMotion, geometry.attributes.crowdRole]) assert.deepEqual(attribute.updateRanges, [{ start: 0, count: mesh.count * attribute.itemSize }]);
    species.set(mesh.name.split(':')[0], geometry.index.count / 3);
  }
  assert.equal(species.size, 3);
  for (const sample of crowds.getMotionSamples()) {
    const mesh = scene.getObjectByProperty('uuid', sample.meshUuid);
    assert.ok(mesh && sample.instanceIndex < mesh.count, 'sample identity resolves after pool growth');
    const matrix = new THREE.Matrix4(); mesh.getMatrixAt(sample.instanceIndex, matrix);
    const p = new THREE.Vector3().setFromMatrixPosition(matrix);
    assert.ok(Math.hypot(p.x - sample.x, p.y - sample.groundY, p.z - sample.z) < 1e-5, 'sample tracks literal rendered matrix');
    assert.equal(sample.representedCount, sample.kind === 'worker' ? 6 : 1);
    if (sample.kind === 'worker') { assert.equal(sample.crewSize, 6); assert.equal(sample.badgeText, '6×'); }
  }
  assert.deepEqual(state, before, 'renderer never mutates simulation'); crowds.dispose();
});

test('subpulse home and deployed motion continue; an exact paused frame reuses unchanged transforms', () => {
  const { scene } = sceneAtOverview(), state = categories(), crowds = createCrowds(THREE, scene);
  crowds.update(state, 10, 's0', .3); const before = crowds.getMotionSamples();
  crowds.update(state, 10.016, 's0', .46); const after = crowds.getMotionSamples();
  assert.ok(after.some((p, i) => p.kind === 'home' && Math.hypot(p.x - before[i].x, p.y - before[i].y, p.z - before[i].z) > 1e-8));
  assert.ok(after.some((p, i) => p.kind !== 'home' && Math.hypot(p.x - before[i].x, p.y - before[i].y, p.z - before[i].z) > 1e-8));
  const arrays = visibleMeshes(scene).map(m => Array.from(m.instanceMatrix.array));
  crowds.update(state, 10.016, 's0', .46);
  assert.equal(crowds.diagnostics.reusedFrame, true); assert.deepEqual(crowds.getMotionSamples(), after);
  assert.deepEqual(visibleMeshes(scene).map(m => Array.from(m.instanceMatrix.array)), arrays); crowds.dispose();
});

test('paused cache invalidates on camera/projection, quality, selection, state and node changes', () => {
  const { scene, camera } = sceneAtOverview(), state = categories(), crowds = createCrowds(THREE, scene);
  let selected = 's0';
  const run = () => crowds.update(state, 10, selected, .5);
  run(); run(); assert.equal(crowds.diagnostics.reusedFrame, true);
  const changes = [() => camera.position.x++, () => { camera.fov = 41; camera.updateProjectionMatrix(); }, () => { scene.userData.quality = 'low'; }, () => { selected = 'g0:0'; }, () => state.settlements[0].population++, () => state.settlements[0].buildings[0].x++, () => state.groups[0].carrying++, () => state.groups[0].x++, () => state.nodes[0].radius++, () => state.nodes[0].amount--, () => { state.factions[0].color = '#ffffff'; }, () => state.step++, () => { state.seed = 'another'; }];
  for (const change of changes) { change(); run(); assert.equal(crowds.diagnostics.reusedFrame, false, change.toString()); run(); assert.equal(crowds.diagnostics.reusedFrame, true); }
  camera.lookAt(camera.position.clone().multiplyScalar(2)); run();
  assert.equal(crowds.diagnostics.visibleIndividuals, 0); assert.equal(crowds.diagnostics.representedIndividuals, 301); assert.equal(crowds.diagnostics.culledIndividuals, 301);
  assert.equal(visibleMeshes(scene).length, 0); crowds.dispose();
});

test('naturally evolved state preserves exact rendering census through overview, close view and state replacement', () => {
  const state = createSimulation('first-light'); stepSimulation(state, 3000);
  const { scene, camera } = sceneAtOverview(), crowds = createCrowds(THREE, scene), snapshot = structuredClone(state);
  crowds.update(state, state.time, 's0', .5);
  const total = state.settlements.reduce((n, s) => n + s.population, 0);
  assert.equal(crowds.diagnostics.representedIndividuals, total); assert.equal(crowds.diagnostics.visibleIndividuals, total);
  const home = state.settlements[0]; camera.position.set(home.x + 18, 20, home.z + 25); camera.lookAt(home.x, 3, home.z);
  crowds.update(state, state.time, 's0', .5);
  assert.equal(crowds.diagnostics.representedIndividuals, total); assert.ok(crowds.diagnostics.detailedIndividuals > 0);
  assert.equal(crowds.diagnostics.visibleIndividuals + crowds.diagnostics.culledIndividuals, total);
  assert.deepEqual(state, snapshot);
  const next = createSimulation('first-light'); crowds.update(next, 0, 's0', 0);
  assert.equal(crowds.diagnostics.totalPopulation, next.settlements.reduce((n, s) => n + s.population, 0)); assert.equal(crowds.diagnostics.populationAccountingDelta, 0);
  crowds.dispose(); assert.equal(scene.children.length, 0);
});

test('depleted resources and cleared decoration are removed from submissions and regrow with exact picking', async () => {
  const { createTerrain } = await import('../src/render/terrain.js');
  const state = createSimulation('render-resources'), scene = new THREE.Scene(), terrain = createTerrain(THREE, scene, state.seed);
  terrain.update(0, state, 1);
  const original = terrain.getPickables().map(mesh => ({ mesh, count: mesh.count, ids: [...mesh.userData.resourceNodeIds], matrices: Array.from(mesh.instanceMatrix.array) }));
  const decorative = []; scene.traverse(mesh => { if (mesh.isInstancedMesh && mesh.userData.clearanceKind) decorative.push({ mesh, count: mesh.count, matrices: Array.from(mesh.instanceMatrix.array.slice(0, mesh.count * 16)), colors: mesh.instanceColor ? Array.from(mesh.instanceColor.array.slice(0, mesh.count * 3)) : null }); });
  const initialVisible = terrain.diagnostics.visibleDecorativePieces;
  for (const node of state.nodes) node.amount = 0;
  for (const home of state.settlements) home.radius += 70;
  state.step++; state.tick++; terrain.update(1, state, 1);
  assert.equal(terrain.diagnostics.visibleResourcePieces, 0);
  assert.equal(terrain.diagnostics.resourceDrawCalls, 0);
  assert.ok(terrain.diagnostics.visibleDecorativePieces < initialVisible);
  for (const { mesh } of original) { assert.equal(mesh.count, 0); assert.deepEqual(mesh.userData.resourceNodeIds, []); }
  for (const node of state.nodes) node.amount = node.maxAmount * .37;
  state.step++; terrain.update(2, state, 1);
  assert.ok(terrain.diagnostics.visibleResourcePieces > 0 && terrain.diagnostics.visibleResourcePieces < terrain.diagnostics.resourcePieces);
  for (const { mesh } of original) {
    assert.equal(mesh.count, mesh.userData.resourceNodeIds.length);
    for (let i = 0; i < mesh.count; i++) assert.equal(terrain.resolvePick({ object: mesh, instanceId: i }), mesh.userData.resourceNodeIds[i]);
  }
  for (const node of state.nodes) node.amount = node.maxAmount;
  for (const home of state.settlements) home.radius -= 70;
  state.step++; state.tick++; terrain.update(3, state, 1);
  for (const { mesh, count, ids, matrices } of original) { assert.equal(mesh.count, count); assert.deepEqual(mesh.userData.resourceNodeIds, ids); assert.deepEqual(Array.from(mesh.instanceMatrix.array), matrices); }
  for (const { mesh, count, matrices, colors } of decorative) { assert.equal(mesh.count, count); assert.deepEqual(Array.from(mesh.instanceMatrix.array.slice(0, count * 16)), matrices); if (colors) assert.deepEqual(Array.from(mesh.instanceColor.array.slice(0, count * 3)), colors); }
  terrain.dispose(); assert.equal(scene.children.length, 0);
});
