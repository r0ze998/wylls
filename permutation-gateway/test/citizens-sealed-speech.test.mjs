// A SEALED decision (one that sends a march) posts nothing to the talk channel before its release, and after the release its say and why
// are published correctly (contract 6.2 rule 4, 7.2, 7.3 M8).
//
// Why this file exists: the recorded run take-2 (code aae47bdb) failed verify-minds M8 with one `sealed_decision_posted`. The talk record
// filed under the sealed decision was not that decision's own `say` (the mind withheld it; it first appeared in PUB/open/30.json): it was a
// COUNCIL MOTION of another, unsealed record of the same AI and turn, which the watcher's outbox carrier (watcher/outbox.mjs, AC6-NOTES.md
// deviation 2) attached to the AI's next decide answer and registered under THAT answer's decision id, without looking at whether that
// answer's record was sealed. In take-1 the same two calls came in the other order and the run passed by timing.
//
// The three parts a reader looks for:
//   (a) "a sealed decision posts nothing before its release"  the carrier, the acceptance, and the whole service in take-2's order
//   (b) "after the release it is published correctly"         the opened record (once), and the held motion on the next unsealed answer
//   (c) "verify-minds M8"                                     FAILS on files of take-2's shape, passes on the corrected flow
// and, after a review by mutation, "the rule in full": the same three parts for the cases take-2 did not have (the sealed decision's own
// say; a record sealed without a march, by the model or on autopilot; a talk filed at or after the release turn; a refused attach).
// Everything on the path is the shipped code (records, outbox, call ledger, social book, release job, season-end bundle, verify-minds M8,
// and in the service tests the mind, the watcher and the HTTP routes). The doubles: the model (a fake llama-server on 127.0.0.1:0), the
// herald's `me` (invented session keys, test/fixtures/ai-social-kit.mjs), the feed's DEPART and REVEAL rows, and the BRAIN: `createBrain`
// below posts a decide answer the way bots/src/ai/follow.rs `post_social` does. Nothing here proves what the Rust brain itself does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecords } from '../citizens/mind/records.mjs';
import { provenanceOf } from '../citizens/mind/wiring.mjs';
import { createLlm } from '../citizens/mind/llm.mjs';
import { createOutbox, MOTION_VALID_BELLS } from '../citizens/watcher/outbox.mjs';
import { createCallLedger, CALLS_FILE } from '../citizens/watcher/call_ledger.mjs';
import { createRelease } from '../citizens/watcher/release.mjs';
import { ball } from '../citizens/watcher/council_gen.mjs';
import { Refusal, createBook } from '../citizens/social/book.mjs';
import { createAudit } from '../citizens/audit/season_end.mjs';
import { openPub } from '../citizens/audit/canon.mjs';
import { checkM8 } from '../citizens/verify-minds.mjs';
import { buildReport, councilCallsSection, loadRun, renderMarkdown } from '../citizens/report.mjs';
import { createCitizensService } from '../citizens/server.mjs';
import { decodeTalk, encodeBallot, encodeTalk, toBase64 } from '../../permutation-server/web/frontier/council/aisocial.mjs';
import { SEASON, fakeHerald, makeCitizen, makeClock, tmpAiDir } from './fixtures/ai-social-kit.mjs';
import { fakeFeed, fakeOwners, host, province } from './fixtures/ai-watcher-kit.mjs';
import { startFakeLlama, loadWireFixture, sessionAnswer, makeStores, makeEpisode, makeRosterJson, renderMemoryDouble, renderPersonaDouble, personaOfDouble, nameOfDouble, CONFIG, TAGS } from './fixtures/ai-mind-doubles.mjs';

// ---------------------------------------------------------------- the shape of take-2's turn 25 (texts as recorded; keys invented)
const T = 25; // the turn of the motion and of the march
const PERIOD = 1;
const OPTION = 3;
const REF = PERIOD * 256 + OPTION; // 259
const TAG = 'c0ffee0000000001';
const HOST = '140741783322624';
const MOTION_TEXT = 'I am considering a strike against a nearby camp to bolster our strength.';
const SAY = 'The first hunt begins.';
const WHY = 'I am marching H1 to the nearest camp to begin the hunt.';
const OWN_SAY = 'Wood is plentiful.';

const readJson = p => JSON.parse(readFileSync(p, 'utf8'));
const journalOf = dir => readFileSync(join(dir, 'state', 'records.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const refusedWith = async (p, code) => { await assert.rejects(p, e => e instanceof Refusal && e.code === code, `expected the refusal ${code}`); };
/** every file under `dir` whose text contains `needle` (paths relative to `dir`) */
function filesWith(dir, needle, rel = '') {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...filesWith(p, needle, `${rel}${n}/`));
    else if (readFileSync(p, 'utf8').includes(needle)) out.push(`${rel}${n}`);
  }
  return out.sort();
}

/**
 * The brain's posting of a decide answer, as bots/src/ai/follow.rs `post_social` does it (lines 981-1037 at aae47bdb): every `say[]`
 * entry as a talk, then `motion` (a talk), then `ballot`; each under the ANSWER's `decision_id` with the entry's own `item` (its position
 * when it has none); the wallet is the brain's; a decision id is posted at most once; a refusal is counted by its code and never retried.
 */
