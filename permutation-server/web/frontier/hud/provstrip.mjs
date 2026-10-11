// "Provinces held" on a conquest season (program version 3): the six nations
// with the number of provinces each holds, from the chain's records as the
// herald serves them (the standings record, checked by screens/conquest.mjs
// `scoreRows`; after the season's end the final record). The viewer's nation
// is marked. A press opens the full standings (the nation tab).
//
// And the season's end as ONE card, said only when the records say it: with
// a prize pool, when the pool's own count is final on chain (Tally and
// Finalize: `FS.prize.state` no longer open, with its area and winners);
// without one, when the herald's final standings stand. Never from the
// page's own count, and never before.
//
// Pure: the models from the store, the markup from the models. app.mjs puts
// them in the page and gives a changed figure its beat (`changedCounts`).
import { html } from '../../util.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { factionName } from '../fi18n.mjs';
import { scoreRows } from '../screens/conquest.mjs';
import { prizeModel } from '../fprize.mjs';
import { icon } from './icons.mjs';
import { crest, conquestOn } from './keephand.mjs';

const ended = FS => (FS.nowBell ?? 0) >= Number(FS.season?.endBell ?? Infinity);

/**
 * The strip's model, or null (no conquest season, or no readable record yet): `{rows: [{faction, provinces, mine,
 * lead}] in the nations' own order, bell (the turn the record speaks of), final, total}`.
 */
export function stripModel(FS) {
  if (!conquestOn(FS)) return null;
  const cq = FS.conquest, over = ended(FS);
  const record = over && cq?.final ? cq.final : cq?.standings;
  let rows = scoreRows(record);
  if (!rows) return null;
  const final = over && record === cq?.final;
  // (the standings record is written a turn or two after the control record that says who holds each keep: a capture
  // the board has just played from the control record would be counted here a minute or twenty later. While the
  // control record is the newer of the two and accounts for every province the standings count, the figures are its own)
  let bell = record.bell;
  const ahead = final ? null : controlCounts(cq, rows.reduce((a, r) => a + r.provinces, 0));
  if (ahead && ahead.bell > record.bell) { rows = rows.map(r => ({ ...r, provinces: ahead.counts[r.faction] })); bell = ahead.bell; }
  const top = Math.max(...rows.map(r => r.provinces));
  const mine = FS.citizen?.faction;
  return { bell, final, total: rows.reduce((a, r) => a + r.provinces, 0),
    rows: [...rows].sort((a, b) => a.faction - b.faction).map(r => ({ faction: r.faction, provinces: r.provinces, mine: r.faction === mine, lead: top > 0 && r.provinces === top })) };
}

/**
 * The provinces each nation holds by the control record the page has read (`FS.conquest.control`, laid on
 * `FS.conquest.keeps` by controller.mjs refreshConquest): `{bell, counts: [six]}`, or null unless every keep's holder
 * is read from a record of that turn or later and the counts add up to `total` (the standings' own sum).
 */
export function controlCounts(cq, total = null) {
  const bell = cq?.control?.bell;
  if (!Number.isInteger(bell) || !cq.keeps?.size) return null;
  const counts = [0, 0, 0, 0, 0, 0];
  for (const k of cq.keeps.values()) {
    if (!Number.isInteger(k.asOfBell) || k.asOfBell < bell) return null;
    if (Number.isInteger(k.holder) && k.holder >= 0 && k.holder < 6) counts[k.holder] += 1;
  }
  if (total !== null && counts.reduce((a, n) => a + n, 0) !== total) return null;
  return { bell, counts };
}

/** The strip as one line read aloud: "Provinces held: Aster 9, …". */
export const stripText = m => { const list = m.rows.map(r => `${factionName(r.faction)} ${fmtNum(r.provinces)}`).join(' · '); return L`支配する州：${list}`; };

/** The strip (one button: a press opens the full standings). */
export function renderStrip(m) {
  if (!m) return '';
  return html`<button type="button" class="ps" data-act="tab" data-tab="territory" aria-label="${L`${stripText(m)}（押すと順位の表を開きます）`}" title="${L`第${fmtNum(m.bell)}ターンまでのチェーンの記録です。押すと順位の表を開きます`}">
    <span class="ps-k">${icon('flag')}<span>${m.final ? L`最終の州の数` : L`支配する州`}</span></span>
    <span class="ps-rows">${m.rows.map(r => html`<span class="ps-n kh-n${r.faction}${r.mine ? ' ps-mine' : ''}${r.lead ? ' ps-lead' : ''}" data-f="${r.faction}" data-v="${r.provinces}">${crest(r.faction, 20)}<span class="ps-name">${factionName(r.faction)}</span><span class="ps-v num">${fmtNum(r.provinces)}</span>${r.mine ? html`<span class="ps-you">${L`あなた`}</span>` : ''}</span>`)}</span>
    <span class="ps-go" aria-hidden="true">${icon('chevron')}</span></button>`;
}

