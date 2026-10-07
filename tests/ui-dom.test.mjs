import { setMilitary, bindArmy } from './roster-fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createUI } from '../src/ui.js';
import { createSimulation } from '../src/sim/core.js';
import { applyCivilianDamage } from '../src/sim/civilians.js';

// DOM logic tests, not browser/layout/WebGL evidence. Linkedom does not implement
// HTMLSelectElement's standard value setter; supply that one DOM adapter here.
function setup(options={}) {
  const {document,window}=parseHTML('<html><body><div id="ui"></div></body></html>');
  const proto=window.HTMLSelectElement.prototype,descriptor=Object.getOwnPropertyDescriptor(proto,'value');
  if(!descriptor?.set)Object.defineProperty(proto,'value',{configurable:true,get:descriptor.get,set(value){for(const option of this.querySelectorAll('option'))option.removeAttribute('selected');const option=[...this.querySelectorAll('option')].find(option=>option.value===String(value));if(option)option.setAttribute('selected','');}});
  globalThis.document=document;
  let state=createSimulation('ui-dom-proof',{civCount:4});
  const view={worldGeneration:0,speed:1,paused:true,selectedId:'s0',quality:'low',perspective:'omniscient',perspectiveOptions:state.factions,diagnosticsScope:'omniscient',diagnostics:{crowds:{totalPopulation:400,representedIndividuals:400,visibleIndividuals:400,culledIndividuals:0}}};
  const calls=[];let ui;
  const actions={
    select(id){view.selectedId=id;ui.update(state,view);},
    reset(seed,config){calls.push({action:'reset',seed,config});state=createSimulation(seed,config);view.worldGeneration++;view.selectedId='s0';view.advancing=null;view.perspectiveOptions=state.factions;ui.update(state,view);},
    setPerspective(value){calls.push({action:'perspective',value});view.perspective=value;ui.update(state,view);},
    setQuality(value){view.quality=value;},
    ...options.actions,
  };
  const root=document.getElementById('ui');ui=createUI(root,actions);ui.update(state,view);
  const fire=(selector,type='click')=>{const element=root.querySelector(selector);assert.ok(element,selector);element.dispatchEvent(new window.Event(type,{bubbles:true,cancelable:true}));};
  return {document,window,root,ui,view,calls,actions,fire,get state(){return state;},update(next=state){ui.update(next,view);},dispose(){ui.dispose();delete globalThis.document;}};
}

test('worker inspection follows actual crew injuries and reduced surviving headcount',()=>{
  const t=setup();try{
    const home=t.state.settlements[0], group={id:'wounded-crew',kind:'worker',factionId:home.factionId,originId:home.id,size:12,x:home.x,z:home.z,capacity:72,carrying:{food:24},phase:'working'};
    t.state.groups.push(group);t.view.selectedId=group.id;t.update();
    assert.match(t.root.querySelector('.crew-health').textContent,/12 surviving workers.*384 \/ 384/);
    applyCivilianDamage(t.state,group,69);t.update();
    assert.match(t.root.querySelector('.crew-health').textContent,/10 surviving workers.*315 \/ 320/);
    assert.match(t.root.querySelector('.party-phase').textContent,/10 travellers/);
  }finally{t.dispose();}
});

test('observer settings show four starts and edited seed/count survive refresh and blur',()=>{
  const t=setup();try{
    const seed=t.root.querySelector('#atlas-seed'),civs=t.root.querySelector('#atlas-civs');assert.equal(civs.value,'4');assert.equal(t.root.querySelectorAll('.faction-entry').length,4);
    seed.value='a-new-world';t.fire('#atlas-seed','input');civs.value='5';t.fire('#atlas-civs','input');t.update();
    assert.equal(seed.value,'a-new-world');assert.equal(civs.value,'5');assert.equal(t.root.querySelector('[data-slot="civ-count"]').textContent,'5');
    t.fire('.seed-form','submit');assert.deepEqual(t.calls.at(-1),{action:'reset',seed:'a-new-world',config:{civCount:5,biome:'random'}});assert.equal(t.state.factions.length,5);assert.equal(t.root.querySelectorAll('.faction-entry').length,5);
  }finally{t.dispose();}
});

