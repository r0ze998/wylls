// (2026-11-20, ③ public exposure) Per-agent API keys for the PUBLIC read-only MCP endpoint (src/public-mcp.mjs).
//
// What a key is: a bearer secret an operator hands to one agent (an external AI, a player's tool) so that its public
// reads are attributed, limited and revocable one by one. What it is NOT: an owner's authority. A key reads only
// what the public herald already serves to anyone; it carries the public scope only. Acting for a player stays the
// owner-signed OAuth link of the owner server (auth.mjs: the wallet signs the link statement, and for caravans the
// agent wallet's capability command) — whether an API key may ever carry an acting scope is r0ze's decision
// (reports/ws03-mcp-public.md Q2); until then a key file naming any other scope is refused as a whole.
//
// The key file (JSON, mode 0600, written by bin/wylls-mcp-key.mjs) holds only SHA-256 hashes, never a token:
//   {"v": 1, "keys": [{"id": "<16 hex>", "sha256": "<64 hex of the whole token>", "label": "…", "scopes": ["wylls.public"],
//     "tools": null | ["get_world_season", …], "createdAt": ms, "expiresAt": ms | null, "revokedAt": ms | null,
//     "rate": null | "30/1", "perDay": null | 5000}]}
// A token is `wylls_pk_<id>_<43 base64url>`: the id finds the entry, the hash of the whole token is compared in
// constant time. The file is read again when it changes (checked at most every `recheckMs`), so a revocation needs no
// restart.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { parseRate } from './rate-limit.mjs';

export const PUBLIC_SCOPE = 'wylls.public';
/** The only scopes a key may hold (see the header): public reads. */
export const KEY_SCOPES = Object.freeze([PUBLIC_SCOPE]);
export const TOKEN = /^wylls_pk_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;
const ID = /^[0-9a-f]{16}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const LABEL = /^[\x20-\x7e]{1,80}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

const sha = s => createHash('sha256').update(s).digest('hex');

export class KeyFileError extends Error {}

/** The checked entries of a key file's JSON (throws KeyFileError naming the entry and the rule, never a value). */
export function parseKeyFile(json) {
  if (!json || json.v !== 1 || !Array.isArray(json.keys)) throw new KeyFileError('key file: {"v": 1, "keys": [...]} expected');
  const seen = new Set();
  return json.keys.map((k, i) => {
    const at = `key file: keys[${i}]`;
    if (!k || typeof k !== 'object') throw new KeyFileError(`${at}: an object expected`);
    if (!ID.test(String(k.id)) || seen.has(k.id)) throw new KeyFileError(`${at}: id must be 16 lowercase hex, unique`);
    seen.add(k.id);
    if (!HEX64.test(String(k.sha256))) throw new KeyFileError(`${at}: sha256 must be 64 lowercase hex`);
    if (!LABEL.test(String(k.label ?? ''))) throw new KeyFileError(`${at}: label must be 1–80 printable ASCII characters`);
    if (!Array.isArray(k.scopes) || !k.scopes.length) throw new KeyFileError(`${at}: scopes must be a non-empty list`);
    if (k.scopes.some(s => !KEY_SCOPES.includes(s))) throw new KeyFileError(`${at}: a key may hold ${KEY_SCOPES.join(', ')} only: acting is an owner-signed link, never an API key`);
    if (k.tools != null && (!Array.isArray(k.tools) || !k.tools.length || k.tools.some(t => !TOOL_NAME.test(String(t))))) throw new KeyFileError(`${at}: tools must be null or a non-empty list of tool names`);
    for (const f of ['createdAt', 'expiresAt', 'revokedAt']) if (k[f] != null && !Number.isSafeInteger(k[f])) throw new KeyFileError(`${at}: ${f} must be null or unix ms`);
    if (k.rate != null && !parseRate(k.rate)) throw new KeyFileError(`${at}: rate must be null or "burst/everySecs"`);
    if (k.perDay != null && !(Number.isInteger(k.perDay) && k.perDay >= 1)) throw new KeyFileError(`${at}: perDay must be null or a whole number ≥ 1`);
    return Object.freeze({ id: k.id, sha256: k.sha256, label: k.label, scopes: Object.freeze([...new Set(k.scopes)]), tools: k.tools ? Object.freeze([...new Set(k.tools)]) : null,
      createdAt: k.createdAt ?? null, expiresAt: k.expiresAt ?? null, revokedAt: k.revokedAt ?? null, rate: k.rate ? parseRate(k.rate) : null, perDay: k.perDay ?? null });
  });
}

