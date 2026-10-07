import { random, clamp, distance, emit } from '../shared.js';
import { terrainAt } from '../world.js';
import { SURVIVAL_NEEDS } from './economy.js';
import { knownReports } from './knowledge.js';
import { settlementController } from './control.js';

// Research is purchased in small, visible installments. Field requirements never
// consult enemy state: only returned reports and this faction's own experience.
const RESOURCES = ['food', 'water', 'energy', 'materials'];
const MAX_GROUPS = 480;
const MAX_OFFERS = 48;
const RESEARCH_COST_SCALE = 8;
const RESEARCH_WORK_SCALE = 6;
const BASE_MODIFIERS = {
  production: 1, growth: 1, capacity: 1, waterEfficiency: 1,
  energyEfficiency: 1, materialEfficiency: 1, carryCapacity: 1,
  replication: 1, movement: 1, supplyEfficiency: 1, defense: 1, researchThroughput: 1,
};
const ARCHETYPES = {
  human: [
    ['Wayfarers', 'Restless surveyors who value open routes', .52, .90, .51, .56],
    ['Commons', 'Patient cultivators who favour mutual aid', .23, .55, .66, .90],
    ['Wardens', 'Protective pioneers who defend hard-won stores', .74, .51, .61, .37],
    ['Artificers', 'Practical builders who prize useful discoveries', .43, .69, .88, .65],
  ],
  machine: [
    ['Gleaners', 'Cautious recyclers who conserve every component', .31, .59, .88, .74],
    ['Survey Mesh', 'Inquisitive networks driven to map salvage', .48, .95, .66, .58],
    ['Iron Accord', 'Disciplined fabricators who bargain before fighting', .61, .60, .84, .72],
    ['Reclaimers', 'Possessive scavengers who contest rich deposits', .84, .71, .75, .28],
  ],
  hive: [
    ['Chorus', 'Social broods who cultivate living trade networks', .31, .61, .64, .89],
    ['Thorn Kin', 'Territorial nests that invest in resilient defenders', .87, .52, .60, .29],
    ['Wanderbrood', 'Curious foragers who seek new habitats', .48, .89, .50, .67],
    ['Root Covenant', 'Patient gardeners who adapt to difficult ground', .40, .54, .84, .75],
  ],
};
const PREFIXES = {
  human: ['Aster', 'Dawn', 'Hearth', 'Sol', 'Amber', 'Valley', 'Meridian', 'Orchard'],
  machine: ['Copper', 'Echo', 'Cobalt', 'Helix', 'Arc', 'Relay', 'Lattice', 'Morrow'],
  hive: ['Violet', 'Opal', 'Jade', 'Saffron', 'Moss', 'Pearl', 'Indigo', 'Umber'],
};
const PALETTES = {
  human: ['#eebc75', '#e98669', '#dfce83', '#f2a96a'],
  machine: ['#70d7e0', '#76aef0', '#75e3c0', '#a1cbee'],
  hive: ['#c79bea', '#d993b7', '#b3d588', '#dbb5e3'],
};
const TRACKS = {
  human: [
    { id: 'irrigation', name: 'Terraced irrigation', work: 62, cost: { food: 2, water: 1, energy: 1, materials: 3 }, effects: { waterEfficiency: 1.14, growth: 1.06 }, gate: 'local', detail: 'Field trials in the settlement biome' },
    { id: 'survey', name: 'Surveyors’ guild', work: 104, cost: { food: 2, energy: 2, materials: 4 }, effects: { carryCapacity: 1.15, movement: 1.08, capacity: 1.10 }, gate: 'reports', detail: 'A returned discovery or a delivered exchange' },
    { id: 'logistics', name: 'Supply engineering', work: 154, cost: { food: 3, water: 2, energy: 3, materials: 5 }, effects: { supplyEfficiency: 1.22, production: 1.12, capacity: 1.15 }, gate: 'fieldwork', detail: 'Three field experiences or two successful deliveries' },
    { id: 'civic', name: 'Federated workshops', work: 214, cost: { food: 4, water: 2, energy: 4, materials: 7 }, effects: { production: 1.10, growth: 1.10, materialEfficiency: 1.12 }, gate: 'mature', detail: 'A mature settlement and five field experiences' },
  ],
  machine: [
    { id: 'cooling', name: 'Closed-cycle cooling', work: 74, cost: { water: 2, energy: 3, materials: 4 }, effects: { waterEfficiency: 1.20, energyEfficiency: 1.06 }, gate: 'local', detail: 'Cooling trials under local heat and load' },
    { id: 'foundry', name: 'Salvage foundry', work: 116, cost: { water: 1, energy: 4, materials: 6 }, effects: { materialEfficiency: 1.15, capacity: 1.15, production: 1.08, replication: 1.2, researchThroughput: 1.5 }, gate: 'salvage', detail: '18 components salvaged and a returned field report', benefit: 'Salvage-fed rigs enable 1.5x funded trials and 1.2x assembly.' },
    { id: 'relay', name: 'Distributed relay', work: 170, cost: { water: 2, energy: 6, materials: 7 }, effects: { energyEfficiency: 1.12, supplyEfficiency: 1.14, carryCapacity: 1.18, researchThroughput: 1.4 }, gate: 'fieldwork', detail: 'Three field experiences or two successful deliveries', benefit: 'Distributed experiments reach 2.1x throughput, with proportional cooling, energy, and component costs.' },
    { id: 'fabrication', name: 'Adaptive fabrication', work: 260, cost: { water: 3, energy: 8, materials: 10 }, effects: { production: 1.16, replication: 2, materialEfficiency: 1.10 }, gate: 'fabrication', detail: 'Five field experiences, 70 energy and 55 spare components', benefit: 'Funded assembly reaches 2.4x its original rate; each new unit still consumes energy and components.' },
  ],
  hive: [
    { id: 'rootwater', name: 'Deep root reservoirs', work: 66, cost: { food: 3, water: 2, materials: 2 }, effects: { waterEfficiency: 1.15, capacity: 1.10 }, gate: 'local', detail: 'Root trials in the settlement habitat' },
    { id: 'pheromones', name: 'Trail memory', work: 112, cost: { food: 4, water: 2, energy: 1, materials: 3 }, effects: { movement: 1.10, carryCapacity: 1.16, production: 1.06 }, gate: 'reports', detail: 'A returned discovery or a delivered exchange' },
    { id: 'carapace', name: 'Mineral carapace', work: 166, cost: { food: 5, water: 3, energy: 2, materials: 5 }, effects: { defense: 1.18, materialEfficiency: 1.10, growth: 1.06 }, gate: 'fieldwork', detail: 'Three field experiences or two successful deliveries' },
    { id: 'symbiosis', name: 'Symbiotic gardens', work: 228, cost: { food: 7, water: 4, energy: 2, materials: 7 }, effects: { production: 1.16, growth: 1.12, capacity: 1.15 }, gate: 'mature', detail: 'A mature settlement and five field experiences' },
  ],
};
const APPETITES = {
  human: { food: .46, water: .40, energy: .16, materials: .28 },
  machine: { food: .04, water: .24, energy: .52, materials: .46 },
  hive: { food: .54, water: .42, energy: .10, materials: .28 },
};
const IMPORTANCE = {
  human: { food: .85, water: .80, energy: .62, materials: .92 },
  machine: { food: .04, water: .64, energy: 1, materials: 1 },
  hive: { food: .96, water: .88, energy: .30, materials: .86 },
};

