// The registrar (contract §1.3 C8, §6.3, §7.1, §8.4; unit AC5): the one process in the AI stack that holds a
// key (KEYS/registrar.json, a local test key, airdropped on the local chain). It
//   commit   signs PUB/commitments.json before genesis and anchors its sha256 with a Memo on the local chain
//   deal     signs PUB/roster.json after genesis (the deal of §2.3 from the genesis seed)
//   run      anchors every closed bell: Memo `wylls-ai/1 <season> <bell> <social_root> <minds_root>`
//   publish  closes the season: anchors index, the season-end trigger for the audit
// and keeps the RUNS.md format (one block per invocation of the run script, aborted runs included).
//
//   node registrar.mjs slots   --stack T --n 12 --out AI_DIR/ai-slots.json
//   node registrar.mjs commit  --ai-dir D --key KEYS/registrar.json --stack T --citizens-config F --slots F
//                              [--deck deck-3] [--model P] [--model-sha256 H] [--llama-dir D] [--inputs J]   (a non-smoke config needs --model and --llama-dir)
//                              [--prepare-only | --wait-rpc URL [--herald URL]] [--allow-dirty]
//   node registrar.mjs deal    --ai-dir D --key K --herald URL --stack T
//   node registrar.mjs run     --ai-dir D --key K --rpc URL [--stack T] [--poll-ms 2000] [--until-bell N] [--memo-tries N --memo-interval-ms MS]
//   node registrar.mjs publish --ai-dir D --key K --herald URL --rpc URL [--stack T] [--wait-last-secs N] [--memo-tries N --memo-interval-ms MS]
//   node registrar.mjs runs-add | runs-end  (RUNS.md lines, see formatRunBlock)
//
// Everything it talks to is on 127.0.0.1 or ::1, and it refuses a chain that is not the local test chain: the
// herald must say `cluster = localnet` and the RPC's genesis hash must be the one `frontier-localnet` derives from
// its game-clock origin. It runs outside the citizens service's permission sandbox (it holds the key); the service
// never reads KEYS.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import bs58 from 'bs58';
import { promptTemplatesSha256 } from './mind/templates-hash.mjs';
import { acquireFile, pidAlive, rewriteHeld } from './lock.mjs';

/** True when this file is the program being run (symlinked temp directories, such as macOS /var, resolve to the same real path). */
function isMain() {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');
const HTTP = 'http:'; // (a literal scheme-and-slashes in this file would trip the G10 outside-URL grep)

/** SPL Memo v2 (a default program of LiteSVM 0.16, which frontier-localnet embeds). */
export const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const MEMO_PREFIX = 'wylls-ai/1';
export const COMMIT_BASE = '30ba411';
export const REGISTRAR_AIRDROP = 10_000_000_000; // 10 test SOL
export const FIRST_AI_INDEX = 1000;
export const LABELS = Object.freeze({
  ai: 'AI citizen, Gemma 4 local',
  script: 'script bot: not AI, not human',
  seat: 'Presenter (operator, human)',
});
/** §7.1's pinned llama-server flags (AC1a's start-pinned.sh runs exactly these). */
export const PINNED_LLAMA_FLAGS = Object.freeze(['--jinja', '--reasoning', 'off', '-np', '1', '-c', '16384', '-ngl', '999', '-fa', 'on', '--no-webui', '--metrics', '--host', '127.0.0.1', '--port', '41901', '--alias', 'gemma-4-26b-a4b-it']);
export const PINNED_MODEL = Object.freeze({ file: 'gemma-4-26B-A4B-it-Q4_0.gguf', sha256: 'd208665ab1cd3a69f7a9a4bc59430e8448c8093d9b06334f566ac59d6d504a03', alias: 'gemma-4-26b-a4b-it' });
/**
 * What a commitments field holds when nothing measured it (v1.3, R9): a smoke run may leave AI_MODEL and AI_LLAMA_DIR unset; its
 * `model.file`, `model.sha256` and `server.tree_sha256` then say this string, never the pinned constants of PINNED_MODEL (wave A
 * asserted those without measuring them). verify-minds M1 prints such a field as `unmeasured`, never as PASS, and a run with an
 * unmeasured field is not cited for audit claims.
 */
export const UNMEASURED = 'unmeasured';
/** A smoke run is the one that uses the citizens config named smoke.json (contract 7.1: every other config is a non-smoke run). */
export const isSmokeConfig = citizensConfigPath => path.basename(String(citizensConfigPath ?? '')) === 'smoke.json';
export const SEED_RULE = "u32_le(sha256('wylls-mind-seed/v1' ‖ season u64 ‖ index u32 ‖ bell u32 ‖ kind u8 ‖ attempt u8)[0..4])";
/** The paths the dirty-tree guard and the commitments cover (§7.1 Guards). */
export const GUARDED_PATHS = Object.freeze(['permutation-gateway/citizens', 'permutation-server/web/frontier/council', 'permutation-server/web/frontier/council.html', 'frontier-node/crates/bots', 'frontier-node/crates/agents', 'frontier-node/crates/herald', 'frontier-node/crates/stack']);

// ------------------------------------------------------------------ small helpers
export const sha256 = data => crypto.createHash('sha256').update(data).digest();
export const sha256hex = data => sha256(data).toString('hex');
const u64le = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const i64le = n => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
const u32le = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

/** Canonical JSON (§7.1): keys sorted at every level, no spaces, UTF-8. Refuses what JSON cannot carry exactly. */
export function canonicalJson(v) {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('canonicalJson: a number is not finite');
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object') {
    const keys = Object.keys(v).sort();
    for (const k of keys) if (v[k] === undefined) throw new Error(`canonicalJson: ${k} is undefined`);
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  }
  throw new Error(`canonicalJson: ${typeof v} is not JSON`);
}

export function writeAtomic(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data, mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

export const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', '::1']);
/** `{host, port, url}` of a loopback http URL (the registrar talks to nothing else). */
export function loopbackUrl(url, what) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`${what}: not a URL (${url})`); }
  const host = u.hostname === '[::1]' ? '::1' : u.hostname;
  if (u.protocol !== HTTP || !LOOPBACK_HOSTS.includes(host)) throw new Error(`${what}: ${url} is not a loopback URL (127.0.0.1 or ::1 only)`);
  return { host, port: Number(u.port), url: `${HTTP}//${u.host}` };
}

// ------------------------------------------------------------------ keys
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const privateKeyOf = seed32 => crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed32]), format: 'der', type: 'pkcs8' });
export const signBytes = (seed32, msg) => crypto.sign(null, Buffer.from(msg), privateKeyOf(Buffer.from(seed32)));
export const verifyBytes = (pub32, msg, sig) => crypto.verify(null, Buffer.from(msg), crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(pub32)]), format: 'der', type: 'spki' }), Buffer.from(sig));
export const pubOfSeed = seed32 => crypto.createPublicKey(privateKeyOf(Buffer.from(seed32))).export({ format: 'der', type: 'spki' }).subarray(-32);

/** The bot wallet of `agents/src/keys.rs`: ed25519(sha256("PS-FRONTIER-BOT-v1" ‖ le64(seed) ‖ le32(index) ‖ "wallet")). Test keys: the seed is public. */
export function walletOf(seed, index) {
  const sk = sha256(Buffer.concat([Buffer.from('PS-FRONTIER-BOT-v1'), u64le(seed), u32le(index), Buffer.from('wallet')]));
  const pub = pubOfSeed(sk);
  return { index, pub, b58: bs58.encode(pub) };
}

/** KEYS/registrar.json: the Solana CLI format (64 bytes as JSON), mode 0600, never under PUB or STATE. */
export function assertKeyPathAllowed(keyPath, aiDir) {
  const k = path.resolve(keyPath);
  for (const dir of ['pub', 'state']) {
    const d = path.resolve(aiDir, dir);
    if (k === d || k.startsWith(d + path.sep)) throw new Error(`the registrar key path ${keyPath} lies under ${dir.toUpperCase()}: keys live in KEYS only`);
  }
}
export function loadOrCreateKey(keyPath, aiDir) {
  if (aiDir) assertKeyPathAllowed(keyPath, aiDir);
  let kp;
  if (fs.existsSync(keyPath)) {
    kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, 'utf8'))));
  } else {
    kp = Keypair.generate();
    fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
    writeAtomic(keyPath, JSON.stringify(Array.from(kp.secretKey)), 0o600);
  }
  return kp;
}
const seedOfKeypair = kp => Buffer.from(kp.secretKey.subarray(0, 32));

