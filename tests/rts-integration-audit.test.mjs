import { getSoldier, getSoldiers } from '../src/sim/soldiers.js';
import { houseExistingPopulation, setMilitary, recruitMilitary, bindArmy } from './roster-fixtures.mjs';
// Independent contract audit. Controlled fixtures are not natural-population or
// browser-performance evidence; natural multi-seed evidence lives in balance.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stepStrategy } from '../src/sim/strategy.js';
import { createSimulation, stepSimulation } from '../src/sim/core.js';
import { terrainAt } from '../src/world.js';
import { emptyResources, initializeLedger, ledgerResidual, RESOURCES } from '../src/sim/economy.js';
import { countMilitary, refreshExileBases, commandFactionForHome, queueTraining, advanceTraining, unitStats } from '../src/sim/military.js';
import { groupController } from '../src/sim/control.js';
import { DEFENSE_STATS, assignDefenses, defenseAmmoCost } from '../src/sim/defenses.js';
import { stepCombat, updateCombatFormation, combatFormationSlot, COMBAT_LIMITS } from '../src/sim/combat.js';
import { occupySettlement, updateConquest, settlementController, sovereignHomes } from '../src/sim/conquest.js';
import { initializeKnowledge, stepKnowledge, observeGroup, factionView, isVisible } from '../src/sim/knowledge.js';
import { lineOfSight, isSegmentTraversable, moveAlongRoute, invalidateNavigation } from '../src/sim/navigation.js';
import { auditState, population } from './balance.mjs';

function clearSite(state) {
  // Select actual seeded traversable land with unobstructed firing lanes.
  for (let z = -72; z <= 72; z += 6) for (let x = -72; x <= 72; x += 6) {
    const points = [];
    for (let dz = -8; dz <= 8; dz += 2) for (let dx = -8; dx <= 8; dx += 2) points.push({ x: x + dx, z: z + dz });
    if (points.every(p => terrainAt(p.x, p.z, state.terrainSeed || state.seed).traversable) && lineOfSight(state, { x: x - 7, z }, { x: x + 7, z }, { fromHeight: .65, toHeight: .65 })) return { x, z };
  }
  assert.fail('Fixture needs real traversable land and a clear firing lane');
}
function fixture() {
  const state = createSimulation('rts-independent-audit', { civCount: 3 });
  state.groups = []; state.nodes = []; state.tradeOffers = []; state.events = [];
  for (const home of state.settlements) {
    home.buildings = []; home.population = 200; home.homePresent = 200;
    home.stock = Object.fromEntries(RESOURCES.map(k => [k, 500]));
    home.assigned = { training: 0, towerCrew: 0 };
    setMilitary(state, home);
  }
  const center = clearSite(state);
  const [a, b] = state.factions;
  a.relations[b.id] = { status: 'hostile', trust: 0 };
  b.relations[a.id] = { status: 'hostile', trust: 0 };
  initializeLedger(state);
  return { state, center, a, b, ha: state.settlements[0], hb: state.settlements[1] };
}
function army(state, home, id, units, point) {
  recruitMilitary(state, home, units);
  const g = { id, kind: 'army', factionId: home.factionId, originId: home.id,
    units: { ...units }, size: countMilitary(units), initialSize: countMilitary(units),
    x: point.x, z: point.z, prevX: point.x, prevZ: point.z, targetX: point.x, targetZ: point.z,
    speed: 0, phase: 'outbound', supply: 100, morale: 100, carrying: emptyResources(), createdTick: state.tick };
  bindArmy(state, home, g); state.groups.push(g); return g;
}
function pulse(state) {
  state.step++; state.tick = Math.floor(state.step / 10); state.time = state.step / 10;
  stepCombat(state, .1);
}
function conserved(state) {
  for (const [kind, residual] of Object.entries(ledgerResidual(state))) assert.ok(Math.abs(residual) < 1e-7, `${kind} residual ${residual}`);
}

function duel() {
  const f = fixture(), { state, center, ha, hb } = f;
  const source = army(state, ha, 'audit-archers', { infantry: 0, ranged: 24 }, { x: center.x - 3, z: center.z });
  const target = army(state, hb, 'audit-target', { infantry: 24, ranged: 0 }, { x: center.x + 3, z: center.z });
  target.carrying.food = target.size * 1.2;
  initializeLedger(state);
  return { ...f, source, target };
}

