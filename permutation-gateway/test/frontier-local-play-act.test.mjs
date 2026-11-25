// The validator core of the local-play economy path (src/frontier/local-play-act.mjs): Join, PlaceHome, Harvest,
// Build, Train, Muster as page-signed transactions whose fee payer AND actor is the one wallet.
// A KEY-USING test (scripts/ci/node-key-tests.txt): an in-memory test Ed25519 key, never printed or stored, signs the
// messages. No relay, no chain, no network: nothing is sent — this module sends nothing.
// It shows the check a relay will make. It is not wired into any server or page, and it is no evidence of play.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { encode } from '../client/src/base58.mjs';
import { localActIntent, localActMessage, localActSubmit, LocalActError, LOCAL_ACT_COMMANDS, LOCAL_ACT_SUBMIT_SCHEMA } from '../src/frontier/local-play-act.mjs';
import { LOCAL_PLAY_PROGRAM, LOCAL_PLAY_RULESET_HASH } from '../src/frontier/local-play-relay.mjs';
import { SIGNED_BY } from '../../permutation-server/web/frontier/fplay.mjs';
import { seasonPda } from '../../permutation-server/web/frontier/faddr.mjs';

const key = () => { const { publicKey, privateKey } = generateKeyPairSync('ed25519'); return { address: encode(publicKey.export({ format: 'der', type: 'spki' }).subarray(12)), privateKey }; };
const W = key(), OTHER = key();
const SEASON = seasonPda(LOCAL_PLAY_PROGRAM, 11)[0], HASH = encode(new Uint8Array(32).fill(7));
const pins = (over = {}) => ({ program: LOCAL_PLAY_PROGRAM, season: SEASON, seasonId: 11, wallet: W.address, rulesetHash: LOCAL_PLAY_RULESET_HASH, ...over });
const HOME = { p: 3, q: -2, site: 4 };
const INTENTS = {
  Join: { name: 'Join', subject: { faction: 2 }, fields: { faction: 2, session: W.address, session_expiry: '1785600000' } },
  PlaceHome: { name: 'PlaceHome', subject: { holding: HOME, faction: 2 }, fields: { p: 3, q: -2, site: 4 } },
  Harvest: { name: 'Harvest', subject: { holding: HOME }, fields: {} },
  Build: { name: 'Build', subject: { holding: HOME }, fields: { item: 1 } },
  Train: { name: 'Train', subject: { holding: HOME }, fields: { unit: 0, n: 10 } },
  Muster: { name: 'Muster', subject: { holding: HOME }, fields: { unit: 0, troops: 10, tile: 30 } },
};
const wireOf = (message, signers = [W]) => Buffer.concat([Buffer.from([signers.length]), ...signers.map(s => sign(null, message, s.privateKey)), Buffer.from(message)]).toString('base64');
const body = (intent, tx) => ({ schema: LOCAL_ACT_SUBMIT_SCHEMA, name: intent.name, subject: intent.subject, fields: intent.fields, transaction_b64: tx });
const signedFor = (intent, p = pins(), signers = [W]) => wireOf(localActMessage(localActIntent(intent, { wallet: p.wallet }), p, HASH).message, signers);
const refused = (f, code) => assert.throws(f, e => e instanceof LocalActError && e.code === code, code);

test('the closed list: exactly the six commands, each one the page already sends; nothing else is taken', () => {
  // (wide-local-playable: and the local wide world's one-site rim request and wide claim — the claim is not an SDK
  //  shape, flocalplay-wide.mjs builds it on both sides; frontier-local-play-wide-play.test.mjs)
  // (wide -> wide marches, #94, owner Q-W2 t385u: plus the wide village's own WideTrain / WideMuster / WideDepart, built by
  //  flocalplay-wide-host.mjs on both sides; the list is still closed — frontier-local-play-wide-host.test.mjs)
  // (territory-impl, owner 2026-11-24 12:09: plus the single-tile claim, flocalplay-territory.mjs on both sides)
  assert.deepEqual(LOCAL_ACT_COMMANDS, ['Join', 'PlaceHome', 'Harvest', 'Build', 'Train', 'Muster', 'FileTicket', 'WideClaim', 'TerritoryClaim', 'WideTrain', 'WideMuster', 'WideDepart', 'ResearchPledge', 'ResearchApply']); assert.ok(Object.isFrozen(LOCAL_ACT_COMMANDS));
  const NOT_SDK = ['WideClaim', 'TerritoryClaim', 'WideTrain', 'WideMuster', 'WideDepart', 'ResearchPledge', 'ResearchApply'];  // (research: flocalplay-research.mjs)
  for (const n of LOCAL_ACT_COMMANDS.filter(n => !NOT_SDK.includes(n))) assert.ok(Object.hasOwn(SIGNED_BY, n), n);
  for (const n of NOT_SDK) assert.ok(!Object.hasOwn(SIGNED_BY, n), `${n} is not an SDK shape`);
  for (const name of ['SetSession', 'JoinResident', 'DeclareSiege', 'Depart', 'Dissolve', 'Garrison', 'Explore', 'SendCaravan', 'RaidCaravan', 'BuildVault', 'Vote', 'SeizeVault', 'SettleTransit', 'toString', '__proto__', '']) {
    refused(() => localActIntent({ name, subject: { holding: HOME }, fields: {} }, { wallet: W.address }), name === '' ? 'LocalActNotAllowed' : 'LocalActNotAllowed');
  }
});

test('each command, signed once by the wallet as fee payer and actor, is accepted as exactly what it is stated to be', () => {
  for (const [name, intent] of Object.entries(INTENTS)) {
    const got = localActSubmit(body(intent, signedFor(intent)), pins());
    assert.equal(got.intent.name, name); assert.deepEqual(JSON.parse(JSON.stringify(got.intent)), intent); assert.equal(got.blockhash, HASH); assert.equal(typeof got.signature, 'string');
    // the message is the game's own builder's, with no signer but the wallet
    assert.deepEqual([...got.message], [...localActMessage(localActIntent(intent, { wallet: W.address }), pins(), HASH).message]);
  }
  // the six messages are six different messages
  assert.equal(new Set(Object.values(INTENTS).map(i => signedFor(i))).size, 6);
});

