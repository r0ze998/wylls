#!/usr/bin/env node
// Regenerates scenarios/fixtures/ws01-e2e-48f34e77.json from ①'s own end-to-end script (test/scenario-e2e.mjs at
// 48f34e77991846fc709b0e2e088c81c135aea185, origin/ws/01-coop-s1): ①'s board (fold() through ①'s boardForEvaluators,
// contract ws01-board v1), the S1 records of the same run (the fake chain's transaction logs, read with the game's
// decodePage), and what ① itself counted. Extract ① first (read only), then run under a key guard:
//   git archive 48f34e77 workstreams/01-national-strategy permutation-server/web | tar -x -C <dir>
//   node --import <no-keys-guard.mjs> workstreams/15-coop-outcomes/scenarios/fixtures/gen-ws01-e2e.mjs <dir>
// ①'s script makes no key and no signature: wallets are fixed 32-byte strings, signature fields fixed bytes; the
// account addresses and owner tags are real S1 public-address computations (PDA, create_with_seed).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? '');
const ws = `${root}/workstreams/01-national-strategy`;
const { runScenario } = await import(`${ws}/test/scenario-e2e.mjs`);
const { boardForEvaluators } = await import(`${ws}/coop/export.mjs`);
const { decodePage } = await import(`${root}/permutation-server/web/frontier/flog.mjs`);
const r = await runScenario(fs.mkdtempSync(path.join(os.tmpdir(), 'ws15-ws01-')));
const raw = [];
for (const [sig, t] of r.ch.txs) for (const l of t.logs) if (l.startsWith('Program data: UFMy ')) raw.push({ seq: raw.length, slot: t.slot, sig, body_b64: l.slice('Program data: UFMy '.length) });
const plain = v => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? [...v] : Array.isArray(v) ? v.map(plain)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)])) : v);
const counted = r.after.arrivals.reduce((t, a) => { for (const [k, v] of Object.entries(a.counted ?? {})) t[k] = (t[k] ?? 0) + v; return t; }, {});
const out = {
  source: { repo: 'r0ze998/wylls', branch: 'ws/01-coop-s1', commit: '48f34e77991846fc709b0e2e088c81c135aea185',
    code: 'workstreams/01-national-strategy/test/scenario-e2e.mjs runScenario; coop/export.mjs boardForEvaluators; permutation-server/web/frontier/flog.mjs decodePage',
    note: 'Produced by ①\'s own script and functions. The chain is ①\'s fake chain (test/coop-chain.mjs); no key, no signature.' },
  contexts: r.board.contexts ?? null,
  board: boardForEvaluators(r.board.state(), { contexts: r.board.contexts ?? [] }),
  labels: Object.fromEntries(Object.entries(r.ids).map(([k, id]) => [id, k])),
  tags: r.tags,
  wallets: Object.fromEntries(Object.entries((await import(`${ws}/test/scenario-e2e.mjs`)).W).map(([k, w]) => [w.address, k])),
  page: plain(decodePage(raw).records),
  countedBy1: counted,
  arrivalsBy1: plain(r.after.arrivals.map(a => ({ requestId: a.requestId, caravanId: a.caravanId, state: a.state, source: a.source, counted: a.counted ?? null, duplicateOf: a.duplicateOf ?? null }))),
};
fs.writeFileSync(new URL('./ws01-e2e-48f34e77.json', import.meta.url), `${JSON.stringify(out, null, 1)}\n`);
console.log('requests', out.board.requests.length, 'records', out.page.length, 'counted', JSON.stringify(counted));
