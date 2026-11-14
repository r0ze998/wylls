// ⑳ An NFT resident's first village on the page (controller.mjs confirmHome,
// autoTicket, applyMeResult, the viewer-keyed records; hud/drawer.mjs
// joinKind). An NFT Citizen has no in-game key: its owner's wallet signs
// every action as a ResidentAct for the pass's current generation, and
// SetSession is refused for it (NftNoSession). Found in the integration of
// the NFT resident work with the home flow:
//   - the confirm asked the wallet for a key the program refuses to register
//     and never placed the village;
//   - the automatic village request waited for a key that never comes;
//   - the wallet's own key was held against the NFT Citizen (NoSession), so
//     the drawer kept the resident on the "mend the key" card;
//   - the stored home and land records were the wallet's, so two NFTs of one
//     wallet (one Citizen each) shared a chosen site and a pending PlaceHome.
//
// Key-free: literal 32-byte addresses (the NFT, the owner, the proof
// accounts); a wallet stand-in that records its calls and signs nothing
// (fixed bytes back; the flow under test must never ask it to sign a
// message); a relay stand-in; the pinned test world's program addresses are
// public PDAs. Nothing is sent to any chain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const C = await import('../../permutation-server/web/frontier/controller.mjs');
const { FS } = await import('../../permutation-server/web/frontier/fstate.mjs');
const io = await import('../../permutation-server/web/frontier/fchainio.mjs');
const fui = await import('../../permutation-server/web/frontier/fui.mjs');
const wallet = await import('../../permutation-server/web/wallet.mjs');
const { homeKey, loadHome } = await import('../../permutation-server/web/frontier/home.mjs');
const { joinKind } = await import('../../permutation-server/web/frontier/hud/drawer.mjs');
const { NO_TICKET } = await import('../../permutation-server/web/frontier/fland.mjs');
const { ringProvinces, wedgeOf } = await import('../../permutation-server/web/frontier/fgeo.mjs');
const { joinShardOf } = await import('../../permutation-server/web/frontier/faddr.mjs');
const { encode: b58, decode: fromB58 } = await import('../../permutation-server/web/sdk/base58.mjs');
const { decode } = await import('../../permutation-server/web/frontier/fcodec.mjs');
const { encodeAccount } = await import('../../permutation-server/web/sdk/frontier/codec.mjs');
const { fromHex } = await import('../../permutation-server/web/sdk/bytes.mjs');
const { PROGRAM, SEASON_ID } = await import('../screens/world.mjs');

const key = n => b58(new Uint8Array(32).fill(n));
/**
 * The NFT played: the asset and the resident mark the program writes (frontier-abi `resident_citizen::mark`;
 * vectors/v2/resident-citizen.json, case nft), never a wallet Citizen standing in for it.
 */
const RESIDENT = JSON.parse(readFileSync(new URL('../../frontier-abi/vectors/v2/resident-citizen.json', import.meta.url), 'utf8'));
const OWNER = key(0xa1), NFT = RESIDENT.asset, CHAIN = 'solana:localnet';
/** The identity the page plays the NFT as (fresident.identityOf's shape, written in: no address is made here). */
const id = { asset: NFT, citizen: key(0x41), generation: 3, joined: true, proof: { policy: key(0x61), link: key(0x62), asset: NFT, resident: key(0x63) } };
const home = ringProvinces(2)[0], FACTION = wedgeOf(home.p, home.q);
const site = { p: home.p, q: home.q, site: 0, faction: FACTION, gen: 0 };
const province = (p, q) => ({ p, q, siteCount: 2, sites: [5, 14], siteMirror: [{ state: 0, gen: 0 }, { state: 0, gen: 0 }], ticketCohorts: [] });
/** A joined v2 Citizen as the herald client decodes it: no Frontier session (zero), no ticket, no holding; the wallet's, or the NFT's with the program's resident mark over a zero wallet. */
const citizenOf = ({ wallet = null } = {}) => {
  const b = encodeAccount('Citizen', { SEASON_ID: BigInt(SEASON_ID), LAYOUT_VERSION: 2, WALLET: wallet ? fromB58(wallet) : new Uint8Array(32), FACTION, FLAGS: 1, TICKET_BELL: NO_TICKET }, { profile: 2 });
  if (!wallet) b.set(fromHex(RESIDENT.cases.find(c => c.case === 'nft').bytes).subarray(RESIDENT.resident_asset_off), RESIDENT.resident_asset_off);
  return decode('Citizen', b, { seasonId: SEASON_ID });
};
const nftCitizen = () => citizenOf();
const walletCitizen = () => citizenOf({ wallet: OWNER });

