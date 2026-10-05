// AC9: the A/B harness (contract 9.3): the threshold T, the seat key and ballot, the seat loop against the REAL social service
// (AC4's createSocial, with AC4's test kit for the herald and the clock), arm readers, the pre-registered pair rules and the
// pass rule, the council replay proxy (arm B), the plan. No model and no stack: the chain facts the seat would read from the
// herald are a fake clash detail, labelled so where it is made.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { decodeBallot, fromBase64, motionRef, toBase58, toBase64, toHex } from '../../permutation-server/web/frontier/council/aisocial.mjs';
import { createSocial } from '../citizens/social/routes.mjs';
import { candidatesHash, optionsHash } from '../citizens/social/council.mjs';
import { buildAnswerSchema, validateShape } from '../citizens/mind/schema.mjs';
import { OPTIONS, SEASON, builders, fakeHerald, makeCitizen, makeClock, tmpAiDir } from './fixtures/ai-social-kit.mjs';
import { aiMotionOption, ballotOption, buildSeatBallot, loadSeatKey, runSeat, summariseClash } from '../citizens/ab/seat.mjs';
import { abOutcome, armAPass, armBPass, armPlan, computeT, evaluatePair, pairValidity, readArm, renderAbResult } from '../citizens/ab/run-ab.mjs';
import { createReplayProxy, identifyCouncilJob, loadReplayTable, makeArmBConfig, replayedContent } from '../citizens/ab/replay.mjs';

const CFG = { council: { period: 24, offset: 0, strike_lead: 6, human_present: true } };
const K = 2;
const C0 = 48;
const CH = candidatesHash(OPTIONS);

test('T = min(3, the ready invited hosts the pilot saw), never below 2', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(computeT), [2, 2, 2, 3, 3, 3]);
  assert.equal(computeT(NaN), 2);
  assert.equal(computeT(2.9), 2);
});

// ---- the seat key and ballot ---------------------------------------------------------------------------------------------
function seatKeyFile(dir, citizen) {
  const file = join(dir, 'seat.txt');
  const kp = new Uint8Array(64);
  kp.set(citizen.key.seed, 0);
  kp.set(citizen.key.pub, 32);
  writeFileSync(file, JSON.stringify({ index: 1012, wallet: citizen.b58, wallet_keypair_b58: 'unused', session: toBase58(citizen.key.pub), session_keypair_b58: toBase58(kp) }));
  return file;
}

test('loadSeatKey: reads the session seed, checks it against the listed public key, signs ed25519', () => {
  const dir = tmpAiDir();
  const seat = makeCitizen('seat', { faction: 0 });
  const key = loadSeatKey(seatKeyFile(dir.dir, seat));
  const sig = key.sign(Buffer.from('hello'));
  const pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(seat.key.pub)]), format: 'der', type: 'spki' });
  assert.equal(crypto.verify(null, Buffer.from('hello'), pub, sig), true);
  assert.equal(key.wallet, seat.b58);
  // a key file whose seed is not the listed session key is refused
  const bad = join(dir.dir, 'bad.txt');
  writeFileSync(bad, JSON.stringify({ wallet: seat.b58, session: toBase58(new Uint8Array(32).fill(7)), session_keypair_b58: JSON.parse(readFileSync(join(dir.dir, 'seat.txt'), 'utf8')).session_keypair_b58 }));
  assert.throws(() => loadSeatKey(bad), /does not give the listed session public key/);
  dir.dispose();
});

test('the seat ballot: origin 2 (scripted), nation 0, this period\'s candidates_hash; arm A casts X, arm B casts none', async () => {
  const dir = tmpAiDir();
  const seat = makeCitizen('seat', { faction: 0 });
  const key = loadSeatKey(seatKeyFile(dir.dir, seat));
  assert.equal(ballotOption('A', 2), 2);
  assert.equal(ballotOption('B', 2), 0);
  const body = await buildSeatBallot({ key, season: SEASON, state: { period: K, candidates_hash: CH }, option: 2, nonce: new Uint8Array(16).fill(5) });
  const d = decodeBallot(fromBase64(body.bytes_b64));
  assert.deepEqual([d.origin, d.faction, d.option, d.period, toHex(d.candidates_hash)], [2, 0, 2, K, CH]);
  assert.equal(toBase58(d.wallet), seat.b58);
  assert.equal(body.sig_b64.length > 80, true);
  dir.dispose();
});

