// FB4 (fix unit for the council page and the council options). One test per finding of the wave-B page review, each of
// them FAILING on the code of frontier/ai-integ 0cc0973 (the notes name the failure). Where a producer exists in the
// tree, the test is fed by the REAL producer, not by a hand-made file:
//   E1  the clash rows of citizens/watcher/events_pub.mjs build() (real feed over the captured herald rows)
//   late files: citizens/mind/records.mjs (closeBell, attachOutcome, add)
//   not_sent: citizens/watcher/release.mjs releaseState()
//   redaction: citizens/social/book.mjs redact() and its redactions.json
// Everything else is SYNTHETIC in the shapes of ai-page-kit.mjs (and says so in its title).
import './fixtures/ai-page-lang.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeH } from '../../permutation-server/web/frontier/council/dom.mjs';
import { makeRosterIndex, badgedSegments } from '../../permutation-server/web/frontier/council/badges.mjs';
import { normalizeEvents, renderEvents } from '../../permutation-server/web/frontier/council/events.mjs';
import { normalizeMinds, normalizeOpenFile, normalizeEpisodes, normalizeLate, applyLate, planLateProbes, planOpenProbes, decisionList, buildDecision, renderDecisions } from '../../permutation-server/web/frontier/council/decisions.mjs';
import { normalizeTalk, mergeTalk, normalizeRedactions, applyRedactions, talkSignature, renderFeed } from '../../permutation-server/web/frontier/council/feed.mjs';
import { signerRefusal, chooseSavedKey } from '../../permutation-server/web/frontier/council/keys.mjs';
import { normalizeCard, renderCard } from '../../permutation-server/web/frontier/council/cards.mjs';
import { normalizeCouncil, renderCouncil, ratioWord } from '../../permutation-server/web/frontier/council/ballot.mjs';
import { tl } from '../../permutation-server/web/frontier/council/lang.mjs';
import { makeFakeDocument, textOf, byClass, findAll, hasActiveContent } from './fixtures/ai-page-dom.mjs';
import { roster, card, W, T, sealedRecord, openedRecord, councilState, episodeText } from './fixtures/ai-page-kit.mjs';
import { createFeed } from '../citizens/watcher/feed.mjs';
import { createEventsPub } from '../citizens/watcher/events_pub.mjs';
import { createRecords } from '../citizens/mind/records.mjs';
import { releaseState } from '../citizens/watcher/release.mjs';
import { createBook } from '../citizens/social/book.mjs';
import { startFakeHerald } from './fixtures/ai-herald-fake.mjs';
import { fakeRoster, nameOfDouble } from './fixtures/ai-watcher-kit.mjs';
import { SEASON, builders, fakeHerald, makeCitizen, makeClock, tmpAiDir } from './fixtures/ai-social-kit.mjs';

const h = makeH(makeFakeDocument());
const index = makeRosterIndex(roster(), { scriptTags: [T.s0] });
const ctxOf = (lang = 'en', over = {}) => ({ h, t: (k, v) => tl(lang, k, v), lang, index, resolve: null, ...over });
const minds = recs => normalizeMinds({ records: recs });
const openedMap = recs => new Map(normalizeOpenFile({ records: recs }).map(o => [o.id, o]));

// ---------------------------------------------------------------- E1: the clash panel against the REAL events_pub output
test('E1: a clash built by the real events_pub.build() prints each actor\'s troops after the clash and its fate, and says "losses are not in this file", never "no troops lost recorded"', async () => {
  const herald = await startFakeHerald();
  try {
    const feed = createFeed({ herald: herald.url });
    await feed.poll();
    const pub = createEventsPub({ feed, roster: fakeRoster({ ai: [] }), nameOf: nameOfDouble, pubDir: join(mkdtempSync(join(tmpdir(), 'fb4-ev-')), 'pub'), window: 2000, cap: 2000 });
    const built = JSON.parse(JSON.stringify(await pub.build(feed.headBell()))); // the file as it is served
    const clashes = built.events.filter(e => e.kind === 'clash' && e.actors.length);
    assert.ok(clashes.length >= 1, 'the captured rows hold a clash with actors');
    assert.ok(clashes.every(c => !('lost' in c) && c.actors.every(a => !('lost' in a))), 'premise: the producer writes no `lost` (the page must not wait for one)');
    const rows = normalizeEvents(built);
    const first = rows.find(r => r.kind === 'clash' && r.actors.length);
    const src = clashes.find(c => c.p === first.at.p && c.q === first.at.q && c.bell === first.bell);
    assert.deepEqual(first.actors.map(a => [a.after, a.fate, a.faction]), src.actors.map(a => [a.troops_after, a.fate, a.faction]), 'normalizeEvents reads troops_after, fate and faction of the actors');
    const text = textOf(renderEvents(ctxOf('en'), rows));
    assert.doesNotMatch(text, /no troops lost recorded/);
    assert.match(text, /losses are not in this file/);
    assert.match(text, /\d+ troops after the clash/);
    assert.match(text, /bounced/, 'the captured clash at (-5,6) has a Bounced fighter');
    assert.match(text, /stayed/);
    const ja = textOf(renderEvents(ctxOf('ja'), rows));
    assert.match(ja, /損失はこのファイルにありません/);
    assert.match(ja, /衝突後の兵\d+/);
  } finally { await herald.close(); }
});

