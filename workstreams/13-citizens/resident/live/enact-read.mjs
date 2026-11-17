// The saved respond results of a resident, read back without a key, a signer or a proposal (2026-11-17): after a stop
// or a restart, a respond that enact.mjs may have posted (`sending`) is checked on workstream 1's board. A result read.
//
// Local first, nothing outside: the lock file's metadata (`lstat` only: whether a writer may be changing the journal;
// its content is not read and nothing about it is decided or changed) and one read of the whole `live-enact.json` (the
// state store writes it by temporary file and rename, so a read sees one whole version). Each line is classified from
// the journal alone: its state, its own record and signature by enact.mjs's checks against the binding it records, and
// that binding's wallet and board being the ones given here.
// Outside, ONLY when some line is a `sending` that passed those checks (a post that may have arrived, the one thing
// whose result the board alone can tell): the herald's /h/season (the world and the Season bell's clock), the board's
// /coop/config (its program, Season and network) and one /coop/view for this wallet. No other line causes a read: an
// empty journal, intents only, signed-not-posted, posted or refused as journaled, or lines that are not intact or not
// for this wallet and board read nothing outside.
// What it never does: take or remove a lock; write the journal or state.json; observe for candidates; propose; sign;
// post; re-send. Results keep the journal's word and the board's present view apart:
//   journal  {state, recordId}: what the journal says, as it is
//   board    {read: false, why} | {read: true, seen: true} | {read: true, seen: false, why}: what the view shows now
//            (never "not sent", "failed" or "absent": not found on a view is not known)
//   result   held | intent | signed-not-posted | posted | refused (the journal's) | confirmed | unknown (a sending)
// A `signed` line was never posted by enactRespond (it saves `sending` before its one POST): it stays signed-not-posted,
// never raised to a submission, and is not looked up. A `sending` line whose record id the view shows for this request
// and wallet, with the request on the view exactly once, is `confirmed`; the journal is NOT updated here (enactRespond
// does that on its next call, under its lock). A journal that is not there says only that it is not there now: whether
// anything was enacted before (a removed or moved journal) is not known, and it is no evidence that nothing was.
// A stopped resident is not asked: reading results is allowed while stopped (stop-A), and nothing new is done here.
import path from 'node:path';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { JOURNAL, LOCK, LINE_STATES, sameBinding, lineProblem, boardWorldIs } from './enact.mjs';
import { seasonClock, clockId } from '../frame.mjs';

export const READ_KIND = 'ws13-enact-read/1';
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const short = v => String(v?.code ?? v?.message ?? v ?? '').slice(0, 120);
const httpBase = u => { try { const x = new URL(u); return ['http:', 'https:'].includes(x.protocol) && !x.username && !x.password ? String(u).replace(/\/+$/, '') : null; } catch { return null; } };

/** GET only, JSON, redirects refused. */
function getOnly(base, fetchImpl) {
  return { async get(p) { const r = await fetchImpl(`${base}${p}`, { redirect: 'error', headers: { accept: 'application/json' } }); let j = null; try { j = await r.json(); } catch { j = null; } return { status: r.status, json: j }; } };
}

/** The world and clock now, from one /h/season read. → {season, world_id, clock} | {why} */
async function worldNow(herald, worldFromSeason) {
  let s;
  try { s = await herald.get('/h/season'); } catch (e) { return { why: `herald /h/season: ${short(e)}` }; }
  if (!(s?.status >= 200 && s.status < 300 && isObj(s.json))) return { why: `herald /h/season: http_${s?.status ?? '?'}` };
  try {
    const w = worldFromSeason(s.json);
    if (!w?.world || typeof w.world.world_id !== 'string' || typeof s.json.programId !== 'string' || typeof s.json.cluster !== 'string' || w.world.cluster !== s.json.cluster) return { why: 'not a continuous world, or its network is not said' };
    const clock = clockId(seasonClock({ genesisTs: w.clock.genesisTs, bellSecs: w.clock.bellSecs, source: w.clock.source }));
    return { season: { programId: s.json.programId, seasonId: String(s.json.season), cluster: s.json.cluster }, world_id: w.world.world_id, clock };
  } catch (e) { return { why: `herald /h/season malformed: ${short(e)}` }; }
}

