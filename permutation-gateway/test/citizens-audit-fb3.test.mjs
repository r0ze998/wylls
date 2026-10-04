// FB3 (fix unit, wave-B audit review D1 to D3 and the reviewer's tampers T1 to T4): verify-minds must not call a partial run a pass, must not trust the
// labels of an opening, must not pass a run whose last bells were cut off, must not let a `redacted` flag stand for a tombstone, and must not use a stored
// retrieval focus unchecked. Every test here FAILS on the pre-FB3 verify-minds.mjs / audit/* (shown in docs/frontier/ai-citizens/FB3-NOTES.md).
// The consistent mini run (test/fixtures/ai-audit-mini.mjs) is the base; each test makes one tamper on a COPY of its pub/.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { main, verifyMinds } from '../citizens/verify-minds.mjs';
import { startFakeLlama } from './fixtures/ai-audit-doubles.mjs';
import { buildMiniRun, llmOutputOf } from './fixtures/ai-audit-mini.mjs';

const rj = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const wj = (p, v) => fs.writeFileSync(p, `${JSON.stringify(v)}\n`);
const codes = c => c.failures.map(f => f.code);
const cp = (from, to) => { if (fs.statSync(from).isDirectory()) { fs.mkdirSync(to, { recursive: true }); for (const n of fs.readdirSync(from)) cp(path.join(from, n), path.join(to, n)); } else fs.copyFileSync(from, to); };
const PROPS = { default_generation_settings: { n_ctx: 16384 }, model_alias: 'gemma-4-26b-a4b-it' };

let plain;
before(async () => { plain = await buildMiniRun({ council: false }); });
after(async () => { await plain?.close(); });

/** Verify a COPY of a mini run's pub/ (and state/) after `edit({pub, state, dir})`. */
async function check(run, edit, { only = null, llm = null, ...extra } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-fb3-copy-'));
  try {
    cp(run.pub, path.join(dir, 'pub'));
    cp(run.state, path.join(dir, 'state'));
    for (const f of ['stack.toml', 'ai-slots.json']) fs.copyFileSync(path.join(run.aiDir, f), path.join(dir, f));
    edit?.({ pub: path.join(dir, 'pub'), state: path.join(dir, 'state'), dir });
    return await verifyMinds({ ...run.verifyOpts({ llm, only, ...extra }), aiDir: path.join(dir, 'pub') });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** An HTTP JSON-RPC front of the in-process chain double, so that the command line (which takes a URL) can run every check. */
async function serveRpc(chain) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      const j = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      try { res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: await chain.call(j.method, j.params ?? []) })); } catch (e) { res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, error: { code: -32000, message: e.message } })); }
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }) };
}

const cliArgs = (run, dir, rpcUrl, extra = []) => ['--herald', run.herald.url, '--rpc', rpcUrl, '--ai-dir', path.join(dir, 'pub'), '--repo', run.repo, '--model', run.modelPath, '--llama-dir', run.llamaDir,
  '--stack', run.stackPath, '--slots', run.slotsPath, '--quiet',
  '--episode-rule', 'legacy_v1', // merge seam FB3+FB5: the mini run publishes the real slice-4 episodes (pre-R12 rule), as the fixture's verifyOpts say
  ...extra];

