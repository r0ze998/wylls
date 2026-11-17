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
//   2  the journal line for this request (`respond:<request>`): a line already posted or refused is answered as it is;
//      one whose post is not known is checked on the board's view (my response's record id), never posted again
//      (reading a result: allowed also while stopped, stop-A)
//   3  the resident's stop read now (resident-state.mjs): stopped or unknown → held, before any new operation
//   4  intent saved (the unsigned record); a failed save stops here
//   5  signed (await); the stop read again and the board's world checked again (program, Season, network); any change →
//      held, the signed bytes kept in the line, nothing posted
//   6  `sending` saved (the signed bytes and their record id); a failed save stops here, nothing posted
//   7  one POST: 200 {ok: true} → posted; 400 {ok: false, why} → refused (workstream 1's board answers so); anything
//      else → unknown (it may have arrived): kept as `sending`, read back on the view later, never re-posted blindly
// A respond record only says the resident will send; it moves nothing (workstream 1). Nothing here signs a transaction,
// sends a caravan, spends or authorizes.
//
// Why a send is not enacted: workstream 1's send path (send.mjs sendPlanned) pins the cluster to 'localnet' and takes
// no idempotency key; its at-most-once rests on the board's `sending` record, which the board page posts from inside
// the wallet's signTransaction hook (coop-ui.mjs), and on sendOutcome's correlation by the wallet's signature. A
// resident-side send would need that hook and that correlation carried over as a contract for a non-browser signer and
// for a non-localnet world; neither is adopted, so enactSend answers held and does nothing.
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { signRecord, recordId, shapeProblem } from '../../../01-national-strategy/coop/record.mjs';
import { createStateStore } from '../../../../permutation-gateway/src/config.mjs';
import { readResidentState } from './resident-state.mjs';
import { existsForHalt } from './factory.mjs';

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

/**
 * `dir`, `wallet`: the resident; `proposal`, `observed`: from one live step (step.mjs / factory.mjs step()) and its
 * observation; `nation` (0..5, declared); `signer` ({address, signMessage}); `boardUrl`, `fetchImpl`; `nowSecs()` the
 * record's time (explicit). → {ok: true, state: 'posted'|'refused', …} | {ok: false, held|unknown, why, …}
 */
