// Custody of deposited test USDC (docs/agent-wallet/DESIGN.md §6; the
// owner's decision of 2026-10-17: an operator-held account plus the ledger,
// local test tokens only, to be replaced by an on-chain vault behind the
// same interface before any live money).
//
// * Deposit: the owner sends test USDC to the custody token account in a
//   transaction the owner signs; the relay credits the agent after reading
//   that transaction from the chain: confirmed, no error, the owner signed,
//   and its top-level SPL TransferChecked instructions of the custody mint
//   into the custody account, with the owner as authority, sum to the
//   amount (an instruction that ran without error moved its tokens). When
//   the node reports token balances (a full validator; the local
//   frontier-localnet does not), the custody account's gain must agree.
// * Withdrawal: the custody key signs a TransferChecked to the agent's fixed
//   payout (the owner's associated token account), a relay payer pays the
//   fee. The signature is known (and recorded) before the bytes are sent, so
//   a timeout leaves a withdrawal whose outcome `status` can still decide.
import { PublicKey } from '@solana/web3.js';
import { decode as fromBase58, encode as base58 } from '../../../client/src/base58.mjs';
import { ata, decodeTokenAccount, TOKEN_PROGRAM } from '../../../client/src/frontier/prize.mjs';
import { ASSOCIATED_TOKEN_PROGRAM, createAtaIdempotentIx } from '../../../client/src/player.mjs';
import { SYSTEM_PROGRAM } from '../../../client/src/frontier/addresses.mjs';
import { baseFee, rent } from '../../../client/src/frontier/fees.mjs';
import { compileMessage, wireTransaction } from '../../../client/src/solana-tx.mjs';
import { signTalk } from '../../../client/src/talk-node.mjs';
import { AgentError, ERR } from './contract.mjs';

/** SPL Token TransferChecked (tag 12): `amount` of `mint` (`decimals`) from `source` to `dest`, signed by `authority`. */
export function transferCheckedIx({ source, mint, dest, authority, amount, decimals }) {
  const data = new Uint8Array(10);
  data[0] = 12;
  new DataView(data.buffer).setBigUint64(1, BigInt(amount), true);
  data[9] = decimals;
  return { programId: TOKEN_PROGRAM, data, keys: [
    { pubkey: source, isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: dest, isSigner: false, isWritable: true }, { pubkey: authority, isSigner: true, isWritable: false }] };
}

const keyOf = k => (typeof k === 'string' ? k : k?.pubkey ? new PublicKey(k.pubkey).toBase58() : new PublicKey(k).toBase58());
const TRANSFER_CHECKED = 12;

/** A transaction message's instructions as `{programIdIndex, accountKeyIndexes, data: Uint8Array}` (web3.js objects or the RPC's JSON). */
function compiledIxs(msg) {
  if (Array.isArray(msg.compiledInstructions)) return msg.compiledInstructions.map(i => ({ programIdIndex: i.programIdIndex, accountKeyIndexes: [...i.accountKeyIndexes], data: Uint8Array.from(i.data) }));
  return (msg.instructions ?? []).map(i => ({ programIdIndex: i.programIdIndex, accountKeyIndexes: [...(i.accountKeyIndexes ?? i.accounts ?? [])], data: typeof i.data === 'string' ? fromBase58(i.data) : Uint8Array.from(i.data ?? []) }));
}

export class Custody {
  #keypair;

  /**
   * `keypair`: the custody authority (web3.js Keypair; never exposed); `pool`: the relay PayerPool (fees);
   * `commitment`: the deposit read's ('confirmed' here as the rest of the relay; a live cluster would use 'finalized');
   * `strictBalances`: refuse a deposit whose node reports no token balances for the custody account (a full
   * validator always does; the local frontier-localnet never does, so it is off there).
   */
  constructor({ connection, keypair, mint, decimals = 6, pool, blockhashes, commitment = 'confirmed', strictBalances = false }) {
    this.connection = connection;
    this.#keypair = keypair;
    this.mint = mint;
    this.decimals = decimals;
    this.pool = pool;
    this.blockhashes = blockhashes;
    this.commitment = commitment;
    this.strictBalances = strictBalances;
    this.authority = keypair.publicKey.toBase58();
    this.account = ata(this.authority, mint);
  }

