// A mock Solana JSON-RPC over the mock chain, speaking the subset the mint
// page uses, with **real wire transactions** (legacy format, ed25519
// signatures verified) so the page code that runs here is the page code
// that would run against devnet. It also hosts the mock resident program's
// `MintResident` instruction: SOL payment, Core asset creation into the
// collection (guarded), and the resident account (generation 0) in ONE
// instruction; a failure anywhere leaves only the network fee paid, as the
// Solana runtime would.
//
// What is mock here: the runtime (slots, fees, rent, blockhash lifetime),
// the Core program's effects (modelled as account writes), the resident
// program (its instruction layout below is the proposal for ④). What is
// real: the transaction bytes, the signature checks, the account layout the
// page decodes (AssetV1), the JSON-RPC shapes.
import { parseTransaction } from '../../permutation-gateway/client/src/solana-tx.mjs';
import { verifySignature, base58, pubkeyBytes, sha256, randomAddress } from './crypto.mjs';
import { encodeAssetV1, MPL_CORE_PROGRAM } from './core-asset.mjs';
import { residentIdOf } from './ids.mjs';
import { residentAccountOf, RESIDENT_PROGRAM } from './mock-chain.mjs';
import { ERR, Refusal } from './errors.mjs';

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const LAMPORTS_PER_SIGNATURE = 5_000n;
export const BLOCKHASH_LIFETIME = 150;               // blocks
export const SLOTS_PER_BLOCK = 1;
/** Rent-exempt minimum per byte-year scaled as mainnet (6960 lamports/byte + 128-byte overhead, 2 years). */
export const rentFor = bytes => BigInt((bytes + 128) * 6960) * 2n / 2n;
export const ASSET_BYTES = 170;                      // AssetV1 base + a plugin header, rounded (estimate)
export const RESIDENT_BYTES = 384;                   // the Citizen v2 size
/** MintResident instruction: tag 0x50 ‖ price lamports u64 LE (the price the client saw; the program refuses a mismatch). */
export const MINT_RESIDENT_TAG = 0x50;
/** Account order of MintResident (proposal for ④): payer s/w, treasury w, asset s/w, collection w, collection authority PDA, resident PDA w, config, Core program, System program. */
export const MINT_RESIDENT_ACCOUNTS = Object.freeze(['payer', 'treasury', 'asset', 'collection', 'collectionAuthority', 'resident', 'config', 'coreProgram', 'systemProgram']);

export class MockRpc {
  /**
   * @param {object} o
   * @param {import('./mock-chain.mjs').MockChain} o.chain
   * @param {string} o.collection
   * @param {{priceLamports: bigint, treasury: string, genesisHash: string, collectionAuthorityPda: string, configPda: string}} o.config
   */
  constructor({ chain, collection, config, registry = null, now = () => Date.now() }) {
    this.chain = chain; this.collection = collection; this.config = config; this.registry = registry; this.now = now;
    this.lamports = new Map();                      // address → bigint (SOL balances of wallets)
    this.blockhashes = new Map();                   // blockhash → lastValidBlockHeight
    this.height = 1000;
    this.txs = new Map();                           // signature → {slot, err, logs, blockTime}
    /** Test knobs. */
    this.knobs = { dropSendResponse: false, failAfterPayment: false, rejectAll: false };
    this.sent = [];
  }

  /** The server's chain reader for the status check: the latest account state at the current slot. */
  async readerGetAccount(address) { return { slot: this.chain.slot, account: this.chain.accounts.get(address) ?? null }; }

  /** Test knob: move an asset holder-to-holder through the mock program (TransferResident), as a sale or gift would. */
  mockTransfer({ asset, from, to }) {
    const a = this.chain.accounts.get(asset);
    if (!a) return { ok: false, code: 'NoAccount' };
    // The mock program path: owner change + generation bump + session clear.
    const st = this.chain.residentOf(asset);
    const data = new Uint8Array(a.data); data.set(pubkeyBytes(to), 1);
    this.chain.accounts.set(asset, { ...a, data });
    this.chain.history.get(asset).push({ slot: this.chain.slot, account: { ...a, data } });
    this.chain.writeResidentPublic(asset, { ...st, gen: st.gen + 1, session: null });
    return { ok: true, from, to, gen: st.gen + 1 };
  }

