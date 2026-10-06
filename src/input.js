// Pure pointer bookkeeping shared by the canvas and synthetic gesture tests.
// Browser scrolling is contained by canvas touch-action; panels keep pan-y.
export class PointerGestures {
  constructor(threshold=8) { this.threshold=threshold;this.points=new Map();this.multiple=false; }
  down(id,x,y) { this.points.set(id,{x,y,moved:false});if(this.points.size>1)this.multiple=true; }
  move(id,x,y) { const p=this.points.get(id);if(p&&Math.hypot(x-p.x,y-p.y)>this.threshold)p.moved=true; }
  up(id,x,y) { const p=this.points.get(id),tap=!!p&&!p.moved&&!this.multiple&&this.points.size===1&&Math.hypot(x-p.x,y-p.y)<=this.threshold;this.points.delete(id);if(!this.points.size)this.multiple=false;return {tap,x,y}; }
  cancel(id) { this.points.delete(id);if(!this.points.size)this.multiple=false; }
  clear() { this.points.clear();this.multiple=false; }
}
