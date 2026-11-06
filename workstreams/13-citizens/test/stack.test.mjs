// Everything connected at once, through the demo's common set-up (runDemo → openAll → openResident, with `wire`,
// `wrapMemory` and `costFor` applied at every open), keyless:
//   execution  workstream 4's real act registry: clients/acts.mjs + runexec (8e96f24d), a SQLite file per run;
//              the wallet's GET /f/agent/fate is a scripted loopback server answering from the test world
//   cost       workstream 5's TokenPriceBook (FIXTURE prices) + FileCostLedger + ProcessLease (e9d1551a)
//   memory     workstream 12's mirror (adapters/ws13-resident.mjs, 1583026f), a journal per resident
//   evidence   workstream 12's canonical port (adapters/canonical.mjs) over a synthetic /h/season: the test world's
//              clock is not the Season bell, so it is never read (clock_mismatch), and nothing is verified
// Scenarios: plain, restart, a stop right after a send, a reply lost after the send arrived, an operator halt with
// the result arriving late (and the registry unable to cancel), a stop in the middle of a model call. In each:
// no double execution, no double cost, no double memory, and nothing unknown is decided.
// Needs WS04_ACTS_CLIENT, RUNEXEC_BIN, WS05_E9D1551A and WS12_ROOT; skipped otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, readdirSync, statSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runDemo } from '../demo/run-demo.mjs';
import { tmp } from './helpers.mjs';
import { ws04ActsPort } from '../resident/ports/ws04-acts.mjs';
import { ws05LedgerCost } from '../resident/ports/ws05-cost.mjs';
import { ws12CanonicalEvidence } from '../resident/ports/ws12-canonical.mjs';
import { decisionsOf } from '../demo/report.mjs';

const { WS04_ACTS_CLIENT: CLIENT4, RUNEXEC_BIN: BIN4, WS05_E9D1551A: ROOT5 } = process.env;
const ROOT12 = process.env.WS12_ROOT ?? process.env.WS12_EA0636EB;
const skip = CLIENT4 && BIN4 && ROOT5 && ROOT12 ? false : 'set WS04_ACTS_CLIENT, RUNEXEC_BIN, WS05_E9D1551A and WS12_ROOT';
const imp = (root, rel) => import(pathToFileURL(path.join(root, rel)).href);
const files = dir => readdirSync(dir).flatMap(f => { const p = path.join(dir, f); return statSync(p).isDirectory() ? files(p) : [p]; });
const family = (keys, base) => keys.filter(k => k === base || k.startsWith(`${base}#`));
const baseOf = k => k.split('#')[0];
const sum = xs => xs.reduce((a, b) => a + BigInt(b), 0n);
const BELLS = 120;

const season = { cluster: 'localnet-synthetic', programId: 'Prog1111111111111111111111111111111111111111', seasonAddress: 'Seas1111111111111111111111111111111111111111', season: '1', genesisTs: 1_760_000_000, bellSecs: 600, continuous: true, latestSlot: 900, latestUnix: 1_760_240_000, slot: 900 };

/**
 * The whole stack for one run. `fateOverride(agent, key, bell)` may answer the wallet's fate for a key instead of
 * the world; `loseReplyOf(resident, key, n)` makes the n-th send of a resident arrive and its reply be lost.
 */
