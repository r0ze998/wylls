// What happened (UI plan A2–A4; Civ's notification stack, Old World's turn
// summary, Civ VII's "pan to combat"): the page compares what it knew at
// the last poll with what it knows now and turns each change into one
// notification — a march's seal opened, its clash resolved, its result to
// collect, a battle in a province of the viewer's, an attack that may come,
// a building finished, a village made final, a keep taken (and, for the viewer's nation, a
// contest for a keep begun or beaten off). When the bell tolls, the
// changes of the turn that ended are folded into one summary ("turn 1,034:
// 2 battles…"). A place is said by its name, never by coordinates (UX
// design 11.13): a village by its own, a province by hud/place.mjs.
//
// Notifications sit at the map's top right (newest first, at most
// TOAST_MAX, each with "go there" and, for battles, "watch" and "report"),
// a × dismisses one; the More tab keeps the last FEED_MAX with filters.
// Nothing here blocks the game: no modal, no sound.
import { html, raw } from '../../util.mjs';
import { L, fmtNum, lang } from '../../lang.mjs';
import { BUILDINGS, TIERS, factionName } from '../fi18n.mjs';
import { BUILD_ITEMS, queueItem } from '../fland.mjs';
import { keepEventSide } from '../fconquest.mjs';
import { holdingName } from '../people/ui.mjs';
import { playerFace } from '../people/faces.mjs';
import { placeName } from '../people/identity.mjs';
import { icon } from './icons.mjs';
import { tileWhat, provinceName } from './place.mjs';
import { cardHead, chip, fold } from '../screens/parts.mjs';
import { territoryEnabled, territoryOf } from '../territory.mjs';

export const FEED_MAX = 60;
export const TOAST_MAX = 3;
/** A notification stays a toast for this long (ms) unless dismissed; it stays in the list after. */
export const TOAST_MS = 45_000;

/** A keep event is news for this many bells after its own (a bell resolves after it ends; older ones are the record's). */
export const KEEP_NEWS_BELLS = 6;

const marchKey = m => String(m.entry?.host ?? m.transit?.hostId ?? '');

/**
 * What the page knows now, reduced to what notifications compare. `prev` is the snapshot before this one: what a
 * march has once been seen to be stays so (its seal open, its turn resolved: the herald's per-turn files come and go
 * and a line was told twice), and its destination keeps the name it had while its arrival turn had not ended.
 */
