// Key-free model of the wide-economy browser fixture (first half: data + checks, no UI).
//
// The five committed cases (frontier-node/crates/verify/tests/fixtures/wide_economy/*) are HOST DISPATCH RECORDINGS:
// each is one Harvest / Build / Train run on the host with the stock reset by hand between cases. They are not a live
// simulator and nothing here continues, projects or re-computes an economy. Every amount stays an exact string of
// the stored milli-units; before/after differences are reported as the raw before/after strings, never subtracted.
//
// Public bytes only: PDA / with-seed derivation, decoding, structural checks. No key, signature, transaction, RPC or
// wallet appears here. The receipt decoder is STRUCTURAL: it does not verify digests, authorization, replay or chain.
//
// The imports are relative on purpose: Node tests import this file directly, and the fixture server mirrors the same
// repo paths so the browser resolves the same specifiers to the same files.
import { decode } from '../../../permutation-server/web/frontier/fcodec.mjs';
import { seasonAddresses } from '../../../permutation-server/web/frontier/faddr.mjs';
import {
  adoptWide, selectWide, selectedWide, citizenBindings, decodeWideHoldingBytes, coordOfSortKey, sortKeyOf,
  wideHoldingAddress, WIDE_HOLDING_SIZE, FIRST_WIDE_RING, WideError,
} from '../../../permutation-server/web/frontier/fwide.mjs';
import { worldIdOf, ringPosition, WORLD_DOMAIN } from '../../../permutation-server/web/frontier/map/wide.mjs';
import { encode as toB58, decode as fromB58 } from '../../../permutation-server/web/sdk/base58.mjs';
import { toBase64, toHex } from '../../../permutation-server/web/sdk/bytes.mjs';
import { sha256 } from '../../../permutation-server/web/sdk/sha256.mjs';
// Static SHA-256 pins of the 40 original files, written once by make-manifest.mjs (never by this module or the browser).
import { MANIFEST } from './manifest.mjs';

// ------------------------------------------------------------------ pins (literals of map_growth_runtime_tests.rs:133-143)
const fill = n => new Uint8Array(32).fill(n);
export const PROGRAM = fill(0x12);
export const WALLET_A = fill(0xa1);
export const SEASON_ID = 11n;
export const PROGRAM_B58 = toB58(PROGRAM);
export const WALLET_A_B58 = toB58(WALLET_A);

export const SEASON_SIZE = 2048;
export const CITIZEN_SIZE = 384;
export const RECEIPT_ORDINARY_SIZE = 184;
export const RECEIPT_MIRROR_SIZE = 225;
export const KIND_ECONOMY = 15;
export const KIND_ECONOMY_MIRROR = 16;
export const INSTRUCTION_PREFIX_HEX = 'daff0103';

/** Repo-relative directory of the committed binaries, and the route the fixture server serves them under. */
export const FIXTURE_DIR = 'frontier-node/crates/verify/tests/fixtures/wide_economy';
export const CASE_NAMES = Object.freeze(['harvest', 'building', 'wall', 'tier', 'train']);
export const FILE_NAMES = Object.freeze(['season.bin', 'citizen_pre.bin', 'holding_pre.bin', 'province_pre.bin',
  'citizen_post.bin', 'holding_post.bin', 'province_post.bin', 'record.bin']);
export const fixtureRoute = (name, file) => `/${FIXTURE_DIR}/${name}/${file}`;
/** `files` object key → original file name (the same eight, in the order of FILE_NAMES). */
export const FILE_KEYS = Object.freeze({
  season: 'season.bin', citizenPre: 'citizen_pre.bin', holdingPre: 'holding_pre.bin', provincePre: 'province_pre.bin',
  citizenPost: 'citizen_post.bin', holdingPost: 'holding_post.bin', provincePost: 'province_post.bin', record: 'record.bin',
});