test('E1: a row that does carry per-nation losses still prints them; a hostile fate or troops_after is dropped, never printed (synthetic)', () => {
  const rows = normalizeEvents({ events: [
    { kind: 'clash', bell: 12, p: 1, q: 2, engagements: 2, lost: { 0: 100, 1: 220 }, actors: [{ tag: T.ai0, fate: 'Stays', troops_after: 50 }] },
    { kind: 'clash', bell: 13, p: 1, q: 3, engagements: 1, actors: [{ tag: T.ai1, fate: '<img src=x onerror=alert(1)>', troops_after: '<script>alert(2)</script>', arrived: 'yes' }] },
  ] });
  const node = renderEvents(ctxOf('en'), rows);
  const text = textOf(node);
  assert.match(text, /Aster lost 100, Borealis lost 220/);
  assert.match(text, /50 troops after the clash · stayed/);
  const [hostile, plain] = rows; // newest bell first
  assert.equal(plain.actors[0].fate, 'Stays');
  assert.deepEqual([hostile.actors[0].fate, hostile.actors[0].after, hostile.actors[0].arrived], [null, null, null]);
  assert.doesNotMatch(text, /onerror|<script>/);
  assert.equal(hasActiveContent(node), null);
  // the badge still comes from the roster only: a file's own `ai` or `kind` flag changes nothing
  const forged = normalizeEvents({ events: [{ kind: 'clash', bell: 1, actors: [{ tag: T.human, ai: true, kind: 'ai', fate: 'Stays', troops_after: 5 }] }] });
  assert.equal(findAll(renderEvents(ctxOf('en'), forged), e => e.className.includes('badge-ai')).length, 0);
});

// ---------------------------------------------------------------- B1 (page side): the strength printed is `enemy`
test('B1: the page prints `enemy` as the target strength; a file without it says so instead of printing `value`; the ratio fallback divides by enemy (synthetic)', () => {
  const state = councilState({ options: [
    { option: 1, kind: 'camp', p: -2, q: 3, value: 110, own: 200, enemy: 220, ratio: 'even' },
    { option: 2, kind: 'strike', p: 1, q: 4, value: 500, own: 600, ratio: 'even' }, // an earlier file: no `enemy`
  ] });
  const node = renderCouncil(ctxOf('en'), { council: normalizeCouncil(state), bell: 50, faction: 0, me: null, mine: null, note: '', slots: {}, draft: { option: 1, text: '' }, onDraft() {}, onNation() {}, onVote() {}, onMotion() {} });
  const [a, b] = byClass(node, 'option');
  assert.match(textOf(a), /target strength 220/);
  assert.doesNotMatch(textOf(a), /target strength 110/, 'half the camp is the ranking key, not the strength');
  assert.match(textOf(b), /target strength: not in this file/);
  assert.doesNotMatch(textOf(b), /target strength 500/);
  assert.equal(ratioWord({ own: 150, value: 100, enemy: 200 }), 'unfavourable', 'no word in the file: own / enemy = 0.75, not own / value = 1.5');
  assert.equal(ratioWord({ own: 150, value: 100 }), 'even', 'an earlier file without enemy keeps the old reading');
});