// ------------------------------------------------------------------ the slots file (§2.3) and the deal inputs
/** `AI_DIR/ai-slots.json`: n AI slots (index 1000+i, faction i mod 6, join_bell i) and the seat (index 1000+n, faction 0). */
export function makeSlots({ seed, n, firstIndex = FIRST_AI_INDEX }) {
  if (![6, 12, 18].includes(n)) throw new Error(`n = ${n}: the pinned decks give 6 (deck-1), 12 (deck-2) or 18 (deck-3) AI citizens`);
  const slots = [];
  for (let i = 0; i < n; i++) slots.push({ index: firstIndex + i, faction: i % 6, join_bell: i, kind: 'ai' });
  slots.push({ index: firstIndex + n, faction: 0, join_bell: 0, kind: 'seat' });
  return { v: 1, seed: Number(seed), first_index: firstIndex, slots };
}

// ------------------------------------------------------------------ the stack toml subset (stack/src/toml.rs: strings, integers, floats, booleans)
export function parseStackToml(text) {
  const out = {};
  let section = '';
  text.split('\n').forEach((raw, n) => {
    let line = raw;
    let inStr = false;
    for (let i = 0; i < line.length; i++) { if (line[i] === '"') inStr = !inStr; else if (line[i] === '#' && !inStr) { line = line.slice(0, i); break; } }
    line = line.trim();
    if (!line) return;
    if (line.startsWith('[')) {
      if (!line.endsWith(']')) throw new Error(`line ${n + 1}: bad section header`);
      section = line.slice(1, -1).trim();
      return;
    }
    const eq = line.indexOf('=');
    if (eq < 0) throw new Error(`line ${n + 1}: expected key = value`);
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(k)) throw new Error(`line ${n + 1}: bad key ${k}`);
    const full = section ? `${section}.${k}` : k;
    if (full in out) throw new Error(`line ${n + 1}: ${full} given twice`);
    let val;
    if (v.startsWith('"')) {
      if (!v.endsWith('"') || v.length < 2) throw new Error(`line ${n + 1}: unclosed string`);
      val = v.slice(1, -1);
      if (val.includes('"') || val.includes('\\')) throw new Error(`line ${n + 1}: escapes are not supported`);
    } else if (v === 'true' || v === 'false') val = v === 'true';
    else if (/^-?[0-9_]+$/.test(v)) val = Number(v.replace(/_/g, ''));
    else if (Number.isFinite(Number(v.replace(/_/g, '')))) val = Number(v.replace(/_/g, ''));
    else throw new Error(`line ${n + 1}: bad value ${v}`);
    out[full] = val;
  });
  return out;
}

// ------------------------------------------------------------------ hashing the tree
export const sha256File = p => sha256hex(fs.readFileSync(p));
/** sha256 over the sorted `path\0sha256\n` lines of the regular files under `dir` (links to files are followed, links to nowhere hash their target text). */
export function treeSha256Dir(dir) {
  const lines = [];
  const walk = (d, rel) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      let st;
      try { st = fs.statSync(p); } catch { lines.push(`${r}\0link:${fs.readlinkSync(p)}\n`); continue; }
      if (st.isDirectory()) walk(p, r);
      else if (st.isFile()) lines.push(`${r}\0${sha256File(p)}\n`);
    }
  };
  walk(dir, '');
  return sha256hex(lines.sort().join(''));
}
/** `sha256 over sorted path\0sha256\n` of the files matching `ext` directly in `dir` (the prompt templates). */
export function filesSha256(dir, ext) {
  if (!fs.existsSync(dir)) return null;
  const lines = fs.readdirSync(dir).filter(n => n.endsWith(ext)).sort().map(n => `${n}\0${sha256File(path.join(dir, n))}\n`);
  return sha256hex(lines.join(''));
}
/**
 * `episode_kinds_sha256`: sha256 of the canonical JSON of the sorted episode kinds, which are the keys of `kinds` in
 * `memory/templates.en.json` (the kinds that have a text template; memory/config.mjs KINDS is the same list, a test ties them).
 * Null when the file or its `kinds` is missing (visible in the file; the first version hashed the file's TOP-LEVEL keys, a
 * constant that did not move when a kind was added).
 */
