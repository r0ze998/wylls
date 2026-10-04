// AC1a: decision records (section 7.2): ids, sealed commitments and their opening, release bookkeeping,
// per-bell roots, PUB/minds files, late outcomes, provenance, restart.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRecords, canonicalJson, merkleRootHex, recordLeaf, publishedForm, recordId } from '../citizens/mind/records.mjs';
import { merkleRoot } from '../src/talk.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const dir = () => mkdtempSync(join(tmpdir(), 'ai-rec-'));
const rec = (over = {}) => ({
  v: 2, ai: 'aaaaaaaaaaaaaaa1', index: 1003, bell: 402, kind: 'session', mode: 'model', reason: 'ok', wake: ['W-PULSE'], gate_score: 3,
  obs_digest: 'ab', situation_hash: 'sh', candidates_hash: 'ch', memory_hash: 'mh', inbox_root: 'ir', prompt_hash: 'ph', request_hash: 'rh', output_hash: 'oh',
  attempts: 1, seed: 5, choice: { ids: ['c3'], params: {}, council: null, goal_id: 'G1', mem: ['e1'] }, retrieved: ['e1', 'e2'],
  public: { say: ['hi'], why: 'because', why_withheld: null }, latency_ms: 5000, deadline_slack_ms: 30000, quota_left: 30, ...over,
});
const fixedRandom = (n) => Buffer.alloc(n, 7);

test('an unsealed record is published in full; its id excludes tx; the same content gives the same id', () => {
  const r = createRecords({ aiDir: dir(), randomBytes: fixedRandom });
  const a = r.add(rec(), { candidates: [{ id: 'c1' }] });
  assert.equal(a.published.sealed, false);
  assert.deepEqual(a.published.choice.ids, ['c3']);
  assert.equal(a.published.id, a.id);
  assert.equal(recordId(a.published), a.id);
  const before = a.id;
  r.attachOutcome(a.id, { actions: [{ intent: 'build', sig: 'S', status: 'sent' }] });
  assert.equal(r.get(a.id).id, before, 'tx arrives later and does not change the id');
  assert.deepEqual(r.get(a.id).tx, [{ intent: 'build', sig: 'S', status: 'sent', code: null }]);
  assert.equal(r.add(rec()).duplicate, true, 'the same decision is not recorded twice');
});

test('a sealed record publishes no choice, retrieved, public, situation_hash or candidates_hash, only a commit', () => {
  const r = createRecords({ aiDir: dir(), randomBytes: fixedRandom });
  const { published, id } = r.add(rec({ sealed: true, release_bell: 410 }), { candidates: [{ id: 'c3', facts: { target: { p: 2, q: 0 } } }], remembered: [{ id: 'e1', bell: 380, text: { en: 'x', ja: 'y' } }] });
  for (const k of ['choice', 'retrieved', 'public', 'situation_hash', 'candidates_hash']) assert.equal(k in published, false, k);
  assert.equal(published.sealed, true);
  assert.equal(published.release_bell, 410);
  assert.match(published.commit, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(published).includes('because'), false);
  assert.equal(JSON.stringify(published).includes('2'.repeat(0) + '"p"'), false);
  assert.equal(published.mode, 'model');
  assert.ok('tx' in published && 'reason' in published && 'wake' in published && 'kind' in published);
  assert.ok(id);
});

test('the commit opens: sha256(canonical{situation_hash, candidates_hash, choice, retrieved, public} || nonce16)', () => {
  const r = createRecords({ aiDir: dir(), randomBytes: fixedRandom });
  const { id, published } = r.add(rec({ sealed: true, release_bell: 410 }), { candidates: [{ id: 'c3' }], remembered: [{ id: 'e1', bell: 380, text: { en: 'x', ja: 'y' } }] });
  const o = r.open(id);
  assert.equal(o.nonce, '07'.repeat(16));
  const again = sha(Buffer.concat([Buffer.from(canonicalJson({ situation_hash: o.situation_hash, candidates_hash: o.candidates_hash, choice: o.choice, retrieved: o.retrieved, public: o.public })), Buffer.from(o.nonce, 'hex')]));
  assert.equal(again, published.commit);
  assert.deepEqual(o.candidates, [{ id: 'c3' }]);
  assert.deepEqual(o.remembered, [{ id: 'e1', bell: 380, text: { en: 'x', ja: 'y' } }]);
  assert.equal(o.release_bell, 410);
});

test('open() is null for an unsealed record; dueForRelease lists sealed records once their release bell is reached, until opened', () => {
  const r = createRecords({ aiDir: dir() });
  const a = r.add(rec({ bell: 400 }));
  const b = r.add(rec({ bell: 401, sealed: true, release_bell: 410 }));
  const c = r.add(rec({ bell: 402, index: 1004, sealed: true, release_bell: 420 }));
  assert.equal(r.open(a.id), null);
  assert.deepEqual(r.dueForRelease(409), []);
  assert.deepEqual(r.dueForRelease(410), [b.id]);
  assert.deepEqual(r.dueForRelease(420).sort(), [b.id, c.id].sort());
  r.markOpened(b.id);
  assert.deepEqual(r.dueForRelease(420), [c.id]);
});

