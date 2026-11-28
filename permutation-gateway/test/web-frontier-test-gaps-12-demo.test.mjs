// test-gaps-12: PR-CI tests for the walletless demo's #321 (demo-goal-polish-1: the phone goal card vs the Hosts
// drawer, hold 20, "attacks the castles you capture … marching never takes land"), #324 (fix-tg11-since: every land
// record is made with the world, a read writes nothing, so a reload is the played world, `since` included) and #325
// (demo-dgp1-waves: from game turn 120 an AI wave every 5 turns, ×1.2, a wave host left at home marches again, a
// skirmisher leaves its castle to the leader, so every game ends). Until now these were checked in a browser by hand
// (verify-pr321 §1a, verify-pr324's harness, verify-pr325 §2–4) or by tests that run a world other than the page's
// (web-frontier-demo-waves: `lateFromBells: 48`, no camps, no travelers; goal-playtest: no camps, no travelers).
//
// KEY-FREE, NO SIGNATURE: every world is made with the keyless viewer (W.viewer({ keyless: true })), the player's
// inputs go through the world's own test instructions (`testPlay.join`, `testPlay.march`, `order`) — the save carries
// them as test POSTs on `/gw/test/…`, which a small wrapper hands to those instructions (as #324's own test does). No
// key is generated, derived, imported or used; the approved demo sample keys are not needed. The goal card (#321) runs
// against a stand-in document (plain objects: no browser, no network).
//
// #324 is merged (999399e91): its tests here use the world's `testPlay.land()` (the raw land records #324 adds) and
// run; they would say SKIP only on a tree without it (verify-pr330).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as W from '../screens/world.mjs';
import { createLive } from '../screens/liveworld.mjs';
import * as G from '../screens/demogoal.mjs';
import { tileHex, hexDistance } from '../../permutation-server/web/frontier/fgeo.mjs';
import { createClock, createRecorder, readSave, replay } from '../demo/src/save.mjs';

const src = f => readFileSync(new URL(f, import.meta.url), 'utf8');
const TURN = 12, MS = TURN * 1000;
// the page's world: demo/src/boot.mjs's createLive options (pinned by web-frontier-test-gaps-11-demo-goal-camps test 1)
const PAGE = { stage: 'none', opening: true, territory: true, nations: true, landUpkeep: true, landClaim: true, travelers: true, camps: true, goal: true, turn: TURN, delay: 3, landMs: 400 };
const json = v => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? `${x}n` : x instanceof Uint8Array ? Array.from(x) : x instanceof Set ? [...x] : x));
const hash = v => createHash('sha256').update(json(v)).digest('hex');
const memory = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); } }; };
/** `live` with the test POSTs a save can carry (anything else: the relay). */
const withTests = live => ({
  ...live,
  relay: (m, p, b) => {
    if (p === '/gw/test/join') return live.testPlay.join(b.nation);
    if (p === '/gw/test/order') return live.order(b.name, b.d, b.at);
    if (p === '/gw/test/march') return live.testPlay.march(b.host, b.dest);
    return live.relay(m, p, b);
  },
});
/** The page's clock poll (the herald's /h/season record: the API path's name). */
const heraldClock = live => live.herald('/h/season', new URL('http://x/h/season'));
/** Everything the page can read of the world (the event slots masked: D-test-gaps-9-2, still open). */
function worldState(live) {
  const s = live.summary();
  return {
    summary: s, land: live.testPlay.land?.() ?? null, provinces: (s.territory ?? []).map(t => live.province(t.p, t.q)),
    goal: live.goal(), goalLog: live.goalLog(), camps: live.camps(), campsLog: live.campsLog(), travelers: live.travelers?.() ?? null, travelLog: live.travelLog?.() ?? null,
    clock: heraldClock(live),
  };
}

/**
 * One played session in the page's world on a hand clock, recorded by save.mjs. The player is this file's own (not
 * goal-playtest's): every `every` turns, at mid-turn, it builds a farm / ore mine / farm, trains what the stores pay
 * for, musters it, keeps max(150, guardK × the card's "next wave" troops) on each castle it took, and sends its ready
 * hosts on the nearest rival castle they outnumber 1.3 × + 50. `reads(live)` is called every `cadence` ms (the page's
 * polling; null: no reads but the player's own). `look(live, goal)` runs four times a turn (a test's observer). Stops at
 * the result, after `turns` turns, or at `stopAt` (a game turn since the goal was posted).
 */
