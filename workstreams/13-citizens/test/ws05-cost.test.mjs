// Workstream 5's cost ledger (e9d1551a) under the resident, keyless, through the demo's common set-up (runDemo,
// openAll, openResident: the same code the demo runs) and through small worlds:
//   5's TokenPriceBook (FIXTURE_BOOK: invented prices) quotes; 5's FileCostLedger (file-locked, shared between
//   processes, fenced by 5's ProcessLease) reserves, settles, releases or holds undecided; the agent wallet's
//   AgentLedger keeps the resident's own money as before. The two must agree call by call, and an unknown cost must
//   stay undecided in both, through a restart and a stop in the middle of a model call.
// Set WS05_ROOT to a checkout of workstream 5 (e9d1551a was restored from its delivery bundle); skipped otherwise.
// No model is called (fixture providers), nothing is signed, no key is made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runDemo } from '../demo/run-demo.mjs';
import { small, run, tmp } from './helpers.mjs';
import { ws05LedgerCost } from '../resident/ports/ws05-cost.mjs';
import { decisionsOf } from '../demo/report.mjs';
import { expectCommit } from './versions.mjs';

// Workstream 5's tree: WS05_ROOT (or the older name WS05_E9D1551A). The commit it is at is printed by every test and,
// with WS05_EXPECT set, must match: a pass on one version of 5 is never a pass on another.
const ROOT = process.env.WS05_ROOT ?? process.env.WS05_E9D1551A;
const skip = ROOT ? false : 'set WS05_ROOT to a checkout of workstream 5';
const WS05_COMMIT = ROOT ? expectCommit('WS05', ROOT) : null;
test('workstream 5 version these tests ran against', { skip }, t => { t.diagnostic(`workstream 5 at ${WS05_COMMIT}`); });
const m5 = rel => import(pathToFileURL(path.join(ROOT, 'workstreams/05-ai-participation/model-api/src', rel)).href);
const PROVIDER = 'anthropic', MODEL = 'claude-fixture-model'; // an entry of 5's FIXTURE_BOOK (invented numbers)
const files = dir => readdirSync(dir).flatMap(f => { const p = path.join(dir, f); return statSync(p).isDirectory() ? files(p) : [p]; });

/**
 * costFor(resident) for every (re)open: one 5 ledger directory per resident, a lease per open. Each open is a new
 * "process" (a synthetic pid): the previous open of the same resident is dead, as after a real stop.
 */
async function ws05Factory(root, { available = '400000', caps = {}, recover = true } = {}) {
  const { FileCostLedger } = await m5('cost-store.mjs');
  const { ProcessLease } = await m5('process-lease.mjs');
  const { FIXTURE_BOOK } = await m5('price-book.mjs');
  const alive = new Set();
  const lastPid = {};
  let next = 1_000_000;
  const opened = [];
  const costFor = r => {
    const dir = path.join(root, 'ws05', r.id);
    mkdirSync(dir, { recursive: true });
    if (lastPid[r.id]) alive.delete(lastPid[r.id]);
    const pid = (lastPid[r.id] = next++);
    alive.add(pid);
    const lease = new ProcessLease({ dir, agentId: r.id, pid, isAlive: p => alive.has(p), ttlMs: 3_600_000 });
    lease.acquire();
    const ledger = new FileCostLedger({ dir, init: { available, caps }, lease });
    const recovered = recover ? ledger.recoverStale({ ttlMs: 3_600_000, isAlive: p => alive.has(p) }) : null;
    opened.push({ id: r.id, pid, recovered });
    return ws05LedgerCost({ book: FIXTURE_BOOK(), ledger, provider: PROVIDER, model: MODEL });
  };
  const ledgerOf = id => new FileCostLedger({ dir: path.join(root, 'ws05', id) });
  return { costFor, opened, ledgerOf, ProcessLease, FileCostLedger, FIXTURE_BOOK };
}

const sum = xs => xs.reduce((a, b) => a + BigInt(b), 0n);
/** The resident's own (AgentLedger) inference money, by state. */
function walletInference(r) {
  const rec = r.ledger.get(r.id);
  const holds = Object.values(rec.holds).filter(h => h.category === 'inference');
  return { spent: BigInt(rec.bal.spent.inference ?? 0), unresolved: sum(holds.filter(h => h.state === 'unresolved').map(h => h.amount)), open: holds.filter(h => ['held', 'running'].includes(h.state)).length, unresolvedHolds: holds.filter(h => h.state === 'unresolved') };
}