export function snapshot(FS, now = FS.chain?.now?.() ?? 0, prev = null) {
  const marches = new Map();
  for (const m of FS.marches ?? []) {
    const k = marchKey(m);
    const was = prev?.marches?.get(k) ?? null;
    const arrive = m.entry?.arriveBell ?? m.transit?.arriveBell ?? null;
    // (the destination's name as the page knows it now: what stands on the tile, when this browser knows the tile)
    // (once the arrival turn has ended its clash may have changed what stands there — a camp it cleared is grass —: the
    // line that tells of the clash names the place as it was when the host came to it)
    const nameNow = m.dest && Number.isInteger(m.dest.tile) ? tileWhat(FS, m.dest.p, m.dest.q, m.dest.tile).name ?? null : null;
    const ended = Number.isInteger(arrive) && Number.isInteger(FS.nowBell) && FS.nowBell > arrive;
    const destName = ended && was && was.bell === arrive && was.destName ? was.destName : nameNow;
    const same = !!was && was.bell === arrive;
    if (k) marches.set(k, { pipeline: same && was.pipeline === 'resolved' ? 'resolved' : m.facts?.pipeline ?? null,
      revealed: !!m.facts?.slotPresent || (same && was.revealed), settle: !!m.facts?.settleReady,
      dest: m.dest ?? null, destName, bell: arrive, outcome: m.transit?.outcome ?? null });
  }
  const builds = new Set(), pendingBuilds = new Set(), holdings = new Map();
  for (const h of FS.holdings ?? []) {
    holdings.set(`${h.p},${h.q},${h.site}`, { state: h.state, tier: h.tier, p: h.p, q: h.q, site: h.site });
    for (const q of h.queue ?? []) {
      if (!q) continue;
      const done = Number(q.doneAt ?? 0);
      if (done > 0) (done <= now ? builds : pendingBuilds).add(`${h.p},${h.q},${h.site},${queueItem(q) ?? -1},${done}`);
    }
  }
  const own = new Set((FS.holdings ?? []).map(h => `${h.p},${h.q}`));
  // (`fights`: the engagements of every CLASH record read, by "p,q,bell". The program logs a CLASH for every turn
  // of a province it resolves with arrivals, also when nobody stood against them: `engagements` 0 is an arrival
  // with no fight, and is not told as a battle)
  const clashes = new Set(), fights = new Map();
  for (const x of FS.chronicle ?? []) {
    const r = x.record ?? x;
    if (r.name !== 'CLASH') continue;
    const k = `${Number(r.p)},${Number(r.q)},${Number(r.bell)}`;
    fights.set(k, Number(r.engagements ?? 1));
    if (own.has(`${Number(r.p)},${Number(r.q)}`)) clashes.add(k);
  }
  // (the results of the viewer's own explorations, from the log's EXPLORE_RESULT records: "host:turn" → Works earned)
  const explored = new Map();
  for (const x of FS.chronicle ?? []) {
    const r = x.record ?? x;
    let own = false;
    try { own = r.name === 'EXPLORE_RESULT' && !!FS.isMine?.(r); } catch { own = false; }
    if (own) explored.set(`${r.host_id},${Number(r.bell)}`, Number(r.works ?? 0));
  }
  const territory = new Map(), territoryKnown = new Set(), territorySeen = new Set();
  if (territoryEnabled(FS) && Number.isInteger(FS.citizen?.faction)) for (const key of FS.provinces?.keys?.() ?? []) {
    const [p, q] = key.split(',').map(Number), record = territoryOf(FS, p, q);
    if (record) territoryKnown.add(key);
    for (const c of record?.history ?? record?.changes ?? []) {
      if (c.to !== FS.citizen.faction && c.from !== FS.citizen.faction) continue;
      const id = `${p},${q},${c.tile},${c.bell},${c.from},${c.to},${c.reason}`;
      territorySeen.add(id);
      if (FS.survey && !FS.survey.showAll && FS.survey.levelOf(p, q, c.tile) !== 3) continue;
      territory.set(id, { ...c, p, q, mine: c.to === FS.citizen.faction, name: tileWhat(FS, p, q, c.tile).name ?? provinceName(FS, p, q) });
    }
  }
  // keep events (controller refreshKeepEvents): null until the season's days are read, so the past is not news
  const keeps = Array.isArray(FS.conquest?.events) ? new Map(FS.conquest.events.map(e => [`${e.kind}:${e.seq}`, { ...e, side: keepEventSide(e, FS.citizen?.faction) }])) : null;
  return { bell: FS.nowBell ?? null, now, keeps, territory, territoryKnown, territorySeen, marches, builds, pendingBuilds, holdings, clashes, fights, explored, incoming: new Set((FS.incoming ?? []).map(w => `${w.bell},${w.holding.p},${w.holding.q}`)) };
}

const SIDE_TEXT = { gain: () => L`あなたの国が得た`, loss: () => L`あなたの国が失った`, attack: () => L`あなたの国が攻めている`, defend: () => L`あなたの国が守っている` };

/** A keep event's notification, or null: a capture is news to everyone, a contest's start and its end only to the two nations. */
function keepItem(k, e, bell) {
  const at = { id: `kp:${k}`, kind: 'keep', bell, p: e.p, q: e.q, side: e.side };
  if (e.kind === 'keep_taken') return { ...at, text: L`州 ${e.p},${e.q} の砦を ${factionName(e.to)} が ${factionName(e.from)} から奪った（第${fmtNum(e.bell)}ターン）` };
  if (!e.side) return null;
  if (e.kind === 'keep_contest') return { ...at, text: L`州 ${e.p},${e.q} の砦を ${factionName(e.to)} が攻めはじめた（第${fmtNum(e.bell)}ターン）` };
  return { ...at, text: L`州 ${e.p},${e.q} の砦は ${factionName(e.to)} が守りきった（第${fmtNum(e.bell)}ターン）` };
}

