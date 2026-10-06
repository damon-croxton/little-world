import { clamp, distance, emit, random } from '../shared.js';
import { terrainAt } from '../world.js';

// Decisions read faction reports. Physical contact alone belongs to a travelling
// group until its courier returns (or an earned relay finishes transmitting).
const KEYS = ['food', 'water', 'energy', 'materials'];
const MAX_GROUPS = 480;
const factionOf = (s, id) => s.factions.find(f => f.id === id);
const homeOf = (s, g) => s.settlements.find(p => p.id === g.originId);
const alive = p => p && p.population > 0 && p.health > 0 && !['camp', 'ruin'].includes(p.status);
const deployed = (s, p) => s.groups.reduce((n, g) => n + (g.kind === 'army' && !g.finished && g.originId === p.id ? g.size : 0), 0);
const modifier = (f, key) => f.modifiers?.[key] ?? f.tech?.modifiers?.[key] ?? 1;
const relation = (f, id) => f.relations[id] ?? { status: 'unknown', trust: 40 };
const emptyCargo = () => ({ food: 0, water: 0, energy: 0, materials: 0 });
const groupName = g => g.kind === 'army' ? 'expedition' : g.kind === 'trader' ? 'caravan' : 'scout';
const account = (s, key, field, amount) => {
  if (s.resourceLedger?.[key] && amount > 0) s.resourceLedger[key][field] = (s.resourceLedger[key][field] ?? 0) + amount;
};

function initialize(s, ageReports = true) {
  s.pendingReports ??= [];
  for (const f of s.factions) {
    f.knowledge ??= {};
    f.relations ??= {};
    f.experience ??= { exploration: 0, combat: 0, trade: 0 };
    f.lastScout ??= 0;
    f.lastArmy ??= 0;
    f.scoutCount ??= 0;
    f.seenObjects ??= {};
    for (const k of Object.values(f.knowledge)) {
      if (ageReports && k.observedTick < s.tick) k.confidence = Math.max(0.08, (k.confidence ?? 0.7) - 0.0017);
    }
  }
}

function recordHostility(s, a, b, severity = 8) {
  for (const [f, other] of [[a, b], [b, a]]) {
    if (!f || !other) continue;
    const r = f.relations[other.id] ??= { status: 'neutral', trust: 40, lastTrade: 0 };
    r.trust = Math.max(0, r.trust - severity);
    r.status = 'hostile';
    r.lastConflict = s.tick;
  }
}

function observe(s, g) {
  const f = factionOf(s, g.factionId);
  if (!f) return;
  g.observations ??= [];
  const radius = g.kind === 'scout' ? 17 : 11;
  const near = terrainAt(g.x, g.z, s.seed);
  const visibility = radius * (1 - Math.min(0.24, near.roughness * 0.24));
  for (const object of [...s.settlements, ...s.nodes]) {
    const isTown = 'factionId' in object;
    if (isTown && (object.factionId === f.id || (!alive(object) && !['camp', 'ruin'].includes(object.status)))) continue;
    if (!isTown && object.amount <= 0) continue;
    if (distance(g, object) > visibility) continue;
    // One measurement per journey: repeated proximity does not grant exact census.
    if (g.observations.some(o => o.id === object.id)) continue;
    const error = 0.77 + random(s) * 0.46;
    const o = {
      id: object.id, kind: isTown ? 'settlement' : 'resource',
      x: object.x, z: object.z, ownerId: isTown ? object.factionId : null,
      observedTick: s.tick, observedTime: s.time ?? s.tick, reportedTick: null,
      populationEstimate: isTown ? Math.max(0, Math.round(object.population * error)) : 0,
      soldiersEstimate: isTown ? Math.max(0, Math.round(object.soldiers * error)) : 0,
      status: isTown ? object.status ?? 'active' : null,
      healthEstimate: isTown ? Math.round(clamp(object.health * error, 0, 100)) : null,
      confidence: clamp(0.88 - near.roughness * 0.14 - Math.abs(error - 1) * 0.6, 0.5, 0.9),
      resourceKind: isTown ? null : object.kind,
      abundanceEstimate: isTown ? null : Math.round(object.amount * error),
      amountEstimate: isTown ? null : Math.round(object.amount * error),
      richnessEstimate: isTown ? null : clamp(object.richness * error, 0, 1),
    };
    g.observations.push(o);
    if (!f.seenObjects[object.id]) {
      f.seenObjects[object.id] = s.tick;
      s.stats.discoveries++;
      if (isTown || g.observations.length <= 2) emit(s, 'discovery',
        `${f.name}'s ${groupName(g)} spotted ${isTown ? object.name : object.kind + ' deposits'}; its report is still travelling.`,
        f.id, { groupId: g.id, targetId: object.id, knowledgePending: true });
    }
  }
  if (f.species === 'machine' && f.tech.unlocked.includes('relay') && g.kind === 'scout') {
    const unsent = g.observations.filter(o => !o.transmittedTick);
    if (unsent.length && (!g.lastTransmission || s.tick - g.lastTransmission >= 9)) {
      const home = homeOf(s, g);
      const delay = Math.max(3, Math.ceil((home ? distance(home, g) : 90) / 22));
      for (const o of unsent) o.transmittedTick = s.tick;
      s.pendingReports.push({ factionId: f.id, groupId: g.id, dueTick: s.tick + delay,
        observations: unsent.map(o => ({ ...o })), method: 'relay' });
      g.lastTransmission = s.tick;
      emit(s, 'report', `${f.name}'s relay sent a field packet; it will arrive in ${delay} cycles.`, f.id,
        { groupId: g.id, pending: true, dueTick: s.tick + delay });
    }
  }
}