test('visible ranged volleys create pending projectiles before actual role casualties and proportional cargo loss', () => {
  const { state, source, target, hb } = duel(), initialPopulation = population(state), initialSize = target.size, initialFood = target.carrying.food;
  pulse(state);
  const shots = state.combatEvents.filter(e => e.type === 'projectile' && e.sourceId === source.id);
  assert.ok(shots.length > 0, 'no real ranged projectile was launched');
  assert.equal(state.stats.deaths, 0, 'launch applied damage before projectile flight');
  for (const event of shots) {
    const order = state.pendingCombat.find(p => p.id === event.id);
    assert.ok(order && order.impactTime > state.time, 'visual projectile lacks a future damage order');
    assert.equal(event.count, event.shots.length);
    assert.equal(event.shots.length, 1);
    assert.ok(source.soldierIds.includes(event.sourceSoldierId));
    assert.ok(target.soldierIds.includes(event.targetSoldierId));
    for (const shot of event.shots) assert.ok(Number.isFinite(shot.from.x) && Number.isFinite(shot.to.x));
  }
  for (let i = 0; i < 200 && target.size === initialSize; i++) pulse(state);
  assert.ok(target.size < initialSize, 'projectiles never reached a casualty-producing impact');
  assert.equal(target.size, countMilitary(target.units));
  assert.equal(hb.soldiers, target.size);
  assert.equal(population(state), initialPopulation - state.stats.deaths);
  assert.ok(Math.abs(target.carrying.food - initialFood * target.size / initialSize) < 1e-8);
  assert.ok(Math.abs(state.resourceLedger.food.lost - (initialFood - target.carrying.food)) < 1e-8);
  conserved(state);
});

test('combat pulse replay is deterministic, bounded and exactly frozen with no elapsed time', () => {
  const first = duel(), second = duel();
  for (let i = 0; i < 350; i++) {
    pulse(first.state); pulse(second.state);
    assert.ok(first.state.pendingCombat.every(strike => getSoldier(first.state, strike.sourceSoldierId) && getSoldier(first.state, strike.targetSoldierId)), 'a pending strike lost its canonical shooter or target');
    assert.ok(first.state.combatEvents.length <= COMBAT_LIMITS.effects);
    conserved(first.state);
  }
  assert.deepEqual(first.state, second.state);
  const frozen = structuredClone(first.state);
  for (let i = 0; i < 20; i++) stepCombat(first.state, 0);
  assert.deepEqual(first.state, frozen);
});

function towerFixture() {
  const f = fixture(), { state, center, ha, hb, a } = f;
  setMilitary(state, ha, { infantry: 0, ranged: 2 });
  const tower = { id: 'audit-tower', kind: 'tower', x: center.x - 3, z: center.z, progress: 1,
    hp: DEFENSE_STATS.tower.maxHp, maxHp: DEFENSE_STATS.tower.maxHp };
  ha.buildings = [tower];
  army(state, hb, 'audit-tower-target', { infantry: 20, ranged: 0 }, { x: center.x + 3, z: center.z });
  assignDefenses(state, ha, a);
  for (const body of getSoldiers(state, ha)) Object.assign(body, { x: tower.x, z: tower.z, prevX: tower.x, prevZ: tower.z, positioned: true });
  initializeLedger(state);
  return { ...f, tower };
}

test('operational towers spend species ammunition only when firing real delayed projectiles', () => {
  const { state, ha, tower, a } = towerFixture(), before = { ...ha.stock };
  pulse(state);
  const event = state.combatEvents.find(e => e.type === 'projectile' && e.sourceId === tower.id);
  assert.ok(event?.tower, 'crewed supplied tower failed to fire on visible hostile group');
  assert.ok(state.pendingCombat.some(p => p.id === event.id && p.impactTime > state.time));
  for (const kind of RESOURCES) assert.ok(Math.abs(before[kind] - ha.stock[kind] - (defenseAmmoCost(a.species)[kind] || 0)) < 1e-8, `wrong tower ammunition debit: ${kind}`);
  conserved(state);
});

test('uncrewed, destroyed, unfinished, unfunded and wall-occluded towers cannot shoot', () => {
  for (const reason of ['no-crew', 'lost-crew', 'destroyed', 'unfinished', 'unfunded', 'wall']) {
    const { state, ha, tower, a, center } = towerFixture();
    if (reason === 'no-crew') { setMilitary(state, ha); assignDefenses(state, ha, a); }
    if (reason === 'lost-crew') setMilitary(state, ha); // Intentionally leave operational stale until combat validates it.
    if (reason === 'destroyed') tower.hp = 0;
    if (reason === 'unfinished') tower.progress = .99;
    if (reason === 'unfunded') ha.stock = emptyResources();
    if (reason === 'wall') {
      ha.buildings.push({ id: 'audit-occluder', kind: 'wall', x: center.x, z: center.z, rotation: Math.PI / 2, length: 14, width: 1, wallHeight: 12, progress: 1, hp: 300 });
      invalidateNavigation(state);
    }
    initializeLedger(state); pulse(state);
    assert.ok(!state.combatEvents.some(e => e.sourceId === tower.id), `${reason} tower fired`);
    conserved(state);
  }
});

