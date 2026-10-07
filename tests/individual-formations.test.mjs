import { setMilitary, bindArmy } from './roster-fixtures.mjs';
import { applySoldierDamage } from '../src/sim/soldiers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { terrainAt } from '../src/world.js';
import { combatFormationSlot, updateCombatFormation } from '../src/sim/formations.js';
import { isSegmentTraversable, lineOfSight, navigationDiagnostics, invalidateNavigation, moveAlongRoute } from '../src/sim/navigation.js';

const seed = 'combat-physical-contract';
let ground;
function fixture() {
  const s = { seed, step: 0, tick: 0, time: 0, groups: [], settlements: [], factions: [
    { id: 'a', species: 'human', relations: { b: { status: 'hostile' } } },
    { id: 'b', species: 'human', relations: { a: { status: 'hostile' } } },
  ] };
  if (!ground) outer: for (let z = -72; z <= 72; z += 6) for (let x = -72; x <= 72; x += 6) {
    let clear = true;
    for (let dz = -11; dz <= 11 && clear; dz += 1) for (let dx = -11; dx <= 11; dx += 1) if (!terrainAt(x + dx, z + dz, seed).traversable) { clear = false; break; }
    if (clear && lineOfSight(s, { x: x - 9, z }, { x: x + 9, z }, { fromHeight: .6, toHeight: .6 })) { ground = { x, z }; break outer; }
  }
  assert.ok(ground); return { s, center: { ...ground } };
}
function army(s, center, id, factionId, units, offset = 0, yaw = Math.PI / 2) {
  const home = { id: `${id}-home`, factionId, population: 300, x: center.x + offset, z: center.z, assigned: {} };
  s.settlements.push(home); setMilitary(s, home, units);
  const group = { id, originId: home.id, kind: 'army', factionId, units, size: units.infantry + units.ranged, x: center.x + offset, z: center.z, speed: 3, combat: { active: true, yaw } };
  bindArmy(s, home, group); s.groups.push(group); updateCombatFormation(s, group, units, 0, { yaw }); return group;
}
const slots = entity => Object.values(entity.formationSlots).flat();
function descriptor(entity) { return { id: entity.id, kind: 'group', x: entity.x, z: entity.z, units: entity.units, entity }; }
function pulse(s, entries) {
  s.step++; s.time = s.step / 10; s.tick = Math.floor(s.time);
  for (const [entity, target] of entries) updateCombatFormation(s, entity, entity.units, .1, target ? { contact: true, primaryTargetId: target.id, localTargets: [descriptor(target)] } : {});
}
function minimumSpacing(groups, alpha = 1) {
  const points = groups.flatMap(group => Array.from({ length: group.size }, (_, i) => combatFormationSlot(group, i, { alpha })));
  let minimum = Infinity;
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) minimum = Math.min(minimum, Math.hypot(points[i].x - points[j].x, points[i].z - points[j].z));
  return minimum;
}

