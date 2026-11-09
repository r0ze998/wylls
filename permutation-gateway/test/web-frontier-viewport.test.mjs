// Pure shipped viewport geometry; no app boot, network, wallet, WASM or worker.
// The original exhaustive algorithm is retained solely as the regression oracle.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {visibleProvinces,provinceCandidates,provinceWindow} from '../../permutation-server/web/frontier/map/viewport.mjs';
import {ringProvinces,ringOf} from '../../permutation-server/web/frontier/fgeo.mjs';
import {provincePixel,PROVINCE_CIRCUMRADIUS} from '../../permutation-server/web/frontier/map/layers.mjs';
import {nearQuad} from '../../permutation-server/web/frontier/map/tilt.mjs';

function exhaustive(view,size,maxRing,quad=null) {
  const a={x:-size.width/2/view.zoom+view.x,y:-size.height/2/view.zoom+view.y};
  const b={x:size.width/2/view.zoom+view.x,y:size.height/2/view.zoom+view.y};
  const m=PROVINCE_CIRCUMRADIUS,out=[];
  for(let d=0;d<=maxRing;d++) for(const pr of ringProvinces(d)) {
    const c=provincePixel(pr.p,pr.q);
    if(c.x>=a.x-m && c.x<=b.x+m && c.y>=a.y-m && c.y<=b.y+m && nearQuad(quad,c.x,c.y,m)) {
      out.push({...pr,dist:Math.hypot(c.x-view.x,c.y-view.y)});
    }
  }
  return out.sort((a,b)=>a.dist-b.dist).map(({p,q})=>({p,q}));
}
const sizes=[{width:390,height:844},{width:1440,height:900},{width:2800,height:1800},{width:1,height:700}];
const match=(view,size,ring,quad=null)=>assert.deepEqual(visibleProvinces(view,size,ring,quad),exhaustive(view,size,ring,quad),JSON.stringify({view,size,ring}));

test('viewport output and distance ties exactly match original ring scans at every supported scale',()=>{
  for(const ring of [0,1,8,64,128]) for(const size of sizes) for(const zoom of [.005,.02,.13,.5,1,2.2]) {
    match({x:0,y:0,zoom},size,ring);
    const c=provincePixel(ring,0);
    match({x:c.x+47.5,y:c.y-19.25,zoom},size,ring);
  }
});

test('all six edges, negative coordinates and tilted ground retain exact culling',()=>{
  for(const ring of [1,8,64,128]) for(const [p,q] of [[ring,0],[0,ring],[-ring,ring],[-ring,0],[0,-ring],[ring,-ring]]) {
    const c=provincePixel(p,q),view={...c,zoom:.6},size=sizes[1];
    const w=size.width/view.zoom/2,h=size.height/view.zoom/2;
    const quad=[{x:c.x-w*.7,y:c.y-h},{x:c.x+w*.7,y:c.y-h},{x:c.x+w,y:c.y+h},{x:c.x-w,y:c.y+h}];
    match(view,size,ring,quad);
    match(view,size,ring,[...quad].reverse());
    match({...view,x:c.x*3,y:c.y*3},size,ring);
  }
});

test('exact viewport edges and fractional ring counts preserve boundary cells',()=>{
  const m=PROVINCE_CIRCUMRADIUS,size={width:100,height:100},c=provincePixel(-3,2);
  for(const delta of [-1e-9,0,1e-9]) for(const sign of [-1,1]) {
    match({x:c.x+sign*(m+50)+delta,y:c.y,zoom:1},size,8);
    match({x:c.x,y:c.y+sign*(m+50)+delta,zoom:1},size,8);
  }
  match({x:0,y:0,zoom:.2},sizes[0],8.7);
  match({x:0,y:0,zoom:1},{width:0,height:0},0);
});

test('close-up work depends on viewport size, not 49,537 opened provinces',()=>{
  const view={x:0,y:0,zoom:1};
  const small=[...provinceCandidates(view,sizes[1],8)].length;
  const large=[...provinceCandidates(view,sizes[1],128)].length;
  assert.equal(large,small);
  assert.ok(large<100,`${large} candidates, not 49,537`);
  console.log(`desktop close view: ${large} candidates at both ring8 and ring128; original ring128 scans 49,537`);
  const far=provincePixel(128,0);
  assert.ok([...provinceCandidates({...far,zoom:1},sizes[0],130)].length<100);
});

test('cloud margin beyond the gameplay limit stays drawable without host-index lookups',()=>{
  const view={...provincePixel(129,0),zoom:1};
  assert.throws(()=>exhaustive(view,sizes[0],130),TypeError,'old ring index returns null beyond128');
  const cells=visibleProvinces(view,sizes[0],130);
  assert.ok(cells.some(x=>x.p===129&&x.q===0));
  assert.ok(cells.every(x=>Number.isInteger(x.p)&&Number.isInteger(x.q)&&ringOf(x.p,x.q)<=130));
  assert.deepEqual(cells,visibleProvinces(view,sizes[0],130),'stable including cloud-cell ties');
});

test('invalid nonfinite geometry fails closed and original renderer uses this module',()=>{
  for(const maxRing of [-1,NaN,Infinity,undefined,1e100]) assert.deepEqual(visibleProvinces({x:0,y:0,zoom:1},sizes[0],maxRing),[]);
  for(const zoom of [0,-1,NaN,Infinity]) assert.equal(provinceWindow({x:0,y:0,zoom},sizes[0],128),null);
  assert.equal(provinceWindow({x:0,y:0,zoom:Number.MIN_VALUE},sizes[0],128),null);
  assert.deepEqual(visibleProvinces({x:1e100,y:-1e100,zoom:1},sizes[0],128),[]);
  const source=readFileSync(new URL('../../permutation-server/web/frontier/map/fmap.mjs',import.meta.url),'utf8');
  assert.match(source,/import \{ visibleProvinces \} from '\.\/viewport\.mjs'/);
  assert.match(source,/export \{ visibleProvinces \} from '\.\/viewport\.mjs'/);
  assert.doesNotMatch(source,/function visibleProvinces/);
});
