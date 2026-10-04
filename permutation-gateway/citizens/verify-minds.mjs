// verify-minds (contract 7.3, 10.2 G8, G13, G15; unit AC8): the public audit of an AI run, from what is published and from the
// local chain alone. Loopback only.
//
//   node permutation-gateway/citizens/verify-minds.mjs --herald URL --ai-dir PUB --rpc URL [--llm URL] [--sample 20]
//        [--repo ROOT] [--model GGUF] [--llama-dir DIR] [--stack TOML] [--citizens-config JSON] [--slots JSON]
//        [--seat-script FILE] [--bot-seed N] [--only M1,M3,...] [--through BELL] [--out FILE | --no-write] [--quiet]
//
//   --ai-dir      PUB (or AI_DIR, which holds pub/); the check reads files only, never STATE.
//   M1  commitments       signature, commit memo (hash, signer, block time before genesis), measured model and llama tree,
//                         config and code hashes against the committed git tree (`code.git_commit`), personas, slots, rules
//   M2  roster            the deal recomputed from the GENESIS_SEED record, script-bot wallets, labels, signature
//   M3  roots, openings   every closed bell's roots against the files and the anchor memo; ballots against their leaves; call
//                         commits; every sealed record's commit opened when due (7.2: the later of release_bell and the real
//                         arrival bell, release_bell + 6 if unrevealed; no later than 2 bells after)
//   M7  coverage          every session-signed chain transaction of each AI in exactly one record's tx; every listed signature on chain
//   M8  speech            every social record of an AI wallet = its decision's signed-ready output, origin 1, no use twice
//   M9  bit replay        20 stored request bodies re-sent to llama (--llm); n/20 equal
//   M11 episodes          replay of the episodes of 3 sampled AIs over the public log, 20 decisions' retrieval (audit/episodes.mjs)
//
// Output PUB/verify-minds.json {v, run_id, checks:{M1:{pass, n, failures:[...]}, ...}, verdict}. A check is true, false or null (null =
// not fully verified: an `unmeasured` field of the commitments, a missing input, no llama-server). verdict: FAIL if any check is false,
// INCOMPLETE if none is false and some is null, else PASS. Exit code: 0 PASS, 1 FAIL, 3 INCOMPLETE, 2 usage.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import bs58 from 'bs58';
import {
  LABELS, MEMO_PROGRAM_ID, PINNED_LLAMA_FLAGS, Rpc, anchorMemoText, canonicalJson, commitMemoText, fileBytes, localnetGenesisHash, makeSlots, parseStackToml,
  rulesFromConfig, treeSha256Dir, verifyBytes, verifySigned, walletOf,
} from './registrar.mjs';
import { createHerald } from '../../permutation-server/web/frontier/herald.mjs';
import * as faddr from '../../permutation-server/web/frontier/faddr.mjs';
import * as ident from '../../permutation-server/web/frontier/people/identity.mjs';
import { decode as decodeSocial, fromBase64, view as viewSocial } from '../../permutation-server/web/frontier/council/aisocial.mjs';
import { deal as dealPersonas } from './persona/deal.mjs';
import { assertLoopback, callCommitOf, createCheck, innerHex, openPub, recordIdOf, recordLeaf, resolvePubDir, sampleFrom, sealedCommit, sha256Canonical, sha256hex, socialLeaf, verdictOf, writeAtomic, ZERO_ROOT, merkleRootHex } from './audit/canon.mjs';
import { checkM11, drainFeed } from './audit/episodes.mjs';
import { checkM9 } from './audit/replay.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');
/** The release job waits at most 6 bells for a REVEAL (7.2); M3 allows the opening 2 bells after it was due. */
export const OPEN_GRACE_BELLS = 2;
export const UNREVEALED_WAIT_BELLS = 6;
const EMPTY = sha256hex('');

// ------------------------------------------------------------------ the herald and the chain, as the checks read them
/** `{get(path) -> {status, json, text, bytes}, fetch(url) -> Response-like, base}` over a loopback URL or a `{get}` double. */
export function makeHerald(h, fetchImpl = globalThis.fetch) {
  if (h && typeof h.get === 'function') {
    const g = h.get.bind(h);
    const shim = async url => { const p = String(url).replace(/^https?:\/\/[^/]+/, ''); const r = await g(p); return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json, text: async () => r.text ?? JSON.stringify(r.json), arrayBuffer: async () => (r.bytes ?? Buffer.from(r.text ?? '')).buffer }; };
    return { base: h.base ?? 'http://127.0.0.1:0', get: g, fetch: shim, raw: h };
  }
  const base = assertLoopback(String(h), 'herald');
  const get = async p => {
    const r = await fetchImpl(base + p, { signal: AbortSignal.timeout(20_000) });
    const bytes = Buffer.from(await r.arrayBuffer());
    const text = bytes.toString('utf8');
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, json, text, bytes };
  };
  return { base, get, fetch: fetchImpl, raw: base };
}
export function makeRpc(r) {
  if (r && typeof r.call === 'function') return r;
  return new Rpc(String(r));
}

const git = (repo, args, opts = {}) => execFileSync('git', ['-C', repo, ...args], { encoding: opts.buffer ? 'buffer' : 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28 });
const gitOk = (repo, args) => { try { return git(repo, args).trim(); } catch { return null; } };

/** Reads of the committed tree: the audit compares the commitments with `code.git_commit`, not with whatever is checked out. */
export function committedTree(repo, commit) {
  const tree = p => gitOk(repo, ['rev-parse', `${commit}:${p}`]);
  const blob = p => { try { return git(repo, ['show', `${commit}:${p}`], { buffer: true }); } catch { return null; } };
  const ls = p => { const o = gitOk(repo, ['ls-tree', '--name-only', `${commit}:${p}`]); return o ? o.split('\n').filter(Boolean) : []; };
  return {
    exists: () => gitOk(repo, ['cat-file', '-t', commit]) === 'commit',
    tree, blob, ls,
    blobSha: p => { const b = blob(p); return b ? sha256hex(b) : null; },
    combined: paths => sha256hex(paths.map(p => `${p}\0${tree(p)}\n`).sort().join('')),
    promptTemplates: dir => { const names = ls(dir).filter(n => n.endsWith('.txt')).sort(); return names.length ? sha256hex(names.map(n => `${n}\0${sha256hex(blob(`${dir}/${n}`))}\n`).join('')) : null; },
    episodeKinds: () => { const b = blob('permutation-gateway/citizens/memory/templates.en.json'); if (!b) return null; const k = JSON.parse(b.toString('utf8')).kinds; return k && typeof k === 'object' ? sha256hex(canonicalJson(Object.keys(k).sort())) : null; },
  };
}

