// Key-free. Workstream 12's optional public-evidence reader for an external AI resident (⑤ B; Q12-1 A, Q12-2 A):
// adapters/public-evidence-reader.mjs. Every request is a stub that records what would have been asked (no network);
// 4's store is the fixtures/ws04-receipts vectors in readWs04Store's shape (no file). No key is made, nothing signed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { b58decode, b58encode } from '../adapters/canonical.mjs';
import { parseJsonU64 } from '../adapters/ws04-receipts.mjs';
import { createPublicEvidenceReader, READER_KIND, RECALL_DEFAULT, RECALL_MAX, recallCaps } from '../adapters/public-evidence-reader.mjs';
import { createMemory } from '../src/index.mjs';

const bytes = (fill, head = []) => { const b = Buffer.alloc(32, fill); Buffer.from(head).copy(b); return b; };
const PROGRAM = b58encode(bytes(0x21)), SEASON_PDA = b58encode(bytes(0x42));
const WALLET_B = b58encode(bytes(0x0b)), WALLET_X = b58encode(bytes(0x0c));
const CITIZEN_B = b58encode(bytes(0xab, [0x77, 0, 0, 0, 0, 0, 0, 0]));
const HERALD = 'http://127.0.0.1:8080', RPC = 'http://127.0.0.1:8899';
const SEASON = { v: 1, programId: PROGRAM, cluster: 'localnet', sample: false, season: '1', seasonAddress: SEASON_PDA, genesisTs: 1_000_000, bellSecs: 600, continuous: true, latestSlot: 40, latestUnix: 1_000_000 + 200 * 600, slot: 40 };
const EVENT_ROWS = [2, 4, 6, 24].map((slot, i) => ({ seq: String(i + 1), slot, sig: `s${slot}`, kind: 1, bell: 100 + slot }));
const citizen = wallet => { const d = Buffer.alloc(384); b58decode(wallet).forEach((x, i) => { d[64 + i] = x; }); d.writeBigUInt64LE(0x77n, 208); return d.toString('base64'); };
const ME_B = { v: 1, wallet: WALLET_B, citizen: { address: CITIZEN_B, slot: 30, seq: '9', head: 'h', bytes_b64: citizen(WALLET_B) } };
const BINDING = { ws04World: 'sim-world-1', programId: PROGRAM, seasonAddress: SEASON_PDA, source: 'fixture:operator declaration' };
const RPC_BINDING = { rpcUrl: RPC, cluster: 'localnet', source: 'fixture:operator declaration' };

function storeOf(names, world = 'sim-world-1') {
  const receipts = [], runSpecs = {};
  for (const name of names) {
    const v = JSON.parse(readFileSync(new URL(`../fixtures/ws04-receipts/${name}.json`, import.meta.url), 'utf8'));
    for (const [id, spec] of Object.entries(v.run_specs_json)) runSpecs[id] = parseJsonU64(spec);
    for (const r of v.receipts) receipts.push({ run_id: r.run_id, kind: r.kind, subject: r.subject, source: r.source, slot: Number(r.slot), body: parseJsonU64(r.body_json) });
  }
  return { world, receipts, runSpecs };
}

function io({ pages = [{ v: 1, events: EVENT_ROWS, next: '4', full: false }], store = storeOf(['happy', 'raid']) } = {}) {
  const calls = [];
  return {
    calls,
    getJson: async url => {
      calls.push({ verb: 'GET', url });
      const path = url.slice(HERALD.length);
      if (path === '/h/season') return { ok: true, status: 200, body: SEASON };
      if (path.startsWith('/h/events?after=')) {
        const after = decodeURIComponent(path.slice('/h/events?after='.length));
        const i = pages.findIndex((p, k) => (k === 0 ? after === '0' : pages[k - 1].next === after));
        return i < 0 ? { ok: false, status: 400 } : { ok: true, status: 200, body: pages[i] };
      }
      if (path.startsWith('/h/me/')) { const w = decodeURIComponent(path.slice(6)); return { ok: true, status: 200, body: w === WALLET_B ? ME_B : { v: 1, wallet: w, citizen: null } }; }
      return { ok: false, status: 404 };
    },
    rpc: async (url, method, params) => { calls.push({ verb: 'RPC', url, method, params }); return 100; },
    readStore: () => { calls.push({ verb: 'STORE' }); return store; },
  };
}
const full = (i, over = {}) => createPublicEvidenceReader({ heraldUrl: HERALD, rpcUrl: RPC, rpcBinding: RPC_BINDING, storePath: '/x/runexec.sqlite', binding: BINDING,
  kinds: { herald: 'chain', rpc: 'chain', store: 'chain' }, io: i, ...over });

