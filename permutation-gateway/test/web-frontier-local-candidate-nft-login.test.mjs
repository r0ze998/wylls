// The REAL controller (controller.mjs) in local play on the LOCAL TEST CANDIDATE lane ([0x4C; 32] / 0xC804; NOT an
// allocation): an NFT's first login (nft-login → JoinResident through the world relay) PINS the wallet, the world, the
// relay, the asset and the viewer at the press and asks them again after every await, inside the send, while it follows
// the outcome and right before the viewer changes. A switch anywhere: no further request that could carry an order, and
// the former viewer is not adopted. A fetch stub plays the world relay; the page's memory-only test wallet signs (a
// KEY-USING test: no key leaves memory). No network, no chain, nothing here is evidence of a transaction.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../../permutation-server/web/frontier/controller.mjs';
import * as io from '../../permutation-server/web/frontier/fchainio.mjs';
import { FS } from '../../permutation-server/web/frontier/fstate.mjs';
import { createEphemeralWallet, currentEphemeralWallet } from '../../permutation-server/web/frontier/fephemeral-wallet.mjs';
import { LOCAL_LANE_PROGRAMS } from '../../permutation-server/web/frontier/flocallanes.mjs';
import { encode } from '../../permutation-server/web/sdk/base58.mjs';

const CAND = LOCAL_LANE_PROGRAMS.conquestNftCandidate;
const RELAY = 'http://127.0.0.1:41987';
const key = n => encode(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? n : (n * 31 + i) & 0xff)));
const ASSET = key(11), CORE = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d', RESIDENT_PROGRAM = key(7), OTHER = key(22);
const POLICY = { coreProgram: CORE, residentProgram: RESIDENT_PROGRAM, collection: key(8), guardAuthority: key(9) };
const HASH = encode(new Uint8Array(32).fill(7));
let ew = null, lp = null, oldFetch = null, posts = [], hooks = {};
const herald = new Proxy({ pin: () => {} }, { get: (t, k) => (k in t ? t[k] : async () => ({ ok: false, code: 'NotFound' })) });
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

before(async () => {
  globalThis.location = { hostname: '127.0.0.1' };
  ew = await createEphemeralWallet({ cluster: 'localnet', hostname: '127.0.0.1', localPlay: true });
  const pin = io.setPin({ programId: CAND, cluster: 'localnet', seasonId: 11 });
  io.setRelay(RELAY);
  lp = { address: ew.address, programId: CAND, seasonAddress: pin.addresses.season, cluster: 'localnet', seasonId: '11', worldEndsAt: Date.now() + 3_600_000 };
  oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname, method = String(init?.method ?? 'GET').toUpperCase();
    if (method !== 'POST') return json({ ok: false, code: 'Unavailable' }, 503);
    const body = JSON.parse(init.body);
    posts.push({ path, body });
    if (path === '/gw/f/local-play/act/residents') { await hooks.residents?.(); return json({ wallet: lp.address, policy: POLICY, residents: [{ asset: ASSET, generation: 0, citizen: key(30), joined: false, link: false }] }); }
    if (path === '/gw/f/local-play/act/context') { const r = json({ wallet: lp.address, blockhash: { hash: HASH, last_valid_block_height: '300', context_slot: '90' } }); await hooks.context?.(); return r; }
    if (path === '/gw/f/local-play/act/submit') { const wire = Buffer.from(body.transaction_b64, 'base64'); return json({ status: 'submitted', name: body.name, signature: encode(wire.subarray(1, 65)), status_route: 'POST /f/local-play/act/status' }); }
    if (path === '/gw/f/local-play/act/status') { await hooks.status?.(); return json({ signature: body.signature, status: 'confirmed', err: null, slot: 93, context_slot: 95 }); }
    return json({ code: 'NotFound' }, 404);
  };
  const oldSetTimeout = globalThis.setTimeout; globalThis.setTimeout = () => 0;
  try { await C.startPlay({ herald, cfg: { localPlay: lp, dev: false, herald: RELAY } }); } finally { globalThis.setTimeout = oldSetTimeout; }
});
after(() => { globalThis.fetch = oldFetch; currentEphemeralWallet()?.destroy?.(); });

function scene() {
  posts = []; hooks = {};
  Object.assign(FS, { mode: 'play', season: { programVersion: 0xc804, layoutVersion: 2, joinGate: [0], rulesetHash: 'f9d4cd2ab7d4b7b80c91fa8f2abb5bd65d6ba1f3be6a0a13e1c4f9aeb6c4c3b1', endBell: 9999, bellSecs: 600 },
    wallet: { address: lp.address }, resident: null, joinDraft: { faction: 2 }, inFlight: 0, notice: null,
    nfts: { residents: [{ asset: ASSET, generation: 0, citizen: key(30), joined: false, link: false }], policy: POLICY, mint: null }, nftsRead: { ok: true, code: null } });
}
const submits = () => posts.filter(p => p.path === '/gw/f/local-play/act/submit');

test('setup: the candidate lane\'s local play is this page (the real local gate is open)', () => {
  scene();
  assert.equal(FS.localPlay, lp); assert.equal(currentEphemeralWallet()?.address, lp.address);
});

test('the first login: ONE JoinResident with the resident schema; once it landed, the NFT is the viewer', async () => {
  scene();
  await C.ACTIONS['nft-login']({ asset: ASSET });
  assert.equal(submits().length, 1);
  const b = submits()[0].body;
  assert.equal(b.schema, 'frontier-local-play-act-submit-resident-v1'); assert.equal(b.name, 'JoinResident');
  assert.deepEqual(b.resident, { asset: ASSET, generation: 0, resident_program: RESIDENT_PROGRAM }); assert.deepEqual(b.fields, { faction: 2 });
  assert.equal(FS.resident?.asset, ASSET); assert.equal(FS.resident?.joined, true);
});

test('the wallet changes while the generation is read: nothing is sent, the viewer is not adopted', async () => {
  scene();
  hooks.residents = () => { FS.wallet = { address: OTHER }; };
  await C.ACTIONS['nft-login']({ asset: ASSET });
  assert.equal(submits().length, 0); assert.equal(FS.resident, null);
});

test('the viewer changes after the context was read: nothing is signed or sent', async () => {
  scene();
  hooks.context = () => { FS.resident = { asset: key(40) }; };
  await C.ACTIONS['nft-login']({ asset: ASSET });
  assert.equal(submits().length, 0); assert.equal(FS.resident?.asset, key(40), 'the other viewer is left as it is');
});

test('the wallet changes while the outcome is followed: the one send stays the only one, and the former viewer is not adopted', async () => {
  scene();
  hooks.status = () => { FS.wallet = { address: OTHER }; };
  await C.ACTIONS['nft-login']({ asset: ASSET });
  assert.equal(submits().length, 1); assert.equal(FS.resident, null);
});
