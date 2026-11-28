// The walletless demo's goal card, castle flags and result screen (owner r0ze 2026-11-28 14:32, Option A: the real
// flag-keeps win condition, compressed — screens/demogoal.mjs). Bundled into the page (src/page-app.mjs), so it shares
// the page's language and map; it reads the in-page world directly (`__wyllsDemo.world()` → `goal()`, the record GET
// /h/demo/goal also answers): no request, nothing signed, nothing the page's own code depends on.
//
//   the card    top left, under the demo tag: the goal in one line, the player's captured castles with their hold
//               timers, every castle (holder, timer, "march here" while a march is being composed), the rival's progress
//               and the next AI wave. Folds to one line (phones start folded).
//   the flags   a pennant over each castle on the map, in its holder's colour, with the hold timer while it counts.
//   the result  when a nation reaches the goal: won / lost, the time it took, "Play again" (the demo's Start over without
//               the question) and "Keep looking".
import { lang } from '../../../permutation-server/web/lang.mjs';
import { CIV_NAMES } from '../../../permutation-server/web/i18n.mjs';
import { NATION_FILL, NATION_DARK, NATION_ON } from '../../../permutation-server/web/frontier/palette.mjs';
import { FrontierMap } from '../../../permutation-server/web/frontier/map/fmap.mjs';
import { tileHex } from '../../../permutation-server/web/frontier/fgeo.mjs';
import { project } from '../../../permutation-server/web/map.mjs';

const KEYS = ['Aster', 'Borealis', 'Cinder', 'Dunmar', 'Ember', 'Fjordal'];
const nationName = n => (Number.isInteger(n) && n >= 0 && n < 6 ? CIV_NAMES[KEYS[n]] : '—');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The card's words, English and Japanese (never "season": the world is continuous). */
export const TEXT = {
  en: {
    title: 'Goal: the flag castles',
    rule: (need, hold) => `Hold ${need} flag castles of other nations, each for ${hold} turns. Your own nation's castle does not count.`,
    pick: (need, hold) => `Pick a nation to start. To win, hold ${need} flag castles of other nations for ${hold} turns each, before a rival nation does.`,
    yours: (k, need) => `Your captured castles: ${k} / ${need}`,
    castle: n => `${n}'s castle`,
    held: h => `held by ${h}`,
    nobody: 'held by nobody',
    you: 'you',
    timer: (t, hold) => `${t}/${hold} turns`,
    done: 'held long ✓',
    own: 'your nation’s (does not count)',
    march: 'March here',
    howto: 'To attack: Hosts → march a host, then press "March here" on a castle.',
    rival: (n, k, need, left) => `Rival ${n}: ${k}/${need}${left !== null ? ` — wins in ${left} turns if nothing changes` : ''}`,
    others: 'Other nations',
    wave: (t, troops) => `Next AI attack wave in ${t} turns (about ${troops} troops a host)`,
    late: every => `The AI waves now come every ${every} turns and grow faster each time.`,
    fold: 'Fold', unfold: 'Show',
    won: 'Victory', lost: 'Defeat',
    wonText: (need, hold) => `Your nation held ${need} rival flag castles for ${hold} turns each.`,
    lostText: (who, need, hold) => `${who} held ${need} flag castles for ${hold} turns each before you did.`,
    time: (real, turns, clock) => `Time: ${real} (${turns} turns, ${clock} on the demo clock)`,
    again: 'Play again', look: 'Keep looking',
    mins: (m, s) => `${m} min ${String(s).padStart(2, '0')} s`, hours: (h, m) => (h ? `${h} h ${m} min` : `${m} min`),
    pill: (k, need) => `Castles ${k}/${need}`,
    result: s => (s === 'won' ? 'You won — Play again' : 'You lost — Play again'),
  },
  ja: {
    title: '目標：旗の城',
    rule: (need, hold) => `ほかの国の旗の城を${need}つ、それぞれ${hold}ターン守り続けると勝ちです。自分の国の城は数えません。`,
    pick: (need, hold) => `国を選ぶと始まります。ほかの国より先に、ほかの国の旗の城を${need}つ、それぞれ${hold}ターン守り続けると勝ちです。`,
    yours: (k, need) => `取った城：${k} / ${need}`,
    castle: n => `${n}の城`,
    held: h => `${h}が保持`,
    nobody: '保持する国なし',
    you: 'あなた',
    timer: (t, hold) => `${t}/${hold}ターン`,
    done: '守り切った ✓',
    own: '自分の国の城（数えない）',
    march: 'ここへ進軍',
    howto: '攻めるには：軍勢 → 進軍を開き、城の「ここへ進軍」を押します。',
    rival: (n, k, need, left) => `ライバル ${n}：${k}/${need}${left !== null ? `（このままだと${left}ターン後に勝利）` : ''}`,
    others: 'ほかの国',
    wave: (t, troops) => `次の AI の攻撃の波まで ${t} ターン（1軍勢 約${troops}兵）`,
    late: every => `AI の波は ${every} ターンごとになり、毎回より大きくなります。`,
    fold: 'たたむ', unfold: 'ひらく',
    won: '勝利', lost: '敗北',
    wonText: (need, hold) => `あなたの国が、ほかの国の旗の城を${need}つ、それぞれ${hold}ターン守り切りました。`,
    lostText: (who, need, hold) => `${who}が先に、旗の城を${need}つ、それぞれ${hold}ターン守り切りました。`,
    time: (real, turns, clock) => `かかった時間：${real}（${turns}ターン、体験版の時計で${clock}）`,
    again: 'もう一度遊ぶ', look: 'このまま見る',
    mins: (m, s) => `${m}分${String(s).padStart(2, '0')}秒`, hours: (h, m) => (h ? `${h}時間${m}分` : `${m}分`),
    pill: (k, need) => `城 ${k}/${need}`,
    result: s => (s === 'won' ? '勝利 — もう一度遊ぶ' : '敗北 — もう一度遊ぶ'),
  },
};
const T = () => TEXT[lang() === 'en' ? 'en' : 'ja'];

