// ② rights as page-signed local acts in a COEXIST local world (TEST-ONLY, rights-play): the one builder the page and the
// relay share (permutation-server/web/frontier/flocalplay-rights.mjs) and the relay's allow-list (src/frontier/
// local-play-act.mjs). The encodings are pinned by hand from frontier-abi/src/v2/rights.rs (`ix_rights!`, the
// `accounts` module, `grant_seed`), the same values frontier-node/crates/itest/src/coexist_play.rs sends on the real
// coexist `.so`. A KEY-USING test (an in-memory test Ed25519 key signs; never printed or stored); nothing is sent anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { encode, decode as b58d } from '../client/src/base58.mjs';
import { localActIntent, localActMessage, localActSubmit, localActGrantCheck, LocalActError, LOCAL_ACT_SUBMIT_SCHEMA, LOCAL_ACT_PRESEND_REFUSALS, createLocalPlayAct, coexistPins } from '../src/frontier/local-play-act.mjs';
import { LOCAL_PLAY_PROGRAM } from '../src/frontier/local-play-relay.mjs';
import { NEVER_DELEGATED } from '../src/frontier/agent/contract.mjs';
import * as R from '../../permutation-server/web/frontier/flocalplay-rights.mjs';
import * as PA from '../../permutation-server/web/frontier/flocalplay-act.mjs';
import { PLAIN_LANE, COEXIST_LANE, selectLocalLane } from '../../permutation-server/web/frontier/flocalplay-lane.mjs';
import { seasonAddresses, seasonPda, citizenTag } from '../../permutation-server/web/frontier/faddr.mjs';
import { parseTransaction } from '../client/src/solana-tx.mjs';
import { CARAVAN_FEE } from '../../permutation-server/web/sdk/frontier/budgets.mjs';
import { PREVIEW_INTENTS } from './fixtures/custody-intents.mjs';

const key = () => { const { publicKey, privateKey } = generateKeyPairSync('ed25519'); return { address: encode(publicKey.export({ format: 'der', type: 'spki' }).subarray(12)), privateKey }; };
const W = key(), B = key();
const SEASON = seasonPda(LOCAL_PLAY_PROGRAM, 11)[0], HASH = encode(new Uint8Array(32).fill(7));
const A = seasonAddresses(LOCAL_PLAY_PROGRAM, '11');
const CIT = A.of('Citizen', { wallet: W.address }), CIT_B = A.of('Citizen', { wallet: B.address });
const TAG = citizenTag(CIT).toString();
const COEX = { program: LOCAL_PLAY_PROGRAM, season: SEASON, seasonId: 11, wallet: W.address, rulesetHash: COEXIST_LANE.rulesetHash };
const PLAIN = { ...COEX, rulesetHash: PLAIN_LANE.rulesetHash };
const F = { p: 3, q: -2, site: 4 }, V = { p: 3, q: -2, tile: 22 };
const USE = { grant: { issuer_tag: TAG, nonce: 1 }, facility: F, station: V };
const INTENTS = {
  IssueGrant: { name: 'IssueGrant', subject: { facility: F, grantee: CIT_B, station: V }, fields: { nonce: 1, kind: 1, max_swaps: 3, max_units: 30, expires_ts: '1790000000' } },
  ReserveSwap: { name: 'ReserveSwap', subject: USE, fields: { units: 500, seq: 2 } },
  ExecuteSwap: { name: 'ExecuteSwap', subject: USE, fields: { seq: 2 } },
  ReleaseSwap: { name: 'ReleaseSwap', subject: USE, fields: {} },
  RevokeGrant: { name: 'RevokeGrant', subject: USE, fields: {} },
  CloseGrant: { name: 'CloseGrant', subject: { grant: { issuer_tag: TAG, nonce: 1 } }, fields: {} },
  BuildVault: { name: 'BuildVault', subject: { holding: F, at: V }, fields: { tile: 22 } },
  SendCaravan: { name: 'SendCaravan', subject: { seq: 0, src: { kind: 'vault', p: 3, q: -2, tile: 22, gen: 0 }, dst: { kind: 'holding', p: 3, q: -2, site: 4, gen: 0 }, provinces: [{ p: 3, q: -2 }] },
    fields: { seq: 0, dst_kind: 1, dst_p: 3, dst_q: -2, dst_at: 4, dst_gen: 0, steps: 2, path: [9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], cargo: [0, 0, 0, 0, 1, 0, 0, 0], fee: CARAVAN_FEE.toString() } },
  // (rights-play, parent: the delivery of the wallet's own arrived caravan — local play has no keeper delivering S1 caravans)
  SettleCaravan: { name: 'SettleCaravan', subject: { seq: 0, dst: { kind: 'vault', p: 3, q: -2, tile: 22, gen: 0 }, provinces: [{ p: 3, q: -2 }] }, fields: {} },
  // (local-9-10-preview: ⑨ capacity and ⑩ custody ride the same coexist acts — flocalplay-custody.mjs; their own encodings
  //  are pinned in frontier-local-play-custody.test.mjs)
  ...PREVIEW_INTENTS({ F, V, owner: CIT_B, tag: TAG, rentTo: B.address }),
};
const wireOf = (message, signers = [W]) => Buffer.concat([Buffer.from([signers.length]), ...signers.map(s => sign(null, message, s.privateKey)), Buffer.from(message)]).toString('base64');
const body = (intent, tx) => ({ schema: LOCAL_ACT_SUBMIT_SCHEMA, name: intent.name, subject: intent.subject, fields: intent.fields, transaction_b64: tx });
const messageOf = (intent, p = COEX) => localActMessage(localActIntent(intent, { wallet: p.wallet, coexist: coexistPins(p) }), p, HASH).message;
const refused = (f, code) => assert.throws(f, e => e instanceof LocalActError && e.code === code, code);
const ixOf = message => { const t = parseTransaction(Buffer.concat([Buffer.from([1]), Buffer.alloc(64), Buffer.from(message)])); return t.instructions[t.instructions.length - 1]; };

