import test from 'node:test';
import assert from 'node:assert/strict';
import {findObserved,SelectionMemory,knowledgeOverlaySource} from '../src/selection.js';
const state=()=>({settlements:[{id:'s0',factionId:'f0'},{id:'s2',factionId:'f0'}],groups:[{id:'party',originId:'s2',factionId:'f0'}],nodes:[],knownPlaces:[]});
test('a party completing during ordinary frames returns inspection to its actual home',()=>{const s=state(),memory=new SelectionMemory();memory.record(s,'party');s.groups=[];assert.equal(memory.reconcile(s,'party','f0'),'s2');});
test('unknown or hidden party origins are never resolved through private world data',()=>{const s=state(),memory=new SelectionMemory();memory.record(s,'party');s.groups=[];s.settlements=s.settlements.slice(0,1);assert.equal(memory.reconcile(s,'party','f0'),'s0');assert.equal(findObserved(s,'s2'),undefined);});
test('perspective switches keep visible contacts and remembered places, reset clears prior origin',()=>{const s=state(),memory=new SelectionMemory();memory.record(s,'party');s.groups=[];s.knownPlaces=[{id:'party',kind:'settlement',x:1,z:1}];assert.equal(memory.reconcile(s,'party','f0'),'party');memory.clear();s.knownPlaces=[];assert.equal(memory.reconcile(s,'party','f0'),'s0');});

test('knowledge overlays follow auxiliary command and cannot borrow enemy reports in scoped views',()=>{
 const s=state();s.factions=[{id:'f0',knowledge:{native:{id:'native'}}},{id:'f1',knowledge:{command:{id:'command'}}}];s.groups[0].commandFactionId='f1';s.settlements[1].occupiedBy='f1';
 const source=knowledgeOverlaySource(s,'party');assert.equal(source.faction.id,'f1');assert.equal(source.home.id,'s2');assert.deepEqual(Object.keys(source.knowledge),['command']);
 s.viewer={mode:'faction',factionId:'f0'};const scoped=knowledgeOverlaySource(s,'party');assert.equal(scoped.faction.id,'f0');assert.equal(scoped.home.id,'s0');assert.deepEqual(Object.keys(scoped.knowledge),['native']);
});
