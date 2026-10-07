import test from 'node:test';
import assert from 'node:assert/strict';
import { createSimulation, stepSimulation, launchWorkers, planFounding } from '../src/sim/core.js';
import { stepStrategy, coordinateFrontlines } from '../src/sim/strategy.js';
import { initializeLedger, ledgerResidual } from '../src/sim/economy.js';
import { knownResourceNodes } from '../src/sim/knowledge.js';
import { getSoldiers } from '../src/sim/soldiers.js';
import { terrainAt } from '../src/world.js';
import { findPath, lineOfSight } from '../src/sim/navigation.js';
import { setMilitary, recruitMilitary, bindArmy } from './roster-fixtures.mjs';

function fixture() {
  const s = createSimulation('first-light'), [home, enemy] = s.settlements, [f, rival] = s.factions;
  s.groups = []; s.nodes = []; s.tick = 150; s.time = 150; s.step = 1500;
  for (const h of s.settlements) { h.buildings = []; setMilitary(s, h); }
  for (const faction of s.factions) { faction.lastScout = 150; faction.lastArmy = 150; faction.knowledge = {}; }
  f.relations[rival.id] = { status: 'hostile', trust: 0 }; rival.relations[f.id] = { status: 'hostile', trust: 0 };
  return { s, home, enemy, f, rival };
}
function node(s, f, id, kind, point, amount = 700) {
  const n = { id, kind, ...point, amount, maxAmount: amount, richness: .6, radius: 2, regeneration: 0 };
  s.nodes.push(n);
  f.knowledge[id] = { id, kind: 'resource', resourceKind: kind, ...point, amountEstimate: amount, richnessEstimate: .6, radius: 2, observedTick: s.tick, reportedTick: s.tick, confidence: 1 };
  return n;
}
function ledger(s) { for (const r of Object.values(ledgerResidual(s))) assert.ok(Math.abs(r) < 1e-7, `ledger residual ${r}`); }
function army(s, home, id, point, extras = {}) {
  const units = { infantry: 6, ranged: 2 }; recruitMilitary(s, home, units);
  const g = { id, kind: 'army', factionId: home.factionId, originId: home.id, ...point, prevX: point.x, prevZ: point.z,
    targetId: 'shared-front', targetX: point.x + 30, targetZ: point.z, missionTargetX: point.x + 30, missionTargetZ: point.z,
    phase: 'outbound', campaign: true, size: 8, initialSize: 8, units, supply: 90, morale: 90, speed: 2.8,
    carrying: { food: 3, water: 0, materials: 0, energy: 0 }, observations: [], createdTick: 120, ...extras };
  bindArmy(s, home, g); s.groups.push(g); return g;
}
function pulse(s) { s.step++; s.time = s.step / 10; s.tick = Math.floor(s.time); stepStrategy(s, .1); }

test('harvest dispatch skips a blocked best deposit and funds a reachable alternative', () => {
  const { s, home, f } = fixture(); home.workers = home.population; home.availableWorkers = 40; home.assigned = { workers: 0, civilianAway: 0 };
  home.stock = { food: 20, water: 200, energy: 200, materials: 200 };
  const blocked = { x: home.x + 12, z: home.z };
  home.buildings.push({ id: 'blocked-deposit-wall', kind: 'wall', ...blocked, width: 4, length: 8, progress: 1, hp: 200 });
  node(s, f, 'blocked-food', 'food', blocked);
  // A known impossible deposit must not veto the useful nearby trip.
  const reachable = node(s, f, 'reachable-water', 'water', { x: home.x - 4, z: home.z });
  assert.equal(findPath(s, home, blocked, { factionId: f.id }).reachable, false);
  assert.equal(findPath(s, home, reachable, { factionId: f.id }).reachable, true);
  initializeLedger(s);
  launchWorkers(s, home, f, { traffic: new Map(), knownNodes: new Map([[f.id, knownResourceNodes(s, f)]]) });
  assert.equal(s.groups[0]?.targetId, 'reachable-water'); assert.ok(s.groups[0].provisionCycles > 0); ledger(s);
});

test('empty stores can recover with real small crews, depleted rations and conserved cargo', () => {
  const { s, home, f } = fixture(); home.workers = home.population; home.availableWorkers = 40; home.assigned = { workers: 0, civilianAway: 0 };
  home.stock = { food: 0, water: 0, energy: 0, materials: 0 }; home.shortageDays = 20;
  node(s, f, 'recovery-water', 'water', { x: home.x + 2, z: home.z });
  initializeLedger(s);
  launchWorkers(s, home, f, { traffic: new Map(), knownNodes: new Map([[f.id, knownResourceNodes(s, f)]]) });
  const g = s.groups[0]; assert.ok(g?.emergencyForage); assert.ok(g.size <= 3); assert.equal(g.supply, 0);
  assert.deepEqual(g.provisions, { food: 0, water: 0, energy: 0, materials: 0 });
  stepSimulation(s, 50);
  assert.ok(s.resourceLedger.water.delivered > 0, 'recovery crew must actually bring harvested water home');
  assert.ok(s.resourceLedger.water.extracted >= s.resourceLedger.water.delivered); ledger(s);
});

