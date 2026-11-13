// The FRESH ECONOMY test entry (screens/codex/live-connect-fresh-economy.mjs) and its page's steps, joined in this
// process to the EXISTING economy relay's real flow (src/frontier/local-play-act.mjs) over a stand-in runner RPC.
// A KEY-USING test (scripts/ci/node-key-tests.txt): the wallet is the game's own memory-only test wallet, made here
// and never printed or stored — ONE wallet for the whole file (the page has one key; see the Join/Home test).
// Nothing is started: no runner, no world, no listener, no browser, no network. The announcements are written here
// in the shapes the contract fixes (CLAUDE-FRESH-ECONOMY-ENTRY-CONTRACT-20261112.md); they are NOT a runner's output,
// and nothing in this file is evidence of a Build, Train, Muster or Harvest on any chain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEconomyEntry, eConfigProblems, eStepProblem, eSendProblem, eCurrent, parseArgs, readWebFile, E_STATE_SCHEMA, E_STEPS, E_COMMANDS, E_PAGE_FILES, E_STEP_MAX_BYTES, E_ARTIFACT_SHA256 } from '../screens/codex/live-connect-fresh-economy.mjs';
import { E_PAGE, E_PAGE_SCRIPT_PATH } from '../screens/codex/live-connect-fresh-economy-page.mjs';
import { createEconomyRun, orderOf, nationsOf, sitesOf, villageOf, announced, E_ORDER, E_EXPIRY_MARGIN } from '../screens/codex/live-connect-fresh-economy-steps.mjs';
import { sendText, statusText, sendingText, nowText, reportText, controls, E_IDS } from '../screens/codex/live-connect-fresh-economy-page-script.mjs';
import { createLocalPlayAct } from '../src/frontier/local-play-act.mjs';
import { actFromArgs } from '../src/frontier/local-play-relay-server.mjs';
import { LOCAL_PLAY_PROGRAM, LOCAL_PLAY_RULESET_HASH, LOCAL_PLAY_SEASON_ID } from '../src/frontier/local-play-relay.mjs';
import { CONQUEST_ARTIFACT_CURRENT } from '../src/frontier/conquest-table-read.mjs';
import { createEphemeralWallet } from '../../permutation-server/web/frontier/fephemeral-wallet.mjs';
import { LOCAL_ACT_CONTEXT_PATH, LOCAL_ACT_SUBMIT_PATH, LOCAL_ACT_STATUS_PATH, LOCAL_ACT_SUBMIT_SCHEMA } from '../../permutation-server/web/frontier/flocalplay-act.mjs';
import { seasonAddresses, seasonPda } from '../../permutation-server/web/frontier/faddr.mjs';
import { decode, encode } from '../../permutation-server/web/sdk/base58.mjs';

const W = await createEphemeralWallet({ cluster: 'localnet', hostname: '127.0.0.1', localPlay: true });
const PORT = 47600, ORIGIN = `http://127.0.0.1:${PORT}`, HOST = `127.0.0.1:${PORT}`, INSTANCE = 'ce'.repeat(32), HASH = encode(new Uint8Array(32).fill(7));
const SEASON = seasonPda(LOCAL_PLAY_PROGRAM, 11)[0], A = seasonAddresses(LOCAL_PLAY_PROGRAM, '11'), CITIZEN_AT = A.of('Citizen', { wallet: W.address });
const HOME = { p: 2, q: 0, site: 4 }, VILLAGE = { p: '2', q: '0', site: 4 }, HOLDING_AT = A.of('Holding', HOME);
const line1 = (over = {}) => ({ schema: 'frontier-localnet-expedition-play-v1', runner_instance: INSTANCE, rpc_url: 'http://127.0.0.1:47001', program: LOCAL_PLAY_PROGRAM, season: SEASON,
  season_id: LOCAL_PLAY_SEASON_ID, player_wallet: W.address, artifact: { sha256: E_ARTIFACT_SHA256 },
  test_capability: { purpose: 'fresh-economy', synthetic: true, memory_only: true, outside_network: false, operator_keys: { upgrade_authority: 'x', payer: 'y' }, player_airdrop_lamports: 10000000000,
    clock: 'paused; …', round_fixture_sha256: 'ab'.repeat(32), genesis_round: 30943232, t_create_min: 1785632400, evidence_for: ['intro Build …'] }, ...over });
const MAX_EXPIRY = String(1785633660 + 30 * 86400);
const STEPS = {
  'season-created': { e_step: 'season-created', ruleset_hash: LOCAL_PLAY_RULESET_HASH }, genesis: { e_step: 'genesis', genesis_ts: 1785633660 },
  'prereq-ready-for-join': { e_step: 'prereq-ready-for-join', home_provinces: [{ p: '2', q: '0', nation: 2 }, { p: '-2', q: '1', nation: 4 }], join_shard: 5, max_session_expiry: MAX_EXPIRY },
  'prereq-join-landed': { e_step: 'prereq-join-landed', signature: 'sig', faction: 2, shard: 5 },
  'prereq-ready-for-place-home': { e_step: 'prereq-ready-for-place-home', faction: 2, shard: 5, candidates: [{ p: '2', q: '0', site: 0 }, { p: '2', q: '0', site: 4 }] },
  'prereq-place-home-landed': { e_step: 'prereq-place-home-landed', signature: 'sig', ...VILLAGE },
  'ready-for-build': { e_step: 'ready-for-build', village: VILLAGE, items: [0, 1, 2, 3, 4, 5], intro_secs: 60 },
  'build-landed': { e_step: 'build-landed', signature: 'sig', item: 3, done_at: 1785633800 },
  'ready-for-train': { e_step: 'ready-for-train', village: VILLAGE, units: [0, 1, 2, 6], min_n: 100, max_n: 100 },
  'train-landed': { e_step: 'train-landed', signature: 'sig', unit: 6, n: 100, reserve: 100, build_complete: false },
  'ready-for-muster': { e_step: 'ready-for-muster', village: VILLAGE, unit: 6, min_troops: 100, max_troops: 100, tiles: [0, 7, 30, 60], note: 'acceptance only: …' },
  'muster-accepted': { e_step: 'muster-accepted', signature: 'sig', host_id: 'h', troops: 100, tile: 30, entry_state: 2, build_complete: false },
  'ready-for-harvest': { e_step: 'ready-for-harvest', village: VILLAGE, after_done_at: 1785633800 },
  'harvest-landed': { e_step: 'harvest-landed', signature: 'sig', build_complete: true, completed_by: 'Harvest', item: 3, done_at: 1785633800 },
  'page-actions-closed': { e_step: 'page-actions-closed', reason: 'no block is produced from here; a transaction sent now does not land', window_until_secs: 200, elapsed_secs: 140 },
  stopped: { e_step: 'stopped' },
};
// the player's choices of a whole run, within the announcements above
const CHOICE = { Join: { faction: 2 }, PlaceHome: { ...HOME }, Build: { item: 3 }, Train: { unit: 6 }, Muster: { troops: 100, tile: 30 }, Harvest: {} };
function citizenBytes() { const b = new Uint8Array(384), v = new DataView(b.buffer); b.set(Buffer.from('PSF1CITZ'), 0); v.setBigUint64(8, 11n, true); v.setUint16(16, 2, true); b.set(decode(W.address), 64); b.set(decode(CITIZEN_AT).subarray(0, 8), 208); return b; }
function holdingBytes() { const b = new Uint8Array(1280), v = new DataView(b.buffer); b.set(Buffer.from('PSF1HOLD'), 0); v.setBigUint64(8, 11n, true); v.setInt16(64, HOME.p, true); v.setInt16(66, HOME.q, true); b[68] = HOME.site; b.set(decode(CITIZEN_AT), 72); return b; }
const row = bytes => (bytes === null ? null : { owner: LOCAL_PLAY_PROGRAM, executable: false, lamports: 1, data: [Buffer.from(bytes).toString('base64'), 'base64'] });
const none = () => Object.fromEntries(E_ORDER.map(([n]) => [n, { send: false, status: false }])), notSent = () => Object.fromEntries(E_ORDER.map(([n]) => [n, null]));

