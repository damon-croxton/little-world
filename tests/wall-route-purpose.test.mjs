import { setMilitary, bindArmy } from './roster-fixtures.mjs';
import { getSoldiers } from '../src/sim/soldiers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { defenseBuildingPlan, canCompleteDefense } from '../src/sim/defenses.js';
import { assessBreachRoute, findPath, isSegmentTraversable, moveAlongRoute, invalidateNavigation } from '../src/sim/navigation.js';

function fixture() {
  const owner = { id: 'owner', species: 'human', relations: {}, traits: { aggression: .3 }, knowledge: {} };
  const enemy = { id: 'enemy', relations: {} }, ally = { id: 'ally', relations: { owner: { status: 'allied' } } };
  const home = { id: 'town', factionId: owner.id, x: -78, z: -120, population: 400, health: 100, wellbeing: 1, shortageDays: 0, military: { ranged: 9 }, buildings: [], status: 'town' };
  owner.knowledge.materials = { id: 'materials', kind: 'resource', resourceKind: 'materials', x: home.x + 30, z: home.z, amountEstimate: 1000, richnessEstimate: 1, observedTick: 100, reportedTick: 100 };
  const state = { seed: 'joined-screen', step: 1000, tick: 100, time: 100, factions: [owner, enemy, ally], settlements: [home], groups: [], walls: [] };
  setMilitary(state, home, { infantry: 2, ranged: 9 });
  return { state, home, owner, enemy, ally, goal: owner.knowledge.materials };
}
function build(state, home, owner, count) {
  const plans = [];
  for (let i = 0; i < count; i++) {
    const plan = defenseBuildingPlan(state, home, owner);
    assert.ok(plan, `missing funded slot ${i}`);
    const building = { ...plan, id: `defense-${i}`, progress: 1 };
    home.buildings.push(building); plans.push(building);
    home.lastDefenseStarted = state.tick; state.tick += 24; state.step += 240; state.time += 24;
    invalidateNavigation(state);
  }
  return plans;
}
function standingWall(id, x, z, length, hp = 300) {
  return { id, factionId: 'enemy', kind: 'wall', x, z, rotation: Math.PI / 2, length, width: 1, hp, maxHp: hp, progress: 1 };
}

test('funded fortifications enclose the base with joined gates and preserve a real harvesting route', () => {
  const { state, home, owner, goal } = fixture(), before = structuredClone(state);
  assert.equal(defenseBuildingPlan(state, home, owner).kind, 'gate');
  const cached = home.perimeterPlan; delete home.perimeterPlan;
  assert.deepEqual(state, before, 'planning must not fund construction, move bodies, or change the census'); home.perimeterPlan = cached;
  const plans = build(state, home, owner, cached.plans.length + 2), gate = plans[0], screen = plans.filter(p => p.kind !== 'tower');
  assert.equal(screen.length, cached.plans.length); assert.equal(plans.filter(p => p.kind === 'tower').length, 2);
  assert.ok(screen.filter(p => p.kind === 'gate').length >= 2);
  assert.ok(plans.every(p => p.topologyId === gate.topologyId));
  const nodes = new Map();
  for (const wall of screen) {
    assert.ok(Math.abs(wall.length - Math.hypot(wall.to.x - wall.from.x, wall.to.z - wall.from.z)) < 1e-9);
    assert.ok(isSegmentTraversable(state, wall.from, wall.to, { ignoreWalls: true, radius: .8 }), 'a full footprint crossed impassable terrain');
    for (const end of ['from', 'to']) {
      if (nodes.has(wall.joins[end])) assert.deepEqual(wall[end], nodes.get(wall.joins[end]), 'joined endpoints drifted apart');
      else nodes.set(wall.joins[end], wall[end]);
    }
  }
  assert.equal(nodes.size, screen.length, 'perimeter must form a closed loop');
  for (const id of nodes.keys()) assert.equal(screen.flatMap(p => Object.values(p.joins)).filter(v => v === id).length, 2);
  assert.equal(findPath(state, home, goal, { factionId: owner.id }).reason, 'direct');
  assert.equal(findPath(state, home, goal, { factionId: 'ally' }).reason, 'direct');
  const hostile = findPath(state, home, goal, { factionId: 'enemy' });
  assert.equal(hostile.reachable, false, 'a hostile party escaped through the closed perimeter');
  let previous = home;
  for (const point of hostile.waypoints) {
    assert.ok(isSegmentTraversable(state, previous, point, { factionId: 'enemy', radius: .16 })); previous = point;
  }
  const worker = { id: 'crew', kind: 'worker', factionId: owner.id, originId: home.id, size: 8, x: home.x, z: home.z, speed: 4 };
  state.groups.push(worker);
  for (const destination of [goal, home]) {
    let arrived = false;
    for (let i = 0; i < 250 && !arrived; i++) {
      const from = { x: worker.x, z: worker.z }; state.step++; state.time += .1;
      arrived = moveAlongRoute(state, worker, destination, { dt: .1, arrival: .3 });
      assert.ok(isSegmentTraversable(state, from, worker, { factionId: owner.id, radius: .12 }));
      assert.ok(Math.hypot(worker.x - from.x, worker.z - from.z) <= .5, 'crew jumped across the gate');
    }
    assert.ok(arrived, 'crew could not complete a physical outward/return trip');
  }
  assert.equal(worker.size, 8); assert.equal(home.population, 400);
});

