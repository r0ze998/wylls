// Shared original-map reader over injected read-only responses. No app boot,
// network, wallet, renderer, WASM, worker or key-operation self-test.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {readOverviews,preferredOverviewRings,OVERVIEW_IN_FLIGHT} from '../../permutation-server/web/frontier/map/overviews.mjs';
import {applySeasonRecord} from '../../permutation-server/web/frontier/map/world.mjs';
const flush=async()=>{for(let i=0;i<12;i++) await Promise.resolve();};
const state=(n=8)=>({world:{ringsOpen:n,ringProvinces:Array.from({length:n},(_,d)=>d?6*d:1)},overviews:new Map(),holdings:[]});
function source() {
  const pending=[],calls=[];let active=0,peak=0;
  const read=method=>ring=>new Promise((resolve,reject)=>{
    active++;peak=Math.max(peak,active);calls.push({method,ring});
    pending.push({ring,method,finish:(answer={ok:true,ring,bell:0,provinces:[]})=>{active--;resolve(answer);},fail:()=>{active--;reject(new Error('offline'));}});
  });
  return {herald:{overview:read('v1'),overview2:read('v2')},pending,calls,peak:()=>peak};
}
async function drain(src,finish=x=>x.finish()) {
  let waves=0;
  await flush();
  while(src.pending.length) {const batch=src.pending.splice(0);waves++;batch.forEach(finish);await flush();}
  return waves;
}

// Execute only isolated controller declarations with read-only injected inputs: the world-aware refresh
// (refreshOverviews and its cache), the pinned-world key (providerWorld), the season answer order
// (askSeason/takeSeason/seasonStale) and the pinned-record check (recordOfPin), each cut from the real source.
// The controller's imports, module initializers, wallet and boot never execute; the pin (`io.pinned()`, which
// fchainio.setPin sets in the page) is a plain injected object.
const W1={gen:0,cluster:'localnet',programId:'Prog1',seasonId:'7',addresses:{season:'Season1'}};
const W2={gen:1,cluster:'localnet',programId:'Prog1',seasonId:'8',addresses:{season:'Season2'}};
/** A season record of world `w` (what recordOfPin accepts for that pin). */
const rec=(w,rings,ringProvinces)=>({rings,ringProvinces,cluster:w.cluster,programId:w.programId,season:w.seasonId,seasonAddress:w.addresses.season});
function cut(source,from,to) {
  const i=source.indexOf(from);
  assert.ok(i>=0,`controller.mjs has ${from}`);assert.equal(source.indexOf(from,i+1),-1,`${from} appears once`);
  const j=source.indexOf(to,i+from.length);assert.ok(j>i,`${to} follows ${from}`);
  return source.slice(i,j);
}
function controllerRefresh(FS,herald,read=readOverviews,{pin=W1}={}) {
  const source=readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs',import.meta.url),'utf8');
  const world=cut(source,'function providerWorld() {','\n');
  const order=cut(source,'let seasonAsked = 0, seasonTaken = 0;','/** The conquest and S1 state is another world').replace(/^export /gm,'');
  const refresh=cut(source,'let overviewRefresh = null, overviewSource = null, overviewWorld = null;','// ------------------------------------------------------------------ the composer');
  // The refresh under test is the world-aware one: it keys its cache and completion by the pinned world, applies only
  // a record of that world, and only when no later-asked season answer was applied.
  assert.match(refresh,/const w = providerWorld\(\);/);
  assert.match(refresh,/recordOfPin\(r\.record\) && !seasonStale\(seq\)/);
  assert.match(refresh,/overviewWorld = request\.world;/);
  assert.match(order,/function recordOfPin\(record\)/);
  const io={pinned:()=>pin};
  const isolated=new Function('FS','herald','applySeasonRecord','readOverviews','conquestEnabled','invalidate','io',
    `${world}\n${order}\n${refresh}\nreturn {refresh:refreshOverviews,setHerald:h=>{herald=h;},ask:askSeason,take:takeSeason};`);
  const h=isolated(FS,herald,applySeasonRecord,read,()=>true,()=>{},io);
  return {...h,setPin:p=>{pin=p;}};
}