/** An entry with fake clocks, over the relay's REAL flow and a stand-in runner RPC; a page (`run`) that posts to it. */
function world({ maxMs = 225000, instance = INSTANCE } = {}) {
  const t = { wall: 1_800_000_000_000, mono: 5000 }, emitted = [], rpc = [], w = { joined: false, placed: false, sent: [], hold: null };
  const standIn = async (method, params) => {
    rpc.push(method);
    if (method === 'getLatestBlockhash') return { result: { context: { slot: 90 }, value: { blockhash: HASH, lastValidBlockHeight: 300 } } };
    if (method === 'getMultipleAccounts') { if (w.hold) await w.hold; return { result: { context: { slot: 91 }, value: params[0].map(a => (a === CITIZEN_AT ? (w.joined ? row(citizenBytes()) : null) : a === HOLDING_AT ? (w.placed ? row(holdingBytes()) : null) : null)) } }; }
    if (method === 'sendTransaction') { const sig = encode(Buffer.from(params[0], 'base64').subarray(1, 65)); w.sent.push(sig); return { result: sig }; }
    if (method === 'getSignatureStatuses') return { result: { context: { slot: 95, instance }, value: [w.sent.includes(params[0][0]) ? { slot: 93, confirmationStatus: 'confirmed', err: null } : null] } };
    return { error: { code: -1 } };
  };
  let made = null;
  const entry = createEconomyEntry({ pagePort: PORT, maxMs, now: () => t.wall, mono: () => t.mono, page: E_PAGE, emit: v => emitted.push(v),
    make: { act: o => { made = o; return createLocalPlayAct({ ...o, rpc: standIn }); } } });
  const req = (method, path, body, over = {}) => entry.handle({ method, path, host: HOST, origin: method === 'POST' ? ORIGIN : undefined, type: method === 'POST' ? 'application/json' : undefined, body, ...over });
  const get = async path => { const r = await req('GET', path); return { status: r.status, v: r.type === 'application/json' ? JSON.parse(r.body) : r.body }; };
  const postRaw = async (path, body, over) => { const r = await req('POST', path, body === undefined ? undefined : JSON.parse(JSON.stringify(body)), over); return { status: r.status, v: JSON.parse(r.body) }; };
  const post = async (origin, path, body) => { assert.equal(origin, ORIGIN); const r = await postRaw(path, body); if (r.status !== 200) throw Object.assign(new Error('refused'), { code: r.v.code, refused: true, status: r.status }); return r.v; };
  let state = null;
  const refresh = async () => { state = (await get('/e/state')).v; return state; };
  const run = createEconomyRun({ state: () => state, signer: () => W, origin: ORIGIN, post });
  // an announcement; a `…-landed` of Join / PlaceHome also makes the stand-in chain show the account
  const step = async name => { if (name === 'prereq-join-landed') w.joined = true; if (name === 'prereq-place-home-landed') w.placed = true; entry.step(structuredClone(STEPS[name])); await refresh(); };
  const upTo = async name => { for (const n of E_STEPS.slice(0, E_STEPS.indexOf(name) + 1)) await step(n); };
  const begin = async () => { assert.equal((await postRaw('/e/wallet', { public_key: W.address })).status, 200); entry.configure({ runner: line1() }); await refresh(); };
  return { t, emitted, rpc, w, entry, get, postRaw, post, run, step, upTo, begin, refresh, state: () => state, made: () => made, sends: () => rpc.filter(m => m === 'sendTransaction').length };
}
const submitBody = (name, subject, fields) => ({ schema: LOCAL_ACT_SUBMIT_SCHEMA, name, subject, fields, transaction_b64: 'AAAA' });
const BODIES = {
  Join: submitBody('Join', { faction: 2 }, { faction: 2, session: W.address, session_expiry: MAX_EXPIRY }), PlaceHome: submitBody('PlaceHome', { holding: HOME, faction: 2 }, { ...HOME }),
  Build: submitBody('Build', { holding: HOME }, { item: 3 }), Train: submitBody('Train', { holding: HOME }, { unit: 6, n: 100 }),
  Muster: submitBody('Muster', { holding: HOME }, { unit: 6, troops: 100, tile: 30 }), Harvest: submitBody('Harvest', { holding: HOME }, {}),
};

test('the configuring line: exactly {runner}, purpose "fresh-economy" — the Join/Home runner\'s line is refused here, and this runner\'s line is refused by the Join/Home entry', () => {
  const ok = { wallet: W.address, pagePort: PORT };
  assert.deepEqual(eConfigProblems({ runner: line1() }, ok), []);
  const bad = (line, about) => { const p = eConfigProblems(line, ok); assert.ok(p.length > 0 && p.some(x => about.test(x)), `${about}: ${JSON.stringify(p)}`); };
  const tc = line1().test_capability;
  for (const t of [undefined, null, { ...tc, purpose: 'fresh-start' }, { ...tc, purpose: 'a-page-signed-path' }, { ...tc, synthetic: false }, { ...tc, memory_only: false }, { ...tc, outside_network: true }]) bad({ runner: line1({ test_capability: t }) }, /test_capability/);
  bad({ runner: line1(), clis: {} }, /exactly runner/); bad({}, /exactly runner/); bad({ runner: null }, /line 1/);
  bad({ runner: line1({ program: W.address }) }, /program/); bad({ runner: line1({ season_id: '11' }) }, /season/); bad({ runner: line1({ artifact: { sha256: 'ab'.repeat(32) } }) }, /artifact/);
  for (const rpc_url of ['http://127.0.0.1:41964', 'http://127.0.0.1:47100', `http://127.0.0.1:${PORT}`, 'http://localhost:47001', 'https://127.0.0.1:47001', undefined]) bad({ runner: line1({ rpc_url }) }, /rpc_url/);
  bad({ runner: line1({ player_wallet: LOCAL_PLAY_PROGRAM }) }, /player_wallet/); bad({ runner: line1({ runner_instance: '00'.repeat(32) }) }, /runner_instance/);
  // THE TWO FRESH TESTS DO NOT TAKE EACH OTHER'S RUNNER
  // (that the Join/Home entry in turn refuses THIS runner's line is shown where both entries exist:
  //  frontier-live-connect-fresh-separation.test.mjs — this file imports nothing of that entry)
});

