// The walletless demo's travelers on the page (screens/travelers.mjs; owner r0ze 2026-11-28 16:21, NPCs part 2).
// Bundled into the page (src/page-app.mjs), so it shares the page's language and map. It reads the in-page world
// directly (`__wyllsDemo.world()` → `travelers()`, the record GET /h/demo/travelers also answers) and trades through
// the page's own world route (POST /gw/f/sample/trade, answered in the page by demo-world.js — a world input, so the
// save replays it). Nothing leaves the browser and nothing is signed.
//
//   the markers  a small pack-and-name marker on each traveler's tile, over the map (a ring when it is visiting you);
//                tap one to open its panel.
//   the list     a "Travelers" button (bottom left) lists all of them, also those off screen.
//   the panel    who it is, where it walks, Talk (the next of its 3 lines; which line is next is saved in the demo's
//                save, section `travelers`, v 1) and, while it is visiting your village, Trade: buy or sell 10 ore at
//                this visit's rates, a few lots a visit.
import { lang } from '../../../permutation-server/web/lang.mjs';
import { FrontierMap } from '../../../permutation-server/web/frontier/map/fmap.mjs';
import { tileHex } from '../../../permutation-server/web/frontier/fgeo.mjs';
import { project } from '../../../permutation-server/web/map.mjs';
import { LINES } from '../../screens/travelers.mjs';

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The panel's words, English and Japanese (never "season": the world is continuous). */
export const TEXT = {
  en: {
    list: n => (n ? `Travelers · ${n} visiting` : 'Travelers'),
    listTitle: 'Travelers on the roads',
    route: { outer: 'Walks the outer ring of provinces.', inner: 'Walks the inner ring of provinces.', villages: 'Walks from village to village.' },
    visiting: 'Visiting your village — you can trade now.',
    visitingShort: 'visiting you',
    away: t => (t === null ? 'On the road, far from your village.' : `On the road. Near your village in about ${t} turn${t === 1 ? '' : 's'}.`),
    nojoin: 'Pick a nation and found your village to trade.',
    walking: 'walking', resting: 'resting',
    talk: 'Talk', trade: 'Trade', close: 'Close',
    buy: (ore, food) => `Buy ${ore} ore for ${food} food`,
    sell: (ore, food) => `Sell ${ore} ore for ${food} food`,
    left: (n, max) => `Trades left this visit: ${n} of ${max}`,
    done: (side, ore, food) => (side === 'buy' ? `Bought ${ore} ore for ${-food} food.` : `Sold ${-ore} ore for ${food} food.`),
    refused: { Limit: 'No more trades this visit. Wait for the next one.', Insufficient: 'Your village does not have enough for that.', StoreFull: 'Your storehouse is full.',
      Away: 'This traveler has moved on.', NotFinal: 'Your village is not ready yet.', NoVillage: 'Found your village first.', BadData: 'That trade is not possible.' },
    stores: (food, ore) => `Your village: ${food} food · ${ore} ore`,
    notice: 'Travelers cannot be attacked and never block a march.',
  },
  ja: {
    list: n => (n ? `旅人・${n}人が来訪中` : '旅人'),
    listTitle: '街道の旅人',
    route: { outer: '外側の州をぐるりと歩いています。', inner: '内側の州をぐるりと歩いています。', villages: '村から村へ歩いています。' },
    visiting: 'あなたの村に来ています。いま取り引きできます。',
    visitingShort: '来訪中',
    away: t => (t === null ? '旅の途中。あなたの村からは遠くにいます。' : `旅の途中。あと${t}ターンほどであなたの村の近くに来ます。`),
    nojoin: '取り引きするには、国を選んで村を作ってください。',
    walking: '移動中', resting: '休憩中',
    talk: '話す', trade: '取り引き', close: '閉じる',
    buy: (ore, food) => `鉱石${ore}を食料${food}で買う`,
    sell: (ore, food) => `鉱石${ore}を食料${food}で売る`,
    left: (n, max) => `今回の来訪で残りの取り引き：${n} / ${max}`,
    done: (side, ore, food) => (side === 'buy' ? `鉱石${ore}を食料${-food}で買いました。` : `鉱石${-ore}を食料${food}で売りました。`),
    refused: { Limit: '今回の来訪ではもう取り引きできません。次の来訪を待ちましょう。', Insufficient: '村の蓄えが足りません。', StoreFull: '倉庫がいっぱいです。',
      Away: 'この旅人はもう先へ進みました。', NotFinal: '村の準備がまだです。', NoVillage: '先に村を作ってください。', BadData: 'その取り引きはできません。' },
    stores: (food, ore) => `あなたの村：食料${food}・鉱石${ore}`,
    notice: '旅人は攻撃できず、進軍の邪魔にもなりません。',
  },
};
const LANG = () => (lang() === 'en' ? 'en' : 'ja');
const T = () => TEXT[LANG()];

