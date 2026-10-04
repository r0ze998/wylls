// Seat eligibility fix (smoke-r3 finding, owner decision 2026-10-04/05; integ-B-NOTES.md section 12): the scripted seat's ballot was refused
// 400 NotEligible because the council's eligible list for nation 0 held only the AI: the seat's village was still PROVISIONAL (Holding
// STATE 1) and nothing ever touched it, while the program flips provisional to final lazily (I-29, I-47). Also: WHY a nation got no council in
// a period was only in the watcher's memory.
//
// What is real here: the social service (`createSocial`, council store, book, routes), the census (`createCensus`), the owners index
// (`createOwners`, fed with JOIN / SETTLE / HOLDING_FINAL rows exactly as the herald log gives them), the council job (`createCouncilGen.tryOpen`,
// which hands the census's voters to the council store as the explicit eligible list: the live path), the seat script (`runSeatScript`) and the
// seat finaliser. What is a double: the chain. `sendWalls` plays the program: the flip (a HOLDING_FINAL row) is written only when the
// program's own condition holds (state 1, now >= final_ts, cohort closed; `due` here), nothing else flips it. Province files are synthetic
// (test/fixtures/ai-watcher-kit.mjs). No stack, no model, no network.
//
// Why each test fails on the code before this fix: the old seat.mjs has no `createSeatFinaliser` and its loops ignore a `finaliser`; the old
// council job and watcher persist nothing (`councilOutcomesSection`, `outcomes.mjs` do not exist).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';
import * as b58 from '../../permutation-server/web/sdk/base58.mjs';
import { toBase58 } from '../../permutation-server/web/frontier/council/aisocial.mjs';
import { createSocial } from '../citizens/social/routes.mjs';
import { createCensus } from '../citizens/watcher/census.mjs';
import { createCouncilGen } from '../citizens/watcher/council_gen.mjs';
import { createWatcher } from '../citizens/watcher/index.mjs';
import { createOutcomes } from '../citizens/watcher/outcomes.mjs';
import { createOwners, citizenTagOfTag15 } from '../citizens/watcher/owners.mjs';
import { buildReport, councilOutcomesSection, loadRun, renderMarkdown } from '../citizens/report.mjs';
import { createRecords } from '../citizens/mind/records.mjs';
import { createMemoryStore } from '../citizens/memory/store.mjs';
import { builders, fakeHerald, makeCitizen, makeClock, tmpAiDir, SEASON } from './fixtures/ai-social-kit.mjs';
import { fakeFeed, fakeOwners, fakeRoster, host, province, nameOfDouble, nationNameDouble, tmpDir } from './fixtures/ai-watcher-kit.mjs';
import { ball } from '../citizens/watcher/council_gen.mjs';
import * as seat from '../citizens/ab/seat.mjs';

const CFG = { period: 24, offset: 0, strike_lead: 6, human_present: true };
const C0 = 48;
const DUE_BELL = 30; // the chain double's flip condition holds from this bell on (final_ts passed, cohort closed)

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const PROGRAM = b58.encode(Uint8Array.from({ length: 32 }, (_, i) => 100 + i));
const SEASON_ADDR = b58.encode(Uint8Array.from({ length: 32 }, (_, i) => 50 + i));

function seatKeyFile(dir, citizen) {
  const file = join(dir, 'seat.txt');
  const kp = new Uint8Array(64);
  kp.set(citizen.key.seed, 0);
  kp.set(citizen.key.pub, 32);
  writeFileSync(file, JSON.stringify({ index: 1012, wallet: citizen.b58, wallet_keypair_b58: 'unused', session: toBase58(citizen.key.pub), session_keypair_b58: toBase58(kp) }));
  return file;
}

/**
 * Nation 0: one AI (ai0, two villages, final) and the seat (one village, PROVISIONAL until `chain.flip()`); nation 3: a foe. The owners index is
 * the real one, fed by rows; the census, the council job and the social service run on it. `clock` is the game bell.
 */