function deliverReport(s, factionId, observations, groupId, method = 'return') {
  const f = factionOf(s, factionId);
  if (!f || !observations.length) return;
  let fresh = 0, settlements = 0, oldest = s.tick;
  for (const o of observations) {
    const previous = f.knowledge[o.id];
    if (previous && previous.observedTick >= o.observedTick) continue;
    f.knowledge[o.id] = { ...o, reportedTick: s.tick, reportedTime: s.time ?? s.tick,
      confidence: clamp(o.confidence - (s.tick - o.observedTick) * 0.0025, 0.12, 0.94) };
    fresh++;
    oldest = Math.min(oldest, o.observedTick);
    if (o.kind === 'settlement') settlements++;
  }
  if (!fresh) return;
  s.stats.reports++;
  f.experience.exploration += fresh;
  const source = method === 'relay' ? 'a delayed relay' : method === 'expedition' ? 'a returning expedition' : method === 'relief' ? 'a relief party' : 'a returning scout';
  emit(s, 'report', `${f.name} received ${source} report: ${fresh} observations${settlements ? ', ' + settlements + ' settlements' : ''}, up to ${s.tick - oldest} cycles old.`,
    f.id, { groupId, reportMethod: method, observationCount: fresh, oldestObservation: oldest });
}

function returnHome(s, g, reason, retreat = false) {
  const p = homeOf(s, g);
  if (!p) { g.finished = true; return; }
  const wasRetreat = g.phase === 'retreating';
  const siegeTarget = g.siegeMode && s.settlements.find(t => t.id === g.targetId);
  if (siegeTarget?.siege?.groupId === g.id) {
    siegeTarget.siege.active = false;
    siegeTarget.siege.endedTick = s.tick;
  }
  g.phase = retreat ? 'retreating' : 'returning';
  g.targetX = p.x;
  g.targetZ = p.z;
  g.reason = reason;
  g.stuck = 0;
  if (retreat && !wasRetreat && g.kind === 'army') {
    s.stats.retreats++;
    emit(s, 'retreat', `${factionOf(s, g.factionId)?.name}'s expedition withdrew: ${reason}`, g.factionId,
      { groupId: g.id, targetId: g.targetId, supply: Math.round(g.supply), morale: Math.round(g.morale) });
  }
}

function move(s, g, dt) {
  const dx = g.targetX - g.x, dz = g.targetZ - g.z;
  const remaining = Math.hypot(dx, dz);
  if (remaining < 0.45) return true;
  const ground = terrainAt(g.x, g.z, s.seed);
  const f = factionOf(s, g.factionId);
  const pace = (g.speed ?? 2.8) * (g.kind === 'trader' && !g.v2Speed ? 5 : 1) * modifier(f, 'movement') * ground.movement *
    (g.kind === 'army' ? 0.75 + g.morale / 400 : 1);
  const step = Math.min(remaining, pace * dt);
  const heading = Math.atan2(dz, dx);
  let best = null, bestScore = -Infinity;
  for (const turn of [0, 0.5, -0.5, 1, -1, 1.55, -1.55]) {
    const x = g.x + Math.cos(heading + turn) * step;
    const z = g.z + Math.sin(heading + turn) * step;
    const next = terrainAt(x, z, s.seed);
    if (next.height < -0.3 || Math.abs(x) > 148 || Math.abs(z) > 148) continue;
    const gain = remaining - Math.hypot(g.targetX - x, g.targetZ - z);
    const score = gain + next.movement * 0.08 - Math.abs(turn) * 0.03;
    if (score > bestScore) { best = { x, z, gain }; bestScore = score; }
  }
  if (best) {
    g.x = best.x; g.z = best.z;
    g.travelled = (g.travelled ?? 0) + step;
    g.stuck = best.gain > 0.015 * dt ? 0 : (g.stuck ?? 0) + dt;
  } else g.stuck = (g.stuck ?? 0) + dt;
  if (g.stuck > 12 && g.phase === 'outbound') returnHome(s, g, 'The coast blocked the route; returning with available observations.', g.kind === 'army');
  return Math.hypot(g.targetX - g.x, g.targetZ - g.z) < 0.45;
}

