import test from 'node:test';
import assert from 'node:assert/strict';
import { createBattle, stepBattle, getBattleView, issueBattleOrder } from '../src/battle/sim.js';

// Independent integration invariants, deliberately separate from the ordinary
// seeded fights in battle-audit.mjs and the simulation's tactical unit tests.
function isolatedBattle(seed = 'independent-micro', perSide = 3) {
  const state = createBattle(seed, { perSide });
  state.obstacles = [];
  for (const [index, unit] of state.units.entries()) {
    Object.assign(unit, { x: unit.team === 'blue' ? -30 : 30, z: (index % perSide) * 3 - 3,
      vx: 0, vz: 0, targetId: null, attackReadyAt: 1e6,
      withdrawing: false });
    unit.prevX = unit.x; unit.prevZ = unit.z;
    unit.order = { type: 'hold', x: unit.x, z: unit.z };
  }
  return state;
}

const ownUnits = state => state.units.filter(unit => unit.team === 'blue');
const ownEvents = state => state.events.filter(event =>
  ownUnits(state).some(unit => unit.id === (event.sourceId ?? event.unitId)));

test('never-visible enemy changes do not alter blue decisions or the complete blue view', () => {
  const original = isolatedBattle('hidden-information-independence');
  const observer = ownUnits(original)[0];
  const visibleEnemy = original.units.find(unit => unit.team === 'red');
  Object.assign(visibleEnemy, { x: observer.x + 7, z: observer.z, prevX: observer.x + 7, prevZ: observer.z });
  visibleEnemy.order = { type: 'hold', x: visibleEnemy.x, z: visibleEnemy.z };
  stepBattle(original, .1);
  const hiddenIds = original.units.filter(unit => unit.team === 'red' && unit !== visibleEnemy).map(unit => unit.id);
  const firstView = getBattleView(original, 'blue');
  assert.ok(firstView.units.some(unit => unit.id === visibleEnemy.id), 'fixture must contain a visible enemy');
  assert.ok(hiddenIds.every(id => !firstView.units.some(unit => unit.id === id)), 'fixture enemies must really be hidden');

  const changed = structuredClone(original);
  for (const [index, id] of hiddenIds.entries()) {
    const enemy = changed.units.find(unit => unit.id === id);
    Object.assign(enemy, { x: 31 - index, z: 10 + index * 2,
      prevX: 31 - index, prevZ: 10 + index * 2,
      hp: Math.max(1, Math.floor(enemy.maxHp * .4)), attackReadyAt: 9876,
      targetId: observer.id, order: { type: 'move', x: 29, z: 15 },
      action: 'hidden-private-action', reason: 'HIDDEN_PRIVATE_REASON' });
  }
  assert.deepEqual(getBattleView(changed, 'blue'), getBattleView(original, 'blue'),
    'the public view leaked never-visible enemy truth before the next step');
  for (let frame = 0; frame < 20; frame++) {
    stepBattle(original, .1); stepBattle(changed, .1);
    assert.deepEqual(ownUnits(changed), ownUnits(original), `hidden state affected own units at frame ${frame}`);
    assert.deepEqual(ownEvents(changed), ownEvents(original), `hidden state affected own event trace at frame ${frame}`);
    assert.deepEqual(getBattleView(changed, 'blue'), getBattleView(original, 'blue'),
      `the blue view leaked hidden state at frame ${frame}`);
    assert.ok(hiddenIds.every(id => !getBattleView(changed, 'blue').units.some(unit => unit.id === id)),
      'hidden fixture entered sight; this would invalidate the metamorphic comparison');
  }
});

test('unseen enemy deaths cannot disclose their identities through the team view', () => {
  const original = isolatedBattle('hidden-casualty-independence');
  stepBattle(original, .1);
  const changed = structuredClone(original);
  const enemy = changed.units.find(unit => unit.team === 'red');
  const viewBefore = getBattleView(original, 'blue');
  assert.ok(!viewBefore.units.some(unit => unit.id === enemy.id), 'casualty fixture must be unseen');
  enemy.hp = 0; enemy.alive = false;
  assert.deepEqual(getBattleView(changed, 'blue'), viewBefore,
    'a never-observed casualty changed the visible report');
  stepBattle(original, .1); stepBattle(changed, .1);
  assert.deepEqual(ownUnits(changed), ownUnits(original), 'unseen casualty changed own tactical decisions');
  assert.deepEqual(getBattleView(changed, 'blue'), getBattleView(original, 'blue'),
    'a never-observed casualty leaked after perception refreshed');
});

test('an unseen observer cannot reveal enemy sight through public event metadata', () => {
  const original = isolatedBattle('asymmetric-observer-metadata');
  for (const [index, unit] of original.units.entries()) {
    Object.assign(unit, { x: unit.team === 'blue' ? -28 : 28, z: -20 + (index % 3) * 3 });
    unit.prevX = unit.x; unit.prevZ = unit.z;
    unit.order = { type: 'hold', x: unit.x, z: unit.z };
  }
  const changed = structuredClone(original);
  const hiddenObserver = changed.units.find(unit => unit.team === 'red');
  Object.assign(hiddenObserver, { x: -9, z: -20, prevX: -9, prevZ: -20, sight: 20,
    order: { type: 'hold', x: -9, z: -20 } });
  stepBattle(original, .1); stepBattle(changed, .1);
  const originalView = getBattleView(original, 'blue'), changedView = getBattleView(changed, 'blue');
  assert.ok(!changedView.units.some(unit => unit.id === hiddenObserver.id), 'the long-sight observer must remain unseen');
  assert.deepEqual(ownUnits(changed), ownUnits(original), 'an unseen observer affected blue behavior');
  assert.deepEqual(changedView, originalView, 'public metadata disclosed another team’s private field of view');
});

