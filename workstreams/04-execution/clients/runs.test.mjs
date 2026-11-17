// The gateway's run intake client (workstream 04, 2026-11-07). No keys, nothing signed or sent.
//
//   node --test workstreams/04-execution/clients/runs.test.mjs
//   RUNEXEC_BIN=<path to runexec> node --test …   (also against the real binary)
//
// The transfer cases (before/after an NFT transfer, against a node serving the pass at its PDAs)
// are in tests/intake_chain.rs; here: what the client hands over, and how a refusal comes back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRunsClient, requesterFile, RunsError } from './runs.mjs';

const ADDR = n => '1'.repeat(31) + n; // syntactically base58, not a key of anything
const REQ = { actor: ADDR('A'), generation: 1, citizen: ADDR('C'), authenticatedBy: 'test: credential layer stand-in' };
const SPEC = { run_id: 'g-1', owner: 119 };

// A stand-in runexec: prints what it was given, so the hand-over can be checked.
function stub(exit = 0, error = null) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ws04-runs-stub-'));
  const p = path.join(dir, 'runexec');
  writeFileSync(p, `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
const at = k => a[a.indexOf(k) + 1];
const out = { args: a, requester: JSON.parse(fs.readFileSync(at('--requester'), 'utf8')), spec: JSON.parse(fs.readFileSync(at('--spec'), 'utf8')) };
${error ? `out.error = ${JSON.stringify(error)}; out.message = 'refused';` : `out.accept = 'Created';`}
console.log(JSON.stringify(out));
process.exit(${exit});
`);
  chmodSync(p, 0o755);
  return p;
}
const client = bin => createRunsClient({ bin, db: '/nonexistent/runs.db', rpc: 'http://127.0.0.1:9', program: ADDR('P'), season: ADDR('S') });

test('hands the authenticated requester and the chain to run accept', async () => {
  const r = await client(stub()).accept(SPEC, REQ, { slot: 7 });
  assert.equal(r.accept, 'Created');
  assert.deepEqual(r.requester, REQ);
  assert.deepEqual(r.spec, SPEC);
  const at = k => r.args[r.args.indexOf(k) + 1];
  assert.deepEqual([r.args[0], r.args[1], at('--rpc'), at('--program'), at('--season'), at('--slot')], ['run', 'accept', 'http://127.0.0.1:9', ADDR('P'), ADDR('S'), '7']);
  assert.equal(existsSync(path.dirname(at('--requester'))), false, 'the requester file is removed');
});

test('a refusal from the chain check comes back as NotAuthorized', async () => {
  await assert.rejects(client(stub(5, 'NotAuthorized')).accept(SPEC, REQ), e => e instanceof RunsError && e.code === 'NotAuthorized' && e.exit === 5);
});

test('a requester without the authenticated facts is not handed over', async () => {
  const bin = stub();
  for (const bad of [{ ...REQ, actor: undefined }, { ...REQ, citizen: 'not-an-address' }, { ...REQ, generation: -1 }, { ...REQ, generation: 1.5 }, { ...REQ, authenticatedBy: ' ' }, { ...REQ, authenticatedBy: undefined }]) {
    await assert.rejects(client(bin).accept(SPEC, bad), e => e.code === 'BadRequest', JSON.stringify(bad));
  }
  assert.equal(requesterFile(REQ), JSON.stringify(REQ));
});

const bin = process.env.RUNEXEC_BIN;
function b58(bytes) {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = bytes.reduce((x, b) => x * 256n + BigInt(b), 0n);
  let s = '';
  while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = '1' + s; }
  return s;
}
test('the real binary: no node to read the pass from, nothing admitted', { skip: bin ? false : 'set RUNEXEC_BIN' }, async () => {
  const db = path.join(mkdtempSync(path.join(os.tmpdir(), 'ws04-runs-')), 'runs.db');
  const spec = {
    run_id: 'g-real', owner: 119, stock: { kind: 1, p: 0, q: 0, at: 1, gen: 1 }, inbound: null,
    inputs: [0, 0, 0, 0, 0, 0, 0, 0], outputs: [0, 0, 0, 0, 0, 0, 0, 0], rights_units: 0,
    ship: { dst: { kind: 2, p: 1, q: 0, at: 5, gen: 1 }, cargo: [0, 4, 0, 0, 0, 0, 0, 0] }, deadline_slot: 400,
    budget: { max_attempts: 3, max_fee: 200000, max_port_errors: 5 },
  };
  const c = createRunsClient({ bin, db, rpc: 'http://127.0.0.1:9', program: ADDR('P'), season: ADDR('S') });
  // ADDR('C') has citizen_tag 0 ≠ 119: refused before the chain is asked.
  await assert.rejects(c.accept(spec, REQ), e => e.code === 'NotAuthorized' && /citizen/.test(e.message));
  // A Citizen of tag 119 (its first 8 bytes, LE): the pass cannot be read (no node), so not admitted.
  const citizen = b58([0x77, 0, 0, 0, 0, 0, 0, 0, ...Array(24).fill(0x9c)]);
  await assert.rejects(c.accept(spec, { ...REQ, citizen }), e => e.code === 'NotAuthorized' && /rpc/.test(e.message));
  assert.equal(existsSync(db), false, 'refused before the store is opened');
});
