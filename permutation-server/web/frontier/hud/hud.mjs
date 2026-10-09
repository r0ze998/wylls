// The game HUD around the map (UI plan, benchmarks: Eternum's header and
// left command column, Civ's yield bar and "what needs you" list, Travian's
// incoming-attack mark):
//   - the next-bell pill: the bell number, the time left and a bar of the
//     ten minutes; calm, then amber from 120 s and red from 30 s before the
//     bell (the screen edge follows only while a march is being composed);
//   - the resource strip: the active holding's stores, amount / cap, the
//     hourly rate and the time until full (full and near-full marked);
//   - the attention pill: what needs the player before the next bell
//     (possible arrivals at a holding, settlements due, full stores, a march
//     left unsent), one press moves to the next item;
//   - the village plate (bottom left; UX design section 6): who the viewer
//     is, the active village with its countdown and warning mark, one press
//     home; above it at most two to-do lines. (It replaces the left rail;
//     the action tiles are the dock, screens/shell.mjs.)
// Models are pure (they read FS and return numbers and text the tests
// check); the render functions return markup; app.mjs puts it in the page.
import { html, raw } from '../../util.mjs';
import { L, fmtNum, lang } from '../../lang.mjs';
import { RESOURCES, RESOURCE_ORDER, TIERS, factionName } from '../fi18n.mjs';
import { storesAt, holdingFacts, SETTLER, ticketTimes } from '../fland.mjs';
import { hostRows } from '../screens/host.mjs';
import { DEPART_STAMINA } from '../fmarch.mjs';
import { bellChip, countdown, BELL_SECS } from '../clock.mjs';
import { ownTag, ownIdentity, holdingName } from '../people/ui.mjs';
import { leaderSvg } from '../people/leaders.mjs';
import { displayName } from '../people/identity.mjs';
import { avatarSvg, sigilPath, FACTION_FILL, FACTION_DARK, FACTION_ON } from '../people/avatar.mjs';
import { icon, RESOURCE_ICON } from './icons.mjs';
import { tileWhat, provinceName } from './place.mjs';

/** Seconds before the bell at which the pill turns amber, then red. */
export const URGENCY = Object.freeze({ warn: 120, crit: 30 });
/** A store this close to its cap (seconds of production) reads as "near full". */
export const NEAR_FULL_SECS = 3600;

export { activeHolding } from '../fstate.mjs';
import { activeHolding } from '../fstate.mjs';

// ------------------------------------------------------------------ the bell pill
/** `{bell, secondsLeft, frac, urgency, beforeGenesis, ended}` at chain time `now`. */
export function bellModel(clock, now) {
  const c = clock ? bellChip(clock, now) : { bell: null, secondsLeft: null };
  const left = c.secondsLeft;
  const inBell = !c.beforeGenesis && !c.ended && Number.isFinite(left);
  const urgency = !inBell ? 'calm' : left <= URGENCY.crit ? 'crit' : left <= URGENCY.warn ? 'warn' : 'calm';
  const frac = inBell ? Math.min(1, Math.max(0, 1 - left / BELL_SECS)) : 0;
  return { ...c, frac, urgency };
}

// ------------------------------------------------------------------ resources
/**
 * The strip's tokens for a holding at `now`: `[{resource, name, value, cap,
 * perHour, fullIn, state}]`, only resources the holding produces or holds;
 * `fullIn` is seconds to the cap (0 when full, null without production),
 * `state` 'full' | 'near' | 'ok'.
 */
export function resourceModel(holding, now) {
  if (!holding) return [];
  return storesAt(holding, now, RESOURCE_ORDER)
    .filter(s => s.value > 0 || s.perHour > 0)
    .map(s => {
      const fullIn = s.cap > 0 && s.value >= s.cap ? 0 : s.perHour > 0 && s.cap > 0 ? Math.ceil(((s.cap - s.value) / s.perHour) * 3600) : null;
      const state = fullIn === 0 ? 'full' : fullIn !== null && fullIn <= NEAR_FULL_SECS ? 'near' : 'ok';
      return { resource: s.resource, name: RESOURCES[s.resource], value: s.value, cap: s.cap, perHour: s.perHour, fullIn, state };
    });
}

/** A span for the strip: "12:30" under an hour, "3時間20分" under a day, else "5日". */
export function span(secs) {
  const s = Math.max(0, Math.ceil(secs));
  if (s < 3600) return countdown(s);
  if (s < 86_400) return L`${Math.floor(s / 3600)}時間${Math.floor((s % 3600) / 60)}分`;
  return L`${Math.floor(s / 86_400)}日`;
}

