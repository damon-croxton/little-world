import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createUI } from '../src/ui.js';
import { createSimulation } from '../src/sim/core.js';

// DOM identity regressions only. Browser actionability and real keyboard focus
// remain covered by browser QA; Linkedom supplies neither layout nor focus.
function setup() {
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
  const state = createSimulation('ui-stability', { civCount: 4 });
  const view = { worldGeneration: 0, selectedId: state.settlements[0].id, followId: null, speed: 2, paused: true, quality: 'low', perspective: 'omniscient', perspectiveOptions: state.factions };
  const followed = [];
  const ui = createUI(root, {
    follow(id) { followed.push(id); view.followId = id; ui.update(state, view); },
    select(id) { view.selectedId = id; ui.update(state, view); },
  });
  ui.update(state, view);
  return {
    root, state, view, followed,
    update() { ui.update(state, view); },
    click(button) { button.dispatchEvent(new window.Event('click', { bubbles: true })); },
    dispose() { ui.dispose(); if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument; },
  };
}

test('unchanged observer markup preserves live control nodes despite HTML serialization', () => {
  const t = setup();
  try {
    const factions = [...t.root.querySelectorAll('.faction-entry')];
    const follow = t.root.querySelector('[data-action="follow"]');
    t.click(t.root.querySelector('#atlas-tab-intelligence'));
    const showMap = t.root.querySelector('.selection-body [data-action="overlay"]');
    assert.ok(showMap.querySelector('svg'), 'The unchanged content includes normalized SVG markup');
    for (let i = 0; i < 20; i++) {
      t.update();
      assert.equal(t.root.querySelector('[data-action="follow"]'), follow);
      assert.equal(t.root.querySelector('.selection-body [data-action="overlay"]'), showMap);
      const updatedFactions = [...t.root.querySelectorAll('.faction-entry')];
      factions.forEach((button, index) => assert.equal(updatedFactions[index], button));
    }
  } finally { t.dispose(); }
});

test('party follow control stays attached while elapsed cycles, cargo and follow state change', () => {
  const t = setup();
  try {
    const home = t.state.settlements[0];
    const party = { id: 'stability-party', factionId: home.factionId, originId: home.id, kind: 'worker', size: 5, phase: 'working', createdTick: 0, supply: 80, morale: 75, carrying: { materials: 0 }, capacity: 40 };
    t.state.groups.push(party);
    t.view.selectedId = party.id;
    t.update();
    const follow = t.root.querySelector('[data-action="follow"]');
    for (let tick = 1; tick <= 8; tick++) {
      t.state.tick = tick;
      party.carrying.materials = tick;
      t.update();
      assert.equal(t.root.querySelector('[data-action="follow"]'), follow);
      assert.equal(follow.isConnected, true);
      assert.equal(follow.dataset.value, party.id);
      assert.match(t.root.querySelector('.selection-actions').textContent, new RegExp(`Cycle ${tick} afield`));
    }
    t.click(follow);
    assert.equal(follow.getAttribute('aria-pressed'), 'true');
    assert.equal(follow.querySelector('span').textContent, 'Following');
    assert.equal(t.root.querySelector('[data-action="follow"]'), follow);
    t.click(follow);
    assert.equal(follow.getAttribute('aria-pressed'), 'false');
    assert.equal(follow.querySelector('span').textContent, 'Follow party');
    assert.deepEqual(t.followed, [party.id, null]);
  } finally { t.dispose(); }
});

test('stable follow control updates its target and label across settlement, worksite and memory views', () => {
  const t = setup();
  try {
    const follow = t.root.querySelector('[data-action="follow"]');
    assert.equal(follow.disabled, false);
    assert.equal(follow.querySelector('span').textContent, 'Follow settlement');
    t.click(follow);
    assert.equal(follow.querySelector('span').textContent, 'Following');
    const resource = t.state.nodes[0];
    t.view.selectedId = resource.id;
    t.update();
    assert.equal(t.root.querySelector('[data-action="follow"]'), follow);
    assert.equal(follow.dataset.value, resource.id);
    assert.equal(follow.getAttribute('aria-pressed'), 'false');
    assert.equal(follow.querySelector('span').textContent, 'View worksite');
    t.click(follow);
    assert.equal(follow.querySelector('span').textContent, 'Following site');
    t.state.knownPlaces = [{ id: 'old-survey', kind: 'resource', resourceKind: 'materials', amountEstimate: 42, observedTick: 0 }];
    t.view.selectedId = 'old-survey';
    t.update();
    assert.equal(t.root.querySelector('[data-action="follow"]'), follow);
    assert.equal(follow.dataset.value, 'old-survey');
    assert.equal(follow.querySelector('span').textContent, 'View last location');
    t.click(follow);
    assert.equal(follow.getAttribute('aria-pressed'), 'true');
    assert.deepEqual(t.followed, [t.state.settlements[0].id, resource.id, 'old-survey']);
  } finally { t.dispose(); }
});
