// The clashes of the viewer's own host where it STANDS (a conquest season).
//
// A march on a keep of 100 defenders is fought over two turns on chain (the
// local test chain, 2026-10-11: the keep's troops 100 → 8 in the arrival
// turn's clash record, 8 → 0 in the next turn's). The page's notifications
// (hud/feed.mjs) tell the first, by the march that arrived, and tell the
// clashes of the provinces the viewer has a village in. The second record is
// of neither kind: the host is a resident of another nation's province by
// then. So the second turn passed unseen, and a viewer could not tell who won
// before the hold began.
//
// This module gives every such record its place among the turn's own
// results: a CLASH record with an engagement, in a province the page's own
// notifications do not tell, in which a host of the viewer's fought as a
// resident. It reads that record's own report, stages the scene from it
// (people/battle.mjs, in the turn's order: fx/stage.mjs `feed` → `turn:scene`
// → the page's playBattle) and says the result in the turn's card and in the
// notifications, with the record's own 見る and 報告. Nothing is staged for a
// record without an engagement, and nothing the report does not say is said.
//
// A scene of this kind has ONE start: its cue. The page also starts, on its
// own and without the camera, the clash of any province it has loaded when
// that clash is new (app.mjs autoBattles); for these scenes that start is
// called off here (`battle:ask`), or the scene would play twice.
//
// It is mounted with the keeps (map/keepmount.mjs), so it runs only where a
// map is and only on a conquest season. It sends no order.
import { FS, invalidate } from '../fstate.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { hostParts } from '../faddr.mjs';
import { decode } from '../fcodec.mjs';
import { fromBase64 } from '../../sdk/bytes.mjs';
import { createHerald } from '../herald.mjs';
import { config } from '../config.mjs';
import { bus as pageBus } from '../fx/bus.mjs';
import { battleScene, BATTLE_SPEEDS, PHASE } from '../people/battle.mjs';
import { provinceName } from '../hud/place.mjs';

const int = Number.isInteger;
/** The notifications kept (hud/feed.mjs FEED_MAX). */
const FEED_KEEP = 60;
/** How often, and how many times, a record's report is asked for before it is given up (the report is written a moment after the record). */
const RETRY_MS = 1500, RETRIES = 20;
/** A scene the turn's order has just cued is the page's to start for this long (the page reads the report first). */
const CUE_SECS = 20;

/** Whether host `id` is one of the viewer's: its home is one of the viewer's villages. */
export function ownHost(fs, id) {
  try { const h = hostParts(id); return !!h && (fs?.holdings ?? []).some(o => o.p === h.p && o.q === h.q && o.site === h.site); } catch { return false; }
}

/**
 * Whether the page's own notifications tell the clash of (p, q) at `bell` (hud/feed.mjs): a province the viewer has a
 * village in (the `cl:` line), or the destination of a march of this browser that arrives at that very turn (`rs:`).
 */
export function feedTells(fs, p, q, bell) {
  return (fs?.holdings ?? []).some(h => h.p === p && h.q === q)
    || (fs?.marches ?? []).some(m => m.dest && m.dest.p === p && m.dest.q === q && (m.entry?.arriveBell ?? m.transit?.arriveBell) === bell);
}

const sidesOf = t => [...(t?.attackers ?? []), ...(t?.defenders ?? [])];

/**
 * The viewer's own part in a scene (people/battle.mjs battleScene), or null: `{tile, me, foes, keep}`. `me`: the rows
 * of the viewer's hosts on the first tile where one of them stood as a RESIDENT (a host that arrived in this very
 * turn is the march's own line, and is left to it); `foes`: the rows of the other side there; `keep`: the keep's own
 * defenders among them, or null.
 */
