import test from 'node:test';
import assert from 'node:assert/strict';
import { createSimulation } from '../src/sim/core.js';
import { economicSurveyTarget, stepStrategy } from '../src/sim/strategy.js';
import { initializeLedger, ledgerResidual } from '../src/sim/economy.js';
import { setMilitary, recruitMilitary, bindArmy } from './roster-fixtures.mjs';

function fixture() {
  const s = createSimulation('first-light', { civCount: 3 }), [f, rival] = s.factions, [home, enemy] = s.settlements;
  s.tick = 150; s.time = 150; s.step = 1500; s.groups = [];
  f.relations[rival.id] = { status: 'hostile', trust: 0 }; rival.relations[f.id] = { status: 'hostile', trust: 0 };
  for (const faction of s.factions) { faction.lastScout = 150; faction.lastArmy = 150; faction.knowledge = {}; }
  f.lastScout = 0; f.scoutCount = 2;
  const expansion = s.terrain.districts.find(d => d.id === 'expansion-0');
  f.knowledge.site = { id: 'site', kind: 'resource', resourceKind: 'materials', x: expansion.x, z: expansion.z, amountEstimate: 700, observedTick: 100, reportedTick: 100, confidence: 1 };
  f.knowledge.crew = { id: 'crew-report', kind: 'group', groupKind: 'worker', ownerId: rival.id, x: expansion.x + 2, z: expansion.z, sizeEstimate: 12, observedTick: 120, reportedTick: 120, confidence: 1 };
  return { s, f, rival, home, enemy, expansion };
}

test('economic reconnaissance approaches only a reported worksite with dated enemy labor activity', () => {
  const { s, f, home, expansion } = fixture(), target = economicSurveyTarget(s, f, home);
  assert.equal(target.id, 'site'); assert.equal(target.observedTick, 120);
  assert.ok(Math.abs(Math.hypot(target.x - expansion.x, target.z - expansion.z) - 12) < 1e-7);
  assert.ok(Math.hypot(target.x - home.x, target.z - home.z) < Math.hypot(expansion.x - home.x, expansion.z - home.z));
  const baseline = structuredClone(target);
  Object.assign(s.settlements[1], target); s.settlements[1].population = 900;
  s.groups.push({ id: 'hidden-army', kind: 'army', factionId: s.factions[1].id, originId: s.settlements[1].id, size: 80, ...target });
  assert.deepEqual(economicSurveyTarget(s, f, home), baseline, 'hidden enemy position or strength changed a report-based survey');
  delete f.knowledge.site; assert.equal(economicSurveyTarget(s, f, home), null);
});

test('fresh, expired, unreported and allied worker sightings do not trigger economic reconnaissance', () => {
  for (const change of ['fresh', 'expired', 'unreported', 'allied']) {
    const { s, f, rival, home } = fixture();
    if (change === 'fresh') f.knowledge.crew.observedTick = 145;
    if (change === 'expired') f.knowledge.crew.observedTick = 40;
    if (change === 'unreported') f.knowledge.crew.reportedTick = null;
    if (change === 'allied') f.relations[rival.id].status = 'allied';
    assert.equal(economicSurveyTarget(s, f, home), null, change);
  }
});

test('known defenders, existing survey orders and a recent visit veto a worksite revisit', () => {
  for (const change of ['army', 'settlement', 'active', 'recent']) {
    const { s, f, rival, home } = fixture(), target = economicSurveyTarget(s, f, home);
    if (change === 'army') f.knowledge.guard = { id: 'guard', kind: 'group', groupKind: 'army', ownerId: rival.id, x: target.x, z: target.z, observedTick: 145, reportedTick: 145, confidence: 1 };
    if (change === 'settlement') f.knowledge.guard = { id: 'guard', kind: 'settlement', ownerId: rival.id, soldiersEstimate: 8, status: 'active', x: target.x, z: target.z, observedTick: 145, reportedTick: 145, confidence: 1 };
    if (change === 'recent') f.economicSurveys = { site: 100 };
    assert.equal(economicSurveyTarget(s, f, home, change === 'active' ? [{ surveyTargetId: 'site' }] : []), null, change);
  }
});

test('a funded single-citizen economic scout retains its native census and paid supplies', () => {
  const { s, f, home } = fixture(), stock = { ...home.stock }, population = home.population;
  initializeLedger(s); stepStrategy(s, 0);
  const scout = s.groups.find(g => g.kind === 'scout' && g.factionId === f.id);
  assert.equal(scout?.surveyPurpose, 'economic'); assert.equal(scout.surveyTargetId, 'site'); assert.equal(scout.size, 1);
  assert.equal(f.economicSurveys.site, 150); assert.equal(home.population, population);
  assert.ok(Object.keys(stock).some(key => home.stock[key] < stock[key]));
  for (const value of Object.values(ledgerResidual(s))) assert.ok(Math.abs(value) < 1e-7);
});

test('an economic scout abandons its survey after actually seeing hostile defenders', () => {
  const { s, f, home, enemy, expansion } = fixture();
  for (const h of s.settlements) { h.buildings = []; setMilitary(s, h); }
  const scout = { id: 'economic-scout', kind: 'scout', factionId: f.id, originId: home.id, ...expansion, x: expansion.x + 2, prevX: expansion.x + 2, prevZ: expansion.z,
    size: 1, initialSize: 1, supply: 100, morale: 90, speed: 0, phase: 'outbound', targetX: expansion.x + 10, targetZ: expansion.z, createdTick: 150, surveyPurpose: 'economic', carrying: {}, observations: [] };
  scout.id = 'economic-scout'; scout.kind = 'scout';
  const units = { infantry: 8, ranged: 0 }; recruitMilitary(s, enemy, units);
  const guard = { id: 'known-only-on-contact', kind: 'army', factionId: enemy.factionId, originId: enemy.id, x: expansion.x - 3, z: expansion.z, prevX: expansion.x - 3, prevZ: expansion.z, units, size: 8, initialSize: 8, phase: 'outbound', speed: 0, morale: 100, supply: 100, targetX: expansion.x - 3, targetZ: expansion.z, createdTick: 150, observations: [] };
  bindArmy(s, enemy, guard); s.groups.push(scout, guard);
  s.step++; s.time = s.step / 10; stepStrategy(s, .1);
  assert.equal(scout.phase, 'returning'); assert.match(scout.reason, /Visible defenders/); assert.equal(scout.size, 1);
  assert.equal(scout.targetX, home.x); assert.equal(scout.targetZ, home.z);
});