test('the Grant address and the instruction data are rights.rs\'s, byte for byte (pinned by hand)', () => {
  // grant_seed: 'gr' ‖ hex(le64 issuer_tag ‖ le32 nonce); with_seed(season, seed, program) = sha256(season ‖ seed ‖ program)
  const tagHex = Buffer.from(b58d(CIT)).subarray(0, 8).toString('hex');
  assert.equal(R.grantSeed(TAG, 1), `gr${tagHex}01000000`);
  const want = encode(createHash('sha256').update(Buffer.from(b58d(SEASON))).update(`gr${tagHex}01000000`).update(Buffer.from(b58d(LOCAL_PLAY_PROGRAM))).digest());
  assert.equal(R.grantAddress(SEASON, LOCAL_PLAY_PROGRAM, TAG, 1), want);
  const hex = name => Buffer.from(ixOf(messageOf(INTENTS[name])).data).toString('hex');
  // IssueGrant { nonce u32, kind u8, max_swaps u16, max_units u32, expires_ts i64 } = 20 bytes
  assert.equal(hex('IssueGrant'), 'd0' + '01000000' + '01' + '0300' + '1e000000' + '803bb16a00000000');
  assert.equal(hex('ReserveSwap'), 'd1' + 'f4010000' + '0200');
  assert.equal(hex('ExecuteSwap'), 'd2' + '0200');
  assert.equal(hex('ReleaseSwap'), 'd3'); assert.equal(hex('RevokeGrant'), 'd4'); assert.equal(hex('CloseGrant'), 'd5');
});

