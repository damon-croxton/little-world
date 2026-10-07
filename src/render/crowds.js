import { heightAt } from '../world.js';
import { observedGroupController } from '../selection.js';
import { settlementController } from '../sim/control.js';
import { createWorkerBadges } from './worker-badges.js';

// Military have individual bodies; home civilians are represented by housing. An active resource crew
// has one worker body and a count badge; its full census remains represented.
// All motion is a function of the supplied SIMULATION time and interpolation
// alpha. Rendering neither advances simulation nor consumes its seeded RNG.
const TAU = Math.PI * 2;
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const mix = (a, b, t) => a + (b - a) * t;
const finite = (x, fallback = 0) => Number.isFinite(x) ? x : fallback;
const countOf = x => Math.max(0, Math.floor(finite(x)));
function hash(text) { let n = 2166136261; for (const c of String(text)) n = Math.imul(n ^ c.charCodeAt(0), 16777619); return n >>> 0; }
function noise(n) { n = Math.imul(n ^ n >>> 16, 0x45d9f3b); n = Math.imul(n ^ n >>> 16, 0x45d9f3b); return ((n ^ n >>> 16) >>> 0) / 4294967296; }
function angleMix(a, b, t) { return a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t; }
// Main and faction views provide a flat allowlisted projection. Raw simulation
// tests can read the canonical home ledgers, but a faction view never can.
function visibleSoldiers(state) { return Array.isArray(state.soldiers) ? state.soldiers : state.viewer?.mode === 'faction' ? [] : state.settlements.flatMap(home => home.soldierRoster || []); }

