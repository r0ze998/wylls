// pt-world-goals-devnet: the devnet world's off-chain world-goals judge (wide-flags.mjs, devnet-world-goals.mjs) and the
// relay's read-only route (routes/world-goals.mjs). Synthetic captured wide Province bytes (frontier-abi
// world_index/land.rs layout); no chain, no herald process, no key, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { answerOf, initialState, observationOf, readWideProvince, replay, standingsOf, stepFlags, WIDE_FLAGS_RULESET, WP } from '../src/frontier/wide-flags.mjs';
import { ANSWER_FILE, ARCHIVE_FILE, openJudge, parseArgs, readHerald, replayArchive } from '../src/frontier/devnet-world-goals.mjs';
import { goalsFileReader, servableGoals, worldGoalsRoutes, WORLD_GOALS_ROUTE } from '../src/frontier/routes/world-goals.mjs';

const SEASON = '3';
const WORLD = 'ab'.repeat(32);
const NEUTRAL = 0xff;

/** A ready captured wide Province (4,864 B) with the given keep and sites. */
function province({ season = SEASON, world = WORLD, resolvedNext = 1, keep = { tile: 30, holder: NEUTRAL, since: 0, gen: 0, lastFrom: NEUTRAL }, sites = [] } = {}) {
  const b = new Uint8Array(WP.SIZE), v = new DataView(b.buffer);
  b.set(Buffer.from(WP.MAGIC, 'latin1'), 0);
  v.setBigUint64(WP.SEASON_ID, BigInt(season), true);
  v.setUint16(WP.LAYOUT_VERSION, 3, true);
  v.setUint32(WP.RESOLVED_NEXT, resolvedNext, true);
  v.setUint16(WP.TRAILER + WP.T_FAMILY, 1, true);
  b[WP.TRAILER + WP.T_STATUS] = 1;
  b[WP.TRAILER + WP.T_READY] = 15;
  b.set(Buffer.from(world, 'hex'), WP.TRAILER + WP.T_WORLD);
  const k = WP.KEEP;
  if (keep === null) b[k + WP.K_TILE] = 0xff;
  else {
    b[k + WP.K_TILE] = keep.tile; b[k + WP.K_HOLDER] = keep.holder;
    v.setUint32(k + WP.K_SINCE, keep.since, true); v.setUint32(k + WP.K_GEN, keep.gen, true); b[k + WP.K_LAST_FROM] = keep.lastFrom;
  }
  b[WP.SITE_COUNT] = sites.length;
  sites.forEach((s, i) => { b[WP.SITES + i] = s.tile ?? i; const o = WP.SITE_MIRROR + i * WP.SITE_SIZE; b[o] = s.state; b[o + 1] = s.faction ?? NEUTRAL; b[o + 4] = s.gen ?? 0; });
  return b;
}

/** A herald `/h/world/wide/page` entry for (p, q). */
const entry = (p, q, bytes, slot = 1) => ({ p: String(p), q: String(q), ring: '140', state: 'open', wide: { capture: { slot: String(slot), bytes_b64: Buffer.from(bytes).toString('base64') } } });
const obsOf = (...entries) => observationOf(entries, { seasonId: SEASON, world: WORLD });
const keepAt = (holder, since, gen, lastFrom = NEUTRAL) => ({ tile: 30, holder, since, gen, lastFrom });

test('readWideProvince reads the keep and the sites, and refuses what is not a ready wide Province of the season', () => {
  const r = readWideProvince(province({ resolvedNext: 77, keep: keepAt(2, 50, 1), sites: [{ state: 5 }, { state: 1, faction: 3, gen: 2 }] }), { seasonId: SEASON, world: WORLD });
  assert.equal(r.resolvedNext, 77);
  assert.deepEqual(r.keep, { tile: 30, holder: 2, flags: 0, troops: 0, since: 50, gen: 1, lastFrom: NEUTRAL });
  assert.deepEqual(r.sites.map(s => [s.state, s.faction, s.gen]), [[5, NEUTRAL, 0], [1, 3, 2]]);
  assert.equal(readWideProvince(province({ keep: null }), { seasonId: SEASON }).keep, null);
  assert.throws(() => readWideProvince(new Uint8Array(100), { seasonId: SEASON }), /WideProvinceLength/);
  const bad = province(); bad[0] = 0x41;
  assert.throws(() => readWideProvince(bad, { seasonId: SEASON }), /WideProvinceMagic/);
  assert.throws(() => readWideProvince(province({ season: '2' }), { seasonId: SEASON }), /WideProvinceSeason/);
  assert.throws(() => readWideProvince(province({ world: 'cd'.repeat(32) }), { seasonId: SEASON, world: WORLD }), /WideProvinceWorld/);
  const unready = province(); unready[WP.TRAILER + WP.T_READY] = 7;
  assert.throws(() => readWideProvince(unready, { seasonId: SEASON }), /WideProvinceNotReady/);
});

