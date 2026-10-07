import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { normalizeConfig, DEFAULT_CONFIG } from '../src/config.js';
import { generateWorld, heightAt, terrainAt, terrainFeatures, startingPositions, isTerrainTraversable, WORLD_RADIUS, LAND_SCALE, WORLD_RESOURCE_SITES } from '../src/world.js';
import { createSimulation } from '../src/sim/core.js';
import { createTerrain } from '../src/render/terrain.js';
import { findPath, moveAlongRoute, isPointTraversable, isSegmentTraversable, lineOfSight, invalidateNavigation, navigationDiagnostics, knownChokepoints, NAV_MAX_EXPANSIONS } from '../src/sim/navigation.js';

const empty = seed => ({ seed, step: 0, tick: 0, time: 0, settlements: [], factions: [{ id: 'owner', relations: {} }, { id: 'enemy', relations: {} }] });
const translated = (p, x, z) => ({ x: p.x + x, z: p.z + z });
function enclosed(seed = 'navigation-room') {
  const state = empty(seed), center = startingPositions(seed)[0];
  state.walls = [
    { id: 'gate', kind: 'wall', factionId: 'owner', ...translated(center, 0, 6), length: 12, width: 1, rotation: 0, isGate: true, gateWidth: 5, progress: 1, hp: 100 },
    { id: 'south', kind: 'wall', factionId: 'owner', ...translated(center, 0, -6), length: 12, width: 1, rotation: 0, progress: 1, hp: 100 },
    { id: 'east', kind: 'wall', factionId: 'owner', ...translated(center, 6, 0), length: 12, width: 1, rotation: Math.PI / 2, progress: 1, hp: 100 },
    { id: 'west', kind: 'wall', factionId: 'owner', ...translated(center, -6, 0), length: 12, width: 1, rotation: Math.PI / 2, progress: 1, hp: 100 },
  ];
  return { state, center, outside: translated(center, 0, 12) };
}

test('configuration defaults to four and supports explicit three through six plus factionCount alias', () => {
  assert.deepEqual(DEFAULT_CONFIG, { civCount: 4 });
  for (const value of [undefined, {}, null, { civCount: NaN }, { civCount: Infinity }, { civCount: 'bad' }]) assert.equal(normalizeConfig(value).civCount, 4);
  assert.equal(normalizeConfig({ civCount: 2 }).civCount, 3);
  assert.equal(normalizeConfig({ civCount: 99 }).civCount, 6);
  assert.equal(normalizeConfig({ factionCount: 5 }).civCount, 5);
  assert.equal(normalizeConfig({ civCount: 3, factionCount: 6 }).civCount, 3);
  for (const civCount of [3, 4, 5, 6]) {
    const state = createSimulation('configuration-starts', { factionCount: civCount });
    assert.equal(state.factions.length, civCount); assert.equal(state.settlements.length, civCount);
    assert.equal(state.config.civCount, civCount);
  }
  assert.equal(createSimulation('configuration-default').factions.length, 4);
});

test('fast physical ground checks exactly match full terrain classification', () => {
  for (const seed of ['first-light', 'navigation-river', 'collision-cache']) {
    for (let x = -WORLD_RADIUS + .3; x < WORLD_RADIUS; x += 5.7) for (let z = -WORLD_RADIUS + .7; z < WORLD_RADIUS; z += 6.1) {
      assert.equal(isTerrainTraversable(x, z, seed), terrainAt(x, z, seed).traversable, `${seed}:${x},${z}`);
    }
  }
});