export function episodeKindsSha256(templatesPath) {
  if (!fs.existsSync(templatesPath)) return null;
  const kinds = JSON.parse(fs.readFileSync(templatesPath, 'utf8')).kinds;
  if (!kinds || typeof kinds !== 'object') return null;
  return sha256hex(canonicalJson(Object.keys(kinds).sort()));
}
/** The git tree hash of `repoPath` at HEAD, or null when HEAD has no such path. */
export function gitTree(repoRoot, repoPath) {
  try { return execFileSync('git', ['-C', repoRoot, 'rev-parse', `HEAD:${repoPath}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}
export const gitHead = repoRoot => execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
export function dirtyPaths(repoRoot, paths = GUARDED_PATHS) {
  const out = execFileSync('git', ['-C', repoRoot, 'status', '--porcelain', '--', ...paths], { encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}
/** One hash for several git trees: sha256 over the sorted `path\0tree\n` lines (the candidate generator spans two crates). */
export function combinedTreeHash(repoRoot, paths) {
  const lines = paths.map(p => `${p}\0${gitTree(repoRoot, p)}\n`).sort();
  return sha256hex(lines.join(''));
}

// ------------------------------------------------------------------ commitments (§7.1)
const hashOrNull = p => (p && fs.existsSync(p) ? sha256File(p) : null);
const firstExisting = ps => ps.find(p => fs.existsSync(p)) ?? null;

/** The §7.1 `rules` block from a citizens config (`config/{main,ab,smoke}.json`); refuses a config that lacks a pinned key. */
export function rulesFromConfig(cfg) {
  const need = (o, keys, where) => { for (const k of keys) if (o?.[k] === undefined) throw new Error(`citizens config: ${where}.${k} is missing`); };
  need(cfg, ['council', 'caps', 'budgets', 'gate', 'memory'], '');
  need(cfg.council, ['period', 'offset', 'strike_lead', 'human_present'], 'council');
  need(cfg.caps, ['march_share', 'day_share', 'home_floor', 'marches_per_day'], 'caps');
  need(cfg.gate, ['pulse', 'threshold', 'social_cap'], 'gate');
  need(cfg.memory, ['reflect_every', 'reflection', 'retrieve', 'block_tokens'], 'memory');
  need(cfg.memory.retrieve, ['top', 'newest', 'half_life_bells', 'focus_bonus'], 'memory.retrieve');
  const { period, offset, strike_lead, human_present } = cfg.council;
  const { pulse, threshold, social_cap } = cfg.gate;
  return { council: { period, offset, strike_lead, human_present }, caps: cfg.caps, budgets: cfg.budgets, gate: { pulse, threshold, social_cap }, memory: cfg.memory };
}

/**
 * Gathers what §7.1 commits to from the checked-out tree and the run's files.
 * `opts`: repoRoot, aiDir, stackPath, citizensConfigPath, slotsPath, deck, runId, seasonId, model{file,sha256,alias}, llama{...}, seatScriptPath, now.
 * Missing optional parts of a unit that is not merged yet come out as null; a null is visible in the file.
 */
export function collectInputs(opts) {
  const root = opts.repoRoot ?? REPO_ROOT;
  const cit = path.join(root, 'permutation-gateway', 'citizens');
  const stack = parseStackToml(fs.readFileSync(opts.stackPath, 'utf8'));
  const cfg = JSON.parse(fs.readFileSync(opts.citizensConfigPath, 'utf8'));
  const slotsFile = JSON.parse(fs.readFileSync(opts.slotsPath, 'utf8'));
  const deck = opts.deck;
  const seasonId = opts.seasonId ?? stack.season_id;
  const runId = opts.runId ?? stack.run_id;
  if (seasonId === undefined || !runId) throw new Error('the stack config needs run_id and season_id');
  if (!/^deck-[0-9]+$/.test(deck ?? '')) throw new Error(`deck ${deck}: expected deck-<k>`);
  const slots = slotsFile.slots.map(s => ({ index: s.index, wallet: walletOf(slotsFile.seed, s.index).b58, faction: s.faction, kind: s.kind }));
  if (slotsFile.seed !== stack.bot_seed) throw new Error(`the slots file's seed ${slotsFile.seed} is not the stack's bot_seed ${stack.bot_seed}`);
  const memDir = path.join(cit, 'memory');
  const episodesFile = path.join(memDir, 'episodes.mjs');
  const kindsSource = path.join(memDir, 'templates.en.json');
  const episodeKinds = episodeKindsSha256(kindsSource);
  const llama = opts.llama ?? {};
  const flags = llama.flags ?? [...PINNED_LLAMA_FLAGS];
  // R9: measured, or the string "unmeasured"; never the pinned constants (those are what the run script's /props check compares with)
  if (llama.dir && !fs.existsSync(llama.dir)) throw new Error(`--llama-dir ${llama.dir} does not exist: nothing to measure`);
  const model = opts.model?.sha256 ? { file: opts.model.file ?? UNMEASURED, sha256: opts.model.sha256, alias: opts.model.alias } : { file: UNMEASURED, sha256: UNMEASURED, alias: opts.model?.alias };
  return {
    run_id: runId,
    season_id: seasonId,
    created_unix: Math.floor((opts.now ?? Date.now)() / 1000),
    model: { file: model.file, sha256: model.sha256, alias: model.alias ?? PINNED_MODEL.alias },
    server: {
      llama_cpp: llama.llama_cpp ?? 'b11146 / 7fe450e19 (Homebrew 0.5.0)',
      tree_sha256: llama.tree_sha256 ?? (llama.dir ? treeSha256Dir(llama.dir) : UNMEASURED),
      flags,
      flags_sha256: sha256hex(canonicalJson(flags)),
      request_shape: 'response_format',
      backend: llama.backend ?? 'Metal, M4 Max',
    },
    sampling: { temperature: 0, top_k: 1, cache_prompt: false, seed_rule: SEED_RULE },
    code: {
      git_commit: gitHead(root),
      prompt_templates_sha256: fs.existsSync(path.join(cit, 'prompts')) ? promptTemplatesSha256(path.join(cit, 'prompts')) : null,
      mind_tree: gitTree(root, 'permutation-gateway/citizens'),
      candidate_generator_tree: combinedTreeHash(root, ['frontier-node/crates/bots/src', 'frontier-node/crates/agents/src']),
      page_tree: gitTree(root, 'permutation-server/web/frontier/council'),
      memory_tree: gitTree(root, 'permutation-gateway/citizens/memory'),
      episodes_module_sha256: hashOrNull(episodesFile),
      episode_kinds_sha256: episodeKinds,
      serve_sha256: sha256File(path.join(cit, 'serve.mjs')),
    },
    configs: {
      citizens_config_sha256: sha256File(opts.citizensConfigPath),
      stack_toml_sha256: sha256File(opts.stackPath),
      slots_sha256: sha256File(opts.slotsPath),
      seat_script_sha256: hashOrNull(opts.seatScriptPath),
      injection_corpus_sha256: hashOrNull(firstExisting([path.join(cit, 'injection', 'corpus.json'), path.join(cit, 'injection', 'corpus.mjs')])),
    },
    personas: {
      library_sha256: hashOrNull(path.join(cit, 'persona', 'library.json')),
      deck,
      deck_sha256: hashOrNull(path.join(cit, 'persona', 'decks', `${deck}.json`)),
      deal_rule: '§2.3 v1.2',
    },
    slots,
    slots_root: sha256hex(canonicalJson(slots)),
    rules: rulesFromConfig(cfg),
  };
}

/** The §7.1 object, unsigned. `registrar` = the b58 public key. */
export function buildCommitments(inputs, registrarB58) {
  const { run_id, season_id, created_unix, ...rest } = inputs;
  return { v: 1, run_id, season_id, created_unix, ...rest, registrar: registrarB58 };
}

/** Sign: `sig` = base64 ed25519 over the canonical JSON without `sig`. The file is the canonical JSON of the signed object. */
export function signObject(obj, kp) {
  const { sig: _drop, ...body } = obj;
  const sig = signBytes(seedOfKeypair(kp), canonicalJson(body));
  return { ...body, sig: sig.toString('base64') };
}
export const verifySigned = (obj, pubB58) => {
  try {
    const { sig, ...body } = obj;
    return typeof sig === 'string' && verifyBytes(new PublicKey(pubB58).toBytes(), canonicalJson(body), Buffer.from(sig, 'base64'));
  } catch { return false; }
};
/** The bytes written to PUB/commitments.json; its sha256 is what the commit memo carries. */
export const fileBytes = obj => Buffer.from(canonicalJson(obj), 'utf8');

export const commitMemoText = (season, sha) => `${MEMO_PREFIX} commit ${season} ${sha}`;
export const anchorMemoText = (season, bell, social, minds) => `${MEMO_PREFIX} ${season} ${bell} ${social} ${minds}`;
export const ZERO_ROOT = '00'.repeat(32);

/** Prepare: collect, refuse a dirty tree, sign, write `PUB/commitments.json` atomically. Returns `{obj, bytes, sha256, file}`. */
export function prepareCommitments(opts) {
  const root = opts.repoRoot ?? REPO_ROOT;
  if (!opts.allowDirty) {
    const dirty = dirtyPaths(root);
    if (dirty.length) throw new Error(`refusing to commit to a dirty tree: ${dirty.slice(0, 5).join('; ')}`);
  }
  const kp = loadOrCreateKey(opts.keyPath, opts.aiDir);
  const inputs = { ...collectInputs(opts), ...(opts.override ?? {}) };
  const obj = signObject(buildCommitments(inputs, kp.publicKey.toBase58()), kp);
  const bytes = fileBytes(obj);
  const file = path.join(opts.aiDir, 'pub', 'commitments.json');
  writeAtomic(file, bytes);
  return { obj, bytes, sha256: sha256hex(bytes), file, kp };
}

// ------------------------------------------------------------------ the local chain
/** What `frontier-localnet` derives (localnet/src/chain.rs): sha256("PSF-LOCALNET-GENESIS" ‖ g0 i64 ‖ slot0 u64), base58. */
export const localnetGenesisHash = (g0, slot0 = 1) => bs58.encode(sha256(Buffer.concat([Buffer.from('PSF-LOCALNET-GENESIS'), i64le(g0), u64le(slot0)])));

export class Rpc {
  constructor(url, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
    this.url = loopbackUrl(url, 'rpc').url;
    Object.assign(this, { fetchImpl, timeoutMs });
    this.id = 0;
  }
  async call(method, params = []) {
    const res = await this.fetchImpl(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }), signal: AbortSignal.timeout(this.timeoutMs) });
    const j = await res.json();
    if (j.error) { const e = new Error(`rpc ${method}: ${j.error.message}`); e.rpc = j.error; throw e; }
    return j.result;
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function waitHealthy(rpc, { timeoutMs = 600_000, intervalMs = 500 } = {}) {
  const t0 = Date.now();
  for (;;) {
    try { if ((await rpc.call('getHealth')) === 'ok') return; } catch { /* not up yet */ }
    if (Date.now() - t0 > timeoutMs) throw new Error(`rpc ${rpc.url}: not healthy after ${timeoutMs} ms`);
    await sleep(intervalMs);
  }
}

/** Refuses a chain that is not the local test chain (the RPC half; the herald half is `assertHeraldLocalnet`). */
export async function assertLocalnetRpc(rpc, g0) {
  const want = localnetGenesisHash(g0);
  const got = await rpc.call('getGenesisHash');
  if (got !== want) throw new Error(`rpc ${rpc.url}: genesis hash ${got} is not the local test chain's ${want} (g0 ${g0}); refusing`);
}
export async function assertHeraldLocalnet(heraldUrl, fetchImpl = fetch) {
  const { url } = loopbackUrl(heraldUrl, 'herald');
  const s = await (await fetchImpl(`${url}/h/season`, { signal: AbortSignal.timeout(10_000) })).json();
  if (s.cluster !== 'localnet') throw new Error(`herald ${url}: cluster is ${JSON.stringify(s.cluster)}, not localnet; refusing`);
  return s;
}

export async function ensureFunded(rpc, kp, lamports = REGISTRAR_AIRDROP, { floor = 1_000_000_000 } = {}) {
  const bal = async () => { const r = await rpc.call('getBalance', [kp.publicKey.toBase58()]); return typeof r === 'number' ? r : r.value; };
  if ((await bal()) >= floor) return;
  await rpc.call('requestAirdrop', [kp.publicKey.toBase58(), lamports]);
  for (let i = 0; i < 40; i++) { if ((await bal()) >= floor) return; await sleep(250); }
  throw new Error('the registrar airdrop did not land');
}

/** A legacy transaction with one SPL Memo instruction signed by `kp` (the signer is listed, so the memo program checks it). */
export function memoTransaction(kp, text, recentBlockhash) {
  if (Buffer.byteLength(text) > 566) throw new Error('memo longer than one transaction can carry');
  const tx = new Transaction({ feePayer: kp.publicKey, recentBlockhash });
  tx.add(new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM_ID), keys: [{ pubkey: kp.publicKey, isSigner: true, isWritable: false }], data: Buffer.from(text, 'utf8') }));
  tx.sign(kp);
  return tx.serialize();
}