test('a signature cannot be carried to another command, village, field or wallet: the stated intent must rebuild the signed bytes', () => {
  const tx = signedFor(INTENTS.Train);
  // the same transaction stated as something else
  refused(() => localActSubmit(body(INTENTS.Harvest, tx), pins()), 'LocalActMessageMismatch');
  refused(() => localActSubmit(body({ ...INTENTS.Train, fields: { unit: 0, n: 11 } }, tx), pins()), 'LocalActMessageMismatch');
  refused(() => localActSubmit(body({ ...INTENTS.Train, fields: { unit: 1, n: 10 } }, tx), pins()), 'LocalActMessageMismatch');
  refused(() => localActSubmit(body({ ...INTENTS.Train, subject: { holding: { p: 3, q: -2, site: 5 } } }, tx), pins()), 'LocalActMessageMismatch');
  refused(() => localActSubmit(body({ ...INTENTS.Train, subject: { holding: { p: 4, q: -2, site: 4 } } }, tx), pins()), 'LocalActMessageMismatch');
  refused(() => localActSubmit(body(INTENTS.Muster, signedFor(INTENTS.Build)), pins()), 'LocalActMessageMismatch');
  // another ruleset's ABI profile, another Season id: not this relay's message
  assert.throws(() => localActSubmit(body(INTENTS.Train, tx), pins({ seasonId: 12 })), LocalActError);
  // the wallet: another wallet's own valid transaction; this wallet's message signed by another key; two signatures
  refused(() => localActSubmit(body(INTENTS.Train, signedFor(INTENTS.Train, pins({ wallet: OTHER.address }), [OTHER])), pins()), 'LocalActSigner');
  const mine = localActMessage(localActIntent(INTENTS.Train, { wallet: W.address }), pins(), HASH).message;
  refused(() => localActSubmit(body(INTENTS.Train, wireOf(mine, [OTHER])), pins()), 'LocalActSigner');
  assert.throws(() => localActSubmit(body(INTENTS.Train, wireOf(mine, [W, OTHER])), pins()), LocalActError);
  // one byte of the signed message altered
  const raw = Buffer.from(tx, 'base64'); raw[raw.length - 1] ^= 1;
  assert.throws(() => localActSubmit(body(INTENTS.Train, raw.toString('base64')), pins()), LocalActError);
});

test('the intent shapes are closed: every field is required, typed and in range; the Join\'s session key is the wallet itself; PlaceHome\'s fields are its village', () => {
  const bad = (intent, code = 'LocalActInvalid') => refused(() => localActIntent(intent, { wallet: W.address }), code);
  for (const v of [null, 'x', [], {}, { name: 'Harvest' }, { name: 'Harvest', subject: { holding: HOME } }, { ...INTENTS.Harvest, extra: 1 }, { name: 7, subject: {}, fields: {} }]) bad(v);
  bad({ ...INTENTS.Harvest, fields: { n: 1 } }); bad({ ...INTENTS.Harvest, subject: { holding: HOME, faction: 2 } }); bad({ ...INTENTS.Harvest, subject: {} });
  for (const item of [-1, 8, '1', 1.5, null]) bad({ ...INTENTS.Build, fields: { item } });
  // (n is 4 bytes in the ABI, as Muster's troops: the whole range is taken, nothing beyond it)
  for (const f of [{ unit: 0 }, { unit: 0, n: 0 }, { unit: 256, n: 1 }, { unit: 0, n: 2 ** 32 }, { unit: 0, n: 1.5 }, { unit: 0, n: 1, x: 1 }, { unit: '0', n: 1 }]) bad({ ...INTENTS.Train, fields: f });
  for (const n of [65535, 65536, 1_000_000, 2 ** 32 - 1]) assert.equal(localActIntent({ ...INTENTS.Train, fields: { unit: 0, n } }, { wallet: W.address }).fields.n, n);
  for (const f of [{ unit: 0, troops: 0, tile: 30 }, { unit: 0, troops: 10, tile: 61 }, { unit: 0, troops: 10 }, { unit: 0, troops: 2 ** 32, tile: 0 }]) bad({ ...INTENTS.Muster, fields: f });
  for (const h of [{ p: 3, q: -2 }, { p: 3, q: -2, site: 12 }, { p: '3', q: -2, site: 4 }, { p: 3.5, q: 0, site: 0 }, { p: 3, q: -2, site: 4, gen: 1 }, null]) bad({ ...INTENTS.Harvest, subject: { holding: h } });
  // PlaceHome: the fields are the village's own, and the nation is stated
  for (const f of [{ p: 3, q: -2, site: 5 }, { p: 4, q: -2, site: 4 }, { p: 3, q: -2 }]) bad({ ...INTENTS.PlaceHome, fields: f });
  bad({ ...INTENTS.PlaceHome, subject: { holding: HOME } }); bad({ ...INTENTS.PlaceHome, subject: { holding: HOME, faction: 6 } });
  // Join: no other key is ever registered — the session key must be the wallet; the nation is one of six; the expiry a plain decimal
  bad({ ...INTENTS.Join, fields: { ...INTENTS.Join.fields, session: OTHER.address } }); bad({ ...INTENTS.Join, fields: { ...INTENTS.Join.fields, session: 'x' } });
  bad({ ...INTENTS.Join, fields: { ...INTENTS.Join.fields, faction: 3 } }); bad({ ...INTENTS.Join, subject: { faction: 6 }, fields: { ...INTENTS.Join.fields, faction: 6 } });
  for (const session_expiry of [1785600000, '0', '-1', '01', '', '1e9']) bad({ ...INTENTS.Join, fields: { ...INTENTS.Join.fields, session_expiry } });
  bad({ ...INTENTS.Join, subject: { faction: 2, joinGate: 'x' } });
  // what survives is only what the command can carry, frozen
  const kept = localActIntent(INTENTS.Muster, { wallet: W.address }); assert.ok(Object.isFrozen(kept) && Object.isFrozen(kept.subject) && Object.isFrozen(kept.subject.holding) && Object.isFrozen(kept.fields));
});