/** The memo text of a `getTransaction(..., json)` result and its first signer. */
export function memoOf(tx) {
  const m = tx?.transaction?.message;
  if (!m) return null;
  for (const ins of m.instructions ?? []) {
    if (m.accountKeys[ins.programIdIndex] !== MEMO_PROGRAM_ID) continue;
    try { return { text: Buffer.from(bs58.decode(ins.data)).toString('utf8'), signer: m.accountKeys[0], slot: tx.slot, blockTime: tx.blockTime }; } catch { return null; }
  }
  return null;
}
/** The game instruction tag of a transaction: the first data byte of the instruction addressed to the program. */
export function gameTagOf(tx, programId) {
  const m = tx?.transaction?.message;
  if (!m) return null;
  for (const ins of m.instructions ?? []) if (m.accountKeys[ins.programIdIndex] === programId) { try { return Buffer.from(bs58.decode(ins.data))[0]; } catch { return null; } }
  return null;
}
/** Join 0x30, SetSession 0x31, SetVigil 0x32, FileTicket 0x33 (frontier-abi tags.rs): the onboarding of a citizen. */
export const ONBOARDING_TAGS = new Set([0x30, 0x31, 0x32, 0x33]);
export function isOnboardingBeforeFirstRecord(tx, programId, blockTime, firstBell, season) {
  if (!ONBOARDING_TAGS.has(gameTagOf(tx, programId))) return false;
  if (firstBell === undefined) return true;
  const start = Number(season?.genesisTs) + firstBell * Number(season?.bellSecs ?? 600);
  return Number.isFinite(start) && Number(blockTime) < start;
}
const signersOf = tx => { const m = tx?.transaction?.message; return m ? m.accountKeys.slice(0, m.header.numRequiredSignatures) : []; };

const modelShaCache = new Map();
async function fileSha256(file) {
  const st = fs.statSync(file);
  const key = `${path.resolve(file)}|${st.size}|${Math.floor(st.mtimeMs)}`;
  if (modelShaCache.has(key)) return modelShaCache.get(key);
  // the registrar's own cache (os.tmpdir()/wylls-ai-model-sha.json, keyed the same way) saves hashing a 14 GB file twice
  try { const c = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'wylls-ai-model-sha.json'), 'utf8')); if (c[key]) { modelShaCache.set(key, c[key]); return c[key]; } } catch { /* none */ }
  const h = crypto.createHash('sha256');
  await new Promise((resolve, reject) => fs.createReadStream(file).on('data', c => h.update(c)).on('end', resolve).on('error', reject));
  const v = h.digest('hex');
  modelShaCache.set(key, v);
  return v;
}

// ------------------------------------------------------------------ the verification context
export async function createContext(o) {
  const { pub: pubDir } = resolvePubDir(o.aiDir);
  const pub = openPub(pubDir);
  const herald = makeHerald(o.herald, o.fetchImpl);
  const rpc = makeRpc(o.rpc);
  const ctx = {
    pub, pubDir, herald, rpc, o,
    repo: o.repoRoot ?? REPO_ROOT,
    commitments: pub.commitments(),
    roster: pub.roster(),
    seedHex: pub.lastMindsRoot(),
    _season: null,
    async season() { return (ctx._season ??= (await herald.get('/h/season')).json); },
    _txCache: new Map(),
    async tx(sig) {
      if (!ctx._txCache.has(sig)) ctx._txCache.set(sig, await rpc.call('getTransaction', [sig, { encoding: 'json' }]));
      return ctx._txCache.get(sig);
    },
    _meCache: new Map(),
    /** the Citizen of a wallet through the herald client (decoded; `session` is its current session key) */
    async me(wallet) {
      if (!ctx._meCache.has(wallet)) {
        const s = await ctx.season();
        const hc = createHerald({ base: herald.base, fetch: herald.fetch, seasonId: s?.season !== undefined ? String(s.season) : null });
        ctx._meCache.set(wallet, await hc.me(wallet));
      }
      return ctx._meCache.get(wallet);
    },
    tagOfWallet(wallet) {
      const s = ctx._season;
      if (!s?.programId) throw new Error('season not read yet');
      return ident.tagKey(faddr.citizenTag(faddr.seasonAddresses(s.programId, s.season).of('Citizen', { wallet })));
    },
    decisions: null,
    _drained: null,
    /** one feed over the herald's whole log, shared by M3 (REVEALs) and M11 */
    drained() { return (ctx._drained ??= drainFeed({ herald: o.herald, roster: ctx.roster ?? { ai: [] }, fetchImpl: o.fetchImpl })); },
  };
  return ctx;
}

/** Every decision record (the minds files and the late files) with its opening (unsealed: the record itself; sealed: PUB/open or PUB/full/open) and its full-bundle entry. */
export function collectDecisions(pub) {
  const openIdx = new Map();
  for (const [bell, f] of pub.open()) for (const op of f?.records ?? f?.opened ?? []) if (op?.id) openIdx.set(op.id, { opening: op, bell, source: 'release' });
  const recs = [];
  for (const [bell, f] of pub.minds()) for (const r of f?.records ?? []) recs.push({ record: r, fileBell: bell, late: false });
  for (const [bell, f] of pub.late()) for (const e of f?.entries ?? []) if (e.record) recs.push({ record: e.record, fileBell: bell, late: true });
  return recs.map(({ record, fileBell, late }) => {
    const full = pub.fullDecision(record.id);
    let opened = null, source = null, openBell = null;
    if (!record.sealed) { opened = { ...record, candidates: full?.candidates ?? null }; source = 'public'; }
    else if (openIdx.has(record.id)) { ({ opening: opened, source, bell: openBell } = openIdx.get(record.id)); }
    else { const fo = pub.fullOpen(record.id); if (fo) { opened = fo; source = 'season_end'; } }
    return { record, fileBell, late, full, opened, source, openBell };
  });
}