test('observer perspective uses explicit action and never silently changes the simulation configuration',()=>{
  const t=setup();try{const count=t.state.factions.length;t.root.querySelector('#atlas-perspective').value='f1';t.fire('#atlas-perspective','change');assert.deepEqual(t.calls.at(-1),{action:'perspective',value:'f1'});assert.equal(t.state.factions.length,count);assert.equal(t.root.querySelector('#atlas-civs').value,'4');}finally{t.dispose();}
});

test('settings and field guide stay mutually exclusive through repeated opens',()=>{
  const t=setup();try{t.fire('[data-action="settings"]');assert.equal(t.root.querySelector('#atlas-settings').hidden,false);t.fire('.render-reading [data-action="help"]');assert.equal(t.root.querySelector('.field-guide').hidden,false);assert.equal(t.root.querySelector('#atlas-settings').hidden,true);t.fire('[data-action="settings"]');assert.equal(t.root.querySelector('#atlas-settings').hidden,false);assert.equal(t.root.querySelector('.field-guide').hidden,true);t.fire('[data-action="diagnostics"]');assert.equal(t.root.querySelector('.field-guide').hidden,true);}finally{t.dispose();}
});

test('paid production inspector shows actual queue and role counts without creating orders',()=>{
  const t=setup();try{const home=t.state.settlements[0];setMilitary(t.state,home,{infantry:9,ranged:5});home.trainingQueue=[{id:'qa-order',role:'ranged',size:3,buildingId:'qa-range',progress:.5,remaining:9}];home.assigned.training=3;home.buildings.push({id:'qa-range',kind:'range',x:home.x+5,z:home.z,progress:1,hp:160,maxHp:160});t.update();const text=t.root.querySelector('.military-reading').textContent;assert.match(text,/Field Range/);assert.match(text,/3 Trail archer/);assert.match(text,/50%/);assert.match(text,/costs already paid/);assert.equal(home.trainingQueue.length,1);}finally{t.dispose();}
});

test('foreign and remembered inspectors withhold stores, production queues and live hidden state',()=>{
  const t=setup();try{
    t.view.perspective='f0';t.view.selectedId='s1';const foreign=t.state.settlements[1];foreign.stock.materials=543210;foreign.trainingQueue=[{role:'secret-military-order',size:987654,progress:.5}];const scoped={...t.state,viewer:{mode:'faction',factionId:'f0'},knownPlaces:[]};t.update(scoped);
    const inspector=t.root.querySelector('.inspector').textContent;assert.match(inspector,/Foreign stores, orders and training queues remain unknown/);assert.doesNotMatch(inspector,/543,210|987,654|secret-military-order|Stores & carrying/);
    t.view.selectedId='remembered-site';t.update({...scoped,knownPlaces:[{id:'remembered-site',kind:'resource',resourceKind:'materials',x:12,z:14,amountEstimate:42,observedTick:0,knowledgeView:'remembered'}]});
    const memory=t.root.querySelector('.inspector').textContent;assert.match(memory,/Last known position/);assert.match(memory,/~42/);assert.match(memory,/Hidden changes are not shown/);
  }finally{t.dispose();}
});

test('cancelling advance by seed reset cannot announce success or leave its button busy',async()=>{
  let resolve,calls=0;const t=setup({actions:{advance(){calls++;return new Promise(r=>{resolve=r;});}}});try{
    t.fire('[data-action="develop"]');t.fire('[data-action="develop"]');assert.equal(calls,1);assert.equal(t.root.querySelector('[data-action="develop"]').getAttribute('aria-busy'),'true');
    t.actions.reset('cancelled-proof',{civCount:3});resolve({completed:false,reason:'reset'});await Promise.resolve();await Promise.resolve();
    assert.doesNotMatch(t.root.querySelector('.ui-toast').textContent,/1,200 cycles simulated/);assert.equal(t.root.querySelector('[data-action="develop"]').getAttribute('aria-busy'),'false');assert.equal(t.root.querySelector('[data-action="develop"]').disabled,false);
  }finally{t.dispose();}
});

