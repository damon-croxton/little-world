import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {configuration,launch,boot,environment,observeErrors,output,save,sampleFrames,frameSummary} from './browser-v2.mjs';
const config=configuration(),report={at:new Date().toISOString(),scope:'Actual advancing WebGL browser performance. No other QA browser should run concurrently. Headless RAF/display cadence may limit measured frame rate.',errors:[],warnings:[],samples:[],screenshots:[]};
await mkdir(config.outputDir,{recursive:true});const browser=await launch(config),page=await browser.newPage({viewport:{width:1600,height:1000},deviceScaleFactor:1});observeErrors(page,report);
const persist=()=>save(config,'desktop-active-performance.json',report);
try{
 await boot(page,config);report.environment=await environment(page,browser,config);await page.evaluate(seed=>littleworld.reset(seed),config.seed);
 for(const target of [1200,3000,5000]){
  const started=Date.now();await page.evaluate(async target=>{const w=littleworld;if(!w.view.paused)w.actions.togglePause();await w.advance(Math.max(0,target-w.state.tick));w.actions.overview(true);},target);await page.waitForTimeout(600);
  const outcome=await page.evaluate(()=>littleworld.state.outcome);
  if(outcome?.status==='victory'&&!report.victory){const path=output(config,'natural-victory.png');await page.screenshot({path});report.screenshots.push(path);const data=await page.evaluate(()=>({outcome:littleworld.state.outcome,paused:littleworld.view.paused,visible:!littleworld.view.outcomeDismissed,step:littleworld.state.step}));assert.ok(data.paused);await page.locator('[data-action="keep-watching"]').click();await page.waitForTimeout(300);const after=await page.evaluate(()=>({step:littleworld.state.step,paused:littleworld.view.paused}));assert.equal(after.paused,false);assert.ok(after.step>data.step);report.victory={...data,continueAfter:after};}
  for(const quality of ['high','low']){
   await page.evaluate(quality=>{littleworld.actions.setQuality(quality);littleworld.actions.setSpeed(2);},quality);await page.waitForTimeout(1500);
   const frames=await sampleFrames(page,{durationMs:5000,minimumFrames:30}),summary=frameSummary(frames);assert.ok(frames.at(-1).step>frames[0].step+50);assert.ok(frames.every(f=>!f.paused&&f.speed===2));
   const diagnostics=await page.evaluate(()=>littleworld.diagnostics),simSeconds=(frames.at(-1).step-frames[0].step)*.1,wallSeconds=(frames.at(-1).wallMs-frames[0].wallMs)/1000;assert.equal(diagnostics.representedIndividuals,diagnostics.totalPopulation);
   report.samples.push({target,quality,generationWallMs:Date.now()-started,actualCycle:frames[0].tick,...summary,pairs:undefined,simulatedSeconds:simSeconds,wallSeconds,simulatedCyclesPerWallSecond:simSeconds/wallSeconds,diagnostics});await persist();
  }
  await page.evaluate(()=>{if(!littleworld.view.paused)littleworld.actions.togglePause();littleworld.actions.setQuality('high');});await page.waitForTimeout(300);const path=output(config,`natural-cycle${target}-overview.png`);await page.screenshot({path});report.screenshots.push(path);console.log(`Measured natural cycle${target}`);
 }
 assert.deepEqual(report.errors,[]);report.status='passed';
}catch(error){report.status='failed';report.failure=error.stack;console.error(error);}finally{await persist();await browser.close();}
console.log(JSON.stringify({status:report.status,report:output(config,'desktop-active-performance.json'),samples:report.samples.map(s=>({target:s.target,quality:s.quality,fps:s.derivedFps,p95:s.p95Ms,pop:s.diagnostics.totalPopulation,cyclesPerSecond:s.simulatedCyclesPerWallSecond})),failure:report.failure}));if(report.status!=='passed')process.exitCode=1;
