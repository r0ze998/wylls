// Agent signing keys (docs/agent-wallet/DESIGN.md §5.2). Each agent has its
// own ed25519 key, made at random when the agent is created; the owner makes
// it the Citizen's session key with a wallet-signed SetSession, which is how
// the chain lets the agent act (and how the owner takes that right back).
//
// The secret never leaves this module: callers get the public key and a
// `sign(bytes)`; views, logs, errors, the model's prompt and any MCP output
// only ever see the public key. Keys are kept in `dir/<agentId>.key` (hex
// seed, mode 0600), or only in memory when `dir` is null (tests).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { signTalk } from '../../../client/src/talk-node.mjs';

const ID = /^[A-Za-z0-9-]{1,64}$/;

export class AgentKeyring {
  #keys = new Map();
  #byPub = new Map();

  constructor({ dir = null } = {}) {
    this.dir = dir;
    if (dir && existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.key')) continue;
        const id = f.slice(0, -4);
        if (!ID.test(id)) continue;
        const seed = Buffer.from(readFileSync(path.join(dir, f), 'utf8').trim(), 'hex');
        if (seed.length === 32) this.#put(id, Keypair.fromSeed(seed));
      }
    }
  }

  #put(id, kp) {
    this.#keys.set(id, kp);
    this.#byPub.set(kp.publicKey.toBase58(), id);
  }

  /** A new key for `agentId`; returns its public key (base58). */
  create(agentId) {
    if (!ID.test(agentId)) throw new Error('bad agent id');
    if (this.#keys.has(agentId)) throw new Error('agent key exists');
    const kp = Keypair.generate();
    if (this.dir) {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(this.dir, `${agentId}.key`), `${Buffer.from(kp.secretKey.slice(0, 32)).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
    }
    this.#put(agentId, kp);
    return kp.publicKey.toBase58();
  }

  publicKey(agentId) { return this.#keys.get(agentId)?.publicKey.toBase58() ?? null; }

  /** Whether `pubkey` is some agent's key (the relay refuses such keys outside the agent gateway). */
  isAgentKey(pubkey) { return this.#byPub.has(String(pubkey)); }

  /** The agent's ed25519 signature of `bytes`. */
  sign(agentId, bytes) {
    const kp = this.#keys.get(agentId);
    if (!kp) throw new Error('no key for this agent');
    return signTalk(bytes, kp);
  }

  toJSON() { return { agents: this.#keys.size }; }
  [Symbol.for('nodejs.util.inspect.custom')]() { return `AgentKeyring(${this.#keys.size} keys)`; }
}
