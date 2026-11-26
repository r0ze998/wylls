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
import { L, fmtNum, lang, inEachLang } from '../../lang.mjs';
import { BUILDINGS, TIERS, factionName } from '../fi18n.mjs';
import { queueItem, buildItemOf } from '../fland.mjs';
import { keepEventSide, keepFromProvince } from '../fconquest.mjs';
import { holdingName } from '../people/ui.mjs';
import { playerFace } from '../people/faces.mjs';
import { placeName } from '../people/identity.mjs';
import { icon } from './icons.mjs';
import { worded, noticeText } from './words.mjs';
import { tileWhat, noticeProvince, noticeKeep } from './place.mjs';
import { cardHead, chip, fold } from '../screens/parts.mjs';
import { territoryEnabled, territoryOf } from '../territory.mjs';
import { viewClash, keepTileIn } from '../map/fog.mjs';

/**
 * (fix-loop24) A march's destination in a notification: a keep as 「州 p,q の砦」, a tile that is something (a camp, a
 * village, a Free City) by its name, any other tile — or none known — by its province, 「州 p,q」 (hud/place.mjs
 * noticeProvince). A keep's tile was named by its terrain ("Hills").
 */
export function destPlace(FS, d) {
  if (!d || !Number.isInteger(d.p) || !Number.isInteger(d.q)) return null;
  if (Number.isInteger(d.tile)) {
    const keep = keepTileIn(FS?.overviews, d.p, d.q) ?? keepFromProvince(FS?.provinces?.get?.(`${d.p},${d.q}`)?.province)?.tile ?? null;
    if (keep === d.tile) return noticeKeep(d.p, d.q);
    const w = tileWhat(FS, d.p, d.q, d.tile);
    if (w.kind !== 'land' && w.name) return w.name;
  }
  return noticeProvince(d.p, d.q);
}

export const FEED_MAX = 60;
export const TOAST_MAX = 3;
/** A notification stays a toast for this long (ms) unless dismissed; it stays in the list after. */
export const TOAST_MS = 45_000;

/** A keep event is news for this many bells after its own (a bell resolves after it ends; older ones are the record's). */
export const KEEP_NEWS_BELLS = 6;