/** A new key: the token (shown once) and the entry to store (its hash only). */
export function newKey({ label, tools = null, expiresAt = null, rate = null, perDay = null, now = Date.now() }) {
  const id = randomBytes(8).toString('hex');
  const token = `wylls_pk_${id}_${randomBytes(32).toString('base64url')}`;
  const entry = { id, sha256: sha(token), label, scopes: [PUBLIC_SCOPE], tools, createdAt: now, expiresAt, revokedAt: null, rate, perDay };
  parseKeyFile({ v: 1, keys: [entry] });
  return { token, entry };
}

/** Write a key file atomically, mode 0600. */
export function writeKeyFile(file, keys) {
  parseKeyFile({ v: 1, keys });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ v: 1, keys }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

export function readKeyFile(file) {
  if (!existsSync(file)) return [];
  return JSON.parse(readFileSync(file, 'utf8')).keys;
}

export class KeyRing {
  /**
   * @param {object} o
   * @param {string|null} [o.file]  the key file (re-read when its mtime or size changes)
   * @param {object[]} [o.keys]     entries instead of a file (tests)
   */
  constructor({ file = null, keys = null, now = Date.now, recheckMs = 5_000, log = () => {} } = {}) {
    this.file = file; this.now = now; this.recheckMs = recheckMs; this.log = log;
    this.checkedAt = -Infinity; this.stamp = null;
    this.byId = new Map();
    if (keys) this.#use(parseKeyFile({ v: 1, keys }));
    else if (file) this.#load(true);
  }

  #use(entries) { this.byId = new Map(entries.map(e => [e.id, e])); }

  #load(first) {
    let st;
    try { st = statSync(this.file); } catch (e) {
      if (first) throw new KeyFileError('key file: cannot be read');
      // (2026-11-20, verify-pr114) Fail closed: an operator who deletes (or moves) the key file means "no key"; keeping
      // the keys loaded before kept every unrevoked key working until a restart.
      if (this.byId.size) this.log('public keys: the key file cannot be read; no key is accepted until it is back');
      this.byId = new Map(); this.stamp = null;
      return;
    }
    if ((st.mode & 0o077) !== 0 && first) throw new KeyFileError('key file: must not be readable by group or others (chmod 600)');
    const stamp = `${st.mtimeMs}:${st.size}`;
    if (stamp === this.stamp) return;
    if ((st.mode & 0o077) !== 0) this.log('public keys: warning: the changed key file is readable by group or others (chmod 600)');
    try {
      this.#use(parseKeyFile(JSON.parse(readFileSync(this.file, 'utf8'))));
      this.stamp = stamp;
      if (!first) this.log(`public keys: reloaded (${this.byId.size})`);
    } catch (e) {
      if (first) throw e instanceof KeyFileError ? e : new KeyFileError('key file: not JSON');
      // A broken edit never opens the door: the keys loaded before stay (a revocation already loaded stays revoked).
      this.log(`public keys: the changed key file was refused (${e instanceof KeyFileError ? e.message : 'not JSON'}); keeping the keys loaded before`);
    }
  }

  maybeReload() {
    if (!this.file) return;
    const t = this.now();
    if (t - this.checkedAt < this.recheckMs) return;
    this.checkedAt = t;
    this.#load(false);
  }

  get size() { return this.byId.size; }

  /**
   * The key a token is, or a refusal: {key} | {error: 'invalid_token', message}. The message never echoes the token.
   */
  verify(token) {
    this.maybeReload();
    const m = TOKEN.exec(String(token ?? ''));
    if (!m) return { error: 'invalid_token', message: 'not a Wylls public key' };
    const k = this.byId.get(m[1]);
    // the hash is compared even for an unknown id (same work either way)
    const want = Buffer.from(k?.sha256 ?? '0'.repeat(64), 'hex');
    const got = Buffer.from(sha(token), 'hex');
    if (!k || !timingSafeEqual(want, got)) return { error: 'invalid_token', message: 'unknown key' };
    if (k.revokedAt !== null && k.revokedAt <= this.now()) return { error: 'invalid_token', message: 'the key was revoked' };
    if (k.expiresAt !== null && k.expiresAt <= this.now()) return { error: 'invalid_token', message: 'the key has expired' };
    return { key: k };
  }
}