// ------------------------------------------------------------------ M1
export async function checkM1(ctx) {
  const c = createCheck('M1', 'commitments');
  const cm = ctx.commitments;
  const bytes = ctx.pub.commitmentsBytes();
  if (!cm || !bytes) { c.fail('commitments_missing'); return c.result(); }
  const sha = sha256hex(bytes);
  // the file is the canonical JSON of the signed object (7.1)
  c.count();
  if (!Buffer.from(fileBytes(cm)).equals(bytes)) c.fail('file_not_canonical', { detail: 'commitments.json is not the canonical JSON of its own content' });
  c.count();
  if (!verifySigned(cm, cm.registrar)) c.fail('registrar_signature', { detail: 'the signature does not verify under the registrar key named in the file', registrar: cm.registrar });

  // ---- the commit memo
  const ca = ctx.pub.commitAnchor();
  c.count();
  if (!ca) c.fail('commit_anchor_missing', { detail: 'PUB/anchors/commit.json is missing' });
  else {
    if (ca.commitments_sha256 !== sha) c.fail('commit_anchor_hash', { anchor: ca.commitments_sha256, file: sha });
    let tx = null;
    try { tx = await ctx.tx(ca.signature); } catch (e) { c.fail('commit_memo_unreadable', { detail: e.message }); }
    c.count();
    if (!tx) c.fail('commit_memo_not_on_chain', { signature: ca.signature });
    else {
      const m = memoOf(tx);
      if (!m) c.fail('commit_memo_missing', { signature: ca.signature });
      else {
        if (m.text !== commitMemoText(cm.season_id, sha)) c.fail('commit_memo_text', { memo: m.text, want: commitMemoText(cm.season_id, sha) });
        if (m.signer !== cm.registrar) c.fail('commit_memo_signer', { signer: m.signer, registrar: cm.registrar });
        const s = await ctx.season();
        const genesis = Number(s?.genesisTs);
        c.count();
        if (!Number.isFinite(genesis)) c.fail('genesis_ts_unreadable');
        else if (!(m.blockTime < genesis)) c.fail('commit_after_genesis', { block_time: m.blockTime, genesis_ts: genesis, detail: 'the commit memo is not before genesis: the run is unaudited' });
        if (ca.status !== (m.blockTime < genesis ? 'audited' : 'unaudited')) c.fail('commit_anchor_status', { status: ca.status });
      }
    }
  }

  // ---- model and server (7.1 "Measured or unmeasured")
  const unm = v => v === null || v === undefined || v === 'unmeasured';
  c.count();
  if (cm.model?.sha256 === 'unmeasured') c.unmeasured('model.sha256', 'the run recorded "unmeasured" (smoke run)');
  else if (ctx.o.modelPath) {
    const got = await fileSha256(ctx.o.modelPath);
    if (got !== cm.model.sha256) c.fail('model_sha256', { committed: cm.model.sha256, file: got, path: ctx.o.modelPath });
  } else c.note('model.sha256 not compared: --model not given (it is a committed value; if the run did not measure it, this audit cannot tell)');
  c.count();
  if (unm(cm.server?.tree_sha256)) c.unmeasured('server.tree_sha256', cm.server?.tree_sha256 === null ? 'null in the commitments' : 'the run recorded "unmeasured"');
  else if (ctx.o.llamaDir) {
    const got = treeSha256Dir(ctx.o.llamaDir);
    if (got !== cm.server.tree_sha256) c.fail('server_tree_sha256', { committed: cm.server.tree_sha256, dir: got });
  } else c.unverified('server.tree_sha256', '--llama-dir not given');
  c.count();
  if (cm.server?.flags_sha256 !== sha256hex(canonicalJson(cm.server?.flags ?? []))) c.fail('flags_sha256', { detail: 'flags_sha256 is not the hash of the committed flags' });

  // ---- code trees and files of the committed commit
  const T = committedTree(ctx.repo, cm.code?.git_commit ?? '');
  c.count();
  if (!cm.code?.git_commit || !T.exists()) c.fail('git_commit_unknown', { commit: cm.code?.git_commit, repo: ctx.repo });
  else {
    const eq = (field, want, got) => { c.count(); if (want !== got) c.fail('code_hash', { field, committed: want ?? null, recomputed: got ?? null }); };
    eq('mind_tree', cm.code.mind_tree, T.tree('permutation-gateway/citizens'));
    eq('memory_tree', cm.code.memory_tree, T.tree('permutation-gateway/citizens/memory'));
    eq('page_tree', cm.code.page_tree ?? null, T.tree('permutation-server/web/frontier/council') ?? null);
    eq('candidate_generator_tree', cm.code.candidate_generator_tree, T.combined(['frontier-node/crates/bots/src', 'frontier-node/crates/agents/src']));
    eq('episodes_module_sha256', cm.code.episodes_module_sha256, T.blobSha('permutation-gateway/citizens/memory/episodes.mjs'));
    eq('episode_kinds_sha256', cm.code.episode_kinds_sha256, T.episodeKinds());
    eq('serve_sha256', cm.code.serve_sha256, T.blobSha('permutation-gateway/citizens/serve.mjs'));
    eq('prompt_templates_sha256', cm.code.prompt_templates_sha256, T.promptTemplates('permutation-gateway/citizens/prompts'));
    eq('personas.library_sha256', cm.personas.library_sha256, T.blobSha('permutation-gateway/citizens/persona/library.json'));
    eq('personas.deck_sha256', cm.personas.deck_sha256, T.blobSha(`permutation-gateway/citizens/persona/decks/${cm.personas.deck}.json`));
  }

  // ---- configs: the files given, else AI_DIR's copies, else the committed ones
  const aiDir = resolvePubDir(ctx.o.aiDir).aiDir;
  const stackPath = ctx.o.stackPath ?? (aiDir && fs.existsSync(path.join(aiDir, 'stack.toml')) ? path.join(aiDir, 'stack.toml') : null);
  let stack = null;
  c.count();
  if (stackPath) {
    const got = sha256hex(fs.readFileSync(stackPath));
    if (got !== cm.configs?.stack_toml_sha256) c.fail('config_hash', { field: 'stack_toml_sha256', committed: cm.configs?.stack_toml_sha256, file: got, path: stackPath });
    else stack = parseStackToml(fs.readFileSync(stackPath, 'utf8'));
  } else c.unverified('configs.stack_toml_sha256', 'no --stack and no AI_DIR/stack.toml');
  c.count();
  let cfgJson = null;
  if (ctx.o.citizensConfig) {
    const b = fs.readFileSync(ctx.o.citizensConfig);
    if (sha256hex(b) !== cm.configs?.citizens_config_sha256) c.fail('config_hash', { field: 'citizens_config_sha256', committed: cm.configs?.citizens_config_sha256, file: sha256hex(b) });
    else cfgJson = JSON.parse(b.toString('utf8'));
  } else if (T.exists()) {
    const hit = T.ls('permutation-gateway/citizens/config').filter(n => n.endsWith('.json')).find(n => T.blobSha(`permutation-gateway/citizens/config/${n}`) === cm.configs?.citizens_config_sha256);
    if (hit) { cfgJson = JSON.parse(T.blob(`permutation-gateway/citizens/config/${hit}`).toString('utf8')); c.note(`citizens config = ${hit} of the committed tree`); }
    else c.fail('config_hash', { field: 'citizens_config_sha256', committed: cm.configs?.citizens_config_sha256, detail: 'no file under citizens/config of the committed tree has this hash (and no --citizens-config given)' });
  } else c.unverified('configs.citizens_config_sha256', 'no --citizens-config and no committed tree');
  c.count();
  if (cfgJson) {
    try { if (canonicalJson(rulesFromConfig(cfgJson)) !== canonicalJson(cm.rules)) c.fail('rules_mismatch', { detail: 'the committed rules block is not the one the committed config gives' }); } catch (e) { c.fail('rules_mismatch', { detail: e.message }); }
  }
  // slots
  const botSeed = ctx.o.botSeed ?? stack?.bot_seed ?? null;
  c.count();
  const slotsPath = ctx.o.slotsPath ?? (aiDir && fs.existsSync(path.join(aiDir, 'ai-slots.json')) ? path.join(aiDir, 'ai-slots.json') : null);
  if (slotsPath) {
    const got = sha256hex(fs.readFileSync(slotsPath));
    if (got !== cm.configs?.slots_sha256) c.fail('config_hash', { field: 'slots_sha256', committed: cm.configs?.slots_sha256, file: got });
  } else if (botSeed !== null) {
    const n = cm.slots.filter(s => s.kind === 'ai').length;
    try {
      const derived = sha256hex(`${JSON.stringify(makeSlots({ seed: botSeed, n }), null, 2)}\n`);
      if (derived !== cm.configs?.slots_sha256) c.fail('config_hash', { field: 'slots_sha256', committed: cm.configs?.slots_sha256, derived, detail: 'derived from bot_seed and the AI count (no slots file given)' });
    } catch (e) { c.fail('slots_underivable', { detail: e.message }); }
  } else c.unverified('configs.slots_sha256', 'no slots file and no bot seed');
  c.count();
  if (sha256hex(canonicalJson(cm.slots)) !== cm.slots_root) c.fail('slots_root', { detail: 'slots_root is not the hash of the committed slots' });
  if (botSeed !== null) {
    for (const s of cm.slots) { c.count(); if (walletOf(botSeed, s.index).b58 !== s.wallet) c.fail('slot_wallet', { index: s.index, committed: s.wallet, derived: walletOf(botSeed, s.index).b58 }); }
  } else c.unverified('slots[].wallet', 'no bot seed (stack toml or --bot-seed)');
  // seat script and injection corpus (null when the run had none)
  for (const [field, files, given] of [['seat_script_sha256', ['permutation-gateway/citizens/scenario/seat-script.mjs'], ctx.o.seatScript], ['injection_corpus_sha256', ['permutation-gateway/citizens/injection/corpus.json', 'permutation-gateway/citizens/injection/corpus.mjs'], null]]) {
    c.count();
    const want = cm.configs?.[field] ?? null;
    if (given) { const got = sha256hex(fs.readFileSync(given)); if (got !== want) c.fail('config_hash', { field, committed: want, file: got }); continue; }
    const have = T.exists() ? files.map(f => T.blobSha(f)).find(Boolean) ?? null : null;
    if (want === null && have === null) continue;
    if (want !== null && have === want) continue;
    if (T.exists() && (want === null) !== (have === null)) c.fail('config_hash', { field, committed: want, committed_tree: have });
    else if (want !== null && have !== want) c.unverified(`configs.${field}`, 'the file is not in the committed tree and no file was given');
  }
  return c.result();
}