test('unknown enemy stores, census and production queues never enter a faction view', () => {
  const state = createSimulation('rts-fog-private', { civCount: 4 }), own = state.factions[0];
  initializeKnowledge(state, { reset: true }); stepKnowledge(state, { force: true });
  const hidden = state.settlements.find(home => home.factionId !== own.id && !isVisible(state, own.id, home));
  assert.ok(hidden, 'fixture lacks an unknown enemy');
  const before = JSON.stringify(factionView(state, own.id));
  hidden.stock.materials += 918; hidden.population += 40; hidden.trainingQueue.push({ id: 'secret-course', role: 'ranged', size: 5 });
  hidden.military.ranged += 20; hidden.soldiers += 20;
  stepKnowledge(state, { force: true });
  const shown = factionView(state, own.id);
  // Visibility version changes on observation refresh; private truth must not.
  const redactVersion = text => JSON.parse(text, (key, value) => ['version'].includes(key) ? undefined : value);
  assert.deepEqual(redactVersion(JSON.stringify(shown)), redactVersion(before));
  assert.ok(!JSON.stringify(shown).includes('secret-course'));
});

test('natural paid-unit worlds preserve role, trainee, civilian and resource census each cycle', () => {
  const state = createSimulation('rts-natural-census', { civCount: 4 }), initial = population(state);
  for (let cycle = 0; cycle < 220; cycle++) {
    stepSimulation(state, 10); auditState(state);
    assert.equal(population(state), initial + state.stats.births - state.stats.deaths);
    for (const g of state.groups) assert.ok(terrainAt(g.x, g.z, state.terrainSeed || state.seed).traversable, `party ${g.id} entered impassable terrain`);
  }
  assert.ok(state.stats.trained > 0, 'natural AI never completed a paid training course');
  assert.ok(RESOURCES.some(k => state.resourceLedger[k].training > 0), 'natural training spent no resources');
});

test('hidden foreign harvesting teams cannot change a faction worker-dispatch choices', () => {
  const base = createSimulation('rts-hidden-traffic', { civCount: 4 }), own = base.factions[0], home = base.settlements[0];
  const foreign = base.settlements.find(h => h.factionId !== own.id && Math.hypot(h.x - home.x, h.z - home.z) > 70);
  assert.ok(foreign, 'fixture needs an unseen remote society');
  for (const faction of base.factions) { faction.lastScout = 100; faction.lastArmy = 100; }
  const baseline = structuredClone(base), changed = structuredClone(base);
  const reports = Object.values(own.knowledge).filter(k => k.kind === 'resource');
  assert.ok(reports.length > 0);
  // Foreign commitments differ, but none is locally observable and all have
  // zero cargo, so there is no inventory intervention in either economy.
  for (const report of reports) for (let i = 0; i < 3; i++) changed.groups.push({
    id: `hidden-worker-${report.id}-${i}`, kind: 'worker', factionId: foreign.factionId, originId: foreign.id,
    size: 1, x: foreign.x, z: foreign.z, prevX: foreign.x, prevZ: foreign.z,
    targetId: report.id, targetX: report.x, targetZ: report.z, phase: 'outbound', speed: 0,
    carrying: emptyResources(), capacity: 6, cargoCapacity: 6, supply: 100, morale: 100,
    createdTick: 0, observations: [], resourceKind: report.resourceKind, extractedTotal: 0,
  });
  stepSimulation(baseline, 10); stepSimulation(changed, 10);
  const choices = s => s.groups.filter(g => g.factionId === own.id && g.kind === 'worker').map(g => ({ targetId: g.targetId, size: g.size, resourceKind: g.resourceKind }));
  assert.ok(choices(baseline).length > 0, 'fixture launched no work team');
  assert.deepEqual(choices(changed), choices(baseline), 'hidden foreign traffic changed the planner');
});

test('a wall completed during projectile flight blocks damage without undoing the launched shot', () => {
  const { state, source, target, ha, center } = duel();
  pulse(state);
  const fired = state.combatEvents.filter(e => e.type === 'projectile' && e.sourceId === source.id);
  assert.ok(fired.length > 0);
  const initialSize = target.size, attacks = state.stats.attacks;
  source.disabled = true; target.disabled = true; // Isolate only already-fired projectiles.
  ha.buildings.push({ id: 'audit-late-cover', kind: 'wall', x: center.x, z: center.z,
    rotation: Math.PI / 2, length: 24, width: 1, wallHeight: 12, progress: 1, hp: 300 });
  invalidateNavigation(state);
  for (let i = 0; i < 12; i++) pulse(state);
  assert.equal(target.size, initialSize, 'projectile killed through newly completed cover');
  assert.ok(getSoldiers(state, target).every(body => body.hp === body.maxHp), 'blocked projectile injured a canonical target');
  assert.equal(state.stats.attacks, attacks, 'blocking cover undid the actual fired-shot count');
  assert.ok(!state.pendingCombat.some(p => fired.some(e => e.id === p.id)), 'blocked orders never resolved');
  conserved(state);
});