test('THE WHOLE PATH on stand-ins: the six commands, one send each, in the runner\'s order — each only when announced; page-actions-closed closes sending and is acknowledged; reads go on; stopped', async () => {
  const h = world();
  assert.throws(() => h.entry.configure({ runner: line1() }), { code: 'NoWalletYet' });
  await h.begin();
  assert.deepEqual(h.emitted, [{ e_wallet: W.address }, { e_entry: 'ready', synthetic: true, remaining_ms: 225000 }]);
  assert.deepEqual([h.made().cfg.wallet, h.made().cfg.rpc, h.made().runnerInstance], [W.address, 'http://127.0.0.1:47001', INSTANCE]); assert.equal(typeof h.made().test.sendGuard, 'function');
  let s = h.state();
  assert.deepEqual([s.schema, s.phase, s.synthetic, s.wallet, s.send, s.world, s.current, s.ruleset], [E_STATE_SCHEMA, 'ready', true, W.address, 'open', 'running', null, 'not-yet-announced']);
  assert.deepEqual(s.used, { Join: false, PlaceHome: false, Build: false, Train: false, Muster: false, Harvest: false }); assert.match(s.note, /prerequisites/); assert.match(s.note, /synthetic/i);
  await h.upTo('genesis');
  const sigs = [];
  for (const c of E_COMMANDS) {
    // before its announcement: the page has nothing to build it from; the entry's state names no current command
    assert.equal(h.state().current, null); await assert.rejects(h.run.send(c.name, CHOICE[c.name]), { code: 'EconomyNotAnnounced' });
    const before = h.sends();
    await h.step(c.ready);
    assert.equal(h.state().current, c.name);
    assert.deepEqual(controls(h.state(), { address: W.address, sent: h.run.sent(), stale: false })[c.name].send, true);
    const r = await h.run.send(c.name, CHOICE[c.name]);
    assert.equal(r.sent, true, `${c.name}: ${r.code}`); assert.equal(h.sends(), before + 1, `${c.name}: ONE send`); sigs.push(r.signature);
    assert.equal((await h.refresh()).used[c.name], true);
    // a second press: the same signature, nothing sent
    assert.deepEqual(await h.run.send(c.name, CHOICE[c.name]), { sent: true, signature: r.signature, again: true }); assert.equal(h.sends(), before + 1);
    assert.deepEqual(await h.run.status(c.name), { signature: r.signature, ok: true, state: 'landed', slot: 93 });
    await h.step(c.landed);
    assert.equal(h.state().current, null, `${c.name}: closed by its landed announcement`);
  }
  assert.equal(h.sends(), 6); assert.equal(new Set(sigs).size, 6); assert.deepEqual(h.w.sent, sigs);
  // each of the four went out for the announced village with the announced choice (the relay's intent, as posted)
  // PAGE ACTIONS CLOSED: acknowledged AFTER the announcement was taken; from then nothing is sent, reads go on
  assert.equal(h.emitted.some(e => e.e_entry === 'send-closed'), false);
  await h.step('page-actions-closed');
  assert.deepEqual(h.emitted.at(-1), { e_entry: 'send-closed' }); assert.deepEqual([h.state().send, h.state().current], ['closed', null]);
  const n = h.rpc.length, late = await h.postRaw(LOCAL_ACT_SUBMIT_PATH, BODIES.Harvest);
  assert.deepEqual([late.status, late.v.code], [503, 'LocalActClosed']); assert.equal(h.rpc.length, n);
  assert.equal((await h.run.status('Muster')).state, 'landed');
  await h.step('stopped');
  assert.deepEqual(h.emitted.filter(e => e.e_entry).map(e => e.e_entry), ['ready', 'send-closed', 'world-ended']); assert.equal(h.state().world, 'ended');
  assert.deepEqual(await h.run.status('Build'), { signature: sigs[2], ok: false, code: 'LocalActClosed' });
  assert.equal(h.sends(), 6);
});

test('ONLY THE ANNOUNCED COMMAND, ONLY NOW: every other one of the six is refused at each point of the run — before its announcement, after it landed, and once a later one was announced — without asking the relay or the runner', async () => {
  const h = world(); await h.begin(); await h.upTo('genesis');
  const refused = async (body, why) => { const n = h.rpc.length, r = await h.postRaw(LOCAL_ACT_SUBMIT_PATH, body); assert.deepEqual([r.status, r.v.code, r.v.detail], [403, 'LocalActNotAllowed', { fresh_economy: why }], `${body?.name}: ${why}`); assert.equal(h.rpc.length, n); };
  // nothing announced yet: none of the six
  for (const c of E_COMMANDS) await refused(BODIES[c.name], 'not-the-announced-command');
  for (const c of E_COMMANDS) {
    await h.step(c.ready);
    for (const other of E_COMMANDS.filter(x => x !== c)) await refused(BODIES[other.name], h.state().used[other.name] ? 'sent-already' : 'not-the-announced-command');
    assert.equal((await h.run.send(c.name, CHOICE[c.name])).sent, true);
    await refused(BODIES[c.name], 'sent-already');
    await h.step(c.landed);
    await refused(BODIES[c.name], 'sent-already');
  }
  // not one of the six at all
  for (const name of ['Depart', 'Reveal', 'DeclareSiege', 'Garrison', 'Dissolve', 'build', '', undefined]) await refused(submitBody(name, { holding: HOME }, {}), 'not-one-of-the-six');
  await refused(null, 'not-one-of-the-six');
  assert.equal(h.sends(), 6);
  // eCurrent: the LAST announced ready whose landed has not come — an earlier command is never current again
  const names = list => eCurrent(list.map(n => STEPS[n]))?.name ?? null;
  assert.equal(names([]), null); assert.equal(names(['prereq-ready-for-join']), 'Join'); assert.equal(names(['prereq-ready-for-join', 'prereq-join-landed']), null);
  assert.equal(names(['prereq-ready-for-join', 'ready-for-build']), 'Build', 'a later announcement closes the earlier command, whatever was skipped');
  assert.equal(names(['ready-for-build', 'ready-for-train', 'train-landed']), null); assert.equal(names(['ready-for-muster']), 'Muster');
});

test('WITHIN THE ANNOUNCEMENT ONLY: another village, an item / unit / number / tile / troops that was not announced, another nation or site, an expiry over the bound — each refused before the relay is asked', async () => {
  const h = world(); await h.begin(); await h.upTo('genesis');
  const refused = async (body, why) => { const n = h.rpc.length, r = await h.postRaw(LOCAL_ACT_SUBMIT_PATH, body); assert.deepEqual([r.status, r.v.code, r.v.detail], [403, 'LocalActNotAllowed', { fresh_economy: why }], `${body.name} ${JSON.stringify(body.fields)}: ${why}`); assert.equal(h.rpc.length, n); };
  const pass = async name => { assert.equal((await h.run.send(name, CHOICE[name])).sent, true, name); await h.step(E_COMMANDS.find(c => c.name === name).landed); };
  const elsewhere = [{ p: 2, q: 0, site: 5 }, { p: 3, q: 0, site: 4 }, { p: 2, q: 1, site: 4 }, { p: '2', q: '0', site: 4 }, null];
  await h.step('prereq-ready-for-join');
  await refused(submitBody('Join', { faction: 3 }, { faction: 3, session: W.address, session_expiry: MAX_EXPIRY }), 'not-an-announced-nation');
  for (const e of [String(BigInt(MAX_EXPIRY) + 1n), String(Math.floor(Date.now() / 1000) + 400 * 86400), 1785633660, undefined]) await refused(submitBody('Join', { faction: 2 }, { faction: 2, session: W.address, session_expiry: e }), 'expiry-over-the-announced-bound');
  await pass('Join'); await h.step('prereq-ready-for-place-home');
  await refused(submitBody('PlaceHome', { holding: { p: 2, q: 0, site: 5 }, faction: 2 }, { p: 2, q: 0, site: 5 }), 'not-an-announced-site');
  await refused(submitBody('PlaceHome', { holding: HOME, faction: 4 }, { ...HOME }), 'not-an-announced-site');
  await pass('PlaceHome'); await h.step('ready-for-build');
  for (const v of elsewhere) await refused(submitBody('Build', { holding: v }, { item: 3 }), 'not-the-announced-village');
  for (const item of [6, 7, 8, -1, '3', 3.5, undefined]) await refused(submitBody('Build', { holding: HOME }, { item }), 'not-an-announced-item');   // (walls, tier-up, the workshop: not intro items)
  await pass('Build'); await h.step('ready-for-train');
  for (const v of elsewhere) await refused(submitBody('Train', { holding: v }, { unit: 6, n: 100 }), 'not-the-announced-village');
  for (const f of [{ unit: 3, n: 100 }, { unit: 4, n: 100 }, { unit: 5, n: 100 }, { unit: 7, n: 100 }, { unit: 6, n: 99 }, { unit: 6, n: 101 }, { unit: 6, n: 1 }, { unit: 6, n: 1000 }, { unit: 6, n: '100' }, { unit: 6 }]) await refused(submitBody('Train', { holding: HOME }, f), 'not-the-announced-training');
  await pass('Train'); await h.step('ready-for-muster');
  for (const v of elsewhere) await refused(submitBody('Muster', { holding: v }, { unit: 6, troops: 100, tile: 30 }), 'not-the-announced-village');
  for (const f of [{ unit: 0, troops: 100, tile: 30 }, { unit: 6, troops: 99, tile: 30 }, { unit: 6, troops: 101, tile: 30 }, { unit: 6, troops: 100, tile: 31 }, { unit: 6, troops: 100, tile: 61 }, { unit: 6, troops: 100 }, { unit: 6, troops: '100', tile: 30 }])
    await refused(submitBody('Muster', { holding: HOME }, f), 'not-the-announced-muster');
  await pass('Muster'); await h.step('ready-for-harvest');
  for (const v of elsewhere) await refused(submitBody('Harvest', { holding: v }, {}), 'not-the-announced-village');
  await refused(submitBody('Harvest', { holding: HOME }, { amount: 1 }), 'not-as-announced'); await refused(submitBody('Harvest', { holding: HOME }, undefined), 'not-as-announced');
  await pass('Harvest');
  assert.equal(h.sends(), 6);
  // a pre-send refusal by the RELAY gives the command back: a Build whose bytes are not a transaction
  const g = world(); await g.begin(); await g.upTo('ready-for-build');
  const junk = await g.postRaw(LOCAL_ACT_SUBMIT_PATH, BODIES.Build); assert.ok(junk.status >= 400); assert.equal(g.sends(), 0); assert.equal((await g.refresh()).used.Build, false, `given back after ${junk.v.code}`);
});

