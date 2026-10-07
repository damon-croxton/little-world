import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const TEAM = { blue: '#378dba', red: '#d67960' };
const lerp = THREE.MathUtils.lerp;

// The renderer consumes the same filtered observation as the inspector. It never
// looks up an unseen enemy in the authoritative battle state.
export function createBattleRenderer(scene, camera, initialState) {
  const root = new THREE.Group();
  root.name = 'The crossing';
  scene.add(root);
  const geometries = new Set(), materials = new Set(), textures = new Set();
  const geometry = value => (geometries.add(value), value);
  const material = value => (materials.add(value), value);
  const standard = (color, extra = {}) => material(new THREE.MeshStandardMaterial({ color, roughness: .93, flatShading: true, ...extra }));
  const basic = (color, extra = {}) => material(new THREE.MeshBasicMaterial({ color, ...extra }));
  const dummy = new THREE.Object3D(), color = new THREE.Color();
  const capacity = Math.max(48, initialState.units.length);
  const bounds = initialState.bounds;
  const width = bounds.maxX - bounds.minX, depth = bounds.maxZ - bounds.minZ;
  const centerX = (bounds.maxX + bounds.minX) / 2, centerZ = (bounds.maxZ + bounds.minZ) / 2;
  let randomState = [...String(initialState.seed)].reduce((n, c) => Math.imul(n ^ c.charCodeAt(0), 16777619), 2166136261) >>> 0;
  function random() { randomState += 0x6D2B79F5; let t = randomState; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }
  function mesh(g, m, x = 0, y = 0, z = 0, parent = root) {
    const result = new THREE.Mesh(g, m); result.position.set(x, y, z); result.castShadow = true; result.receiveShadow = true; parent.add(result); return result;
  }
  function instances(g, m, count = capacity) {
    const result = new THREE.InstancedMesh(g, m, count); result.count = 0;
    result.instanceMatrix.setUsage(THREE.DynamicDrawUsage); result.frustumCulled = false;
    // Raycasting otherwise caches the first formation's sphere after a pick.
    // Units can cross the entire field, so keep a conservative arena bound.
    result.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 110);
    result.castShadow = true; result.receiveShadow = true; root.add(result); return result;
  }
  const soil = standard('#818364');
  mesh(geometry(new THREE.BoxGeometry(width + 3.8, 1.3, depth + 3.8)), soil, centerX, -.75, centerZ);
  mesh(geometry(new THREE.BoxGeometry(width + 4.3, .35, depth + 4.3)), standard('#a2a587'), centerX, -1.43, centerZ);
  const fieldGeometry = geometry(new THREE.PlaneGeometry(width + 3.8, depth + 3.8, 44, 30));
  fieldGeometry.rotateX(-Math.PI / 2);
  const positions = fieldGeometry.getAttribute('position'), fieldColors = [];
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i), z = positions.getZ(i);
    color.set('#a2b17b').lerp(new THREE.Color('#c1c798'), .25 + .14 * Math.sin(x * .32 + z * .13) + .12 * Math.cos(z * .43));
    color.multiplyScalar(.95 + random() * .09); fieldColors.push(color.r, color.g, color.b);
  }
  fieldGeometry.setAttribute('color', new THREE.Float32BufferAttribute(fieldColors, 3));
  mesh(fieldGeometry, standard('#ffffff', { vertexColors: true }), centerX, -.08, centerZ);
  const pathPoints = [], pathColors = [];
  for (let i = 0; i < 36; i++) {
    const x0 = bounds.minX - 1.85 + i / 36 * (width + 3.7), x1 = bounds.minX - 1.85 + (i + 1) / 36 * (width + 3.7);
    const z0 = Math.sin(x0 * .1) * 1.4, z1 = Math.sin(x1 * .1) * 1.4, r = 1.3;
    pathPoints.push(x0, -.055, z0 - r, x0, -.055, z0 + r, x1, -.055, z1 + r, x0, -.055, z0 - r, x1, -.055, z1 + r, x1, -.055, z1 - r);
    color.set('#c1ba8a').multiplyScalar(.95 + random() * .07); for (let j = 0; j < 6; j++) pathColors.push(color.r, color.g, color.b);
  }
  const pathGeometry = geometry(new THREE.BufferGeometry());
  pathGeometry.setAttribute('position', new THREE.Float32BufferAttribute(pathPoints, 3));
  pathGeometry.setAttribute('color', new THREE.Float32BufferAttribute(pathColors, 3)); pathGeometry.computeVertexNormals();
  mesh(pathGeometry, standard('#ffffff', { vertexColors: true, side: THREE.DoubleSide }));

  const boundaryPositions = [];
  for (const [x, z, sx, sz] of [[bounds.minX, bounds.minZ, 1, 1], [bounds.maxX, bounds.minZ, -1, 1], [bounds.minX, bounds.maxZ, 1, -1], [bounds.maxX, bounds.maxZ, -1, -1]]) {
    boundaryPositions.push(x + sx * 3, .025, z, x, .025, z, x, .025, z, x, .025, z + sz * 3);
  }
  const borderGeometry = geometry(new THREE.BufferGeometry()); borderGeometry.setAttribute('position', new THREE.Float32BufferAttribute(boundaryPositions, 3));
  root.add(new THREE.LineSegments(borderGeometry, basic('#e3ddaf', { transparent: true, opacity: .6 })));

  const rockMaterials = ['#9a9d88', '#adb09a', '#8e927f'].map(c => standard(c));
  for (const obstacle of initialState.obstacles || []) {
    const h = obstacle.height || 1.8, w = obstacle.width || obstacle.radius * 2 || 3, d = obstacle.depth || obstacle.radius * 2 || 3;
    const block = mesh(geometry(new THREE.BoxGeometry(w, h, d)), rockMaterials[0], obstacle.x, h / 2, obstacle.z);
    block.userData.obstacleId = obstacle.id;
    mesh(geometry(new THREE.BoxGeometry(w * .96, .2, d * .96)), rockMaterials[1], obstacle.x, h + .08, obstacle.z);
    const rocks = Math.max(2, Math.floor(w / 1.3));
    for (let j = 0; j < rocks; j++) {
      const rock = mesh(geometry(new THREE.DodecahedronGeometry(.65, 0)), rockMaterials[(j + 1) % 3], obstacle.x + (random() - .5) * (w - .8), h + .25, obstacle.z + (random() - .5) * Math.max(0, d - .8));
      rock.scale.set(.8 + random() * .6, .5, .8 + random() * .4); rock.rotation.y = random() * 4;
    }
  }

  // All trees sit beyond the playable bounds; apparent cover is real cover.
  const trunkGeometry = geometry(new THREE.CylinderGeometry(.16, .23, 1.9, 5)), canopyGeometry = geometry(new THREE.ConeGeometry(1.35, 3.1, 6));
  const trunkMaterial = standard('#8a8160'), leafMaterials = ['#7f9964', '#69855c', '#93a471'].map(c => standard(c));
  for (let i = 0; i < 26; i++) {
    const side = i % 4, t = random(), outward = 3 + random() * 4;
    const x = side < 2 ? lerp(bounds.minX - 1, bounds.maxX + 1, t) : side === 2 ? bounds.minX - outward : bounds.maxX + outward;
    const z = side >= 2 ? lerp(bounds.minZ, bounds.maxZ, t) : side === 0 ? bounds.minZ - outward : bounds.maxZ + outward;
    const scale = .65 + random() * .65;
    const trunk = mesh(trunkGeometry, trunkMaterial, x, -.9 + .95 * scale, z); trunk.scale.setScalar(scale);
    const crown = mesh(canopyGeometry, leafMaterials[i % 3], x, -.9 + 2.4 * scale, z); crown.scale.setScalar(scale); crown.rotation.y = random() * 2;
    const upper = mesh(canopyGeometry, leafMaterials[(i + 1) % 3], x, -.9 + 3.3 * scale, z); upper.scale.setScalar(scale * .72); upper.rotation.y = crown.rotation.y;
  }
  const grassGeometry = geometry(new THREE.ConeGeometry(.16, .65, 3)), grass = instances(grassGeometry, standard('#8b9f68'), 230);
  grass.castShadow = false;
  for (let i = 0; i < 230; i++) {
    const x = lerp(bounds.minX, bounds.maxX, random()), z = lerp(bounds.minZ, bounds.maxZ, random());
    if (Math.abs(z - Math.sin(x * .1) * 1.4) < 2 || (initialState.obstacles || []).some(o => Math.abs(x - o.x) < o.width / 2 + 1 && Math.abs(z - o.z) < o.depth / 2 + 1)) continue;
    dummy.position.set(x, .03, z); dummy.rotation.set(0, random() * Math.PI, .2); dummy.scale.setScalar(.4 + random() * .55); dummy.updateMatrix(); grass.setMatrixAt(grass.count++, dummy.matrix);
  }
  grass.instanceMatrix.needsUpdate = true;
  for (const team of ['blue', 'red']) {
    const x = team === 'blue' ? bounds.minX + 4 : bounds.maxX - 4;
    for (const z of [bounds.minZ + 4, bounds.maxZ - 4]) {
      mesh(geometry(new THREE.CylinderGeometry(.06, .1, 3.8, 5)), standard('#746e4f'), x, 1.9, z);
      const flag = mesh(geometry(new THREE.BoxGeometry(1.3, .9, .04)), standard(TEAM[team]), x + .65, 3.2, z); flag.rotation.y = -.18;
      mesh(geometry(new THREE.CylinderGeometry(.28, .48, .35, 6)), rockMaterials[1], x, .175, z);
    }
  }

  function modelGeometry(team, role) {
    const pieces = [];
    function add(g, c, x, y, z, rx = 0, ry = 0, rz = 0) {
      if (g.index) { const old = g; g = g.toNonIndexed(); old.dispose(); }
      g.rotateX(rx); g.rotateY(ry); g.rotateZ(rz); g.translate(x, y, z);
      const vertices = g.getAttribute('position').count, colors = new Float32Array(vertices * 3), tint = new THREE.Color(c);
      for (let i = 0; i < vertices; i++) tint.toArray(colors, i * 3);
      g.setAttribute('color', new THREE.BufferAttribute(colors, 3)); pieces.push(g);
    }
    const shade = TEAM[team], cloth = team === 'blue' ? '#245d80' : '#954e41', skin = '#e7c995', boots = '#4e5a4a', steel = '#d7dfca';
    add(new THREE.CylinderGeometry(.28, .38, .71, 5), shade, 0, .84, 0);
    add(new THREE.BoxGeometry(.21, .51, .24), boots, -.17, .27, 0);
    add(new THREE.BoxGeometry(.21, .51, .24), boots, .17, .27, .04);
    add(new THREE.BoxGeometry(.26, .18, .34), '#56604a', -.17, .1, .09);
    add(new THREE.BoxGeometry(.26, .18, .34), '#56604a', .17, .1, .13);
    add(new THREE.SphereGeometry(.25, 6, 5), skin, 0, 1.37, .04);
    add(new THREE.BoxGeometry(.14, .38, .19), cloth, -.36, .92, .06, -.22);
    add(new THREE.BoxGeometry(.14, .38, .19), cloth, .36, .92, .09, -.25);
    if (role === 'infantry') {
      add(new THREE.SphereGeometry(.28, 6, 4, 0, Math.PI * 2, 0, Math.PI * .55), steel, 0, 1.41, .03);
      add(new THREE.BoxGeometry(.07, .19, .33), shade, 0, 1.7, .015);
      add(new THREE.CylinderGeometry(.3, .3, .105, 5), steel, -.36, .94, .25, Math.PI / 2);
      add(new THREE.CylinderGeometry(.23, .23, .12, 5), shade, -.36, .94, .27, Math.PI / 2);
      add(new THREE.BoxGeometry(.08, .87, .065), '#dde2d0', .42, 1.28, .23, .3, 0, -.15);
      add(new THREE.BoxGeometry(.22, .06, .13), '#806e4c', .41, .94, .11);
    } else if (role === 'ranged') {
      add(new THREE.ConeGeometry(.31, .35, 6), cloth, 0, 1.62, -.025, -.16);
      add(new THREE.BoxGeometry(.22, .5, .18), '#675638', .17, 1, -.33, .12, 0, -.2);
      for (let j = 0; j < 3; j++) add(new THREE.BoxGeometry(.025, .38, .025), '#e6d5a4', .09 + j * .06, 1.36, -.34, .12, 0, -.2);
      add(new THREE.TorusGeometry(.41, .047, 3, 9, Math.PI), '#ae854f', -.4, 1.04, .36, 0, .55, -Math.PI / 2);
      add(new THREE.BoxGeometry(.016, .78, .016), '#e5dbb4', -.4, 1.04, .36, 0, 0, 0);
    } else {
      add(new THREE.ConeGeometry(.28, .39, 5), shade, 0, 1.57, -.035, -.25);
      add(new THREE.BoxGeometry(.11, .55, .34), '#dde0b0', .03, 1.4, -.23, -.4);
      add(new THREE.BoxGeometry(.055, .56, .055), steel, .39, 1.13, .3, .65, 0, -.4);
      add(new THREE.BoxGeometry(.47, .4, .07), cloth, 0, .88, -.26, -.22);
    }
    const combined = geometry(mergeGeometries(pieces, false)); pieces.forEach(p => p.dispose()); return combined;
  }
  const batches = new Map(), pickables = [];
  const figureMaterial = standard('#ffffff', { vertexColors: true });
  const corpseMaterial = standard('#a7a48b', { vertexColors: true, transparent: true, opacity: .62 });
  for (const team of ['blue', 'red']) for (const role of ['infantry', 'ranged', 'scout']) {
    const figure = modelGeometry(team, role), live = instances(figure, figureMaterial), fallen = instances(figure, corpseMaterial);
    live.name = `${team} ${role}`; live.userData.unitIds = []; live.userData.battleUnits = true;
    fallen.name = `${team} fallen ${role}`; fallen.castShadow = false;
    batches.set(`${team}:${role}`, { live, fallen }); pickables.push(live);
  }
  const baseGeometry = geometry(new THREE.CylinderGeometry(.48, .52, .09, 12));
  const bases = instances(baseGeometry, standard('#ffffff'), capacity); bases.castShadow = false;
  const barGeometry = geometry(new THREE.PlaneGeometry(1, 1));
  const barBacks = instances(barGeometry, basic('#2f4032', { transparent: true, opacity: .75, depthTest: false }), capacity);
  const barFills = instances(barGeometry, basic('#ffffff', { depthTest: false }), capacity);
  barBacks.renderOrder = 10; barFills.renderOrder = 11; barBacks.castShadow = barFills.castShadow = false;
  const selection = mesh(geometry(new THREE.RingGeometry(.65, .78, 40)), basic('#fff3ae', { side: THREE.DoubleSide, depthTest: false }), 0, .12, 0);
  selection.rotation.x = -Math.PI / 2; selection.renderOrder = 6; selection.visible = false; selection.castShadow = false;
  const targetRing = mesh(geometry(new THREE.RingGeometry(.58, .64, 28)), basic('#f4d29b', { side: THREE.DoubleSide, depthTest: false }), 0, .12, 0);
  targetRing.rotation.x = -Math.PI / 2; targetRing.renderOrder = 5; targetRing.visible = false; targetRing.castShadow = false;
  const targetGeometry = geometry(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]));
  const targetLine = new THREE.Line(targetGeometry, material(new THREE.LineDashedMaterial({ color: '#f6f1bb', dashSize: .35, gapSize: .25, transparent: true, opacity: .8, depthTest: false })));
  targetLine.renderOrder = 5; targetLine.visible = false; root.add(targetLine);
  const arrowGeometry = geometry(new THREE.ConeGeometry(.055, .75, 4)); arrowGeometry.rotateX(Math.PI / 2);
  const arrows = instances(arrowGeometry, basic('#fff5c4'), Math.max(256, capacity * 2)); arrows.castShadow = false; arrows.renderOrder = 4;
  const meleeGeometry = geometry(new THREE.RingGeometry(.24, .34, 9, 1, 0, Math.PI * 1.25));
  const slashes = instances(meleeGeometry, basic('#fff1c4', { side: THREE.DoubleSide, transparent: true, opacity: .85 }), capacity * 2); slashes.castShadow = false;
  const effectGeometry = geometry(new THREE.IcosahedronGeometry(1, 0));
  const sparks = instances(effectGeometry, basic('#ffffff', { transparent: true, opacity: .84 }), capacity * 20); sparks.castShadow = false;
  const seenEvents = new Set(), effects = [], renderedPositions = new Map();
  let actualImpactCount = 0, actualDeathCount = 0, actualShotCount = 0, renderedFrame = 0, renderedPerspective = null;
  const fogCanvas = document.createElement('canvas'); fogCanvas.width = 320; fogCanvas.height = 224;
  const fogContext = fogCanvas.getContext('2d'), fogTexture = new THREE.CanvasTexture(fogCanvas); textures.add(fogTexture);
  const fogMaterial = basic('#50644d', { map: fogTexture, transparent: true, opacity: .5, depthWrite: false, side: THREE.DoubleSide });
  const fog = mesh(geometry(new THREE.PlaneGeometry(width + 3.8, depth + 3.8)), fogMaterial, centerX, .025, centerZ);
  fog.rotation.x = -Math.PI / 2; fog.castShadow = false; fog.receiveShadow = false; fog.visible = false;
  let fogSignature = '';
  function updateFog(view, perspective) {
    fog.visible = perspective !== 'all'; if (!fog.visible || !fogContext) return;
    const signature = `${perspective}:${Math.floor(view.time * 4)}`; if (signature === fogSignature) return; fogSignature = signature;
    const ctx = fogContext, w = fogCanvas.width, h = fogCanvas.height, sx = w / (width + 3.8), sz = h / (depth + 3.8);
    ctx.globalCompositeOperation = 'source-over'; ctx.clearRect(0, 0, w, h); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'destination-out';
    const observers = view.sight?.observers || (view.units || []).filter(u => u.team === perspective && u.alive).map(u => ({ ...u, radius: u.sight || 12 }));
    for (const observer of observers) {
      const x = (observer.x - bounds.minX + 1.9) * sx, y = (observer.z - bounds.minZ + 1.9) * sz, radius = Math.max(2, observer.radius || observer.sight || 12) * sx;
      const gradient = ctx.createRadialGradient(x, y, radius * .75, x, y, radius); gradient.addColorStop(0, '#000'); gradient.addColorStop(1, '#0000');
      ctx.fillStyle = gradient; ctx.beginPath(); ctx.ellipse(x, y, radius, radius * sz / sx, 0, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over'; fogTexture.needsUpdate = true;
  }
  function unitPosition(unit, alpha) {
    return { x: Number.isFinite(unit.prevX) ? lerp(unit.prevX, unit.x, alpha) : unit.x, z: Number.isFinite(unit.prevZ) ? lerp(unit.prevZ, unit.z, alpha) : unit.z };
  }
  function update(view, { alpha = 1, selectedId = null, perspective = 'all', time = view.time } = {}) {
    renderedFrame++; renderedPositions.clear();
    if (renderedPerspective !== perspective) {
      effects.length = 0; seenEvents.clear();
      actualImpactCount = actualDeathCount = actualShotCount = 0;
      renderedPerspective = perspective;
    }
    for (const batch of batches.values()) { batch.live.count = 0; batch.fallen.count = 0; batch.live.userData.unitIds.length = 0; }
    bases.count = barBacks.count = barFills.count = 0;
    const visibleUnits = new Map((view.units || []).map(u => [u.id, u]));
    for (const unit of view.units || []) {
      const batch = batches.get(`${unit.team}:${unit.role}`); if (!batch) continue;
      const position = unitPosition(unit, alpha), moving = Math.hypot(unit.vx || 0, unit.vz || 0) > .2;
      const heading = Number.isFinite(unit.heading) ? unit.heading : Math.atan2(unit.vx || 0, unit.vz || (unit.team === 'blue' ? 1 : -1));
      const alive = unit.alive && unit.hp > 0;
      renderedPositions.set(unit.id, { x: position.x, y: alive ? 1 : .2, z: position.z, alive });
      dummy.position.set(position.x, alive ? .055 + (moving ? Math.abs(Math.sin(time * 13 + unit.id.length)) * .06 : 0) : .12, position.z);
      dummy.rotation.set(alive ? 0 : Math.PI / 2, heading, 0); dummy.scale.setScalar(1); dummy.updateMatrix();
      if (alive) {
        batch.live.setMatrixAt(batch.live.count, dummy.matrix); batch.live.userData.unitIds[batch.live.count++] = unit.id;
        dummy.position.set(position.x, .035, position.z); dummy.rotation.set(0, 0, 0); dummy.scale.setScalar(1); dummy.updateMatrix();
        bases.setMatrixAt(bases.count, dummy.matrix); bases.setColorAt(bases.count++, color.set(TEAM[unit.team]).multiplyScalar(.8));
        const barWidth = .93, health = Math.max(0, Math.min(1, unit.hp / unit.maxHp));
        dummy.position.set(position.x, 2.03, position.z); dummy.quaternion.copy(camera.quaternion); dummy.scale.set(barWidth, .085, 1); dummy.updateMatrix();
        barBacks.setMatrixAt(barBacks.count++, dummy.matrix);
        const offset = new THREE.Vector3(-(1 - health) * barWidth / 2, .003, .012).applyQuaternion(camera.quaternion);
        dummy.position.add(offset); dummy.scale.set(barWidth * health, .055, 1); dummy.updateMatrix();
        barFills.setMatrixAt(barFills.count, dummy.matrix); barFills.setColorAt(barFills.count++, color.set(health < .3 ? '#f2be78' : unit.team === 'blue' ? '#83d1ec' : '#f4b3a2'));
      } else batch.fallen.setMatrixAt(batch.fallen.count++, dummy.matrix);
    }
    for (const batch of batches.values()) { batch.live.instanceMatrix.needsUpdate = true; batch.fallen.instanceMatrix.needsUpdate = true; }
    for (const batch of [bases, barBacks, barFills]) { batch.instanceMatrix.needsUpdate = true; if (batch.instanceColor) batch.instanceColor.needsUpdate = true; }
    selection.visible = renderedPositions.has(selectedId); targetRing.visible = targetLine.visible = false;
    if (selection.visible) {
      const p = renderedPositions.get(selectedId); selection.position.set(p.x, .14, p.z);
      const selected = visibleUnits.get(selectedId), target = renderedPositions.get(selected?.targetId);
      if (target && selected.alive) {
        targetRing.visible = targetLine.visible = true; targetRing.position.set(target.x, .13, target.z);
        const attr = targetGeometry.getAttribute('position'); attr.setXYZ(0, p.x, .2, p.z); attr.setXYZ(1, target.x, .2, target.z); attr.needsUpdate = true; targetGeometry.computeBoundingSphere(); targetLine.computeLineDistances();
      }
    }
    for (const event of view.events || []) {
      if (seenEvents.has(event.id)) continue; seenEvents.add(event.id);
      if (event.type === 'shot') actualShotCount++;
      if (event.type === 'impact') actualImpactCount++;
      if (event.type === 'death') actualDeathCount++;
      if (['impact', 'death', 'miss'].includes(event.type) && Math.abs(view.time - event.time) < 1.5) effects.push({ ...event, born: event.time, kind: event.type });
      if (event.type === 'shot' && event.projectile === false && Math.abs(view.time - event.time) < .4) effects.push({ ...event, born: event.time, kind: 'melee' });
    }
    if (seenEvents.size > 3000) { const retained = [...seenEvents].slice(-1500); seenEvents.clear(); retained.forEach(id => seenEvents.add(id)); }
    arrows.count = 0;
    for (const shot of view.projectiles || []) {
      const progress = THREE.MathUtils.clamp((time - shot.launchedAt) / Math.max(.01, shot.impactAt - shot.launchedAt), 0, 1);
      const x = lerp(shot.fromX, shot.toX, progress), z = lerp(shot.fromZ, shot.toZ, progress), height = 1.1 + Math.sin(progress * Math.PI) * 1.8;
      dummy.position.set(x, height, z); dummy.rotation.set(-Math.cos(progress * Math.PI) * .38, Math.atan2(shot.toX - shot.fromX, shot.toZ - shot.fromZ), 0); dummy.scale.setScalar(1); dummy.updateMatrix();
      if (arrows.count < arrows.instanceMatrix.count) arrows.setMatrixAt(arrows.count++, dummy.matrix);
    }
    arrows.instanceMatrix.needsUpdate = true; sparks.count = slashes.count = 0;
    for (let i = effects.length - 1; i >= 0; i--) {
      const effect = effects[i], age = Math.max(0, time - effect.born), duration = effect.kind === 'death' ? 1.3 : effect.kind === 'melee' ? .28 : .4;
      if (age > duration) { effects.splice(i, 1); continue; }
      if (time < effect.born) continue;
      const progress = age / duration, x = effect.x ?? effect.targetX, z = effect.z ?? effect.targetZ;
      if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
      if (effect.kind === 'melee') {
        dummy.position.set(x, .8 + progress * .3, z); dummy.quaternion.copy(camera.quaternion); dummy.rotateZ(progress * 2.5); dummy.scale.setScalar(1.4); dummy.updateMatrix();
        if (slashes.count < slashes.instanceMatrix.count) slashes.setMatrixAt(slashes.count++, dummy.matrix);
      } else {
        const count = effect.kind === 'death' ? 9 : 4;
        for (let j = 0; j < count; j++) {
          if (sparks.count >= sparks.instanceMatrix.count) break;
          const angle = j / count * Math.PI * 2, spread = progress * (effect.kind === 'death' ? 1.2 : .65), size = (1 - progress) * (effect.kind === 'death' ? .22 : .105);
          dummy.position.set(x + Math.sin(angle) * spread, .4 + Math.sin(progress * Math.PI) * .8 + j % 3 * .13, z + Math.cos(angle) * spread); dummy.rotation.set(angle, progress * 2, angle); dummy.scale.setScalar(size); dummy.updateMatrix();
          sparks.setMatrixAt(sparks.count, dummy.matrix); sparks.setColorAt(sparks.count++, color.set(effect.kind === 'death' || effect.kind === 'miss' ? '#d4cfad' : '#fff0af'));
        }
      }
    }
    sparks.instanceMatrix.needsUpdate = true; if (sparks.instanceColor) sparks.instanceColor.needsUpdate = true; slashes.instanceMatrix.needsUpdate = true;
    updateFog(view, perspective);
  }
  return {
    root, update,
    getPickables: () => pickables.filter(p => p.count > 0),
    resolvePick: hit => hit.object.userData.unitIds?.[hit.instanceId] || null,
    position: id => renderedPositions.get(id) || null,
    diagnostics: () => ({ frame: renderedFrame, visibleUnitIds: [...renderedPositions.keys()], visibleUnitCount: bases.count, visibleIndividuals: bases.count, corpseCount: [...batches.values()].reduce((n, b) => n + b.fallen.count, 0), projectiles: arrows.count, activeEffects: effects.length, impactEffects: effects.filter(e => e.kind === 'impact').length, deathEffects: effects.filter(e => e.kind === 'death').length, actualShotsRendered: actualShotCount, actualImpactsRendered: actualImpactCount, actualDeathsRendered: actualDeathCount, unitDrawCalls: [...batches.values()].filter(b => b.live.count > 0).length, healthBars: barFills.count }),
    dispose() { root.removeFromParent(); root.traverse(object => { if (object.isInstancedMesh) object.dispose(); }); geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); textures.forEach(t => t.dispose()); }
  };
}