/** One token's hover text: "食料 1,200 / 5,000 · 毎時 +120 · 満杯まで 31:40". */
export function resourceTitle(r) {
  const full = r.fullIn === 0 ? L`満杯です（これ以上は貯まりません）` : r.fullIn === null ? '' : L`満杯まで ${span(r.fullIn)}`;
  return [`${r.name} ${fmtNum(r.value)} / ${fmtNum(r.cap)}`, L`毎時 +${fmtNum(r.perHour)}`, full].filter(Boolean).join(' · ');
}

// ------------------------------------------------------------------ attention
/**
 * What needs the player, most urgent first: `[{kind, text, p, q, tab}]`.
 *   incoming  another faction's host may arrive at one of the holdings
 *   settle    the result of a march of the viewer's can be collected
 *   draft     a march is being composed and not yet sent
 * A place is said by its name (the village, the destination), never by coordinates (UX design 11.13).
 *   full      a store of the active holding is full
 */
export function attentionItems(FS) {
  const out = [];
  const villageOf = x => { const h = (FS.holdings ?? []).find(o => o.p === x.p && o.q === x.q && (x.site === undefined || o.site === x.site)); return h ? holdingName(h) : provinceName(FS, x.p, x.q); };
  for (const w of FS.incoming ?? []) {
    out.push({ kind: 'incoming', p: w.holding.p, q: w.holding.q, tab: 'marches', bell: w.bell, short: L`来襲 ターン ${fmtNum(w.bell)}`, text: L`ターン ${fmtNum(w.bell)} に、${villageOf(w.holding)}へ敵が来るかもしれません` });
  }
  for (const m of FS.marches ?? []) {
    if (!m.facts?.settleReady || !m.dest) continue;
    const to = (Number.isInteger(m.dest.tile) ? tileWhat(FS, m.dest.p, m.dest.q, m.dest.tile).name : null) ?? provinceName(FS, m.dest.p, m.dest.q);
    out.push({ kind: 'settle', p: m.dest.p, q: m.dest.q, tab: 'marches', short: L`進軍の結果`, text: L`${to}への進軍の結果を受け取れます` });
  }
  if (FS.compose && !FS.compose.sending) {
    const o = FS.compose.origin;
    out.push({ kind: 'draft', p: o.p, q: o.q, tab: 'marches', short: L`書きかけの命令`, text: L`書きかけの進軍の命令が、まだ送られていません` });
  }
  if (FS.exploreSeedReady) {
    const h0 = activeHolding(FS);
    if (h0) out.push({ kind: 'explore', p: h0.p, q: h0.q, tab: 'hosts', short: L`探索の結果`, text: L`探索の結果を受け取れます` });
  }
  const now = FS.chain?.now() ?? 0, bell = FS.nowBell ?? 0;
  // hosts ready to march: in the roster, rested, not on the road, nothing pending
  const idle = FS.holdings?.length ? hostRows(FS).filter(r => r.state === 1 && !r.inTransit && !r.pending && r.stamina >= DEPART_STAMINA && !(r.readyBell > bell)) : [];
  if (idle.length) out.push({ kind: 'idle', p: idle[0].p, q: idle[0].q, tile: idle[0].tile, host: String(idle[0].id), tab: 'hosts', n: idle.length, short: L`出陣できる軍勢 ${fmtNum(idle.length)}`, text: L`出陣できる軍勢が ${fmtNum(idle.length)} あります` });
  for (const h of FS.holdings ?? []) {
    const full = resourceModel(h, now).filter(r => r.state === 'full');
    const facts = FS.season ? holdingFacts(h, FS.season, now) : null;
    if (!facts) { if (full.length) out.push({ kind: 'full', p: h.p, q: h.q, tab: 'holding', holding: h, short: L`満杯 ${fmtNum(full.length)}`, text: L`${full.map(r => r.name).join(' / ')}が満杯です。収穫するか使いましょう。` }); continue; }
    if (facts.final && !facts.queue.some(q => q.doneIn > 0)) out.push({ kind: 'build', p: h.p, q: h.q, tab: 'holding', holding: h, short: L`建設の列が空`, text: L`${holdingName(h)}の建設の列が空いています` });
    const musterable = facts.reserve.filter(r => r.unit !== SETTLER).reduce((a, r) => a + r.troops, 0);
    if (facts.final && musterable >= 100) out.push({ kind: 'muster', p: h.p, q: h.q, tab: 'holding', holding: h, short: L`編成できる兵 ${fmtNum(musterable)}`, text: L`控えの兵 ${fmtNum(musterable)} を軍勢に編成できます` });
    if (facts.dormantIn > 0 && facts.dormantIn < DORMANT_WARN_SECS) out.push({ kind: 'dormant', p: h.p, q: h.q, tab: 'holding', holding: h, short: L`休眠まで ${span(facts.dormantIn)}`, text: L`${holdingName(h)}はあと ${span(facts.dormantIn)} で休眠します。何か操作しましょう。` });
    if (full.length) out.push({ kind: 'full', p: h.p, q: h.q, tab: 'holding', holding: h, short: L`満杯 ${fmtNum(full.length)}`, text: L`${full.map(r => r.name).join(' / ')}が満杯です。収穫するか使いましょう。` });
  }
  return out;
}

