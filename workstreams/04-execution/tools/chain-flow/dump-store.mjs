// Writes 4's run store as JSON (world, receipts, runs; u64 fields kept as the raw JSON text). Read only.
// Usage: node dump-store.mjs <store.sqlite> <out.json>
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const [dbPath, outPath] = process.argv.slice(2);
const db = new DatabaseSync(dbPath, { readOnly: true });
const o = {
  world: db.prepare("SELECT value FROM meta WHERE name = 'world'").get()?.value ?? null,
  receipts: db.prepare('SELECT run_id, kind, subject, source, slot, body FROM receipts ORDER BY slot, kind').all().map(r => ({ ...r })),
  runs: db.prepare('SELECT run_id, state, spec, detail FROM runs').all().map(r => ({ ...r })),
};
db.close();
writeFileSync(outPath, JSON.stringify(o, null, 2));