test('aiMotionOption: the first motion of an AI of the roster; a human or script motion is not X', () => {
  const aiW = new Set(['AIW']);
  assert.deepEqual(aiMotionOption({ motions: [{ wallet: 'H', option: 1, ai_roster: false }, { wallet: 'AIW', option: 3, ai_roster: true }, { wallet: 'AIX', option: 1, ai_roster: true }] }, aiW), { option: 3, wallet: 'AIW', tag: null });
  assert.equal(aiMotionOption({ motions: [{ wallet: 'H', option: 1 }] }, aiW), null);
  assert.equal(aiMotionOption({ motions: [{ wallet: 'AIW', option: 0, ai_roster: true }] }, aiW), null, 'option 0 is no motion for X');
});

test('summariseClash: present, bounced, own and enemy losses by faction; no report is a distinct answer', () => {
  const detail = { engagements: 3, fighters: [
    { faction: 0, arrival: true, engaged: true, fate: 'Stays', lost: 30 }, { faction: 0, arrival: true, engaged: false, fate: 'Bounced', lost: 0 },
    { faction: 3, arrival: false, engaged: true, fate: 'Destroyed', lost: 120 }, { faction: null, arrival: false, engaged: true, fate: 'Stays', lost: 9 },
  ] };
  assert.deepEqual(summariseClash(detail), { clash_report: true, engagements: 3, present: 2, bounced: 1, engaged_own: 1, own_lost: 30, enemy_lost: 120, nation0_involved: true, unknown_owner_fighters: 1 });
  assert.deepEqual(summariseClash(null), { clash_report: false, engagements: 0, present: 0, bounced: 0, engaged_own: 0, own_lost: 0, enemy_lost: 0, nation0_involved: false });
});

// ---- the seat loop against the real social service, both arms ------------------------------------------------------------
async function runArmWorld(arm, { aiMotion = 2, observed = null, aiBallotOption = 2, strange = false } = {}) {
  const clock = makeClock({ bell: C0 });
  const dir = tmpAiDir();
  const cits = { ai0: makeCitizen('ai0', { faction: 0 }), ai1: makeCitizen('ai1', { faction: 0 }), seat: makeCitizen('seat', { faction: 0 }), ai2: makeCitizen('ai2', { faction: 2 }) };
  const herald = fakeHerald(Object.values(cits));
  const aiEntry = (c, i, f) => ({ index: 1000 + i, wallet: c.b58, tag: `${i}`.padStart(16, '0'), faction: f, persona: 'avenger', name: { en: `AI${i}`, ja: `AI${i}` } });
  const roster = { v: 1, season: SEASON, ai: [aiEntry(cits.ai0, 0, 0), aiEntry(cits.ai1, 1, 0), aiEntry(cits.ai2, 2, 2)], script: { wallets: [] }, seat: { index: 1012, wallet: cits.seat.b58, tag: 'bbbbbbbbbbbbbbb0', faction: 0, scripted: true } };
  mkdirSync(join(dir.dir, 'pub'), { recursive: true });
  writeFileSync(join(dir.dir, 'pub/roster.json'), JSON.stringify(roster));
  const outputs = new Map();
  const social = createSocial({ herald, aiDir: dir.dir, roster, clock, provenance: (id, item, type) => outputs.get(`${id}|${item}|${type}`) ?? null, config: CFG, season: SEASON, random: (n) => new Uint8Array(n).fill(0x11) });
  const b = builders(clock);
  social.council.open({ faction: 0, period: K, c0: C0, candidates: OPTIONS });
  let n = 0;
  const events = {
    // the AIs' council jobs of arm A or arm B (identical by construction): a motion in the window, two ballots in the ballot window
    49: async () => { const id = `md${n++}`; outputs.set(`${id}|0|talk`, { type: 'talk', bell: 49, text: 'Strike the camp together.' }); if (aiMotion) await social.book.submit('talk', b.talk(cits.ai0, { channel: 1, target: 0, kind: 1, ref: motionRef(K, aiMotion), origin: 1, text: 'Strike the camp together.' }, { decision_id: id, item: 0 }).body); },
    51: async () => { for (const c of [cits.ai0, cits.ai1]) { const id = `bd${n++}`; outputs.set(`${id}|0|ballot`, { type: 'ballot', bell: 51, option: aiBallotOption, period: K, faction: 0, candidates_hash: CH }); await social.book.submit('ballot', b.ballot(c, { period: K, option: aiBallotOption, candidates_hash: CH, origin: 1 }, { decision_id: id, item: 0 }).body); } },
    55: async () => { await social.tick(); if (social.council.memberCall(0, K) === null && social.council.publicState(0, K).adopted) social.council.seal(0, K, { tile: 5, invited: ['111', '222'] }); },
  };
  const getJson = async (url) => { const u = new URL(url); const r = await social.routes.dispatch({ method: 'GET', path: u.pathname, query: Object.fromEntries(u.searchParams), headers: {}, peer: '127.0.0.1' }); if (r.status !== 200) throw new Error(`${r.status}`); return r.body; };
  const postJson = async (url, body) => social.routes.dispatch({ method: 'POST', path: new URL(url).pathname, body: JSON.stringify(body), headers: {}, peer: '127.0.0.1' });
  const key = loadSeatKey(seatKeyFile(dir.dir, cits.seat));
  const seen = [];
  const log = await runSeat({
    arm, rep: 1, aiDir: dir.dir, social: 'http://127.0.0.1:1', key, config: CFG, getJson, postJson, bellNow: async () => clock.bell(), pollMs: 0, maxPolls: 60,
    sleep: async () => { clock.advance(1); const e = events[clock.bell()]; if (e) await e(); await social.tick(); },
    observeAt: async (p, q, bell) => { seen.push([p, q, bell]); return observed; },
  });
  await social.tick();
  return { log, dir, social, seen, clock };
}

