// Titles and chronicle lines of cooperation between nations (workstream 15, owner decision 2026-11-18: ruleset B).
// Workstream 01's board (coop/board.mjs `/coop/outcomes`) runs 15's evaluator over the herald's public records and its
// own; this page only READS the answer and shows it. A title is a record: nothing here — nor in the answer — touches
// who wins, a score, a prize or the end of a season, and an answer that claims any such effect, or names a ruleset
// other than B, is not shown at all.
//
// As hud/coopboard.mjs: a game served by the herald alone gets a 404 (or 204) at /coop/outcomes; then the card is not
// drawn and the path is not asked again until the page is loaded again. An answer for another world (program or
// Season) is not shown.
import { html, raw } from '../../util.mjs';
import { L, fmtNum, lang } from '../../lang.mjs';
import { factionName } from '../fi18n.mjs';
import { tagOf } from '../people/identity.mjs';
import { decode as fromBase58 } from '../../sdk/base58.mjs';

/** A turn's stamp, as the chronicle says it (screens/chronicle.mjs stampOf; not imported: that module reaches the march
 * sealing code, which this read-only card has no use for). u32::MAX marks a record from before the first turn. */
const stampOf = bell => (Number(bell) >= 0xffffffff ? L`最初のターンの前` : L`ターン ${fmtNum(bell)}`);

/** The card's head and fold, in the markup screens/parts.mjs cardHead/fold write (not imported for the same reason; no icon). */
// (the banner icon as hud/icons.mjs icon('banner') writes it: the sprite beside the page, art/ui/icons.svg)
const BANNER = raw('<svg class="ic" aria-hidden="true" focusable="false"><use href="art/ui/icons.svg#banner"/></svg>');
const cardHead = ({ id, title, sub }) => html`<header class="c-head"><span class="c-ic">${BANNER}</span><span class="c-titles"><h3 id="${id}">${title}</h3><span class="c-sub">${sub}</span></span></header>`;
const fold = (key, summary, body) => html`<details class="fold" data-fold="${key}"><summary><span class="fold-sum">${summary}</span></summary><div class="fold-body">${body}</div></details>`;

/** The effects an answer must state: none of them. */
export const NO_EFFECT = Object.freeze({ win: 'none', score: 'none', prize: 'none', seasonEnd: 'none' });
/** How many entries stand in sight before the fold. */
export const SHOWN = 6;

const str = x => typeof x === 'string' && x.length > 0 && x.length <= 400;
const pair = x => x && typeof x === 'object' && str(x.ja) && str(x.en);
const goodEntry = e => e && typeof e === 'object' && str(e.id) && str(e.goal) && Number.isSafeInteger(e.at) && e.at >= 0
  && pair(e.title) && pair(e.reason) && e.subject && typeof e.subject === 'object' && ['nation', 'actor'].includes(e.subject.kind)
  && (e.subject.nation === null || /^n[0-5]$/.test(String(e.subject.nation)))
  && (e.audience === undefined || e.audience === 'all' || e.audience === 'subject');

/**
 * Read the board's outcomes: `{read: 'ok', outcomes}` | `{read: 'absent'}` (no board, or no evaluator, on this server) |
 * `{read: 'unread', code}`. An answer whose effects are not all 'none', or whose ruleset is not B, is `BadOutcomes`.
 */
export async function probeOutcomes({ fetch: f = (...a) => globalThis.fetch(...a), base = '' } = {}) {
  let r;
  try { r = await f(`${base}/coop/outcomes`, { cache: 'no-store' }); } catch { return { read: 'unread', code: 'network' }; }
  if (r.status === 404 || r.status === 204) { try { await r.arrayBuffer?.(); } catch { /* nothing to read */ } return { read: 'absent' }; }
  let j = null;
  try { j = await r.json(); } catch { j = null; }
  if (!r.ok) return { read: 'unread', code: typeof j?.code === 'string' && /^[A-Za-z0-9]{1,40}$/.test(j.code) ? j.code : `HTTP${r.status}` };
  const ok = j && j.ok === true && j.v === 1 && j.kind === 'ws15-coop-outcomes' && j.ruleset?.variant === 'B' && j.ruleset?.carryInputs === true
    && j.effects && Object.keys(NO_EFFECT).every(k => j.effects[k] === 'none') && Object.keys(j.effects).length === Object.keys(NO_EFFECT).length
    && j.season && typeof j.season.seasonId === 'string' && Array.isArray(j.entries) && j.entries.every(goodEntry) && Number.isSafeInteger(j.undecided);
  return ok ? { read: 'ok', outcomes: j } : { read: 'unread', code: 'BadOutcomes' };
}

/** The program the page is pinned to (app.mjs sets FS.pin when the season is read), or null. */
const pinnedProgram = FS => FS?.pin?.programId ?? null;

/** Whether an answer is of the world this page shows (its Season and, when both name one, its program). */
export function sameWorld(FS, o) {
  const season = FS?.season?.seasonId;
  if (season === undefined || season === null || String(o?.season?.seasonId) !== String(season)) return false;
  const program = pinnedProgram(FS);
  return !(program && typeof o.season.programId === 'string' && o.season.programId !== program);
}

const pick = p => (lang() === 'en' ? p.en : p.ja);
const nationIndex = n => (typeof n === 'string' && /^n[0-5]$/.test(n) ? Number(n.slice(1)) : null);