export function createFactions(state, count = 6) {
  const factions = [];
  const usedNames = new Set();
  const usedPrefixes = { human: new Set(), machine: new Set(), hive: new Set() };
  const archetypeOffset = { human: Math.floor(random(state) * 4), machine: Math.floor(random(state) * 4), hive: Math.floor(random(state) * 4) };
  for (let i = 0; i < Math.max(0, Math.min(12, count)); i++) {
    const species = ['human', 'machine', 'hive'][i % 3];
    const ordinal = Math.floor(i / 3);
    const archetype = ARCHETYPES[species][(archetypeOffset[species] + ordinal * 2 + (ordinal > 1 ? 1 : 0)) % 4];
    let prefixIndex = Math.floor(random(state) * PREFIXES[species].length);
    // Resolve a collision without another random draw: population, traits, and
    // other seeded outcomes keep their existing random sequence.
    while (usedPrefixes[species].has(PREFIXES[species][prefixIndex])) prefixIndex = (prefixIndex + 1) % PREFIXES[species].length;
    const prefix = PREFIXES[species][prefixIndex];
    usedPrefixes[species].add(prefix);
    let name = `${prefix} ${archetype[0]}`;
    if (usedNames.has(name)) name += ` ${ordinal + 1}`;
    usedNames.add(name);
    const traits = {};
    ['aggression', 'curiosity', 'industry', 'cooperation'].forEach((key, j) => {
      traits[key] = +clamp(archetype[j + 2] + (random(state) - .5) * .22, .10, .94).toFixed(3);
    });
    const focus = TRACKS[species][0];
    factions.push({
      id: `f${i}`, name, species, color: PALETTES[species][ordinal % 4], traits,
      personality: archetype[1], knowledge: {}, relations: {},
      tech: { level: 0, progress: 0, focus: focus.name, nextId: focus.id, unlocked: [], requirement: focus.detail, requiredProgress: focus.work * RESEARCH_WORK_SCALE, invested: { food: 0, water: 0, energy: 0, materials: 0 }, status: 'Settling in; field trials begin after cycle 24', breakthroughs: [] },
      modifiers: { ...BASE_MODIFIERS }, intent: 'Establishing a secure home', history: [],
      experience: { exploration: 0, combat: 0, trade: 0 }, lastScout: 0, lastArmy: 0,
      researchWorkers: 0, researchHomeId: null, lastProposal: -60, diplomacy: 'No returned reports of another society',
    });
  }
  return factions;
}