test('a sealed record needs a release bell', () => {
  const r = createRecords({ aiDir: dir() });
  assert.throws(() => r.add(rec({ sealed: true })), /release_bell/);
  assert.throws(() => r.add(rec({ kind: 'nonsense' })), /kind/);
});

test('minds_root: leaf = sha256(0x00 || sha256(canonical record)), nodes sha256(0x01 || l || r), odd carried up, empty = 32 zero bytes', () => {
  const d = dir();
  const r = createRecords({ aiDir: d });
  assert.equal(r.closeBell(500).root, '0'.repeat(64));
  const recs = [r.add(rec({ bell: 501, index: 1000 })), r.add(rec({ bell: 501, index: 1001 })), r.add(rec({ bell: 501, index: 1002 }))];
  const { root, file } = r.closeBell(501);
  const leaves = recs.map((x) => recordLeaf(x.published));
  assert.equal(root, merkleRootHex(leaves));
  // identical to the talk.mjs tree rules
  assert.equal(root, Buffer.from(merkleRoot(leaves.map((h) => new Uint8Array(Buffer.from(h, 'hex'))))).toString('hex'));
  const j = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(j.bell, 501);
  assert.equal(j.root, root);
  assert.deepEqual(j.records.map((x) => x.index), [1000, 1001, 1002]);
});

test('records are ordered by (AI index, kind, seq) inside a bell, whatever the arrival order', () => {
  const r = createRecords({ aiDir: dir() });
  r.add(rec({ bell: 600, index: 1005, kind: 'reaction' }));
  r.add(rec({ bell: 600, index: 1001, kind: 'reaction', gate_score: 1 }));
  r.add(rec({ bell: 600, index: 1001, kind: 'session', gate_score: 2 }));
  r.add(rec({ bell: 600, index: 1001, kind: 'session', gate_score: 9 }));
  const o = r.recordsOf(600).map((x) => [x.index, x.kind, x.gate_score]);
  assert.deepEqual(o, [[1001, 'session', 2], [1001, 'session', 9], [1001, 'reaction', 1], [1005, 'reaction', 3]]);
});

test('closeBell writes once and is idempotent; a later outcome goes to PUB/minds/late/<b>.json', () => {
  const d = dir();
  const r = createRecords({ aiDir: d });
  const a = r.add(rec({ bell: 700 }));
  const c1 = r.closeBell(700);
  const c2 = r.closeBell(700);
  assert.deepEqual(c1, c2);
  const bytes = readFileSync(c1.file, 'utf8');
  r.attachOutcome(a.id, { actions: [{ intent: 'depart', sig: 'LATE', status: 'sent' }] });
  assert.equal(readFileSync(c1.file, 'utf8'), bytes, 'the closed file is never rewritten');
  const late = JSON.parse(readFileSync(join(d, 'pub/minds/late/700.json'), 'utf8'));
  assert.deepEqual(late.entries, [{ id: a.id, tx: [{ intent: 'depart', sig: 'LATE', status: 'sent', code: null }] }]);
  const l = r.add(rec({ bell: 700, index: 1999 }));
  assert.equal(r.stats().late_adds, 1);
  assert.equal(JSON.parse(readFileSync(join(d, 'pub/minds/late/700.json'), 'utf8')).entries.at(-1).record.id, l.id);
});

test('a second outcome for one decision ADDS to the tx (same-bell repeat), identical entries once, in first-seen order (M7)', () => {
  const d = dir();
  const r = createRecords({ aiDir: d });
  const a = r.add(rec({ bell: 710 }));
  r.attachOutcome(a.id, { actions: [{ intent: 'build', sig: 'SIG1', status: 'sent' }, { intent: 'depart', sig: 'SIG2', status: 'sent' }] });
  r.attachOutcome(a.id, { actions: [{ intent: 'nudge', sig: 'SIG3', status: 'sent' }, { intent: 'build', sig: 'SIG1', status: 'sent' }] });
  assert.deepEqual(r.get(a.id).tx.map((t) => t.sig), ['SIG1', 'SIG2', 'SIG3']);
  // refused entries carry no sig: kept once per (intent,status,code)
  r.attachOutcome(a.id, { actions: [{ intent: 'train', status: 'refused', code: 'x' }, { intent: 'train', status: 'refused', code: 'x' }] });
  assert.equal(r.get(a.id).tx.length, 4);
  // survives a restart (journal replay)
  const r2 = createRecords({ aiDir: d });
  assert.deepEqual(r2.get(a.id).tx.map((t) => t.sig), ['SIG1', 'SIG2', 'SIG3', null]);
  // and after the bell is closed: a late second outcome still adds
  r.closeBell(710);
  r.attachOutcome(a.id, { actions: [{ intent: 'muster', sig: 'SIG4', status: 'sent' }] });
  assert.deepEqual(r.get(a.id).tx.map((t) => t.sig), ['SIG1', 'SIG2', 'SIG3', null, 'SIG4']);
});

