import { clamp, distance, emit, random } from '../shared.js';
import { terrainAt, WORLD_RADIUS } from '../world.js';
import { allocateMilitary, applyMilitaryCasualties, availableMilitary, countMilitary, returnMilitary, demobilizeMilitary, refreshExileBases } from './military.js';
import { stepCombat, canFight } from './combat.js';
import { observeGroup, reportObservations, knownReports, visibleToGroup } from './knowledge.js';
import { moveAlongRoute, isSegmentTraversable, findPath } from './navigation.js';
import { factionController, settlementController, groupController, occupySettlement, updateConquest } from './conquest.js';

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
const nativeProfile = (s, g, commander) => ({ ...commander, species: factionOf(s, g.factionId)?.species || commander.species });
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
    // Stored reports remain snapshots; decision helpers enforce their age.
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
  const f = factionOf(s, groupController(s, g));
  if (!f) return;
  const observed = observeGroup(s, g);
  for (const o of observed) {
    if (f.seenObjects[o.id]) continue;
    f.seenObjects[o.id] = s.tick; s.stats.discoveries++;
    if (o.kind === 'settlement' || g.observations.length <= 2) emit(s, 'discovery',
      `${f.name}'s ${groupName(g)} spotted ${o.kind === 'settlement' ? o.name || 'a foreign settlement' : o.resourceKind ? o.resourceKind + ' deposits' : 'a terrain passage'}; its report is still travelling.`,
      f.id, { groupId: g.id, targetId: o.id, knowledgePending: true });
  }
  if (f.species === 'machine' && f.tech.unlocked.includes('relay') && g.kind === 'scout') {
    const unsent = g.observations.filter(o => !o.transmittedTick);
    if (unsent.length && (!g.lastTransmission || s.tick - g.lastTransmission >= 9)) {
      const home = homeOf(s, g);
      const delay = Math.max(3, Math.ceil((home ? distance(home, g) : 90) / 22));
      for (const o of unsent) o.transmittedTick = s.tick;
      s.pendingReports.push({ factionId: f.id, groupId: g.id, dueTick: s.tick + delay,
        observations: unsent.map(o => ({ ...o })), explorationMask: g.explorationMask?.slice(), method: 'relay' });
      g.lastTransmission = s.tick;
      emit(s, 'report', `${f.name}'s relay sent a field packet; it will arrive in ${delay} cycles.`, f.id,
        { groupId: g.id, pending: true, dueTick: s.tick + delay });
    }
  }
}

function deliverReport(s, factionId, observations, groupId, method = 'return', explorationMask = undefined, receiverHomeId = null) {
  const group = s.groups.find(g => g.id === groupId), home = receiverHomeId ? s.settlements.find(p => p.id === receiverHomeId) : group && homeOf(s, group);
  if (method !== 'relay' && home && distance(group, home) < 1) factionId = settlementController(s, home);
  const f = factionOf(s, factionId);
  if (!f || !observations.length || method === 'relay' && f.defeatedBy) return;
  const { fresh, settlements, oldest } = reportObservations(s, f, observations, { method, group: s.groups.find(g => g.id === groupId), explorationMask, homeId: home?.id });
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
  g.stagingTargetId = null; g.stagingPurpose = null;
  if (g.kind === 'army' && !g.surrendered && !factionOf(s, groupController(s, g))?.defeatedBy && settlementController(s, p) !== groupController(s, g) && !retreat) {
    g.phase = 'outbound'; g.missionOrderTick = s.tick; g.intelligence = { observedTick: s.tick, reportedTick: s.tick, confidence: 1, reportMethod: 'own-home-status' }; g.targetId = p.id; g.targetX = p.x; g.targetZ = p.z; g.liberation = true;
    if (g.combat) g.combat.active = false;
    g.reason = 'The surviving expedition is marching to liberate its occupied native home.'; return;
  }
  const wasRetreat = g.phase === 'retreating';
  const siegeTarget = g.siegeMode && s.settlements.find(t => t.id === g.targetId);
  if (siegeTarget?.siege?.groupId === g.id) {
    siegeTarget.siege.active = false;
    siegeTarget.siege.endedTick = s.tick;
  }
  g.phase = retreat ? 'retreating' : 'returning';
  if (g.combat) g.combat.active = false;
  g.targetX = p.x;
  g.targetZ = p.z;
  const depot = g.stagingHomeId && s.settlements.find(h => h.id === g.stagingHomeId);
  if (g.kind === 'army' && alive(depot) && settlementController(s, depot) === groupController(s, g) && distance(g, depot) > 1 && distance(depot, p) < distance(g, p) * .9) { g.stagingTargetId = depot.id; g.stagingPurpose = 'return'; g.targetX = depot.x; g.targetZ = depot.z; }
  if (g.kind === 'scout' && distance(g, p) > 80) {
    const stops = s.settlements.filter(h => h.id !== p.id && alive(h) && settlementController(s, h) === groupController(s, g) && distance(g, h) < distance(g, p) * .8 && distance(g, h) + distance(h, p) < distance(g, p) * 1.3);
    stops.sort((a, b) => distance(g, a) - distance(g, b));
    if (stops[0]) { g.reportStopId = stops[0].id; g.targetX = stops[0].x; g.targetZ = stops[0].z; }
  }
  g.reason = reason;
  g.stuck = 0;
  if (retreat && !wasRetreat && g.kind === 'army') {
    s.stats.retreats++;
    emit(s, 'retreat', `${factionOf(s, groupController(s, g))?.name}'s expedition withdrew: ${reason}`, groupController(s, g),
      { groupId: g.id, targetId: g.targetId, supply: Math.round(g.supply), morale: Math.round(g.morale) });
  }
}

