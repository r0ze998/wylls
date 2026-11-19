// One action per resident per turn (Q16-2) on the LOCAL-PLAY relays (local-play-turns.mjs): a resident's relay — started
// with `--resident-turns`, as the launcher starts every operator resident's — sends at most one command per bell for its
// wallet's Citizen, whoever posts it and through however many relays of that wallet share the lease directory. A
// KEY-USING test (scripts/ci/node-key-tests.txt): an in-memory test Ed25519 key signs; the runner is a stand-in; nothing
// is sent anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { encode, decode as b58d } from '../client/src/base58.mjs';
import { localActIntent, localActMessage, LocalActError, LOCAL_ACT_SUBMIT_SCHEMA, LOCAL_ACT_PRESEND_REFUSALS, createLocalPlayAct } from '../src/frontier/local-play-act.mjs';
import { LOCAL_PLAY_PROGRAM, LOCAL_PLAY_RULESET_HASH } from '../src/frontier/local-play-relay.mjs';
import { parseArgs, actFromArgs } from '../src/frontier/local-play-relay-server.mjs';
import { CLOCK_SYSVAR } from '../src/frontier/local-play-turns.mjs';
import { createResidentTurns, RESIDENT_ALREADY_ACTED } from '../src/frontier/resident-turns.mjs';
import { residentTurn } from '../src/frontier/local-play-operator-residents.mjs';
import { createResidentMemory, createOperatorBudget } from '../src/frontier/local-play-operator-policy.mjs';
import { startOperatorResidents, startExternalResidents } from '../src/frontier/local-play-launcher.mjs';
import { seasonAddresses, seasonPda } from '../../permutation-server/web/frontier/faddr.mjs';
import { LAYOUTS as V2 } from '../../permutation-server/web/sdk/frontier/abi-v2-layouts.mjs';
import { LOCAL_ACT_PRESEND_REFUSALS as PAGE_PRESEND } from '../../permutation-server/web/frontier/flocalplay-act.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lp-resident-turns-'));
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const W = { address: encode(publicKey.export({ format: 'der', type: 'spki' }).subarray(12)), privateKey };
const SEASON = seasonPda(LOCAL_PLAY_PROGRAM, 11)[0], HASH = encode(new Uint8Array(32).fill(7));
const pins = { program: LOCAL_PLAY_PROGRAM, season: SEASON, seasonId: 11, wallet: W.address, rulesetHash: LOCAL_PLAY_RULESET_HASH };
const cfg = { localPlay: true, rpc: 'http://127.0.0.1:41864', program: LOCAL_PLAY_PROGRAM, season: SEASON, wallet: W.address, rulesetHash: LOCAL_PLAY_RULESET_HASH, prepareBin: '/x/depart', cuLimit: '1000000', loadedLimit: '67108864' };
const HOME = { p: 3, q: -2, site: 4 };
const A = seasonAddresses(LOCAL_PLAY_PROGRAM, '11'), CITIZEN_AT = A.of('Citizen', { wallet: W.address });
const INTENTS = {
  Harvest: { name: 'Harvest', subject: { holding: HOME }, fields: {} },
  Train: { name: 'Train', subject: { holding: HOME }, fields: { unit: 0, n: 10 } },
  Build: { name: 'Build', subject: { holding: HOME }, fields: { item: 1 } },
  Join: { name: 'Join', subject: { faction: 2 }, fields: { faction: 2, session: W.address, session_expiry: '1785600000' } },
};
const body = intent => {
  const message = localActMessage(localActIntent(intent, { wallet: W.address }), pins, HASH).message;
  const tx = Buffer.concat([Buffer.from([1]), sign(null, message, W.privateKey), Buffer.from(message)]).toString('base64');
  return { schema: LOCAL_ACT_SUBMIT_SCHEMA, name: intent.name, subject: intent.subject, fields: intent.fields, transaction_b64: tx };
};
function citizenBytes() { const b = new Uint8Array(384), v = new DataView(b.buffer); b.set(Buffer.from('PSF1CITZ'), 0); v.setBigUint64(8, 11n, true); v.setUint16(16, 2, true); b.set(b58d(W.address), 64); b.set(b58d(CITIZEN_AT).subarray(0, 8), 208); return b; }
function holdingBytes() { const b = new Uint8Array(1280), v = new DataView(b.buffer); b.set(Buffer.from('PSF1HOLD'), 0); v.setBigUint64(8, 11n, true); v.setInt16(64, HOME.p, true); v.setInt16(66, HOME.q, true); b[68] = HOME.site; b.set(b58d(CITIZEN_AT), 72); return b; }
const GENESIS = 1_000_000;
function seasonBytes() { const L = V2.accounts.find(a => a.kind === 'Season'); const b = Buffer.alloc(L.size); b.writeBigInt64LE(BigInt(GENESIS), L.fields.find(f => f.name === 'GENESIS_TS').off); return b; }
const clockBytes = unix => { const b = Buffer.alloc(40); b.writeBigInt64LE(BigInt(unix), 32); return b; };
const row = (bytes, owner = LOCAL_PLAY_PROGRAM) => (bytes === null ? null : { owner, executable: false, lamports: 1, data: [Buffer.from(bytes).toString('base64'), 'base64'] });

