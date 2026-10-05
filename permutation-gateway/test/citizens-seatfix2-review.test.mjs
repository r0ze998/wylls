// Seatfix2 review (smoke-r4 live evidence): the findings that were real, each with a test that fails on the code before this change.
//
//  1. A council call the mind decided after the brain had stopped (the drain) was never delivered: AI 1001's ballot of period 4 (bell 99) was
//     decided, counted as a valid decision, and never posted. The delivery of every council call is now written to state/watcher/council-calls.json
//     (call_ledger.mjs) and the report shows decided / attached / expired / dropped / pending / posted.
//  2. The report did not say that the AI brains and the script bots stop at the end of play (bells 84 to 108 of smoke-r4 were the drain), so a
//     council with C0 in the drain was read as evidence about the AI. The report now has a play/drain section and a phase per council row.
//  3. The Wyll card's "decisions (valid)" counted reflections (9 of 18 were refused, so the card said valid < decisions while the report said all
//     valid): reflections have their own counters and their own card line.
//  4. A closed period with no motion said "No motion yet" (the period is over).
import './fixtures/ai-page-lang.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCallLedger, CALLS_FILE } from '../citizens/watcher/call_ledger.mjs';
import { createOutbox } from '../citizens/watcher/outbox.mjs';
import { createWatcher } from '../citizens/watcher/index.mjs';
import * as report from '../citizens/report.mjs'; // a namespace import: on the old report.mjs each test fails on its own instead of the file failing to load
const { buildReport, loadRun, renderMarkdown } = report;
const phaseSection = (...a) => report.phaseSection(...a);
const councilCallsSection = (...a) => report.councilCallsSection(...a);
const councilOutcomesSection = (...a) => report.councilOutcomesSection(...a);
import { createRecords } from '../citizens/mind/records.mjs';
import { createMemoryStore } from '../citizens/memory/store.mjs';
import { fakeFeed, fakeOwners, nameOfDouble, nationNameDouble, tmpDir } from './fixtures/ai-watcher-kit.mjs';
import { makeH } from '../../permutation-server/web/frontier/council/dom.mjs';
import { makeRosterIndex } from '../../permutation-server/web/frontier/council/badges.mjs';
import { normalizeCouncil, renderCouncil } from '../../permutation-server/web/frontier/council/ballot.mjs';
import { normalizeCard, renderCard } from '../../permutation-server/web/frontier/council/cards.mjs';
import { tl } from '../../permutation-server/web/frontier/council/lang.mjs';
import { makeFakeDocument, textOf } from './fixtures/ai-page-dom.mjs';
import { roster, card, councilState, T } from './fixtures/ai-page-kit.mjs';

const TAG = 'aaaaaaaaaaaaaaa1';
const item = (kind, period, bell, over = {}) => ({ tag: TAG, kind, period, decision_id: `d-${kind}-${period}`, bell, motion: kind === 'motion' ? { option: 1 } : null, ballot: kind === 'ballot' ? { option: 1 } : null, ...over });
const recordsDouble = () => ({
  getPrivate: () => ({ priv: {} }),
  provenance: (id) => ({ decision_id: id }),
  attachSocial: () => {},
});
const readLedger = (file) => JSON.parse(readFileSync(file, 'utf8')).calls;