async function stack(out, { fateOverride = () => undefined, loseReply = () => false } = {}) {
  const { createActsClient } = await import(pathToFileURL(path.resolve(CLIENT4)).href);
  const { FileCostLedger } = await imp(ROOT5, 'workstreams/05-ai-participation/model-api/src/cost-store.mjs');
  const { ProcessLease } = await imp(ROOT5, 'workstreams/05-ai-participation/model-api/src/process-lease.mjs');
  const { FIXTURE_BOOK } = await imp(ROOT5, 'workstreams/05-ai-participation/model-api/src/price-book.mjs');
  const { createMemory } = await imp(ROOT12, 'workstreams/12-memory/src/index.mjs');
  const { mirrorMemoryPort } = await imp(ROOT12, 'workstreams/12-memory/adapters/ws13-resident.mjs');
  const c12 = await imp(ROOT12, 'workstreams/12-memory/adapters/canonical.mjs');

  // The latest world port of each agent (a restart rebuilds the world from its files) and the bell, for the fate server.
  const worldPort = {};
  let bell = 0;
  const reads = [];
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const agent = u.searchParams.get('id'), key = u.searchParams.get('key');
    reads.push([agent, key]);
    let v = fateOverride(agent, key, bell);
    if (v === undefined) {
      const w = await worldPort[agent]?.status(key);
      // The test world's fate in the wallet's words: not decided yet (null) is pending; withdrawn before landing
      // (cancelled) is expired: provably nothing happened.
      const state = !w ? 'not-sent' : w.fate === null ? 'pending' : ({ cancelled: 'expired' }[w.fate] ?? w.fate);
      v = !w ? { state, sent: false } : { state, sent: true, signature: w.signature ?? null, commitment: state === 'landed' ? 'finalized' : 'confirmed', why: w.fateError ?? null };
    }
    res.writeHead(v ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify(v ?? { error: 'Unavailable' }));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const acts = createActsClient({ bin: BIN4, db: path.join(out, 'ws04-runs.db'), gatewayPort: srv.address().port });

  const sent = [], lost = [], cancels = [];
  const alive = new Set(), lastPid = {};
  let pid = 2_000_000;
  const ledgerDir = id => path.join(out, 'ws05', id);
  const nSent = {};
  const w = c12.worldFromSeason(season);

  const wire = r => {
    const world = r.ports.execution; // the test world's port for this open
    worldPort[r.address] = world;
    r.ports.execution = ws04ActsPort(acts, {
      agentId: r.address, runId: `ws13-${r.id}`,
      send: async req => {
        sent.push([r.id, req.idempotencyKey]);
        const res = await world.submit(req);
        nSent[r.id] = (nSent[r.id] ?? 0) + 1;
        if (loseReply(r.id, req.idempotencyKey, nSent[r.id])) { lost.push(req.idempotencyKey); throw new Error('reply lost after the send arrived'); }
        return res;
      },
    });
    r.ports.evidence = ws12CanonicalEvidence({ ws12EvidencePort: c12.ws12EvidencePort, memory: createMemory({ world: w.world, partitions: w.partitions }), identity: c12.resolverFromIdentity([]), worldClock: w.clock, residentClock: r.ports.observe.clock });
  };
  const wrapMemory = (port, r) => {
    mkdirSync(path.join(out, 'ws12'), { recursive: true });
    const p = mirrorMemoryPort(port, createMemory({ path: path.join(out, 'ws12', `${r.id}.jsonl`) }), { owner: r.address });
    p.reconcile();
    return p;
  };
  const costFor = r => {
    mkdirSync(ledgerDir(r.id), { recursive: true });
    if (lastPid[r.id]) alive.delete(lastPid[r.id]);
    const me = (lastPid[r.id] = pid++);
    alive.add(me);
    const lease = new ProcessLease({ dir: ledgerDir(r.id), agentId: r.id, pid: me, isAlive: p => alive.has(p), ttlMs: 3_600_000 });
    lease.acquire();
    const ledger = new FileCostLedger({ dir: ledgerDir(r.id), init: { available: '400000', caps: {} }, lease });
    ledger.recoverStale({ ttlMs: 3_600_000, isAlive: p => alive.has(p) });
    return ws05LedgerCost({ book: FIXTURE_BOOK(), ledger, provider: 'anthropic', model: 'claude-fixture-model' });
  };
  return {
    wire, wrapMemory, costFor, sent, lost, cancels, reads, acts,
    tick: b => { bell = b; },
    close: () => srv.close(),
    ledger5: id => new FileCostLedger({ dir: ledgerDir(id) }),
    memory12: id => createMemory({ path: path.join(out, 'ws12', `${id}.jsonl`) }),
  };
}