/** Send a memo and wait for its status: `{signature, slot, blockTime}` (blockTime from the chain's clock, not ours). */
export async function sendMemo(rpc, kp, text, { tries = 40, intervalMs = 250, onSigned = null } = {}) {
  const bh = await rpc.call('getLatestBlockhash');
  const wire = memoTransaction(kp, text, (bh.value ?? bh).blockhash);
  const signature = await rpc.call('sendTransaction', [wire.toString('base64'), { encoding: 'base64' }]);
  onSigned?.(signature); // the memo is on its way: a caller that fails after this point must look the signature up before it sends again
  for (let i = 0; i < tries; i++) {
    const st = (await rpc.call('getSignatureStatuses', [[signature]])).value?.[0];
    if (st) {
      if (st.err) throw new Error(`memo ${signature} failed: ${JSON.stringify(st.err)}`);
      const tx = await rpc.call('getTransaction', [signature, { encoding: 'json' }]);
      return { signature, slot: st.slot, blockTime: tx?.blockTime ?? null };
    }
    await sleep(intervalMs);
  }
  throw new Error(`memo ${signature}: no status after ${tries} tries`);
}

// ------------------------------------------------------------------ commit flow (§7.1)
/** PUB/anchors/commit.json: where the commit memo landed and whether it came before genesis. */
export function commitAnchorRecord({ sha, memo, genesisTs }) {
  const before = memo.blockTime !== null && genesisTs !== null && memo.blockTime < genesisTs;
  return {
    v: 1, commitments_sha256: sha, memo_text_prefix: `${MEMO_PREFIX} commit`, signature: memo.signature, slot: memo.slot, block_time: memo.blockTime, genesis_ts: genesisTs,
    status: before ? 'audited' : 'unaudited',
    ...(before ? {} : { reason: genesisTs === null ? 'genesis_ts not read yet' : `memo block time ${memo.blockTime} is not before genesis ${genesisTs}` }),
  };
}

export async function anchorCommit({ aiDir, kp, rpc, g0, sha, season, herald, heraldWaitMs = 900_000, fetchImpl = fetch, log = () => {} }) {
  await waitHealthy(rpc);
  await assertLocalnetRpc(rpc, g0);
  await ensureFunded(rpc, kp);
  const memo = await sendMemo(rpc, kp, commitMemoText(season, sha));
  const file = path.join(aiDir, 'pub', 'anchors', 'commit.json');
  writeAtomic(file, `${JSON.stringify(commitAnchorRecord({ sha, memo, genesisTs: null }))}\n`);
  log(`commit memo ${memo.signature} slot ${memo.slot} block time ${memo.blockTime}`);
  if (!herald) return { memo, status: 'unaudited', file };
  // After the herald is up: the memo's block time must precede genesis (the 24-h preseason runs about 43 s; a miss labels the run "unaudited").
  const t0 = Date.now();
  let genesisTs = null;
  for (;;) {
    try {
      const s = await assertHeraldLocalnet(herald, fetchImpl);
      genesisTs = Number(s.genesisTs);
      break;
    } catch (e) {
      if (/not localnet/.test(e.message)) throw e;
      if (Date.now() - t0 > heraldWaitMs) break;
      await sleep(1000);
    }
  }
  const rec = commitAnchorRecord({ sha, memo, genesisTs: Number.isFinite(genesisTs) ? genesisTs : null });
  writeAtomic(file, `${JSON.stringify(rec)}\n`);
  log(`commit anchor: ${rec.status}${rec.reason ? ` (${rec.reason})` : ''}`);
  return { memo, status: rec.status, file, record: rec };
}

// ------------------------------------------------------------------ the deal and the roster (§2.3, §8.3)
/** The GENESIS_SEED record (kind 3) of `/h/events`: `{round, seed}`. */
export async function readGenesisSeed(heraldUrl, fetchImpl = fetch) {
  const { url } = loopbackUrl(heraldUrl, 'herald');
  let after = '0';
  for (let page = 0; page < 40; page++) {
    const j = await (await fetchImpl(`${url}/h/events?after=${after}&limit=500`, { signal: AbortSignal.timeout(15_000) })).json();
    for (const e of j.events ?? []) if (e.kind === 3 && e.decoded?.name === 'GENESIS_SEED') return { round: String(e.decoded.payload.round), seed: e.decoded.payload.seed };
    if (!j.events?.length || String(j.next) === after) break;
    after = String(j.next);
  }
  throw new Error('no GENESIS_SEED record in /h/events (the season has not reached genesis)');
}

/**
 * Build the signed roster. `deps` carries the AC2 and web modules, so tests can double them:
 * `deal(seed32, deck, slots) → [{index, persona, creed_variant, temperament}]`, `library` (persona id → {ambition}),
 * `deck` (ordered persona ids), `tagOf(programId, seasonId, wallet) → tag`, `nameOf(tag) → {en, ja}`.
 */
export function buildRoster({ commitments, commitmentsSha, season, genesis, deps, kp }) {
  const slots = commitments.slots;
  const ais = slots.filter(s => s.kind === 'ai');
  const seat = slots.find(s => s.kind === 'seat');
  const dealt = deps.deal(Buffer.from(genesis.seed, 'hex'), deps.deck, ais.map(s => ({ index: s.index, faction: s.faction, kind: 'ai' }))); // integ-A: AC2's deal keeps only slots with kind 'ai'
  const byIndex = new Map(dealt.map(d => [d.index, d]));
  const ai = ais.map(s => {
    const d = byIndex.get(s.index);
    if (!d) throw new Error(`the deal returned nothing for slot ${s.index}`);
    const tag = deps.tagOf(season.programId, season.season, s.wallet);
    return { index: s.index, wallet: s.wallet, tag, faction: s.faction, persona: d.persona, ambition: deps.library[d.persona]?.ambition ?? null, creed_variant: d.creed_variant, temperament: d.temperament, name: deps.nameOf(tag), kind: 'ai', label: LABELS.ai };
  });
  const scriptCount = deps.scriptCount;
  const body = {
    v: 1,
    season: Number(season.season),
    program_id: season.programId,
    genesis_round: genesis.round,
    genesis_seed: genesis.seed,
    deck: commitments.personas.deck,
    commitments_sha256: commitmentsSha,
    ai,
    script: { first_index: 0, count: scriptCount, wallets: Array.from({ length: scriptCount }, (_, i) => walletOf(deps.botSeed, i).b58), kind: 'script', label: LABELS.script },
    seat: seat && { index: seat.index, wallet: seat.wallet, tag: deps.tagOf(season.programId, season.season, seat.wallet), faction: seat.faction, kind: 'seat', label: LABELS.seat, scripted: commitments.configs.seat_script_sha256 !== null },
  };
  return signObject(body, kp);
}