export function ownPart(fs, scene) {
  for (const t of scene?.tiles ?? []) {
    const inA = (t.attackers ?? []).some(s => ownHost(fs, s.id)), list = inA ? t.attackers : t.defenders ?? [];
    const me = list.filter(s => ownHost(fs, s.id));
    if (!me.length || me.some(s => s.kind === 'arrival')) continue;
    const foes = inA ? t.defenders ?? [] : t.attackers ?? [];
    // (a host of the viewer's own nation that arrives on the tile is no foe: an ally's march to the keep the viewer holds)
    if (!foes.some(s => s.faction !== me[0].faction)) continue;
    return { tile: t.idx, me, foes, keep: foes.find(s => s.keep) ?? null, attacking: inA };
  }
  return null;
}

/**
 * The line that tells such a clash, from the scene's rows alone. A keep's last defenders beaten is said plainly, with
 * who holds the keep's tile now: this is where the hold of the keep begins.
 */
export function ownClashText(fs, { p, q, bell }, part) {
  const lost = part.me.every(s => Number.isFinite(s.before) && Number.isFinite(s.after)) ? part.me.reduce((n, s) => n + Math.max(0, s.before - s.after), 0) : null;
  const stays = part.me.some(s => s.fate === 'Stays' && s.after !== 0);
  if (part.keep && part.keep.after === 0 && stays) return L`州 ${p},${q} の砦の守備兵を、あなたの軍勢が破りました。軍勢は砦のマスを押さえています（ターン ${fmtNum(bell)}）`;
  if (part.keep && Number.isFinite(part.keep.after)) return L`州 ${p},${q} の砦の守備兵と、あなたの軍勢が戦いました。守備兵は残り ${fmtNum(part.keep.after)}（ターン ${fmtNum(bell)}）`;
  const where = provinceName(fs, p, q);
  return lost !== null ? L`${where}で、あなたの軍勢が戦いました（ターン ${fmtNum(bell)}・${fmtNum(lost)} 兵を失いました）` : L`${where}で、あなたの軍勢が戦いました（ターン ${fmtNum(bell)}）`;
}

/**
 * The notification of such a clash, or null when the record is not one of them: `{id: 'cl:P,Q,bell', kind: 'battle',
 * bell, p, q, tile, battle: {p, q, bell}, text, residents}` (the id and the shape of hud/feed.mjs's own `cl:` line, so
 * that the two are one line wherever both are made). `report`: the herald's clash report (`inputs_b64`,
 * `province_before_b64`); `after`: the Province after that turn, or null when the page does not have it yet.
 */
export function ownClashItem(fs, { p, q, bell, inputs, before, after }) {
  const scene = battleScene({ p, q, bell, inputs, before, after });
  const part = scene ? ownPart(fs, scene) : null;
  if (!part) return null;
  return { id: `cl:${p},${q},${bell}`, kind: 'battle', bell: fs?.nowBell ?? bell, p, q, tile: part.tile, battle: { p, q, bell }, text: ownClashText(fs, { p, q, bell }, part), residents: !!scene.residents };
}

/** The CLASH records of the log the page has read that had an engagement: `[{p, q, bell}]`. */
export function foughtClashes(chronicle) {
  const out = [];
  for (const x of chronicle ?? []) {
    const r = x?.record ?? x;
    if (r?.name !== 'CLASH' || !(Number(r.engagements ?? 1) > 0)) continue;
    const c = { p: Number(r.p), q: Number(r.q), bell: Number(r.bell) };
    if (int(c.p) && int(c.q) && int(c.bell)) out.push(c);
  }
  return out;
}

/** The tiles of a scene that would be staged as a fight: both sides have somebody (people/battle.mjs battlePlan). */
const fightTiles = scene => (scene?.tiles ?? []).filter(t => (t.attackers ?? []).length > 0 && (t.defenders ?? []).length > 0);
/** Whether every tile a scene would stage as a fight has one nation alone on it: nobody there is anybody's foe. */
export function noFight(scene) {
  const fights = fightTiles(scene);
  return fights.length > 0 && fights.every(t => new Set(sidesOf(t).map(s => s.faction)).size < 2);
}

