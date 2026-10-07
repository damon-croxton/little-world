import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { createSimulation, stepSimulation } from '../src/sim/core.js';
import { createDebugRecorder, encodeDebugReport, DEBUG_LIMITS } from '../src/debug-report.js';

const build = { version: '0.2.0', commit: 'a'.repeat(40) }, view = { paused: true, speed: 2, quality: 'low', perspective: 'f0' };
const fixture = () => createSimulation('debug-report', { civCount: 3 });

test('diagnostic snapshot is coherent, roundtrips gzip, includes native and actual command identities, and never mutates simulation', async () => {
  const s = fixture(), home = s.settlements[0]; home.occupiedBy = 'f1';
  home.assigned = {workers:11,scouts:2,traders:3,colonists:4,military:20,civilianAway:20,researchers:3,construction:4,infrastructure:5,training:6,towerCrew:2};home.missingResources=['water','food'];
  const body = home.soldierRoster[0]; body.hp = 37; body.commandFactionId = 'f1'; body.order = { role: 'recover', objectiveId: home.id };
  const crew = { id: 'crew', kind: 'worker', factionId: 'f0', originId: home.id, size: 11, civilianWounds: 9, x: home.x, z: home.z, targetId: 'n1', carrying: { food: 40 }, provisions: { water: 3 }, soldierIds: [] };
  s.groups.push(crew); s.factions[0].campaignOrders = { army: { groupId: 'army', originId: home.id, size: 20, issuedTick: 12, expiresTick: 90, missionKind: 'campaign' } };
  const before = JSON.stringify(s), d = createDebugRecorder(); d.reset(s, view); d.sample(s, view);
  const r = d.capture(s, view, build), encoded = await encodeDebugReport(r);
  const bytes = Buffer.from(await encoded.blob.arrayBuffer());
  const parsed = JSON.parse(encoded.encoding === 'gzip' ? gunzipSync(bytes) : bytes.toString());
  assert.deepEqual(parsed, r); assert.equal(r.schemaVersion, 1); assert.equal(r.containsHiddenWorldInformation, true);
  assert.equal(r.snapshot.settlements[0].factionId, 'f0'); assert.equal(r.snapshot.settlements[0].controllerId, 'f1');
  assert.deepEqual(r.snapshot.settlements[0].assigned,home.assigned);assert.deepEqual(r.snapshot.settlements[0].missingResources,['water','food']);
  assert.equal(r.snapshot.soldiers[0].hp, 37); assert.equal(r.snapshot.soldiers[0].nativeFactionId, 'f0'); assert.equal(r.snapshot.soldiers[0].controllerId, 'f1');
  assert.equal(r.snapshot.groups[0].controllerId, 'f1'); assert.equal(r.snapshot.groups[0].civilianHealth, 343);
  assert.equal(r.snapshot.factions[0].campaignOrders[0].size, 20); assert.equal(r.snapshot.factions[0].campaignOrders[0].issuedTick, 12);
  assert.equal(JSON.stringify(s), before); assert.ok(encoded.blob.size < DEBUG_LIMITS.reportBytes);
});

test('current sight IDs stay distinct from discoveries and report timestamps', () => {
  const s=fixture(),f=s.factions[0],d=createDebugRecorder();f.seenObjects={stale:1};f.visibility.visibleIds={current:true};f.visibility.updatedStep=14;
  f.knowledge={stale:{id:'stale',kind:'group',observedTick:1,reportedTick:3}};d.reset(s,view);
  const k=d.capture(s,view,build).snapshot.knowledge[0];assert.deepEqual(k.visibleIds,['current']);assert.equal(k.visibilityUpdatedStep,14);assert.equal(k.reports[0].reportedTick,3);
});

test('plain JSON fallback preserves the complete same schema when compression is missing or fails', async () => {
  const d = createDebugRecorder(), s = fixture(); d.reset(s, view); const r = d.capture(s, view, build);
  for (const Compression of [null, class { constructor() { throw new Error('unavailable'); } }]) {
    const file = await encodeDebugReport(r, { Compression });
    assert.equal(file.encoding, 'json'); assert.match(file.name, /\.json$/); assert.deepEqual(JSON.parse(await file.blob.text()), r);
  }
});

