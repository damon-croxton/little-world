import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createBattle, stepBattle, getBattleView, issueBattleOrder, battleSummary } from './sim.js';
import { createBattleRenderer } from './render.js';

const $ = id => document.getElementById(id);
const root = $('battle-canvas');
const params = new URLSearchParams(location.search);
const DT = .1, MAX_STEPS_PER_FRAME = 12;
const allowedSizes = [24, 48, 96];
const requestedSize = Number(params.get('perSide') || params.get('size') || 24);
let state = createBattle(params.get('seed') || 'crossing', { perSide: allowedSizes.includes(requestedSize) ? requestedSize : 24 });
const view = { paused: params.get('autostart') !== '1', speed: 1, perspective: 'all', selectedId: null, fps: 0, frameMs: 0, droppedSeconds: 0 };
let shownState = getBattleView(state, view.perspective), accumulator = 0, lastFrame = performance.now(), lastUI = 0, frameCount = 0, fpsAt = performance.now();
let cameraGoal = null, overviewLocked = true, selectionSignature = '', announcedOutcome = false, lastEventSignature = '';
const scene = new THREE.Scene();
scene.background = new THREE.Color('#dce6d4');
scene.fog = new THREE.Fog('#dce6d4', 100, 175);
const camera = new THREE.OrthographicCamera(-40, 40, 30, -30, .1, 300);
camera.position.set(7, 63, 52); camera.lookAt(0, 0, 0);
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
} catch (error) {
  $('battle-loading').textContent = 'The battlefield needs WebGL. Enable hardware acceleration and reload to try again.';
  throw error;
}
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.65));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.13;
renderer.domElement.tabIndex = 0;
renderer.domElement.setAttribute('role', 'img');
renderer.domElement.setAttribute('aria-label', 'Miniature battlefield. Click a soldier to inspect it. Drag to orbit and scroll to zoom. Use left and right arrow keys to select a soldier, Enter to locate it, Space to pause, and Home for the whole field.');
renderer.domElement.style.touchAction = 'none';
renderer.domElement.addEventListener('contextmenu', e => e.preventDefault());
root.prepend(renderer.domElement);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, .4, 0); controls.enableDamping = true; controls.dampingFactor = .09;
controls.minZoom = .65; controls.maxZoom = 4.5; controls.minPolarAngle = .25; controls.maxPolarAngle = Math.PI * .43;
controls.panSpeed = .7; controls.rotateSpeed = .65; controls.touches.ONE = THREE.TOUCH.PAN; controls.touches.TWO = THREE.TOUCH.DOLLY_ROTATE;
controls.addEventListener('start', () => { cameraGoal = null; overviewLocked = false; });
scene.add(new THREE.HemisphereLight('#fff9dc', '#7b8966', 2.6));
const sunlight = new THREE.DirectionalLight('#fff3cf', 3.1); sunlight.position.set(-35, 70, 35); sunlight.castShadow = true;
sunlight.shadow.mapSize.set(1024, 1024); Object.assign(sunlight.shadow.camera, { left: -45, right: 45, top: 38, bottom: -38, near: 1, far: 170 });
sunlight.shadow.bias = -.00025; sunlight.shadow.normalBias = .08; sunlight.shadow.radius = 3;
scene.add(sunlight);
scene.add(new THREE.AmbientLight('#e7f0d7', .35));
const outerGround = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: '#dce6d4', roughness: 1 }));
outerGround.rotation.x = -Math.PI / 2; outerGround.position.y = -1.66; outerGround.receiveShadow = true; scene.add(outerGround);
let battlefield = createBattleRenderer(scene, camera, state);
const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
let pointerDown = null, activePointers = new Set(), multiplePointers = false;