/** Which nations' figures changed between two models: `[{faction, from, to}]` (nothing on the first one). */
export function changedCounts(prev, next) {
  if (!prev || !next) return [];
  const out = [];
  for (const r of next.rows) { const p = prev.rows.find(x => x.faction === r.faction); if (p && p.provinces !== r.provinces) out.push({ faction: r.faction, from: p.provinces, to: r.provinces }); }
  return out;
}

/**
 * The season's end, or null while the records do not say it: `{winners: [faction], provinces (the winners' count),
 * area: [six counts by nation], source: 'pool' | 'final', mine (the viewer's nation is among the winners), key}`.
 */
export function seasonEndModel(FS) {
  if (!conquestOn(FS) || !ended(FS)) return null;
  const pm = FS.prize ? prizeModel(FS.prize) : null;
  if (pm) {
    // a season with a pool: the pool's own count on chain, once it is final (Tally over every keep, then Finalize)
    if (!pm.final || !Array.isArray(pm.area) || pm.area.length !== 6 || !Array.isArray(pm.winners) || !pm.winners.length) return null;
    const area = pm.area.map(a => a.provinces);
    return { winners: [...pm.winners], provinces: Math.max(...pm.winners.map(f => area[f] ?? 0)), area, source: 'pool', mine: pm.winners.includes(FS.citizen?.faction), key: `pool:${pm.winners.join(',')}:${area.join(',')}` };
  }
  const rows = scoreRows(FS.conquest?.final);
  if (!rows) return null;
  const area = Array.from({ length: 6 }, (_, f) => rows.find(r => r.faction === f)?.provinces ?? 0);
  const winners = rows.filter(r => r.rank === 1).map(r => r.faction).sort((a, b) => a - b);
  return { winners, provinces: rows[0].provinces, area, source: 'final', mine: winners.includes(FS.citizen?.faction), key: `final:${winners.join(',')}:${area.join(',')}` };
}

/** The headline: "Aster holds the most provinces (11)"; a tie for first names every nation in it. */
export const seasonEndLine = m => (m.winners.length === 1
  ? L`${factionName(m.winners[0])}が最も多くの州を保持（${fmtNum(m.provinces)}）`
  : L`首位は同数：${m.winners.map(factionName).join(' / ')}（各 ${fmtNum(m.provinces)}）`);

/** The season-end card (`#season-end`): the result in one line, the six counts, and the way to the full result. */
export function renderSeasonEnd(m) {
  if (!m) return '';
  return html`<section class="se-card${m.mine ? ' se-mine' : ''}" role="status" aria-labelledby="se-title">
    <button type="button" class="se-x" data-act="se-close" aria-label="${L`閉じる`}">${icon('close')}</button>
    <p class="se-kicker">${icon('flag')}<span>${L`シーズンは終わりました`}</span></p>
    <h2 id="se-title" class="se-line">${m.winners.map(f => crest(f, 34))}<span>${seasonEndLine(m)}</span></h2>
    <ol class="se-area" aria-label="${L`国ごとの州の数`}">${m.area.map((n, f) => html`<li class="kh-n${f}${m.winners.includes(f) ? ' se-win' : ''}">${crest(f, 22)}<span class="se-name">${factionName(f)}</span><strong class="num">${fmtNum(n)}</strong></li>`)}</ol>
    <p class="se-note">${m.source === 'pool' ? L`賞金プールの集計（Tally と Finalize）がチェーンで確定しました。州の数はチェーンの記録を数えたものです。` : L`最終の順位の記録が確定しました。州の数はチェーンの記録を数えたものです。`}${m.mine ? html` <strong>${L`あなたの国の勝利です。`}</strong>` : ''}</p>
    <div class="se-acts"><button type="button" class="btn primary" data-act="se-go">${icon('list')}${L`結果と賞金を見る`}</button></div>
  </section>`;
}