// ---------------------------------------------------------------- E2: the contract's ASCII apostrophe
test('E2: "AI\'s words" and the card\'s summary label use the ASCII apostrophe of the contract in both places they are printed', () => {
  assert.equal(tl('en', 'dec.words'), "AI's words (model-written, not verified)");
  assert.equal(tl('en', 'card.summary_label'), "Written by the AI's model; not verified, not replayed.");
  const dec = textOf(renderDecisions(ctxOf('en'), decisionList({ minds: minds([sealedRecord()]), opened: openedMap([openedRecord()]) })));
  assert.ok(dec.includes("AI's words (model-written, not verified)"));
  assert.ok(!dec.includes('AI’s words'), 'no curly apostrophe');
});

// ---------------------------------------------------------------- badges from the roster only, with or without entities
test('badges: a cited line gets its roster badge beside every citizen name even when the record carries no entities and the episode list has not loaded (synthetic)', () => {
  const opened = openedRecord({ choice: { ids: ['c3'], params: {}, council: null, goal_id: 'G1', mem: ['a1e34dee94bb1e02'] }, remembered: [{ id: 'a1e34dee94bb1e02', bell: 388, text: episodeText.attacked }] });
  const node = renderDecisions(ctxOf('en'), decisionList({ minds: minds([sealedRecord()]), opened: openedMap([opened]) /* no episodesByTag: not loaded */ }));
  const rem = byClass(node, 'remembered-block')[0];
  assert.match(textOf(rem), /Elrin Somere AI/);
  assert.equal(findAll(rem, e => e.className.includes('badge-ai')).length, 1);
  // Japanese name too
  const ja = renderDecisions(ctxOf('ja'), decisionList({ minds: minds([sealedRecord()]), opened: openedMap([opened]) }));
  assert.ok(findAll(byClass(ja, 'remembered-block')[0], e => e.className.includes('badge-ai')).length >= 1);
});

test('badges: the roster scan also finds the seat and the script bots by their derived names, never a citizen the roster does not list; the name lookups are cached (synthetic)', () => {
  const names = { [T.seat]: 'Aria Voss', [T.s0]: 'Gorm Tavik', [T.human]: 'Pell Narrow' };
  let calls = 0;
  const resolve = (tag, lang, full) => { calls++; return full ? (names[tag] ?? null) : null; };
  const line = 'Gorm Tavik, Aria Voss and Pell Narrow marched; Elrin Somere watched.';
  const segs = badgedSegments(line, [], index, 'en', { resolve });
  const badges = segs.filter(s => s.badge).map(s => s.badge).sort();
  assert.deepEqual(badges, ['ai', 'script', 'seat'], 'AI, script and seat badges; the unlisted human has none');
  const before = calls;
  badgedSegments(line, [], index, 'en', { resolve });
  assert.equal(calls, before, 'a second line asks the identity module for nothing it already answered');
  assert.equal(badgedSegments(line, [], index, 'en', { resolve, scanRoster: false }).filter(s => s.badge).length, 0, 'entities-only reading is still available');
});

test('Remembered: an id not found while the AI\'s episode list is still loading is "not loaded yet", not "not in the published list" (synthetic)', () => {
  const opened = openedRecord({ choice: { ids: ['c3'], params: {}, council: null, goal_id: 'G1', mem: ['ffffffffffffffff'] }, remembered: [] });
  const rec = minds([sealedRecord()])[0];
  const op = normalizeOpenFile({ records: [opened] })[0];
  const loading = buildDecision({ rec, opened: op, episodes: null });
  const loaded = buildDecision({ rec, opened: op, episodes: normalizeEpisodes({ episodes: [] }) });
  assert.deepEqual([loading.remembered[0].missing, loading.remembered[0].loading], [true, true]);
  assert.deepEqual([loaded.remembered[0].missing, loaded.remembered[0].loading], [true, false]);
  const lt = textOf(renderDecisions(ctxOf('en'), [loading]));
  const dt = textOf(renderDecisions(ctxOf('en'), [loaded]));
  assert.match(lt, /the episode list has not loaded yet/);
  assert.doesNotMatch(lt, /not in the published list/);
  assert.match(dt, /is not in the published list/);
});

