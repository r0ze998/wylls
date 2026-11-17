// How the server's JSON store behaves as operation history grows (a continuing world never resets it).
// Writes a store with N operations shaped like real ones (steps, seen records, receipts' fields) into a temporary
// directory and times a save (the server writes the whole file after each change) and a load (a restart).
//   node bench/store-growth.mjs 1000 10000 50000
import { mkdtempSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.mjs';

const op = i => ({ id: `op_${String(i).padStart(24, '0')}`, requestId: `req-bench-${i}`, planId: `pln_${i}`, linkId: `lnk_${i % 50}`, kind: 'caravan.send', state: 'completed', outcome: 'delivered',
  createdAt: new Date(1_785_000_000_000 + i * 60_000).toISOString(), updatedAt: new Date(1_785_000_000_000 + i * 60_000 + 300_000).toISOString(), context: 'Prog111:5',
  steps: ['requested', 'accepted', 'processing', 'completed'].map(s => ({ state: s, at: new Date(1_785_000_000_000 + i * 60_000).toISOString(), detail: 'the caravan arrived and was settled' })),
  planSummary: { from: 'vault:1,2,33', to: 'village:1,2,3', cargo: { Stone: 100 }, steps: 3, estimatedMinutes: 18, seq: i },
  caravan: { seq: i, ownerTag: '1234567890123456789', arriveAt: new Date().toISOString(), mine: { by: 'CARAVAN_SENT signed by this request', kind: 'CARAVAN_SENT', signature: 'x'.repeat(88), slot: i, event: String(i * 3) },
    seen: [{ kind: 91, name: 'CARAVAN_SENT', signature: 'x'.repeat(88), slot: i, event: String(i * 3), bell: 30, payload: { dst: '12345', cargo: [0, 0, 100, 0, 0, 0, 0, 0], worn_bps: 0, arrive_ts: 1785700000 } },
      { kind: 92, name: 'CARAVAN_SETTLED', signature: 'y'.repeat(88), slot: i + 9, event: String(i * 3 + 2), bell: 40, payload: { cargo: [0, 0, 100, 0, 0, 0, 0, 0], outcome: 0 } }],
    settle: { record: { kind: 'CARAVAN_SETTLED', signature: 'y'.repeat(88) }, cargoLogged: { Stone: 100 }, precision: 'whole units, floor(milli / 1000)' } },
  gateway: { status: 'sent', signature: 'x'.repeat(88), code: null, replayed: false, charges: [] }, chain: { state: 'landed', slot: i, commitment: 'finalized', fee: 10000 },
  eventsCursor: String(i * 3 + 2), attempts: 1, unknownSince: null, grant: 'consumed' });

const rows = [];
for (const n of process.argv.slice(2).map(Number)) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wylls-bench-'));
  const file = path.join(dir, 'store.json');
  const s = new JsonStore(file);
  for (let i = 0; i < n; i++) s.state.operations[`op_${i}`] = op(i);
  let t = performance.now(); s.save(); const save = performance.now() - t;
  t = performance.now(); const r = new JsonStore(file); const load = performance.now() - t;
  t = performance.now(); Object.values(r.state.operations).filter(o => o.linkId === 'lnk_7').sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50); const query = performance.now() - t;
  rows.push({ operations: n, fileMB: +(statSync(file).size / 1e6).toFixed(1), saveMs: Math.round(save), loadMs: Math.round(load), ownerQueryMs: Math.round(query), heapMB: Math.round(process.memoryUsage().heapUsed / 1e6) });
  rmSync(dir, { recursive: true, force: true });
}
// The same history with the archive: N finished operations archived, 200 unfinished in the main store.
for (const n of process.argv.slice(2).map(Number)) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wylls-bench-'));
  const file = path.join(dir, 'store.json');
  const s = new JsonStore(file);
  let t = performance.now();
  for (let i = 0; i < n; i++) s.archive(op(i));
  const archiveAll = performance.now() - t;
  for (let i = n; i < n + 200; i++) s.state.operations[`op_${String(i).padStart(24, '0')}`] = { ...op(i), state: 'accepted' };
  t = performance.now(); s.save(); const save = performance.now() - t;
  t = performance.now(); const r = new JsonStore(file); const load = performance.now() - t;
  t = performance.now(); const list = r.operationsOf(['lnk_7'], 50); const query = performance.now() - t;
  t = performance.now(); r.operation(`op_${String(Math.floor(n / 2)).padStart(24, '0')}`); const one = performance.now() - t;
  rows.push({ archived: n, mainOps: 200, mainFileMB: +(statSync(file).size / 1e6).toFixed(2), archiveMB: +(statSync(`${file}.archive.jsonl`).size / 1e6).toFixed(1), saveMs: Math.round(save), loadMs: Math.round(load), ownerQueryMs: Math.round(query), listed: list.length, oneMs: +one.toFixed(2), archiveEachMs: +(archiveAll / n).toFixed(3), heapMB: Math.round(process.memoryUsage().heapUsed / 1e6) });
  rmSync(dir, { recursive: true, force: true });
}
console.log(JSON.stringify(rows, null, 1));