test('the wide guard: a village outside the legacy disk is refused for every one of these commands, before any message is built', () => {
  for (const name of ['PlaceHome', 'Harvest', 'Build', 'Train', 'Muster']) {
    for (const [p, q] of [[129, 0], [0, 129], [-129, 0], [200, -50]]) {
      const holding = { p, q, site: 1 }, intent = { ...INTENTS[name], subject: name === 'PlaceHome' ? { holding, faction: 2 } : { holding }, fields: name === 'PlaceHome' ? { p, q, site: 1 } : INTENTS[name].fields };
      refused(() => localActIntent(intent, { wallet: W.address }), 'LocalActWideHolding');
    }
  }
  assert.equal(localActIntent({ ...INTENTS.Harvest, subject: { holding: { p: 128, q: 0, site: 1 } } }, { wallet: W.address }).subject.holding.p, 128, 'the edge of the legacy disk is still legacy');
});

test('the request around it is closed too; and nothing is wired: no server, page or launcher names this module', () => {
  const tx = signedFor(INTENTS.Harvest), ok = body(INTENTS.Harvest, tx);
  assert.equal(localActSubmit(ok, pins()).intent.name, 'Harvest');
  for (const b of [{ ...ok, schema: 'frontier-local-play-depart-submit-v1' }, { ...ok, extra: 1 }, { ...ok, transaction_b64: tx + '=' }, { ...ok, transaction_b64: 'A'.repeat(1704) }, { ...ok, transaction_b64: 7 },
    (() => { const x = { ...ok }; delete x.fields; return x; })(), null, 'x']) assert.throws(() => localActSubmit(b, pins()), LocalActError);
  // (the page's controller reaches the page-side transport for the six; the relay's SERVER serves the routes only when
  //  its command line asks in words — tested below; the relay's core, the page's app and the launcher do not name them)
  for (const f of ['../src/frontier/local-play-relay.mjs', '../src/frontier/local-play-reveal.mjs', '../src/frontier/local-play-resident.mjs', '../src/frontier/local-play-conquest.mjs', '../../permutation-server/web/frontier/app.mjs']) {
    assert.doesNotMatch(readFileSync(new URL(f, import.meta.url), 'utf8'), /local-play-act|localActSubmit|LOCAL_ACT_/, f);
  }
  // the page's general `act` is still refused in local play, before anything is built — for everything but the six in their plain form
  const controller = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
  assert.equal(controller.split("const route = localAct.localOrderRoute({ localPlay: pl?.identity ?? null, name, v, signer, requester, names: pl?.lane.names, otherwise: pl?.otherwise });\n  if (route === 'refuse') return early(localPlayReadOnly());").length - 1, 1, 'asked first, in the order path');
  assert.equal(controller.split("const local = lo !== null && localAct.localOrderRoute({ localPlay: lo.identity, name, v, signer, requester, names: lo.lane.names }) === 'local-act';").length - 1, 1, 'and asked again where the transaction is made');
  assert.equal(controller.split('localAct.submitLocalAct(').length - 1, 1, 'one place sends them');
});

// ---------------------------------------------------------------------------------------------------------------
// The relay flow (createLocalPlayAct): context, submit with the read of the real accounts, status. The runner's RPC
// and the accounts are stand-ins built here from the layouts as read; nothing is sent anywhere.
const { createLocalPlayAct, LOCAL_ACT_ROUTES, LOCAL_ACT_CONTEXT_SCHEMA, LOCAL_ACT_STATUS_SCHEMA, LOCAL_ACT_MAX_HISTORY } = await import('../src/frontier/local-play-act.mjs');
const { seasonAddresses } = await import('../../permutation-server/web/frontier/faddr.mjs');
const { decode: b58d } = await import('../client/src/base58.mjs');
const A = seasonAddresses(LOCAL_PLAY_PROGRAM, '11'), CITIZEN_AT = A.of('Citizen', { wallet: W.address }), HOLDING_AT = A.of('Holding', HOME), INSTANCE = 'ab'.repeat(32);
const cfg = { localPlay: true, rpc: 'http://127.0.0.1:41964', program: LOCAL_PLAY_PROGRAM, season: SEASON, wallet: W.address, rulesetHash: LOCAL_PLAY_RULESET_HASH, prepareBin: '/x/depart', cuLimit: '1000000', loadedLimit: '67108864' };
/** A Citizen account of `wallet` at `address`, as the reader requires it: magic, Season 11, layout 2, the wallet at 64, the address's tag at 208. */
function citizenBytes(wallet = W.address, at = CITIZEN_AT) { const b = new Uint8Array(384), v = new DataView(b.buffer); b.set(Buffer.from('PSF1CITZ'), 0); v.setBigUint64(8, 11n, true); v.setUint16(16, 2, true); b.set(b58d(wallet), 64); b.set(b58d(at).subarray(0, 8), 208); return b; }
/** A legacy Holding owned by the Citizen at `owner` (the owner field at 72, as the layout has it). */
// (the layout's own offsets: SEASON_ID 8, P 64 and Q 66 as i16, SITE 68, OWNER_CITIZEN 72)
function holdingBytes({ magic = 'PSF1HOLD', owner = CITIZEN_AT, season = 11n, p = HOME.p, q = HOME.q, site = HOME.site } = {}) {
  const b = new Uint8Array(1280), v = new DataView(b.buffer); b.set(Buffer.from(magic), 0); v.setBigUint64(8, season, true); v.setInt16(64, p, true); v.setInt16(66, q, true); b[68] = site; b.set(b58d(owner), 72); return b;
}
const row = (bytes, owner = LOCAL_PLAY_PROGRAM) => (bytes === null ? null : { owner, executable: false, lamports: 1, data: [Buffer.from(bytes).toString('base64'), 'base64'] });
function flow({ citizen = row(citizenBytes()), holding = row(holdingBytes()), send = null, status = null, probe = null, instance = INSTANCE, runnerInstance = INSTANCE } = {}) {
  const calls = []; let sentYet = false;
  const act = createLocalPlayAct({ cfg, runnerInstance, rpc: async (method, params) => {
    calls.push({ method, params });
    if (method === 'getLatestBlockhash') return { result: { context: { slot: 90 }, value: { blockhash: HASH, lastValidBlockHeight: 300 } } };
    if (method === 'getMultipleAccounts') return { result: { context: { slot: 91 }, value: params[0].map(a => (a === CITIZEN_AT ? citizen : holding)) } };
    if (method === 'sendTransaction') { sentYet = true; return send ? send(params) : { result: encode(Buffer.from(params[0], 'base64').subarray(1, 65)) }; }
    // (before the send: the relay's last question — the runner does not know the signature yet; after it: the status)
    if (method === 'getSignatureStatuses' && !sentYet) return probe ?? { result: { context: { slot: 92, apiVersion: 'x', instance }, value: [null] } };
    if (method === 'getSignatureStatuses') return status ?? { result: { context: { slot: 95, apiVersion: 'x', instance }, value: [{ slot: 93, confirmationStatus: 'confirmed', err: null }] } };
    return { error: { code: -1 } };
  } });
  return { act, calls, sends: () => calls.filter(c => c.method === 'sendTransaction').length, reads: () => calls.filter(c => c.method === 'getMultipleAccounts') };
}
const rejects = (p, code) => assert.rejects(p, e => e instanceof LocalActError && e.code === code, code);