test('small towns finish a stable enclosing plan despite later intel changes, then expand around new buildings', () => {
  const { state, home, owner } = fixture(); home.population = 100;
  const gate = build(state, home, owner, 1)[0], blueprint = home.perimeterPlan;
  owner.knowledge = {};
  for (let i = 1; i < blueprint.plans.length; i++) {
    const plan = defenseBuildingPlan(state, home, owner); assert.ok(plan);
    assert.equal(plan.topologyId, gate.topologyId);
    assert.ok(home.buildings.some(b => Object.values(b.joins || {}).some(end => Object.values(plan.joins).includes(end))), 'new work detached from the funded perimeter');
    home.buildings.push({ ...plan, id: `extension-${i}`, progress: 1 }); invalidateNavigation(state);
  }
  assert.ok(blueprint.plans.length > 7, 'old screen budget prevented enclosure');
  const tower = defenseBuildingPlan(state, home, owner); assert.equal(tower.kind, 'tower');
  home.buildings.push({ ...tower, id: 'tower', progress: 1 }); invalidateNavigation(state);
  assert.equal(defenseBuildingPlan(state, home, owner), null, 'a completed perimeter started endless extra defenses');
  home.buildings.push({ id: 'new-house', kind: 'housing', x: home.x + blueprint.radius + 2, z: home.z, hp: 100, progress: 1 });
  const expansion = defenseBuildingPlan(state, home, owner);
  assert.ok(expansion, 'growth had no enclosing fallback'); assert.ok(home.perimeterPlan.radius > blueprint.radius);
  assert.notEqual(expansion.topologyId, gate.topologyId);
});

test('a destroyed gate is rebuilt on the original joined endpoints', () => {
  const { state, home, owner } = fixture(), [gate] = build(state, home, owner, 3);
  gate.destroyed = true; gate.hp = 0; invalidateNavigation(state);
  owner.knowledge.materials.z += 10;
  const replacement = defenseBuildingPlan(state, home, owner);
  assert.equal(replacement.kind, 'gate'); assert.deepEqual(replacement.from, gate.from); assert.deepEqual(replacement.to, gate.to);
  home.buildings.push({ ...replacement, id: 'replacement-gate', progress: 1 }); invalidateNavigation(state);
  assert.notEqual(defenseBuildingPlan(state, home, owner)?.kind, 'gate', 'rebuilt gate was funded twice');
});

test('defense completion respects endpoint geometry, actual soldier bodies, and controlled gate clearance', () => {
  const { state, home, owner } = fixture(), wall = standingWall('wall', home.x + 8, home.z, 9);
  wall.from = { x: home.x + 8, z: home.z - 4.5 }; wall.to = { x: home.x + 8, z: home.z + 4.5 };
  wall.x = 999; wall.z = 999; // Legacy center data must not override endpoints.
  const group = { id: 'army', originId: home.id, kind: 'army', factionId: owner.id, size: 2, units: { infantry: 2, ranged: 0 }, x: home.x + 5, z: home.z };
  bindArmy(state, home, group);
  const bodies = getSoldiers(state, group); bodies.forEach(body => Object.assign(body, { positioned: true }));
  bodies[0].x = home.x + 8; group.formationSlots = { infantry: bodies, ranged: [] };
  state.groups.push(group);
  assert.equal(canCompleteDefense(state, wall), false);
  group.formationSlots.infantry[0].x = home.x + 5;
  assert.equal(canCompleteDefense(state, wall), true);
  wall.kind = 'gate'; wall.factionId = owner.id; wall.gateWidth = 5;
  group.x = home.x + 8; group.formationSlots.infantry[0].x = group.x;
  assert.equal(canCompleteDefense(state, wall), true, 'friendly traffic in the real opening blocks completion');
  group.factionId = 'enemy';
  assert.equal(canCompleteDefense(state, wall), false, 'a hostile body would be enclosed by the controlled gate');
});

