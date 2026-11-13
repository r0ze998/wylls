// Local play: the explicit Reveal of a departure this page sealed (flocalplay-reveal.mjs), over a stand-in relay whose
// `context` answers from synthetic accounts in the program's own layouts. A KEY-USING test
// (scripts/ci/node-key-tests.txt): the memory-only wallet's non-extractable key is made by WebCrypto in this process
// and signs the page's own Reveal message. No chain, no network. The departure before it is a real local-play run
// (flocalplay-depart.mjs) whose seal keeps a real plaintext, salt, ct_hash and seal root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seasonAddresses, hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { encode, decode as fromB58 } from '../../permutation-server/web/sdk/base58.mjs';
import { encodeAccount } from '../../permutation-server/web/sdk/frontier/codec.mjs';
import { decode } from '../../permutation-server/web/frontier/fcodec.mjs';
import { OUTBOUND_POP, openOutbound, editOutbound, inspectOutboundContext } from '../../permutation-server/web/frontier/fexpedition-compose.mjs';
import * as LD from '../../permutation-server/web/frontier/flocalplay-depart.mjs';
import * as LR from '../../permutation-server/web/frontier/flocalplay-reveal.mjs';
import * as EW from '../../permutation-server/web/frontier/fephemeral-wallet.mjs';
import { revealAddresses, REVEAL_WIRE_LEN } from '../../permutation-server/web/frontier/fexpedition-reveal.mjs';
import { packWidePlain, unpackWidePlain, decodeWideProvinceKey, canonicalWideProvinceKey } from '../../permutation-server/web/frontier/fexpedition-seal.mjs';
import { commitWide } from '../../permutation-server/web/frontier/seal-wide.mjs';
import { ringPosition, worldIdOf } from '../../permutation-server/web/frontier/map/wide.mjs';
import { compileMessage, parseTransaction, COMPUTE_BUDGET_PROGRAM } from '../../permutation-server/web/sdk/solana-tx.mjs';
import { toBase64, fromBase64, toHex, fromHex } from '../../permutation-server/web/sdk/bytes.mjs';
import { sha256 } from '../../permutation-server/web/sdk/sha256.mjs';
import * as hand from '../../permutation-server/web/frontier/hud/hand.mjs';
import { setLang, missingKeys } from '../../permutation-server/web/lang.mjs';

const LOCAL = { cluster: 'localnet', hostname: '127.0.0.1', localPlay: true };
const PROGRAM = encode(new Uint8Array(32).fill(94)), A = seasonAddresses(PROGRAM, '1');
const PIN = { programId: PROGRAM, cluster: 'localnet', seasonId: '1', addresses: A };
const HOST = hostId({ p: 128, q: 0, site: 3, gen: 1, seq: 0 }).toString();
const acct = (kind, values) => decode(kind, encodeAccount(kind, { SEASON_ID: 1n, ...values }));
const SEASON_V1 = Buffer.from(JSON.parse(readFileSync(new URL('fixtures/frontier/season.json', import.meta.url), 'utf8')).bytes_b64, 'base64');
const SEASON = decode('Season', SEASON_V1);
const BLOCKHASH = encode(new Uint8Array(32).fill(7)), RELAY = 'http://127.0.0.1:41966';
const CLOCK = 'SysvarC1ock11111111111111111111111111111111', SYSVAR = 'Sysvar1111111111111111111111111111111111111';
const le = (n, size) => { const b = new Uint8Array(size); new DataView(b.buffer)[size === 8 ? 'setBigUint64' : 'setUint32'](0, size === 8 ? BigInt(n) : n, true); return b; };
const WANT = JSON.parse(readFileSync(new URL('./fixtures/frontier-expedition-depart-prepare-wallet-payer-heap256k-rust.json', import.meta.url), 'utf8'));

