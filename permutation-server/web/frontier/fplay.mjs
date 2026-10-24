// Play actions through the relay (contract §8.3, §9.4; web design §5): one
// path for every player and settle shape the page sends.
//
//   GET /f/relay (fee payer, blockhash) → the Frontier instruction built
//   from addresses recomputed here (accountsFor) → the legacy message with
//   the budgets' compute-budget prefix at CU price 0 → the pre-signing
//   check (fchainio.messageProblems: exact accounts and data, the relay's
//   own allowlist) → one signature (the session key; the wallet only for
//   Join and SetSession; nobody for a settle shape) → POST → the answer's
//   signature must be the announced fee payer's signature **of this
//   message** (a relay that co-signed anything else is caught before the
//   page reports success) → GET /f/tx until landed, failed or expired.
//
// A Reveal is never built here (I-24): marchbook.revealMaterial goes to
// POST /gw/f/reveal. Every function answers `{ok, …}` and never rejects.
import { frontierIx } from '../sdk/frontier/shapes.mjs';
import { isV2 } from '../sdk/frontier/profile.mjs';
import { budgetOf, budgetPrefix } from '../sdk/frontier/budgets.mjs';
import { compileMessage, wireTransaction } from '../sdk/solana-tx.mjs';
import { decode as fromBase58 } from '../sdk/base58.mjs';
import { toBase64 } from '../sdk/bytes.mjs';
import { verify } from '../session.mjs';
import * as io from './fchainio.mjs';
import { joinShardOf, citizenTag, depositSeq } from './faddr.mjs';

/**
 * ClashInputs' `camp_mask` (v1.7, I-56): u32 LE at offset 76 of the raw
 * account bytes (the herald's /h/clash `inputs_b64`). Since ABI v1.8 the
 * decoded ClashInputs carries it as `campMask`; this reader is the fallback
 * for raw bytes.
 */
export const CAMP_MASK_OFFSET = 76;
export function campMaskOf(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : null;
  if (!b || b.length < CAMP_MASK_OFFSET + 4) return 0;
  return (b[76] | (b[77] << 8) | (b[78] << 16) | (b[79] << 24)) >>> 0;
}
/**
 * fclient::ix::camp_winner: the arrival at (faction, i) earns the camp's
 * Works when its fate is Stays (1) and its position `faction·4 + i` is the
 * lowest set bit of `camp_mask` (one winner per camp).
 */
export const campWinner = (mask, faction, i, fate) => fate === 1 && mask !== 0 && 31 - Math.clz32(mask & -mask) === faction * 4 + i;

/** The shapes this page sends and who signs them. */
export const SIGNED_BY = Object.freeze({
  Join: 'wallet', SetSession: 'wallet',
  SetVigil: 'session', FileTicket: 'session', PlaceHome: 'session', Harvest: 'session', Build: 'session', Train: 'session', Muster: 'session',
  DeclareSiege: 'session', FileOutpost: 'session', RetireHost: 'session', Dissolve: 'session', Garrison: 'session', Explore: 'session', Depart: 'session',
  SettleExplore: 'none', SettleTransit: 'none',
  // S1 (program_version 4): vaults, caravans, structures, forts and nations
  BuildVault: 'session', SendCaravan: 'session', RaidCaravan: 'session', BuildStructure: 'session', FortGarrison: 'session',
  Propose: 'session', Vote: 'session',
  // S2 (program_version 5): tickets. A gift to another citizen needs the
  // wallet (L7); this page signs every GiveLot with it.
  IssueTickets: 'session', GiveLot: 'wallet', CloseLot: 'session',
  // S2 (2b): shares. A withdrawal home needs no wallet (to another's place
  // it would; this page sends it home).
  OpenShares: 'session', WithdrawShares: 'session',
  // S2 (2c): receipts.
  ClaimReceipt: 'session', WithdrawReceipt: 'session',
});
/** S1 `layout::s1::place` kinds (a caravan's origin or destination). */
export const PLACE_KIND = Object.freeze({ holding: 1, vault: 2 });
/** S1 `log::raid_choice`: a raider takes the caravan, or burns its load. */
export const RAID_CHOICE = Object.freeze({ take: 0, burn: 1 });
/** Build item of the walls (catalog `ITEM_WALLS`; the only Build that names the Province). */
export const ITEM_WALLS = 6;