test('129-ring boot is bounded to four concurrent reads and 33 deterministic response waves',async()=>{
  const FS=state(129),s=source(),changed=[];
  const done=readOverviews(FS,{herald:s.herald,v2:true,onChange:d=>changed.push(d)});
  await flush();assert.equal(s.calls.length,4);
  const first=s.pending.shift();first.finish();await flush();
  assert.equal(changed.length,1,'progress delivered before whole world completes');
  assert.equal(FS.overviews.size,1);
  await drain(s);const result=await done;
  assert.equal(result.filter(Boolean).length,129);assert.equal(s.calls.length,129);
  assert.equal(s.peak(),OVERVIEW_IN_FLIGHT);assert.ok(s.calls.every(x=>x.method==='v2'));
  const baseline=source();const second=readOverviews(state(129),{herald:baseline.herald});
  const waves=await drain(baseline);await second;assert.equal(waves,33);
  console.log('129 ring reads: 33 four-request response waves, instead of 129 serial waves');
});

test('active village, selected place and camera focus lead the queue; priorities can change during loading',async()=>{
  const FS=state(129),s=source();FS.holdings=[{p:120,q:0}];FS.selected={p:121,q:0};
  assert.deepEqual(preferredOverviewRings(FS,{p:119,q:0}),[120,121,119,0]);
  const done=readOverviews(FS,{herald:s.herald,focus:()=>({p:119,q:0})});
  await flush();assert.deepEqual(s.calls.map(x=>x.ring),[120,121,119,0]);
  FS.activeHolding=1;FS.holdings.push({p:128,q:0});
  s.pending.shift().finish();await flush();assert.equal(s.calls.at(-1).ring,128);
  await drain(s);await done;
});

test('overlapping boot/controller callers coalesce and both receive progress',async()=>{
  const FS=state(),s=source(),a=[],b=[];
  const first=readOverviews(FS,{herald:s.herald,rings:[3,4,5],v2:true,onChange:d=>a.push(d)});
  const second=readOverviews(FS,{herald:s.herald,rings:[4,5],v2:true,onChange:d=>b.push(d)});
  await drain(s);assert.deepEqual(await first,[true,true,true]);assert.deepEqual(await second,[true,true]);
  assert.equal(s.calls.length,3);assert.deepEqual(a.sort(),[3,4,5]);assert.deepEqual(b.sort(),[4,5]);
});

test('old-world responses retry while queued work follows the newer map',async()=>{
  const FS=state(8),s=source(),oldWorld=FS.world;
  const first=readOverviews(FS,{herald:s.herald});await flush();
  const old=s.pending.splice(0);FS.world={...oldWorld,ringProvinces:Array(8).fill(999)};
  const second=readOverviews(FS,{herald:s.herald,rings:[7]});
  old.forEach(x=>x.finish());await flush();assert.equal(FS.overviews.size,0);
  assert.equal(s.calls.length,8,'four stale in-flight reads are replaced within the same bound');
  await drain(s);assert.ok((await first).every(Boolean));assert.deepEqual(await second,[true]);
  assert.equal(FS.overviewTaken.get(7),999);assert.equal(FS.overviews.size,8);
  assert.ok([...FS.overviewTaken.values()].every(n=>n===999));
});

test('world replacement without a new reader also preserves outstanding callers',async()=>{
  const FS=state(8),s=source();const done=readOverviews(FS,{herald:s.herald});await flush();
  FS.world={...FS.world};await drain(s);
  assert.equal(s.calls.length,8);assert.ok((await done).every(Boolean));assert.equal(FS.overviews.size,8);
});