/**
 * The notifications between two snapshots: `[{id, kind, bell, text, p, q,
 * battle?: {p, q, bell}}]`, kinds 'battle' | 'march' | 'explore' |
 * 'incoming' | 'build' | 'holding' | 'keep' (with `side`: the viewer's nation's part,
 * 'gain' | 'loss' | 'attack' | 'defend' | null). A first snapshot (prev
 * null) is not news.
 */
export function diffFeed(prev, next) {
  if (!prev) return [];
  const out = [];
  const bell = next.bell;
  // names from the two snapshots alone: a village by its place and tier, a province by the viewer's village in it
  // (else by the nation on whose side it lies), a march's destination by what stands there
  const own = { holdings: [...next.holdings.values(), ...[...prev.holdings.values()].filter(h => !next.holdings.has(`${h.p},${h.q},${h.site}`))] };
  const village = h => (Number.isInteger(h?.site) ? holdingName({ p: h.p, q: h.q, site: h.site }, h.tier ?? 0) : provinceName(own, h.p, h.q));
  const villageIn = (p, q) => { const h = own.holdings.find(x => x.p === p && x.q === q); return h ? village(h) : provinceName(own, p, q); };
  const destOf = m => m.destName ?? provinceName(own, m.dest.p, m.dest.q);
  for (const [k, m] of next.marches) {
    const was = prev.marches.get(k);
    const d = m.dest;
    if (!was) continue;
    if (!was.revealed && m.revealed && d) out.push({ id: `rv:${k}`, kind: 'march', bell, p: d.p, q: d.q, text: L`${destOf(m)}への進軍の封が開けられました` });
    if (was.pipeline !== 'resolved' && m.pipeline === 'resolved' && d) {
      // (the place by the name it had before the turn was resolved: a camp that this very clash cleared is still
      // "the camp" in the line that tells of it. With no engagement in the record nobody stood there: the host
      // simply arrived, and no battle is staged for it)
      const name = was.destName ?? destOf(m), quiet = next.fights?.get(`${d.p},${d.q},${m.bell}`) === 0;
      if (quiet) out.push({ id: `rs:${k}`, kind: 'march', bell, p: d.p, q: d.q, tile: d.tile, text: L`${name}に着きました。戦いはありませんでした（ターン ${fmtNum(m.bell)} の到着）` });
      else out.push({ id: `rs:${k}`, kind: 'battle', bell, p: d.p, q: d.q, battle: { p: d.p, q: d.q, bell: m.bell }, text: L`${name}の衝突が決着しました（ターン ${fmtNum(m.bell)} の到着）` });
    }
    if (!was.settle && m.settle && d) out.push({ id: `st:${k}`, kind: 'march', bell, p: d.p, q: d.q, text: L`${destOf(m)}への進軍の結果を受け取れます` });
  }
  for (const c of next.clashes) {
    if (prev.clashes.has(c)) continue;
    const [p, q, b] = c.split(',').map(Number);
    if (out.some(x => x.battle && x.battle.p === p && x.battle.q === q && x.battle.bell === b)) continue;
    // (an arrival nobody fought: said as what it was, with no battle to watch; the viewer's own arrival there has its own line)
    // (`quiet`: kept in the list and counted in the turn's summary, not raised as a card over the map: in a province
    // with neighbours it would be raised every turn)
    if (next.fights?.get(c) === 0) {
      if (!out.some(x => x.id.startsWith('rs:') && x.p === p && x.q === q)) out.push({ id: `cl:${c}`, kind: 'march', bell, p, q, quiet: true, text: L`${provinceName(own, p, q)}に軍勢が着きました。戦いはありませんでした（ターン ${fmtNum(b)}）` });
      continue;
    }
    out.push({ id: `cl:${c}`, kind: 'battle', bell, p, q, battle: { p, q, bell: b }, text: L`${provinceName(own, p, q)}で戦いがありました（ターン ${fmtNum(b)}）` });
  }
  for (const [k, c] of next.territory ?? []) {
    // A late resolution is still news. First loading history, or revealing an old
    // event after gaining sight, is not: remember records even while their tile is hidden.
    if (prev.territorySeen?.has(k) || !prev.territoryKnown?.has(`${c.p},${c.q}`)) continue;
    out.push({ id: `tr:${k}`, kind: 'territory', bell: c.bell, p: c.p, q: c.q, tile: c.tile,
      text: c.mine ? (c.reason === 'battle' ? L`${c.name}の戦いに勝ち、領地を獲得しました` : L`${c.name}へ到着し、領地を獲得しました`) : L`${c.name}の領地を失いました` });
  }
  if (prev.keeps && next.keeps) for (const [k, e] of next.keeps) {
    if (prev.keeps.has(k) || (Number.isInteger(bell) && e.bell < bell - KEEP_NEWS_BELLS)) continue;
    const item = keepItem(k, e, bell);
    if (item) out.push(item);
  }
  // an exploration's result: what the record says it earned (the tiles themselves are surveyed on the map). Only a
  // result of the last turns is news: older ones are the log being read up
  for (const [k, works] of next.explored ?? []) {
    if (!prev.explored || prev.explored.has(k)) continue;
    const b = Number(k.split(',')[1]);
    if (Number.isInteger(bell) && Number.isInteger(b) && bell - b > 3) continue;
    const h = own.holdings[0] ?? null;
    out.push({ id: `ex:${k}`, kind: 'explore', bell, p: h?.p, q: h?.q, text: works > 0 ? L`探索の結果が出ました：功績 +${fmtNum(works)}` : L`探索の結果が出ました：今回は功績がありませんでした` });
  }
  for (const w of next.incoming) {
    if (prev.incoming.has(w)) continue;
    const [b, p, q] = w.split(',').map(Number);
    out.push({ id: `in:${w}`, kind: 'incoming', bell, p, q, text: L`ターン ${fmtNum(b)} に、${villageIn(p, q)}へ敵が来るかもしれません` });
  }
  // A transaction can consume the completed queue before the next poll.
  const completed = new Set([...next.builds, ...[...(prev.pendingBuilds ?? [])].filter(b => {
    const parts = b.split(',');
    return next.holdings.has(parts.slice(0, 3).join(',')) && Number(parts[4]) <= next.now;
  })]);
  for (const b of completed) {
    if (prev.builds.has(b)) continue;
    const [p, q, site, kind] = b.split(',').map(Number);
    out.push({ id: `bd:${b}`, kind: 'build', bell, p, q, text: L`${BUILDINGS[BUILD_ITEMS[kind]?.resource] ?? L`建物`}が完成しました（${village(next.holdings.get(`${p},${q},${site}`) ?? { p, q, site })}）` });
  }
  for (const [k, h] of next.holdings) {
    const was = prev.holdings.get(k);
    if (!was) out.push({ id: `hn:${k}:${h.state}`, kind: 'holding', bell, p: h.p, q: h.q, text: L`${village(h)}ができました` });
    else if (was.state !== 2 && h.state === 2) out.push({ id: `hf:${k}`, kind: 'holding', bell, p: h.p, q: h.q, text: L`${village(h)}が確定しました` });
    else if (was.tier !== h.tier) out.push({ id: `ht:${k}:${h.tier}`, kind: 'holding', bell, p: h.p, q: h.q, text: Number.isInteger(h.site) ? L`${placeName(h.p, h.q, h.site)[lang() === 'en' ? 'en' : 'ja']}の村が${TIERS[h.tier] ?? ''}になりました` : L`${village(h)}になりました` });
  }
  // a village that is gone: displaced while provisional, or lost (a new village request is sent automatically)
  for (const [k, was] of prev.holdings) {
    if (next.holdings.has(k)) continue;
    // a new request follows only when no village is left (re-check 6)
    const last = next.holdings.size === 0;
    out.push({ id: `hg:${k}:${bell}`, kind: 'holding', bell, p: was.p, q: was.q, text: was.state === 2
      ? (last ? L`${village(was)}を失いました。村の申し込みを自動でもう一度出します。` : L`${village(was)}を失いました`)
      : (last ? L`仮の村（${village(was)}）は押し出されました。村の申し込みを自動でもう一度出します。` : L`仮の村（${village(was)}）は押し出されました`) });
  }
  return out;
}

