// AC8: the checks M1, M2, M3 (with release openings), M7, M8, M9 and M11 PASS on a consistent mini run (test/fixtures/ai-audit-mini.mjs: the real
// decisions, episodes and herald log of slice-4 re-issued by the production registrar, records and season-end code on a fake chain, with the run's
// defects repaired and three synthetic decisions), and each of them FAILS on the tampers of the task: an edited episode, a mem id outside retrieved,
// an altered commit, a removed record, a changed anchor, a forged signature. The real slice-4 result of each check is pinned in
// citizens-audit-slice4.test.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAudit } from '../citizens/audit/season_end.mjs';
import { main, verifyMinds } from '../citizens/verify-minds.mjs';
import { canonical, sha256hex } from '../citizens/memory/config.mjs';
import { startFakeLlama } from './fixtures/ai-audit-doubles.mjs';
import { buildMiniRun, llmOutputOf } from './fixtures/ai-audit-mini.mjs';

const rj = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const wj = (p, v) => fs.writeFileSync(p, `${JSON.stringify(v)}\n`);
const codes = c => c.failures.map(f => f.code);
const cp = (from, to) => { if (fs.statSync(from).isDirectory()) { fs.mkdirSync(to, { recursive: true }); for (const n of fs.readdirSync(from)) cp(path.join(from, n), path.join(to, n)); } else fs.copyFileSync(from, to); };

let plain, withCouncil;
before(async () => {
  plain = await buildMiniRun({ council: false });
  withCouncil = await buildMiniRun({ council: true });
});
after(async () => { await plain?.close(); await withCouncil?.close(); });