function move(s, g, dt) {
  const f = factionOf(s, groupController(s, g)), ground = terrainAt(g.x, g.z, s.seed);
  const pace = (g.speed ?? 2.8) * (g.kind === 'trader' && !g.v2Speed ? 5 : 1) * modifier(f, 'movement') *
    (g.kind === 'army' ? .75 + g.morale / 400 : 1);
  const arrived = moveAlongRoute(s, g, { x: g.targetX, z: g.targetZ }, { dt, speed: pace, factionId: groupController(s, g) });
  if ((g.stuckTime ?? g.stuck ?? 0) > 12 && g.phase === 'outbound') returnHome(s, g, 'An impassable route blocked the journey; returning with available observations.', g.kind === 'army');
  return arrived;
}

function casualties(s, g, amount) {
  if (amount <= 0 || g.size <= 0) return 0;
  g.casualtyProgress = (g.casualtyProgress ?? 0) + amount;
  const n = Math.min(g.size, Math.floor(g.casualtyProgress));
  if (!n) return 0;
  g.casualtyProgress -= n;
  if (g.kind === 'army') {
    const actual = applyMilitaryCasualties(s, homeOf(s, g), g, n);
    s.stats.strategicFieldDeaths = (s.stats.strategicFieldDeaths || 0) + actual;
    g.morale = Math.max(0, g.morale - actual * 90 / Math.max(20, g.initialSize ?? 50));
    if (g.finished) {
      const target = s.settlements.find(t => t.id === g.targetId);
      if (target?.siege?.groupId === g.id) { target.siege.active = false; target.siege.endedTick = s.tick; }
      emit(s, 'loss', `${factionOf(s, groupController(s, g))?.name} lost an expedition of ${g.initialSize ?? n} individuals far from home.`, groupController(s, g), { groupId: g.id, targetId: g.targetId });
    }
    return actual;
  }
  const survivors = (g.size - n) / g.size;
  for (const key of KEYS) {
    const lost = (g.carrying?.[key] || 0) * (1 - survivors);
    if (g.carrying) g.carrying[key] -= lost;
    account(s, key, 'lost', lost);
  }
  if (g.capacity != null) g.capacity *= survivors;
  if (g.cargoCapacity != null) g.cargoCapacity *= survivors;
  g.size -= n;
  const home = homeOf(s, g);
  if (home) {
    home.population = Math.max(0, home.population - n);
    if (g.kind === 'army') home.soldiers = Math.max(0, home.soldiers - n);
    home.workers = Math.max(0, home.population - home.soldiers);
  }
  s.stats.deaths += n;
  s.stats.strategicFieldDeaths = (s.stats.strategicFieldDeaths || 0) + n;
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
    emit(s, 'loss', `${factionOf(s, groupController(s, g))?.name} lost an expedition of ${g.initialSize ?? n} individuals far from home.`,
      groupController(s, g), { groupId: g.id, targetId: g.targetId });
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
  const f = factionOf(s, groupController(s, g));
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
  const f = factionOf(s, groupController(s, g)), defender = factionOf(s, settlementController(s, town));
  const terrain = terrainAt(town.x, town.z, s.seed);
  const garrison = Math.max(0, town.soldiers - deployed(s, town));
  const attack = power(s, nativeProfile(s, g, f), g.size, g.supply, g.morale, terrain);
  const awayCivilians = s.groups.reduce((sum, party) => sum + (party.originId === town.id && party.kind !== 'army' && !party.finished ? party.size : 0), 0);
  const militia = town.occupiedBy ? 0 : Math.min(30, Math.max(0, town.population - town.soldiers - awayCivilians) * 0.055);
  const protection = 1.09 + terrain.roughness * 0.28 + (town.level - 1) * 0.08;
  const defense = power(s, { ...defender, species: factionOf(s, town.factionId)?.species || defender.species }, garrison + militia, 88, 76, terrain, true) * protection;
  g.engagedDays = (g.engagedDays ?? 0) + 1;
  g.initialGarrison ??= garrison; town.defenseMorale ??= 90;
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
  if (!g.siegeMode && g.size >= (g.campaign ? 16 : 50) && attack >= defense * (g.campaign ? .82 : 1.3) && g.supply >= (g.campaign ? 34 : 48) && g.morale >= 50) {
    g.siegeMode = true;
    g.siegeDays = 0;
    town.siege = { attackerId: f.id, groupId: g.id, sinceTick: s.tick, startHealth: town.health, active: true };
    s.stats.sieges = (s.stats.sieges ?? 0) + 1;
    emit(s, 'siege', `${f.name} committed to a siege of ${town.name}: its supplied force is pressing the observed defence.`,
      f.id, { groupId: g.id, targetId: town.id, attackerPower: +attack.toFixed(2), defenderPower: +defense.toFixed(2) });
  }
  // The tactical combat module alone applies military damage and deaths.
  // An empty garrison never stores future casualty debt.
  town.defenseCasualtyProgress = 0;
  const canReachStores = isSegmentTraversable(s, g, town, { factionId: groupController(s, g), radius: .15 });
  g.morale = Math.max(0, g.morale - (attack < defense ? 5.5 : g.siegeMode ? 0.9 : 1.6));
  g.supply = Math.max(0, g.supply - 1.6);
  if (g.finished) return;
  if (g.morale < 38 || g.supply < 21 || (defense > attack * 1.75 && g.engagedDays >= 4)) {
    returnHome(s, g, defense > attack ? 'The defenders are stronger than the old report suggested.' : 'Morale or field supplies are too low to continue.', true);
    return;
  }
  if (g.siegeMode) {
    g.siegeDays++;
    const pressure = canReachStores ? clamp((attack - defense * .30) * .24, 3, 18) : 0;
    if (pressure) town.defenseMorale = Math.max(0, town.defenseMorale - pressure * .20);
    town.health = Math.max(1, town.health - pressure);
    const remainingDefenders = Math.max(0, town.soldiers - deployed(s, town));
    g.reason = `Siege cycle ${g.siegeDays}: ${remainingDefenders} defenders remain; settlement integrity ${Math.round(town.health)}%; field supply ${Math.round(g.supply)}%.`;
    const brokenDefense = remainingDefenders <= Math.max(4, Math.floor(g.initialGarrison * .55)) || attack > defense * 1.25 || town.defenseMorale < 28;
    if (g.siegeDays >= 6 && town.health <= 18 && brokenDefense && canReachStores && g.size >= 12 && g.supply >= 16 && g.morale >= 35) {
      if (occupySettlement(s, town, g)) {
        s.stats.breaches = (s.stats.breaches ?? 0) + 1;
        if (!continueCampaign(s, g, town)) returnHome(s, g, 'The settlement capitulated; the surviving expedition is returning with its reports.');
      }
      return;
    }
    if (g.siegeDays >= (g.campaign ? 36 : 15) || g.supply < 20 || g.morale < 35 || g.size < 12) returnHome(s, g, 'The siege could not be sustained; the damaged settlement still holds.', true);
    return;
  }
  if (g.engagedDays >= 5 && canReachStores && (attack >= defense * 0.94 || garrison <= 5)) {
    const carryLimit = g.size * 1.2;
    let carried = KEYS.reduce((sum, key) => sum + (g.carrying[key] || 0), 0);
    const initialCargo = carried;
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
    emit(s, 'raid', `${f.name} raided ${town.name}, taking ${Math.round(carried - initialCargo)} supplies. The survivors are carrying them home.`,
      f.id, { groupId: g.id, targetId: town.id, loot: Math.round(carried - initialCargo) });
    returnHome(s, g, 'Raid complete; bringing captured supplies home.');
  } else if (g.engagedDays >= 7) returnHome(s, g, 'The defenders held; a longer siege would exhaust the expedition.', true);
}

