// The guide on a conquest season (program version 3): seven steps from the
// first village to a province taken, each ticked from the records the page
// holds and from nothing else —
//   1 the first village      the viewer's Holding
//   2 build                  the Holding's queue or its production above the base
//   3 train                  troops in the reserve, or a combat host
//   4 form a host            a combat host of the viewer in a province record
//   5 march on a keep        a march of the viewer to a province whose keep another nation holds, or
//                            a host of the viewer standing on such a keep's tile; a march whose turn is
//                            resolved with no host left on the tile and no contest is turned back, and
//                            the step is current again (it says so, and what the keeps take)
//   6 hold it for 72 turns   that keep's record names the viewer's nation as the contender, the keep being one the
//                            viewer's own host stands on or own march is bound for: its count
//   7 the capture            a capture record (keep_taken) to the viewer's nation, or the keep's holder
//                            is now the viewer's nation after its contest
// One "next thing" at a time (UX design 7.4, 11.11): the current step's sentence and its one press, which
// opens the thing the step needs (the village's card, the host's list of keeps, the keep).
import { html, raw } from '../../util.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { factionName, unitCount } from '../fi18n.mjs';
import { activeHolding } from '../fstate.mjs';
import { SCOUT, SETTLER, UNIT_ORDER } from '../fland.mjs';
import { factsOf, hasBuilt } from '../onboarding.mjs';
import { icon } from '../hud/icons.mjs';
import { conquestOn, holdTurns, hostWaits, waitOf, waitText, keepsModel, arrivalOdds, roughAt } from '../hud/keephand.mjs';
import { keepArrival } from '../hud/rulebook.mjs';
import { provinceName } from '../hud/place.mjs';
import { hostRows } from './host.mjs';
import { cardHead } from './parts.mjs';

export const CONQUEST_STEPS = Object.freeze(['village', 'build', 'train', 'muster', 'march', 'hold', 'capture']);
const int = Number.isInteger;

const keepsOf = FS => (FS.conquest?.keeps instanceof Map ? [...FS.conquest.keeps.values()] : []);

/**
 * What the records say of the viewer on the way to a province: `{village, built, trained, host, marched, holding:
 * {p, q, progress, required} | null, captured: {p, q, turn} | null, target: {p, q} | null}`.
 */
export function conquestFacts(FS) {
  const f = FS.citizen?.faction, h = activeHolding(FS) ?? null, now = FS.chain?.now?.() ?? 0;
  let base = { trainedCombat: false, ownCombatHost: false };
  try { base = factsOf(FS); } catch { /* a page without its records yet */ }
  let rows = [];
  try { rows = hostRows(FS).filter(r => r.unit !== SCOUT && r.unit !== SETTLER); } catch { rows = []; }
  const keeps = keepsOf(FS);
  const foreign = k => int(k.holder) && k.holder !== f && !k.heartland;
  // a host of the viewer on a keep's tile (the province record), a march revealed toward a keep's province, or the order this page sealed
  const standing = rows.map(r => keeps.find(k => k.p === r.p && k.q === r.q && k.tile === r.tile && (r.state === 1 || r.state === 3)) ?? null).find(Boolean) ?? null;
  // a march whose turn has been resolved while no host of the viewer stands on that keep's tile and its nation runs no
  // contest there was turned back (the first turn decides it): it no longer counts as "marched" — the guide goes back
  // to the march and says so (seen in the UI check of 2026-10-26: a first march of 100 spearmen on a keep of 100 was
  // pushed home, and the guide kept saying "hold the keep's tile for 72 turns" until the march was settled)
  const keepOf = m => (m?.dest ? keeps.find(k => k.p === m.dest.p && k.q === m.dest.q && foreign(k)) ?? null : null);
  const turnedBack = m => {
    const k = keepOf(m);
    return !!k && m.facts?.pipeline === 'resolved' && !(standing && standing.p === k.p && standing.q === k.q) && !(int(f) && k.contender === f);
  };
  const live = (FS.marches ?? []).filter(m => !turnedBack(m));
  const back = (FS.marches ?? []).find(turnedBack) ?? null;
  const repelled = back ? { p: back.dest.p, q: back.dest.q, bell: back.entry?.arriveBell ?? back.transit?.arriveBell ?? null } : null;
  const revealed = live.map(keepOf).find(Boolean) ?? null;
  const sealed = (FS.orders ?? []).map(o => (o?.kind === 'march' && o.dest ? keeps.find(k => k.p === o.dest.p && k.q === o.dest.q && k.tile === o.dest.tile) ?? null : null))
    .find(k => k && !(repelled && repelled.p === k.p && repelled.q === k.q)) ?? null;
  // the contest the viewer is part of: its nation is the contender of the keep the viewer's own host stands on, or the
  // viewer's own march is bound for. Not any keep its nation contends: in a world with others in the nation (people or
  // bots) one of them is nearly always holding a keep somewhere, and a newcomer who had not even formed a host — or
  // whose own march was turned back — read "hold the keep's tile for 72 turns" (the live check of 2026-10-26)
  const mine = k => int(f) && k.contender === f;
  const contest = [standing, revealed, sealed].find(k => k && mine(k)) ?? null;
  const gain = (FS.conquest?.events ?? []).filter(e => e.kind === 'keep_taken' && e.to === f).at(-1) ?? null;
  const target = contest ?? standing ?? revealed ?? sealed ?? null;
  return { village: !!h, built: !!h && (hasBuilt(h, now) || (h.queue ?? []).some(q => q && q.kind === 1)), trained: !!base.trainedCombat, host: !!base.ownCombatHost || rows.length > 0,
    marched: !!(standing || revealed || sealed || contest || gain),
    holding: contest ? { p: contest.p, q: contest.q, progress: Math.max(0, Number(contest.progress ?? 0)), required: holdTurns(FS, contest) } : null,
    captured: gain ? { p: gain.p, q: gain.q, turn: gain.bell } : null, target: target ? { p: target.p, q: target.q } : gain ? { p: gain.p, q: gain.q } : null,
    repelled: contest || standing ? null : repelled };
}

