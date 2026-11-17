// The ordinary march in local play: the relay's validator (local-play-march.mjs). The page's Depart, rebuilt exactly;
// the seal's shape and its binding; every refusal BEFORE a read or a send.
//
// THIS FILE MAKES NO KEY and runs under the no-key guard:
//   node --import ./screens/codex/no-key-node.mjs --test ./test/frontier-local-play-march.test.mjs
// The "signed" transactions here carry 64 zero bytes as their signature (no key exists), so the flow must refuse them at
// its signature check; a stub RPC records every call (none may happen).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as M from '../src/frontier/local-play-march.mjs';
import { LOCAL_PLAY_SEASON_ID, LOCAL_PLAY_RULESET_HASH as RULESET_HASH_V3_HEX } from '../src/frontier/local-play-relay.mjs';
import { accountsFor, buildShape } from '../../permutation-server/web/frontier/fplay.mjs';
import { seasonAddresses, hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { profileForHash } from '../../permutation-server/web/sdk/frontier/profile.mjs';
import { budgetPrefix } from '../../permutation-server/web/sdk/frontier/budgets.mjs';
import { compileMessage } from '../../permutation-server/web/sdk/solana-tx.mjs';
import { LOCAL_PLAY_PROGRAM } from '../../permutation-server/web/frontier/flocalplay.mjs';

const WALLET = 'BbPGAbHDvV5U43zQ5E8FmSnEzZ7r2vwWAZWTNAPTTSUT', OTHER = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';   // (not the program's address)
const BLOCKHASH = '7pshbHEvHUftsEcrGUPb9FoVXWmV1gEs1R1cZCGXjSCt';
const A = seasonAddresses(LOCAL_PLAY_PROGRAM, String(LOCAL_PLAY_SEASON_ID));
const PINS = Object.freeze({ program: LOCAL_PLAY_PROGRAM, season: A.season, seasonId: LOCAL_PLAY_SEASON_ID, wallet: WALLET, rulesetHash: RULESET_HASH_V3_HEX });
const HOME = { p: 2, q: 0, site: 11 };
const HOST = hostId({ p: 2, q: 0, site: 11, gen: 2, seq: 0 }).toString();
const SEAL = '8' + '0'.repeat(1) + 'ab'.repeat(164);   // 165 bytes, first byte 0x80: compressed, not infinity
const COMMIT = 'cd'.repeat(32);
const intentBody = (over = {}) => ({ name: 'Depart', subject: { holding: { ...HOME }, province: { p: 2, q: 0 } },
  fields: { host_id: HOST, commit: COMMIT, seal: SEAL, arrive_bell: 12, tip: '1000', transit_slot: 0 }, ...over });
const withFields = f => { const b = intentBody(); b.fields = { ...b.fields, ...f }; return b; };