async function session({ nation, every = 5, guardK = 1.25, turns = 260, stopAt = null, cadence = null, reads = null, look = null, act = true }) {
  let real = 1_000_000;
  const clock = createClock(() => real);
  const live = withTests(createLive({ viewer: await W.viewer({ keyless: true }), keyless: true, ...PAGE, wall: clock.wall }));
  const ls = memory(), rec = createRecorder({ storage: ls, worldId: 'w', clock });
  const post = (p, b) => rec.post('POST', p, JSON.stringify(b), () => live.relay('POST', p, b));
  const step = ms => {
    if (!cadence || !reads) { real += ms; rec.tick(live.turn()); return; }
    for (let d = 0; d < ms;) { const x = Math.min(cadence, ms - d); real += x; d += x; reads(live); rec.tick(live.turn()); }
  };
  // (nothing is read before the page's first /h/season, which starts the clock and is what `seen` records: D-verify-pr324-7)
  real += 900; rec.seen(live); step(3_100);
  const j = await post('/gw/test/join', { nation });
  assert.equal(j.ok, true, json(j));
  step(MS);
  const me = () => live.summary().me;
  const [p, q] = me().village, home = tileHex(p, q, me().tile);
  const d = c => { const h = tileHex(c.p, c.q, c.tile); return hexDistance(h.q, h.r, home.q, home.r); };
  const standing = c => live.province(c.p, c.q).entries.filter(e => e.state === 1 && e.tile === c.tile);
  const foes = c => standing(c).filter(e => e.faction !== nation).reduce((a, e) => a + Math.floor(e.troops / 1000), 0);
  const ours = c => standing(c).filter(e => e.faction === nation).reduce((a, e) => a + Math.floor(e.troops / 1000), 0);
  const dest = new Map(), far = new Set();
  const order = (name, dd, at) => post('/gw/test/order', { name, d: dd, at });
  const march = async (h, c) => { const r = await post('/gw/test/march', { host: h.id, dest: { p: c.p, q: c.q, tile: c.tile } }); if (r.ok) dest.set(h.id, `${c.p},${c.q},${c.tile}`); else if (r.code === 'Path') far.add(`${c.p},${c.q}`); return r.ok; };
  for (let i = 0; i < turns; i++) {
    // (a test's observer looks four times a turn: 1.5 s into the turn, before its npc step (3 s in: a wave goes then),
    //  and after it; the player acts at mid-turn)
    step(MS / 8); if (look) look(live, live.goal());
    step(3 * MS / 8);
    const g = live.goal();
    look?.(live, g);
    if (g.result || (stopAt !== null && g.turn - g.posted >= stopAt)) break;
    if (act && i % every === 0) {
      const m = me();
      for (const item of [0, 3, 0]) await order('Build', { item }, { p, q });
      for (const n of [1000, 600, 400, 200]) if ((await order('Train', { unit: 0, n }, null)).ok) break;
      if (m.reserve[0] >= 200) await order('Muster', { unit: 0, troops: m.reserve[0], tile: m.tile }, { p, q });
      const onCastle = h => g.castles.some(c => c.p === h.province[0] && c.q === h.province[1] && c.tile === h.tile);
      const pool = me().hosts.filter(h => h.state === 1 && h.unit === 0 && h.stamina >= 74 && h.readyBell <= g.turn && h.troops >= 100 && !me().marches.some(x => x.host === h.id) && !onCastle(h)).sort((a, b) => b.troops - a.troops);
      const coming = c => me().marches.filter(x => dest.get(x.host) === `${c.p},${c.q},${c.tile}`).length;
      const guard = Math.max(150, Math.round((g.waveTroops ?? 0) * guardK));
      for (const c of g.castles.filter(x => x.holder === nation && x.nation !== nation && ours(x) < guard && !coming(x))) { const h = pool.shift(); if (h) await march(h, c); }
      for (const c of g.castles.filter(x => x.nation !== nation && x.holder !== nation && !coming(x) && !far.has(`${x.p},${x.q}`)).sort((a, b) => d(a) - d(b))) {
        const want = foes(c) * 1.3 + 50;
        if (pool.reduce((a, h) => a + h.troops, 0) < want) continue;
        let sent = 0;
        while (sent < want && pool.length) { const h = pool.shift(); if (await march(h, c)) sent += h.troops; }
        break;
      }
    }
    step(MS / 4); if (look) look(live, live.goal());
    step(MS / 4);
  }
  rec.write();
  return { live, ls, rec, real: () => real, move: ms => step(ms), post };
}
/** The reload: a new world made with a new clock, and save.mjs's replay of the save (nothing read between its inputs). */
async function reload(ls) {
  let real = 5_000_000;
  const clock = createClock(() => real);
  const live = withTests(createLive({ viewer: await W.viewer({ keyless: true }), keyless: true, ...PAGE, wall: clock.wall }));
  await replay(live, readSave(ls, 'w').save, clock);
  return { live, move: ms => { real += ms; } };
}