test('a visible enemy does not expose its private attack clock or pursuit planning event', () => {
  const state = isolatedBattle('visible-enemy-private-intent');
  const observer = ownUnits(state)[0], enemy = state.units.find(unit => unit.team === 'red');
  Object.assign(observer, { x: 0, z: 0, prevX: 0, prevZ: 0, vx: -2.75, vz: 0,
    role: 'infantry', speed: 2.75, order: { type: 'retreat', x: -29, z: 0 } });
  Object.assign(enemy, { x: 4, z: 0, prevX: 4, prevZ: 0, role: 'scout', speed: 4.25,
    attackRange: 1.42, order: { type: 'auto' } });
  stepBattle(state, .1);
  const view = getBattleView(state, 'blue');
  const observed = view.units.find(unit => unit.id === enemy.id);
  assert.ok(observed, 'the enemy must be visible to test private-field redaction');
  assert.ok(state.events.some(event => event.type === 'decision' && event.sourceId === enemy.id && event.intercept),
    'the simulation must actually create a private predictive-pursuit decision');
  for (const key of ['attackReadyAt', 'targetSince', 'nextDecisionAt', 'intercept', 'withdrawSince']) {
    assert.equal(observed[key], undefined, `visible enemy exposed private ${key}`);
  }
  for (const event of view.events.filter(event => event.type === 'decision' && event.sourceId === enemy.id)) {
    for (const key of ['intercept', 'targetVX', 'targetVZ', 'pursuerSpeed', 'order', 'detail', 'reason']) {
      assert.equal(event[key], undefined, `visible enemy decision exposed private ${key}`);
    }
  }
  const changed = structuredClone(state);
  const privateEnemy = changed.units.find(unit => unit.id === enemy.id);
  privateEnemy.attackReadyAt += 321; privateEnemy.targetSince += 10; privateEnemy.nextDecisionAt += 10;
  assert.deepEqual(getBattleView(changed, 'blue'), view,
    'changing only visible enemy private timers changed its public observation');
});

test('an exact selected casualty retains its ID, location, and record while a peer remains intact', () => {
  const state = isolatedBattle('selected-individual-ledger', 2);
  const attacker = ownUnits(state)[0];
  const [untouchedPeer, selected] = state.units.filter(unit => unit.team === 'red');
  Object.assign(attacker, { role: 'ranged', x: -8, z: 0, prevX: -8, prevZ: 0,
    attackReadyAt: 0, attackRange: 12, attackDamage: 50, attackCooldown: 2,
    order: { type: 'attack', targetId: selected.id } });
  Object.assign(selected, { x: -3, z: 0, prevX: -3, prevZ: 0, hp: 3, maxHp: 3,
    attackReadyAt: 1e6, order: { type: 'hold', x: -3, z: 0 } });
  const selectedId = selected.id, selectedReference = selected;
  const peerHp = untouchedPeer.hp, allIds = state.units.map(unit => unit.id);
  for (let tick = 0; tick < 50 && selected.alive; tick++) stepBattle(state, .1);
  assert.equal(selected.alive, false, 'fixture failed to kill the selected individual');
  assert.equal(selected.hp, 0);
  const deathPosition = { x: selected.x, z: selected.z };
  assert.deepEqual(state.units.map(unit => unit.id), allIds, 'death reordered or removed stable individual IDs');
  assert.equal(state.units.find(unit => unit.id === selectedId), selectedReference, 'selection now refers to a different unit');
  assert.equal(untouchedPeer.hp, peerHp, 'damage spilled into an unrelated individual');
  const impacts = state.events.filter(event => event.type === 'impact' && event.targetId === selectedId);
  assert.equal(impacts.reduce((damage, event) => damage + event.damage, 0), 3,
    'actual impact ledger must account for exactly the selected individual’s remaining HP');
  assert.equal(state.events.filter(event => event.type === 'death' && (event.targetId ?? event.unitId) === selectedId).length, 1);
  assert.ok(getBattleView(state, 'all').units.some(unit => unit.id === selectedId && !unit.alive),
    'observer selection cannot inspect the exact casualty');

  issueBattleOrder(state, [selectedId], { type: 'move', x: 0, z: 15 });
  for (let tick = 0; tick < 20; tick++) stepBattle(state, .1);
  assert.equal(state.units.find(unit => unit.id === selectedId), selectedReference);
  assert.deepEqual({ x: selected.x, z: selected.z }, deathPosition, 'issuing an order moved a casualty');
  assert.equal(selected.hp, 0); assert.equal(selected.alive, false);
  assert.equal(untouchedPeer.hp, peerHp);
});

test('fog-filtered views cannot mutate authoritative unit health or commands', () => {
  const state = isolatedBattle('view-isolation');
  stepBattle(state, .1);
  const unit = ownUnits(state)[0], hp = unit.hp;
  const order = structuredClone(unit.order);
  const view = getBattleView(state, 'blue');
  const exposed = view.units.find(candidate => candidate.id === unit.id);
  for (const change of [() => { exposed.hp = 0; }, () => {
    if (exposed.order) { exposed.order.type = 'move'; exposed.order.x = 0; }
    else exposed.order = { type: 'move', x: 0, z: 0 };
  }]) {
    try { change(); } catch (error) { assert.ok(error instanceof TypeError, 'only immutable-view writes may be rejected'); }
  }
  assert.equal(unit.hp, hp, 'presentation mutated authoritative HP through a shared unit');
  assert.deepEqual(unit.order, order, 'presentation mutated the authoritative command through a shared unit');
});
