// The chronicle (web design §7.10; UX design 11.13): the season's public
// record as the herald's event pages carry it — ring and province openings,
// villages founded, departures (who left and the arrival turn only),
// seals opened, clashes, march results, explorations — decoded by this page
// from the raw PS2 bodies (flog.mjs); the viewer's own lines are marked.
// A place is said by its name (a village's, else the province in words:
// hud/place.mjs provinceName); the turn is the block's stamp, so a line
// repeats a number only when it is another turn's (an arrival still to come).
import { html } from '../../util.mjs';
import { L, fmtNum, lang } from '../../lang.mjs';
import { TRANSIT_OUTCOME_TEXT } from '../fi18n.mjs';
import { TRANSIT_OUTCOMES, SETTLE_OUTCOMES } from '../flog.mjs';
import { hostParts } from '../faddr.mjs';
import { placeName } from '../people/identity.mjs';
import { icon } from '../hud/icons.mjs';
import { provinceName } from '../hud/place.mjs';
import { cardHead, fold } from './parts.mjs';

/** A site by its place name (the name a village there carries), in the page's language. */
const nameAt = (p, q, site) => placeName(Number(p), Number(q), Number(site))[lang() === 'en' ? 'en' : 'ja'];
const siteName = r => nameAt(r.p, r.q, r.site);
/** The village a host belongs to, by its place name; null for an id that names no host. */
const homeOf = id => { let h = null; try { h = hostParts(id); } catch { h = null; } return h ? nameAt(h.p, h.q, h.site) : null; };

/**
 * A record's line, or null for a kind the chronicle does not list. `FS` (optional) lets a province be said by the
 * viewer's own village in it.
 */
export function lineOf(r, FS = null) {
  const prov = (p, q) => provinceName(FS, Number(p), Number(q));
  switch (r.name) {
    case 'RING_OPEN': return L`第${r.d}輪がひらかれた`;
    case 'PROVINCE_OPEN': return L`${prov(r.p, r.q)}がひらかれた（村を置ける場所 ${r.site_count}）`;
    case 'JOIN': return L`新しい領主が加わった`;
    case 'SETTLE': return { fresh: () => L`${siteName(r)}に村ができた`, displace: () => L`${siteName(r)}の仮の村が押し出された`,
      taken: () => null, expired: () => L`村の申し込みが期限切れになった` }[SETTLE_OUTCOMES[r.outcome]]?.() ?? null;
    case 'HOLDING_FINAL': return L`${siteName(r)}の村が確定した`;
    case 'DEPART': { const home = homeOf(r.host_id); return home ? L`${home}の軍勢が出発した（ターン ${fmtNum(r.arrive_bell)} に到着）` : L`${prov(r.origin_p, r.origin_q)}から軍勢が出発した（ターン ${fmtNum(r.arrive_bell)} に到着）`; }
    case 'REVEAL': return L`${prov(r.p, r.q)}への到着の封が開けられた（ターン ${fmtNum(r.arrive)}）`;
    case 'CLASH': return L`${prov(r.p, r.q)}で衝突が決着した`;
    case 'TRANSIT_SETTLED': return L`進軍の結果：${TRANSIT_OUTCOME_TEXT[TRANSIT_OUTCOMES[r.outcome]] ?? r.outcome}`;
    case 'EXPLORE_RESULT': return L`探索の結果：功績 ${r.works}`;
    case 'CAMP': return L`${prov(r.p, r.q)}に蛮族の野営地が現れた`;
    default: return null;
  }
}

/** Where a record happened (the province "see" goes to), or null. A departure's is its origin: its destination is sealed. */
export function placeOf(r) {
  const at = r.name === 'DEPART' ? [r.origin_p, r.origin_q] : ['PROVINCE_OPEN', 'SETTLE', 'HOLDING_FINAL', 'REVEAL', 'CLASH', 'CAMP'].includes(r.name) ? [r.p, r.q] : null;
  return at && at.every(x => Number.isInteger(Number(x))) && at.every(x => x !== undefined && x !== null) ? { p: Number(at[0]), q: Number(at[1]) } : null;
}

/** Chronicle rows, newest first: `[{seq, bell, text, mine, at, clash}]`; `mine(record)` marks the viewer's own; `FS` as in `lineOf`. */
export function chronicleRows(records, mine = () => false, limit = 60, FS = null) {
  const out = [];
  for (let i = records.length - 1; i >= 0 && out.length < limit; i--) {
    const { seq, record } = records[i];
    const text = lineOf(record, FS);
    if (text) out.push({ seq, bell: record.bell, text, mine: !!mine(record), at: placeOf(record), clash: record.name === 'CLASH' });
  }
  return out;
}

/** How many turns of the chronicle stand in sight before the fold. */
export const TURNS_SHOWN = 2;

function turnBlock(bell, rows) {
  return html`<li class="chron-turn"><h4 class="chron-stamp">${icon('bell')}${L`ターン ${fmtNum(bell)}`}</h4>
    <ol class="chron-lines">${rows.map(r => html`<li class="${r.mine ? 'mine' : ''}"><span class="chron-text">${r.text}${r.mine ? html` <span class="mine-mark">${L`（あなた）`}</span>` : ''}</span>${r.at ? (r.clash
      ? html`<button type="button" class="btn small quiet chron-go" data-act="report-open" data-p="${r.at.p}" data-q="${r.at.q}" data-bell="${r.bell}">${L`報告`}</button>`
      : html`<button type="button" class="btn small quiet chron-go" data-act="goto" data-p="${r.at.p}" data-q="${r.at.q}">${L`見る`}</button>`) : ''}</li>`)}</ol></li>`;
}

/**
 * The chronicle as a document: the record grouped by turn, the latest turns
 * in sight and the rest behind a fold; a line with a place goes there.
 */
export function render(FS) {
  const rows = chronicleRows(FS.chronicle ?? [], FS.isMine ?? (() => false), 60, FS);
  if (!rows.length) return html`<section class="vcard" aria-labelledby="chronicle-title">${cardHead({ id: 'chronicle-title', ic: 'quill', title: L`年代記` })}<p class="muted">${L`まだ記録はありません`}</p></section>`;
  const turns = [];
  for (const r of rows) { const t = turns[turns.length - 1]; if (t && t.bell === r.bell) t.rows.push(r); else turns.push({ bell: r.bell, rows: [r] }); }
  const first = turns.slice(0, TURNS_SHOWN), rest = turns.slice(TURNS_SHOWN);
  return html`<section class="vcard chronicle-card" aria-labelledby="chronicle-title">${cardHead({ id: 'chronicle-title', ic: 'quill', title: L`年代記`, sub: L`この世界で起きたことの記録` })}
    <ol class="chron">${first.map(t => turnBlock(t.bell, t.rows))}</ol>
    ${rest.length ? fold('chron-old', L`それより前の記録（${fmtNum(rest.reduce((a, t) => a + t.rows.length, 0))}）`, html`<ol class="chron">${rest.map(t => turnBlock(t.bell, t.rows))}</ol>`) : ''}</section>`;
}
