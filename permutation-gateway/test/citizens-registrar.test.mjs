// citizens/registrar.mjs (unit AC5; contract §6.3, §7.1, §8.4): canonical JSON, wallet derivation, the slots file,
// commitments (collect, sign, verify, tamper), the memo transaction and the commit/anchor flows against a fake RPC and a
// fake herald on 127.0.0.1:0, the localnet-only refusals, the deal and the roster with test doubles for the AC2 modules,
// the per-bell anchors (retry, gap), the season-end publication and the RUNS.md format. No chain, no model.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import * as R from '../citizens/registrar.mjs';
import { findKeyLikeFiles } from '../citizens/serve.mjs';
import { citizenTag, seasonAddresses } from '../../permutation-server/web/frontier/faddr.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-reg-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const write = (p, data) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };
const read = p => fs.readFileSync(p, 'utf8');
const here = new URL('../citizens/stack/', import.meta.url).pathname;

const G0 = 1_785_542_400;
const stackToml = `run_id = "ai-test"\nmode = "accel"\nbeacon = "test-key"\nscale = 10\npreseason_scale = 2000\ndays = 3\nbots = 180\nbot_seed = 31\nseason_id = 31\nbase_port = 41900\nbots_args = "--follow-council"\n`;
const config = {
  channel_lang: 'en',
  council: { period: 48, offset: 12, strike_lead: 6, human_present: true },
  budgets: { sessions: 8, reactions: 6, reflection: 2, reactions_per_bell_global: 4 },
  caps: { march_share: 0.6, day_share: 0.6, home_floor: 0.4, marches_per_day: 4 },
  gate: { weights: { a: 1 }, pulse: 24, threshold: 3, social_cap: 2 },
  memory: { reflect_every: 72, reflection: true, retrieve: { top: 8, newest: 3, half_life_bells: 72, focus_bonus: 0.5 }, block_tokens: 750 },
  llm: { url: 'http://127.0.0.1:41901', alias: 'gemma-4-26b-a4b-it', max_tokens: 400 },
  serve: { port: 41902 },
};