function world({ startBell = 20, seatFinalFromStart = false } = {}) {
  const clock = makeClock({ bell: startBell });
  const dir = tmpAiDir('seatfix2-');
  const cits = { ai0: makeCitizen('ai0', { faction: 0 }), seat: makeCitizen('seat', { faction: 0 }), foe: makeCitizen('foe', { faction: 3 }) };
  const owners = createOwners({ seasonAddress: SEASON_ADDR, programId: PROGRAM });
  const tags = {};
  let n = 0;
  const enrol = (name, faction, sites, final) => {
    const tag15 = sha(`tag15/${name}`).slice(0, 30);
    const tag = citizenTagOfTag15(tag15, { seasonAddress: SEASON_ADDR, programId: PROGRAM });
    tags[name] = tag;
    owners.ingest({ kind: 'JOIN', citizen15: tag15, wallet: Buffer.from(b58.decode(cits[name].b58)).toString('hex'), faction, bell: 3 });
    for (const [p, q, site] of sites) {
      owners.ingest({ kind: 'SETTLE', outcome: 0, p, q, site, citizen: tag, gen: 0, bell: 4 + n++, ticket_bell: 3 });
      if (final) owners.ingest({ kind: 'HOLDING_FINAL', p, q, site });
    }
  };
  enrol('ai0', 0, [[0, 0, 0], [1, 0, 1]], true);
  enrol('seat', 0, [[1, 1, 1]], seatFinalFromStart);
  enrol('foe', 3, [[3, 0, 0]], true);
  const roster = fakeRoster({
    ai: [{ index: 1000, tag: tags.ai0, wallet: cits.ai0.b58, faction: 0, name: { en: 'AI0', ja: 'AI0' } }],
    seat: { index: 1012, wallet: cits.seat.b58, tag: tags.seat, faction: 0, kind: 'seat', scripted: true },
  });
  const rosterJson = { v: 1, season: SEASON, ai: roster.ai.map((a) => ({ ...a, persona: 'avenger' })), script: { wallets: [] }, seat: roster.seat };
  mkdirSync(join(dir.dir, 'pub'), { recursive: true });
  writeFileSync(join(dir.dir, 'pub/roster.json'), JSON.stringify(rosterJson));
  const feed = fakeFeed({ owners, through: 100, head: 100 });
  // a world with options for nation 0 around its three villages: a camp at (2,0), a stack of nation 3 at (1,1)
  const f2 = C0 - 2;
  feed.files.set(`2,0,${f2}`, province({ p: 2, q: 0, bell: f2, camp: { tile: 44, troops: 200 } }));
  feed.files.set(`1,1,${f2}`, province({ p: 1, q: 1, bell: f2, hosts: [host({ owner: 'x', faction: 0, tile: 30, troops: 500 }), host({ owner: 'x', faction: 0, tile: 31, troops: 400 }), host({ faction: 3, tile: 20, troops: 300 })] }));
  for (const c of ball(0, 0, 5)) if (!feed.files.has(`${c.p},${c.q},${f2}`)) feed.files.set(`${c.p},${c.q},${f2}`, province({ p: c.p, q: c.q, bell: f2 }));
  const herald = fakeHerald(Object.values(cits));
  const social = createSocial({ herald, aiDir: dir.dir, roster: rosterJson, clock, provenance: (id, item, type) => outputs.get(`${id}|${item}|${type}`) ?? null, config: { council: CFG }, season: SEASON, random: (m) => new Uint8Array(m).fill(0x11) });
  const outputs = new Map();
  const census = createCensus({ feed, roster });
  census.start();
  const outcomes = createOutcomes({ file: join(dir.dir, 'state/watcher/council-outcomes.json') });
  const gen = createCouncilGen({ feed, social, roster, census, clock: null, mind: () => null, store: { calls: new Set(), dirty: false }, config: { council: CFG }, stats: {}, nowMs: () => 1e12, retryMs: 0, outcomes });
  const b = builders(clock);
  let seq = 0;
  const w = { clock, dir, cits, tags, owners, census, gen, social, outcomes, feed, polls: 0, posts: [], chain: null };
  // the chain double: the program flips a provisional village only inside an instruction that carries its Province, once it is due
  const chain = {
    sent: [],
    due: () => clock.bell() >= DUE_BELL,
    holding: () => owners.holdingsOf(tags.seat)[0] ?? null,
    flip() { const h = chain.holding(); owners.ingest({ kind: 'HOLDING_FINAL', p: h.p, q: h.q, site: h.site }); },
    io: {
      readSeat: async () => { const h = chain.holding(); return h ? { holding: { state: h.final ? 2 : 1 }, due: chain.due(), stone: 320 } : { holding: null, due: false, stone: null }; },
      sendWalls: async () => { chain.sent.push(clock.bell()); if (chain.due()) chain.flip(); return { ok: true, state: 'landed', signature: `sig${chain.sent.length}-aaaaaaaa` }; },
      quotaLeft: async () => 40,
    },
  };
  w.chain = chain;
  const aiBallot = async ({ option, period }) => {
    const c = cits.ai0;
    const id = `bd${seq++}`;
    const ch = w.lastCandidatesHash;
    outputs.set(`${id}|0|ballot`, { type: 'ballot', bell: clock.bell(), option, period, faction: 0, candidates_hash: ch });
    return social.book.submit('ballot', b.ballot(c, { period, option, candidates_hash: ch, origin: 1 }, { decision_id: id, item: 0 }).body);
  };
  // one bell of the world: the council job opens period 2 in the first bells, the AI casts its ballot at C0 + 3, the social store ticks
  const atBell = async () => {
    const bell = clock.bell();
    if (bell >= C0 && bell <= C0 + 2) {
      const r = await gen.tryOpen(0, 2, C0, bell);
      if (r === 'opened') w.lastCandidatesHash = social.council.periodOf(0, 2).candidates_hash;
    }
    if (bell === C0 + 3 && social.council.periodOf(0, 2)) await aiBallot({ option: 1, period: 2 });
    await social.tick();
  };
  const getJson = async (url) => { const u = new URL(url); const r = await social.routes.dispatch({ method: 'GET', path: u.pathname, query: Object.fromEntries(u.searchParams), headers: {}, peer: '127.0.0.1' }); if (r.status !== 200) throw new Error(`${r.status}`); return r.body; };
  const postJson = async (url, body) => { w.posts.push({ url, bell: clock.bell() }); return social.routes.dispatch({ method: 'POST', path: new URL(url).pathname, body: JSON.stringify(body), headers: {}, peer: '127.0.0.1' }); };
  const sleep = async () => { w.polls++; clock.advance(1); await atBell(); };
  const common = { aiDir: dir.dir, social: 'http://127.0.0.1:1', key: seat.loadSeatKey(seatKeyFile(dir.dir, cits.seat)), config: { council: CFG }, getJson, postJson, bellNow: async () => clock.bell(), sleep, pollMs: 0 };
  Object.assign(w, {
    run: (over = {}) => seat.runSeatScript({ ...common, shouldStop: () => clock.bell() >= C0 + 7, ...over }),
    finaliser: (over = {}) => seat.createSeatFinaliser({ ...chain.io, log: () => {}, ...over }),
  });
  return w;
}

