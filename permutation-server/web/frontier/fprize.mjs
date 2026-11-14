// The season's prize pool on the page (permutation-prize; テストUSDC on the
// local test chain, no value): what the relay reads from the chain
// (GET /f/prize), the test-token faucet, the paid Join over x402
// (sdk prize.mjs `joinViaX402`: one request, the 402's price, the paid
// retry signed by the wallet), the published achievements ledger and the
// ESTIMATED split. A season without a pool answers 404 NoPrizePool: the
// page then says nothing about prizes that is not true.
//
// NFT pass (experimental, permutation-prize `nft-experimental`): while an
// NFT is played (FS.resident), the pool is read with the pass's Entry and
// NFT Citizen (`GET /f/prize?asset=`: `claimedBy` and `claimGeneration`
// together), and its share is claimed with ClaimResident signed by the
// pass's current owner for the generation read fresh at that moment
// (`claimPass`). **New pass deposits are disabled**: `payAndJoinResident`
// stays for the day the pass refund right is decided, but the program
// refuses PayResident at dispatch, the relay refuses the shape, the SDK
// refuses to sign it and the controller refuses before reading
// (ResidentDepositsDisabled). Whether the signer is the owner now is the
// program's judgement from the live asset; this page only refuses to offer
// a claim it already knows the program would refuse (`passClaimModel`), and
// counts a claimed Entry as this owner's only when it names this wallet at
// this generation (`claimIsMine`). A pass's refund is undecided and never
// offered.
import * as io from './fchainio.mjs';
import { claimResidentIx, joinResidentViaX402, joinViaX402 } from '../sdk/frontier/prize.mjs';
import { compileMessage, wireTransaction } from '../sdk/solana-tx.mjs';
import { decode as fromBase58 } from '../sdk/base58.mjs';
import { fromHex, toBase64 } from '../sdk/bytes.mjs';
import { verify } from '../session.mjs';

/** Base units → a number string with up to `decimals` fraction digits ("25", "7.5"). */
export function tokenUnits(v, decimals = 6) {
  const x = BigInt(v ?? 0);
  const s = String(x < 0n ? -x : x).padStart(decimals + 1, '0');
  const frac = s.slice(-decimals).replace(/0+$/, '');
  return `${x < 0n ? '-' : ''}${s.slice(0, -decimals)}${frac ? `.${frac}` : ''}`;
}

/**
 * GET /f/prize[?wallet][&asset]: `{ok, pool}` with the pool view (and, for
 * `asset`, the pass's `pass` block), `{ok: true, pool: null}` for a season
 * without one.
 */
export async function loadPrize(wallet = null, { asset = null, ...opts } = {}) {
  const q = [wallet ? `wallet=${encodeURIComponent(wallet)}` : '', asset ? `asset=${encodeURIComponent(asset)}` : ''].filter(Boolean).join('&');
  const r = await io.request('GET', `/f/prize${q ? `?${q}` : ''}`, opts);
  if (!r.ok) return r.code === 'NoPrizePool' || r.httpStatus === 404 ? { ok: true, pool: null } : r;
  return { ok: true, pool: r };
}

/** POST /f/faucet: test tokens for `wallet`, once. */
export const faucet = (wallet, opts) => io.request('POST', '/f/faucet', { ...opts, body: { wallet } });

/** GET /f/prize/ledger: the published ledger, or `{ok: true, ledger: null}` before it is published. */
export async function loadLedger(opts) {
  const r = await io.request('GET', '/f/prize/ledger', opts);
  if (!r.ok) return r.code === 'LedgerNotPublished' || r.httpStatus === 404 ? { ok: true, ledger: null } : r;
  return { ok: true, ledger: r };
}

/**
 * The paid Join: `wallet` is the connected wallet (`{address,
 * signTransaction}`), `session` the in-game key. Returns `{ok, signature}`
 * or a failure `{ok: false, code, error}` (the relay's 402 reason:
 * InsufficientFunds, AlreadyPaid, InvalidPayment…).
 */
