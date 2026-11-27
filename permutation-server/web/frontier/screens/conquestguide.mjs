// The guide on a conquest season (program version 3): seven steps from the
// first village to a province taken, each ticked from the records the page
// holds and from nothing else —
//   1 the first village      the viewer's Holding
//   2 train                  troops in the reserve, or a combat host
//   3 form a host            a combat host of the viewer in a province record
//   4 raid a camp            (pt-first-battle, owner 2026-11-26 15:48 Q-PT-2 "march first") a march of the viewer has
//                            left — to the nearest barbarian camp the host can beat (hud/firstbattle.mjs campChoice), or
//                            anywhere —, or the step was skipped. Its report is the first battle the viewer checks.
//   5 build                  the Holding's queue or its production above the base (done while the first march walks;
//                            a building does not pass the steps before it: reach ignores it)
//   6 march on a keep        a march of the viewer to a province whose keep another nation holds, or
//                            a host of the viewer standing on such a keep's tile; a march whose turn is
//                            resolved with no host left on the tile and no contest is turned back, and
//                            the step is current again (it says so, and what the keeps take)
//   7 hold it for 72 turns   that keep's record names the viewer's nation as the contender, the keep being one the
//                            viewer's own host stands on or own march is bound for: its count
//   8 the capture            a capture record (keep_taken) to the viewer's nation, or the keep's holder
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
import { conquestOn, heartlandOnlyKeeps, holdTurns, hostWaits, waitOf, waitText, keepsModel, arrivalOdds, roughAt, choosableWait } from '../hud/keephand.mjs';
import { keepArrival } from '../hud/rulebook.mjs';
import { provinceName } from '../hud/place.mjs';
import { hostRows } from './host.mjs';
import { cardHead } from './parts.mjs';
import { viewKeeps, fogNow } from '../map/fog.mjs';
import { holdingModel } from './holding.mjs';
import { worldContinues } from '../clock.mjs';
import { turnsLine } from '../seasonterms.mjs';
import { maxTrain } from '../hud/rulebook.mjs';
import { marchOpenFor, marchClosedText, formingHosts, stoodHosts, formingLine, whileWaiting, whileWaitingLine } from '../hud/firststeps.mjs';
import { campChoice, campsSittingOut, fightingCampsInSight, earliestReportAt, reportEtaAt, ownReportDue, ownProvinceOf, CAMP_GARRISON_CAP } from '../hud/firstbattle.mjs';
import { planRoute, arrivalWindow } from '../fmarch.mjs';
import { MAX_PATH_STEPS } from '../seal.mjs';
import { MAX_ROUTE_PROVINCES } from '../fkeepreach.mjs';
import { palisadeHexesOf } from '../s1walk.mjs';
import { routeArrival } from './march.mjs';
import { viewTile } from '../map/fog.mjs';
import { dueText } from './shell.mjs';
import { villageConfirm, confirmPending, confirmLine, joinSentences } from '../hud/provisional.mjs';
import { FLAG } from '../onboarding.mjs';

export const CONQUEST_STEPS = Object.freeze(['village', 'train', 'muster', 'camp', 'build', 'march', 'hold', 'capture']);
/** Steps that never pass the ones before them (a building is a side step of the first hour, not progress toward a keep). */
const SIDE_STEPS = new Set(['build']);
const int = Number.isInteger;

const keepsOf = FS => (FS.conquest?.keeps instanceof Map ? [...viewKeeps(FS.conquest.keeps).values()] : []);

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
  // (fix-loop22, LP22-4: once the march row has left the list, the viewer's own resolved clash on a keep it does not stand
  //  on and its nation does not contest — hud/feed.mjs ownClashesFrom — is the same fact. The guide said 「砦のマスを
  //  72 ターン保つ … 着いて勝てば」 with 「砦へ進軍」 ticked after the host had bounced home)
  const gone = back ? null : (FS.ownClashes ?? []).find(c => {
    const k = keeps.find(x => x.p === c.p && x.q === c.q && foreign(x) && (c.tile === null || c.tile === undefined || x.tile === c.tile));
    return !!k && !(standing && standing.p === k.p && standing.q === k.q) && !(int(f) && k.contender === f) && !(FS.marches ?? []).some(m => m?.dest && m.dest.p === c.p && m.dest.q === c.q)
      // (a later march sealed to the same keep is a new try, not the old loss)
      && !(FS.orders ?? []).some(o => o?.kind === 'march' && o.state !== 'refused' && o.dest?.p === c.p && o.dest?.q === c.q && Number(o.arriveBell) > c.bell);
  }) ?? null;
  const repelled = back ? { p: back.dest.p, q: back.dest.q, bell: back.entry?.arriveBell ?? back.transit?.arriveBell ?? null } : gone ? { p: gone.p, q: gone.q, bell: gone.bell } : null;
  const revealed = live.map(keepOf).find(Boolean) ?? null;
  // (verify-pr193: a march order the page was answered "no" for — refused before sending, refused on chain, or read
  //  `expired` — never went: it is not "marched". It moved the guide to 「5/7 砦を見る」 with no march out)
  const sealed = (FS.orders ?? []).map(o => (o?.kind === 'march' && o.state !== 'refused' && o.dest ? keeps.find(k => k.p === o.dest.p && k.q === o.dest.q && k.tile === o.dest.tile) ?? null : null))
    .find(k => k && !(repelled && repelled.p === k.p && repelled.q === k.q)) ?? null;
  // the contest the viewer is part of: its nation is the contender of the keep the viewer's own host stands on, or the
  // viewer's own march is bound for. Not any keep its nation contends: in a world with others in the nation (people or
  // bots) one of them is nearly always holding a keep somewhere, and a newcomer who had not even formed a host — or
  // whose own march was turned back — read "hold the keep's tile for 72 turns" (the live check of 2026-10-26)
  const mine = k => int(f) && k.contender === f;
  const contest = [standing, revealed, sealed].find(k => k && mine(k)) ?? null;
  const gain = (FS.conquest?.events ?? []).filter(e => e.kind === 'keep_taken' && e.to === f).at(-1) ?? null;
  const target = contest ?? standing ?? revealed ?? sealed ?? null;
  // (round 46, seen in live33: a host out on a march is in no province record the page holds until its arrival is read;
  // the guide then counted no host and fell back to "build" (1/7) mid-march. The viewer's own march list says a host
  // stood and is away)
  const away = (FS.marches ?? []).length > 0;
  // (pt-first-battle) the first march has left: any march of the viewer — on the page's list, counted by the Citizen
  // (`arrivals`), or sealed by this page and not answered "no" — or the step was skipped by the viewer
  const sentOrder = (FS.orders ?? []).some(o => o?.kind === 'march' && o.state !== 'refused');
  const raided = away || Number(FS.citizen?.arrivals ?? 0) > 0 || sentOrder || (FS.ui?.dismissed ?? []).includes(FLAG.skip('camp'));
  return { village: !!h, built: !!h && (hasBuilt(h, now) || (h.queue ?? []).some(q => q && q.kind === 1)), trained: !!base.trainedCombat, host: !!base.ownCombatHost || rows.length > 0 || away,
    // (a host that stands in the record — formed, or out on a march: the muster step is done only then, not while it forms)
    stood: stoodHosts(rows).length > 0 || away, forming: formingHosts(rows)[0] ?? null,
    marched: !!(standing || revealed || sealed || contest || gain), raided,
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
  const rank = { good: 2, even: 1, poor: 0 };
  // (fix-loop22: a row whose odds only the order card's forecast can tell — other hosts on the keep's tile, keephand.mjs
  //  arrivalOdds 'hosts' — is no measure here: never read as "low odds")
  try { const km = keepsModel(FS, r); rows = km.state === 'ready' ? km.rows.filter(x => x.odds && x.odds.odds in rank) : []; } catch { rows = []; }
  if (rows.length) {
    const x = rows.reduce((a, b) => (rank[b.odds.odds] > rank[a.odds.odds] || (rank[b.odds.odds] === rank[a.odds.odds] && b.troops < a.troops) ? b : a));
    return { odds: x.odds.odds, need: x.odds.need, troops: x.troops };
  }
  const t = keepTarget(FS);
  if (!t) return null;
  const o = arrivalOdds(FS, r, t);
  return o && o.odds in rank ? { odds: o.odds, need: o.need, troops: t.troops } : null;
}