test('THE PAGE\'S ORDERS come from the announcements only: the announced village, the announced n, the announced Muster unit, the bound for Join\'s expiry — anything else builds nothing', () => {
  const S = STEPS;
  assert.deepEqual(orderOf('Join', S['prereq-ready-for-join'], { faction: 4 }), { name: 'Join', v: { faction: 4 }, fields: { faction: 4, session_expiry: BigInt(MAX_EXPIRY) - E_EXPIRY_MARGIN } });
  assert.deepEqual(orderOf('PlaceHome', S['prereq-ready-for-place-home'], { ...HOME }), { name: 'PlaceHome', v: { holding: HOME, faction: 2 }, fields: HOME });
  assert.deepEqual(orderOf('Build', S['ready-for-build'], { item: 5 }), { name: 'Build', v: { holding: HOME, item: 5 }, fields: { item: 5 } });
  assert.deepEqual(orderOf('Train', S['ready-for-train'], { unit: 1 }), { name: 'Train', v: { holding: HOME }, fields: { unit: 1, n: 100 } });
  assert.deepEqual(orderOf('Train', S['ready-for-train'], { unit: 1, n: 5000 }).fields.n, 100, 'the page does not take an n from the player');
  assert.deepEqual(orderOf('Muster', S['ready-for-muster'], { troops: 100, tile: 60 }), { name: 'Muster', v: { holding: HOME }, fields: { unit: 6, troops: 100, tile: 60 } });
  assert.deepEqual(orderOf('Muster', S['ready-for-muster'], { unit: 0, troops: 100, tile: 0 }).fields.unit, 6, 'the Muster unit is the announced one');
  assert.deepEqual(orderOf('Harvest', S['ready-for-harvest']), { name: 'Harvest', v: { holding: HOME }, fields: undefined });
  const no = (name, ready, choice, code) => assert.throws(() => orderOf(name, ready, choice), { code }, `${name} ${JSON.stringify(choice)}`);
  for (const f of [0, 3, 6, '2', undefined]) no('Join', S['prereq-ready-for-join'], { faction: f }, 'EconomyNotAnnouncedChoice');
  no('PlaceHome', S['prereq-ready-for-place-home'], { p: 2, q: 0, site: 5 }, 'EconomyNotAnnouncedChoice');
  for (const item of [6, 7, 8, -1, '3', undefined]) no('Build', S['ready-for-build'], { item }, 'EconomyNotAnnouncedChoice');
  for (const unit of [3, 4, 5, 7, undefined]) no('Train', S['ready-for-train'], { unit }, 'EconomyNotAnnouncedChoice');
  no('Train', { ...S['ready-for-train'], max_n: 200 }, { unit: 0 }, 'EconomyBadAnnouncement');   // a range is not a choice this page offers
  for (const c of [{ troops: 99, tile: 30 }, { troops: 101, tile: 30 }, { troops: 100, tile: 31 }, { troops: 100.5, tile: 30 }, { troops: 100 }, {}]) no('Muster', S['ready-for-muster'], c, 'EconomyNotAnnouncedChoice');
  assert.deepEqual(orderOf('Muster', { ...S['ready-for-muster'], max_troops: 250 }, { troops: 250, tile: 7 }).fields, { unit: 6, troops: 250, tile: 7 });
  for (const name of ['Build', 'Train', 'Muster', 'Harvest']) { no(name, null, CHOICE[name], 'EconomyNotAnnounced'); no(name, { ...S[`ready-for-${name.toLowerCase()}`], village: { p: 2, q: 0, site: 4 } }, CHOICE[name], 'EconomyBadAnnouncement'); }
  no('Garrison', S['ready-for-harvest'], {}, 'EconomyNotOneOfTheSix');
  assert.deepEqual(nationsOf(S['prereq-ready-for-join']), [2, 4]); assert.deepEqual(sitesOf(S['prereq-ready-for-place-home']), [{ p: 2, q: 0, site: 0 }, HOME]); assert.deepEqual(villageOf(S['ready-for-build']), HOME);
  assert.equal(announced([S.genesis], 'ready-for-build'), null);
  // the two tables of the six — the entry's and the page's — are the same commands, in the same order, opened by the same announcements
  assert.deepEqual(E_ORDER.map(x => [...x]), E_COMMANDS.map(c => [c.name, c.ready])); assert.deepEqual(Object.keys(E_IDS), E_COMMANDS.map(c => c.name));
});