// ------------------------------------------------------------------ per-bell anchors (§6.3)
const numericJson = dir => (fs.existsSync(dir) ? fs.readdirSync(dir).map(n => /^(\d+)\.json$/.exec(n)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b) : []);
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const readJsonOrNull = p => { try { return readJson(p); } catch { return null; } };
export const ANCHOR_RETRY_BELLS = 3;

/** The roots of a closed bell, or null until both the talk file and the minds file exist. */
export function closedBellRoots(pub, bell) {
  const t = path.join(pub, 'talk', `${bell}.json`);
  const m = path.join(pub, 'minds', `${bell}.json`);
  if (!fs.existsSync(t) || !fs.existsSync(m)) return null;
  const social = readJson(t).root ?? ZERO_ROOT;
  const minds = readJson(m).root ?? ZERO_ROOT;
  return { social_root: social, minds_root: minds };
}

// ---- the cross-process guard of the anchors (v1.3, R9; contract 6.3 "No anchor is sent twice") -----------------------------------
// `registrar run` (the whole run) and `registrar publish` (the end of the run) both walk the closed bells, and the run script keeps
// the first alive while it starts the second, so both could find the last bells without an anchor and send each memo twice. Every
// bell therefore has a CLAIM FILE under KEYS (`<AI_DIR>/keys/anchor-claims/<bell>.json`, never served: KEYS is not PUB) created
// with the atomic create of lock.mjs before a memo is sent: exactly one process holds a bell's claim, the other skips the bell.
//   * a claim holds {pid, bell, started, signature}; `signature` is written as soon as the memo has been sent;
//   * success keeps the claim (it records who anchored the bell) next to the anchor file;
//   * a failure before any signature removes the claim, so the next pass (or the other process) may try again;
//   * a failure AFTER the signature (the status never came back) keeps the claim with its signature: the next attempt, in this
//     process or after a takeover of a dead holder, asks the chain for that signature before it would send anything;
//   * a claim whose pid is dead is taken over race-free (lock.mjs) and its signature is checked first.
export const anchorClaimFile = (aiDir, bell) => path.join(aiDir, 'keys', 'anchor-claims', `${bell}.json`);
/** Claim a bell. `pid` is overridable for tests that stand in for two processes. Returns {ok, previous} (previous = a dead or own earlier claim). */
export function claimAnchor(aiDir, bell, { pid = process.pid, now = Date.now } = {}) {
  const file = anchorClaimFile(aiDir, bell);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const body = `${JSON.stringify({ pid, bell, started: new Date(now()).toISOString(), signature: null })}\n`;
  const r = acquireFile(file, body, { isLive: c => pidAlive(c?.pid) && c.pid !== pid }); // our own earlier claim is ours to retry
  if (r.ok) return { ok: true, previous: r.previous, file };
  return { ok: false, holder: r.holder, file };
}
const recordClaimSignature = (file, pid, bell, signature) => rewriteHeld(file, `${JSON.stringify({ pid, bell, started: new Date().toISOString(), signature })}\n`);
const releaseClaim = file => fs.rmSync(file, { force: true });
/**
 * What the chain says about a memo signature: `landed` (`slot`), `failed` (the transaction was executed and errored: the memo
 * does not exist), or `unknown` (no status yet, or the RPC could not be asked). Only `failed` frees a bell for a new memo.
 */
async function signatureState(rpc, signature) {
  try {
    const st = (await rpc.call('getSignatureStatuses', [[signature]])).value?.[0];
    if (!st) return { state: 'unknown' };
    if (st.err) return { state: 'failed', err: st.err };
    return { state: 'landed', slot: st.slot, signature };
  } catch { return { state: 'unknown' }; }
}
/** `signatureState`, asked up to `tries` times `intervalMs` apart until it is no longer `unknown` (bounded). */
async function pollSignature(rpc, signature, { tries = 8, intervalMs = 250 } = {}) {
  let last = { state: 'unknown' };
  for (let i = 0; i < Math.max(1, tries); i++) {
    last = await signatureState(rpc, signature);
    if (last.state !== 'unknown') return last;
    if (i < tries - 1) await sleep(intervalMs);
  }
  return last;
}
export const memoPendingReason = signature => `memo ${signature} was sent and no status came; it is not sent again while it may still land`;

/**
 * One pass over the closed bells that have no anchor yet, oldest first. A bell whose memo cannot be sent is tried again on
 * the next pass; once `ANCHOR_RETRY_BELLS` later bells have closed it is written as an `anchor_gap` (M3 fails for it).
 * `state.failed` (bell -> first failure message) lives with the caller. Returns the bells anchored and gapped in this pass, and the
 * bells it left to another process (`claimed`). A bell claimed by a live process is skipped and the pass stops there (memo order).
 * `pid` stands in for the process id in tests.
 *
 * FB1 (A1): a memo that was SENT is never lost and never sent again while its signature may still land. The signature of an earlier
 * attempt (this process's own earlier pass, or a process that died) arrives as `claim.previous.signature` and is written into THIS
 * attempt's claim before anything is sent (before, a second failure in the same process read the fresh claim, found no signature
 * and released the claim: the signature was lost and a third pass sent a second memo). The attempt then polls that signature
 * (`pollTries` x `pollIntervalMs`, bounded): landed -> the bell is anchored from it; failed on the chain -> the memo does not exist
 * and one new memo may be sent; no status -> the pass fails for the bell without sending (the claim keeps the signature), and after
 * `ANCHOR_RETRY_BELLS` later bells the bell is an anchor_gap whose reason names the signature.
 *
 * FB1 (A2): `sendBlocked` (a reason string, e.g. the chain is paused) sends nothing: a memo for a paused chain sits pending and
 * would confirm after the bell was declared a gap. The bell stays open (`unsent`) and the pass stops there (memo order); with
 * `gapWhenBlocked` it is written as an anchor_gap with that reason at once (the season-end index exists: nothing can anchor it).
 * `memoTries` and `memoIntervalMs` bound the wait for a status after a send (tests).
 */
