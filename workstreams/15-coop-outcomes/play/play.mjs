// The playable comparison: you take one participant through a fixed story;
// at four bells you pick one of the options the evaluator offers you, and
// the same events are judged under A, B and C side by side. The others act
// from the scenario's script. Uses the evaluator's own modules unchanged.
import { evaluate } from '../src/evaluate.mjs';
import { RULESETS } from '../src/rulesets.mjs';
import { REASONS } from '../src/contract.mjs';

const STORIES = {
  'coop-north-fort': '協力の基本形（n1 が砦を開き、n2・n3 が送る）',
  'chapter-no-sabotage': '要塞が動く戦期（50 で n1 が逆転、300 で n0 が再逆転）',
  'rush-clients-own': '先行する n0 が、従う2国と砦を急ぐ',
  'coop-with-tower': '⑭の塔の入力つき',
};
const STOPS = [30, 60, 90, 130];
const LABEL = {
  wait: '待つ', contribute: '計画に材料を送る', 'open-project': '共同の計画を自分で開く', 'build-own': '自分の柵を建てる',
  'contest-keeps': '要塞を取りに行く', raid: '移動中の他国の隊商を襲う', 'obstruct-project': '他国の計画を妨げる',
  'use-foreign-structure': '他国の建物を使う（守備に入る）', 'report-sighting': '塔で見たことを知らせる', 'move-nation': '国を移る',
};
/** Options this page can turn into events; the rest belong to the game itself. */
const PLAYABLE = new Set(['wait', 'contribute', 'build-own', 'raid', 'use-foreign-structure', 'report-sighting']);
const STATUS = { achieved: '達成', not_achieved: '未達', indeterminate: '判定できない', not_offered: '出さない', not_awarded: '枠が重複' };

const $ = s => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v === null || v === undefined) continue; else if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v);
  for (const k of kids.flat()) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
};

let game = null;

async function load(name) {
  const r = await fetch(`../scenarios/${name}.json`);
  return r.json();
}

async function start() {
  const name = $('#story').value;
  const base = await load(name);
  const me = $('#actor').value;
  game = { name, base, me, extra: [], seq: 0, stop: 0, log: [] };
  game.base.state.streams = { ...game.base.state.streams, play: { from: 0 } };
  render();
}

const input = () => ({ state: game.base.state, events: [...game.base.events, ...game.extra] });
const add = (at, kind, fields) => { game.extra.push({ id: `play:${game.seq}`, stream: 'play', seq: game.seq++, at, kind, verified: 'chain', ...fields }); };

/** Turns the picked option into events at bell `t` (labelled in the log). */
function act(o, t, v) {
  const me = game.me;
  if (o.kind === 'contribute') {
    const lots = game.base.state.lots.filter(l => l.owner === me && o.resources.includes(l.resource));
    const l = lots[0];
    const qty = Math.min(100, l.qty);
    add(t, 'ship.send', { ship: `play-${game.seq}`, from: me, to: `project:${o.project}`, resource: l.resource, qty, lot: l.lot });
    add(t + 5, 'ship.arrive', { ship: `play-${game.seq - 1}`, qty });
    return `${o.project} に ${l.resource} ${qty} を送った（${t + 5} に着く）`;
  }
  if (o.kind === 'build-own') {
    const p = `play-pal-${game.seq}`;
    add(t, 'project.open', { project: p, goal: 'own', structure: 'palisade', steward: me });
    for (const [r, q] of [['wood', 200], ['stone', 100], ['gold', 20]]) add(t, 'contribute', { project: p, actor: me, lot: `init:${me}:${r}`, qty: q });
    add(t + 2, 'build.complete', { project: p, structure: `S-${p}` });
    const other = game.base.state.actors.find(a => a.nation && a.nation !== v.options.byActor[me].nation);
    add(t + 4, 'use', { structure: `S-${p}`, actor: other.id, how: 'pass' });
    return `自分の柵を建てた（台本：${other.id} が ${t + 4} に通る）`;
  }
  if (o.kind === 'raid') {
    const ship = o.ships[0];
    const sent = [...game.base.events, ...game.extra].find(e => e.kind === 'ship.send' && e.ship === ship);
    // The ship's own arrival is dropped: it never arrives.
    game.base.events = game.base.events.filter(e => !(e.kind === 'ship.arrive' && e.ship === ship));
    renumber();
    add(t, 'ship.raid', { ship, raider: me, taken: sent.qty, burned: 0 });
    return `${ship}（${sent.resource} ${sent.qty}）を奪った`;
  }
  if (o.kind === 'use-foreign-structure') {
    add(t, 'use', { structure: o.structures[0], actor: me, how: 'garrison', qty: 100 });
    return `${o.structures[0]} の守備に入った`;
  }
  if (o.kind === 'report-sighting') {
    const sg = `play-sg-${game.seq}`;
    add(t, 'tower.sighting', { sighting: sg, tower: 'T-east', actor: me });
    const other = game.base.state.actors.find(a => a.id !== me && a.nation);
    add(t + 1, 'tower.report.used', { sighting: sg, actor: other.id });
    return `塔の目撃を知らせた（台本：${other.id} が使う）`;
  }
  return '待った';
}