// ---------------------------------------------------------------- 1. delivery of council calls
test('a council call is written to the delivery ledger as pending, attached when a brain answer carries it, expired when its window passes, and pending forever when no brain answer comes', () => {
  const dir = tmpDir('ai-seatfix2-ledger-');
  const file = join(dir, CALLS_FILE);
  const ledger = createCallLedger({ file });
  const outbox = createOutbox({ records: recordsDouble(), ledger });
  outbox.push(item('ballot', 2, 51));
  assert.equal(readLedger(file)[0].status, 'pending', 'on disk the moment it is decided');
  // the brain steps at bell 52: the item rides on its answer
  const ans = outbox.decorate({ ai: { tag: TAG }, bell: 52 }, { decision_id: 'step-1', social: {} });
  assert.ok(ans.social.ballot, 'handed to the brain');
  assert.equal(readLedger(file).find((r) => r.period === 2).status, 'attached');
  // a ballot nobody carries before its window passes
  outbox.push(item('ballot', 3, 75));
  outbox.decorate({ ai: { tag: TAG }, bell: 90 }, { decision_id: 'step-2', social: {} });
  assert.equal(readLedger(file).find((r) => r.period === 3).status, 'expired');
  // the smoke-r4 case: decided at bell 99, in the drain, no brain step after it
  outbox.push(item('ballot', 4, 99));
  const rows = readLedger(file);
  assert.deepEqual(rows.find((r) => r.period === 4), { key: `ballot:${TAG}:4`, tag: TAG, kind: 'ballot', period: 4, decision_id: 'd-ballot-4', decided_bell: 99, status: 'pending', status_bell: 99, why: null });
  assert.deepEqual(ledger.summary(), { ballot: { decided: 3, pending: 1, attached: 1, expired: 1, dropped: 0 } });
  // a restart keeps the rows
  assert.equal(createCallLedger({ file }).all().length, 3);
});

test('a ballot rides under an answer that has its own says: its item follows them (and the motion), never a second item 0 (M8 duplicate_use, pilot ai-pilot-A1)', () => {
  const attached = [];
  const records = { getPrivate: () => ({ priv: {} }), provenance: (id, it, type) => ({ decision_id: id, type, item: it }), attachSocial: (id, type, exp) => attached.push([id, type, exp.item]) };
  const outbox = createOutbox({ records });
  // an answer with one say: the say is item 0, the ballot must not be
  outbox.push(item('ballot', 2, 51));
  const a1 = outbox.decorate({ ai: { tag: TAG }, bell: 52 }, { decision_id: 'step-1', social: { say: [{ item: 0, text: 'hi' }] } });
  assert.equal(a1.social.ballot.item, 1);
  assert.deepEqual(attached.at(-1), ['step-1', 'ballot', 1], 'the provenance item is the posted item');
  // an answer with two says
  outbox.push(item('ballot', 3, 75));
  const a2 = outbox.decorate({ ai: { tag: TAG }, bell: 76 }, { decision_id: 'step-2', social: { say: [{ item: 0 }, { item: 1 }] } });
  assert.equal(a2.social.ballot.item, 2);
  // no say: item 0 as before
  outbox.push(item('ballot', 4, 99));
  assert.equal(outbox.decorate({ ai: { tag: TAG }, bell: 100 }, { decision_id: 'step-3', social: {} }).social.ballot.item, 0);
  // a motion and a ballot in one answer (rare): the motion follows the says, the ballot follows the motion
  outbox.push(item('motion', 5, 120));
  outbox.push(item('ballot', 5, 120));
  const a4 = outbox.decorate({ ai: { tag: TAG }, bell: 120 }, { decision_id: 'step-4', social: { say: [{ item: 0 }] } });
  assert.deepEqual([a4.social.motion.item, a4.social.ballot.item], [1, 2]);
});

test('an item taken but lost (no record, no provenance) is written as dropped with the reason', () => {
  const dir = tmpDir('ai-seatfix2-ledger-drop-');
  const file = join(dir, CALLS_FILE);
  const ledger = createCallLedger({ file });
  const noRecord = createOutbox({ records: { ...recordsDouble(), getPrivate: () => null }, ledger });
  noRecord.push(item('motion', 2, 49));
  noRecord.decorate({ ai: { tag: TAG }, bell: 49 }, { decision_id: 's', social: {} });
  assert.deepEqual(readLedger(file).map((r) => [r.kind, r.status, r.why]), [['motion', 'dropped', 'no_record']]);
  const noProv = createOutbox({ records: { ...recordsDouble(), provenance: () => null }, ledger });
  noProv.push(item('ballot', 2, 51));
  noProv.decorate({ ai: { tag: TAG }, bell: 51 }, { decision_id: 's2', social: {} });
  assert.equal(readLedger(file).find((r) => r.kind === 'ballot').why, 'no_provenance');
});