/** How long a game took: real time at the demo's turn length, turns, and the demo clock (10 game minutes a turn). */
export function elapsed(turns, turnSecs, t = T()) {
  const real = Math.round(turns * turnSecs), clock = turns * 10;
  return { real: t.mins(Math.floor(real / 60), real % 60), turns, clock: t.hours(Math.floor(clock / 60), clock % 60) };
}

/** The card's model from the goal record: pure (tests read it). */
export function cardModel(g) {
  const posted = g.posted !== null && g.posted !== undefined;
  const me = posted ? g.progress.find(x => x.nation === g.player) : null;
  const castles = g.castles.map(c => {
    const p = posted && c.holder !== null ? g.progress.find(x => x.nation === c.holder)?.castles.find(k => k.p === c.p && k.q === c.q && k.tile === c.tile) : null;
    return { ...c, counting: !!p, held: p ? Math.max(0, Math.min(g.rules.holdBells, g.turn - p.from)) : null, long: p ? p.longAt <= g.turn : false };
  });
  const rivals = posted ? g.progress.filter(x => x.nation !== g.player && x.captured > 0)
    .map(x => ({ nation: x.nation, captured: x.captured, left: x.reachAt !== null ? Math.max(0, x.reachAt - g.turn) : null, leader: x.nation === g.leader }))
    .sort((a, b) => (a.left ?? 1e9) - (b.left ?? 1e9) || b.captured - a.captured) : [];
  return { posted, need: g.need, hold: g.rules.holdBells, captured: me?.captured ?? 0, capturedLong: me?.capturedLong ?? 0, left: me?.reachAt !== null && me?.reachAt !== undefined ? Math.max(0, me.reachAt - g.turn) : null,
    castles, rivals, nextWave: g.nextWave !== null && g.nextWave !== undefined ? Math.max(0, g.nextWave - g.turn) : null, waveTroops: g.waveTroops, late: g.late === true && g.nextWave !== null && g.nextWave !== undefined ? (g.rules.lateEvery ?? null) : null, result: g.result, player: g.player, turnSecs: g.turnSecs, posted_: g.posted };
}

