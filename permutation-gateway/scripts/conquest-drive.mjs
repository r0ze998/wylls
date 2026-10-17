// Drives one wallet through the conquest paths a script fleet never takes
// (test tokens only, no value): a paid x402 join, a village, troops, a
// march onto a ring-4 Free City, the horn (DeclareSiege), the capture
// settled by the keeper, the Town tier-up, an outpost filed (FileOutpost)
// and settled, then the season's end — so a disposable local season has
// SIEGE_DECLARED, CONQUEST, CAPTURE_SETTLED, TICKET and OUTPOST_SETTLED
// records for the verifier's V14–V22. The test clock is advanced
// (frontier_setScale) as prize-e2e.mjs does; the stack's keepers do the
// settlements. Wallet keys are ephemeral, the key seed is saved.
//
//   frontier-stack up --conquest --mode accel --beacon test-key --scale 10 --game-hours 120 \
//     --season-end-at-play-end --bots 0 --prize-so … --run-id sc-drive --base-port 41900 …
//   CQ_DRIVE_URL=http://127.0.0.1:41940 CQ_DRIVE_RPC=http://127.0.0.1:41910 CQ_DRIVE_OUT=.local/prize/sc-drive \
//   node permutation-gateway/scripts/conquest-drive.mjs
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { createHerald } from '../../permutation-server/web/frontier/herald.mjs';
import { setPin, setRelay, nudge, reveal } from '../../permutation-server/web/frontier/fchainio.mjs';
import { homeSites } from '../../permutation-server/web/frontier/home.mjs';
import { submit, track, accountsFor } from '../../permutation-server/web/frontier/fplay.mjs';
import { keyFromSeed } from '../../permutation-server/web/session.mjs';
import { devWallet, connect } from '../../permutation-server/web/wallet.mjs';
import { toHex } from '../../permutation-server/web/sdk/bytes.mjs';
import { bellAt, seasonClock } from '../../permutation-server/web/frontier/clock.mjs';
import { ringProvinces } from '../../permutation-server/web/frontier/fgeo.mjs';
import { hostsIn, freeSitesOf } from '../../permutation-server/web/frontier/fland.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { loadKernel } from '../../permutation-server/web/frontier/wasm.mjs';
import { planRoute, earliestBell, plaintextOf, tipOptions, freeTransitSlot } from '../../permutation-server/web/frontier/fmarch.mjs';
import { sealMarch } from '../../permutation-server/web/frontier/seal.mjs';
import { joinViaX402 } from '../client/src/frontier/prize.mjs';

const base = process.env.CQ_DRIVE_URL ?? 'http://127.0.0.1:41940';
const rpcUrl = process.env.CQ_DRIVE_RPC ?? 'http://127.0.0.1:41910';
for (const u of [base, rpcUrl]) assert.ok(['127.0.0.1', 'localhost'].includes(new URL(u).hostname), 'local test chain only');
const outDir = path.resolve(process.env.CQ_DRIVE_OUT ?? '.local/prize/sc-drive');
mkdirSync(outDir, { recursive: true });
const gw = `${base}/gw`;
const json = x => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? toHex(v) : v), 2);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { testAssetsOnly: true, base, rpcUrl, startedAt: new Date().toISOString(), steps: [] };
const save = () => writeFileSync(path.join(outDir, 'drive.json'), `${json(report)}\n`);
const step = (name, details = {}) => { report.steps.push({ name, ...details }); console.log(`${new Date().toISOString().slice(11, 19)} ${name} ${json(details).slice(0, 400)}`); save(); };
const api = async (p, body) => {
  const r = await fetch(gw + p, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
async function rpc(method, params = []) {
  const r = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json(); assert.ok(!j.error, json(j.error)); return j.result;
}
async function eventually(label, fn, ms = 180000) {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(500); }
  throw new Error(`${label}: timeout; ${json(last)}`);
}
const h = createHerald({ base });
let pin, kernel, originalScale, player;
async function action(name, fields, extra = {}) {
  let sent;
  for (let i = 0; i < 6; i++) {
    sent = await submit({ name, accounts: accountsFor(name, { ...player.context, ...extra }), fields, signer: { session: player.session } });
    if (sent.ok || !['network', 'Unavailable', 'HTTP502', 'HTTP504'].includes(sent.code)) break;
    await sleep(5000);
  }
  if (!sent.ok) return sent;
  const landed = await track(sent.signature, { tries: 80, every: 500 });
  if (!landed.ok) return { ok: false, code: landed.code ?? 'NotLanded', error: json(landed), signature: sent.signature };
  step(name, { signature: sent.signature, fields: Object.fromEntries(Object.entries(fields).filter(([k]) => !['commit', 'seal'].includes(k))) });
  return sent;
}
async function must(name, fields, extra = {}) { const r = await action(name, fields, extra); assert.equal(r.ok, true, `${name}: ${json(r)}`); return r; }
async function advanceTo(targetBell) {
  const current = await h.season(); const target = Number(current.season.genesisTs) + targetBell * 600 + 1;
  await rpc('frontier_setScale', [1000]);
  try { await eventually(`clock bell ${targetBell}`, async () => (await rpc('frontier_status')).unixTimestamp >= target, 600000); }
  finally { await rpc('frontier_setScale', [10]); }
  step('clock', { bell: targetBell });
}
async function province(p, q) { const r = await h.province(p, q); return r.ok ? r.province : null; }
async function resident(at) {
  const [s, p] = await Promise.all([h.season(), h.province(at.p, at.q)]);
  if (!s.ok || !p.ok) return null;
  const bell = bellAt(Number(s.season.genesisTs), Number(s.record.latestUnix));
  // The program's residency: the Province resolved through now_bell - 2 (the keeper resolves a contested bell at a time).
  if (p.province.resolvedNext + 1 < bell) { await nudge(at.p, at.q, p.province.resolvedNext).catch(() => {}); return null; }
  return { s, province: p.province, bell };
}
const distance = (a, b) => { const dq = a.p - b.p, dr = a.q - b.q; return Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr)); };

