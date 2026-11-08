// Receipt-chain module tests. The golden vectors are REAL runtime-handler receipts and chained headers captured by
// the supervisor from the audited v3 host (commit 07ae3f0d); see the golden file's provenance. They are not signing
// fixtures and nothing here generates a key, signs, builds, spawns or contacts anything. Records marked SYNTHETIC
// below are built with this module's own encoder to exercise creation/close semantics, not to claim host output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ReceiptError, ENTITY, KIND, KINDS, NON_CHAIN_KINDS, MAX_BODY, HEAD_LEN, LINK_LEN, HOST_KEY_LEN, DEPARTED_PAYLOAD_LEN,
  TRANSIT_SETTLED_PAYLOAD_LEN, TRANSIT_SETTLED_DEST_AT, WIDE_CHAIN_DOMAIN, MAX_RECORDS,
  decodeRecord, encodeRecord, nextHead, advance, verifyChain, verifyReceiptChains, parseChainHeader,
  chainHeaderOfAccount, chainHeaderFromAccounts, provinceKeyHex, holdingRefHex,
} from '../screens/wide-march-local/local-receipts.mjs';

const G = JSON.parse(await readFile(new URL('./wide-march-local-receipts.golden.json', import.meta.url), 'utf8'));
const R = G.responses;
const at = cmd => R.findIndex(r => r.command === cmd);
const ROLES = [['holding', ENTITY.HOLDING], ['origin', ENTITY.PROVINCE], ['destination', ENTITY.PROVINCE]];
const chainsBetween = (i, j, { roles = ROLES, edit = {} } = {}) => roles.map(([role, entity]) => ({
  label: role, entity, targetHex: G.targets[role], before: R[i].headers[role], after: R[j].headers[role], ...(edit[role] ?? {}),
}));
const NON_CHAIN = { post_reveal: [KIND.REVEALED], resolve_arrival: [KIND.GATHERED] };
const step = (cmd, { records, edit, ...extra } = {}) => {
  const j = at(cmd);
  return verifyReceiptChains({ records: records ?? R[j].recordsHex, chains: chainsBetween(j - 1, j, { edit }), nonChainKinds: NON_CHAIN[cmd] ?? [], ...extra });
};
const code = c => e => { assert.ok(e instanceof ReceiptError, `not a ReceiptError: ${e}`); assert.equal(e.code, c, e.message); return true; };
const byteAt = (hex, i) => parseInt(hex.slice(2 * i, 2 * i + 2), 16);
const setByte = (hex, i, v) => hex.slice(0, 2 * i) + v.toString(16).padStart(2, '0') + hex.slice(2 * i + 2);
const flip = (hex, i) => setByte(hex, i, byteAt(hex, i) ^ 1);
const setBytes = (hex, from, to, v) => { for (let i = from; i < to; i++) hex = setByte(hex, i, v); return hex; };
const le64hex = v => { let s = ''; for (let i = 0n; i < 8n; i++) s += ((v >> (8n * i)) & 0xffn).toString(16).padStart(2, '0'); return s; };
const withChain = (header, seq, headHex) => header.slice(0, 48) + le64hex(seq) + headHex;
const ZERO = '00'.repeat(32);
const HARVEST = R[at('harvest')].recordsHex[0], DEPARTED = R[at('depart')].recordsHex[0];
const SETTLE = R[at('settle_departure')].recordsHex, TRANSIT = R[at('settle_transit')].recordsHex[0];
const ARRIVAL_RESOLVE = R[at('resolve_arrival')].recordsHex[1];

