import { setMilitary, recruitMilitary, bindArmy } from './roster-fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { createSimulation, stepSimulation } from '../src/sim/core.js';
import { stepCombat } from '../src/sim/combat.js';
import { stepStrategy } from '../src/sim/strategy.js';
import { visibleToGroup } from '../src/sim/knowledge.js';
import { assessBreachRoute, invalidateNavigation } from '../src/sim/navigation.js';
import { createCrowds } from '../src/render/crowds.js';
import { createEntities } from '../src/render/entities.js';
import { createCombatEffects } from '../src/render/combat.js';
import { createTerrain } from '../src/render/terrain.js';
import { overviewFrame } from '../src/render/overview.js';
import { auditState } from './balance.mjs';

function finiteState(value, path = 'state') {
  if (typeof value === 'number') assert.ok(Number.isFinite(value), `nonfinite ${path}: ${value}`);
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) finiteState(child, `${path}.${key}`);
}

// Deliberately controlled local fixtures, separate from natural balance evidence.
function localFixture() {
  const s = createSimulation('joined-screen', { civCount: 3 });
  s.groups = []; s.nodes = []; s.events = [];
  for (const [i, home] of s.settlements.entries()) {
    home.buildings = []; home.assigned = {}; home.population = 300; home.homePresent = 300;
    home.x = 80 + i * 25; home.z = 80; setMilitary(s, home);
  }
  const [a, b] = s.factions, [ha, hb] = s.settlements;
  a.relations[b.id] = { status: 'hostile', trust: 0 }; b.relations[a.id] = { status: 'hostile', trust: 0 };
  return { s, a, b, ha, hb, center: { x: -60, z: -120 } };
}
function army(s, home, id, x, z, size = 12) {
  recruitMilitary(s, home, { infantry: size, ranged: 0 });
  const group = { id, kind: 'army', factionId: home.factionId, originId: home.id, units: { infantry: size, ranged: 0 },
    size, initialSize: size, x, z, prevX: x, prevZ: z, targetX: x + 14, targetZ: z, targetId: null,
    phase: 'outbound', speed: 0, morale: 100, supply: 100, carrying: { food: 0, water: 0, energy: 0, materials: 0 } };
  bindArmy(s, home, group); s.groups.push(group); return group;
}
function pulse(s) { s.step++; s.time = s.step / 10; s.tick = Math.floor(s.time); stepCombat(s, .1); }

test('audit: a sealed visible route may select breach without storing nonfinite authoritative data', () => {
  const { s, a, ha, hb, center } = localFixture();
  const corners = [[-4, -4], [4, -4], [4, 4], [-4, 4]].map(([x, z]) => ({ x: center.x + x, z: center.z + z }));
  const walls = corners.map((from, i) => {
    const to = corners[(i + 1) % 4];
    return { id: `sealed-${i}`, kind: 'wall', from, to, x: (from.x + to.x) / 2, z: (from.z + to.z) / 2, width: 1, hp: 20, maxHp: 20, progress: 1 };
  });
  hb.buildings.push(...walls); invalidateNavigation(s);
  const g = army(s, ha, 'a-sealed', center.x, center.z, 4);
  const assessment = assessBreachRoute(s, g, { x: g.targetX, z: g.targetZ }, walls.map(building => ({ building, home: hb })), { factionId: a.id, speed: 2.8, breachDps: 100, maxExpansions: 500 });
  assert.equal(assessment.action, 'breach'); assert.equal(assessment.route.reachable, false);
  assert.ok(assessment.expansions <= 500 * 4, 'candidate searches exceeded their explicit budget');
  pulse(s);
  assert.equal(g.combat.routeDecision.action, 'breach'); assert.equal(g.combat.intent, 'breach');
  finiteState(s);
});

test('audit: visible enemy private reserves, morale and upgrades do not change the observer strength estimate', () => {
  for (const kind of ['army', 'garrison']) {
    const { s, ha, hb, center } = localFixture();
    army(s, ha, 'a-observer', center.x - 3, center.z, 20);
    if (kind === 'army') army(s, hb, 'b-contact', center.x + 3, center.z, 30);
    else { Object.assign(hb, { x: center.x + 3, z: center.z }); setMilitary(s, hb, { infantry: 30, ranged: 0 }); }
    const alternate = structuredClone(s), enemyHome = alternate.settlements.find(h => h.id === hb.id);
    const enemyFaction = alternate.factions.find(f => f.id === hb.factionId);
    enemyFaction.tech.level = 4;
    enemyFaction.advantages = { ...enemyFaction.advantages, infantryDamage: 9, rangedDamage: 8, rangedRange: 3 };
    enemyHome.defenseMorale = 0;
    for (const key of Object.keys(enemyHome.stock)) enemyHome.stock[key] = 0;
    if (kind === 'army') { const secret = alternate.groups.find(g => g.id === 'b-contact'); secret.supply = 20; secret.morale = 40; }
    pulse(s); pulse(alternate);
    const pick = state => {
      const g = state.groups[0], c = g.combat;
      return { phase: g.phase, targetId: c.targetId, intent: c.intent, enemyStrength: c.enemyStrength, strengthRatio: c.strengthRatio, reason: c.reason };
    };
    assert.ok(s.groups[0].combat.enemyStrength > 0, `${kind}: fixture had no visible enemy contact`);
    assert.deepEqual(pick(alternate), pick(s), `${kind}: private enemy supply/morale/upgrades changed local judgment`);
  }
});

