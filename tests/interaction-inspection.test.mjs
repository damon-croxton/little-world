import { setMilitary, bindArmy, positionMilitary } from './roster-fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import * as THREE from 'three';
import { createSimulation } from '../src/sim/core.js';
import { initializeKnowledge, stepKnowledge, factionView } from '../src/sim/knowledge.js';
import { createUI } from '../src/ui.js';
import { createCrowds } from '../src/render/crowds.js';
import { createEntities } from '../src/render/entities.js';
import { findObserved, observedBuilding, factionFocusTarget, scenePickId, SelectionMemory, knowledgeOverlaySource } from '../src/selection.js';

function dom(state, view = {}) {
  const {document,window}=parseHTML('<html><body><div id="ui"></div></body></html>');
  const proto=window.HTMLSelectElement.prototype,descriptor=Object.getOwnPropertyDescriptor(proto,'value');
  if(!descriptor?.set)Object.defineProperty(proto,'value',{configurable:true,get:descriptor.get,set(value){for(const option of this.querySelectorAll('option'))option.removeAttribute('selected');[...this.querySelectorAll('option')].find(option=>option.value===String(value))?.setAttribute('selected','');}});
  const previous=globalThis.document;globalThis.document=document;
  const root=document.getElementById('ui'),calls=[];
  view={worldGeneration:0,selectedId:state.settlements[0]?.id,perspective:state.viewer?.factionId||'omniscient',speed:2,paused:true,quality:'low',...view};
  const ui=createUI(root,{inspectFaction(id){calls.push(['inspectFaction',id]);},select(id){calls.push(['select',id]);view.selectedId=id;ui.update(state,view);}});
  ui.update(state,view);
  return {root,calls,view,update(){ui.update(state,view);},text(){return root.querySelector('.inspector').textContent;},click(selector){const target=root.querySelector(selector);assert.ok(target,selector);target.dispatchEvent(new window.Event('click',{bubbles:true}));},dispose(){ui.dispose();if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}};
}

test('civilisation menu remains a complete perspective switch without revealing hidden census',()=>{
  const state=createSimulation('inspect-civilisations',{civCount:4});
  state.settlements[1].population=987654;
  initializeKnowledge(state,{reset:true});
  const scoped=factionView(state,'f0'),t=dom(scoped,{perspectiveOptions:state.factions.map(({id,name,species,color})=>({id,name,species,color}))});
  try{
    assert.equal(t.root.querySelectorAll('.faction-entry').length,4);
    assert.doesNotMatch(t.root.querySelector('.faction-list').textContent,/987,654/);
    const button=t.root.querySelector('.faction-entry[data-value="f1"]');assert.equal(button.disabled,false);
    assert.match(button.getAttribute('aria-label'),/perspective and focus home/);
    t.click('.faction-entry[data-value="f1"]');assert.deepEqual(t.calls,[['inspectFaction','f1']]);
    assert.equal(t.root.querySelector('.faction-entry[data-value="f0"]').getAttribute('aria-pressed'),'true');
  }finally{t.dispose();}
});

test('faction focus uses its scoped surviving base and never borrows another civilisation home',()=>{
  const state={factions:[{id:'f0'},{id:'f1'}],settlements:[{id:'occupied',factionId:'f0',occupiedBy:'f1',population:30},{id:'free',factionId:'f0',population:20},{id:'enemy',factionId:'f1',population:50}],groups:[],nodes:[],knownPlaces:[]};
  assert.equal(factionFocusTarget(state,'f0').id,'free');
  assert.equal(factionFocusTarget({...state,settlements:[state.settlements[2]]},'f0'),null);
  state.settlements[1].occupiedBy='f1';
  assert.equal(factionFocusTarget(state,'f0').id,'occupied');
  assert.equal(factionFocusTarget(state,'f1').id,'enemy');
});

