// The way from the game to workstream 01's cooperation between nations — requests across nations, answers, the
// caravans linked to them — through the slot the S1 village card already has (hud/coopentry.mjs). Workstream 07
// connects; the board, its records and its rules are 01's (workstreams/01-national-strategy/coop/), and nothing here
// decides one of them. This replaces 01's proposal 0003 (a second fold in the card, to a fixed path) with the slot
// that was made for it.
//
// 01's board (coop/board.mjs) serves its page and /coop/* and passes every other path on to the herald, so a game
// reached through the board finds /coop/config on its own origin. A game served by the herald alone gets a 404 there
// (a server may also say 204, no content, which a browser does not log as an error): the board is not on this
// server, the slot shows nothing, and it is not asked again until the page is loaded again. A board that cannot be read now is said as such
// (disabled, with why); a board for another Season is not offered (its requests are not this world's).
import { L } from '../../lang.mjs';
import { registerCoopEntry } from './coopentry.mjs';
import { activeHolding } from '../fstate.mjs';
import { pinned } from '../fchainio.mjs';

/** Where 01's board serves its page (coop/board.mjs PAGE); its config may name another (`page`). */
export const BOARD_PAGE = '/ws01/repo/workstreams/01-national-strategy/coop/';

/**
 * Read the board's config: `{read: 'ok', config}` | `{read: 'absent'}` (no board on this server: 404 or 204) |
 * `{read: 'unread', code}` (it did not answer, or answered something else).
 */
export async function probeBoard({ fetch: f = (...a) => globalThis.fetch(...a), base = '' } = {}) {
  let r;
  try { r = await f(`${base}/coop/config`, { cache: 'no-store' }); } catch { return { read: 'unread', code: 'network' }; }
  // (the empty answer is read to its end: an unread body is cancelled by the browser, which then reports the request as
  // aborted — ERR_ABORTED — though the server answered; round 41)
  if (r.status === 404 || r.status === 204) { try { await r.arrayBuffer?.(); } catch { /* nothing to read */ } return { read: 'absent' }; }
  if (!r.ok) return { read: 'unread', code: `HTTP${r.status}` };
  let j;
  try { j = await r.json(); } catch { return { read: 'unread', code: 'BadBody' }; }
  // (01's config: `season` is the board's present context {programId, seasonId} — coop/board.mjs —, `page` its page)
  const s = j?.season;
  if (!j || typeof j !== 'object' || !s || typeof s !== 'object' || typeof s.seasonId !== 'string' || !s.seasonId) return { read: 'unread', code: 'BadConfig' };
  return { read: 'ok', config: j };
}

/** The program the page is pinned to, or null (no pin yet). */
const pinnedProgram = FS => { try { return FS?.pin?.programId ?? pinned()?.programId ?? null; } catch { return null; } };

/** This village as the board's `to` (p,q,site,gen), or null. */
export function villageTo(FS) {
  const h = activeHolding(FS);
  return h ? [h.p, h.q, h.site, h.gen ?? 0].join(',') : null;
}

/** The slot's state for a board read `b` (probeBoard's answer, or null before the first read). */
export function boardState(FS, b) {
  if (!b || b.read === 'absent') return { hidden: true };
  if (b.read !== 'ok') return { available: false, why: L`国をまたぐ依頼の板を読み込めませんでした（${b.code ?? '?'}）。もう一度読み込むと、また確かめます` };
  const season = FS?.season?.seasonId, program = pinnedProgram(FS);
  const other = season === undefined || season === null || b.config.season.seasonId !== String(season)
    || (program && typeof b.config.season.programId === 'string' && b.config.season.programId !== program);
  if (other) return { available: false, why: L`この依頼の板は、別の世界（シーズン）のものです` };
  if (!villageTo(FS)) return { available: false, why: L`村を選ぶと、その村を届け先にして開けます` };
  return { available: true };
}