test('audit: an unseen enemy wall cannot cancel a reported expedition before any local contact', () => {
  for (const scoutAware of [false, true]) {
  const { s, a, b, ha, hb } = localFixture();
  s.tick = 400; s.step = 4000; s.time = 400;
  for (const f of s.factions) { f.lastScout = 400; f.lastArmy = 400; }
  a.lastArmy = 0; a.traits.aggression = .9; a.traits.cooperation = .1;
  Object.assign(ha, { x: -78, z: -120, population: 400, availableWorkers: 200 }); setMilitary(s, ha, { infantry: 120, ranged: 0 });
  Object.assign(hb, { x: -30, z: -120 });
  for (const key of Object.keys(ha.stock)) ha.stock[key] = 500;
  a.knowledge = { [hb.id]: { id: hb.id, kind: 'settlement', ownerId: b.id, x: hb.x, z: hb.z, observedTick: 390, reportedTick: 395,
    confidence: .9, status: 'active', populationEstimate: 100, soldiersEstimate: 20, healthEstimate: 100 } };
  const alternate = structuredClone(s), enemyHome = alternate.settlements.find(h => h.id === hb.id);
  const corners = [[-4, -4], [4, -4], [4, 4], [-4, 4]].map(([x, z]) => ({ x: hb.x + x, z: hb.z + z }));
  enemyHome.buildings = corners.map((from, i) => {
    const to = corners[(i + 1) % 4];
    return { id: `unseen-${i}`, kind: 'wall', from, to, x: (from.x + to.x) / 2, z: (from.z + to.z) / 2, width: 1, hp: 200, maxHp: 200, progress: 1 };
  });
  assert.ok(enemyHome.buildings.every(wall => !visibleToGroup(alternate, ha, wall)), 'wall fixture was visible to the command');
  if (scoutAware) {
    const scout = { id: 'unreturned-scout', kind: 'scout', factionId: a.id, originId: ha.id, size: 4, initialSize: 4,
      x: hb.x - 5, z: hb.z, targetX: hb.x - 5, targetZ: hb.z, phase: 'outbound', speed: 0, supply: 100, morale: 100,
      carrying: { food: 0, water: 0, energy: 0, materials: 0 }, observations: [], createdTick: 390 };
    s.groups.push(scout); alternate.groups.push(structuredClone(scout));
    assert.ok(enemyHome.buildings.some(wall => visibleToGroup(alternate, scout, wall)), 'scout fixture did not see a wall');
  }
  stepStrategy(s, 0); stepStrategy(alternate, 0);
  const deployed = state => state.groups.find(g => g.kind === 'army' && g.factionId === a.id);
  assert.ok(deployed(s), `control report failed to mobilize: ${s.factions[0].intent}`);
  assert.ok(deployed(alternate), `unseen wall prevented dispatch: ${alternate.factions[0].intent}`);
  // Local discovery events legitimately consume world IDs before dispatch;
  // compare the full mission contract independent of its allocated identity.
  const mission = state => { const { id, ...order } = deployed(state); return order; };
  assert.deepEqual(mission(alternate), mission(s), 'hidden enemy construction changed report-based mobilization');
  assert.equal(alternate.factions[0].knowledge[hb.id].reportedTick, 395, 'unreturned scout observation reached command');
  }
});

test('audit: natural contact replay is identical across chunk sizes and irregular render calls', t => {
  const seed = 'first-light', pulses = 2200;
  const baseline = createSimulation(seed), chunked = createSimulation(seed), rendered = createSimulation(seed);
  stepSimulation(baseline, pulses); auditState(baseline);
  for (let done = 0; done < pulses;) { const count = Math.min([1, 7, 13, 59, 101][done % 5], pulses - done); stepSimulation(chunked, count); done += count; }
  assert.deepEqual(chunked, baseline, 'stepSimulation call boundaries changed the seeded outcome');
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(40, 1.6, .2, 1800), frame = overviewFrame(1.6);
  camera.position.copy(frame.position); camera.lookAt(frame.target.x, frame.target.y, frame.target.z); camera.updateMatrixWorld(); scene.userData.camera = camera;
  const crowds = createCrowds(THREE, scene), entities = createEntities(THREE, scene), effects = createCombatEffects(THREE, scene), terrain = createTerrain(THREE, scene, seed);
  let frames = 0;
  try {
    for (let done = 0; done < pulses;) {
      const count = Math.min(113, pulses - done); stepSimulation(rendered, count); done += count;
      const before = structuredClone(rendered);
      for (const alpha of [.83, .17, 1]) {
        const time = rendered.time + alpha / 10, selection = rendered.groups.find(g => g.kind === 'army')?.id ?? rendered.settlements[0].id;
        crowds.update(rendered, time, selection, alpha); entities.update(rendered, time, selection, alpha); effects.update(rendered, time); terrain.update(time, rendered, alpha); frames++;
      }
      assert.deepEqual(rendered, before, `render calls changed state at pulse ${done}`);
    }
    assert.deepEqual(rendered, baseline, 'renderer cache use changed subsequent simulation evolution');
    assert.ok(baseline.stats.attacks > 0, 'natural replay must cover actual contact and attacks');
    assert.ok(baseline.groups.some(g => g.formationSlots), 'natural replay must cover physical formation state');
    const hash = createHash('sha256').update(JSON.stringify(baseline)).digest('hex');
    t.diagnostic(`${pulses} pulses; ${frames} irregular frames through four renderers; ${baseline.stats.attacks} attacks; exact state SHA-256 ${hash}`);
  } finally { crowds.dispose(); entities.dispose(); effects.dispose(); terrain.dispose(); }
});
