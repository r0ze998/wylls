// Shared helpers of the audit (contract sections 6.3, 7.1 to 7.3; unit AC8): canonical JSON and hashes, the
// redactable Merkle rules, deterministic sampling, the published bundle reader, the check accumulator and the
// loopback guard. Imports only node builtins and two small citizens modules, so `season_end.mjs` can run inside the
// citizens service's permission sandbox (citizens/audit is on its read list) and `verify-minds.mjs` can run outside it.
//
// What is pinned here that the contract leaves open (listed in AC8-NOTES.md, "pinned details"):
//  * sampling: item j of a sample is pool[ u64_le(sha256(seed || u32_le(i))[0..8]) mod |pool| ], i = 0, 1, 2, ... skipping
//    a pool slot already taken. `seed` = the last published minds_root (7.3 says `sha256(last minds_root || i)`).
//  * a "check" result is {pass: true | false | null, n, failures:[{code, ...}], ...}; null means "not fully verified"
//    (a field the run left `unmeasured`, a check that was skipped); the verdict is FAIL if any check is false,
//    INCOMPLETE if none is false and some is null, PASS otherwise.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalJson } from '../mind/guards.mjs';
import { merkleRootHex, recordLeaf } from '../mind/records.mjs';

export { canonicalJson, merkleRootHex, recordLeaf };

export const ZERO_ROOT = '0'.repeat(64);
export const sha256buf = (...parts) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(typeof p === 'string' ? Buffer.from(p, 'utf8') : p);
  return h.digest();
};
export const sha256hex = (...parts) => sha256buf(...parts).toString('hex');
export const sha256Canonical = v => sha256hex(canonicalJson(v));
export const u32le = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

/** inner = sha256(bytes || sig); leaf = sha256(0x00 || inner) (6.3). */
export const innerHex = (bytes, sig) => sha256hex(Buffer.from(bytes), Buffer.from(sig));
export const socialLeaf = inner => sha256hex(Buffer.from([0]), Buffer.from(inner, 'hex'));
/** social_root over the inner hashes of a bell's records in acceptance order. */
export const socialRootOfInners = inners => merkleRootHex(inners.map(socialLeaf));

/** The minds leaf is sha256(0x00 || sha256(canonical published record)); the id covers everything but `id` and `tx` (records.mjs). */
export function recordIdOf(published) {
  const { id, tx, ...rest } = published;
  return sha256Canonical(rest);
}

/** The commitment of a sealed record: sha256(canonical {situation_hash, candidates_hash, choice, retrieved, public} || nonce16). */
export function sealedCommit(opened, nonceHex) {
  return sha256hex(canonicalJson({
    situation_hash: opened.situation_hash ?? null,
    candidates_hash: opened.candidates_hash ?? null,
    choice: opened.choice ?? null,
    retrieved: opened.retrieved ?? null,
    public: opened.public ?? null,
  }), Buffer.from(nonceHex, 'hex'));
}

/** call_commit = sha256(canonical {option, p, q, tile} || nonce32) (council.mjs `callCommit`). */
export const callCommitOf = ({ option, p, q, tile }, nonceHex) => sha256hex(canonicalJson({ option, p, q, tile }), Buffer.from(nonceHex, 'hex'));

// ------------------------------------------------------------------ sampling (7.3)
/** `count` distinct items of `pool` (an array in a canonical order), chosen by sha256(seed || u32_le(i)). */
export function sampleFrom(seedHex, pool, count) {
  const seed = Buffer.from(seedHex ?? ZERO_ROOT, 'hex');
  const want = Math.min(count, pool.length);
  const used = new Set();
  const out = [];
  for (let i = 0; out.length < want && i < 100000; i++) {
    const j = Number(sha256buf(seed, u32le(i)).readBigUInt64LE(0) % BigInt(pool.length));
    if (used.has(j)) continue;
    used.add(j);
    out.push(pool[j]);
  }
  return out;
}