/** Verify a COPY of a mini run's pub/ (and state/) after `edit({pub, state, dir})`; the chain, the herald and the git repo are shared. */
async function check(run, edit, { only = null, llm = null, ...extra } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-audit-copy-'));
  try {
    cp(run.pub, path.join(dir, 'pub'));
    cp(run.state, path.join(dir, 'state'));
    for (const f of ['stack.toml', 'ai-slots.json']) fs.copyFileSync(path.join(run.aiDir, f), path.join(dir, f));
    edit?.({ pub: path.join(dir, 'pub'), state: path.join(dir, 'state'), dir });
    return await verifyMinds({ ...run.verifyOpts({ llm, only, ...extra }), aiDir: path.join(dir, 'pub') });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
// a llama-server reports its context size and alias on /props; M9 compares them with the committed flags (-c 16384, --alias gemma-4-26b-a4b-it)
const PROPS = { default_generation_settings: { n_ctx: 16384 }, model_alias: 'gemma-4-26b-a4b-it' };
const withLlama = async (outputOf, f) => { const l = await startFakeLlama(outputOf, { props: PROPS }); try { return await f(l); } finally { await l.close(); } };

// ---------------------------------------------------------------- everything passes on the consistent run
test('every check PASSES on the mini run and the verdict is PASS (M9 against a fake llama-server that answers what the records committed to)', async () => {
  await withLlama(llmOutputOf, async llm => {
    const report = await check(plain, null, { llm: llm.url });
    for (const id of ['M1', 'M2', 'M3', 'M7', 'M8', 'M9', 'M11']) assert.equal(report.checks[id].pass, true, `${id}: ${JSON.stringify(report.checks[id].failures.slice(0, 2))}`);
    assert.equal(report.verdict, 'PASS');
    assert.equal(report.checks.M9.equal, report.checks.M9.compared);
    assert.equal(report.checks.M9.m9_excluded_redacted, 1, 'the redacted message\'s stored request is excluded and counted');
    assert.equal(report.checks.M3.sealed_records, 7);
    assert.equal(report.checks.M3.openings_checked_for_timing, 7, 'every sealed record was opened by the release job at its due bell');
    assert.equal(report.checks.M7.onboarding_exempt, 6);
    assert.ok(report.checks.M11.retrieval.sampled >= 14);
    assert.equal(report.checks.M1.unmeasured, undefined);
  });
});

test('the command line writes {v, run_id, checks, verdict}; a run of one check (--only M2) is INCOMPLETE (exit 3), never PASS (FB3 D1; citizens-audit-fb3.test.mjs pins the file rules)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-audit-cli-'));
  try {
    cp(plain.pub, path.join(dir, 'pub'));
    const out = [];
    const argv = ['--herald', plain.herald.url, '--rpc', 'http://127.0.0.1:1', '--ai-dir', path.join(dir, 'pub'), '--stack', plain.stackPath, '--no-write', '--quiet', '--only', 'M2'];
    // the CLI talks to a URL; the chain double is in-process, so the CLI is exercised on a check that needs no chain
    const code = await main(argv, { out: m => out.push(m), err: () => {} });
    assert.equal(code, 3, 'FB3: one check of seven is not a verdict');
    assert.equal(JSON.parse(out[0]).checks.M2.pass, true);
    assert.equal(JSON.parse(out[0]).verdict, 'INCOMPLETE');
    // the report file: {v, run_id, checks:{M2:{pass, n, failures}}, verdict}, written only where --out says for a partial run
    const outFile = path.join(dir, 'report.json');
    assert.equal(await main(['--herald', plain.herald.url, '--rpc', 'http://127.0.0.1:1', '--ai-dir', path.join(dir, 'pub'), '--stack', plain.stackPath, '--only', 'M2', '--out', outFile, '--quiet'], { out: () => {}, err: () => {} }), 3);
    const file = rj(outFile);
    assert.equal(file.v, 1);
    assert.equal(file.run_id, 'mini');
    assert.equal(file.verdict, 'INCOMPLETE');
    assert.equal(file.partial, true);
    assert.deepEqual(Object.keys(file.checks.M2).slice(0, 3), ['pass', 'n', 'failures']);
    assert.equal(await main(['--herald', 'http://example.com:80', '--rpc', 'http://127.0.0.1:1', '--ai-dir', dir], { out: () => {}, err: () => {} }), 2, 'a herald that is not on loopback is refused');
    assert.equal(await main(['--herald', plain.herald.url, '--rpc', 'http://10.0.0.1:8899', '--ai-dir', dir], { out: () => {}, err: () => {} }), 2, 'a chain that is not on loopback is refused');
    // without a llama-server the verdict is INCOMPLETE, never PASS
    const report = await check(plain, null);
    assert.equal(report.checks.M9.pass, null);
    assert.equal(report.verdict, 'INCOMPLETE');
    assert.equal(report.partial, undefined, 'all seven checks ran: this one is a full run that is incomplete for lack of an input');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- M1
test('M1 tamper: a forged registrar signature on the commitments', async () => {
  const report = await check(plain, ({ pub }) => {
    const j = rj(path.join(pub, 'commitments.json'));
    const raw = Buffer.from(j.sig, 'base64'); raw[3] ^= 1; j.sig = raw.toString('base64');
    const c = x => (x === null || typeof x !== 'object' ? JSON.stringify(x) : Array.isArray(x) ? `[${x.map(c).join(',')}]` : `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${c(x[k])}`).join(',')}}`);
    fs.writeFileSync(path.join(pub, 'commitments.json'), c(j));
  }, { only: ['M1'] });
  assert.ok(codes(report.checks.M1).includes('registrar_signature'));
});

test('M1 tamper: a model file or a llama tree that is not the committed one', async () => {
  const other = path.join(os.tmpdir(), `other-model-${process.pid}.gguf`);
  fs.writeFileSync(other, 'different weights');
  try {
    const report = await check(plain, null, { only: ['M1'], modelPath: other });
    assert.ok(codes(report.checks.M1).includes('model_sha256'));
  } finally { fs.rmSync(other, { force: true }); }
  const llamaCopy = path.join(os.tmpdir(), `llama-copy-${process.pid}`);
  cp(plain.llamaDir, llamaCopy);
  fs.writeFileSync(path.join(llamaCopy, 'libllama.dylib'), 'a rebuilt library');
  try {
    const report = await check(plain, null, { only: ['M1'], llamaDir: llamaCopy });
    assert.ok(codes(report.checks.M1).includes('server_tree_sha256'));
  } finally { fs.rmSync(llamaCopy, { recursive: true, force: true }); }
});

test('M1 tamper: a changed stack config, citizens config or slots file no longer hashes to the commitments', async () => {
  const stack = path.join(os.tmpdir(), `stack-${process.pid}.toml`);
  fs.writeFileSync(stack, `${fs.readFileSync(plain.stackPath, 'utf8')}# edited\n`);
  const cfg = path.join(os.tmpdir(), `cfg-${process.pid}.json`);
  fs.writeFileSync(cfg, `${fs.readFileSync(plain.citizensConfigPath, 'utf8')} `);
  try {
    const r1 = await check(plain, null, { only: ['M1'], stackPath: stack });
    assert.ok(r1.checks.M1.failures.some(f => f.code === 'config_hash' && f.field === 'stack_toml_sha256'));
    const r2 = await check(plain, null, { only: ['M1'], citizensConfig: cfg });
    assert.ok(r2.checks.M1.failures.some(f => f.code === 'config_hash' && f.field === 'citizens_config_sha256'));
  } finally { fs.rmSync(stack, { force: true }); fs.rmSync(cfg, { force: true }); }
});

test('M1 tamper: a commit memo whose text is not the file\'s hash, and a commitments file edited after the memo', async () => {
  const report = await check(plain, ({ pub }) => {
    const p = path.join(pub, 'anchors', 'commit.json');
    const j = rj(p); j.signature = rj(path.join(pub, 'anchors', '20.json')).signature; wj(p, j); // a real memo of another text
  }, { only: ['M1'] });
  assert.ok(codes(report.checks.M1).includes('commit_memo_text'));
});

test('M1: a run whose commit memo came after genesis is reported (the run is unaudited)', async () => {
  const late = await buildMiniRun({ council: false, commitLate: true });
  try {
    const report = await verifyMinds({ ...late.verifyOpts({ only: ['M1'] }) });
    assert.ok(codes(report.checks.M1).includes('commit_after_genesis'));
    assert.ok(codes(report.checks.M1).includes('commit_anchor_status') === false, 'the anchor file already says unaudited');
  } finally { await late.close(); }
});

test('M1: "unmeasured" fields are printed as unmeasured and the check is never PASS (7.1, R9)', async () => {
  const run = await buildMiniRun({ council: false, unmeasured: true });
  try {
    const report = await verifyMinds({ ...run.verifyOpts({ only: ['M1'] }) });
    assert.equal(report.checks.M1.pass, null);
    assert.deepEqual(report.checks.M1.unmeasured.map(u => u.field).sort(), ['model.sha256', 'server.tree_sha256']);
    assert.equal(report.verdict, 'INCOMPLETE');
  } finally { await run.close(); }
});

test('M1 tamper: a commit that is not in the repository is refused', async () => {
  const report = await check(plain, ({ pub }) => {
    const j = rj(path.join(pub, 'commitments.json'));
    j.code.git_commit = '0'.repeat(40);
    wj(path.join(pub, 'commitments.json'), j);
  }, { only: ['M1'] });
  assert.ok(codes(report.checks.M1).includes('git_commit_unknown'));
});

// ---------------------------------------------------------------- M3 openings (7.2)
const openFiles = pub => fs.readdirSync(path.join(pub, 'open')).map(n => Number(n.replace('.json', ''))).sort((a, b) => a - b);

test('M3: a sealed record never opened, opened too early, or opened more than 2 bells after it was due', async () => {
  let victim;
  const gone = await check(plain, ({ pub }) => {
    const b = openFiles(pub)[0];
    const f = rj(path.join(pub, 'open', `${b}.json`));
    victim = f.records[0].id;
    f.records.shift();
    wj(path.join(pub, 'open', `${b}.json`), f);
    fs.rmSync(path.join(pub, 'full', 'open', `${victim}.json`), { force: true });
  }, { only: ['M3'] });
  assert.ok(gone.checks.M3.failures.some(f => f.code === 'sealed_not_opened' && f.decision === victim));
  const early = await check(plain, ({ pub }) => { const b = openFiles(pub)[0]; fs.renameSync(path.join(pub, 'open', `${b}.json`), path.join(pub, 'open', `${b - 1}.json`)); }, { only: ['M3'] });
  assert.ok(codes(early.checks.M3).includes('opened_early'));
  const late = await check(plain, ({ pub }) => { const b = openFiles(pub)[0]; fs.renameSync(path.join(pub, 'open', `${b}.json`), path.join(pub, 'open', `${b + 3}.json`)); }, { only: ['M3'] });
  assert.ok(codes(late.checks.M3).includes('opened_late'));
  const ok = await check(plain, ({ pub }) => { const b = openFiles(pub)[0]; fs.renameSync(path.join(pub, 'open', `${b}.json`), path.join(pub, 'open', `${b + 2}.json`)); }, { only: ['M3'] });
  assert.ok(!codes(ok.checks.M3).includes('opened_late') && !codes(ok.checks.M3).includes('opened_early'), 'two bells late is within the allowance');
});

test('M3: an altered commit (choice, text, retrieved set or nonce of the opening) fails; so does an altered candidate list', async () => {
  const mutate = f => async () => (await check(plain, ({ pub }) => {
    const b = openFiles(pub)[0];
    const file = rj(path.join(pub, 'open', `${b}.json`));
    f(file.records[0]);
    wj(path.join(pub, 'open', `${b}.json`), file);
  }, { only: ['M3'] })).checks.M3;
  assert.ok(codes(await mutate(o => { o.choice.ids = ['c9']; })()).includes('commit_mismatch'));
  assert.ok(codes(await mutate(o => { o.public.why = `${o.public.why} (edited)`; })()).includes('commit_mismatch'));
  assert.ok(codes(await mutate(o => { o.retrieved = [...o.retrieved, '0'.repeat(16)]; })()).includes('commit_mismatch'));
  assert.ok(codes(await mutate(o => { o.nonce = '00'.repeat(16); })()).includes('commit_mismatch'));
  assert.ok(codes(await mutate(o => { o.candidates[0].label = 'something else'; })()).includes('candidates_hash'));
  assert.ok(codes(await mutate(o => { o.release_bell += 1; })()).includes('release_bell_changed'));
});

test('M3: an opened destination that is not the public REVEAL fails; the real arrival bell is shown next to the plan', async () => {
  const c = (await check(plain, ({ pub }) => {
    const b = openFiles(pub)[0];
    const file = rj(path.join(pub, 'open', `${b}.json`));
    const d = file.records[0].destinations[0];
    assert.ok(Number.isInteger(d.planned_arrive_bell) && Number.isInteger(d.arrive_bell));
    d.tile = (d.tile + 1) % 60;
    wj(path.join(pub, 'open', `${b}.json`), file);
  }, { only: ['M3'] })).checks.M3;
  assert.ok(codes(c).includes('destination_mismatch'));
});

test('M3: a removed record, a changed anchor, a missing anchor, an anchor memo not on chain, a record whose content was edited', async () => {
  const removed = await check(plain, ({ pub }) => { const p = path.join(pub, 'minds', '40.json'); const j = rj(p); j.records.pop(); wj(p, j); }, { only: ['M3'] });
  assert.ok(codes(removed.checks.M3).includes('minds_root_mismatch') && codes(removed.checks.M3).includes('anchor_minds_root'));
  const changed = await check(plain, ({ pub }) => { const p = path.join(pub, 'anchors', '41.json'); const j = rj(p); j.social_root = 'b'.repeat(64); wj(p, j); }, { only: ['M3'] });
  assert.ok(codes(changed.checks.M3).includes('anchor_social_root') && codes(changed.checks.M3).includes('anchor_memo_text'));
  const missing = await check(plain, ({ pub }) => fs.rmSync(path.join(pub, 'anchors', '42.json')), { only: ['M3'] });
  assert.ok(codes(missing.checks.M3).includes('gap_anchor'));
  const gap = await check(plain, ({ pub }) => { const p = path.join(pub, 'anchors', '43.json'); wj(p, { bell: 43, social_root: 'a'.repeat(64), minds_root: null, signature: null, slot: null, anchor_gap: true, reason: 'x' }); }, { only: ['M3'] });
  assert.ok(codes(gap.checks.M3).includes('anchor_gap'));
  const notOn = await check(plain, ({ pub }) => { const p = path.join(pub, 'anchors', '44.json'); const j = rj(p); j.signature = bs(88); wj(p, j); }, { only: ['M3'] });
  assert.ok(codes(notOn.checks.M3).includes('anchor_not_on_chain'));
  const edited = await check(plain, ({ pub }) => {
    const f = fs.readdirSync(path.join(pub, 'minds')).filter(n => /^\d+\.json$/.test(n)).find(n => rj(path.join(pub, 'minds', n)).records.length);
    const p = path.join(pub, 'minds', f); const j = rj(p);
    j.records[0].reason = 'edited'; wj(p, j);
  }, { only: ['M3'] });
  assert.ok(codes(edited.checks.M3).includes('record_id_mismatch'));
});
const bs = n => '3'.repeat(n);

test('M3: a record in a talk file whose signature or bytes were changed no longer hashes to its inner; a changed leaf breaks the social root', async () => {
  const sig = await check(plain, ({ pub }) => {
    const p = path.join(pub, 'talk', '30.json'); const j = rj(p);
    const raw = Buffer.from(j.records[0].sig_b64, 'base64'); raw[0] ^= 0xff; j.records[0].sig_b64 = raw.toString('base64');
    wj(p, j);
  }, { only: ['M3'] });
  assert.ok(codes(sig.checks.M3).includes('inner_mismatch'), 'a forged signature');
  const leaf = await check(plain, ({ pub }) => { const p = path.join(pub, 'talk', '30.json'); const j = rj(p); j.records[0].inner = 'c'.repeat(64); wj(p, j); }, { only: ['M3'] });
  assert.ok(codes(leaf.checks.M3).includes('social_root_mismatch'));
});

test('M3 council: every ballot\'s bytes hash to its earlier leaf and every call_commit opens', async () => {
  const run = withCouncil;
  const ok = await check(run, null, { only: ['M3', 'M8'] });
  assert.equal(ok.checks.M3.pass, true, JSON.stringify(ok.checks.M3.failures));
  assert.equal(ok.checks.M8.pass, true, JSON.stringify(ok.checks.M8.failures));
  assert.equal(ok.checks.M8.ai_records_checked, 2, 'a world message and a ballot');
  const bytes = await check(run, ({ pub }) => { const p = path.join(pub, 'council', '0-1.json'); const j = rj(p); const raw = Buffer.from(j.open.ballots[0].bytes_b64, 'base64'); raw[raw.length - 1] ^= 1; j.open.ballots[0].bytes_b64 = raw.toString('base64'); wj(p, j); }, { only: ['M3'] });
  assert.ok(codes(bytes.checks.M3).includes('ballot_bytes_inner'));
  const leaf = await check(run, ({ pub }) => {
    const p = path.join(pub, 'talk', '28.json'); const j = rj(p); j.records = []; j.root = '0'.repeat(64); wj(p, j);
  }, { only: ['M3'] });
  assert.ok(codes(leaf.checks.M3).includes('ballot_leaf_missing'));
  const commit = await check(run, ({ pub }) => { const p = path.join(pub, 'council', '0-1.json'); const j = rj(p); j.open.nonce = 'ee'.repeat(32); wj(p, j); }, { only: ['M3'] });
  assert.ok(codes(commit.checks.M3).includes('call_commit_mismatch'));
  const opt = await check(run, ({ pub }) => { const p = path.join(pub, 'council', '0-1.json'); const j = rj(p); j.open.option = 3; wj(p, j); }, { only: ['M3'] });
  assert.ok(codes(opt.checks.M3).includes('call_commit_mismatch'));
  const notOpened = await check(run, ({ pub }) => { const p = path.join(pub, 'council', '0-1.json'); const j = rj(p); delete j.open; wj(p, j); }, { only: ['M3'] });
  assert.ok(codes(notOpened.checks.M3).includes('call_not_opened'));
});

// ---------------------------------------------------------------- M2
test('M2 tamper: a changed deal field, a forged roster signature, a changed script-bot list', async () => {
  const deal = await check(plain, ({ pub }) => { const p = path.join(pub, 'roster.json'); const j = rj(p); j.ai[2].creed_variant = (j.ai[2].creed_variant + 1) % 6; wj(p, j); }, { only: ['M2'] });
  assert.ok(codes(deal.checks.M2).includes('deal_mismatch') && codes(deal.checks.M2).includes('roster_signature'));
  const sig = await check(plain, ({ pub }) => { const p = path.join(pub, 'roster.json'); const j = rj(p); const raw = Buffer.from(j.sig, 'base64'); raw[1] ^= 4; j.sig = raw.toString('base64'); wj(p, j); }, { only: ['M2'] });
  assert.deepEqual(codes(sig.checks.M2), ['roster_signature']);
  const script = await check(plain, ({ pub }) => { const p = path.join(pub, 'roster.json'); const j = rj(p); j.script.wallets[3] = j.script.wallets[4]; wj(p, j); }, { only: ['M2'] });
  assert.ok(codes(script.checks.M2).includes('script_wallets'));
  const seed = await check(plain, ({ pub }) => { const p = path.join(pub, 'roster.json'); const j = rj(p); j.genesis_seed = '00'.repeat(32); wj(p, j); }, { only: ['M2'] });
  assert.ok(codes(seed.checks.M2).includes('genesis_seed'));
});

// ---------------------------------------------------------------- M7
test('M7: exactly one record per session-signed transaction; a removed tx, a doubled tx and a listed signature that is not on chain fail', async () => {
  const gone = await check(plain, ({ pub }) => { const p = path.join(pub, 'minds', '40.json'); const j = rj(p); j.records.find(r => r.tx?.length).tx = []; wj(p, j); }, { only: ['M7'] });
  assert.ok(gone.checks.M7.failures.some(f => f.code === 'orphan_chain_tx'));
  const twice = await check(plain, ({ pub }) => { const p = path.join(pub, 'minds', '40.json'); const j = rj(p); const [a, b] = j.records.filter(r => r.tx?.length); b.tx = [...b.tx, a.tx[0]]; wj(p, j); }, { only: ['M7'] });
  assert.ok(twice.checks.M7.failures.some(f => f.code === 'tx_in_many_records' || f.code === 'tx_in_other_ais_record'));
  const phantom = await check(plain, ({ pub }) => { const p = path.join(pub, 'minds', '40.json'); const j = rj(p); j.records.find(r => r.tx?.length).tx.push({ intent: 'build', sig: bs(88), status: 'sent', code: null }); wj(p, j); }, { only: ['M7'] });
  assert.ok(phantom.checks.M7.failures.some(f => f.code === 'listed_signature_not_on_chain'));
  const strict = await check(plain, null, { only: ['M7'], strictOnboarding: true });
  assert.equal(strict.checks.M7.failures.filter(f => f.code === 'orphan_chain_tx').length, 6, 'the six onboarding FileTickets count when strict');
});

test('M7: a late tx update (PUB/minds/late) counts as the same record\'s transaction, not a second one', async () => {
  const report = await check(plain, ({ pub }) => {
    const p = path.join(pub, 'minds', '40.json'); const j = rj(p);
    const r = j.records.find(x => x.tx?.length);
    fs.mkdirSync(path.join(pub, 'minds', 'late'), { recursive: true });
    wj(path.join(pub, 'minds', 'late', '40.json'), { bell: 40, entries: [{ id: r.id, tx: r.tx }] });
  }, { only: ['M7'] });
  assert.equal(report.checks.M7.pass, true, JSON.stringify(report.checks.M7.failures));
});

// ---------------------------------------------------------------- M8
test('M8 tamper: a text that is not the mind\'s signed-ready output, an origin that is not AI, a forged signature, a decision of another AI, a ballot under the wrong decision', async () => {
  const text = await check(plain, ({ pub }) => {
    const dir = path.join(pub, 'full', 'decisions');
    for (const f of fs.readdirSync(dir)) { const d = rj(path.join(dir, f)); if (d.social?.talk?.[0]?.text === 'Greetings from the north.') { d.social.talk[0].text = 'Something else.'; wj(path.join(dir, f), d); } }
  }, { only: ['M8'] });
  assert.ok(codes(text.checks.M8).includes('text_differs_from_mind_output'));
  const forged = await check(plain, ({ pub }) => {
    const p = path.join(pub, 'talk', '30.json'); const j = rj(p);
    const raw = Buffer.from(j.records[0].sig_b64, 'base64'); raw[5] ^= 1; j.records[0].sig_b64 = raw.toString('base64'); wj(p, j);
  }, { only: ['M8'] });
  assert.ok(codes(forged.checks.M8).includes('bad_signature'));
  const other = await check(plain, ({ pub }) => {
    const p = path.join(pub, 'full', 'social.json'); const j = rj(p);
    const mine = j.records.find(r => r.bell === 30);
    const dec = fs.readdirSync(path.join(pub, 'full', 'decisions')).map(f => rj(path.join(pub, 'full', 'decisions', f))).find(d => d.ai && d.ai !== rj(path.join(pub, 'roster.json')).ai.find(a => a.index === 1000).tag && d.mode === 'model');
    mine.decision_id = dec.id; wj(p, j);
  }, { only: ['M8'] });
  assert.ok(codes(other.checks.M8).includes('decision_of_another_ai'));
  const twice = await check(withCouncil, ({ pub }) => {
    const p = path.join(pub, 'full', 'social.json'); const j = rj(p);
    const talk = j.records.find(r => r.bell === 30);
    j.records.find(r => r.type === 'ballot').decision_id = talk.decision_id; // a second use of the same decision
    wj(p, j);
  }, { only: ['M8'] });
  assert.ok(codes(twice.checks.M8).includes('duplicate_use'), 'a ballot posted under a world message\'s decision (item 0 twice) is a duplicate use (FB3: the pair is (decision_id, item) whatever the type)');
  const noTable = await check(plain, ({ pub }) => fs.rmSync(path.join(pub, 'full', 'social.json')), { only: ['M8'] });
  assert.ok(codes(noTable.checks.M8).includes('no_provenance_table'));
});

test('M8 origin: an AI wallet\'s record that says origin 0 (human-written) fails', async () => {
  // re-sign nothing: the bytes of the world message are re-encoded with origin 0 and signed with the AI\'s own session key (the verifier must still refuse it)
  const { encodeTalk, toBase64, toHex, innerOf, fromBase64, decode } = await import('../../permutation-server/web/frontier/council/aisocial.mjs');
  const R = await import('../citizens/registrar.mjs');
  const crypto = await import('node:crypto');
  const report = await check(plain, ({ pub }) => {
    const p = path.join(pub, 'talk', '30.json'); const j = rj(p);
    const d = decode(fromBase64(j.records[0].bytes_b64));
    const bytes = encodeTalk({ ...d, origin: 0 });
    const le64 = Buffer.alloc(8); le64.writeBigUInt64LE(41n); const le32 = Buffer.alloc(4); le32.writeUInt32LE(1000);
    const seed = crypto.createHash('sha256').update(Buffer.concat([Buffer.from('PS-FRONTIER-BOT-v1'), le64, le32, Buffer.from('session')])).digest();
    const sig = R.signBytes(seed, bytes);
    j.records[0] = { ...j.records[0], bytes_b64: toBase64(bytes), sig_b64: toBase64(sig), inner: toHex(innerOf(bytes, sig)) };
    wj(p, j);
  }, { only: ['M8'] });
  assert.ok(codes(report.checks.M8).includes('origin_not_ai'));
});

// ---------------------------------------------------------------- M9
test('M9: 1 of 15 outputs differing is within the 18-of-20 allowance and is listed; 3 of 15 fail the check', async () => {
  const differ = new Set();
  const out = (n) => (body) => { if (differ.size < n && !differ.has(body)) differ.add(body); return differ.has(body) ? 'DIFFERENT OUTPUT' : llmOutputOf(body); };
  differ.clear();
  const one = await withLlama(out(1), llm => check(plain, null, { only: ['M9'], llm: llm.url }));
  assert.equal(one.checks.M9.pass, true);
  assert.equal(one.checks.M9.mismatches.length, 1);
  assert.equal(one.checks.M9.equal, one.checks.M9.compared - 1);
  differ.clear();
  const three = await withLlama(out(3), llm => check(plain, null, { only: ['M9'], llm: llm.url }));
  assert.equal(three.checks.M9.pass, false);
  assert.ok(codes(three.checks.M9).includes('replay_below_threshold'));
  assert.equal(three.checks.M9.mismatches.length, 3);
});

test('M9: a stored body edited after the run fails offline (its hash is no longer the record\'s request_hash); an unreachable llama-server lists errors', async () => {
  const seed = await check(plain, ({ pub }) => {
    const dir = path.join(pub, 'full', 'requests');
    for (const f of fs.readdirSync(dir)) { const b = rj(path.join(dir, f)); b.seed += 1; fs.writeFileSync(path.join(dir, f), JSON.stringify(b)); }
  }, { only: ['M9'] });
  assert.ok(codes(seed.checks.M9).includes('request_hash_mismatch'), 'the body no longer hashes to request_hash');
  const dead = await check(plain, null, { only: ['M9'], llm: 'http://127.0.0.1:1' });
  assert.equal(dead.checks.M9.pass, false);
  assert.ok(dead.checks.M9.mismatches.every(m => m.error));
});

test('M9: a llama-server whose /props show another context size or alias than the committed flags is refused', async () => {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/props') res.end(JSON.stringify({ default_generation_settings: { n_ctx: 4096 }, model_alias: 'some-other-model' }));
      else res.end(JSON.stringify({ choices: [{ message: { content: llmOutputOf(body) }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const report = await check(plain, null, { only: ['M9'], llm: `http://127.0.0.1:${server.address().port}` });
    assert.equal(report.checks.M9.pass, false);
    assert.equal(report.checks.M9.failures.filter(f => f.code === 'llm_flags').length, 2);
    assert.equal(report.checks.M9.llm_props.n_ctx, 4096);
  } finally { server.closeAllConnections?.(); await new Promise(r => server.close(r)); }
});

test('M9: a body redacted at season end is excluded from the sample and counted, and never fails the check', async () => {
  const report = await check(plain, null, { only: ['M9'] });
  assert.equal(report.checks.M9.m9_excluded_redacted, 1);
  assert.ok(!codes(report.checks.M9).includes('request_missing'));
  const blanked = fs.readdirSync(path.join(plain.pub, 'full', 'requests')).map(f => rj(path.join(plain.pub, 'full', 'requests', f))).filter(b => b.redacted);
  assert.equal(blanked.length, 1);
  assert.equal(typeof blanked[0].request_hash, 'string');
  assert.ok(!fs.readFileSync(path.join(plain.pub, 'full', 'requests', fs.readdirSync(path.join(plain.pub, 'full', 'requests')).find(f => rj(path.join(plain.pub, 'full', 'requests', f)).redacted)), 'utf8').includes('REDACT-ME'));
});

// ---------------------------------------------------------------- M11
test('M11 tamper: an edited episode, an episode removed, a retrieved set that is not what retrieve() gives, a mem id outside retrieved', async () => {
  const sha = list => sha256hex(canonical([...list].sort((a, b) => a.created_bell - b.created_bell || a.bell - b.bell || (a.id < b.id ? -1 : 1))));
  const edit = fn => ({ pub }) => { for (const t of fs.readdirSync(path.join(pub, 'memory'))) { const p = path.join(pub, 'memory', t, 'episodes.json'); const j = rj(p); fn(j); j.sha256 = sha(j.episodes); j.count = j.episodes.length; wj(p, j); } };
  const edited = await check(plain, edit(j => { j.episodes[0].text.en += ' (edited)'; }), { only: ['M11'] });
  assert.ok(edited.checks.M11.failures.some(f => f.code === 'episodes_mismatch' && f.changed.length));
  const removed = await check(plain, edit(j => { j.episodes.shift(); }), { only: ['M11'] });
  assert.ok(removed.checks.M11.failures.some(f => f.code === 'episodes_mismatch' && f.missing_in_published.length));
  const added = await check(plain, edit(j => { j.episodes.push({ ...j.episodes[0], id: 'f'.repeat(16), bell: 3, created_bell: 4 }); }), { only: ['M11'] });
  assert.ok(added.checks.M11.failures.some(f => f.code === 'episodes_mismatch' && f.extra_in_published.length));
  const retr = await check(plain, ({ pub }) => {
    for (const f of fs.readdirSync(path.join(pub, 'minds')).filter(n => /^\d+\.json$/.test(n))) {
      const p = path.join(pub, 'minds', f); const j = rj(p);
      const r = j.records.find(x => x.mode === 'model' && !x.sealed && x.retrieved?.length > 1);
      if (r) { r.retrieved = r.retrieved.slice(0, -1); wj(p, j); return; } // the newest episode dropped: not a budget cut (the newest 3 are protected)
    }
    throw new Error('no unsealed model decision with 2+ retrieved ids in the mini run');
  }, { only: ['M11'] });
  assert.ok(codes(retr.checks.M11).includes('retrieved_mismatch'));
  const mem = await check(plain, ({ pub }) => {
    for (const f of fs.readdirSync(path.join(pub, 'minds')).filter(n => /^\d+\.json$/.test(n))) {
      const p = path.join(pub, 'minds', f); const j = rj(p);
      const r = j.records.find(x => x.mode === 'model' && !x.sealed);
      if (r) { r.choice.mem = ['0123456789abcdef']; wj(p, j); return; }
    }
  }, { only: ['M11'] });
  assert.ok(mem.checks.M11.failures.some(f => f.code === 'mem_outside_retrieved'));
});

// ---------------------------------------------------------------- season end
test('season end: openings only for records whose release did not happen; M3 then reports them as opened late with the commitment verified', async () => {
  const report = await check(plain, ({ pub, state }) => {
    fs.rmSync(path.join(pub, 'open'), { recursive: true, force: true });
    fs.rmSync(path.join(pub, 'full'), { recursive: true, force: true });
    const j = path.join(state, 'records.jsonl');
    fs.writeFileSync(j, fs.readFileSync(j, 'utf8').split('\n').filter(l => !l.includes('"op":"opened"')).join('\n'));
    const r = createAudit({ aiDir: path.dirname(pub) }).publishSeasonEnd();
    assert.equal(r.unreleased, 7);
    assert.equal(r.opened_at_season_end, 7);
  }, { only: ['M3'] });
  const c = report.checks.M3;
  assert.equal(c.failures.filter(f => f.code === 'opened_late').length, 7);
  assert.ok(!codes(c).includes('commit_mismatch'));
});

test('season end: a released record is not opened again; the bundle lists every file with its sha256; social.json carries the routing fields and no text', async () => {
  const idx = rj(path.join(plain.pub, 'full', 'index.json'));
  assert.equal(idx.unreleased.length, 0);
  assert.equal(idx.released.length, 7);
  for (const f of idx.files) assert.equal(sha256hex(fs.readFileSync(path.join(plain.pub, f.path), 'utf8')), f.sha256, f.path);
  const social = rj(path.join(plain.pub, 'full', 'social.json'));
  assert.equal(social.records.length, 2);
  assert.ok(!JSON.stringify(social).includes('Greetings'));
  const red = social.records.find(r => r.redacted);
  assert.ok(red && red.inner === plain.redactedInner && red.channel === 0 && red.decision_id);
  assert.equal(fs.existsSync(path.join(plain.pub, 'full', 'open')), false, 'nothing to open at season end');
});

test('season end: watch() publishes once when the trigger file appears, and publishSeasonEnd without a trigger says so', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-audit-watch-'));
  try {
    cp(plain.state, path.join(dir, 'state'));
    fs.mkdirSync(path.join(dir, 'pub'), { recursive: true });
    fs.rmSync(path.join(dir, 'state', 'season-end.json'), { force: true });
    const audit = createAudit({ aiDir: dir });
    assert.equal(audit.publishSeasonEnd().published, false);
    let tick = null;
    const done = [];
    const stop = audit.watch({ setIntervalFn: f => { tick = f; return { unref() {} }; }, clearIntervalFn: () => {}, onDone: r => done.push(r) });
    tick();
    assert.equal(done.length, 0, 'no trigger yet');
    fs.writeFileSync(path.join(dir, 'state', 'season-end.json'), JSON.stringify({ v: 1, season: 41, last_bell: 72 }));
    tick(); tick();
    assert.equal(done.length, 1, 'published once');
    assert.equal(done[0].published, true);
    stop();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('season end redaction: a stored request that holds the text of a redacted message is blanked (with its request_hash), others are copied verbatim', async () => {
  const dir = path.join(plain.state, 'requests');
  const n = fs.readdirSync(dir).length;
  const blanked = fs.readdirSync(path.join(plain.pub, 'full', 'requests')).filter(f => rj(path.join(plain.pub, 'full', 'requests', f)).redacted);
  assert.equal(blanked.length, 1);
  assert.equal(fs.readdirSync(path.join(plain.pub, 'full', 'requests')).length, n);
  for (const f of fs.readdirSync(dir)) {
    const orig = fs.readFileSync(path.join(dir, f), 'utf8'), pubd = fs.readFileSync(path.join(plain.pub, 'full', 'requests', f), 'utf8');
    if (blanked.includes(f)) assert.equal(rj(path.join(plain.pub, 'full', 'requests', f)).request_hash, sha256hex(orig));
    else assert.equal(pubd, orig);
  }
});