test('observationOf keeps open wide Provinces with a capture, in (p, q) order, and counts the refused', () => {
  const o = observationOf([
    entry(150, -3, province()), entry(-140, 2, province()), { ...entry(130, 0, province()), state: 'closed' },
    { ...entry(5, 5, province()), ring: '10' }, entry(141, 1, province({ season: '9' })),
  ], { seasonId: SEASON, world: WORLD });
  assert.deepEqual(o.provinces.map(x => `${x.p},${x.q}`), ['-140,2', '150,-3']);
  assert.equal(o.refused, 1);
  assert.match(o.provinces[0].sha, /^[0-9a-f]{64}$/);
});

test('a neutral wide keep captured and held 144 turns is achieved at since + 144, from the chain\'s own bells', () => {
  let st = initialState();
  // neutral at open
  st = stepFlags(st, obsOf(entry(140, 0, province({ resolvedNext: 90 })))).state;
  assert.equal(Object.keys(st.flags).length, 1);
  // nation 2 takes it: since 101 (a capture at bell 100)
  let s = stepFlags(st, obsOf(entry(140, 0, province({ resolvedNext: 150, keep: keepAt(2, 101, 1) }))));
  assert.deepEqual(s.events, []);
  // resolved through 244: not yet (needs resolved_next ≥ 245)
  s = stepFlags(s.state, obsOf(entry(140, 0, province({ resolvedNext: 244, keep: keepAt(2, 101, 1) }))));
  assert.deepEqual(s.events, []);
  s = stepFlags(s.state, obsOf(entry(140, 0, province({ resolvedNext: 245, keep: keepAt(2, 101, 1) }))));
  assert.deepEqual(s.events.map(e => [e.kind, e.nation, e.bell]), [['keep', 2, 245]]);
  // a judge that only ever saw the late capture gets the same achievement bell
  const late = stepFlags(initialState(), obsOf(entry(140, 0, province({ resolvedNext: 400, keep: keepAt(2, 101, 1) }))));
  assert.deepEqual(late.events.map(e => [e.nation, e.bell]), [[2, 245]]);
  const a = answerOf(s.state, { seasonId: SEASON });
  assert.equal(a.ruleset, WIDE_FLAGS_RULESET);
  assert.deepEqual(a.effects, { money: 'none', chain: 'none' });
  assert.deepEqual(a.wideFlags.flags[0].achieved, { nation: 2, bell: 245 });
});

test('captured then lost before 24 h: nothing for the first holder; the new holder counts from its own capture', () => {
  let st = initialState();
  st = stepFlags(st, obsOf(entry(140, 0, province({ resolvedNext: 150, keep: keepAt(1, 101, 1) })))).state;
  // nation 3 takes it at bell 199 (since 200), gen 2, from nation 1: nation 1 held 99 turns
  let s = stepFlags(st, obsOf(entry(140, 0, province({ resolvedNext: 210, keep: keepAt(3, 200, 2, 1) }))));
  assert.deepEqual(s.events, []);
  s = stepFlags(s.state, obsOf(entry(140, 0, province({ resolvedNext: 344, keep: keepAt(3, 200, 2, 1) }))));
  assert.deepEqual(s.events.map(e => [e.nation, e.bell]), [[3, 344]]);
  // a recapture by the same nation restarts its hold
  let r = stepFlags(initialState(), obsOf(entry(140, 0, province({ resolvedNext: 150, keep: keepAt(1, 101, 1) })))).state;
  r = stepFlags(r, obsOf(entry(140, 0, province({ resolvedNext: 160, keep: keepAt(NEUTRAL, 0, 1) })))).state; // (not a real path, but a holder gap)
  const rr = stepFlags(r, obsOf(entry(140, 0, province({ resolvedNext: 250, keep: keepAt(1, 170, 3, 4) }))));
  assert.deepEqual(rr.events, [], 'held since 170: long only at 314');
});