/**
 * The usual keep of another nation (outside its holder's heartland, defenders known): one with the defender count
 * most keeps have, the larger on a tie — not the weakest, which may stand anywhere on the map after a fight and out
 * of every host's reach (the live check of 2026-10-26: one keep worn down elsewhere made the guide say a host of 100
 * could go, while every keep in its reach had 100 defenders). `{p, q, tile, troops, need}` — `need` the Spearmen that
 * hold its tile on the arrival turn even at the worst luck (rulebook.mjs keepArrival; the tile counted rough unless
 * its terrain says otherwise). Null without one.
 */
export function keepTarget(FS) {
  const f = FS.citizen?.faction;
  const ks = keepsOf(FS).filter(k => int(k.holder) && k.holder !== f && !k.heartland && Number.isFinite(Number(k.troops)));
  if (!ks.length) return null;
  const count = new Map();
  for (const k of ks) count.set(Number(k.troops), (count.get(Number(k.troops)) ?? 0) + 1);
  const usual = [...count.entries()].reduce((a, b) => (b[1] > a[1] || (b[1] === a[1] && b[0] > a[0]) ? b : a))[0];
  const k = ks.find(x => Number(x.troops) === usual);
  const o = keepArrival({ unit: 0, troops: 100, keepTroops: Number(k.troops), rough: roughAt(FS, k.p, k.q, k.tile) });
  return { p: k.p, q: k.q, tile: k.tile, troops: Number(k.troops), need: o.need };
}

/** The best the ready host `r` could do among the keeps its card lists (or, before the card has been read, the usual keep: `keepTarget`): `{odds, need, troops}` or null. */
function bestOdds(FS, r) {
  let rows = [];
  try { const km = keepsModel(FS, r); rows = km.state === 'ready' ? km.rows.filter(x => x.odds) : []; } catch { rows = []; }
  const rank = { good: 2, even: 1, poor: 0 };
  if (rows.length) {
    const x = rows.reduce((a, b) => (rank[b.odds.odds] > rank[a.odds.odds] || (rank[b.odds.odds] === rank[a.odds.odds] && b.troops < a.troops) ? b : a));
    return { odds: x.odds.odds, need: x.odds.need, troops: x.troops };
  }
  const t = keepTarget(FS);
  if (!t) return null;
  const o = arrivalOdds(FS, r, t);
  return o ? { odds: o.odds, need: o.need, troops: t.troops } : null;
}

