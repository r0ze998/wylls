// Seat ballot fix (owner decision 2026-10-04; contract 6.5, 9.2, 9.3; integ-B-NOTES.md "seat ballot fix"): the council script of
// citizens/ab/seat.mjs runs against the REAL social service (createSocial, the AC4 test kit) in process. No stack, no model.
// What each test pins, and why it fails on the old seat.mjs:
//  - the old file has no council script at all (it ballots only after an AI of nation 0 moved an option, in A/B arms), and its poll
//    budget was a count of 400 polls, so a seat started in preseason had given up before period 2.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { motionRef, toBase58 } from '../../permutation-server/web/frontier/council/aisocial.mjs';
import { createSocial } from '../citizens/social/routes.mjs';
import { candidatesHash } from '../citizens/social/council.mjs';
import { OPTIONS, SEASON, builders, fakeHerald, makeCitizen, makeClock, tmpAiDir } from './fixtures/ai-social-kit.mjs';
import * as seat from '../citizens/ab/seat.mjs';

const CFG = { council: { period: 24, offset: 0, strike_lead: 6, human_present: true } };
const C0 = 48;
const CH = candidatesHash(OPTIONS);
const OPT_RATIO = [
  { option: 1, kind: 'strike', p: 3, q: -1, value: 220, own: 480, ratio: 'even' },
  { option: 2, kind: 'camp', p: 4, q: 0, value: 120, own: 300, ratio: 'favourable' },
  { option: 3, kind: 'raid', p: 2, q: 2, value: 400, own: 700, ratio: 'favourable' },
];
const HASH_OF = new Map([[OPTIONS, CH], [OPT_RATIO, candidatesHash(OPT_RATIO)]]);

function seatKeyFile(dir, citizen) {
  const file = join(dir, 'seat.txt');
  const kp = new Uint8Array(64);
  kp.set(citizen.key.seed, 0);
  kp.set(citizen.key.pub, 32);
  writeFileSync(file, JSON.stringify({ index: 1012, wallet: citizen.b58, wallet_keypair_b58: 'unused', session: toBase58(citizen.key.pub), session_keypair_b58: toBase58(kp) }));
  return file;
}

/**
 * One world: the real social service in process, nation 0 (ai0 [ai1 when `twoAis`] and the seat) and nation 2 (ai2).
 * Bells advance once every `pollsPerBell` polls (a poll is one `sleep`), so a long preseason is a long poll count.
 * `plan`: { open: {bell: [{faction, period, c0, candidates}]}, ai: {bell: [{who, option, period, candidates}]}, motion: {bell: [{who, option, period}]} }.
 */
