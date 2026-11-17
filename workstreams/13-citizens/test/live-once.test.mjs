// The one-step entry (resident/live/once.mjs, bin/live-once.mjs) (2026-11-17. WRITTEN ONLY, NOT RUN). Fakes only:
// no factory made for real, no herald, no chain, no runexec, no key; nothing signed or sent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { onceConfig, runOnce, summarizeStep, RESULT_KIND } from '../resident/live/once.mjs';
import { main, inputOf, exitOf } from '../bin/live-once.mjs';

const ME = 'Me1111111111111111111111111111111';
const OK = { heraldUrl: 'http://127.0.0.1:8080', wallet: ME, residentDir: '/srv/resident-a' };

test('settings: the three required ones; partial groups and foreign settings are refused; nothing is defaulted', () => {
  assert.equal(onceConfig(OK).ok, true);
  assert.deepEqual(onceConfig(OK).config, { ...OK, boardUrl: null, rpc: null, actsStatus: null });
  const none = onceConfig({});
  assert.deepEqual(none.missing.map(m => m.field), ['heraldUrl', 'wallet', 'residentDir']);
  assert.equal(none.config, null);
  assert.deepEqual(onceConfig({ ...OK, provider: {}, allow: { model: true }, authority: {}, execution: {} }).refused, ['provider', 'allow', 'authority', 'execution']);
  for (const bad of [{ heraldUrl: 'http://u:p@h' }, { heraldUrl: 'ftp://h' }, { wallet: 'short' }, { residentDir: 'rel' }, { boardUrl: 'nope' },
    { rpc: { url: 'http://r' } }, { actsStatus: { bin: '/b', db: '/d' } }, { actsStatus: { bin: 'b', db: '/d', registry: 'r', agentId: 'a' } }, { actsStatus: { bin: '/b', db: '/d', registry: 'r', agentId: 'a', gatewayPort: 70000 } }]) {
    assert.equal(onceConfig({ ...OK, ...bad }).ok, false, JSON.stringify(bad));
  }
});

test('runOnce: the no-charge rule fixed (no provider, no allow, no authority); one step; errors are short', async () => {
  let given = null, steps = 0;
  const make = o => { given = o; return { step: async () => { steps += 1; return { decision: { choice: 'wait', by: 'no-charge-rule', why: 'x' }, proposal: null, world: { cluster: 'localnet', world_id: 'P/S' }, bell: 7 } }; } };
  const r = await runOnce(onceConfig(OK).config, { make, fetchImpl: async () => { throw new Error('never'); } });
  assert.equal(steps, 1);
  assert.equal(given.provider, null);
  assert.deepEqual(given.allow, {});
  assert.deepEqual(given.authority, {});
  assert.equal(r.outcome, 'wait');
  assert.equal(r.enacted, false);
  const e = await runOnce(onceConfig(OK).config, { make: () => { throw Object.assign(new Error(`bad ${'S'.repeat(64)} and more ${'x'.repeat(200)}`), { code: 'Boom' }); } });
  assert.equal(e.outcome, 'error');
  assert.equal(e.error.code, 'Boom');
  assert.ok(e.error.message.length <= 120 && !e.error.message.includes('S'.repeat(40)), 'no long token or full internal error');
});

test('the result: a proposal is never said as sent; plan and fee readable; held and unknown kept apart', () => {
  const step = {
    world: { cluster: 'localnet', world_id: 'P/S' }, bell: 42, bellBasis: { from: 'herald /h/season latestUnix', finality: 'none (informational)' },
    decision: { choice: 'send:r1', by: 'no-charge-rule', why: 'keeps an accepted request' },
    candidates: [{ id: 'send:r1', kind: 'send' }, { id: 'respond:r2', kind: 'respond', held: ["the board's responses for this request were not read"] }],
    unsupported: ['join'], why: [], unknown: [{ what: 'events', why: 'not mapped' }], held: [{ what: 'request', id: 'r9', why: 'of another world' }],
    proposal: { candidate: { kind: 'send', request: 'r1', source: { p: 4, q: 0, site: 5, gen: 1 }, offer: { wood: 100 } }, needs: ['send-sign', 'board-sign'], missingAuthority: ['send-sign', 'board-sign'], enacted: false,
      plan: { ok: true, plan: { dirs: [1, 2, 3] }, fields: { seq: 3, fee: 50000n }, estimate: { have: { wood: 300 }, shortfall: {} } } },
  };
  const s = summarizeStep(step, onceConfig(OK).config);
  assert.equal(s.kind, RESULT_KIND);
  assert.equal(s.outcome, 'proposal');
  assert.equal(s.proposal.enacted, false);
  assert.match(s.proposal.notice, /nothing was signed, posted or sent, and nothing has landed/);
  assert.deepEqual(s.proposal.plan, { ok: true, steps: 3, caravanSeq: 3, fee: '50000', estimate: { have: { wood: 300 }, shortfall: {} } });
  assert.doesNotThrow(() => JSON.stringify(s), 'no bigint left');
  assert.deepEqual(s.candidates[1].held, ["the board's responses for this request were not read"]);
  assert.deepEqual(s.unknown, [{ what: 'events', why: 'not mapped' }]);
  assert.match(s.effects.sent, /nothing/);
  assert.deepEqual(s.effects.writes, ['none by this step']);
  const failed = summarizeStep({ ...step, proposal: { ...step.proposal, plan: { ok: false, code: 'TimeUnknown', why: 'no time' }, held: ['TimeUnknown: no time'] } }, onceConfig(OK).config);
  assert.deepEqual(failed.proposal.plan, { ok: false, code: 'TimeUnknown', why: 'no time' });
  assert.deepEqual(failed.proposal.held, ['TimeUnknown: no time']);
});