export async function payAndJoin({ wallet, faction, session, sessionExpiry, maxFee, fetch: f }) {
  try {
    const r = await joinViaX402(io.relay(), { wallet: wallet.address, signTransaction: w => wallet.signTransaction(w), faction, session: session.publicKeyBytes, sessionExpiry, maxFee, ...(f ? { fetch: f } : {}) });
    return { ok: true, signature: r.signature, paymentResponse: r.paymentResponse, paid: r.body?.paid ?? null, pool: r.body?.pool ?? null };
  } catch (e) {
    return io.fail(e?.code ?? 'X402Failed', String(e?.message ?? e), { httpStatus: e?.status ?? 0 });
  }
}

/**
 * NFT pass (experimental): the paid JoinResident — the connected wallet
 * (`wallet`, the pass's owner now) pays the fee and joins `faction` with
 * the pass `asset` at `generation` (read fresh by the caller);
 * `residentProgram` is the season's policy's (FS.nfts.policy).
 */
export async function payAndJoinResident({ wallet, asset, generation, faction, residentProgram, maxFee, fetch: f }) {
  try {
    const r = await joinResidentViaX402(io.relay(), { owner: wallet.address, signTransaction: w => wallet.signTransaction(w), asset, generation, faction, residentProgram, maxFee, ...(f ? { fetch: f } : {}) });
    return { ok: true, signature: r.signature, paymentResponse: r.paymentResponse, paid: r.body?.paid ?? null, pool: r.body?.pool ?? null, asset: r.body?.asset ?? asset };
  } catch (e) {
    return io.fail(e?.code ?? 'X402Failed', String(e?.message ?? e), { httpStatus: e?.status ?? 0 });
  }
}

/**
 * NFT pass (experimental): ClaimResident through the relay (POST
 * /f/prize/claim), as fplay.submit sends a shape — the relay's fee payer and
 * blockhash, one instruction, the wallet's signature over exactly this
 * message, the relay's answer checked to be its fee payer's signature of it.
 *   wallet      the connected wallet (`{address, signTransaction}`): the pass's owner now
 *   prize       `{program, pool, vault, mint}` (FS.prize)
 *   id          the pass played (FS.resident: asset, citizen, proof)
 *   generation  the resident program's generation read fresh by the caller
 *   share       the ledger's member line of the pass (`passShareOf`)
 * → `{ok: true, signature, amount, already}` or `{ok: false, code, …}`.
 */