// ---------------------------------------------------------------- the finding, reproduced and fixed
test('OLD FLOW (smoke-r3): a seat whose village is provisional is not on the council\'s eligible list and the real social service refuses its ballot NotEligible', async () => {
  const w = world();
  assert.equal(w.census.hasFinalHolding(w.tags.seat), false, 'the seat\'s village is provisional: no HOLDING_FINAL row for it');
  assert.equal(w.census.hasFinalHolding(w.tags.ai0), true);
  // the script as it ran in smoke-r3: no finaliser, and a `finaliser` option the old loops would ignore is not passed
  const log = await w.run();
  assert.equal(w.census.voters(0).eligible.includes(w.cits.seat.b58), false, 'the council\'s eligible list for nation 0 holds only the AI');
  assert.ok(w.census.voters(0).eligible.includes(w.cits.ai0.b58));
  const st = w.social.council.publicState(0, 2);
  assert.equal(st.ballots_cast, 1, 'only the AI voted');
  assert.deepEqual(st.tally_split, { ai: 1, human: 0, scripted: 0 });
  assert.equal(st.adopted, false);
  assert.equal(st.reason, 'quorum');
  assert.equal(log.periods.length, 1);
  assert.deepEqual({ status: log.periods[0].status, ok: log.periods[0].ok, code: log.periods[0].code }, { status: 400, ok: false, code: 'NotEligible' }, 'the refusal smoke-r3 recorded');
  assert.equal(w.chain.sent.length, 0, 'nothing touched the seat\'s holding');
  w.dir.dispose();
});