const EXPECT = {
  harvest: { kinds: [15], bells: [6], consumed: { holding: [0], origin: [], destination: [] } },
  depart: { kinds: [7], bells: [6], consumed: { holding: [0], origin: [0], destination: [] } },
  settle_departure: { kinds: [3, 3, 9], bells: [5, 6, 8], consumed: { holding: [2], origin: [0, 1, 2], destination: [] } },
  post_reveal: { kinds: [10], bells: [21], consumed: { holding: [], origin: [], destination: [] }, nonChain: [0] },
  resolve_arrival: { kinds: [11, 3], bells: [22, 20], consumed: { holding: [], origin: [], destination: [1] }, nonChain: [0] },
  settle_transit: { kinds: [8], bells: [23], consumed: { holding: [0], origin: [], destination: [0] } },
  dissolve_return: { kinds: [3, 2, 3, 3, 4], bells: [21, 23, 22, 23, 25], consumed: { holding: [1, 4], origin: [], destination: [0, 1, 2, 3, 4] } },
};
const SEQS = { holding: [2, 3, 4, 5, 5, 5, 6, 8], origin: [7, 7, 8, 11, 11, 11, 11, 11], destination: [19, 19, 19, 19, 19, 20, 21, 26] };

test('ABI widths, link sets and the chain domain are event.rs\'s', () => {
  assert.equal(HEAD_LEN, 6); assert.equal(LINK_LEN, 41); assert.equal(HOST_KEY_LEN, 106);
  assert.equal(DEPARTED_PAYLOAD_LEN, 71); assert.equal(TRANSIT_SETTLED_PAYLOAD_LEN, 82); assert.equal(TRANSIT_SETTLED_DEST_AT, 32);
  assert.equal(MAX_BODY, HEAD_LEN + HOST_KEY_LEN + 82 + 1 + 2 * LINK_LEN);
  assert.equal(WIDE_CHAIN_DOMAIN, 'PSF-WIDE-CHAIN-v1');
  assert.deepEqual(Object.values(KINDS).map(k => k.payloadLen), [15, 9, 71, 6, 5, 40, 71, 82, 11, 12, 12, 47, 41, 40, 80, 80]);
  assert.deepEqual(Object.values(KINDS).map(k => k.links.join('')), ['12', '12', '1', '12', '1', '', '12', '12', '12', '', '', '', '', '1', '2', '12']);
  assert.deepEqual(Object.values(KINDS).map(k => k.keyLen), [106, 106, 50, 106, 106, 50, 106, 106, 106, 106, 50, 50, 106, 50, 56, 56]);
  assert.deepEqual(NON_CHAIN_KINDS, [6, 10, 11, 12, 13]);
});

test('golden: every real receipt decodes strictly, is attributed by its full key, and re-encodes byte for byte', () => {
  for (const [cmd, want] of Object.entries(EXPECT)) {
    const recs = R[at(cmd)].recordsHex.map(decodeRecord);
    assert.deepEqual(recs.map(r => r.kind), want.kinds, cmd);
    assert.deepEqual(recs.map(r => r.bell), want.bells, cmd);
    R[at(cmd)].recordsHex.forEach((hex, i) => {
      const r = recs[i];
      assert.equal(encodeRecord({ kind: r.kind, bell: r.bell, keyHex: r.keyHex, payloadHex: r.payloadHex, links: r.links }), hex, `${cmd} ${i}`);
      assert.equal(r.chained, r.links.length > 0);
    });
  }
  const h = decodeRecord(HARVEST);
  assert.equal(h.name, 'WIDE_ECONOMY'); assert.equal(h.hostHex, null);
  assert.equal(h.holdingHex, G.targets.holding); assert.equal(h.provinceHex, G.targets.origin, 'an owner action happens at home');
  const d = decodeRecord(DEPARTED);
  assert.equal(d.provinceHex, G.targets.origin); assert.equal(d.holdingHex, G.targets.holding); assert.equal(d.homeHex, G.targets.origin);
  const s = decodeRecord(TRANSIT);
  assert.equal(s.provinceHex, G.targets.destination, 'attributed where it happened'); assert.equal(s.sealedDestHex, G.targets.destination); assert.equal(s.homeHex, G.targets.origin);
  const ret = decodeRecord(R[at('dissolve_return')].recordsHex[4]);
  assert.equal(ret.name, 'WIDE_RETURN'); assert.equal(ret.provinceHex, G.targets.destination); assert.equal(ret.homeHex, G.targets.origin);
  assert.equal(decodeRecord(R[at('post_reveal')].recordsHex[0]).chained, false);
  // bytes are accepted as well as hex
  assert.equal(decodeRecord(Buffer.from(HARVEST, 'hex')).bodyHex, HARVEST);
});