/** (fix-loop6, LP6-4) The host's own list of reachable keeps has been read and holds none (keepsModel 'ready', 0 rows). */
function noVisibleReach(FS, r) {
  try { const km = keepsModel(FS, r); return km.state === 'ready' && km.rows.length === 0; } catch { return false; }
}

/**
 * (w2-wipeout, D-verify-pr137-3) The next army when the viewer has no host that can march: the press that starts it
 * from the active village — 「編成」 when its reserve holds a host's worth of combat troops, else 「訓練」. Opens the
 * village's card only (cg-go); nothing is sent. `{pop: 'train' | 'muster', go}`.
 */
export function nextArmyGo(FS) {
  const h = activeHolding(FS) ?? null;
  const ready = !!h && [0, 1, 2, 3, 4, 5].some(u => Number(h.reserve?.[u] ?? 0) >= 100);
  return ready ? { pop: 'muster', go: { act: 'cg-go', data: { pop: 'muster' }, label: L`次の軍勢を編成する` } }
    : { pop: 'train', go: { act: 'cg-go', data: { pop: 'train' }, label: L`次の軍勢の兵を訓練する` } };
}

/**
 * (w2-wipeout, D-verify-pr137-3) After a capture — the guide's seven steps are done — the next thing: a host that can
 * march goes on to another keep; one forming is waited for; with none (the capturing host stays on as the keep's
 * garrison), a new army is raised (nextArmyGo). `{text, go}`; never null, the card is never a dead end.
 */
export function afterCapture(FS) {
  let rows = [];
  try { rows = hostRows(FS).filter(r => r.unit !== SCOUT && r.unit !== SETTLER); } catch { rows = []; }
  const ready = rows.find(r => !waitOf(FS, r)) ?? null;
  if (ready) return { text: L`次の州を狙うなら、軍勢（${unitCount(UNIT_ORDER[ready.unit], Math.floor(Number(ready.troops)))}）で次の砦へ進軍します。`, go: { act: 'cg-go', data: { pop: 'keeps', host: String(ready.id) }, label: L`届く砦を見る` } };
  if (rows.length) return { text: L`次の州を狙う軍勢が整うのを待っています。`, go: { act: 'tab', data: { tab: 'hosts' }, label: L`軍勢の準備を確かめる` } };
  const n = nextArmyGo(FS);
  return { text: n.pop === 'muster' ? L`砦を奪った軍勢は、砦の守備兵として残りました。いま進軍できる軍勢はいません。次の州を狙うなら、控えの兵で新しい軍勢を編成します。`
    : L`砦を奪った軍勢は、砦の守備兵として残りました。いま進軍できる軍勢はいません。次の州を狙うなら、まず兵を訓練して新しい軍勢を作ります。`, go: n.go };
}

/**
 * (verify-pr176) The viewer's marches as the "no host left" line reads them: `pending` — still out (a march not yet
 * settled; its survivors, if any, come home with the settlement) — and `wiped`, a march settled as 壊滅 (Destroyed).
 * A settled march of any other outcome has brought its survivors home already: it is not "still out". An expedition
 * row (TEST-only wide play, flocalplay-expedition.mjs) has no settlement facts: it is over once it was wiped out
 * (fate destroyed), took the keep (its host is the garrison) or was beaten off the keep's tile — what the expedition
 * card's 「次の軍勢」 line says (tracker.mjs expeditionNextText). Before, every expedition row and every settled
 * non-Destroyed march counted as "still out" for good.
 */
