// AC8: a consistent MINI RUN, built with the production modules, for the tests that must PASS (unit AC8, contract 11.5).
//
//   const run = await buildMiniRun();   // run.verifyOpts(), run.chain, run.aiDir, run.pub, run.llmOutputOf, run.close()
//
// What is REAL (taken verbatim from the recorded slice-4 run, test/fixtures/ai-audit-slice4): the 14 model decisions with their candidates,
// memory handles, retrieved sets, sealed destinations and prompts (private entries of the journal); the 6 published episode lists; the herald's
// public log, province and clash files, the season and the citizens (so the session keys); the stack config and the slots.
// What is DERIVED by the production code from those: every id, commit, root, anchor, signature and the commitments of this run (a fresh registrar
// key, the registrar's own `prepareCommitments`, `anchorCommit`, `anchorPass`, `buildRoster`, `publishSeasonEnd`, AC1a's `createRecords`, AC8's
// `createAudit`), because the real run's defects (a season-0 seed, one overwritten tx list, no release job, an older episode-kinds hash) are
// repaired here: the seeds follow season 41 (each stored body gets its rule seed and so a new request_hash), the llama output is a deterministic
// stand-in (`llmOutputOf`, served by the fake llama of ai-audit-doubles.mjs), the commit memo comes before genesis, the release job is simulated
// by `buildOpening` at each record's due bell (REVEALs from the real log), and the commitments hash a tiny git repo made from copies of real files.
// What is SYNTHETIC: the chain (an in-memory JSON-RPC double that records the memos and the session-signed transactions), the git repo, the fake model
// and llama directory, three extra decisions (a world message, a message that is later redacted, a ballot), their signed social records
// (signed with the AI's real session key, derivable from the public test seed 41), one council file and one session-signed onboarding transaction.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import * as R from '../../citizens/registrar.mjs';
import { createRecords } from '../../citizens/mind/records.mjs';
import { buildRequestBody, mindSeed } from '../../citizens/mind/llm.mjs';
import { buildOpening, createAudit, replayRecordsJournal } from '../../citizens/audit/season_end.mjs';
import { callCommitOf, merkleRootHex, sha256hex, socialLeaf } from '../../citizens/audit/canon.mjs';
import { encodeBallot, encodeTalk, innerOf, seqOf, toBase64, toHex } from '../../../permutation-server/web/frontier/council/aisocial.mjs';
import { deal } from '../../citizens/persona/deal.mjs';
import { retrieve } from '../../citizens/memory/retrieve.mjs';
import * as faddr from '../../../permutation-server/web/frontier/faddr.mjs';
import * as ident from '../../../permutation-server/web/frontier/people/identity.mjs';
import { SLICE4, readJson, startRecordedHerald } from './ai-audit-doubles.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GAME_TAGS = { join: 0x30, settle: 0x33, harvest: 0x40, build: 0x41, train: 0x42, muster: 0x43, explore: 0x46, depart: 0x50 };
export const SEASON = 41;
export const ALIAS = 'gemma-4-26b-a4b-it';

/** The stand-in model output the fake llama serves and the records' output_hash commits to. */
export const llmOutputOf = bodyText => JSON.stringify({ choose: ['c1'], echo: sha256hex(bodyText).slice(0, 16) });

const fakeSig = label => bs58.encode(Buffer.concat([crypto.createHash('sha256').update(`${label}/a`).digest(), crypto.createHash('sha256').update(`${label}/b`).digest()]));
const sessionSeed = (seed, index) => {
  const le64 = Buffer.alloc(8); le64.writeBigUInt64LE(BigInt(seed));
  const le32 = Buffer.alloc(4); le32.writeUInt32LE(index);
  return crypto.createHash('sha256').update(Buffer.concat([Buffer.from('PS-FRONTIER-BOT-v1'), le64, le32, Buffer.from('session')])).digest();
};