// ------------------------------------------------------------------ the departure before it (as web-frontier-local-play-depart.test.mjs)
async function page() {
  EW.destroyEphemeralWallet();
  const signer = await EW.createEphemeralWallet(LOCAL), WALLET = signer.address, OWNER = A.of('Citizen', { wallet: WALLET });
  const h = acct('Holding', { P: 128, Q: 0, SITE: 3, GEN: 1, TILE: 60, STATE: 2, FACTION: 0, TIER: 1, HOST_SEQ: 1, OWNER_CITIZEN: fromB58(OWNER), RESERVE: [400, 0, 0, 0, 0, 0, 100, 0] });
  const province = acct('Province', { P: 128, Q: 0, RESOLVED_NEXT: 42, SITE_COUNT: 1, SITES: Uint8Array.of(60, ...new Array(11).fill(0)), PASSABLE_MASK: (1n << 61n) - 1n,
    SITE_MIRROR: [{ STATE: 1, GEN: 1, FACTION: 0, TIER: 1 }, ...Array.from({ length: 11 }, () => ({ STATE: 0 }))],
    ENTRIES: [{ ID: BigInt(HOST), FACTION: 0, UNIT: 0, TILE: 60, STATE: 1, TROOPS: 600000, STAMINA_VALUE: 120, STAMINA_BELL: 42 }] });
  const fs = { mode: 'play', sample: null, proto: null, season: { ...SEASON, seasonId: 1n, programVersion: 18436, rulesetHash: new Uint8Array(32).fill(1) },
    wallet: { address: WALLET }, resident: null, session: null, meStatus: 'ready', meAnswered: true,
    localPlay: { address: WALLET, programId: PROGRAM, cluster: 'localnet', seasonId: '1', seasonAddress: A.season },
    citizen: acct('Citizen', { WALLET: fromB58(WALLET), FACTION: 0, FLAGS: 5, TICKET_BELL: 0xffffffff, HOLDING: [{ P: 128, Q: 0, SITE: 3, GEN: 1 }, { GEN: 255 }, { GEN: 255 }] }), holdings: [h], activeHolding: 0,
    selected: { kind: 'tile', p: 128, q: 0, idx: 60 }, hand: { host: HOST, pop: OUTBOUND_POP }, nowBell: 42, chain: { now: () => 1000 }, provinces: new Map([['128,0', { province }]]),
    view: { lod: 'tile', fog: true }, land: { stage: 'final' }, marches: [], book: [], orders: [], compose: null };
  const ctx = { pin: PIN, relay: RELAY, source: {} };
  openOutbound(fs, ctx); editOutbound(fs, ctx, 'step', '0'); editOutbound(fs, ctx, 'arriveBell', '44');
  await inspectOutboundContext(fs, { context: () => ctx,
    snapshot: async source => ({ status: 'read', source, lands: [], season: fs.season, holdingBytes: null, clock: { unixTimestamp: 1000n }, contextSlot: '7', digest: 'ab'.repeat(32), coherent: true, contentConsistent: true }),
    judge: () => ({ ok: true, code: null }), evaluate: () => ({ ok: true, code: null, min: 44, max: 47, travelSecs: 120, wearBps: 0, stepIndex: null }) });
  return { fs, ctx, signer, WALLET, OWNER };
}
function prepared(request) {
  const budget = (tag, n, size) => ({ programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: Uint8Array.of(tag, ...le(n, size)) });
  const data = Uint8Array.of(0xda, 0xff, 2, 0, ...fromHex(request.proposal.bytes_hex));
  const instructions = [budget(2, 200000, 4), budget(3, 0, 8), budget(4, 1000000, 4), budget(1, 262144, 4),
    { programId: request.program, keys: request.proposal.roles.map(x => ({ pubkey: x.address, isSigner: x.signer, isWritable: x.writable })), data }];
  const message = compileMessage({ feePayer: request.payer, recentBlockhash: WANT.blockhash.hash, instructions });
  const m = parseTransaction(Uint8Array.of(1, ...new Uint8Array(64), ...message)), n = m.accountKeys.length;
  const report = { ...WANT, request, source: { ...WANT.source, arrive_bell: request.arrive_bell, current_bell: '42' },
    prepared: { program: request.program, season: request.season, program_version: '18436', action: 'Depart', fee_payer: request.payer,
      budget: { cu_limit: 200000, cu_price: '0', loaded_limit: 1000000, heap: 262144 }, roles: request.proposal.roles, instruction_hex: toHex(data),
      message_b64: toBase64(message), message_digest: toHex(sha256(message)), signers: [request.payer],
      shape: { bytes: message.length + 1 + 64, locks: n, writes: n - m.header.numReadonlySignedAccounts - m.header.numReadonlyUnsignedAccounts, sigs: 1 }, proposal_digest: request.proposal.content_digest } };
  return { report, submit: { route: 'POST /f/local-play/depart/submit', schema: 'frontier-local-play-depart-submit-v1', message_digest: report.prepared.message_digest,
    last_valid_block_height: report.blockhash.last_valid_block_height, signer: request.wallet } };
}
const SALT = new Uint8Array(32).fill(0x5a);
/** A seal with the real commitment arithmetic over the draft's own plaintext (the ciphertext itself is a stand-in). */
const realSeal = async req => {
  const plain = packWidePlain(req.plain), seal = new Uint8Array(264).fill(0xa7), commit = commitWide(plain, SALT), ctHash = sha256(seal);
  return { ok: true, seal, commit, ctHash, sealRoot: sha256(commit, ctHash), round: 9, reveal: { plain, salt: SALT } };
};
const allowedOf = p => () => LD.localDepartAllowed({ localPlay: p.fs.localPlay, cluster: 'localnet', hostname: '127.0.0.1', relay: p.ctx.relay, wallet: p.fs.wallet?.address, signer: EW.currentEphemeralWallet() });
/** A page whose departure the (stand-in) chain confirmed: it holds one seal that can be revealed. */
async function departed() {
  const p = await page();
  const post = async (origin, path, body) => {
    if (path === LD.LOCAL_DEPART_PREPARE_PATH) return prepared(body);
    if (path === LD.LOCAL_DEPART_SUBMIT_PATH) return { status: 'submitted', signature: encode(parseTransaction(fromBase64(body.transaction_b64)).signatures[0]), status_route: 'POST /f/local-play/depart/status' };
    return { signature: body.signature, status: 'confirmed', err: null, slot: 70 };
  };
  const s = await LD.runLocalDepart(p.fs, { allowed: allowedOf(p), context: () => p.ctx, sealInput: () => ({ clock: { genesisTs: 1, drand: { genesis: 1, period: 3 } }, drand: { publicKey: 'aa', period: 3, genesis: 1 }, seasonPkHash: 'bb', seasonNetwork: 0, cluster: 'localnet' }),
    seal: realSeal, signer: () => EW.currentEphemeralWallet(), post, changed: () => {}, requestId: 'lp-1' });
  assert.equal(s.status, 'confirmed');
  const record = LR.localRevealCandidate(p.fs);
  assert.ok(record && record.signature === s.signature); assert.equal(LR.localRevealRecordProblem(record), null);
  return { ...p, record };
}