export async function claimPass({ wallet, prize, id, generation, share, fetch: f }) {
  const opts = f ? { fetch: f } : {};
  // Before the POST nothing has left this page: these failures are definite (`notSent: true`).
  const notSent = r => ({ ...r, notSent: true });
  const info = await io.relayInfo(opts);
  if (!info.ok) return notSent(info);
  let ix;
  try {
    ix = claimResidentIx({ prize: { program: prize.program, pool: prize.pool, vault: prize.vault, mint: prize.mint }, owner: wallet.address, asset: id.asset,
      citizen: id.citizen, link: id.proof.link, policy: id.proof.policy, resident: id.proof.resident,
      generation, nation: share.nation, points: BigInt(share.points), proof: share.proof.map(fromHex) });
  } catch (e) {
    return notSent(io.fail('BuildFailed', String(e?.message ?? e)));
  }
  const message = compileMessage({ feePayer: info.feePayer, recentBlockhash: info.blockhash, instructions: [ix] });
  let wire;
  try {
    wire = await wallet.signTransaction(wireTransaction(message));
  } catch (e) {
    return notSent(io.fail(e?.code ?? 'SignFailed', String(e?.message ?? e)));
  }
  if (!io.sameMessage(message, wire)) return notSent(io.fail('WalletAlteredMessage'));
  // From here on the signed bytes may have reached the relay and the chain:
  // no failure below is definite (`notSent: false`), whatever the answer.
  const r = await io.request('POST', '/f/prize/claim', { ...opts, body: { tx: toBase64(wire) } });
  if (!r.ok) return { ...r, notSent: false };
  if (r.already) {
    // The relay answered with an EARLIER claim's signature: it signs another
    // message, so it is not checked against this one, and this message was
    // never sent. Success is only what the pass's Entry says now, and only
    // if the Entry names THIS owner at THIS generation (claimIsMine); an
    // Entry claimed by an earlier owner or generation is that owner's claim,
    // not this one's success. Otherwise the outcome is unknown (never
    // "failed").
    const p = await loadPrize(wallet.address, { asset: id.asset, ...opts });
    const e = p.ok && p.pool?.pass?.asset === id.asset ? p.pool.pass.entry : null;
    if (e?.claimed && !claimIsMine(e, wallet.address, generation)) {
      return { ok: false, notSent: false, code: 'AlreadyClaimedByPriorOwner', error: 'already claimed by another owner or at another generation', httpStatus: 0,
        priorClaim: { claimedBy: e.claimedBy ?? null, claimGeneration: e.claimGeneration ?? null }, signature: r.signature ?? null };
    }
    const landed = !!e?.claimed;
    return { ok: true, already: true, sent: false, landed, signature: r.signature ?? null, amount: landed ? e.claimAmount : null };
  }
  let sig;
  try { sig = fromBase58(String(r.signature)); } catch { sig = null; }
  if (!sig || sig.length !== 64 || !(await verify(info.feePayer, message, sig))) return { ...io.fail('RelayMessageChanged'), notSent: false, signature: r.signature ?? null };
  return { ok: true, sent: true, landed: false, signature: r.signature, amount: r.amount ?? null, already: false };
}

/**
 * The page's record of a claim attempt's outcome, from `claimPass`'s result
 * `r` and, when the transaction was sent, the tracked status `t`
 * (fplay.track). `failed` is reserved for a definite failure: one before the
 * POST (`r.notSent`: relay info, build, signing, the pre-signing check) or a
 * failure the chain proved (`t.state === 'failed'`). Everything else that
 * did not land is `unknown`: a refused or lost answer after the POST, an
 * `already` whose Entry does not read claimed, an expired or unconfirmed
 * track. An unknown outcome is never offered for resubmission by the page;
 * the relay's own pending lookup answers the next attempt.
 */
/**
 * Whether a claimed pass Entry (the relay's view: `claimedBy`,
 * `claimGeneration`) is the claim of `wallet` signed at `generation`. An
 * Entry claimed by an earlier owner, or by the same wallet at another
 * generation (sold and bought back since), is not this claim.
 */
export const claimIsMine = (entry, wallet, generation) => !!entry?.claimed && !!wallet && Number.isInteger(generation)
  && entry.claimedBy === wallet && entry.claimGeneration === generation;

export function claimOutcome(r, t = null) {
  if (!r?.ok) {
    const code = r?.code ?? 'ClaimFailed';
    // Claimed by an earlier owner or generation (the relay's or the page's finding): closed, nothing to send or resend.
    if (code === 'AlreadyClaimedByPriorOwner') return { state: 'claimedByOther', notSent: !!r?.notSent, code };
    return r?.notSent ? { state: 'failed', notSent: true, code } : { state: 'unknown', notSent: false, code };
  }
  if (r.already) return r.landed ? { state: 'landed', notSent: false, code: null } : { state: 'unknown', notSent: false, code: 'ClaimOutcomeUnknown' };
  if (!t) return { state: 'pending', notSent: false, code: null };
  if (t.ok) return { state: 'landed', notSent: false, code: null };
  return t.state === 'failed'
    ? { state: 'failed', notSent: false, code: t.code ?? 'TransactionFailed' }
    : { state: 'unknown', notSent: false, code: t.code ?? 'Unconfirmed' };
}

