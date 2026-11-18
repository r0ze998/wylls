// Shared read-only ring overview queue for original map boot and controller
// refreshes. Bounded concurrency, progressive delivery, extent-snapshot checks.
import {ringOf} from '../fgeo.mjs';
import {overviewRings,overviewTaken,ringSeeded} from './world.mjs';

export const OVERVIEW_IN_FLIGHT=4;
const queues=new WeakMap();

// A sparse world (world.mjs: `seeded`) has overviews only for the rings it seeds: an unseeded inner ring is not read.
const validRing=(world,ring)=>!!world&&ringSeeded(world,ring);
const extentFields=['ringsOpen','ringsOpened','rMax','rMaxCeiling','rMaxHard'];
function sameExtent(a,b) {
  if(!a||!b||extentFields.some(key=>(a[key]??null)!==(b[key]??null))) return false;
  if((a.seeded?.join(',')??null)!==(b.seeded?.join(',')??null)) return false;
  // Missing/non-integer counts both mean unknown, as overviewTaken records it.
  for(let d=0;d<a.ringsOpen;d++) {
    const count=w=>Number.isInteger(w.ringProvinces?.[d])?w.ringProvinces[d]:null;
    if(count(a)!==count(b)) return false;
  }
  return true;
}
const snapshot=world=>({...world,ringProvinces:world.ringProvinces?.slice()??null});
// (PR #46 round 3, 2026-11-18: a ring the herald REFUSED — 404, `NoSuchRing` from the herald, `NotFound` from the client —
//  under this extent. Seen live in the natural world: the season record opens rings 0..4 and the page's world model says
//  every one is seeded, but the herald serves no overview of rings 0 and 1; the page asked again on every refresh, 125
//  times each in 15 min, and the reach list waited for them for ever. A refused ring is remembered with the extent it was
//  refused under: it is not asked again while that extent stands — a changed extent (a ring opened, a province count
//  changed) asks again, and so do another herald client and an explicit re-read (`forgetOverviewRefusals`, the map's
//  'province-reread') — and `overviewRefused` tells the reach list that nothing is coming for it.)
const refusals=new WeakMap();
const refusedOf=FS=>{let m=refusals.get(FS);if(!m) {m=new Map();refusals.set(FS,m);}return m;};
const refusedNow=(FS,world,ring)=>{const w=refusals.get(FS)?.get(ring);return !!w&&!!world&&sameExtent(world,w);};
/** Whether the herald refused ring `ring`'s overview (404) under the current world's extent, and no overview of it is held. */
export function overviewRefused(FS,ring) {
  return !FS.overviews?.has?.(ring)&&refusedNow(FS,FS.world,ring);
}
/**
 * The rings whose overview did not come that the map says so of NOW (app.mjs readMarksNow, ⑦; fix-stale-tooltip
 * 2026-11-19): `[{p, q, ring}]`. Seen live in the six-nation real-client video: the two rings the herald refused
 * (404 NoSuchRing, PR #46) stayed in FS.overviewMisses, and the words "the list of villages in this ring is not loaded"
 * stood over the World chart for the whole 85 s. Now a miss is said only
 *  - for this world's misses (`key`, the pinned world the miss was noted in), on an open, seeded ring of FS.world;
 *  - never for a ring the herald refused under this extent (`overviewRefused`): nothing is coming, and asking again is
 *    the province card's explicit re-read, not a map label;
 *  - never once its overview is held (it goes the moment the read comes);
 *  - and only for the ring the person is looking at: a place of `looking` (the selected province, the province at the
 *    view's centre when the map is zoomed in) that lies in it — the words stand on that place. A ring merely missed
 *    while the person looks elsewhere is retried quietly by the season poll (loadOverviews) and not marked.
 * Pure: reads FS, asks nothing.
 */