/** The invariants every scenario must keep. Returns numbers for the record. */
async function invariants(t, s, all) {
  const out = {};
  for (const id of ['asa', 'ren']) {
    const r = all[id];
    // Execution: every key sent was registered first; each line (key and its new attempts) took effect at most once.
    const rows = (await s.acts.list(`ws13-${id}`)).acts;
    const registered = new Set(rows.map(a => a.idempotencyKey));
    const mine = s.sent.filter(([who]) => who === id).map(([, k]) => k);
    for (const k of mine) assert.ok(registered.has(k), `${id}: ${k} was registered before it was sent`);
    const bases = [...new Set(mine.map(baseOf))];
    const exec = r.ports.execution;
    for (const b of bases) {
      const fam = [...new Set(family(mine, b))];
      const landed = rows.filter(a => fam.includes(a.idempotencyKey) && a.state === 'landed');
      assert.ok(landed.length <= 1, `${id}: ${b} took effect at most once (${landed.length})`);
      // A new attempt only after 4 said nothing happened (expired, not-sent) for the attempt before it.
      for (const k of fam.filter(k => k !== b)) {
        const n = Number(k.split('#a')[1]);
        const prev = n === 2 ? b : `${b}#a${n - 1}`;
        const pr = rows.find(a => a.idempotencyKey === prev);
        assert.ok(['expired', 'not-sent'].includes(pr?.state), `${id}: ${k} only after ${prev} was ${pr?.state}`);
      }
    }
    void exec;
    // Unknown is held: no line whose registry state is unknown is settled or followed by a new attempt.
    for (const a of rows.filter(a => a.state === 'unknown')) {
      assert.deepEqual(family(mine, a.idempotencyKey).filter(k => k !== a.idempotencyKey), [], `${id}: nothing after unknown ${a.idempotencyKey}`);
      const line = Object.values(r.state.journal).find(j => j.key === a.idempotencyKey);
      if (line) assert.ok(['sent', 'unresolved'].includes(line.state), `${id}: ${a.idempotencyKey} still held (${line.state})`);
    }
    // Cost: the two ledgers agree call by call; no key twice; nothing left reserved.
    const l5 = s.ledger5(id);
    const items = [...l5.items.values()];
    const c = l5.classes();
    const rec = r.ledger.get(r.id);
    const holds = Object.values(rec.holds).filter(h => h.category === 'inference');
    assert.equal(new Set(items.map(i => i.key)).size, items.length, `${id}: a cost key once`);
    assert.equal(BigInt(c.settled), BigInt(rec.bal.spent.inference ?? 0), `${id}: settled = spent`);
    assert.equal(BigInt(c.undecided), sum(holds.filter(h => h.state === 'unresolved').map(h => h.amount)), `${id}: undecided = unresolved`);
    assert.equal(BigInt(c.reserved), 0n);
    // Memory: one private note per episode, no episode twice, nothing public, nothing turned into evidence.
    const eps = r.ports.memory.all();
    assert.equal(new Set(eps.map(e => e.id)).size, eps.length, `${id}: an episode once`);
    const m = s.memory12(id);
    const notes = m.knowledge({ tag: r.address, nation: null }, 2 ** 32 - 1).notes.filter(n => n.owner === r.address);
    assert.equal(notes.length, eps.length, `${id}: one note per episode`);
    const k = m.knowledge({ tag: r.address, nation: null }, 2 ** 32 - 1);
    assert.deepEqual([k.facts.length, k.commitments.length, Object.keys(k.reliability).length], [0, 0, 0]);
    // Evidence: the test world's clock is not the Season bell: 12 is never read, the withholding is recorded.
    const ev = decisionsOf(r).filter(d => d.evidence).flatMap(d => d.evidence.map(e => e.status));
    assert.ok(ev.every(x => x === 'clock_mismatch'), `${id}: evidence withheld (${[...new Set(ev)]})`);
    if (process.env.WS13_DEBUG) t.diagnostic(`${id} rows: ${JSON.stringify(rows.map(a => [a.idempotencyKey, a.state, a.why ?? a.lastReadError ?? null]))} journal: ${JSON.stringify(Object.values(r.state.journal).map(j => [j.key, j.state, j.lastFate ?? null]))}`);
    out[id] = { sends: mine.length, keys: registered.size, lines: bases.length, newAttempts: mine.filter(k => k.includes('#a')).length, calls: items.length, settled: c.settled, undecided: c.undecided, episodes: eps.length, notes: notes.length };
    t.diagnostic(`${id}: ${JSON.stringify(out[id])}`);
  }
  assert.deepEqual(files(path.dirname(path.dirname(s.ledger5('asa').dir))).filter(f => f.endsWith('.key')), [], 'no key file');
  return out;
}