function continueCampaign(s, g, captured) {
  const f = factionOf(s, groupController(s, g));
  if (!g.campaign || g.size < 18 || g.morale < 40) return false;
  const refill = provisions(nativeProfile(s, g, f), g.size, true), fraction = Math.max(0, 90 - g.supply) / 100;
  const costs = Object.fromEntries(Object.entries(refill).map(([key, value]) => [key, value * fraction * (g.provisionFactor || 1)]));
  if (canPay(captured, costs, 8)) { pay(s, captured, costs); g.supply = Math.max(g.supply, 90); }
  const candidates = knownReports(s, f, { kind: 'settlement', maxAge: 230, minConfidence: .3, includeOwn: false }).filter(k => k.id !== captured.id && k.ownerId && !['camp', 'ruin'].includes(k.status) && !['allied', 'trade'].includes(relation(f, k.ownerId).status) && distance(g, k) <= 150 && (g.size >= (k.soldiersEstimate || 1) * .7 || f.traits.aggression > .76));
  candidates.sort((a, b) => distance(g, a) + (a.soldiersEstimate || 0) * .4 - distance(g, b) - (b.soldiersEstimate || 0) * .4);
  const target = candidates[0];
  if (!target || g.supply < 58) return false;
  g.phase = 'outbound'; g.missionOrderTick = s.tick; g.targetId = target.id; g.targetX = target.x; g.targetZ = target.z; g.missionTargetX = target.x; g.missionTargetZ = target.z; g.stagingTargetId = null; g.stagingPurpose = null; g.stagingHomeId = captured.id; g.engagedDays = 0; g.siegeMode = false; g.siegeDays = 0; g.cohesionSize = g.size; delete g.initialGarrison;
  if (g.combat) g.combat.active = false;
  g.morale = Math.min(96, g.morale + 9);
  g.reason = `After occupying ${captured.name}, the surviving force uses local supplies and a returned report to continue its campaign.`;
  g.intelligence = { observedTick: target.observedTick, reportedTick: target.reportedTick, confidence: target.confidence, soldiersEstimate: target.soldiersEstimate };
  s.stats.campaignLegs = (s.stats.campaignLegs || 0) + 1;
  emit(s, 'campaign', `${f.name}'s ${g.size} surviving soldiers continue from ${captured.name} toward another reported rival.`, f.id, { groupId: g.id, targetId: target.id, originId: captured.id, provisions: costs });
  return true;
}

