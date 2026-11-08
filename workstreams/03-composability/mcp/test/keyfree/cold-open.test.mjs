// The one-off failure of integration.test.mjs "③ and ⑤ on one agent and one ④ registry" (④/⑯ on candidate 4d44f021:
// line 85 got [undefined, true, 'real']; doc 24), made deterministic. ③ and ⑤ register on ONE brand-new run store at
// the same time; the failing run is the interleaving where ⑤'s runexec is in the middle of the store's first open
// (switching the new file to WAL) when ③'s runexec opens it. ④ 16576826's Store::open then answers ③ "database is
// locked" at once, without its busy wait, so ③ sends nothing and answers RunRegistryUnavailable (no `state`), while
// ⑤'s register completes.
//
// The interleaving is forced, not timed: while ③'s register runs, a SQLite connection holds the lock that a runexec
// in the middle of Store::open holds on that file. On a new file that is the write lock of the switch to WAL (a
// rollback-journal write transaction). On a store already opened once it is only a read, because PRAGMA
// journal_mode=WAL and CREATE TABLE IF NOT EXISTS then change nothing. ⑤'s register starts after ③'s has answered,
// as the open that completes. Measured on ④ 16576826's runexec: a new file with that write lock held answers
// StoreError "database is locked" in 0.00 s; the opened store with the read held registers.
//
// KEY-FREE, PDA-FREE: SQLite (node:sqlite) and ④'s runexec, which writes only SQLite. REAL: ③'s server, ④'s
// runexec and clients/acts.mjs, ⑤'s acts-port, the wallet's capability check. MOCK: the send's answer, the node, the herald.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { HAS_0008, HAS_FATE, OWNER, keyfreeWorld, mcpServer, openRunStore } from './harness.mjs';

const BIN = process.env.RUNEXEC_BIN;
const CLIENT4 = process.env.WS04_ROOT && path.join(process.env.WS04_ROOT, 'workstreams/04-execution/clients/acts.mjs');
const PORT5 = process.env.WS05_ROOT && path.join(process.env.WS05_ROOT, 'workstreams/05-ai-participation/model-api/src/acts-port.mjs');
const skip = [!HAS_FATE && 'needs the wallet with GET /f/agent/fate', !HAS_0008 && 'needs patch 0008', (!BIN || !existsSync(BIN)) && 'set RUNEXEC_BIN',
  (!CLIENT4 || !existsSync(CLIENT4)) && 'set WS04_ROOT', (!PORT5 || !existsSync(PORT5)) && 'set WS05_ROOT'].find(Boolean) ?? false;

/** What another runexec holds on `db` while it is in the middle of Store::open; returns its release. */
function openInProgress(db) {
  const c = new DatabaseSync(db, { timeout: 0 });
  const cold = c.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal';
  if (cold) c.exec('BEGIN IMMEDIATE'); // the switch of a new file to WAL: a rollback-journal write
  else { c.exec('BEGIN'); c.prepare('SELECT count(*) AS n FROM sqlite_master').get(); } // an opened store: reads only
  return { cold, release() { c.exec('ROLLBACK'); c.close(); } };
}

/** Test 17's first step (integration.test.mjs: ③'s send and ⑤'s register at once), with that interleaving forced. */
async function threeAndFiveAtOnce({ openFirst }) {
  const { createActsClient } = await import(pathToFileURL(CLIENT4).href);
  const five = await import(pathToFileURL(PORT5).href);
  const w = await keyfreeWorld();
  const fp = await w.fatePort();
  try {
    const db = path.join(mkdtempSync(path.join(tmpdir(), 'ws03-cold-')), 'runs.db');
    if (openFirst) await openRunStore(createActsClient, BIN, db);
    const gatewayPort = fp.address().port;
    const real3 = createActsClient({ bin: BIN, db, gatewayPort });
    let threeAnswered;
    const threeDone = new Promise(r => { threeAnswered = r; });
    const seen = {};
    const acts3 = { ...real3, async register(a) {
      const other = openInProgress(db); // ⑤'s runexec is in the middle of the store's first open
      seen.cold = other.cold;
      // ⑤'s open ends on its own shortly (a Store::open that waits for it then proceeds; 16576826's does not wait).
      let released = false;
      const end = () => { if (!released) { released = true; other.release(); } };
      const timer = setTimeout(end, 300);
      try { return await real3.register(a); } finally { clearTimeout(timer); end(); threeAnswered(); }
    } };
    const real5 = five.fourActsPort(createActsClient({ bin: BIN, db, gatewayPort }));
    const port5 = { ...real5, async register(a) { await threeDone; return real5.register(a); } }; // ⑤'s open completes
    const s = mcpServer(w, { acts: acts3 });
    const link = s.connectAs(w.g.issueSourceCapability(w.agentId, OWNER, 'mcp').capability.token);
    const reg5 = five.registerBeforeSend(port5, { agentId: w.agentId, source: 'ai' });
    const p = await s.plan(link);
    const [r3, g5] = await Promise.all([s.tool(link, 'send_caravan', { planId: p.planId, requestId: 'req-kf-reg01' }), reg5({ requestId: 'p05.kf.1' })]);
    return { w, s, link, p, r3, g5, seen };
  } finally { fp.close(); }
}

test('old setup (a new run store opened first by ③ and ⑤ at once), interleaving forced: [undefined, true, \'real\'] — 4d44f021\'s failure', { skip }, async (t) => {
  const { w, r3, g5, seen } = await threeAndFiveAtOnce({ openFirst: false });
  assert.equal(seen.cold, true);
  if (r3.state === 'accepted') { // a runexec whose Store::open waits for the other open (④'s fix): no failure to reproduce
    t.diagnostic('this runexec registered through the other open: the cold-open race is fixed in ④\'s store');
    assert.deepEqual([g5.ok, w.script.posts], [true, 1]);
    return;
  }
  assert.deepEqual([r3.state, g5.ok, g5.connection], [undefined, true, 'real'], 'the values of the failing assertion at integration.test.mjs:85');
  assert.deepEqual([r3.error?.code, r3.error?.retrySameRequestId], ['RunRegistryUnavailable', true]);
  assert.match(r3.error.message, /StoreError/);
  assert.equal(w.script.posts, 0, '③ sent nothing');
});

test('current setup (harness.mjs openRunStore), the same interleaving: test 17\'s first assertion holds', { skip }, async () => {
  const { w, r3, g5, seen } = await threeAndFiveAtOnce({ openFirst: true });
  assert.equal(seen.cold, false);
  assert.deepEqual([r3.state, g5.ok, g5.connection], ['accepted', true, 'real'], JSON.stringify(r3.error ?? {}));
  assert.equal(w.script.posts, 1);
});
