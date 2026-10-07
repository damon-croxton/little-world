import { setMilitary, bindArmy, positionMilitary } from './roster-fixtures.mjs';
import { returnMilitary } from '../src/sim/military.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createCrowds } from '../src/render/crowds.js';
import { overviewFrame } from '../src/render/overview.js';

function fixture() {
  const worker = (id, size, x, phase = 'outbound') => ({ id, size, x, z: 8, prevX: x - .4, prevZ: 8, targetX: x + 3, targetZ: 8, targetId: 'ore', originId: 'home', factionId: 'people', kind: 'worker', phase, carrying: { ore: 12, wood: 0 }, capacity: 60 });
  const state = { seed: 'civilian-crew-render', step: 100, time: 10,
    factions: [{ id: 'people', species: 'human', color: '#dca16b' }],
    settlements: [{ id: 'home', factionId: 'people', x: 0, z: 0, population: 40, health: 100, status: 'active', soldiers: 5, military: { infantry: 3, ranged: 2 }, assigned: {}, buildings: [] }],
    groups: [worker('outbound-crew', 11, -6), worker('mining-crew', 7, 6, 'working'),
      { ...worker('soldiers', 5, 12), kind: 'army', units: { infantry: 3, ranged: 2 } }, { ...worker('scouts', 2, -12), kind: 'scout' }],
    nodes: [{ id: 'ore', x: 9, z: 8, radius: 3, amount: 100 }]
  };
  const groups = state.groups; state.groups = [];
  setMilitary(state, state.settlements[0], { infantry: 3, ranged: 2 });
  bindArmy(state, state.settlements[0], groups[2]); state.groups = groups;
  positionMilitary(state); return state;
}
function setup(camera = false) {
  const state = fixture(), scene = new THREE.Scene();
  if (camera) {
    scene.userData.camera = new THREE.PerspectiveCamera(40, 1.6, .2, 1800);
    scene.userData.camera.position.set(0, 35, 55); scene.userData.camera.lookAt(0, 2, 8);
  }
  return { state, scene, crowds: createCrowds(THREE, scene) };
}
function badgeMesh(scene) { let result; scene.traverse(mesh => { if (mesh.userData.workerBadges) result = mesh; }); return result; }
function literalBody(scene, sample) {
  const mesh = scene.getObjectByProperty('uuid', sample.meshUuid), matrix = new THREE.Matrix4();
  assert.ok(mesh && sample.instanceIndex < mesh.count); mesh.getMatrixAt(sample.instanceIndex, matrix);
  const p = new THREE.Vector3().setFromMatrixPosition(matrix);
  assert.ok(Math.hypot(p.x - sample.x, p.y - sample.groundY, p.z - sample.z) < 1e-5);
  return { mesh, matrix, motion: Array.from(mesh.geometry.attributes.crowdMotion.array.slice(sample.instanceIndex * 4, sample.instanceIndex * 4 + 4)) };
}
function weightedContract(crowds, scene) {
  const d = crowds.diagnostics;
  assert.equal(d.drawnModels, d.instances);
  assert.equal(d.drawnModels, d.visibleIndividuals - d.visibleWorkerIndividuals + d.drawnWorkerModels);
  assert.ok(d.workerBadgeCount <= d.visibleWorkerCrews); assert.equal(d.drawnWorkerModels, d.visibleWorkerCrews);
  assert.equal(d.workerBadgeCount + d.workerBadgeLodCulled + d.workerBadgeOverlapCulled, d.visibleWorkerCrews);
  assert.equal(d.representedIndividuals, d.totalPopulation); assert.equal(d.culledIndividuals, d.totalPopulation - d.visibleIndividuals - d.housedIndividuals);
  let models = 0; scene.traverse(mesh => { if (mesh.isInstancedMesh && mesh.visible) models += mesh.count; });
  assert.equal(models, d.drawnModels); assert.equal(badgeMesh(scene).geometry.instanceCount, d.workerBadgeCount);
}