test('unchanged real season polls faster than replies cannot starve a full controller refresh',async()=>{
  const FS=state(129),s=source(),rings=Array.from({length:129},(_,d)=>d);
  const record={rings,ringProvinces:FS.world.ringProvinces};
  applySeasonRecord(FS,record);
  FS.overviewTaken=new Map(rings.map(d=>[d,record.ringProvinces[d]]));
  for(const ring of rings) FS.overviews.set(ring,{ok:true,ring,bell:-1,provinces:[]});
  let completed=false;
  const done=readOverviews(FS,{herald:s.herald,rings,v2:true}).then(result=>{completed=true;return result;});
  await flush();
  const fresh=x=>x.finish({ok:true,ring:x.ring,bell:1,provinces:[]});
  let waves=0;
  while(s.pending.length) {
    assert.equal(completed,false,'the controller still awaits every outstanding ring');
    for(let i=0;i<3;i++) {
      applySeasonRecord(FS,{...record,ringProvinces:[...record.ringProvinces]});
      assert.deepEqual(await readOverviews(FS,{herald:s.herald,v2:true}),[]);
    }
    s.pending.splice(0).forEach(fresh);await flush();waves++;
  }
  assert.ok((await done).every(Boolean));assert.ok([...FS.overviews.values()].every(x=>x.bell===1));
  assert.equal(waves,33);assert.equal(s.calls.length,129);assert.equal(s.peak(),OVERVIEW_IN_FLIGHT);
});

test('changed extent or counts retry while an unchanged poll never stamps a newer count',async()=>{
  for(const field of ['ringsOpened','rMax','rMaxCeiling','rMaxHard','ringProvinces']) {
    const FS=state(1),s=source();Object.assign(FS.world,{ringsOpened:1,rMax:0,rMaxCeiling:2,rMaxHard:128});
    const done=readOverviews(FS,{herald:s.herald});await flush();
    const old=s.pending.shift();
    FS.world={...FS.world,[field]:field==='ringProvinces'?[2]:FS.world[field]+1};
    await readOverviews(FS,{herald:s.herald,rings:[]});
    old.finish();await flush();assert.equal(FS.overviews.size,0,field);
    assert.equal(FS.overviewTaken,undefined,field);
    await drain(s);assert.deepEqual(await done,[true],field);assert.equal(s.calls.length,2,field);
    assert.equal(FS.overviewTaken.get(0),field==='ringProvinces'?2:1,field);
  }
});

test('rings removed by a newer world cancel without stranding their callers',async()=>{
  const FS=state(8),s=source(),done=readOverviews(FS,{herald:s.herald});await flush();
  FS.world={...FS.world,ringsOpen:2};
  const next=readOverviews(FS,{herald:s.herald,rings:[]});
  await drain(s);assert.deepEqual(await done,[true,true,false,false,false,false,false,false]);
  assert.deepEqual(await next,[]);assert.deepEqual([...FS.overviews.keys()].sort(),[0,1]);
});

test('client/format replacement rejects old responses and never downgrades current PSFOV2',async()=>{
  const FS=state(2),s=source(),newer=source();
  const old=readOverviews(FS,{herald:s.herald});await flush();
  const current=readOverviews(FS,{herald:newer.herald,v2:true});
  s.pending.splice(0).forEach(x=>x.finish({ok:true,version:1,provinces:[]}));await flush();
  assert.equal(FS.overviews.size,0);
  newer.pending.splice(0).forEach(x=>x.finish({ok:true,version:2,provinces:[]}));await flush();
  assert.ok((await old).every(x=>!x));assert.ok((await current).every(Boolean));
  assert.ok([...FS.overviews.values()].every(x=>x.version===2));
});

test('a failed response retains previous records and leaves that ring eligible for retry',async()=>{
  const FS=state(2),s=source(),kept={ok:true,old:true};FS.overviews.set(0,kept);
  const first=readOverviews(FS,{herald:s.herald});await flush();
  s.pending.find(x=>x.ring===0).fail();s.pending.find(x=>x.ring===1).finish({ok:false});s.pending.splice(0);
  await flush();assert.deepEqual(await first,[false,false]);assert.equal(FS.overviews.get(0),kept);assert.equal(FS.overviewTaken,undefined);
  const retry=readOverviews(FS,{herald:s.herald});await drain(s);assert.deepEqual(await retry,[true,true]);
});

test('response processing errors settle callers, release capacity and permit retry',async()=>{
  const FS=state(5),s=source(),kept={ok:true,old:true};
  FS.overviews.set(0,kept);
  const set=FS.overviews.set.bind(FS.overviews);
  FS.overviews.set=(ring,answer)=>{if(ring===0) throw new Error('store');return set(ring,answer);};
  const first=readOverviews(FS,{herald:s.herald});await drain(s);
  assert.deepEqual(await first,[false,true,true,true,true]);assert.equal(FS.overviews.get(0),kept);
  assert.equal(FS.overviewTaken.has(0),false);
  FS.overviews.set=set;
  const retry=readOverviews(FS,{herald:s.herald});await drain(s);assert.deepEqual(await retry,[true]);
  assert.equal(s.calls.length,6);assert.equal(s.peak(),OVERVIEW_IN_FLIGHT);
});