test('golden: each real transition verifies from the previous response\'s headers through its receipts to the next', () => {
  for (const [cmd, want] of Object.entries(EXPECT)) {
    const rep = step(cmd, { kinds: want.kinds });
    const j = at(cmd);
    assert.equal(rep.verifies, 'WIDE_EVENT_CHAINS_ONLY');
    assert.deepEqual(rep.nonChainRecords, want.nonChain ?? [], cmd);
    assert.deepEqual(rep.unverifiedLinks, [], cmd);
    for (const c of rep.chains) {
      assert.deepEqual(c.consumed, want.consumed[c.label], `${cmd} ${c.label}`);
      assert.equal(c.after.seq, BigInt(SEQS[c.label][j]), `${cmd} ${c.label}`);
      assert.equal(c.created, false); assert.equal(c.closed, false);
      if (!c.consumed.length) assert.deepEqual(c.after, c.before, `${cmd}: an untouched chain is identical`);
    }
  }
  // get: no receipts, nothing moves
  const none = verifyReceiptChains({ records: [], chains: chainsBetween(0, 0) });
  assert.ok(none.chains.every(c => c.consumed.length === 0));
});

test('golden: the whole run verifies in one pass from get to dissolve_return', () => {
  const all = R.flatMap(r => r.recordsHex);
  const rep = verifyReceiptChains({ records: all, chains: chainsBetween(0, R.length - 1), nonChainKinds: [KIND.REVEALED, KIND.GATHERED] });
  const by = Object.fromEntries(rep.chains.map(c => [c.label, c.consumed]));
  assert.deepEqual(by.holding, [0, 1, 4, 8, 10, 13]);
  assert.deepEqual(by.origin, [1, 2, 3, 4]);
  assert.deepEqual(by.destination, [7, 8, 9, 10, 11, 12, 13]);
  assert.deepEqual(rep.nonChainRecords, [5, 6]);
  // the bare ABI port over the same bodies
  const h0 = parseChainHeader(R[0].headers.holding, ENTITY.HOLDING), h7 = parseChainHeader(R[7].headers.holding, ENTITY.HOLDING);
  const v = verifyChain({ entity: ENTITY.HOLDING, keyHex: G.targets.holding }, { seq: h0.seq, headHex: h0.headHex }, all);
  assert.equal(v.seq, h7.seq); assert.equal(v.headHex, h7.headHex);
  // verify_chain compares a holding target by its holding reference: a host reference of it (sequence 5) is the same target
  const host5 = G.targets.holding.slice(0, 104) + '05000000';
  assert.deepEqual(verifyChain({ entity: ENTITY.HOLDING, keyHex: host5 }, { seq: h0.seq, headHex: h0.headHex }, all), v);
});

test('next_head and advance reproduce a real link; overflow is refused', () => {
  const before = parseChainHeader(R[0].headers.holding, ENTITY.HOLDING), after = parseChainHeader(R[1].headers.holding, ENTITY.HOLDING);
  const bwt = HARVEST.slice(0, 2 * (6 + 56 + 80));
  assert.equal(Buffer.from(nextHead(ENTITY.HOLDING, 3n, before.headHex, bwt)).toString('hex'), after.headHex);
  assert.deepEqual(advance(ENTITY.HOLDING, 2n, before.headHex, bwt), { entity: ENTITY.HOLDING, seq: 3n, headHex: after.headHex });
  assert.notEqual(Buffer.from(nextHead(ENTITY.PROVINCE, 3n, before.headHex, bwt)).toString('hex'), after.headHex, 'the entity is hashed');
  assert.throws(() => advance(ENTITY.HOLDING, (1n << 64n) - 1n, before.headHex, bwt), code('Overflow'));
  assert.throws(() => nextHead(ENTITY.HOLDING, 3, before.headHex, bwt), code('BadInput'), 'a Number sequence is refused');
  assert.throws(() => verifyChain({ entity: ENTITY.HOLDING, keyHex: G.targets.holding }, { seq: (1n << 64n) - 1n, headHex: before.headHex }, [HARVEST]), code('Chain'));
});

