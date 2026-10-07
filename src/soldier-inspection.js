import { MILITARY_UNITS } from './sim/military.js';
import { findObserved } from './selection.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const title=value=>String(value??'').replace(/[_-]/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
const number=value=>Number.isFinite(value)?Math.round(value*10)/10:null;

export function soldierLabel(soldier){
  return MILITARY_UNITS[soldier.species]?.[soldier.role]?.name||title(soldier.role)||'Soldier';
}

// A selected soldier is resolved only from the supplied observer view. Even a
// malformed foreign projection cannot turn this panel into an orders inspector.
export function soldierInspectionMarkup(current,state){
  const {soldier,group,settlement,controller,nativeFaction}=current;
  const foreign=state.viewer?.mode==='faction'&&(soldier.knowledgeView==='visible'||soldier.commandFactionId!==state.viewer.factionId);
  const fallen=soldier.alive===false||soldier.status==='dead';
  const rows=[['Identity',soldier.id],['Role',soldierLabel(soldier)],['Controlled by',controller?.name||'Unknown'],['Native identity',`${nativeFaction?.name||'Unknown'} · ${title(soldier.species||nativeFaction?.species)}`]];
  if(!foreign){
    if(Number.isFinite(soldier.hp))rows.push(['Health',`${number(soldier.hp)}${Number.isFinite(soldier.maxHp)?` / ${number(soldier.maxHp)}`:''}`]);
    rows.push(['Action',fallen?'Fallen':title(soldier.action|| (soldier.towerId?'Tower duty':group?.phase||'Garrison'))]);
    if(!fallen){
      if(soldier.withdrawing)rows.push(['Movement','Withdrawing']);
      if(soldier.reasonCode)rows.push(['Decision',title(soldier.reasonCode)]);
      const target=soldier.targetId&&findObserved(state,soldier.targetId);
      if(target)rows.push(['Target',target.name||target.id]);
      else if(soldier.targetId)rows.push(['Target','Outside this view']);
      if(Number.isFinite(soldier.attackReadyAt))rows.push(['Weapon',soldier.attackReadyAt>(state.time??state.tick??0)?`Ready in ${number(soldier.attackReadyAt-(state.time??state.tick??0))} cycles`:'Ready']);
    }
  }
  const navigate=[];
  if(group)navigate.push(`<button class="text-button" data-action="select" data-value="${esc(group.id)}">Inspect ${esc(group.kind||'army')} party →</button>`);
  if(settlement)navigate.push(`<button class="text-button" data-action="select" data-value="${esc(settlement.id)}">Inspect ${esc(settlement.name||'settlement')} →</button>`);
  return `<section class="soldier-detail"><span class="knowledge-badge">${foreign?'Visible soldier':'Selected soldier'}</span><dl class="ledger-list identity-reading">${rows.map(([label,value])=>`<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>${foreign?'<p class="muted-note">Only this visible soldier is shown. Health, targets, weapon timing and orders remain unknown.</p>':'<p class="muted-note">This identity follows the same soldier through movement, injury and deployment.</p>'}${navigate.join('')}</section>`;
}
