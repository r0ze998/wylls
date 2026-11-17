// ⑦ the season record, the world's extent, the ring lists and the ring overviews are written only for the pinned world
// (with its generation) they were read for; a world without conquest shows no other world's conquest or S1 state
// (Lane C, 2026-11-17). WRITTEN, NOT RUN. KEY-FREE and import-free beyond node:test / node:assert / node:fs:
// controller.mjs, app.mjs and map/overviews.mjs are read as TEXT, not imported (controller.mjs and app.mjs load
// fi18n.mjs and lang.mjs, the subjects of refused tests). A text check: it pins the guards and their places; it runs no
// page, herald or world. (map/overviews.mjs imports none of those; a behaviour case for its queue is left to the
// coordinator's decision.)
//   O1 refreshOverviews: the join, the cache and the completion carry the world; every check after an await is same()
//      (herald and world); the season answer is applied only under same(); the queue is told the world (source)
//   O2 the shared queue: a job carries the key of the world it was made under; a changed key cancels the queue as a
//      changed client does; a job whose world is gone is not started, its answer is not stored, it settles false
//   O3 unchanged in one world: four in flight, the order, the extent rules, a partial read left retryable; callers without
//      source as before
//   O4 app: loadSeason forgets another world's reads right after the pin, before the record is applied; the boot/poll
//      reader names the same world as the controller
//   O5 adoptPinnedWorld: the first pin and the same world forget nothing; another world empties the overviews in place,
//      the taken counts, the ring lists, the completion, and the conquest and S1 state
//   O6 refreshConquest drops another world's conquest and S1 state before asking whether conquest is on: the consumers
//      that read them ungated (feed, sheet, report, inspect, S1 walk) are named here
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../../permutation-server/web/frontier/${f}`, import.meta.url), 'utf8');
const ctl = read('controller.mjs'), app = read('app.mjs'), ov = read('map/overviews.mjs');
const fnOf = (src, head) => { const at = src.indexOf(head); assert.ok(at >= 0, head); return src.slice(at, src.indexOf('\n}\n', at) + 2); };
const order = (body, ...parts) => { let at = -1; for (const p of parts) { const i = body.indexOf(p, at + 1); assert.ok(i > at, `in order: ${p}`); at = i; } };
const refresh = fnOf(ctl, 'function refreshOverviews(b) {');

test('O1 a refresh of the overviews is one herald and one world', () => {
  assert.ok(ctl.includes('let overviewRefresh = null, overviewSource = null, overviewWorld = null;'));
  order(refresh, 'const w = providerWorld();',
    'if (overviewRefresh?.bell === b && overviewRefresh.herald === herald && overviewRefresh.world === w) return overviewRefresh.promise;',
    'if (FS.overviewsBell === b && overviewSource === herald && overviewWorld === w) return Promise.resolve();',
    'const request = { bell: b, herald, world: w, promise: null };',
    'const same = () => herald === request.herald && providerWorld() === request.world;',
    'const r = await request.herald.season();', 'if (!same()) return;', 'applySeasonRecord(FS, r.record,', 'if (r.season) FS.season = r.season;',
    '} catch { /* keep the last record */ }', 'if (!same()) return;',
    'const results = await readOverviews(FS, { herald, rings, v2: conquestEnabled(FS.season), source: providerWorld,', 'if (!same()) return;',
    'if (results.every(Boolean)) {', 'FS.overviewsBell = b;', 'overviewSource = herald;', 'overviewWorld = request.world;',
    'if (overviewRefresh === request) overviewRefresh = null;');
  assert.doesNotMatch(refresh, /if \(herald !== request\.herald\) return;/, 'no herald-only check is left');
});

test('O2 the queue knows the world each job was made under', () => {
  assert.ok(ov.includes("const keyGone=(Q,job)=>job.key!==Q.key||(typeof Q.source==='function'&&Q.source()!==job.key);"));
  const rd = fnOf(ov, 'export function readOverviews(');
  order(rd, 'onChange=()=>{},source=null}={}) {', 'source:null,key:undefined};', "const key=typeof source==='function'?source():undefined;",
    "if(typeof source==='function') Q.source=source;", 'if(Q.herald!==herald||Q.method!==method||(key!==undefined&&key!==Q.key)) {',
    'for(const job of Q.jobs.values()) settle(Q,job,false);', 'if(key!==undefined) Q.key=key;',
    '||job.method!==method||job.key!==Q.key) {', 'job={ring,world,herald,method,key:Q.key,promise,');
  const st = fnOf(ov, 'function start(FS,Q) {');
  order(st, 'if(job.done) continue;', 'if(keyGone(Q,job)) {settle(Q,job,false);continue;}', 'Q.active++;',
    'if(job.done||keyGone(Q,job)||!sameExtent(job.world,requestedWorld)||!answer?.ok) return;', 'FS.overviews.set(job.ring,answer);',
    'if(job.done) settle(Q,job,stored);', 'else if(keyGone(Q,job)) settle(Q,job,false);', 'else if(consumed&&(job.herald!==Q.herald||job.method!==Q.method)) settle(Q,job,false);');
});

test('O3 one world: as before', () => {
  assert.ok(ov.includes('export const OVERVIEW_IN_FLIGHT=4;'));
  assert.ok(ov.includes('while(Q.active<OVERVIEW_IN_FLIGHT&&Q.pending.length) {'));
  assert.ok(ov.includes("Q.pending.sort((a,b)=>rank(a.ring)-rank(b.ring)||a.ring-b.ring);"));
  assert.ok(ov.includes('else if(sameExtent(current,requestedWorld)) settle(Q,job,stored);'));
  assert.ok(ov.includes('else if(!consumed) Q.pending.push(job);'));
  assert.ok(refresh.includes('// A partial/failed read remains retryable;'));
});

test('O4 app: forget, then apply; the reader names the world', () => {
  assert.ok(app.includes("import { useHerald, refresh as refreshPlay, onReread, adoptPinnedWorld } from './controller.mjs';"));
  const ls = fnOf(app, 'async function loadSeason(herald) {');
  order(ls, 'FS.pin = setPin({', 'herald.pin(record.season, FS.pin.addresses);', 'adoptPinnedWorld();', 'FS.season = season;', 'applySeasonRecord(FS, record,', 'if (FS.overviewsBooted) loadOverviews(herald)');
  assert.ok(app.includes('return readOverviews(FS, { herald, rings, v2: conquestEnabled(FS.season), source: momentWorld,'));
  assert.ok(app.includes("const momentWorld = () => (FS.pin?.programId && FS.pin?.addresses?.season ? `${FS.pin.gen ?? 0}|${FS.pin.cluster ?? ''}|${FS.pin.programId}|${FS.pin.addresses.season}` : null);"));
  assert.ok(ctl.includes("function providerWorld() { const p = io.pinned(); return p?.programId && p?.addresses?.season ? `${p.gen ?? 0}|${p.cluster ?? ''}|${p.programId}|${p.addresses.season}` : null; }"), 'the same string');
});

test('O5 adoptPinnedWorld forgets only another world', () => {
  const ad = fnOf(ctl, 'export function adoptPinnedWorld() {');
  order(ad, 'const world = providerWorld();', 'if (readsWorld === undefined || readsWorld === world) { readsWorld = world; return false; }',
    'readsWorld = world;', 'FS.overviews?.clear?.();', 'FS.overviewTaken?.clear?.();', 'FS.worldRings?.clear?.();', 'FS.overviewsBell = undefined;',
    'overviewSource = null; overviewWorld = null;', 'dropOtherWorldConquest(world);', 'return true;');
  assert.doesNotMatch(ad, /FS\.overviews = /, 'the map holds the Map: emptied in place, never replaced');
  const drop = fnOf(ctl, 'function dropOtherWorldConquest(world) {');
  assert.ok(drop.includes('if (FS.conquest && (FS.conquest.world ?? null) !== world) FS.conquest = undefined;'));
  assert.ok(drop.includes('if (FS.s1 && (FS.s1.world ?? null) !== world) FS.s1 = undefined;'));
});

test('O6 a world without conquest shows none of another world', () => {
  const cq = fnOf(ctl, 'export async function refreshConquest() {');
  order(cq, 'dropOtherWorldConquest(providerWorld());', 'if (!conquestEnabled(FS.season) || !herald?.control) return;', 'const request=++conquestRefresh;');
  // the consumers that read the state without asking whether conquest is on (why the drop is before that question)
  const fx = read('fx/sheetfx.mjs'), feed = read('hud/feed.mjs'), insp = read('hud/inspect.mjs'), walk = read('s1walk.mjs');
  assert.ok(fx.includes('const keeps = FS.conquest?.keeps, k = keeps instanceof Map'));
  assert.ok(feed.includes('const keeps = Array.isArray(FS.conquest?.events) ?'));
  assert.ok(insp.includes('if (FS.s1) {'));
  assert.ok(walk.includes('return { structures: fs.s1?.structures?.structures ?? [], stances: fs.s1?.nations?.stances ?? null,'));
  // no payment, prize or join is touched by this bundle
  for (const body of [refresh, fnOf(ctl, 'export function adoptPinnedWorld() {')]) assert.doesNotMatch(body, /prize|faucet|payAndJoin|paidJoin|claim/i);
});