function casualties(s, g, amount) {
  if (amount <= 0 || g.size <= 0) return 0;
  g.casualtyProgress = (g.casualtyProgress ?? 0) + amount;
  const n = Math.min(g.size, Math.floor(g.casualtyProgress));
  if (!n) return 0;
  g.casualtyProgress -= n;
  g.size -= n;
  const home = homeOf(s, g);
  if (home) {
    home.population = Math.max(0, home.population - n);
    if (g.kind === 'army') home.soldiers = Math.max(0, home.soldiers - n);
    home.workers = Math.max(0, home.population - home.soldiers);
  }
  s.stats.deaths += n;
  g.morale = Math.max(0, g.morale - n * (g.kind === 'army' ? 90 / Math.max(20, g.initialSize ?? 50) : 9));
  if (!g.size) {
    g.finished = true;
    const besieged = g.siegeMode && s.settlements.find(t => t.id === g.targetId);
    if (besieged?.siege?.groupId === g.id) {
      besieged.siege.active = false;
      besieged.siege.endedTick = s.tick;
    }
    for (const key of KEYS) account(s, key, 'lost', g.carrying?.[key] ?? 0);
    g.carrying = emptyCargo();
    emit(s, 'loss', `${factionOf(s, g.factionId)?.name} lost an expedition of ${g.initialSize ?? n} individuals far from home.`,
      g.factionId, { groupId: g.id, targetId: g.targetId });
  }
  return n;
}

function deposit(s, g, town, retainOverflow = false) {
  let delivered = 0, overflow = 0;
  for (const key of KEYS) {
    const load = Math.max(0, g.carrying?.[key] ?? 0);
    const accepted = Math.min(load, Math.max(0, town.capacity - town.stock[key]));
    town.stock[key] += accepted;
    delivered += accepted;
    overflow += load - accepted;
    if (!retainOverflow) account(s, key, 'lost', load - accepted);
    if (g.carrying) g.carrying[key] = retainOverflow ? load - accepted : 0;
  }
  if (overflow > 8) emit(s, 'trade', `${town.name} could not store ${Math.round(overflow)} cargo; ${retainOverflow ? 'the caravan will carry it home' : 'the excess spoiled outside the full storehouses'}.`, town.factionId);
  return delivered;
}

function arriveTrader(s, g) {
  const f = factionOf(s, g.factionId);
  const town = g.phase === 'outbound' ? s.settlements.find(p => p.id === g.targetId) : homeOf(s, g);
  if (g.phase === 'outbound' && (!alive(town) || town.factionId !== g.trade?.partnerId || relation(f, town.factionId).status === 'hostile')) {
    returnHome(s, g, 'The exchange is unsafe; carrying the cargo home.');
    emit(s, 'trade', `${f.name}'s caravan turned back after the destination became unsafe.`, f.id, { groupId: g.id });
    return;
  }
  if (town) {
    const amount = deposit(s, g, town, g.phase === 'outbound');
    if (g.phase === 'outbound') {
      if (amount > 0.5) {
        s.stats.trades++;
        f.experience.trade++;
        const partner = factionOf(s, town.factionId);
        for (const [side, other] of [[f, partner], [partner, f]]) {
          if (!side || !other) continue;
          const r = side.relations[other.id] ??= { trust: 40, status: 'neutral', lastTrade: 0 };
          r.trust = Math.min(100, r.trust + 3);
          r.successfulTrades = (r.successfulTrades ?? 0) + 1;
        }
      }
      emit(s, 'trade', amount > 0.5 ? `${f.name}'s caravan delivered ${Math.round(amount)} ${g.trade?.exportKind ?? 'supplies'} to ${town.name}.` : `${f.name}'s caravan found ${town.name}'s storehouses full; no exchange was credited.`,
        f.id, { groupId: g.id, targetId: town.id, amount });
      // Cargo arrives now, but the labour party must still walk home.
      returnHome(s, g, 'Trade delivered; the caravan crew is returning home.');
      g.tradeDelivered = true;
      return;
    }
  }
  g.finished = true;
}

function power(s, f, size, supply, morale, terrain, defending = false) {
  const level = f.tech?.level ?? 0;
  let adaptation = f.species === 'human' ? (terrain.biome === 'meadow' ? 1.14 : 1)
    : f.species === 'hive' ? (terrain.biome === 'alien' ? 1.22 : 1.02) : 1.03 + level * 0.025;
  if (defending) adaptation *= modifier(f, 'defense');
  const experience = 1 + Math.min(0.18, (f.experience.combat ?? 0) * 0.008);
  return size * adaptation * experience * (1 + level * 0.06) *
    (0.46 + Math.max(0, supply) * 0.0054) * (0.42 + Math.max(0, morale) * 0.0058);
}