test('the larger island adds usable, supplied frontier rather than empty sea', () => {
  assert.equal(WORLD_RADIUS, 180); assert.equal(LAND_SCALE, 4);
  const world = generateWorld('expanded-frontier');
  assert.equal(world.nodes.length, WORLD_RESOURCE_SITES);
  const frontier = world.nodes.filter(node => Math.hypot(node.x, node.z) > 132);
  assert.ok(frontier.length > WORLD_RESOURCE_SITES * .12, 'scarce frontier still needs a distributed share of resource destinations');
  assert.ok(frontier.every(node => terrainAt(node.x, node.z, 'expanded-frontier').traversable));
  assert.ok(Math.max(...frontier.map(node => Math.hypot(node.x, node.z))) > 154);
  // The simulation boundary lies in visible deep water, never through dry land.
  for (let edge = -WORLD_RADIUS; edge <= WORLD_RADIUS; edge += 4) for (const side of [-WORLD_RADIUS, WORLD_RADIUS]) {
    assert.ok(heightAt(side, edge, 'expanded-frontier') < -.3);
    assert.ok(heightAt(edge, side, 'expanded-frontier') < -.3);
  }
});

test('count-specific starts are deterministic, separated and evenly spread on count-independent terrain', () => {
  for (const seed of ['first-light', 'qa-world', 'river-ring', 'cliff-starts']) {
    const heights = Array.from({ length: 24 }, (_, i) => heightAt(Math.cos(i) * 90, Math.sin(i) * 90, seed));
    for (const civCount of [3, 4, 5, 6]) {
      const a = startingPositions(seed, { civCount }), b = startingPositions(seed, { civCount });
      assert.deepEqual(a, b); assert.equal(a.length, civCount);
      const angles = a.map(p => (Math.atan2(p.z, p.x) + Math.PI * 2) % (Math.PI * 2)).sort((x, y) => x - y);
      for (let i = 0; i < civCount; i++) {
        const gap = (angles[(i + 1) % civCount] - angles[i] + Math.PI * 2) % (Math.PI * 2);
        assert.ok(gap > Math.PI * 2 / civCount - .65 && gap < Math.PI * 2 / civCount + .65, `${seed}/${civCount}: unbalanced angular gap ${gap}`);
      }
      for (let i = 0; i < a.length; i++) {
        assert.ok(terrainAt(a[i].x, a[i].z, seed).traversable);
        for (let j = i + 1; j < a.length; j++) assert.ok(Math.hypot(a[i].x - a[j].x, a[i].z - a[j].z) > 45);
      }
      assert.deepEqual(heights, Array.from({ length: 24 }, (_, i) => heightAt(Math.cos(i) * 90, Math.sin(i) * 90, seed)));
    }
  }
});

test('every start has reachable survival supplies and every generated worksite is reachable', () => {
  const seed = 'navigation-supplies', state = empty(seed);
  for (const civCount of [3, 4, 5, 6]) {
    const world = generateWorld(seed, { civCount });
    for (const start of world.starts) for (const kind of ['food', 'water', 'energy', 'materials']) {
      const nearby = world.nodes.filter(n => n.kind === kind && Math.hypot(n.x - start.x, n.z - start.z) < 30);
      assert.ok(nearby.some(node => findPath(state, start, node).reachable), `count ${civCount} lacks reachable ${kind}`);
    }
    // The frontier uses the same connected island for all four count settings.
    for (const node of world.nodes) assert.ok(findPath(state, world.starts[0], node).reachable, `count ${civCount}: ${node.id} unreachable`);
  }
});

test('deep river forces routes through real fords and cliff passes remain open', () => {
  const state = empty('navigation-river'), features = terrainFeatures(state.seed);
  for (const pass of features.passes) {
    assert.ok(terrainAt(pass.x, pass.z, state.seed).traversable, `${pass.id} obstructed`);
    const axis = typeof pass.axis === 'number' ? pass.axis : 0;
    const a = { x: pass.x - Math.cos(axis) * 13, z: pass.z - Math.sin(axis) * 13 }, b = { x: pass.x + Math.cos(axis) * 13, z: pass.z + Math.sin(axis) * 13 };
    assert.ok(isSegmentTraversable(state, a, b), `${pass.id} does not connect its banks`);
  }
  const z = 33;
  let riverX = 0, low = Infinity;
  for (let x = -30; x <= 20; x += .5) { const h = heightAt(x, z, state.seed); if (h < low) { low = h; riverX = x; } }
  const a = { x: riverX - 15, z }, b = { x: riverX + 15, z };
  assert.equal(terrainAt(riverX, z, state.seed).blockedBy, 'deep-water');
  assert.equal(isSegmentTraversable(state, a, b), false);
  const path = findPath(state, a, b);
  assert.ok(path.reachable); assert.ok(path.length > 45, 'river route ignored the detour');
  assert.ok(path.expansions <= NAV_MAX_EXPANSIONS);
  let prior = a;
  for (const point of path.waypoints) { assert.ok(isSegmentTraversable(state, prior, point)); prior = point; }
  for (const ridge of features.obstacles) assert.equal(terrainAt(ridge.x, ridge.z, state.seed).blockedBy, 'cliff');
});

