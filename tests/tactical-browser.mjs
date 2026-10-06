// Controlled tactical fixtures in the actual browser V8 runtime. These are
// simulation/module checks, not natural-world or rendered-battle video evidence.
// Importing this file does not launch a browser. Run only with the exclusive QA slot.
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { configuration, launch } from './browser-v2.mjs';

export async function controlledScenarios({ moduleRoot = '/src/' } = {}) {
  const [{ createSimulation, stepSimulation, getSummary }, { terrainAt }, combat, formation, navigation, military, economy, strategy, defenses, knowledge] = await Promise.all([
    import(`${moduleRoot}sim/core.js`), import(`${moduleRoot}world.js`), import(`${moduleRoot}sim/combat.js`),
    import(`${moduleRoot}sim/formations.js`), import(`${moduleRoot}sim/navigation.js`), import(`${moduleRoot}sim/military.js`),
    import(`${moduleRoot}sim/economy.js`), import(`${moduleRoot}sim/strategy.js`), import(`${moduleRoot}sim/defenses.js`), import(`${moduleRoot}sim/knowledge.js`),
  ]);
  const { stepCombat } = combat, { updateCombatFormation, combatFormationSlot } = formation;
  const { isSegmentTraversable, lineOfSight, invalidateNavigation, assessBreachRoute, findPath, moveAlongRoute, navigationDiagnostics } = navigation;
  const { initializeMilitary, countMilitary, unitStats, queueTraining, advanceTraining } = military;
  const { emptyResources, initializeLedger, ledgerResidual, RESOURCES } = economy;
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const equal = (a, b, message) => check(JSON.stringify(a) === JSON.stringify(b), message);
  const near = (a, b, message, epsilon = 1e-7) => check(Math.abs(a - b) <= epsilon, `${message}: ${a} versus ${b}`);
  const plain = value => JSON.parse(JSON.stringify(value));
  const point = (center, x = 0, z = 0) => ({ x: center.x + x, z: center.z + z });
  const seed = 'combat-physical-contract'; let ground;
  function findGround(s) {
    if (ground) return { ...ground };
    outer: for (let z = -72; z <= 72; z += 6) for (let x = -72; x <= 72; x += 6) {
      let clear = true;
      for (let dz = -11; dz <= 11 && clear; dz++) for (let dx = -11; dx <= 11; dx++) if (!terrainAt(x + dx, z + dz, seed).traversable) { clear = false; break; }
      if (clear && lineOfSight(s, { x: x - 9, z }, { x: x + 9, z }, { fromHeight: .6, toHeight: .6 })) { ground = { x, z }; break outer; }
    }
    check(ground, 'Seed has no qualifying physical fixture ground'); return { ...ground };
  }
  function fixture() {
    const s = createSimulation(seed, { civCount: 3 }); s.groups = []; s.nodes = []; s.events = [];
    for (const home of s.settlements) {
      home.buildings = []; home.assigned = {}; home.population = 300; home.homePresent = 300; home.availableWorkers = 300;
      home.stock = Object.fromEntries(RESOURCES.map(key => [key, 500])); initializeMilitary(home);
    }
    const [a, b] = s.factions;
    a.relations[b.id] = { status: 'hostile', trust: 0 }; b.relations[a.id] = { status: 'hostile', trust: 0 };
    const center = findGround(s);
    for (const [i, home] of s.settlements.entries()) Object.assign(home, point(center, 80 + i * 25, 60));
    initializeLedger(s); return { s, center, a, b, ha: s.settlements[0], hb: s.settlements[1] };
  }
  function army(s, home, id, size, position, extras = {}) {
    const units = extras.units || { infantry: size, ranged: 0 };
    home.military.infantry += units.infantry; home.military.ranged += units.ranged;
    home.soldiers = countMilitary(home.military); home.workers = home.population - home.soldiers;
    const g = { id, kind: 'army', factionId: home.factionId, originId: home.id, units: { ...units }, size, initialSize: size,
      ...position, prevX: position.x, prevZ: position.z, targetX: position.x, targetZ: position.z, targetId: null,
      phase: 'outbound', speed: 0, morale: 100, supply: 100, carrying: emptyResources(), ...extras };
    s.groups.push(g); return g;
  }
  function pulse(s, strategic = false) {
    s.step++; s.time = s.step / 10; s.tick = Math.floor(s.time);
    for (const f of s.factions) { f.lastScout = s.tick; f.lastArmy = s.tick; }
    if (strategic) strategy.stepStrategy(s, .1); else stepCombat(s, .1);
  }
  function conserved(s) { const residual = ledgerResidual(s); for (const [key, value] of Object.entries(residual)) near(value, 0, `${key} ledger residual`); return residual; }
  const cases = [];
  async function scenario(name, run) {
    const started = performance.now();
    try { cases.push({ name, passed: true, evidence: await run(), elapsedMs: performance.now() - started }); }
    catch (error) { cases.push({ name, passed: false, error: String(error.stack || error), elapsedMs: performance.now() - started }); }
  }

  await scenario('visible defenders interrupt worker and production raids', () => {
    return ['worker', 'structure'].map(kind => {
      const { s, center, ha, hb } = fixture(), raider = army(s, ha, 'a-raider', 30, point(center, -3));
      const target = kind === 'worker' ? { id: 'exposed-crew', kind, factionId: hb.factionId, originId: hb.id, size: 8, phase: 'working', ...point(center, 4), carrying: { ...emptyResources(), food: 20 } }
        : { id: 'exposed-farm', kind: 'farm', ...point(center, 4), progress: 1, hp: 160 };
      (kind === 'worker' ? s.groups : hb.buildings).push(target);
      pulse(s); check(raider.combat.targetId === target.id, `Did not initially select exposed ${kind}`);
      check(raider.combat.decisionUntil > s.time, 'Initial raid had no commitment window');
      const before = plain(raider.combat), defender = army(s, hb, 'b-defender', 25, point(center, 1, -2));
      pulse(s);
      check(raider.combat.targetId === defender.id && raider.combat.intent === 'intercept', `Defender failed to interrupt ${kind}`);
      check(/interrupting/.test(raider.combat.reason), 'Interruption lacks an explicit reason');
      check(!s.combatEvents.some(hit => hit.sourceId === raider.id && hit.targetId === target.id && hit.time === s.time && ['melee', 'projectile'].includes(hit.type)), 'New strike targeted the interrupted economic objective');
      return { kind, before, after: plain(raider.combat), step: s.step };
    });
  });

  await scenario('near-side defender immediately interrupts a real useful breach', () => {
    const { s, center, ha, hb } = fixture(); Object.assign(hb, point(center, 4));
    const wall = { id: 'useful-wall', kind: 'wall', ...center, rotation: Math.PI / 2, length: 20, width: 1, progress: 1, hp: 240, wallHeight: 4 };
    hb.buildings.push(wall); invalidateNavigation(s);
    const g = army(s, ha, 'a-breacher', 30, point(center, -1.8), { targetId: hb.id, targetX: hb.x, targetZ: hb.z });
    pulse(s); check(g.combat.targetId === wall.id && g.combat.intent === 'breach', 'Actual combat did not choose useful wall breach');
    const before = plain(g.combat), existingWallStrikes = s.pendingCombat.filter(p => p.targetId === wall.id).map(p => p.id);
    check(existingWallStrikes.length > 0, 'Breach decision produced no physical attack');
    check(before.routeDecision.savedSeconds == null || Number.isFinite(before.routeDecision.savedSeconds), 'Nonfinite route saving leaked into combat state');
    const defender = army(s, hb, 'b-defender', 25, point(center, -4, -3)); pulse(s);
    check(g.combat.targetId === defender.id && g.combat.intent === 'intercept', 'Defender failed to interrupt wall breach');
    check(s.pendingCombat.filter(p => p.targetId === wall.id).every(p => existingWallStrikes.includes(p.id)), 'Wall received fresh damage orders after interruption');
    return { before, after: plain(g.combat), existingWallStrikes, wallHp: wall.hp };
  });

  await scenario('severe local disadvantage commits to retreat', () => {
    const { s, center, ha, hb } = fixture(), small = army(s, ha, 'a-small', 12, point(center, -3));
    army(s, hb, 'b-large', 70, point(center, 3)); pulse(s);
    check(small.phase === 'retreating' && small.combat.intent === 'retreat' && small.combat.strengthRatio < .43, 'Severe visible disadvantage failed to trigger retreat');
    const decision = plain(small.combat); let launches = 0;
    for (let i = 0; i < 50; i++) {
      pulse(s); check(small.phase === 'retreating', 'Retreat re-engaged during its commitment');
      launches += s.combatEvents.filter(e => e.time === s.time && ['melee', 'projectile'].includes(e.type) && e.sourceId === small.id).length;
    }
    check(s.stats.retreats === 1 && launches === 0, 'Retreat looped or launched an attack');
    return { decision, observedPulses: 51, retreats: s.stats.retreats, launches, finalPhase: small.phase };
  });

  await scenario('visible local support changes commitment; remote support does not', () => {
    const run = nearby => {
      const { s, center, ha, hb } = fixture(), small = army(s, ha, 'a-small', 12, point(center, -3));
      army(s, hb, 'b-enemy', 60, point(center, 3)); army(s, ha, 'c-support', 65, point(center, nearby ? -5 : -55, -2));
      pulse(s); return { phase: small.phase, combat: plain(small.combat) };
    };
    const nearSupport = run(true), remoteSupport = run(false);
    check(nearSupport.phase === 'engaging' && nearSupport.combat.supportStrength > 20, 'Reachable visible support was not counted');
    check(remoteSupport.phase === 'retreating' && remoteSupport.combat.supportStrength === 0, 'Remote support affected the local decision');
    return { nearSupport, remoteSupport };
  });

  await scenario('worker raid respects real carrying capacity and conserves intact workforce', () => {
    const { s, center, ha, hb } = fixture(), raider = army(s, ha, 'a-raider', 12, point(center, -1));
    raider.carrying.materials = 10;
    const worker = { id: 'loaded-crew', kind: 'worker', factionId: hb.factionId, originId: hb.id, size: 8, phase: 'working', ...point(center, 1), carrying: { ...emptyResources(), food: 40 }, capacity: 48 };
    s.groups.push(worker); initializeLedger(s);
    const before = { population: hb.population, workers: hb.workers, size: worker.size, cargo: plain(worker.carrying) };
    for (let i = 0; i < 30 && !s.stats.workerRaids; i++) pulse(s);
    check(s.stats.workerRaids === 1 && worker.phase === 'returning' && worker.targetX === hb.x && worker.targetZ === hb.z, 'Raided crew did not return home');
    equal({ population: hb.population, workers: hb.workers, size: worker.size }, { population: before.population, workers: before.workers, size: before.size }, 'Raid changed the actual workforce');
    near(raider.carrying.food, 4.4, 'Raid exceeded or ignored remaining cargo capacity'); near(worker.carrying.food, 35.6, 'Worker cargo transfer mismatch');
    for (let i = 0; i < 20; i++) pulse(s);
    check(s.stats.workerRaids === 1, 'Cooldown allowed repeat raids on the same crew');
    return { before, attackerCargo: plain(raider.carrying), workerCargo: plain(worker.carrying), phase: worker.phase, workerRaids: s.stats.workerRaids, residual: conserved(s) };
  });

  await scenario('production building takes delayed impact and cancels destroyed training', () => {
    const { s, center, ha, hb, b } = fixture();
    const building = { id: 'exposed-producer', kind: unitStats(b.species, 'infantry').building, ...point(center, 1.5), progress: 1, hp: 30, maxHp: 30 };
    hb.buildings.push(building); army(s, ha, 'a-raider', 18, point(center, -1)); initializeLedger(s);
    check(queueTraining(s, hb, b, 'infantry', 3), 'Fixture could not pay for real training');
    const population = hb.population, paidStock = plain(hb.stock); pulse(s);
    check(building.hp === 30, 'Damage preceded the physical impact');
    for (let i = 0; i < 60 && !building.destroyed; i++) pulse(s);
    check(building.destroyed && building.hp === 0 && s.stats.structuresDestroyed === 1, 'Bounded raid failed to destroy exposed production');
    check(s.combatEvents.some(e => e.type === 'collapse' && e.targetId === building.id), 'No collapse matched destruction');
    advanceTraining(s, hb, b);
    check(hb.trainingQueue.length === 0 && hb.soldiers === 0 && hb.population === population, 'Destroyed training produced soldiers or lost citizens');
    equal(hb.stock, paidStock, 'Destroyed course refunded or charged supplies again');
    return { destroyedAt: s.time, hp: building.hp, trainingQueue: hb.trainingQueue, soldiers: hb.soldiers, population, residual: conserved(s) };
  });

  await scenario('new defenders interrupt settlement pressure before strategic raid', () => {
    const { s, center, ha, hb } = fixture(); Object.assign(hb, point(center, 2));
    const g = army(s, ha, 'a-raider', 40, center, { targetId: hb.id, targetX: hb.x, targetZ: hb.z, engagedDays: 4 });
    pulse(s); check(g.combat.targetKind === 'settlement', 'Fixture did not apply initial settlement pressure');
    army(s, hb, 'b-relief', 40, point(center, -2, 2), { targetId: ha.id, targetX: ha.x, targetZ: ha.z });
    s.step = 9; s.time = .9; const health = hb.health, stock = plain(hb.stock); pulse(s, true);
    check(g.combat.targetKind === 'group' && g.engagedDays === 4 && hb.health === health, 'Strategic raid continued after local defenders arrived');
    equal(hb.stock, stock, 'Interrupted settlement raid still stole supplies');
    return { targetId: g.combat.targetId, targetKind: g.combat.targetKind, engagedDays: g.engagedDays, health, stock };
  });

  await scenario('hidden enemy census, training, buildings and remote force leave tactics invariant', () => {
    const { s, center, ha, hb } = fixture();
    army(s, ha, 'a-main', 30, point(center, -3)); army(s, hb, 'b-contact', 25, point(center, 3));
    const alternate = structuredClone(s), remote = alternate.settlements.find(p => p.id === hb.id);
    remote.population = 800; remote.military = { infantry: 650, ranged: 100 }; remote.soldiers = 750;
    remote.buildings.push({ id: 'secret-farm', kind: 'farm', x: remote.x, z: remote.z, progress: 1, hp: 160 });
    remote.trainingQueue = [{ id: 'secret-course', role: 'ranged', size: 40 }];
    army(alternate, remote, 'secret-force', 60, point(center, 60, 60));
    const knowledge = plain(s.factions[0].knowledge);
    for (let i = 0; i < 20; i++) {
      pulse(s); pulse(alternate);
      equal(alternate.groups[0].combat, s.groups[0].combat, `Hidden state changed combat at pulse ${i + 1}`);
      equal(alternate.groups[0].formationSlots, s.groups[0].formationSlots, `Hidden state changed physical formation at pulse ${i + 1}`);
    }
    equal(s.factions[0].knowledge, knowledge, 'Local contact delivered instant strategic intelligence');
    return { comparedPulses: 20, finalCombat: plain(s.groups[0].combat), knowledgeUnchanged: true };
  });

  function routeFixture() {
    const owner = { id: 'owner', species: 'human', relations: {}, traits: { aggression: .3 }, knowledge: {} };
    const enemy = { id: 'enemy', relations: {} }, ally = { id: 'ally', relations: { owner: { status: 'allied' } } };
    const home = { id: 'town', factionId: owner.id, x: -78, z: -120, population: 400, health: 100, wellbeing: 1, shortageDays: 0, military: { ranged: 9 }, buildings: [], status: 'town' };
    owner.knowledge.materials = { id: 'materials', kind: 'resource', resourceKind: 'materials', x: home.x + 30, z: home.z, amountEstimate: 1000, richnessEstimate: 1, observedTick: 100, reportedTick: 100 };
    return { state: { seed: 'joined-screen', step: 1000, tick: 100, time: 100, factions: [owner, enemy, ally], settlements: [home], groups: [], walls: [] }, home, owner };
  }
  const standingWall = (id, x, z, length, hp = 300) => ({ id, factionId: 'enemy', kind: 'wall', x, z, rotation: Math.PI / 2, length, width: 1, hp, maxHp: hp, progress: 1 });

  function auditFixture() {
    const s = createSimulation('joined-screen', { civCount: 3 }); s.groups = []; s.nodes = []; s.events = [];
    for (const [i, home] of s.settlements.entries()) {
      home.buildings = []; home.assigned = {}; home.population = 300; home.homePresent = 300;
      home.x = 80 + i * 25; home.z = 80; initializeMilitary(home);
    }
    const [a, b] = s.factions, [ha, hb] = s.settlements;
    a.relations[b.id] = { status: 'hostile', trust: 0 }; b.relations[a.id] = { status: 'hostile', trust: 0 };
    return { s, a, b, ha, hb, center: { x: -60, z: -120 } };
  }
  function enclosure(center, hp) {
    const corners = [[-4, -4], [4, -4], [4, 4], [-4, 4]].map(([x, z]) => point(center, x, z));
    return corners.map((from, i) => { const to = corners[(i + 1) % 4]; return { id: `enclosure-${i}`, kind: 'wall', from, to, x: (from.x + to.x) / 2, z: (from.z + to.z) / 2, width: 1, hp, maxHp: hp, progress: 1 }; });
  }

  await scenario('unseen enemy walls cannot cancel mobilization from a delivered report', () => {
    const { s, a, b, ha, hb } = auditFixture(); s.tick = 400; s.step = 4000; s.time = 400;
    for (const f of s.factions) { f.lastScout = 400; f.lastArmy = 400; }
    a.lastArmy = 0; a.traits.aggression = .9; a.traits.cooperation = .1;
    Object.assign(ha, { x: -78, z: -120, population: 400, availableWorkers: 200 }); initializeMilitary(ha, { infantry: 120, ranged: 0 });
    Object.assign(hb, { x: -30, z: -120 }); for (const key of Object.keys(ha.stock)) ha.stock[key] = 500;
    a.knowledge = { [hb.id]: { id: hb.id, kind: 'settlement', ownerId: b.id, x: hb.x, z: hb.z, observedTick: 390, reportedTick: 395,
      confidence: .9, status: 'active', populationEstimate: 100, soldiersEstimate: 20, healthEstimate: 100 } };
    const alternate = structuredClone(s), enemyHome = alternate.settlements.find(h => h.id === hb.id);
    enemyHome.buildings = enclosure(hb, 200);
    check(enemyHome.buildings.every(wall => !knowledge.visibleToGroup(alternate, ha, wall)), 'The unseen-wall fixture is actually visible');
    strategy.stepStrategy(s, 0); strategy.stepStrategy(alternate, 0);
    const deployed = state => state.groups.find(g => g.kind === 'army' && g.factionId === a.id);
    check(deployed(s), `Control report did not mobilize: ${s.factions[0].intent}`);
    check(deployed(alternate), `Unseen wall prevented dispatch: ${alternate.factions[0].intent}`);
    equal(deployed(alternate), deployed(s), 'Hidden construction changed the report-based expedition');
    return { ordinary: plain(deployed(s)), hiddenWalls: enemyHome.buildings.length, exactExpeditionEquality: true };
  });

  await scenario('sealed visible route can choose breach without nonfinite authoritative state', () => {
    const { s, a, ha, hb, center } = auditFixture(), walls = enclosure(center, 20);
    hb.buildings.push(...walls); invalidateNavigation(s);
    const g = army(s, ha, 'a-sealed', 4, center, { targetX: center.x + 14, targetZ: center.z });
    const assessment = assessBreachRoute(s, g, { x: g.targetX, z: g.targetZ }, walls.map(building => ({ building, home: hb })), { factionId: a.id, speed: 2.8, breachDps: 100, maxExpansions: 500 });
    check(assessment.action === 'breach' && !assessment.route.reachable && assessment.expansions <= 2000, 'Sealed route did not select a bounded useful breach');
    pulse(s); check(g.combat.routeDecision.action === 'breach' && g.combat.intent === 'breach', 'Actual combat did not adopt sealed-route breach');
    const finite = (value, location = 'state') => {
      if (typeof value === 'number') check(Number.isFinite(value), `Nonfinite authoritative ${location}`);
      if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) finite(child, `${location}.${key}`);
    };
    finite(s);
    return { routeDecision: plain(g.combat.routeDecision), intent: g.combat.intent, boundedExpansions: assessment.expansions, authoritativeStateFinite: true };
  });

  await scenario('unobserved enemy morale, supply and technology do not alter visible strength estimate', () => {
    const { s, center, ha, hb } = fixture();
    army(s, ha, 'a-main', 30, point(center, -3)); army(s, hb, 'b-visible', 25, point(center, 3));
    const alternate = structuredClone(s), enemy = alternate.factions.find(f => f.id === hb.factionId);
    alternate.groups[1].morale = 48; alternate.groups[1].supply = 24;
    enemy.tech.level += 8; enemy.modifiers.damage = 4; enemy.modifiers.defense = 4;
    pulse(s); pulse(alternate);
    const decision = g => ({ targetId: g.combat.targetId, intent: g.combat.intent, enemyStrength: g.combat.enemyStrength, strengthRatio: g.combat.strengthRatio });
    const ordinary = decision(s.groups[0]), secretChanges = decision(alternate.groups[0]);
    equal(ordinary, secretChanges, 'Enemy hidden field state changed the local visible-strength estimate');
    return { ordinary, secretChanges };
  });

  await scenario('useful breach wins over detour only when obstruction and cost justify it', () => {
    const { state, home } = routeFixture(), center = point(home, 18), from = point(center, -4), goal = point(center, 10);
    const wall = standingWall('barrier', center.x, center.z, 4, 1), options = { factionId: 'owner', speed: 2.8, breachDps: 100 };
    const small = assessBreachRoute(state, from, goal, [wall], options); check(small.action === 'detour', 'Tiny obstacle invited needless destruction');
    wall.length = 40; wall.hp = 30;
    const weak = plain(assessBreachRoute(state, from, goal, [wall], options));
    check(weak.action === 'breach' && weak.wallId === wall.id && weak.savedSeconds >= 3 && weak.detourLength > weak.breachLength * 1.22, 'Useful weak barrier failed costed breach');
    check(weak.expansions <= 2048 && weak.assessedCandidates === 1, 'Breach search exceeded its bound');
    wall.hp = 3000; const durable = assessBreachRoute(state, from, goal, [wall], options); check(durable.action === 'detour', 'Durability cost was ignored');
    wall.hp = 1; wall.factionId = 'owner'; const friendly = assessBreachRoute(state, from, goal, [wall], options); check(friendly.action === 'detour', 'Friendly wall selected for destruction');
    return { small: plain(small), weak: plain(weak), durable: plain(durable), friendly: plain(friendly) };
  });

  await scenario('hidden geometry cannot select a breach; physical collision still blocks it', () => {
    const { state, home } = routeFixture(), from = point(home, 8), goal = point(home, 30);
    const unrelated = standingWall('off-route', home.x + 15, home.z + 10, 4, 1), hidden = standingWall('unseen', home.x + 20, home.z, 40, 1);
    const options = { factionId: 'owner', speed: 3, breachDps: 100 }, before = assessBreachRoute(state, from, goal, [unrelated], options);
    state.walls.push(hidden); invalidateNavigation(state);
    equal(assessBreachRoute(state, from, goal, [unrelated], options), before, 'Hidden obstacle changed a tactical route decision');
    check(before.action === 'advance' && before.wallId === null && !isSegmentTraversable(state, from, goal, { factionId: 'owner' }), 'Knowledge or physical collision contract failed');
    const bounded = assessBreachRoute(state, from, goal, [hidden, unrelated], { ...options, maxExpansions: 1 });
    check(bounded.action === 'unreachable' && bounded.route.reason === 'search-budget' && bounded.wallId === null, 'Search exhaustion invented a forced breach');
    return { knownDecision: plain(before), bounded: plain(bounded), hiddenCollisionBlocked: true };
  });

  await scenario('an unrelated visible wall receives no tactical attacks', () => {
    const { s, center, ha, hb } = fixture(); Object.assign(hb, point(center, 6));
    const wall = { id: 'irrelevant-wall', kind: 'wall', ...point(center, -3, 8), rotation: 0, length: 8, width: 1, progress: 1, hp: 30 };
    hb.buildings.push(wall); invalidateNavigation(s);
    const g = army(s, ha, 'a-march', 20, point(center, -3), { targetId: hb.id, targetX: hb.x, targetZ: hb.z });
    for (let i = 0; i < 20; i++) {
      pulse(s); check(g.combat.targetId !== wall.id && !s.pendingCombat.some(p => p.targetId === wall.id), 'Unrelated visible wall became an attack target');
    }
    check(wall.hp === 30, 'Unrelated wall received damage'); return { wallHp: wall.hp, combat: plain(g.combat), observedPulses: 20 };
  });

  await scenario('joined defensive screen preserves friendly round trip and deters hostiles', () => {
    const { state, home, owner } = routeFixture(), goal = owner.knowledge.materials, plans = [];
    for (let i = 0; i < 9; i++) {
      const plan = defenses.defenseBuildingPlan(state, home, owner); check(plan, `Missing funded defense ${i}`);
      const building = { ...plan, id: `defense-${i}`, progress: 1 }; home.buildings.push(building); plans.push(building);
      home.lastDefenseStarted = state.tick; state.tick += 24; state.step += 240; state.time += 24; invalidateNavigation(state);
    }
    const gate = plans[0], screen = plans.filter(p => p.kind !== 'tower'), nodes = new Map();
    check(gate.kind === 'gate' && screen.length === 7 && plans.every(p => p.topologyId === gate.topologyId), 'Defense topology lacks joined gate-led identity');
    for (const segment of screen) for (const end of ['from', 'to']) {
      if (nodes.has(segment.joins[end])) equal(segment[end], nodes.get(segment.joins[end]), 'Defense endpoints did not join exactly');
      else nodes.set(segment.joins[end], segment[end]);
    }
    check(nodes.size === screen.length + 1, 'Screen is disconnected or forms an accidental ring');
    check(findPath(state, home, goal, { factionId: 'owner' }).reason === 'direct' && findPath(state, home, goal, { factionId: 'ally' }).reason === 'direct', 'Friendly or allied route blocked');
    const hostile = findPath(state, home, goal, { factionId: 'enemy' }); check(hostile.reachable && hostile.length > 45, 'Hostile route was not diverted');
    const worker = { id: 'crew', kind: 'worker', factionId: owner.id, originId: home.id, size: 8, x: home.x, z: home.z, speed: 4 }; state.groups.push(worker);
    let pulses = 0;
    for (const destination of [goal, home]) {
      let arrived = false;
      for (let i = 0; i < 250 && !arrived; i++) {
        const from = { x: worker.x, z: worker.z }; state.step++; state.time += .1; pulses++;
        arrived = moveAlongRoute(state, worker, destination, { dt: .1, arrival: .3 });
        check(isSegmentTraversable(state, from, worker, { factionId: owner.id, radius: .12 }) && Math.hypot(worker.x - from.x, worker.z - from.z) <= .5, 'Worker crossed gate geometry or jumped');
      }
      check(arrived, 'Worker failed bounded outward/return trip');
    }
    return { defenses: plans.length, joinedNodes: nodes.size, hostileRouteLength: hostile.length, roundTripPulses: pulses, workerSize: worker.size };
  });

  function movementFixture() {
    const s = { seed, step: 0, tick: 0, time: 0, groups: [], settlements: [], factions: [
      { id: 'a', species: 'human', relations: { b: { status: 'hostile' } } }, { id: 'b', species: 'human', relations: { a: { status: 'hostile' } } },
    ] }; return { s, center: findGround(s) };
  }
  function formationArmy(s, center, id, factionId, units, offset, yaw = Math.PI / 2) {
    const g = { id, kind: 'army', factionId, units, size: units.infantry + units.ranged, ...point(center, offset), speed: 3, combat: { active: true, yaw } };
    s.groups.push(g); updateCombatFormation(s, g, units, 0, { yaw }); return g;
  }
  const slots = g => Object.values(g.formationSlots).flat();
  function formationPulse(s, entries) {
    s.step++; s.time = s.step / 10; s.tick = Math.floor(s.time);
    for (const [entity, target] of entries) updateCombatFormation(s, entity, entity.units, .1, target ? { contact: true, primaryTargetId: target.id, localTargets: [{ id: target.id, kind: 'group', x: target.x, z: target.z, units: target.units, entity: target }] } : {});
  }
  function spacing(groups, alpha = 1) {
    const positions = groups.flatMap(g => Array.from({ length: g.size }, (_, i) => combatFormationSlot(g, i, { alpha }))); let min = Infinity;
    for (let i = 0; i < positions.length; i++) for (let j = i + 1; j < positions.length; j++) min = Math.min(min, Math.hypot(positions[i].x - positions[j].x, positions[i].z - positions[j].z));
    return min;
  }

  await scenario('physical melee soldiers reach contact with body and interpolation separation', () => {
    const { s, center } = movementFixture(), a = formationArmy(s, center, 'a', 'a', { infantry: 30, ranged: 8 }, -3.4), b = formationArmy(s, center, 'b', 'b', { infantry: 30, ranged: 8 }, 3.4, -Math.PI / 2);
    const before = slots(a).map(p => ({ x: p.x, z: p.z })); let minimum = Infinity, maximumStep = 0;
    for (let i = 0; i < 80; i++) {
      formationPulse(s, [[a, b], [b, a]]);
      for (const alpha of [0, .25, .5, .75, 1]) minimum = Math.min(minimum, spacing([a, b], alpha));
      for (const g of [a, b]) for (const body of slots(g)) {
        maximumStep = Math.max(maximumStep, Math.hypot(body.x - body.prevX, body.z - body.prevZ));
        check(isSegmentTraversable(s, { x: body.prevX, z: body.prevZ }, body, { factionId: g.factionId, radius: .15 }), 'Soldier crossed unreachable ground');
      }
    }
    const displaced = slots(a).filter((p, i) => Math.hypot(p.x - before[i].x, p.z - before[i].z) > .5).length;
    const reachable = a.formationSlots.infantry.filter(p => b.formationSlots.infantry.some(q => Math.hypot(p.x - q.x, p.z - q.z) <= 1.8 && isSegmentTraversable(s, p, q, { factionId: 'a', radius: .08 }) && lineOfSight(s, p, q, { fromHeight: .7, toHeight: .65 }))).length;
    check(minimum >= .46 - 1e-7 && maximumStep <= .5, `Body separation/speed failed (${minimum}, ${maximumStep})`);
    check(displaced > 12 && reachable >= 10, `Contact did not produce useful independent melee positions (${displaced} moved, ${reachable} reachable)`);
    check(navigationDiagnostics(s).searches === 0, 'Soldiers performed global route searches');
    return { soldiers: 76, pulses: 80, minimumSpacing: minimum, maximumStep, displaced, meleeReachable: reachable, globalSearches: navigationDiagnostics(s).searches, finalSlots: plain([a.formationSlots, b.formationSlots]) };
  });

  await scenario('ranged soldiers settle in reachable clear firing band', () => {
    const { s, center } = movementFixture(), a = formationArmy(s, center, 'ranged', 'a', { infantry: 0, ranged: 12 }, -3), b = formationArmy(s, center, 'targets', 'b', { infantry: 6, ranged: 0 }, 1, -Math.PI / 2);
    const initialMeanX = a.formationSlots.ranged.reduce((n, p) => n + p.x, 0) / 12;
    let maximumStep = 0;
    for (let i = 0; i < 90; i++) {
      formationPulse(s, [[a, b]]);
      for (const p of a.formationSlots.ranged) { check(isSegmentTraversable(s, { x: p.prevX, z: p.prevZ }, p, { factionId: 'a', radius: .15 }), 'Ranged soldier crossed unreachable ground'); maximumStep = Math.max(maximumStep, Math.hypot(p.x - p.prevX, p.z - p.prevZ)); }
    }
    const finalMeanX = a.formationSlots.ranged.reduce((n, p) => n + p.x, 0) / 12, distances = [], finalSteps = [];
    check(finalMeanX < initialMeanX - 1, 'Ranged troops did not obtain stand-off');
    for (const body of a.formationSlots.ranged) {
      const nearest = Math.min(...b.formationSlots.infantry.map(p => Math.hypot(body.x - p.x, body.z - p.z))), delta = Math.hypot(body.x - body.prevX, body.z - body.prevZ);
      distances.push(nearest); finalSteps.push(delta);
      check(nearest >= 9 * .59 - .02 && nearest <= 9 * .91 && delta < .035, `Unstable or unsuitable ranged band (${nearest}, ${delta})`);
      check(b.formationSlots.infantry.some(p => Math.hypot(body.x - p.x, body.z - p.z) <= 9 && lineOfSight(s, body, p, { maxRange: 9, fromHeight: .7, toHeight: .65 })), 'Ranged band lacks a clear shot');
    }
    return { soldiers: 12, pulses: 90, initialMeanX, finalMeanX, distances, finalSteps, maximumStep, minimumSpacing: spacing([a, b]) };
  });

  await scenario('enemy wall prevents physical soldiers crossing or claiming contact', () => {
    const { s, center } = movementFixture(); s.walls = [{ id: 'barrier', kind: 'wall', factionId: 'b', from: point(center, 0, -10), to: point(center, 0, 10), width: 1, hp: 400, progress: 1 }]; invalidateNavigation(s);
    const a = formationArmy(s, center, 'blocked', 'a', { infantry: 18, ranged: 0 }, -2.5), b = formationArmy(s, center, 'defenders', 'b', { infantry: 12, ranged: 0 }, 2.5, -Math.PI / 2);
    for (let i = 0; i < 70; i++) {
      formationPulse(s, [[a, b], [b, a]]);
      for (const p of slots(a)) check(p.x < center.x - .65 && isSegmentTraversable(s, { x: p.prevX, z: p.prevZ }, p, { factionId: 'a', radius: .15 }), 'Attacker crossed wall');
      for (const p of slots(b)) check(p.x > center.x + .65, 'Defender crossed wall');
    }
    check(spacing([a, b]) >= .46 - 1e-7 && navigationDiagnostics(s).searches === 0, 'Wall contact violated separation or bounded local movement');
    return { pulses: 70, minimumSpacing: spacing([a, b]), attackerClosestX: Math.max(...slots(a).map(p => p.x)), defenderClosestX: Math.min(...slots(b).map(p => p.x)), wallX: center.x };
  });

  await scenario('every physical soldier follows shared route through friendly gate', () => {
    const { s, center } = movementFixture(); s.walls = [{ id: 'gate', kind: 'gate', factionId: 'a', from: point(center, 0, -10), to: point(center, 0, 10), gateWidth: 2, width: 1, hp: 400, progress: 1 }]; invalidateNavigation(s);
    const a = formationArmy(s, center, 'gate-march', 'a', { infantry: 18, ranged: 4 }, -5), goal = point(center, 5); let minimum = Infinity;
    for (let i = 0; i < 180; i++) {
      s.step++; s.time = s.step / 10; moveAlongRoute(s, a, goal, { factionId: 'a', dt: .1, speed: 2.5, arrival: .1 }); updateCombatFormation(s, a, a.units, .1, { yaw: Math.PI / 2 });
      for (const p of slots(a)) check(isSegmentTraversable(s, { x: p.prevX, z: p.prevZ }, p, { factionId: 'a', radius: .15 }), 'Soldier clipped through gate edge');
      minimum = Math.min(minimum, spacing([a]));
    }
    const crossed = slots(a).filter(p => p.x > center.x + .66).length; check(crossed === a.size && minimum >= .46 - 1e-7, `Only ${crossed}/${a.size} soldiers crossed with separation`);
    return { pulses: 180, crossed, soldiers: a.size, minimumSpacing: minimum, center: { x: a.x, z: a.z } };
  });

  await scenario('paired natural simulation replay is exact inside this browser runtime', async () => {
    const a = createSimulation('tactical-chrome-replay', { civCount: 4 }), b = createSimulation('tactical-chrome-replay', { civCount: 4 }), checkpoints = [];
    for (let cycle = 20; cycle <= 120; cycle += 20) {
      stepSimulation(a, 200); stepSimulation(b, 200);
      equal(a, b, `Paired same-runtime natural replay diverged at cycle ${cycle}`); conserved(a); checkpoints.push({ cycle, summary: plain(getSummary(a)) });
    }
    const bytes = new TextEncoder().encode(JSON.stringify(a)), digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
    return { seed: a.seed, pulsesPerRun: 1200, cyclesPerRun: 120, exactFullStateEquality: true, finalStateSha256: digest, checkpoints, residual: ledgerResidual(a) };
  });
  return { fixtureType: 'Controlled, manually arranged module fixtures; not natural rendered showcase evidence. The separately named replay case uses unmodified createSimulation/stepSimulation.', seed, ground, cases, passed: cases.every(c => c.passed) };
}

