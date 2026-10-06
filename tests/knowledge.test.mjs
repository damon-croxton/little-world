import test from 'node:test';
import assert from 'node:assert/strict';
import { createSimulation, stepSimulation } from '../src/sim/core.js';
import { initializeLedger, ledgerResidual } from '../src/sim/economy.js';
import { initializeKnowledge, stepKnowledge, knownReports, knownResourceNodes, factionView, reportObservations, visibleToGroup, isExplored, knowledgeCell, KNOWLEDGE_GRID } from '../src/sim/knowledge.js';

function fixture(seed = 'knowledge-fixture') {
  const state = createSimulation(seed);
  state.factions = state.factions.slice(0, 2); state.settlements = state.settlements.filter(h => state.factions.some(f => f.id === h.factionId));
  state.groups = []; state.nodes = []; state.events = []; state.tradeOffers = [];
  for (const home of state.settlements) { home.sightRadius = 8; home.radius = 4; home.buildings = []; }
  state.terrain.passes = [];
  initializeKnowledge(state, { reset: true });
  return state;
}
function tick(state, count = 1) { state.step += count * 10; state.tick += count; state.time = state.step / 10; stepKnowledge(state, { force: true }); }
function node(id, point, amount = 400) { return { id, ...point, kind: 'materials', subtype: 'ore', amount, maxAmount: 1000, richness: .8, regeneration: 0, radius: 2 }; }
function scout(state, id, point) {
  const [f] = state.factions, [home] = state.settlements;
  return { id, factionId: f.id, originId: home.id, kind: 'scout', size: 4, x: point.x, z: point.z, sightRadius: 8, phase: 'outbound', observations: [] };
}

test('factions have different current and explored views; omniscient view does not alter knowledge', () => {
  const s = fixture(), [a, b] = s.factions, [ha, hb] = s.settlements;
  s.nodes = [node('near-a', { x: ha.x + 3, z: ha.z }), node('near-b', { x: hb.x + 3, z: hb.z })];
  stepKnowledge(s, { force: true });
  const before = structuredClone(s);
  const av = factionView(s, a.id), bv = factionView(s, b.id);
  assert.deepEqual(av.nodes.map(n => n.id), ['near-a']); assert.deepEqual(bv.nodes.map(n => n.id), ['near-b']);
  assert.equal(av.settlements.length, 1); assert.equal(bv.settlements.length, 1);
  assert.notDeepEqual(a.visibility.visible, b.visibility.visible);
  assert.equal(factionView(s), s); assert.equal(factionView(s, 'omniscient'), s);
  assert.deepEqual(s, before, 'render view lookup mutated simulation or reports');
});

test('remote sight stays with a scout until its map and observations are actually reported', () => {
  const s = fixture(), [f] = s.factions, [, remote] = s.settlements;
  // Observe in another starting clearing; the home cannot share this LOS.
  s.nodes = [node('remote-ore', { x: remote.x + 3, z: remote.z })];
  const g = scout(s, 'field-scout', remote); s.groups.push(g);
  stepKnowledge(s, { force: true });
  assert.ok(g.observations.some(o => o.id === 'remote-ore'));
  assert.ok(factionView(s, f.id).nodes.some(n => n.id === 'remote-ore'));
  assert.ok(!knownResourceNodes(s, f).some(n => n.id === 'remote-ore'), 'unreturned field sight became a harvest target');
  assert.equal(isExplored(s, f, remote), false, 'unreturned map reached the commander');
  tick(s);
  const report = reportObservations(s, f, g.observations, { group: g, method: 'return' });
  assert.ok(report.fresh > 0); assert.ok(knownResourceNodes(s, f).some(n => n.id === 'remote-ore'));
  assert.equal(isExplored(s, f, remote), true);
});