test('the account lists are rights.rs `accounts::{issue, use_grant, release, close}` with the wallet as actor AND payer', () => {
  const G = R.grantAddress(SEASON, LOCAL_PLAY_PROGRAM, TAG, 1), H = A.of('Holding', F), P = A.of('Province', F), VA = A.of('Vault', V);
  const keys = name => { const t = parseTransaction(Buffer.concat([Buffer.from([1]), Buffer.alloc(64), Buffer.from(messageOf(INTENTS[name]))])); return t.instructions[t.instructions.length - 1].keys.map(k => k.pubkey); };
  const W_ = W.address, S = SEASON;
  assert.deepEqual(keys('IssueGrant'), [W_, W_, S, CIT, H, P, CIT_B, VA, G, '11111111111111111111111111111111']);
  for (const n of ['ReserveSwap', 'ExecuteSwap', 'RevokeGrant']) assert.deepEqual(keys(n), [W_, W_, S, CIT, G, H, VA, P], n);
  assert.deepEqual(keys('ReleaseSwap'), [W_, S, CIT, G, H, VA, P]);
  assert.deepEqual(keys('CloseGrant'), [W_, S, G, W_]);
  // one signature (the wallet), the compute prefix with the local loaded-data limit and the rights CU
  const t = parseTransaction(Buffer.concat([Buffer.from([1]), Buffer.alloc(64), Buffer.from(messageOf(INTENTS.IssueGrant))]));
  assert.deepEqual(t.signers, [W.address]); assert.equal(t.instructions.length, 4);
  assert.equal(Buffer.from(t.instructions[0].data).readUInt32LE(1), R.RIGHTS_CU.IssueGrant);
  assert.equal(Buffer.from(t.instructions[2].data).readUInt32LE(1), 67108864);
});

test('PLAIN worlds are unchanged: every rights name, BuildVault and SendCaravan is refused as not a local command; the page lane too', () => {
  for (const name of R.COEXIST_ACTS) {
    refused(() => localActIntent(INTENTS[name], { wallet: W.address }), 'LocalActNotAllowed');
    refused(() => localActIntent(INTENTS[name], { wallet: W.address, coexist: false }), 'LocalActNotAllowed');
    // a coexist intent carried to a plain relay's pins is not built either
    const intent = localActIntent(INTENTS[name], { wallet: W.address, coexist: true });
    refused(() => localActMessage(intent, PLAIN, HASH), 'LocalActNotAllowed');
    assert.equal(PA.localOrderRoute({ localPlay: { address: W.address }, name, v: {}, signer: undefined, requester: null }), 'refuse', name);
    assert.equal(PA.localOrderRoute({ localPlay: { address: W.address }, name, v: {}, signer: undefined, requester: null, names: PA.COEXIST_LOCAL_LANE.names }), 'local-act', name);
  }
  assert.equal(PA.localLaneFor(PLAIN_LANE.rulesetHash), PA.LOCAL_LANE);
  assert.equal(PA.localLaneFor(HASH), PA.LOCAL_LANE);
  assert.equal(PA.localLaneFor(COEXIST_LANE.rulesetHash), PA.COEXIST_LOCAL_LANE);
  assert.deepEqual(PA.COEXIST_LOCAL_LANE.names.slice(0, PA.LOCAL_ACT_NAMES.length), [...PA.LOCAL_ACT_NAMES]);
  assert.deepEqual({ ...PA.COEXIST_LOCAL_LANE.paths }, { ...PA.LOCAL_LANE.paths });
  // the pre-send refusals: the page and the relay say the same, with the two new ones
  assert.deepEqual([...PA.LOCAL_ACT_PRESEND_REFUSALS], [...LOCAL_ACT_PRESEND_REFUSALS]);
  for (const c of ['LocalActWalletOnly', 'LocalActGrant']) assert.ok(LOCAL_ACT_PRESEND_REFUSALS.includes(c), c);
  // MCP: issuing and revoking are never delegated
  for (const n of R.RIGHTS_WALLET_ONLY) assert.ok(NEVER_DELEGATED.includes(n), n);
});

