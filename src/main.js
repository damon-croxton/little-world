import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {EffectComposer} from 'three/addons/postprocessing/EffectComposer.js';
import {RenderPass} from 'three/addons/postprocessing/RenderPass.js';
import {UnrealBloomPass} from 'three/addons/postprocessing/UnrealBloomPass.js';
import {OutputPass} from 'three/addons/postprocessing/OutputPass.js';
import {createSimulation,stepSimulation} from './sim/core.js';
import {heightAt,WORLD_RADIUS} from './world.js';
import {createTerrain} from './render/terrain.js';
import {createEntities} from './render/entities.js';
import {createCrowds} from './render/crowds.js';
import {createUI} from './ui.js';
import {SimulationClock,SIM_DT} from './clock.js';

const root=document.getElementById('app'), labelRoot=document.getElementById('world-labels');
const params=new URLSearchParams(location.search);
let state=createSimulation(params.get('seed')||'first-light');
const view={speed:1,paused:false,selectedId:'s0',followId:null,overlay:'none',cinematic:false,quality:'high',fps:0,diagnostics:{},advancing:null};
const scene=new THREE.Scene();
scene.background=new THREE.Color('#879fa4');
scene.fog=new THREE.FogExp2('#96aca9',.00085);
const camera=new THREE.PerspectiveCamera(40,innerWidth/innerHeight,.2,1800);
const overviewPosition=new THREE.Vector3(250,255,320),overviewTarget=new THREE.Vector3(0,4,0);
camera.position.copy(overviewPosition);scene.userData.camera=camera;scene.userData.crowdCamera=camera;
let renderer;
try{renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:'high-performance',preserveDrawingBuffer:true});}
catch(error){document.getElementById('boot').innerHTML='<h1>WebGL could not start</h1><p>Open LittleWorld V2 in a browser with hardware acceleration.</p>';throw error;}
renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.setSize(innerWidth,innerHeight);
renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.02;renderer.info.autoReset=false;
root.appendChild(renderer.domElement);renderer.domElement.setAttribute('aria-label','LittleWorld V2: drag to orbit, scroll to zoom, click settlements, moving parties or resources.');
const controls=new OrbitControls(camera,renderer.domElement);
controls.target.copy(overviewTarget);controls.enableDamping=true;controls.dampingFactor=.07;
controls.minDistance=9;controls.maxDistance=700;controls.maxPolarAngle=Math.PI*.465;controls.minPolarAngle=.12;controls.panSpeed=.75;
scene.add(new THREE.HemisphereLight('#d9f4f0','#574a36',1.25));
const sun=new THREE.DirectionalLight('#ffe8ba',3.2);sun.position.set(-130,250,130);sun.castShadow=true;
sun.shadow.mapSize.set(2048,2048);Object.assign(sun.shadow.camera,{left:-185,right:185,top:185,bottom:-185,near:1,far:700});
sun.shadow.bias=-.0002;sun.shadow.normalBias=.12;sun.shadow.radius=3;scene.add(sun);
const rim=new THREE.DirectionalLight('#87bad5',.75);rim.position.set(90,60,-110);scene.add(rim);
const composer=new EffectComposer(renderer);composer.addPass(new RenderPass(scene,camera));
const bloom=new UnrealBloomPass(new THREE.Vector2(innerWidth,innerHeight),.15,.55,1.12);composer.addPass(bloom);composer.addPass(new OutputPass());
let terrain=createTerrain(THREE,scene,state.seed),entities=createEntities(THREE,scene),crowds=createCrowds(THREE,scene);
const simClock=new SimulationClock();
const overlayGroup=new THREE.Group();scene.add(overlayGroup);
const labels=new Map();let labelOccluders=[],cameraGoal=null,overlayKey='',ui=null,advanceGeneration=0;
const ray=new THREE.Raycaster(),pointer=new THREE.Vector2(),vec=new THREE.Vector3(),groundPlane=new THREE.Plane(new THREE.Vector3(0,1,0),-3);
const byId=id=>state.settlements.find(s=>s.id===id)||state.groups.find(g=>g.id===id)||state.nodes.find(n=>n.id===id);
function visualPosition(o,alpha=simClock.alpha){return {x:Number.isFinite(o.prevX)?THREE.MathUtils.lerp(o.prevX,o.x,alpha):o.x,z:Number.isFinite(o.prevZ)?THREE.MathUtils.lerp(o.prevZ,o.z,alpha):o.z};}
function select(id){if(!byId(id)){const s=state.settlements.find(s=>s.factionId===id);if(s)id=s.id;else return;}view.selectedId=id;overlayKey='';refreshUI();}
function focus(id,close=true){const o=byId(id);if(!o)return;select(id);view.followId=id;const p=visualPosition(o),y=heightAt(p.x,p.z,state.seed),radius=o.radius||Math.max(7,Math.sqrt(o.population||0)*.5);const d=close?Math.max(18,radius*1.7):Math.max(40,radius*3);cameraGoal={target:new THREE.Vector3(p.x,y+1,p.z),position:new THREE.Vector3(p.x+d*.75,y+d*.65,p.z+d)};}
function reset(seed){advanceGeneration++;view.advancing=null;const next=String(seed||'first-light').trim().slice(0,80)||'first-light';state=createSimulation(next);simClock.reset();terrain.dispose();entities.dispose();crowds.dispose();terrain=createTerrain(THREE,scene,state.seed);entities=createEntities(THREE,scene);crowds=createCrowds(THREE,scene);view.selectedId='s0';view.followId=null;view.cinematic=false;cameraGoal={target:overviewTarget.clone(),position:overviewPosition.clone()};overlayKey='';for(const el of labels.values())el.remove();labels.clear();refreshUI();}
function setQuality(q){view.quality=q;renderer.setPixelRatio(Math.min(devicePixelRatio,q==='low'?1:1.5));renderer.shadowMap.enabled=q!=='low';bloom.enabled=q!=='low';scene.userData.quality=q;resize();}
async function advance(cycles=1200){if(view.advancing)return;const token=++advanceGeneration,n=Math.max(0,Math.min(10000,Math.floor(cycles))),wasPaused=view.paused;view.paused=true;view.advancing={done:0,total:n};refreshUI();for(let done=0;done<n;){if(token!==advanceGeneration)return;const chunk=Math.min(25,n-done);stepSimulation(state,chunk*10);done+=chunk;view.advancing={done,total:n};refreshUI();await new Promise(requestAnimationFrame);}if(token===advanceGeneration){view.advancing=null;view.paused=wasPaused;simClock.reset();refreshUI();}}
const actions={
  setSpeed(n){view.speed=Number(n);view.paused=n===0;refreshUI();},
  togglePause(){view.paused=!view.paused;refreshUI();},reset,select,selectResource:select,advance,
  follow(id){if(id===null){view.followId=null;cameraGoal=null;}else focus(id||view.selectedId,true);},
  setOverlay(mode){view.overlay=mode;overlayKey='';refreshUI();},
  setCinematic(value){view.cinematic=Boolean(value);if(view.cinematic)focus(view.selectedId||state.settlements[0].id,true);else cameraGoal={target:overviewTarget.clone(),position:overviewPosition.clone()};refreshUI();},
  setQuality
};
ui=createUI(document.getElementById('ui'),actions);
function readDiagnostics(rendererPart){return typeof rendererPart.diagnostics==='function'?rendererPart.diagnostics():rendererPart.diagnostics||{};}
function diagnostics(){const c=readDiagnostics(crowds),b=readDiagnostics(entities),t=readDiagnostics(terrain);return {fps:view.fps,frameMs:view.frameMs||0,drawCalls:renderer.info.render.calls,calls:renderer.info.render.calls,triangles:renderer.info.render.triangles,geometries:renderer.info.memory.geometries,textures:renderer.info.memory.textures,groups:state.groups.length,totalPopulation:state.settlements.reduce((n,s)=>n+s.population,0),visibleIndividuals:c.visibleIndividuals,representedIndividuals:c.representedIndividuals,crowds:c,buildings:b,terrain:t};}
function refreshUI(){if(!ui)return;view.diagnostics=diagnostics();ui.update(state,view);labelOccluders=[...document.querySelectorAll('.atlas-brand,.time-console,.faction-index,.inspector,.chronicle,.observation-console,.atlas-settings,.field-guide,.first-light-note,.scale-reading')].filter(el=>el.getClientRects().length).map(el=>el.getBoundingClientRect());}
function clearOverlay(){for(const o of [...overlayGroup.children]){overlayGroup.remove(o);o.geometry?.dispose();o.material?.dispose();}}
function updateOverlay(){
  const key=state.tick+':'+view.overlay+':'+view.selectedId;if(key===overlayKey)return;overlayKey=key;clearOverlay();if(view.overlay==='none')return;
  const positions=[],colors=[];const c=new THREE.Color();const add=(a,b,color)=>{c.set(color);positions.push(a.x,a.y,a.z,b.x,b.y,b.z);colors.push(c.r,c.g,c.b,c.r,c.g,c.b);};
  function route(a,b,color,dashed=false){const ay=heightAt(a.x,a.z,state.seed)+.5,by=heightAt(b.x,b.z,state.seed)+.5;for(let i=0;i<12;i++){if(dashed&&i%2)continue;const f=i/12,g=(i+1)/12;add({x:THREE.MathUtils.lerp(a.x,b.x,f),y:THREE.MathUtils.lerp(ay,by,f)+Math.sin(f*Math.PI)*2,z:THREE.MathUtils.lerp(a.z,b.z,f)},{x:THREE.MathUtils.lerp(a.x,b.x,g),y:THREE.MathUtils.lerp(ay,by,g)+Math.sin(g*Math.PI)*2,z:THREE.MathUtils.lerp(a.z,b.z,g)},color);}}
  if(view.overlay==='routes')for(const g of state.groups){const f=state.factions.find(f=>f.id===g.factionId);if(Number.isFinite(g.targetX)&&Number.isFinite(g.targetZ))route(g,{x:g.targetX,z:g.targetZ},f?.color||'#fff',g.kind==='scout');}
  if(view.overlay==='territory')for(const s of state.settlements){const f=state.factions.find(f=>f.id===s.factionId),r=(s.radius||10)+5;for(let i=0;i<64;i++){const a=i/64*Math.PI*2,b=(i+1)/64*Math.PI*2,x=s.x+Math.cos(a)*r,z=s.z+Math.sin(a)*r,xx=s.x+Math.cos(b)*r,zz=s.z+Math.sin(b)*r;add({x,y:heightAt(x,z,state.seed)+.3,z},{x:xx,y:heightAt(xx,zz,state.seed)+.3,z:zz},f?.color||'#fff');}}
  if(view.overlay==='knowledge'){const selected=byId(view.selectedId),f=state.factions.find(f=>f.id===selected?.factionId)||state.factions[0],home=state.settlements.find(s=>s.factionId===f.id);if(home)for(const k of Object.values(f.knowledge))if(Number.isFinite(k.x)&&Number.isFinite(k.z))route(home,k,k.kind==='settlement'?'#ffc595':'#8ae5bb',true);}
  if(positions.length){const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));overlayGroup.add(new THREE.LineSegments(geometry,new THREE.LineBasicMaterial({vertexColors:true,transparent:true,opacity:.65,depthTest:false})));}
  if(view.overlay==='resources'){const p=[],col=[];for(const n of state.nodes){p.push(n.x,heightAt(n.x,n.z,state.seed)+1.6,n.z);c.set({food:'#a8d97b',water:'#79cfe4',energy:'#c3a2ff',materials:'#eab66d'}[n.kind]).multiplyScalar(.3+.7*n.amount/Math.max(1,n.maxAmount||n.amount));col.push(c.r,c.g,c.b);}const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(p,3));geo.setAttribute('color',new THREE.Float32BufferAttribute(col,3));overlayGroup.add(new THREE.Points(geo,new THREE.PointsMaterial({size:6,sizeAttenuation:false,vertexColors:true,depthTest:false})));}
}
function updateLabels(){
  const used=[];const ordered=[...state.settlements].sort((a,b)=>(b.id===view.selectedId)-(a.id===view.selectedId)||b.population-a.population);
  for(const s of ordered){let el=labels.get(s.id);if(!el){el=document.createElement('button');el.className='world-label';const f=state.factions.find(f=>f.id===s.factionId);el.style.setProperty('--faction-color',f?.color||'#fff');el.title='Inspect '+s.name;el.addEventListener('click',()=>select(s.id));el.addEventListener('dblclick',()=>focus(s.id));labelRoot.appendChild(el);labels.set(s.id,el);}
    vec.set(s.x,heightAt(s.x,s.z,state.seed)+(s.radius||8)*.3+3,s.z).project(camera);const x=(vec.x*.5+.5)*innerWidth,y=(-vec.y*.5+.5)*innerHeight;
    el.textContent=s.name+(s.status==='ruin'?' · ruins':s.status==='camp'?' · refuge':'');el.style.left=x+'px';el.style.top=y+'px';
    const occluded=!document.body.classList.contains('hide-ui')&&labelOccluders.some(r=>x+65>r.left&&x-65<r.right&&y>r.top&&y-25<r.bottom);
    const collision=used.some(p=>Math.abs(p.x-x)<115&&Math.abs(p.y-y)<29),show=vec.z<1&&x>20&&x<innerWidth-20&&y>80&&y<innerHeight-75&&!view.cinematic&&!occluded&&!collision;
    el.style.display=show?'':'none';if(show)used.push({x,y});el.classList.toggle('selected',s.id===view.selectedId);
  }
  for(const [id,el]of labels)if(!state.settlements.some(s=>s.id===id)){el.remove();labels.delete(id);}
}
let pointerDown=null;
renderer.domElement.addEventListener('pointerdown',e=>{pointerDown={x:e.clientX,y:e.clientY};});
renderer.domElement.addEventListener('pointerup',e=>{
  if(!pointerDown||Math.hypot(pointerDown.x-e.clientX,pointerDown.y-e.clientY)>5)return;
  pointer.set(e.clientX/innerWidth*2-1,-e.clientY/innerHeight*2+1);ray.setFromCamera(pointer,camera);
  const hit=ray.intersectObjects([...entities.getPickables(),...crowds.getPickables()],true)[0];
  if(hit){const resolved=crowds.resolvePick?.(hit)||entities.resolvePick?.(hit);if(resolved){select(resolved);return;}let o=hit.object;while(o&&!o.userData.settlementId&&!o.userData.groupId)o=o.parent;if(o){select(o.userData.settlementId||o.userData.groupId);return;}}
  const nodeId=terrain.pickResource?.(ray);if(nodeId){select(typeof nodeId==='string'?nodeId:nodeId.id);return;}
  const point=ray.ray.intersectPlane(groundPlane,new THREE.Vector3());if(point){const node=state.nodes.map(n=>({n,d:Math.hypot(n.x-point.x,n.z-point.z)})).sort((a,b)=>a.d-b.d)[0];if(node&&node.d<(node.n.radius||3)+2)select(node.n.id);}
});
controls.addEventListener('start',()=>{cameraGoal=null;view.followId=null;view.cinematic=false;});
window.addEventListener('keydown',e=>{if(e.target.matches('input,textarea,select'))return;
  if(e.code==='Space'){e.preventDefault();actions.togglePause();}
  if(['1','2','3','4'].includes(e.key))actions.setSpeed([1,4,16,32][Number(e.key)-1]);
  if(e.key.toLowerCase()==='f')focus(view.selectedId);if(e.key.toLowerCase()==='c')actions.setCinematic(!view.cinematic);
  if(e.key.toLowerCase()==='h')document.body.classList.toggle('hide-ui');
  if(e.key==='Escape'){view.cinematic=false;view.followId=null;cameraGoal={target:overviewTarget.clone(),position:overviewPosition.clone()};}
});
function resize(){camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);composer.setSize(innerWidth,innerHeight);}
window.addEventListener('resize',resize);
let then=performance.now(),uiTimer=0,frameCount=0,fpsTime=0,wallTime=0;
document.addEventListener('visibilitychange',()=>{then=performance.now();});
function frame(now){
  requestAnimationFrame(frame);const dt=Math.max(0,(now-then)/1000);then=now;if(document.hidden)return;wallTime+=dt;
  simClock.advance(dt,view.speed,view.paused||Boolean(view.advancing),n=>stepSimulation(state,n));
  const alpha=simClock.alpha,simTime=Math.max(0,(state.time??state.tick)-SIM_DT+alpha*SIM_DT);
  if(view.followId&&!cameraGoal&&!view.cinematic){const o=byId(view.followId);if(o){const p=visualPosition(o,alpha),desired=new THREE.Vector3(p.x,heightAt(p.x,p.z,state.seed)+1,p.z),delta=desired.sub(controls.target);controls.target.addScaledVector(delta,1-Math.exp(-dt*5));camera.position.addScaledVector(delta,1-Math.exp(-dt*5));}else view.followId=null;}
  if(view.cinematic){const o=byId(view.followId||view.selectedId);if(o){const p=visualPosition(o,alpha),y=heightAt(p.x,p.z,state.seed),r=Math.max(24,(o.radius||8)*2.3),a=wallTime*.025;cameraGoal={target:new THREE.Vector3(p.x,y+2,p.z),position:new THREE.Vector3(p.x+Math.sin(a)*r,y+r*.48,p.z+Math.cos(a)*r)};}}
  if(cameraGoal){const k=1-Math.exp(-dt*2.6);camera.position.lerp(cameraGoal.position,k);controls.target.lerp(cameraGoal.target,k);if(!view.cinematic&&camera.position.distanceTo(cameraGoal.position)<.08)cameraGoal=null;}
  controls.update();camera.updateMatrixWorld();
  terrain.update?.(simTime,state,alpha);entities.update(state,simTime,view.selectedId,alpha);crowds.update(state,simTime,view.selectedId,alpha);
  updateOverlay();updateLabels();renderer.info.reset();composer.render();
  uiTimer+=dt;frameCount++;fpsTime+=dt;if(fpsTime>=1){view.fps=Math.round(frameCount/fpsTime);view.frameMs=fpsTime/frameCount*1000;frameCount=0;fpsTime=0;}
  if(uiTimer>.25){refreshUI();uiTimer=0;}
}
window.littleworld={
  get state(){return state;},view,actions,reset,select,advance,
  step(cycles){stepSimulation(state,Math.max(0,Math.floor(cycles))*10);simClock.reset();refreshUI();},
  stepPulses(n){stepSimulation(state,n);refreshUI();},
  renderer,camera,scene,controls,clock:simClock,
  get renderers(){return {terrain,buildings:entities,crowds};},
  get diagnostics(){return diagnostics();},
  getMotionSamples(){return crowds.getMotionSamples?.()||[];}
};
refreshUI();document.getElementById('boot').remove();requestAnimationFrame(frame);
if(Number(params.get('evolve'))>0)setTimeout(()=>advance(Number(params.get('evolve'))),300);
