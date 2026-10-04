// FB1 (fix unit of integ-B; findings A1 and A2 of the integ-B review): the per-bell anchors of citizens/registrar.mjs and the end of
// a run. Every test here was written to FAIL on the code of frontier/ai-integ 0cc0973 (see docs/frontier/ai-citizens/FB1-NOTES.md for the
// recorded failing run); fake JSON-RPC doubles and fake servers on 127.0.0.1:0, no chain, no model.
//
//   A1  a signature that was sent is never lost and never sent again: carried into the retry's own claim before anything is sent,
//       polled (bounded) while it is the bell's only memo, a retry that throws before the signature callback keeps it, a later pass
//       with an advanced blockhash sends nothing; a signature that FAILED on the chain is the one case that frees the bell.
//   A2  the end of the run: a bell that is half closed (talk file, no minds file yet) is waited for (bounded) and anchored; every
//       closed bell without an anchor gets an anchor_gap at publish; nothing is sent to a paused chain; the report counts closed bells
//       against anchored bells, gaps and bells closed after the season-end index.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Keypair, Transaction } from '@solana/web3.js';
import * as R from '../citizens/registrar.mjs';
import * as REP from '../citizens/report.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-fb1-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const write = (p, data) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };
const read = p => fs.readFileSync(p, 'utf8');
const readJ = p => JSON.parse(read(p));
const social = b => String(b).padStart(2, '0').repeat(32).slice(0, 64);
function writeBell(aiDir, bell, { talk = true, minds = true } = {}) {
  if (talk) write(path.join(aiDir, 'pub', 'talk', `${bell}.json`), JSON.stringify({ bell, root: social(bell), records: [] }));
  if (minds) write(path.join(aiDir, 'pub', 'minds', `${bell}.json`), JSON.stringify({ bell, root: social(bell + 1), records: [] }));
}
const newDir = tag => fs.mkdtempSync(path.join(tmp, `${tag}-`));
function deadPid() { const r = spawnSync(process.execPath, ['-e', '']); return r.pid; }
const FAST = { memoTries: 2, memoIntervalMs: 1, pollTries: 2, pollIntervalMs: 1 };
const quiet = () => {};

/** An in-memory chain that counts every sendTransaction. `landOnSend`: a sent memo has its status at once. */
function chainDouble({ landOnSend = false } = {}) {
  const c = { sent: [], statuses: new Map(), n: 0, calls: [], failBlockhash: false, landOnSend, paused: false, heard: [] };
  c.call = async (method, params = []) => {
    c.calls.push(method);
    if (method === 'getLatestBlockhash') {
      if (c.failBlockhash) throw new Error('rpc down before the signature exists');
      return { value: { blockhash: Keypair.generate().publicKey.toBase58() } }; // every call: an advanced blockhash, so a re-sent memo is a NEW transaction
    }
    if (method === 'sendTransaction') {
      const tx = Transaction.from(Buffer.from(params[0], 'base64'));
      const sig = `SIG${++c.n}`;
      c.sent.push({ sig, text: Buffer.from(tx.instructions[0].data).toString('utf8') });
      if (c.landOnSend) c.statuses.set(sig, { slot: 100 + c.n, err: null });
      return sig;
    }
    if (method === 'getSignatureStatuses') return { value: params[0].map(s => c.statuses.get(s) ?? null) };
    if (method === 'getTransaction') return { blockTime: 1_790_000_000 };
    if (method === 'frontier_status') return { paused: c.paused };
    throw new Error(`unexpected ${method}`);
  };
  return c;
}

