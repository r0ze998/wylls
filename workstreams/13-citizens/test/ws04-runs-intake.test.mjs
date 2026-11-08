// The resident's run port against workstream 4's authenticated run intake (cf517b55: clients/runs.mjs
// `createRunsClient().accept(spec, requester)`, `runexec run accept --requester`, `runexec run view`, p04-run/0.1).
//
//   always:              a fake in workstream 4's new shapes (Created/Existing, refusals thrown with a code,
//                        NoRecord vs StoreUnavailable), and a resident on it
//   RUNEXEC_VIEW_BIN:    the real `runexec run view` (built from 7d2fbe0d, whose src/view.rs is cf517b55's; the
//                        cf517b55 binary itself needs two crates not in the offline cache) over runexec's own demo store
//   WS04_RUNS_CLIENT:    workstream 4's real clients/runs.mjs (cf517b55) with a STAND-IN runexec that answers in
//                        runexec's documented JSON, as workstream 4's own runs.test.mjs does (not the real intake check)
// Nothing signs or verifies: the requester's facts are what a credential layer would hand over; here they are
// labelled test stand-ins. No key, no PDA in this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { small, run } from './helpers.mjs';
import { fateOfRun, runViewClient, ws04ExecutionPort, DEFINITE_REFUSALS } from '../resident/ports/ws04-run.mjs';

const ADDR = c => '1'.repeat(31) + c; // syntactically base58; not a key of anything
const REQUESTER = { actor: ADDR('A'), generation: 1, citizen: ADDR('C'), authenticatedBy: 'test stand-in: no credential layer here' };
const specOf = () => ({ owner: 119 });
const err = (code, message = code) => Object.assign(new Error(message), { code });

/** Workstream 4 in its cf517b55 shapes, in memory. `refuse(spec)` may return a code to throw. */
function fake4({ refuse = () => null } = {}) {
  const runs = new Map(), accepts = [];
  return {
    runs, accepts,
    async accept(spec, requester) {
      accepts.push({ spec, requester });
      const code = refuse(spec, requester);
      if (code) throw err(code);
      const r = runs.get(spec.run_id);
      if (r) { if (JSON.stringify(r.spec) !== JSON.stringify(spec)) throw err('Conflict'); return { ...r, accept: 'Existing', replayed: true }; }
      const v = { view_version: 'p04-run/0.1', run_id: spec.run_id, spec, state: 'Accepted', held_reason: null, effects: [], sent: false };
      runs.set(spec.run_id, v);
      return { ...v, accept: 'Created', replayed: false };
    },
    async view(id) { const r = runs.get(id); if (!r) throw err('NoRecord'); return r; },
    land(id) { Object.assign(runs.get(id), { state: 'Fulfilled', effects: ['caravan_sent', 'caravan_settled'], sent: true }); },
  };
}

test('the port hands workstream 4 the requester the credential layer gave, and nothing without one', async () => {
  const c = fake4();
  const port = ws04ExecutionPort(c, { specOf, requesterOf: req => (req.idempotencyKey === 'no-one' ? null : REQUESTER) });
  const req = { idempotencyKey: 'ren:t1:1', action: { name: 'SendCaravan', fields: {} } };
  assert.equal((await port.submit(req)).status, 'sent');
  assert.deepEqual(c.accepts[0].requester, REQUESTER);
  assert.equal((await port.submit(req)).replayed, true, 'Existing');
  const none = await port.submit({ ...req, idempotencyKey: 'no-one' });
  assert.deepEqual([none.status, none.error.code], ['refused', 'NoAuthenticatedRequester']);
  assert.equal(c.accepts.length, 2, 'not handed over without a requester');
});

test('refusals: definite ones (nothing written) come back refused; StoreError/Spawn are thrown (maybe written)', async () => {
  for (const code of ['BadRequest', 'NotAuthorized', 'Conflict']) {
    const port = ws04ExecutionPort(fake4({ refuse: () => code }), { specOf, requesterOf: () => REQUESTER });
    const r = await port.submit({ idempotencyKey: 'k', action: {} });
    assert.deepEqual([r.status, r.error.code], ['refused', code === 'Conflict' ? 'IdempotencyConflict' : code]);
  }
  for (const code of ['StoreError', 'Spawn']) {
    const port = ws04ExecutionPort(fake4({ refuse: () => code }), { specOf, requesterOf: () => REQUESTER });
    await assert.rejects(port.submit({ idempotencyKey: 'k', action: {} }), e => e.code === code);
  }
  assert.deepEqual([...DEFINITE_REFUSALS].sort(), ['BadRequest', 'Conflict', 'NoAuthenticatedRequester', 'NotAuthorized']);
});

test('status: NoRecord alone is "never accepted"; StoreUnavailable is no answer; effects are read at the top of the view', async () => {
  const c = fake4();
  const port = ws04ExecutionPort({ ...c, accept: c.accept, view: async id => { if (id === 'gone') throw err('StoreUnavailable'); return c.view(id); } }, { specOf, requesterOf: () => REQUESTER });
  assert.equal(await port.status('never'), null);
  await assert.rejects(port.status('gone'), e => e.code === 'StoreUnavailable');
  assert.equal(fateOfRun({ state: 'Failed', effects: ['caravan_sent'] }).fate, 'landed', 'stopped after an effect');
  assert.equal(fateOfRun({ state: 'Failed', effects: [] }).fate, 'failed');
});

async function residentOn(c, opts = {}) {
  const env = await small({ residents: [{ id: 'ren', goal: 'village-first', pos: { q: 0, r: 0 } }] });
  const ren = env.rs.ren;
  ren.ports.execution = ws04ExecutionPort(c, { specOf, requesterOf: () => REQUESTER, ...opts });
  return { env, ren };
}