// (fix-loop24: a kept expedition's row — wide land — has no book entry and, once its marker is gone, no transit: its own host)
const marchKey = m => String(m.entry?.host ?? m.transit?.hostId ?? m.expedition?.host ?? '');
/** (fix-loop24) A march row's arrival turn: the book's, the transit's, else a kept expedition's. */
export const marchArrive = m => m.entry?.arriveBell ?? m.transit?.arriveBell ?? m.expedition?.arriveBell ?? null;
/** (fix-loop24) A march row's stage as the feed reads it: a kept expedition resolved or settled on chain is `resolved`. */
const marchPipeline = m => m.facts?.pipeline ?? (['resolved', 'settled'].includes(m.expedition?.stage) ? 'resolved' : null);

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
    const arrive = marchArrive(m);
    // (fix-loop24, BREAK-3: the destination once known stays known for the same march — the same arrival turn —: a
    //  row read once without it (a local march whose turn record was not read in that poll) left the snapshot with
    //  `dest: null`, and neither the resolved line nor the "row gone" line below could be told: the keep march of
    //  loop-play24 was never said)
    const dest = m.dest ?? m.expedition?.dest ?? (was && was.bell === arrive ? was.dest : null);
    // (the destination's name as the page knows it now: what stands on the tile, when this browser knows the tile)
    // (once the arrival turn has ended its clash may have changed what stands there — a camp it cleared is grass —: the
    // line that tells of the clash names the place as it was when the host came to it)
    // (fix-loop24: a keep tile as the keep, not by its terrain — destPlace; without a tile the line names the province then)
    const nameNow = dest && Number.isInteger(dest.tile) ? destPlace(FS, dest) : null;
    // (B11 round 2: the same name in every language, kept beside it — a notice made later names the place in each)
    const namesNow = dest && Number.isInteger(dest.tile) ? inEachLang(() => destPlace(FS, dest)) : null;
    const ended = Number.isInteger(arrive) && Number.isInteger(FS.nowBell) && FS.nowBell > arrive;
    const kept = ended && was && was.bell === arrive && was.destName;
    const destName = kept ? was.destName : nameNow, destNames = kept ? was.destNames ?? null : namesNow;
    const same = !!was && was.bell === arrive;
    if (k) marches.set(k, { pipeline: same && was.pipeline === 'resolved' ? 'resolved' : marchPipeline(m),
      revealed: !!m.facts?.slotPresent || (same && was.revealed), settle: !!m.facts?.settleReady,
      dest, destName, destNames, bell: arrive, outcome: m.transit?.outcome ?? null });
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
  // (fix-loop14, LP14-7 — `still`: a CLASH record with no engagement AND no arrival's fate. The program also logs one
  //  for every turn a host merely STANDS on a tile of the province (a host holding a road tile or a keep: resolved
  //  again each turn), and each was told as 「…に軍勢が着きました。戦いはありませんでした」 — one line and one summary
  //  every turn, though nothing arrived. A record without `fates` (an older herald) is taken as an arrival, as before)
  const clashes = new Set(), fights = new Map(), still = new Set();
  for (const x of FS.chronicle ?? []) {
    const r = x.record ?? x;
    if (r.name !== 'CLASH') continue;
    const k = `${Number(r.p)},${Number(r.q)},${Number(r.bell)}`;
    fights.set(k, Number(r.engagements ?? 1));
    if (Number(r.engagements ?? 1) === 0 && r.fates && typeof r.fates === 'object' && Object.values(r.fates).every(v => Number(v) === 0)) still.add(k);
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
      territory.set(id, { ...c, p, q, mine: c.to === FS.citizen.faction, name: tileWhat(FS, p, q, c.tile).name ?? noticeProvince(p, q), names: inEachLang(() => tileWhat(FS, p, q, c.tile).name ?? noticeProvince(p, q)) });
    }
  }
  // keep events (controller refreshKeepEvents): null until the season's days are read, so the past is not news
  // (the fog of war of a local test world, map/fog.mjs: a keep event out of sight is not news unless the viewer's nation is in it)
  const keeps = Array.isArray(FS.conquest?.events) ? new Map(FS.conquest.events.map(e => [`${e.kind}:${e.seq}`, { ...e, side: keepEventSide(e, FS.citizen?.faction) }])
    // (verify-pr117: a keep event's place is its keep tile — map/fog.mjs clashSeen —, not any tile of its province)
    .filter(([, e]) => !Number.isInteger(e.p) || !Number.isInteger(e.q) || viewClash({ p: e.p, q: e.q, keepTile: keepTileIn(FS.overviews, e.p, e.q), mine: !!e.side }))) : null;
  // B18: the returns home of the viewer's own keep-capture donors (controller refreshKeepEvents; K-19), by seq.
  // null until the season's days are read, as `keeps`
  const mine = new Map((FS.holdings ?? []).map(h => [`${h.p},${h.q},${h.site}`, h]));
  const returns = Array.isArray(FS.conquest?.events) ? new Map((FS.conquest.returns ?? []).filter(e => mine.has(`${e.p},${e.q},${e.site}`)).map(e => [String(e.seq), e])) : null;
  return { bell: FS.nowBell ?? null, now, keeps, returns, territory, territoryKnown, territorySeen, marches, builds, pendingBuilds, holdings, clashes, fights, still, explored, incoming: new Set((FS.incoming ?? []).map(w => `${w.bell},${w.holding.p},${w.holding.q}`)) };
}

/** How many of the viewer's own resolved marches the page keeps (`ownClashes`). */
export const OWN_CLASHES_MAX = 24;
/**
 * (fix-loop22, LP22-4) The viewer's own clashes, kept after their march rows leave the page's list: `list` (newest
 * first, `{p, q, tile, bell}`) with every march of snapshot `next` whose turn is resolved, and every march of `prev`
 * that is gone from `next` after its arrival turn ended. The march row is the page's only record of a march to a
 * province the viewer holds no village in; once it went, the report, "Other → Battles" and the guide forgot the march
 * (loop-play22: the keep march that retreated). Page memory only, of this viewer and world (controller.mjs clears it).
 */
export function ownClashesFrom(list, prev, next) {
  const out = [...(list ?? [])];
  const add = (d, bell) => { if (d && Number.isInteger(bell) && !out.some(x => x.p === d.p && x.q === d.q && x.bell === bell)) out.unshift({ p: d.p, q: d.q, tile: d.tile ?? null, bell }); };
  for (const m of next?.marches?.values() ?? []) if (m.pipeline === 'resolved') add(m.dest, m.bell);
  for (const [k, m] of prev?.marches ?? []) if (!next?.marches?.has(k) && Number.isInteger(next?.bell) && Number.isInteger(m.bell) && next.bell > m.bell) add(m.dest, m.bell);
  return out.sort((a, b) => b.bell - a.bell).slice(0, OWN_CLASHES_MAX);
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
 * null) is not news. Each notice carries `words` (its text in every language, as of now: hud/words.mjs), so that it
 * follows a later switch of language (B11).
 */
