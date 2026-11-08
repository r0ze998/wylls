// Key-free model of the LOCAL wide-economy demo (pure: no I/O, no DOM, no network, no process).
//
// What this is: the validator/adapter between the local host's reply lines (protocol wylls-local-economy-v1) and the
// PRODUCTION wide parser/renderer. It implements NO economics: no cost, price, yield, accrual, queue or completion rule
// exists here. Every number the UI shows comes from the host's bytes, read by the production parser.
//
// What it is not: chain provenance. The host is a LOCAL SIMULATION with a mock authorization (an `is_signer` flag set by
// the harness). There is no wallet, no signature, no transaction, no RPC. A "record" is decoded structurally only.
//
// Only the INITIAL state (revision 0 and every reset) is tied to the original harvest "pre" fixture bytes, by SHA-256 pin
// of those four files and byte equality. MUTATED state is never held against the original before/after manifest pins; it is
// validated structurally (fixed identity / season / world / owner / province, parser acceptance, record key and action).
import { decode } from '../../../permutation-server/web/frontier/fcodec.mjs';
import { seasonAddresses } from '../../../permutation-server/web/frontier/faddr.mjs';
import {
  adoptWide, selectWide, selectedWide, citizenBindings, decodeWideHoldingBytes, coordOfSortKey, sortKeyOf, wideHoldingAddress,
  WIDE_HOLDING_SIZE, FIRST_WIDE_RING, WideError,
} from '../../../permutation-server/web/frontier/fwide.mjs';
import { worldIdOf, ringPosition, WORLD_DOMAIN } from '../../../permutation-server/web/frontier/map/wide.mjs';
import { decode as fromB58 } from '../../../permutation-server/web/sdk/base58.mjs';
import { toBase64, toHex } from '../../../permutation-server/web/sdk/bytes.mjs';
import { sha256 } from '../../../permutation-server/web/sdk/sha256.mjs';
// Pure helpers and public literals of the existing fixture model (exported there). Its static manifest is used ONLY to
// pin the four ORIGINAL harvest "pre" files (the initial state), never to judge a mutated state.
import {
  WALLET_A, SEASON_ID, PROGRAM_B58, WALLET_A_B58, SEASON_SIZE, CITIZEN_SIZE, SYNTHETIC_CAPTURE, FIXTURE_DIR, decodeReceipt,
  PROVINCE as PROVINCE_LAYOUT,
} from '../wide-economy-fixture/model.mjs';
import { MANIFEST } from '../wide-economy-fixture/manifest.mjs';

export { PROGRAM_B58, WALLET_A_B58, SEASON_ID, SYNTHETIC_CAPTURE };

// ------------------------------------------------------------------ protocol constants (host contract)
export const PROTOCOL = 'wylls-local-economy-v1';
export const MODE = 'local-only';
export const AUTH = 'MOCK_AUTH_NO_SIGNATURE';
export const MAX_REVISION = 1000000;
export const INITIAL_NOW = '1800088200';
export const REPLY_KEYS = Object.freeze(['protocol', 'mode', 'auth', 'status', 'revision', 'now', 'command', 'action', 'code', 'seasonHex', 'citizenHex', 'holdingHex', 'provinceHex', 'recordHex']);
export const STATUSES = Object.freeze(['ok', 'refused', 'fault']);
export const ADVANCE_SECONDS = Object.freeze([600, 3600, 86400]);
export const BUILD_ITEMS = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8]);
export const TRAIN_UNITS = Object.freeze([0, 1, 2, 3, 4, 5, 6]);
/** Transport bound only (the host's own rules decide what is allowed); NOT an economy rule. */
export const TRAIN_COUNT_MIN = 1;
export const TRAIN_COUNT_MAX = 1000;
export const MAX_COMMAND_BYTES = 256;
export const MAX_REPLY_BYTES = 64 * 1024;
export const HOST_REL_PATH = Object.freeze(['.local', 'wide-economy-demo', 'target', 'debug', 'examples', 'local_economy_demo']);

/** Rust protocol convention: REV in a command is the revision the
 *  caller believes is current; a successful mutation answers REV + 1; a refusal answers the unchanged revision. */
export const revisionAfter = rev => rev + 1;