/** A JSON-RPC double of the local chain: memos (sendTransaction), session-signed game transactions, status and history queries. */
export class FakeChain {
  constructor({ genesisTs, g0 = 1_785_542_400 }) {
    Object.assign(this, { genesisTs, g0, slot: 10, time: genesisTs - 500, txs: new Map(), bySession: new Map(), calls: [] });
  }
  setTime(t) { this.time = t; }
  _put(tx) { this.slot += 1; this.time += 1; const rec = { slot: this.slot, blockTime: this.time, ...tx }; this.txs.set(tx.signature, rec); return rec; }
  /** a game transaction: signers [relay, session], the game instruction last (the shape frontier-localnet reports) */
  addGameTx({ signature, session, program, tag, time, signerIsSession = true, relay = '5LJ1yPcX3M9trrd4fzgSNk6sDY2KXjHkC7Y9KZxWypcm' }) {
    if (time !== undefined) this.time = time;
    const keys = signerIsSession ? [relay, session, program] : [relay, '11111111111111111111111111111111', session, program];
    const header = { numRequiredSignatures: signerIsSession ? 2 : 1, numReadonlySignedAccounts: signerIsSession ? 1 : 0, numReadonlyUnsignedAccounts: 1 };
    const rec = this._put({ signature, message: { accountKeys: keys, header, instructions: [{ programIdIndex: keys.length - 1, accounts: [], data: bs58.encode(Buffer.from([tag, 1, 2])) }] } });
    const list = this.bySession.get(session) ?? this.bySession.set(session, []).get(session);
    list.push(rec);
    return rec;
  }
  async call(method, params = []) {
    this.calls.push(method);
    switch (method) {
      case 'getHealth': return 'ok';
      case 'getGenesisHash': return R.localnetGenesisHash(this.g0);
      case 'getBalance': return { value: 10_000_000_000 };
      case 'requestAirdrop': return 'airdrop';
      case 'getLatestBlockhash': return { value: { blockhash: bs58.encode(crypto.createHash('sha256').update(String(this.slot)).digest()) } };
      case 'sendTransaction': {
        const { Transaction, PublicKey } = await import('@solana/web3.js');
        const tx = Transaction.from(Buffer.from(params[0], 'base64'));
        const signature = bs58.encode(tx.signature);
        const ins = tx.instructions[0];
        const memoProgram = ins.programId.toBase58();
        this._put({ signature, message: { accountKeys: [tx.feePayer.toBase58(), memoProgram], header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 }, instructions: [{ programIdIndex: 1, accounts: [0], data: bs58.encode(ins.data) }] } });
        void PublicKey;
        return signature;
      }
      case 'getSignatureStatuses': return { value: params[0].map(s => (this.txs.has(s) ? { slot: this.txs.get(s).slot, err: null, confirmationStatus: 'finalized' } : null)) };
      case 'getTransaction': {
        const t = this.txs.get(params[0]);
        return t ? { slot: t.slot, blockTime: t.blockTime, transaction: { message: t.message, signatures: [t.signature] }, meta: { err: null } } : null;
      }
      case 'getSignaturesForAddress': {
        const list = [...(this.bySession.get(params[0]) ?? [])].sort((a, b) => b.slot - a.slot);
        const before = params[1]?.before;
        const from = before ? list.findIndex(x => x.signature === before) + 1 : 0;
        return list.slice(from, from + (params[1]?.limit ?? 1000)).map(t => ({ signature: t.signature, slot: t.slot, err: null, blockTime: t.blockTime, confirmationStatus: 'finalized' }));
      }
      default: throw new Error(`fake chain: ${method} is not implemented`);
    }
  }
}

const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=ai-audit-test', '-c', 'user.email=test@example.invalid', '-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function makeRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const cp = rel => { const to = path.join(dir, rel); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(REPO, rel), to); };
  const cit = 'permutation-gateway/citizens';
  for (const f of ['memory/episodes.mjs', 'memory/templates.en.json', 'memory/templates.ja.json', 'serve.mjs', 'persona/library.json', 'persona/decks/deck-1.json', 'config/smoke.json', 'ab/seat.mjs', 'scenario/seat-script.mjs']) cp(`${cit}/${f}`); // integ-B: the A/B seat script files are in the tree while the (smoke-like) run committed none: M1 must not read that as a mismatch
  for (const f of fs.readdirSync(path.join(REPO, cit, 'prompts'))) cp(`${cit}/prompts/${f}`);
  cp('permutation-server/web/frontier/council/aisocial.mjs');
  for (const f of ['frontier-node/crates/bots/src/lib.rs', 'frontier-node/crates/agents/src/lib.rs']) { const to = path.join(dir, f); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, `// stand-in for ${f}\n`); }
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'mini repo');
}

