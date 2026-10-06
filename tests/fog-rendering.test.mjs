import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createFog } from '../src/render/fog.js';
import { createSimulation } from '../src/sim/core.js';
import { initializeKnowledge, stepKnowledge, factionView, reportObservations, KNOWLEDGE_GRID } from '../src/sim/knowledge.js';

test('fog veil and remembered-place markers are bounded, switch while paused, and never change intelligence', () => {
  const s = createSimulation('fog-geometry'), scene = new THREE.Scene(), fog = createFog(THREE, scene), f = s.factions[0];
  const far = s.settlements[1];
  reportObservations(s, f, [{ id: 'remembered-site', kind: 'resource', resourceKind: 'materials', x: far.x, z: far.z, amountEstimate: 123, observedTick: 0, confidence: .7 }]);
  const before = structuredClone(s);
  fog.update(s, f.id, factionView(s, f.id));
  const root = scene.getObjectByName('Faction fog and remembered places');
  assert.equal(root.visible, true); assert.ok(root.children.length <= 2); assert.equal(fog.diagnostics.drawCalls, 2);
  assert.equal(fog.pickRemembered(far), 'remembered-site');
  assert.equal(root.children[0].geometry.getAttribute('position').count, (KNOWLEDGE_GRID.width * 2 + 1) * (KNOWLEDGE_GRID.height * 2 + 1));
  const texture = root.children[0].material.uniforms.visibilityMap.value;
  assert.equal(texture.image.width, KNOWLEDGE_GRID.width); assert.equal(texture.image.height, KNOWLEDGE_GRID.height);
  assert.ok([...texture.image.data].every(Number.isFinite));
  fog.update(s, 'omniscient');
  assert.equal(root.visible, false); assert.equal(fog.pickRemembered(far), null);
  fog.update(s, s.factions[1].id, factionView(s, s.factions[1].id));
  assert.equal(root.visible, true); assert.equal(fog.pickRemembered(far), null);
  assert.deepEqual(s, before, 'fog render mutated factual state or reports');
  fog.dispose(); assert.equal(scene.children.length, 0);
});

test('a reset replaces fog geometry and leaves no stale place to pick', () => {
  const scene = new THREE.Scene(), fog = createFog(THREE, scene), old = createSimulation('fog-old'), f = old.factions[0];
  reportObservations(old, f, [{ id: 'gone', kind: 'settlement', x: 0, z: 0, ownerId: old.factions[1].id, observedTick: 0, confidence: .8 }]);
  fog.update(old, f.id); assert.ok(fog.getRemembered().some(k => k.id === 'gone'));
  const next = createSimulation('fog-new'); initializeKnowledge(next, { reset: true }); stepKnowledge(next, { force: true });
  fog.update(next, next.factions[0].id);
  assert.ok(!fog.getRemembered().some(k => k.id === 'gone'));
  fog.dispose();
});
