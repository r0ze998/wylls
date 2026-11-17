// A small JSON-RPC client over fetch for the real RPC (local validator now,
// devnet later), with the confirmation loop the page's rules need: a sent
// transaction is identified by its signature and looked up, never resent.
export class RpcClient {
  constructor(url) { this.url = url; }
  async call(method, params = []) {
    const r = await fetch(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (!r.ok) throw Object.assign(new Error(`rpc ${method}: http ${r.status}`), { code: 'RpcHttp', status: r.status });
    const j = await r.json();
    if (j.error) throw Object.assign(new Error(j.error.message), { code: 'RpcError', data: j.error.data, rpcCode: j.error.code });
    return j.result;
  }
  async health() { return this.call('getHealth'); }
  async genesisHash() { return this.call('getGenesisHash'); }
  async latestBlockhash() { return (await this.call('getLatestBlockhash', [{ commitment: 'confirmed' }])).value; }
  async blockHeight() { return this.call('getBlockHeight', [{ commitment: 'confirmed' }]); }
  async balance(address) { return BigInt((await this.call('getBalance', [address, { commitment: 'confirmed' }])).value); }
  async account(address) {
    const v = (await this.call('getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }])).value;
    return v ? { owner: v.owner, lamports: v.lamports, data: new Uint8Array(Buffer.from(v.data[0], 'base64')), executable: v.executable } : null;
  }
  async rent(bytes) { return BigInt(await this.call('getMinimumBalanceForRentExemption', [bytes])); }
  async airdrop(address, lamports) { return this.call('requestAirdrop', [address, Number(lamports)]); }
  /** Send signed wire bytes; preflight on by default (a refused transaction costs nothing). */
  async send(wire, { skipPreflight = false } = {}) {
    return this.call('sendTransaction', [Buffer.from(wire).toString('base64'), { encoding: 'base64', skipPreflight, preflightCommitment: 'confirmed', maxRetries: 3 }]);
  }
  async statuses(signatures) { return (await this.call('getSignatureStatuses', [signatures, { searchTransactionHistory: true }])).value; }
  /** Wait until `signature` has a status (confirmed or failed) or `tries` runs out; returns the status or null. */
  async confirm(signature, { tries = 60, every = 250 } = {}) {
    for (let i = 0; i < tries; i++) {
      const [st] = await this.statuses([signature]);
      if (st && (st.err || st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return st;
      await new Promise(r => setTimeout(r, every));
    }
    return null;
  }
  /** Core assets of `collection` held by `wallet`: getProgramAccounts with memcmp on owner (offset 1) and update_authority = Collection(address) (offset 33). */
  async assetsOf({ coreProgram, collection, wallet, encodeFilter }) {
    const r = await this.call('getProgramAccounts', [coreProgram, { encoding: 'base64', commitment: 'confirmed', filters: [{ memcmp: { offset: 1, bytes: wallet } }, { memcmp: { offset: 33, bytes: encodeFilter(collection) } }] }]);
    return r.map(x => ({ address: x.pubkey, owner: x.account.owner, lamports: x.account.lamports, data: new Uint8Array(Buffer.from(x.account.data[0], 'base64')) }));
  }
}