test('missing/changed ring defaults, v1 fallback, invalid rings and redraw errors stay bounded',async()=>{
  const FS=state(3),s=source();delete s.herald.overview2;FS.overviewTaken=new Map([[0,1],[1,0]]);
  const first=readOverviews(FS,{herald:s.herald,v2:true,onChange:()=>{throw new Error('redraw');}});
  await drain(s);assert.deepEqual(await first,[true,true]);assert.deepEqual(s.calls.map(x=>x.ring),[1,2]);
  assert.ok(s.calls.every(x=>x.method==='v1'));
  assert.deepEqual(await readOverviews(FS,{herald:s.herald,rings:[-1,3,NaN,1.5]}),[]);
  assert.deepEqual(await readOverviews({overviews:new Map()},{herald:s.herald}),[]);
});

test('actual controller refresh shares the same-bell pending promise and caches only completion',async()=>{
  const FS=state(8),s=source(),record=rec(W1,Array(8).fill(0),FS.world.ringProvinces);
  let finishSeason,seasons=0;
  s.herald.season=()=>{seasons++;return new Promise(resolve=>{finishSeason=resolve;});};
  const h=controllerRefresh(FS,s.herald),first=h.refresh(5),second=h.refresh(5);
  assert.strictEqual(first,second);assert.equal(seasons,1);assert.equal(FS.overviewsBell,undefined);
  finishSeason({ok:true,record});await flush();
  assert.strictEqual(h.refresh(5),first);assert.equal(FS.overviewsBell,undefined);
  await drain(s);await first;assert.equal(FS.overviewsBell,5);assert.equal(s.calls.length,8);
  assert.strictEqual(FS.record,record,'a record of the pinned world is applied');
  await h.refresh(5);assert.equal(seasons,1);
});

test('actual controller refresh clears failed work for retry without marking the bell complete',async()=>{
  const FS=state(1),herald={season:async()=>({ok:true,record:rec(W1,[0],[1])})};
  let reads=0;
  const h=controllerRefresh(FS,herald,async()=>{reads++;if(reads===1) throw new Error('offline');return [reads>2];});
  await assert.rejects(h.refresh(5),/offline/);assert.equal(FS.overviewsBell,undefined);
  await h.refresh(5);assert.equal(FS.overviewsBell,undefined);
  await h.refresh(5);assert.equal(FS.overviewsBell,5);
  await h.refresh(5);assert.equal(reads,3);
});

test('actual controller refresh cannot apply an obsolete client season or reuse its completed bell',async()=>{
  const FS=state(1),old=source(),current=source();let finishOld;
  old.herald.season=()=>new Promise(resolve=>{finishOld=resolve;});
  const record=rec(W1,[0,1],[1,6]);
  current.herald.season=async()=>({ok:true,record});
  const h=controllerRefresh(FS,old.herald),first=h.refresh(5);
  h.setHerald(current.herald);const second=h.refresh(5);
  finishOld({ok:true,record:rec(W1,[0],[99])});
  await first;await drain(current);await second;
  assert.strictEqual(FS.record,record);assert.equal(old.calls.length,0);assert.equal(current.calls.length,2);
  const replacement=source();replacement.herald.season=async()=>({ok:true,record});
  h.setHerald(replacement.herald);const third=h.refresh(5);await drain(replacement);await third;
  assert.equal(replacement.calls.length,2,'same bell on a different client is not cached');
});

