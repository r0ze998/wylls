// verify-watch-lib.mjs (world3-verifier-watch): RPC allow-list, rate cap, the FAIL-only exit rule, the log line and the
// health line. Pure functions only: no process, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, checkRpc, classify, expectedLoad, gapMsFor, logLine, nextDelayMin, parseLine, summarizeReport, watchHealth } from '../verify-watch-lib.mjs';

const PIN = '245ce1abcdb48d59aaec9e74eb571f5316e89302b02ae877bd3976b9245d0d34';
const pullOk = (o = {}) => ({
  ok: true, archived: 12, seq_before: 100, seq: 112, last_slot: 900, requests: 20, throttled: 0, seconds: 10.5,
  finals: { final_slot: 905, consistent: true, tries: 1, accounts: 300 }, program_hash: { sha256: PIN, deploy_slot: 1 }, ...o,
});
const rep = (verdict, findings = []) => ({ verdict, findings });
const F = (check, code, severity) => ({ check, code, severity });

test('checkRpc: loopback always, api.devnet only with --devnet, never mainnet/testnet/other hosts', () => {
  assert.equal(checkRpc('http://127.0.0.1:41700').ok, true);
  assert.equal(checkRpc('http://localhost:41700').ok, true);
  assert.equal(checkRpc('https://api.devnet.solana.com').ok, false);
  assert.match(checkRpc('https://api.devnet.solana.com').why, /needs --devnet/);
  assert.deepEqual(checkRpc('https://api.devnet.solana.com', { allowDevnet: true }), { ok: true, devnet: true });
  assert.equal(checkRpc('http://api.devnet.solana.com', { allowDevnet: true }).ok, false, 'devnet over https only');
  for (const u of ['https://api.mainnet-beta.solana.com', 'https://api.solana.com', 'https://api.testnet.solana.com', 'https://rpc.example.com', 'nope']) {
    assert.equal(checkRpc(u, { allowDevnet: true }).ok, false, u);
  }
});

test('gapMsFor: the pacer gap of a request cap (2 rps → 500 ms); nonsense refused', () => {
  assert.equal(gapMsFor(2), 500);
  assert.equal(gapMsFor(1), 1000);
  assert.equal(gapMsFor(0.5), 2000);
  for (const r of [0, -1, 11, 'x']) assert.throws(() => gapMsFor(r));
});

test('summarizeReport: counts and codes per severity', () => {
  const s = summarizeReport(rep('FAIL', [F('VG', 'FinalMismatch', 'FAIL'), F('VG', 'FinalMismatch', 'FAIL'), F('V13', 'MissingData', 'UNVERIFIABLE'), F('V1', 'x', 'INFO')]));
  assert.equal(s.verdict, 'FAIL');
  assert.equal(s.fail, 2);
  assert.equal(s.unverifiable, 1);
  assert.deepEqual(s.failCodes, { 'VG/FinalMismatch': 2 });
  assert.deepEqual(summarizeReport(null), { verdict: null, fail: 0, unverifiable: 0, failCodes: {}, unvCodes: {} });
});