const CSS = `
#demo-goal{position:fixed;left:12px;top:112px;z-index:40;width:310px;max-height:calc(100vh - 260px);overflow:auto;background:rgba(18,38,34,.94);color:#f3ead2;border:1px solid #c9a24a;border-radius:10px;font:13px/1.35 system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.35)}
#demo-goal header{display:flex;align-items:center;gap:6px;padding:7px 10px;border-bottom:1px solid rgba(201,162,74,.4);font-weight:700}
#demo-goal header .dg-pill{margin-left:auto;font-weight:600;color:#ffd24d}
#demo-goal header button{background:none;border:1px solid rgba(243,234,210,.4);color:inherit;border-radius:6px;padding:1px 7px;font:inherit;font-weight:500;cursor:pointer}
#demo-goal .dg-body{padding:7px 10px 9px}
#demo-goal.folded .dg-body{display:none}
#demo-goal p{margin:0 0 6px}
#demo-goal .dg-me{font-weight:700;color:#ffd24d}
#demo-goal ul{list-style:none;margin:4px 0 6px;padding:0}
#demo-goal li{display:flex;align-items:center;gap:6px;padding:2px 0;border-top:1px solid rgba(243,234,210,.12);line-height:1.25}
#demo-goal li .dg-flag{width:12px;height:12px;border-radius:2px;flex:none;border:1px solid rgba(0,0,0,.4)}
#demo-goal li .dg-name{flex:1;min-width:0}
#demo-goal li .dg-sub{font-size:11.5px;opacity:.82}
#demo-goal li .dg-sub::before{content:' · '}
#demo-goal li .dg-bar{display:block;height:4px;background:rgba(243,234,210,.18);border-radius:2px;margin-top:2px}
#demo-goal li .dg-bar i{display:block;height:4px;background:#ffd24d;border-radius:2px}
#demo-goal li.dg-rivalbar .dg-bar i{background:#e0604f}
#demo-goal li button{background:#c9a24a;color:#1a1408;border:0;border-radius:6px;padding:3px 7px;font:inherit;font-size:12px;font-weight:700;cursor:pointer;flex:none}
#demo-goal .dg-rival{color:#ffb4a6;font-weight:600}
#demo-goal .dg-muted{opacity:.8;font-size:12px}
.demo-castle{position:fixed;z-index:2;pointer-events:none;transform:translate(-50%,-100%);display:flex;flex-direction:column;align-items:center;font:700 11px/1 system-ui,sans-serif}
.demo-castle svg{filter:drop-shadow(0 1px 2px rgba(0,0,0,.6))}
.demo-castle span{margin-top:1px;padding:1px 4px;border-radius:4px;background:rgba(18,38,34,.88);color:#ffd24d;white-space:nowrap}
#demo-result{position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:center;background:rgba(8,14,12,.62)}
#demo-result .dr-card{background:#f6efdc;color:#1d2a26;border:2px solid #c9a24a;border-radius:14px;padding:22px 26px;max-width:min(440px,92vw);text-align:center;font:15px/1.45 system-ui,sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.5)}
#demo-result h2{margin:0 0 8px;font-size:30px}
#demo-result.won h2{color:#8a6d00}
#demo-result.lost h2{color:#81242c}
#demo-result .dr-acts{display:flex;gap:10px;justify-content:center;margin-top:14px;flex-wrap:wrap}
#demo-result button{border-radius:8px;padding:9px 16px;font:inherit;font-weight:700;cursor:pointer;border:1px solid #1d2a26;background:#fff}
#demo-result button.primary{background:#1f4d44;color:#fff;border-color:#1f4d44}
@media (max-width:700px){#demo-goal{top:150px;left:8px;width:calc(100vw - 80px);max-height:52vh}#demo-goal.folded{width:auto;max-width:calc(100vw - 80px)}}
`;

