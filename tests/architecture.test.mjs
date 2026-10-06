import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createEntities } from '../src/render/entities.js';

function fixture() {
  const kinds = { human: ['barracks','range'], machine: ['fabricator','launcher'], hive: ['brooder','spitter'] };
  const factions = Object.keys(kinds).map((species,i) => ({ id:`f${i}`, species, color:['#d5ab75','#8ec7b9','#b6a4c1'][i] }));
  const settlements = factions.map((f,i) => ({ id:`s${i}`,factionId:f.id,lastFactionId:f.id,x:(i-1)*27,z:0,population:100,soldiers:16,status:'active',radius:15,roads:[], buildings:[...kinds[f.species],'wall','gate','tower'].map((kind,j)=>({id:`${f.id}b${j}`,kind,x:(i-1)*27+(j-2)*5,z:j%2?5:-5,rotation:.3,progress:1,hp:200,maxHp:200,...(kind==='wall'?{length:7,width:1}:kind==='gate'?{length:9,width:1,gateWidth:5}:kind==='tower'?{length:3,width:3}:{})})) }));
  return {seed:'architecture-proof',tick:0,step:0,time:0,factions,settlements,groups:[],nodes:[]};
}
function setup() {
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(40,1.6,.1,1000);camera.position.set(24,32,52);camera.lookAt(0,0,0);scene.userData.camera=camera;
  return {scene,renderer:createEntities(THREE,scene)};
}

test('each species has distinct original producer and wall/gate/tower geometry from actual records',()=>{
  const state=fixture(),{scene,renderer}=setup();renderer.update(state,0,null,0);
  const d=renderer.diagnostics;assert.equal(d.buildingRecords,15);assert.equal(d.renderedBuildings,15);assert.equal(d.completedBuildings,15);
  for(const kind of ['barracks','range','fabricator','launcher','brooder','spitter'])assert.equal(d.byKind[kind],1,`${kind} fell back to unrelated geometry`);
  for(const kind of ['wall','gate','tower'])assert.equal(d.byKind[kind],3);
  const speciesHashes={};let vertices=0;
  scene.traverse(mesh=>{if(!mesh.isInstancedMesh||!mesh.count)return;const p=mesh.geometry.attributes.position;vertices+=p.count;for(const x of p.array)assert.ok(Number.isFinite(x));assert.ok(mesh.geometry.boundingSphere.radius>0);for(const species of ['human','machine','hive'])if(mesh.name.includes(` ${species} tower `))speciesHashes[species]=(speciesHashes[species]||0)+p.count;});
  assert.equal(Object.keys(speciesHashes).length,3);assert.equal(new Set(Object.values(speciesHashes)).size,3,'all tower meshes were identical');assert.ok(vertices<250000,'architectural template complexity unexpectedly grew');renderer.dispose();
});

test('construction and destroyed defenses render real completion and ruins without remaining live towers',()=>{
  const state=fixture(),{renderer}=setup();state.settlements[0].buildings[0].progress=.25;state.settlements[1].buildings.at(-1).hp=0;state.settlements[1].buildings.at(-1).destroyed=true;
  renderer.update(state,0,null,0);assert.equal(renderer.diagnostics.constructionSites,1);assert.equal(renderer.diagnostics.ruinedBuildings,1);assert.equal(renderer.diagnostics.completedBuildings,13);assert.equal(renderer.getPickables().length,15);renderer.dispose();
});

test('faction-filtered building views remove hidden geometry and pick targets, then restore observer view',()=>{
  const state=fixture(),{scene,renderer}=setup();renderer.update(state,0,null,0);
  renderer.update({...state,viewer:{mode:'faction',factionId:'f0'},settlements:[state.settlements[0]],factions:[state.factions[0]]},0,null,0);
  assert.equal(renderer.diagnostics.renderedBuildings,5);assert.ok(renderer.getPickables().every(p=>p.userData.settlementId==='s0'));
  scene.traverse(mesh=>{if(mesh.isInstancedMesh&&/ machine | hive /.test(mesh.name))assert.equal(mesh.count,0,'hidden foreign geometry remained visible');});
  renderer.update(state,0,null,0);assert.equal(renderer.diagnostics.renderedBuildings,15);renderer.dispose();
});