function raid(s, g, town) {
  const f = factionOf(s, g.factionId), defender = factionOf(s, town.factionId);
  const terrain = terrainAt(town.x, town.z, s.seed);
  const garrison = Math.max(0, town.soldiers - deployed(s, town));
  const attack = power(s, f, g.size, g.supply, g.morale, terrain);
  const militia = Math.min(30, Math.max(0, town.population - town.soldiers) * 0.055);
  const protection = 1.09 + terrain.roughness * 0.28 + (town.level - 1) * 0.08;
  const defense = power(s, defender, garrison + militia, 88, 76, terrain, true) * protection;
  g.engagedDays = (g.engagedDays ?? 0) + 1;
  town.contestedUntil = s.tick + 2;
  if (g.engagedDays === 1) {
    s.stats.battles++;
    recordHostility(s, f, defender);
    emit(s, 'battle', `${f.name}'s ${g.size}-soldier expedition reached ${town.name}; ${garrison} defenders hold the ${terrain.biome}.`,
      f.id, { groupId: g.id, targetId: town.id, attackerPower: +attack.toFixed(2), defenderPower: +defense.toFixed(2) });
    f.experience.combat++;
    defender.experience.combat++;
  }
  // A commander commits to a siege only after seeing an actual local advantage.
  // The report justified the march; it cannot substitute for present defenders.
  if (!g.siegeMode && g.size >= 50 && attack >= defense * 1.3 && g.supply >= 48 && g.morale >= 60) {
    g.siegeMode = true;
    g.siegeDays = 0;
    town.siege = { attackerId: f.id, groupId: g.id, sinceTick: s.tick, startHealth: town.health, active: true };
    s.stats.sieges = (s.stats.sieges ?? 0) + 1;
    emit(s, 'siege', `${f.name} committed to a siege of ${town.name}: its supplied force outnumbers the remaining defence.`,
      f.id, { groupId: g.id, targetId: town.id, attackerPower: +attack.toFixed(2), defenderPower: +defense.toFixed(2) });
  }
  // Home advantage and supply decide rates; no victory dice or overlap counting.
  casualties(s, g, defense * 0.038);
  town.defenseCasualtyProgress = (town.defenseCasualtyProgress ?? 0) + attack * (g.siegeMode ? 0.055 : 0.03);
  const lost = Math.min(garrison, Math.floor(town.defenseCasualtyProgress));
  if (lost) {
    town.defenseCasualtyProgress -= lost;
    town.soldiers = Math.max(0, town.soldiers - lost);
    town.population = Math.max(0, town.population - lost);
    town.workers = Math.max(0, town.population - town.soldiers);
    s.stats.deaths += lost;
  }
  g.morale = Math.max(0, g.morale - (attack < defense ? 5.5 : g.siegeMode ? 0.9 : 1.6));
  g.supply = Math.max(0, g.supply - 1.6);
  if (g.finished) return;
  if (g.morale < 38 || g.supply < 21 || (defense > attack * 1.75 && g.engagedDays >= 2)) {
    returnHome(s, g, defense > attack ? 'The defenders are stronger than the old report suggested.' : 'Morale or field supplies are too low to continue.', true);
    return;
  }
  if (g.siegeMode) {
    g.siegeDays++;
    const pressure = clamp((attack - defense * 0.35) * 0.185, 2, 16);
    town.health = Math.max(1, town.health - pressure);
    const remainingDefenders = Math.max(0, town.soldiers - deployed(s, town));
    g.reason = `Siege cycle ${g.siegeDays}: ${remainingDefenders} defenders remain; settlement integrity ${Math.round(town.health)}%; field supply ${Math.round(g.supply)}%.`;
    if (g.siegeDays >= 6 && town.health <= 18 && remainingDefenders <= Math.max(5, Math.floor(g.initialSize * 0.05)) && g.size >= 35 && g.supply >= 28 && g.morale >= 45) {
      // Economy finalization evacuates/rebases survivors and field parties. No
      // population is silently deleted and no settlement changes species.
      town.health = 0;
      town.defeat = { tick: s.tick, attackerId: f.id, groupId: g.id,
        reason: `${g.siegeDays} cycles of siege depleted the defenders and breached the settlement.` };
      s.stats.breaches = (s.stats.breaches ?? 0) + 1;
      f.experience.combat += 4;
      emit(s, 'defeat', `${town.name}'s defence collapsed after ${g.siegeDays} cycles of siege. Its surviving inhabitants are evacuating.`,
        defender.id, { groupId: g.id, settlementId: town.id, attackerId: f.id, remainingDefenders });
      returnHome(s, g, 'The settlement was breached; the expedition is returning while the survivors evacuate.');
      return;
    }
    if (g.siegeDays >= 15 || g.supply < 30 || g.morale < 45 || g.size < 35) {
      returnHome(s, g, 'The siege could not be sustained; the damaged settlement still holds.', true);
    }
    return;
  }
  if (g.engagedDays >= 3 && (attack >= defense * 0.94 || garrison <= 5)) {
    const carryLimit = g.size * 1.2;
    let carried = 0;
    const priority = f.species === 'machine' ? ['materials', 'energy', 'water', 'food'] : ['food', 'materials', 'water', 'energy'];
    for (const key of priority) {
      const amount = Math.min(Math.max(0, carryLimit - carried), town.stock[key] * 0.22);
      g.carrying[key] += amount;
      town.stock[key] -= amount;
      carried += amount;
    }
    town.health = Math.max(1, town.health - 10 - g.size * 0.045);
    s.stats.raids++;
    f.experience.combat += 2;
    g.morale = Math.min(100, g.morale + 10);
    emit(s, 'raid', `${f.name} raided ${town.name}, taking ${Math.round(carried)} supplies. The survivors are carrying them home.`,
      f.id, { groupId: g.id, targetId: town.id, loot: Math.round(carried) });
    returnHome(s, g, 'Raid complete; bringing captured supplies home.');
  } else if (g.engagedDays >= 7) returnHome(s, g, 'The defenders held; a longer siege would exhaust the expedition.', true);
}