/** A Wallet Standard wallet that records its calls and signs nothing (fixed bytes back): the NFT's owner. */
function fakeWallet() {
  const calls = [];
  const account = { address: OWNER, publicKey: new Uint8Array(32).fill(0xa1), chains: [CHAIN], features: ['solana:signTransaction', 'solana:signMessage'] };
  const w = {
    version: '1.0.0', name: 'Owner', icon: '', chains: [CHAIN], accounts: [],
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => { calls.push('connect'); w.accounts = [account]; return { accounts: [account] }; } },
      'standard:events': { version: '1.0.0', on: () => () => {} },
      'solana:signTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0], signTransaction: async (...inputs) => { calls.push('signTransaction'); return inputs.map(i => ({ signedTransaction: i.transaction })); } },
      'solana:signMessage': { version: '1.0.0', signMessage: async (...inputs) => { calls.push('signMessage'); return inputs.map(i => ({ signedMessage: i.message, signature: new Uint8Array(64) })); } },
    },
  };
  return { w, calls };
}

io.setPin({ programId: PROGRAM, cluster: 'localnet', seasonId: SEASON_ID });
const SC = io.scope();

test('an NFT Citizen\'s first village: the confirm sends the PlaceHome as a ResidentAct of the owner\'s wallet, asks for no in-game key, and keeps the chosen site under the NFT', async () => {
  const f = fakeWallet();
  await wallet.connect(f.w, { chain: CHAIN });
  assert.equal(wallet.connected()?.address, OWNER);
  const realFetch = globalThis.fetch;
  io.setRelay('http://relay.test');
  // the relay's answer about the owner's NFTs: the generation the owner signs is read fresh before each send
  globalThis.fetch = async url => (String(url).includes('/f/residents')
    ? { ok: true, status: 200, json: async () => ({ ok: true, residents: [{ asset: NFT, generation: 3, joined: true }], policy: { residentProgram: key(0x44) } }) }
    : { ok: false, status: 404, json: async () => ({}) });
  const sent = [];
  C.useTransport({ submit: async req => { sent.push(req); return { ok: false, code: 'Stop' }; }, track: async () => ({ ok: false, state: 'failed', code: 'Stop' }) });
  C.useHerald({ province: async (p, q) => ({ ok: true, province: province(p, q) }) });
  try {
    Object.assign(FS, {
      season: { layoutVersion: 2, programVersion: 3, conquestParams: { placement: 0, heartlandMaxRing: 3 }, joinGate: new Uint8Array(32) },
      record: { rings: [{}, {}, {}, {}] }, clock: undefined, chain: { now: () => 0 },
      wallet: { address: OWNER }, resident: { ...id }, nfts: null,
      citizen: nftCitizen(), holdings: [], land: { stage: 'joined' }, meStatus: 'ready',
      session: null, sessionProblem: null, delegation: null, agentWallet: false,
      homeChoice: { candidates: [site], selected: site, faction: FACTION, loadedBell: 0, loading: false, error: null, busy: false, pending: null },
      homeGrant: null, provinces: new Map(), notice: null, inFlight: 0, overviews: new Map(), orders: [],
    });
    await C.confirmHome();
    // the PlaceHome left for the relay, for the NFT's Citizen, signed by the owner's wallet at the pass's generation
    assert.equal(sent.length, 1, 'one PlaceHome sent');
    const [req] = sent;
    assert.equal(req.name, 'PlaceHome');
    assert.deepEqual(req.resident, { generation: 3, proof: id.proof }, 'a ResidentAct at the generation the relay answered');
    assert.equal(req.accounts.citizen, id.citizen, 'the resident ID\'s Citizen, not the wallet\'s');
    assert.equal(req.accounts.actor, OWNER);
    assert.equal(req.signer?.wallet?.address, OWNER, 'the owner\'s wallet signs');
    assert.equal(req.accounts.joinshard, io.pinned().addresses.of('JoinShard', { faction: FACTION, shard: joinShardOf(NFT) }), 'the JoinShard of the asset, as JoinResident wrote it');
    assert.deepEqual(req.fields, { p: site.p, q: site.q, site: site.site });
    // no in-game key was asked of the wallet (the program refuses to register one for an NFT Citizen)
    assert.deepEqual(f.calls.filter(c => c !== 'connect'), [], 'the wallet signed nothing: no message, no key');
    assert.equal(FS.session, null, 'no in-game key was made');
    assert.equal(FS.resident.generation, 3);
    // the refusal is the confirm's answer, and the flow is free again
    assert.equal(FS.homeChoice.error?.code, 'Stop');
    assert.equal(FS.homeChoice.busy, false);
    // the chosen site is the NFT's record, not the wallet's (two NFTs of one wallet are two Citizens)
    assert.deepEqual(loadHome(fui.uiStorage, homeKey(SC, NFT)).selected, site);
    assert.equal(loadHome(fui.uiStorage, homeKey(SC, OWNER)).selected, null);
  } finally {
    globalThis.fetch = realFetch;
    io.setRelay('');
    C.useTransport(null);
    C.useHerald(null);
    FS.resident = null;
  }
});