test('an outbound worker abort cannot remotely refresh its unseen target deposit report', () => {
  const state = createSimulation('rts-worker-abort-report', { civCount: 4 }), home = state.settlements[0], faction = state.factions[0];
  const node = state.nodes.find(n => Math.hypot(n.x - home.x, n.z - home.z) > 80);
  assert.ok(node);
  const prior = { id: node.id, kind: 'resource', resourceKind: node.kind, x: node.x, z: node.z,
    amountEstimate: 900, observedTick: 0, reportedTick: 0, confidence: .8 };
  faction.knowledge[node.id] = { ...prior }; node.amount = 7;
  const worker = { id: 'audit-abort-worker', kind: 'worker', factionId: faction.id, originId: home.id,
    size: 8, x: home.x, z: home.z, prevX: home.x, prevZ: home.z,
    targetId: node.id, targetX: node.x, targetZ: node.z, phase: 'outbound', speed: 2,
    carrying: emptyResources(), capacity: 48, cargoCapacity: 48, supply: 1, morale: 90,
    createdTick: 0, observations: [], resourceKind: node.kind, extractedTotal: 0 };
  state.groups = [worker]; initializeLedger(state);
  assert.equal(isVisible(state, faction.id, node), false);
  stepSimulation(state, 1);
  assert.equal(worker.phase, 'returning');
  assert.ok(!worker.observations.some(o => o.id === node.id), 'supply abort read the remote deposit');
  stepSimulation(state, 1); // The same crew is already physically home.
  assert.ok(!state.groups.includes(worker));
  assert.equal(faction.knowledge[node.id].amountEstimate, prior.amountEstimate);
  assert.equal(faction.knowledge[node.id].observedTick, prior.observedTick);
  conserved(state);
});

test('every actual formation body stays on connected terrain beside a solid wall', () => {
  const { state, center, ha } = fixture();
  const units = { infantry: 40, ranged: 40 };
  ha.buildings.push({ id: 'audit-flank-wall', kind: 'wall', x: center.x, z: center.z,
    rotation: Math.PI / 2, length: 30, width: 1, progress: 1, hp: 300 });
  invalidateNavigation(state);
  const g = army(state, ha, 'audit-wall-flank', units, { x: center.x - 1.1, z: center.z - 2 });
  g.speed = 3; g.targetX = g.x; g.targetZ = center.z + 6;
  for (let i = 0; i < 20; i++) {
    state.step++; state.time = state.step / 10; g.z += .15;
    updateCombatFormation(state, g, units, .1, { yaw: 0 });
    assert.equal(g.formationSlots.infantry.length + g.formationSlots.ranged.length, g.size);
    for (let index = 0; index < g.size; index++) {
      const p = combatFormationSlot(g, index), role = index < units.infantry ? 'infantry' : 'ranged';
      const body = g.formationSlots[role][index - (role === 'ranged' ? units.infantry : 0)];
      assert.equal(p.x, body.x); assert.equal(p.z, body.z);
      assert.ok(p.x < center.x - .5, `actual ${role} body crossed a solid wall`);
      assert.ok(terrainAt(p.x, p.z, state.terrainSeed || state.seed).traversable, 'actual body entered impassable terrain');
      assert.ok(isSegmentTraversable(state, { x: body.prevX, z: body.prevZ }, body, { factionId: g.factionId, radius: .08 }), 'body moved through an obstruction');
      assert.ok(Math.hypot(body.x - body.prevX, body.z - body.prevZ) <= .4 + 1e-8, 'individual formation body teleported');
    }
  }
});

test('occupation preserves native species, actual citizens, deployed roles and local stores', () => {
  const { state, ha, hb, a, b } = fixture();
  const invader = army(state, ha, 'audit-occupying-army', { infantry: 20, ranged: 12 }, hb);
  setMilitary(state, hb, { infantry: 8, ranged: 4 });
  const original = { population: population(state), nativeFactionId: hb.factionId, species: b.species, stock: { ...hb.stock }, military: hb.soldiers };
  initializeLedger(state);
  assert.equal(occupySettlement(state, hb, invader), true);
  assert.equal(hb.factionId, original.nativeFactionId);
  assert.equal(state.factions.find(f => f.id === hb.factionId).species, original.species);
  assert.equal(hb.occupiedBy, a.id); assert.equal(settlementController(state, hb), a.id);
  assert.equal(population(state), original.population, 'occupation deleted or created civilians');
  assert.deepEqual(hb.stock, original.stock, 'occupation teleported held stock');
  assert.equal(hb.soldiers, 0, 'surrendered home troops did not demobilize');
  assert.equal(hb.population - hb.soldiers, hb.population);
  assert.equal(invader.size, 32); assert.equal(countMilitary(invader.units), 32);
  assert.equal(state.stats.deaths, 0, 'surrender was counted as a death');
  const captures = state.stats.captures;
  assert.equal(occupySettlement(state, hb, invader), false, 'repeat capture repeated its effects');
  assert.equal(state.stats.captures, captures);
  conserved(state);
});