export function ringMissMarks(FS,{key,looking=[]}={}) {
  const miss=FS.overviewMisses,out=[];
  if(!miss||miss.world!==key||!FS.world||!miss.rings?.has) return out;
  for(const at of looking) {
    if(!Number.isInteger(at?.p)||!Number.isInteger(at?.q)) continue;
    const d=ringOf(at.p,at.q);
    if(out.some(m=>m.ring===d)||!miss.rings.has(d)||FS.overviews?.has?.(d)||!ringSeeded(FS.world,d)||overviewRefused(FS,d)) continue;
    out.push({p:at.p,q:at.q,ring:d});
  }
  return out;
}
/** Forget every refusal: the next read asks those rings again (an explicit re-read by the player). */
export function forgetOverviewRefusals(FS) {refusals.delete(FS);}
// (2026-11-17, ⑦: the pinned world a caller names with `source` — a function giving the world now, with its generation —
//  and a job is for the one it was made under. The herald object can stay the same when the world is pinned again, and
//  two worlds can have the same extent, so neither the client nor the extent sees that change. A job whose world is no
//  longer pinned is not started, its answer is not stored, and it settles false; callers without `source` as before.)
const keyGone=(Q,job)=>job.key!==Q.key||(typeof Q.source==='function'&&Q.source()!==job.key);
function settle(Q,job,stored) {
  if(job.done) return;
  job.done=true;
  if(Q.jobs.get(job.ring)===job) Q.jobs.delete(job.ring);
  job.resolve(stored);
}

// A season poll makes a new world object even when the extent is unchanged.
// Preserve outstanding callers: pending requests follow the new world, and an
// in-flight response for a changed extent must be retried. An identical extent
// is equivalent, so frequent unchanged polls cannot starve slower responses.
function rebase(FS,Q) {
  if(Q.world===FS.world) return;
  Q.world=FS.world;
  for(const job of Q.jobs.values()) {
    if(validRing(Q.world,job.ring)) job.world=Q.world;
    else settle(Q,job,false);
  }
  Q.pending=Q.pending.filter(job=>!job.done);
}

function pump(FS,Q) {
  // focus() is caller code: a focus that reads overviews re-enters here. The
  // outer pass sorts and starts whatever the nested call queued, so the nested
  // pass has nothing to do (unguarded it recursed until the stack overflowed).
  if(Q.pumping) return;
  Q.pumping=true;
  try {start(FS,Q);} finally {Q.pumping=false;}
}

function start(FS,Q) {
  let focusPlace=null;
  try {focusPlace=Q.focus?.();} catch { /* priority is optional, never a read prerequisite */ }
  rebase(FS,Q);
  const preferred=preferredOverviewRings(FS,focusPlace),anchor=preferred[0]??0;
  const rank=d=>{const i=preferred.indexOf(d);return i<0?preferred.length+Math.abs(d-anchor):i;};
  Q.pending.sort((a,b)=>rank(a.ring)-rank(b.ring)||a.ring-b.ring);
  while(Q.active<OVERVIEW_IN_FLIGHT&&Q.pending.length) {
    const job=Q.pending.shift();
    if(job.done) continue;
    if(keyGone(Q,job)) {settle(Q,job,false);continue;}
    Q.active++;
    // Copy counts too: mutating a later record cannot rewrite this snapshot.
    const requestedWorld=snapshot(job.world);
    let stored=false,consumed=false;
    Promise.resolve().then(()=>job.herald[job.method](job.ring)).then(answer=>{
      rebase(FS,Q);
      if(!job.done&&!keyGone(Q,job)&&sameExtent(job.world,requestedWorld)&&answer?.ok===false&&answer.code==='NotFound') refusedOf(FS).set(job.ring,requestedWorld);
      if(job.done||keyGone(Q,job)||!sameExtent(job.world,requestedWorld)||!answer?.ok) return;
      refusals.get(FS)?.delete(job.ring);
      // This response is now spent. Close the job to new callers before any
      // caller code runs: a request made from a redraw callback, or between
      // this step and settlement, wants a read of its own. Joining here would
      // answer it with this older response (and, from a callback, grow the
      // callback set while it is being walked, without bound).
      consumed=true;
      if(Q.jobs.get(job.ring)===job) Q.jobs.delete(job.ring);
      FS.overviews.set(job.ring,answer);
      if(!overviewTaken(FS,job.ring,job.world)) return;
      stored=true;
      for(const changed of [...job.changed]) {try {changed(job.ring,answer);} catch { /* one redraw cannot strand other callers */ }}
    }).catch(()=>{ /* network and processing failures both settle this request */ }).finally(()=>{
      Q.active--;
      rebase(FS,Q);
      // A consumed job left Q.jobs, so rebase and a client change no longer
      // reach it: apply the same rules here. Its callers are owed what every
      // other caller is owed, a read under the current world and client.
      const current=consumed?Q.world:job.world;
      if(job.done) settle(Q,job,stored);
      else if(keyGone(Q,job)) settle(Q,job,false);
      else if(consumed&&(job.herald!==Q.herald||job.method!==Q.method)) settle(Q,job,false);
      else if(sameExtent(current,requestedWorld)) settle(Q,job,stored);
      else if(!consumed) Q.pending.push(job);
      else if(!validRing(Q.world,job.ring)) settle(Q,job,false);
      else {
        // The extent changed while the stored response was being redrawn
        // (any extent field, as for a response still in flight): read again.
        // A request made meanwhile already reads under the current world.
        const newer=Q.jobs.get(job.ring);
        if(newer) newer.promise.then(ok=>settle(Q,job,ok));
        else {job.world=Q.world;Q.jobs.set(job.ring,job);Q.pending.push(job);}
      }
      pump(FS,Q);
    });
  }
}

