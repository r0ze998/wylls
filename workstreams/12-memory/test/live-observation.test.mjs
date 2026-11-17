// Workstream 12's live observation (adapters/live-observation.mjs), with every request stubbed (2026-11-16).
// SOURCE-ONLY when first written (2026-11-16): not run in the session that wrote it. The `full`-shape tests below
// (2026-11-17) were written without being run by their author; the coordinator then ran this single file with the
// nokey preload (tools/nokey-guard.mjs): 11 passed, 0 failed, 0 skipped (Node v23.11.0). The command and result are
// recorded in docs/integration/CLAUDE-WS12-EVENT-PAGE-SHAPE-20261117.md.
// Its listing in tools/keyfree-tests.txt was not checked or changed by that edit.
// No network: io.getJson / io.rpc are stubs that record what would have been asked. No file: io.readStore returns a
// store built from fixtures/ws04-receipts (the shape readWs04Store returns). No key is made, nothing is signed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { b58decode, b58encode } from '../adapters/canonical.mjs';
import { parseJsonU64 } from '../adapters/ws04-receipts.mjs';
import { baseUrl, capKind, LABEL_CAP, observeLive, readFinalizedSlot, readHerald, RPC_METHODS } from '../adapters/live-observation.mjs';

const bytes = (fill, head = []) => { const b = Buffer.alloc(32, fill); Buffer.from(head).copy(b); return b; };
const PROGRAM = b58encode(bytes(0x21)), SEASON_PDA = b58encode(bytes(0x42));
const WALLET_B = b58encode(bytes(0x0b));
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

/** Stub I/O: herald answers from `routes`, the RPC answers `slot`; every call is recorded. */
function io({ season = SEASON, pages = [{ v: 1, events: EVENT_ROWS, next: '4', full: false }], me = { [WALLET_B]: ME_B }, slot = 100, store = storeOf(['happy', 'raid']), status = {} } = {}) {
  const calls = [];
  return {
    calls,
    getJson: async url => {
      calls.push({ verb: 'GET', url });
      const path = url.slice(HERALD.length);
      if (status[path]) return { ok: false, status: status[path] };
      if (path === '/h/season') return season ? { ok: true, status: 200, body: season } : { ok: false, status: 503 };
      if (path.startsWith('/h/events?after=')) {
        const after = decodeURIComponent(path.slice('/h/events?after='.length));
        const i = pages.findIndex((p, k) => (k === 0 ? after === '0' : pages[k - 1].next === after));
        return i < 0 ? { ok: false, status: 400 } : { ok: true, status: 200, body: pages[i] };
      }
      if (path.startsWith('/h/me/')) { const w = decodeURIComponent(path.slice(6)); return me[w] ? { ok: true, status: 200, body: me[w] } : { ok: true, status: 200, body: { v: 1, wallet: w, citizen: null } }; }
      return { ok: false, status: 404 };
    },
    rpc: async (url, method, params) => { calls.push({ verb: 'RPC', url, method, params }); return slot; },
    readStore: () => { calls.push({ verb: 'STORE' }); if (store instanceof Error) throw store; return store; },
  };
}
const observe = (over = {}, ioOver = {}) => {
  const i = io(ioOver);
  return observeLive({ heraldUrl: HERALD, rpcUrl: RPC, storePath: '/x/runexec.sqlite', binding: BINDING, rpcBinding: RPC_BINDING, wallets: [WALLET_B],
    kinds: { herald: 'chain', rpc: 'chain', store: 'integration-output' }, io: i, ...over }).then(o => ({ o, calls: i.calls }));
};

test('connected: the world and the Season clock; a caller\'s chain label is lowered (herald, RPC, store), never kept', async () => {
  const { o, calls } = await observe({ kinds: { herald: 'chain', rpc: 'chain', store: 'chain' } });   // a caller who states the store is chain
  assert.equal(o.status, 'ok');
  assert.deepEqual(o.world, { cluster: 'localnet', world_id: `${PROGRAM}/${SEASON_PDA}` });
  assert.deepEqual([o.clock.genesisTs, o.clock.bellSecs], [1_000_000, 600]);
  assert.equal(o.provenance.records.kind, 'integration-output', '4\'s executor is a simulation: never raised to chain');
  assert.equal(LABEL_CAP, 'integration-output');
  for (const part of ['world', 'clock', 'identity', 'finality']) assert.equal(o.provenance[part].kind, 'integration-output', `${part}: a label alone is not chain`);
  assert.equal(o.inputs.lowered.length, 3, o.inputs.lowered.join(' | '));
  assert.equal(o.provenance.finality.commitment, 'finalized'); assert.equal(o.provenance.finality.slot, 100);
  assert.equal(o.observedBell, 200);
  assert.equal(o.inputs.eventsComplete, true);
  assert.ok(o.identity.walletKnown(WALLET_B));
  // what was asked: GETs to the herald, one getSlot(finalized), one store read
  assert.ok(calls.filter(c => c.verb === 'GET').every(c => c.url.startsWith(`${HERALD}/h/`)));
  assert.deepEqual(calls.filter(c => c.verb === 'RPC').map(c => [c.method, c.params]), [['getSlot', [{ commitment: 'finalized' }]]]);
  assert.equal(calls.filter(c => c.verb === 'STORE').length, 1);
});

