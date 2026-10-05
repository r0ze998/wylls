// Live seat (the recording run; docs/frontier/ai-citizens/RECORDING-RUN.md, contract 9.2 and 9.4): in the recording the presenter (the operator) votes for
// real on the council page, so the seat must NOT cast a ballot, yet its village must still be made final before the council opens (a live seat
// has no script, so before this change its village stayed provisional and the presenter was refused NotEligible), and the roster and the page
// must show it as the live presenter (`scripted: false`, origin 0), not "scripted".
//
// What is real here: the social service (`createSocial`: book, council store, routes), the census and owners index fed with the herald's rows, the
// council job (`tryOpen`), the seat finaliser and the live seat loop (`runSeatLive`), and the PAGE's own modules (council/keys.mjs `parseKeyText` and
// `makeSigner` with web/session.mjs Ed25519, council/ballot.mjs `castBallot`, `normalizeCouncil`, `renderCouncil`, `pivotal`), so the presenter's ballot
// is signed with the exported key exactly as the page signs it. What is a double: the chain (as in citizens-seatfix2.test.mjs) and the browser (a fake DOM).
//
// Why each test fails on the code before this change: `runSeatLive`, `writePresenterKey`, `createSeatFinaliser({mode: 'live'})`, `councilSchedule`,
// `scheduleLines`, the `--seat-live` and `--hold` flags and `bin/record-info.mjs` do not exist; the report does not read `seat-live-log.json`.
import './fixtures/ai-page-lang.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';
import * as b58 from '../../permutation-server/web/sdk/base58.mjs';
import { keyFromSeed } from '../../permutation-server/web/session.mjs';
import { toBase58 } from '../../permutation-server/web/frontier/council/aisocial.mjs';
import { parseKeyText, makeSigner, signerKind, signerRefusal } from '../../permutation-server/web/frontier/council/keys.mjs';
import { castBallot, normalizeCouncil, renderCouncil, pivotal, adoptionParts } from '../../permutation-server/web/frontier/council/ballot.mjs';
import { makeRosterIndex, badgeOf } from '../../permutation-server/web/frontier/council/badges.mjs';
import { refusalText } from '../../permutation-server/web/frontier/council/notice.mjs';
import { makeH } from '../../permutation-server/web/frontier/council/dom.mjs';
import { tl } from '../../permutation-server/web/frontier/council/lang.mjs';
import { createSocial } from '../citizens/social/routes.mjs';
import { createCensus } from '../citizens/watcher/census.mjs';
import { createCouncilGen, ball } from '../citizens/watcher/council_gen.mjs';
import { createOwners, citizenTagOfTag15 } from '../citizens/watcher/owners.mjs';
import { tallyPhrase } from '../citizens/watcher/chronicle.mjs';
import { buildReport, councilOutcomesSection, loadRun, renderMarkdown } from '../citizens/report.mjs';
import { builders, fakeHerald, makeCitizen, makeClock, tmpAiDir, SEASON } from './fixtures/ai-social-kit.mjs';
import { fakeFeed, fakeRoster, host, province, tmpDir } from './fixtures/ai-watcher-kit.mjs';
import { makeFakeDocument, textOf } from './fixtures/ai-page-dom.mjs';
import * as seat from '../citizens/ab/seat.mjs';
import { infoLines } from '../citizens/bin/record-info.mjs';

const CFG = { period: 24, offset: 0, strike_lead: 6, human_present: true };
const C0 = 48;
const DUE_BELL = 30;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const PROGRAM = b58.encode(Uint8Array.from({ length: 32 }, (_, i) => 100 + i));
const SEASON_ADDR = b58.encode(Uint8Array.from({ length: 32 }, (_, i) => 50 + i));
const h = makeH(makeFakeDocument());

/** The seat file as `frontier-bots --export-seat-key` writes it: the SESSION keypair and ALSO the wallet keypair (a secret the page must never be shown). */
function seatKeyFile(dir, citizen) {
  const file = join(dir, 'seat.txt');
  const kp = new Uint8Array(64);
  kp.set(citizen.key.seed, 0);
  kp.set(citizen.key.pub, 32);
  writeFileSync(file, JSON.stringify({ index: 1012, wallet: citizen.b58, wallet_keypair_b58: 'WALLET-SECRET-NOT-FOR-THE-PAGE', session: toBase58(citizen.key.pub), session_keypair_b58: toBase58(kp) }));
  return file;
}

