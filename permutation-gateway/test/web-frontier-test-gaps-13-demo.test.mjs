// test-gaps-13: PR-CI tests for #327 (fix-loop32) in the walletless demo's own world. #327's unit tests use a recorded
// conquest fixture, a hand-made page state and a hand-made kernel outcome; the real thing was played in a browser by hand
// (verify-pr327). Here the page's world (demo/src/boot.mjs's createLive options) is played on a hand clock and read the way
// the page reads it: web/frontier/herald.mjs over the world's own /h/ routes, flog.mjs, the map's keep board mount, the
// guide's facts, the report screen and "Verify in this browser" (the real kernel).
//   D  every clash in which a host of the player's is attacked where it stands (a flag castle held) is told once — notice
//      and "your clash reports" — with the troops the world took, and nothing else is told
//   G  the guide's sixth step is the flag castle: there before the capture, gone while one is held, back when it is lost
//   C  a camp cleared by holding its tile (the kernel leaves troops in it) reads Victory before AND after the check
// KEY-FREE, NO SIGNATURE: the keyless viewer; the player's inputs are the world's test instructions (testPlay, order).
// #327 is merged (d59b761da); the tests would say SKIP only on a tree without it (no ownClashOn in map/keepmount.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as W from '../screens/world.mjs';
import { createLive } from '../screens/liveworld.mjs';
import { kernel } from '../screens/kernel.mjs';
import { tileHex, hexDistance } from '../../permutation-server/web/frontier/fgeo.mjs';
import { createHerald } from '../../permutation-server/web/frontier/herald.mjs';
import { decodePage } from '../../permutation-server/web/frontier/flog.mjs';
import { decode } from '../../permutation-server/web/frontier/fcodec.mjs';
import { fromBase64 } from '../../permutation-server/web/sdk/bytes.mjs';
import { seasonClock as worldClock } from '../../permutation-server/web/frontier/clock.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import * as keepmount from '../../permutation-server/web/frontier/map/keepmount.mjs';
import { factsOf, onboardingState } from '../../permutation-server/web/frontier/onboarding.mjs';
import { objectiveModel } from '../../permutation-server/web/frontier/screens/onboarding.mjs';
import * as report from '../../permutation-server/web/frontier/screens/report.mjs';

const skip = typeof keepmount.ownClashOn === 'function' ? false : 'this tree has no #327 (fix-loop32): map/keepmount.mjs exports no ownClashOn';
const TURN = 12, MS = TURN * 1000;
const PAGE = { stage: 'none', opening: true, territory: true, nations: true, landUpkeep: true, landClaim: true, travelers: true, camps: true, goal: true, turn: TURN, delay: 3, landMs: 400 };
const tick = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };
const why = r => `${r.code ?? ''} ${r.message ?? r.error ?? ''}`;
const whole = milli => Math.floor(Number(milli) / 1000);