// ------------------------------------------------------------------ A1
test('A1: after a second in-process failure the sent signature is kept; a third pass with an advanced blockhash sends NOTHING; the signature then lands and anchors the bell', async () => {
  const aiDir = newDir('a1');
  writeBell(aiDir, 40);
  const kp = Keypair.generate();
  const chain = chainDouble();
  const state = { failed: new Map() };
  const pass = () => R.anchorPass({ aiDir, kp, rpc: chain, season: 31, state, log: quiet, ...FAST });
  // pass 1: the memo is sent (SIG1) and its status never comes
  assert.deepEqual(await pass(), { anchored: [], gaps: [] });
  assert.equal(chain.sent.length, 1);
  assert.equal(readJ(R.anchorClaimFile(aiDir, 40)).signature, 'SIG1', 'the claim keeps the signature of the memo that was sent');
  // pass 2 (same process: it takes over its own claim): the retry fails before it has a signature of its own
  chain.failBlockhash = true;
  assert.deepEqual(await pass(), { anchored: [], gaps: [] });
  assert.ok(fs.existsSync(R.anchorClaimFile(aiDir, 40)), 'the claim must not be released while a signature was sent (old code released it here and lost SIG1)');
  assert.equal(readJ(R.anchorClaimFile(aiDir, 40)).signature, 'SIG1', 'the signature is carried into the retry\'s own claim');
  // pass 3: the chain answers again, the blockhash has advanced: a new memo would be a second memo for the bell
  chain.failBlockhash = false;
  assert.deepEqual(await pass(), { anchored: [], gaps: [] });
  assert.equal(chain.sent.length, 1, 'sendTransaction was called once in three passes (old code sent a second memo in pass 3)');
  // the first memo lands at last: the bell is anchored from it, and still only one memo exists
  chain.statuses.set('SIG1', { slot: 77, err: null });
  assert.deepEqual((await pass()).anchored, [40]);
  assert.equal(chain.sent.length, 1);
  const a = readJ(path.join(aiDir, 'pub', 'anchors', '40.json'));
  assert.deepEqual([a.signature, a.slot, a.social_root, a.minds_root], ['SIG1', 77, social(40), social(41)]);
});

test('A1: a dead process\'s unlanded signature is carried into the taker\'s claim and polled; nothing is sent while it may still land; it becomes a gap with the signature in the reason after 3 later bells', async () => {
  const aiDir = newDir('a1d');
  writeBell(aiDir, 50);
  write(R.anchorClaimFile(aiDir, 50), JSON.stringify({ pid: deadPid(), bell: 50, started: 't', signature: 'SIGX' }));
  const kp = Keypair.generate();
  const chain = chainDouble();
  const state = { failed: new Map() };
  const pass = () => R.anchorPass({ aiDir, kp, rpc: chain, season: 31, state, log: quiet, ...FAST });
  assert.deepEqual(await pass(), { anchored: [], gaps: [] });
  assert.equal(chain.sent.length, 0, 'the earlier signature has no status yet: no new memo (old code sent one)');
  const claim = readJ(R.anchorClaimFile(aiDir, 50));
  assert.deepEqual([claim.pid, claim.signature], [process.pid, 'SIGX'], 'the claim is ours now and still carries SIGX');
  writeBell(aiDir, 51); writeBell(aiDir, 52);
  assert.deepEqual((await pass()).gaps, [], 'not yet 3 later bells');
  assert.equal(chain.sent.length, 0);
  writeBell(aiDir, 53);
  const r = await pass();
  assert.deepEqual(r.gaps, [50]);
  const gap = readJ(path.join(aiDir, 'pub', 'anchors', '50.json'));
  assert.equal(gap.anchor_gap, true);
  assert.match(gap.reason, /SIGX/, 'the reason names the signature that was sent and never confirmed');
  assert.match(gap.reason, /not sent again/);
  assert.equal(chain.sent.length, 0, 'still no second memo for the bell');
});

test('A1 boundary: a signature that FAILED on the chain frees the bell for exactly one new memo', async () => {
  const aiDir = newDir('a1f');
  writeBell(aiDir, 60);
  write(R.anchorClaimFile(aiDir, 60), JSON.stringify({ pid: deadPid(), bell: 60, started: 't', signature: 'SIGE' }));
  const chain = chainDouble({ landOnSend: true });
  chain.statuses.set('SIGE', { slot: 3, err: { InstructionError: [0, 'Custom'] } });
  const r = await R.anchorPass({ aiDir, kp: Keypair.generate(), rpc: chain, season: 31, log: quiet, ...FAST });
  assert.deepEqual(r.anchored, [60]);
  assert.equal(chain.sent.length, 1);
  assert.equal(readJ(path.join(aiDir, 'pub', 'anchors', '60.json')).signature, 'SIG1');
});