const TITLE = {
  village: () => L`最初の村`, build: () => L`建物を建てる`, train: () => L`兵を訓練する`, muster: () => L`軍勢を編成する`,
  march: () => L`砦へ進軍する`, hold: hold => L`砦のマスを ${fmtNum(hold)} ターン保つ`, capture: () => L`州を奪う`,
};

/**
 * The guide's state: `{steps: [{id, title, status: 'done' | 'current' | 'todo'}], current (an id, or 'done'), n, total,
 * facts}`. A later step that the records already show is ticked whatever came before it (a capture is a capture).
 */
export function conquestGuide(FS) {
  if (!conquestOn(FS)) return null;
  const x = conquestFacts(FS), hold = holdTurns(FS);
  const captured = !!x.captured;
  const done = { village: x.village, build: x.built || x.trained || x.host, train: x.trained || x.host, muster: x.host || x.marched, march: x.marched, hold: captured, capture: captured };
  // the step that is next is the one after the furthest the records show (a player who has marched is not sent back to
  // "build" because the village's queue is empty): what lies before it and is not in the records now reads as passed
  const reach = CONQUEST_STEPS.reduce((a, id, i) => (done[id] ? i : a), -1);
  const current = CONQUEST_STEPS.find((id, i) => i > reach && !done[id]) ?? 'done';
  return { steps: CONQUEST_STEPS.map((id, i) => ({ id, title: TITLE[id](hold), status: done[id] || i < reach ? 'done' : id === current ? 'current' : 'todo' })), current, n: Math.max(0, reach + 1), total: CONQUEST_STEPS.length, facts: x };
}

/** The current step as the one "next thing": `{id, n, total, title, text, go: {act, data, label} | null}`; null when every step is done. */
export function conquestObjective(FS) {
  const g = conquestGuide(FS);
  if (!g || g.current === 'done') return null;
  const x = g.facts, hold = holdTurns(FS), id = g.current;
  const title = TITLE[id](hold);
  let text = '', go = null;
  if (id === 'village') { text = L`国を選ぶと、最初の村が自動で置かれます。`; go = { act: 'join-open', data: {}, label: L`国を選ぶ` }; }
  else if (id === 'build') { text = L`村を選び、「建てる」から最初の建物を選びます。建物は毎時の産出を増やします。`; go = { act: 'cg-go', data: { pop: 'build' }, label: L`建設をひらく` }; }
  else if (id === 'train' || id === 'muster') {
    // what a keep takes, said before the host is formed (the UI check of 2026-10-26: the guide's first march, a host of
    // the first 100 spearmen, met a keep of 100 defenders behind walls and was turned back)
    const t = keepTarget(FS);
    const aim = t?.need ? L`砦を攻めるなら、${unitCount(UNIT_ORDER[0], t.need)} 以上を一つの軍勢にまとめると、守備兵 ${fmtNum(t.troops)} の砦に着いたターンに勝てる見込みです。` : '';
    if (id === 'train') { text = L`「訓練」で兵を雇います。訓練はすぐに終わり、兵は村の控えに入ります。${aim}`; go = { act: 'cg-go', data: { pop: 'train' }, label: L`訓練する兵を選ぶ` }; }
    else { text = L`「編成」で控えの兵を軍勢にします。軍勢は、記録に現れたターンから動かせます。${aim}`; go = { act: 'cg-go', data: { pop: 'muster' }, label: L`軍勢を編成する` }; }
  } else if (id === 'march') {
    let rows = [];
    try { rows = hostRows(FS).filter(r => r.unit !== SCOUT && r.unit !== SETTLER); } catch { rows = []; }
    const ready = rows.find(r => !waitOf(FS, r)) ?? null, wait = ready ? null : hostWaits(FS)[0] ?? null;
    const back = x.repelled ? L`前の進軍は${provinceName(FS, x.repelled.p, x.repelled.q, { own: false })}の砦のマスに残れず、村へ押し戻されました。` : '';
    const best = ready ? bestOdds(FS, ready) : null;
    if (ready && best && best.odds !== 'good') {
      // the host as it stands would most likely be turned back: say so, and how many it takes, before it goes
      const who = unitCount(UNIT_ORDER[ready.unit], Math.floor(Number(ready.troops)));
      const chance = best.odds === 'even' ? L`勝ち目は五分です。` : L`勝ち目は低いです。`;
      const need = best.need ? L`${unitCount(UNIT_ORDER[ready.unit], best.need)} ほどにしてから進軍すると、運が悪くても砦のマスに残れます。` : '';
      text = L`${back}いまの軍勢（${who}）で届く砦（守備兵 ${fmtNum(best.troops)}、城壁あり）を攻めると、${chance}${need}訓練で兵を足し、今の軍勢を解散して控えに戻してから（次のターンに戻ります）、まとめて編成し直します。`;
      go = { act: 'cg-go', data: { pop: 'train' }, label: L`兵を足す` };
    } else {
      text = ready ? L`${back}軍勢を選び、「砦へ進軍」で届く他国の砦を選びます。勝ち目の欄が「十分」の砦を選ぶと、着いたターンに砦のマスに残れる見込みです。命令に封をして出発すると、到着のターンに戦いが決まります。`
        : wait ? back + waitText(wait) : L`${back}軍勢を選び、「砦へ進軍」で届く他国の砦を選びます。`;
      go = ready ? { act: 'cg-go', data: { pop: 'keeps', host: String(ready.id) }, label: L`届く砦を見る` } : { act: 'tab', data: { tab: 'hosts' }, label: L`軍勢の準備を確かめる` };
    }
  } else {
    // hold, then the capture: the count is the keep's own record
    const k = x.holding;
    text = k ? L`${provinceName(FS, k.p, k.q, { own: false })}の砦のマスを、あなたの国が ${fmtNum(k.progress)} / ${fmtNum(k.required)} ターン保っています。${fmtNum(k.required)} ターン続けて保つと、州はあなたの国のものになります。`
      : L`進軍が砦のマスに着いて勝つと、占拠のターンが数えられます。${fmtNum(hold)} ターン続けて保つと、州はあなたの国のものになります。`;
    go = x.target ? { act: 'goto', data: { p: x.target.p, q: x.target.q }, label: L`砦を見る` } : { act: 'tab', data: { tab: 'marches' }, label: L`進軍を見る` };
  }
  return { id, n: g.n, total: g.total, title, text, go };
}

