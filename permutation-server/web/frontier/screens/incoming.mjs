// Incoming-arrival warnings (web design §7.7): departures are public
// (origin and arrival turn, never the destination), so for each hostile
// departure that could reach one of the viewer's villages by its arrival
// turn the panel says "on turn b, up to N hosts (M troops) may arrive at
// <village>; where they are going is sealed". The reach test is the kernel's `reachable`
// (optimistic: a "no" is certain, a "yes" is only a warning); without the
// rules module the panel says the warnings are unavailable.
//
// (2026-11-17, ⑦ the warning's way on) A warning was a sentence and nothing else. From it the person can now go on, by
// what already exists: open the village it names (by its identity, never an index), bring its garrison form into view,
// see the place on the map, see where that village's own hosts stand, and open the EXISTING plan of a march home for a
// host that is away (controller 'march-home': it opens the draft; sending is the plan's own step). Nothing here sends,
// attacks, or decides for the person, and nothing is said that the page does not know: whether the hosts come, and
// where they go, stays sealed; whether a host at home will fight is the rules', not this card's.
// How the warnings were read is said too: not judged yet (another viewer or world just taken) is not "none"; a
// chronicle read that failed, or departures whose origin's owner is not read, are said beside the list.
import { html } from '../../util.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { holdingName } from '../people/ui.mjs';
import { provinceName } from '../hud/place.mjs';
import { icon } from '../hud/icons.mjs';
import { unitCount } from '../fi18n.mjs';
import { hostsIn, UNIT_ORDER } from '../fland.mjs';
import { cardHead, chip } from './parts.mjs';

/** The pinned world with its generation, as the controller marks it (providerWorld). */
const worldOf = FS => { const pin = FS?.pin ?? null; return pin?.programId && pin?.addresses?.season ? `${pin.gen ?? 0}|${pin.cluster ?? ''}|${pin.programId}|${pin.addresses.season}` : null; };

/**
 * The viewer's village a warning names, as it stands now: the same place and site, and — where the warning carries it —
 * the same generation (a village founded anew on the site is another village). Null when it is not among the viewer's.
 */
export const holdingOfWarning = (w, FS) => (FS?.holdings ?? []).find(o => o.p === w.holding.p && o.q === w.holding.q && (w.holding.site === undefined || o.site === w.holding.site)
  && (w.holding.gen === undefined || (o.gen ?? 0) === w.holding.gen)) ?? null;

/** The village a warning is about, by its name (`FS` gives its tier); without the store, the province in words. */
const villageOf = (w, FS) => { const h = holdingOfWarning(w, FS); return h ? holdingName(h) : provinceName(FS, w.holding.p, w.holding.q); };

/** One warning line. The destinations of those hosts are sealed: the line says so and names none. */
export const warningText = (w, FS = null) => L`ターン ${fmtNum(w.bell)} に、${villageOf(w, FS)}へ最大 ${w.hosts} の軍勢（${fmtNum(w.troops)} 兵）が来るかもしれません。行き先は封印中です。`;

/**
 * How the warnings were read (controller `FS.incomingRead`): `{state}` —
 *   'unread'   nothing was judged for this viewer and this pinned world yet (`FS.incomingRead` null, or another world's)
 *   'noRules'  the rules module is not there: nothing can be judged
 *   'ok'       judged; `chronicleOk` false when the chronicle's last read failed, `unknownOrigins` the departures still
 *              under way that could not be judged (their origin's owner is not read)
 * A store that carries no `incomingRead` at all (an older fixture) is read as judged, as before.
 */
export function incomingRead(FS) {
  const r = FS.incomingRead;
  if (r === null || (r && r.world !== worldOf(FS))) return { state: 'unread', chronicleOk: true, unknownOrigins: 0 };
  if (FS.incoming === null || FS.incoming === undefined) return { state: 'noRules', chronicleOk: true, unknownOrigins: 0 };
  return { state: 'ok', chronicleOk: r ? r.chronicleOk !== false : true, unknownOrigins: Number(r?.unknownOrigins ?? 0) };
}

/**
 * Where the hosts of a warning's village stand, from the provinces the page holds: `{holding, home, away, moving}` —
 * `home`: on the village's own tile; `away`: standing elsewhere; `moving`: on the road (each `{id, unit, troops, p, q,
 * tile}`). Null when the village is not among the viewer's now. A host in a province that is not read is not listed.
 */