export async function runBrowser() {
  const config = configuration({ ...process.env, QA_OUTPUT_DIR: process.env.QA_OUTPUT_DIR || 'screenshots/ai-readability-tactical-browser', QA_VIDEO: '0' });
  const report = { startedAt: new Date().toISOString(), harness: 'tests/tactical-browser.mjs', scope: 'Controlled source-module outcomes in real Chrome, no renderer/video claims', node: process.versions, sourceHashes: {}, errors: [] };
  for (const file of ['src/sim/combat.js', 'src/sim/strategy.js', 'src/sim/formations.js', 'src/sim/defenses.js', 'src/sim/navigation.js', 'tests/tactical-browser.mjs']) report.sourceHashes[file] = createHash('sha256').update(await readFile(file)).digest('hex');
  await mkdir(config.outputDir, { recursive: true });
  const browser = await launch(config);
  try {
    report.browser = browser.version(); report.launch = config.launchOptions;
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    page.on('pageerror', error => report.errors.push(String(error)));
    // A same-origin source document avoids spending GPU time on an unrelated world.
    await page.goto(new URL('src/shared.js', config.url).href, { waitUntil: 'domcontentloaded' });
    report.userAgent = await page.evaluate(() => navigator.userAgent);
    for (let run = 1; run <= 2; run++) {
      const started = Date.now();
      report[`run${run}`] = await page.evaluate(controlledScenarios, { moduleRoot: new URL('src/', config.url).pathname });
      console.log(`Chrome tactical pass ${run}: ${report[`run${run}`].cases.filter(c => c.passed).length}/${report[`run${run}`].cases.length} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
      await writeFile(path.join(config.outputDir, 'report.json'), JSON.stringify(report, null, 2));
    }
    const evidence = run => run.cases.map(({ name, passed, evidence }) => ({ name, passed, evidence }));
    report.pairedFixtureReplayExact = JSON.stringify(evidence(report.run1)) === JSON.stringify(evidence(report.run2));
    report.passed = report.run1.passed && report.run2.passed && report.pairedFixtureReplayExact && report.errors.length === 0;
    report.completedAt = new Date().toISOString();
  } finally {
    await browser.close();
    await writeFile(path.join(config.outputDir, 'report.json'), JSON.stringify(report, null, 2));
  }
  for (const scenario of report.run1?.cases || []) console.log(`${scenario.passed ? 'PASS' : 'FAIL'} ${scenario.name}${scenario.error ? `\n${scenario.error}` : ''}`);
  console.log(`Paired fixture replay exact: ${report.pairedFixtureReplayExact}; browser: ${report.browser}; report: ${path.join(config.outputDir, 'report.json')}`);
  if (!report.passed) process.exitCode = 1;
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--node-fixtures')) {
    const report = await controlledScenarios({ moduleRoot: pathToFileURL(path.resolve('src') + path.sep).href });
    for (const scenario of report.cases) console.log(`${scenario.passed ? 'PASS' : 'FAIL'} ${scenario.name}${scenario.error ? `\n${scenario.error}` : ''}`);
    if (!report.passed) process.exitCode = 1;
  } else await runBrowser();
}