// ====================================================================== #325 demo-dgp1-waves, in the page's world
// The late games: this file's player, every 5 turns, guarding 1.25 × the card's wave. In the page's world (fixed map)
// nations 3 and 4 reach the late phase (lost at 185 / 183 turns when measured); the others win before turn 120.
const LATE = [{ nation: 3, guardK: 1.25 }, { nation: 4, guardK: 2 }];

test('1 #325 the late phase in the page\'s world: waves from turn 120 every 5 turns ×1.2, the card names the wave that comes, no skirmisher breaks the leader\'s hold, the game ends ≤ 200 turns', async () => {
  const R = G.DEMO_GOAL, L = G.lateWave();
  assert.equal(R.lateFromBells, 120);
  for (const { nation, guardK } of LATE) {
    const seen = [], holders = new Map();
    const { live } = await session({ nation, guardK, look: (lv, g) => {
      const log = lv.goalLog();
      if (g.nextWave !== null) seen.push({ turn: g.turn, at: g.nextWave, troops: g.waveTroops, late: g.late, sent: log.some(x => x.kind === 'wave' && x.bell === g.nextWave),
        due: G.waveAt(g.turn - g.posted) !== null && !log.some(x => x.kind === 'wave' && x.bell === g.turn) });
      // (the castles as the turn's first look saw them: before its npc step, when that turn's wave picks its targets)
      if (!holders.has(g.turn)) holders.set(g.turn, new Map(g.castles.map(c => [c.nation, c.holder])));
    } });
    const g = live.goal(), posted = g.posted, leader = G.leaderOf(nation), waves = live.goalLog().filter(x => x.kind === 'wave');
    const tag = `nation ${nation}`;
    const late = waves.filter(w => w.wave >= L);
    assert.ok(late.length >= 10, `${tag}: the late phase was played (${late.length} late wave hosts)`);
    // the schedule, from the goal's posting (D-verify-pr325-2: "from turn 120" is the first wave at or after 120)
    const bells = [...new Set(waves.map(w => w.bell - posted))];
    const early = Array.from({ length: L + 1 }, (_, k) => R.graceBells + k * R.waveEvery);
    assert.deepEqual(bells.slice(0, L + 1), early, `${tag}: every 10 turns to the first late wave`);
    assert.equal(bells[L], 128, 'the first late-spaced wave is at turn 128 (wave 10; 118 is the last 10-turn one)');
    for (let i = L + 1; i < bells.length; i++) assert.equal(bells[i] - bells[i - 1], 5, `${tag}: every 5 turns after turn ${bells[L]}`);
    // the troops: a wave host is the wave's troops (the leader's × 1.2, capped); ×1.2 from wave L + 1 on
    for (const w of waves.filter(x => x.troops)) {
      const base = G.waveTroops(w.wave);
      assert.equal(w.troops, w.nation === leader ? Math.min(R.waveCap, Math.round(base * 1.2)) : base, `${tag}: wave ${w.wave} of nation ${w.nation}`);
    }
    for (let k = L + 1; k <= Math.max(...late.map(w => w.wave)); k++) assert.ok(Math.abs(G.waveTroops(k) / G.waveTroops(k - 1) - 1.2) < 0.02, `wave ${k}: ×1.2`);
    // the stuck-wave fix: no wave lost to a full home; a wave host left at home (Path) is the next wave's host
    assert.equal(waves.filter(w => w.code === 'Full').length, 0, `${tag}: no wave lost to a full home`);
    for (const w of waves.filter(x => x.code === 'Path')) {
      const next = waves.find(x => x.nation === w.nation && x.wave > w.wave);
      if (next) assert.equal(next.reused, true, `${tag}: nation ${w.nation}'s wave after its stalled wave ${w.wave} reuses the host left at home`);
    }
    assert.ok(waves.some(w => w.reused), `${tag}: wave hosts were reused`);
    // no hold-breaking late: no late wave of a nation other than the leader marches on a castle the leader holds
    for (const w of late.filter(x => x.nation !== leader && x.dest)) {
      const c = g.castles.find(k => k.p === w.dest.p && k.q === w.dest.q && k.tile === w.dest.tile);
      if (!c) continue;
      const before = holders.get(w.bell);
      assert.ok(before, `${tag}: the castles were read in turn ${w.bell}`);
      assert.notEqual(before.get(c.nation), leader, `${tag}: late wave ${w.wave} of nation ${w.nation} (${w.target}) on ${c.nation}'s castle, held by the leader ${leader}`);
    }
    assert.ok(late.some(w => w.nation !== leader && w.target === 'raid'), `${tag}: skirmishers raided in the late phase`);
    // the card: the wave it names is the next one sent, with its troops; "late" exactly when that wave is late-spaced
    const sent = new Map();
    for (const w of waves.filter(x => x.nation !== leader && x.troops)) sent.set(w.bell, w.troops);
    for (const s of seen) {
      assert.equal(s.sent, false, `${tag} turn ${s.turn}: the card never names a wave already sent`);
      if (s.due) assert.equal(s.at, s.turn, `${tag} turn ${s.turn}: a wave due this turn and not yet sent is the card's next wave`);
      if (sent.has(s.at)) assert.equal(s.troops, sent.get(s.at), `${tag} turn ${s.turn}: wave at ${s.at}`);
      assert.equal(s.late, G.waveAt(s.at - posted) > L, `${tag} turn ${s.turn}: the late line`);
    }
    assert.ok(seen.some(s => s.late) && seen.some(s => !s.late));
    assert.ok(seen.filter(s => s.due).length >= 10, `${tag}: the card was read in a wave's turn before the wave went (${seen.filter(s => s.due).length})`);
    // the game ends, lost to the leader, within the no-stalemate bound (verify-pr325: ≤ 203 in 210 model games)
    assert.ok(g.result, `${tag}: a result`);
    assert.equal(g.result.state, 'lost'); assert.deepEqual(g.result.nations, [leader]);
    assert.ok(g.result.bell - posted <= 200, `${tag}: ended at turn ${g.result.bell - posted}`);
  }
});