/** The save's section of the travelers (`{v: 1, talk: {id: next line}}`); anything else reads as a fresh one. */
export const SECTION = 'travelers';
export function readTalk(raw) {
  const talk = {};
  if (raw && raw.v === 1 && raw.talk && typeof raw.talk === 'object') for (const [k, n] of Object.entries(raw.talk)) if (Object.hasOwn(LINES, k) && Number.isInteger(n) && n >= 0) talk[k] = n % LINES[k].length;
  return talk;
}

/** The marker's model and the panel's model from the record: pure (tests read it). */
export function panelModel(rec, id, talk = {}, l = 'en') {
  const x = rec?.travelers?.find(t => t.id === id);
  if (!x) return null;
  const t = TEXT[l];
  const status = !rec.home ? t.nojoin : x.visiting ? t.visiting : t.away(x.next === null ? null : Math.max(0, x.next - rec.turn));
  const said = talk[id] ?? 0;
  return { id, name: x.name[l], route: t.route[x.route], status, walking: x.walking, visiting: x.visiting, rates: x.rates, left: x.left, max: rec.rules.lotsPerVisit, lot: rec.rules.lot,
    line: LINES[id][said % LINES[id].length][l], nextLine: (said + 1) % LINES[id].length };
}

const CSS = `
.demo-trav{position:fixed;z-index:3;transform:translate(-50%,-100%);display:flex;flex-direction:column;align-items:center;font:700 11px/1 system-ui,sans-serif;background:none;border:0;padding:0;cursor:pointer;color:inherit}
.demo-trav svg{filter:drop-shadow(0 1px 2px rgba(0,0,0,.6))}
.demo-trav span{margin-top:1px;padding:1px 4px;border-radius:4px;background:rgba(40,28,12,.88);color:#f6e7bf;white-space:nowrap}
.demo-trav.visiting span{background:#c9a24a;color:#1a1408}
.demo-trav.visiting svg{animation:demo-trav-bob 1.4s ease-in-out infinite}
@keyframes demo-trav-bob{50%{transform:translateY(-3px)}}
#demo-trav-list{position:fixed;left:12px;bottom:84px;z-index:40;background:rgba(40,28,12,.94);color:#f6e7bf;border:1px solid #c9a24a;border-radius:18px;padding:6px 12px;font:600 13px/1.2 system-ui,sans-serif;cursor:pointer;box-shadow:0 3px 10px rgba(0,0,0,.35)}
#demo-trav-list.visiting{background:#c9a24a;color:#1a1408}
#demo-trav-panel{position:fixed;left:12px;bottom:128px;z-index:41;width:300px;max-width:calc(100vw - 24px);max-height:60vh;overflow:auto;background:#f6efdc;color:#2a2214;border:2px solid #c9a24a;border-radius:12px;font:13px/1.4 system-ui,sans-serif;box-shadow:0 8px 26px rgba(0,0,0,.45)}
#demo-trav-panel header{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid rgba(201,162,74,.5);font-weight:700}
#demo-trav-panel header button{margin-left:auto}
#demo-trav-panel .dt-body{padding:8px 10px 10px}
#demo-trav-panel p{margin:0 0 6px}
#demo-trav-panel .dt-muted{opacity:.75;font-size:12px}
#demo-trav-panel .dt-line{background:#fff8e6;border-left:3px solid #c9a24a;padding:6px 8px;border-radius:4px;font-style:italic}
#demo-trav-panel .dt-acts{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}
#demo-trav-panel button{border-radius:7px;padding:5px 9px;font:inherit;font-weight:700;cursor:pointer;border:1px solid #2a2214;background:#fff}
#demo-trav-panel button.primary{background:#1f4d44;color:#fff;border-color:#1f4d44}
#demo-trav-panel button:disabled{opacity:.45;cursor:default}
#demo-trav-panel .dt-msg{font-weight:600;color:#1f4d44}
#demo-trav-panel .dt-msg.no{color:#81242c}
#demo-trav-panel ul{list-style:none;margin:0;padding:0}
#demo-trav-panel li button{width:100%;text-align:left;margin:2px 0;font-weight:600}
@media (max-width:700px){#demo-trav-list{bottom:96px;left:8px}#demo-trav-panel{left:8px;bottom:136px}}
`;