// ---------------------------------------------------------------- redaction reaches an open page (real book)
test('redaction: a tombstone written by the real book after the page fetched a row blanks that row on the open page and changes the feed panel\'s signature', async () => {
  const clock = makeClock();
  const dir = tmpAiDir();
  const alice = makeCitizen('alice', { faction: 0 });
  const bob = makeCitizen('bob', { faction: 0 });
  const book = createBook({ aiDir: dir.dir, roster: { season: SEASON, ai: [], script: { wallets: [] }, seat: null }, season: SEASON, clock, herald: fakeHerald([alice, bob]) });
  const b = builders(clock);
  const r1 = await book.submit('talk', b.talk(alice, { text: 'keep me' }).body);
  const r2 = await book.submit('talk', b.talk(bob, { text: 'forget me' }).body);
  // what the page holds: the rows as the live API served them before the redaction
  let rows = normalizeTalk(JSON.parse(JSON.stringify(book.list())));
  assert.deepEqual(rows.map(r => r.text), ['keep me', 'forget me']);
  assert.equal(rows[1].inner, r2.inner, 'the page keeps `inner` to match tombstones');
  const sigBefore = JSON.stringify(talkSignature(rows));
  assert.equal(applyRedactions(rows, new Set()).changed, false);
  // the operator redacts one record
  book.redact([{ inner: r2.inner, bell: 402, reason: 'operator request' }]);
  const file = JSON.parse(readFileSync(join(dir.pub, 'redactions.json'), 'utf8'));
  const tombs = normalizeRedactions(file);
  assert.deepEqual([...tombs], [r2.inner]);
  const a = applyRedactions(rows, tombs);
  assert.equal(a.changed, true);
  rows = a.rows;
  assert.deepEqual(rows.map(r => [r.redacted, r.text]), [[false, 'keep me'], [true, '']]);
  assert.equal(rows[0], applyRedactions(rows, tombs).rows[0], 'rows that are not named are the same objects');
  assert.notEqual(JSON.stringify(talkSignature(rows)), sigBefore, 'the feed panel re-renders when a row turns redacted (its signature was the ids only)');
  const text = textOf(renderFeed(ctxOf('en'), rows));
  assert.doesNotMatch(text, /forget me/);
  assert.match(text, /keep me/);
  // a refetch that still carries the old text can never un-redact a row
  const merged = mergeTalk(rows, normalizeTalk({ messages: [{ ...book.list().messages[1], redacted: false, text: 'forget me' }] }));
  assert.deepEqual(merged.map(r => [r.redacted, r.text]), [[false, 'keep me'], [true, '']]);
  void r1;
});

// ---------------------------------------------------------------- late files (real records) and the open index
test('late files: a transaction reported after the bell closed (the real minds/late/<b>.json) reaches the "Sent:" line, and a late-added record shows; each transaction once', () => {
  const d = mkdtempSync(join(tmpdir(), 'fb4-late-'));
  const r = createRecords({ aiDir: d });
  const base = { v: 2, ai: T.ai0, index: 1000, bell: 700, kind: 'session', mode: 'model', reason: 'ok', wake: ['W-PULSE'], gate_score: 3, obs_digest: 'ab', situation_hash: 'sh', candidates_hash: 'ch', memory_hash: 'mh', inbox_root: 'ir', prompt_hash: 'ph', request_hash: 'rh', output_hash: 'oh', attempts: 1, seed: 5, sealed: true, release_bell: 710, choice: { ids: ['c3'], params: {}, council: null, goal_id: 'G1', mem: [] }, retrieved: [], public: { say: [], why: 'w', why_withheld: null }, latency_ms: 5, deadline_slack_ms: 1, quota_left: 30 };
  const a = r.add(base);
  const closed = r.closeBell(700);
  r.attachOutcome(a.id, { actions: [{ intent: 'depart', sig: 'SIG-LATE', status: 'sent' }] });
  const late2 = r.add({ ...base, index: 1001, ai: T.ai1, kind: 'reaction', sealed: false, release_bell: null });
  const closedFile = JSON.parse(readFileSync(closed.file, 'utf8'));
  const lateFile = JSON.parse(readFileSync(join(d, 'pub/minds/late/700.json'), 'utf8'));
  const plain = normalizeMinds(closedFile);
  assert.equal(plain.length, 1);
  assert.deepEqual(plain[0].tx, [], 'premise: the closed file has no transaction');
  const text0 = textOf(renderDecisions(ctxOf('en'), decisionList({ minds: plain, opened: new Map() })));
  assert.doesNotMatch(text0, /Sent:/);
  const merged = applyLate(plain, [normalizeLate(lateFile)]);
  assert.equal(merged.length, 2, 'the late-added record is appended');
  assert.deepEqual(merged[0].tx.map(x => [x.intent, x.status]), [['depart', 'sent']]);
  assert.ok(merged.some(x => x.id === late2.id));
  assert.match(textOf(renderDecisions(ctxOf('en'), decisionList({ minds: merged, opened: new Map(), showAutopilot: true }))), /Sent: march/);
  // reading the same late file twice, or a closed-file record that already has the transaction, adds nothing
  assert.deepEqual(applyLate(merged, [normalizeLate(lateFile), normalizeLate(lateFile)])[0].tx.length, 1);
  assert.equal(applyLate(merged, [normalizeLate(lateFile)]).length, 2);
  // malformed late files give nothing
  assert.deepEqual(normalizeLate(null), { bell: null, adds: [], tx: new Map() });
  assert.deepEqual(applyLate(plain, [normalizeLate({ entries: [null, 7, { id: 5 }] })]).map(x => x.tx.length), [0]);
});

