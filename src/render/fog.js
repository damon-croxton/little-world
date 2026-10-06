import { heightAt } from '../world.js';
import { KNOWLEDGE_GRID, factionView } from '../sim/knowledge.js';

// One terrain-following veil and one batched line mesh. This is presentation
// only: toggling omniscience never steps, discovers or reports anything.
export function createFog(THREE, scene) {
  const root = new THREE.Group(); root.name = 'Faction fog and remembered places'; scene.add(root);
  const { width, height, cellSize, minX, minZ } = KNOWLEDGE_GRID;
  const pixels = new Uint8Array(width * height * 4);
  const texture = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat);
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  const material = new THREE.ShaderMaterial({
    uniforms: { visibilityMap: { value: texture }, fogColor: { value: new THREE.Color('#18262a') }, mapOrigin: { value: new THREE.Vector2(minX, minZ) }, mapSize: { value: new THREE.Vector2(width * cellSize, height * cellSize) } },
    transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: `uniform vec2 mapOrigin; uniform vec2 mapSize; varying vec2 mapUv; void main(){ mapUv=(position.xz-mapOrigin)/mapSize; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `uniform sampler2D visibilityMap; uniform vec3 fogColor; varying vec2 mapUv;
      void main(){vec2 sight=texture2D(visibilityMap,mapUv).rg; float visible=smoothstep(.18,.82,sight.r); float explored=smoothstep(.12,.8,sight.g); float opacity=mix(.94,.48,explored)*(1.0-visible); if(opacity<.015)discard; gl_FragColor=vec4(fogColor,opacity);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      }`,
  });
  let veil = null, markers = null, seed = null, revision = '', remembered = [];
  const markerMaterial = new THREE.LineBasicMaterial({ color: '#adbbbd', transparent: true, opacity: .76, depthTest: false, depthWrite: false });
  const diagnostics = { active: false, visibleCells: 0, exploredCells: 0, rememberedPlaces: 0, drawCalls: 0 };
  function rebuildGround(nextSeed) {
    if (veil) { root.remove(veil); veil.geometry.dispose(); }
    const geometry = new THREE.PlaneGeometry(width * cellSize, height * cellSize, width * 2, height * 2);
    geometry.rotateX(-Math.PI / 2);
    const positions = geometry.getAttribute('position');
    for (let i = 0; i < positions.count; i++) positions.setY(i, Math.max(.34, heightAt(positions.getX(i), positions.getZ(i), nextSeed)) + .2);
    geometry.computeBoundingSphere(); veil = new THREE.Mesh(geometry, material); veil.frustumCulled = false; veil.renderOrder = 80; root.add(veil);
    seed = nextSeed; revision = '';
  }
  function updateMarkers(places) {
    if (markers) { root.remove(markers); markers.geometry.dispose(); markers = null; }
    const vertices = [];
    const segment = (a, b) => vertices.push(a.x, Math.max(.34, heightAt(a.x, a.z, seed)) + .5, a.z, b.x, Math.max(.34, heightAt(b.x, b.z, seed)) + .5, b.z);
    for (const k of places) {
      const radius = k.kind === 'settlement' ? Math.max(3, Math.min(10, k.radius || 5)) : k.kind === 'terrain' ? 3.2 : 2;
      const steps = k.kind === 'settlement' ? 28 : 16;
      for (let i = 0; i < steps; i++) {
        if (i % 2) continue;
        const a = i / steps * Math.PI * 2, b = (i + .75) / steps * Math.PI * 2;
        segment({ x: k.x + Math.cos(a) * radius, z: k.z + Math.sin(a) * radius }, { x: k.x + Math.cos(b) * radius, z: k.z + Math.sin(b) * radius });
      }
      const s = k.kind === 'settlement' ? 1.7 : 1;
      segment({ x: k.x - s, z: k.z }, { x: k.x + s, z: k.z });
      segment({ x: k.x, z: k.z - s }, { x: k.x, z: k.z + s });
    }
    if (!vertices.length) return;
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    markers = new THREE.LineSegments(geometry, markerMaterial); markers.frustumCulled = false; markers.renderOrder = 81; root.add(markers);
  }
  function update(state, factionId = null, preparedView = null) {
    root.visible = !!factionId && factionId !== 'omniscient'; diagnostics.active = root.visible;
    if (!root.visible) { diagnostics.drawCalls = 0; remembered = []; return; }
    if (seed !== state.seed) rebuildGround(state.seed);
    const f = state.factions.find(f => f.id === factionId), vision = f?.visibility;
    if (!vision) { root.visible = false; diagnostics.active = false; return; }
    const view = preparedView || factionView(state, factionId), key = `${state.seed}:${factionId}:${vision.version}:${vision.reportVersion || 0}:${view.knownPlaces?.length || 0}`;
    remembered = view.knownPlaces || [];
    if (key !== revision) {
      revision = key;
      for (let i = 0; i < width * height; i++) { pixels[i * 4] = vision.visible[i] ? 255 : 0; pixels[i * 4 + 1] = vision.explored[i] ? 255 : 0; pixels[i * 4 + 2] = 0; pixels[i * 4 + 3] = 255; }
      texture.needsUpdate = true; updateMarkers(remembered);
    }
    diagnostics.visibleCells = view.viewer.visibleCells; diagnostics.exploredCells = view.viewer.exploredCells; diagnostics.rememberedPlaces = remembered.length; diagnostics.drawCalls = 1 + (markers ? 1 : 0);
  }
  function pickRemembered(point, tolerance = 3) {
    if (!root.visible || !point) return null;
    let best = null, nearest = Infinity;
    for (const k of remembered) {
      const d = Math.hypot(k.x - point.x, k.z - point.z), radius = k.kind === 'settlement' ? Math.max(3, Math.min(10, k.radius || 5)) : 2;
      if (d <= radius + tolerance && d < nearest) { best = k.id; nearest = d; }
    }
    return best;
  }
  function dispose() {
    veil?.geometry.dispose(); markers?.geometry.dispose(); texture.dispose(); material.dispose(); markerMaterial.dispose(); root.removeFromParent(); remembered = [];
  }
  return { update, dispose, diagnostics, pickRemembered, getRemembered: () => remembered.slice() };
}