export async function anchorPass({ aiDir, kp, rpc, season, state = { failed: new Map() }, log = () => {}, pid = process.pid, memoTries = 40, memoIntervalMs = 250, pollTries = 8, pollIntervalMs = 250, sendBlocked = null, gapWhenBlocked = false }) {
  const pub = path.join(aiDir, 'pub');
  const talk = numericJson(path.join(pub, 'talk'));
  const have = new Set(numericJson(path.join(pub, 'anchors')));
  const newest = talk.length ? talk[talk.length - 1] : -1;
  const done = { anchored: [], gaps: [] }; // `claimed` appears only when a bell was left to another live process; `unsent` only when sends were blocked
  for (const bell of talk) {
    if (have.has(bell)) continue;
    const roots = closedBellRoots(pub, bell);
    const file = path.join(pub, 'anchors', `${bell}.json`);
    if (!roots) {
      // the talk file is there but the minds file never came: once ANCHOR_RETRY_BELLS later bells have closed this is a gap
      // (before, such a bell was skipped forever, with neither an anchor nor an anchor_gap, and M3 could not name it)
      if (newest - bell >= ANCHOR_RETRY_BELLS && !fs.existsSync(path.join(pub, 'minds', `${bell}.json`))) {
        writeAtomic(file, `${JSON.stringify({ bell, social_root: readJson(path.join(pub, 'talk', `${bell}.json`)).root ?? ZERO_ROOT, minds_root: null, signature: null, slot: null, anchor_gap: true, reason: 'minds file missing' })}\n`);
        done.gaps.push(bell);
      }
      continue;
    }
    const claim = claimAnchor(aiDir, bell, { pid });
    if (!claim.ok) {
      if (fs.existsSync(file)) continue; // anchored by the other process while we looked
      (done.claimed ??= []).push(bell);
      log(`anchor ${bell}: claimed by pid ${claim.holder?.pid ?? '?'}; left to it`);
      break; // keep the memo order: later bells wait for this one
    }
    if (fs.existsSync(file)) continue; // anchored (by a process that has since ended) between our listing and our claim: never send it again
    // A1: the signature of an earlier attempt goes into this attempt's claim BEFORE anything is sent or polled
    let sentSig = claim.previous?.signature ?? null;
    if (sentSig) recordClaimSignature(claim.file, pid, bell, sentSig);
    try {
      let memo = null;
      if (sentSig) {
        const s = await pollSignature(rpc, sentSig, { tries: pollTries, intervalMs: pollIntervalMs });
        if (s.state === 'landed') memo = { signature: sentSig, slot: s.slot };
        else if (s.state === 'failed') {
          log(`anchor ${bell}: the earlier memo ${sentSig} failed on the chain (${JSON.stringify(s.err)}); one new memo is sent`);
          sentSig = null;
          recordClaimSignature(claim.file, pid, bell, null);
        } else throw new Error(memoPendingReason(sentSig));
      }
      if (!memo && sendBlocked) {
        releaseClaim(claim.file); // nothing was sent: the claim is not needed
        const first = !state.failed.has(bell);
        if (first) state.failed.set(bell, sendBlocked);
        if (first) log(`anchor ${bell}: not sent: ${sendBlocked}`);
        (done.unsent ??= []).push(bell);
        if (!gapWhenBlocked) break; // keep the memo order: later bells wait for this one
        writeAtomic(file, `${JSON.stringify({ bell, ...roots, signature: null, slot: null, anchor_gap: true, reason: sendBlocked })}\n`);
        state.failed.delete(bell);
        done.gaps.push(bell);
        continue;
      }
      if (!memo) memo = await sendMemo(rpc, kp, anchorMemoText(season, bell, roots.social_root, roots.minds_root), { tries: memoTries, intervalMs: memoIntervalMs, onSigned: sig => { sentSig = sig; recordClaimSignature(claim.file, pid, bell, sig); } });
      writeAtomic(file, `${JSON.stringify({ bell, ...roots, signature: memo.signature, slot: memo.slot })}\n`);
      state.failed.delete(bell);
      done.anchored.push(bell);
    } catch (e) {
      // the signature that was sent (this attempt's, or an earlier one carried in) must survive the failure: keep the claim with it
      const kept = readJsonOrNull(claim.file)?.signature ?? sentSig;
      if (kept) { if (readJsonOrNull(claim.file)?.signature !== kept) recordClaimSignature(claim.file, pid, bell, kept); } else releaseClaim(claim.file); // nothing was sent: the bell is free for the next pass or the other process
      if (!state.failed.has(bell)) state.failed.set(bell, e.message);
      log(`anchor ${bell}: ${e.message}`);
      if (newest - bell >= ANCHOR_RETRY_BELLS) {
        writeAtomic(file, `${JSON.stringify({ bell, ...roots, signature: null, slot: null, anchor_gap: true, reason: kept ? memoPendingReason(kept) : state.failed.get(bell) })}\n`);
        state.failed.delete(bell);
        done.gaps.push(bell);
      }
      break; // keep the memo order: later bells wait for this one
    }
  }
  return done;
}

/** Wait (bounded) until every bell that another LIVE process has claimed has its anchor file: `publish` writes the index only after that. */
export async function waitForClaimedAnchors({ aiDir, pid = process.pid, timeoutMs = 60_000, intervalMs = 250 }) {
  const dir = path.join(aiDir, 'keys', 'anchor-claims');
  const t0 = Date.now();
  for (;;) {
    const pending = numericJson(dir).filter(b => {
      const c = readJsonOrNull(anchorClaimFile(aiDir, b));
      return c && pidAlive(c.pid) && c.pid !== pid && !fs.existsSync(path.join(aiDir, 'pub', 'anchors', `${b}.json`));
    });
    if (!pending.length) return { waited_ms: Date.now() - t0, pending: [] };
    if (Date.now() - t0 > timeoutMs) return { waited_ms: Date.now() - t0, pending };
    await sleep(intervalMs);
  }
}

/** The bells that are closed: those with a talk file or a minds file (the closer writes the talk file first, the minds file right after). */
export function closedBells(pub) {
  return [...new Set([...numericJson(path.join(pub, 'talk')), ...numericJson(path.join(pub, 'minds'))])].sort((a, b) => a - b);
}

/**
 * FB1 (A2): wait (bounded) until every closed bell has BOTH its talk file and its minds file. The closer writes the talk file and then
 * the minds file of a bell in one tick, so this is the short window in which the last bell is half closed; the end of the run used to
 * publish inside it and left that bell with neither an anchor nor a gap. Returns `{waited_ms, incomplete: [bells]}` (empty = complete).
 */
export async function waitForClosedBellFiles({ aiDir, timeoutMs = 60_000, intervalMs = 100 }) {
  const pub = path.join(aiDir, 'pub');
  const t0 = Date.now();
  for (;;) {
    const incomplete = closedBells(pub).filter(b => !fs.existsSync(path.join(pub, 'talk', `${b}.json`)) || !fs.existsSync(path.join(pub, 'minds', `${b}.json`)));
    if (!incomplete.length || Date.now() - t0 >= timeoutMs) return { waited_ms: Date.now() - t0, incomplete };
    await sleep(Math.min(intervalMs, Math.max(1, timeoutMs - (Date.now() - t0))));
  }
}

/**
 * Is the local chain paused? `frontier_status` is the local test chain's own method (frontier-localnet); the stack pauses the chain
 * when the season is complete, and a paused chain produces no block: a memo sent to it is never confirmed. Any other answer (an error,
 * a chain without the method) counts as not paused, so the registrar behaves as before there.
 */
export async function chainPaused(rpc) {
  try { return (await rpc.call('frontier_status', []))?.paused === true; } catch { return false; }
}
export const PAUSED_REASON = 'the chain was paused (the season is complete): no block can confirm a memo';

/**
 * The season-end publication of the registrar: a signed index of the anchors and the trigger file the audit watches (STATE/season-end.json).
 * FB1 (A2): every CLOSED bell (talk or minds file) that has no anchor file gets an `anchor_gap` first (its reason names the memo signature
 * if one was sent and never confirmed, else `defaultReason`), so a closed bell is always either anchored or a named gap and the index
 * lists it. `skip` = bells a live process still holds (they are left alone: that process may still anchor them).
 */
export function publishSeasonEnd({ aiDir, kp, season, commitmentsSha, skip = [], defaultReason = 'no memo was confirmed before the season end' }) {
  const pub = path.join(aiDir, 'pub');
  for (const b of closedBells(pub)) {
    const file = path.join(pub, 'anchors', `${b}.json`);
    if (fs.existsSync(file) || skip.includes(b)) continue;
    const talkFile = path.join(pub, 'talk', `${b}.json`), mindsFile = path.join(pub, 'minds', `${b}.json`);
    const t = fs.existsSync(talkFile) ? readJsonOrNull(talkFile) : undefined, m = fs.existsSync(mindsFile) ? readJsonOrNull(mindsFile) : undefined;
    const sig = readJsonOrNull(anchorClaimFile(aiDir, b))?.signature ?? null;
    writeAtomic(file, `${JSON.stringify({ bell: b, social_root: t === undefined || t === null ? null : t.root ?? ZERO_ROOT, minds_root: m === undefined || m === null ? null : m.root ?? ZERO_ROOT, signature: null, slot: null, anchor_gap: true, reason: sig ? memoPendingReason(sig) : defaultReason })}\n`);
  }
  const bells = numericJson(path.join(pub, 'anchors'));
  const anchored = [], gaps = [];
  for (const b of bells) (readJson(path.join(pub, 'anchors', `${b}.json`)).anchor_gap ? gaps : anchored).push(b);
  const commitFile = path.join(pub, 'anchors', 'commit.json');
  const index = signObject({ v: 1, season: Number(season), registrar: kp.publicKey.toBase58(), commitments_sha256: commitmentsSha ?? null, commit: fs.existsSync(commitFile) ? readJson(commitFile) : null, first_bell: bells[0] ?? null, last_bell: bells.at(-1) ?? null, anchored, gaps }, kp);
  writeAtomic(path.join(pub, 'anchors', 'index.json'), `${JSON.stringify(index)}\n`);
  writeAtomic(path.join(aiDir, 'state', 'season-end.json'), `${JSON.stringify({ v: 1, season: Number(season), last_bell: bells.at(-1) ?? null, requested_unix: Math.floor(Date.now() / 1000) })}\n`);
  return index;
}