test('missing, extra and reordered receipts fail', () => {
  assert.throws(() => step('harvest', { records: [HARVEST, HARVEST] }), code('Chain'), 'extra (replayed)');
  assert.throws(() => step('harvest', { records: [] }), code('ChainEnd'), 'missing');
  assert.throws(() => step('settle_departure', { records: SETTLE.slice(1) }), code('Chain'), 'first missing');
  assert.throws(() => step('settle_departure', { records: SETTLE.slice(0, 2) }), code('ChainEnd'), 'last missing');
  assert.throws(() => step('settle_departure', { records: [SETTLE[1], SETTLE[0], SETTLE[2]] }), code('Chain'), 'reordered');
  assert.throws(() => step('dissolve_return', { records: [...R[at('dissolve_return')].recordsHex].reverse() }), code('Chain'));
  const all = R.flatMap(r => r.recordsHex);
  [all[0], all[1]] = [all[1], all[0]];
  assert.throws(() => verifyReceiptChains({ records: all, chains: chainsBetween(0, 7), nonChainKinds: [10, 11] }), code('Chain'), 'harvest and depart swapped');
  // a receipt of another transition does not satisfy this one
  assert.throws(() => step('harvest', { records: [DEPARTED] }), code('Chain'));
});

test('wrong sequence, head, previous head, tampered body or bell fail', () => {
  assert.throws(() => step('harvest', { records: [setByte(HARVEST, 144, 4)] }), code('Chain'), 'link seq');
  assert.throws(() => step('harvest', { records: [flip(HARVEST, 160)] }), code('Chain'), 'link head');
  assert.throws(() => step('harvest', { records: [flip(HARVEST, 80)] }), code('Chain'), 'a digest byte');
  assert.throws(() => step('harvest', { records: [flip(HARVEST, 2)] }), code('Chain'), 'the bell');
  assert.throws(() => step('depart', { records: [flip(DEPARTED, 120)] }), code('Chain'), 'a Departed payload byte');
  assert.throws(() => step('harvest', { edit: { holding: { before: flip(R[0].headers.holding, 40) } } }), code('Chain'), 'previous head');
  assert.throws(() => step('harvest', { edit: { holding: { before: setByte(R[0].headers.holding, 24, 3) } } }), code('Chain'), 'previous seq');
  assert.throws(() => step('harvest', { edit: { holding: { after: flip(R[1].headers.holding, 50) } } }), code('ChainEnd'), 'after head');
  assert.throws(() => step('harvest', { edit: { holding: { after: setByte(R[1].headers.holding, 24, 4) } } }), code('ChainEnd'), 'after seq');
  assert.throws(() => step('harvest', { edit: { origin: { after: R[2].headers.origin } } }), code('ChainEnd'), 'an untouched chain moved');
});

