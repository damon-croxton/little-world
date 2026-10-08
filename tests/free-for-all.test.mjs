import test from 'node:test';
import assert from 'node:assert/strict';
import { createSimulation } from '../src/sim/core.js';
import { normalizeConfig } from '../src/config.js';
import { relationStatus, enforceHostility } from '../src/sim/diplomacy.js';
import { stepProgression } from '../src/sim/progression.js';
import { stepCombat } from '../src/sim/combat.js';
import { initializeMilitary, deployMilitary, getSoldiers } from '../src/sim/military.js';
import { initializeLedger, ledgerResidual } from '../src/sim/economy.js';

test('new matches make every other civilisation hostile without revealing contacts or intelligence', () => {
  const s = createSimulation('ffa-rules', { civCount: 6 });
  assert.equal(normalizeConfig({ diplomacy: 'allied' }).diplomacy, 'free-for-all');
  const knowledge = s.factions.map(f => structuredClone(f.knowledge));
  for (const a of s.factions) for (const b of s.factions) assert.equal(relationStatus(s, a, b.id), a === b ? 'own' : 'hostile');
  assert.equal(s.factions[0].species, s.factions[3].species);
  enforceHostility(s);
  assert.deepEqual(s.factions.map(f => f.knowledge), knowledge);
  assert.ok(s.factions.every(f => Object.keys(f.relations).length === 0), 'The rule invented contact ledgers');
});

test('high trust and past deliveries cannot create truces; existing reserved trade cargo refunds honestly', () => {
  const s = createSimulation('ffa-no-truce'), [a, b] = s.factions, [home, target] = s.settlements;
  Object.assign(s, { tick: 104, step: 1040, time: 104 });
  for (const f of s.factions) { f.lastProposal = -100; f.tech.level = 4; }
  a.relations[b.id] = { status: 'allied', trust: 100, successfulTrades: 100, truceUntil: 1000 };
  b.relations[a.id] = { ...a.relations[b.id] };
  s.tradeOffers = [{ id: 'legacy-reservation', factionId: a.id, partnerId: b.id, originId: home.id, targetId: target.id, dueTick: 104, exportKind: 'materials', importKind: 'water', amount: 20 }];
  initializeLedger(s); const before = home.stock.materials;
  stepProgression(s);
  assert.equal(a.relations[b.id].status, 'hostile'); assert.equal(b.relations[a.id].status, 'hostile');
  assert.equal(s.tradeOffers.length, 0); assert.equal(s.groups.filter(g => g.kind === 'trader').length, 0);
  assert.equal(home.stock.materials, before + 20);
  for (const residual of Object.values(ledgerResidual(s))) assert.ok(Math.abs(residual) < 1e-7);
});

test('a nearby third faction remains attackable and never contributes allied combat support', () => {
  const s = createSimulation('ffa-contact', { civCount: 3 }), [a, b, c] = s.factions;
  const centre = s.terrain.districts.find(d => d.kind === 'expansion');
  s.groups = [];
  for (const home of s.settlements) { home.buildings = []; initializeMilitary(home, { infantry: 8, ranged: 0 }, { state: s }); }
  for (const [i, home] of s.settlements.entries()) {
    const x = centre.x + [-3, 8, 2][i], z = centre.z;
    const g = { id: `army-${i}`, kind: 'army', factionId: home.factionId, originId: home.id, size: 8, initialSize: 8, units: { infantry: 8, ranged: 0 }, x, z,
      phase: 'outbound', supply: 100, morale: 100, speed: 0, targetX: centre.x + 20, targetZ: z, campaign: true, missionEnemyId: b.id };
    deployMilitary(s, home, g); s.groups.push(g);
    for (const [j, body] of getSoldiers(s, g).entries()) Object.assign(body, { positioned: true, x: x + j % 2 * .5, z: z + Math.floor(j / 2) * .5, prevX: x, prevZ: z });
  }
  a.relations[c.id] = { status: 'allied', trust: 100 };
  const knowledge = s.factions.map(f => structuredClone(f.knowledge));
  stepCombat(s, .1);
  assert.equal(s.groups[0].combat.targetId, 'army-2');
  assert.equal(s.groups[0].combat.supportStrength, 0);
  assert.deepEqual(s.factions.map(f => f.knowledge), knowledge, 'Local combat shared foreign intelligence');
});