/** The only initial-state files the browser/server fetch (exact repo-relative routes under FIXTURE_DIR / harvest). */
export const INITIAL_FILES = Object.freeze({ season: 'season.bin', citizen: 'citizen_pre.bin', holding: 'holding_pre.bin', province: 'province_pre.bin' });
export const initialRoute = file => `/${FIXTURE_DIR}/harvest/${file}`;

const HEX_LEN = Object.freeze({ seasonHex: SEASON_SIZE * 2, citizenHex: CITIZEN_SIZE * 2, holdingHex: WIDE_HOLDING_SIZE * 2, provinceHex: PROVINCE_LAYOUT.SIZE * 2 });
const RECORD_HEX_LENS = Object.freeze([184 * 2, 225 * 2]);

export class LocalModelError extends Error {
  constructor(code, message) { super(message ?? code); this.code = code; }
}
const check = (cond, code, msg) => { if (!cond) throw new LocalModelError(code, msg ?? code); };
const zero = (b, from, to) => { for (let i = from; i < to; i++) if (b[i] !== 0) return false; return true; };
const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

// ------------------------------------------------------------------ commands (bounded ASCII lines)
const isInt = (v, lo, hi) => typeof v === 'number' && Number.isSafeInteger(v) && v >= lo && v <= hi;
export const isRevision = v => isInt(v, 0, Number.MAX_SAFE_INTEGER);

/**
 * A validated command description → the exact host line (no newline). Anything outside the allowlists throws; there is
 * no free-form text, path, account, instruction or time.
 *   {kind:'get'} {kind:'harvest',rev} {kind:'build',rev,item} {kind:'train',rev,unit,count} {kind:'advance',rev,seconds} {kind:'reset',rev}
 */
export function commandLine(cmd) {
  check(isPlain(cmd), 'BadCommand', 'command');
  const only = keys => check(Object.keys(cmd).length === keys.length && keys.every(k => Object.hasOwn(cmd, k)), 'BadCommand', 'command keys');
  let line;
  switch (cmd.kind) {
    case 'get': only(['kind']); line = 'get'; break;
    case 'harvest': only(['kind', 'rev']); check(isRevision(cmd.rev), 'BadCommand', 'rev'); line = `act ${cmd.rev} harvest`; break;
    case 'build':
      only(['kind', 'rev', 'item']); check(isRevision(cmd.rev), 'BadCommand', 'rev'); check(BUILD_ITEMS.includes(cmd.item), 'BadCommand', 'build item');
      line = `act ${cmd.rev} build ${cmd.item}`; break;
    case 'train':
      only(['kind', 'rev', 'unit', 'count']); check(isRevision(cmd.rev), 'BadCommand', 'rev'); check(TRAIN_UNITS.includes(cmd.unit), 'BadCommand', 'train unit');
      check(isInt(cmd.count, TRAIN_COUNT_MIN, TRAIN_COUNT_MAX), 'BadCommand', 'train count');
      line = `act ${cmd.rev} train ${cmd.unit} ${cmd.count}`; break;
    case 'advance':
      only(['kind', 'rev', 'seconds']); check(isRevision(cmd.rev), 'BadCommand', 'rev'); check(ADVANCE_SECONDS.includes(cmd.seconds), 'BadCommand', 'seconds');
      line = `advance ${cmd.rev} ${cmd.seconds}`; break;
    case 'reset': only(['kind', 'rev']); check(isRevision(cmd.rev), 'BadCommand', 'rev'); line = `reset ${cmd.rev}`; break;
    default: throw new LocalModelError('BadCommand', 'kind');
  }
  check(/^[\x20-\x7e]+$/.test(line) && line.length <= MAX_COMMAND_BYTES, 'BadCommand', 'line');
  return line;
}

/**
 * The browser→server action body (exact schema) → a command, or throws. `expectedRevision` is mandatory on every mutation.
 *   /api/action  {expectedRevision, action:'harvest'} | {…, action:'build', item} | {…, action:'train', unit, count}
 *   /api/advance {expectedRevision, seconds}     /api/reset {expectedRevision}
 */
