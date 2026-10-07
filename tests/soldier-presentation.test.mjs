import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { parseHTML } from 'linkedom';
import { createCrowds } from '../src/render/crowds.js';
import { createCombatEffects } from '../src/render/combat.js';
import { findObserved, observedSoldier, SelectionMemory } from '../src/selection.js';
import { createUI } from '../src/ui.js';

function soldier(id, role, groupId, x, z = 0) {
  return { id, role, groupId, originId: 'home', nativeFactionId: 'native', factionId: 'native', commandFactionId: 'commander', species: 'machine', status: 'serving', alive: true, positioned: true, hp: 61, maxHp: 120, x, z, prevX: x - .4, prevZ: z, yaw: 1, prevYaw: .8, action: 'holding', targetId: 'target', reasonCode: 'hold_contact', attackReadyAt: 10.5, lastAttackTime: 9.9, lastHitTime: 9.8 };
}
function fixture() {
  return { seed: 'persistent-render', tick: 10, step: 100, time: 10, config: { civCount: 3 },
    factions: [{ id: 'commander', name: 'Command', species: 'human', color: '#dca16b' }, { id: 'native', name: 'Native', species: 'machine', color: '#85bbbf' }],
    settlements: [{ id: 'home', name: 'Native home', factionId: 'native', occupiedBy: 'commander', x: 0, z: 0, population: 8, soldiers: 3, military: { infantry: 2, ranged: 1 }, assigned: {}, buildings: [] }],
    groups: [{ id: 'army', kind: 'army', originId: 'home', factionId: 'native', commandFactionId: 'commander', size: 2, units: { infantry: 1, ranged: 1 }, x: 12, z: 0, phase: 'outbound' }, { id: 'crew', kind: 'worker', originId: 'home', factionId: 'native', size: 3, x: 6, z: 0, phase: 'working' }],
    soldiers: [soldier('persistent-front', 'infantry', 'army', 11), soldier('persistent-back', 'ranged', 'army', 14), soldier('persistent-home', 'infantry', null, 3)], nodes: [], events: [], knownPlaces: [], combatEvents: [] };
}
function renderedIds(crowds) { return crowds.getPickables().flatMap(mesh => (mesh.userData.crowdSelectionIds || []).slice(0, mesh.count)); }

test('persistent bodies use saved individual transforms, command tint and exact casualty identity', () => {
  const state = fixture(), scene = new THREE.Scene(), crowds = createCrowds(THREE, scene), before = structuredClone(state);
  crowds.update(state, 10, 'persistent-front', .5); scene.updateMatrixWorld(true);
  assert.deepEqual(state, before); assert.equal(crowds.diagnostics.populationAccountingDelta, 0);
  assert.equal(crowds.diagnostics.militaryIndividuals, 3); assert.equal(crowds.diagnostics.drawnWorkerModels, 1);
  for (const person of state.soldiers) {
    const sample = crowds.getMotionSamples().find(body => body.id === person.id);
    assert.ok(sample); assert.equal(sample.x, (person.prevX + person.x) / 2); assert.equal(sample.z, person.z); assert.equal(sample.heading, .9);
    assert.match(sample.poolKey, /^machine:/);
    const mesh = scene.getObjectByProperty('uuid', sample.meshUuid), actual = new THREE.Color(); mesh.getColorAt(sample.instanceIndex, actual);
    const expected = new THREE.Color(state.factions[0].color).lerp(new THREE.Color('#f0e5ca'), .12);
    assert.ok(actual.toArray().every((n, i) => Math.abs(n - expected.toArray()[i]) < 1e-6));
    const ray = new THREE.Raycaster(new THREE.Vector3(sample.x, sample.groundY + 8, sample.z), new THREE.Vector3(0, -1, 0));
    const hit = ray.intersectObject(mesh).find(hit => hit.instanceId === sample.instanceIndex); assert.ok(hit); assert.equal(crowds.resolvePick(hit), person.id);
  }
  assert.ok(!crowds.getPickables().some(mesh => mesh.userData.groupId === 'army'), 'a broad proxy must not mask a soldier click');
  const survivor = crowds.getMotionSamples().find(body => body.id === 'persistent-back');
  Object.assign(state.soldiers[0], { hp: 0, alive: false, status: 'dead' }); state.groups[0].size--; state.settlements[0].population--;
  crowds.update(state, 10, 'persistent-front', .5);
  assert.equal(crowds.diagnostics.reusedFrame, false); assert.ok(!renderedIds(crowds).includes('persistent-front'));
  assert.equal(crowds.getMotionSamples().find(body => body.id === survivor.id).x, survivor.x); assert.equal(crowds.diagnostics.populationAccountingDelta, 0);
  assert.equal(findObserved(state, 'persistent-front').hp, 0, 'the exact recent death stays inspectable');
  const memory = new SelectionMemory(); memory.record(state, 'persistent-front');
  state.soldiers.shift(); assert.equal(memory.reconcile(state, 'persistent-front'), 'army');
  state.groups.shift(); assert.equal(memory.reconcile(state, 'army'), 'home');
  crowds.dispose();
});