test('a hold the judge did not see end: the next capture names the old holder, so the chain still tells', () => {
  const seen = stepFlags(initialState(), obsOf(entry(140, 0, province({ resolvedNext: 120, keep: keepAt(1, 101, 1) })))).state;
  // nation 4 took it at bell 299 (since 300) from nation 1, one gen later: nation 1 held 101 → 299 ≥ 245
  const long = stepFlags(seen, obsOf(entry(140, 0, province({ resolvedNext: 310, keep: keepAt(4, 300, 2, 1) }))));
  assert.deepEqual(long.events.map(e => [e.nation, e.bell]), [[1, 245]]);
  // taken at bell 199: nation 1 held 98 turns — nothing
  const short = stepFlags(seen, obsOf(entry(140, 0, province({ resolvedNext: 210, keep: keepAt(4, 200, 2, 1) }))));
  assert.deepEqual(short.events, []);
  // two captures in between (gen + 2): the judge does not guess
  const twice = stepFlags(seen, obsOf(entry(140, 0, province({ resolvedNext: 310, keep: keepAt(4, 300, 3, 5) }))));
  assert.deepEqual(twice.events, []);
});

test('two nations on two keeps: both achieve, in (bell, flag) order; standings count them', () => {
  const s = stepFlags(initialState(), obsOf(
    entry(141, 0, province({ resolvedNext: 400, keep: keepAt(5, 101, 1) })),
    entry(140, 0, province({ resolvedNext: 400, keep: keepAt(0, 101, 1) })),
    entry(139, 2, province({ resolvedNext: 400, keep: keepAt(0, 50, 1) })),
    entry(138, 2, province({ resolvedNext: 400, keep: keepAt(3, 300, 1) })),
  ));
  assert.deepEqual(s.events.map(e => [e.p, e.nation, e.bell]), [['139', 0, 194], ['140', 0, 245], ['141', 5, 245]]);
  const st = standingsOf(s.state);
  assert.equal(st[0].achieved, 2); assert.equal(st[5].achieved, 1); assert.equal(st[3].holding, 1); assert.equal(st[3].achieved, 0);
});

test('first to hold long takes the flag: a later holder of an achieved flag adds nothing', () => {
  let st = stepFlags(initialState(), obsOf(entry(140, 0, province({ resolvedNext: 300, keep: keepAt(2, 101, 1) })))).state;
  assert.equal(st.achievements.length, 1);
  const s = stepFlags(st, obsOf(entry(140, 0, province({ resolvedNext: 700, keep: keepAt(4, 400, 2, 2) }))));
  assert.deepEqual(s.events, []);
  assert.equal(s.state.achievements.length, 1);
  assert.equal(standingsOf(s.state)[4].holding, 0, 'an achieved flag is no one\'s "holding" any more');
});

test('a Free City: known as state 5, captured (a holding of a nation) and held 144 turns from the first capture that shows it', () => {
  const fc = (resolvedNext, site) => entry(150, 1, province({ resolvedNext, keep: null, sites: [{ state: 0 }, site] }));
  let s = stepFlags(initialState(), obsOf(fc(100, { state: 5 })));
  assert.deepEqual(Object.keys(s.state.flags), ['c:150,1:1']);
  s = stepFlags(s.state, obsOf(fc(200, { state: 1, faction: 2, gen: 1 })));
  s = stepFlags(s.state, obsOf(fc(343, { state: 1, faction: 2, gen: 1 })));
  assert.deepEqual(s.events, []);
  // lost (taken by nation 3: gen 2) before the hold: restarts for nation 3 at 350
  s = stepFlags(s.state, obsOf(fc(350, { state: 1, faction: 3, gen: 2 })));
  assert.deepEqual(s.events, []);
  s = stepFlags(s.state, obsOf(fc(494, { state: 1, faction: 3, gen: 2 })));
  assert.deepEqual(s.events.map(e => [e.kind, e.site, e.nation, e.bell]), [['freeCity', 1, 3, 494]]);
  // a holding never seen as a Free City is not a flag
  const h = stepFlags(initialState(), obsOf(entry(151, 1, province({ resolvedNext: 900, keep: null, sites: [{ state: 1, faction: 1, gen: 1 }] }))));
  assert.deepEqual(Object.keys(h.state.flags), []);
});