test('NEW FLOW: the seat script finalises its own village in time, is on the eligible list at C0, its scripted ballot is accepted and the Strike Order is adopted as scripted seat + AI', async () => {
  const w = world();
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  let log;
  try {
    // the real log line, not the silent one
    log = await w.run({ finaliser: seat.createSeatFinaliser({ ...w.chain.io }) });
  } finally { console.log = orig; }
  assert.equal(w.chain.sent.length, 1, 'exactly one action touched the holding');
  assert.equal(w.chain.sent[0], DUE_BELL, 'sent at the first bell at which the program would take the flip (never before)');
  assert.equal(w.census.hasFinalHolding(w.tags.seat), true, 'the HOLDING_FINAL row reached the owners index');
  assert.ok(w.census.voters(0).eligible.includes(w.cits.seat.b58), 'the council\'s eligible list for nation 0 holds the AI and the seat');
  assert.ok(w.census.voters(0).eligible.includes(w.cits.ai0.b58));
  const st = w.social.council.publicState(0, 2);
  assert.deepEqual(st.tally_split, { ai: 1, human: 0, scripted: 1 }, 'the seat ballot is counted as scripted');
  assert.equal(st.adopted, true);
  assert.equal(st.reason, 'adopted');
  assert.deepEqual({ status: log.periods[0].status, ok: log.periods[0].ok, origin: log.periods[0].origin, scripted: log.periods[0].scripted }, { status: 200, ok: true, origin: 2, scripted: true });
  // the log says what the script is doing
  assert.ok(lines.some((l) => /scripted seat: finalising its village/.test(l)), `a log line says it: ${lines.join(' | ')}`);
  assert.ok(lines.some((l) => /its village is final/.test(l)));
  assert.equal(log.finalise.final, true);
  assert.equal(log.finalise.status, 'final');
  assert.equal(log.finalise.attempts, 1);
  assert.equal(log.scripted, true, 'the earlier seat fix is kept: the label is still there');
  assert.equal(w.posts.length, 1, 'no double ballot');
  assert.equal(JSON.stringify(log).includes('session_keypair'), false);
  const saved = JSON.parse(readFileSync(join(w.dir.dir, 'seat/seat-script-log.json'), 'utf8'));
  assert.equal(saved.finalise.final, true, 'the private log carries the finaliser state');
  w.dir.dispose();
});

test('the finaliser does nothing before the flip is due, then sends exactly once, and stops once the village reads as final', async () => {
  const w = world({ startBell: 20 });
  const f = w.finaliser();
  const seen = [];
  for (let bell = 20; bell <= 36; bell++) {
    w.clock.set(bell);
    await f.step({ bell });
    seen.push([bell, f.state().status, w.chain.sent.length]);
  }
  assert.deepEqual(seen.filter(([b]) => b < DUE_BELL).map((x) => x[2]), new Array(10).fill(0), 'no send while not due');
  assert.ok(seen.filter(([b]) => b < DUE_BELL).every((x) => x[1] === 'waiting_final_due'));
  assert.deepEqual(w.chain.sent, [DUE_BELL]);
  assert.equal(f.state().final, true);
  assert.equal(f.state().final_bell, DUE_BELL + 1, 'seen as final at the bell after the send');
  // done: more steps send nothing
  for (let bell = 37; bell < 45; bell++) await f.step({ bell });
  assert.deepEqual(w.chain.sent, [DUE_BELL]);
  w.dir.dispose();
});