test('2 #325 a reload in the late phase replays the same escalation (save.mjs replay, page\'s world, past turn 140)', async () => {
  const { nation, guardK } = LATE[0];
  const A = await session({ nation, guardK, stopAt: 142 });
  const a = A.live.goal();
  assert.ok(!a.result && a.turn - a.posted >= 142, `still playing at ${a.turn - a.posted}`);
  assert.ok(A.live.goalLog().some(w => w.kind === 'wave' && w.wave > G.lateWave()), 'late waves before the save');
  const B = await reload(A.ls);
  assert.equal(json(B.live.goalLog()), json(A.live.goalLog()), 'the same waves up to the save');
  assert.equal(json(B.live.goal()), json(a), 'the same goal record (card, next wave, late line)');
  // both run on unplayed: the same next waves and the same result
  for (let k = 0; k < 80 && !A.live.goal().result; k++) { A.move(MS); B.move(MS); }
  assert.ok(A.live.goal().result, 'the game ended');
  assert.equal(json(B.live.goal()), json(A.live.goal()));
  assert.equal(json(B.live.goalLog()), json(A.live.goalLog()));
});

test('3 #325 idle players in the page\'s world (every nation): no wave lost to a full home, a stalled wave\'s host marches again, every game ends', async () => {
  for (let nation = 0; nation < 6; nation++) {
    const { live } = await session({ nation, act: false, turns: 220 });
    const g = live.goal(), waves = live.goalLog().filter(x => x.kind === 'wave');
    assert.ok(g.result && g.result.state === 'lost', `nation ${nation}: lost`);
    assert.equal(waves.filter(w => w.code === 'Full').length, 0, `nation ${nation}`);
    for (const w of waves.filter(x => x.code === 'Path')) {
      const next = waves.find(x => x.nation === w.nation && x.wave > w.wave);
      if (next) assert.equal(next.reused, true, `nation ${nation}: after nation ${w.nation}'s stalled wave ${w.wave}`);
    }
  }
});

