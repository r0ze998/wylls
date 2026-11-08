#!/usr/bin/env node
// Reads the centre's facts from a running herald or from saved feeds and
// prints them (wylls.ws14.centre-facts/1). Read-only: public GETs only, no
// keys, no signing, no transactions.
//
//   node workstreams/14-central-tower/game/centre-cli.mjs --herald http://127.0.0.1:41940 [--at <label>]
//     (reads /h/status before and after the two feeds: the output's provenance)
//   node workstreams/14-central-tower/game/centre-cli.mjs --caravans caravans.json [--structures structures.json] [--at <label>]
import { readFileSync } from 'node:fs';
import { centreFacts } from './centre.mjs';

const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const herald = opt('--herald');

async function get(path) {
  const r = await fetch(new URL(path, herald));
  if (r.status === 404 && path.endsWith('structures.json')) return null;   // a herald without the S1 feeds
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

let caravans, structures, status = null;
if (herald) {
  const before = await get('/h/status').catch(() => null);
  caravans = await get('/h/caravans.json');
  structures = await get('/h/structures.json');
  const after = await get('/h/status').catch(() => null);
  status = { before, after };
} else if (opt('--caravans')) {
  caravans = JSON.parse(readFileSync(opt('--caravans'), 'utf8'));
  structures = opt('--structures') ? JSON.parse(readFileSync(opt('--structures'), 'utf8')) : null;
} else {
  console.error('usage: --herald <url> | --caravans <file> [--structures <file>]');
  process.exit(2);
}
const out = centreFacts({ caravans, structures, status, observedAt: opt('--at') });
console.log(JSON.stringify(out, null, 1));
if (out.refused) process.exit(1);