const fail = (code, error, extra = {}) => ({ ok: false, code, error: error ?? code, ...extra });

/** The distinct provinces of a site list, in first-named order (FileTicket's province accounts). */
export function ticketProvinces(sites) {
  const out = [];
  for (const s of sites) if (!out.some(o => o.p === s.p && o.q === s.q)) out.push({ p: s.p, q: s.q });
  return out;
}

/**
 * The accounts of a shape (every one but `payer`, which is the relay's fee
 * payer), recomputed from the pinned season's addresses (faddr.mjs):
 *   v = {addresses, wallet, actor, faction?, joinGate?, holding: {p, q, site}?,
 *        province: {p, q}?, sites?, item?, settle?: {…keys the herald gave}}
 * `actor` is the signing key (the session key, or the wallet). Throws on a
 * shape this page does not send.
 */
export function accountsFor(name, v) {
  if (!SIGNED_BY[name]) throw new Error(`fplay: ${name} is not a shape this page sends`);
  const A = v.addresses;
  // MC and S1 (profile 2 and 3) share the ABI v2 account lists.
  const cq = isV2(v.profile ?? io.pinned()?.profile);
  const citizen = A.of('Citizen', { wallet: v.wallet });
  const base = { actor: v.actor, season: A.season, citizen };
  const holding = () => A.of('Holding', v.holding);
  const province = () => A.of('Province', v.province ?? v.holding);
  switch (name) {
    case 'Join':
      return { wallet: v.wallet, season: A.season, frontier: A.of('Frontier'), citizen,
        joinshard: A.of('JoinShard', { faction: v.faction, shard: joinShardOf(v.wallet) }), ...(v.joinGate ? { join_gate: v.joinGate } : {}) };
    case 'SetSession':
      return { ...base, actor: v.wallet };
    case 'SetVigil':
      return base;
    case 'FileTicket':
      return { ...base, frontier: A.of('Frontier'), province: ticketProvinces(v.sites).map(p => A.of('Province', p)) };
    case 'FileOutpost':
      return { ...base, frontier: A.of('Frontier'), province: ticketProvinces(v.sites).map(p => A.of('Province', p)),
        anchor_holding: A.of('Holding', v.anchor), anchor_province: A.of('Province', v.anchor), slot2_holding: A.of('Holding', v.slot2 ?? v.anchor), slot2_province: A.of('Province', v.slot2 ?? v.anchor) };
    case 'DeclareSiege':
      return { ...base, src_holding: holding(), province: province(), target_holding: A.of('Holding', v.target),
        owner_citizen: v.ownerCitizen, nearby_province: A.of('Province', v.nearby ?? v.holding), holding_province: A.of('Province', v.holding) };
    case 'RetireHost':
      return { actor: v.actor, season: A.season, victim_citizen: citizen, province: province(),
        captured_holding: A.of('Holding', v.captured), home_holding: A.of('Holding', v.home) };
    case 'PlaceHome':
      return { ...base, frontier: A.of('Frontier'), province: province(), holding: holding(),
        joinshard: A.of('JoinShard', { faction: v.faction, shard: joinShardOf(v.wallet) }) };
    case 'Harvest': case 'Train':
      return { ...base, holding: holding(), ...(cq ? { province: province() } : {}) };
    case 'Build':
      return { ...base, holding: holding(), ...(cq || v.item === ITEM_WALLS ? { province: province() } : {}) };
    case 'Muster': case 'Dissolve': case 'Garrison': case 'Explore': case 'Depart':
      return { ...base, holding: holding(), province: province(), ...(cq && ['Dissolve','Explore','Depart'].includes(name) ? { holding_province: A.of('Province', v.holding) } : {}) };
    // S1 (fclient ix::v2): `at` is {p, q, tile} of the vault or structure; a place is {kind: 'holding', p, q, site} or {kind: 'vault', p, q, tile}.
    case 'BuildVault':
      return { ...base, holding: holding(), holding_province: A.of('Province', v.holding), province: A.of('Province', v.at), vault: A.of('Vault', v.at) };
    case 'BuildStructure':
      return { ...base, holding: holding(), holding_province: A.of('Province', v.holding), province: A.of('Province', v.at), structure: A.of('Structure', v.at) };
    case 'FortGarrison':
      return { ...base, holding: holding(), province: A.of('Province', v.holding), structure: A.of('Structure', { p: v.holding.p, q: v.holding.q, tile: v.tile }) };
    case 'SendCaravan':
      return { ...base, src: placeAddress(A, v.src), dst: placeAddress(A, v.dst), caravan: A.of('Caravan', { ownerTag: citizenTag(citizen), seq: v.seq }),
        path_province: v.provinces.map(p => A.of('Province', p)) };
    case 'RaidCaravan':
      return { ...base, caravan: v.caravan, raider_holding: A.of('Holding', v.raider), dst: v.dst ? placeAddress(A, v.dst) : A.of('Holding', v.raider),
        path_province: raidProvinces(v).provinces.map(p => A.of('Province', p)) };
    case 'Propose': {
      const nation = A.of('Nation', { faction: v.faction });
      return { ...base, nation, target: v.target ?? nation };
    }
    case 'Vote':
      return { ...base, nation: A.of('Nation', { faction: v.faction }) };
    // S2 (fclient ix::v2): `source` is a place ({kind: 'vault', p, q, tile} or
    // {kind: 'holding', p, q, site}); an issue is {tag, seq}, a lot {tag, seq}
    // (its seed: the first holder's tag).
    case 'IssueTickets':
      return { ...base, holding: holding(), holding_province: A.of('Province', v.holding), source: placeAddress(A, v.source),
        issue: A.of('Issue', { tag: v.issuerTag, seq: v.seq }), lot: A.of('Lot', { tag: v.issuerTag, seq: v.lotSeq }) };
    case 'GiveLot':
      return { ...base, lot: A.of('Lot', v.lot), issue: A.of('Issue', v.issue), source: placeAddress(A, v.source),
        recipient: v.recipient, to_lot: A.of('Lot', v.toLot) };
    // S2 (2b): `at` the vault {p, q, tile}; the opener's deposit lot is
    // seeded by its tag (`issuerTag`) and its issue `seq`.
    case 'OpenShares':
      return { ...base, holding: holding(), holding_province: A.of('Province', v.holding), vault: A.of('Vault', v.at),
        issue: A.of('Issue', { tag: v.issuerTag, seq: v.seq }), lot: A.of('Lot', { tag: v.issuerTag, seq: depositSeq(v.issuerTag, v.seq) }) };
    // `lot` {tag, seq} the holder's, `issue` {tag, seq}, `vault` {p, q, tile},
    // `dst` a place, `seq` the holder's caravan, `provinces` the walk's.
    case 'WithdrawShares':
      return { ...base, lot: A.of('Lot', v.lot), issue: A.of('Issue', v.issue), src: A.of('Vault', v.vault), dst: placeAddress(A, v.dst),
        caravan: A.of('Caravan', { ownerTag: citizenTag(citizen), seq: v.seq }), path_province: v.provinces.map(p => A.of('Province', p)) };
    // S2 (2c): `lot` and `issue` {tag, seq}, `vault` {p, q, tile}; a
    // withdrawal is WithdrawShares' shape.
    case 'ClaimReceipt':
      return { ...base, lot: A.of('Lot', v.lot), issue: A.of('Issue', v.issue), vault: A.of('Vault', v.vault) };
    case 'WithdrawReceipt':
      return { ...base, lot: A.of('Lot', v.lot), issue: A.of('Issue', v.issue), src: A.of('Vault', v.vault), dst: placeAddress(A, v.dst),
        caravan: A.of('Caravan', { ownerTag: citizenTag(citizen), seq: v.seq }), path_province: v.provinces.map(p => A.of('Province', p)) };
    case 'CloseLot':
      return { ...base, issue: A.of('Issue', v.issue), source: placeAddress(A, v.source), issue_rent_to: v.issueRentTo,
        ...(v.lot ? { lot: A.of('Lot', v.lot), rent_to: v.rentTo } : {}) };
    case 'SettleExplore':
      return { season: A.season, holding: holding(), citizen, seedcache_or_archive: v.settle.seed, anchor_or_archive: v.settle.anchor };
    case 'SettleTransit': {
      const s = v.settle;
      // v1.7 (I-56): the camp's winner names its owner's Citizen as the optional 14th account.
      return { season: A.season, holding: holding(), dest_province: A.of('Province', s.dest), inputs: A.of('ClashInputs', { ...s.dest, bell: s.arriveBell }),
        slot: A.of('ArrivalSlot', { ...s.dest, bell: s.arriveBell, faction: s.faction, i: s.slotIndex ?? 0 }), home_province: A.of('Province', v.holding),
        anchor_or_archive: s.anchor, slot_beneficiary: s.slotBeneficiary, resolver: s.resolver, holding_rent_payer: s.rentPayer, settle_beneficiary: s.beneficiary,
        ...(s.campCitizen ? { citizen: s.campCitizen } : {}), ...(cq ? { holding_province: A.of('Province', v.holding), ...(s.prevHome ? { prev_home_holding: A.of('Holding', s.prevHome) } : {}) } : {}) };
    }
    default:
      throw new Error(`fplay: ${name} is not a shape this page sends`);
  }
}