test('history detects target, retreat, rally and failed route reasons without retaining live object references', () => {
  let now = 0; const d = createDebugRecorder({ now: () => now }), s = fixture();
  const g = { id: 'army', kind: 'army', factionId: 'f0', size: 20, targetId: 's1', phase: 'outbound', x: 0, z: 0, strategicHold: { kind: 'rally', x: 2, z: 2 } };
  s.groups.push(g); d.reset(s, view); d.sample(s, view);
  g.targetId = 's2'; g.phase = 'retreating'; g.reason = 'No useful route'; g.navigation = { reachable: false, reason: 'blocked' }; now += 2000; s.step++; d.sample(s, view);
  const report = d.capture(s, view, build), decisions = report.history.filter(e => e.kind === 'decision' && e.data.id === 'army');
  assert.equal(decisions[0].data.targetId, 's1'); assert.equal(decisions[0].data.hold.kind, 'rally');
  assert.equal(decisions[1].data.phase, 'retreating'); assert.equal(decisions[1].data.navigation.reason, 'blocked');
  g.reason = 'different'; assert.equal(decisions[1].data.reason, 'No useful route');
});

test('sampling is throttled, never scans soldiers, and leaves deterministic outcomes identical', () => {
  let now = 0; const d = createDebugRecorder({ now: () => now }), s = fixture(), other = fixture();
  d.reset(s, view);
  for (let i = 0; i < 8; i++) { stepSimulation(s, 10); stepSimulation(other, 10); now += 2000; d.sample(s, view); }
  assert.equal(JSON.stringify(s), JSON.stringify(other));
  const home = s.settlements[0], roster = home.soldierRoster;
  Object.defineProperty(home, 'soldierRoster', { configurable: true, get() { throw new Error('sampler scanned roster'); } });
  for (let i = 0; i < 1000; i++) assert.equal(d.sample(s, view), false);
  now += 2000; s.step++; assert.equal(d.sample(s, view), true);
  Object.defineProperty(home, 'soldierRoster', { value: roster, writable: true });
});

test('history count and byte caps, source event gaps and same-seed reset are explicit', () => {
  let now = 0; const d = createDebugRecorder({ now: () => now }), s = fixture(); d.reset(s, view); d.sample(s, view);
  for (let i = 0; i < 1800; i++) d.recordError(s, 'runtime', new Error('not retained'));
  assert.ok(d.stats().retainedEvents <= DEBUG_LIMITS.events); assert.ok(d.stats().retainedBytes <= DEBUG_LIMITS.historyBytes); assert.ok(d.stats().dropped > 0);
  s.events = [{ id: 'replacement', tick: 8, text: 'A new event' }]; s.step++; now += 2000; d.sample(s, view);
  assert.equal(d.capture(s, view, build).truncation.eventGaps, 1);
  d.reset(s, view); assert.equal(d.stats().dropped, 0); assert.equal(d.stats().trackedEntities, 0);
  assert.equal(d.capture(s, view, build).world.generation, 2); assert.equal(d.stats().retainedEvents, 2);
});

test('whitelists omit circular state, arbitrary error payloads, unrelated browser data and nested secrets', () => {
  const d = createDebugRecorder(), s = fixture(); s.secret = 'do-not-export'; s.self = s;
  s.factions[0].secret = 'do-not-export'; s.settlements[0].soldierRoster[0].unrelated = s;
  d.reset(s, view); d.recordError(s, 'promise', { name: 'secret-name', message: 'do-not-export', stack: 'https://secret.test/?token=do-not-export' }, { line: 14, column: 2, url: 'do-not-export' });
  const r = d.capture(s, view, build), json = JSON.stringify(r);
  assert.doesNotMatch(json, /do-not-export|secret-name/); assert.equal(r.history.at(-1).data.name, 'Error'); assert.equal(r.history.at(-1).data.line, 14);
});

test('snapshot row and byte budgets preserve valid JSON and report omitted rosters', async () => {
  const s = fixture(), original = s.settlements[0].soldierRoster[0], d = createDebugRecorder();
  s.settlements[0].soldierRoster = Array.from({ length: 7000 }, (_, i) => ({ ...original, id: `large-${i}`, reason: 'x'.repeat(1000), order: { role: 'rally', objectiveId: 's1' } }));
  d.reset(s, view); const r = d.capture(s, view, build), file = await encodeDebugReport(r, { Compression: null });
  assert.ok(r.truncation.omitted.soldiers > 0); assert.ok(r.snapshot.soldiers.length <= DEBUG_LIMITS.soldiers);
  assert.ok(file.blob.size <= DEBUG_LIMITS.reportBytes); assert.ok(r.snapshot.soldiers.every(b => b.reason.length <= DEBUG_LIMITS.string));
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(r)));
});