export function marchesLeft(FS) {
  const marches = FS.marches ?? [];
  const xOver = x => x.hold?.outcome === 'taken' || (x.stage === 'settled' && x.fate === 'destroyed') || (x.hold?.outcome === 'lost' && x.hold.why === 'gone');
  const over = m => (m?.expedition ? xOver(m.expedition) : !!m?.facts?.settled);
  const wiped = marches.find(m => (m?.expedition ? m.expedition.stage === 'settled' && m.expedition.fate === 'destroyed' : m?.facts?.settled?.outcome === 'Destroyed')) ?? null;
  return { wiped, pending: marches.filter(m => !over(m)) };
}

/**
 * (fix-loop12, LP12-3) A march of the viewer that is out — not settled — and whose destination the page does not know
 * (sealed: no `dest` on its row; a local-play march after a reload): `{arrive}` (its arrival turn, when the transit says
 * it), or null. An expedition row is not one: it always names its destination.
 */
export function sealedMarch(FS) {
  const m = marchesLeft(FS).pending.find(x => !x?.expedition && !x?.dest) ?? null;
  if (!m) return null;
  const arrive = m.entry?.arriveBell ?? m.transit?.arriveBell ?? null;
  return { arrive: Number.isInteger(arrive) ? arrive : null };
}

const TITLE = {
  village: () => L`最初の村`, build: () => L`建物を建てる`, train: () => L`兵を訓練する`, muster: () => L`軍勢を編成する`,
  camp: () => L`近くの蛮族の野営地を襲う`, march: () => L`砦へ進軍する`, hold: hold => L`砦のマスを ${fmtNum(hold)} ターン保つ`, capture: () => L`州を奪う`,
};

/**
 * The guide's state: `{steps: [{id, title, status: 'done' | 'current' | 'todo'}], current (an id, or 'done'), n, total,
 * facts}`. A later step that the records already show is ticked whatever came before it (a capture is a capture).
 */
export function conquestGuide(FS) {
  // (no guide to a capture in a world opened only to the heartlands, where no keep can ever be taken — heartlandOnlyKeeps)
  if (!conquestOn(FS) || heartlandOnlyKeeps(FS)) return null;
  const x = conquestFacts(FS), hold = holdTurns(FS);
  const captured = !!x.captured;
  const done = { village: x.village, train: x.trained || x.host, muster: x.stood || x.marched, camp: x.raided || x.marched || captured, build: x.built, march: x.marched, hold: captured, capture: captured };
  // the step that is next is the one after the furthest the records show (a player who has marched is not sent back to
  // "build" because the village's queue is empty): what lies before it and is not in the records now reads as passed.
  // (pt-first-battle: a building — the side step — passes nothing: a newcomer who built first is still led to the camp)
  const reach = CONQUEST_STEPS.reduce((a, id, i) => (done[id] && !SIDE_STEPS.has(id) ? i : a), -1);
  const current = CONQUEST_STEPS.find((id, i) => i > reach && !done[id]) ?? 'done';
  const steps = CONQUEST_STEPS.map((id, i) => ({ id, title: TITLE[id](hold), status: done[id] || i < reach ? 'done' : id === current ? 'current' : 'todo' }));
  // (the count of the steps done: a building counts though it passes nothing)
  return { steps, current, n: steps.filter(x => x.status === 'done').length, total: CONQUEST_STEPS.length, facts: x };
}

/**
 * What to suggest while host row `r` forms (hud/firststeps.mjs whileWaiting), from the active village's stores and
 * queue and the usual keep `t` (keepTarget): troops toward its need, or a free building slot. Null for nothing.
 */
function waitingSuggestion(FS, r, t) {
  let m = null;
  try { m = holdingModel(FS); } catch { m = null; }
  if (!m) return null;
  const reserve = Number(activeHolding(FS)?.reserve?.[r.unit] ?? 0);
  let canTrain = 0;
  try { canTrain = maxTrain(r.unit, m.have ?? [], FS.season?.programVersion); } catch { canTrain = 0; }
  return whileWaiting({ need: t?.need ?? null, troops: Number(r.troops) || 0, reserve, canTrain: m.blocks?.Train?.length ? 0 : canTrain,
    freeSlots: Math.max(0, (m.slots ?? 0) - (m.queue?.length ?? 0)), buildBlocked: !!m.blocks?.Build?.length });
}

/**
 * (pt-first-battle, owner 2026-11-26 15:48 Q-PT-2) The "march first" step: the nearest barbarian camp the ready host
 * beats even at the worst roll (hud/firstbattle.mjs campChoice; under the fog only camps on surveyed tiles, as the march
 * card's "nearby destinations"), with when the first battle report can be expected. `{text, go, wait}`. Nothing is sent:
 * the press opens the march card with the camp filled in (app.mjs guideGo, guideTarget's `camp`), where the rules'
 * forecast and the seal are.
 */