test('actual controller refresh joins a later bell instead of applying an older season response',async()=>{
  const FS=state(1),s=source(),record=rec(W1,[0],[1]);let finishOld,calls=0;
  s.herald.season=()=>++calls===1?new Promise(resolve=>{finishOld=resolve;}):Promise.resolve({ok:true,record});
  const h=controllerRefresh(FS,s.herald);let completed=false;
  const first=h.refresh(5).then(()=>{completed=true;}),second=h.refresh(6);
  await flush();finishOld({ok:true,record:rec(W1,[0],[99])});await flush();
  assert.strictEqual(FS.record,record);assert.equal(completed,false);
  await drain(s);await Promise.all([first,second]);assert.equal(FS.overviewsBell,6);assert.equal(s.calls.length,1);
});

test('actual controller refresh applies only a record of the pinned world; completion is per world',async()=>{
  const FS=state(1),s=source();let seasons=0,answer=rec(W2,[0],[42]);
  s.herald.season=async()=>{seasons++;return {ok:true,record:answer};};
  const h=controllerRefresh(FS,s.herald);
  // pinned to W1, the herald answers W2's record: it is not applied (pinning is the season poll's), the rings read are
  // the world already held, and the bell completes for W1 only
  const first=h.refresh(5);await drain(s);await first;
  assert.equal(FS.record,undefined,'another world\'s record is never applied');
  assert.equal(FS.overviewsBell,5);assert.equal(s.calls.length,1);
  await h.refresh(5);assert.equal(seasons,1,'same bell, same herald, same world: cached');
  // the same herald pinned to W2 (fchainio.setPin): the bell completed under W1 is not reused
  h.setPin(W2);answer=rec(W2,[0],[1]);
  const second=h.refresh(5);await drain(s);await second;
  assert.equal(seasons,2,'same bell on another world is read again');assert.strictEqual(FS.record,answer);
  assert.equal(s.calls.length,2);
  // no pin: providerWorld is null and no record is of it
  h.setPin(null);answer=rec(W2,[0],[7]);const third=h.refresh(5);await drain(s);await third;
  assert.equal(seasons,3);assert.equal(FS.record.ringProvinces[0],1,'nothing applied without a pin');
});

test('actual controller refresh drops a season answer when the world changes while it is pending',async()=>{
  const FS=state(1),s=source();let finish;
  s.herald.season=()=>new Promise(resolve=>{finish=resolve;});
  const h=controllerRefresh(FS,s.herald),first=h.refresh(5);
  await flush();h.setPin(W2);finish({ok:true,record:rec(W1,[0],[99])});await first;await flush();
  assert.equal(FS.record,undefined,'an answer read under W1 is not applied under W2');
  assert.equal(FS.overviewsBell,undefined,'and no bell is marked complete');assert.equal(s.calls.length,0,'nor any overview read');
  const second=h.refresh(5);await flush();
  const record=rec(W2,[0],[1]);finish({ok:true,record});await drain(s);await second;
  assert.strictEqual(FS.record,record);assert.equal(FS.overviewsBell,5);assert.equal(s.calls.length,1);
});

test('actual controller refresh never applies a season answer asked before one the season poll applied',async()=>{
  const FS=state(1),s=source();let finish;
  s.herald.season=()=>new Promise(resolve=>{finish=resolve;});
  const h=controllerRefresh(FS,s.herald),first=h.refresh(5);await flush();
  // the season poll (app.mjs loadSeason) asks later, and its answer is applied first
  const polled=rec(W1,[0],[1]);const seq=h.ask();applySeasonRecord(FS,polled);assert.equal(h.take(seq),true);
  finish({ok:true,record:rec(W1,[0],[99])});await drain(s);await first;
  assert.strictEqual(FS.record,polled,'the earlier-asked answer does not undo the later one');
  assert.equal(FS.overviewsBell,5,'the overviews are still read and complete for this world');
  assert.equal(h.take(seq),false,'answer numbers only grow');
});

test('original boot streams summaries, uses PSFOV2 when appropriate, and controller planning still awaits them',()=>{
  const app=readFileSync(new URL('../../permutation-server/web/frontier/app.mjs',import.meta.url),'utf8');
  const controller=readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(app,/await loadOverviews\(herald\)/);
  assert.match(app,/loadOverviews\(herald\)\.catch/);
  assert.match(app,/readOverviews\(FS, \{ herald, rings, v2: conquestEnabled\(FS.season\)/);
  assert.match(controller,/await readOverviews\(FS, \{ herald, rings, v2: conquestEnabled\(FS.season\)/);
});