/** The two ledgers agree: 5's settled = the wallet's spent; 5's undecided = the wallet's unresolved; no key twice. */
function agree(r, ledger5) {
  const items = [...ledger5.items.values()];
  const c = ledger5.classes();
  const w = walletInference(r);
  assert.equal(BigInt(c.settled), w.spent, `${r.id}: settled in 5 = spent in the wallet`);
  assert.equal(BigInt(c.undecided), w.unresolved, `${r.id}: undecided in 5 = unresolved in the wallet`);
  assert.equal(BigInt(c.reserved), 0n, `${r.id}: nothing left reserved or calling`);
  assert.equal(w.open, 0);
  assert.equal(new Set(items.map(i => i.key)).size, items.length);
  return { items, c, w };
}

for (const [name, opts] of [
  ['normal', {}],
  ['restart at bell 50', { restartAt: 50 }],
  ['stop right after a submit', { crash: { resident: 'ren', at: 'after-submit', turn: 3 } }],
  ['stop in the middle of a model call', { crash: { resident: 'ren', at: 'during-inference', turn: 3 } }],
]) {
  test(`5's ledger through the demo set-up, ${name}: both ledgers agree, call by call`, { skip, timeout: 120_000 }, async t => {
    const out = tmp();
    const f = await ws05Factory(out);
    const r = await runDemo({ out, bells: 120, costFor: f.costFor, ...opts });
    for (const id of ['asa', 'ren']) {
      const res = r.all[id];
      const { items, c, w } = agree(res, f.ledgerOf(id));
      t.diagnostic(`${id}: ${items.length} calls in 5's ledger; settled ${c.settled}, undecided ${c.undecided}, released ${c.released}; wallet spent ${w.spent}`);
      const calls = decisionsOf(res).filter(d => d.cost?.kind === 'ws05-ledger');
      assert.ok(calls.length > 3, 'the residents called the (fixture) model and were costed by 5');
      assert.ok(items.length >= calls.length);
      if (opts.crash?.at === 'during-inference' && id === 'ren') {
        const und = items.filter(i => i.state === 'undecided');
        assert.equal(und.length, 1, 'the call cut off by the stop is undecided, not released, not 0');
        assert.match(und[0].why, /restart while calling|gone while calling/, "by 5's own recovery (holder gone) or the resident's (restart)");
        assert.equal(w.unresolvedHolds.length, 1);
        assert.equal(BigInt(und[0].amount), BigInt(w.unresolvedHolds[0].amount));
      } else {
        assert.equal(BigInt(c.undecided), 0n);
      }
    }
    assert.equal(f.opened.length, { normal: 2, 'restart at bell 50': 4 }[name] ?? 3, 'a cost port at every open');
    assert.deepEqual(files(out).filter(p => p.endsWith('.key')), [], 'no key file');
  });
}

/** A provider answering the best candidate (with a usage report), or failing with a given outcome; counts calls. */
const providerWith = ({ fail = null } = {}) => {
  const p = { calls: 0, async decide(req) {
    p.calls++;
    if (fail) throw Object.assign(new Error(`provider ${fail}`), { outcome: fail });
    const best = [...req.candidates].sort((a, b) => b.score - a.score)[0];
    return { choice: best.id, reason: 'fixture', mem: [], usage: { inputTokens: 100, outputTokens: 10 }, provider: 'fixture', model: 'm' };
  } };
  return p;
};

async function oneResident(provider, f, n = 1) {
  const env = await small({ residents: [{ id: 'ren', goal: 'village-first', pos: { q: 0, r: 0 }, provider }] });
  env.rs.ren.ports.cost = f.costFor(env.rs.ren);
  await run(env, n);
  return env;
}

test('an unknown outcome stays undecided in both ledgers, and a restart does not release it', { skip }, async () => {
  const dir = tmp();
  const f = await ws05Factory(dir);
  const env = await oneResident(providerWith({ fail: 'unknown' }), f);
  const ren = env.rs.ren;
  const d = decisionsOf(ren).find(x => x.cost);
  assert.equal(d.cost.undecided, 'outcome unknown');
  const before = agree(ren, f.ledgerOf('ren'));
  assert.equal(before.items[0].state, 'undecided');
  // a restart of the whole process (5's ledger reopened, its restart rule applied, the resident reopened)
  const again = new f.FileCostLedger({ dir: path.join(dir, 'ws05', 'ren') });
  again.recoverStale({ ttlMs: 1, isAlive: () => false });
  const after = again.items.get(before.items[0].key);
  assert.deepEqual([after.state, after.amount], ['undecided', before.items[0].amount], 'still undecided, still the full quote');
  assert.throws(() => again.decide(after.key, { by: 'operator', outcome: 'refund', note: 'no evidence' }), e => e.code === 'EvidenceRequired', '5 refuses to zero it without evidence');
});