test('A1 boundary: a signature that has landed is used as it is (no memo is sent), also when the pass is a retry of our own claim', async () => {
  const aiDir = newDir('a1l');
  writeBell(aiDir, 61);
  write(R.anchorClaimFile(aiDir, 61), JSON.stringify({ pid: process.pid, bell: 61, started: 't', signature: 'SIGL' }));
  const chain = chainDouble();
  chain.statuses.set('SIGL', { slot: 9, err: null });
  const r = await R.anchorPass({ aiDir, kp: Keypair.generate(), rpc: chain, season: 31, log: quiet, ...FAST });
  assert.deepEqual(r.anchored, [61]);
  assert.equal(chain.sent.length, 0);
  assert.equal(readJ(path.join(aiDir, 'pub', 'anchors', '61.json')).signature, 'SIGL');
});

// ------------------------------------------------------------------ A2
test('A2: nothing is sent to a paused chain (a memo would sit pending and confirm later, after the bell was declared a gap); with gapWhenBlocked the bell is a gap at once', async () => {
  const aiDir = newDir('a2p');
  writeBell(aiDir, 70); writeBell(aiDir, 71);
  const chain = chainDouble({ landOnSend: true });
  const state = { failed: new Map() };
  const kp = Keypair.generate();
  const blocked = 'the chain is paused: no block can confirm a memo';
  let r = await R.anchorPass({ aiDir, kp, rpc: chain, season: 31, state, log: quiet, sendBlocked: blocked, ...FAST });
  assert.equal(chain.sent.length, 0, 'sendTransaction was never called (old code ignores the option and sends)');
  assert.deepEqual([r.anchored, r.gaps, r.unsent], [[], [], [70]], 'the pass stops at the first blocked bell (memo order)');
  assert.ok(!fs.existsSync(R.anchorClaimFile(aiDir, 70)), 'no claim is left behind for a bell that was not sent');
  r = await R.anchorPass({ aiDir, kp, rpc: chain, season: 31, state, log: quiet, sendBlocked: blocked, gapWhenBlocked: true, ...FAST });
  assert.deepEqual(r.gaps, [70, 71]);
  assert.equal(chain.sent.length, 0);
  const g = readJ(path.join(aiDir, 'pub', 'anchors', '71.json'));
  assert.deepEqual([g.anchor_gap, g.signature, g.slot, g.social_root, g.minds_root, g.reason], [true, null, null, social(71), social(72), blocked]);
});