function viewport() { return { width: Math.max(1, root.clientWidth), height: Math.max(1, root.clientHeight) }; }
function fitCamera() {
  const { width, height } = viewport(), aspect = width / height;
  // Leave room for the raised board and silhouettes at both narrow and wide sizes.
  const portrait = aspect < .9;
  const halfHeight = portrait ? Math.max(35, 29 / aspect) : Math.max(28, 40 / aspect);
  camera.left = -halfHeight * aspect; camera.right = halfHeight * aspect; camera.top = halfHeight; camera.bottom = -halfHeight;
  camera.updateProjectionMatrix();
}
function resize() {
  const { width, height } = viewport(); renderer.setSize(width, height, false); fitCamera();
  if (overviewLocked) overview(true);
}
function syncShown() { shownState = getBattleView(state, view.perspective); return shownState; }
function reconcileSelection() {
  if (view.selectedId && !shownState.units.some(u => u.id === view.selectedId)) view.selectedId = null;
}
function select(id) {
  syncShown();
  if (id !== null && !shownState.units.some(unit => unit.id === id)) return false;
  view.selectedId = id; refreshUI(); renderNow(); return true;
}
function overview(immediate = false) {
  overviewLocked = true; fitCamera();
  const { width, height } = viewport();
  const position = width / height < .9 ? new THREE.Vector3(52, 63, 7) : new THREE.Vector3(7, 63, 52), target = new THREE.Vector3(0, .4, 0);
  if (immediate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    camera.position.copy(position); controls.target.copy(target); camera.zoom = 1; camera.updateProjectionMatrix(); cameraGoal = null; controls.update();
  } else cameraGoal = { position, target, zoom: 1 };
}
function focus(id = view.selectedId) {
  const unit = shownState.units.find(u => u.id === id); if (!unit) return;
  const offset = camera.position.clone().sub(controls.target);
  const target = new THREE.Vector3(unit.x, .4, unit.z);
  cameraGoal = { target, position: target.clone().add(offset), zoom: Math.max(camera.zoom, 1.65) }; overviewLocked = false;
}
function reset(seed = state.seed, options = {}) {
  const nextSeed = String(seed || 'crossing').trim().slice(0, 80) || 'crossing';
  const requested = Number(options.perSide ?? state.units.filter(u => u.team === 'blue').length);
  const perSide = Number.isInteger(requested) && requested >= 1 && requested <= 120 ? requested : 24;
  state = createBattle(nextSeed, { perSide }); accumulator = 0; lastFrame = performance.now();
  $('battle-seed').value = state.seed; $('battle-size').value = String(perSide);
  view.paused = true; view.selectedId = null; view.droppedSeconds = 0;
  announcedOutcome = false; selectionSignature = ''; lastEventSignature = '';
  battlefield.dispose(); battlefield = createBattleRenderer(scene, camera, state);
  syncShown(); overview(true); refreshUI(); renderNow();
  $('battle-announcement').textContent = `${perSide} soldiers in each army. Battle reset and ready.`;
  return state;
}
function togglePause() {
  if (state.outcome) return false;
  view.paused = !view.paused; accumulator = 0; lastFrame = performance.now(); refreshUI();
  return view.paused;
}
function setSpeed(value) {
  const speed = Number(value); if (![1, 2, 4].includes(speed)) return false;
  view.speed = speed; refreshUI(); return true;
}
function setPerspective(perspective) {
  if (!['all', 'blue', 'red'].includes(perspective)) return false;
  view.perspective = perspective; syncShown(); reconcileSelection(); selectionSignature = ''; lastEventSignature = ''; refreshUI(); renderNow(); return true;
}
function order(unitIds, nextOrder) {
  const visibleIds = new Set(shownState.units.map(u => u.id));
  const eligible = unitIds.filter(id => visibleIds.has(id));
  const result = issueBattleOrder(state, eligible, nextOrder); syncShown(); refreshUI(); renderNow(); return result;
}
function stepPulses(count = 1) {
  const n = Math.max(0, Math.min(10000, Math.floor(Number(count) || 0)));
  let completed = 0;
  for (; completed < n && !state.outcome; completed++) stepBattle(state, DT);
  accumulator = 0; syncShown(); if (state.outcome) view.paused = true; refreshUI(); renderNow();
  return { completed, time: state.time, tick: state.tick, outcome: state.outcome };
}
const roleNames = { infantry: 'Infantry', ranged: 'Archer', scout: 'Scout' };
const roleSymbols = { infantry: '◆', scout: '⌁' };
const actionNames = { advance: 'Advancing with the squad', attack: 'Attacking', hold: 'Holding position', pursue: 'Pursuing a target', intercept: 'Cutting off a target', withdraw: 'Falling back', space: 'Making room to shoot', move: 'Moving to an order', dead: 'Fallen in battle', retreat: 'Falling back', 'attack-move': 'Advancing into battle' };
const teamName = team => team === 'blue' ? 'Blue' : 'Red';
const soldierName = unit => `${roleNames[unit.role] || 'Soldier'} ${String(unit.id).split('-').at(-1)}`;
const timeText = time => `${String(Math.floor(time / 60)).padStart(2, '0')}:${String(Math.floor(time % 60)).padStart(2, '0')}`;
function text(id, value) { const element = $(id); if (element.textContent !== String(value)) element.textContent = value; }
function refreshUI() {
  syncShown(); reconcileSelection();
  $('battle-pause').disabled = Boolean(state.outcome);
  $('play-symbol').classList.toggle('is-playing', !view.paused);
  text('play-label', state.outcome ? 'Complete' : view.paused ? state.tick ? 'Resume' : 'Start battle' : 'Pause');
  $('battle-pause').setAttribute('aria-label', state.outcome ? 'Battle complete' : view.paused ? 'Start or resume the battle' : 'Pause the battle');
  $('battle-pause').setAttribute('aria-pressed', String(!view.paused));
  $('battle-speed').value = String(view.speed); $('battle-perspective').value = view.perspective;
  text('battle-status', state.outcome ? 'Finished' : view.paused ? state.tick ? 'Paused' : 'Ready' : 'In motion');
  $('battle-status').classList.toggle('is-live', !view.paused && !state.outcome); text('battle-time', timeText(state.time));
  for (const team of ['blue', 'red']) {
    const units = shownState.units.filter(unit => unit.team === team), alive = units.filter(unit => unit.alive).length;
    const observedEnemy = view.perspective !== 'all' && view.perspective !== team;
    const count = $(`${team}-count`), label = observedEnemy ? 'in sight' : 'standing';
    if (count.dataset.value !== `${alive}:${label}`) { count.replaceChildren(document.createTextNode(`${alive} `), Object.assign(document.createElement('small'), { textContent: label })); count.dataset.value = `${alive}:${label}`; }
    const ratio = units.reduce((sum, unit) => sum + unit.hp, 0) / Math.max(1, units.reduce((sum, unit) => sum + unit.maxHp, 0));
    $(`${team}-health`).style.width = observedEnemy ? '0%' : `${ratio * 100}%`;
    $(`${team}-health`).parentElement.setAttribute('aria-label', observedEnemy ? `${teamName(team)} army total health is unknown` : `${teamName(team)} army health ${Math.round(ratio * 100)} percent`);
  }
  text('view-description', view.perspective === 'all' ? 'Both armies act on what they can see.' : `Only soldiers seen by the ${teamName(view.perspective).toLowerCase()} army are shown.`);
  const livingShown = shownState.units.filter(u => u.alive).length;
  text('field-population', view.perspective === 'all' ? `${livingShown} soldiers standing` : `${livingShown} soldiers in view`);
  text('performance-note', view.droppedSeconds > .5 ? 'The battle slows when the browser needs a moment.' : 'Same seed. Same opening.');
  const rosterSignature = shownState.units.map(u => `${u.id}:${u.alive}`).join('|');
  if (selectionSignature !== rosterSignature) {
    const options = [Object.assign(document.createElement('option'), { value: '', textContent: 'Choose a soldier' })];
    for (const unit of shownState.units) options.push(Object.assign(document.createElement('option'), { value: unit.id, textContent: `${teamName(unit.team)} · ${soldierName(unit)}${unit.alive ? '' : ' · fallen'}` }));
    $('unit-selector').replaceChildren(...options); selectionSignature = rosterSignature;
  }
  $('unit-selector').value = view.selectedId || '';
  const selected = shownState.units.find(unit => unit.id === view.selectedId);
  $('unit-inspector').dataset.selectedId = selected?.id || '';
  $('unit-empty').hidden = Boolean(selected); $('unit-details').hidden = !selected; $('unit-focus').disabled = !selected;
  if (selected) {
    const observedEnemy = view.perspective !== 'all' && selected.team !== view.perspective;
    const target = shownState.units.find(unit => unit.id === selected.targetId);
    text('unit-team', `${teamName(selected.team)} army`); text('unit-name', soldierName(selected)); text('unit-id', selected.id);
    if (selected.role === 'ranged') {
      if (!$('unit-icon').querySelector('svg')) $('unit-icon').innerHTML = '<svg class="bow-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3c10 4 10 14 0 18L11 12 7 3ZM3 12h17m-3-3 3 3-3 3"/></svg>';
    } else text('unit-icon', roleSymbols[selected.role] || '◆');
    $('unit-icon').style.color = selected.team === 'blue' ? '#378dba' : '#d67960'; $('unit-icon').style.background = selected.team === 'blue' ? '#e5eff0' : '#f5e7de';
    text('unit-health-text', `${Math.ceil(selected.hp)} / ${selected.maxHp}`);
    $('unit-health-bar').style.width = `${Math.max(0, selected.hp / selected.maxHp) * 100}%`;
    $('unit-health-bar').style.background = selected.hp / selected.maxHp < .3 ? '#c99868' : '#91ab73';
    const observedAction = !selected.alive ? 'Fallen in battle' : Math.hypot(selected.vx || 0, selected.vz || 0) > .2 ? 'Moving in sight' : 'Standing in sight';
    text('unit-action', observedEnemy ? observedAction : actionNames[selected.action] || selected.action?.replaceAll('-', ' ') || 'Watching the field');
    text('unit-reason', observedEnemy ? selected.alive ? 'This soldier is visible. Its plans and attack timing are unknown.' : 'This soldier was seen falling in battle.' : selected.reason || 'Watching the field.');
    text('unit-target', observedEnemy && selected.alive ? 'Unknown' : target ? `${teamName(target.team)} ${soldierName(target)}` : selected.targetId ? 'Out of sight' : 'No target');
    const cooldown = Number.isFinite(selected.attackReadyAt) ? Math.max(0, selected.attackReadyAt - state.time) : null;
    text('unit-cooldown', !selected.alive ? '—' : cooldown === null ? 'Unknown' : cooldown > .02 ? `${cooldown.toFixed(1)}s` : 'Ready');
    text('unit-position', `${selected.x.toFixed(1)}, ${selected.z.toFixed(1)}`);
    $('unit-target-select').hidden = !target; $('unit-target-select').dataset.targetId = target?.id || '';
  } else {
    // A change of army view must not leave a previous enemy's HP or decision
    // text behind, including in collapsed or assistive-technology content.
    for (const id of ['unit-team', 'unit-name', 'unit-id', 'unit-health-text', 'unit-action', 'unit-reason', 'unit-target', 'unit-cooldown', 'unit-position']) text(id, '');
    $('unit-health-bar').style.width = '0%'; $('unit-target-select').hidden = true; $('unit-target-select').dataset.targetId = '';
  }
  const dispatch = shownState.events.filter(event => ['death', 'impact', 'shot'].includes(event.type)).slice(-3).reverse();
  const eventSignature = `${view.perspective}:${dispatch.map(event => event.id).join(':')}`;
  if (lastEventSignature !== eventSignature) {
    lastEventSignature = eventSignature;
    const rows = dispatch.map(event => {
      const li = document.createElement('li'), timestamp = document.createElement('time'), copy = document.createElement('span'); timestamp.textContent = timeText(event.time);
      copy.textContent = event.type === 'death' ? `${event.targetId} fell in battle.` : event.type === 'impact' ? `${event.sourceId} hit ${event.targetId} for ${event.damage}.` : `${event.sourceId} ${event.projectile ? 'loosed an arrow at' : 'struck at'} ${event.targetId}.`;
      li.append(timestamp, copy); return li;
    });
    if (!rows.length) { const placeholder = document.createElement('li'); placeholder.className = 'event-placeholder'; placeholder.textContent = state.tick ? 'The armies are moving. First contact is still ahead.' : 'The armies are ready. Start the battle to see how it unfolds.'; rows.push(placeholder); }
    $('battle-events').replaceChildren(...rows);
  }
  $('battle-result').hidden = !state.outcome;
  if (state.outcome) {
    const winner = state.outcome.winner, remaining = shownState.units.filter(u => u.alive && u.team === winner).length;
    text('result-title', winner ? `${teamName(winner)} holds the field` : 'The armies disengaged');
    const knowWinnerStrength = view.perspective === 'all' || view.perspective === winner;
    text('result-detail', winner && knowWinnerStrength ? `${remaining} ${remaining === 1 ? 'soldier remains' : 'soldiers remain'} after ${timeText(state.time)}.` : `The battle ended after ${timeText(state.time)}.`);
    if (!announcedOutcome) { announcedOutcome = true; $('battle-announcement').textContent = `${$('result-title').textContent}. ${$('result-detail').textContent}`; }
  }
}
function renderNow() {
  controls.update();
  const alpha = view.paused || state.outcome ? 1 : accumulator / DT;
  const renderTime = view.paused || state.outcome ? state.time : Math.max(0, state.time - DT + accumulator);
  battlefield.update(shownState, { alpha, selectedId: view.selectedId, perspective: view.perspective, time: renderTime });
  renderer.render(scene, camera);
}
function diagnostics() {
  const detail = battlefield.diagnostics();
  return { ...detail, fps: view.fps, frameMs: view.frameMs, frame: renderer.info.render.frame, simulationTime: state.time, simulationTick: state.tick, simulationSpeed: view.speed, paused: view.paused, perspective: view.perspective, droppedSeconds: view.droppedSeconds, drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures, selectedId: view.selectedId, simulationMetrics: { ...shownState.metrics } };
}
function projectUnit(id) {
  const position = battlefield.position(id); if (!position) return null;
  const rect = renderer.domElement.getBoundingClientRect(); let fallback = null;
  // Prefer a point that actually resolves to this model. In a tight formation,
  // its geometric center may sit behind the soldier immediately in front.
  for (const y of position.alive ? [1.03, 1.43, .64] : [.2]) {
    const projected = new THREE.Vector3(position.x, y, position.z).project(camera);
    const point = { x: rect.left + (projected.x * .5 + .5) * rect.width, y: rect.top + (-projected.y * .5 + .5) * rect.height, visible: false, alive: position.alive };
    fallback ||= point;
    if (projected.z < -1 || projected.z > 1 || Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1) continue;
    raycaster.setFromCamera(new THREE.Vector2(projected.x, projected.y), camera);
    const hit = raycaster.intersectObjects(battlefield.getPickables(), false)[0];
    if (hit && battlefield.resolvePick(hit) === id) return { ...point, visible: true };
  }
  return fallback;
}
const actions = { reset, togglePause, setSpeed, setPerspective, select, overview, focus, issueOrder: order, replay() { reset(state.seed, { perSide: state.units.length / 2 }); togglePause(); } };
window.littleworldBattle = { get state() { return state; }, get shownState() { return shownState; }, view, actions, stepPulses, renderer, camera, controls, scene, diagnostics, getPickables: () => battlefield.getPickables(), projectUnit, summary: () => battleSummary(state) };