/** A throwaway git repository shaped like the parts of the tree the commitments hash. */
function makeRepo() {
  const root = path.join(tmp, `repo-${Math.random().toString(16).slice(2)}`);
  const f = (p, c) => write(path.join(root, p), c);
  f('permutation-gateway/citizens/serve.mjs', '// serve v1\n');
  f('permutation-gateway/citizens/prompts/decide.txt', 'prompt a\n');
  f('permutation-gateway/citizens/prompts/reflect.txt', 'prompt b\n');
  f('permutation-gateway/citizens/persona/library.json', '{"personas":[{"id":"avenger","ambition":"Avenger"}]}\n');
  f('permutation-gateway/citizens/persona/decks/deck-2.json', '["avenger","diplomat"]\n');
  f('permutation-gateway/citizens/memory/episodes.mjs', 'export {};\n');
  f('permutation-gateway/citizens/memory/templates.en.json', '{"v":1,"lang":"en","kinds":{"attacked_own":"x","threat":"y"},"words":{},"items":{}}\n');
  f('permutation-gateway/citizens/injection/corpus.json', '[]\n');
  f('frontier-node/crates/bots/src/lib.rs', '// bots\n');
  f('frontier-node/crates/agents/src/lib.rs', '// agents\n');
  f('permutation-server/web/frontier/council/main.mjs', 'export {};\n');
  f('stack.toml', stackToml);
  f('config.json', JSON.stringify(config));
  const slots = R.makeSlots({ seed: 31, n: 12 });
  f('slots.json', JSON.stringify(slots));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...a) => execFileSync('git', ['-C', root, '-c', 'commit.gpgsign=false', ...a], { env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return { root, git, f };
}
const baseOpts = (repo, aiDir) => ({
  repoRoot: repo.root, aiDir, keyPath: path.join(aiDir, 'keys', 'registrar.json'), stackPath: path.join(repo.root, 'stack.toml'), citizensConfigPath: path.join(repo.root, 'config.json'),
  slotsPath: path.join(repo.root, 'slots.json'), deck: 'deck-2', now: () => 1_790_000_000_000,
});

// ------------------------------------------------------------------ helpers
test('canonical JSON: keys sorted at every level, no spaces, arrays in order, unicode kept; NaN and undefined refused', () => {
  assert.equal(R.canonicalJson({ b: 1, a: { d: [3, 1, { z: 0, y: null }], c: 'é\n' } }), '{"a":{"c":"é\\n","d":[3,1,{"y":null,"z":0}]},"b":1}');
  assert.equal(R.canonicalJson([]), '[]');
  assert.equal(R.canonicalJson({}), '{}');
  assert.equal(R.canonicalJson({ x: 0.6 }), '{"x":0.6}');
  assert.throws(() => R.canonicalJson({ a: NaN }), /finite/);
  assert.throws(() => R.canonicalJson({ a: undefined }), /undefined/);
  assert.throws(() => R.canonicalJson(() => 1), /not JSON/);
});

test('walletOf is the agents/src/keys.rs derivation (vectors recorded from a real local run\'s JOIN records: bot seed 1, indices 11 and 17)', () => {
  assert.equal(R.walletOf(1, 11).b58, 'CdMwi56zYQCTmKkLuPBK9AWWRuZ1A9ft6PRoj7MEE8uk');
  assert.equal(R.walletOf(1, 17).b58, '5KHdD4n3JV3Sygv9AaL7kXgkWkAUzvorcSDJF7VAbPF3');
  assert.notEqual(R.walletOf(1, 11).b58, R.walletOf(2, 11).b58);
  assert.equal(R.walletOf(31, 1000).pub.length, 32);
});

test('the slots file: n AI slots from index 1000 (faction = i mod 6, join_bell = i) and the seat after them; n is 6, 12 or 18', () => {
  const s = R.makeSlots({ seed: 31, n: 12 });
  assert.equal(s.v, 1);
  assert.equal(s.seed, 31);
  assert.equal(s.first_index, 1000);
  assert.equal(s.slots.length, 13);
  assert.deepEqual(s.slots[0], { index: 1000, faction: 0, join_bell: 0, kind: 'ai' });
  assert.deepEqual(s.slots[7], { index: 1007, faction: 1, join_bell: 7, kind: 'ai' });
  assert.deepEqual(s.slots[12], { index: 1012, faction: 0, join_bell: 0, kind: 'seat' });
  for (let f = 0; f < 6; f++) assert.equal(s.slots.filter(x => x.kind === 'ai' && x.faction === f).length, 2, 'equal per nation (W5)');
  assert.equal(R.makeSlots({ seed: 1, n: 6 }).slots.length, 7);
  assert.equal(R.makeSlots({ seed: 1, n: 18 }).slots.length, 19);
  assert.throws(() => R.makeSlots({ seed: 1, n: 7 }), /6 \(deck-1\)/);
});

test('slot wallets never meet the script bots\' wallets for the three stack configs (JS mirror of ai_slots_disjoint)', () => {
  for (const [name, n] of [['ai-citizens', 18], ['ai-ab', 12], ['ai-smoke', 6]]) {
    const stack = R.parseStackToml(read(path.join(here, `${name}.toml`)));
    const slots = R.makeSlots({ seed: stack.bot_seed, n });
    const ai = new Set(slots.slots.map(s => R.walletOf(stack.bot_seed, s.index).b58));
    assert.equal(ai.size, n + 1);
    for (let i = 0; i < stack.bots; i++) assert.ok(!ai.has(R.walletOf(stack.bot_seed, i).b58), `${name}: script bot ${i}`);
    assert.ok(slots.slots[0].index >= stack.bots, `${name}: AI indices start above the script bots`);
  }
});

test('loopbackUrl and the key path rule', () => {
  assert.equal(R.loopbackUrl('http://127.0.0.1:41910', 'rpc').url, 'http://127.0.0.1:41910');
  assert.equal(R.loopbackUrl('http://[::1]:41940', 'h').host, '::1');
  for (const u of ['http://localhost:41910', 'http://10.0.0.1:41910', 'http://example.com:80', 'https://127.0.0.1:41910', 'ftp://127.0.0.1', 'nonsense']) assert.throws(() => R.loopbackUrl(u, 'x'), /loopback|not a URL/, u);
  const ai = path.join(tmp, 'k-ai');
  assert.throws(() => R.assertKeyPathAllowed(path.join(ai, 'pub', 'registrar.json'), ai), /lies under PUB/);
  assert.throws(() => R.assertKeyPathAllowed(path.join(ai, 'state', 'x', 'registrar.json'), ai), /lies under STATE/);
  assert.doesNotThrow(() => R.assertKeyPathAllowed(path.join(ai, 'keys', 'registrar.json'), ai));
});

test('the stack toml subset reader agrees with the stack\'s own rules (strings, integers, floats, booleans; no escapes, no duplicates)', () => {
  const t = R.parseStackToml('a = 1\nb = "x y" # c\n[s]\nk = 2.5\nflag = true\nbig = 1_000\n');
  assert.deepEqual(t, { a: 1, b: 'x y', 's.k': 2.5, 's.flag': true, 's.big': 1000 });
  assert.throws(() => R.parseStackToml('a = 1\na = 2'), /twice/);
  assert.throws(() => R.parseStackToml('a = [1, 2]'), /bad value/);
  assert.throws(() => R.parseStackToml('a = "x\\n"'), /escapes/);
  assert.throws(() => R.parseStackToml('a = "x'), /unclosed/);
});

test('genesis hash: sha256("PSF-LOCALNET-GENESIS" ‖ g0 ‖ slot0), base58', () => {
  const h = R.localnetGenesisHash(G0);
  assert.equal(bs58.decode(h).length, 32);
  assert.notEqual(h, R.localnetGenesisHash(G0 + 1));
  assert.notEqual(h, R.localnetGenesisHash(G0, 2));
  assert.equal(h, 'JEJHwFji41LtHV65M7ejtPti4zpLxtqp3SrjZ5NFSMG6');
});

// ------------------------------------------------------------------ commitments
test('commitments: collected from the tree, signed, verifiable, and any edit breaks the signature; the file is canonical and its sha256 is what the memo carries', () => {
  const repo = makeRepo();
  const aiDir = path.join(tmp, 'run-a');
  const p = R.prepareCommitments(baseOpts(repo, aiDir));
  const c = JSON.parse(read(p.file));
  assert.equal(c.v, 1);
  assert.equal(c.run_id, 'ai-test');
  assert.equal(c.season_id, 31);
  assert.equal(c.created_unix, 1_790_000_000);
  assert.deepEqual(c.model, R.PINNED_MODEL);
  assert.deepEqual(c.server.flags, R.PINNED_LLAMA_FLAGS);
  assert.equal(c.server.flags_sha256, R.sha256hex(R.canonicalJson(R.PINNED_LLAMA_FLAGS)));
  assert.equal(c.server.request_shape, 'response_format');
  assert.deepEqual(c.sampling, { temperature: 0, top_k: 1, cache_prompt: false, seed_rule: R.SEED_RULE });
  assert.equal(c.code.git_commit, repo.git('rev-parse', 'HEAD').trim());
  assert.equal(c.code.mind_tree, repo.git('rev-parse', 'HEAD:permutation-gateway/citizens').trim());
  assert.equal(c.code.memory_tree, repo.git('rev-parse', 'HEAD:permutation-gateway/citizens/memory').trim());
  assert.equal(c.code.page_tree, repo.git('rev-parse', 'HEAD:permutation-server/web/frontier/council').trim());
  assert.equal(c.code.serve_sha256, R.sha256hex('// serve v1\n'));
  assert.equal(c.code.episodes_module_sha256, R.sha256hex('export {};\n'));
  assert.equal(c.code.episode_kinds_sha256, R.sha256hex('["attacked_own","threat"]'));
  assert.equal(c.code.prompt_templates_sha256, R.sha256hex(`decide.txt\0${R.sha256hex('prompt a\n')}\nreflect.txt\0${R.sha256hex('prompt b\n')}\n`));
  assert.equal(c.code.candidate_generator_tree, R.combinedTreeHash(repo.root, ['frontier-node/crates/bots/src', 'frontier-node/crates/agents/src']));
  assert.equal(c.configs.stack_toml_sha256, R.sha256hex(stackToml));
  assert.equal(c.configs.slots_sha256, R.sha256File(path.join(repo.root, 'slots.json')));
  assert.equal(c.configs.citizens_config_sha256, R.sha256File(path.join(repo.root, 'config.json')));
  assert.equal(c.configs.seat_script_sha256, null);
  assert.equal(c.configs.injection_corpus_sha256, R.sha256hex('[]\n'));
  assert.equal(c.personas.deck, 'deck-2');
  assert.equal(c.personas.library_sha256, R.sha256hex('{"personas":[{"id":"avenger","ambition":"Avenger"}]}\n'));
  assert.equal(c.personas.deck_sha256, R.sha256hex('["avenger","diplomat"]\n'));
  assert.equal(c.personas.deal_rule, '§2.3 v1.2');
  assert.equal(c.slots.length, 13);
  assert.equal(c.slots[0].wallet, R.walletOf(31, 1000).b58);
  assert.deepEqual(Object.keys(c.slots[0]).sort(), ['faction', 'index', 'kind', 'wallet']);
  assert.equal(c.slots_root, R.sha256hex(R.canonicalJson(c.slots)));
  assert.deepEqual(c.rules.council, config.council);
  assert.deepEqual(c.rules.gate, { pulse: 24, threshold: 3, social_cap: 2 }, 'the weights stay out of the commitment block');
  assert.deepEqual(c.rules.caps, config.caps);
  assert.deepEqual(c.rules.memory, config.memory);
  // Signed, canonical, memo-able.
  assert.equal(c.registrar, p.kp.publicKey.toBase58());
  assert.ok(R.verifySigned(c, c.registrar));
  assert.equal(read(p.file), R.canonicalJson(c), 'the file is the canonical JSON of the signed object');
  assert.equal(p.sha256, R.sha256hex(read(p.file)));
  assert.equal(R.commitMemoText(c.season_id, p.sha256), `wylls-ai/1 commit 31 ${p.sha256}`);
  for (const mut of [o => { o.model.sha256 = '00'; }, o => { o.slots[3].wallet = o.slots[4].wallet; }, o => { o.rules.caps.march_share = 0.9; }, o => { o.created_unix += 1; }, o => { o.registrar = Keypair.generate().publicKey.toBase58(); }]) {
    const t = JSON.parse(read(p.file));
    mut(t);
    assert.ok(!R.verifySigned(t, c.registrar) && !R.verifySigned(t, t.registrar), 'a changed field breaks the signature');
  }
  assert.ok(!R.verifySigned({ ...c, sig: undefined }, c.registrar));
  // Same inputs, same file (the key is fixed by the key file, the time by `now`).
  const again = R.prepareCommitments(baseOpts(repo, aiDir));
  assert.equal(again.sha256, p.sha256);
  // The key never lands in PUB; nothing in PUB reads like a key.
  assert.deepEqual(findKeyLikeFiles(path.join(aiDir, 'pub')), []);
  assert.equal(JSON.parse(read(path.join(aiDir, 'keys', 'registrar.json'))).length, 64);
  assert.equal(fs.statSync(path.join(aiDir, 'keys', 'registrar.json')).mode & 0o777, 0o600);
});

test('commitments refuse a dirty tree, a key path under PUB, a slots file with another seed, a config that lacks a pinned key', () => {
  const repo = makeRepo();
  const aiDir = path.join(tmp, 'run-b');
  write(path.join(repo.root, 'permutation-gateway/citizens/serve.mjs'), '// edited\n');
  assert.throws(() => R.prepareCommitments(baseOpts(repo, aiDir)), /dirty tree/);
  assert.doesNotThrow(() => R.prepareCommitments({ ...baseOpts(repo, aiDir), allowDirty: true }));
  repo.git('checkout', '--', '.');
  assert.throws(() => R.prepareCommitments({ ...baseOpts(repo, aiDir), keyPath: path.join(aiDir, 'pub', 'registrar.json') }), /lies under PUB/);
  write(path.join(repo.root, 'slots.json'), JSON.stringify(R.makeSlots({ seed: 99, n: 12 })));
  assert.throws(() => R.prepareCommitments({ ...baseOpts(repo, aiDir), allowDirty: true }), /bot_seed/);
  write(path.join(repo.root, 'slots.json'), JSON.stringify(R.makeSlots({ seed: 31, n: 12 })));
  const bad = { ...config, caps: { march_share: 0.6 } };
  write(path.join(repo.root, 'config.json'), JSON.stringify(bad));
  assert.throws(() => R.prepareCommitments({ ...baseOpts(repo, aiDir), allowDirty: true }), /caps\.day_share is missing/);
  assert.throws(() => R.rulesFromConfig({ ...config, memory: { ...config.memory, retrieve: { top: 8 } } }), /retrieve\.newest/);
  assert.throws(() => R.prepareCommitments({ ...baseOpts(repo, aiDir), deck: 'deck-x', allowDirty: true }), /expected deck-<k>/);
});

test('a seat script and a given llama directory are committed; the llama tree hash follows the files', () => {
  const repo = makeRepo();
  const aiDir = path.join(tmp, 'run-c');
  const llama = path.join(tmp, 'llama-tree');
  write(path.join(llama, 'bin', 'llama-server'), 'binary-a');
  write(path.join(llama, 'lib', 'x.dylib'), 'lib');
  fs.symlinkSync('x.dylib', path.join(llama, 'lib', 'y.dylib'));
  fs.symlinkSync('nowhere', path.join(llama, 'lib', 'broken.dylib'));
  const seat = path.join(tmp, 'seat-script.json');
  write(seat, '{"move":1}');
  const p = R.prepareCommitments({ ...baseOpts(repo, aiDir), seatScriptPath: seat, llama: { dir: llama } });
  assert.equal(p.obj.configs.seat_script_sha256, R.sha256hex('{"move":1}'));
  const t1 = p.obj.server.tree_sha256;
  assert.match(t1, /^[0-9a-f]{64}$/);
  assert.equal(t1, R.treeSha256Dir(llama));
  write(path.join(llama, 'bin', 'llama-server'), 'binary-b');
  assert.notEqual(R.treeSha256Dir(llama), t1);
});

// ------------------------------------------------------------------ the memo transaction
test('the memo transaction: one SPL Memo instruction with the text, signed by the registrar, the registrar is the fee payer', () => {
  const kp = Keypair.generate();
  const bh = Keypair.generate().publicKey.toBase58();
  const wire = R.memoTransaction(kp, 'wylls-ai/1 31 402 aa bb', bh);
  const tx = Transaction.from(wire);
  assert.ok(tx.verifySignatures());
  assert.equal(tx.feePayer.toBase58(), kp.publicKey.toBase58());
  assert.equal(tx.recentBlockhash, bh);
  assert.equal(tx.instructions.length, 1);
  assert.equal(tx.instructions[0].programId.toBase58(), R.MEMO_PROGRAM_ID);
  assert.equal(tx.instructions[0].data.toString('utf8'), 'wylls-ai/1 31 402 aa bb');
  assert.equal(tx.instructions[0].keys.length, 1);
  assert.ok(tx.instructions[0].keys[0].isSigner);
  assert.throws(() => R.memoTransaction(kp, 'x'.repeat(600), bh), /longer/);
  assert.equal(R.anchorMemoText(31, 402, 'a'.repeat(64), 'b'.repeat(64)), `wylls-ai/1 31 402 ${'a'.repeat(64)} ${'b'.repeat(64)}`);
});

// ------------------------------------------------------------------ fake chain and fake herald
/** JSON-RPC like frontier-localnet's subset; every sent transaction is decoded and kept. */
function fakeChain({ g0 = G0, blockTime = G0 + 5, failSend = () => false } = {}) {
  const st = { calls: [], sent: [], balances: new Map(), blockTime, slot: 100, g0 };
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const { id, method, params } = JSON.parse(Buffer.concat(chunks));
      st.calls.push(method);
      const ok = result => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id, result })); };
      const err = message => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } })); };
      if (method === 'getHealth') return ok('ok');
      if (method === 'getGenesisHash') return ok(R.localnetGenesisHash(st.g0));
      if (method === 'getBalance') return ok({ context: { slot: st.slot }, value: st.balances.get(params[0]) ?? 0 });
      if (method === 'requestAirdrop') { st.balances.set(params[0], (st.balances.get(params[0]) ?? 0) + params[1]); return ok('airdropsig'); }
      if (method === 'getLatestBlockhash') return ok({ context: { slot: st.slot }, value: { blockhash: bs58.encode(Buffer.alloc(32, 7)), lastValidBlockHeight: 150 } });
      if (method === 'sendTransaction') {
        if (failSend(st)) return err('Transaction simulation failed: injected');
        const tx = Transaction.from(Buffer.from(params[0], 'base64'));
        const sig = bs58.encode(tx.signature);
        st.sent.push({ sig, tx, text: tx.instructions[0].data.toString('utf8'), slot: ++st.slot, valid: tx.verifySignatures() });
        return ok(sig);
      }
      if (method === 'getSignatureStatuses') return ok({ context: { slot: st.slot }, value: params[0].map(s => { const x = st.sent.find(y => y.sig === s); return x ? { slot: x.slot, confirmations: null, err: null, confirmationStatus: 'finalized' } : null; }) });
      if (method === 'getTransaction') { const x = st.sent.find(y => y.sig === params[0]); return ok(x ? { slot: x.slot, blockTime: st.blockTime } : null); }
      return err(`unsupported ${method}`);
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, st, url: `http://127.0.0.1:${srv.address().port}` })));
}
function fakeHerald({ cluster = 'localnet', genesisTs = G0 + 86_400, seed = 'ab'.repeat(32), events } = {}) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push(req.url);
    const j = o => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/h/season') return j({ cluster, genesisTs, programId: '9U2LmkyRveBwApBMRrx5SjBMwPFTdciS2xPaL3J1YHb7', season: '31' });
    if (req.url.startsWith('/h/events')) {
      const after = Number(new URL(req.url, 'http://x').searchParams.get('after'));
      const all = events ?? [{ seq: '1', kind: 1, decoded: { name: 'ANNOUNCE' } }, { seq: '2', kind: 2, decoded: { name: 'SEASON_CREATED' } }, { seq: '3', kind: 3, decoded: { name: 'GENESIS_SEED', payload: { round: '32094119', seed } } }];
      const page = all.slice(after, after + 2);
      return j({ v: 1, events: page, next: String(after + page.length), full: after + 2 >= all.length });
    }
    res.writeHead(404); res.end('{}');
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, hits, url: `http://127.0.0.1:${srv.address().port}` })));
}
const closeAll = (...s) => Promise.all(s.map(x => new Promise(r => { x.closeAllConnections?.(); x.close(r); })));