export const diffFeed = (prev, next) => worded(() => diffFeedNow(prev, next));
function diffFeedNow(prev, next) {
  if (!prev) return [];
  const out = [];
  const bell = next.bell;
  // names from the two snapshots alone: a village by its place and tier, a province by the viewer's village in it
  // (else by the nation on whose side it lies), a march's destination by what stands there
  const own = { holdings: [...next.holdings.values(), ...[...prev.holdings.values()].filter(h => !next.holdings.has(`${h.p},${h.q},${h.site}`))] };
  const village = h => (Number.isInteger(h?.site) ? holdingName({ p: h.p, q: h.q, site: h.site }, h.tier ?? 0) : noticeProvince(h.p, h.q));
  const villageIn = (p, q) => { const h = own.holdings.find(x => x.p === p && x.q === q); return h ? village(h) : noticeProvince(p, q); };
  // (a kept name in the language of this run when the snapshot has it in every language: B11 round 2)
  const named = (names, name) => names?.[lang()] ?? name ?? null;
  const destOf = m => named(m.destNames, m.destName) ?? noticeProvince(m.dest.p, m.dest.q);
  for (const [k, m] of next.marches) {
    const was = prev.marches.get(k);
    const d = m.dest;
    if (!was) continue;
    if (!was.revealed && m.revealed && d) out.push({ id: `rv:${k}`, kind: 'march', bell, p: d.p, q: d.q, text: L`${destOf(m)}への進軍の封が開けられました` });
    if (was.pipeline !== 'resolved' && m.pipeline === 'resolved' && d) {
      // (the place by the name it had before the turn was resolved: a camp that this very clash cleared is still
      // "the camp" in the line that tells of it. With no engagement in the record nobody stood there: the host
      // simply arrived, and no battle is staged for it)
      const name = named(was.destNames, was.destName) ?? destOf(m), quiet = next.fights?.get(`${d.p},${d.q},${m.bell}`) === 0;
      if (quiet) out.push({ id: `rs:${k}`, kind: 'march', bell, p: d.p, q: d.q, tile: d.tile, text: L`${name}に着きました。戦いはありませんでした（ターン ${fmtNum(m.bell)} の到着）` });
      else out.push({ id: `rs:${k}`, kind: 'battle', bell, p: d.p, q: d.q, battle: { p: d.p, q: d.q, bell: m.bell }, text: L`${name}の衝突が決着しました（ターン ${fmtNum(m.bell)} の到着）` });
    }
    if (!was.settle && m.settle && d) out.push({ id: `st:${k}`, kind: 'march', bell, p: d.p, q: d.q, text: L`${destOf(m)}への進軍の結果を受け取れます` });
  }
  // (fix-loop22, LP22-4: a march whose row left the page's list in the same poll its turn was resolved — a march to a
  //  province the viewer holds no village in is read only while its transit stands — was told by nobody: the keep march
  //  that retreated had no line in "More → Notifications". Its arrival turn has ended and it was never told resolved:
  //  told now, as the same line with the same id, so it is said once)
  for (const [k, was] of prev.marches) {
    if (next.marches.has(k) || was.pipeline === 'resolved' || !was.dest || !Number.isInteger(was.bell) || !Number.isInteger(bell) || bell <= was.bell) continue;
    const d = was.dest, name = named(was.destNames, was.destName) ?? noticeProvince(d.p, d.q), quiet = next.fights?.get(`${d.p},${d.q},${was.bell}`) === 0;
    if (quiet) out.push({ id: `rs:${k}`, kind: 'march', bell, p: d.p, q: d.q, tile: d.tile, text: L`${name}に着きました。戦いはありませんでした（ターン ${fmtNum(was.bell)} の到着）` });
    else out.push({ id: `rs:${k}`, kind: 'battle', bell, p: d.p, q: d.q, battle: { p: d.p, q: d.q, bell: was.bell }, mine: true, text: L`${name}の衝突が決着しました（ターン ${fmtNum(was.bell)} の到着）` });
  }
  for (const c of next.clashes) {
    if (prev.clashes.has(c)) continue;
    const [p, q, b] = c.split(',').map(Number);
    if (out.some(x => x.battle && x.battle.p === p && x.battle.q === q && x.battle.bell === b)) continue;
    // (an arrival nobody fought: said as what it was, with no battle to watch; the viewer's own arrival there has its own line)
    // (`quiet`: kept in the list and counted in the turn's summary, not raised as a card over the map: in a province
    // with neighbours it would be raised every turn)
    if (next.still?.has(c)) continue;   // (LP14-7: nobody arrived and nobody fought — a host only stood there: not news)
    if (next.fights?.get(c) === 0) {
      if (!out.some(x => x.id.startsWith('rs:') && x.p === p && x.q === q)) out.push({ id: `cl:${c}`, kind: 'march', bell, p, q, quiet: true, text: L`${noticeProvince(p, q)}に軍勢が着きました。戦いはありませんでした（ターン ${fmtNum(b)}）` });
      continue;
    }
    out.push({ id: `cl:${c}`, kind: 'battle', bell, p, q, battle: { p, q, bell: b }, text: L`${noticeProvince(p, q)}で戦いがありました（ターン ${fmtNum(b)}）` });
  }
  for (const [k, c] of next.territory ?? []) {
    // A late resolution is still news. First loading history, or revealing an old
    // event after gaining sight, is not: remember records even while their tile is hidden.
    if (prev.territorySeen?.has(k) || !prev.territoryKnown?.has(`${c.p},${c.q}`)) continue;
    out.push({ id: `tr:${k}`, kind: 'territory', bell: c.bell, p: c.p, q: c.q, tile: c.tile, ...(c.mine ? {} : { lost: true }),
      text: c.mine ? (c.reason === 'battle' ? L`${named(c.names, c.name)}の戦いに勝ち、領地を獲得しました` : L`${named(c.names, c.name)}へ到着し、領地を獲得しました`) : L`${named(c.names, c.name)}の領地を失いました` });
  }
  if (prev.keeps && next.keeps) for (const [k, e] of next.keeps) {
    if (prev.keeps.has(k) || (Number.isInteger(bell) && e.bell < bell - KEEP_NEWS_BELLS)) continue;
    const item = keepItem(k, e, bell);
    if (item) out.push(item);
  }
  // B18: the host that took a keep left part of itself as the keep's garrison and went home with the rest (K-19)
  // ("go back", not "are back": the record is logged with the capture; the reserve is credited by the return's settle,
  //  seen live one turn later — fix-ui-b17-b21)
  if (prev.returns && next.returns) for (const [k, e] of next.returns) {
    if (prev.returns.has(k) || (Number.isInteger(bell) && e.bell < bell - KEEP_NEWS_BELLS)) continue;
    const home = village(next.holdings.get(`${e.p},${e.q},${e.site}`) ?? { p: e.p, q: e.q, site: e.site });
    out.push({ id: `kr:${k}`, kind: 'keep', bell, p: e.p, q: e.q, side: 'gain', text: L`砦を取った軍勢は、一部を砦の守備兵に残し、残りの ${fmtNum(e.troops)} 人は${home}の控えに戻ります。戻ったあと、村でもう一度、軍勢に編成できます。` });
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
    out.push({ id: `bd:${b}`, kind: 'build', bell, p, q, text: L`${BUILDINGS[buildItemOf(kind)?.resource] ?? L`建物`}が完成しました（${village(next.holdings.get(`${p},${q},${site}`) ?? { p, q, site })}）` });
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
    // (`lost`: a final village taken — an attack, hud/notify.mjs —; a provisional one pushed out is not)
    out.push({ id: `hg:${k}:${bell}`, kind: 'holding', bell, p: was.p, q: was.q, ...(was.state === 2 ? { lost: true } : {}), text: was.state === 2
      ? (last ? L`${village(was)}を失いました。村の申し込みを自動でもう一度出します。` : L`${village(was)}を失いました`)
      : (last ? L`仮の村（${village(was)}）は押し出されました。村の申し込みを自動でもう一度出します。` : L`仮の村（${village(was)}）は押し出されました`) });
  }
  return out;
}