/**
 * Whether the clash of (p, q) at `bell` had an engagement: the log's own CLASH record where the page has read it,
 * else the count in the herald's report of it; null while neither says. A turn in which hosts only stood on a tile,
 * or an ally arrived on it, is logged as a clash with no engagement, and is no battle.
 */
export function engagedIn(chronicle, { p, q, bell }, report = null) {
  for (const x of chronicle ?? []) {
    const r = x?.record ?? x;
    if (r?.name === 'CLASH' && Number(r.p) === p && Number(r.q) === q && Number(r.bell) === bell) return Number(r.engagements ?? 1) > 0;
  }
  const n = report?.decoded?.engagements;
  return int(n) ? n > 0 : null;
}

/** Whether the page's own reading of province (p, q) has a host of the viewer's in it. */
export function ownHostIn(fs, p, q) {
  const pr = fs?.provinces?.get?.(`${p},${q}`)?.province;
  return (pr?.entries ?? []).some(e => e.state !== 0 && ownHost(fs, e.id));
}

/**
 * Mount the watch. `sync()` is called once a frame by the keeps' feed (map/keepmount.mjs) while the season is a
 * conquest season (`enabled`: nothing is told, asked for or called off elsewhere). Returns `{sync, off, told}` (`told`:
 * the records that are settled, told or found to be no battle of the viewer's); tests
 * give their own `state`, `clash`, `bus`, `now` and `later`.
 */