/** The account of a caravan's origin or destination. */
export const placeAddress = (A, pl) => (pl.kind === 'vault' ? A.of('Vault', pl) : A.of('Holding', pl));

/**
 * A place's instruction data (`dst_kind, dst_p, dst_q, dst_at, dst_gen`):
 * a holding's site or a vault's tile, and its generation.
 */
export const placeData = pl => ({ dst_kind: PLACE_KIND[pl.kind], dst_p: pl.p, dst_q: pl.q, dst_at: pl.kind === 'vault' ? pl.tile : pl.site, dst_gen: pl.gen ?? 0 });

/**
 * fclient `raid_provinces`: a take names the raid's Province first, then the
 * new walk's others, then the old route's others (`n_path` = the first
 * two parts); a burn names the raid's alone.
 */
export function raidProvinces({ raid, dst = null, pathProvinces = [], oldRoute = [] }) {
  const same = (a, b) => a.p === b.p && a.q === b.q;
  if (!dst) return { provinces: [raid], nPath: 1 };
  const out = [raid, ...pathProvinces.filter(x => !same(x, raid))];
  const nPath = out.length;
  for (const o of oldRoute) if (!out.some(x => same(x, o))) out.push(o);
  return { provinces: out, nPath };
}

/** Eight whole amounts as SendCaravan's `cargo` bytes (u32 LE each). */
export function cargoBytes(cargo) {
  const out = new Uint8Array(32), dv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) dv.setUint32(i * 4, Number(cargo[i] ?? 0), true);
  return out;
}

