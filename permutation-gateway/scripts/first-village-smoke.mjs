import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHerald } from '../../permutation-server/web/frontier/herald.mjs';
import { setPin, setRelay, nudge } from '../../permutation-server/web/frontier/fchainio.mjs';
import { planHomes } from '../../permutation-server/web/frontier/home.mjs';
import { submit, track, accountsFor } from '../../permutation-server/web/frontier/fplay.mjs';
import { keyFromSeed } from '../../permutation-server/web/session.mjs';
import { devWallet, connect } from '../../permutation-server/web/wallet.mjs';
import { toHex } from '../../permutation-server/web/sdk/bytes.mjs';
import { decodePage } from '../../permutation-server/web/frontier/flog.mjs';
import { bellAt, archivePartOf, seasonClock } from '../../permutation-server/web/frontier/clock.mjs';
import { regionOf } from '../../permutation-server/web/frontier/fgeo.mjs';
import { hostsIn, exploreTargets, ticketTimes } from '../../permutation-server/web/frontier/fland.mjs';
import { seedSourceOf } from '../../permutation-server/web/frontier/controller.mjs';

// Protocol integration only: the production page modules talk to the real
// isolated local stack. No browser automation, mocked chain, or user key.
// Run against a newly seeded local season (program version 2 or newer):
// FIRST_VILLAGE_URL=http://127.0.0.1:41640 node permutation-gateway/scripts/first-village-smoke.mjs
// Creates one temporary player and village; does not reuse or save wallet keys.
// Optional FIRST_VILLAGE_RPC + FIRST_VILLAGE_SCALE accelerate only this local
// test stack, restoring its original scale in finally (e.g. 10 for the first-turn test).
// FIRST_VILLAGE_RPC=http://127.0.0.1:41610 FIRST_VILLAGE_SCALE=10 node permutation-gateway/scripts/first-village-smoke.mjs
const base = (process.env.FIRST_VILLAGE_URL ?? 'http://127.0.0.1:41640').replace(/\/+$/, '');
const url = new URL(base);
assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname), 'integration smoke is local-only');
const reportFile = new URL('../../.local/first-village-smoke.json', import.meta.url);
const rpcUrl = process.env.FIRST_VILLAGE_RPC;
const turnWaitLimit = Math.ceil(1500000 / Number(process.env.FIRST_VILLAGE_SCALE || 1)) + 30000;
let originalScale = null;
async function rpc(method, params = []) {
  const url = new URL(rpcUrl);
  assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname), 'test clock control is local-only');
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  assert.ok(!j.error, JSON.stringify(j.error));
  return j.result;
}
const report = { startedAt: new Date().toISOString(), mode: 'real-localnet-protocol', base, checks: [] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const h = createHerald({ base });
const check = (name, details) => { report.checks.push({ name, ok: true, ...details }); console.log(name, JSON.stringify(details)); };
const json = v => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? String(x) : x, 2);
async function eventually(label, fn, limit = 90000) {
  const until = Date.now() + limit;
  let last;
  while (Date.now() < until) { last = await fn(); if (last) return last; await sleep(1000); }
  throw new Error(`${label}: timeout (${json(last)})`);
}
async function action(name, v, fields, signer) {
  const t0 = Date.now();
  const r = await submit({ name, accounts: accountsFor(name, v), fields, signer });
  assert.equal(r.ok, true, `${name} send ${json(r)}`);
  const landed = await track(r.signature, { tries: 60, every: 500 });
  assert.equal(landed.ok, true, `${name} land ${json(landed)}`);
  check(name, { signature: r.signature, slot: landed.slot, elapsedMs: Date.now() - t0 });
  return r;
}
try {
  if (process.env.FIRST_VILLAGE_SCALE) {
    assert.ok(rpcUrl, 'FIRST_VILLAGE_RPC is required for test clock control');
    const scale = Number(process.env.FIRST_VILLAGE_SCALE);
    assert.ok(scale > 0 && scale <= 100, 'test scale in (0, 100]');
    originalScale = (await rpc('frontier_status')).scale;
    await rpc('frontier_setScale', [scale]);
    report.testScale = scale;
  }
  const s = await eventually('new season available', async () => {
    const s = await h.season();
    return s.ok && s.record.rings?.length >= 3 ? s : null;
  }, 180000);
  assert.ok(s.season.programVersion >= 2, 'new program version');
  assert.equal(s.record.cluster, 'localnet', 'integration smoke must use a local test chain');
  const pin = setPin({ programId: s.record.programId, cluster: s.record.cluster, seasonId: s.record.season, seasonAddress: s.record.seasonAddress, rulesetHash: toHex(s.season.rulesetHash) });
  h.pin(s.record.season, pin.addresses);
  setRelay(`${base}/gw`);
  const plan = await eventually('three open starting candidates', async () => {
    const current = await h.season();
    if (!current.ok) return null;
    const overviews = new Map();
    for (const r of current.record.rings) { const ov = await h.overview(r.d); if (ov.ok) overviews.set(r.d, ov); }
    const p = await planHomes({ overviews, nowBell: bellAt(Number(current.season.genesisTs), Number(current.record.latestUnix)), ringsOpen: current.record.rings.length, seed: 'protocol-smoke', read: async (p, q) => { const r = await h.province(p, q); return r.ok ? r.province : null; } });
    return p.candidates.length === 3 ? p : null;
  });
  assert.equal(plan.error, null, json(plan));
  assert.equal(plan.candidates.length, 3, 'three real open candidates');
  const home = plan.candidates[0];
  check('three-starting-candidates', { candidates: plan.candidates, selected: home, programVersion: s.season.programVersion });
  const key = await keyFromSeed(randomBytes(32));
  const session = await keyFromSeed(randomBytes(32));
  const wallet = await connect(devWallet(key), { chain: 'solana:localnet' });
  report.wallet = wallet.address;
  report.home = home;
  const context = { addresses: pin.addresses, wallet: wallet.address, actor: session.publicKey, faction: home.faction, holding: home, province: home };
  await action('Join', context, { faction: home.faction, session: session.publicKeyBytes, session_expiry: BigInt(s.record.latestUnix) + 7n * 86400n }, { wallet });
  const initial = await eventually('citizen after Join', async () => { const r = await h.me(wallet.address); return r.ok && r.citizen ? r : null; });
  assert.equal(initial.holdings.length, 0);
  await action('PlaceHome', context, { p: home.p, q: home.q, site: home.site }, { session });
  const placed = await eventually('final home after PlaceHome', async () => { const r = await h.me(wallet.address); return r.ok && r.holdings.length ? r : null; });
  const holding = placed.holdings[0];
  assert.equal(holding.state, 2, 'immediate FINAL state');
  assert.equal(holding.p, home.p);
  assert.equal(holding.q, home.q);
  assert.equal(holding.site, home.site);
  assert.ok(holding.flags & 2, 'introductory building available');
  assert.ok(placed.citizen.flags & 32, 'first home already granted');
  check('holding-final-immediately', { state: holding.state, flags: holding.flags, finalTs: Number(holding.finalTs), noTicket: placed.citizen.ticketBell === 0xffffffff });
  const second = await submit({ name: 'PlaceHome', accounts: accountsFor('PlaceHome', context), fields: { p: home.p, q: home.q, site: home.site }, signer: { session } });
  assert.equal(second.ok, false, 'a second home grant is refused');
  assert.ok(['QuotaExceeded', 'AlreadyDone'].includes(second.code), `repeat grant refused for an expected reason: ${json(second)}`);
  check('repeat-grant-refused', { code: second.code });
  await action('Build', { ...context, item: 0 }, { item: 0 }, { session });
  const built = await eventually('build queue after Build', async () => { const r = await h.me(wallet.address); return r.ok && r.holdings[0]?.queue.some(q => Number(q.doneAt) > 0) ? r.holdings[0] : null; });
  const queued = built.queue.find(q => Number(q.doneAt) > 0);
  assert.equal(Number(queued.doneAt) - Number(built.lastOwnerAction), 60, 'first build lasts 60 game seconds');
  assert.equal(built.flags & 2, 0, 'first-build benefit consumed');
  const beforeRate = holding.stores[0].rate;
  check('first-build-sixty-seconds', { duration: Number(queued.doneAt) - Number(built.lastOwnerAction), doneAt: Number(queued.doneAt) });
  await eventually('construction time passes', async () => { const r = await h.season(); return r.ok && Number(r.record.latestUnix) >= Number(queued.doneAt) ? r : null; });
  await action('Harvest', context, {}, { session });
  const finished = await eventually('completed building affects income', async () => { const r = await h.me(wallet.address); return r.ok && r.holdings[0] && r.holdings[0].stores[0].rate > beforeRate ? r.holdings[0] : null; });
  assert.equal(finished.queue.filter(q => Number(q.doneAt) > 0).length, 0, 'queue empty after completion');
  check('completed-building-increases-income', { oldRate: String(beforeRate), newRate: String(finished.stores[0].rate) });
  await action('Train', context, { unit: 6, n: 100 }, { session });
  const trained = await eventually('100 scouts in reserve', async () => { const r = await h.me(wallet.address); return r.ok && r.holdings[0]?.reserve[6] === 100 ? r : null; });
  check('hundred-scouts-trained', { reserve: trained.holdings[0].reserve[6] });
  let lastNudgeBell = null;
  async function residentProvince() {
    const [current, pr] = await Promise.all([h.season(), h.province(home.p, home.q)]);
    if (!current.ok || !pr.ok) return null;
    const bell = bellAt(Number(current.season.genesisTs), Number(current.record.latestUnix));
    if (pr.province.resolvedNext + 1 < bell) {
      if (lastNudgeBell !== bell) { await nudge(home.p, home.q, pr.province.resolvedNext); lastNudgeBell = bell; }
      return null;
    }
    return { current, province: pr.province, bell };
  }
  await eventually('province ready for muster', residentProvince, turnWaitLimit);
  await action('Muster', context, { unit: 6, troops: 100, tile: home.tile }, { session });
  const readyStart = Date.now();
  const ready = await eventually('scout host joins after turn resolution', async () => {
    const pr = await residentProvince();
    if (!pr) return null;
    const host = hostsIn(pr.province, holding, pr.bell).find(x => x.unit === 6 && x.state === 1 && x.readyBell <= pr.bell && !x.pending);
    return host ? { ...pr, host } : null;
  }, turnWaitLimit);
  check('scouts-ready-after-resolution', { host: String(ready.host.id), readyBell: ready.host.readyBell, currentBell: ready.bell, elapsedMs: Date.now() - readyStart });
  const tiles = exploreTargets(ready.province, ready.host).slice(0, 2);
  assert.ok(tiles.length > 0, 'the home scout has an unexplored adjacent tile');
  await action('Explore', context, { host_id: ready.host.id, n: tiles.length, tiles: Uint8Array.of(tiles[0], tiles[1] ?? 0) }, { session });
  const exploring = await eventually('exploration pending', async () => { const r = await h.me(wallet.address); return r.ok && r.holdings[0]?.explore.state === 1 ? r : null; });
  const expedition = exploring.holdings[0].explore;
  const current = await h.season();
  const timing = ticketTimes(seasonClock(current.season), expedition.bell);
  check('exploration-scheduled', { tiles, bell: expedition.bell, resultAbout: timing.resultAbout, estimatedGameSeconds: timing.resultAbout - Number(current.record.latestUnix) });
  const resultStart = Date.now();
  let manuallySettled = false;
  const result = await eventually('exploration result settled', async () => {
    let me = await h.me(wallet.address);
    if (me.ok && me.holdings[0]?.explore.state === 0 && me.citizen.explores >= tiles.length) return me;
    const region = regionOf(expedition.p, expedition.q);
    const source = await h.bellRegion(expedition.bell, region);
    const src = source.ok ? seedSourceOf(source.record) : null;
    if (!src || manuallySettled) return null;
    const archive = pin.addresses.of('AnchorArchive', { region, part: archivePartOf(expedition.bell) });
    const settle = src.archived ? { seed: archive, anchor: archive } : { seed: pin.addresses.of('SeedCache', { bell: expedition.bell, region, nonce: src.nonce }), anchor: pin.addresses.of('BellAnchor', { bell: expedition.bell, region }) };
    const r = await submit({ name: 'SettleExplore', accounts: accountsFor('SettleExplore', { ...context, settle }), fields: {}, signer: null, requester: session, citizen: pin.addresses.of('Citizen', { wallet: wallet.address }) });
    if (!r.ok) { assert.ok(['AlreadyDone', 'SeedNotReady', 'NoAnchor'].includes(r.code), `SettleExplore ${json(r)}`); return null; }
    const landed = await track(r.signature, { tries: 60, every: 500 });
    assert.ok(landed.ok || landed.code === 'AlreadyDone', `SettleExplore land ${json(landed)}`);
    manuallySettled = landed.ok;
    return null;
  }, turnWaitLimit);
  assert.equal(Number(result.citizen.works) - Number(exploring.citizen.works), tiles.length * 4, 'first exploration earns guaranteed works per tile');
  assert.equal(result.holdings[0].explore.state, 0, 'exploration no longer pending');
  check('exploration-result-arrived', { elapsedMs: Date.now() - resultStart, worksEarned: Number(result.citizen.works) - Number(exploring.citizen.works), tiles: tiles.length, settledBy: manuallySettled ? 'player' : 'keeper' });
  const events = await h.events(Number(s.record.headSeq ?? 0));
  assert.equal(events.ok, true, json(events));
  const decoded = decodePage(events.events);
  assert.equal(decoded.bad, 0, 'new events decode');
  assert.ok(decoded.records.some(({ record: e }) => e.name === 'HOME_PLACED' && e.p === home.p && e.q === home.q && e.site === home.site), 'selected home appears in the authoritative event feed');
  assert.ok(decoded.records.some(({ record: e }) => e.name === 'EXPLORE_RESULT' && e.host_id === ready.host.id), 'exploration outcome appears in the authoritative event feed');
  check('new-events-decode', { count: decoded.records.length, includesSelectedHome: true });
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = String(error?.stack ?? error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  if (originalScale !== null) {
    try { await rpc('frontier_setScale', [originalScale]); report.restoredScale = originalScale; }
    catch (error) { report.clockRestoreError = String(error); report.ok = false; process.exitCode = 1; }
  }
  report.finishedAt = new Date().toISOString();
  mkdirSync(new URL('.', reportFile), { recursive: true });
  writeFileSync(reportFile, json(report) + '\n');
}