test('building hits preserve structure identity, show its paid course and return to its own settlement',()=>{
  const state=createSimulation('inspect-building',{civCount:3}),home=state.settlements[0];
  const building={id:'selected-range',kind:'range',x:home.x+5,z:home.z,progress:1,hp:81,maxHp:160,fundedCost:{materials:75,energy:18}};
  home.buildings.push(building);home.trainingQueue=[{id:'course',buildingId:building.id,role:'ranged',size:3,progress:.5,remaining:9}];
  const t=dom(state,{selectedId:building.id});
  try{
    assert.match(t.root.querySelector('.selection-header').textContent,/Field Range/);
    assert.match(t.text(),/Integrity81 \/ 160/);assert.match(t.text(),/3 Trail archer · 50% trained · 9 cycles remaining/);
    assert.match(t.text(),/Controlled by/);assert.match(t.text(),/Native identity/);
    assert.equal(t.root.querySelector('[data-action="follow"]').dataset.value,building.id);
    const renderer=createEntities(THREE,new THREE.Scene());renderer.update(state);
    const proxy=renderer.getPickables().find(object=>object.userData.buildingId===building.id);assert.ok(proxy);
    assert.equal(scenePickId({object:proxy}),building.id);renderer.dispose();
    t.click('.building-detail [data-action="select"]');assert.equal(t.view.selectedId,home.id);
    const memory=new SelectionMemory();memory.record(state,building.id);home.buildings=home.buildings.filter(item=>item!==building);
    assert.equal(memory.reconcile(state,building.id),home.id);
  }finally{t.dispose();}
});

test('occupied buildings name the real controller and native civilisation separately',()=>{
  const state=createSimulation('inspect-control',{civCount:3}),home=state.settlements[1];home.occupiedBy='f0';
  const building=home.buildings[0],t=dom(state,{selectedId:building.id});
  try{
    const identity=t.root.querySelector('.identity-reading').textContent;
    assert.match(identity,new RegExp(`Controlled by${state.factions[0].name}`));
    assert.match(identity,new RegExp(`Native identity${state.factions[1].name}`));
    assert.match(t.root.querySelector('.selection-affiliation').textContent,new RegExp(state.factions[0].name));
  }finally{t.dispose();}
});

test('foreign building inspection shows visible condition without private queues, stocks or history',()=>{
  const state=createSimulation('inspect-foreign-building',{civCount:3}),[home,enemy]=state.settlements;
  state.groups=[];for(const settlement of state.settlements){settlement.buildings=[];settlement.sightRadius=20;}
  enemy.x=home.x+3;enemy.z=home.z;
  const building={id:'visible-enemy-range',kind:'range',x:enemy.x,z:enemy.z,progress:.45,hp:65,maxHp:160};
  const hiddenHome=state.settlements[2],hiddenBuilding={id:'unseen-building',kind:'storage',x:hiddenHome.x,z:hiddenHome.z,progress:1,hp:80,maxHp:100};
  hiddenHome.buildings=[hiddenBuilding];
  enemy.buildings=[building];enemy.stock.materials=543210;
  enemy.trainingQueue=[{buildingId:building.id,role:'SECRET_COURSE',size:987654,progress:.8,remaining:9}];
  state.factions[1].history=[{tick:0,text:'PRIVATE_NATIVE_HISTORY'}];
  initializeKnowledge(state,{reset:true});stepKnowledge(state,{force:true});
  const scoped=factionView(state,'f0');assert.ok(observedBuilding(scoped,building.id),'fixture building must actually be visible');
  const t=dom(scoped,{selectedId:building.id});
  try{
    for(const tab of ['life','intelligence','record']){
      t.click(`[data-action="tab"][data-value="${tab}"]`);
      assert.match(t.text(),/Observed building/);assert.match(t.text(),/Construction45%/);assert.match(t.text(),/Integrity65 \/ 160/);
      assert.match(t.text(),/Foreign stores, orders and training queues remain unknown/);
      assert.doesNotMatch(t.text(),/543,210|987,654|SECRET_COURSE|PRIVATE_NATIVE_HISTORY|Training here/);
    }
    assert.equal(findObserved(state,hiddenBuilding.id),hiddenBuilding);
    assert.equal(findObserved(scoped,hiddenBuilding.id),undefined);
  }finally{t.dispose();}
});