/** A mark per kind of item (not colour alone, UI plan E6): a sprite icon (hud/icons.mjs). */
export const TODO_ICON = Object.freeze({ incoming: 'alert', settle: 'check', draft: 'quill', explore: 'scout', idle: 'banner', build: 'hammer', muster: 'swords', dormant: 'moon', full: 'crate' });

/** A holding this close to dormancy (seconds) is an attention item. */
export const DORMANT_WARN_SECS = 6 * 3600;

/**
 * The pill's text (Civ's end-turn button names the next blocker): the first
 * item's short label, then how many more — "来襲 ターン 1,040 · ほか 2";
 * null when nothing needs the player.
 */
export function attentionText(items) {
  if (!items.length) return null;
  const first = items[0].short ?? items[0].text;
  return items.length > 1 ? L`${first} · ほか ${fmtNum(items.length - 1)}` : first;
}

// ------------------------------------------------------------------ markup
const STATE_RANK = { full: 0, near: 1, ok: 2 };
/**
 * The strip: `max` tokens (the header's room: one on a phone), the most
 * pressing first (full, then near full); when some are left out, a press
 * opens every resource ('*').
 */
export function renderStrip(tokens, open = null, max = tokens.length) {
  const all = tokens.length > max;
  const shown = all ? [...tokens].sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || tokens.indexOf(a) - tokens.indexOf(b)).slice(0, max) : tokens;
  // (some are left out: the last one shown carries how many more there are, and every one opens them all; a strip
  // never ends in half a token)
  const more = all ? tokens.length - shown.length : 0;
  return shown.map((r, i) => html`<button type="button" class="res res-${r.state}" data-act="res-open" data-r="${all ? '*' : r.resource}" data-res="${r.resource}" aria-expanded="${open === (all ? '*' : r.resource) ? 'true' : 'false'}" aria-haspopup="dialog" title="${resourceTitle(r)}" aria-label="${all ? L`${resourceTitle(r)} · ほか ${fmtNum(tokens.length - max)} 種` : resourceTitle(r)}">
    ${icon(RESOURCE_ICON[r.resource] ?? 'crate', `res-ic res-c-${r.resource}`)}
    <span class="res-val">${fmtNum(r.value)}</span><span class="res-short" aria-hidden="true">${shortNum(r.value)}</span>
    ${r.perHour > 0 ? html`<span class="res-rate">${L`+${fmtNum(r.perHour)}/時`}</span>` : ''}
    ${r.state === 'full' ? html`<span class="res-flag">${L`満杯`}</span>` : r.state === 'near' ? html`<span class="res-flag">${span(r.fullIn)}</span>` : ''}
    ${more > 0 && i === shown.length - 1 ? html`<span class="res-more-n" aria-hidden="true">+${fmtNum(more)}</span>` : ''}
  </button>`);
}

/** A number in a few characters for the phone strip: 980, 1,220, 12K / 1.2万. */
export function shortNum(n) {
  const v = Number(n ?? 0);
  // (one way of writing a number in a strip: whole up to 9,999, in a few characters above; "1.2K" beside "815" read as two units)
  if (Math.abs(v) < 10000) return fmtNum(Math.round(v));
  try { return new Intl.NumberFormat(lang() === 'en' ? 'en' : 'ja', { notation: 'compact', maximumFractionDigits: 1 }).format(v); } catch { return fmtNum(v); }
}