test('strict decoder: versions, kinds, widths, tail, trailing bytes and input shape', () => {
  assert.throws(() => decodeRecord(''), code('Short'));
  assert.throws(() => decodeRecord(setByte(HARVEST, 0, 0x81)), code('RetiredVersion'));
  for (const v of [0x00, 0x80, 0x83]) assert.throws(() => decodeRecord(setByte(HARVEST, 0, v)), code('Version'));
  for (const k of [0, 17, 255]) assert.throws(() => decodeRecord(setByte(HARVEST, 1, k)), code('UnknownKind'));
  assert.throws(() => decodeRecord(HARVEST.slice(0, -2)), code('Short'));
  assert.throws(() => decodeRecord(HARVEST.slice(0, 2 * 100)), code('Short'));
  assert.throws(() => decodeRecord(HARVEST + '00'), code('Trailing'));
  assert.throws(() => decodeRecord(setByte(HARVEST, 142, 3)), code('Tail'), 'more than two links');
  assert.throws(() => decodeRecord(setByte(HARVEST, 142, 0)), code('Trailing'), 'n = 0 with a link after it');
  assert.throws(() => decodeRecord(HARVEST.slice(0, 2 * 142) + '00'), code('Links'), 'no tail where the kind chains');
  assert.throws(() => decodeRecord(setByte(HARVEST, 143, 1)), code('Links'), 'wrong entity for the kind');
  assert.throws(() => decodeRecord(setByte(HARVEST, 143, 3)), code('UnknownEntity'));
  assert.throws(() => decodeRecord(setByte(DEPARTED, 184, 2)), code('Tail'), 'repeated entity');
  assert.throws(() => decodeRecord(setByte(DEPARTED, 1, KIND.REVEALED)), code('Trailing'), 'a kind with other widths');
  assert.throws(() => decodeRecord(HARVEST.toUpperCase()), code('Hex'));
  assert.throws(() => decodeRecord(HARVEST.slice(0, -1)), code('Hex'));
  assert.throws(() => decodeRecord(42), code('Hex'));
  assert.throws(() => decodeRecord('00'.repeat(MAX_BODY + 1)), code('Bounds'));
  assert.throws(() => decodeRecord(new Uint8Array(MAX_BODY + 1)), code('Bounds'));
});

test('strict keys: canonical province keys, host references and holding references only', () => {
  const resolve = SETTLE[0];
  assert.throws(() => decodeRecord(setByte(resolve, 6, 2)), code('Key'), 'key version');
  assert.throws(() => decodeRecord(setBytes(resolve, 7, 39, 0)), code('Key'), 'reserved world');
  assert.throws(() => decodeRecord(setByte(resolve, 47, 7)), code('Key'), 'wedge 7');
  assert.throws(() => decodeRecord(setByte(resolve, 55, 0x81)), code('Key'), 'position = ring');
  assert.throws(() => decodeRecord(setBytes(resolve, 39, 47, 0xff)), code('Key'), 'outside the bound');
  assert.throws(() => decodeRecord(flip(DEPARTED, 63)), code('Key'), 'standing province of another world');
  assert.throws(() => decodeRecord(setByte(DEPARTED, 56, 12)), code('Key'), 'site 12');
  assert.throws(() => decodeRecord(setByte(HARVEST, 58, 1)), code('Key'), 'economy key with a sequence');
  for (const g of [0, 0xff]) assert.throws(() => decodeRecord(setByte(HARVEST, 57, g)), code('Key'), `generation ${g}`);
  assert.throws(() => decodeRecord(setByte(HARVEST, 46, 0x80)), code('Key'), 'a holding on ring 128 is not wide');
  assert.throws(() => decodeRecord(setBytes(TRANSIT, 145, 177, 0)), code('Key'), 'sealed destination: reserved world');
  assert.throws(() => decodeRecord(flip(TRANSIT, 145)), code('Key'), 'sealed destination of another world');
});