  airdrop(address, lamports) { this.lamports.set(address, (this.lamports.get(address) ?? 0n) + BigInt(lamports)); }
  balance(address) { return this.lamports.get(address) ?? 0n; }
  /** Advance `n` blocks (and slots): blockhashes age out. */
  advance(n = 1) { this.height += n; this.chain.tick(n); }

  latestBlockhash() {
    const blockhash = randomAddress();
    const lastValidBlockHeight = this.height + BLOCKHASH_LIFETIME;
    this.blockhashes.set(blockhash, lastValidBlockHeight);
    return { blockhash, lastValidBlockHeight };
  }

  /** JSON-RPC dispatch: `{jsonrpc, id, method, params}` → `{jsonrpc, id, result|error}`. */
  async handle(req) {
    const reply = result => ({ jsonrpc: '2.0', id: req.id, result });
    const error = (code, message, data) => ({ jsonrpc: '2.0', id: req.id, error: { code, message, ...(data ? { data } : {}) } });
    const p = req.params ?? [];
    const ctx = { slot: this.chain.slot, apiVersion: 'mock' };
    try {
      switch (req.method) {
        case 'getHealth': return reply('ok');
        case 'getGenesisHash': return reply(this.knobs.genesisHash ?? this.config.genesisHash);
        case 'getLatestBlockhash': return reply({ context: ctx, value: this.latestBlockhash() });
        case 'getBlockHeight': return reply(this.height);
        case 'getSlot': return reply(this.chain.slot);
        case 'getBalance': return reply({ context: ctx, value: Number(this.balance(p[0])) });
        case 'getMinimumBalanceForRentExemption': return reply(Number(rentFor(Number(p[0]))));
        case 'getFeeForMessage': return reply({ context: ctx, value: Number(LAMPORTS_PER_SIGNATURE) });
        case 'getAccountInfo': {
          const a = this.chain.accounts.get(p[0]);
          if (!a) return reply({ context: ctx, value: null });
          return reply({ context: ctx, value: { lamports: a.lamports, owner: a.owner, executable: false, rentEpoch: 0, data: [Buffer.from(a.data).toString('base64'), 'base64'] } });
        }
        case 'getSignatureStatuses': {
          return reply({ context: ctx, value: p[0].map(sig => { const t = this.txs.get(sig); return t ? { slot: t.slot, confirmations: null, err: t.err, confirmationStatus: 'finalized' } : null; }) });
        }
        case 'getTransaction': {
          const t = this.txs.get(p[0]);
          return reply(t ? { slot: t.slot, blockTime: t.blockTime, meta: { err: t.err, logMessages: t.logs, fee: Number(LAMPORTS_PER_SIGNATURE) }, transaction: null } : null);
        }
        case 'simulateTransaction': {
          const r = this.#execute(fromBase64(p[0]), { dryRun: true });
          return reply({ context: ctx, value: { err: r.err, logs: r.logs, unitsConsumed: 12_000 } });
        }
        case 'sendTransaction': {
          if (this.knobs.rejectAll) return error(-32003, 'Transaction simulation failed: mock refuses everything');
          const r = this.#execute(fromBase64(p[0]), { dryRun: false, skipPreflight: p[1]?.skipPreflight === true });
          if (r.preflightErr) return error(-32002, `Transaction simulation failed: ${r.preflightErr}`, { err: r.preflightErr, logs: r.logs });
          if (this.knobs.dropSendResponse) { this.knobs.dropSendResponse = false; return { drop: true, signature: r.signature }; }
          return reply(r.signature);
        }
        default: return error(-32601, `Method not found: ${req.method}`);
      }
    } catch (e) {
      return error(-32602, e.message);
    }
  }