test('scoped soldier projections never consult hidden native ledgers or invent unseen bodies', () => {
  const state = fixture(), hidden = state.soldiers[0], visible = { ...state.soldiers[1], originId: null, knowledgeView: 'visible' };
  delete visible.hp; delete visible.maxHp; delete visible.targetId; delete visible.reasonCode; delete visible.attackReadyAt;
  const scoped = { ...state, viewer: { mode: 'faction', factionId: 'commander' }, settlements: [], groups: [{ ...state.groups[0], originId: null, size: 1 }], soldiers: [visible] };
  const scene = new THREE.Scene(), crowds = createCrowds(THREE, scene); crowds.update(scoped, 10, visible.id);
  assert.deepEqual(renderedIds(crowds), [visible.id]); assert.equal(crowds.diagnostics.populationAccountingDelta, 0);
  assert.equal(observedSoldier(scoped, hidden.id), null); assert.equal(findObserved(scoped, hidden.id), undefined);
  scoped.soldiers = []; scoped.settlements = [{ ...state.settlements[0], population: 0, soldierRoster: [hidden] }];
  crowds.update(scoped, 10, hidden.id); assert.equal(crowds.diagnostics.militaryIndividuals, 0); assert.ok(!renderedIds(crowds).includes(hidden.id));
  crowds.dispose();
});

test('individual inspection shows saved health and party navigation while foreign tabs redact private state', () => {
  const state = fixture(), { document, window } = parseHTML('<html><body><div id="ui"></div></body></html>');
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value');
  if (!descriptor?.set) Object.defineProperty(window.HTMLSelectElement.prototype, 'value', { configurable: true, get: descriptor.get, set(value) { for (const option of this.querySelectorAll('option')) option.removeAttribute('selected'); [...this.querySelectorAll('option')].find(option => option.value === String(value))?.setAttribute('selected', ''); } });
  const previous = globalThis.document; globalThis.document = document;
  const root = document.getElementById('ui'), calls = [], view = { selectedId: state.soldiers[0].id, perspective: 'omniscient', paused: true, speed: 1, quality: 'low' };
  const ui = createUI(root, { select(id) { calls.push(id); } });
  try {
    ui.update(state, view); assert.match(root.querySelector('.soldier-detail').textContent, /Health61 \/ 120/);
    assert.match(root.querySelector('.selection-header').textContent, /Brace walker/);
    assert.equal(root.querySelector('[data-action="follow"]').dataset.value, state.soldiers[0].id);
    root.querySelector('.soldier-detail [data-value="army"]').dispatchEvent(new window.Event('click', { bubbles: true })); assert.deepEqual(calls, ['army']);
    Object.assign(state.soldiers[0], { hp: 0, alive: false, status: 'dead' }); ui.update(state, view);
    assert.match(root.querySelector('.soldier-detail').textContent, /Health0 \/ 120.*ActionFallen/);
    assert.doesNotMatch(root.querySelector('.soldier-detail').textContent, /Weapon|Ready in/);
    assert.equal(root.querySelector('[data-action="follow"]').dataset.value, state.soldiers[0].id);
    state.viewer = { mode: 'faction', factionId: 'native' }; state.soldiers[0].knowledgeView = 'visible';
    Object.assign(state.soldiers[0], { hp: 987654, targetId: 'SECRET_TARGET', reasonCode: 'SECRET_PLAN', attackReadyAt: 876543 });
    for (const tab of ['life', 'intelligence', 'record']) {
      ui.update(state, view); root.querySelector(`[data-action="tab"][data-value="${tab}"]`).dispatchEvent(new window.Event('click', { bubbles: true }));
      assert.match(root.querySelector('.soldier-detail').textContent, /Visible soldier/);
      assert.doesNotMatch(root.querySelector('.inspector').textContent, /987654|876543|SECRET_TARGET|SECRET_PLAN/);
    }
  } finally { ui.dispose(); if (previous === undefined) delete globalThis.document; else globalThis.document = previous; }
});