function arriveArmy(s, g, cycleBoundary) {
  const f = factionOf(s, g.factionId);
  if (g.phase === 'returning' || g.phase === 'retreating') {
    const home = homeOf(s, g);
    if (home) deposit(s, g, home);
    deliverReport(s, g.factionId, g.observations ?? [], g.id, 'expedition');
    emit(s, 'return', `${f.name}'s expedition returned with ${g.size} of ${g.initialSize} soldiers.`, f.id, { groupId: g.id, targetId: g.originId });
    g.finished = true;
    return;
  }
  const target = s.settlements.find(p => p.id === g.targetId);
  if (!alive(target) || target.factionId === f.id || ['allied', 'trade'].includes(relation(f, target.factionId).status)) {
    returnHome(s, g, 'The old target is gone or now friendly; the expedition is returning.');
    return;
  }
  g.phase = 'engaging';
  if (cycleBoundary) raid(s, g, target);
}

function updateGroups(s, dt, cycleBoundary) {
  for (const g of s.groups) {
    if (g.kind === 'worker' || g.kind === 'colonist' || g.finished) continue;
    const f = factionOf(s, g.factionId);
    if (!f || !homeOf(s, g)) { g.finished = true; continue; }
    g.carrying ??= emptyCargo();
    g.observations ??= [];
    g.initialSize ??= g.size;
    g.supply = clamp(g.supply ?? 90, 0, 100);
    g.morale = clamp(g.morale ?? 85, 0, 100);
    if (g.kind !== 'trader' && cycleBoundary) {
      const ground = terrainAt(g.x, g.z, s.seed);
      const drain = g.kind === 'army' ? 0.62 + g.size * 0.0014 + ground.roughness * 0.24 : 0.4;
      g.supply = Math.max(0, g.supply - drain / modifier(f, 'supplyEfficiency'));
      if (g.supply < 25) g.morale = Math.max(0, g.morale - 1.1);
      if (g.phase === 'outbound' && (g.supply < (g.kind === 'army' ? 45 : 35) || g.morale < 40)) {
        returnHome(s, g, 'The supply reserve must cover the journey home.', g.kind === 'army');
      }
      if (g.supply === 0) casualties(s, g, g.kind === 'army' ? Math.max(0.2, g.size * 0.008) : 0.055);
      if (g.finished) continue;
    }
    if (g.kind === 'army' && g.phase === 'engaging') { if (cycleBoundary) arriveArmy(s, g, true); continue; }
    const arrived = move(s, g, dt);
    if (g.kind !== 'trader') observe(s, g);
    if (arrived) {
      if (g.kind === 'trader') arriveTrader(s, g);
      else if (g.kind === 'army') arriveArmy(s, g, cycleBoundary);
      else if (g.phase === 'outbound') returnHome(s, g, 'Exploration leg complete; taking field reports home.');
      else {
        deliverReport(s, f.id, g.observations, g.id);
        g.finished = true;
      }
    }
    // Navigation failures must not retain a faction's workforce forever.
    if (cycleBoundary && s.tick - g.createdTick > 480 && !g.finished) {
      if (g.kind === 'army') casualties(s, g, Math.max(1, g.size * 0.25));
      const home = homeOf(s, g);
      if (home) deposit(s, g, home);
      emit(s, 'return', `${f.name}'s stranded ${groupName(g)} was recovered by a relief party; its mission ended.`, f.id, { groupId: g.id });
      // This is an explicit rescue delivery, never unexplained remote knowledge.
      deliverReport(s, f.id, g.observations, g.id, 'relief');
      g.finished = true;
    }
  }
}