/** Who earned a title, in words: a nation by its name, a lord by their nation. */
export function whoOf(e) {
  const n = nationIndex(e.subject.nation);
  if (e.subject.kind === 'nation') return n === null ? L`ある国` : factionName(n);
  return n === null ? L`所属の分からない領主` : L`${factionName(n)}の領主`;
}

/**
 * The viewer's Citizen as the evaluator names actors (`tag:<u64 decimal>`), or null. As people/ui.mjs ownTag (not
 * imported: that module draws portraits): a held village's owner, else the wallet's Citizen address.
 */
export function viewerActor(FS) {
  try {
    const h = FS?.holdings?.find?.(x => x?.ownerCitizen);
    if (h) return `tag:${tagOf(h.ownerCitizen).toString()}`;
    const a = FS?.wallet && FS.pin?.addresses?.of?.('Citizen', { wallet: FS.wallet.address });
    return a ? `tag:${tagOf(fromBase58(a)).toString()}` : null;
  } catch { return null; }
}

/**
 * The card's rows, newest first: `[{id, at, text, reason, mine, own}]` (`mine`: of the viewer's nation; `own`: the
 * viewer's own title). An entry for its holder only (`audience: 'subject'` — ⑮'s 「依頼に応えた」, owner decision
 * 2026-11-22) is drawn for that player alone: other players' pages leave it out (it is a line of their own chronicle).
 */
export function outcomeRows(o, FS = null) {
  const faction = FS?.citizen?.faction ?? null;
  const me = viewerActor(FS);
  return o.entries.filter(e => e.audience !== 'subject' || (me !== null && e.subject.kind === 'actor' && e.subject.id === me)).map(e => {
    const own = me !== null && e.subject.kind === 'actor' && e.subject.id === me;
    return { id: e.id, at: e.at, text: own ? L`あなたが称号「${pick(e.title)}」を得た` : L`${whoOf(e)}が称号「${pick(e.title)}」を得た`, reason: pick(e.reason),
      mine: own || (faction !== null && nationIndex(e.subject.nation) === Number(faction)), own };
  });
}

const rowMarkup = r => html`<li class="chron-turn coop-title-row${r.mine ? ' mine' : ''}${r.own ? ' own' : ''}" data-title="${r.id}"><h4 class="chron-stamp">${stampOf(r.at)}</h4>
  <ol class="chron-lines"><li><span class="chron-text">${r.text}${r.mine && !r.own ? html` <span class="mine-mark">${L`（あなたの国）`}</span>` : ''}<br><small class="muted coop-title-reason">${L`理由：${r.reason}`}</small></span></li></ol></li>`;

/** The card for a read `b` (probeOutcomes' answer, or null before the first read): '' when there is nothing to show. */
export function render(FS, b) {
  if (!b || b.read === 'absent') return '';
  const head = cardHead({ id: 'coop-titles-title', title: L`称号と記録`, sub: L`国をまたぐ協力の達成。勝敗・得点・賞金には関わらない` });
  if (b.read !== 'ok') return html`<section class="vcard coop-titles" aria-labelledby="coop-titles-title">${head}<p class="muted read-state" role="status" data-read="unread">${L`称号と記録を読み込めませんでした（${b.code ?? '?'}）。記録が空という意味ではありません`}</p></section>`;
  if (!sameWorld(FS, b.outcomes)) return '';
  const rows = outcomeRows(b.outcomes, FS);
  const first = rows.slice(0, SHOWN), rest = rows.slice(SHOWN);
  const undecided = b.outcomes.undecided > 0 ? html`<p class="muted">${L`まだ判定できない達成 ${fmtNum(b.outcomes.undecided)}（記録が欠けているか、量が確かめられない）`}</p>` : '';
  return html`<section class="vcard coop-titles" aria-labelledby="coop-titles-title" data-ruleset="${b.outcomes.ruleset.variant}">${head}
    ${rows.length ? html`<ol class="chron">${first.map(rowMarkup)}</ol>` : html`<p class="muted">${L`まだ称号はありません`}</p>`}
    ${rest.length ? fold('coop-titles-old', L`それより前の称号（${fmtNum(rest.length)}）`, html`<ol class="chron">${rest.map(rowMarkup)}</ol>`) : ''}
    ${undecided}<p class="muted small">${L`称号と記録だけです。世界の目標の達成・得点・賞金には何も加えません`}</p></section>`;
}

/** The latest read, for the page's render (null before the first). */
let last = null;
export const current = () => last;

/**
 * Read now and every `every` ms while the board answers (or could not be read); a server with no outcomes is not
 * asked again. `changed()` after each read. Installs once: a second call while it runs returns the same stop.
 * → a function that stops it.
 */
let running = null;
export function installCoopOutcomes({ fetch, base = '', every = 60_000, changed = () => {}, timers = globalThis } = {}) {
  // (once: the page's start may run again after a step threw; a second call returns the first one's stop)
  if (running) return running;
  let stopped = false, timer = null;
  const read = async () => {
    const b = await probeOutcomes({ fetch, base });
    if (stopped) return;
    last = b;
    changed();
    if (b.read !== 'absent') timer = timers.setTimeout?.(read, every) ?? null;
  };
  read();
  running = () => { stopped = true; last = null; running = null; if (timer !== null) timers.clearTimeout?.(timer); };
  return running;
}