/** The summary of a bell that ended: one line per kind, or null when nothing happened. */
export function bellSummary(feed, bell) {
  const of = feed.filter(x => x.bell === bell && x.kind !== 'summary');
  if (!of.length) return null;
  const n = k => of.filter(x => x.kind === k).length;
  const parts = [
    n('battle') && L`戦い ${fmtNum(n('battle'))}`, n('march') && L`進軍の知らせ ${fmtNum(n('march'))}`, n('explore') && L`探索の結果 ${fmtNum(n('explore'))}`, n('incoming') && L`来襲の恐れ ${fmtNum(n('incoming'))}`,
    n('build') && L`完成 ${fmtNum(n('build'))}`, n('holding') && L`村 ${fmtNum(n('holding'))}`, n('territory') && L`領地 ${fmtNum(n('territory'))}`, n('keep') && L`砦 ${fmtNum(n('keep'))}`, n('proto') && L`旗（試作） ${fmtNum(n('proto'))}`,
  ].filter(Boolean);
  // (a turn of which only quiet lines are known is summed up quietly too: in the list, not over the map)
  return { id: `sum:${bell}`, kind: 'summary', bell: bell + 1, text: L`ターン ${fmtNum(bell)} のまとめ：${parts.join(' · ')}`, items: of.map(x => x.id), ...(of.every(x => x.quiet) ? { quiet: true } : {}) };
}

