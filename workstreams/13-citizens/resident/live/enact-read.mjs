// The saved respond results of a resident, read back without a key, a signer or a proposal (2026-11-17): after a stop
// or a restart, what enact.mjs posted or may have posted is checked on workstream 1's board. A result read only.
//
// What it reads, nothing else:
//   - the resident's `live-enact.json` (one read of the whole file; the state store writes it by temporary file and
//     rename, so a read sees one whole version) and the lock file's metadata (`lstat` only: whether a writer may be
//     changing the journal now; its content is not read, and nothing about the lock is decided or changed);
//   - the herald's /h/season (the world and the Season bell's clock, workstream 12's worldFromSeason and frame.mjs
//     seasonClock), the board's /coop/config (its program, Season and network) and one /coop/view for this wallet.
// What it never does: take or remove a lock; write the journal or state.json; observe for candidates; make a
// proposal; sign; post; re-send. A line is answered from the journal and the board as they are now:
//   posted / refused       the journal says so (and for posted, whether the board's view shows the same record id)
//   confirmed              a `sending` (or `signed`) line whose record id the board's view shows, for this request and
//                          this wallet, exactly once: posted. The journal is NOT updated here (enactRespond does that
//                          on its next call, under its lock).
//   unknown                anything not clearly matched: not on the view, another record of this wallet there, the
//                          request not or more than once on the view, the view or the world not read. Never "not sent".
//   held                   a line made under another wallet, board, world or clock (or not saying), not intact, or
//                          in a state this code does not know: not compared at all.
//   intent                 an `intended` line: nothing was signed for it; it is not taken further here.
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
 * → {kind, ok, world, lock, wrote: 'nothing', lines: [{request, journal, result, recordId, why?, board?}], why?}
 */
export async function readRespondResults({ dir, wallet, boardUrl, heraldUrl, fetchImpl, worldFromSeason } = {}) {
  const out = (o) => ({ kind: READ_KIND, wrote: 'nothing: the journal, its lock and state.json are not written; a confirmed line stays as the journal says until enactRespond confirms it', ...o });
  if (typeof wallet !== 'string' || !wallet) return out({ ok: false, why: 'no wallet given' });
  const board = httpBase(boardUrl), herald = httpBase(heraldUrl);
  if (!board || !herald || typeof fetchImpl !== 'function') return out({ ok: false, why: 'no board, herald or fetch given' });
  if (typeof worldFromSeason !== 'function') return out({ ok: false, why: "no world reader given (workstream 12's worldFromSeason)" });
  let real;
  try { if (typeof dir !== 'string' || !dir) throw new Error('no dir'); real = realpathSync(dir); } catch (e) { return out({ ok: false, why: `the resident directory is not readable (${short(e)})` }); }
  // the lock's metadata only: a writer may be changing the journal now (nothing is decided or changed about it)
  let lock;
  try { lstatSync(path.join(real, LOCK)); lock = { present: true, note: 'a writer may be changing the journal now, or one that stopped left the lock: this is the version read' }; }
  catch (e) { lock = e?.code === 'ENOENT' ? { present: false } : { present: null, note: `the lock could not be looked at (${short(e)})` }; }
  // the journal, one read
  let j;
  try { j = JSON.parse(readFileSync(path.join(real, JOURNAL), 'utf8')); }
  catch (e) { return out({ ok: e?.code === 'ENOENT', lock, lines: [], why: e?.code === 'ENOENT' ? 'no enact journal: nothing was enacted from this directory' : `the enact journal is not readable (${short(e)})` }); }
  if (!isObj(j) || j.v !== 1 || !isObj(j.lines)) return out({ ok: false, lock, lines: [], why: 'the enact journal is not one this code knows' });
  // the world and clock now, and the board in it; without them no line is compared (unknown is never matched)
  const w = await worldNow(getOnly(herald, fetchImpl), worldFromSeason);
  const io = getOnly(board, fetchImpl);
  const boardOk = w.why ? false : await boardWorldIs(io, w.season);
  const binding = w.why ? null : { wallet, board, programId: w.season.programId, seasonId: w.season.seasonId, cluster: w.season.cluster, world_id: w.world_id, clock: w.clock };
  const notCompared = w.why ? `the world or clock now is not known (${w.why})` : !boardOk ? "the board is not in this world now (program, Season, network), or its config was not read" : null;
  const view = notCompared ? { why: notCompared } : await viewNow(io, wallet);
  const lines = [];
  for (const [key, line] of Object.entries(j.lines)) {
    const request = isObj(line) && typeof line.request === 'string' ? line.request : null;
    const base = { key, request, journal: isObj(line) ? line.state ?? null : null, recordId: isObj(line) && typeof line.recordId === 'string' ? line.recordId : null };
    if (!isObj(line) || !LINE_STATES.has(line.state) || request === null) { lines.push({ ...base, result: 'held', why: 'a line in a state this code does not know: not compared' }); continue; }
    if (notCompared) { lines.push({ ...base, result: 'unknown', why: `${notCompared}: not compared` }); continue; }
    if (!sameBinding(line.binding, binding)) { lines.push({ ...base, result: 'held', why: 'made for another wallet, board, world or clock (or does not say): not compared' }); continue; }
    const bad = lineProblem(line, { key, request, binding, wallet });
    if (bad) { lines.push({ ...base, result: 'held', why: `not intact (${bad}): not compared` }); continue; }
    if (line.state === 'intended') { lines.push({ ...base, result: 'intent', why: 'nothing was signed for it; it is not taken further here' }); continue; }
    const seen = onView(view, request, wallet, line.recordId);
    if (line.state === 'posted') { lines.push({ ...base, result: 'posted', board: seen === 'seen' ? 'seen' : seen.unknown }); continue; }
    if (line.state === 'refused') { lines.push({ ...base, result: 'refused', why: typeof line.why === 'string' ? line.why : null, board: seen === 'seen' ? 'seen (the board refused it once; a record with this id is on the view now)' : seen.unknown }); continue; }
    // signed (never posted by enactRespond: `sending` is saved before its one POST) or sending: the view decides, or unknown
    lines.push(seen === 'seen' ? { ...base, result: 'confirmed', why: 'the board\'s view shows this record id for this request and wallet; the journal is not updated here' } : { ...base, result: 'unknown', why: seen.unknown });
  }
  return out({ ok: true, lock, world: binding ? { programId: binding.programId, seasonId: binding.seasonId, cluster: binding.cluster, world_id: binding.world_id, clock: binding.clock } : null, lines });
}
