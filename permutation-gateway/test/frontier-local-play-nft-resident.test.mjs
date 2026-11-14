// LOCAL TEST CANDIDATE lane ([0x4C; 32] / 0xC804; NOT an allocation), increment 2: an NFT resident's local command
// through the relay's REAL act flow (src/frontier/local-play-act.mjs) over a stand-in runner RPC, with the page's own
// builder (permutation-server/web/frontier/flocalresident.mjs). Every holder fact is read on ONE read at one slot, and
// every refusal comes BEFORE the one send.
// A KEY-USING test: one ed25519 key made in memory here, never printed or stored. Nothing is started: no runner, no
// chain, no listener, no network. Nothing here is evidence of any transaction on any chain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createLocalPlayAct } from '../src/frontier/local-play-act.mjs';
import { LOCAL_PLAY_PROGRAM, LOCAL_PLAY_RULESET_HASH } from '../src/frontier/local-play-relay.mjs';
import { LOCAL_LANE_PROGRAMS } from '../src/frontier/local-lane-versions.mjs';
import { LOCAL_ACT_SUBMIT_RESIDENT_SCHEMA, localResidentActMessage, localResidentCitizen, localResidentProof } from '../../permutation-server/web/frontier/flocalresident.mjs';
import { policyAddress, residentAddress } from '../client/src/frontier/resident.mjs';
import { seasonAddresses, seasonPda } from '../../permutation-server/web/frontier/faddr.mjs';
import { decode, encode } from '../../permutation-server/web/sdk/base58.mjs';

const CAND = LOCAL_LANE_PROGRAMS.conquestNftCandidate;
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const WALLET = encode(new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(12)));
const key = n => encode(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? n : (n * 31 + i) & 0xff)));
const vec = JSON.parse(readFileSync(new URL('../../frontier-abi/vectors/v2/resident-citizen.json', import.meta.url), 'utf8'));
const hex = h => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
const citizenCase = name => hex(vec.cases.find(c => c.case === name).bytes);
const ASSET = vec.asset, CORE = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d', RESIDENT_PROGRAM = key(7), COLLECTION = key(8), GUARD = key(9), OTHER = key(22);
const SEASON = seasonPda(CAND, 11)[0], A = seasonAddresses(CAND, '11');
const CITIZEN_AT = localResidentCitizen(CAND, ASSET), HOME = { p: 2, q: 0, site: 4 }, VILLAGE = { p: 2, q: 0, site: 4 }, HOLDING_AT = A.of('Holding', HOME);
const HASH = encode(new Uint8Array(32).fill(7));

const policyBytes = (rp = RESIDENT_PROGRAM) => Uint8Array.from([...Buffer.from('PSFNP002'), ...decode(CORE), ...decode(rp), ...decode(COLLECTION), ...decode(GUARD)]);
const assetBytes = (owner, collection = COLLECTION) => Uint8Array.from([1, ...decode(owner), 2, ...decode(collection), ...new Uint8Array(40)]);
const residentBytes = gen => { const b = new Uint8Array(133); b[0] = 0xc2; b.set(decode(ASSET), 1); new DataView(b.buffer).setUint32(48, gen, true); return b; };
const holdingBytes = (owner = CITIZEN_AT) => { const b = new Uint8Array(1280), v = new DataView(b.buffer); b.set(Buffer.from('PSF1HOLD'), 0); v.setBigUint64(8, 11n, true); v.setInt16(64, HOME.p, true); v.setInt16(66, HOME.q, true); b[68] = HOME.site; b.set(decode(owner), 72); return b; };
const row = (owner, bytes) => ({ owner, executable: false, lamports: 1, data: [Buffer.from(bytes).toString('base64'), 'base64'] });

function chain({ holder: holderIn = null, gen = 0, citizen = 'nft', villageOwner = CITIZEN_AT, policyRp = RESIDENT_PROGRAM } = {}) {
  return new Map([
    [policyAddress(CAND), row(CAND, policyBytes(policyRp))],
    [ASSET, row(CORE, assetBytes(holderIn ?? WALLET))],
    [residentAddress(RESIDENT_PROGRAM, ASSET), row(RESIDENT_PROGRAM, residentBytes(gen))],
    [CITIZEN_AT, row(CAND, citizenCase(citizen))],
    [HOLDING_AT, row(CAND, holdingBytes(villageOwner))],
  ]);
}
const cfgOf = program => ({ localPlay: true, rpc: 'http://127.0.0.1:41010', program, season: seasonPda(program, 11)[0], wallet: WALLET, rulesetHash: LOCAL_PLAY_RULESET_HASH, prepareBin: '/abs/prepare', cuLimit: 400000, loadedLimit: 262144 });

