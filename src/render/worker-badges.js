// One shared glyph atlas and one instanced draw for every visible worker label.
// Counts are uniforms per instance, so changing crews never creates textures,
// materials, canvas elements or DOM labels. This layer represents no extra people.
export function createWorkerBadges(THREE, root) {
  const glyphs = '0123456789×', cell = 64;
  let texture;
  const canvas = globalThis.document?.createElement?.('canvas');
  const context = canvas?.getContext?.('2d');
  if (context) {
    canvas.width = cell * glyphs.length; canvas.height = cell;
    context.fillStyle = '#ffffff'; context.font = '700 48px Arial, sans-serif';
    context.textAlign = 'center'; context.textBaseline = 'middle';
    for (let i = 0; i < glyphs.length; i++) context.fillText(glyphs[i], (i + .5) * cell, cell * .51);
    texture = new THREE.CanvasTexture(canvas);
  } else {
    // Deterministic non-DOM atlas also permits real geometry/accounting tests in
    // Node. Browsers use the antialiased type above, with the same atlas layout.
    const rows = ['111,101,101,101,111', '010,110,010,010,111', '111,001,111,100,111', '111,001,111,001,111', '101,101,111,001,001', '111,100,111,001,111', '111,100,111,101,111', '111,001,010,010,010', '111,101,111,101,111', '111,101,111,001,111', '000,101,010,101,000'];
    const width = cell * glyphs.length, pixels = new Uint8Array(width * cell * 4);
    for (let g = 0; g < rows.length; g++) {
      const bitmap = rows[g].split(',');
      for (let y = 0; y < 40; y++) for (let x = 0; x < 24; x++) if (bitmap[Math.floor(y / 8)][Math.floor(x / 8)] === '1') {
        const i = ((cell - 1 - (y + 12)) * width + g * cell + x + 20) * 4;
        pixels[i] = pixels[i + 1] = pixels[i + 2] = pixels[i + 3] = 255;
      }
    }
    texture = new THREE.DataTexture(pixels, width, cell); texture.needsUpdate = true;
  }
  texture.minFilter = THREE.LinearFilter; texture.magFilter = THREE.LinearFilter; texture.generateMipmaps = false;
  const viewport = new THREE.Vector2(1280, 800);
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: true, toneMapped: false,
    uniforms: { glyphAtlas: { value: texture }, viewport: { value: viewport } },
    vertexShader: `
      attribute vec3 badgeAnchor;
      attribute vec4 badgeLayout;
      attribute vec3 badgeColor;
      uniform vec2 viewport;
      varying vec2 labelUv;
      varying vec4 labelLayout;
      varying vec3 labelColor;
      void main() {
        labelUv = uv; labelLayout = badgeLayout; labelColor = badgeColor;
        vec4 anchor = projectionMatrix * modelViewMatrix * vec4(badgeAnchor, 1.0);
        float width = (badgeLayout.y + 1.0) * badgeLayout.z * 0.52 + 8.0;
        vec2 pixels = vec2(position.x * width, (position.y + 0.5) * badgeLayout.z + 3.0);
        anchor.xy += pixels * 2.0 / viewport * anchor.w;
        gl_Position = anchor;
      }`,
    fragmentShader: `
      uniform sampler2D glyphAtlas;
      varying vec2 labelUv;
      varying vec4 labelLayout;
      varying vec3 labelColor;
      void main() {
        float digits = labelLayout.y, height = labelLayout.z;
        float width = (digits + 1.0) * height * 0.52 + 8.0;
        vec2 pixels = (labelUv - 0.5) * vec2(width, height);
        vec2 edge = abs(pixels) - vec2(width * 0.5 - 4.0, height * 0.5 - 4.0);
        float distance = length(max(edge, 0.0)) + min(max(edge.x, edge.y), 0.0) - 4.0;
        float alpha = 1.0 - smoothstep(-0.7, 0.5, distance);
        if (alpha < 0.01) discard;
        float ink = 0.0;
        float textX = (labelUv.x * width - 4.0) / (height * 0.52);
        if (textX >= 0.0 && textX < digits + 1.0) {
          float column = floor(textX);
          float glyph = column >= digits ? 10.0 : mod(floor(labelLayout.x / pow(10.0, digits - column - 1.0)), 10.0);
          ink = texture2D(glyphAtlas, vec2((glyph + 0.5 + (fract(textX) - 0.5) * 0.64) / 11.0, labelUv.y)).a;
        }
        vec3 background = mix(vec3(0.028, 0.048, 0.055), labelColor * 0.19, 0.28);
        float border = smoothstep(-1.8, -0.7, distance);
        vec3 color = mix(background, mix(labelColor, vec3(1.0), labelLayout.w * 0.55), border * 0.9);
        gl_FragColor = vec4(mix(color, vec3(1.0, 0.99, 0.94), ink), alpha * 0.97);
      }`
  });
  const quad = new THREE.PlaneGeometry(1, 1), geometry = new THREE.InstancedBufferGeometry();
  geometry.index = quad.index; geometry.attributes.position = quad.attributes.position; geometry.attributes.uv = quad.attributes.uv;
  const mesh = new THREE.Mesh(geometry, material); mesh.name = 'Worker crew count badges'; mesh.frustumCulled = false; mesh.renderOrder = 9; mesh.visible = false;
  mesh.userData.workerBadges = true; root.add(mesh);
  let capacity = 0, count = 0, records = [], candidates = [], camera = null;
  const attributes = ['badgeAnchor', 'badgeLayout', 'badgeColor'];
  const projected = new THREE.Vector3(), pointer = new THREE.Vector3();
  mesh.onBeforeRender = renderer => renderer.getSize(viewport);
  mesh.raycast = (raycaster, hits) => {
    if (!mesh.visible || !raycaster.camera) return;
    // Billboard positions are authored in the vertex shader. Test the exact
    // same CSS-pixel rectangle instead of raycasting the untransformed quad.
    raycaster.ray.at(1, pointer).project(raycaster.camera);
    for (let i = 0; i < count; i++) {
      const record = records[i]; projected.set(record.x, record.y, record.z).project(raycaster.camera);
      if (projected.z < -1 || projected.z > 1) continue;
      const dx = (pointer.x - projected.x) * viewport.x / 2, dy = (pointer.y - projected.y) * viewport.y / 2;
      if (Math.abs(dx) > record.width / 2 || dy < 3 || dy > record.height + 3) continue;
      const hitPoint = new THREE.Vector3(record.x, record.y, record.z), distance = raycaster.ray.origin.distanceTo(hitPoint);
      if (distance >= raycaster.near && distance <= raycaster.far) hits.push({ distance, point: hitPoint, object: mesh, instanceId: i });
    }
  };
  function reserve(requested) {
    if (requested <= capacity) return;
    let next = Math.max(16, capacity); while (next < requested) next *= 2;
    for (const [name, size] of [['badgeAnchor', 3], ['badgeLayout', 4], ['badgeColor', 3]]) {
      const values = new Float32Array(next * size), previous = geometry.getAttribute(name);
      if (previous) values.set(previous.array);
      geometry.setAttribute(name, new THREE.InstancedBufferAttribute(values, size).setUsage(THREE.DynamicDrawUsage));
    }
    capacity = next;
  }
  function submit(record) {
    reserve(count + 1);
    const { size, digits, height, x, y, z, color, selected } = record;
    geometry.attributes.badgeAnchor.setXYZ(count, x, y, z);
    geometry.attributes.badgeLayout.setXYZW(count, size, digits, height, Number(selected));
    geometry.attributes.badgeColor.setXYZ(count, color.r, color.g, color.b);
    records[count++] = record;
  }
  return {
    mesh,
    setViewport(size) {
      const width = size?.width || globalThis.innerWidth || viewport.x, height = size?.height || globalThis.innerHeight || viewport.y;
      viewport.set(Math.max(1, width), Math.max(1, height));
      return `${viewport.x}:${viewport.y}`;
    },
    begin(nextCamera) { count = 0; candidates.length = 0; camera = nextCamera; },
    add({ groupId, size, x, y, z, color, lod, selected }) {
      const digits = String(size).length, height = lod === 'detailed' ? 21 : 18;
      candidates.push({ groupId, text: `${size}×`, size, digits, x, y, z, color, selected: !!selected, width: (digits + 1) * height * .52 + 8, height });
    },
    finish() {
      let lodCulled = 0, overlapCulled = 0;
      // Measure a reference worker in pixels, independent of its enlarged
      // overview LOD, so switching model detail cannot toggle count labels.
      // Stable IDs break ties; selection takes precedence over ordinary labels
      // regardless of the simulation group's iteration order.
      candidates.sort((a, b) => Number(b.selected) - Number(a.selected) || (a.groupId < b.groupId ? -1 : a.groupId > b.groupId ? 1 : 0));
      const occupied = new Map(), cellSize = 64, gap = 3;
      for (const record of candidates) {
        if (camera) {
          projected.set(record.x, record.y, record.z).applyMatrix4(camera.matrixWorldInverse);
          const depth = -projected.z, referencePixels = .82 * viewport.y * camera.projectionMatrix.elements[5] / (2 * Math.max(.01, camera.isOrthographicCamera ? 1 : depth));
          if (depth <= .01 || !Number.isFinite(depth) || !record.selected && referencePixels < 3.5) { lodCulled++; continue; }
          projected.set(record.x, record.y, record.z).project(camera);
          const centerX = (projected.x + 1) * viewport.x / 2, bottom = (1 - projected.y) * viewport.y / 2 - 3;
          const bounds = { left: centerX - record.width / 2 - gap, right: centerX + record.width / 2 + gap, top: bottom - record.height - gap, bottom: bottom + gap };
          const fromX = Math.floor(bounds.left / cellSize), toX = Math.floor(bounds.right / cellSize), fromY = Math.floor(bounds.top / cellSize), toY = Math.floor(bounds.bottom / cellSize);
          let overlaps = false;
          for (let x = fromX; x <= toX && !overlaps; x++) for (let y = fromY; y <= toY && !overlaps; y++) {
            overlaps = (occupied.get(`${x}:${y}`) || []).some(other => bounds.left < other.right && bounds.right > other.left && bounds.top < other.bottom && bounds.bottom > other.top);
          }
          if (!record.selected && overlaps) { overlapCulled++; continue; }
          for (let x = fromX; x <= toX; x++) for (let y = fromY; y <= toY; y++) {
            const key = `${x}:${y}`, bucket = occupied.get(key) || []; bucket.push(bounds); occupied.set(key, bucket);
          }
        }
        submit(record);
      }
      records.length = count; geometry.instanceCount = count; mesh.visible = count > 0;
      if (count) for (const name of attributes) { const attribute = geometry.getAttribute(name); attribute.clearUpdateRanges(); attribute.addUpdateRange(0, count * attribute.itemSize); attribute.needsUpdate = true; }
      return { count, capacity, drawCalls: Number(count > 0), lodCulled, overlapCulled };
    },
    isVisible(groupId) { return records.some(record => record.groupId === groupId); },
    resolvePick(hit) { return hit.object === mesh ? records[hit.instanceId]?.groupId : null; },
    dispose() { mesh.removeFromParent(); geometry.dispose(); material.dispose(); texture.dispose(); records = []; candidates = []; }
  };
}
