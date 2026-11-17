#!/usr/bin/env node
// The resident's saved respond results, read once and printed as JSON (2026-11-17). An explicit command: it does
// something only when run as `node workstreams/13-citizens/bin/live-enact-read.mjs …`, once, and ends.
//
//   node workstreams/13-citizens/bin/live-enact-read.mjs \
//     --resident-dir /abs/path/to/resident --wallet <base58> --herald http://127.0.0.1:8080 --board http://127.0.0.1:41873
//
// Reads the enact journal and its lock's metadata; only when a `sending` line needs the board's answer, GETs the
// herald's /h/season and the board's /coop/config and /coop/view. Writes nothing; no lock is made or removed; no key,
// proposal, signature, POST or re-send; nothing is chosen for you. Not the one-step entry (live-once.mjs).
// Exit 0: a result (whatever the lines say: posted, confirmed, unknown, held, …); 1: not read (the directory or the
// journal not readable) or an error; 64: usage or a missing setting.
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { readOnceConfig, runReadOnce, READ_ONCE_KIND } from '../resident/live/read-once.mjs';

const OPTIONS = { 'resident-dir': { type: 'string' }, wallet: { type: 'string' }, herald: { type: 'string' }, board: { type: 'string' } };

/** The settings from the command line: only what was given; nothing is filled in. */
export const inputOf = v => ({ residentDir: v['resident-dir'], wallet: v.wallet, heraldUrl: v.herald, boardUrl: v.board });

/** One classification for the command: settings → 64; a result → 0; not read or an error → 1. */
export const exitOf = r => (r?.outcome === 'config-missing' || r?.outcome === 'usage' ? 64 : r?.outcome === 'result' ? 0 : 1);

export async function main(argv = process.argv.slice(2), { print = s => process.stdout.write(`${s}\n`), run = runReadOnce } = {}) {
  let v;
  try { ({ values: v } = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false })); }
  catch (e) { print(JSON.stringify({ kind: READ_ONCE_KIND, outcome: 'usage', why: String(e?.message ?? e).slice(0, 160) })); return 64; }
  const c = readOnceConfig(inputOf(v));
  if (!c.ok) { print(JSON.stringify({ kind: READ_ONCE_KIND, outcome: 'config-missing', missing: c.missing, refused: c.refused })); return 64; }
  const r = await run(c.config);
  print(JSON.stringify(r, null, 2));
  return exitOf(r);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