function relay(accounts, program = CAND) {
  const calls = [], sent = [];
  const rpc = async (method, params) => {
    calls.push(method);
    if (method === 'getMultipleAccounts') return { result: { context: { slot: 91 }, value: params[0].map(a => accounts.get(a) ?? null) } };
    if (method === 'sendTransaction') { const sig = encode(Buffer.from(params[0], 'base64').subarray(1, 65)); sent.push(sig); return { result: sig }; }
    return { error: { code: -1 } };
  };
  return { act: createLocalPlayAct({ cfg: cfgOf(program), rpc }), calls, sent };
}

/** The page's bytes for `name`, signed by the wallet; `over` changes what the page states (not what it signs). */
function submitOf(name, fields, { generation = 0, residentProgram = RESIDENT_PROGRAM, signGeneration = generation } = {}) {
  const intent = { name, subject: { holding: VILLAGE }, fields };
  const proof = { ...localResidentProof({ programId: CAND, seasonAddress: SEASON, asset: ASSET, residentProgram: RESIDENT_PROGRAM }), residentProgram: RESIDENT_PROGRAM };
  const message = localResidentActMessage(intent, { programId: CAND, seasonAddress: SEASON, wallet: WALLET, rulesetHash: LOCAL_PLAY_RULESET_HASH, blockhash: HASH, resident: { asset: ASSET, generation: signGeneration, proof } });
  const sig = sign(null, Buffer.from(message), privateKey);
  const wire = Buffer.concat([Buffer.from([1]), sig, Buffer.from(message)]);
  return { schema: LOCAL_ACT_SUBMIT_RESIDENT_SCHEMA, name, subject: { holding: VILLAGE }, fields, resident: { asset: ASSET, generation, resident_program: residentProgram }, transaction_b64: wire.toString('base64') };
}
const refusal = async (p, code) => { await assert.rejects(p, e => e.code === code, code); };

test('the current holder, its generation, its Citizen and its village: the command is sent once (Build, Train, Muster)', async () => {
  for (const [name, fields] of [['Build', { item: 3 }], ['Train', { unit: 6, n: 100 }], ['Muster', { unit: 6, troops: 100, tile: 30 }]]) {
    const r = relay(chain());
    const out = await r.act.submit(submitOf(name, fields));
    assert.equal(out.status, 'submitted'); assert.equal(out.name, name);
    assert.deepEqual(r.calls, ['getMultipleAccounts', 'sendTransaction'], 'ONE read, then ONE send');
    assert.equal(r.sent.length, 1);
    await refusal(r.act.submit(submitOf(name, fields)), 'LocalActMessageUsed');
  }
});

test('the previous holder after a transfer is refused before any send', async () => {
  const r = relay(chain({ holder: OTHER, gen: 1 }));
  await refusal(r.act.submit(submitOf('Build', { item: 3 }, { generation: 1 })), 'LocalActResidentNotHolder');
  assert.deepEqual(r.sent, []);
});

test('a proof signed for an earlier generation is refused (stale), also when the page states the new one', async () => {
  const r = relay(chain({ gen: 1 }));
  await refusal(r.act.submit(submitOf('Build', { item: 3 }, { generation: 0 })), 'LocalActResidentStale');
  // the page states generation 1 but signed bytes made for 0: the rebuild differs
  await refusal(r.act.submit(submitOf('Build', { item: 3 }, { generation: 1, signGeneration: 0 })), 'LocalActMessageMismatch');
  assert.deepEqual(r.sent, []);
});

test('a resident program the policy does not name, or a policy naming another: unverified', async () => {
  await refusal(relay(chain()).act.submit(submitOf('Build', { item: 3 }, { residentProgram: key(40) })), 'LocalActResidentUnverified');
  await refusal(relay(chain({ policyRp: key(41) })).act.submit(submitOf('Build', { item: 3 })), 'LocalActResidentUnverified');
});

test('the Citizen at the asset\'s address must be THIS asset\'s resident: a wallet Citizen or an invalid mark is refused', async () => {
  await refusal(relay(chain({ citizen: 'wallet' })).act.submit(submitOf('Build', { item: 3 })), 'LocalActResidentCitizen');
  await refusal(relay(chain({ citizen: 'flagged_with_wallet' })).act.submit(submitOf('Build', { item: 3 })), 'LocalActResidentCitizen');
});

test('a village of another Citizen is refused', async () => {
  await refusal(relay(chain({ villageOwner: key(50) })).act.submit(submitOf('Build', { item: 3 })), 'LocalActNotYourVillage');
});

