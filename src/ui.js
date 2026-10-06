import { factionController, settlementController, groupController } from './sim/control.js';
import { MILITARY_BUILDINGS, MILITARY_UNITS } from './sim/military.js';
import { normalizeConfig, MIN_CIV_COUNT, MAX_CIV_COUNT } from './config.js';

const SPECIES = {
  human: { name: 'Human settlers', short: 'Human', mark: 'I', food: 'Provisions', water: 'Water', energy: 'Power', materials: 'Materials' },
  machine: { name: 'Scavenger machines', short: 'Machine', mark: 'II', food: 'Organics', water: 'Coolant', energy: 'Charge', materials: 'Salvage' },
  hive: { name: 'Alien hive', short: 'Hive', mark: 'III', food: 'Biomass', water: 'Water', energy: 'Energy', materials: 'Minerals' },
};
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const num = value => Math.round(n(value)).toLocaleString('en');
const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, n(value)));
const buildingLabel = (kind, species = 'human') => MILITARY_BUILDINGS[kind]?.name || ({ human: { wall: 'Palisade', gate: 'Timber gate', tower: 'Watchtower' }, machine: { wall: 'Alloy barrier', gate: 'Flux gate', tower: 'Arc turret' }, hive: { wall: 'Chitin wall', gate: 'Root passage', tower: 'Quill spire' } }[species]?.[kind]) || String(kind || '').replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const title = value => String(value ?? '').replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const list = value => Array.isArray(value) ? value : [];
const isRuin = settlement => !!settlement && (settlement.status === 'ruin' || (settlement.population != null && n(settlement.population) <= 0));
const isCamp = settlement => settlement?.status === 'camp';
const color = value => /^#[a-f\d]{3,8}$/i.test(value || '') ? value : '#aebcaf';
const icon = name => {
  const paths = {
    pause: '<path d="M8 5v14M16 5v14"/>',
    play: '<path d="m8 5 11 7-11 7Z"/>',
    focus: '<path d="M8 4H4v4m12-4h4v4M4 16v4h4m12-4v4h-4"/><circle cx="12" cy="12" r="3"/>',
    eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    arrow: '<path d="m5 12 14 0m-6-6 6 6-6 6"/>',
    seed: '<path d="M5 19C2 7 10 3 20 4c0 11-4 17-15 15Zm0 0L16 8"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.eye}</svg>`;
};

/** Observer-only DOM. No simulation mutations; all commands go through actions. */
export function createUI(root, actions) {
  let state = null;
  let view = {};
  let activeTab = 'life';
  let eventScope = 'world';
  let previousSelection = null;
  let lastPartyOrigin = null;
  let requestedDefault = false;
  let dismissedGuide = false;
  let disposed = false;
  let advanceInProgress = false;
  let advanceRequest = 0;
  let toastTimer = null;
  let lastFactionId = null;
  let worldIdentity = null;
  let worldGeneration = null;
  let settingsDirty = false;
  let mobilePanel = null;

  root.innerHTML = `
    <div class="atlas-shell">
      <header class="atlas-brand">
        <div class="eyebrow"><span class="live-star" aria-hidden="true">✧</span> A living world · an observer's atlas</div>
        <h1>Little<span>World</span><span class="title-period">.</span><sup>II</sup></h1>
        <button class="brand-caption world-scale" data-action="diagnostics" data-slot="world-scale" title="Actual population and measured render counts">A world of individuals</button>
      </header>

      <section class="time-console glass" aria-label="Simulation controls">
        <div class="world-date"><span class="eyebrow">World cycle</span><strong data-slot="cycle">000</strong><span data-slot="era" class="era-label">First light</span></div>
        <div class="time-actions">
          <button class="pause-button" data-action="pause" title="Pause / resume · Space" aria-label="Pause simulation">${icon('pause')}<span data-slot="pause-label">Pause</span></button>
          <div class="speed-switch" role="group" aria-label="Simulation speed">
            ${[1, 2, 4, 16, 32].map(speed => `<button data-action="speed" data-value="${speed}" aria-pressed="${speed === 2}" title="${speed} simulated cycles per second">${speed}<small>×</small></button>`).join('')}
          </div>
        </div>
        <button class="icon-button settings-toggle" data-action="settings" aria-expanded="false" aria-controls="atlas-settings" title="Seed and quality settings" aria-label="Seed and quality settings">${icon('settings')}</button>
      </section>

      <section id="atlas-settings" class="atlas-settings glass" hidden aria-label="World settings">
        <form class="seed-form"><label class="eyebrow" for="atlas-seed">Grow a different world</label><div class="seed-input-row"><input id="atlas-seed" name="seed" type="text" value="littleworld" maxlength="64" autocomplete="off" spellcheck="false" aria-label="World seed"><button type="submit" title="Start a new world with this seed">${icon('seed')}<span>Reset</span></button></div><div class="civ-setting"><label for="atlas-civs">Starting civilisations <output for="atlas-civs" data-slot="civ-count">4</output></label><input id="atlas-civs" name="civs" type="range" min="${MIN_CIV_COUNT}" max="${MAX_CIV_COUNT}" step="1" value="4" aria-label="Starting civilisations"><p>3–5 is a good starting range. Four is the default.</p></div><p>The same seed and civilisation count repeat the same story. Reset applies both at cycle zero.</p></form><div class="perspective-setting"><label for="atlas-perspective">Observer perspective</label><select id="atlas-perspective" aria-label="Observer perspective"><option value="omniscient">Whole world</option></select><p data-slot="perspective-note">All societies still act from their own limited knowledge.</p></div>
        <div class="quality-setting"><label for="atlas-quality">Render quality</label><select id="atlas-quality" aria-label="Render quality"><option value="high">High</option><option value="low">Performance</option></select></div>
        <div class="render-accounting" data-slot="render-accounting"></div>
        <div class="render-reading"><span data-slot="performance">Measuring the view…</span><button data-action="help" class="text-button">Field guide</button></div>
      </section>

      <nav id="atlas-inhabitants" class="faction-index" aria-label="Factions"><button class="mobile-panel-close" data-action="close-mobile-panel" aria-label="Close inhabitants panel">Close ×</button><div class="section-heading"><span class="eyebrow">The inhabitants</span><span data-slot="faction-count" class="count-label">06</span></div><div data-slot="factions" class="faction-list"></div><p class="faction-index-note">Select a colony, a moving team, or a resource site to follow its work.</p><div class="developed-control"><button class="developed-button" data-action="develop" title="Actually simulate another 1,200 cycles of this current seed">${icon('arrow')}<span>Developed world</span></button><p>Simulate this world forward 1,200 cycles.</p></div></nav>

      <aside id="atlas-inspector" class="inspector glass" aria-label="Selection details"><button class="mobile-panel-close" data-action="close-mobile-panel" aria-label="Close selection panel">Close ×</button>
        <div data-slot="selection-header" class="selection-header"></div>
        <div class="inspector-tabs" role="tablist" aria-label="Inspector sections">
          <button id="atlas-tab-life" role="tab" aria-selected="true" aria-controls="atlas-inspector-content" data-action="tab" data-value="life">Life</button>
          <button id="atlas-tab-intelligence" role="tab" aria-selected="false" aria-controls="atlas-inspector-content" data-action="tab" data-value="intelligence">Intelligence</button>
          <button id="atlas-tab-record" role="tab" aria-selected="false" aria-controls="atlas-inspector-content" data-action="tab" data-value="record">Record</button>
        </div>
        <div id="atlas-inspector-content" data-slot="selection-body" class="selection-body" role="tabpanel" aria-labelledby="atlas-tab-life"></div>
        <div data-slot="selection-actions" class="selection-actions"><button data-action="follow" data-value="" aria-pressed="false" disabled>${icon('focus')}<span></span></button><span></span></div>
      </aside>

      <section class="world-chronicle glass" aria-label="Recent world events">
        <div class="section-heading"><span class="eyebrow"><span class="chronicle-dot"></span> The chronicle</span><button class="text-button" data-action="scope" aria-label="Toggle world or selected faction events">All life</button></div>
        <div data-slot="events" class="chronicle-events" role="log" aria-label="Recent events" aria-live="off"></div>
      </section>

      <footer class="observation-tools">
        <div class="overlay-control glass"><span class="eyebrow">Observe</span><div role="group" aria-label="World overlays">${[['none', 'World'], ['territory', 'Territories'], ['knowledge', 'Reports'], ['routes', 'Journeys'], ['resources', 'Resources']].map(([mode, label]) => `<button data-action="overlay" data-value="${mode}" aria-pressed="${mode === 'none'}" title="${mode === 'knowledge' ? 'Selected faction’s reported knowledge, including stale beliefs' : mode === 'routes' ? 'Travelling groups and their destinations' : mode === 'territory' ? 'Settlement influence, coloured by faction' : 'The world without an overlay'}">${label}</button>`).join('')}</div></div>
        <button class="cinematic-button glass" data-action="cinematic" aria-pressed="false" title="Toggle cinematic camera">${icon('eye')}<span>Cinematic</span></button>
      </footer>

      <section class="field-guide glass" hidden aria-label="Observer field guide">
        <button class="icon-button guide-close" data-action="help" aria-label="Close field guide">${icon('close')}</button>
        <span class="eyebrow">A small field guide</span><h2>Watch a world<br>find its way.</h2>
        <p>The societies begin small. Each population unit is an actual individual. Teams share work decisions, travel to physical sites, extract supplies and carry them home.</p>
        <ol><li><strong>Watch it grow.</strong> Try 16x, or Developed world to actually simulate 1,200 more cycles of the current seed. A cycle is one simulation second at 1x.</li><li><strong>Follow the work.</strong> Select a colony, team or resource site. Watch building projects, extraction and cargo deliveries.</li><li><strong>See what they know.</strong> Choose a civilisation in settings to see its fog of war. Reports age, and scouts must return or transmit what they discover.</li><li><strong>Watch them prepare.</strong> Paid training buildings produce infantry and ranged units. Walls, gates and towers protect routes and resources; supplies and terrain still decide what survives.</li></ol>
        <div class="guide-shortcuts"><span><kbd>Space</kbd> pause</span><span>Drag to orbit</span><span>Scroll to explore</span></div>
        <button class="guide-done" data-action="help">Let the world unfold ${icon('arrow')}</button>
      </section>
      <div class="first-light-note"><span>Start with a little patience. Or a little speed.</span><button data-action="help">How to watch ${icon('arrow')}</button><button class="dismiss-note" data-action="dismiss-note" aria-label="Dismiss introduction">×</button></div>
      <section class="world-outcome glass" data-slot="outcome" hidden aria-label="Domination result" aria-live="polite"></section>
      <nav class="mobile-toolbar glass" aria-label="Mobile observer tools">
        <button data-action="mobile-panel" data-value="factions" aria-pressed="false" aria-controls="atlas-inhabitants">${icon('seed')}<span>Societies</span></button>
        <button data-action="mobile-panel" data-value="inspector" aria-pressed="false" aria-controls="atlas-inspector">${icon('focus')}<span>Inspect</span></button>
        <button data-action="mobile-panel" data-value="views" aria-pressed="false">${icon('eye')}<span>Views</span></button>
        <button data-action="overview" aria-label="Show whole map">${icon('focus')}<span>Map</span></button>
      </nav>
      <p class="mobile-gesture-hint">One finger pans · pinch zooms · two-finger drag orbits</p>
      <div class="ui-toast" role="status" aria-live="polite" hidden></div>
    </div>`;

  const slots = Object.fromEntries([...root.querySelectorAll('[data-slot]')].map(el => [el.dataset.slot, el]));
  const settings = root.querySelector('#atlas-settings');
  const guide = root.querySelector('.field-guide');
  const seedInput = root.querySelector('#atlas-seed');
  const qualityInput = root.querySelector('#atlas-quality');
  const civInput = root.querySelector('#atlas-civs');
  const perspectiveInput = root.querySelector('#atlas-perspective');
  const followButton = slots['selection-actions'].querySelector('button');
  const followLabel = followButton.querySelector('span');
  const selectionNote = slots['selection-actions'].lastElementChild;
  const renderedHTML = new WeakMap();

  // Keep keyboard focus stable as the live inspector refreshes.
  function setHTML(element, html) {
    // DOM serialization normalizes SVG tags and attributes; compare the authored
    // markup so unchanged content does not detach controls on every refresh.
    if (renderedHTML.get(element) === html) return;
    const focused = document.activeElement;
    const restore = element.contains(focused) && focused?.dataset?.action ? { action: focused.dataset.action, value: focused.dataset.value } : null;
    element.innerHTML = html;
    renderedHTML.set(element, html);
    if (restore) [...element.querySelectorAll('button[data-action]')].find(button => button.dataset.action === restore.action && button.dataset.value === restore.value)?.focus({ preventScroll: true });
  }

  function renderSelectionAction(id, label, note) {
    // Party age changes during a click or keyboard interaction. Keep its control
    // mounted even when the footer text or follow state changes.
    followButton.dataset.value = id || '';
    followButton.disabled = !id;
    followButton.setAttribute('aria-pressed', String(!!id && view.followId === id));
    if (followLabel.textContent !== label) followLabel.textContent = label;
    if (selectionNote.textContent !== note) selectionNote.textContent = note;
  }

  function selected() {
    const settlements = list(state?.settlements);
    const groups = list(state?.groups);
    const factions = list(state?.factions);
    const resource = list(state?.nodes).find(item => item.id === view.selectedId);
    const knownPlace = list(state?.knownPlaces).find(item => item.id === view.selectedId);
    const group = groups.find(item => item.id === view.selectedId);
    const settlement = settlements.find(item => item.id === view.selectedId) || (group ? settlements.find(item => item.id === group.originId) : settlements.find(item => item.factionId === view.selectedId && !isRuin(item)) || settlements.find(item => item.factionId === view.selectedId || item.lastFactionId === view.selectedId)) || (!group ? settlements[0] : null);
    const faction = factions.find(item => item.id === (resource ? lastFactionId : knownPlace?.ownerId || (group ? group.controllerId || groupController(state,group) : null) || settlement?.factionId || settlement?.lastFactionId || view.selectedId)) || factions[0];
    if (!resource && faction) lastFactionId = faction.id;
    const nativeSpecies = factions.find(item => item.id === (group?.factionId || settlement?.factionId))?.species || faction?.species;
    return { settlement, group, resource, knownPlace, faction, species: SPECIES[nativeSpecies] || SPECIES.human };
  }

  function onClick(event) {
    const button = event.target.closest('button[data-action]');
    if (!button || !root.contains(button)) return;
    const value = button.dataset.value;
    const current = selected();
    switch (button.dataset.action) {
      case 'pause': actions.togglePause?.(); break;
      case 'keep-watching': actions.continueWatching?.(); break;
      case 'replay': actions.replay?.(); break;
      case 'new-world': actions.newWorld?.(); break;
      case 'mobile-panel': setMobilePanel(mobilePanel === value ? null : value); break;
      case 'close-mobile-panel': setMobilePanel(null); break;
      case 'overview': actions.overview?.(); setMobilePanel(null); break;
      case 'speed': actions.setSpeed?.(Number(value)); break;
      case 'select': actions.select?.(value); break;
      case 'select-resource': (actions.selectResource || actions.select)?.(value); break;
      case 'develop': developWorld(); break;
      case 'diagnostics': settings.hidden = false; guide.hidden = true; setMobilePanel(null); root.querySelector('.settings-toggle').setAttribute('aria-expanded', 'true'); break;
      case 'follow': actions.follow?.(view.followId === value ? null : value); break;
      case 'focus': actions.select?.(value); actions.follow?.(value); break;
      case 'overlay': actions.setOverlay?.(value); break;
      case 'cinematic': actions.setCinematic?.(!view.cinematic); break;
      case 'tab': activeTab = value; renderSelection(current); break;
      case 'open-record': activeTab = 'record'; renderSelection(current); break;
      case 'site-ledger': activeTab = 'record'; renderSelection(current); break;
      case 'scope': eventScope = eventScope === 'world' ? 'faction' : 'world'; renderEvents(current.faction); break;
      case 'settings': settings.hidden = !settings.hidden; if (!settings.hidden) { guide.hidden = true; setMobilePanel(null); } button.setAttribute('aria-expanded', String(!settings.hidden)); break;
      case 'help': guide.hidden = !guide.hidden; if (!guide.hidden) { settings.hidden = true; setMobilePanel(null); } root.querySelector('.settings-toggle').setAttribute('aria-expanded', String(!settings.hidden)); break;
      case 'dismiss-note': dismissedGuide = true; root.querySelector('.first-light-note').hidden = true; break;
    }
  }

  function setMobilePanel(panel) {
    mobilePanel = panel;
    for (const name of ['factions','inspector','views']) root.classList.toggle(`mobile-panel-${name}`, panel === name);
    root.querySelectorAll('[data-action="mobile-panel"]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.value === panel)));
  }

  function notify(message) {
    const toast = root.querySelector('.ui-toast');
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { if (!disposed) toast.hidden = true; }, 5000);
  }

  async function developWorld() {
    if (advanceInProgress || !actions.advance) return;
    const request = ++advanceRequest;
    advanceInProgress = true;
    const button = root.querySelector('[data-action="develop"]');
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.querySelector('span').textContent = 'Simulating...';
    notify('Simulating 1,200 more cycles of this current seed.');
    try {
      const result = await actions.advance(1200);
      if (!disposed && request === advanceRequest) {
        if (result?.completed !== false) notify('1,200 cycles simulated. This is the same world, further into its story.');
        else if (result.reason === 'cancelled') notify(`Fast-forward stopped after ${num(result.cycles)} cycles.`);
      }
    } catch (error) {
      if (!disposed && request === advanceRequest) notify(`Could not finish advancing: ${error?.message || 'please try again'}`);
    } finally {
      if (!disposed && request === advanceRequest) { advanceInProgress = false; updateDiagnostics(); }
    }
  }

  function onSubmit(event) {
    if (!event.target.matches('.seed-form')) return;
    event.preventDefault();
    const seed = seedInput.value.trim() || 'littleworld';
    const config = normalizeConfig({ civCount: civInput.value });
    settingsDirty = false;
    actions.reset?.(seed, config);
    activeTab = 'life';
    requestedDefault = false;
    settings.hidden = true;
    setMobilePanel(null);
    root.querySelector('.settings-toggle').setAttribute('aria-expanded', 'false');
  }

  function onChange(event) {
    if (event.target === qualityInput) actions.setQuality?.(qualityInput.value);
    if (event.target === perspectiveInput) actions.setPerspective?.(perspectiveInput.value);
  }
  function onInput(event) {
    if (event.target === seedInput || event.target === civInput) settingsDirty = true;
    if (event.target === civInput) slots['civ-count'].textContent = normalizeConfig({ civCount: civInput.value }).civCount;
  }
  root.addEventListener('click', onClick);
  root.addEventListener('submit', onSubmit);
  root.addEventListener('change', onChange);
  root.addEventListener('input', onInput);

  function stockMarkup(settlement, species) {
    const stock = settlement?.stock || {};
    const capacity = Math.max(1, n(settlement?.capacity) || 180);
    return `<div class="stock-grid">${['food', 'water', 'energy', 'materials'].map(key => {
      const amount = n(stock[key]);
      const ratio = clamp(amount / capacity * 100);
      const net = settlement?.net?.[key];
      return `<div class="stock-item ${ratio < 15 ? 'stock-scarce' : ''}"><div><span>${esc(species[key])}</span><strong>${num(amount)}<small> / ${num(capacity)}</small></strong></div><div class="stock-track" role="meter" aria-label="${esc(species[key])}" aria-valuenow="${Math.round(amount)}" aria-valuemin="0" aria-valuemax="${capacity}"><i style="width:${ratio}%"></i></div>${Number.isFinite(net) ? `<div class="stock-flow ${net < -.05 ? 'flow-negative' : ''}">${net > 0 ? '+' : ''}${net.toFixed(1)} per cycle</div>` : ''}</div>`;
    }).join('')}</div>`;
  }

  function advantageMarkup(faction) {
    const advantage = faction?.advantages;
    if (!advantage) return '';
    return `<section class="inspector-section advantage-reading"><span class="eyebrow">Seeded advantage</span><h3>${esc(advantage.name || advantage.profile || 'Distinct strengths')}</h3><p>${esc(advantage.description || '')}</p>${advantage.strength ? `<p class="advantage-strength">${esc(advantage.strength)}</p>` : ''}${advantage.tradeoff ? `<small>${esc(advantage.tradeoff)}</small>` : ''}<p class="muted-note">Strengths differ between seeds and belong to a civilisation, not permanently to one species.</p></section>`;
  }

  function techMarkup(faction) {
    const tech = faction?.tech || {};
    const progress = n(tech.progress);
    const required = n(tech.requiredProgress || tech.threshold || tech.required || tech.cost) || 100;
    const ratio = /mature knowledge|all four specialisations/i.test(`${tech.focus || ''} ${tech.status || ''}`) ? 100 : clamp(progress / required * 100);
    const unlocked = list(tech.unlocked).slice(-3);
    return `<section class="inspector-section technology"><div class="section-heading"><span class="eyebrow">Adaptation</span><span class="tech-level">Tier ${num(tech.level)}</span></div><div class="tech-focus">${esc(title(tech.focus || 'Learning to survive'))}<span>${Math.round(ratio)}%</span></div><div class="tech-track"><i style="width:${ratio}%"></i></div><p class="research-status">${esc(tech.status || 'Breakthroughs grow from investment and experience.')}</p>${tech.requirement ? `<p class="muted-note research-requirement"><span>Needs</span> ${esc(tech.requirement)}</p>` : ''}${tech.environment ? `<p class="muted-note">${esc(tech.environment)}</p>` : ''}${unlocked.length ? `<div class="discovery-tags">${unlocked.map(item => `<span>${esc(title(typeof item === 'string' ? item : item.name || item.id))}</span>`).join('')}</div>` : ''}</section>`;
  }

  function workforceMarkup(settlement) {
    if (!settlement || isRuin(settlement)) return '';
    const groups = list(state.groups).filter(group => group.originId === settlement.id);
    const teams = groups.filter(group => group.kind === 'worker');
    const field = teams.reduce((sum, group) => sum + n(group.size), 0);
    const away = groups.reduce((sum, group) => sum + n(group.size), 0);
    const home = settlement.homePresent ?? Math.max(0, n(settlement.population) - away);
    const buildings = list(settlement.buildings);
    const complete = buildings.filter(building => n(building.progress ?? 1) >= 1 && !building.destroyed && (building.hp == null || building.hp > 0));
    const projects = buildings.filter(building => n(building.progress ?? 1) < 1 && !building.destroyed && (building.hp == null || building.hp > 0));
    const assigned = settlement.assigned || {};
    return `<section class="inspector-section colony-scale"><div class="section-heading"><span class="eyebrow">A working colony</span><span class="health-reading">${num(settlement.population)} individuals</span></div><div class="colony-metrics"><div><strong>${num(field)}</strong><span>field workers</span></div><div><strong>${num(teams.length)}</strong><span>work teams</span></div><div><strong>${num(complete.length)}</strong><span>built structures</span></div></div><p class="workforce-accounting">${num(home)} present at home · ${num(away)} away in teams. Deployed individuals remain part of this colony's population.</p><div class="assignment-line"><span>${num(assigned.construction)} building</span><span>${num(assigned.researchers)} researching</span><span>${num(assigned.infrastructure)} in infrastructure</span><span>${num(assigned.training)} training</span></div><div class="housing-reading"><span>Housing</span><strong>${num(settlement.population)} / ${num(settlement.housingCapacity ?? settlement.carryingCapacity ?? settlement.population)}</strong></div>${projects.length ? `<div class="construction-list">${projects.slice(0, 3).map(project => `<div><span>${esc(buildingLabel(project.kind, list(state.factions).find(f => f.id === settlement.factionId)?.species))}<strong>${num(n(project.progress) * 100)}%</strong></span><div class="tech-track"><i style="width:${clamp(n(project.progress) * 100)}%"></i></div></div>`).join('')}${projects.length > 3 ? `<p class="muted-note">${projects.length - 3} further projects under construction.</p>` : ''}</div>` : '<p class="muted-note">No structures currently under construction.</p>'}${teams.length ? `<div class="site-links">${[...new Set(teams.map(team => team.targetId))].filter(Boolean).slice(0, 3).map(id => { const node = list(state.nodes).find(node => node.id === id); return node ? `<button data-action="select-resource" data-value="${esc(id)}">${esc(title(node.subtype || node.kind))} site ${icon('arrow')}</button>` : ''; }).join('')}</div>` : ''}</section>`;
  }

  function militaryMarkup(home, faction) {
    if (!home || isRuin(home) || isCamp(home)) return '';
    const species = list(state.factions).find(f => f.id === home.factionId)?.species || faction?.species || 'human';
    const units = MILITARY_UNITS[species] || MILITARY_UNITS.human;
    const producers = list(home.buildings).filter(b => MILITARY_BUILDINGS[b.kind] && !b.destroyed && (b.hp == null || b.hp > 0));
    const queue = list(home.trainingQueue);
    const armies = list(state.groups).filter(g => g.kind === 'army' && g.originId === home.id);
    const deployed = role => armies.reduce((sum, group) => sum + n(group.units?.[role]), 0);
    const defenses = list(home.buildings).filter(b => ['wall', 'gate', 'tower'].includes(b.kind) && !b.destroyed && n(b.hp) > 0);
    return `<section class="inspector-section military-reading"><div class="section-heading"><span class="eyebrow">Trained forces</span><span class="health-reading">${num(home.soldiers)} serving</span></div><div class="military-roster">${['infantry', 'ranged'].map(role => `<div><strong>${num(home.military?.[role])}</strong><span>${esc(units[role].name)}</span><small>${num(deployed(role))} deployed · ${esc(role)}</small></div>`).join('')}</div><p class="muted-note">Trained forces are part of this colony's population. ${num(home.assigned?.training)} existing citizens are currently in training.</p>${producers.length ? `<div class="producer-list">${producers.map(building => `<div><span>${esc(buildingLabel(building.kind, species))}</span><small>${building.progress < 1 ? `${num(building.progress * 100)}% built` : queue.some(job => job.buildingId === building.id) ? 'Training' : 'Ready'}</small></div>`).join('')}</div>` : '<p class="muted-note">New forces require funded training buildings.</p>'}${queue.length ? `<div class="production-queue">${queue.map(job => `<div class="training-job"><div><span>${num(job.size)} ${esc(units[job.role]?.name || title(job.role))}</span><strong>${num(job.progress * 100)}%</strong></div><div class="tech-track" role="progressbar" aria-label="${esc(units[job.role]?.name || job.role)} training" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${num(job.progress * 100)}"><i style="width:${clamp(job.progress * 100)}%"></i></div><small>${num(job.remaining)} cycles remaining · costs already paid</small></div>`).join('')}</div>` : ''}${defenses.length ? `<div class="fortification-reading"><span class="eyebrow">Built defences</span><p>${num(defenses.filter(b => b.kind === 'wall' && b.progress >= 1).length)} walls · ${num(defenses.filter(b => b.kind === 'gate' && b.progress >= 1).length)} gates · ${num(defenses.filter(b => b.kind === 'tower' && b.operational).length)} active towers</p><small>${num(home.assigned?.towerCrew)} ranged operators · ammunition is paid per shot</small>${defenses.filter(b => b.kind === 'tower').map(b => `<div><span>${esc(buildingLabel(b.kind, species))}</span><small>${b.progress < 1 ? `${num(b.progress * 100)}% built` : b.operational ? `${num(b.hp)} / ${num(b.maxHp)} integrity` : esc(b.inactiveReason || 'Unstaffed')}</small></div>`).join('')}</div>` : ''}</section>`;
  }

  function resourceTeams(resource) { return list(state.groups).filter(group => group.kind === 'worker' && group.targetId === resource.id); }

  function workerJobMarkup(group) {
    if (group?.kind !== 'worker') return '';
    const node = list(state.nodes).find(node => node.id === group.targetId);
    return `<section class="worker-job"><div class="section-heading"><span class="eyebrow">Physical work assignment</span><span class="health-reading">${num(group.size)} individuals</span></div>${node ? `<button class="site-job-link" data-action="select-resource" data-value="${esc(node.id)}">${esc(title(node.subtype || node.kind))} site ${icon('arrow')}</button>` : ''}<div class="assignment-line"><span>${esc(title(group.phase || 'Travelling'))}</span><span>${num(group.extractedTotal)} extracted on this trip</span></div>${Number.isFinite(group.workProgress) ? `<div class="tech-track"><i style="width:${clamp(group.workProgress <= 1 ? group.workProgress * 100 : group.workProgress)}%"></i></div>` : ''}<p class="muted-note">This team's cargo is separate from home stocks until it returns.</p></section>`;
  }

  function resourceMarkup(resource, pane) {
    if (pane === 'record') return ledgerMarkup(resource.kind);
    const teams = resourceTeams(resource);
    const workers = teams.reduce((sum, team) => sum + n(team.size), 0);
    const harvesting = teams.filter(team => team.phase === 'working');
    const amount = Math.max(0, n(resource.amount));
    const maximum = Math.max(amount, n(resource.maxAmount));
    const regen = n(resource.regeneration);
    const cargo = teams.reduce((sum, team) => sum + n(team.carrying?.[resource.kind]), 0);
    const crewList = teams.length ? `<div class="resource-teams">${teams.map(team => { const faction = list(state.factions).find(faction => faction.id === team.factionId); return `<button data-action="select" data-value="${esc(team.id)}" style="--team-color:${color(faction?.color)}"><span class="resource-team-title"><i></i>${esc(faction?.name || 'Work team')} ${icon('arrow')}</span><span>${num(team.size)} individuals · ${esc(title(team.phase || 'Travelling'))}</span><small>${num(team.carrying?.[resource.kind])} in cargo${team.capacity || team.cargoCapacity ? ` / ${num(team.capacity || team.cargoCapacity)} capacity` : ''}</small></button>`; }).join('')}</div>` : '<p class="empty-note">No work team is assigned to this site. Colonies need resources, available workers and a viable route before they send a team.</p>';
    if (pane === 'intelligence') return `<section class="intel-introduction"><span class="eyebrow">Work happens here</span><p>Teams travel, extract within reach, then return with their cargo. A distant colony gains nothing until delivery.</p><div class="intel-numbers"><div><strong>${teams.length}</strong><span>teams assigned</span></div><div><strong>${num(workers)}</strong><span>individuals</span></div><div><strong>${num(cargo)}</strong><span>in cargo</span></div></div></section>${crewList}`;
    return `<section class="resource-introduction"><span class="eyebrow">${amount <= .01 ? 'Depleted site' : harvesting.length ? 'Active extraction' : 'Available deposit'}</span><h3>${amount <= .01 ? regen > 0 ? 'A resource slowly renewing.' : 'The deposit is exhausted.' : `${num(amount)} remaining`}</h3><p>${regen > 0 ? `Renewable supply regenerates at up to ${regen.toFixed(2)} units per cycle, bounded by its capacity.` : 'Finite supply. Extracted material does not reappear when the site is exhausted.'}</p><div class="resource-reserve"><span>${num(amount)} / ${num(maximum)}</span><div class="tech-track"><i style="width:${maximum ? clamp(amount / maximum * 100) : 0}%"></i></div></div></section><section class="inspector-section"><div class="colony-metrics"><div><strong>${num(workers)}</strong><span>assigned workers</span></div><div><strong>${harvesting.length}</strong><span>extracting teams</span></div><div><strong>${num(cargo)}</strong><span>carried away</span></div></div><p class="workforce-accounting">Extraction lowers this site's stock and fills team cargo. Colony storage rises only after the team physically returns.</p></section><section class="inspector-section"><div class="section-heading"><span class="eyebrow">Teams at work</span><span class="health-reading">${esc(title(resource.biome || 'Landscape'))}</span></div>${crewList}</section><section class="inspector-section"><button class="text-button" data-action="site-ledger">Trace the ${esc(resource.kind)} ledger ${icon('arrow')}</button></section>`;
  }

  function ledgerMarkup(kind) {
    const ledger = state.resourceLedger?.[kind];
    if (!ledger) return '<p class="empty-note">World-wide ledger totals are hidden in a civilisation’s perspective. Choose Whole world in settings to inspect global conservation.</p>';
    const rows = [['initial', 'Initial site supply'], ['regenerated', 'Natural regeneration'], ['extracted', 'Removed from sites'], ['delivered', 'Delivered to storage'], ['produced', 'Infrastructure output'], ['consumed', 'Consumed'], ['construction', 'Invested in construction'], ['research', 'Invested in research'], ['training', 'Paid unit training'], ['tradeNet', 'Net trade'], ['lost', 'Lost']];
    return `<section class="ledger-intro"><span class="eyebrow">World ${esc(kind)} ledger</span><p>These are cumulative world totals for this resource. Extraction, cargo and delivery are separate steps.</p></section><dl class="ledger-list">${rows.map(([key, label]) => `<div><dt>${label}</dt><dd>${Number.isFinite(ledger[key]) ? num(ledger[key]) : '—'}</dd></div>`).join('')}</dl><p class="muted-note ledger-note">Initial and regenerated supply feed physical deposits. Extraction removes that supply; delivered cargo enters colony stocks. Infrastructure output is counted separately.</p>`;
  }

  function updateDiagnostics() {
    const diag = view.diagnostics || {};
    const crowds = diag.crowds || diag;
    const factionView = state.viewer?.mode === 'faction';
    const homeIds = new Set(list(state.settlements).map(home => home.id));
    const actual = list(state.settlements).reduce((sum, settlement) => sum + n(settlement.population), 0) + (factionView ? list(state.groups).filter(group => !homeIds.has(group.originId)).reduce((sum, group) => sum + n(group.size), 0) : 0);
    const measurementsCurrent = view.diagnosticsScope == null ? !view.perspective : view.diagnosticsScope === view.perspective;
    const measured = key => measurementsCurrent && Number.isFinite(crowds[key]) ? num(crowds[key]) : 'Measuring';
    const models = measurementsCurrent && Number.isFinite(crowds.drawnModels ?? crowds.instances) ? `${num(crowds.drawnModels ?? crowds.instances)} models` : 'view measuring';
    setHTML(slots['world-scale'], `<strong>${num(actual)}</strong> ${factionView ? 'known & in sight' : 'individuals'} <span>· ${models}</span>`);
    setHTML(slots['render-accounting'], `<span class="eyebrow">Population & the view</span><dl class="render-counts"><div><dt>${factionView ? 'Own census + observed people' : 'Actual population'}</dt><dd>${num(actual)}</dd></div><div><dt>Represented individuals</dt><dd>${measured('representedIndividuals')}</dd></div><div><dt>People visible in this view</dt><dd>${measured('visibleIndividuals')}</dd></div><div><dt>Drawn crowd models</dt><dd>${measured('drawnModels')}</dd></div><div><dt>Workers represented</dt><dd>${measured('visibleWorkerIndividuals')}</dd></div><div><dt>Worker crew models</dt><dd>${measured('drawnWorkerModels')}</dd></div><div><dt>Individual soldiers visible</dt><dd>${measured('visibleMilitaryIndividuals')}</dd></div><div><dt>Hidden by culling</dt><dd>${measured('culledIndividuals')}</dd></div></dl><p>Each resource crew has one worker model and a count badge. Soldiers are drawn individually. Visible people counts include every worker represented by a badge.</p><p>${factionView ? 'This is a scoped view: your civilisation’s census plus foreign people currently in sight. It does not reveal the whole-world population.' : 'Population includes deployed teams. Crew badges and model counts change the view, while workforce and cargo remain fully accounted for.'}</p>${measurementsCurrent && Number.isFinite(crowds.representedIndividuals) && crowds.representedIndividuals !== actual ? '<p class="diagnostic-caution">The renderer currently represents fewer or more individuals than the simulation. These counts are shown separately.</p>' : ''}`);
    const developed = root.querySelector('[data-action="develop"]');
    developed.disabled = !actions.advance || advanceInProgress || !!view.advancing;
    developed.setAttribute('aria-busy', String(advanceInProgress || !!view.advancing));
    if (view.advancing) developed.querySelector('span').textContent = `Simulating ${num(view.advancing.done)} / ${num(view.advancing.total)}`;
    else if (!advanceInProgress) developed.querySelector('span').textContent = 'Developed world';
  }

  function tacticalMarkup(group) {
    const combat = group?.combat;
    if (group?.kind !== 'army' || !combat?.intent || !combat.reason) return '';
    // This inspector is only reached for an owned party or the omniscient view.
    // Visible foreign parties use the observation panel and reveal no orders.
    const local = Number.isFinite(combat.localStrength) && Number.isFinite(combat.enemyStrength);
    return `<section class="tactical-reading"><div class="section-heading"><span class="eyebrow">Local decision</span><strong>${esc(title(combat.intent))}</strong></div><p>${esc(combat.reason)}</p>${local ? `<div class="tactical-balance"><span>Own force <strong>${num(combat.localStrength)}</strong></span><span>Nearby support <strong>${num(combat.supportStrength)}</strong></span><span>Estimated opposition <strong>${num(combat.enemyStrength)}</strong></span></div><small>Strength scores use visible troop types. Our force also accounts for morale, supplies and equipment.</small>` : ''}</section>`;
  }

  function groupMarkup(group, faction) {
    if (!group) return '';
    const origin = list(state.settlements).find(s => s.id === group.originId);
    const target = list(state.settlements).find(s => s.id === group.targetId) || list(state.nodes).find(s => s.id === group.targetId);
    const destination = target?.name || (target?.kind ? `${title(target.kind)} deposit` : group.phase === 'returning' || group.phase === 'retreating' ? origin?.name || 'Home' : 'Uncharted ground');
    const cargo = Object.entries(group.carrying || {}).filter(([, amount]) => n(amount) > 0).map(([kind, amount]) => `${num(amount)} ${kind}`).join(', ');
    return `<section class="party-detail"><div class="party-phase"><span class="phase-dot"></span>${esc(title(group.phase || 'Travelling'))}<span>${num(group.size)} ${group.kind === 'army' ? 'soldiers' : 'travellers'}</span></div><p class="party-reason">${esc(group.reason || faction?.intent || 'Exploring the world beyond home.')}</p><div class="party-destination"><span class="eyebrow">Destination</span><strong>${esc(destination)}</strong></div><div class="party-gauges">${[['supply', 'Supplies'], ['morale', 'Morale']].map(([key, label]) => `<div><span>${label}<strong>${num(group[key])}%</strong></span><div class="stock-track ${n(group[key]) < 25 ? 'danger-track' : ''}"><i style="width:${clamp(group[key])}%"></i></div></div>`).join('')}</div><p class="muted-note">${group.kind === 'scout' ? `${list(group.observations).length} field observations. Knowledge reaches home only after a report arrives.` : 'Distance, terrain and provisions shape whether a party presses on or turns back.'}</p>${(group.capacity || group.cargoCapacity) ? `<p class="cargo-reading"><span class="eyebrow">Cargo</span> ${esc(cargo || 'Empty')} <small>· ${num(group.capacity || group.cargoCapacity)} capacity</small></p>` : ''}${group.commandFactionId && group.commandFactionId !== group.factionId ? `<p class="auxiliary-reading">Native ${esc(list(state.factions).find(f => f.id === group.factionId)?.species || 'local')} auxiliaries commanded by ${esc(list(state.factions).find(f => f.id === groupController(state,group))?.name || 'their controller')}. Existing people retain their native identity.</p>` : ''}${group.kind === 'army' ? `<p class="military-composition">${num(group.units?.infantry)} infantry · ${num(group.units?.ranged)} ranged${group.combat?.targetId ? ' · engaged' : ''}</p>` : ''}${tacticalMarkup(group)}${group.intelligence ? `<p class="mission-intelligence">Mobilised from a report delivered on cycle ${num(group.intelligence.reportedTick)}: ${num(clamp(n(group.intelligence.confidence) * 100))}% confidence, observed ${num(Math.max(0, n(state.tick) - n(group.intelligence.observedTick)))} cycles ago.</p>` : ''}</section>`;
  }

  function lifeMarkup({ settlement, group, faction, species }) {
    if (!faction) return '<p class="empty-note">A world is taking shape.</p>';
    if (isRuin(settlement) && !group) return ruinMarkup({ settlement, faction, species });
    if (settlement?.knowledgeControl === 'occupied') {
      const controller = (view.perspectiveOptions || state.factions).find(f => f.id === settlement.controllerId || f.id === settlement.occupiedBy);
      return `${groupMarkup(group,faction)}${settlement.exileBaseFor ? `<section class="occupation-reading"><span class="knowledge-badge">Exile command base</span><p>This held producer can train paid native auxiliaries for its controller while it has no native base. Local people retain their species and population count.</p></section>${militaryMarkup(settlement, faction)}` : ''}<section class="occupation-reading"><span class="knowledge-badge">Controlled local settlement</span><p>${esc(controller?.name || 'The occupier')} controls this place. The native population remains here; distant native troops and private history are not revealed.</p><div class="colony-metrics"><div><strong>${num(settlement.homePresent ?? settlement.population)}</strong><span>present inhabitants</span></div><div><strong>${num(list(settlement.buildings).filter(b => b.progress >= 1 && !b.destroyed).length)}</strong><span>observed buildings</span></div></div></section><section class="inspector-section"><span class="eyebrow">Stores held at this location</span>${stockMarkup(settlement,species)}<p class="muted-note">Captured stores remain physically here. They are not remotely credited to another colony.</p></section>`;
    }

    const population = n(settlement?.population);
    const workers = n(settlement?.workers);
    const soldiers = n(settlement?.soldiers);
    const parties = list(state.groups).filter(g => g.factionId === faction.id);
    const activeSoldiers = parties.filter(g => g.kind === 'army' && g.originId === settlement?.id).reduce((sum, g) => sum + n(g.size), 0);
    const recoveryIntent = list(settlement?.economyReasons).find(reason => /repair|rebuild|recover|displaced/i.test(reason));
    return `${settlement?.occupiedBy ? `<section class="occupation-reading"><span class="knowledge-badge">Occupied settlement</span><p>Controlled by ${esc((view.perspectiveOptions || state.factions).find(f => f.id === (settlement.controllerId || settlementController(state,settlement)))?.name || 'another civilisation')}. Native inhabitants and stores remain here; independent military production has stopped.</p></section>` : ''}${groupMarkup(group, faction)}${isCamp(settlement) ? lifecycleMarkup(settlement, faction) : ''}<section class="intent-card"><span class="eyebrow">${isCamp(settlement) ? 'Recovery intention' : 'What moves them'}</span><p>${esc(isCamp(settlement) ? recoveryIntent || 'Survivors need reserves and repairs before this camp can become a settlement again.' : faction.intent || 'Establish a foothold and learn what lies beyond it.')}</p></section>
      <section class="inspector-section"><div class="population-summary"><div><span class="eyebrow">${group ? 'Home population' : isCamp(settlement) ? 'Survivors' : 'Population'}</span><strong>${num(population)}<small>${faction.species === 'machine' ? 'units' : faction.species === 'hive' ? 'individuals' : 'people'}</small></strong></div><span class="settlement-level">${esc(isCamp(settlement) ? 'Displaced camp' : settlement?.level > 2 ? 'Town' : settlement?.level > 1 ? 'Outpost' : 'Founding camp')}<small>Level ${num(settlement?.level || 1)}</small></span></div><div class="role-bar" aria-label="${num(workers)} worker individuals and ${num(soldiers)} soldier individuals"><i style="width:${population ? clamp(workers / population * 100) : 0}%"></i></div><div class="role-legend"><span><i></i>${num(workers)} workers</span><span><i></i>${num(soldiers)} soldiers</span></div><p class="muted-note">${activeSoldiers ? `${num(activeSoldiers)} soldiers are deployed. ` : ''}Every soldier is a pair of hands away from production.</p>${settlement?.carryingCapacity ? `<p class="population-capacity">Habitat supports ${num(settlement.carryingCapacity)} · ${num(settlement.availableWorkers ?? workers)} working locally${settlement.assigned?.researchers ? ` · ${num(settlement.assigned.researchers)} researching` : ''}</p>` : ''}</section>
      <section class="inspector-section"><div class="section-heading"><span class="eyebrow">Stores & carrying limits</span><span class="health-reading">${num(settlement?.health ?? 100)}% health</span></div>${stockMarkup(settlement, species)}${settlement?.economyReasons?.[2] ? `<p class="economy-reason">${esc(settlement.economyReasons[2])}</p>` : ''}</section>
      ${advantageMarkup(faction)}${techMarkup(faction)}
      <section class="inspector-section personality-section"><span class="eyebrow">Character</span><p>${esc(faction.personality || 'A society finding its character through circumstance.')}</p>${traitsMarkup(faction.traits)}<div class="active-parties"><span>${parties.length} ${parties.length === 1 ? 'party' : 'parties'} afield</span>${parties.slice(0, 3).map(g => `<button data-action="select" data-value="${esc(g.id)}" title="Inspect ${esc(g.kind)}">${esc(title(g.kind))} ${icon('arrow')}</button>`).join('')}</div></section>`;
  }

  function lifecycleMarkup(settlement, faction) {
    const ruin = isRuin(settlement);
    return `<section class="lifecycle-card ${ruin ? 'is-ruin' : 'is-camp'}"><div class="section-heading"><span class="eyebrow">${ruin ? 'Abandoned settlement' : 'Displaced survivors'}</span>${settlement.ruinedTick != null ? `<span class="lifecycle-date">Cycle ${num(settlement.ruinedTick)}</span>` : ''}</div><h3>${ruin ? 'The settlement fell silent.' : 'A home lost. A future uncertain.'}</h3><p>${esc(settlement.ruinReason || (ruin ? 'No inhabitants remain at this site.' : 'The settlement was destroyed; surviving individuals remain in a camp.'))}</p>${!ruin ? '<p class="lifecycle-caption">Survivors remain. Adequate reserves and repairs can restore this settlement.</p>' : ''}${faction?.status === 'collapsed' ? `<div class="faction-fate">${esc(faction.name)} has collapsed${faction.collapsedTick != null ? ` · cycle ${num(faction.collapsedTick)}` : ''}. No inhabited homes remain.</div>` : faction?.status === 'displaced' ? '<div class="faction-fate">This society has lost its towns. Its survivors endure in displaced camps.</div>' : ''}</section>`;
  }

  function ruinMarkup({ settlement, faction, species }) {
    const survivingHomes = list(state.settlements).filter(home => home.factionId === faction.id && !isRuin(home));
    const remainingStock = Object.values(settlement.stock || {}).some(amount => n(amount) > 0);
    return `${lifecycleMarkup(settlement, faction)}<section class="inspector-section ruin-summary"><div class="population-summary"><div><span class="eyebrow">Remaining inhabitants</span><strong>0<small>${faction.species === 'machine' ? 'units' : faction.species === 'hive' ? 'individuals' : 'people'}</small></strong></div><span class="settlement-level">Ruins<small>Former level ${num(settlement.level || 1)}</small></span></div><p class="muted-note">Production and growth have stopped here. Its history remains in the record.</p><button class="ruin-record-link" data-action="open-record">Read the final chapters ${icon('arrow')}</button></section>${remainingStock ? `<section class="inspector-section"><span class="eyebrow">Stores left behind</span>${stockMarkup({ ...settlement, net: null }, species)}</section>` : ''}${survivingHomes.length ? `<section class="inspector-section"><span class="eyebrow">Their story continues</span><p class="muted-note">${esc(faction.name)} still has ${survivingHomes.length} inhabited ${survivingHomes.length === 1 ? 'site' : 'sites'}.</p><div class="active-parties">${survivingHomes.slice(0, 3).map(home => `<button data-action="select" data-value="${esc(home.id)}">${esc(home.name)} ${icon('arrow')}</button>`).join('')}</div></section>` : ''}`;
  }

  function traitsMarkup(traits = {}) {
    return `<div class="trait-list">${[['curiosity', 'Curious'], ['industry', 'Industrious'], ['cooperation', 'Cooperative'], ['aggression', 'Forceful']].filter(([key]) => n(traits[key]) >= 0.55).slice(0, 3).map(([, label]) => `<span>${label}</span>`).join('')}</div>`;
  }

  function intelligenceMarkup({ faction }) {
    if (!faction) return '';
    const knowledge = Object.values(faction.knowledge || {}).filter(item => item && item.reportedTick != null && n(item.reportedTick) <= n(state.tick)).sort((a, b) => n(b.reportedTick) - n(a.reportedTick));
    const contacts = knowledge.filter(item => item.kind === 'settlement' && item.ownerId !== faction.id);
    const scouting = list(state.groups).filter(g => g.factionId === faction.id && g.kind === 'scout');
    const relations = Object.entries(faction.relations || {}).filter(([, r]) => r && r.status && r.status !== 'unknown');
    return `<section class="intel-introduction"><span class="eyebrow">${faction.status === 'collapsed' ? 'Archived intelligence' : 'The world as they know it'}</span><p>${faction.status === 'collapsed' ? 'The last reports this society held before its collapse. Their beliefs remain a record of what they knew.' : 'Reports arrive with a delay. A remembered settlement may have changed since it was last seen.'}</p><div class="intel-numbers"><div><strong>${knowledge.length}</strong><span>reports</span></div><div><strong>${contacts.length}</strong><span>contacts</span></div><div><strong>${scouting.length}</strong><span>scouts afield</span></div></div></section>
      <section class="inspector-section"><div class="section-heading"><span class="eyebrow">Latest intelligence</span><button class="text-button" data-action="overlay" data-value="knowledge">Show map ${icon('arrow')}</button></div>${knowledge.length ? `<div class="report-list">${knowledge.slice(0, 8).map(report => {
        const age = Math.max(0, n(state.tick) - n(report.observedTick));
        const delay = Math.max(0, n(report.reportedTick) - n(report.observedTick));
        const knownOwner = list(state.factions).find(f => f.id === report.ownerId);
        const knownName = report.name || (report.kind === 'settlement' ? knownOwner ? `${knownOwner.name} settlement` : 'Distant settlement' : `${title(report.resourceKind || report.resource || report.type || 'Resource')} site`);
        const confidence = clamp(n(report.confidence) * 100);
        return `<article class="report-item ${age > 80 ? 'report-old' : ''}"><div><strong>${esc(knownName)}</strong><span>${age ? `${num(age)} cycles old` : 'Fresh'}</span></div><p>${report.kind === 'settlement' ? `Estimated population ${num(report.populationEstimate)} · ` : ''}${num(confidence)}% confidence</p><span class="report-delay">Arrived cycle ${num(report.reportedTick)} · ${num(delay)} cycle reporting delay</span></article>`;
      }).join('')}</div>` : '<div class="empty-note"><span class="empty-symbol">⌁</span>The horizon is still a mystery.<small>Scouts must return or transmit before their discoveries become shared knowledge.</small></div>'}</section>
      <section class="inspector-section"><span class="eyebrow">${faction.status === 'collapsed' ? 'Last known ties' : 'Diplomatic ties'}</span>${relations.length ? `<div class="relation-list">${relations.map(([id, relation]) => { const other = list(state.factions).find(f => f.id === id); return `<div><span><i style="background:${color(other?.color)}"></i>${esc(other?.name || 'Unidentified society')}</span><strong class="relation-${esc(relation.status)}">${esc(title(relation.status))}</strong></div>`; }).join('')}</div>` : `<p class="muted-note">${faction.status === 'collapsed' ? 'No diplomatic ties were recorded.' : 'No established relations. First contact begins with a delivered report.'}</p>`}</section>`;
  }

  function recordMarkup({ faction }) {
    if (!faction) return '';
    const history = list(faction.history).map(item => typeof item === 'string' ? { text: item } : item).filter(Boolean);
    const events = (history.length ? history : list(state.events).filter(event => event.factionId === faction.id)).slice(-20).reverse();
    return `<div class="record-intro"><span class="eyebrow">${faction.status === 'collapsed' ? 'The record of a fallen society' : 'A society in the making'}</span><p>${faction.status === 'collapsed' ? 'Their settlements fell silent. Their story remains.' : 'Small decisions leave a long history.'}</p></div>${events.length ? `<ol class="history-list">${events.map(event => `<li><span class="history-cycle">${event.tick == null ? '—' : `Cycle ${num(event.tick)}`}</span><p>${esc(event.text || event.message || event.description || title(event.type))}</p></li>`).join('')}</ol>` : `<p class="empty-note">${faction.status === 'collapsed' ? 'No earlier events remain in this chronicle.' : 'The first chapter is still being written.'}</p>`}`;
  }

  function renderSelection(current) {
    const { settlement, group, resource, knownPlace, faction, species } = current;
    const selectedActor = group || settlement;
    const foreign = state.viewer?.mode === 'faction' && !resource && (![selectedActor?.controllerId || (group ? groupController(state,group) : settlement ? settlementController(state,settlement) : null), selectedActor?.nativeFactionId || selectedActor?.factionId].includes(state.viewer.factionId) || (group?.knowledgeView === 'visible' && !group.originId));
    if (knownPlace || foreign || (group && !group.originId)) {
      const object = knownPlace || group || settlement;
      const remembered = !!knownPlace;
      const ownerId = object?.controllerId || (group ? groupController(state,group) : null) || object?.ownerId || object?.factionId;
      const owner = state.factions.find(f => f.id === ownerId);
      const observedTick = object?.observedTick ?? state.tick;
      const age = Math.max(0, state.tick - observedTick);
      const kind = group ? 'group' : object?.renderKind || object?.kind || 'settlement';
      const label = object?.name || (kind === 'resource' ? `${title(object.resourceKind)} site` : kind === 'terrain' ? 'Surveyed pass' : kind === 'group' ? `${title(object.groupKind || group?.kind)} party` : 'Observed settlement');
      const inspector = root.querySelector('.inspector'); inspector.classList.remove('inspector-ruin', 'inspector-camp'); inspector.style.setProperty('--selection-color', color(owner?.color));
      setHTML(slots['selection-header'], `<div class="selection-kicker"><span class="eyebrow">${remembered ? 'Remembered location' : 'Observed contact'}</span><span class="species-mark">◌</span></div><h2>${esc(label)}</h2><div class="selection-affiliation"><i></i><span>${esc(owner?.name || 'Surveyed landscape')}</span><small>${remembered ? 'Out of sight' : 'In sight'}</small></div>`);
      for (const [tab, label] of [['life', 'Observation'], ['intelligence', 'Memory'], ['record', 'Limits']]) { const button = root.querySelector(`#atlas-tab-${tab}`); button.textContent = label; button.setAttribute('aria-selected', String(activeTab === tab)); button.tabIndex = activeTab === tab ? 0 : -1; }
      slots['selection-body'].setAttribute('aria-labelledby', `atlas-tab-${activeTab}`);
      const estimates = [['Population estimate', object?.populationEstimate], ['Defender estimate', object?.soldiersEstimate], ['Observed group', object?.sizeEstimate ?? group?.size], ['Resource estimate', object?.amountEstimate ?? object?.abundanceEstimate]].filter(([,value]) => Number.isFinite(value));
      setHTML(slots['selection-body'], `<section class="known-place-reading"><span class="knowledge-badge">${remembered ? 'Last known position' : 'Local line of sight'}</span><p>${remembered ? 'This dashed marker records an earlier observation. Hidden changes are not shown.' : 'Only observable details are available. Foreign stores, orders and training queues remain unknown.'}</p><p>Observed on cycle ${num(observedTick)} · ${num(age)} cycles ago.</p>${estimates.length ? `<dl class="ledger-list">${estimates.map(([label,value]) => `<div><dt>${esc(label)}</dt><dd>~${num(value)}</dd></div>`).join('')}</dl>` : ''}<p>${activeTab === 'intelligence' ? 'A scout must return or deliver an earned signal for field discoveries to reach its civilisation’s command knowledge.' : activeTab === 'record' ? 'The whole-world perspective is an observer tool. Switching views does not reveal information to the simulated factions.' : 'Revisit this location to learn what has changed.'}</p></section>`);
      renderSelectionAction(object?.id, remembered ? 'View last location' : 'Follow contact', remembered ? 'Memory, not live state' : 'Visible observation');
      return;
    }
    root.querySelector('#atlas-tab-life').textContent = resource ? 'Site' : 'Life';
    root.querySelector('#atlas-tab-intelligence').textContent = resource ? 'Teams' : 'Intelligence';
    root.querySelector('#atlas-tab-record').textContent = resource ? 'Ledger' : 'Record';
    if (resource) {
      const inspector = root.querySelector('.inspector');
      inspector.classList.remove('inspector-ruin', 'inspector-camp');
      inspector.style.setProperty('--selection-color', '#b2ceb2');
      setHTML(slots['selection-header'], `<div class="selection-kicker"><span class="eyebrow">Resource site in focus</span><span class="species-mark">${esc(resource.id)}</span></div><h2>${esc(title(resource.subtype || resource.kind))} site</h2><div class="selection-affiliation"><i></i><span>${esc(title(resource.kind))} · ${esc(title(resource.biome || 'Landscape'))}</span><small>${n(resource.regeneration) > 0 ? 'Renewable' : 'Finite'}</small></div>`);
      root.querySelectorAll('[data-action="tab"]').forEach(button => { button.setAttribute('aria-selected', String(button.dataset.value === activeTab)); button.tabIndex = button.dataset.value === activeTab ? 0 : -1; });
      slots['selection-body'].setAttribute('aria-labelledby', `atlas-tab-${activeTab}`);
      setHTML(slots['selection-body'], resourceMarkup(resource, activeTab));
      renderSelectionAction(resource.id, view.followId === resource.id ? 'Following site' : 'View worksite', 'Physical extraction');
      return;
    }
    const selectionId = group?.id || settlement?.id;
    const inspector = root.querySelector('.inspector');
    inspector.style.setProperty('--selection-color', color(faction?.color));
    inspector.classList.toggle('inspector-ruin', !group && isRuin(settlement));
    inspector.classList.toggle('inspector-camp', !group && isCamp(settlement));
    setHTML(slots['selection-header'], `<div class="selection-kicker"><span class="eyebrow">${group ? `${esc(title(group.kind))} party` : isRuin(settlement) ? 'Ruins in focus' : isCamp(settlement) ? 'Displaced camp in focus' : 'Settlement in focus'}</span><span class="species-mark">${species.mark}</span></div><h2>${esc(group ? `${title(group.kind)} · ${String(group.id).replace(/\D/g, '') || 'I'}` : settlement?.name || 'An unfolding world')}</h2><div class="selection-affiliation"><i></i><span>${esc(faction?.name || 'First inhabitants')}</span><small>${faction?.status === 'collapsed' ? 'Collapsed' : faction?.status === 'displaced' ? 'Displaced' : esc(species.short)}</small></div>`);
    root.querySelectorAll('[data-action="tab"]').forEach(button => { button.setAttribute('aria-selected', String(button.dataset.value === activeTab)); button.tabIndex = button.dataset.value === activeTab ? 0 : -1; });
    slots['selection-body'].setAttribute('aria-labelledby', `atlas-tab-${activeTab}`);
    const life = activeTab === 'life' ? lifeMarkup(current) : '';
    const lifeWithColony = group ? workerJobMarkup(group) + life : !isRuin(settlement) ? life.replace('<section class="inspector-section"><div class="population-summary">', `${workforceMarkup(settlement)}${militaryMarkup(settlement, faction)}<section class="inspector-section"><div class="population-summary">`) : life;
    setHTML(slots['selection-body'], activeTab === 'intelligence' ? intelligenceMarkup(current) : activeTab === 'record' ? recordMarkup(current) : lifeWithColony);
    const followed = !!selectionId && view.followId === selectionId;
    renderSelectionAction(selectionId, followed ? 'Following' : group ? 'Follow party' : isRuin(settlement) ? 'View ruins' : isCamp(settlement) ? 'Follow survivors' : 'Follow settlement', group ? `Cycle ${num(Math.max(0, n(state.tick) - n(group.createdTick)))} afield` : isRuin(settlement) ? 'A place in history' : 'Click the world to explore');
  }

  function renderEvents(faction) {
    const events = list(state.events).filter(event => eventScope === 'world' || event.factionId === faction?.id).slice(-3).reverse();
    root.querySelector('[data-action="scope"]').textContent = eventScope === 'world' ? 'All life' : 'Selected';
    setHTML(slots.events, events.length ? events.map(event => { const owner = list(state.factions).find(f => f.id === event.factionId); return `<article class="chronicle-event"><span class="event-cycle">${num(event.tick).padStart(3, '0')}</span><i style="background:${color(owner?.color)}"></i><p>${esc(event.text || event.message || title(event.type))}</p></article>`; }).join('') : '<p class="chronicle-empty">The first fires are lit. A new history begins.</p>');
  }

  function update(nextState, nextView = {}) {
    if (disposed || !nextState) return;
    const generation = nextView.worldGeneration ?? null;
    const newWorld = generation != null && generation !== worldGeneration;
    if (state && advanceInProgress && (generation != null ? generation !== worldGeneration : !nextState.viewer && state !== nextState)) {
      advanceRequest++;
      advanceInProgress = false;
      clearTimeout(toastTimer);
      root.querySelector('.ui-toast').hidden = true;
    }
    state = nextState;
    view = nextView;
    worldGeneration = generation;
    if (newWorld) { setMobilePanel(null); settings.hidden = true; guide.hidden = true; root.querySelector('.settings-toggle').setAttribute('aria-expanded','false'); }
    if (!view.selectedId && !requestedDefault && state.settlements?.length) { requestedDefault = true; actions.select?.(state.settlements.find(s => s.id === 's0')?.id || state.settlements[0].id); }
    const selectedParty = list(state.groups).find(group => group.id === view.selectedId);
    if (selectedParty) lastPartyOrigin = { id: selectedParty.id, originId: selectedParty.originId };
    else if (lastPartyOrigin?.id === view.selectedId) { actions.select?.(lastPartyOrigin.originId); lastPartyOrigin = null; }
    const current = selected();
    if (previousSelection !== view.selectedId) { slots['selection-body'].scrollTop = 0; previousSelection = view.selectedId; }
    slots.cycle.textContent = num(state.tick).padStart(3, '0');
    const elapsed = n(state.time ?? state.tick); slots.era.textContent = `${Math.floor(elapsed / 60)}m ${Math.floor(elapsed % 60)}s elapsed`;
    slots['pause-label'].textContent = view.advancing ? 'Stop' : view.paused || view.speed === 0 ? 'Resume' : 'Pause';
    const pause = root.querySelector('[data-action="pause"]');
    pause.querySelector('svg').outerHTML = icon(!view.advancing && (view.paused || view.speed === 0) ? 'play' : 'pause');
    pause.setAttribute('aria-label', view.advancing ? 'Stop advancing simulation' : view.paused || view.speed === 0 ? 'Resume simulation' : 'Pause simulation');
    pause.classList.toggle('is-paused', !!view.paused || view.speed === 0);
    root.querySelectorAll('[data-action="speed"]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.value) === view.speed)));
    root.querySelectorAll('[data-action="overlay"]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.value === (view.overlay || 'none'))));
    root.querySelector('[data-action="cinematic"]').setAttribute('aria-pressed', String(!!view.cinematic));
    slots['faction-count'].textContent = String(list(state.factions).length).padStart(2, '0');
    setHTML(slots.factions, list(state.factions).map(faction => {
      const settlements = list(state.settlements).filter(s => s.factionId === faction.id || (!s.factionId && s.lastFactionId === faction.id));
      const inhabited = settlements.filter(s => !isRuin(s));
      const target = inhabited.find(s => !isCamp(s)) || inhabited[0] || settlements[0];
      if (state.viewer?.mode === 'faction' && faction.id !== state.viewer.factionId && !settlements.some(home => home.controllerId === state.viewer.factionId)) {
        const remembered = list(state.knownPlaces).find(k => k.kind === 'settlement' && k.ownerId === faction.id);
        const contact = target || remembered;
        const spec = SPECIES[faction.species] || SPECIES.human;
        return `<button class="faction-entry faction-reported ${current.faction?.id === faction.id ? 'is-selected' : ''}" data-action="select" data-value="${esc(contact?.id || '')}" ${contact ? '' : 'disabled'} aria-label="Inspect known ${esc(faction.name)} observation" aria-pressed="${current.faction?.id === faction.id}" style="--faction-color:${color(faction.color)}"><span class="faction-sigil species-${esc(faction.species)}">${spec.mark}</span><span class="faction-entry-label"><strong>${esc(faction.name)}</strong><small>${target ? 'Currently in sight' : 'Remembered contact'}</small></span><span class="faction-chevron">›</span></button>`;
      }

      const population = settlements.reduce((sum, s) => sum + n(s.population), 0);
      const spec = SPECIES[faction.species] || SPECIES.human;
      const fate = faction.defeatedBy ? 'defeated' : faction.status === 'collapsed' || (!inhabited.length && settlements.length) ? 'collapsed' : faction.status === 'displaced' ? 'displaced' : 'active';
      return `<button class="faction-entry ${current.faction?.id === faction.id ? 'is-selected' : ''} ${fate === 'collapsed' ? 'faction-collapsed' : fate === 'displaced' ? 'faction-displaced' : ''}" data-action="select" data-value="${esc(target?.id || faction.id)}" aria-label="Inspect ${esc(faction.name)}, ${spec.short}, ${fate === 'active' ? `population ${num(population)}` : fate}" aria-pressed="${current.faction?.id === faction.id}" style="--faction-color:${color(faction.color)}"><span class="faction-sigil species-${esc(faction.species)}">${spec.mark}</span><span class="faction-entry-label"><strong>${esc(faction.name)}</strong><small>${fate === 'defeated' ? `Capitulated · ${num(population)} survivors` : fate === 'collapsed' ? 'Collapsed · record remains' : fate === 'displaced' ? `Displaced · ${num(population)} survivors` : `${spec.short} · ${num(population)} ${faction.species === 'machine' ? 'units' : faction.species === 'hive' ? 'individuals' : 'people'}`}</small></span><span class="faction-chevron">›</span></button>`;
    }).join(''));
    renderSelection(current);
    renderEvents(current.faction);
    updateDiagnostics();
    const identity = `${state.seed}:${state.config?.civCount ?? state.factions.length}`;
    if (worldIdentity !== identity || newWorld) { worldIdentity = identity; settingsDirty = false; }
    if (!settingsDirty) {
      seedInput.value = String(state.seed || 'littleworld');
      civInput.value = String(normalizeConfig(state.config || { civCount: state.factions.length }).civCount);
      slots['civ-count'].textContent = civInput.value;
    }
    const perspectiveOptions = view.perspectiveOptions || state.factions;
    const options = `<option value="omniscient">Whole world</option>` + perspectiveOptions.map(f => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('');
    if (perspectiveInput.innerHTML !== options) perspectiveInput.innerHTML = options;
    perspectiveInput.value = view.perspective || 'omniscient';
    slots['perspective-note'].textContent = state.viewer?.mode === 'faction' ? 'Bright ground is visible now. Muted ground is explored memory. Hidden opponents and supplies are not revealed.' : 'The whole-world view is for you. Each society still acts from its own limited knowledge.';
    if (document.activeElement !== qualityInput) qualityInput.value = view.quality || 'high';
    slots.performance.textContent = n(view.fps) > 0 ? `${Math.round(n(view.fps))} fps · ${num(list(state.groups).length)} travelling parties` : `${num(list(state.groups).length)} travelling parties`;
    root.querySelector('.first-light-note').hidden = dismissedGuide || n(state.tick) > 20;
    const outcome = view.outcome || state.outcome;
    const result = slots.outcome;
    result.hidden = outcome?.status !== 'victory' || !!view.outcomeDismissed || !!view.advancing;
    if (!result.hidden) {
      const winner = (view.perspectiveOptions || state.factions).find(f => f.id === outcome.winnerId);
      const cycles = n(outcome.wonAt ?? outcome.tick), seconds = Math.round(cycles / 2);
      setHTML(result, `<span class="eyebrow">Domination achieved</span><h2>${esc(winner?.name || 'One civilisation')} prevails.</h2><p>The other societies have lost their sovereignty. Surviving inhabitants stay in their occupied settlements.</p><div class="outcome-metrics"><span>Cycle <strong>${num(cycles)}</strong></span><span>At 2x <strong>${Math.floor(seconds / 60)}m ${seconds % 60}s</strong></span>${view.victorySummary ? `<span>Captures <strong>${num(view.victorySummary.captures)}</strong></span>` : ''}</div><p class="muted-note">Seed: ${esc(state.seed)} · ${state.config?.civCount || (view.perspectiveOptions || state.factions).length} starting civilisations. Timing is simulation playback, not a device performance guarantee.</p><div class="outcome-actions"><button data-action="keep-watching">Keep watching</button><button data-action="replay">Replay seed</button><button data-action="new-world">New world</button></div>`);
    }
    root.classList.toggle('cinematic-active', !!view.cinematic);
    root.classList.toggle('has-navigation', !!view.userNavigated);
  }

  function onKeyDown(event) {
    const tab = event.target.closest('[role="tab"]');
    if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const tabs = [...root.querySelectorAll('[role="tab"]')];
      let index = tabs.indexOf(tab);
      index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      activeTab = tabs[index].dataset.value;
      if (state) renderSelection(selected());
      tabs[index].focus();
    }
    if (event.key === 'Escape') { setMobilePanel(null); settings.hidden = true; guide.hidden = true; root.querySelector('.settings-toggle').setAttribute('aria-expanded', 'false'); }
  }
  root.addEventListener('keydown', onKeyDown);

  return { update, revealSelection() { setMobilePanel('inspector'); }, dispose() { disposed = true; advanceRequest++; clearTimeout(toastTimer); root.removeEventListener('click', onClick); root.removeEventListener('submit', onSubmit); root.removeEventListener('change', onChange); root.removeEventListener('input', onInput); root.removeEventListener('keydown', onKeyDown); root.innerHTML = ''; } };
}
