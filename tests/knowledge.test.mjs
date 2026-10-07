import { setMilitary, bindArmy, positionMilitary } from './roster-fixtures.mjs';
import { getSoldiers, applySoldierDamage } from '../src/sim/soldiers.js';
import { returnMilitary } from '../src/sim/military.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSimulation, stepSimulation } from '../src/sim/core.js';
import { initializeLedger, ledgerResidual } from '../src/sim/economy.js';
import { initializeKnowledge, stepKnowledge, knownReports, knownResourceNodes, factionView, reportObservations, visibleToGroup, lineOfSight, isExplored, knowledgeCell, KNOWLEDGE_GRID } from '../src/sim/knowledge.js';

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
  for (const view of [factionView(s), factionView(s, 'omniscient')]) {
    assert.equal(view.settlements, s.settlements); assert.equal(view.groups, s.groups);
    assert.deepEqual(view.soldiers.map(body => body.id), s.settlements.flatMap(home => home.soldierRoster.filter(body => body.status === 'serving').map(body => body.id)));
  }
  assert.deepEqual(s, before, 'render view lookup mutated simulation or reports');
});

test('observed connected gates retain physical geometry without exposing private building plans', () => {
  const s = fixture(), [f] = s.factions, [, remote] = s.settlements;
  const observer = scout(s, 'gate-observer', remote); s.groups.push(observer);
  const gate = { id: 'observed-gate', kind: 'gate', x: remote.x + 2, z: remote.z, progress: 1, hp: 200,
    from: { x: remote.x + 2, z: remote.z - 4 }, to: { x: remote.x + 2, z: remote.z + 4 }, length: 8, width: 1,
    rotation: Math.PI / 2, gateWidth: 5, isGate: true, open: true, gateOpen: true,
    topologyId: 'screen-test', topologySlot: 0, joins: { from: 'join-0', to: 'join-1' },
    placementReason: 'PRIVATE_PLANNING_REASON', defensiveObjective: 'PRIVATE_OBJECTIVE', targetReportId: 'PRIVATE_REPORT' };
  remote.buildings.push(gate);stepKnowledge(s, { force: true });
  const visible = factionView(s, f.id).settlements.find(home => home.id === remote.id)?.buildings.find(b => b.id === gate.id);
  assert.ok(visible, 'The observer must actually see the gate');
  for (const key of ['from','to','length','width','gateWidth','open','gateOpen','topologyId','topologySlot','joins']) assert.deepEqual(visible[key], gate[key], key);
  for (const key of ['placementReason','defensiveObjective','targetReportId']) assert.equal(visible[key], undefined, key);
  observer.x = s.settlements[0].x; observer.z = s.settlements[0].z; tick(s);
  assert.ok(!factionView(s, f.id).settlements.some(home => home.id === remote.id), 'Hidden walls must not remain live render geometry');
});

test('scout sight and surveyed terrain reach faction planning live', () => {
  const s = fixture(), [f] = s.factions, [, remote] = s.settlements;
  // Observe in another starting clearing; the home cannot share this LOS.
  s.nodes = [node('remote-ore', { x: remote.x + 3, z: remote.z })];
  const g = scout(s, 'field-scout', remote); s.groups.push(g);
  stepKnowledge(s, { force: true });
  assert.ok(g.observations.some(o => o.id === 'remote-ore'));
  assert.ok(factionView(s, f.id).nodes.some(n => n.id === 'remote-ore'));
  assert.ok(knownResourceNodes(s, f).some(n => n.id === 'remote-ore'), 'live scout sight must reach planning');
  assert.equal(isExplored(s, f, remote), true, 'only surveyed terrain reaches the commander');
  tick(s);
  const report = reportObservations(s, f, g.observations, { group: g, method: 'return' });
  assert.equal(report.fresh, 0, 'returning the same live reading must not duplicate it'); assert.ok(knownResourceNodes(s, f).some(n => n.id === 'remote-ore'));
  assert.equal(isExplored(s, f, remote), true);
});

