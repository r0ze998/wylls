// Records the herald files the census reads (read-only GETs) into ai-census-herald-recorded.json, for the census test.
// Not run by the tests. It was run once on 2026-10-04 against the paused m1-exit herald (a local test chain, bot seed 1):
//   node permutation-gateway/test/fixtures/ai-census-record.mjs http://127.0.0.1:41040 146 147
// The bots 146 and 147 stand in for AI citizens (they are script bots of that run); the roster of the test is written
// by the test, not recorded. The census windows are 2 provinces here to keep the file small.
import fs from 'node:fs';
import { createHerald } from '../../../permutation-server/web/frontier/herald.mjs';
import { collectCensus } from '../../citizens/scenario/census.mjs';
import { walletOf } from '../../citizens/registrar.mjs';

const [base, ...idx] = process.argv.slice(2);
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base ?? '')) throw new Error('usage: ai-census-record.mjs http://127.0.0.1:PORT index...');
const seen = new Map();
const f = async (url, o) => {
  const r = await fetch(url, o);
  const body = Buffer.from(await r.arrayBuffer());
  seen.set(url.slice(base.length), { status: r.status, type: r.headers.get('content-type'), body_b64: body.toString('base64') });
  return new Response(body, { status: r.status, headers: { 'content-type': r.headers.get('content-type') } });
};
const roster = { ai: idx.map(Number).map(i => ({ index: i, tag: `t${i}`, faction: 0, wallet: walletOf(1, i).b58 })) };
await collectCensus({ herald: createHerald({ base, fetch: f }), roster, window: 2 });
fs.writeFileSync(new URL('./ai-census-herald-recorded.json', import.meta.url), `${JSON.stringify({ recorded_unix: Math.floor(Date.now() / 1000), source: 'paused m1-exit herald, local test chain, bot seed 1', roster, files: Object.fromEntries(seen) })}\n`);