test('the viewer\'s key problem is the wallet Citizen\'s only: an NFT Citizen (a zero session on chain) has none to mend, and the drawer shows it the wait', () => {
  const citizen = nftCitizen();
  assert.equal(b58(citizen.residentAsset), NFT, 'the program\'s NFT Citizen (WALLET zero, the asset marked)');
  Object.assign(FS, { wallet: { address: OWNER }, session: { publicKey: key(0x33), publicKeyBytes: new Uint8Array(32).fill(0x33) }, sessionProblem: null, delegation: null, agentWallet: false, resident: { ...id }, landRec: undefined });
  assert.equal(C.applyMeResult({ ok: true, record: {}, citizen, holdings: [], slots: [] }), 'found');
  assert.equal(FS.sessionProblem, null, 'playing an NFT: the wallet\'s own key is not held against its Citizen');
  assert.equal(FS.land.stage, 'joined');
  assert.equal(joinKind(FS), 'wait', 'the drawer: the wait for the village, not the key card');
  assert.equal(joinKind({ ...FS, session: null }), 'wait', 'with no key at all, the same');
  assert.equal(joinKind({ ...FS, wallet: null }), 'join', 'without the owner\'s wallet nothing can be signed');
  FS.resident = null;
  // as the wallet again, the NFT's Citizen is not its own (refused, not adopted); its own wallet Citizen is
  assert.equal(C.applyMeResult({ ok: true, record: {}, citizen, holdings: [], slots: [] }), 'error');
  assert.equal(FS.meError?.code, 'WrongKey');
  assert.equal(C.applyMeResult({ ok: true, record: {}, citizen: walletCitizen(), holdings: [], slots: [] }), 'found');
  assert.equal(FS.sessionProblem, 'NoSession', 'the wallet\'s own Citizen without a registered key: a key to make');
  assert.equal(joinKind(FS), 'join');
  assert.equal(joinKind({ ...FS, sessionProblem: null }), 'wait');
});

