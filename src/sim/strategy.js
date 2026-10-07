import { clamp, distance, emit, random } from '../shared.js';
import { terrainAt, WORLD_RADIUS } from '../world.js';
import { allocateMilitary, applyMilitaryCasualties, availableMilitary, countMilitary, deployMilitary, getSoldiers, returnMilitary, demobilizeMilitary, refreshExileBases } from './military.js';
import { stepCombat, canFight } from './combat.js';
import { syncGroupSoldiers, touchSoldiers } from './soldiers.js';
import { planStrategy } from './planner.js';
import { observeGroup, reportObservations, knownReports, visibleToGroup } from './knowledge.js';
import { moveAlongRoute, isSegmentTraversable, findPath } from './navigation.js';
import { factionController, settlementController, groupController, occupySettlement, updateConquest } from './conquest.js';

// Decisions read faction reports, including live scout observations. Other
// field parties retain local observations until they physically report them.
const KEYS = ['food', 'water', 'energy', 'materials'];
const MAX_GROUPS = 480;
const factionOf = (s, id) => s.factions.find(f => f.id === id);
const homeOf = (s, g) => s.settlements.find(p => p.id === g.originId);
const alive = p => p && p.population > 0 && p.health > 0 && !['camp', 'ruin'].includes(p.status);
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
    f.campaignOrders ??= {};
    // Stored reports remain snapshots; decision helpers enforce their age.
  }
  for (const g of s.groups) if (g.kind === 'army' && !g.commandOrderRecorded) rememberCampaignOrder(s, g, g.createdTick ?? s.tick);
  for (const f of s.factions) for (const [id, order] of Object.entries(f.campaignOrders)) if (s.tick > order.expiresTick) delete f.campaignOrders[id];
}