/**
 * A points value of the ledger (a JSON number or a decimal string) as the
 * exact u64 the program hashes into the leaf: a safe integer number, a
 * decimal string, or a bigint, within 0..=2^64−1; null for anything else (a
 * float, a negative, a number above 2^53 — which JSON cannot carry exactly —,
 * NaN, an empty or non-decimal string). Never goes through Number.
 */
export function pointsOf(v) {
  let b;
  if (typeof v === 'bigint') b = v;
  else if (typeof v === 'number') { if (!Number.isSafeInteger(v)) return null; b = BigInt(v); }
  else if (typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v)) b = BigInt(v);
  else return null;
  return b >= 0n && b <= 0xffff_ffff_ffff_ffffn ? b : null;
}

/** A relay amount (a decimal string) as a bigint, or null when it is not one. */
const big = v => (typeof v === 'bigint' ? v : typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v) ? BigInt(v) : typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null);

/**
 * The page's pass epoch: counted up on every real change of the wallet or
 * the pass played (connect, switch, NFT login, logout). An operation begun
 * in an earlier epoch is stale even when the same wallet and pass come
 * back (A → B → A, logout and login again).
 */
export const nextPassEpoch = FS => { FS.passEpoch = (FS.passEpoch ?? 0) + 1; return FS.passEpoch; };
/** The identity of one pass claim in flight: the wallet that signs, the pass, the epoch they were seen in, the generation signed once known. */
export const claimOpOf = (walletAddress, asset, epoch, generation = null) => ({ wallet: walletAddress, asset, epoch, generation });
/**
 * Whether `op` is still the page's: the same epoch (no wallet or pass change
 * since, not even away and back), the same wallet connected, the same pass
 * played, and — once the operation knows the generation it signed — the
 * page's generation of the pass unchanged (a transfer observed meanwhile
 * makes the operation stale). A stale operation's completion, success or
 * failure, must never be written into the page's state.
 */
export function claimOpLive(op, FS) {
  if (!op) return false;
  if ((FS?.passEpoch ?? 0) !== (op.epoch ?? 0)) return false;
  if ((FS?.wallet?.address ?? null) !== op.wallet || (FS?.resident?.asset ?? null) !== op.asset) return false;
  if (op.generation !== null && op.generation !== undefined && (FS?.resident?.generation ?? null) !== op.generation) return false;
  return true;
}

/**
 * The page's model of the pool: amounts in whole test USDC as strings, the
 * split, and after the end the area, the winners and whether the result is
 * final (the chain's, never the page's own count).
 */
export function prizeModel(pool) {
  if (!pool) return null;
  const d = pool.decimals ?? 6;
  const u = v => tokenUnits(v, d);
  return {
    fee: u(pool.fee), prizePct: pool.prizeBps / 100, opsPct: pool.opsBps / 100, entries: pool.entries,
    collected: u(pool.collected), prize: u(pool.prize), ops: u(pool.ops),
    feeToPrize: u(BigInt(pool.fee) - BigInt(pool.fee) * BigInt(pool.opsBps) / 10_000n), feeToOps: u(BigInt(pool.fee) * BigInt(pool.opsBps) / 10_000n),
    state: pool.state, counting: pool.state === 'open' && pool.counted > 0, final: pool.state !== 'open',
    // The game's keeps at the end (the map may grow; the pool's own figure is display only).
    counted: pool.counted, keepsToCount: pool.keepsToCount ?? pool.expectedKeeps,
    area: pool.area ? pool.area.map((provinces, faction) => ({ faction, provinces, winner: !!pool.winners?.includes(faction) })) : null,
    winners: pool.winners ?? null,
    // Shares posted on chain (the deferred step): how many claims were paid, and how much.
    posted: pool.shares ? { mode: pool.shares.mode, claims: pool.shares.claims, claimed: u(pool.shares.claimed) } : null,
    wallet: pool.wallet ? { address: pool.wallet.address, balance: u(pool.wallet.balance), paid: !!pool.wallet.entry, canPay: BigInt(pool.wallet.balance) >= BigInt(pool.fee),
      faction: pool.wallet.faction, claimed: !!pool.wallet.entry?.claimed, claimAmount: pool.wallet.entry ? u(pool.wallet.entry.claimAmount) : null } : null,
  };
}