function packSvg(visiting) {
  const ring = visiting ? '<circle cx="12" cy="13" r="11" fill="none" stroke="#ffd24d" stroke-width="2.2"/>' : '';
  return `<svg width="24" height="26" viewBox="0 0 24 26" aria-hidden="true">${ring}<rect x="6" y="9" width="12" height="11" rx="2.5" fill="#8a5a2b" stroke="#3a240e" stroke-width="1.2"/><path d="M9 9V7a3 3 0 0 1 6 0v2" fill="none" stroke="#3a240e" stroke-width="1.4"/><rect x="6" y="13" width="12" height="2.2" fill="#c9a24a"/><circle cx="12" cy="14.1" r="1.3" fill="#3a240e"/></svg>`;
}

/** Start the markers, the list and the panel (once; the page's document). */
export function startTravelHud(doc = globalThis.document) {
  if (!doc || doc.getElementById('demo-trav-style')) return;
  const style = doc.createElement('style');
  style.id = 'demo-trav-style'; style.textContent = CSS;
  doc.head.appendChild(style);
  const marks = doc.createElement('div');
  marks.id = 'demo-travelers';
  // (fix-loop32, LP32 BREAK-7: the map's markers live in the page's own <main id="frontier">, the stacking context of the map
  //  and the HUD: from <body> their z-index 2 put them over everything in it — the right drawer, its report, the notices)
  (doc.getElementById('frontier') ?? doc.body).appendChild(marks);
  const list = doc.createElement('button');
  list.type = 'button'; list.id = 'demo-trav-list'; list.hidden = true; list.dataset.dt = 'list';
  doc.body.appendChild(list);
  const panel = doc.createElement('section');
  panel.id = 'demo-trav-panel'; panel.hidden = true; panel.setAttribute('aria-label', 'traveler');
  doc.body.appendChild(panel);

  let map = null, last = null, polledAt = 0, open = null, msg = null, busy = false, html = '';
  const P = FrontierMap.prototype, draw = P.draw;
  P.draw = function (...a) { map = this; return draw.apply(this, a); };
  const section = globalThis.__wyllsDemo?.section;
  let talk = readTalk(section?.get?.(SECTION));

  function renderList() {
    if (!last) { list.hidden = true; return; }
    const n = last.travelers.filter(x => x.visiting).length;
    const text = T().list(n);
    if (list.textContent !== text) list.textContent = text;
    list.classList.toggle('visiting', n > 0);
    list.dataset.visiting = String(n);
    list.hidden = false;
  }

  function renderPanel(force = false) {
    if (!open || !last) { if (!panel.hidden) { panel.hidden = true; html = ''; } return; }
    const t = T(), l = LANG();
    let next;
    if (open === '*') {
      const items = last.travelers.map(x => `<li><button type="button" data-dt="open" data-id="${esc(x.id)}">${esc(x.name[l])}${x.visiting ? ` · ${esc(t.visitingShort)}` : ''}</button></li>`).join('');
      next = `<header><span>${esc(t.listTitle)}</span><button type="button" data-dt="close">${esc(t.close)}</button></header><div class="dt-body"><ul>${items}</ul><p class="dt-muted">${esc(t.notice)}</p></div>`;
    } else {
      const m = panelModel(last, open, talk, l);
      if (!m) { open = null; return renderPanel(); }
      const rec = last.travelers.find(x => x.id === open);
      const trade = m.visiting && m.rates ? `<div class="dt-acts" data-dt-trade="${m.left}">
          <button type="button" class="primary" data-dt="trade" data-side="buy" ${m.left && !busy ? '' : 'disabled'}>${esc(t.buy(m.lot, m.rates.buy))}</button>
          <button type="button" data-dt="trade" data-side="sell" ${m.left && !busy ? '' : 'disabled'}>${esc(t.sell(m.lot, m.rates.sell))}</button></div>
        <p class="dt-muted">${esc(t.left(m.left, m.max))}</p>` : '';
      const stores = msg?.stores ? `<p class="dt-muted">${esc(t.stores(msg.stores.food, msg.stores.ore))}</p>` : '';
      next = `<header>${packSvg(m.visiting).replace('width="24" height="26"', 'width="18" height="20"')}<span data-dt-name="${esc(m.id)}">${esc(m.name)}</span><button type="button" data-dt="close">${esc(t.close)}</button></header>
        <div class="dt-body"><p class="dt-muted">${esc(m.route)} (${esc(rec.walking ? t.walking : t.resting)})</p><p data-dt-status="${m.visiting ? 'visiting' : last.home ? 'away' : 'nojoin'}">${esc(m.status)}</p>
        ${msg?.line ? `<p class="dt-line" data-dt-line="${msg.lineNo}">${esc(msg.line)}</p>` : ''}
        <div class="dt-acts"><button type="button" data-dt="talk">${esc(t.talk)}</button></div>
        ${trade}${msg?.text ? `<p class="dt-msg${msg.ok ? '' : ' no'}" data-dt-result="${msg.ok ? 'ok' : esc(msg.code)}">${esc(msg.text)}</p>` : ''}${stores}</div>`;
    }
    if (next !== html || force) { panel.innerHTML = next; html = next; }
    panel.hidden = false;
  }

  function placeMarks() {
    if (!last || !map || typeof map.project !== 'function') { if (marks.innerHTML) marks.innerHTML = ''; return; }
    // (between two reads of the world: the traveler walks on along its trail, at its speed)
    const into = Math.min(0.999, Math.max(0, (last.into ?? 0) + (Date.now() - polledAt) / 1000 / (last.turnSecs || 12)));
    const out = [];
    for (const x of last.travelers) {
      const k = x.walking ? into * last.rules.speed : 0, i = Math.min(x.trail.length - 1, Math.floor(k)), j = Math.min(x.trail.length - 1, i + 1), f = k - Math.floor(k);
      const a = tileHex(x.trail[i].p, x.trail[i].q, x.trail[i].tile), b = tileHex(x.trail[j].p, x.trail[j].q, x.trail[j].tile);
      const wa = project(a.q, a.r), wb = project(b.q, b.r), s = map.project(wa.x + (wb.x - wa.x) * f, wa.y + (wb.y - wa.y) * f);
      if (!s || !Number.isFinite(s.x) || s.x < 0 || s.y < 132 || s.x > innerWidth || s.y > innerHeight) continue;
      out.push(`<button type="button" class="demo-trav${x.visiting ? ' visiting' : ''}" data-dt="open" data-id="${esc(x.id)}" data-traveler="${esc(x.id)}" style="left:${Math.round(s.x)}px;top:${Math.round(s.y)}px" aria-label="${esc(x.name[LANG()])}">${packSvg(x.visiting)}<span>${esc(x.name[LANG()].split(/[,、]/)[0].replace(/^.*の/, ''))}</span></button>`);
    }
    const next = out.join('');
    if (marks.innerHTML !== next) marks.innerHTML = next;
  }

  async function doTrade(side) {
    if (busy || !open) return;
    busy = true; renderPanel(true);
    const t = T();
    try {
      const res = await fetch('/gw/f/sample/trade', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ traveler: open, side, lots: 1 }) });
      const r = await res.json();
      msg = { ...(msg ?? {}), ok: !!r.ok, code: r.code ?? null, text: r.ok ? t.done(side, r.ore, r.food) : (t.refused[r.code] ?? t.refused.BadData), stores: r.stores ?? msg?.stores ?? null };
    } catch { msg = { ...(msg ?? {}), ok: false, code: 'BadData', text: t.refused.BadData }; }
    busy = false;
    await poll();
  }

  function sayNext() {
    const l = LANG(), n = talk[open] ?? 0, line = LINES[open][n % LINES[open].length][l];
    talk = { ...talk, [open]: (n + 1) % LINES[open].length };
    section?.set?.(SECTION, { v: 1, talk });
    msg = { ...(msg ?? {}), line, lineNo: n % LINES[open].length };
    renderPanel();
  }

  doc.addEventListener('click', e => {
    const b = e.target.closest?.('[data-dt]');
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    const what = b.dataset.dt;
    if (what === 'list') { open = open === '*' ? null : '*'; msg = null; }
    else if (what === 'open') { if (open !== b.dataset.id) msg = null; open = b.dataset.id; }
    else if (what === 'close') { open = null; msg = null; }
    else if (what === 'talk') return sayNext();
    else if (what === 'trade') return doTrade(b.dataset.side);
    renderPanel();
  }, true);

  async function poll() {
    try {
      const live = await globalThis.__wyllsDemo?.world?.();
      last = live?.travelers ? live.travelers() : null;
      polledAt = Date.now();
      renderList(); renderPanel();
    } catch { /* the world is not made yet (or is reloading): the next poll */ }
  }
  setInterval(poll, 700);
  poll();
  const frame = () => { try { placeMarks(); } catch { /* the map is being rebuilt */ } globalThis.requestAnimationFrame(frame); };
  globalThis.requestAnimationFrame(frame);
}