test('exchanged capitals preserve both territorial sovereignties until a real later liberation wins', () => {
  const { state, ha, hb, a, b } = fixture();
  state.factions = [a, b]; state.settlements = [ha, hb];
  const ga = army(state, ha, 'audit-mutual-a', { infantry: 4, ranged: 0 }, hb);
  const gb = army(state, hb, 'audit-mutual-b', { infantry: 4, ranged: 0 }, ha);
  initializeLedger(state); const initial = population(state);
  assert.ok(occupySettlement(state, hb, ga));
  assert.ok(occupySettlement(state, ha, gb));
  for (let i = 0; i < 3; i++) updateConquest(state);
  assert.equal(population(state), initial);
  assert.equal(state.outcome.status, 'ongoing', 'iteration order decided a winner despite both sides controlling territory');
  assert.ok(!a.defeatedBy && !b.defeatedBy);
  assert.equal(sovereignHomes(state, a.id).length, 1); assert.equal(sovereignHomes(state, b.id).length, 1);
  // A later, separately staged physical contact liberates the first capital.
  // This explicit transition fixture does not claim that a natural march occurred.
  ga.x = ha.x; ga.z = ha.z;
  for (const body of getSoldiers(state, ga)) Object.assign(body, { x: ha.x, z: ha.z, prevX: ha.x, prevZ: ha.z, positioned: true });
  assert.ok(occupySettlement(state, ha, ga));
  updateConquest(state);
  assert.equal(state.outcome.status, 'victory', 'genuine all-territory control never resolved the war');
  const winner = state.outcome.winnerId;
  assert.equal(winner, a.id);
  assert.ok(state.factions.some(f => f.id === winner && !f.defeatedBy));
  assert.ok(sovereignHomes(state, winner).length > 0);
  for (const home of state.settlements) assert.equal(settlementController(state, home), winner);
  conserved(state);
});

test('an elapsed deadline alone cannot declare domination while independent factions still have homes', () => {
  const { state } = fixture();
  state.tick = 5000; state.step = 50000; state.time = 5000;
  const before = population(state);
  updateConquest(state);
  assert.equal(state.outcome.status, 'ongoing');
  assert.equal(state.outcome.winnerId, null);
  assert.ok(state.factions.every(f => !f.defeatedBy));
  assert.equal(population(state), before);
});

test('an attacking army progresses a siege against the effective occupier of a defeated native home', () => {
  const { state, a, b, hb } = fixture(), third = state.factions[2], hc = state.settlements[2];
  hb.occupiedBy = a.id; b.defeatedBy = a.id; b.status = 'capitulated';
  a.relations[third.id] = { status: 'hostile', trust: 0 }; third.relations[a.id] = { status: 'hostile', trust: 0 };
  const attacker = army(state, hc, 'audit-occupied-assault', { infantry: 24, ranged: 12 }, { x: hb.x + 3, z: hb.z });
  // This isolated siege starts with extended field rations for its distant return.
  Object.assign(attacker, { targetId: hb.id, targetX: hb.x, targetZ: hb.z, phase: 'engaging', campaign: true, provisionFactor: 2 });
  initializeLedger(state);
  for (let i = 0; i < 220 && !hb.razed; i++) {
    state.step++; state.tick = Math.floor(state.step / 10); state.time = state.step / 10;
    for (const f of state.factions) { f.lastScout = state.tick; f.lastArmy = state.tick; }
    stepStrategy(state, .1);
  }
  assert.ok(attacker.engagedDays > 0, 'occupied target caused an endless return/reacquire loop');
  assert.equal(hb.razed, true, 'undefended legacy occupied settlement never reached destruction');
  assert.equal(settlementController(state, hb), a.id, 'destruction transferred ownership');
  assert.equal(hb.factionId, b.id, 'destruction changed native identity');
  conserved(state);
});

test('forward-depot stops consume local rations and never remotely finish a home return or deliver carried spoils', () => {
  for (const phase of ['outbound', 'returning']) {
    const { state, a, b, ha, hb } = fixture(), target = state.settlements[2];
    hb.occupiedBy = a.id; b.defeatedBy = a.id;
    const g = army(state, ha, `audit-staging-${phase}`, { infantry: 18, ranged: 6 }, hb);
    Object.assign(g, { phase, supply: 50, provisionFactor: 2, targetId: target.id, targetX: hb.x, targetZ: hb.z,
      stagingHomeId: hb.id, stagingTargetId: hb.id, stagingPurpose: phase === 'returning' ? 'return' : 'outbound',
      missionTargetX: target.x, missionTargetZ: target.z, campaign: true });
    g.carrying.materials = 20;
    initializeLedger(state);
    const originStock = { ...ha.stock }, depotStock = { ...hb.stock }, cargo = { ...g.carrying };
    state.step = 1; state.tick = 0; state.time = .1;
    stepStrategy(state, .1);
    assert.ok(state.groups.includes(g) && !g.finished, 'supply depot teleported surviving troops home');
    assert.equal(g.originId, ha.id); assert.equal(g.x, hb.x); assert.equal(g.z, hb.z);
    assert.deepEqual(ha.stock, originStock, 'supply depot remotely credited original home');
    assert.deepEqual(g.carrying, cargo, 'supply stop delivered army spoils early');
    assert.equal(g.supply, 100); assert.equal(state.stats.supplyStops, 1);
    assert.ok(RESOURCES.some(k => hb.stock[k] < depotStock[k]), 'supply stop refilled without paid local stores');
    assert.ok(RESOURCES.some(k => state.resourceLedger[k].consumed > 0));
    assert.equal(g.stagingTargetId, null);
    const onward = phase === 'returning' ? ha : target;
    assert.equal(g.targetX, onward.x); assert.equal(g.targetZ, onward.z);
    conserved(state);
  }
});