// ------------------------------------------------------------------ M2
export async function checkM2(ctx) {
  const c = createCheck('M2', 'roster');
  const cm = ctx.commitments, r = ctx.roster;
  if (!cm) { c.fail('commitments_missing'); return c.result(); }
  if (!r) { c.fail('roster_missing'); return c.result(); }
  c.count();
  if (!verifySigned(r, cm.registrar)) c.fail('roster_signature', { detail: 'roster.json is not signed by the registrar of the commitments' });
  c.count();
  if (r.commitments_sha256 !== sha256hex(ctx.pub.commitmentsBytes())) c.fail('roster_commitments_hash', { roster: r.commitments_sha256, file: sha256hex(ctx.pub.commitmentsBytes()) });
  const s = await ctx.season();
  c.count();
  if (!s?.programId) { c.fail('season_unreadable'); return c.result(); }
  if (r.program_id !== s.programId) c.fail('program_id', { roster: r.program_id, herald: s.programId });
  if (Number(r.season) !== Number(cm.season_id) || Number(s.season) !== Number(cm.season_id)) c.fail('season_id', { roster: r.season, commitments: cm.season_id, herald: s.season });
  if (r.deck !== cm.personas?.deck) c.fail('deck_name', { roster: r.deck, commitments: cm.personas?.deck });

  // genesis seed from the public log
  let genesis = null;
  try {
    let after = '0';
    for (let page = 0; page < 60 && !genesis; page++) {
      const j = (await ctx.herald.get(`/h/events?after=${after}&limit=500`)).json;
      for (const e of j?.events ?? []) if (e.kind === 3 && e.decoded?.name === 'GENESIS_SEED') { genesis = { round: String(e.decoded.payload.round), seed: e.decoded.payload.seed }; break; }
      if (!j?.events?.length || String(j.next) === after) break;
      after = String(j.next);
    }
  } catch (e) { c.fail('genesis_unreadable', { detail: e.message }); }
  c.count();
  if (!genesis) { c.fail('genesis_seed_missing', { detail: 'no GENESIS_SEED record in the public log' }); return c.result(); }
  if (r.genesis_seed !== genesis.seed || String(r.genesis_round) !== genesis.round) c.fail('genesis_seed', { roster: { round: r.genesis_round, seed: r.genesis_seed }, chain: genesis });

  // the deal (2.3), from the committed deck and library
  const T = committedTree(ctx.repo, cm.code?.git_commit ?? '');
  const lib = T.exists() ? T.blob('permutation-gateway/citizens/persona/library.json') : null;
  const deckBlob = T.exists() ? T.blob(`permutation-gateway/citizens/persona/decks/${cm.personas.deck}.json`) : null;
  const library = lib ? JSON.parse(lib.toString('utf8')) : JSON.parse(fs.readFileSync(path.join(HERE, 'persona', 'library.json'), 'utf8'));
  const deckFile = deckBlob ? JSON.parse(deckBlob.toString('utf8')) : JSON.parse(fs.readFileSync(path.join(HERE, 'persona', 'decks', `${cm.personas.deck}.json`), 'utf8'));
  if (!lib || !deckBlob) c.note('the committed library or deck could not be read from git: the working tree\'s were used');
  const deck = Array.isArray(deckFile) ? deckFile : deckFile.personas ?? deckFile.deck;
  const ambitionOf = id => (library.personas ?? library).find?.(p => p.id === id)?.ambition ?? null;
  const ais = cm.slots.filter(x => x.kind === 'ai');
  const dealt = dealPersonas(Buffer.from(genesis.seed, 'hex'), deck, ais.map(x => ({ index: x.index, faction: x.faction, kind: 'ai' })));
  const byIndex = new Map(dealt.map(d => [d.index, d]));
  if ((r.ai ?? []).length !== ais.length) c.fail('ai_count', { roster: (r.ai ?? []).length, slots: ais.length });
  for (const slot of ais) {
    c.count();
    const e = (r.ai ?? []).find(x => x.index === slot.index);
    if (!e) { c.fail('ai_missing', { index: slot.index }); continue; }
    const d = byIndex.get(slot.index);
    const tag = ctx.tagOfWallet(slot.wallet);
    const want = {
      wallet: slot.wallet, faction: slot.faction, persona: d?.persona, creed_variant: d?.creed_variant, temperament: d?.temperament, ambition: ambitionOf(d?.persona), tag, kind: 'ai', label: LABELS.ai,
      name: { en: ident.displayName(ident.identityOf(tag), { full: true, language: 'en' }), ja: ident.displayName(ident.identityOf(tag), { full: true, language: 'ja' }) },
    };
    const diff = Object.keys(want).filter(k => canonicalJson(want[k] ?? null) !== canonicalJson(e[k] ?? null));
    if (diff.length) c.fail('deal_mismatch', { index: slot.index, fields: diff, roster: Object.fromEntries(diff.map(k => [k, e[k]])), recomputed: Object.fromEntries(diff.map(k => [k, want[k]])) });
  }
  // the script-bot list
  c.count();
  const botSeed = ctx.o.botSeed ?? (ctx.o.stackPath && fs.existsSync(ctx.o.stackPath) ? parseStackToml(fs.readFileSync(ctx.o.stackPath, 'utf8')).bot_seed : null)
    ?? (() => { const a = resolvePubDir(ctx.o.aiDir).aiDir; const p = a && path.join(a, 'stack.toml'); return p && fs.existsSync(p) && sha256hex(fs.readFileSync(p)) === cm.configs?.stack_toml_sha256 ? parseStackToml(fs.readFileSync(p, 'utf8')).bot_seed : null; })();
  if (botSeed === null || botSeed === undefined) c.unverified('script.wallets', 'no bot seed (stack toml or --bot-seed)');
  else {
    const want = Array.from({ length: r.script?.count ?? 0 }, (_, i) => walletOf(botSeed, i).b58);
    if (canonicalJson(want) !== canonicalJson(r.script?.wallets ?? null)) c.fail('script_wallets', { detail: 'the roster\'s script-bot wallets are not roster(bots, bot_seed)', count: r.script?.count, derived_count: want.length });
    if (r.script?.label !== LABELS.script || r.script?.kind !== 'script') c.fail('script_label', { label: r.script?.label });
  }
  // the seat
  c.count();
  const seatSlot = cm.slots.find(x => x.kind === 'seat');
  if (seatSlot) {
    const e = r.seat;
    const tag = ctx.tagOfWallet(seatSlot.wallet);
    if (!e || e.wallet !== seatSlot.wallet || e.index !== seatSlot.index || e.tag !== tag || e.kind !== 'seat' || e.label !== LABELS.seat || e.faction !== seatSlot.faction) c.fail('seat_mismatch', { roster: e ?? null, slot: seatSlot, tag });
    if (e && e.scripted !== (cm.configs?.seat_script_sha256 !== null)) c.fail('seat_scripted_flag', { scripted: e.scripted, seat_script_sha256: cm.configs?.seat_script_sha256 });
  } else if (r.seat) c.fail('seat_not_committed', {});
  return c.result();
}

