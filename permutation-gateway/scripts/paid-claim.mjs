// Claims for the paid dev-wallet members of a local stack season (test
// tokens only, no value): after prize-settle.mjs (Tally, Finalize) and its
// --set-shares (--out <out>/shares), every wallet of <out>/wallets.json
// (paid-join.mjs) sends a Claim with its ledger proof through the relay,
// as prize-e2e.mjs step 5 does. A member of a losing nation, or one with
// no points in a scored split, is refused by the program and reported so.
//
//   PAID_JOIN_URL=http://127.0.0.1:41840 PAID_JOIN_OUT=.local/prize/sc-14d node permutation-gateway/scripts/paid-claim.mjs
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { keyFromSeed } from '../../permutation-server/web/session.mjs';
import { toBase64, toHex } from '../../permutation-server/web/sdk/bytes.mjs';
import { claimIx } from '../client/src/frontier/prize.mjs';
import { FrontierAddresses } from '../client/src/frontier/addresses.mjs';
import { compileMessage, wireTransaction } from '../client/src/solana-tx.mjs';

const base = process.env.PAID_JOIN_URL ?? 'http://127.0.0.1:41840';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(base).hostname), 'local test chain only');
const outDir = path.resolve(process.env.PAID_JOIN_OUT ?? '.local/prize/paid-join');
const gw = `${base}/gw`;
const json = x => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? toHex(v) : v), 2);
const api = async (p, body) => {
  const r = await fetch(gw + p, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const saved = JSON.parse(readFileSync(path.join(outDir, 'wallets.json'), 'utf8'));
const posted = JSON.parse(readFileSync(path.join(outDir, 'shares', 'ledger.json'), 'utf8'));
const terms = (await api('/f/season')).body;
assert.ok(terms.prize, 'the stack runs without --prize-so');
const A = new FrontierAddresses({ programId: saved.programId, seasonId: BigInt(saved.season) });
const pool = (await api('/f/prize')).body;
console.log('pool', json({ state: pool.state, winners: pool.winners, prize: pool.prize, mode: posted.shares?.mode ?? posted.estimate?.mode }));
const claims = [];
for (const w of saved.wallets) {
  const key = await keyFromSeed(Buffer.from(w.seed, 'hex'));
  const m = (posted.shares?.members ?? []).find(x => x.wallet === w.wallet);
  const before = (await api(`/f/prize?wallet=${w.wallet}`)).body.wallet?.balance ?? null;
  const { feePayer, blockhash } = (await api('/f/relay')).body;
  const ix = claimIx({ prize: terms.prize, wallet: w.wallet, citizen: A.citizen(w.wallet), nation: m?.nation ?? w.faction,
    points: BigInt(m?.points ?? 0), proof: (m?.proof ?? []).map(x => Buffer.from(x, 'hex')) });
  const message = compileMessage({ feePayer, recentBlockhash: blockhash, instructions: [ix] });
  const wire = wireTransaction(message, { [w.wallet]: await key.sign(message) });
  const r = await api('/f/prize/claim', { tx: toBase64(wire) });
  const after = (await api(`/f/prize?wallet=${w.wallet}`)).body.wallet?.balance ?? null;
  const received = before !== null && after !== null ? String(BigInt(after) - BigInt(before)) : null;
  claims.push({ wallet: w.wallet, nation: w.faction, inLedger: !!m, points: m?.points ?? 0, status: r.status, code: r.body.code ?? null, signature: r.body.signature ?? null, testUsdcBefore: before, testUsdcAfter: after, received });
  console.log(`claim ${w.wallet} (nation ${w.faction}, points ${m?.points ?? 0}): ${r.status} ${r.body.code ?? r.body.signature ?? ''} received ${received}`);
}
const end = (await api('/f/prize')).body;
writeFileSync(path.join(outDir, 'claims.json'), `${json({ testAssetsOnly: true, base, season: saved.season, claims, poolAfter: end })}\n`);
console.log(`wrote ${path.join(outDir, 'claims.json')}`);