test('an older capture than one already read is ignored', () => {
  let st = stepFlags(initialState(), obsOf(entry(140, 0, province({ resolvedNext: 200, keep: keepAt(2, 150, 1) })))).state;
  st = stepFlags(st, obsOf(entry(140, 0, province({ resolvedNext: 120, keep: keepAt(NEUTRAL, 0, 0) })))).state;
  assert.equal(st.flags['k:140,0'].holder, 2);
});

// (verify-pr260) edge cases beyond the author's: the real neutral side, recapture, and the provisional-rule switches
test('verify-pr260: the live world\'s neutral side is faction 6 (not 0xFF): a neutral keep has no holder, a capture from it counts', () => {
  // the world-3 replica's bytes: every unowned wide keep reads holder 6, troops 50, since 7, gen 0, last_taken_from 0xFF
  let s = stepFlags(initialState(), obsOf(entry(140, 0, province({ resolvedNext: 400, keep: keepAt(6, 7, 0) }))));
  assert.deepEqual(s.events, []);
  assert.equal(s.state.flags['k:140,0'].holder, null);
  assert.equal(standingsOf(s.state).reduce((n, x) => n + x.holding, 0), 0);
  s = stepFlags(s.state, obsOf(entry(140, 0, province({ resolvedNext: 410, keep: keepAt(2, 405, 1, 6) }))));
  assert.deepEqual(s.events, [], 'not a missed hold of the neutral side');
  s = stepFlags(s.state, obsOf(entry(140, 0, province({ resolvedNext: 549, keep: keepAt(2, 405, 1, 6) }))));
  assert.deepEqual(s.events.map(e => [e.nation, e.bell]), [[2, 549]]);
});

test('verify-pr260: captured, lost before 24 h, recaptured by the first nation: it counts from the recapture only', () => {
  const at = (rn, k) => obsOf(entry(140, 0, province({ resolvedNext: rn, keep: k })));
  let st = stepFlags(initialState(), at(110, keepAt(1, 101, 1))).state;
  st = stepFlags(st, at(160, keepAt(3, 150, 2, 1))).state; // nation 3 takes it after 49 turns
  let s = stepFlags(st, at(200, keepAt(1, 190, 3, 3))); // nation 1 retakes it at bell 189
  assert.deepEqual(s.events, []);
  s = stepFlags(s.state, at(333, keepAt(1, 190, 3, 3)));
  assert.deepEqual(s.events, [], '101 + 144 = 245 is not the bell: the first hold ended at 149');
  s = stepFlags(s.state, at(334, keepAt(1, 190, 3, 3)));
  assert.deepEqual(s.events.map(e => [e.nation, e.bell]), [[1, 334]]);
  // the same hold read again does not count again
  s = stepFlags(s.state, at(400, keepAt(1, 190, 3, 3)));
  assert.deepEqual(s.events, []);
  assert.equal(s.state.achievements.length, 1);
});

test('verify-pr260: firstOnly false (Q-PTWG-2 (b)) counts each long hold exactly once, however often it is read', () => {
  const rules = { holdBells: 144, firstOnly: false, freeCities: true };
  const at = (rn, k) => obsOf(entry(140, 0, province({ resolvedNext: rn, keep: k })));
  const reads = [at(20, keepAt(2, 15, 1)), at(170, keepAt(2, 15, 1)), at(171, keepAt(2, 15, 1)), at(180, keepAt(3, 175, 2, 2)),
    at(330, keepAt(3, 175, 2, 2)), at(331, keepAt(3, 175, 2, 2)), at(332, keepAt(3, 175, 2, 2))];
  const st = replay(reads, rules);
  assert.deepEqual(st.achievements.map(a => [a.nation, a.bell]), [[2, 159], [3, 319]]);
  assert.deepEqual(st.flags['k:140,0'].achieved, { nation: 2, bell: 159 }, 'the first taker stays named');
  // a missed hold then a seen one, in one read: both, in bell order, once
  const s2 = replay([at(20, keepAt(2, 15, 1)), at(500, keepAt(4, 300, 2, 2)), at(501, keepAt(4, 300, 2, 2))], rules);
  assert.deepEqual(s2.achievements.map(a => [a.nation, a.bell]), [[2, 159], [4, 444]]);
});