test('A2: publishSeasonEnd gives every closed bell without an anchor an anchor_gap (it left the last bell with neither before); a bell a live process still holds is left out', () => {
  const aiDir = newDir('a2g');
  const kp = Keypair.generate();
  writeBell(aiDir, 10);
  write(path.join(aiDir, 'pub', 'anchors', '10.json'), JSON.stringify({ bell: 10, social_root: social(10), minds_root: social(11), signature: 'S10', slot: 5 }));
  writeBell(aiDir, 11);                              // both files, memo sent, never confirmed
  write(R.anchorClaimFile(aiDir, 11), JSON.stringify({ pid: deadPid(), bell: 11, started: 't', signature: 'SIGP' }));
  writeBell(aiDir, 12, { minds: false });            // talk file only
  writeBell(aiDir, 13, { talk: false });             // minds file only
  writeBell(aiDir, 14);                              // in flight in a live process
  const idx = R.publishSeasonEnd({ aiDir, kp, season: 31, commitmentsSha: 'cc'.repeat(32), skip: [14], defaultReason: 'the chain was paused' });
  assert.deepEqual(idx.anchored, [10]);
  assert.deepEqual(idx.gaps, [11, 12, 13]);
  assert.equal(idx.last_bell, 13);
  assert.ok(R.verifySigned(idx, kp.publicKey.toBase58()));
  const g = b => readJ(path.join(aiDir, 'pub', 'anchors', `${b}.json`));
  assert.deepEqual([g(11).anchor_gap, g(11).signature, g(11).slot, g(11).social_root, g(11).minds_root], [true, null, null, social(11), social(12)]);
  assert.match(g(11).reason, /SIGP/, 'a bell whose memo was sent names that signature');
  assert.match(g(11).reason, /not sent again/);
  assert.equal(g(12).minds_root, null);
  assert.equal(g(12).reason, 'the chain was paused');
  assert.equal(g(13).social_root, null);
  assert.ok(!fs.existsSync(path.join(aiDir, 'pub', 'anchors', '14.json')), 'a live process may still anchor bell 14: no gap is written over it');
  assert.equal(readJ(path.join(aiDir, 'state', 'season-end.json')).last_bell, 13);
  assert.deepEqual(readJ(path.join(aiDir, 'pub', 'anchors', '10.json')).signature, 'S10', 'an existing anchor is never touched');
});

/** A tiny loopback herald (cluster localnet) and a JSON-RPC server around a chainDouble. */
function servers(chain) {
  const rpc = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      const { id, method, params } = JSON.parse(Buffer.concat(chunks));
      chain.heard.push(method);
      let out;
      try { out = { jsonrpc: '2.0', id, result: await chain.call(method, params) }; } catch (e) { out = { jsonrpc: '2.0', id, error: { code: -32000, message: e.message } }; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  const herald = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ cluster: 'localnet', genesisTs: 1, season: '31' })); });
  const up = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)));
  return Promise.all([up(rpc), up(herald)]).then(([rpcUrl, heraldUrl]) => ({ rpcUrl, heraldUrl, close: () => Promise.all([rpc, herald].map(s => new Promise(r => { s.closeAllConnections?.(); s.close(r); }))) }));
}
async function publishCli(aiDir, s, extra = []) {
  write(path.join(aiDir, 'pub', 'commitments.json'), JSON.stringify({ season_id: 31 }));
  const lines = [];
  const code = await R.main(['publish', '--ai-dir', aiDir, '--key', path.join(aiDir, 'keys', 'registrar.json'), '--herald', s.heraldUrl, '--rpc', s.rpcUrl, '--memo-tries', '2', '--memo-interval-ms', '1', ...extra], { log: m => lines.push(m), out: m => lines.push(m) });
  return { code, lines };
}

test('A2: `publish` waits (bounded) for a bell that is half closed, anchors it in its final pass, and only then writes the index', async () => {
  const aiDir = newDir('a2w');
  writeBell(aiDir, 30); writeBell(aiDir, 31, { minds: false }); // bell 31: the closer wrote the talk file; the minds file comes 200 ms later
  const chain = chainDouble({ landOnSend: true });
  const s = await servers(chain);
  try {
    setTimeout(() => writeBell(aiDir, 31, { talk: false }), 200);
    const { code, lines } = await publishCli(aiDir, s, ['--wait-last-secs', '10']);
    assert.equal(code, 0, lines.join('\n'));
    const idx = readJ(path.join(aiDir, 'pub', 'anchors', 'index.json'));
    assert.deepEqual([idx.anchored, idx.gaps, idx.last_bell], [[30, 31], [], 31], 'bell 31 is anchored, not skipped (old code: index ended at 30)');
    assert.equal(chain.sent.length, 2);
    assert.match(lines.at(-1), /2 anchored, 0 gap\(s\) of 2 closed bells/);
  } finally { await s.close(); }
});