test('hidden place reports freeze, hidden units disappear, and regained sight refreshes observations', () => {
  const s = fixture(), [f, other] = s.factions, [home, remote] = s.settlements;
  const g = scout(s, 'traveller', remote); s.groups.push(g);
  const enemy = { id: 'enemy-unit', factionId: other.id, originId: remote.id, kind: 'army', size: 9, x: remote.x + 2, z: remote.z, phase: 'outbound', units: { infantry: 6, ranged: 3 } };
  setMilitary(s, remote, enemy.units); bindArmy(s, remote, enemy);
  s.groups.push(enemy); s.nodes = [node('remembered-ore', { x: remote.x + 3, z: remote.z })];
  stepKnowledge(s, { force: true }); tick(s);
  reportObservations(s, f, g.observations, { group: g });
  const report = structuredClone(f.knowledge['remembered-ore']), townReport = structuredClone(f.knowledge[remote.id]);
  const observedUnits = factionView(s, f.id).groups.find(p => p.id === enemy.id);
  assert.ok(observedUnits); assert.equal(observedUnits.targetId, null); assert.equal(observedUnits.originId, null);
  g.x = home.x; g.z = home.z; tick(s);
  s.nodes[0].amount = 7; remote.population = 700; remote.homePresent = 700; setMilitary(s, remote, { infantry: 150, ranged: 50 }); delete enemy.soldierIds; enemy.units = { infantry: 150, ranged: 50 }; bindArmy(s, remote, enemy); tick(s, 3);
  assert.deepEqual(f.knowledge['remembered-ore'], report); assert.deepEqual(f.knowledge[remote.id], townReport);
  const view = factionView(s, f.id);
  assert.ok(!view.groups.some(p => p.id === enemy.id)); assert.ok(!view.settlements.some(p => p.id === remote.id));
  assert.ok(!view.nodes.some(n => n.id === 'remembered-ore'));
  const stale = view.knownPlaces.find(n => n.id === 'remembered-ore');
  assert.equal(stale.amountEstimate, 400); assert.equal(stale.amount, undefined); assert.equal(stale.knowledgeView, 'remembered');
  g.x = remote.x; g.z = remote.z; tick(s);
  assert.equal(factionView(s, f.id).nodes.find(n => n.id === 'remembered-ore').amount, 7);
  assert.equal(f.knowledge['remembered-ore'].amountEstimate, 7, 'actual recontact must refresh live scout intelligence');
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
  const resource = node('local-resource', { x: home.x + 3, z: home.z });
  const towerResource = node('tower-resource', { x: remote.x + 1, z: remote.z });
  s.nodes = [resource, towerResource];
  const towerSite = Array.from({ length: 64 }, (_, index) => {
    const angle = index / 64 * Math.PI * 2;
    return { x: remote.x + Math.cos(angle) * 22, z: remote.z + Math.sin(angle) * 22 };
  }).find(point => [remote, towerResource].every(target => lineOfSight(s, point, target, { maxRange: 26, fromHeight: 4.5, toHeight: 'population' in target ? 2 : 1.2, factionId: f.id })));
  assert.ok(towerSite, 'the tower fixture needs a clear lane within its own sight range');
  setMilitary(s, home, { infantry: 0, ranged: 2 });
  const operators = getSoldiers(s, home);
  const tower = { id: 'remote-tower', kind: 'tower', ...towerSite, progress: 1, hp: 100, requiredCrew: 2, crewAssigned: 2, crewSoldierIds: operators.map(body => body.id) };
  home.buildings.push(tower);
  for (const [index, body] of operators.entries()) {
    const x = tower.x + (index ? .25 : -.25);
    Object.assign(body, { towerId: tower.id, x, z: tower.z, prevX: x, prevZ: tower.z, positioned: true });
    for (const target of [remote, towerResource]) assert.ok(Math.hypot(body.x - target.x, body.z - target.z) > 15, 'personal soldier sight would mask tower destruction');
  }
  stepKnowledge(s, { force: true });
  assert.equal(f.knowledge[resource.id].amountEstimate, 400);
  assert.ok(f.visibility.visibleIds[remote.id]); assert.ok(f.visibility.visibleIds[towerResource.id]);
  tower.hp = 0; tower.destroyed = true; resource.amount = 90; towerResource.amount = 7; tick(s);
  assert.ok(!f.visibility.visibleIds[remote.id]); assert.ok(!f.visibility.visibleIds[towerResource.id]);
  assert.ok(!factionView(s, f.id).nodes.some(candidate => candidate.id === towerResource.id));
  assert.equal(f.knowledge[towerResource.id].amountEstimate, 400, 'destroyed tower refreshed an unseen deposit');
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
  setMilitary(s, home); home.homePresent = 0;
  home.buildings = [{ id: 'uncrewed-tower', kind: 'tower', x: remote.x, z: remote.z, progress: 1, hp: 100, crewAssigned: 0 }];
  stepKnowledge(s, { force: true });
  assert.equal(f.visibility.visible.reduce((sum, value) => sum + value, 0), 0);
  home.homePresent = 5; setMilitary(s, home, { infantry: 0, ranged: 2 });
  const tower = home.buildings[0], operators = getSoldiers(s, home);
  tower.crewAssigned = 2; tower.crewSoldierIds = operators.map(body => body.id);
  for (const body of operators) Object.assign(body, { towerId: tower.id, x: tower.x, z: tower.z, prevX: tower.x, prevZ: tower.z, positioned: true });
  tick(s);
  assert.ok(f.visibility.visibleIds[remote.id]);
});