// ------------------------------------------------------------------ the chain's accounts, in the program's layouts
const sortKey = (p, q) => { const r = ringPosition(BigInt(p), BigInt(q)), b = new Uint8Array(17), v = new DataView(b.buffer); v.setBigUint64(0, r.ring, false); b[8] = r.wedge; v.setBigUint64(9, r.pos, false); return b; };
const GENESIS = Number(SEASON.genesisTs), NOW = GENESIS + 600 * 44 + 30, REGION = 5, FACTION = 0, DEP_MASS = 600000;
function seasonBytes({ status = 2, version = 0x4804, ruleset = 1 } = {}) {
  const b = Uint8Array.from(SEASON_V1), v = new DataView(b.buffer);
  v.setUint16(16, 2, true); v.setUint16(138, version, true); b[64] = status; b.fill(ruleset, 104, 136);
  decode('Season', b, { seasonId: '1', profile: 2 });   // (a Season the page's own codec takes as v2)
  return b;
}
const clockBytes = unix => { const b = new Uint8Array(40); new DataView(b.buffer).setBigInt64(32, BigInt(unix), true); return b; };
/** One arrival slot (frontier-abi arrival::wide_arrival_slot, the expedition family). */
function slotBytes(w, i, { host = w.host, citizen = w.p.OWNER, transitSlot = w.record.transitSlot, depMass = DEP_MASS, tile = w.typed.destTile, stance = w.typed.stance, retreatBps = w.typed.retreatBps,
  season = 1n, world = w.dest.world, key = sortKey(w.dest.p, w.dest.q), bell = w.record.arriveBell, faction = FACTION, family = 2 } = {}) {
  const b = new Uint8Array(288), v = new DataView(b.buffer);
  b.set(new TextEncoder().encode('PSFXWASL')); v.setBigUint64(8, season, true); v.setUint16(16, family, true); b[19] = faction; b[20] = i; b[22] = stance; b[23] = tile;
  v.setUint16(24, retreatBps, true); b[28] = transitSlot; v.setUint32(32, bell, true); b.set(fromHex(world), 40); b.set(key, 72); b.set(fromHex(host), 96); b.set(fromB58(citizen), 152); v.setUint32(184, depMass, true);
  return b;
}
/** The world a reveal of `p.record` reads: `set(name | address, bytes | null, owner?)` changes one account, `now` the Clock. */
function chain(p) {
  const record = p.record, typed = unpackWidePlain(record.plain), dest = decodeWideProvinceKey(typed.dest), world = worldIdOf(A.season, PROGRAM);
  const at = revealAddresses({ program: PROGRAM, season: A.season, holding: record.holding, transitSlot: record.transitSlot, faction: FACTION, arriveBell: record.arriveBell, destKey: typed.dest, destRegion: REGION });
  const names = { transit: at.transit, holding: record.holding, dest: at.destProvince, inputs: at.inputs, day: at.arrivalDay, season: A.season, clock: CLOCK, anchor: at.anchor, archive: at.archive, log: at.beaconLog,
    slot0: at.slots[0], slot1: at.slots[1], slot2: at.slots[2], slot3: at.slots[3] };
  const accounts = new Map();
  const w = { p, record, typed, dest, world, host: record.host, names, accounts, posts: [], submits: [], statuses: 0, submit: () => 'submitted', status: () => ({ status: 'confirmed', slot: 88 }), onContext: null };
  w.set = (name, data, owner = PROGRAM) => { const key = names[name] ?? name; if (data === null) accounts.delete(key); else accounts.set(key, { owner, data }); return w; };
  w.now = unix => w.set('clock', clockBytes(unix), SYSVAR);
  // the bridge transit (expedition_transport OwnedBridgeTransit: the 304-byte bridge, then the original owner)
  const t = new Uint8Array(336), tv = new DataView(t.buffer), T = 16;
  t.set(new TextEncoder().encode('PSWLEXP1')); t[8] = 2; t[9] = record.transitSlot; t[T + 1] = 1; t[T + 3] = FACTION; t.set(fromHex(record.host), T + 8);
  t.set(fromHex(canonicalWideProvinceKey({ world, p: '128', q: '0' })), T + 64); t[T + 114] = 60; tv.setUint32(T + 172, record.arriveBell, true); tv.setUint32(T + 184, DEP_MASS, true);
  t.set(record.sealRoot, T + 200); t.set(fromB58(p.OWNER), 304);
  w.transit = t;
  // the village (Holding v2) with its own marker of this departure in the transit slot
  w.holding = (values = {}, marker = {}) => encodeAccount('Holding', { SEASON_ID: 1n, LAYOUT_VERSION: 2, P: 128, Q: 0, SITE: 3, GEN: 1, TILE: 60, STATE: 2, FACTION, HOST_SEQ: 1, OWNER_CITIZEN: fromB58(p.OWNER),
    TRANSIT: Array.from({ length: 4 }, (_, i) => (i === record.transitSlot ? { STATE: 4, FACTION, ORIGIN_TILE: 60, ORIGIN_P: 128, ORIGIN_Q: 0, HOST_ID: BigInt(HOST), ARRIVE_BELL: record.arriveBell, DEP_MASS, SEAL_ROOT: record.sealRoot, ...marker } : { STATE: 0 })), ...values }, { profile: 2 });
  // the destination Province (the wide family: the v2 Province layout, then the wide tail)
  w.province = ({ resolvedNext = 44, region = REGION, ready = 15, seed = 9 } = {}) => {
    const b = new Uint8Array(4864), v = new DataView(b.buffer), tail = 4736;
    b.set(new TextEncoder().encode('PSFXWPV1')); v.setBigUint64(8, 1n, true); v.setUint16(16, 3, true); b[71] = region; v.setUint32(72, resolvedNext, true);
    v.setUint16(tail, 1, true); b[tail + 2] = 1; b[tail + 3] = ready; b.set(fromHex(dest.world), tail + 4); b.set(sortKey(dest.p, dest.q), tail + 36); b.fill(seed, tail + 64, tail + 96);
    return b;
  };
  w.set('transit', t).set('holding', w.holding()).set('dest', w.province()).set('season', seasonBytes()).now(NOW);
  w.post = async (origin, path, body) => {
    w.posts.push({ origin, path, body: JSON.parse(JSON.stringify(body)) });
    if (path === LR.LOCAL_REVEAL_CONTEXT_PATH) {
      if (w.onContext) await w.onContext(w.posts.filter(x => x.path === path).length);
      return { context_slot: '900', blockhash: { hash: BLOCKHASH, last_valid_block_height: '1050', context_slot: '900' },
        accounts: body.addresses.map(address => { const a = accounts.get(address); return a ? { address, owner: a.owner, data_b64: toBase64(a.data) } : { address, owner: null, data_b64: null }; }) };
    }
    if (path === LR.LOCAL_REVEAL_SUBMIT_PATH) {
      const tx = parseTransaction(fromBase64(body.transaction_b64)), signature = encode(tx.signatures[0]);
      w.submits.push({ tx, signature });
      const r = await w.submit(signature);
      return typeof r === 'string' ? { status: r, signature, status_route: 'POST /f/local-play/reveal/status' } : r;
    }
    const r = await w.status(body.signature, ++w.statuses);
    return r && !('signature' in r) ? { signature: body.signature, err: null, slot: null, ...r } : r;
  };
  w.count = path => w.posts.filter(x => x.path === path).length;
  w.deps = (more = {}) => ({ allowed: allowedOf(p), signer: () => EW.currentEphemeralWallet(), budget: () => ({ cuLimit: 400000, loadedLimit: 1000000 }), post: w.post, changed: () => {}, ...more });
  w.check = more => LR.checkLocalReveal(p.fs, w.deps(more));
  w.run = more => LR.runLocalReveal(p.fs, w.deps(more));
  return w;
}
const C = LR.LOCAL_REVEAL_CONTEXT_PATH, S = LR.LOCAL_REVEAL_SUBMIT_PATH, T = LR.LOCAL_REVEAL_STATUS_PATH;
const blockedBy = async (w, code) => { const s = await w.check(); assert.deepEqual([s.status, s.code, s.busy], ['blocked', code, false], code); assert.equal(w.record.revealed, null, code); return s; };