export const PIN_NOTE = Object.freeze({
  en: 'SHA-256 pins identify which checked-in fixture files these are, so a stale or swapped file of the same identity is refused. They are not chain provenance, not a replay, and not a proof that the host run was honest.',
  ja: 'SHA-256 ピンは、どのチェックイン済みフィクスチャファイルかを識別し、同じ識別の古い・差し替えファイルを拒否するためのものです。チェーン上の出どころでも、リプレイでも、ホスト実行が正直だった証明でもありません。',
});

/** What each original case must record (receipt action, structurally). */
export const EXPECTED = Object.freeze({
  harvest: Object.freeze({ kind: 'Harvest' }),
  building: Object.freeze({ kind: 'Build', item: 0 }),
  wall: Object.freeze({ kind: 'Build', item: 6 }),
  tier: Object.freeze({ kind: 'Build', item: 7 }),
  train: Object.freeze({ kind: 'Train', unit: 0, n: 10 }),
});

export const SYNTHETIC_CAPTURE = Object.freeze({
  slot: '0', archiveSequence: '0',
  note: Object.freeze({
    en: 'Slot 0 / archive 0 are synthetic adapter metadata so the real parser accepts the bytes. They are not a chain slot, not an archive position, and say nothing about when these bytes were true.',
    ja: 'スロット0・アーカイブ0は、実パーサがバイト列を受け付けるための合成アダプタ値です。チェーンのスロットでもアーカイブ位置でもなく、これらのバイトがいつの状態かを示しません。',
  }),
});

export const PROVENANCE = Object.freeze({
  en: 'Five original host dispatch recordings with the stock reset by hand between cases. Not a live simulator; nothing is projected or executed. Captured, unverified: digests, authorization, replay and chain state are not checked here.',
  ja: '元の5件はホストのディスパッチ記録で、ケース間で在庫を手動リセットしています。ライブのシミュレータではなく、予測も実行もしません。捕捉のみ・未検証：ダイジェスト・認可・リプレイ・チェーン状態はここでは確認しません。',
});

export class ModelError extends Error {
  constructor(code, message) { super(message ?? code); this.code = code; }
}
const check = (cond, code, msg) => { if (!cond) throw new ModelError(code, msg ?? code); };
const asBytes = (b, code, what) => {
  check(b instanceof Uint8Array, code, `${what}: bytes expected`);
  return b;
};
const zero = (b, from, to) => { for (let i = from; i < to; i++) if (b[i] !== 0) return false; return true; };

// ------------------------------------------------------------------ receipt (structural only)
function decodeAction(a) {
  const tag = a[0];
  if (tag === 0) {
    check(zero(a, 1, 6), 'BadAction', 'Harvest padding');
    return { kind: 'Harvest' };
  }
  if (tag === 1) {
    check(a[1] <= 8, 'BadAction', 'Build item');
    check(zero(a, 2, 6), 'BadAction', 'Build padding');
    return { kind: 'Build', item: a[1] };
  }
  if (tag === 2) {
    check(a[1] <= 6, 'BadAction', 'Train unit');
    const n = new DataView(a.buffer, a.byteOffset, 6).getUint32(2, true);
    check(n > 0, 'BadAction', 'Train count');
    return { kind: 'Train', unit: a[1], n };
  }
  throw new ModelError('BadAction', `action tag ${tag}`);
}

/**
 * Structural decode of record.bin (Economy 184 B / EconomyMirror 225 B). Not a proof of anything: digests, auth and
 * replay are neither recomputed nor checked. Returns plain metadata (BigInts as decimal strings, hashes as hex).
 */