test('the commit anchor: health, localnet check, airdrop, memo `wylls-ai/1 commit <season> <sha>`, and the verdict from the memo\'s block time against genesis_ts', async () => {
  const chain = await fakeChain({ blockTime: G0 + 5 });
  const herald = await fakeHerald({ genesisTs: G0 + 86_400 });
  try {
    const aiDir = path.join(tmp, 'run-d');
    const kp = R.loadOrCreateKey(path.join(aiDir, 'keys', 'registrar.json'), aiDir);
    const sha = R.sha256hex('commitments');
    const r = await R.anchorCommit({ aiDir, kp, rpc: new R.Rpc(chain.url), g0: G0, sha, season: 31, herald: herald.url });
    assert.equal(r.status, 'audited');
    assert.deepEqual(chain.st.calls.slice(0, 3), ['getHealth', 'getGenesisHash', 'getBalance']);
    assert.ok(chain.st.calls.includes('requestAirdrop'));
    assert.equal(chain.st.sent.length, 1);
    assert.equal(chain.st.sent[0].text, `wylls-ai/1 commit 31 ${sha}`);
    assert.ok(chain.st.sent[0].valid);
    const rec = JSON.parse(read(path.join(aiDir, 'pub', 'anchors', 'commit.json')));
    assert.equal(rec.status, 'audited');
    assert.equal(rec.commitments_sha256, sha);
    assert.equal(rec.block_time, G0 + 5);
    assert.equal(rec.genesis_ts, G0 + 86_400);
    assert.equal(rec.signature, chain.st.sent[0].sig);
    assert.equal(rec.slot, chain.st.sent[0].slot);
    assert.deepEqual(findKeyLikeFiles(path.join(aiDir, 'pub')), []);
  } finally { await closeAll(chain.srv, herald.srv); }
});