/** NFT pass deposits (PayResident) are disabled everywhere until the pass refund right is decided (permutation-prize NFT-PRIZE.md §8.3). */
export const PASS_DEPOSITS_ENABLED = false;

/**
 * How a pass enters this season (the NFT login's branch; pure):
 *   play             its NFT Citizen exists: nothing to send
 *   joinInvite       no prize pool: the plain JoinResident through POST /f/join (an invite when gated), as before
 *   joinPaid         a pool, and the pass's NFT Entry already exists (paid before deposits were refused): the plain
 *                    JoinResident through the relay's settled x402 path — no PayResident, no fee, an existing right
 *   depositDisabled  a pool, and no Entry: a new deposit would be needed; refused (ResidentDepositsDisabled)
 * `entry` is the pass's Entry from GET /f/prize?asset= (prize-view.mjs `passEntryView`), null when there is none.
 */
export function passJoinPlan({ prize, entry = null, joined = false } = {}) {
  if (joined) return 'play';
  if (!prize) return 'joinInvite';
  return entry && entry.paid !== undefined ? 'joinPaid' : 'depositDisabled';
}

/**
 * The ledger's share line of the pass `asset`: `{nation, points (bigint,
 * exact), proof: [hex…]}`, or null when there is none or the line is not
 * one the program could accept (no proof, a nation outside 0–5, points that
 * are not an exact u64).
 */
export function passShareOf(ledger, asset) {
  const m = (ledger?.shares?.members ?? []).find(x => x.asset === asset || x.wallet === `pass:${asset}`);
  if (!m || !Array.isArray(m.proof) || !Number.isInteger(m.nation) || m.nation < 0 || m.nation > 5) return null;
  const points = pointsOf(m.points);
  return points === null ? null : { nation: m.nation, points, proof: m.proof };
}

/**
 * NFT pass (experimental): what the 賞金 panel says and offers for the pass
 * played, from the relay's pool view (`prize.pass`, read for FS.resident's
 * asset), the published ledger and the page's own pending claim
 * (`prizePass`). Null when no pass is played or the season has no pool.
 *
 * `state`: unpaid (no Entry for the pass) | claimed | pending (this page
 * sent a claim and waits, or its outcome is unknown: `pending.state` says
 * which) | notPosted (the shares are not on chain yet) | refund (the pool
 * refunds: a pass's refund is undecided, nothing is offered) | noShare (the
 * ledger gives the pass no points) | notHeld (the relay reports no
 * generation: the pass left this wallet) | claimable. Only `claimable`
 * carries `share` (points as an exact bigint) and `offer` (the estimate,
 * points as a decimal string); the button is shown then only. A pending or
 * unknown claim of this pass is kept whatever the generation (its
 * transaction may still land); a failed one of another generation, and any
 * record of another pass or another wallet, is stale and dropped.
 */