test('real eleven-person and seven-person crews render two counted workers while soldiers stay individual', () => {
  const { state, scene, crowds } = setup(), before = structuredClone(state);
  crowds.update(state, 10, 'soldiers', .5); weightedContract(crowds, scene);
  const d = crowds.diagnostics, workers = crowds.getMotionSamples().filter(s => s.kind === 'worker');
  assert.equal(d.totalPopulation, 40); assert.equal(d.drawnModels, 9); assert.equal(d.housedIndividuals, 15);
  assert.equal(d.representedWorkerIndividuals, 18); assert.equal(d.visibleWorkerIndividuals, 18); assert.equal(d.workerCrewCount, 2);
  assert.equal(d.militaryIndividuals, 5); assert.equal(d.visibleMilitaryIndividuals, 5);
  assert.deepEqual(workers.map(s => [s.groupId, s.representedCount, s.crewSize, s.badgeText]), [['outbound-crew', 11, 11, '11×'], ['mining-crew', 7, 7, '7×']]);
  for (const worker of workers) { assert.equal(worker.role, 1); assert.equal(worker.militaryRole, null); literalBody(scene, worker); }
  const soldiers = crowds.getMotionSamples().filter(s => s.kind === 'army');
  assert.equal(soldiers.length, 5); assert.ok(soldiers.every(s => s.representedCount === 1 && s.badgeText === null));
  assert.deepEqual(new Set(soldiers.map(s => s.role)), new Set([2, 7]));
  assert.deepEqual(state, before); crowds.dispose();
});

test('crew motion, work, cargo and paused changes remain tied to the literal representative', () => {
  const { state, scene, crowds } = setup();
  crowds.update(state, 10, null, .2);
  const a = crowds.getMotionSamples().filter(s => s.kind === 'worker');
  crowds.update(state, 10.04, null, .6);
  const b = crowds.getMotionSamples().filter(s => s.kind === 'worker');
  assert.ok(b[0].x > a[0].x, 'outbound representative advances with interpolation');
  assert.ok(b[1].toolMotion.y !== a[1].toolMotion.y, 'stationary work articulates over simulation time');
  assert.equal(b[0].carrying, .2);
  const literal = b.map(s => literalBody(scene, s));
  assert.equal(literal[0].motion[1], 1); assert.ok(literal[1].motion[2] > .9);
  const labels = badgeMesh(scene), badgePositions = Array.from(labels.geometry.attributes.badgeAnchor.array);
  crowds.update(state, 10.04, null, .6);
  assert.equal(crowds.diagnostics.reusedFrame, true); assert.deepEqual(crowds.getMotionSamples().filter(s => s.kind === 'worker'), b);
  assert.deepEqual(Array.from(labels.geometry.attributes.badgeAnchor.array), badgePositions);
  for (let i = 0; i < b.length; i++) assert.deepEqual(literalBody(scene, b[i]).matrix, literal[i].matrix);
  state.groups[0].size = 9; state.groups[0].carrying.ore = 30;
  const before = structuredClone(state); crowds.update(state, 10.04, null, .6);
  assert.equal(crowds.diagnostics.reusedFrame, false); weightedContract(crowds, scene);
  const changed = crowds.getMotionSamples().find(s => s.groupId === 'outbound-crew');
  assert.equal(changed.representedCount, 9); assert.equal(changed.badgeText, '9×'); assert.equal(changed.carrying, .5);
  const badgeIndex = Array.from({ length: labels.geometry.instanceCount }, (_, i) => i).find(i => crowds.resolvePick({ object: labels, instanceId: i }) === 'outbound-crew');
  assert.equal(labels.geometry.attributes.badgeLayout.getX(badgeIndex), 9); assert.equal(crowds.diagnostics.homePresentIndividuals, 17);
  assert.deepEqual(state, before); crowds.dispose();
});