function homesOf(state, faction) {
  return state.settlements.filter(s => s.factionId === faction.id && settlementController(state, s) === faction.id && s.population > 0 && s.health > 0 && s.status !== 'camp' && s.status !== 'ruin' && !s.defeat);
}

function experienceOf(faction) {
  const e = faction.experience;
  return (e.exploration || 0) + (e.combat || 0) + (e.trade || 0);
}

function freshReports(state, faction, ownerId = null) {
  return knownReports(state, faction, { minConfidence: .15 }).filter(k => k.reportedTick >= 0 && (!ownerId || k.ownerId === ownerId));
}

function reserveFor(settlement, faction, kind) {
  const cap = settlement.capacity || 1200;
  const population = settlement.population || 0;
  const important = APPETITES[faction.species][kind];
  const dailyNeed = (settlement.resourceNeeds?.[kind] || 0) * population;
  return Math.max(kind === 'materials' ? 80 : 45, dailyNeed * 12, Math.min(cap * important * .45, population * (kind === 'water' ? 1.1 : kind === 'materials' ? .8 : 1.3)));
}

function canSpend(settlement, faction, cost, multiplier = 1) {
  return Object.entries(cost).every(([kind, amount]) => (settlement.stock[kind] || 0) >= reserveFor(settlement, faction, kind) + amount * multiplier);
}

function account(state, kind, field, amount) {
  if (state.resourceLedger?.[kind] && amount > 0) state.resourceLedger[kind][field] = (state.resourceLedger[kind][field] || 0) + amount;
}

// Escrow and caravans are owned inventory, not a sink or new production. A
// global conservation sum includes settlements + group cargo + tradeOffers.
// Internal barter has global tradeNet=0; only rations/research/loss leave it.
function debit(state, settlement, cost, sink = null) {
  for (const [kind, amount] of Object.entries(cost)) {
    const paid = Math.min(settlement.stock[kind] || 0, Math.max(0, amount));
    settlement.stock[kind] -= paid;
    if (sink) account(state, kind, sink, paid);
  }
}

function credit(state, settlement, cargo) {
  let accepted = 0, lost = 0;
  for (const [kind, amount] of Object.entries(cargo)) {
    const delivered = settlement ? Math.min(amount, Math.max(0, settlement.capacity - (settlement.stock[kind] || 0))) : 0;
    if (settlement) settlement.stock[kind] = (settlement.stock[kind] || 0) + delivered;
    account(state, kind, 'lost', amount - delivered);
    accepted += delivered; lost += amount - delivered;
  }
  return { accepted, lost };
}

function buildingsOf(home, kind) {
  return (home.buildings || []).filter(b => b.kind === kind && (b.progress ?? 1) >= 1).length;
}

function freeCivilians(state, home, includeResearchers = false) {
  const away = state.groups.reduce((n, g) => n + (g.originId === home.id && g.kind !== 'army' && !g.finished ? g.size : 0), 0);
  const actual = Math.max(0, home.population - home.soldiers - away);
  return Math.floor(Math.max(0, Math.min(actual, (home.availableWorkers ?? actual) + (includeResearchers ? home.assigned?.researchers || 0 : 0))));
}