const CLASH_OK = { engagements: 2, fighters: [{ faction: 0, arrival: true, engaged: true, fate: 'Stays', lost: 40 }, { faction: 0, arrival: true, engaged: true, fate: 'Stays', lost: 10 }, { faction: 0, arrival: true, engaged: true, fate: 'Stays', lost: 0 }, { faction: 3, arrival: false, engaged: true, fate: 'Destroyed', lost: 200 }] }; // FAKE chain facts for the test
const CLASH_NONE = null;

test('seat loop, arm A: ballots X at C0 + 4 with origin 2, the Strike Order is adopted, the seat observes the clash at S + 3', async () => {
  const w = await runArmWorld('A', { observed: CLASH_OK });
  const l = w.log;
  assert.equal(l.period, K);
  assert.equal(l.option_x, 2);
  assert.equal(l.ballot.option, 2);
  assert.equal(l.ballot.bell, C0 + 4, 'the ballot is cast at C0 + 4, inside the window [C0 + 3, C0 + 6)');
  assert.equal(l.ballot.ok, true);
  assert.equal(l.ballot.origin, 2);
  assert.deepEqual(w.seen, [[4, 0, C0 + 12]], 'the clash report asked for is at the option\'s province at S = C0 + 12 (option 2 is the camp at (4,0))');
  assert.equal(l.observed.s, C0 + 12);
  assert.equal(l.observed.observed_at_bell, C0 + 12 + 3);
  assert.equal(l.observed.present, 3);
  assert.equal(l.observed.enemy_lost, 200);
  const state = w.social.council.publicState(0, K);
  assert.equal(state.adopted, true, 'two AI ballots and the scripted seat ballot adopt option 2');
  assert.deepEqual(state.tally_split, { ai: 2, human: 0, scripted: 1 });
  assert.ok(existsSync(join(w.dir.dir, 'ab/seat-A-1.json')));
  assert.equal(JSON.stringify(l).includes('session_keypair'), false, 'the log never carries the key');
  w.dir.dispose();
});

test('seat loop, arm B: ballots none at the same bell; the seat is pivotal and the Strike Order is not adopted', async () => {
  const w = await runArmWorld('B', { observed: CLASH_NONE });
  assert.equal(w.log.ballot.option, 0);
  assert.equal(w.log.ballot.bell, C0 + 4);
  const state = w.social.council.publicState(0, K);
  assert.equal(state.adopted, false);
  assert.equal(state.reason, 'human_present', 'the winner has AI ballots only: the human-present rule refuses it');
  assert.equal(w.log.observed.clash_report, false);
  w.dir.dispose();
});

test('seat loop: a period where no AI of nation 0 moved an option is skipped and reported; the seat casts nothing', async () => {
  const w = await runArmWorld('A', { aiMotion: 0, observed: CLASH_OK });
  assert.equal(w.log.ballot, null);
  assert.equal(w.log.period, null);
  assert.equal(w.log.skipped_periods.length, 1);
  assert.match(w.log.skipped_periods[0].reason, /no AI citizen of nation 0 moved/);
  assert.match(w.log.notes.at(-1), /gave up/);
  w.dir.dispose();
});