function rememberCampaignOrder(s, g, issuedTick = s.tick) {
  const f = factionOf(s, groupController(s, g));
  if (!f) return;
  const home = homeOf(s, g), target = { x: g.missionTargetX ?? g.targetX, z: g.missionTargetZ ?? g.targetZ };
  const travel = g.expectedTravelCycles ?? (home && Number.isFinite(target.x) && Number.isFinite(target.z) ? Math.ceil(distance(home, target) * 2 / Math.max(.5, (g.speed || 2.8) * .70)) : 120);
  f.campaignOrders ??= {};
  f.campaignOrders[g.id] = { groupId: g.id, originId: g.originId, targetId: g.targetId ?? null,
    size: g.cohesionSize ?? g.initialSize ?? g.size, issuedTick, expiresTick: issuedTick + Math.max(60, travel) + 48 };
  g.commandOrderRecorded = true; g.commandOrderFactionId = f.id;
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
  if (g.kind === 'scout') reportObservations(s, f, observed, { method: 'scout-sight', group: g });
  for (const o of observed) {
    if (f.seenObjects[o.id]) continue;
    f.seenObjects[o.id] = s.tick; s.stats.discoveries++;
    if (o.kind === 'settlement' || g.observations.length <= 2) emit(s, 'discovery',
      `${f.name}'s ${groupName(g)} spotted ${o.kind === 'settlement' ? o.name || 'a foreign settlement' : o.resourceKind ? o.resourceKind + ' deposits' : 'a terrain passage'}; ${g.kind === 'scout' ? 'its current sight is shared with the faction' : 'its report is still travelling'}.`,
      f.id, { groupId: g.id, targetId: o.id, knowledgePending: g.kind !== 'scout' });
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
  g.rallyGroupId = null; g.rallyWaitUntil = null;
  g.strategicHold = null; g.operationId = null;
  if (g.combat) { g.combat.active = false; g.combat.resumePhase = null; g.combat.intent = retreat ? 'retreat' : 'return'; g.combat.reason = reason; }
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
  const f = factionOf(s, groupController(s, g)), ground = terrainAt(g.x, g.z, s.terrainSeed || s.seed);
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
  let adaptation = f.species === 'human' ? (!terrain.balancedDistrict && terrain.biome === 'meadow' ? 1.14 : 1)
    : f.species === 'hive' ? (!terrain.balancedDistrict && terrain.biome === 'alien' ? 1.22 : 1.02) : 1.03 + level * 0.025;
  if (defending) adaptation *= modifier(f, 'defense');
  const experience = 1 + Math.min(0.18, (f.experience.combat ?? 0) * 0.008);
  return size * adaptation * experience * (1 + level * 0.06) *
    (0.46 + Math.max(0, supply) * 0.0054) * (0.42 + Math.max(0, morale) * 0.0058);
}

function soldiersAtSettlement(s, g, town, radius = 5) {
  return getSoldiers(s, g).filter(soldier => soldier.positioned && distance(soldier, town) <= radius &&
    isSegmentTraversable(s, soldier, town, { factionId: groupController(s, g), radius: .15 }));
}

function raid(s, g, town) {
  const f = factionOf(s, groupController(s, g)), defender = factionOf(s, settlementController(s, town));
  const terrain = terrainAt(town.x, town.z, s.terrainSeed || s.seed);
  const present = soldiersAtSettlement(s, g, town).length;
  if (!present) return;
  const garrison = countMilitary(availableMilitary(s, town));
  const attack = power(s, nativeProfile(s, g, f), present, g.supply, g.morale, terrain);
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
  const canReachStores = present > 0;
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
    const remainingDefenders = countMilitary(availableMilitary(s, town));
    g.reason = `Siege cycle ${g.siegeDays}: ${remainingDefenders} defenders remain; settlement integrity ${Math.round(town.health)}%; field supply ${Math.round(g.supply)}%.`;
    const brokenDefense = remainingDefenders <= Math.max(4, Math.floor(g.initialGarrison * .55)) || attack > defense * 1.25 || town.defenseMorale < 28;
    if (g.siegeDays >= 6 && town.health <= 18 && brokenDefense && canReachStores && present >= 12 && g.supply >= 16 && g.morale >= 35) {
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
  const heldIds = new Set(s.settlements.filter(p => alive(p) && settlementController(s, p) === f.id).map(p => p.id));
  const candidates = knownReports(s, f, { kind: 'settlement', maxAge: 230, minConfidence: .3, includeOwn: false }).filter(k => !heldIds.has(k.id) && k.ownerId && !['camp', 'ruin'].includes(k.status) && !['allied', 'trade'].includes(relation(f, k.ownerId).status) && distance(g, k) <= 150 && g.size >= (k.soldiersEstimate || 1) * .85);
  candidates.sort((a, b) => distance(g, a) + (a.soldiersEstimate || 0) * .4 - distance(g, b) - (b.soldiersEstimate || 0) * .4);
  let next = null;
  for (const target of candidates) {
    const route = campaignRoute(s, f, g, target, g.size, g.speed ?? 2.8, null, g);
    if (!route || route.provisionFactor > 3.5) continue;
    const factor = Math.max(g.provisionFactor || 1, route.provisionFactor);
    // Supply is a percentage of the paid pack capacity. A longer next leg must
    // buy its additional rations as well as replace those already consumed.
    const refill = Math.max(0, .90 * factor - g.supply / 100 * (g.provisionFactor || 1));
    const costs = Object.fromEntries(Object.entries(provisions(nativeProfile(s, g, f), g.size, true)).map(([key, value]) => [key, value * refill]));
    if (!canPay(captured, costs, 8)) continue;
    next = { target, route, factor, costs }; break;
  }
  if (!next) return false;
  const { target, route, factor, costs } = next;
  pay(s, captured, costs);
  g.supply = Math.max(90, g.supply * (g.provisionFactor || 1) / factor);
  g.provisionFactor = factor; g.expectedTravelCycles = route.expectedTravelCycles; g.routeSupplyBudget = Math.round(route.routeSupplyBudget);
  g.phase = 'outbound'; g.missionOrderTick = s.tick; g.targetId = target.id; g.targetX = target.x; g.targetZ = target.z; g.missionTargetX = target.x; g.missionTargetZ = target.z; g.stagingTargetId = null; g.stagingPurpose = null; g.stagingHomeId = captured.id; g.engagedDays = 0; g.siegeMode = false; g.siegeDays = 0; g.cohesionSize = g.size; delete g.initialGarrison;
  if (g.combat) g.combat.active = false;
  g.morale = Math.min(96, g.morale + 9);
  g.reason = `After occupying ${captured.name}, the surviving force uses local supplies and a returned report to continue its campaign.`;
  g.intelligence = { observedTick: target.observedTick, reportedTick: target.reportedTick, confidence: target.confidence, soldiersEstimate: target.soldiersEstimate };
  rememberCampaignOrder(s, g);
  s.stats.campaignLegs = (s.stats.campaignLegs || 0) + 1;
  emit(s, 'campaign', `${f.name}'s ${g.size} surviving soldiers continue from ${captured.name} toward another reported rival.`, f.id, { groupId: g.id, targetId: target.id, originId: captured.id, provisions: costs });
  return true;
}

function continueFieldObjective(s, g, f) {
  if (g.supply < 60 || g.morale < 65 || g.size < 4) return false;
  const reports = [...(g.observations || []), ...knownReports(s, f, { maxAge: 80, minConfidence: .4, includeOwn: false })];
  const candidates = reports.filter(k => k.id !== g.targetId && k.ownerId && k.ownerId !== f.id && relation(f, k.ownerId).status === 'hostile' &&
    s.tick - k.observedTick <= 80 && distance(g, k) < 35 &&
    (k.kind === 'group' && k.groupKind === 'worker' && k.sizeEstimate <= g.size || k.kind === 'settlement' && !['camp', 'ruin'].includes(k.status) && (k.soldiersEstimate ?? Infinity) < g.size * .65))
    .sort((a, b) => distance(g, a) - distance(g, b));
  for (const k of candidates) {
    const route = findPath(expeditionPlanningWorld(s, f, g), g, k, { factionId: f.id, arrival: .45, maxExpansions: 800 });
    if (!route.reachable || route.length > 45) continue;
    Object.assign(g, { targetId: k.id, targetX: k.x, targetZ: k.z, missionTargetX: k.x, missionTargetZ: k.z,
      missionKind: k.kind === 'group' ? 'harassment' : 'campaign', phase: 'outbound', reason: 'Continuing toward a nearby reported field opportunity with existing paid supplies.' });
    if (g.combat) g.combat.active = false;
    rememberCampaignOrder(s, g); return true;
  }
  return false;
}

function arriveArmy(s, g, cycleBoundary) {
  const f = factionOf(s, groupController(s, g));
  if (g.stagingTargetId && g.phase !== 'engaging') {
    const depot = s.settlements.find(p => p.id === g.stagingTargetId), purpose = g.stagingPurpose;
    if (alive(depot) && settlementController(s, depot) === f.id && distance(g, depot) <= 1 &&
      soldiersAtSettlement(s, g, depot, Math.max(5, depot.radius ?? 8)).length < g.size) return;
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
    // The route centre can arrive before a wounded soldier or rear rank.
    // Keep the expedition and its cargo/report commitment in the field until
    // every surviving body has physically reached the home settlement.
    if (home && soldiersAtSettlement(s, g, home, Math.max(5, home.radius ?? 8)).length < g.size) return;
    if (home) deposit(s, g, home);
    deliverReport(s, groupController(s, g), g.observations ?? [], g.id, 'expedition');
    emit(s, 'return', `${f.name}'s expedition returned with ${g.size} of ${g.initialSize} soldiers.`, f.id, { groupId: g.id, targetId: g.originId });
    const issuingFaction = factionOf(s, g.commandOrderFactionId || f.id);
    if (issuingFaction?.campaignOrders) delete issuingFaction.campaignOrders[g.id];
    returnMilitary(s, home, g);
    if (home && ((home.occupiedBy && home.exileBaseFor !== groupController(s, g)) || f.defeatedBy || g.surrendered)) demobilizeMilitary(s, home, g.size, { soldierIds: g.soldierIds });
    return;
  }
  if (g.missionKind === 'harassment') {
    const worker = s.groups.find(other => other.id === g.targetId);
    if (worker && !worker.finished && visibleToGroup(s, g, worker, 18) && worker.size > 0 && relation(f, groupController(s, worker)).status === 'hostile') {
      g.phase = 'engaging'; return;
    }
    if (!continueFieldObjective(s, g, f)) returnHome(s, g, 'The reported work party is no longer exposed; returning with current observations.');
    return;
  }
  const target = s.settlements.find(p => p.id === g.targetId);
  if (!alive(target) || settlementController(s, target) === factionController(s, f.id) || ['allied', 'trade'].includes(relation(f, settlementController(s, target)).status)) {
    if (!continueFieldObjective(s, g, f)) returnHome(s, g, 'The old target is gone or now friendly; no suitable nearby field objective is known.');
    return;
  }
  if (!visibleToGroup(s, g, target, 18)) { returnHome(s, g, 'The reported coordinates yielded no current local contact.'); return; }
  g.phase = 'engaging';
}

function armyReturnReserve(s, g, f) {
  const home = homeOf(s, g), depot = g.stagingHomeId && s.settlements.find(p => p.id === g.stagingHomeId);
  const destination = alive(depot) && settlementController(s, depot) === f.id && distance(g, depot) > 1 && distance(depot, home) < distance(g, home) * .9 ? depot : home;
  if (!destination) return 45;
  const previous = g.returnSupplyPlan;
  if (previous?.destinationId === destination.id && s.tick - previous.tick < 10 && distance(previous, g) < 12) return previous.reserve;
  // A brief skirmish must not end a campaign merely because its next movement
  // pulse crosses a fixed percentage. Keep enough for the known physical walk
  // back, plus a buffer; a depleted army still has to abandon the objective.
  const route = findPath(expeditionPlanningWorld(s, f, g), g, destination, { factionId: f.id, arrival: .45 });
  const cycles = route.reachable ? route.length / Math.max(.5, (g.speed || 2.8) * .70 * modifier(f, 'movement')) : null;
  const reserve = cycles == null ? 45 : Math.max(21, Math.ceil(cycles * (.86 + g.size * .0014) / modifier(f, 'supplyEfficiency') / (g.provisionFactor || 1) + 8));
  g.returnSupplyPlan = { destinationId: destination.id, tick: s.tick, x: g.x, z: g.z, reserve };
  return reserve;
}

// Compatible parties combine only at physical contact and only within the same
// native census. Other homes keep separate squads on the shared frontline.
export function coordinateFrontlines(s, f) {
  const armies = s.groups.filter(g => g.kind === 'army' && !g.finished && !g.disabled && groupController(s, g) === f.id);
  const fronts = armies.filter(g => g.campaign && !g.rallyGroupId && !['returning', 'retreating'].includes(g.phase) && g.supply >= 45 && g.morale >= 55)
    .sort((a, b) => (a.createdTick ?? 0) - (b.createdTick ?? 0) || a.id.localeCompare(b.id));
  for (const g of armies) {
    if (g.operationId && f.strategy?.operation?.id === g.operationId) continue;
    if (g.finished || g.phase === 'retreating' || g.morale < 65 || g.supply < 55 || getSoldiers(s, g).some(body => body.withdrawing)) continue;
    let leader = g.rallyGroupId && armies.find(other => other.id === g.rallyGroupId && !other.finished && !['returning', 'retreating'].includes(other.phase));
    if (!leader) leader = fronts.find(other => other !== g && !other.finished && (other.createdTick ?? 0) <= (g.createdTick ?? 0) &&
      (g.phase === 'returning' ? distance(g, other) < 35 : g.campaign && other.targetId === g.targetId && other.id.localeCompare(g.id) < 0));
    if (!leader) {
      if (g.rallyGroupId && Number.isFinite(g.missionTargetX) && Number.isFinite(g.missionTargetZ)) { g.targetX = g.missionTargetX; g.targetZ = g.missionTargetZ; }
      g.rallyGroupId = null; continue;
    }
    if (g.frontlineJoinedId === leader.id && g.phase !== 'returning') continue;
    if (g.phase === 'returning' && g.supply < armyReturnReserve(s, g, f) + 20) continue;
    g.rallyGroupId = leader.id; g.campaign = true;
    if (g.phase !== 'engaging') {
      g.phase = 'outbound'; g.targetId = leader.targetId; g.missionTargetX = leader.missionTargetX ?? leader.targetX; g.missionTargetZ = leader.missionTargetZ ?? leader.targetZ;
      const home = homeOf(s, leader), gap = Math.max(1, distance(home, leader));
      g.targetX = leader.x + (home.x - leader.x) / gap * 5; g.targetZ = leader.z + (home.z - leader.z) / gap * 5;
      g.reason = 'Reinforcing the existing frontline before committing another small isolated force.';
    }
    if (distance(g, leader) < 24 && distance(g, leader) > 7 && !leader.combat?.active && (s.time ?? s.tick) - (leader.lastRallyWait ?? -100) > 25) {
      leader.lastRallyWait = s.time ?? s.tick; leader.rallyWaitUntil = leader.lastRallyWait + 5;
    }
    const incoming = getSoldiers(s, g), present = getSoldiers(s, leader);
    if (g.originId !== leader.originId && distance(g, leader) < 8 && incoming.every(body => distance(body, leader) < 12)) {
      g.frontlineJoinedId = leader.id; g.rallyGroupId = null; g.targetX = g.missionTargetX; g.targetZ = g.missionTargetZ;
      continue;
    }
    if (g.originId !== leader.originId || g.combat?.active || leader.combat?.active || !incoming.length || !present.length || distance(g, leader) > 8 || incoming.some(body => distance(body, leader) > 12)) continue;
    const total = g.size + leader.size, factor = ((leader.provisionFactor || 1) * leader.size + (g.provisionFactor || 1) * g.size) / total;
    leader.supply = (leader.supply * (leader.provisionFactor || 1) * leader.size + g.supply * (g.provisionFactor || 1) * g.size) / (total * factor);
    leader.provisionFactor = factor; leader.morale = (leader.morale * leader.size + g.morale * g.size) / total;
    leader.initialSize = (leader.initialSize ?? leader.size) + g.size; leader.cohesionSize = (leader.cohesionSize ?? leader.size) + g.size;
    for (const body of incoming) { body.groupId = leader.id; leader.soldierIds.push(body.id); }
    leader.carrying ||= emptyCargo();
    for (const key of KEYS) { leader.carrying[key] = (leader.carrying[key] || 0) + (g.carrying?.[key] || 0); if (g.carrying) g.carrying[key] = 0; }
    leader.observations ||= []; for (const observation of g.observations || []) if (!leader.observations.some(o => o.id === observation.id && o.observedTick >= observation.observedTick)) leader.observations.push(observation);
    g.soldierIds = []; g.formationSlots = { infantry: [], ranged: [] }; g.finished = true; g.militaryReturned = true;
    syncGroupSoldiers(s, g); syncGroupSoldiers(s, leader); touchSoldiers(s); leader.rallyWaitUntil = null;
    delete f.campaignOrders?.[g.id]; rememberCampaignOrder(s, leader);
    s.stats.reinforcementMerges = (s.stats.reinforcementMerges || 0) + 1;
  }
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
      const ground = terrainAt(g.x, g.z, s.terrainSeed || s.seed);
      const drain = g.kind === 'army' ? 0.62 + g.size * 0.0014 + ground.roughness * 0.24 : 0.4;
      g.supply = g.kind === 'trader' && g.provisionCycles
        ? Math.max(0, 100 * (1 - ((s.time ?? s.tick) - g.createdTick) / g.provisionCycles))
        : Math.max(0, g.supply - drain / modifier(f, 'supplyEfficiency') / (g.provisionFactor || 1));
      if (g.supply < 25) g.morale = Math.max(0, g.morale - 1.1);
      if ((g.phase === 'outbound' || g.kind === 'army' && g.phase === 'engaging') && (g.supply < (g.kind === 'army' ? armyReturnReserve(s, g, f) : 35) || g.morale < 40)) {
        returnHome(s, g, 'The supply reserve must cover the journey home.', g.kind === 'army');
      }
      if (g.supply === 0) casualties(s, g, g.kind === 'army' ? Math.max(0.2, g.size * 0.008) : g.kind === 'trader' ? Math.max(.04, g.size * .008) : .055);
      if (g.finished) continue;
    }
    if (g.kind === 'army' && g.phase === 'engaging') {
      if (cycleBoundary && g.missionKind === 'harassment' && g.combat?.targetKind === 'worker') {
        const worker = s.groups.find(other => other.id === g.combat.targetId);
        if (!worker || !visibleToGroup(s, g, worker, 18) || worker.finished) {
          if (!continueFieldObjective(s, g, f)) returnHome(s, g, 'The exposed work-party objective has ended.');
        }
      }
      if (cycleBoundary) observe(s, g);
      continue;
    }
    if (g.kind === 'army' && (g.rallyWaitUntil ?? 0) > (s.time ?? s.tick) && !g.combat?.active) continue;
    const arrived = move(s, g, dt);
    // A whole-cycle survey overlaps the previous sight radius even at maximum
    // movement speed; arrivals also survey before delivering a report.
    if (g.kind !== 'trader' && (cycleBoundary || arrived)) observe(s, g);
    if (arrived) {
      if (g.kind === 'army' && g.strategicHold) continue;
      if (g.kind === 'scout' && g.fieldRaidTargetId && g.phase === 'outbound') continue;
      if (g.kind === 'army' && g.rallyGroupId && g.phase === 'outbound') {
        const leader = s.groups.find(other => other.id === g.rallyGroupId && !other.finished);
        if (leader && !['returning', 'retreating'].includes(leader.phase)) { g.targetX = leader.targetX; g.targetZ = leader.targetZ; g.rallyGroupId = null; }
        continue;
      }
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
  for (let i = 0; i < 12 && terrainAt(x, z, s.terrainSeed || s.seed).height < -0.3; i++) { x *= 0.9; z *= 0.9; }
  return { x, z };
}

export function economicSurveyTarget(s, f, home, active = []) {
  const reports = knownReports(s, f, { maxAge: 140, minConfidence: .5, includeOwn: false });
  const workers = reports.filter(k => k.kind === 'group' && k.groupKind === 'worker' && k.sizeEstimate > 0 && s.tick - k.observedTick >= 18 && s.tick - k.observedTick <= 100 && relation(f, k.ownerId).status === 'hostile');
  const resources = knownReports(s, f, { kind: 'resource', maxAge: 180, minConfidence: .5 });
  const candidates = [];
  for (const report of workers) {
    const site = resources.filter(k => distance(k, report) <= 10 && (k.amountEstimate ?? 0) > 20).sort((a, b) => distance(a, report) - distance(b, report) || a.id.localeCompare(b.id))[0];
    // A known worksite is persistent; a vanished party's exact old position is
    // not a useful destination for repeated long reconnaissance trips.
    if (!site || active.some(g => g.surveyTargetId === site.id) || s.tick - (f.economicSurveys?.[site.id] ?? -200) < 100) continue;
    const d = distance(home, site); if (d < 30 || d > 150) continue;
    const point = { x: site.x + (home.x - site.x) / d * 12, z: site.z + (home.z - site.z) / d * 12 };
    const danger = reports.some(k => k.ownerId !== f.id && !['allied', 'trade'].includes(relation(f, k.ownerId).status) &&
      (k.kind === 'group' && k.groupKind === 'army' && s.tick - k.observedTick <= 24 && distance(k, point) < 22 || k.kind === 'settlement' && (k.soldiersEstimate ?? 0) >= 4 && !['camp', 'ruin'].includes(k.status) && distance(k, point) < 24));
    if (!danger) candidates.push({ ...point, id: site.id, observedTick: report.observedTick, score: Math.min(16, report.sizeEstimate) - d * .08 - (s.tick - report.observedTick) * .05 });
  }
  candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  for (const candidate of candidates.slice(0, 3)) {
    const path = findPath(expeditionPlanningWorld(s, f), home, candidate, { factionId: f.id, maxExpansions: 800 });
    if (path.reachable && path.length <= 165) return candidate;
  }
  return null;
}

function dispatchScout(s, f, homes) {
  const active = s.groups.filter(g => groupController(s, g) === f.id && g.kind === 'scout');
  const interval = 24 + Math.round((1 - f.traits.curiosity) * 24);
  const firstCycle = 13 + s.factions.indexOf(f) * 3;
  if (s.tick < firstCycle || s.tick - f.lastScout < (f.scoutCount ? interval : firstCycle) || active.length >= 2 || s.groups.length >= MAX_GROUPS) return;
  const p = homes.slice().sort((a, b) => b.population - a.population)[0];
  if (!p || p.population - p.soldiers < 20) return;
  const civilianAway = s.groups.reduce((n, g) => n + (g.originId === p.id && g.kind !== 'army' ? g.size : 0), 0);
  const size = 1;
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
  const economic = !refresh && f.scoutCount % 2 === 0 ? economicSurveyTarget(s, f, p, active) : null;
  const target = refresh ? { x: refresh.x, z: refresh.z } : economic || exploratoryTarget(s, f, p);
  const g = { id: 'g' + s.nextId++, factionId: p.factionId, commandFactionId: f.id, originId: p.id, kind: 'scout',
    x: p.x, z: p.z, prevX: p.x, prevZ: p.z, targetX: target.x, targetZ: target.z, targetId: null, phase: 'outbound',
    size, initialSize: size, supply: 100, morale: 88, speed: biology.species === 'hive' ? 4.0 : 4.2,
    carrying: emptyCargo(), observations: [], createdTick: s.tick, createdTime: s.time ?? s.tick,
    surveyTargetId: refresh?.id ?? economic?.id ?? null, surveyPurpose: economic ? 'economic' : 'exploration',
    reason: refresh ? 'Revisiting a reported rival position and sharing live local sight.' : economic ? 'Checking a previously observed enemy worksite from its near side; only actual scout sight can refresh worker activity.' : 'Surveying and sharing live sight within this scout’s actual vision and line of sight.' };
  if (economic) (f.economicSurveys ||= {})[economic.id] = s.tick;
  s.groups.push(g);
  p.availableWorkers = Math.max(0, (p.availableWorkers || 0) - size);
  if (p.assigned) { p.assigned.scouts = (p.assigned.scouts || 0) + size; p.assigned.civilianAway = (p.assigned.civilianAway || 0) + size; }
  f.lastScout = s.tick; f.scoutCount++;
  if (f.scoutCount <= 2 || f.scoutCount % 4 === 0) emit(s, 'scout', `${f.name} sent one scout beyond ${p.name}. Its local sight is shared live; the individual remains away from production until returning.`, f.id, { groupId: g.id, originId: p.id });
}

export function expeditionPlanningWorld(s, f, observer = null) {
  const held = s.settlements.filter(home => settlementController(s, home) === f.id);
  const sources = held.filter(home => alive(home) && (home.homePresent ?? home.population) > 0)
    .map(home => ({ ...home, factionId: f.id, commandFactionId: f.id }));
  for (const home of held) if (alive(home)) for (const building of home.buildings || []) {
    if (building.kind === 'tower' && building.progress >= 1 && !building.destroyed && (building.hp ?? 1) > 0 && (building.crewAssigned ?? 1) > 0) sources.push({ ...building, factionId: f.id, commandFactionId: f.id });
  }
  if (observer) sources.push(observer);
  for (const scout of s.groups) if (scout.kind === 'scout' && !scout.finished && scout.size > 0 && groupController(s, scout) === f.id) sources.push(scout);
  const walls = [], add = (wall, ownerId) => {
    if (!['wall', 'gate'].includes(wall.kind)) return;
    if (ownerId === f.id || sources.some(source => visibleToGroup(s, source, wall))) walls.push({ ...wall, factionId: ownerId });
  };
  for (const home of s.settlements) for (const wall of home.buildings || []) add(wall, settlementController(s, home));
  for (const wall of s.walls || []) add(wall, factionController(s, wall.factionId));
  // Delivered settlement reports contain coordinates and estimates, not exact
  // wall geometry. Owned obstacles and actual home/scout sightings inform the
  // capital's route/provision estimate.
  // Real movement still collides with every wall and discovers it locally.
  return { seed: s.seed, terrainSeed: s.terrainSeed, factions: s.factions, settlements: [], walls, navigationRevision: 0 };
}

function homeDefense(s, f, home, reports) {
  const available = countMilitary(availableMilitary(s, home));
  const committed = Object.values(f.campaignOrders || {}).reduce((sum, order) => sum + (order.originId === home.id ? order.size : 0), 0);
  const sources = [{ ...home, factionId: f.id, commandFactionId: f.id }];
  for (const tower of home.buildings || []) if (tower.kind === 'tower' && tower.progress >= 1 && !tower.destroyed && (tower.hp ?? 1) > 0 && tower.crewAssigned > 0) {
    sources.push({ ...tower, factionId: f.id, commandFactionId: f.id });
  }
  // A distant scout's unreturned discovery is not a home-defense alarm. Count
  // hostile bodies only after a home or its staffed tower actually sees them.
  const threats = s.groups.filter(g => g.kind === 'army' && !g.finished && g.size > 0 &&
    sources.some(source => visibleToGroup(s, source, g)) && relation(f, groupController(s, g)).status === 'hostile');
  const observedThreat = threats.reduce((sum, g) => sum + g.size, 0);
  const reportedThreat = reports.reduce((largest, k) => relation(f, k.ownerId).status === 'hostile' && distance(home, k) < 90
    ? Math.max(largest, (k.soldiersEstimate ?? (k.populationEstimate || 0) * .22) * .4) : largest, 0);
  // The demographic ledger loses remote casualties immediately; command has
  // only departure commitments until those soldiers/report couriers return.
  const reserve = Math.max(12, Math.ceil((available + committed) * .30), Math.ceil(reportedThreat), Math.ceil(observedThreat * 1.1));
  // Tower crews are members of the total home reserve, not additional people.
  // Quote the ready roster before choosing a destination: wounded returnees
  // still count at home but cannot satisfy a new expedition's required force.
  const deployable = countMilitary(allocateMilitary(s, home, Math.max(0, available - Math.max(reserve, home.assigned?.towerCrew || 0))));
  return { available, reserve, observedThreat, threatIds: threats.map(g => g.id).sort(), deployable };
}

function reserveHomeDefense(s, f, homes, reports) {
  for (const home of homes) {
    const defense = homeDefense(s, f, home, reports);
    home.defensePlan = { reserve: defense.reserve, observedThreat: defense.observedThreat, threatIds: defense.threatIds, tick: s.tick };
    if (!defense.observedThreat || defense.available >= defense.reserve) continue;
    let promised = defense.available;
    const nearby = s.groups.filter(g => canFight(g) && g.originId === home.id && groupController(s, g) === f.id && !g.combat?.active && visibleToGroup(s, { ...home, factionId: f.id }, g));
    nearby.sort((a, b) => distance(a, home) - distance(b, home) || a.id.localeCompare(b.id));
    for (const g of nearby) {
      if (promised >= defense.reserve) break;
      // Local runners can recall a departing force still within home sight.
      // Returning troops must physically arrive before they join the garrison.
      returnHome(s, g, 'A locally sighted hostile force threatens home; reinforcing the garrison before continuing the campaign.');
      promised += g.size;
      s.stats.defenseRecalls = (s.stats.defenseRecalls || 0) + 1;
    }
  }
}

function campaignRoute(s, f, from, target, size, speed, stage = null, observer = null) {
  const planning = expeditionPlanningWorld(s, f, observer);
  const route = findPath(planning, from, stage || target, { factionId: f.id, arrival: .45 });
  const onward = stage ? findPath(planning, stage, target, { factionId: f.id, arrival: .45 }) : route;
  if (!route.reachable || !onward.reachable) return null;
  const pace = speed * .70 * modifier(f, 'movement');
  const expectedTravelCycles = Math.ceil((stage ? route.length + onward.length : route.length) * 2 / pace);
  const routeSupplyBudget = Math.ceil(Math.max(route.length, onward.length) * 2 / pace) * (.68 + size * .0014) / modifier(f, 'supplyEfficiency') + 18;
  return { expectedTravelCycles, routeSupplyBudget, provisionFactor: Math.max(1, routeSupplyBudget / 86) };
}

export function dispatchHarassment(s, f, homes) {
  if (f.strategy?.mode === 'recover' || f.strategy?.operation?.phase === 'assemble') return;
  if (s.tick < 70 || s.tick - (f.lastHarassment ?? -40) < 40 || s.groups.length >= MAX_GROUPS ||
    s.groups.filter(g => g.kind === 'army' && !g.finished && groupController(s, g) === f.id).length >= 4 ||
    s.groups.some(g => g.missionKind === 'harassment' && !g.finished && groupController(s, g) === f.id)) return;
  const reported = knownReports(s, f, { kind: 'group', maxAge: 18, minConfidence: .5, includeOwn: false });
  const workers = reported.filter(k => k.groupKind === 'worker' && k.sizeEstimate > 0 && k.sizeEstimate <= 24 && relation(f, k.ownerId).status === 'hostile' &&
    !reported.some(other => other.groupKind === 'army' && other.ownerId === k.ownerId && distance(k, other) < 20));
  for (const home of homes) {
    const defense = homeDefense(s, f, home, []);
    if (defense.observedThreat || defense.deployable < 6) continue;
    const target = workers.filter(k => distance(home, k) < 48).sort((a, b) => distance(home, a) - distance(home, b))[0];
    if (!target) continue;
    const units = allocateMilitary(s, home, Math.min(8, defense.deployable)), size = countMilitary(units);
    if (size < 4) continue;
    const biology = { ...f, species: factionOf(s, home.factionId)?.species || f.species }, speed = 2.9;
    const route = campaignRoute(s, f, home, target, size, speed); if (!route || route.provisionFactor > 2) continue;
    const costs = Object.fromEntries(Object.entries(provisions(biology, size, true)).map(([key, value]) => [key, value * route.provisionFactor]));
    if (!canPay(home, costs, 12)) continue;
    const group = { id: 'g' + s.nextId++, factionId: home.factionId, commandFactionId: f.id, originId: home.id, kind: 'army', missionKind: 'harassment',
      x: home.x, z: home.z, prevX: home.x, prevZ: home.z, targetId: target.id, targetX: target.x, targetZ: target.z, missionTargetX: target.x, missionTargetZ: target.z,
      phase: 'outbound', size, initialSize: size, units, supply: 100, morale: 90, speed, ...route, homeReserve: defense.reserve,
      carrying: emptyCargo(), observations: [], createdTick: s.tick, createdTime: s.time ?? s.tick,
      reason: 'A small funded party is checking a recent report of exposed enemy workers; visible defenders take priority.' };
    if (!deployMilitary(s, home, group)) continue;
    pay(s, home, costs); s.groups.push(group); f.lastHarassment = s.tick;
    s.stats.harassmentParties = (s.stats.harassmentParties || 0) + 1;
    rememberCampaignOrder(s, group); return;
  }
}

function chooseExpedition(s, f, homes) {
  if (s.tick < 100 || s.groups.length >= MAX_GROUPS) return;
  if (f.strategy?.mode === 'recover') return;
  const orders = Object.values(f.campaignOrders || {});
  const armies = s.groups.filter(g => g.kind === 'army' && !g.finished && groupController(s, g) === f.id);
  if (Math.max(orders.length, armies.length) >= Math.min(4, Math.max(2, homes.length * 2))) return;
  const assembling = f.strategy?.operation?.phase === 'assemble';
  const cooldown = assembling ? 12 : 70 + Math.round((1 - f.traits.aggression) * 55);
  if (s.tick - f.lastArmy < cooldown) return;
  const heldIds = new Set(s.settlements.filter(p => alive(p) && settlementController(s, p) === f.id).map(p => p.id));
  const known = knownReports(s, f, { kind: 'settlement', maxAge: 230, minConfidence: .3, includeOwn: false }).filter(k => k.ownerId && !heldIds.has(k.id) && !['camp', 'ruin'].includes(k.status));
  if (!known.length) { if (s.tick % 12 === 0) f.intent = 'Exploring: no returned report identifies a foreign settlement.'; return; }
  const resources = knownReports(s, f, { kind: 'resource', maxAge: 230, minConfidence: .3 }).filter(k => (k.amountEstimate ?? k.abundanceEstimate ?? 0) >= 600);
  let best = null;
  for (const p of homes) {
    if (Math.max(orders.filter(order => order.originId === p.id).length, armies.filter(g => g.originId === p.id).length) >= 2) continue;
    const defense = homeDefense(s, f, p, known), available = defense.deployable;
    if (available < 8 || defense.observedThreat) continue;
    const staple = f.species === 'machine' ? 'energy' : 'food';
    const need = p.stock[staple] < p.population * 0.25 || p.stock.materials < p.population * 0.20;
    for (const k of known) {
      if (f.strategy?.mode === 'campaign' && k.id !== f.strategy.targetId) continue;
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
      const committed = orders.filter(order => order.targetId === k.id);
      if (!committed.length && available < 16) continue;
      if (!committed.length && r.lastConflict != null && s.tick - r.lastConflict < 35) continue;
      const appetite = .42 + f.traits.aggression * .35 + f.traits.industry * .12 + (need ? .12 : 0) + (deposit ? .12 : 0) + (r.status === 'hostile' ? .18 : 0) - f.traits.cooperation * .06;
      const age = s.tick - k.observedTick;
      const reportedDefenders = Math.max(1, k.soldiersEstimate ?? k.populationEstimate * 0.22);
      // Orders retain their departure strength until a new report warrants more
      // troops; unseen field casualties cannot summon remote reinforcements.
      const assigned = committed.reduce((sum, order) => sum + order.size, 0);
      const required = Math.max(24, Math.ceil(reportedDefenders * 1.45 + 12));
      if (assigned >= required || committed.length >= 2) continue;
      const size = f.strategy?.mode === 'campaign' ? Math.min(200, available) : Math.min(200, available, Math.max(24, required - assigned));
      if (size + assigned < reportedDefenders * .85) continue;
      const vulnerability = clamp((available - reportedDefenders) * 0.17, -12, 11);
      const damageOpportunity = Math.max(0, 70 - (k.healthEstimate ?? 100)) * 0.065;
      const score = appetite * 30 + k.confidence * 10 + vulnerability + damageOpportunity + (committed.length ? 5 : 0) - distanceTo * 0.20 - age * 0.025;
      if (!best || score > best.score) best = { p, k, need, deposit, frontierClaim, score, distanceTo, size, reserve: defense.reserve, reinforcement: committed.length > 0 };
    }
  }
  if (!best) { if (s.tick % 12 === 0) f.intent = 'Seeking a fresh reachable rival report and waiting for temporary truces to expire.'; return; }
  const { p, k, need, deposit, frontierClaim } = best;
  let units = allocateMilitary(s, p, best.size), size = countMilitary(units);
  const estimate = Math.max(1, k.soldiersEstimate ?? k.populationEstimate * 0.22);
  p.militaryTarget = clamp(.30 + f.traits.aggression * .10, .30, .40);
  if (size < (best.reinforcement ? 8 : 16)) {
    f.intent = `Training before acting on a ${s.tick - k.observedTick}-cycle-old report; ${size} soldiers available, about ${estimate} reported defenders.`;
    return;
  }
  const biology = { ...f, species: factionOf(s, p.factionId)?.species || f.species };
  const speed = biology.species === 'machine' ? 2.7 : biology.species === 'hive' ? 3.05 : 2.9;
  const stages = s.settlements.filter(h => h.id !== p.id && alive(h) && settlementController(s, h) === f.id && distance(p, h) < best.distanceTo * .85 && distance(h, k) < best.distanceTo * .85 && canPay(h, provisions(biology, size, true), 8));
  stages.sort((a, b) => distance(p, a) + distance(a, k) - distance(p, b) - distance(b, k));
  const stage = best.distanceTo > 125 ? stages[0] : null;
  let route = campaignRoute(s, f, p, k, size, speed, stage);
  if (!route) { f.unreachableTargets ??= {}; f.unreachableTargets[k.id] = s.tick; f.intent = 'The reported rival has no traversable approach; another known route is needed.'; return; }
  const minimum = Math.max(best.reinforcement ? 8 : 16, Math.ceil(estimate * .85 - orders.filter(o => o.targetId === k.id).reduce((n, o) => n + o.size, 0)));
  const reserve = Math.max(12, p.population * .05);
  let costs;
  // Prefer concentration, but a smaller supported army is better than an
  // unaffordable order. At most three alternatives; no money is spent yet.
  for (let attempt = 0; attempt < 4; attempt++) {
    costs = Object.fromEntries(Object.entries(provisions(biology, size, true)).map(([key, value]) => [key, value * route.provisionFactor]));
    if (route.provisionFactor <= 3.5 && canPay(p, costs, reserve)) break;
    const smaller = Math.max(minimum, Math.floor(size * .7));
    if (attempt === 3 || smaller >= size) { f.intent = 'Building paid route supplies for a supported force while preserving the home reserve.'; return; }
    units = allocateMilitary(s, p, smaller); size = countMilitary(units);
    if (size < minimum) return;
    route = campaignRoute(s, f, p, k, size, speed, stage); if (!route) return;
  }
  const { expectedTravelCycles, routeSupplyBudget, provisionFactor } = route;
  pay(s, p, costs);
  const reason = `${relation(f, k.ownerId).status === 'hostile' ? 'An unresolved frontier conflict' : frontierClaim ? 'A territorial claim on a reported ' + deposit.resourceKind + ' deposit shared with the rival frontier' : deposit ? 'A campaign to secure reported ' + deposit.resourceKind + ' stores and territory' : 'A campaign against an independently reported rival settlement'}; a returned report observed about ${estimate} defenders ${s.tick - k.observedTick} cycles ago.`;
  const g = { id: 'g' + s.nextId++, factionId: p.factionId, commandFactionId: f.id, originId: p.id, kind: 'army',
    x: p.x, z: p.z, prevX: p.x, prevZ: p.z, targetX: stage?.x ?? k.x, targetZ: stage?.z ?? k.z, targetId: k.id, phase: 'outbound',
    missionTargetX: k.x, missionTargetZ: k.z, stagingHomeId: stage?.id ?? null, stagingTargetId: stage?.id ?? null, stagingPurpose: stage ? 'outbound' : null, provisionFactor,
    size, initialSize: size, units, supply: 100, morale: 80 + f.traits.aggression * 12,
    speed, campaign: true, missionEnemyId: k.ownerId, reinforcement: best.reinforcement, homeReserve: best.reserve, missionOrderTick: s.tick, expectedTravelCycles, routeSupplyBudget: Math.round(routeSupplyBudget),
    carrying: emptyCargo(), observations: [], createdTick: s.tick, createdTime: s.time ?? s.tick, reason,
    intelligence: { observedTick: k.observedTick, reportedTick: k.reportedTick, confidence: k.confidence, populationEstimate: k.populationEstimate, soldiersEstimate: estimate } };
  deployMilitary(s, p, g);
  s.groups.push(g);
  rememberCampaignOrder(s, g);
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
    for (const f of s.factions) coordinateFrontlines(s, f);
    const remaining = [];
    for (const packet of s.pendingReports) {
      if (packet.dueTick <= s.tick) deliverReport(s, packet.factionId, packet.observations, packet.groupId, packet.method, packet.explorationMask);
      else remaining.push(packet);
    }
    s.pendingReports = remaining;
  }
  updateGroups(s, dt, cycleBoundary);
  stepCombat(s, dt, { retreat: returnHome, hostility: recordHostility, casualties });
  if (cycleBoundary) {
    // Resolve pressure/loot only after current local defenders can interrupt.
    // A wall, worker, or field battle cannot remotely damage settlement stores.
    for (const g of s.groups) if (dt > 0 && canFight(g) && g.phase === 'engaging' && g.combat?.targetKind === 'settlement' && g.combat.targetId === g.targetId) {
      const town = s.settlements.find(p => p.id === g.targetId);
      const owner = town && settlementController(s, town), commander = groupController(s, g);
      if (alive(town) && owner !== commander && !['allied', 'trade'].includes(relation(factionOf(s, commander), owner).status) && visibleToGroup(s, g, town, 18)) raid(s, g, town);
    }
    fieldEncounters(s); updateConquest(s);
  }
  s.groups = s.groups.filter(g => !g.finished && g.size > 0);
  if (!cycleBoundary) return;
  for (const f of s.factions) {
    if (f.defeatedBy || s.outcome?.status === 'victory') continue;
    const homes = s.settlements.filter(p => alive(p) && (p.factionId === f.id && !p.occupiedBy || p.exileBaseFor === f.id && settlementController(s, p) === f.id));
    if (!homes.length) continue;
    reserveHomeDefense(s, f, homes, knownReports(s, f, { kind: 'settlement', maxAge: 230, minConfidence: .3, includeOwn: false }));
    planStrategy(s, f, homes, { planningWorld: expeditionPlanningWorld, returnHome });
    dispatchScout(s, f, homes);
    dispatchHarassment(s, f, homes);
    chooseExpedition(s, f, homes);
  }
}