function fieldEncounters(s) {
  const armies = s.groups.filter(g => g.kind === 'army' && !g.finished && g.phase !== 'retreating');
  for (let i = 0; i < armies.length; i++) {
    const a = armies[i];
    if (a.finished || a.phase === 'retreating') continue;
    const af = factionOf(s, a.factionId);
    for (let j = i + 1; j < armies.length; j++) {
      const b = armies[j], bf = factionOf(s, b.factionId);
      if (b.finished || b.phase === 'retreating' || a.factionId === b.factionId || distance(a, b) > 9) continue;
      if (relation(af, bf.id).status !== 'hostile') continue;
      const ground = terrainAt((a.x + b.x) / 2, (a.z + b.z) / 2, s.seed);
      const aPower = power(s, af, a.size, a.supply, a.morale, ground);
      const bPower = power(s, bf, b.size, b.supply, b.morale, ground);
      const first = a.lastEncounterId !== b.id || s.tick - (a.lastEncounterTick ?? -10) > 6;
      const ambusher = ground.roughness > 0.36 ? (af.species === 'hive' || a.supply > b.supply + 15 ? a : b) : null;
      if (first) {
        s.stats.battles++;
        emit(s, ambusher ? 'ambush' : 'battle', `${af.name} and ${bf.name} met in the ${ground.biome}${ambusher ? '; cover gave ' + factionOf(s, ambusher.factionId).name + ' the first strike' : ''}.`,
          af.id, { groupId: a.id, otherGroupId: b.id });
        af.experience.combat++; bf.experience.combat++;
      }
      a.lastEncounterId = b.id; b.lastEncounterId = a.id;
      a.lastEncounterTick = b.lastEncounterTick = s.tick;
      casualties(s, a, bPower * 0.055 * (first && ambusher === b ? 1.45 : 1));
      casualties(s, b, aPower * 0.055 * (first && ambusher === a ? 1.45 : 1));
      a.morale = Math.max(0, a.morale - (aPower < bPower ? 8 : 3));
      b.morale = Math.max(0, b.morale - (bPower < aPower ? 8 : 3));
      if (!a.finished && (a.morale < 42 || a.size < a.initialSize * 0.6)) returnHome(s, a, "Field losses broke the expedition's cohesion.", true);
      if (!b.finished && (b.morale < 42 || b.size < b.initialSize * 0.6)) returnHome(s, b, "Field losses broke the expedition's cohesion.", true);
    }
    for (const caravan of s.groups) {
      if (caravan.kind !== 'trader' || caravan.finished || caravan.phase !== 'outbound' || caravan.factionId === a.factionId || distance(a, caravan) > 6) continue;
      if (relation(af, caravan.factionId).status !== 'hostile') continue;
      let loot = 0;
      for (const key of KEYS) {
        const taken = Math.min(caravan.carrying[key] ?? 0, Math.max(0, a.size * 1.2 - loot));
        caravan.carrying[key] -= taken; a.carrying[key] += taken; loot += taken;
      }
      returnHome(s, caravan, 'Hostile troops intercepted the cargo; the crew escaped home.');
      if (loot > 0) { s.stats.raids++; emit(s, 'raid', `${af.name} intercepted a caravan and took ${Math.round(loot)} supplies.`, af.id, { groupId: a.id, otherGroupId: caravan.id }); }
    }
  }
}

function canPay(p, costs, reserve = 0) {
  return KEYS.every(k => p.stock[k] >= (costs[k] ?? 0) + (costs[k] ? reserve : 0));
}
function pay(s, p, costs) {
  for (const k of KEYS) {
    const paid = Math.min(p.stock[k], Math.max(0, costs[k] ?? 0));
    p.stock[k] -= paid;
    account(s, k, 'consumed', paid);
  }
}
function provisions(f, size, army) {
  const factor = size;
  return f.species === 'machine'
    ? { energy: factor * (army ? 0.62 : 0.75), materials: factor * 0.12, water: factor * 0.1 }
    : { food: factor * (army ? 0.5 : 0.8), water: factor * (army ? 0.35 : 0.6), materials: army ? factor * 0.08 : 0 };
}

function exploratoryTarget(s, f, p) {
  // Compass bearings use only the home position and previous expeditions.
  const inward = Math.atan2(-p.z, -p.x);
  const bearings = [Math.PI / 3, -Math.PI / 3, 0, Math.PI / 6, -Math.PI / 6, 1.48, -1.48];
  const bearing = inward + bearings[f.scoutCount % bearings.length] + (random(s) - 0.5) * 0.18;
  const reach = 72 + Math.min(30, Math.floor(f.scoutCount / 3) * 6) + f.traits.curiosity * 12;
  let x = p.x + Math.cos(bearing) * reach, z = p.z + Math.sin(bearing) * reach;
  const radius = Math.hypot(x, z);
  if (radius > 125) { x *= 125 / radius; z *= 125 / radius; }
  for (let i = 0; i < 12 && terrainAt(x, z, s.seed).height < -0.3; i++) { x *= 0.9; z *= 0.9; }
  return { x, z };
}

