import test from 'node:test';
import assert from 'node:assert/strict';
import { createBattle, stepBattle, getBattleView, issueBattleOrder, battleSummary, ROLE_STATS, predictIntercept, battleLineOfSight } from '../src/battle/sim.js';

function place(unit, x, z, extras = {}) {
  Object.assign(unit, { x, z, prevX: x, prevZ: z, vx: 0, vz: 0, speed: 0, targetId: null, attackReadyAt: 1e6,
    order: { type: 'hold', x, z }, ...extras });
  return unit;
}
function fixture(perSide = 3) {
  const state = createBattle('controlled-contract', { perSide }); state.obstacles = [];
  for (const team of ['blue', 'red']) state.units.filter(u => u.team === team).forEach((unit, i) => place(unit, team === 'blue' ? -29 : 29, -18 + i * 1.1));
  return { state, blue: state.units.filter(u => u.team === 'blue'), red: state.units.filter(u => u.team === 'red') };
}
function advance(state, seconds) { for (let i = 0; i < Math.round(seconds * 10); i++) stepBattle(state); }
const strikes = (state, id) => state.events.filter(e => e.type === 'shot' && e.sourceId === id);

test('default seeded creation is exactly 24 persistent individual soldiers per side and deterministic', () => {
  const a = createBattle('same-seed'), b = createBattle('same-seed');
  assert.equal(a.units.length, 48); assert.equal(new Set(a.units.map(u => u.id)).size, 48);
  for (const team of ['blue', 'red']) {
    assert.deepEqual(battleSummary(a).teams[team].roles, { infantry: 14, ranged: 8, scout: 2 });
    assert.equal(a.squads.filter(s => s.team === team).flatMap(s => s.unitIds).length, 24);
  }
  advance(a, 5); advance(b, 5);
  assert.deepEqual(getBattleView(a), getBattleView(b));
  assert.equal(getBattleView(createBattle(), 'blue').units.length, 24);
});

test('damage, cooldown and death are charged to the exact retained victim, never a peer', () => {
  const { state, blue, red } = fixture();
  const attacker = place(blue[0], -.6, 0, { attackReadyAt: 0 }), casualty = place(red[0], .6, 0, { hp: 31 });
  place(red[1], .6, 3); const peerHp = red[1].hp;
  stepBattle(state);
  assert.equal(casualty.hp, 13); assert.equal(red[1].hp, peerHp);
  advance(state, 1.1);
  assert.equal(casualty.hp, 0); assert.equal(casualty.alive, false);
  const impacts = state.events.filter(e => e.type === 'impact' && e.targetId === casualty.id);
  assert.deepEqual(impacts.map(e => [e.hpBefore, e.damage, e.hpAfter]), [[31, 18, 13], [13, 13, 0]]);
  const shots = strikes(state, attacker.id);
  assert.equal(shots.length, 2); assert.ok(shots[1].time - shots[0].time >= attacker.attackCooldown);
  assert.equal(state.events.filter(e => e.type === 'death' && e.targetId === casualty.id).length, 1);
  const atDeath = { x: casualty.x, z: casualty.z };
  assert.deepEqual(issueBattleOrder(state, [casualty.id], { type: 'move', x: 10, z: 10 }).accepted, []);
  advance(state, 1);
  assert.equal(state.units.find(u => u.id === casualty.id), casualty);
  assert.deepEqual({ x: casualty.x, z: casualty.z }, atDeath); assert.equal(red[1].hp, peerHp);
});

test('all 24 individually eligible melee soldiers can strike in one pulse', () => {
  const { state, blue, red } = fixture(24);
  for (const [index, army] of [blue, red].entries()) army.forEach((unit, i) => place(unit, index ? .6 : -.6, -19 + i * 1.65,
    { role: 'infantry', hp: 1000, maxHp: 1000, attackRange: ROLE_STATS.infantry.range, attackDamage: 18, attackReadyAt: index ? 1e6 : 0 }));
  stepBattle(state);
  const shots = state.events.filter(e => e.type === 'shot' && e.sourceTeam === 'blue');
  assert.equal(shots.length, 24); assert.equal(new Set(shots.map(e => e.sourceId)).size, 24);
  assert.equal(new Set(shots.map(e => e.targetId)).size, 24);
  assert.ok(red.every(u => u.hp === 982));
});