export function decodeReceipt(bytes) {
  const b = asBytes(bytes, 'BadReceipt', 'receipt');
  check(b.length === RECEIPT_ORDINARY_SIZE || b.length === RECEIPT_MIRROR_SIZE, 'BadReceipt', `size ${b.length}`);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  check(b[0] === 0x82, 'BadReceipt', 'version');
  const kind = b[1];
  check((kind === KIND_ECONOMY && b.length === RECEIPT_ORDINARY_SIZE) || (kind === KIND_ECONOMY_MIRROR && b.length === RECEIPT_MIRROR_SIZE), 'BadReceipt', 'kind does not match size');
  check(b[6] === 1, 'BadReceipt', 'holding key version');
  check(dv.getUint32(58, true) === 0, 'BadReceipt', 'key sequence');
  let coord;
  try { coord = coordOfSortKey(b.slice(39, 56)); } catch (e) { throw new ModelError('BadReceipt', e instanceof WideError ? e.message : 'sort key'); }
  const key = Object.freeze({
    world: toHex(b.subarray(7, 39)), sortKey: toHex(b.subarray(39, 56)), p: coord.p, q: coord.q, site: b[56], generation: b[57], seq: 0,
  });
  // the holding key as the program's own record checks it: a real wide ring, site < 12, generation 1..254, a non-reserved world
  check(ringPosition(coord.p, coord.q).ring >= FIRST_WIDE_RING, 'BadReceipt', 'key inside the legacy disk');
  check(key.site < 12, 'BadReceipt', 'key site');
  check(key.generation >= 1 && key.generation <= 254, 'BadReceipt', 'key generation');
  check(key.world !== '0'.repeat(64), 'BadReceipt', 'key world is the reserved zero world');
  check(b[62] === 1, 'BadReceipt', 'receipt version');
  const action = b.slice(63, 69);
  const finalByte = b[77];
  check(finalByte === 0 || finalByte === 1, 'BadReceipt', 'final flag');
  const decoded = decodeAction(action);
  // only the two Build items that touch the province (6 and 7) are mirror receipts; every other action is the ordinary kind
  const mirrors = decoded.kind === 'Build' && (decoded.item === 6 || decoded.item === 7);
  check(mirrors === (kind === KIND_ECONOMY_MIRROR), 'BadReceipt', 'the action does not agree with the receipt kind');
  const linkCount = b[142];
  const expectedEntities = kind === KIND_ECONOMY ? [2] : [1, 2];
  check(linkCount === expectedEntities.length && b.length === 143 + 41 * linkCount, 'BadReceipt', 'link count');
  const links = expectedEntities.map((entity, i) => {
    const o = 143 + 41 * i;
    check(b[o] === entity, 'BadReceipt', 'link order');
    return Object.freeze({ entity, seq: String(dv.getBigUint64(o + 1, true)), head: toHex(b.subarray(o + 9, o + 41)) });
  });
  const actionHex = toHex(action);
  return Object.freeze({
    structuralOnly: true, size: b.length, version: b[0], kind, kindName: kind === KIND_ECONOMY ? 'Economy' : 'EconomyMirror',
    bell: dv.getUint32(2, true), key,
    receipt: Object.freeze({
      version: b[62], actionHex, action: Object.freeze(decoded), now: String(dv.getBigInt64(69, true)), final: finalByte === 1,
      input: toHex(b.subarray(78, 110)), output: toHex(b.subarray(110, 142)),
    }),
    links: Object.freeze(links),
    // unsigned instruction DATA only; no accounts, no transaction, nothing built or sent
    instructionDataHex: INSTRUCTION_PREFIX_HEX + actionHex,
  });
}

// ------------------------------------------------------------------ province (frontier-abi world_index/land.rs `WideProvince::read`)
/** Offsets of the wide province: the 4,736 B Province v2 prefix + the 128 B trailer (land.rs `province`, PV2, `header`). */
export const PROVINCE = Object.freeze({
  SIZE: 4864, MAGIC: 'PSFXWPV1', LAYOUT_VERSION: 3, FAMILY_VERSION: 1, STATUS_OPENED: 1, READINESS_REQUIRED: 15,
  AT: Object.freeze({
    SEASON_ID: 8, LAYOUT_VERSION: 16, P: 64, Q: 66, RING: 68, WEDGE: 70, REGION: 71, OPENED_BELL: 76,
    FAMILY_VERSION: 4736, STATUS: 4738, READINESS: 4739, WORLD: 4740, SORT_KEY: 4772, RSV_53: 4789, RING_SEED: 4800, RSV: 4840, RSV_LEN: 24,
  }),
});