test('THE SEND LATCH inside the relay\'s awaits: page-actions-closed, stopped, the harness\'s runner-ended line, the run\'s end or close() arriving while a submit waits for the runner → nothing is sent', async () => {
  // (`page-actions-closed` and `stopped` come only in their place, after `harvest-landed`: the submit that can still be
  //  waiting then is a Harvest. The other three can come at any moment: shown during a Build.)
  for (const how of ['page-actions-closed', 'stopped', 'harness', 'lifetime', 'close']) {
    const closing = how === 'page-actions-closed' || how === 'stopped', name = closing ? 'Harvest' : 'Build';
    const h = world(); await h.begin(); await h.upTo(closing ? 'ready-for-harvest' : 'ready-for-build');
    assert.equal(h.sends(), 0, 'this world\'s earlier commands were announced as landed without a send (the stand-in chain shows their accounts)');
    let release; h.w.hold = new Promise(r => { release = r; });
    const pending = h.run.send(name, CHOICE[name]);
    while (!h.rpc.includes('getMultipleAccounts')) await new Promise(r => setImmediate(r));
    if (how === 'lifetime') h.t.mono += 225001; else if (how === 'close') h.entry.close(); else if (how === 'harness') h.entry.harness({ e_harness: 'runner-ended', rc: 101, stopped: false });
    else for (const n of E_STEPS.slice(E_STEPS.indexOf('harvest-landed'), E_STEPS.indexOf(how) + 1)) h.entry.step(structuredClone(STEPS[n]));
    release();
    const r = await pending;
    assert.equal(r.sent, false, how); assert.equal(h.sends(), 0, `${how}: nothing was sent`); assert.ok(['LocalActClosed', 'Closed'].includes(r.code), `${how}: ${r.code}`);
  }
  // one press at a time on the page: a second press (of any command) during the first one's awaits starts nothing
  const h = world(); await h.begin(); await h.upTo('ready-for-build');
  let release; h.w.hold = new Promise(r => { release = r; });
  const first = h.run.send('Build', CHOICE.Build);
  assert.deepEqual(await h.run.send('Build', CHOICE.Build), { sent: false, code: 'EconomyInFlight' }); assert.deepEqual(await h.run.send('Train', CHOICE.Train).catch(e => ({ code: e.code })), { sent: false, code: 'EconomyInFlight' });
  release(); assert.equal((await first).sent, true); assert.equal(h.sends(), 1);
  // another runner instance answering on the port: nothing is sent, the command is given back
  const x = world({ instance: 'ee'.repeat(32) }); await x.begin(); await x.upTo('ready-for-build');
  const r = await x.run.send('Build', CHOICE.Build); assert.deepEqual([r.sent, r.code], [false, 'LocalActRpcUnavailable']); assert.equal(x.sends(), 0); assert.equal((await x.refresh()).used.Build, false);
});

test('THE ANNOUNCEMENTS: only the sixteen `e_step` names, each once, in order, bounded, well-formed; every `village` is the site PlaceHome landed on; `f_step` lines of the Join/Home runner are not taken', async () => {
  const h = world();
  assert.throws(() => h.entry.step(structuredClone(STEPS.genesis)), { code: 'NotReady' });
  await h.begin();
  for (const v of [null, [], 'genesis', {}, { f_step: 'genesis' }, { a_step: 'genesis' }, { e_step: 'ready-for-join' }, { e_step: 'join-landed' }, { e_step: 'place-home-landed' }, { e_step: 'ready-for-depart' }, { e_step: 7 }]) assert.throws(() => h.entry.step(v), { code: 'BadStep' });
  assert.throws(() => h.entry.step({ e_step: 'genesis', pad: 'x'.repeat(E_STEP_MAX_BYTES) }), { code: 'BadStep' });
  for (const n of E_STEPS) assert.equal(eStepProblem(STEPS[n]), null, n);
  assert.equal(E_STEPS.length, 16); assert.deepEqual(Object.keys(STEPS), [...E_STEPS]);
  const bad = v => assert.notEqual(eStepProblem(v), null, JSON.stringify(v).slice(0, 90));
  const B = STEPS['ready-for-build'], T = STEPS['ready-for-train'], M = STEPS['ready-for-muster'];
  for (const v of [{ ...B, items: [] }, { ...B, items: [0, 6] }, { ...B, items: [0, 0] }, { ...B, items: '0' }, { ...B, intro_secs: 3600 }, { ...B, village: HOME }, { ...B, village: undefined }, { e_step: 'ready-for-build' }]) bad(v);
  for (const v of [{ ...T, units: [] }, { ...T, units: [7] }, { ...T, min_n: 0 }, { ...T, min_n: 200 }, { ...T, max_n: '100' }, { ...T, village: { p: '2', q: '0' } }]) bad(v);
  for (const v of [{ ...M, unit: 7 }, { ...M, unit: undefined }, { ...M, min_troops: 0 }, { ...M, max_troops: 99 }, { ...M, tiles: [] }, { ...M, tiles: [61] }, { ...M, tiles: [3, 3] }, { ...M, tiles: Array.from({ length: 62 }, (_, i) => i % 61) }]) bad(v);
  bad({ e_step: 'ready-for-harvest' }); bad({ e_step: 'prereq-place-home-landed', p: 2, q: 0, site: 4 }); bad({ ...STEPS['prereq-ready-for-place-home'], candidates: [] });
  assert.equal(eStepProblem({ ...M, tiles: Array.from({ length: 61 }, (_, i) => i) }), null, 'all 61 tiles');
  // order: never an earlier (or the same) name after a later one
  await h.upTo('prereq-place-home-landed');
  for (const n of ['genesis', 'prereq-ready-for-join', 'prereq-place-home-landed']) assert.throws(() => h.entry.step(structuredClone(STEPS[n])), { code: 'StepOutOfOrder' });
  // VILLAGE: any other site than the one PlaceHome landed on → the announcement is not taken
  for (const village of [{ p: '2', q: '0', site: 5 }, { p: '3', q: '0', site: 4 }, { p: '2', q: '-1', site: 4 }]) assert.throws(() => h.entry.step({ ...B, village }), { code: 'VillageMismatch' });
  assert.equal((await h.refresh()).current, null);
  await h.step('ready-for-build'); assert.equal(h.state().current, 'Build');
  // NONE SKIPPED: after `ready-for-build` only `build-landed` is taken — not a later announcement, however plausible
  for (const n of E_STEPS.slice(E_STEPS.indexOf('build-landed') + 1)) assert.throws(() => h.entry.step(structuredClone(STEPS[n])), { code: 'StepSkipped' }, n);
  assert.deepEqual((await h.refresh()).steps.map(x => x.e_step), E_STEPS.slice(0, E_STEPS.indexOf('ready-for-build') + 1)); assert.equal(h.state().current, 'Build');
  // an announcement is data: it changes no pin; the stored copy is not the caller's object
  assert.equal(h.state().identity.address, W.address); assert.throws(() => h.entry.configure({ runner: line1() }), { code: 'ConfiguredAlready' });
  const mine = structuredClone(STEPS['build-landed']); h.entry.step(mine); mine.e_step = 'x'; assert.equal((await h.refresh()).steps.at(-1).e_step, 'build-landed');
});

