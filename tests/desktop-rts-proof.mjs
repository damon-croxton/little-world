import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {configuration,launch,boot,environment,observeErrors,output,save,sampleFrames,frameSummary} from './browser-v2.mjs';

const config=configuration(), report={at:new Date().toISOString(),scope:'Actual Chrome WebGL; natural simulation only. No injected troops, structures, queues or combat.',errors:[],warnings:[],checks:[],screenshots:[],observations:[]};
await mkdir(config.outputDir,{recursive:true});
const browser=await launch(config),page=await browser.newPage({viewport:{width:1600,height:1000},deviceScaleFactor:1});
observeErrors(page,report);
const persist=()=>save(config,'desktop-rts-report.json',report);
async function shot(name){const path=output(config,`rts-${name}.png`);await page.screenshot({path});report.screenshots.push({name,path,...await page.evaluate(()=>({step:littleworld.state.step,time:littleworld.state.time,diagnostics:littleworld.diagnostics}))});await persist();}
async function pin(x,z,id,d=26){await page.evaluate(({x,z,id,d})=>{const w=littleworld;w.actions.follow(null);if(id)w.select(id);w.camera.position.set(x+d*.8,d*.78+4,z+d);w.controls.target.set(x,3,z);w.controls.update();},{x,z,id,d});await page.waitForTimeout(400);}
async function read(){return page.evaluate(()=>{const w=littleworld,s=w.state;return {tick:s.tick,time:s.time,pop:s.settlements.reduce((n,h)=>n+h.population,0),stats:s.stats,homes:s.settlements.map(h=>({id:h.id,x:h.x,z:h.z,pop:h.population,species:s.factions.find(f=>f.id===h.factionId).species,queue:h.trainingQueue,military:h.military,defenses:h.buildings.filter(b=>['wall','gate','tower'].includes(b.kind)).map(b=>({id:b.id,kind:b.kind,hp:b.hp,progress:b.progress,crew:b.crewAssigned,x:b.x,z:b.z})),producers:h.buildings.filter(b=>['barracks','range','fabricator','launcher','brooder','spitter'].includes(b.kind)).map(b=>({id:b.id,kind:b.kind,progress:b.progress}))})),shot:[...(s.combatEvents||[])].reverse().find(e=>e.type==='projectile'&&e.shots?.length&&e.impactTime>=s.time-.1),outcome:s.outcome};});}
try{
  await boot(page,config);report.environment=await environment(page,browser,config);await page.evaluate(seed=>littleworld.reset(seed),config.seed);await page.waitForTimeout(400);
  const initial=await read();await page.evaluate(()=>{littleworld.actions.setPerspective('f0');littleworld.actions.overview(true);});await page.waitForTimeout(400);await shot('initial-faction-fog');
  report.initialFog=await page.evaluate(()=>({diagnostics:littleworld.diagnostics,actual:littleworld.state.settlements.reduce((n,h)=>n+h.population,0),shown:littleworld.shownState.settlements.map(s=>s.id)}));
  assert.equal(report.initialFog.diagnostics.fog.active,true);assert.ok(report.initialFog.shown.length<initial.homes.length);report.checks.push({name:'Initial faction view obscures unknown foreign colonies',passed:true});
  await page.evaluate(()=>littleworld.actions.setPerspective('omniscient'));
  const fortSpecies=new Set();let training=false,combat=false;
  for(let i=0;i<260;i++){
    await page.evaluate(()=>littleworld.step(5));const s=await read();
    if(!training){const h=s.homes.find(h=>h.queue?.length);if(h){await pin(h.x,h.z,h.id,24);await shot('paid-training');report.training={tick:s.tick,home:h,ledger:await page.evaluate(()=>littleworld.state.resourceLedger)};training=true;}}
    for(const h of s.homes){if(!fortSpecies.has(h.species)&&h.defenses.some(b=>b.kind==='tower'&&b.progress>=1&&b.hp>0)&&h.defenses.some(b=>b.kind==='wall'&&b.progress>=1&&b.hp>0)){await pin(h.x,h.z,h.id,31);await shot(`${h.species}-fortifications`);report.observations.push({kind:'fortifications',tick:s.tick,home:h});fortSpecies.add(h.species);}}
    if(!combat&&s.shot){const e=s.shot,a=e.shots[0].from,b=e.shots[0].to;await pin((a.x+b.x)/2,(a.z+b.z)/2,e.sourceId,23);const d=await page.evaluate(()=>littleworld.diagnostics.combat);if(d.projectiles>0){await shot('natural-projectile-battle');report.battle={tick:s.tick,event:e,diagnostics:d,stats:s.stats};combat=true;
      const video=await page.evaluate(async()=>{const w=littleworld,canvas=w.renderer.domElement,stream=canvas.captureStream(30),chunks=[],recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp9',videoBitsPerSecond:4500000});const done=new Promise(resolve=>recorder.onstop=resolve);recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};const start={step:w.state.step,stats:{...w.state.stats}};recorder.start(250);w.actions.setSpeed(1);await new Promise(resolve=>setTimeout(resolve,12000));w.actions.togglePause();recorder.stop();await done;stream.getTracks().forEach(t=>t.stop());const bytes=Array.from(new Uint8Array(await new Blob(chunks,{type:'video/webm'}).arrayBuffer()));return {bytes,start,end:{step:w.state.step,stats:{...w.state.stats}}};});const videoPath=output(config,'natural-combat-canvas.webm');await writeFile(videoPath,Buffer.from(video.bytes));report.video={path:videoPath,bytes:video.bytes.length,start:video.start,end:video.end,scope:'12 seconds of actual WebGL canvas at live 1x; observer camera fixed on naturally occurring battle. UI omitted by canvas capture.'};await persist();
    }}
    if(training&&combat&&fortSpecies.size===3)break;
  }
  assert.ok(training,'No natural paid training queue captured');assert.ok(combat,'No natural rendered projectile captured');assert.equal(fortSpecies.size,3,'Not all three species had natural walls and towers');
  report.checks.push({name:'Paid queues, species walls/towers and natural projectile combat rendered',passed:true});
  await page.evaluate(()=>{littleworld.actions.setPerspective('f0');littleworld.actions.overview(true);});await page.waitForTimeout(400);await shot('developed-faction-fog-memory');report.developedFog=await page.evaluate(()=>littleworld.diagnostics.fog);
  await page.evaluate(()=>{littleworld.actions.setPerspective('omniscient');littleworld.actions.overview(true);});await page.waitForTimeout(400);await shot('developed-observer');
  report.final=await read();assert.deepEqual(report.errors,[]);report.checks.push({name:'No WebGL, JavaScript, module or HTTP errors',passed:true});report.status='passed';
}catch(e){report.status='failed';report.failure=e.stack;console.error(e);}finally{await persist();await browser.close();}
console.log(JSON.stringify({status:report.status,checks:report.checks,errors:report.errors,failure:report.failure,report:output(config,'desktop-rts-report.json')}));
if(report.status!=='passed')process.exitCode=1;