test('the flow: a blockhash to build on; a command of this wallet\'s own legacy village is read on the real accounts, sent ONCE, and its status is the pinned runner\'s', async () => {
  const h = flow();
  assert.deepEqual(await h.act.context({ schema: LOCAL_ACT_CONTEXT_SCHEMA }), { wallet: W.address, blockhash: { hash: HASH, last_valid_block_height: '300', context_slot: '90' } });
  await rejects(h.act.context({ schema: 'x' }), 'LocalActInvalid'); await rejects(h.act.context({}), 'LocalActInvalid');
  assert.deepEqual(LOCAL_ACT_ROUTES, { context: 'POST /f/local-play/act/context', submit: 'POST /f/local-play/act/submit', status: 'POST /f/local-play/act/status' });
  for (const name of ['Harvest', 'Build', 'Train', 'Muster']) {
    const g = flow(), b = body(INTENTS[name], signedFor(INTENTS[name]));
    const sent = await g.act.submit(b);
    assert.deepEqual([sent.status, sent.name, sent.status_route], ['submitted', name, 'POST /f/local-play/act/status']); assert.equal(g.sends(), 1);
    assert.deepEqual(g.reads()[0].params, [[CITIZEN_AT, HOLDING_AT], { encoding: 'base64', commitment: 'confirmed' }], 'ONE read: this wallet\'s Citizen and the village, at the addresses derived here');
    assert.equal(g.reads().length, 1);
    // the same bytes again: refused, nothing sent
    await rejects(g.act.submit(b), 'LocalActMessageUsed'); assert.equal(g.sends(), 1);
    assert.deepEqual(await g.act.status({ schema: LOCAL_ACT_STATUS_SCHEMA, signature: sent.signature }), { signature: sent.signature, status: 'confirmed', err: null, slot: 93, context_slot: 95 });
  }
  // PlaceHome: the village may be absent (the command makes it); Join: no Citizen yet, and no village is read at all
  let g = flow({ holding: null }); assert.equal((await g.act.submit(body(INTENTS.PlaceHome, signedFor(INTENTS.PlaceHome)))).status, 'submitted');
  g = flow({ citizen: null }); assert.equal((await g.act.submit(body(INTENTS.Join, signedFor(INTENTS.Join)))).status, 'submitted'); assert.deepEqual(g.reads()[0].params[0], [CITIZEN_AT]);
  // an answer that never comes, or another signature back: unknown — and never sent again
  g = flow({ send: () => { throw new Error('socket'); } }); const b = body(INTENTS.Harvest, signedFor(INTENTS.Harvest));
  assert.equal((await g.act.submit(b)).status, 'unknown'); await rejects(g.act.submit(b), 'LocalActMessageUsed'); assert.equal(g.sends(), 1);
  g = flow({ send: () => ({ result: 'other' }) }); assert.equal((await g.act.submit(b)).status, 'unknown');
  g = flow({ send: () => ({ error: { code: -32002, message: 'refused' } }) }); await rejects(g.act.submit(b), 'LocalActSendRefused'); await rejects(g.act.submit(b), 'LocalActMessageUsed');
});

test('the real accounts decide: a wide village, another owner\'s village, a foreign or missing account, a Citizen that is not this wallet\'s — refused, and NOTHING is sent', async () => {
  const b = body(INTENTS.Train, signedFor(INTENTS.Train));
  const no = async (over, code, intent = INTENTS.Train) => { const g = flow(over); await rejects(g.act.submit(body(intent, signedFor(intent))), code); assert.equal(g.sends(), 0, code); return g; };
  // the village: a WIDE Holding at that address (another family), an unknown family, absent, another program's, another Citizen's
  await no({ holding: row(holdingBytes({ magic: 'PSFXWHL1' })) }, 'LocalActWideHolding');
  await no({ holding: row(holdingBytes({ magic: 'PSF1PROV' })) }, 'LocalActHolding'); await no({ holding: null }, 'LocalActHolding');
  await no({ holding: row(holdingBytes(), SEASON) }, 'LocalActHolding');
  await no({ holding: row(holdingBytes({ owner: A.of('Citizen', { wallet: OTHER.address }) })) }, 'LocalActNotYourVillage');
  await no({ holding: row(holdingBytes({ magic: 'PSFXWHL1' })) }, 'LocalActWideHolding', INTENTS.PlaceHome);
  await no({ holding: row(holdingBytes(), SEASON) }, 'LocalActHolding', INTENTS.PlaceHome);
  // the account at the address must itself say it is THIS village: another Season, other coordinates, another site
  await no({ holding: row(holdingBytes({ season: 12n })) }, 'LocalActHolding'); await no({ holding: row(holdingBytes({ p: 4 })) }, 'LocalActHolding');
  await no({ holding: row(holdingBytes({ q: -3 })) }, 'LocalActHolding'); await no({ holding: row(holdingBytes({ site: 5 })) }, 'LocalActHolding');
  // the Citizen: absent, another program's, another wallet's bytes at this address, another Season
  await no({ citizen: null }, 'LocalActCitizen'); await no({ citizen: row(citizenBytes(), SEASON) }, 'LocalActCitizen');
  await no({ citizen: row(citizenBytes(OTHER.address)) }, 'LocalActCitizen'); await no({ citizen: row(citizenBytes(W.address, HOLDING_AT)) }, 'LocalActCitizen');
  await no({ citizen: row(citizenBytes().subarray(0, 300)) }, 'LocalActCitizen');
  // Join when the Citizen already exists
  await no({}, 'LocalActAlreadyJoined', INTENTS.Join);
  // an unusable answer is not "absent": no account list, a wrong count, a malformed row, an RPC error
  for (const bad of [{ result: { context: { slot: 91 }, value: [null] } }, { result: { value: [null, null] } }, { result: { context: { slot: 91 }, value: 'x' } }, { error: { code: -1 } }, null]) {
    const calls = [], act = createLocalPlayAct({ cfg, rpc: async m => { calls.push(m); return m === 'getMultipleAccounts' ? bad : { error: { code: -1 } }; } });
    await rejects(act.submit(b), 'LocalActRpcUnavailable'); assert.ok(!calls.includes('sendTransaction'));
  }
  const g = flow({ holding: { owner: LOCAL_PLAY_PROGRAM, data: ['not base64!', 'base64'] } }); await rejects(g.act.submit(b), 'LocalActRpcUnavailable'); assert.equal(g.sends(), 0);
  // a refusal before the send leaves the bytes unconsumed: the same transaction can be submitted when the accounts are right
  const calls = []; let holding = null;
  const act = createLocalPlayAct({ cfg, rpc: async (m, p) => { calls.push(m); if (m === 'getMultipleAccounts') return { result: { context: { slot: 91 }, value: [row(citizenBytes()), holding] } }; return { result: encode(Buffer.from(p[0], 'base64').subarray(1, 65)) }; } });
  await rejects(act.submit(b), 'LocalActHolding'); holding = row(holdingBytes()); assert.equal((await act.submit(b)).status, 'submitted'); assert.equal(calls.filter(m => m === 'sendTransaction').length, 1);
});