  /**
   * A sponsored deposit (POST /f/agent/deposit {tx}): the owner's wallet
   * signed a transaction whose fee payer is one of the relay's pool keys and
   * whose instructions are exactly `[createAtaIdempotent(custody)?,
   * TransferChecked(owner's token account → custody, mint, amount,
   * authority = owner, decimals)]`, signed by the fee payer and the owner
   * only, naming no other account. Returns `{feePayer, amount, createsAta,
   * allowance}` (lamports the fee payer may lose beyond the fee: the
   * custody account's rent when the transaction creates it) or throws
   * DepositInvalid. The relay adds its signature only: it cannot change the
   * amount or the destination.
   */
  checkDepositShape(tx, { owner, pool }) {
    const bad = m => { throw new AgentError(ERR.DEPOSIT_INVALID, `deposit refused: ${m}`); };
    const feePayer = tx.signers[0];
    if (!pool.has(feePayer)) bad('the fee payer is not one of this relay\'s (GET /f/relay names one)');
    if (tx.signers.length !== 2 || tx.signers[1] !== owner) bad('the fee payer and the owner sign, nobody else');
    const ixs = tx.instructions;
    if (ixs.length < 1 || ixs.length > 2) bad('one TransferChecked, with at most the custody account\'s creation before it');
    const transfer = ixs[ixs.length - 1];
    const createsAta = ixs.length === 2;
    const keysOf = ix => ix.keys.map(k => k.pubkey);
    if (createsAta) {
      const want = createAtaIdempotentIx({ payer: feePayer, owner: this.authority, mint: this.mint });
      const got = ixs[0];
      if (got.programId !== ASSOCIATED_TOKEN_PROGRAM || got.data.length !== 1 || got.data[0] !== 1 || keysOf(got).join() !== want.keys.map(k => k.pubkey).join()) {
        bad('the first instruction must create the custody account idempotently, paid by the fee payer');
      }
    }
    if (transfer.programId !== TOKEN_PROGRAM || transfer.data.length !== 10 || transfer.data[0] !== 12) bad('the last instruction must be an SPL Token TransferChecked');
    const [source, mint, dest, authority] = keysOf(transfer);
    if (source !== ata(owner, this.mint) || mint !== this.mint || dest !== this.account || authority !== owner) bad('the transfer must move the test USDC from the owner\'s token account into the custody account, by the owner');
    if (transfer.data[9] !== this.decimals) bad(`decimals must be ${this.decimals}`);
    const amount = new DataView(Uint8Array.from(transfer.data).buffer).getBigUint64(1, true);
    if (amount <= 0n) bad('the amount must be positive');
    const used = new Set([feePayer, owner, source, mint, dest, TOKEN_PROGRAM, ...(createsAta ? [ASSOCIATED_TOKEN_PROGRAM, this.account, this.authority, SYSTEM_PROGRAM] : [])]);
    if (tx.accountKeys.length !== used.size || tx.accountKeys.some(k => !used.has(k))) bad('the message names account keys the deposit does not use');
    return { feePayer, amount, createsAta, fee: baseFee(2), allowance: createsAta ? rent(165) : 0n };
  }

  /** The custody token account's balance (base units). */
  async balance() {
    const info = await this.connection.getAccountInfo(new PublicKey(this.account), 'confirmed');
    return info ? decodeTokenAccount(info.data).amount : 0n;
  }