/** One stand-in runner (shared by every relay of the test: one chain) and its clock. */
function runner() {
  const chain = { bell: 4, sends: [], joined: true };
  chain.rpc = async (method, params) => {
    if (method === 'getMultipleAccounts') {
      const at = params[0];
      if (at.length === 2 && at[1] === CLOCK_SYSVAR) return { result: { context: { slot: 91 }, value: [row(seasonBytes()), row(clockBytes(GENESIS + 600 * chain.bell + 5), 'Sysvar1111111111111111111111111111111111111')] } };
      return { result: { context: { slot: 91 }, value: at.map(a => (a === CITIZEN_AT ? (chain.joined ? row(citizenBytes()) : null) : row(holdingBytes()))) } };
    }
    if (method === 'sendTransaction') { await new Promise(r => setImmediate(r)); chain.sends.push(params[0]); return { result: encode(Buffer.from(params[0], 'base64').subarray(1, 65)) }; }
    return { error: { code: -1 } };
  };
  return chain;
}
const rejects = (p, code) => assert.rejects(p, e => e instanceof LocalActError && e.code === code, code);

test('two writers racing for one resident in one bell, through TWO relays of its wallet sharing the lease: exactly one lands; the next bell both may act again', async () => {
  const chain = runner(), dir = tmp();
  const relayA = createLocalPlayAct({ cfg, rpc: chain.rpc, turns: createResidentTurns({ dir }) });
  const relayB = createLocalPlayAct({ cfg, rpc: chain.rpc, turns: createResidentTurns({ dir }) });   // (another process: its own memory)
  const got = await Promise.allSettled([relayA.submit(body(INTENTS.Harvest)), relayB.submit(body(INTENTS.Train))]);
  assert.equal(got.filter(g => g.status === 'fulfilled').length, 1, JSON.stringify(got.map(g => g.reason?.code ?? g.value?.status)));
  const lost = got.find(g => g.status === 'rejected').reason;
  assert.equal(lost.code, RESIDENT_ALREADY_ACTED); assert.equal(lost.status, 409); assert.equal(lost.detail.bell, 4); assert.equal(lost.detail.citizen, CITIZEN_AT);
  assert.equal(chain.sends.length, 1, 'one send for the bell');
  // a pre-send refusal: the page and the operator residents say "not sent" for it (one list on both sides)
  assert.ok(LOCAL_ACT_PRESEND_REFUSALS.includes(RESIDENT_ALREADY_ACTED)); assert.deepEqual([...PAGE_PRESEND], [...LOCAL_ACT_PRESEND_REFUSALS]);
  // the bytes of the refused command were not consumed: in the next bell the same signed command goes (once)
  chain.bell = 5;
  const loserBody = got[0].status === 'rejected' ? body(INTENTS.Harvest) : body(INTENTS.Train);
  const loserRelay = got[0].status === 'rejected' ? relayA : relayB;
  assert.equal((await loserRelay.submit(loserBody)).status, 'submitted');
  await rejects(relayA.submit(body(INTENTS.Build)), RESIDENT_ALREADY_ACTED);
  chain.bell = 6;
  assert.equal((await relayA.submit(body(INTENTS.Build))).status, 'submitted');
  assert.equal(chain.sends.length, 3);
});

test('one relay, many concurrent posts for its resident in one bell: one send; a Join is no turn action; without --resident-turns nothing changes', async () => {
  const chain = runner();
  const relay = createLocalPlayAct({ cfg, rpc: chain.rpc, turns: createResidentTurns({ dir: tmp() }) });
  const got = await Promise.allSettled([INTENTS.Harvest, INTENTS.Train, INTENTS.Build].map(i => relay.submit(body(i))));
  assert.equal(got.filter(g => g.status === 'fulfilled').length, 1);
  assert.ok(got.filter(g => g.status === 'rejected').every(g => g.reason.code === RESIDENT_ALREADY_ACTED));
  assert.equal(chain.sends.length, 1);
  // Join (no Citizen yet) does not take the turn
  const fresh = runner(); fresh.joined = false;
  const j = createLocalPlayAct({ cfg, rpc: fresh.rpc, turns: createResidentTurns({ dir: tmp() }) });
  assert.equal((await j.submit(body(INTENTS.Join))).status, 'submitted');
  fresh.joined = true;
  assert.equal((await j.submit(body(INTENTS.Harvest))).status, 'submitted', 'Join and the first command in one bell');
  // a person's relay (no flag): several commands in one bell, as before
  const person = runner();
  const p = createLocalPlayAct({ cfg, rpc: person.rpc });
  for (const i of [INTENTS.Harvest, INTENTS.Train, INTENTS.Build]) assert.equal((await p.submit(body(i))).status, 'submitted');
  assert.equal(person.sends.length, 3);
});