test('the page and the relay build the same bytes; a signature cannot be carried to another Grant, amount, seq, Vault or grantee', () => {
  for (const name of R.COEXIST_ACTS) {
    const i = INTENTS[name];
    const page = PA.localActMessage(PA.localActIntentOf(name, i.subject, i.fields, W.address), { address: W.address, programId: LOCAL_PLAY_PROGRAM, seasonAddress: SEASON }, COEXIST_LANE.rulesetHash, HASH, PA.COEXIST_LOCAL_LANE);
    assert.deepEqual(Buffer.from(page), Buffer.from(messageOf(i)), name);
    const ok = localActSubmit(body(i, wireOf(messageOf(i))), COEX);
    assert.equal(ok.intent.name, name);
  }
  const tx = wireOf(messageOf(INTENTS.ReserveSwap));
  for (const over of [{ fields: { units: 501, seq: 2 } }, { fields: { units: 500, seq: 3 } }, { subject: { ...USE, grant: { issuer_tag: TAG, nonce: 2 } } }, { subject: { ...USE, station: { ...V, tile: 23 } } }]) {
    refused(() => localActSubmit(body({ ...INTENTS.ReserveSwap, ...over }, tx), COEX), 'LocalActMessageMismatch');
  }
  const issue = wireOf(messageOf(INTENTS.IssueGrant));
  refused(() => localActSubmit(body({ ...INTENTS.IssueGrant, subject: { ...INTENTS.IssueGrant.subject, grantee: A.of('Citizen', { wallet: key().address }) } }, issue), COEX), 'LocalActMessageMismatch');
  // another key signs: refused
  refused(() => localActSubmit(body(INTENTS.IssueGrant, wireOf(messageOf(INTENTS.IssueGrant), [B])), COEX), 'LocalActSigner');
});

test('the intent shapes are closed: the station in the facility\'s Province, kind 1, units within a swap, the fee the game\'s, a wide place refused', () => {
  const bad = (name, over) => refused(() => localActIntent({ ...INTENTS[name], ...over }, { wallet: W.address, coexist: true }), 'LocalActInvalid');
  bad('IssueGrant', { subject: { ...INTENTS.IssueGrant.subject, station: { p: 4, q: -2, tile: 22 } } });
  bad('IssueGrant', { fields: { ...INTENTS.IssueGrant.fields, kind: 2 } });
  bad('IssueGrant', { fields: { ...INTENTS.IssueGrant.fields, max_swaps: 0 } });
  bad('IssueGrant', { fields: { ...INTENTS.IssueGrant.fields, expires_ts: 1790000000 } });
  bad('IssueGrant', { fields: { ...INTENTS.IssueGrant.fields, extra: 1 } });
  bad('IssueGrant', { subject: { ...INTENTS.IssueGrant.subject, grantee: 'nope' } });
  bad('ReserveSwap', { fields: { units: 0, seq: 0 } });
  bad('ReserveSwap', { fields: { units: R.MAX_UNITS_PER_SWAP + 1, seq: 0 } });
  bad('ReserveSwap', { subject: { ...USE, grant: { issuer_tag: 7, nonce: 1 } } });
  bad('BuildVault', { fields: { tile: 21 } });
  bad('SendCaravan', { fields: { ...INTENTS.SendCaravan.fields, fee: '1' } });
  bad('SendCaravan', { fields: { ...INTENTS.SendCaravan.fields, cargo: [0, 0, 0, 0, 0, 0, 0, 0] } });
  bad('SendCaravan', { fields: { ...INTENTS.SendCaravan.fields, dst_at: 5 } });
  refused(() => localActIntent({ ...INTENTS.IssueGrant, subject: { ...INTENTS.IssueGrant.subject, facility: { p: 200, q: 0, site: 1 }, station: { p: 200, q: 0, tile: 3 } } }, { wallet: W.address, coexist: true }), 'LocalActWideHolding');
});

// ------------------------------------------------------------------ the Grant read with the Citizen

function grantBytes({ issuer = CIT, grantee = CIT_B, facility = A.of('Holding', F), station = A.of('Vault', V), rentTo = W.address, season = 11n, nonce = 1, tag = BigInt(TAG), open = 0, state = 1 } = {}) {
  const b = new Uint8Array(272), v = new DataView(b.buffer);
  b.set(Buffer.from('PSF2GRNT'), 0); v.setBigUint64(8, season, true); v.setUint16(16, 1, true); b[18] = 1; b[19] = state;
  v.setInt16(24, F.p, true); v.setInt16(26, F.q, true); v.setUint32(28, nonce, true);
  b.set(b58d(issuer), 32); b.set(b58d(grantee), 64); b.set(b58d(facility), 96); b.set(b58d(station), 128);
  v.setBigUint64(160, tag, true); v.setBigInt64(168, 1790000000n, true); v.setUint16(184, 3, true); v.setUint32(188, 30, true); v.setUint32(196, open, true);
  b.set(b58d(rentTo), 240);
  return b;
}
const acc = (bytes, owner = LOCAL_PLAY_PROGRAM) => (bytes === null ? null : { owner, bytes });