test('THE FIXED ORDER, FAIL-CLOSED: at every point of the run only the NEXT of the sixteen is taken — a jump ahead, a `ready-for-…` without the `…-landed` before it, a repeat and a step back are each refused, change nothing, and open no command', async () => {
  // the reviewed case: season-created → prereq-place-home-landed → ready-for-train must NOT open Train
  const r = world(); await r.begin(); await r.step('season-created');
  assert.throws(() => r.entry.step(structuredClone(STEPS['prereq-place-home-landed'])), { code: 'StepSkipped' });
  assert.throws(() => r.entry.step(structuredClone(STEPS['ready-for-train'])), { code: 'StepSkipped' });
  await r.refresh(); assert.deepEqual([r.state().steps.map(x => x.e_step), r.state().current], [['season-created'], null]);
  const train = await r.postRaw(LOCAL_ACT_SUBMIT_PATH, BODIES.Train); assert.deepEqual([train.status, train.v.detail], [403, { fresh_economy: 'not-the-announced-command' }]); assert.deepEqual(r.rpc, []);
  assert.deepEqual(controls(r.state(), { address: W.address, sent: notSent(), stale: false }), none());
  // at EVERY position: exactly one name is taken next; all fifteen others are refused — earlier ones as out of order, later ones as skipped
  const h = world(); await h.begin();
  for (let i = 0; i < E_STEPS.length; i++) {
    for (let j = 0; j < E_STEPS.length; j++) {
      if (j === i) continue;
      assert.throws(() => h.entry.step(structuredClone(STEPS[E_STEPS[j]])), { code: j < i ? 'StepOutOfOrder' : 'StepSkipped' }, `after ${E_STEPS[i - 1] ?? 'nothing'}: ${E_STEPS[j]}`);
    }
    const before = (await h.refresh()).steps.length; assert.equal(before, i, 'the refused lines changed nothing');
    await h.step(E_STEPS[i]);
    assert.equal(h.state().steps.length, i + 1);
  }
  assert.deepEqual(h.state().steps.map(x => x.e_step), [...E_STEPS]);
  // each `ready-for-…` therefore has the `…-landed` of the command before it: a command is never open while an earlier one has not landed
  for (let k = 1; k < E_COMMANDS.length; k++) assert.equal(E_STEPS.indexOf(E_COMMANDS[k].ready), E_STEPS.indexOf(E_COMMANDS[k - 1].landed) + 1, E_COMMANDS[k].name);
  for (const c of E_COMMANDS) assert.equal(E_STEPS.indexOf(c.landed), E_STEPS.indexOf(c.ready) + 1, c.name);
  // an early END is not a jump: `stopped` (or `page-actions-closed`) cannot be announced out of place; the harness's line is how a run ends early
  const e = world(); await e.begin(); await e.upTo('ready-for-muster');
  for (const n of ['page-actions-closed', 'stopped', 'harvest-landed', 'ready-for-harvest']) assert.throws(() => e.entry.step(structuredClone(STEPS[n])), { code: 'StepSkipped' }, n);
  assert.equal((await e.refresh()).send, 'open'); assert.equal(e.emitted.some(x => x.e_entry === 'send-closed'), false);
  assert.equal(e.entry.harness({ e_harness: 'runner-ended', rc: 101, stopped: false }), true); assert.equal((await e.refresh()).ended_during, 'Muster');
});

test('G1 — the ruleset hash: `season-created` must announce the relay\'s own before anything is sent; absent, another one, or skipped → nothing is sent in the run', async () => {
  const sc = STEPS['season-created'];
  for (const bad of [{ e_step: 'season-created' }, { ...sc, ruleset_hash: 'ab'.repeat(32) }, { ...sc, ruleset_hash: LOCAL_PLAY_RULESET_HASH.toUpperCase() }, { ...sc, ruleset_hash: null }]) {
    const h = world(); await h.begin();
    assert.throws(() => h.entry.step(structuredClone(bad)), { code: 'RulesetHashMismatch' });
    await h.refresh(); assert.deepEqual([h.state().ruleset, h.state().send, h.state().current], ['refused', 'closed', null]); assert.equal(h.emitted.some(e => e.e_entry === 'send-closed'), false);
    h.entry.step(structuredClone(sc)); await h.step('genesis'); await h.step('prereq-ready-for-join');
    assert.deepEqual(controls(h.state(), { address: W.address, sent: notSent(), stale: false }), none());
    const r = await h.run.send('Join', CHOICE.Join); assert.equal(r.sent, false);
    const direct = await h.postRaw(LOCAL_ACT_SUBMIT_PATH, BODIES.Join); assert.deepEqual([direct.status, direct.v.code], [503, 'LocalActClosed']); assert.deepEqual(h.rpc, []);
    assert.match(sendingText(h.state()), /ruleset is not the one this page builds for/);
  }
  // SKIPPED: nothing can be announced before `season-created` — so no command is ever opened on an unconfirmed ruleset
  const s = world(); await s.begin();
  for (const n of E_STEPS.slice(1)) assert.throws(() => s.entry.step(structuredClone(STEPS[n])), { code: 'StepSkipped' }, n);
  const direct = await s.postRaw(LOCAL_ACT_SUBMIT_PATH, BODIES.Join); assert.deepEqual([direct.status, direct.v.detail], [403, { fresh_economy: 'ruleset-not-confirmed' }]); assert.deepEqual(s.rpc, []);
  assert.deepEqual((await s.refresh()).steps, []);
  assert.equal(eSendProblem(BODIES.Build, { steps: [STEPS['prereq-place-home-landed'], STEPS['ready-for-build']], used: {} }), 'ruleset-not-confirmed');
});

test('G2 — the runner ended WITHOUT `stopped` (the harness\'s one `e_harness` line): taken once; sending and the relay close with no `send-closed`; the page is told during which command — prerequisite or not', async () => {
  const line = (over = {}) => ({ e_harness: 'runner-ended', rc: 101, stopped: false, ...over });
  // during each command (after its announcement, before its landing), and between commands
  const cases = [['genesis', null], ['prereq-ready-for-join', 'Join (prerequisite)'], ['prereq-ready-for-place-home', 'PlaceHome (prerequisite)'], ['prereq-place-home-landed', null],
    ['ready-for-build', 'Build'], ['ready-for-train', 'Train'], ['ready-for-muster', 'Muster'], ['muster-accepted', null], ['ready-for-harvest', 'Harvest'], ['page-actions-closed', null]];
  for (const [upTo, during] of cases) {
    const h = world(); await h.begin(); await h.upTo(upTo);
    assert.equal(h.entry.harness(line()), true);
    assert.deepEqual(h.emitted.at(-1), { e_entry: 'runner-ended-noted', rc: 101, during });
    await h.refresh(); assert.deepEqual([h.state().world, h.state().send, h.state().runner_rc, h.state().ended_during, h.state().current], ['ended-incomplete', 'closed', 101, during, null], upTo);
    assert.equal(h.emitted.filter(e => e.e_entry === 'send-closed').length, upTo === 'page-actions-closed' ? 1 : 0, 'send-closed answers page-actions-closed only');
    assert.match(sendingText(h.state()), during ? new RegExp(`^closed — the test world ended without completing, during: ${during.replace(/[()]/g, '\\$&')}; nothing is asked of any other node$`) : /^closed — the test world ended without completing; nothing/);
    assert.deepEqual(controls(h.state(), { address: W.address, sent: notSent(), stale: false }), none());
    const n = h.rpc.length;
    for (const c of E_COMMANDS) { const r = await h.postRaw(LOCAL_ACT_SUBMIT_PATH, BODIES[c.name]); assert.deepEqual([r.status, r.v.code], [503, 'LocalActClosed']); }
    assert.equal((await h.postRaw(LOCAL_ACT_CONTEXT_PATH, { schema: 'frontier-local-play-act-context-v1' })).v.code, 'LocalActClosed'); assert.equal(h.rpc.length, n);
    assert.throws(() => h.entry.step(structuredClone(STEPS.stopped)), { code: 'RunnerEnded' }); assert.throws(() => h.entry.harness(line({ rc: -1 })), { code: 'RunnerEndedAlready' });
  }
  const h = world(); await h.begin();
  for (const bad of [{ e_harness: 'runner-ended' }, line({ rc: '1' }), line({ rc: -2 }), line({ rc: 65536 }), line({ stopped: true }), line({ extra: 1 }), line({ e_harness: 'entry-ended' }),
    { f_harness: 'runner-ended', rc: 101, stopped: false }, null, []]) assert.throws(() => h.entry.harness(bad), { code: 'BadHarnessLine' });
  assert.equal((await h.refresh()).world, 'running');
  // before the configuring line; after `stopped`; after the run's end; never over HTTP
  const early = world(); assert.equal((await early.postRaw('/e/wallet', { public_key: W.address })).status, 200); early.entry.harness(line({ rc: -1 }));
  const st = (await early.get('/e/state')).v; assert.deepEqual([st.phase, st.world, st.runner_rc, st.ended_during], ['awaiting-runner', 'ended-incomplete', -1, null]); assert.throws(() => early.entry.configure({ runner: line1() }), { code: 'RunnerEnded' });
  const done = world(); await done.begin(); await done.upTo('stopped'); assert.throws(() => done.entry.harness(line({ rc: 0 })), { code: 'RunnerEndedAfterStopped' }); assert.equal((await done.refresh()).world, 'ended');
  const late = world({ maxMs: 5000 }); await late.begin(); late.t.mono += 5001; assert.throws(() => late.entry.harness(line()), { code: 'Closed' });
  for (const p of ['/e/harness', '/f/harness', '/gw/e/harness']) assert.equal((await h.postRaw(p, line())).status, 404, p);
});