test('hidden place reports freeze, hidden units disappear, and regained sight refreshes observations', () => {
  const s = fixture(), [f, other] = s.factions, [home, remote] = s.settlements;
  const g = scout(s, 'traveller', remote); s.groups.push(g);
  const enemy = { id: 'enemy-unit', factionId: other.id, originId: remote.id, kind: 'army', size: 9, x: remote.x + 2, z: remote.z, phase: 'outbound', units: { infantry: 6, ranged: 3 } };
  s.groups.push(enemy); s.nodes = [node('remembered-ore', { x: remote.x + 3, z: remote.z })];
  stepKnowledge(s, { force: true }); tick(s);
  reportObservations(s, f, g.observations, { group: g });
  const report = structuredClone(f.knowledge['remembered-ore']), townReport = structuredClone(f.knowledge[remote.id]);
  const observedUnits = factionView(s, f.id).groups.find(p => p.id === enemy.id);
  assert.ok(observedUnits); assert.equal(observedUnits.targetId, null); assert.equal(observedUnits.originId, null);
  g.x = home.x; g.z = home.z; tick(s);
  s.nodes[0].amount = 7; remote.population = 700; remote.homePresent = 700; remote.soldiers = 100; enemy.size = 200; tick(s, 3);
  assert.deepEqual(f.knowledge['remembered-ore'], report); assert.deepEqual(f.knowledge[remote.id], townReport);
  const view = factionView(s, f.id);
  assert.ok(!view.groups.some(p => p.id === enemy.id)); assert.ok(!view.settlements.some(p => p.id === remote.id));
  assert.ok(!view.nodes.some(n => n.id === 'remembered-ore'));
  const stale = view.knownPlaces.find(n => n.id === 'remembered-ore');
  assert.equal(stale.amountEstimate, 400); assert.equal(stale.amount, undefined); assert.equal(stale.knowledgeView, 'remembered');
  g.x = remote.x; g.z = remote.z; tick(s);
  assert.equal(factionView(s, f.id).nodes.find(n => n.id === 'remembered-ore').amount, 7);
  assert.equal(f.knowledge['remembered-ore'].amountEstimate, 400, 'recontact bypassed report transit');
  reportObservations(s, f, g.observations, { group: g });
  assert.equal(f.knowledge['remembered-ore'].amountEstimate, 7);
});

test('unknown, future, and undelivered targets are never offered to strategic helpers', () => {
  const s = fixture(), [f] = s.factions, [home, remote] = s.settlements;
  s.nodes = [node('unknown-rich', remote, 90000), node('known-poor', home, 12)];
  f.knowledge['known-poor'] = { id: 'known-poor', kind: 'resource', resourceKind: 'materials', x: home.x, z: home.z, amountEstimate: 12, observedTick: 0, reportedTick: 0, confidence: .8 };
  f.knowledge.future = { id: 'future', kind: 'settlement', ownerId: 'f1', x: 0, z: 0, observedTick: 0, reportedTick: 5, confidence: 1 };
  f.knowledge.undelivered = { id: 'undelivered', kind: 'settlement', ownerId: 'f1', x: 0, z: 0, observedTick: 0, reportedTick: null, confidence: 1 };
  assert.deepEqual(knownResourceNodes(s, f).map(n => n.id), ['known-poor']);
  assert.deepEqual(knownReports(s, f, { kind: 'settlement' }), []);
  s.nodes[1].amount = 999999;
  assert.equal(knownResourceNodes(s, f)[0].amount, 12, 'planner refreshed a report by reading live node truth');
});

test('own homes share current local sight, while destroyed towers contribute no sight', () => {
  const s = fixture(), [f] = s.factions, [home, remote] = s.settlements;
  const resource = node('local-resource', { x: home.x + 3, z: home.z }); s.nodes = [resource];
  home.buildings.push({ id: 'remote-tower', kind: 'tower', x: remote.x, z: remote.z, progress: 1, hp: 100 });
  stepKnowledge(s, { force: true });
  assert.equal(f.knowledge[resource.id].amountEstimate, 400);
  assert.ok(f.visibility.visibleIds[remote.id]);
  home.buildings[0].hp = 0; home.buildings[0].destroyed = true; resource.amount = 90; tick(s);
  assert.ok(!f.visibility.visibleIds[remote.id]);
  assert.equal(f.knowledge[resource.id].amountEstimate, 90);
});

test('reset clears explored memory, field reports, pending relays and observer caches', () => {
  const s = fixture(), [f] = s.factions, [home] = s.settlements;
  s.nodes = [node('reset-node', home)]; const g = scout(s, 'reset-scout', home); s.groups.push(g);
  stepKnowledge(s, { force: true }); factionView(s, f.id);
  s.pendingReports = [{ factionId: f.id, dueTick: 9, observations: [...g.observations] }];
  initializeKnowledge(s, { reset: true });
  assert.equal(Object.keys(f.knowledge).length, 0); assert.equal(Object.keys(f.visibility.visualMemory).length, 0);
  assert.equal(f.visibility.explored.reduce((a, b) => a + b, 0), 0); assert.equal(s.pendingReports.length, 0); assert.equal(g.observations.length, 0);
  assert.equal(factionView(s, f.id).nodes.length, 0);
  assert.equal(knowledgeCell({ x: -1000, z: 0 }), -1);
});