test('the conquest lane never takes the resident schema: refused before anything is read', async () => {
  const r = relay(chain(), LOCAL_PLAY_PROGRAM);
  await refusal(r.act.submit(submitOf('Build', { item: 3 })), 'LocalActNotAllowed');
  assert.deepEqual(r.calls, []);
});

test('the wallet guard stays on the candidate: the ordinary schema still needs this wallet\'s own Citizen', async () => {
  const r = relay(chain());
  const s = submitOf('Build', { item: 3 });
  const plain = { schema: 'frontier-local-play-act-submit-v1', name: s.name, subject: s.subject, fields: s.fields, transaction_b64: s.transaction_b64 };
  // the resident bytes are not the plain command's bytes; and no wallet Citizen is there
  await assert.rejects(r.act.submit(plain), e => ['LocalActMessageMismatch', 'LocalActCitizen'].includes(e.code));
  assert.deepEqual(r.sent, []);
});

test('the page builder refuses every lane but the candidate, Join, and a proof that is not the recomputed one', () => {
  const proof = { ...localResidentProof({ programId: CAND, seasonAddress: SEASON, asset: ASSET, residentProgram: RESIDENT_PROGRAM }), residentProgram: RESIDENT_PROGRAM };
  const base = { programId: CAND, seasonAddress: SEASON, wallet: WALLET, rulesetHash: LOCAL_PLAY_RULESET_HASH, blockhash: HASH, resident: { asset: ASSET, generation: 0, proof } };
  const intent = { name: 'Build', subject: { holding: VILLAGE }, fields: { item: 3 } };
  assert.ok(localResidentActMessage(intent, base) instanceof Uint8Array);
  assert.throws(() => localResidentActMessage(intent, { ...base, programId: LOCAL_PLAY_PROGRAM, seasonAddress: seasonPda(LOCAL_PLAY_PROGRAM, 11)[0] }), e => e.code === 'LocalActNotAllowed');
  assert.throws(() => localResidentActMessage({ ...intent, name: 'Join' }, base), e => e.code === 'LocalActNotAllowed');
  assert.throws(() => localResidentActMessage(intent, { ...base, resident: { ...base.resident, proof: { ...proof, link: key(60) } } }), e => e.code === 'LocalActResidentUnverified');
  assert.throws(() => localResidentActMessage(intent, { ...base, resident: { ...base.resident, proof: { ...proof, resident: key(61) } } }), e => e.code === 'LocalActResidentUnverified');
});

// The page's own send (flocalplay-act.mjs `submitLocalAct` with `resident`) to the relay's real flow: the bytes the
// page signs are the relay's rebuild, and a refusal before the send is "not sent" on the page.
import { submitLocalAct, LOCAL_ACT_CONTEXT_PATH, LOCAL_ACT_SUBMIT_PATH } from '../../permutation-server/web/frontier/flocalplay-act.mjs';
import { createEphemeralWallet } from '../../permutation-server/web/frontier/fephemeral-wallet.mjs';

test('the page signs what the relay rebuilds: a resident Build goes out once; a pass sold meanwhile is "not sent"', async () => {
  const W = await createEphemeralWallet({ cluster: 'localnet', hostname: '127.0.0.1', localPlay: true });
  const ORIGIN = 'http://127.0.0.1:47611';
  const run = async holder => {
    const accounts = chain({ holder });
    const sent = [];
    const rpc = async (method, params) => {
      if (method === 'getLatestBlockhash') return { result: { context: { slot: 90 }, value: { blockhash: HASH, lastValidBlockHeight: 300 } } };
      if (method === 'getMultipleAccounts') return { result: { context: { slot: 91 }, value: params[0].map(a => accounts.get(a) ?? null) } };
      if (method === 'sendTransaction') { const sig = encode(Buffer.from(params[0], 'base64').subarray(1, 65)); sent.push(sig); return { result: sig }; }
      return { error: { code: -1 } };
    };
    const act = createLocalPlayAct({ cfg: { ...cfgOf(CAND), wallet: W.address }, rpc });
    const post = async (origin, path, body) => {
      assert.equal(origin, ORIGIN);
      try { return path === LOCAL_ACT_CONTEXT_PATH ? await act.context(body) : await act.submit(JSON.parse(JSON.stringify(body))); }
      catch (e) { throw Object.assign(new Error('refused'), { code: e.code, refused: true, status: e.status }); }
    };
    const identity = Object.freeze({ address: W.address, programId: CAND, seasonAddress: SEASON, cluster: 'localnet', seasonId: '11' });
    const out = await submitLocalAct({ name: 'Build', v: { holding: HOME }, fields: { item: 3 } }, {
      allowed: () => ({ ok: true, relay: ORIGIN }), identity: () => identity, rulesetHash: () => LOCAL_PLAY_RULESET_HASH, signer: () => W, post,
      resident: () => ({ asset: ASSET, generation: 0, residentProgram: RESIDENT_PROGRAM }) });
    return { out, sent };
  };
  const ok = await run(W.address);
  assert.equal(ok.out.ok, true, JSON.stringify(ok.out)); assert.equal(ok.sent.length, 1); assert.equal(ok.out.signature, ok.sent[0]);
  const sold = await run(OTHER);
  assert.deepEqual([sold.out.ok, sold.out.code], [false, 'LocalActResidentNotHolder']); assert.equal(sold.sent.length, 0);
});