test('a resident whose pass is no longer current (NotAuthorized): the line fails, no new attempt, nothing re-sent', async () => {
  const c = fake4({ refuse: () => 'NotAuthorized' });
  const { env, ren } = await residentOn(c);
  await run(env, 30);
  const it = Object.values(ren.state.journal).find(j => j.purpose?.type === 'build');
  assert.equal(it.state, 'failed');
  assert.equal(it.error, 'NotAuthorized');
  const keys = c.accepts.map(a => a.spec.run_id).filter(k => k === it.key || k.startsWith(`${it.key}#`));
  assert.deepEqual(keys, [it.key], 'refused once, never retried under a new key');
});

test('a StoreError on accept after the run was written: the key is kept and read back; one run, landed', async () => {
  let first = true;
  const c = fake4();
  const accept = c.accept;
  c.accept = async (spec, requester) => { const r = await accept(spec, requester); if (first) { first = false; throw err('StoreError', 'written, then the view failed'); } return r; };
  const { env, ren } = await residentOn(c);
  await run(env, 1);
  const it = Object.values(ren.state.journal).find(j => j.purpose?.type === 'build');
  assert.equal(it.lastError, 'Transport', 'kept under its key');
  c.land(it.key);
  await run(env, 4);
  assert.equal(ren.state.journal[it.key].state, 'landed');
  assert.equal([...c.runs.keys()].filter(k => k === it.key || k.startsWith(`${it.key}#`)).length, 1, 'one run');
  assert.equal(c.accepts.filter(a => a.spec.run_id === it.key).length, 1, 'not re-sent: read back');
});

// ---- the real `runexec run view` ----------------------------------------------------------------------------------
const VIEW_BIN = process.env.RUNEXEC_VIEW_BIN;
test('real runexec run view: the demo store\'s run, NoRecord, and a missing store', { skip: VIEW_BIN ? false : 'set RUNEXEC_VIEW_BIN' }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ws13-view-'));
  execFileSync(VIEW_BIN, ['demo', '--scenario', 'happy', '--db', path.join(dir, 's.db')], { stdio: 'ignore' });
  const view = runViewClient({ bin: VIEW_BIN, db: path.join(dir, 's.db'), execFile });
  const v = await view('demo-happy');
  assert.equal(v.view_version, 'p04-run/0.1');
  assert.deepEqual([fateOfRun(v).fate, fateOfRun(v).ws04State], ['landed', 'Fulfilled']);
  const port = ws04ExecutionPort({ accept: async () => { throw err('BadRequest'); }, view }, { specOf, requesterOf: () => REQUESTER });
  assert.equal(await port.status('nope'), null, 'NoRecord from an opened store');
  const missing = ws04ExecutionPort({ accept: async () => ({}), view: runViewClient({ bin: VIEW_BIN, db: path.join(dir, 'missing.db'), execFile }) }, { specOf });
  await assert.rejects(missing.status('x'), e => e.code === 'StoreUnavailable', 'a missing store is no answer, never "not sent"');
});

// ---- workstream 4's real runs client, with a stand-in runexec ------------------------------------------------------
const RUNS_CLIENT = process.env.WS04_RUNS_CLIENT;
test('workstream 4\'s clients/runs.mjs: the requester file it hands over, and a NotAuthorized refusal through the port', { skip: RUNS_CLIENT ? false : 'set WS04_RUNS_CLIENT' }, async () => {
  const { createRunsClient } = await import(pathToFileURL(path.resolve(RUNS_CLIENT)).href);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ws13-runs-stub-'));
  const stub = (name, body) => { const p = path.join(dir, name); writeFileSync(p, `#!/usr/bin/env node\n${body}\n`); chmodSync(p, 0o755); return p; };
  // A stand-in answering as runexec does: Created with the requester echoed; or NotAuthorized with exit 5.
  const ok = stub('ok', `const fs=require('fs');const a=process.argv.slice(2);const at=k=>a[a.indexOf(k)+1];console.log(JSON.stringify({accept:'Created',replayed:false,requester:JSON.parse(fs.readFileSync(at('--requester'),'utf8')),run_id:JSON.parse(fs.readFileSync(at('--spec'),'utf8')).run_id}));`);
  const no = stub('no', `console.log(JSON.stringify({error:'NotAuthorized',message:'StaleGeneration'}));process.exit(5);`);
  const opts = { db: path.join(dir, 'x.db'), rpc: 'http://127.0.0.1:1', program: ADDR('P'), season: ADDR('S') };
  const port = bin => ws04ExecutionPort({ accept: (s, r) => createRunsClient({ bin, ...opts }).accept(s, r), view: async () => { throw err('NoRecord'); } }, { specOf, requesterOf: () => REQUESTER });
  const r = await port(ok).submit({ idempotencyKey: 'ren:t1:1', action: {} });
  assert.equal(r.status, 'sent');
  const n = await port(no).submit({ idempotencyKey: 'ren:t1:2', action: {} });
  assert.deepEqual([n.status, n.error.code], ['refused', 'NotAuthorized']);
  // the client's own check: a requester without authenticatedBy is refused before runexec is started
  const bad = ws04ExecutionPort({ accept: (s, r2) => createRunsClient({ bin: ok, ...opts }).accept(s, r2), view: async () => null }, { specOf, requesterOf: () => ({ ...REQUESTER, authenticatedBy: '' }) });
  assert.equal((await bad.submit({ idempotencyKey: 'ren:t1:3', action: {} })).error.code, 'BadRequest');
});