/**
 * Nation 0: one AI (two final villages) and the seat (PROVISIONAL until the chain double flips it); nation 3: a foe. The roster says the seat is NOT scripted
 * (a run started without --seat-script). The council job opens period 2 (C0 48) with options; the AI ballots option 1 at C0 + 3.
 */
function world({ startBell = 20 } = {}) {
  const clock = makeClock({ bell: startBell });
  const dir = tmpAiDir('seatlive-');
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
  enrol('seat', 0, [[1, 1, 1]], false);
  enrol('foe', 3, [[3, 0, 0]], true);
  const roster = fakeRoster({
    ai: [{ index: 1000, tag: tags.ai0, wallet: cits.ai0.b58, faction: 0, name: { en: 'AI0', ja: 'AI0' } }],
    seat: { index: 1012, wallet: cits.seat.b58, tag: tags.seat, faction: 0, kind: 'seat', scripted: false, label: 'Presenter (operator, human)' },
  });
  const rosterJson = { v: 1, season: SEASON, ai: roster.ai.map((a) => ({ ...a, persona: 'avenger' })), script: { wallets: [] }, seat: roster.seat };
  mkdirSync(join(dir.dir, 'pub'), { recursive: true });
  writeFileSync(join(dir.dir, 'pub/roster.json'), JSON.stringify(rosterJson));
  const feed = fakeFeed({ owners, through: 100, head: 100 });
  const f2 = C0 - 2;
  feed.files.set(`2,0,${f2}`, province({ p: 2, q: 0, bell: f2, camp: { tile: 44, troops: 200 } }));
  feed.files.set(`1,1,${f2}`, province({ p: 1, q: 1, bell: f2, hosts: [host({ owner: 'x', faction: 0, tile: 30, troops: 500 }), host({ owner: 'x', faction: 0, tile: 31, troops: 400 }), host({ faction: 3, tile: 20, troops: 300 })] }));
  for (const c of ball(0, 0, 5)) if (!feed.files.has(`${c.p},${c.q},${f2}`)) feed.files.set(`${c.p},${c.q},${f2}`, province({ p: c.p, q: c.q, bell: f2 }));
  const herald = fakeHerald(Object.values(cits));
  const outputs = new Map();
  const social = createSocial({ herald, aiDir: dir.dir, roster: rosterJson, clock, provenance: (id, item, type) => outputs.get(`${id}|${item}|${type}`) ?? null, config: { council: CFG }, season: SEASON, random: (m) => new Uint8Array(m).fill(0x11) });
  const census = createCensus({ feed, roster });
  census.start();
  const gen = createCouncilGen({ feed, social, roster, census, clock: null, mind: () => null, store: { calls: new Set(), dirty: false }, config: { council: CFG }, stats: {}, nowMs: () => 1e12, retryMs: 0 });
  const b = builders(clock);
  let seq = 0;
  const w = { clock, dir, cits, tags, owners, census, gen, social, rosterJson, feed, posts: [], polls: 0, lastCandidatesHash: null };
  const chain = {
    sent: [],
    due: () => clock.bell() >= DUE_BELL,
    holding: () => owners.holdingsOf(tags.seat)[0] ?? null,
    flip() { const hd = chain.holding(); owners.ingest({ kind: 'HOLDING_FINAL', p: hd.p, q: hd.q, site: hd.site }); },
    io: {
      readSeat: async () => { const hd = chain.holding(); return hd ? { holding: { state: hd.final ? 2 : 1 }, due: chain.due(), stone: 320 } : { holding: null, due: false, stone: null }; },
      sendWalls: async () => { chain.sent.push(clock.bell()); if (chain.due()) chain.flip(); return { ok: true, state: 'landed', signature: `sig${chain.sent.length}-aaaaaaaa` }; },
      quotaLeft: async () => 40,
    },
  };
  w.chain = chain;
  const aiBallot = async ({ option, period }) => {
    const c = cits.ai0;
    const id = `bd${seq++}`;
    outputs.set(`${id}|0|ballot`, { type: 'ballot', bell: clock.bell(), option, period, faction: 0, candidates_hash: w.lastCandidatesHash });
    return social.book.submit('ballot', b.ballot(c, { period, option, candidates_hash: w.lastCandidatesHash, origin: 1 }, { decision_id: id, item: 0 }).body);
  };
  w.atBell = async () => {
    const bell = clock.bell();
    if (bell >= C0 && bell <= C0 + 2) {
      const r = await gen.tryOpen(0, 2, C0, bell);
      if (r === 'opened') w.lastCandidatesHash = social.council.periodOf(0, 2).candidates_hash;
    }
    if (bell === C0 + 3 && social.council.periodOf(0, 2)) await aiBallot({ option: 1, period: 2 });
    await social.tick();
  };
  w.getJson = async (url) => { const u = new URL(url); const r = await social.routes.dispatch({ method: 'GET', path: u.pathname, query: Object.fromEntries(u.searchParams), headers: {}, peer: '127.0.0.1' }); if (r.status !== 200) throw new Error(`${r.status}`); return r.body; };
  // every POST that reaches the social service from the SEAT PROCESS side is counted here (the page's own post below is separate)
  w.postJson = async (url, body) => { w.posts.push(url); return social.routes.dispatch({ method: 'POST', path: new URL(url).pathname, body: JSON.stringify(body), headers: {}, peer: '127.0.0.1' }); };
  w.sleep = async () => { w.polls++; clock.advance(1); await w.atBell(); };
  w.keyFile = seatKeyFile(dir.dir, cits.seat);
  w.key = seat.loadSeatKey(w.keyFile);
  w.lines = [];
  w.live = (over = {}) => seat.runSeatLive({ aiDir: dir.dir, social: 'http://127.0.0.1:1', key: w.key, config: { council: CFG, time: { bell_secs: 600, scale: 10 } }, getJson: w.getJson, bellNow: async () => clock.bell(), sleep: w.sleep, pollMs: 0, say: (m) => w.lines.push(m), now: () => 1_700_000_000_000, clock: () => '12:00:00', ...over });
  w.finaliser = (over = {}) => seat.createSeatFinaliser({ ...chain.io, mode: 'live', log: (m) => w.lines.push(m), ...over });
  /** The page side: the key file the run writes for the presenter, parsed and used as the page does, and a POST the way the page's api.post answers. */
  w.page = async ({ exported = true } = {}) => {
    const file = exported ? seat.writePresenterKey({ keyFile: w.keyFile }) : w.keyFile; // `exported: false` = the fleet's raw seat file, which the page accepts as well
    const parsed = parseKeyText(readFileSync(file, 'utf8'));
    const signer = await makeSigner(parsed, async (s) => keyFromSeed(Uint8Array.from(s)));
    const post = async (path, body) => { const r = await social.routes.dispatch({ method: 'POST', path, body: JSON.stringify(body), headers: {}, peer: '127.0.0.1' }); return { ok: r.status < 300, status: r.status, json: r.body }; };
    return { file, parsed, signer, post };
  };
  return w;
}

