import { hashSeed } from '../shared.js';
import { matchValue } from '../config.js';

export const RESOURCES = ['food', 'water', 'energy', 'materials'];

// The same daily needs price home upkeep and a caravan's finite journey stores.
export const SURVIVAL_NEEDS = {
  human: { food: .018, water: .020, energy: .003, materials: .0008 },
  machine: { food: 0, water: .008, energy: .032, materials: .006 },
  hive: { food: .026, water: .015, energy: .002, materials: .001 },
};
export const emptyResources = () => ({ food: 0, water: 0, energy: 0, materials: 0 });

const needsCache = new Map();
export function survivalNeeds(faction) {
  const species = faction?.species || 'human', scale = matchValue(faction, 'upkeepScale'), key = `${species}:${scale}`;
  if (!needsCache.has(key)) {
    if (needsCache.size >= 128) needsCache.clear();
    const base = SURVIVAL_NEEDS[species] || SURVIVAL_NEEDS.human;
    needsCache.set(key, Object.freeze(Object.fromEntries(RESOURCES.map(kind => [kind, base[kind] * scale]))));
  }
  return needsCache.get(key);
}

// Conservation is global: deposits + settlement stores + travelling cargo +
// reserved trade offers = initial + regenerated + produced - consumed -
// construction - research - training - lost. Extracted/delivered are gross internal flows;
// tradeNet is zero globally because societies exchange existing resources.
export function inventory(state, includeDeposits = true) {
  const total = emptyResources();
  if (includeDeposits) for (const node of state.nodes) total[node.kind] += Math.max(0, node.amount || 0);
  for (const home of state.settlements) for (const kind of RESOURCES) total[kind] += Math.max(0, home.stock[kind] || 0);
  for (const group of state.groups) for (const kind of RESOURCES) total[kind] += Math.max(0, group.carrying?.[kind] || 0);
  for (const offer of state.tradeOffers || []) if (offer.exportKind in total) total[offer.exportKind] += Math.max(0, offer.amount || 0);
  return total;
}

export function initializeLedger(state) {
  const initial = inventory(state);
  state.resourceLedger = Object.fromEntries(RESOURCES.map(kind => [kind, {
    initial: initial[kind], regenerated: 0, extracted: 0, delivered: 0,
    produced: 0, consumed: 0, construction: 0, research: 0, training: 0, tradeNet: 0, lost: 0,
  }]));
}

export function ledgerAdd(state, kind, field, amount) {
  if (!(amount > 0)) return;
  if (state.resourceLedger?.[kind]) state.resourceLedger[kind][field] = (state.resourceLedger[kind][field] || 0) + amount;
}

export function canAfford(home, costs, reserves = {}) {
  return RESOURCES.every(kind => home.stock[kind] >= (costs[kind] || 0) + (reserves[kind] || 0));
}

export function spend(state, home, costs, purpose = 'consumed') {
  for (const kind of RESOURCES) {
    const amount = Math.min(home.stock[kind], Math.max(0, costs[kind] || 0));
    home.stock[kind] -= amount;
    ledgerAdd(state, kind, purpose, amount);
  }
}

export function depositCargo(state, home, group) {
  let delivered = 0;
  for (const kind of RESOURCES) {
    const amount = Math.min(group.carrying[kind] || 0, Math.max(0, home.capacity - home.stock[kind]));
    home.stock[kind] += amount; group.carrying[kind] -= amount;
    home.deliveryAccumulator ||= emptyResources();
    home.deliveryAccumulator[kind] += amount;
    ledgerAdd(state, kind, 'delivered', amount); delivered += amount;
  }
  return delivered;
}

export function discardCargo(state, group) {
  for (const kind of RESOURCES) {
    ledgerAdd(state, kind, 'lost', group.carrying?.[kind] || 0);
    if (group.carrying) group.carrying[kind] = 0;
  }
}