/** Add notifications to a feed (newest first, no duplicates, at most FEED_MAX), stamping when they arrived. */
export function pushFeed(feed, items, at = Date.now()) {
  const seen = new Set(feed.map(x => x.id));
  const fresh = items.filter(x => !seen.has(x.id)).map(x => ({ ...x, at }));
  return [...fresh.reverse(), ...feed].slice(0, FEED_MAX);
}

/** A mark per kind (hud/icons.mjs); the summary of a turn carries the bell. */
export const KIND_ICON = Object.freeze({ battle: 'swords', march: 'banner', explore: 'scout', incoming: 'alert', build: 'hammer', holding: 'home', territory: 'banner', keep: 'flag', summary: 'bell', proto: 'flag' });
/** A notification's words in a list: a line of the prototype rule "banners" says 試作 first (its toast says so in its heading). */
export const lineText = x => (x.proto ? L`試作：${x.text}` : x.text);
/** The stamp of a notification: the turn it belongs to, with the bell beside it (UX design section 6, turn wording). */
const stamp = x => (Number.isInteger(x.bell) && x.kind !== 'summary' ? html`<span class="toast-stamp">${icon('bell')}${L`ターン ${fmtNum(x.bell)}`}</span>` : '');
// (`proto`: a line of the prototype rule "banners", which only a sample world that serves it writes: it says 試作 on itself)
const KIND_TEXT = { battle: () => L`戦闘`, march: () => L`進軍`, explore: () => L`探索`, incoming: () => L`来襲`, build: () => L`建設`, holding: () => L`村`, territory: () => L`領地`, keep: () => L`砦`, summary: () => L`まとめ`, proto: () => L`旗（試作）` };
/** The viewer's nation's part in a keep notification, as a tag after the text. */
const sideTag = x => (SIDE_TEXT[x.side] ? html` <span class="tag feed-side-${x.side}">${SIDE_TEXT[x.side]()}</span>` : '');

/**
 * What a notice offers: "see" goes there (a battle is played where it
 * happened), and a battle has its report.
 */
function itemActions(x) {
  const acts = [];
  if (x.battle) {
    acts.push(html`<button type="button" class="btn small go" data-act="battle-play" data-p="${x.battle.p}" data-q="${x.battle.q}" data-bell="${x.battle.bell}">${L`見る`}${icon('chevron', 'go-ic')}</button>`);
    acts.push(html`<button type="button" class="btn small" data-act="report-open" data-p="${x.battle.p}" data-q="${x.battle.q}" data-bell="${x.battle.bell}">${L`報告`}</button>`);
  } else if (Number.isInteger(x.p)) acts.push(html`<button type="button" class="btn small go" data-act="feed-go" data-id="${x.id}">${L`見る`}${icon('chevron', 'go-ic')}</button>`);
  // (a banner of the viewer's under threat, prototype rule "banners": the answer is a march that wins the tile)
  if (x.send && Number.isInteger(x.send.tile)) acts.push(html`<button type="button" class="btn small primary" data-act="proto-send" data-p="${x.send.p}" data-q="${x.send.q}" data-tile="${x.send.tile}">${icon('march')}${L`軍勢を送る`}</button>`);
  return acts;
}

