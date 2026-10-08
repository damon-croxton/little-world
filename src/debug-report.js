import { normalizeConfig, MATCH_SETTINGS, MATCH_SETTINGS_VERSION } from './config.js';
// Read-only observer diagnostics. Never imported by the simulation.
import { factionController, settlementController, groupController } from './sim/control.js';
import { localGroupController } from './sim/knowledge.js';
import { civilianHealth } from './sim/civilians.js';

export const DEBUG_LIMITS = Object.freeze({ sampleMs: 2000, movementMs: 10000, events: 768, historyBytes: 512 * 1024,
  reportBytes: 4 * 1024 * 1024, snapshotBytes: 3 * 1024 * 1024, factions: 12, homes: 48, groups: 480,
  buildings: 2048, soldiers: 6000, knowledgePerFaction: 256, nodes: 256, string: 256 });
const encoder = new TextEncoder();
const keys = text => text.split(' ');
const scalar = value => typeof value === 'string' ? value.slice(0, DEBUG_LIMITS.string) :
  typeof value === 'number' ? (Number.isFinite(value) ? value : null) : typeof value === 'boolean' || value === null ? value : undefined;
function pick(value, fields) {
  const out = {};
  for (const key of keys(fields)) { const v = scalar(value?.[key]); if (v !== undefined) out[key] = v; }
  return out;
}
const resources = value => pick(value, 'food water energy materials');
const point = value => pick(value, 'x z');
const order = value => pick(value, 'id role kind missionKind objectiveId targetId enemyId originId groupId phase size committedSize issuedTick createdTick departedTick expiresTick reportDeadline reason x z');
const combat = value => ({ ...pick(value, 'assessedAt active intent reason targetId targetKind decisionUntil retreatUntil engagedAt ownStrength enemyStrength supportStrength localStrength strengthRatio'),
  routeDecision: pick(value?.routeDecision, 'action wallId reason savedSeconds') });
const rally = value => pick(value, 'id kind phase targetId frontGroupId x z destinationX destinationZ reachable minimumBatch required assembled assembleDeadline committedTick reason');
const defense = value => pick(value, 'available ready recovering committed reserve observedThreat reportedThreat allIn deployable tick reason');
const settings = view => pick(view, 'speed paused quality perspective overlay selectedId followId cinematic worldGeneration');
const perf = view => ({ ...pick(view, 'fps frameMs'), ...pick(view?.performance, 'mode speed quality sampledFrames sampledSeconds simulationPulses simulationCyclesPerSecond simulationMs sceneUpdateMs renderSubmitMs cpuMs backlogSeconds droppedRequestedSeconds gpuTiming') });
const stamp = state => pick(state, 'step tick time');
const eventFields = 'id tick time type text factionId settlementId groupId targetId sourceId reason deaths damage';
const reportFields = 'id kind groupKind resourceKind x z ownerId nativeFactionId nativeOwnerId ownerSpecies nativeSpecies observedTick observedTime reportedTick reportedTime reportedAtSettlementId reportMethod status confidence soldiersEstimate populationEstimate sizeEstimate amountEstimate activity targetId';
function groupDecision(state, g) {
  return { ...pick(g, 'id factionId originId kind phase strategicRole missionKind missionEnemyId missionTargetId targetId operationId stagingTargetId stagingPurpose reason finished disabled'),
    controllerId: g.kind === 'worker' ? factionController(state, localGroupController(state, g)) : groupController(state, g), combat: combat(g.combat), hold: rally(g.strategicHold),
    navigation: pick(g.navigation, 'reachable reason'), progress: pick(g.objectiveProgress, 'objective retries') };
}
function homeDecision(state, h) {
  return { id: h.id, controllerId: settlementController(state, h), defense: defense(h.defensePlan), rally: rally(h.productionRally),
    recovery: pick(h.militaryRecovery, 'tick patients treated readyAgain healedHp reason'),
    mobilization: pick(h.lastMobilization, 'tick ready reserved requested dispatched reason'),
    economyReasons: (h.economyReasons || []).slice(0, 8).map(scalar) };
}