test('restart: a relay started again over the same lease directory refuses the bell its predecessor used', async () => {
  const chain = runner(), dir = tmp();
  assert.equal((await createLocalPlayAct({ cfg, rpc: chain.rpc, turns: createResidentTurns({ dir }) }).submit(body(INTENTS.Harvest))).status, 'submitted');
  await rejects(createLocalPlayAct({ cfg, rpc: chain.rpc, turns: createResidentTurns({ dir }) }).submit(body(INTENTS.Train)), RESIDENT_ALREADY_ACTED);
  assert.equal(chain.sends.length, 1);
});

test('the command line: --resident-turns takes an absolute directory and reaches the economy routes; the launcher gives it to every operator resident\'s relay', async () => {
  const base = ['--local-play', '--rpc', cfg.rpc, '--program', cfg.program, '--season', cfg.season, '--wallet', cfg.wallet, '--ruleset-hash', cfg.rulesetHash, '--prepare-bin', '/x/d', '--cu-limit', '1', '--loaded-limit', '1', '--listen-port', '41865'];
  assert.equal(parseArgs(base).residentTurns, undefined, 'absent: no key, as before');
  assert.equal(parseArgs([...base, '--resident-turns', '/tmp/rt']).residentTurns, '/tmp/rt');
  assert.throws(() => parseArgs([...base, '--resident-turns', 'rel/dir']), /absolute/);
  let made = null;
  actFromArgs({ cfg, economy: true, turns: 'T' }, { create: o => { made = o; return {}; } });
  assert.equal(made.turns, 'T');
  actFromArgs({ cfg, economy: true }, { create: o => { made = o; return {}; } });
  assert.deepEqual(made, { cfg }, 'without it: the same call as before');
  // the launcher: one operator resident (its runner's homes and its public wallet line as the launcher reads them);
  // its relay's arguments end with --resident-turns <world>/resident-turns
  const { OPERATOR_RESIDENTS_SCHEMA, OPERATOR_RESIDENTS_MODE } = await import('../src/frontier/local-play-operator-policy.mjs');
  const dir = tmp(); const launched = [];
  fs.writeFileSync(path.join(dir, 'runner.out'), JSON.stringify({ natural_step: 'ready-for-join', home_provinces: [{ p: 0, q: 1, nation: 1 }] }) + '\n');
  fs.writeFileSync(path.join(dir, 'operators.out'), JSON.stringify({ schema: OPERATOR_RESIDENTS_SCHEMA, mode: OPERATOR_RESIDENTS_MODE, test_only: true, wallets: [W.address] }) + '\n');
  const out = await startOperatorResidents({ n: 1, dir, ports: [41851], rpc: 41852, herald: 41853, players: ['11111111111111111111111111111112'], root: '/r', stopping: () => false,
    launch: (name, cmd, args) => launched.push({ name, args }), launchSide: () => {}, relayArgsFor: (w, p) => ['--wallet', w, '--listen-port', String(p)],
    limit: { operatorHomesMs: 1000, operatorWalletsMs: 1000, operatorFund: async () => {} }, pace: {} });
  assert.deepEqual([...out.wallets], [W.address]);
  const op = launched.find(l => l.name === 'relay-op-0');
  assert.deepEqual(op.args.slice(-4), ['--listen-port', '41851', '--resident-turns', path.resolve(dir, 'resident-turns')]);
  // ⑤B: an external AI resident's relay is a resident's relay too — the same world lease directory (a stand-in launch;
  //  only its proxy listens, on loopback 41854, and is closed here)
  const EXT_W = 'Vote111111111111111111111111111111111111111';   // (any public address; an external resident signs with its own wallet)
  const side = [], proxies = [];
  try {
    const ext = await startExternalResidents({ wallets: [EXT_W], dir, ports: [{ herald: 41854, relay: 41855 }], rpc: 41852, internalHerald: 41853, launcherPort: 41850,
      players: [W.address], root: '/r', proxies, stopping: () => false, relayArgsFor: (w, p) => ['--wallet', w, '--listen-port', String(p)],
      launchSide: (name, cmd, args) => { side.push({ name, args }); fs.writeFileSync(path.join(dir, `${name}.out`), JSON.stringify({ listen: '127.0.0.1:41855' }) + '\n'); },
      limit: { externalFund: async () => {}, externalListenTries: 5 } });
    assert.deepEqual([...ext.wallets], [EXT_W]);
    const er = side.find(l => l.name === 'relay-ext-0');
    assert.deepEqual(er.args.slice(-4), ['--listen-port', '41855', '--resident-turns', path.resolve(dir, 'resident-turns')]);
  } finally { await Promise.all(proxies.map(x => new Promise(r => x.close(() => r())))); }
});