test('opposing physical soldiers loosen into reachable contact without body or interpolation overlap', t => {
  const { s, center } = fixture();
  const a = army(s, center, 'a', 'a', { infantry: 30, ranged: 8 }, -3.4);
  const b = army(s, center, 'b', 'b', { infantry: 30, ranged: 8 }, 3.4, -Math.PI / 2);
  const before = slots(a).map(p => ({ x: p.x, z: p.z }));
  let minimum = Infinity, maximumStep = 0;
  const start = performance.now();
  for (let step = 0; step < 80; step++) {
    pulse(s, [[a, b], [b, a]]);
    for (const alpha of [0, .25, .5, .75, 1]) minimum = Math.min(minimum, minimumSpacing([a, b], alpha));
    for (const group of [a, b]) for (const body of slots(group)) {
      maximumStep = Math.max(maximumStep, Math.hypot(body.x - body.prevX, body.z - body.prevZ));
      assert.ok(isSegmentTraversable(s, { x: body.prevX, z: body.prevZ }, body, { factionId: group.factionId, radius: .15 }));
    }
  }
  const elapsed = performance.now() - start;
  assert.ok(minimum >= .46 - 1e-7, `physical spacing ${minimum}`);
  assert.ok(maximumStep <= .5, `unbounded body speed ${maximumStep}`);
  const displaced = slots(a).filter((p, i) => Math.hypot(p.x - before[i].x, p.z - before[i].z) > .5);
  assert.ok(displaced.length > 12, 'only the old square formation moved');
  const deviations = slots(a).map((p, i) => { const rank = combatFormationSlot(a, i, { physical: false }); return Math.hypot(p.x - rank.x, p.z - rank.z); });
  assert.ok(deviations.filter(d => d > .5).length > 12, 'contact remained locked to the square formation');
  const reachable = a.formationSlots.infantry.filter(p => b.formationSlots.infantry.some(q => Math.hypot(p.x - q.x, p.z - q.z) <= 1.8 && isSegmentTraversable(s, p, q, { factionId: a.factionId, radius: .08 }) && lineOfSight(s, p, q, { fromHeight: .7, toHeight: .65 })));
  assert.ok(reachable.length >= 10, `only ${reachable.length} infantry reached melee positions`);
  assert.equal(navigationDiagnostics(s).searches, 0, 'individual soldiers ran global route searches');
  t.diagnostic(`76 soldiers / 80 contact pulses including exhaustive overlap checks: ${elapsed.toFixed(1)}ms; spacing ${minimum.toFixed(3)}; melee reachable ${reachable.length}/30`);
});

test('allied armies share physical spacing during overlapping deployment and crossing orders', () => {
  const { s, center } = fixture();
  const a = army(s, center, 'allied-a', 'a', { infantry: 20, ranged: 0 }, -.5);
  const b = army(s, center, 'allied-b', 'a', { infantry: 20, ranged: 0 }, .5, -Math.PI / 2);
  assert.ok(minimumSpacing([a, b]) >= .46 - 1e-7);
  for (let i = 0; i < 70; i++) {
    a.x += .035; b.x -= .035; pulse(s, [[a], [b]]);
    for (const alpha of [.25, .5, .75, 1]) assert.ok(minimumSpacing([a, b], alpha) >= .46 - 1e-7, `crossing overlap at ${i}/${alpha}`);
  }
});

test('ranged soldiers independently back away into a clear firing band and settle there', () => {
  const { s, center } = fixture();
  const a = army(s, center, 'ranged', 'a', { infantry: 0, ranged: 12 }, -3);
  const b = army(s, center, 'targets', 'b', { infantry: 6, ranged: 0 }, 1, -Math.PI / 2);
  const initial = a.formationSlots.ranged.reduce((n, p) => n + p.x, 0) / 12;
  for (let i = 0; i < 90; i++) pulse(s, [[a, b]]);
  const final = a.formationSlots.ranged.reduce((n, p) => n + p.x, 0) / 12;
  assert.ok(final < initial - 1, 'archers advanced into melee instead of obtaining stand-off');
  for (const body of a.formationSlots.ranged) {
    const nearest = Math.min(...b.formationSlots.infantry.map(p => Math.hypot(body.x - p.x, body.z - p.z)));
    assert.ok(nearest >= 9 * .59 - .02 && nearest <= 9 * .91, `ranged distance ${nearest}`);
    assert.ok(Math.hypot(body.x - body.prevX, body.z - body.prevZ) < .035, 'stable firing position kept jittering');
  }
});

test('contact movement cannot cross an enemy wall or claim unreachable melee through it', () => {
  const { s, center } = fixture();
  s.walls = [{ id: 'barrier', kind: 'wall', factionId: 'b', from: { x: center.x, z: center.z - 10 }, to: { x: center.x, z: center.z + 10 }, width: 1, hp: 400, progress: 1 }];
  invalidateNavigation(s);
  const a = army(s, center, 'blocked', 'a', { infantry: 18, ranged: 0 }, -2.5);
  const b = army(s, center, 'defenders', 'b', { infantry: 12, ranged: 0 }, 2.5, -Math.PI / 2);
  for (let i = 0; i < 70; i++) {
    pulse(s, [[a, b], [b, a]]);
    for (const p of slots(a)) { assert.ok(p.x < center.x - .65); assert.ok(isSegmentTraversable(s, { x: p.prevX, z: p.prevZ }, p, { factionId: a.factionId, radius: .15 })); }
    for (const p of slots(b)) assert.ok(p.x > center.x + .65);
  }
  assert.ok(minimumSpacing([a, b]) >= .46 - 1e-7);
  assert.equal(navigationDiagnostics(s).searches, 0);
});