// ====================================================================== #324 fix-tg11-since (SKIP until it is merged)
const HAS_LAND = typeof createLive({ viewer: { keyless: true }, keyless: true, stage: 'none' }).testPlay?.land === 'function';
const NEEDS_324 = HAS_LAND ? false : '#324 (fix-tg11-since) is not merged: the world has no testPlay.land() (its raw land records) yet';

test('4 #324 every province\'s land record is made with the world, and no read writes one (between resolves, a burst of every page read leaves the records as they were)', { skip: NEEDS_324 }, async () => {
  let real = 1_000_000;
  const live = createLive({ viewer: await W.viewer({ keyless: true }), keyless: true, ...PAGE, wall: () => real });
  // before any read of the world: every province has its record
  const first = live.testPlay.land();
  const provinces = live.summary().territory.map(t => `${t.p},${t.q}`).sort();
  assert.deepEqual(Object.keys(first).sort(), provinces, 'a record for every province, before the first read');
  assert.ok(provinces.length >= 19, `rings 0–2: ${provinces.length} provinces`);
  const reads = () => {
    live.summary(); live.clock(); live.goal(); live.goalLog(); live.camps(); live.campsLog(); live.travelers?.(); heraldClock(live);
    live.herald('/h/demo/goal', new URL('http://x/h/demo/goal'));
    for (const k of provinces) { const [p, q] = k.split(',').map(Number); live.province(p, q); }
  };
  real += 900; live.seen(); real += 3_100;
  assert.equal(live.testPlay.join(2).ok, true);
  const me = live.summary().me, k = `${me.village[0]},${me.village[1]}`, b0 = live.turn();
  const raw = json(live.testPlay.land());
  // the window #324 is about: the village is placed, its tile not yet granted by a resolve
  assert.notEqual(live.testPlay.land()[k].owners[me.tile], me.nation, 'the record grants the tile at the next resolve');
  assert.equal(live.summary().territory.find(t => `${t.p},${t.q}` === k).owners[me.tile], me.nation, 'a read shows it at once');
  // (until the next resolve: the records' bell moves on)
  const bell0 = JSON.parse(raw)[k].bell;
  let n = 0;
  for (; n < 200; n++) {
    reads(); reads();
    const now = live.testPlay.land();
    if (now[k].bell !== bell0) break;
    assert.equal(json(now), raw, `reads at +${n * 50} ms wrote nothing`);
    real += 50;
  }
  assert.ok(n >= 10 && n < 200, `${n} rounds of reads before the resolve`);
  // the resolve grants it, whoever read
  while (live.turn() < b0 + 2) real += 500;
  const t = live.testPlay.land()[k];
  assert.equal(t.owners[me.tile], me.nation);
  assert.equal(t.since[me.tile], JSON.parse(raw)[k].bell + 1, 'stamped by the first resolve after the placement');
});

