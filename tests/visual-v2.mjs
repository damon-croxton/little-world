import {chromium} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';

// Real local Chrome and the real seeded simulation: no population or resource fixtures.
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-angle=d3d11','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
const page=await browser.newPage({viewport:{width:1600,height:1000},deviceScaleFactor:1});
page.setDefaultTimeout(120000);
const report={at:new Date().toISOString(),mode:'Local headless Chrome, ANGLE D3D11, real first-light simulation',errors:[],warnings:[],checks:[],states:{},performance:{},screenshots:[]};
page.on('pageerror',e=>{report.errors.push(e.message);console.error('PAGE ERROR',e.message);});
page.on('console',m=>{if(m.type()==='error')report.errors.push(m.text());else if(m.type()==='warning')report.warnings.push(m.text());});
const check=(name,passed,details)=>report.checks.push({name,passed,details});
const save=()=>writeFile('screenshots/visual-report.json',JSON.stringify(report,null,2));
async function shot(name){const path=`screenshots/visual-${name}.png`;await page.screenshot({path});report.screenshots.push(path);console.log('SCREENSHOT',path);await save();}
async function settle(ms=700){await page.waitForTimeout(ms);}
async function overview(){await page.evaluate(()=>{littleworld.actions.follow(null);littleworld.view.cinematic=false;littleworld.camera.position.set(250,255,320);littleworld.controls.target.set(0,4,0);littleworld.controls.update();});await settle();}
async function focusFixed(id){await page.evaluate(id=>{const w=littleworld,s=w.state.settlements.find(s=>s.id===id);w.actions.follow(null);w.view.cinematic=false;w.select(id);w.camera.position.set(s.x+34,35,s.z+44);w.controls.target.set(s.x,3,s.z);w.controls.update();},id);await settle();}
async function snapshot(name){report.states[name]=await page.evaluate(()=>({tick:littleworld.state.tick,time:littleworld.state.time,step:littleworld.state.step,diagnostics:littleworld.diagnostics,settlements:littleworld.state.settlements.map(s=>({id:s.id,name:s.name,species:littleworld.state.factions.find(f=>f.id===s.factionId)?.species,population:s.population,radius:s.radius,buildingCount:s.buildings?.length,completed:s.buildings?.filter(b=>b.progress>=1).length,x:s.x,z:s.z,stocks:s.stock||s.stocks,assigned:s.assigned})),nodes:littleworld.state.nodes.map(n=>({id:n.id,kind:n.kind,subtype:n.subtype,x:n.x,z:n.z,amount:n.amount,maxAmount:n.maxAmount})),ledger:littleworld.state.resourceLedger,stats:littleworld.state.stats}));console.log('STATE',name,JSON.stringify({tick:report.states[name].tick,...report.states[name].diagnostics}));await save();}
async function performanceSample(name,n=90){report.performance[name]=await page.evaluate(async n=>{const frames=[];let prev;for(let i=0;i<=n;i++){await new Promise(requestAnimationFrame);const now=performance.now();if(prev!==undefined)frames.push({ms:now-prev,calls:littleworld.renderer.info.render.calls,triangles:littleworld.renderer.info.render.triangles});prev=now;}const gl=littleworld.renderer.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info'),times=frames.map(f=>f.ms).sort((a,b)=>a-b),meanMs=times.reduce((a,b)=>a+b,0)/times.length;return {tick:littleworld.state.tick,paused:littleworld.view.paused,quality:littleworld.view.quality,meanMs,p50Ms:times[Math.floor(times.length*.5)],p95Ms:times[Math.floor(times.length*.95)],maxMs:times.at(-1),derivedFps:1000/meanMs,drawCalls:{min:Math.min(...frames.map(f=>f.calls)),max:Math.max(...frames.map(f=>f.calls))},maxTriangles:Math.max(...frames.map(f=>f.triangles)),gpu:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),diagnostics:littleworld.diagnostics};},n);console.log('PERF',name,JSON.stringify(report.performance[name]));await save();}
async function layouts(name){return page.evaluate(name=>{const sels=['.atlas-brand','.time-console','.faction-index','.inspector','.world-chronicle','.observation-tools'];const rects=sels.flatMap(selector=>{const e=document.querySelector(selector);if(!e||!e.getClientRects().length)return [];const r=e.getBoundingClientRect();return [{selector,x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}];});const overlaps=[];for(let i=0;i<rects.length;i++)for(let j=i+1;j<rects.length;j++){const a=rects[i],b=rects[j],width=Math.min(a.right,b.right)-Math.max(a.x,b.x),height=Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y);if(width>4&&height>4)overlaps.push({a:a.selector,b:b.selector,width,height});}return {name,width:innerWidth,height:innerHeight,horizontalOverflow:document.documentElement.scrollWidth>innerWidth,overlaps,rects};},name);}

await mkdir('screenshots',{recursive:true});
try{
  await page.goto('http://127.0.0.1:4174/?seed=first-light');
  await page.waitForFunction(()=>Boolean(window.littleworld));
  await page.evaluate(()=>{littleworld.view.paused=true;littleworld.reset('first-light');});await settle(1500);
  await overview();await snapshot('initial');await shot('initial-overview');await performanceSample('initialHigh');
  report.layoutDesktop=await layouts('desktop');
  await focusFixed('s0');await shot('initial-human-same-camera');
  console.log('ADVANCE 1200');await page.evaluate(()=>littleworld.advance(1200));await overview();
  await snapshot('cycle1200');await shot('cycle1200-overview');await performanceSample('cycle1200High');
  await focusFixed('s0');await shot('cycle1200-human-same-camera');
  for(const species of ['human','machine','hive']){const id=await page.evaluate(species=>{const w=littleworld;return w.state.settlements.filter(s=>w.state.factions.find(f=>f.id===s.factionId)?.species===species).sort((a,b)=>b.population-a.population)[0]?.id;},species);if(!id)continue;await page.evaluate(id=>littleworld.actions.follow(id),id);await settle(3000);await shot(`cycle1200-${species}-close`);}
  await overview();console.log('ADVANCE 1800');await page.evaluate(()=>littleworld.advance(1800));await overview();
  await snapshot('cycle3000');await shot('cycle3000-overview');await performanceSample('cycle3000High');
  check('Natural developed world has several thousand visible individuals',report.states.cycle3000.diagnostics.visibleIndividuals>=3000,report.states.cycle3000.diagnostics);
  check('No duplicated or omitted represented population',Object.values(report.states).every(s=>s.diagnostics.totalPopulation===s.diagnostics.representedIndividuals),Object.fromEntries(Object.entries(report.states).map(([n,s])=>[n,{population:s.diagnostics.totalPopulation,represented:s.diagnostics.representedIndividuals}])));
  await focusFixed('s0');await shot('cycle3000-human-same-camera');
  await page.evaluate(()=>{littleworld.actions.setSpeed(1);});
  report.motion=await page.evaluate(async()=>{const out=[];const start=performance.now();while(performance.now()-start<1800){await new Promise(requestAnimationFrame);out.push({wallMs:performance.now()-start,tick:littleworld.state.tick,time:littleworld.state.time,alpha:littleworld.clock.alpha,samples:littleworld.getMotionSamples()});}return out;});
  const motionPairs=report.motion.slice(1).map((f,i)=>{const p=report.motion[i],prior=new Map(p.samples.map(s=>[s.id,s]));let changed=0,positionChanged=0;for(const s of f.samples){const old=prior.get(s.id);if(!old)continue;if(JSON.stringify(s)!==JSON.stringify(old))changed++;if(Math.hypot(s.x-old.x,s.y-old.y,s.z-old.z)>1e-7)positionChanged++;}return {wallMs:f.wallMs,dt:f.wallMs-p.wallMs,sameCycle:f.tick===p.tick,changed,positionChanged};});
  report.motionSummary={frames:report.motion.length,pairs:motionPairs,changedWithinSameCycle:motionPairs.filter(p=>p.sameCycle&&p.positionChanged>0).length};delete report.motion;
  check('Subsecond positions continuously change at 1x within the same cycle',report.motionSummary.changedWithinSameCycle>=5,report.motionSummary);
  await page.evaluate(()=>{littleworld.view.paused=true;});await settle(100);
  const pausedA=await page.evaluate(()=>({tick:littleworld.state.tick,time:littleworld.state.time,samples:littleworld.getMotionSamples()}));await settle(700);
  const pausedB=await page.evaluate(()=>({tick:littleworld.state.tick,time:littleworld.state.time,samples:littleworld.getMotionSamples()}));
  check('Paused simulation and sampled render positions are exactly unchanged',JSON.stringify(pausedA)===JSON.stringify(pausedB),{tickBefore:pausedA.tick,tickAfter:pausedB.tick,samples:pausedA.samples.length});
  await overview();await page.evaluate(()=>littleworld.actions.setQuality('low'));await settle();await performanceSample('cycle3000Low');await page.evaluate(()=>littleworld.actions.setQuality('high'));
  report.depletion=report.states.cycle3000.nodes.map(n=>{const initial=report.states.initial.nodes.find(x=>x.id===n.id);return {...n,initial:initial.amount,extractedNet:initial.amount-n.amount,remainingRatio:n.amount/initial.amount};}).sort((a,b)=>b.extractedNet-a.extractedNet).slice(0,15);
  const depleted=report.depletion.find(n=>n.kind==='materials')||report.depletion[0];
  async function resourceCamera(node){await page.evaluate(n=>{const w=littleworld;w.actions.follow(null);w.select(n.id);w.camera.position.set(n.x+15,20,n.z+19);w.controls.target.set(n.x,2,n.z);w.controls.update();},node);await settle();}
  if(depleted){await resourceCamera(depleted);await shot('resource-depleted');await page.evaluate(()=>littleworld.reset('first-light'));await settle(2000);await resourceCamera(depleted);await shot('resource-initial-same-camera');}
  await overview();await page.setViewportSize({width:1024,height:768});await settle();report.layoutCompact=await layouts('compact');await shot('compact');
  await page.setViewportSize({width:390,height:844});await settle();report.layoutMobile=await layouts('mobile');await shot('mobile');
  check('Desktop panels have no overlaps',!report.layoutDesktop.overlaps.length,report.layoutDesktop);
  check('Compact UI has no horizontal overflow',!report.layoutCompact.horizontalOverflow,report.layoutCompact);
  check('Mobile UI has no horizontal overflow',!report.layoutMobile.horizontalOverflow,report.layoutMobile);
}catch(error){report.failure=error.stack;console.error(error);process.exitCode=1;}
finally{await save();await browser.close();}
console.log('RESULT',JSON.stringify({errors:report.errors,failure:report.failure,checks:report.checks.map(({name,passed})=>({name,passed})),screenshots:report.screenshots},null,2));
if(report.errors.length||report.checks.some(c=>!c.passed))process.exitCode=1;