test('fog removes hidden live projectiles and filters mixed casualty/shot events independently', () => {
  const s = fixture(), [f] = s.factions, [home, remote] = s.settlements;
  stepKnowledge(s, { force: true });
  const close = { x: home.x + 1, z: home.z }, far = { x: remote.x, z: remote.z };
  s.projectiles = [{ id: 'near', ...close }, { id: 'far', ...far }];
  s.combatEvents = [
    { id: 'shots', type: 'projectile', time: 0, impactTime: 1, expiresAt: 2, shots: [{ from: close, to: close }, { from: far, to: far }] },
    { id: 'deaths', type: 'casualty', time: 0, expiresAt: 2, count: 2, positions: [close, far] },
    { id: 'hidden', type: 'impact', ...far, time: 0, expiresAt: 2 },
  ];
  const view = factionView(s, f.id);
  assert.deepEqual(view.projectiles.map(p => p.id), ['near']);
  assert.equal(view.combatEvents.length, 2); assert.equal(view.combatEvents[0].shots.length, 1); assert.equal(view.combatEvents[1].count, 1);
});

test('knowledge updates have bounded group-based work and preserve inventories, population, and RNG', () => {
  const s = fixture(), [f] = s.factions, [home] = s.settlements;
  home.population = 20000; home.homePresent = 20000;
  s.nodes = [node('ledger-node', { x: home.x + 2, z: home.z })];
  s.groups = Array.from({ length: 120 }, (_, i) => scout(s, `bounded-${i}`, { x: home.x + i % 3, z: home.z + i % 4 }));
  initializeLedger(s); const rng = s.rng, population = home.population, amount = s.nodes[0].amount;
  stepKnowledge(s, { force: true });
  assert.equal(s.rng, rng); assert.equal(home.population, population); assert.equal(s.nodes[0].amount, amount);
  assert.equal(f.visibility.visible.length, KNOWLEDGE_GRID.width * KNOWLEDGE_GRID.height);
  assert.equal(f.visibility.sources.length, 121, 'vision sources were allocated per person');
  for (const residual of Object.values(ledgerResidual(s))) assert.ok(Math.abs(residual) < 1e-7);
  const first = structuredClone(s); stepKnowledge(s); assert.deepEqual(s, first, 'same pulse recomputed knowledge');
});

test('canonical simulation pulses remain identical when observer perspectives are switched', () => {
  const a = createSimulation('knowledge-canonical'), b = createSimulation('knowledge-canonical');
  for (let i = 0; i < 100; i++) {
    stepSimulation(a, 1); stepSimulation(b, 1);
    factionView(a, i % 3 ? a.factions[i % a.factions.length].id : null);
  }
  assert.deepEqual(a, b);
  for (const residual of Object.values(ledgerResidual(a))) assert.ok(Math.abs(residual) < 1e-6);
});

test('stale incoming packets cannot overwrite fresher knowledge or mutate queued snapshots', () => {
  const s = fixture(), [f] = s.factions, [home] = s.settlements;
  s.step = 100; s.tick = 10; s.time = 10;
  const old = { id: 'packet-site', kind: 'resource', resourceKind: 'water', x: home.x, z: home.z, amountEstimate: 200, observedTick: 2, observedTime: 2, confidence: .8 };
  const fresh = { ...old, amountEstimate: 50, observedTick: 9, observedTime: 9 };
  reportObservations(s, f, [fresh]); reportObservations(s, f, [old], { method: 'relay' });
  assert.equal(f.knowledge[old.id].amountEstimate, 50); assert.equal(old.reportedTick, undefined);
  const viewBefore = factionView(s, f.id);
  s.time = 11; s.tick = 11; s.step = 110;
  reportObservations(s, f, [{ ...fresh, amountEstimate: 25, observedTick: 11, observedTime: 11 }]);
  assert.equal(f.knowledge[old.id].amountEstimate, 25); assert.notEqual(factionView(s, f.id), viewBefore);
});