function arriveArmy(s, g, cycleBoundary) {
  const f = factionOf(s, groupController(s, g));
  if (g.stagingTargetId && g.phase !== 'engaging') {
    const depot = s.settlements.find(p => p.id === g.stagingTargetId), purpose = g.stagingPurpose;
    g.stagingTargetId = null; g.stagingPurpose = null;
    if (!alive(depot) || settlementController(s, depot) !== f.id || distance(g, depot) > 1) { returnHome(s, g, 'The forward supply stop is no longer safe.', true); return; }
    const refill = Math.max(0, 100 - g.supply) / 100 * (g.provisionFactor || 1), costs = Object.fromEntries(Object.entries(provisions(nativeProfile(s, g, f), g.size, true)).map(([key, value]) => [key, value * refill]));
    if (canPay(depot, costs, 8)) { pay(s, depot, costs); g.supply = 100; s.stats.supplyStops = (s.stats.supplyStops || 0) + 1; }
    else if (purpose === 'outbound') { returnHome(s, g, 'The forward stores cannot fund the next leg.', true); return; }
    const destination = purpose === 'return' ? homeOf(s, g) : { x: g.missionTargetX, z: g.missionTargetZ };
    g.targetX = destination.x; g.targetZ = destination.z;
    if (purpose === 'outbound') g.phase = 'outbound';
    g.reason = 'The expedition physically visited a held supply depot and paid for replacement rations.';
    return;
  }
  if (g.phase === 'returning' || g.phase === 'retreating') {
    const home = homeOf(s, g);
    if (home) deposit(s, g, home);
    deliverReport(s, groupController(s, g), g.observations ?? [], g.id, 'expedition');
    emit(s, 'return', `${f.name}'s expedition returned with ${g.size} of ${g.initialSize} soldiers.`, f.id, { groupId: g.id, targetId: g.originId });
    returnMilitary(s, home, g);
    if (home && ((home.occupiedBy && home.exileBaseFor !== groupController(s, g)) || f.defeatedBy || g.surrendered)) demobilizeMilitary(s, home, g.size);
    return;
  }
  const target = s.settlements.find(p => p.id === g.targetId);
  if (!alive(target) || settlementController(s, target) === factionController(s, f.id) || ['allied', 'trade'].includes(relation(f, settlementController(s, target)).status)) {
    returnHome(s, g, 'The old target is gone or now friendly; the expedition is returning.');
    return;
  }
  if (!visibleToGroup(s, g, target, 18)) { returnHome(s, g, 'The reported coordinates yielded no current local contact.'); return; }
  g.phase = 'engaging';
  if (cycleBoundary) raid(s, g, target);
}

