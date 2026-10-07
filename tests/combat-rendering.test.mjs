import { getSoldier, getSoldiers } from '../src/sim/soldiers.js';
import { setMilitary, recruitMilitary, bindArmy, positionMilitary } from './roster-fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createSimulation } from '../src/sim/core.js';
import { terrainAt } from '../src/world.js';
import { combatFormationSlot, updateCombatFormation, formationSize, stepCombat } from '../src/sim/combat.js';
import { countMilitary } from '../src/sim/military.js';
import { isSegmentTraversable, lineOfSight, invalidateNavigation } from '../src/sim/navigation.js';
import { createCombatEffects } from '../src/render/combat.js';
import { createCrowds } from '../src/render/crowds.js';
import { emptyResources, initializeLedger, ledgerResidual } from '../src/sim/economy.js';

function fixture() {
  const s = createSimulation('combat-physical-contract', { civCount: 3 });
  s.groups = []; s.nodes = []; s.events = [];
  for (const p of s.settlements) { p.buildings = []; p.assigned = {}; p.population = 200; p.homePresent = 200; setMilitary(s, p); }
  const [a, b] = s.factions;
  a.relations[b.id] = { status: 'hostile', trust: 0 }; b.relations[a.id] = { status: 'hostile', trust: 0 };
  let center;
  outer: for (let z = -72; z < 72; z += 6) for (let x = -72; x < 72; x += 6) {
    const points = [];
    for (let dz = -10; dz <= 10; dz += 2) for (let dx = -10; dx <= 10; dx += 2) points.push({ x: x + dx, z: z + dz });
    if (points.every(p => terrainAt(p.x, p.z, s.seed).traversable) && lineOfSight(s, { x: x - 7, z }, { x: x + 7, z }, { fromHeight: .6, toHeight: .6 })) { center = { x, z }; break outer; }
  }
  assert.ok(center);
  initializeLedger(s); return { s, center, a, b, ha: s.settlements[0], hb: s.settlements[1] };
}
function army(s, p, id, units, point) {
  recruitMilitary(s, p, units);
  const g = { id, kind: 'army', factionId: p.factionId, originId: p.id, units: { ...units }, size: countMilitary(units), initialSize: countMilitary(units),
    x: point.x, z: point.z, prevX: point.x, prevZ: point.z, targetX: point.x, targetZ: point.z, targetId: null, phase: 'outbound', speed: 0, morale: 100, supply: 100, carrying: emptyResources() };
  bindArmy(s, p, g); s.groups.push(g); return g;
}
function pulse(s) { s.step++; s.time = s.step / 10; s.tick = Math.floor(s.time); stepCombat(s, .1); }
function matrices(scene) {
  const result = [];
  scene.traverse(mesh => { if (mesh.isInstancedMesh && mesh.count) result.push({ name: mesh.name, count: mesh.count, values: Array.from(mesh.instanceMatrix.array.slice(0, mesh.count * 16)) }); });
  return result;
}

test('formation roles, firing origins and rendered bodies share deterministic positions', () => {
  const { s, ha, hb, center } = fixture();
  const a = army(s, ha, 'mixed-a', { infantry: 9, ranged: 6 }, { x: center.x - 3, z: center.z });
  army(s, hb, 'mixed-b', { infantry: 9, ranged: 6 }, { x: center.x + 3, z: center.z });
  for (let i = 0; i < 15; i++) pulse(s);
  const scene = new THREE.Scene(), crowds = createCrowds(THREE, scene);
  const before = structuredClone(s); crowds.update(s, s.time, a.id, 1);
  assert.deepEqual(s, before, 'render must remain read-only');
  const samples = crowds.getMotionSamples().filter(p => p.groupId === a.id);
  assert.ok(samples.some(p => p.militaryRole === 'infantry')); assert.ok(samples.some(p => p.militaryRole === 'ranged'));
  for (const p of samples) {
    const slot = getSoldier(s, p.soldierId);
    assert.ok(a.soldierIds.includes(slot.id));
    assert.equal(p.x, slot.x); assert.equal(p.z, slot.z); assert.equal(p.militaryRole, slot.role);
  }
  assert.equal(crowds.diagnostics.representedIndividuals, s.settlements.reduce((n, p) => n + p.population, 0));
  assert.equal(crowds.diagnostics.populationAccountingDelta, 0);
  const shot = s.combatEvents.find(e => e.sourceId === a.id && e.type === 'projectile');
  assert.ok(shot && shot.shots.every(p => getSoldier(s, p.sourceSoldierId)?.role === 'ranged'), 'ranged fire was attributed to infantry');
  crowds.dispose();
});

test('physical formation slots cannot walk through a standing wall during a turn', () => {
  const { s, center, ha, hb } = fixture();
  const g = army(s, ha, 'wall-turn', { infantry: 30, ranged: 12 }, { x: center.x - 3, z: center.z });
  g.speed = 3;
  hb.buildings = [{ id: 'test-wall', kind: 'wall', x: center.x, z: center.z, rotation: Math.PI / 2, length: 16, width: 1, progress: 1, hp: 300 }];
  invalidateNavigation(s);
  updateCombatFormation(s, g, g.units, 0, { yaw: Math.PI / 2 });
  for (let frame = 0; frame < 50; frame++) {
    updateCombatFormation(s, g, g.units, .1, { yaw: Math.PI / 2 + frame * .012 });
    for (const role of ['infantry', 'ranged']) for (const p of g.formationSlots[role]) {
      assert.ok(isSegmentTraversable(s, { x: p.prevX, z: p.prevZ }, p, { factionId: g.factionId, radius: .01 }), 'a real body crossed an impassable segment');
      assert.ok(terrainAt(p.x, p.z, s.seed).traversable);
      assert.ok(p.x < center.x - .49, 'a flank appeared through the wall');
    }
  }
  assert.equal(g.formationSlots.infantry.length + g.formationSlots.ranged.length, g.size);
});