test('late probes: each of the last 8 closed bells once per page bell; open probes: with the index only the listed bells are fetched, nothing blind', () => {
  assert.deepEqual(planLateProbes({ bellNow: 20 }), [19, 18, 17, 16, 15, 14, 13, 12]);
  assert.deepEqual(planLateProbes({ bellNow: 20, checkedAt: new Map([[19, 20], [18, 19]]) }), [18, 17, 16, 15, 14, 13, 12], 'asked in this bell already: skipped; asked in an earlier bell: again');
  assert.deepEqual(planLateProbes({ bellNow: 3 }), [2, 1, 0]);
  // open/index.json (the release job's own list)
  const sealed = [{ id: 'a', releaseBell: 410 }];
  assert.deepEqual(planOpenProbes({ sealed, bellNow: 420, index: [] }), [], 'an index without bells: no probes at all (the blind plan would have asked for 8 files)');
  assert.deepEqual(planOpenProbes({ sealed, bellNow: 420, index: [412, 415] }), [415, 412]);
  assert.deepEqual(planOpenProbes({ sealed, bellNow: 420, index: [412, 415], have: new Set([415]) }), [412]);
  assert.deepEqual(planOpenProbes({ sealed, bellNow: 420, index: [412, 415], missedAt: new Map([[415, 420]]) }), [412], 'a listed file that failed is asked again in the next bell');
  assert.deepEqual(planOpenProbes({ sealed, bellNow: 420, index: [10, 415, 999] }), [415], 'not the far past (lookback), not a bell in the future');
  assert.ok(planOpenProbes({ bellNow: 500, index: Array.from({ length: 60 }, (_, i) => 440 + i) }).length <= 8, 'bounded per poll');
  assert.deepEqual(planOpenProbes({ sealed, bellNow: 412 }), [412, 411, 410], 'without the index the old plan still works');
});

// ---------------------------------------------------------------- not_sent (real releaseState)
test('not_sent: a march the brain never sent opens as not_sent (the real releaseState); the page says "This march was not sent." and shows no destination; `marched` follows the state', () => {
  const entry = { full: { release_bell: 410, tx: [{ intent: 'build', status: 'sent' }] }, priv: { intended: [{ host_id: '7', arrive_bell: 409, via: 'model' }] } };
  const st = releaseState({ entry, bell: 410, find: { depart: () => null, reveal: () => null } });
  assert.equal(st.destinations[0].state, 'not_sent', 'premise: what the release job writes');
  const opened = openedRecord({ destinations: st.destinations, destination: undefined });
  const dec = decisionList({ minds: minds([sealedRecord({ tx: [{ intent: 'build', sig: 's', status: 'sent', code: null }] })]), opened: openedMap([opened]) })[0];
  assert.equal(dec.notSent, true);
  assert.equal(dec.marched, false);
  assert.deepEqual(dec.destinations, []);
  assert.equal(dec.unrevealed, false);
  const text = textOf(renderDecisions(ctxOf('en'), [dec]));
  assert.match(text, /This march was not sent\./);
  assert.doesNotMatch(text, /Destination:/);
  assert.match(textOf(renderDecisions(ctxOf('ja'), [dec])), /この進軍は送信されませんでした/);
  // a revealed march is a march
  const ok = releaseState({ entry: { full: { release_bell: 410, tx: [{ intent: 'depart', status: 'sent' }] }, priv: entry.priv }, bell: 411, find: { depart: () => ({ arrive_bell: 410, depart_bell: 409 }), reveal: () => ({ p: -2, q: 3, tile: 5 }) } });
  const dec2 = decisionList({ minds: minds([sealedRecord()]), opened: openedMap([openedRecord({ destinations: ok.destinations })]) })[0];
  assert.deepEqual([dec2.marched, dec2.notSent, dec2.destinations.length], [true, false, 1]);
  assert.doesNotMatch(textOf(renderDecisions(ctxOf('en'), [dec2])), /not sent/);
});