test('the finaliser: one step per bell, quota guard, stone guard, spacing and attempt cap, a failed send is retried later, nothing is sent for a village that is already final', async () => {
  const mk = (over = {}) => {
    const sent = [];
    const io = { readSeat: async () => ({ holding: { state: 1 }, due: true, stone: 400 }), sendWalls: async () => { sent.push(1); return { ok: true, signature: 'sigsigsigsig' }; }, quotaLeft: async () => 40, ...over };
    return { sent, f: seat.createSeatFinaliser({ ...io, log: () => {} }) };
  };
  // one step per bell
  let a = mk();
  await a.f.step({ bell: 10 });
  await a.f.step({ bell: 10 });
  assert.equal(a.sent.length, 1, 'a second step in the same bell does nothing');
  // quota guard: below the reserve nothing is sent and the status says why
  a = mk({ quotaLeft: async () => seat.FINALISE_MIN_QUOTA - 1 });
  await a.f.step({ bell: 10 });
  assert.equal(a.sent.length, 0);
  assert.equal(a.f.state().status, 'waiting_quota');
  // stone guard
  a = mk({ readSeat: async () => ({ holding: { state: 1 }, due: true, stone: seat.WALL_STONE_NEEDED - 1 }) });
  await a.f.step({ bell: 10 });
  assert.equal(a.sent.length, 0);
  assert.equal(a.f.state().status, 'waiting_stone');
  // spacing and the cap: landed walls that do not turn the village final are sent again only after the spacing, at most FINALISE_MAX_ATTEMPTS times
  a = mk();
  for (let bell = 10; bell < 40; bell++) await a.f.step({ bell });
  assert.equal(a.sent.length, seat.FINALISE_MAX_ATTEMPTS);
  assert.equal(a.f.state().status, 'gave_up');
  assert.deepEqual(a.sent.length, 3);
  // a failed send does not count as a landed attempt, is retried after the spacing, and the error is recorded without a key
  let calls = 0;
  a = mk({ sendWalls: async () => { calls++; return calls < 3 ? { ok: false, code: 'QuotaExceeded', error: 'used up' } : { ok: true, signature: 'ok' }; } });
  for (let bell = 10; bell < 19; bell++) await a.f.step({ bell }); // sends at bells 10, 13, 16
  assert.equal(calls, 3);
  assert.equal(a.f.state().attempts, 1);
  assert.equal(a.f.state().tries, 3);
  // already final: nothing is sent
  a = mk({ readSeat: async () => ({ holding: { state: 2 }, due: true, stone: 0 }) });
  await a.f.step({ bell: 10 });
  assert.equal(a.sent.length, 0);
  assert.equal(a.f.state().final, true);
  // no village yet, a herald that does not answer, a send that throws: never an exception out of step()
  a = mk({ readSeat: async () => ({ holding: null, due: false, stone: null }) });
  assert.equal((await a.f.step({ bell: 10 })).status, 'no_village_yet');
  a = mk({ readSeat: async () => { throw new Error('down'); } });
  assert.equal((await a.f.step({ bell: 10 })).status, 'herald_unreachable');
  a = mk({ sendWalls: async () => { throw new Error('boom'); } });
  assert.equal((await a.f.step({ bell: 10 })).status, 'send_failed');
  // preseason: no bell, no step
  a = mk();
  await a.f.step({ bell: null });
  await a.f.step({ bell: -1 });
  assert.equal(a.sent.length, 0);
});

test('the A/B seat finalises its village too (its ballot was refused for the same reason)', async () => {
  const v = world();
  const fin = v.finaliser();
  const ab = await seat.runSeat({ arm: 'A', rep: 1, aiDir: v.dir.dir, social: 'http://127.0.0.1:1', key: seat.loadSeatKey(join(v.dir.dir, 'seat.txt')), config: { council: CFG }, getJson: async () => { throw new Error('no council'); }, postJson: async () => ({ status: 500, body: null }), bellNow: async () => v.clock.bell(), sleep: async () => { v.clock.advance(1); }, pollMs: 0, shouldStop: () => v.clock.bell() >= DUE_BELL + 3, finaliser: fin });
  assert.deepEqual(v.chain.sent, [DUE_BELL]);
  assert.equal(ab.finalise.final, true);
  v.dir.dispose();
});