/**
 * (2026-11-17) Read the board's view (01's coop/board.mjs `/coop/view`, goal.mjs `coopView`): `{read: 'ok', requests}` |
 * `{read: 'unread', code}`. A view whose requests are not all of the shape 01 writes (`ctx {programId, seasonId}`, `to {p, q,
 * site, gen}`, `stateNow`, `fulfilment.status`) is not read at all: an incomplete list is never said as "none".
 */
export async function probeView({ fetch: f = (...a) => globalThis.fetch(...a), base = '' } = {}) {
  let r;
  try { r = await f(`${base}/coop/view`, { cache: 'no-store' }); } catch { return { read: 'unread', code: 'network' }; }
  if (!r.ok) return { read: 'unread', code: `HTTP${r.status}` };
  let j;
  try { j = await r.json(); } catch { return { read: 'unread', code: 'BadBody' }; }
  const int = x => Number.isInteger(Number(x)) && x !== null && x !== '' && typeof x !== 'boolean';
  const good = q => q && typeof q === 'object' && q.ctx && typeof q.ctx.programId === 'string' && (typeof q.ctx.seasonId === 'string' || typeof q.ctx.seasonId === 'number')
    && q.to && ['p', 'q', 'site', 'gen'].every(k => int(q.to[k])) && typeof q.stateNow === 'string' && typeof q.fulfilment?.status === 'string'
    // (sends: each with its outcome as the board checked it, chain.mjs sendOutcome; absent: none recorded)
    && (q.sendings === undefined || (Array.isArray(q.sendings) && q.sendings.every(z => z && typeof z.outcome?.status === 'string')));
  if (!j || !Array.isArray(j.requests) || !j.requests.every(good)) return { read: 'unread', code: 'BadView' };
  return { read: 'ok', requests: j.requests };
}

/** The world a board read is of: its present context (program and Season), as `/coop/config` names it. */
const worldKeyOf = b => (b?.read === 'ok' ? `${b.config.season.programId ?? ''}|${b.config.season.seasonId}` : null);

/**
 * (2026-11-17) What the card says of the requests TO THIS VILLAGE, from the board's view `v` read for the board's present
 * world: `{lines}` or null (nothing to say: the slot is not available). Only this world's requests (their own `ctx` is the
 * board's present context, which `boardState` already found to be the page's world) and only those whose destination `to`
 * is the active village (p, q, site, gen). The fulfilment words are 01's own (ws04.mjs FULFILMENT_JA): "reached" is
 * proven by the counted lower bound, never by a caravan's cargo. Not read yet, or not readable: said as such, never "none".
 */
