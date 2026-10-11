// The guide on a conquest season (program version 3): seven steps from the
// first village to a province taken, each ticked from the records the page
// holds and from nothing else —
//   1 the first village      the viewer's Holding
//   2 build                  the Holding's queue or its production above the base
//   3 train                  troops in the reserve, or a combat host
//   4 form a host            a combat host of the viewer in a province record
//   5 march on a keep        a march of the viewer to a province whose keep another nation holds, or
//                            a host of the viewer standing on such a keep's tile
//   6 hold it for 72 turns   that keep's record names the viewer's nation as the contender: its count
//   7 the capture            a capture record (keep_taken) to the viewer's nation, or the keep's holder
//                            is now the viewer's nation after its contest
// One "next thing" at a time (UX design 7.4, 11.11): the current step's sentence and its one press, which
// opens the thing the step needs (the village's card, the host's list of keeps, the keep).
import { html, raw } from '../../util.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { factionName } from '../fi18n.mjs';
import { activeHolding } from '../fstate.mjs';
import { SCOUT, SETTLER } from '../fland.mjs';
import { factsOf, hasBuilt } from '../onboarding.mjs';
import { icon } from '../hud/icons.mjs';
import { conquestOn, holdTurns, hostWaits, waitOf, waitText } from '../hud/keephand.mjs';
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
  const revealed = (FS.marches ?? []).map(m => (m.dest ? keeps.find(k => k.p === m.dest.p && k.q === m.dest.q && foreign(k)) ?? null : null)).find(Boolean) ?? null;
  const sealed = (FS.orders ?? []).map(o => (o?.kind === 'march' && o.dest ? keeps.find(k => k.p === o.dest.p && k.q === o.dest.q && k.tile === o.dest.tile) ?? null : null)).find(Boolean) ?? null;
  // the contest the viewer's nation runs: the keep its host stands on first, else any keep its nation is the contender of
  const mine = k => int(f) && k.contender === f;
  const contest = [standing, revealed, sealed, ...keeps].find(k => k && mine(k)) ?? null;
  const gain = (FS.conquest?.events ?? []).filter(e => e.kind === 'keep_taken' && e.to === f).at(-1) ?? null;
  const target = contest ?? standing ?? revealed ?? sealed ?? null;
  return { village: !!h, built: !!h && (hasBuilt(h, now) || (h.queue ?? []).some(q => q && q.kind === 1)), trained: !!base.trainedCombat, host: !!base.ownCombatHost || rows.length > 0,
    marched: !!(standing || revealed || sealed || contest || gain),
    holding: contest ? { p: contest.p, q: contest.q, progress: Math.max(0, Number(contest.progress ?? 0)), required: holdTurns(FS, contest) } : null,
    captured: gain ? { p: gain.p, q: gain.q, turn: gain.bell } : null, target: target ? { p: target.p, q: target.q } : gain ? { p: gain.p, q: gain.q } : null };
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
  else if (id === 'train') { text = L`「訓練」で兵を雇います。訓練はすぐに終わり、兵は村の控えに入ります。`; go = { act: 'cg-go', data: { pop: 'train' }, label: L`訓練する兵を選ぶ` }; }
  else if (id === 'muster') { text = L`「編成」で控えの兵を軍勢にします。軍勢は、記録に現れたターンから動かせます。`; go = { act: 'cg-go', data: { pop: 'muster' }, label: L`軍勢を編成する` }; }
  else if (id === 'march') {
    let rows = [];
    try { rows = hostRows(FS).filter(r => r.unit !== SCOUT && r.unit !== SETTLER); } catch { rows = []; }
    const ready = rows.find(r => !waitOf(FS, r)) ?? null, wait = ready ? null : hostWaits(FS)[0] ?? null;
    text = ready ? L`軍勢を選び、「砦へ進軍」で届く他国の砦を選びます。命令に封をして出発すると、到着のターンに戦いが決まります。`
      : wait ? waitText(wait) : L`軍勢を選び、「砦へ進軍」で届く他国の砦を選びます。`;
    go = ready ? { act: 'cg-go', data: { pop: 'keeps', host: String(ready.id) }, label: L`届く砦を見る` } : { act: 'tab', data: { tab: 'hosts' }, label: L`軍勢の準備を確かめる` };
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