/** The page's world on a hand clock, joined, and a page that reads it through the real herald client. */
async function start(nation) {
  let real = 1_000_000;
  const viewer = await W.viewer({ keyless: true });
  const live = createLive({ viewer, keyless: true, ...PAGE, wall: () => real });
  const asked = [];
  const herald = createHerald({ base: 'http://x', fetch: async url => {
    const u = new URL(url), a = live.herald(u.pathname, u);
    asked.push(u.pathname);
    // (demo/src/boot.mjs withDemo: the static bundle's world says `sample.demo`)
    const body = a?.body?.sample ? { ...a.body, sample: { ...a.body.sample, demo: { live: '', crypto: 'ok' } } } : a?.body;
    return new Response(a ? (body instanceof Uint8Array ? body : JSON.stringify(body)) : '{}', { status: a ? a.status ?? 200 : 404 });
  } });
  const step = ms => { real += ms; live.clock(); };
  const s = await herald.season();
  assert.equal(s.ok, true, why(s));
  step(4_000);
  const j = live.testPlay.join(nation);
  assert.equal(j.ok, true, why(j));
  step(MS);
  const fs = { mode: 'play', record: s.record, sample: s.record.sample, season: s.season, clock: worldClock(s.season), citizen: null, holdings: [], marches: [], provinces: new Map(), chronicle: undefined,
    feed: [], ownClashes: [], ui: { autoPan: false, battleFx: 'off', dismissed: [] }, land: { stage: 'final' }, chain: { now: () => live.clock()?.chainNow ?? 0 }, ownLand: { player: { tiles: 0 } } };
  let cursor = 0;
  const ids = new Set();   // every host the world has listed as the player's
  const all = [];       // every record of the world's log (the truth below reads it; the page keeps its last 400)
  /** One poll of the page: the record, the viewer, the provinces it has a host or a village in, the log. */
  async function poll({ sight = 'all' } = {}) {
    const r = await herald.season(); fs.record = r.record; fs.sample = r.record.sample;
    const me = await herald.me(viewer.wallet);
    assert.equal(me.ok, true, why(me));
    fs.citizen = me.citizen; fs.holdings = me.holdings; fs.nowBell = live.turn();
    const want = new Set([...fs.holdings.map(h => `${h.p},${h.q}`), ...live.summary().me.hosts.map(h => h.province.join(',')), ...(sight === 'all' ? fs.provinces.keys() : [])]);
    for (const h of live.summary().me.hosts) ids.add(String(h.id));
    for (const key of want) { const [p, q] = key.split(',').map(Number), pv = await herald.province(p, q); if (pv.ok) fs.provinces.set(key, pv); }
    for (let i = 0; i < 20; i++) {
      const e = await herald.events(cursor);
      assert.equal(e.ok, true, why(e));
      const { records } = decodePage(e.events);
      all.push(...records); fs.chronicle = [...(fs.chronicle ?? []), ...records].slice(-400); cursor = Number(e.next);
      if (!e.full) break;
    }
  }
  return { live, herald, fs, step, poll, all, asked, nation, ids };
}

/** The player's turn (this file's own player): build, train, muster, keep a guard on a taken castle, march on the nearest castle it outnumbers. */
function act(g, { guardK = 1.25, take = true } = {}) {
  const { live, fs, nation } = g, goal = live.goal(), me = () => live.summary().me, m = me(), [p, q] = m.village, home = tileHex(p, q, m.tile);
  const d = c => { const h = tileHex(c.p, c.q, c.tile); return hexDistance(h.q, h.r, home.q, home.r); };
  const on = (c, own) => live.province(c.p, c.q).entries.filter(e => e.state === 1 && e.tile === c.tile && (e.faction === nation) === own).reduce((a, e) => a + whole(e.troops), 0);
  g.dest ??= new Map(); g.far ??= new Set();
  for (const item of [0, 3, 0]) live.order('Build', { item }, { p, q });
  for (const n of [1000, 600, 400, 200]) if (live.order('Train', { unit: 0, n }, null).ok) break;
  if (m.reserve[0] >= 200) live.order('Muster', { unit: 0, troops: m.reserve[0], tile: m.tile }, { p, q });
  if (!take) return;
  const onCastle = h => goal.castles.some(c => c.p === h.province[0] && c.q === h.province[1] && c.tile === h.tile);
  const pool = me().hosts.filter(h => h.state === 1 && h.unit === 0 && h.stamina >= 74 && h.readyBell <= goal.turn && h.troops >= 100 && !me().marches.some(x => x.host === h.id) && !onCastle(h)).sort((a, b) => b.troops - a.troops);
  const coming = c => me().marches.some(x => g.dest.get(x.host) === `${c.p},${c.q}`);
  const march = (h, c) => {
    const r = live.testPlay.march(h.id, { p: c.p, q: c.q, tile: c.tile });
    if (r.ok) { g.dest.set(h.id, `${c.p},${c.q}`); fs.marches = [...fs.marches, { dest: { p: c.p, q: c.q, tile: c.tile }, entry: { arriveBell: r.arrive } }]; } else if (r.code === 'Path') g.far.add(`${c.p},${c.q}`);
    return r.ok;
  };
  const guard = Math.max(150, Math.round((goal.waveTroops ?? 0) * guardK));
  for (const c of goal.castles.filter(x => x.holder === nation && x.nation !== nation && on(x, true) < guard && !coming(x))) { const h = pool.shift(); if (h) march(h, c); }
  for (const c of goal.castles.filter(x => x.nation !== nation && x.holder !== nation && !coming(x) && !g.far.has(`${x.p},${x.q}`)).sort((a, b) => d(a) - d(b))) {
    const want = on(c, false) * 1.3 + 50;
    if (pool.reduce((a, h) => a + h.troops, 0) < want) continue;
    for (let sent = 0; sent < want && pool.length;) { const h = pool.shift(); if (march(h, c)) sent += h.troops; }
    break;
  }
}