function researchGate(state, faction, home, project) {
  const reports = freshReports(state, faction).filter(k => k.reportedTick > k.observedTick);
  const fieldwork = experienceOf(faction);
  if (faction.tech.level >= 1 && buildingsOf(home, 'workshop') < 1) return false;
  if (faction.tech.level >= 2 && (buildingsOf(home, 'lab') < 1 || home.population < 150)) return false;
  if (faction.tech.level >= 3 && (buildingsOf(home, 'lab') < 2 || buildingsOf(home, 'workshop') < 2 || home.population < 240)) return false;
  switch (project.gate) {
    case 'local': return state.tick >= 24;
    case 'reports': return fieldwork >= 1 || reports.length >= 1;
    case 'salvage': return (faction.experience.salvage || 0) >= 180 && (fieldwork >= 1 || reports.some(k => k.kind === 'resource' && k.resourceKind === 'materials'));
    case 'fieldwork': return fieldwork >= 6 || (faction.experience.trade || 0) >= 4;
    case 'mature': return fieldwork >= 12;
    case 'fabrication': return fieldwork >= 12 && home.stock.energy >= 450 && home.stock.materials >= 360;
    default: return false;
  }
}

function stepResearch(state, faction, homes) {
  const project = TRACKS[faction.species][faction.tech.level];
  faction.researchWorkers = 0;
  faction.researchHomeId = null;
  if (!project || !homes.length) {
    faction.tech.focus = project ? project.name : 'Mature knowledge';
    faction.tech.status = homes.length ? 'All four specialisations established' : 'Research suspended: permanent shelter must be rebuilt';
    return;
  }
  faction.tech.focus = project.name;
  faction.tech.nextId = project.id;
  const level = faction.tech.level;
  const prerequisite = project.gate === 'salvage' ? '180 delivered salvage components and a returned field report'
    : project.gate === 'fabrication' ? '12 field experiences, 450 energy and 360 spare components'
    : project.gate === 'fieldwork' ? 'Six field experiences or four successful deliveries'
    : project.gate === 'mature' ? 'Twelve field experiences' : project.detail;
  const infrastructure = level >= 3 ? 'two completed labs, two workshops, and 240 residents'
    : level >= 2 ? 'a completed lab, workshop, and 150 residents' : level >= 1 ? 'a completed workshop' : 'a permanent settlement';
  faction.tech.requirement = `${prerequisite}; ${infrastructure}`;
  faction.tech.requiredProgress = project.work * RESEARCH_WORK_SCALE;
  const home = homes.slice().sort((a, b) => (researchGate(state, faction, b, project) ? 1 : 0) - (researchGate(state, faction, a, project) ? 1 : 0) || buildingsOf(b, 'lab') - buildingsOf(a, 'lab') || (b.workers || 0) - (a.workers || 0) || a.id.localeCompare(b.id))[0];
  if (!researchGate(state, faction, home, project)) {
    faction.tech.status = `Waiting: ${faction.tech.requirement.toLowerCase()}`;
    return;
  }
  // Foundry rigs and the relay can run simultaneous paid experiments. Their
  // speed saves calendar time, never resource investment or survival reserves.
  const throughput = faction.species === 'machine' ? clamp(faction.modifiers.researchThroughput || 1, 1, 2.1) : 1;
  const installment = Object.fromEntries(Object.entries(project.cost).map(([kind, amount]) => [kind, +(amount * RESEARCH_COST_SCALE * throughput).toFixed(4)]));
  faction.tech.parallelism = throughput;
  faction.tech.installment = installment;
  if (!canSpend(home, faction, installment)) {
    const shortages = Object.entries(installment).filter(([kind, amount]) => home.stock[kind] < reserveFor(home, faction, kind) + amount).map(([kind]) => kind);
    faction.tech.status = `Reserves first: need spare ${shortages.join(' and ')}`;
    return;
  }
  const labCapacity = Math.min(24, 6 + buildingsOf(home, 'lab') * 8);
  faction.researchWorkers = Math.max(0, Math.min(labCapacity, Math.floor((home.workers || 0) * .12), freeCivilians(state, home, true) - Math.max(12, Math.ceil(home.population * .12))));
  if (faction.researchWorkers < 6) {
    faction.researchWorkers = 0;
    faction.tech.status = 'Research paused: local crews are needed for food and supply';
    return;
  }
  faction.researchHomeId = home.id;
  home.availableWorkers = Math.max(0, (home.availableWorkers || 0) - faction.researchWorkers);
  home.assigned ||= {};
  home.assigned.researchers = faction.researchWorkers;
  faction.tech.status = `${faction.researchWorkers} specialists at ${home.name}; ${throughput > 1 ? `${throughput.toFixed(1)}x parallel funded trials` : 'funded trials'} every eight cycles`;
  const phase = Number(faction.id.slice(1)) || 0;
  if ((state.tick + phase) % 8 !== 0) return;
  debit(state, home, installment, 'research');
  for (const [kind, amount] of Object.entries(installment)) faction.tech.invested[kind] += amount;
  const terrain = terrainAt(home.x, home.z, state.terrainSeed || state.seed);
  // Different surroundings reward different experiments; no random winner roll.
  const habitatFit = terrain.balancedDistrict ? 1 : faction.species === 'human' ? (terrain.biome === 'meadow' ? 1.12 : terrain.biome === 'desert' && project.id === 'irrigation' ? 1.20 : 1)
    : faction.species === 'machine' ? (terrain.biome === 'desert' ? 1.16 : 1)
    : terrain.biome === 'alien' ? 1.18 : terrain.fertility > .6 ? 1.10 : 1;
  const experienceBonus = 1 + Math.min(.20, experienceOf(faction) * .012);
  const work = (6 + faction.researchWorkers * 1.8 + faction.traits.industry * 4 + faction.traits.curiosity * 2) * habitatFit * experienceBonus * throughput;
  faction.tech.progress += work;
  faction.tech.environment = `${terrain.balancedDistrict ? "Balanced district" : terrain.biome}: ×${habitatFit.toFixed(2)} trial yield`;
  if (faction.tech.progress < faction.tech.requiredProgress) return;
  faction.tech.progress = 0;
  faction.tech.level++;
  faction.tech.unlocked.push(project.id);
  faction.tech.breakthroughs.push({ id: project.id, name: project.name, tick: state.tick, habitat: terrain.biome });
  for (const [key, gain] of Object.entries(project.effects)) faction.modifiers[key] = +((Number.isFinite(faction.modifiers[key]) ? faction.modifiers[key] : 1) * gain).toFixed(4);
  state.stats.breakthroughs = (state.stats.breakthroughs || 0) + 1;
  emit(state, 'breakthrough', `${faction.name} developed ${project.name.toLowerCase()} through funded ${terrain.biome} trials.${project.benefit ? ` ${project.benefit}` : ''}`, faction.id, { settlementId: home.id, technology: project.id });
  const next = TRACKS[faction.species][faction.tech.level];
  faction.tech.focus = next?.name || 'Mature knowledge';
  faction.tech.status = next ? `New project: ${next.detail.toLowerCase()}` : 'All four specialisations established';
}

