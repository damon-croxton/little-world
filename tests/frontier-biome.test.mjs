import test from 'node:test';
import assert from 'node:assert/strict';
import { generateWorld, biomeAt, terrainAt, worldBiome } from '../src/world.js';
import { normalizeConfig } from '../src/config.js';
import { createSimulation, planFounding } from '../src/sim/core.js';
import { frontierContext, assessFrontier, assessFrontierRoute, frontierAssets } from '../src/sim/frontier.js';
import { dispatchProtection, stepStrategy, coordinateFrontlines } from '../src/sim/strategy.js';
import { stepCombat } from '../src/sim/combat.js';
import { observationFor, factionView } from '../src/sim/knowledge.js';
import { getSoldiers } from '../src/sim/soldiers.js';
import { initializeLedger, ledgerResidual, SURVIVAL_NEEDS } from '../src/sim/economy.js';
import { setMilitary, bindArmy } from './roster-fixtures.mjs';

for (const biome of ['meadow', 'desert', 'alien']) test(`${biome}: every terrain sample and deposit uses the selected whole-world biome`, () => {
  const world = generateWorld('one-world', { civCount: 5, biome });
  assert.equal(world.biome, biome); assert.equal(world.starts.length, 5);
  for (let x = -170; x <= 170; x += 17) for (let z = -170; z <= 170; z += 17) {
    assert.equal(biomeAt(x, z, world.terrainSeed), biome); assert.equal(terrainAt(x, z, world.terrainSeed).biome, biome);
  }
  assert.ok(world.nodes.every(node => node.biome === biome));
  for (const district of world.districts) assert.equal(terrainAt(district.x, district.z, world.terrainSeed).fertility, .8);
  const s = createSimulation('one-world', { biome }); assert.equal(factionView(s, s.factions[0].id).terrain.biome, biome);
});

