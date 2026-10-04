// AC8: the pure parts of the audit: canonical hashes against the production definitions, the sampler, the as-of-bell episode cap and the redaction
// order of the retrieval replay (R10), the retrieval cut, the journal replay, openings, onboarding transactions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import bs58 from 'bs58';
import { createRecords } from '../citizens/mind/records.mjs';
import { callCommit } from '../citizens/social/council.mjs';
import { socialRoot } from '../citizens/social/merkle.mjs';
import { buildOpening, destinationsOf, replayRecordsJournal } from '../citizens/audit/season_end.mjs';
import { callCommitOf, createCheck, merkleRootHex, openPub, recordIdOf, recordLeaf, resolvePubDir, sampleFrom, sealedCommit, sha256Canonical, sha256hex, socialLeaf, socialRootOfInners, verdictOf, ZERO_ROOT } from '../citizens/audit/canon.mjs';
import { comparisonForm, comparisonHash, explainRetrieved, grievancesAt, listAsOf, redactedAt, talkRowsFromPub, tombstoneMap } from '../citizens/audit/episodes.mjs';
import { gameTagOf, isOnboardingBeforeFirstRecord, memoOf } from '../citizens/verify-minds.mjs';
import { retrieve, protectedIds } from '../citizens/memory/retrieve.mjs';
import { Episodes } from '../citizens/memory/store.mjs';
import { encodeTalk, innerOf, toBase64, toHex } from '../../permutation-server/web/frontier/council/aisocial.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ai-audit-canon-'));

test('sampling is deterministic, distinct, bounded by the pool and moves with the seed (sha256(seed || u32_le(i)))', () => {
  const pool = Array.from({ length: 50 }, (_, i) => `r${i}`);
  const a = sampleFrom('ab'.repeat(32), pool, 20), b = sampleFrom('ab'.repeat(32), pool, 20), c = sampleFrom('cd'.repeat(32), pool, 20);
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, 20);
  assert.notDeepEqual(a, c);
  assert.deepEqual(sampleFrom(ZERO_ROOT, ['x', 'y'], 20).sort(), ['x', 'y'], 'a pool smaller than the sample is taken whole');
  assert.deepEqual(sampleFrom('ab'.repeat(32), [], 3), []);
  // pinned: the first pick for this seed is the pool slot u64_le(sha256(seed || 00000000)[0..8]) mod 50
  const h = crypto.createHash('sha256').update(Buffer.concat([Buffer.from('ab'.repeat(32), 'hex'), Buffer.alloc(4)])).digest();
  assert.equal(a[0], pool[Number(h.readBigUInt64LE(0) % 50n)]);
});

