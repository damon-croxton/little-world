import { setMilitary } from './roster-fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSimulation } from '../src/sim/core.js';
import { stepProgression } from '../src/sim/progression.js';
import { initializeLedger, ledgerResidual } from '../src/sim/economy.js';
import { factionView } from '../src/sim/knowledge.js';

function proposalState(seed) {
  const s = createSimulation(seed); s.factions = s.factions.slice(0, 2); s.settlements = s.settlements.filter(h => s.factions.some(f => f.id === h.factionId));
  delete s.config.diplomacy; // Retained pre-free-for-all snapshot compatibility.
  s.groups = []; s.tradeOffers = []; s.events = []; s.tick = 80; s.step = 800; s.time = 80;
  const [f, partner] = s.factions, [origin, destination] = s.settlements;
  origin.stock = { food: 2000, water: 2000, energy: 2400, materials: 1000 }; origin.capacity = 3000; origin.availableWorkers = 75;
  origin.lastTradeProposal = -100; origin.assigned = {}; f.researchWorkers = 0; f.lastProposal = -100; partner.lastProposal = 80;
  f.relations[partner.id] = { trust: 55, status: 'neutral', lastTrade: -100, successfulTrades: 0 };
  f.knowledge[destination.id] = { id: destination.id, kind: 'settlement', ownerId: partner.id, name: destination.name, x: origin.x + 40, z: origin.z, populationEstimate: 110, soldiersEstimate: 10, status: 'active', observedTick: 20, reportedTick: 40, confidence: .8 };
  initializeLedger(s); return s;
}

test('barter proposals use stale contacts and self stores without reading hidden partner stocks, census, traits or disposition', () => {
  const a = proposalState('knowledge-trade'), b = structuredClone(a), [f, partner] = b.factions;
  const hidden = b.settlements[1]; hidden.stock = { food: 0, water: 0, energy: 0, materials: 0 }; hidden.population = 2; setMilitary(b, hidden); hidden.homePresent = 2;
  partner.traits.cooperation = 0; partner.traits.aggression = 1;
  partner.relations[f.id] = { status: 'hostile', trust: 0, lastTrade: 79 };
  initializeLedger(b);
  stepProgression(a); stepProgression(b);
  const offered = s => s.tradeOffers.filter(o => o.factionId === s.factions[0].id).map(({ id, ...o }) => o);
  assert.equal(offered(a).length, 1, 'fixture did not produce a proposal'); assert.deepEqual(offered(a), offered(b));
  assert.deepEqual(a.settlements[0].stock, b.settlements[0].stock);
  assert.equal(a.factions[1].lastProposal, 80, 'an incoming proposal secretly changed recipient planning before delivery');
  const recipient = factionView(a, a.factions[1].id);
  assert.ok(!recipient.events.some(e => e.pending), 'recipient saw the unarrived trade proposal');
  for (const s of [a, b]) for (const value of Object.values(ledgerResidual(s))) assert.ok(Math.abs(value) < 1e-6);
});

test('commercial protection expires after 72 cycles and cannot silently become an eternal alliance', () => {
  const s = proposalState('temporary-truce'), [a, b] = s.factions;
  s.tick = 100; s.step = 1000; s.time = 100;
  a.lastProposal = b.lastProposal = 10000;
  a.relations[b.id] = { status: 'neutral', trust: 95, successfulTrades: 8, lastTrade: 90 };
  b.relations[a.id] = { status: 'neutral', trust: 95, successfulTrades: 8, lastTrade: 90 };
  stepProgression(s);
  assert.equal(a.relations[b.id].status, 'trade'); assert.equal(a.relations[b.id].truceUntil, 172);
  s.tick = 172; s.step = 1720; s.time = 172; stepProgression(s);
  assert.equal(a.relations[b.id].status, 'neutral'); assert.equal(b.relations[a.id].status, 'neutral');
  s.tick = 173; s.step = 1730; s.time = 173; stepProgression(s);
  assert.equal(a.relations[b.id].status, 'neutral', 'high inherited trust silently renewed the alliance');
});

test('capitulated factions stop independent research and occupied homes cannot fund native expansion diplomacy', () => {
  const s = proposalState('defeated-agency'), [native, victor] = s.factions, [held] = s.settlements;
  native.defeatedBy = victor.id; held.occupiedBy = victor.id; native.researchWorkers = 9; native.researchHomeId = held.id;
  const before = native.tech.progress, invested = { ...native.tech.invested };
  stepProgression(s);
  assert.equal(native.researchWorkers, 0); assert.equal(native.researchHomeId, null); assert.equal(native.tech.progress, before); assert.deepEqual(native.tech.invested, invested);
  assert.ok(!s.tradeOffers.some(o => o.factionId === native.id));
});