const councilView = (w, over = {}) => normalizeCouncil({ ...w.social.council.publicState(0, 2), ...over });

// ---------------------------------------------------------------- the finding: a seat nobody drives is not eligible
test('WITHOUT the live seat (the old recording setup: no seat process at all) the seat\'s village stays provisional and the presenter\'s page ballot is refused NotEligible', async () => {
  const w = world();
  for (let i = 0; i < 32; i++) await w.sleep(); // bells 21 .. 52: the council opens at 48, the AI ballots at 51, nothing touches the seat's village
  assert.equal(w.clock.bell(), C0 + 4, 'inside the ballot window');
  assert.equal(w.census.hasFinalHolding(w.tags.seat), false);
  const page = await w.page({ exported: false }); // the raw seat file (the old setup had no presenter-key.json), pasted into the page
  const c = councilView(w);
  const r = await castBallot({ signer: { ...page.signer, kind: 'seat' }, post: page.post, season: SEASON, period: 2, faction: 0, option: 1, candidatesHash: c.candidatesHash, nonce16: crypto.randomBytes(16) });
  assert.deepEqual({ ok: r.ok, code: r.code }, { ok: false, code: 'NotEligible' }, 'the refusal the owner would have met');
  w.dir.dispose();
});

// ---------------------------------------------------------------- the new flow, end to end
test('LIVE SEAT: the seat is finalised before C0 and eligible; it casts NO ballot; the presenter\'s page ballot (exported key) is accepted as HUMAN, satisfies the human-present rule, and the page and the chronicle say so', async () => {
  const w = world();
  // the live seat process: the finaliser only (mode live) and the council watch; it is stopped after the AI's ballot, before the presenter votes
  const log = await w.live({ finaliser: w.finaliser(), shouldStop: () => w.clock.bell() >= C0 + 4 });
  assert.deepEqual(w.chain.sent, [DUE_BELL], 'one Build of walls, at the first bell the program would take the flip');
  assert.equal(w.census.hasFinalHolding(w.tags.seat), true);
  assert.ok(w.census.voters(0).eligible.includes(w.cits.seat.b58), 'the seat is on the council\'s eligible list at C0');
  assert.deepEqual(w.posts, [], 'the live seat posted NOTHING to the social service');
  let st = w.social.council.publicState(0, 2);
  assert.equal(st.state, 'ballots');
  assert.equal(st.ballots_cast, 1, 'only the AI has voted: no seat ballot, scripted or other');
  assert.deepEqual(log.finalise && { final: log.finalise.final, scripted: log.finalise.scripted, mode: log.finalise.mode }, { final: true, scripted: false, mode: 'live' });
  assert.equal(log.casts_ballots, false);
  assert.equal(log.scripted, false);

  // the PAGE side: the presenter pastes KEYS/presenter-key.json, the page signs a ballot with it (origin 0)
  const page = await w.page();
  assert.equal(page.parsed.ok, true);
  assert.equal(page.parsed.source, 'seat-file');
  assert.equal(page.signer.ok, true);
  assert.equal(page.signer.wallet, w.cits.seat.b58);
  const index = makeRosterIndex({ ...w.rosterJson, ai: w.rosterJson.ai.map((a) => ({ ...a, name: { en: 'AI0', ja: 'AI0' } })) });
  assert.equal(signerKind(index, page.signer), 'seat', 'the page treats the key as the presenter seat');
  assert.equal(signerRefusal(index, page.signer), null, 'not refused as an AI key');
  const cv = councilView(w);
  const r = await castBallot({ signer: page.signer, post: page.post, season: SEASON, period: 2, faction: 0, option: 1, candidatesHash: cv.candidatesHash, nonce16: crypto.randomBytes(16) });
  assert.equal(r.ok, true, `the service accepted the presenter's ballot: ${JSON.stringify(r)}`);

  // the close
  w.clock.set(C0 + 6);
  await w.social.tick();
  st = w.social.council.publicState(0, 2);
  assert.equal(st.state, 'closed');
  assert.deepEqual(st.tally_split, { ai: 1, human: 1, scripted: 0 }, 'the ballot counts as HUMAN (origin 0), not scripted');
  assert.equal(st.adopted, true, `adopted by one AI ballot plus the presenter's ballot: ${st.reason}`);
  assert.equal(st.reason, 'adopted');
  // the human-present rule is on, and the winner's ballots include a human (origin 0) one; the rule's refusal path itself is covered by citizens-social-council.test.mjs
  assert.equal(w.social.council.config.human_present, true);

  // the page: the tally line, the adoption line and the pivotal verdict
  const closed = councilView(w);
  const en = (k, v) => tl('en', k, v);
  const node = renderCouncil({ h, t: en, lang: 'en', index, resolve: null }, { council: closed, bell: C0 + 6, faction: 0, me: { wallet: page.signer.wallet, faction: 0 }, mine: { option: 1, origin: 0 }, note: '', slots: {}, draft: { option: 1, text: '' }, onDraft() {}, onNation() {}, onVote() {}, onMotion() {} });
  const text = textOf(node);
  assert.match(text, /Ballots by who cast them: AI 1 · human \(the presenter\) 1 · scripted seat 0/);
  assert.match(text, /Strike Order adopted with 1 AI ballot\(s\) \+ the presenter’s ballot — strike at bell 60 \(target sealed\)/);
  assert.equal(adoptionParts(en, closed.tallySplit), '1 AI ballot(s) + the presenter’s ballot');
  assert.deepEqual(pivotal({ council: closed, wallet: page.signer.wallet, humanSeatHere: true, mine: { option: 1, origin: 0 } }), { state: 'yes', why: 'human' }, 'the page says the ballot was pivotal');
  assert.match(text, /Was your ballot pivotal\?.*Yes/);
  assert.equal(tallyPhrase(st.tally_split, { seatVoted: true }, 'en'), 'with 1 AI ballot and the presenter\'s ballot', 'the chronicle line');
  // the roster: not scripted, the seat is badged as the presenter, not as "scripted for the A/B test"
  assert.equal(index.seat.scripted, false);
  const seatBadge = badgeOf(index, { wallet: w.cits.seat.b58 }, { origin: 0 });
  assert.deepEqual({ look: seatBadge.look, labelKey: seatBadge.labelKey, noteKey: seatBadge.noteKey }, { look: 'seat', labelKey: 'badge.seat', noteKey: null }, 'the live presenter: no "scripted seat message" note');
  assert.equal(tl('en', seatBadge.labelKey), 'presenter seat (human operator)');
  // the contrast: a roster that marks the seat scripted gets the dashed "scripted for the A/B test" badge
  const scriptedIndex = makeRosterIndex({ ...w.rosterJson, seat: { ...w.rosterJson.seat, scripted: true } });
  assert.equal(badgeOf(scriptedIndex, { wallet: w.cits.seat.b58 }, { origin: 2 }).look, 'seat-scripted');
  // no seat ballot record was ever written by the process
  assert.equal(existsSync(join(w.dir.dir, 'pub/seat/ballots.json')), false);
  assert.equal(existsSync(join(w.dir.dir, 'seat/seat-script-log.json')), false);
  w.dir.dispose();
});

