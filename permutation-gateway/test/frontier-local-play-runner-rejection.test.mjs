// (2026-11-19, fix-march-held) The runner's definite "not taken" answer to the relay's one send, and a sent march whose
// blockhash expired: D-r0ze-play-kit-1 (a refused keep-march Depart held its host for the rest of the world).
//   - `runnerRejection`: which sendTransaction errors say the transaction was never queued or run (preflight failed,
//     blockhash unknown, signature failure) — and which do not (AlreadyProcessed, any other code);
//   - the act and march relays answer those as LocalActRejected / LocalMarchRejected (HTTP 422) with the program code;
//   - the march status route answers `expired` when the blockhash was read as past its life BEFORE the signature was
//     read as still unknown — and `pending` otherwise.
// The runner's RPC is a stand-in; the test key is made here in memory (as frontier-local-play-act.test.mjs does).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { encode, decode as b58d } from '../client/src/base58.mjs';
import { runnerRejection, sendRefusalDetail, createLocalPlayAct, localActIntent, localActMessage, LOCAL_ACT_SUBMIT_SCHEMA, LOCAL_ACT_PRESEND_REFUSALS } from '../src/frontier/local-play-act.mjs';
import * as M from '../src/frontier/local-play-march.mjs';
import { LOCAL_PLAY_PROGRAM, LOCAL_PLAY_RULESET_HASH } from '../src/frontier/local-play-relay.mjs';
import { seasonPda, seasonAddresses, hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import * as P from '../../permutation-server/web/frontier/flocalplay-march.mjs';
import * as PA from '../../permutation-server/web/frontier/flocalplay-act.mjs';

const key = () => { const { publicKey, privateKey } = generateKeyPairSync('ed25519'); return { address: encode(publicKey.export({ format: 'der', type: 'spki' }).subarray(12)), privateKey }; };
const W = key();
const SEASON = seasonPda(LOCAL_PLAY_PROGRAM, 11)[0], HASH = encode(new Uint8Array(32).fill(7)), INSTANCE = 'ab'.repeat(32);
const A = seasonAddresses(LOCAL_PLAY_PROGRAM, '11');
const HOME = { p: 3, q: -2, site: 4 }, CITIZEN_AT = A.of('Citizen', { wallet: W.address });
const pins = { program: LOCAL_PLAY_PROGRAM, season: SEASON, seasonId: 11, wallet: W.address, rulesetHash: LOCAL_PLAY_RULESET_HASH };
const cfg = { localPlay: true, rpc: 'http://127.0.0.1:41720', program: LOCAL_PLAY_PROGRAM, season: SEASON, wallet: W.address, rulesetHash: LOCAL_PLAY_RULESET_HASH, prepareBin: '/x/depart', cuLimit: '1000000', loadedLimit: '67108864' };
const wireOf = message => Buffer.concat([Buffer.from([1]), sign(null, message, W.privateKey), Buffer.from(message)]).toString('base64');
function citizenBytes() { const b = new Uint8Array(384), v = new DataView(b.buffer); b.set(Buffer.from('PSF1CITZ'), 0); v.setBigUint64(8, 11n, true); v.setUint16(16, 2, true); b.set(b58d(W.address), 64); b.set(b58d(CITIZEN_AT).subarray(0, 8), 208); return b; }
function holdingBytes() { const b = new Uint8Array(1280), v = new DataView(b.buffer); b.set(Buffer.from('PSF1HOLD'), 0); v.setBigUint64(8, 11n, true); v.setInt16(64, HOME.p, true); v.setInt16(66, HOME.q, true); b[68] = HOME.site; b.set(b58d(CITIZEN_AT), 72); return b; }
function provinceBytes() { const b = new Uint8Array(4736), v = new DataView(b.buffer); b.set(Buffer.from('PSF1PROV'), 0); v.setBigUint64(8, 11n, true); v.setUint16(16, 2, true); v.setInt16(64, HOME.p, true); v.setInt16(66, HOME.q, true); return b; }
const row = bytes => ({ owner: LOCAL_PLAY_PROGRAM, executable: false, lamports: 1, data: [Buffer.from(bytes).toString('base64'), 'base64'] });
const SIM = (err, logs = ['Program x invoke [1]', 'Program x failed: custom program error: 0x1a']) => ({ code: -32002, message: `Transaction simulation failed: ${typeof err === 'string' ? err : 'InstructionError(3, Custom(26))'}`, data: { err, logs, unitsConsumed: 10657 } });

test('runnerRejection: preflight failures, an unknown blockhash and a bad signature are definite; AlreadyProcessed and anything else are not', () => {
  const r = runnerRejection(SIM({ InstructionError: [3, { Custom: 26 }] }));
  assert.deepEqual([r.err, r.programCode, r.logs.length], [{ InstructionError: [3, { Custom: 26 }] }, 26, 2]);
  assert.equal(runnerRejection(SIM({ InstructionError: [4, 'ProgramFailedToComplete'] })).programCode, null, 'no program code: still a rejection');
  assert.equal(runnerRejection(SIM('BlockhashNotFound')).err, 'BlockhashNotFound');
  assert.equal(runnerRejection(SIM('MaxLoadedAccountsDataSizeExceeded')).programCode, null);
  assert.equal(runnerRejection({ code: -32003, message: 'Transaction signature verification failure: x' }).err, 'SignatureFailure');
  // NOT definite: the signature is known to the runner (it may land), another code, no data, a malformed answer
  for (const e of [SIM('AlreadyProcessed'), { code: -32002, message: 'Transaction simulation failed: This transaction has already been processed', data: { err: 'x' } },
    { code: -32002, message: 'refused' }, { code: -32002, message: 'Transaction simulation failed: x' }, { code: -32005, message: 'Node is behind' },
    { code: -32602, message: 'bad' }, null, 'x', [], { code: -32003, message: 'other' }]) assert.equal(runnerRejection(e), null, JSON.stringify(e));
  const d = sendRefusalDetail(SIM({ InstructionError: [3, { Custom: 26 }] }), 'S');
  assert.deepEqual([d.code, d.signature, d.program_code], [-32002, 'S', 26]);
  assert.deepEqual(Object.keys(sendRefusalDetail({ code: -32005, message: 'm' }, 'S')), ['code', 'message', 'signature'], 'an unknown refusal carries no rejection fields');
  // the page's lists agree with the relay's; neither rejection code is a pre-send refusal (the bytes ARE consumed)
  assert.deepEqual([...PA.LOCAL_ACT_REJECTED], ['LocalActRejected']); assert.ok(!LOCAL_ACT_PRESEND_REFUSALS.includes('LocalActRejected'));
  assert.deepEqual([...P.LOCAL_MARCH_REJECTED], [...M.LOCAL_MARCH_REJECTED]); assert.ok(!M.LOCAL_MARCH_PRESEND_REFUSALS.includes('LocalMarchRejected'));
});

test('the act relay: a preflight failure is LocalActRejected (422) with the program code; AlreadyProcessed stays LocalActSendRefused; sent once either way', async () => {
  const intent = { name: 'Muster', subject: { holding: HOME }, fields: { unit: 0, troops: 10, tile: 30 } };
  const tx = wireOf(localActMessage(localActIntent(intent, { wallet: W.address }), pins, HASH).message);
  const body = { schema: LOCAL_ACT_SUBMIT_SCHEMA, name: intent.name, subject: intent.subject, fields: intent.fields, transaction_b64: tx };
  const run = async sendAnswer => {
    let sent = 0;
    const act = createLocalPlayAct({ cfg, runnerInstance: INSTANCE, rpc: async (method, params) => {
      if (method === 'getMultipleAccounts') return { result: { context: { slot: 91 }, value: params[0].map(a => (a === CITIZEN_AT ? row(citizenBytes()) : row(holdingBytes()))) } };
      if (method === 'getSignatureStatuses') return { result: { context: { slot: 92, apiVersion: 'x', instance: INSTANCE }, value: [null] } };
      if (method === 'sendTransaction') { sent += 1; return { error: sendAnswer }; }
      return { error: { code: -1 } };
    } });
    const e = await act.submit(body).then(() => null, x => x);
    return { e, sent };
  };
  let { e, sent } = await run(SIM({ InstructionError: [3, { Custom: 26 }] }));
  assert.deepEqual([e.code, e.status, e.detail.program_code, sent], ['LocalActRejected', 422, 26, 1]);
  ({ e, sent } = await run(SIM('AlreadyProcessed')));
  assert.deepEqual([e.code, e.status, sent], ['LocalActSendRefused', 502, 1]);
});

function marchFlow({ send, valid = true }) {
  const calls = [];
  const flow = M.createLocalPlayMarch({ cfg, runnerInstance: INSTANCE, trial: true, rpc: async (method, params) => {
    calls.push(method);
    if (method === 'getMultipleAccounts') return { result: { context: { slot: 91 }, value: [row(citizenBytes()), row(holdingBytes()), row(provinceBytes())] } };
    if (method === 'getSignatureStatuses') return { result: { context: { slot: 92, apiVersion: 'x', instance: INSTANCE }, value: [null] } };
    if (method === 'isBlockhashValid') return { result: { context: { slot: 93 }, value: typeof valid === 'function' ? valid() : valid } };
    if (method === 'sendTransaction') return send(params);
    return { error: { code: -1 } };
  } });
  const intent = M.localMarchIntent({ name: 'Depart', subject: { holding: HOME, province: { p: HOME.p, q: HOME.q } },
    fields: { host_id: String(hostId({ ...HOME, gen: 1, seq: 0 })), commit: 'cd'.repeat(32), seal: '80' + 'ab'.repeat(164), arrive_bell: 12, tip: '1000', transit_slot: 0 } });
  const tx = wireOf(M.localMarchMessage(intent, pins, HASH));
  const body = { schema: M.LOCAL_MARCH_SUBMIT_SCHEMA, name: 'Depart', subject: JSON.parse(JSON.stringify(intent.subject)), fields: { ...intent.fields }, transaction_b64: tx };
  return { flow, calls, body, signature: encode(Buffer.from(tx, 'base64').subarray(1, 65)) };
}

test('the march relay: NotResident at preflight is LocalMarchRejected (422) with program code 26; AlreadyProcessed stays LocalMarchSendRefused', async () => {
  let h = marchFlow({ send: () => ({ error: SIM({ InstructionError: [3, { Custom: 26 }] }) }) });
  let e = await h.flow.submit(h.body).then(() => null, x => x);
  assert.deepEqual([e.code, e.status, e.detail.program_code, e.detail.signature], ['LocalMarchRejected', 422, 26, h.signature]);
  assert.equal(h.calls.filter(c => c === 'sendTransaction').length, 1);
  await assert.rejects(h.flow.submit(h.body), x => x.code === 'LocalMarchMessageUsed', 'the same bytes are never sent again');
  h = marchFlow({ send: () => ({ error: SIM('AlreadyProcessed') }) });
  e = await h.flow.submit(h.body).then(() => null, x => x);
  assert.deepEqual([e.code, e.status], ['LocalMarchSendRefused', 502]);
});

test('the march status: `expired` only when the blockhash was read invalid BEFORE the signature was read unknown; else pending', async () => {
  const ok = p => ({ result: encode(Buffer.from(p[0], 'base64').subarray(1, 65)) });
  let h = marchFlow({ send: ok, valid: true });
  assert.equal((await h.flow.submit(h.body)).status, 'submitted');
  assert.equal((await h.flow.status({ schema: M.LOCAL_MARCH_STATUS_SCHEMA, signature: h.signature })).status, 'pending');
  h = marchFlow({ send: ok, valid: false });
  await h.flow.submit(h.body);
  h.calls.length = 0;
  assert.deepEqual(await h.flow.status({ schema: M.LOCAL_MARCH_STATUS_SCHEMA, signature: h.signature }), { signature: h.signature, status: 'expired', context_slot: 92 });
  assert.deepEqual(h.calls, ['isBlockhashValid', 'getSignatureStatuses'], 'the blockhash first, then the signature');
});