test('the real watcher owns a ledger: the outbox writes state/watcher/council-calls.json and the stats carry the delivery counts', () => {
  const dir = tmpDir('ai-seatfix2-watcher-ledger-');
  const wallet = 'W'.repeat(32);
  const owners = fakeOwners({ citizens: [{ tag: TAG, faction: 5, kind: 'ai', wallet, holdings: [{ p: 0, q: 0, site: 0, final: true }] }] });
  const feed = fakeFeed({ owners, through: 500, head: 500 });
  const records = createRecords({ aiDir: dir, randomBytes: (n) => Buffer.alloc(n, 9) });
  const stores = createMemoryStore({ stateDir: join(dir, 'state'), pubDir: join(dir, 'pub') });
  const ai = [{ index: 1005, tag: TAG, wallet, faction: 5, persona: 'avenger', name: { en: 'Five', ja: 'Five' } }];
  const rosterV = { ai, seat: null, byTag: (t) => ai.find((a) => a.tag === t) ?? null, byWallet: (x) => ai.find((a) => a.wallet === x) ?? null, isScript: () => false, isAi: (t) => ai.some((a) => a.tag === t) };
  const council = { config: { period: 24, offset: 0, strike_lead: 6 }, periodOf: () => null, publicOf: () => null, latest: () => null, periodAt: () => null, tick: async () => {}, open: () => { throw new Error('must not open'); } };
  const social = { subscribe: () => () => {}, book: { list: () => ({ messages: [], next: 0 }) }, council };
  const w = createWatcher({ feed, social, ledgers: stores, records, aiDir: dir, config: { council: { period: 24, offset: 0, strike_lead: 6 } }, roster: rosterV, nameOf: nameOfDouble, nationName: nationNameDouble, nowMs: () => 1e12 });
  w.parts.outbox.push(item('ballot', 4, 99));
  w.stop();
  const file = join(dir, 'state/watcher', CALLS_FILE);
  assert.ok(existsSync(file), 'the delivery is on disk');
  assert.equal(readLedger(file)[0].status, 'pending');
  assert.deepEqual(w.stats().outbox.delivery, { ballot: { decided: 1, pending: 1, attached: 0, expired: 0, dropped: 0 } });
});