test('JoinResident: the first login goes out once while neither the Citizen nor the link exists; a joined NFT is refused', async () => {
  const join = (generation = 0) => {
    const intent = { name: 'JoinResident', subject: { faction: 2 }, fields: { faction: 2 } };
    const proof = { ...localResidentProof({ programId: CAND, seasonAddress: SEASON, asset: ASSET, residentProgram: RESIDENT_PROGRAM }), residentProgram: RESIDENT_PROGRAM };
    const message = localResidentActMessage(intent, { programId: CAND, seasonAddress: SEASON, wallet: WALLET, rulesetHash: LOCAL_PLAY_RULESET_HASH, blockhash: HASH, resident: { asset: ASSET, generation, proof } });
    const wire = Buffer.concat([Buffer.from([1]), sign(null, Buffer.from(message), privateKey), Buffer.from(message)]);
    return { schema: LOCAL_ACT_SUBMIT_RESIDENT_SCHEMA, name: 'JoinResident', subject: { faction: 2 }, fields: { faction: 2 }, resident: { asset: ASSET, generation, resident_program: RESIDENT_PROGRAM }, transaction_b64: wire.toString('base64') };
  };
  const fresh = chain(); fresh.delete(CITIZEN_AT);
  const r = relay(fresh);
  assert.equal((await r.act.submit(join())).status, 'submitted'); assert.equal(r.sent.length, 1);
  await refusal(relay(chain()).act.submit(join()), 'LocalActAlreadyJoined');
  const sold = chain({ holder: OTHER }); sold.delete(CITIZEN_AT);
  await refusal(relay(sold).act.submit(join()), 'LocalActResidentNotHolder');
  const stale = chain({ gen: 1 }); stale.delete(CITIZEN_AT);
  await refusal(relay(stale).act.submit(join(0)), 'LocalActResidentStale');
});

test('the residents read: the candidate lane only, the relay\'s own wallet only, each pass with its generation and joined', async () => {
  const accounts = chain();
  const asked = [];
  const rpc = async (method, params) => {
    asked.push([method, params[0]]);
    if (method === 'getAccountInfo') return { result: { value: accounts.get(params[0]) ?? null } };
    if (method === 'getProgramAccounts') {
      const f = params[1].filters;
      assert.equal(params[0], CORE); assert.equal(f.find(x => x.memcmp.offset === 1).memcmp.bytes, WALLET, 'the owner is the relay\'s wallet');
      return { result: [{ pubkey: ASSET, account: accounts.get(ASSET) }, { pubkey: key(70), account: row(CORE, assetBytes(OTHER)) }] };
    }
    if (method === 'getMultipleAccounts') return { result: { context: { slot: 91 }, value: params[0].map(a => accounts.get(a) ?? null) } };
    return { error: { code: -1 } };
  };
  const act = createLocalPlayAct({ cfg: cfgOf(CAND), rpc });
  const out = await act.residents({ schema: 'frontier-local-play-nft-residents-v1' });
  assert.equal(out.wallet, WALLET);
  assert.equal(out.policy.residentProgram, RESIDENT_PROGRAM);
  assert.deepEqual(out.residents.map(x => [x.asset, x.generation, x.joined, x.citizen]), [[ASSET, 0, true, CITIZEN_AT]], 'another owner\'s asset from the RPC is dropped');
  await assert.rejects(act.residents({ schema: 'x' }), e => e.code === 'LocalActInvalid');
  // the conquest lane has no residents read at all
  const plain = createLocalPlayAct({ cfg: cfgOf(LOCAL_PLAY_PROGRAM), rpc });
  assert.equal(plain.residents, undefined);
});

// The pass's transfer from the page (TransferResident, candidate lane only).
import { localTransferIx, localTransferMessage } from '../../permutation-server/web/frontier/flocalresident.mjs';
import { transferResidentIx } from '../../permutation-nft-resident-spike/src/resident-ix.mjs';