test('a memo that is not before genesis labels the run unaudited with the reason; no herald yet is unaudited too', async () => {
  const chain = await fakeChain({ blockTime: G0 + 90_000 });
  const herald = await fakeHerald({ genesisTs: G0 + 86_400 });
  try {
    const aiDir = path.join(tmp, 'run-e');
    const kp = R.loadOrCreateKey(path.join(aiDir, 'keys', 'registrar.json'), aiDir);
    const r = await R.anchorCommit({ aiDir, kp, rpc: new R.Rpc(chain.url), g0: G0, sha: 'aa'.repeat(32), season: 31, herald: herald.url });
    assert.equal(r.status, 'unaudited');
    assert.match(r.record.reason, /not before genesis/);
    const aiDir2 = path.join(tmp, 'run-e2');
    const r2 = await R.anchorCommit({ aiDir: aiDir2, kp, rpc: new R.Rpc(chain.url), g0: G0, sha: 'bb'.repeat(32), season: 31 });
    assert.equal(r2.status, 'unaudited');
    assert.equal(JSON.parse(read(path.join(aiDir2, 'pub', 'anchors', 'commit.json'))).status, 'unaudited');
  } finally { await closeAll(chain.srv, herald.srv); }
});

test('not the local test chain: a wrong genesis hash or a herald cluster other than localnet is refused before any memo', async () => {
  const chain = await fakeChain({ g0: G0 + 1 });
  const herald = await fakeHerald({ cluster: 'other' });
  try {
    const aiDir = path.join(tmp, 'run-f');
    const kp = R.loadOrCreateKey(path.join(aiDir, 'keys', 'registrar.json'), aiDir);
    await assert.rejects(R.anchorCommit({ aiDir, kp, rpc: new R.Rpc(chain.url), g0: G0, sha: 'aa'.repeat(32), season: 31 }), /genesis hash .* is not the local test chain/);
    assert.equal(chain.st.sent.length, 0);
    assert.ok(!chain.st.calls.includes('requestAirdrop'));
    await assert.rejects(R.assertHeraldLocalnet(herald.url), /not localnet/);
    chain.st.g0 = G0;
    await assert.rejects(R.anchorCommit({ aiDir, kp, rpc: new R.Rpc(chain.url), g0: G0, sha: 'aa'.repeat(32), season: 31, herald: herald.url }), /not localnet/);
    assert.throws(() => new R.Rpc('http://203.0.113.5:41910'), /loopback/);
    await assert.rejects(R.assertHeraldLocalnet('http://example.com:41940'), /loopback/);
  } finally { await closeAll(chain.srv, herald.srv); }
});