// ---------------------------------------------------------------- 2. play phase, drain, delivery in the report
const BELL = 600;
function runDir({ stackLog = true, toml = null } = {}) {
  const dir = tmpDir('ai-seatfix2-phase-');
  for (const d of ['pub/minds', 'pub/council', 'state/watcher', 'fleet', 'logs']) mkdirSync(join(dir, d), { recursive: true });
  const ai = { index: 1001, tag: TAG, wallet: 'W'.repeat(32), faction: 1, persona: 'conqueror', name: { en: 'One', ja: 'One' } };
  writeFileSync(join(dir, 'pub/roster.json'), JSON.stringify({ v: 1, season: 41, ai: [ai] }));
  const rec = (id, bell, kind) => ({ id, ai: TAG, index: 1001, bell, kind, mode: 'model', reason: 'ok', tx: [], sealed: false, choice: { ids: [], council: kind === 'ballot' ? { ballot: 1 } : null, mem: [] } });
  const files = { 51: [rec('r51', 51, 'ballot')], 83: [rec('r83', 83, 'session')], 97: [rec('r97', 97, 'motion')], 99: [rec('r99', 99, 'ballot')] };
  for (const [b, records] of Object.entries(files)) writeFileSync(join(dir, `pub/minds/${b}.json`), JSON.stringify({ bell: Number(b), records }));
  if (stackLog) writeFileSync(join(dir, 'logs/stack.log'), `frontier-stack: season 41 created (genesis 1000000); play until ${1000000 + 84 * BELL}, drain until ${1000000 + 110 * BELL}\n`);
  if (toml) writeFileSync(join(dir, 'stack.toml'), toml);
  writeFileSync(join(dir, 'fleet/ai-brain.json'), JSON.stringify({ counters: { 'social_posted:ballot': 1, 'social_posted:talk': 3, steps: 84 }, per_bot: {} }));
  writeFileSync(join(dir, 'pub/council/2-1.json'), JSON.stringify({ period: 2, faction: 1, c0: 48, adopted: false, ballots_cast: 1, tally_split: { ai: 1, human: 0, scripted: 0 } }));
  writeFileSync(join(dir, 'pub/council/4-1.json'), JSON.stringify({ period: 4, faction: 1, c0: 96, adopted: false, ballots_cast: 0, tally_split: { ai: 0, human: 0, scripted: 0 } }));
  writeFileSync(join(dir, 'state/watcher/council-outcomes.json'), JSON.stringify({ v: 1, kind: 'council-open-outcomes', periods: { 2: { 1: { status: 'opened', reason: null, c0: 48, bell: 49, detail: null } }, 4: { 1: { status: 'opened', reason: null, c0: 96, bell: 97, detail: null } } } }));
  writeFileSync(join(dir, 'state/watcher', CALLS_FILE), JSON.stringify({ v: 1, kind: 'council-call-delivery', calls: [
    { key: `ballot:${TAG}:2`, tag: TAG, kind: 'ballot', period: 2, decision_id: 'r51', decided_bell: 51, status: 'attached', status_bell: 52, why: null },
    { key: `motion:${TAG}:4`, tag: TAG, kind: 'motion', period: 4, decision_id: 'r97', decided_bell: 97, status: 'pending', status_bell: 97, why: null },
    { key: `ballot:${TAG}:4`, tag: TAG, kind: 'ballot', period: 4, decision_id: 'r99', decided_bell: 99, status: 'pending', status_bell: 99, why: null },
  ] }));
  return dir;
}

test('the report tells the play phase from the drain (from the stack log) and counts what was decided in the drain', () => {
  const run = loadRun(runDir());
  const p = phaseSection(run);
  assert.equal(p.available, true);
  assert.equal(p.source, 'logs/stack.log');
  assert.equal(p.play_end_bell, 84);
  assert.equal(p.drain_closed_bells, 99 - 84 + 1, 'last closed bell 99, first drain bell 84');
  assert.equal(p.records_in_drain, 2);
  assert.deepEqual(p.records_in_drain_by_kind, { 'motion:model': 1, 'ballot:model': 1 });
  assert.match(p.note, /play: bells 0 to 83 \(84 bells\); drain: bells 84 to 99/);
  assert.match(p.note, /brains and the script bots stop at the end of play/);
});

test('without a stack log the phase comes from stack.toml; with neither it says it does not know', () => {
  const t = phaseSection(loadRun(runDir({ stackLog: false, toml: 'game_hours = 14\ndrain_bells = 26\n' })));
  assert.deepEqual({ available: t.available, source: t.source, play_end_bell: t.play_end_bell, drain_end_bell: t.drain_end_bell }, { available: true, source: 'stack.toml', play_end_bell: 84, drain_end_bell: 110 });
  const none = phaseSection(loadRun(runDir({ stackLog: false })));
  assert.equal(none.available, false);
  assert.match(none.note, /not told apart/);
});

test('every council row carries its phase: a council whose C0 is in the drain is marked drain', () => {
  const sec = councilOutcomesSection(loadRun(runDir()));
  const at = (k) => sec.rows.find((r) => r.period === k && r.nation === 1);
  assert.equal(at(2).phase, 'play');
  assert.equal(at(4).phase, 'drain');
});