function dispatchScout(s, f, homes) {
  const active = s.groups.filter(g => g.factionId === f.id && g.kind === 'scout');
  const interval = 24 + Math.round((1 - f.traits.curiosity) * 24);
  const firstCycle = 13 + s.factions.indexOf(f) * 3;
  if (s.tick < firstCycle || s.tick - f.lastScout < (f.scoutCount ? interval : firstCycle) || active.length >= 2 || s.groups.length >= MAX_GROUPS) return;
  const p = homes.slice().sort((a, b) => b.population - a.population)[0];
  if (!p || p.population - p.soldiers < 20) return;
  const civilianAway = s.groups.reduce((n, g) => n + (g.originId === p.id && g.kind !== 'army' ? g.size : 0), 0);
  const size = Math.round(clamp(3 + p.population / 180, 3, 8));
  const localAvailable = Math.min(p.availableWorkers ?? Infinity, p.population - p.soldiers - civilianAway);
  if (localAvailable < size + 8) return;
  const costs = provisions(f, size, false);
  if (!canPay(p, costs, 8)) return;
  pay(s, p, costs);
  const target = exploratoryTarget(s, f, p);
  const g = { id: 'g' + s.nextId++, factionId: f.id, originId: p.id, kind: 'scout',
    x: p.x, z: p.z, prevX: p.x, prevZ: p.z, targetX: target.x, targetZ: target.z, targetId: null, phase: 'outbound',
    size, initialSize: size, supply: 100, morale: 88, speed: f.species === 'hive' ? 4.0 : 4.2,
    carrying: emptyCargo(), observations: [], createdTick: s.tick, createdTime: s.time ?? s.tick,
    reason: f.scoutCount ? 'Surveying another compass bearing; discoveries must be brought home.' : 'First survey beyond the settlement; no foreign positions are known.' };
  s.groups.push(g);
  f.lastScout = s.tick; f.scoutCount++;
  if (f.scoutCount <= 2 || f.scoutCount % 4 === 0) emit(s, 'scout', `${f.name} sent ${size} scouts beyond ${p.name}. They leave production until their report returns.`, f.id, { groupId: g.id, originId: p.id });
}