test('the intent: only the ordinary Depart, every field in its form; the host must be this village\'s', () => {
  const i = M.localMarchIntent(intentBody());
  assert.equal(i.name, 'Depart'); assert.ok(Object.isFrozen(i) && Object.isFrozen(i.fields) && Object.isFrozen(i.subject.holding));
  const refused = (v, code) => assert.throws(() => M.localMarchIntent(v), e => e.code === code, code + ' ' + JSON.stringify(v).slice(0, 80));
  refused({ ...intentBody(), name: 'Reveal' }, 'LocalMarchNotAllowed');
  refused({ ...intentBody(), name: 'Join' }, 'LocalMarchNotAllowed');
  refused({ ...intentBody(), extra: 1 }, 'LocalMarchInvalid');
  refused(withFields({ seal: SEAL.slice(2) }), 'LocalMarchSeal');                              // 164 bytes
  refused(withFields({ seal: 'c0' + SEAL.slice(2) }), 'LocalMarchSeal');                       // infinity flag
  refused(withFields({ seal: '00' + SEAL.slice(2) }), 'LocalMarchSeal');                       // not compressed
  refused(withFields({ seal: SEAL.toUpperCase() }), 'LocalMarchSeal');
  refused(withFields({ commit: '00'.repeat(32) }), 'LocalMarchInvalid');
  refused(withFields({ commit: 'cd'.repeat(31) }), 'LocalMarchInvalid');
  refused(withFields({ host_id: 12 }), 'LocalMarchInvalid');                                  // not a decimal string
  refused(withFields({ host_id: '18446744073709551616' }), 'LocalMarchInvalid');              // > u64
  refused(withFields({ tip: '-1' }), 'LocalMarchInvalid');
  refused(withFields({ arrive_bell: 0 }), 'LocalMarchInvalid');
  refused(withFields({ arrive_bell: 1.5 }), 'LocalMarchInvalid');
  refused(withFields({ transit_slot: 4 }), 'LocalMarchInvalid');
  refused(withFields({ host_id: hostId({ p: 2, q: 0, site: 10, gen: 2, seq: 0 }).toString() }), 'LocalMarchNotYourHost');   // another site
  refused(withFields({ host_id: hostId({ p: 1, q: 1, site: 11, gen: 2, seq: 0 }).toString() }), 'LocalMarchNotYourHost');   // another province
  const wide = intentBody(); wide.subject.province = { p: 200, q: 0 };
  refused(wide, 'LocalMarchWideHolding');
  const extraField = intentBody(); extraField.fields = { ...extraField.fields, stance: 1 };
  refused(extraField, 'LocalMarchInvalid');
});

test('the seal binding is the program\'s: seal_root = sha256(commit ‖ sha256(seal))', () => {
  const b = M.sealBinding(M.localMarchIntent(intentBody()));
  const ct = createHash('sha256').update(Buffer.from(SEAL, 'hex')).digest();
  assert.equal(b.ct_hash, ct.toString('hex'));
  assert.equal(b.seal_root, createHash('sha256').update(Buffer.concat([Buffer.from(COMMIT, 'hex'), ct])).digest('hex'));
  assert.ok(M.sealFlagOk(0x80) && M.sealFlagOk(0xa0) && !M.sealFlagOk(0xc0) && !M.sealFlagOk(0x00), 'host.rs seal_flag_ok');
});

test('the message is the page\'s own Depart, byte for byte: the wallet as fee payer and actor, the local loaded limit', () => {
  const msg = M.localMarchMessage(M.localMarchIntent(intentBody()), PINS, BLOCKHASH);
  const profile = profileForHash(RULESET_HASH_V3_HEX);
  const v = { addresses: A, wallet: WALLET, actor: WALLET, profile, holding: HOME, province: { p: 2, q: 0 } };
  const built = buildShape({ programId: LOCAL_PLAY_PROGRAM, name: 'Depart', accounts: accountsFor('Depart', v), feePayer: WALLET, blockhash: BLOCKHASH, profile,
    fields: { host_id: BigInt(HOST), commit: Uint8Array.from(Buffer.from(COMMIT, 'hex')), seal: Uint8Array.from(Buffer.from(SEAL, 'hex')), arrive_bell: 12, tip: 1000n, transit_slot: 0 } });
  assert.equal(built.signers.length, 0, 'no key but the wallet');
  const page = Uint8Array.from(compileMessage({ feePayer: WALLET, recentBlockhash: BLOCKHASH, instructions: [...budgetPrefix('Depart', { profile, loadedLimit: 67108864 }), built.expected] }));
  assert.deepEqual(Buffer.from(msg), Buffer.from(page));
  // any field changes the bytes
  for (const f of [{ arrive_bell: 13 }, { tip: '1001' }, { transit_slot: 1 }, { commit: 'ce'.repeat(32) }]) {
    assert.notDeepEqual(Buffer.from(M.localMarchMessage(M.localMarchIntent(withFields(f)), PINS, BLOCKHASH)), Buffer.from(msg), JSON.stringify(f));
  }
});