test('completed walls close hostile routes while gates let owners and allies escape', () => {
  const { state, center, outside } = enclosed();
  assert.equal(isSegmentTraversable(state, center, outside, { factionId: 'owner' }), true);
  assert.equal(isSegmentTraversable(state, center, outside, { factionId: 'enemy' }), false);
  assert.equal(findPath(state, center, outside, { factionId: 'owner' }).reachable, true);
  const trapped = findPath(state, center, outside, { factionId: 'enemy' });
  assert.equal(trapped.reachable, false); assert.equal(trapped.reason, 'unreachable');
  state.factions[1].relations.owner = { status: 'allied' }; invalidateNavigation(state);
  assert.equal(findPath(state, center, outside, { factionId: 'enemy' }).reachable, true);
  state.factions[1].relations.owner.status = 'hostile'; state.walls[0].gateOpen = true; invalidateNavigation(state);
  assert.equal(findPath(state, center, outside, { factionId: 'enemy' }).reachable, true);
  state.walls[0].gateOpen = false; state.walls[0].hp = 0; invalidateNavigation(state);
  assert.equal(findPath(state, center, outside, { factionId: 'enemy' }).reachable, true);
  state.walls[0].hp = 100; state.walls[0].progress = .99; invalidateNavigation(state);
  assert.equal(findPath(state, center, outside, { factionId: 'enemy' }).reachable, true);
});

test('occupied gates follow effective control without changing native faction identity', () => {
  const { state, center, outside } = enclosed('navigation-occupation');
  const home = { id: 'held-home', ...center, factionId: 'owner', occupiedBy: 'enemy', buildings: state.walls };
  state.settlements = [home]; state.walls = [];
  assert.equal(findPath(state, center, outside, { factionId: 'enemy' }).reachable, true);
  assert.equal(findPath(state, center, outside, { factionId: 'owner' }).reachable, false);
  state.factions[0].defeatedBy = 'enemy'; invalidateNavigation(state);
  assert.equal(findPath(state, center, outside, { factionId: 'owner' }).reachable, true);
  state.factions.push({ id: 'overlord', relations: {} }); state.factions[1].defeatedBy = 'overlord'; invalidateNavigation(state);
  assert.equal(findPath(state, center, outside, { factionId: 'overlord' }).reachable, true);
  assert.equal(home.factionId, 'owner'); assert.equal(home.occupiedBy, 'enemy');
});

test('blocked endpoints and coast failures never teleport, falsely arrive or re-search per pulse', () => {
  const { state, center, outside } = enclosed('navigation-failure');
  const group = { id: 'trapped', factionId: 'enemy', ...center, speed: 4 };
  const initial = { x: group.x, z: group.z };
  for (let pulse = 0; pulse < 40; pulse++) { state.step++; state.time += .1; assert.equal(moveAlongRoute(state, group, outside, { dt: .1, arrival: .5 }), false); }
  assert.deepEqual({ x: group.x, z: group.z }, initial);
  assert.equal(navigationDiagnostics(state).searches, 1, 'blocked route re-searched every pulse');
  assert.equal(group.navigation.length, null); assert.ok(group.stuckTime > 3.9);
  const blocked = { x: state.walls[1].x, z: state.walls[1].z };
  assert.equal(findPath(state, blocked, center, { factionId: 'enemy' }).reason, 'blocked-start');
  assert.equal(findPath(state, center, blocked, { factionId: 'enemy' }).reason, 'blocked-target');
  const coast = { x: 149, z: 149 };
  assert.equal(findPath(state, center, coast).reachable, false);
  for (let pulse = 0; pulse < 20; pulse++) { state.step++; state.time += .1; assert.equal(moveAlongRoute(state, group, coast), false); }
  assert.deepEqual({ x: group.x, z: group.z }, initial);
});

