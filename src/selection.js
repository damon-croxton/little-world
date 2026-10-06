import {groupController,settlementController} from './sim/control.js';
// Observer selection is scoped to the rendered knowledge view, never hidden truth.
export const findObserved = (state,id) => state.settlements.find(s=>s.id===id)||state.groups.find(g=>g.id===id)||state.nodes.find(n=>n.id===id)||state.knownPlaces?.find(k=>k.id===id);
export class SelectionMemory {
  constructor(){this.party=null;}
  clear(){this.party=null;}
  record(state,id){const group=state.groups.find(g=>g.id===id);this.party=group?.originId?{id:group.id,originId:group.originId}:null;}
  reconcile(state,id,perspective='omniscient'){
    if(id&&findObserved(state,id))return id;
    const origin=this.party?.id===id&&findObserved(state,this.party.originId)?this.party.originId:null;
    this.party=null;
    return origin||(state.settlements.find(s=>s.factionId===perspective||s.controllerId===perspective)||state.settlements[0])?.id||null;
  }
}


// Knowledge routes always belong to the observer's polity in a scoped view.
// In omniscient mode an auxiliary selects its commander, not its native ledger.
export function knowledgeOverlaySource(state,selectedId){
  const selected=findObserved(state,selectedId);
  const group=state.groups.find(g=>g.id===selectedId),home=state.settlements.find(h=>h.id===selectedId);
  const owner=state.viewer?.mode==='faction'?state.viewer.factionId:group?groupController(state,group):home?(home.controllerId||settlementController(state,home)):selected?.ownerId||selected?.factionId;
  const faction=state.factions.find(f=>f.id===owner)||state.factions.find(f=>f.knowledge);
  const origin=faction&&state.settlements.find(h=>(h.controllerId||settlementController(state,h))===faction.id);
  return {faction,home:origin,knowledge:faction?.knowledge||{}};
}