test('breach assessment prefers a reasonable detour, but selects a useful weak barrier', () => {
  const { state, home } = fixture(), center = { x: home.x + 18, z: home.z }, from = { x: center.x - 4, z: center.z }, goal = { x: center.x + 10, z: center.z };
  const wall = standingWall('barrier', center.x, center.z, 4, 1), options = { factionId: 'owner', speed: 2.8, breachDps: 100 };
  assert.equal(assessBreachRoute(state, from, goal, [wall], options).action, 'detour', 'a tiny obstruction should not trigger needless destruction');
  wall.length = 40; wall.hp = 30;
  const result = assessBreachRoute(state, from, goal, [wall], options);
  assert.equal(result.action, 'breach'); assert.equal(result.wallId, wall.id);
  assert.ok(result.savedSeconds >= 3); assert.ok(result.detourLength > result.breachLength * 1.22);
  assert.ok(result.expansions <= 512 * 4); assert.equal(result.assessedCandidates, 1);
  assert.deepEqual(assessBreachRoute(state, from, goal, [wall], options), result, 'decision is nondeterministic');
  wall.hp = 3000;
  assert.equal(assessBreachRoute(state, from, goal, [wall], options).action, 'detour', 'durability cost was ignored');
  wall.hp = 1; wall.factionId = 'owner';
  assert.equal(assessBreachRoute(state, from, goal, [wall], options).action, 'detour', 'own wall became a breach target');
});

test('unrelated and hidden walls cannot become tactical breach targets; search exhaustion is not a trapped route', () => {
  const { state, home } = fixture(), from = { x: home.x + 8, z: home.z }, goal = { x: home.x + 30, z: home.z };
  const unrelated = standingWall('off-route', home.x + 15, home.z + 10, 4, 1);
  const hidden = standingWall('unseen', home.x + 20, home.z, 40, 1), options = { factionId: 'owner', speed: 3, breachDps: 100 };
  const before = assessBreachRoute(state, from, goal, [unrelated], options);
  state.walls.push(hidden); invalidateNavigation(state);
  assert.deepEqual(assessBreachRoute(state, from, goal, [unrelated], options), before, 'hidden geometry altered a tactical decision');
  assert.equal(before.action, 'advance'); assert.equal(before.wallId, null);
  assert.equal(isSegmentTraversable(state, from, goal, { factionId: 'owner' }), false, 'physical collision must still respect the hidden wall');
  const bounded = assessBreachRoute(state, from, goal, [hidden, unrelated], { ...options, maxExpansions: 1 });
  assert.equal(bounded.action, 'unreachable'); assert.equal(bounded.route.reason, 'search-budget'); assert.equal(bounded.wallId, null);
});

test('gate width changes invalidate cached paths and wide parties cannot squeeze through a narrow aperture', () => {
  const { state, home } = fixture(), from = { x: home.x + 8, z: home.z }, goal = { x: home.x + 24, z: home.z };
  const gate = { ...standingWall('gate', home.x + 16, home.z, 20), kind: 'gate', factionId: 'owner', gateWidth: 5 };
  state.walls.push(gate); invalidateNavigation(state);
  assert.equal(findPath(state, from, goal, { factionId: 'owner', radius: .7 }).reason, 'direct');
  gate.gateWidth = 1; state.step++;
  assert.equal(isSegmentTraversable(state, from, goal, { factionId: 'owner', radius: .7 }), false);
  assert.notEqual(findPath(state, from, goal, { factionId: 'owner', radius: .7 }).reason, 'direct');
  gate.open = true; gate.gateWidth = 5; state.step++;
  assert.equal(findPath(state, from, goal, { factionId: 'enemy', radius: .7 }).reason, 'direct');
});


test('a healthy funded-size expansion can begin the same connected path-safe perimeter', () => {
  const { state, home, owner, goal } = fixture();
  home.population = 28; home.foundedTick = 80;
  const gate = defenseBuildingPlan(state, home, owner);
  assert.ok(gate); assert.equal(gate.kind, 'gate'); assert.equal(home.buildings.length, 0);
  const planned = home.perimeterPlan;
  assert.ok(planned.plans.every((p, i) => p.joins.to === planned.plans[(i + 1) % planned.plans.length].joins.from));
  home.buildings.push({ ...gate, id: 'outpost-gate', progress: 1 }); invalidateNavigation(state);
  const next = defenseBuildingPlan(state, home, owner);
  assert.ok(next); assert.equal(next.topologyId, gate.topologyId);
  assert.ok(Object.values(gate.joins).some(id => Object.values(next.joins).includes(id)));
  assert.equal(findPath(state, home, goal, { factionId: owner.id }).reachable, true);
  home.shortageDays = 1; assert.equal(defenseBuildingPlan(state, home, owner), null);
});