async function play(t, opts = {}, hooks = {}) {
  const out = tmp();
  const s = await stack(out, hooks);
  try {
    const r = await runDemo({ out, bells: BELLS, wire: s.wire, wrapMemory: s.wrapMemory, costFor: s.costFor, each: async all => { s.tick(all.world.bell + 1); if (hooks.each) await hooks.each(all, s); }, ...opts });
    const inv = await invariants(t, s, r.all);
    return { r, s, inv };
  } finally { s.close(); }
}

test('stack: plain', { skip, timeout: 300_000 }, async t => {
  const { inv } = await play(t);
  for (const id of ['asa', 'ren']) assert.ok(inv[id].sends > 3 && inv[id].calls > 3 && inv[id].notes > 3);
});

test('stack: restart at bell 50 (every object rebuilt from files)', { skip, timeout: 300_000 }, async t => {
  const plain = await play(t);
  const { inv } = await play(t, { restartAt: 50 });
  assert.deepEqual(inv, plain.inv, 'the same sends, keys, calls, costs and notes as without the restart');
});

test('stack: a stop right after a send', { skip, timeout: 300_000 }, async t => {
  const { r, s } = await play(t, { crash: { resident: 'ren', at: 'after-submit', turn: 3 } });
  assert.equal(r.summary.mechanical.restarts.length, 1);
  const k = s.sent.filter(([id]) => id === 'ren').map(([, k]) => k);
  assert.equal(new Set(k).size, k.length, 'the cut-off send was read back from the registry, not sent again');
});

test('stack: a reply lost after the send arrived', { skip, timeout: 300_000 }, async t => {
  const { s, r } = await play(t, {}, { loseReply: (id, key, n) => id === 'ren' && n === 2 });
  assert.equal(s.lost.length, 1);
  const key = s.lost[0];
  const line = Object.values(r.all.ren.state.journal).find(j => j.key === key);
  assert.ok(!line || line.state === 'landed', `kept under its key and settled by reading: ${line?.state}`);
  assert.deepEqual([...new Set(family(s.sent.map(([, k]) => k), key))], [key], 'never a new key for it');
  assert.ok(s.sent.filter(([, k]) => k === key).length <= 2, 'at most one re-send under the same key');
});

test('stack: an operator halt right after a send, the registry cannot cancel, and the result arrives late', { skip, timeout: 300_000 }, async t => {
  let target = null, haltAt = null;
  const late = 70;
  const { r, s } = await play(t, {}, {
    fateOverride: (agent, key, bell) => (key === target && bell < late ? { state: 'unknown', sent: true, signature: 'sigLate' } : undefined),
    each: async (all, st) => {
      const ren = all.ren, b = all.world.bell;
      if (!target) {
        const k = st.sent.find(([id]) => id === 'ren')?.[1];
        if (k) {
          target = k; haltAt = b;
          writeFileSync(ren.charter.haltFile, 'operator halt (test)');
          const c = await ren.ports.execution.cancel(k);
          st.cancels.push(c);
        }
      }
      if (haltAt !== null && b === haltAt + 40 && existsSync(ren.charter.haltFile)) rmSync(ren.charter.haltFile);
      if (target && b === late - 1) {
        const line = Object.values(ren.state.journal).find(j => j.key === target);
        assert.ok(['sent', 'unresolved'].includes(line.state), `held while unknown: ${line.state}`);
      }
    },
  });
  assert.deepEqual(s.cancels, [{ cancelled: false, reason: 'NotSupported' }], 'signed bytes cannot be recalled');
  assert.deepEqual([...new Set(family(s.sent.map(([, k]) => k), target))], [target], 'not re-sent, under any key, before or after the halt');
  const line = Object.values(r.all.ren.state.journal).find(j => j.key === target);
  assert.ok(!line || line.state === 'landed', `the late result settled it: ${line?.state}`);
  const row = (await s.acts.list('ws13-ren')).acts.find(a => a.idempotencyKey === target);
  assert.equal(row.state, 'landed', '4 recorded the late answer (unknown is not final)');
});

test('stack: a stop in the middle of a model call', { skip, timeout: 300_000 }, async t => {
  const { inv } = await play(t, { crash: { resident: 'ren', at: 'during-inference', turn: 3 } });
  assert.ok(BigInt(inv.ren.undecided) > 0n, 'that call is undecided in both ledgers, not released, not 0');
  assert.equal(inv.asa.undecided, '0');
});