export function preferredOverviewRings(FS,focus=null) {
  const own=FS.holdings??[], active=own[FS.activeHolding??0];
  const places=[active,FS.selected,...own,focus];
  const rings=places.filter(p=>Number.isInteger(p?.p)&&Number.isInteger(p?.q)).map(p=>ringOf(p.p,p.q));
  return [...new Set([...rings,0])];
}

/** Read requested rings (missing/changed by default); failures retain last known data.
 * v2 selects PSFOV2 for conquest seasons. focus() only affects queue priority.
 * Every caller awaits its own jobs; concurrent callers share identical jobs.
 * Same-source world updates preserve those jobs until their current-world read
 * completes. A removed ring or a changed client/format cancels them with false.
 * A job is shared only until its response is taken: a later request for that
 * ring (also one made from onChange) starts a read of its own.
 * onChange(ring, answer) says that `answer` was stored for the world and client
 * it was read under. Every caller of the job is told of that store, also after
 * an earlier onChange of the same delivery changed the world or the client: the
 * record is in FS.overviews either way, and what the change then requires (a
 * read again, or false for a replaced client) is decided when the job settles.
 */
export function readOverviews(FS,{herald,rings=overviewRings(FS.world,FS.overviewTaken),v2=false,focus=null,onChange=()=>{},source=null}={}) {
  const world=FS.world,method=v2&&typeof herald?.overview2==='function'?'overview2':'overview';
  if(!world||typeof herald?.[method]!=='function') return Promise.resolve([]);
  let Q=queues.get(FS);
  if(!Q) {Q={active:0,pending:[],jobs:new Map(),world:null,herald:null,method:null,focus:null,pumping:false,source:null,key:undefined};queues.set(FS,Q);}
  if(focus) Q.focus=focus;
  const key=typeof source==='function'?source():undefined;
  if(typeof source==='function') Q.source=source;
  if(Q.herald!==herald||Q.method!==method||(key!==undefined&&key!==Q.key)) {
    // In-flight fetches cannot be aborted by this client API. They still count
    // against the bound and are discarded on return; old callers settle now.
    for(const job of Q.jobs.values()) settle(Q,job,false);
    Q.pending=[];Q.herald=herald;Q.method=method;
    refusals.delete(FS);
    if(key!==undefined) Q.key=key;
  }
  rebase(FS,Q);
  const promises=[];
  for(const ring of new Set(rings)) {
    if(!validRing(world,ring)) continue;
    // (a ring the herald refused under this extent is not asked again: its caller is answered false, as for a failure)
    if(refusedNow(FS,world,ring)) {promises.push(Promise.resolve(false));continue;}
    let job=Q.jobs.get(ring);
    if(!job||job.world!==world||job.herald!==herald||job.method!==method||job.key!==Q.key) {
      let resolve;
      const promise=new Promise(r=>{resolve=r;});
      job={ring,world,herald,method,key:Q.key,promise,resolve,changed:new Set(),done:false};
      Q.jobs.set(ring,job);Q.pending.push(job);
    }
    job.changed.add(onChange);promises.push(job.promise);
  }
  pump(FS,Q);
  return Promise.all(promises);
}