test('a presenter who does not vote leaves the AI\'s single ballot below the quorum: no Strike Order (nothing is adopted without the live ballot)', async () => {
  const w = world();
  await w.live({ finaliser: w.finaliser(), shouldStop: () => w.clock.bell() >= C0 + 4 });
  w.clock.set(C0 + 6);
  await w.social.tick();
  const st = w.social.council.publicState(0, 2);
  assert.deepEqual({ adopted: st.adopted, reason: st.reason, split: st.tally_split }, { adopted: false, reason: 'quorum', split: { ai: 1, human: 0, scripted: 0 } }, 'a presenter who does not vote leaves one ballot');
  w.dir.dispose();
});

// ---------------------------------------------------------------- the presenter's key file
test('presenter-key.json: exactly the fields the page reads, the session key only (no wallet secret), mode 600, one line; the page accepts it and signs as the seat; a file that is not a seat key is refused', async () => {
  const w = world();
  const file = seat.writePresenterKey({ keyFile: w.keyFile });
  assert.equal(file, join(w.dir.dir, seat.PRESENTER_KEY_FILE));
  const text = readFileSync(file, 'utf8');
  assert.equal(text.trim().includes('\n'), false, 'one line: a pasted multi-line JSON would fill the textarea');
  const j = JSON.parse(text);
  assert.deepEqual(Object.keys(j).sort(), ['session', 'session_keypair_b58', 'wallet']);
  assert.equal(text.includes('WALLET-SECRET-NOT-FOR-THE-PAGE'), false, 'the wallet keypair is left out');
  assert.equal(text.includes('wallet_keypair'), false);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const parsed = parseKeyText(text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.wallet, w.cits.seat.b58);
  assert.equal(parsed.session, toBase58(w.cits.seat.key.pub));
  // the seat's own export (the file the fleet writes) is accepted by the page as well: the format needed no fix on the page side
  assert.equal(parseKeyText(readFileSync(w.keyFile, 'utf8')).ok, true);
  // a mismatching seed is refused before anything is written
  const bad = join(w.dir.dir, 'bad.txt');
  writeFileSync(bad, JSON.stringify({ wallet: w.cits.seat.b58, session: w.cits.foe.b58, session_keypair_b58: JSON.parse(readFileSync(w.keyFile, 'utf8')).session_keypair_b58 }));
  assert.throws(() => seat.writePresenterKey({ keyFile: bad, outFile: join(w.dir.dir, 'x.json') }), /does not give the listed session public key/);
  assert.equal(existsSync(join(w.dir.dir, 'x.json')), false);
  w.dir.dispose();
});