test('empty homes and explicitly uncrewed towers do not provide eyes in the field', () => {
  const s = fixture(), [f] = s.factions, [home, remote] = s.settlements;
  home.homePresent = 0;
  home.buildings = [{ id: 'uncrewed-tower', kind: 'tower', x: remote.x, z: remote.z, progress: 1, hp: 100, crewAssigned: 0 }];
  stepKnowledge(s, { force: true });
  assert.equal(f.visibility.visible.reduce((sum, value) => sum + value, 0), 0);
  home.homePresent = 5; home.buildings[0].crewAssigned = 1; tick(s);
  assert.ok(f.visibility.visibleIds[remote.id]);
});

test('already-seen foreign bodies refresh physical slots each pulse without discovering or reporting hidden targets', () => {
  const s = fixture(), [f, other] = s.factions, [home, remote] = s.settlements;
  const g = scout(s, 'body-watcher', remote), enemy = { id: 'seen-army', factionId: other.id, kind: 'army', size: 1, units: { infantry: 1, ranged: 0 }, x: remote.x + 2, z: remote.z, prevX: remote.x + 1.9, prevZ: remote.z, formationSlots: { infantry: [{ x: remote.x + 2, z: remote.z, prevX: remote.x + 1.9, prevZ: remote.z }], ranged: [] }, formationRevision: 1 };
  s.groups = [g, enemy]; stepKnowledge(s, { force: true });
  const before = structuredClone(f.knowledge), initial = factionView(s, f.id).groups.find(a => a.id === enemy.id);
  assert.equal(initial.formationRevision, 1);
  s.step++; s.time += .1; enemy.prevX = enemy.x; enemy.x += .2; enemy.formationSlots.infantry[0].x += .2; enemy.formationRevision++;
  const now = factionView(s, f.id).groups.find(a => a.id === enemy.id);
  assert.equal(now.x, enemy.x); assert.deepEqual(now.formationSlots, enemy.formationSlots); assert.equal(now.formationRevision, 2);
  assert.deepEqual(f.knowledge, before);
  s.step++; s.time += .1; g.x = home.x; g.z = home.z;
  assert.ok(!factionView(s, f.id).groups.some(a => a.id === enemy.id), 'contact remained visible after every nearby observer left');
  assert.deepEqual(f.knowledge, before);
});

test('occupation reveals local stores and captives without distant armies or the native command archive', () => {
  const s = fixture(), [victor, native] = s.factions, [capital, occupied] = s.settlements;
  occupied.occupiedBy = victor.id; native.defeatedBy = victor.id;
  occupied.population = 150; occupied.homePresent = 80; occupied.soldiers = 70; occupied.military = { infantry: 60, ranged: 10 }; occupied.assigned = { military: 60, workers: 10 };
  occupied.trainingQueue = [{ secret: 'old military project' }]; occupied.stock.materials = 321;
  const distant = { x: -170, z: 160 };
  s.groups = [
    { id: 'unseen-native-army', factionId: native.id, originId: occupied.id, kind: 'army', size: 60, units: { infantry: 60, ranged: 0 }, ...distant },
    { id: 'unseen-native-workers', factionId: native.id, originId: occupied.id, kind: 'worker', size: 5, x: -170, z: -160 },
    { id: 'local-captive-workers', factionId: native.id, originId: occupied.id, kind: 'worker', size: 5, x: occupied.x + 2, z: occupied.z },
  ];
  s.nodes = [node('held-local-resource', { x: occupied.x + 3, z: occupied.z }, 7)];
  native.knowledge.secret = { id: 'secret', kind: 'settlement', ownerId: 'unknown', x: 160, z: 160, observedTick: 0, reportedTick: 0, confidence: 1 };
  native.knowledge['held-local-resource'] = { id: 'held-local-resource', kind: 'resource', resourceKind: 'materials', x: occupied.x + 3, z: occupied.z, amountEstimate: 333, observedTick: 0, reportedTick: 0, confidence: .8 };
  stepKnowledge(s, { force: true });
  const view = factionView(s, victor.id), captiveHome = view.settlements.find(h => h.id === occupied.id);
  assert.equal(captiveHome.population, 80); assert.equal(captiveHome.stock.materials, 321); assert.deepEqual(captiveHome.military, { infantry: 0, ranged: 10 });
  assert.equal(captiveHome.controllerId, victor.id); assert.equal(captiveHome.knowledgeControl, 'occupied'); assert.deepEqual(captiveHome.trainingQueue, []);
  assert.equal(captiveHome.assigned.military, undefined); assert.ok(!view.groups.some(g => g.id.startsWith('unseen-native')));
  assert.equal(view.groups.find(g => g.id === 'local-captive-workers').originId, null);
  assert.equal(victor.knowledge['held-local-resource'].amountEstimate, 7); assert.equal(victor.knowledge.secret, undefined);
  assert.equal(native.knowledge['held-local-resource'].amountEstimate, 333, 'occupation kept feeding fresh intelligence to former commanders');
  const nativeView = factionView(s, native.id);
  assert.equal(nativeView.settlements.find(h => h.id === occupied.id).population, 150); assert.ok(nativeView.groups.some(g => g.id === 'unseen-native-army'));
});