function createBrain({ citizen, submit }) {
  const posted = new Set();
  const stats = {};
  const bump = k => { stats[k] = (stats[k] ?? 0) + 1; };
  return {
    stats,
    async post(ans) {
      const items = [];
      for (const x of Array.isArray(ans?.social?.say) ? ans.social.say : []) items.push(['talk', x]);
      if (ans?.social?.motion) items.push(['talk', ans.social.motion]);
      if (ans?.social?.ballot) items.push(['ballot', ans.social.ballot]);
      if (!items.length || posted.has(ans.decision_id)) return [];
      posted.add(ans.decision_id);
      const out = [];
      for (const [n, [route, it]] of items.entries()) {
        const item = Number.isInteger(it.item) ? it.item : n;
        const bytes = route === 'talk'
          ? encodeTalk({ season: it.season, wallet: citizen.wallet, bell: it.bell, seq: it.seq, channel: it.channel, target: it.target, kind: it.kind, ref: it.ref ?? 0, origin: it.origin, lang: it.lang, text: it.text })
          : encodeBallot({ season: it.season, period: it.period, wallet: citizen.wallet, faction: it.faction, option: it.option, candidates_hash: it.candidates_hash, nonce: it.nonce, origin: it.origin });
        const body = { bytes_b64: toBase64(bytes), sig_b64: toBase64(citizen.key.sign(bytes)), decision_id: ans.decision_id, item };
        const r = await submit(route, body);
        bump(r.ok ? `social_posted:${route}` : `social_refused:${r.code}`);
        out.push({ route, item, text: it.text ?? null, kind: it.kind ?? null, ...r });
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------- the unit world: real records, outbox, ledger, book, release job
function unitWorld({ provenance = null } = {}) {
  const t = tmpAiDir('ai-sealed-speech-');
  const records = createRecords({ aiDir: t.dir, randomBytes: n => Buffer.alloc(n, 5) });
  const stats = {};
  const ledgerFile = join(t.state, 'watcher', CALLS_FILE);
  const ledger = createCallLedger({ file: ledgerFile });
  const outbox = createOutbox({ records, stats, ledger });
  const clock = makeClock({ bell: T });
  const ai = makeCitizen('sealed-speech-ai', { faction: 1 });
  const roster = { season: SEASON, ai: [{ index: 1000, wallet: ai.b58, tag: TAG, faction: 1, name: { en: 'Hana', ja: 'ハナ' } }], script: { wallets: [] }, seat: null };
  const herald = fakeHerald([ai]);
  const book = createBook({ aiDir: t.dir, roster, season: SEASON, clock, herald, provenance: provenance ? provenance(records) : provenanceOf(records) });
  const feed = fakeFeed();
  const release = createRelease({ feed, records, pubDir: t.pub });
  const submit = async (route, body) => { try { return await book.submit(route, body); } catch (e) { if (e instanceof Refusal) return { ok: false, code: e.code }; throw e; } };
  const brain = createBrain({ citizen: ai, submit });
  const base = { v: 2, ai: TAG, index: 1000, mode: 'model', reason: 'ok', gate_score: 0, retrieved: [], situation_hash: 's', candidates_hash: 'c' };
  const req = turn => ({ ai: { index: 1000, tag: TAG, wallet: ai.b58 }, bell: turn });
  const w = {
    ...t, records, stats, ledger, ledgerFile, outbox, clock, ai, roster, herald, book, feed, release, brain, submit, req,
    ledgerRows: () => readJson(ledgerFile).calls,
    /** the council call's own record (unsealed, public at once) and its item in the outbox, as watcher/council_gen.mjs pushes it */
    motion(turn = T) {
      const item = { item: 0, kind: 1, channel: 1, target: 1, text: MOTION_TEXT, lang: 'en', ref: REF, bell: turn, seq: turn * 16 };
      const { id } = records.add({ ...base, bell: turn, kind: 'motion', wake: ['W-COUNCIL'], sealed: false, choice: { ids: [], params: {}, council: { motion: OPTION }, goal_id: 'G3', mem: [] }, public: { say: [MOTION_TEXT], why: 'A motion for goal G3.', why_withheld: null } }, { candidates: [], social: { talk: [item] } });
      const signedReady = { season: SEASON, bell: turn, seq: turn * 16, channel: 1, target: 1, kind: 1, ref: REF, origin: 1, lang: 'en', text: MOTION_TEXT, item: 0 };
      outbox.push({ tag: TAG, kind: 'motion', period: PERIOD, decision_id: id, bell: turn, motion: signedReady, ballot: null });
      return { id, item, signedReady };
    },
    /** a march decision as mind/api.mjs writes it: sealed, its own say kept in the record and NOT in priv.social.talk; the answer carries no say */
    march(turn = T) {
      const { id } = records.add(
        { ...base, bell: turn, kind: 'session', wake: ['W-PULSE'], sealed: true, release_bell: turn + 4, choice: { ids: ['c3'], params: { c3: { stance: 'assault' } }, council: null, goal_id: 'G2', mem: [] }, public: { say: [SAY], why: WHY, why_withheld: null } },
        { candidates: [{ id: 'c3', kind: 'march', facts: { host_id: HOST, target: { p: 1, q: 1, tile: 45 }, earliest_bell: turn + 3 } }], remembered: [], intended: [{ host_id: HOST, arrive_bell: turn + 3, pq: [1, 1], tile: 45, via: 'model', target_kind: 'camp' }], social: { talk: [] } },
      );
      return { id, ans: { v: 1, decision_id: id, mode: 'model', reason: 'ok', choice: { ids: ['c3'], params: {}, mem: [] }, social: { say: [], motion: null, ballot: null } } };
    },
    /** an unsealed decide answer (no march); with `say` it carries one message of its own, numbered and sequenced as mind/api.mjs does */
    quiet(turn, { say = null } = {}) {
      const seq = turn * 16;
      const talk = say ? [{ item: 0, kind: 0, channel: 1, target: 1, text: say, lang: 'en', ref: 0, bell: turn, seq }] : [];
      const { id } = records.add({ ...base, bell: turn, kind: 'session', mode: say ? 'model' : 'autopilot', reason: say ? 'ok' : 'below_gate', wake: [], sealed: false, choice: { ids: ['c1'], params: {}, council: null, goal_id: 'G1', mem: [] }, public: { say: say ? [say] : [], why: say ? 'Economy first.' : null, why_withheld: null } }, { candidates: [], social: { talk } });
      const items = say ? [{ season: SEASON, bell: turn, seq, channel: 1, target: 1, kind: 0, ref: 0, origin: 1, lang: 'en', text: say, item: 0 }] : [];
      return { id, ans: { v: 1, decision_id: id, mode: say ? 'model' : 'autopilot', reason: say ? 'ok' : 'below_gate', choice: { ids: ['c1'], params: {}, mem: [] }, social: { say: items, motion: null, ballot: null } } };
    },
    /** the march left and arrived: the outcome, and the public DEPART and REVEAL rows the release job reads */
    marched(id, turn = T) {
      records.attachOutcome(id, { actions: [{ intent: 'depart', sig: `sig-${id.slice(0, 8)}`, status: 'sent' }] });
      feed.addEvent({ kind: 'DEPART', bell: turn, seq: `d${id.slice(0, 6)}`, host_id: HOST, depart_bell: turn, arrive_bell: turn + 3, dep_mass: 300_000, origin_p: 0, origin_q: 0, origin_tile: 4 });
      const rev = { kind: 'REVEAL', bell: turn + 3, seq: `r${id.slice(0, 6)}`, p: 1, q: 1, arrive: turn + 3, faction: 1, i: 0, host_id: HOST, tile: 45, displace: 0, displaced_host: null };
      feed.reveals.set(`${HOST}/${turn + 3}`, rev);
      feed.addEvent(rev);
    },
    /** what the season end publishes (PUB/full/**) and the auditor's check M8 over the public files, with the herald double's session keys */
    async audit() {
      createAudit({ aiDir: t.dir }).publishSeasonEnd({ force: true });
      return checkM8({ pub: openPub(t.pub), roster, me: wallet => herald.me(wallet) });
    },
  };
  return w;
}
const talkOf = (book) => book.records.filter(r => r.type === 'talk');

// ================================================================ (a) a sealed decision posts nothing before its release
test('(a) a sealed decision posts nothing before its release: the carrier (watcher/outbox.mjs) does not attach a pending council motion to a sealed decide answer; the motion stays pending (take-2\'s order: the motion, then the same turn\'s march)', async () => {
  const w = unitWorld();
  try {
    const m = w.motion(T); // the watcher's council call was answered first ...
    const s = w.march(T); // ... and the brain's step of the same turn chose a march: its record is sealed
    assert.equal(w.records.get(s.id).sealed, true);
    assert.equal('public' in w.records.get(s.id), false, 'the published form of the sealed record carries no say and no why');
    const out = w.outbox.decorate(w.req(T), s.ans);
    assert.equal(out, s.ans, 'the sealed answer goes to the brain as the mind made it: nothing is attached');
    assert.deepEqual(out.social, { say: [], motion: null, ballot: null });
    assert.equal(w.records.provenance(s.id, 0, 'talk'), null, 'the records do not vouch for a talk item under the sealed id');
    assert.equal(w.records.consume(s.id, 0, 'talk'), false, 'and nothing is consumed under it');
    assert.deepEqual(journalOf(w.dir).filter(op => op.op === 'social' || op.op === 'consume'), [], 'no social item was journaled under any record');
    assert.deepEqual(w.records.getPrivate(s.id).priv.social, { talk: [] }, 'the sealed record\'s signed-ready output is still empty');
    // the brain has nothing to post for this answer
    assert.deepEqual(await w.brain.post(out), []);
    assert.deepEqual(talkOf(w.book), []);
    // the motion is not lost: it waits for the AI's next unsealed answer, and the hold is counted and written down
    assert.equal(w.outbox.pendingCount(TAG), 1);
    assert.equal(w.stats.outbox_held_sealed, 1);
    assert.equal(w.stats.outbox_attached, undefined);
    const row = w.ledgerRows().find(r => r.kind === 'motion');
    assert.deepEqual([row.status, row.decision_id, row.decided_bell, row.held_sealed, row.held_bell], ['pending', m.id, T, 1, T]);
    // a same-turn repeat of the brain's step gets the cached sealed answer: held again, counted once
    assert.equal(w.outbox.decorate(w.req(T), s.ans), s.ans);
    assert.equal(w.stats.outbox_held_sealed, 1, 'one hold per (item, sealed answer)');
    assert.equal(w.outbox.pendingCount(TAG), 1);
  } finally { w.dispose(); }
});

test('(a) a sealed decision posts nothing before its release: the acceptance (mind/records.mjs attachSocial, provenance, consume; the social service through them) refuses a talk item under a sealed record, whatever a carrier does', async () => {
  const w = unitWorld();
  try {
    const m = w.motion(T);
    const s = w.march(T);
    const exp = { ...w.records.provenance(m.id, 0, 'talk'), item: 0 };
    assert.equal(exp.text, MOTION_TEXT, 'the motion\'s own (unsealed) record vouches for it');
    // 1. a carrier that asks the records to register the item under the sealed answer is refused, and nothing is journaled
    assert.equal(w.records.attachSocial(s.id, 'talk', exp), false);
    assert.equal(journalOf(w.dir).some(op => op.op === 'social'), false);
    assert.equal(w.records.stats().sealed_talk_refused, 1, 'the refusal is counted');
    // 2. a carrier that writes into the record's private part itself (what the outbox did for a records object without attachSocial)
    w.records.getPrivate(s.id).priv.social.talk.push(exp);
    assert.equal(w.records.provenance(s.id, 0, 'talk'), null, 'still not vouched for');
    assert.equal(w.records.consume(s.id, 0, 'talk'), false, 'still not consumed');
    // 3. the social service: the brain signs the motion and posts it under the sealed id, as take-2's brain did; refused, nothing is stored
    const bytes = encodeTalk({ ...m.signedReady, wallet: w.ai.wallet });
    await refusedWith(w.book.submit('talk', { bytes_b64: toBase64(bytes), sig_b64: toBase64(w.ai.key.sign(bytes)), decision_id: s.id, item: 0 }), 'NotFromMind');
    assert.deepEqual(talkOf(w.book), []);
    // 4. a restart over a journal that already holds such lines (the lines aae47bdb wrote in take-2) does not make the records vouch
    appendFileSync(join(w.state, 'records.jsonl'), `${JSON.stringify({ op: 'social', id: s.id, type: 'talk', exp })}\n${JSON.stringify({ op: 'consume', key: `${s.id}:talk:0` })}\n`);
    const again = createRecords({ aiDir: w.dir });
    assert.equal(again.getPrivate(s.id).priv.social.talk.length, 1, 'the journal is replayed as it was written (a record of what happened)');
    assert.equal(again.provenance(s.id, 0, 'talk'), null);
    assert.equal(again.consume(s.id, 0, 'talk'), false);
    // 5. opening the record at its release does not turn it into a talk source: its say appears in the opened record only (7.2)
    w.records.markOpened(s.id);
    assert.equal(w.records.provenance(s.id, 0, 'talk'), null);
    // the unsealed records are untouched by the rule
    const q = w.quiet(T + 1);
    assert.equal(w.records.attachSocial(q.id, 'talk', exp), true);
    assert.equal(w.records.provenance(q.id, 0, 'talk').text, MOTION_TEXT);
  } finally { w.dispose(); }
});

test('(a) decision, from the contract\'s text: a BALLOT still rides on a sealed answer (7.2 withholds a sealed decision\'s say and why; a ballot is hidden by the council itself until the Strike Order opens, and M8 flags talk records only)', async () => {
  const w = unitWorld();
  try {
    const nonce = 'ab'.repeat(16);
    const { id: ballotId } = w.records.add({ v: 2, ai: TAG, index: 1000, mode: 'model', reason: 'ok', gate_score: 0, retrieved: [], situation_hash: 's', candidates_hash: 'c', bell: T, kind: 'ballot', wake: ['W-COUNCIL'], sealed: false, choice: { ids: [], params: {}, council: { ballot: 2 }, goal_id: 'G3', mem: [] }, public: { say: [], why: 'Option two.', why_withheld: null } }, { candidates: [], social: { ballot: [{ item: 0, option: 2, period: PERIOD, nonce }] } });
    w.outbox.push({ tag: TAG, kind: 'ballot', period: PERIOD, decision_id: ballotId, bell: T, motion: null, ballot: { season: SEASON, period: PERIOD, faction: 1, option: 2, candidates_hash: '11'.repeat(32), nonce, origin: 1, item: 0 } });
    const s = w.march(T);
    const out = w.outbox.decorate(w.req(T), s.ans);
    assert.equal(out.social.ballot.item, 0, 'the ballot is on the sealed answer, as before the fix');
    assert.equal(out.social.motion, null);
    assert.deepEqual(out.social.say, []);
    const p = w.records.provenance(s.id, 0, 'ballot');
    assert.deepEqual([p.option, p.period, p.nonce], [2, PERIOD, nonce]);
    assert.equal(w.records.provenance(s.id, 0, 'talk'), null, 'a ballot under the sealed record is not a talk under it');
    const posted = await w.brain.post(out);
    assert.deepEqual(posted.map(x => [x.route, x.ok]), [['ballot', true]], JSON.stringify(posted));
    assert.equal(w.stats.outbox_held_sealed, undefined);
  } finally { w.dispose(); }
});

// ================================================================ (b) after the release it is published correctly
test('(b) after the release it is published correctly: the held motion is posted under the AI\'s next UNSEALED answer within its validity (take-1\'s sequence) with its own text, kind and reference; the sealed decision\'s say and why appear in the opened record at its release, exactly once, and nowhere before', async () => {
  const w = unitWorld();
  try {
    const m = w.motion(T);
    const s = w.march(T);
    await w.brain.post(w.outbox.decorate(w.req(T), s.ans));
    w.marched(s.id);
    // ---- turn T + 1: the brain's next step makes no march; its answer carries the motion
    w.clock.set(T + 1);
    const q = w.quiet(T + 1);
    const out = w.outbox.decorate(w.req(T + 1), q.ans);
    assert.notEqual(out, q.ans, 'a new answer object: the mind\'s cached answer is never mutated');
    assert.equal(q.ans.social.motion, null);
    assert.deepEqual([out.social.motion.text, out.social.motion.kind, out.social.motion.ref, out.social.motion.item, out.social.motion.decision_id], [MOTION_TEXT, 1, REF, 0, m.id]);
    assert.equal(MOTION_VALID_BELLS, 1, 'a motion is valid in its own turn and the next');
    const posted = await w.brain.post(out);
    assert.deepEqual(posted.map(x => [x.route, x.ok, x.text]), [['talk', true, MOTION_TEXT]], JSON.stringify(posted));
    const talks = talkOf(w.book);
    assert.equal(talks.length, 1);
    const d = decodeTalk(talks[0].bytes);
    assert.deepEqual([d.text, d.kind, Number(d.ref), d.channel, d.bell, talks[0].bell], [MOTION_TEXT, 1, REF, 1, T, T + 1], 'the motion\'s own text, kind 1 and reference, signed for turn T and filed at T + 1');
    assert.equal(talks[0].decision_id, q.id, 'filed under the unsealed answer that carried it');
    assert.notEqual(talks[0].decision_id, s.id, 'never under the sealed decision');
    assert.equal(w.records.provenance(q.id, 0, 'talk').consumed, true);
    assert.equal(w.stats.outbox_attached, 1);
    const row = w.ledgerRows().find(r => r.kind === 'motion');
    assert.deepEqual([row.status, row.status_bell, row.held_sealed], ['attached', T + 1, 1], 'the ledger says it was carried a turn later, after one sealed answer');
    // ---- before the release nothing of the sealed decision is public: not in the turn's files, not in the talk channel
    w.records.closeBell(T);
    w.records.closeBell(T + 1);
    w.book.closeBell(T + 1);
    const sealedPub = readJson(join(w.pub, 'minds', `${T}.json`)).records.find(r => r.id === s.id);
    assert.deepEqual([sealedPub.sealed, sealedPub.release_bell, 'public' in sealedPub, 'choice' in sealedPub], [true, T + 4, false, false]);
    for (const turn of [T + 1, T + 2, T + 3]) assert.deepEqual((await w.release.releaseDue(turn)).opened, [], `nothing is opened at turn ${turn}`);
    assert.deepEqual(filesWith(w.pub, SAY), [], 'the sealed say is in no public file before the release');
    assert.deepEqual(filesWith(w.pub, WHY), [], 'the sealed why is in no public file before the release');
    assert.equal(talkOf(w.book).some(r => decodeTalk(r.bytes).text === SAY), false);
    // ---- the release (the watcher's job, watcher/release.mjs): the say and the why in the opened record, once
    const r = await w.release.releaseDue(T + 4);
    assert.deepEqual(r.opened, [s.id]);
    const opened = readJson(join(w.pub, 'open', `${T + 4}.json`)).records;
    assert.deepEqual(opened.map(o => o.id), [s.id]);
    assert.deepEqual(opened[0].public, { say: [SAY], why: WHY, why_withheld: null });
    assert.deepEqual([opened[0].opened_bell, opened[0].release_bell, opened[0].destinations[0].state, opened[0].destinations[0].p, opened[0].destinations[0].q], [T + 4, T + 4, 'revealed', 1, 1]);
    for (const turn of [T + 5, T + 6]) assert.deepEqual((await w.release.releaseDue(turn)).opened, [], 'opened once: later turns do not open it again');
    assert.deepEqual(filesWith(w.pub, SAY), [`open/${T + 4}.json`], 'the say is published in the opened record only');
    assert.deepEqual(filesWith(w.pub, WHY), [`open/${T + 4}.json`]);
    assert.equal(readdirSync(join(w.pub, 'open')).filter(n => /^\d+\.json$/.test(n)).flatMap(n => readJson(join(w.pub, 'open', n)).records).filter(o => o.id === s.id).length, 1);
    // the say of a sealed decision is never a talk record, before or after (7.2: "appear only in the opened record")
    assert.equal(talkOf(w.book).some(x => decodeTalk(x.bytes).text === SAY), false);
    assert.equal(w.records.provenance(s.id, 0, 'talk'), null);
    // and the auditor passes these files
    const m8 = await w.audit();
    assert.deepEqual([m8.pass, m8.failures, m8.ai_records_checked], [true, [], 1], JSON.stringify(m8.failures));
  } finally { w.dispose(); }
});

test('(b) a held motion whose carrier has a say of its own is posted BEFORE that say (the brain posts say[] in order and the social service refuses a sequence number that is not above the wallet\'s last: SeqReplay)', async () => {
  const w = unitWorld();
  try {
    const m = w.motion(T);
    const s = w.march(T);
    w.outbox.decorate(w.req(T), s.ans);
    w.clock.set(T + 1);
    const q = w.quiet(T + 1, { say: OWN_SAY });
    assert.ok(q.ans.social.say[0].seq > m.signedReady.seq, 'the next turn\'s say has the higher sequence number');
    const out = w.outbox.decorate(w.req(T + 1), q.ans);
    assert.deepEqual(out.social.say.map(x => [x.text, x.kind, x.item, x.seq]), [[MOTION_TEXT, 1, 1, T * 16], [OWN_SAY, 0, 0, (T + 1) * 16]], 'the motion first, with its own item number after the answer\'s say');
    assert.equal(out.social.motion, null, 'not in the motion slot, which the brain posts after say[]');
    assert.equal(out.social.say[0].decision_id, m.id);
    assert.deepEqual(q.ans.social.say.map(x => x.text), [OWN_SAY], 'the mind\'s cached answer is untouched');
    assert.equal(w.stats.outbox_motion_first, 1);
    const posted = await w.brain.post(out);
    assert.deepEqual(posted.map(x => [x.text, x.item, x.ok]), [[MOTION_TEXT, 1, true], [OWN_SAY, 0, true]], JSON.stringify(posted));
    assert.deepEqual(talkOf(w.book).map(r => [decodeTalk(r.bytes).text, r.decision_id, r.item]), [[MOTION_TEXT, q.id, 1], [OWN_SAY, q.id, 0]]);
    // the control: in the order the brain used for the motion slot (the say, then the motion) the motion is refused and lost
    const c = unitWorld();
    try {
      const cm = c.motion(T);
      c.outbox.decorate(c.req(T), c.march(T).ans);
      c.clock.set(T + 1);
      const cq = c.quiet(T + 1, { say: OWN_SAY });
      const old = { ...cq.ans, social: { say: cq.ans.social.say, motion: { ...cm.signedReady, item: 1, decision_id: cm.id }, ballot: null } };
      c.records.attachSocial(cq.id, 'talk', { ...c.records.provenance(cm.id, 0, 'talk'), item: 1 });
      const res = await c.brain.post(old);
      assert.deepEqual(res.map(x => [x.text, x.ok, x.code ?? null]), [[OWN_SAY, true, null], [MOTION_TEXT, false, 'SeqReplay']]);
    } finally { c.dispose(); }
    // a carrier whose say has no later sequence number (or none): the motion keeps its slot, as before
    const k = unitWorld();
    try {
      k.motion(T);
      k.clock.set(T + 1);
      const kq = k.quiet(T + 1);
      const ko = k.outbox.decorate(k.req(T + 1), { ...kq.ans, social: { say: [{ item: 0 }, { item: 1 }], motion: null, ballot: null } });
      assert.deepEqual([ko.social.say.length, ko.social.motion.item], [2, 2]);
    } finally { k.dispose(); }
  } finally { w.dispose(); }
});

test('(b) a motion that meets only sealed answers while it is valid expires unposted; that is counted (outbox_held_sealed, outbox_expired) and written to the delivery ledger with its cause', async () => {
  const w = unitWorld();
  try {
    const m = w.motion(T);
    const s1 = w.march(T);
    assert.equal(w.outbox.decorate(w.req(T), s1.ans), s1.ans);
    w.clock.set(T + 1);
    const s2 = w.march(T + 1); // the next turn's step marches again (or recalls): sealed too
    assert.equal(w.outbox.decorate(w.req(T + 1), s2.ans), s2.ans);
    assert.equal(w.outbox.pendingCount(TAG), 1, 'still pending after two sealed answers');
    assert.equal(w.stats.outbox_held_sealed, 2);
    // turn T + 2: an unsealed answer comes, but the motion's turn is in its signed bytes and the social service takes it within one turn only
    w.clock.set(T + 2);
    const q = w.quiet(T + 2);
    assert.equal(w.outbox.decorate(w.req(T + 2), q.ans), q.ans, 'the expired motion is not attached');
    assert.equal(w.stats.outbox_expired, 1);
    assert.equal(w.stats.outbox_attached, undefined);
    assert.equal(w.outbox.pendingCount(TAG), 0);
    const row = w.ledgerRows().find(r => r.kind === 'motion');
    assert.deepEqual(row, { key: `motion:${TAG}:${PERIOD}`, tag: TAG, kind: 'motion', period: PERIOD, decision_id: m.id, decided_bell: T, status: 'expired', status_bell: T + 2, why: 'sealed_carrier', held_sealed: 2, held_bell: T + 1 });
    assert.deepEqual(w.ledger.summary(), { motion: { decided: 1, pending: 0, attached: 0, expired: 1, dropped: 0, held_sealed: 1 } });
    // and the run's report says so (citizens/report.mjs reads the ledger)
    const cc = councilCallsSection(loadRun(w.dir));
    assert.deepEqual([cc.motion.expired, cc.motion.held_by_sealed_answer, cc.motion.expired_after_sealed_answer, cc.ballot.held_by_sealed_answer], [1, 1, 1, 0]);
    assert.match(renderMarkdown(buildReport({ aiDir: w.dir })), /1 motion\(s\) met a sealed answer .* and were held back for the AI's next unsealed answer; 1 of them expired unposted/);
    for (const id of [s1.id, s2.id, q.id]) assert.equal(w.records.provenance(id, 0, 'talk'), null);
    assert.deepEqual(talkOf(w.book), []);
    // the motion itself stays public where the contract puts it: in its own, unsealed record (6.5 step 3)
    assert.deepEqual(w.records.get(m.id).public.say, [MOTION_TEXT]);
  } finally { w.dispose(); }
});

// ================================================================ (c) verify-minds M8
test('(c) verify-minds M8 FAILS with sealed_decision_posted on public files of take-2\'s shape (a talk record filed under a sealed decision, written the way aae47bdb wrote it), and names the decision; the rule had no test', async () => {
  // aae47bdb's acceptance never looked at `sealed`: this vouches the way it did, for this one item, so that files of take-2's shape exist.
  // (The fixed records refuse to; the tests of part (a) pin that.)
  const faulty = { id: null, exp: null };
  const w = unitWorld({
    provenance: records => ({
      provenance: (id, item, type) => (id === faulty.id && type === 'talk' && item === 0 ? faulty.exp : records.provenance(id, item, type)),
      consume: () => true,
    }),
  });
  try {
    const m = w.motion(T);
    const s = w.march(T);
    faulty.id = s.id;
    faulty.exp = { ...w.records.provenance(m.id, 0, 'talk'), item: 0 };
    appendFileSync(join(w.state, 'records.jsonl'), `${JSON.stringify({ op: 'social', id: s.id, type: 'talk', exp: faulty.exp })}\n${JSON.stringify({ op: 'consume', key: `${s.id}:talk:0` })}\n`);
    const posted = await w.brain.post({ ...s.ans, social: { say: [], motion: { ...m.signedReady, item: 0, decision_id: m.id }, ballot: null } });
    assert.deepEqual(posted.map(x => x.ok), [true], 'the pre-fix acceptance took the motion under the sealed id');
    w.marched(s.id);
    w.records.closeBell(T);
    w.book.closeBell(T);
    await w.release.releaseDue(T + 5); // take-2 opened the record one turn after its release turn
    const m8 = await w.audit();
    // the files have take-2's shape
    const row = readJson(join(w.pub, 'full', 'social.json')).records[0];
    assert.deepEqual([row.type, row.bell, row.decision_id, row.item, row.kind, row.ref, row.kind_of_wallet], ['talk', T, s.id, 0, 1, REF, 'ai']);
    const full = readJson(join(w.pub, 'full', 'decisions', `${s.id}.json`));
    assert.deepEqual([full.sealed, full.social.talk[0].text, full.social.talk[0].kind, full.social.talk[0].ref], [true, MOTION_TEXT, 1, REF]);
    assert.deepEqual(readJson(join(w.pub, 'open', `${T + 5}.json`)).records[0].public.say, [SAY], 'the sealed decision\'s own say was withheld and is in the opened record');
    // and the auditor fails them, on that decision, with that code and nothing else
    assert.equal(m8.pass, false);
    assert.deepEqual(m8.failures.map(f => [f.code, f.decision]), [['sealed_decision_posted', s.id]]);
    assert.deepEqual([m8.failures[0].item, m8.failures[0].talk_kind, m8.failures[0].filed_bell, m8.failures[0].release_bell], [0, 1, T, T + 4], 'the failure says which item, that it is a motion (kind 1), when it was filed and when the decision was to be released');
    assert.match(m8.failures[0].detail, /talk record filed under a sealed decision/);
    assert.doesNotMatch(m8.failures[0].detail, /a sealed decision's say is withheld until the release: it must not have been posted/, 'the old sentence called a carried motion "the say"');
    assert.equal(m8.ai_records_checked, 1);
  } finally { w.dispose(); }
});

test('(c) verify-minds M8 passes the corrected flow (the same motion and the same march, in take-2\'s order, through the fixed carrier and acceptance) and still fails when that talk is re-filed under the sealed decision', async () => {
  const w = unitWorld();
  try {
    const m = w.motion(T);
    const s = w.march(T);
    await w.brain.post(w.outbox.decorate(w.req(T), s.ans));
    w.marched(s.id);
    w.clock.set(T + 1);
    const q = w.quiet(T + 1);
    assert.deepEqual((await w.brain.post(w.outbox.decorate(w.req(T + 1), q.ans))).map(x => x.ok), [true]);
    w.records.closeBell(T);
    w.records.closeBell(T + 1);
    w.book.closeBell(T + 1);
    await w.release.releaseDue(T + 4);
    const m8 = await w.audit();
    assert.deepEqual([m8.pass, m8.failures, m8.ai_records_checked], [true, [], 1], JSON.stringify(m8.failures));
    assert.equal(readJson(join(w.pub, 'full', 'social.json')).records[0].decision_id, q.id);
    // the check is not loosened: the same public files with that one talk filed under the sealed decision fail as take-2's did
    const socialPath = join(w.pub, 'full', 'social.json');
    const social = readJson(socialPath);
    social.records[0].decision_id = s.id;
    writeFileSync(socialPath, JSON.stringify(social));
    const decisionPath = join(w.pub, 'full', 'decisions', `${s.id}.json`);
    const full = readJson(decisionPath);
    full.social = { talk: [{ ...w.records.provenance(m.id, 0, 'talk'), item: 0 }] };
    writeFileSync(decisionPath, JSON.stringify(full));
    const tampered = await checkM8({ pub: openPub(w.pub), roster: w.roster, me: wallet => w.herald.me(wallet) });
    assert.equal(tampered.pass, false);
    assert.ok(tampered.failures.some(f => f.code === 'sealed_decision_posted' && f.decision === s.id), JSON.stringify(tampered.failures));
  } finally { w.dispose(); }
});

// ================================================================ the rule in full: any talk, any sealed record, any turn
// The tests above pin take-2's own case: a MOTION, under a record sealed by a MARCH the model chose, filed BEFORE the release. A review
// by mutation showed that narrower rules passed them all. Each test below names the narrowing it refuses (the code it would sit in).
// None of these paths is taken by the shipped mind or carrier; the tests write the faulty state themselves where one is needed.

/** a world whose social service vouches for chosen (decision id, item) pairs the way aae47bdb's acceptance did, so that faulty public files exist */
const faultyWorld = () => {
  const faulty = new Map(); // `${id}:${item}` -> the expectation
  const w = unitWorld({ provenance: records => ({ provenance: (id, item, type) => (type === 'talk' && faulty.has(`${id}:${item}`) ? faulty.get(`${id}:${item}`) : records.provenance(id, item, type)), consume: () => true }) });
  return { w, faulty };
};
const BASE = { v: 2, ai: TAG, index: 1000, mode: 'model', reason: 'ok', gate_score: 0, retrieved: [], situation_hash: 's', candidates_hash: 'c' };
/** the sealed decision's OWN say as a talk item (kind 0), as a mind that did not withhold it would have made it signed-ready */
const ownSay = turn => ({ item: 0, kind: 0, channel: 1, target: 1, text: SAY, lang: 'en', ref: 0, bell: turn, seq: turn * 16 });
/**
 * A record sealed WITHOUT a march of its own: sealed, a release turn, no intended sends. That is what mind/api.mjs `intendedSends` gives a
 * step made under a live Strike Order of the nation (`sealed: anyMarch || Boolean(member?.call)`), by the model or on autopilot.
 */
const sealedNoMarch = (w, turn, release, { mode = 'model' } = {}) => {
  const { id } = w.records.add(
    { ...BASE, mode, reason: mode === 'model' ? 'ok' : 'below_gate', bell: turn, kind: 'session', wake: ['W-PULSE'], sealed: true, release_bell: release, choice: { ids: ['c1'], params: {}, council: null, goal_id: 'G1', mem: [] }, public: { say: [SAY], why: WHY, why_withheld: null } },
    { candidates: [], remembered: [], intended: [], social: { talk: [] } },
  );
  return { id, ans: { v: 1, decision_id: id, mode, reason: mode === 'model' ? 'ok' : 'below_gate', choice: { ids: ['c1'], params: {}, mem: [] }, social: { say: [], motion: null, ballot: null } } };
};

test('(a) the acceptance refuses the sealed decision\'s OWN say (kind 0) under its id, not only a carried motion: not registered, not vouched for, not consumed, refused by the social service, in no public file (refuses: "the records refuse only a motion under a sealed record")', async () => {
  const w = unitWorld();
  try {
    const s = w.march(T);
    const sayExp = ownSay(T);
    assert.equal(w.records.attachSocial(s.id, 'talk', sayExp), false, 'not registered');
    assert.equal(journalOf(w.dir).some(op => op.op === 'social'), false, 'and not journaled');
    w.records.getPrivate(s.id).priv.social.talk.push(sayExp); // what a mind that did not withhold the say would have written
    assert.equal(w.records.provenance(s.id, 0, 'talk'), null, 'not vouched for');
    assert.equal(w.records.consume(s.id, 0, 'talk'), false, 'not consumed');
    // the brain signs the say and posts it under the sealed id: refused, nothing is stored
    const bytes = encodeTalk({ season: SEASON, wallet: w.ai.wallet, bell: T, seq: T * 16, channel: 1, target: 1, kind: 0, ref: 0, origin: 1, lang: 'en', text: SAY });
    await refusedWith(w.book.submit('talk', { bytes_b64: toBase64(bytes), sig_b64: toBase64(w.ai.key.sign(bytes)), decision_id: s.id, item: 0 }), 'NotFromMind');
    assert.deepEqual(talkOf(w.book), []);
    w.records.closeBell(T);
    w.book.closeBell(T);
    assert.deepEqual(readJson(join(w.pub, 'talk', `${T}.json`)).records, [], 'the turn\'s talk file is empty');
    assert.deepEqual(filesWith(w.pub, SAY), [], 'the say is in no public file');
  } finally { w.dispose(); }
});

test('(a) a record sealed WITHOUT a march of its own (a step under a live Strike Order), made by the model or on autopilot, is a sealed carrier too: the motion is held, and the acceptance refuses a talk under it (refuses: "only an answer with a march", "only a model answer")', async () => {
  for (const mode of ['model', 'autopilot']) {
    const w = unitWorld();
    try {
      const m = w.motion(T);
      const s = sealedNoMarch(w, T, T + 6, { mode });
      assert.deepEqual([w.records.get(s.id).sealed, w.records.get(s.id).mode, w.records.getPrivate(s.id).priv.intended], [true, mode, []], `${mode}: sealed, and no send of its own`);
      // the carrier
      assert.equal(w.outbox.decorate(w.req(T), s.ans), s.ans, `${mode}: nothing is attached`);
      assert.equal(w.outbox.pendingCount(TAG), 1, `${mode}: the motion waits`);
      assert.equal(w.stats.outbox_held_sealed, 1, `${mode}: the hold is counted`);
      assert.equal(w.stats.outbox_refused, undefined, `${mode}: held by the carrier, not handed to the records and dropped`);
      assert.equal(w.stats.outbox_attached, undefined);
      assert.equal(w.ledgerRows().find(r => r.kind === 'motion').status, 'pending', `${mode}: the ledger still has it pending`);
      assert.deepEqual(journalOf(w.dir).filter(op => op.op === 'social' || op.op === 'consume'), []);
      // the acceptance
      const exp = { ...w.records.provenance(m.id, 0, 'talk'), item: 0 };
      assert.equal(w.records.attachSocial(s.id, 'talk', exp), false, `${mode}: not registered`);
      w.records.getPrivate(s.id).priv.social.talk.push(exp);
      assert.equal(w.records.provenance(s.id, 0, 'talk'), null, `${mode}: not vouched for`);
      assert.equal(w.records.consume(s.id, 0, 'talk'), false, `${mode}: not consumed`);
      const bytes = encodeTalk({ ...m.signedReady, wallet: w.ai.wallet });
      await refusedWith(w.book.submit('talk', { bytes_b64: toBase64(bytes), sig_b64: toBase64(w.ai.key.sign(bytes)), decision_id: s.id, item: 0 }), 'NotFromMind');
      assert.deepEqual(talkOf(w.book), [], `${mode}: nothing is stored`);
      // and the held motion is not lost: the next turn's unsealed answer carries it
      w.clock.set(T + 1);
      const q = w.quiet(T + 1);
      const posted = await w.brain.post(w.outbox.decorate(w.req(T + 1), q.ans));
      assert.deepEqual(posted.map(x => [x.ok, x.text]), [[true, MOTION_TEXT]], JSON.stringify(posted));
      assert.deepEqual(talkOf(w.book).map(r => r.decision_id), [q.id], `${mode}: filed under the unsealed answer`);
    } finally { w.dispose(); }
  }
});

test('(a) the opening of a sealed record does not make it a talk carrier: a motion that meets the sealed answer after its release is still held, and the records still do not vouch (refuses: "sealed only until opened" in the carrier)', async () => {
  const w = unitWorld();
  try {
    const s = sealedNoMarch(w, T, T + 1);
    w.clock.set(T + 1);
    assert.deepEqual((await w.release.releaseDue(T + 1)).opened, [s.id], 'opened at its release turn');
    w.motion(T + 1);
    assert.equal(w.outbox.decorate(w.req(T + 1), s.ans), s.ans, 'nothing is attached to the opened sealed answer');
    assert.equal(w.outbox.pendingCount(TAG), 1);
    assert.equal(w.stats.outbox_held_sealed, 1);
    assert.equal(w.stats.outbox_refused, undefined, 'held by the carrier itself, not refused by the records behind it');
    assert.equal(w.records.provenance(s.id, 0, 'talk'), null);
    assert.deepEqual(journalOf(w.dir).filter(op => op.op === 'social' || op.op === 'consume'), []);
  } finally { w.dispose(); }
});

test('(a) a carrier whose attach is refused by the records hands nothing to the brain: the item is dropped, counted (outbox_refused) and written to the delivery ledger (dropped, refused_by_records) (refuses: "the carrier ignores the refusal")', async () => {
  const w = unitWorld();
  try {
    const refusing = Object.create(w.records);
    refusing.attachSocial = () => false; // the records' answer for a talk under a sealed record, here for any record
    const stats = {};
    const outbox = createOutbox({ records: refusing, stats, ledger: w.ledger });
    const item = { item: 0, kind: 1, channel: 1, target: 1, text: MOTION_TEXT, lang: 'en', ref: REF, bell: T, seq: T * 16 };
    const { id } = w.records.add({ ...BASE, bell: T, kind: 'motion', wake: ['W-COUNCIL'], sealed: false, choice: { ids: [], params: {}, council: { motion: OPTION }, goal_id: 'G3', mem: [] }, public: { say: [MOTION_TEXT], why: 'A motion.', why_withheld: null } }, { candidates: [], social: { talk: [item] } });
    outbox.push({ tag: TAG, kind: 'motion', period: PERIOD, decision_id: id, bell: T, motion: { season: SEASON, bell: T, seq: T * 16, channel: 1, target: 1, kind: 1, ref: REF, origin: 1, lang: 'en', text: MOTION_TEXT, item: 0 }, ballot: null });
    const q = w.quiet(T);
    const out = outbox.decorate(w.req(T), q.ans);
    assert.equal(out, q.ans, 'nothing is handed to the brain');
    assert.deepEqual(out.social, { say: [], motion: null, ballot: null });
    assert.equal(stats.outbox_refused, 1);
    assert.equal(stats.outbox_attached, undefined);
    assert.equal(outbox.pendingCount(TAG), 0, 'dropped, not kept for a later answer');
    const row = w.ledgerRows().find(r => r.kind === 'motion');
    assert.deepEqual([row.status, row.status_bell, row.why], ['dropped', T, 'refused_by_records']);
    assert.deepEqual(await w.brain.post(out), []);
  } finally { w.dispose(); }
});

test('(b) a sealed record with no march of its own is not opened before its release turn: its say is in no public file until then, and in the opened record from then (refuses: "due for release at once")', async () => {
  const w = unitWorld();
  try {
    const s = sealedNoMarch(w, T, T + 3);
    w.records.closeBell(T);
    for (const turn of [T, T + 1, T + 2]) assert.deepEqual((await w.release.releaseDue(turn)).opened, [], `nothing is opened at turn ${turn}`);
    assert.deepEqual(filesWith(w.pub, SAY), []);
    assert.deepEqual(filesWith(w.pub, WHY), []);
    assert.deepEqual((await w.release.releaseDue(T + 3)).opened, [s.id]);
    assert.deepEqual(filesWith(w.pub, SAY), [`open/${T + 3}.json`]);
    assert.deepEqual(readJson(join(w.pub, 'open', `${T + 3}.json`)).records.map(o => [o.id, o.public.say, o.public.why]), [[s.id, [SAY], WHY]]);
  } finally { w.dispose(); }
});

test('(c) verify-minds M8 fails when the sealed decision\'s OWN say (kind 0) was posted under it, the rule\'s first meaning (refuses the loosening "only a motion under a sealed decision fails")', async () => {
  const { w, faulty } = faultyWorld();
  try {
    const s = w.march(T);
    const sayExp = ownSay(T);
    faulty.set(`${s.id}:0`, { ...sayExp, decision_bell: T, index: 1000 });
    appendFileSync(join(w.state, 'records.jsonl'), `${JSON.stringify({ op: 'social', id: s.id, type: 'talk', exp: sayExp })}\n`);
    const posted = await w.brain.post({ ...s.ans, social: { say: [{ season: SEASON, bell: T, seq: T * 16, channel: 1, target: 1, kind: 0, ref: 0, origin: 1, lang: 'en', text: SAY, item: 0 }], motion: null, ballot: null } });
    assert.deepEqual(posted.map(x => x.ok), [true], 'the faulty acceptance took the say under the sealed id');
    w.marched(s.id);
    w.records.closeBell(T);
    w.book.closeBell(T);
    await w.release.releaseDue(T + 4);
    const m8 = await w.audit();
    const row = readJson(join(w.pub, 'full', 'social.json')).records[0];
    assert.deepEqual([row.type, row.bell, row.decision_id, row.item, row.kind], ['talk', T, s.id, 0, 0], 'the files: a say (kind 0) filed under the sealed decision at its own turn');
    assert.equal(m8.pass, false);
    assert.deepEqual(m8.failures.map(f => [f.code, f.decision, f.item, f.talk_kind, f.filed_bell, f.release_bell]), [['sealed_decision_posted', s.id, 0, 0, T, T + 4]], JSON.stringify(m8.failures));
  } finally { w.dispose(); }
});

test('(c) verify-minds M8 fails a talk filed under a sealed decision AT OR AFTER its release turn too: the opening does not make the decision a talk source (7.2: the say appears only in the opened record) (refuses the loosening "only a talk filed before the release fails")', async () => {
  const RELEASE = T + 1;
  for (const filedAt of [RELEASE, RELEASE + 1]) { // in the release turn itself, and one turn after it
    const { w, faulty } = faultyWorld();
    try {
      const s = sealedNoMarch(w, T, RELEASE);
      w.clock.set(RELEASE);
      const m = w.motion(RELEASE); // signed for the release turn
      assert.deepEqual((await w.release.releaseDue(RELEASE)).opened, [s.id], 'opened at its release turn');
      w.clock.set(filedAt);
      const exp = { ...w.records.provenance(m.id, 0, 'talk'), item: 0 };
      faulty.set(`${s.id}:0`, exp);
      appendFileSync(join(w.state, 'records.jsonl'), `${JSON.stringify({ op: 'social', id: s.id, type: 'talk', exp })}\n`);
      const posted = await w.brain.post({ ...s.ans, social: { say: [], motion: { ...m.signedReady, item: 0, decision_id: m.id }, ballot: null } });
      assert.deepEqual(posted.map(x => x.ok), [true], JSON.stringify(posted));
      for (let turn = T; turn <= filedAt; turn++) w.records.closeBell(turn);
      w.book.closeBell(filedAt);
      const m8 = await w.audit();
      assert.equal(readJson(join(w.pub, 'open', `${RELEASE}.json`)).records[0].id, s.id, 'the decision was opened before the talk was filed');
      assert.equal(m8.pass, false, JSON.stringify(m8));
      assert.deepEqual(m8.failures.map(f => [f.code, f.decision, f.item, f.talk_kind, f.filed_bell, f.release_bell]), [['sealed_decision_posted', s.id, 0, 1, filedAt, RELEASE]], `filed at turn ${filedAt}: ${JSON.stringify(m8.failures)}`);
      assert.ok(m8.failures[0].filed_bell >= m8.failures[0].release_bell, 'filed at or after the release turn');
    } finally { w.dispose(); }
  }
});

// ================================================================ the whole service, in take-2's order
// The real citizens service (server.mjs): the real mind over a fake llama-server, the real records, the real social store behind its HTTP
// routes, the real watcher (council generator, outbox, release job) and the service's own wrapping of `mind.decide` (server.mjs, the
// `decorateAnswer` wiring). The watcher's council opens at C0 from SYNTHETIC province files (test/fixtures/ai-watcher-kit.mjs), asks the
// AI for its motion through the mind, and the brain's step of the same turn then chooses a march.
const { json: wire } = loadWireFixture();
const GENESIS = 1_800_000_000;
const C0 = 48;
const SVC_MOTION = 'Option two is within reach.';
const SVC_WHY = 'A short march serves goal G1.';

async function boot() {
  const aiDir = mkdtempSync(join(tmpdir(), 'ai-sealed-speech-svc-'));
  mkdirSync(join(aiDir, 'pub'), { recursive: true });
  const a = makeCitizen('ai-a', { faction: 0 });
  const b = makeCitizen('ai-b', { faction: 0 });
  const roster = makeRosterJson({ n: 3 });
  roster.ai[0].wallet = a.b58;
  roster.ai[1].wallet = b.b58;
  roster.season = SEASON;
  writeFileSync(join(aiDir, 'pub/roster.json'), JSON.stringify(roster));
  // what the model "writes" next for a session: the test sets it before each brain step
  const plan = { session: { kinds: ['build'], say: [], why: 'Building suits goal G1.' } };
  const llama = await startFakeLlama({
    respond: body => {
      const props = body.response_format.json_schema.schema.properties;
      if (props.council?.properties?.motion) return { goal_id: 'G1', choose: [], params: {}, say: [{ channel: 'nation', text: SVC_MOTION }], council: { motion: 2 }, trust: [], mem: [], why: 'Option two fits goal G1.' };
      if (props.council?.properties?.ballot) return { goal_id: 'G1', choose: [], params: {}, say: [], council: { ballot: 2 }, trust: [], mem: [], why: 'Option two fits goal G1.' };
      return sessionAnswer(body, plan.session);
    },
  });
  const herald = fakeHerald([a, b]);
  const owners = fakeOwners({
    citizens: [
      { tag: TAGS[0], faction: 0, kind: 'ai', wallet: a.b58, holdings: [{ p: 0, q: 0, site: 0, final: true }, { p: 1, q: 0, site: 1, final: true }] },
      { tag: TAGS[1], faction: 0, kind: 'ai', wallet: b.b58, holdings: [{ p: 0, q: 1, site: 2, final: true }] },
    ],
  });
  const feed = fakeFeed({ owners, through: 300, head: 300 });
  const wakes = new Map(); // "tag|turn" -> [wake]: a public clash row wakes the AI for a session one turn after its last (the gate's min_gap)
  feed.wakeEvents = (tag, turn) => wakes.get(`${tag}|${turn}`) ?? [];
  for (const t of [TAGS[0], TAGS[1]]) feed.addEvent({ kind: 'SETTLE', bell: 3, seq: t, citizen: t, displaced: null });
  const own = host({ id: 7001, owner: TAGS[0], faction: 0, tile: 30, troops: 300 });
  owners.citizenOfHost = id => (String(id) === '7001' ? TAGS[0] : null);
  // the files of turn C0 - 2: a camp at (2,0) and a stack of nation 3 at (0,1): two options for nation 0
  feed.files.set(`2,0,${C0 - 2}`, province({ p: 2, q: 0, bell: C0 - 2, camp: { tile: 44, troops: 200 } }));
  feed.files.set(`0,1,${C0 - 2}`, province({ p: 0, q: 1, bell: C0 - 2, hosts: [host({ faction: 3, tile: 20, troops: 100 })] }));
  feed.files.set(`1,0,${C0 - 2}`, province({ p: 1, q: 0, bell: C0 - 2, hosts: [own] }));
  for (const c of ball(0, 0, 5)) if (!feed.files.has(`${c.p},${c.q},${C0 - 2}`)) feed.files.set(`${c.p},${c.q},${C0 - 2}`, province({ p: c.p, q: c.q, bell: C0 - 2 }));
  const svc = await createCitizensService(
    { aiDir, herald: 'http://127.0.0.1:41940', llm: 'http://127.0.0.1:41901', mindPort: 0, socialPort: 0, servePort: 0, runId: 't', season: SEASON, genesisTs: GENESIS },
    {
      test: true, noCloserTimer: true, config: { ...CONFIG, channel_lang: 'en' }, stores: makeStores({ episodes: [makeEpisode(1)] }), renderMemory: renderMemoryDouble, renderPersona: renderPersonaDouble,
      personaOf: personaOfDouble, nameOf: nameOfDouble, feed, llm: createLlm({ url: llama.url }), socialHerald: herald,
      // the two URLs above are configuration only: the model and the herald's `me` are the doubles, and the service's own polls of the herald go nowhere
      fetch: async () => { throw new Error('no network in this test'); },
    },
  );
  svc.watcher.stop(); // the per-turn job is driven by hand (tick, releaseDue): no timer runs it in between
  const req = (who, turn) => {
    const r = JSON.parse(JSON.stringify(wire.request));
    r.bell = turn;
    r.now_game = GENESIS + turn * 600 + 60;
    r.deadline_unix_ms = Date.now() + 60_000;
    r.ai = who === 'b' ? { index: roster.ai[1].index, tag: roster.ai[1].tag, wallet: b.b58 } : { index: roster.ai[0].index, tag: roster.ai[0].tag, wallet: a.b58 };
    for (const c of r.candidates) if (c.facts?.earliest_bell != null) c.facts.earliest_bell = turn + 3; // the wire fixture's marches arrive at turn 43
    return r;
  };
  const post = async (route, body) => {
    const r = await fetch(`http://127.0.0.1:${svc.ports.social}/f/ai/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    return r.status === 200 ? { ok: true, id: j.id, bell: j.bell } : { ok: false, code: j.code, detail: j.detail };
  };
  const brain = createBrain({ citizen: a, submit: post });
  const outbox = svc.watcher.parts.outbox;
  const pendingA = async () => { for (let i = 0; i < 200; i++) { if (outbox.pendingCount(TAGS[0]) >= 1) return true; await new Promise(r => setTimeout(r, 25)); } return false; };
  /** the service up to the sealed answer, in take-2's order: the motion call is answered, then the same turn's step chooses a march */
  async function untilSealed() {
    plan.session = { kinds: ['build'], say: [], why: 'Building suits goal G1.' };
    // the mind needs the AI's last situation before a council call; that first step is a session (W-PULSE), and the next pulse is due 24
    // turns later, at C0: the march of take-2 was such a W-PULSE session
    await svc.mind.decide(req('a', C0 - 24));
    await svc.mind.decide(req('b', C0)); // another brain steps first in turn C0: the game clock is at C0
    await svc.watcher.tick(C0); // the council of nation 0 opens; the watcher asks its AIs for their motion
    assert.ok(svc.social.council.periodOf(0, 2), 'the council opened at C0');
    assert.ok(await pendingA(), 'the motion of AI a is decided and waits in the outbox');
    const motionRec = svc.records.recordsOf(C0).find(r => r.kind === 'motion' && r.ai === TAGS[0]);
    assert.deepEqual([motionRec.sealed, motionRec.public.say], [false, [SVC_MOTION]], 'the motion\'s own record is unsealed and public at once');
    plan.session = { kinds: ['march'], say: [{ channel: 'nation', text: SAY }], why: SVC_WHY };
    const sealedReq = req('a', C0);
    const sealedAns = await svc.mind.decide(sealedReq); // through server.mjs's wrapping: mind.decide, then the watcher's decorateAnswer
    return { motionRec, sealedReq, sealedAns };
  }
  return { aiDir, pub: join(aiDir, 'pub'), a, b, roster, herald, llama, svc, feed, wakes, plan, req, post, brain, outbox, untilSealed, async close() { await svc.close(); await llama.close(); } };
}

test('(a) the whole service in take-2\'s order (the motion is decided, then the same turn\'s step chooses a march): the sealed answer carries neither its own say nor the motion, the social service refuses the motion under the sealed id, and nothing of the sealed decision is public', async () => {
  const h = await boot();
  try {
    const { svc } = h;
    const { motionRec, sealedReq, sealedAns } = await h.untilSealed();
    const rec = svc.records.get(sealedAns.decision_id);
    assert.deepEqual([sealedAns.mode, rec.sealed, rec.release_bell, rec.kind], ['model', true, C0 + 4, 'session'], 'a march: sealed until turn C0 + 4');
    assert.deepEqual(svc.records.getPrivate(sealedAns.decision_id).full.public.say, [SAY], 'the model did write a say; the record keeps it for the release');
    // 1. the mind's own rule: a sealed decision's say is not handed out. 2. the carrier: the pending motion does not ride on it.
    assert.deepEqual(sealedAns.social, { say: [], motion: null, ballot: null });
    assert.equal(svc.records.provenance(sealedAns.decision_id, 0, 'talk'), null);
    assert.equal(h.outbox.pendingCount(TAGS[0]), 1, 'the motion still waits');
    assert.equal(svc.watcher.stats().outbox.outbox_held_sealed, 1);
    assert.equal((await svc.mind.decide(sealedReq)).social.motion, null, 'a same-turn repeat (the cached sealed answer) carries nothing either');
    // the brain posts what the answer carries: nothing
    assert.deepEqual(await h.brain.post(sealedAns), []);
    // 3. the acceptance: the motion signed with the AI's session key and posted under the sealed decision id (what take-2's brain did) is refused
    const exp = svc.records.provenance(motionRec.id, 0, 'talk');
    // The fixed carrier registered nothing under the sealed record, so a bare post would be refused for the OLD reason (no such item).
    // Write the item into the record as aae47bdb's carrier did: now only the acceptance rule itself stands between the post and the book.
    svc.records.getPrivate(sealedAns.decision_id).priv.social.talk.push({ item: 0, kind: exp.kind, channel: exp.channel, target: exp.target, text: exp.text, lang: exp.lang, ref: exp.ref, bell: exp.bell, seq: exp.seq });
    assert.equal(svc.records.provenance(sealedAns.decision_id, 0, 'talk'), null, 'the item is in the sealed record and the records still do not vouch for it');
    assert.equal(svc.records.consume(sealedAns.decision_id, 0, 'talk'), false);
    const bytes = encodeTalk({ season: SEASON, wallet: h.a.wallet, bell: exp.bell, seq: exp.seq, channel: exp.channel, target: exp.target, kind: exp.kind, ref: exp.ref, origin: 1, lang: exp.lang, text: exp.text });
    const forced = await h.post('talk', { bytes_b64: toBase64(bytes), sig_b64: toBase64(h.a.key.sign(bytes)), decision_id: sealedAns.decision_id, item: 0 });
    assert.deepEqual([forced.ok, forced.code], [false, 'NotFromMind'], JSON.stringify(forced));
    assert.deepEqual(svc.social.book.records.filter(r => r.wallet === h.a.b58), [], 'no social record of this AI exists');
    assert.equal(svc.social.council.publicState(0).motions.length, 0);
    // nothing of the sealed decision is public: the turn's files, the talk channel, every file under pub
    svc.records.closeBell(C0);
    svc.social.closeBell(C0);
    const pubRec = readJson(join(h.pub, 'minds', `${C0}.json`)).records.find(r => r.id === sealedAns.decision_id);
    assert.deepEqual(['public' in pubRec, 'choice' in pubRec, 'retrieved' in pubRec, typeof pubRec.commit], [false, false, false, 'string']);
    assert.deepEqual(readJson(join(h.pub, 'talk', `${C0}.json`)).records, []);
    assert.deepEqual(filesWith(h.pub, SAY), []);
    assert.deepEqual(filesWith(h.pub, SVC_WHY), []);
    assert.deepEqual(svc.watcher.stats().errors, {}, `${JSON.stringify(svc.watcher.stats().errors)} ${svc.watcher.stats().last_error}`);
  } finally { await h.close(); }
});

test('(b) the whole service after the sealed answer: the motion rides on the next turn\'s unsealed answer ahead of that answer\'s own say and is accepted with its own text, kind and reference; the release job publishes the sealed say and why in PUB/open once; verify-minds M8 passes the files', async () => {
  const h = await boot();
  try {
    const { svc } = h;
    const { motionRec, sealedAns } = await h.untilSealed();
    assert.deepEqual(await h.brain.post(sealedAns), []);
    // the march leaves: the brain's outcome, and the public DEPART row
    const c3 = svc.records.getPrivate(sealedAns.decision_id).priv.intended[0];
    assert.equal(c3.arrive_bell, C0 + 3);
    svc.mind.outcome({ decision_id: sealedAns.decision_id, actions: [{ intent: 'depart', sig: 'sig-march', status: 'sent' }] });
    h.feed.addEvent({ kind: 'DEPART', bell: C0, seq: 'd1', host_id: c3.host_id, depart_bell: C0, arrive_bell: C0 + 3, dep_mass: 500_000, origin_p: 2, origin_q: 0, origin_tile: 4 });
    // ---- turn C0 + 1: a step without a march, with a say of its own
    h.plan.session = { kinds: ['build'], say: [{ channel: 'nation', text: OWN_SAY }], why: 'Building suits goal G1.' };
    h.wakes.set(`${TAGS[0]}|${C0 + 1}`, [{ code: 'W-CLASH', seq: 'w1' }]);
    const next = await svc.mind.decide(h.req('a', C0 + 1));
    assert.deepEqual([next.mode, svc.records.get(next.decision_id).sealed], ['model', false], 'a model session that sends no march: not sealed');
    svc.records.closeBell(C0);
    svc.social.closeBell(C0);
    assert.deepEqual(next.social.say.map(x => [x.text, x.kind, x.item]), [[SVC_MOTION, 1, 1], [OWN_SAY, 0, 0]], 'the held motion first (its sequence number is the lower one), then the answer\'s own say');
    assert.equal(next.social.motion, null);
    const posted = await h.brain.post(next);
    assert.deepEqual(posted.map(x => [x.text, x.ok]), [[SVC_MOTION, true], [OWN_SAY, true]], JSON.stringify(posted));
    const mine = svc.social.book.records.filter(r => r.wallet === h.a.b58);
    assert.deepEqual(mine.map(r => [decodeTalk(r.bytes).text, decodeTalk(r.bytes).kind, Number(decodeTalk(r.bytes).ref), r.decision_id, r.item, r.bell]), [[SVC_MOTION, 1, 2 * 256 + 2, next.decision_id, 1, C0 + 1], [OWN_SAY, 0, 0, next.decision_id, 0, C0 + 1]]);
    assert.equal(mine.some(r => r.decision_id === sealedAns.decision_id), false, 'nothing is filed under the sealed decision');
    const motions = svc.social.council.publicState(0).motions;
    assert.deepEqual(motions.map(x => [x.tag, x.option, x.text]), [[TAGS[0], 2, SVC_MOTION]], 'the council has the motion, one turn after it was decided, inside the motion window');
    assert.equal(svc.records.provenance(motionRec.id, 0, 'talk').text, SVC_MOTION);
    assert.deepEqual([svc.watcher.stats().outbox.outbox_held_sealed, svc.watcher.stats().outbox.outbox_attached, svc.watcher.stats().outbox.outbox_motion_first], [1, 1, 1]);
    const row = readJson(join(h.aiDir, 'state', 'watcher', CALLS_FILE)).calls.find(r => r.kind === 'motion' && r.tag === TAGS[0]);
    assert.deepEqual([row.status, row.decided_bell, row.status_bell, row.held_sealed], ['attached', C0, C0 + 1, 1]);
    // ---- before the release: the sealed say and why are in no public file and not in the talk channel
    svc.records.closeBell(C0 + 1);
    svc.social.closeBell(C0 + 1);
    for (const turn of [C0 + 1, C0 + 2, C0 + 3]) assert.deepEqual((await svc.watcher.releaseDue(turn)).opened, []);
    assert.deepEqual(filesWith(h.pub, SAY), []);
    assert.deepEqual(filesWith(h.pub, SVC_WHY), []);
    // ---- the army arrives at C0 + 3 (the REVEAL is public); the release job of turn C0 + 4 opens the record
    const rev = { kind: 'REVEAL', bell: C0 + 3, seq: 'r1', p: 2, q: 0, arrive: C0 + 3, faction: 0, i: 0, host_id: c3.host_id, tile: 55, displace: 0, displaced_host: null };
    h.feed.reveals.set(`${c3.host_id}/${C0 + 3}`, rev);
    h.feed.addEvent(rev);
    const rel = await svc.watcher.releaseDue(C0 + 4);
    assert.deepEqual(rel.opened, [sealedAns.decision_id]);
    const opened = readJson(join(h.pub, 'open', `${C0 + 4}.json`)).records.filter(o => o.id === sealedAns.decision_id);
    assert.equal(opened.length, 1);
    assert.deepEqual(opened[0].public, { say: [SAY], why: SVC_WHY, why_withheld: null }, 'the say and the why the model wrote at the decision, published at the release');
    assert.deepEqual([opened[0].opened_bell, opened[0].destinations[0].state], [C0 + 4, 'revealed']);
    for (const turn of [C0 + 5, C0 + 6]) assert.deepEqual((await svc.watcher.releaseDue(turn)).opened, []);
    assert.deepEqual(filesWith(h.pub, SAY), [`open/${C0 + 4}.json`], 'published once, in the opened record only');
    assert.deepEqual(filesWith(h.pub, SVC_WHY), [`open/${C0 + 4}.json`]);
    assert.equal(svc.social.book.records.some(r => r.type === 'talk' && decodeTalk(r.bytes).text === SAY), false, 'the sealed say is never a talk record');
    // ---- the season-end bundle and the auditor's speech check over the public files
    svc.audit.publishSeasonEnd({ force: true });
    const m8 = await checkM8({ pub: openPub(h.pub), roster: h.roster, me: wallet => h.herald.me(wallet) });
    assert.deepEqual([m8.pass, m8.failures, m8.ai_records_checked], [true, [], 2], JSON.stringify(m8.failures));
    assert.deepEqual(svc.watcher.stats().errors, {}, `${JSON.stringify(svc.watcher.stats().errors)} ${svc.watcher.stats().last_error}`);
  } finally { await h.close(); }
});