/**
 * The wide province's identity, structurally, as `WideProvince::read` requires it: exactly 4,864 B, the wide magic, layout
 * version 3, family version 1, status opened, a complete readiness mask, zero reserved trailer bytes, a zero legacy P/Q/RING
 * prefix, a canonical sort key past the legacy disk with the prefix wedge equal to its wedge, a non-zero world and ring seed.
 * Returns identity metadata only: this is neither a proof of the province's game state nor of the chain.
 */
function provinceMeta(bytes, phase) {
  const b = asBytes(bytes, 'BadProvince', `${phase} province`);
  const A = PROVINCE.AT;
  check(b.length === PROVINCE.SIZE, 'BadProvince', `${phase}: ${b.length} B is not a wide province (${PROVINCE.SIZE})`);
  check(String.fromCharCode(...b.subarray(0, 8)) === PROVINCE.MAGIC, 'BadProvince', `${phase}: magic`);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  check(dv.getUint16(A.LAYOUT_VERSION, true) === PROVINCE.LAYOUT_VERSION, 'BadProvince', `${phase}: layout version`);
  check(dv.getUint16(A.FAMILY_VERSION, true) === PROVINCE.FAMILY_VERSION, 'BadProvince', `${phase}: family version`);
  check(b[A.STATUS] === PROVINCE.STATUS_OPENED, 'BadProvince', `${phase}: status`);
  check(b[A.READINESS] === PROVINCE.READINESS_REQUIRED, 'BadProvince', `${phase}: readiness`);
  check(zero(b, A.RSV_53, A.RSV_53 + 3) && zero(b, A.RSV, A.RSV + A.RSV_LEN), 'BadProvince', `${phase}: reserved bytes`);
  check(dv.getInt16(A.P, true) === 0 && dv.getInt16(A.Q, true) === 0 && dv.getUint16(A.RING, true) === 0, 'BadProvince', `${phase}: a legacy identity in the prefix`);
  let coord;
  try { coord = coordOfSortKey(b.slice(A.SORT_KEY, A.SORT_KEY + 17)); } catch (e) { throw new ModelError('BadProvince', `${phase}: ${e instanceof WideError ? e.message : 'sort key'}`); }
  const rp = ringPosition(coord.p, coord.q);
  check(rp.ring >= FIRST_WIDE_RING, 'BadProvince', `${phase}: inside the legacy disk`);
  check(b[A.WEDGE] === rp.wedge, 'BadProvince', `${phase}: wedge`);
  check(!zero(b, A.RING_SEED, A.RING_SEED + 32), 'BadProvince', `${phase}: zero ring seed`);
  const world = toHex(b.subarray(A.WORLD, A.WORLD + 32));
  check(world !== '0'.repeat(64), 'BadProvince', `${phase}: the reserved zero world`);
  return Object.freeze({
    structuralOnly: true, size: b.length, magic: PROVINCE.MAGIC, layoutVersion: PROVINCE.LAYOUT_VERSION, familyVersion: PROVINCE.FAMILY_VERSION,
    season: String(dv.getBigUint64(A.SEASON_ID, true)), world, sortKey: toHex(b.subarray(A.SORT_KEY, A.SORT_KEY + 17)),
    p: String(coord.p), q: String(coord.q), ring: String(rp.ring), wedge: rp.wedge, region: b[A.REGION], openedBell: dv.getUint32(A.OPENED_BELL, true),
  });
}

// ------------------------------------------------------------------ raw string differences
const plain = v => {
  if (typeof v === 'bigint' || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return String(v);
  return JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? String(x) : x));
};
const plainFields = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, plain(v)]));
const changedKeys = (a, b) => Object.keys(a).filter(k => a[k] !== b[k]);

const SCALARS = ['tier', 'walls', 'state', 'flags', 'faction', 'order', 'foundedTs', 'lastOwnerAction', 'shieldUntil', 'finalTs', 'foodShortfall', 'escrow', 'wallsCommittedBefore'];