// ---- the arm readers and the pair rules ------------------------------------------------------------------------------------
async function pairWorlds(over = {}) {
  const A = await runArmWorld('A', { observed: CLASH_OK, ...(over.A ?? {}) });
  const B = await runArmWorld('B', { observed: CLASH_NONE, ...(over.B ?? {}) });
  // arm A: the Strike Order opens at S + 2 (ballots' bytes become public); advance the arm A clock
  A.clock.set(C0 + 14);
  await A.social.tick();
  return { A, B, a: readArm({ aiDir: A.dir.dir, arm: 'A', rep: 1 }), b: readArm({ aiDir: B.dir.dir, arm: 'B', rep: 1 }) };
}

test('readArm: motions, opened ballots (decoded), the seat ballot by origin, the Call, the measures', async () => {
  const { a, b } = await pairWorlds();
  assert.equal(a.period, K);
  assert.equal(a.option_x, 2);
  assert.equal(a.options_hash, optionsHash(OPTIONS));
  assert.deepEqual(a.ai_motions.map((m) => [m.name, m.option]), [['AI0', 2]]);
  assert.deepEqual(a.ai_ballots.map((x) => [x.name, x.option, x.origin]), [['AI0', 2, 1], ['AI1', 2, 1]]);
  assert.deepEqual(a.seat_ballot, { option: 2, origin: 2, from: 'opened ballot bytes' });
  assert.equal(a.adopted, true);
  assert.equal(a.call_option, 2);
  assert.equal(a.measures.source, 'seat observation (herald clash report)');
  assert.equal(a.measures.present, 3);
  assert.deepEqual(b.seat_ballot, { option: 0, origin: 2, from: 'opened ballot bytes' }, 'arm B: the ballots were opened at the close (no Call)');
  assert.equal(b.adopted, false);
  assert.deepEqual(a.motions_equal_top_option, [false]);
});

test('a valid pair that passes: equal options_hash, same AI motion and ballot options, the seat pivotal, Call X with T hosts present and a clash; B none of it', async () => {
  const { a, b } = await pairWorlds();
  const p = evaluatePair(a, b, 3);
  assert.equal(p.valid, true, JSON.stringify(p.validity.reasons));
  assert.equal(p.pass, true, JSON.stringify([p.arm_a.checks, p.arm_b.checks]));
  assert.deepEqual(p.validity.reasons, []);
  assert.equal(p.arm_a.checks.hosts_present_at_least_T, true);
  assert.equal(armAPass(a, 4).pass, false, 'T = 4 would not be met by 3 hosts present');
  assert.equal(armAPass(a, 4).checks.hosts_present_at_least_T, false);
});

test('pair validity: every pre-registered condition is a separate check (synthetic edits of real arm readings are labelled)', async () => {
  const { a, b } = await pairWorlds();
  const edit = (arm, f) => { const c = JSON.parse(JSON.stringify(arm)); f(c); return c; };
  // different options_hash: the pair is invalid
  let v = pairValidity(a, edit(b, (x) => { x.options_hash = 'f'.repeat(64); }));
  assert.equal(v.valid, false);
  assert.deepEqual(v.reasons, ['a_options_hash_equal']);
  // a different AI motion option
  v = pairValidity(a, edit(b, (x) => { x.ai_motions[0].option = 1; }));
  assert.deepEqual(v.reasons, ['a_same_ai_motion_option']);
  // a different AI ballot option
  v = pairValidity(a, edit(b, (x) => { x.ai_ballots[1].option = 3; }));
  assert.deepEqual(v.reasons, ['a_same_ai_ballot_options']);
  // arm B adopted X: the seat was not pivotal
  v = pairValidity(a, edit(b, (x) => { x.adopted = true; x.call_option = 2; }));
  assert.deepEqual(v.reasons, ['b_seat_pivotal_x_not_adopted_in_b']);
  // the seat did not ballot as designed
  v = pairValidity(a, edit(b, (x) => { x.seat_ballot_ok = false; }));
  assert.deepEqual(v.reasons, ['seat_ballots_cast_as_designed']);
  // a different period
  v = pairValidity(a, edit(b, (x) => { x.period = 3; }));
  assert.ok(v.reasons.includes('a_same_period'));
  // the candidates_hash may differ: reported, not required
  v = pairValidity(a, edit(b, (x) => { x.candidates_hash = 'e'.repeat(64); }));
  assert.equal(v.valid, true);
  assert.equal(v.candidates_hash_equal, false);
  assert.match(v.candidates_hash_note, /not required/);
  // text hashes are not compared
  v = pairValidity(a, edit(b, (x) => { x.ai_motions[0].text = 'another speech'; }));
  assert.equal(v.valid, true);
});