// ---------------------------------------------------------------- the loop never votes, says what it does, refuses a contradictory roster
test('the live seat loop casts no ballot and no message even with a postJson handed to it, in a ballot window with options; its log, the published record and every line say so', async () => {
  const w = world();
  const spy = [];
  const log = await w.live({ finaliser: w.finaliser(), postJson: async (...a) => { spy.push(a); return { status: 200, body: {} }; }, shouldStop: () => w.clock.bell() >= C0 + 7 });
  assert.deepEqual(spy, [], 'runSeatLive has no way to post');
  assert.deepEqual(w.posts, []);
  assert.equal(w.social.council.publicState(0, 2).tally_split.scripted, 0);
  assert.equal(log.kind, 'seat-live-log');
  assert.deepEqual({ scripted: log.scripted, casts_ballots: log.casts_ballots, origin: log.origin, nation: log.nation }, { scripted: false, casts_ballots: false, origin: 0, nation: 0 });
  assert.match(log.statement, /cast by the presenter on the council page \(origin 0, counted as human\)/);
  assert.match(log.statement, /Build of walls .* run harness's act, not the presenter's/);
  const saved = JSON.parse(readFileSync(join(w.dir.dir, 'seat', seat.LIVE_LOG_FILE), 'utf8'));
  assert.equal(saved.finalise.final, true);
  const pub = JSON.parse(readFileSync(join(w.dir.dir, 'pub/seat/live.json'), 'utf8'));
  assert.deepEqual({ kind: pub.kind, scripted: pub.scripted, casts_ballots: pub.casts_ballots, origin: pub.origin }, { kind: 'seat-live', scripted: false, casts_ballots: false, origin: 0 });
  assert.equal(pub.finalise.by, 'run harness');
  assert.equal(pub.finalise.final, true);
  assert.equal(JSON.stringify(pub).includes('option'), false, 'no ballot option is published');
  assert.equal(JSON.stringify([log, pub, w.lines]).includes('session_keypair'), false);
  assert.equal(existsSync(join(w.dir.dir, 'pub/seat/ballots.json')), false, 'the scripted seat record is not written');
  w.dir.dispose();
});