/**
 * One resource across the viewer's holdings (UI plan E1, Civ's yield
 * breakdown on press): `{resource, name, total, perHour, rows: [{holding,
 * value, cap, perHour, fullIn, state}]}`.
 */
export function resourceBreakdown(holdings, resource, now) {
  const rows = [];
  for (const h of holdings ?? []) {
    const r = resourceModel(h, now).find(x => x.resource === resource);
    if (r) rows.push({ holding: h, value: r.value, cap: r.cap, perHour: r.perHour, fullIn: r.fullIn, state: r.state });
  }
  return { resource, name: RESOURCES[resource], total: rows.reduce((a, r) => a + r.value, 0), perHour: rows.reduce((a, r) => a + r.perHour, 0), rows };
}

/** Every resource of the viewer's holdings in one list (the phone's strip shows one): `[breakdown]`. */
export function allBreakdowns(holdings, now) {
  const seen = new Set();
  for (const h of holdings ?? []) for (const r of resourceModel(h, now)) seen.add(r.resource);
  return RESOURCE_ORDER.filter(r => seen.has(r)).map(r => resourceBreakdown(holdings, r, now));
}

/** The popover for every resource: one row each, a press opens that one's breakdown. */
export function renderAllBreakdowns(list) {
  return html`<div class="res-pop-head"><strong>${L`資源`}</strong><span></span>
    <button type="button" class="btn small pop-x" data-act="res-close" aria-label="${L`閉じる`}">${icon('close')}</button></div>
    <ul class="list res-rows">${list.map(b => html`<li class="${b.rows.some(r => r.state === 'full') ? 'res-full' : ''}"><button type="button" class="res-row" data-act="res-open" data-r="${b.resource}">
      <span class="res-row-name">${icon(RESOURCE_ICON[b.resource] ?? 'crate', `res-ic res-c-${b.resource}`)} ${b.name}</span><span>${fmtNum(b.total)}</span>
      <span class="muted">${L`毎時 +${fmtNum(b.perHour)}`}</span><span class="muted">${b.rows.some(r => r.state === 'full') ? L`満杯` : ''}</span></button></li>`)}</ul>`;
}

/** The breakdown popover's markup. */
export function renderBreakdown(b) {
  if (!b) return '';
  return html`<div class="res-pop-head"><strong>${b.name}</strong> <span>${L`合計 ${fmtNum(b.total)} · 毎時 +${fmtNum(b.perHour)}`}</span>
    <button type="button" class="btn small pop-x" data-act="res-close" aria-label="${L`閉じる`}">${icon('close')}</button></div>
    <ul class="list res-rows">${b.rows.map(r => html`<li class="res-${r.state}"><button type="button" class="res-row" data-act="goto" data-p="${r.holding.p}" data-q="${r.holding.q}">
      <span class="res-row-name">${holdingName(r.holding)}</span>
      <span>${fmtNum(r.value)} / ${fmtNum(r.cap)}</span><span class="muted">${L`毎時 +${fmtNum(r.perHour)}`}</span>
      <span class="muted">${r.fullIn === 0 ? L`満杯` : r.fullIn !== null ? L`満杯まで ${span(r.fullIn)}` : ''}</span></button></li>`)}</ul>
    <p class="muted">${L`増える量は、建物と村のまわりの土地で決まります。満杯になると増えません。村の画面で収穫や建設ができます。`}</p>`;
}

/**
 * A holding's clocks for the rail (Civ's city banner timers): the next
 * building done, the first store full, dormancy when it is near.
 */
export function holdingCountdowns(FS, h) {
  const now = FS.chain?.now?.() ?? 0;
  const out = [];
  const facts = FS.season ? holdingFacts(h, FS.season, now) : null;
  const next = facts?.queue.filter(q => q.doneIn > 0).sort((a, b) => a.doneIn - b.doneIn)[0];
  if (next) out.push(L`建設 あと ${span(next.doneIn)}`);
  const full = resourceModel(h, now).filter(r => r.fullIn > 0).sort((a, b) => a.fullIn - b.fullIn)[0];
  if (full && full.fullIn < 24 * 3600) out.push(L`${full.name} 満杯まで ${span(full.fullIn)}`);
  if (facts && facts.dormantIn > 0 && facts.dormantIn < DORMANT_WARN_SECS) out.push(L`休眠まで ${span(facts.dormantIn)}`);
  return out;
}