test('the pass rule: arm A needs Call X, >= T hosts present and a clash with an engagement and enemy loss; arm B needs no Call X, 0 present and no nation-0 clash', async () => {
  const { a, b } = await pairWorlds();
  const edit = (arm, f) => { const c = JSON.parse(JSON.stringify(arm)); f(c); return c; };
  assert.equal(armAPass(edit(a, (x) => { x.measures.enemy_lost = 0; }), 2).checks.clash_with_engagement_and_enemy_loss, false);
  assert.equal(armAPass(edit(a, (x) => { x.measures.engagements = 0; }), 2).pass, false);
  assert.equal(armAPass(edit(a, (x) => { x.adopted = false; x.call_option = null; }), 2).checks.call_is_x, false);
  assert.equal(armAPass(edit(a, (x) => { x.measures = null; }), 2).pass, false, 'no observation is no pass');
  assert.equal(armBPass(b, 2).pass, true);
  assert.equal(armBPass(edit(b, (x) => { x.measures.present = 1; }), 2).checks.zero_hosts_of_nation_0_arrive_at_x, false);
  assert.equal(armBPass(edit(b, (x) => { x.measures.nation0_involved = true; }), 2).pass, false);
  assert.equal(armBPass(edit(b, (x) => { x.adopted = true; x.call_option = 2; }), 2).checks.no_call_x, false);
  const notObserved = armBPass(edit(b, (x) => { x.measures = null; }), 2);
  assert.equal(notObserved.pass, false);
  assert.equal(notObserved.not_observed, true);
});

test('the claim over reps: 2 valid pairs both pass = G7 met; 1 valid pair in 3 reps = the pre-registered reduced claim; otherwise not met or undecided', () => {
  const pr = (rep, valid, pass) => ({ rep, valid, pass });
  assert.equal(abOutcome([pr(1, true, true), pr(2, true, true)]).claim.kind, 'pass');
  assert.equal(abOutcome([pr(1, true, true), pr(2, false, false), pr(3, true, true)]).claim.kind, 'pass');
  assert.equal(abOutcome([pr(1, true, true), pr(2, true, false)]).claim.kind, 'fail');
  assert.equal(abOutcome([pr(1, true, true), pr(2, false, false)]).claim.kind, 'incomplete');
  assert.equal(abOutcome([pr(1, true, true), pr(2, false, false), pr(3, false, false)]).claim.kind, 'reduced');
  assert.equal(abOutcome([pr(1, true, false), pr(2, false, false), pr(3, false, false)]).claim.kind, 'fail');
  assert.equal(abOutcome([pr(1, false, false), pr(2, false, false), pr(3, false, false)]).claim.kind, 'fail');
  const o = abOutcome([pr(1, true, true), pr(2, true, true), pr(3, true, false)]);
  assert.deepEqual(o.pairs_used, [1, 2], 'stop at 2 valid pairs: a third is reported, not used');
});

test('AB-RESULT table: scripted seat wording, T, every rep, replay counts, and no claim of humans deciding', async () => {
  const { a, b } = await pairWorlds();
  const pair = evaluatePair(a, b, 3);
  const md = renderAbResult({ pairs: [pair], T: 3, outcome: abOutcome([pair]), runs: [{ run_id: 'ai-ab-A-1', arm: 'A', rep: 1, status: 'complete', detail: 'x' }] });
  for (const must of ['Local test chain only', 'operator-scripted seat ballot', 'Nation 0 only', 'T = 3', 'ai-ab-A-1', 'replays arm A', 'pre-registered']) assert.ok(md.includes(must), must);
  assert.equal(/humans and AI (citizens )?decide together/.test(md.replace('not that humans and AI citizens decide together', '')), false);
});