/** One /coop/view for this wallet. → Map(request id → [its entries]) | {why} */
async function viewNow(board, wallet) {
  try {
    const v = await board.get(`/coop/view?viewer=${encodeURIComponent(wallet)}`);
    if (v.status !== 200 || !Array.isArray(v.json?.requests)) return { why: `board /coop/view: http_${v.status}` };
    const by = new Map();
    for (const q of v.json.requests) if (typeof q?.id === 'string') by.set(q.id, [...(by.get(q.id) ?? []), q]);
    return { by };
  } catch (e) { return { why: `board /coop/view: ${short(e)}` }; }
}

/** What the board's view says of my record for one request: 'seen' | {unknown: why}. */
function onView(view, request, wallet, recordId) {
  if (view.why) return { unknown: `the board's view was not read (${view.why})` };
  const qs = view.by.get(request) ?? [];
  if (qs.length !== 1) return { unknown: qs.length ? 'the request is on the view more than once: not identified' : 'the request is not on the board\'s view now (closed, expired or another view): not known' };
  const q = qs[0];
  if (!isObj(q.responses)) return { unknown: "the view's responses for this request are not read" };
  const mine = q.responses[wallet];
  if (mine === undefined || mine === null) return { unknown: 'no response of this wallet on the view now: whether it arrived is not known' };
  if (!isObj(mine) || typeof mine.id !== 'string') return { unknown: "this wallet's response on the view has no record id" };
  if (mine.id !== recordId) return { unknown: 'another record of this wallet is on the view for this request: this one is not identified' };
  return 'seen';
}

/**
 * `dir` the resident's directory; `wallet` its address; `boardUrl` and `heraldUrl` (explicit, http(s) without
 * credentials); `fetchImpl`; `worldFromSeason` (workstream 12's, injected as factory.mjs does). Nothing is chosen.
 * → {kind, ok, journal, lock, read, world, lines: [{key, request, journal, board, result, why?}], wrote, why?}
 */