function world({ startBell = 40, pollsPerBell = 1, plan, twoAis = false } = {}) {
  const clock = makeClock({ bell: startBell });
  const dir = tmpAiDir('seatfix-');
  const cits = { ai0: makeCitizen('ai0', { faction: 0 }), ai1: makeCitizen('ai1', { faction: 0 }), seat: makeCitizen('seat', { faction: 0 }), ai2: makeCitizen('ai2', { faction: 2 }) };
  const herald = fakeHerald(Object.values(cits));
  const aiEntry = (c, i, f) => ({ index: 1000 + i, wallet: c.b58, tag: `${i}`.padStart(16, '0'), faction: f, persona: 'avenger', name: { en: `AI${i}`, ja: `AI${i}` } });
  const ais = twoAis ? [aiEntry(cits.ai0, 0, 0), aiEntry(cits.ai1, 1, 0), aiEntry(cits.ai2, 2, 2)] : [aiEntry(cits.ai0, 0, 0), aiEntry(cits.ai2, 2, 2)];
  const roster = { v: 1, season: SEASON, ai: ais, script: { wallets: [] }, seat: { index: 1012, wallet: cits.seat.b58, tag: 'bbbbbbbbbbbbbbb0', faction: 0, scripted: true } };
  mkdirSync(join(dir.dir, 'pub'), { recursive: true });
  writeFileSync(join(dir.dir, 'pub/roster.json'), JSON.stringify(roster));
  const outputs = new Map();
  const social = createSocial({ herald, aiDir: dir.dir, roster, clock, provenance: (id, item, type) => outputs.get(`${id}|${item}|${type}`) ?? null, config: CFG, season: SEASON, random: (n) => new Uint8Array(n).fill(0x11) });
  const b = builders(clock);
  let n = 0;
  const w = { clock, dir, cits, social, herald, polls: 0, posts: [] };
  const aiBallot = async ({ who, option, period, candidates = OPTIONS }) => {
    const c = cits[who];
    const id = `bd${n++}`;
    outputs.set(`${id}|0|ballot`, { type: 'ballot', bell: clock.bell(), option, period, faction: c.faction, candidates_hash: HASH_OF.get(candidates) });
    return social.book.submit('ballot', b.ballot(c, { period, option, candidates_hash: HASH_OF.get(candidates), origin: 1 }, { decision_id: id, item: 0 }).body);
  };
  const aiMotion = async ({ who, option, period }) => {
    const id = `md${n++}`;
    outputs.set(`${id}|0|talk`, { type: 'talk', bell: clock.bell(), text: 'Strike together.' });
    return social.book.submit('talk', b.talk(cits[who], { channel: 1, target: 0, kind: 1, ref: motionRef(period, option), origin: 1, text: 'Strike together.' }, { decision_id: id, item: 0 }).body);
  };
  const atBell = async () => {
    const bell = clock.bell();
    for (const o of plan?.open?.[bell] ?? []) social.council.open(o);
    for (const m of plan?.motion?.[bell] ?? []) await aiMotion(m);
    for (const x of plan?.ai?.[bell] ?? []) await aiBallot(x);
    await social.tick();
  };
  const getJson = async (url) => { const u = new URL(url); const r = await social.routes.dispatch({ method: 'GET', path: u.pathname, query: Object.fromEntries(u.searchParams), headers: {}, peer: '127.0.0.1' }); if (r.status !== 200) throw new Error(`${r.status}`); return r.body; };
  const postJson = async (url, body) => { w.posts.push({ url, bell: clock.bell() }); return social.routes.dispatch({ method: 'POST', path: new URL(url).pathname, body: JSON.stringify(body), headers: {}, peer: '127.0.0.1' }); };
  const sleep = async () => { w.polls++; if (w.polls % pollsPerBell === 0) { clock.advance(1); await atBell(); } };
  const common = { aiDir: dir.dir, social: 'http://127.0.0.1:1', key: seat.loadSeatKey(seatKeyFile(dir.dir, cits.seat)), config: CFG, getJson, postJson, bellNow: async () => clock.bell(), sleep, pollMs: 0 };
  Object.assign(w, {
    common,
    script: (over = {}) => seat.runSeatScript({ ...common, ...over }),
    ab: (arm, over = {}) => seat.runSeat({ ...common, arm, rep: 1, ...over }),
    start: () => atBell(),
    ballotsOf: () => seat.readJournalBallots(dir.dir),
    pub: () => JSON.parse(readFileSync(join(dir.dir, 'pub/seat/ballots.json'), 'utf8')),
  });
  return w;
}

const stopAfterBell = (w, bell) => () => w.clock.bell() >= bell;
const OPEN2 = { [C0]: [{ faction: 0, period: 2, c0: C0, candidates: OPTIONS }] };