// ---- the replay proxy (arm B) ------------------------------------------------------------------------------------------------
function councilBody({ name = 'AI0', kind = 'motion', options = OPTIONS }) {
  const spec = { kind, goalIds: ['G1', 'G2'], candidateIds: [], handles: [], who: ['N0'], direct: [], channels: ['nation'], maxSay: kind === 'motion' ? 1 : 0, motionOptions: [0, 1, 2, 3], ballotOptions: [0, 1, 2, 3] };
  const schema = buildAnswerSchema(spec);
  const lines = options.map((o) => `  option ${o.option}: ${o.kind} at (${o.p},${o.q}), ${o.ratio} (estimate)`);
  return {
    model: 'gemma-4-26b-a4b-it',
    messages: [{ role: 'system', content: `You are ${name}, a citizen of nation 0 in "Wylls", a hex-map strategy game on a local test chain.` }, { role: 'user', content: `NOW: bell 50\n\nCOUNCIL (your nation, motions): options for this period:\n${lines.join('\n')}\n  this window closes at bell 54.\n\nTASK: x` }],
    temperature: 0, response_format: { type: 'json_schema', json_schema: { name: kind, strict: true, schema } }, spec,
  };
}

test('identifyCouncilJob: the AI, the kind and the options_hash the social service computes; other jobs are not council jobs', () => {
  const j = identifyCouncilJob(councilBody({}));
  assert.deepEqual([j.name, j.kind, j.options_hash], ['AI0', 'motion', optionsHash(OPTIONS)]);
  const sess = councilBody({});
  sess.response_format.json_schema.name = 'session';
  assert.equal(identifyCouncilJob(sess), null);
  assert.equal(identifyCouncilJob({ messages: [] }), null);
  const noOpts = councilBody({ options: [] });
  assert.equal(identifyCouncilJob(noOpts), null);
});

test('replayedContent fits the request schema (V1) for a motion with speech and for a ballot, and is refused when the option is not allowed', () => {
  const m = councilBody({});
  const content = replayedContent(identifyCouncilJob(m), { option: 2, text: 'Strike the camp together.' });
  const v = validateShape(JSON.parse(content), m.spec);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.deepEqual(v.value.council, { motion: 2 });
  assert.equal(v.value.say[0].text, 'Strike the camp together.');
  const bb = councilBody({ kind: 'ballot' });
  const vb = validateShape(JSON.parse(replayedContent(identifyCouncilJob(bb), { option: 2 })), bb.spec);
  assert.equal(vb.ok, true, JSON.stringify(vb.errors));
  assert.deepEqual(vb.value.council, { ballot: 2 });
  assert.equal(vb.value.say.length, 0);
  assert.equal(replayedContent(identifyCouncilJob(m), { option: 9, text: '' }), null);
});