test('ONE WALLET, ONE CONFIGURATION, ONE LIFETIME; the origin\'s bounds; only the three economy routes — none of the Join/Home entry\'s or Stage A\'s', async () => {
  const h = world({ maxMs: 5000 });
  for (const body of [{}, { public_key: 'x' }, { public_key: LOCAL_PLAY_PROGRAM }, null]) assert.equal((await h.postRaw('/e/wallet', body)).status, 400);
  assert.equal((await h.postRaw('/e/wallet', { public_key: W.address })).status, 200);
  for (const k of [SEASON, W.address]) assert.deepEqual((await h.postRaw('/e/wallet', { public_key: k })).v, { code: 'WalletAlreadyPinned' });
  for (const line of [{ runner: line1({ player_wallet: LOCAL_PLAY_PROGRAM }) }, { runner: line1({ test_capability: { ...line1().test_capability, purpose: 'fresh-start' } }) }, 'x', null]) assert.throws(() => h.entry.configure(line), { code: 'BadConfiguration' });
  assert.equal(h.made(), null);
  h.entry.configure({ runner: line1() }); assert.throws(() => h.entry.configure({ runner: line1() }), { code: 'ConfiguredAlready' });
  const page = await h.get('/'); assert.equal(page.v, E_PAGE);
  for (const host of ['evil.example', `127.0.0.1:${PORT + 1}`, undefined]) assert.deepEqual(JSON.parse((await h.entry.handle({ method: 'GET', path: '/', host })).body), { code: 'HostDenied' });
  for (const origin of ['http://evil.example', 'null', undefined]) assert.equal((await h.postRaw(LOCAL_ACT_CONTEXT_PATH, {}, { origin })).v.code, 'OriginDenied');
  assert.equal((await h.postRaw(LOCAL_ACT_CONTEXT_PATH, {}, { type: 'text/plain' })).v.code, 'JsonOnly'); assert.equal((await h.entry.handle({ method: 'PUT', path: '/', host: HOST })).status, 405);
  for (const p of ['/f/wallet', '/a/wallet', '/gw/f/local-play/depart/submit', '/gw/f/local-play/reveal/submit', '/gw/f/local-play/conquest/submit', '/gw/f/act', '/e/configure', '/e/step']) assert.equal((await h.postRaw(p, {})).status, 404, p);
  for (const p of ['/f/state', '/a/state', '/permutation-gateway/screens/codex/live-connect-fresh-steps.mjs', '/permutation-gateway/screens/codex/live-connect-fresh-economy.mjs', '/etc/passwd']) assert.equal((await h.get(p)).status, 404, p);
  assert.deepEqual(Object.keys(E_PAGE_FILES), ['/permutation-gateway/screens/codex/live-connect-fresh-economy-steps.mjs', E_PAGE_SCRIPT_PATH]); assert.ok(E_PAGE.includes(`src="${E_PAGE_SCRIPT_PATH}"`));
  const here = new URL('../screens/codex/', import.meta.url).pathname;
  assert.notEqual(await readWebFile(here, 'live-connect-fresh-economy-steps.mjs'), null); for (const rel of ['../../package.json', '/etc/passwd', 'x.txt', '']) assert.equal(await readWebFile(here, rel), null);
  // the lifetime: a wall clock set back does not lengthen it; latched
  assert.equal((await h.get('/e/state')).v.remaining_ms, 5000); h.t.wall -= 3_600_000; h.t.mono += 5001;
  for (const [m, p, b] of [['GET', '/'], ['GET', '/e/state'], ['POST', LOCAL_ACT_SUBMIT_PATH, {}], ['POST', LOCAL_ACT_STATUS_PATH, {}], ['POST', '/e/wallet', { public_key: W.address }]]) { const r = m === 'GET' ? await h.get(p) : await h.postRaw(p, b); assert.deepEqual([r.status, r.v.code], [410, 'Closed'], p); }
  assert.throws(() => h.entry.step(structuredClone(STEPS.genesis)), { code: 'Closed' }); h.t.mono -= 100000; assert.equal((await h.get('/e/state')).status, 410); assert.deepEqual(h.rpc, []);
});

test('SEPARATION: its four files import nothing of the Join/Home entry, of Stage A or C; no gate constant, no storage, no secret; the relay\'s own listener passes no test form; none of its files is in the Join/Home pin list', () => {
  const src = f => readFileSync(new URL(f, import.meta.url), 'utf8');
  const mine = ['live-connect-fresh-economy.mjs', 'live-connect-fresh-economy-steps.mjs', 'live-connect-fresh-economy-page.mjs', 'live-connect-fresh-economy-page-script.mjs'];
  for (const f of mine) {
    const t = src(`../screens/codex/${f}`), imports = [...t.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)].map(m => m[1]);
    assert.ok(imports.length > 0 || f.endsWith('-page.mjs'), f);
    for (const i of imports) assert.ok(/live-connect-fresh-economy/.test(i) || !/live-connect/.test(i), `${f} imports ${i}`);
    assert.doesNotMatch(t, /CONQUEST_OPEN_CONDITIONS|heapConfirmed|pageBinding/); assert.doesNotMatch(t, /localStorage|sessionStorage|indexedDB|document\.cookie/); assert.doesNotMatch(t, /secretKey|privateKey|exportKey/);
    assert.doesNotMatch(t, /"f_step"|f_entry|f_wallet|\/f\/state|\/f\/wallet/, `${f} uses none of the Join/Home entry's words`);
  }
  // (the game's own entry points; the other test entries' files are checked in frontier-live-connect-fresh-separation.test.mjs)
  for (const f of ['../src/frontier/local-play-relay-server.mjs', '../src/frontier/local-play-launcher.mjs', '../src/frontier/server.mjs', '../src/frontier/app.mjs', '../../permutation-server/web/frontier/controller.mjs',
    '../../permutation-server/web/frontier/flocalplay-act.mjs']) assert.doesNotMatch(src(f), /live-connect-fresh-economy|createEconomyEntry|sendGuard\s*:/, f);
  let given = null; actFromArgs({ cfg: { rpc: 'http://127.0.0.1:41964' }, economy: true, runnerInstance: INSTANCE }, { create: o => { given = o; return {}; } });
  assert.deepEqual(Object.keys(given).sort(), ['cfg', 'runnerInstance']);
  // THE ARTEFACT PIN IS THIS TEST'S OWN: the entry does not import the conquest lane's shared constant. It names the
  // lane artefact rebuilt with the CreateSeason fix (b64a539a…); the conquest lane's shared constant is untouched and
  // still names e6bfe8c2… — which THIS entry refuses (the older artefact cannot create the fresh season).
  const entrySrc = src('../screens/codex/live-connect-fresh-economy.mjs');
  assert.doesNotMatch(entrySrc.split('\n').filter(l => l.startsWith('import ')).join('\n'), /conquest-table-read/);
  assert.equal(E_ARTIFACT_SHA256, 'b64a539afe066c59c6584ff7928f620647428f1a115df41f9289c772c4447f80');
  assert.equal(CONQUEST_ARTIFACT_CURRENT, 'e6bfe8c206caeb840531a64e9df497a2e4fc2c1224521e474700d774f4d961de', 'the shared constant was not moved');
  assert.notEqual(E_ARTIFACT_SHA256, CONQUEST_ARTIFACT_CURRENT);
  const ok = { wallet: W.address, pagePort: PORT };
  assert.deepEqual(eConfigProblems({ runner: line1() }, ok), [], 'the rebuilt artefact is taken');
  for (const sha256 of [CONQUEST_ARTIFACT_CURRENT, 'ab'.repeat(32), E_ARTIFACT_SHA256.toUpperCase(), E_ARTIFACT_SHA256.slice(0, 63), undefined])
    assert.deepEqual(eConfigProblems({ runner: line1({ artifact: { sha256 } }) }, ok), ['artifact is not this test\'s pinned one'], `refused: ${sha256}`);
  assert.deepEqual(eConfigProblems({ runner: line1({ artifact: undefined }) }, ok), ['artifact is not this test\'s pinned one']);
  // this test file itself imports nothing of the Join/Home entry or of Stage A / C (it runs where those do not exist)
  assert.doesNotMatch(src('./frontier-live-connect-fresh-economy.test.mjs').split('\n').filter(l => l.startsWith('import ')).join('\n'), /live-connect-(a|c)[-.]|live-connect-fresh(?!-economy)/);
});