// ------------------------------------------------------------------ files
export function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}
export function writeAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}
/** The numbers n of the files `<n>.json` directly in `dir`, ascending. */
export function numericJson(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map(n => /^(\d+)\.json$/.exec(n)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
}

/**
 * `--ai-dir` may be PUB itself (the contract's form) or AI_DIR (it holds `pub/`); returns `{pub, aiDir}` with
 * `aiDir` null when only PUB was given.
 */
export function resolvePubDir(arg) {
  if (existsSync(join(arg, 'commitments.json')) || existsSync(join(arg, 'minds'))) return { pub: arg, aiDir: existsSync(join(arg, '..', 'state')) ? join(arg, '..') : null };
  if (existsSync(join(arg, 'pub'))) return { pub: join(arg, 'pub'), aiDir: arg };
  return { pub: arg, aiDir: null };
}

/** A lazy reader over a published bundle (PUB). Every getter returns null / [] / an empty Map for what is not there. */
export function openPub(pub) {
  const cache = new Map();
  const memo = (k, f) => { if (!cache.has(k)) cache.set(k, f()); return cache.get(k); };
  const byBell = (dir) => memo(`dir:${dir}`, () => {
    const m = new Map();
    for (const b of numericJson(join(pub, dir))) m.set(b, readJson(join(pub, dir, `${b}.json`)));
    return m;
  });
  const api = {
    dir: pub,
    path: (...p) => join(pub, ...p),
    exists: (...p) => existsSync(join(pub, ...p)),
    json: (...p) => readJson(join(pub, ...p)),
    bytes: (...p) => (existsSync(join(pub, ...p)) ? readFileSync(join(pub, ...p)) : null),
    commitments: () => memo('commitments', () => readJson(join(pub, 'commitments.json'))),
    commitmentsBytes: () => api.bytes('commitments.json'),
    roster: () => memo('roster', () => readJson(join(pub, 'roster.json'))),
    commitAnchor: () => memo('commit', () => readJson(join(pub, 'anchors', 'commit.json'))),
    anchorsIndex: () => memo('anchors-index', () => readJson(join(pub, 'anchors', 'index.json'))),
    anchors: () => byBell('anchors'),
    minds: () => byBell('minds'),
    talk: () => byBell('talk'),
    open: () => byBell('open'),
    late: () => byBell('minds/late'),
    redactions: () => memo('redactions', () => { const r = readJson(join(pub, 'redactions.json'), []); return Array.isArray(r) ? r : []; }),
    /** council files `<k>-<f>.json` in file-name order */
    councils: () => memo('councils', () => {
      const dir = join(pub, 'council');
      if (!existsSync(dir)) return [];
      return readdirSync(dir).filter(n => /^\d+-\d+\.json$/.test(n)).sort((a, b) => { const [ka, fa] = a.split(/[-.]/).map(Number), [kb, fb] = b.split(/[-.]/).map(Number); return fa - fb || ka - kb; })
        .map(n => ({ name: n, ...readJson(join(dir, n)) }));
    }),
    memoryFile: tag => readJson(join(pub, 'memory', tag, 'episodes.json')),
    fullIndex: () => memo('full-index', () => readJson(join(pub, 'full', 'index.json'))),
    fullRequest: id => (existsSync(join(pub, 'full', 'requests', `${id}.json`)) ? readFileSync(join(pub, 'full', 'requests', `${id}.json`), 'utf8') : null),
    fullDecision: id => readJson(join(pub, 'full', 'decisions', `${id}.json`)),
    fullOpen: id => readJson(join(pub, 'full', 'open', `${id}.json`)),
    fullSocial: () => memo('full-social', () => readJson(join(pub, 'full', 'social.json'))),
    /** every record of the minds files (in bell order) with its bell */
    mindsRecords: () => memo('minds-records', () => {
      const out = [];
      for (const [b, f] of api.minds()) for (const r of f?.records ?? []) out.push({ bell: b, record: r });
      return out;
    }),
    lastMindsRoot: () => {
      const m = api.minds();
      const bells = [...m.keys()];
      return bells.length ? (m.get(bells[bells.length - 1])?.root ?? ZERO_ROOT) : ZERO_ROOT;
    },
  };
  return api;
}

// ------------------------------------------------------------------ the check accumulator
export function createCheck(id, title = '') {
  const c = { id, title, n: 0, failures: [], notes: [], unmeasured: [], unverified: [], skipped: null, extra: {} };
  const api = {
    id,
    count: (k = 1) => { c.n += k; },
    fail(code, detail = {}) { c.failures.push({ code, ...detail }); },
    note(text) { c.notes.push(String(text)); },
    /** a field the run itself left unmeasured (smoke runs, 7.1 R9) */
    unmeasured(field, why) { c.unmeasured.push({ field, why }); },
    /** a field the verifier was not given the input to check */
    unverified(field, why) { c.unverified.push({ field, why }); },
    skip(reason) { c.skipped = reason; },
    set(k, v) { c.extra[k] = v; },
    get failed() { return c.failures.length > 0; },
    result() {
      const pass = c.failures.length ? false : c.skipped || c.unmeasured.length || c.unverified.length ? null : true;
      return { pass, n: c.n, failures: c.failures, ...(c.unmeasured.length ? { unmeasured: c.unmeasured } : {}), ...(c.unverified.length ? { unverified: c.unverified } : {}), ...(c.skipped ? { skipped: c.skipped } : {}), ...(c.notes.length ? { notes: c.notes } : {}), ...c.extra };
    },
  };
  return api;
}

/** FAIL when a check is false, INCOMPLETE when none is false and one is null, else PASS. */
export function verdictOf(checks) {
  const vals = Object.values(checks).map(c => c.pass);
  if (vals.includes(false)) return 'FAIL';
  if (vals.includes(null)) return 'INCOMPLETE';
  return 'PASS';
}

// ------------------------------------------------------------------ loopback only (7.1 Guards)
export function assertLoopback(url, what = 'url') {
  let u;
  try { u = new URL(url); } catch { throw new Error(`${what}: ${url} is not a URL`); }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (u.protocol !== 'http:' || (host !== '127.0.0.1' && host !== '::1')) throw new Error(`${what}: ${url} is not a loopback URL (http on 127.0.0.1 or ::1 only)`);
  return u.origin;
}

/** Group an array by a key function. */
export function groupBy(list, f) {
  const m = new Map();
  for (const x of list) { const k = f(x); (m.get(k) ?? m.set(k, []).get(k)).push(x); }
  return m;
}