// ------------------------------------------------------------------ per-bell anchors
const social = n => n.toString(16).padStart(64, '1');
const minds = n => n.toString(16).padStart(64, '2');
function writeBell(aiDir, b, { talk = true, mindsToo = true } = {}) {
  if (talk) write(path.join(aiDir, 'pub', 'talk', `${b}.json`), JSON.stringify({ bell: b, root: social(b), records: [] }));
  if (mindsToo) write(path.join(aiDir, 'pub', 'minds', `${b}.json`), JSON.stringify({ bell: b, root: minds(b), records: [] }));
}

test('anchors: one memo per closed bell (oldest first, only when both roots exist), the anchor file, and nothing is sent twice', async () => {
  const chain = await fakeChain();
  try {
    const aiDir = path.join(tmp, 'run-g');
    const kp = R.loadOrCreateKey(path.join(aiDir, 'keys', 'registrar.json'), aiDir);
    writeBell(aiDir, 401); writeBell(aiDir, 402); writeBell(aiDir, 403, { mindsToo: false });
    const rpc = new R.Rpc(chain.url);
    const r = await R.anchorPass({ aiDir, kp, rpc, season: 31 });
    assert.deepEqual(r, { anchored: [401, 402], gaps: [] });
    assert.deepEqual(chain.st.sent.map(s => s.text), [`wylls-ai/1 31 401 ${social(401)} ${minds(401)}`, `wylls-ai/1 31 402 ${social(402)} ${minds(402)}`]);
    const a = JSON.parse(read(path.join(aiDir, 'pub', 'anchors', '402.json')));
    assert.deepEqual(Object.keys(a).sort(), ['bell', 'minds_root', 'signature', 'slot', 'social_root']);
    assert.equal(a.bell, 402);
    assert.equal(a.social_root, social(402));
    assert.equal(a.signature, chain.st.sent[1].sig);
    assert.equal(a.slot, chain.st.sent[1].slot);
    assert.deepEqual(await R.anchorPass({ aiDir, kp, rpc, season: 31 }), { anchored: [], gaps: [] }, 'idempotent');
    assert.equal(chain.st.sent.length, 2);
    writeBell(aiDir, 403, { talk: false });
    assert.deepEqual((await R.anchorPass({ aiDir, kp, rpc, season: 31 })).anchored, [403]);
    // An empty bell is 32 zero bytes.
    write(path.join(aiDir, 'pub', 'talk', '404.json'), JSON.stringify({ bell: 404, records: [] }));
    write(path.join(aiDir, 'pub', 'minds', '404.json'), JSON.stringify({ bell: 404, records: [] }));
    await R.anchorPass({ aiDir, kp, rpc, season: 31 });
    assert.equal(JSON.parse(read(path.join(aiDir, 'pub', 'anchors', '404.json'))).social_root, R.ZERO_ROOT);
    assert.deepEqual(findKeyLikeFiles(path.join(aiDir, 'pub')), []);
  } finally { await closeAll(chain.srv); }
});

test('a bell with a talk file but no minds file becomes an anchor_gap once 3 later bells have closed (it was skipped forever before)', async () => {
  const chain = await fakeChain();
  try {
    const aiDir = path.join(tmp, 'run-hm');
    const kp = R.loadOrCreateKey(path.join(aiDir, 'keys', 'registrar.json'), aiDir);
    const rpc = new R.Rpc(chain.url);
    writeBell(aiDir, 20, { mindsToo: false });
    writeBell(aiDir, 21); writeBell(aiDir, 22);
    let r = await R.anchorPass({ aiDir, kp, rpc, season: 31 });
    assert.deepEqual(r.gaps, [], 'recent: the minds file may still come');
    assert.deepEqual(r.anchored, [21, 22]);
    writeBell(aiDir, 23);
    r = await R.anchorPass({ aiDir, kp, rpc, season: 31 });
    assert.deepEqual(r.gaps, [20]);
    const gap = JSON.parse(read(path.join(aiDir, 'pub', 'anchors', '20.json')));
    assert.deepEqual([gap.anchor_gap, gap.signature, gap.minds_root, gap.reason], [true, null, null, 'minds file missing']);
    assert.equal(gap.social_root, social(20));
    assert.deepEqual((await R.anchorPass({ aiDir, kp, rpc, season: 31 })).gaps, [], 'written once');
  } finally { await closeAll(chain.srv); }
});