test('controlled native workers retain actionable party details when the home census is redacted',()=>{
  const state=createSimulation('inspect-controlled-party',{civCount:3}),[capital,occupied]=state.settlements;
  occupied.occupiedBy=capital.factionId;
  const group={id:'captive-crew',factionId:occupied.factionId,originId:occupied.id,kind:'worker',size:5,x:occupied.x+1,z:occupied.z,phase:'returning',supply:71,morale:76,capacity:40,carrying:{materials:18}};
  state.groups=[group];initializeKnowledge(state,{reset:true});stepKnowledge(state,{force:true});
  const scoped=factionView(state,capital.factionId),t=dom(scoped,{selectedId:group.id});
  try{
    assert.equal(scoped.groups[0].originId,null);
    assert.match(t.text(),/Supplies71%/);assert.match(t.text(),/18 materials/);assert.match(t.text(),/5 travellers/);
    assert.doesNotMatch(t.text(),/Home population|Stores & carrying limits/);
    assert.match(t.root.querySelector('.identity-reading').textContent,new RegExp(`Controlled by${state.factions[0].name}`));
    assert.match(t.root.querySelector('.identity-reading').textContent,new RegExp(`Native identity${state.factions[1].name}`));
  }finally{t.dispose();}
});

test('whole-world and faction inspection agree on nearby captive workers without claiming distant native crews',()=>{
  const state=createSimulation('inspect-local-controller',{civCount:3}),[capital,occupied]=state.settlements;
  occupied.occupiedBy=capital.factionId;
  const group={id:'locally-held-crew',factionId:occupied.factionId,originId:occupied.id,kind:'worker',size:5,x:occupied.x+1,z:occupied.z,phase:'returning',supply:71,morale:76,capacity:40,carrying:{materials:18}};
  state.groups=[group];initializeKnowledge(state,{reset:true});stepKnowledge(state,{force:true});
  for(const shown of [state,factionView(state,capital.factionId)]){
    const t=dom(shown,{selectedId:group.id});
    try{
      assert.match(t.root.querySelector('.identity-reading').textContent,new RegExp(`Controlled by${state.factions[0].name}`));
      assert.match(t.root.querySelector('.identity-reading').textContent,new RegExp(`Native identity${state.factions[1].name}`));
      assert.equal(knowledgeOverlaySource(shown,group.id).faction.id,capital.factionId);
    }finally{t.dispose();}
  }
  group.x=occupied.x+90;
  assert.equal(knowledgeOverlaySource(state,group.id).faction.id,occupied.factionId,'distant workers remain native assets');
  group.x=occupied.x+1;group.commandFactionId='f2';
  assert.equal(knowledgeOverlaySource(state,group.id).faction.id,'f2','explicit command takes precedence over local occupation');
});

test('occupied home troops and local crews use command tint while native species and civilian colours remain intact',()=>{
  const state=createSimulation('inspect-command-tint',{civCount:3}),home=state.settlements[1];
  state.settlements=[home];home.population=15;setMilitary(state,home,{infantry:2,ranged:2});home.assigned={};
  home.buildings=[{id:'staffed-tower',kind:'tower',x:home.x+4,z:home.z,progress:1,hp:100,maxHp:100,crewAssigned:1}];
  state.groups=[{id:'commanded-army',factionId:home.factionId,commandFactionId:'f0',originId:home.id,kind:'army',size:2,units:{infantry:1,ranged:1},x:home.x+10,z:home.z,phase:'outbound'},
    {id:'local-workers',factionId:home.factionId,originId:home.id,kind:'worker',size:3,x:home.x+1,z:home.z,phase:'returning'}];
  bindArmy(state,home,state.groups[0]);positionMilitary(state);
  const towerBody=home.soldierRoster.find(body=>body.groupId==null&&body.role==='ranged');
  Object.assign(towerBody,{towerId:'staffed-tower',x:home.x+4,z:home.z,prevX:home.x+4,prevZ:home.z,elevation:3.2,action:'tower-crew'});
  const scene=new THREE.Scene(),crowds=createCrowds(THREE,scene);
  const actualColor=sample=>{const result=new THREE.Color();scene.getObjectByProperty('uuid',sample.meshUuid).getColorAt(sample.instanceIndex,result);return result;};
  const tint=color=>new THREE.Color(color).lerp(new THREE.Color('#f0e5ca'),.12);
  const nearColor=(actual,expected)=>assert.ok(actual.toArray().every((component,i)=>Math.abs(component-expected.toArray()[i])<1e-6));
  try{
    crowds.update(state,0,null);
    nearColor(actualColor(crowds.getMotionSamples().find(sample=>sample.settlementId===home.id&&sample.militaryRole)),tint(state.factions[1].color));
    home.occupiedBy='f0';const unchanged=structuredClone(state);
    crowds.update(state,0,null);assert.equal(crowds.diagnostics.reusedFrame,false,'occupation at the same paused pulse refreshes allegiance');
    const samples=crowds.getMotionSamples(),troops=samples.filter(sample=>sample.settlementId===home.id&&sample.militaryRole);
    assert.ok(troops.some(sample=>sample.phase==='garrison'));assert.ok(troops.some(sample=>sample.phase==='tower-crew'));
    for(const sample of [...troops,...samples.filter(sample=>['commanded-army','local-workers'].includes(sample.groupId))]){
      assert.match(sample.poolKey,/^machine:/,'a command colour must never replace the native body species');
      nearColor(actualColor(sample),tint(state.factions[0].color));
    }
    assert.ok(!samples.some(sample=>sample.settlementId===home.id&&!sample.militaryRole), 'residents do not reappear as decorative crowd bodies');
    assert.equal(crowds.diagnostics.housedIndividuals,8); assert.equal(home.factionId,state.factions[1].id);
    assert.deepEqual(state,unchanged,'observer attribution does not mutate simulation authority');
  }finally{crowds.dispose();}
});

