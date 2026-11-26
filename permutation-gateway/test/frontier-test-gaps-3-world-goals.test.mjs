// test-gaps-3 (#260 world goals judge, off chain): random capture histories, judged from the herald's bytes alone.
//
// verify-pr260 checked the judge on hand-made cases and one real archive. Here a seeded random TRUE history per flag
// (captures at random bells by random nations; the chain's own keep write: since = b + 1, gen + 1, last_taken_from =
// the previous holder; a Free City's site mirror state 5 → 1 with the taker's faction and gen + 1) is read by the
// herald at random bells (resolvedNext moves on; only captures before it are in the bytes), encoded as real 4,864-byte
// wide Province captures and fed through observationOf → stepFlags. Properties, for every rule switch (firstOnly,
// freeCities):
//   S  soundness: every achievement is a TRUE hold of that nation of at least holdBells, achieved at since + holdBells
//      (a capture lost again in < 24 h never gives a flag; Free Cities: the judge's start is never before the truth's)
//   C  completeness when every capture is seen (at most one capture of a flag between two reads): every first long
//      hold (firstOnly) — every long hold (firstOnly false) — that ended or reached 24 h before the last read is
//      achieved, exactly once
//   R  replay: the incremental answer = replay(archive) = replayArchive(the archive file) byte for byte; a read seen
//      twice adds nothing; the herald's entry order within a read changes nothing (inputs hash included)
// No clock is read by the judge; no network, no key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { answerOf, initialState, observationOf, replay, stepFlags, WIDE_FLAGS_DEFAULTS, WP } from '../src/frontier/wide-flags.mjs';
import { replayArchive } from '../src/frontier/devnet-world-goals.mjs';

const SEASON = '3';
const WORLD = 'cd'.repeat(32);
const NEUTRAL_SIDE = 6; // world 3's unowned wide keep (verify-pr260 D-1)
const H = WIDE_FLAGS_DEFAULTS.holdBells;

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pick = (r, n) => Math.floor(r() * n);

/** A ready captured wide Province (frontier-abi world_index/land.rs WideProvince) with this keep and these sites. */
function province({ resolvedNext, keep, sites }) {
  const b = new Uint8Array(WP.SIZE), v = new DataView(b.buffer);
  b.set(Buffer.from(WP.MAGIC, 'latin1'), 0);
  v.setBigUint64(WP.SEASON_ID, BigInt(SEASON), true);
  v.setUint16(WP.LAYOUT_VERSION, 3, true);
  v.setUint32(WP.RESOLVED_NEXT, resolvedNext, true);
  v.setUint16(WP.TRAILER + WP.T_FAMILY, 1, true);
  b[WP.TRAILER + WP.T_STATUS] = 1;
  b[WP.TRAILER + WP.T_READY] = 15;
  b.set(Buffer.from(WORLD, 'hex'), WP.TRAILER + WP.T_WORLD);
  const k = WP.KEEP;
  b[k + WP.K_TILE] = keep.tile; b[k + WP.K_HOLDER] = keep.holder; v.setUint32(k + WP.K_TROOPS, 50, true);
  v.setUint32(k + WP.K_SINCE, keep.since, true); v.setUint32(k + WP.K_GEN, keep.gen, true); b[k + WP.K_LAST_FROM] = keep.lastFrom;
  b[WP.SITE_COUNT] = sites.length;
  sites.forEach((s, i) => { b[WP.SITES + i] = 40 + i; const o = WP.SITE_MIRROR + i * WP.SITE_SIZE; b[o] = s.state; b[o + 1] = s.faction; b[o + 4] = s.gen; });
  return b;
}

/**
 * A random world: `provinces` wide provinces, each a keep and 0–2 Free Cities with their TRUE capture lists, and the
 * herald's reads. `dense`: every flag has at most one capture between two reads (the judge sees each one).
 */
function randomWorld(seed, { dense }) {
  const r = rng(seed);
  const provinces = [];
  const nProv = 1 + pick(r, 3);
  const end = 600 + pick(r, 900);
  for (let i = 0; i < nProv; i++) {
    const p = String(129 + pick(r, 40) * (r() < 0.5 ? 1 : -1)), q = String(pick(r, 300) - 150);
    if (provinces.some(x => x.p === p && x.q === q)) continue;
    const caps = () => {
      const out = [];
      let b = 7 + pick(r, 60);
      while (b < end) {
        // short holds (< 24 h) and long ones (> 24 h), around the edge too
        const gap = r() < 0.35 ? 1 + pick(r, H - 1) : r() < 0.2 ? H - 2 + pick(r, 5) : H + pick(r, 260);
        out.push({ bell: b, nation: pick(r, 6) });
        b += gap;
      }
      return out;
    };
    provinces.push({ p, q, keep: caps(), cities: Array.from({ length: pick(r, 3) }, caps) });
  }
  // the reads: resolvedNext values, increasing
  const reads = [];
  let at = 8 + pick(r, 30);
  while (at < end + 300) { reads.push(at); at += dense ? 1 + pick(r, 6) : 1 + pick(r, 220); }
  // (dense: no flag may have two captures inside one read gap — move to the next seed's reads if so)
  return { provinces, reads };
}