// ------------------------------------------------------------------ M3
const asOpenedList = f => f?.records ?? f?.opened ?? [];

export async function checkM3(ctx) {
  const c = createCheck('M3', 'roots and openings');
  const { pub } = ctx;
  const cm = ctx.commitments;
  const anchors = pub.anchors(), talk = pub.talk(), minds = pub.minds();
  const all = [...new Set([...anchors.keys(), ...talk.keys(), ...minds.keys()])].sort((a, b) => a - b);
  if (!all.length) { c.fail('no_bells', { detail: 'no anchors, talk or minds files' }); return c.result(); }
  const lo = all[0], hi = all[all.length - 1];
  const registrar = cm?.registrar;
  c.set('bells', { first: lo, last: hi });
  const innerOfBallot = new Map(); // inner -> bell of its leaf
  const talkInners = new Map();
  for (let b = lo; b <= hi; b++) {
    c.count();
    const t = talk.get(b), m = minds.get(b), a = anchors.get(b);
    if (!t) c.fail('gap_talk_file', { bell: b });
    if (!m) c.fail('gap_minds_file', { bell: b });
    if (!a) c.fail('gap_anchor', { bell: b, detail: 'no anchor file for a closed bell' });
    let social = null, mroot = null;
    if (t) {
      const inners = [];
      for (const r of t.records ?? []) {
        inners.push(r.inner);
        talkInners.set(r.inner, b);
        if (r.type === 'ballot') innerOfBallot.set(r.inner, b);
        if (r.bytes_b64 || r.sig_b64) {
          if (innerHex(fromBase64(r.bytes_b64), fromBase64(r.sig_b64)) !== r.inner) c.fail('inner_mismatch', { bell: b, id: r.id, detail: 'sha256(bytes || sig) is not the record\'s inner: the bytes or the signature were changed' });
        } else if (!r.redacted && r.type !== 'ballot') c.fail('leaf_without_bytes', { bell: b, id: r.id });
      }
      social = merkleRootHex(inners.map(socialLeaf));
      if (social !== t.root) c.fail('social_root_mismatch', { bell: b, file: t.root, recomputed: social });
    }
    if (m) {
      for (const r of m.records ?? []) {
        if (r.id !== recordIdOf(r)) c.fail('record_id_mismatch', { bell: b, id: r.id, detail: 'the record\'s id is not the hash of its content: a field was edited' });
      }
      mroot = merkleRootHex((m.records ?? []).map(recordLeaf));
      if (mroot !== m.root) c.fail('minds_root_mismatch', { bell: b, file: m.root, recomputed: mroot });
    }
    if (!a) continue;
    if (a.anchor_gap) { c.fail('anchor_gap', { bell: b, reason: a.reason ?? null }); continue; }
    if (social !== null && a.social_root !== social) c.fail('anchor_social_root', { bell: b, anchor: a.social_root, recomputed: social });
    if (mroot !== null && a.minds_root !== mroot) c.fail('anchor_minds_root', { bell: b, anchor: a.minds_root, recomputed: mroot });
    let tx = null;
    try { tx = a.signature ? await ctx.tx(a.signature) : null; } catch (e) { c.fail('anchor_unreadable', { bell: b, detail: e.message }); continue; }
    if (!tx) { c.fail('anchor_not_on_chain', { bell: b, signature: a.signature }); continue; }
    const memo = memoOf(tx);
    if (!memo) { c.fail('anchor_memo_missing', { bell: b }); continue; }
    const want = anchorMemoText(cm?.season_id, b, a.social_root, a.minds_root);
    if (memo.text !== want) c.fail('anchor_memo_text', { bell: b, memo: memo.text, want });
    if (registrar && memo.signer !== registrar) c.fail('anchor_memo_signer', { bell: b, signer: memo.signer });
    if (a.slot !== undefined && a.slot !== null && a.slot !== tx.slot) c.fail('anchor_slot', { bell: b, anchor: a.slot, chain: tx.slot });
  }
  // late files: every late id belongs to a record of its bell or is a tx update of one
  for (const [b, f] of pub.late()) {
    for (const e of f?.entries ?? []) {
      c.count();
      if (e.id && !(minds.get(b)?.records ?? []).some(r => r.id === e.id)) c.fail('late_unknown_record', { bell: b, id: e.id });
    }
  }

  // ---- council: ballots against their leaves, call commits
  for (const f of pub.councils()) {
    for (const b of f.ballots ?? []) {
      c.count();
      if (b.bytes_b64) { if (innerHex(fromBase64(b.bytes_b64), fromBase64(b.sig_b64)) !== b.inner) c.fail('ballot_bytes_inner', { council: f.name, inner: b.inner, detail: 'the ballot\'s bytes do not hash to its inner' }); }
      if (!innerOfBallot.has(b.inner)) c.fail('ballot_leaf_missing', { council: f.name, inner: b.inner, detail: 'no ballot leaf with this inner in any talk file' });
    }
    for (const b of f.open?.ballots ?? []) {
      c.count();
      if (b.bytes_b64) { if (innerHex(fromBase64(b.bytes_b64), fromBase64(b.sig_b64)) !== b.inner) c.fail('ballot_bytes_inner', { council: f.name, inner: b.inner, detail: 'the opened ballot\'s bytes do not hash to its earlier leaf' }); }
      else if (!b.redacted) c.fail('ballot_not_opened', { council: f.name, inner: b.inner });
      if (!innerOfBallot.has(b.inner)) c.fail('ballot_leaf_missing', { council: f.name, inner: b.inner, detail: 'an opened ballot with no earlier leaf' });
    }
    if (f.adopted && f.call_commit) {
      c.count();
      if (!f.open?.nonce) { if (f.strike_bell + 2 <= hi) c.fail('call_not_opened', { council: f.name, strike_bell: f.strike_bell, detail: 'the strike bell + 2 has passed and the Strike Order is not opened' }); }
      else if (callCommitOf({ option: f.open.option, p: f.open.p, q: f.open.q, tile: f.open.tile }, f.open.nonce) !== f.call_commit) c.fail('call_commit_mismatch', { council: f.name, commit: f.call_commit });
    }
  }

  // ---- sealed records: every commit opens when due (7.2)
  const decisions = ctx.decisions ?? (ctx.decisions = collectDecisions(pub));
  let reveals = null;
  const revealOf = async (host, arrive) => {
    if (reveals === null) { try { reveals = (await ctx.drained()).feed; } catch { reveals = false; } }
    return reveals ? reveals.revealOf(String(host), arrive) : undefined;
  };
  const sealed = decisions.filter(d => d.record.sealed);
  c.set('sealed_records', sealed.length);
  const lateSeen = new Set();
  let timely = 0;
  for (const d of sealed) {
    c.count();
    const rec = d.record;
    if (lateSeen.has(rec.id)) continue;
    lateSeen.add(rec.id);
    const op = d.opened;
    if (!op) { c.fail('sealed_not_opened', { decision: rec.id, ai: rec.ai, bell: rec.bell, release_bell: rec.release_bell, detail: 'no opening in PUB/open or PUB/full/open' }); continue; }
    if (op.release_bell !== undefined && op.release_bell !== rec.release_bell) c.fail('release_bell_changed', { decision: rec.id, committed: rec.release_bell, opened: op.release_bell });
    if (typeof op.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(op.nonce)) { c.fail('opening_nonce', { decision: rec.id }); continue; }
    const commit = sealedCommit(op, op.nonce);
    if (commit !== rec.commit) { c.fail('commit_mismatch', { decision: rec.id, ai: rec.ai, bell: rec.bell, record: rec.commit, recomputed: commit, detail: 'the opened choice, retrieved set, text or hashes are not what was committed' }); continue; }
    if (!Array.isArray(op.candidates)) c.fail('candidates_missing', { decision: rec.id });
    else if (sha256Canonical(op.candidates) !== op.candidates_hash) c.fail('candidates_hash', { decision: rec.id, opened: op.candidates_hash, recomputed: sha256Canonical(op.candidates) });
    // when due
    const dests = op.destinations ?? [];
    const arrive = dests.map(x => x.arrive_bell).filter(x => Number.isInteger(x));
    const unrevealed = dests.some(x => x.source === 'unrevealed' || x.destination === 'unrevealed' || x.arrive_bell === null) || op.destination === 'unrevealed';
    let due = rec.release_bell;
    if (unrevealed) due = rec.release_bell + UNREVEALED_WAIT_BELLS;
    else if (arrive.length) due = Math.max(rec.release_bell, Math.max(...arrive));
    for (const x of dests) {
      if (x.source !== 'reveal' && x.source !== undefined) continue;
      const rv = await revealOf(x.host_id, x.arrive_bell);
      if (rv === null) c.fail('destination_unrevealed', { decision: rec.id, host_id: x.host_id, arrive_bell: x.arrive_bell, detail: 'the opening names a destination with no public REVEAL' });
      else if (rv && (rv.p !== x.p || rv.q !== x.q || rv.tile !== x.tile)) c.fail('destination_mismatch', { decision: rec.id, host_id: x.host_id, opened: { p: x.p, q: x.q, tile: x.tile }, reveal: { p: rv.p, q: rv.q, tile: rv.tile } });
    }
    if (d.source === 'season_end') { c.fail('opened_late', { decision: rec.id, ai: rec.ai, bell: rec.bell, due_bell: due, detail: 'opened only in the season-end bundle (PUB/full/open): the release did not happen. The commitment verifies.' }); continue; }
    timely++;
    if (d.openBell < due) c.fail('opened_early', { decision: rec.id, open_bell: d.openBell, due_bell: due });
    else if (d.openBell > due + OPEN_GRACE_BELLS) c.fail('opened_late', { decision: rec.id, open_bell: d.openBell, due_bell: due, grace: OPEN_GRACE_BELLS });
  }
  c.set('openings_checked_for_timing', timely);
  return c.result();
}