/** Exact before/after strings of the economy (stores, queue, reserve, tier, walls, metadata). No arithmetic. */
export function economyDiff(before, after) {
  const scalars = {};
  for (const k of SCALARS) scalars[k] = Object.freeze({ before: plain(before[k]), after: plain(after[k]), changed: plain(before[k]) !== plain(after[k]) });
  const stores = before.stores.map((s, i) => {
    const b = plainFields(s), a = plainFields(after.stores[i]);
    return Object.freeze({ resource: s.resource, before: Object.freeze(b), after: Object.freeze(a), changedFields: Object.freeze(changedKeys(b, a)) });
  });
  const queue = before.queue.map((s, i) => {
    const b = plainFields(s), a = plainFields(after.queue[i]);
    return Object.freeze({ index: i, before: Object.freeze(b), after: Object.freeze(a), changedFields: Object.freeze(changedKeys(b, a)) });
  });
  const reserve = before.reserve.map((v, i) => Object.freeze({ index: i, before: plain(v), after: plain(after.reserve[i]), changed: plain(v) !== plain(after.reserve[i]) }));
  const groups = {
    stores: stores.filter(x => x.changedFields.length).map(x => x.resource),
    queue: queue.filter(x => x.changedFields.length).map(x => x.index),
    reserve: reserve.filter(x => x.changed).map(x => x.index),
    scalars: Object.keys(scalars).filter(k => scalars[k].changed),
  };
  return Object.freeze({ arithmetic: 'none', scalars: Object.freeze(scalars), stores: Object.freeze(stores), queue: Object.freeze(queue), reserve: Object.freeze(reserve), changed: Object.freeze(groups) });
}

// ------------------------------------------------------------------ one phase through the real parser
function legacyShapedFS(season, citizen, name, phase) {
  return {
    mode: 'play', tab: 'holding', season, citizen, holdings: [], provinces: new Map(), view: { fog: true }, ui: { dismissed: ['onboarding'] },
    marches: [], chronicle: [], incoming: [], feed: [], playReady: true, land: { stage: 'final' },
    wideHoldings: null, wideStatus: 'loading', wideError: null, wideSelect: null,
    // the fixture's own flags: a captured, unverified, read-only view; no chain timer, no projection
    readOnly: true, executable: false, verification: 'captured-unverified', economyCase: name, economyPhase: phase,
  };
}