function establishContacts(state, faction) {
  const contacts = freshReports(state, faction).filter(k => k.kind === 'settlement' && k.ownerId && k.ownerId !== faction.id);
  for (const report of contacts) {
    const other = state.factions.find(f => f.id === report.ownerId);
    if (!other || (faction.relations[other.id]?.status !== undefined && faction.relations[other.id].status !== 'unknown')) continue;
    const trust = clamp(41 + faction.traits.cooperation * 22 - faction.traits.aggression * 12 + (other.species === faction.species ? 6 : 0), 20, 75);
    faction.relations[other.id] = { trust: +trust.toFixed(1), status: 'neutral', lastTrade: -100, contactedTick: state.tick, successfulTrades: 0 };
    state.stats.contacts = (state.stats.contacts || 0) + 1;
    faction.contactCount = (faction.contactCount || 0) + 1;
    emit(state, 'contact', `${faction.name} opened a contact ledger for ${other.name} after a report reached home.`, faction.id, { otherFactionId: other.id, observedTick: report.observedTick });
  }
  const known = Object.entries(faction.relations).filter(([, r]) => r.status !== 'unknown');
  if (known.length) faction.diplomacy = `${known.length} known societ${known.length === 1 ? 'y' : 'ies'}; ${known.filter(([, r]) => r.status === 'trade').length} temporary trade truces`;
}