test('A2: `publish` on a paused chain sends no memo and writes an anchor_gap for every closed bell without an anchor; the line counts closed bells', async () => {
  const aiDir = newDir('a2c');
  writeBell(aiDir, 20); writeBell(aiDir, 21);
  write(path.join(aiDir, 'pub', 'anchors', '20.json'), JSON.stringify({ bell: 20, social_root: social(20), minds_root: social(21), signature: 'S20', slot: 5 }));
  const chain = chainDouble({ landOnSend: true });
  chain.paused = true;
  const s = await servers(chain);
  try {
    const { code, lines } = await publishCli(aiDir, s, ['--wait-last-secs', '1']);
    assert.equal(code, 0, lines.join('\n'));
    assert.equal(chain.sent.length, 0, 'no memo is sent to a paused chain');
    assert.ok(!chain.heard.includes('sendTransaction'));
    const idx = readJ(path.join(aiDir, 'pub', 'anchors', 'index.json'));
    assert.deepEqual([idx.anchored, idx.gaps, idx.last_bell], [[20], [21], 21]);
    assert.match(readJ(path.join(aiDir, 'pub', 'anchors', '21.json')).reason, /paused/);
    assert.match(lines.at(-1), /1 anchored, 1 gap\(s\) of 2 closed bells/);
  } finally { await s.close(); }
});

test('A2: the run script passes the bounded wait to publish and names closed against anchored bells in the END detail', () => {
  const sh = read(new URL('../citizens/bin/ai-citizens-run.sh', import.meta.url).pathname);
  const pubLine = sh.split('\n').find(l => /REGISTRAR/.test(l) && /\bpublish\b/.test(l) && !l.trim().startsWith('#') && !l.includes('PLAN'));
  assert.ok(pubLine, 'the publish step is in the script');
  assert.match(pubLine, /--wait-last-secs/, 'publish waits for the bell the closer is closing');
  assert.match(sh, /AI_WAIT_LAST_SECS/);
  assert.match(sh, /ANCHOR_NOTE/, 'the closed/anchored/gap line goes into the END detail of RUNS.md');
});

// ------------------------------------------------------------------ the report counts closed bells against anchored bells
test('A2 report: closed bells against anchored bells, gaps, bells without any anchor file and bells closed after the season-end index', () => {
  assert.equal(typeof REP.anchorsSection, 'function', 'report.mjs exports anchorsSection');
  const aiDir = newDir('rep');
  for (const b of [0, 1, 2, 3, 4]) writeBell(aiDir, b);
  const pub = path.join(aiDir, 'pub');
  const anchor = (b, o) => write(path.join(pub, 'anchors', `${b}.json`), JSON.stringify({ bell: b, social_root: social(b), minds_root: social(b + 1), signature: 'S', slot: 1, ...o }));
  anchor(0); anchor(1); anchor(2, { signature: null, slot: null, anchor_gap: true, reason: 'paused' });
  write(path.join(pub, 'anchors', 'commit.json'), '{}');
  write(path.join(pub, 'anchors', 'index.json'), JSON.stringify({ last_bell: 2, anchored: [0, 1], gaps: [2] }));
  const s = REP.anchorsSection({ pub });
  assert.deepEqual([s.closed_bells, s.anchored, s.gaps], [5, 2, 1]);
  assert.deepEqual(s.closed_without_anchor_file, [3, 4]);
  assert.deepEqual(s.closed_after_index, [3, 4]);
  assert.equal(s.index_last_bell, 2);
  assert.equal(s.every_closed_bell_has_an_anchor_or_gap, false);
  assert.match(s.note, /5 closed bells/);
  // no anchors directory at all (a run that never anchored): counts, never a throw
  const bare = newDir('rep2');
  const s0 = REP.anchorsSection({ pub: path.join(bare, 'pub') });
  assert.deepEqual([s0.closed_bells, s0.anchored, s0.gaps, s0.index_last_bell], [0, 0, 0, null]);
  assert.equal(s0.every_closed_bell_has_an_anchor_or_gap, true);
  // the markdown prints it
  const md = REP.renderMarkdown(REP.buildReport({ aiDir, privateOk: false }));
  assert.match(md, /Anchors/);
  assert.match(md, /5 closed bells/);
});
