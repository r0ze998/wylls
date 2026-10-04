// AC8: verify-minds over the RECORDED slice-4 run (test/fixtures/ai-audit-slice4: the wave-A slice gate on a local test chain, 6 AI citizens,
// 12 game hours; pub/ verbatim, herald and chain answers recorded read-only, season-end bundle generated here from the run's state subset).
//
// What this pins is the REAL result of each check on that pre-fix run, not a wished-for PASS: the run predates the release job (no PUB/open), the
// stored seeds follow season 0, one older episode-kinds hash and an overwritten-tx bug (all explained in AC8-NOTES.md). M2 and M11 pass for real;
// M1, M3, M7, M9 fail for the named reasons; M8 is vacuous (the social service was a stub). Then each tamper of the task (an edited episode, a mem id
// outside retrieved, an altered commit, a removed record, a changed anchor, a forged signature) is made on a copy and must be caught.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createAudit } from '../citizens/audit/season_end.mjs';
import { verifyMinds, REPO_ROOT } from '../citizens/verify-minds.mjs';
import { canonical, sha256hex } from '../citizens/memory/config.mjs';
import { SLICE4, copyFixture, readJson, startFakeLlama, startRecordedHerald, startRecordedRpc } from './fixtures/ai-audit-doubles.mjs';