test('the live seat prints where the council stands: open, BALLOT WINDOW, closed (adopted or why not); schedule estimates once; a warning when its village is not final at the opening; every line carries a clock time', async () => {
  const w = world();
  await w.live({ finaliser: w.finaliser(), shouldStop: () => w.clock.bell() >= C0 + 7 });
  const said = w.lines.filter((l) => /^\[12:00:00\] seat/.test(l));
  assert.ok(said.length >= 4, w.lines.join('\n'));
  assert.ok(w.lines.every((l) => /^\[12:00:00\] /.test(l) || /live seat \(run harness\)/.test(l)), 'every seat line has a time stamp (the finaliser\'s own lines carry the label)');
  const t = w.lines.join('\n');
  assert.match(t, /live seat: the presenter casts the ballot on the council page \(origin 0\); this process casts no ballot/);
  assert.match(t, /seat \(live\): period 1: motions from about \d\d:\d\d \(bell 24\); BALLOT WINDOW about \d\d:\d\d to \d\d:\d\d \(bells 27 to 29\)/);
  assert.match(t, /seat \(live\): period 2: motions from about \d\d:\d\d \(bell 48\); BALLOT WINDOW about \d\d:\d\d to \d\d:\d\d \(bells 51 to 53\); strike about \d\d:\d\d \(bell 60\); the order opens about \d\d:\d\d \(bell 62\)/);
  assert.match(t, /council of nation 0, period 2: OPEN at bell 4[89]\. Motions until the end of bell 50; BALLOT WINDOW bells 51 to 53 \(about \d\d:\d\d to \d\d:\d\d; closes at bell 54\); \d option\(s\)/);
  assert.match(t, /council of nation 0, period 2: BALLOT WINDOW OPEN at bell 51: the presenter votes on the council page now \(last bell to vote: 53\)/);
  assert.match(t, /council of nation 0, period 2: CLOSED, no Strike Order \(quorum\)/);
  assert.doesNotMatch(t, /WARNING/, 'the village was final in time: no warning');
  assert.match(t, /live seat \(run harness\): finalising its village : a Build of walls touches its holding at bell 30 \(no vote, no troops\)/);
  assert.doesNotMatch(t, /scripted seat: finalising/);
  // the warning: a seat whose finaliser could not finalise by the opening
  const w2 = world();
  const stuck = w2.finaliser({ readSeat: async () => ({ holding: { state: 1 }, due: false, stone: 320 }) });
  await w2.live({ finaliser: stuck, shouldStop: () => w2.clock.bell() >= C0 + 2 });
  assert.match(w2.lines.join('\n'), /council of nation 0, period 2: OPEN at bell 4\d\..*WARNING: the seat's village is not final \(waiting_final_due\); the presenter would be refused NotEligible in this period/);
  w.dir.dispose(); w2.dir.dispose();
});

test('the live seat warns when it has NO finaliser (it could not start, or --finalise 0): at the council opening and again at the ballot window', async () => {
  const w = world();
  await w.live({ finaliser: null, shouldStop: () => w.clock.bell() >= C0 + 4 });
  const t = w.lines.join('\n');
  assert.match(t, /council of nation 0, period 2: OPEN at bell 4[89]\..*WARNING: the seat's village is not being finalised \(the finaliser is not running\); the presenter would be refused NotEligible in this period/);
  assert.match(t, /council of nation 0, period 2: BALLOT WINDOW OPEN at bell 51: .*ballots cast so far: \d+\. WARNING: the seat's village is not being finalised/);
  w.dir.dispose();
});

test('the live seat refuses a roster that marks the seat scripted (a --seat-script run), and a key that is not the roster seat', async () => {
  const w = world();
  const r = JSON.parse(readFileSync(join(w.dir.dir, 'pub/roster.json'), 'utf8'));
  r.seat.scripted = true;
  writeFileSync(join(w.dir.dir, 'pub/roster.json'), JSON.stringify(r));
  await assert.rejects(() => w.live({ finaliser: w.finaliser(), shouldStop: () => w.clock.bell() >= C0 }), /roster marks the seat scripted, but this is a live seat run/);
  r.seat.scripted = false;
  r.seat.wallet = w.cits.foe.b58;
  writeFileSync(join(w.dir.dir, 'pub/roster.json'), JSON.stringify(r));
  await assert.rejects(() => w.live({ finaliser: w.finaliser(), shouldStop: () => w.clock.bell() >= C0 }), /the key file is not the roster seat/);
  w.dir.dispose();
});

test('the live loop ends on the stop file, an end bell or a signal flag and waits through preseason (bell null or -1), never on a poll count', async () => {
  const w = world();
  let polls = 0;
  const log = await w.live({ finaliser: null, bellNow: async () => (polls++ < 600 ? -1 : 5), sleep: async () => {}, shouldStop: () => polls > 700 });
  assert.ok(polls > 600, 'more than 400 polls in preseason and still running');
  assert.match(log.notes.at(-1), /stop file or signal/);
  const w2 = world();
  const log2 = await w2.live({ finaliser: null, endBell: 30, shouldStop: () => false });
  assert.match(log2.notes.at(-1), /reached the end bell 30/);
  w.dir.dispose(); w2.dir.dispose();
});

// ---------------------------------------------------------------- the finaliser labels, the schedule, the report
test('the live finaliser: the same single Build of walls, labelled as the run harness\'s and not scripted; the default (scripted) finaliser is unchanged', async () => {
  const sent = [];
  const lines = [];
  const io = { readSeat: async () => ({ holding: { state: 1 }, due: true, stone: 400 }), sendWalls: async () => { sent.push(1); return { ok: true, signature: 'sigsigsigsig' }; }, quotaLeft: async () => 40 };
  const live = seat.createSeatFinaliser({ ...io, mode: 'live', log: (m) => lines.push(m) });
  await live.step({ bell: 10 });
  assert.equal(sent.length, 1);
  const st = live.state();
  assert.deepEqual({ scripted: st.scripted, mode: st.mode }, { scripted: false, mode: 'live' });
  assert.match(st.statement, /run harness .* casts no vote and moves no troops/);
  assert.ok(lines.length && lines.every((l) => l.startsWith(seat.FINALISE_LINE_LIVE)), lines.join('|'));
  const old = [];
  const sc = seat.createSeatFinaliser({ ...io, log: (m) => old.push(m) });
  await sc.step({ bell: 10 });
  assert.equal(sc.state().scripted, true);
  assert.equal('mode' in sc.state(), false, 'the scripted state is exactly what it was');
  assert.ok(old.every((l) => l.startsWith(seat.FINALISE_LINE)));
});

test('councilSchedule and scheduleLines: C0 = k * period + offset, motions [C0, C0+3), ballots [C0+3, C0+6), strike C0+6+lead, open at S+2; clock times from the bell now at the real bell length', () => {
  const c = seat.councilSchedule({ period: 24, offset: 0, strike_lead: 6 }, 2);
  assert.deepEqual(c, { k: 2, c0: 48, motions_from: 48, motions_to: 50, ballots_from: 51, ballots_to: 53, close: 54, follow_from: 54, strike: 60, opens: 62 });
  assert.deepEqual(seat.councilSchedule({ period: 48, offset: 12, strike_lead: 6 }, 1).c0, 60, 'the main config');
  assert.equal(seat.bellMsOf({ time: { bell_secs: 600, scale: 10 } }), 60_000);
  const L = seat.scheduleLines({ bell: 40, nowMs: Date.UTC(2026, 9, 5, 3, 0, 0), config: { council: { period: 24, offset: 0, strike_lead: 6 }, time: { bell_secs: 600, scale: 10 } }, periods: 2, clock: (ms) => new Date(ms).toISOString().slice(11, 19) });
  assert.equal(L.length, 2);
  assert.match(L[0], /^period 2: motions from about 03:08 \(bell 48\); BALLOT WINDOW about 03:11 to 03:14 \(bells 51 to 53\); strike about 03:20 \(bell 60\); the order opens about 03:22 \(bell 62\)$/);
  assert.match(L[1], /^period 3: motions from about 03:32 /);
});

test('the run report reads the live seat\'s log and says "Live seat" (not "Scripted seat")', () => {
  const dir = tmpDir('ai-seatlive-report-');
  mkdirSync(join(dir, 'pub/council'), { recursive: true });
  mkdirSync(join(dir, 'state/watcher'), { recursive: true });
  mkdirSync(join(dir, 'seat'), { recursive: true });
  writeFileSync(join(dir, 'pub/roster.json'), JSON.stringify({ v: 1, season: 1, ai: [{ index: 1000, tag: '0'.repeat(16), wallet: 'w0', faction: 0, persona: 'avenger', name: { en: 'N0', ja: 'N0' } }] }));
  writeFileSync(join(dir, 'pub/council/2-0.json'), JSON.stringify({ period: 2, faction: 0, c0: 48, adopted: true, ballots_cast: 2 }));
  writeFileSync(join(dir, 'state/watcher/council-outcomes.json'), JSON.stringify({ v: 1, kind: 'council-open-outcomes', periods: { 2: { 0: { status: 'opened', reason: null, c0: 48, bell: 49, detail: null } } } }));
  writeFileSync(join(dir, 'seat', 'seat-live-log.json'), JSON.stringify({ kind: 'seat-live-log', finalise: { mode: 'live', status: 'final', final: true, attempts: 1, final_bell: 35 } }));
  const sec = councilOutcomesSection(loadRun(dir));
  assert.equal(sec.seat_finalise.final, true);
  assert.equal(sec.seat_finalise.live, true);
  const md = renderMarkdown(buildReport({ aiDir: dir }));
  assert.match(md, /Live seat \(run harness; the presenter votes on the page\), finalising its village: status final, final true, attempts 1, final seen at bell 35/);
  assert.doesNotMatch(md, /Scripted seat, finalising/);
});

// ---------------------------------------------------------------- what the operator reads
test('record-info: the page and map addresses, the presenter key and how to copy it, the timeline of period 2 (C0 48, ballots 51-53, strike 60, opens 62), what not to do, how to stop', () => {
  const L = infoLines({ runId: 'ai-record-1', serve: 'http://127.0.0.1:41902', keys: '/x/keys', stopFile: '/x/state/hold.stop', hold: 7200, scale: 10, config: { council: { period: 24, offset: 0, strike_lead: 6 }, time: { bell_secs: 600 } }, date: '2026-10-11' });
  const t = L.join('\n');
  assert.match(t, /RECORDING RUN \(live seat\), run ai-record-1/);
  assert.match(t, /council page\s+http:\/\/127\.0\.0\.1:41902\/council\.html\?recorded=2026-10-11/);
  assert.match(t, /map\s+http:\/\/127\.0\.0\.1:41902\/frontier\/frontier\/spectate\.html\?art=1/);
  assert.match(t, /presenter key\s+\/x\/keys\/presenter-key\.json/);
  assert.match(t, /pbcopy < \/x\/keys\/presenter-key\.json/);
  assert.match(t, /1 bell = 1 real minute\(s\) at 10x/);
  assert.match(t, /period 2: C0 bell 48 \(\+48 min\); motions bells 48-50; BALLOT WINDOW bells 51-53 \(bell 51 \(\+51 min\) to bell 54 \(\+54 min\)\); strike bell 60 \(\+60 min\); the order opens bell 62 \(\+62 min\)/);
  assert.match(t, /do not start the scripted seat/);
  assert.match(t, /touch \/x\/state\/hold\.stop/);
  assert.match(t, /at most 7200 s/);
  const short = infoLines({ runId: 'r', serve: 'http://127.0.0.1:41902', keys: '/x/keys', stopFile: '/x/state/hold.stop', hold: 0, urlsOnly: true }).join('\n');
  assert.doesNotMatch(short, /timeline/);
  assert.match(short, /no --hold was given/);
  // the wording keeps the honesty rule: the seat casts nothing, only the page ballot is the human one
  assert.match(t, /only your ballot on the page counts as the live human ballot/);
});