test('economy payloads: canonical receipt of exactly the record\'s kind', () => {
  assert.throws(() => decodeRecord(setByte(HARVEST, 62, 2)), code('Payload'), 'receipt version');
  assert.throws(() => decodeRecord(setByte(HARVEST, 63, 3)), code('Payload'), 'action tag');
  assert.throws(() => decodeRecord(setByte(HARVEST, 64, 1)), code('Payload'), 'harvest padding');
  assert.throws(() => decodeRecord(setByte(HARVEST, 77, 2)), code('Payload'), 'became_final');
  assert.throws(() => decodeRecord(setByte(setByte(HARVEST, 63, 1), 64, 6)), code('Payload'), 'walls belong under EconomyMirror');
  assert.throws(() => decodeRecord(setByte(setByte(HARVEST, 63, 1), 64, 7)), code('Payload'), 'tier-up belongs under EconomyMirror');
  assert.throws(() => decodeRecord(setByte(setByte(HARVEST, 63, 1), 64, 9)), code('Payload'), 'build item');
  assert.throws(() => decodeRecord(setByte(setByte(HARVEST, 63, 2), 64, 7)), code('Payload'), 'train unit');
  assert.throws(() => decodeRecord(setByte(HARVEST, 63, 2)), code('Payload'), 'train count 0');
  assert.equal(decodeRecord(setByte(setByte(HARVEST, 63, 1), 64, 5)).kind, KIND.ECONOMY, 'a plain build decodes');
  assert.equal(decodeRecord(setByte(setByte(HARVEST, 63, 2), 65, 10)).kind, KIND.ECONOMY, 'a train decodes');
  assert.throws(() => decodeRecord(setByte(HARVEST, 1, KIND.ECONOMY_MIRROR)), code('Payload'), 'harvest under EconomyMirror');
});

test('coverage: undeclared links fail unless explicitly unverified; non-chain records only when permitted', () => {
  const j = at('depart');
  const holdingOnly = { roles: [ROLES[0]] };
  assert.throws(() => verifyReceiptChains({ records: R[j].recordsHex, chains: chainsBetween(j - 1, j, holdingOnly) }), code('Undeclared'));
  const rep = verifyReceiptChains({ records: R[j].recordsHex, chains: chainsBetween(j - 1, j, holdingOnly), unverified: [{ entity: ENTITY.PROVINCE, keyHex: G.targets.origin }] });
  assert.deepEqual(rep.unverifiedLinks, [{ record: 0, entity: ENTITY.PROVINCE, keyHex: G.targets.origin }], 'reported, never counted as verified');
  assert.throws(() => verifyReceiptChains({ records: R[j].recordsHex, chains: chainsBetween(j - 1, j), unverified: [{ entity: ENTITY.PROVINCE, keyHex: G.targets.origin }] }), code('BadInput'), 'declared and unverified at once');
  assert.throws(() => step('post_reveal', { nonChainKinds: [] }), code('Unexpected'));
  assert.throws(() => step('resolve_arrival', { nonChainKinds: [KIND.REVEALED] }), code('Unexpected'), 'another non-chain kind');
  assert.throws(() => step('post_reveal', { nonChainKinds: [KIND.RESOLVE] }), code('BadInput'), 'a chained kind is never a non-chain kind');
  assert.throws(() => step('post_reveal', { nonChainKinds: [10, 10] }), code('BadInput'));
  // the harvest receipt is attributed to the origin province too, but an Economy record does not chain it: skipped, unchanged
  assert.deepEqual(step('harvest').chains.find(c => c.label === 'origin').consumed, []);
  assert.throws(() => step('harvest', { kinds: [KIND.DEPARTED] }), code('Kinds'));
  assert.throws(() => step('harvest', { kinds: [15, 15] }), code('Kinds'));
});

test('headers: magic per entity, layout version, reserved bytes, unchanged identity', () => {
  assert.throws(() => step('harvest', { edit: { origin: { before: R[0].headers.holding } } }), code('Header'), 'a holding header for a province');
  assert.throws(() => step('harvest', { edit: { holding: { before: setByte(R[0].headers.holding, 16, 4) } } }), code('Header'), 'layout version');
  assert.throws(() => step('harvest', { edit: { holding: { before: setByte(R[0].headers.holding, 18, 1) } } }), code('Header'), 'reserved');
  assert.throws(() => step('harvest', { edit: { holding: { after: flip(R[1].headers.holding, 8) } } }), code('Identity'), 'season id changed');
  assert.throws(() => step('harvest', { edit: { holding: { before: R[0].headers.holding + '00' } } }), code('Bounds'));
  assert.throws(() => step('harvest', { edit: { holding: { before: R[0].headers.holding.slice(0, -2) } } }), code('Hex'));
  assert.equal(parseChainHeader(R[0].headers.destination, ENTITY.PROVINCE).seasonId, 11n);
});