/** The live, undismissed notifications: the newest TOAST_MAX. */
export function liveToasts(feed, { dismissed = new Set(), now = Date.now(), standing = null } = {}) {
  // (an alarm whose threat stands no longer is no notice any more: on real records a banner was taken and, under the
  // line that said so, 「いつ取られてもおかしくありません」 still stood with its 軍勢を送る for as long as a fresh notice lives)
  const live0 = feed.filter(x => !x.quiet && !dismissed.has(x.id) && now - (x.at ?? 0) < TOAST_MS && !(x.alarm && standing && !standing.has(x.id)));
  // (a turn's summary that sums nothing but lines of the prototype rule "banners" which are themselves still notices
  // says less than they do: on a phone, which shows one notice, 「ターン 203 のまとめ：旗（試作） 1」 stood in place of
  // 「あなたの旗がほつれました」 and of 「あなたの旗が倒されました」. It is in the list; it is no notice while they are.)
  const shown = new Map(live0.map(x => [x.id, x]));
  const live = live0.filter(x => !(x.kind === 'summary' && x.items?.length && x.items.every(id => shown.get(id)?.proto)));
  // (`standing`: the ids of alarms that still stand — a banner under threat, prototype rule "banners" —: such a notice
  // stays, first, for as long as its threat does, whatever newer notices come; a phone shows one notice, and a threat
  // that came while a sheet was open was pushed out by the next line and told only in the turn's summary)
  const alarms = standing?.size ? feed.filter(x => x.alarm && standing.has(x.id) && !dismissed.has(x.id)) : [];
  return alarms.length ? [...alarms, ...live.filter(x => !alarms.includes(x))].slice(0, TOAST_MAX) : live.slice(0, TOAST_MAX);
}

/**
 * The order of the map's stack under the status of the action in hand: this turn's own card, then the notices; with
 * `alarmsFirst` (a phone, which shows one of them) the notices of threats that still stand come before the turn's card.
 * `strip`: [] or the turn's card; `toasts`: `[{id, alarm, markup}]` in liveToasts' order.
 */
export function stackOrder(strip, toasts, { alarmsFirst = false } = {}) {
  if (!alarmsFirst) return [...strip, ...toasts];
  return [...toasts.filter(x => x.alarm), ...strip, ...toasts.filter(x => !x.alarm)];
}

/** One toast ("what happened this turn": at most three cards over the map, each with "see"). */
export function renderToast(x) {
  return html`<div class="toast toast-${x.kind}" role="status">
    <span class="toast-icon">${icon(KIND_ICON[x.kind] ?? 'flag')}</span>
    <span class="toast-text"><span class="toast-kind">${KIND_TEXT[x.kind]?.() ?? ''}${stamp(x)}</span>${x.text}${sideTag(x)}</span>
    <button type="button" class="toast-x" data-act="feed-dismiss" data-id="${x.id}" aria-label="${L`閉じる`}">${icon('close')}</button>
    ${itemActions(x).length ? html`<span class="toast-acts">${itemActions(x)}</span>` : ''}
  </div>`;
}

/** A mark per kind of own result at the turn (fx/stage.mjs `turn:results`). */
const RESULT_ICON = Object.freeze({ arrival: 'seal', battle: 'swords', incoming: 'alert' });
/**
 * What happened this turn (UX design 8.3: after the toll this turn's own results play on the map in order,
 * each offering "see"): one card over the map with a row per result. `strip` = `{turn, items: [{id, kind,
 * p, q, tile, text, battle}], demo}`; `now`: the index of the row whose mark is playing on the map (-1: none);
 * `faction`: the viewer's nation. These are the viewer's own results, so the card is headed by the viewer's own face
 * (the nation's character in the gold ring: people/faces.mjs), the bell where the nation is not known.
 */
