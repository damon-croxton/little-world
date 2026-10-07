export const SIM_DT=0.1;
// Fixed10Hz physical motion. Rendering interpolates the last completed pulse.
export class SimulationClock{
  constructor(){this.remainder=0;this.stepSeconds=SIM_DT;this.droppedRequestedSeconds=0;}
  advance(seconds,speed,paused,step,limits={}){
    if(paused)return 0;
    this.remainder+=Math.max(0,seconds)*Math.max(0,speed);
    const backlog=limits.maxBacklogSeconds??Infinity;
    if(this.remainder>backlog){this.droppedRequestedSeconds+=this.remainder-backlog;this.remainder=backlog;}
    const maximum=Math.min(limits.maxPulses??512,Math.floor((this.remainder+1e-9)/SIM_DT));
    const now=limits.now??(()=>performance.now()),start=now(),budget=limits.budgetMs??Infinity;
    let n=0;
    while(n<maximum&&(n===0||now()-start<budget)){step(1);n++;this.remainder-=SIM_DT;}
    if(this.remainder<0&&this.remainder>-1e-8)this.remainder=0;
    return n;
  }
  get alpha(){return Math.max(0,Math.min(1,this.remainder/SIM_DT));}
  reset(){this.remainder=0;this.droppedRequestedSeconds=0;}
}
