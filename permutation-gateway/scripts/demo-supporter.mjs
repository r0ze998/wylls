// A second person in a LIVE local conquest world (test tokens only): the
// "supporter". Through the real browser modules, relay and herald, in real
// time (the clock is never touched; it only waits and polls):
//
//   1. a wallet and a session key from a random seed kept in <out>/keys.json (mode 600): a re-run with the same
//      directory resumes the same person instead of joining twice;
//   2. test USDC from the faucet, the paid Join over x402 in the attacker's nation, a home with a legal route to the keep;
//   3. Build one producer, Train spearmen from the starting stores, Muster one host;
//   4. a sealed march to the keep tile, arriving at DEMO_SUP_ARRIVE_TURN or later, never retreating; the reveal is saved;
//   5. the transit outcome after arrival (expected: the host stays on the keep tile as a same-nation reinforcement);
//   6. <out>/transcript.json.
//
//   DEMO_SUP_URL=http://127.0.0.1:41940 DEMO_SUP_RPC=http://127.0.0.1:41910 DEMO_SUP_RUN=season3 \
//   node permutation-gateway/scripts/demo-supporter.mjs
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHerald } from '../../permutation-server/web/frontier/herald.mjs';
import { setPin, setRelay, nudge, reveal } from '../../permutation-server/web/frontier/fchainio.mjs';
import { homeSites } from '../../permutation-server/web/frontier/home.mjs';
import { submit, track, accountsFor } from '../../permutation-server/web/frontier/fplay.mjs';
import { keyFromSeed } from '../../permutation-server/web/session.mjs';
import { devWallet, connect } from '../../permutation-server/web/wallet.mjs';
import { toHex } from '../../permutation-server/web/sdk/bytes.mjs';
import { bellAt, seasonClock } from '../../permutation-server/web/frontier/clock.mjs';
import { ringProvinces } from '../../permutation-server/web/frontier/fgeo.mjs';
import { hostsIn, trainingQuote } from '../../permutation-server/web/frontier/fland.mjs';
import { loadKernel } from '../../permutation-server/web/frontier/wasm.mjs';
import { planRoute, earliestBell, plaintextOf, tipOptions, freeTransitSlot, hostInTransit } from '../../permutation-server/web/frontier/fmarch.mjs';
import { TRANSIT_OUTCOMES } from '../../permutation-server/web/frontier/flog.mjs';
import { sealMarch } from '../../permutation-server/web/frontier/seal.mjs';
import { joinViaX402 } from '../client/src/frontier/prize.mjs';
import { recordsOf } from '../src/frontier/achievements.mjs';

const env = (k, d) => process.env[k] ?? d;
const base = env('DEMO_SUP_URL', 'http://127.0.0.1:41940');
const rpcUrl = env('DEMO_SUP_RPC', 'http://127.0.0.1:41910');
for (const u of [base, rpcUrl]) assert.ok(['127.0.0.1', 'localhost'].includes(new URL(u).hostname), 'loopback only');
const run = env('DEMO_SUP_RUN', 'season3');
const NATION = Number(env('DEMO_SUP_NATION', '0'));
const [KP, KQ] = env('DEMO_SUP_KEEP', '4,-1').split(',').map(Number);
const ARRIVE_NOT_BEFORE = Number(env('DEMO_SUP_ARRIVE_TURN', '13'));
const WANT_TROOPS = Number(env('DEMO_SUP_TROOPS', '500'));
const PREFER = [[2, 0], [1, 1], [2, 1], [3, 0], [3, 1], [1, 2], [4, 0], [2, 2]];
const POLL = 3000;
const outDir = path.resolve(env('DEMO_SUP_OUT', fileURLToPath(new URL(`../../.local/demo-supporter/${run}`, import.meta.url))));
mkdirSync(outDir, { recursive: true });
const gw = `${base}/gw`;
const json = x => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? toHex(v) : v), 2);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const transcriptFile = path.join(outDir, 'transcript.json');
const keysFile = path.join(outDir, 'keys.json');
let report = existsSync(transcriptFile) ? JSON.parse(readFileSync(transcriptFile, 'utf8')) : {};
report = { mode: 'demo-supporter-live-world', testAssetsOnly: true, token: 'test USDC (local test mint, no value)', run, base, rpcUrl, transactions: [], notes: [], ...report, resumedAt: report.startedAt ? new Date().toISOString() : undefined, startedAt: report.startedAt ?? new Date().toISOString() };
delete report.error; delete report.ok;
const save = () => writeFileSync(transcriptFile, `${json(report)}\n`);
const say = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const note = text => { report.notes.push(text); say('note:', text); save(); };
const sent = kind => report.transactions.find(t => t.kind === kind);

