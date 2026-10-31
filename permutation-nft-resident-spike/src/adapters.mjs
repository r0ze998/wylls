// What the mint companion server needs from "the chain", in two shapes:
//   MockAdapter  the mock JSON-RPC and mock chain (browser tests without a validator)
//   RpcAdapter   a real JSON-RPC (the loopback solana-test-validator now; devnet later),
//                with the real program's accounts decoded and holdings found by getProgramAccounts.
// "Registered" is decided the same way in both: the asset account verified
// (Core program, AssetV1, Collection(expected), owner == wallet) and the
// resident account bound to the asset by the derived tag.
import { MPL_CORE_PROGRAM, verifyResidentAsset } from './core-asset.mjs';
import { residentIdOf } from './ids.mjs';
import { decodeResident, residentAccountOf, RESIDENT_PROGRAM } from './mock-chain.mjs';
import { ASSET_BYTES, LAMPORTS_PER_SIGNATURE, MINT_RESIDENT_ACCOUNTS, MINT_RESIDENT_TAG, RESIDENT_BYTES, rentFor, SYSTEM_PROGRAM } from './mint-rpc.mjs';
import { collectionFilter, decodeConfigAccount, decodeResidentAccount, pdas, RESIDENT } from './resident-ix.mjs';

/** Real Core asset account size seen in LiteSVM (base struct + plugin header and registry for the two permanent plugins). */
export const REAL_ASSET_BYTES = 233;

export class MockAdapter {
  constructor({ rpc, chain, collection, config }) { this.rpc = rpc; this.chain = chain; this.collection = collection; this.cfg = config; this.kind = 'mock'; this.knobs = rpc.knobs; }
  async config() {
    const c = this.cfg;
    return {
      mode: 'mock', network: c.network, chainId: c.chainId, genesisHash: c.genesisHash, explorer: c.explorer,
      price: { lamports: String(c.priceLamports), label: c.priceLabel, test: true, changeable: true },
      estimate: { feeLamports: String(LAMPORTS_PER_SIGNATURE * 2n), rentAssetLamports: String(rentFor(ASSET_BYTES)), rentResidentLamports: String(rentFor(RESIDENT_BYTES)) },
      programs: { resident: RESIDENT_PROGRAM, core: MPL_CORE_PROGRAM, system: SYSTEM_PROGRAM }, collection: this.collection, treasury: c.treasury,
      collectionAuthorityPda: c.collectionAuthorityPda, configPda: c.configPda, residentPda: 'server-derived',
      instruction: { tag: MINT_RESIDENT_TAG, accounts: MINT_RESIDENT_ACCOUNTS },
    };
  }
  async handle(req) { return this.rpc.handle(req); }
  derive(asset) { return residentAccountOf(asset); }
  async status({ wallet, asset }) {
    const r = await this.rpc.readerGetAccount(asset);
    const v = verifyResidentAsset({ account: r.account ? { ...r.account, address: asset } : null, expected: { program: MPL_CORE_PROGRAM, collection: this.collection } });
    if (!v.ok) return { registered: false, code: v.code, asset, readSlot: r.slot };
    const resident = decodeResident((await this.rpc.readerGetAccount(residentAccountOf(asset))).account);
    const bound = resident?.bound === residentIdOf(asset);
    return { registered: bound && v.holder === wallet, holder: v.holder, isHolder: v.holder === wallet, bound, residentId: bound ? resident.bound : null, gen: resident?.gen ?? null, asset, readSlot: r.slot };
  }
  async mine(wallet) {
    const out = [];
    for (const [address, a] of this.chain.accounts) {
      if (a.owner !== MPL_CORE_PROGRAM) continue;
      const v = verifyResidentAsset({ account: { ...a, address }, expected: { program: MPL_CORE_PROGRAM, collection: this.collection } });
      if (v.ok && v.holder === wallet) out.push({ asset: address, residentId: residentIdOf(address) });
    }
    return out;
  }
  async airdrop(address, lamports) { this.rpc.airdrop(address, lamports); return String(this.rpc.balance(address)); }
}

