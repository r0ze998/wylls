// Enacting a live proposal, separate from the one-step entry (once.mjs stays no-charge and non-enacting) (2026-11-17).
//
//   enactRespond   a `respond` proposal → workstream 1's signed `respond` record (record.mjs signRecord), posted to
//                  workstream 1's board (POST /coop/records). The signer is INJECTED ({address, signMessage}: the
//                  resident's identity as its owner supplies it); no key is read, made or chosen here.
//   enactSend      held: not supported (below).
//
// The order for a respond, each side effect after a durable record of it (its own journal file, `live-enact.json` in
// the resident's directory, written through the existing state store: a temporary file and a rename):
//   1  checks, nothing written: a respond proposal from an observation of a known world; the signer is this wallet;
//      a declared nation (0..5, as workstream 1 requires); an explicit clock for the record's `at`; the board given
//   2  the journal line for this request (`respond:<request>`), used ONLY under the binding it was made with (the
//      wallet, the board, the program, Season, network, world and the Season bell's clock; unknown never matches
//      unknown) and only when it is intact (its record by the same respond schema as a new one; from `signed` on, its
//      bytes that record signed by this wallet, with its record id): anything else is held and nothing is done. A line already posted or refused is answered as it is; one whose post is
//      not known is checked on the board's view (my response's record id), never posted again (a result read: allowed
//      also while stopped, stop-A)
//   3  the resident's stop read now (resident-state.mjs): stopped or unknown → held, before any new operation
//   4  intent saved: the record built from the allowed respond fields only ({v, kind, season, at, request, answer,
//      offer, nation}), the offer checked against the candidate and the observed request's need, workstream 1's shape
//      checked; a held candidate, another kind or another world is never signed; a failed save stops here
//   5  signed (await); the stop read again and the board's world checked again (program, Season, network); any change →
//      held, the signed bytes kept in the line, nothing posted
//   6  `sending` saved (the signed bytes and their record id); a failed save stops here, nothing posted
//   7  one POST: 200 {ok: true} → posted; 400 {ok: false, why} → refused (workstream 1's board answers so); anything
//      else → unknown (it may have arrived): kept as `sending`, read back on the view later, never re-posted blindly.
//      What was observed and what was saved are told apart: a failed save is `durable: false, saved: 'unknown'` (the
//      state store may fail after its rename, so the disk may say either state); a later call (this process or after a
//      restart) reads the disk again: `sending` is only read back, never posted again.
// Within one process a second call on the same journal (any request; the directory's real path) is held while the
// first runs. (2026-11-17) Across processes, every call of THIS module takes `live-enact.json.lock` next to the journal
// by exclusive create before it reads the journal, and holds it until it returns; a lock that is there already is
// never taken over, moved or removed (whoever made it, alive or not: no process id is used to decide), so the call is
// held with nothing done. A lock left by a call that stopped (a crash) keeps every later call held until an operator
// who knows no writer is running removes it. A call removes only the lock it made (the same file, the same token).
// What this protects: the enact journal against two calls of this module. NOT state.json (the resident, the owner's
// mode command, the initial writer) or any other file, and not a writer that does not take this lock.
// A respond record only says the resident will send; it moves nothing (workstream 1). Nothing here signs a transaction,
// sends a caravan, spends or authorizes.
//
// Why a send is not enacted: workstream 1's send path (send.mjs sendPlanned) pins the cluster to 'localnet' and takes
// no idempotency key; its at-most-once rests on the board's `sending` record, which the board page posts from inside
// the wallet's signTransaction hook (coop-ui.mjs), and on sendOutcome's correlation by the wallet's signature. A
// resident-side send would need that hook and that correlation carried over as a contract for a non-browser signer and
// for a non-localnet world; neither is adopted, so enactSend answers held and does nothing.
import path from 'node:path';
import { readFileSync, realpathSync, openSync, writeFileSync, fsyncSync, fstatSync, closeSync, lstatSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { signRecord, recordId, shapeProblem, canonical } from '../../../01-national-strategy/coop/record.mjs';
import { createStateStore } from '../../../../permutation-gateway/src/config.mjs';
import { readResidentState } from './resident-state.mjs';
import { existsForHalt } from './factory.mjs';
import { clockId } from '../frame.mjs';

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const short = v => String(v?.code ?? v?.message ?? v ?? '').slice(0, 120);
const held = (why, extra = {}) => ({ ok: false, held: true, why, ...extra });

export const SEND_UNSUPPORTED = Object.freeze([
  "workstream 1's sendPlanned pins the cluster to 'localnet' (io.setPin cluster 'localnet')",
  'sendPlanned / fplay.submit take no idempotency key',
  "the at-most-once record (workstream 1's `sending`) is posted from the wallet's signTransaction hook in the board page; no non-browser contract for it is adopted",
]);

/** A send is not enacted (see the header): held, nothing done. */
export function enactSend() { return held('a caravan send is not supported from the resident', { unsupported: SEND_UNSUPPORTED }); }

/** One GET or POST of JSON on the board, redirects refused. → {status, json} (throws when unreachable). */
function boardIo(url, fetchImpl) {
  const base = String(url).replace(/\/+$/, '');
  return {
    async get(p) { const r = await fetchImpl(`${base}${p}`, { redirect: 'error', headers: { accept: 'application/json' } }); let j = null; try { j = await r.json(); } catch { j = null; } return { status: r.status, json: j }; },
    async post(p, body) { const r = await fetchImpl(`${base}${p}`, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); let j = null; try { j = await r.json(); } catch { j = null; } return { status: r.status, json: j }; },
  };
}

/** The board's world now, equal to the observed one (program, Season, network)? */
async function boardWorldIs(io, season) {
  try {
    const c = await io.get('/coop/config');
    const s = c.json?.season;
    return c.status === 200 && isObj(s) && s.programId === season.programId && String(s.seasonId) === String(season.seasonId) && typeof c.json.cluster === 'string' && c.json.cluster === season.cluster;
  } catch { return false; }
}

/** My response to `request` on the board's view: its record id, null when none, undefined when the view is not read. */
async function myResponseId(io, request, wallet) {
  try {
    const v = await io.get(`/coop/view?viewer=${encodeURIComponent(wallet)}`);
    if (v.status !== 200 || !Array.isArray(v.json?.requests)) return undefined;
    const q = v.json.requests.find(x => x?.id === request);
    if (!q || !isObj(q.responses)) return undefined;
    return q.responses[wallet]?.id ?? null;
  } catch { return undefined; }
}

/** (2026-11-17) Journals being used by this process now, by their real path: a second call on the same journal (any
 * request) is held while the first runs, so no call saves over another's lines. Across processes nothing is excluded. */
const inFlight = new Set();
const JOURNAL = 'live-enact.json';
const LINE_STATES = new Set(['intended', 'signed', 'sending', 'posted', 'refused']);
const RESOURCE = /^[a-z]+$/;
const BINDING_KEYS = ['wallet', 'board', 'programId', 'seasonId', 'cluster', 'world_id', 'clock'];
const RECORD_KEYS = ['v', 'kind', 'season', 'at', 'request', 'answer', 'offer', 'nation'];
const sameKeys = (o, keys) => isObj(o) && Object.keys(o).length === keys.length && keys.every(k => Object.hasOwn(o, k));
const LOCK = `${JOURNAL}.lock`;

/**
 * (2026-11-17) The journal's cross-process lock, made by exclusive create (`wx`: an existing file or link is never
 * opened or followed). → {lock: {path, token, dev, ino}} | {why}. Nothing existing is removed, moved or taken over.
 */
function takeJournalLock(dir) {
  const p = path.join(dir, LOCK);
  let fd;
  try { fd = openSync(p, 'wx', 0o600); } catch (e) {
    if (e?.code === 'EEXIST') return { why: `the enact journal is locked (${LOCK}): another writer is using it, or one that stopped left it; it is not removed or taken over here (an operator who knows no writer is running removes it)` };
    return { why: `the enact journal's lock could not be made (${short(e)})` };
  }
  let st = null, token = null;
  try {
    st = fstatSync(fd);
    token = randomBytes(16).toString('hex');
    writeFileSync(fd, JSON.stringify({ v: 1, by: 'workstream 13 enact.mjs', token, pid: process.pid, pidNote: 'informational only; never used to decide who holds it' }));
    fsyncSync(fd);
  } catch (e) {
    try { closeSync(fd); } catch { /* closed */ }
    const left = st ? releaseJournalLock({ path: p, token: null, dev: st.dev, ino: st.ino }) : 'not released: the lock file could not be identified';
    return { why: `the enact journal's lock could not be written (${short(e)}); the lock ${left}` };
  }
  try { closeSync(fd); } catch { /* the content is synced; the descriptor is not used again */ }
  return { lock: { path: p, token, dev: st.dev, ino: st.ino } };
}

/** Removes the lock only when it is still the file this call made, with this call's token. → 'released' | 'not released: …' */
function releaseJournalLock(lock) {
  try {
    const st = lstatSync(lock.path);
    if (!st.isFile() || st.dev !== lock.dev || st.ino !== lock.ino) return 'not released: it is not the file this call made (left as it is)';
    if (lock.token !== null) {
      let t = null;
      try { t = JSON.parse(readFileSync(lock.path, 'utf8')).token; } catch { t = null; }
      if (t !== lock.token) return 'not released: it does not hold this call\'s token (left as it is)';
    }
    unlinkSync(lock.path);
    return 'released';
  } catch (e) { return `not released (${short(e)}): later calls are held until it is removed`; }
}

const UNSAVED = 'the journal could not be saved, and whether the new state reached the disk is not known (a failure after the rename leaves it there)';

/** The binding a journal line is made under, and must still match before it is used: who, which board, which world, which clock. */
function bindingOf({ wallet, boardBase, observed }) {
  return { wallet, board: boardBase, programId: observed.season.programId, seasonId: observed.season.seasonId, cluster: observed.season.cluster, world_id: observed.world.world_id, clock: clockId(observed.clock) };
}
/** Every key a non-empty string, on both sides, and equal: unknown never matches unknown. */
const sameBinding = (a, b) => sameKeys(a, BINDING_KEYS) && sameKeys(b, BINDING_KEYS) && BINDING_KEYS.every(k => typeof a[k] === 'string' && a[k] !== '' && a[k] === b[k]);

/** (2026-11-17) The one respond schema, for a record built now and for one kept in a line alike. → null | why */
function respondShapeProblem(rec, { request, binding, wallet }) {
  if (!sameKeys(rec, RECORD_KEYS)) return 'not exactly {v, kind, season, at, request, answer, offer, nation}';
  if (rec.v !== 1 || rec.kind !== 'respond' || rec.answer !== 'accept') return 'not a respond accept';
  if (!sameKeys(rec.season, ['programId', 'seasonId']) || rec.season.programId !== binding.programId || rec.season.seasonId !== binding.seasonId) return 'another Season';
  if (rec.request !== request) return 'another request';
  if (!Number.isSafeInteger(rec.at) || rec.at <= 0) return 'no time';
  if (!Number.isInteger(rec.nation) || rec.nation < 0 || rec.nation > 5) return 'no declared nation';
  if (!isObj(rec.offer) || !Object.keys(rec.offer).length || Object.entries(rec.offer).some(([k, v]) => !RESOURCE.test(k) || !Number.isInteger(v) || v < 1)) return 'no offer in whole units';
  const shape = shapeProblem({ ...rec, signer: wallet, sig: 'x' }, {});
  return shape ? `workstream 1 would refuse it (${shape})` : null;
}

/** (2026-11-17) A kept line, checked before anything uses it: its own key and request, its record by the respond schema,
 * and from `signed` on, the signed bytes being exactly that record signed by this wallet with the kept record id. */
function lineProblem(line, { key, request, binding, wallet }) {
  if (line.key !== key || line.request !== request) return 'it is not this request\'s line';
  const p = respondShapeProblem(line.record, { request, binding, wallet });
  if (p) return `its record: ${p}`;
  if (line.state === 'intended') return line.signed === undefined && line.recordId === undefined ? null : 'an intent with a signature';
  const s = line.signed;
  if (!sameKeys(s, [...RECORD_KEYS, 'signer', 'sig']) || s.signer !== wallet || typeof s.sig !== 'string' || !s.sig) return 'its signed record is not this record signed by this wallet';
  try { if (RECORD_KEYS.some(k => canonical(s[k]) !== canonical(line.record[k]))) return 'its signed record differs from its record'; } catch { return 'its signed record is not canonical'; }
  if (shapeProblem(s, {})) return 'its signed record is not a valid respond';
  if (typeof line.recordId !== 'string' || recordId(s) !== line.recordId) return 'its record id is not its signed record\'s';
  return null;
}

/**
 * (2026-11-17) The respond record from its allowed fields only, checked against the candidate and the observed request
 * before anything is signed: an accept for a request this observation shows open and verified, with an offer of whole
 * units of the request's own resources, no more than its need, equal to the candidate's. → {record} | {why}
 */
function respondRecordOf(proposal, observed, nation, at) {
  const cand = proposal?.candidate, rec = proposal?.record;
  if (proposal?.enacted !== false) return { why: 'not an unenacted proposal' };
  if (cand?.kind !== 'respond' || cand.held) return { why: 'not a choosable respond candidate' };
  if (!sameKeys(rec, ['kind', 'request', 'answer', 'offer']) || rec.kind !== 'respond' || rec.answer !== 'accept') return { why: 'the proposal record is not exactly a respond accept {kind, request, answer, offer}' };
  if (typeof cand.request !== 'string' || rec.request !== cand.request) return { why: 'the record is for another request than the candidate' };
  const q = (observed?.requests ?? []).find(x => x?.id === cand.request);
  if (!q || !isObj(q.need)) return { why: 'the request is not in this observation (open, verified, this world)' };
  const offer = rec.offer;
  if (!isObj(offer) || !Object.keys(offer).length || JSON.stringify(offer) !== JSON.stringify(cand.offer ?? null)) return { why: "the offer is not the candidate's" };
  for (const [k, v] of Object.entries(offer)) if (!RESOURCE.test(k) || !Number.isInteger(v) || v < 1 || !(k in q.need) || v > q.need[k]) return { why: `the offer ${k} is not within the request's need` };
  return { record: { v: 1, kind: 'respond', season: { programId: observed.season.programId, seasonId: observed.season.seasonId }, at, request: cand.request, answer: 'accept', offer: { ...offer }, nation } };
}

/**
 * `dir`, `wallet`: the resident; `proposal`, `observed`: from one live step (step.mjs / factory.mjs step()) and its
 * observation (a verified world and its Season-bell clock); `nation` (0..5, declared); `signer` ({address,
 * signMessage}); `boardUrl`, `fetchImpl`; `nowSecs()` the record's time (explicit).
 * → {ok, state, recordId, durable, …}: `state` is what was observed (posted | refused | sending | signed | intended);
 *   `durable: true` when the journal on disk says it; `durable: false, saved: 'unknown'` when the save failed: the disk
 *   may say the earlier state or the new one. A later call (this process or after a restart) reads the disk again and
 *   only reads a `sending` line back, never posts it again.
 * Within one process, one call per resident journal at a time (its real path); across processes, one call of this
 *   module per journal at a time (its lock file); `lock` says whether this call's lock was released.
 */
export async function enactRespond(args) {
  let realDir;
  try { if (typeof args?.dir !== 'string' || !args.dir) throw new Error('no dir'); realDir = realpathSync(args.dir); } catch (e) { return held(`the resident directory is not readable (${short(e)}): nothing done`); }
  const journal = path.join(realDir, JOURNAL);
  if (inFlight.has(journal)) return held("another call in this process is using this resident's enact journal: nothing done");
  inFlight.add(journal);
  let lock = null;
  try {
    // (2026-11-17) the cross-process lock before the journal is read; not taken → held, nothing read or done
    const t = takeJournalLock(realDir);
    if (!t.lock) return held(`nothing done: ${t.why}`, { lock: 'not taken' });
    lock = t.lock;
    const r = await enactRespondOnce({ ...args, dir: realDir }, journal);
    const released = releaseJournalLock(lock);
    lock = null;
    return { ...r, lock: released };
  } finally {
    if (lock) releaseJournalLock(lock);
    inFlight.delete(journal);
  }
}

async function enactRespondOnce({ dir, wallet, proposal, observed, nation, signer, boardUrl, fetchImpl, nowSecs }, journal) {
  // 1  checks; nothing written
  const cand = proposal?.candidate;
  if (cand?.kind !== 'respond' || typeof cand.request !== 'string') return held('not a respond proposal');
  const season = observed?.season, world = observed?.world;
  if (!isObj(season) || typeof season.programId !== 'string' || typeof season.seasonId !== 'string' || typeof season.cluster !== 'string' || !isObj(world) || typeof world.world_id !== 'string' || world.cluster !== season.cluster) return held('no observed world (program, Season, network, world)');
  const clock = clockId(observed.clock);
  if (typeof clock !== 'string' || !clock.startsWith('season-bell:')) return held("no observed world clock (the Season's bell)");
  if (!signer || typeof signer.signMessage !== 'function' || typeof wallet !== 'string' || signer.address !== wallet) return held("no signer for this resident's wallet (its identity is supplied by its owner)");
  if (!Number.isInteger(nation) || nation < 0 || nation > 5) return held("no declared nation (workstream 1's record requires 0..5)");
  if (typeof nowSecs !== 'function') return held('no clock given for the record time');
  if (typeof boardUrl !== 'string' || !/^https?:\/\//.test(boardUrl) || typeof fetchImpl !== 'function') return held('no board given');
  const boardBase = boardUrl.replace(/\/+$/, '');
  const binding = bindingOf({ wallet, boardBase, observed });
  const fs = { readText: p => readFileSync(p, 'utf8'), exists: existsForHalt };
  const stopped = () => readResidentState({ dir, wallet, fs }).stop;
  const io = boardIo(boardBase, fetchImpl);
  const store = createStateStore(journal);
  try { store.load(); } catch (e) { return held(`the enact journal is not readable: ${short(e)}`); }
  store.state ??= { v: 1, lines: {} };
  if (store.state.v !== 1 || !isObj(store.state.lines)) return held('the enact journal is not one this code knows');
  const key = `respond:${cand.request}`;
  const save = () => { try { store.save(); return true; } catch { return false; } };
  const unsaved = (r, why) => ({ ...r, durable: false, saved: 'unknown', why: `${why}: ${UNSAVED}; a later call reads the disk again and never posts again` });
  let line = store.state.lines[key];
  // 2  an existing line: only under the same binding and only when it is intact; posted/refused answered as they are;
  //    sending read back only
  if (line !== undefined) {
    if (!isObj(line) || !LINE_STATES.has(line.state)) return held('the journal line for this request is in a state this code does not know: nothing done');
    if (!sameBinding(line.binding, binding)) return held('the journal line for this request was made for another wallet, board, world or clock (or does not say): nothing done', { state: line.state });
    const bad = lineProblem(line, { key, request: cand.request, binding, wallet });
    if (bad) return held(`the journal line for this request is not intact (${bad}): nothing done`, { state: line.state });
    if (line.state === 'posted' || line.state === 'refused') return { ok: line.state === 'posted', state: line.state, recordId: line.recordId, why: line.why ?? null, durable: true, again: true };
    if (line.state === 'sending') {
      const mine = await myResponseId(io, cand.request, wallet);
      if (mine !== line.recordId) return { ok: false, unknown: true, state: 'sending', recordId: line.recordId, durable: true, why: mine === undefined ? "the board's view could not be read: whether it arrived is not known" : 'not on the board yet: whether it arrived is not known; not posted again' };
      line.state = 'posted'; line.confirmedBy = 'view';
      const r = { ok: true, state: 'posted', recordId: line.recordId, confirmedBy: 'view' };
      return save() ? { ...r, durable: true } : unsaved(r, 'seen on the board');
    }
  }
  // 3  the stop now, before any new operation (reading back an earlier post's result, above, is allowed: stop-A)
  const s0 = stopped();
  if (s0) return held(`the resident is stopped (${s0.why})`, { stop: s0 });
  // 4  intent saved before anything else: the record from its allowed fields, checked by the same schema as a kept line
  if (line === undefined) {
    const at = nowSecs();
    if (!Number.isSafeInteger(at) || at <= 0) return held('the given clock gave no time');
    const r = respondRecordOf(proposal, observed, nation, at);
    if (!r.record) return held(`not signed: ${r.why}`);
    const shape = respondShapeProblem(r.record, { request: cand.request, binding, wallet });
    if (shape) return held(`not signed: ${shape}`);
    line = store.state.lines[key] = { key, state: 'intended', binding, request: cand.request, record: r.record };
    if (!save()) return held(`the intent could not be saved: nothing signed or posted (${UNSAVED})`, { durable: false, saved: 'unknown' });
  }
  // 5  signed (or the bytes kept from before), then the stop and the board's world again
  if (line.state === 'intended') {
    let signed;
    try { signed = await signRecord(signer, line.record); } catch (e) { return held(`not signed: ${short(e)}`); }
    const tmp = { ...line, state: 'signed', signed, recordId: (() => { try { return recordId(signed); } catch { return null; } })() };
    const bad = lineProblem(tmp, { key, request: cand.request, binding, wallet });
    if (bad) return held(`the signed record is not a valid respond (${bad}): not posted`);
    line.signed = tmp.signed; line.recordId = tmp.recordId; line.state = 'signed';
    if (!save()) return held(`the signed record could not be saved: not posted (${UNSAVED})`, { durable: false, saved: 'unknown', recordId: line.recordId });
  }
  const s1 = stopped();
  if (s1) return held(`the resident is stopped (${s1.why}): signed, not posted`, { stop: s1, recordId: line.recordId });
  if (!(await boardWorldIs(io, season))) return held("the board's world is not the observed one now: signed, not posted", { recordId: line.recordId });
  const s2 = stopped();
  if (s2) return held(`the resident is stopped (${s2.why}): signed, not posted`, { stop: s2, recordId: line.recordId });
  // 6  sending saved, then 7 one POST; what was observed and what was saved are told apart
  line.state = 'sending';
  if (!save()) return held(`the send could not be recorded: not posted (${UNSAVED}; if it says sending, it is only read back)`, { durable: false, saved: 'unknown', recordId: line.recordId });
  let r;
  try { r = await io.post('/coop/records', line.signed); } catch (e) { line.lastError = short(e); save(); return { ok: false, unknown: true, state: 'sending', recordId: line.recordId, durable: true, why: `the board was not reached or did not answer (${short(e)}): it may have arrived; read back later, not posted again` }; }
  if (r.status === 200 && r.json?.ok === true) {
    line.state = 'posted';
    const o = { ok: true, state: 'posted', recordId: line.recordId };
    return save() ? { ...o, durable: true } : unsaved(o, 'posted (the board answered ok)');
  }
  if (r.status === 400 && r.json?.ok === false && typeof r.json.why === 'string') {
    line.state = 'refused'; line.why = r.json.why.slice(0, 160);
    const o = { ok: false, state: 'refused', recordId: line.recordId, refusal: line.why };
    return save() ? { ...o, why: line.why, durable: true } : unsaved(o, `refused by the board (${line.why})`);
  }
  line.lastError = `http_${r.status}`; save();
  return { ok: false, unknown: true, state: 'sending', recordId: line.recordId, durable: true, why: `the board answered http ${r.status}: whether it arrived is not known; read back later, not posted again` };
}

// (2026-11-17) The same checks for the read-only consumer of saved results (enact-read.mjs): exported as they are, not
// copied, so a line is judged there exactly as here.
export { JOURNAL, LOCK, LINE_STATES, sameBinding, lineProblem, boardWorldIs };
