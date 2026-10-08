import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, DEFAULT_CONFIG, MATCH_SETTINGS } from '../src/config.js';
import { createSimulation } from '../src/sim/core.js';
import { survivalNeeds, SURVIVAL_NEEDS } from '../src/sim/economy.js';
import { expansionRequirements, offensiveCooldown } from '../src/sim/match-rules.js';
import { unitStats } from '../src/sim/military.js';

test('all match controls clamp and quantize; invalid values preserve documented defaults',()=>{
  for(const [key,spec] of Object.entries(MATCH_SETTINGS)) {
    for(const value of [undefined,null,'',false,NaN,Infinity,'invalid'])assert.equal(normalizeConfig({[key]:value})[key],spec.default);
    assert.equal(normalizeConfig({[key]:-10})[key],spec.min);assert.equal(normalizeConfig({[key]:10})[key],spec.max);
    assert.equal(normalizeConfig({[key]:1.021})[key],1);assert.equal(normalizeConfig({[key]:1.039})[key],1.05);
  }
  assert.deepEqual(normalizeConfig({matchVersion:99}),DEFAULT_CONFIG);
});

test('settings preserve world layout, seeded identities and weapon damage while changing only their intended costs',()=>{
  const base=createSimulation('first-light',{civCount:6,resourceScale:1,upkeepScale:1,economyFocus:1,aggressionScale:1});
  const tuned=createSimulation('first-light',{civCount:6});
  assert.deepEqual(tuned,createSimulation('first-light',{civCount:6}));
  assert.deepEqual(tuned.factions.map(f=>f.name),['Human1','Robot1','Alien1','Human2','Robot2','Alien2']);
  assert.equal(new Set(tuned.factions.map(f=>f.color)).size,6);
  assert.deepEqual(tuned.factions.map(f=>f.traits),base.factions.map(f=>f.traits));
  assert.deepEqual(tuned.settlements.map(h=>[h.x,h.z,h.population,h.stock]),base.settlements.map(h=>[h.x,h.z,h.population,h.stock]));
  for(let i=0;i<base.nodes.length;i++) {const a=base.nodes[i],b=tuned.nodes[i];assert.deepEqual([b.x,b.z,b.richness,b.regeneration],[a.x,a.z,a.richness,a.regeneration]);assert.equal(b.amount,Math.round(a.amount*1.25));}
  for(let i=0;i<base.factions.length;i++) {
    const f=tuned.factions[i];for(const [key,value] of Object.entries(SURVIVAL_NEEDS[f.species]))assert.equal(survivalNeeds(f)[key],value*.85);
    assert.deepEqual(unitStats(f,'infantry'),unitStats(base.factions[i],'infantry'));
  }
  assert.ok(expansionRequirements(tuned).population<expansionRequirements(base).population);
  assert.ok(expansionRequirements(tuned).cooldown<expansionRequirements(base).cooldown);
  const f=tuned.factions[0],fast={...f,matchSettings:{...f.matchSettings,aggressionScale:1.5}};
  assert.ok(offensiveCooldown(fast)<offensiveCooldown(f));assert.ok(offensiveCooldown(fast,true)<offensiveCooldown(f,true));
});