/** The world's own answer to "which clashes were the player's, attacked where a host of theirs stood": from each turn's records. */
async function attacked(g) {
  const out = new Map(), home = g.live.summary().me.village.join(',');
  for (const x of g.all) {
    const r = x.record ?? x;
    if (r.name !== 'CLASH' || !(Number(r.engagements) > 0) || `${r.p},${r.q}` === home) continue;
    const c = await g.herald.clash(r.p, r.q, r.bell), after = await g.herald.province(r.p, r.q, r.bell);
    assert.ok(c.ok && after.ok, `${r.p},${r.q} at ${r.bell}`);
    const before = decode('Province', fromBase64(c.report.province_before_b64));
    const arrivals = (c.inputs.arrivals ?? []).filter(a => a.present === 1);
    if (arrivals.some(a => g.ids.has(String(a.hostId)))) continue;                   // the player's own march: that march's line tells it
    const mine = before.entries.filter(e => e.state === 1 && g.ids.has(String(e.id)));
    const hit = mine.filter(e => arrivals.some(a => a.tile === e.tile && a.faction !== g.nation) || before.entries.some(o => o.state === 1 && o.tile === e.tile && o.faction !== g.nation));
    if (!hit.length) continue;
    const left = e => whole(after.province.entries.find(o => o.state === 1 && o.id === e.id)?.troops ?? 0);
    out.set(`${r.p},${r.q},${r.bell}`, { lost: hit.reduce((n, e) => n + whole(e.troops) - left(e), 0), stood: hit.every(e => left(e) > 0), castle: g.live.goal().castles.some(k => k.p === r.p && k.q === r.q && hit.some(e => e.tile === k.tile)) });
  }
  return out;
}

async function game({ nation, turns, guardK = 1.25, sight = 'all', every = 5, until = null }) {
  const g = await start(nation), { live, fs } = g;
  // the page's timers (a report asked for again) run on the hand clock
  const timers = [], real = globalThis.setTimeout;
  let now = 0;
  const map = { setKeepFeed(fn) { this.feed = fn; }, keeps: { reachOwn: true, setReach() {} } };
  const guide = [];
  try {
    globalThis.setTimeout = (fn, ms) => { timers.push({ fn, at: now + (ms ?? 0) }); return timers.length; };
    keepmount.mountKeepBoard({ map, state: () => fs, clash: (p, q, bell) => g.herald.clash(p, q, bell) });
    for (let i = 0; i < turns * 4; i++) {
      g.step(MS / 4); now += MS / 4;
      await g.poll({ sight });
      map.feed(); await tick();
      for (const t of timers.splice(0).sort((a, b) => a.at - b.at)) { if (t.at <= now) t.fn(); else timers.push(t); }
      await tick();
      const goal = live.goal();
      const st = onboardingState(factsOf(fs)), held = goal.castles.some(c => c.nation !== nation && c.holder === nation);
      guide.push({ turn: goal.turn, steps: st.steps.map(x => x.id), step: st.current, complete: st.complete, held, objective: st.complete ? null : objectiveModel(fs) });
      if (goal.result || until?.(guide)) break;
      // (with `until` — the game that loses a castle — the player stops acting once a castle is held)
      if (i % (4 * every) === 1 && !(until && guide.some(x => x.held))) act(g, { guardK });
    }
  } finally { globalThis.setTimeout = real; }
  return { ...g, guide };
}

const games = new Map();
const played = (key, o) => { if (!games.has(key)) games.set(key, game(o)); return games.get(key); };