test('a scout physically reports at a held waystation, keeps its crew and cargo in the field, and only finishes at its native home', () => {
  const { state, a, b, ha, hb } = fixture(), remote = state.settlements[2];
  hb.occupiedBy = a.id; b.defeatedBy = a.id; a.knowledge = {};
  const scout = { id: 'audit-waystation-scout', kind: 'scout', factionId: a.id, originId: ha.id,
    x: hb.x, z: hb.z, prevX: hb.x, prevZ: hb.z, targetX: hb.x, targetZ: hb.z,
    reportStopId: hb.id, phase: 'returning', size: 4, initialSize: 4, speed: 3, supply: 100, morale: 90,
    createdTick: 0, carrying: { ...emptyResources(), materials: 3 },
    observations: [{ id: remote.id, kind: 'settlement', ownerId: remote.factionId, x: remote.x, z: remote.z,
      populationEstimate: 100, soldiersEstimate: 12, status: 'active', observedTick: 0, reportedTick: null, confidence: .9 }] };
  state.groups = [scout]; state.tick = 1; state.step = 11; state.time = 1.1;
  initializeLedger(state); const initial = population(state), originStock = { ...ha.stock };
  stepStrategy(state, .1);
  assert.equal(a.knowledge[remote.id].reportMethod, 'waystation');
  assert.equal(a.knowledge[remote.id].reportedAtSettlementId, hb.id);
  assert.equal(a.knowledge[remote.id].observedTick, 0);
  assert.equal(a.knowledge[remote.id].reportedTick, 1);
  assert.ok(state.groups.includes(scout) && !scout.finished);
  assert.equal(scout.originId, ha.id); assert.equal(scout.carrying.materials, 3);
  assert.deepEqual(ha.stock, originStock); assert.equal(population(state), initial);
  assert.equal(scout.targetX, ha.x); assert.equal(scout.targetZ, ha.z);
  conserved(state);
  for (let i = 0; i < 1800 && state.groups.includes(scout); i++) {
    const before = { x: scout.x, z: scout.z };
    state.step++; state.tick = Math.floor(state.step / 10); state.time = state.step / 10;
    for (const f of state.factions) { f.lastScout = state.tick; f.lastArmy = state.tick; }
    stepStrategy(state, .1);
    assert.ok(Math.hypot(scout.x - before.x, scout.z - before.z) <= .6 + 1e-8, 'scout teleported after its report stop');
    if (!state.groups.includes(scout)) assert.ok(Math.hypot(scout.x - ha.x, scout.z - ha.z) < 1, 'scout released away from its native home');
  }
  assert.ok(!state.groups.includes(scout), 'scout never completed the actual homeward route');
  assert.equal(population(state), initial);
  conserved(state);
});

test('scouts recheck stale believed-friendly settlements without refreshing their ownership from hidden truth', () => {
  const { state, a, ha, hb } = fixture();
  state.tick = 400; state.step = 4000; state.time = 400;
  a.knowledge = {
    [ha.id]: { id: ha.id, kind: 'settlement', ownerId: a.id, x: ha.x, z: ha.z, observedTick: 400, reportedTick: 400, confidence: 1, status: 'active' },
    [hb.id]: { id: hb.id, kind: 'settlement', ownerId: a.id, x: hb.x, z: hb.z, observedTick: 10, reportedTick: 20, confidence: .8, status: 'active', populationEstimate: 200, soldiersEstimate: 0 },
  };
  for (const f of state.factions) { f.lastScout = 400; f.lastArmy = 400; }
  a.lastScout = 0; a.scoutCount = 1;
  initializeLedger(state);
  stepStrategy(state, 0);
  const scout = state.groups.find(g => g.kind === 'scout' && g.factionId === a.id);
  assert.ok(scout, 'no scout was dispatched');
  assert.equal(scout.surveyTargetId, hb.id, 'stale friendly ownership permanently excluded a lost settlement from recon');
  assert.equal(scout.targetX, a.knowledge[hb.id].x); assert.equal(scout.targetZ, a.knowledge[hb.id].z);
  assert.equal(a.knowledge[hb.id].ownerId, a.id, 'planner secretly read current enemy ownership');
  assert.equal(a.knowledge[hb.id].reportedTick, 20, 'planner fabricated a new observation');
  conserved(state);
});