export function campStep(FS) {
  let rows = [];
  try { rows = hostRows(FS).filter(r => r.unit !== SCOUT && r.unit !== SETTLER); } catch { rows = []; }
  // (a formed host whose province is only finishing the last turn counts as ready — keephand.mjs choosableWait, the keep
  //  list's own rule: the march card holds the seal and sends it once the province has caught up. At ×60 every turn
  //  change made the step flip to 「軍勢の準備を確かめる」 for a moment, and a press then opened the host list)
  const ready = rows.find(r => choosableWait(waitOf(FS, r), r)) ?? null;
  const now = FS.chain?.now?.() ?? null;
  const skip = L`この手順は飛ばせます（飛ばすと建設へ進みます）。`;
  if (!ready) {
    const w = hostWaits(FS)[0] ?? null;
    return { text: w ? waitText(w, FS) : L`野営地へ向かう軍勢がいません。訓練して軍勢を編成します。`, go: w ? { act: 'tab', data: { tab: 'hosts' }, label: L`軍勢の準備を確かめる` } : nextArmyGo(FS).go, wait: w ? L`軍勢の準備を待つ` : null };
  }
  const who = unitCount(UNIT_ORDER[ready.unit], Math.floor(Number(ready.troops)));
  // (this page cannot send a march in this world: said as the keep step says it, and the step can be skipped)
  if (!marchOpenFor(FS)) return { text: L`${who}の軍勢が立ちました。${marchClosedText(FS)}${skip}`, go: { act: 'ob-skip', data: { step: 'camp' }, label: L`この手順を飛ばす` }, wait: null };
  const seen = (p, q, t) => viewTile(p, q, t, 2);
  // (fix-loop25, Q-PM2-1 (a): the guide's one fog exception — a camp in a province of the viewer's OWN village is named
  //  under the fog too, by position and whether it fights; hud/firstbattle.mjs ownProvinceOf says exactly what and why)
  const own = ownProvinceOf(FS);
  const c = campChoice(FS, ready, { seen, own, rough: (p, q, t) => roughAt(FS, p, q, t), reach: camp => campReach(FS, ready, camp) });
  // (fix-firstcamp, Q-LP22-1 (a): a camp in a province of 12 villages sits every battle out — the march there was a
  //  non-battle, "Held", no losses — so the guide passes it by and says why)
  const sitOut = c ? c.passed : campsSittingOut(FS, ready, { seen, own });
  // (named by the viewer's own village where it has one: in --demo the camp passed by is in the home province)
  const out = sitOut.length ? L`${provinceName(FS, sitOut[0].p, sitOut[0].q)}の野営地は近くにありますが、その州には村が ${fmtNum(CAMP_GARRISON_CAP)} 立っているため、戦いに加わりません（野営地が戦うのは、州の村が ${fmtNum(CAMP_GARRISON_CAP)} 未満のときだけです）。` : '';
  // the way there and when the march would arrive (tiles, provinces, the arrival turn and its wait in the report line's words), and
  // the report expected after that arrival turn; without a route, the earliest a sealed march can be reported
  const way = c ? campWay(FS, ready, c.camp) : null;
  const at = way?.arrive ? reportEtaAt(FS.clock, way.arrive.bell) : earliestReportAt(FS.clock, FS.nowBell, FS.season);
  const eta = at !== null ? (way?.arrive ? L`封をして出発すると、最初の戦いの報告は${dueText(at, now)}に出る見込みです。` : L`封をして出発すると、最初の戦いの報告は早くて${dueText(at, now)}に出ます。`) : '';
  const road = way?.line ? L`道のり：${way.line}。` : '';
  // (fix-loop25: a camp named only by the exception — its tile under the fog — is said without its defender count, as the
  //  march card says none for a tile out of sight; the odds and the troops advised are the page's own copy of the clash)
  const fogNote = c?.camp?.fogged ? L`この野営地はあなたの村の州にあるため、霧の中でも場所だけを示しています（守り手の数は、見えるところまで近づくとわかります）。` : '';
  if (c?.winnable && c.camp.fogged) {
    return { text: out + L`最初の戦いは、${provinceName(FS, c.camp.p, c.camp.q, { own: false })}の蛮族の野営地にしましょう。${fogNote}いまの軍勢（${who}）なら、運が悪くても勝てる見込みです。${road + eta}報告は、このブラウザで計算し直して確かめられます。`,
      go: { act: 'ob-go', data: {}, label: L`この野営地へ進軍を準備する` }, wait: null };
  }
  if (c?.winnable) {
    return { text: out + L`最初の戦いは、${provinceName(FS, c.camp.p, c.camp.q, { own: false })}の蛮族の野営地（守り手 ${fmtNum(c.camp.troops)}）にしましょう。いまの軍勢（${who}）なら、運が悪くても勝てる見込みです。${road + eta}報告は、このブラウザで計算し直して確かめられます。`,
      go: { act: 'ob-go', data: {}, label: L`この野営地へ進軍を準備する` }, wait: null };
  }
  if (c) {
    const need = c.need ? L`${unitCount(UNIT_ORDER[ready.unit], c.need)} ほどにすると、運が悪くても勝てる見込みです。` : '';
    const chance = c.odds === 'even' ? L`勝ち目は五分です。` : L`勝ち目は低いです。`;
    if (c.camp.fogged) {
      return { text: out + L`いちばん近い蛮族の野営地（${provinceName(FS, c.camp.p, c.camp.q, { own: false })}）を、いまの軍勢（${who}）で攻めると、${chance}${need}訓練で兵を足してから向かいましょう。${skip}` + fogNote + road,
        go: { act: 'cg-go', data: { pop: 'train' }, label: L`兵を足す` }, wait: null };
    }
    return { text: out + L`いちばん近い蛮族の野営地（${provinceName(FS, c.camp.p, c.camp.q, { own: false })}、守り手 ${fmtNum(c.camp.troops)}）を、いまの軍勢（${who}）で攻めると、${chance}${need}訓練で兵を足してから向かいましょう。${skip}` + road,
      go: { act: 'cg-go', data: { pop: 'train' }, label: L`兵を足す` }, wait: null };
  }
  if (fightingCampsInSight(FS, ready, { seen, own }).length) {
    // (fix-camp-reach, Q-PM2-1 (c): fighting camps are in sight but none within this host's reach — a rim village saw
    //  only a ring-3 camp 125 rings away, whose march card said "No path there was found". Never named; the practice
    //  battle (#261) meanwhile, and the map to look further. The fog is unchanged: unseen camps stay unnamed)
    return { text: out + L`見えている蛮族の野営地には、まだこの軍勢が届きません（1 回の進軍で行けるのは ${fmtNum(MAX_ROUTE_PROVINCES)} 州・${fmtNum(MAX_PATH_STEPS)} マスまでです）。そのあいだに練習の戦い（チェーンの記録ではありません）で戦い方を確かめられます。「進軍」で地図のマスを押すと、着いたあたりが見えて、届く野営地が見つかることがあります。${skip}`,
      go: { act: 'practice-open', data: {}, label: L`練習で戦う` }, wait: null };
  }
  if (sitOut.length) {
    // only camps that sit battles out are in sight: a practice battle (pt-first-battle #261, screens/practice.mjs — said
    // as practice, never a chain record) while the march looks further
    return { text: L`見えている蛮族の野営地は、どれも村が ${fmtNum(CAMP_GARRISON_CAP)} 立つ州にあり、戦いに加わりません（野営地が戦うのは、州の村が ${fmtNum(CAMP_GARRISON_CAP)} 未満のときだけです）。そのあいだに練習の戦い（チェーンの記録ではありません）で戦い方を確かめられます。「進軍」で地図のマスを押すと、着いたあたりが見えて、ほかの野営地が見つかります。${skip}`,
      go: { act: 'practice-open', data: {}, label: L`練習で戦う` }, wait: null };
  }
  return { text: L`見えている蛮族の野営地はありません。「進軍」で地図のマスを押すと、着いたあたりが見えるようになります。${skip}`,
    go: { act: 'cg-go', data: { pop: 'march', host: String(ready.id) }, label: L`進軍で地図から選ぶ` }, wait: null };
}