// ================================================================ D1: a partial run is never a pass and never overwrites the published file
test('D1: --only leaves checks out: the verdict is INCOMPLETE (exit 3), not PASS, and PUB/verify-minds.json is NOT written unless --out is given', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-fb3-cli-'));
  try {
    cp(plain.pub, path.join(dir, 'pub'));
    const published = path.join(dir, 'pub', 'verify-minds.json');
    fs.writeFileSync(published, 'SENTINEL: the file the service publishes');
    const out = [];
    const argv = ['--herald', plain.herald.url, '--rpc', 'http://127.0.0.1:1', '--ai-dir', path.join(dir, 'pub'), '--stack', plain.stackPath, '--quiet', '--only', 'M2'];
    const code = await main(argv, { out: m => out.push(m), err: () => {} });
    assert.equal(code, 3, 'a partial run exits 3 (INCOMPLETE)');
    const printed = JSON.parse(out[0]);
    assert.equal(printed.verdict, 'INCOMPLETE');
    assert.equal(printed.partial, true);
    assert.deepEqual(printed.not_run, ['M1', 'M3', 'M7', 'M8', 'M9', 'M11']);
    assert.equal(printed.checks.M2.pass, true, 'the one check that ran still passed: it is the verdict that is not PASS');
    assert.equal(fs.readFileSync(published, 'utf8'), 'SENTINEL: the file the service publishes', 'the published file was not overwritten by a partial run');
    // with --out the partial report is written there, and says what it is
    const outFile = path.join(dir, 'partial.json');
    assert.equal(await main([...argv, '--out', outFile], { out: () => {}, err: () => {} }), 3);
    const file = rj(outFile);
    assert.equal(file.verdict, 'INCOMPLETE');
    assert.equal(file.partial, true);
    assert.deepEqual(file.not_run, ['M1', 'M3', 'M7', 'M8', 'M9', 'M11']);
    assert.equal(fs.readFileSync(published, 'utf8'), 'SENTINEL: the file the service publishes');
    // an unknown check id is a usage error, not an empty run
    assert.equal(await main([...argv.slice(0, -1), 'M4'], { out: () => {}, err: () => {} }), 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('D1: a failure in a partial run is still a FAIL (INCOMPLETE only replaces PASS); --through is a partial run too', async () => {
  const bad = await check(plain, ({ pub }) => { const p = path.join(pub, 'roster.json'); const j = rj(p); j.genesis_seed = '00'.repeat(32); wj(p, j); }, { only: ['M2'] });
  assert.equal(bad.verdict, 'FAIL');
  assert.equal(bad.partial, true);
  const ok = await check(plain, null, { only: ['M2'] });
  assert.equal(ok.verdict, 'INCOMPLETE');
  assert.equal(ok.checks.M2.pass, true);
  assert.deepEqual(ok.not_run, ['M1', 'M3', 'M7', 'M8', 'M9', 'M11']);
  const limited = await check(plain, null, { through: 40 });
  assert.equal(limited.partial, true);
  assert.equal(limited.through_override, 40);
  assert.notEqual(limited.verdict, 'PASS', 'a run that was told where to stop is not a full verdict');
});

test('D1: a full run through the command line writes PUB/verify-minds.json (PASS, exit 0); the stdout summary prints the redacted records M8 skipped and M9 excluded', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-fb3-cli-full-'));
  const rpc = await serveRpc(plain.chain);
  const llm = await startFakeLlama(llmOutputOf, { props: PROPS });
  try {
    cp(plain.pub, path.join(dir, 'pub'));
    fs.rmSync(path.join(dir, 'pub', 'verify-minds.json'), { force: true });
    const out = [];
    const code = await main(cliArgs(plain, dir, rpc.url, ['--llm', llm.url]), { out: m => out.push(m), err: () => {} });
    const printed = JSON.parse(out[0]);
    assert.equal(code, 0, JSON.stringify(printed));
    assert.equal(printed.verdict, 'PASS');
    assert.equal(printed.partial, undefined);
    const file = rj(path.join(dir, 'pub', 'verify-minds.json'));
    assert.equal(file.verdict, 'PASS');
    assert.equal(file.partial, undefined);
    assert.deepEqual(Object.keys(file.checks), ['M1', 'M2', 'M3', 'M7', 'M8', 'M9', 'M11']);
    // D2: the skipped counts are printed, not hidden in the file
    assert.equal(printed.checks.M8.redacted_skipped, 1);
    assert.equal(printed.checks.M8.redacted_skipped_ai, 1);
    assert.equal(printed.checks.M9.m9_excluded_redacted, 1);
  } finally { await rpc.close(); await llm.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ================================================================ D2 T1: the last bells' files are removed
test('T1 tail truncation: the last 5 bells\' talk, minds and anchor files removed is caught three ways (herald log, signed anchors index, registrar memos on chain)', async () => {
  const hi = Math.max(...fs.readdirSync(path.join(plain.pub, 'anchors')).filter(n => /^\d+\.json$/.test(n)).map(n => Number(n.replace('.json', ''))));
  const cut = ({ pub }) => { for (let b = hi - 4; b <= hi; b++) for (const d of ['talk', 'minds', 'anchors']) fs.rmSync(path.join(pub, d, `${b}.json`), { force: true }); };
  const report = await check(plain, cut, { only: ['M3'] });
  const sources = report.checks.M3.failures.filter(f => f.code === 'tail_truncated').map(f => f.source);
  assert.ok(sources.includes('herald log'), JSON.stringify(sources));
  assert.ok(sources.includes('signed anchors index'), JSON.stringify(sources));
  assert.ok(sources.includes('registrar memos on chain'), JSON.stringify(sources));
  assert.equal(report.checks.M3.pass, false);
  // the operator also removes the index: the herald and the chain still say so
  const noIndex = await check(plain, ctx => { cut(ctx); fs.rmSync(path.join(ctx.pub, 'anchors', 'index.json')); }, { only: ['M3'] });
  assert.ok(noIndex.checks.M3.failures.some(f => f.code === 'tail_truncated' && f.source === 'herald log'));
  assert.ok(noIndex.checks.M3.failures.some(f => f.code === 'tail_truncated' && f.source === 'registrar memos on chain'));
  assert.equal(noIndex.checks.M3.unverified.some(u => u.field === 'anchors_index'), true, 'a missing index is not silently skipped');
  // the intact run reaches the end: the same checks pass
  const ok = await check(plain, null, { only: ['M3'] });
  assert.equal(ok.checks.M3.pass, true, JSON.stringify(ok.checks.M3.failures.slice(0, 3)));
  assert.ok(ok.checks.M3.chain_anchored_bells >= 57);
  assert.ok(ok.checks.M3.herald_last_closed_bell <= ok.checks.M3.bells.last);
});

test('T1: a head cut (the first bells\' files removed) is caught by the signed index and the chain', async () => {
  const lo = Math.min(...fs.readdirSync(path.join(plain.pub, 'anchors')).filter(n => /^\d+\.json$/.test(n)).map(n => Number(n.replace('.json', ''))));
  const report = await check(plain, ({ pub }) => { for (let b = lo; b < lo + 3; b++) for (const d of ['talk', 'minds', 'anchors']) fs.rmSync(path.join(pub, d, `${b}.json`), { force: true }); }, { only: ['M3'] });
  assert.ok(report.checks.M3.failures.some(f => f.code === 'head_truncated' && f.source === 'signed anchors index'));
  assert.ok(report.checks.M3.failures.some(f => f.code === 'head_truncated' && f.source === 'registrar memos on chain'));
});

test('T1: a chain history that cannot be read is "unverified" (M3 is not PASS), never a silent skip', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-fb3-rpc-'));
  try {
    cp(plain.pub, path.join(dir, 'pub'));
    const reg = plain.commitments.registrar;
    const rpc = { call: async (m, p) => { if (m === 'getSignaturesForAddress' && p[0] === reg) throw new Error('method not supported'); return plain.chain.call(m, p); } };
    const report = await verifyMinds({ ...plain.verifyOpts({ only: ['M3'] }), rpc, aiDir: path.join(dir, 'pub') });
    assert.equal(report.checks.M3.failures.length, 0);
    assert.equal(report.checks.M3.pass, null);
    assert.ok(report.checks.M3.unverified.some(u => u.field === 'anchor_memos_on_chain'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ================================================================ D2 T2: the opening's label of its destination
const openFiles = pub => fs.readdirSync(path.join(pub, 'open')).filter(n => /^\d+\.json$/.test(n)).map(n => Number(n.replace('.json', ''))).sort((a, b) => a - b);

/** Take the first record of the first open file out into a file of its own at `bell`, with `edit(record)` applied. Returns {id, release_bell}. */
function relabelFirst(pub, bell, edit) {
  const b0 = openFiles(pub)[0];
  const p0 = path.join(pub, 'open', `${b0}.json`);
  const f = rj(p0);
  const rec = f.records.shift();
  wj(p0, f);
  edit(rec);
  wj(path.join(pub, 'open', `${bell(rec)}.json`), { bell: bell(rec), records: [rec] });
  return rec;
}

test('T2: a revealed march labelled "unrevealed" (so its due bell moves to release_bell + 6) and opened late is caught: the herald logged its REVEAL', async () => {
  let victim;
  const report = await check(plain, ({ pub }) => {
    victim = relabelFirst(pub, r => r.release_bell + 6, r => {
      r.destinations = r.destinations.map(d => ({ host_id: d.host_id, planned_arrive_bell: d.planned_arrive_bell, via: 'model', state: 'unrevealed', destination: 'unrevealed', arrive_bell: null }));
    });
  }, { only: ['M3'] });
  const c = report.checks.M3;
  assert.ok(c.failures.some(f => f.code === 'unrevealed_but_revealed' && f.decision === victim.id), JSON.stringify(codes(c)));
  assert.ok(!codes(c).includes('opened_late'), 'the label made the late opening look due: that is the attack');
  assert.equal(c.pass, false);
  // the honest "unrevealed" (no REVEAL ever public) is not an accusation: a march that never arrived has none
  const honest = await check(plain, ({ pub }) => {
    relabelFirst(pub, r => r.release_bell + 6, r => {
      r.destinations = r.destinations.map(d => ({ host_id: '999999999999999', planned_arrive_bell: d.planned_arrive_bell, via: 'model', state: 'unrevealed', destination: 'unrevealed', arrive_bell: null }));
    });
  }, { only: ['M3'] });
  assert.ok(!codes(honest.checks.M3).includes('unrevealed_but_revealed'));
});

test('T2: a revealed march labelled "not_sent" fails (the record\'s tx list sent it), also when the intent label in the list was changed (a Depart on chain)', async () => {
  let victim;
  const report = await check(plain, ({ pub }) => {
    victim = relabelFirst(pub, r => r.release_bell, r => { r.destinations = r.destinations.map(d => ({ host_id: d.host_id, planned_arrive_bell: d.planned_arrive_bell, via: 'model', state: 'not_sent', destination: 'not_sent', arrive_bell: null })); });
  }, { only: ['M3'] });
  assert.ok(report.checks.M3.failures.some(f => f.code === 'not_sent_but_sent' && f.decision === victim.id), JSON.stringify(codes(report.checks.M3)));
  // the same label with the depart's intent renamed in the record's tx list: the chain says the transaction is a Depart (0x50)
  let victim2;
  const renamed = await check(plain, ({ pub }) => {
    victim2 = relabelFirst(pub, r => r.release_bell, r => { r.destinations = r.destinations.map(d => ({ host_id: d.host_id, planned_arrive_bell: d.planned_arrive_bell, via: 'model', state: 'not_sent', destination: 'not_sent', arrive_bell: null })); });
    for (const f of fs.readdirSync(path.join(pub, 'minds')).filter(n => /^\d+\.json$/.test(n))) {
      const p = path.join(pub, 'minds', f); const j = rj(p);
      const r = j.records.find(x => x.id === victim2.id);
      if (r) { r.tx = r.tx.map(t => (t.intent === 'depart' ? { ...t, intent: 'build' } : t)); wj(p, j); }
    }
  }, { only: ['M3'] });
  assert.ok(renamed.checks.M3.failures.some(f => f.code === 'not_sent_but_depart_on_chain' && f.decision === victim2.id), JSON.stringify(codes(renamed.checks.M3)));
});

test('T2: an opening that names no destination for a record whose tx list sent a march fails (the due bell cannot be taken from it)', async () => {
  const report = await check(plain, ({ pub }) => { relabelFirst(pub, r => r.release_bell, r => { r.destinations = []; }); }, { only: ['M3'] });
  assert.ok(codes(report.checks.M3).includes('march_without_destination'));
});

test('M3: a "planned" destination (the operator\'s plan, season-end style) is compared with the public REVEAL when there is one', async () => {
  const report = await check(plain, ({ pub }) => {
    relabelFirst(pub, r => r.release_bell, r => { r.destinations = r.destinations.map(d => ({ host_id: d.host_id, p: d.p + 1, q: d.q, tile: d.tile, planned_arrive_bell: d.planned_arrive_bell, arrive_bell: d.planned_arrive_bell, source: 'planned' })); });
  }, { only: ['M3'] });
  assert.ok(report.checks.M3.failures.some(f => f.code === 'destination_mismatch' && f.source === 'planned'), JSON.stringify(codes(report.checks.M3)));
});

test('M3: an unreadable herald feed makes the opening checks "unverified" (M3 is null), not a silent skip', async () => {
  // a herald that serves everything but its event log
  const real = plain.herald.url;
  const proxy = http.createServer(async (req, res) => {
    if (req.url.startsWith('/h/events')) { res.writeHead(500); res.end('{}'); return; }
    const r = await fetch(real + req.url);
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-fb3-herald-'));
    try {
      cp(plain.pub, path.join(dir, 'pub'));
      const report = await verifyMinds({ ...plain.verifyOpts({ only: ['M3'] }), herald: `http://127.0.0.1:${proxy.address().port}`, aiDir: path.join(dir, 'pub') });
      const c = report.checks.M3;
      assert.equal(c.pass, null, JSON.stringify(c.failures.slice(0, 2)));
      assert.ok(c.unverified.some(u => u.field === 'herald_feed'));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  } finally { proxy.closeAllConnections?.(); await new Promise(r => proxy.close(r)); }
});

test('M3: a march still in flight at the last closed bell, opened only in the season-end bundle, is "not due yet": counted and noted, not opened_late', async () => {
  const report = await check(plain, ({ pub }) => {
    // the last open file's record becomes a season-end-only opening whose due bell lies after the last closed bell
    const last = openFiles(pub).at(-1);
    const f = rj(path.join(pub, 'open', `${last}.json`));
    const rec = f.records[0];
    fs.mkdirSync(path.join(pub, 'full', 'open'), { recursive: true });
    const hi = Math.max(...fs.readdirSync(path.join(pub, 'anchors')).filter(n => /^\d+\.json$/.test(n)).map(n => Number(n.replace('.json', ''))));
    wj(path.join(pub, 'full', 'open', `${rec.id}.json`), { ...rec, release_bell: rec.release_bell, destinations: rec.destinations.map(d => ({ ...d, planned_arrive_bell: hi + 5, arrive_bell: hi + 5, source: 'planned' })) });
    f.records.shift();
    wj(path.join(pub, 'open', `${last}.json`), f);
    if (!f.records.length) fs.rmSync(path.join(pub, 'open', `${last}.json`));
  }, { only: ['M3'] });
  const c = report.checks.M3;
  assert.ok(!codes(c).includes('opened_late'), JSON.stringify(c.failures));
  assert.equal(c.not_due_at_season_end, 1);
});

// ================================================================ D2 T3: a redacted flag is not a tombstone
test('T3: a talk leaf flagged redacted with its bytes removed and no tombstone fails M3 and M8 (it used to be skipped by both)', async () => {
  const report = await check(plain, ({ pub }) => {
    const p = path.join(pub, 'talk', '30.json'); const j = rj(p);
    j.records[0] = { ...j.records[0], bytes_b64: '', sig_b64: '', redacted: true }; // the root still verifies from `inner`
    wj(p, j);
  }, { only: ['M3', 'M8'] });
  assert.ok(codes(report.checks.M3).includes('redacted_without_tombstone'), JSON.stringify(codes(report.checks.M3)));
  assert.ok(codes(report.checks.M8).includes('redacted_without_tombstone'), JSON.stringify(codes(report.checks.M8)));
  assert.equal(report.checks.M8.redacted_skipped, 1, 'only the record with a tombstone was skipped');
});

test('T3: a leaf with no bytes and no flag fails M8 as well (not skipped); the tombstoned redaction of the run is counted by M3 and M8', async () => {
  const report = await check(plain, ({ pub }) => { const p = path.join(pub, 'talk', '30.json'); const j = rj(p); j.records[0] = { ...j.records[0], bytes_b64: '', sig_b64: '' }; wj(p, j); }, { only: ['M3', 'M8'] });
  assert.ok(codes(report.checks.M8).includes('record_without_bytes'));
  const ok = await check(plain, null, { only: ['M3', 'M8'] });
  assert.equal(ok.checks.M3.redacted_leaves, 1);
  assert.equal(ok.checks.M8.redacted_skipped, 1);
  assert.equal(ok.checks.M8.redacted_skipped_ai, 1);
  assert.match(ok.checks.M8.notes.join(' '), /1 redacted record\(s\) with a tombstone were not checked/);
});

test('T3: a record with its bytes present is checked whatever flag it carries (M8 used to skip every record with the flag)', async () => {
  const report = await check(plain, ({ pub }) => {
    const p = path.join(pub, 'talk', '30.json'); const j = rj(p);
    j.records[0].redacted = true; // the bytes are there
    const raw = Buffer.from(j.records[0].sig_b64, 'base64'); raw[5] ^= 1; j.records[0].sig_b64 = raw.toString('base64'); // and the signature is forged
    wj(p, j);
  }, { only: ['M8'] });
  assert.ok(codes(report.checks.M8).includes('bad_signature'));
});

// ================================================================ D2 T4: a stored request replaced by a redacted stub
test('T4: a stored request body replaced by {redacted:true} with no tombstone behind it fails M9 (it used to be excluded from the sample without a word)', async () => {
  let victim, rec;
  const report = await check(plain, ({ pub }) => {
    // the decision of the 31 message is the one with a tombstone; take another model record, one that neither authored a tombstoned message nor had an inbox (the bell-30 world message)
    const records = [];
    for (const f of fs.readdirSync(path.join(pub, 'minds')).filter(n => /^\d+\.json$/.test(n))) for (const r of rj(path.join(pub, 'minds', f)).records) records.push(r);
    rec = records.find(r => r.mode === 'model' && r.request_hash && r.bell === 30 && r.kind === 'reaction');
    victim = path.join(pub, 'full', 'requests', `${rec.id}.json`);
    wj(victim, { redacted: true, reason: 'the request contains the text of a redacted message', request_hash: rec.request_hash });
  }, { only: ['M9'] });
  assert.ok(report.checks.M9.failures.some(f => f.code === 'redacted_request_unjustified' && f.decision === rec.id), JSON.stringify(report.checks.M9.failures.slice(0, 2)));
  assert.equal(report.checks.M9.m9_excluded_redacted, 2, 'the real stub and the forged one are both counted');
  // a stub with another request_hash does not stand for the record's request either
  const wrongHash = await check(plain, ({ pub }) => {
    const records = [];
    for (const f of fs.readdirSync(path.join(pub, 'minds')).filter(n => /^\d+\.json$/.test(n))) for (const r of rj(path.join(pub, 'minds', f)).records) records.push(r);
    const r = records.find(x => x.mode === 'model' && x.request_hash && x.bell === 30 && x.kind === 'reaction');
    wj(path.join(pub, 'full', 'requests', `${r.id}.json`), { redacted: true, request_hash: '0'.repeat(64) });
  }, { only: ['M9'] });
  assert.ok(codes(wrongHash.checks.M9).includes('redacted_request_hash'));
});

test('T4: with no tombstone at all, every redacted stub fails; the stub of the run (a decision that authored a tombstoned message) passes', async () => {
  const none = await check(plain, ({ pub }) => wj(path.join(pub, 'redactions.json'), []), { only: ['M9'] });
  assert.ok(none.checks.M9.failures.some(f => f.code === 'redacted_request_unjustified' && /no tombstone/.test(f.detail)));
  const ok = await check(plain, null, { only: ['M9'] });
  assert.equal(ok.checks.M9.failures.length, 0);
  assert.equal(ok.checks.M9.m9_excluded_redacted, 1);
});

// ================================================================ the reviewer's smaller points
test('M8: a (decision_id, item) pair is used once whatever the record type; a vacuous M8 is "not verified", not a pass', async () => {
  const withCouncil = await buildMiniRun({ council: true });
  try {
    const twice = await check(withCouncil, ({ pub }) => {
      const p = path.join(pub, 'full', 'social.json'); const j = rj(p);
      const talk = j.records.find(r => r.bell === 30);
      j.records.find(r => r.type === 'ballot').decision_id = talk.decision_id; // item 0 of the ballot and item 0 of the world message: one decision, one item
      wj(p, j);
    }, { only: ['M8'] });
    assert.ok(codes(twice.checks.M8).includes('duplicate_use'), JSON.stringify(codes(twice.checks.M8)));
  } finally { await withCouncil.close(); }
  const empty = await check(plain, ({ pub }) => { for (const b of [30, 31]) { const p = path.join(pub, 'talk', `${b}.json`); const j = rj(p); j.records = []; j.root = '0'.repeat(64); wj(p, j); } }, { only: ['M8'] });
  assert.equal(empty.checks.M8.pass, null);
  assert.equal(empty.checks.M8.vacuous, true);
  assert.equal(empty.verdict, 'INCOMPLETE');
});

test('M1: with no --model the committed model hash is "unverified" (M1 is null); a committed injection corpus that differs from the file of the committed tree fails', async () => {
  const noModel = await check(plain, null, { only: ['M1'], modelPath: undefined });
  assert.equal(noModel.checks.M1.failures.length, 0, JSON.stringify(noModel.checks.M1.failures));
  assert.ok(noModel.checks.M1.unverified.some(u => u.field === 'model.sha256'));
  assert.equal(noModel.checks.M1.pass, null);
  assert.notEqual(plain.commitments.configs.injection_corpus_sha256, null, 'the mini repo holds a corpus file');
  const edited = await check(plain, ({ pub }) => { const p = path.join(pub, 'commitments.json'); const j = rj(p); j.configs.injection_corpus_sha256 = 'a'.repeat(64); wj(p, j); }, { only: ['M1'] });
  assert.ok(edited.checks.M1.failures.some(f => f.code === 'config_hash' && f.field === 'injection_corpus_sha256' && /another hash/.test(f.detail)), JSON.stringify(codes(edited.checks.M1)));
});

test('M9: an unreadable /props of the llama-server is "unverified" (M9 is null); the other committed flags are not visible there and are said not to be compared', async () => {
  const llm = await startFakeLlama(llmOutputOf); // answers {} on /props: no n_ctx, no alias
  try {
    const report = await check(plain, null, { only: ['M9'], llm: llm.url });
    assert.equal(report.checks.M9.failures.length, 0);
    assert.equal(report.checks.M9.pass, null);
    assert.ok(report.checks.M9.unverified.some(u => u.field === 'llm_props' && /-ngl/.test(u.why)));
  } finally { await llm.close(); }
});

// ================================================================ D3: a stored retrieval focus is checked
/** The mini run's first unsealed model decision with 4 or more retrieved ids, its AI's published episodes, and the base focus the audit derives. */
function focusScenario(run) {
  const decDir = path.join(run.pub, 'full', 'decisions');
  for (const f of fs.readdirSync(path.join(run.pub, 'minds')).filter(n => /^\d+\.json$/.test(n))) {
    for (const r of rj(path.join(run.pub, 'minds', f)).records) {
      if (r.mode !== 'model' || r.sealed || r.kind !== 'session' || !r.retrieved || r.retrieved.length < 4 || !fs.existsSync(path.join(decDir, `${r.id}.json`))) continue;
      const full = rj(path.join(decDir, `${r.id}.json`));
      const eps = rj(path.join(run.pub, 'memory', r.ai, 'episodes.json')).episodes.filter(e => e.created_bell < r.bell);
      const home = full.situation.me.home;
      const base = new Set([r.ai, `nation:${full.situation.me.faction}`, `pq:${home.p},${home.q}`]);
      for (const c of full.candidates ?? []) for (const e of c.entities ?? []) base.add(e);
      return { rec: r, file: f, eps, base, full };
    }
  }
  throw new Error('no unsealed model session decision with 4+ retrieved ids in the mini run');
}

test('D3: a stored focus is used when it holds the base focus and only justified extras; a stored focus that is exactly the base passes', async () => {
  const s = focusScenario(plain);
  const ok = await check(plain, ({ pub }) => {
    const p = path.join(pub, 'full', 'decisions', `${s.rec.id}.json`); const j = rj(p);
    j.focus = [...s.base].sort(); wj(p, j);
  }, { only: ['M11'] });
  assert.equal(ok.checks.M11.pass, true, JSON.stringify(ok.checks.M11.failures));
  assert.equal(ok.checks.M11.retrieval.focus_stored, 1);
});

test('D3: a stored focus that lacks the base focus (here the home province) fails', async () => {
  const s = focusScenario(plain);
  const home = [...s.base].find(x => x.startsWith('pq:'));
  const report = await check(plain, ({ pub }) => {
    const p = path.join(pub, 'full', 'decisions', `${s.rec.id}.json`); const j = rj(p);
    j.focus = [...s.base].filter(x => x !== home).sort(); wj(p, j);
  }, { only: ['M11'] });
  assert.ok(report.checks.M11.failures.some(f => f.code === 'focus_missing_base' && f.decision === s.rec.id && f.missing.includes(home)), JSON.stringify(report.checks.M11.failures.slice(0, 2)));
});

test('D3: an inbox sender\'s tag is a justified extra when a talk record addressed to the AI (or its nation) came from it at or before the decision; another citizen\'s tag is not', async () => {
  const s = focusScenario(plain);
  const stranger = 'abcdef0123456789';
  const report = await check(plain, ({ pub }) => {
    const p = path.join(pub, 'full', 'decisions', `${s.rec.id}.json`); const j = rj(p);
    j.focus = [...s.base, stranger].sort(); wj(p, j);
  }, { only: ['M11'] });
  assert.ok(report.checks.M11.failures.some(f => f.code === 'focus_extra_unjustified' && f.extras.includes(stranger)));
});

test('D3: part 2 that recomputed nothing is "not verified": no sampled decision, or sampled decisions without candidates', async () => {
  const none = await check(plain, ({ pub }) => {
    // every decision loses its opening data: the pool of opened model decisions with a retrieved set is empty
    for (const f of fs.readdirSync(path.join(pub, 'minds')).filter(n => /^\d+\.json$/.test(n))) { const p = path.join(pub, 'minds', f); const j = rj(p); for (const r of j.records) if (!r.sealed) { delete r.retrieved; r.choice.mem = []; } wj(p, j); }
    fs.rmSync(path.join(pub, 'open'), { recursive: true, force: true });
    fs.rmSync(path.join(pub, 'full', 'open'), { recursive: true, force: true });
  }, { only: ['M11'] });
  assert.equal(none.checks.M11.vacuous, true);
  assert.ok(none.checks.M11.unverified.some(u => u.field === 'retrieval'));
  assert.equal(none.checks.M11.pass, null);
});

// ================================================================ season end: redaction reaches the whole bundle; no key material in PUB
test('season end: the text of a redacted message is blanked in decisions, ledgers and summaries too (6.3), not only in request bodies; other files are copied verbatim', async () => {
  const { createAudit } = await import('../citizens/audit/season_end.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-fb3-se-'));
  try {
    cp(plain.state, path.join(dir, 'state'));
    fs.mkdirSync(path.join(dir, 'pub'), { recursive: true });
    fs.copyFileSync(path.join(plain.pub, 'redactions.json'), path.join(dir, 'pub', 'redactions.json'));
    const tag = plain.roster.ai[0].tag;
    fs.mkdirSync(path.join(dir, 'state', 'ledger'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state', 'ledger', `${tag}.json`), JSON.stringify({ v: 1, tag, note: 'they said REDACT-ME private words to me', goals: [] }));
    fs.mkdirSync(path.join(dir, 'state', 'summary', tag), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state', 'summary', tag, '50.txt'), 'A neighbour wrote REDACT-ME private words and I did not answer.');
    fs.writeFileSync(path.join(dir, 'state', 'summary', tag, '40.txt'), 'A quiet day.');
    const r = createAudit({ aiDir: dir }).publishSeasonEnd();
    assert.equal(r.published, true);
    const everything = [];
    const walk = d => { for (const n of fs.readdirSync(d)) { const f = path.join(d, n); if (fs.statSync(f).isDirectory()) walk(f); else everything.push(f); } };
    walk(path.join(dir, 'pub', 'full'));
    for (const f of everything) assert.ok(!fs.readFileSync(f, 'utf8').includes('REDACT-ME'), `${path.relative(dir, f)} still holds the redacted text`);
    const idx = rj(path.join(dir, 'pub', 'full', 'index.json'));
    assert.ok(idx.counts.decisions_blanked >= 1 && idx.counts.ledgers_blanked === 1 && idx.counts.summaries_blanked === 1, JSON.stringify(idx.counts));
    const sums = rj(path.join(dir, 'pub', 'full', 'memory', tag, 'summaries.json')).summaries;
    assert.equal(sums.find(x => x.bell === 50).redacted, true);
    assert.match(sums.find(x => x.bell === 50).text, /\[redacted\]/);
    assert.equal(sums.find(x => x.bell === 40).text, 'A quiet day.');
    assert.equal(sums.find(x => x.bell === 40).redacted, undefined);
    // a decision with no redacted text is the same bytes as before
    const clean = fs.readdirSync(path.join(plain.pub, 'full', 'decisions')).find(f => !fs.readFileSync(path.join(plain.state, 'requests', f), 'utf8').includes('REDACT-ME') && !JSON.stringify(rj(path.join(plain.pub, 'full', 'decisions', f))).includes('[redacted]'));
    assert.equal(fs.readFileSync(path.join(dir, 'pub', 'full', 'decisions', clean), 'utf8'), fs.readFileSync(path.join(plain.pub, 'full', 'decisions', clean), 'utf8'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('PUB holds no key material: not the registrar\'s secret key, not an AI session seed, no bearer token, in any published file (including PUB/full)', async () => {
  const bs58 = (await import('bs58')).default;
  const secret = Buffer.from(JSON.parse(fs.readFileSync(path.join(plain.root, 'keys', 'registrar.json'), 'utf8')));
  assert.equal(secret.length, 64);
  const crypto = await import('node:crypto');
  const R = await import('../citizens/registrar.mjs');
  const sessionSeed = (seed, index) => { const le64 = Buffer.alloc(8); le64.writeBigUInt64LE(BigInt(seed)); const le32 = Buffer.alloc(4); le32.writeUInt32LE(index); return crypto.createHash('sha256').update(Buffer.concat([Buffer.from('PS-FRONTIER-BOT-v1'), le64, le32, Buffer.from('session')])).digest(); };
  const stack = R.parseStackToml(fs.readFileSync(plain.stackPath, 'utf8'));
  const secrets = [secret, secret.subarray(0, 32), ...plain.roster.ai.map(a => sessionSeed(stack.bot_seed, a.index))];
  const needles = secrets.flatMap(b => [bs58.encode(b), b.toString('hex'), b.toString('base64'), `[${[...b.subarray(0, 8)].join(',')}`]);
  const files = [];
  const walk = d => { for (const n of fs.readdirSync(d)) { const f = path.join(d, n); if (fs.statSync(f).isDirectory()) walk(f); else files.push(f); } };
  walk(plain.pub);
  assert.ok(files.length > 100, `${files.length} published files scanned`);
  for (const f of files) {
    const text = fs.readFileSync(f, 'latin1');
    for (const n of needles) assert.ok(!text.includes(n), `${path.relative(plain.pub, f)} holds key material (${n.slice(0, 12)}...)`);
    assert.ok(!/Bearer\s+[A-Za-z0-9._-]{16,}/.test(text), `${path.relative(plain.pub, f)} holds a bearer token`);
    assert.ok(!/BEGIN (RSA |EC )?PRIVATE KEY/.test(text), `${path.relative(plain.pub, f)} holds a PEM key`);
  }
});

test('M3 notes a season-end bundle that was forced before the registrar\'s trigger', async () => {
  const report = await check(plain, ({ pub }) => { const p = path.join(pub, 'full', 'index.json'); const j = rj(p); j.forced = true; wj(p, j); }, { only: ['M3'] });
  assert.match((report.checks.M3.notes ?? []).join(' '), /forced: true/);
});