test('an operator resident told ResidentAlreadyActed waits for the next bell: nothing marked tried, nothing spent', async () => {
  const r = { index: 0, key: { address: W.address }, memory: createResidentMemory(0), budget: createOperatorBudget({ maxActs: 5, maxRefusals: 1, minGapMs: 0 }), lastRefusal: { code: RESIDENT_ALREADY_ACTED, detail: { bell: 9 } } };
  const decisions = r.memory.decisions;
  // (not joined yet: the rule decides a Join; its relay answers that this resident's bell is taken)
  const deps = { now: () => 1, nowSecs: async () => 1_700_000_000, read: async () => ({ v: 1, citizen: null }), submit: async () => ({ ok: false, code: RESIDENT_ALREADY_ACTED }), follow: async () => { throw new Error('nothing to follow'); } };
  const line = await residentTurn(r, { homes: [], deps });
  assert.equal(line.step, 'act'); assert.equal(line.act, 'Join');
  assert.equal(line.outcome, 'wait'); assert.equal(line.code, RESIDENT_ALREADY_ACTED); assert.match(line.detail, /"bell":9/);
  assert.deepEqual(r.budget.state(), { sent: 0, refusalsInRow: 0, stopped: null }, 'no refusal counted: maxRefusals 1 would otherwise stop it');
  assert.equal(r.budget.allow(2).ok, true, 'it may ask again');
  assert.equal(r.memory.decisions, decisions, 'the decision memory is unchanged: the same command next bell');
});

test('the prepared flows (Depart, the return, conquest: local-play-relay.mjs) hold to the same lease; a refused submit keeps its prepared message for the next bell', async () => {
  const { createLocalPlayRelay, singleSigned, LocalPlayError, SUBMIT_SCHEMA } = await import('../src/frontier/local-play-relay.mjs');
  const { createHash } = await import('node:crypto');
  const chain = runner(), dir = tmp();
  const messages = [1, 2].map(n => Buffer.concat([Buffer.from([1, 0, 0]), Buffer.alloc(200, n)]));
  let i = 0;
  const report = () => { const m = messages[i++ % 2]; return { status: 'prepared', blockhash: { last_valid_block_height: '100' },
    prepared: { fee_payer: W.address, signers: [W.address], message_b64: m.toString('base64'), message_digest: createHash('sha256').update(m).digest('hex') } }; };
  const relayCfg = { ...cfg, prepareBin: '/nonexistent/depart-prepare' };
  const rpc = async (method, params) => {
    if (method === 'getBlockHeight') return { result: 50 };
    if (method === 'sendTransaction') { chain.sends.push(params[0]); return { result: encode(singleSigned(Buffer.from(params[0], 'base64')).signature) }; }
    return chain.rpc(method, params);
  };
  const relay = createLocalPlayRelay({ cfg: relayCfg, prepare: { prepare: async () => report(), close() {} }, rpc, turns: createResidentTurns({ dir }) });
  const request = { cluster: 'localnet', program: LOCAL_PLAY_PROGRAM, season: SEASON, wallet: W.address, payer: W.address, deployment: { program_version: '18436', ruleset_hash: LOCAL_PLAY_RULESET_HASH } };
  await relay.prepare(request); await relay.prepare(request);
  const submit = m => relay.submit({ schema: SUBMIT_SCHEMA, message_digest: createHash('sha256').update(m).digest('hex'),
    transaction_b64: Buffer.concat([Buffer.from([1]), sign(null, m, W.privateKey), m]).toString('base64') });
  const got = await Promise.allSettled(messages.map(submit));
  assert.equal(got.filter(g => g.status === 'fulfilled').length, 1);
  const lost = got.find(g => g.status === 'rejected').reason;
  assert.ok(lost instanceof LocalPlayError); assert.equal(lost.code, RESIDENT_ALREADY_ACTED); assert.equal(lost.status, 409); assert.equal(lost.detail.bell, 4);
  assert.equal(chain.sends.length, 1);
  chain.bell = 5;
  const again = await submit(messages[got[0].status === 'rejected' ? 0 : 1]);
  assert.equal(again.status, 'submitted', 'the reservation was given back: the same prepared message goes in the next bell');
  assert.equal(chain.sends.length, 2);
});