/** (fix-camp-reach) The routes the camp choice asked the rules for, by host and camp (geometry only; cleared with a new kernel). */
let reachMemo = { kernel: null, map: new Map() };
const REACH_MEMO_LIMIT = 128;
/**
 * (fix-camp-reach, Q-PM2-1 (c)) Whether a march of host row `r` can reach `camp` now, as the march card would say it:
 * the rules' planner (fmarch.planRoute — the card's own call, palisades avoided as there) finds a route, and the
 * earliest arrival turn of that route lies inside the arrival window (fmarch.arrivalWindow; else the card refuses the
 * turn). `true`, `false` (no route: the card's "No path there was found"; or no arrival turn in the window), or `null`
 * when not known (no rules module yet, the bounded search's budget spent, no clock).
 */
export function campReach(FS, r, camp) {
  if (!FS?.kernel || !r || !camp || !Number.isInteger(r.tile)) return null;
  if (reachMemo.kernel !== FS.kernel) reachMemo = { kernel: FS.kernel, map: new Map() };
  const rings = FS.record?.rings ?? [];
  let blocked = [];
  try { blocked = palisadeHexesOf(FS); } catch { blocked = []; }
  const key = `${r.p},${r.q},${r.tile},${r.unit}|${camp.p},${camp.q},${camp.tile}|${rings.length}|${blocked.map(h => `${h.q},${h.r}`).join(';')}`;
  let x = reachMemo.map.get(key);
  if (x === undefined) {
    try {
      x = planRoute(FS.kernel, { from: { p: r.p, q: r.q, tile: r.tile }, to: { p: camp.p, q: camp.q, tile: camp.tile }, unit: r.unit,
        seeds: rings.map(g => ({ ring: g.d, seed: g.seed })), blocked });
    } catch { x = { ok: false, code: 'Error' }; }
    reachMemo.map.set(key, x);
    if (reachMemo.map.size > REACH_MEMO_LIMIT) reachMemo.map.delete(reachMemo.map.keys().next().value);
  }
  if (!x?.ok) return x?.code === 'NoPath' || x?.code === 'Path' || x?.code === 'PlannerRefused' || x?.code === 'BadTile' ? false : null;
  // the arrival: the earliest turn of this route must be one the card can name (min lead ≤ it ≤ max lead)
  let arrive = null;
  try { arrive = routeArrival(FS, x.route); } catch { arrive = null; }
  if (!arrive || !FS.season || !Number.isInteger(FS.nowBell)) return true;
  const w = arrivalWindow(FS.season, FS.nowBell);
  return Number.isFinite(w.max) ? arrive.bell <= w.max : true;
}

/** The last route the camp step asked the rules for (one at a time: the step is drawn on every render). */
let campRouteMemo = null;
/**
 * (fix-firstcamp) The way from host row `r` to `camp`: `{line, arrive}` — the order card's row (tiles,
 * provinces, the arrival turn and the wait until it begins) and the arrival `{bell, inSecs}` (screens/march.mjs
 * routeArrival) — or null while the rules module is not loaded or no route is found. The rules' planner, the same
 * call the march card makes (palisades avoided as there); the card asks again when the order is written.
 */
export function campWay(FS, r, camp) {
  if (!FS?.kernel || !r || !camp || !Number.isInteger(r.tile)) return null;
  const rings = FS.record?.rings ?? [];
  const key = `${r.id}|${r.p},${r.q},${r.tile},${r.unit}|${camp.p},${camp.q},${camp.tile}|${rings.length}|${FS.nowBell ?? ''}`;
  if (campRouteMemo?.key !== key) {
    let route = null;
    try {
      let blocked = [];
      try { blocked = palisadeHexesOf(FS); } catch { blocked = []; }
      const x = planRoute(FS.kernel, { from: { p: r.p, q: r.q, tile: r.tile }, to: { p: camp.p, q: camp.q, tile: camp.tile }, unit: r.unit,
        seeds: rings.map(g => ({ ring: g.d, seed: g.seed })), blocked });
      route = x?.ok ? x.route : null;
    } catch { route = null; }
    campRouteMemo = { key, route };
  }
  const route = campRouteMemo.route;
  if (!route) return null;
  let arrive = null;
  try { arrive = routeArrival(FS, route); } catch { arrive = null; }
  // (the wait is said by shell.mjs dueText, as the report time beside it: on a TEST clock it adds the real time. The
  //  keep list's keepRouteLine says it by march.mjs waitWords, which knows only the --demo clock (FS.localPlay
  //  .clockScale): in a --wide ×60 world it said "about 13 min" for 13 real seconds)
  const now = FS.chain?.now?.() ?? null;
  const n = route.hexes, pv = route.provinces?.length ?? 1;
  const t = arrive ? L`到着はターン ${fmtNum(arrive.bell)}（${dueText(Number(now) + arrive.inSecs, now)}）` : '';
  const head = n === 1 && pv === 1 ? L`1 マス · 1 州 · ${t}` : pv === 1 ? L`${n} マス · 1 州 · ${t}` : L`${n} マス · ${pv} 州 · ${t}`;
  return { line: t ? head : '', arrive };
}