export async function buildMiniRun({ council = true, commitLate = false, unmeasured = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-audit-mini-'));
  const aiDir = path.join(root, 'ai'), pub = path.join(aiDir, 'pub'), state = path.join(aiDir, 'state');
  fs.mkdirSync(pub, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  const heraldData = readJson(path.join(SLICE4, 'herald.json'));
  const season = heraldData.gets['/h/season'].json;
  const herald = await startRecordedHerald(heraldData);
  const chain = new FakeChain({ genesisTs: Number(season.genesisTs) });
  const stackPath = path.join(aiDir, 'stack.toml'), slotsPath = path.join(aiDir, 'ai-slots.json');
  fs.copyFileSync(path.join(SLICE4, 'stack.toml'), stackPath);
  fs.copyFileSync(path.join(SLICE4, 'ai-slots.json'), slotsPath);
  const stack = R.parseStackToml(fs.readFileSync(stackPath, 'utf8'));
  const slotsFile = readJson(slotsPath);

  // ---- the commitments (the registrar's own code) over a tiny git repo of copies of real files, a fake model and a fake llama directory
  const repo = path.join(root, 'repo');
  makeRepo(repo);
  const modelPath = path.join(root, 'fake-model.gguf');
  fs.writeFileSync(modelPath, 'fake weights for the audit test');
  const llamaDir = path.join(root, 'llama');
  fs.mkdirSync(llamaDir);
  fs.writeFileSync(path.join(llamaDir, 'llama-server'), 'fake binary');
  fs.writeFileSync(path.join(llamaDir, 'libllama.dylib'), 'fake library');
  const keyPath = path.join(root, 'keys', 'registrar.json');
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  const kp = Keypair.fromSeed(crypto.createHash('sha256').update('ai-audit-mini-registrar').digest());
  fs.writeFileSync(keyPath, JSON.stringify(Array.from(kp.secretKey)));
  const citizensConfigPath = path.join(repo, 'permutation-gateway/citizens/config/smoke.json');
  const prepOpts = {
    repoRoot: repo, aiDir, keyPath, stackPath, citizensConfigPath, slotsPath, deck: 'deck-1', runId: 'mini', now: () => Number(season.genesisTs) * 1000 - 1000,
    model: { file: 'fake-model.gguf', sha256: sha256hex(fs.readFileSync(modelPath)), alias: ALIAS }, llama: { dir: llamaDir },
  };
  if (unmeasured) { // a smoke run that left the model and the llama tree unmeasured (7.1, R9)
    const inputs = R.collectInputs(prepOpts);
    prepOpts.override = { model: { ...inputs.model, sha256: 'unmeasured' }, server: { ...inputs.server, tree_sha256: 'unmeasured' } };
  }
  const prepared = R.prepareCommitments(prepOpts);
  chain.setTime(commitLate ? Number(season.genesisTs) + 50 : Number(season.genesisTs) - 400);
  await R.anchorCommit({ aiDir, kp, rpc: chain, g0: chain.g0, sha: prepared.sha256, season: prepared.obj.season_id, herald: herald.url, heraldWaitMs: 2000 });

  // ---- the roster (the registrar's `buildRoster` with the real deal)
  const genesisRow = heraldData.events.find(e => e.decoded?.name === 'GENESIS_SEED');
  const genesis = { round: String(genesisRow.decoded.payload.round), seed: genesisRow.decoded.payload.seed };
  const library = readJson(path.join(REPO, 'permutation-gateway/citizens/persona/library.json'));
  const deps = {
    deal, library: Object.fromEntries(library.personas.map(p => [p.id, p])), deck: readJson(path.join(REPO, 'permutation-gateway/citizens/persona/decks/deck-1.json')),
    tagOf: (programId, seasonId, wallet) => ident.tagKey(faddr.citizenTag(faddr.seasonAddresses(programId, seasonId).of('Citizen', { wallet }))),
    nameOf: tag => ({ en: ident.displayName(ident.identityOf(tag), { full: true, language: 'en' }), ja: ident.displayName(ident.identityOf(tag), { full: true, language: 'ja' }) }),
    botSeed: stack.bot_seed, scriptCount: stack.bots,
  };
  const roster = R.buildRoster({ commitments: prepared.obj, commitmentsSha: prepared.sha256, season: { programId: season.programId, season: season.season }, genesis, deps: { ...deps, deck: Array.isArray(deps.deck) ? deps.deck : deps.deck.personas ?? deps.deck.deck }, kp });
  fs.writeFileSync(path.join(pub, 'roster.json'), `${JSON.stringify(roster)}\n`);
  const ais = roster.ai;
  const aiByIndex = new Map(ais.map(a => [a.index, a]));
  const sessionPub = new Map(ais.map(a => [a.index, bs58.encode(R.pubOfSeed(sessionSeed(stack.bot_seed, a.index)))]));

  // ---- the decisions: the 14 real model decisions (re-issued), plus three synthetic ones
  const journal = replayRecordsJournal(path.join(SLICE4, 'state', 'records.jsonl'));
  let nonceCounter = 1;
  const records = createRecords({ aiDir, runId: 'mini', season: SEASON, randomBytes: n => Buffer.alloc(n, nonceCounter++) });
  const reissued = [];
  const wallets = new Map(ais.map(a => [a.index, a.wallet]));
  const bodyFor = (index, bell, kind, attempt, messages, schemaName) => {
    const body = buildRequestBody({ alias: ALIAS, messages, schemaName, schema: { type: 'object' }, maxTokens: 256, seed: mindSeed({ season: SEASON, index, bell, kind, attempt }), requestShape: 'response_format' });
    return JSON.stringify(body);
  };
  const addWithBody = (full, priv, bodyText) => {
    full.request_hash = sha256hex(bodyText);
    full.output_hash = sha256hex(llmOutputOf(bodyText));
    const { id } = records.add(full, priv);
    records.saveRequest(id, bodyText);
    return id;
  };
  for (const e of [...journal.values()].filter(x => x.full.mode === 'model').sort((a, b) => a.bell - b.bell || a.index - b.index)) {
    const old = JSON.parse(fs.readFileSync(path.join(SLICE4, 'state', 'requests', `${e.id}.json`), 'utf8'));
    old.seed = mindSeed({ season: SEASON, index: e.index, bell: e.bell, kind: e.kind, attempt: Math.max(0, (e.full.attempts ?? 1) - 1) });
    const bodyText = JSON.stringify(old);
    const full = { ...e.full };
    delete full.id;
    full.commit = null;
    full.seed = old.seed;
    const id = addWithBody(full, e.priv, bodyText);
    reissued.push({ id, old: e.id, index: e.index, bell: e.bell, sealed: Boolean(full.sealed) });
  }
  // what the live mind retrieves for a decision with no candidates, inbox or threats: the production retrieve() over the AI's own published list
  const publishedEpisodes = tag => readJson(path.join(SLICE4, 'pub', 'memory', tag, 'episodes.json')).episodes;
  const homeOf = index => [...journal.values()].find(x => x.index === index && x.priv?.situation?.me?.home)?.priv.situation.me.home ?? null;
  const retrievedFor = (index, bell) => {
    const a = aiByIndex.get(index), home = homeOf(index);
    const focus = new Set([a.tag, `nation:${a.faction}`, ...(home ? [`pq:${home.p},${home.q}`] : [])]);
    return retrieve(publishedEpisodes(a.tag).filter(e => e.created_bell < bell), focus, bell, { grievances: [] });
  };
  const baseRec = (index, bell, kind, extra) => ({
    v: 2, ai: aiByIndex.get(index).tag, index, bell, kind, mode: 'model', reason: 'ok', wake: ['W-QUEUE'], gate_score: 3, sealed: false, release_bell: null, obs_digest: sha256hex(`obs${index}${bell}`),
    situation_hash: sha256hex('sit'), candidates_hash: sha256hex('[]'), memory_hash: sha256hex('mem'), inbox_root: sha256hex(''), prompt_hash: sha256hex('prompt'), attempts: 1,
    choice: { ids: [], params: {}, council: null, goal_id: 'G2', mem: [] }, retrieved: retrievedFor(index, bell), public: { say: [], why: 'a stand-in reason', why_withheld: null }, latency_ms: 900, deadline_slack_ms: 50_000, quota_left: 30, tx: [], ...extra,
  });
  const sign = (index, bytes) => R.signBytes(sessionSeed(stack.bot_seed, index), bytes);
  const walletBytes = index => Buffer.from(bs58.decode(wallets.get(index)));
  const social = []; // journal lines of the social book (STATE/social/records.jsonl)
  const talkByBell = new Map();
  const putTalk = (bell, entry) => { (talkByBell.get(bell) ?? talkByBell.set(bell, []).get(bell)).push(entry); };
  // (a) a world message by AI 1000 at bell 30
  {
    const text = 'Greetings from the north.', bell = 30, index = 1000, seq = seqOf(bell, 0);
    const msgs = [{ role: 'system', content: 'You are an AI citizen.' }, { role: 'user', content: `Say hello. ${text}` }];
    const full = baseRec(index, bell, 'reaction', { seed: mindSeed({ season: SEASON, index, bell, kind: 'reaction', attempt: 0 }), public: { say: [text], why: 'I greet my neighbours.', why_withheld: null } });
    full.choice = { ...full.choice, mem: full.retrieved.slice(-1) };
    const id = addWithBody(full, { candidates: [], situation: { me: { faction: 0 } }, remembered: [], intended: [], social: { talk: [{ item: 0, kind: 0, channel: 0, target: null, text, lang: 'en', ref: 0, bell, seq }] } }, bodyFor(index, bell, 'reaction', 0, msgs, 'reaction'));
    const bytes = encodeTalk({ season: SEASON, bell, wallet: walletBytes(index), seq, channel: 0, target: null, kind: 0, ref: 0, origin: 1, lang: 'en', text });
    const sig = sign(index, bytes);
    const inner = toHex(innerOf(bytes, sig));
    putTalk(bell, { type: 'talk', id: 1, inner, bytes_b64: toBase64(bytes), sig_b64: toBase64(sig) });
    social.push({ t: 'rec', id: 1, type: 'talk', bell, wallet: wallets.get(index), tag: aiByIndex.get(index).tag, faction: 0, kind: 'ai', origin: 1, bytes_b64: toBase64(bytes), sig_b64: toBase64(sig), decision_id: id, item: 0 });
    reissued.push({ id, index, bell, social: 'talk', inner });
  }
  // (b) a message by AI 1003 at bell 31 that the operator redacts later: its text is in the prompt too, so the stored request is blanked and M9 excludes it
  let redactedInner;
  {
    const text = 'REDACT-ME private words', bell = 31, index = 1003, seq = seqOf(bell, 0);
    const msgs = [{ role: 'system', content: 'You are an AI citizen.' }, { role: 'user', content: `INBOX: a neighbour wrote ${text}` }];
    const full = baseRec(index, bell, 'reaction', { seed: mindSeed({ season: SEASON, index, bell, kind: 'reaction', attempt: 0 }), public: { say: [text], why: 'I repeat it.', why_withheld: null } });
    const id = addWithBody(full, { candidates: [], situation: { me: { faction: 3 } }, remembered: [], intended: [], social: { talk: [{ item: 0, kind: 0, channel: 0, target: null, text, lang: 'en', ref: 0, bell, seq }] } }, bodyFor(index, bell, 'reaction', 0, msgs, 'reaction'));
    const bytes = encodeTalk({ season: SEASON, bell, wallet: walletBytes(index), seq, channel: 0, target: null, kind: 0, ref: 0, origin: 1, lang: 'en', text });
    const sig = sign(index, bytes);
    redactedInner = toHex(innerOf(bytes, sig));
    putTalk(bell, { type: 'talk', id: 2, inner: redactedInner, bytes_b64: '', sig_b64: '', redacted: true });
    social.push({ t: 'rec', id: 2, type: 'talk', bell, wallet: wallets.get(index), tag: aiByIndex.get(index).tag, faction: 3, kind: 'ai', origin: 1, bytes_b64: toBase64(bytes), sig_b64: toBase64(sig), decision_id: id, item: 0 });
    reissued.push({ id, index, bell, redacted: true });
  }
  // (c) a ballot of AI 1001 (faction 1) at bell 28, opened with the Strike Order of faction 1 at bell 38 (S = 36)
  let councilFile = null;
  if (council) {
    const bell = 28, index = 1001, option = 2, period = 0;
    const nonce = crypto.createHash('sha256').update('ballot-nonce').digest().subarray(0, 16);
    const msgs = [{ role: 'system', content: 'You are an AI citizen.' }, { role: 'user', content: 'Cast a ballot.' }];
    const full = baseRec(index, bell, 'ballot', { seed: mindSeed({ season: SEASON, index, bell, kind: 'ballot', attempt: 0 }), choice: { ids: [], params: {}, council: { ballot: option }, goal_id: 'G1', mem: [] } });
    const id = addWithBody(full, { candidates: [], situation: { me: { faction: 1 } }, remembered: [], intended: [], social: { ballot: [{ item: 0, option, period, nonce: toHex(nonce) }] } }, bodyFor(index, bell, 'ballot', 0, msgs, 'ballot'));
    const candHash = Uint8Array.from(crypto.createHash('sha256').update('candidates').digest());
    const bytes = encodeBallot({ season: SEASON, period, wallet: walletBytes(index), faction: 1, option, candidates_hash: candHash, nonce, origin: 1 });
    const sig = sign(index, bytes);
    const inner = toHex(innerOf(bytes, sig));
    putTalk(bell, { type: 'ballot', id: 3, inner, wallet: wallets.get(index), period });
    social.push({ t: 'rec', id: 3, type: 'ballot', bell, wallet: wallets.get(index), tag: aiByIndex.get(index).tag, faction: 1, kind: 'ai', origin: 1, bytes_b64: toBase64(bytes), sig_b64: toBase64(sig), decision_id: id, item: 0 });
    const call = { option, p: 0, q: -3, tile: 27 }, cnonce = 'cd'.repeat(32);
    councilFile = {
      period, faction: 1, adopted: true, strike_bell: 36, call_commit: callCommitOf(call, cnonce), ballots: [{ inner, wallet: wallets.get(index) }],
      open: { ...call, nonce: cnonce, invited: ['550859620483072'], tally: { 1: 0, 2: 1, 3: 0 }, ballots: [{ inner, bytes_b64: toBase64(bytes), sig_b64: toBase64(sig) }] },
    };
    reissued.push({ id, index, bell, social: 'ballot', inner });
  }
  fs.mkdirSync(path.join(state, 'social'), { recursive: true });
  fs.writeFileSync(path.join(state, 'social', 'records.jsonl'), `${social.map(x => JSON.stringify(x)).join('\n')}\n`);
  if (councilFile) {
    fs.mkdirSync(path.join(pub, 'council'), { recursive: true });
    fs.writeFileSync(path.join(pub, 'council', '0-1.json'), `${JSON.stringify(councilFile)}\n`);
  }
  fs.writeFileSync(path.join(pub, 'redactions.json'), `${JSON.stringify([{ inner: redactedInner, bell: 45, reason: 'test redaction' }])}\n`);

  // ---- the chain: every listed signature as a session-signed transaction, one onboarding FileTicket per AI, one wallet-signed join
  const program = season.programId;
  const intentTag = intent => GAME_TAGS[intent] ?? 0x40;
  for (const a of ais) {
    chain.addGameTx({ signature: fakeSig(`filetix${a.index}`), session: sessionPub.get(a.index), program, tag: GAME_TAGS.settle, time: Number(season.genesisTs) + 100 });
    chain.addGameTx({ signature: fakeSig(`join${a.index}`), session: sessionPub.get(a.index), program, tag: GAME_TAGS.join, time: Number(season.genesisTs) + 50, signerIsSession: false });
  }
  const priv = records.privateRecords();
  for (const e of priv) {
    for (const t of e.full.tx ?? []) if (t.sig) chain.addGameTx({ signature: t.sig, session: sessionPub.get(e.index), program, tag: intentTag(t.intent), time: Number(season.genesisTs) + e.bell * 600 + 20 });
  }

  // ---- close every bell from the first record to the last, publish talk files, anchor each bell, release the sealed records
  const bells = priv.map(e => e.bell);
  const lo = Math.min(...bells), hi = Math.max(...bells) + 2;
  const fileOfTalk = b => { const recs = talkByBell.get(b) ?? []; return { bell: b, root: merkleRootHex(recs.map(r => socialLeaf(r.inner))), records: recs }; };
  for (let b = lo; b <= hi; b++) {
    records.closeBell(b);
    fs.mkdirSync(path.join(pub, 'talk'), { recursive: true });
    fs.writeFileSync(path.join(pub, 'talk', `${b}.json`), `${JSON.stringify(fileOfTalk(b))}\n`);
  }
  const reveals = (host, arrive) => {
    const row = heraldData.events.find(e => e.decoded?.name === 'REVEAL' && String(e.decoded.payload.host_id) === String(host) && e.decoded.key.arrive === arrive);
    return row ? { p: row.decoded.key.p, q: row.decoded.key.q, tile: row.decoded.payload.tile, arrive: row.decoded.key.arrive } : null;
  };
  // the release job (AC6, not built yet): open each sealed record at its due bell, once per bell, all due records together
  const due = new Map();
  for (const e of records.privateRecords()) {
    if (!e.full.sealed) continue;
    const o = buildOpening(e, { reveals });
    const arrive = o.destinations.map(d => d.arrive_bell).filter(Number.isInteger);
    const at = Math.max(e.full.release_bell, ...arrive);
    (due.get(at) ?? due.set(at, []).get(at)).push(o);
    records.markOpened(e.id);
  }
  fs.mkdirSync(path.join(pub, 'open'), { recursive: true });
  for (const [b, list] of due) fs.writeFileSync(path.join(pub, 'open', `${b}.json`), `${JSON.stringify({ bell: b, records: list.sort((x, y) => (x.id < y.id ? -1 : 1)) })}\n`);
  chain.setTime(Number(season.genesisTs) + (hi + 1) * 600);
  await R.anchorPass({ aiDir, kp, rpc: chain, season: SEASON });
  R.publishSeasonEnd({ aiDir, kp, season: SEASON, commitmentsSha: prepared.sha256 });

  // ---- the episode lists (real, published by the slice-4 run) and the season-end bundle
  for (const t of fs.readdirSync(path.join(SLICE4, 'pub', 'memory'))) {
    fs.mkdirSync(path.join(pub, 'memory', t), { recursive: true });
    fs.copyFileSync(path.join(SLICE4, 'pub', 'memory', t, 'episodes.json'), path.join(pub, 'memory', t, 'episodes.json'));
  }
  const audit = createAudit({ aiDir });
  const result = audit.publishSeasonEnd();

  return {
    aiDir, pub, state, root, repo, chain, kp, roster, commitments: prepared.obj, reissued, redactedInner, seasonEnd: result, herald, heraldData,
    modelPath, llamaDir, stackPath, slotsPath, citizensConfigPath, llmOutputOf, sessionPub,
    // episodeRule: the 6 published episode lists are the REAL slice-4 ones, written under the pre-R12 rule (FB5); the commitments of this mini run are made from the current tree, so the rule is named here
    verifyOpts: (extra = {}) => ({ herald: herald.url, rpc: chain, aiDir: pub, repoRoot: repo, modelPath, llamaDir, stackPath, slotsPath, episodeRule: 'legacy_v1', ...extra }),
    async close() { await herald.close(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}