test('D every clash of a host attacked where it stands is told once, with the troops the world took, and listed; nothing else is (two real games)', { skip }, async () => {
  let castles = 0, withdrew = 0, total = 0;
  for (const nation of [3, 4]) {
    const g = await played(`d${nation}`, { nation, turns: 135 }), want = await attacked(g), tag = `nation ${nation}`;
    assert.ok(want.size >= 10, `${tag}: the player was attacked (${want.size})`);
    // (the keep board itself is off in this world: the watch is the demo's own, map/keepmount.mjs ownClashOn)
    assert.equal(keepmount.keepFeedOf(g.fs).enabled, false);
    assert.deepEqual(g.fs.feed.map(x => x.id).sort(), [...want.keys()].map(k => `cl:${k}`).sort(), `${tag}: the notices are the world's clashes, each once`);
    assert.deepEqual(g.fs.ownClashes.map(c => `${c.p},${c.q},${c.bell}`), [...want.keys()].sort((a, b) => b.split(',')[2] - a.split(',')[2]).slice(0, 24), `${tag}: "your clash reports", newest first`);
    for (const x of g.fs.feed) {
      const k = x.id.slice(3), [p, q, bell] = k.split(',').map(Number), w = want.get(k);
      assert.equal(x.kind, 'battle');
      assert.deepEqual(x.battle, { p, q, bell }, `${tag} ${k}: the notice opens that clash's report`);
      assert.ok(x.text.includes(`州 ${p},${q}`) && x.text.includes(`ターン ${bell}`), `${tag} ${k}: ${x.text}`);
      assert.equal(/・(\d+) 兵を失いました/.exec(x.text)?.[1], String(w.lost), `${tag} ${k}: ${x.text}`);
      assert.doesNotMatch(x.text, /season|シーズン/i);
      castles += w.castle; withdrew += !w.stood; total++;
    }
  }
  assert.ok(castles >= 20 && withdrew >= 2, `${total} clashes, ${castles} on a flag castle, ${withdrew} where the host did not stay`);
});

test('D the report each notice opens is the real clash: the check in this browser matches and the player\'s loss is the notice\'s', { skip }, async () => {
  const g = await played('d3', { nation: 3, turns: 135 }), want = await attacked(g);
  let checked = 0;
  for (const x of g.fs.feed.slice(0, 6)) {
    const { p, q, bell } = x.battle, clash = await g.herald.clash(p, q, bell);
    const v = await report.verifyClash({ p, q, bell, clash, herald: g.herald, kernel, clock: g.fs.clock, season: g.fs.season });
    assert.equal(v.result, 'match', `${x.id}: ${why(v.steps)}`);
    const mine = report.outcomeRows(v.args, v.outcome, id => g.ids.has(String(id))).filter(r => r.mine && r.kind === 'resident' && r.engaged);
    const w = want.get(x.id.slice(3));
    if (w.stood) { assert.equal(mine.reduce((n, r) => n + r.before - r.after, 0), w.lost, x.id); checked++; }
  }
  assert.ok(checked >= 3);
});

test('G the guide\'s sixth step is the flag castle: there before the capture, gone while one is held, back when it is lost — also where the page no longer reads the province', { skip }, async () => {
  // the player takes a castle, then does nothing: an AI wave takes it back; the page reads only where it has a host or a village
  const g = await played('g', { nation: 0, turns: 200, sight: 'own', until: log => log.some(x => x.held) && !log.at(-1).held && log.filter(x => !x.held && x.turn > log.find(y => y.held).turn).length >= 12 });
  const first = g.guide.findIndex(x => x.held), lost = g.guide.findIndex((x, i) => i > first && !x.held);
  assert.ok(first > 0 && lost > first, 'a castle was taken and lost');
  for (const x of g.guide) assert.deepEqual(x.steps, ['join', 'build', 'train', 'muster', 'march', 'castle', 'done'], `turn ${x.turn}`);
  assert.equal(g.guide.some(x => x.step === 'claim'), false, 'never the tile claim');
  const marched = g.guide.findIndex(x => x.step === 'castle');
  assert.ok(marched > 0 && marched < first, 'the step is shown after the first march, before the capture');
  for (const [i, x] of g.guide.entries()) {
    if (i < marched) continue;
    assert.equal(x.step === 'castle', !x.held, `turn ${x.turn}: held ${x.held}, the guide says ${x.step}`);
    assert.equal(x.complete, x.held, `turn ${x.turn}`);
    if (!x.held) { assert.equal(x.objective.id, 'castle'); assert.equal(x.objective.title, '旗の城を取る'); assert.equal(`${x.objective.n}/${x.objective.total}`, '5/6'); }
  }
  // the world's record is what says it: the page's own copy of the lost castle's province may still show the player's nation
  const c = g.fs.sample.goal.castles, now = g.live.goal().castles;
  assert.deepEqual(c.map(k => [k.nation, k.p, k.q, k.tile, k.holder]), now.map(k => [k.nation, k.p, k.q, k.tile, k.holder]));
});