test('moving groups share bounded waypoints and cannot clip closed walls at arrival distance', () => {
  const { state, center, outside } = enclosed('navigation-movement');
  const group = { id: 'owner-party', factionId: 'owner', ...center, speed: 3 };
  let arrived = false;
  for (let pulse = 0; pulse < 150; pulse++) {
    const previous = { x: group.x, z: group.z }; state.step++; state.time += .1;
    arrived = moveAlongRoute(state, group, outside, { dt: .1, arrival: .35 });
    assert.ok(isSegmentTraversable(state, previous, group, { factionId: 'owner' }));
    assert.ok(Math.hypot(group.x - previous.x, group.z - previous.z) <= .3 + 1e-8);
    if (arrived) break;
  }
  assert.ok(arrived);
  const hostile = { id: 'near-wall', factionId: 'enemy', ...translated(center, 0, 5), speed: 3 };
  const through = translated(center, 0, 7);
  assert.equal(moveAlongRoute(state, hostile, through, { arrival: 3 }), false, 'arrival radius credited through closed gate');
});

test('multiple harvesting parties reserve distinct reachable arrival lanes inside gathering range', () => {
  const state = empty('navigation-lanes'), world = generateWorld(state.seed), home = world.starts[0], node = world.nodes[0];
  const arrival = Math.max(1, node.radius * .55);
  state.groups = Array.from({ length: 3 }, (_, i) => ({ id: `lane-${i}`, factionId: 'owner', kind: 'worker', phase: 'outbound', ...home, speed: 2.65 }));
  const arrived = new Set();
  for (let pulse = 0; pulse < 350; pulse++) {
    state.step++; state.time += .1;
    for (const group of state.groups) {
      if (arrived.has(group.id)) continue;
      const before = { x: group.x, z: group.z };
      if (moveAlongRoute(state, group, node, { dt: .1, arrival, spreadArrival: true })) arrived.add(group.id);
      assert.ok(isSegmentTraversable(state, before, group, { factionId: group.factionId, radius: .12 }));
    }
    if (arrived.size === state.groups.length) break;
  }
  assert.equal(arrived.size, 3);
  for (let i = 0; i < state.groups.length; i++) {
    const group = state.groups[i];
    assert.ok(Math.hypot(group.x - node.x, group.z - node.z) < arrival);
    for (let j = i + 1; j < state.groups.length; j++) assert.ok(Math.hypot(group.x - state.groups[j].x, group.z - state.groups[j].z) > .7, 'crews stacked at the same endpoint');
  }
});

test('nearby corner waypoints are reached before turning and routes store coordinates only', () => {
  const state = empty('navigation-corner'), start = startingPositions(state.seed)[0];
  const corner = { x: Math.round(start.x / 3) * 3, z: Math.round(start.z / 3) * 3 };
  const home = { id: 'corner-home', ...translated(corner, 1.70852093133335, -13.20501506827865), privateStock: { materials: 1000 }, buildings: [] };
  state.walls = [{ id: 'corner-wall', kind: 'wall', factionId: 'owner', ...translated(corner, -3.43401461056123, -2.18551742998538), rotation: -.4366348584509465, length: 7, width: 1, progress: 1, hp: 300 }];
  const group = { id: 'corner-party', factionId: 'owner', ...translated(corner, -.20825645823722, .04083280502074), speed: 2.65 };
  const path = findPath(state, group, home, { factionId: group.factionId, arrival: 3 });
  assert.ok(path.reachable);
  for (const point of path.waypoints) assert.deepEqual(Object.keys(point).sort(), ['x', 'z'], 'route retained a live object or private state');
  let arrived = false;
  for (let i = 0; i < 200; i++) {
    state.step++; state.time += .1;
    const previous = { x: group.x, z: group.z };
    arrived = moveAlongRoute(state, group, home, { dt: .1, arrival: 3 });
    assert.ok(isSegmentTraversable(state, previous, group, { factionId: group.factionId, radius: .12 }));
    if (arrived) break;
  }
  assert.ok(arrived, 'party repeated the same skipped corner forever');
  for (const point of group.navigation.waypoints) assert.deepEqual(Object.keys(point).sort(), ['x', 'z']);
});