export function mountOwnClash({ state = () => FS, enabled = () => true, bus = pageBus, clash = null, now = () => (globalThis.performance?.now?.() ?? Date.now()) / 1000, later = (fn, ms) => globalThis.setTimeout?.(fn, ms), redraw = () => invalidate('panel') } = {}) {
  let herald = null;
  const read = clash ?? ((p, q, bell) => { herald = herald ?? createHerald({ base: config().herald }); return herald.clash(p, q, bell); });
  const keyOf = c => `${c.p},${c.q},${c.bell}`;
  let known = null, lastLog = null;   // the CLASH records already seen ("p,q,bell"); null until the first reading, which is not news
  const told = new Set(), asked = new Set(), cued = new Map(), camera = new Map();   // camera: "p,q,bell" → whether its cue's start comes with the camera
  const live = fs => (fs?.mode ?? 'play') === 'play' && !!fs.citizen && !!enabled(fs);

  /** Read the record's report and, if a host of the viewer's fought in it where it stood, tell it and give its scene a place in the turn's order. */
  async function consider(c, tries = 0) {
    const key = keyOf(c), fs = state();
    if (told.has(key) || !live(fs) || feedTells(fs, c.p, c.q, c.bell)) { asked.delete(key); return false; }
    let item = null, ready = false;
    try {
      const r = await read(c.p, c.q, c.bell);
      // (no scene and no notice for a record with no engagement; one whose engagement is not known yet is asked again)
      const fought = r?.ok !== false && r?.inputs ? engagedIn(state().chronicle, c, r.report) : null;
      if (fought === false) { asked.delete(key); told.add(key); return false; }
      if (fought === true) {
        let before = null;
        try { before = r.report?.province_before_b64 ? decode('Province', fromBase64(r.report.province_before_b64)) : null; } catch { before = null; }
        const now = state().provinces?.get?.(`${c.p},${c.q}`)?.province ?? null, after = now && now.resolvedNext > c.bell ? now : null;
        // (what was lost is told from the province after the turn: asked again until the page has read it. A clash with
        // arrivals can be told without it in the end: who came is in the record's own inputs)
        ready = !!after || (tries >= RETRIES && (r.inputs.arrivals ?? []).some(a => a.present === 1 || a.present === true));
        if (ready) item = ownClashItem(state(), { ...c, inputs: r.inputs, before, after });
      }
    } catch (e) { globalThis.console?.warn?.('frontier own clash:', e); }
    if (!ready && tries < RETRIES) { later(() => { consider(c, tries + 1); }, RETRY_MS); return false; }
    asked.delete(key);
    if (!item || told.has(key)) return false;
    told.add(key);
    const f = state(), speed = BATTLE_SPEEDS[f.ui?.battleFx ?? 'normal'] || 0;
    // (the notifications' own list, as app.mjs keeps it: newest first, one line an id)
    if (!(f.feed ?? []).some(x => x.id === item.id)) f.feed = [{ ...item, at: Date.now() }, ...(f.feed ?? [])].slice(0, FEED_KEEP);
    camera.set(key, speed > 0 && !!f.ui?.autoPan);
    bus.emit('feed', { turn: f.nowBell ?? item.bell, fresh: [{ ...item, faction: f.citizen?.faction ?? null,
      ...(speed > 0 ? { scene: (item.residents ? PHASE.end - PHASE.deploy : PHASE.end) / speed, focus: !!f.ui?.autoPan } : {}) }] });
    redraw();
    return true;
  }
  const ask = c => { const key = keyOf(c); if (told.has(key) || asked.has(key)) return; asked.add(key); consider(c); };

  // the provinces a host of the viewer's has been seen in ("p,q"): a host that fell in a clash is in no roster once the
  // page has read the province after that turn, and its last clash is the viewer's own all the same
  const stoodIn = new Set();
  /** Once a frame: the CLASH records that are new since the last look (the log is read once a poll: nothing is done between polls). */
  function sync() {
    const fs = state();
    if (!live(fs) || !fs.chronicle || fs.chronicle === lastLog) return;
    lastLog = fs.chronicle;
    const list = foughtClashes(fs.chronicle);
    const was = new Set(stoodIn);
    for (const [key, env] of fs.provinces ?? []) if ((env?.province?.entries ?? []).some(e => e.state !== 0 && ownHost(fs, e.id))) stoodIn.add(key);
    if (!known) { known = new Set(list.map(keyOf)); return; }
    for (const c of list) {
      const key = keyOf(c);
      if (known.has(key)) continue;
      known.add(key);
      if (!feedTells(fs, c.p, c.q, c.bell) && (was.has(`${c.p},${c.q}`) || ownHostIn(fs, c.p, c.q))) ask(c);
    }
  }

  const offs = [
    // the turn's order has come to a scene: the page starts it now (a start that follows is that one)
    bus.on('turn:scene', x => { if (x?.battle) cued.set(keyOf(x.battle), now()); }),
    // a scene is about to be staged (fx/stage.mjs asks before it stages): one of these, begun without the camera and
    // not by its cue, is called off and given its place in the turn's order instead. A start WITH the camera is the
    // cue's own where the option sends the camera, or the player's 見る: never called off. Where the option is off the
    // cue's own start comes without the camera too: that one start after the cue is let through (seen on the local
    // test chain, 2026-10-11: the page's own start came 0.4 s after the cue's and began the scene again, small)
    bus.on('battle:ask', a => {
      const fs = state(), sc = a?.play?.scene;
      if (!sc || a.focus || !live(fs) || !int(sc.p) || !int(sc.q) || !int(sc.bell)) return;
      // (no battle at all: the tiles the scene would stage as a fight have one nation alone on them — an ally's host
      // arriving where a host stands, as the film's second wallet does at the keep the first one holds —, or the log
      // says that turn had no engagement. The page's own start staged such a turn as a clash; it is called off)
      if (noFight(sc) || (fightTiles(sc).length > 0 && engagedIn(fs.chronicle, sc) === false)) { a.hold = true; return; }
      if (feedTells(fs, sc.p, sc.q, sc.bell) || !ownPart(fs, sc)) return;
      const key = keyOf(sc), t = cued.get(key);
      if (t !== undefined && now() - t < CUE_SECS && camera.get(key) === false) { cued.delete(key); return; }
      a.hold = true;
      if (known) known.add(keyOf(sc));
      ask({ p: sc.p, q: sc.q, bell: sc.bell });
    }),
  ];
  return { sync, told, off() { for (const f of offs) f(); } };
}