test('classify: only FAIL on a consistent snapshot with the pinned program exits 1', () => {
  const fail = { code: 1, report: {}, summary: summarizeReport(rep('FAIL', [F('VG', 'FinalMismatch', 'FAIL')])) };
  const unv = { code: 2, report: {}, summary: summarizeReport(rep('UNVERIFIABLE', [F('V13', 'MissingData', 'UNVERIFIABLE')])) };
  const pass = { code: 0, report: {}, summary: summarizeReport(rep('PASS')) };
  assert.deepEqual(classify({ pull: pullOk(), verify: fail, pinnedSha256: PIN }), { level: 'FAIL', exit: 1, why: 'VG/FinalMismatch×1' });
  assert.equal(classify({ pull: pullOk(), verify: pass, pinnedSha256: PIN }).level, 'PASS');
  assert.equal(classify({ pull: pullOk(), verify: unv, pinnedSha256: PIN }).level, 'UNVERIFIABLE');
  assert.equal(classify({ pull: pullOk(), verify: unv }).exit, 0);
  // finals ahead of the archive: not a mismatch
  const race = classify({ pull: pullOk({ finals: { consistent: false, tries: 3 } }), verify: fail, pinnedSha256: PIN });
  assert.equal(race.level, 'RACE');
  assert.equal(race.exit, 0);
  // the deployed program is not the pinned one: not judged
  const repin = classify({ pull: pullOk({ program_hash: { sha256: 'ab'.repeat(32) } }), verify: fail, pinnedSha256: PIN });
  assert.equal(repin.level, 'REPIN');
  assert.equal(repin.exit, 0);
  // the pull or the judge could not run
  assert.equal(classify({ pull: { ok: false, error: 'Http(429)' }, verify: null }).level, 'ERROR');
  assert.equal(classify({ pull: pullOk(), verify: null }).level, 'ERROR');
  assert.equal(classify({ pull: pullOk(), verify: { code: -1 } }).level, 'ERROR');
  assert.equal(classify({ pull: pullOk(), verify: { code: 2, report: null, stderr: 'frontier-verify: bad --finals\n' } }).level, 'ERROR');
  // a FAIL finding under an UNVERIFIABLE verdict (an unproven public-RPC history downgrades the verdict) is a mismatch
  const hidden = { code: 2, report: {}, summary: summarizeReport(rep('UNVERIFIABLE', [F('VG', 'ReexecMismatch', 'FAIL'), F('H', 'HistoryUnproven', 'UNVERIFIABLE')])) };
  assert.deepEqual(classify({ pull: pullOk(), verify: hidden, pinnedSha256: PIN }), { level: 'FAIL', exit: 1, why: 'VG/ReexecMismatch×1' });
  // a judge without a report but exit 1 is still a FAIL only if the snapshot was consistent
  assert.equal(classify({ pull: pullOk(), verify: { code: 1, report: null, summary: summarizeReport(null) } }).exit, 1);
});

test('logLine / parseLine: one line per cycle, level second', () => {
  const at = Date.UTC(2026, 10, 26, 3, 30);
  const l = logLine({ at, level: 'FAIL', why: 'VG/FinalMismatch×1', pull: pullOk(), verify: { seconds: 4.2, summary: summarizeReport(rep('FAIL', [F('VG', 'FinalMismatch', 'FAIL')])) }, reportDir: 'reports/x' });
  assert.ok(!l.includes('\n') && !l.includes('\t'));
  assert.match(l, /^2026-11-26T03:30:00\.000Z FAIL seq=100->112 new=12 last_slot=900 final_slot=905 consistent=true tries=1 req=20 throttled=0 pull_s=10\.5 judge_s=4\.2 verdict=FAIL fail=1 unv=0 fail_codes=VG\/FinalMismatch×1 report=reports\/x why=/);
  assert.deepEqual(parseLine(l).level, 'FAIL');
  assert.equal(parseLine(l).at, at);
  assert.equal(parseLine('garbage'), null);
  const e = logLine({ at, level: 'ERROR', why: 'pull: x\ny', pull: { ok: false } });
  assert.match(e, / ERROR seq=\?->\? .* why=pull: x y$/);
});

test('watchHealth: OK / WARN stale / FAIL mismatch / REPIN / streaks', () => {
  const t = m => Date.UTC(2026, 10, 26, 3, 0) + m * 60000;
  const line = (m, level) => `${new Date(t(m)).toISOString()} ${level} seq=1->2 new=1`;
  assert.equal(watchHealth('', t(0)).level, 'OK');
  assert.equal(watchHealth('', t(0), { expected: true }).level, 'WARN');
  assert.equal(watchHealth([line(0, 'UNVERIFIABLE')].join('\n'), t(10)).level, 'OK');
  assert.equal(watchHealth([line(0, 'PASS')].join('\n'), t(10)).level, 'OK');
  const stale = watchHealth([line(0, 'UNVERIFIABLE')].join('\n'), t(DEFAULTS.staleMin + 1));
  assert.equal(stale.level, 'WARN');
  assert.match(stale.detail, /^stale/);
  // FAIL stays FAIL while later cycles only RACE / ERROR; a later judged PASS/UNVERIFIABLE clears it
  assert.equal(watchHealth([line(0, 'FAIL')].join('\n'), t(500)).level, 'FAIL');
  assert.equal(watchHealth([line(0, 'FAIL'), line(30, 'ERROR')].join('\n'), t(31)).level, 'FAIL');
  assert.equal(watchHealth([line(0, 'FAIL'), line(30, 'UNVERIFIABLE')].join('\n'), t(31)).level, 'OK');
  assert.equal(watchHealth([line(0, 'REPIN')].join('\n'), t(1)).level, 'WARN');
  assert.equal(watchHealth([line(0, 'ERROR'), line(30, 'ERROR')].join('\n'), t(31)).level, 'OK');
  assert.equal(watchHealth([line(0, 'ERROR'), line(30, 'ERROR'), line(60, 'ERROR')].join('\n'), t(61)).level, 'WARN');
  assert.equal(watchHealth([0, 30, 60].map(m => line(m, 'RACE')).join('\n'), t(61)).level, 'OK');
  assert.equal(watchHealth([0, 30, 60, 90].map(m => line(m, 'RACE')).join('\n'), t(91)).level, 'WARN');
  assert.equal(watchHealth('', t(0)).key, 'verify.watch');
});

