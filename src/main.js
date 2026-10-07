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
import {overviewFrame} from './render/overview.js';
import {createUI} from './ui.js';
import {normalizeConfig} from './config.js';
import {PointerGestures} from './input.js';
import {findObserved,SelectionMemory,knowledgeOverlaySource,factionFocusTarget,scenePickId,observedGroupController} from './selection.js';
import {factionView} from './sim/knowledge.js';
import {settlementController} from './sim/control.js';
import {createFog} from './render/fog.js';
import {createCombatEffects} from './render/combat.js';
import {SimulationClock,SIM_DT} from './clock.js';

const root=document.getElementById('app'), labelRoot=document.getElementById('world-labels');
const viewport=()=>({width:Math.max(1,root.clientWidth||innerWidth),height:Math.max(1,root.clientHeight||window.visualViewport?.height||innerHeight)});
const initialViewport=viewport();
const params=new URLSearchParams(location.search);
const initialQuality=params.get('quality')==='low'||((innerWidth<=800||innerHeight<=560)&&window.matchMedia?.('(pointer: coarse)').matches)?'low':'high';
let state=createSimulation(params.get('seed')||'first-light',normalizeConfig({civCount:params.get('civs')??undefined,biome:params.get('biome')??undefined}));
let shownState=state;
const view={victoryObserved:null,outcomeDismissed:false,worldGeneration:0,perspective:'omniscient',perspectiveOptions:[],speed:2,paused:false,selectedId:'s0',followId:null,overlay:'none',cinematic:false,quality:initialQuality,fps:0,diagnostics:{},advancing:null};
let renderedPerspective=null;
const scene=new THREE.Scene();
scene.userData.crowdViewport={...initialViewport};
scene.background=new THREE.Color('#879fa4');
scene.fog=new THREE.FogExp2('#96aca9',.00085);
const camera=new THREE.PerspectiveCamera(40,initialViewport.width/initialViewport.height,.2,2400);
const overviewPosition=new THREE.Vector3(),overviewTarget=new THREE.Vector3();
let overviewLocked=true;
function fitOverview(){const frame=overviewFrame(camera.aspect,camera.fov,WORLD_RADIUS);overviewPosition.copy(frame.position);overviewTarget.copy(frame.target);}
fitOverview();
camera.position.copy(overviewPosition);scene.userData.camera=camera;scene.userData.crowdCamera=camera;
let renderer;
try{renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:'high-performance',preserveDrawingBuffer:true});}
catch(error){document.getElementById('boot').innerHTML='<h1>WebGL could not start</h1><p>Open LittleWorld V2 in a browser with hardware acceleration.</p>';throw error;}
renderer.setPixelRatio(Math.min(devicePixelRatio,view.quality==='low'?1:1.5));renderer.setSize(initialViewport.width,initialViewport.height,false);
renderer.shadowMap.enabled=view.quality!=='low';scene.userData.quality=view.quality;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.02;renderer.info.autoReset=false;
root.appendChild(renderer.domElement);renderer.domElement.tabIndex=0;renderer.domElement.style.touchAction='none';renderer.domElement.addEventListener('contextmenu',event=>event.preventDefault());renderer.domElement.addEventListener('touchmove',event=>event.preventDefault(),{passive:false});renderer.domElement.setAttribute('aria-label','LittleWorld V2: mouse drag orbits, right drag pans, scroll zooms. On touch, one finger pans; two fingers pinch to zoom and drag to orbit. Tap a settlement, party or resource to inspect.');
const controls=new OrbitControls(camera,renderer.domElement);
controls.target.copy(overviewTarget);controls.enableDamping=true;controls.dampingFactor=.07;
controls.minDistance=9;controls.maxDistance=Math.max(700,overviewPosition.distanceTo(overviewTarget)*1.05);controls.maxPolarAngle=Math.PI*.465;controls.minPolarAngle=.12;controls.panSpeed=.75;controls.touches.ONE=THREE.TOUCH.PAN;controls.touches.TWO=THREE.TOUCH.DOLLY_ROTATE;
scene.add(new THREE.HemisphereLight('#d9f4f0','#574a36',1.25));
const sun=new THREE.DirectionalLight('#ffe8ba',3.2);sun.position.set(-130,250,130);sun.castShadow=true;
sun.shadow.mapSize.set(2048,2048);Object.assign(sun.shadow.camera,{left:-185,right:185,top:185,bottom:-185,near:1,far:700});
sun.shadow.bias=-.0002;sun.shadow.normalBias=.12;sun.shadow.radius=3;scene.add(sun);
const rim=new THREE.DirectionalLight('#87bad5',.75);rim.position.set(90,60,-110);scene.add(rim);
const composer=new EffectComposer(renderer);composer.addPass(new RenderPass(scene,camera));
const bloom=new UnrealBloomPass(new THREE.Vector2(initialViewport.width,initialViewport.height),.15,.55,1.12);composer.addPass(bloom);bloom.enabled=view.quality!=='low';composer.addPass(new OutputPass());
let terrain=createTerrain(THREE,scene,state.seed,state.config),entities=createEntities(THREE,scene),crowds=createCrowds(THREE,scene),fog=createFog(THREE,scene),combatEffects=createCombatEffects(THREE,scene);
const simClock=new SimulationClock();
const overlayGroup=new THREE.Group();scene.add(overlayGroup);
const labels=new Map();let labelOccluders=[],cameraGoal=null,overlayKey='',ui=null,advanceGeneration=0;
const ray=new THREE.Raycaster(),pointer=new THREE.Vector2(),vec=new THREE.Vector3(),groundPlane=new THREE.Plane(new THREE.Vector3(0,1,0),-3);
function syncShownState(){shownState=factionView(state,view.perspective);return shownState;}
const selectionMemory=new SelectionMemory();
const byId=id=>findObserved(shownState,id);
function reconcileSelection(){view.selectedId=selectionMemory.reconcile(shownState,view.selectedId,view.perspective);}
function visualPosition(o,alpha=simClock.alpha){return {x:Number.isFinite(o.prevX)?THREE.MathUtils.lerp(o.prevX,o.x,alpha):o.x,z:Number.isFinite(o.prevZ)?THREE.MathUtils.lerp(o.prevZ,o.z,alpha):o.z};}
function select(id){syncShownState();if(!byId(id)){const s=shownState.settlements.find(s=>s.factionId===id);if(s)id=s.id;else return;}view.selectedId=id;selectionMemory.record(shownState,id);overlayKey='';refreshUI();ui?.revealSelection?.();}
function focus(id,close=true){const o=byId(id);if(!o)return;overviewLocked=false;view.followId=id;select(id);const p=visualPosition(o),y=heightAt(p.x,p.z,state.terrainSeed || state.seed),radius=o.radius||Math.max(7,Math.sqrt(o.population||0)*.5);const d=close?Math.max(18,radius*1.7):Math.max(40,radius*3);cameraGoal={target:new THREE.Vector3(p.x,y+1,p.z),position:new THREE.Vector3(p.x+d*.75,y+d*.65,p.z+d)};}
function reset(seed,options=state.config){
  advanceGeneration++;selectionMemory.clear();view.worldGeneration++;view.advancing=null;view.victoryObserved=null;view.outcomeDismissed=false;renderedPerspective=null;
  const next=String(seed||'first-light').trim().slice(0,80)||'first-light';
  state=createSimulation(next,normalizeConfig(options));simClock.reset();
  if(view.perspective!=='omniscient'&&!state.factions.some(f=>f.id===view.perspective))view.perspective='omniscient';
  terrain.dispose();entities.dispose();crowds.dispose();fog.dispose();combatEffects.dispose();
  terrain=createTerrain(THREE,scene,state.seed,state.config);entities=createEntities(THREE,scene);crowds=createCrowds(THREE,scene);fog=createFog(THREE,scene);combatEffects=createCombatEffects(THREE,scene);
  syncShownState();view.selectedId=(shownState.settlements.find(s=>s.factionId===view.perspective)||shownState.settlements[0])?.id||null;
  view.followId=null;view.cinematic=false;overviewLocked=true;fitOverview();controls.maxDistance=Math.max(700,overviewPosition.distanceTo(overviewTarget)*1.05);cameraGoal={target:overviewTarget.clone(),position:overviewPosition.clone()};overlayKey='';for(const el of labels.values())el.remove();labels.clear();refreshUI();
}
function setQuality(q){view.quality=q;renderer.setPixelRatio(Math.min(devicePixelRatio,q==='low'?1:1.5));renderer.shadowMap.enabled=q!=='low';bloom.enabled=q!=='low';scene.userData.quality=q;resize();}
function cancelAdvance(){
  if(!view.advancing)return false;
  advanceGeneration++;view.advancing=null;view.paused=true;simClock.reset();refreshUI();return true;
}
async function advance(cycles=1200){
  if(view.advancing)return {completed:false,reason:'busy',cycles:0};
  const token=++advanceGeneration,runState=state,n=Math.max(0,Math.min(10000,Math.floor(cycles))),wasPaused=view.paused;
  let done=0;
  const interrupted=()=>({completed:false,reason:state===runState?'cancelled':'reset',cycles:done});
  view.paused=true;view.advancing={done:0,total:n};refreshUI();
  for(;done<n;){
    if(token!==advanceGeneration)return interrupted();
    const chunk=Math.min(25,n-done);stepSimulation(state,chunk*10);done+=chunk;view.advancing={done,total:n};refreshUI();await new Promise(requestAnimationFrame);
  }
  if(token!==advanceGeneration)return interrupted();
  view.advancing=null;view.paused=wasPaused;simClock.reset();refreshUI();return {completed:true,cycles:n};
}
const actions={
  continueWatching(){view.outcomeDismissed=true;view.paused=false;refreshUI();},
  replay(){view.speed=2;view.paused=false;reset(state.seed,state.config);},
  newWorld(){view.speed=2;view.paused=false;reset(`world-${Date.now().toString(36)}`,state.config);},
  setSpeed(n){cancelAdvance();view.speed=Number(n);view.paused=n===0;refreshUI();},
  togglePause(){if(cancelAdvance())return;view.paused=!view.paused;refreshUI();},cancelAdvance,reset,select,selectResource:select,advance,
  overview(immediate=false){view.followId=null;view.cinematic=false;overviewLocked=true;fitOverview();controls.maxDistance=Math.max(700,overviewPosition.distanceTo(overviewTarget)*1.05);if(immediate){camera.position.copy(overviewPosition);controls.target.copy(overviewTarget);controls.update();cameraGoal=null;}else cameraGoal={target:overviewTarget.clone(),position:overviewPosition.clone()};refreshUI();},
  follow(id){if(id===null){view.followId=null;cameraGoal=null;overviewLocked=false;refreshUI();}else focus(id||view.selectedId,true);},
  setPerspective(id){view.perspective=id==='omniscient'||state.factions.some(f=>f.id===id)?id:'omniscient';syncShownState();view.followId=null;view.cinematic=false;cameraGoal=null;reconcileSelection();overlayKey='';for(const el of labels.values())el.remove();labels.clear();refreshUI();},
  inspectFaction(id){if(!state.factions.some(f=>f.id===id))return;actions.setPerspective(id);const target=factionFocusTarget(shownState,id);if(target)focus(target.id,true);else actions.overview();},
  setOverlay(mode){view.overlay=mode;overlayKey='';refreshUI();},
  setCinematic(value){view.cinematic=Boolean(value);if(view.cinematic)focus(view.selectedId||state.settlements[0].id,true);else actions.overview();refreshUI();},
  setQuality
};
ui=createUI(document.getElementById('ui'),actions);
function readDiagnostics(rendererPart){return typeof rendererPart.diagnostics==='function'?rendererPart.diagnostics():rendererPart.diagnostics||{};}
function diagnostics(){const c=readDiagnostics(crowds),b=readDiagnostics(entities),t=readDiagnostics(terrain);return {fps:view.fps,frameMs:view.frameMs||0,performance:view.performance||null,performanceMode:view.advancing?'advancing':view.paused?'paused':'active',simulationSpeed:view.speed,simulationTime:state.time,simulationStep:state.step,drawCalls:renderer.info.render.calls,calls:renderer.info.render.calls,triangles:renderer.info.render.triangles,geometries:renderer.info.memory.geometries,textures:renderer.info.memory.textures,observationMode:view.perspective,viewer:shownState.viewer||null,groups:shownState.groups.length,totalPopulation:c.totalPopulation??shownState.settlements.reduce((n,s)=>n+s.population,0),visibleIndividuals:c.visibleIndividuals,representedIndividuals:c.representedIndividuals,drawnModels:c.drawnModels??c.instances,visibleWorkerIndividuals:c.visibleWorkerIndividuals,drawnWorkerModels:c.drawnWorkerModels,visibleMilitaryIndividuals:c.visibleMilitaryIndividuals,crowds:c,buildings:b,terrain:t,fog:readDiagnostics(fog),combat:readDiagnostics(combatEffects)};}
function refreshUI(){if(!ui)return;syncShownState();reconcileSelection();view.perspectiveOptions=state.factions.map(({id,name,species,color})=>({id,name,species,color}));view.outcome=state.outcome;view.victorySummary=state.outcome?.status==='victory'?{battles:state.stats.battles||0,captures:state.stats.captures||0,combatDeaths:state.stats.combatDeaths||0}:null;view.diagnostics=diagnostics();view.diagnosticsScope=renderedPerspective;ui.update(shownState,view);labelOccluders=[...document.querySelectorAll('.atlas-brand,.time-console,.faction-index,.inspector,.world-chronicle,.observation-tools,.atlas-settings,.field-guide,.first-light-note,.scale-reading,.mobile-toolbar,.mobile-gesture-hint,.world-outcome')].filter(el=>el.getClientRects().length).map(el=>el.getBoundingClientRect());}
function clearOverlay(){for(const o of [...overlayGroup.children]){overlayGroup.remove(o);o.geometry?.dispose();o.material?.dispose();}}
function updateOverlay(){
  const state=shownState;
  const key=view.perspective+':'+state.tick+':'+view.overlay+':'+view.selectedId+':'+state.settlements.map(s=>s.id+'='+ (s.controllerId||settlementController(state,s))).join(',');if(key===overlayKey)return;overlayKey=key;clearOverlay();if(view.overlay==='none')return;
  const positions=[],colors=[];const c=new THREE.Color();const add=(a,b,color)=>{c.set(color);positions.push(a.x,a.y,a.z,b.x,b.y,b.z);colors.push(c.r,c.g,c.b,c.r,c.g,c.b);};
  function route(a,b,color,dashed=false){const ay=heightAt(a.x,a.z,state.terrainSeed || state.seed)+.5,by=heightAt(b.x,b.z,state.terrainSeed || state.seed)+.5;for(let i=0;i<12;i++){if(dashed&&i%2)continue;const f=i/12,g=(i+1)/12;add({x:THREE.MathUtils.lerp(a.x,b.x,f),y:THREE.MathUtils.lerp(ay,by,f)+Math.sin(f*Math.PI)*2,z:THREE.MathUtils.lerp(a.z,b.z,f)},{x:THREE.MathUtils.lerp(a.x,b.x,g),y:THREE.MathUtils.lerp(ay,by,g)+Math.sin(g*Math.PI)*2,z:THREE.MathUtils.lerp(a.z,b.z,g)},color);}}
  if(view.overlay==='routes')for(const g of state.groups){const f=state.factions.find(f=>f.id===observedGroupController(state,g));if(Number.isFinite(g.targetX)&&Number.isFinite(g.targetZ))route(g,{x:g.targetX,z:g.targetZ},f?.color||'#fff',g.kind==='scout');}
  if(view.overlay==='territory')for(const s of state.settlements){const f=state.factions.find(f=>f.id===(s.controllerId||settlementController(state,s))),r=(s.radius||10)+5;for(let i=0;i<64;i++){const a=i/64*Math.PI*2,b=(i+1)/64*Math.PI*2,x=s.x+Math.cos(a)*r,z=s.z+Math.sin(a)*r,xx=s.x+Math.cos(b)*r,zz=s.z+Math.sin(b)*r;add({x,y:heightAt(x,z,state.terrainSeed || state.seed)+.3,z},{x:xx,y:heightAt(xx,zz,state.terrainSeed || state.seed)+.3,z:zz},f?.color||'#fff');}}
  if(view.overlay==='knowledge'){const {home,knowledge}=knowledgeOverlaySource(state,view.selectedId);if(home)for(const k of Object.values(knowledge))if(Number.isFinite(k.x)&&Number.isFinite(k.z))route(home,k,k.kind==='settlement'?'#ffc595':'#8ae5bb',true);}
  if(positions.length){const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));overlayGroup.add(new THREE.LineSegments(geometry,new THREE.LineBasicMaterial({vertexColors:true,transparent:true,opacity:.65,depthTest:false})));}
  if(view.overlay==='resources'){const p=[],col=[];for(const n of state.nodes){p.push(n.x,heightAt(n.x,n.z,state.terrainSeed || state.seed)+1.6,n.z);c.set({food:'#a8d97b',water:'#79cfe4',energy:'#c3a2ff',materials:'#eab66d'}[n.kind]).multiplyScalar(.3+.7*n.amount/Math.max(1,n.maxAmount||n.amount));col.push(c.r,c.g,c.b);}const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(p,3));geo.setAttribute('color',new THREE.Float32BufferAttribute(col,3));overlayGroup.add(new THREE.Points(geo,new THREE.PointsMaterial({size:6,sizeAttenuation:false,vertexColors:true,depthTest:false})));}
}
function updateLabels(){
  const state=shownState,{width,height}=viewport();
  const used=[];const ordered=[...state.settlements].sort((a,b)=>(b.id===view.selectedId)-(a.id===view.selectedId)||b.population-a.population);
  for(const s of ordered){let el=labels.get(s.id);if(!el){el=document.createElement('button');el.className='world-label';const f=state.factions.find(f=>f.id===s.factionId);el.style.setProperty('--faction-color',f?.color||'#fff');el.title='Inspect '+s.name;el.addEventListener('click',()=>select(s.id));el.addEventListener('dblclick',()=>focus(s.id));labelRoot.appendChild(el);labels.set(s.id,el);}
    vec.set(s.x,heightAt(s.x,s.z,state.terrainSeed || state.seed)+(s.radius||8)*.3+3,s.z).project(camera);const x=(vec.x*.5+.5)*width,y=(-vec.y*.5+.5)*height;
    const labelOwner=state.factions.find(f=>f.id===(s.controllerId||settlementController(state,s)));el.style.setProperty('--faction-color',labelOwner?.color||'#fff');
    el.textContent=s.name+(s.status==='ruin'?' · ruins':s.status==='camp'?' · refuge':s.occupiedBy?' · occupied':'');el.style.left=x+'px';el.style.top=y+'px';
    const occluded=!document.body.classList.contains('hide-ui')&&labelOccluders.some(r=>x+65>r.left&&x-65<r.right&&y>r.top&&y-25<r.bottom);
    const collision=used.some(p=>Math.abs(p.x-x)<115&&Math.abs(p.y-y)<29),show=vec.z<1&&x>20&&x<width-20&&y>80&&y<height-75&&!view.cinematic&&!occluded&&!collision;
    el.style.display=show?'':'none';if(show)used.push({x,y});el.classList.toggle('selected',s.id===view.selectedId);
  }
  for(const [id,el]of labels)if(!state.settlements.some(s=>s.id===id)){el.remove();labels.delete(id);}
}
const gestures=new PointerGestures();
renderer.domElement.addEventListener('pointerdown',e=>{if(e.pointerType==='touch'||e.button===0)gestures.down(e.pointerId,e.clientX,e.clientY);});
renderer.domElement.addEventListener('pointermove',e=>gestures.move(e.pointerId,e.clientX,e.clientY));
renderer.domElement.addEventListener('pointercancel',e=>gestures.cancel(e.pointerId));
renderer.domElement.addEventListener('lostpointercapture',e=>gestures.cancel(e.pointerId));
renderer.domElement.addEventListener('pointerup',e=>{
  if(!gestures.up(e.pointerId,e.clientX,e.clientY).tap)return;
  const rect=renderer.domElement.getBoundingClientRect();pointer.set((e.clientX-rect.left)/rect.width*2-1,-(e.clientY-rect.top)/rect.height*2+1);ray.setFromCamera(pointer,camera);
  const hit=ray.intersectObjects([...entities.getPickables(),...crowds.getPickables()],true)[0];
  if(hit){const resolved=crowds.resolvePick?.(hit)||entities.resolvePick?.(hit)||scenePickId(hit);if(resolved){select(resolved);return;}}
  const nodeId=terrain.pickResource?.(ray);if(nodeId){select(typeof nodeId==='string'?nodeId:nodeId.id);return;}
  const point=ray.ray.intersectPlane(groundPlane,new THREE.Vector3());if(point){const remembered=fog.pickRemembered(point);if(remembered){select(remembered);return;}const node=shownState.nodes.map(n=>({n,d:Math.hypot(n.x-point.x,n.z-point.z)})).sort((a,b)=>a.d-b.d)[0];if(node&&node.d<(node.n.radius||3)+2)select(node.n.id);}
});
controls.addEventListener('start',()=>{view.userNavigated=true;overviewLocked=false;cameraGoal=null;view.followId=null;view.cinematic=false;});
window.addEventListener('keydown',e=>{if(e.target.matches('input,textarea,select'))return;
  if(e.code==='Space'){if(e.target.closest('button,a[href],[role=button]'))return;e.preventDefault();actions.togglePause();}
  if(['1','2','3','4','5'].includes(e.key))actions.setSpeed([1,2,4,16,32][Number(e.key)-1]);
  if(e.key.toLowerCase()==='f')focus(view.selectedId);if(e.key.toLowerCase()==='c')actions.setCinematic(!view.cinematic);
  if(e.key.toLowerCase()==='h')document.body.classList.toggle('hide-ui');
  if(e.key==='Escape')actions.overview();
});
function resize(){const{width,height}=viewport();scene.userData.crowdViewport={width,height};camera.aspect=width/height;camera.updateProjectionMatrix();renderer.setSize(width,height,false);composer.setSize(width,height);if(overviewLocked){fitOverview();controls.maxDistance=Math.max(700,overviewPosition.distanceTo(overviewTarget)*1.05);cameraGoal={target:overviewTarget.clone(),position:overviewPosition.clone()};}}
window.addEventListener('resize',resize);window.visualViewport?.addEventListener('resize',resize);
let then=performance.now(),uiTimer=0,frameCount=0,fpsTime=0,wallTime=0,timingKey='',timingTotals={simulationMs:0,sceneUpdateMs:0,renderSubmitMs:0,cpuMs:0,simulationPulses:0};
document.addEventListener('visibilitychange',()=>{then=performance.now();});
function frame(now){
  requestAnimationFrame(frame);const dt=Math.max(0,(now-then)/1000);then=now;if(document.hidden)return;wallTime+=dt;
  const cpuStart=performance.now(),stepBefore=state.step,mode=view.advancing?'advancing':view.paused?'paused':'active',key=`${mode}:${view.speed}:${view.quality}`;
  if(key!==timingKey){timingKey=key;fpsTime=0;frameCount=0;view.fps=0;view.frameMs=0;view.performance=null;for(const metric in timingTotals)timingTotals[metric]=0;}
  simClock.advance(dt,view.speed,view.paused||Boolean(view.advancing),n=>stepSimulation(state,n),{maxPulses:4,budgetMs:8,maxBacklogSeconds:.5});
  const afterSimulation=performance.now();syncShownState();
  const victoryKey=state.outcome?.status==='victory'?`${state.seed}:${state.outcome.winnerId}:${state.outcome.wonAt}`:null;
  if(victoryKey&&!view.advancing&&view.victoryObserved!==victoryKey){view.victoryObserved=victoryKey;view.outcomeDismissed=false;view.paused=true;refreshUI();}
  if(view.followId&&!byId(view.followId)){view.followId=null;cameraGoal=null;}
  reconcileSelection();
  const alpha=simClock.alpha,simTime=Math.max(0,(state.time??state.tick)-SIM_DT+alpha*SIM_DT);
  if(view.followId&&!cameraGoal&&!view.cinematic){const o=byId(view.followId);if(o){const p=visualPosition(o,alpha),desired=new THREE.Vector3(p.x,heightAt(p.x,p.z,state.terrainSeed || state.seed)+1,p.z),delta=desired.sub(controls.target);controls.target.addScaledVector(delta,1-Math.exp(-dt*5));camera.position.addScaledVector(delta,1-Math.exp(-dt*5));}else view.followId=null;}
  if(view.cinematic){const o=byId(view.followId||view.selectedId);if(o){const p=visualPosition(o,alpha),y=heightAt(p.x,p.z,state.terrainSeed || state.seed),r=Math.max(24,(o.radius||8)*2.3),a=wallTime*.025;cameraGoal={target:new THREE.Vector3(p.x,y+2,p.z),position:new THREE.Vector3(p.x+Math.sin(a)*r,y+r*.48,p.z+Math.cos(a)*r)};}}
  if(cameraGoal){const k=1-Math.exp(-dt*2.6);camera.position.lerp(cameraGoal.position,k);controls.target.lerp(cameraGoal.target,k);if(!view.cinematic&&camera.position.distanceTo(cameraGoal.position)<.08)cameraGoal=null;}
  controls.update();camera.updateMatrixWorld();
  terrain.update?.(simTime,shownState,alpha);entities.update(shownState,simTime,view.selectedId,alpha);crowds.update(shownState,simTime,view.selectedId,alpha);combatEffects.update(shownState,simTime,view.selectedId,alpha);fog.update(state,view.perspective,shownState);renderedPerspective=view.perspective;
  updateOverlay();updateLabels();const afterUpdates=performance.now();renderer.info.reset();composer.render();const afterRender=performance.now();
  timingTotals.simulationMs+=afterSimulation-cpuStart;timingTotals.sceneUpdateMs+=afterUpdates-afterSimulation;timingTotals.renderSubmitMs+=afterRender-afterUpdates;timingTotals.cpuMs+=afterRender-cpuStart;timingTotals.simulationPulses+=state.step-stepBefore;
  uiTimer+=dt;frameCount++;fpsTime+=dt;if(fpsTime>=1){view.fps=Math.round(frameCount/fpsTime);view.frameMs=fpsTime/frameCount*1000;view.performance={mode,speed:view.speed,quality:view.quality,sampledFrames:frameCount,sampledSeconds:fpsTime,simulationPulses:timingTotals.simulationPulses,simulationCyclesPerSecond:timingTotals.simulationPulses*.1/fpsTime,simulationMs:timingTotals.simulationMs/frameCount,sceneUpdateMs:timingTotals.sceneUpdateMs/frameCount,renderSubmitMs:timingTotals.renderSubmitMs/frameCount,cpuMs:timingTotals.cpuMs/frameCount,gpuTiming:false,backlogSeconds:simClock.remainder,droppedRequestedSeconds:simClock.droppedRequestedSeconds};frameCount=0;fpsTime=0;for(const metric in timingTotals)timingTotals[metric]=0;}
  if(uiTimer>.25){refreshUI();uiTimer=0;}
}
window.littleworld={
  get state(){return state;},get shownState(){return syncShownState();},view,actions,reset,select,advance,
  step(cycles){stepSimulation(state,Math.max(0,Math.floor(cycles))*10);simClock.reset();refreshUI();},
  stepPulses(n){stepSimulation(state,n);refreshUI();},
  renderer,camera,scene,controls,clock:simClock,
  get renderers(){return {terrain,buildings:entities,crowds,fog,combat:combatEffects};},
  get diagnostics(){return diagnostics();},
  getMotionSamples(){return crowds.getMotionSamples?.()||[];}
};
refreshUI();document.getElementById('boot').remove();requestAnimationFrame(frame);
if(Number(params.get('evolve'))>0)setTimeout(()=>advance(Number(params.get('evolve'))),300);