test('a refusal before generating releases in 5 and charges 0 in the wallet', { skip }, async () => {
  const f = await ws05Factory(tmp());
  const env = await oneResident(providerWith({ fail: 'rejected' }), f);
  const { items, w } = agree(env.rs.ren, f.ledgerOf('ren'));
  assert.deepEqual(items.map(i => i.state), ['released']);
  assert.equal(w.spent, 0n);
});

test('duplicate execution: a second process for the same resident is refused; a process taken over cannot call the model', { skip }, async () => {
  const dir = tmp();
  const f = await ws05Factory(dir);
  const p = providerWith();
  const env = await oneResident(p, f, 2);
  const ren = env.rs.ren;
  const calls = p.calls;
  assert.ok(calls >= 1);
  const ldir = path.join(dir, 'ws05', 'ren');
  // A second live process for the same agent: refused while the first is alive.
  const second = new f.ProcessLease({ dir: ldir, agentId: 'ren', pid: 42, isAlive: () => true, ttlMs: 3_600_000 });
  assert.throws(() => second.acquire(), e => e.code === 'AlreadyRunning');
  // The first is presumed hung and taken over: from then on it cannot reserve, so it makes no model call.
  const taker = new f.ProcessLease({ dir: ldir, agentId: 'ren', pid: 43, isAlive: pid => pid === 43, ttlMs: 3_600_000 });
  taker.acquire();
  const spentBefore = walletInference(ren).spent;
  await run(env, 30);
  assert.equal(p.calls, calls, 'no model call after the takeover');
  const refused = decisionsOf(ren).filter(d => d.cost?.refused === 'LeaseLost');
  assert.ok(refused.length > 0, 'the refusal is recorded');
  assert.ok(refused.every(d => d.by === 'fallback' || d.by === 'code'));
  const w = walletInference(ren);
  assert.equal(w.spent, spentBefore, 'nothing charged for refused calls');
  assert.equal(w.open, 0, 'the wallet holds were released');
  agree(ren, f.ledgerOf('ren'));
});

test("5's caps bind: a quote over 5's per-call cap is refused before the call", { skip }, async () => {
  const f = await ws05Factory(tmp(), { caps: { perCall: '10' } });
  const p = providerWith();
  const env = await oneResident(p, f, 3);
  assert.equal(p.calls, 0);
  assert.ok(decisionsOf(env.rs.ren).some(d => d.cost?.refused === 'PerCallLimit'));
  agree(env.rs.ren, f.ledgerOf('ren'));
});

test("a stop in the middle of a model call, without 5's own recovery: the resident tells 5, and it is undecided", { skip, timeout: 120_000 }, async () => {
  const out = tmp();
  const f = await ws05Factory(out, { recover: false });
  const r = await runDemo({ out, bells: 40, costFor: f.costFor, crash: { resident: 'ren', at: 'during-inference', turn: 3 } });
  const { items, w } = agree(r.all.ren, f.ledgerOf('ren'));
  const und = items.filter(i => i.state === 'undecided');
  assert.deepEqual(und.map(i => i.why), ['restart while calling']);
  assert.equal(w.unresolvedHolds.length, 1);
  // Undecided in 5: the record stays on file (with 5's state) until 5 decides it with evidence; the wallet keeps it unresolved.
  const kept = Object.entries(r.all.ren.state.costCalls ?? {});
  assert.deepEqual(kept.map(([k, c]) => [k, c.costState]), [[und[0].key, 'undecided']], 'kept on file, undecided, under the same key');
});

// ---- together with workstreams 4 and 12 (each only when its tree is given) ------------------------------------------
const ROOT12 = process.env.WS12_ROOT ?? process.env.WS12_EA0636EB;
const CLIENT4 = process.env.WS04_ACTS_CLIENT, BIN4 = process.env.RUNEXEC_BIN;

test("5's ledger and 12's mirror together, through the demo, stopped in the middle of a model call", { skip: skip || (ROOT12 ? false : 'set WS12_ROOT'), timeout: 120_000 }, async () => {
  const { createMemory } = await import(pathToFileURL(path.join(ROOT12, 'workstreams/12-memory/src/index.mjs')).href);
  const { mirrorMemoryPort } = await import(pathToFileURL(path.join(ROOT12, 'workstreams/12-memory/adapters/ws13-resident.mjs')).href);
  const out = tmp();
  const f = await ws05Factory(out);
  mkdirSync(path.join(out, 'ws12'), { recursive: true });
  const wrapMemory = (port, r) => { const p = mirrorMemoryPort(port, createMemory({ path: path.join(out, 'ws12', `${r.id}.jsonl`) }), { owner: r.address }); p.reconcile(); return p; };
  const r = await runDemo({ out, bells: 120, costFor: f.costFor, wrapMemory, crash: { resident: 'ren', at: 'during-inference', turn: 3 } });
  for (const id of ['asa', 'ren']) {
    agree(r.all[id], f.ledgerOf(id));
    const m = createMemory({ path: path.join(out, 'ws12', `${id}.jsonl`) });
    const notes = m.knowledge({ tag: r.all[id].address, nation: null }, 2 ** 32 - 1).notes.filter(n => n.owner === r.all[id].address);
    assert.equal(notes.length, r.all[id].ports.memory.all().length, `${id}: one note per episode`);
  }
  assert.equal([...f.ledgerOf('ren').items.values()].filter(i => i.state === 'undecided').length, 1);
});