test('check, then the explicit reveal: read at the chain\'s time, the page\'s own message signed by the memory wallet, one submit, the status confirms; "revealed" and no more', async () => {
  const w = chain(await departed()), p = w.p;
  assert.equal(LR.localRevealOf(p.fs).status, 'idle');
  // a reveal is never made without a `ready` check
  assert.equal((await w.run()).status, 'idle'); assert.equal(w.posts.length, 0);
  const ready = await w.check();
  assert.deepEqual([ready.status, ready.targetI, ready.busy, ready.sent], ['ready', 0, false, false], 'before THE anchor exists a reveal may be made (no anchor is not a refusal)');
  assert.equal(w.count(C), 2); assert.equal(w.count(S), 0, 'a check builds, signs and sends nothing');
  const asked = w.posts[1].body.addresses;
  assert.equal(asked.length, 14); for (const n of ['transit', 'holding', 'dest', 'inputs', 'day', 'season', 'clock', 'anchor', 'archive', 'log', 'slot0', 'slot3']) assert.ok(asked.includes(w.names[n]), n);
  const done = await w.run();
  assert.deepEqual([done.status, done.chain, done.slot, done.sent, done.busy], ['revealed', 'confirmed', 88, true, false]);
  assert.deepEqual(w.posts.map(x => x.path), [C, C, C, C, S, T]); assert.ok(w.posts.every(x => x.origin === RELAY));
  // what was sent: budgets, then the 242-byte reveal carrying this seal's plaintext, salt and ct_hash; only the wallet signs; the admission slot is the one writable slot
  const { tx, signature } = w.submits[0], ix = tx.instructions.at(-1), data = Uint8Array.from(ix.data);
  assert.equal(tx.instructions.length, 5);
  assert.equal(tx.instructions[3].programId, COMPUTE_BUDGET_PROGRAM);
  assert.deepEqual([...tx.instructions[3].data], [1, 0, 0, 4, 0]); assert.equal(data.length, REVEAL_WIRE_LEN); assert.deepEqual(tx.signers, [p.WALLET]); assert.equal(signature, done.signature);
  assert.equal(data[8], w.record.transitSlot); assert.equal(data[9], 0); assert.equal(toHex(data.subarray(10, 146)), toHex(w.record.plain)); assert.equal(toHex(data.subarray(146, 178)), toHex(SALT)); assert.equal(toHex(data.subarray(178, 210)), toHex(w.record.ctHash));
  const keys = tx.accountKeys, writable = i => tx.isWritable(i);
  if (typeof tx.isWritable === 'function') assert.deepEqual([0, 1, 2, 3].map(i => writable(keys.indexOf(w.names['slot' + i]))), [true, false, false, false]);
  const key = await crypto.subtle.importKey('raw', fromB58(p.WALLET), 'Ed25519', false, ['verify']);
  assert.equal(await crypto.subtle.verify('Ed25519', key, tx.signatures[0], tx.message), true);
  assert.deepEqual(w.posts[4].body, { schema: 'frontier-local-play-reveal-submit-v1', transaction_b64: w.posts[4].body.transaction_b64 });
  assert.deepEqual(w.posts[5].body, { schema: 'frontier-local-play-reveal-status-v1', signature });
  // the seal is kept and marked; nothing of the plaintext or salt is in the page's state or in any read or status request
  assert.equal(LD.localDepartReveals(p.fs).length, 1); assert.deepEqual(w.record.revealed, { signature, by: 'status', chain: 'confirmed', slot: 88 }); assert.equal(LR.localRevealCandidate(p.fs), null);
  const said = JSON.stringify(done) + JSON.stringify(w.posts.filter(x => x.path !== S));
  assert.ok(!said.includes(toHex(SALT)) && !said.includes(toHex(w.record.plain)));
  // the state claims no arrival, gathering, battle or settlement: only that the reveal is on the chain
  assert.deepEqual(Object.keys(done).sort(), ['arriveBell', 'busy', 'chain', 'code', 'commit', 'error', 'host', 'sent', 'signature', 'slot', 'status', 'targetI', 'transitSlot']);
  // nothing is left to reveal: another check finds no seal and sends nothing
  const again = await w.check(); assert.deepEqual([again.status, again.code], ['blocked', 'RevealSealMissing']); assert.equal(w.count(S), 1);
});

test('readiness is the handler\'s own time rule, at the Clock of the same read: Season, THE anchor\'s window, the beacon round, the archive, the latch', async () => {
  const w = chain(await departed()), bell = w.record.arriveBell;
  const anchor = a => encodeAccount('BellAnchor', { SEASON_ID: 1n, BELL: bell, REGION, A: BigInt(a) });
  const log = (round, region = REGION) => encodeAccount('BeaconLog', { SEASON_ID: 1n, REGION: region, LATEST_ROUND: BigInt(round) });
  const W = SEASON.windowFromBell !== 0xffffffff && bell >= SEASON.windowFromBell ? SEASON.windowNext : SEASON.revealWindow;
  const a = NOW - 10, close = a + W, seed = Math.ceil((close + SEASON.seedMargin - Number(SEASON.drandGenesis)) / Math.max(SEASON.drandPeriod, 1)) + 1;
  // the Clock and the Season
  w.set('clock', null); await blockedBy(w, 'RevealClockMissing');
  w.set('clock', clockBytes(NOW), PROGRAM); await blockedBy(w, 'RevealClockMissing');
  w.now(GENESIS - 1); await blockedBy(w, 'RevealSeasonNotRunning');
  w.now(NOW).set('season', seasonBytes({ status: 6 })); await blockedBy(w, 'RevealSeasonNotRunning');
  w.set('season', seasonBytes(), SYSVAR); await blockedBy(w, 'RevealSeasonMismatch');
  // a v2 Season at the address that is not of the deployment the page verified (program version, ruleset): refused before anything is signed
  w.set('season', seasonBytes({ version: 0x4803 })); await blockedBy(w, 'RevealSeasonVersion');
  w.set('season', seasonBytes({ ruleset: 2 })); await blockedBy(w, 'RevealSeasonRuleset');
  w.set('season', seasonBytes());
  // THE anchor landed: the window is A + W(b), judged at the chain's own time
  w.set('anchor', anchor(a)).set('log', log(seed - 1));
  assert.equal((await w.check()).status, 'ready', 'inside the window, before the seed round');
  w.now(close - 1); assert.equal((await w.check()).status, 'ready');
  w.now(close); await blockedBy(w, 'RevealWindowClosed');
  w.now(NOW).set('log', log(seed)); await blockedBy(w, 'RevealWindowClosed');
  w.set('log', null); await blockedBy(w, 'RevealBeaconLogMissing');
  w.set('log', log(seed - 1, REGION + 1)); await blockedBy(w, 'RevealBeaconLogMissing');
  w.set('log', log(seed - 1)).set('anchor', encodeAccount('BellAnchor', { SEASON_ID: 1n, BELL: bell + 1, REGION, A: BigInt(a) })); await blockedBy(w, 'RevealAnchorMismatch');
  w.set('anchor', encodeAccount('BellAnchor', { SEASON_ID: 2n, BELL: bell, REGION, A: BigInt(a) })); await blockedBy(w, 'RevealAnchorMismatch');
  // no anchor, an archive: only a tombstoned bell is refused
  const archive = bits => { const t = new Uint8Array(9); for (const b of bits) t[(b % 72) >> 3] |= 1 << ((b % 72) & 7); return encodeAccount('AnchorArchive', { SEASON_ID: 1n, REGION, PART: Math.floor(bell / 72), TOMBSTONE: t }); };
  w.set('anchor', null).set('log', null).set('archive', archive([bell + 1]));
  assert.equal((await w.check()).status, 'ready');
  w.set('archive', archive([bell])); await blockedBy(w, 'RevealArchived');
  w.set('archive', encodeAccount('AnchorArchive', { SEASON_ID: 1n, REGION: REGION + 1, PART: Math.floor(bell / 72) })); await blockedBy(w, 'RevealArchiveMismatch');
  w.set('archive', null);
  // the latch: the bell's clash inputs exist, or the destination is resolved past the bell
  w.set('inputs', new Uint8Array(64)); await blockedBy(w, 'RevealLatchClosed');
  w.set('inputs', null).set('dest', w.province({ resolvedNext: bell + 1 })); await blockedBy(w, 'RevealLatchClosed');
  w.set('dest', w.province({ resolvedNext: bell })); assert.equal((await w.check()).status, 'ready', 'resolved up to the bell itself is still open');
  // the destination itself
  w.set('dest', w.province({ ready: 7 })); await blockedBy(w, 'RevealDestinationNotReady');
  w.set('dest', null); await blockedBy(w, 'RevealDestinationNotOpen');
  assert.equal(w.count(S), 0);
});

