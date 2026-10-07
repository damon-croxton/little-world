// Browser-portable controlled module checks. These are not natural gameplay,
// rendered video, or performance evidence. The root harness owns browser I/O.
export async function combatTargetScenarios({ moduleRoot = '/src/' } = {}) {
  const [{ createSimulation }, { terrainAt }, { stepCombat, COMBAT_LIMITS }, { initializeMilitary, countMilitary },
    { occupySettlement }, { lineOfSight }, { emptyResources, initializeLedger, ledgerResidual, RESOURCES }] = await Promise.all([
    import(`${moduleRoot}sim/core.js`), import(`${moduleRoot}world.js`), import(`${moduleRoot}sim/combat.js`), import(`${moduleRoot}sim/military.js`),
    import(`${moduleRoot}sim/conquest.js`), import(`${moduleRoot}sim/navigation.js`), import(`${moduleRoot}sim/economy.js`),
  ]);
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const equal = (actual, expected, message) => check(JSON.stringify(actual) === JSON.stringify(expected), message);
  const point = (center, x = 0, z = 0) => ({ x: center.x + x, z: center.z + z });
  let ground;
  function fixture() {
    const s = createSimulation('combat-physical-contract', { civCount: 3 }); s.groups = []; s.nodes = []; s.events = [];
    for (const home of s.settlements) {
      home.buildings = []; home.assigned = {}; home.population = 300; home.homePresent = 300; home.availableWorkers = 300;
      home.stock = Object.fromEntries(RESOURCES.map(key => [key, 500])); initializeMilitary(home);
    }
    for (const a of s.factions) for (const b of s.factions) if (a !== b) a.relations[b.id] = { status: 'hostile', trust: 0 };
    if (!ground) outer: for (let z = -72; z < 72; z += 6) for (let x = -72; x < 72; x += 6) {
      const points = [];
      for (let dz = -10; dz <= 10; dz += 2) for (let dx = -10; dx <= 10; dx += 2) points.push({ x: x + dx, z: z + dz });
      if (points.every(p => terrainAt(p.x, p.z, s.seed).traversable) && lineOfSight(s, { x: x - 7, z }, { x: x + 7, z }, { fromHeight: .6, toHeight: .6 })) { ground = { x, z }; break outer; }
    }
    check(ground, 'Combat target fixture has no suitable seeded ground');
    const center = { ...ground };
    for (const [i, home] of s.settlements.entries()) Object.assign(home, point(center, 80 + i * 25, 60));
    initializeLedger(s);
    return { s, center, a: s.factions[0], b: s.factions[1], ha: s.settlements[0], hb: s.settlements[1], hc: s.settlements[2] };
  }
  function army(s, home, id, units, position) {
    home.military.infantry += units.infantry; home.military.ranged += units.ranged; home.soldiers = countMilitary(home.military); home.workers = home.population - home.soldiers;
    const size = countMilitary(units), g = { id, kind: 'army', factionId: home.factionId, originId: home.id, units: { ...units }, size, initialSize: size,
      ...position, prevX: position.x, prevZ: position.z, targetX: position.x, targetZ: position.z, targetId: null, phase: 'outbound', speed: 0,
      morale: 100, supply: 100, carrying: emptyResources() };
    s.groups.push(g); return g;
  }
  function pulse(s) { s.step++; s.time = s.step / 10; s.tick = Math.floor(s.time); stepCombat(s, .1); }
  const attacks = (s, sourceId) => s.combatEvents.filter(e => ['melee', 'projectile'].includes(e.type) && e.sourceId === sourceId);
  const cases = [];
  {
    const { s, center, ha, hb, a } = fixture();
    const farm = { id: 'captured-farm', kind: 'farm', ...point(center, 3), progress: 1, hp: 160 }; hb.buildings.push(farm);
    const g = army(s, ha, 'archers', { infantry: 0, ranged: 16 }, point(center, -4));
    pulse(s); const launched = s.pendingCombat.filter(hit => hit.targetId === farm.id).length;
    check(launched > 0, 'Capture fixture launched no structural projectiles');
    Object.assign(hb, point(center, 4)); check(occupySettlement(s, hb, g) && hb.occupiedBy === a.id, 'Capture fixture failed actual occupation');
    for (let i = 0; i < 12; i++) pulse(s);
    check(farm.hp === 160, `Captured structure took friendly damage: ${farm.hp}/160 HP`);
    check(!s.combatEvents.some(e => e.type === 'impact' && e.targetId === farm.id), 'Captured farm received an impact');
    cases.push({ name: 'capture cancels in-flight hostile structure damage', passed: true, evidence: { launchedOrders: launched, controllerId: hb.occupiedBy, nativeFactionId: hb.factionId, finalHp: farm.hp } });
  }
  {
    const { s, center, ha, hb, b } = fixture();
    const guard = army(s, ha, 'guard', { infantry: 12, ranged: 0 }, point(center, -1));
    const scout = { id: 'enemy-scout', kind: 'scout', factionId: b.id, originId: hb.id, size: 4, phase: 'outbound', ...point(center, 1),
      targetX: center.x + 20, targetZ: center.z, carrying: { ...emptyResources(), food: 2 }, observations: [{ id: 'unreported-place', x: 18, z: 22, kind: 'settlement', observedTick: 0 }] };
    s.groups.push(scout); initializeLedger(s);
    const before = structuredClone({ reports: b.knowledge, observations: scout.observations, cargo: scout.carrying, population: hb.population });
    for (let i = 0; i < 30 && scout.phase === 'outbound'; i++) pulse(s);
    check(scout.phase === 'returning' && scout.targetX === hb.x && scout.targetZ === hb.z, 'Physical scout contact failed to start homeward travel');
    check(scout.size === 4 && hb.population === before.population, 'Scout interception invented casualties');
    equal(scout.observations, before.observations, 'Scout interception changed carried observations');
    equal(b.knowledge, before.reports, 'Scout interception remotely delivered a report');
    equal(scout.carrying, before.cargo, 'Scout interception changed cargo');
    for (let i = 0; i < 30; i++) pulse(s);
    check(s.stats.scoutInterceptions === 1 && !guard.combat.active, 'Returning scout was repeatedly intercepted');
    const residual = ledgerResidual(s);
    for (const [key, value] of Object.entries(residual)) check(Math.abs(value) < 1e-7, `Scout interception broke the ${key} ledger`);
    cases.push({ name: 'scout contact preserves people, cargo and unreported observations', passed: true, evidence: { phase: scout.phase, crew: scout.size, interceptions: s.stats.scoutInterceptions, reportedRemotely: false, residual } });
  }
  {
    const { s, center, ha, hb, hc } = fixture();
    const main = army(s, ha, 'a-main', { infantry: 20, ranged: 20 }, center);
    const left = army(s, hb, 'b-left', { infantry: 12, ranged: 0 }, point(center, -3));
    const right = army(s, hc, 'c-right', { infantry: 12, ranged: 0 }, point(center, 3));
    pulse(s); const fired = attacks(s, main.id), targetIds = [...new Set(fired.map(e => e.targetId))];
    check(targetIds.includes(left.id) && targetIds.includes(right.id), 'One mixed army could not fire at two local hostile factions in one pulse');
    const counts = {};
    for (const role of ['infantry', 'ranged']) {
      const indices = fired.filter(e => e.role === role).flatMap(e => e.shots.map(p => p.sourceIndex));
      check(new Set(indices).size === indices.length, `A ${role} soldier attacked multiple targets within one cooldown`);
      check(indices.length <= (role === 'infantry' ? COMBAT_LIMITS.infantryFrontage : COMBAT_LIMITS.rangedFrontage), `${role} exceeded its total frontage budget`);
      counts[role] = indices.length;
    }
    check(main.combat.localTargetIds.length <= COMBAT_LIMITS.localTargets, 'Local target list exceeded its bound');
    cases.push({ name: 'one mixed force fires at two hostile factions simultaneously', passed: true, evidence: { targetIds, counts, primaryTargetId: main.combat.targetId, localTargetIds: main.combat.localTargetIds } });
  }
  {
    const { s, center, ha, hb, hc } = fixture(); Object.assign(ha, center); initializeMilitary(ha, { infantry: 16, ranged: 16 });
    const left = army(s, hb, 'b-left', { infantry: 14, ranged: 14 }, point(center, -3));
    const right = army(s, hc, 'c-right', { infantry: 14, ranged: 14 }, point(center, 3));
    pulse(s); const targetIds = [...new Set(attacks(s, ha.id).map(e => e.targetId))];
    check(left.combat.targetId === right.id && right.combat.targetId === left.id, 'Garrison fixture did not create independent field combat');
    check(ha.combat.active && targetIds.includes(left.id) && targetIds.includes(right.id), 'Garrison waited for its settlement to be the primary target or ignored a local attacker');
    cases.push({ name: 'garrison responds independently to multiple local armies', passed: true, evidence: { targetIds, primaryTargetId: ha.combat.targetId, localTargetIds: ha.combat.localTargetIds } });
  }
  return { passed: true, kind: 'controlled-module-scenarios', cases };
}