test('faction view object refresh is not mistaken for a world reset during advance',async()=>{
  let resolve;const t=setup({actions:{advance(){return new Promise(r=>{resolve=r;});}}});try{
    t.fire('[data-action="develop"]');t.view.perspective='f0';t.update({...t.state,viewer:{mode:'faction',factionId:'f0'},knownPlaces:[]});resolve({completed:true,cycles:1200});await Promise.resolve();await Promise.resolve();
    assert.match(t.root.querySelector('.ui-toast').textContent,/1,200 cycles simulated/);assert.equal(t.root.querySelector('[data-action="develop"]').getAttribute('aria-busy'),'false');
  }finally{t.dispose();}
});

test('untrusted seed and faction labels are escaped instead of creating elements',()=>{
  const t=setup();try{t.state.factions[0].name='<img src=x onerror=oops>';t.state.settlements[0].name='<script>oops</script>';t.update();assert.equal(t.root.querySelectorAll('script,img').length,0);assert.match(t.root.textContent,/<script>oops<\/script>/);}finally{t.dispose();}
});

test('mobile panel controls start collapsed and toggle one reachable panel at a time',()=>{
  const t=setup();try{assert.equal(t.root.className.includes('mobile-panel-'),false);t.fire('[data-action="mobile-panel"][data-value="inspector"]');assert.equal(t.root.classList.contains('mobile-panel-inspector'),true);assert.equal(t.root.querySelector('[data-value="inspector"]').getAttribute('aria-pressed'),'true');t.fire('[data-action="mobile-panel"][data-value="factions"]');assert.equal(t.root.classList.contains('mobile-panel-inspector'),false);assert.equal(t.root.classList.contains('mobile-panel-factions'),true);t.fire('[data-action="close-mobile-panel"]');assert.equal(t.root.classList.contains('mobile-panel-factions'),false);assert.equal(t.root.querySelectorAll('.mobile-toolbar button').length,4);}finally{t.dispose();}
});

test('victory is shown only for a real outcome and reports neutral2x pacing without deleting survivors',()=>{
  let continued=0;const t=setup({actions:{continueWatching(){continued++;}}});try{assert.equal(t.root.querySelector('.world-outcome').hidden,true);t.view.outcome={status:'victory',winnerId:'f0',wonAt:720,tick:720};t.view.victorySummary={captures:3,battles:8};t.update();const result=t.root.querySelector('.world-outcome');assert.equal(result.hidden,false);assert.match(result.textContent,/6m 0s/);assert.match(result.textContent,/Surviving inhabitants stay/);t.fire('[data-action="keep-watching"]');assert.equal(continued,1);t.view.outcomeDismissed=true;t.update();assert.equal(result.hidden,true);}finally{t.dispose();}
});

test('seeded strengths display real numerical bonuses and tradeoffs',()=>{
  const t=setup();try{t.state.factions[0].advantages={name:'Harvest guild',description:'Supply funds growth.',strength:'65% faster gathering; 45% larger loads',tradeoff:'8% weaker weapons'};t.update();const text=t.root.querySelector('.advantage-reading').textContent;assert.match(text,/65% faster gathering/);assert.match(text,/8% weaker weapons/);}finally{t.dispose();}
});

test('replaying the same world clears abandoned dirty setup fields',()=>{
  const t=setup();try{t.root.querySelector('#atlas-seed').value='not-committed';t.fire('#atlas-seed','input');t.actions.reset('ui-dom-proof',{civCount:4});assert.equal(t.root.querySelector('#atlas-seed').value,'ui-dom-proof');}finally{t.dispose();}
});

test('crew diagnostics distinguish actual people, weighted visibility and drawn models',()=>{
  const t=setup();try{
    const actual=t.state.settlements.reduce((sum,home)=>sum+home.population,0);
    t.view.diagnostics.crowds={totalPopulation:actual,representedIndividuals:actual,visibleIndividuals:actual,culledIndividuals:0,drawnModels:actual-20,visibleWorkerIndividuals:22,drawnWorkerModels:2,visibleMilitaryIndividuals:14,housedIndividuals:0};
    t.update();
    const rows=Object.fromEntries([...t.root.querySelectorAll('.render-counts > div')].map(row=>[row.querySelector('dt').textContent,row.querySelector('dd').textContent]));
    assert.equal(rows['Actual population'],actual.toLocaleString('en'));
    assert.equal(rows['People visible in this view'],actual.toLocaleString('en'));
    assert.equal(rows['Drawn crowd models'],(actual-20).toLocaleString('en'));
    assert.equal(rows['Workers represented'],'22');assert.equal(rows['Worker crew models'],'2');
    assert.match(t.root.querySelector('[data-slot="world-scale"]').textContent,new RegExp((actual-20).toLocaleString('en')+' models'));
    assert.match(t.root.querySelector('[data-slot="render-accounting"]').textContent,/count badge.*housing.*Soldiers and single scouts are drawn individually/);
  }finally{t.dispose();}
});

