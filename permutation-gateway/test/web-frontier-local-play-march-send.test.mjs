// The page's local Depart (flocalplay-march.mjs `createLocalMarchSender`): the relay's own bytes, ONE POST, a
// memory-only book, an unknown outcome held and only asked about. THIS FILE MAKES NO KEY:
//   node --import ./screens/codex/no-key-node.mjs --test ./test/web-frontier-local-play-march-send.test.mjs
// The signing step is a stub that returns a wire with 64 zero bytes (no key exists); the relay is a stub POST.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as P from '../../permutation-server/web/frontier/flocalplay-march.mjs';
import * as R from '../src/frontier/local-play-march.mjs';
import { LOCAL_PLAY_SEASON_ID, LOCAL_PLAY_RULESET_HASH } from '../src/frontier/local-play-relay.mjs';
import { seasonAddresses, hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { LOCAL_PLAY_PROGRAM } from '../../permutation-server/web/frontier/flocalplay.mjs';
import { wireTransaction } from '../../permutation-server/web/sdk/solana-tx.mjs';

const WALLET = 'BbPGAbHDvV5U43zQ5E8FmSnEzZ7r2vwWAZWTNAPTTSUT', BLOCKHASH = '7pshbHEvHUftsEcrGUPb9FoVXWmV1gEs1R1cZCGXjSCt', RELAY = 'http://localhost:41926';
const A = seasonAddresses(LOCAL_PLAY_PROGRAM, String(LOCAL_PLAY_SEASON_ID));
const IDENTITY = Object.freeze({ address: WALLET, programId: LOCAL_PLAY_PROGRAM, seasonAddress: A.season, cluster: 'localnet' });
const HOLDING = { p: 2, q: 0, site: 11 }, PROVINCE = { p: 2, q: 0 };
const HOST = hostId({ p: 2, q: 0, site: 11, gen: 2, seq: 0 });
const SEAL = Uint8Array.from([0x80, ...new Array(164).fill(0xab)]), COMMIT = new Uint8Array(32).fill(0xcd);
const FIELDS = Object.freeze({ host_id: HOST, commit: COMMIT, seal: SEAL, arrive_bell: 12, tip: 1000n, transit_slot: 0 });
const SIG = '5'.repeat(87);

function harness({ answers = {}, open = true, gate = { ok: true, relay: RELAY } } = {}) {
  const posts = [], signed = [];
  const post = async (origin, path, body) => {
    posts.push({ origin, path, body });
    const a = answers[path];
    const v = typeof a === 'function' ? a(body) : a;
    if (v instanceof Error) throw v;
    return v;
  };
  const sign = async (w, wallet, message) => { signed.push(message); return { wire: wireTransaction(message, [new Uint8Array(64)]), signature: SIG }; };
  const signer = { destroyed: false, address: WALLET };
  const sender = P.createLocalMarchSender({ allowed: () => gate, open: () => open, identity: () => IDENTITY, rulesetHash: () => LOCAL_PLAY_RULESET_HASH, signer: () => signer,
    post, sign, wait: async () => {}, tries: 3, every: 0 });
  return { sender, posts, signed, deps: sender.depsFor({ holding: HOLDING, province: PROVINCE }) };
}
const CONTEXT = { wallet: WALLET, blockhash: { hash: BLOCKHASH, last_valid_block_height: '300', context_slot: '90' } };
const binding = () => P.localMarchBinding(P.localMarchIntentOf(FIELDS, HOLDING, PROVINCE));
const SUBMITTED = () => ({ status: 'submitted', name: 'Depart', signature: SIG, ...binding(), status_route: 'POST /f/local-play/march/status' });
const refusal = (code, status) => Object.assign(new Error('refused'), { code, refused: true, status });
const submits = posts => posts.filter(p => p.path === P.LOCAL_MARCH_SUBMIT_PATH).length;

test('the page builds the relay\'s own bytes; the intent and the binding are the relay\'s', () => {
  const intent = P.localMarchIntentOf(FIELDS, HOLDING, PROVINCE);
  assert.deepEqual(R.localMarchIntent(JSON.parse(JSON.stringify(intent))), intent, 'the relay accepts the page\'s intent as it is');
  const pins = { program: LOCAL_PLAY_PROGRAM, season: A.season, seasonId: LOCAL_PLAY_SEASON_ID, wallet: WALLET, rulesetHash: LOCAL_PLAY_RULESET_HASH };
  assert.deepEqual(Buffer.from(P.localMarchMessageOf(intent, IDENTITY, LOCAL_PLAY_RULESET_HASH, BLOCKHASH)), Buffer.from(R.localMarchMessage(R.localMarchIntent(intent), pins, BLOCKHASH)));
  assert.deepEqual(P.localMarchBinding(intent), R.sealBinding(R.localMarchIntent(intent)));
  assert.deepEqual([...P.LOCAL_MARCH_PRESEND_REFUSALS], [...R.LOCAL_MARCH_PRESEND_REFUSALS], 'the page says "not sent" for exactly the relay\'s pre-send refusals');
  const bad = (f, h, pv, code) => assert.throws(() => P.localMarchIntentOf(f, h, pv), e => e.code === code, code);
  bad(FIELDS, { p: 200, q: 0, site: 1 }, PROVINCE, 'LocalMarchWideHolding');
  bad({ ...FIELDS, seal: SEAL.slice(1) }, HOLDING, PROVINCE, 'LocalMarchShape');
  bad({ ...FIELDS, host_id: 5 }, HOLDING, PROVINCE, 'LocalMarchShape');
  bad({ ...FIELDS, transit_slot: 4 }, HOLDING, PROVINCE, 'LocalMarchShape');
});

test('nothing is signed or posted while the march is closed, the gate is not ok, or the host is held', async () => {
  for (const [opts, code] of [[{ open: false }, 'LocalMarchClosed'], [{ gate: { ok: false, code: 'LocalDepartSigner' } }, 'LocalDepartSigner']]) {
    const h = harness({ ...opts, answers: { [P.LOCAL_MARCH_SUBMIT_PATH]: SUBMITTED() } });
    assert.deepEqual(await h.deps.submit({ name: 'Depart', fields: FIELDS }), { ok: false, code, error: code });
    assert.deepEqual([h.posts.length, h.signed.length], [0, 0]);
  }
  const h = harness();
  assert.equal((await h.deps.submit({ name: 'Join', fields: FIELDS })).code, 'LocalMarchNotAllowed');
  // a held march of this host: the book says `sent`, outcome unknown
  h.sender.storage.set(h.sender.bookKey, JSON.stringify([{ v: 1, host: String(HOST), transitSlot: 1, arriveBell: 9, state: 'sent', signature: 'held1', attempts: [] }]));
  assert.deepEqual(h.sender.held(HOST), ['held1']);
  assert.equal((await h.deps.submit({ name: 'Depart', fields: FIELDS })).code, 'LocalMarchHeld');
  assert.deepEqual([h.posts.length, h.signed.length], [0, 0]);
});

test('a send: context, sign, ONE submit; the answer must carry the program\'s binding', async () => {
  const h = harness({ answers: { [P.LOCAL_MARCH_SUBMIT_PATH]: SUBMITTED(), '/gw/f/local-play/act/context': CONTEXT } });
  assert.deepEqual(await h.deps.submit({ name: 'Depart', fields: FIELDS }), { ok: true, signature: SIG });
  assert.deepEqual(h.posts.map(p => p.path), ['/gw/f/local-play/act/context', P.LOCAL_MARCH_SUBMIT_PATH]);
  assert.ok(h.posts.every(p => p.origin === RELAY));
  const body = h.posts[1].body;
  assert.equal(body.schema, R.LOCAL_MARCH_SUBMIT_SCHEMA);
  assert.deepEqual(R.localMarchSubmit.length, 2);
  // the relay's parser takes the page's body as it is (its signature check is the only refusal left: zero bytes here)
  assert.throws(() => R.localMarchSubmit(body, { program: LOCAL_PLAY_PROGRAM, season: A.season, seasonId: LOCAL_PLAY_SEASON_ID, wallet: WALLET, rulesetHash: LOCAL_PLAY_RULESET_HASH }), e => e.code === 'LocalMarchSigner');
});

test('after the POST: only the relay\'s pre-send refusals say "not sent"; everything else is held by its signature', async () => {
  const at = async a => { const h = harness({ answers: { '/gw/f/local-play/act/context': CONTEXT, [P.LOCAL_MARCH_SUBMIT_PATH]: a } }); const r = await h.deps.submit({ name: 'Depart', fields: FIELDS }); assert.equal(submits(h.posts), 1); return r; };
  assert.deepEqual(await at(refusal('LocalMarchCitizen', 403)), { ok: false, code: 'LocalMarchCitizen', error: 'LocalMarchCitizen' });
  for (const [a, why] of [[refusal('LocalMarchSendRefused', 502), 'the runner refused the send'], [refusal('LocalMarchMessageUsed', 409), 'used bytes'],
    [Object.assign(new Error('x'), { code: 'LocalMarchNoAnswer' }), 'no answer'], [{ ...SUBMITTED(), seal_root: '00'.repeat(32) }, 'another binding'],
    [{ ...SUBMITTED(), signature: 'other' }, 'another signature'], [{ ...SUBMITTED(), status: 'unknown' }, 'the relay does not know']]) {
    const r = await at(a);
    assert.equal(r.ok, true, why); assert.equal(r.signature, SIG, why); assert.equal(r.outcome, 'unknown', why);
  }
});

test('track reads only; landed, failed with the program code, or unconfirmed (held); ask is one read', async () => {
  const status = v => ({ [P.LOCAL_MARCH_SUBMIT_PATH]: SUBMITTED(), '/gw/f/local-play/act/context': CONTEXT, [P.LOCAL_MARCH_STATUS_PATH]: v });
  let h = harness({ answers: status({ signature: SIG, status: 'confirmed', slot: 5 }) });
  await h.deps.submit({ name: 'Depart', fields: FIELDS });
  assert.deepEqual(await h.deps.track(SIG), { ok: true, slot: 5 });
  h = harness({ answers: status({ signature: SIG, status: 'failed', err: { InstructionError: [2, { Custom: 31 }] } }) });
  await h.deps.submit({ name: 'Depart', fields: FIELDS });
  assert.deepEqual(await h.deps.track(SIG), { ok: false, state: 'failed', code: 'TransactionFailed', programCode: 31 });
  h = harness({ answers: status({ signature: SIG, status: 'pending' }) });
  await h.deps.submit({ name: 'Depart', fields: FIELDS });
  assert.deepEqual(await h.deps.track(SIG), { ok: false, state: 'unconfirmed', code: 'Unconfirmed' });
  assert.equal(submits(h.posts), 1, 'never sent again');
  assert.equal(h.posts.filter(p => p.path === P.LOCAL_MARCH_STATUS_PATH).length, 3);
  // a signature this page did not send through a relay is not asked about
  assert.deepEqual(await h.deps.track('never'), { ok: false, state: 'unconfirmed', code: 'Unconfirmed' });
  // ask: the book entry is `sent` (as sendMarch leaves it after an unconfirmed track); one read; still held, then landed
  h.sender.storage.set(h.sender.bookKey, JSON.stringify([{ v: 1, host: String(HOST), transitSlot: 0, arriveBell: 12, state: 'sent', signature: SIG, attempts: [] }]));
  const before = h.posts.length;
  assert.equal(await h.sender.ask(SIG), 'unconfirmed'); assert.equal(h.posts.length, before + 1); assert.deepEqual(h.sender.held(HOST), [SIG]);
  const h2 = harness({ answers: status({ signature: SIG, status: 'finalized', slot: 9 }) });
  await h2.deps.submit({ name: 'Depart', fields: FIELDS });
  h2.sender.storage.set(h2.sender.bookKey, JSON.stringify([{ v: 1, host: String(HOST), transitSlot: 0, arriveBell: 12, state: 'sent', signature: SIG, attempts: [] }]));
  assert.equal(await h2.sender.ask(SIG), 'landed'); assert.deepEqual(h2.sender.held(HOST), []);
  assert.equal(await h2.sender.ask('never'), 'none');
  assert.equal(submits(h2.posts), 1);
});

test('the memory book: the marchbook\'s storage shape, and nothing reaches the browser', () => {
  const m = P.memoryStorage(); assert.equal(m.get('k'), null); assert.equal(m.set('k', 'v'), true); assert.equal(m.get('k'), 'v');
  const src = readFileSync(new URL('../../permutation-server/web/frontier/flocalplay-march.mjs', import.meta.url), 'utf8');
  assert.equal(src.split('LOCAL_MARCH_SUBMIT_PATH, {').length - 1, 1, 'one submit POST in the module');
});

test('the controller: local play sends the march only when FS.localMarch is open, ONCE (sendMarch), with the memory book; never the retrying path', () => {
  const src = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
  assert.match(src, /if \(localPlay && FS\.localMarch\?\.open !== true\) return failed\(localPlayReadOnly\(\)\);/);
  assert.match(src, /const r = localPlay \? await sendMarch\(m, \{/);
  const local = src.slice(src.indexOf('const r = localPlay ? await sendMarch(m, {'), src.indexOf(') : await sendMarchRetrying(m, {'));
  assert.ok(local.length > 0 && local.length < 800);
  for (const w of ['nudge', 'storage: book.browserStorage', 'bookKey()', 'session: FS.session', 'onRetry', 'refresh']) assert.ok(!local.includes(w), w);
  assert.match(local, /localMarchSenderNow\(\)\.depsFor\(/);
  assert.match(src, /Object\.defineProperty\(FS, 'localMarch', \{ configurable: true, enumerable: false, get: localMarchView \}\);/);
  assert.match(src, /'local-march-ask': \(d = \{\}\) => \(localPlay && localMarchSender && typeof d\.signature === 'string' \? localMarchSender\.ask\(d\.signature\)/);
  // the capability is read for the launcher's stated instance and kept only while the page is still that wallet
  assert.match(src, /readLocalMarchCapability\(\{ origin: cfg\.herald, wallet: asked, expectedInstance: localPlay\.march\.instance,/);
  assert.match(src, /if \(FS\.wallet\?\.address === asked\) \{ localMarchCapability = cap;/);
  // the readiness is never passed by the page (only the module's frozen default)
  const view = src.slice(src.indexOf('function localMarchView()'), src.indexOf('function localMarchView()') + 700);
  assert.ok(!/ready:/.test(view), 'the page never passes its own readiness');
});

test('the gate: march=trial and the start answer must agree; the statement needs the launcher\'s instance', async () => {
  const G = await import('../../permutation-server/web/frontier/flocalplay.mjs');
  const loc = q => ({ href: `http://localhost:41920/frontier/frontier/index.html?localPlay=1&launcher=1&devWallet=off&world=natural${q}` });
  const cfg = { localPlay: true };
  const I = 'ab'.repeat(32);
  assert.deepEqual({ ...G.launcherMarchStatement({ expiry: { instance: I }, marchTrial: true }, { launcher: true, trialPage: true }) }, { instance: I, trialEntry: true });
  assert.deepEqual({ ...G.launcherMarchStatement({ expiry: { instance: I }, marchTrial: true }, { launcher: true, trialPage: false }) }, { instance: I, trialEntry: false });
  assert.deepEqual({ ...G.launcherMarchStatement({ expiry: { instance: I } }, { launcher: true, trialPage: true }) }, { instance: I, trialEntry: false });
  assert.deepEqual({ ...G.launcherMarchStatement({ expiry: {}, marchTrial: true }, { launcher: true, trialPage: true }) }, { instance: null, trialEntry: false });
  assert.deepEqual({ ...G.launcherMarchStatement({ expiry: { instance: I }, marchTrial: true }, { launcher: false, trialPage: true }) }, { instance: null, trialEntry: false });
  const src = readFileSync(new URL('../../permutation-server/web/frontier/flocalplay.mjs', import.meta.url), 'utf8');
  assert.match(src, /if \(\(body\?\.marchTrial === true\) !== marchTrial\) return \{ ok: false, code: 'LauncherWorldMismatch' \};/);
  void loc; void cfg;
});

test('the controller: a local march with a signature is recorded as SENT (unconfirmed, or failed on chain), never as "not sent"', () => {
  const src = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
  const from = src.indexOf('async function sendTheMarch()'), body = src.slice(from, src.indexOf('\n}\n', from));
  assert.match(body, /const localSent = localPlay && !r\.ok && typeof r\.signature === 'string' && r\.signature !== '';/);
  assert.match(body, /if \(localSent && r\.code !== 'TransactionFailed'\) orderUnconfirmed\(marchOrder, r\.signature\);/);
  assert.match(body, /localSent \? \{ code: r\.code \?\? null, sent: true, signature: r\.signature \} : \{ code: r\.code \?\? null, sent: false \}/);
  assert.match(body, /if \(localSent && r\.code !== 'TransactionFailed'\) setNotice\(\{ busy: false, text: localActUnconfirmedText\(r\.signature\) \}\); else failed\(r\);/);
  // "sent: false" appears exactly once in the function, and only on the branch without a local signature
  assert.equal(body.split('sent: false').length - 1, 1);
  assert.ok(body.indexOf('sent: false') > body.indexOf('localSent ?'), 'the not-sent record is the last alternative, after the local signature branch');
  // the hold itself stays: the march's refusal while held is FS.localMarch (LocalMarchHeld), and the sender refuses a held host before any POST
  assert.match(src, /held: localMarchSender \? localMarchSender\.held\(FS\.compose\?\.host\?\.id \?\? null\) : \[\]/);
});

test('the order record by outcome (the controller\'s branch, replayed): signature + Unconfirmed → unconfirmed; signature + TransactionFailed → refused but sent; no signature → not sent', () => {
  const recordOf = (localPlay, r) => {
    const localSent = localPlay && !r.ok && typeof r.signature === 'string' && r.signature !== '';
    if (localSent && r.code !== 'TransactionFailed') return { state: 'unconfirmed', sent: true, signature: r.signature };
    return { state: r.ok ? 'accepted' : 'refused', ...(r.ok ? {} : localSent ? { code: r.code, sent: true, signature: r.signature } : { code: r.code, sent: false }) };
  };
  assert.deepEqual(recordOf(true, { ok: false, step: 'onChain', code: 'Unconfirmed', signature: 'S' }), { state: 'unconfirmed', sent: true, signature: 'S' });
  assert.deepEqual(recordOf(true, { ok: false, step: 'onChain', code: 'TransactionFailed', signature: 'S' }), { state: 'refused', code: 'TransactionFailed', sent: true, signature: 'S' });
  assert.deepEqual(recordOf(true, { ok: false, step: 'sent', code: 'LocalMarchCitizen' }), { state: 'refused', code: 'LocalMarchCitizen', sent: false });
  assert.deepEqual(recordOf(false, { ok: false, code: 'Unconfirmed', signature: 'S' }), { state: 'refused', code: 'Unconfirmed', sent: false }, 'the chain page is as it was');
  // the replay is the controller's own text
  const src = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes(recordOf.toString().split('\n')[1].trim()));
});

test('the controller: in local play the arrival offers no page SettleTransit (the keeper settles); elsewhere unchanged', () => {
  const src = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
  const lines = src.split('\n').filter(l => /const settleReady = /.test(l));
  assert.equal(lines.length, 1, 'one place decides settleReady');
  assert.match(lines[0], /^\s*const settleReady = !localPlay && !!transit && !!env && transit\.state >= 2 && pl\.state === 'resolved' && pl\.close !== null && now\(\) >= pl\.close \+ 600;$/);
  // (the card with no entry of this device never offers it either; and a settle asked anyway is still refused by act)
  assert.match(src, /facts: \{ nowBell: b, pipeline: null, slotPresent: false, settleReady: false \}/);
  assert.match(src, /if \(localPlay && !local\) return early\(localPlayReadOnly\(\)\);/);
  // (the keeper's self-reveal rule beside it is unchanged: no reveal request in local play)
  assert.match(src, /if \(step\.action === 'send' && !localPlay\) \{/);
});