export function commandFromBody(route, body) {
  check(isPlain(body), 'BadBody', 'object expected');
  const keys = Object.keys(body);
  const exact = want => check(keys.length === want.length && want.every(k => Object.hasOwn(body, k)), 'BadBody', 'exact keys');
  if (route === 'reset') { exact(['expectedRevision']); check(isRevision(body.expectedRevision), 'BadBody', 'expectedRevision'); return { kind: 'reset', rev: body.expectedRevision }; }
  if (route === 'advance') {
    exact(['expectedRevision', 'seconds']); check(isRevision(body.expectedRevision), 'BadBody', 'expectedRevision');
    check(ADVANCE_SECONDS.includes(body.seconds), 'BadBody', 'seconds'); return { kind: 'advance', rev: body.expectedRevision, seconds: body.seconds };
  }
  check(route === 'action', 'BadBody', 'route');
  check(isRevision(body.expectedRevision), 'BadBody', 'expectedRevision');
  if (body.action === 'harvest') { exact(['expectedRevision', 'action']); return { kind: 'harvest', rev: body.expectedRevision }; }
  if (body.action === 'build') {
    exact(['expectedRevision', 'action', 'item']); check(BUILD_ITEMS.includes(body.item), 'BadBody', 'item');
    return { kind: 'build', rev: body.expectedRevision, item: body.item };
  }
  if (body.action === 'train') {
    exact(['expectedRevision', 'action', 'unit', 'count']); check(TRAIN_UNITS.includes(body.unit), 'BadBody', 'unit');
    check(isInt(body.count, TRAIN_COUNT_MIN, TRAIN_COUNT_MAX), 'BadBody', 'count');
    return { kind: 'train', rev: body.expectedRevision, unit: body.unit, count: body.count };
  }
  throw new LocalModelError('BadBody', 'action');
}