test('visible wall obstruction receives real delayed melee damage and destruction opens collision', () => {
  const { s, center, ha, hb } = fixture();
  Object.assign(hb, { x: center.x + 4, z: center.z, radius: 8 });
  const wall = { id: 'breachable-wall', kind: 'wall', x: center.x, z: center.z, rotation: Math.PI / 2, length: 14, width: 1, wallHeight: 4, progress: 1, hp: 24, maxHp: 24 };
  hb.buildings = [wall]; invalidateNavigation(s);
  const g = army(s, ha, 'wall-attack', { infantry: 12, ranged: 0 }, { x: center.x - 1.8, z: center.z });
  g.targetId = hb.id; g.targetX = hb.x; g.targetZ = hb.z;
  const before = s.stats.deaths;
  for (let i = 0; i < 180 && !wall.destroyed; i++) pulse(s);
  assert.equal(wall.hp, 0); assert.equal(wall.destroyed, true); assert.equal(s.stats.structuresDestroyed, 1);
  assert.ok(s.combatEvents.some(e => e.type === 'collapse' && e.targetId === wall.id));
  assert.ok(isSegmentTraversable(s, { x: center.x - 2, z: center.z }, { x: center.x + 2, z: center.z }, { factionId: g.factionId }));
  assert.equal(s.stats.deaths, before, 'wall damage killed nonexistent soldiers');
});

test('combat effects are bounded, pause-frozen, read-only and expire on simulation time', () => {
  const { s, center, ha, hb } = fixture();
  army(s, ha, 'archers', { infantry: 0, ranged: 24 }, { x: center.x - 3, z: center.z });
  army(s, hb, 'guards', { infantry: 24, ranged: 0 }, { x: center.x + 3, z: center.z });
  for (let i = 0; i < 500 && !s.combatEvents?.some(event => event.type === 'casualty'); i++) pulse(s);
  const scene = new THREE.Scene(), effects = createCombatEffects(THREE, scene), copy = structuredClone(s);
  effects.update(s, s.time); const first = matrices(scene), samples = effects.getMotionSamples();
  effects.update(s, s.time);
  assert.equal(effects.diagnostics.reusedFrame, true); assert.deepEqual(matrices(scene), first); assert.deepEqual(effects.getMotionSamples(), samples); assert.deepEqual(s, copy);
  assert.ok(effects.diagnostics.drawCallsEstimate <= 5);
  assert.ok(effects.diagnostics.casualties > 0, 'actual deaths lack visible falling markers');
  assert.equal(effects.diagnostics.casualties, s.combatEvents.filter(e => e.type === 'casualty' && s.time - e.time <= 2.2).reduce((n, e) => n + e.positions.length, 0));
  effects.update(s, s.time + 10); assert.equal(effects.diagnostics.visibleEffects, 0); effects.dispose(); assert.equal(scene.children.length, 0);
  for (const residual of Object.values(ledgerResidual(s))) assert.ok(Math.abs(residual) < 1e-6);
});

test('scoped faction census includes visible foreign groups without inventing hidden home population', () => {
  const { s, center, ha, hb } = fixture();
  const g = army(s, hb, 'visible-foreign', { infantry: 6, ranged: 3 }, center);
  positionMilitary(s);
  const observedSoldiers = getSoldiers(s, g).map(body => ({ ...body, originId: null }));
  g.originId = null;
  const view = { ...s, settlements: [ha], groups: [g], soldiers: [...getSoldiers(s, ha), ...observedSoldiers], viewer: { mode: 'faction', factionId: ha.factionId } };
  const scene = new THREE.Scene(), crowds = createCrowds(THREE, scene); crowds.update(view, 0, g.id, 1);
  assert.equal(crowds.diagnostics.totalPopulation, ha.population + g.size);
  assert.equal(crowds.diagnostics.representedIndividuals, ha.population + g.size);
  assert.equal(crowds.diagnostics.populationAccountingDelta, 0);
  assert.equal(crowds.diagnostics.censusScope, 'friendly-and-currently-visible'); crowds.dispose();
});

test('a native auxiliary army delays its actual commander’s capitulation and surrenders without changing demographic ownership', async () => {
  const { updateConquest } = await import('../src/sim/conquest.js');
  const { groupController } = await import('../src/sim/control.js');
  const { s, center, a, b, ha, hb } = fixture(), winner = s.factions[2];
  ha.occupiedBy = winner.id; hb.occupiedBy = winner.id; b.defeatedBy = winner.id;
  const g = army(s, hb, 'auxiliary-last-force', { infantry: 12, ranged: 8 }, center);
  g.commandFactionId = a.id;
  const population = s.settlements.reduce((n, p) => n + p.population, 0), native = g.factionId;
  updateConquest(s);
  assert.equal(a.defeatedBy, undefined, 'a viable politically commanded auxiliary force was ignored');
  assert.equal(s.outcome.status, 'ongoing'); assert.equal(groupController(s, g), a.id);
  g.phase = 'retreating'; g.morale = 20;
  updateConquest(s);
  assert.equal(a.defeatedBy, winner.id); assert.equal(g.surrendered, true); assert.equal(g.phase, 'returning');
  assert.equal(g.factionId, native); assert.equal(g.originId, hb.id); assert.equal(g.size, 20);
  assert.equal(hb.military.infantry + hb.military.ranged, 20, 'remote surrender teleported or demobilized people');
  assert.equal(s.settlements.reduce((n, p) => n + p.population, 0), population);
  assert.equal(s.outcome.winnerId, winner.id);
});