test('nearby reinforcement merges canonical identities and paid supplies without healing', () => {
  const { s, home, f } = fixture(), p = { x: home.x, z: home.z };
  const leader = army(s, home, 'front-a', p), incoming = army(s, home, 'front-b', { x: p.x + 4, z: p.z }, { createdTick: 130, supply: 70 });
  const bodies = [...getSoldiers(s, leader), ...getSoldiers(s, incoming)], wounded = bodies.at(-1); wounded.hp -= 7;
  const health = new Map(bodies.map(b => [b.id, b.hp])), population = home.population, cargo = leader.carrying.food + incoming.carrying.food;
  initializeLedger(s); coordinateFrontlines(s, f);
  assert.equal(leader.size, 16); assert.ok(incoming.finished); assert.equal(leader.supply, 80); assert.equal(leader.carrying.food, cargo);
  assert.equal(home.population, population); assert.equal(new Set(leader.soldierIds).size, 16);
  for (const body of bodies) { assert.ok(getSoldiers(s, leader).includes(body)); assert.equal(body.hp, health.get(body.id)); assert.equal(body.groupId, leader.id); }
  ledger(s);
});

test('head-on returning armies interrupt travel, fight and keep physical bodies separated', () => {
  const { s, home, enemy } = fixture(), point = { x: home.x, z: home.z };
  const a = army(s, home, 'left', { x: point.x - 3, z: point.z }, { phase: 'returning', campaign: false, targetX: point.x + 20 });
  const b = army(s, enemy, 'right', { x: point.x + 3, z: point.z }, { phase: 'returning', campaign: false, targetX: point.x - 20 });
  home.x += 70; home.z += 50;
  const hp = [...getSoldiers(s, a), ...getSoldiers(s, b)].reduce((n, b) => n + b.hp, 0);
  initializeLedger(s);
  for (let i = 0; i < 35; i++) pulse(s);
  assert.equal(a.phase, 'engaging'); assert.equal(b.phase, 'engaging');
  const bodies = [...getSoldiers(s, a), ...getSoldiers(s, b)];
  assert.ok(bodies.reduce((n, b) => n + b.hp, 0) < hp, 'nearby enemies must actually exchange damage');
  for (const left of getSoldiers(s, a)) for (const right of getSoldiers(s, b)) assert.ok(Math.hypot(left.x - right.x, left.z - right.z) >= .459);
  assert.equal(a.combat.resumePhase, 'returning'); ledger(s);
});

test('a faster escaping scout is promptly ignored and the army resumes its objective', () => {
  const { s, home, enemy } = fixture(), point = { x: home.x, z: home.z };
  const a = army(s, home, 'chaser', point);
  home.x += 70; home.z += 50;
  const scout = { id: 'escaping-scout', kind: 'scout', originId: enemy.id, factionId: enemy.factionId, x: point.x + 8, z: point.z, prevX: point.x + 7.5, prevZ: point.z,
    targetX: point.x + 30, targetZ: point.z, phase: 'outbound', size: 1, initialSize: 1, speed: 4.2, supply: 100, morale: 90, carrying: {}, observations: [] };
  s.groups.push(scout); pulse(s);
  assert.equal(a.combat.ignoredScoutId, scout.id); assert.equal(a.phase, 'outbound'); assert.ok(a.combat.ignoreScoutUntil > s.time);
  assert.equal(a.targetId, 'shared-front');
});

test('funded small outposts choose accessible resources away from reported threats', () => {
  const { s, home, f, rival } = fixture();
  home.population = 160; home.workers = 160; home.availableWorkers = 100; home.lastExpansion = 0; home.radius = 4;
  home.stock = { food: 1000, water: 1000, energy: 1000, materials: 1000 };
  let site;
  for (let angle = 0; angle < Math.PI * 2; angle += .2) {
    const p = { x: home.x + Math.cos(angle) * 48, z: home.z + Math.sin(angle) * 48 }, t = terrainAt(p.x, p.z, s.terrainSeed || s.seed);
    if (t.traversable && t.height >= .4 && t.roughness <= .65 && findPath(s, home, p, { factionId: f.id }).reachable && lineOfSight(s, p, { x: p.x + 2, z: p.z })) { site = p; break; }
  }
  assert.ok(site);
  for (const [i, kind] of ['food', 'water', 'materials'].entries()) node(s, f, `colony-${kind}`, kind, { x: site.x + i, z: site.z });
  f.knowledge.threat = { id: 'threat', kind: 'settlement', ownerId: rival.id, x: home.x - (site.x - home.x), z: home.z - (site.z - home.z), observedTick: 150, reportedTick: 150, confidence: 1, status: 'active' };
  const unsafe = structuredClone(s);
  Object.assign(unsafe.factions[0].knowledge.threat, site);
  planFounding(unsafe, unsafe.settlements[0], unsafe.factions[0]);
  assert.ok(!unsafe.groups.some(g => g.kind === 'colonist'), 'a reported enemy beside the site must veto expansion');
  // Unseen opposing coordinates cannot influence the planned destination.
  Object.assign(s.settlements[1], site);
  initializeLedger(s); const population = home.population, stock = home.stock.materials;
  planFounding(s, home, f);
  const colony = s.groups.find(g => g.kind === 'colonist'); assert.ok(colony); assert.ok(colony.size >= 24 && colony.size <= 48);
  assert.ok(Math.hypot(colony.targetX - site.x, colony.targetZ - site.z) < 5);
  assert.equal(home.population, population, 'travelling colonists remain in their origin census until arrival');
  assert.ok(home.availableWorkers >= 40); assert.ok(home.stock.materials < stock); assert.ok(colony.provisionCycles > 0); ledger(s);
});