/** The base script's streams renumbered after an event was taken out (it never happened). */
function renumber() {
  const next = {};
  const sorted = [...game.base.events].sort((a, b) => (a.stream < b.stream ? -1 : a.stream > b.stream ? 1 : a.seq - b.seq));
  for (const e of sorted) { e.seq = next[e.stream] ?? 0; next[e.stream] = e.seq + 1; }
}

function pick(o) {
  const t = STOPS[game.stop];
  const v = evaluate(RULESETS.B, input(), { asOf: t });
  game.log.push(`${t}: ${act(o, t, v)}`);
  game.stop++;
  render();
}

function reasonList(rs) {
  return el('ul', { class: 'reasons' }, (rs ?? []).map(r => el('li', {}, el('code', {}, r.code), ' ', REASONS[r.code] ?? '')));
}

function verdictCard(k, v) {
  const j = v.achievements.joint[0];
  const mine = v.awards.filter(a => a.beneficiary === game.me || a.beneficiary === v.options.byActor[game.me]?.nation);
  return el('section', { class: 'card', 'data-variant': k },
    el('h3', {}, `${k} ${RULESETS[k].note}`),
    el('dl', {},
      el('dt', {}, '戦期の終わり'), el('dd', {}, `${v.period.closeAt}（${v.period.closedBy === 'schedule' ? '予定どおり' : '共同達成で区切り'}）`),
      el('dt', {}, '賞金を受け取る国'), el('dd', { class: 'winners' }, `${v.prize.winners.join('・')}（${v.prize.rule}）`),
      el('dt', {}, '共同目標'), el('dd', {}, j ? `${STATUS[j.status]}${j.achievedAt !== null ? `（${j.achievedAt}）` : ''}` : '判定しない'),
      el('dt', {}, 'あなた（と国）の記録'), el('dd', {}, mine.length ? mine.map(a => a.goal).join('、') : 'なし'),
    ),
    j ? el('details', {}, el('summary', {}, '共同目標の理由'), reasonList(j.reasons)) : '',
    v.period.closedBy !== 'schedule' ? el('details', {}, el('summary', {}, '区切りで終わるもの・続くもの'),
      el('p', {}, '終わる：'), el('ul', {}, v.period.scope.ends.map(s => el('li', {}, s))),
      el('p', {}, '続く：'), el('ul', {}, v.period.scope.continues.map(s => el('li', {}, s)))) : '');
}

function render() {
  const main = $('#main');
  main.replaceChildren();
  if (!game) return;
  main.append(el('p', { class: 'log' }, game.log.length ? game.log.join(' / ') : 'まだ何もしていない'));
  if (game.stop < STOPS.length) {
    const t = STOPS[game.stop];
    const v = evaluate(RULESETS.B, input(), { asOf: t });
    const mine = v.options.byActor[game.me];
    main.append(el('h2', {}, `鐘 ${t}：${game.me}（${mine?.nation ?? '無所属'}）の番`),
      el('div', { class: 'choices' }, (mine?.options ?? []).map(o => {
        const ok = PLAYABLE.has(o.kind);
        return el('button', { type: 'button', class: o.category, disabled: ok ? null : '', 'data-kind': o.kind, title: ok ? '' : 'この試作では動かせない（本体のゲームの操作）', onclick: () => pick(o) },
          LABEL[o.kind] ?? o.kind, o.project ? `：${o.project}` : '', el('small', {}, ` ${o.category}${o.goal ? ` → ${o.goal}` : ''}`));
      })));
  } else main.append(el('h2', {}, '結果（同じ出来事を3つのルールで判定）'));
  const vs = Object.fromEntries(['A', 'B', 'C'].map(k => [k, evaluate(RULESETS[k], input())]));
  main.append(el('div', { class: 'cards' }, Object.entries(vs).map(([k, v]) => verdictCard(k, v))));
  main.append(el('p', { class: 'hash' }, Object.entries(vs).map(([k, v]) => `${k}: ${v.verdictHash.slice(0, 12)}`).join('  ')));
}

function init() {
  $('#story').replaceChildren(...Object.entries(STORIES).map(([k, v]) => el('option', { value: k }, v)));
  $('#start').addEventListener('click', start);
  window.__ws15 = { get game() { return game; } };
}
init();