test('a memo that cannot be sent is retried and becomes an anchor_gap once 3 later bells have closed; order is kept', async () => {
  let failing = true;
  const chain = await fakeChain({ failSend: () => failing });
  try {
    const aiDir = path.join(tmp, 'run-h');
    const kp = R.loadOrCreateKey(path.join(aiDir, 'keys', 'registrar.json'), aiDir);
    const rpc = new R.Rpc(chain.url);
    const state = { failed: new Map() };
    writeBell(aiDir, 10);
    let r = await R.anchorPass({ aiDir, kp, rpc, season: 31, state });
    assert.deepEqual(r, { anchored: [], gaps: [] });
    assert.ok(!fs.existsSync(path.join(aiDir, 'pub', 'anchors', '10.json')), 'not final yet: no file to cache');
    writeBell(aiDir, 11); writeBell(aiDir, 12);
    r = await R.anchorPass({ aiDir, kp, rpc, season: 31, state });
    assert.deepEqual(r, { anchored: [], gaps: [] });
    writeBell(aiDir, 13);
    r = await R.anchorPass({ aiDir, kp, rpc, season: 31, state });
    assert.deepEqual(r, { anchored: [], gaps: [10] });
    const gap = JSON.parse(read(path.join(aiDir, 'pub', 'anchors', '10.json')));
    assert.equal(gap.anchor_gap, true);
    assert.equal(gap.signature, null);
    assert.match(gap.reason, /injected/);
    assert.equal(gap.social_root, social(10));
    failing = false;
    r = await R.anchorPass({ aiDir, kp, rpc, season: 31, state });
    assert.deepEqual(r.anchored, [11, 12, 13], 'the later bells go out in order once the chain answers');
    assert.deepEqual(chain.st.sent.map(s => s.text.split(' ')[2]), ['11', '12', '13']);
    const idx = R.publishSeasonEnd({ aiDir, kp, season: 31, commitmentsSha: 'cc'.repeat(32) });
    assert.deepEqual(idx.anchored, [11, 12, 13]);
    assert.deepEqual(idx.gaps, [10]);
    assert.equal(idx.first_bell, 10);
    assert.equal(idx.last_bell, 13);
    assert.ok(R.verifySigned(idx, kp.publicKey.toBase58()));
    assert.equal(JSON.parse(read(path.join(aiDir, 'state', 'season-end.json'))).last_bell, 13);
    assert.ok(!fs.existsSync(path.join(aiDir, 'pub', 'season-end.json')), 'the trigger is private (STATE), not evidence');
  } finally { await closeAll(chain.srv); }
});

// ------------------------------------------------------------------ the deal and the roster
test('GENESIS_SEED is found across pages of /h/events; a season before genesis is an error', async () => {
  const h = await fakeHerald({ seed: '12'.repeat(32) });
  const h2 = await fakeHerald({ events: [{ seq: '1', kind: 1, decoded: { name: 'ANNOUNCE' } }] });
  try {
    assert.deepEqual(await R.readGenesisSeed(h.url), { round: '32094119', seed: '12'.repeat(32) });
    assert.ok(h.hits.filter(u => u.startsWith('/h/events')).length >= 2, 'paged');
    await assert.rejects(R.readGenesisSeed(h2.url), /no GENESIS_SEED/);
  } finally { await closeAll(h.srv, h2.srv); }
});

test('the roster: AI entries from the deal with wallet, tag, label; the script bots\' wallets; the seat; signed; the seat is scripted only when the commitments name a script', () => {
  const repo = makeRepo();
  const aiDir = path.join(tmp, 'run-i');
  const seatScript = path.join(tmp, 'seat-script-2.json');
  write(seatScript, '{"m":1}');
  const p = R.prepareCommitments({ ...baseOpts(repo, aiDir), seatScriptPath: seatScript });
  const calls = [];
  const deps = {
    deck: ['avenger', 'diplomat'], library: { avenger: { ambition: 'Avenger' }, diplomat: { ambition: 'Diplomat' } }, botSeed: 31, scriptCount: 5,
    deal: (seed32, deck, slots) => { calls.push({ seed32, deck, slots }); return slots.map((s, i) => ({ index: s.index, persona: deck[i % 2], creed_variant: i % 6, temperament: { aggression: 50 } })); },
    tagOf: (programId, seasonId, wallet) => { const t = citizenTag(seasonAddresses(programId, seasonId).of('Citizen', { wallet })); return t.toString(16).padStart(16, '0'); },
    nameOf: tag => ({ en: `N-${tag.slice(0, 4)}`, ja: `名-${tag.slice(0, 4)}` }),
  };
  const season = { programId: '9U2LmkyRveBwApBMRrx5SjBMwPFTdciS2xPaL3J1YHb7', season: '31' };
  const genesis = { round: '32094119', seed: 'cd'.repeat(32) };
  const roster = R.buildRoster({ commitments: p.obj, commitmentsSha: p.sha256, season, genesis, deps, kp: p.kp });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].seed32.toString('hex'), 'cd'.repeat(32));
  assert.equal(calls[0].slots.length, 12);
  assert.deepEqual(calls[0].slots[0], { index: 1000, faction: 0, kind: 'ai' });
  assert.equal(roster.v, 1);
  assert.equal(roster.season, 31);
  assert.equal(roster.program_id, season.programId);
  assert.equal(roster.genesis_round, '32094119');
  assert.equal(roster.genesis_seed, genesis.seed);
  assert.equal(roster.deck, 'deck-2');
  assert.equal(roster.commitments_sha256, p.sha256);
  assert.equal(roster.ai.length, 12);
  assert.deepEqual(Object.keys(roster.ai[0]).sort(), ['ambition', 'creed_variant', 'faction', 'index', 'kind', 'label', 'name', 'persona', 'tag', 'temperament', 'wallet']);
  assert.equal(roster.ai[0].kind, 'ai');
  assert.equal(roster.ai[0].label, 'AI citizen, Gemma 4 local');
  assert.equal(roster.ai[0].ambition, 'Avenger');
  assert.equal(roster.ai[0].wallet, R.walletOf(31, 1000).b58);
  assert.match(roster.ai[0].tag, /^[0-9a-f]{16}$/);
  assert.equal(roster.script.count, 5);
  assert.equal(roster.script.wallets.length, 5);
  assert.equal(roster.script.wallets[2], R.walletOf(31, 2).b58);
  assert.equal(roster.script.label, 'script bot: not AI, not human');
  assert.equal(roster.script.kind, 'script');
  assert.equal(roster.seat.index, 1012);
  assert.equal(roster.seat.kind, 'seat');
  assert.equal(roster.seat.label, 'Presenter (operator, human)');
  assert.equal(roster.seat.scripted, true);
  assert.ok(R.verifySigned(roster, p.kp.publicKey.toBase58()));
  const noScript = R.buildRoster({ commitments: { ...p.obj, configs: { ...p.obj.configs, seat_script_sha256: null } }, commitmentsSha: p.sha256, season, genesis, deps, kp: p.kp });
  assert.equal(noScript.seat.scripted, false);
  assert.throws(() => R.buildRoster({ commitments: p.obj, commitmentsSha: p.sha256, season, genesis, deps: { ...deps, deal: () => [] }, kp: p.kp }), /nothing for slot 1000/);
  const t = JSON.parse(JSON.stringify(roster));
  t.ai[3].persona = 'conqueror';
  assert.ok(!R.verifySigned(t, p.kp.publicKey.toBase58()));
});