test('a council with three options, one AI ballot and no motion: the scripted seat ballot follows the AI, quorum is reached and the human-present rule is satisfied', async () => {
  const w = world({ startBell: C0 - 2, plan: { open: OPEN2, ai: { [C0 + 3]: [{ who: 'ai0', option: 2, period: 2 }] } } });
  await w.start();
  const log = await w.script({ shouldStop: stopAfterBell(w, C0 + 7) });
  const st = w.social.council.publicState(0, 2);
  assert.equal(st.motions.length, 0, 'no AI motion was needed');
  assert.deepEqual(st.tally_split, { ai: 1, human: 0, scripted: 1 }, 'the seat ballot is counted as scripted, never as an AI or a live human');
  assert.equal(st.adopted, true, 'two ballots for option 2 reach quorum; the scripted ballot satisfies the human-present rule');
  assert.equal(st.reason, 'adopted');
  assert.equal(log.periods.length, 1);
  const p = log.periods[0];
  assert.equal(p.option, 2);
  assert.equal(p.rule, 'follow_ai_ballots');
  assert.equal(p.ok, true);
  assert.equal(p.origin, 2);
  assert.equal(p.bell, C0 + 3, 'it casts as soon as the nation-0 AI has voted');
  // the ballot in the service's journal is signed by the seat wallet, origin 2, nation 0
  const mine = w.ballotsOf().filter((x) => x.wallet === w.cits.seat.b58);
  assert.equal(mine.length, 1);
  assert.deepEqual({ origin: mine[0].origin, faction: mine[0].faction, option: mine[0].option, period: mine[0].period }, { origin: 2, faction: 0, option: 2, period: 2 });
  w.dir.dispose();
});

test('the log and the published seat record say the ballot is scripted; the option stays hidden until the period closes', async () => {
  const w = world({ startBell: C0 - 2, plan: { open: OPEN2, ai: { [C0 + 3]: [{ who: 'ai0', option: 2, period: 2 }] } } });
  await w.start();
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  let log;
  let midPub = null;
  try {
    log = await w.script({ shouldStop: () => { if (w.clock.bell() === C0 + 4 && !midPub) midPub = w.pub(); return w.clock.bell() >= C0 + 7; } });
  } finally { console.log = orig; }
  assert.equal(log.scripted, true);
  assert.match(log.ballot_label.en, /scripted seat ballot/);
  assert.match(log.never_live, /not "humans and AI decided together"/);
  assert.ok(lines.length >= 2 && lines.every((l) => /scripted seat ballot/.test(l)), `every log line says scripted: ${lines.join(' | ')}`);
  const saved = JSON.parse(readFileSync(join(w.dir.dir, 'seat/seat-script-log.json'), 'utf8'));
  assert.equal(saved.scripted, true);
  assert.equal(JSON.stringify(saved).includes('session_keypair'), false, 'the log never carries the key');
  assert.equal(midPub.scripted, true);
  assert.equal(midPub.origin, 2);
  assert.equal(midPub.ballots[0].scripted, true);
  assert.equal(midPub.ballots[0].option, null, 'an open period: the option is withheld');
  const pub = w.pub();
  assert.equal(pub.kind, 'seat-ballots');
  assert.equal(pub.scripted, true);
  assert.match(pub.label.en, /not a live human ballot/);
  assert.match(pub.statement, /scripted seat vote plus AI votes/);
  assert.equal(pub.ballots[0].option, 2, 'after the close the option is published');
  assert.equal(pub.ballots[0].rule, 'follow_ai_ballots');
  w.dir.dispose();
});

test('no AI ballot by the last ballot bell: the seat ballots the highest ratio word (ties the lowest option), counted scripted; one ballot is no quorum', async () => {
  const w = world({ startBell: C0 - 2, plan: { open: { [C0]: [{ faction: 0, period: 2, c0: C0, candidates: OPT_RATIO }] } } });
  await w.start();
  const log = await w.script({ shouldStop: stopAfterBell(w, C0 + 7) });
  assert.equal(log.periods[0].rule, 'highest_ratio_word');
  assert.equal(log.periods[0].option, 2, 'options 2 and 3 are both favourable; the lower number wins');
  assert.equal(log.periods[0].bell, C0 + 5, 'with no AI ballot the seat waits for the last ballot bell');
  const st = w.social.council.publicState(0, 2);
  assert.deepEqual(st.tally_split, { ai: 0, human: 0, scripted: 1 });
  assert.equal(st.adopted, false);
  assert.equal(st.reason, 'quorum');
  w.dir.dispose();
});