test('verify-pr260: freeCities false (Q-PTWG-5 (c)) makes keeps the only flags', () => {
  const o = obsOf(entry(150, 1, province({ resolvedNext: 100, keep: keepAt(6, 7, 0), sites: [{ state: 5, faction: 6 }] })));
  assert.deepEqual(Object.keys(replay([o]).flags).sort(), ['c:150,1:0', 'k:150,1']);
  assert.deepEqual(Object.keys(replay([o], { holdBells: 144, firstOnly: true, freeCities: false }).flags), ['k:150,1']);
});

test('verify-pr260: the herald\'s entry order does not change the answer (same inputs hash, same achievements)', () => {
  const a = entry(141, 0, province({ resolvedNext: 400, keep: keepAt(5, 101, 1) }));
  const b = entry(-140, 3, province({ resolvedNext: 400, keep: keepAt(0, 101, 1), sites: [{ state: 5 }] }));
  const c = entry(139, -2, province({ resolvedNext: 380, keep: keepAt(0, 50, 1) }));
  const x = answerOf(replay([obsOf(a, b, c)]), { seasonId: SEASON });
  const y = answerOf(replay([obsOf(c, a, b)]), { seasonId: SEASON });
  assert.deepEqual(x, y);
  assert.equal(x.achievements.length, 3);
});

/** A fake herald over a list of reads (each a list of entries), paged by 2. */
function fakeHerald(reads, { staleOnce = false } = {}) {
  let i = 0, stale = staleOnce;
  const current = () => reads[Math.min(i, reads.length - 1)];
  const res = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
  const fetchImpl = async url => {
    const u = new URL(url);
    if (u.pathname === '/h/season') return res(200, { season: SEASON, programId: 'Prog111', seasonAddress: 'Seas111' });
    if (u.pathname === '/h/world/wide') return res(200, { season: SEASON, program: 'Prog111', world: WORLD });
    if (u.pathname === '/h/world/wide/page') {
      const after = Number(u.searchParams.get('after') ?? 0);
      if (stale && after > 0) { stale = false; return res(409, { error: 'StaleSnapshot' }); }
      const list = current();
      return res(200, { world: WORLD, entries: list.slice(after, after + 2), next: after + 2 < list.length ? String(after + 2) : null });
    }
    return res(404, { error: 'NotFound' });
  };
  return { fetchImpl, next: () => { i += 1; } };
}