test('the arrival slots are read as the program reads them; "already revealed" is only this exact departure in a slot', async () => {
  const w = chain(await departed()), p = w.p;
  const other = toHex(Uint8Array.from(fromHex(w.host)).fill(9, 52, 56)), stranger = encode(new Uint8Array(32).fill(33));
  // another host of another Citizen in slot 0: the first free slot is 1
  w.set('slot0', slotBytes(w, 0, { host: other, citizen: stranger }));
  const s = await w.check(); assert.deepEqual([s.status, s.targetI], ['ready', 1]);
  // a slot that is not this Season's, world's, destination's, bell's, nation's or index's is not read as a slot
  for (const [bad, why] of [[{ season: 2n }, 'season'], [{ world: 'cd'.repeat(32) }, 'world'], [{ key: sortKey(w.dest.p + 1n, w.dest.q) }, 'destination'], [{ bell: w.record.arriveBell + 1 }, 'bell'],
    [{ faction: 1 }, 'nation'], [{ family: 3 }, 'family']]) {
    w.set('slot0', slotBytes(w, 0, { host: other, citizen: stranger, ...bad })); await blockedBy(w, 'RevealSlotMismatch'); assert.ok(why);
  }
  w.set('slot0', slotBytes(w, 1, { host: other, citizen: stranger })); await blockedBy(w, 'RevealSlotMismatch');
  w.set('slot0', slotBytes(w, 0, { host: other, citizen: stranger }), SYSVAR); await blockedBy(w, 'RevealSlotMismatch');
  // this Citizen's other host in a slot, or no free slot: the program's ranking, not mirrored: nothing is sent
  w.set('slot0', slotBytes(w, 0, { host: other })); await blockedBy(w, 'RevealAdmissionContested');
  for (let i = 0; i < 4; i++) w.set('slot' + i, slotBytes(w, i, { host: toHex(Uint8Array.from(fromHex(w.host)).fill(10 + i, 52, 56)), citizen: stranger }));
  await blockedBy(w, 'RevealAdmissionContested');
  for (let i = 0; i < 4; i++) w.set('slot' + i, null);
  // this host named in a slot, but not this departure (another Citizen, transit slot, mass, order or family): nothing is concluded
  for (const bad of [{ citizen: stranger }, { transitSlot: (w.record.transitSlot + 1) % 4 }, { depMass: DEP_MASS + 1 }, { tile: (w.typed.destTile + 1) % 61 }, { stance: w.typed.stance ^ 1 }, { retreatBps: w.typed.retreatBps + 1 }, { family: 1 }]) {
    w.set('slot2', slotBytes(w, 2, bad)); await blockedBy(w, 'RevealAdmissionMismatch');
    assert.equal(LR.localRevealCandidate(p.fs), w.record, 'the seal is still to be revealed');
  }
  // exactly this departure: the chain has the reveal; the seal is marked (kept), nothing is sent
  w.set('slot2', slotBytes(w, 2));
  const r = await w.check();
  assert.deepEqual([r.status, r.code, r.sent], ['revealed', 'RevealAlreadyIn', false]); assert.deepEqual(w.record.revealed, { signature: null, by: 'chain' });
  assert.equal(LD.localDepartReveals(p.fs).length, 1); assert.equal(w.count(S), 0); assert.equal(w.count(T), 0);
});

test('the transit and the village are this departure\'s canonical ones: address, issuance, owner, the village\'s own marker', async () => {
  const w = chain(await departed()), stranger = fromB58(encode(new Uint8Array(32).fill(33)));
  for (const [values, marker, code] of [[{ SITE: 4 }, {}, 'RevealHoldingMismatch'], [{ P: 127 }, {}, 'RevealHoldingMismatch'], [{ SEASON_ID: 2n }, {}, 'RevealHoldingMismatch'], [{ LAYOUT_VERSION: 1 }, {}, 'RevealHoldingMismatch'],
    [{ HOST_SEQ: 0 }, {}, 'RevealHoldingIssuance'], [{ OWNER_CITIZEN: stranger }, {}, 'RevealHoldingOwner'],
    [{}, { STATE: 1 }, 'RevealHoldingMarker'], [{}, { HOST_ID: BigInt(HOST) + 1n }, 'RevealHoldingMarker'], [{}, { ARRIVE_BELL: 45 }, 'RevealHoldingMarker'], [{}, { SEAL_ROOT: new Uint8Array(32).fill(1) }, 'RevealHoldingMarker'],
    [{}, { DEP_MASS: 1 }, 'RevealHoldingMarker']]) {
    w.set('holding', w.holding(values, marker)); await blockedBy(w, code);
  }
  w.set('holding', w.holding(), SYSVAR); await blockedBy(w, 'RevealHoldingMissing');
  w.set('holding', null); await blockedBy(w, 'RevealHoldingMissing');
  // a later generation of the village (captured since): the departure keeps its own owner, as the handler has it
  w.set('holding', w.holding({ GEN: 2, OWNER_CITIZEN: stranger })); assert.equal((await w.check()).status, 'ready');
  w.set('holding', w.holding());
  // the transit
  const edit = f => { const t = Uint8Array.from(w.transit); f(t); return t; };
  for (const [f, code] of [[t => { t[304] ^= 1; }, 'RevealTransitOwner'], [t => { t[16 + 200] ^= 1; }, 'RevealSealRootMismatch'], [t => { t[16 + 172] ^= 1; }, 'RevealTransitMismatch'], [t => { t[9] = (t[9] + 1) % 4; }, 'RevealTransitMismatch'],
    [t => { t[8] = 1; }, 'RevealTransitMismatch'], [t => { t[16 + 1] = 0; }, 'RevealTransitFree'], [t => { t[16 + 1] = 3; }, 'RevealHostDestroyedAtOrigin'], [t => { t[16 + 1] = 4; }, 'RevealAlreadyGathered']]) {
    w.set('transit', edit(f)); await blockedBy(w, code);
  }
  w.set('transit', w.transit, SYSVAR); await blockedBy(w, 'RevealTransitForeign');
  w.set('transit', null); await blockedBy(w, 'RevealTransitMissing');
  assert.equal(w.count(S), 0);
});