/** The bytes the herald holds at resolvedNext R for province x: captures at bells < R are in. */
function bytesAt(x, R) {
  const kc = x.keep.filter(c => c.bell < R);
  let keep = { tile: 30, holder: NEUTRAL_SIDE, since: 7, gen: 0, lastFrom: 0xff };
  for (const c of kc) keep = { tile: 30, holder: c.nation, since: c.bell + 1, gen: keep.gen + 1, lastFrom: keep.holder };
  const sites = x.cities.map(list => {
    const cc = list.filter(c => c.bell < R);
    return cc.length ? { state: 1, faction: cc.at(-1).nation, gen: cc.length } : { state: 5, faction: NEUTRAL_SIDE, gen: 0 };
  });
  return province({ resolvedNext: R, keep, sites });
}
const entryOf = (x, R) => ({ p: x.p, q: x.q, ring: '140', state: 'open', wide: { capture: { slot: String(R * 3), bytes_b64: Buffer.from(bytesAt(x, R)).toString('base64') } } });
const readOf = (w, R, order = null) => { const es = w.provinces.map(x => entryOf(x, R)); return order ? order(es) : es; };

/** Whether every flag has at most one capture between two consecutive reads (and none before the first read is a second). */
function everyCaptureSeen(w) {
  for (const x of w.provinces) for (const list of [x.keep, ...x.cities]) {
    let prev = -1;
    for (const R of w.reads) { const n = list.filter(c => c.bell >= prev && c.bell < R).length; if (n > 1) return false; prev = R; }
  }
  return true;
}

/**
 * The TRUE long holds of one capture list for the judge's rules: a hold i (by n_i from since s_i = b_i + 1) is long when
 * the next capture comes at b ≥ s_i + H before the last read, or none comes and the last read's resolvedNext ≥ s_i + H.
 * Keeps: the chain's since. Free Cities: the bell from which the truth holds (b_i + 1, the earliest the judge can see).
 */
function longHolds(list, lastR) {
  const out = [];
  list.forEach((c, i) => {
    const s = c.bell + 1, nxt = list[i + 1];
    const endsBy = nxt && nxt.bell < lastR ? nxt.bell : null;
    if (endsBy !== null ? endsBy >= s + H : lastR >= s + H) out.push({ nation: c.nation, since: s, endsBy, i });
  });
  return out;
}

const RULES = [
  { holdBells: H, firstOnly: true, freeCities: true },
  { holdBells: H, firstOnly: false, freeCities: true },
  { holdBells: H, firstOnly: true, freeCities: false },
];

test('S: every achievement is a true hold of ≥ 24 h by that nation (random histories, sparse and dense reads)', () => {
  let achieved = 0, shortHolds = 0, worlds = 0;
  for (let seed = 1; seed <= 240; seed++) {
    for (const dense of [false, true]) {
      const w = randomWorld(seed * 7 + (dense ? 1 : 0), { dense });
      const rules = RULES[seed % RULES.length];
      const obs = w.reads.map(R => observationOf(readOf(w, R), { seasonId: SEASON, world: WORLD }));
      const st = replay(obs, rules);
      worlds++;
      const lastR = w.reads.at(-1);
      for (const a of st.achievements) {
        const x = w.provinces.find(y => y.p === a.p && y.q === a.q);
        assert.ok(x, `achievement in a province of the world ${a.p},${a.q}`);
        if (a.kind === 'keep') {
          const holds = longHolds(x.keep, lastR).filter(h => h.nation === a.nation && h.since + H === a.bell);
          assert.equal(holds.length, 1, `seed ${seed} dense ${dense}: keep ${a.p},${a.q} achieved by ${a.nation} at ${a.bell} is a true hold of ≥ ${H} bells`);
        } else {
          assert.equal(rules.freeCities, true, 'Free Cities only when they are flags');
          const list = x.cities[a.site];
          // the judge's start is a read's resolvedNext: the truth held from some since ≤ that start and kept it until ≥ the achievement
          const i = list.findLastIndex(c => c.bell + 1 <= a.bell - H);
          assert.ok(i >= 0 && list[i].nation === a.nation, `seed ${seed}: city ${a.p},${a.q}:${a.site} held by ${a.nation} before ${a.bell - H}`);
          const nxt = list[i + 1];
          assert.ok(!nxt || nxt.bell >= a.bell, `seed ${seed}: city ${a.p},${a.q}:${a.site} still held at ${a.bell} (next capture ${nxt?.bell})`);
        }
        achieved++;
      }
      for (const x of w.provinces) shortHolds += x.keep.filter((c, i) => x.keep[i + 1] && x.keep[i + 1].bell - (c.bell + 1) < H).length;
    }
  }
  assert.ok(worlds >= 480 && achieved > 500 && shortHolds > 500, `exercised: ${worlds} worlds, ${achieved} achievements, ${shortHolds} short holds`);
});

