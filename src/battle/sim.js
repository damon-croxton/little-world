/** Isolated individual-soldier skirmish. No civilisation state or pooled damage. */
export const BATTLE_STEP = 0.1;
export const ROLE_STATS = Object.freeze({
  infantry: Object.freeze({ maxHp: 100, speed: 2.75, damage: 18, range: 1.48, cooldown: 1.05, sight: 14, radius: .38 }),
  ranged: Object.freeze({ maxHp: 66, speed: 2.55, damage: 13, range: 10.5, cooldown: 1.55, sight: 16, radius: .35, preferredRange: 7.4 }),
  scout: Object.freeze({ maxHp: 60, speed: 4.25, damage: 12, range: 1.42, cooldown: .8, sight: 20, radius: .33 }),
});
const TEAMS = ['blue', 'red'];
const EPS = 1e-7;
const CELL = 4;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const copyPoint = p => ({ x: p.x, z: p.z });
const otherTeam = team => team === 'blue' ? 'red' : 'blue';
const direction = team => team === 'blue' ? 1 : -1;
function hash(text) { let h = 2166136261; for (const c of String(text)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function randomFor(seed) { let a = hash(seed); return () => { a += 0x6D2B79F5; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// A hash query visits a fixed local rectangle of cells; it never sorts the army.
class SpatialHash {
  constructor(units, metrics) {
    this.cells = new Map(); this.metrics = metrics;
    for (const unit of units) { const key = `${Math.floor(unit.x / CELL)},${Math.floor(unit.z / CELL)}`; if (!this.cells.has(key)) this.cells.set(key, []); this.cells.get(key).push(unit); }
  }
  near(point, radius) {
    const found = [], r2 = radius * radius;
    if (this.metrics) this.metrics.spatialQueries++;
    for (let x = Math.floor((point.x - radius) / CELL); x <= Math.floor((point.x + radius) / CELL); x++) {
      for (let z = Math.floor((point.z - radius) / CELL); z <= Math.floor((point.z + radius) / CELL); z++) {
        for (const unit of this.cells.get(`${x},${z}`) || []) {
          if (this.metrics) this.metrics.candidateChecks++;
          if ((unit.x - point.x) ** 2 + (unit.z - point.z) ** 2 <= r2 + EPS) found.push(unit);
        }
      }
    }
    return found;
  }
}
function rectangle(obstacle, padding = 0) {
  return { left: obstacle.x - obstacle.width / 2 - padding, right: obstacle.x + obstacle.width / 2 + padding,
    top: obstacle.z - obstacle.depth / 2 - padding, bottom: obstacle.z + obstacle.depth / 2 + padding };
}
function segmentHitsRectangle(a, b, r) {
  let lo = 0, hi = 1;
  for (const [start, delta, min, max] of [[a.x, b.x - a.x, r.left, r.right], [a.z, b.z - a.z, r.top, r.bottom]]) {
    if (Math.abs(delta) < EPS) { if (start < min || start > max) return false; }
    else { let t0 = (min - start) / delta, t1 = (max - start) / delta; if (t0 > t1) [t0, t1] = [t1, t0]; lo = Math.max(lo, t0); hi = Math.min(hi, t1); if (lo > hi) return false; }
  }
  return hi >= 0 && lo <= 1;
}
export function battleLineOfSight(state, a, b) {
  return !state.obstacles.some(o => o.blocksSight !== false && segmentHitsRectangle(a, b, rectangle(o)));
}
function clearMovement(state, a, b, radius = .42) {
  return !state.obstacles.some(o => segmentHitsRectangle(a, b, rectangle(o, radius)));
}
function withinBounds(state, p, radius = .4) {
  return p.x >= state.bounds.minX + radius && p.x <= state.bounds.maxX - radius && p.z >= state.bounds.minZ + radius && p.z <= state.bounds.maxZ - radius;
}
function validPoint(state, point, radius = .42) {
  const p = { x: clamp(point.x, state.bounds.minX + radius, state.bounds.maxX - radius), z: clamp(point.z, state.bounds.minZ + radius, state.bounds.maxZ - radius) };
  for (const obstacle of state.obstacles) {
    const r = rectangle(obstacle, radius + .025);
    if (p.x > r.left && p.x < r.right && p.z > r.top && p.z < r.bottom) {
      const choices = [{ d: p.x - r.left, x: r.left, z: p.z }, { d: r.right - p.x, x: r.right, z: p.z }, { d: p.z - r.top, x: p.x, z: r.top }, { d: r.bottom - p.z, x: p.x, z: r.bottom }];
      choices.sort((a, b) => a.d - b.d); p.x = choices[0].x; p.z = choices[0].z;
    }
  }
  return p;
}
// Build the small, static visibility graph once. Floyd-Warshall is shared by all
// soldiers: movement queries only connect their endpoints to these cached paths.
function navigation(state) {
  const signature = JSON.stringify(state.obstacles.map(o => [o.x, o.z, o.width, o.depth]));
  if (state._navigation?.signature === signature) return state._navigation;
  const nodes = [];
  for (const o of state.obstacles) { const r = rectangle(o, .53); for (const x of [r.left, r.right]) for (const z of [r.top, r.bottom]) { const p = { x, z }; if (withinBounds(state, p) && clearMovement(state, p, p)) nodes.push(p); } }
  const n = nodes.length, costs = Array.from({ length: n }, () => Array(n).fill(Infinity)), next = Array.from({ length: n }, () => Array(n).fill(-1));
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i === j || clearMovement(state, nodes[i], nodes[j])) { costs[i][j] = distance(nodes[i], nodes[j]); next[i][j] = j; }
  for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (costs[i][k] + costs[k][j] < costs[i][j] - EPS) { costs[i][j] = costs[i][k] + costs[k][j]; next[i][j] = next[i][k]; }
  state.metrics.navigationBuilds++;
  return state._navigation = { signature, nodes, costs, next };
}
function route(state, start, rawGoal, radius = .42) {
  const goal = validPoint(state, rawGoal, radius), nav = navigation(state);
  state.metrics.navigationQueries++;
  if (clearMovement(state, start, goal, radius)) return [goal];
  const starts = [], ends = [];
  for (let i = 0; i < nav.nodes.length; i++) { if (clearMovement(state, start, nav.nodes[i], radius)) starts.push(i); if (clearMovement(state, goal, nav.nodes[i], radius)) ends.push(i); }
  let best = Infinity, first = -1, last = -1;
  for (const i of starts) for (const j of ends) { const cost = distance(start, nav.nodes[i]) + nav.costs[i][j] + distance(goal, nav.nodes[j]); if (cost < best) { best = cost; first = i; last = j; } }
  if (first < 0) return [];
  const result = [copyPoint(nav.nodes[first])];
  for (let guard = 0; first !== last && guard < nav.nodes.length; guard++) { first = nav.next[first][last]; if (first < 0) return []; result.push(copyPoint(nav.nodes[first])); }
  result.push(goal); return result;
}
function waypoint(state, unit, goal) {
  if (clearMovement(state, unit, goal, unit.radius)) return goal;
  if (!unit._pathGoal || distance(unit._pathGoal, goal) > 1.4 || !unit._path?.length || !clearMovement(state, unit, unit._path[0], unit.radius)) { unit._path = route(state, unit, goal, unit.radius); unit._pathGoal = copyPoint(goal); }
  // Never skip a corner merely because it is close: the next leg must clear
  // the body radius, or the soldier would cut into cover and lose its route.
  while (unit._path?.length > 1 && clearMovement(state, unit, unit._path[1], unit.radius)) unit._path.shift();
  return unit._path?.[0] || copyPoint(unit);
}

function perceive(state, spatial) {
  const result = { blue: new Map(), red: new Map() };
  for (const observer of state.units) if (observer.alive) {
    const visible = result[observer.team];
    for (const candidate of spatial.near(observer, observer.sight)) if (candidate.team !== observer.team && !visible.has(candidate.id) && battleLineOfSight(state, observer, candidate)) {
      visible.set(candidate.id, { id: candidate.id, team: candidate.team, role: candidate.role, x: candidate.x, z: candidate.z, vx: candidate.vx, vz: candidate.vz, hp: candidate.hp, maxHp: candidate.maxHp, alive: candidate.alive, radius: candidate.radius, speed: candidate.speed, attackRange: candidate.attackRange, observedAt: state.time });
    }
  }
  return result;
}
function remember(state, visibility) {
  for (const team of TEAMS) for (const [id, contact] of visibility[team]) state.knowledge[team][id] = { id, team: contact.team, role: contact.role, x: contact.x, z: contact.z, seenAt: state.time, aliveAtObservation: contact.alive };
}
function emit(state, event) {
  const source = state._byId.get(event.sourceId), target = state._byId.get(event.targetId);
  const visibleTo = TEAMS.filter(team => (!source || source.team === team || state._visibility[team].has(source.id)) && (!target || target.team === team || state._visibility[team].has(target.id)));
  const full = { id: ++state._eventId, tick: state.tick, time: state.time, sourceId: null, targetId: null,
    sourceX: source?.x ?? null, sourceZ: source?.z ?? null, targetX: target?.x ?? null, targetZ: target?.z ?? null,
    x: target?.x ?? source?.x ?? 0, z: target?.z ?? source?.z ?? 0, sourceTeam: source?.team ?? null, team: source?.team ?? null,
    ...event, visibleTo };
  state.events.push(full); return full;
}

export function createBattle(seed = 'crossing', { perSide = 24 } = {}) {
  if (!Number.isInteger(perSide) || perSide < 1 || perSide > 120) throw new RangeError('perSide must be an integer from 1 to 120.');
  const state = { seed: String(seed), time: 0, tick: 0, bounds: { minX: -32, maxX: 32, minZ: -22, maxZ: 22 },
    units: [], squads: [], obstacles: [
      { id: 'west-rocks', x: -2.6, z: -6.4, width: 3.7, depth: 4.2, height: 1.8, blocksSight: true },
      { id: 'east-rocks', x: 2.6, z: 6.4, width: 3.7, depth: 4.2, height: 1.8, blocksSight: true },
      { id: 'north-ruin', x: -10, z: 13.5, width: 3, depth: 3.3, height: 2.2, blocksSight: true },
      { id: 'south-ruin', x: 10, z: -13.5, width: 3, depth: 3.3, height: 2.2, blocksSight: true },
    ], events: [], projectiles: [], knowledge: { blue: {}, red: {} }, outcome: null,
    metrics: { shots: 0, impacts: 0, misses: 0, deaths: 0, targetChanges: 0, withdrawals: 0, spacingMoves: 0, intercepts: 0, pursuits: 0, pursuitRefusals: 0, focusFireShots: 0,
      spatialQueries: 0, candidateChecks: 0, navigationQueries: 0, navigationBuilds: 0,
      damageByTeam: { blue: 0, red: 0 }, killsByTeam: { blue: 0, red: 0 }, shotsByTeam: { blue: 0, red: 0 } },
    _eventId: 0, _shotId: 0, _byId: new Map(), _visibility: { blue: new Map(), red: new Map() }, _navigation: null };
  const rand = randomFor(seed);
  // Largest practical ratio preserving an infantry majority and two scouts at 24.
  const counts = { scout: perSide >= 8 ? Math.max(1, Math.round(perSide / 12)) : 0, ranged: perSide >= 3 ? Math.round(perSide / 3) : 0 };
  counts.infantry = perSide - counts.scout - counts.ranged;
  for (const team of TEAMS) {
    const d = direction(team); let serial = 0;
    for (const role of ['infantry', 'ranged', 'scout']) {
      const count = counts[role], groups = role === 'scout' ? count : count > 5 ? 2 : count ? 1 : 0;
      for (let g = 0; g < groups; g++) {
        const members = role === 'scout' ? 1 : Math.floor(count / groups) + (g < count % groups ? 1 : 0);
        const lane = role === 'scout' ? (g % 2 ? 12 : -12) : groups > 1 ? (g ? 4 : -4) : 0;
        const squad = { id: `${team}-${role}-${g + 1}`, team, role, unitIds: [], objective: { type: 'attack-move', x: d * 25, z: lane }, focusTargetId: null, focusReason: '', nextFocusAt: 0, lane, route: [] };
        state.squads.push(squad);
        for (let i = 0; i < members; i++) {
          const stats = ROLE_STATS[role]; serial++;
          const row = Math.floor(i / 4), column = i % 4;
          const p = validPoint(state, { x: -d * (role === 'ranged' ? 23 + row * 1.25 : role === 'scout' ? 17.5 : 18 + row * 1.2) + (rand() - .5) * .28,
            z: lane + (column - (Math.min(4, members) - 1) / 2) * 1.55 + (rand() - .5) * .24 });
          const unit = { id: `${team}-${String(serial).padStart(2, '0')}`, team, role, squadId: squad.id, ...p, prevX: p.x, prevZ: p.z, vx: 0, vz: 0,
            hp: stats.maxHp, maxHp: stats.maxHp, alive: true, speed: stats.speed, radius: stats.radius, sight: stats.sight,
            attackRange: stats.range, attackDamage: stats.damage, attackCooldown: stats.cooldown, attackReadyAt: rand() * .35,
            targetId: null, action: 'advance', reason: 'Advance with the squad toward its objective.', reasonCode: 'squad-objective',
            order: { type: 'auto' }, heading: d * Math.PI / 2, withdrawing: false, nextDecisionAt: 0,
            slotZ: (column - (Math.min(4, members) - 1) / 2) * 1.2, slotX: -d * row * 1.1, targetSince: 0, _path: [], _pathGoal: null };
          squad.unitIds.push(unit.id); state.units.push(unit); state._byId.set(unit.id, unit);
        }
      }
    }
  }
  for (const squad of state.squads) { const members = squad.unitIds.map(id => state._byId.get(id)); const center = centroid(members); squad.route = route(state, center, squad.objective); }
  state._visibility = perceive(state, new SpatialHash(state.units)); remember(state, state._visibility);
  return state;
}
function centroid(units) { if (!units.length) return { x: 0, z: 0 }; return { x: units.reduce((s, u) => s + u.x, 0) / units.length, z: units.reduce((s, u) => s + u.z, 0) / units.length }; }

/** Constant-velocity interception within attack reach. A null result is a
 * deliberate refusal to predict a catch the soldier cannot physically make. */
export function predictIntercept(pursuer, target, maxTime = 3) {
  const speed = pursuer.speed ?? ROLE_STATS[pursuer.role]?.speed ?? 0, reach = pursuer.attackRange ?? ROLE_STATS[pursuer.role]?.range ?? 0;
  const dx = target.x - pursuer.x, dz = target.z - pursuer.z, vx = target.vx || 0, vz = target.vz || 0;
  const c = dx * dx + dz * dz - reach * reach;
  if (c <= 0 || speed <= 0 || Math.hypot(vx, vz) < .12) return null;
  const a = vx * vx + vz * vz - speed * speed, b = 2 * (dx * vx + dz * vz - speed * reach);
  let roots;
  if (Math.abs(a) < EPS) roots = Math.abs(b) < EPS ? [] : [-c / b];
  else { const disc = b * b - 4 * a * c; if (disc < 0) return null; const sqrt = Math.sqrt(disc); roots = [(-b - sqrt) / (2 * a), (-b + sqrt) / (2 * a)]; }
  const time = roots.filter(t => t > EPS && t <= maxTime).sort((a, b) => a - b)[0];
  return time === undefined ? null : { x: target.x + vx * time, z: target.z + vz * time, time };
}
function updateSquads(state) {
  for (const squad of state.squads) {
    const members = squad.unitIds.map(id => state._byId.get(id)).filter(u => u?.alive);
    squad.center = centroid(members);
    if (!members.length || state.time + EPS < squad.nextFocusAt) continue;
    squad.nextFocusAt = state.time + .6;
    const visible = state._visibility[squad.team];
    const old = visible.get(squad.focusTargetId);
    if (old?.alive && distance(squad.center, old) < 16 && members.some(u => distance(u, old) <= u.attackRange + 3 && battleLineOfSight(state, u, old))) continue;
    const candidates = [...visible.values()].filter(e => e.alive && distance(squad.center, e) < 17 && members.some(u => distance(u, e) <= u.attackRange + 4 && battleLineOfSight(state, u, e)));
    candidates.sort((a, b) => (a.hp / a.maxHp * 3 + distance(squad.center, a)) - (b.hp / b.maxHp * 3 + distance(squad.center, b)) || a.id.localeCompare(b.id));
    squad.focusTargetId = candidates[0]?.id || null;
    squad.focusReason = squad.focusTargetId ? 'Concentrate available attacks on the same visible enemy.' : 'Continue toward the squad objective.';
  }
}
const REASONS = {
  'wounded-withdrawal': 'Wounded: fall back while the rest of the squad keeps fighting.',
  'ranged-spacing': 'Make space from a nearby enemy and keep firing when ready.',
  'feasible-intercept': 'Aim ahead of this moving enemy: the interception is reachable.',
  'direct-pursuit': 'Close on the visible target; a safe interception is unavailable.',
  'hold-range': 'Hold a useful firing distance from the current target.',
  'melee-contact': 'Stay with this opponent and strike when ready.',
  'squad-objective': 'Advance with the squad toward its objective.',
  'move-order': 'Move to the ordered position.',
  'hold-order': 'Hold this position and attack enemies within reach.',
  'retreat-order': 'Withdraw to the ordered position; fire back when able.',
  'attack-order': 'Engage the enemy selected by the order.',
  'target-lost': 'The last target left sight; continue the assigned objective.',
  'pursuit-refused': 'This chase cannot close safely; return to the squad objective.',
  'battle-ended': 'The fighting has ended.',
};
function changeDecision(state, unit, targetId, action, code, targetReason, extra = {}) {
  const oldTargetId = unit.targetId, oldAction = unit.action, oldCode = unit.reasonCode;
  if (oldTargetId !== targetId || oldAction !== action || oldCode !== code) {
    if (oldTargetId !== targetId) { state.metrics.targetChanges++; unit.targetSince = state.time; }
    if (action === 'withdraw' && oldAction !== 'withdraw') state.metrics.withdrawals++;
    if (action === 'space' && oldAction !== 'space') state.metrics.spacingMoves++;
    if (action === 'intercept' && oldAction !== 'intercept') state.metrics.intercepts++;
    if (action === 'pursue' && oldAction !== 'pursue') state.metrics.pursuits++;
    emit(state, { type: 'decision', sourceId: unit.id, targetId, unitId: unit.id, oldTargetId, oldAction, action,
      reason: oldTargetId !== targetId ? targetReason : code, reasonCode: code, detail: REASONS[code] || code, ...extra });
  }
  unit.targetId = targetId; unit.action = action; unit.reasonCode = code; unit.reason = REASONS[code] || code;
}
function selectTarget(state, unit, spatial, squad) {
  const visible = state._visibility[unit.team], old = visible.get(unit.targetId), order = unit.order;
  const limit = unit.role === 'ranged' ? 16 : unit.role === 'scout' ? 16 : 11;
  const candidates = spatial.near(unit, limit).filter(e => e.alive && e.team !== unit.team && visible.has(e.id) && !(unit._ignoredTargets?.[e.id] > state.time) && battleLineOfSight(state, unit, e));
  const nearest = candidates.reduce((best, c) => !best || distance(unit, c) < distance(unit, best) ? c : best, null);
  if (order.type === 'attack') { const ordered = candidates.find(e => e.id === order.targetId); if (ordered) return { target: visible.get(ordered.id), reason: 'attack-order' }; }
  const restricted = order.type === 'move' || order.type === 'hold' || order.type === 'retreat';
  const oldLegal = old?.alive && !(unit._ignoredTargets?.[old.id] > state.time) && distance(unit, old) <= (restricted ? unit.attackRange + .15 : limit + 2) && battleLineOfSight(state, unit, old);
  if (oldLegal) {
    // Hysteresis: a soldier keeps a viable opponent. Switching is justified only
    // by a close threat while the current opponent is outside attack range.
    const urgent = nearest && nearest.id !== old.id && distance(unit, nearest) <= (unit.role === 'ranged' ? 3.5 : 1.8) && distance(unit, old) > unit.attackRange + .4;
    if (!urgent) return { target: old, reason: 'keep-target' };
    return { target: visible.get(nearest.id), reason: 'immediate-threat' };
  }
  let available = restricted ? candidates.filter(e => distance(unit, e) <= unit.attackRange + .15) : candidates;
  const focus = unit.role === 'ranged' && available.find(e => e.id === squad?.focusTargetId && distance(unit, e) <= unit.attackRange + 2.5);
  if (focus) return { target: visible.get(focus.id), reason: 'focus-fire' };
  available = available.map(e => ({ unit: e, score: distance(unit, e) + e.hp / e.maxHp * .75 + (unit.role === 'scout' && e.role === 'ranged' ? -.8 : 0) }));
  available.sort((a, b) => a.score - b.score || a.unit.id.localeCompare(b.unit.id));
  const target = available[0] ? visible.get(available[0].unit.id) : null;
  return { target, reason: unit.targetId ? (old && !old.alive ? 'target-dead' : !old ? 'target-lost' : 'target-unreachable') : 'acquire-visible-target' };
}
function planUnit(state, unit, spatial, squad) {
  const chosen = selectTarget(state, unit, spatial, squad);
  let target = chosen.target;
  const lowHp = unit.hp / unit.maxHp <= (unit.role === 'ranged' ? .38 : .30);
  // Withdrawal is individual and does not remove this soldier from target lists.
  if (lowHp && !unit.withdrawing) { unit.withdrawing = true; unit.withdrawSince = state.time; }
  if (target && !unit.withdrawing && !['hold', 'retreat', 'move'].includes(unit.order.type) && distance(unit, target) > unit.attackRange + .35) {
    const gap = distance(unit, target);
    if (unit._pursuit?.id !== target.id) unit._pursuit = { id: target.id, startedAt: state.time, lastProgressAt: state.time, bestGap: gap, x: unit.x, z: unit.z };
    const pursuit = unit._pursuit;
    if (gap < pursuit.bestGap - .4) { pursuit.bestGap = gap; pursuit.lastProgressAt = state.time; }
    const radialSpeed = ((target.x - unit.x) * target.vx + (target.z - unit.z) * target.vz) / gap;
    const impossible = radialSpeed >= unit.speed * .99 && !predictIntercept(unit, target, 4);
    const expired = state.time - pursuit.startedAt > 8 || state.time - pursuit.lastProgressAt > 3.2 || distance(unit, pursuit) > 16;
    if (impossible || expired) {
      unit._ignoredTargets ??= {}; unit._ignoredTargets[target.id] = state.time + 5;
      unit._lastPursuitRefusal = state.time; unit._pursuit = null;
      state.metrics.pursuitRefusals++; target = null; chosen.reason = impossible ? 'faster-enemy-escaping' : 'pursuit-leash';
    }
  } else unit._pursuit = null;
  let action = 'advance', code = 'squad-objective', goal, speedScale = 1, intercept = null;
  if (unit.withdrawing || unit.order.type === 'retreat') {
    action = 'withdraw'; code = unit.order.type === 'retreat' ? 'retreat-order' : 'wounded-withdrawal';
    goal = unit.order.type === 'retreat' && Number.isFinite(unit.order.x) ? unit.order : { x: -direction(unit.team) * 29, z: clamp(unit.z + (unit.z >= 0 ? 1.5 : -1.5), -19, 19) };
    speedScale = unit.withdrawing ? .86 : 1;
  } else if (unit.order.type === 'move') {
    goal = unit.order; action = 'move'; code = 'move-order';
  } else if (unit.order.type === 'hold') {
    goal = unit.order; action = 'hold'; code = 'hold-order';
  } else if (target) {
    const dist = distance(unit, target);
    if (unit.role === 'ranged') {
      const threats = spatial.near(unit, 8).filter(e => e.alive && e.team !== unit.team && state._visibility[unit.team].has(e.id) && battleLineOfSight(state, unit, e));
      const threat = threats.reduce((a, b) => !a || distance(unit, b) < distance(unit, a) ? b : a, null);
      unit._spacing = !!threat && distance(unit, threat) < (unit._spacing ? 7.3 : 5.8);
      if (unit._spacing) {
        const gap = Math.max(.1, distance(unit, threat));
        goal = { x: unit.x + (unit.x - threat.x) / gap * 3.5, z: unit.z + (unit.z - threat.z) / gap * 3.5 };
        action = 'space'; code = 'ranged-spacing';
      } else if (dist > unit.attackRange - .7) { goal = target; action = 'pursue'; code = 'direct-pursuit'; }
      else { goal = unit; action = 'attack'; code = 'hold-range'; }
    } else if (dist <= unit.attackRange - .13) { goal = unit; action = 'attack'; code = 'melee-contact'; }
    else {
      const away = ((target.x - unit.x) * target.vx + (target.z - unit.z) * target.vz) / Math.max(dist, .1) > .2;
      const possible = away ? predictIntercept({ ...unit, speed: unit.speed * speedScale }, target) : null;
      if (possible && withinBounds(state, possible) && clearMovement(state, unit, possible, unit.radius)) {
        goal = possible; action = 'intercept'; code = 'feasible-intercept'; intercept = possible;
      } else { goal = target; action = 'pursue'; code = 'direct-pursuit'; }
    }
  } else {
    const base = unit.order.type === 'attack-move' ? unit.order : squad?.objective || { x: direction(unit.team) * 25, z: 0 };
    goal = { x: base.x + (unit.order.type === 'attack-move' ? 0 : unit.slotX), z: base.z + (unit.order.type === 'attack-move' ? 0 : unit.slotZ) };
    if (unit.order.type === 'attack' && unit.order.lastSeen) goal = unit.order.lastSeen;
    if (state.time - (unit._lastPursuitRefusal ?? -Infinity) < 5) code = 'pursuit-refused';
  }
  goal = validPoint(state, goal, unit.radius + .015);
  changeDecision(state, unit, target?.id || null, action, code, chosen.reason, intercept ? { intercept: { ...intercept }, targetVX: target.vx, targetVZ: target.vz, pursuerSpeed: unit.speed * speedScale } : {});
  unit.intercept = intercept;
  return { unit, goal, targetId: target?.id || null, speedScale };
}
function moveUnits(state, plans, spatial, dt) {
  for (const { unit, goal, speedScale } of plans) {
    unit.prevX = unit.x; unit.prevZ = unit.z;
    const next = waypoint(state, unit, goal), dist = distance(unit, next);
    let vx = 0, vz = 0;
    if (dist > .12) { const speed = Math.min(unit.speed * speedScale, dist / dt); vx = (next.x - unit.x) / dist * speed; vz = (next.z - unit.z) / dist * speed; }
    // Local soft separation has no army-wide engagement or frontage limit.
    for (const peer of spatial.near(unit, 1.1)) if (peer.alive && peer.id !== unit.id) {
      const gap = distance(unit, peer), desired = unit.radius + peer.radius + .1;
      if (gap < desired && gap > EPS) { const strength = (desired - gap) * 3; vx += (unit.x - peer.x) / gap * strength; vz += (unit.z - peer.z) / gap * strength; }
    }
    const speed = Math.hypot(vx, vz), max = unit.speed * speedScale;
    if (speed > max) { vx *= max / speed; vz *= max / speed; }
    const destination = validPoint(state, { x: unit.x + vx * dt, z: unit.z + vz * dt }, unit.radius);
    if (clearMovement(state, unit, destination, unit.radius - .015)) { unit.x = destination.x; unit.z = destination.z; }
    else {
      const slideX = { x: destination.x, z: unit.z }, slideZ = { x: unit.x, z: destination.z };
      if (clearMovement(state, unit, slideX, unit.radius - .015)) unit.x = slideX.x;
      if (clearMovement(state, unit, slideZ, unit.radius - .015)) unit.z = slideZ.z;
    }
  }
  // Symmetric collision resolution is local and affects bodies, never hit points.
  for (let pass = 0; pass < 2; pass++) {
    const moved = new SpatialHash(state.units.filter(u => u.alive), state.metrics);
    for (const unit of state.units) if (unit.alive) for (const peer of moved.near(unit, .85)) if (peer.id > unit.id) {
      let dx = peer.x - unit.x, dz = peer.z - unit.z, gap = Math.hypot(dx, dz); const min = unit.radius + peer.radius;
      if (gap >= min - .002) continue;
      if (gap < EPS) { dx = unit.id < peer.id ? 1 : -1; dz = 0; gap = 1; }
      const overlap = Math.max(.02, min - distance(unit, peer)) * .5;
      for (const [body, sign] of [[unit, -1], [peer, 1]]) {
        const p = validPoint(state, { x: body.x + sign * dx / gap * overlap, z: body.z + sign * dz / gap * overlap }, body.radius);
        if (clearMovement(state, body, p, body.radius - .015)) { body.x = p.x; body.z = p.z; }
      }
    }
  }
  for (const { unit } of plans) { unit.vx = (unit.x - unit.prevX) / dt; unit.vz = (unit.z - unit.prevZ) / dt; if (Math.hypot(unit.vx, unit.vz) > .08) unit.heading = Math.atan2(unit.vx, unit.vz); }
}
function resolveImpacts(state) {
  const future = [];
  for (const shot of state.projectiles) {
    if (shot.impactAt > state.time + EPS) { future.push(shot); continue; }
    const source = state._byId.get(shot.sourceId), target = state._byId.get(shot.targetId);
    const invalid = !target?.alive || target.team === shot.team || (source && source.team !== shot.team);
    const missed = shot.projectile && (distance(target || { x: Infinity, z: Infinity }, { x: shot.toX, z: shot.toZ }) > (target?.radius || .35) + .3 || !battleLineOfSight(state, { x: shot.fromX, z: shot.fromZ }, { x: shot.toX, z: shot.toZ }));
    if (invalid || missed) {
      if (shot.projectile) {
        state.metrics.misses++;
        emit(state, { type: 'miss', sourceId: shot.sourceId, targetId: shot.targetId, sourceTeam: shot.team, team: shot.team, shotId: shot.id,
          x: shot.toX, z: shot.toZ, targetX: shot.toX, targetZ: shot.toZ, sourceX: shot.fromX, sourceZ: shot.fromZ,
          damage: 0, role: shot.role, projectile: true, reason: invalid ? 'target-unavailable' : 'target-evaded-or-cover' });
      }
      continue;
    }
    const hpBefore = target.hp, damage = Math.min(hpBefore, shot.damage);
    target.hp = Math.max(0, hpBefore - damage);
    state.metrics.impacts++; state.metrics.damageByTeam[shot.team] += damage;
    emit(state, { type: 'impact', sourceId: shot.sourceId, targetId: target.id, sourceTeam: shot.team, team: shot.team, shotId: shot.id,
      sourceX: shot.fromX, sourceZ: shot.fromZ, targetX: target.x, targetZ: target.z, x: target.x, z: target.z,
      role: shot.role, projectile: shot.projectile, damage, hpBefore, hpAfter: target.hp, targetAction: target.action });
    if (target.hp <= 0) {
      target.alive = false; target.deathAt = state.time; target.killedBy = shot.sourceId; target.vx = 0; target.vz = 0; target.targetId = null;
      const previousAction = target.action; target.action = 'dead'; target.reason = `Killed by ${shot.sourceId}.`; target.reasonCode = 'dead';
      state.metrics.deaths++; state.metrics.killsByTeam[shot.team]++;
      emit(state, { type: 'death', sourceId: shot.sourceId, targetId: target.id, sourceTeam: shot.team, team: target.team, unitId: target.id,
        shotId: shot.id, damage, hpBefore, hpAfter: 0, previousAction, targetAction: previousAction });
    }
  }
  state.projectiles = future;
}
function launchAttacks(state, plans) {
  // All ready attackers launch before any same-pulse melee impacts resolve.
  for (const { unit, targetId } of plans) {
    if (!unit.alive || state.time + EPS < unit.attackReadyAt || !targetId) continue;
    const target = state._byId.get(targetId);
    if (!target?.alive || target.team === unit.team || !state._visibility[unit.team].has(target.id) || distance(unit, target) > unit.attackRange + EPS || !battleLineOfSight(state, unit, target)) continue;
    const projectile = unit.role === 'ranged';
    let duration = projectile ? Math.max(.12, distance(unit, target) / 24) : 0;
    let aim = { x: target.x, z: target.z };
    if (projectile) {
      // Solve a short ballistic lead from observable velocity. The shot never
      // changes target or homes; later movement can genuinely evade this point.
      for (let i = 0; i < 3; i++) { aim = { x: target.x + target.vx * duration, z: target.z + target.vz * duration }; duration = Math.max(.12, distance(unit, aim) / 24); }
      if (!withinBounds(state, aim, 0) || !battleLineOfSight(state, unit, aim)) { aim = copyPoint(target); duration = Math.max(.12, distance(unit, aim) / 24); }
    }
    const shot = { id: ++state._shotId, sourceId: unit.id, targetId: target.id, team: unit.team, role: unit.role, damage: unit.attackDamage,
      projectile, fromX: unit.x, fromZ: unit.z, toX: aim.x, toZ: aim.z, launchedAt: state.time, impactAt: state.time + duration };
    unit.attackReadyAt = state.time + unit.attackCooldown;
    state.metrics.shots++; state.metrics.shotsByTeam[unit.team]++;
    const squad = state.squads.find(s => s.id === unit.squadId);
    const focusFire = unit.role === 'ranged' && squad?.focusTargetId === target.id;
    if (focusFire) state.metrics.focusFireShots++;
    emit(state, { type: 'shot', sourceId: unit.id, targetId: target.id, shotId: shot.id, role: unit.role, projectile, duration,
      fromX: shot.fromX, fromZ: shot.fromZ, toX: shot.toX, toZ: shot.toZ, targetX: shot.toX, targetZ: shot.toZ, impactAt: shot.impactAt,
      damage: unit.attackDamage, hpBefore: target.hp, attackCooldown: unit.attackCooldown, attackReadyAt: unit.attackReadyAt, action: unit.action,
      reason: focusFire ? 'focus-fire' : unit.reasonCode, focusFire });
    state.projectiles.push(shot);
  }
}
function updateOutcome(state) {
  const living = Object.fromEntries(TEAMS.map(team => [team, state.units.filter(u => u.team === team && u.alive).length]));
  if ((!living.blue || !living.red) && !state.projectiles.length) {
    state.outcome = { winner: living.blue ? 'blue' : living.red ? 'red' : null, reason: !living.blue && !living.red ? 'mutual-destruction' : 'elimination', time: state.time };
  }
  // A battle can finish with surviving wounded on both sides after a genuine
  // disengagement; this is explicitly a draw, never invented casualties.
  if (!state.outcome && state.time > 35 && state.units.filter(u => u.alive).every(u => u.withdrawing || u.order.type === 'retreat')) {
    const anyContact = TEAMS.some(team => [...state._visibility[team].values()].some(u => u.alive));
    if (!anyContact && !state.projectiles.length) state._disengagedAt ??= state.time; else state._disengagedAt = null;
    if (state._disengagedAt != null && state.time - state._disengagedAt > 6) state.outcome = { winner: null, reason: 'both-sides-disengaged', time: state.time };
  }
  if (state.outcome) for (const unit of state.units) if (unit.alive) { unit.action = 'hold'; unit.reasonCode = 'battle-ended'; unit.reason = REASONS['battle-ended']; unit.vx = unit.vz = 0; }
}

/** Exactly one simulation pulse, with no wall-clock accumulation or hidden steps. */
export function stepBattle(state, dt = BATTLE_STEP) {
  if (!Number.isFinite(dt) || dt <= 0 || dt > .25) throw new RangeError('A battle pulse must be greater than zero and at most 0.25 seconds.');
  if (state.outcome) return state;
  state.time = Math.round((state.time + dt) * 1e9) / 1e9; state.tick++;
  state._byId = new Map(state.units.map(u => [u.id, u]));
  state._visibility = perceive(state, new SpatialHash(state.units, state.metrics));
  resolveImpacts(state);
  const spatial = new SpatialHash(state.units.map(u => ({ ...u })), state.metrics);
  state._visibility = perceive(state, spatial); remember(state, state._visibility); updateSquads(state);
  const squads = new Map(state.squads.map(s => [s.id, s]));
  const plans = state.units.filter(u => u.alive).map(unit => planUnit(state, unit, spatial, squads.get(unit.squadId)));
  moveUnits(state, plans, spatial, dt);
  state._visibility = perceive(state, new SpatialHash(state.units, state.metrics));
  launchAttacks(state, plans); resolveImpacts(state);
  state._visibility = perceive(state, new SpatialHash(state.units, state.metrics)); remember(state, state._visibility);
  updateOutcome(state); return state;
}

export function issueBattleOrder(state, unitIds, order) {
  const allowed = new Set(['move', 'hold', 'attack-move', 'retreat', 'attack']);
  if (!order || !allowed.has(order.type) || !Array.isArray(unitIds)) return { accepted: [], rejected: Array.isArray(unitIds) ? [...unitIds] : [], reason: 'Invalid order.' };
  const selected = state.units.filter(u => unitIds.includes(u.id) && u.alive), center = centroid(selected);
  if (['move', 'attack-move'].includes(order.type) && (!Number.isFinite(order.x) || !Number.isFinite(order.z))) return { accepted: [], rejected: [...unitIds], reason: 'A finite destination is required.' };
  const visibility = perceive(state, new SpatialHash(state.units)), accepted = [];
  state._byId = new Map(state.units.map(u => [u.id, u])); state._visibility = visibility;
  for (const unit of selected) {
    const next = { type: order.type, issuedAt: state.time };
    if (order.type === 'attack') {
      const target = visibility[unit.team].get(order.targetId);
      if (!target?.alive || target.team === unit.team) continue;
      next.targetId = target.id; next.lastSeen = copyPoint(target);
    } else {
      const destination = order.type === 'hold' ? unit : { x: Number.isFinite(order.x) ? order.x : -direction(unit.team) * 29, z: Number.isFinite(order.z) ? order.z : center.z };
      const spread = order.type === 'hold' ? { x: 0, z: 0 } : { x: clamp(unit.x - center.x, -2, 2), z: clamp(unit.z - center.z, -4, 4) };
      Object.assign(next, validPoint(state, { x: destination.x + spread.x, z: destination.z + spread.z }));
    }
    unit.order = next; unit._path = []; unit._pathGoal = null; accepted.push(unit.id);
    emit(state, { type: 'decision', sourceId: unit.id, targetId: next.targetId || null, unitId: unit.id, oldTargetId: unit.targetId,
      action: order.type, reason: 'player-order', detail: `Order: ${order.type}.`, order: { ...next } });
  }
  for (const squad of state.squads) if (squad.unitIds.every(id => accepted.includes(id) || !state._byId.get(id)?.alive)) {
    const member = state._byId.get(squad.unitIds.find(id => accepted.includes(id)));
    if (member) squad.objective = { ...member.order };
  }
  return { accepted, rejected: unitIds.filter(id => !accepted.includes(id)), reason: accepted.length ? 'Order issued.' : 'No eligible visible target or living soldier.' };
}
function publicUnit(unit) {
  const copy = Object.fromEntries(Object.entries(unit).filter(([key]) => !key.startsWith('_')));
  return { ...copy, order: { ...unit.order, ...(unit.order.lastSeen ? { lastSeen: { ...unit.order.lastSeen } } : {}) }, ...(unit.intercept ? { intercept: { ...unit.intercept } } : {}) };
}
export function getBattleView(state, perspective = 'all') {
  if (perspective !== 'all' && !TEAMS.includes(perspective)) throw new RangeError('Perspective must be all, blue, or red.');
  const all = perspective === 'all', visibility = perceive(state, new SpatialHash(state.units));
  const visible = all ? new Set(state.units.map(u => u.id)) : new Set(visibility[perspective].keys());
  const known = all ? {} : state.knowledge[perspective];
  const shown = state.units.filter(u => all || u.team === perspective || visible.has(u.id) || (!u.alive && known[u.id]?.aliveAtObservation === false));
  const shownIds = new Set(shown.map(u => u.id));
  const units = shown.map(unit => {
    const copy = publicUnit(unit);
    // Enemy intentions, hidden target identifiers and navigation are never intel.
    if (!all && unit.team !== perspective) {
      return { id: copy.id, team: copy.team, role: copy.role, x: copy.x, z: copy.z, prevX: copy.prevX, prevZ: copy.prevZ,
        vx: copy.vx, vz: copy.vz, hp: copy.hp, maxHp: copy.maxHp, alive: copy.alive, radius: copy.radius, heading: copy.heading,
        action: !copy.alive ? 'dead' : Math.hypot(copy.vx, copy.vz) > .08 ? 'move' : 'hold',
        reason: copy.alive ? 'Observed enemy movement.' : 'Observed casualty.', order: { type: 'unknown' }, targetId: null };
    }
    return copy;
  });
  const recent = [];
  for (let i = state.events.length - 1; i >= 0 && recent.length < 180; i--) {
    const event = state.events[i];
    if (all || (event.visibleTo.includes(perspective) && (event.type !== 'decision' || event.sourceTeam === perspective))) recent.push(event);
  }
  const events = recent.reverse().map(e => {
    const copy = { ...e, visibleTo: all ? [...e.visibleTo] : [perspective] };
    if (e.intercept) copy.intercept = { ...e.intercept };
    if (e.order) copy.order = { ...e.order };
    if (!all && e.sourceTeam !== perspective) { delete copy.attackReadyAt; delete copy.attackCooldown; delete copy.reason; delete copy.focusFire; delete copy.action; }
    if (!all && state._byId.get(e.targetId)?.team !== perspective) { delete copy.targetAction; delete copy.previousAction; }
    return copy;
  });
  return { seed: state.seed, time: state.time, tick: state.tick, perspective, bounds: { ...state.bounds }, units,
    squads: state.squads.filter(s => all || s.team === perspective).map(s => ({ ...s, objective: { ...s.objective }, center: s.center ? { ...s.center } : undefined, unitIds: [...s.unitIds], route: s.route.map(copyPoint) })),
    obstacles: state.obstacles.map(o => ({ ...o })), events,
    projectiles: state.projectiles.filter(p => all || (shownIds.has(p.sourceId) && visible.has(p.targetId)) || (p.team === perspective && visible.has(p.targetId))).map(p => ({ ...p })),
    metrics: all ? { ...state.metrics, damageByTeam: { ...state.metrics.damageByTeam }, killsByTeam: { ...state.metrics.killsByTeam }, shotsByTeam: { ...state.metrics.shotsByTeam } } : {
      shots: state.metrics.shotsByTeam[perspective], ownAlive: state.units.filter(u => u.team === perspective && u.alive).length,
      ownDead: state.units.filter(u => u.team === perspective && !u.alive).length, visibleEnemies: [...visibility[perspective].values()].filter(u => u.alive).length },
    outcome: state.outcome ? { ...state.outcome } : null,
    sight: { observers: state.units.filter(u => u.alive && (all || u.team === perspective)).map(u => ({ id: u.id, team: u.team, x: u.x, z: u.z, radius: u.sight })),
      visibleEnemyIds: all ? state.units.filter(u => u.alive).map(u => u.id) : [...visibility[perspective].values()].filter(u => u.alive).map(u => u.id),
      contacts: Object.values(known).filter(c => !visible.has(c.id) && c.aliveAtObservation).map(c => ({ id: c.id, team: c.team, role: c.role, x: c.x, z: c.z, seenAt: c.seenAt, stale: true })) } };
}
export function battleSummary(state) {
  const teams = Object.fromEntries(TEAMS.map(team => {
    const units = state.units.filter(u => u.team === team);
    return [team, { initial: units.length, alive: units.filter(u => u.alive).length, dead: units.filter(u => !u.alive).length,
      hp: units.reduce((total, u) => total + u.hp, 0), maxHp: units.reduce((total, u) => total + u.maxHp, 0),
      wounded: units.filter(u => u.alive && u.hp < u.maxHp).length, withdrawing: units.filter(u => u.alive && u.withdrawing).length,
      roles: Object.fromEntries(Object.keys(ROLE_STATS).map(role => [role, units.filter(u => u.role === role && u.alive).length])),
      shots: state.metrics.shotsByTeam[team], damage: state.metrics.damageByTeam[team], kills: state.metrics.killsByTeam[team] }];
  }));
  return { seed: state.seed, time: state.time, tick: state.tick, teams, blue: teams.blue, red: teams.red, outcome: state.outcome ? { ...state.outcome } : null,
    metrics: { ...state.metrics, damageByTeam: { ...state.metrics.damageByTeam }, killsByTeam: { ...state.metrics.killsByTeam }, shotsByTeam: { ...state.metrics.shotsByTeam } } };
}
