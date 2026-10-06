import { heightAt } from '../world.js';

// All of the miniatures are original procedural geometry. Rendering reads the
// simulation, but never consumes its random stream or writes back into it.
export function createEntities(THREE, scene) {
  const root = new THREE.Group();
  root.name = 'Living miniatures';
  scene.add(root);
  const settlements = new Map();

  const geometryCache = new Map();
  const materials = {
    solid: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.87, metalness: 0.04 }),
    metal: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.58, metalness: 0.5 }),
    glow: new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
    accent: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75 }),
  };
  const white = new THREE.Color(0xffffff);
  const tint = new THREE.Color();
  const temp = new THREE.Object3D();
  const mat = new THREE.Matrix4();
  const instanceMatrix = new THREE.Matrix4();
  const normalMatrix = new THREE.Matrix3();
  const vec = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();

  let lastSeed = null;
  let pickables = [];
  let disposed = false;

  function hash(value) {
    let h = 2166136261;
    for (const c of String(value)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    return (h >>> 0) / 4294967296;
  }
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  function cached(key, create) {
    if (!geometryCache.has(key)) geometryCache.set(key, create());
    return geometryCache.get(key);
  }
  const box = () => cached('box', () => new THREE.BoxGeometry(1, 1, 1));
  const ball = () => cached('ball', () => new THREE.SphereGeometry(1, 12, 8));
  const cylinder = (sides = 12, top = 1) => cached(`cylinder${sides}:${top}`, () => new THREE.CylinderGeometry(top, 1, 1, sides));
  const ring = () => cached('ring', () => new THREE.TorusGeometry(1, 0.075, 5, 20));
  const roof = () => cached('roof', () => {
    const g = new THREE.BufferGeometry();
    // A low ridge, generous eaves and separate gable faces make a readable house.
    const p = [-.5,0,-.5,.5,0,-.5,0,.42,-.5, -.5,0,.5,0,.42,.5,.5,0,.5,
      -.5,0,-.5,0,.42,-.5,0,.42,.5, -.5,0,-.5,0,.42,.5,-.5,0,.5,
      0,.42,-.5,.5,0,-.5,.5,0,.5, 0,.42,-.5,.5,0,.5,0,.42,.5];
    // The template is viewed from outside: reverse the original inward winding.
    for(let i=0;i<p.length;i+=9)for(let axis=0;axis<3;axis++){
      const value=p[i+3+axis];p[i+3+axis]=p[i+6+axis];p[i+6+axis]=value;
    }
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.computeVertexNormals();
    return g;
  });

  // Bake many individually coloured pieces into one geometry per material.
  // This retains genuine 3D detailing without a draw call for every plank.
  class Batch {
    constructor() { this.parts = {}; this.frame = new THREE.Matrix4(); }
    add(geometry, color, position = [0, 0, 0], size = [1, 1, 1], rotation = [0, 0, 0], material = 'solid') {
      const dst = this.parts[material] ||= { position: [], normal: [], color: [] };
      temp.position.set(...position);
      temp.scale.set(...size);
      temp.rotation.set(...rotation);
      temp.updateMatrix();
      mat.multiplyMatrices(this.frame, temp.matrix);
      normalMatrix.getNormalMatrix(mat);
      tint.set(color);
      const p = geometry.attributes.position;
      const n = geometry.attributes.normal;
      const count = geometry.index ? geometry.index.count : p.count;
      for (let i = 0; i < count; i++) {
        const j = geometry.index ? geometry.index.getX(i) : i;
        vec.fromBufferAttribute(p, j).applyMatrix4(mat);
        normal.fromBufferAttribute(n, j).applyNormalMatrix(normalMatrix);
        dst.position.push(vec.x, vec.y, vec.z);
        dst.normal.push(normal.x, normal.y, normal.z);
        dst.color.push(tint.r, tint.g, tint.b);
      }
    }
    frameAt(x, y, z, yaw, fn) {
      const previous = this.frame;
      this.frame = previous.clone().multiply(new THREE.Matrix4().makeRotationY(yaw));
      const translation = new THREE.Matrix4().makeTranslation(x, y, z);
      this.frame.copy(previous).multiply(translation).multiply(new THREE.Matrix4().makeRotationY(yaw));
      fn();
      this.frame = previous;
    }
    cube(c, x, y, z, w, h, d, yaw = 0, material = 'solid') { this.add(box(), c, [x,y,z], [w,h,d], [0,yaw,0], material); }
    sphere(c, x, y, z, w, h = w, d = w, material = 'solid') { this.add(ball(), c, [x,y,z], [w,h,d], [0,0,0], material); }
    cyl(c, x, y, z, r, h, top = 1, material = 'solid', rotation = [0,0,0]) { this.add(cylinder(12,top), c, [x,y,z], [r,h,r], rotation, material); }
    torus(c, x, y, z, r, rotation = [Math.PI/2,0,0], material = 'solid') { this.add(ring(), c, [x,y,z], [r,r,r], rotation, material); }
    rod(c, start, end, r, material = 'solid') {
      a.set(...start); b.set(...end); direction.subVectors(b, a);
      const length = direction.length();
      quaternion.setFromUnitVectors(up, direction.normalize());
      const rotation = new THREE.Euler().setFromQuaternion(quaternion);
      this.add(cylinder(6), c, [(a.x+b.x)/2,(a.y+b.y)/2,(a.z+b.z)/2], [r,length,r], [rotation.x,rotation.y,rotation.z], material);
    }
    finish(parent, userData) {
      const result = [];
      for (const [kind, arrays] of Object.entries(this.parts)) {
        if (!arrays.position.length) continue;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(arrays.position, 3));
        geometry.setAttribute('normal', new THREE.Float32BufferAttribute(arrays.normal, 3));
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(arrays.color, 3));
        geometry.computeBoundingSphere();
        const mesh = new THREE.Mesh(geometry, materials[kind]);
        mesh.castShadow = kind !== 'glow';
        mesh.receiveShadow = kind !== 'glow';
        mesh.userData = { ...userData, materialKind: kind };
        if (parent) parent.add(mesh);
        result.push(mesh);
      }
      return result;
    }
  }

  function humanHouse(batch, x, y, z, yaw, color, variation) {
    batch.frameAt(x,y,z,yaw,() => {
      const w = .95 + variation * .24, h = .7 + variation * .15, d = 1.05;
      batch.cube('#817968', 0,.09,0,w+.2,.18,d+.18);
      batch.cube('#d9c5a0', 0,h/2+.15,0,w,h,d);
      batch.add(roof(), color, [0,h+.13,0], [w+ .3,1.1,d+.3]);
      // Roof ridges, timber joints, deep doorway and glowing small windows.
      batch.rod('#6b4e39', [0,h+.6,-.68], [0,h+.6,.68], .045);
      for (const xx of [-w/2,w/2]) for (const zz of [-d/2,d/2]) batch.cube('#76513a',xx,h/2+.12,zz,.07,h+.12,.07);
      batch.cube('#76513a',0,.27,-.535,.28,.5,.045);
      batch.cube('#34372f',0,.26,-.561,.19,.38,.024);
      batch.cube('#b7a78a',0,.08,-.67,.4,.09,.28);
      for (const xx of [-.29,.29]) {
        batch.cube('#69583e',xx,.58,-.535,.22,.25,.04);
        batch.cube('#ffd993',xx,.59,-.562,.14,.16,.012,0,'glow');
      }
      batch.cube('#887e69',.25,h+.52,.25,.16,.65,.2);
      batch.cube('#5b6253',.25,h+.86,.25,.23,.07,.26);
      batch.cube('#5d513e',-.58,.37,.15,.13,.13,.85);
      batch.cyl('#a98757',-.61,.23,-.37,.14,.35);
      batch.torus('#4d584e',-.61,.27,-.37,.14);
    });
  }

  function machineWorkshop(batch, x,y,z,yaw,index) {
    batch.frameAt(x,y,z,yaw,() => {
      batch.cube('#555c55',0,.06,0,1.45,.12,1.3,0,'metal');
      batch.cube('#788886',0,.43,.12,1.19,.76,1,0,'metal');
      batch.sphere('#aa9c78',0,.85,.12,.7,.35,.59,'metal');
      batch.cube('#292f30',0,.43,-.42,.8,.6,.02);
      batch.cube('#dba554',0,.8,-.45,1.14,.12,.13,0,'metal');
      for(let i=0;i<4;i++) batch.cube('#3e504e',-.5+i*.33,.63,.12,.055,.58,1.08,0,'metal');
      batch.cyl('#967653',.69,.36,.35,.17,.62,1,'metal');
      batch.torus('#444e49',.69,.5,.35,.18,[Math.PI/2,0,0],'metal');
      batch.cube('#79e3d4',-.38,.65,-.465,.22,.045,.012,0,'glow');
      batch.rod('#4d5855',[-.36,.29,-.62],[-.1,.52,-.66],.045,'metal');
      batch.cube('#c58347',-.42,.2,-.72,.2,.35,.22,.25,'metal');
      batch.cube('#a1afa1',.29,.16,-.67,.42,.23,.3,-.12,'metal');
      // External curving conduit, a legible mechanical silhouette at distance.
      batch.torus('#c79752',.63,.82,.4,.25,[0,0,0],'metal');
      if(index%2===0) {
        batch.rod('#4c5855',[.45,.8,.43],[.45,1.65,.43],.035,'metal');
        batch.sphere('#6ddace',.45,1.7,.43,.08,.09,.08,'glow');
      }
    });
  }
  function hivePod(batch,x,y,z,size,index) {
    batch.frameAt(x,y,z,index*.7,() => {
      batch.sphere('#887b83',0,.46*size,0,.65*size,.75*size,.55*size);
      batch.sphere('#b6a292',0,.7*size,.07,.5*size,.61*size,.46*size);
      batch.sphere('#324b53',0,.28*size,-.46*size,.23*size,.31*size,.16*size);
      batch.sphere('#8dd8cb',0,.44*size,-.53*size,.1*size,.14*size,.045*size,'glow');
      // Curved chitin seams wrap every brood house, rather than cone markers.
      for(let i=0;i<5;i++) {
        const angle=i/5*Math.PI*2;
        for(let j=0;j<4;j++) {
          const t0=j/4*Math.PI*.77,t1=(j+1)/4*Math.PI*.77;
          batch.rod('#625663',
            [Math.sin(angle)*Math.sin(t0)*.67*size,(.72+Math.cos(t0)*.7)*size,Math.cos(angle)*Math.sin(t0)*.56*size],
            [Math.sin(angle)*Math.sin(t1)*.67*size,(.72+Math.cos(t1)*.7)*size,Math.cos(angle)*Math.sin(t1)*.56*size],.025*size);
        }
      }
      batch.rod('#6b666f',[0,1.2*size,0],[.18*size,1.65*size,.03*size],.028*size);
      batch.sphere('#abdcbf',.18*size,1.65*size,.03*size,.08*size,.13*size,.08*size,'glow');
    });
  }

  // V2 renders the simulation's real building records. No decorative people,
  // fabricated houses, or invisible population multipliers live in this module.
  root.name = 'LittleWorld V2 buildings and infrastructure';
  const KINDS=['housing','storage','workshop','farm','power','barracks','lab','hub'];
  const DIMENSIONS={housing:[1.65,1.65,1.65],storage:[1.9,1.5,1.8],workshop:[2.05,1.9,1.9],farm:[2.65,.65,2.8],power:[2.3,1.6,2.4],barracks:[2.25,1.6,2],lab:[2.2,2.4,2.1],hub:[3.2,3.8,3.2]};
  const pools=new Map();
  const buildingGround=new Map();
  let lastRevision='';
  const diagnostics={buildingRecords:0,completedBuildings:0,constructionSites:0,renderedBuildings:0,nearBuildings:0,farBuildings:0,ruinedBuildings:0,temporaryShelters:0,roadSegments:0,instances:0,drawCallsEstimate:0,settlements:0,camps:0,ruins:0,byKind:{},bySpecies:{},minRadius:0,maxRadius:0};

  // Construction clips each instanced model at its real completion height.
  // Matching shadow clipping avoids a completed-roof shadow over a foundation.
  function constructionShader(shader) {
    shader.vertexShader='attribute float buildLimit; varying float vBuildLimit; varying float vBuildingY;\n'+shader.vertexShader;
    shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nvBuildLimit=buildLimit; vBuildingY=position.y;');
    shader.fragmentShader='varying float vBuildLimit; varying float vBuildingY;\n'+shader.fragmentShader;
    shader.fragmentShader=shader.fragmentShader.replace('#include <clipping_planes_fragment>','#include <clipping_planes_fragment>\nif(vBuildingY>vBuildLimit) discard;');
  }
  for(const material of Object.values(materials)) {
    material.onBeforeCompile=constructionShader;
    material.customProgramCacheKey=()=> 'littleworld-v2-building-height';
  }
  const depthMaterial=new THREE.MeshDepthMaterial({depthPacking:THREE.RGBADepthPacking});
  depthMaterial.onBeforeCompile=constructionShader;
  depthMaterial.customProgramCacheKey=()=> 'littleworld-v2-building-depth';

  function pennant(batch,x,y,z,h=2.1) {
    batch.rod('#645d4a',[x,.08,z],[x,h,z],.023,'metal');
    batch.cube('#ffffff',x+.29,h-.22,z,.56,.33,.025,0,'accent');
  }
  function window(batch,x,y,z,w=.18,h=.2) {
    batch.cube('#584b38',x,y,z,w+.06,h+.06,.035);
    batch.cube('#ffd59b',x,y,z-.023,w,h,.015,0,'glow');
  }
  function humanBuilding(batch,kind,detailed) {
    if(kind==='housing') {
      if(detailed)humanHouse(batch,0,0,0,0,'#b56c46',.42);
      else {batch.cube('#d2bb93',0,.47,0,1.04,.76,1.1);batch.add(roof(),'#b16c48',[0,.85,0],[1.35,1.15,1.42]);batch.cube('#ffffff',0,.75,-.567,.29,.16,.023,0,'accent');}
      return;
    }
    if(kind==='farm') {
      batch.cube('#776544',0,.035,0,2.45,.06,2.55);
      for(let i=0;i<(detailed?6:4);i++) {
        const x=-1.02+i*(detailed?.405:.67);
        batch.cube('#87974e',x,.13,0,detailed?.22:.32,.18,2.32);
        if(detailed)for(let j=0;j<7;j++)batch.sphere(j%3?'#b9b974':'#88a051',x,.28,-.97+j*.32,.095,.17,.11);
      }
      batch.cube('#7a7f67',1.3,.08,0,.1,.09,2.65);
      if(detailed)for(const x of [-1.28,1.28])for(const z of [-1.36,1.36])batch.cube('#92774d',x,.21,z,.065,.42,.065);
      return;
    }
    if(kind==='power') {
      batch.cyl('#9b9272',0,.1,0,.54,.2);
      batch.cyl('#b59d71',0,.64,0,.31,.94,.67);
      batch.cube('#695c44',0,1.22,0,.24,.33,.31);
      for(let i=0;i<4;i++) {
        const t=i*Math.PI/2+.45;
        batch.rod('#655b45',[0,1.34,-.2],[Math.cos(t)*.97,1.34+Math.sin(t)*.97,-.2],.025);
        batch.add(box(),'#d4c69d',[Math.cos(t)*.66,1.34+Math.sin(t)*.66,-.22],[.29,.62,.035],[0,0,t-Math.PI/2]);
      }
      if(detailed){batch.cube('#657d76',.8,.29,.5,.54,.45,.38);batch.cube('#ffffff',.8,.34,.298,.24,.14,.025,0,'accent');}
      return;
    }
    if(kind==='storage') {
      batch.cube('#938872',0,.11,0,1.9,.22,1.72);
      batch.cube('#b3a37d',0,.63,0,1.55,.94,1.42);
      batch.add(roof(),'#838976',[0,1.1,0],[1.86,.75,1.73]);
      batch.cube('#6d5740',0,.48,-.73,.54,.72,.06);
      if(detailed)for(const x of [-.67,.67]){batch.cyl('#a0804f',x,.26,-1,.2,.46);batch.torus('#545b4b',x,.37,-1,.2);batch.cube('#735c40',x,.68,-.742,.055,.84,.055);}
      return;
    }
    if(kind==='hub') {
      batch.cyl('#8d8972',0,.15,0,1.28,.3);
      batch.cyl('#dbcaab',0,.83,0,1.05,1.2);
      batch.add(cylinder(10,0),'#b97b4b',[0,1.77,0],[1.4,.88,1.4]);
      batch.cyl('#7d8975',0,2.34,0,.17,.34);
      if(detailed)for(let i=0;i<10;i++){
        const t=i*Math.PI/5;batch.cube('#7b583e',Math.sin(t)*1.05,.9,Math.cos(t)*1.05,.09,1.23,.09);
        if(i%2===0)batch.sphere('#ffd692',Math.sin(t)*1.075,1.02,Math.cos(t)*1.075,.085,.19,.085,'glow');
      }
      batch.cube('#725139',0,.5,-1.06,.5,.81,.05);
      batch.cube('#bba580',0,.07,-1.33,.78,.1,.47);
      pennant(batch,-1.06,0,.8,3.15);
      return;
    }
    const lab=kind==='lab',barracks=kind==='barracks';
    const w=barracks?2:1.8,h=lab?1.08:.82;
    batch.cube('#8b856d',0,.1,0,w+.18,.2,1.7);
    batch.cube(lab?'#d4c6a5':'#c1ab85',0,.2+h/2,0,w,h,1.46);
    batch.add(roof(),lab?'#638c88':barracks?'#8c7256':'#a57547',[0,h+.18,0],[w+.32,.9,1.8]);
    batch.cube('#584c3b',0,.53,-.75,.42,.66,.04);
    batch.cube('#ffffff',0,1.02,-.78,.39,.16,.022,0,'accent');
    if(detailed){for(const x of [-w/2,w/2])for(const z of [-.73,.73])batch.cube('#73533d',x,.7,z,.075,1.1,.075);window(batch,-.62,.74,-.753);window(batch,.62,.74,-.753);}
    if(lab){batch.cyl('#b3b399',.49,1.65,.1,.35,.38);batch.sphere('#75aeb3',.49,1.92,.1,.36,.28,.36,'metal');batch.rod('#a79d71',[.5,1.94,.1],[.86,2.22,.1],.05,'metal');}
    else if(barracks){batch.rod('#877352',[-.77,.25,-1],[.77,.25,-1],.037);if(detailed)for(let i=0;i<4;i++)batch.rod('#a39670',[-.54+i*.36,.1,-1],[-.54+i*.36,.75,-1],.022);}
    else {batch.cube('#88836c',.7,1.51,.33,.28,.89,.29);batch.cube('#655f4d',.7,1.99,.33,.36,.1,.38);if(detailed){batch.cube('#70624b',-.74,.3,-1,.56,.2,.4);batch.cyl('#b99a5c',.5,.22,-.95,.18,.35);}}
  }

  function machineBuilding(batch,kind,detailed) {
    if(kind==='workshop'||kind==='housing') {
      if(detailed)machineWorkshop(batch,0,0,0,0,kind==='housing'?1:0);
      else {batch.cube('#6f847e',0,.42,0,1.2,.76,1.15,0,'metal');batch.sphere('#ac9970',0,.81,0,.7,.29,.65,'metal');batch.cube('#2f3e3a',0,.35,-.59,.79,.58,.03);}
      batch.cube('#ffffff',0,.74,-.61,.49,.12,.03,0,'accent');
      if(kind==='workshop'){
        batch.rod('#b39155',[.82,.09,.56],[.82,1.75,.56],.044,'metal');batch.rod('#b39155',[.82,1.75,.56],[-.3,1.69,.56],.042,'metal');
        if(detailed)batch.rod('#48564f',[-.3,1.69,.56],[-.3,.85,.56],.015,'metal');
      }
      return;
    }
    if(kind==='farm') {
      batch.cube('#627368',0,.11,0,2.45,.2,2.58,0,'metal');
      for(let i=0;i<4;i++){
        const x=-.84+i*.56;batch.cube('#a2ada0',x,.22,0,.4,.14,2.24,0,'metal');batch.cube('#5c9883',x,.31,0,.26,.09,2.11);
        if(detailed)for(let j=0;j<7;j++)batch.sphere('#b2cc91',x,.41,-.89+j*.3,.11,.12,.12);
      }
      if(detailed)for(const z of [-1.25,1.25])batch.rod('#c2a568',[-1.1,.45,z],[1.1,.45,z],.04,'metal');
      return;
    }
    if(kind==='power') {
      for(const x of [-.78,.78])batch.rod('#657469',[x,.03,0],[x,.65,0],.054,'metal');
      batch.add(box(),'#bec2a6',[0,.68,0],[2.27,.07,2.1],[-.24,0,0],'metal');
      const cols=detailed?5:3,rows=detailed?4:2;
      for(let i=0;i<cols;i++)for(let j=0;j<rows;j++){
        const x=-.94+(i+.5)*1.88/cols,z=-.91+(j+.5)*1.82/rows;
        batch.add(box(),'#33677a',[x,.73+z*.24,z],[1.8/cols,.022,1.73/rows],[-.24,0,0],'metal');
      }
      batch.cube('#718776',0,.2,-1.2,.62,.36,.34,0,'metal');batch.cube('#a1e0c4',0,.25,-1.38,.26,.045,.025,0,'glow');
      return;
    }
    if(kind==='storage') {
      batch.cube('#687361',0,.08,0,1.92,.16,1.67,0,'metal');
      for(const x of [-.43,.43]){
        batch.cyl('#9fae95',x,.73,0,.37,1.29,1,'metal');batch.sphere('#c1bf98',x,1.38,0,.37,.14,.37,'metal');
        if(detailed)for(const y of [.23,1.1])batch.torus('#51635a',x,y,0,.39,[Math.PI/2,0,0],'metal');
        batch.cube('#ffffff',x,.89,-.375,.32,.18,.025,0,'accent');
      }
      if(detailed){batch.rod('#b49b5b',[-.4,.22,-.16],[.73,.22,-.6],.04,'metal');batch.cube('#7b8869',.64,.24,-.61,.38,.42,.35,0,'metal');}
      return;
    }
    if(kind==='hub') {
      batch.cyl('#687b66',0,.11,0,1.37,.22,1,'metal');batch.cyl('#486562',0,.79,0,.63,1.3,.8,'metal');
      batch.cyl('#be9d5e',0,1.46,0,.55,.23,1,'metal');batch.cyl('#a1b497',0,2.05,0,.35,.97,.7,'metal');
      batch.torus('#89e2c6',0,2.5,0,.32,[Math.PI/2,0,0],'glow');batch.rod('#667b69',[0,2.45,0],[0,3.38,0],.054,'metal');batch.sphere('#a0eed3',0,3.44,0,.086,.13,.086,'glow');
      for(let i=0;i<(detailed?6:4);i++){const t=i/(detailed?6:4)*Math.PI*2,x=Math.sin(t),z=Math.cos(t);batch.rod('#788d73',[x*.3,1.94,z*.3],[x*1.02,.2,z*1.02],.056,'metal');}
      pennant(batch,-1.1,0,.67,2.7);
      return;
    }
    const lab=kind==='lab';
    batch.cube('#586d63',0,.1,0,2.04,.2,1.79,0,'metal');batch.cube('#829786',0,.65,0,1.8,1.04,1.56,0,'metal');
    batch.cube('#b8ab82',0,1.22,0,1.92,.14,1.68,0,'metal');batch.cube('#ffffff',0,.95,-.8,.8,.16,.028,0,'accent');
    batch.cube('#344944',0,.46,-.797,.94,.7,.03);
    if(lab){batch.cyl('#6a877b',.34,1.47,.16,.39,.4,1,'metal');batch.sphere('#82bbb6',.34,1.72,.16,.47,.3,.47,'metal');batch.torus('#a0e7ca',.34,1.74,.16,.46,[Math.PI/2,0,0],'glow');batch.rod('#a99d6b',[-.62,1.28,.31],[-.62,2.33,.31],.033,'metal');}
    else {for(const x of [-.65,.65])batch.cube('#576d61',x,.46,-1,.34,.79,.29,0,'metal');if(detailed)for(let i=0;i<5;i++)batch.rod('#bbac7b',[-.7+i*.35,.1,.89],[-.7+i*.35,.81,.89],.023,'metal');}
    if(detailed)for(let i=0;i<5;i++)batch.cube('#4f6458',-.67+i*.335,1.1,.05,.055,.35,1.49,0,'metal');
  }

  function hiveBuilding(batch,kind,detailed) {
    if(kind==='housing') {
      if(detailed)hivePod(batch,0,0,0,1.02,1);
      else {batch.sphere('#9c8e91',0,.65,0,.68,.74,.57);batch.sphere('#b6b9a2',0,1.09,.02,.39,.42,.36);batch.sphere('#4d5960',0,.29,-.49,.22,.3,.12);batch.sphere('#a4dcc2',0,.63,-.49,.075,.16,.055,'glow');}
      batch.sphere('#ffffff',0,1.2,.05,.11,.12,.11,'accent');return;
    }
    if(kind==='farm') {
      batch.sphere('#797464',0,.05,0,1.32,.09,1.36);
      for(let i=0;i<(detailed?20:9);i++){
        const cols=detailed?5:3,x=-1.03+(i%cols)*2.06/(cols-1),z=-1.03+Math.floor(i/cols)*(detailed?.68:1.03),h=.2+hash(`fungus${i}`)*.19;
        batch.rod('#aaad91',[x,.05,z],[x,h,z],.026);batch.sphere(i%3?'#c8bf9d':'#9cc8a2',x,h,z,detailed?.18:.29,.08,detailed?.17:.25);
      }
      return;
    }
    if(kind==='power') {
      batch.sphere('#7f7877',0,.22,0,.82,.28,.85);
      for(let i=0;i<5;i++){
        const t=i/5*Math.PI*2,x=Math.sin(t)*.61,z=Math.cos(t)*.61;
        batch.rod('#837b81',[x,.2,z],[x*.69,1.1,z*.69],.055);batch.sphere('#a8ceae',x*.69,1.17,z*.69,.24,.39,.24);
        if(detailed)batch.sphere('#a5edc2',x*.69,1.32,z*.69,.17,.25,.17,'glow');
      }
      return;
    }
    if(kind==='storage') {
      batch.sphere('#95848b',0,.46,0,.86,.54,.8);batch.sphere('#beb5a0',0,.92,0,.72,.36,.68);
      for(let i=0;i<(detailed?6:3);i++){const t=i/(detailed?6:3)*Math.PI*2;batch.rod('#766a78',[Math.sin(t)*.86,.13,Math.cos(t)*.79],[Math.sin(t)*.65,1.1,Math.cos(t)*.62],.055);}
      batch.sphere('#ffffff',0,1.21,0,.22,.075,.2,'accent');batch.sphere('#59666a',0,.29,-.75,.25,.27,.12);return;
    }
    if(kind==='hub') {
      batch.sphere('#6c8071',0,.08,0,1.48,.15,1.33);batch.sphere('#a4919c',0,1.15,0,.84,1.35,.76);
      batch.sphere('#bdd7bb',0,2.17,0,.57,.86,.53);batch.sphere('#b8e6bd',0,2.68,0,.29,.34,.27,'glow');
      for(let i=0;i<(detailed?8:5);i++){
        const t=i/(detailed?8:5)*Math.PI*2,sn=Math.sin(t),cs=Math.cos(t),points=[[sn*1.08,.12,cs*1.08],[sn*.73,.96,cs*.73],[sn*.61,1.91,cs*.61],[sn*.26,2.78,cs*.26],[sn*.18,3.24,cs*.18]];
        for(let j=0;j<points.length-1;j++)batch.rod('#736172',points[j],points[j+1],.064-j*.009);
      }
      batch.torus('#c7b09e',0,.6,0,.84);batch.torus('#bdb39e',0,1.13,0,.82);pennant(batch,-1.14,0,.7,2.55);return;
    }
    const lab=kind==='lab',barracks=kind==='barracks';
    batch.sphere('#8c8090',0,.6,0,.93,.69,.79);batch.sphere(lab?'#c6bbad':'#a69b94',0,1.04,.05,.68,.65,.61);
    batch.sphere('#4d5760',0,.38,-.68,.31,.4,.17);
    for(let i=0;i<(detailed?6:4);i++){
      const t=i/(detailed?6:4)*Math.PI*2;batch.rod('#706074',[Math.sin(t)*.91,.15,Math.cos(t)*.82],[Math.sin(t)*.63,1.19,Math.cos(t)*.58],.043);
    }
    if(lab){batch.sphere('#98ccbf',0,1.77,.04,.31,.49,.3,'glow');for(const side of [-1,1])batch.rod('#786b7f',[side*.53,1.09,.1],[side*.28,2.23,.13],.036);}
    else if(barracks){for(let i=0;i<5;i++)batch.add(cylinder(6,0),'#a79b93',[-.65+i*.325,1.36,.08],[.11,.6,.12],[0,0,(i-2)*.1]);}
    else {batch.cyl('#a4ab91',.64,.67,-.29,.25,.87,.65);batch.sphere('#bee0b8',.64,1.15,-.29,.22,.22,.21,'glow');}
    batch.sphere('#ffffff',0,1.43,-.35,.17,.08,.12,'accent');
  }

  function ruinTemplate(batch,species,kind) {
    const d=DIMENSIONS[kind],w=d[0]*.8,z=d[2]*.8,machine=species==='machine',hive=species==='hive';
    const material=machine?'metal':'solid';
    batch.cube(hive?'#6d6168':machine?'#50615a':'#7c7765',0,.075,0,w,.15,z,0,material);
    if(hive){
      batch.sphere('#6e626c',0,.24,0,w*.43,.31,z*.41);batch.sphere('#414346',0,.46,0,w*.27,.06,z*.27);
      for(let i=0;i<5;i++){const a=i/5*Math.PI*2;batch.rod('#8a7982',[Math.sin(a)*w*.44,.14,Math.cos(a)*z*.43],[Math.sin(a)*w*.32,.61+hash(`ruin${i}`)*.25,Math.cos(a)*z*.32],.043);}
    } else {
      batch.cube(machine?'#788273':'#b09f85',-w*.4,.35,0,.14,.55,z*.82,0,material);
      batch.cube(machine?'#697763':'#a59980',w*.37,.28,z*.27,.17,.4,z*.3,0,material);
      batch.cube(machine?'#5c6d62':'#9c937c',0,.25,z*.38,w*.7,.34,.15,0,material);
      batch.rod(machine?'#a4966c':'#66533e',[-w*.4,.58,z*.28],[w*.27,.13,-z*.31],.045,material);
      if(kind==='hub'||kind==='workshop')batch.cube(machine?'#687966':'#8e8773',-.16,.7,.12,.25,1.1,.3,0,material);
    }
    const rubble=cached('rubble',()=>new THREE.IcosahedronGeometry(1,0));
    for(let i=0;i<6;i++){const a=i*2.39,xx=Math.cos(a)*w*.5,zz=Math.sin(a)*z*.5;batch.add(rubble,machine?'#8b816b':hive?'#908088':'#a2957b',[xx,.12,zz],[.16,.12,.19],[i,.4,i*.23],material);}
  }
  function scaffoldTemplate(batch,species,kind) {
    const [w,h,d]=DIMENSIONS[kind],machine=species==='machine',hive=species==='hive';
    const color=machine?'#b2a267':hive?'#b7ab9b':'#b89865',material=machine?'metal':'solid';
    batch.cube(machine?'#6e7d69':hive?'#8d847c':'#a29578',0,.045,0,w+.12,.09,d+.12,0,material);
    for(const x of [-w*.52,w*.52])for(const z of [-d*.52,d*.52])batch.rod(color,[x,.06,z],[x,h*.93,z],.029,material);
    for(const y of [h*.35,h*.7])for(const z of [-d*.52,d*.52])batch.rod(color,[-w*.52,y,z],[w*.52,y,z],.026,material);
    for(const x of [-w*.52,w*.52])batch.rod(color,[x,.16,-d*.52],[x,h*.7,d*.52],.023,material);
    if(hive){batch.rod('#d0c2b1',[-w*.52,h*.7,0],[0,h*1.05,0],.027);batch.rod('#d0c2b1',[0,h*1.05,0],[w*.52,h*.7,0],.027);}
    else {batch.cube(machine?'#859481':'#ac9369',0,h*.36,-d*.57,w+.28,.044,.29,0,material);for(let i=0;i<6;i++)batch.rod(color,[w*.59,i*h*.12,-d*.3],[w*.59,i*h*.12,d*.06],.018,material);}
    batch.cube('#ffffff',-w*.47,.22,-d*.56,.24,.17,.025,0,'accent');
  }
  function shelterTemplate(batch,species) {
    if(species==='hive'){batch.sphere('#b9afa0',0,.27,0,.56,.36,.44);batch.sphere('#6f6967',0,.17,-.34,.19,.2,.1);batch.rod('#8b7c87',[-.45,.06,0],[0,.66,.08],.025);batch.rod('#8b7c87',[0,.66,.08],[.45,.06,0],.025);}
    else {batch.add(roof(),species==='machine'?'#b2b08b':'#cbb28c',[0,.12,0],[1.11,1.34,1.03]);batch.rod('#817251',[-.5,.04,-.45],[0,.74,-.45],.029);batch.rod('#817251',[0,.74,-.45],[.5,.04,-.45],.029);batch.cube('#5e5846',0,.18,-.51,.35,.33,.024);}
    batch.cube('#ffffff',-.25,.27,-.52,.18,.12,.025,0,'accent');
  }
  function getTemplate(species,kind,lod,mode='building') {
    const key=`${species}:${kind}:${lod}:${mode}`;
    if(pools.has(key))return pools.get(key);
    const batch=new Batch();
    if(mode==='ruin')ruinTemplate(batch,species,kind);
    else if(mode==='scaffold')scaffoldTemplate(batch,species,kind);
    else if(mode==='shelter')shelterTemplate(batch,species);
    else if(mode==='road')batch.cube('#ffffff',0,0,0,1,.035,1);
    else if(species==='machine')machineBuilding(batch,kind,lod==='near');
    else if(species==='hive')hiveBuilding(batch,kind,lod==='near');
    else humanBuilding(batch,kind,lod==='near');
    const meshes=batch.finish().map(source=>{
      const capacity=64;
      source.geometry.setAttribute('buildLimit',new THREE.InstancedBufferAttribute(new Float32Array(capacity).fill(100),1));
      const mesh=new THREE.InstancedMesh(source.geometry,source.material,capacity);
      mesh.name=`${mode} ${species} ${kind} ${lod} ${source.userData.materialKind}`;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.userData={...source.userData,capacity};mesh.count=0;mesh.frustumCulled=false;
      mesh.castShadow=mode!=='road'&&source.userData.materialKind!=='glow';mesh.receiveShadow=source.userData.materialKind!=='glow';mesh.customDepthMaterial=depthMaterial;
      root.add(mesh);return mesh;
    });
    const pool={meshes,count:0,key};pools.set(key,pool);return pool;
  }
  function growPoolMesh(pool,index) {
    const old=pool.meshes[index],capacity=old.userData.capacity*2;
    const buildLimit=new Float32Array(capacity).fill(100);buildLimit.set(old.geometry.attributes.buildLimit.array);
    old.geometry.setAttribute('buildLimit',new THREE.InstancedBufferAttribute(buildLimit,1));
    const mesh=new THREE.InstancedMesh(old.geometry,old.material,capacity);
    mesh.name=old.name;mesh.userData={...old.userData,capacity};mesh.frustumCulled=false;mesh.castShadow=old.castShadow;mesh.receiveShadow=old.receiveShadow;mesh.customDepthMaterial=depthMaterial;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);mesh.instanceMatrix.array.set(old.instanceMatrix.array);
    if(old.instanceColor){mesh.instanceColor=new THREE.InstancedBufferAttribute(new Float32Array(capacity*3).fill(1),3);mesh.instanceColor.array.set(old.instanceColor.array);}
    mesh.count=pool.count;root.remove(old);old.dispose();root.add(mesh);pool.meshes[index]=mesh;return mesh;
  }
  function instance(pool,x,y,z,rotation,sx,sy,sz,color,limit=100,allColor=false) {
    temp.position.set(x,y,z);temp.rotation.set(0,rotation||0,0);temp.scale.set(sx,sy,sz);temp.updateMatrix();
    for(let i=0;i<pool.meshes.length;i++){
      let mesh=pool.meshes[i];if(pool.count>=mesh.userData.capacity)mesh=growPoolMesh(pool,i);
      mesh.setMatrixAt(pool.count,temp.matrix);mesh.setColorAt(pool.count,allColor||mesh.userData.materialKind==='accent'?color:white);
      mesh.geometry.attributes.buildLimit.setX(pool.count,limit);
    }
    pool.count++;
  }
  function conditionOf(s){return s.status==='ruin'||s.population<=0?'ruin':s.status==='camp'?'camp':'active';}
  function ground(x,z,id,seed) {
    let entry=buildingGround.get(id);
    if(!entry||entry.x!==x||entry.z!==z){entry={x,z,y:heightAt(x,z,seed)};buildingGround.set(id,entry);}
    return entry.y;
  }

  const pickGeometry=cached('building-pick',()=>new THREE.CylinderGeometry(1,1,1,8));
  const haloMaterial=new THREE.LineBasicMaterial({color:'#ffe1a1',transparent:true,opacity:.75,depthWrite:false});
  const halo=new THREE.LineSegments(new THREE.BufferGeometry(),haloMaterial);halo.frustumCulled=false;halo.renderOrder=3;root.add(halo);
  let haloKey='';
  function updateHalo(state,time,selectedId) {
    const s=state.settlements.find(s=>s.id===selectedId);
    if(!s){halo.visible=false;haloKey='';return;}halo.visible=true;
    const radius=Math.max(3,s.radius||8),key=`${state.seed}:${s.id}:${s.x}:${s.z}:${radius}`;
    if(key!==haloKey){
      haloKey=key;const points=[];
      for(let i=0;i<128;i++){if(i%7===6)continue;for(const end of [0,.8]){const angle=(i+end)/128*Math.PI*2,x=s.x+Math.cos(angle)*radius,z=s.z+Math.sin(angle)*radius;points.push(x,heightAt(x,z,state.seed)+.085,z);}}
      halo.geometry.dispose();halo.geometry=new THREE.BufferGeometry();halo.geometry.setAttribute('position',new THREE.Float32BufferAttribute(points,3));
    }
    haloMaterial.opacity=.68+Math.sin(time*1.8)*.12;
  }
  const roadColors={human:new THREE.Color('#ac9b75'),machine:new THREE.Color('#748571'),hive:new THREE.Color('#a09492')};
  function roadNetwork(s,buildings,state,view) {
    const key=buildings.map(b=>`${b.id}:${b.x}:${b.z}`).join('|');
    if(view.roadKey===key)return view.roads;
    view.roadKey=key;const segments=[];
    const hub=buildings.find(b=>b.kind==='hub')||s;
    const connected=[hub];
    const ordered=buildings.filter(b=>b!==hub).slice().sort((a,b)=>Math.hypot(a.x-hub.x,a.z-hub.z)-Math.hypot(b.x-hub.x,b.z-hub.z));
    for(const building of ordered){
      let nearest=connected[0],distance=Infinity;
      for(const candidate of connected){const d=Math.hypot(candidate.x-building.x,candidate.z-building.z);if(d<distance){distance=d;nearest=candidate;}}
      connected.push(building);if(distance<2.25)continue;
      const dx=building.x-nearest.x,dz=building.z-nearest.z,rotation=Math.atan2(dx,dz),length=Math.max(.1,distance-1.65),pieces=Math.ceil(length/1.25);
      for(let i=0;i<pieces;i++){
        const f=(.8+(i+.5)*length/pieces)/distance,x=nearest.x+dx*f,z=nearest.z+dz*f;
        segments.push({x,z,y:heightAt(x,z,state.seed)+.025,rotation,length:length/pieces+.02});
      }
    }
    view.roads=segments;return segments;
  }

  function update(state,time=0,selectedId=null,alpha=0) {
    if(disposed||!state)return;
    if(lastSeed!==state.seed){lastSeed=state.seed;lastRevision='';buildingGround.clear();settlements.clear();haloKey='';}
    updateHalo(state,time,selectedId);
    const camera=scene.userData.camera;
    const lodKey=camera?`${Math.round(camera.position.x/12)}:${Math.round(camera.position.y/12)}:${Math.round(camera.position.z/12)}`:'default';
    // Building work changes on simulation cycles. The small structural digest
    // also handles reset, refounding and direct inspection fixtures immediately.
    const revision=`${state.seed}:${state.tick}:${lodKey}|`+state.settlements.map(s=>`${s.id}:${conditionOf(s)}:${s.radius}:${s.factionId}:`+(s.buildings||[]).map(b=>`${b.id}:${b.kind}:${b.x}:${b.z}:${b.rotation}:${b.progress}`).join(',')).join('|');
    if(revision===lastRevision)return;lastRevision=revision;
    for(const pool of pools.values())pool.count=0;
    for(const key of ['buildingRecords','completedBuildings','constructionSites','renderedBuildings','nearBuildings','farBuildings','ruinedBuildings','temporaryShelters','roadSegments','instances','drawCallsEstimate','camps','ruins'])diagnostics[key]=0;
    diagnostics.byKind=Object.fromEntries(KINDS.map(k=>[k,0]));diagnostics.bySpecies={human:0,machine:0,hive:0};diagnostics.settlements=state.settlements.length;diagnostics.minRadius=Infinity;diagnostics.maxRadius=0;
    const factions=new Map(state.factions.map(f=>[f.id,f]));const live=new Set();pickables=[];
    for(const s of state.settlements){
      const faction=factions.get(s.factionId)||factions.get(s.lastFactionId);if(!faction)continue;
      const species=['human','machine','hive'].includes(faction.species)?faction.species:'human',condition=conditionOf(s),color=new THREE.Color(faction.color||'#b9c09b');
      const radius=Math.max(3,s.radius||8),base=ground(s.x,s.z,`settlement:${s.id}`,state.seed),distance=camera?camera.position.distanceTo(new THREE.Vector3(s.x,base,s.z)):100;
      const lod=distance>175?'far':'near';
      diagnostics.minRadius=Math.min(diagnostics.minRadius,radius);diagnostics.maxRadius=Math.max(diagnostics.maxRadius,radius);if(condition==='camp')diagnostics.camps++;if(condition==='ruin')diagnostics.ruins++;
      let view=settlements.get(s.id);if(!view){view={proxies:new Map(),roadKey:'',roads:[]};settlements.set(s.id,view);}live.add(s.id);
      const records=(s.buildings||[]).filter(b=>Number.isFinite(b.x)&&Number.isFinite(b.z));
      const liveBuildings=new Set();
      for(const building of records){
        const kind=KINDS.includes(building.kind)?building.kind:'housing',progress=clamp(Number.isFinite(building.progress)?building.progress:1,0,1),d=DIMENSIONS[kind];
        const y=ground(building.x,building.z,`building:${s.id}:${building.id}`,state.seed)+.025,rotation=building.rotation||0;
        diagnostics.buildingRecords++;diagnostics.byKind[kind]++;diagnostics.bySpecies[species]++;diagnostics.renderedBuildings++;diagnostics[lod==='near'?'nearBuildings':'farBuildings']++;
        if(condition!=='active'){
          instance(getTemplate(species,kind,'far','ruin'),building.x,y,building.z,rotation,1,1,1,color);diagnostics.ruinedBuildings++;
        }else{
          const pool=getTemplate(species,kind,lod);
          instance(pool,building.x,y,building.z,rotation,1,1,1,color,progress>=1?100:Math.max(.09,d[1]*progress));
          if(progress<1){instance(getTemplate(species,kind,'near','scaffold'),building.x,y,building.z,rotation,1,.35+progress*.65,1,color);diagnostics.constructionSites++;}
          else diagnostics.completedBuildings++;
        }
        let proxy=view.proxies.get(building.id);if(!proxy){proxy=new THREE.Mesh(pickGeometry,materials.solid);view.proxies.set(building.id,proxy);}
        const h=condition==='active'?Math.max(.35,d[1]*(progress<1?progress:1)):1;
        proxy.position.set(building.x,y+h*.5,building.z);proxy.scale.set(Math.max(d[0],d[2])*.53,h,Math.max(d[0],d[2])*.53);proxy.updateMatrixWorld(true);proxy.userData={settlementId:s.id,buildingId:building.id};pickables.push(proxy);liveBuildings.add(building.id);
      }
      for(const id of view.proxies.keys())if(!liveBuildings.has(id))view.proxies.delete(id);
      if(condition==='active')for(const road of roadNetwork(s,records,state,view)){
        instance(getTemplate('human','housing','far','road'),road.x,road.y,road.z,road.rotation,.28,1,road.length,roadColors[species],100,true);diagnostics.roadSegments++;
      }
      if(condition==='camp'){
        const shelterCount=clamp(Math.ceil(s.population/30),1,4);
        for(let i=0;i<shelterCount;i++){
          const a=i/shelterCount*Math.PI*2+.5,x=s.x+Math.cos(a)*2.1,z=s.z+Math.sin(a)*2.1;
          instance(getTemplate(species,'housing','near','shelter'),x,heightAt(x,z,state.seed),z,a,1,1,1,color);diagnostics.temporaryShelters++;
        }
      }
      // An empty camp/ruin remains inspectable even if its building records were
      // removed by the simulation. This is a pick target, never a fake structure.
      if(records.length===0){if(!view.emptyProxy)view.emptyProxy=new THREE.Mesh(pickGeometry,materials.solid);view.emptyProxy.position.set(s.x,base+.3,s.z);view.emptyProxy.scale.set(2,.6,2);view.emptyProxy.userData={settlementId:s.id};view.emptyProxy.updateMatrixWorld(true);pickables.push(view.emptyProxy);}
    }
    for(const id of settlements.keys())if(!live.has(id))settlements.delete(id);
    for(const pool of pools.values())for(const mesh of pool.meshes){
      mesh.count=pool.count;if(!pool.count)continue;mesh.instanceMatrix.needsUpdate=true;if(mesh.instanceColor)mesh.instanceColor.needsUpdate=true;mesh.geometry.attributes.buildLimit.needsUpdate=true;
      diagnostics.instances+=pool.count;diagnostics.drawCallsEstimate++;
    }
    if(!Number.isFinite(diagnostics.minRadius))diagnostics.minRadius=0;
  }
  function dispose(){
    if(disposed)return;disposed=true;
    for(const pool of pools.values())for(const mesh of pool.meshes){mesh.dispose();mesh.geometry.dispose();}
    pools.clear();settlements.clear();buildingGround.clear();
    for(const geometry of geometryCache.values())geometry.dispose();
    for(const material of Object.values(materials))material.dispose();depthMaterial.dispose();halo.geometry.dispose();haloMaterial.dispose();root.removeFromParent();pickables=[];
  }
  return {update,getPickables:()=>pickables,dispose,diagnostics};
}