test('the identity is pinned at the check: another program, Season, wallet or signer afterwards ends the run unsent, whatever the gate says', async () => {
  const yes = () => ({ ok: true, relay: RELAY });
  const other = encode(new Uint8Array(32).fill(77));
  // between the check and the reveal
  for (const change of [fs => { fs.localPlay = { ...fs.localPlay, seasonAddress: other }; }, fs => { fs.localPlay = { ...fs.localPlay, programId: other }; }, fs => { fs.localPlay = { ...fs.localPlay, seasonId: '2' }; },
    fs => { fs.localPlay = { ...fs.localPlay, address: other }; }, fs => { fs.localPlay = null; }]) {
    const w = chain(await departed());
    assert.equal((await w.check({ allowed: yes })).status, 'ready');
    change(w.p.fs);
    const s = await w.run({ allowed: yes });
    assert.deepEqual([s.status, s.error, s.sent], ['error', 'LocalRevealIdentityChanged', false]); assert.equal(w.count(S), 0); assert.equal(w.record.revealed, null);
  }
  // a signer that is not the one pinned (a new memory wallet, even of a gate that says yes)
  { const w = chain(await departed());
    assert.equal((await w.check({ allowed: yes })).status, 'ready');
    const fake = { address: w.p.WALLET, destroyed: false, wallet: w.p.signer.wallet };
    const s = await w.run({ allowed: yes, signer: () => fake });
    assert.deepEqual([s.status, s.error], ['error', 'LocalRevealIdentityChanged']); assert.equal(w.count(S), 0); }
  // while the fresh read is awaited (the third context read is the run's first)
  { const w = chain(await departed());
    assert.equal((await w.check({ allowed: yes })).status, 'ready');
    w.onContext = n => { if (n === 4) w.p.fs.localPlay = { ...w.p.fs.localPlay, seasonAddress: other }; };
    const s = await w.run({ allowed: yes });
    assert.deepEqual([s.status, s.error], ['error', 'LocalRevealIdentityChanged']); assert.equal(w.count(S), 0); }
  // at every gate of the run (before the read, after it, before and after connect, after the signature, in the turn of the POST):
  // an identity that changed is noticed there, and nothing is submitted
  for (let n = 1; n <= 6; n++) {
    const w = chain(await departed());
    assert.equal((await w.check({ allowed: yes })).status, 'ready');
    let calls = 0;
    const s = await w.run({ allowed: () => { if (++calls === n) w.p.fs.localPlay = { ...w.p.fs.localPlay, programId: other }; return yes(); } });
    assert.deepEqual([s.status, s.error, s.sent], ['error', 'LocalRevealIdentityChanged', false], `gate ${n}`); assert.equal(w.count(S), 0, `gate ${n}`); assert.ok(calls >= n, `gate ${n} was reached`);
  }
  // the page's verified deployment itself changing (another program version or ruleset in its Season) is another identity
  for (const [change, after] of [[fs => { fs.season = { ...fs.season, programVersion: 0x4803 }; }, ['error', null, 'LocalRevealDeployment']],
    [fs => { fs.season = { ...fs.season, rulesetHash: new Uint8Array(32).fill(2) }; }, ['blocked', 'RevealSeasonRuleset', null]]]) {
    const w = chain(await departed());
    assert.equal((await w.check({ allowed: yes })).status, 'ready');
    change(w.p.fs);
    const s = await w.run({ allowed: yes }); assert.deepEqual([s.status, s.error], ['error', 'LocalRevealIdentityChanged']); assert.equal(w.count(S), 0);
    const c = await w.check({ allowed: yes }); assert.deepEqual([c.status, c.code, c.error], after, 'and a page of another deployment is never ready against this Season');
  }
  // during the check itself: nothing is said to be ready
  { const w = chain(await departed());
    w.onContext = n => { if (n === 2) w.p.fs.localPlay = { ...w.p.fs.localPlay, seasonAddress: other }; };
    const s = await w.check({ allowed: yes });
    assert.deepEqual([s.status, s.error], ['error', 'LocalRevealIdentityChanged']);
    assert.equal((await w.run({ allowed: yes })).status, 'error'); assert.equal(w.count(S), 0); }
  // a destroyed wallet: the real gate refuses
  { const w = chain(await departed());
    assert.equal((await w.check()).status, 'ready');
    w.p.signer.destroy();
    const s = await w.run(); assert.equal(s.status, 'error'); assert.equal(w.count(S), 0); }
});

