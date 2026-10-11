import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHerald } from '../../permutation-server/web/frontier/herald.mjs';
import { setPin, setRelay, nudge, reveal } from '../../permutation-server/web/frontier/fchainio.mjs';
import { homeSites } from '../../permutation-server/web/frontier/home.mjs';
import { submit, track, accountsFor } from '../../permutation-server/web/frontier/fplay.mjs';
import { keyFromSeed } from '../../permutation-server/web/session.mjs';
import { devWallet, connect } from '../../permutation-server/web/wallet.mjs';
import { toHex } from '../../permutation-server/web/sdk/bytes.mjs';
import { bellAt, seasonClock } from '../../permutation-server/web/frontier/clock.mjs';
import { ringProvinces, wedgeOf } from '../../permutation-server/web/frontier/fgeo.mjs';
import { hostsIn } from '../../permutation-server/web/frontier/fland.mjs';
import { loadKernel } from '../../permutation-server/web/frontier/wasm.mjs';
import { planRoute, earliestBell, plaintextOf, tipOptions, freeTransitSlot } from '../../permutation-server/web/frontier/fmarch.mjs';
import { sealMarch } from '../../permutation-server/web/frontier/seal.mjs';

// Real two-wallet protocol regression. Uses the production browser modules,
// relay, on-chain program and keepers, with no browser automation or state edits.
// Run only on a disposable local CQ season, e.g. 72h end and genesis ring 4:
// CQ_SMOKE_URL=http://127.0.0.1:41740 CQ_SMOKE_RPC=http://127.0.0.1:41710 node permutation-gateway/scripts/conquest-smoke.mjs
// Test-clock acceleration is restored in finally. Wallet keys are ephemeral.
const base = process.env.CQ_SMOKE_URL ?? 'http://127.0.0.1:41740';
const rpcUrl = process.env.CQ_SMOKE_RPC ?? 'http://127.0.0.1:41710';
for (const u of [base, rpcUrl]) assert.ok(['127.0.0.1', 'localhost'].includes(new URL(u).hostname), 'local-only test');
const reportFile = new URL('../../.local/conquest-smoke.json', import.meta.url);
let report = { mode: 'real-localnet-two-wallets', base, startedAt: new Date().toISOString(), checks: [] };
const json = x => JSON.stringify(x, (_, v) => typeof v === 'bigint' ? String(v) : v, 2);
const save = () => { mkdirSync(new URL('.', reportFile), { recursive: true }); writeFileSync(reportFile, json(report) + '\n'); };
const check = (name, details = {}) => { report.checks.push({ name, ok: true, ...details }); console.log(name, json(details)); save(); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
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
let pin, kernel, originalScale;
async function action(name, player, fields, extra = {}, walletSigned = false) {
  const sent = await submit({ name, accounts: accountsFor(name, { ...player.context, ...extra }), fields, signer: walletSigned ? { wallet: player.wallet } : { session: player.session } });
  assert.equal(sent.ok, true, `${name} submit ${json(sent)}`);
  const landed = await track(sent.signature, { tries: 80, every: 500 });
  assert.equal(landed.ok, true, `${name} track ${json(landed)}`);
  check(name, { player: player.wallet.address, signature: sent.signature });
}
async function advanceTo(targetBell) {
  const current = await h.season(); const target = Number(current.season.genesisTs) + targetBell * 600 + 1;
  await rpc('frontier_setScale', [1000]);
  try { await eventually(`clock bell ${targetBell}`, async () => (await rpc('frontier_status')).unixTimestamp >= target, 240000); }
  finally { await rpc('frontier_setScale', [10]); }
  check('test-clock-advanced', { targetBell });
}
async function resident(home) {
  const [s, p] = await Promise.all([h.season(), h.province(home.p, home.q)]);
  if (!s.ok || !p.ok) return null;
  const bell = bellAt(Number(s.season.genesisTs), Number(s.record.latestUnix));
  if (p.province.resolvedNext + 1 < bell) { await nudge(home.p, home.q, p.province.resolvedNext); return null; }
  return { s, province: p.province, bell };
}
async function finish(faction, dest, season) {
  const captured = await eventually('keep captured after contest', async () => { const p = await h.province(dest.p, dest.q); return p.ok && p.province.keep.holder === faction && p.province.territoryBells[faction] > 0n ? p.province : null; }, 300000);
  assert.ok(captured.territoryBells[faction] > 0n);
  check('keep-captured-and-scores-accrue', { keep: captured.keep, territoryBells: captured.territoryBells, scoreNextBell: captured.scoreNextBell });
  const standings = await eventually('current national standings', async () => { const r = await h.standings(); return r.ok && r.standings.scoring === 'territory-time' && r.standings.factions.some(f => f.territoryBells > 0) ? r.standings : null; });
  check('national-standings', { standings });
  await advanceTo(season.endBell + 2);
  const final = await eventually('season result published', async () => { const r = await h.final(); return r.ok && r.final.standings?.scoring === 'territory-time' ? r.final : null; }, 360000);
  const control = await h.control(); assert.ok(control.ok); assert.equal(control.control.bell, season.endBell - 1);
  assert.equal(String(final.season), String(report.season));
  const latest = await h.season();
  const totals = [0n, 0n, 0n, 0n, 0n, 0n];
  for (const ring of latest.record.rings) for (const at of ringProvinces(ring.d)) {
    const p = await h.province(at.p, at.q); assert.ok(p.ok);
    assert.equal(p.province.scoreNextBell, season.endBell);
    p.province.territoryBells.forEach((v, i) => { totals[i] += v; });
  }
  assert.deepEqual(final.standings.factions.map(f => BigInt(f.territoryBells)), totals, 'final national score is the exact sum of authoritative province counters');
  check('final-season-result', { final, authoritativeTerritoryBells: totals });
}
async function run() {
  originalScale = (await rpc('frontier_status')).scale;
  const s = await eventually('CQ season and outer frontier ready', async () => { const r = await h.season(); return r.ok && r.record.rings?.length >= 5 ? r : null; });
  assert.equal(s.record.cluster, 'localnet'); assert.equal(s.season.programVersion, 3); assert.equal(s.season.layoutVersion, 2);
  pin = setPin({ programId: s.record.programId, cluster: s.record.cluster, seasonId: s.record.season, seasonAddress: s.record.seasonAddress, rulesetHash: toHex(s.season.rulesetHash) });
  h.pin(s.record.season, pin.addresses); setRelay(`${base}/gw`);
  if (process.env.CQ_SMOKE_FINISH === '1') {
    const previous = JSON.parse(readFileSync(reportFile, 'utf8'));
    assert.equal(String(previous.season), String(s.record.season), 'continuation stays on the same season');
    report = previous; delete report.error; delete report.ok;
    await rpc('frontier_setScale', [10]);
    await finish(report.players[0].home.faction, report.target, s.season);
    report.ok = true; return;
  }
  kernel = await loadKernel({ url: `${base}/frontier/frontier/wasm/frontier-v2.wasm`, ruleset: toHex(s.season.rulesetHash) });
  report.season = s.record.season; report.programId = s.record.programId; report.endBell = s.season.endBell;
  const seeds = s.record.rings.map(r => ({ ring: r.d, seed: r.seed }));
  const provinces = [];
  for (const at of ringProvinces(3)) { const r = await h.province(at.p, at.q); if (r.ok) provinces.push(r.province); }
  const targets = [];
  for (const at of ringProvinces(4)) { const r = await h.province(at.p, at.q); if (r.ok && r.province.keep?.tile < 61) targets.push(r.province); }
  assert.ok(targets.length, 'outer ring has keeps');
  const choices = [];
  for (const province of provinces) for (const home of homeSites(province, { ringsOpen: s.record.rings.length })) {
    for (const target of targets) {
      if (target.keep.holder === home.faction) continue;
      const dest = { p: target.p, q: target.q, tile: target.keep.tile };
      const p = planRoute(kernel, { from: home, to: dest, unit: 0, seeds });
      if (p.ok) choices.push({ home, dest, route: p.route });
    }
  }
  choices.sort((a, b) => a.route.secs - b.route.secs);
  assert.ok(choices.length, 'a legitimate path connects home to a frontier keep');
  const first = choices[0];
  const second = choices.find(x => x.home.faction !== first.home.faction);
  assert.ok(second, 'second independent nation can join');
  const players = [];
  for (const choice of [first, second]) {
    const key = await keyFromSeed(randomBytes(32)), session = await keyFromSeed(randomBytes(32));
    const wallet = await connect(devWallet(key), { chain: 'solana:localnet' });
    const player = { wallet, session, home: choice.home, context: { addresses: pin.addresses, wallet: wallet.address, actor: session.publicKey, faction: choice.home.faction, holding: choice.home, province: choice.home } };
    await action('Join', player, { faction: choice.home.faction, session: session.publicKeyBytes, session_expiry: BigInt(s.record.latestUnix) + 7n * 86400n }, {}, true);
    await action('PlaceHome', player, { p: choice.home.p, q: choice.home.q, site: choice.home.site });
    const me = await eventually('immediate final home', async () => { const r = await h.me(wallet.address); return r.ok && r.holdings[0]?.state === 2 ? r : null; });
    player.holding = me.holdings[0];
    check('immediate-home', { wallet: wallet.address, home: player.home, owner: toHex(player.holding.ownerCitizen) });
    await action('Build', player, { item: 0 }, { item: 0 });
    players.push(player);
  }
  assert.notEqual(players[0].wallet.address, players[1].wallet.address);
  assert.notEqual(players[0].home.faction, players[1].home.faction);
  report.players = players.map(p => ({ wallet: p.wallet.address, home: p.home })); report.target = first.dest; save();
  const foundedBell = Math.max(...players.map(p => bellAt(Number(s.season.genesisTs), Number(p.holding.finalTs))));
  const readyAt = Math.max(150, foundedBell + 150);
  await advanceTo(readyAt); // first-day shields expire; production legitimately accrues
  for (const player of players) {
    await action('Harvest', player, {});
    await eventually('home province current', () => resident(player.home));
    await action('Train', player, { unit: 0, n: 1000 });
    await action('Muster', player, { unit: 0, troops: 1000, tile: player.home.tile });
  }
  await advanceTo(readyAt + 4);
  const player = players[0];
  const ready = await eventually('muster resolved', async () => {
    const p = await resident(player.home); if (!p) return null;
    const host = hostsIn(p.province, player.holding, p.bell).find(x => x.state === 1 && x.unit === 0 && !x.pending && x.readyBell <= p.bell);
    return host ? { ...p, host } : null;
  });
  const now = await h.season();
  const arriveBell = Math.max(ready.bell + now.season.minLead, earliestBell(kernel, { genesisTs: Number(now.season.genesisTs), departTs: Number(now.record.latestUnix) + 90, secs: first.route.secs }));
  const plain = plaintextOf({ host: ready.host, arriveBell, dest: first.dest, route: first.route, stance: 1, retreat: { choice: 'never' } });
  const sealed = await sealMarch({ plain, clock: seasonClock(now.season), publicKey: now.record.drand.publicKey, hostId: ready.host.id, arriveBell }, { inline: true });
  assert.ok(sealed.ok, json(sealed));
  const me = await h.me(player.wallet.address); const transitSlot = freeTransitSlot(me.holdings[0]);
  await action('Depart', player, { host_id: ready.host.id, commit: sealed.commit, seal: sealed.seal, arrive_bell: arriveBell, tip: tipOptions(now.season)[0].lamports, transit_slot: transitSlot });
  const revealed = await reveal({ holding: pin.addresses.of('Holding', player.home), transit_slot: transitSlot, plain_b64: Buffer.from(plain).toString('base64'), salt_b64: Buffer.from(sealed.salt).toString('base64'), ct_hash_b64: Buffer.from(sealed.ctHash).toString('base64') });
  assert.ok(revealed.ok, json(revealed));
  check('march-sealed-and-reveal-saved', { hostId: String(ready.host.id), arriveBell, target: first.dest, routeSteps: first.route.dirs.length });
  await advanceTo(arriveBell + 3);
  const arrived = await eventually('host arrived at frontier keep', async () => {
    const p = await h.province(first.dest.p, first.dest.q); if (!p.ok) return null;
    return p.province.entries.find(x => x.id === ready.host.id && x.state === 1) ? p.province : null;
  });
  check('march-arrived', { keep: arrived.keep, host: String(ready.host.id) });
  await advanceTo(arriveBell + 80);
  await finish(player.home.faction, first.dest, now.season);
  report.ok = true;
}
try { await run(); } catch (e) { report.ok = false; report.error = String(e?.stack ?? e); console.error(report.error); process.exitCode = 1; }
finally {
  if (originalScale !== undefined) { await rpc('frontier_setScale', [originalScale]); report.restoredScale = originalScale; }
  report.finishedAt = new Date().toISOString(); save();
}