test("5's ledger with 4's real registry: a send whose result is unknown is never re-sent, and costs still agree", { skip: skip || (CLIENT4 && BIN4 ? false : 'set WS04_ACTS_CLIENT and RUNEXEC_BIN'), timeout: 120_000 }, async () => {
  const http = await import('node:http');
  const { createActsClient } = await import(pathToFileURL(path.resolve(CLIENT4)).href);
  const { ws04ActsPort } = await import('../resident/ports/ws04-acts.mjs');
  const f = await ws05Factory(tmp());
  const env = await small({ residents: [{ id: 'ren', goal: 'village-first', pos: { q: 0, r: 0 } }] });
  const ren = env.rs.ren;
  ren.ports.cost = f.costFor(ren);
  const world = ren.ports.execution;
  let first = null;
  const srv = http.createServer((req, res) => {
    const key = new URL(req.url, 'http://x').searchParams.get('key');
    first ??= key;
    const w = world.status(key, ren.address);
    const v = key === first ? { state: 'unknown', sent: true, signature: 'sigU' } : !w ? { state: 'not-sent', sent: false } : { state: w.fate, sent: true, commitment: 'finalized' };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(v));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const sent = [];
  try {
    const acts = createActsClient({ bin: BIN4, db: path.join(tmp(), 'runs.db'), gatewayPort: srv.address().port });
    ren.ports.execution = ws04ActsPort(acts, { agentId: ren.address, send: async req => { sent.push(req.idempotencyKey); return world.submit(req); } });
    await run(env, 25);
  } finally { srv.close(); }
  assert.deepEqual(sent.filter(k => k === first || k.startsWith(`${first}#`)), [first], 'never re-sent under any key');
  assert.equal(Object.values(ren.state.journal).find(j => j.key === first).state, 'sent', 'held, not taken as not-done');
  agree(ren, f.ledgerOf('ren'));
});

// ---- a stop between 5's reservation and the resident's own save ------------------------------------------------------
for (const at of ['before-cost-reserve', 'after-cost-reserve']) {
  for (const recover of [true, false]) {
    test(`a stop ${at.replace('-cost-reserve', " 5's reservation")} (5's own recovery ${recover ? 'on' : 'off'}): released in both ledgers, no cost twice, no send twice`, { skip, timeout: 120_000 }, async t => {
      const out = tmp();
      const f = await ws05Factory(out, { recover });
      const submits = [];
      const wire = r => { const p = r.ports.execution; r.ports.execution = { ...p, async submit(req) { submits.push([r.id, req.idempotencyKey]); return p.submit(req); } }; };
      const r = await runDemo({ out, bells: 120, costFor: f.costFor, wire, crash: { resident: 'ren', at, turn: 3 } });
      assert.equal(r.summary.mechanical.restarts.length, 1, 'the stop happened');
      for (const id of ['asa', 'ren']) {
        const { items, c } = agree(r.all[id], f.ledgerOf(id));
        assert.equal(BigInt(c.undecided), 0n, `${id}: nothing undecided (no call was made by the cut-off turn)`);
        if (id === 'ren') {
          const released = items.filter(i => i.state === 'released');
          // before: 5 never reserved it (nothing to release); after: the reservation is released once
          assert.equal(released.length, at === 'after-cost-reserve' ? 1 : 0, `released: ${released.map(i => i.reason)}`);
          if (released.length) assert.match(released[0].reason, /restart before calling|gone before calling/);
          const holds = Object.values(r.all.ren.ledger.get('ren').holds).filter(h => h.category === 'inference');
          assert.equal(holds.filter(h => ['held', 'running'].includes(h.state)).length, 0, 'no wallet hold left open');
          t.diagnostic(`ren: ${items.length} calls in 5; released ${released.length}; wallet holds ${holds.length} (${[...new Set(holds.map(h => h.state))]})`);
        }
      }
      const keys = submits.map(([id, k]) => `${id}|${k}`);
      assert.equal(new Set(keys).size, keys.length, 'every action key submitted once');
    });
  }
}