export function renderTurnStrip(strip, { now = -1, faction = null } = {}) {
  if (!strip?.items?.length) return '';
  const see = x => (x.battle ? html`<button type="button" class="btn small go" data-act="battle-play" data-p="${x.battle.p}" data-q="${x.battle.q}" data-bell="${x.battle.bell}">${L`見る`}${icon('chevron', 'go-ic')}</button><button type="button" class="btn small" data-act="report-open" data-p="${x.battle.p}" data-q="${x.battle.q}" data-bell="${x.battle.bell}">${L`報告`}</button>`
    : Number.isInteger(x.p) ? html`<button type="button" class="btn small go" data-act="turn-go" data-id="${x.id}">${L`見る`}${icon('chevron', 'go-ic')}</button>` : '');
  const face = playerFace(faction, { size: 34, own: true });
  return html`<div class="toast turn-strip" role="status">
    ${face ? html`<span class="toast-face">${raw(face)}</span>` : html`<span class="toast-icon">${icon('bell')}</span>`}
    <span class="toast-text"><span class="toast-kind">${L`このターンのできごと`}<span class="toast-stamp">${icon('bell')}${L`ターン ${fmtNum(strip.turn)}`}</span></span></span>
    <button type="button" class="toast-x" data-act="turn-dismiss" aria-label="${L`閉じる`}">${icon('close')}</button>
    <ol class="turn-rows">${strip.items.map((x, i) => html`<li class="turn-row turn-${x.kind}${i === now ? ' now' : ''}"><span class="turn-ic">${icon(RESULT_ICON[x.kind] ?? 'flag')}</span><span class="turn-text">${x.text}</span><span class="turn-acts">${see(x)}</span></li>`)}</ol>
  </div>`;
}

/** The toasts: the newest live, undismissed notifications. */
export function renderToasts(feed, opts = {}) {
  return liveToasts(feed, opts).map(renderToast);
}

export const FEED_FILTERS = Object.freeze(['all', 'battle', 'march', 'holding']);
const FILTER_TEXT = { all: () => L`すべて`, battle: () => L`戦闘`, march: () => L`進軍と来襲`, holding: () => L`村と建設` };
const inFilter = (x, f) => f === 'all' || (f === 'battle' && (x.kind === 'battle' || x.kind === 'keep')) || (f === 'march' && (x.kind === 'march' || x.kind === 'incoming' || x.kind === 'explore')) || (f === 'holding' && (x.kind === 'holding' || x.kind === 'build' || x.kind === 'proto'));

/** How many notifications of the list stand in sight before the fold. */
export const CENTRE_SHOWN = 5;
/** The notification list ("More"): the newest in sight, the rest behind a fold. */
export function renderCentre(feed, filter = 'all') {
  const list = feed.filter(x => inFilter(x, filter));
  const rowOf = x => html`<li class="feed-${x.kind}"><span class="toast-icon">${icon(KIND_ICON[x.kind] ?? 'flag')}</span><span class="feed-text">${lineText(x)}${sideTag(x)} ${stamp(x)}</span>${itemActions(x).length ? html`<span class="toast-acts">${itemActions(x)}</span>` : ''}</li>`;
  const first = list.slice(0, CENTRE_SHOWN), rest = list.slice(CENTRE_SHOWN);
  return html`<section class="vcard" aria-labelledby="feed-title">${cardHead({ id: 'feed-title', ic: 'bell', title: L`お知らせ`, side: list.length ? chip(fmtNum(list.length)) : '' })}
    <div class="seg" role="group" aria-label="${L`絞り込み`}">${FEED_FILTERS.map(f => html`<button type="button" class="seg-btn" data-act="feed-filter" data-f="${f}" aria-pressed="${f === filter ? 'true' : 'false'}">${FILTER_TEXT[f]()}</button>`)}</div>
    ${list.length ? html`<ol class="list feed-list">${first.map(rowOf)}</ol>${rest.length ? fold('feed-old', L`もっと見る（${fmtNum(rest.length)}）`, html`<ol class="list feed-list">${rest.map(rowOf)}</ol>`) : ''}`
      : html`<p class="muted">${L`まだお知らせはありません`}</p>`}</section>`;
}

export { raw };