// ------------------------------------------------------------------ RUNS.md (§7.1 Run ledger)
export const RUNS_FILE = 'docs/frontier/ai-citizens/RUNS.md';
export const RUNS_HEADER = `# Wylls AI runs

Append-only. One block per invocation of \`citizens/bin/ai-citizens-run.sh\`, written before genesis; aborted and failed runs are listed too.
Each block has a heading and a \`RUN\` line (JSON: \`run_id\`, \`start_unix\`, \`commitments_sha256\`, \`configs\`, \`arm\`, \`rep\`). When a run ends, an \`END\` line (JSON:
\`run_id\`, \`end_unix\`, \`status\`, \`detail\`) is appended at the end of the file; a run with no \`END\` line was aborted or is still running. \`report.mjs\`
and the A/B table read these two line kinds and nothing else. Every run is local test chain only.
`;
export function formatRunBlock({ run_id, start_unix, commitments_sha256, configs, arm = null, rep = null }) {
  const iso = new Date(start_unix * 1000).toISOString().replace('.000Z', 'Z');
  const line = canonicalJson({ run_id, start_unix, commitments_sha256, configs, arm, rep });
  return `\n## ${run_id} — ${iso}${arm ? ` — arm ${arm} rep ${rep}` : ''}\nRUN ${line}\n`;
}
export const formatRunEnd = ({ run_id, end_unix, status, detail = '' }) => `END ${canonicalJson({ run_id, end_unix, status, detail })}\n`;
export function appendRunLine(file, text, { header = RUNS_HEADER } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, header);
  else if (!fs.readFileSync(file, 'utf8').endsWith('\n')) fs.appendFileSync(file, '\n');
  fs.appendFileSync(file, text);
}
/** `[{run_id, start_unix, ..., end: {end_unix, status, detail}|null}]` in file order. */
export function parseRunsMd(text) {
  const runs = new Map();
  for (const line of text.split('\n')) {
    if (line.startsWith('RUN ')) { const r = JSON.parse(line.slice(4)); runs.set(r.run_id, { ...r, end: null }); }
    else if (line.startsWith('END ')) { const e = JSON.parse(line.slice(4)); const r = runs.get(e.run_id); if (r) r.end = { end_unix: e.end_unix, status: e.status, detail: e.detail }; }
  }
  return [...runs.values()];
}

// ------------------------------------------------------------------ command line
const BOOLEAN = new Set(['prepare-only', 'allow-dirty', 'reuse', 'help']);
export function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) { a._.push(k); continue; }
    const name = k.slice(2);
    if (BOOLEAN.has(name)) a[name] = true;
    else { if (i + 1 >= argv.length) throw new Error(`${k} needs a value`); a[name] = argv[++i]; }
  }
  return a;
}
const need = (a, ...names) => { for (const n of names) if (a[n] === undefined) throw new Error(`--${n} is required`); };
const rel = p => path.resolve(p);

async function importDeps() {
  const cit = path.join(REPO_ROOT, 'permutation-gateway', 'citizens');
  const need1 = f => { if (!fs.existsSync(path.join(cit, f))) throw new Error(`citizens/${f} is missing (unit AC2 is not merged here); the deal needs it`); return pathToFileURL(path.join(cit, f)).href; };
  const dealMod = await import(need1('persona/deal.mjs'));
  const library = readJson(path.join(cit, 'persona', 'library.json'));
  const faddr = await import(pathToFileURL(path.join(REPO_ROOT, 'permutation-server', 'web', 'frontier', 'faddr.mjs')).href);
  const ident = await import(pathToFileURL(path.join(REPO_ROOT, 'permutation-server', 'web', 'frontier', 'people', 'identity.mjs')).href);
  const personas = Array.isArray(library) ? Object.fromEntries(library.map(p => [p.id, p])) : (library.personas ? Object.fromEntries((Array.isArray(library.personas) ? library.personas : Object.values(library.personas)).map(p => [p.id, p])) : library);
  return {
    deal: dealMod.deal,
    library: personas,
    tagOf: (programId, seasonId, wallet) => ident.tagKey(faddr.citizenTag(faddr.seasonAddresses(programId, seasonId).of('Citizen', { wallet }))),
    nameOf: tag => ({ en: ident.displayName(ident.identityOf(tag), { full: true, language: 'en' }), ja: ident.displayName(ident.identityOf(tag), { full: true, language: 'ja' }) }),
  };
}

/** The bounds of a memo send and of the poll of an earlier signature, from the CLI (tests shorten them; the defaults are the production ones). */
function memoOptions(a) {
  const o = {};
  if (a['memo-tries'] !== undefined) { o.memoTries = Number(a['memo-tries']); o.pollTries = Number(a['memo-tries']); }
  if (a['memo-interval-ms'] !== undefined) { o.memoIntervalMs = Number(a['memo-interval-ms']); o.pollIntervalMs = Number(a['memo-interval-ms']); }
  return o;
}