test('5 #324 the same inputs make the same world at any read cadence (none, 250 ms, 9 s, bursts), every tile\'s since included, and the reload is that world', { skip: NEEDS_324 }, async () => {
  const pageReads = live => { live.summary(); live.goal(); live.camps(); live.travelers?.(); heraldClock(live); live.herald('/h/demo/goal', new URL('http://x/h/demo/goal')); };
  let n = 0;
  const burst = live => { if (n++ % 40 < 8) for (let i = 0; i < 5; i++) pageReads(live); };
  const CADENCES = [['none', null, null], ['250 ms', 250, pageReads], ['9 s', 9_000, pageReads], ['bursts', 100, burst]];
  for (const nation of [1, 4]) {
    const out = [];
    for (const [name, cadence, reads] of CADENCES) {
      const A = await session({ nation, stopAt: 45, cadence, reads });
      // (by value: goalLog() and the others are the world's own arrays, which grow as it runs on)
      const s = JSON.parse(json(worldState(A.live)));
      out.push([name, hash(s), s]);
      if (name === '250 ms') {
        const B = await reload(A.ls);
        assert.equal(hash(worldState(B.live)), hash(s), `nation ${nation}: the reload is the played world`);
        A.move(20 * MS); B.move(20 * MS);
        assert.equal(hash(worldState(B.live)), hash(worldState(A.live)), `nation ${nation}: and 20 turns on`);
      }
    }
    const land = out[0][2].land, me = out[0][2].summary.me;
    assert.ok(me && Object.values(land).some(t => t.owners.some(o => o === me.nation)), 'the session holds land');
    for (const [name, h, s] of out.slice(1)) {
      for (const key of Object.keys(s)) assert.equal(json(s[key]), json(out[0][2][key]), `nation ${nation}, ${name} vs none: ${key}`);
      assert.equal(h, out[0][1]);
    }
  }
});

// ====================================================================== #321 demo-goal-polish-1: the goal card on a phone
/**
 * A stand-in document for goalhud.mjs's startGoalHud: just what it touches (ids, classes, style, dataset, listeners,
 * innerHTML as text, a settable bounding box). No browser, no layout: the test places the drawer and the card.
 */
function fakeDocument() {
  const byId = new Map();
  const make = tag => {
    const listeners = new Map(), classes = new Set();
    let id = '', html = '';
    const el = {
      tagName: tag.toUpperCase(), style: {}, dataset: {}, hidden: false, children: [], parent: null, textContent: '', box: { top: 0 },
      get id() { return id; }, set id(v) { if (id) byId.delete(id); id = v; if (el.parent) byId.set(v, el); },
      get innerHTML() { return html; }, set innerHTML(v) { html = String(v); },
      classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c), toggle: (c, on) => { const want = on === undefined ? !classes.has(c) : !!on; if (want) classes.add(c); else classes.delete(c); return want; } },
      setAttribute: (k, v) => { el[`@${k}`] = v; },
      appendChild: c => { c.parent = el; el.children.push(c); if (c.id) byId.set(c.id, c); return c; },
      remove: () => { if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1); if (id) byId.delete(id); el.parent = null; },
      addEventListener: (ev, f) => { listeners.set(ev, [...(listeners.get(ev) ?? []), f]); },
      dispatch: (ev, e = {}) => { for (const f of listeners.get(ev) ?? []) f({ target: el, ...e }); },
      getBoundingClientRect: () => ({ top: el.box.top, bottom: el.box.top + 10, left: 0, right: 10 }),
      closest: () => null,
    };
    return el;
  };
  const doc = { createElement: make, getElementById: k => byId.get(k) ?? null, addEventListener: () => {} };
  doc.head = make('head'); doc.body = make('body');
  doc.head.parent = doc.body.parent = doc;
  /** An element of the page's own (the drawer #panel, the march composer's #mc-title). */
  doc.put = (tag, idv) => { const e = make(tag); doc.body.appendChild(e); e.id = idv; return e; };
  return doc;
}

/** goalhud.mjs started on the stand-in document, the page world as its world, a phone (≤ 700 px) or a desktop. */
async function goalCard({ narrow = true, language = 'en' } = {}) {
  const frames = [], timers = [];
  let pollFn = null;
  globalThis.matchMedia = q => ({ matches: narrow && /max-width: 700px/.test(q) });
  globalThis.requestAnimationFrame = f => { frames.push(f); return frames.length; };
  globalThis.innerWidth = narrow ? 390 : 1280; globalThis.innerHeight = 844;
  const realInterval = globalThis.setInterval, realTimeout = globalThis.setTimeout;
  globalThis.setInterval = f => { pollFn = f; return 1; };            // the 700 ms poll: called by hand
  const { setLang } = await import('../../permutation-server/web/lang.mjs');
  setLang(language);
  let real = 1_000_000;
  const live = createLive({ viewer: await W.viewer({ keyless: true }), keyless: true, ...PAGE, wall: () => real });
  globalThis.__wyllsDemo = { world: async () => live };
  const doc = fakeDocument();
  const { startGoalHud } = await import('../demo/src/goalhud.mjs');
  try { startGoalHud(doc); } finally { globalThis.setInterval = realInterval; }
  const card = doc.getElementById('demo-goal');
  const frame = () => { const f = frames.shift(); assert.ok(f, 'a frame is scheduled'); f(); };
  // (the poll: the world's goal record, then the card is rendered)
  const poll = async () => { assert.ok(pollFn, 'the card polls'); pollFn(); for (let i = 0; i < 5; i++) await new Promise(r => realTimeout(r, 0)); };
  /** A pointer event on the card, its timers taken by the test (the 400 ms after a finger lifts). */
  const press = ev => { globalThis.setTimeout = (f, ms) => { timers.push({ f, ms }); return timers.length; }; try { card.dispatch(ev); } finally { globalThis.setTimeout = realTimeout; } };
  return { doc, card, live, frame, frames, timers, poll, press, move: ms => { real += ms; }, start: () => { real += 900; live.seen(); real += 3_100; } };
}