function updateAgreements(state) {
  for (let i = 0; i < state.factions.length; i++) {
    const a = state.factions[i]; if (a.defeatedBy) continue;
    for (let j = i + 1; j < state.factions.length; j++) {
      const b = state.factions[j], ab = a.relations[b.id], ba = b.relations[a.id];
      if (b.defeatedBy || !ab || !ba || ab.status === 'hostile' || ba.status === 'hostile') continue;
      const deliveries = Math.min(ab.successfulTrades || 0, ba.successfulTrades || 0);
      const trust = Math.min(ab.trust, ba.trust);
      // Commerce can buy a short ceasefire, never permanent military immunity.
      // Both sides retain their conquest ambitions and need new deliveries plus
      // a cooling-off interval before negotiating another protected exchange.
      const protectedRoute = ['trade', 'allied'].includes(ab.status) || ['trade', 'allied'].includes(ba.status);
      if (protectedRoute) {
        const expiry = Math.min(ab.truceUntil ?? state.tick + 72, ba.truceUntil ?? state.tick + 72);
        if (expiry > state.tick) { ab.status = ba.status = 'trade'; ab.truceUntil = ba.truceUntil = expiry; continue; }
        ab.status = ba.status = 'neutral'; ab.lastTruceEnded = ba.lastTruceEnded = state.tick;
        ab.pactDeliveries = ba.pactDeliveries = deliveries;
        emit(state, 'diplomacy', `${a.name} and ${b.name}'s temporary exchange truce expired; both now reassess their frontier.`, a.id, { otherFactionId: b.id, agreement: 'neutral', expired: true });
        continue;
      }
      const sinceLast = state.tick - Math.max(ab.lastTruceEnded ?? -1000, ba.lastTruceEnded ?? -1000);
      const newDeliveries = deliveries - Math.max(ab.pactDeliveries || 0, ba.pactDeliveries || 0);
      if (newDeliveries < 2 || trust < 57 || sinceLast < 120) continue;
      ab.status = ba.status = 'trade'; ab.truceUntil = ba.truceUntil = state.tick + 72;
      ab.pactDeliveries = ba.pactDeliveries = deliveries;
      emit(state, 'diplomacy', `${a.name} and ${b.name} agreed to protect their exchange route for 72 cycles.`, a.id, { otherFactionId: b.id, agreement: 'trade', truceUntil: state.tick + 72 });
    }
  }
}

function travelCycles(faction, routeLength) {
  const speed = (faction.species === 'machine' ? 2.7 : 2.9) * (faction.modifiers.movement || 1);
  return Math.ceil(routeLength * 2 / (speed * .72) + 20);
}

function travelRations(faction, crewSize, routeLength) {
  const cycles = travelCycles(faction, routeLength), daily = SURVIVAL_NEEDS[faction.species];
  const efficiency = { water: faction.modifiers.waterEfficiency || 1, energy: faction.modifiers.energyEfficiency || 1, materials: faction.modifiers.materialEfficiency || 1 };
  return Object.fromEntries(Object.entries(daily).filter(([, amount]) => amount > 0).map(([kind, amount]) => [kind, +(amount * crewSize * cycles / (efficiency[kind] || 1)).toFixed(4)]));
}

function trader(state, faction, origin, destination, cargo, partner, offer, crewSize) {
  return {
    id: `g${state.nextId++}`, factionId: faction.id, originId: origin.id, kind: 'trader',
    x: origin.x, z: origin.z, prevX: origin.x, prevZ: origin.z, targetX: destination.x, targetZ: destination.z, targetId: destination.id,
    phase: 'outbound', size: crewSize, initialSize: crewSize, provisionCycles: travelCycles(faction, distance(origin, destination)), supply: 100, morale: 85, speed: faction.species === 'machine' ? 2.7 : 2.9, v2Speed: true,
    capacity: crewSize * 24 * (faction.modifiers.carryCapacity || 1),
    carrying: { food: 0, water: 0, energy: 0, materials: 0, ...cargo }, observations: [], createdTick: state.tick, createdTime: state.time ?? state.tick,
    reason: `Deliver ${Object.entries(cargo).map(([kind, n]) => `${n} ${kind}`).join(', ')} under a negotiated exchange`,
    trade: { partnerId: partner.id, dealId: offer.id, exportKind: Object.keys(cargo)[0], importKind: offer.factionId === faction.id ? offer.importKind : offer.exportKind },
  };
}