export async function readRespondResults({ dir, wallet, boardUrl, heraldUrl, fetchImpl, worldFromSeason } = {}) {
  const out = (o) => ({ kind: READ_KIND, wrote: 'nothing: the journal, its lock and state.json are not written; a confirmed line stays as the journal says until enactRespond confirms it', ...o });
  if (typeof wallet !== 'string' || !wallet) return out({ ok: false, why: 'no wallet given' });
  const board = httpBase(boardUrl), herald = httpBase(heraldUrl);
  if (!board || !herald || typeof fetchImpl !== 'function') return out({ ok: false, why: 'no board, herald or fetch given' });
  if (typeof worldFromSeason !== 'function') return out({ ok: false, why: "no world reader given (workstream 12's worldFromSeason)" });
  let real;
  try { if (typeof dir !== 'string' || !dir) throw new Error('no dir'); real = realpathSync(dir); } catch (e) { return out({ ok: false, why: `the resident directory is not readable (${short(e)})` }); }
  // local: the lock's metadata only
  let lock;
  try { lstatSync(path.join(real, LOCK)); lock = { present: true, note: 'a writer may be changing the journal now, or one that stopped left the lock: this is the version read' }; }
  catch (e) { lock = e?.code === 'ENOENT' ? { present: false } : { present: null, note: `the lock could not be looked at (${short(e)})` }; }
  // local: the journal, one read
  let j;
  try { j = JSON.parse(readFileSync(path.join(real, JOURNAL), 'utf8')); }
  catch (e) {
    if (e?.code === 'ENOENT') return out({ ok: true, journal: 'not there now', lock, read: 'nothing outside', lines: [], why: 'no enact journal in this directory now: whether anything was enacted before (a removed or moved journal) is not known; this is no evidence that nothing was enacted or sent' });
    return out({ ok: false, journal: 'not readable', lock, read: 'nothing outside', lines: [], why: `the enact journal is not readable (${short(e)})` });
  }
  if (!isObj(j) || j.v !== 1 || !isObj(j.lines)) return out({ ok: false, journal: 'not one this code knows', lock, read: 'nothing outside', lines: [], why: 'the enact journal is not one this code knows' });
  // local: each line from the journal alone
  const lines = [], toCheck = [];
  for (const [key, line] of Object.entries(j.lines)) {
    const request = isObj(line) && typeof line.request === 'string' ? line.request : null;
    const said = { state: isObj(line) ? line.state ?? null : null, recordId: isObj(line) && typeof line.recordId === 'string' ? line.recordId : null };
    const notRead = why => ({ read: false, why });
    const entry = { key, request, journal: said };
    if (!isObj(line) || !LINE_STATES.has(line.state) || request === null) { lines.push({ ...entry, board: notRead('the line is not compared'), result: 'held', why: 'a line in a state this code does not know' }); continue; }
    const b = line.binding;
    if (!sameBinding(b, b)) { lines.push({ ...entry, board: notRead('the line is not compared'), result: 'held', why: 'the line does not say the wallet, board, world and clock it was made under' }); continue; }
    if (b.wallet !== wallet || b.board !== board) { lines.push({ ...entry, board: notRead('the line is not compared'), result: 'held', why: 'made for another wallet or board than the ones given' }); continue; }
    const bad = lineProblem(line, { key, request, binding: b, wallet });
    if (bad) { lines.push({ ...entry, board: notRead('the line is not compared'), result: 'held', why: `not intact (${bad})` }); continue; }
    if (line.state === 'intended') { lines.push({ ...entry, board: notRead('nothing was signed for it'), result: 'intent', why: 'nothing was signed for it; it is not taken further here' }); continue; }
    if (line.state === 'signed') { lines.push({ ...entry, board: notRead('signed, and never posted by enactRespond (it saves sending before its one POST)'), result: 'signed-not-posted', why: 'signed, not posted: not a submission, not looked up' }); continue; }
    if (line.state === 'posted' || line.state === 'refused') { lines.push({ ...entry, board: notRead(`the journal already says ${line.state}`), result: line.state, ...(line.state === 'refused' && typeof line.why === 'string' ? { why: line.why } : {}) }); continue; }
    const at = lines.push({ ...entry, board: null, result: null }) - 1;   // sending: the board decides, below
    toCheck.push({ at, key, request, line });
  }
  if (!toCheck.length) return out({ ok: true, journal: 'read', lock, read: 'nothing outside: no line whose result only the board can tell', world: null, lines });
  // outside, only for the sending lines: the world and clock now, the board in it, then one view
  const w = await worldNow(getOnly(herald, fetchImpl), worldFromSeason);
  const io = getOnly(board, fetchImpl);
  const boardOk = w.why ? false : await boardWorldIs(io, w.season);
  const binding = w.why ? null : { wallet, board, programId: w.season.programId, seasonId: w.season.seasonId, cluster: w.season.cluster, world_id: w.world_id, clock: w.clock };
  const notCompared = w.why ? `the world or clock now is not known (${w.why})` : !boardOk ? 'the board is not in this world now (program, Season, network), or its config was not read' : null;
  const fits = notCompared ? [] : toCheck.filter(c => sameBinding(c.line.binding, binding));
  const view = notCompared || !fits.length ? null : await viewNow(io, wallet);
  for (const c of toCheck) {
    const l = lines[c.at];
    if (notCompared) { Object.assign(l, { board: { read: false, why: notCompared }, result: 'unknown', why: `${notCompared}: not compared; whether it arrived is not known` }); continue; }
    if (!fits.includes(c)) { Object.assign(l, { board: { read: false, why: 'the line is not compared' }, result: 'held', why: 'made under another world or clock than the one now' }); continue; }
    const seen = onView(view, c.request, wallet, c.line.recordId);
    Object.assign(l, seen === 'seen'
      ? { board: { read: true, seen: true }, result: 'confirmed', why: "the board's view shows this record id for this request and wallet; the journal is not updated here" }
      : { board: { read: !view.why, seen: false, why: seen.unknown }, result: 'unknown', why: seen.unknown });
  }
  return out({ ok: true, journal: 'read', lock, read: view ? 'herald /h/season, board /coop/config and /coop/view' : 'herald /h/season and board /coop/config', world: binding ? { programId: binding.programId, seasonId: binding.seasonId, cluster: binding.cluster, world_id: binding.world_id, clock: binding.clock } : null, lines });
}