test('status is read strictly and only from the pinned runner; only signatures this relay sent; the barrier is bounded; the configuration is the relay\'s own', async () => {
  const b = body(INTENTS.Harvest, signedFor(INTENTS.Harvest));
  const ask = async (status, over = {}) => { const g = flow({ status, ...over }); const s = await g.act.submit(b); return g.act.status({ schema: LOCAL_ACT_STATUS_SCHEMA, signature: s.signature }); };
  const ctx = { slot: 95, instance: INSTANCE };
  assert.equal((await ask({ result: { context: ctx, value: [null] } })).status, 'pending');
  assert.equal((await ask({ result: { context: ctx, value: [{ slot: 93, confirmationStatus: 'processed', err: { InstructionError: [2, 'Custom'] } }] } })).status, 'failed');
  for (const value of [[{ confirmationStatus: 'confirmed' }], [{ confirmationStatus: 'confirmed', err: null }], [{ slot: 96, confirmationStatus: 'confirmed', err: null }], [{ slot: 93, confirmationStatus: 'landed', err: null }], [], [null, null], 'x']) {
    await rejects(ask({ result: { context: ctx, value } }), 'LocalActRpcUnavailable');
  }
  for (const context of [{ slot: 95 }, { slot: 95, instance: 'cd'.repeat(32) }, { instance: INSTANCE }, null]) await rejects(ask({ result: { context, value: [null] } }), 'LocalActRpcUnavailable');
  // THE LAST QUESTION BEFORE THE SEND (a pinned runner): its own word on this signature, from the pinned instance.
  // Another instance, none, or a malformed answer → nothing is sent and the bytes are NOT consumed; a signature the
  // runner already knows is not sent again.
  for (const probe of [{ result: { context: { slot: 92, instance: 'cd'.repeat(32) }, value: [null] } }, { result: { context: { slot: 92 }, value: [null] } }, { result: { context: { slot: -1, instance: INSTANCE }, value: [null] } },
    { result: { context: { slot: 92, instance: INSTANCE }, value: [] } }, { result: { context: { slot: 92, instance: INSTANCE }, value: [null, null] } }, { error: { code: -1 } }]) {
    const g = flow({ probe }); await rejects(g.act.submit(b), 'LocalActRpcUnavailable'); assert.equal(g.sends(), 0); assert.deepEqual(g.act.stats(), { history: 0 }, 'not consumed');
  }
  { const g = flow({ probe: { result: { context: { slot: 92, instance: INSTANCE }, value: [{ slot: 90, confirmationStatus: 'confirmed', err: null }] } } });
    await rejects(g.act.submit(b), 'LocalActMessageUsed'); assert.equal(g.sends(), 0); assert.deepEqual(g.act.stats(), { history: 1 }, 'known to the runner: recorded, never sent by this relay'); }
  { const g = flow(), order = []; await g.act.submit(b); for (const c of g.calls) order.push(c.method);
    assert.deepEqual(order, ['getMultipleAccounts', 'getSignatureStatuses', 'sendTransaction'], 'accounts, then the runner\'s word, then the one send'); }
  { const g = flow({ runnerInstance: null }); await g.act.submit(b); assert.deepEqual(g.calls.map(c => c.method), ['getMultipleAccounts', 'sendTransaction'], 'a runner that states no instance is not asked'); }
  // without a pinned instance (a runner that states none) the same strict reading applies, minus the instance
  assert.equal((await ask({ result: { context: { slot: 95 }, value: [null] } }, { runnerInstance: null })).status, 'pending');
  const g = flow(); await rejects(g.act.status({ schema: LOCAL_ACT_STATUS_SCHEMA, signature: 'never-sent' }), 'LocalActUnknownSignature'); await rejects(g.act.status({ schema: 'x', signature: 'y' }), 'LocalActInvalid');
  assert.equal(LOCAL_ACT_MAX_HISTORY, 256); assert.deepEqual(g.act.stats(), { history: 0 });
  for (const over of [{ rpc: 'http://127.0.0.1:8899' }, { localPlay: false }, { rulesetHash: '00'.repeat(32) }]) assert.throws(() => createLocalPlayAct({ cfg: { ...cfg, ...over } }), /local-play act refused/);
  for (const runnerInstance of ['ab', '00'.repeat(32), 7]) assert.throws(() => createLocalPlayAct({ cfg, runnerInstance }), /bad runner instance/);
});