async function run() {
  originalScale = (await rpc('frontier_status')).scale;
  // The outer frontier open and a few bells into play (a stack that has just come up refuses a Join `WrongStatus` in its first bells).
  const s = await eventually('season a few bells in', async () => { const r = await h.season(); if (!r.ok || r.record.rings?.length < 5) return null; const bell = Math.floor((Number(r.record.latestUnix) - Number(r.season.genesisTs)) / 600); return bell >= 10 ? r : null; }, 900000);
  pin = setPin({ programId: s.record.programId, cluster: s.record.cluster, seasonId: s.record.season, seasonAddress: s.record.seasonAddress, rulesetHash: toHex(s.season.rulesetHash) });
  h.pin(s.record.season, pin.addresses); setRelay(gw);
  const terms = (await api('/f/season')).body;
  assert.ok(terms.prize, 'the stack runs without --prize-so');
  kernel = await loadKernel({ url: `${base}/frontier/frontier/wasm/frontier-v2.wasm`, ruleset: toHex(s.season.rulesetHash) });
  const seeds = s.record.rings.map(r => ({ ring: r.d, seed: r.seed }));
  const ringsOpen = s.record.rings.length;
  const genesisTs = Number(s.season.genesisTs);
  const endBell = s.season.endBell;
  report.season = s.record.season; report.programId = s.record.programId; report.endBell = endBell;

  // A home (ring 3) with a route to a Free City (ring 4) two provinces away at most.
  const freeCities = [];
  for (const at of ringProvinces(4)) {
    const pv = await province(at.p, at.q); if (!pv) continue;
    for (let i = 0; i < pv.siteCount; i++) if (pv.siteMirror[i].state === 5) freeCities.push({ p: at.p, q: at.q, site: i, tile: pv.sites[i], garrison: pv.siteMirror[i].garrison });
  }
  assert.ok(freeCities.length, 'no Free City in ring 4');
  let choice = null;
  for (const at of ringProvinces(3)) {
    const pv = await province(at.p, at.q); if (!pv) continue;
    for (const home of homeSites(pv, { ringsOpen })) {
      for (const fc of freeCities) {
        if (distance(home, fc) > 2) continue;
        const plan = planRoute(kernel, { from: home, to: { p: fc.p, q: fc.q, tile: fc.tile }, unit: 0, seeds });
        if (plan.ok && (!choice || plan.route.secs < choice.route.secs)) choice = { home, fc, route: plan.route };
      }
    }
  }
  assert.ok(choice, 'no home with a route to a Free City');
  const { home, fc, route } = choice;
  step('target', { home, freeCity: fc, routeSecs: route.secs, provinces: route.provinces });

  // The wallet: faucet, x402 join, the village.
  const seed = randomBytes(32), sessionSeed = randomBytes(32);
  const key = await keyFromSeed(seed), session = await keyFromSeed(sessionSeed);
  const wallet = await connect(devWallet(key), { chain: 'solana:localnet' });
  const faucet = await api('/f/faucet', { wallet: wallet.address }); assert.equal(faucet.status, 200, json(faucet));
  let joined;
  for (let i = 0; ; i++) {
    try {
      joined = await joinViaX402(gw, { wallet: wallet.address, sign: m => key.sign(m), faction: home.faction, session: session.publicKeyBytes,
        sessionExpiry: BigInt(s.record.latestUnix) + 14n * 86400n, maxFee: 25_000_000n });
      break;
    } catch (e) {
      if (i >= 12 || !/WrongStatus|Unavailable|network/.test(String(e?.message ?? e) + json(e?.body ?? {}))) throw e;
      step('join-retry', { attempt: i + 1, error: String(e?.message ?? e).slice(0, 160) });
      await sleep(10000);
    }
  }
  player = { key, wallet, session, home, context: { addresses: pin.addresses, wallet: wallet.address, actor: session.publicKey, faction: home.faction, holding: home, province: home } };
  report.wallet = { address: wallet.address, faction: home.faction, seed: toHex(seed), sessionSeed: toHex(sessionSeed), join: joined.signature }; save();
  await must('PlaceHome', { p: home.p, q: home.q, site: home.site });
  const me0 = await eventually('immediate final home', async () => { const r = await h.me(wallet.address); return r.ok && r.holdings[0]?.state === 2 ? r : null; });
  player.holding = me0.holdings[0];
  await must('Build', { item: 0 }, { item: 0 });

  // 36 game hours: the shield (24 h) lapses, the stores fill (stake 500 gold + the troops).
  const foundedBell = bellAt(genesisTs, Number(player.holding.finalTs));
  await advanceTo(foundedBell + 220);
  await must('Harvest', {});
  await eventually('home province current', () => resident(home));
  const troops = 1000;
  await must('Train', { unit: 0, n: troops });
  await must('Muster', { unit: 0, troops, tile: home.tile });
  await advanceTo(foundedBell + 226);
  const ready = await eventually('muster resolved', async () => {
    const p = await resident(home); if (!p) return null;
    const host = hostsIn(p.province, player.holding, p.bell).find(x => x.state === 1 && x.unit === 0 && !x.pending && x.readyBell <= p.bell);
    return host ? { ...p, host } : null;
  });
  // The march onto the Free City's tile.
  const now = await h.season();
  const dest = { p: fc.p, q: fc.q, tile: fc.tile };
  const arriveBell = Math.max(ready.bell + now.season.minLead, earliestBell(kernel, { genesisTs, departTs: Number(now.record.latestUnix) + 150, secs: route.secs }));
  const plain = plaintextOf({ host: ready.host, arriveBell, dest, route, stance: 1, retreat: { choice: 'never' } });
  const sealed = await sealMarch({ plain, clock: seasonClock(now.season), publicKey: now.record.drand.publicKey, hostId: ready.host.id, arriveBell }, { inline: true });
  assert.ok(sealed.ok, json(sealed));
  const me1 = await h.me(wallet.address); const transitSlot = freeTransitSlot(me1.holdings[0]);
  await must('Depart', { host_id: ready.host.id, commit: sealed.commit, seal: sealed.seal, arrive_bell: arriveBell, tip: tipOptions(now.season)[0].lamports, transit_slot: transitSlot });
  const revealed = await reveal({ holding: pin.addresses.of('Holding', home), transit_slot: transitSlot, plain_b64: Buffer.from(plain).toString('base64'), salt_b64: Buffer.from(sealed.salt).toString('base64'), ct_hash_b64: Buffer.from(sealed.ctHash).toString('base64') });
  assert.ok(revealed.ok, json(revealed));
  step('march', { hostId: String(ready.host.id), troops, arriveBell, dest });
  await advanceTo(arriveBell + 3);
  const arrived = await eventually('the host stands on the Free City tile', async () => {
    const pv = await province(fc.p, fc.q); if (!pv) return null;
    if (pv.resolvedNext <= arriveBell) { await nudge(fc.p, fc.q, pv.resolvedNext).catch(() => {}); return null; }
    const i = pv.entries.findIndex(e => e.id === ready.host.id && e.state === 1 && e.tile === fc.tile);
    return i >= 0 ? { pv, entry: i } : null;
  }, 300000);
  step('arrived', { entry: arrived.entry, entries: arrived.pv.entries.length, troops: String(arrived.pv.entries[arrived.entry].troops), garrison: arrived.pv.siteMirror[fc.site].garrison });

  // The horn: a capture siege on the Free City (no owner: absent accounts), once the target Province is resident.
  await must('Harvest', {});
  const res = await eventually('the Free City province resident (resolved through now - 2)', () => resident(fc), 600000);
  const bellNow = res.bell;
  const entryNow = res.province.entries.findIndex(e => e.id === ready.host.id && e.state === 1);
  assert.ok(entryNow >= 0, 'the host left the Free City tile');
  arrived.entry = entryNow;
  const horn = await action('DeclareSiege', { site: fc.site, entry: arrived.entry, nearby_site: home.site },
    { province: { p: fc.p, q: fc.q }, target: { p: fc.p, q: fc.q, site: fc.site }, ownerCitizen: Keypair.generate().publicKey.toBase58(), nearby: { p: home.p, q: home.q } });
  assert.equal(horn.ok, true, `DeclareSiege: ${json(horn)}`);
  step('horn', { bell: bellNow, signature: horn.signature });
  // The siege runs 36 counted bells (walls 0); the keeper resolves the contested bells and settles the capture.
  for (let b = bellNow + 8; b <= bellNow + 60; b += 8) {
    await advanceTo(b);
    const pv = await province(fc.p, fc.q);
    const m = pv.siteMirror[fc.site];
    const rec = pv.conquest?.[fc.site] ?? pv.conquest;
    step('siege-progress', { bell: b, resolvedNext: pv.resolvedNext, mirror: { state: m.state, faction: m.faction, order: m.order, gen: m.gen }, record: rec });
    if (m.state === 1 && m.faction === home.faction) break;
  }
  const captured = await eventually('the Free City is the wallet\'s holding', async () => {
    const r = await h.me(wallet.address); return r.ok && r.holdings.length >= 2 ? r : null;
  }, 300000);
  step('captured', { holdings: captured.holdings.map(x => ({ p: x.p, q: x.q, site: x.site, order: x.order, state: x.state })) });

  // The Town: the tier-up (wood 1,000, stone 600, gold 300; 6 h), then an outpost.
  let tierUp = null;
  for (let i = 0; i < 6 && !tierUp; i++) {
    await must('Harvest', {});
    const r = await action('Build', { item: 7 }, { item: 7 });
    if (r.ok) tierUp = r; else { step('tier-up-wait', { code: r.code }); const b = bellAt(genesisTs, Number((await h.season()).record.latestUnix)); await advanceTo(b + 60); }
  }
  assert.ok(tierUp, 'the tier-up could not be ordered');
  const bT = bellAt(genesisTs, Number((await h.season()).record.latestUnix));
  await advanceTo(bT + 40);
  await must('Harvest', {});
  const town = await eventually('the village is a Town', async () => { const r = await h.me(wallet.address); return r.ok && r.holdings[0]?.tier >= 1 ? r : null; });
  step('town', { tier: town.holdings[0].tier });
  // An outpost site: a ring-4 province within 3 of home where the faction holds less than half, a free site.
  let target = null;
  for (const at of ringProvinces(4)) {
    if (distance(home, at) > 3) continue;
    const pv = await province(at.p, at.q); if (!pv) continue;
    if (pv.siteMirror.some(m => m.state === 1 && m.faction === home.faction)) continue;
    const free = freeSitesOf(pv);
    if (free.length) { target = free[0]; break; }
  }
  assert.ok(target, 'no outpost site');
  const anchor = town.holdings.find(x => x.order === 1), slot2 = town.holdings.find(x => x.order === 2) ?? anchor;
  const filed = await action('FileOutpost', { sites: [target], anchor_site_key: hostId({ p: anchor.p, q: anchor.q, site: anchor.site, gen: anchor.gen, seq: 0 }) }, { sites: [target], anchor, slot2 });
  assert.equal(filed.ok, true, `FileOutpost: ${json(filed)}`);
  const bF = bellAt(genesisTs, Number((await h.season()).record.latestUnix));
  step('outpost-filed', { target, bell: bF });
  await advanceTo(bF + 30);
  const settled = await eventually('the outpost is founded', async () => {
    const r = await h.me(wallet.address); if (!r.ok) return null;
    const pv = await province(target.p, target.q); if (pv && pv.resolvedNext + 1 < bF + 30) { await nudge(target.p, target.q, pv.resolvedNext).catch(() => {}); }
    return r.holdings.length >= 3 ? r : null;
  }, 300000);
  step('outpost-settled', { holdings: settled.holdings.map(x => ({ p: x.p, q: x.q, site: x.site, order: x.order, state: x.state })) });

  // The season's end.
  await advanceTo(endBell + 2);
  await eventually('the Season is Ended on chain', async () => { const a = await rpc('getAccountInfo', [pin.addresses.season, { encoding: 'base64' }]); return Buffer.from(a.value.data[0], 'base64')[64] === 4; }, 360000);
  await eventually('every province resolved to the end', async () => {
    for (const d of [2, 3, 4]) for (const at of ringProvinces(d)) { const pv = await province(at.p, at.q); if (!pv || pv.resolvedNext < endBell) { await nudge(at.p, at.q, pv?.resolvedNext ?? 0).catch(() => {}); return null; } }
    return true;
  }, 600000);
  step('season-ended', { endBell });
  report.ok = true;
}
try { await run(); } catch (e) { report.ok = false; report.error = String(e?.stack ?? e); console.error(report.error); process.exitCode = 1; }
finally {
  if (originalScale !== undefined) { await rpc('frontier_setScale', [originalScale]).catch(() => {}); }
  report.finishedAt = new Date().toISOString(); save();
  console.log(`report: ${path.join(outDir, 'drive.json')}`);
}