test('what was checked is what is revealed; an unknown outcome is asked about by its signature and never signed or sent again; the seal is kept until the chain confirms', async () => {
  // the chain changed between the check and the reveal: another check, nothing signed
  { const w = chain(await departed());
    assert.equal((await w.check()).status, 'ready');
    w.set('slot0', slotBytes(w, 0, { host: toHex(Uint8Array.from(fromHex(w.host)).fill(9, 52, 56)), citizen: encode(new Uint8Array(32).fill(33)) }));
    const s = await w.run(); assert.deepEqual([s.status, s.error], ['error', 'RevealFactsChanged']); assert.equal(w.count(S), 0);
    assert.equal((await w.run()).status, 'error', 'no reveal without a new check'); assert.equal(w.count(C), 4); }
  // the window closed between the check and the reveal
  { const w = chain(await departed());
    assert.equal((await w.check()).status, 'ready');
    w.set('inputs', new Uint8Array(64));
    const s = await w.run(); assert.deepEqual([s.status, s.error], ['error', 'RevealLatchClosed']); assert.equal(w.count(S), 0); }
  // no answer to the submit: unknown
  const w = chain(await departed()), p = w.p;
  assert.equal((await w.check()).status, 'ready');
  w.submit = () => { throw Object.assign(new Error('socket'), { code: 'LocalPlayRpcUnavailable' }); };
  const s = await w.run();
  assert.deepEqual([s.status, s.sent, s.busy, s.error], ['unknown', true, false, 'LocalPlayRpcUnavailable']); assert.equal(typeof s.signature, 'string');
  assert.equal(w.count(S), 1); assert.equal(w.count(T), 0); assert.equal(w.record.revealed, null);
  // not a success, not a failure; nothing can be checked, revealed, or cleared over it
  assert.equal((await w.check()).status, 'unknown'); assert.equal((await w.run()).status, 'unknown'); assert.equal(LR.clearLocalReveal(p.fs), false);
  assert.equal(w.count(S), 1); assert.equal(w.count(C), 4);
  // asked about by its first signature only; pending and an unbelievable answer change nothing
  w.status = () => ({ status: 'pending' });
  let r = await LR.reconcileLocalReveal(p.fs, w.deps()); assert.deepEqual([r.status, r.chain], ['unknown', 'pending']);
  w.status = () => ({ signature: 'x', status: 'confirmed', err: null, slot: 1 });
  r = await LR.reconcileLocalReveal(p.fs, w.deps()); assert.deepEqual([r.status, r.error], ['unknown', 'BadLocalRevealStatus']); assert.equal(w.record.revealed, null);
  w.status = () => { throw Object.assign(new Error('unknown'), { code: 'LocalPlayUnknownSignature', refused: true }); };
  r = await LR.reconcileLocalReveal(p.fs, w.deps()); assert.deepEqual([r.status, r.error], ['unknown', 'LocalPlayUnknownSignature'], 'a relay that does not know the signature proves nothing');
  // another identity's answer is not asked for
  const live = p.fs.localPlay; p.fs.localPlay = { ...live, seasonAddress: encode(new Uint8Array(32).fill(77)) };
  r = await LR.reconcileLocalReveal(p.fs, w.deps({ allowed: () => ({ ok: true, relay: RELAY }) })); assert.deepEqual([r.status, r.error], ['unknown', 'LocalRevealIdentityChanged']);
  p.fs.localPlay = live;
  assert.equal(w.count(S), 1); assert.ok(w.posts.filter(x => x.path === T).every(x => x.body.signature === s.signature));
  assert.equal(LR.localRevealCandidate(p.fs), w.record, 'the seal is held while the outcome is not known');
  // the chain's own failure is a failure (the seal is kept: a new check may follow); confirmed is revealed
  w.status = () => ({ status: 'failed', err: { InstructionError: [3, { Custom: 6001 }] }, slot: 91 });
  r = await LR.reconcileLocalReveal(p.fs, w.deps()); assert.deepEqual([r.status, r.chain, r.slot], ['failed', 'failed', 91]); assert.match(r.code, /Custom/);
  assert.equal(w.record.revealed, null); assert.equal(LR.localRevealCandidate(p.fs), w.record);
  assert.equal(LR.clearLocalReveal(p.fs), true);
  w.submit = () => 'unknown'; w.status = (sig, n) => ({ status: n < 6 ? 'processed' : 'finalized', slot: 95 });
  assert.equal((await w.check()).status, 'ready');
  r = await w.run(); assert.deepEqual([r.status, r.chain], ['unknown', 'processed']); assert.equal(w.count(S), 2, 'a new check and a new explicit reveal after a failure the chain itself reported');
  r = await LR.reconcileLocalReveal(p.fs, w.deps()); assert.deepEqual([r.status, r.chain, r.slot], ['revealed', 'finalized', 95]);
  assert.equal(w.record.revealed.signature, r.signature); assert.equal(LD.localDepartReveals(p.fs).length, 1); assert.equal(w.count(S), 2);
});

test('the relay\'s context answer is believed in nothing: exact shape, the asked addresses in order, canonical base64; the post is one bounded loopback POST', async () => {
  const a = [encode(new Uint8Array(32).fill(1)), encode(new Uint8Array(32).fill(2))];
  const good = { context_slot: '5', blockhash: { hash: BLOCKHASH, last_valid_block_height: '9', context_slot: '5' }, accounts: [{ address: a[0], owner: PROGRAM, data_b64: 'AQI=' }, { address: a[1], owner: null, data_b64: null }] };
  const ctx = LR.localRevealContext(good, a);
  assert.deepEqual([...ctx.accounts.get(a[0]).data], [1, 2]); assert.equal(ctx.accounts.get(a[1]), null); assert.equal(ctx.blockhash, BLOCKHASH);
  for (const bad of [{ ...good, extra: 1 }, { ...good, context_slot: 5 }, { ...good, blockhash: { ...good.blockhash, context_slot: '4' } }, { ...good, accounts: [good.accounts[1], good.accounts[0]] }, { ...good, accounts: [good.accounts[0]] },
    { ...good, accounts: [{ ...good.accounts[0], data_b64: 'AQI' }, good.accounts[1]] }, { ...good, accounts: [good.accounts[0], { address: a[1], owner: null, data_b64: 'AQI=' }] }, { ...good, accounts: [{ ...good.accounts[0], owner: 'x' }, good.accounts[1]] }]) {
    assert.throws(() => LR.localRevealContext(bad, a), { code: 'BadLocalRevealContext' });
  }
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, init }); return { ok: true, text: async () => '{"ok":1}' }; };
  assert.deepEqual(await LR.postLocalReveal(RELAY, C, { schema: 'x' }, { fetch }), { ok: 1 });
  assert.equal(calls[0].url, RELAY + C); assert.equal(calls[0].init.method, 'POST'); assert.equal(calls[0].init.credentials, 'omit'); assert.equal(calls[0].init.redirect, 'error');
  await assert.rejects(LR.postLocalReveal('https://relay.example', C, {}, { fetch }), { code: 'LocalRevealRelay' });
  await assert.rejects(LR.postLocalReveal(RELAY, '/gw/f/local-play/depart/submit', {}, { fetch }), { code: 'LocalRevealRelay' });
  await assert.rejects(LR.postLocalReveal(RELAY, S, {}, { fetch: async () => ({ ok: false, text: async () => '{"code":"LocalPlayNotReveal"}' }) }), { code: 'LocalPlayNotReveal', refused: true });
  assert.equal(calls.length, 1);
});