test('chooseScriptedOption: AI plurality, ties to the lowest option, none only when every AI cast none, the ratio rule otherwise', () => {
  const ai = (...o) => o.map((option, i) => ({ wallet: `w${i}`, option }));
  assert.equal(seat.chooseScriptedOption({ aiBallots: ai(3), options: OPTIONS }).option, 3);
  assert.equal(seat.chooseScriptedOption({ aiBallots: ai(3, 3, 1), options: OPTIONS }).option, 3);
  assert.equal(seat.chooseScriptedOption({ aiBallots: ai(2, 3), options: OPTIONS }).option, 2, 'a tie goes to the lower option');
  assert.equal(seat.chooseScriptedOption({ aiBallots: ai(0, 1), options: OPTIONS }).option, 1, 'none loses a tie');
  assert.equal(seat.chooseScriptedOption({ aiBallots: ai(0), options: OPTIONS }).option, 0, 'the AI chose none: the seat does not overrule it');
  const r = seat.chooseScriptedOption({ aiBallots: [], options: OPT_RATIO });
  assert.deepEqual({ option: r.option, rule: r.rule }, { option: 2, rule: 'highest_ratio_word' });
  assert.equal(seat.chooseScriptedOption({ aiBallots: [], options: [{ option: 1, ratio: 'unfavourable' }, { option: 2, ratio: 'even' }] }).option, 2);
  assert.equal(seat.chooseScriptedOption({ aiBallots: [], options: [] }), null);
});

test('with two AIs in nation 0 the seat waits for both and follows the majority', async () => {
  const w = world({ twoAis: true, startBell: C0 - 2, plan: { open: OPEN2, ai: { [C0 + 3]: [{ who: 'ai0', option: 3, period: 2 }], [C0 + 4]: [{ who: 'ai1', option: 3, period: 2 }] } } });
  await w.start();
  const log = await w.script({ shouldStop: stopAfterBell(w, C0 + 7) });
  assert.equal(log.periods[0].option, 3);
  assert.equal(log.periods[0].bell, C0 + 4, 'it waited for the second AI');
  const st = w.social.council.publicState(0, 2);
  assert.deepEqual(st.tally_split, { ai: 2, human: 0, scripted: 1 });
  assert.equal(st.adopted, true);
  w.dir.dispose();
});

test('a seat started in preseason still votes in period 2 after more than 400 poll intervals (the budget is game time, not a poll count)', async () => {
  // 10 polls per bell from bell 4: period 2 opens at bell 48 (440 polls), the AI ballots at 51, the seat votes right after
  const w = world({ startBell: 4, pollsPerBell: 10, plan: { open: OPEN2, ai: { [C0 + 3]: [{ who: 'ai0', option: 1, period: 2 }] } } });
  await w.start();
  const log = await w.script({ shouldStop: stopAfterBell(w, C0 + 7) });
  assert.ok(w.polls > 400, `polls ${w.polls}`);
  assert.equal(log.periods.length, 1);
  assert.equal(log.periods[0].ok, true);
  assert.ok(log.periods[0].bell >= C0 + 3);
  assert.equal(w.social.council.publicState(0, 2).adopted, true);
  assert.equal(log.notes.some((x) => /gave up/.test(x)), false);
  w.dir.dispose();
});