test('the judge: reads the herald only, archives each read, and the archive alone replays to the same answer', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wg-'));
  try {
    const reads = [
      [entry(140, 0, province({ resolvedNext: 90 })), entry(141, 0, province({ resolvedNext: 90 })), entry(150, 1, province({ resolvedNext: 90, keep: null, sites: [{ state: 5 }] }))],
      [entry(140, 0, province({ resolvedNext: 150, keep: keepAt(2, 101, 1) })), entry(141, 0, province({ resolvedNext: 150, keep: keepAt(1, 120, 1) })), entry(150, 1, province({ resolvedNext: 150, keep: null, sites: [{ state: 5 }] }))],
      [entry(140, 0, province({ resolvedNext: 250, keep: keepAt(2, 101, 1) })), entry(141, 0, province({ resolvedNext: 250, keep: keepAt(4, 230, 2, 1) })), entry(150, 1, province({ resolvedNext: 250, keep: null, sites: [{ state: 1, faction: 0, gen: 1 }] }))],
      [entry(140, 0, province({ resolvedNext: 400, keep: keepAt(2, 101, 1) })), entry(141, 0, province({ resolvedNext: 400, keep: keepAt(4, 230, 2, 1) })), entry(150, 1, province({ resolvedNext: 400, keep: null, sites: [{ state: 1, faction: 0, gen: 1 }] }))],
    ];
    const h = fakeHerald(reads, { staleOnce: true });
    const urls = [];
    const judge = await openJudge({ herald: 'http://127.0.0.1:41640', dir, fetchImpl: async u => { urls.push(new URL(u).pathname); return h.fetchImpl(u); }, now: () => 'T' });
    const events = [];
    for (let k = 0; k < reads.length; k++) { events.push(...(await judge.tick()).events); h.next(); }
    assert.ok(urls.every(u => u.startsWith('/h/')), 'only herald routes');
    assert.deepEqual(events.map(e => [e.kind, e.p, e.nation, e.bell]), [['keep', '140', 2, 245], ['keep', '141', 4, 374], ['freeCity', '150', 0, 394]]);
    const answer = JSON.parse(await readFile(path.join(dir, ANSWER_FILE), 'utf8'));
    const r = await replayArchive(path.join(dir, ARCHIVE_FILE));
    const replayed = answerOf(r.state, { seasonId: r.season.seasonId, programId: r.season.programId, seasonAddress: r.season.seasonAddress });
    assert.deepEqual(replayed, answer, 'the archive alone gives the served answer');
    assert.equal(replayed.judge.observations, 4);
    assert.deepEqual(replay(r.lines.map(l => l.obs)), judge.state);
    // a restarted judge rebuilds from the archive and goes on
    const again = await openJudge({ herald: 'http://127.0.0.1:41640', dir, fetchImpl: h.fetchImpl });
    assert.deepEqual(again.state, judge.state);
    // a tampered archive line changes the inputs hash
    const lines = (await readFile(path.join(dir, ARCHIVE_FILE), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    lines[1].obs.provinces[0].keep.since = 50;
    await writeFile(path.join(dir, 'bad.jsonl'), `${lines.map(l => JSON.stringify(l)).join('\n')}\n`);
    const bad = await replayArchive(path.join(dir, 'bad.jsonl'));
    assert.notEqual(bad.state.inputsHash, r.state.inputsHash);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the judge refuses a herald of another world against its archive, and a non-loopback herald', async () => {
  assert.throws(() => parseArgs(['--herald', 'https://example.org', '--dir', 'x']), /loopback/);
  assert.throws(() => parseArgs(['--herald', 'http://127.0.0.1:41640']), /--dir/);
  assert.equal(parseArgs(['--herald', 'http://127.0.0.1:41640/', '--dir', 'x', '--once']).herald, 'http://127.0.0.1:41640');
  const h = fakeHerald([[entry(140, 0, province())]]);
  const r = await readHerald('http://127.0.0.1:41640', { fetchImpl: h.fetchImpl });
  assert.equal(r.entries.length, 1);
  const bad = async u => (new URL(u).pathname === '/h/world/wide' ? { ok: true, status: 200, text: async () => JSON.stringify({ season: '2', program: 'Prog111', world: WORLD }) } : h.fetchImpl(u));
  await assert.rejects(readHerald('http://127.0.0.1:41640', { fetchImpl: bad }), /another season/);
});

test('the relay route: 404 without the file, 409 before a good answer, the answer of this season only', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wgr-'));
  try {
    const route = worldGoalsRoutes[WORLD_GOALS_ROUTE];
    await assert.rejects(route({ cfg: { seasonId: SEASON, worldGoalsFile: null } }), e => e.status === 404 && e.code === 'NotFound');
    const file = path.join(dir, 'answer.json');
    await assert.rejects(route({ cfg: { seasonId: SEASON, worldGoalsFile: file } }), e => e.status === 409 && e.code === 'WorldGoalsNotYet');
    const good = answerOf(initialState(), { seasonId: SEASON });
    await writeFile(file, JSON.stringify(good));
    assert.deepEqual((await route({ cfg: { seasonId: SEASON, worldGoalsFile: file } })).body, good);
    await assert.rejects(route({ cfg: { seasonId: '4', worldGoalsFile: file } }), e => e.status === 409);
    assert.equal(servableGoals({ ...good, effects: { money: 'test-usdc', chain: 'none' } }, SEASON), false);
    // the reader re-reads only a changed file
    let reads = 0;
    const rd = goalsFileReader(file, { readImpl: async (...a) => { reads++; return readFile(...a); } });
    await rd(); await rd();
    assert.equal(reads, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