test('LOS respects raised cliffs and walls while towers can see over low cover', () => {
  const { state, center, outside } = enclosed('navigation-sight');
  assert.equal(lineOfSight(state, center, outside, { factionId: 'enemy' }), false);
  assert.equal(lineOfSight(state, center, outside, { factionId: 'owner' }), true);
  assert.equal(lineOfSight(state, center, outside, { factionId: 'enemy', fromHeight: 8 }), true);
  assert.equal(lineOfSight(state, center, outside, { maxRange: 4 }), false);
  const ridge = terrainFeatures(state.seed).obstacles[0];
  const a = { x: ridge.x + Math.sin(ridge.angle) * 10, z: ridge.z - Math.cos(ridge.angle) * 10 }, b = { x: ridge.x - Math.sin(ridge.angle) * 10, z: ridge.z + Math.cos(ridge.angle) * 10 };
  assert.equal(lineOfSight(state, a, b), false);
  assert.equal(lineOfSight(state, a, b, { fromHeight: 12, toHeight: 12 }), true);
  assert.deepEqual(knownChokepoints(state, 'owner'), []);
  const known = knownChokepoints(state, 'owner', (_s, _f, pass) => pass.id === 'ford-1');
  assert.equal(known.length, 1); assert.equal(known[0].id, 'ford-1');
});

test('faction terrain view hides resource sites, detail and picking and restores at a paused step', () => {
  const seed = 'navigation-render', world = generateWorld(seed, { civCount: 5 }), scene = new THREE.Scene(), terrain = createTerrain(THREE, scene, seed, { civCount: 5 });
  const state = { ...world, step: 0, tick: 0, settlements: [], groups: [] }, visible = world.nodes[0], hidden = world.nodes.at(-1);
  terrain.update(0, state);
  const full = { ...terrain.diagnostics };
  terrain.update(0, { ...state, viewer: { mode: 'faction', factionId: 'owner', version: 1 }, visibleNodeIds: [visible.id], nodes: [visible] });
  assert.equal(terrain.diagnostics.visibleResourceSites, 1);
  assert.ok(terrain.diagnostics.visibleResourcePieces < full.visibleResourcePieces);
  assert.ok(terrain.diagnostics.visibleResourceSiteDetails < full.visibleResourceSiteDetails);
  for (const mesh of terrain.getPickables()) assert.ok(mesh.userData.resourceNodeIds.every(id => id === visible.id));
  const raycaster = new THREE.Raycaster(new THREE.Vector3(hidden.x, 100, hidden.z), new THREE.Vector3(0, -1, 0));
  assert.notEqual(terrain.pickResource(raycaster), hidden.id);
  terrain.update(0, { ...state, viewer: { mode: 'faction', factionId: 'enemy', version: 1 }, visibleNodeIds: [], nodes: [] });
  assert.equal(terrain.diagnostics.visibleResourcePieces, 0); assert.equal(terrain.diagnostics.visibleResourceSiteDetails, 0); assert.equal(terrain.pickResource(raycaster), null);
  terrain.update(0, state);
  assert.equal(terrain.diagnostics.visibleResourcePieces, full.visibleResourcePieces);
  assert.equal(terrain.diagnostics.visibleResourceSiteDetails, full.visibleResourceSiteDetails);
  assert.equal(terrain.pickResource(raycaster), hidden.id);
  terrain.dispose(); assert.equal(scene.children.length, 0);
});