$('battle-pause').addEventListener('click', togglePause);
$('battle-speed').addEventListener('change', event => setSpeed(event.target.value));
$('battle-perspective').addEventListener('change', event => setPerspective(event.target.value));
$('battle-setup').addEventListener('submit', event => { event.preventDefault(); reset($('battle-seed').value, { perSide: Number($('battle-size').value) }); });
$('unit-selector').addEventListener('change', event => select(event.target.value || null));
$('unit-focus').addEventListener('click', () => focus());
$('unit-target-select').addEventListener('click', () => select($('unit-target-select').dataset.targetId));
$('battle-overview').addEventListener('click', () => overview());
$('battle-replay').addEventListener('click', actions.replay);
renderer.domElement.addEventListener('pointerdown', event => {
  activePointers.add(event.pointerId); if (activePointers.size > 1) multiplePointers = true;
  if (event.button === 0 || event.pointerType === 'touch') pointerDown = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
});
renderer.domElement.addEventListener('pointermove', event => { if (pointerDown?.id === event.pointerId && Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) > 6) pointerDown.moved = true; });
renderer.domElement.addEventListener('pointercancel', event => { activePointers.delete(event.pointerId); pointerDown = null; if (!activePointers.size) multiplePointers = false; });
renderer.domElement.addEventListener('pointerup', event => {
  const tap = pointerDown?.id === event.pointerId && !pointerDown.moved && !multiplePointers;
  activePointers.delete(event.pointerId); if (!activePointers.size) multiplePointers = false; pointerDown = null;
  if (!tap) return;
  const rect = renderer.domElement.getBoundingClientRect(); pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1); raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(battlefield.getPickables(), false)[0]; if (hit) { const id = battlefield.resolvePick(hit); if (id) select(id); }
});
renderer.domElement.addEventListener('keydown', event => {
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
    event.preventDefault(); const units = shownState.units.filter(u => u.alive), index = units.findIndex(u => u.id === view.selectedId), offset = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1;
    if (units.length) select(units[(index + offset + units.length) % units.length].id);
  }
  if (event.key === 'Enter') { event.preventDefault(); focus(); }
});
window.addEventListener('keydown', event => {
  if (event.target.matches('input,select,textarea') || event.altKey || event.metaKey || event.ctrlKey) return;
  if (event.code === 'Space' && !event.target.closest('button,a[href]')) { event.preventDefault(); togglePause(); }
  if (event.key === 'Home') { event.preventDefault(); overview(); }
  if (event.key === 'Escape') select(null);
});
document.addEventListener('visibilitychange', () => { lastFrame = performance.now(); accumulator = 0; });
new ResizeObserver(resize).observe(root);
$('battle-seed').value = state.seed; $('battle-size').value = String(state.units.length / 2);
resize(); overview(true); refreshUI(); renderNow(); $('battle-loading').remove();
function frame(now) {
  const elapsed = Math.max(0, (now - lastFrame) / 1000); lastFrame = now; view.frameMs = elapsed * 1000;
  if (!view.paused && !state.outcome && !document.hidden) {
    const accepted = Math.min(elapsed, .25); view.droppedSeconds += Math.max(0, elapsed - accepted) * view.speed;
    accumulator += accepted * view.speed;
    let steps = 0;
    while (accumulator >= DT - 1e-9 && steps < MAX_STEPS_PER_FRAME && !state.outcome) { stepBattle(state, DT); accumulator = Math.max(0, accumulator - DT); steps++; }
    if (accumulator >= DT) { const remainder = accumulator % DT; view.droppedSeconds += accumulator - remainder; accumulator = remainder; }
    if (steps) syncShown();
    if (state.outcome) { view.paused = true; accumulator = 0; refreshUI(); }
  }
  if (cameraGoal) {
    camera.position.lerp(cameraGoal.position, .1); controls.target.lerp(cameraGoal.target, .1); camera.zoom = lerpNumber(camera.zoom, cameraGoal.zoom, .1); camera.updateProjectionMatrix();
    if (camera.position.distanceTo(cameraGoal.position) < .03 && Math.abs(camera.zoom - cameraGoal.zoom) < .002) cameraGoal = null;
  }
  renderNow(); frameCount++;
  if (now - fpsAt >= 500) { view.fps = Math.round(frameCount * 1000 / (now - fpsAt)); frameCount = 0; fpsAt = now; }
  if (now - lastUI >= 100) { refreshUI(); lastUI = now; }
  requestAnimationFrame(frame);
}
function lerpNumber(a, b, amount) { return a + (b - a) * amount; }
requestAnimationFrame(frame);