async function rpc(method, params = []) {
  const r = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json(); assert.ok(!j.error, json(j.error)); return j.result;
}
async function eventually(label, fn, ms = 300000) {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) { try { last = await fn(); } catch (e) { last = null; say(`${label}: ${String(e.message ?? e).slice(0, 160)}`); } if (last) return last; await sleep(POLL); }
  throw new Error(`${label}: timeout`);
}
const api = async (p, body) => { const r = await fetch(gw + p, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const poolNow = async wallet => (await api(`/f/prize${wallet ? `?wallet=${wallet}` : ''}`)).body;
const poolView = p => ({ entries: p.entries, collected: p.collected, prize: p.prize, ops: p.ops, fee: p.fee, state: p.state });
const keepFile = async () => (await fetch(`${base}/h/keep/${KP},${KQ}.json`)).json();
const h = createHerald({ base });
let pin, kernel;
const turnNow = async () => { const r = await h.season(); assert.ok(r.ok, 'the herald has no season'); return { s: r, turn: bellAt(Number(r.season.genesisTs), Number(r.record.latestUnix)) }; };

async function action(kind, player, fields, extra = {}) {
  let out;
  for (let i = 0; i < 6; i++) {
    out = await submit({ name: kind, accounts: accountsFor(kind, { ...player.context, ...extra }), fields, signer: { session: player.session } });
    if (out.ok || !['network', 'Unavailable', 'HTTP502', 'HTTP504'].includes(out.code)) break;
    await sleep(5000);
  }
  assert.equal(out.ok, true, `${kind} was not accepted: ${json({ code: out.code, error: out.error, problems: out.problems })}`);
  const landed = await track(out.signature, { tries: 60, every: 1000 });
  assert.equal(landed.ok, true, `${kind} did not land: ${json(landed)}`);
  const { turn } = await turnNow();
  report.transactions.push({ kind, turn, signature: out.signature });
  say(`${kind} landed at turn ${turn}: ${out.signature}`); save();
  return out.signature;
}
/** The home province, current to this turn (a lagging province is nudged, as the page does). */
async function resident(home) {
  const [s, p] = await Promise.all([h.season(), h.province(home.p, home.q)]);
  if (!s.ok || !p.ok) return null;
  const turn = bellAt(Number(s.season.genesisTs), Number(s.record.latestUnix));
  if (p.province.resolvedNext + 1 < turn) { await nudge(home.p, home.q, p.province.resolvedNext); return null; }
  return { s, province: p.province, turn };
}
/** The host's settlement, from its Holding's transactions: `{signature, outcome, troops, turn}` or null. */
async function settlementOf(holdingAddress, hostId) {
  const sigs = await rpc('getSignaturesForAddress', [holdingAddress, { limit: 60 }]);
  for (const { signature, err } of sigs) {
    if (err) continue;
    const tx = await rpc('getTransaction', [signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
    const r = recordsOf(tx?.meta?.logMessages ?? []).find(x => x.name === 'TRANSIT_SETTLED' && BigInt(x.host_id) === BigInt(hostId));
    if (r) return { signature, outcomeCode: r.outcome, outcome: TRANSIT_OUTCOMES[r.outcome - 1] ?? TRANSIT_OUTCOMES[r.outcome] ?? String(r.outcome), troops: r.troops, turn: r.bell, sealCode: r.seal_code };
  }
  return null;
}

async function main() {
  const { s, turn: turn0 } = await turnNow();
  assert.equal(s.record.cluster, 'localnet');
  pin = setPin({ programId: s.record.programId, cluster: s.record.cluster, seasonId: s.record.season, seasonAddress: s.record.seasonAddress, rulesetHash: toHex(s.season.rulesetHash) });
  h.pin(s.record.season, pin.addresses); setRelay(gw);
  report.season = s.record.season; report.programId = s.record.programId; report.endTurn = s.season.endBell; save();
  say(`season ${s.record.season}, turn ${turn0} of ${s.season.endBell}`);
  kernel = await loadKernel({ url: `${base}/frontier/frontier/wasm/frontier-v2.wasm`, ruleset: toHex(s.season.rulesetHash) });
  const seeds = s.record.rings.map(r => ({ ring: r.d, seed: r.seed }));

  // 1. The person: one seed file per run directory.
  let keys;
  if (existsSync(keysFile)) keys = JSON.parse(readFileSync(keysFile, 'utf8'));
  else { keys = { note: 'local test keys of the demo supporter (test tokens only)', walletSeed: randomBytes(32).toString('hex'), sessionSeed: randomBytes(32).toString('hex') }; writeFileSync(keysFile, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 }); }
  chmodSync(keysFile, 0o600);
  const key = await keyFromSeed(Buffer.from(keys.walletSeed, 'hex')), session = await keyFromSeed(Buffer.from(keys.sessionSeed, 'hex'));
  const wallet = await connect(devWallet(key), { chain: 'solana:localnet' });
  report.wallet = wallet.address; report.session = session.publicKey; save();
  say(`wallet ${wallet.address}`);

  // The keep and its tile, from the live world.
  const kp = await eventually('the keep province', async () => { const r = await h.province(KP, KQ); return r.ok && r.province.keep ? r.province : null; });
  const dest = { p: KP, q: KQ, tile: kp.keep.tile };
  const file0 = await keepFile();
  if (file0.tile !== dest.tile) note(`the keep file names tile ${file0.tile}, the province account tile ${dest.tile}; the account's is used`);
  report.target = { ...dest, holderAtStart: kp.keep.holder, guardAtStart: kp.keep.troops };
  say(`keep (${KP},${KQ}) tile ${dest.tile}, holder nation ${kp.keep.holder}, guard ${kp.keep.troops}`);

  // 2. Join (once), then the home.
  let me = await h.me(wallet.address);
  if (!(me.ok && me.citizen)) {
    const faucet = await api('/f/faucet', { wallet: wallet.address });
    assert.equal(faucet.status, 200, `faucet: ${json(faucet)}`);
    const before = (await poolNow(wallet.address)).wallet;
    const joined = await joinViaX402(gw, { wallet: wallet.address, sign: m => key.sign(m), faction: NATION, session: session.publicKeyBytes, sessionExpiry: BigInt(s.record.latestUnix) + 7n * 86400n, maxFee: 25_000_000n });
    const after = await poolNow(wallet.address);
    const { turn } = await turnNow();
    report.transactions.push({ kind: 'Faucet', turn, signature: faucet.body.signature ?? null });
    report.transactions.push({ kind: 'Pay+Join (x402)', turn, signature: joined.signature });
    report.join = { nation: NATION, testUsdcBefore: before?.balance ?? null, testUsdcAfter: after.wallet?.balance ?? null, paymentResponse: joined.paymentResponse, pool: poolView(after) };
    report.poolAfterJoin = after;
    say(`joined nation ${NATION} at turn ${turn}: ${joined.signature}; test USDC ${before?.balance} -> ${after.wallet?.balance}; pool entries ${after.entries}, prize ${after.prize}, operator ${after.ops}`);
    save();
    me = await eventually('the herald shows the new citizen', async () => { const r = await h.me(wallet.address); return r.ok && r.citizen ? r : null; }, 120000);
  } else say('this wallet is already a citizen: resuming');
  assert.equal(me.citizen.faction, NATION, 'the citizen is of another nation');
  report.citizenTag = String(me.citizen.citizenTag ?? me.citizen.tag ?? '');
  if (!report.poolAfterJoin) report.poolAfterJoin = await poolNow(wallet.address);
  save();
  say(`citizen tag ${report.citizenTag}`);

  let home, route;
  if (me.holdings[0]) {
    const hd = me.holdings[0];
    home = { p: hd.p, q: hd.q, site: hd.site, tile: hd.tile, faction: hd.faction, gen: hd.gen };
    const r = planRoute(kernel, { from: home, to: dest, unit: 0, seeds });
    assert.ok(r.ok, `the existing home has no route to the keep: ${json(r)}`);
    route = r.route;
  } else {
    const order = [...PREFER.map(([p, q]) => ({ p, q })), ...[2, 3, 4].flatMap(d => ringProvinces(d)).filter(at => !PREFER.some(([p, q]) => p === at.p && q === at.q))];
    const pick = await eventually('a home site of the nation with a route to the keep', async () => {
      for (const at of order) {
        const r = await h.province(at.p, at.q); if (!r.ok) continue;
        let best = null;
        for (const site of homeSites(r.province, { ringsOpen: s.record.rings.length })) {
          if (site.faction !== NATION) continue;
          const pr = planRoute(kernel, { from: site, to: dest, unit: 0, seeds });
          if (pr.ok && (!best || pr.route.secs < best.route.secs)) best = { home: site, route: pr.route };
        }
        if (best) return best;
      }
      return null;
    }, 120000);
    home = pick.home; route = pick.route;
  }
  report.home = { p: home.p, q: home.q, site: home.site, tile: home.tile, nation: home.faction }; report.route = { steps: route.dirs.length, secs: route.secs, provinces: route.provinces }; save();
  say(`home (${home.p},${home.q}) site ${home.site} tile ${home.tile}; route to the keep: ${route.dirs.length} steps, ${route.secs} s of game time`);
  const player = { wallet, session, home, context: { addresses: pin.addresses, wallet: wallet.address, actor: session.publicKey, faction: NATION, holding: home, province: home } };
  if (!me.holdings[0]) await action('PlaceHome', player, { p: home.p, q: home.q, site: home.site });
  me = await eventually('the home is final', async () => { const r = await h.me(wallet.address); return r.ok && r.holdings[0]?.state === 2 ? r : null; }, 180000);
  let holding = me.holdings[0];
  const holdingAddress = pin.addresses.of('Holding', home);
  report.holding = holdingAddress; save();

  // 3. Build, Train, Muster: one host.
  const hostNow = async () => { const p = await resident(home); if (!p) return null; const m = await h.me(wallet.address); if (!m.ok) return null; holding = m.holdings[0]; return { ...p, hosts: hostsIn(p.province, holding, p.turn) }; };
  let state = await eventually('the home province is current', hostNow);
  let host = state.hosts.find(x => x.unit === 0) ?? null;
  const marching = () => holding.transit.find(t => t.state >= 1 && t.state <= 3) ?? null;
  if (!host && !marching() && !sent('Depart')) {
    if (!sent('Build') && !holding.queue.some(x => Number(x.doneAt) > 0)) await action('Build', player, { item: 0 }, { item: 0 });
    let reserve = Number(holding.reserve[0] ?? 0);
    if (!sent('Train') && reserve < 100) {
      const fresh = await eventually('the holding after Build', async () => { const r = await h.me(wallet.address); return r.ok && r.holdings[0] ? r : null; });
      holding = fresh.holdings[0];
      const now = Number((await h.season()).record.latestUnix);
      const quote = trainingQuote(holding, 0, WANT_TROOPS, now, s.season.programVersion);
      const n = Math.min(WANT_TROOPS, quote.max);
      report.training = { wanted: WANT_TROOPS, affordable: quote.max, trained: n, stores: quote.stores, cost: quote.cost };
      assert.ok(n >= 100, `the starting stores allow ${quote.max} spearmen: fewer than the 100 a host needs`);
      if (n < WANT_TROOPS) note(`the stores allow ${n} spearmen, not ${WANT_TROOPS}`);
      await action('Train', player, { unit: 0, n });
      reserve = n;
    } else if (reserve < 100) reserve = report.training?.trained ?? reserve;
    if (!sent('Muster')) {
      const r = await eventually('the trained spearmen are in the reserve', async () => { const m = await h.me(wallet.address); return m.ok && Number(m.holdings[0]?.reserve[0] ?? 0) >= 100 ? m.holdings[0] : null; }, 120000);
      const troops = Math.min(WANT_TROOPS, Number(r.reserve[0]));
      await eventually('the home province is current', () => resident(home));
      await action('Muster', player, { unit: 0, troops, tile: home.tile });
      report.mustered = troops; save();
    }
  }
  let arriveTurn, hostId;
  const inFlight = marching();
  if (inFlight || sent('Depart')) {
    hostId = BigInt(inFlight?.hostId ?? report.host.id); arriveTurn = inFlight?.arriveBell ?? report.march.arriveTurn;
    say(`the host ${hostId} is already on its way: arrival turn ${arriveTurn}`);
  } else {
    const ready = await eventually('the host is mustered and ready', async () => {
      const p = await hostNow(); if (!p) return null;
      const x = p.hosts.find(x => x.state === 1 && x.unit === 0 && !x.pending && x.readyBell <= p.turn);
      return x ? { ...p, host: x } : null;
    }, 600000);
    host = ready.host; hostId = BigInt(host.id);
    report.host = { id: String(host.id), troops: host.troops, readyTurn: host.readyBell, tile: host.tile }; save();
    say(`host ${host.id}: ${host.troops} spearmen, ready at turn ${ready.turn}`);

    // 4. The sealed march, arriving after the attacker.
    let now = await h.season(), turn = bellAt(Number(now.season.genesisTs), Number(now.record.latestUnix));
    const minLead = Number(now.season.minLead), maxLead = Number(now.season.maxLead);
    while (turn + maxLead < ARRIVE_NOT_BEFORE) { say(`turn ${turn}: turn ${ARRIVE_NOT_BEFORE} is beyond the latest arrival a march may name now (${turn + maxLead}); waiting`); await sleep(POLL * 4); now = await h.season(); turn = bellAt(Number(now.season.genesisTs), Number(now.record.latestUnix)); }
    const earliest = Math.max(turn + minLead, earliestBell(kernel, { genesisTs: Number(now.season.genesisTs), departTs: Number(now.record.latestUnix) + 150, secs: route.secs }));
    arriveTurn = Math.max(ARRIVE_NOT_BEFORE, earliest);
    if (earliest > ARRIVE_NOT_BEFORE) note(`started late: the earliest legal arrival is turn ${earliest}, later than turn ${ARRIVE_NOT_BEFORE}`);
    // Stance and retreat as prize-e2e's supporter: stance 1, never withdraw.
    const plain = plaintextOf({ host, arriveBell: arriveTurn, dest, route, stance: 1, retreat: { choice: 'never' } });
    const sealed = await sealMarch({ plain, clock: seasonClock(now.season), publicKey: now.record.drand.publicKey, hostId: host.id, arriveBell: arriveTurn }, { inline: true });
    assert.ok(sealed.ok, `seal: ${json(sealed)}`);
    const transitSlot = freeTransitSlot(holding);
    assert.ok(transitSlot !== null, 'the holding has no free transit record');
    const material = { holding: holdingAddress, transit_slot: transitSlot, plain_b64: Buffer.from(plain).toString('base64'), salt_b64: Buffer.from(sealed.salt).toString('base64'), ct_hash_b64: Buffer.from(sealed.ctHash).toString('base64') };
    report.march = { arriveTurn, departTurn: turn, stance: 1, retreat: 'never', target: dest, transitSlot, reveal: material }; save();
    await action('Depart', player, { host_id: host.id, commit: sealed.commit, seal: sealed.seal, arrive_bell: arriveTurn, tip: tipOptions(now.season)[0].lamports, transit_slot: transitSlot });
    const revealed = await reveal(material);
    report.march.revealSaved = revealed.ok === true; save();
    assert.ok(revealed.ok, `the reveal was not saved: ${json(revealed)}`);
    say(`sealed march departed at turn ${turn}: arrival turn ${arriveTurn} at (${KP},${KQ}) tile ${dest.tile}; reveal saved`);
  }

  // 5. Arrival and the outcome.
  await eventually(`turn ${arriveTurn}`, async () => { const { turn } = await turnNow(); if (turn < arriveTurn) { say(`turn ${turn}; the host arrives at turn ${arriveTurn}`); await sleep(POLL * 4); return null; } return true; }, 60 * 60000);
  const lastTurn = Math.min(arriveTurn + 8, Number(s.season.endBell));
  const settled = await eventually('the march is settled', async () => {
    const r = await settlementOf(holdingAddress, hostId); if (r) return r;
    const { turn } = await turnNow();
    if (turn > lastTurn) return { outcome: 'unsettled', turn };
    say(`turn ${turn}: waiting for the settlement of the march`); await sleep(POLL * 2); return null;
  }, 20 * 60000);
  const [keepProvince, homeProvince, meEnd, keepView] = [await h.province(KP, KQ), await h.province(home.p, home.q), await h.me(wallet.address), await keepFile()];
  const onKeep = keepProvince.ok ? keepProvince.province.entries.find(e => BigInt(e.id) === hostId) ?? null : null;
  const atHome = homeProvince.ok ? homeProvince.province.entries.find(e => BigInt(e.id) === hostId) ?? null : null;
  const { turn: endTurn } = await turnNow();
  if (settled.signature) report.transactions.push({ kind: `TransitSettled (${settled.outcome}; sent by a keeper)`, turn: settled.turn, signature: settled.signature });
  report.arrival = { arriveTurn, readAtTurn: endTurn, outcome: settled.outcome, outcomeCode: settled.outcomeCode ?? null, troopsAfter: settled.troops ?? null,
    hostOnKeepTile: !!onKeep && onKeep.state === 1 && onKeep.tile === dest.tile, hostEntryInKeepProvince: onKeep, hostEntryInHomeProvince: atHome,
    transit: meEnd.ok ? meEnd.holdings[0]?.transit.find(t => BigInt(t.hostId) === hostId) ?? null : null };
  report.keepAfterArrival = keepView;
  report.keepAccountAfterArrival = keepProvince.ok ? keepProvince.province.keep : null;
  say(`outcome: ${settled.outcome}${settled.troops !== undefined ? `, ${settled.troops} troops` : ''}; host on the keep tile: ${report.arrival.hostOnKeepTile}; keep holder nation ${keepView.holder}, guard ${keepView.troops}, contests ${json(keepView.contests)}`);
  report.ok = settled.outcome === 'Stays' && report.arrival.hostOnKeepTile;
  if (!report.ok) note(`the host did not stay on the keep tile: outcome ${settled.outcome}; nothing is retried`);
}
try { await main(); } catch (e) { report.ok = false; report.error = String(e?.stack ?? e); console.error(report.error); process.exitCode = 1; }
finally { report.finishedAt = new Date().toISOString(); save(); console.log(`transcript: ${transcriptFile}`); }