/**
 * The standings of the six factions from the overviews (the spectator's rail):
 * `[{faction, holdings, provinces}]`, most holdings first.
 */
export function standings(overviews) {
  const rows = Array.from({ length: 6 }, (_, f) => ({ faction: f, holdings: 0, provinces: 0 }));
  for (const o of overviews?.values?.() ?? []) for (const pr of o.provinces ?? []) {
    const seen = new Set();
    pr.owners.forEach((f, j) => { if (pr.sites[j] === 1 && f < 6) { rows[f].holdings++; seen.add(f); } });
    for (const f of seen) rows[f].provinces++;
  }
  return rows.sort((a, b) => b.holdings - a.holdings || b.provinces - a.provinces || a.faction - b.faction);
}

/** The standings list alone (the spectator's phone panel folds it). */
export function renderStandingsList(FS) {
  return html`<ol class="rail-standings">${standings(FS.overviews).map((r, i) => html`<li><span class="rank">${i + 1}</span>${raw(leaderSvg(r.faction, { size: 34 }))}<strong>${factionName(r.faction)}</strong>
      <span class="muted">${L`村 ${fmtNum(r.holdings)} · ${fmtNum(r.provinces)} 州`}</span></li>`)}</ol>`;
}

/**
 * A nation's crest: its sigil on a shield in its colour (the sigil carries the identity; colour
 * is never the only signal). Presentation attributes only: the page's CSP allows no style attribute.
 */
export function crestSvg(faction, { size = 26 } = {}) {
  const f = Number.isInteger(faction) && faction >= 0 && faction < 6 ? faction : null;
  const fill = f === null ? '#8a8a80' : FACTION_FILL[f], dark = f === null ? '#55554e' : FACTION_DARK[f];
  return raw(`<svg class="crest" viewBox="0 0 24 28" width="${Math.round(size * 24 / 28)}" height="${size}" aria-hidden="true" focusable="false"><path d="M12 1.2l9.6 2.9v9.9c0 5.8-3.9 9.8-9.6 12.6C6.3 23.8 2.4 19.8 2.4 14V4.1Z" fill="${fill}" stroke="#f0d48a" stroke-width="1.3" stroke-linejoin="round"/><path d="M12 3.4l7.5 2.3v8.3c0 4.6-3 7.9-7.5 10.3Z" fill="${dark}" opacity=".28"/><g transform="translate(12 12.6)"><path d="${sigilPath(f ?? 6, 5)}" fill="${f === null ? '#fffaf0' : FACTION_ON[f]}" stroke="${dark}" stroke-width=".7"/></g></svg>`);
}

/**
 * The top plaque's nation mark: the leader's hexagon icon with the nation's sigil on its colour at the foot (the
 * sigil carries the identity where the name is put away: a phone's strip).
 */
export const leaderCrest = (faction, { size = 34 } = {}) => raw(leaderSvg(faction, { size, shape: 'hex', sigil: true }));

/** How many to-do lines the opened list shows at most (the count beside the heading says how many there are). */
export const TODO_LINES = 5;

/**
 * The to-do lines (UX design 11.11: there is ONE "next thing" signal, the button of the top strip; the lines
 * wait behind a count): a tab that reads "this turn" with the bell and the number of items; pressed
 * (`data-act="todo-toggle"`), it opens the list — one plaque, rows of equal width, a medallion per kind — each
 * row a press that goes there. `open` true: the list stands open (a phone's raised sheet shows it so). Nothing
 * when there is nothing to do.
 */
export function renderTodo(FS, { max = TODO_LINES, open = false } = {}) {
  const items = FS.mode === 'play' ? attentionItems(FS) : [];
  if (!items.length) return '';
  return html`<div class="todo${open ? ' todo-open' : ''}"><h2 class="todo-h"><button type="button" class="todo-tab" data-act="todo-toggle" aria-expanded="${open ? 'true' : 'false'}" aria-controls="todo-list">${icon('bell')}<span>${L`このターンにやること`}</span><span class="todo-n">${fmtNum(items.length)}</span>${icon('chevron', 'todo-mark')}</button></h2>
    ${open ? html`<ol class="todo-list" id="todo-list">${items.slice(0, max).map((x, i) => html`<li class="todo-${x.kind}"><button type="button" class="todo-btn" data-act="attn-go" data-i="${i}"><span class="todo-medal">${icon(TODO_ICON[x.kind] ?? 'flag', 'todo-ic')}</span><span class="todo-text">${x.text}</span>${icon('next', 'todo-go')}</button></li>`)}</ol>` : ''}</div>`;
}

