// Paid members for a running local stack (test tokens only, no value): N
// dev wallets take test USDC from the relay's faucet, join over x402 (the
// entry fee, exactly as a person's browser does: prize-e2e.mjs step 1),
// place their first village and build once, so a bot season has paid
// members and a prize pool to settle at its end. Their key seeds are saved
// (test keys) for the claims after prize-settle.mjs --set-shares.
//
//   PAID_JOIN_URL=http://127.0.0.1:41840 PAID_JOIN_N=3 PAID_JOIN_OUT=.local/prize/sc-14d \
//   [PAID_JOIN_FACTIONS=0,1,2] node permutation-gateway/scripts/paid-join.mjs
//
// PAID_JOIN_URL is the herald (its /gw proxies the relay). Nations are
// taken round-robin unless PAID_JOIN_FACTIONS lists them.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHerald } from '../../permutation-server/web/frontier/herald.mjs';
import { setPin, setRelay } from '../../permutation-server/web/frontier/fchainio.mjs';
import { homeSites } from '../../permutation-server/web/frontier/home.mjs';
import { submit, track, accountsFor } from '../../permutation-server/web/frontier/fplay.mjs';
import { keyFromSeed } from '../../permutation-server/web/session.mjs';
import { devWallet, connect } from '../../permutation-server/web/wallet.mjs';
import { toHex } from '../../permutation-server/web/sdk/bytes.mjs';
import { ringProvinces } from '../../permutation-server/web/frontier/fgeo.mjs';
import { joinViaX402 } from '../client/src/frontier/prize.mjs';

const base = process.env.PAID_JOIN_URL ?? 'http://127.0.0.1:41840';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(base).hostname), 'local test chain only');
const n = Number(process.env.PAID_JOIN_N ?? 3);
const outDir = path.resolve(process.env.PAID_JOIN_OUT ?? '.local/prize/paid-join');
const factions = (process.env.PAID_JOIN_FACTIONS ?? '').split(',').filter(Boolean).map(Number);
mkdirSync(outDir, { recursive: true });
const gw = `${base}/gw`;
const json = x => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? toHex(v) : v), 2);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const api = async (p, body) => {
  const r = await fetch(gw + p, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
async function eventually(label, fn, ms = 120000) {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(500); }
  throw new Error(`${label}: timeout; ${json(last)}`);
}
async function action(name, player, fields, extra = {}) {
  let sent;
  for (let i = 0; i < 6; i++) {
    sent = await submit({ name, accounts: accountsFor(name, { ...player.context, ...extra }), fields, signer: { session: player.session } });
    if (sent.ok || !['network', 'Unavailable', 'HTTP502', 'HTTP504'].includes(sent.code)) break;
    await sleep(5000);
  }
  assert.equal(sent.ok, true, `${name} submit ${json(sent)}`);
  const landed = await track(sent.signature, { tries: 80, every: 500 });
  assert.equal(landed.ok, true, `${name} track ${json(landed)}`);
  return sent.signature;
}

const h = createHerald({ base });
const s = await eventually('season ready', async () => { const r = await h.season(); return r.ok && r.record.rings?.length >= 5 ? r : null; });
assert.equal(s.record.cluster, 'localnet');
const pin = setPin({ programId: s.record.programId, cluster: s.record.cluster, seasonId: s.record.season, seasonAddress: s.record.seasonAddress, rulesetHash: toHex(s.season.rulesetHash) });
h.pin(s.record.season, pin.addresses); setRelay(gw);
const terms = (await api('/f/season')).body;
assert.ok(terms.prize, 'the stack runs without --prize-so');
const pool0 = (await api('/f/prize')).body;
const ringsOpen = s.record.rings.length;
const wallets = [];
for (let i = 0; i < n; i++) {
  const faction = factions.length ? factions[i % factions.length] : i % 6;
  let home = null;
  for (const ring of [2, 3]) {
    for (const at of ringProvinces(ring)) {
      const r = await h.province(at.p, at.q);
      if (!r.ok) continue;
      const sites = homeSites(r.province, { faction, ringsOpen });
      if (sites.length) { home = sites[0]; break; }
    }
    if (home) break;
  }
  assert.ok(home, `no free home site for nation ${faction}`);
  const seed = randomBytes(32), sessionSeed = randomBytes(32);
  const key = await keyFromSeed(seed), session = await keyFromSeed(sessionSeed);
  const wallet = await connect(devWallet(key), { chain: 'solana:localnet' });
  const faucet = await api('/f/faucet', { wallet: wallet.address });
  assert.equal(faucet.status, 200, json(faucet));
  const joined = await joinViaX402(gw, { wallet: wallet.address, sign: m => key.sign(m), faction, session: session.publicKeyBytes,
    sessionExpiry: BigInt(s.record.latestUnix) + 14n * 86400n, maxFee: 25_000_000n });
  const player = { key, wallet, session, home, context: { addresses: pin.addresses, wallet: wallet.address, actor: session.publicKey, faction, holding: home, province: home } };
  const placed = await action('PlaceHome', player, { p: home.p, q: home.q, site: home.site });
  await eventually('immediate final home', async () => { const r = await h.me(wallet.address); return r.ok && r.holdings[0]?.state === 2 ? r : null; });
  const built = await action('Build', player, { item: 0 }, { item: 0 });
  wallets.push({ wallet: wallet.address, faction, home, seed: toHex(seed), sessionSeed: toHex(sessionSeed), join: joined.signature, placeHome: placed, build: built });
  console.log(`joined ${wallet.address}: nation ${faction}, home (${home.p}, ${home.q}, ${home.site}), join ${joined.signature}`);
}
const pool = (await api('/f/prize')).body;
writeFileSync(path.join(outDir, 'wallets.json'), `${json({ testAssetsOnly: true, base, season: s.record.season, programId: s.record.programId, wallets, poolBefore: pool0, poolAfter: pool })}\n`);
console.log('pool', json({ entries: pool.entries, collected: pool.collected, prize: pool.prize, ops: pool.ops }));
console.log(`wrote ${path.join(outDir, 'wallets.json')}`);