test('nextDelayMin: ×2 per throttled cycle up to ×4, back to ×1 after a clean one', () => {
  assert.deepEqual(nextDelayMin(1, pullOk(), { everyMin: 30 }), { factor: 1, minutes: 30 });
  assert.deepEqual(nextDelayMin(1, pullOk({ throttled: 3 }), { everyMin: 30 }), { factor: 2, minutes: 60 });
  assert.deepEqual(nextDelayMin(2, pullOk({ throttled: 1 }), { everyMin: 30 }), { factor: 4, minutes: 120 });
  assert.deepEqual(nextDelayMin(4, { ok: false }, { everyMin: 30 }), { factor: 4, minutes: 120 });
  assert.deepEqual(nextDelayMin(4, pullOk(), { everyMin: 30 }), { factor: 1, minutes: 30 });
});

test('expectedLoad: per-cycle requests and the time at the cap', () => {
  const l = expectedLoad({ txPerHour: 600, accounts: 1000, everyMin: 30 });
  // 300 new tx: 1 page + 1 continuity + 300 tx + 300 balances; finals 1 gPA + 10 gMA + 1 late listing; 1 rent + 2 hash
  assert.equal(l.newTx, 300);
  assert.equal(l.perCycle, 1 + 1 + 600 + 12 + 3);
  assert.equal(expectedLoad({ txPerHour: 600, accounts: 1000, everyMin: 30, settleExtra: 2 }).perCycle, 1 + 1 + 600 + 36 + 3);
  // the dry run's cycle 2 (36 new tx, ~150 accounts): 83 requests measured (two settle reads were not needed)
  assert.ok(expectedLoad({ txPerHour: 72, accounts: 150, everyMin: 30 }).perCycle >= 80);
  assert.equal(l.perHour, 2 * l.perCycle);
  assert.equal(l.seconds, Math.ceil(l.perCycle / DEFAULTS.maxRps));
  // verify-pr251: the safe default is at most 1 request a second (devnet's public RPC: ~1/s per method per IP)
  assert.ok(DEFAULTS.maxRps <= 1);
  assert.ok(gapMsFor(DEFAULTS.maxRps) >= 1000);
});

test('verify-pr251: an UNVERIFIABLE code beyond the public-RPC baseline is logged and WARNs (lying balances → VG/MissingData)', () => {
  const at = Date.parse('2026-11-26T00:00:00Z');
  const base = summarizeReport(rep('UNVERIFIABLE', [F('V0', 'HistoryUnproven', 'unverifiable')]));
  const lied = summarizeReport(rep('UNVERIFIABLE', [F('V0', 'HistoryUnproven', 'unverifiable'), F('VG', 'MissingData', 'unverifiable')]));
  const l1 = logLine({ at, level: 'UNVERIFIABLE', why: '1 unverifiable', pull: pullOk(), verify: { seconds: 0.1, summary: base } });
  const l2 = logLine({ at, level: 'UNVERIFIABLE', why: '2 unverifiable', pull: pullOk(), verify: { seconds: 0.1, summary: lied } });
  assert.match(l1, / unv_codes=V0\/HistoryUnproven×1 /);
  assert.match(l2, / unv_codes=\S*VG\/MissingData×1/);
  assert.equal(watchHealth(l1 + '\n', at + 60000).level, 'OK');
  const h = watchHealth(l2 + '\n', at + 60000);
  assert.equal(h.level, 'WARN');
  assert.match(h.detail, /VG\/MissingData/);
  // a FAIL still wins
  assert.equal(watchHealth(l2 + '\n' + logLine({ at: at + 1, level: 'FAIL', why: 'x', pull: pullOk(), verify: { seconds: 0.1, summary: summarizeReport(rep('FAIL', [F('VG', 'ReExecMismatch', 'FAIL')])) } }) + '\n', at + 60000).level, 'FAIL');
});