function updateGroups(s, dt, cycleBoundary) {
  for (const g of s.groups) {
    if (g.kind === 'worker' || g.kind === 'colonist' || g.finished) continue;
    const f = factionOf(s, groupController(s, g));
    if (!f || !homeOf(s, g)) { g.finished = true; continue; }
    g.carrying ??= emptyCargo();
    g.observations ??= [];
    g.initialSize ??= g.size;
    g.supply = clamp(g.supply ?? 90, 0, 100);
    g.morale = clamp(g.morale ?? 85, 0, 100);
    if (cycleBoundary) {
      const ground = terrainAt(g.x, g.z, s.seed);
      const drain = g.kind === 'army' ? 0.62 + g.size * 0.0014 + ground.roughness * 0.24 : 0.4;
      g.supply = g.kind === 'trader' && g.provisionCycles
        ? Math.max(0, 100 * (1 - ((s.time ?? s.tick) - g.createdTick) / g.provisionCycles))
        : Math.max(0, g.supply - drain / modifier(f, 'supplyEfficiency') / (g.provisionFactor || 1));
      if (g.supply < 25) g.morale = Math.max(0, g.morale - 1.1);
      if (g.phase === 'outbound' && (g.supply < (g.kind === 'army' ? 45 : 35) || g.morale < 40)) {
        returnHome(s, g, 'The supply reserve must cover the journey home.', g.kind === 'army');
      }
      if (g.supply === 0) casualties(s, g, g.kind === 'army' ? Math.max(0.2, g.size * 0.008) : g.kind === 'trader' ? Math.max(.04, g.size * .008) : .055);
      if (g.finished) continue;
    }
    if (g.kind === 'army' && g.phase === 'engaging') {
      if (cycleBoundary && (!g.combat?.active || g.combat.targetKind === 'settlement' && (g.combat.exchangeStartedAt != null || g.combat.holding && countMilitary(availableMilitary(s, s.settlements.find(p => p.id === g.targetId))) <= 0 || distance(g, s.settlements.find(p => p.id === g.targetId) || g) < 5))) arriveArmy(s, g, true);
      if (cycleBoundary) observe(s, g);
      continue;
    }
    const arrived = move(s, g, dt);
    // A whole-cycle survey overlaps the previous sight radius even at maximum
    // movement speed; arrivals also survey before delivering a report.
    if (g.kind !== 'trader' && (cycleBoundary || arrived)) observe(s, g);
    if (arrived) {
      if (g.kind === 'trader') arriveTrader(s, g);
      else if (g.kind === 'army') arriveArmy(s, g, cycleBoundary);
      else if (g.phase === 'outbound') returnHome(s, g, 'Exploration leg complete; taking field reports home.');
      else {
        if (g.reportStopId) {
          const stop = s.settlements.find(p => p.id === g.reportStopId);
          if (stop && distance(g, stop) < 1 && settlementController(s, stop) === factionController(s, f.id)) {
            deliverReport(s, f.id, g.observations, g.id, 'waystation', g.explorationMask, stop.id);
            s.stats.reportStops = (s.stats.reportStops || 0) + 1;
          }
          g.reportStopId = null; const home = homeOf(s, g); g.targetX = home.x; g.targetZ = home.z;
          g.reason = 'The scout physically delivered its report at a held waystation and is still walking home.';
        } else { const home = homeOf(s, g); if (home) deposit(s, g, home); deliverReport(s, f.id, g.observations, g.id); g.finished = true; }
      }
    }
    // Stranded parties keep their cargo and unreturned observations in the
    // field. Finite provisions and real attrition end a failed journey; elapsed
    // time alone never teleports people, inventory or intelligence home.
  }
}

