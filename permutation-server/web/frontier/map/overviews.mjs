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
    Q.active++;
    // Copy counts too: mutating a later record cannot rewrite this snapshot.
    const requestedWorld=snapshot(job.world);
    let stored=false,consumed=false;
    Promise.resolve().then(()=>job.herald[job.method](job.ring)).then(answer=>{
      rebase(FS,Q);
      if(job.done||!sameExtent(job.world,requestedWorld)||!answer?.ok) return;
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
export function readOverviews(FS,{herald,rings=overviewRings(FS.world,FS.overviewTaken),v2=false,focus=null,onChange=()=>{}}={}) {
  const world=FS.world,method=v2&&typeof herald?.overview2==='function'?'overview2':'overview';
  if(!world||typeof herald?.[method]!=='function') return Promise.resolve([]);
  let Q=queues.get(FS);
  if(!Q) {Q={active:0,pending:[],jobs:new Map(),world:null,herald:null,method:null,focus:null,pumping:false};queues.set(FS,Q);}
  if(focus) Q.focus=focus;
  if(Q.herald!==herald||Q.method!==method) {
    // In-flight fetches cannot be aborted by this client API. They still count
    // against the bound and are discarded on return; old callers settle now.
    for(const job of Q.jobs.values()) settle(Q,job,false);
    Q.pending=[];Q.herald=herald;Q.method=method;
  }
  rebase(FS,Q);
  const promises=[];
  for(const ring of new Set(rings)) {
    if(!validRing(world,ring)) continue;
    let job=Q.jobs.get(ring);
    if(!job||job.world!==world||job.herald!==herald||job.method!==method) {
      let resolve;
      const promise=new Promise(r=>{resolve=r;});
      job={ring,world,herald,method,promise,resolve,changed:new Set(),done:false};
      Q.jobs.set(ring,job);Q.pending.push(job);
    }
    job.changed.add(onChange);promises.push(job.promise);
  }
  pump(FS,Q);
  return Promise.all(promises);
}