test('kinds are capped, never raised: an unknown kind is no statement; a sample Season is a fixture', async () => {
  assert.equal(capKind('chain', 'integration-output'), 'integration-output');
  assert.equal(capKind('fixture', 'integration-output'), 'fixture');
  assert.equal(capKind('final', 'chain'), null);
  assert.equal(capKind(undefined), null);
  const { o } = await observe({}, { season: { ...SEASON, sample: true, cluster: 'fixture' } });
  // cluster 'fixture' is not the rpc binding's cluster: no finality either
  assert.equal(o.provenance.world.kind, 'fixture');
  assert.equal(o.provenance.finality, null);
  const unstated = await observe({ kinds: {} });
  assert.deepEqual([unstated.o.provenance.world, unstated.o.provenance.records, unstated.o.provenance.finality], [null, null, null]);
});

test('no finality without a declared RPC <-> cluster pairing; every receipt is held with the reason', async () => {
  for (const [rpcBinding, why] of [[null, 'rpc_cluster_undeclared'], [{ ...RPC_BINDING, source: '' }, 'rpc_cluster_undeclared'],
    [{ ...RPC_BINDING, cluster: 'mainnet' }, 'rpc_binding_names_another_cluster'], [{ ...RPC_BINDING, rpcUrl: 'http://other:8899' }, 'rpc_binding_names_another_endpoint']]) {
    const { o, calls } = await observe({ rpcBinding });
    assert.ok(o.reasons.includes(why), `${why}: ${o.reasons}`);
    assert.equal(o.status, 'held');
    assert.ok(o.held.length > 0 && o.held.every(h => h.why === 'no_finality_attestation'));
    assert.equal(calls.filter(c => c.verb === 'RPC').length, 0, 'no RPC request without the pairing');
    assert.equal(o.ingest, null);
  }
  for (const slot of [null, -1, 1.5, '100', 2 ** 53]) {
    const { o } = await observe({}, { slot });
    assert.ok(o.reasons.includes('rpc_slot_malformed')); assert.equal(o.status, 'held');
  }
});

test('the store and the world: unbound, undeclared, another world, unreadable: held with the reason', async () => {
  for (const [over, ioOver, why] of [[{}, { store: storeOf(['happy'], null) }, 'ws04_store_world_unbound'], [{ binding: null }, {}, 'world_binding_undeclared'],
    [{}, { store: storeOf(['happy'], 'sim-world-2') }, 'ws04_store_bound_to_another_world']]) {
    const { o } = await observe(over, ioOver);
    assert.equal(o.status, 'held'); assert.ok(o.held.every(h => h.why === why), `${why}: ${JSON.stringify(o.held[0])}`);
  }
  const { o } = await observe({}, { store: new Error('SQLITE_CANTOPEN') });
  assert.equal(o.status, 'held'); assert.ok(o.reasons.some(r => r.startsWith('ws04_store_unreadable:')));
  assert.deepEqual(o.held, []);
});

test('a slot the herald\'s events place in no bell, or past the finalized slot, is held (never interpolated, never final)', async () => {
  const { o } = await observe({}, { pages: [{ v: 1, events: EVENT_ROWS.filter(e => e.slot !== 24), next: '3', full: false }] });
  assert.ok(o.held.some(h => h.why === 'clock_unmapped'), JSON.stringify(o.held));
  const late = await observe({}, { slot: 4 });
  assert.ok(late.o.held.some(h => h.why === 'not_finalized'), JSON.stringify(late.o.held));
});