function flagSvg(n) {
  const fill = n === null ? '#9a9a92' : NATION_FILL[n], dark = n === null ? '#4a4a44' : NATION_DARK[n];
  return `<svg width="26" height="30" viewBox="0 0 26 30" aria-hidden="true"><rect x="3" y="2" width="2.4" height="27" rx="1" fill="#3a2a10"/><path d="M5.4 3h17l-4 5 4 5h-17z" fill="${fill}" stroke="${dark}" stroke-width="1.2"/><path d="M11 6.2l1.1 2.2 2.4.3-1.7 1.7.4 2.4-2.2-1.2-2.2 1.2.4-2.4-1.7-1.7 2.4-.3z" fill="#ffd24d" stroke="#5a4208" stroke-width=".5"/></svg>`;
}

/** Start the card, the flags and the result screen (once; the page's document). */
export function startGoalHud(doc = globalThis.document) {
  if (!doc || doc.getElementById('demo-goal-style')) return;
  const style = doc.createElement('style');
  style.id = 'demo-goal-style'; style.textContent = CSS;
  doc.head.appendChild(style);
  const card = doc.createElement('section');
  card.id = 'demo-goal'; card.setAttribute('aria-label', 'goal');
  card.hidden = true;
  if (globalThis.matchMedia?.('(max-width: 700px)').matches) card.classList.add('folded');
  doc.body.appendChild(card);
  const flags = doc.createElement('div');
  flags.id = 'demo-castles';
  doc.body.appendChild(flags);
  let map = null, last = null, dismissed = null, html = '';
  // the page's map instance (its draw is patched once to learn it; the flags are drawn over it)
  const P = FrontierMap.prototype, draw = P.draw;
  P.draw = function (...a) { map = this; return draw.apply(this, a); };

  card.addEventListener('click', e => {
    const b = e.target.closest?.('[data-dg]');
    if (!b) return;
    if (b.dataset.dg === 'fold') { card.classList.toggle('folded'); render(true); }
  });
  doc.addEventListener('click', e => {
    const b = e.target.closest?.('[data-dr]');
    if (!b) return;
    if (b.dataset.dr === 'look') { dismissed = last?.result?.bell ?? true; doc.getElementById('demo-result')?.remove(); }
  });

  function render(force = false) {
    const g = last;
    if (!g) { card.hidden = true; return; }
    const t = T(), m = cardModel(g);
    const composing = !!doc.getElementById('mc-title');
    let body;
    if (!m.posted) body = `<p>${esc(t.pick(m.need, m.hold))}</p>`;
    else {
      const items = m.castles.map(c => {
        const holder = c.holder === null ? t.nobody : t.held(c.holder === m.player ? `${nationName(c.holder)} (${t.you})` : nationName(c.holder));
        const sub = c.nation === m.player ? t.own : c.counting ? (c.long ? t.done : t.timer(c.held, m.hold)) : '';
        const bar = c.counting ? `<span class="dg-bar"><i style="width:${Math.round((100 * c.held) / m.hold)}%"></i></span>` : '';
        const mine = c.holder === m.player;
        const go = composing && c.nation !== m.player && !mine ? `<button type="button" data-act="dest-quick" data-p="${c.p}" data-q="${c.q}" data-tile="${c.tile}">${esc(t.march)}</button>` : '';
        return `<li class="${c.counting && !mine ? 'dg-rivalbar' : ''}" data-castle="${c.nation}"><span class="dg-flag" style="background:${c.holder === null ? '#9a9a92' : NATION_FILL[c.holder]}"></span><span class="dg-name">${esc(t.castle(nationName(c.nation)))}<span class="dg-sub">${esc(holder)}${sub ? ` · ${esc(sub)}` : ''}</span>${bar}</span>${go}</li>`;
      }).join('');
      const rivals = m.rivals.slice(0, 3).map(r => `<p class="dg-rival">${esc(t.rival(nationName(r.nation), r.captured, m.need, r.left))}</p>`).join('');
      body = `<p>${esc(t.rule(m.need, m.hold))}</p><p class="dg-me" data-dg-me="${m.captured}">${esc(t.yours(m.captured, m.need))}</p><ul>${items}</ul>${rivals}
        ${m.nextWave !== null ? `<p class="dg-muted">${esc(t.wave(m.nextWave, m.waveTroops))}</p>` : ''}${m.late ? `<p class="dg-muted">${esc(t.late(m.late))}</p>` : ''}${composing ? '' : `<p class="dg-muted">${esc(t.howto)}</p>`}`;
    }
    const folded = card.classList.contains('folded');
    const head = `<header>${flagSvg(m.player ?? null).replace('width="26" height="30"', 'width="16" height="19"')}<span>${esc(t.title)}</span><span class="dg-pill">${m.posted ? esc(t.pill(m.captured, m.need)) : ''}</span><button type="button" data-dg="fold">${esc(folded ? t.unfold : t.fold)}</button></header>`;
    const next = `${head}<div class="dg-body">${body}</div>`;
    if (next !== html || force) { card.innerHTML = next; html = next; }
    card.hidden = false;
    // the result screen, once per result (Keep looking hides it until the page is loaded again)
    if (m.result && dismissed !== m.result.bell && !doc.getElementById('demo-result')) {
      const turns = m.result.bell - m.posted_, e = elapsed(turns, m.turnSecs, t);
      const won = m.result.state === 'won';
      const who = m.result.nations.filter(n => n !== m.player).map(nationName).join(' + ');
      const box = doc.createElement('div');
      box.id = 'demo-result'; box.className = won ? 'won' : 'lost';
      box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.dataset.result = m.result.state;
      box.innerHTML = `<div class="dr-card">${flagSvg(won ? m.player : m.result.nations[0])}<h2>${esc(won ? t.won : t.lost)}</h2><p>${esc(won ? t.wonText(m.need, m.hold) : t.lostText(who, m.need, m.hold))}</p>
        <p data-dr-time="${turns}">${esc(t.time(e.real, e.turns, e.clock))}</p><div class="dr-acts"><button type="button" class="primary" data-demo-reset="now">${esc(t.again)}</button><button type="button" data-dr="look">${esc(t.look)}</button></div></div>`;
      doc.body.appendChild(box);
    }
  }

  function placeFlags() {
    const g = last;
    if (!g || !map || typeof map.project !== 'function') { flags.innerHTML = ''; return; }
    const m = cardModel(g), out = [];
    for (const c of m.castles) {
      const h = tileHex(c.p, c.q, c.tile), w = project(h.q, h.r), s = map.project(w.x, w.y);
      // (not under the page's top bar, nor off screen)
      if (!s || !Number.isFinite(s.x) || s.x < 0 || s.y < 132 || s.x > innerWidth || s.y > innerHeight) continue;
      const label = c.counting && !c.long ? `${c.held}/${m.hold}` : c.long ? '✓' : '';
      out.push(`<div class="demo-castle" data-castle="${c.nation}" style="left:${Math.round(s.x)}px;top:${Math.round(s.y)}px">${flagSvg(c.holder)}${label ? `<span>${esc(label)}</span>` : ''}</div>`);
    }
    const next = out.join('');
    if (flags.innerHTML !== next) flags.innerHTML = next;
  }

  async function poll() {
    try {
      const live = await globalThis.__wyllsDemo?.world?.();
      last = live?.goal ? live.goal() : null;
      render();
    } catch { /* the world is not made yet (or is reloading): the next poll */ }
  }
  setInterval(poll, 700);
  poll();
  const frame = () => { try { placeFlags(); } catch { /* the map is being rebuilt */ } globalThis.requestAnimationFrame(frame); };
  globalThis.requestAnimationFrame(frame);
}