test('the A/B seat started in preseason also outlives 400 polls; the arm behaviour is unchanged (A: X at C0 + 4, B: none, no AI motion: skipped)', async () => {
  const plan = { open: OPEN2, motion: { [C0 + 1]: [{ who: 'ai0', option: 2, period: 2 }] }, ai: { [C0 + 3]: [{ who: 'ai0', option: 2, period: 2 }] } };
  const a = world({ startBell: 4, pollsPerBell: 10, plan });
  await a.start();
  const la = await a.ab('A', { shouldStop: stopAfterBell(a, C0 + 7) });
  assert.ok(a.polls > 400);
  assert.equal(la.ballot.option, 2);
  assert.equal(la.ballot.bell, C0 + 4, 'arm A: C0 + 4, as before');
  assert.equal(la.ballot.ok, true);
  assert.equal(la.scripted, true);
  assert.equal(a.pub().scripted, true, 'the A/B seat publishes the scripted record too');
  const b = world({ startBell: 4, pollsPerBell: 10, plan });
  await b.start();
  const lb = await b.ab('B', { shouldStop: stopAfterBell(b, C0 + 7) });
  assert.equal(lb.ballot.option, 0, 'arm B: none');
  const c = world({ startBell: C0 - 2, plan: { open: OPEN2 } });
  await c.start();
  const lc = await c.ab('A', { shouldStop: stopAfterBell(c, C0 + 7) });
  assert.equal(lc.ballot, null);
  assert.equal(lc.skipped_periods.length, 1);
  a.dir.dispose(); b.dir.dispose(); c.dir.dispose();
});

test('no double ballot in a period: one post over many polls, and a restarted seat does not vote again', async () => {
  const w = world({ startBell: C0 - 2, pollsPerBell: 3, plan: { open: OPEN2, ai: { [C0 + 3]: [{ who: 'ai0', option: 2, period: 2 }] } } });
  await w.start();
  await w.script({ shouldStop: stopAfterBell(w, C0 + 5) }); // stops inside the window, after the ballot
  assert.equal(w.posts.length, 1, 'one post for the period, not one per poll');
  assert.equal(w.social.council.publicState(0, 2).ballots_cast, 2);
  const again = await w.script({ shouldStop: stopAfterBell(w, C0 + 7) }); // a restart in the same period (a new process in real life)
  assert.equal(w.posts.length, 1, 'the restarted seat read its own ballot from the journal and posted nothing');
  assert.equal(again.periods.length, 0);
  assert.equal(w.social.council.publicState(0, 2).ballots_cast, 2);
  assert.equal(w.ballotsOf().filter((x) => x.wallet === w.cits.seat.b58).length, 1);
  w.dir.dispose();
});

test('a refused duplicate is final: the seat posts once, is refused, and does not retry', async () => {
  const w = world({ startBell: C0 - 2, plan: { open: OPEN2, ai: { [C0 + 3]: [{ who: 'ai0', option: 2, period: 2 }] } } });
  await w.start();
  // a ballot of the seat already stands, but this reader cannot see it (a journal that was lost): the service is the last line
  const first = await w.script({ shouldStop: stopAfterBell(w, C0 + 4) });
  assert.equal(first.periods[0].ok, true);
  const blind = (d) => seat.readJournalBallots(d).filter((x) => x.wallet !== w.cits.seat.b58);
  const log = await w.script({ readBallots: blind, shouldStop: stopAfterBell(w, C0 + 7) });
  assert.equal(w.posts.length, 2, 'one refused attempt, no retry loop');
  assert.equal(log.periods.length, 1);
  assert.equal(log.periods[0].ok, false);
  assert.ok(log.periods[0].status >= 400 && log.periods[0].status < 500);
  assert.equal(log.periods[0].attempts, 1);
  assert.equal(w.social.council.publicState(0, 2).ballots_cast, 2, 'the service still counts one seat ballot');
  w.dir.dispose();
});

test('every council period with options gets one scripted ballot (period 2 and period 3)', async () => {
  const w = world({
    startBell: C0 - 2,
    plan: { open: { [C0]: [{ faction: 0, period: 2, c0: C0, candidates: OPTIONS }], [C0 + 24]: [{ faction: 0, period: 3, c0: C0 + 24, candidates: OPT_RATIO }] }, ai: { [C0 + 3]: [{ who: 'ai0', option: 1, period: 2 }], [C0 + 27]: [{ who: 'ai0', option: 3, period: 3, candidates: OPT_RATIO }] } },
  });
  await w.start();
  const log = await w.script({ shouldStop: stopAfterBell(w, C0 + 31) });
  assert.deepEqual(log.periods.map((p) => [p.period, p.option, p.ok]), [[2, 1, true], [3, 3, true]]);
  assert.equal(w.posts.length, 2);
  assert.equal(w.social.council.publicState(0, 2).adopted, true);
  assert.equal(w.social.council.publicState(0, 3).adopted, true);
  w.dir.dispose();
});