test('the herald\'s answers: a missing Season is no world; a page limit or a stalled page is an incomplete clock, said so', async () => {
  const none = await observe({}, { season: null });
  assert.equal(none.o.status, 'world_unverified'); assert.equal(none.o.memory, null); assert.ok(none.o.reasons.includes('season_http_503'));
  const pages = [{ v: 1, events: EVENT_ROWS.slice(0, 2), next: '2', full: true }, { v: 1, events: EVENT_ROWS.slice(2), next: '4', full: false }];
  const cut = await observe({ maxEventPages: 1 }, { pages });
  assert.equal(cut.o.inputs.eventsComplete, false); assert.ok(cut.o.reasons.includes('events_page_limit'));
  assert.ok(cut.o.held.length > 0 && cut.o.held.every(h => h.why === 'herald_events_incomplete')); assert.equal(cut.o.ingest, undefined);
  const both = await observe({}, { pages });
  assert.equal(both.o.inputs.eventPages, 2); assert.equal(both.o.inputs.eventsComplete, true);
  const stall = await observe({}, { pages: [{ v: 1, events: [], next: '0', full: true }] });
  assert.ok(stall.o.reasons.includes('events_next_did_not_advance'));
  for (const bad of [{ v: 2, events: [], next: '0', full: false }, { v: 1, events: {}, next: '0', full: false }, { v: 1, events: [], next: 5, full: false }]) {
    const r = await readHerald({ base: HERALD, getJson: async u => (u.includes('/h/events') ? { ok: true, body: bad } : { ok: true, body: SEASON }) });
    assert.ok(r.why.includes('events_malformed'));
  }
});

test('a page whose `full` is not a boolean (missing, null, string, number) is malformed: never a complete clock, nothing taken in', async () => {
  const { full: _drop, ...noFull } = { v: 1, events: EVENT_ROWS, next: '4', full: false };
  const badFirst = [['missing', noFull], ['null', { ...noFull, full: null }], ['string', { ...noFull, full: 'true' }], ['number', { ...noFull, full: 1 }]];
  const receiptCount = storeOf(['happy', 'raid']).receipts.length;
  assert.ok(receiptCount > 0);
  const firstValid = { v: 1, events: EVENT_ROWS.slice(0, 2), next: '2', full: true };
  for (const [label, bad] of badFirst) {
    // directly: the first page alone
    const r = await readHerald({ base: HERALD, getJson: async u => ({ ok: true, body: u.includes('/h/events') ? bad : SEASON }) });
    assert.ok(r.why.includes('events_malformed'), `${label}: ${r.why}`);
    assert.equal(r.eventsComplete, false, label); assert.equal(r.eventPages, 0, label); assert.deepEqual(r.events, [], label);
    assert.ok(!r.why.includes('events_page_limit'), label);
    // directly: a valid full=true page, then a second page with the bad `full`
    const second = { ...bad, events: EVENT_ROWS.slice(2) };
    const r2 = await readHerald({ base: HERALD, getJson: async u => ({ ok: true, body: !u.includes('/h/events') ? SEASON : u.endsWith('after=0') ? firstValid : second }) });
    assert.ok(r2.why.includes('events_malformed'), `${label} second: ${r2.why}`);
    assert.equal(r2.eventsComplete, false, `${label} second`); assert.equal(r2.eventPages, 1, `${label} second`);
    // end to end: every receipt held, nothing ingested, no journal record, no provenance
    for (const [where, pages] of [['first', [bad]], ['second', [firstValid, second]]]) {
      const { o } = await observe({}, { pages });
      const tag = `${label} ${where}`;
      assert.ok(o.reasons.includes('events_malformed'), `${tag}: ${o.reasons}`);
      assert.ok(o.reasons.includes('herald_events_incomplete'), tag);
      assert.equal(o.status, 'held', tag); assert.equal(o.inputs.eventsComplete, false, tag);
      assert.equal(o.held.length, receiptCount, `${tag}: every receipt held`);
      assert.ok(o.held.every(h => h.why === 'herald_events_incomplete'), tag);
      assert.equal(o.ingest, undefined, tag); assert.equal(o.provenance, null, tag);
      assert.equal(o.memory.journal.records().length, 0, `${tag}: the memory took in nothing`);
    }
  }
  // a boolean `full` still pages as before: true, then false, is complete
  const flow = await observe({}, { pages: [firstValid, { v: 1, events: EVENT_ROWS.slice(2), next: '4', full: false }] });
  assert.equal(flow.o.inputs.eventPages, 2); assert.equal(flow.o.inputs.eventsComplete, true);
  assert.ok(!flow.o.reasons.includes('events_malformed')); assert.equal(flow.o.status, 'ok'); assert.notEqual(flow.o.provenance, null);
});

