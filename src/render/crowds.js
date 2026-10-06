import { heightAt } from '../world.js';
import { groupController } from '../sim/control.js';
import { combatFormationSlot } from '../sim/combat.js';

// One instance is one real individual. Teams share decisions, never bodies.
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

export function createCrowds(THREE, scene) {
  const root = new THREE.Group(); root.name = 'Actual population — instanced individuals'; scene.add(root);
  const templates = new Map(), pools = new Map(), homeLayouts = new Map(), groupViews = new Map(), heights = new Map();
  const transform = new THREE.Object3D(), point = new THREE.Vector3(), sphere = new THREE.Sphere(), frustum = new THREE.Frustum(), clip = new THREE.Matrix4();
  const colorCache = new Map();
  const timeUniform = { value: 0 };
  let seed = null, lastState = null, disposed = false, pickables = [], samples = [], hasCamera = false;
  let lastFrame = null;
  const priorClip = new THREE.Matrix4();
  let nodeIndex = new Map();
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
      // separate articulated 3D limbs, head/body and real cargo for EVERY
      // individual, but do not rasterize hundreds of subpixel detail faces.
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

  function poolFor(species, lod, x, z) {
    const key = `${species}:${lod}:${Math.floor(x / 56)}:${Math.floor(z / 56)}`;
    if (!pools.has(key)) {
      const base = miniature(species, lod), geometry = new THREE.BufferGeometry();
      geometry.setIndex(base.index);
      for (const [name, attr] of Object.entries(base.attributes)) geometry.setAttribute(name, attr);
      const pool = { key, geometry, count: 0, capacity: 0, mesh: null, detailed: lod === 'detailed', usedFrame: 0 };
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
  function homeLayout(s) {
    const buildings = (s.buildings || []).filter(b => b.progress == null || b.progress > .45);
    const signature = `${s.x}:${s.z}:${finite(s.radius, 8)}|` + (s.buildings || []).map(b => `${b.id}:${b.kind}:${b.x}:${b.z}:${b.progress == null || b.progress > .45}:${b.progress < 1}`).join('|');
    if (homeLayouts.get(s.id)?.signature === signature) return homeLayouts.get(s.id);
    const entrances = buildings.map(b => {
      const dx = s.x - b.x, dz = s.z - b.z, length = Math.hypot(dx, dz) || 1;
      const d = b.kind === 'hub' ? 1.95 : ['farm', 'power'].includes(b.kind) ? 1.65 : 1.22;
      return { x: b.x + dx / length * d, z: b.z + dz / length * d, kind: b.kind };
    });
    // Initial states without building records still have exact population.
    if (!entrances.length) for (let i = 0; i < 9; i++) { const a = i / 9 * TAU, r = 3 + i % 3 * 1.2; entrances.push({ x: s.x + Math.sin(a) * r, z: s.z + Math.cos(a) * r, kind: i ? 'housing' : 'hub' }); }
    const layout = { signature, people: [], entrances, labs: entrances.filter(b => b.kind === 'lab'), barracks: entrances.filter(b => ['barracks', 'range', 'fabricator', 'launcher', 'brooder', 'spitter'].includes(b.kind)), sites: entrances.filter(b => ['farm', 'power', 'workshop'].includes(b.kind)), construction: (s.buildings || []).filter(b => b.progress < 1) };
    homeLayouts.set(s.id, layout); return layout;
  }

  function emitIndividual(record, faction, camera, collect = false) {
    const { x, z, yaw, walk, work, cargo, phase, role, id } = record;
    const y = ground(x, z) + .035 + (record.elevation || 0), distanceSq = camera ? (camera.position.x - x) ** 2 + (camera.position.y - y) ** 2 + (camera.position.z - z) ** 2 : 0;
    const detailed = !camera || distanceSq < 95 ** 2;
    const lod = detailed ? 'detailed' : distanceSq < 180 ** 2 ? 'simplified' : 'overview';
    point.set(x, y + .40, z); sphere.center.copy(point); sphere.radius = .8;
    const visible = !hasCamera || frustum.intersectsSphere(sphere);
    let meshUuid = null, instanceIndex = null, poolKey = null;
    diagnostics.representedIndividuals++;
    if (!visible) diagnostics.culledIndividuals++;
    else {
      const pool = poolFor(faction.species || 'human', lod, x, z), index = pool.count++;
      if (index >= pool.capacity) grow(pool, index + 1);
      if (collect) { meshUuid = pool.mesh.uuid; instanceIndex = index; poolKey = pool.key; }
      // All crowd transforms are yaw + uniform scale. Write the affine matrix
      // directly instead of composing an Object3D/quaternion for every body.
      const m = pool.mesh.instanceMatrix.array, offset = index * 16, scale = record.scale || 1, sn = Math.sin(yaw) * scale, cs = Math.cos(yaw) * scale;
      m[offset] = cs; m[offset + 1] = 0; m[offset + 2] = -sn; m[offset + 3] = 0;
      m[offset + 4] = 0; m[offset + 5] = scale; m[offset + 6] = 0; m[offset + 7] = 0;
      m[offset + 8] = sn; m[offset + 9] = 0; m[offset + 10] = cs; m[offset + 11] = 0;
      m[offset + 12] = x; m[offset + 13] = y; m[offset + 14] = z; m[offset + 15] = 1;
      pool.mesh.setColorAt(index, colorFor(faction));
      pool.geometry.attributes.crowdMotion.setXYZW(index, phase, walk, work, cargo); pool.geometry.attributes.crowdRole.setX(index, role); pool.geometry.attributes.crowdBattle.setXYZW(index, record.attackTime ?? -1000, record.hitTime ?? -1000, 0, 0);
      diagnostics.visibleIndividuals++; if (record.groupId) diagnostics.groupVisibleIndividuals++; else diagnostics.homeVisibleIndividuals++;
      if (detailed) diagnostics.detailedIndividuals++; else { diagnostics.simplifiedIndividuals++; if (lod === 'overview') diagnostics.overviewIndividuals++; }
    }
    if (collect && samples.length < 256) {
      const beat = timeUniform.value * 8.4 + phase, bob = (.5 + .5 * Math.sin(beat * 2)) * .025 * walk, scale = record.scale || 1;
      // These offsets mirror the GPU vertex deformation, allowing QA to sample
      // working limbs even when a miner correctly remains at one worksite.
      const toolDy = work * Math.sin(beat * .73) * .17 * scale, toolDz = work * (.12 + Math.cos(beat * .73) * .08) * scale;
      samples.push({ id, meshUuid, instanceIndex, poolKey, groundY: y, groupId: record.groupId || null, settlementId: record.settlementId || null, kind: record.kind, phase: record.action, x, y: y + bob * scale, z, heading: yaw, role, militaryRole: record.militaryRole || null, attackTime: record.attackTime ?? -1000, hitTime: record.hitTime ?? -1000, attacking: Math.max(0, 1 - (timeUniform.value - (record.attackTime ?? -1000)) / .38) * Number(timeUniform.value >= (record.attackTime ?? -1000)), walking: walk, working: work, carrying: cargo, visible, lod, animationPhase: beat, leftFootZ: Math.sin(beat) * .125 * walk * scale, toolMotion: { x: Math.sin(yaw) * toolDz, y: toolDy, z: Math.cos(yaw) * toolDz }, simulationTime: timeUniform.value });
    }
  }

  function renderHome(s, faction, deployed, militaryAway, time, camera, awayRoles = { infantry: 0, ranged: 0 }, alpha = 1) {
    const population = countOf(s.population), present = Math.max(0, population - deployed), base = hash(s.id), layout = homeLayout(s);
    diagnostics.homePresentBySettlement[s.id] = present; diagnostics.homePresentIndividuals += present;
    const researchers = Math.min(present, countOf(s.assigned?.researchers)), builders = Math.min(present - researchers, countOf(s.assigned?.construction));
    const infrastructure = Math.min(present - researchers - builders, countOf(s.assigned?.infrastructure));
    const specialistCount = researchers + builders + infrastructure;
    const garrison = Math.min(present - specialistCount, Math.max(0, countOf(s.soldiers) - militaryAway));
    const homeUnits = s.military ? { infantry: Math.max(0, countOf(s.military.infantry) - awayRoles.infantry), ranged: Math.max(0, countOf(s.military.ranged) - awayRoles.ranged) } : { infantry: garrison, ranged: 0 };
    const towers = (s.buildings || []).filter(b => b.kind === 'tower' && b.progress >= 1 && !b.destroyed && b.crewAssigned > 0);
    const towerCrew = Math.min(homeUnits.ranged, towers.reduce((n, b) => n + b.crewAssigned, 0));
    const fieldUnits = { infantry: homeUnits.infantry, ranged: Math.max(0, homeUnits.ranged - towerCrew) }, fieldTotal = fieldUnits.infantry + fieldUnits.ranged;
    for (let i = 0; i < present; i++) {
      let person = layout.people[i];
      if (!person) {
        const h = noise(base + i * 31), h2 = noise(base + i * 131 + 17), phase = h * TAU;
        const a = layout.entrances[Math.floor(h * layout.entrances.length)], b = layout.entrances[Math.floor(h2 * layout.entrances.length)];
        const roadRadius = Math.max(3.2, finite(s.radius, 8) * (.28 + h2 * .24));
        const cx = s.x + Math.sin(phase) * roadRadius, cz = s.z + Math.cos(phase) * roadRadius;
        const points = [[a.x, a.z], [cx, cz], [b.x, b.z], [cx, cz], [a.x, a.z]], segments = [];
        let length = 0;
        for (let k = 0; k < 4; k++) {
          const p = points[k], q = points[k + 1], dx = q[0] - p[0], dz = q[1] - p[1], distance = Math.hypot(dx, dz), yaw = Math.atan2(dx, dz);
          const size = Math.max(.25, distance), lane = (h2 - .5) * 1.15;
          segments.push({ x: p[0] + Math.cos(yaw) * lane, z: p[1] - Math.sin(yaw) * lane, dx, dz, size, yaw, walking: distance >= .2 }); length += size;
        }
        person = layout.people[i] = { h, h2, phase, a, segments, length, sinPhase: Math.sin(phase), cosPhase: Math.cos(phase), body: { id: `home:${s.id}:${i}`, settlementId: s.id, groupId: null, kind: 'home', cargo: 0, phase, scale: .94 + h * .12 } };
      }
      const { h, h2, phase, a } = person;
      let x, z, yaw, walk = 1, work = 0, role = 0, action = 'courtyard', militaryRole = null, attackTime = -1000, hitTime = -1000, elevation = 0;
      const specialist = i < specialistCount;
      if (specialist) {
        let dest;
        if (i < researchers) { dest = layout.labs[i % Math.max(1, layout.labs.length)] || a; action = 'researching'; role = 6; }
        else if (i < researchers + builders) { const c = layout.construction[i % Math.max(1, layout.construction.length)]; dest = c ? { x: c.x + 1.4 * Math.cos(phase), z: c.z + 1.4 * Math.sin(phase) } : a; action = 'constructing'; role = 1; }
        else { dest = layout.sites[i % Math.max(1, layout.sites.length)] || a; action = 'infrastructure'; role = 1; }
        // Stationary specialists stay at their actual facility and work. Their
        // limbs move, but they are not counted as a second walking citizen.
        const spread = .26 + .10 * Math.floor(i / Math.max(1, layout.sites.length + layout.labs.length));
        x = dest.x + Math.sin(phase) * Math.min(spread, 1.35); z = dest.z + Math.cos(phase) * Math.min(spread, 1.35); yaw = Math.atan2(dest.x - x, dest.z - z); walk = 0; work = .7;
      } else if (i < specialistCount + garrison) {
        const dest = layout.barracks[0] || { x: s.x + 3.4, z: s.z + 2.4 }, slot = i - specialistCount;
        militaryRole = slot < fieldUnits.infantry ? 'infantry' : 'ranged'; role = militaryRole === 'infantry' ? 2 : 7;
        x = dest.x + (slot % 6 - 2.5) * .55; z = dest.z + Math.floor(slot / 6) * .60; yaw = Math.PI / 2; walk = 0; work = 0; action = 'garrison';
        if (slot >= fieldTotal && towerCrew) {
          let operator = slot - fieldTotal, tower = towers[0];
          for (const candidate of towers) { if (operator < candidate.crewAssigned) { tower = candidate; break; } operator -= candidate.crewAssigned; }
          x = tower.x + (operator ? .55 : -.55); z = tower.z + .45; action = 'tower-crew'; elevation = faction.species === 'human' ? 3.15 : 3.45;
          attackTime = tower.lastAttackTime ?? -1000;
        } else if (s.combat?.active) {
          const position = combatFormationSlot(s, slot, { units: fieldUnits, alpha, x: mix(s.combat.prevX ?? s.combat.x, s.combat.x, alpha), z: mix(s.combat.prevZ ?? s.combat.z, s.combat.z, alpha) });
          x = position.x; z = position.z; yaw = position.yaw; action = 'defending';
          walk = Math.hypot((s.combat.prevX ?? s.combat.x) - s.combat.x, (s.combat.prevZ ?? s.combat.z) - s.combat.z) > .001 ? 1 : 0;
          const attack = s.combat.roleAttacks?.[militaryRole];
          if (attack?.indices?.includes(slot)) attackTime = attack.time;
          if (s.combat.hitIndices?.includes(slot)) hitTime = s.combat.lastHitTime ?? -1000;
        }
      } else {
        // A loop follows entrance → central road junction → second entrance →
        // junction. Fixed per-person speed gives real sub-pulse movement at1x.
        const { segments, length } = person;
        let d = ((time * (.53 + h2 * .27) + h * length) % length + length) % length, segment = 0;
        while (segment < 3 && d > segments[segment].size) { d -= segments[segment].size; segment++; }
        const leg = segments[segment], t = clamp(d / leg.size);
        yaw = leg.yaw; x = leg.x + leg.dx * t; z = leg.z + leg.dz * t;
        if (!leg.walking) { walk = 0; work = .3; }
      }
      const collect = i < 3 || i === specialistCount + garrison;
      const body = person.body;
      body.action = action; body.x = x; body.z = z; body.yaw = yaw; body.walk = walk; body.work = work; body.role = role; body.militaryRole = militaryRole; body.attackTime = attackTime; body.hitTime = hitTime; body.elevation = elevation;
      emitIndividual(body, faction, camera, collect);
    }
  }

  function renderGroup(g, faction, state, time, alpha, camera, selectedId) {
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
    const yaw = g.combat?.active ? g.combat.yaw : angleMix(view.previousYaw, view.yaw, alpha), sin = Math.sin(yaw), cos = Math.cos(yaw), isArmy = g.kind === 'army', isWorking = ['working', 'gathering'].includes(g.phase), engaging = g.phase === 'engaging';
    const workBlend = mix(view.previousWorking, isWorking ? 1 : 0, clamp((time - view.phaseStart) / .65));
    const cols = isArmy ? Math.min(12, Math.max(4, Math.ceil(Math.sqrt(size * .9)))) : g.kind === 'scout' ? Math.min(2, size) : Math.min(4, Math.ceil(Math.sqrt(size * .7)));
    const rows = Math.ceil(size / cols), spacing = isArmy ? .56 : .65;
    const node = isWorking ? nodeIndex.get(g.targetId) : null, siteRadius = Math.max(1.2, Math.min(4.5, finite(node?.radius, 2.0)));
    const cargoAmount = typeof g.carrying === 'object' ? Object.values(g.carrying).reduce((n, x) => n + finite(x), 0) : finite(g.carrying);
    const cargo = clamp(cargoAmount / Math.max(1, finite(g.capacity, size * 6))), phaseSeed = hash(g.id), role = ({ worker: 1, army: 2, scout: 3, trader: 4, colonist: 5 })[g.kind] || 0;
    const units = g.units || { infantry: size, ranged: 0 };
    diagnostics.groupIndividuals += size; if (g.kind === 'worker') diagnostics.workerIndividuals += size; if (isArmy) diagnostics.armyIndividuals += size;
    view.proxy.position.set(x, ground(x, z) + .5, z); view.proxy.scale.set(Math.max(1.1, cols * spacing * .65), 1.0, Math.max(1.1, rows * spacing * .65)); view.proxy.rotation.y = yaw; view.proxy.updateMatrixWorld(); pickables.push(view.proxy);
    for (let i = 0; i < size; i++) {
      let person = view.people[i];
      if (!person) { const h = noise(phaseSeed + i * 67), phase = h * TAU; person = view.people[i] = { h, phase, body: { id: `group:${g.id}:${i}`, groupId: g.id, settlementId: null, phase, scale: .97 + h * .08 } }; }
      const { phase } = person, side = (i % cols - (cols - 1) / 2) * spacing, forward = (Math.floor(i / cols) - (rows - 1) / 2) * spacing;
      let ox = side * cos + forward * sin, oz = -side * sin + forward * cos, heading = yaw;
      if (workBlend > 0) {
        const angle = (i * 2.399963229728653 + phaseSeed * .001) % TAU, radius = siteRadius * (.65 + .6 * Math.sqrt((i + .5) / size));
        ox = mix(ox, Math.sin(angle) * radius, workBlend); oz = mix(oz, Math.cos(angle) * radius, workBlend); heading = angleMix(yaw, angle + Math.PI, workBlend);
      }
      const walk = moved ? 1 - workBlend : 0, work = isWorking ? .95 : 0;
      let militaryRole = null, individualRole = role, attackTime = -1000, hitTime = -1000;
      if (isArmy) {
        const position = combatFormationSlot(g, i, { units, x, z, yaw, alpha });
        ox = position.x - x; oz = position.z - z; heading = yaw; militaryRole = position.role; individualRole = militaryRole === 'infantry' ? 2 : 7;
        const attack = g.combat?.roleAttacks?.[militaryRole];
        if (attack?.indices?.includes(i)) attackTime = attack.time;
        if (g.combat?.hitIndices?.includes(i)) hitTime = g.combat.lastHitTime ?? -1000;
      }
      const collect = i < 2 || isArmy && i === units.infantry || g.id === selectedId && i < 6;
      const body = person.body;
      body.kind = g.kind; body.action = g.phase; body.x = x + ox; body.z = z + oz; body.yaw = heading; body.walk = walk; body.work = work; body.cargo = g.kind === 'trader' ? .75 : g.kind === 'colonist' ? .55 : cargo; body.role = individualRole; body.militaryRole = militaryRole; body.attackTime = attackTime; body.hitTime = hitTime;
      emitIndividual(body, faction, camera, collect);
    }
  }

  function stateDigest(state) {
    // Normally step/time invalidate the frame. Also detect inspector/QA edits
    // during a pause: replacing or mutating a node, group, faction or building
    // must not reuse stale accounting or transforms at the same pulse.
    return state.factions.map(f => `${f.id}:${f.species}:${f.color}:${f.defeatedBy}`).join('|') + ';' +
      state.settlements.map(s => `${s.id}:${s.factionId}:${s.x}:${s.z}:${s.radius}:${s.population}:${s.soldiers}:${s.military?.infantry}:${s.military?.ranged}:${s.combat?.active}:${s.combat?.lastHitTime}:${s.assigned?.researchers}:${s.assigned?.construction}:${s.assigned?.infrastructure}:` + (s.buildings || []).map(b => `${b.id}:${b.kind}:${b.x}:${b.z}:${b.progress}`).join(',')).join('|') + ';' +
      state.groups.map(g => `${g.id}:${g.originId}:${g.factionId}:${g.commandFactionId}:${g.controllerId}:${g.kind}:${g.size}:${g.units?.infantry}:${g.units?.ranged}:${g.combat?.active}:${g.formationRevision}:${g.combat?.roleAttacks?.infantry?.time}:${g.combat?.roleAttacks?.ranged?.time}:${g.combat?.lastHitTime}:${g.finished}:${g.x}:${g.z}:${g.prevX}:${g.prevZ}:${g.targetX}:${g.targetZ}:${g.phase}:${g.carrying}:${g.capacity}:${g.targetId}`).join('|') + ';' +
      (state.nodes || []).map(n => `${n.id}:${n.x}:${n.z}:${n.radius}:${n.amount}`).join('|');
  }

  function update(state, time, selectedId, alpha = 1) {
    if (disposed) return;
    alpha = clamp(finite(alpha, 1)); time = finite(time, finite(state.time));
    const camera = scene.userData.crowdCamera || scene.userData.camera;
    hasCamera = !!camera; if (camera) { camera.updateMatrixWorld(); clip.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); frustum.setFromProjectionMatrix(clip); }
    const digest = stateDigest(state), quality = scene.userData.quality;
    // Exact paused-frame reuse. A changed camera, selection, simulation pulse,
    // interpolation or seed invalidates it; active motion is never throttled.
    if (lastFrame && lastState === state && seed === state.seed && lastFrame.step === (state.step ?? state.tick) && lastFrame.time === time && lastFrame.alpha === alpha && lastFrame.selectedId === selectedId && lastFrame.camera === camera && lastFrame.digest === digest && lastFrame.quality === quality && (!camera || priorClip.equals(clip))) { diagnostics.reusedFrame = true; return; }
    lastFrame = { step: state.step ?? state.tick, time, alpha, selectedId, camera, digest, quality }; priorClip.copy(clip);
    timeUniform.value = time; samples = []; pickables = [];
    if (seed !== state.seed || lastState !== state) { seed = state.seed; lastState = state; heights.clear(); homeLayouts.clear(); for (const view of groupViews.values()) view.proxy.removeFromParent(); groupViews.clear(); }
    for (const pool of pools.values()) pool.count = 0;
    Object.assign(diagnostics, { totalPopulation: 0, representedIndividuals: 0, visibleIndividuals: 0, culledIndividuals: 0, homePresentIndividuals: 0, homeVisibleIndividuals: 0, groupIndividuals: 0, groupVisibleIndividuals: 0, workerIndividuals: 0, armyIndividuals: 0, groupCount: 0, instances: 0, detailedIndividuals: 0, simplifiedIndividuals: 0, overviewIndividuals: 0, reusedFrame: false, drawCallsEstimate: 0, triangleEstimate: 0, allocatedInstances: 0, instanceAllocationUnfulfilled: 0, homePresentBySettlement: {}, populationAccountingDelta: 0, terrainCacheSamples: 0, occlusionCulling: false });
    nodeIndex = new Map((state.nodes || []).map(n => [n.id, n]));
    const factions = new Map(state.factions.map(f => [f.id, f])), deployed = new Map(), militaryAway = new Map(), militaryAwayRoles = new Map(), liveGroups = new Set();
    for (const g of state.groups) if (countOf(g.size) && !g.finished) { deployed.set(g.originId, (deployed.get(g.originId) || 0) + countOf(g.size)); if (g.kind === 'army') { militaryAway.set(g.originId, (militaryAway.get(g.originId) || 0) + countOf(g.size)); const roles = militaryAwayRoles.get(g.originId) || { infantry: 0, ranged: 0 }; roles.infantry += countOf(g.units?.infantry ?? g.size); roles.ranged += countOf(g.units?.ranged); militaryAwayRoles.set(g.originId, roles); } liveGroups.add(g.id); }
    for (const s of state.settlements) { diagnostics.totalPopulation += countOf(s.population); const faction = factions.get(s.factionId); if (faction && countOf(s.population)) renderHome(s, faction, deployed.get(s.id) || 0, militaryAway.get(s.id) || 0, time, camera, militaryAwayRoles.get(s.id), alpha); }
    if (state.viewer?.mode === 'faction') for (const g of state.groups) if (!g.originId && liveGroups.has(g.id)) diagnostics.totalPopulation += countOf(g.size);
    diagnostics.censusScope = state.viewer?.mode === 'faction' ? 'friendly-and-currently-visible' : 'whole-world';
    for (const g of state.groups) { const native = factions.get(g.factionId), commander = factions.get(groupController(state, g)); const faction = native && commander && native.id !== commander.id ? { ...native, color: commander.color } : native; if (faction && liveGroups.has(g.id)) { diagnostics.groupCount++; renderGroup(g, faction, state, time, alpha, camera, selectedId); } }
    for (const [id, view] of groupViews) if (!liveGroups.has(id)) { view.proxy.removeFromParent(); groupViews.delete(id); }
    for (const pool of pools.values()) {
      pool.mesh.count = pool.count; pool.mesh.visible = pool.count > 0; diagnostics.allocatedInstances += pool.capacity;
      if (!pool.count) continue;
      for (const attribute of [pool.mesh.instanceMatrix, pool.mesh.instanceColor, pool.geometry.attributes.crowdMotion, pool.geometry.attributes.crowdRole, pool.geometry.attributes.crowdBattle]) {
        attribute.clearUpdateRanges(); attribute.addUpdateRange(0, pool.count * attribute.itemSize); attribute.needsUpdate = true;
      }
      diagnostics.instances += pool.count; diagnostics.drawCallsEstimate++; diagnostics.triangleEstimate += pool.count * (pool.geometry.index?.count || pool.geometry.attributes.position.count) / 3;
    }
    // A later individual may have grown this pool and replaced its mesh.
    for (const sample of samples) if (sample.poolKey) sample.meshUuid = pools.get(sample.poolKey).mesh.uuid;
    diagnostics.populationAccountingDelta = diagnostics.representedIndividuals - diagnostics.totalPopulation;
    diagnostics.terrainCacheSamples = heights.size;
  }
  function dispose() {
    if (disposed) return; disposed = true;
    for (const pool of pools.values()) { pool.geometry.dispose(); pool.mesh.dispose(); }
    for (const geometry of templates.values()) geometry.dispose(); material.dispose(); depthMaterial.dispose(); pickGeometry.dispose(); pickMaterial.dispose(); root.removeFromParent();
    pools.clear(); templates.clear(); groupViews.clear(); homeLayouts.clear(); heights.clear(); pickables = []; samples = [];
  }
  return { update, getPickables: () => pickables, dispose, diagnostics, getMotionSamples: () => samples.map(s => ({ ...s })) };
}