// ------------------------------------------------------------------ reply line (shape only)
const hexBytes = (s, code, what) => {
  check(typeof s === 'string' && s.length % 2 === 0 && /^[0-9a-f]*$/.test(s), code, `${what}: lowercase hex expected`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
};

/** One reply line (string) → plain frozen reply object; exact keys and types or throws `BadReply`. No semantics yet. */
export function parseReplyLine(line) {
  check(typeof line === 'string' && line.length > 0 && line.length <= MAX_REPLY_BYTES, 'BadReply', 'line size');
  check(/^[\x20-\x7e]+$/.test(line), 'BadReply', 'ASCII only');
  let j;
  try { j = JSON.parse(line); } catch { throw new LocalModelError('BadReply', 'not JSON'); }
  return parseReplyObject(j);
}

export function parseReplyObject(j) {
  check(isPlain(j), 'BadReply', 'object expected');
  const keys = Object.keys(j);
  check(keys.length === REPLY_KEYS.length && REPLY_KEYS.every(k => Object.hasOwn(j, k)), 'BadReply', 'exact keys');
  check(j.protocol === PROTOCOL, 'BadReply', 'protocol');
  check(j.mode === MODE, 'BadReply', 'mode');
  check(j.auth === AUTH, 'BadReply', 'auth');
  check(['get', 'act', 'advance', 'reset', 'invalid'].includes(j.command), 'BadReply', 'command');
  check(j.command === 'act' ? ['harvest', 'build', 'train'].includes(j.action) : j.action === null, 'BadReply', 'action');
  check(j.command !== 'invalid' || j.status === 'refused', 'BadReply', 'invalid command status');
  check(j.command !== 'get' || j.status === 'ok', 'BadReply', 'get status');
  check(STATUSES.includes(j.status), 'BadReply', 'status');
  check(isInt(j.revision, 0, MAX_REVISION), 'BadReply', 'revision');
  check(typeof j.now === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(j.now) && BigInt(j.now) <= 0x7fffffffffffffffn, 'BadReply', 'now');
  check(j.code === null || (typeof j.code === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(j.code)), 'BadReply', 'code');
  check(j.status === 'ok' ? j.code === null : j.code !== null, 'BadReply', 'status code');
  for (const k of Object.keys(HEX_LEN)) check(typeof j[k] === 'string' && j[k].length === HEX_LEN[k] && /^[0-9a-f]+$/.test(j[k]), 'BadReply', `${k}: size or hex`);
  check(j.recordHex === null || (typeof j.recordHex === 'string' && RECORD_HEX_LENS.includes(j.recordHex.length) && /^[0-9a-f]+$/.test(j.recordHex)), 'BadReply', 'recordHex');
  check((j.recordHex !== null) === (j.status === 'ok' && j.command === 'act'), 'BadReply', 'receipt presence');
  return Object.freeze({
    auth: j.auth, command: j.command, action: j.action,
    protocol: j.protocol, mode: j.mode, status: j.status, revision: j.revision, now: j.now, code: j.code,
    seasonHex: j.seasonHex, citizenHex: j.citizenHex, holdingHex: j.holdingHex, provinceHex: j.provinceHex, recordHex: j.recordHex,
  });
}

/** Re-serialize a reply with exactly the contract keys (what the server hands the browser). */
export const replyObject = r => Object.fromEntries(REPLY_KEYS.map(k => [k, r[k]]));

// ------------------------------------------------------------------ province identity (structural, WideProvince::read)
function provinceMeta(b, what) {
  const A = PROVINCE_LAYOUT.AT;
  check(b.length === PROVINCE_LAYOUT.SIZE, 'BadProvince', `${what}: size`);
  check(String.fromCharCode(...b.subarray(0, 8)) === PROVINCE_LAYOUT.MAGIC, 'BadProvince', `${what}: magic`);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  check(dv.getUint16(A.LAYOUT_VERSION, true) === PROVINCE_LAYOUT.LAYOUT_VERSION, 'BadProvince', `${what}: layout version`);
  check(dv.getUint16(A.FAMILY_VERSION, true) === PROVINCE_LAYOUT.FAMILY_VERSION, 'BadProvince', `${what}: family version`);
  check(b[A.STATUS] === PROVINCE_LAYOUT.STATUS_OPENED, 'BadProvince', `${what}: status`);
  check(b[A.READINESS] === PROVINCE_LAYOUT.READINESS_REQUIRED, 'BadProvince', `${what}: readiness`);
  check(zero(b, A.RSV_53, A.RSV_53 + 3) && zero(b, A.RSV, A.RSV + A.RSV_LEN), 'BadProvince', `${what}: reserved bytes`);
  check(dv.getInt16(A.P, true) === 0 && dv.getInt16(A.Q, true) === 0 && dv.getUint16(A.RING, true) === 0, 'BadProvince', `${what}: legacy prefix`);
  let coord;
  try { coord = coordOfSortKey(b.slice(A.SORT_KEY, A.SORT_KEY + 17)); } catch (e) { throw new LocalModelError('BadProvince', `${what}: ${e instanceof WideError ? e.message : 'sort key'}`); }
  const rp = ringPosition(coord.p, coord.q);
  check(rp.ring >= FIRST_WIDE_RING, 'BadProvince', `${what}: inside the legacy disk`);
  check(b[A.WEDGE] === rp.wedge, 'BadProvince', `${what}: wedge`);
  check(!zero(b, A.RING_SEED, A.RING_SEED + 32), 'BadProvince', `${what}: zero ring seed`);
  const world = toHex(b.subarray(A.WORLD, A.WORLD + 32));
  check(world !== '0'.repeat(64), 'BadProvince', `${what}: zero world`);
  return Object.freeze({ season: String(dv.getBigUint64(A.SEASON_ID, true)), world, sortKey: toHex(b.subarray(A.SORT_KEY, A.SORT_KEY + 17)), p: String(coord.p), q: String(coord.q), ring: String(rp.ring) });
}

// ------------------------------------------------------------------ the initial state (original harvest "pre" fixture bytes)
/**
 * `files` = {season, citizen, holding, province} (Uint8Array): the four ORIGINAL harvest pre files. Each is pinned by
 * SHA-256 to the committed manifest and must decode. Returns the immutable "initial" context every later state is held to
 * (same program, wallet, season, world, owner, holding and province identity; season bytes byte-identical).
 */
export function loadInitial(files) {
  check(files !== null && typeof files === 'object', 'BadInitial', 'files');
  const pins = MANIFEST.harvest;
  const hex = {};
  for (const [k, name] of Object.entries(INITIAL_FILES)) {
    check(files[k] instanceof Uint8Array && files[k].length > 0, 'BadInitial', `${name}: missing`);
    check(typeof pins?.[name] === 'string' && toHex(sha256(files[k])) === pins[name], 'BadInitial', `${name}: not the committed original`);
    hex[k] = toHex(files[k]);
  }
  const ctx = contextFromSeason(files.season);
  const snap = decodeSnapshot(ctx, files.citizen, files.holding, 'initial');
  const pm = provinceMeta(files.province, 'initial province');
  check(pm.season === String(SEASON_ID) && pm.world === ctx.world && pm.sortKey === toHex(snap.sortKey), 'BadInitial', 'the province is not the holding\'s');
  return Object.freeze({ ctx, hex: Object.freeze(hex), identity: snap.idKey, province: Object.freeze({ season: pm.season, world: pm.world, sortKey: pm.sortKey }), nowText: INITIAL_NOW });
}

function contextFromSeason(seasonBytes) {
  check(seasonBytes instanceof Uint8Array && seasonBytes.length === SEASON_SIZE, 'BadSeason', 'size');
  let seasonDecoded;
  try { seasonDecoded = decode('Season', seasonBytes, { profile: 2, seasonId: SEASON_ID }); } catch (e) { throw new LocalModelError('BadSeason', e.message); }
  const addrs = seasonAddresses(PROGRAM_B58, SEASON_ID);
  return Object.freeze({
    seasonAddress: addrs.season, seasonDecoded, world: worldIdOf(addrs.season, PROGRAM_B58), citizenAddress: addrs.of('Citizen', { wallet: WALLET_A_B58 }),
    holdingAddress: id => wideHoldingAddress(addrs.season, PROGRAM_B58, id.p, id.q, id.site),
  });
}

// ------------------------------------------------------------------ one snapshot through the production parser
function decodeSnapshot(ctx, citizenBytes, holdingBytes, what) {
  let citizen, wide;
  try {
    citizen = decode('Citizen', citizenBytes, { profile: 2, seasonId: SEASON_ID });
    wide = decodeWideHoldingBytes(holdingBytes);
  } catch (e) { throw new LocalModelError('BadAccount', `${what}: ${e.message}`); }
  check(citizen.wallet && toHex(Uint8Array.from(citizen.wallet)) === toHex(WALLET_A), 'WrongKey', `${what}: the Citizen names another wallet`);
  const id = wide.identity;
  check(id.world === ctx.world, 'WorldMismatch', `${what}: another world`);
  check(id.season === String(SEASON_ID), 'WrongSeason', `${what}: another season`);
  check(toHex(id.ownerCitizenBytes) === toHex(fromB58(ctx.citizenAddress)), 'WrongKey', `${what}: another owner`);
  const bindings = citizenBindings(citizen);
  check(bindings[id.inventorySlot - 1] === 'wide', 'BadBinding', `${what}: the Citizen does not bind slot ${id.inventorySlot} wide`);
  const idKey = `${id.world}:${id.p},${id.q}:${id.site}:${id.generation}:${id.inventorySlot}:${toHex(id.ownerCitizenBytes)}`;
  return { citizen, wide, id, bindings, idKey, sortKey: sortKeyBytes(id) };
}
// the sort key of the holding's coordinate, derived through the same helper the production parser uses
const sortKeyBytes = id => sortKeyOf(id.p, id.q);

function buildFS(ctx, snap, holdingBytes) {
  const { id, bindings, citizen } = snap;
  const record = {
    v: 1, wallet: WALLET_A_B58, citizen: { address: ctx.citizenAddress }, holdings: [], slots: [],
    wideContext: {
      // 'captured-unverified' / 'transaction' are the literals the production parser requires of its input envelope.
      // Here they are NOT a claim of chain capture: this is a local simulation (see FS.local* below and the UI notice).
      v: 1, readOnly: true, executable: false, verification: 'captured-unverified', world: ctx.world, worldDomain: WORLD_DOMAIN,
      season: String(SEASON_ID), citizen: ctx.citizenAddress, latestSlot: SYNTHETIC_CAPTURE.slot, foldedThrough: SYNTHETIC_CAPTURE.archiveSequence,
      postState: 'transaction', inventory: bindings.map((binding, i) => ({ inventorySlot: i + 1, binding })),
    },
    wideHoldings: bindings.flatMap((binding, i) => {
      if (binding !== 'wide') return [];
      const slot = i + 1;
      if (slot !== id.inventorySlot) return [{ inventorySlot: slot, status: 'not-captured', holding: null }];
      return [{
        inventorySlot: slot, status: 'captured-unverified',
        holding: {
          world: ctx.world, p: String(id.p), q: String(id.q), ring: String(id.ring), site: id.site, generation: id.generation, inventorySlot: slot,
          season: id.season, ownerCitizen: ctx.citizenAddress, hostIdentity: id.hostIdentity, openTransits: id.openTransits,
          capture: { address: ctx.holdingAddress(id), slot: SYNTHETIC_CAPTURE.slot, archiveSequence: SYNTHETIC_CAPTURE.archiveSequence, postState: 'transaction', verification: 'captured-unverified', bytes_b64: toBase64(holdingBytes) },
        },
      }];
    }),
  };
  const FS = {
    mode: 'play', tab: 'holding', season: ctx.seasonDecoded, citizen, holdings: [], provinces: new Map(), view: { fog: true }, ui: { dismissed: ['onboarding'] },
    marches: [], chronicle: [], incoming: [], feed: [], playReady: true, land: { stage: 'final' },
    wideHoldings: null, wideStatus: 'loading', wideError: null, wideSelect: null,
    // production card is read-only and not executable; LOCAL controls live outside it
    readOnly: true, executable: false, verification: 'local-simulation-mock-auth', localSimulation: true,
  };
  const pins = { seasonAddress: ctx.seasonAddress, programId: PROGRAM_B58, seasonId: String(SEASON_ID), world: ctx.world, citizen: ctx.citizenAddress, citizenRecord: citizen, viewerKey: WALLET_A_B58 };
  const status = adoptWide(FS, record, pins);
  check(status === 'ready', 'WideRefused', `the wide parser refused (${FS.wideError?.code ?? status})`);
  check(selectWide(FS, id.inventorySlot) !== false, 'WideRefused', 'slot not selectable');
  check(FS.holdings.length === 0, 'WideRefused', 'no legacy village may appear');
  const holding = selectedWide(FS)?.holding;
  check(holding && holding.readOnly === true && holding.executable === false, 'WideRefused', 'nothing captured in the selected slot');
  return { FS, holding };
}

// ------------------------------------------------------------------ a whole reply → validated state
const sameBytes = (a, b) => a === b;

/**
 * Validate one parsed reply against the initial context and build the production-parser state.
 *   - status 'fault' never yields a state (the host is not trusted any more);
 *   - season bytes identical to the initial season (fixed season hash);
 *   - citizen / holding / province must keep the initial program, wallet, season, world, owner, holding and province identity
 *     and be accepted by the production parser / structural province check;
 *   - `now` is a separate simulated clock, never before the initial time;
 *   - recordHex, when present, decodes structurally and names THIS holding and action at exactly `now`.
 * Mutated economy bytes are NOT compared with any original after-state, and nothing claims chain provenance.
 */
export function validateState(reply, initial) {
  check(reply && reply.protocol === PROTOCOL, 'BadReply', 'not a parsed reply');
  check(initial?.ctx, 'BadInitial', 'initial');
  check(reply.status !== 'fault', 'HostFault', reply.code ?? 'fault');
  const ctx = initial.ctx;
  check(sameBytes(reply.seasonHex, initial.hex.season), 'SeasonChanged', 'the season bytes are not the fixed season');
  check(BigInt(reply.now) >= BigInt(INITIAL_NOW), 'BadClock', 'time before the initial time');
  const snap = decodeSnapshot(ctx, hexBytes(reply.citizenHex, 'BadReply', 'citizen'), hexBytes(reply.holdingHex, 'BadReply', 'holding'), 'state');
  check(snap.idKey === initial.identity, 'IdentityChanged', 'the holding identity is not the fixed one');
  const pm = provinceMeta(hexBytes(reply.provinceHex, 'BadReply', 'province'), 'province');
  check(pm.season === initial.province.season && pm.world === initial.province.world && pm.sortKey === initial.province.sortKey, 'IdentityChanged', 'the province identity is not the fixed one');
  let record = null;
  if (reply.recordHex !== null) {
    try { record = decodeReceipt(hexBytes(reply.recordHex, 'BadReply', 'record')); } catch (e) { throw new LocalModelError('BadRecord', e.message); }
    const k = record.key;
    check(k.world === snap.id.world && k.p === snap.id.p && k.q === snap.id.q && k.site === snap.id.site && k.generation === snap.id.generation, 'BadRecord', 'the record names another holding');
    check(record.receipt.action.kind.toLowerCase() === reply.action, 'BadRecord', 'receipt action metadata');
    const t = BigInt(record.receipt.now);
    check(t === BigInt(reply.now), 'BadRecord', 'the record time does not match the simulated clock');
  }
  const { FS, holding } = buildFS(ctx, snap, hexBytes(reply.holdingHex, 'BadReply', 'holding'));
  return Object.freeze({
    revision: reply.revision, now: reply.now, status: reply.status, code: reply.code, record, FS, holding,
    hex: Object.freeze({ season: reply.seasonHex, citizen: reply.citizenHex, holding: reply.holdingHex, province: reply.provinceHex, record: reply.recordHex }),
    pins: Object.freeze({ program: PROGRAM_B58, wallet: WALLET_A_B58, seasonId: String(SEASON_ID), seasonAddress: ctx.seasonAddress, citizenAddress: ctx.citizenAddress, world: ctx.world, holdingAddress: ctx.holdingAddress(snap.id) }),
    simulation: true, chainProvenance: false,
  });
}

/** Revision-0 / reset state: every byte equal to the original harvest "pre" files and the original time. */
export function isPristine(reply, initial) {
  return reply.seasonHex === initial.hex.season && reply.citizenHex === initial.hex.citizen && reply.holdingHex === initial.hex.holding
    && reply.provinceHex === initial.hex.province && reply.now === INITIAL_NOW && reply.recordHex === null;
}

// ------------------------------------------------------------------ a request/reply pair
const STATE_KEYS = ['seasonHex', 'citizenHex', 'holdingHex', 'provinceHex'];
const sameState = (a, b) => STATE_KEYS.every(k => a[k] === b[k]) && a.now === b.now;
const actionMatches = (a, cmd) => (cmd.kind === 'harvest' ? a.kind === 'Harvest'
  : cmd.kind === 'build' ? a.kind === 'Build' && a.item === cmd.item
    : cmd.kind === 'train' ? a.kind === 'Train' && a.unit === cmd.unit && a.n === cmd.count : false);

/**
 * `prev` = the last accepted PARSED reply, `cmd` the command sent (or {kind:'get'}), `next` the new parsed reply.
 * Returns 'ok' | 'refused'; throws LocalModelError on anything the contract does not allow (the caller then treats the
 * state as UNCERTAIN: no retry, no restart, no further mutation). Structural only; no economic rule is applied.
 */
export function checkTransition(prev, cmd, next, initial) {
  check(next.status !== 'fault', 'HostFault', next.code ?? 'fault');
  parseReplyObject(next);
  const isAct = ['harvest', 'build', 'train'].includes(cmd.kind);
  check(next.command === (isAct ? 'act' : cmd.kind) && next.action === (isAct ? cmd.kind : null), 'BadTransition', 'reply command metadata');
  if (cmd.kind === 'get') {
    check(next.status === 'ok' && next.revision === prev.revision && sameState(prev, next) && next.recordHex === null, 'BadTransition', 'get changed something');
    return 'ok';
  }
  check(cmd.rev === prev.revision, 'BadTransition', 'the command was not for the current revision');
  if (next.status === 'refused') {
    check(next.revision === prev.revision && sameState(prev, next) && next.recordHex === null, 'BadTransition', 'a refusal changed the state');
    return 'refused';
  }
  check(next.revision === revisionAfter(prev.revision) && Number.isSafeInteger(next.revision), 'BadTransition', 'revision did not advance by one');
  const before = BigInt(prev.now), after = BigInt(next.now);
  if (cmd.kind === 'reset') {
    check(isPristine(next, initial) && next.recordHex === null, 'BadTransition', 'reset is not the pristine initial state');
    return 'ok';
  }
  if (cmd.kind === 'advance') {
    check(after === before + BigInt(cmd.seconds), 'BadTransition', 'advance moved the clock by another amount');
    check(next.citizenHex === prev.citizenHex && next.holdingHex === prev.holdingHex && next.provinceHex === prev.provinceHex && next.seasonHex === prev.seasonHex,
      'BadTransition', 'advance changed more than the clock');
    return 'ok';
  }
  check(after === before, 'BadTransition', 'an action moved the simulated clock');
  if (next.recordHex !== null) {
    const rec = decodeReceipt(hexBytes(next.recordHex, 'BadReply', 'record'));
    check(BigInt(rec.receipt.now) === after, 'BadTransition', 'record time');
    check(actionMatches(rec.receipt.action, cmd), 'BadTransition', 'the record is not of the requested action');
  }
  return 'ok';
}