/**
 * The one "next thing" (UX design 11.11): while the guide runs, the guide's step (`guide`:
 * screens/onboarding.mjs objectiveModel) — unless an attack may be coming, which comes first; afterwards the
 * most pressing to-do item (`items`, as the guide's level lets through). `{kind: 'guide' | 'todo', icon,
 * kicker, title, label, text, act, data, more}`: `act` / `data` are what a press does, `text` the whole of it
 * in one line (the control's name), `more` how many other items wait. Null when nothing needs the player.
 */
export function nextThing(FS, { guide = null, items = null } = {}) {
  const list = items ?? (FS.mode === 'play' ? attentionItems(FS) : []);
  const urgent = list[0]?.kind === 'incoming';
  if (guide && !urgent) {
    const kicker = L`ガイド ${fmtNum(guide.n)}/${fmtNum(guide.total)}`;
    const go = guide.go ?? { act: 'guide-open', data: {}, label: L`手順を見る` };
    return { kind: 'guide', icon: 'compass', kicker, title: guide.title, label: go.label, text: L`${kicker}：${guide.title}（${go.label}）`, hint: guide.text, act: go.act, data: go.data ?? {}, more: list.length };
  }
  if (!list.length) return null;
  const x = list[0];
  return { kind: 'todo', icon: TODO_ICON[x.kind] ?? 'flag', kicker: '', title: x.short ?? x.text, label: '', text: attentionText(list), hint: x.text ?? '', act: 'attn', data: {}, more: list.length - 1, item: x.kind };
}

const dataAttrs = d => raw(Object.entries(d ?? {}).map(([k, v]) => `data-${String(k).replace(/[^\w-]/g, '')}="${String(v).replace(/[^\w.,:-]/g, '')}"`).join(' '));

/**
 * The next thing as a line under the village plate (a phone's sheet at rest: the top strip has no room for
 * it): the step or the item by name with its one press; for the guide, a second small button opens the steps.
 */
export function renderNextRow(next) {
  if (!next) return '';
  return html`<div class="next-row next-${next.kind}">
    <button type="button" class="next-row-go" data-act="${next.act}" ${dataAttrs(next.data)} aria-label="${L`次にやること：${next.text}`}"><span class="todo-medal">${icon(next.icon, 'todo-ic')}</span><span class="next-row-t">${next.kicker ? html`<span class="next-kicker">${next.kicker}</span>` : ''}<strong>${next.title}</strong></span>${next.label ? html`<span class="next-row-do">${next.label}</span>` : next.more > 0 ? html`<span class="todo-n">${L`ほか ${fmtNum(next.more)}`}</span>` : ''}${icon('next', 'todo-go')}</button>
    ${next.kind === 'guide' ? html`<button type="button" class="next-row-steps" data-act="guide-open" aria-label="${L`ガイドの手順を見る`}">${icon('list')}</button>` : ''}</div>`;
}

/**
 * The plate's line for a viewer without a village yet: what the request for the village is doing right now, in the
 * same words as the wait view (the second review: the plate said "is being sent automatically" under a drawer that
 * said the request had been refused).
 */
export function waitingLine(FS) {
  const stage = FS.land?.stage ?? 'none', st = FS.autoTicket?.state ?? null;
  if (stage === 'ticket') {
    // (the bell that decides it: the toll just before the result, as the wait view and the dial's card say it)
    let turn = null;
    try { turn = FS.clock && Number.isInteger(FS.land?.ticket?.bell) ? Math.floor((ticketTimes(FS.clock, FS.land.ticket.bell).resultAbout - FS.clock.genesisTs) / BELL_SECS) : null; } catch { turn = null; }
    return turn === null ? L`村の申し込みは済んでいます。次のターンの鐘のあとに決まります。` : L`村の申し込みは済んでいます。ターン ${fmtNum(turn)} の鐘のあとに決まります。`;
  }
  if (st === 'failed') return L`村の申し込みはまだ通っていません。次のターンにやり直します。`;
  if (st === 'nofree') return L`空いた場所が見つかりません。ターンごとに探し直します。`;
  if (st === 'room') return L`このターンの申し込みの枠がいっぱいです。次のターンに出します。`;
  if (st === 'sent') return L`村の申し込みを出しました。記録に現れるのを待っています。`;
  if (st === 'waiting') return L`このターンの申し込みは済みました。次のターンにもう一度出します。`;
  return L`村の申し込みを出しています。`;
}