// ------------------------------------------------------------------ M7
export async function checkM7(ctx) {
  const c = createCheck('M7', 'transaction coverage');
  const ais = ctx.roster?.ai ?? [];
  if (!ais.length) { c.skip('no AI citizens on the roster'); return c.result(); }
  const decisions = ctx.decisions ?? (ctx.decisions = collectDecisions(ctx.pub));
  // sig -> ids of the records that list it (a tx update in a late file repeats the list of the same record: one record)
  const listed = new Map();
  const add = (sig, id, ai) => { const m = listed.get(sig) ?? listed.set(sig, new Map()).get(sig); m.set(id, ai); };
  for (const [b, f] of ctx.pub.minds()) for (const r of f?.records ?? []) for (const t of r.tx ?? []) if (t.sig) add(t.sig, r.id, r.ai);
  const aiOfId = new Map(decisions.map(d => [d.record.id, d.record.ai]));
  for (const [b, f] of ctx.pub.late()) for (const e of f?.entries ?? []) for (const t of (e.tx ?? e.record?.tx ?? [])) if (t.sig) add(t.sig, e.id ?? e.record?.id, aiOfId.get(e.id ?? e.record?.id));
  c.set('listed_signatures', listed.size);
  let notRequired = 0, onChain = 0;
  const onboarding = [];
  const season = await ctx.season();
  const firstBellOf = new Map();
  for (const d of decisions) { const b = firstBellOf.get(d.record.ai); if (b === undefined || d.record.bell < b) firstBellOf.set(d.record.ai, d.record.bell); }
  const sessions = new Map();
  for (const a of ais) {
    c.count();
    const me = await ctx.me(a.wallet);
    const key = me?.citizen?.session;
    if (!me?.ok || !key || key.every(x => x === 0)) { c.fail('session_key_unreadable', { ai: a.tag, wallet: a.wallet }); continue; }
    const session = bs58.encode(Buffer.from(key));
    sessions.set(a.tag, session);
    // the session key's whole history, newest first, 1000 per page
    const sigs = [];
    let before = null;
    for (let page = 0; page < 200; page++) {
      const rows = await ctx.rpc.call('getSignaturesForAddress', [session, { limit: 1000, ...(before ? { before } : {}) }]);
      if (!rows?.length) break;
      sigs.push(...rows);
      if (rows.length < 1000) break;
      before = rows[rows.length - 1].signature;
    }
    for (const row of sigs) {
      const tx = await ctx.tx(row.signature);
      if (!tx) { c.fail('chain_tx_unreadable', { ai: a.tag, signature: row.signature }); continue; }
      if (!signersOf(tx).includes(session)) { notRequired++; continue; } // a join (wallet-signed) or a settle (relay-signed): not required (7.3)
      onChain++;
      c.count();
      const owners = listed.get(row.signature);
      if (!owners && !ctx.o.strictOnboarding && isOnboardingBeforeFirstRecord(tx, ctx.roster?.program_id, row.blockTime ?? tx.blockTime, firstBellOf.get(a.tag), season)) { onboarding.push(row.signature); continue; }
      if (!owners) c.fail('orphan_chain_tx', { ai: a.tag, signature: row.signature, slot: row.slot, detail: 'a transaction signed by the AI\'s session key that no decision record lists' });
      else if (owners.size > 1) c.fail('tx_in_many_records', { ai: a.tag, signature: row.signature, records: [...owners.keys()] });
      else if ([...owners.values()][0] !== a.tag) c.fail('tx_in_other_ais_record', { ai: a.tag, signature: row.signature, record_ai: [...owners.values()][0] });
    }
    // every signature a record of this AI lists exists on chain
    const mine = [...listed].filter(([, ids]) => [...ids.values()].includes(a.tag)).map(([sig]) => sig);
    for (let i = 0; i < mine.length; i += 200) {
      const chunk = mine.slice(i, i + 200);
      const st = await ctx.rpc.call('getSignatureStatuses', [chunk]);
      chunk.forEach((sig, k) => { c.count(); if (!st?.value?.[k]) c.fail('listed_signature_not_on_chain', { ai: a.tag, signature: sig }); });
    }
  }
  // a listed signature of an AI that is not on the roster
  for (const [sig, ids] of listed) for (const [id, ai] of ids) if (ai && !ais.some(a => a.tag === ai)) c.fail('listed_by_unknown_ai', { signature: sig, record: id, ai });
  c.set('session_signed_on_chain', onChain);
  c.set('onboarding_exempt', onboarding.length);
  if (onboarding.length) c.note(`${onboarding.length} session-signed onboarding transaction(s) (Join, SetSession, SetVigil or FileTicket) before the AI's first decision record are not required: the steps before a home holding make no mind call and leave no record (R5). Contract 7.3 names joins and settles only: this reading is the verifier's (AC8-NOTES.md); --strict-onboarding counts them as orphans.`);
  c.set('not_required_join_or_settle', notRequired);
  c.note('the seat\'s transactions are excluded (it has no record); joins and settles are not session-signed and are not required');
  return c.result();
}

