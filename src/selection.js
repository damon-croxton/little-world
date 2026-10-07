import {settlementController} from './sim/control.js';
import {localGroupController} from './sim/knowledge.js';
// Observer selection is scoped to the rendered knowledge view, never hidden truth.
export const observedGroupController = (state,group) => group.controllerId || localGroupController(state,group);
export function observedBuilding(state,id){
  for(const settlement of state.settlements||[]){const building=settlement.buildings?.find(b=>b.id===id);if(building)return {settlement,building};}
  return null;
}
export function observedSoldier(state,id){
  // Recent observed deaths remain inspectable until the view drops its body
  // record. Their saved identity never resolves to a replacement survivor.
  const soldier=state.soldiers?.find(person=>person.id===id);
  if(!soldier)return null;
  const group=state.groups?.find(party=>party.id===soldier.groupId);
  const settlement=state.settlements?.find(home=>home.id===(soldier.originId||group?.originId));
  return {soldier,group,settlement};
}
export const findObserved = (state,id) => state.settlements.find(s=>s.id===id)||state.groups.find(g=>g.id===id)||state.nodes.find(n=>n.id===id)||observedSoldier(state,id)?.soldier||observedBuilding(state,id)?.building||state.knownPlaces?.find(k=>k.id===id);

// Public faction identities choose a new observer perspective. Camera targets
// are resolved only after that perspective has produced its scoped world.
export function factionFocusTarget(state,factionId){
  const homes=state.settlements||[],alive=home=>home.population!==0&&home.status!=='ruin';
  const native=homes.filter(home=>home.factionId===factionId);
  return native.find(home=>alive(home)&&(home.controllerId||settlementController(state,home))===factionId)
    ||homes.find(home=>alive(home)&&(home.controllerId||settlementController(state,home))===factionId)
    ||native.find(alive)||native[0]
    ||state.groups?.find(group=>!group.finished&&observedGroupController(state,group)===factionId)
    ||state.knownPlaces?.find(place=>place.kind==='settlement'&&(place.ownerId===factionId||place.nativeOwnerId===factionId))||null;
}

export function scenePickId(hit){
  for(let object=hit?.object;object;object=object.parent){const data=object.userData||{};const id=data.buildingId||data.groupId||data.settlementId;if(id)return id;}
  return null;
}
export class SelectionMemory {
  constructor(){this.party=null;}
  clear(){this.party=null;}
  record(state,id){const person=observedSoldier(state,id),group=person?.group||state.groups.find(g=>g.id===id),homeId=person?.settlement?.id||group?.originId||observedBuilding(state,id)?.settlement.id;this.party=homeId||person?.group?{id,groupId:person?.group?.id,originId:homeId}:null;}
  reconcile(state,id,perspective='omniscient'){
    if(id&&findObserved(state,id))return id;
    const fallback=this.party?.id===id?this.party:null;
    if(fallback?.groupId&&findObserved(state,fallback.groupId)){this.party=fallback.originId?{id:fallback.groupId,originId:fallback.originId}:null;return fallback.groupId;}
    const origin=fallback&&findObserved(state,fallback.originId)?fallback.originId:null;
    this.party=null;
    return origin||(state.settlements.find(s=>s.factionId===perspective||s.controllerId===perspective)||state.settlements[0])?.id||null;
  }
}


// Knowledge routes always belong to the observer's polity in a scoped view.
// In omniscient mode an auxiliary selects its commander, not its native ledger.
export function knowledgeOverlaySource(state,selectedId){
  const selected=findObserved(state,selectedId);
  const person=observedSoldier(state,selectedId),group=person?.group||state.groups.find(g=>g.id===selectedId),home=person?.settlement||state.settlements.find(h=>h.id===selectedId)||observedBuilding(state,selectedId)?.settlement;
  const owner=state.viewer?.mode==='faction'?state.viewer.factionId:person?.soldier.commandFactionId|| (group?observedGroupController(state,group):home?(home.controllerId||settlementController(state,home)):selected?.ownerId||selected?.factionId);
  const faction=state.factions.find(f=>f.id===owner)||state.factions.find(f=>f.knowledge);
  const origin=faction&&state.settlements.find(h=>(h.controllerId||settlementController(state,h))===faction.id);
  return {faction,home:origin,knowledge:faction?.knowledge||{}};
}