function decodePhase(name, phase, ctx, citizenBytes, holdingBytes) {
  check(citizenBytes.length === CITIZEN_SIZE, 'BadCitizen', `${phase}: ${citizenBytes.length} B`);
  check(holdingBytes.length === WIDE_HOLDING_SIZE, 'BadHolding', `${phase}: ${holdingBytes.length} B`);
  let citizen, wide;
  try {
    citizen = decode('Citizen', citizenBytes, { profile: 2, seasonId: SEASON_ID });
    wide = decodeWideHoldingBytes(holdingBytes);
  } catch (e) { throw new ModelError('BadAccount', `${phase}: ${e.message}`); }
  check(citizen.wallet && toHex(Uint8Array.from(citizen.wallet)) === toHex(WALLET_A), 'WrongKey', `${phase}: the Citizen bytes name another wallet`);
  const { identity } = wide;
  check(identity.world === ctx.world, 'WorldMismatch', `${phase}: the holding names another world`);
  check(identity.season === String(SEASON_ID), 'WrongSeason', `${phase}: the holding is of another season`);
  check(toHex(identity.ownerCitizenBytes) === toHex(fromB58(ctx.citizenAddress)), 'WrongKey', `${phase}: the holding names another owner`);
  const bindings = citizenBindings(citizen);
  check(bindings[identity.inventorySlot - 1] === 'wide', 'BadBinding', `${phase}: the Citizen does not bind slot ${identity.inventorySlot} wide`);

  const record = {
    v: 1, wallet: WALLET_A_B58, citizen: { address: ctx.citizenAddress }, holdings: [], slots: [],
    wideContext: {
      v: 1, readOnly: true, executable: false, verification: 'captured-unverified', world: ctx.world, worldDomain: WORLD_DOMAIN,
      season: String(SEASON_ID), citizen: ctx.citizenAddress, latestSlot: SYNTHETIC_CAPTURE.slot, foldedThrough: SYNTHETIC_CAPTURE.archiveSequence,
      postState: 'transaction', inventory: bindings.map((binding, i) => ({ inventorySlot: i + 1, binding })),
    },
    wideHoldings: bindings.flatMap((binding, i) => {
      if (binding !== 'wide') return [];
      const slot = i + 1;
      if (slot !== identity.inventorySlot) return [{ inventorySlot: slot, status: 'not-captured', holding: null }];
      return [{
        inventorySlot: slot, status: 'captured-unverified',
        holding: {
          world: ctx.world, p: String(identity.p), q: String(identity.q), ring: String(identity.ring), site: identity.site, generation: identity.generation,
          inventorySlot: slot, season: identity.season, ownerCitizen: ctx.citizenAddress, hostIdentity: identity.hostIdentity, openTransits: identity.openTransits,
          capture: {
            address: ctx.holdingAddress(identity), slot: SYNTHETIC_CAPTURE.slot, archiveSequence: SYNTHETIC_CAPTURE.archiveSequence,
            postState: 'transaction', verification: 'captured-unverified', bytes_b64: toBase64(holdingBytes),
          },
        },
      }];
    }),
  };
  const FS = legacyShapedFS(ctx.seasonDecoded, citizen, name, phase);
  const pins = { seasonAddress: ctx.seasonAddress, programId: PROGRAM_B58, seasonId: String(SEASON_ID), world: ctx.world, citizen: ctx.citizenAddress, citizenRecord: citizen, viewerKey: WALLET_A_B58 };
  const status = adoptWide(FS, record, pins);
  check(status === 'ready', 'WideRefused', `${phase}: the wide parser refused (${FS.wideError?.code ?? status})`);
  check(selectWide(FS, identity.inventorySlot), 'WideRefused', `${phase}: the slot could not be selected`);
  check(FS.holdings.length === 0, 'WideRefused', 'no legacy village may appear');
  const holding = selectedWide(FS)?.holding;
  check(holding, 'WideRefused', `${phase}: nothing captured in the selected slot`);
  return { FS, holding, wide, identity, citizen };
}

// ------------------------------------------------------------------ one case
/**
 * `files` = { season, citizenPre, holdingPre, provincePre, citizenPost, holdingPost, provincePost, record } (Uint8Array).
 * Nothing is mutated. Throws ModelError on any size, identity, pairing, receipt or case mismatch.
 */