test('badge pooling survives growth, shrink, crew completion and render disposal', () => {
  const { state, scene, crowds } = setup(), original = state.groups[0];
  returnMilitary(state, state.settlements[0], state.groups[2]);
  const labels = badgeMesh(scene), material = labels.material, texture = material.uniforms.glyphAtlas.value;
  for (const crews of [1, 70, 3, 71, 0]) {
    state.groups = Array.from({ length: crews }, (_, i) => ({ ...original, id: `crew-${i}`, size: i % 23 + 1, x: i % 9 * 2, prevX: i % 9 * 2 - .1 }));
    state.settlements[0].population = 10 + state.groups.reduce((n, g) => n + g.size, 0); state.step++;
    crowds.update(state, 10, null, 1); weightedContract(crowds, scene);
    const d = crowds.diagnostics;
    assert.equal(d.workerCrewCount, crews); assert.equal(d.drawnWorkerModels, crews); assert.equal(d.workerBadgeCount, crews);
    assert.equal(d.workerBadgeDrawCalls, Number(crews > 0)); assert.ok(d.workerBadgeCapacity <= 128);
    assert.equal(badgeMesh(scene), labels); assert.equal(labels.material, material); assert.equal(labels.material.uniforms.glyphAtlas.value, texture);
  }
  state.groups = [{ ...original, finished: true }]; state.step++; crowds.update(state, 10, null, 1);
  assert.equal(crowds.diagnostics.workerCrewCount, 0); assert.equal(crowds.diagnostics.workerBadgeCount, 0);
  assert.equal(crowds.diagnostics.homePresentIndividuals, 10);
  assert.ok(crowds.getPickables().every(mesh => mesh.userData.crowdSelectionIds?.slice(0, mesh.count).every(id => id === 'home' || state.settlements[0].soldierRoster.some(body => body.id === id))), 'remaining inhabitants stay selectable without stale crew targets');
  let textureDisposed = false, materialDisposed = false;
  texture.addEventListener('dispose', () => { textureDisposed = true; }); material.addEventListener('dispose', () => { materialDisposed = true; });
  crowds.dispose(); assert.ok(textureDisposed && materialDisposed); assert.equal(scene.children.length, 0);
});

test('crew culling weights people and badge clicks resolve the same real group as body picking', () => {
  const { state, scene, crowds } = setup(true), camera = scene.userData.camera;
  crowds.update(state, 10, null, 1); weightedContract(crowds, scene);
  const labels = badgeMesh(scene), layout = labels.geometry.attributes.badgeLayout, anchor = labels.geometry.attributes.badgeAnchor;
  labels.onBeforeRender({ getSize: target => target.set(1280, 800) });
  const center = new THREE.Vector3(anchor.getX(0), anchor.getY(0), anchor.getZ(0)).project(camera);
  center.y += (3 + layout.getZ(0) / 2) * 2 / 800;
  const raycaster = new THREE.Raycaster(); raycaster.setFromCamera(new THREE.Vector2(center.x, center.y), camera);
  const hit = raycaster.intersectObject(labels)[0]; assert.ok(hit, 'actual billboard pixel bounds can be selected');
  assert.equal(crowds.resolvePick(hit), 'mining-crew');
  assert.ok(crowds.getPickables().some(o => o.userData.groupId === 'outbound-crew'));
  camera.lookAt(0, 80, 120); crowds.update(state, 10, null, 1); weightedContract(crowds, scene);
  assert.equal(crowds.diagnostics.visibleIndividuals, 0); assert.equal(crowds.diagnostics.culledIndividuals + crowds.diagnostics.housedIndividuals, 40);
  assert.equal(crowds.diagnostics.representedWorkerIndividuals, 18); assert.equal(crowds.diagnostics.visibleWorkerIndividuals, 0);
  assert.equal(crowds.diagnostics.workerCrewCount, 2); assert.equal(crowds.diagnostics.workerBadgeCount, 0);
  crowds.dispose();
});