test('native scouts can physically observe changed control of their own occupied settlement without telepathic command updates', () => {
  const { state, a, b, ha } = fixture();
  ha.occupiedBy = b.id;
  a.knowledge = { [ha.id]: { id: ha.id, kind: 'settlement', ownerId: a.id, x: ha.x, z: ha.z, observedTick: 0, reportedTick: 0, confidence: 1, status: 'active' } };
  state.tick = 5; state.step = 50; state.time = 5;
  const scout = { id: 'audit-native-recon', factionId: a.id, originId: ha.id, kind: 'scout', size: 4,
    x: ha.x + 2, z: ha.z, observations: [], phase: 'returning' };
  state.groups = [scout];
  observeGroup(state, scout);
  const observation = scout.observations.find(o => o.id === ha.id);
  assert.ok(observation, 'native identity suppressed an actual occupied-home observation');
  assert.equal(observation.ownerId, b.id); assert.equal(observation.observedTick, 5);
  assert.equal(observation.reportedTick, null);
  assert.equal(a.knowledge[ha.id].ownerId, a.id, 'local scout sight bypassed physical report transit');
  stepKnowledge(state, { force: true });
  assert.equal(a.knowledge[ha.id].ownerId, b.id, 'actual scout LOS must report changed control live');
});

test('one exile base trains paid native citizens with explicit command and loses eligibility when a native home returns', () => {
  const { state, a, b, ha, hb } = fixture(), hc = state.settlements[2];
  ha.occupiedBy = b.id; hb.occupiedBy = a.id; hc.occupiedBy = a.id;
  const producer = unitStats(b.species, 'infantry').building;
  hb.buildings.push({ id: 'audit-exile-producer', kind: producer, x: hb.x, z: hb.z, progress: 1, hp: 160 });
  houseExistingPopulation(hb, b);
  refreshExileBases(state);
  assert.equal(hb.exileBaseFor, a.id); assert.equal(commandFactionForHome(state, hb), a.id);
  assert.equal(state.settlements.filter(h => h.exileBaseFor === a.id).length, 1);
  assert.equal(commandFactionForHome(state, hc), null, 'multiple occupied bases gained independent recruitment');
  initializeLedger(state); const beforePopulation = population(state), beforeStock = { ...hb.stock };
  const job = queueTraining(state, hb, a, 'infantry', 4);
  assert.ok(job, 'sovereign exile cannot fund a native auxiliary course');
  assert.equal(job.commandFactionId, a.id); assert.equal(job.nativeFactionId, b.id);
  assert.equal(hb.buildings.find(building => building.id === job.buildingId).kind, producer);
  if (b.species === 'machine') assert.equal(job.cost.food, 0, 'human commander changed machine native needs');
  for (const kind of RESOURCES) assert.ok(Math.abs(beforeStock[kind] - hb.stock[kind] - job.cost[kind]) < 1e-8);
  assert.equal(hb.soldiers, 0); assert.equal(hb.assigned.training, 4);
  state.tick += Math.ceil(job.duration); state.step = state.tick * 10; state.time = state.tick;
  assert.equal(advanceTraining(state, hb, a), 4);
  assert.equal(hb.factionId, b.id); assert.equal(hb.military.infantry, 4); assert.equal(population(state), beforePopulation);
  const pending = queueTraining(state, hb, a, 'infantry', 2); assert.ok(pending);
  ha.occupiedBy = null; refreshExileBases(state);
  assert.equal(hb.exileBaseFor, null); assert.equal(commandFactionForHome(state, hb), null);
  state.tick++; state.step = state.tick * 10; state.time = state.tick;
  advanceTraining(state, hb, a);
  assert.equal(hb.trainingQueue.length, 0); assert.equal(hb.military.infantry, 4, 'ineligible course completed');
  assert.equal(population(state), beforePopulation); conserved(state);
});

test('political command controls battle allegiance while native species and demographic origin stay fixed', () => {
  for (const sameCommand of [true, false]) {
    const { state, center, a, b, ha, hb } = fixture();
    // Different commands can use the same native species; different native
    // populations can also serve the same command without fighting each other.
    if (!sameCommand) ha.factionId = b.id;
    const left = army(state, ha, 'audit-command-left', { infantry: 0, ranged: 24 }, { x: center.x - 3, z: center.z });
    const right = army(state, hb, 'audit-command-right', { infantry: 0, ranged: 24 }, { x: center.x + 3, z: center.z });
    left.commandFactionId = a.id; right.commandFactionId = sameCommand ? a.id : b.id;
    const native = [left.factionId, right.factionId];
    pulse(state);
    assert.deepEqual([left.factionId, right.factionId], native);
    assert.equal(left.factionId, ha.factionId); assert.equal(right.factionId, hb.factionId);
    assert.equal(groupController(state, left), a.id);
    if (sameCommand) assert.equal(state.stats.attacks || 0, 0, 'allied native auxiliaries attacked each other');
    else {
      assert.ok(state.stats.attacks > 0, 'same-native opposing commands failed to fight');
      for (const effect of state.combatEvents.filter(e => e.type === 'projectile')) assert.equal(effect.species, b.species, 'political command changed native weapon/body species');
    }
    conserved(state);
  }
});