/**
 * The village plate (bottom left, always on screen in play): the viewer's
 * face, the active village's name (its tier is in the name), the nearest
 * countdown and the warning mark; the whole plate is one press home
 * (`data-act="home"`, pressed again: the next village). Before a village
 * exists it says where the viewer stands and opens the join flow.
 */
export function renderPlate(FS) {
  if (FS.mode !== 'play') return '';
  const faction = FS.citizen?.faction;
  const joined = Number.isInteger(faction);
  if (!joined) {
    return html`<div class="plate plate-open"><span class="plate-text"><strong class="plate-name">${L`まだ国に加わっていません`}</strong><span class="plate-sub">${L`選ぶのは国だけです。村の場所は自動で決まります。`}</span></span>
      <span class="plate-acts"><button type="button" class="btn primary plate-go" data-act="join-open">${L`国を選ぶ`}</button></span></div>`;
  }
  const me = ownTag(FS) !== null ? ownIdentity(FS) : null;
  const face = me ? raw(avatarSvg(me, faction, { size: 48, uid: 'plate' })) : raw(leaderSvg(faction, { size: 48 }));
  const myName = me ? html`<span data-name>${displayName(me, { full: true })}</span>` : null;
  const who = myName ? html`${myName} · ${factionName(faction)}` : factionName(faction);
  const hs = FS.holdings ?? [];
  const h = activeHolding(FS);
  if (!h) {
    return html`<div class="plate plate-open"><span class="plate-who"><span class="plate-face">${face}</span><span class="plate-text"><strong class="plate-name">${myName ?? factionName(faction)}</strong>${myName ? html`<span class="plate-sub">${factionName(faction)}</span>` : ''}</span></span>
      <span class="plate-sub">${waitingLine(FS)}</span>
      <span class="plate-acts"><button type="button" class="btn plate-go" data-act="join-open">${L`様子を見る`}</button><button type="button" class="btn plate-go plate-practice" data-act="practice-open">${icon('swords')}${L`練習で戦う`}</button></span></div>`;
  }
  const warned = (FS.incoming ?? []).some(w => w.holding.p === h.p && w.holding.q === h.q);
  const clocks = holdingCountdowns(FS, h);
  const name = holdingName(h);
  const i = hs.indexOf(h);
  return html`<div class="plate${warned ? ' plate-warned' : ''}">
    <button type="button" class="plate-main" data-act="home" aria-label="${hs.length > 1 ? L`${name}へ移動（もう一度押すと次の村）` : L`${name}へ移動`}">
      <span class="plate-face">${face}</span>
      <span class="plate-text"><strong class="plate-name">${name}${h.state === 2 ? '' : html` <span class="plate-tag">${L`仮`}</span>`}</strong>
        <span class="plate-sub">${who}</span>
        ${warned ? html`<span class="plate-warn">${icon('alert')}${L`来襲の恐れ`}</span>` : clocks.length ? html`<span class="plate-clock">${clocks[0]}</span>` : ''}</span>
      <span class="plate-home">${icon('home')}</span>
    </button>
    ${hs.length > 1 ? html`<span class="plate-pips" role="group" aria-label="${L`村`}">${hs.map((o, k) => html`<button type="button" class="plate-pip" data-act="holding-go" data-i="${k}" ${raw(k === i ? 'aria-current="true"' : '')} aria-label="${holdingName(o)}" title="${holdingName(o)}"><span aria-hidden="true">${k + 1}</span></button>`)}</span>` : ''}
  </div>`;
}

/**
 * The bottom-left corner (`aside#rail`): the to-do tab (its list when `todoOpen`), then the plate.
 * The spectator sees the standings there instead.
 */
export function renderRail(FS, { todoOpen = false } = {}) {
  if (FS.mode === 'spectate') return html`<div class="plate plate-watch"><h2 class="todo-h todo-h-plain">${icon('eye')}<span>${L`国の順位`}</span></h2>${renderStandingsList(FS)}<p class="plate-note">${L`村の数は、ターンごとにまとめられる記録から数えています。`}</p></div>`;
  if (FS.mode !== 'play') return '';
  return html`${renderTodo(FS, { open: todoOpen })}${renderPlate(FS)}`;
}