/** The report screen as app.mjs openReport fills it, before and after "Verify in this browser". */
async function campReport(g, p, q, bell) {
  const clash = await g.herald.clash(p, q, bell), now = (await g.herald.province(p, q, bell)).province;
  const FS = { ...g.fs, report: { p, q, bell, clash, before: decode('Province', fromBase64(clash.report.province_before_b64)), after: now, destroyed: Number(now.resolveSummary?.destroyed ?? 0) } };
  const mine = id => g.ids.has(String(id));
  const before = String(report.render(FS, mine));
  const v = await report.verifyClash({ p, q, bell, clash, herald: g.herald, kernel, clock: g.fs.clock, season: g.fs.season });
  FS.report.verify = v;
  return { before, after: String(report.render(FS, mine)), v, rows: report.outcomeRows(v.args, v.outcome, mine) };
}

test('C a camp cleared by holding its tile reads Victory before and after the check, with the camp at 0; a camp that beat the march off never does', { skip }, async () => {
  const seen = { held: 0, beaten: 0 };
  for (const [nation, troops] of [[2, 500], [1, 500], [4, 500], [2, 200]]) {
    const g = await start(nation), { live } = g, me = () => live.summary().me, [p, q] = me().village;
    const turn = () => g.step(MS);
    g.step(MS / 2);
    assert.equal(live.order('Train', { unit: 0, n: troops }, null).ok, true);
    turn();
    assert.equal(live.order('Muster', { unit: 0, troops, tile: me().tile }, { p, q }).ok, true);
    turn(); turn();
    await g.poll();
    const host = me().hosts.find(h => h.troops === troops);
    const camp = live.camps().camps.filter(c => c.up && c.troops === 500).find(c => { const r = live.testPlay.march(host.id, { p: c.p, q: c.q, tile: c.tile }); if (r.ok) c.arrive = r.arrive; return r.ok; });
    assert.ok(host && camp, 'a host marches on a camp of 500');
    while (live.turn() <= camp.arrive + 1) turn();
    await g.poll();
    const r = await campReport(g, camp.p, camp.q, camp.arrive);
    assert.equal(r.v.result, 'match');
    const gar = r.v.outcome.garrisons.find(x => r.v.args.garrisons.find(a => a.id === x.id)?.faction === report.NEUTRAL);
    const cleared = live.province(camp.p, camp.q).camp.state === 0;
    for (const [lang, won] of [['ja', /勝利/], ['en', /Victory/]]) {
      setLang(lang);
      const x = await campReport(g, camp.p, camp.q, camp.arrive);
      assert.equal(won.test(x.before), cleared, `${lang}, ${troops} on 500, before the check`);
      assert.equal(won.test(x.after), cleared, `${lang}, ${troops} on 500, after the check`);
      const row = x.rows.find(y => y.kind === 'camp');
      assert.equal(row.before, 500);
      assert.equal(row.after, cleared ? 0 : whole(gar.troops));
    }
    setLang('ja');
    if (cleared && gar.troops > 0) { assert.equal(gar.attackersHold, true); seen.held++; }
    if (!cleared) seen.beaten++;
  }
  assert.ok(seen.held >= 1, `the kernel left troops in a camp whose tile the attackers hold (${JSON.stringify(seen)})`);
  assert.ok(seen.beaten >= 1, `a march was beaten off (${JSON.stringify(seen)})`);
});