export function villageRequests(FS, b, v) {
  if (!boardState(FS, b).available) return null;
  if (!v) return { lines: [L`この村あての依頼を読み込んでいます…`] };
  if (v.read !== 'ok') return { lines: [L`この村あての依頼を読み込めませんでした（${v.code ?? '?'}）`] };
  const h = activeHolding(FS), s = b.config.season;
  // (2026-11-17, second tip) the board's config must name its program: without it a request of another program with the
  // same Season number cannot be told apart, so nothing is counted (the link to the board itself is unchanged: boardState)
  if (typeof s.programId !== 'string' || !s.programId) return { lines: [L`この村あての依頼が、この世界のものか確かめられません`] };
  const mine = v.requests.filter(q => q.ctx.programId === s.programId && String(q.ctx.seasonId) === String(s.seasonId)
    && Number(q.to.p) === Number(h.p) && Number(q.to.q) === Number(h.q) && Number(q.to.site) === Number(h.site) && Number(q.to.gen) === Number(h.gen ?? 0));
  if (!mine.length) return { lines: [L`この村あての依頼はありません`] };
  const n = st => mine.filter(q => q.fulfilment.status === st).length;
  // (second tip) a status that is not one of 01's four (ws04.mjs fulfilmentOf) is not known: counted as "cannot be judged",
  // never dropped and never as reached
  const KNOWN = ['fulfilled', 'undetermined', 'not-reached', 'none'];
  const unknown = mine.filter(q => !KNOWN.includes(q.fulfilment.status)).length;
  // (2026-11-17, sends) the sends recorded for these requests, by the outcome 01's board checked (chain.mjs sendOutcome):
  // landed = the transaction is on chain (not "arrived"); failed = the program refused it; expired = its blockhash ran out;
  // mismatch / seq-taken = a transaction or number that does not match the plan (to be looked at); anything else, and
  // unknown, = not known yet. No advice is added here: what to do is said on 01's own page.
  const sends = mine.flatMap(q => q.sendings ?? []).map(z => z.outcome.status);
  const c = st => sends.filter(x => x === st).length;
  const look = c('mismatch') + c('seq-taken');
  const notKnown = sends.length - c('landed') - c('failed') - c('expired') - look;
  // (2026-11-17, one request) each of these requests can be opened on the board itself (open ones first, at most five): only
  // the requests already counted above (this world, this village), with 01's own fulfilment word; nothing is accepted,
  // signed or prepared by following one
  const WORD = { fulfilled: () => L`依頼量に届いた（下限で証明）`, undetermined: () => L`判定できない`, 'not-reached': () => L`届かなかった`, none: () => L`まだ隊商がない` };
  const order = [...mine].sort((a, b) => (a.stateNow === 'open' ? 0 : 1) - (b.stateNow === 'open' ? 0 : 1));
  const links = order.slice(0, 5).map((q, i) => ({ id: q.id, href: boardHref(FS, b, q.id),
    text: L`依頼 ${i + 1} を板で開く（${q.stateNow === 'open' ? L`受付中` : L`受付は終わった`}・${(WORD[q.fulfilment.status] ?? WORD.undetermined)()}）` }))
    .filter(x => x.href.includes('&request='));
  return { links, lines: [
    L`この村あての依頼 ${mine.length} 件（受付中 ${mine.filter(q => q.stateNow === 'open').length}）`,
    L`依頼量に届いた（下限で証明）${n('fulfilled')}・判定できない ${n('undetermined') + unknown}・届かなかった ${n('not-reached')}・まだ隊商がない ${n('none')}`,
    ...(sends.length ? [L`送信 ${sends.length}：記録された ${c('landed')}・断られた ${c('failed')}・期限切れ ${c('expired')}・確かめが要る ${look}・まだ確かめられない ${notKnown}`] : []),
  ] };
}

/**
 * (fix-loop8, LP8-3) The destinations of the requests THIS VIEWER accepted, from the board's view `v` read for the board's
 * present world: `[{kind: 'holding', p, q, site, gen, other: true, coop: {id, need}}]`. Only this world's requests (as
 * villageRequests), still open, whose answer by this wallet (`responses[wallet]`, 01's record.mjs fold) is an accept not
 * withdrawn, and not the viewer's own request. The place is the request's own `to` — the requester published it on the
 * board when asking, and the board shows it to every reader (「行き先 (p,q) 村 n」); nothing else of the requester's land
 * is read or shown by this, and the map's fog is not touched. [] when the board, the view or the world is not this one.
 */
export function acceptedDestinations(FS, b, v, wallet) {
  if (!boardState(FS, b).available || v?.read !== 'ok' || typeof wallet !== 'string' || !wallet) return [];
  const s = b.config.season;
  if (typeof s.programId !== 'string' || !s.programId) return [];
  const int = x => Number.isSafeInteger(Number(x));
  const out = [];
  for (const q of v.requests) {
    if (q.ctx.programId !== s.programId || String(q.ctx.seasonId) !== String(s.seasonId) || q.stateNow !== 'open' || q.requester === wallet) continue;
    const r = q.responses && typeof q.responses === 'object' ? q.responses[wallet] : null;
    if (!r || r.answer !== 'accept' || r.withdrawn === true) continue;
    if (!['p', 'q', 'site', 'gen'].every(k => int(q.to[k]))) continue;
    const to = { kind: 'holding', p: Number(q.to.p), q: Number(q.to.q), site: Number(q.to.site), gen: Number(q.to.gen) };
    if (out.some(x => x.p === to.p && x.q === to.q && x.site === to.site)) continue;
    out.push({ ...to, other: true, coop: { id: String(q.id ?? ''), need: q.need && typeof q.need === 'object' ? { ...q.need } : {} } });
  }
  return out;
}