// ------------------------------------------------------------------ M8
export async function checkM8(ctx) {
  const c = createCheck('M8', 'speech');
  const roster = ctx.roster;
  const byWallet = new Map((roster?.ai ?? []).map(a => [a.wallet, a]));
  const decisions = ctx.decisions ?? (ctx.decisions = collectDecisions(ctx.pub));
  const byId = new Map(decisions.map(d => [d.record.id, d]));
  const social = ctx.pub.fullSocial();
  const provOf = new Map((social?.records ?? []).filter(r => r.inner).map(r => [r.inner, r]));
  const used = new Map();
  let aiRecords = 0;
  const check = async (kind, rec, bell, bytes, sig, inner, wallet) => {
    const ai = byWallet.get(wallet);
    if (!ai) return;
    aiRecords++;
    c.count();
    const d = decodeSocial(bytes);
    if (d.origin !== 1) c.fail('origin_not_ai', { bell, inner, wallet, origin: d.origin });
    // signature under the citizen's session key (6.2 rule 1)
    const me = await ctx.me(wallet);
    const key = me?.citizen?.session;
    if (!key || !verifyBytes(Buffer.from(key), Buffer.from(bytes), Buffer.from(sig))) c.fail('bad_signature', { bell, inner, wallet, detail: 'the signature is not the citizen\'s current session key over these bytes' });
    const prov = provOf.get(inner);
    if (!social) { c.fail('no_provenance_table', { bell, inner, detail: 'PUB/full/social.json is missing: the (decision_id, item) of an AI record cannot be checked' }); return; }
    if (!prov || prov.decision_id === null) { c.fail('no_decision', { bell, inner, wallet, detail: 'an AI wallet\'s record with no decision_id' }); return; }
    const key2 = `${prov.type}|${prov.decision_id}|${prov.item}`;
    if (used.has(key2)) c.fail('duplicate_use', { decision: prov.decision_id, item: prov.item, type: prov.type, inners: [used.get(key2), inner] });
    used.set(key2, inner);
    const dec = byId.get(prov.decision_id);
    if (!dec) { c.fail('decision_unknown', { decision: prov.decision_id, bell, inner }); return; }
    if (dec.record.ai !== ai.tag) c.fail('decision_of_another_ai', { decision: prov.decision_id, record_ai: dec.record.ai, wallet_ai: ai.tag });
    if (Math.abs(dec.record.bell - d.bell) > 1) c.fail('bell_window', { decision: prov.decision_id, decision_bell: dec.record.bell, record_bell: d.bell, filed_bell: bell });
    const expect = (dec.full?.social ?? {})[prov.type === 'ballot' ? 'ballot' : 'talk']?.find(x => x.item === prov.item);
    if (!expect) { c.fail('no_expected_output', { decision: prov.decision_id, item: prov.item, detail: 'the decision has no signed-ready output for this item (PUB/full/decisions)' }); return; }
    if (prov.type === 'ballot' || d.type === 'ballot') {
      const v = viewSocial(d);
      if (v.option !== expect.option || (expect.nonce && v.nonce !== expect.nonce) || (expect.candidates_hash && v.candidates_hash !== expect.candidates_hash)) c.fail('ballot_differs_from_mind_output', { decision: prov.decision_id, item: prov.item, record: { option: v.option }, expected: { option: expect.option } });
    } else {
      const v = viewSocial(d);
      if (v.text !== expect.text || v.channel !== expect.channel || (expect.target !== null && expect.target !== undefined && String(v.target) !== String(expect.target)) || v.kind !== expect.kind || String(v.ref) !== String(expect.ref ?? 0)) {
        c.fail('text_differs_from_mind_output', { decision: prov.decision_id, item: prov.item, record: { text: v.text, channel: v.channel, kind: v.kind }, expected: { text: expect.text, channel: expect.channel, kind: expect.kind } });
      }
      // an unsealed decision's published `say` is the same text
      if (!dec.record.sealed && dec.record.kind !== 'motion' && Array.isArray(dec.record.public?.say) && dec.record.public.say[prov.item] !== undefined && dec.record.public.say[prov.item] !== v.text) c.fail('differs_from_published_say', { decision: prov.decision_id, item: prov.item });
      if (dec.record.sealed) c.fail('sealed_decision_posted', { decision: prov.decision_id, detail: 'a sealed decision\'s say is withheld until the release: it must not have been posted' });
    }
  };
  for (const [bell, f] of ctx.pub.talk()) {
    for (const r of f?.records ?? []) {
      if (r.type === 'ballot' || r.redacted || !r.bytes_b64) continue;
      let d;
      try { d = decodeSocial(fromBase64(r.bytes_b64)); } catch { c.fail('undecodable_record', { bell, id: r.id }); continue; }
      if (d.type !== 'talk') continue;
      await check('talk', r, bell, fromBase64(r.bytes_b64), fromBase64(r.sig_b64), r.inner, viewSocial(d).wallet);
    }
  }
  // opened ballots of the council files
  for (const f of ctx.pub.councils()) {
    for (const b of f.open?.ballots ?? []) {
      if (!b.bytes_b64) continue;
      const bytes = fromBase64(b.bytes_b64);
      let d;
      try { d = decodeSocial(bytes); } catch { c.fail('undecodable_ballot', { council: f.name }); continue; }
      const bell = [...ctx.pub.talk()].find(([, tf]) => (tf?.records ?? []).some(x => x.inner === b.inner))?.[0] ?? -1;
      await check('ballot', b, bell, bytes, fromBase64(b.sig_b64), b.inner, viewSocial(d).wallet);
    }
  }
  c.set('ai_records_checked', aiRecords);
  if (!aiRecords) c.note('vacuous: no social record from an AI wallet in this run (0 records checked)');
  return c.result();
}