export async function main(argv, { log = m => console.error(m), out = m => console.log(m) } = {}) {
  const a = parseArgs(argv);
  const cmd = a._[0];
  if (!cmd || a.help) { out(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 22).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); return cmd ? 0 : 2; }
  switch (cmd) {
    case 'slots': {
      need(a, 'stack', 'n', 'out');
      const stack = parseStackToml(fs.readFileSync(a.stack, 'utf8'));
      writeAtomic(a.out, `${JSON.stringify(makeSlots({ seed: stack.bot_seed, n: Number(a.n) }), null, 2)}\n`);
      out(`slots: ${a.out} (${a.n} AI + seat, seed ${stack.bot_seed})`);
      return 0;
    }
    case 'commit': {
      need(a, 'ai-dir', 'key', 'stack', 'citizens-config', 'slots', 'deck');
      const aiDir = rel(a['ai-dir']);
      const stack = parseStackToml(fs.readFileSync(a.stack, 'utf8'));
      const pubFile = path.join(aiDir, 'pub', 'commitments.json');
      let prepared;
      if (a.reuse && fs.existsSync(pubFile)) {
        const bytes = fs.readFileSync(pubFile);
        prepared = { bytes, sha256: sha256hex(bytes), obj: JSON.parse(bytes), kp: loadOrCreateKey(a.key, aiDir) };
      } else {
        // R9: a non-smoke run (a citizens config not named smoke.json) must measure the model file and the llama.cpp tree; a smoke run
        // may leave both out and its commitments then say "unmeasured" (collectInputs)
        if (!isSmokeConfig(a['citizens-config']) && !(a.model && a['llama-dir'])) throw new Error(`a non-smoke run (config ${path.basename(a['citizens-config'])}) needs --model (AI_MODEL) and --llama-dir (AI_LLAMA_DIR): the commitments carry their measured hashes (contract 7.1, R9)`);
        const model = a['model-sha256'] || a.model
          ? { ...PINNED_MODEL, sha256: a['model-sha256'] ?? (await modelSha(a.model)), file: a.model ? path.basename(a.model) : UNMEASURED }
          : undefined;
        const extra = a.inputs ? readJson(a.inputs) : {};
        prepared = prepareCommitments({ repoRoot: REPO_ROOT, aiDir, keyPath: a.key, stackPath: a.stack, citizensConfigPath: a['citizens-config'], slotsPath: a.slots, deck: a.deck, runId: a['run-id'], model, llama: { dir: a['llama-dir'], ...(extra.llama ?? {}) }, seatScriptPath: a['seat-script'], allowDirty: a['allow-dirty'], override: extra.override });
      }
      out(`commitments: ${path.join(aiDir, 'pub', 'commitments.json')} sha256 ${prepared.sha256}`);
      if (a['prepare-only'] || !a['wait-rpc']) return 0;
      const g0 = stack.g0 ?? 1_785_542_400;
      const r = await anchorCommit({ aiDir, kp: prepared.kp, rpc: new Rpc(a['wait-rpc']), g0, sha: prepared.sha256, season: prepared.obj.season_id, herald: a.herald, log });
      out(`commit anchor: ${r.status}`);
      return 0;
    }
    case 'deal': {
      need(a, 'ai-dir', 'key', 'herald', 'stack');
      const aiDir = rel(a['ai-dir']);
      const kp = loadOrCreateKey(a.key, aiDir);
      const season = await assertHeraldLocalnet(a.herald);
      const genesis = await readGenesisSeed(a.herald);
      const bytes = fs.readFileSync(path.join(aiDir, 'pub', 'commitments.json'));
      const commitments = JSON.parse(bytes);
      if (!verifySigned(commitments, kp.publicKey.toBase58())) throw new Error('commitments.json is not signed by this registrar key');
      const stack = parseStackToml(fs.readFileSync(a.stack, 'utf8'));
      if (sha256File(a.stack) !== commitments.configs.stack_toml_sha256) throw new Error('--stack is not the stack config the commitments name (stack_toml_sha256)');
      const deps = await importDeps();
      const deckFile = readJson(path.join(REPO_ROOT, 'permutation-gateway', 'citizens', 'persona', 'decks', `${commitments.personas.deck}.json`));
      const roster = buildRoster({ commitments, commitmentsSha: sha256hex(bytes), season, genesis, deps: { ...deps, deck: Array.isArray(deckFile) ? deckFile : deckFile.personas ?? deckFile.deck, botSeed: stack.bot_seed, scriptCount: stack.bots }, kp });
      writeAtomic(path.join(aiDir, 'pub', 'roster.json'), `${JSON.stringify(roster)}\n`);
      out(`roster: ${roster.ai.length} AI citizens, seat ${roster.seat?.index}, ${roster.script.count} script bots`);
      return 0;
    }
    case 'run': {
      need(a, 'ai-dir', 'key', 'rpc');
      const aiDir = rel(a['ai-dir']);
      const kp = loadOrCreateKey(a.key, aiDir);
      const rpc = new Rpc(a.rpc);
      const commitments = readJson(path.join(aiDir, 'pub', 'commitments.json'));
      await waitHealthy(rpc);
      if (a.stack) await assertLocalnetRpc(rpc, parseStackToml(fs.readFileSync(a.stack, 'utf8')).g0 ?? 1_785_542_400);
      await ensureFunded(rpc, kp);
      const state = { failed: new Map() };
      let stop = false;
      for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { stop = true; });
      const until = a['until-bell'] === undefined ? Infinity : Number(a['until-bell']);
      const memoOpts = memoOptions(a);
      for (;;) {
        // FB1 (A2): a paused chain (the stack pauses it when the season is complete) confirms nothing: send nothing to it; once the
        // season-end index exists a bell that closes now is written as a gap at once (publish wrote the index before it closed)
        const blocked = (await chainPaused(rpc)) ? PAUSED_REASON : null;
        const sealed = fs.existsSync(path.join(aiDir, 'pub', 'anchors', 'index.json'));
        const r = await anchorPass({ aiDir, kp, rpc, season: commitments.season_id, state, log, sendBlocked: blocked, gapWhenBlocked: Boolean(blocked) && sealed, ...memoOpts });
        if (r.anchored.length || r.gaps.length) log(`anchors: ${r.anchored.length} sent${r.gaps.length ? `, ${r.gaps.length} gap(s)` : ''}`);
        const newest = numericJson(path.join(aiDir, 'pub', 'anchors')).at(-1) ?? -1;
        if (stop || newest >= until) break;
        await sleep(Number(a['poll-ms'] ?? 2000));
      }
      return 0;
    }
    case 'publish': {
      need(a, 'ai-dir', 'key', 'herald', 'rpc');
      const aiDir = rel(a['ai-dir']);
      const kp = loadOrCreateKey(a.key, aiDir);
      await assertHeraldLocalnet(a.herald);
      const bytes = fs.readFileSync(path.join(aiDir, 'pub', 'commitments.json'));
      const commitments = JSON.parse(bytes);
      const rpc = new Rpc(a.rpc);
      if (a.stack) await assertLocalnetRpc(rpc, parseStackToml(fs.readFileSync(a.stack, 'utf8')).g0 ?? 1_785_542_400);
      // FB1 (A2): the closer may be inside the tick that closes the last bell (talk file written, minds file not yet): wait (bounded) for
      // both files, then one more anchor pass (nothing is sent to a paused chain), then the index; every closed bell without an anchor
      // becomes a named anchor_gap in publishSeasonEnd, so the index and the closed bells agree
      const wl = await waitForClosedBellFiles({ aiDir, timeoutMs: Number(a['wait-last-secs'] ?? 0) * 1000 });
      if (wl.incomplete.length) log(`publish: bells ${wl.incomplete.join(', ')} still have only one of talk and minds after ${wl.waited_ms} ms`);
      const paused = await chainPaused(rpc);
      await anchorPass({ aiDir, kp, rpc, season: commitments.season_id, log, sendBlocked: paused ? PAUSED_REASON : null, ...memoOptions(a) });
      // R9: the `run` process may be sending the last bells at this very moment (its claim is live): wait for its anchors, then index
      const w = await waitForClaimedAnchors({ aiDir });
      if (w.pending.length) log(`publish: bells ${w.pending.join(', ')} are still claimed by a live registrar run after ${w.waited_ms} ms; they are not in the index`);
      const index = publishSeasonEnd({ aiDir, kp, season: commitments.season_id, commitmentsSha: sha256hex(bytes), skip: w.pending, defaultReason: paused ? PAUSED_REASON : undefined });
      const closed = closedBells(path.join(aiDir, 'pub')).length;
      out(`anchors: ${index.anchored.length} anchored, ${index.gaps.length} gap(s) of ${closed} closed bells; season-end trigger written`);
      return 0;
    }
    case 'runs-add': {
      need(a, 'run-id', 'commitments', 'file');
      const bytes = fs.readFileSync(a.commitments);
      const c = JSON.parse(bytes);
      appendRunLine(a.file, formatRunBlock({ run_id: a['run-id'], start_unix: Math.floor(Date.now() / 1000), commitments_sha256: sha256hex(bytes), configs: c.configs, arm: a.arm ?? null, rep: a.rep === undefined ? null : Number(a.rep) }));
      out(`RUNS.md: ${a['run-id']} added`);
      return 0;
    }
    case 'runs-end': {
      need(a, 'run-id', 'status', 'file');
      appendRunLine(a.file, formatRunEnd({ run_id: a['run-id'], end_unix: Math.floor(Date.now() / 1000), status: a.status, detail: a.detail ?? '' }));
      return 0;
    }
    default:
      throw new Error(`unknown command ${cmd}`);
  }
}

/** The model file's sha256, streamed once and cached by (path, size, mtime) so a run does not hash 14 GB twice. */
async function modelSha(file) {
  const st = fs.statSync(file);
  const cacheFile = path.join(os.tmpdir(), 'wylls-ai-model-sha.json');
  const key = `${path.resolve(file)}|${st.size}|${Math.floor(st.mtimeMs)}`;
  let cache = {};
  try { cache = readJson(cacheFile); } catch { /* none yet */ }
  if (cache[key]) return cache[key];
  const h = crypto.createHash('sha256');
  await new Promise((resolve, reject) => fs.createReadStream(file).on('data', c => h.update(c)).on('end', resolve).on('error', reject));
  cache[key] = h.digest('hex');
  writeAtomic(cacheFile, JSON.stringify(cache));
  return cache[key];
}

if (isMain()) {
  // exitCode, not exit(): a pipe's output is flushed before the process ends.
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => { console.error(`registrar: ${e.message}`); process.exitCode = 2; });
}