  /**
   * The amount `owner` deposited in transaction `signature` (BigInt > 0), or
   * DepositPending (not confirmed yet, or no result metadata yet) /
   * DepositInvalid. Credited only when all of these hold:
   *   1. the node returns the transaction at `commitment` with its result metadata, and `meta.err` is null;
   *   2. the owner is one of the transaction's required signers;
   *   3. the custody token account is among the transaction's accounts;
   *   4. the sum over the TOP-LEVEL instructions of the classic SPL Token program (no fee extensions) with
   *      tag 12 TransferChecked, mint = the custody mint, destination = the custody account and
   *      authority = the owner is positive — the amount is that sum (a TransferChecked that ran in a
   *      transaction without error moved exactly its amount);
   *   5. when the node reports token balances for the custody account, its gain equals that sum;
   *      with `strictBalances`, a node that reports none is refused.
   * Inner (CPI) instructions and address-lookup-table accounts are not read: such a transaction is
   * not credited. One signature is credited once, ever (the ledger).
   */
  async verifyDeposit(signature, owner) {
    const tx = await this.connection.getTransaction(signature, { commitment: this.commitment, maxSupportedTransactionVersion: 0 });
    if (!tx) throw new AgentError(ERR.DEPOSIT_PENDING, 'the deposit transaction is not confirmed yet; try again shortly', 409);
    if (!tx.meta) throw new AgentError(ERR.DEPOSIT_PENDING, 'the deposit transaction has no result metadata yet; try again shortly', 409);
    if (tx.meta.err !== null && tx.meta.err !== undefined) throw new AgentError(ERR.DEPOSIT_INVALID, 'the deposit transaction failed on chain');
    const msg = tx.transaction.message;
    const keys = (msg.staticAccountKeys ?? msg.accountKeys).map(keyOf);
    const nSigners = msg.header.numRequiredSignatures;
    if (!keys.slice(0, nSigners).includes(owner)) throw new AgentError(ERR.DEPOSIT_INVALID, 'the agent\'s owner did not sign the deposit');
    const custodyIndex = keys.indexOf(this.account);
    if (custodyIndex < 0) throw new AgentError(ERR.DEPOSIT_INVALID, 'the deposit does not touch the custody account');
    let sum = 0n;
    for (const ix of compiledIxs(msg)) {
      if (keys[ix.programIdIndex] !== TOKEN_PROGRAM || ix.data[0] !== TRANSFER_CHECKED || ix.data.length < 10 || ix.accountKeyIndexes.length < 4) continue;
      const [source, mint, dest, authority] = ix.accountKeyIndexes.map(i => keys[i]);
      if (dest !== this.account || mint !== this.mint || authority !== owner || source === this.account) continue;
      sum += new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength).getBigUint64(1, true);
    }
    if (sum <= 0n) throw new AgentError(ERR.DEPOSIT_INVALID, 'the transaction carries no TransferChecked of the test USDC from the owner into the custody account');
    // A node that reports token balances must agree with the instructions.
    const pre = tx.meta.preTokenBalances ?? [];
    const post = tx.meta.postTokenBalances ?? [];
    const reported = post.some(b => b.accountIndex === custodyIndex);
    if (this.strictBalances && !reported) throw new AgentError(ERR.DEPOSIT_INVALID, 'the node reported no token balances for the custody account; this relay requires them');
    if (reported) {
      const amountAt = (list, i) => BigInt(list.find(b => b.accountIndex === i && b.mint === this.mint)?.uiTokenAmount?.amount ?? 0);
      const gained = amountAt(post, custodyIndex) - amountAt(pre, custodyIndex);
      if (gained !== sum) throw new AgentError(ERR.DEPOSIT_INVALID, `the custody account gained ${gained}, not the ${sum} the transfer instructions say`);
    }
    return sum;
  }

  /**
   * Builds and signs a withdrawal of `amount` to `to`'s associated token
   * account; `onSigned({signature, lastValidBlockHeight})` runs before the
   * bytes are sent (the ledger records the signature), then sends. Returns
   * the signature; a send error after `onSigned` is rethrown with
   * `uncertain: true` (the outcome is decided by `status`).
   */
  async withdraw({ to, amount }, { onSigned }) {
    const payer = this.pool.draw();
    const { blockhash, lastValidBlockHeight } = await this.blockhashes.latest();
    const feePayer = payer.publicKey.toBase58();
    const message = compileMessage({ feePayer, recentBlockhash: blockhash, instructions: [
      createAtaIdempotentIx({ payer: feePayer, owner: to, mint: this.mint }),
      transferCheckedIx({ source: this.account, mint: this.mint, dest: ata(to, this.mint), authority: this.authority, amount, decimals: this.decimals }),
    ] });
    const sigs = { [feePayer]: signTalk(message, payer), [this.authority]: signTalk(message, this.#keypair) };
    const signature = base58(sigs[feePayer]);
    onSigned({ signature, lastValidBlockHeight });
    try {
      await this.connection.sendRawTransaction(wireTransaction(message, sigs), { skipPreflight: false, maxRetries: 5 });
    } catch (e) {
      e.uncertain = true;
      e.signature = signature;
      throw e;
    }
    return { signature, lastValidBlockHeight };
  }

  /** A sent transaction's fate: 'landed' | 'failed' | 'expired' (never landed, cannot any more) | 'pending'. */
  async status(signature, lastValidBlockHeight) {
    const st = (await this.connection.getSignatureStatuses([signature], { searchTransactionHistory: true }))?.value?.[0] ?? null;
    if (st?.err) return 'failed';
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return 'landed';
    if (!st && Number.isSafeInteger(lastValidBlockHeight) && (await this.connection.getBlockHeight('confirmed')) > lastValidBlockHeight) return 'expired';
    return 'pending';
  }

  toJSON() { return { authority: this.authority, account: this.account, mint: this.mint }; }
}