test('death effects preserve the actual dead soldier and recorded death coordinates', () => {
  const state = fixture(); state.combatEvents = [{ id: 'death', type: 'casualty', time: 10, expiresAt: 12.2, targetId: 'army', targetSoldierId: 'persistent-front', species: 'machine', factionId: 'commander', positions: [{ soldierId: 'persistent-front', x: 11, z: 3, yaw: 1 }] }];
  const effects = createCombatEffects(THREE, new THREE.Scene()); effects.update(state, 10.2);
  assert.equal(effects.diagnostics.casualties, 1); assert.deepEqual(effects.getMotionSamples().map(({ soldierId, deathX, deathZ }) => ({ soldierId, deathX, deathZ })), [{ soldierId: 'persistent-front', deathX: 11, deathZ: 3 }]); effects.dispose();
});

test('observer snapshots preserve world caches and a same-seed new world resets them', () => {
  const state = fixture(); state.renderWorldId = 1;
  const crowds = createCrowds(THREE, new THREE.Scene()); crowds.update(state, 10, null, 1);
  const initialSamples = crowds.diagnostics.terrainCacheSamples;
  const next = structuredClone(state); next.soldiers[0].x = next.soldiers[0].prevX = 1000;
  crowds.update(next, 10, null, 1);
  assert.ok(crowds.diagnostics.terrainCacheSamples > initialSamples, 'a projection identity change discarded reusable terrain samples');
  const accumulated = crowds.diagnostics.terrainCacheSamples;
  next.renderWorldId = 2; crowds.update(next, 10, null, 1);
  assert.ok(crowds.diagnostics.terrainCacheSamples < accumulated, 'a new same-seed world retained the previous world cache');
  crowds.dispose();
});

test('six thousand persistent soldiers remain individually pickable in bounded instanced pools', t => {
  const state = fixture(); state.groups = [state.groups[0]]; state.groups[0].size = 6000; state.settlements[0].population = 6000;
  state.soldiers = Array.from({ length: 6000 }, (_, i) => soldier(`late-${i}`, i % 3 ? 'infantry' : 'ranged', 'army', i % 100 * .55 + 1, Math.floor(i / 100) * .55 + 1));
  const crowds = createCrowds(THREE, new THREE.Scene()), started = performance.now(); crowds.update(state, 10, 'late-5999', 1); const elapsed = performance.now() - started;
  assert.equal(crowds.diagnostics.instances, 6000); assert.equal(new Set(renderedIds(crowds)).size, 6000); assert.ok(crowds.diagnostics.drawCallsEstimate <= 5); assert.equal(crowds.diagnostics.populationAccountingDelta, 0);
  assert.ok(crowds.getMotionSamples().some(body => body.id === 'late-5999'), 'selected bodies remain sampled beyond the diagnostic cap');
  crowds.update(state, 10, 'late-5999', 1); assert.equal(crowds.diagnostics.reusedFrame, true);
  t.diagnostic(`6,000 persistent bodies: ${elapsed.toFixed(1)} ms initial submission, ${crowds.diagnostics.drawCallsEstimate} draws`); crowds.dispose();
});