export function createCrowds(THREE, scene) {
  const root = new THREE.Group(); root.name = 'Population - individuals and counted worker crews'; scene.add(root);
  const workerBadges = createWorkerBadges(THREE, root);
  const templates = new Map(), pools = new Map(), homeLayouts = new Map(), groupViews = new Map(), heights = new Map();
  const soldierViews = new Map();
  const selectionGeometry = new THREE.RingGeometry(.43, .59, 24), selectionMaterial = new THREE.MeshBasicMaterial({ color: '#fff0b8', transparent: true, opacity: .8, depthWrite: false, side: THREE.DoubleSide });
  const soldierSelection = new THREE.Mesh(selectionGeometry, selectionMaterial); soldierSelection.name = 'Selected soldier'; soldierSelection.rotation.x = -Math.PI / 2; soldierSelection.visible = false; root.add(soldierSelection);
  const transform = new THREE.Object3D(), point = new THREE.Vector3(), sphere = new THREE.Sphere(), frustum = new THREE.Frustum(), clip = new THREE.Matrix4();
  const colorCache = new Map();
  const timeUniform = { value: 0 };
  let seed = null, lastState = null, lastWorld = null, disposed = false, pickables = [], samples = [], hasCamera = false;
  let lastFrame = null;
  const priorClip = new THREE.Matrix4();
  let nodeIndex = new Map();
  let soldierFrame = 0, factionIndex = new Map();
  const diagnostics = {};

  // Composite, genuinely three-dimensional silhouettes are baked once. A
  // single indexed/instanced draw carries torso, head, legs, equipment and load.
  function miniature(species, lod) {
    const detailed = lod === 'detailed', overview = lod === 'overview';
    const key = species + ':' + lod;
    if (templates.has(key)) return templates.get(key);
    const out = { p: [], n: [], c: [], part: [], tint: [], indices: [] };
    const mat = new THREE.Matrix4(), normalMat = new THREE.Matrix3(), v = new THREE.Vector3(), n = new THREE.Vector3(), tint = new THREE.Color();
    function add(g, position, scale, color, part = 0, faction = 0, rotation = [0, 0, 0]) {
      transform.position.set(...position); transform.scale.set(...scale); transform.rotation.set(...rotation); transform.updateMatrix(); mat.copy(transform.matrix); normalMat.getNormalMatrix(mat); tint.set(color);
      const p = g.attributes.position, normals = g.attributes.normal, offset = out.p.length / 3;
      // Preserve each primitive's index buffer instead of expanding repeated
      // vertices. Per-part normal/color/animation boundaries stay separate.
      for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(mat); n.fromBufferAttribute(normals, i).applyNormalMatrix(normalMat); out.p.push(v.x, v.y, v.z); out.n.push(n.x, n.y, n.z); out.c.push(tint.r, tint.g, tint.b); out.part.push(part); out.tint.push(faction); }
      for (let i = 0, total = g.index ? g.index.count : p.count; i < total; i++) out.indices.push(offset + (g.index ? g.index.getX(i) : i));
      g.dispose();
    }
    const box = (p, s, c, part = 0, f = 0, r) => add(new THREE.BoxGeometry(1, 1, 1), p, s, c, part, f, r);
    const ellipsoid = (p, s, c, part = 0, f = 0) => add(new THREE.SphereGeometry(1, detailed ? 8 : 5, detailed ? 5 : 3), p, s, c, part, f);
    const cylinder = (p, s, c, part = 0, f = 0, r = [0, 0, 0], top = 1) => add(new THREE.CylinderGeometry(top, 1, 1, detailed ? 7 : 5), p, s, c, part, f, r);
    if (overview) {
      // At overview distance a body is roughly 2–5 screen pixels high. Keep
      // articulated limbs, head/body and cargo on every submitted body, but
      // do not rasterize hundreds of subpixel detail faces.
      const gem = (p, s, c, part = 0, f = 0) => add(new THREE.OctahedronGeometry(1), p, s, c, part, f);
      const limb = (p, s, c, part = 0, f = 0, rotation = [0, 0, 0]) => add(new THREE.CylinderGeometry(1, 1, 1, 3, 1, true), p, s, c, part, f, rotation);
      if (species === 'human') {
        for (const side of [-1, 1]) {
          limb([side * .09, .17, 0], [.075, .31, .085], '#3e4e53', side < 0 ? 1 : 2);
          limb([side * .19, .45, .01], [.055, .29, .065], '#c4c0a2', side < 0 ? 3 : 4, .82);
        }
        box([0, .45, 0], [.29, .30, .22], '#d6d4b8', 0, .85);
        gem([0, .69, .01], [.135, .145, .12], '#e5bb94');
        gem([0, .79, 0], [.18, .047, .16], '#ebe1bf', 0, .34);
        limb([.24, .45, .13], [.029, .48, .029], '#b5c6bf', 5);
        box([0, .49, .29], [.29, .26, .25], '#b39562', 6);
        limb([.235, .46, .12], [.036, .49, .036], '#384950', 7, 0, [Math.PI / 2, 0, 0]);
      } else if (species === 'machine') {
        for (let i = 0; i < 4; i++) {
          const sx = i % 2 ? 1 : -1, sz = i < 2 ? -1 : 1;
          limb([sx * .23, .17, sz * .17], [.09, .30, .10], '#6e817e', i % 2 + 1, 0, [sz * .22, 0, sx * -.25]);
        }
        box([0, .32, 0], [.42, .21, .45], '#aeb6a0', 0, .84);
        gem([0, .48, 0], [.27, .16, .25], '#d9cbaa', 0, .8);
        box([0, .42, .236], [.27, .07, .033], '#a3f1e7');
        limb([.09, .64, -.05], [.033, .29, .033], '#ddfbc5');
        limb([.23, .40, .24], [.04, .40, .04], '#e9b77a', 5, 0, [.85, 0, 0]);
        box([0, .65, 0], [.38, .21, .33], '#b58f64', 6);
        limb([0, .55, .30], [.065, .49, .065], '#41565b', 7, 0, [Math.PI / 2, 0, 0]);
      } else {
        for (let i = 0; i < 6; i++) {
          const sx = i % 2 ? 1 : -1, z = (Math.floor(i / 2) - 1) * .17;
          limb([sx * .22, .17, z], [.035, .42, .035], '#8ea59e', i % 2 + 1, .45, [0, 0, sx * .94]);
        }
        gem([0, .32, -.14], [.25, .20, .32], '#afc9be', 0, .9);
        gem([0, .40, .10], [.17, .23, .19], '#c0d8bb', 0, .78);
        gem([0, .55, .22], [.17, .12, .13], '#dbe7b7', 0, .7);
        for (const sx of [-1, 1]) {
          limb([sx * .11, .68, .22], [.018, .24, .018], '#d8d5ac', 0, .18, [0, 0, sx * -.4]);
          limb([sx * .20, .39, .22], [.032, .29, .032], '#b5d2be', sx < 0 ? 3 : 4, .7, [.7, 0, sx * -.3]);
        }
        limb([.22, .26, .36], [.045, .33, .035], '#e4d8b2', 5);
        gem([0, .54, -.17], [.25, .18, .23], '#dcb27d', 6, .15);
        limb([.19, .44, .36], [.055, .37, .055], '#d4ded0', 7, .65, [Math.PI / 2, 0, 0]);
      }
    } else if (species === 'human') {
      // Boots, trousers, coat, a face under a brim, backpack and working arms.
      for (const side of [-1, 1]) {
        box([side * .09, .18, 0], [.11, .29, .12], '#3e4e53', side < 0 ? 1 : 2);
        box([side * .09, .045, .035], [.135, .085, .19], '#29353a', side < 0 ? 1 : 2);
        box([side * .19, .455, .005], [.085, .26, .10], '#c4c0a2', side < 0 ? 3 : 4, .82, [0, 0, side * .11]);
        if (detailed) ellipsoid([side * .20, .33, .01], [.05, .045, .05], '#d7ae88', side < 0 ? 3 : 4);
      }
      cylinder([0, .45, 0], [.16, .29, .12], '#d6d4b8', 0, .85, [0, 0, 0], .85);
      box([0, .45, -.125], [.20, .21, .095], '#696c52');
      ellipsoid([0, .695, .01], [.12, .135, .11], '#e5bb94');
      cylinder([0, .784, 0], [.144, .055, .14], '#ebe1bf', 0, .34);
      if (detailed) { box([0, .786, .07], [.30, .025, .19], '#ddcca3', 0, .3); box([0, .70, .112], [.09, .024, .012], '#394954'); box([0, .50, .13], [.09, .13, .025], '#eee6c7'); }
      // Tool and transport load collapse in the vertex shader when unused.
      cylinder([.245, .42, .11], [.018, .50, .018], '#807153', 5, 0, [.34, 0, -.1]);
      box([.245, .67, .17], [.23, .055, .07], '#c3d5d4', 5);
      box([0, .49, .29], [.29, .26, .25], '#b39562', 6);
      if (detailed) { box([0, .50, .42], [.035, .26, .012], '#dfd5a6', 6); box([0, .59, .29], [.29, .025, .25], '#dcc999', 6); }
      // A rifle/pole distinguishes a squad from unarmed workers.
      box([.235, .46, .12], [.045, .055, .49], '#384950', 7);
      if (detailed) box([.235, .46, -.07], [.065, .085, .15], '#79634c', 7);
    } else if (species === 'machine') {
      // Four articulated feet under a slung salvage chassis, a sensor mast and
      // warm optical bar; this reads as a small industrial machine, not a cube.
      for (let i = 0; i < 4; i++) {
        const sx = i % 2 ? 1 : -1, sz = i < 2 ? -1 : 1, part = (i % 2) + 1;
        box([sx * .22, .17, sz * .16], [.09, .27, .08], '#6e817e', part, 0, [sz * .22, 0, sx * -.22]);
        box([sx * .25, .05, sz * .18], [.18, .09, .22], '#35484a', part);
        if (detailed) ellipsoid([sx * .18, .31, sz * .13], [.075, .065, .065], '#ddc18e', part);
      }
      box([0, .32, 0], [.40, .20, .43], '#aeb6a0', 0, .84);
      cylinder([0, .44, 0], [.21, .14, .22], '#d9cbaa', 0, .8, [0, .3, 0], .73);
      box([0, .42, .226], [.25, .06, .035], '#a3f1e7');
      cylinder([.09, .62, -.05], [.019, .26, .019], '#bfc9ad');
      ellipsoid([.09, .75, -.05], [.055, .035, .055], '#ddfbc5');
      if (detailed) { box([0, .55, -.1], [.17, .075, .17], '#526c6b'); for (const sx of [-1, 1]) cylinder([sx * .22, .39, -.03], [.045, .31, .045], '#889c9a', 0, 0, [Math.PI / 2, 0, 0]); }
      cylinder([.23, .42, .22], [.035, .40, .035], '#b3c7c2', 5, 0, [.85, 0, 0]);
      cylinder([.23, .30, .4], [.08, .13, .08], '#e9b77a', 5, .3, [.8, 0, 0], .4);
      box([0, .65, 0], [.38, .21, .33], '#b58f64', 6);
      box([0, .55, .30], [.10, .10, .49], '#41565b', 7);
    } else {
      // Six splayed legs, segmented abdomen, mantis forearms and antennae.
      for (let i = 0; i < 6; i++) {
        const sx = i % 2 ? 1 : -1, z = (Math.floor(i / 2) - 1) * .17, part = (i % 2) + 1;
        cylinder([sx * .21, .18, z], [.029, .32, .029], '#718c91', part, .55, [0, 0, sx * .94]);
        cylinder([sx * .32, .07, z + .03], [.022, .19, .022], '#acbba3', part, .18, [.3, 0, sx * -.3]);
      }
      ellipsoid([0, .32, -.14], [.22, .17, .29], '#afc9be', 0, .9);
      ellipsoid([0, .38, .10], [.145, .20, .17], '#c0d8bb', 0, .78);
      ellipsoid([0, .54, .21], [.145, .10, .11], '#b9d6bd', 0, .7);
      for (const sx of [-1, 1]) {
        ellipsoid([sx * .10, .55, .282], [.04, .035, .022], '#eff3b7');
        cylinder([sx * .11, .68, .22], [.013, .24, .013], '#d8d5ac', 0, .18, [0, 0, sx * -.4]);
        cylinder([sx * .20, .39, .22], [.025, .29, .025], '#b5d2be', sx < 0 ? 3 : 4, .7, [.7, 0, sx * -.3]);
      }
      if (detailed) for (const z of [-.27, -.12, .03]) box([0, .455, z], [.27, .025, .018], '#617e87', 0, .6);
      ellipsoid([.22, .24, .36], [.045, .19, .035], '#e4d8b2', 5, 0);
      ellipsoid([0, .54, -.17], [.24, .16, .22], '#dcb27d', 6, .15);
      cylinder([.19, .44, .36], [.055, .37, .055], '#d4ded0', 7, .65, [Math.PI / 2, 0, 0], .3);
    }
    // Original role silhouettes share an instanced species template. Infantry
    // carry broad guards/braces; ranged ranks have a distinct high quill/coil.
    if (species === 'human') {
      box([-.24, .47, .12], [.09, .36, .29], '#d9caa0', 8, .85);
      box([.235, .48, .28], [.31, .045, .045], '#c5aa75', 9, .2);
    } else if (species === 'machine') {
      box([0, .40, .31], [.48, .20, .09], '#bec6b5', 8, .9);
      add(new THREE.OctahedronGeometry(1), [0, .67, .12], [.14, .21, .16], '#acf2f4', 9, .35);
    } else {
      box([0, .47, .30], [.36, .10, .12], '#c4d5ae', 8, .8);
      add(new THREE.ConeGeometry(.16, .42, overview ? 3 : 5), [0, .68, -.15], [1, 1, 1], '#e8d5a7', 9, .5);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(out.p, 3)); geometry.setAttribute('normal', new THREE.Float32BufferAttribute(out.n, 3)); geometry.setAttribute('color', new THREE.Float32BufferAttribute(out.c, 3));
    geometry.setAttribute('crowdPart', new THREE.Float32BufferAttribute(out.part, 1)); geometry.setAttribute('crowdTint', new THREE.Float32BufferAttribute(out.tint, 1)); geometry.setIndex(out.indices); geometry.computeBoundingSphere();
    templates.set(key, geometry); return geometry;
  }

  const declarations = `uniform float crowdTime; attribute vec4 crowdMotion; attribute vec4 crowdBattle; attribute float crowdRole; attribute float crowdPart; attribute float crowdTint;`;
  const animate = `
    float crowdBeat = crowdTime * 8.4 + crowdMotion.x;
    float attackAge = crowdTime - crowdBattle.x;
    float hitAge = crowdTime - crowdBattle.y;
    float attackPulse = float(attackAge >= 0.0) * max(0.0, 1.0 - attackAge / 0.38);
    float hitPulse = float(hitAge >= 0.0) * max(0.0, 1.0 - hitAge / 0.30);
    float isRanged = float(crowdRole > 6.5 && crowdRole < 7.5);
    transformed.z += attackPulse * mix(0.16, -0.075, isRanged) - hitPulse * 0.095;
    transformed.y -= hitPulse * 0.035;
    float crowdWalk = crowdMotion.y;
    float crowdWork = crowdMotion.z;
    float crowdBob = (0.5 + 0.5 * sin(crowdBeat * 2.0)) * 0.025 * crowdWalk;
    transformed.y += crowdBob;
    if (crowdPart > 0.5 && crowdPart < 2.5) {
      float side = crowdPart < 1.5 ? 1.0 : -1.0;
      float weight = clamp((0.36 - transformed.y) / 0.33, 0.0, 1.0);
      transformed.z += sin(crowdBeat) * side * 0.125 * crowdWalk * weight;
      transformed.y += max(0.0, sin(crowdBeat) * side) * 0.072 * crowdWalk * weight;
    }
    if (crowdPart > 2.5 && crowdPart < 4.5) {
      float side = crowdPart < 3.5 ? -1.0 : 1.0;
      float weight = clamp((0.60 - transformed.y) / 0.25, 0.0, 1.0);
      transformed.z += sin(crowdBeat) * side * 0.115 * crowdWalk * weight;
      transformed.z += crowdWork * (0.09 + 0.08 * sin(crowdBeat * 0.73)) * weight;
      transformed.y += crowdWork * sin(crowdBeat * 0.73) * 0.09 * weight;
    }
    if (crowdPart > 4.5 && crowdPart < 5.5) {
      float toolVisible = float(crowdRole > 0.5 && crowdRole < 1.5) * max(crowdWork, 0.55);
      transformed = vec3(0.23, 0.4, 0.12) + (transformed - vec3(0.23, 0.4, 0.12)) * toolVisible;
      transformed.y += crowdWork * sin(crowdBeat * 0.73) * 0.17;
      transformed.z += crowdWork * (0.12 + cos(crowdBeat * 0.73) * 0.08);
    }
    if (crowdPart > 5.5 && crowdPart < 6.5) {
      transformed = vec3(0.0, 0.45, 0.0) + (transformed - vec3(0.0, 0.45, 0.0)) * min(1.0, crowdMotion.w * 2.5);
    }
    if (crowdPart > 6.5 && crowdPart < 7.5) {
      float armed = max(float(crowdRole > 1.5 && crowdRole < 3.5), isRanged);
      if (crowdRole > 1.5 && crowdRole < 2.5) {
        vec3 local = transformed - vec3(0.235, 0.46, 0.12);
        transformed = vec3(0.235, 0.46, 0.12) + vec3(local.x, local.z, -local.y);
      }
      transformed = vec3(0.2, 0.4, 0.1) + (transformed - vec3(0.2, 0.4, 0.1)) * armed;
      transformed.z += attackPulse * 0.12;
    }
    if (crowdPart > 7.5 && crowdPart < 8.5) {
      transformed = vec3(0.0, 0.45, 0.1) + (transformed - vec3(0.0, 0.45, 0.1)) * float(crowdRole > 1.5 && crowdRole < 2.5);
    }
    if (crowdPart > 8.5 && crowdPart < 9.5) {
      transformed = vec3(0.0, 0.45, 0.1) + (transformed - vec3(0.0, 0.45, 0.1)) * isRanged;
    }
  `;
  function patchShader(shader, tint = true) {
    shader.uniforms.crowdTime = timeUniform;
    shader.vertexShader = declarations + '\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n' + animate);
    if (tint) shader.vertexShader = shader.vertexShader.replace('#include <color_vertex>', `
      #if defined( USE_COLOR_ALPHA )
        vColor = vec4( 1.0 );
      #elif defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
        vColor = vec3( 1.0 );
      #endif
      #ifdef USE_COLOR
        vColor *= color;
      #endif
      #ifdef USE_INSTANCING_COLOR
        vColor.xyz *= mix(vec3(1.0), instanceColor.xyz, crowdTint);
      #endif
    `);
  }
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .83, metalness: .12 });
  material.onBeforeCompile = shader => patchShader(shader); material.customProgramCacheKey = () => 'littleworld-v2-actual-crowds-4';
  const depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }); depthMaterial.onBeforeCompile = shader => patchShader(shader, false); depthMaterial.customProgramCacheKey = () => 'littleworld-v2-crowd-depth-4';
  const pickGeometry = new THREE.SphereGeometry(1, 8, 5), pickMaterial = new THREE.MeshBasicMaterial({ visible: false });
  const bodyPickSphere = new THREE.Sphere(), bodyPickPoint = new THREE.Vector3();

  function poolFor(species, lod, x, z) {
    const key = `${species}:${lod}:${Math.floor(x / 56)}:${Math.floor(z / 56)}`;
    if (!pools.has(key)) {
      const base = miniature(species, lod), geometry = new THREE.BufferGeometry();
      geometry.setIndex(base.index);
      for (const [name, attr] of Object.entries(base.attributes)) geometry.setAttribute(name, attr);
      const pool = { key, geometry, count: 0, capacity: 0, mesh: null, selectionIds: [], detailed: lod === 'detailed', usedFrame: 0 };
      pools.set(key, pool); grow(pool, 64);
    }
    return pools.get(key);
  }
  function grow(pool, requested) {
    let capacity = Math.max(64, pool.capacity); while (capacity < requested) capacity *= 2;
    const old = pool.mesh, motion = new Float32Array(capacity * 4), roles = new Float32Array(capacity), battle = new Float32Array(capacity * 4);
    if (old) { motion.set(pool.geometry.attributes.crowdMotion.array); roles.set(pool.geometry.attributes.crowdRole.array); battle.set(pool.geometry.attributes.crowdBattle.array); }
    pool.geometry.setAttribute('crowdMotion', new THREE.InstancedBufferAttribute(motion, 4).setUsage(THREE.DynamicDrawUsage));
    pool.geometry.setAttribute('crowdRole', new THREE.InstancedBufferAttribute(roles, 1).setUsage(THREE.DynamicDrawUsage));
    pool.geometry.setAttribute('crowdBattle', new THREE.InstancedBufferAttribute(battle, 4).setUsage(THREE.DynamicDrawUsage));
    const mesh = new THREE.InstancedMesh(pool.geometry, material, capacity); mesh.name = `Individuals ${pool.key}`; mesh.count = 0; mesh.frustumCulled = false; mesh.castShadow = pool.detailed; mesh.receiveShadow = true; mesh.customDepthMaterial = depthMaterial; mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.userData.crowdSelectionIds = pool.selectionIds;
    // A small body-sized target also catches animated limbs without raycasting
    // every crowd triangle. Only this frame's visible instances are selectable.
    mesh.raycast = function(raycaster,hits){
      if(!this.visible)return;
      const matrices=this.instanceMatrix.array;
      for(let i=0;i<this.count;i++){
        const offset=i*16,scale=matrices[offset+5];
        bodyPickSphere.center.set(matrices[offset+12],matrices[offset+13]+.45*scale,matrices[offset+14]).applyMatrix4(this.matrixWorld);
        bodyPickSphere.radius=.55*scale;
        if(!raycaster.ray.intersectSphere(bodyPickSphere,bodyPickPoint))continue;
        const distance=raycaster.ray.origin.distanceTo(bodyPickPoint);
        if(distance>=raycaster.near&&distance<=raycaster.far)hits.push({distance,point:bodyPickPoint.clone(),object:this,instanceId:i});
      }
    };
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
    if (old) { mesh.instanceMatrix.array.set(old.instanceMatrix.array); mesh.instanceColor.array.set(old.instanceColor.array); old.removeFromParent(); old.dispose(); }
    root.add(mesh); pool.mesh = mesh; pool.capacity = capacity;
  }

  // Bounded terrain work: persistent, bilinear 1.5-unit ground cache. Moving
  // ten thousand bodies never invokes ten thousand noise queries every frame.
  const GRID = 1.5;
  function groundCorner(ix, iz) { const key = (ix + 8192) * 16384 + iz + 8192; if (!heights.has(key)) heights.set(key, heightAt(ix * GRID, iz * GRID, seed)); return heights.get(key); }
  function ground(x, z) { const gx = x / GRID, gz = z / GRID, ix = Math.floor(gx), iz = Math.floor(gz); return mix(mix(groundCorner(ix, iz), groundCorner(ix + 1, iz), gx - ix), mix(groundCorner(ix, iz + 1), groundCorner(ix + 1, iz + 1), gx - ix), gz - iz); }
  function colorFor(faction) { const key = faction.color || '#b7cabd'; if (!colorCache.has(key)) { const c = new THREE.Color(key); c.lerp(new THREE.Color('#f0e5ca'), .12); colorCache.set(key, c); } return colorCache.get(key); }
  function emitIndividual(record, faction, camera, collect = false) {
    const { x, z, yaw, walk, work, cargo, phase, role, id } = record;
    const representedCount = record.representedCount || 1, workerCrew = record.kind === 'worker';
    const y = ground(x, z) + .035 + (record.elevation || 0), distanceSq = camera ? (camera.position.x - x) ** 2 + (camera.position.y - y) ** 2 + (camera.position.z - z) ** 2 : 0;
    const detailed = !camera || distanceSq < 95 ** 2;
    const lod = detailed ? 'detailed' : distanceSq < 180 ** 2 ? 'simplified' : 'overview';
    // A slightly clearer silhouette at overview makes the one worker body
    // recognizable under its screen-sized count badge without changing people.
    const scale = (record.scale || 1) * (workerCrew ? detailed ? 1.3 : lod === 'simplified' ? 2.0 : 2.8 : 1);
    point.set(x, y + .40 * scale, z); sphere.center.copy(point); sphere.radius = .8 * scale;
    const visible = !hasCamera || frustum.intersectsSphere(sphere);
    let meshUuid = null, instanceIndex = null, poolKey = null;
    diagnostics.representedIndividuals += representedCount;
    if (record.militaryRole) diagnostics.militaryIndividuals++;
    if (workerCrew) diagnostics.representedWorkerIndividuals += representedCount;
    if (!visible) diagnostics.culledIndividuals += representedCount;
    else {
      const pool = poolFor(faction.species || 'human', lod, x, z), index = pool.count++;
      if (index >= pool.capacity) grow(pool, index + 1);
      pool.selectionIds[index] = record.soldierId || record.groupId || record.settlementId;
      if (collect) { meshUuid = pool.mesh.uuid; instanceIndex = index; poolKey = pool.key; }
      // All crowd transforms are yaw + uniform scale. Write the affine matrix
      // directly instead of composing an Object3D/quaternion for every body.
      const m = pool.mesh.instanceMatrix.array, offset = index * 16, sn = Math.sin(yaw) * scale, cs = Math.cos(yaw) * scale;
      m[offset] = cs; m[offset + 1] = 0; m[offset + 2] = -sn; m[offset + 3] = 0;
      m[offset + 4] = 0; m[offset + 5] = scale; m[offset + 6] = 0; m[offset + 7] = 0;
      m[offset + 8] = sn; m[offset + 9] = 0; m[offset + 10] = cs; m[offset + 11] = 0;
      m[offset + 12] = x; m[offset + 13] = y; m[offset + 14] = z; m[offset + 15] = 1;
      pool.mesh.setColorAt(index, colorFor(faction));
      pool.geometry.attributes.crowdMotion.setXYZW(index, phase, walk, work, cargo); pool.geometry.attributes.crowdRole.setX(index, role); pool.geometry.attributes.crowdBattle.setXYZW(index, record.attackTime ?? -1000, record.hitTime ?? -1000, 0, 0);
      diagnostics.visibleIndividuals += representedCount; if (record.groupId) diagnostics.groupVisibleIndividuals += representedCount; else diagnostics.homeVisibleIndividuals += representedCount;
      if (record.militaryRole) diagnostics.visibleMilitaryIndividuals++;
      if (workerCrew) {
        diagnostics.visibleWorkerIndividuals += representedCount; diagnostics.visibleWorkerCrews++; diagnostics.drawnWorkerModels++;
        workerBadges.add({ groupId: record.groupId, size: representedCount, x, y: y + .97 * scale, z, color: colorFor(faction), lod, selected: record.selected });
      }
      if (detailed) diagnostics.detailedIndividuals += representedCount; else { diagnostics.simplifiedIndividuals += representedCount; if (lod === 'overview') diagnostics.overviewIndividuals += representedCount; }
    }
    if (record.soldierId && record.selected) { soldierSelection.visible = visible; soldierSelection.position.set(x, y + .025, z); }
    if (collect && (samples.length < 256 || record.soldierId && record.selected)) {
      const beat = timeUniform.value * 8.4 + phase, bob = (.5 + .5 * Math.sin(beat * 2)) * .025 * walk;
      // These offsets mirror the GPU vertex deformation, allowing QA to sample
      // working limbs even when a miner correctly remains at one worksite.
      const toolDy = work * Math.sin(beat * .73) * .17 * scale, toolDz = work * (.12 + Math.cos(beat * .73) * .08) * scale;
      samples.push({ id, soldierId: record.soldierId || null, meshUuid, instanceIndex, poolKey, groundY: y, groupId: record.groupId || null, settlementId: record.settlementId || null, kind: record.kind, phase: record.action, representedCount, crewSize: record.crewSize || 1, badgeText: workerCrew ? `${representedCount}×` : null, scale, x, y: y + bob * scale, z, heading: yaw, role, militaryRole: record.militaryRole || null, attackTime: record.attackTime ?? -1000, hitTime: record.hitTime ?? -1000, attacking: Math.max(0, 1 - (timeUniform.value - (record.attackTime ?? -1000)) / .38) * Number(timeUniform.value >= (record.attackTime ?? -1000)), walking: walk, working: work, carrying: cargo, visible, lod, animationPhase: beat, leftFootZ: Math.sin(beat) * .125 * walk * scale, toolMotion: { x: Math.sin(yaw) * toolDz, y: toolDy, z: Math.cos(yaw) * toolDz }, simulationTime: timeUniform.value });
    }
  }

  function renderSoldier(soldier, faction, camera, alpha, selectedId, collect = false) {
    if (soldier.positioned === false || !Number.isFinite(soldier.x) || !Number.isFinite(soldier.z)) { diagnostics.unpositionedSoldiers++; return; }
    let body = soldierViews.get(soldier.id);
    if (!body) { const h = noise(hash(soldier.id)); body = { id: soldier.id, soldierId: soldier.id, phase: h * TAU, scale: .97 + h * .08, cargo: 0, work: 0 }; soldierViews.set(soldier.id, body); }
    body.seenFrame = soldierFrame; body.groupId = soldier.groupId || null; body.settlementId = soldier.groupId ? null : soldier.originId || null;
    body.kind = soldier.groupId ? 'army' : 'home'; body.action = soldier.action || (soldier.towerId ? 'tower-crew' : soldier.groupId ? 'serving' : 'garrison');
    body.x = mix(finite(soldier.prevX, soldier.x), soldier.x, alpha); body.z = mix(finite(soldier.prevZ, soldier.z), soldier.z, alpha);
    body.yaw = angleMix(finite(soldier.prevYaw, finite(soldier.yaw)), finite(soldier.yaw), alpha);
    body.walk = Math.hypot(soldier.x - finite(soldier.prevX, soldier.x), soldier.z - finite(soldier.prevZ, soldier.z)) > .001 ? 1 : 0;
    body.militaryRole = soldier.role; body.role = soldier.role === 'ranged' ? 7 : 2; body.attackTime = soldier.lastAttackTime ?? -1000; body.hitTime = soldier.lastHitTime ?? -1000;
    body.elevation = soldier.elevation || 0; body.selected = selectedId === soldier.id;
    const native = factionIndex.get(soldier.nativeFactionId || soldier.factionId) || faction, commander = factionIndex.get(soldier.commandFactionId || soldier.controllerId);
    const appearance = { species: soldier.species || native?.species || 'human', color: faction?.color || commander?.color || native?.color };
    emitIndividual(body, appearance, camera, collect || body.selected);
  }

  function renderHome(s, faction, deployed, time, camera, alpha = 1, militaryFaction = faction, roster = [], selectedId) {
    const present = Math.max(0, countOf(s.population) - deployed);
    const residents = Math.max(0, present - roster.length);
    diagnostics.homePresentBySettlement[s.id] = present; diagnostics.homePresentIndividuals += present;
    // Local residents/jobs remain real census and labour, represented by the
    // settlement's housing. They have no independent movement or collision.
    diagnostics.housedIndividuals += residents;
    diagnostics.representedIndividuals += residents;
    for (let i = 0; i < roster.length; i++) renderSoldier(roster[i], militaryFaction, camera, alpha, selectedId, i < 3);
  }

  function renderGroup(g, faction, state, time, alpha, camera, selectedId, roster = []) {
    if (g.kind === 'army') {
      diagnostics.groupIndividuals += roster.length; diagnostics.armyIndividuals += roster.length;
      // A broad party proxy would intercept the exact body's hit. The soldier
      // inspector retains navigation back to its party and civilisation.
      for (let i = 0; i < roster.length; i++) renderSoldier(roster[i], faction, camera, alpha, selectedId, i < 3 || g.id === selectedId && i < 6 || roster[i].role !== roster[i - 1]?.role);
      return;
    }
    const size = countOf(g.size); if (!size) return;
    const x = mix(finite(g.prevX, g.x), finite(g.x), alpha), z = mix(finite(g.prevZ, g.z), finite(g.z), alpha);
    let view = groupViews.get(g.id);
    const desiredYaw = Math.atan2(finite(g.x) - finite(g.prevX, g.x), finite(g.z) - finite(g.prevZ, g.z));
    const moved = Math.hypot(finite(g.x) - finite(g.prevX, g.x), finite(g.z) - finite(g.prevZ, g.z)) > .00001;
    if (!view) {
      const proxy = new THREE.Mesh(pickGeometry, pickMaterial); proxy.userData.groupId = g.id; proxy.name = `Select ${g.kind} ${g.id}`; root.add(proxy);
      const yaw = moved ? desiredYaw : Math.atan2(finite(g.targetX, x) - x, finite(g.targetZ, z) - z);
      view = { proxy, yaw, previousYaw: yaw, step: state.step ?? state.tick, phase: g.phase, phaseStart: time - 1, previousWorking: 0, people: [] }; groupViews.set(g.id, view);
    }
    if (view.step !== (state.step ?? state.tick)) { view.previousYaw = view.yaw; if (moved) view.yaw = desiredYaw; view.step = state.step ?? state.tick; }
    if (view.phase !== g.phase) { view.previousWorking = ['working', 'gathering'].includes(view.phase) ? 1 : 0; view.phase = g.phase; view.phaseStart = finite(state.time, time); }
    const yaw = angleMix(view.previousYaw, view.yaw, alpha), sin = Math.sin(yaw), cos = Math.cos(yaw), isWorker = g.kind === 'worker', isWorking = ['working', 'gathering'].includes(g.phase);
    const workBlend = mix(view.previousWorking, isWorking ? 1 : 0, clamp((time - view.phaseStart) / .65));
    const cols = g.kind === 'scout' ? Math.min(2, size) : Math.min(4, Math.ceil(Math.sqrt(size * .7)));
    const rows = Math.ceil(size / cols), spacing = .65;
    const node = isWorking ? nodeIndex.get(g.targetId) : null, siteRadius = Math.max(1.2, Math.min(4.5, finite(node?.radius, 2.0)));
    const cargoAmount = typeof g.carrying === 'object' ? Object.values(g.carrying).reduce((n, x) => n + finite(x), 0) : finite(g.carrying);
    const cargo = clamp(cargoAmount / Math.max(1, finite(g.capacity, size * 6))), phaseSeed = hash(g.id), role = ({ worker: 1, scout: 3, trader: 4, colonist: 5 })[g.kind] || 0;
    diagnostics.groupIndividuals += size; if (isWorker) { diagnostics.workerIndividuals += size; diagnostics.workerCrewCount++; }
    view.proxy.position.set(x, ground(x, z) + .5, z); view.proxy.scale.set(isWorker ? 1.5 : Math.max(1.1, cols * spacing * .65), 1.0, isWorker ? 1.5 : Math.max(1.1, rows * spacing * .65)); view.proxy.rotation.y = yaw; view.proxy.updateMatrixWorld(); pickables.push(view.proxy);
    const models = isWorker ? 1 : size;
    for (let i = 0; i < models; i++) {
      let person = view.people[i];
      if (!person) { const h = noise(phaseSeed + i * 67), phase = h * TAU; person = view.people[i] = { h, phase, body: { id: `group:${g.id}:${i}`, groupId: g.id, settlementId: null, phase, scale: .97 + h * .08 } }; }
      const { phase } = person, side = isWorker ? 0 : (i % cols - (cols - 1) / 2) * spacing, forward = isWorker ? 0 : (Math.floor(i / cols) - (rows - 1) / 2) * spacing;
      let ox = side * cos + forward * sin, oz = -side * sin + forward * cos, heading = yaw;
      if (workBlend > 0) {
        if (isWorker) {
          // Keep the representative on its authoritative group center so
          // selection/follow stays attached; face the actual resource target.
          heading = angleMix(yaw, Math.atan2(finite(node?.x, finite(g.targetX, x)) - x, finite(node?.z, finite(g.targetZ, z)) - z), workBlend);
        } else {
          const angle = (i * 2.399963229728653 + phaseSeed * .001) % TAU, radius = siteRadius * (.65 + .6 * Math.sqrt((i + .5) / size));
          ox = mix(ox, Math.sin(angle) * radius, workBlend); oz = mix(oz, Math.cos(angle) * radius, workBlend); heading = angleMix(yaw, angle + Math.PI, workBlend);
        }
      }
      const walk = moved ? 1 - workBlend : 0;
      const work = isWorking ? .95 : 0;
      const collect = i < 2 || g.id === selectedId && i < 6;
      const body = person.body;
      body.kind = g.kind; body.action = g.phase; body.x = x + ox; body.z = z + oz; body.yaw = heading; body.walk = walk; body.work = work; body.cargo = g.kind === 'trader' ? .75 : g.kind === 'colonist' ? .55 : cargo; body.role = role; body.militaryRole = null; body.attackTime = -1000; body.hitTime = -1000; body.representedCount = isWorker ? size : 1; body.crewSize = size; body.selected = g.id === selectedId;
      emitIndividual(body, faction, camera, collect);
    }
  }

  function stateDigest(state, roster) {
    // Normally step/time invalidate the frame. Also detect inspector/QA edits
    // during a pause: replacing or mutating a node, group, faction or building
    // must not reuse stale accounting or transforms at the same pulse.
    let soldiers = 2166136261;
    for (const person of roster) {
      soldiers = Math.imul(soldiers ^ hash(`${person.id}:${person.groupId}:${person.originId}:${person.role}:${person.species}:${person.commandFactionId}:${person.status}:${person.alive}:${person.positioned}`), 16777619);
      for (const value of [person.x, person.z, person.prevX, person.prevZ, person.yaw, person.prevYaw, person.elevation, person.lastAttackTime, person.lastHitTime]) soldiers = Math.imul(soldiers ^ Math.round(finite(value) * 1e6), 16777619);
    }
    return soldiers + ';' + state.factions.map(f => `${f.id}:${f.species}:${f.color}:${f.defeatedBy}`).join('|') + ';' +
      state.settlements.map(s => `${s.id}:${s.factionId}:${s.occupiedBy}:${s.controllerId}:${s.x}:${s.z}:${s.radius}:${s.population}:${s.soldiers}:${s.military?.infantry}:${s.military?.ranged}:${s.combat?.active}:${s.combat?.lastHitTime}:${s.assigned?.researchers}:${s.assigned?.construction}:${s.assigned?.infrastructure}:` + (s.buildings || []).map(b => `${b.id}:${b.kind}:${b.x}:${b.z}:${b.progress}`).join(',')).join('|') + ';' +
      state.groups.map(g => `${g.id}:${g.originId}:${g.factionId}:${g.commandFactionId}:${g.controllerId}:${g.kind}:${g.size}:${g.units?.infantry}:${g.units?.ranged}:${g.combat?.active}:${g.formationRevision}:${g.combat?.roleAttacks?.infantry?.time}:${g.combat?.roleAttacks?.ranged?.time}:${g.combat?.lastHitTime}:${g.finished}:${g.x}:${g.z}:${g.prevX}:${g.prevZ}:${g.targetX}:${g.targetZ}:${g.phase}:${typeof g.carrying === 'object' ? JSON.stringify(g.carrying) : g.carrying}:${g.capacity}:${g.targetId}`).join('|') + ';' +
      (state.nodes || []).map(n => `${n.id}:${n.x}:${n.z}:${n.radius}:${n.amount}`).join('|');
  }

  function update(state, time, selectedId, alpha = 1) {
    if (disposed) return;
    alpha = clamp(finite(alpha, 1)); time = finite(time, finite(state.time));
    const camera = scene.userData.crowdCamera || scene.userData.camera;
    hasCamera = !!camera; if (camera) { camera.updateMatrixWorld(); clip.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); frustum.setFromProjectionMatrix(clip); }
    const world = state.renderWorldId ?? state, suppliedSoldiers = visibleSoldiers(state), digest = stateDigest(state, suppliedSoldiers), quality = scene.userData.quality, badgeViewport = workerBadges.setViewport(scene.userData.crowdViewport);
    // Exact paused-frame reuse. A changed camera, selection, simulation pulse,
    // interpolation or seed invalidates it; active motion is never throttled.
    if (lastFrame && lastState === state && lastWorld === world && seed === state.seed && lastFrame.step === (state.step ?? state.tick) && lastFrame.time === time && lastFrame.alpha === alpha && lastFrame.selectedId === selectedId && lastFrame.camera === camera && lastFrame.digest === digest && lastFrame.quality === quality && lastFrame.badgeViewport === badgeViewport && (!camera || priorClip.equals(clip))) { diagnostics.reusedFrame = true; return; }
    lastFrame = { step: state.step ?? state.tick, time, alpha, selectedId, camera, digest, quality, badgeViewport }; priorClip.copy(clip);
    timeUniform.value = time; samples = []; pickables = []; workerBadges.begin(camera); soldierSelection.visible = false; soldierFrame++;
    // Observer snapshots change every pulse, but their terrain and layouts
    // belong to the same world. The opaque token also distinguishes a new run
    // with the same seed; raw simulation callers retain object-identity resets.
    if (seed !== state.seed || lastWorld !== world) { seed = state.seed; lastWorld = world; heights.clear(); homeLayouts.clear(); soldierViews.clear(); for (const view of groupViews.values()) view.proxy.removeFromParent(); groupViews.clear(); }
    lastState = state;
    for (const pool of pools.values()) { pool.count = 0; pool.selectionIds.length = 0; }
    Object.assign(diagnostics, { totalPopulation: 0, representedIndividuals: 0, visibleIndividuals: 0, culledIndividuals: 0, homePresentIndividuals: 0, housedIndividuals: 0, homeVisibleIndividuals: 0, groupIndividuals: 0, groupVisibleIndividuals: 0, workerIndividuals: 0, representedWorkerIndividuals: 0, visibleWorkerIndividuals: 0, workerCrewCount: 0, visibleWorkerCrews: 0, drawnWorkerModels: 0, workerBadgeCount: 0, workerBadgeCapacity: 0, workerBadgeDrawCalls: 0, militaryIndividuals: 0, visibleMilitaryIndividuals: 0, armyIndividuals: 0, groupCount: 0, instances: 0, drawnModels: 0, detailedIndividuals: 0, simplifiedIndividuals: 0, overviewIndividuals: 0, reusedFrame: false, drawCallsEstimate: 0, triangleEstimate: 0, allocatedInstances: 0, instanceAllocationUnfulfilled: 0, homePresentBySettlement: {}, populationAccountingDelta: 0, terrainCacheSamples: 0, occlusionCulling: false, unpositionedSoldiers: 0 });
    nodeIndex = new Map((state.nodes || []).map(n => [n.id, n]));
    const factions = new Map(state.factions.map(f => [f.id, f])), deployed = new Map(), liveGroups = new Set();
    factionIndex = factions;
    const soldiersByHome = new Map(), soldiersByGroup = new Map(), orphanSoldiers = [];
    const homeIds = new Set(state.settlements.map(home => home.id)), groupIds = new Set(state.groups.filter(group => !group.finished).map(group => group.id));
    for (const person of suppliedSoldiers) {
      if (person.alive === false || person.status === 'dead' || person.status === 'demobilized' || person.hp <= 0) continue;
      const index = person.groupId ? soldiersByGroup : soldiersByHome, id = person.groupId || person.originId;
      if (person.groupId ? !groupIds.has(id) : !homeIds.has(id)) { orphanSoldiers.push(person); continue; }
      if (!index.has(id)) index.set(id, []); index.get(id).push(person);
    }
    for (const g of state.groups) {
      const roster = g.kind === 'army' ? soldiersByGroup.get(g.id) || [] : null, size = roster ? roster.length : countOf(g.size);
      if (!size || g.finished) continue;
      deployed.set(g.originId, (deployed.get(g.originId) || 0) + size);
      liveGroups.add(g.id);
    }
    for (const s of state.settlements) {
      diagnostics.totalPopulation += countOf(s.population);
      const faction=factions.get(s.factionId),commander=factions.get(s.controllerId||settlementController(state,s));
      const militaryFaction=faction&&commander&&faction.id!==commander.id?{...faction,color:commander.color}:faction;
      if(faction&&countOf(s.population))renderHome(s,faction,deployed.get(s.id)||0,time,camera,alpha,militaryFaction,soldiersByHome.get(s.id)||[],selectedId);
    }
    if (state.viewer?.mode === 'faction') for (const g of state.groups) if (!g.originId && liveGroups.has(g.id)) diagnostics.totalPopulation += g.kind==='army'?(soldiersByGroup.get(g.id)||[]).length:countOf(g.size);
    diagnostics.censusScope = state.viewer?.mode === 'faction' ? 'friendly-and-currently-visible' : 'whole-world';
    for (const g of state.groups) { const native = factions.get(g.factionId), commander = factions.get(observedGroupController(state, g)); const faction = native && commander && native.id !== commander.id ? { ...native, color: commander.color } : native; if (faction && liveGroups.has(g.id)) { diagnostics.groupCount++; renderGroup(g, faction, state, time, alpha, camera, selectedId,soldiersByGroup.get(g.id)||[]); } }
    for (const person of orphanSoldiers) { diagnostics.totalPopulation++; if(person.groupId){diagnostics.groupIndividuals++;diagnostics.armyIndividuals++;}else diagnostics.homePresentIndividuals++; renderSoldier(person, null, camera, alpha, selectedId, samples.length < 3); }
    for (const [id, body] of soldierViews) if (body.seenFrame !== soldierFrame) soldierViews.delete(id);
    for (const [id, view] of groupViews) if (!liveGroups.has(id)) { view.proxy.removeFromParent(); groupViews.delete(id); }
    const badges = workerBadges.finish();
    diagnostics.workerBadgeCount = badges.count; diagnostics.workerBadgeCapacity = badges.capacity; diagnostics.workerBadgeDrawCalls = badges.drawCalls;
    diagnostics.workerBadgeLodCulled = badges.lodCulled; diagnostics.workerBadgeOverlapCulled = badges.overlapCulled;
    diagnostics.drawCallsEstimate += badges.drawCalls; diagnostics.triangleEstimate += badges.count * 2;
    if (badges.count) pickables.push(workerBadges.mesh);
    for (const pool of pools.values()) {
      pool.mesh.count = pool.count; pool.mesh.visible = pool.count > 0; diagnostics.allocatedInstances += pool.capacity;
      if (!pool.count) continue;
      pickables.push(pool.mesh);
      for (const attribute of [pool.mesh.instanceMatrix, pool.mesh.instanceColor, pool.geometry.attributes.crowdMotion, pool.geometry.attributes.crowdRole, pool.geometry.attributes.crowdBattle]) {
        attribute.clearUpdateRanges(); attribute.addUpdateRange(0, pool.count * attribute.itemSize); attribute.needsUpdate = true;
      }
      diagnostics.instances += pool.count; diagnostics.drawCallsEstimate++; diagnostics.triangleEstimate += pool.count * (pool.geometry.index?.count || pool.geometry.attributes.position.count) / 3;
    }
    // A later individual may have grown this pool and replaced its mesh.
    for (const sample of samples) {
      if (sample.poolKey) sample.meshUuid = pools.get(sample.poolKey).mesh.uuid;
      if (sample.kind === 'worker') sample.badgeVisible = workerBadges.isVisible(sample.groupId);
    }
    if (soldierSelection.visible) diagnostics.drawCallsEstimate++;
    diagnostics.drawnModels = diagnostics.instances;
    diagnostics.culledIndividuals = diagnostics.totalPopulation - diagnostics.visibleIndividuals - diagnostics.housedIndividuals;
    diagnostics.populationAccountingDelta = diagnostics.representedIndividuals - diagnostics.totalPopulation;
    diagnostics.terrainCacheSamples = heights.size;
  }
  function dispose() {
    if (disposed) return; disposed = true;
    for (const pool of pools.values()) { pool.geometry.dispose(); pool.mesh.dispose(); }
    for (const geometry of templates.values()) geometry.dispose(); material.dispose(); depthMaterial.dispose(); pickGeometry.dispose(); pickMaterial.dispose(); selectionGeometry.dispose(); selectionMaterial.dispose(); workerBadges.dispose(); root.removeFromParent();
    pools.clear(); templates.clear(); groupViews.clear(); homeLayouts.clear(); soldierViews.clear(); heights.clear(); pickables = []; samples = [];
  }
  return { update, getPickables: () => pickables, resolvePick: hit => workerBadges.resolvePick(hit) || (hit?.object?.visible && Number.isInteger(hit.instanceId) && hit.instanceId >= 0 && hit.instanceId < hit.object.count ? hit.object.userData.crowdSelectionIds?.[hit.instanceId] : null), dispose, diagnostics, getMotionSamples: () => samples.map(s => ({ ...s })) };
}