test('Harvest does not finalise a village; only an instruction that carries the holding\'s Province does (the program, read, not assumed)', () => {
  // the program source is part of this tree: Harvest builds no province and never calls finality(); Build walls does
  const src = readFileSync(new URL('../../permutation-frontier/src/proc/holding.rs', import.meta.url), 'utf8');
  const harvest = src.slice(src.indexOf('pub fn harvest'), src.indexOf('pub fn build'));
  assert.equal(/finality\(/.test(harvest), false, 'Harvest never calls finality()');
  const build = src.slice(src.indexOf('pub fn build'), src.indexOf('fn faction_doctrine'));
  assert.match(build, /own_province\([^)]*\)\?;\s*finality\(/, 'Build with a province (walls) runs the lazy flip');
  assert.equal(seat.ITEM_WALLS, 6, 'the item the seat sends is the walls item (catalog ITEM_WALLS)');
});

// ---------------------------------------------------------------- why a nation got no council
test('the council job writes WHY a nation got no council: not_all_final (with which AI and the seat), no_options, waiting, opened (with the seat on the list or not); a restart keeps it', async () => {
  const w = world();
  // (1) feed incomplete: waiting, recorded
  w.feed.state.through = C0 - 5;
  assert.equal(await w.gen.tryOpen(0, 2, C0, C0), 'waiting');
  assert.deepEqual({ status: w.outcomes.get(0, 2).status, reason: w.outcomes.get(0, 2).reason }, { status: 'waiting', reason: 'feed_incomplete' });
  // (2) the feed completes, no files served: waited for in the first bell (recorded), then no options from C0 + 1
  w.feed.state.through = 100;
  w.feed.files.clear();
  assert.equal(await w.gen.tryOpen(0, 2, C0, C0), 'waiting');
  assert.equal(w.outcomes.get(0, 2).reason, 'waiting_files');
  assert.equal(await w.gen.tryOpen(0, 2, C0, C0 + 1), 'skipped:no_options');
  const no = w.outcomes.get(0, 2);
  assert.deepEqual({ status: no.status, reason: no.reason, c0: no.c0, bell: no.bell }, { status: 'skipped', reason: 'no_options', c0: C0, bell: C0 + 1 });
  assert.ok(Number.isInteger(no.detail.holdings) && no.detail.targets >= 0 && 'fetched' in no.detail, 'the facts the verdict rested on are kept');
  // the file on disk says it, and a new store over the same file (a restart) still does
  const file = join(w.dir.dir, 'state/watcher/council-outcomes.json');
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(onDisk.kind, 'council-open-outcomes');
  assert.equal(onDisk.periods['2']['0'].reason, 'no_options');
  const again = createOutcomes({ file });
  assert.equal(again.get(0, 2).reason, 'no_options');
  assert.deepEqual(again.summary(), { opened: 0, skipped: { no_options: 1 }, waiting: {} });
  w.dir.dispose();
});

test('the verdict of an opened council says whether the seat was on the eligible list (the smoke-r3 cause, now in the files)', async () => {
  const a = world();
  assert.equal(await a.gen.tryOpen(0, 2, C0, C0), 'opened');
  assert.deepEqual(a.outcomes.get(0, 2).detail.seat, { in_eligible_list: false, final_village: false }, 'provisional seat: not on the list');
  assert.equal(a.outcomes.get(0, 2).detail.eligible, 1);
  const b = world();
  b.chain.flip();
  assert.equal(await b.gen.tryOpen(0, 2, C0, C0), 'opened');
  assert.deepEqual(b.outcomes.get(0, 2).detail.seat, { in_eligible_list: true, final_village: true });
  assert.equal(b.outcomes.get(0, 2).detail.eligible, 2);
  a.dir.dispose(); b.dir.dispose();
});

test('not_all_final is recorded with the AI that lacked a final village and the seat\'s own state', async () => {
  const w = world();
  // make the AI's villages provisional by building a world whose AI holds none that is final: reuse the real owners with a second AI that never settled
  const cit = makeCitizen('ai1', { faction: 0 });
  const tag15 = sha('tag15/ai1').slice(0, 30);
  const tag = citizenTagOfTag15(tag15, { seasonAddress: SEASON_ADDR, programId: PROGRAM });
  w.owners.ingest({ kind: 'JOIN', citizen15: tag15, wallet: Buffer.from(b58.decode(cit.b58)).toString('hex'), faction: 0, bell: 3 });
  w.owners.ingest({ kind: 'SETTLE', outcome: 0, p: 2, q: 1, site: 3, citizen: tag, gen: 0, bell: 9, ticket_bell: 3 }); // provisional: no HOLDING_FINAL
  const roster = fakeRoster({
    ai: [{ index: 1000, tag: w.tags.ai0, wallet: w.cits.ai0.b58, faction: 0, name: { en: 'a', ja: 'a' } }, { index: 1001, tag, wallet: cit.b58, faction: 0, name: { en: 'b', ja: 'b' } }],
    seat: { index: 1012, wallet: w.cits.seat.b58, tag: w.tags.seat, faction: 0, kind: 'seat', scripted: true },
  });
  const census = createCensus({ feed: w.feed, roster });
  census.start();
  const gen = createCouncilGen({ feed: w.feed, social: w.social, roster, census, clock: null, mind: () => null, store: { calls: new Set(), dirty: false }, config: { council: CFG }, stats: {}, nowMs: () => 1e12, retryMs: 0, outcomes: w.outcomes });
  assert.equal(await gen.tryOpen(0, 2, C0, C0), 'skipped:not_all_final');
  const o = w.outcomes.get(0, 2);
  assert.deepEqual({ status: o.status, reason: o.reason }, { status: 'skipped', reason: 'not_all_final' });
  assert.deepEqual(o.detail.lacking, [{ tag, villages: 1, final: 0, provisional: 1 }], 'which AI, and that it holds a provisional village');
  assert.deepEqual(o.detail.seat, { tag: w.tags.seat, villages: 1, final: 0, provisional: 1 });
  assert.equal(await gen.tryOpen(0, 2, C0, C0 + 1), 'skipped:not_all_final', 'final for the period, unchanged');
  w.dir.dispose();
});

test('the real watcher writes state/watcher/council-outcomes.json at its tick and shows the counts in its stats', async () => {
  const dir = tmpDir('ai-seatfix2-watcher-');
  const TAG = 'aaaaaaaaaaaaaaa1';
  const wallet = b58.encode(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
  const owners = fakeOwners({ citizens: [{ tag: TAG, faction: 5, kind: 'ai', wallet, holdings: [{ p: 0, q: 0, site: 0, final: false }] }] });
  const feed = fakeFeed({ owners, through: 500, head: 500 });
  const records = createRecords({ aiDir: dir, randomBytes: (n) => Buffer.alloc(n, 9) });
  const stores = createMemoryStore({ stateDir: join(dir, 'state'), pubDir: join(dir, 'pub') });
  const ai = [{ index: 1005, tag: TAG, wallet, faction: 5, persona: 'avenger', name: { en: 'Five', ja: 'Five' } }];
  const roster = { ai, seat: null, byTag: (t) => ai.find((a) => a.tag === t) ?? null, byWallet: (x) => ai.find((a) => a.wallet === x) ?? null, isScript: () => false, isAi: (t) => ai.some((a) => a.tag === t) };
  const council = { config: CFG, periodOf: () => null, publicOf: () => null, latest: () => null, periodAt: () => ({ k: 3, c0: 72 }), tick: async () => {}, open: () => { throw new Error('must not open'); } };
  const social = { subscribe: () => () => {}, book: { list: () => ({ messages: [], next: 0 }) }, council };
  const w = createWatcher({ feed, social, ledgers: stores, records, aiDir: dir, config: { council: CFG }, roster, nameOf: nameOfDouble, nationName: nationNameDouble, nowMs: () => 1e12 });
  w.attachMind({ subscribe: () => () => {}, statsOf: () => ({}), councilCall: async () => ({ social: {} }) });
  await w.tick(72);
  w.stop();
  const file = join(dir, 'state/watcher/council-outcomes.json');
  assert.ok(existsSync(file), 'the verdict is on disk');
  const j = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual({ status: j.periods['3']['5'].status, reason: j.periods['3']['5'].reason, c0: j.periods['3']['5'].c0 }, { status: 'skipped', reason: 'not_all_final', c0: 72 });
  assert.equal(w.stats().council.outcomes.skipped.not_all_final, 1);
});

// ---------------------------------------------------------------- the report shows it
test('the run report lists, per period and nation, a council, the skip reason, a period that passed with no verdict, or nothing recorded; and the seat\'s finalisation', () => {
  const dir = tmpDir('ai-seatfix2-report-');
  mkdirSync(join(dir, 'pub/council'), { recursive: true });
  mkdirSync(join(dir, 'state/watcher'), { recursive: true });
  mkdirSync(join(dir, 'seat'), { recursive: true });
  const ai = (f) => ({ index: 1000 + f, tag: String(f).repeat(16), wallet: `w${f}`, faction: f, persona: 'avenger', name: { en: `N${f}`, ja: `N${f}` } });
  writeFileSync(join(dir, 'pub/roster.json'), JSON.stringify({ v: 1, season: 1, ai: [ai(0), ai(1), ai(5)] }));
  writeFileSync(join(dir, 'pub/council/2-0.json'), JSON.stringify({ period: 2, faction: 0, c0: 48, adopted: false, ballots_cast: 1 }));
  writeFileSync(join(dir, 'state/watcher/council-outcomes.json'), JSON.stringify({
    v: 1, kind: 'council-open-outcomes', periods: {
      2: { 0: { status: 'opened', reason: null, c0: 48, bell: 48, detail: { seat: { in_eligible_list: false, final_village: false } } }, 1: { status: 'opened', reason: null, c0: 48, bell: 48, detail: null }, 5: { status: 'skipped', reason: 'not_all_final', c0: 48, bell: 48, detail: { lacking: [{ tag: '5'.repeat(16), villages: 1, final: 0, provisional: 1 }] } } },
      3: { 0: { status: 'waiting', reason: 'feed_incomplete', c0: 72, bell: 74, detail: { complete_through: 60, needs: 71 } }, 5: { status: 'skipped', reason: 'no_options', c0: 72, bell: 72, detail: { holdings: 1 } } },
    },
  }));
  writeFileSync(join(dir, 'seat/seat-script-log.json'), JSON.stringify({ finalise: { status: 'final', final: true, attempts: 1, final_bell: 31 } }));
  const sec = councilOutcomesSection(loadRun(dir));
  assert.equal(sec.available, true);
  const at = (period, nation) => sec.rows.find((r) => r.period === period && r.nation === nation);
  assert.equal(at(2, 0).kind, 'council');
  assert.deepEqual({ kind: at(2, 5).kind, reason: at(2, 5).reason }, { kind: 'skipped', reason: 'not_all_final' });
  assert.deepEqual({ kind: at(3, 0).kind, reason: at(3, 0).reason }, { kind: 'waiting', reason: 'feed_incomplete' }, 'a period that passed with no verdict is not called a skip');
  assert.deepEqual({ kind: at(3, 5).kind, reason: at(3, 5).reason }, { kind: 'skipped', reason: 'no_options' });
  assert.equal(at(3, 1).kind, 'no_verdict', 'nothing recorded for this nation and period');
  assert.equal(sec.by_reason['skipped:not_all_final'], 1);
  assert.equal(sec.seat_finalise.final, true);
  const r = buildReport({ aiDir: dir });
  assert.equal(r.social.council_outcomes.rows.length, 6);
  const md = renderMarkdown(r);
  assert.match(md, /Why a nation had no council/);
  assert.match(md, /\| 2 \| 5 \| skipped \| not_all_final \|/);
  assert.match(md, /\| 3 \| 1 \| no_verdict \|/);
  assert.match(md, /Scripted seat, finalising its village: status final, final true, attempts 1, final seen at bell 31/);
  // --public-only does not read operator state
  const pub = buildReport({ aiDir: dir, privateOk: false });
  assert.equal(pub.social.council_outcomes.available, false);
  assert.match(pub.social.council_outcomes.note, /public-only/);
  // a run without the file says so instead of inventing rows
  const empty = tmpDir('ai-seatfix2-empty-');
  mkdirSync(join(empty, 'pub'), { recursive: true });
  assert.equal(councilOutcomesSection(loadRun(empty)).available, false);
});