/** The board's page for this village (the board's own `page` when its config names one on this origin). */
export function boardHref(FS, b, requestId = null) {
  const page = typeof b?.config?.page === 'string' && b.config.page.startsWith('/') && !b.config.page.startsWith('//') ? b.config.page : BOARD_PAGE;
  // (2026-11-17) the village's world goes with it: the program and Season THIS page is pinned to. The board's page fills the
  // destination only when they are its own present world (coop-ui.mjs); a world this page cannot name is not sent, and then
  // the board's page does not fill it in.
  const program = pinnedProgram(FS), season = FS?.season?.seasonId;
  const world = typeof program === 'string' && program && season !== undefined && season !== null
    ? `&program=${encodeURIComponent(program)}&season=${encodeURIComponent(String(season))}` : '';
  // (2026-11-17, one request) a request of THIS village and world may be named: the board's page checks it again (its world,
  // and that it is to this village) before it points at it; the id is only ever URL-encoded here and escaped where drawn
  const one = typeof requestId === 'string' && requestId && requestId.length <= 128 && world ? `&request=${encodeURIComponent(requestId)}` : '';
  return `${page}?to=${encodeURIComponent(villageTo(FS) ?? '')}${world}${one}`;
}

/**
 * Register the entry and read the board now and every `every` ms while it is there or could not be read; a server
 * that says it has no board is not asked again (each ask would be one more 404 in the console every minute).
 * `changed()` is called after each read (the page draws the card again). → a function that stops it and removes the entry.
 */
export const COOP_VIEW_FRESH_MS = 15_000;
export function installCoopBoard({ fetch, base = '', every = 60_000, changed = () => {}, open = href => globalThis.open?.(href, '_blank', 'noopener'), timers = globalThis } = {}) {
  let board = null, stopped = false, timer = null;
  // (2026-11-17) the board's view, read when the card asks for it (no timer of its own) and kept with the world it was read
  // for: `{key, ...probeView}`. A newer read supersedes an older one (`viewSeq`); an answer for another world, an older read,
  // or one that comes after stop is dropped. Each read of the config marks it due again (`viewDue`).
  let view = null, viewSeq = 0, viewInFlight = null, viewDue = false;
  const readView = async key => {
    const seq = ++viewSeq;
    viewInFlight = key; viewDue = false;
    const r = await probeView({ fetch, base });
    if (stopped || seq !== viewSeq) return;
    viewInFlight = null;
    view = worldKeyOf(board) === key ? { key, at: Date.now(), ...r } : null;   // the board moved to another world meanwhile: not kept
    changed();
  };
  const read = async () => {
    const b = await probeBoard({ fetch, base });
    if (stopped) return;
    board = b;
    viewDue = true;
    changed();
    if (b.read !== 'absent') timer = timers.setTimeout?.(read, every) ?? null;
  };
  const off = registerCoopEntry({
    id: 'ws01-coop',
    title: () => L`国をまたぐ依頼を開く`,
    state: FS => boardState(FS, board),
    open: FS => open(boardHref(FS, board)),
    detail: FS => {
      if (!boardState(FS, board).available) return null;
      const key = worldKeyOf(board);
      if ((viewDue || !view || view.key !== key) && viewInFlight !== key) readView(key);
      return villageRequests(FS, board, view && view.key === key ? view : null);
    },
    // (fix-loop8, LP8-3: the caravan form's destinations — the requests this wallet accepted; read with the same view)
    destinations: FS => {
      if (!boardState(FS, board).available) return [];
      const key = worldKeyOf(board);
      // (an answer given on the board a moment ago should reach the form soon: the view is read again when 15 s old)
      if ((viewDue || !view || view.key !== key || !(Date.now() - (view.at ?? 0) < COOP_VIEW_FRESH_MS)) && viewInFlight !== key) readView(key);
      return acceptedDestinations(FS, board, view && view.key === key ? view : null, FS?.wallet?.address ?? null);
    },
  });
  read();
  return () => { stopped = true; if (timer !== null) timers.clearTimeout?.(timer); off(); };
}