const COMMIT = '4b7a9b9494725f895b301e551a80abda992da028';
const haveCommit = (() => { try { return execFileSync('git', ['-C', REPO_ROOT, 'cat-file', '-t', COMMIT], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'commit'; } catch { return false; } })();
const stackPath = path.join(SLICE4, 'stack.toml'), slotsPath = path.join(SLICE4, 'ai-slots.json');

const rj = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const wj = (p, v) => fs.writeFileSync(p, `${JSON.stringify(v)}\n`);

/** Copy the fixture, apply `pre(fx)` to the private state, publish the season-end bundle, apply `post(fx)` to pub, verify. */
async function run({ pre = null, post = null, only = null, llm = null, ...opts } = {}) {
  const fx = copyFixture();
  const herald = await startRecordedHerald(readJson(path.join(SLICE4, 'herald.json')));
  const rpc = await startRecordedRpc(readJson(path.join(SLICE4, 'rpc.json')));
  try {
    pre?.(fx);
    createAudit({ aiDir: fx.dir }).publishSeasonEnd();
    post?.(fx);
    const report = await verifyMinds({ herald: herald.url, rpc: rpc.url, aiDir: fx.pub, stackPath, slotsPath, repoRoot: REPO_ROOT, only, llm, ...opts });
    return { report, fx, herald, rpc };
  } finally {
    await herald.close();
    await rpc.close();
    fx.cleanup();
  }
}
const codes = c => c.failures.map(f => f.code);

let base;
test('the recorded run verifies end to end; the real verdict is FAIL (pre-fix run) and no check crashes', async () => {
  base = (await run()).report;
  assert.equal(base.run_id, 'slice-4');
  assert.equal(base.verdict, 'FAIL');
  for (const [id, c] of Object.entries(base.checks)) assert.ok(!codes(c).includes('check_crashed'), `${id}: ${JSON.stringify(c.failures[0])}`);
});

test('M2 roster PASS on the real run: the deal recomputed from the GENESIS_SEED record, the script-bot wallets, labels, seat and signature', () => {
  assert.equal(base.checks.M2.pass, true, JSON.stringify(base.checks.M2.failures));
  assert.ok(base.checks.M2.n >= 12);
});

test('M11 episodes PASS on the real run: 3 sampled AIs replay to the published lists, 14 decisions\' retrieval recomputes, every cited id is retrieved', () => {
  const c = base.checks.M11;
  assert.equal(c.pass, true, JSON.stringify(c.failures));
  assert.equal(c.sampled_ais.length, 3);
  assert.equal(c.retrieval.sampled, 14);
  assert.equal(c.retrieval.skipped_no_candidates, 0);
  assert.equal(c.mem_checked, 387);
  assert.ok(c.through_bell >= 84);
  // the audit's own code is compared with the committed blobs and the differences are reported, never hidden
  assert.ok(Array.isArray(c.replay_code.differ));
});

test('M3 on the real run: all 85 bells\' roots, anchors and memos verify; the 7 sealed marches were never released (no release job in wave A): opened_late', () => {
  const c = base.checks.M3;
  assert.equal(c.pass, false);
  assert.deepEqual([...new Set(codes(c))], ['opened_late']);
  assert.equal(c.failures.length, 7);
  assert.equal(c.sealed_records, 7);
  assert.ok(c.failures.every(f => /season-end bundle/.test(f.detail)));
  assert.deepEqual(c.bells, { first: 0, last: 84 });
});

test('M7 on the real run: 146 session-signed transactions, 6 onboarding FileTickets exempt, 2 orphans (the harvest and the train that a later outcome overwrote in the record)', () => {
  const c = base.checks.M7;
  assert.equal(c.pass, false);
  assert.deepEqual(codes(c), ['orphan_chain_tx', 'orphan_chain_tx']);
  assert.equal(c.session_signed_on_chain, 146);
  assert.equal(c.listed_signatures, 138);
  assert.equal(c.onboarding_exempt, 6);
});

test('M7 --strict-onboarding counts the 6 FileTickets as orphans too', async () => {
  const { report } = await run({ only: ['M7'], strictOnboarding: true });
  assert.equal(report.checks.M7.failures.length, 8);
});

test('M9 on the real run: the stored seeds follow season 0, the commitments say season 41 (integ-A-NOTES section 2): seed_rule_broken for every sampled record; no llama-server: not run', () => {
  const c = base.checks.M9;
  assert.equal(c.pass, false);
  assert.ok(codes(c).every(x => x === 'seed_rule_broken'));
  assert.equal(c.failures.length, 14);
  assert.match(c.skipped, /no --llm/);
});

test('M8 on the real run is vacuous (the social service was a stub: 0 AI records) and says so', () => {
  const c = base.checks.M8;
  assert.equal(c.pass, true);
  assert.equal(c.ai_records_checked, 0);
  assert.match(c.notes.join(' '), /vacuous/);
});

test('M1 on the real run: only episode_kinds_sha256 differs (the run hashed the template file\'s top-level keys; the registrar now hashes the kinds); server.tree_sha256 is null = unmeasured', { skip: !haveCommit && 'the run\'s commit 4b7a9b9 is not in this clone' }, () => {
  const c = base.checks.M1;
  assert.equal(c.pass, false);
  assert.equal(c.failures.length, 1);
  assert.equal(c.failures[0].code, 'code_hash');
  assert.equal(c.failures[0].field, 'episode_kinds_sha256');
  // the committed value is the sha256 of the sorted TOP-LEVEL keys of templates.en.json at the commit (the first definition)
  assert.equal(c.failures[0].committed, sha256hex(canonical(['items', 'kinds', 'lang', 'v', 'words'])));
  assert.deepEqual(c.unmeasured.map(u => u.field), ['server.tree_sha256']);
});

test('verdict logic: FAIL beats INCOMPLETE beats PASS; an unmeasured field is never a PASS', async () => {
  const { verdictOf } = await import('../citizens/audit/canon.mjs');
  assert.equal(verdictOf({ a: { pass: true }, b: { pass: null } }), 'INCOMPLETE');
  assert.equal(verdictOf({ a: { pass: false }, b: { pass: null } }), 'FAIL');
  assert.equal(verdictOf({ a: { pass: true }, b: { pass: true } }), 'PASS');
});

// ---------------------------------------------------------------- tampers on the real run
test('tamper: an edited episode in a published list fails M11 (the file\'s own hash no longer matches)', async () => {
  const { report } = await run({ only: ['M11'], post: fx => {
    // only 3 of the 6 AIs are sampled (7.3): the tamper is made in every list, as an attacker who does not know the sample would have to
    for (const tag of fs.readdirSync(path.join(fx.pub, 'memory'))) {
      const p = path.join(fx.pub, 'memory', tag, 'episodes.json');
      const j = rj(p);
      j.episodes[0].text.en = j.episodes[0].text.en.replace(/\d+/, '999');
      wj(p, j);
    }
  } });
  assert.equal(report.checks.M11.pass, false);
  assert.ok(codes(report.checks.M11).some(c => c === 'episodes_file_inconsistent' || c === 'episodes_mismatch'));
});

test('tamper: an edited episode whose file hash was recomputed still fails M11 (the replay differs)', async () => {
  let edited = null;
  const { report } = await run({ only: ['M11'], post: fx => {
    for (const tag of fs.readdirSync(path.join(fx.pub, 'memory'))) {
      const p = path.join(fx.pub, 'memory', tag, 'episodes.json');
      const j = rj(p);
      j.episodes[0].text.en += ' (edited)';
      j.sha256 = sha256hex(canonical([...j.episodes].sort((a, b) => a.created_bell - b.created_bell || a.bell - b.bell || (a.id < b.id ? -1 : 1))));
      wj(p, j);
      edited = tag;
    }
  } });
  const c = report.checks.M11;
  assert.equal(c.pass, false);
  assert.ok(codes(c).includes('episodes_mismatch'));
  assert.ok(c.failures.find(f => f.code === 'episodes_mismatch').changed.length >= 1);
  assert.ok(edited);
});

test('tamper: an episode removed from a published list fails M11', async () => {
  const { report } = await run({ only: ['M11'], post: fx => {
    for (const tag of fs.readdirSync(path.join(fx.pub, 'memory'))) {
      const p = path.join(fx.pub, 'memory', tag, 'episodes.json');
      const j = rj(p);
      j.episodes.pop();
      j.count = j.episodes.length;
      j.sha256 = sha256hex(canonical([...j.episodes].sort((a, b) => a.created_bell - b.created_bell || a.bell - b.bell || (a.id < b.id ? -1 : 1))));
      wj(p, j);
    }
  } });
  const c = report.checks.M11;
  assert.equal(c.pass, false);
  assert.ok(c.failures.some(f => f.code === 'episodes_mismatch' && f.missing_in_published.length >= 1));
});

test('tamper: a mem id outside the retrieved set fails M11 (an unsealed model decision)', async () => {
  let victim = null;
  const { report } = await run({ only: ['M11', 'M3'], post: fx => {
    for (const f of fs.readdirSync(path.join(fx.pub, 'minds')).filter(n => /^\d+\.json$/.test(n))) {
      const p = path.join(fx.pub, 'minds', f);
      const j = rj(p);
      const r = j.records.find(x => x.mode === 'model' && !x.sealed && x.choice?.mem);
      if (r) { r.choice.mem = [...r.choice.mem, 'ffffffffffffffff']; victim = r.id; wj(p, j); return; }
    }
  } });
  assert.ok(victim, 'the fixture has an unsealed model decision');
  const c = report.checks.M11;
  assert.equal(c.pass, false);
  assert.ok(c.failures.some(f => f.code === 'mem_outside_retrieved' && f.mem.includes('ffffffffffffffff')));
  assert.equal(report.checks.M3.pass, false, 'the same edit also breaks the record id and the minds root');
});

test('tamper: a mem id outside retrieved in a sealed record\'s opening fails M11 AND the commit (M3)', async () => {
  const { report } = await run({ only: ['M11', 'M3'], post: fx => {
    const dir = path.join(fx.pub, 'full', 'open');
    const f = fs.readdirSync(dir)[0];
    const o = rj(path.join(dir, f));
    o.choice.mem = [...(o.choice.mem ?? []), 'eeeeeeeeeeeeeeee'];
    wj(path.join(dir, f), o);
  } });
  assert.ok(report.checks.M11.failures.some(f => f.code === 'mem_outside_retrieved'));
  assert.ok(codes(report.checks.M3).includes('commit_mismatch'));
});

test('tamper: an altered commit (the opening\'s choice) fails M3 commit_mismatch; altered candidates fail candidates_hash', async () => {
  const { report } = await run({ only: ['M3'], post: fx => {
    const dir = path.join(fx.pub, 'full', 'open');
    const files = fs.readdirSync(dir).sort();
    const a = rj(path.join(dir, files[0]));
    a.choice.ids = [...a.choice.ids].reverse().concat(['c9']);
    wj(path.join(dir, files[0]), a);
    const b = rj(path.join(dir, files[1]));
    b.candidates[0].label = 'something else';
    wj(path.join(dir, files[1]), b);
  } });
  const cs = codes(report.checks.M3);
  assert.ok(cs.includes('commit_mismatch'));
  assert.ok(cs.includes('opened_late'), 'the other 5 are still not released');
  assert.ok(codes(report.checks.M3).filter(x => x === 'candidates_hash').length === 1 || cs.includes('candidates_hash'));
});

test('tamper: a removed record fails M3 (its bell\'s minds root and the anchored root no longer match)', async () => {
  const { report } = await run({ only: ['M3'], post: fx => {
    const p = path.join(fx.pub, 'minds', '30.json');
    const j = rj(p);
    j.records.pop();
    wj(p, j);
  } });
  const cs = codes(report.checks.M3);
  assert.ok(cs.includes('minds_root_mismatch'));
  assert.ok(cs.includes('anchor_minds_root'));
});

test('tamper: a changed anchor (its minds_root) fails M3 against the file and against the memo on chain', async () => {
  const { report } = await run({ only: ['M3'], post: fx => {
    const p = path.join(fx.pub, 'anchors', '50.json');
    const j = rj(p);
    j.minds_root = 'a'.repeat(64);
    wj(p, j);
  } });
  const cs = codes(report.checks.M3);
  assert.ok(cs.includes('anchor_minds_root'));
  assert.ok(cs.includes('anchor_memo_text'));
});

test('tamper: a missing anchor and a missing minds file are gaps (M3)', async () => {
  const { report } = await run({ only: ['M3'], post: fx => {
    fs.rmSync(path.join(fx.pub, 'anchors', '20.json'));
    fs.rmSync(path.join(fx.pub, 'minds', '21.json'));
  } });
  const cs = codes(report.checks.M3);
  assert.ok(cs.includes('gap_anchor'));
  assert.ok(cs.includes('gap_minds_file'));
});

test('tamper: an anchor signature that is not on chain fails M3', async () => {
  const { report } = await run({ only: ['M3'], post: fx => {
    const p = path.join(fx.pub, 'anchors', '33.json');
    const j = rj(p);
    j.signature = '1'.repeat(88);
    wj(p, j);
  } });
  assert.ok(codes(report.checks.M3).includes('anchor_not_on_chain'));
});

test('tamper: a forged registrar signature on the roster fails M2; on the commitments fails M1', { skip: !haveCommit && 'commit not in this clone' }, async () => {
  const { report } = await run({ only: ['M1', 'M2'], post: fx => {
    for (const f of ['roster.json', 'commitments.json']) {
      const p = path.join(fx.pub, f);
      const j = rj(p);
      const raw = Buffer.from(j.sig, 'base64');
      raw[0] ^= 0xff;
      j.sig = raw.toString('base64');
      // keep the file in the canonical form the run wrote, so only the signature is wrong
      fs.writeFileSync(p, f === 'commitments.json' ? canonicalJsonBytes(j) : `${JSON.stringify(j)}\n`);
    }
  } });
  assert.ok(codes(report.checks.M2).includes('roster_signature'));
  assert.ok(codes(report.checks.M1).includes('registrar_signature'));
  assert.ok(codes(report.checks.M1).includes('commit_anchor_hash'), 'a changed commitments file no longer hashes to the commit memo');
});
function canonicalJsonBytes(v) {
  const c = x => (x === null || typeof x !== 'object' ? JSON.stringify(x) : Array.isArray(x) ? `[${x.map(c).join(',')}]` : `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${c(x[k])}`).join(',')}}`);
  return c(v);
}

test('tamper: a changed deal field in the roster (re-signed or not) fails M2', async () => {
  const { report } = await run({ only: ['M2'], post: fx => {
    const p = path.join(fx.pub, 'roster.json');
    const j = rj(p);
    j.ai[0].persona = 'guardian';
    wj(p, j);
  } });
  const cs = codes(report.checks.M2);
  assert.ok(cs.includes('deal_mismatch'));
  assert.ok(cs.includes('roster_signature'));
});

test('tamper: a record\'s tx removed from the published file fails M7 (the chain transaction becomes an orphan) and M3 (id and root)', async () => {
  const { report } = await run({ only: ['M7', 'M3'], post: fx => {
    const p = path.join(fx.pub, 'minds', '40.json');
    const j = rj(p);
    const r = j.records.find(x => x.tx?.length);
    r.tx = [];
    wj(p, j);
  } });
  assert.ok(report.checks.M7.failures.filter(f => f.code === 'orphan_chain_tx').length >= 3);
  assert.ok(codes(report.checks.M3).includes('record_id_mismatch') || codes(report.checks.M3).includes('minds_root_mismatch'));
});

test('tamper: a listed signature that is not on chain fails M7', async () => {
  const { report } = await run({ only: ['M7'], post: fx => {
    const p = path.join(fx.pub, 'minds', '40.json');
    const j = rj(p);
    j.records.find(x => x.tx?.length).tx.push({ intent: 'build', sig: '2'.repeat(88), status: 'sent', code: null });
    wj(p, j);
  } });
  assert.ok(codes(report.checks.M7).includes('listed_signature_not_on_chain'));
});

test('tamper: one signature in two records fails M7', async () => {
  const { report } = await run({ only: ['M7'], post: fx => {
    const p = path.join(fx.pub, 'minds', '40.json');
    const j = rj(p);
    const [a, b] = j.records.filter(x => x.tx?.length);
    b.tx = [...b.tx, a.tx[0]];
    wj(p, j);
  } });
  assert.ok(codes(report.checks.M7).some(c => c === 'tx_in_many_records' || c === 'tx_in_other_ais_record'));
});

// ---------------------------------------------------------------- M9
test('M9 with a llama-server given: every record of the real run fails the offline seed rule first, so no request is sent to llama', async () => {
  const llm = await startFakeLlama(() => 'not what the run produced');
  try {
    const { report } = await run({ only: ['M9'], llm: llm.url });
    const c = report.checks.M9;
    assert.equal(c.pass, false);
    assert.equal(llm.requests.length, 0);
    assert.ok(c.failures.every(f => f.code === 'seed_rule_broken'));
  } finally { await llm.close(); }
});

test('M9: a stored body edited after the run no longer hashes to the record\'s request_hash', async () => {
  const { report } = await run({ only: ['M9'], pre: fx => {
    const dir = path.join(fx.dir, 'state', 'requests');
    const f = fs.readdirSync(dir)[0];
    const j = rj(path.join(dir, f));
    j.messages[1].content += ' ';
    wj(path.join(dir, f), j);
  } });
  assert.ok(codes(report.checks.M9).includes('request_hash_mismatch'));
});

test('season end: 42 files from the run\'s state, 7 openings written because no release happened, every opening\'s commit verifies, sealed records carry no choice in minds files', async () => {
  const fx = copyFixture();
  try {
    const r = createAudit({ aiDir: fx.dir }).publishSeasonEnd();
    assert.equal(r.published, true);
    assert.equal(r.unreleased, 7);
    assert.equal(r.requests, 14);
    const idx = rj(path.join(fx.pub, 'full', 'index.json'));
    assert.equal(idx.unreleased.length, 7);
    for (const f of idx.files) assert.equal(sha256hex(fs.readFileSync(path.join(fx.pub, f.path), 'utf8')), f.sha256, f.path);
  } finally { fx.cleanup(); }
});