/** The current step as the one "next thing": `{id, n, total, title, text, go: {act, data, label} | null}`; null when every step is done. */
export function conquestObjective(FS) {
  const g = conquestGuide(FS);
  if (!g || g.current === 'done') return null;
  const x = g.facts, hold = holdTurns(FS), id = g.current;
  const title = TITLE[id](hold);
  let text = '', go = null, wait = null;
  if (id === 'village') { text = L`国を選ぶと、最初の村が自動で置かれます。`; go = { act: 'join-open', data: {}, label: L`国を選ぶ` }; }
  else if (id === 'build') {
    // (pt-first-battle: the build step now comes while the first march walks — said so, with when its report is due)
    const due = ownReportDue(FS), now = FS.chain?.now?.() ?? null;
    const lead = due ? L`最初の進軍が向かっています。報告は${dueText(due.at, now)}に出る見込みです。待つあいだに、` : '';
    // (a march turned back from a keep before anything was built: said here too, as the march step says it)
    const back = x.repelled ? L`前の進軍は${provinceName(FS, x.repelled.p, x.repelled.q, { own: false })}の砦のマスに残れず、村へ押し戻されました。` : '';
    text = back + (lead ? L`${lead}村を選び、「建てる」から建物を選びます。建物は毎時の産出を増やし、次の軍勢の兵を養います。` : L`村を選び、「建てる」から最初の建物を選びます。建物は毎時の産出を増やします。`);
    go = { act: 'cg-go', data: { pop: 'build' }, label: L`建設をひらく` };
  }
  else if (id === 'camp') ({ text, go, wait } = campStep(FS));
  else if (id === 'train' || id === 'muster') {
    // what a keep takes, said before the host is formed (the UI check of 2026-10-26: the guide's first march, a host of
    // the first 100 spearmen, met a keep of 100 defenders behind walls and was turned back)
    const t = keepTarget(FS);
    // (pt-first-battle, "march first": before the first march the measure is the nearest camp in sight, not a keep)
    const hv = activeHolding(FS);
    // (fix-camp-reach: only a camp a march from the village could reach — the planner's limits and route)
    const fr = hv ? { unit: 0, troops: 100, p: hv.p, q: hv.q, tile: hv.tile } : null;
    const fc = !x.raided && hv ? campChoice(FS, fr, { seen: (p, q, tl) => viewTile(p, q, tl, 2), own: ownProvinceOf(FS), rough: (p, q, tl) => roughAt(FS, p, q, tl), reach: camp => campReach(FS, fr, camp) }) : null;
    // (fix-loop25: a camp under the fog in the village's own province — the one exception — without its defender count)
    const aim = fc?.need && fc.camp.fogged ? L`最初の戦いは、あなたの村の州にある蛮族の野営地です（霧の中なので守り手の数は見えません）。${unitCount(UNIT_ORDER[0], fc.need)} 以上を一つの軍勢にまとめると、運が悪くても勝てる見込みです。`
      : fc?.need ? L`最初の戦いは近くの蛮族の野営地（守り手 ${fmtNum(fc.camp.troops)}）です。${unitCount(UNIT_ORDER[0], fc.need)} 以上を一つの軍勢にまとめると、運が悪くても勝てる見込みです。`
      : t?.need ? L`砦を攻めるなら、${unitCount(UNIT_ORDER[0], t.need)} 以上を一つの軍勢にまとめると、守備兵 ${fmtNum(t.troops)} の砦に着いたターンに勝てる見込みです。` : '';
    // (fix-provisional-guide, loop-play23 BREAK-1: the first village is provisional for up to ≈4 h after its request — the
    //  program forms no host from it until hud/provisional.mjs villageConfirm's time, and only an action after that time
    //  confirms it. The step pointed at 「軍勢を編成する」, whose card could not be pressed for hours. It says when, that an
    //  action after that time confirms it, and offers what works meanwhile: building)
    const pend = id === 'muster' && !x.forming ? villageConfirm(FS) : null;
    if (id === 'train') { text = L`「訓練」で兵を雇います。訓練はすぐに終わり、兵は村の控えに入ります。${aim}`; go = { act: 'cg-go', data: { pop: 'train' }, label: L`訓練する兵を選ぶ` }; }
    else if (confirmPending(pend)) {
      text = confirmLine(FS, pend, { meanwhile: 'build' });
      if (pend.state === 'past') go = { act: 'harvest', data: {}, label: L`収穫して村を確定する` };
      else { go = { act: 'cg-go', data: { pop: 'build' }, label: L`建設をひらく`, aside: true }; wait = L`村の確定を待つ`; }
    } else if (pend?.state === 'due') {
      text = joinSentences(confirmLine(FS, pend), L`「編成」で控えの兵を軍勢にします。軍勢は、記録に現れたターンから動かせます。${aim}`);
      go = { act: 'cg-go', data: { pop: 'muster' }, label: L`軍勢を編成する` };
    }
    else if (x.forming) {
      // the host is forming: where its muster turn really is, and one thing worth doing meanwhile (the first-session
      // review of 2026-11-13: the guide said nothing for the ~18 minutes between the muster and the formed host)
      const r = x.forming, s = waitingSuggestion(FS, r, t);
      text = [formingLine(FS, r), whileWaitingLine(s, r.unit)].filter(Boolean).join(' ');
      // (fix-loop5, L5-7: a press for meanwhile — 兵を足す / 建設をひらく — is said as that, `aside`, and the step's own
      //  line is the wait: the pill read 「ガイド 3/7 建設をひらく」 under the step 「軍勢を編成する」 after the muster)
      go = s?.kind === 'train' ? { act: 'cg-go', data: { pop: 'train' }, label: L`兵を足す`, aside: true }
        : s?.kind === 'build' ? { act: 'cg-go', data: { pop: 'build' }, label: L`建設をひらく`, aside: true }
        : { act: 'tab', data: { tab: 'hosts' }, label: L`軍勢の準備を確かめる` };
      wait = L`軍勢の整列を待つ`;
    } else { text = L`「編成」で控えの兵を軍勢にします。軍勢は、記録に現れたターンから動かせます。${aim}`; go = { act: 'cg-go', data: { pop: 'muster' }, label: L`軍勢を編成する` }; }
  } else if (id === 'march') {
    let rows = [];
    try { rows = hostRows(FS).filter(r => r.unit !== SCOUT && r.unit !== SETTLER); } catch { rows = []; }
    const ready = rows.find(r => !waitOf(FS, r)) ?? null, wait = ready ? null : hostWaits(FS)[0] ?? null;
    const back = x.repelled ? L`前の進軍は${provinceName(FS, x.repelled.p, x.repelled.q, { own: false })}の砦のマスに残れず、村へ押し戻されました。` : '';
    const best = ready ? bestOdds(FS, ready) : null;
    if (ready && !marchOpenFor(FS)) {
      // this page cannot send a march in this world (hud/firststeps.mjs marchOpenFor): never point at a press that
      // cannot work. Say so plainly, without promising when, and set a goal the page can take: troops toward the keep
      const t = keepTarget(FS), troops = Math.floor(Number(ready.troops)) || 0;
      const who = unitCount(UNIT_ORDER[ready.unit], troops), closed = marchClosedText(FS);
      if (t?.need && troops < t.need) {
        text = L`${back}${who}の軍勢が立ちました。${closed}届く砦（守備兵 ${fmtNum(t.troops)}）に勝てる見込みの ${unitCount(UNIT_ORDER[ready.unit], t.need)} まで、兵を足しておけます。`;
        go = { act: 'cg-go', data: { pop: 'train' }, label: L`兵を足す` };
      } else if (t?.need) {
        text = L`${back}${who}の軍勢は、届く砦（守備兵 ${fmtNum(t.troops)}）に勝てる見込みの兵数です。${closed}`;
        go = { act: 'cg-go', data: { pop: 'keeps', host: String(ready.id) }, label: L`届く砦を見る` };
      } else {
        text = L`${back}${who}の軍勢が立ちました。${closed}`;
        go = { act: 'tab', data: { tab: 'hosts' }, label: L`軍勢の準備を確かめる` };
      }
    } else if (ready && best && best.odds !== 'good') {
      // the host as it stands would most likely be turned back: say so, and how many it takes, before it goes
      const who = unitCount(UNIT_ORDER[ready.unit], Math.floor(Number(ready.troops)));
      const chance = best.odds === 'even' ? L`勝ち目は五分です。` : L`勝ち目は低いです。`;
      const need = best.need ? L`${unitCount(UNIT_ORDER[ready.unit], best.need)} ほどにしてから進軍すると、運が悪くても砦のマスに残れます。` : '';
      text = L`${back}いまの軍勢（${who}）で届く砦（守備兵 ${fmtNum(best.troops)}、城壁あり）を攻めると、${chance}${need}訓練で兵を足し、今の軍勢を解散して控えに戻してから（次のターンに戻ります）、まとめて編成し直します。`;
      go = { act: 'cg-go', data: { pop: 'train' }, label: L`兵を足す` };
    } else if (ready && noVisibleReach(FS, ready)) {
      // (fix-loop6, LP6-4: the host's list was read and holds no keep — under the fog, none SEEN — 「届く砦を見る」 again
      //  would only show 「届く砦 0」. The next useful step instead: a march onto a tile of the map, seen or not, toward
      //  the keeps. Nothing unseen is named)
      text = fogNow().on ? L`${back}見えている他国の砦で、この軍勢が届くものはありません。「進軍」で地図のマスを押せば、まだ見ていない土地へも向かえます。着いたあたりが見えるようになり、砦が見えれば「砦へ進軍」の一覧に出ます。`
        : L`${back}この軍勢が届く他国の砦はありません（進軍が越えられるのは4州まで）。「進軍」で地図のマスを押して、砦に近づけます。`;
      go = { act: 'cg-go', data: { pop: 'march', host: String(ready.id) }, label: L`進軍で地図から選ぶ` };
    } else {
      text = ready ? L`${back}軍勢を選び、「砦へ進軍」で届く他国の砦を選びます。勝ち目の欄が「十分」の砦を選ぶと、着いたターンに砦のマスに残れる見込みです。命令に封をして出発すると、到着のターンに戦いが決まります。`
        : wait ? back + waitText(wait, FS) : L`${back}軍勢を選び、「砦へ進軍」で届く他国の砦を選びます。`;
      go = ready ? { act: 'cg-go', data: { pop: 'keeps', host: String(ready.id) }, label: L`届く砦を見る` } : { act: 'tab', data: { tab: 'hosts' }, label: L`軍勢の準備を確かめる` };
      // (fix-loop12, LP12-3: a march of the viewer is out and its destination is still under seal — after a reload the
      //  page no longer holds the order it sealed (FS.orders is page memory), and the transit names no destination until
      //  its arrival turn reveals it — while no host is at home: the departing host stood in the province record as
      //  「出発の手続き中」, so the guide said 「軍勢の準備を確かめる」 and the press opened 訓練. Said as what it is: out on
      //  a march, its result to be seen in 進軍)
      const sealedOut = !ready ? sealedMarch(FS) : null;
      if (sealedOut && !rows.some(r => !r.inTransit && r.pending !== 1)) {
        text = int(sealedOut.arrive) ? L`${back}軍勢は進軍に出ています。行き先は封をしたままで、到着のターン ${fmtNum(sealedOut.arrive)} に明かされます。砦に着いて勝てば、占拠のターンが数えられます。`
          : L`${back}軍勢は進軍に出ています。行き先は封をしたままで、到着のターンに明かされます。砦に着いて勝てば、占拠のターンが数えられます。`;
        go = { act: 'tab', data: { tab: 'marches' }, label: L`進軍を見る` };
      }
      // (w2-wipeout, D-verify-pr137-3: no host of the viewer anywhere — none in a province record, none out on a march —
      //  so 「軍勢の準備を確かめる」 opened an empty list: the last host was wiped out (a settled march says 壊滅) or
      //  none is left. Say so, and offer the next army's first step instead. A march still out — its survivors may come
      //  home with its result — is pointed at instead, with what its result decides)
      if (!ready && !wait && !rows.length) {
        const { wiped, pending } = marchesLeft(FS);
        if (pending.length) {
          text = L`${back}いま村に軍勢はいません。進軍の記録が締めくくられると、生き残った兵が村に戻ります（全滅していれば戻りません）。`;
          go = { act: 'tab', data: { tab: 'marches' }, label: L`進軍の結果を見る` };
        } else {
          const n = nextArmyGo(FS);
          const was = wiped?.dest ? L`前の軍勢は${provinceName(FS, wiped.dest.p, wiped.dest.q, { own: false })}で壊滅し、戻った兵はいません。` : back || L`進軍できる軍勢がいません（前の軍勢は戻りませんでした）。`;
          text = n.pop === 'muster' ? L`${was}砦へ進軍するには新しい軍勢が要ります：控えの兵を編成します。` : L`${was}砦へ進軍するには新しい軍勢が要ります：まず兵を訓練します。`;
          go = n.go;
        }
      }
    }
  } else {
    // hold, then the capture: the count is the keep's own record
    const k = x.holding;
    text = k ? L`${provinceName(FS, k.p, k.q, { own: false })}の砦のマスを、あなたの国が ${fmtNum(k.progress)} / ${fmtNum(k.required)} ターン保っています。${fmtNum(k.required)} ターン（${turnsLine(k.required)}）続けて保つと、州はあなたの国のものになります。`
      : L`進軍が砦のマスに着いて勝つと、占拠のターンが数えられます。${fmtNum(hold)} ターン（${turnsLine(hold)}）続けて保つと、州はあなたの国のものになります。`;
    go = x.target ? { act: 'goto', data: { p: x.target.p, q: x.target.q }, label: L`砦を見る` } : { act: 'tab', data: { tab: 'marches' }, label: L`進軍を見る` };
  }
  return { id, n: g.n, total: g.total, title, text, go, wait };
}