export async function enactRespond({ dir, wallet, proposal, observed, nation, signer, boardUrl, fetchImpl, nowSecs }) {
  // 1  checks; nothing written
  const cand = proposal?.candidate;
  if (cand?.kind !== 'respond' || !isObj(proposal?.record) || typeof cand.request !== 'string' || proposal.record.request !== cand.request) return held('not a respond proposal');
  const season = observed?.season;
  if (!isObj(season) || typeof season.programId !== 'string' || typeof season.seasonId !== 'string' || typeof season.cluster !== 'string' || !observed?.world) return held('no observed world (program, Season, network)');
  if (!signer || typeof signer.signMessage !== 'function' || signer.address !== wallet) return held("no signer for this resident's wallet (its identity is supplied by its owner)");
  if (!Number.isInteger(nation) || nation < 0 || nation > 5) return held("no declared nation (workstream 1's record requires 0..5)");
  if (typeof nowSecs !== 'function') return held('no clock given for the record time');
  if (typeof boardUrl !== 'string' || !/^https?:\/\//.test(boardUrl) || typeof fetchImpl !== 'function') return held('no board given');
  const fs = { readText: p => readFileSync(p, 'utf8'), exists: existsForHalt };
  const stopped = () => readResidentState({ dir, wallet, fs }).stop;
  const io = boardIo(boardUrl, fetchImpl);
  const store = createStateStore(path.join(dir, 'live-enact.json'));
  try { store.load(); } catch (e) { return held(`the enact journal is not readable: ${short(e)}`); }
  store.state ??= { v: 1, lines: {} };
  if (store.state.v !== 1 || !isObj(store.state.lines)) return held('the enact journal is not one this code knows');
  const key = `respond:${cand.request}`;
  const save = () => { try { store.save(); return true; } catch { return false; } };
  let line = store.state.lines[key];
  // 3  an existing line: answered as it is, or read back; never posted again blindly
  if (line?.state === 'posted' || line?.state === 'refused') return { ok: line.state === 'posted', state: line.state, recordId: line.recordId ?? null, why: line.why ?? null, again: true };
  if (line?.state === 'sending') {
    const mine = await myResponseId(io, cand.request, wallet);
    if (mine === line.recordId) { line.state = 'posted'; line.confirmedBy = 'view'; save(); return { ok: true, state: 'posted', recordId: line.recordId, confirmedBy: 'view' }; }
    return { ok: false, unknown: true, state: 'sending', recordId: line.recordId, why: mine === undefined ? "the board's view could not be read: whether it arrived is not known" : 'not on the board yet: whether it arrived is not known; not posted again' };
  }
  // 2  the stop now, before any new operation (reading back an earlier post's result, above, is allowed: stop-A)
  const s0 = stopped();
  if (s0) return held(`the resident is stopped (${s0.why})`, { stop: s0 });
  // 4  intent saved before anything else
  if (!line) {
    const at = nowSecs();
    if (!Number.isSafeInteger(at) || at <= 0) return held('the given clock gave no time');
    line = store.state.lines[key] = { key, state: 'intended', request: cand.request, season: { programId: season.programId, seasonId: season.seasonId, cluster: season.cluster }, record: { v: 1, season: { programId: season.programId, seasonId: season.seasonId }, at, ...proposal.record, nation } };
    if (!save()) return held('the intent could not be saved: nothing signed or posted');
  }
  if (line.season.programId !== season.programId || line.season.seasonId !== season.seasonId || line.season.cluster !== season.cluster) return held('the journal line is of another world: not signed or posted');
  // 5  signed (or the bytes kept from before), then the stop and the board's world again
  if (!line.signed) {
    let signed;
    try { signed = await signRecord(signer, line.record); } catch (e) { return held(`not signed: ${short(e)}`); }
    const shape = shapeProblem(signed, {});
    if (shape || signed.signer !== wallet) return held(`the signed record is not a valid respond (${shape ?? 'another signer'})`);
    line.signed = signed; line.recordId = recordId(signed); line.state = 'signed';
    if (!save()) return held('the signed record could not be saved: not posted');
  }
  const s1 = stopped();
  if (s1) return held(`the resident is stopped (${s1.why}): signed, not posted`, { stop: s1, recordId: line.recordId });
  if (!(await boardWorldIs(io, season))) return held("the board's world is not the observed one now: signed, not posted", { recordId: line.recordId });
  const s2 = stopped();
  if (s2) return held(`the resident is stopped (${s2.why}): signed, not posted`, { stop: s2, recordId: line.recordId });
  // 6  sending saved, then 7 one POST
  line.state = 'sending';
  if (!save()) return held('the send could not be recorded: not posted', { recordId: line.recordId });
  let r;
  try { r = await io.post('/coop/records', line.signed); } catch (e) { line.lastError = short(e); save(); return { ok: false, unknown: true, state: 'sending', recordId: line.recordId, why: `the board was not reached or did not answer (${short(e)}): it may have arrived; read back later, not posted again` }; }
  if (r.status === 200 && r.json?.ok === true) { line.state = 'posted'; save(); return { ok: true, state: 'posted', recordId: line.recordId }; }
  if (r.status === 400 && r.json?.ok === false && typeof r.json.why === 'string') { line.state = 'refused'; line.why = r.json.why.slice(0, 160); save(); return { ok: false, state: 'refused', recordId: line.recordId, why: line.why }; }
  line.lastError = `http_${r.status}`; save();
  return { ok: false, unknown: true, state: 'sending', recordId: line.recordId, why: `the board answered http ${r.status}: whether it arrived is not known; read back later, not posted again` };
}
