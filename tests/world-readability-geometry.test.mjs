import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createEntities, defensiveSpan } from '../src/render/entities.js';
import { createTerrain } from '../src/render/terrain.js';
import { createSimulation } from '../src/sim/core.js';
import { biomeAt, heightAt } from '../src/world.js';

function stateFor(species = 'human') {
  const gateFrom = { x: 35, z: 31 }, gateTo = { x: 43, z: 37 };
  const buildings = [
    { id: 'gate', kind: 'gate', from: gateFrom, to: gateTo, gateWidth: 5.5, joins: { from: 'left', to: 'right' } },
    { id: 'left', kind: 'wall', from: { x: 28, z: 31 }, to: gateFrom, joins: { from: 'outer-left', to: 'left' } },
    { id: 'right', kind: 'wall', from: gateTo, to: { x: 47, z: 45 }, joins: { from: 'right', to: 'outer-right' } },
  ].map(b => ({ ...b, x: -100, z: -100, length: 7, rotation: 2, width: 1.2, progress: 1, hp: 240, maxHp: 240, topologyId: 'screen' }));
  return { seed: 'readable-walls', tick: 0, factions: [{ id: 'f', species, color: '#ac896e' }], settlements: [{ id: 'home', factionId: 'f', x: 35, z: 35, population: 100, status: 'active', radius: 8, buildings }], groups: [], nodes: [] };
}
function setup(state) {
  const scene = new THREE.Scene(), renderer = createEntities(THREE, scene);
  renderer.update(state);
  return { scene, renderer };
}
function meshes(scene, prefix) {
  const result = [];
  scene.traverse(mesh => { if (mesh.isInstancedMesh && mesh.count && mesh.name.startsWith(prefix)) result.push(mesh); });
  return result;
}
function castThrough(renderer, span, localX, localY = 1) {
  const x = span.x + Math.cos(span.rotation) * localX, z = span.z - Math.sin(span.rotation) * localX;
  const t = .5 + localX / span.length;
  const y = heightAt(span.from.x, span.from.z, 'readable-walls') * (1 - t) + heightAt(span.to.x, span.to.z, 'readable-walls') * t + localY;
  const forward = new THREE.Vector3(Math.sin(span.rotation), 0, Math.cos(span.rotation));
  const origin = new THREE.Vector3(x, y, z).addScaledVector(forward, -3);
  return new THREE.Raycaster(origin, forward, 0, 6).intersectObjects(renderer.getPickables(), false);
}

for (const species of ['human', 'machine', 'hive']) test(`${species} connected walls render true endpoints, shared joints, and exact open passage`, () => {
  const state = stateFor(species), before = structuredClone(state), { scene, renderer } = setup(state);
  const d = renderer.diagnostics, expectedLength = 10 + 7 + Math.sqrt(80);
  assert.equal(d.wallSegments, 3); assert.equal(d.wallJunctions, 2); assert.equal(d.gatePassages, 1);
  assert.ok(Math.abs(d.wallLength - expectedLength) < 1e-8);
  assert.equal(renderer.getPickables().length, 3);
  const span = defensiveSpan(state.settlements[0].buildings[0]);
  assert.equal(span.length, 10); assert.deepEqual({ x: span.x, z: span.z }, { x: 39, z: 34 });
  for (const mesh of meshes(scene, `building ${species} gate `)) {
    const p = mesh.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) if (p.getY(i) > .05 && p.getY(i) < 2.4) {
      assert.ok(Math.abs(p.getX(i)) >= span.gap / 2 - 1e-5, `gate geometry obstructs passage at ${p.getX(i)}, ${p.getY(i)}`);
    }
    const matrix = new THREE.Matrix4(); mesh.getMatrixAt(0, matrix);
    const from = new THREE.Vector3(-span.length / 2, 0, 0).applyMatrix4(matrix), to = new THREE.Vector3(span.length / 2, 0, 0).applyMatrix4(matrix);
    for (const [actual, expected] of [[from, span.from], [to, span.to]]) {
      assert.ok(Math.hypot(actual.x - expected.x, actual.z - expected.z) < 1e-5, 'mesh endpoints use authoritative topology');
      assert.ok(Math.abs(actual.y - heightAt(expected.x, expected.z, state.terrainSeed || state.seed) - .025) < 1e-5, 'base grades to shared ground elevation');
    }
  }
  assert.equal(castThrough(renderer, span, 0).length, 0, 'gate picking leaves center open');
  assert.equal(castThrough(renderer, span, span.gap / 2 - .05).length, 0, 'full gateWidth stays usable');
  assert.equal(castThrough(renderer, span, span.gap / 2 + .2)[0]?.object.userData.buildingId, 'gate');
  for (const mesh of meshes(scene, `join ${species} wall `)) assert.equal(mesh.count, 4, 'one physical corner post at each unique endpoint');
  assert.deepEqual(state, before, 'geometry and diagnostics never mutate simulation');
  renderer.dispose(); assert.equal(scene.children.length, 0);
});