test('CLOSING: a submit that is inside an await when the relay begins to stop sends NOTHING and consumes nothing; one already sent keeps its record and is never "not sent"', async () => {
  const b = body(INTENTS.Train, signedFor(INTENTS.Train));
  /** A flow whose RPC method `hold` answers only when `release()` is called. */
  const delayed = hold => {
    const calls = []; let release; const gate = new Promise(r => { release = r; }); let sentYet = false;
    const act = createLocalPlayAct({ cfg, runnerInstance: INSTANCE, rpc: async (method, params) => {
      calls.push(method); if (method === hold) await gate;
      if (method === 'getLatestBlockhash') return { result: { context: { slot: 90 }, value: { blockhash: HASH, lastValidBlockHeight: 300 } } };
      if (method === 'getMultipleAccounts') return { result: { context: { slot: 91 }, value: [row(citizenBytes()), row(holdingBytes())] } };
      if (method === 'getSignatureStatuses') return { result: { context: { slot: 92, instance: INSTANCE }, value: [sentYet ? { slot: 92, confirmationStatus: 'confirmed', err: null } : null] } };
      if (method === 'sendTransaction') { sentYet = true; return { result: encode(Buffer.from(params[0], 'base64').subarray(1, 65)) }; }
      return { error: { code: -1 } };
    } });
    return { act, calls, release: () => release(), sends: () => calls.filter(m => m === 'sendTransaction').length };
  };
  const tick = () => new Promise(r => setImmediate(r));
  // (1) the close comes while the ACCOUNTS are being read: the read answers afterwards — no last question, no send, bytes not consumed
  let h = delayed('getMultipleAccounts'), p = h.act.submit(b); await tick(); assert.deepEqual(h.calls, ['getMultipleAccounts']);
  h.act.close(); h.release();
  await rejects(p, 'LocalActClosed'); assert.equal(h.sends(), 0); assert.deepEqual(h.calls, ['getMultipleAccounts']); assert.deepEqual(h.act.stats(), { history: 0 }, 'not consumed');
  // (2) the close comes while the runner is asked its LAST QUESTION (the instance check): the answer comes afterwards — no send
  h = delayed('getSignatureStatuses'); p = h.act.submit(b); await tick(); assert.deepEqual(h.calls, ['getMultipleAccounts', 'getSignatureStatuses']);
  h.act.close(); h.release();
  await rejects(p, 'LocalActClosed'); assert.equal(h.sends(), 0); assert.deepEqual(h.act.stats(), { history: 0 });
  // (3) after the close: every route is refused on entry, before anything is read
  for (const f of [() => h.act.submit(b), () => h.act.context({ schema: LOCAL_ACT_CONTEXT_SCHEMA }), () => h.act.status({ schema: LOCAL_ACT_STATUS_SCHEMA, signature: 'x' })]) { const n = h.calls.length; await rejects(f(), 'LocalActClosed'); assert.equal(h.calls.length, n); }
  assert.equal(h.act.closed(), true);
  // (4) the close comes while the SEND ITSELF is awaited: the transaction went out — its answer is given as it is (submitted), never "closed / not sent"
  h = delayed('sendTransaction'); p = h.act.submit(b); await tick(); assert.equal(h.sends(), 1);
  h.act.close(); h.release();
  const sent = await p; assert.deepEqual([sent.status, sent.name], ['submitted', 'Train']); assert.deepEqual(h.act.stats(), { history: 1 }, 'recorded: the bytes are barred for good');
  // (5) the context read crossing the close gives no blockhash to build on
  h = delayed('getLatestBlockhash'); p = h.act.context({ schema: LOCAL_ACT_CONTEXT_SCHEMA }); await tick(); h.act.close(); h.release(); await rejects(p, 'LocalActClosed');
  // LocalActClosed is a refusal BEFORE the send on both sides' lists (a submit answers it only when nothing was sent)
  const { LOCAL_ACT_PRESEND_REFUSALS } = await import('../src/frontier/local-play-act.mjs'); assert.ok(LOCAL_ACT_PRESEND_REFUSALS.includes('LocalActClosed'));
  // the listener's close closes the economy routes FIRST
  const srv = readFileSync(new URL('../src/frontier/local-play-relay-server.mjs', import.meta.url), 'utf8');
  assert.match(srv, /close: \(\) => new Promise\(r => \{ act\?\.close\(\);/);
});

test('the server: the routes exist only when the command line asks in words; without it they are 404 as before; refusals keep their own status and code', async () => {
  const { parseArgs, actFromArgs, serveLocalPlayRelay, relaysFromArgs, ECONOMY_MODE } = await import('../src/frontier/local-play-relay-server.mjs');
  const { createLocalPlayRelay } = await import('../src/frontier/local-play-relay.mjs');
  const base = ['--local-play', '--listen-port', '41966', '--rpc', 'http://127.0.0.1:41964', '--program', LOCAL_PLAY_PROGRAM, '--season', SEASON, '--wallet', W.address,
    '--ruleset-hash', LOCAL_PLAY_RULESET_HASH, '--prepare-bin', '/abs/prepare', '--cu-limit', '1000000', '--loaded-limit', '67108864'];
  // the command line: off unless given; exactly the one word; once; its value is not part of the relay's closed configuration
  assert.equal(ECONOMY_MODE, 'page-signed-v1');
  const plain = parseArgs(base), on = parseArgs([...base, '--economy', 'page-signed-v1']);
  assert.equal(plain.economy, false); assert.equal(on.economy, true); assert.deepEqual(on.cfg, plain.cfg); assert.ok(!Object.hasOwn(on.cfg, 'economy'));
  for (const v of ['true', 'yes', '1', 'page-signed', 'PAGE-SIGNED-V1', '', 'all']) assert.throws(() => parseArgs([...base, '--economy', v]), /--economy must be page-signed-v1/, v);
  assert.throws(() => parseArgs([...base, '--economy']), /bad argument/); assert.throws(() => parseArgs([...base, '--economy', 'page-signed-v1', '--economy', 'page-signed-v1']), /bad argument/);
  for (const flag of ['--act', '--economy-all', '--allow-act']) assert.throws(() => parseArgs([...base, flag, 'page-signed-v1']), /bad argument/, flag);
  // the builder: nothing unless asked; the relay's own configuration and the one runner instance, nothing else
  const made = [];
  assert.equal(actFromArgs({ cfg: plain.cfg, economy: false, runnerInstance: INSTANCE }, { create: a => { made.push(a); return 'A'; } }), null);
  for (const economy of [undefined, null, 'page-signed-v1', 1, 'true']) assert.equal(actFromArgs({ cfg: plain.cfg, economy }, { create: a => { made.push(a); return 'A'; } }), null, String(economy));
  assert.deepEqual(made, []);
  assert.equal(actFromArgs({ cfg: plain.cfg, economy: true }, { create: a => { made.push(a); return 'A'; } }), 'A');
  assert.equal(actFromArgs({ cfg: plain.cfg, economy: true, runnerInstance: INSTANCE }, { create: a => { made.push(a); return 'A'; } }), 'A');
  assert.deepEqual(made, [{ cfg: plain.cfg }, { cfg: plain.cfg, runnerInstance: INSTANCE }]);
  // the other relays are built exactly as before, with or without the flag
  const others = []; relaysFromArgs({ cfg: on.cfg, residentBin: null, conquestBin: null, conquestCapability: null, runnerInstance: null, economy: true }, { relay: a => { others.push(a); return 'R'; }, resident: () => 'S', conquest: a => { others.push(a); return null; } });
  for (const a of others) assert.ok(!Object.hasOwn(a, 'economy'));
  // OVER HTTP (a loopback listener on a free port): without the routes → 404; with them → served, refusals with their own status and code
  const depart = () => createLocalPlayRelay({ cfg, prepare: { prepare: async () => ({ status: 'blocked' }), close() {} } });
  const call = async (s, path, b) => { const r = await fetch(`http://127.0.0.1:${s.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return [r.status, await r.json()]; };
  const bare = await serveLocalPlayRelay(depart(), 0);
  try { for (const p of ['context', 'submit', 'status']) assert.deepEqual((await call(bare, `/f/local-play/act/${p}`, {}))[0], 404, p); } finally { await bare.close(); }
  const h = flow(), s = await serveLocalPlayRelay(depart(), 0, { act: h.act });
  try {
    assert.deepEqual(await call(s, '/f/local-play/act/context', { schema: LOCAL_ACT_CONTEXT_SCHEMA }), [200, { wallet: W.address, blockhash: { hash: HASH, last_valid_block_height: '300', context_slot: '90' } }]);
    const b = body(INTENTS.Harvest, signedFor(INTENTS.Harvest));
    const [st, sent] = await call(s, '/f/local-play/act/submit', b); assert.equal(st, 200); assert.deepEqual([sent.status, sent.name], ['submitted', 'Harvest']); assert.equal(h.sends(), 1);
    assert.deepEqual((await call(s, '/f/local-play/act/submit', b)).map((x, i) => (i ? x.code : x)), [409, 'LocalActMessageUsed']); assert.equal(h.sends(), 1);
    assert.deepEqual((await call(s, '/f/local-play/act/status', { schema: LOCAL_ACT_STATUS_SCHEMA, signature: sent.signature }))[1].status, 'confirmed');
    assert.deepEqual((await call(s, '/f/local-play/act/submit', body({ name: 'Depart', subject: { holding: HOME }, fields: {} }, signedFor(INTENTS.Train)))).map((x, i) => (i ? x.code : x)), [403, 'LocalActNotAllowed']);
    assert.deepEqual((await call(s, '/f/local-play/act/status', { schema: LOCAL_ACT_STATUS_SCHEMA, signature: 'never' })).map((x, i) => (i ? x.code : x)), [404, 'LocalActUnknownSignature']);
    assert.notEqual((await fetch(`http://127.0.0.1:${s.port}/f/local-play/act/context`)).status, 200, 'never by GET');
  } finally { await s.close(); }
  // a send the runner refused: 502 with the code AND the signature (the page keeps it: "sent, outcome unknown")
  const g = flow({ send: () => ({ error: { code: -32002, message: 'preflight failed' } }) }), s2 = await serveLocalPlayRelay(depart(), 0, { act: g.act });
  try { const [st, v] = await call(s2, '/f/local-play/act/submit', body(INTENTS.Train, signedFor(INTENTS.Train))); assert.deepEqual([st, v.code, typeof v.detail?.signature], [502, 'LocalActSendRefused', 'string']); } finally { await s2.close(); }
  // THE LAUNCHER: the three paths are admitted by its world proxy; the flag reaches the relay ONLY when the launcher's own
  // command line says the one word; any other value refuses the launcher's start; nothing is on by default
  const L = await import('../src/frontier/local-play-launcher.mjs');
  assert.equal(L.ECONOMY_MODE, ECONOMY_MODE);
  for (const p of ['context', 'submit', 'status']) assert.ok(L.WORLD_POST_ROUTES.includes(`/gw/f/local-play/act/${p}`), p);
  const lsrc = readFileSync(new URL('../src/frontier/local-play-launcher.mjs', import.meta.url), 'utf8');
  assert.match(lsrc, /const economyArgs = c\.economy === ECONOMY_MODE \? \['--economy', ECONOMY_MODE\] : \[\];/);
  assert.match(lsrc, /if \(out\.economy !== undefined && out\.economy !== ECONOMY_MODE\) throw fault\('InvalidEconomy'\);/);
  assert.equal([...lsrc.matchAll(/'--economy'/g)].length, 1, 'the flag is written in one place only');
  const need = ['--root', '/abs/root', '--data', '/abs/data', '--runner', '/abs/r', '--herald', '/abs/h', '--depart', '/abs/d', '--preview', '/abs/p', '--resident', '/abs/s', '--artifact', '/abs/a.so', '--artifact-sha', 'ab'.repeat(32)];
  for (const v of ['true', 'yes', 'page-signed', 'all', 'PAGE-SIGNED-V1']) await assert.rejects(L.parseConfig([...need, '--economy', v]), e => e.code === 'InvalidEconomy' || /InvalidEconomy/.test(String(e?.message ?? e)), v);
  await assert.rejects(L.parseConfig([...need, '--economy', 'page-signed-v1', '--economy', 'page-signed-v1']), e => /InvalidArguments/.test(String(e?.code ?? e?.message ?? e)));
});

// (fix-loop5, L5-1) loop-play5: a page that had sent 256 acts in one world was refused for the rest of that world
// (LocalActBusy, shown as "today's quota is used up"; it never came back). The cap now bounds the commands that are still
// UNSETTLED: a full barrier asks the runner whether its records' blockhashes are still valid, and the records whose
// blockhash the runner says is no longer valid retire (the chain itself refuses those bytes for good).
test('L5-1: the barrier bounds UNSETTLED commands only — once their blockhashes expire on the runner the world can send again; it fails closed', async () => {
  const hashOf = i => { const b = new Uint8Array(32); b[0] = 9; new DataView(b.buffer).setUint32(1, i + 1, true); return encode(b); };
  const signedAt = (i, intent = INTENTS.Harvest) => body(intent, wireOf(localActMessage(localActIntent(intent, { wallet: W.address }), pins(), hashOf(i)).message));
  /** A relay whose runner says `valid(hash)` for isBlockhashValid (a boolean, or a whole answer when an object). */
  const relay = valid => {
    const calls = [];
    const act = createLocalPlayAct({ cfg, runnerInstance: INSTANCE, rpc: async (method, params) => {
      calls.push({ method, params });
      if (method === 'getMultipleAccounts') return { result: { context: { slot: 91 }, value: params[0].map(a => (a === CITIZEN_AT ? row(citizenBytes()) : row(holdingBytes()))) } };
      if (method === 'getSignatureStatuses' && params[1]?.searchTransactionHistory && params[0].length === 1 && !calls.some(c => c.method === 'sendTransaction' && Buffer.from(c.params[0], 'base64').subarray(1, 65).equals(Buffer.from(b58d(params[0][0]))))) return { result: { context: { slot: 92, instance: INSTANCE }, value: [null] } };
      if (method === 'getSignatureStatuses') return { result: { context: { slot: 95, instance: INSTANCE }, value: [{ slot: 93, confirmationStatus: 'finalized', err: null }] } };
      if (method === 'sendTransaction') return { result: encode(Buffer.from(params[0], 'base64').subarray(1, 65)) };
      if (method === 'isBlockhashValid') { const v = valid(params[0]); return typeof v === 'boolean' ? { result: { context: { slot: 500, instance: INSTANCE }, value: v } } : v; }
      return { error: { code: -1 } };
    } });
    return { act, calls, sends: () => calls.filter(c => c.method === 'sendTransaction').length, asks: () => calls.filter(c => c.method === 'isBlockhashValid').length };
  };
  // 256 sends fill the barrier; nothing is asked about blockhashes until it is full
  let expired = new Set();
  const g = relay(h => !expired.has(h));
  const first = [];
  for (let i = 0; i < LOCAL_ACT_MAX_HISTORY; i++) first.push((await g.act.submit(signedAt(i))).signature);
  assert.equal(g.sends(), LOCAL_ACT_MAX_HISTORY); assert.equal(g.asks(), 0); assert.deepEqual(g.act.stats(), { history: LOCAL_ACT_MAX_HISTORY });
  // all still valid on the runner: the 257th is refused Busy (nothing sent, not consumed) — the text says "wait", not "today's quota"
  await rejects(g.act.submit(signedAt(300)), 'LocalActBusy'); assert.equal(g.sends(), LOCAL_ACT_MAX_HISTORY); assert.ok(g.asks() > 0);
  // (verify-pr117) a refused submit costs the runner ONE ask while the oldest record is still valid: refusals cannot be
  // turned into a flood of isBlockhashValid calls (64 per refusal before)
  { const a0 = g.asks(); for (let i = 0; i < 20; i++) await rejects(g.act.submit(signedAt(300)), 'LocalActBusy'); assert.equal(g.asks() - a0, 20); }
  // the runner moves on: the first 10 blockhashes are no longer valid → those records retire and the world sends again
  for (let i = 0; i < 10; i++) expired.add(hashOf(i));
  assert.equal((await g.act.submit(signedAt(300))).status, 'submitted'); assert.equal(g.sends(), LOCAL_ACT_MAX_HISTORY + 1);
  assert.equal(g.act.stats().history, LOCAL_ACT_MAX_HISTORY - 10 + 1);
  // a retired signature is still answered by status; a never-sent one still is not
  assert.equal((await g.act.status({ schema: LOCAL_ACT_STATUS_SCHEMA, signature: first[0] })).status, 'finalized');
  await rejects(g.act.status({ schema: LOCAL_ACT_STATUS_SCHEMA, signature: 'never-sent' }), 'LocalActUnknownSignature');
  // retired bytes again: not in the barrier, but the pinned runner knows the signature → MessageUsed, never sent twice
  await rejects(g.act.submit(signedAt(0)), 'LocalActMessageUsed'); assert.equal(g.sends(), LOCAL_ACT_MAX_HISTORY + 1);
  // a live record's bytes again: MessageUsed at once
  await rejects(g.act.submit(signedAt(200)), 'LocalActMessageUsed');
  // 1,000 commands over a world's life (each batch expiring before the next) — no permanent cap
  const h = relay(hash => !expired.has(hash)); expired = new Set();
  for (let i = 0; i < 1000; i++) { if (i >= LOCAL_ACT_MAX_HISTORY) expired.add(hashOf(i - LOCAL_ACT_MAX_HISTORY)); assert.equal((await h.act.submit(signedAt(i))).status, 'submitted', `#${i}`); }
  assert.equal(h.sends(), 1000);
  // FAILS CLOSED: no usable answer from the runner (an error, another instance, no context, no boolean) → nothing retires, Busy
  for (const bad of [{ error: { code: -1 } }, { result: { context: { slot: 5, instance: 'cd'.repeat(32) }, value: false } }, { result: { value: false } }, { result: { context: { slot: 5, instance: INSTANCE }, value: 'no' } }]) {
    const f = relay(() => bad);
    for (let i = 0; i < LOCAL_ACT_MAX_HISTORY; i++) await f.act.submit(signedAt(i));
    await rejects(f.act.submit(signedAt(300)), 'LocalActBusy'); assert.equal(f.sends(), LOCAL_ACT_MAX_HISTORY); assert.equal(f.act.stats().history, LOCAL_ACT_MAX_HISTORY);
  }
});
