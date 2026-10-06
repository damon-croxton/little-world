import test from 'node:test';
import assert from 'node:assert/strict';
import {PointerGestures} from '../src/input.js';
test('a stationary single pointer taps but drags and return-to-origin pans never select',()=>{const g=new PointerGestures();g.down(1,10,20);assert.equal(g.up(1,11,21).tap,true);g.down(2,10,20);g.move(2,60,20);assert.equal(g.up(2,10,20).tap,false);});
test('two-pointer pinch/orbit cannot end in a spurious scene selection',()=>{const g=new PointerGestures();g.down(1,10,20);g.down(2,50,20);g.move(1,0,20);g.move(2,70,20);assert.equal(g.up(1,10,20).tap,false);assert.equal(g.up(2,50,20).tap,false);g.down(3,10,20);assert.equal(g.up(3,10,20).tap,true);});
test('cancelled pointer gestures are cleared without ghost taps',()=>{const g=new PointerGestures();g.down(1,0,0);g.cancel(1);assert.equal(g.up(1,0,0).tap,false);g.down(1,0,0);g.down(2,20,0);g.cancel(2);assert.equal(g.up(1,0,0).tap,false);g.down(3,1,1);g.clear();assert.equal(g.up(3,1,1).tap,false);});