test('own tactical inspector explains decisions while foreign observation hides private reasoning',()=>{
  const t=setup();try{
    const home=t.state.settlements[0];
    const army={id:'ui-tactical-army',kind:'army',factionId:home.factionId,originId:home.id,size:12,units:{infantry:8,ranged:4},phase:'retreating',supply:75,morale:61,combat:{intent:'retreat',reason:'Observed defenders outnumber our supported force.',localStrength:12,enemyStrength:44}};
    setMilitary(t.state,home,army.units);bindArmy(t.state,home,army);t.state.groups.push(army);t.view.selectedId=army.id;t.update();
    const decision=t.root.querySelector('.tactical-reading');assert.ok(decision);assert.match(decision.textContent,/Retreat/);assert.match(decision.textContent,/Observed defenders outnumber/);assert.match(decision.textContent,/Own force\s*12/);assert.match(decision.textContent,/Estimated opposition\s*44/);
    t.view.perspective='f1';t.update({...t.state,viewer:{mode:'faction',factionId:'f1'},knownPlaces:[]});
    assert.equal(t.root.querySelector('.tactical-reading'),null);assert.doesNotMatch(t.root.querySelector('.inspector').textContent,/Observed defenders outnumber/);
  }finally{t.dispose();}
});

test('comparison chart updates a collapsed census and rebuilds cleanly after reset', () => {
  const t = setup(); try {
    assert.equal(t.root.querySelectorAll('.strength-bar[role="img"]').length, 4);
    t.state.factions[1].economy.population = 0; t.state.factions[1].economy.soldiers = 0;
    t.state.factions[1].status = 'collapsed'; t.update();
    const row = t.root.querySelector('.faction-entry[data-value="f1"]');
    assert.match(row.textContent, /0 workers · 0 military/); assert.equal(row.querySelector('.strength-workers').style.width, '0.00%');
    t.actions.reset('fresh-chart', { civCount: 3 });
    assert.equal(t.root.querySelectorAll('.strength-bar[role="img"]').length, 3);
    assert.ok(!t.root.querySelector('.faction-entry[data-value="f3"]'));
  } finally { t.dispose(); }
});


test('balanced-district rules are visible in the home and deposit inspectors',()=>{
  const t=setup();try{
    assert.match(t.root.querySelector('.balanced-district').textContent,/0.80 fertility/);
    const node=t.state.nodes.find(n=>n.balancedDistrict);t.view.selectedId=node.id;t.update();
    assert.match(t.root.querySelector('.balanced-district').textContent,/matched stocks and replenishment/);
  }finally{t.dispose();}
});


test('whole-world biome choice survives refresh and resets with the seed and civilisation count',()=>{
  const t=setup();try{
    t.root.querySelector('#atlas-biome').value='desert';t.fire('#atlas-biome','change');t.update();
    assert.equal(t.root.querySelector('#atlas-biome').value,'desert');
    t.fire('.seed-form','submit');assert.equal(t.calls.at(-1).config.biome,'desert');
    assert.equal(t.state.terrain.biome,'desert');assert.match(t.root.querySelector('[data-slot="world-biome"]').textContent,/Current world: Desert.*One biome throughout/);
    assert.equal(t.root.querySelector('#atlas-civs').value,'4');
    t.actions.reset('other-world',{civCount:3,biome:'alien'});
    assert.equal(t.root.querySelector('#atlas-biome').value,'alien');assert.match(t.root.querySelector('[data-slot="world-biome"]').textContent,/Alien meadow/);
  }finally{t.dispose();}
});