test('C: when every capture is seen, every first (or every) long hold is achieved once, at since + 24 h', () => {
  let checked = 0, worlds = 0;
  for (let seed = 1; seed <= 400 && worlds < 160; seed++) {
    const w = randomWorld(seed * 13, { dense: true });
    if (!everyCaptureSeen(w)) continue;
    worlds++;
    const lastR = w.reads.at(-1);
    for (const rules of RULES) {
      const st = replay(w.reads.map(R => observationOf(readOf(w, R), { seasonId: SEASON, world: WORLD })), rules);
      for (const x of w.provinces) {
        const want = longHolds(x.keep, lastR).map(h => ({ nation: h.nation, bell: h.since + H }));
        const got = st.achievements.filter(a => a.kind === 'keep' && a.p === x.p && a.q === x.q).map(a => ({ nation: a.nation, bell: a.bell }));
        assert.deepEqual(got, rules.firstOnly ? want.slice(0, 1) : want, `seed ${seed} ${JSON.stringify(rules)} keep ${x.p},${x.q}`);
        checked += want.length;
        x.cities.forEach((list, site) => {
          const got = st.achievements.filter(a => a.kind === 'freeCity' && a.p === x.p && a.q === x.q && a.site === site);
          if (!rules.freeCities) { assert.equal(got.length, 0); return; }
          // a city's start is the first read that shows it held: each true hold reaching 24 h from that read counts.
          // (a site the judge first sees already taken is no flag: "a holding the judge never saw as a Free City")
          const want = [];
          if (list.length && list[0].bell < w.reads[0]) { assert.equal(got.length, 0, `seed ${seed}: city first seen taken is no flag`); return; }
          list.forEach((c, i) => {
            const firstRead = w.reads.find(R => R > c.bell), nxt = list[i + 1];
            if (firstRead === undefined) return;
            const lastHeldRead = w.reads.filter(R => R > c.bell && (!nxt || R <= nxt.bell)).at(-1);
            if (lastHeldRead !== undefined && lastHeldRead >= firstRead + H) want.push({ nation: c.nation, bell: firstRead + H });
          });
          assert.deepEqual(got.map(a => ({ nation: a.nation, bell: a.bell })), rules.firstOnly ? want.slice(0, 1) : want, `seed ${seed} ${JSON.stringify(rules)} city ${x.p},${x.q}:${site}`);
          checked += want.length;
        });
      }
    }
  }
  assert.ok(worlds >= 60 && checked > 300, `exercised: ${worlds} fully-seen worlds, ${checked} long holds`);
});

test('R: incremental = replay = replayArchive byte for byte; a read seen twice adds nothing; entry order changes nothing', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tg3-goals-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (let seed = 1; seed <= 40; seed++) {
    const w = randomWorld(seed * 31, { dense: seed % 2 === 0 });
    const rules = RULES[seed % RULES.length];
    const r = rng(seed);
    const shuffle = es => { const a = [...es]; for (let i = a.length - 1; i > 0; i--) { const j = pick(r, i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
    const obs = w.reads.map(R => observationOf(readOf(w, R), { seasonId: SEASON, world: WORLD }));
    let st = initialState(rules);
    for (const o of obs) st = stepFlags(st, o).state;
    const meta = { seasonId: SEASON, programId: 'P', seasonAddress: 'S' };
    const a1 = JSON.stringify(answerOf(st, meta));
    assert.equal(JSON.stringify(answerOf(replay(obs, rules), meta)), a1, `seed ${seed}: replay = incremental`);
    // the archive file the judge writes (one line per read), replayed from disk
    const file = path.join(dir, `archive-${seed}.jsonl`);
    await writeFile(file, obs.map((o, i) => `${JSON.stringify({ n: i + 1, season: { seasonId: SEASON, programId: 'P', world: WORLD }, rules, readAt: `t${i}`, obs: o })}\n`).join(''));
    const fromDisk = await replayArchive(file);
    assert.equal(JSON.stringify(answerOf(fromDisk.state, meta)), a1, `seed ${seed}: replayArchive = the served answer`);
    // the herald's entries in another order: the same observation, the same inputs hash
    const shuffled = w.reads.map(R => observationOf(readOf(w, R, shuffle), { seasonId: SEASON, world: WORLD }));
    assert.equal(JSON.stringify(answerOf(replay(shuffled, rules), meta)), a1, `seed ${seed}: entry order`);
    // every read seen twice (a judge that read the herald twice between two turns): no achievement added or moved
    const twice = replay(obs.flatMap(o => [o, o]), rules);
    assert.deepEqual(twice.achievements, st.achievements, `seed ${seed}: a read seen twice`);
    assert.deepEqual(twice.flags, st.flags, `seed ${seed}: the flags too`);
  }
});
