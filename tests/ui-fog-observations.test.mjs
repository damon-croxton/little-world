import { setMilitary, bindArmy } from './roster-fixtures.mjs';
// Independent DOM/knowledge contract checks. These do not render CSS, WebGL, or
// native mobile gestures; the fixtures pass through the real factionView filter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createSimulation } from '../src/sim/core.js';
import { initializeKnowledge, stepKnowledge, factionView } from '../src/sim/knowledge.js';
import { createUI } from '../src/ui.js';

function setup(state, factionId, selectedId) {
  const { document, window } = parseHTML('<html><body><div id="ui"></div></body></html>');
  const proto = window.HTMLSelectElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  if (!descriptor?.set) Object.defineProperty(proto, 'value', {
    configurable: true, get: descriptor.get,
    set(value) {
      for (const option of this.querySelectorAll('option')) option.removeAttribute('selected');
      [...this.querySelectorAll('option')].find(option => option.value === String(value))?.setAttribute('selected', '');
    },
  });
  const previousDocument = globalThis.document;
  globalThis.document = document;
  const root = document.getElementById('ui');
  const ui = createUI(root, {});
  const scoped = factionView(state, factionId);
  const view = { worldGeneration: 0, selectedId, perspective: factionId, perspectiveOptions: state.factions, speed: 2, paused: true, quality: 'low' };
  ui.update(scoped, view);
  return {
    scoped, root,
    text() { return root.querySelector('.inspector').textContent; },
    tab(value) { root.querySelector(`[data-action="tab"][data-value="${value}"]`).dispatchEvent(new window.Event('click', { bubbles: true })); },
    dispose() { ui.dispose(); if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument; },
  };
}

function fixture() {
  const state = createSimulation('ui-observation-review', { civCount: 3 });
  state.groups = [];
  // Clearing buildings removes incidental line-of-sight occluders without
  // replacing the seeded terrain or knowledge pipeline.
  for (const home of state.settlements) { home.buildings = []; home.sightRadius = 12; }
  state.settlements[0].stock.materials = 543210;
  state.factions[1].history = [{ tick: 0, text: 'PRIVATE_NATIVE_ARCHIVE' }];
  initializeKnowledge(state, { reset: true });
  return state;
}

test('a visible foreign party never borrows the first owned home or invents its private gauges', () => {
  const state = fixture(), [home, enemyHome] = state.settlements;
  const enemy = { id: 'observed-enemy', factionId: enemyHome.factionId, originId: enemyHome.id,
    kind: 'army', size: 12, units: { infantry: 8, ranged: 4 }, x: home.x + 2, z: home.z,
    phase: 'outbound', supply: 83, morale: 79, targetId: home.id, targetX: home.x, targetZ: home.z };
  setMilitary(state, enemyHome, enemy.units); bindArmy(state, enemyHome, enemy);
  state.groups.push(enemy);
  stepKnowledge(state, { force: true });
  const t = setup(state, home.factionId, enemy.id);
  try {
    const observation = t.scoped.groups.find(group => group.id === enemy.id);
    assert.ok(observation, 'The fixture must produce a genuinely visible foreign party');
    assert.equal(observation.originId, null);
    assert.equal(observation.supply, undefined);
    assert.match(t.text(), /Observed contact/);
    for (const tab of ['life', 'intelligence', 'record']) {
      t.tab(tab);
      assert.match(t.text(), /Only observable details are available/);
      assert.doesNotMatch(t.text(), /543,210|Supplies0%|Morale0%|Home population|Stores & carrying limits|AdaptationTier|PRIVATE_NATIVE_ARCHIVE/);
    }
  } finally { t.dispose(); }
});

test('locally controlled captive workers with redacted origins do not inherit an unrelated home', () => {
  const state = fixture(), [capital, occupied] = state.settlements;
  occupied.occupiedBy = capital.factionId;
  const workers = { id: 'controlled-captive-workers', factionId: occupied.factionId,
    originId: occupied.id, kind: 'worker', size: 5, x: occupied.x + 2, z: occupied.z,
    phase: 'working', supply: 71, morale: 76, carrying: { food: 0, water: 0, energy: 0, materials: 18 } };
  state.groups.push(workers);
  stepKnowledge(state, { force: true });
  const t = setup(state, capital.factionId, workers.id);
  try {
    const controlled = t.scoped.groups.find(group => group.id === workers.id);
    assert.ok(controlled, 'The fixture must produce locally controlled workers');
    assert.equal(controlled.controllerId, capital.factionId);
    assert.equal(controlled.knowledgeControl, 'occupied');
    assert.equal(controlled.originId, null);
    assert.match(t.root.querySelector('[data-slot="selection-header"]').textContent, /Worker party/);
    assert.doesNotMatch(t.root.querySelector('[data-slot="selection-header"]').textContent, /Observed settlement/);
    for (const tab of ['life', 'intelligence', 'record']) {
      t.tab(tab);
      assert.doesNotMatch(t.text(), /543,210|Home population|Stores & carrying limits|AdaptationTier|PRIVATE_NATIVE_ARCHIVE/);
    }
  } finally { t.dispose(); }
});

test('native owned parties retain their actual origin census and stores', () => {
  const state = fixture(), [home] = state.settlements;
  const workers = { id: 'owned-workers', factionId: home.factionId, originId: home.id,
    kind: 'worker', size: 5, x: home.x + 2, z: home.z, phase: 'returning', supply: 71,
    morale: 76, carrying: { food: 0, water: 0, energy: 0, materials: 18 } };
  state.groups.push(workers);
  stepKnowledge(state, { force: true });
  const t = setup(state, home.factionId, workers.id);
  try {
    assert.equal(t.scoped.groups.find(group => group.id === workers.id).originId, home.id);
    assert.match(t.text(), /Home population/);
    assert.match(t.text(), /543,210/);
    assert.match(t.text(), /Supplies71%/);
    assert.match(t.text(), /Morale76%/);
  } finally { t.dispose(); }
});