test('pagination that repeats, goes back, skips, mislabels `next` or fails midway holds every receipt; nothing is read as "no record"', async () => {
  const row = (seq, slot) => ({ seq: String(seq), slot, sig: `s${slot}`, kind: 1, bell: 100 + slot });
  const cases = [
    [[{ v: 1, events: [row(1, 2), row(1, 2)], next: '1', full: false }], 'events_seq_repeated'],
    [[{ v: 1, events: [row(1, 2), row(3, 4)], next: '3', full: false }], 'events_seq_skipped'],
    [[{ v: 1, events: [row(2, 2)], next: '2', full: false }], 'events_seq_skipped'],
    [[{ v: 1, events: [row(1, 2), row(2, 4)], next: '2', full: true }, { v: 1, events: [row(2, 4)], next: '2', full: false }], 'events_seq_repeated'],
    [[{ v: 1, events: [row(1, 2), row(2, 4)], next: '2', full: true }, { v: 1, events: [row(1, 2)], next: '1', full: false }], 'events_seq_went_back'],
    [[{ v: 1, events: [row(1, 2), row(2, 4)], next: '9', full: false }], 'events_next_not_the_last_row'],
    [[{ v: 1, events: [{ ...row(1, 2), seq: 1 }], next: '1', full: false }], 'events_seq_malformed'],
  ];
  for (const [pages, why] of cases) {
    const { o } = await observe({}, { pages });
    assert.ok(o.reasons.includes(why), `${why}: ${o.reasons}`);
    assert.equal(o.inputs.eventsComplete, false); assert.equal(o.status, 'held');
    assert.ok(o.held.length > 0 && o.held.every(h => h.why === 'herald_events_incomplete'));
    assert.equal(o.provenance, null, 'nothing was taken in');
  }
  // a second page that fails: the first page's slots are not used either
  const midway = await observe({}, { pages: [{ v: 1, events: EVENT_ROWS.slice(0, 2), next: '2', full: true }], status: { '/h/events?after=2': 503 } });
  assert.ok(midway.o.reasons.includes('events_http_503')); assert.ok(midway.o.held.every(h => h.why === 'herald_events_incomplete'));
  assert.equal(midway.o.memory.journal.records().length, 0, 'the memory took in nothing');
});

test('/h/me: a malformed wallet is not requested; an answer for another wallet or no citizen pairs nobody', async () => {
  const asked = [];
  const r = await readHerald({ base: HERALD, wallets: ['not base58!', WALLET_B], getJson: async u => { asked.push(u); return { ok: true, body: u.includes('/h/me/') ? { ...ME_B, wallet: PROGRAM } : u.includes('/h/events') ? { v: 1, events: [], next: '0', full: false } : SEASON }; } });
  assert.ok(!asked.some(u => u.includes('not')));
  assert.deepEqual(r.meRefused.map(x => x.why), ['wallet_malformed', 'me_malformed']);
  const { o } = await observe({}, { me: {} });
  assert.equal(o.identity.walletKnown(WALLET_B), null);
});

test('urls: http(s) only, no query, credentials or fragment', async () => {
  for (const u of ['ftp://x', 'http://u:p@x', 'http://x/?a=1', 'http://x/#f', 'not a url', null]) assert.equal(baseUrl(u), null, String(u));
  assert.equal(baseUrl('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080');
  assert.equal((await readFinalizedSlot({ rpcUrl: 'file:///x', rpc: () => 1, rpcBinding: RPC_BINDING, season: SEASON, world: {} })).why, 'rpc_url_malformed');
});

test('the source: one RPC read; nothing written; no absence concluded; no credit made (pinned as text)', () => {
  const s = readFileSync(new URL('../adapters/live-observation.mjs', import.meta.url), 'utf8');
  assert.deepEqual([...RPC_METHODS], ['getSlot']);
  assert.doesNotMatch(s, /coverageFromHistory\(|writeFileSync|appendFileSync|\.observe\(|\.say\(|credited|sign\(|Keypair/);
  assert.match(s, /createMemory\(\{ world: W\.world, partitions: W\.partitions \}\)/, 'no path: an in-process memory only');
  assert.match(s, /capKind\(kinds\.store, 'integration-output'\)/);
  assert.match(s, /capKind\(kinds\.herald, LABEL_CAP\)/); assert.match(s, /capKind\(kinds\.rpc, LABEL_CAP\)/);
  assert.doesNotMatch(s, /capKind\(kinds\.(herald|rpc)\)/, 'no uncapped label');
  // Arrival time is not a clock here: 4's CaravanView.arrive_slot (u64, compared as a slot) and the chain's
  // ARRIVE_TS (i64 unix seconds, frontier-abi v2 s1.rs @180; the herald's arrive_ts) are not converted into each
  // other. A receipt's bell comes only from its own record slot through the herald's events.
  for (const f of ['../adapters/live-observation.mjs', '../adapters/ws04-receipts.mjs', '../adapters/canonical.mjs']) {
    assert.doesNotMatch(readFileSync(new URL(f, import.meta.url), 'utf8'), /arrive_?(slot|ts)|arriveTs|arriveSlot|ARRIVE_TS/i, f);
  }
});