function chooseExpedition(s, f, homes) {
  if (s.tick < 180 || s.groups.length >= MAX_GROUPS || s.groups.some(g => g.factionId === f.id && g.kind === 'army')) return;
  const cooldown = 110 + Math.round((1 - f.traits.aggression) * 100);
  if (s.tick - f.lastArmy < cooldown) return;
  const known = Object.values(f.knowledge).filter(k => k.kind === 'settlement' && k.ownerId && k.ownerId !== f.id &&
    !['camp', 'ruin'].includes(k.status) && k.reportedTick !== null && k.reportedTick <= s.tick && k.confidence >= 0.3 && s.tick - k.observedTick <= 230);
  if (!known.length) { if (s.tick % 12 === 0) f.intent = 'Exploring: no returned report identifies a foreign settlement.'; return; }
  const resources = Object.values(f.knowledge).filter(k => k.kind === 'resource' && k.reportedTick != null &&
    k.reportedTick <= s.tick && k.confidence >= 0.3 && (k.amountEstimate ?? k.abundanceEstimate ?? 0) >= 600);
  let best = null;
  for (const p of homes) {
    const staple = f.species === 'machine' ? 'energy' : 'food';
    const need = p.stock[staple] < p.population * 0.25 || p.stock.materials < p.population * 0.20;
    for (const k of known) {
      const r = relation(f, k.ownerId);
      if (['allied', 'trade'].includes(r.status)) continue;
      const distanceTo = distance(p, k);
      if (distanceTo > 138) continue;
      const deposit = resources.find(resource => distance(resource, k) < 34 && distance(p, resource) <= distanceTo * 0.9 + 10 &&
        (resource.resourceKind === 'materials' || resource.resourceKind === staple));
      // Ample local resources favour settlement-building. Personality changes the
      // response to an actual shortage/frontier claim, never invents a war.
      if (r.status !== 'hostile' && (!need || !deposit)) continue;
      const appetite = f.traits.aggression * 0.68 + (need ? 0.2 : 0) + (r.status === 'hostile' ? 0.3 : 0) - f.traits.cooperation * 0.22;
      if (appetite < 0.54) continue;
      const age = s.tick - k.observedTick;
      const available = Math.max(0, p.soldiers - deployed(s, p) - 12);
      const reportedDefenders = Math.max(1, k.soldiersEstimate ?? k.populationEstimate * 0.22);
      const vulnerability = clamp((available - reportedDefenders) * 0.085, -12, 11);
      const damageOpportunity = Math.max(0, 70 - (k.healthEstimate ?? 100)) * 0.065;
      const score = appetite * 30 + k.confidence * 10 + vulnerability + damageOpportunity - distanceTo * 0.085 - age * 0.025;
      if (!best || score > best.score) best = { p, k, need, deposit, score, distanceTo };
    }
  }
  if (!best) { if (s.tick % 12 === 0) f.intent = 'Holding the peace; scouts and exchange are safer than an expedition.'; return; }
  const { p, k, need, deposit } = best;
  const available = Math.max(0, p.soldiers - deployed(s, p));
  const size = Math.min(200, Math.max(0, available - Math.max(12, Math.ceil(p.soldiers * 0.2))));
  const estimate = Math.max(1, k.soldiersEstimate ?? k.populationEstimate * 0.22);
  p.militaryTarget = clamp(0.18 + f.traits.aggression * 0.12, 0.18, 0.3);
  if (size < 50 || (size < estimate * 0.65 && f.traits.aggression < 0.8)) {
    f.intent = `Training before acting on a ${s.tick - k.observedTick}-cycle-old report; ${size} soldiers available, about ${estimate} reported defenders.`;
    return;
  }
  const costs = provisions(f, size, true);
  const speed = f.species === 'machine' ? 2.7 : f.species === 'hive' ? 3.05 : 2.9;
  const expectedTravelCycles = Math.ceil(best.distanceTo * 2 / (speed * 0.78 * modifier(f, 'movement')));
  const routeSupplyBudget = expectedTravelCycles * (0.68 + size * 0.0014) / modifier(f, 'supplyEfficiency') + 8;
  if (routeSupplyBudget > 96) {
    f.intent = `The reported target is beyond a safe return journey; waiting for better logistics or a nearer outpost.`;
    return;
  }
  if (!canPay(p, costs, Math.max(12, p.population * 0.05))) {
    f.intent = `Building expedition stocks; intelligence alone cannot feed ${size} soldiers on the march.`;
    return;
  }
  pay(s, p, costs);
  const reason = `${relation(f, k.ownerId).status === 'hostile' ? 'An unresolved frontier conflict' : 'Low reserves and a reported ' + deposit.resourceKind + ' deposit near the rival frontier'}; a returned report observed about ${estimate} defenders ${s.tick - k.observedTick} cycles ago.`;
  const g = { id: 'g' + s.nextId++, factionId: f.id, originId: p.id, kind: 'army',
    x: p.x, z: p.z, prevX: p.x, prevZ: p.z, targetX: k.x, targetZ: k.z, targetId: k.id, phase: 'outbound',
    size, initialSize: size, supply: 100, morale: 80 + f.traits.aggression * 12,
    speed, expectedTravelCycles, routeSupplyBudget: Math.round(routeSupplyBudget),
    carrying: emptyCargo(), observations: [], createdTick: s.tick, createdTime: s.time ?? s.tick, reason,
    intelligence: { observedTick: k.observedTick, reportedTick: k.reportedTick, confidence: k.confidence, populationEstimate: k.populationEstimate, soldiersEstimate: estimate } };
  s.groups.push(g);
  f.lastArmy = s.tick;
  f.intent = `An expedition of ${size} soldiers is marching on reported coordinates. ${reason}`;
  emit(s, 'mobilize', `${f.name} mobilised ${size} soldiers from ${p.name}. ${reason}`, f.id,
    { groupId: g.id, targetId: k.id, reportTick: k.reportedTick, observationTick: k.observedTick, provisions: costs });
}

export function stepStrategy(s, dt = 0.1) {
  const cycleBoundary = Number.isInteger(s.step) ? s.step % 10 === 0 : true;
  // Motion pulses do not repeatedly age intelligence, buy provisions or inflict
  // combat damage. All strategic/upkeep work happens once per whole cycle.
  if (cycleBoundary || !s.strategyInitialized) {
    initialize(s, cycleBoundary);
    s.strategyInitialized = true;
  }
  if (cycleBoundary) {
    const remaining = [];
    for (const packet of s.pendingReports) {
      if (packet.dueTick <= s.tick) deliverReport(s, packet.factionId, packet.observations, packet.groupId, packet.method);
      else remaining.push(packet);
    }
    s.pendingReports = remaining;
  }
  updateGroups(s, dt, cycleBoundary);
  if (cycleBoundary) fieldEncounters(s);
  s.groups = s.groups.filter(g => g.kind === 'worker' || g.kind === 'colonist' || (!g.finished && g.size > 0));
  if (!cycleBoundary) return;
  for (const f of s.factions) {
    const homes = s.settlements.filter(p => p.factionId === f.id && alive(p));
    if (!homes.length) continue;
    dispatchScout(s, f, homes);
    chooseExpedition(s, f, homes);
  }
}