function resolveOffers(state) {
  for (let i = state.tradeOffers.length - 1; i >= 0; i--) {
    const offer = state.tradeOffers[i];
    if (offer.dueTick > state.tick) continue;
    const a = state.factions.find(f => f.id === offer.factionId);
    const b = state.factions.find(f => f.id === offer.partnerId);
    const origin = state.settlements.find(s => s.id === offer.originId && s.factionId === a?.id && s.population > 0);
    const destination = state.settlements.find(s => s.id === offer.targetId && s.factionId === b?.id && s.population > 0);
    const crewSize = clamp(Math.ceil(offer.amount / 20), 8, 20);
    const routeLength = origin && destination ? distance(origin, destination) : 0;
    const originRations = a ? travelRations(a, crewSize, routeLength) : {};
    const destinationRations = b ? travelRations(b, crewSize, routeLength) : {};
    const exportCost = { [offer.importKind]: offer.amount };
    const destinationCost = { ...exportCost };
    for (const [kind, amount] of Object.entries(destinationRations)) destinationCost[kind] = (destinationCost[kind] || 0) + amount;
    let decline = '';
    if (!origin || !destination) decline = 'the settlement route changed';
    else if (a.defeatedBy || b.defeatedBy || settlementController(state, origin) !== a.id || settlementController(state, destination) !== b.id) decline = 'conquest ended the independent exchange agreement';
    else if (origin.status === 'camp' || origin.status === 'ruin' || origin.defeat || destination.status === 'camp' || destination.status === 'ruin' || destination.defeat) decline = 'permanent shelter must be rebuilt before sending an exchange crew';
    else if (a.relations[b.id]?.status === 'hostile' || b.relations[a.id]?.status === 'hostile') decline = 'hostilities closed the route';
    else if (!canSpend(destination, b, destinationCost)) decline = `${b.name} could not spare ${offer.importKind} and caravan rations`;
    else if (!canSpend(origin, a, originRations)) decline = 'caravan rations were needed at home';
    else if (freeCivilians(state, origin) < crewSize + 8 || freeCivilians(state, destination) < crewSize + 8 || state.groups.length > MAX_GROUPS - 2) {
      if (state.tick < offer.dueTick + 48) { offer.status = 'Agreement reached; waiting for a full civilian crew'; continue; }
      decline = 'no caravan crews were available';
    }
    state.tradeOffers.splice(i, 1);
    if (decline) {
      const returned = credit(state, origin, { [offer.exportKind]: offer.amount });
      if (a) emit(state, 'trade', `${a.name} cancelled an exchange: ${decline}. ${Math.round(returned.accepted)} reserved cargo returned${returned.lost > .01 ? `; ${Math.round(returned.lost)} was lost` : ''}.`, a.id, { offerId: offer.id, refunded: returned.accepted, lost: returned.lost });
      continue;
    }
    debit(state, destination, exportCost);
    debit(state, origin, originRations, 'consumed'); debit(state, destination, destinationRations, 'consumed');
    state.groups.push(trader(state, a, origin, destination, { [offer.exportKind]: offer.amount }, b, offer, crewSize));
    state.groups.push(trader(state, b, destination, origin, { [offer.importKind]: offer.amount }, a, offer, crewSize));
    for (const home of [origin, destination]) {
      home.availableWorkers = Math.max(0, (home.availableWorkers || 0) - crewSize);
      if (home.assigned) { home.assigned.traders = (home.assigned.traders || 0) + crewSize; home.assigned.civilianAway = (home.assigned.civilianAway || 0) + crewSize; }
    }
    a.relations[b.id] ??= { trust: 40, status: 'neutral', lastTrade: -100, successfulTrades: 0 };
    b.relations[a.id] ??= { trust: 40, status: 'neutral', lastTrade: -100, successfulTrades: 0 };
    a.relations[b.id].lastTrade = state.tick; b.relations[a.id].lastTrade = state.tick;
    b.lastProposal = state.tick;
    emit(state, 'trade', `${a.name} and ${b.name} each sent ${crewSize} carriers: ${offer.amount} ${offer.exportKind} for ${offer.amount} ${offer.importKind}.`, a.id, { otherFactionId: b.id, offerId: offer.id, crewSize, amount: offer.amount });
  }
}