test('a nation other than 0 is never touched: no post for a council of nation 2, and a council of nation 2 beside nation 0 gets no seat ballot', async () => {
  const w = world({ startBell: C0 - 2, plan: { open: { [C0]: [{ faction: 2, period: 2, c0: C0, candidates: OPTIONS }] }, ai: { [C0 + 3]: [{ who: 'ai2', option: 1, period: 2 }] } } });
  await w.start();
  const log = await w.script({ shouldStop: stopAfterBell(w, C0 + 7) });
  assert.equal(w.posts.length, 0, 'nation 0 has no council: the seat posts nothing');
  assert.equal(log.periods.length, 0);
  const s2 = w.social.council.publicState(2, 2);
  assert.deepEqual(s2.tally_split, { ai: 1, human: 0, scripted: 0 });
  assert.equal(s2.ballots_cast, 1);
  const v = world({ startBell: C0 - 2, plan: { open: { [C0]: [{ faction: 0, period: 2, c0: C0, candidates: OPTIONS }, { faction: 2, period: 2, c0: C0, candidates: OPTIONS }] }, ai: { [C0 + 3]: [{ who: 'ai0', option: 2, period: 2 }, { who: 'ai2', option: 2, period: 2 }] } } });
  await v.start();
  await v.script({ shouldStop: stopAfterBell(v, C0 + 7) });
  assert.deepEqual(v.social.council.publicState(2, 2).tally_split, { ai: 1, human: 0, scripted: 0 });
  assert.deepEqual(v.social.council.publicState(0, 2).tally_split, { ai: 1, human: 0, scripted: 1 });
  assert.equal(v.ballotsOf().filter((x) => x.wallet === v.cits.seat.b58 && x.faction !== 0).length, 0);
  assert.equal(v.posts.length, 1);
  w.dir.dispose(); v.dir.dispose();
});

test('the loop ends with the run (stop signal, end bell) and waits without throwing while the roster, the bell or the period does not exist yet', async () => {
  const w = world({ startBell: 4 });
  // preseason, before genesis: the herald gives no bell, the roster has no season yet
  writeFileSync(join(w.dir.dir, 'pub/roster.json'), JSON.stringify({ v: 1, ai: [] }));
  let n = 0;
  const l1 = await w.script({ bellNow: async () => null, sleep: async () => {}, shouldStop: () => ++n > 700 });
  assert.equal(l1.periods.length, 0);
  assert.match(l1.notes.at(-1), /stop file or signal/);
  assert.ok(n > 700, 'more than 700 polls without giving up');
  w.clock.set(10);
  const l2 = await w.script({ endBell: 60, shouldStop: () => false, sleep: async () => { w.clock.advance(1); } });
  assert.match(l2.notes.at(-1), /run ended: bell 60 reached the end bell 60/);
  const l3 = await w.script({ maxPolls: 5, sleep: async () => {}, shouldStop: () => false });
  assert.match(l3.notes.at(-1), /gave up after 5 polls/);
  w.dir.dispose();
});

test('the run script passes the stop file and starts the seat process for a run that names a seat script', () => {
  assert.equal(seat.STOP_FILE_NAME, 'seat.stop');
  const sh = readFileSync(new URL('../citizens/bin/ai-citizens-run.sh', import.meta.url), 'utf8');
  assert.match(sh, /--stop-file "\$STATE\/seat\.stop"/);
  assert.match(sh, /if \[ -n "\$AB" \] \|\| \[ -n "\$SEAT_SCRIPT" \]/);
  assert.equal(existsSync(new URL('../citizens/ab/seat.mjs', import.meta.url)), true);
});