test('endpoint edits, gate width/open state, damage, construction and ruins invalidate geometry without a cycle', () => {
  const state = stateFor(), { scene, renderer } = setup(state), [gate, left, right] = state.settlements[0].buildings;
  gate.gateWidth = 3; gate.open = true; left.progress = .4; right.hp = 120;
  renderer.update(state);
  assert.equal(renderer.diagnostics.constructionSites, 1); assert.equal(renderer.diagnostics.damagedBuildings, 1);
  assert.equal(renderer.diagnostics.defenseSpans[0].gateWidth, 3); assert.equal(renderer.diagnostics.defenseSpans[0].open, true);
  assert.equal(castThrough(renderer, defensiveSpan(gate), 2)[0]?.object.userData.buildingId, 'gate');
  const wallMeshes = meshes(scene, 'building human wall ');
  assert.ok(wallMeshes.some(m => Array.from(m.geometry.attributes.buildLimit.array.slice(0, m.count)).some(v => Math.abs(v - .92) < 1e-5)), 'real construction height remains in shader attributes');
  assert.ok(wallMeshes.some(m => m.instanceColor.array[0] < .99), 'damage visibly darkens the retained structure');
  gate.progress = .4; renderer.update(state);
  assert.equal(castThrough(renderer, defensiveSpan(gate), 0, 1.15).length, 0, 'construction does not lower a phantom pickable lintel across the passage');
  assert.equal(castThrough(renderer, defensiveSpan(gate), 2, 2).length, 0, 'unbuilt gate posts are not pickable above real completion');
  assert.equal(castThrough(renderer, defensiveSpan(gate), 2, .7)[0]?.object.userData.buildingId, 'gate');
  gate.progress = 1;
  right.to = { x: 50, z: 46 }; renderer.update(state);
  assert.ok(Math.abs(renderer.diagnostics.defenseSpans[2].length - Math.sqrt(130)) < 1e-8);
  right.destroyed = true; right.hp = 0; renderer.update(state);
  assert.equal(renderer.diagnostics.ruinedBuildings, 1); assert.equal(renderer.diagnostics.wallJunctions, 1);
  assert.ok(meshes(scene, 'ruin human wall ').length > 0);
  renderer.update({ ...state, viewer: { mode: 'faction', factionId: 'other' }, settlements: [] });
  assert.equal(renderer.diagnostics.wallSegments, 0); assert.equal(renderer.getPickables().length, 0);
  scene.traverse(m => { if (m.isInstancedMesh) assert.equal(m.count, 0, 'no hidden fortification instances survive view filtering'); });
  renderer.dispose();
});

for (const biome of ['meadow', 'desert', 'alien']) test(`${biome} landscape retains all deposits and only its own biome silhouettes within the decoration budget`, () => {
  const state = createSimulation('first-light', { biome }), before = structuredClone(state), scene = new THREE.Scene(), terrain = createTerrain(THREE, scene, state.seed, state.config);
  terrain.update(0, state);
  const d = terrain.diagnostics;
  assert.equal(d.resourceSites, 160); assert.equal(d.visibleResourceSites, state.nodes.length);
  assert.equal(d.resourcePieces, { meadow: 1606, desert: 1657, alien: 1313 }[biome], 'every deposit retains its complete seeded representation');
  assert.equal(d.visibleResourcePieces, d.resourcePieces);
  assert.ok(d.visibleDecorativePieces < 1800 && d.visibleDecorativePieces > 300, `${d.visibleDecorativePieces} decorative pieces retain atmosphere without blanket noise`);
  assert.ok(d.visibleResourceSiteDetails < 1800, 'deposits no longer carry rings of random pebbles');
  const canopyBiomes = new Set(), matrix = new THREE.Matrix4(), position = new THREE.Vector3();
  scene.traverse(mesh => {
    if (!mesh.isInstancedMesh || mesh.userData.clearanceKind !== 'canopy') return;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, matrix); position.setFromMatrixPosition(matrix); canopyBiomes.add(biomeAt(position.x, position.z, state.terrainSeed));
      for (const node of state.nodes) assert.ok(Math.hypot(position.x - node.x, position.z - node.z) > node.radius + 2.599, 'decorative canopy stays outside worksite access margin');
    }
  });
  assert.deepEqual([...canopyBiomes], [biome]);
  assert.deepEqual(state, before);
  terrain.dispose(); assert.equal(scene.children.length, 0);
});

test('vegetation clears a real screen outside town and restores it when that structure leaves the viewer snapshot', () => {
  const state = createSimulation('readable-clearings'), scene = new THREE.Scene(), terrain = createTerrain(THREE, scene, state.seed), matrix = new THREE.Matrix4();
  terrain.update(0, state);
  let target;
  scene.traverse(mesh => {
    if (target || !mesh.isInstancedMesh || mesh.userData.clearanceKind !== 'canopy' || !mesh.count) return;
    mesh.getMatrixAt(0, matrix); const p = new THREE.Vector3().setFromMatrixPosition(matrix); target = { mesh, x: p.x, z: p.z };
  });
  assert.ok(target, 'fixture needs a real seeded canopy');
  const includesTarget = () => {
    for (let i = 0; i < target.mesh.count; i++) { target.mesh.getMatrixAt(i, matrix); if (Math.hypot(matrix.elements[12] - target.x, matrix.elements[14] - target.z) < .001) return true; }
    return false;
  };
  assert.ok(includesTarget());
  state.settlements[0].buildings.push({ id: 'remote-screen', kind: 'wall', x: target.x, z: target.z, from: { x: target.x - 4, z: target.z }, to: { x: target.x + 4, z: target.z }, length: 8, progress: 1, hp: 100 });
  state.tick++; terrain.update(1, state); assert.equal(includesTarget(), false, 'new wall clears its own footprint beyond town radius');
  const snapshot = structuredClone(state);
  terrain.update(2, { ...state, settlements: state.settlements.slice(1), viewer: { mode: 'faction', factionId: 'other', version: 1 } });
  assert.ok(includesTarget(), 'hidden buildings do not clear or reveal a footprint in faction view');
  assert.deepEqual(state, snapshot);
  terrain.dispose();
});
