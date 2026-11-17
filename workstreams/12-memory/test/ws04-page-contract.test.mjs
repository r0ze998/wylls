// The page contract between 4's producer and 12's held report (2026-11-17). SOURCE-ONLY when written: not run.
// The page is NOT written here: it is 4's file, workstreams/04-execution/tests/fixtures/observe-page-contract.json,
// which 4's test (tests/observe_page_contract.rs) requires `read_store_observations` to print exactly. 12 reads the
// same bytes as runexec's stdout. Synthetic records only, never chain evidence: the page stays held whole.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { heldFromWs04Observation, WS04_OBSERVATION_HELD, WS04_PAGE_HELD } from '../adapters/ws04-observation.mjs';
import { parseJsonU64 } from '../adapters/ws04-receipts.mjs';
import { main } from '../../13-citizens/bin/observe-canonical.mjs';

const TEXT = readFileSync(new URL('../../04-execution/tests/fixtures/observe-page-contract.json', import.meta.url), 'utf8');
// runexec prints the page compact on one line (main.rs `println!("{v}")`); no string in the page holds a newline
const LINE = TEXT.replace(/\n\s*/g, '');

test("4's own page: parsed exact, reported held with no finding of 12's, every reason as 4 gave it", () => {
  assert.ok(!LINE.includes('\n') && LINE.startsWith('{"format":'));
  const page = parseJsonU64(LINE);
  // u64 kept exact: the owner tag u64::MAX and a raider past 2^53 come back as their decimal text
  assert.equal(page.observations[0].event.value.key.owner, '18446744073709551615');
  assert.equal(page.observations[1].event.value.raider, '9223372036854775813');
  const r = heldFromWs04Observation(page);
  assert.deepEqual([r.format, r.status, r.admitted], ['ws04-observation/0', 'held', 0]);
  assert.deepEqual(r.why, [], `12 finds nothing wrong with 4's own page: ${r.why}`);
  assert.deepEqual(r.pageHeld, page.held, "4's page reasons, verbatim");
  for (const h of WS04_PAGE_HELD) assert.ok(r.pageHeld.includes(h), h);
  assert.equal(r.observations.length, 2);
  r.observations.forEach((o, i) => {
    const p = page.observations[i];
    assert.deepEqual(o.why, [], `row ${i}: ${o.why}`);
    assert.deepEqual(o.held, p.held, `row ${i}: 4's reasons, verbatim`);
    for (const h of WS04_OBSERVATION_HELD) assert.ok(o.held.includes(h), `${i} ${h}`);
    assert.equal(o.kind, p.event.kind);
    assert.equal(o.transaction_slot, p.transaction_slot);
    assert.equal(o.locator, p.local_locator);
    assert.equal(o.triple, `${p.signature}|${p.ps2_ordinal}|${p.body_sha256}`);
    assert.deepEqual(o.archive_epoch, p.archive_epoch, 'the epoch view as given');
  });
  assert.deepEqual(r.store, { ...page.store, unsafe: [] }, 'the pairing facts as given');
  // nothing is turned into evidence
  assert.ok(!('facts' in r) && !('receipts' in r) && !('coverage' in r) && !('basis' in r));
  assert.ok(r.observations.every(o => !('id' in o) && !('value' in o) && !('credited' in o)));
});

test("the same line as runexec's stdout through observe-canonical: read in store mode, held, nothing else asked", async () => {
  const n = { getJson: [], rpc: 0, readStore: 0 };
  const io = {
    getJson: async url => { n.getJson.push(url); return { ok: false, status: 503 }; },
    rpc: async () => { n.rpc++; throw new Error('no RPC in this test'); },
    readStore: () => { n.readStore++; throw new Error('no store is opened in this test'); },
  };
  const calls = [];
  const execFile = (bin, a, opts, cb) => { calls.push({ bin, a, shell: opts.shell }); setImmediate(() => cb(null, `${LINE}\n`, '')); };
  const printed = [];
  const code = await main(['--herald', 'http://127.0.0.1:1', '--rpc', 'http://127.0.0.1:2', '--store', '/nowhere/runexec.sqlite',
    '--runexec', '/x/runexec', '--ws04-store', '/s'], { io, execFile, print: s => printed.push(s) });
  const out = JSON.parse(printed.at(-1));
  assert.deepEqual(calls, [{ bin: '/x/runexec', a: ['observe', 'store', '--store', '/s'], shell: false }]);
  assert.equal(n.rpc, 0); assert.equal(n.readStore, 0);
  assert.ok(n.getJson.every(u => u.startsWith('http://127.0.0.1:1/h/')), n.getJson.join(' '));
  assert.deepEqual(out.ws04Read, { status: 'read', mode: 'store' }, 'the mode asked is the mode of the page: no finding');
  assert.deepEqual([out.ws04.status, out.ws04.admitted, out.ws04.why], ['held', 0, []]);
  assert.equal(out.ws04.observations.length, 2);
  assert.ok(out.ws04.observations.every(o => o.why.length === 0 && o.held.length === 4));
  assert.equal(out.ws04.store.generation, 'index_matches_manifest');
  assert.notEqual(out.basis, 'chain');
  assert.equal(code, 2, 'the herald part decides the exit (503 here); 4\'s page never makes it 0');
});