const attrs = d => raw(Object.entries(d ?? {}).map(([k, v]) => `data-${String(k).replace(/[^\w-]/g, '')}="${String(v).replace(/[^\w.,:-]/g, '')}"`).join(' '));

/** The guide's drawer on a conquest season: the seven steps as a checklist, the current one with its sentence and its press. */
export function renderConquestGuide(FS, { open = true } = {}) {
  const g = conquestGuide(FS);
  if (!g) return '';
  const o = conquestObjective(FS);
  const item = s => html`<li class="${s.status === 'done' ? 'done' : s.status === 'current' ? 'now' : ''}" ${raw(s.status === 'current' ? 'aria-current="step"' : '')}><span class="ck-mark" aria-hidden="true">${s.status === 'done' ? icon('check') : ''}</span><span class="ck-name">${s.title}</span>${s.status === 'done' ? html` <span class="visually-hidden">${L`（${L`済み`}）`}</span>` : s.status === 'current' ? html` <span class="visually-hidden">${L`（${L`いま`}）`}</span>` : ''}</li>`;
  const cap = g.facts.captured;
  // (w2-wipeout, D-verify-pr137-3: after the capture the card offers the next army too — it ended on the result alone)
  const next = !o && cap ? afterCapture(FS) : null;
  // (newcomer-ux: a world that goes on has no season end and no winner yet — the 領土 tab says so; the guide said the opposite)
  // (fix-loop13, LP13-1: seasons are abolished — a --demo / --wide TEST world that still has an end turn says it as a
  // test world's limit, never as "the nation with the most provinces wins at the season's end")
  const seasonLine = worldContinues(FS.season) ? L`この世界は続きます。戦期の勝敗と集計は未決定です。` : L`この試しの世界は決まったターンで新しい命令の受付を終えます。試しの世界の上限で、勝ち負けの決まりではありません。`;
  const body = html`${o ? html`<p>${o.text}</p>${o.go ? html`<div class="actions"><button type="button" class="btn primary" data-act="${o.go.act}" ${attrs(o.go.data)}>${o.go.label}</button></div>` : ''}`
      : html`<p>${cap ? L`第${fmtNum(cap.turn)}ターンに、あなたの国（${factionName(FS.citizen?.faction)}）が州 ${cap.p},${cap.q} を奪いました。${seasonLine}` : seasonLine}</p>${next ? html`<p class="cg-next" data-next="after-capture">${next.text}</p><div class="actions"><button type="button" class="btn primary" data-act="${next.go.act}" ${attrs(next.go.data)}>${next.go.label}</button></div>` : ''}`}
    <ol class="checklist">${g.steps.map(item)}</ol>
    <div class="actions ck-foot">${o?.id === 'camp' && o.go?.act !== 'ob-skip' ? html`<button type="button" class="btn small quiet" data-act="ob-skip" data-step="camp">${L`この手順を飛ばす`}</button>` : ''}<button type="button" class="btn small quiet" data-act="ob-dismiss">${L`ガイドを閉じる`}</button></div>`;
  const head = o ? L`ガイド ${o.n}/${o.total}：${o.title}` : L`ガイド：州を奪いました`;
  if (!open) return html`<details class="callout onboarding"><summary>${head}</summary>${body}</details>`;
  return html`<section class="vcard onboarding" aria-labelledby="ob-title">${cardHead({ id: 'ob-title', ic: 'compass', title: head })}${body}</section>`;
}