test('a viable target stays selected when a marginally nearer opponent arrives', () => {
  const { state, blue, red } = fixture();
  const unit = place(blue[0], 0, 0), original = place(red[0], 1.25, 0);
  stepBattle(state); assert.equal(unit.targetId, original.id);
  place(red[1], .9, .7);
  advance(state, .8); assert.equal(unit.targetId, original.id);
  assert.equal(state.events.filter(e => e.type === 'decision' && e.sourceId === unit.id && e.oldTargetId && e.oldTargetId !== e.targetId).length, 0);
  original.hp = 0; original.alive = false;
  stepBattle(state); assert.equal(unit.targetId, red[1].id);
  assert.equal(state.events.filter(e => e.type === 'decision' && e.sourceId === unit.id).at(-1).reason, 'target-dead');
});

test('friendly targets are rejected and a launched arrow cannot damage a newly friendly unit', () => {
  const { state, blue, red } = fixture();
  const archer = place(blue.find(u => u.role === 'ranged'), 0, 0, { attackReadyAt: 0 }), target = place(red[0], 7, 0);
  assert.deepEqual(issueBattleOrder(state, [archer.id], { type: 'attack', targetId: blue[0].id }).accepted, []);
  stepBattle(state); assert.equal(strikes(state, archer.id).length, 1);
  target.team = 'blue'; advance(state, .4);
  assert.equal(target.hp, target.maxHp);
  assert.equal(state.events.filter(e => e.type === 'impact' && e.targetId === target.id).length, 0);
});

test('wounded soldiers withdraw independently and remain valid victims', () => {
  const { state, blue, red } = fixture();
  const wounded = place(red[0], 7, 0, { hp: 20 });
  const healthyPeer = place(red[1], 0, 8, { attackReadyAt: 0 });
  place(blue[0], 1.2, 8); const archer = place(blue.find(u => u.role === 'ranged'), 0, 0, { attackReadyAt: 0 });
  stepBattle(state);
  assert.equal(wounded.action, 'withdraw'); assert.equal(wounded.alive, true);
  assert.equal(healthyPeer.withdrawing, false); assert.ok(strikes(state, healthyPeer.id).length);
  assert.equal(strikes(state, archer.id)[0].targetId, wounded.id);
  advance(state, .4);
  const hit = state.events.find(e => e.type === 'impact' && e.targetId === wounded.id);
  assert.equal(hit.damage, 13); assert.equal(hit.targetAction, 'withdraw'); assert.equal(wounded.hp, 7);
});

test('arrows use fixed visible flight endpoints and genuinely miss a target that leaves them', () => {
  const { state, blue, red } = fixture();
  const archer = place(blue.find(u => u.role === 'ranged'), 0, 0, { attackReadyAt: 0 }), target = place(red[0], 7, 0);
  stepBattle(state); const shot = state.projectiles.find(p => p.sourceId === archer.id);
  assert.ok(shot); const endpoint = { x: shot.toX, z: shot.toZ };
  const event = strikes(state, archer.id)[0]; assert.equal(event.targetX, shot.toX); assert.equal(event.targetZ, shot.toZ);
  place(target, 7, 4); advance(state, .4);
  assert.equal(target.hp, target.maxHp);
  const miss = state.events.find(e => e.type === 'miss' && e.shotId === shot.id);
  assert.deepEqual({ x: miss.x, z: miss.z }, endpoint); assert.equal(miss.damage, 0);
  assert.equal(state.events.filter(e => e.type === 'impact' && e.shotId === shot.id).length, 0);
});

test('flight obstruction cancels a ranged hit instead of applying damage through cover', () => {
  const { state, blue, red } = fixture();
  const archer = place(blue.find(u => u.role === 'ranged'), 0, 0, { attackReadyAt: 0 }), target = place(red[0], 7, 0);
  stepBattle(state);
  state.obstacles = [{ id: 'test-cover', x: 3, z: 0, width: 1, depth: 3, blocksSight: true }];
  assert.equal(battleLineOfSight(state, archer, target), false); advance(state, .4);
  assert.equal(target.hp, target.maxHp); assert.ok(state.events.some(e => e.type === 'miss'));
});