function fieldEncounters(s) {
  const armies = s.groups.filter(canFight);
  for (const a of armies) {
    if (!canFight(a) || a.combat?.active) continue;
    const af = factionOf(s, groupController(s, a));
    for (const caravan of s.groups) {
      if (caravan.kind !== 'trader' || caravan.finished || caravan.phase !== 'outbound' || groupController(s, caravan) === groupController(s, a) || distance(a, caravan) > 6 || !visibleToGroup(s, a, caravan, 6)) continue;
      if (relation(af, groupController(s, caravan)).status !== 'hostile') continue;
      let loot = 0;
      const existingCargo = KEYS.reduce((sum, key) => sum + (a.carrying[key] || 0), 0);
      for (const key of KEYS) {
        const taken = Math.min(caravan.carrying[key] ?? 0, Math.max(0, a.size * 1.2 - existingCargo - loot));
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
  const bearings = [Math.PI / 4, -Math.PI / 4, Math.PI / 3, -Math.PI / 3, Math.PI / 6, -Math.PI / 6, 0, 1.48, -1.48];
  const bearing = inward + bearings[f.scoutCount % bearings.length] + (random(s) - 0.5) * 0.18;
  const reach = Math.min(WORLD_RADIUS * 1.1, Math.max(110, Math.hypot(p.x, p.z) * (f.scoutCount % 9 === 6 ? 2 : 1.48)) + f.traits.curiosity * 10);
  let x = p.x + Math.cos(bearing) * reach, z = p.z + Math.sin(bearing) * reach;
  const radius = Math.hypot(x, z);
  if (radius > WORLD_RADIUS * .88) { x *= WORLD_RADIUS * .88 / radius; z *= WORLD_RADIUS * .88 / radius; }
  for (let i = 0; i < 12 && terrainAt(x, z, s.seed).height < -0.3; i++) { x *= 0.9; z *= 0.9; }
  return { x, z };
}

function dispatchScout(s, f, homes) {
  const active = s.groups.filter(g => groupController(s, g) === f.id && g.kind === 'scout');
  const interval = 24 + Math.round((1 - f.traits.curiosity) * 24);
  const firstCycle = 13 + s.factions.indexOf(f) * 3;
  if (s.tick < firstCycle || s.tick - f.lastScout < (f.scoutCount ? interval : firstCycle) || active.length >= 2 || s.groups.length >= MAX_GROUPS) return;
  const p = homes.slice().sort((a, b) => b.population - a.population)[0];
  if (!p || p.population - p.soldiers < 20) return;
  const civilianAway = s.groups.reduce((n, g) => n + (g.originId === p.id && g.kind !== 'army' ? g.size : 0), 0);
  const size = Math.round(clamp(3 + p.population / 180, 3, 8));
  const localAvailable = Math.min(p.availableWorkers ?? Infinity, p.population - p.soldiers - civilianAway);
  if (localAvailable < size + 8) return;
  const biology = { ...f, species: factionOf(s, p.factionId)?.species || f.species };
  const costs = provisions(biology, size, false);
  if (!canPay(p, costs, 8)) return;
  pay(s, p, costs);
  // A stale report saying 'ours' is not proof that a distant former holding
  // is still friendly. Revisit it physically instead of reading hidden control.
  const rivals = knownReports(s, f, { kind: 'settlement', minConfidence: .1, includeOwn: true }).filter(k => !['camp', 'ruin'].includes(k.status) && !active.some(g => g.surveyTargetId === k.id));
  rivals.sort((a, b) => a.observedTick - b.observedTick || distance(p, a) - distance(p, b));
  const refresh = rivals[0] && s.tick - rivals[0].observedTick > 70 ? rivals[0] : null;
  const target = refresh ? { x: refresh.x, z: refresh.z } : exploratoryTarget(s, f, p);
  const g = { id: 'g' + s.nextId++, factionId: p.factionId, commandFactionId: f.id, originId: p.id, kind: 'scout',
    x: p.x, z: p.z, prevX: p.x, prevZ: p.z, targetX: target.x, targetZ: target.z, targetId: null, phase: 'outbound',
    size, initialSize: size, supply: 100, morale: 88, speed: biology.species === 'hive' ? 4.0 : 4.2,
    carrying: emptyCargo(), observations: [], createdTick: s.tick, createdTime: s.time ?? s.tick,
    surveyTargetId: refresh?.id ?? null, reason: refresh ? 'Revisiting a reported rival position; fresh observations still have to come home.' : f.scoutCount ? 'Surveying another compass bearing; discoveries must be brought home.' : 'First survey beyond the settlement; no foreign positions are known.' };
  s.groups.push(g);
  p.availableWorkers = Math.max(0, (p.availableWorkers || 0) - size);
  if (p.assigned) { p.assigned.scouts = (p.assigned.scouts || 0) + size; p.assigned.civilianAway = (p.assigned.civilianAway || 0) + size; }
  f.lastScout = s.tick; f.scoutCount++;
  if (f.scoutCount <= 2 || f.scoutCount % 4 === 0) emit(s, 'scout', `${f.name} sent ${size} scouts beyond ${p.name}. They leave production until their report returns.`, f.id, { groupId: g.id, originId: p.id });
}

function chooseExpedition(s, f, homes) {
  if (s.tick < 100 || s.groups.length >= MAX_GROUPS || s.groups.some(g => groupController(s, g) === f.id && g.kind === 'army')) return;
  const cooldown = 70 + Math.round((1 - f.traits.aggression) * 55);
  if (s.tick - f.lastArmy < cooldown) return;
  const known = knownReports(s, f, { kind: 'settlement', maxAge: 230, minConfidence: .3, includeOwn: false }).filter(k => k.ownerId && !['camp', 'ruin'].includes(k.status));
  if (!known.length) { if (s.tick % 12 === 0) f.intent = 'Exploring: no returned report identifies a foreign settlement.'; return; }
  const resources = knownReports(s, f, { kind: 'resource', maxAge: 230, minConfidence: .3 }).filter(k => (k.amountEstimate ?? k.abundanceEstimate ?? 0) >= 600);
  let best = null;
  for (const p of homes) {
    const staple = f.species === 'machine' ? 'energy' : 'food';
    const need = p.stock[staple] < p.population * 0.25 || p.stock.materials < p.population * 0.20;
    for (const k of known) {
      const r = relation(f, k.ownerId);
      if (['allied', 'trade'].includes(r.status)) continue;
      const distanceTo = distance(p, k);
      if (distanceTo > WORLD_RADIUS * 2.1 || s.tick - (f.unreachableTargets?.[k.id] ?? -100) < 45) continue;
      const deposit = resources.find(resource => distance(resource, k) < 64 && distance(p, resource) <= distanceTo * 0.9 + 10 &&
        (resource.resourceKind === 'materials' || resource.resourceKind === staple));
      // Territorial societies can contest a valuable, genuinely reported
      // deposit on a shared frontier even before famine. The claim is derived
      // solely from delivered maps and personalities, never hidden enemy stores.
      const frontierClaim = !!deposit && s.tick >= 280 && f.traits.aggression >= .62 && f.traits.cooperation < .72 && distance(p, deposit) < 86 && distanceTo < 158;
      // Every independent society competes for sovereignty. Personality changes
      // timing, preferred targets, trade, and risk rather than opting out of war.
      if (r.lastConflict != null && s.tick - r.lastConflict < 35) continue;
      const appetite = .42 + f.traits.aggression * .35 + f.traits.industry * .12 + (need ? .12 : 0) + (deposit ? .12 : 0) + (r.status === 'hostile' ? .18 : 0) - f.traits.cooperation * .06;
      const age = s.tick - k.observedTick;
      const available = Math.max(0, p.soldiers - deployed(s, p) - 12);
      const reportedDefenders = Math.max(1, k.soldiersEstimate ?? k.populationEstimate * 0.22);
      const vulnerability = clamp((available - reportedDefenders) * 0.17, -12, 11);
      const damageOpportunity = Math.max(0, 70 - (k.healthEstimate ?? 100)) * 0.065;
      const score = appetite * 30 + k.confidence * 10 + vulnerability + damageOpportunity - distanceTo * 0.085 - age * 0.025;
      if (!best || score > best.score) best = { p, k, need, deposit, frontierClaim, score, distanceTo };
    }
  }
  if (!best) { if (s.tick % 12 === 0) f.intent = 'Seeking a fresh reachable rival report and waiting for temporary truces to expire.'; return; }
  const { p, k, need, deposit, frontierClaim } = best;
  const available = countMilitary(availableMilitary(s, p)) - (p.assigned?.towerCrew || 0);
  const size = Math.min(200, Math.max(0, available - Math.max(6, Math.ceil(p.soldiers * 0.14))));
  const estimate = Math.max(1, k.soldiersEstimate ?? k.populationEstimate * 0.22);
  p.militaryTarget = clamp(.30 + f.traits.aggression * .10, .30, .40);
  if (size < 16 || (size < estimate * .62 && f.traits.aggression < .72)) {
    f.intent = `Training before acting on a ${s.tick - k.observedTick}-cycle-old report; ${size} soldiers available, about ${estimate} reported defenders.`;
    return;
  }
  const biology = { ...f, species: factionOf(s, p.factionId)?.species || f.species };
  const speed = biology.species === 'machine' ? 2.7 : biology.species === 'hive' ? 3.05 : 2.9;
  const stages = s.settlements.filter(h => h.id !== p.id && alive(h) && settlementController(s, h) === f.id && distance(p, h) < best.distanceTo * .85 && distance(h, k) < best.distanceTo * .85 && canPay(h, provisions(biology, size, true), 8));
  stages.sort((a, b) => distance(p, a) + distance(a, k) - distance(p, b) - distance(b, k));
  const stage = best.distanceTo > 125 ? stages[0] : null;
  const route = findPath(s, p, stage || k, { factionId: f.id, arrival: .45 });
  const onward = stage ? findPath(s, stage, k, { factionId: f.id, arrival: .45 }) : route;
  if (!route.reachable || !onward.reachable) { f.unreachableTargets ??= {}; f.unreachableTargets[k.id] = s.tick; f.intent = 'The reported rival has no traversable approach; another known route is needed.'; return; }
  const maxLeg = Math.max(route.length, onward.length), routeLength = stage ? route.length + onward.length : route.length;
  const expectedTravelCycles = Math.ceil(routeLength * 2 / (speed * .70 * modifier(f, 'movement')));
  const routeSupplyBudget = Math.ceil(maxLeg * 2 / (speed * .70 * modifier(f, 'movement'))) * (.68 + size * .0014) / modifier(f, 'supplyEfficiency') + 18;
  const provisionFactor = Math.max(1, routeSupplyBudget / 86);
  if (provisionFactor > 3.5) { f.intent = 'The known march would require more rations than this expedition can carry.'; return; }
  const costs = Object.fromEntries(Object.entries(provisions(biology, size, true)).map(([key, value]) => [key, value * provisionFactor]));
  if (!canPay(p, costs, Math.max(12, p.population * 0.05))) {
    f.intent = `Building expedition stocks; intelligence alone cannot feed ${size} soldiers on the march.`;
    return;
  }
  pay(s, p, costs);
  const reason = `${relation(f, k.ownerId).status === 'hostile' ? 'An unresolved frontier conflict' : frontierClaim ? 'A territorial claim on a reported ' + deposit.resourceKind + ' deposit shared with the rival frontier' : deposit ? 'A campaign to secure reported ' + deposit.resourceKind + ' stores and territory' : 'A campaign against an independently reported rival settlement'}; a returned report observed about ${estimate} defenders ${s.tick - k.observedTick} cycles ago.`;
  const g = { id: 'g' + s.nextId++, factionId: p.factionId, commandFactionId: f.id, originId: p.id, kind: 'army',
    x: p.x, z: p.z, prevX: p.x, prevZ: p.z, targetX: stage?.x ?? k.x, targetZ: stage?.z ?? k.z, targetId: k.id, phase: 'outbound',
    missionTargetX: k.x, missionTargetZ: k.z, stagingHomeId: stage?.id ?? null, stagingTargetId: stage?.id ?? null, stagingPurpose: stage ? 'outbound' : null, provisionFactor,
    size, initialSize: size, units: allocateMilitary(s, p, size), supply: 100, morale: 80 + f.traits.aggression * 12,
    speed, campaign: true, missionOrderTick: s.tick, expectedTravelCycles, routeSupplyBudget: Math.round(routeSupplyBudget),
    carrying: emptyCargo(), observations: [], createdTick: s.tick, createdTime: s.time ?? s.tick, reason,
    intelligence: { observedTick: k.observedTick, reportedTick: k.reportedTick, confidence: k.confidence, populationEstimate: k.populationEstimate, soldiersEstimate: estimate } };
  s.groups.push(g);
  f.lastArmy = s.tick;
  s.stats.mobilisations = (s.stats.mobilisations || 0) + 1;
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
    refreshExileBases(s);
    const remaining = [];
    for (const packet of s.pendingReports) {
      if (packet.dueTick <= s.tick) deliverReport(s, packet.factionId, packet.observations, packet.groupId, packet.method, packet.explorationMask);
      else remaining.push(packet);
    }
    s.pendingReports = remaining;
  }
  updateGroups(s, dt, cycleBoundary);
  stepCombat(s, dt, { retreat: returnHome, hostility: recordHostility });
  if (cycleBoundary) { fieldEncounters(s); updateConquest(s); }
  s.groups = s.groups.filter(g => g.kind === 'worker' || g.kind === 'colonist' || (!g.finished && g.size > 0));
  if (!cycleBoundary) return;
  for (const f of s.factions) {
    if (f.defeatedBy || s.outcome?.status === 'victory') continue;
    const homes = s.settlements.filter(p => alive(p) && (p.factionId === f.id && !p.occupiedBy || p.exileBaseFor === f.id && settlementController(s, p) === f.id));
    if (!homes.length) continue;
    dispatchScout(s, f, homes);
    chooseExpedition(s, f, homes);
  }
}