export function ledgerResidual(state) {
  const actual = inventory(state);
  return Object.fromEntries(RESOURCES.map(kind => {
    const l = state.resourceLedger[kind];
    return [kind, actual[kind] - (l.initial + l.regenerated + l.produced - l.consumed - l.construction - l.research - (l.training || 0) - l.lost)];
  }));
}


// These are persistent, seeded capabilities, not outcome multipliers or a
// victory timer. Every advantage has an explicit economic or military tradeoff
// and can belong to any species. Actual extraction, funding and weapon ranges
// consume the values below, so an advantage can compound through real stores.
export const FACTION_ADVANTAGE_PROFILES = Object.freeze([
  { id: 'harvest-guild', name: 'Harvest guild', description: 'Exceptional gathering funds growth and replacement forces.', strength: '65% faster gathering; 45% larger carried loads', tradeoff: '8% weaker weapons and slower training', gathering: 1.65, hauling: 1.45, trainingRate: .92, infantryDamage: .92, rangedDamage: .92, rangedRange: 1, fortificationHp: .95, unitCost: 1, constructionCost: 1 },
  { id: 'war-school', name: 'War school', description: 'Fast paid recruitment and hard-hitting ranks seize early opportunities.', strength: '55% faster training; 15% stronger weapons', tradeoff: '10% weaker fortifications; 5% dearer units', gathering: 1.08, hauling: 1.05, trainingRate: 1.55, infantryDamage: 1.15, rangedDamage: 1.15, rangedRange: .97, fortificationHp: .9, unitCost: 1.05, constructionCost: 1 },
  { id: 'longwatch', name: 'Longwatch', description: 'Long-range volleys reward prepared positions and surviving screens.', strength: '28% more ranged reach; 16% stronger volleys', tradeoff: '18% slower training; 15% dearer units; weaker infantry', gathering: 1.12, hauling: 1.08, trainingRate: .82, infantryDamage: .90, rangedDamage: 1.16, rangedRange: 1.28, fortificationHp: 1.08, unitCost: 1.15, constructionCost: 1 },
  { id: 'citadel', name: 'Citadel', description: 'Durable defenses secure valuable extraction and hold against sieges.', strength: '60% tougher walls and towers', tradeoff: '12% dearer construction; 10% slower training', gathering: 1.16, hauling: 1.10, trainingRate: .90, infantryDamage: 1.02, rangedDamage: 1.02, rangedRange: 1, fortificationHp: 1.60, unitCost: 1, constructionCost: 1.12 },
  { id: 'lean-logistics', name: 'Lean logistics', description: 'Efficient gathering and cheaper courses sustain repeated campaigns.', strength: '30% faster gathering; 35% larger loads; 18% faster training; 10% cheaper units', tradeoff: '8% weaker weapons; 5% shorter ranged reach', gathering: 1.30, hauling: 1.35, trainingRate: 1.18, infantryDamage: .92, rangedDamage: .92, rangedRange: .95, fortificationHp: 1, unitCost: .90, constructionCost: 1 },
  { id: 'siegecraft', name: 'Siegecraft', description: 'Affordable fieldworks and stronger infantry support methodical advances.', strength: '12% cheaper construction; 20% tougher defenses; 13% stronger infantry', tradeoff: '8% shorter ranged reach; 8% dearer units', gathering: 1.12, hauling: 1.08, trainingRate: 1.05, infantryDamage: 1.13, rangedDamage: 1.02, rangedRange: .92, fortificationHp: 1.20, unitCost: 1.08, constructionCost: .88 },
]);

export function initializeFactionAdvantages(state, faction, index = state.factions.indexOf(faction)) {
  const count = FACTION_ADVANTAGE_PROFILES.length;
  const offset = hashSeed(`${state.seed}:advantage-offset`) % count;
  const direction = hashSeed(`${state.seed}:advantage-order`) % 2 ? 1 : count - 1;
  faction.advantages = { ...FACTION_ADVANTAGE_PROFILES[(offset + Math.max(0, index) * direction) % count] };
  return faction.advantages;
}