// ---------------------------------------------------------------- the presenter key
test('keys: a key whose wallet is an AI citizen of the roster is refused; only the seat\'s saved key is chosen, never another wallet\'s (synthetic)', () => {
  assert.equal(signerRefusal(index, { wallet: W.ai0 }), 'ai_key');
  assert.equal(signerRefusal(index, { wallet: W.seat }), null);
  assert.equal(signerRefusal(index, { wallet: W.human }), null, 'a citizen the roster does not list may be pasted');
  assert.equal(signerRefusal(index, null), null);
  const found = [{ wallet: W.human, seedHex: 'a'.repeat(64) }, { wallet: W.ai0, seedHex: 'b'.repeat(64) }];
  assert.deepEqual(chooseSavedKey(found, index), { ok: false, code: 'noseat' }, 'no seat key saved: another wallet\'s key is not taken');
  assert.deepEqual(chooseSavedKey([], index), { ok: false, code: 'nosaved' });
  assert.deepEqual(chooseSavedKey([...found, { wallet: W.seat, seedHex: 'c'.repeat(64) }], index).key.wallet, W.seat);
  assert.deepEqual(chooseSavedKey(found, makeRosterIndex(null)), { ok: false, code: 'noseat' }, 'no seat in the roster: nothing is chosen for the person');
  assert.match(tl('en', 'keys.err.ai_key'), /never signs as an AI citizen/);
  assert.match(tl('ja', 'keys.err.noseat'), /鍵ファイルを貼り付けて/);
});

// ---------------------------------------------------------------- card labels
test('card labels: an unknown `by` is not "model"; an autopilot reason prints "no model words (autopilot)" and not the model-written label; the summary label is the page\'s own (synthetic)', () => {
  const c = normalizeCard(card(T.ai0, {
    memory: { ...card().memory, summary: { bell: 432, text: 'I hold.', sha256: 'cd'.repeat(32), label: { en: 'Verified by the operator.', ja: '検証済み' } } },
    revealed_reasons: [
      { bell: 402, decision_id: 'd'.repeat(64), by: 'model', why: 'MODEL-REASON', remembered: [] },
      { bell: 403, decision_id: 'e'.repeat(64), why: 'NO-BY-REASON', remembered: [] },
      { bell: 404, decision_id: 'f'.repeat(64), by: 'autopilot', why: '', remembered: [] },
    ],
  }));
  assert.deepEqual(c.reasons.map(r => r.by), ['model', null, 'autopilot']);
  const node = renderCard(ctxOf('en'), c, index.aiByTag(T.ai0), {});
  const reasons = byClass(node, 'reason');
  assert.equal(reasons.length, 3);
  const byBell = n => reasons.find(r => textOf(r).includes(`bell ${n}`));
  const model = textOf(byBell(402)), unknown = textOf(byBell(403)), auto = textOf(byBell(404));
  assert.match(model, /by: model/);
  assert.match(model, /AI's words \(model-written, not verified\)/);
  assert.match(unknown, /by: unknown/);
  assert.doesNotMatch(unknown, /by: model/);
  assert.match(auto, /by: autopilot/);
  assert.match(auto, /no model words \(autopilot\)/);
  assert.doesNotMatch(auto, /model-written|The model wrote no reason/);
  const text = textOf(node);
  assert.match(text, /Written by the AI's model; not verified, not replayed\./);
  assert.doesNotMatch(text, /Verified by the operator|検証済み/, 'the card file cannot replace the summary label');
});