// ------------------------------------------------------------------ the whole audit
const ALL = ['M1', 'M2', 'M3', 'M7', 'M8', 'M9', 'M11'];

export async function verifyMinds(o) {
  const ctx = await createContext(o);
  const only = o.only ? new Set(o.only) : new Set(ALL);
  const log = o.log ?? (() => {});
  const checks = {};
  await ctx.season();
  ctx.decisions = collectDecisions(ctx.pub);
  // the code the audit itself runs, against the committed blobs (an audit with later code than the run says so)
  const T = committedTree(ctx.repo, ctx.commitments?.code?.git_commit ?? '');
  const auditCode = { checked: [], same: 0, differ: [] };
  if (T.exists()) {
    for (const f of ['memory/episodes.mjs', 'memory/templates.en.json', 'memory/templates.ja.json', 'memory/names.json', 'memory/retrieve.mjs', 'memory/store.mjs', 'memory/herald-view.mjs', 'memory/config.mjs', 'memory/safe.mjs', 'persona/deal.mjs', 'persona/names.mjs', 'watcher/feed.mjs', 'watcher/owners.mjs', 'mind/wiring.mjs']) {
      const want = T.blobSha(`permutation-gateway/citizens/${f}`);
      const have = fs.existsSync(path.join(HERE, f)) ? sha256hex(fs.readFileSync(path.join(HERE, f))) : null;
      auditCode.checked.push(f);
      if (want === have) auditCode.same++; else auditCode.differ.push(f);
    }
  }
  const steps = {
    M1: () => checkM1(ctx), M2: () => checkM2(ctx), M3: () => checkM3(ctx), M7: () => checkM7(ctx), M8: () => checkM8(ctx),
    M9: () => checkM9({ pub: ctx.pub, records: ctx.decisions.map(d => d.record), seedHex: ctx.seedHex, commitments: ctx.commitments, llm: o.llm ? assertLoopback(o.llm, 'llm') : null, sample: o.sample ?? 20, fetchImpl: o.fetchImpl ?? fetch, log }),
    M11: async () => checkM11({ pub: ctx.pub, drained: await ctx.drained().catch(() => null), herald: o.herald, roster: ctx.roster, tagOfWallet: w => ctx.tagOfWallet(w), decisions: ctx.decisions, seedHex: ctx.seedHex, fetchImpl: o.fetchImpl, through: o.through ?? null, codeCheck: auditCode, sampleDecisions: o.sample ?? 20 }),
  };
  for (const id of ALL) {
    if (!only.has(id)) continue;
    const t0 = Date.now();
    try { checks[id] = await steps[id](); } catch (e) { checks[id] = { pass: false, n: 0, failures: [{ code: 'check_crashed', detail: String(e?.stack ?? e).slice(0, 600) }] }; }
    log(`${id}: ${checks[id].pass === true ? 'PASS' : checks[id].pass === false ? 'FAIL' : 'not verified'} (n=${checks[id].n}, ${checks[id].failures.length} failure(s), ${Date.now() - t0} ms)`);
  }
  const report = { v: 1, run_id: ctx.commitments?.run_id ?? null, season: ctx.commitments?.season_id ?? null, checks, verdict: verdictOf(checks), audit_code_vs_committed: auditCode, generated_unix: Math.floor(Date.now() / 1000) };
  return report;
}

// ------------------------------------------------------------------ command line
const BOOLEAN = new Set(['no-write', 'quiet', 'help', 'strict-onboarding']);
export function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) throw new Error(`unexpected argument ${k}`);
    const name = k.slice(2);
    if (BOOLEAN.has(name)) a[name] = true;
    else { if (i + 1 >= argv.length) throw new Error(`${k} needs a value`); a[name] = argv[++i]; }
  }
  return a;
}

export async function main(argv, { out = m => console.log(m), err = m => console.error(m) } = {}) {
  let a;
  try { a = parseArgs(argv); } catch (e) { err(`verify-minds: ${e.message}`); return 2; }
  if (a.help || !a.herald || !a['ai-dir'] || !a.rpc) { err('usage: verify-minds.mjs --herald URL --ai-dir PUB --rpc URL [--llm URL] [--sample 20] [--repo ROOT] [--model GGUF] [--llama-dir DIR] [--stack TOML] [--citizens-config JSON] [--slots JSON] [--seat-script F] [--bot-seed N] [--only M1,M3] [--strict-onboarding] [--through BELL] [--out FILE | --no-write] [--quiet]'); return 2; }
  try {
    assertLoopback(a.herald, 'herald');
    assertLoopback(a.rpc, 'rpc');
    if (a.llm) assertLoopback(a.llm, 'llm');
  } catch (e) { err(`verify-minds: ${e.message}`); return 2; }
  const report = await verifyMinds({
    herald: a.herald, rpc: a.rpc, aiDir: a['ai-dir'], llm: a.llm, sample: a.sample ? Number(a.sample) : 20, repoRoot: a.repo, modelPath: a.model, llamaDir: a['llama-dir'],
    stackPath: a.stack, citizensConfig: a['citizens-config'], slotsPath: a.slots, seatScript: a['seat-script'], botSeed: a['bot-seed'] !== undefined ? Number(a['bot-seed']) : undefined,
    strictOnboarding: a['strict-onboarding'] === true, only: a.only ? a.only.split(',').map(s => s.trim()) : null, through: a.through !== undefined ? Number(a.through) : null, log: a.quiet ? () => {} : m => err(m),
  });
  if (!a['no-write']) {
    const file = a.out ?? path.join(resolvePubDir(a['ai-dir']).pub, 'verify-minds.json');
    writeAtomic(file, `${JSON.stringify(report, null, 1)}\n`);
    err(`verify-minds: wrote ${file}`);
  }
  out(JSON.stringify({ verdict: report.verdict, run_id: report.run_id, checks: Object.fromEntries(Object.entries(report.checks).map(([k, v]) => [k, { pass: v.pass, n: v.n, failures: v.failures.length }])) }));
  return report.verdict === 'PASS' ? 0 : report.verdict === 'FAIL' ? 1 : 3;
}

const isMain = (() => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => { console.error(`verify-minds: ${e.stack ?? e}`); process.exitCode = 2; });