test('resource claims are learned locally and hidden ownership changes remain stale', () => {
  const s = fixture(), [f, rival] = s.factions, [home, remote] = s.settlements;
  const g = scout(s, 'claim-scout', remote); s.groups.push(g);
  const resource = node('claimed-ore', { x: remote.x + 3, z: remote.z }); resource.claimedBy = rival.id; resource.claimSettlementId = remote.id; s.nodes = [resource];
  stepKnowledge(s, { force: true }); reportObservations(s, f, g.observations, { group: g });
  assert.equal(f.knowledge[resource.id].ownerId, rival.id); assert.equal(knownResourceNodes(s, f)[0].claimedBy, rival.id);
  g.x = home.x; g.z = home.z; tick(s); resource.claimedBy = f.id; tick(s);
  assert.equal(f.knowledge[resource.id].claimedBy, rival.id); assert.equal(factionView(s, f.id).knownPlaces.find(n => n.id === resource.id).claimedBy, rival.id);
  g.x = remote.x; g.z = remote.z; tick(s); reportObservations(s, f, g.observations, { group: g });
  assert.equal(f.knowledge[resource.id].claimedBy, f.id);
});

test('captured charts disclose only reports physically delivered there and preserve their original observation age', async () => {
  const { occupySettlement } = await import('../src/sim/conquest.js');
  const s = fixture(), [victor, native] = s.factions, [capital, held] = s.settlements;
  s.step = 100; s.tick = 10; s.time = 10;
  native.knowledge['delivered-map'] = { id: 'delivered-map', kind: 'resource', resourceKind: 'materials', x: 150, z: 150, amountEstimate: 300, observedTick: 2, observedTime: 2, reportedTick: 7, reportedAtSettlementId: held.id, confidence: .8 };
  native.knowledge['remote-live-home'] = { id: 'remote-live-home', kind: 'settlement', ownerId: native.id, x: -150, z: -150, populationEstimate: 700, soldiersEstimate: 250, observedTick: 10, reportedTick: 10, reportedAtSettlementId: 'other-home', confidence: 1 };
  const army = { id: 'capture-party', factionId: victor.id, originId: capital.id, kind: 'army', size: 20, units: { infantry: 20, ranged: 0 }, x: held.x, z: held.z, observations: [] };
  s.groups.push(army);
  const pop = s.settlements.reduce((sum, home) => sum + home.population, 0);
  assert.equal(occupySettlement(s, held, army), true);
  assert.equal(victor.knowledge['delivered-map'].observedTick, 2);
  assert.equal(victor.knowledge['delivered-map'].reportedTick, 10);
  assert.equal(victor.knowledge['delivered-map'].reportedAtSettlementId, held.id);
  assert.equal(victor.knowledge['remote-live-home'], undefined);
  assert.equal(s.settlements.reduce((sum, home) => sum + home.population, 0), pop);
  const captive = factionView(s, native.id);
  assert.ok(captive.events.some(e => e.type === 'capture' && e.settlementId === held.id), 'captive residents could not see the local occupation event');
});