test('already-seen foreign bodies refresh their exact projected positions without discovering or reporting hidden targets', () => {
  const s = fixture(), [f, other] = s.factions, [home, remote] = s.settlements;
  const g = scout(s, 'body-watcher', remote), enemy = { id: 'seen-army', originId: remote.id, factionId: other.id, kind: 'army', size: 1, units: { infantry: 1, ranged: 0 }, x: remote.x + 2, z: remote.z, prevX: remote.x + 1.9, prevZ: remote.z };
  setMilitary(s, remote, enemy.units); bindArmy(s, remote, enemy);
  const enemyBody = getSoldiers(s, enemy)[0];
  Object.assign(enemyBody, { x: enemy.x, z: enemy.z, prevX: enemy.prevX, prevZ: enemy.prevZ, positioned: true });
  s.groups = [g, enemy]; stepKnowledge(s, { force: true });
  const before = structuredClone(f.knowledge), initialView = factionView(s, f.id);
  const initial = initialView.soldiers.find(body => body.id === enemyBody.id);
  assert.ok(initial); assert.equal(initial.groupId, enemy.id); assert.equal(initial.role, 'infantry');
  for (const key of ['x', 'z', 'prevX', 'prevZ']) assert.equal(initial[key], enemyBody[key]);
  for (const entity of [...initialView.groups, ...initialView.settlements]) {
    assert.equal(entity.formationSlots, undefined); assert.equal(entity.soldierRoster, undefined); assert.equal(entity.soldierIds, undefined);
  }
  s.step++; s.time += .1; enemy.prevX = enemy.x; enemy.x += .2; enemyBody.prevX = enemyBody.x; enemyBody.x += .2;
  const nowView = factionView(s, f.id), now = nowView.soldiers.find(body => body.id === enemyBody.id);
  assert.equal(nowView.groups.find(group => group.id === enemy.id).x, enemy.x);
  for (const key of ['x', 'z', 'prevX', 'prevZ']) assert.equal(now[key], enemyBody[key]);
  assert.equal(now.x, initial.x + .2); assert.equal(now.prevX, initial.x);
  assert.deepEqual(f.knowledge, before);
  Object.assign(enemyBody, { yaw: .4, prevYaw: .3, contactId: 'private-contact', contactIndex: 4, facingX: 234, facingZ: 345, steerSide: 1 });
  enemy.combat = { active: true, intent: 'intercept', reason: 'PRIVATE_TACTICAL_REASON', targetId: 'private-contact', localStrength: 100, enemyStrength: 50 };
  s.step++; s.time += .1;
  const physicalView = factionView(s, f.id), physical = physicalView.soldiers.find(body => body.id === enemyBody.id);
  assert.equal(physical.yaw, .4); assert.equal(physical.prevYaw, .3);
  for (const key of ['contactId', 'contactIndex', 'facingX', 'facingZ', 'steerSide']) assert.equal(physical[key], undefined, key);
  const observedCombat = physicalView.groups.find(group => group.id === enemy.id).combat;
  assert.equal(observedCombat.intent, undefined); assert.equal(observedCombat.reason, undefined); assert.equal(observedCombat.targetId, undefined);
  s.step++; s.time += .1; g.x = home.x; g.z = home.z;
  const hiddenView = factionView(s, f.id);
  assert.ok(!hiddenView.groups.some(group => group.id === enemy.id), 'contact remained visible after every nearby observer left');
  assert.ok(!hiddenView.soldiers.some(body => body.id === enemyBody.id), 'the exact soldier remained visible after its observer left');
  assert.deepEqual(f.knowledge, before);
});

