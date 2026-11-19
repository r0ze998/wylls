// One action per resident per bell (Q16-2) on the ORDINARY march relay (local-play-march.mjs, #75's send path): a
// resident's relay started with --resident-turns holds its one Depart send to the world's bell lease, like the economy
// commands and the prepared flows (frontier-local-play-resident-turns.test.mjs).
//   - two march relays of one wallet on one lease directory, two different Departs at once: exactly one is sent, the
//     other is ResidentAlreadyActed {bell, nextBell} and nothing of it reaches the runner;
//   - the runner's definite rejection after the send call (#75: LocalMarchRejected) keeps the bell spent (fail-closed:
//     the send was called), so another Depart in that bell is ResidentAlreadyActed; the next bell is open again;
//   - without the lease (a person's own relay) nothing changes: both are sent.
// The runner's RPC is a stand-in; the test key is made here in memory (as frontier-local-play-runner-rejection.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { encode, decode as b58d } from '../client/src/base58.mjs';
import * as M from '../src/frontier/local-play-march.mjs';
import { LOCAL_PLAY_PROGRAM, LOCAL_PLAY_RULESET_HASH } from '../src/frontier/local-play-relay.mjs';
import { CLOCK_SYSVAR } from '../src/frontier/local-play-turns.mjs';
import { createResidentTurns, RESIDENT_ALREADY_ACTED } from '../src/frontier/resident-turns.mjs';
import { seasonPda, seasonAddresses, hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { LAYOUTS as V2 } from '../../permutation-server/web/sdk/frontier/abi-v2-layouts.mjs';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const W = { address: encode(publicKey.export({ format: 'der', type: 'spki' }).subarray(12)), privateKey };
const SEASON = seasonPda(LOCAL_PLAY_PROGRAM, 11)[0], HASH = encode(new Uint8Array(32).fill(7)), INSTANCE = 'ab'.repeat(32);
const A = seasonAddresses(LOCAL_PLAY_PROGRAM, '11');
const HOME = { p: 3, q: -2, site: 4 }, CITIZEN_AT = A.of('Citizen', { wallet: W.address });
const pins = { program: LOCAL_PLAY_PROGRAM, season: SEASON, seasonId: 11, wallet: W.address, rulesetHash: LOCAL_PLAY_RULESET_HASH };
const cfg = { localPlay: true, rpc: 'http://127.0.0.1:41856', program: LOCAL_PLAY_PROGRAM, season: SEASON, wallet: W.address, rulesetHash: LOCAL_PLAY_RULESET_HASH, prepareBin: '/x/depart', cuLimit: '1000000', loadedLimit: '67108864' };
const GENESIS = 1_000_000;
function citizenBytes() { const b = new Uint8Array(384), v = new DataView(b.buffer); b.set(Buffer.from('PSF1CITZ'), 0); v.setBigUint64(8, 11n, true); v.setUint16(16, 2, true); b.set(b58d(W.address), 64); b.set(b58d(CITIZEN_AT).subarray(0, 8), 208); return b; }
function holdingBytes() { const b = new Uint8Array(1280), v = new DataView(b.buffer); b.set(Buffer.from('PSF1HOLD'), 0); v.setBigUint64(8, 11n, true); v.setInt16(64, HOME.p, true); v.setInt16(66, HOME.q, true); b[68] = HOME.site; b.set(b58d(CITIZEN_AT), 72); return b; }
function provinceBytes() { const b = new Uint8Array(4736), v = new DataView(b.buffer); b.set(Buffer.from('PSF1PROV'), 0); v.setBigUint64(8, 11n, true); v.setUint16(16, 2, true); v.setInt16(64, HOME.p, true); v.setInt16(66, HOME.q, true); return b; }
function seasonBytes() { const L = V2.accounts.find(a => a.kind === 'Season'); const b = Buffer.alloc(L.size); b.writeBigInt64LE(BigInt(GENESIS), L.fields.find(f => f.name === 'GENESIS_TS').off); return b; }
const clockBytes = unix => { const b = Buffer.alloc(40); b.writeBigInt64LE(BigInt(unix), 32); return b; };
const row = (bytes, owner = LOCAL_PLAY_PROGRAM) => ({ owner, executable: false, lamports: 1, data: [Buffer.from(bytes).toString('base64'), 'base64'] });
const SIM = { code: -32002, message: 'Transaction simulation failed: InstructionError(3, Custom(31))', data: { err: { InstructionError: [3, { Custom: 31 }] }, logs: [], unitsConsumed: 1 } };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lp-march-turns-'));

/** One stand-in runner (one chain, its bell) shared by every relay of a test. `reject`: the next send is a preflight failure. */
function runner() {
  const chain = { bell: 4, sends: [], reject: false };
  chain.rpc = async (method, params) => {
    if (method === 'getMultipleAccounts') {
      const at = params[0];
      if (at.length === 2 && at[1] === CLOCK_SYSVAR) return { result: { context: { slot: 91 }, value: [row(seasonBytes()), row(clockBytes(GENESIS + 600 * chain.bell + 5), 'Sysvar1111111111111111111111111111111111111')] } };
      return { result: { context: { slot: 91 }, value: [row(citizenBytes()), row(holdingBytes()), row(provinceBytes())] } };
    }
    if (method === 'getSignatureStatuses') return { result: { context: { slot: 92, apiVersion: 'x', instance: INSTANCE }, value: [null] } };
    if (method === 'isBlockhashValid') return { result: { context: { slot: 93 }, value: true } };
    if (method === 'sendTransaction') {
      await new Promise(r => setImmediate(r));
      chain.sends.push(params[0]);
      if (chain.reject) { chain.reject = false; return { error: SIM }; }
      return { result: encode(Buffer.from(params[0], 'base64').subarray(1, 65)) };
    }
    return { error: { code: -1 } };
  };
  return chain;
}
/** A signed Depart body; `seq` makes each a different host and message. */
function depart(seq) {
  const intent = M.localMarchIntent({ name: 'Depart', subject: { holding: HOME, province: { p: HOME.p, q: HOME.q } },
    fields: { host_id: String(hostId({ ...HOME, gen: 1, seq })), commit: 'cd'.repeat(32), seal: '80' + 'ab'.repeat(164), arrive_bell: 12, tip: '1000', transit_slot: 0 } });
  const message = M.localMarchMessage(intent, pins, HASH);
  const tx = Buffer.concat([Buffer.from([1]), sign(null, message, W.privateKey), Buffer.from(message)]).toString('base64');
  return { schema: M.LOCAL_MARCH_SUBMIT_SCHEMA, name: 'Depart', subject: JSON.parse(JSON.stringify(intent.subject)), fields: { ...intent.fields }, transaction_b64: tx };
}
const relay = (chain, turns) => M.createLocalPlayMarch({ cfg, runnerInstance: INSTANCE, trial: true, rpc: chain.rpc, ...(turns ? { turns } : {}) });
const outcome = p => p.then(r => ({ ok: true, r }), e => ({ ok: false, code: e.code, detail: e.detail }));

test('two march relays of one resident, two Departs in one bell: exactly one is sent; the other is ResidentAlreadyActed and never reaches the runner', async () => {
  const chain = runner(), dir = tmp();
  const a = relay(chain, createResidentTurns({ dir })), b = relay(chain, createResidentTurns({ dir }));
  const res = await Promise.all([outcome(a.submit(depart(0))), outcome(b.submit(depart(1)))]);
  assert.equal(res.filter(x => x.ok).length, 1, JSON.stringify(res));
  const lost = res.find(x => !x.ok);
  assert.equal(lost.code, RESIDENT_ALREADY_ACTED);
  assert.deepEqual([lost.detail.bell, lost.detail.nextBell], [4, 5]);
  assert.equal(chain.sends.length, 1, 'one Depart reached the runner');
  assert.ok(M.LOCAL_MARCH_PRESEND_REFUSALS.includes(RESIDENT_ALREADY_ACTED), 'the page reads it as "not sent"');
  // the next bell: the loser's relay may act again
  chain.bell = 5;
  const next = await outcome((res[0].ok ? b : a).submit(depart(2)));
  assert.equal(next.ok, true, JSON.stringify(next));
  assert.equal(chain.sends.length, 2);
});

test('a Depart the runner rejects after the send call (#75 LocalMarchRejected) keeps the bell spent; the next bell is open', async () => {
  const chain = runner(), dir = tmp();
  const a = relay(chain, createResidentTurns({ dir }));
  chain.reject = true;
  const first = await outcome(a.submit(depart(0)));
  assert.equal(first.code, 'LocalMarchRejected');
  assert.equal(chain.sends.length, 1);
  const again = await outcome(a.submit(depart(1)));
  assert.equal(again.code, RESIDENT_ALREADY_ACTED, 'fail-closed: the send was called in this bell');
  assert.equal(chain.sends.length, 1);
  chain.bell = 5;
  assert.equal((await outcome(a.submit(depart(2)))).ok, true);
});

test('without the lease (a person\'s own relay): two Departs in one bell are both sent, as before', async () => {
  const chain = runner();
  const a = relay(chain, null), b = relay(chain, null);
  const res = await Promise.all([outcome(a.submit(depart(0))), outcome(b.submit(depart(1)))]);
  assert.deepEqual(res.map(x => x.ok), [true, true], JSON.stringify(res));
  assert.equal(chain.sends.length, 2);
});
