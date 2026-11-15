// Re-entrant and late callers of the shared overview queue
// (permutation-server/web/frontier/map/overviews.mjs) over injected read-only
// responses. No app boot, network, wallet, renderer, WASM, worker or key use.
// The queue's other behaviour: web-frontier-overview-queue.test.mjs.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readOverviews,OVERVIEW_IN_FLIGHT} from '../../permutation-server/web/frontier/map/overviews.mjs';
import {overviewRings} from '../../permutation-server/web/frontier/map/world.mjs';

const flush=async()=>{for(let i=0;i<12;i++) await Promise.resolve();};
const state=(n=8)=>({world:{ringsOpen:n,ringProvinces:Array.from({length:n},(_,d)=>d?6*d:1)},overviews:new Map(),holdings:[]});
function source() {
  const pending=[],calls=[];let active=0,peak=0;
  const overview=ring=>new Promise(resolve=>{
    active++;peak=Math.max(peak,active);calls.push(ring);
    pending.push({ring,finish:(answer={ok:true,ring,serial:calls.length,provinces:[]})=>{active--;resolve(answer);}});
  });
  return {herald:{overview},pending,calls,peak:()=>peak};
}
const finishAll=async s=>{s.pending.splice(0).forEach(x=>x.finish());await flush();};

test('a redraw callback that asks for its ring again gets a read of its own, one response at a time',async()=>{
  const FS=state(1),s=source();let redraws=0,inner=null;
  // A new closure per request, as an inline onChange is at every call site.
  const redraw=()=>()=>{redraws++;if(redraws<3) inner=readOverviews(FS,{herald:s.herald,rings:[0],onChange:redraw()});};
  const outer=readOverviews(FS,{herald:s.herald,rings:[0],onChange:redraw()});
  await flush();assert.deepEqual(s.calls,[0]);
  await finishAll(s);
  assert.equal(redraws,1,'one response redraws once: the request made while redrawing is not walked in the same pass');
  assert.deepEqual(s.calls,[0,0],'that request reads again instead of being answered by the response just taken');
  assert.deepEqual(await outer,[true]);
  await finishAll(s);assert.equal(redraws,2);assert.deepEqual(s.calls,[0,0,0]);
  await finishAll(s);assert.equal(redraws,3);
  assert.deepEqual(await inner,[true]);
  assert.deepEqual(s.calls,[0,0,0],'the callback stopped asking, so the queue stopped reading');
  assert.equal(FS.overviews.get(0).serial,3,'the last response is the one kept');
  assert.equal(s.peak(),1);
});

test('a caller that arrives after a response was taken, before its job settled, is not answered by it',async()=>{
  const FS=state(1),s=source(),early=[],lateSeen=[];let late=null;
  const first=readOverviews(FS,{herald:s.herald,rings:[0],onChange:d=>{
    early.push(d);
    // Runs after the response was stored and before the job's settlement.
    Promise.resolve().then(()=>{late=readOverviews(FS,{herald:s.herald,rings:[0],onChange:x=>lateSeen.push(x)});});
  }});
  await flush();await finishAll(s);
  assert.deepEqual(await first,[true]);assert.deepEqual(early,[0]);
  assert.ok(late,'the late request was made');
  assert.deepEqual(s.calls,[0,0],'it starts its own read');
  assert.deepEqual(lateSeen,[],'and has seen nothing yet');
  await finishAll(s);
  assert.deepEqual(await late,[true]);assert.deepEqual(lateSeen,[0],'its redraw runs with its own response');
  assert.deepEqual(early,[0],'the settled caller is not redrawn by a read it did not ask for');
  assert.equal(FS.overviews.get(0).serial,2);
});

test('callers that share a job before its response still coalesce, and each redraws once',async()=>{
  const FS=state(2),s=source(),a=[],b=[];
  const first=readOverviews(FS,{herald:s.herald,rings:[0,1],onChange:d=>a.push(d)});
  await flush();
  const second=readOverviews(FS,{herald:s.herald,rings:[1],onChange:d=>b.push(d)});
  await finishAll(s);
  assert.deepEqual(await first,[true,true]);assert.deepEqual(await second,[true]);
  assert.deepEqual(s.calls.slice().sort(),[0,1]);assert.deepEqual(a.sort(),[0,1]);assert.deepEqual(b,[1]);
});