export function createDebugRecorder({ now = () => performance.now() } = {}) {
  let history = [], bytes = 0, dropped = 0, generation = 0, start = now(), lastSample = -Infinity, lastMovement = -Infinity;
  let previous = new Map(), lastEventId = null, lastStep = null, settingsKey = '', sampleCount = 0, totalMs = 0, maximumMs = 0, eventGaps = 0;
  function append(kind, state, data) {
    const entry = JSON.stringify({ kind, ...stamp(state), wallMs: Math.round(now() - start), data });
    const size = encoder.encode(entry).length;
    if (size > DEBUG_LIMITS.historyBytes) { dropped++; return; }
    history.push({ entry, size }); bytes += size;
    while (history.length > DEBUG_LIMITS.events || bytes > DEBUG_LIMITS.historyBytes) { bytes -= history.shift().size; dropped++; }
  }
  function recordSettings(state, view) {
    const value = settings(view), key = JSON.stringify(value);
    if (key !== settingsKey) { append('settings', state, value); settingsKey = key; }
  }
  function reset(state, view) {
    history = []; bytes = dropped = eventGaps = sampleCount = totalMs = maximumMs = 0; generation++;
    start = now(); lastSample = lastMovement = -Infinity; lastStep = lastEventId = null; settingsKey = ''; previous = new Map();
    append('reset', state, { seed: scalar(state.seed), config: normalizeConfig(state.config), generation }); recordSettings(state, view);
  }
  function sample(state, view) {
    const time = now();
    if (time - lastSample < DEBUG_LIMITS.sampleMs) return false;
    lastSample = time; recordSettings(state, view);
    append('performance', state, perf(view));
    if (lastStep !== state.step) {
      lastStep = state.step;
      const next = new Map(), movement = time - lastMovement >= DEBUG_LIMITS.movementMs;
      function change(key, value) {
        const signature = JSON.stringify(value); next.set(key, signature);
        if (previous.get(key) !== signature) append('decision', state, value);
      }
      for (const f of (state.factions || []).slice(0, DEBUG_LIMITS.factions)) change(`f:${f.id}`, { id: f.id, entity: 'faction',
        ...pick(f.strategy, 'mode targetId reason'), operation: rally(f.strategy?.operation) });
      for (const h of (state.settlements || []).slice(0, DEBUG_LIMITS.homes)) change(`h:${h.id}`, { entity: 'settlement', ...homeDecision(state, h) });
      for (const g of (state.groups || []).slice(0, DEBUG_LIMITS.groups)) {
        change(`g:${g.id}`, { entity: 'group', ...groupDecision(state, g) });
        if (movement) append('movement', state, { ...pick(g, 'id x z targetX targetZ size supply morale travelled stuckTime'),
          navigation: pick(g.navigation, 'index length reachable reason'), progress: pick(g.objectiveProgress, 'bestGap at retries') });
      }
      for (const key of previous.keys()) if (!next.has(key)) append('no-longer-present', state, { key });
      previous = next; if (movement) lastMovement = time;
      const events = state.events || [], index = lastEventId ? events.findIndex(e => e.id === lastEventId) : -1;
      if (lastEventId && index < 0 && events.length) eventGaps++;
      for (const e of events.slice(index + 1, index + 161)) append('world-event', state, pick(e, eventFields));
      if (events.length) lastEventId = events.at(-1).id;
    }
    const elapsed = now() - time; sampleCount++; totalMs += elapsed; maximumMs = Math.max(maximumMs, elapsed);
    return true;
  }
  function recordError(state, category, error, location = {}) {
    // Do not retain arbitrary messages, URLs, stacks, rejection payloads or DOM.
    const name = ['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError'].includes(error?.name) ? error.name : 'Error';
    append('error', state, { category: ['runtime', 'promise', 'export'].includes(category) ? category : 'runtime', name,
      ...pick(location, 'line column') });
  }
  function capture(state, view, build = {}) {
    const captureStart = now();
    const omitted = {}, limits = DEBUG_LIMITS;
    let snapshotBytes = 0;
    const rows = (name, values, cap, map) => {
      const result = []; let index = 0;
      for (; index < Math.min(values.length, cap); index++) {
        const item = map(values[index]), size = encoder.encode(JSON.stringify(item)).length;
        if (snapshotBytes + size > limits.snapshotBytes) break;
        snapshotBytes += size; result.push(item);
      }
      if (index < values.length) omitted[name] = (omitted[name] || 0) + values.length - index;
      return result;
    };
    const homes = (state.settlements || []).slice(0, limits.homes);
    const factions = rows('factions', state.factions || [], limits.factions, f => ({ ...pick(f, 'id name species color status defeatedBy intent'),
      controllerId: factionController(state, f), economy: pick(f.economy, 'population soldiers workers settlements sovereignSettlements controlledSettlements controlledPopulation training fieldWorkers camps'), strategy: { ...pick(f.strategy, 'mode targetId chosenAt observedTick intelAge nextReview reason'), operation: rally(f.strategy?.operation) },
      campaignOrders: rows(`orders:${f.id}`, Object.values(f.campaignOrders || {}), 32, order),
      relations: Object.entries(f.relations || {}).slice(0, limits.factions).map(([id, v]) => ({ id, ...pick(v, 'status trust') })) }));
    const settlements = rows('settlements', state.settlements || [], limits.homes, h => ({ ...homeDecision(state, h),
      ...pick(h, 'factionId nativeSpecies name x z status razed destroyedTick ruinReason population homePresent soldiers workers availableWorkers health capacity housingCapacity shortageDays starvation wellbeing'),
      stock: resources(h.stock), net: resources(h.net), production: resources(h.lastProduction), consumption: resources(h.lastConsumption), missingResources: (h.missingResources || []).slice(0, 4).map(scalar),
      assigned: pick(h.assigned, 'workers scouts traders colonists military civilianAway researchers construction infrastructure training towerCrew'),
      training: rows(`training:${h.id}`, h.trainingQueue || [], 32, j => pick(j, 'id role size buildingId progress remaining')) }));
    const groups = rows('groups', state.groups || [], limits.groups, g => ({ ...groupDecision(state, g),
      ...pick(g, 'x z targetX targetZ missionTargetX missionTargetZ size initialSize civilianWounds health maxHealth supply morale speed capacity cargoCapacity travelled stuck stuckTime provisionCycles createdTick workProgress workRemaining extractedTotal'),
      ...(g.kind === 'worker' ? { civilianHealth: civilianHealth(g), civilianMaxHealth: Math.max(0, g.size * 32) } : {}),
      finishPlan: pick(g.finishPlan, 'targetId evaluatedTick estimatedCycles returnReserve supplyNeeded deadline accepted reason'),
      returnSupplyPlan: pick(g.returnSupplyPlan, 'destinationId tick reserve'),
      provisions: resources(g.provisions), carrying: resources(g.carrying), units: pick(g.units, 'infantry ranged scout'),
      navigation: { ...pick(g.navigation, 'index length reachable reason retryAt replanAfter'), goal: point(g.navigation?.goal),
        waypointCount: g.navigation?.waypoints?.length || 0, nextWaypoint: point(g.navigation?.waypoints?.[g.navigation?.index || 0]) },
      objectiveProgress: pick(g.objectiveProgress, 'objective bestGap at retries'), soldierIds: (g.soldierIds || []).slice(0, 1000).map(scalar),
      soldierIdsOmitted: Math.max(0, (g.soldierIds?.length || 0) - 1000), observations: rows(`observations:${g.id}`, [...(g.observations || [])].sort((a,b) => (b.observedTime ?? b.observedTick ?? 0) - (a.observedTime ?? a.observedTick ?? 0)), 16, k => pick(k, reportFields)) }));
    const nodes = rows('nodes', state.nodes || [], limits.nodes, n => pick(n, 'id kind subtype x z amount maxAmount regeneration richness claimedBy claimSettlementId'));
    const buildings = rows('buildings', homes.flatMap(h => (h.buildings || []).map(b => ({ h, b }))), limits.buildings, ({ h, b }) => ({
      ...pick(b, 'id kind x z hp maxHp progress destroyed operational crewAssigned length width rotation'), settlementId: h.id,
      nativeFactionId: h.factionId, controllerId: settlementController(state, h) }));
    const knowledge = rows('knowledge-factions', state.factions || [], limits.factions, f => ({ factionId: f.id,
      reports: rows(`knowledge:${f.id}`, Object.values(f.knowledge || {}), limits.knowledgePerFaction, k => pick(k, reportFields)),
      // IDs of current observations distinguish actual sight from remembered reports. Grids are deliberately excluded.
      visibleIds: Object.keys(f.visibility?.visibleIds || {}).slice(0, 512), visibleIdsOmitted: Math.max(0, Object.keys(f.visibility?.visibleIds || {}).length - 512),
      visibilityUpdatedStep: f.visibility?.updatedStep ?? null }));
    const soldiers = rows('soldiers', homes.flatMap(h => h.soldierRoster || []), limits.soldiers, b => ({
      ...pick(b, 'id originId factionId nativeFactionId commandFactionId species role status alive groupId hp maxHp x z targetId towerId withdrawing action reasonCode targetReason reason cooldown attackReadyAt lastAttackTime lastRecoveryTick recoveredTick recoveredHp'),
      controllerId: factionController(state, b.commandFactionId || b.nativeFactionId || b.factionId), order: order(b.order) }));
    const snapshot = { factions, settlements, groups, nodes, buildings, knowledge, soldiers,
      resourceLedger: Object.fromEntries(['food', 'water', 'energy', 'materials'].map(k => [k, pick(state.resourceLedger?.[k], 'initial regenerated extracted delivered produced consumed construction research training tradeNet lost')])),
      outcome: pick(state.outcome, 'status winnerId wonAt tick'), totals: { factions: state.factions?.length || 0, settlements: state.settlements?.length || 0,
        groups: state.groups?.length || 0, nodes: state.nodes?.length || 0, soldiersInIncludedHomes: homes.reduce((n, h) => n + (h.soldierRoster?.length || 0), 0) } };
    const report = { format: 'littleworld-diagnostic', schemaVersion: 1, matchSettingsSchema: { version: MATCH_SETTINGS_VERSION, controls: MATCH_SETTINGS }, purpose: 'Diagnostic snapshot and sampled history; not a save or deterministic replay.',
      containsHiddenWorldInformation: true, build: pick(build, 'version commit'), capturedAt: new Date().toISOString(),
      world: { ...stamp(state), ...pick(state, 'seed terrainSeed'), generation, config: normalizeConfig(state.config) },
      settings: settings(view), performance: perf(view), limits, snapshot,
      history: history.map(h => JSON.parse(h.entry)), truncation: { omitted, historyDropped: dropped, eventGaps, stringsMayBeClippedAt: limits.string },
      recorder: { sampleCount, totalMs, maximumMs, retainedEvents: history.length, retainedBytes: bytes, captureMs: now() - captureStart } };
    return report;
  }
  return { reset, sample, recordSettings, recordError, capture,
    stats: () => ({ retainedEvents: history.length, retainedBytes: bytes, dropped, sampleCount, totalMs, maximumMs, trackedEntities: previous.size }) };
}

export async function encodeDebugReport(report, { Compression = globalThis.CompressionStream } = {}) {
  const json = JSON.stringify(report), blob = new Blob([json], { type: 'application/json' });
  if (blob.size > DEBUG_LIMITS.reportBytes) throw new RangeError('Diagnostic report exceeded its size limit');
  const base = `littleworld-debug-${String(report.build.commit || 'development').slice(0, 12).replace(/[^a-z0-9-]/gi, '')}-step-${report.world.step}`;
  if (Compression) {
    try {
      const compressed = await new Response(blob.stream().pipeThrough(new Compression('gzip'))).blob();
      if (compressed.size < blob.size) return { blob: new Blob([compressed], { type: 'application/gzip' }), name: `${base}.json.gz`, jsonBytes: blob.size, encoding: 'gzip' };
    } catch { /* Older browsers can still save the same bounded JSON. */ }
  }
  return { blob, name: `${base}.json`, jsonBytes: blob.size, encoding: 'json' };
}