test('main run and publish refuse a chain whose genesis hash is not the local test chain\'s when --stack names the config (no airdrop, no memo)', async () => {
  const chain = await fakeChain({ g0: G0 + 7 });
  const repo = makeRepo();
  const aiDir = path.join(tmp, 'run-k');
  const p = R.prepareCommitments(baseOpts(repo, aiDir));
  void p;
  const cap = { out: () => {}, log: () => {} };
  try {
    const args = ['--ai-dir', aiDir, '--key', path.join(aiDir, 'keys', 'registrar.json'), '--rpc', chain.url, '--stack', path.join(repo.root, 'stack.toml')];
    await assert.rejects(R.main(['run', ...args, '--until-bell', '0'], cap), /genesis hash .* is not the local test chain/);
    const herald = await fakeHerald();
    try { await assert.rejects(R.main(['publish', ...args, '--herald', herald.url], cap), /genesis hash .* is not the local test chain/); } finally { await closeAll(herald.srv); }
    assert.equal(chain.st.sent.length, 0);
    assert.ok(!chain.st.calls.includes('requestAirdrop'));
  } finally { await closeAll(chain.srv); }
});

test('PUB holds no key after a whole run\'s writers (commitments, commit anchor, bell anchors, roster, index, RUNS), and the detector does find the real key file in KEYS', async () => {
  const chain = await fakeChain();
  const herald = await fakeHerald();
  try {
    const repo = makeRepo();
    const aiDir = path.join(tmp, 'run-l');
    const p = R.prepareCommitments(baseOpts(repo, aiDir));
    await R.anchorCommit({ aiDir, kp: p.kp, rpc: new R.Rpc(chain.url), g0: G0, sha: p.sha256, season: 31, herald: herald.url });
    writeBell(aiDir, 1); writeBell(aiDir, 2);
    await R.anchorPass({ aiDir, kp: p.kp, rpc: new R.Rpc(chain.url), season: 31 });
    R.publishSeasonEnd({ aiDir, kp: p.kp, season: 31, commitmentsSha: p.sha256 });
    const deps = { deck: ['avenger', 'diplomat'], library: {}, botSeed: 31, scriptCount: 2, deal: (s, d, slots) => slots.map(x => ({ index: x.index, persona: 'avenger', creed_variant: 0, temperament: {} })), tagOf: () => '00'.repeat(8), nameOf: () => ({ en: 'x', ja: 'y' }) };
    const roster = R.buildRoster({ commitments: p.obj, commitmentsSha: p.sha256, season: { programId: 'p', season: '31' }, genesis: { round: '1', seed: 'aa'.repeat(32) }, deps, kp: p.kp });
    write(path.join(aiDir, 'pub', 'roster.json'), JSON.stringify(roster));
    const files = [];
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => (e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.join(d, e.name))));
    walk(path.join(aiDir, 'pub'));
    assert.ok(files.length >= 8, files.join(' '));
    assert.deepEqual(findKeyLikeFiles(path.join(aiDir, 'pub')), []);
    // The key text itself appears nowhere in PUB, in any encoding the key file uses.
    const secret = JSON.parse(read(path.join(aiDir, 'keys', 'registrar.json')));
    const b58secret = bs58.encode(Buffer.from(secret));
    for (const f of files) { const t = read(f); assert.ok(!t.includes(b58secret) && !t.includes(JSON.stringify(secret)), f); }
    // Positive control: the detector flags the real key file.
    assert.deepEqual(findKeyLikeFiles(path.join(aiDir, 'keys')).map(f => path.basename(f)), ['registrar.json']);
  } finally { await closeAll(chain.srv, herald.srv); }
});