test('occupation reveals local stores and captives without distant armies or the native command archive', () => {
  const s = fixture(), [victor, native] = s.factions, [capital, occupied] = s.settlements;
  occupied.occupiedBy = victor.id; native.defeatedBy = victor.id;
  occupied.population = 150; occupied.homePresent = 80; setMilitary(s, occupied, { infantry: 60, ranged: 10 }); occupied.assigned = { military: 60, workers: 10 };
  occupied.trainingQueue = [{ secret: 'old military project' }]; occupied.stock.materials = 321;
  const distant = { x: -170, z: 160 };
  s.groups = [
    { id: 'unseen-native-army', factionId: native.id, originId: occupied.id, kind: 'army', size: 60, units: { infantry: 60, ranged: 0 }, ...distant },
    { id: 'unseen-native-workers', factionId: native.id, originId: occupied.id, kind: 'worker', size: 5, x: -170, z: -160 },
    { id: 'local-captive-workers', factionId: native.id, originId: occupied.id, kind: 'worker', size: 5, x: occupied.x + 2, z: occupied.z },
  ];
  bindArmy(s, occupied, s.groups[0]);
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
  setMilitary(s, capital, army.units); bindArmy(s, capital, army); s.groups.push(army);
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
    home.population = 120; setMilitary(s, home, { infantry: 28, ranged: 12 });
    home.homePresent = 120; home.assigned = { military: 0, workers: 0 }; // Intentionally stale whole-cycle caches.
    const watcher = scout(s, 'census-watcher', home);
    const army = { id: 'census-army', factionId: native.id, originId: home.id, kind: 'army', size: 16, units: { infantry: 10, ranged: 6 }, x: -170, z: 160 };
    const workers = { id: 'census-workers', factionId: native.id, originId: home.id, kind: 'worker', size: 9, x: -170, z: -160 };
    bindArmy(s, home, army); s.groups = [watcher, army, workers]; positionMilitary(s); stepKnowledge(s, { force: true });
    const storedReports = structuredClone(viewer.knowledge), rng = s.rng;
    const renderedHome = () => factionView(s, viewer.id).settlements.find(p => p.id === home.id);
    let current = renderedHome();
    assert.equal(current.population, 95); assert.equal(current.homePresent, 95); assert.equal(current.soldiers, 24); assert.equal(current.workers, 71);
    assert.deepEqual(current.military, { infantry: 18, ranged: 6 });

    // A local ranged defender dies after the cycle's assignments were cached.
    const defender = getSoldiers(s, home).find(body => body.role === 'ranged');
    applySoldierDamage(s, defender.id, defender.hp);
    current = renderedHome();
    assert.equal(current.population, 94); assert.equal(current.soldiers, 23); assert.equal(current.workers, 71);
    assert.deepEqual(current.military, { infantry: 18, ranged: 5 });

    // Field losses reduce the party and home ledger together, leaving the local
    // bodies untouched even though the hidden native total has changed.
    for (const body of getSoldiers(s, army).filter(body => body.role === 'infantry').slice(0, 3)) applySoldierDamage(s, body.id, body.hp);
    current = renderedHome();
    assert.equal(current.population, 94); assert.equal(current.soldiers, 23);
    assert.deepEqual(current.military, { infantry: 18, ranged: 5 });

    // Returned crews no longer count as departures, before updateAssignments.
    workers.finished = true;
    current = renderedHome(); assert.equal(current.population, 103); assert.equal(current.workers, 80);
    // Stage the actual surviving bodies at home before their census return.
    army.x = home.x; army.z = home.z;
    for (const [index, body] of getSoldiers(s, army).entries()) {
      const x = home.x + (index % 4 - 1.5) * .6, z = home.z + (Math.floor(index / 4) - 1.5) * .6;
      Object.assign(body, { x, z, prevX: x, prevZ: z, positioned: true });
    }
    returnMilitary(s, home, army); army.finished = true;
    current = renderedHome(); assert.equal(current.population, 116); assert.equal(current.soldiers, 36); assert.equal(current.workers, 80);
    assert.deepEqual(current.military, { infantry: 25, ranged: 11 });
    assert.equal(home.homePresent, 120); assert.equal(home.assigned.military, 0, 'view wrote to simulation job assignments');
    assert.deepEqual(viewer.knowledge, storedReports, 'render census correction rewrote reported intelligence');
    assert.equal(s.rng, rng); assert.equal(s.tick, 0); assert.equal(s.step, 0);
  }
});