test('decodeGrant and the party rule (fog: a Grant of two other players gives no role and no action)', () => {
  const g = R.decodeGrant(grantBytes({ open: 5 }));
  assert.equal(g.issuerCitizen, CIT); assert.equal(g.granteeCitizen, CIT_B); assert.equal(g.issuerTag, TAG); assert.equal(g.nonce, 1); assert.equal(g.openUnits, 5);
  assert.equal(R.decodeGrant(new Uint8Array(271)), null);
  assert.deepEqual([...R.grantOptions(g, CIT_B, 1).can].sort(), ['ExecuteSwap', 'ReleaseSwap']);
  assert.deepEqual([...R.grantOptions(g, CIT, 1).can], ['RevokeGrant']);
  const other = R.grantOptions(g, A.of('Citizen', { wallet: key().address }), 1);
  assert.equal(other.role, null); assert.equal(other.can.size, 0);
  const answer = { schema: R.HERALD_GRANTS_SCHEMA, grants: [{ address: R.grantAddress(SEASON, LOCAL_PLAY_PROGRAM, TAG, 1), issuer_tag: TAG, grantee_tag: citizenTag(CIT_B).toString(), nonce: 1, issuer_citizen: null, grantee_citizen: null },
    { address: R.grantAddress(SEASON, LOCAL_PLAY_PROGRAM, TAG, 2), issuer_tag: '5', grantee_tag: '6', nonce: 2, issuer_citizen: null, grantee_citizen: null }] };
  assert.equal(R.partyGrants(answer, CIT_B).length, 1); assert.equal(R.partyGrants(answer, A.of('Citizen', { wallet: key().address })).length, 0);
  assert.equal(R.partyGrants({ schema: 'other', grants: [] }, CIT), null);
});

test('the relay\'s Grant check: absent for IssueGrant; the grantee uses, the issuer revokes and closes; another grantee, Vault, Season or program is refused', () => {
  const asB = { ...COEX, wallet: B.address };
  const iB = name => localActIntent({ ...INTENTS[name] }, { wallet: B.address, coexist: true });
  const issue = localActIntent(INTENTS.IssueGrant, { wallet: W.address, coexist: true });
  localActGrantCheck(issue, COEX, { citizenAt: CIT }, null);
  refused(() => localActGrantCheck(issue, COEX, { citizenAt: CIT }, acc(grantBytes())), 'LocalActGrant');
  for (const n of ['ReserveSwap', 'ExecuteSwap', 'ReleaseSwap']) {
    localActGrantCheck(iB(n), asB, { citizenAt: CIT_B }, acc(grantBytes()));
    refused(() => localActGrantCheck(iB(n), COEX, { citizenAt: CIT }, acc(grantBytes())), 'LocalActGrant');   // the issuer is not the grantee
    refused(() => localActGrantCheck(iB(n), asB, { citizenAt: CIT_B }, null), 'LocalActGrant');
    refused(() => localActGrantCheck(iB(n), asB, { citizenAt: CIT_B }, acc(grantBytes(), 'Other1111111111111111111111111111111111111')), 'LocalActGrant');
    refused(() => localActGrantCheck(iB(n), asB, { citizenAt: CIT_B }, acc(grantBytes({ season: 12n }))), 'LocalActGrant');
    refused(() => localActGrantCheck(iB(n), asB, { citizenAt: CIT_B }, acc(grantBytes({ station: A.of('Vault', { ...V, tile: 23 }) }))), 'LocalActGrant');
  }
  localActGrantCheck(localActIntent(INTENTS.RevokeGrant, { wallet: W.address, coexist: true }), COEX, { citizenAt: CIT }, acc(grantBytes()));
  refused(() => localActGrantCheck(iB('RevokeGrant'), asB, { citizenAt: CIT_B }, acc(grantBytes())), 'LocalActGrant');
  localActGrantCheck(localActIntent(INTENTS.CloseGrant, { wallet: W.address, coexist: true }), COEX, { citizenAt: CIT }, acc(grantBytes({ state: 2 })));
  refused(() => localActGrantCheck(localActIntent(INTENTS.CloseGrant, { wallet: W.address, coexist: true }), COEX, { citizenAt: CIT }, acc(grantBytes({ rentTo: B.address }))), 'LocalActGrant');
});