test('interception math refuses faster escaping targets and bounds feasible predictions', () => {
  const pursuer = { x: 0, z: 0, speed: 2.75, attackRange: 1.48 };
  assert.equal(predictIntercept(pursuer, { x: 6, z: 0, vx: 4.25, vz: 0 }), null);
  assert.equal(predictIntercept(pursuer, { x: 20, z: 0, vx: 1, vz: 0 }), null);
  const target = { x: 4, z: 0, vx: 1, vz: .3 }, intercept = predictIntercept(pursuer, target);
  assert.ok(intercept && intercept.time <= 3);
  assert.ok(Math.abs(Math.hypot(intercept.x, intercept.z) - (pursuer.speed * intercept.time + pursuer.attackRange)) < 1e-7);
});

test('actual AI abandons an impossible chase and does not immediately reacquire it', () => {
  const { state, blue, red } = fixture();
  const pursuer = place(blue[0], 0, 0, { speed: 2.75, order: { type: 'auto' } });
  const target = place(red[0], 6, 0, { role: 'scout', speed: 4.25, vx: 4.25, order: { type: 'move', x: 24, z: 0 } });
  stepBattle(state);
  assert.equal(pursuer.targetId, null); assert.notEqual(pursuer.action, 'pursue'); assert.equal(pursuer.reasonCode, 'pursuit-refused');
  advance(state, 1);
  assert.ok(!state.events.some(e => e.type === 'decision' && e.sourceId === pursuer.id && e.targetId === target.id));
  assert.equal(pursuer.targetId, null); assert.ok(state.metrics.pursuitRefusals >= 1);
});

test('an actual feasible interception records the observed velocity and reachable point', () => {
  const { state, blue, red } = fixture();
  const pursuer = place(blue[0], 0, 0, { role: 'scout', speed: 4.25, order: { type: 'auto' } });
  place(red[0], 4, 0, { speed: 1, vx: 1, order: { type: 'move', x: 20, z: 0 } });
  stepBattle(state);
  assert.equal(pursuer.action, 'intercept');
  const event = state.events.find(e => e.type === 'decision' && e.sourceId === pursuer.id && e.action === 'intercept');
  assert.ok(event.intercept.time <= 3); assert.equal(event.targetVX, 1);
  assert.ok(Math.hypot(event.intercept.x - event.sourceX, event.intercept.z - event.sourceZ) <= event.pursuerSpeed * event.intercept.time + pursuer.attackRange + 1e-6);
});

test('shared navigation takes a move order around cover while sight remains blocked', () => {
  const { state, blue, red } = fixture();
  const unit = place(blue[0], -5, 0, { speed: ROLE_STATS.infantry.speed });
  place(red[0], 5, 0);
  state.obstacles = [{ id: 'central-cover', x: 0, z: 0, width: 2, depth: 4, blocksSight: true }];
  assert.equal(battleLineOfSight(state, unit, red[0]), false);
  assert.ok(!getBattleView(state, 'blue').units.some(u => u.id === red[0].id));
  issueBattleOrder(state, [unit.id], { type: 'move', x: 5, z: 0 });
  let largestDetour = 0;
  for (let i = 0; i < 70; i++) { stepBattle(state); largestDetour = Math.max(largestDetour, Math.abs(unit.z)); assert.ok(Math.abs(unit.x) >= 1 + unit.radius - .02 || Math.abs(unit.z) >= 2 + unit.radius - .02); }
  assert.ok(largestDetour > 2.3); assert.ok(Math.hypot(unit.x - 5, unit.z) < 1);
  assert.equal(state.metrics.navigationBuilds, 2, 'one initial graph and one rebuild for the edited fixture');
});

test('invalid time pulses and malformed orders make no partial simulation changes', () => {
  const state = createBattle(); const before = getBattleView(state);
  for (const dt of [0, -1, Infinity, NaN, 1]) assert.throws(() => stepBattle(state, dt), RangeError);
  assert.deepEqual(issueBattleOrder(state, [state.units[0].id], { type: 'move', x: NaN, z: 0 }).accepted, []);
  assert.deepEqual(getBattleView(state), before);
});