const attrs = d => raw(Object.entries(d ?? {}).map(([k, v]) => `data-${String(k).replace(/[^\w-]/g, '')}="${String(v).replace(/[^\w.,:-]/g, '')}"`).join(' '));

/** The guide's drawer on a conquest season: the seven steps as a checklist, the current one with its sentence and its press. */
export function renderConquestGuide(FS, { open = true } = {}) {
  const g = conquestGuide(FS);
  if (!g) return '';
  const o = conquestObjective(FS);
  const item = s => html`<li class="${s.status === 'done' ? 'done' : s.status === 'current' ? 'now' : ''}" ${raw(s.status === 'current' ? 'aria-current="step"' : '')}><span class="ck-mark" aria-hidden="true">${s.status === 'done' ? icon('check') : ''}</span><span class="ck-name">${s.title}</span>${s.status === 'done' ? html` <span class="visually-hidden">${L`（${L`済み`}）`}</span>` : s.status === 'current' ? html` <span class="visually-hidden">${L`（${L`いま`}）`}</span>` : ''}</li>`;
  const cap = g.facts.captured;
  const body = html`${o ? html`<p>${o.text}</p>${o.go ? html`<div class="actions"><button type="button" class="btn primary" data-act="${o.go.act}" ${attrs(o.go.data)}>${o.go.label}</button></div>` : ''}`
      : html`<p>${cap ? L`第${fmtNum(cap.turn)}ターンに、あなたの国（${factionName(FS.citizen?.faction)}）が州 ${cap.p},${cap.q} を奪いました。シーズンの終わりに、支配する州が最も多い国が勝ちます。` : L`シーズンの終わりに、支配する州が最も多い国が勝ちます。`}</p>`}
    <ol class="checklist">${g.steps.map(item)}</ol>
    <div class="actions ck-foot"><button type="button" class="btn small quiet" data-act="ob-dismiss">${L`ガイドを閉じる`}</button></div>`;
  const head = o ? L`ガイド ${o.n}/${o.total}：${o.title}` : L`ガイド：州を奪いました`;
  if (!open) return html`<details class="callout onboarding"><summary>${head}</summary>${body}</details>`;
  return html`<section class="vcard onboarding" aria-labelledby="ob-title">${cardHead({ id: 'ob-title', ic: 'compass', title: head })}${body}</section>`;
}