test('the strip: only in local play and only with a seal to open; two separate presses; every outcome in its own words, and "recorded" claims no arrival, battle or return', async () => {
  const w = chain(await departed()), p = w.p, strip = () => String(hand.localRevealStrip(p.fs));
  const CHECK = /data-act="local-reveal-check"/, SEND = /data-act="local-reveal-send"/, ASK = /data-act="local-reveal-reconcile"/;
  setLang('ja');
  try {
    // the ordinary page: nothing at all
    const identity = p.fs.localPlay; p.fs.localPlay = null; assert.equal(strip(), ''); p.fs.localPlay = identity;
    // a seal to open, nothing asked yet: the check only; no reveal button before a ready check
    let c = strip(); assert.match(c, CHECK); assert.doesNotMatch(c, SEND); assert.match(c, /到着ターン 44/);
    // the card the departure was sent from carries the same strip
    assert.ok(String(hand.renderPop(p.fs, hand.handModel(p.fs))).includes('outbound-local-reveal'));
    // blocked: its reason, nothing sent, the check again; never the reveal button
    w.set('inputs', new Uint8Array(64)); await w.check();
    c = strip(); assert.match(c, /受付をすでに締め切っています/); assert.match(c, /RevealLatchClosed/); assert.match(c, /何も送っていません/); assert.match(c, CHECK); assert.doesNotMatch(c, SEND);
    w.set('inputs', null);
    // ready: the explicit press, with what it makes public
    await w.check(); c = strip(); assert.match(c, SEND); assert.match(c, /到着先の枠 0/); assert.match(c, /公開されます/); assert.doesNotMatch(c, /記録されました/);
    // unknown: said as unknown, the look-up only
    w.submit = () => { throw new Error('reset'); };
    let s = await w.run(); assert.equal(s.status, 'unknown');
    c = strip(); assert.match(c, /封が開かれたかどうかは不明です/); assert.match(c, /もう一度送らずに/); assert.match(c, ASK); assert.doesNotMatch(c, SEND); assert.doesNotMatch(c, CHECK); assert.doesNotMatch(c, /記録されました/);
    assert.ok(c.includes(`${s.signature.slice(0, 8)}…`));
    // failed: the chain's own error; the seal is still held; a new check may follow
    w.status = () => ({ status: 'failed', err: { InstructionError: [3, { Custom: 6001 }] }, slot: 4 });
    s = await LR.reconcileLocalReveal(p.fs, w.deps()); assert.equal(s.status, 'failed');
    c = strip(); assert.match(c, /失敗しました/); assert.match(c, /Custom/); assert.match(c, /封はこのページに残っています/); assert.match(c, CHECK); assert.doesNotMatch(c, /記録されました/);
    // submitted, not yet confirmed
    w.submit = () => 'submitted'; w.status = () => ({ status: 'pending' });
    await w.check(); s = await w.run(); assert.equal(s.status, 'submitted');
    c = strip(); assert.match(c, /まだ確認できていません/); assert.match(c, ASK); assert.doesNotMatch(c, /記録されました/);
    // confirmed: recorded, waiting for the destination; nothing about a battle won, an arrival made or a return
    w.status = () => ({ status: 'confirmed', slot: 9 });
    s = await LR.reconcileLocalReveal(p.fs, w.deps()); assert.equal(s.status, 'revealed');
    c = strip(); assert.match(c, /封を開いたことが記録されました/); assert.match(c, /到着先での決着を待っています/); assert.match(c, /まだ決まっていません/);
    assert.doesNotMatch(c, /到着しました|勝ち|勝利|占領|帰還しました|決着しました/); assert.doesNotMatch(c, SEND); assert.doesNotMatch(c, CHECK);
    // nothing of the seal's contents is ever in the markup
    assert.ok(!c.includes(toHex(SALT)) && !c.includes(toHex(w.record.plain)));
    // English: every string has its translation
    setLang('en'); c = strip();
    assert.match(c, /The opening of the seal is recorded \(arrival turn 44\)\. Waiting for the destination to decide it\./);
    assert.deepEqual(missingKeys().filter(k => /封|ローカルプレイ|照合|署名|到着先|確認し直す|確かめて/.test(k)), []);
  } finally { setLang('ja'); EW.destroyEphemeralWallet(); }
});

test('the wiring: four actions to the controller\'s reveal entry points under the departure\'s own gate; no other send is opened', () => {
  const read = file => readFileSync(new URL(`../../permutation-server/web/frontier/${file}`, import.meta.url), 'utf8');
  const app = read('app.mjs'), ctl = read('controller.mjs'), mod = read('flocalplay-reveal.mjs');
  for (const [act, fn] of [['local-reveal-check', 'checkLocalPlayReveal'], ['local-reveal-send', 'sendLocalPlayReveal'], ['local-reveal-reconcile', 'reconcileLocalPlayReveal']]) assert.ok(app.includes(`'${act}': () => ${fn}(),`), act);
  assert.ok(app.includes("'local-reveal-clear': () => { clearLocalPlayReveal(); },"));
  assert.match(app, /import \{[^}]*\bcheckLocalPlayReveal, sendLocalPlayReveal, reconcileLocalPlayReveal, clearLocalPlayReveal\b[^}]*\} from '\.\/controller\.mjs';/);
  assert.match(app, /const strip = FS\.localPlay && FS\.hand\?\.pop !== OUTBOUND_POP \? hand\.localRevealStrip\(FS\) : ''/, 'the standalone strip exists only in local play');
  // the controller: the departure's gate, the live memory wallet, fixed isolated-SBF budgets; nothing else
  assert.ok(ctl.includes("const localRevealDeps = () => ({ allowed: localDepartGate, signer: currentEphemeralWallet, changed: localDepartChanged,\n  budget: () => localReveal.LOCAL_REVEAL_BUDGET });"));
  assert.deepEqual(LR.LOCAL_REVEAL_BUDGET, { cuLimit: 1_400_000, loadedLimit: 64 * 1024 * 1024 });
  assert.ok(Object.isFrozen(LR.LOCAL_REVEAL_BUDGET));
  const from = ctl.indexOf('const localRevealDeps'), block = ctl.slice(from, ctl.indexOf('export const clearLocalPlayReveal', from));
  for (const banned of ['fsession', 'FS.session', 'submit(', 'sendMarch', 'act(', 'faucet', 'storage']) assert.ok(!block.includes(banned), banned);
  // (2026-11-12, the economy path: of the three general refusals, two are unconditional as they were; the one in `act`
  //  now lets through exactly the six economy commands in their plain form, to their own page-signed path)
  assert.equal([...ctl.matchAll(/if \(localPlay\) return (failed|early)\(localPlayReadOnly\(\)\)/g)].length, 1, 'the one unconditional refusal of local play is as it was'); assert.equal(ctl.split('if (localPlay && FS.localMarch?.open !== true) return failed(localPlayReadOnly());').length - 1, 1, '(2026-11-13, march lane) the march\'s refusal: unless its own answer is open');
  assert.equal(ctl.split("const route = localAct.localOrderRoute({ localPlay, name, v, signer, requester });\n  if (route === 'refuse') return early(localPlayReadOnly());").length - 1, 1, 'the order path refuses everything but the six economy commands (behaviour: web-frontier-local-play-act.test.mjs)');
  // the module itself: memory only, no log, no storage, no timer that reveals by itself
  for (const banned of ['localStorage', 'sessionStorage', 'indexedDB', 'console.', 'setInterval', 'document.cookie']) assert.ok(!mod.includes(banned), banned);
});
