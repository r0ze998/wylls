// Custody of deposited test USDC (docs/agent-wallet/DESIGN.md §6; the
// owner's decision of 2026-10-17: an operator-held account plus the ledger,
// local test tokens only, to be replaced by an on-chain vault behind the
// same interface before any live money).
//
// * Deposit: the owner sends test USDC to the custody token account in a
//   transaction the owner signs; the relay credits the agent after reading
//   that transaction from the chain: confirmed, no error, the owner signed,
//   the custody account gained exactly what the owner's token accounts lost.
// * Withdrawal: the custody key signs a TransferChecked to the agent's fixed
//   payout (the owner's associated token account), a relay payer pays the
//   fee. The signature is known (and recorded) before the bytes are sent, so
//   a timeout leaves a withdrawal whose outcome `status` can still decide.
import { PublicKey } from '@solana/web3.js';
import { encode as base58 } from '../../../client/src/base58.mjs';
import { ata, decodeTokenAccount, TOKEN_PROGRAM } from '../../../client/src/frontier/prize.mjs';
import { createAtaIdempotentIx } from '../../../client/src/player.mjs';
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

export class Custody {
  #keypair;

  /** `keypair`: the custody authority (web3.js Keypair; never exposed); `pool`: the relay PayerPool (fees). */
  constructor({ connection, keypair, mint, decimals = 6, pool, blockhashes }) {
    this.connection = connection;
    this.#keypair = keypair;
    this.mint = mint;
    this.decimals = decimals;
    this.pool = pool;
    this.blockhashes = blockhashes;
    this.authority = keypair.publicKey.toBase58();
    this.account = ata(this.authority, mint);
  }

  /** The custody token account's balance (base units). */
  async balance() {
    const info = await this.connection.getAccountInfo(new PublicKey(this.account), 'confirmed');
    return info ? decodeTokenAccount(info.data).amount : 0n;
  }

  /**
   * The amount `owner` deposited in transaction `signature` (BigInt > 0), or
   * DepositPending (not confirmed yet) / DepositInvalid.
   */
  async verifyDeposit(signature, owner) {
    const tx = await this.connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    if (!tx) throw new AgentError(ERR.DEPOSIT_PENDING, 'the deposit transaction is not confirmed yet; try again shortly', 409);
    if (tx.meta?.err) throw new AgentError(ERR.DEPOSIT_INVALID, 'the deposit transaction failed on chain');
    const msg = tx.transaction.message;
    const keys = (msg.staticAccountKeys ?? msg.accountKeys).map(keyOf);
    const nSigners = msg.header.numRequiredSignatures;
    if (!keys.slice(0, nSigners).includes(owner)) throw new AgentError(ERR.DEPOSIT_INVALID, 'the agent\'s owner did not sign the deposit');
    const pre = tx.meta?.preTokenBalances ?? [];
    const post = tx.meta?.postTokenBalances ?? [];
    const amountAt = (list, i) => BigInt(list.find(b => b.accountIndex === i && b.mint === this.mint)?.uiTokenAmount?.amount ?? 0);
    const custodyIndex = keys.indexOf(this.account);
    if (custodyIndex < 0) throw new AgentError(ERR.DEPOSIT_INVALID, 'the deposit does not touch the custody account');
    const gained = amountAt(post, custodyIndex) - amountAt(pre, custodyIndex);
    if (gained <= 0n) throw new AgentError(ERR.DEPOSIT_INVALID, 'the custody account gained nothing in this transaction');
    let ownerDelta = 0n;
    const ownerIdx = new Set([...pre, ...post].filter(b => b.mint === this.mint && b.owner === owner).map(b => b.accountIndex));
    for (const i of ownerIdx) ownerDelta += amountAt(post, i) - amountAt(pre, i);
    if (ownerDelta !== -gained) throw new AgentError(ERR.DEPOSIT_INVALID, 'the custody account\'s gain did not come from the owner\'s token accounts');
    return gained;
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