test('physical slots are deterministic, pause-frozen, and preserve survivor identity and interpolation after casualties', () => {
  function run() {
    const { s, center } = fixture();
    const a = army(s, center, 'a', 'a', { infantry: 12, ranged: 4 }, -2.6);
    const b = army(s, center, 'b', 'b', { infantry: 12, ranged: 4 }, 2.6, -Math.PI / 2);
    for (let i = 0; i < 35; i++) pulse(s, [[a, b], [b, a]]);
    const before = structuredClone(a);
    updateCombatFormation(s, a, a.units, 0, { contact: true, localTargets: [descriptor(b)] });
    assert.deepEqual(a, before, 'paused movement mutated its saved interpolation');
    const survivor = a.formationSlots.ranged[0];
    for (const body of a.formationSlots.infantry.slice(0, 2)) applySoldierDamage(s, body.id, body.hp);
    pulse(s, [[a, b], [b, a]]);
    assert.equal(a.formationSlots.infantry.length, 10); assert.equal(a.formationSlots.ranged[0], survivor);
    const rendered = combatFormationSlot(a, 10, { alpha: .5 });
    assert.equal(rendered.role, 'ranged'); assert.equal(rendered.x, (survivor.prevX + survivor.x) * .5); assert.equal(rendered.z, (survivor.prevZ + survivor.z) * .5);
    assert.equal(rendered.movementDistance, Math.hypot(survivor.x - survivor.prevX, survivor.z - survivor.prevZ));
    return s;
  }
  assert.deepEqual(run(), run());
});

test('a squad files its physical flanks through a friendly gate using its shared route', () => {
  const { s, center } = fixture();
  s.walls = [{ id: 'gate', kind: 'gate', factionId: 'a', from: { x: center.x, z: center.z - 10 }, to: { x: center.x, z: center.z + 10 }, gateWidth: 2, width: 1, hp: 400, progress: 1 }];
  invalidateNavigation(s);
  const a = army(s, center, 'gate-march', 'a', { infantry: 18, ranged: 4 }, -5);
  const goal = { x: center.x + 5, z: center.z };
  for (let i = 0; i < 180; i++) {
    s.step++; s.time = s.step / 10;
    moveAlongRoute(s, a, goal, { factionId: 'a', dt: .1, speed: 2.5, arrival: .1 });
    updateCombatFormation(s, a, a.units, .1, { yaw: Math.PI / 2 });
    for (const p of slots(a)) assert.ok(isSegmentTraversable(s, { x: p.prevX, z: p.prevZ }, p, { factionId: 'a', radius: .15 }));
    assert.ok(minimumSpacing([a]) >= .46 - 1e-7);
  }
  const crossed = slots(a).filter(p => p.x > center.x + .66).length;
  assert.equal(crossed, a.size, `only ${crossed}/${a.size} physical soldiers followed their center through the gate`);
});

test('larger contact formations keep movement work bounded without individual global routes', t => {
  const { s, center } = fixture();
  const a = army(s, center, 'large-a', 'a', { infantry: 80, ranged: 40 }, -4.5);
  const b = army(s, center, 'large-b', 'b', { infantry: 80, ranged: 40 }, 4.5, -Math.PI / 2);
  const started = performance.now();
  for (let i = 0; i < 60; i++) pulse(s, [[a, b], [b, a]]);
  const elapsed = performance.now() - started;
  assert.equal(navigationDiagnostics(s).searches, 0);
  assert.equal(slots(a).length + slots(b).length, 240);
  assert.ok(minimumSpacing([a, b]) >= .46 - 1e-7);
  // Record actual work time without a flaky machine-speed assertion.
  t.diagnostic(`240 real soldiers / 60 contact pulses: ${elapsed.toFixed(1)}ms (${(elapsed / 60).toFixed(2)}ms/pulse), no per-soldier global route searches`);
});