function proposeExchange(state, faction, homes) {
  if (state.tick < 72 || state.tick - faction.lastProposal < 16 || state.tradeOffers.length >= MAX_OFFERS || state.groups.length >= MAX_GROUPS - 8 || !homes.length) return;
  const availableHomes = homes.filter(home => state.tick - (home.lastTradeProposal ?? -100) >= 96 && freeCivilians(state, home) >= 18);
  if (!availableHomes.length) return;
  const contacts = freshReports(state, faction).filter(k => k.kind === 'settlement' && k.ownerId && k.ownerId !== faction.id && k.status !== 'camp' && k.status !== 'ruin' && state.tick - k.observedTick < 320);
  const eligible = contacts.filter(k => {
    const other = state.factions.find(f => f.id === k.ownerId);
    const relation = faction.relations[k.ownerId];
    // The proposer knows its own contact history. The recipient's private
    // disposition and spare stock are checked only when its delayed reply acts.
    return other && relation && relation.status !== 'hostile'
      && relation.trust >= 34 && state.tick - relation.lastTrade >= 80
      && !state.tradeOffers.some(o => o.factionId === faction.id && o.partnerId === other.id);
  });
  if (!eligible.length) return;
  const origin = availableHomes.slice().sort((a, b) => (a.lastTradeProposal ?? -100) - (b.lastTradeProposal ?? -100) || b.population - a.population || a.id.localeCompare(b.id))[0];
  eligible.sort((a, b) => distance(origin, a) - distance(origin, b) || a.id.localeCompare(b.id));
  const target = eligible[0];
  if (distance(origin, target) > 155) return;
  const partner = state.factions.find(f => f.id === target.ownerId);
  // A faction knows its stores and the other society's needs, not its live stock.
  const exports = RESOURCES.map(kind => ({ kind, surplus: origin.stock[kind] - reserveFor(origin, faction, kind), value: origin.stock[kind] / origin.capacity - APPETITES[faction.species][kind] + APPETITES[partner.species][kind] * .6 }))
    .filter(item => item.surplus >= 180 && IMPORTANCE[partner.species][item.kind] >= .30)
    .sort((a, b) => b.value - a.value || a.kind.localeCompare(b.kind));
  if (!exports.length) return;
  const exportKind = exports[0].kind;
  const imports = RESOURCES.filter(kind => kind !== exportKind).map(kind => ({ kind, need: IMPORTANCE[faction.species][kind] * (1 - origin.stock[kind] / origin.capacity) }))
    .filter(item => item.need > .15).sort((a, b) => b.need - a.need || a.kind.localeCompare(b.kind));
  if (!imports.length) return;
  const crewSize = Math.min(20, Math.max(8, Math.floor(origin.population * .045)), freeCivilians(state, origin) - 8);
  const amount = Math.min(crewSize * 20, Math.floor(exports[0].surplus * .65));
  if (amount < 120) return;
  const delay = Math.max(12, Math.ceil(distance(origin, target) / 4) * 2);
  const offer = { id: `t${state.nextId++}`, factionId: faction.id, partnerId: partner.id, originId: origin.id, targetId: target.id, exportKind, importKind: imports[0].kind, amount, crewSize, createdTick: state.tick, dueTick: state.tick + delay, status: 'Barter proposal in transit; export cargo held in escrow' };
  debit(state, origin, { [exportKind]: amount });
  state.tradeOffers.push(offer);
  faction.lastProposal = state.tick;
  origin.lastTradeProposal = state.tick;
  emit(state, 'trade', `${faction.name} reserved ${amount} ${exportKind} and sent a barter proposal to ${partner.name}; a reply needs about ${delay} cycles.`, faction.id, { otherFactionId: partner.id, offerId: offer.id, pending: true, dueTick: offer.dueTick });
}

export function stepProgression(state) {
  state.tradeOffers ||= [];
  // Reassign last cycle's research crews before this cycle's grants and trade
  // commitments. Every paid trial and caravan reserves real local individuals.
  for (const home of state.settlements) {
    home.availableWorkers = (home.availableWorkers || 0) + (home.assigned?.researchers || 0);
    if (home.assigned) home.assigned.researchers = 0;
  }
  for (const faction of state.factions) {
    if (faction.defeatedBy) { faction.researchWorkers = 0; faction.researchHomeId = null; faction.tech.status = 'Independent research ended after capitulation'; continue; }
    faction.modifiers ||= { ...BASE_MODIFIERS };
    faction.tech.invested ||= { food: 0, water: 0, energy: 0, materials: 0 };
    faction.tech.breakthroughs ||= [];
    faction.lastProposal ??= -60;
    const homes = homesOf(state, faction);
    stepResearch(state, faction, homes);
    establishContacts(state, faction);
  }
  resolveOffers(state);
  updateAgreements(state);
  if (state.tick % 8 === 0) for (const faction of state.factions) if (!faction.defeatedBy) proposeExchange(state, faction, homesOf(state, faction));
}