test('off unless asked: making a reader reads nothing; one advise is GETs under /h/, one getSlot(finalized), one store read', async () => {
  const i = io();
  const r = full(i);
  assert.equal(i.calls.length, 0, 'no request at creation');
  assert.equal(r.calls, 0);
  assert.equal(r.kind, READER_KIND);
  const a = await r.advise({ about: [WALLET_B] });
  assert.equal(r.calls, 1);
  assert.equal(a.readOnly, true);
  assert.ok(i.calls.filter(c => c.verb === 'GET').every(c => c.url.startsWith(`${HERALD}/h/`)));
  assert.deepEqual(i.calls.filter(c => c.verb === 'RPC').map(c => [c.method, c.params[0].commitment]), [['getSlot', 'finalized']]);
  assert.equal(i.calls.filter(c => c.verb === 'STORE').length, 1);
});

test('connected: the citizen is paired from /h/me and its public caravan facts are counted, with basis and sources; labels stay capped', async () => {
  const a = await full(io()).advise({ about: [WALLET_B] });
  assert.equal(a.status, 'ok', a.reasons.join(' | '));
  const b = a.about[0];
  assert.equal(b.status, 'ok');
  assert.equal(b.citizen.tag, '0000000000000077');
  assert.equal(b.facts.held, false);
  const c = b.facts.counts;
  // the happy and raid vectors: B's caravans, one sent+settled+credited, one raided
  assert.deepEqual(c, { sent: 1, settled_delivered: 1, settled_lost: 0, raided_as_sender: 1, raided_as_raider: 0, credited: 1 });
  assert.deepEqual([b.facts.recent.length, b.facts.truncated], [4, false]);
  assert.deepEqual(b.facts.recent.map(f => f.bell), [...b.facts.recent.map(f => f.bell)].sort((x, y) => y - x), 'most recent first');
  for (const f of b.facts.recent) {
    assert.ok(f.source, 'every fact names its source');
    assert.notEqual(f.basis?.kind, 'chain', 'a caller\'s chain label is never kept (observeLive caps it)');
  }
  assert.equal(a.provenance.records.kind, 'integration-output');
  assert.equal(b.own, null, 'no own memory handed in: no reputation lines');
});

test('herald only (no RPC, no store): the pairing is known, the caravan facts are unknown (held), never zero', async () => {
  const i = io();
  const a = await createPublicEvidenceReader({ heraldUrl: HERALD, io: { getJson: i.getJson } }).advise({ about: [WALLET_B] });
  assert.notEqual(a.status, 'ok');
  assert.ok(a.reasons.includes('rpc_not_given'), a.reasons.join(' | '));
  assert.ok(a.reasons.includes('ws04_store_not_given'), a.reasons.join(' | '));
  const b = a.about[0];
  assert.equal(b.status, 'ok', 'paired from the herald\'s own /h/me answer');
  assert.deepEqual([b.facts.held, b.facts.counts, b.facts.recent.length, b.facts.epistemic], [true, null, 0, 'unknown']);
  assert.ok(i.calls.every(c => c.verb === 'GET'), 'nothing but herald GETs');
});

test('a wallet the herald pairs with no citizen, and a malformed one, are identity_unverified (the malformed one is not requested)', async () => {
  const i = io();
  const a = await full(i).advise({ about: [WALLET_X, 'not a wallet'] });
  assert.deepEqual(a.about.map(x => x.status), ['identity_unverified', 'identity_unverified']);
  assert.equal(a.about[1].why, 'wallet_malformed');
  assert.ok(!i.calls.some(c => c.url?.includes('not%20a%20wallet')));
  for (const x of a.about) assert.equal(x.facts, null);
});