test('the commitment of a sealed record, the record id and the leaf are the ones AC1a\'s records.mjs produces', () => {
  const dir = tmp();
  try {
    const rec = createRecords({ aiDir: dir, runId: 't', season: 41, randomBytes: n => Buffer.alloc(n, 7) });
    const full = {
      v: 2, ai: 'aa'.repeat(8), index: 1000, bell: 5, kind: 'session', mode: 'model', reason: 'ok', wake: [], gate_score: 3, sealed: true, release_bell: 9, obs_digest: 'x', situation_hash: 's', candidates_hash: 'c', memory_hash: 'm', inbox_root: 'i',
      choice: { ids: ['c1'], params: {}, council: null, goal_id: 'G1', mem: [] }, retrieved: ['e1'], public: { say: ['hi'], why: 'because', why_withheld: null }, tx: [],
    };
    const { id, published } = rec.add(full, { candidates: [{ id: 'c1' }] });
    assert.equal(recordIdOf(published), id);
    const opened = rec.open(id);
    assert.equal(sealedCommit(opened, opened.nonce), published.commit);
    assert.notEqual(sealedCommit({ ...opened, choice: { ...opened.choice, ids: ['c2'] } }, opened.nonce), published.commit);
    assert.equal(recordLeaf(published), recordLeaf({ ...published }));
    const { root } = rec.closeBell(5);
    assert.equal(root, merkleRootHex([recordLeaf(published)]));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('call_commit and the redactable social root are the production definitions (council.mjs, merkle.mjs)', () => {
  const call = { option: 2, p: 3, q: -4, tile: 17 }, nonce = 'ab'.repeat(32);
  assert.equal(callCommitOf(call, nonce), callCommit(call, nonce));
  const inners = Array.from({ length: 5 }, (_, i) => sha256hex(`inner${i}`));
  assert.equal(socialRootOfInners(inners), toHex(socialRoot(inners.map(inner => ({ inner })))));
  assert.equal(socialRootOfInners([]), ZERO_ROOT);
  assert.equal(socialLeaf(inners[0]), sha256hex(Buffer.from([0]), Buffer.from(inners[0], 'hex')));
});

test('a check is true, false or null, and the verdict is FAIL > INCOMPLETE > PASS', () => {
  const a = createCheck('X'); a.count(); assert.equal(a.result().pass, true);
  const b = createCheck('X'); b.fail('boom'); assert.equal(b.result().pass, false);
  const c = createCheck('X'); c.unmeasured('f', 'why'); assert.equal(c.result().pass, null);
  const d = createCheck('X'); d.unverified('f', 'why'); assert.equal(d.result().pass, null);
  const e = createCheck('X'); e.skip('no llama'); assert.equal(e.result().pass, null);
  const f = createCheck('X'); f.skip('no llama'); f.fail('offline'); assert.equal(f.result().pass, false, 'a failure outranks a skip');
  assert.equal(verdictOf({ a: { pass: true } }), 'PASS');
  assert.equal(verdictOf({ a: { pass: true }, b: { pass: null } }), 'INCOMPLETE');
  assert.equal(verdictOf({ a: { pass: null }, b: { pass: false } }), 'FAIL');
});

test('--ai-dir may be PUB or AI_DIR; the pub reader returns nothing for what is not there', () => {
  const dir = tmp();
  try {
    fs.mkdirSync(path.join(dir, 'pub', 'minds'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'state'));
    assert.equal(resolvePubDir(dir).pub, path.join(dir, 'pub'));
    assert.equal(resolvePubDir(dir).aiDir, dir);
    assert.equal(resolvePubDir(path.join(dir, 'pub')).pub, path.join(dir, 'pub'));
    assert.equal(resolvePubDir(path.join(dir, 'pub')).aiDir, dir);
    const pub = openPub(path.join(dir, 'pub'));
    assert.equal(pub.commitments(), null);
    assert.equal(pub.anchors().size, 0);
    assert.deepEqual(pub.redactions(), []);
    assert.equal(pub.lastMindsRoot(), ZERO_ROOT);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- the episode replay's rules (R10)
const ep = (i, o = {}) => ({ v: 1, id: i.toString(16).padStart(16, '0'), bell: i, created_bell: i + 1, kind: 'build_done', entities: [`pq:${i % 5},0`], text: { en: `e${i}`, ja: `e${i}` }, importance: 2, src: [`event:${i}`], facts: {}, ...o });

test('R10: the 200 cap is applied as of the decision\'s bell, not to the final list', () => {
  // 205 episodes; the 5 lowest-importance, oldest ones are dropped from the FINAL list, but a decision at bell 100 could still retrieve them
  const all = Array.from({ length: 205 }, (_, i) => ep(i, { importance: i < 5 ? 1 : 2 }));
  const final = listAsOf(all);
  assert.equal(final.length, 200);
  assert.ok(!final.some(e => e.bell === 0), 'evicted from the final list');
  const asOf = listAsOf(all, { bellExclusive: 100 });
  assert.equal(asOf.length, 99, 'fewer than 200 existed then (created_bell < 100): nothing was evicted');
  assert.ok(asOf.some(e => e.bell === 0), 'a decision at bell 100 saw it');
  // and the retrieval differs: the bell-100 view can retrieve the early low-importance episode (it is among the newest 3? no: one of the top by focus)
  const early = listAsOf(all, { bellExclusive: 6 });
  assert.deepEqual(early.map(e => e.bell), [0, 1, 2, 3, 4]);
  assert.deepEqual(retrieve(early, new Set(['pq:0,0']), 6).length > 0, true);
  // a filter of the final list would have returned nothing for bell 6
  assert.equal(final.filter(e => e.created_bell < 6).length, 0);
});

test('R10: a redaction whose tombstone bell is at or before the decision blanks the episode for that decision, a later one does not; redacted episodes are never retrieved', () => {
  const all = [ep(10, { kind: 'dm', src: ['talk:aa'], importance: 4, entities: ['t1'] }), ep(11), ep(12), ep(13), ep(14)];
  const tombs = tombstoneMap([{ inner: 'aa', bell: 50, reason: 'x' }]);
  assert.equal(redactedAt(all[0], tombs, 49), false);
  assert.equal(redactedAt(all[0], tombs, 50), true);
  assert.equal(redactedAt(all[0], tombs), true);
  const before = listAsOf(all, { bellExclusive: 40, tombs, redactBell: 40 });
  const after = listAsOf(all, { bellExclusive: 60, tombs, redactBell: 60 });
  assert.equal(before.find(e => e.id === all[0].id).redacted, undefined);
  assert.equal(after.find(e => e.id === all[0].id).redacted, true);
  assert.ok(retrieve(before, new Set(['t1']), 40).includes(all[0].id));
  assert.ok(!retrieve(after, new Set(['t1']), 60).includes(all[0].id));
  // the blanked form keeps id, bell, kind and created_bell and loses text and entities; comparison forms agree on both sides
  const b = after.find(e => e.id === all[0].id);
  assert.deepEqual(Object.keys(comparisonForm(b)).sort(), ['bell', 'created_bell', 'id', 'kind', 'redacted']);
  assert.equal(comparisonHash(after), comparisonHash(after.map(e => (e.redacted ? { ...e, text: { en: 'x', ja: 'x' }, entities: ['whatever'] } : e))));
  assert.notEqual(comparisonHash(after), comparisonHash(after.map((e, i) => (i === 1 ? { ...e, text: { en: 'changed', ja: 'changed' } } : e))));
});

test('the retrieval cut: the oldest unprotected ids go first; the 3 newest and an open grievance\'s source never do', () => {
  const eps = Array.from({ length: 12 }, (_, i) => ep(i, { importance: 8 }));
  const store = new Episodes(eps);
  const ids = retrieve(store.list(), new Set(), 20);
  assert.ok(ids.length >= 8);
  const byId = new Map(store.list().map(e => [e.id, e]));
  const prot = protectedIds(byId, ids, []);
  assert.equal(prot.size, 3);
  assert.deepEqual(explainRetrieved(ids, ids, prot), { ok: true, cut: 0 });
  const cut2 = ids.filter(id => !new Set(ids.filter(x => !prot.has(x)).slice(0, 2)).has(id));
  assert.deepEqual(explainRetrieved(ids, cut2, prot), { ok: true, cut: 2 });
  // dropping a protected id, or a newer unprotected one while an older one stays, is not a cut
  assert.equal(explainRetrieved(ids, ids.slice(0, -1), prot).ok, false);
  assert.equal(explainRetrieved(ids, ids.filter((x, i) => i !== 3), prot).ok, false);
  assert.equal(explainRetrieved(ids, [...ids, 'ffffffffffffffff'], prot).ok, false);
});

test('open grievances at a decision\'s bell come from the replay: opened once their episode exists, closed by an answered delta', () => {
  const e1 = ep(5, { kind: 'attacked_own', importance: 8, created_bell: 7 });
  const deltas = [{ id: 'g1', kind: 'grievance', event: e1.id, bell: 5 }, { id: 'a1', kind: 'answered', grievance: 'g1', bell: 20 }];
  assert.deepEqual(grievancesAt([e1], deltas, 7), [], 'not yet public: created_bell 7 is not < 7');
  assert.deepEqual(grievancesAt([e1], deltas, 10), [{ id: 'g1', event: e1.id, bell: 5, answered: false }]);
  assert.equal(grievancesAt([e1], deltas, 25)[0].answered, true);
});

test('talk rows are rebuilt from the published bytes in acceptance order; a redacted entry takes its routing fields from the season-end table, never its text', () => {
  const dir = tmp();
  try {
    fs.mkdirSync(path.join(dir, 'talk'), { recursive: true });
    const wallet = Buffer.alloc(32, 9), peer = Buffer.alloc(32, 5);
    const bytes = encodeTalk({ season: 41, bell: 12, wallet, seq: 192, channel: 3, target: peer, kind: 0, ref: 0, origin: 0, lang: 'en', text: 'hello' });
    const sig = Buffer.alloc(64, 3);
    const inner = toHex(innerOf(bytes, sig));
    fs.writeFileSync(path.join(dir, 'talk', '12.json'), JSON.stringify({ bell: 12, root: 'x', records: [{ type: 'talk', id: 4, inner, bytes_b64: toBase64(bytes), sig_b64: toBase64(sig) }, { type: 'ballot', id: 5, inner: 'bb', wallet: 'w', period: 0 }, { type: 'talk', id: 6, inner: 'cc', bytes_b64: '', sig_b64: '', redacted: true }] }));
    const pub = openPub(dir);
    const rows = talkRowsFromPub(pub, { tagOfWallet: w => `tag-of-${w.slice(0, 4)}`, social: { records: [{ inner: 'cc', type: 'talk', wallet: 'W', channel: 1, target: 2, kind: 1, ref: 513, origin: 0 }] } });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].channel, 3);
    assert.equal(rows[0].bell, 12);
    assert.equal(rows[0].inner, inner);
    assert.equal(rows[1].redacted, true);
    assert.deepEqual([rows[1].channel, rows[1].target, rows[1].kind, rows[1].ref], [1, 2, 1, 513]);
    assert.ok(!JSON.stringify(rows).includes('hello') || rows[0].text === undefined, 'the producer never reads the text');
    assert.equal(talkRowsFromPub(pub, { tagOfWallet: () => 't', social: null }).length, 1, 'without the table a redacted entry cannot be replayed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- season end pieces
test('the journal replay gives the records, their merged tx and the opened flag as records.mjs restores them', () => {
  const dir = tmp();
  try {
    const rec = createRecords({ aiDir: dir, runId: 't', season: 41, randomBytes: n => Buffer.alloc(n, 1) });
    const base = { v: 2, ai: 'bb'.repeat(8), index: 1001, bell: 7, kind: 'session', mode: 'model', reason: 'ok', wake: [], gate_score: 1, sealed: true, release_bell: 12, choice: { ids: ['c1'], params: {}, council: null, goal_id: 'G1', mem: [] }, retrieved: [], public: { say: [], why: 'w', why_withheld: null }, situation_hash: 's', candidates_hash: 'c', tx: [] };
    const { id } = rec.add(base, { candidates: [{ id: 'c1' }], intended: [{ host_id: '5', arrive_bell: 11, pq: [1, 2], tile: 3 }] });
    rec.attachOutcome(id, { actions: [{ intent: 'harvest', sig: 's1', status: 'sent' }] });
    rec.attachOutcome(id, { actions: [{ intent: 'train', sig: 's2', status: 'sent' }, { intent: 'harvest', sig: 's1', status: 'sent' }] });
    rec.markOpened(id);
    const j = replayRecordsJournal(path.join(dir, 'state', 'records.jsonl'));
    const e = j.get(id);
    assert.deepEqual(e.pub.tx.map(t => t.sig), ['s1', 's2'], 'a later outcome adds to the tx list, it does not replace it');
    assert.equal(e.opened, true);
    assert.equal(e.nonce, rec.getPrivate(id).nonce);
    assert.deepEqual(e.priv.candidates, [{ id: 'c1' }]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an opening has the 7.2 fields and destinations from the public REVEAL; without a REVEAL it says unrevealed or planned', () => {
  const entry = { id: 'ee', nonce: 'aa'.repeat(16), index: 1000, bell: 40, full: { sealed: true, release_bell: 44, ai: 'tg', mode: 'model', choice: { ids: ['c3'] }, retrieved: ['m1'], public: { say: [], why: 'w' }, situation_hash: 's', candidates_hash: 'c' }, priv: { candidates: [{ id: 'c3' }], remembered: [{ id: 'm1', bell: 3, text: { en: 't' } }], intended: [{ host_id: '550859620483072', arrive_bell: 43, pq: [0, -3], tile: 27 }] } };
  const real = buildOpening(entry, { reveals: (h, a) => (h === '550859620483072' && a === 43 ? { p: 0, q: -3, tile: 27, arrive: 44 } : null) });
  assert.deepEqual(real.destinations, [{ host_id: '550859620483072', p: 0, q: -3, tile: 27, planned_arrive_bell: 43, arrive_bell: 44, source: 'reveal' }], 'the real arrival bell is shown next to the planned one');
  assert.deepEqual(Object.keys(real).sort(), ['ai', 'bell', 'candidates', 'candidates_hash', 'choice', 'destinations', 'id', 'index', 'mode', 'nonce', 'public', 'release_bell', 'remembered', 'retrieved', 'situation_hash'].sort());
  assert.equal(destinationsOf(entry, () => null)[0].source, 'unrevealed');
  assert.equal(destinationsOf(entry)[0].source, 'planned');
  assert.equal(buildOpening({ ...entry, full: { ...entry.full, sealed: false } }), null);
});

test('onboarding transactions: Join, SetSession, SetVigil and FileTicket before the AI\'s first record are not required; a later one, or any other instruction, is', () => {
  const program = 'ProgramProgramProgramProgramProgramProgram11';
  const tx = tag => ({ transaction: { message: { accountKeys: ['relay', 'session', program], header: { numRequiredSignatures: 2 }, instructions: [{ programIdIndex: 2, data: bs58.encode(Buffer.from([tag, 9])) }] } } });
  const season = { genesisTs: 1000, bellSecs: 600 };
  assert.equal(gameTagOf(tx(0x33), program), 0x33);
  assert.equal(isOnboardingBeforeFirstRecord(tx(0x33), program, 1000 + 100, 5, season), true);
  assert.equal(isOnboardingBeforeFirstRecord(tx(0x33), program, 1000 + 5 * 600, 5, season), false, 'from the first record\'s bell on, every transaction belongs to a record');
  assert.equal(isOnboardingBeforeFirstRecord(tx(0x40), program, 1000 + 100, 5, season), false, 'a harvest is never onboarding');
  assert.equal(isOnboardingBeforeFirstRecord(tx(0x30), program, 1000 + 100, undefined, season), true, 'an AI with no record at all');
});

test('a memo is read from the instruction data (base58) with its signer, slot and block time', () => {
  const tx = { slot: 9, blockTime: 123, transaction: { message: { accountKeys: ['signer', 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'], instructions: [{ programIdIndex: 1, data: bs58.encode(Buffer.from('wylls-ai/1 41 7 aa bb')) }] } } };
  assert.deepEqual(memoOf(tx), { text: 'wylls-ai/1 41 7 aa bb', signer: 'signer', slot: 9, blockTime: 123 });
  assert.equal(memoOf({ transaction: { message: { accountKeys: ['a', 'b'], instructions: [{ programIdIndex: 1, data: bs58.encode(Buffer.from('x')) }] } } }), null, 'not the memo program');
  assert.equal(sha256Canonical({ b: 1, a: [2] }), sha256hex('{"a":[2],"b":1}'));
});
