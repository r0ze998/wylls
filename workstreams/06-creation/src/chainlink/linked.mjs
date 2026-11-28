/**
 * ⑥ chain link, slice 1: the registry (registry.mjs) with its publication
 * mirrored into the local chain stand-in (localchain.mjs), in the order the
 * real thing would have: the off-chain checks decide what may be published,
 * then the "transaction" either lands (both change) or is refused (neither
 * changes). With the flag off it is a plain pass-through.
 *
 * This module does not import registry.mjs (so its import closure has no
 * key code): it takes the registry instance and clones it through its own
 * constructor for the trial run.
 */

import { LocalChain } from "./localchain.mjs";

function chainFinding(r) {
  const { ok: _ok, message, ...detail } = r;
  return { ...detail, severity: "error", stage: "chain", path: "$", message: `チェーンの記録（ローカルの模擬）が受け付けない：${message}` };
}

export class LinkedRegistry {
  /**
   * @param registry a Registry (registry.mjs)
   * @param chain    a LocalChain, or null when the flag is off
   */
  constructor(registry, chain = null) {
    this.registry = registry;
    this.chain = chain instanceof LocalChain ? chain : null;
  }

  get enabled() {
    return this.chain !== null;
  }

  /**
   * Publish a signed envelope. `signer` is the transaction signer the chain
   * stand-in checks (default: the manifest's author, as an author's wallet
   * would sign).
   */
  async publish(env, ctx = {}, { signer = env?.manifest?.author } = {}) {
    if (!this.chain) return this.registry.publish(env, ctx);
    const trial = new this.registry.constructor(this.registry.toJSON());
    const r = await trial.publish(env, ctx);
    if (!r.ok) return r;
    const m = env.manifest;
    const args = { signer, author: m.author, name: m.name, version: m.version, hash: env.hash, derivedFromHash: m.derivedFrom?.hash ?? null, day: ctx.today ?? 0 };
    const refused = this.chain.checkPublish(args);
    if (refused) return { ok: false, findings: [...r.findings, chainFinding(refused)], facts: r.facts };
    const landed = this.chain.publish(args);
    this.registry.data = trial.data;
    return { ...r, chain: { slot: landed.slot, entry: landed.entry, version: landed.version } };
  }

  async setStatus(ref, status, seq, signature, day = null, { signer = ref?.author } = {}) {
    if (!this.chain) return this.registry.setStatus(ref, status, seq, signature, day);
    const trial = new this.registry.constructor(this.registry.toJSON());
    const r = await trial.setStatus(ref, status, seq, signature, day);
    if (!r.ok) return r;
    const args = { signer, author: ref.author, name: ref.name, status, seq, day: day ?? 0 };
    const refused = this.chain.checkSetStatus(args);
    if (refused) return { ok: false, findings: [chainFinding(refused)] };
    const landed = this.chain.setStatus(args);
    this.registry.data = trial.data;
    return { ...r, chain: { slot: landed.slot, entry: landed.entry } };
  }
}