test('provenance: the signed-ready text per (decision_id, item), consumed once', () => {
  const r = createRecords({ aiDir: dir() });
  const { id } = r.add(rec(), { social: { talk: [{ item: 0, kind: 0, channel: 1, text: 'hello', bell: 402, seq: 6432 }, { item: 1, kind: 1, channel: 1, text: 'motion', bell: 402, seq: 6433 }], ballot: [{ item: 0, option: 2, period: 4 }] } });
  assert.equal(r.provenance(id, 0, 'talk').text, 'hello');
  assert.equal(r.provenance(id, 1, 'talk').kind, 1);
  assert.equal(r.provenance(id, 5, 'talk'), null);
  assert.equal(r.provenance('nope', 0, 'talk'), null);
  assert.equal(r.provenance(id, 0, 'ballot').option, 2);
  assert.equal(r.provenance(id, 0, 'talk').consumed, false);
  assert.equal(r.consume(id, 0, 'talk'), true);
  assert.equal(r.consume(id, 0, 'talk'), false, 'a second use is a Duplicate');
  assert.equal(r.provenance(id, 0, 'talk').consumed, true);
  assert.equal(r.provenance(id, 0, 'talk').decision_bell, 402);
});

test('request bodies are stored by id under STATE only', () => {
  const d = dir();
  const r = createRecords({ aiDir: d });
  r.saveRequest('ab'.repeat(32), '{"x":1}');
  assert.equal(r.loadRequest('ab'.repeat(32)), '{"x":1}');
  assert.equal(existsSync(join(d, 'state/requests', 'ab'.repeat(32) + '.json')), true);
  assert.throws(() => r.saveRequest('../evil', 'x'));
  assert.equal(r.loadRequest('../evil'), null);
});

test('restart: the journal restores open bells, outcomes, consumption and release bookkeeping', () => {
  const d = dir();
  const r1 = createRecords({ aiDir: d, randomBytes: fixedRandom });
  const a = r1.add(rec({ bell: 800 }), { social: { talk: [{ item: 0, text: 'x' }] } });
  const s = r1.add(rec({ bell: 800, index: 1001, sealed: true, release_bell: 806 }), { candidates: [{ id: 'c3' }] });
  r1.attachOutcome(a.id, { actions: [{ intent: 'build', status: 'sent', sig: 'Z' }] });
  r1.consume(a.id, 0, 'talk');
  r1.markOpened(s.id);
  const r2 = createRecords({ aiDir: d, randomBytes: fixedRandom });
  assert.equal(r2.get(a.id).tx[0].sig, 'Z');
  assert.equal(r2.provenance(a.id, 0, 'talk').consumed, true);
  assert.deepEqual(r2.dueForRelease(900), []);
  assert.equal(r2.open(s.id).nonce, '07'.repeat(16));
  assert.equal(r2.closeBell(800).root, merkleRootHex(r2.recordsOf(800).map(recordLeaf)));
  const r3 = createRecords({ aiDir: d });
  assert.equal(r3.closeBell(800).root, r2.closeBell(800).root, 'the written file is the truth after a restart');
});

test('nothing private is written under PUB before a release (no nonce, no choice of a sealed record)', () => {
  const d = dir();
  const r = createRecords({ aiDir: d, randomBytes: fixedRandom });
  r.add(rec({ bell: 900, sealed: true, release_bell: 905, public: { say: ['SECRETWORD'], why: 'SECRETWHY', why_withheld: null } }), { candidates: [{ id: 'c3', facts: { target: { p: 77, q: 88 } } }] });
  r.closeBell(900);
  const walk = (p) => readdirSync(p, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(p, e.name)) : [join(p, e.name)]));
  for (const f of walk(join(d, 'pub'))) {
    const t = readFileSync(f, 'utf8');
    assert.equal(/SECRETWORD|SECRETWHY|"p":77|0707070707/.test(t), false, f);
  }
});

test('publishedForm is pure and deterministic', () => {
  const full = { ...rec({ sealed: true, release_bell: 3 }), tx: [] };
  assert.deepEqual(publishedForm(full, '07'.repeat(16)), publishedForm(full, '07'.repeat(16)));
  assert.notEqual(publishedForm(full, '07'.repeat(16)).commit, publishedForm(full, '08'.repeat(16)).commit);
});