export function buildCase(name, files, { pins = MANIFEST } = {}) {
  check(CASE_NAMES.includes(name), 'UnknownCase', String(name));
  check(files && typeof files === 'object', 'MissingFile', 'files');
  for (const k of Object.keys(FILE_KEYS)) {
    check(files[k] instanceof Uint8Array && files[k].length > 0, 'MissingFile', k);
  }
  // All eight snapshots of THIS case must be the checked-in originals, byte for byte (a stale or swapped file of the same
  // identity is refused here, before anything is decoded). `pins` exists so tests can pin a deliberately mutated copy.
  const pinned = pins?.[name];
  check(pinned && typeof pinned === 'object', 'PinMismatch', `${name}: no pins`);
  check(Object.keys(pinned).length === FILE_NAMES.length, 'PinMismatch', `${name}: pins must name exactly ${FILE_NAMES.length} files`);
  const pinHashes = {};
  for (const [k, file] of Object.entries(FILE_KEYS)) {
    const want = pinned[file];
    check(typeof want === 'string' && /^[0-9a-f]{64}$/.test(want), 'PinMismatch', `${name}/${file}: no pin`);
    const got = toHex(sha256(files[k]));
    check(got === want, 'PinMismatch', `${name}/${file}: not the checked-in original`);
    pinHashes[file] = got;
  }
  check(files.season.length === SEASON_SIZE, 'BadSeason', `${files.season.length} B`);
  let seasonDecoded;
  try { seasonDecoded = decode('Season', files.season, { profile: 2, seasonId: SEASON_ID }); } catch (e) { throw new ModelError('BadSeason', e.message); }

  const addrs = seasonAddresses(PROGRAM_B58, SEASON_ID);
  const world = worldIdOf(addrs.season, PROGRAM_B58);
  const citizenAddress = addrs.of('Citizen', { wallet: WALLET_A_B58 });
  const ctx = {
    world, seasonAddress: addrs.season, seasonDecoded, citizenAddress,
    holdingAddress: id => wideHoldingAddress(addrs.season, PROGRAM_B58, id.p, id.q, id.site),
  };

  const receipt = decodeReceipt(files.record);
  const want = EXPECTED[name];
  const got = receipt.receipt.action;
  check(got.kind === want.kind && Object.keys(want).every(k => got[k] === want[k]), 'WrongCase', `${name}: the receipt records ${plain(got)}`);

  const before = decodePhase(name, 'before', ctx, files.citizenPre, files.holdingPre);
  const after = decodePhase(name, 'after', ctx, files.citizenPost, files.holdingPost);
  const a = before.identity, z = after.identity;
  check(a.p === z.p && a.q === z.q && a.site === z.site && a.generation === z.generation && a.world === z.world
    && a.inventorySlot === z.inventorySlot && toHex(a.ownerCitizenBytes) === toHex(z.ownerCitizenBytes), 'PairMismatch', 'before and after name different holdings');
  const k = receipt.key;
  check(k.world === a.world && k.p === a.p && k.q === a.q && k.site === a.site && k.generation === a.generation, 'KeyMismatch', 'the receipt names another holding');

  const provinceBefore = provinceMeta(files.provincePre, 'before'), provinceAfter = provinceMeta(files.provincePost, 'after');
  const wantKey = toHex(sortKeyOf(a.p, a.q));
  for (const [phase, pm] of [['before', provinceBefore], ['after', provinceAfter]]) {
    check(pm.season === String(SEASON_ID), 'ProvinceMismatch', `${phase}: the province is of another season`);
    check(pm.world === a.world, 'ProvinceMismatch', `${phase}: the province names another world`);
    check(pm.sortKey === wantKey, 'ProvinceMismatch', `${phase}: the province is not the holding's province`);
  }
  check(provinceBefore.world === provinceAfter.world && provinceBefore.sortKey === provinceAfter.sortKey && provinceBefore.season === provinceAfter.season,
    'PairMismatch', 'province before and after name different provinces');

  return Object.freeze({
    name, expected: want,
    pins: Object.freeze({
      program: PROGRAM_B58, wallet: WALLET_A_B58, seasonId: String(SEASON_ID), seasonAddress: addrs.season, citizenAddress, world,
      holdingAddress: ctx.holdingAddress(a), literal: 'public harness literals (no key behind them)',
    }),
    synthetic: SYNTHETIC_CAPTURE,
    provenance: PROVENANCE,
    hashPins: Object.freeze(pinHashes), pinNote: PIN_NOTE,
    verification: 'captured-unverified',
    receipt,
    instructionDataHex: receipt.instructionDataHex,
    province: Object.freeze({ before: provinceBefore, after: provinceAfter }),
    before: Object.freeze({ FS: before.FS, holding: before.holding, citizen: before.citizen }),
    after: Object.freeze({ FS: after.FS, holding: after.holding, citizen: after.citizen }),
    diff: economyDiff(before.wide.economy, after.wide.economy),
  });
}

/** Load the eight files of a case through `read(name, file) → Uint8Array|Promise<Uint8Array>` and build it. */
export async function loadCase(name, read, options) {
  check(CASE_NAMES.includes(name), 'UnknownCase', String(name));
  const files = {};
  for (const [k, f] of Object.entries(FILE_KEYS)) files[k] = Uint8Array.from(await read(name, f));
  return buildCase(name, files, options);
}

/** Browser reader: GET the exact allowlisted route from the fixture server (same origin). */
export const fetchReader = (base = '') => async (name, file) => {
  const res = await fetch(base + fixtureRoute(name, file), { method: 'GET', cache: 'no-store' });
  if (!res.ok) throw new ModelError('FetchFailed', `${name}/${file}: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
};