test('stop-A in the result: confirmed answers, could-not-read and not-matched keys are told apart; the run-store write is said', () => {
  const cfg = onceConfig({ ...OK, actsStatus: { bin: '/b', db: '/d', registry: 'r', agentId: 'asa', gatewayPort: 8790 } }).config;
  const step = { stopped: 'stopped-by-owner', newOperations: 0, confirmed: { read: [
    { key: 'k1', result: { fate: 'landed', status: 'sent', ws04: { commitment: 'finalized' } } },
    { key: 'k2', result: null },
    { key: 'k3', result: { fate: 'failed', status: 'failed', duplicate: true, fateError: 'Duplicate' } },
    { key: 'k4', unqueryable: true, why: 'wallet down' },
  ] }, resident: { stop: { why: 'stopped-by-owner', reasons: ['stopped-by-owner'] }, live: { read: 'herald /h/season (world and clock only, to match submitted keys)' },
    submittedHeld: [{ key: 'k5', why: 'no provenance recorded (a line made before it was recorded)' }], submittedWhy: 'keys … are not read', unsent: ['asa:t9:1'] } };
  const s = summarizeStep(step, cfg);
  assert.equal(s.outcome, 'stopped');
  assert.deepEqual(s.stop, { why: 'stopped-by-owner', reasons: ['stopped-by-owner'] });
  assert.deepEqual(s.stopA.confirmed, [
    { key: 'k1', answer: 'landed', status: 'sent', commitment: 'finalized' },
    { key: 'k2', answer: 'not registered (workstream 4 NoRecord)' },
    { key: 'k3', answer: 'failed', status: 'failed', duplicate: true, fateError: 'Duplicate' },
  ]);
  assert.deepEqual(s.stopA.couldNotRead, [{ key: 'k4', why: 'the registry could not answer (read again later)' }]);
  assert.deepEqual(s.stopA.notMatched, [{ key: 'k5', why: 'no provenance recorded (a line made before it was recorded)' }]);
  assert.match(s.stopA.worldRead, /world and clock only/);
  assert.match(s.effects.writes[0], /records the wallet's answer/);
  assert.equal('proposal' in s, false, 'stopped: no observation, candidates or proposal');
});

test('the command: usage and missing settings exit 64 without running; a result 0; an error 1; nothing defaulted from flags', async () => {
  let runs = 0; const out = [];
  const print = s => out.push(s);
  const run = async c => { runs += 1; return c.wallet === 'X' ? { outcome: 'error' } : { outcome: 'wait' }; };
  assert.equal(await main(['--nope'], { print, run }), 64);
  assert.equal(await main([], { print, run }), 64);
  assert.match(out.at(-1), /config-missing/);
  assert.equal(runs, 0);
  assert.equal(await main(['--herald', OK.heraldUrl, '--wallet', ME, '--resident-dir', OK.residentDir], { print, run }), 0);
  assert.equal(runs, 1);
  assert.deepEqual(inputOf({}), { heraldUrl: undefined, wallet: undefined, residentDir: undefined });
  assert.deepEqual(inputOf({ 'acts-gateway-port': '8x' }).actsStatus.gatewayPort, NaN, 'a malformed port is refused, not dropped');
});

test('as text: one step only; no timer, loop, signing or sending; the command runs only when invoked', () => {
  const once = readFileSync(new URL('../resident/live/once.mjs', import.meta.url), 'utf8');
  const bin = readFileSync(new URL('../bin/live-once.mjs', import.meta.url), 'utf8');
  for (const s of [once, bin]) assert.doesNotMatch(s.replace(/\/\/[^\n]*/g, ''), /setInterval|setTimeout|while \(true\)|for \(;;\)|\.sign\(|signRecord\(|\.submit\(|\.post\(|\.register\(|\.cancel\(|\.join\(\{/);
  assert.match(once, /provider: null, allow: \{\}, authority: \{\}/);
  assert.match(bin, /if \(process\.argv\[1\] && import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href\) process\.exitCode = await main\(\);/);
  assert.equal((bin.match(/await main\(/g) ?? []).length, 1);
});

// (2026-11-17, second tip; WRITTEN ONLY, NOT RUN) the API checks its own settings: a direct call never reaches make, step or fetch
test('runOnce called directly with invalid settings: config-missing, and nothing made, stepped or fetched', async () => {
  let makes = 0, steps = 0, fetches = 0;
  const make = () => { makes += 1; return { step: async () => { steps += 1; return {}; } }; };
  const fetchImpl = async () => { fetches += 1; throw new Error('never'); };
  const acts = { bin: '/b', db: '/d', registry: 'runexec-store:/srv/runs.db', agentId: 'asa' };
  const bad = [
    undefined, null, 'x', [], {}, { ...OK, residentDir: undefined }, { ...OK, residentDir: '' }, { ...OK, residentDir: 7 }, { ...OK, wallet: '' },
    { ...OK, provider: { charges: false, decide: () => ({ choice: 'wait' }) } }, { ...OK, allow: { model: true } }, { ...OK, authority: { sendSign: true } }, { ...OK, execution: { status: async () => null } },
    { ...OK, rpc: { url: 'http://r', cluster: 'localnet' } }, { ...OK, rpc: { url: 'http://r', cluster: 'localnet', source: 's', extra: 1 } }, { ...OK, rpc: 'http://r' },
    { ...OK, actsStatus: { ...acts, bridge: 'yes' } }, { ...OK, actsStatus: { ...acts, registry: 'two words' } }, { ...OK, actsStatus: { ...acts, registry: '' } },
    { ...OK, actsStatus: { ...acts, agentId: 'a'.repeat(65) } }, { ...OK, actsStatus: { ...acts, gatewayPort: '8790' } }, { ...OK, actsStatus: { ...acts, timeoutMs: 1 } },
  ];
  for (const input of bad) {
    const r = await runOnce(input, { make, fetchImpl });
    assert.equal(r.outcome, 'config-missing', JSON.stringify(input));
    assert.equal(r.enacted, false);
    assert.ok(r.missing.length + r.refused.length > 0, JSON.stringify(input));
  }
  assert.deepEqual([makes, steps, fetches], [0, 0, 0], 'no factory, no step, no IO for any invalid setting');
  const ok = await runOnce({ ...OK, actsStatus: { ...acts, gatewayPort: 8790, bridge: false } }, { make, fetchImpl });
  assert.notEqual(ok.outcome, 'config-missing');
  assert.deepEqual([makes, steps], [1, 1], 'a valid setting: one factory, one step');
});

test('the checked settings are a copy: a later change of the caller\'s object changes nothing; exit codes are one classification', () => {
  const input = { ...OK, actsStatus: { bin: '/b', db: '/d', registry: 'r1', agentId: 'asa' } };
  const c = onceConfig(input).config;
  input.actsStatus.registry = 'changed'; input.wallet = 'X';
  assert.equal(c.actsStatus.registry, 'r1');
  assert.equal(c.wallet, ME);
  assert.ok(Object.isFrozen(c) && Object.isFrozen(c.actsStatus));
  assert.deepEqual(['config-missing', 'usage', 'error', 'stopped', 'wait', 'proposal', 'odd', undefined].map(o => exitOf({ outcome: o })), [64, 64, 1, 0, 0, 0, 1, 1]);
});

test('runOnce (as text): the check comes before anything is made', () => {
  const once = readFileSync(new URL('../resident/live/once.mjs', import.meta.url), 'utf8');
  const body = once.slice(once.indexOf('export async function runOnce('));
  assert.ok(body.indexOf('const c = onceConfig(input);') < body.indexOf("if (!c.ok) return { kind: RESULT_KIND, outcome: 'config-missing'") && body.indexOf("outcome: 'config-missing'") < body.indexOf('make({'));
  assert.match(once, /import \{ registryOrigin, AGENT_ID_MAX \} from '\.\.\/ports\/ws04-acts\.mjs';/, 'the registry name under the ports\' contract');
});