test('the page\'s TransferResident is byte for byte the resident program\'s own builder (keys, flags, data)', () => {
  const args = { owner: WALLET, asset: ASSET, collection: COLLECTION, to: OTHER };
  const page = localTransferIx({ residentProgram: RESIDENT_PROGRAM, ...args });
  const spike = transferResidentIx({ program: RESIDENT_PROGRAM, ...args });
  assert.equal(page.programId, spike.programId);
  assert.deepEqual(page.keys.map(k => [k.pubkey, k.isSigner, k.isWritable]), spike.keys.map(k => [k.pubkey, k.isSigner, k.isWritable]));
  assert.deepEqual([...page.data], [...spike.data]);
  assert.throws(() => localTransferIx({ residentProgram: RESIDENT_PROGRAM, ...args, to: WALLET }), e => e.code === 'LocalActTransferToSelf');
});

function transferOf(to, { generation = 1, collection = COLLECTION } = {}) {
  const message = localTransferMessage({ programId: CAND, wallet: WALLET, asset: ASSET, collection, residentProgram: RESIDENT_PROGRAM, to, blockhash: HASH });
  const wire = Buffer.concat([Buffer.from([1]), sign(null, Buffer.from(message), privateKey), Buffer.from(message)]);
  return { schema: LOCAL_ACT_SUBMIT_RESIDENT_SCHEMA, name: 'TransferResident', subject: {}, fields: { to }, resident: { asset: ASSET, generation, resident_program: RESIDENT_PROGRAM }, transaction_b64: wire.toString('base64') };
}

test('the current holder\'s transfer goes out once; a holder that sold it, a stale generation, itself, another collection and the conquest lane are refused before any send', async () => {
  const ok = relay(chain({ gen: 1 }));
  assert.equal((await ok.act.submit(transferOf(OTHER))).status, 'submitted'); assert.equal(ok.sent.length, 1);
  const sold = relay(chain({ holder: OTHER, gen: 2 }));
  await refusal(sold.act.submit(transferOf(key(80), { generation: 2 })), 'LocalActResidentNotHolder'); assert.deepEqual(sold.sent, []);
  const stale = relay(chain({ gen: 2 }));
  await refusal(stale.act.submit(transferOf(OTHER, { generation: 1 })), 'LocalActResidentStale'); assert.deepEqual(stale.sent, []);
  const self = relay(chain({ gen: 1 }));
  const body = transferOf(OTHER); body.fields = { to: WALLET };
  await refusal(self.act.submit(body), 'LocalActTransferToSelf'); assert.deepEqual(self.calls, [], 'refused before anything is read');
  const coll = relay(chain({ gen: 1 }));
  await refusal(coll.act.submit(transferOf(OTHER, { collection: key(81) })), 'LocalActMessageMismatch'); assert.deepEqual(coll.sent, []);
  const plain = relay(chain({ gen: 1 }), LOCAL_PLAY_PROGRAM);
  await refusal(plain.act.submit(transferOf(OTHER)), 'LocalActNotAllowed'); assert.deepEqual(plain.calls, []);
});

// KNOWN BOUNDARY (2026-11-15 review): TransferResident's data is the single byte 0x51 — the signed bytes carry no
// holder generation, so the relay's `resident.generation` is the page's statement, not something the owner signed.
// A transfer signed at generation 0 and held unsent can be sent after A→B→A (generation 2) by stating 2: A owns the
// pass again, the bytes are the same. The window is the blockhash's lifetime (~151 slots), and the signed bytes could
// also go to the chain directly (the program checks only the owner's signature for 0x51). The ordinary 0xE2/0xDD
// orders differ: their signed bytes carry the generation and the program checks it.
// The fix proposed (not implemented): the relay issues the transfer's blockhash itself, bound to (asset, generation
// read then), and accepts a transfer only on such a blockhash whose bound generation is the record's now. That closes
// the relay path; the direct-chain path stays bounded by the blockhash lifetime until the program's ABI binds a
// generation (not decided here). The page's transfer send is held in worlds until then.
test('KNOWN GAP: an old transfer signed at generation 0, sent after A→B→A stating generation 2', { todo: 'relay-bound transfer blockhash not implemented: the relay accepts it today' }, async () => {
  const r = relay(chain({ gen: 2 }));   // A (WALLET) holds the pass again, at generation 2
  const old = transferOf(OTHER, { generation: 0 });   // signed while the record said 0: the bytes carry no generation
  old.resident.generation = 2;          // the unsigned statement now matches the record
  await refusal(r.act.submit(old), 'LocalActResidentStale');   // the wanted outcome; today it is sent
  assert.deepEqual(r.sent, []);
});
