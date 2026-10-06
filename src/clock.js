export const SIM_DT=0.1;
// Fixed10Hz physical motion. Rendering interpolates the last completed pulse.
export class SimulationClock{
  constructor(){this.remainder=0;this.stepSeconds=SIM_DT;}
  advance(seconds,speed,paused,step){if(paused)return 0;this.remainder+=Math.max(0,seconds)*Math.max(0,speed);const n=Math.min(512,Math.floor((this.remainder+1e-9)/SIM_DT));if(n){step(n);this.remainder-=n*SIM_DT;if(this.remainder<0&&this.remainder>-1e-8)this.remainder=0;}return n;}
  get alpha(){return Math.max(0,Math.min(1,this.remainder/SIM_DT));}
  reset(){this.remainder=0;}
}
