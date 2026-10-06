import { heightAt, biomeAt, terrainAt, generateWorld, WORLD_RADIUS, LAND_SCALE } from '../world.js';
import { wallGeometry } from '../sim/navigation.js';

// The renderer owns no simulation state. Detail is aggregated into reusable,
// vertex-coloured templates and instanced, including undergrowth and wildlife.
export function createTerrain(THREE, scene, seed = 'littleworld', options = {}) {
  const root = new THREE.Group(); root.name = 'LittleWorld landscape'; scene.add(root);
  const { starts, nodes, obstacles, passes } = generateWorld(seed, options);
  root.userData.terrainObstacles = obstacles; root.userData.terrainPasses = passes;
  const resourceZones = new Map();
  for (const node of nodes) {
    const key = `${Math.floor(node.x / 12)},${Math.floor(node.z / 12)}`;
    if (!resourceZones.has(key)) resourceZones.set(key, []);
    resourceZones.get(key).push(node);
  }
  const geometries = new Set(), materials = new Set(), animatedMaterials = [];
  const clearingGroups = [];
  let lastClearingSignature = '';
  let lastClearingTick = -1;
  let hash = 2166136261;
  for (const c of String(seed)) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  let randomState = hash >>> 0;
  const rand = () => { randomState += 0x6D2B79F5; let t = randomState; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
  const dummy = new THREE.Object3D(), color = new THREE.Color();
  const palette = {
    meadow: { ground: 0x858756, dark: 0x626d4b, stone: 0x85867a, vegetation: 0x687748 },
    desert: { ground: 0xc59667, dark: 0xa67452, stone: 0xa58c76, vegetation: 0x849576 },
    alien: { ground: 0x607a78, dark: 0x4e666b, stone: 0x64747e, vegetation: 0x77aeb0 }
  };
  const geom = g => (geometries.add(g), g);
  const mat = m => (materials.add(m), m);
  const standard = (properties = {}) => mat(new THREE.MeshStandardMaterial({ roughness: .9, ...properties }));

  function merge(parts) {
    const positions = [], normals = [], colors = [];
    const transform = new THREE.Matrix4(), normalMatrix = new THREE.Matrix3();
    const position = new THREE.Vector3(), normal = new THREE.Vector3();
    for (const part of parts) {
      let geometry = part.g.index ? part.g.toNonIndexed() : part.g;
      dummy.position.set(...(part.p || [0, 0, 0]));
      dummy.rotation.set(...(part.r || [0, 0, 0]));
      dummy.scale.set(...(part.s || [1, 1, 1])); dummy.updateMatrix();
      transform.copy(dummy.matrix); normalMatrix.getNormalMatrix(transform);
      const c = new THREE.Color(part.c ?? 0xffffff);
      const pos = geometry.getAttribute('position'), norm = geometry.getAttribute('normal');
      for (let i = 0; i < pos.count; i++) {
        position.fromBufferAttribute(pos, i).applyMatrix4(transform);
        normal.fromBufferAttribute(norm, i).applyMatrix3(normalMatrix).normalize();
        positions.push(position.x, position.y, position.z); normals.push(normal.x, normal.y, normal.z); colors.push(c.r, c.g, c.b);
      }
      if (geometry !== part.g) geometry.dispose();
      part.g.dispose();
    }
    const result = geom(new THREE.BufferGeometry());
    result.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    result.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    result.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    result.computeBoundingSphere(); return result;
  }
  function cylinder(radiusTop, radiusBottom, length, sides = 7) { return new THREE.CylinderGeometry(radiusTop, radiusBottom, length, sides); }
  function sphere(radius = 1, width = 8, height = 6) { return new THREE.SphereGeometry(radius, width, height); }
  function part(g, c, p = [0, 0, 0], s = [1, 1, 1], r = [0, 0, 0]) { return { g, c, p, s, r }; }
  function windMaterial(strength = .065, emissive = 0x000000) {
    const material = standard({ vertexColors: true, emissive, emissiveIntensity: .18 });
    const time = { value: 0 }; animatedMaterials.push(time);
    material.onBeforeCompile = shader => {
      shader.uniforms.landscapeTime = time;
      shader.vertexShader = 'uniform float landscapeTime;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
        float phase = instanceMatrix[3].x * .17 + instanceMatrix[3].z * .23;
        float sway = sin(landscapeTime * .72 + phase) + .33 * sin(landscapeTime * 1.37 + phase * 1.6);
        transformed.x += sway * ${strength.toFixed(4)} * pow(max(position.y, 0.0) / 3.5, 2.0);
        transformed.z += cos(landscapeTime * .48 + phase) * ${(.4 * strength).toFixed(4)} * max(position.y, 0.0);
        #endif`);
    };
    material.customProgramCacheKey = () => `littleworld-wind-${strength}`;
    return material;
  }
  function instances(geometry, material, placements, castShadow = true, clearance = null) {
    if (!placements.length) return null;
    if (clearance && placements.length > 180) {
      const chunks = new Map();
      for (const placement of placements) {
        const key = `${Math.floor(placement.x / 72)},${Math.floor(placement.z / 72)}`;
        if (!chunks.has(key)) chunks.set(key, []);
        chunks.get(key).push(placement);
      }
      if (chunks.size > 1) {
        for (const chunk of chunks.values()) instances(geometry, material, chunk, castShadow, clearance);
        return null;
      }
    }
    const mesh = new THREE.InstancedMesh(geometry, material, placements.length);
    placements.forEach((p, i) => {
      dummy.position.set(p.x, p.y ?? heightAt(p.x, p.z, seed), p.z);
      dummy.rotation.set(p.rx || 0, p.rotation ?? rand() * Math.PI * 2, p.rz || 0);
      const scale = p.scale ?? 1; dummy.scale.set(p.sx ?? scale, p.sy ?? scale, p.sz ?? scale); dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      if (p.color !== undefined) mesh.setColorAt(i, color.set(p.color));
    });
    mesh.castShadow = castShadow; mesh.receiveShadow = true;
    mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere();
    if (clearance) {
      // Keep original seeded transforms, so expansion only clears existing detail
      // and never shifts or rerandomizes the surrounding landscape.
      clearingGroups.push({ mesh, placements, original: mesh.instanceMatrix.array.slice(), originalColors: mesh.instanceColor?.array.slice(), clearance });
      mesh.userData.clearanceKind = clearance;
    }
    root.add(mesh); return mesh;
  }
  function refreshClearings(settlements) {
    const defenses = settlements.flatMap(settlement => (settlement.buildings || []).filter(b => ['wall', 'gate', 'tower'].includes(b.kind) && !b.destroyed && !(b.hp <= 0)).map(b => wallGeometry(b.kind === 'tower' ? { ...b, length: b.length || 3 } : b)).filter(Boolean));
    for (const { mesh, placements, original, originalColors, clearance } of clearingGroups) {
      const transforms = mesh.instanceMatrix.array;
      let visibleCount = 0;
      for (let i = 0; i < placements.length; i++) {
        const p = placements[i];
        let edgeDistance = Infinity;
        for (const settlement of settlements) edgeDistance = Math.min(edgeDistance, Math.hypot(p.x - settlement.x, p.z - settlement.z) - (settlement.radius || 8) - (clearance === 'canopy' ? 5 : 3));
        // Infrastructure can extend beyond the nominal settlement radius.
        // Only buildings present in this observer's view clear the landscape.
        for (const { from, to } of defenses) {
          const dx = to.x - from.x, dz = to.z - from.z, t = clamp(((p.x - from.x) * dx + (p.z - from.z) * dz) / Math.max(.001, dx * dx + dz * dz));
          edgeDistance = Math.min(edgeDistance, Math.hypot(p.x - from.x - t * dx, p.z - from.z - t * dz) - (clearance === 'canopy' ? 3 : 1.5));
        }
        // A cleared tree/grass clump no longer exists. Do not keep submitting
        // a full invisible miniature at microscopic scale below the island.
        if (edgeDistance < 0) continue;
        const offset = visibleCount * 16, source = i * 16;
        const scale = clearance === 'canopy' ? .46 + .54 * smooth(0, 9, edgeDistance) : .7 + .3 * smooth(0, 3, edgeDistance);
        for (let j = 0; j < 16; j++) transforms[offset + j] = original[source + j];
        if (scale < 1) for (const j of [0, 1, 2, 4, 5, 6, 8, 9, 10]) transforms[offset + j] *= scale;
        if (originalColors) for (let j = 0; j < 3; j++) mesh.instanceColor.array[visibleCount * 3 + j] = originalColors[i * 3 + j];
        visibleCount++;
      }
      mesh.count = visibleCount; mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      // Original bounding spheres remain conservative: clearance only shrinks.
    }
    root.userData.settlementClearings = { count: settlements.length, revision: (root.userData.settlementClearings?.revision || 0) + 1 };
  }
  function awayFromSettlements(x, z, radius = 5.1) { return starts.every(s => Math.hypot(s.x - x, s.z - z) > radius * 1.6); }
  function awayFromWorksites(x, z) {
    const cellX = Math.floor(x / 12), cellZ = Math.floor(z / 12);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      for (const node of resourceZones.get(`${cellX + dx},${cellZ + dz}`) || []) if (Math.hypot(x - node.x, z - node.z) < node.radius + 2.6) return false;
    }
    return true;
  }
  function sample(count, biome, minHeight = .7, radius = 38.5, clear = 5.2) {
    count = Math.round(count * 2.4); radius *= LAND_SCALE;
    const result = [];
    for (let attempts = 0; result.length < count && attempts < count * 28; attempts++) {
      const angle = rand() * Math.PI * 2, r = Math.sqrt(rand()) * radius;
      const x = Math.cos(angle) * r, z = Math.sin(angle) * r, y = heightAt(x, z, seed);
      if (y < minHeight || !terrainAt(x, z, seed).traversable || (biome && biomeAt(x, z, seed) !== biome) || !awayFromSettlements(x, z, clear) || !awayFromWorksites(x, z)) continue;
      result.push({ x, z, y, scale: .7 + rand() * .7, rotation: rand() * Math.PI * 2 });
    }
    return result;
  }

  // Soft ridges, natural colour variation and a sandy littoral are all vertex
  // colours, preserving crisp lit detail without texture/network dependencies.
  const groundGeometry = geom(new THREE.PlaneGeometry(100 * LAND_SCALE, 100 * LAND_SCALE, 336, 336));
  groundGeometry.rotateX(-Math.PI / 2);
  const groundPos = groundGeometry.getAttribute('position'), groundColors = new Float32Array(groundPos.count * 3);
  const sand = new THREE.Color(0xbba883), rock = new THREE.Color(0x716c62);
  for (let i = 0; i < groundPos.count; i++) {
    const x = groundPos.getX(i), z = groundPos.getZ(i), y = heightAt(x, z, seed), biome = biomeAt(x, z, seed);
    groundPos.setY(i, y);
    const shade = .96 + .035 * Math.sin(x * .15 + z * .09) + .012 * Math.sin(x * .47 - z * .31);
    const slope = Math.hypot(heightAt(x + .35, z, seed) - heightAt(x - .35, z, seed), heightAt(x, z + .35, seed) - heightAt(x, z - .35, seed));
    color.set(palette[biome].ground);
    // Feather the ecozone boundaries through neighbouring samples.
    for (const [dx, dz] of [[1.25, 0], [-1.25, 0], [0, 1.25], [0, -1.25]]) {
      const neighbour = biomeAt(x + dx, z + dz, seed);
      if (neighbour !== biome) color.lerp(new THREE.Color(palette[neighbour].ground), .15);
    }
    color.lerp(rock, clamp(slope * .4) * .6);
    color.lerp(sand, (1 - smooth(.4, 1.4, y)) * .7);
    for (const start of starts) color.lerp(sand, (1 - smooth(1.5, 4.8, Math.hypot(x - start.x, z - start.z))) * .26);
    color.multiplyScalar(shade);
    groundColors[i * 3] = color.r; groundColors[i * 3 + 1] = color.g; groundColors[i * 3 + 2] = color.b;
  }
  groundGeometry.setAttribute('color', new THREE.BufferAttribute(groundColors, 3)); groundGeometry.computeVertexNormals();
  const ground = new THREE.Mesh(groundGeometry, standard({ vertexColors: true, roughness: .96 }));
  ground.name = 'Seeded island surface'; ground.receiveShadow = true; ground.castShadow = true; root.add(ground);

  const waterUniforms = [];
  function waterMaterial(river = false) {
    const uniforms = { uTime: { value: 0 }, uRiver: { value: river ? 1 : 0 } }; waterUniforms.push(uniforms);
    return mat(new THREE.ShaderMaterial({
      uniforms, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      vertexShader: `varying vec3 vWorld; varying vec3 vNormal;
        void main(){ vec4 world = modelMatrix * vec4(position,1.0); vWorld = world.xyz; vNormal = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * world; }`,
      fragmentShader: `uniform float uTime; uniform float uRiver; varying vec3 vWorld; varying vec3 vNormal;
        void main(){
          vec2 p=vWorld.xz; float a=sin(p.x*1.8+p.y*.7-uTime*.6); float b=sin(p.x*.6-p.y*1.5+uTime*.43);
          vec3 n=normalize(vec3(a*.025,1.0,b*.025)); vec3 eye=normalize(cameraPosition-vWorld);
          float fresnel=pow(1.0-max(dot(n,eye),0.0),3.0);
          vec3 deep=vec3(.105,.225,.255), shallow=vec3(.24,.46,.43);
          vec3 base=mix(deep,shallow,.23+uRiver*.64);
          base=mix(base,vec3(.54,.62,.61),fresnel*.45);
          float gleam=pow(max(dot(reflect(-normalize(vec3(-.55,1.0,.65)),n),eye),0.0),160.0);
          float lines=pow(max(0.0,sin(p.x*1.4+p.y*2.8+sin(p.x*.5)-uTime*.42)),18.0);
          base+=vec3(.62,.47,.28)*gleam*.55+lines*.018;
          gl_FragColor=vec4(base,.91);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`
    }));
  }
  const ocean = new THREE.Mesh(geom(new THREE.CircleGeometry(190 * LAND_SCALE, 128)), waterMaterial());
  ocean.rotation.x = -Math.PI / 2; ocean.position.y = -.54; ocean.name = 'Quiet surrounding sea'; root.add(ocean);
  const riverGeometry = geom(new THREE.PlaneGeometry(20 * LAND_SCALE, 79 * LAND_SCALE, 12, 220)); riverGeometry.rotateX(-Math.PI / 2);
  const riverPos = riverGeometry.getAttribute('position');
  for (let i = 0; i < riverPos.count; i++) { riverPos.setX(i, riverPos.getX(i) - 1.7 * LAND_SCALE); riverPos.setY(i, .31 - smooth(33.5 * LAND_SCALE, 40 * LAND_SCALE, Math.abs(riverPos.getZ(i))) * .85); }
  riverGeometry.computeVertexNormals();
  const river = new THREE.Mesh(riverGeometry, waterMaterial(true)); river.name = 'Winding freshwater'; root.add(river);
  const fordStones = [];
  for (const pass of passes.filter(pass => pass.kind === 'ford')) {
    for (let i = -4; i <= 4; i++) {
      const x = pass.x + i * 2.1, z = pass.z + (i % 2) * .42;
      fordStones.push({ x, z, y: Math.max(.26, heightAt(x, z, seed) + .055), sx: .9, sy: .10, sz: .85, rotation: i * .3 });
    }
  }
  const fordMarkers = instances(geom(new THREE.CylinderGeometry(1, 1.04, 1, 7)), standard({ color: 0xa4a38b, roughness: .96 }), fordStones, false);
  if (fordMarkers) fordMarkers.name = 'Shallow stone-bottomed fords';


  // Meadow groves: trunks and branches remain visible under loose rounded crowns.
  const treeParts = [part(cylinder(.1, .19, 2.5), 0x69604a, [0, 1.25, 0])];
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI * .5 + .3, x = Math.cos(a) * .53, z = Math.sin(a) * .53;
    treeParts.push(part(cylinder(.05, .09, 1.15), 0x706449, [x * .55, 1.9, z * .55], [1, 1, 1], [Math.sin(a) * .68, 0, -Math.cos(a) * .68]));
    treeParts.push(part(sphere(.82, 9, 7), [0x75804b, 0x89935b, 0x647947, 0x9b9c61][i], [x, 2.5 + (i % 2) * .3, z], [1.1, .86, 1]));
  }
  treeParts.push(part(sphere(.85, 10, 7), 0x8b985b, [0, 3.05, 0], [.95, .84, .95]));
  const trees = sample(140, 'meadow');
  // Group groves and leave occasional open grassland instead of uniform static.
  const groves = trees.filter(p => Math.sin(p.x * .10) + Math.cos(p.z * .13) > .12).map(p => ({ ...p, scale: p.scale * .73 }));
  const treeGeometry = merge(treeParts), treeMaterial = windMaterial(.075);
  instances(treeGeometry, treeMaterial, groves, true, 'canopy');

  const pineParts = [part(cylinder(.065, .14, 2.8), 0x655f50, [0, 1.4, 0])];
  for (let i = 0; i < 4; i++) pineParts.push(part(new THREE.ConeGeometry(.84 - i * .16, 1.4, 9), [0x4f6951, 0x587057, 0x65795c, 0x758961][i], [0, 1.15 + i * .51, 0], [1, 1, .92]));
  instances(merge(pineParts), windMaterial(.055), sample(40, 'meadow').filter(p => p.y > 3.4).map(p => ({ ...p, scale: p.scale * .65 })), true, 'canopy');

  // Arid succulents have jointed stems, rounded tips and pale ribbed colours.
  const cactusParts = [part(cylinder(.18, .24, 1.8, 10), 0x758970, [0, .9, 0]), part(sphere(.18), 0x899b7c, [0, 1.82, 0], [1, .6, 1])];
  for (let side = -1; side <= 1; side += 2) {
    cactusParts.push(part(cylinder(.12, .14, .64, 8), 0x7d9174, [side * .31, .8 + side * .15, 0], [1, 1, 1], [0, 0, side * Math.PI / 2]));
    cactusParts.push(part(cylinder(.105, .13, .78, 8), 0x85977a, [side * .59, 1.17 + side * .15, 0]));
    cactusParts.push(part(sphere(.105), 0xa2ae87, [side * .59, 1.58 + side * .15, 0], [1, .65, 1]));
  }
  instances(merge(cactusParts), windMaterial(.008), sample(65, 'desert').map(p => ({ ...p, scale: p.scale * .67 })), true, 'canopy');

  // Fungal woodland: fluted stems and broad umbrella caps, with a softly luminous rim.
  const fungalParts = [part(cylinder(.1, .23, 2.25, 9), 0x63767f, [0, 1.1, 0], [1, 1, 1], [0, 0, .1])];
  const capProfile = [[0, 0], [.32, .015], [.74, .07], [1.04, .17], [1.01, .29], [.79, .47], [.39, .61], [0, .67]].map(p => new THREE.Vector2(...p));
  fungalParts.push(part(new THREE.LatheGeometry(capProfile, 15), 0x839b9c, [-.11, 2.05, 0], [1, .8, .85]));
  fungalParts.push(part(new THREE.TorusGeometry(.99, .034, 4, 18), 0x99cbc1, [-.11, 2.21, 0], [1, .85, 1], [Math.PI / 2, 0, 0]));
  fungalParts.push(part(cylinder(.06, .105, 1.3), 0x6d7c8c, [.57, .65, .31], [1, 1, 1], [.2, 0, -.25]));
  fungalParts.push(part(new THREE.LatheGeometry(capProfile, 12), 0x9b88a3, [.73, 1.2, .36], [.62, .55, .58]));
  const fungi = sample(140, 'alien').filter(p => Math.cos(p.x * .12 - p.z * .06) + Math.sin(p.z * .16) > .12);
  const fungalGeometry = merge(fungalParts), fungalMaterial = windMaterial(.06, 0x2d6b67);
  instances(fungalGeometry, fungalMaterial, fungi.map(p => ({ ...p, scale: p.scale * .77 })), true, 'canopy');

  const reedParts = [];
  for (let i = 0; i < 5; i++) {
    const a = i * 2.4, x = Math.sin(a) * .22, z = Math.cos(a) * .22;
    reedParts.push(part(cylinder(.018, .028, .65 + (i % 2) * .23, 4), 0x9aa175, [x, .32, z], [1, 1, 1], [Math.sin(a) * .16, 0, Math.cos(a) * .16]));
    reedParts.push(part(sphere(.055, 5, 4), 0x87705b, [x * 1.4, .64 + (i % 2) * .15, z * 1.4], [1, 2.1, 1]));
  }
  const shoreReeds = sample(80, null, .32, 38, 4.8).filter(p => p.y < 1.4);
  instances(merge(reedParts), windMaterial(.17), shoreReeds, false, 'ground');

  // Substantial outcrops frame higher ground; tiny scattered pebbles would
  // compete with people and make open routes resemble resource deposits.
  const boulder = new THREE.DodecahedronGeometry(1, 1), boulderPos = boulder.getAttribute('position');
  for (let i = 0; i < boulderPos.count; i++) {
    const x = boulderPos.getX(i), y = boulderPos.getY(i), z = boulderPos.getZ(i);
    const f = .87 + Math.sin(x * 12 + y * 8 + z * 14) * .12;
    boulderPos.setXYZ(i, x * f, y * f * .69, z * f);
  }
  boulder.computeVertexNormals(); geom(boulder);
  const stones = sample(36, null, 3.8, 43, 6).map(p => ({ ...p, scale: .55 + rand() * .4, color: palette[biomeAt(p.x, p.z, seed)].stone }));
  instances(boulder, standard({ color: 0xffffff, roughness: .93 }), stones, true, 'ground');

  const crystalParts = [];
  for (let i = 0; i < 5; i++) {
    const a = i * 2.4, size = i ? .58 + rand() * .4 : 1.35;
    crystalParts.push(part(new THREE.CylinderGeometry(0, .26, 1.25, 5), i % 2 ? 0x70b8b7 : 0xa4c6c1, [Math.sin(a) * .42, size * .66, Math.cos(a) * .42], [size, size, size], [Math.sin(a) * .18, 0, Math.cos(a) * .18]));
    crystalParts.push(part(new THREE.CylinderGeometry(.26, .17, .55, 5), 0x719796, [Math.sin(a) * .42, size * .17, Math.cos(a) * .42], [size, size, size]));
  }
  const crystalGeometry = merge(crystalParts), crystalMaterial = standard({ vertexColors: true, metalness: .22, roughness: .37, emissive: 0x1f5d57, emissiveIntensity: .23 });
  // Bright crystals below belong only to real, inspectable energy deposits.

  // Low vegetation stays in quiet patches with broad open lanes between them.
  const understory = points => points.filter(p => Math.sin(p.x * .13) + Math.cos(p.z * .11) > .15);
  const grassParts = [];
  for (let i = 0; i < 5; i++) {
    const a = i * 2.4;
    grassParts.push(part(new THREE.ConeGeometry(.06, .45 + (i % 2) * .15, 3), i % 2 ? 0xadb079 : 0x8f9a65, [Math.sin(a) * .12, .22, Math.cos(a) * .12], [1, 1, 1], [.17 * Math.sin(a), a, .17 * Math.cos(a)]));
  }
  instances(merge(grassParts), windMaterial(.2), understory(sample(220, 'meadow', .9, 39, 5)), false, 'ground');
  const scrubParts = [part(sphere(.26, 7, 5), 0xabaa85, [0, .2, 0], [1.1, .63, 1]), part(sphere(.18, 7, 5), 0x9e9f7b, [.2, .13, .1], [1, .7, 1])];
  instances(merge(scrubParts), windMaterial(.08), understory(sample(85, 'desert', .75, 39, 5)), false, 'ground');
  const alienUnder = [];
  for (let i = 0; i < 3; i++) {
    const x = (i - 1) * .18;
    alienUnder.push(part(cylinder(.022, .055, .35 + i * .12, 5), 0x63858b, [x, .16 + i * .06, 0]));
    alienUnder.push(part(sphere(.15, 8, 5), i % 2 ? 0xb29fb8 : 0x8abdb4, [x, .35 + i * .12, 0], [1, .65, 1]));
  }
  instances(merge(alienUnder), windMaterial(.1, 0x264b4e), understory(sample(130, 'alien', .6, 39, 5)), false, 'ground');

  const flowerParts = [];
  for (let i = 0; i < 5; i++) {
    const a = i * 2.4, x = Math.sin(a) * .26, z = Math.cos(a) * .26;
    flowerParts.push(part(cylinder(.012, .018, .32, 4), 0x859064, [x, .16, z]));
    flowerParts.push(part(sphere(.07, 6, 4), i % 2 ? 0xd9bf80 : 0xe2d9b2, [x, .33, z], [1, .7, 1]));
  }
  instances(merge(flowerParts), windMaterial(.16), understory(sample(65, 'meadow', 1, 37, 5)), false, 'ground');

  // Harvestable sites have finite, independently removable pieces. Decorative
  // groves above are sparse framing; these bounded, inspectable patches are the
  // exact sites targeted by the physical economy, including their resource radius.
  const vertexMat = standard({ vertexColors: true });
  const salvageParts = [part(new THREE.BoxGeometry(.85, .48, .58), 0x7b776c, [0, .19, 0], [1, 1, 1], [.12, .24, -.16]), part(new THREE.BoxGeometry(.64, .08, .9), 0x9d9a83, [.34, .05, .2], [1, 1, 1], [.07, -.4, .08]), part(new THREE.TorusGeometry(.3, .075, 5, 10), 0x777f75, [-.48, .14, .17], [1, 1, 1], [.35, .3, Math.PI / 2]), part(cylinder(.13, .14, .8, 8), 0xa48d70, [.31, .3, -.2], [1, 1, 1], [0, 0, 1.1])];
  const salvageGeometry = merge(salvageParts);
  const springGeometry = merge([part(new THREE.CylinderGeometry(1, 1, .065, 20), 0x549c99, [0, .06, 0], [1, 1, .88])]);
  const cropParts = [];
  for (let i = 0; i < 5; i++) {
    const x = (i % 3 - 1) * .15, z = (Math.floor(i / 3) - .5) * .24;
    cropParts.push(part(cylinder(.025, .035, .7, 4), 0x91965e, [x, .35, z]));
    cropParts.push(part(sphere(.10, 5, 4), 0xd4ba6f, [x, .72, z], [.58, 1.6, .65]));
  }
  const cropGeometry = merge(cropParts);
  const biomassParts = [part(sphere(.43, 8, 5), 0xa681a1, [0, .36, 0], [.8, 1.2, .8])];
  for (let i = 0; i < 3; i++) { const a = i * 2.4; biomassParts.push(part(cylinder(.05, .11, .6), 0x537d7b, [Math.sin(a) * .24, .3, Math.cos(a) * .24], [1, 1, 1], [Math.cos(a) * .4, 0, Math.sin(a) * .4])); biomassParts.push(part(sphere(.19, 7, 5), 0x91c9b4, [Math.sin(a) * .36, .65, Math.cos(a) * .36], [1, .75, 1])); }
  const biomassGeometry = merge(biomassParts);
  const solarParts = [part(cylinder(.075, .15, .6, 6), 0x918065, [0, .3, 0])];
  for (let i = 0; i < 5; i++) { const a = i / 5 * Math.PI * 2; solarParts.push(part(new THREE.OctahedronGeometry(.3), i % 2 ? 0xe2bd71 : 0xc69c57, [Math.sin(a) * .27, .7, Math.cos(a) * .27], [.8, .3, 1.25], [.3, a, 0])); }
  const solarGeometry = merge(solarParts);
  const stumpGeometry = merge([part(cylinder(.18, .23, .28, 8), 0x6f604a, [0, .14, 0]), part(cylinder(.17, .17, .014, 8), 0xc7ab7c, [0, .286, 0])]);
  const templates = {
    forest: [treeGeometry, treeMaterial], ore: [boulder, standard({ color: 0xb2a093, roughness: .87 })],
    crystal: [crystalGeometry, crystalMaterial], salvage: [salvageGeometry, standard({ vertexColors: true, roughness: .66, metalness: .24 })],
    crop: [cropGeometry, windMaterial(.09)], spring: [springGeometry, standard({ vertexColors: true, roughness: .25, metalness: .14 })],
    biomass: [biomassGeometry, windMaterial(.03, 0x335d4e)], solar: [solarGeometry, standard({ vertexColors: true, metalness: .35, roughness: .4, emissive: 0x6c4617, emissiveIntensity: .12 })]
  };
  const resourceRecords = new Map(), resourceBatches = new Map(), resourceMeshEntries = new Map(), pickableResources = [];
  const stumpPlacements = [], patchPlacements = [], rimPlacements = [];
  const patchColors = { forest: 0x8a7552, ore: 0x665f57, crystal: 0x647779, salvage: 0x7d715c, crop: 0x968051, spring: 0x627a74, biomass: 0x6e7d72, solar: 0xa49269 };
  for (const node of nodes) {
    const subtype = templates[node.subtype] ? node.subtype : ({ food: 'crop', water: 'spring', energy: 'crystal', materials: 'ore' }[node.kind]);
    const count = subtype === 'spring' ? 1 : subtype === 'crop' ? 18 : subtype === 'forest' ? 7 + Math.round(node.richness * 4) : 8 + Math.round(node.richness * 5);
    const record = { id: node.id, subtype, node, height: heightAt(node.x, node.z, seed), count, pieces: [], lastQuantized: -1, fraction: 1, visible: true };
    resourceRecords.set(node.id, record);
    patchPlacements.push({ nodeId: node.id, x: node.x, z: node.z, y: record.height + .045, scale: node.radius * .96, color: patchColors[subtype], rotation: rand() * 6.28 });
    if (subtype === 'spring') {
      for (let j = 0; j < 5; j++) { const a = j / 5 * Math.PI * 2; const x = node.x + Math.sin(a) * node.radius * .81, z = node.z + Math.cos(a) * node.radius * .81; rimPlacements.push({ nodeId: node.id, x, z, scale: .34 + rand() * .17, sy: .17, color: 0x8c9b83 }); }
    }
    for (let i = 0; i < count; i++) {
      const angle = i * 2.399963 + rand() * .32, radius = (subtype === 'forest' ? .59 + .19 * ((i % 3) / 2) : Math.sqrt((i + .4) / count) * .74) * node.radius;
      const x = node.x + Math.sin(angle) * radius, z = node.z + Math.cos(angle) * radius;
      const scale = subtype === 'spring' ? node.radius * .70 : subtype === 'forest' ? .49 + rand() * .17 : subtype === 'ore' ? .65 + rand() * .45 : .65 + rand() * .35;
      const p = { x: subtype === 'spring' ? node.x : x, z: subtype === 'spring' ? node.z : z, y: heightAt(x, z, seed) + .03, scale, rotation: rand() * 6.28 };
      if (subtype === 'spring') p.y = record.height + .06;
      const entry = { record, index: i, p, mesh: null, slot: 0 };
      record.pieces.push(entry);
      const key = `${subtype}:${Math.floor(node.x / 80)},${Math.floor(node.z / 80)}`;
      if (!resourceBatches.has(key)) resourceBatches.set(key, []);
      resourceBatches.get(key).push(entry);
      if (subtype === 'forest') stumpPlacements.push({ ...p, nodeId: node.id });
    }
  }
  const patchGeometry = geom(new THREE.CircleGeometry(1, 17)); patchGeometry.rotateX(-Math.PI / 2);
  const patchPositions = patchGeometry.getAttribute('position');
  for (let i = 1; i < patchPositions.count; i++) { const factor = 1 + Math.sin(i * 2.4) * .09; patchPositions.setX(i, patchPositions.getX(i) * factor); patchPositions.setZ(i, patchPositions.getZ(i) * factor); }
  const resourceSiteDetails = [];
  function siteDetail(geometry, material, placements) {
    const mesh = instances(geometry, material, placements, false);
    if (!mesh) return;
    mesh.name = 'Surveyable resource site detail';
    mesh.userData.resourceSiteDetail = true;
    resourceSiteDetails.push({ mesh, placements, original: mesh.instanceMatrix.array.slice(), colors: mesh.instanceColor?.array.slice() });
  }
  siteDetail(patchGeometry, standard({ color: 0xffffff, transparent: true, opacity: .38, depthWrite: false, roughness: 1, polygonOffset: true, polygonOffsetFactor: -1 }), patchPlacements);
  siteDetail(stumpGeometry, vertexMat, stumpPlacements);
  siteDetail(boulder, standard({ color: 0xffffff, roughness: .97 }), rimPlacements);
  function refreshSiteDetails() {
    for (const { mesh, placements, original, colors } of resourceSiteDetails) {
      let count = 0;
      for (let i = 0; i < placements.length; i++) {
        if (!resourceRecords.get(placements[i].nodeId)?.visible) continue;
        mesh.instanceMatrix.array.set(original.subarray(i * 16, i * 16 + 16), count * 16);
        if (colors) mesh.instanceColor.array.set(colors.subarray(i * 3, i * 3 + 3), count * 3);
        count++;
      }
      mesh.count = count;
      mesh.instanceMatrix.clearUpdateRanges(); if (count) mesh.instanceMatrix.addUpdateRange(0, count * 16);
      mesh.instanceMatrix.needsUpdate = true;
      if (colors) { mesh.instanceColor.clearUpdateRanges(); if (count) mesh.instanceColor.addUpdateRange(0, count * 3); mesh.instanceColor.needsUpdate = true; }
    }
  }
  for (const entries of resourceBatches.values()) {
    const subtype = entries[0].record.subtype, [geometry, material] = templates[subtype];
    const mesh = instances(geometry, material, entries.map(e => e.p), subtype !== 'crop' && subtype !== 'spring');
    mesh.name = `Harvestable ${subtype} patch`; resourceMeshEntries.set(mesh, entries); mesh.userData.resourceNodeIds = entries.map(e => e.record.id);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); pickableResources.push(mesh);
    entries.forEach((entry, slot) => { entry.mesh = mesh; entry.slot = slot; });
  }
  let lastResourceStep = -1, lastViewerSignature = '', resourceRevision = 0, depletedSites = 0;
  function refreshResourceAmounts(state) {
    const dirty = new Set(), current = new Map((state.nodes || []).map(node => [node.id, node])); depletedSites = 0;
    const visibleIds = state.visibleNodeIds ? new Set(state.visibleNodeIds) : null;
    let visibilityChanged = false;
    for (const record of resourceRecords.values()) {
      const node = current.get(record.id), visible = !!node && (!visibleIds || visibleIds.has(record.id));
      if (record.visible !== visible) { record.visible = visible; visibilityChanged = true; record.lastQuantized = -1; }
      if (!visible) {
        if (record.lastQuantized !== -2) {
          record.lastQuantized = -2; record.fraction = 0;
          for (const piece of record.pieces) dirty.add(piece.mesh);
        }
        continue;
      }
      // Only the current viewer snapshot enters depletion and picking. Hidden
      // sites are never updated from their real simulation amount.
      record.node = node;
      const fraction = clamp(node.amount / Math.max(1, node.maxAmount || 1));
      if (fraction < .01) depletedSites++;
      const quantized = Math.round(fraction * record.count * 30);
      if (record.lastQuantized === quantized) continue;
      record.lastQuantized = quantized; record.fraction = fraction;
      for (const piece of record.pieces) dirty.add(piece.mesh);
    }
    if (visibilityChanged) refreshSiteDetails();
    for (const mesh of dirty) {
      let visibleCount = 0;
      const ids = [];
      for (const piece of resourceMeshEntries.get(mesh)) {
        const { record, p } = piece, fraction = record.fraction, remaining = clamp(fraction * record.count - piece.index);
        if (remaining <= 0) { piece.slot = -1; continue; }
        const spring = record.subtype === 'spring', forest = record.subtype === 'forest';
        const size = spring ? Math.sqrt(fraction) : forest ? .55 + remaining * .45 : Math.cbrt(remaining);
        dummy.position.set(p.x, p.y, p.z);
        dummy.rotation.set(0, p.rotation, forest ? (1 - remaining) * Math.PI * .43 : 0);
        dummy.scale.setScalar(p.scale * size); dummy.updateMatrix();
        piece.slot = visibleCount; mesh.setMatrixAt(visibleCount++, dummy.matrix); ids.push(record.id);
      }
      // Compact only genuinely depleted pieces. Each surviving site fragment
      // retains its seeded transform and exact instance-to-node picking map.
      mesh.count = visibleCount; mesh.userData.resourceNodeIds = ids;
      mesh.instanceMatrix.clearUpdateRanges(); if (visibleCount) mesh.instanceMatrix.addUpdateRange(0, visibleCount * 16);
      mesh.instanceMatrix.needsUpdate = true;
    }
    if (dirty.size) resourceRevision++;
  }
  const workCapacity = 1200, workPositions = new Float32Array(workCapacity * 3), workColors = new Float32Array(workCapacity * 3);
  const workGeometry = geom(new THREE.BufferGeometry()); workGeometry.setAttribute('position', new THREE.BufferAttribute(workPositions, 3).setUsage(THREE.DynamicDrawUsage)); workGeometry.setAttribute('color', new THREE.BufferAttribute(workColors, 3).setUsage(THREE.DynamicDrawUsage)); workGeometry.setDrawRange(0, 0);
  const workDust = new THREE.Points(workGeometry, mat(new THREE.PointsMaterial({ vertexColors: true, size: .18, transparent: true, opacity: .7, depthWrite: false, sizeAttenuation: true })));
  workDust.name = 'Physical harvesting dust and chips'; workDust.frustumCulled = false; root.add(workDust);
  let activeWorksites = 0;
  function updateWorkDust(time, state, alpha) {
    let count = 0; activeWorksites = 0;
    for (const group of state.groups || []) {
      if (group.kind !== 'worker' || group.phase !== 'working') continue;
      const record = resourceRecords.get(group.targetId); if (!record || !record.visible || record.node.amount <= 0) continue;
      if (Math.hypot(group.x - record.node.x, group.z - record.node.z) > record.node.radius + .75) continue;
      activeWorksites++;
      color.set(record.node.kind === 'energy' ? 0xbce6c5 : record.node.kind === 'food' ? 0xb7c280 : 0xc5b594);
      const x = (group.prevX ?? group.x) + (group.x - (group.prevX ?? group.x)) * alpha;
      const z = (group.prevZ ?? group.z) + (group.z - (group.prevZ ?? group.z)) * alpha;
      for (let j = 0; j < 6 && count < workCapacity; j++, count++) {
        const phase = time * 1.8 + j * .163 + activeWorksites * .19, rise = phase - Math.floor(phase), a = j * 2.4 + activeWorksites;
        workPositions[count * 3] = x + Math.sin(a + rise) * (.25 + rise * .9);
        workPositions[count * 3 + 1] = record.height + .23 + rise * 1.15;
        workPositions[count * 3 + 2] = z + Math.cos(a + rise) * (.25 + rise * .9);
        workColors[count * 3] = color.r; workColors[count * 3 + 1] = color.g; workColors[count * 3 + 2] = color.b;
      }
    }
    workGeometry.setDrawRange(0, count); workGeometry.attributes.position.needsUpdate = true; workGeometry.attributes.color.needsUpdate = true;
  }
  const pickSphere = new THREE.Sphere(), pickPoint = new THREE.Vector3();

  // The exposed coast includes clusters of dark basalt columns, giving the land
  // a physical weight and silhouette when the observer lowers the camera.
  const coast = [];
  for (let i = 0; i < 400; i++) {
    const a = rand() * Math.PI * 2, r = (39 + rand() * 6) * LAND_SCALE, x = Math.cos(a) * r, z = Math.sin(a) * r, y = heightAt(x, z, seed);
    if (y < -2 || y > 1.8) continue;
    coast.push({ x, z, y: y - .2, sx: .4 + rand() * .6, sy: .6 + rand() * 1.3, sz: .4 + rand() * .6, rotation: rand() });
  }
  const basaltGeometry = geom(cylinder(.64, .75, 1.8, 6)); basaltGeometry.translate(0, .25, 0);
  instances(basaltGeometry, standard({ color: 0x64706d, roughness: .97 }), coast);

  // Low, asymmetric rock ridges break the horizon without the smooth oval tops
  // of submerged ellipsoids. One small faceted template serves every islet.
  const isletVertices = [.16, .72, -.09], isletIndices = [];
  const isletSectors = 18, isletRings = 5;
  for (let ring = 1; ring <= isletRings; ring++) {
    const radius = ring / isletRings;
    for (let sector = 0; sector < isletSectors; sector++) {
      const angle = sector / isletSectors * Math.PI * 2;
      const outline = 1 + .12 * Math.sin(angle * 3 + .4) + .07 * Math.cos(angle * 5);
      const x = Math.cos(angle) * radius * outline * 1.23 + .16 * (1 - radius);
      const z = Math.sin(angle) * radius * outline * .83 - .09 * (1 - radius);
      const ridge = Math.pow(1 - radius, .75) * (.87 + .22 * Math.sin(angle * 2 + .6));
      const shoulder = .34 * Math.exp(-((x + .36) ** 2 / .065 + (z - .04) ** 2 / .13));
      isletVertices.push(x, ridge + shoulder - .18, z);
      const current = 1 + (ring - 1) * isletSectors + sector;
      const next = 1 + (ring - 1) * isletSectors + (sector + 1) % isletSectors;
      if (ring === 1) isletIndices.push(0, next, current);
      else {
        const inner = current - isletSectors, innerNext = next - isletSectors;
        isletIndices.push(inner, innerNext, current, current, innerNext, next);
      }
    }
  }
  const distantGeometry = geom(new THREE.BufferGeometry());
  distantGeometry.setAttribute('position', new THREE.Float32BufferAttribute(isletVertices, 3));
  distantGeometry.setIndex(isletIndices); distantGeometry.computeVertexNormals();
  const distant = [];
  for (let i = 0; i < 16; i++) {
    const a = i / 16 * Math.PI * 2 + rand() * .16, r = (104 + rand() * 30) * LAND_SCALE;
    const width = 5 + rand() * 9, relief = 2 + rand() * 5, depth = 5 + rand() * 9, rotation = rand() * 6.28;
    // Keep random consumption stable so wildlife and the living island do not move.
    if (i % 3 !== 1) distant.push({ x: Math.sin(a) * r, z: Math.cos(a) * r, y: -.54, sx: width * 1.6, sy: 5 + relief, sz: depth * 1.6, rotation });
  }
  const distantMesh = instances(distantGeometry, standard({ color: 0x687a7c, roughness: 1, flatShading: true }), distant, false);
  if (distantMesh) distantMesh.name = 'Distant rocky ridge islets';

  // Grazing herds are representative wildlife, deliberately independent of sim.
  const creatureParts = [part(sphere(.23, 8, 6), 0xbaa47c, [0, .32, 0], [1.5, .8, .7]), part(sphere(.13, 7, 5), 0xcdb78a, [.27, .5, 0], [1.1, 1.1, .85]), part(cylinder(.055, .075, .3, 5), 0xa8916d, [.2, .41, 0], [1, 1, 1], [0, 0, -.3])];
  for (const x of [-.17, .17]) for (const z of [-.085, .085]) creatureParts.push(part(cylinder(.028, .035, .25, 5), 0x8c7e62, [x, .12, z]));
  creatureParts.push(part(new THREE.ConeGeometry(.045, .16, 4), 0x93876b, [.25, .66, .07], [1, 1, 1], [0, 0, -.15]));
  creatureParts.push(part(new THREE.ConeGeometry(.045, .16, 4), 0x93876b, [.25, .66, -.07], [1, 1, 1], [0, 0, -.15]));
  const wildlifePoints = sample(24, 'meadow', 1, 35, 7);
  const wildlife = instances(merge(creatureParts), vertexMat, wildlifePoints.map(p => ({ ...p, scale: .9 + rand() * .5 })), false);
  const fireflyPoints = sample(100, 'alien', 1, 36, 5.2);
  const motePositions = new Float32Array(fireflyPoints.length * 3);
  fireflyPoints.forEach((p, i) => { motePositions[i * 3] = p.x; motePositions[i * 3 + 1] = p.y + 1 + rand() * 2; motePositions[i * 3 + 2] = p.z; });
  const moteGeometry = geom(new THREE.BufferGeometry()); moteGeometry.setAttribute('position', new THREE.BufferAttribute(motePositions, 3));
  const motes = new THREE.Points(moteGeometry, mat(new THREE.PointsMaterial({ color: 0xbce7ce, size: .075, transparent: true, opacity: .55, depthWrite: false, sizeAttenuation: true })));
  root.add(motes);
  let lastWildlifeTime = -1;
  refreshClearings(starts);
  refreshResourceAmounts({ nodes });

  return {
    update(time, state, alpha = 1) {
      const viewerSignature = state?.viewer ? `${state.viewer.mode}:${state.viewer.factionId}:${state.viewer.version}:${(state.visibleNodeIds || []).join(',')}` : 'omniscient';
      if (state?.settlements && ((state.tick ?? 0) !== lastClearingTick || viewerSignature !== lastViewerSignature)) {
        const signature = state.settlements.map(s => `${s.id}:${s.x}:${s.z}:${Math.round((s.radius || 8) * 2)}:` + (s.buildings || []).filter(b => ['wall', 'gate', 'tower'].includes(b.kind)).map(b => `${b.id}:${b.x}:${b.z}:${b.rotation}:${b.length}:${b.from?.x}:${b.from?.z}:${b.to?.x}:${b.to?.z}:${b.destroyed || b.hp <= 0}`).join(',')).join('|');
        if (signature !== lastClearingSignature) { refreshClearings(state.settlements); lastClearingSignature = signature; }
        lastClearingTick = state.tick ?? 0;
      }
      if (state && ((state.step ?? state.tick) !== lastResourceStep || viewerSignature !== lastViewerSignature)) { refreshResourceAmounts(state); lastResourceStep = state.step ?? state.tick; lastViewerSignature = viewerSignature; }
      if (state) updateWorkDust(time, state, clamp(alpha));
      for (const uniform of animatedMaterials) uniform.value = time;
      for (const uniforms of waterUniforms) uniforms.uTime.value = time;
      motes.material.opacity = .34 + Math.sin(time * .67) * .16;
      if (wildlife && time - lastWildlifeTime > .085) {
        wildlifePoints.forEach((p, i) => {
          const phase = time * .1 + i * 2.4, radius = .65;
          const x = p.x + Math.sin(phase) * radius, z = p.z + Math.cos(phase) * radius;
          dummy.position.set(x, heightAt(x, z, seed), z); dummy.rotation.set(0, -phase, 0);
          dummy.scale.setScalar(.8 + (i % 4) * .12); dummy.updateMatrix(); wildlife.setMatrixAt(i, dummy.matrix);
        }); wildlife.instanceMatrix.needsUpdate = true; lastWildlifeTime = time;
      }
    },
    getPickables() { return pickableResources; },
    resolvePick(hit) { return hit?.object?.userData?.resourceNodeIds?.[hit.instanceId] || null; },
    pickResource(raycaster) {
      let nearest = Infinity, result = null;
      for (const record of resourceRecords.values()) {
        if (!record.visible) continue;
        pickSphere.center.set(record.node.x, record.height + .7, record.node.z); pickSphere.radius = record.node.radius;
        if (raycaster.ray.intersectSphere(pickSphere, pickPoint)) {
          const distance = pickPoint.distanceTo(raycaster.ray.origin);
          if (distance < nearest) { nearest = distance; result = record.id; }
        }
      }
      return result;
    },
    get diagnostics() {
      return { worldRadius: WORLD_RADIUS, resourceSites: resourceRecords.size, visibleResourceSites: Array.from(resourceRecords.values()).filter(r => r.visible).length, visibleResourceSiteDetails: resourceSiteDetails.reduce((sum, group) => sum + group.mesh.count, 0), impassableRidges: obstacles.length, tacticalPasses: passes.length, resourcePieces: Array.from(resourceRecords.values()).reduce((sum, r) => sum + r.count, 0), visibleResourcePieces: pickableResources.reduce((sum, mesh) => sum + mesh.count, 0), visibleDecorativePieces: clearingGroups.reduce((sum, group) => sum + group.mesh.count, 0), depletedSites, activeWorksites, resourceRevision, decorativeChunks: clearingGroups.length, resourceBatches: pickableResources.length, resourceDrawCalls: pickableResources.filter(mesh => mesh.count > 0).length, clearingRevision: root.userData.settlementClearings?.revision || 0 };
    },
    dispose() {
      scene.remove(root);
      root.traverse(object => { if (object.isInstancedMesh) object.dispose(); });
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
    }
  };
}
