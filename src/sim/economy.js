export const RESOURCES = ['food', 'water', 'energy', 'materials'];
export const emptyResources = () => ({ food: 0, water: 0, energy: 0, materials: 0 });

// Conservation is global: deposits + settlement stores + travelling cargo +
// reserved trade offers = initial + regenerated + produced - consumed -
// construction - research - lost. Extracted/delivered are gross internal flows;
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
    produced: 0, consumed: 0, construction: 0, research: 0, tradeNet: 0, lost: 0,
  }]));
}

export function ledgerAdd(state, kind, field, amount) {
  if (!(amount > 0)) return;
  if (state.resourceLedger?.[kind]) state.resourceLedger[kind][field] += amount;
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
    return [kind, actual[kind] - (l.initial + l.regenerated + l.produced - l.consumed - l.construction - l.research - l.lost)];
  }));
}
