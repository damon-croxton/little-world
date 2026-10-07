import test from 'node:test';
import assert from 'node:assert/strict';
import { generateWorld, terrainAt, heightAt, biomeAt, BALANCED_SUPPLIES, BALANCED_DISTRICT, worldTerrainSeed } from '../src/world.js';
import { createSimulation, stepSimulation, planFounding } from '../src/sim/core.js';
import { SURVIVAL_NEEDS, initializeLedger, ledgerResidual } from '../src/sim/economy.js';
import { findPath, isSegmentTraversable } from '../src/sim/navigation.js';
import { stepProgression } from '../src/sim/progression.js';
import { observationFor, factionView } from '../src/sim/knowledge.js';

for (const seed of ['first-light', 'river-fairness']) for (const civCount of [3,4,5,6]) test(`${seed}/${civCount}: physical districts, supplies and first expansion approaches are matched`, () => {
  const world = generateWorld(seed,{civCount}), state = {seed,terrainSeed:world.terrainSeed,settlements:[],factions:[],groups:[],walls:[]};
  assert.equal(world.nodes.length,160); assert.equal(world.districts.length,civCount*2);
  assert.deepEqual(generateWorld(seed,{civCount}),world,'identical seed/count changed generation');
  for (const district of world.districts) {
    const nodes=world.nodes.filter(n=>n.balancedDistrict===district.id); assert.equal(nodes.length,4);
    for(const node of nodes){
      assert.equal(node.amount,BALANCED_SUPPLIES[district.kind][node.kind]);assert.equal(node.richness,.7);assert.equal(node.regeneration,BALANCED_SUPPLIES.regeneration[node.kind]);
      const route=findPath(state,district,node,{radius:.35});assert.ok(route.reachable);assert.ok(Math.abs(route.length-16)<1e-6);
      assert.ok(isSegmentTraversable(state,district,node,{radius:.35}));
      for(let i=0;i<=16;i++){const t=i/16;assert.equal(terrainAt(district.x+(node.x-district.x)*t,district.z+(node.z-district.z)*t,world.terrainSeed).movement,1);}
    }
    for(let x=-18;x<=18;x+=6)for(let z=-18;z<=18;z+=6)if(Math.hypot(x,z)<=20){const t=terrainAt(district.x+x,district.z+z,world.terrainSeed);assert.ok(t.traversable&&t.slope<.4&&t.height>.65);assert.equal(t.fertility,.8);assert.equal(t.movement,1);}
    if(district.kind==='start'){
      const expansion=world.districts.find(d=>d.kind==='expansion'&&d.slot===district.slot),route=findPath(state,district,expansion,{radius:1});
      assert.ok(route.reachable);assert.ok(Math.abs(route.length-48)<1e-6);assert.ok(isSegmentTraversable(state,district,expansion,{radius:1}));
      assert.ok(findPath(state,expansion,{x:0,z:0},{radius:1}).reachable);
    }
  }
  assert.ok(world.nodes.some(n=>!n.balancedDistrict&&n.regeneration===0),'outer finite scarcity disappeared');
  assert.ok(new Set(world.nodes.map(n=>n.biome)).size===3,'biome scenery disappeared');
});

test('matched starter deposits cover at least 350 cycles of every species maximum starting upkeep',()=>{
  for(const needs of Object.values(SURVIVAL_NEEDS))for(const [kind,need] of Object.entries(needs))if(need)assert.ok(BALANCED_SUPPLIES.start[kind]/(112*need)>=350,kind);
  assert.equal(BALANCED_DISTRICT.fertility,.8);
});

test('physical map keys separate count settings without changing public seed or reset determinism',()=>{
  const a=createSimulation('repeat-me',{civCount:3}),b=createSimulation('repeat-me',{civCount:6}),again=createSimulation('repeat-me',{civCount:3});
  assert.equal(a.seed,'repeat-me');assert.equal(b.seed,'repeat-me');assert.notEqual(a.terrainSeed,b.terrainSeed);assert.deepEqual(a,again);
  assert.equal(factionView(a,a.factions[0].id).terrainSeed,a.terrainSeed);
  assert.equal(heightAt(a.settlements[0].x,a.settlements[0].z,a.terrainSeed),2.2);
  assert.equal(worldTerrainSeed('repeat-me',{civCount:3}),a.terrainSeed);
});

test('actual opening production uses equal farm and power rules across visual biomes',()=>{
  const s=createSimulation('first-light');stepSimulation(s,10);
  for(const h of s.settlements){const f=s.factions.find(f=>f.id===h.factionId);assert.ok(Math.abs(h.lastProduction.energy-1.4)<1e-8);assert.ok(Math.abs(h.lastProduction.food-(f.species==='machine'?0:1.472*s.season.fertility))<1e-8);}
});

test('first-expansion sites enter planning only through observed resource reports and retain funded accounting',()=>{
  const s=createSimulation('first-light'),h=s.settlements[0],f=s.factions[0];Object.assign(s,{tick:200,step:2000,time:200});Object.assign(h,{population:150,workers:130,availableWorkers:100,health:100,shortageDays:0,lastExpansion:0});for(const key of Object.keys(h.stock))h.stock[key]=1500;
  const own=s.terrain.districts.find(d=>d.kind==='start'&&Math.hypot(d.x-h.x,d.z-h.z)<.1),target=s.terrain.districts.find(d=>d.kind==='expansion'&&d.slot===own.slot);
  f.knowledge={};planFounding(s,h,f);assert.ok(!s.groups.some(g=>g.kind==='colonist'),'hidden guarantee leaked into AI orders');
  for(const n of s.nodes.filter(n=>n.balancedDistrict===target.id)){const report=observationFor(s,f,n);assert.deepEqual(report.foundingSite,{id:target.id,x:target.x,z:target.z});f.knowledge[n.id]={...report,reportedTick:s.tick};}
  initializeLedger(s);planFounding(s,h,f);const party=s.groups.find(g=>g.kind==='colonist');assert.ok(party);assert.equal(party.targetX,target.x);assert.equal(party.targetZ,target.z);
  assert.ok(party.carrying.materials>=170);for(const residual of Object.values(ledgerResidual(s)))assert.ok(Math.abs(residual)<1e-7);
});


test('districts keep biome scenery while habitat research is neutral for every species',()=>{
  const s=createSimulation('first-light');
  for(const h of s.settlements){assert.equal(biomeAt(h.x,h.z,s.seed),biomeAt(h.x,h.z,s.terrainSeed));for(const k of Object.keys(h.stock))h.stock[k]=1500;h.availableWorkers=100;h.assigned={};}
  for(let tick=24;tick<40;tick++){s.tick=tick;s.step=tick*10;s.time=tick;stepProgression(s);}
  for(const f of s.factions){assert.ok(f.tech.progress>0);assert.equal(f.tech.environment,'Balanced district: ×1.00 trial yield');}
  const point={x:145,z:20};assert.equal(heightAt(point.x,point.z,s.seed),heightAt(point.x,point.z,s.terrainSeed),'untouched outer ground was globally flattened');
});