test('creation and removal follow the ABI (SYNTHETIC records from this module\'s encoder)', () => {
  const dest = G.targets.destination, D7 = R[7].headers.destination, d7 = parseChainHeader(D7, ENTITY.PROVINCE);
  const one = (records, before, after, entity = ENTITY.PROVINCE, targetHex = dest) => verifyReceiptChains({ records, chains: [{ label: 'x', entity, targetHex, before, after }] });
  // a created chained account starts from the fresh header (seq 0, zero head: land.rs / holding.rs init)
  const r = decodeRecord(ARRIVAL_RESOLVE), bwt = ARRIVAL_RESOLVE.slice(0, 2 * (6 + 50 + 71));
  const link = advance(ENTITY.PROVINCE, 0n, ZERO, bwt);
  const created = encodeRecord({ kind: r.kind, bell: r.bell, keyHex: r.keyHex, payloadHex: r.payloadHex, links: [link] });
  const rep = one([created], null, withChain(R[0].headers.destination, 1n, link.headHex));
  assert.equal(rep.chains[0].created, true); assert.deepEqual(rep.chains[0].consumed, [0]);
  assert.equal(one([], null, withChain(R[0].headers.destination, 0n, ZERO)).chains[0].created, true);
  assert.throws(() => one([], null, withChain(R[0].headers.destination, 0n, 'ff'.repeat(32))), code('ChainEnd'), 'a new account has the fresh chain');
  assert.throws(() => one([], null, null), code('BadInput'));
  // a province leaves only through its own ProvinceClosed, the terminal record of its chain
  const payload = '11'.repeat(32) + le64hex(1000n), closeBwt = '820e' + '1a000000' + dest + payload;
  const closeLink = advance(ENTITY.PROVINCE, d7.seq, d7.headHex, closeBwt);
  const close = encodeRecord({ kind: KIND.PROVINCE_CLOSED, bell: 26, keyHex: dest, payloadHex: payload, links: [closeLink] });
  assert.equal(close.slice(0, closeBwt.length), closeBwt);
  assert.equal(one([close], D7, null).chains[0].closed, true);
  assert.throws(() => one([close], D7, withChain(D7, closeLink.seq, closeLink.headHex)), code('Closed'), 'closed but still present');
  assert.throws(() => one([], D7, null), code('NotClosed'), 'vanished without a close record');
  const later = encodeRecord({ kind: r.kind, bell: r.bell, keyHex: r.keyHex, payloadHex: r.payloadHex, links: [advance(ENTITY.PROVINCE, closeLink.seq, closeLink.headHex, bwt)] });
  assert.throws(() => one([close, later], D7, null), code('ChainAfterClose'));
  assert.throws(() => one([], R[7].headers.holding, null, ENTITY.HOLDING, G.targets.holding), code('NotClosed'), 'the ABI has no holding close');
});

test('input bounds and explicit absence', () => {
  const j = at('harvest');
  assert.throws(() => verifyReceiptChains({ records: Array(MAX_RECORDS + 1).fill(HARVEST), chains: chainsBetween(j - 1, j) }), code('Bounds'));
  assert.throws(() => verifyReceiptChains({ records: [], chains: [] }), code('BadInput'));
  assert.throws(() => verifyReceiptChains({ records: [], chains: Array(33).fill(chainsBetween(0, 0)[0]) }), code('BadInput'));
  assert.throws(() => verifyReceiptChains({ records: [], chains: [...chainsBetween(0, 0), chainsBetween(0, 0)[0]] }), code('BadInput'), 'declared twice');
  const { after, ...noAfter } = chainsBetween(0, 0)[0];
  assert.ok(after);
  assert.throws(() => verifyReceiptChains({ records: [], chains: [noAfter] }), code('BadInput'), 'a missing after is never read as absent');
  assert.throws(() => verifyReceiptChains({ records: [], chains: chainsBetween(0, 0), extra: 1 }), code('BadInput'));
  assert.throws(() => verifyReceiptChains({ records: [], chains: [{ ...chainsBetween(0, 0)[0], accountKeyHex: 'aa' }] }), code('BadInput'));
  assert.throws(() => verifyReceiptChains({ records: [], chains: [{ ...chainsBetween(0, 0)[0], targetHex: G.targets.holding.slice(0, 104) + '01000000' }] }), code('Key'), 'a declared holding is a holding reference');
  assert.throws(() => verifyReceiptChains({ records: [], chains: [{ ...chainsBetween(0, 0)[1], entity: 3 }] }), code('BadInput'));
  try { verifyReceiptChains({ records: [HARVEST, 'zz'], chains: chainsBetween(j - 1, j) }); assert.fail('accepted'); }
  catch (e) { assert.equal(e.code, 'Hex'); assert.equal(e.index, 1); }
});