test('native recon learns occupied-home control from actual live scout sight', async () => {
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
  assert.equal(native.knowledge[held.id].ownerId, occupier.id);
  reportObservations(s, native, g.observations, { method: 'return' });
  assert.equal(native.knowledge[held.id].ownerId, occupier.id);
  assert.equal(native.knowledge[held.id].observedTick, 5); assert.equal(native.knowledge[held.id].reportedTick, 5);
});

test('foreign-command native auxiliaries provide sight and reports only to their commander without duplicate bodies', async () => {
  const { observeGroup } = await import('../src/sim/knowledge.js');
  const s = fixture('auxiliary-private-sight'), [commander, native] = s.factions, [capital, held] = s.settlements;
  held.occupiedBy = commander.id; held.exileBaseFor = commander.id; held.trainingQueue = [{ id: 'commander-course', commandFactionId: commander.id, role: 'ranged', size: 2, progress: .5 }, { id: 'native-course', commandFactionId: native.id, role: 'infantry', size: 1, progress: .1 }]; held.population = 100; held.homePresent = 87; setMilitary(s, held, { infantry: 6, ranged: 4 }); held.assigned = { military: 10, scouts: 3 };
  const point = { x: -160, z: 140 };
  const army = { id: 'native-auxiliary-army', factionId: native.id, commandFactionId: commander.id, originId: held.id, kind: 'army', size: 10, units: { infantry: 6, ranged: 4 }, ...point, sightRadius: 8 };
  const scout = { id: 'native-auxiliary-scout', factionId: native.id, commandFactionId: commander.id, originId: held.id, kind: 'scout', size: 3, ...point, sightRadius: 8, observations: [] };
  bindArmy(s, held, army); s.groups = [army, scout]; s.nodes = [node('auxiliary-discovery', point, 123)];
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
  assert.equal(commander.knowledge['auxiliary-discovery'].reportMethod, 'scout-sight', 'the actual commander receives live scout sight');
  assert.equal(native.knowledge['auxiliary-discovery'], undefined);
  reportObservations(s, commander, scout.observations, { group: scout, homeId: held.id });
  assert.equal(commander.knowledge['auxiliary-discovery'].amountEstimate, 123); assert.equal(native.knowledge['auxiliary-discovery'], undefined);

  // The native viewer may see the same bodies when they physically return into
  // local sight, but receives neither their remote orders nor their field reports.
  const dx = held.x + 1 - army.x, dz = held.z - army.z;
  army.x = scout.x = held.x + 1; army.z = scout.z = held.z;
  for (const body of getSoldiers(s, army)) Object.assign(body, { x: body.x + dx, z: body.z + dz, prevX: body.prevX + dx, prevZ: body.prevZ + dz });
  tick(s);
  const seen = factionView(s, native.id), observed = seen.groups.filter(g => g.id === army.id || g.id === scout.id);
  assert.equal(observed.length, 2); assert.ok(observed.every(g => g.originId === null && g.knowledgeView === 'visible'));
  assert.ok(observed.every(g => g.targetId === null));
  const scoped = seen.settlements.reduce((sum, h) => sum + h.population, 0) + seen.groups.filter(g => g.originId == null).reduce((sum, g) => sum + g.size, 0);
  assert.equal(scoped, 100, 'local auxiliary sightings caused duplicated or missing native bodies');
});