export function defendersOf(FS, w) {
  const h = holdingOfWarning(w, FS);
  if (!h) return null;
  const bell = FS.nowBell ?? 0, rows = [];
  for (const env of FS.provinces?.values?.() ?? []) {
    const prov = env?.province;
    if (!prov) continue;
    for (const r of hostsIn(prov, h, bell)) rows.push({ id: String(r.id), unit: r.unit, troops: r.troops, p: prov.p, q: prov.q, tile: r.tile, moving: !!r.inTransit, home: prov.p === h.p && prov.q === h.q && r.tile === h.tile });
  }
  return { holding: h, home: rows.filter(r => r.home && !r.moving), away: rows.filter(r => !r.home && !r.moving), moving: rows.filter(r => r.moving) };
}

const troopsOf = list => list.reduce((a, r) => a + Number(r.troops ?? 0), 0);

/** One warning with its way on. */
function warningItem(FS, w) {
  const d = defendersOf(FS, w), play = FS.mode === 'play';
  if (!d) return html`<li class="warn">${warningText(w, FS)}<p class="muted" data-incoming="gone">${L`この村は、いまのあなたの村の記録にありません。`}</p></li>`;
  const h = d.holding, ref = html`data-p="${h.p}" data-q="${h.q}" data-site="${h.site}" data-gen="${h.gen ?? 0}"`;
  return html`<li class="warn">${warningText(w, FS)}
    ${play ? html`<div class="actions"><button type="button" class="btn small" data-act="incoming-village" ${ref} data-to="holding">${icon('home')}${L`この村を開く`}</button>
      <button type="button" class="btn small" data-act="incoming-village" ${ref} data-to="garrison">${icon('shield')}${L`守備隊を増やす欄へ`}</button>
      <button type="button" class="btn small" data-act="goto" data-p="${h.p}" data-q="${h.q}">${L`地図で見る`}</button></div>` : ''}
    <p class="muted" data-incoming="hosts">${L`この村の軍勢：村のマスに ${fmtNum(d.home.length)}（${fmtNum(troopsOf(d.home))} 兵）、ほかの場所に ${fmtNum(d.away.length)}、行軍中 ${fmtNum(d.moving.length)}。`}</p>
    ${play && d.away.length ? html`<ul class="list incoming-hosts">${d.away.map(r => html`<li>${unitCount(UNIT_ORDER[r.unit], r.troops)} <span class="muted">${provinceName(FS, r.p, r.q)}</span>
      <button type="button" class="btn small" data-act="march-home" data-host="${r.id}">${icon('return')}${L`村へ戻す計画を開く`}</button></li>`)}</ul>` : ''}</li>`;
}

export function render(FS) {
  const w = FS.incoming, rd = incomingRead(FS);
  if (rd.state === 'unread') return html`<p class="muted how-line" role="status" data-incoming="unread">${icon('alert')}${L`来襲の恐れは、まだ調べていません。出ていない、という意味ではありません。`}</p>`;
  if (rd.state === 'noRules') return html`<p class="muted how-line">${icon('alert')}${L`ルールを読み込めていないため、来襲の恐れを調べられません。`}</p>`;
  const notes = html`${rd.chronicleOk ? '' : html`<p class="notice error" role="status" data-incoming="chronicle">${L`できごとの記録の最新の読み込みが失敗しています。新しい出発を、数えられていないことがあります。`}</p>`}${rd.unknownOrigins > 0
    ? html`<p class="muted" role="status" data-incoming="origins">${L`出発地の持ち主をまだ読めていない出発が ${fmtNum(rd.unknownOrigins)} 件あります。来襲の恐れには数えていません（来ない、という意味ではありません）。`}</p>` : ''}`;
  if (!w.length) return html`<p class="muted how-line">${icon('shield')}${L`いまのところ、あなたの村に届きそうな他国の軍勢は出ていません。`}</p>${notes}`;
  return html`<section class="vcard incoming-card" aria-labelledby="incoming-title">
    ${cardHead({ id: 'incoming-title', ic: 'alert', title: L`来襲の恐れ`, side: chip(fmtNum(w.length), 'bad') })}
    <ul class="list incoming">${w.map(x => warningItem(FS, x))}</ul>
    ${notes}
    <p class="muted">${L`来るかどうか、どこへ行くかは、封印が開くまで分かりません。上のボタンは、村や計画を開くだけです。送るかどうかは、開いた先であなたが決めます。`}</p>
    <p class="muted">${L`ほかの州にいる軍勢は、その州の記録を読めているものだけを数えています。戦いがあれば、そのターンのあと「あなたの衝突の報告」に出ます。`}</p></section>`;
}