test('the report shows what became of the council calls: 2 decided in the drain and never carried, the ballot decided but not posted is visible', () => {
  const dir = runDir();
  const cc = councilCallsSection(loadRun(dir));
  assert.equal(cc.ballot.decided_by_mind, 2);
  assert.equal(cc.ballot.attached, 1);
  assert.equal(cc.ballot.pending_never_carried, 1);
  assert.equal(cc.ballot.decided_in_drain, 1);
  assert.equal(cc.ballot.posted_by_brain, 1);
  assert.equal(cc.ballot.ai_ballots_in_council_files, 1);
  assert.equal(cc.ballot_decisions_not_posted, 1, 'decided 2, posted 1');
  assert.equal(cc.motion.pending_never_carried, 1);
  assert.equal(cc.motion.decided_in_drain, 1);
  const md = renderMarkdown(buildReport({ aiDir: dir }));
  assert.match(md, /## Play phase and drain/);
  assert.match(md, /Decision records made in the drain: 2/);
  assert.match(md, /What became of the council calls/);
  assert.match(md, /\| ballot \| 2 \| 1 \| 0 \| 0 \| 1 \| 1 \| 1 \| 1 \|/);
  assert.match(md, /\| 4 \| 1 \| drain \| council \|/);
  // --public-only does not read the operator's ledger and says so
  const pub = councilCallsSection(loadRun(dir, { privateOk: false }));
  assert.equal(pub.ballot.attached, null);
  assert.match(pub.note, /public-only/);
});

test('a run from before the ledger says so and still shows decided against posted', () => {
  const dir = runDir();
  writeFileSync(join(dir, 'state/watcher', CALLS_FILE), 'not json');
  const cc = councilCallsSection(loadRun(dir));
  assert.match(cc.note, /predates the delivery ledger/);
  assert.equal(cc.ballot.decided_by_mind, 2);
  assert.equal(cc.ballot.posted_by_brain, 1);
  assert.equal(cc.ballot_decisions_not_posted, 1);
});

// ---------------------------------------------------------------- 3. the card keeps reflections apart
const h = makeH(makeFakeDocument());
const index = makeRosterIndex(roster(), { scriptTags: [T.s0] });
const ctxOf = (lang) => ({ h, t: (k, v) => tl(lang, k, v), lang, index, resolve: null });

test('the Wyll card prints reflections on their own line, in both languages, and "decisions (valid)" stays the session/motion/ballot count', () => {
  const c = normalizeCard(card(T.ai0, { stats: { decisions: 9, valid: 9, reflections: 4, reflections_ok: 2, actions_by_model: 3, actions_by_autopilot: 1, model_marches: 0, model_marches_opened: 0, messages: 0, strikes_declined: 0, decisions_citing_memory: 2, mem_dropped: 0 } }));
  const en = textOf(renderCard(ctxOf('en'), c, index.aiByTag(T.ai0), {}));
  assert.match(en, /decisions 9 \(valid 9\)/);
  assert.match(en, /reflections 4 \(2 accepted\)/);
  const ja = textOf(renderCard(ctxOf('ja'), c, index.aiByTag(T.ai0), {}));
  assert.match(ja, /振り返り 4（2 件採用）/);
});

// ---------------------------------------------------------------- 4. a closed period without a motion
test('a closed period with no motion says so in the past tense; an open one still says "No motion yet"', () => {
  const none = (over) => normalizeCouncil(councilState({ motions: [], ...over }));
  const ctx = (lang) => ({ h, t: (k, v) => tl(lang, k, v), lang, index, resolve: null });
  const view = (c) => ({ council: c, bell: 56, faction: 0, me: null, mine: null, note: '', slots: {}, draft: { option: 1, text: '' }, onDraft() {}, onNation() {}, onVote() {}, onMotion() {} });
  assert.match(textOf(renderCouncil(ctx('en'), view(none({ state: 'closed' })))), /No motion was made in this period\./);
  assert.match(textOf(renderCouncil(ctx('en'), view(none({ state: 'motions' })))), /No motion yet\./);
  assert.match(textOf(renderCouncil(ctx('ja'), view(none({ state: 'closed' })))), /この期間に動議は出されなかった/);
});