export function passClaimModel({ prize, prizeLedger = null, resident = null, prizePass = null, wallet = null } = {}) {
  if (!resident || !prize) return null;
  const asset = resident.asset;
  const d = prize.decimals ?? 6;
  const u = v => tokenUnits(v, d);
  const p = prize.pass && prize.pass.asset === asset ? prize.pass : null;
  const e = p?.entry ?? null;
  const sameWallet = !prizePass?.wallet || !wallet?.address || prizePass.wallet === wallet.address;
  // Open: the offer is held back — a sent claim, an unknown outcome, or a
  // claim found to be an earlier owner's (closed; nothing to resend).
  const open = prizePass?.state === 'pending' || prizePass?.state === 'unknown' || prizePass?.state === 'claimedByOther';
  const pend = prizePass && sameWallet && prizePass.asset === asset && (open || prizePass.generation === resident.generation) ? prizePass : null;
  const out = {
    asset, generation: Number.isInteger(resident.generation) ? resident.generation : null, faction: p?.faction ?? null,
    entry: e ? { paid: u(e.paid), paidBy: e.paidBy ?? null, payGeneration: e.payGeneration ?? null, claimed: !!e.claimed, claimedBy: e.claimedBy ?? null,
      claimGeneration: Number.isInteger(e.claimGeneration) ? e.claimGeneration : null,
      // The claim is this viewer's only if the Entry names this wallet at the generation the pass has now.
      claimedByOther: !!e.claimed && !claimIsMine(e, wallet?.address ?? null, resident.generation),
      claimAmount: e.claimed ? u(e.claimAmount) : null, nation: e.nation ?? null } : null,
    pending: pend ? { state: pend.state, signature: pend.signature ?? null, code: pend.code ?? null, amount: big(pend.amount) !== null ? u(big(pend.amount)) : null, priorClaim: pend.priorClaim ?? null } : null,
    mode: prize.shares?.mode ?? null, share: null, offer: null,
    // Whether a pass without an Entry could pay now: never while the pass refund right is undecided (§8.3).
    depositsOpen: PASS_DEPOSITS_ENABLED,
  };
  let state;
  if (!e) state = 'unpaid';
  else if (e.claimed) state = 'claimed';
  else if (pend && open) state = 'pending';
  else if (prize.state !== 'shares' || !prize.shares) state = 'notPosted';
  else if (prize.shares.mode === 'refund') state = 'refund';
  else {
    const share = passShareOf(prizeLedger, asset);
    const winners = prize.winners ?? [];
    if (!share || !winners.includes(share.nation) || share.points <= 0n) state = 'noShare';
    else if (out.generation === null) state = 'notHeld';
    else {
      state = 'claimable';
      out.share = share;
      // The program's arithmetic, exactly: prize / shareNations × points / total (all u64).
      const total = big(prize.shares.totalPoints?.[share.nation] ?? null);
      const nations = big(prize.shares.shareNations ?? null);
      const prizeAmount = big(prize.prize);
      const amount = total !== null && nations !== null && prizeAmount !== null && total > 0n && nations > 0n && share.points <= total
        ? prizeAmount / nations * share.points / total : null;
      out.offer = { nation: share.nation, points: share.points.toString(), amount: amount === null ? null : u(amount) };
    }
  }
  return { ...out, state };
}

/**
 * The ledger for the page: every line with its kind, player, province,
 * quantity, bell and first signature; the kinds that cannot be derived, with
 * the missing record; the ESTIMATED split (never a transfer).
 */
export function ledgerModel(ledger, { wallet = null, decimals = 6 } = {}) {
  if (!ledger) return null;
  const lines = (ledger.lines ?? []).map(l => ({ kind: l.kind, wallet: l.wallet, nation: l.nation, p: l.province.p, q: l.province.q, quantity: l.quantity, unit: l.unit, bell: l.bell,
    points: l.points ?? 0, eligible: !!l.eligible, invited: l.player === 'operatorInvited', signature: l.signatures?.[0] ?? null, mine: !!wallet && l.wallet === wallet }));
  return {
    provisional: ledger.provisional !== false, provisionalRules: ledger.provisionalRules ?? [],
    attackers: lines.filter(l => l.kind === 'capture'), supporters: lines.filter(l => l.kind === 'reinforcement'),
    notDerivable: Object.entries(ledger.kinds ?? {}).filter(([, k]) => !k.derivable).map(([kind, k]) => ({ kind, reason: k.reason, missingRecord: k.missingRecord })),
    estimate: (ledger.estimate?.split ?? []).map(s => ({ wallet: s.wallet, nation: s.nation, points: s.points, amount: tokenUnits(s.amount, decimals), mine: !!wallet && s.wallet === wallet })),
    mode: ledger.shares?.mode ?? null,
    // Whether any line is an AI citizen's or a script bot's (the page then says what that means for the winner).
    hasInvited: lines.some(l => l.invited),
  };
}