export class RpcAdapter {
  /** `rpc`: RpcClient; `world`: setupWorld's result; `programId`; `network`/`chainId`/`explorer` for the page. */
  constructor({ rpc, world, programId, network = 'localnet (real program, loopback validator)', chainId = 'solana:localnet', explorer = null, priceLabel = 'TEST PRICE — 試験用の仮値、本番価格ではない' }) {
    this.rpc = rpc; this.world = world; this.programId = programId; this.network = network; this.chainId = chainId; this.explorer = explorer; this.priceLabel = priceLabel;
    this.kind = 'rpc'; this.pdas = pdas(programId);
    /** Test knobs: `dropSendResponse` forwards the send but answers 504; `hideStatuses` answers null statuses. */
    this.knobs = { dropSendResponse: false, hideStatuses: false };
    this.sent = [];
  }
  async config() {
    const cfgAcc = await this.rpc.account(this.pdas.config);
    const cfg = decodeConfigAccount(cfgAcc?.data);
    if (!cfg) throw new Error('the program config account is missing or not initialized');
    const [rentAsset, rentResident] = await Promise.all([this.rpc.rent(REAL_ASSET_BYTES), this.rpc.rent(RESIDENT.LEN)]);
    return {
      mode: 'rpc', network: this.network, chainId: this.chainId, genesisHash: await this.rpc.genesisHash(), explorer: this.explorer,
      price: { lamports: String(cfg.price), label: this.priceLabel, test: true, changeable: true },
      estimate: { feeLamports: String(5_000 * 2), rentAssetLamports: String(rentAsset), rentResidentLamports: String(rentResident) },
      programs: { resident: this.programId, core: MPL_CORE_PROGRAM, system: SYSTEM_PROGRAM }, collection: cfg.collection, treasury: cfg.treasury,
      collectionAuthorityPda: this.pdas.collectionAuthority, configPda: this.pdas.config, residentPda: 'page-derived ["resident", asset]',
      instruction: { tag: 0x50, accounts: ['payer', 'treasury', 'asset', 'collection', 'collectionAuthority', 'resident', 'config', 'coreProgram', 'systemProgram'] },
    };
  }
  /** Forward the page's JSON-RPC as is (the page only ever sends the methods it needs); the knobs shape what comes back. */
  async handle(req) {
    if (req.method === 'getSignatureStatuses' && this.knobs.hideStatuses) return { jsonrpc: '2.0', id: req.id, result: { context: { slot: 0 }, value: req.params[0].map(() => null) } };
    const r = await fetch(this.rpc.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) });
    const out = await r.json();
    if (req.method === 'sendTransaction') {
      this.sent.push({ ok: !out.error, result: out.result ?? null, error: out.error ?? null });
      if (!out.error && this.knobs.dropSendResponse) { this.knobs.dropSendResponse = false; return { drop: true, signature: out.result }; }
    }
    return out;
  }
  derive(asset) { return this.pdas.resident(asset); }
  async status({ wallet, asset }) {
    const slot = await this.rpc.call('getSlot', [{ commitment: 'confirmed' }]);
    const a = await this.rpc.account(asset);
    const v = verifyResidentAsset({ account: a ? { ...a, address: asset, flags: {} } : null, expected: { program: MPL_CORE_PROGRAM, collection: this.world.collection } });
    if (!v.ok) return { registered: false, code: v.code, asset, readSlot: slot };
    const r = await this.rpc.account(this.pdas.resident(asset));
    const resident = r && r.owner === this.programId ? decodeResidentAccount(r.data) : null;
    const bound = !!resident && resident.asset === asset && resident.tag15 === residentIdOf(asset);
    return { registered: bound && v.holder === wallet, holder: v.holder, isHolder: v.holder === wallet, bound, residentId: bound ? resident.tag15 : null, gen: resident?.gen ?? null, session: resident?.session ?? null, asset, readSlot: slot };
  }
  /** Holdings by getProgramAccounts (fine on a local validator; a public devnet RPC may refuse it: MINT-FLOW §5). Each hit is verified; the index alone decides nothing. */
  async mine(wallet) {
    const hits = await this.rpc.assetsOf({ coreProgram: MPL_CORE_PROGRAM, collection: this.world.collection, wallet, encodeFilter: collectionFilter });
    const out = [];
    for (const h of hits) {
      const v = verifyResidentAsset({ account: { ...h, flags: {} }, expected: { program: MPL_CORE_PROGRAM, collection: this.world.collection } });
      if (v.ok && v.holder === wallet) out.push({ asset: h.address, residentId: residentIdOf(h.address) });
    }
    return out;
  }
  async airdrop(address, lamports) { await this.rpc.airdrop(address, lamports); for (let i = 0; i < 40; i++) { const b = await this.rpc.balance(address); if (b >= BigInt(lamports)) return String(b); await new Promise(r => setTimeout(r, 250)); } return String(await this.rpc.balance(address)); }
}