test('THE PAGE\'S WORDS AND CONTROLS: one command enabled at a time; nothing while the state is stale or the key is gone; Muster is "accepted: a pending entry" — never a host, an army, the roster or movement; Build complete only when the runner says so', async () => {
  const h = world(); await h.begin(); await h.upTo('ready-for-train');
  const me = { address: W.address, sent: notSent(), stale: false }, s = h.state();
  assert.deepEqual(controls(s, me), { ...none(), Train: { send: true, status: false } });
  assert.deepEqual(controls(s, { ...me, sent: { ...notSent(), Build: { signature: 'S' }, Train: { signature: 'T' } } }), { ...none(), Build: { send: false, status: true }, Train: { send: false, status: true } });
  for (const off of [{ ...me, stale: true }, { ...me, stale: undefined }, { ...me, address: undefined }, { ...me, address: LOCAL_PLAY_PROGRAM }]) assert.deepEqual(controls(s, off), none());
  for (const st of [{ ...s, send: 'closed' }, { ...s, world: 'ended' }, { ...s, world: 'ended-incomplete' }, { ...s, phase: 'closed' }, { ...s, current: null }, null]) assert.deepEqual(controls(st, me), none());
  assert.equal(sendingText(s), 'open'); assert.match(sendingText(s, true), /^disabled — the entry did not answer/); assert.match(nowText(s), /^Train — announced by the runner/); assert.equal(nowText(s, true), '–');
  assert.match(nowText({ ...s, current: 'Join' }), /^Join \(prerequisite\)/); assert.equal(nowText({ ...s, current: null }), 'waiting for the runner\'s next announcement');
  // the run itself, given no state while stale: nothing is built or sent
  let stale = true; const run = createEconomyRun({ state: () => (stale ? null : h.state()), signer: () => W, origin: ORIGIN, post: h.post });
  await assert.rejects(run.send('Train', CHOICE.Train), { code: 'EconomyNotAnnounced' }); assert.equal(h.sends(), 0);
  // the reports: only what the runner announced
  const all = E_STEPS.map(n => STEPS[n]), upto = n => all.slice(0, E_STEPS.indexOf(n) + 1);
  assert.equal(reportText('Build', upto('ready-for-build')), '');
  assert.match(reportText('Build', upto('build-landed')), /accepted and queued \(item 3\); it completes at the first command of the village at or after done-at 1785633800\.\nnot reported complete yet\.$/);
  assert.match(reportText('Build', upto('muster-accepted')), /not reported complete yet\.$/, 'build_complete false on Train and Muster: not complete');
  assert.match(reportText('Build', upto('harvest-landed')), /the runner reports: the Build is complete\.$/);
  assert.match(reportText('Build', [...upto('build-landed'), { ...STEPS['train-landed'], build_complete: true }]), /the Build is complete\.$/, 'complete as soon as any step says so');
  assert.equal(reportText('Train', upto('train-landed')), 'the runner reports: 100 in reserve (unit 6; reserve 100).');
  const muster = reportText('Muster', upto('muster-accepted'));
  assert.match(muster, /^the runner reports: accepted: a pending entry \(100 troops, tile 30\)\. Acceptance only/);
  assert.match(reportText('Harvest', upto('harvest-landed')), /^the runner reports: accepted\. The Build is complete \(completed by: Harvest\)\.$/);
  assert.match(reportText('Join', upto('prereq-join-landed')), /\(prerequisite\)$/); assert.match(reportText('PlaceHome', upto('prereq-place-home-landed')), /\(prerequisite\)$/);
  // NEVER, anywhere a Muster is spoken of: a host, an army, the roster, marching or moving; never a cost or an amount
  const musterWords = [muster, E_PAGE.match(/<div class="step" id="muster-box">[\s\S]*?<\/div><\/div>/)[0]];
  for (const t of musterWords) assert.doesNotMatch(t.replace(/<[^>]*>/g, ' '), /\bhost\b|\barmy\b|\broster\b|\bmarch|\bmove|can act|stands/i);
  for (const t of [E_PAGE, ...E_ORDER.map(([n]) => reportText(n, all))]) assert.doesNotMatch(t.replace(/<[^>]*>/g, ' '), /\bcosts? \d|paid|spent|\bfood\b|\bwood\b|\bgold\b/i);
  assert.match(E_PAGE, /not the game's own screens/); assert.match(E_PAGE, /Prerequisites \(not this test's evidence\)/); assert.match(E_PAGE, /Costs and amounts are not shown or claimed/);
  for (const id of Object.values(E_IDS)) { assert.ok(E_PAGE.includes(`id="${id}"`) && E_PAGE.includes(`id="${id}-status"`) && E_PAGE.includes(`id="${id}-out"`), id); }
  assert.match(sendText({ sent: false, code: 'LocalActClosed' }), /^not sent/); assert.match(sendText({ sent: true, signature: 'S' }), /^sent once/); assert.doesNotMatch(sendText({ sent: true, signature: 'S' }), /landed|complete|accepted/i);
  assert.match(statusText({ signature: 'S', ok: true, state: 'pending' }), /^not seen yet/); assert.match(statusText({ signature: 'S', ok: false, code: 'LocalActNoAnswer' }), /ended without completing/);
});

test('the arguments: exactly --page-port (47100-47999) and --max-seconds (1-225), as the harness passes them; the wallet of this file was never destroyed', () => {
  assert.deepEqual(parseArgs(['--page-port', '47123', '--max-seconds', '225']), { pagePort: 47123, maxMs: 225000 });
  for (const argv of [[], ['--page-port', '47099', '--max-seconds', '225'], ['--page-port', '47123', '--max-seconds', '226'], ['--page-port', '41966', '--max-seconds', '60'], ['--page-port', '47123', '--max-seconds', '0'],
    ['--page-port', '47123', '--max-seconds', '60', '--economy', 'page-signed-v1'], ['--page-port', '47123', '--page-port', '47124']]) assert.throws(() => parseArgs(argv), /live-connect fresh economy/);
  assert.throws(() => createEconomyEntry({ pagePort: 47099, page: 'x' }), /page-port/); assert.throws(() => createEconomyEntry({ pagePort: PORT, maxMs: 225001, page: 'x' }), /max-seconds/); assert.throws(() => createEconomyEntry({ pagePort: PORT, page: '' }), /no page/);
  assert.equal(W.destroyed, false);
});