test('the automatic village request of an NFT Citizen does not wait for an in-game key; the wallet\'s Citizen without one still does', async () => {
  let seasonReads = 0;
  C.useHerald({ season: async () => { seasonReads++; return { ok: true, record: { rings: [{}, {}, {}, {}] } }; }, overview: async () => ({ ok: false }), province: async () => ({ ok: false }) });
  C.useTransport({ submit: async () => ({ ok: false, code: 'Unavailable' }) });
  try {
    const base = { season: { programVersion: 1 }, land: { stage: 'joined' }, session: null, sessionProblem: null, citizen: { faction: 0 }, wallet: { address: OWNER }, holdings: [],
      overviews: new Map(), record: { rings: [{}] }, autoTicket: null, autoTicketBusy: false, overviewsBell: undefined, autoProv: undefined, autoFull: undefined, autoForceAt: 0, notice: null, landRec: undefined };
    Object.assign(FS, { ...base, resident: { ...id } });
    await C.autoTicket();
    assert.ok(seasonReads > 0, 'planned: the season record was read');
    assert.equal(FS.autoTicket?.state, 'nofree', 'and the plan ran to its answer (no land in an empty overview)');
    assert.equal(fui.loadLand(fui.uiStorage, fui.landKey(SC, NFT)).autoTryBell, 0, 'this bell\'s attempt is the NFT\'s record');
    assert.equal(fui.loadLand(fui.uiStorage, fui.landKey(SC, OWNER)).autoTryBell, null, 'not the wallet\'s');
    seasonReads = 0;
    Object.assign(FS, { ...base, resident: null });
    await C.autoTicket();
    assert.equal(seasonReads, 0, 'the wallet\'s Citizen without a key: nothing planned');
    assert.equal(FS.autoTicket, null);
  } finally {
    C.useTransport(null);
    C.useHerald(null);
    FS.resident = null;
  }
});

test('the home and land records are the viewer\'s: an NFT\'s own, never its wallet\'s; the wallet path still asks for its key', () => {
  assert.notEqual(homeKey(SC, NFT), homeKey(SC, OWNER));
  assert.notEqual(fui.landKey(SC, NFT), fui.landKey(SC, OWNER));
  const ctl = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
  assert.match(ctl, /const viewerKey = \(\) => FS\.resident\?\.asset \?\? FS\.wallet\?\.address;/);
  assert.match(ctl, /const landKeyNow = \(\) => \(scope\(\) && FS\.wallet\?\.address \? landKey\(scope\(\), viewerKey\(\)\) : null\);/);
  assert.match(ctl, /const homeKeyNow = \(\) => scope\(\) \? homeKey\(scope\(\), viewerKey\(\)\) : null;/);
  // the key step of the confirm and the gate of the automatic request: a wallet Citizen's only
  // Local play (wallet-free test worlds) also skips the session step; the NFT exemption is the same.
  assert.match(ctl, /if \((?:!localPlay && )?!FS\.resident && \(!FS\.session \|\| FS\.sessionProblem\)\) \{\n\s*await ACTIONS\.session\(\); await refresh\(\);\n\s*if \(!FS\.session \|\| FS\.sessionProblem\) return;\n\s*\}/);
  assert.match(ctl, /if \(\(!FS\.resident && \(!FS\.session \|\| FS\.sessionProblem\)\) \|\| !Number\.isInteger\(FS\.citizen\?\.faction\) \|\| FS\.autoTicketBusy\) return;/);
  // an NFT's Citizen is never made by the wallet Join
  assert.match(ctl, /if \(FS\.resident\) \{\n[^\n]*\n[^\n]*\n\s*if \(!await waitForOwn\(\(\) => !!FS\.citizen\)\) return error\('PendingHome'/);
  assert.match(readFileSync(new URL('../../permutation-server/web/frontier/hud/drawer.mjs', import.meta.url), 'utf8'), /if \(!FS\.wallet \|\| \(!FS\.resident && \(!FS\.session \|\| FS\.sessionProblem\)\)\) return 'join';/);
});