test('bounded recall: counterparties, facts and pages are capped per answer; extras are named, never silently read', async () => {
  assert.deepEqual(recallCaps({}), RECALL_DEFAULT);
  assert.equal(recallCaps({ counterparties: 10_000 }).counterparties, RECALL_MAX.counterparties, 'a caller cannot raise a cap past the maximum');
  assert.equal(recallCaps({ factsPerCounterparty: -1 }).factsPerCounterparty, RECALL_DEFAULT.factsPerCounterparty);
  const i = io();
  const many = [WALLET_B, ...Array.from({ length: 5 }, (_, k) => b58encode(bytes(0x30 + k)))];
  const a = await full(i, { recall: { counterparties: 2, factsPerCounterparty: 1 } }).advise({ about: many });
  assert.equal(a.about.length, 2);
  assert.deepEqual(a.recall.droppedCounterparties, many.slice(2));
  assert.equal(i.calls.filter(c => c.url?.includes('/h/me/')).length, 2, 'only the answered wallets are read');
  assert.equal(a.about[0].facts.recent.length, 1);
  assert.equal(a.about[0].facts.truncated, true);
  // a page cap smaller than the herald's history is an incomplete clock: everything held, said so
  const pages = [{ v: 1, events: EVENT_ROWS.slice(0, 2), next: '2', full: true }, { v: 1, events: EVENT_ROWS.slice(2).map((r, k) => ({ ...r, seq: String(3 + k) })), next: '4', full: false }];
  const b = await full(io({ pages }), { recall: { eventPages: 1 } }).advise({ about: [WALLET_B] });
  assert.ok(b.reasons.includes('herald_events_incomplete'), b.reasons.join(' | '));
  assert.equal(b.about[0].facts.held, true);
  const c = await full(io({ pages }), { recall: { eventPages: 2 } }).advise({ about: [WALLET_B] });
  assert.equal(c.status, 'ok', c.reasons.join(' | '));
});

test('own memory (optional): the caller\'s own lines about the wallet are added, bounded and cut, with its reliability', async () => {
  const own = createMemory();
  for (let n = 0; n < 9; n++) own.note({ owner: 'me', bell: 10 + n, about: WALLET_B, by: 'code', basis: [], text: `note ${n} ${'x'.repeat(300)}` });
  const a = await full(io(), { recall: { linesPerCounterparty: 3, textChars: 40 } }).advise({ about: [WALLET_B], own: { memory: own, viewer: { tag: 'me', nation: 1 } } });
  const o = a.about[0].own;
  assert.equal(o.lines.length, 3);
  assert.equal(o.truncated, true);
  assert.ok(o.lines.every(l => l.text.length <= 40 && l.epistemic === 'interpreted'));
  assert.equal(o.reliability.E, 0.5, 'notes are not evidence: the prior stays');
  assert.equal(own.journal.records().length, 9, 'the caller\'s memory is read, not written');
});

test('no behaviour change elsewhere: the module reads only through io and writes nothing; ⑤ A residents do not import 12', () => {
  const src = readFileSync(new URL('../adapters/public-evidence-reader.mjs', import.meta.url), 'utf8');
  // (key APIs: scripts/ci/scan-node-key-tests.mjs reads this module's whole import closure and lists any it names)
  assert.ok(!/\bfetch\(|writeFile|appendFile|node:child_process/.test(src));
  const op = readFileSync(new URL('../../../permutation-gateway/src/frontier/local-play-operator-policy.mjs', import.meta.url), 'utf8');
  assert.ok(!/12-memory/.test(op), 'the operator residents (⑤ A) stay on their own deterministic memory');
});

test('the command (tools/advise.mjs): usage errors are 64 and read nothing; an answer is one JSON line through the injected I/O', async () => {
  const { main } = await import('../tools/advise.mjs');
  const i = io();
  const err = [];
  const write = process.stderr.write;
  process.stderr.write = s => { err.push(String(s)); return true; };
  try {
    assert.equal(await main(['--about', WALLET_B], { io: i }), 64);
    assert.equal(await main(['--herald', HERALD, '--about', WALLET_B, '--rpc', RPC], { io: i }), 64, 'an RPC without its declared cluster');
    assert.equal(await main(['--herald', HERALD, '--about', WALLET_B, '--store', '/s'], { io: i }), 64, 'a store without its world declaration');
    assert.equal(await main(['--herald', HERALD, '--about', WALLET_B, '--max-facts', 'many'], { io: i }), 64);
  } finally { process.stderr.write = write; }
  assert.equal(err.length, 4);
  assert.equal(i.calls.length, 0);
  const printed = [];
  const code = await main(['--herald', HERALD, '--about', `${WALLET_B},${WALLET_X}`, '--rpc', RPC, '--rpc-cluster', 'localnet', '--rpc-source', 'test declaration',
    '--store', '/x/runexec.sqlite', '--ws04-world', 'sim-world-1', '--binding-program', PROGRAM, '--binding-season', SEASON_PDA, '--binding-source', 'test declaration',
    '--max-counterparties', '1'], { io: i, print: s => printed.push(s) });
  assert.equal(code, 0);
  assert.equal(printed.length, 1);
  const a = JSON.parse(printed[0]);
  assert.equal(a.status, 'ok', a.reasons.join(' | '));
  assert.deepEqual(a.about.map(x => x.wallet), [WALLET_B]);
  assert.deepEqual(a.recall.droppedCounterparties, [WALLET_X]);
  assert.equal(a.about[0].facts.counts.sent, 1);
});