// a transaction wire with ONE all-zero signature over `message` (no key exists)
const zeroSigned = message => Buffer.concat([Buffer.from([1]), Buffer.alloc(64), Buffer.from(message)]).toString('base64');
const submitBody = (body = intentBody(), message = null) => ({ schema: M.LOCAL_MARCH_SUBMIT_SCHEMA, ...body, transaction_b64: zeroSigned(message ?? M.localMarchMessage(M.localMarchIntent(body), PINS, BLOCKHASH)) });

test('a submit is refused before anything is read or sent: schema, another command, another message, a bad signature', async () => {
  const calls = [];
  const cfg = { localPlay: true, rpc: 'http://127.0.0.1:41924', program: LOCAL_PLAY_PROGRAM, season: A.season, wallet: WALLET, rulesetHash: RULESET_HASH_V3_HEX, prepareBin: '/nonexistent/prepare', cuLimit: 1000000, loadedLimit: 67108864 };
  let flow;
  try { flow = M.createLocalPlayMarch({ cfg, rpc: async (m, p) => { calls.push(m); return { result: null }; }, runnerInstance: 'ab'.repeat(32), trial: true }); }
  catch (e) { flow = null; assert.fail('a well-formed config is accepted: ' + e.message); }
  const refused = async (body, code) => { await assert.rejects(flow.submit(body), e => e.code === code, code); };
  await refused({ ...submitBody(), schema: 'frontier-local-play-act-submit-v1' }, 'LocalMarchInvalid');
  await refused({ ...submitBody(), name: 'Muster' }, 'LocalMarchNotAllowed');
  // the signed message is another march (another arrival) than the stated one
  await refused(submitBody(intentBody(), M.localMarchMessage(M.localMarchIntent(withFields({ arrive_bell: 13 })), PINS, BLOCKHASH)), 'LocalMarchMessageMismatch');
  // the exact message, but its one signature does not verify (zero bytes: no key here)
  await refused(submitBody(), 'LocalMarchSigner');
  // signed for another fee payer
  const other = M.localMarchMessage(M.localMarchIntent(intentBody()), { ...PINS, wallet: OTHER }, BLOCKHASH);
  await refused(submitBody(intentBody(), other), 'LocalMarchSigner');
  await refused({ ...submitBody(), transaction_b64: 'not base64!' }, 'LocalMarchInvalid');
  assert.deepEqual(calls, [], 'nothing was read and nothing was sent');
  assert.equal(flow.stats().history, 0);
  // status knows only what this relay sent
  await assert.rejects(flow.status({ schema: M.LOCAL_MARCH_STATUS_SCHEMA, signature: '1'.repeat(88) }), e => e.code === 'LocalMarchUnknownSignature');
  flow.close();
  await assert.rejects(flow.submit(submitBody()), e => e.code === 'LocalMarchClosed', 'a closing relay sends nothing');
  assert.deepEqual(calls, []);
});

test('the presend refusals are the only "not sent" codes; the send refusal and a used message are not among them', () => {
  for (const c of ['LocalMarchSendRefused', 'LocalMarchMessageUsed', 'LocalMarchUnknownSignature']) assert.ok(!M.LOCAL_MARCH_PRESEND_REFUSALS.includes(c), c);
  assert.deepEqual([...M.LOCAL_MARCH_COMMANDS], ['Depart'], 'a closed list of one: no Reveal, no other command');
});

test('the module: no Reveal builder, no storage, no key, no retry loop', async () => {

  const src = readFileSync(new URL('../src/frontier/local-play-march.mjs', import.meta.url), 'utf8').split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  for (const w of ['generateKeyPair', 'Keypair', 'localStorage', 'writeFile', 'setInterval', 'Reveal(', "'Reveal'", 'retry']) assert.ok(!src.includes(w), w);
  assert.equal(src.split("rpc('sendTransaction'").length - 1, 1, 'one send');
  assert.match(src, /seen\.set\(digest, Object\.freeze\(\{ signature: ok\.signature \}\)\);   \/\/ before sending: at most once/);
});