test('any extent field that changes while a stored response is redrawn is read again before the caller settles',async()=>{
  for(const field of ['ringProvinces','ringsOpened','rMax','rMaxCeiling','rMaxHard']) {
    const FS=state(1),s=source();Object.assign(FS.world,{ringsOpened:1,rMax:0,rMaxCeiling:2,rMaxHard:128});
    let redraws=0,settled=false;
    const done=readOverviews(FS,{herald:s.herald,rings:[0],onChange:()=>{
      if(redraws++===0) FS.world={...FS.world,[field]:field==='ringProvinces'?[2]:FS.world[field]+1};
    }});
    done.then(()=>{settled=true;});
    await flush();await finishAll(s);
    assert.equal(FS.overviews.get(0).serial,1,field);
    assert.equal(FS.overviewTaken.get(0),1,`${field}: stamped with the count it was read under, never a newer one`);
    if(field!=='ringProvinces') assert.deepEqual(overviewRings(FS.world,FS.overviewTaken),[],`${field}: the default rings alone would not ask again`);
    assert.deepEqual(s.calls,[0,0],`${field}: the queue reads again by itself`);
    assert.equal(settled,false,`${field}: the caller still awaits the read under the current world`);
    await finishAll(s);
    assert.deepEqual(await done,[true],field);assert.equal(redraws,2,field);
    assert.equal(FS.overviews.get(0).serial,2,field);
    assert.equal(FS.overviewTaken.get(0),field==='ringProvinces'?2:1,field);
    assert.deepEqual(s.calls,[0,0],field);
  }
});

test('a redraw that changes the world and asks again shares one read under the current world',async()=>{
  const FS=state(1),s=source();let redraws=0,inner=null,settled=false;
  const done=readOverviews(FS,{herald:s.herald,rings:[0],onChange:()=>{
    if(redraws++===0) {FS.world={...FS.world,ringProvinces:[2]};inner=readOverviews(FS,{herald:s.herald,rings:[0]});}
  }});
  done.then(()=>{settled=true;});
  await flush();await finishAll(s);
  assert.deepEqual(s.calls,[0,0]);assert.equal(settled,false);
  await finishAll(s);
  assert.deepEqual(await inner,[true]);assert.deepEqual(await done,[true]);
  assert.deepEqual(s.calls,[0,0],'one read serves both, not one each');
  assert.equal(redraws,1,'the first caller is not redrawn by the read the second asked for');
  assert.equal(FS.overviewTaken.get(0),2);
});

test('a ring removed while its stored response is redrawn settles false without another read',async()=>{
  const FS=state(2),s=source();
  const done=readOverviews(FS,{herald:s.herald,rings:[1],onChange:()=>{FS.world={...FS.world,ringsOpen:1};}});
  await flush();await finishAll(s);
  assert.deepEqual(await done,[false]);assert.deepEqual(s.calls,[1]);
});

test('a client replaced by the first redraw: later callers are still told of the store, and all settle false',async()=>{
  const FS=state(1),old=source(),current=source(),seen=[];let next=null;
  const a=readOverviews(FS,{herald:old.herald,rings:[0],onChange:()=>{seen.push('a');next=readOverviews(FS,{herald:current.herald,rings:[0]});}});
  const b=readOverviews(FS,{herald:old.herald,rings:[0],onChange:()=>seen.push('b')});
  await flush();
  old.pending.splice(0).forEach(x=>x.finish({ok:true,ring:0,from:'old',provinces:[]}));await flush();
  assert.deepEqual(seen,['a','b'],'the record was stored before the client changed; both callers are told of that store');
  assert.equal(FS.overviews.get(0).from,'old');
  assert.deepEqual(await a,[false]);assert.deepEqual(await b,[false],'as for every job of a replaced client');
  assert.deepEqual(old.calls,[0],'the replaced client is not read again');
  current.pending.splice(0).forEach(x=>x.finish({ok:true,ring:0,from:'current',provinces:[]}));await flush();
  assert.deepEqual(await next,[true]);assert.equal(FS.overviews.get(0).from,'current');
  assert.deepEqual(seen,['a','b']);
});

test('a focus that reads overviews does not re-enter the queue pass',async()=>{
  const FS=state(3),s=source();let asked=0,nested=null;
  const focus=()=>{if(asked++===0) nested=readOverviews(FS,{herald:s.herald,rings:[2]});return {p:2,q:0};};
  const outer=readOverviews(FS,{herald:s.herald,focus});
  assert.equal(asked,1,'one queue pass asks the focus once');
  assert.ok(nested,'the nested request was accepted');
  await flush();assert.deepEqual(s.calls,[2,0,1],'the focus still leads, and the nested request shares ring 2');
  await finishAll(s);
  assert.deepEqual(await outer,[true,true,true]);assert.deepEqual(await nested,[true]);
  assert.equal(s.calls.length,3);assert.ok(s.peak()<=OVERVIEW_IN_FLIGHT);
});