test('the replay proxy: arm A\'s motion and ballots of nation 0 are answered without the model; everything else, and an unknown job, goes to llama', async () => {
  const A = await runArmWorld('A', { observed: CLASH_OK });
  A.clock.set(C0 + 14);
  await A.social.tick();
  const pub = join(A.dir.dir, 'pub');
  const { table } = loadReplayTable(pub);
  assert.deepEqual([...table.keys()].sort(), [`AI0|ballot|${optionsHash(OPTIONS)}`, `AI0|motion|${optionsHash(OPTIONS)}`, `AI1|ballot|${optionsHash(OPTIONS)}`]);
  assert.equal(table.get(`AI0|motion|${optionsHash(OPTIONS)}`).text, 'Strike the camp together.');
  // a fake llama
  const hits = [];
  const llama = http.createServer((req, res) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => { hits.push(`${req.method} ${req.url}`); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(req.url === '/props' ? { model_alias: 'gemma-4-26b-a4b-it' } : { choices: [{ finish_reason: 'stop', message: { content: '{"from":"llama"}' } }] })); }); });
  await new Promise((r) => llama.listen(0, '127.0.0.1', r));
  const log = join(A.dir.dir, 'ab/replay-B-1.json');
  const proxy = createReplayProxy({ from: pub, upstream: `http://127.0.0.1:${llama.address().port}`, log });
  const { port } = await proxy.listen(0, { test: true });
  const post = async (body) => (await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  const r1 = await post(councilBody({ name: 'AI0', kind: 'motion' }));
  assert.deepEqual(JSON.parse(r1.choices[0].message.content).council, { motion: 2 });
  assert.equal(r1.system_fingerprint, 'ab-replay');
  const r2 = await post(councilBody({ name: 'AI1', kind: 'ballot' }));
  assert.deepEqual(JSON.parse(r2.choices[0].message.content).council, { ballot: 2 });
  assert.equal(hits.length, 0, 'no call reached llama');
  // an AI arm A has no answer for (AI1 never moved), and a different options_hash
  const r3 = await post(councilBody({ name: 'AI1', kind: 'motion' }));
  assert.equal(JSON.parse(r3.choices[0].message.content).from, 'llama');
  const r4 = await post(councilBody({ name: 'AI0', kind: 'motion', options: OPTIONS.map((o) => ({ ...o, p: o.p + 1 })) }));
  assert.equal(JSON.parse(r4.choices[0].message.content).from, 'llama');
  // sessions, /props
  const sess = councilBody({}); sess.response_format.json_schema.name = 'session';
  assert.equal(JSON.parse((await post(sess)).choices[0].message.content).from, 'llama');
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/props`)).json()).model_alias, 'gemma-4-26b-a4b-it');
  const st = proxy.stats();
  assert.equal(st.council_replayed, 2);
  assert.equal(st.miss.length, 2);
  assert.equal(st.passed_through, 4);
  const saved = JSON.parse(readFileSync(log, 'utf8'));
  assert.equal(saved.council_replayed, 2, 'the replay count is written for the A/B table');
  await proxy.close();
  await new Promise((r) => llama.close(r));
  A.dir.dispose();
});

test('the replay proxy refuses a non-loopback upstream and a port outside the AI window; arm B\'s config names the proxy and arm A\'s PUB', () => {
  assert.throws(() => createReplayProxy({ from: '/nonexistent', upstream: 'http://203.0.113.9:41901' }), /not 127\.0\.0\.1/);
  const p = createReplayProxy({ from: '/nonexistent', upstream: 'http://127.0.0.1:41901' });
  assert.throws(() => p.listen(4190), /outside 41901-41999/);
  const dir = tmpAiDir();
  const out = join(dir.dir, 'ab-B-1.json');
  makeArmBConfig({ baseConfigPath: new URL('../citizens/config/ab.json', import.meta.url).pathname, armAPub: '/x/pub', shimUrl: 'http://127.0.0.1:41990', outPath: out });
  const cfg = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(cfg.replay_council_from, '/x/pub');
  assert.equal(cfg.llm.url, 'http://127.0.0.1:41990');
  assert.equal(cfg.llm.alias, 'gemma-4-26b-a4b-it');
  assert.equal(cfg.council.period, 24);
  assert.throws(() => makeArmBConfig({ baseConfigPath: out, armAPub: '/x', shimUrl: 'http://203.0.113.9:1', outPath: out }), /not 127\.0\.0\.1/);
  dir.dispose();
});

test('plan: arm A is the run script with --ab A --rep N; arm B writes its config, starts the proxy on 41990 and runs the script with it', () => {
  const root = '/repo';
  const a = armPlan({ arm: 'A', rep: 2, repoRoot: root });
  assert.equal(a.run_id, 'ai-ab-A-2');
  assert.deepEqual(a.run.slice(0, 2), ['bash', '/repo/permutation-gateway/citizens/bin/ai-citizens-run.sh']);
  assert.ok(a.run.join(' ').includes('--ab A --rep 2'));
  assert.ok(a.run.join(' ').includes('--seat-script /repo/permutation-gateway/citizens/ab/seat.mjs'), 'the seat script is named in the commitments, so the roster marks the seat scripted');
  assert.ok(a.run.join(' ').includes('config/ab.json'));
  const b = armPlan({ arm: 'B', rep: 2, repoRoot: root });
  assert.ok(b.run.join(' ').includes('ab-config/ab-B-2.json'));
  assert.equal(b.steps.length, 4);
  assert.match(b.steps[0], /replay_council_from \/repo\/\.local\/frontier\/ai\/ai-ab-A-2\/pub/);
  assert.match(b.steps[1], /41990/);
  // the CLI plan prints without starting anything
  const r = spawnSync(process.execPath, [new URL('../citizens/ab/run-ab.mjs', import.meta.url).pathname, 'plan', '--rep', '1'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).A.run_id, 'ai-ab-A-1');
  const t = spawnSync(process.execPath, [new URL('../citizens/ab/run-ab.mjs', import.meta.url).pathname, 'threshold', '--ready', '5'], { encoding: 'utf8' });
  assert.equal(JSON.parse(t.stdout).T, 3);
  assert.equal(spawnSync(process.execPath, [new URL('../citizens/ab/run-ab.mjs', import.meta.url).pathname, 'nonsense'], { encoding: 'utf8' }).status, 2);
});

// ---- pilot seam: a period in which the seat cannot vote must not use up the seat's one A/B ballot ---------------------------------
async function runIneligibleWorld({ postFails = 0 } = {}) {
  const clock = makeClock({ bell: C0 });
  const dir = tmpAiDir();
  const cits = { ai0: makeCitizen('ai0', { faction: 0 }), seat: makeCitizen('seat', { faction: 0 }) };
  const herald = fakeHerald(Object.values(cits));
  const roster = { v: 1, season: SEASON, ai: [{ index: 1000, wallet: cits.ai0.b58, tag: '0'.padStart(16, '0'), faction: 0, persona: 'avenger', name: { en: 'AI0', ja: 'AI0' } }], script: { wallets: [] }, seat: { index: 1012, wallet: cits.seat.b58, tag: 'bbbbbbbbbbbbbbb0', faction: 0, scripted: true } };
  mkdirSync(join(dir.dir, 'pub'), { recursive: true });
  writeFileSync(join(dir.dir, 'pub/roster.json'), JSON.stringify(roster));
  const outputs = new Map();
  const social = createSocial({ herald, aiDir: dir.dir, roster, clock, provenance: (id, item, type) => outputs.get(`${id}|${item}|${type}`) ?? null, config: CFG, season: SEASON, random: (n) => new Uint8Array(n).fill(0x11) });
  const b = builders(clock);
  // period K: the seat's village is not final at C0 (it is not on the eligible list); period K + 1: it is
  social.council.open({ faction: 0, period: K, c0: C0, candidates: OPTIONS, eligible: [cits.ai0.b58] });
  const C1 = C0 + 24;
  let n = 0;
  const motion = async (period, bell) => { const id = `m${n++}`; outputs.set(`${id}|0|talk`, { type: 'talk', bell, text: 'Strike the camp together.' }); await social.book.submit('talk', b.talk(cits.ai0, { channel: 1, target: 0, kind: 1, ref: motionRef(period, 2), origin: 1, text: 'Strike the camp together.' }, { decision_id: id, item: 0 }).body); };
  const events = {
    [C0 + 1]: () => motion(K, C0 + 1),
    [C1]: async () => { social.council.open({ faction: 0, period: K + 1, c0: C1, candidates: OPTIONS, eligible: [cits.ai0.b58, cits.seat.b58] }); },
    [C1 + 1]: () => motion(K + 1, C1 + 1),
  };
  const getJson = async (url) => { const u = new URL(url); const r = await social.routes.dispatch({ method: 'GET', path: u.pathname, query: Object.fromEntries(u.searchParams), headers: {}, peer: '127.0.0.1' }); if (r.status !== 200) throw new Error(`${r.status}`); return r.body; };
  let fails = postFails;
  const postJson = async (url, body) => { if (fails > 0 && clock.bell() >= C1) { fails--; throw new Error('connection reset'); } return social.routes.dispatch({ method: 'POST', path: new URL(url).pathname, body: JSON.stringify(body), headers: {}, peer: '127.0.0.1' }); };
  const key = loadSeatKey(seatKeyFile(dir.dir, cits.seat));
  const log = await runSeat({
    arm: 'A', rep: 1, aiDir: dir.dir, social: 'http://127.0.0.1:1', key, config: CFG, getJson, postJson, bellNow: async () => clock.bell(), pollMs: 0, maxPolls: 80,
    sleep: async () => { clock.advance(1); const e = events[clock.bell()]; if (e) await e(); await social.tick(); },
    observeAt: async () => null,
  });
  return { log, dir, social };
}

test('seat loop: a NotEligible refusal marks the period untestable and the ballot goes to the next period with an AI motion', async () => {
  const w = await runIneligibleWorld();
  assert.equal(w.log.ineligible_periods.length, 1);
  assert.equal(w.log.ineligible_periods[0].period, K);
  assert.equal(w.log.ineligible_periods[0].code, 'NotEligible');
  assert.match(w.log.skipped_periods[0].reason, /seat was not eligible/);
  assert.equal(w.log.period, K + 1, 'the ballot was cast in the next period');
  assert.equal(w.log.ballot.ok, true);
  assert.equal(w.log.ballot.bell, C0 + 24 + 4);
  assert.equal(w.log.ballot.origin, 2);
  assert.equal(w.log.option_x, 2);
  w.dir.dispose();
});

test('seat loop: a lost post (network error) is retried while the ballot window lasts, not counted as the seat\'s ballot', async () => {
  const w = await runIneligibleWorld({ postFails: 1 });
  assert.equal(w.log.ineligible_periods.length, 1, 'the first period is still the untestable one');
  assert.equal(w.log.ballot.ok, true, 'one lost post, then the ballot landed');
  assert.ok(w.log.ballot_retries >= 1);
  assert.ok(w.log.ballot.bell < C0 + 24 + 6, 'inside the ballot window');
  w.dir.dispose();
});