/**
 * The message a shape would be (no signature): `{message, expected, budget,
 * signers}` for `feePayer` and `blockhash`. `signers` are the instruction's
 * own signing keys besides the fee payer.
 */
export function buildShape({ programId, name, accounts, fields, feePayer, blockhash, profile = 1 }) {
  const expected = frontierIx(programId, name, { ...accounts, payer: feePayer }, fields, profile);
  const message = compileMessage({ feePayer, recentBlockhash: blockhash, instructions: [...budgetPrefix(name, { profile }), expected] });
  const signers = [];
  for (const k of expected.keys) if (k.isSigner && k.pubkey !== feePayer && !signers.includes(k.pubkey)) signers.push(k.pubkey);
  return { message, expected, budget: budgetOf(name, profile), signers };
}

/**
 * Send one shape through the relay:
 *   {name, accounts, fields, signer: {session}|{wallet}|null, requester?: session key,
 *    citizen?: Citizen address (a settle's requester), invite?}
 * (`accounts` and `fields` may be functions of the relay's fee payer.)
 * → `{ok: true, signature, message, feePayer, lastValidBlockHeight, bytes}` or `{ok: false, code, error, …}`.
 */
export async function submit(req) {
  const pin = io.pinned();
  if (!pin) return fail('NoPin');
  const info = await io.relayInfo();
  if (!info.ok) return info;
  const { feePayer, blockhash, lastValidBlockHeight } = info;
  let built;
  try {
    // A settle names the fee payer inside its accounts and data (its beneficiary): functions of it.
    const accounts = typeof req.accounts === 'function' ? req.accounts(feePayer) : req.accounts;
    const fields = typeof req.fields === 'function' ? req.fields(feePayer) : (req.fields ?? {});
    built = buildShape({ programId: pin.programId, name: req.name, accounts, fields, feePayer, blockhash, profile: pin.profile });
  } catch (e) {
    return fail('BuildFailed', String(e.message ?? e));
  }
  const { message, expected, budget, signers } = built;
  // A gated Join also names the gate key, which the relay signs (§8.3).
  const problems = io.messageProblems(message, { feePayer, blockhash, tag: expected.data[0], signers, cuLimit: budget.cuLimit, loadedLimit: budget.loadedLimit, expected });
  if (problems.length) return fail('MessageRefused', problems.join('; '), { problems });
  let wire;
  const extra = {};
  try {
    if (req.signer?.session) {
      const key = req.signer.session;
      wire = wireTransaction(message, { [key.publicKey]: await key.sign(message) });
    } else if (req.signer?.wallet) {
      wire = await req.signer.wallet.signTransaction(wireTransaction(message));
      if (!io.sameMessage(message, wire)) return fail('WalletAlteredMessage');
    } else {
      wire = wireTransaction(message);
      if (req.requester) {
        extra.requester = req.requester.publicKey;
        extra.requesterSig = toBase64(await req.requester.sign(message));
        if (req.citizen) extra.citizen = req.citizen;
      }
    }
  } catch (e) {
    return fail(e?.code ?? 'SignFailed', String(e?.message ?? e));
  }
  if (wire.length > budget.txCeiling) return fail('TooLarge', `${wire.length} B over the ${budget.txCeiling}-B ceiling of ${req.name}`);
  const r = req.name === 'Join'
    ? await io.sendJoin(wire, req.invite ?? null, { extra: { lastValidBlockHeight } })
    : await io.sendTx(wire, { extra: { ...extra, lastValidBlockHeight } });
  if (!r.ok) return r;
  // The answer names the transaction by its first signature: the fee
  // payer's. It must sign exactly the message this page built and signed.
  let sig;
  try { sig = fromBase58(String(r.signature)); } catch { sig = null; }
  if (!sig || sig.length !== 64 || !(await verify(feePayer, message, sig))) return fail('RelayMessageChanged');
  return { ok: true, signature: r.signature, message, feePayer, lastValidBlockHeight, bytes: wire.length };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Follow a sent transaction: `{ok: true, state: 'landed', slot}` or
 * `{ok: false, state: 'failed'|'expired'|'unknown', code, programCode?}`.
 */
export async function track(signature, { tries = 40, every = 1500, wait = sleep } = {}) {
  for (let i = 0; i < tries; i++) {
    const r = await io.txStatus(signature);
    if (r.ok && r.state === 'landed') return { ok: true, state: 'landed', slot: r.slot };
    if (r.ok && r.state === 'failed') return { ok: false, state: 'failed', code: r.code ?? 'TransactionFailed', programCode: r.programCode };
    if (r.ok && r.state === 'expired') return { ok: false, state: 'expired', code: 'Expired' };
    if (i + 1 < tries) await wait(every);
  }
  return { ok: false, state: 'unknown', code: 'Unconfirmed' };
}
