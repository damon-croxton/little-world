export const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
export const distance=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
export function hashSeed(seed){let h=2166136261;for(const c of String(seed)){h^=c.charCodeAt(0);h=Math.imul(h,16777619);}return h>>>0||1;}
export function random(s){let t=s.rng+=0x6D2B79F5;s.rng>>>=0;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296;}
export function emit(s,type,text,factionId=null,details={}){const e={id:'e'+s.nextId++,tick:s.tick,type,text,factionId,...details};s.events.push(e);if(s.events.length>160)s.events.shift();const f=s.factions.find(f=>f.id===factionId);if(f){f.history.push(e);if(f.history.length>24)f.history.shift();}return e;}
export const SPECIES={human:{name:'Earth settlers',noun:'people'},machine:{name:'Scavenger machines',noun:'units'},hive:{name:'Alien hive',noun:'drones'}};