// ------------------------------------------------------------------ RUNS.md
test('RUNS.md: a header once, a block per run before genesis, END lines at the end, aborted runs stay listed; the parser reads it back', () => {
  const file = path.join(tmp, 'docs', 'RUNS.md');
  const cfgs = { stack_toml_sha256: 'aa', slots_sha256: 'bb' };
  R.appendRunLine(file, R.formatRunBlock({ run_id: 'ai-smoke-1', start_unix: 1_790_000_000, commitments_sha256: 'cc', configs: cfgs }));
  R.appendRunLine(file, R.formatRunBlock({ run_id: 'ai-ab-A-1', start_unix: 1_790_100_000, commitments_sha256: 'dd', configs: cfgs, arm: 'A', rep: 1 }));
  R.appendRunLine(file, R.formatRunBlock({ run_id: 'ai-main', start_unix: 1_790_200_000, commitments_sha256: 'ee', configs: cfgs }));
  R.appendRunLine(file, R.formatRunEnd({ run_id: 'ai-smoke-1', end_unix: 1_790_003_000, status: 'complete', detail: 'unaudited' }));
  R.appendRunLine(file, R.formatRunEnd({ run_id: 'ai-ab-A-1', end_unix: 1_790_105_000, status: 'aborted', detail: 'llama died' }));
  const text = read(file);
  assert.equal(text.split('# Wylls AI runs').length, 2, 'one header');
  assert.match(text, /## ai-smoke-1 — 2026-09-2\dT/);
  assert.match(text, /## ai-ab-A-1 — .* — arm A rep 1/);
  const runs = R.parseRunsMd(text);
  assert.deepEqual(runs.map(r => r.run_id), ['ai-smoke-1', 'ai-ab-A-1', 'ai-main']);
  assert.equal(runs[0].end.status, 'complete');
  assert.equal(runs[1].arm, 'A');
  assert.equal(runs[1].rep, 1);
  assert.equal(runs[1].end.status, 'aborted');
  assert.equal(runs[2].end, null, 'a run with no END line is aborted or still running');
  assert.equal(runs[2].commitments_sha256, 'ee');
  assert.deepEqual(runs[2].configs, cfgs);
  assert.equal(runs[2].arm, null);
  // A file that lacks its final newline still takes the next block on a new line.
  fs.appendFileSync(file, 'tail without newline');
  R.appendRunLine(file, R.formatRunBlock({ run_id: 'x', start_unix: 1_790_300_000, commitments_sha256: 'ff', configs: cfgs }));
  assert.equal(R.parseRunsMd(read(file)).at(-1).run_id, 'x');
});

// ------------------------------------------------------------------ the command line
test('main: slots, commit --prepare-only, runs-add and runs-end; unknown commands and missing flags are errors', async () => {
  const repo = makeRepo();
  const aiDir = path.join(tmp, 'run-j');
  const out = [];
  const cap = { out: m => out.push(m), log: () => {} };
  assert.equal(await R.main(['slots', '--stack', path.join(repo.root, 'stack.toml'), '--n', '12', '--out', path.join(aiDir, 'ai-slots.json')], cap), 0);
  assert.deepEqual(JSON.parse(read(path.join(aiDir, 'ai-slots.json'))), R.makeSlots({ seed: 31, n: 12 }));
  await assert.rejects(R.main(['slots', '--stack', path.join(repo.root, 'stack.toml'), '--n', '9', '--out', path.join(aiDir, 'x.json')], cap), /6 \(deck-1\)/);
  // commit needs the real repository for `git`: run it against the temp repo through the module API, the CLI against REPO_ROOT is exercised by the run script.
  const p = R.prepareCommitments(baseOpts(repo, aiDir));
  const file = path.join(tmp, 'docs2', 'RUNS.md');
  assert.equal(await R.main(['runs-add', '--run-id', 'cli-1', '--commitments', p.file, '--file', file, '--arm', 'B', '--rep', '2'], cap), 0);
  assert.equal(await R.main(['runs-end', '--run-id', 'cli-1', '--status', 'complete', '--file', file], cap), 0);
  const [run] = R.parseRunsMd(read(file));
  assert.equal(run.run_id, 'cli-1');
  assert.equal(run.commitments_sha256, p.sha256);
  assert.equal(run.arm, 'B');
  assert.equal(run.rep, 2);
  assert.equal(run.end.status, 'complete');
  await assert.rejects(R.main(['bogus'], cap), /unknown command/);
  await assert.rejects(R.main(['run', '--ai-dir', aiDir], cap), /--key is required/);
  await assert.rejects(R.main(['run', '--ai-dir', aiDir, '--key', path.join(aiDir, 'keys', 'registrar.json'), '--rpc', 'http://203.0.113.5:41910'], cap), /loopback/);
  await assert.rejects(R.main(['deal', '--ai-dir', aiDir, '--key', path.join(aiDir, 'keys', 'registrar.json'), '--herald', 'http://example.com:41940', '--stack', path.join(repo.root, 'stack.toml')], cap), /loopback/);
});

test('the registrar source holds no outside URL, no paid-API name and no public-network word (the G10 grep, outside bin/)', () => {
  const src = read(new URL('../citizens/registrar.mjs', import.meta.url).pathname);
  assert.doesNotMatch(src, /anthropic|openai|devnet|https?:\/\/(?!127\.0\.0\.1|\[::1\]|localhost)/i);
});

// ------------------------------------------------------------------ the two code hashes that were vacuous or double-defined (integ-A review)
test('episode_kinds_sha256 commits to the episode KINDS (the real templates file lists exactly memory/config.mjs KINDS) and moves when a kind is added', async () => {
  const { KINDS } = await import('../citizens/memory/config.mjs');
  const real = new URL('../citizens/memory/templates.en.json', import.meta.url).pathname;
  assert.equal(R.episodeKindsSha256(real), R.sha256hex(R.canonicalJson([...KINDS].sort())), 'the template kinds are the KINDS');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinds-'));
  const f = path.join(dir, 't.json');
  fs.writeFileSync(f, JSON.stringify({ kinds: { a: 'x', b: 'y' } }));
  const h2 = R.episodeKindsSha256(f);
  fs.writeFileSync(f, JSON.stringify({ kinds: { a: 'x', b: 'y', c: 'z' } }));
  assert.notEqual(R.episodeKindsSha256(f), h2, 'adding a kind changes the hash (the top-level-keys version was a constant)');
  fs.writeFileSync(f, JSON.stringify({ kinds: { b: 'q', a: 'p' } }));
  assert.equal(R.episodeKindsSha256(f), h2, 'order and texts do not matter, only the kinds');
  fs.writeFileSync(f, JSON.stringify({ a: 1 }));
  assert.equal(R.episodeKindsSha256(f), null, 'no `kinds`: null, visible');
});

test('prompt_templates_sha256 has one definition: the registrar\'s commitment equals what the mind computes for the real prompts directory', async () => {
  const { loadTemplates, promptTemplatesSha256 } = await import('../citizens/mind/prompt.mjs');
  const dir = new URL('../citizens/prompts', import.meta.url).pathname;
  assert.equal(loadTemplates(dir).sha256, promptTemplatesSha256(dir));
  assert.equal(R.filesSha256(dir, '.txt'), promptTemplatesSha256(dir));
  // a changed template changes it
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-'));
  fs.writeFileSync(path.join(d2, 'a.txt'), 'one\n');
  const h = promptTemplatesSha256(d2);
  fs.writeFileSync(path.join(d2, 'a.txt'), 'two\n');
  assert.notEqual(promptTemplatesSha256(d2), h);
});