test('seed choice is deterministic, count-independent, and invalid biome choices normalize', () => {
  assert.equal(worldBiome('random-world', { civCount: 3 }), worldBiome('random-world', { civCount: 6 }));
  assert.equal(normalizeConfig({ biome: 'unknown' }).biome, 'random');
  assert.deepEqual(generateWorld('random-world'), generateWorld('random-world'));
  assert.equal(new Set(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'].map(seed => worldBiome(seed))).size, 3);
});

function fixture() {
  const s = createSimulation('frontier-contract', { civCount: 3 }), [home, enemyHome] = s.settlements, [f, enemy] = s.factions;
  Object.assign(s, { tick: 80, step: 800, time: 80 });
  for (const faction of s.factions) { faction.knowledge = {}; faction.lastScout = 80; faction.lastArmy = 80; }
  setMilitary(s, home, { infantry: 24, ranged: 8 });
  Object.assign(home, { availableWorkers: 60, shortageDays: 0, health: 100 });
  for (const key of Object.keys(home.stock)) home.stock[key] = 1500;
  const start = s.terrain.districts.find(d => d.kind === 'start' && Math.hypot(d.x - home.x, d.z - home.z) < .1);
  const point = s.terrain.districts.find(d => d.kind === 'expansion' && d.slot === start.slot);
  const crew = { id: 'remote-crew', targetId: 'remote-deposit', factionId: f.id, originId: home.id, kind: 'worker', size: 20, phase: 'working', x: point.x, z: point.z, targetX: point.x, targetZ: point.z, carrying: { food: 8, water: 0, energy: 0, materials: 0 } };
  s.groups.push(crew);
  return { s, home, enemyHome, f, enemy, point, crew };
}

test('frontier risk ignores hidden enemy movement, supply and army size, but uses delivered reports', () => {
  const { s, f, enemyHome, enemy, point } = fixture();
  const before = assessFrontier(frontierContext(s, f), point);
  Object.assign(enemyHome, { x: point.x, z: point.z, population: 900, soldiers: 800 });
  s.groups.push({ id: 'hidden', kind: 'army', factionId: enemy.id, originId: enemyHome.id, size: 900, x: point.x, z: point.z });
  assert.deepEqual(assessFrontier(frontierContext(s, f), point), before);
  f.relations[enemy.id] = { status: 'hostile' };
  f.knowledge.hidden = { id: 'hidden', kind: 'group', groupKind: 'army', ownerId: enemy.id, x: point.x + 6, z: point.z, sizeEstimate: 8, observedTick: 80, reportedTick: 80, confidence: 1 };
  const known = assessFrontier(frontierContext(s, f), point);
  assert.ok(known.siteBlocked && known.pressure > 0 && known.pressure < 8);
  s.tick = 110; assert.equal(assessFrontier(frontierContext(s, f), point).pressure, 0, 'expired marching-army report kept blocking expansion');
});

test('frontier route checks detect a threat between distant safe endpoints', () => {
  const context = { homes: [], coverage: [], threats: [{ kind: 'group', x: 0, z: 0, sizeEstimate: 12 }] };
  assert.equal(assessFrontier(context, { x: -40, z: 0 }).routeBlocked, false);
  assert.equal(assessFrontier(context, { x: 40, z: 0 }).routeBlocked, false);
  const risk = assessFrontierRoute(context, { x: -40, z: 0 }, { waypoints: [{ x: 40, z: 0 }] });
  assert.equal(risk.blocked, true); assert.ok(risk.peak >= 10);
});

test('remote guard moves actual paid soldiers, preserves home reserve, population and resource ledger', () => {
  const { s, home, f, crew } = fixture(); initializeLedger(s);
  const population = home.population, ids = new Set(home.soldierRoster.map(body => body.id)), food = home.stock.food;
  assert.equal(frontierAssets(s, f, frontierContext(s, f))[0].id, crew.targetId);
  dispatchProtection(s, f, [home]); const guard = s.groups.find(g => g.missionKind === 'protection');
  assert.ok(guard); assert.equal(guard.protectionId, crew.targetId); assert.equal(guard.strategicHold.kind, 'protect');
  assert.ok(guard.size >= 6 && getSoldiers(s, home).length >= guard.homeReserve);
  assert.equal(getSoldiers(s, home).length + getSoldiers(s, guard).length, ids.size);
  assert.ok(getSoldiers(s, guard).every(body => ids.has(body.id))); assert.equal(home.population, population);
  for (const [key, need] of Object.entries(SURVIVAL_NEEDS[f.species])) assert.ok(guard.provisions[key] >= need * guard.size * (guard.expectedTravelCycles + 40), `${key} did not fund the round trip and guard rotation`);
  assert.ok(home.stock.food < food || f.species === 'machine' && home.stock.energy < 1500);
  for (const residual of Object.values(ledgerResidual(s))) assert.ok(Math.abs(residual) < 1e-7);
});

test('remote protection declines unaffordable trips and preserves a threatened home garrison', () => {
  const { s, home, f } = fixture(); for (const key of Object.keys(home.stock)) home.stock[key] = 0;
  dispatchProtection(s, f, [home]); assert.ok(!s.groups.some(g => g.missionKind === 'protection'));
  for (const key of Object.keys(home.stock)) home.stock[key] = 1500;
  setMilitary(s, home, { infantry: 10, ranged: 2 }); const enemy=s.factions[1];f.relations[enemy.id]={status:'hostile'};f.knowledge.alarm={id:'alarm',kind:'group',groupKind:'army',ownerId:enemy.id,x:home.x+15,z:home.z,sizeEstimate:12,observedTick:s.tick,reportedTick:s.tick,confidence:1}; dispatchProtection(s, f, [home]);
  assert.ok(!s.groups.some(g => g.missionKind === 'protection'));
});

test('an empty or depleted home cannot promise nearby reinforcements', () => {
  const {s,home,f,point}=fixture();
  const ready=assessFrontier(frontierContext(s,f),point); assert.ok(ready.reinforcementDistance<50);
  setMilitary(s,home,{infantry:10,ranged:2});const empty=assessFrontier(frontierContext(s,f),point);
  assert.equal(empty.reinforcementDistance,180);assert.ok(empty.reinforcementCycles>ready.reinforcementCycles);
  setMilitary(s,home,{infantry:24,ranged:8});home.shortageDays=2;
  assert.equal(assessFrontier(frontierContext(s,f),point).reinforcementDistance,180);
});

test('guard reacts to a locally seen approaching raider before contact with the remote crew', () => {
  const { s, home, f, enemyHome, enemy, point } = fixture(); dispatchProtection(s, f, [home]);
  const guard = s.groups.find(g => g.missionKind === 'protection'); Object.assign(guard, { x: point.x, z: point.z });
  for (const body of getSoldiers(s, guard)) Object.assign(body, { x: point.x, z: point.z });
  f.relations[enemy.id] = { status: 'hostile' }; enemy.relations[f.id] = { status: 'hostile' };
  setMilitary(s, enemyHome, { infantry: 4, ranged: 0 });
  const raider = { id: 'approaching-raider', kind: 'army', factionId: enemy.id, originId: enemyHome.id, units: { infantry: 4, ranged: 0 }, size: 4, x: point.x + 12, z: point.z, phase: 'outbound', supply: 100, morale: 100, speed: 2.8, targetX: point.x, targetZ: point.z };
  bindArmy(s, enemyHome, raider); s.groups.push(raider); stepCombat(s, .1);
  assert.equal(guard.combat.targetId, raider.id); assert.equal(guard.phase, 'engaging');
});

test('guard rotation expires into physical return and a completed worksite releases its guard', () => {
  for (const expiry of [true, false]) {
    const { s, home, f, crew } = fixture(); dispatchProtection(s, f, [home]);
    const guard = s.groups.find(g => g.missionKind === 'protection'); Object.assign(guard, { x: crew.x, z: crew.z });
    if (expiry) { s.tick = guard.protectionUntil; s.step = s.tick * 10; s.time = s.tick; } else crew.phase = 'returning';
    for (const faction of s.factions) { faction.lastScout = s.tick; faction.lastArmy = s.tick; }
    stepStrategy(s, 0);
    assert.equal(guard.phase, 'returning'); assert.equal(guard.strategicHold, null);
    assert.equal(guard.targetX, home.x); assert.equal(guard.targetZ, home.z); assert.notEqual(guard.x, home.x);
    assert.ok(getSoldiers(s, guard).length > 0, 'returning soldiers teleported into the home roster');
  }
});

test('founding rejects an observed threat along the route, then resumes when that report expires', () => {
  const { s, home, f, enemy, point } = fixture(); s.groups = []; Object.assign(s, { tick: 200, step: 2000, time: 200 });
  Object.assign(home, { population: 150, workers: 118, availableWorkers: 100, lastExpansion: 0 });
  for (const node of s.nodes.filter(n => n.balancedDistrict === point.id)) f.knowledge[node.id] = { ...observationFor(s, f, node), reportedTick: 200 };
  f.relations[enemy.id] = { status: 'hostile' };
  f.knowledge.roadArmy = { id: 'roadArmy', kind: 'group', groupKind: 'army', ownerId: enemy.id, x: home.x + (point.x - home.x) * .32, z: home.z + (point.z - home.z) * .32, sizeEstimate: 8, observedTick: 200, reportedTick: 200, confidence: 1 };
  assert.equal(assessFrontier(frontierContext(s, f), point).siteBlocked, false);
  planFounding(s, home, f); assert.ok(!s.groups.some(g => g.kind === 'colonist'));
  s.tick = 225; planFounding(s, home, f); assert.ok(s.groups.some(g => g.kind === 'colonist'), 'safe funded expansion stayed frozen after stale danger expired');
});


test('a returning guard cannot be diverted or merged into an offensive campaign', () => {
  const {s,home,f,point}=fixture();dispatchProtection(s,f,[home]);const guard=s.groups.find(g=>g.missionKind==='protection');
  Object.assign(guard,{x:point.x,z:point.z,phase:'returning',strategicHold:null,targetX:home.x,targetZ:home.z});
  const army={id:'nearby-campaign',kind:'army',factionId:f.id,originId:home.id,campaign:true,phase:'outbound',units:{infantry:8,ranged:0},size:8,supply:100,morale:100,x:point.x,z:point.z,targetId:'foreign-home',targetX:0,targetZ:0,createdTick:0};
  bindArmy(s,home,army);s.groups.push(army);coordinateFrontlines(s,f);
  assert.equal(guard.phase,'returning');assert.equal(guard.targetX,home.x);assert.equal(guard.finished,undefined);assert.ok(getSoldiers(s,guard).length>0);assert.equal(army.size,8);
});

test('colonist escort follows its own party and becomes protection for the physically founded outpost', () => {
  const {s,home,f,point,crew}=fixture();s.groups=[];
  const settlers={...crew,id:'settlers',kind:'colonist',size:28,phase:'outbound'};s.groups.push(settlers);
  dispatchProtection(s,f,[home]);const guard=s.groups.find(g=>g.missionKind==='protection');
  assert.ok(guard);assert.equal(guard.protectionKind,'escort');assert.equal(guard.protectionId,settlers.id);
  settlers.x+=2;stepStrategy(s,0);assert.equal(guard.targetX,settlers.x);
  settlers.finished=true;
  const outpost={...structuredClone(home),id:'new-outpost',x:settlers.x,z:point.z,population:28,workers:28,foundedTick:s.tick,buildings:[],soldierRoster:[],soldiers:0,military:{infantry:0,ranged:0}};
  s.settlements.push(outpost);stepStrategy(s,0);
  assert.equal(guard.protectionKind,'outpost');assert.equal(guard.protectionId,outpost.id);
  assert.equal(guard.originId,home.id);assert.equal(guard.targetX,outpost.x);assert.equal(guard.strategicHold.kind,'protect');
  assert.equal(getSoldiers(s,outpost).length,0,'escort was silently transferred into the new native census');
});