test('an auxiliary cannot pass an enemy gate merely because its native identity matches the gate owner', () => {
  const { state, center, a, b } = fixture();
  state.walls = [{ id: 'audit-native-gate', kind: 'gate', factionId: b.id, x: center.x, z: center.z,
    rotation: 0, length: 14, width: 1, gateWidth: 5, progress: 1, hp: 240 }];
  invalidateNavigation(state);
  const target = { x: center.x, z: center.z + 1 };
  const auxiliary = { id: 'audit-gate-auxiliary', kind: 'army', factionId: b.id, commandFactionId: a.id,
    x: center.x, z: center.z - 1, speed: 0 };
  assert.equal(moveAlongRoute(state, auxiliary, target, { dt: .1, arrival: 3 }), false, 'native identity bypassed hostile gate control');
  const native = { ...auxiliary, id: 'audit-gate-native', commandFactionId: b.id, navigation: undefined };
  assert.equal(moveAlongRoute(state, native, target, { dt: .1, arrival: 3 }), true, 'legitimate gate owner could not pass');
});

test('exchanged native capitals still produce real controlled scouts and paid auxiliary units', () => {
  const state = createSimulation('audit-exile-agency', { civCount: 3 }), [a, b] = state.factions, [ha, hb] = state.settlements;
  ha.occupiedBy = b.id; hb.occupiedBy = a.id;
  setMilitary(state, ha); setMilitary(state, hb);
  const initial = population(state), seenCommands = new Set();
  initializeLedger(state);
  for (let cycle = 0; cycle < 160; cycle++) {
    stepSimulation(state, 10); auditState(state);
    for (const group of state.groups) if (group.commandFactionId && group.commandFactionId !== group.factionId) seenCommands.add(group.commandFactionId);
    assert.equal(population(state), initial + state.stats.births - state.stats.deaths);
  }
  assert.ok(seenCommands.has(a.id) && seenCommands.has(b.id), 'one exchanged-capital government remained unable to dispatch real citizens');
  assert.ok(state.stats.trained > 0 && RESOURCES.some(k => state.resourceLedger[k].training > 0), 'exile conflict resumed with free or untrained troops');
  assert.equal(ha.factionId, a.id); assert.equal(hb.factionId, b.id);
});

test('auxiliary command controls fog ownership and hidden native troops are not duplicated as bodies at home', () => {
  const { state, a, b, ha, hb } = fixture();
  hb.occupiedBy = a.id;
  const auxiliary = army(state, hb, 'audit-fog-auxiliary', { infantry: 8, ranged: 4 }, { x: ha.x + 3, z: ha.z });
  auxiliary.commandFactionId = a.id;
  auxiliary.targetId = ha.id; auxiliary.carrying.materials = 3;
  initializeKnowledge(state, { reset: true }); stepKnowledge(state, { force: true });
  const commanded = factionView(state, a.id), native = factionView(state, b.id);
  assert.ok(commanded.groups.some(g => g.id === auxiliary.id), 'commander cannot see its auxiliary');
  assert.ok(!native.groups.some(g => g.id === auxiliary.id), 'native identity revealed an unseen opposing-command army');
  const commandedHome = commanded.settlements.find(h => h.id === hb.id), nativeHome = native.settlements.find(h => h.id === hb.id);
  assert.equal(commandedHome.population, hb.population - auxiliary.size);
  assert.equal(nativeHome.population, hb.population - auxiliary.size, 'hidden commanded-away troops reappeared as home bodies');
  assert.equal(commandedHome.military.infantry + commandedHome.military.ranged, 0, 'deployed auxiliary also appeared as home garrison');
  auxiliary.x = hb.x + 2; auxiliary.z = hb.z; state.step++; state.time = state.step / 10;
  stepKnowledge(state, { force: true });
  const visible = factionView(state, b.id).groups.find(g => g.id === auxiliary.id);
  assert.ok(visible, 'native observer cannot physically see a nearby auxiliary');
  assert.equal(visible.knowledgeView, 'visible'); assert.equal(visible.originId, null); assert.equal(visible.targetId, null);
  assert.equal(visible.carrying.materials, 0, 'opposing command cargo leaked through native identity');
  assert.equal(groupController(state, auxiliary), a.id); assert.equal(auxiliary.factionId, b.id);
});