test('the listener: the march routes exist only with the economy routes; refusals keep their own status and code; nothing is sent', async () => {
  const { marchFromArgs, serveLocalPlayRelay } = await import('../src/frontier/local-play-relay-server.mjs');
  const { createLocalPlayRelay } = await import('../src/frontier/local-play-relay.mjs');
  const L = await import('../src/frontier/local-play-launcher.mjs');
  const cfg = { localPlay: true, rpc: 'http://127.0.0.1:41924', program: LOCAL_PLAY_PROGRAM, season: A.season, wallet: WALLET, rulesetHash: RULESET_HASH_V3_HEX, prepareBin: '/nonexistent/prepare', cuLimit: 1000000, loadedLimit: 67108864 };
  // the builder: nothing unless the economy flag is exactly true; the relay's configuration and the one runner instance, nothing else
  const made = [], create = a => { made.push(a); return 'M'; };
  for (const economy of [false, undefined, null, 'page-signed-v1', 1]) assert.equal(marchFromArgs({ cfg, economy, runnerInstance: 'ab'.repeat(32), marchTrial: true }, { create }), null, String(economy));
  // DEFAULT CLOSED (independent review): the economy flag alone, or without a pin, serves NO march
  assert.equal(marchFromArgs({ cfg, economy: true }, { create }), null, 'economy alone');
  assert.equal(marchFromArgs({ cfg, economy: true, runnerInstance: 'ab'.repeat(32) }, { create }), null, 'economy and a pin, no trial');
  assert.equal(marchFromArgs({ cfg, economy: true, marchTrial: true }, { create }), null, 'trial without a pin');
  assert.equal(marchFromArgs({ cfg, economy: true, runnerInstance: 'ab'.repeat(32), marchTrial: 'yes' }, { create }), null);
  assert.deepEqual(made, []);
  assert.equal(marchFromArgs({ cfg, economy: true, runnerInstance: 'ab'.repeat(32), marchTrial: true }, { create }), 'M');
  assert.deepEqual(made, [{ cfg, runnerInstance: 'ab'.repeat(32), trial: true }]);
  // the launcher's proxy admits the two paths, and no Reveal path of the march
  for (const p of ['capability', 'submit', 'status']) assert.ok(L.WORLD_POST_ROUTES.includes(`/gw/f/local-play/march/${p}`), p);
  assert.ok(!L.WORLD_POST_ROUTES.some(r => /march\/(reveal|context|prepare)/.test(r)));
  // over loopback HTTP: without `march` → 404; with it → refusals with their own status and code, and no RPC call
  const depart = () => createLocalPlayRelay({ cfg, prepare: { prepare: async () => ({ status: 'blocked' }), close() {} } });
  const call = async (s, path, b) => { const r = await fetch(`http://127.0.0.1:${s.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return [r.status, (await r.json()).code]; };
  const bare = await serveLocalPlayRelay(depart(), 0);
  try { for (const p of ['capability', 'submit', 'status']) assert.equal((await call(bare, `/f/local-play/march/${p}`, {}))[0], 404, p); } finally { await bare.close(); }
  const calls = [], march = M.createLocalPlayMarch({ cfg, rpc: async m => { calls.push(m); return { result: null }; }, runnerInstance: 'ab'.repeat(32), trial: true });
  const s = await serveLocalPlayRelay(depart(), 0, { march });
  try {
    assert.deepEqual(await call(s, '/f/local-play/march/submit', submitBody()), [403, 'LocalMarchSigner']);
    assert.deepEqual(await call(s, '/f/local-play/march/submit', { ...submitBody(), name: 'Reveal' }), [403, 'LocalMarchNotAllowed']);
    assert.deepEqual(await call(s, '/f/local-play/march/status', { schema: M.LOCAL_MARCH_STATUS_SCHEMA, signature: '1'.repeat(88) }), [404, 'LocalMarchUnknownSignature']);
    assert.notEqual((await fetch(`http://127.0.0.1:${s.port}/f/local-play/march/status`)).status, 200, 'never by GET');
  } finally { await s.close(); }
  assert.ok(march.closed(), 'closing the listener closes the march first');
  assert.deepEqual(calls, []);
});

test('the capability: read-only, the runner\'s own instance word for this wallet, never the pin alone; nothing sent', async () => {
  const cfg = { localPlay: true, rpc: 'http://127.0.0.1:41924', program: LOCAL_PLAY_PROGRAM, season: A.season, wallet: WALLET, rulesetHash: RULESET_HASH_V3_HEX, prepareBin: '/nonexistent/prepare', cuLimit: 1000000, loadedLimit: 67108864 };
  const PIN = 'ab'.repeat(32), body = { schema: M.LOCAL_MARCH_CAPABILITY_SCHEMA };
  const runner = instance => { const calls = []; return { calls, rpc: async (m, p) => { calls.push([m, p]); return { result: { context: { slot: 7, instance }, value: [] } }; } }; };
  // no pin: refused, nothing asked
  // no pin: not even built (default closed), nothing asked
  { const r = runner(PIN); assert.throws(() => M.createLocalPlayMarch({ cfg, rpc: r.rpc, trial: true }), /pinned runner instance is required/); assert.deepEqual(r.calls, []); }
  // the runner states another instance, or none: unavailable
  for (const stated of ['cd'.repeat(32), undefined]) { const r = runner(stated), f = M.createLocalPlayMarch({ cfg, rpc: r.rpc, runnerInstance: PIN, trial: true }); await assert.rejects(f.capability(body), e => e.code === 'LocalMarchRpcUnavailable', String(stated)); }
  // the pinned instance stated by the runner itself: the answer, closed in its form
  const r = runner(PIN), f = M.createLocalPlayMarch({ cfg, rpc: r.rpc, runnerInstance: PIN, trial: true });
  assert.deepEqual(await f.capability(body), { schema: M.LOCAL_MARCH_CAPABILITY_SCHEMA, wallet: WALLET, instance: PIN, commands: ['Depart'], reveal: 'keeper', trial: true });
  assert.deepEqual(r.calls.map(c => c[0]), ['getSignatureStatuses'], 'one read, no send');
  assert.deepEqual(r.calls[0][1], [[]]);
  for (const bad of [{}, { schema: M.LOCAL_MARCH_CAPABILITY_SCHEMA, extra: 1 }, { schema: 'frontier-local-play-act-instance-v1' }]) await assert.rejects(f.capability(bad), e => e.code === 'LocalMarchInvalid');
  assert.equal(f.stats().history, 0);
  f.close(); await assert.rejects(f.capability(body), e => e.code === 'LocalMarchClosed');
  // the test-only trial: only a boolean; with it the same instance-verified answer says trial
  assert.throws(() => M.createLocalPlayMarch({ cfg, rpc: r.rpc, runnerInstance: PIN, trial: 'yes' }), /trial must be a boolean/);
  // DEFAULT CLOSED: without the test-only trial the march is not built at all (no listener can serve it)
  for (const o of [{ runnerInstance: PIN }, { runnerInstance: PIN, trial: false }, {}]) assert.throws(() => M.createLocalPlayMarch({ cfg, rpc: r.rpc, ...o }), /refused/, JSON.stringify(o));
});

test('the relay command line: --march-trial in exactly its word, only with --economy; handed on only when given', async () => {
  const { parseArgs, marchFromArgs, MARCH_TRIAL_MODE } = await import('../src/frontier/local-play-relay-server.mjs');
  const base = ['--local-play', '--listen-port', '41966', '--rpc', 'http://127.0.0.1:41964', '--program', LOCAL_PLAY_PROGRAM, '--season', A.season, '--wallet', WALLET,
    '--ruleset-hash', RULESET_HASH_V3_HEX, '--prepare-bin', '/abs/prepare', '--cu-limit', '1000000', '--loaded-limit', '67108864'];
  assert.equal(MARCH_TRIAL_MODE, 'local-march-trial-v1');
  const on = parseArgs([...base, '--economy', 'page-signed-v1', '--march-trial', MARCH_TRIAL_MODE]), plain = parseArgs([...base, '--economy', 'page-signed-v1']);
  assert.equal(on.marchTrial, true); assert.equal(plain.marchTrial, false); assert.deepEqual(on.cfg, plain.cfg); assert.ok(!Object.hasOwn(on.cfg, 'marchTrial'));
  assert.throws(() => parseArgs([...base, '--march-trial', MARCH_TRIAL_MODE]), /needs --economy/);
  for (const v of ['true', 'local-march-trial', '1']) assert.throws(() => parseArgs([...base, '--economy', 'page-signed-v1', '--march-trial', v]), /--march-trial must be/, v);
  const made = [], create = a => { made.push(a); return 'M'; };
  marchFromArgs({ cfg: on.cfg, economy: true, runnerInstance: 'ab'.repeat(32), marchTrial: true }, { create });
  assert.equal(marchFromArgs({ cfg: on.cfg, economy: true, runnerInstance: 'ab'.repeat(32), marchTrial: 'yes' }, { create }), null);
  assert.equal(marchFromArgs({ cfg: on.cfg, economy: false, marchTrial: true }, { create }), null);
  assert.deepEqual(made, [{ cfg: on.cfg, runnerInstance: 'ab'.repeat(32), trial: true }]);
});

test('the launcher: --march-trial in exactly its word, natural worlds only; it reaches the relay and the page address only when given', async () => {
  const L = await import('../src/frontier/local-play-launcher.mjs');
  assert.equal(L.MARCH_TRIAL_MODE, 'local-march-trial-v1');
  const abs = ['--root', '/r', '--data', '/d', '--runner', '/x/runner', '--herald', '/x/herald', '--depart', '/x/depart', '--preview', '/x/preview', '--resident', '/x/resident', '--artifact', '/x/a.so', '--artifact-sha', 'ab'.repeat(32)];
  const natural = [...abs, '--world-preset', 'local-natural-v1', '--natural-runner', '/x/natural', '--economy', 'page-signed-v1'];
  const fault = async (args, code) => assert.rejects(L.parseConfig(args), e => e.code === code, code);
  await fault([...natural, '--march-trial', 'yes'], 'InvalidMarchTrial');
  await fault([...natural, '--march-trial', 'local-march-trial'], 'InvalidMarchTrial');
  await fault([...abs, '--economy', 'page-signed-v1', '--march-trial', L.MARCH_TRIAL_MODE], 'MarchTrialNeedsNatural');
  // (a well-formed natural trial passes these checks and fails only later, at the paths, which do not exist here)
  await assert.rejects(L.parseConfig([...natural, '--march-trial', L.MARCH_TRIAL_MODE]), e => !['InvalidMarchTrial', 'MarchTrialNeedsNatural', 'InvalidArguments'].includes(e.code));
  const src = readFileSync(new URL('../src/frontier/local-play-launcher.mjs', import.meta.url), 'utf8');
  assert.match(src, /const trialArgs = marchTrial \? \['--march-trial', MARCH_TRIAL_MODE\] : \[\];/);
  assert.match(src, /\.\.\.economyArgs, \.\.\.trialArgs, '--cu-limit'/);
  assert.match(src, /march = c\.marchTrial === true \? 'trial' : ''/);
  assert.match(src, /if \(c\.marchTrial !== undefined && \(!marchTrial \|\| !natural\)\) throw fault\('InvalidWorldPreset', 503\);/);
});
