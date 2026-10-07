import { heightAt } from '../world.js';

// All effects below refer to authoritative weapon orders, impacts, and recorded
// deaths. The renderer never creates a battle or advances a weapon clock.
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const mix = (a, b, t) => a + (b - a) * t;
const CAPS = { projectiles: 768, strikes: 384, impacts: 256, casualties: 512, retreats: 64 };

export function createCombatEffects(THREE, scene) {
  const root = new THREE.Group(); root.name = 'Authoritative combat effects'; scene.add(root);
  const pools = new Map(), groundCache = new Map(), colorCache = new Map();
  const transform = new THREE.Object3D(), from = new THREE.Vector3(), to = new THREE.Vector3(), midpoint = new THREE.Vector3(), direction = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const diagnostics = { projectiles: 0, strikes: 0, impacts: 0, casualties: 0, retreats: 0, visibleEffects: 0, droppedEffects: 0, drawCallsEstimate: 0, events: 0, reusedFrame: false };
  let lastState, lastTime, lastKey, seed, disposed = false, samples = [];
  const projectileMaterial = new THREE.MeshBasicMaterial({ toneMapped: false });
  const impactMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: .72, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  const casualtyMaterial = new THREE.MeshStandardMaterial({ roughness: .85, metalness: .15 });
  const retreatMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: .5, depthWrite: false, toneMapped: false });
  function pool(name, geometry, material, capacity) {
    const mesh = new THREE.InstancedMesh(geometry, material, capacity); mesh.name = `Combat ${name}`; mesh.count = 0; mesh.frustumCulled = false; mesh.castShadow = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
    root.add(mesh); const p = { mesh, geometry, capacity, count: 0 }; pools.set(name, p); return p;
  }
  pool('projectiles', new THREE.CylinderGeometry(.065, .025, 1, 4, 1), projectileMaterial, CAPS.projectiles);
  pool('strikes', new THREE.CylinderGeometry(.055, .025, 1, 3, 1), projectileMaterial, CAPS.strikes);
  pool('impacts', new THREE.OctahedronGeometry(1), impactMaterial, CAPS.impacts);
  pool('casualties', new THREE.CapsuleGeometry(.19, .43, 2, 5), casualtyMaterial, CAPS.casualties);
  pool('retreats', new THREE.RingGeometry(.72, 1, 24), retreatMaterial, CAPS.retreats);
  function color(value) {
    if (!colorCache.has(value)) colorCache.set(value, new THREE.Color(value));
    return colorCache.get(value);
  }
  function ground(event, point, suffix) {
    const key = `${event.id}:${suffix}`;
    if (!groundCache.has(key)) groundCache.set(key, heightAt(point.x, point.z, seed));
    return groundCache.get(key) + (point.height ?? .45);
  }
  function add(name, tint) {
    const p = pools.get(name);
    if (p.count >= p.capacity) { diagnostics.droppedEffects++; return false; }
    transform.updateMatrix(); p.mesh.setMatrixAt(p.count, transform.matrix); p.mesh.setColorAt(p.count, color(tint)); p.count++; diagnostics[name]++; diagnostics.visibleEffects++; return true;
  }
  function segment(name, a, b, width, tint) {
    direction.subVectors(b, a); const length = direction.length();
    if (length < .001) return false;
    midpoint.addVectors(a, b).multiplyScalar(.5); transform.position.copy(midpoint); transform.quaternion.setFromUnitVectors(up, direction.multiplyScalar(1 / length)); transform.scale.set(width, length, width);
    return add(name, tint);
  }
  function update(state, time) {
    if (disposed) return;
    time = Number.isFinite(time) ? time : state.time ?? state.tick;
    const events = state.combatEvents || [], key = `${state.step ?? state.tick}:${events.length}:${events.at(-1)?.id}`;
    if (lastState === state && lastTime === time && key === lastKey) { diagnostics.reusedFrame = true; return; }
    if (lastState !== state || seed !== state.seed) groundCache.clear();
    lastState = state; seed = state.seed; lastTime = time; lastKey = key; samples = [];
    for (const p of pools.values()) p.count = 0;
    for (const k of Object.keys(CAPS)) diagnostics[k] = 0;
    Object.assign(diagnostics, { visibleEffects: 0, droppedEffects: 0, drawCallsEstimate: 0, events: events.length, reusedFrame: false });
    const factionColors = new Map((state.factions || []).map(f => [f.id, f.color]));
    for (const e of events) {
      const age = time - e.time;
      if (age < 0 || time > e.expiresAt) continue;
      const tint = e.species === 'machine' ? '#8ef2ff' : e.species === 'hive' ? '#b8f39c' : '#ffe9a9';
      if (e.type === 'projectile' || e.type === 'melee') {
        const duration = Math.max(.08, e.impactTime - e.time), t = clamp(age / duration);
        if (e.type === 'projectile' && age > duration || e.type === 'melee' && age > duration + .16) continue;
        for (let index = 0; index < (e.shots || []).length; index++) {
          const shot = e.shots[index], fy = ground(e, shot.from, `f${index}`), ty = ground(e, shot.to, `t${index}`);
          if (e.type === 'projectile') {
            const tail = clamp(t - (e.tower ? .18 : .14)), arc = e.species === 'hive' ? 1.2 : e.species === 'human' ? .55 : .18;
            from.set(mix(shot.from.x, shot.to.x, tail), mix(fy, ty, tail) + Math.sin(tail * Math.PI) * arc, mix(shot.from.z, shot.to.z, tail));
            to.set(mix(shot.from.x, shot.to.x, t), mix(fy, ty, t) + Math.sin(t * Math.PI) * arc, mix(shot.from.z, shot.to.z, t));
            if (t < .04) from.y -= .13;
            if (segment('projectiles', from, to, e.tower ? 1.75 : 1, tint) && samples.length < 128) samples.push({ eventId: e.id, kind: e.type, sourceId: e.sourceId, targetId: e.targetId, sourceSoldierId: shot.sourceSoldierId || e.sourceSoldierId || null, targetSoldierId: shot.targetSoldierId || e.targetSoldierId || null, x: to.x, y: to.y, z: to.z, progress: t, simulationTime: time });
          } else {
            const swing = Math.sin(clamp(age / (duration + .16)) * Math.PI), reach = .4 + swing * .6;
            from.set(shot.from.x, fy, shot.from.z); to.set(mix(shot.from.x, shot.to.x, reach), mix(fy, ty, reach) + .2 * swing, mix(shot.from.z, shot.to.z, reach));
            if (segment('strikes', from, to, swing * 1.4, tint) && samples.length < 128) samples.push({ eventId: e.id, kind: e.type, sourceId: e.sourceId, targetId: e.targetId, sourceSoldierId: shot.sourceSoldierId || e.sourceSoldierId || null, targetSoldierId: shot.targetSoldierId || e.targetSoldierId || null, x: to.x, y: to.y, z: to.z, progress: reach, simulationTime: time });
          }
        }
      } else if (e.type === 'impact' && age <= .48) {
        const t = age / .48, radius = (.12 + Math.sin(t * Math.PI) * .32) * (e.structure ? 1.8 : 1);
        transform.position.set(e.x, ground(e, e, 'impact'), e.z); transform.rotation.set(t * 3, t * 4, 0); transform.scale.set(radius, radius * .8, radius);
        add('impacts', e.deaths ? '#fff2ce' : tint);
      } else if (e.type === 'casualty' && age <= 2.2) {
        const fall = clamp(age / .42), sink = clamp((age - 1.5) / .7);
        for (let index = 0; index < (e.positions || []).length; index++) {
          const p = e.positions[index], yaw = p.yaw || 0, h = ground(e, { ...p, height: .4 + (p.elevation || 0) }, `dead${index}`);
          transform.position.set(p.x + Math.sin(yaw) * .22 * fall, h - .28 * fall - .15 * sink, p.z + Math.cos(yaw) * .22 * fall);
          transform.rotation.set(Math.PI * .5 * fall, yaw, .15 * fall); transform.scale.set(1 - sink * .5, e.species === 'machine' ? .7 : 1, e.species === 'hive' ? 1.3 : 1);
          if (add('casualties', factionColors.get(p.commandFactionId || e.factionId) || '#a8a597') && samples.length < 128) samples.push({ eventId: e.id, kind: 'casualty', targetId: e.targetId, soldierId: p.soldierId || e.targetSoldierId || null, targetSoldierId: p.soldierId || e.targetSoldierId || null, deathX: p.x, deathZ: p.z, x: transform.position.x, y: transform.position.y, z: transform.position.z, progress: fall, simulationTime: time });
        }
      } else if (e.type === 'collapse' && age <= 1.6) {
        for (let i = 0; i < 5; i++) {
          const a = i * Math.PI * 2 / 5, t = age / 1.6, r = t * 2.4, scale = (1 - t) * .8;
          transform.position.set(e.x + Math.sin(a) * r, ground(e, { ...e, height: .5 }, 'collapse') + Math.sin(t * Math.PI), e.z + Math.cos(a) * r); transform.rotation.set(t, a, t); transform.scale.setScalar(scale); add('impacts', '#d2b58e');
        }
      } else if (e.type === 'retreat' && age <= 1.2) {
        const size = 1.8 + age * 2;
        transform.position.set(e.x, ground(e, { ...e, height: .06 }, 'retreat'), e.z); transform.rotation.set(-Math.PI / 2, 0, 0); transform.scale.setScalar(size); add('retreats', '#f4c58b');
      }
    }
    for (const p of pools.values()) {
      p.mesh.count = p.count; p.mesh.visible = p.count > 0;
      if (!p.count) continue;
      diagnostics.drawCallsEstimate++;
      for (const attribute of [p.mesh.instanceMatrix, p.mesh.instanceColor]) { attribute.clearUpdateRanges(); attribute.addUpdateRange(0, p.count * attribute.itemSize); attribute.needsUpdate = true; }
    }
    // Every cached point belongs to a bounded short-lived event. Resetting at
    // this conservative bound avoids growth through an arbitrarily long world.
    if (groundCache.size > 32768) groundCache.clear();
  }
  function dispose() {
    if (disposed) return; disposed = true;
    for (const p of pools.values()) { p.geometry.dispose(); p.mesh.dispose(); }
    for (const material of [projectileMaterial, impactMaterial, casualtyMaterial, retreatMaterial]) material.dispose();
    pools.clear(); groundCache.clear(); colorCache.clear(); root.removeFromParent(); samples = [];
  }
  return { update, dispose, diagnostics, getMotionSamples: () => samples.map(s => ({ ...s })) };
}