/** The kinds the turn's summary counts by name (bellSummaryNow); a line of any other kind is counted as 「知らせ」. */
export const SUMMED_KINDS = Object.freeze(['battle', 'march', 'explore', 'incoming', 'build', 'holding', 'territory', 'keep', 'proto', 'goal']);
/** The summary of a bell that ended: one line per kind, or null when nothing happened (with `words`, as diffFeed's). */
export const bellSummary = (feed, bell) => worded(() => bellSummaryNow(feed, bell));
function bellSummaryNow(feed, bell) {
  const of = feed.filter(x => x.bell === bell && x.kind !== 'summary');
  if (!of.length) return null;
  const n = k => of.filter(x => x.kind === k).length;
  const parts = [
    n('battle') && L`戦い ${fmtNum(n('battle'))}`, n('march') && L`進軍の知らせ ${fmtNum(n('march'))}`, n('explore') && L`探索の結果 ${fmtNum(n('explore'))}`, n('incoming') && L`来襲の恐れ ${fmtNum(n('incoming'))}`,
    n('build') && L`完成 ${fmtNum(n('build'))}`, n('holding') && L`村 ${fmtNum(n('holding'))}`, n('territory') && L`領地 ${fmtNum(n('territory'))}`, n('keep') && L`砦 ${fmtNum(n('keep'))}`, n('proto') && L`旗（試作） ${fmtNum(n('proto'))}`,
    // (fix-loop13: a world-goals achievement — hud/worldgoals.mjs achievementNews — is counted by name; the summary said 「ターン 179 のまとめ：」 and nothing)
    n('goal') && L`世界の目標 ${fmtNum(n('goal'))}`,
  ].filter(Boolean);
  // (fix-loop15, LP15-7: a line of a kind with no name of its own above — a caravan's or a storehouse's news, kind
  //  's1' — was counted by nobody: 「ターン 14 のまとめ：」 / "Turn 183 in brief:" and nothing. Every line the summary
  //  folds is counted now: those kinds together, as 「知らせ」 alone or 「ほかの知らせ」 beside the named ones)
  const rest = of.filter(x => !SUMMED_KINDS.includes(x.kind)).length;
  if (rest) parts.push(parts.length ? L`ほかの知らせ ${fmtNum(rest)}` : L`知らせ ${fmtNum(rest)}`);
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
export const KIND_ICON = Object.freeze({ battle: 'swords', march: 'banner', explore: 'scout', incoming: 'alert', build: 'hammer', holding: 'home', territory: 'banner', keep: 'flag', summary: 'bell', proto: 'flag', away: 'bell', s1: 'flag', goal: 'flag' });
/** A notification's words in a list: a line of the prototype rule "banners" says 試作 first (its toast says so in its heading). */
export const lineText = x => (x.proto ? L`試作：${noticeText(x)}` : noticeText(x));
/** The stamp of a notification: the turn it belongs to, with the bell beside it (UX design section 6, turn wording). */
const stamp = x => (Number.isInteger(x.bell) && x.kind !== 'summary' ? html`<span class="toast-stamp">${icon('bell')}${L`ターン ${fmtNum(x.bell)}`}</span>` : '');
// (`proto`: a line of the prototype rule "banners", which only a sample world that serves it writes: it says 試作 on itself)
const KIND_TEXT = { battle: () => L`戦闘`, march: () => L`進軍`, explore: () => L`探索`, incoming: () => L`来襲`, build: () => L`建設`, holding: () => L`村`, territory: () => L`領地`, keep: () => L`砦`, summary: () => L`まとめ`, proto: () => L`旗（試作）`, away: () => L`留守のあいだ`, s1: () => L`隊商と国`, goal: () => L`世界の目標` };
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
  // (the away summary: "seen" moves the player's own mark; closing it does not — hud/returnsum.mjs. With a gap in what
  // was read, or nothing new, there is no "seen": the notice says why, and × only closes it)
  if (x.kind === 'away' && x.away && x.away.ok !== false) acts.push(html`<button type="button" class="btn small primary" data-act="away-seen" data-id="${x.id}">${L`確認した`}</button>`);
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
  // (fix-loop7, LP7-8: a short sentence on the toast; its careful account, when the item has one, as the hover title)
  return html`<div class="toast toast-${x.kind}" role="status"${x.hint ? html` title="${x.hint}"` : ''}>
    <span class="toast-icon">${icon(KIND_ICON[x.kind] ?? 'flag')}</span>
    <span class="toast-text"><span class="toast-kind">${KIND_TEXT[x.kind]?.() ?? ''}${stamp(x)}</span>${noticeText(x)}${sideTag(x)}</span>
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
    <ol class="turn-rows">${strip.items.map((x, i) => html`<li class="turn-row turn-${x.kind}${i === now ? ' now' : ''}"><span class="turn-ic">${icon(RESULT_ICON[x.kind] ?? 'flag')}</span><span class="turn-text">${noticeText(x)}</span><span class="turn-acts">${see(x)}</span></li>`)}</ol>
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
