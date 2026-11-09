// Shared read-only ring overview queue for original map boot and controller
// refreshes. Bounded concurrency, progressive delivery, extent-snapshot checks.
import {ringOf} from '../fgeo.mjs';
import {overviewRings,overviewTaken} from './world.mjs';

export const OVERVIEW_IN_FLIGHT=4;
const queues=new WeakMap();

const validRing=(world,ring)=>!!world&&Number.isInteger(ring)&&ring>=0&&ring<world.ringsOpen;
const extentFields=['ringsOpen','ringsOpened','rMax','rMaxCeiling','rMaxHard'];
function sameExtent(a,b) {
  if(!a||!b||extentFields.some(key=>(a[key]??null)!==(b[key]??null))) return false;
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
  rebase(FS,Q);
  let focusPlace=null;
  try {focusPlace=Q.focus?.();} catch { /* priority is optional, never a read prerequisite */ }
  const preferred=preferredOverviewRings(FS,focusPlace),anchor=preferred[0]??0;
  const rank=d=>{const i=preferred.indexOf(d);return i<0?preferred.length+Math.abs(d-anchor):i;};
  Q.pending.sort((a,b)=>rank(a.ring)-rank(b.ring)||a.ring-b.ring);
  while(Q.active<OVERVIEW_IN_FLIGHT&&Q.pending.length) {
    const job=Q.pending.shift();
    if(job.done) continue;
    Q.active++;
    // Copy counts too: mutating a later record cannot rewrite this snapshot.
    const requestedWorld=snapshot(job.world);
    let stored=false;
    Promise.resolve().then(()=>job.herald[job.method](job.ring)).then(answer=>{
      rebase(FS,Q);
      if(job.done||!sameExtent(job.world,requestedWorld)||!answer?.ok) return;
      FS.overviews.set(job.ring,answer);
      if(!overviewTaken(FS,job.ring,job.world)) return;
      stored=true;
      for(const changed of job.changed) {try {changed(job.ring,answer);} catch { /* one redraw cannot strand other callers */ }}
    }).catch(()=>{ /* network and processing failures both settle this request */ }).finally(()=>{
      Q.active--;
      rebase(FS,Q);
      if(!job.done&&!sameExtent(job.world,requestedWorld)) Q.pending.push(job);
      else settle(Q,job,stored);
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
 */
export function readOverviews(FS,{herald,rings=overviewRings(FS.world,FS.overviewTaken),v2=false,focus=null,onChange=()=>{}}={}) {
  const world=FS.world,method=v2&&typeof herald?.overview2==='function'?'overview2':'overview';
  if(!world||typeof herald?.[method]!=='function') return Promise.resolve([]);
  let Q=queues.get(FS);
  if(!Q) {Q={active:0,pending:[],jobs:new Map(),world:null,herald:null,method:null,focus:null};queues.set(FS,Q);}
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