test('visible and occupied home bodies reflect same-pulse casualties and returns without stale assignment counts', () => {
  for (const occupiedView of [false, true]) {
    const s = fixture(`pulse-census-${occupiedView}`), [viewer, native] = s.factions, [capital, home] = s.settlements;
    if (occupiedView) home.occupiedBy = viewer.id;
    home.population = 120; home.soldiers = 40; home.military = { infantry: 28, ranged: 12 };
    home.homePresent = 120; home.assigned = { military: 0, workers: 0 }; // Intentionally stale whole-cycle caches.
    const watcher = scout(s, 'census-watcher', home);
    const army = { id: 'census-army', factionId: native.id, originId: home.id, kind: 'army', size: 16, units: { infantry: 10, ranged: 6 }, x: -170, z: 160 };
    const workers = { id: 'census-workers', factionId: native.id, originId: home.id, kind: 'worker', size: 9, x: -170, z: -160 };
    s.groups = [watcher, army, workers]; stepKnowledge(s, { force: true });
    const storedReports = structuredClone(viewer.knowledge), rng = s.rng;
    const renderedHome = () => factionView(s, viewer.id).settlements.find(p => p.id === home.id);
    let current = renderedHome();
    assert.equal(current.population, 95); assert.equal(current.homePresent, 95); assert.equal(current.soldiers, 24); assert.equal(current.workers, 71);
    assert.deepEqual(current.military, { infantry: 18, ranged: 6 });

    // A local ranged defender dies after the cycle's assignments were cached.
    home.population--; home.soldiers--; home.military.ranged--;
    current = renderedHome();
    assert.equal(current.population, 94); assert.equal(current.soldiers, 23); assert.equal(current.workers, 71);
    assert.deepEqual(current.military, { infantry: 18, ranged: 5 });

    // Field losses reduce the party and home ledger together, leaving the local
    // bodies untouched even though the hidden native total has changed.
    home.population -= 3; home.soldiers -= 3; home.military.infantry -= 3; army.size -= 3; army.units.infantry -= 3;
    current = renderedHome();
    assert.equal(current.population, 94); assert.equal(current.soldiers, 23);
    assert.deepEqual(current.military, { infantry: 18, ranged: 5 });

    // Returned crews no longer count as departures, before updateAssignments.
    workers.finished = true;
    current = renderedHome(); assert.equal(current.population, 103); assert.equal(current.workers, 80);
    army.finished = true;
    current = renderedHome(); assert.equal(current.population, 116); assert.equal(current.soldiers, 36); assert.equal(current.workers, 80);
    assert.deepEqual(current.military, { infantry: 25, ranged: 11 });
    assert.equal(home.homePresent, 120); assert.equal(home.assigned.military, 0, 'view wrote to simulation job assignments');
    assert.deepEqual(viewer.knowledge, storedReports, 'render census correction rewrote reported intelligence');
    assert.equal(s.rng, rng); assert.equal(s.tick, 0); assert.equal(s.step, 0);
  }
});

test('native recon learns occupied-home control only through actual sight and a subsequently delivered report', async () => {
  const { observeGroup } = await import('../src/sim/knowledge.js');
  const s = fixture('native-recon-control'), [native, occupier] = s.factions, [held, far] = s.settlements;
  held.occupiedBy = occupier.id;
  native.knowledge[held.id] = { id: held.id, kind: 'settlement', ownerId: native.id, x: held.x, z: held.z, observedTick: 0, reportedTick: 0, confidence: 1, status: 'active' };
  s.step = 50; s.tick = 5; s.time = 5;
  const g = scout(s, 'native-recon-party', far); s.groups = [g];
  const oldReport = structuredClone(native.knowledge[held.id]);
  observeGroup(s, g);
  assert.ok(!g.observations.some(o => o.id === held.id), 'remote ownership was inserted into the scout report');
  assert.deepEqual(native.knowledge[held.id], oldReport);

  g.x = held.x + 2; g.z = held.z;
  observeGroup(s, g);
  let observation = g.observations.find(o => o.id === held.id);
  assert.ok(observation); assert.equal(observation.ownerId, occupier.id); assert.equal(observation.reportedTick, null);
  assert.deepEqual(native.knowledge[held.id], oldReport, 'local sight bypassed the courier');

  // The periodic sight path must also record the changed sovereign, but the
  // occupied native home must not transmit to its former independent command.
  g.observations = []; stepKnowledge(s, { force: true });
  observation = g.observations.find(o => o.id === held.id);
  assert.ok(observation); assert.equal(observation.ownerId, occupier.id);
  assert.deepEqual(native.knowledge[held.id], oldReport);
  reportObservations(s, native, g.observations, { method: 'return' });
  assert.equal(native.knowledge[held.id].ownerId, occupier.id);
  assert.equal(native.knowledge[held.id].observedTick, 5); assert.equal(native.knowledge[held.id].reportedTick, 5);
});