test('6 #321 phones: the goal card keeps to the room above the open Hosts drawer, every frame (header only; the castles while a march is composed; none when no room), and gives the room back when it closes', async () => {
  const { doc, card, frame, frames } = await goalCard();
  assert.ok(card, 'the card is in the page');
  const panel = doc.put('aside', 'panel');
  card.box.top = 150;
  // the drawer closed: nothing to keep out of
  panel.dataset.drawer = 'closed'; panel.box.top = 364;
  frame();
  assert.equal(card.classList.contains('dg-auto-fold'), false); assert.equal(card.classList.contains('dg-off'), false); assert.equal(card.style.maxHeight ?? '', '');
  // the drawer opens between two polls: the next frame folds the card to its header and keeps it above the drawer
  panel.dataset.drawer = 'open';
  frame();
  assert.equal(card.classList.contains('dg-auto-fold'), true, 'header only over an open drawer when nothing is composed');
  assert.equal(card.style.maxHeight, `${364 - 150 - 6}px`, 'no taller than the room above the drawer');
  // a march is composed: the castles (and their "March here") show, still above the drawer
  const title = doc.put('h3', 'mc-title');
  frame();
  assert.equal(card.classList.contains('dg-auto-fold'), false);
  assert.equal(card.classList.contains('composing'), true);
  assert.equal(card.style.maxHeight, '208px');
  // the drawer is pulled up: less room, a lower cap; no room at all: the card is off
  panel.box.top = 230; frame();
  assert.equal(card.style.maxHeight, '74px'); assert.equal(card.classList.contains('dg-off'), false);
  panel.box.top = 180; frame();
  assert.equal(card.classList.contains('dg-off'), true, 'no room above the drawer: the card does not lie over it');
  // composing ends, the drawer closes: the cap and the fold go
  title.remove(); panel.dataset.drawer = 'closed'; frame();
  for (const c of ['dg-auto-fold', 'dg-off', 'composing']) assert.equal(card.classList.contains(c), false, c);
  assert.equal(card.style.maxHeight, '');
  assert.ok(frames.length === 1, 'and it keeps fitting every frame');
  // the CSS hides what the classes say
  assert.match(src('../demo/src/goalhud.mjs'), /#demo-goal\.dg-auto-fold \.dg-body,#demo-goal\.dg-off\{display:none\}/);
});

test('7 #321 desktops: the card never folds for the drawer (the rule is a phone\'s)', async () => {
  const { doc, card, frame } = await goalCard({ narrow: false });
  const panel = doc.put('aside', 'panel');
  panel.dataset.drawer = 'open'; panel.box.top = 160; card.box.top = 150;
  doc.put('h3', 'mc-title');
  frame();
  for (const c of ['dg-auto-fold', 'dg-off', 'composing']) assert.equal(card.classList.contains(c), false, c);
  assert.equal(card.style.maxHeight ?? '', '');
});

test('8 #321 the card is not rebuilt under a finger (a tap on "March here" is not lost to the poll), and says hold 20 in EN and JA', async () => {
  for (const language of ['en', 'ja']) {
    const { card, live, poll, move, start, timers, press } = await goalCard({ language });
    start();
    assert.equal(live.testPlay.join(2).ok, true);
    move(6_000);
    await poll();
    const { TEXT } = await import('../demo/src/goalhud.mjs');
    const t = TEXT[language];
    assert.equal(G.DEMO_GOAL.holdBells, 20);
    assert.ok(card.innerHTML.includes(t.rule(3, 20).replace(/'/g, '&#39;')), `${language}: the card's rule says 20 turns: ${card.innerHTML.slice(0, 300)}`);
    // a pointer goes down on the card; the world moves (a castle's timer, a wave): the card waits
    const before = card.innerHTML;
    press('pointerdown');
    move(5 * MS);
    await poll();
    assert.equal(card.innerHTML, before, `${language}: not rebuilt while the finger is down`);
    // the finger lifts: 400 ms later the next poll catches up
    press('pointerup');
    const lift = timers.find(x => x.ms === 400);
    assert.ok(lift, 'the press is cleared 400 ms after the finger lifts');
    lift.f();
    await poll();
    assert.notEqual(card.innerHTML, before, `${language}: rebuilt after the tap`);
  }
});

test('9 #321 the guide\'s goal sentence: the English text is the new one (verify-pr321 D-3: only the Japanese was pinned), and it is true: AI hosts stand on the player\'s land, it stays the player\'s', async () => {
  const EN = (await import('../../permutation-server/web/lang/en-frontier-play.mjs')).default;
  const ja = 'ほかの国の旗の城を{0}つ取り、それぞれ{1}ターン守り続けると勝ちです。ほかの国も同じ城を狙い、あなたが取った城を攻めてきます。あなたの土地にも軍勢を送ってきますが、土地は進軍では奪われません。左上の目標カードに、城と保持の時間が出ています。';
  assert.ok(src('../../permutation-server/web/frontier/screens/onboarding.mjs').includes(ja.replace('{0}', '${goal.need}').replace('{1}', '${goal.holdBells}')), 'the guide says it');
  const en = EN[ja];
  assert.equal(typeof en, 'string');
  assert.match(en, /will attack the castles you capture\. They also send hosts onto your land, but marching never takes land\./);
  assert.doesNotMatch(en, /attack your castles and land/, 'not the old sentence');
  assert.doesNotMatch(en, /season/i);
  // the claim in the world: the player claims land; the AI raids it (raids go to the player's land nearest the
  // raider when the player holds no castle); hosts stand on it; every claimed tile stays the player's while upkeep is paid
  let real = 1_000_000;
  const live = createLive({ viewer: await W.viewer({ keyless: true }), keyless: true, ...PAGE, wall: () => real });
  real += 900; live.seen(); real += 3_100;
  // (nation 0: its land is the nearest target of three raiders on the fixed map; nation 4's is raided by none)
  assert.equal(live.testPlay.join(0).ok, true);
  real += 6_000;
  const me = live.summary().me, [p, q] = me.village;
  const claimed = [];
  for (const tile of [me.tile + 1, me.tile - 1, me.tile + 8, me.tile - 8, me.tile + 9, me.tile - 9, me.tile + 7, me.tile - 7]) {
    if (claimed.length >= 2) break;
    const a = await live.relay('POST', '/gw/f/sample/territory', { p, q, tile }), r = a?.body ?? a;
    if (r.ok) claimed.push(tile);
    real += MS;
  }
  assert.equal(claimed.length, 2, 'two tiles claimed');
  const ownerOf = tile => live.summary().territory.find(t => t.p === p && t.q === q).owners[tile];
  let stood = 0;
  for (let i = 0; i < 160 && !live.goal().result; i++) {
    real += MS;
    const pv = live.province(p, q);
    for (const tile of claimed) {
      if (pv.entries.some(e => e.state === 1 && e.tile === tile && e.faction !== me.nation)) stood++;
      assert.equal(ownerOf(tile), me.nation, `turn ${live.turn()}: tile ${tile} is still the player's`);
    }
  }
  const raids = live.goalLog().filter(w => w.kind === 'wave' && w.target === 'raid' && w.ok && w.dest?.p === p && w.dest?.q === q && claimed.includes(w.dest.tile));
  assert.ok(raids.length >= 3, `AI waves marched onto the claimed land (${raids.length})`);
  assert.ok(stood >= 20, `AI hosts stood on it (${stood} tile-turns)`);
});