test('full-world badge LOD preserves every worker model and keeps the selected crew count', () => {
  const { state, scene, crowds } = setup(true), camera = scene.userData.camera, frame = overviewFrame(1.6);
  camera.position.copy(frame.position); camera.lookAt(frame.target.x, frame.target.y, frame.target.z);
  scene.userData.crowdViewport = { width: 1280, height: 800 };
  crowds.update(state, 10, null, 1); weightedContract(crowds, scene);
  assert.equal(crowds.diagnostics.visibleWorkerIndividuals, 18); assert.equal(crowds.diagnostics.drawnWorkerModels, 2);
  assert.equal(crowds.diagnostics.workerBadgeCount, 0); assert.equal(crowds.diagnostics.workerBadgeLodCulled, 2);
  const models = crowds.diagnostics.drawnModels;
  crowds.update(state, 10, 'outbound-crew', 1); weightedContract(crowds, scene);
  assert.equal(crowds.diagnostics.drawnModels, models); assert.equal(crowds.diagnostics.workerBadgeCount, 1); assert.equal(crowds.diagnostics.workerBadgeLodCulled, 1);
  const labels = badgeMesh(scene);
  assert.equal(crowds.resolvePick({ object: labels, instanceId: 0 }), 'outbound-crew');
  assert.equal(labels.geometry.attributes.badgeLayout.getX(0), 11);
  assert.ok(crowds.getMotionSamples().find(s => s.groupId === 'outbound-crew').badgeVisible);
  assert.equal(crowds.getMotionSamples().find(s => s.groupId === 'mining-crew').badgeVisible, false);
  crowds.dispose();
});

test('close overlapping crew badges choose stable IDs with selected priority and unchanged people', () => {
  const { state, scene, crowds } = setup(true), camera = scene.userData.camera, worker = state.groups[0];
  returnMilitary(state, state.settlements[0], state.groups[2]);
  state.groups = ['c', 'b', 'a'].map(id => ({ ...worker, id, x: 0, prevX: 0, z: 8, prevZ: 8, size: 5 }));
  state.settlements[0].population = 25;
  camera.position.set(0, 30, 40); camera.lookAt(0, 2, 8);
  crowds.update(state, 10, null, 1); weightedContract(crowds, scene);
  const labels = badgeMesh(scene);
  assert.equal(crowds.diagnostics.visibleWorkerIndividuals, 15); assert.equal(crowds.diagnostics.drawnWorkerModels, 3);
  assert.equal(crowds.diagnostics.workerBadgeCount, 1); assert.equal(crowds.diagnostics.workerBadgeOverlapCulled, 2);
  assert.equal(crowds.resolvePick({ object: labels, instanceId: 0 }), 'a');
  state.groups.reverse(); crowds.update(state, 10, null, 1);
  assert.equal(crowds.resolvePick({ object: labels, instanceId: 0 }), 'a', 'stable result after group iteration order changes');
  crowds.update(state, 10, 'c', 1); weightedContract(crowds, scene);
  assert.equal(crowds.resolvePick({ object: labels, instanceId: 0 }), 'c', 'selection wins overlapping labels');
  assert.equal(crowds.diagnostics.workerBadgeCount, 1); assert.equal(crowds.diagnostics.visibleWorkerIndividuals, 15);
  const before = Array.from(labels.geometry.attributes.badgeAnchor.array);
  crowds.update(state, 10, 'c', 1); assert.equal(crowds.diagnostics.reusedFrame, true);
  assert.deepEqual(Array.from(labels.geometry.attributes.badgeAnchor.array), before);
  crowds.dispose();
});

test('pixel LOD re-evaluates on a paused viewport resize even when labels were hidden', () => {
  const { state, scene, crowds } = setup(true), camera = scene.userData.camera;
  camera.position.set(0, 100, 200); camera.lookAt(0, 2, 8);
  scene.userData.crowdViewport = { width: 1280, height: 800 };
  crowds.update(state, 10, null, 1); assert.ok(crowds.diagnostics.workerBadgeCount > 0);
  const count = crowds.diagnostics.visibleWorkerIndividuals, models = crowds.diagnostics.drawnModels;
  scene.userData.crowdViewport = { width: 640, height: 400 };
  crowds.update(state, 10, null, 1); weightedContract(crowds, scene);
  assert.equal(crowds.diagnostics.reusedFrame, false); assert.equal(crowds.diagnostics.workerBadgeCount, 0);
  assert.equal(crowds.diagnostics.visibleWorkerIndividuals, count); assert.equal(crowds.diagnostics.drawnModels, models);
  scene.userData.crowdViewport = { width: 1280, height: 800 };
  crowds.update(state, 10, null, 1); assert.ok(crowds.diagnostics.workerBadgeCount > 0);
  crowds.dispose();
});