test('foreign-command native auxiliaries provide sight and reports only to their commander without duplicate bodies', async () => {
  const { observeGroup } = await import('../src/sim/knowledge.js');
  const s = fixture('auxiliary-private-sight'), [commander, native] = s.factions, [capital, held] = s.settlements;
  held.occupiedBy = commander.id; held.exileBaseFor = commander.id; held.trainingQueue = [{ id: 'commander-course', commandFactionId: commander.id, role: 'ranged', size: 2, progress: .5 }, { id: 'native-course', commandFactionId: native.id, role: 'infantry', size: 1, progress: .1 }]; held.population = 100; held.homePresent = 87; held.soldiers = 10; held.military = { infantry: 6, ranged: 4 }; held.assigned = { military: 10, scouts: 3 };
  const point = { x: -160, z: 140 };
  const army = { id: 'native-auxiliary-army', factionId: native.id, commandFactionId: commander.id, originId: held.id, kind: 'army', size: 10, units: { infantry: 6, ranged: 4 }, ...point, sightRadius: 8 };
  const scout = { id: 'native-auxiliary-scout', factionId: native.id, commandFactionId: commander.id, originId: held.id, kind: 'scout', size: 3, ...point, sightRadius: 8, observations: [] };
  s.groups = [army, scout]; s.nodes = [node('auxiliary-discovery', point, 123)];
  stepKnowledge(s, { force: true }); observeGroup(s, scout);
  const commandView = factionView(s, commander.id), nativeView = factionView(s, native.id);
  assert.ok(commandView.nodes.some(n => n.id === 'auxiliary-discovery'));
  assert.ok(!nativeView.nodes.some(n => n.id === 'auxiliary-discovery'), 'biological identity leaked remote auxiliary sight');
  assert.ok(!nativeView.groups.some(g => g.id === army.id || g.id === scout.id), 'remote enemy-commanded parties were exposed to their former native polity');
  for (const id of [army.id, scout.id]) {
    const group = commandView.groups.find(g => g.id === id);
    assert.ok(group); assert.equal(group.factionId, native.id); assert.equal(group.controllerId, commander.id); assert.equal(group.originId, null); assert.equal(group.observedHomeId, held.id);
  }
  assert.deepEqual(commandView.settlements.find(h => h.id === held.id).trainingQueue.map(j => j.id), ['commander-course']);
  assert.deepEqual(nativeView.settlements.find(h => h.id === held.id).trainingQueue.map(j => j.id), ['native-course']);
  assert.equal(commandView.settlements.find(h => h.id === held.id).exileBaseFor, commander.id);
  assert.equal(commandView.settlements.find(h => h.id === held.id).population, 87);
  assert.equal(nativeView.settlements.find(h => h.id === held.id).population, 87, 'hidden auxiliaries were rendered again as residents');
  assert.deepEqual(nativeView.settlements.find(h => h.id === held.id).military, { infantry: 0, ranged: 0 });
  assert.equal(s.settlements.find(h => h.id === held.id).population, 100, 'a view changed the biological census');
  assert.equal(commander.knowledge['auxiliary-discovery'], undefined, 'auxiliary field discovery bypassed return transit');
  assert.equal(native.knowledge['auxiliary-discovery'], undefined);
  reportObservations(s, commander, scout.observations, { group: scout, homeId: held.id });
  assert.equal(commander.knowledge['auxiliary-discovery'].amountEstimate, 123); assert.equal(native.knowledge['auxiliary-discovery'], undefined);

  // The native viewer may see the same bodies when they physically return into
  // local sight, but receives neither their remote orders nor their field reports.
  army.x = scout.x = held.x + 1; army.z = scout.z = held.z; tick(s);
  const seen = factionView(s, native.id), observed = seen.groups.filter(g => g.id === army.id || g.id === scout.id);
  assert.equal(observed.length, 2); assert.ok(observed.every(g => g.originId === null && g.knowledgeView === 'visible'));
  assert.ok(observed.every(g => g.targetId === null));
  const scoped = seen.settlements.reduce((sum, h) => sum + h.population, 0) + seen.groups.filter(g => g.originId == null).reduce((sum, g) => sum + g.size, 0);
  assert.equal(scoped, 100, 'local auxiliary sightings caused duplicated or missing native bodies');
});