  /**
   * Execute a wire transaction as the runtime would: parse, check the
   * blockhash and every signature, charge the fee, run the instructions
   * all-or-nothing (the fee stays paid on failure). `dryRun` = simulate.
   */
  #execute(wire, { dryRun, skipPreflight = false }) {
    const logs = [];
    let tx;
    try { tx = parseTransaction(wire); } catch (e) { return { preflightErr: `failed to deserialize: ${e.message}`, logs }; }
    const signature = base58(tx.signatures[0]);
    if (this.txs.has(signature) && !dryRun) return { preflightErr: 'This transaction has already been processed', logs, signature };
    const lvbh = this.blockhashes.get(tx.recentBlockhash);
    if (lvbh === undefined || this.height > lvbh) return { preflightErr: 'Blockhash not found', logs, signature };
    for (const [i, s] of tx.signers.entries()) {
      if (!verifySignature(tx.message, tx.signatures[i], s)) return { preflightErr: 'Transaction signature verification failure', logs, signature };
    }
    const payer = tx.signers[0];
    const fee = LAMPORTS_PER_SIGNATURE * BigInt(tx.signers.length);
    if (this.balance(payer) < fee) return { preflightErr: 'Attempt to debit an account but found no record of a prior credit.', logs, signature };
    // Snapshot for all-or-nothing.
    const snapLamports = new Map(this.lamports);
    const snapAccounts = new Map([...this.chain.accounts].map(([k, v]) => [k, { ...v, data: new Uint8Array(v.data), flags: { ...v.flags } }]));
    const snapHistory = new Map([...this.chain.history].map(([k, v]) => [k, v.length]));
    let err = null;
    try {
      for (const ix of tx.instructions) this.#instruction(ix, tx, logs);
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      err = { InstructionError: [0, { Custom: codeNumber(e.code) }] };
      logs.push(`Program ${RESIDENT_PROGRAM} failed: custom program error: ${e.code}: ${e.message}`);
    }
    if (dryRun || (err && !skipPreflight)) {
      // Simulation (or a preflight refusal): restore everything.
      this.lamports = snapLamports; this.chain.accounts = snapAccounts;
      for (const [k, h] of this.chain.history) { const n = snapHistory.get(k); if (n === undefined) this.chain.history.delete(k); else h.length = n; }
      return err ? { preflightErr: JSON.stringify(err), err, logs, signature } : { err: null, logs, signature };
    }
    if (err) {
      // Included but failed: state back, fee paid.
      this.lamports = snapLamports; this.chain.accounts = snapAccounts;
      for (const [k, h] of this.chain.history) { const n = snapHistory.get(k); if (n === undefined) this.chain.history.delete(k); else h.length = n; }
    }
    this.lamports.set(payer, this.balance(payer) - fee);
    this.txs.set(signature, { slot: this.chain.slot, err, logs, blockTime: Math.floor(this.now() / 1000) });
    this.sent.push({ signature, err });
    return { err, logs, signature };
  }

  #instruction(ix, tx, logs) {
    if (ix.programId === SYSTEM_PROGRAM) {
      // Transfer (tag 2): from s/w, to w, lamports u64.
      const d = Buffer.from(ix.data);
      if (d.readUInt32LE(0) !== 2) throw new Refusal(ERR.BAD_DATA, 'system: unsupported instruction');
      const [from, to] = [ix.keys[0].pubkey, ix.keys[1].pubkey];
      const amount = d.readBigUInt64LE(4);
      if (!tx.signers.includes(from)) throw new Refusal(ERR.AUTH, 'system transfer: missing signature');
      if (this.balance(from) < amount) throw new Refusal(ERR.INSUFFICIENT_FUNDS, 'insufficient lamports');
      this.lamports.set(from, this.balance(from) - amount); this.lamports.set(to, this.balance(to) + amount);
      return;
    }
    if (ix.programId === RESIDENT_PROGRAM) return this.#mintResident(ix, tx, logs);
    throw new Refusal(ERR.BAD_DATA, `unknown program ${ix.programId}`);
  }

  /**
   * MintResident: `[payer s/w] [treasury w] [asset s/w] [collection w]
   * [collection_authority PDA] [resident PDA w] [config] [Core] [System]`,
   * data `0x50 ‖ price u64`. Checks: config's price == data price (the
   * client saw the current price), treasury == config's, collection ==
   * the world's, the asset signed (a fresh keypair), resident PDA matches
   * the asset. Effects, all or nothing: payer −price → treasury; payer
   * −rent for asset and resident; Core asset created in the collection,
   * owner = payer, guarded (Permanent Freeze + Permanent Transfer Delegate
   * = this program); resident account {gen: 0, session: null, bound: tag15}.
   */
  #mintResident(ix, tx, logs) {
    const d = Buffer.from(ix.data);
    if (d[0] !== MINT_RESIDENT_TAG || d.length !== 9) throw new Refusal(ERR.BAD_DATA, 'MintResident: data');
    const price = d.readBigUInt64LE(1);
    const k = Object.fromEntries(MINT_RESIDENT_ACCOUNTS.map((n, i) => [n, ix.keys[i]?.pubkey]));
    if (ix.keys.length !== MINT_RESIDENT_ACCOUNTS.length) throw new Refusal(ERR.BAD_DATA, 'MintResident: accounts');
    if (price !== this.config.priceLamports) throw new Refusal(ERR.PRICE_CHANGED, 'MintResident: the price changed; rebuild the transaction', { price: String(this.config.priceLamports) });
    if (k.treasury !== this.config.treasury) throw new Refusal(ERR.BAD_DATA, 'MintResident: treasury');
    if (k.collection !== this.collection) throw new Refusal(ERR.NOT_IN_COLLECTION, 'MintResident: collection');
    if (k.config !== this.config.configPda || k.collectionAuthority !== this.config.collectionAuthorityPda) throw new Refusal(ERR.BAD_ADDRESS ?? ERR.BAD_DATA, 'MintResident: PDA');
    if (k.coreProgram !== MPL_CORE_PROGRAM || k.systemProgram !== SYSTEM_PROGRAM) throw new Refusal(ERR.BAD_DATA, 'MintResident: programs');
    if (!tx.signers.includes(k.payer) || !tx.signers.includes(k.asset)) throw new Refusal(ERR.AUTH, 'MintResident: payer and asset must sign');
    if (k.resident !== residentAccountOf(k.asset)) throw new Refusal(ERR.BAD_DATA, 'MintResident: resident PDA does not match the asset');
    if (this.chain.accounts.has(k.asset)) throw new Refusal(ERR.ALREADY_PROCESSED, 'MintResident: asset exists');
    const rent = rentFor(ASSET_BYTES) + rentFor(RESIDENT_BYTES);
    const need = price + rent;
    if (this.balance(k.payer) < need) throw new Refusal(ERR.INSUFFICIENT_FUNDS, `MintResident: insufficient lamports (need ${need})`);
    // 1. payment
    this.lamports.set(k.payer, this.balance(k.payer) - need);
    this.lamports.set(k.treasury, this.balance(k.treasury) + price);
    logs.push(`Program log: paid ${price} lamports to treasury`);
    if (this.knobs.failAfterPayment) { this.knobs.failAfterPayment = false; throw new Refusal(ERR.BAD_DATA, 'MintResident: injected failure after the payment leg'); }
    // 2. Core create (guarded) — modelled as account writes via the chain's mint, owner = payer
    const kp = { publicKey: k.asset };
    this.chain.mint({ collection: this.collection, to: k.payer, authority: this.chain.collectionAuthorityOf(this.collection), memo: `mint:${k.payer}`, assetKeypair: kp, guard: true });
    // 3. resident account (generation 0), bound to the asset
    this.chain.writeResidentPublic(k.asset, { gen: 0, session: null, bound: residentIdOf(k.asset) });
    logs.push(`Program log: resident ${residentIdOf(k.asset)} created for ${k.asset}`);
  }
}

const fromBase64 = s => new Uint8Array(Buffer.from(String(s), 'base64'));
const codeNumber = code => { let n = 0; for (const c of code) n = (n * 31 + c.charCodeAt(0)) % 1_000; return n; };