// ------------------------------------------------------------------ the flow (a coexist relay: the process lane is selected here, last)

function citizenBytes(wallet, at) { const b = new Uint8Array(384), v = new DataView(b.buffer); b.set(Buffer.from('PSF1CITZ'), 0); v.setBigUint64(8, 11n, true); v.setUint16(16, 2, true); b.set(b58d(wallet), 64); b.set(b58d(at).subarray(0, 8), 208); return b; }
function holdingBytes(owner) { const b = new Uint8Array(1280), v = new DataView(b.buffer); b.set(Buffer.from('PSF1HOLD'), 0); v.setBigUint64(8, 11n, true); v.setInt16(64, F.p, true); v.setInt16(66, F.q, true); b[68] = F.site; b.set(b58d(owner), 72); return b; }
const row = (bytes, owner = LOCAL_PLAY_PROGRAM) => (bytes === null ? null : { owner, executable: false, lamports: 1, data: [Buffer.from(bytes).toString('base64'), 'base64'] });

test('the flow in a coexist relay: IssueGrant read and sent once; a resident\'s relay never sends IssueGrant or RevokeGrant (LocalActWalletOnly), nothing sent', async () => {
  selectLocalLane(COEXIST_LANE);
  const cfg = { localPlay: true, rpc: 'http://127.0.0.1:41864', program: LOCAL_PLAY_PROGRAM, season: SEASON, wallet: W.address, rulesetHash: COEXIST_LANE.rulesetHash, prepareBin: '/x/depart', cuLimit: '1000000', loadedLimit: '67108864' };
  const make = (turns = null) => {
    const sends = [], asked = [];
    const rpc = async (method, params) => {
      if (method === 'getMultipleAccounts') { asked.push(params[0]); return { result: { context: { slot: 9 }, value: params[0].map(a => (a === CIT ? row(citizenBytes(W.address, CIT)) : a === A.of('Holding', F) ? row(holdingBytes(CIT)) : null)) } }; }
      if (method === 'sendTransaction') { sends.push(params[0]); return { result: encode(Buffer.from(params[0], 'base64').subarray(1, 65)) }; }
      throw new Error(method);
    };
    return { act: createLocalPlayAct({ cfg, rpc, turns }), sends, asked };
  };
  const plainAct = make();
  const r = await plainAct.act.submit(body(INTENTS.IssueGrant, wireOf(messageOf(INTENTS.IssueGrant))));
  assert.equal(r.status, 'submitted'); assert.equal(plainAct.sends.length, 1);
  assert.deepEqual(plainAct.asked[0], [CIT, A.of('Holding', F), R.grantAddress(SEASON, LOCAL_PLAY_PROGRAM, TAG, 1)]);
  // a Reserve of a Grant that is not there: refused before the send
  await assert.rejects(plainAct.act.submit(body(INTENTS.ReserveSwap, wireOf(messageOf(INTENTS.ReserveSwap)))), e => e.code === 'LocalActGrant');
  assert.equal(plainAct.sends.length, 1);
  // a resident's relay (turns): the wallet-only two are refused before anything is read
  const resident = make({ bell: async () => 1, claim: () => ({ sent() {} }) });
  for (const n of R.RIGHTS_WALLET_ONLY) {
    await assert.rejects(resident.act.submit(body(INTENTS[n], wireOf(messageOf(INTENTS[n])))), e => e.code === 'LocalActWalletOnly', n);
  }
  assert.equal(resident.sends.length, 0); assert.equal(resident.asked.length, 0);
});