test('rendered civilians and individual soldiers resolve to their real scoped colony or party',()=>{
  const state={seed:'body-picks',tick:0,step:0,time:0,factions:[{id:'f0',species:'human',color:'#dca16b'},{id:'f1',species:'machine',color:'#85bbbf'}],settlements:[{id:'home',factionId:'f0',x:0,z:0,population:9,health:100,status:'active',soldiers:2,assigned:{},military:{infantry:1,ranged:1},buildings:[]},{id:'enemy',factionId:'f1',x:30,z:0,population:4,soldiers:0,assigned:{},buildings:[]}],groups:[{id:'soldiers',factionId:'f0',originId:'home',kind:'army',size:2,units:{infantry:1,ranged:1},x:12,z:12,prevX:12,prevZ:12,phase:'outbound'}],nodes:[]};
  const groups=state.groups;state.groups=[];setMilitary(state,state.settlements[0],{infantry:1,ranged:1});bindArmy(state,state.settlements[0],groups[0]);state.groups=groups;positionMilitary(state);
  state.groups.push({id:'own-scout',kind:'scout',factionId:'f0',originId:'home',size:1,x:2,z:2,phase:'outbound'},{id:'enemy-scout',kind:'scout',factionId:'f1',originId:'enemy',size:1,x:30,z:2,phase:'outbound'});
  const scene=new THREE.Scene(),crowds=createCrowds(THREE,scene);crowds.update(state,0,'soldiers');scene.updateMatrixWorld(true);
  try{
    for(const sample of [crowds.getMotionSamples().find(s=>s.groupId==='own-scout'),...crowds.getMotionSamples().filter(s=>s.groupId==='soldiers')]){
      assert.ok(sample);const mesh=scene.getObjectByProperty('uuid',sample.meshUuid);
      assert.ok(crowds.getPickables().includes(mesh));
      const ray=new THREE.Raycaster(new THREE.Vector3(sample.x,sample.groundY+8,sample.z),new THREE.Vector3(0,-1,0));
      const hit=ray.intersectObject(mesh).find(hit=>hit.instanceId===sample.instanceIndex);assert.ok(hit,'a ray through the body must hit its rendered instance');
      assert.equal(crowds.resolvePick(hit),sample.soldierId||sample.groupId||sample.settlementId);
    }
    const enemySample=crowds.getMotionSamples().find(s=>s.groupId==='enemy-scout'),oldEnemyMesh=scene.getObjectByProperty('uuid',enemySample.meshUuid);
    const scoped={...state,viewer:{mode:'faction',factionId:'f0'},settlements:[state.settlements[0]],factions:[state.factions[0]],groups:state.groups.filter(g=>g.factionId==='f0'),soldiers:state.settlements[0].soldierRoster};
    crowds.update(scoped,0,'soldiers');assert.equal(oldEnemyMesh.count,0);
    assert.ok(!crowds.resolvePick({object:oldEnemyMesh,instanceId:enemySample.instanceIndex}));
    for(const mesh of crowds.getPickables().filter(mesh=>mesh.userData.crowdSelectionIds))for(let i=0;i<mesh.count;i++)assert.ok(['own-scout',...state.groups[0].soldierIds].includes(crowds.resolvePick({object:mesh,instanceId:i})));
  }finally{crowds.dispose();}
});