test('helpers: identities and account headers', () => {
  const w = G.worldHex;
  assert.equal(provinceKeyHex(w, '129', '0'), G.targets.origin);
  assert.equal(provinceKeyHex(w, 129n, -1n), G.targets.destination);
  assert.equal(holdingRefHex(w, '129', '0', 0, 1), G.targets.holding);
  for (const [s, g] of [[0, 0], [0, 255], [12, 1]]) assert.throws(() => holdingRefHex(w, '129', '0', s, g), code('Key'));
  assert.throws(() => holdingRefHex(w, '128', '0', 0, 1), code('Key'), 'not a wide ring');
  assert.throws(() => provinceKeyHex(w, '0129', '0'), code('Key'));
  assert.throws(() => provinceKeyHex('00'.repeat(32), '129', '0'), code('Key'));
  assert.throws(() => provinceKeyHex(w, (1n << 62n) + 1n, 0n), code('Key'));
  const program = '12'.repeat(32), key = G.accounts.holding.accountKeyHex, header = R[0].headers.holding;
  const acct = { keyHex: key, ownerHex: program, lamports: '10245120', dataHex: header + '00'.repeat(1344 - 64) };
  assert.equal(chainHeaderOfAccount(acct, { programOwnerHex: program }), header);
  assert.equal(chainHeaderOfAccount({ keyHex: key, ownerHex: ZERO, lamports: '0', dataHex: '' }, { programOwnerHex: program }), null);
  assert.throws(() => chainHeaderOfAccount({ keyHex: key, ownerHex: ZERO, lamports: '1', dataHex: '' }, { programOwnerHex: program }), code('Account'));
  assert.throws(() => chainHeaderOfAccount({ ...acct, ownerHex: 'ab'.repeat(32) }, { programOwnerHex: program }), code('Account'));
  assert.throws(() => chainHeaderOfAccount({ ...acct, dataHex: header.slice(0, 126) }, { programOwnerHex: program }), code('Account'));
  assert.throws(() => chainHeaderOfAccount({ ...acct, lamports: '01' }, { programOwnerHex: program }), code('Account'));
  assert.throws(() => chainHeaderFromAccounts([acct], 'cd'.repeat(32), { programOwnerHex: program }), code('AccountMissing'));
  assert.throws(() => chainHeaderFromAccounts([acct, acct], key, { programOwnerHex: program }), code('Account'));
  assert.equal(chainHeaderFromAccounts([acct], key, { programOwnerHex: program }), header);
});

test('module source: browser-servable relative imports only; no network, key or signing code', async () => {
  const src = await readFile(new URL('../screens/wide-march-local/local-receipts.mjs', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/g)].map(m => m[1]).sort();
  assert.deepEqual(imports, ['../../../permutation-server/web/frontier/map/wide.mjs', '../../../permutation-server/web/sdk/sha256.mjs']);
  for (const bad of [/\bfetch\(/, /XMLHttpRequest/, /WebSocket/, /crypto\.subtle/, /\.sign\(/, /Keypair/i, /generateKey/, /Math\.random/, /\brequire\(/, /node:/, /innerHTML/, /\beval\(/])
    assert.doesNotMatch(src, bad, String(bad));
});
