// Signed browser protocol against the isolated local development server.
// No controller optimism, direct state injection, funded wallet, or chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../screens/server.mjs';
import * as W from '../screens/world.mjs';
import { kernel } from '../screens/kernel.mjs';
import { createHerald } from '../../permutation-server/web/frontier/herald.mjs';
import * as io from '../../permutation-server/web/frontier/fchainio.mjs';
import { submit, track, accountsFor } from '../../permutation-server/web/frontier/fplay.mjs';
import { keyFromSeed } from '../../permutation-server/web/session.mjs';
import { devWallet, connect, disconnect } from '../../permutation-server/web/wallet.mjs';
import { toHex, toBase64 } from '../../permutation-server/web/sdk/bytes.mjs';
import { homeSites } from '../../permutation-server/web/frontier/home.mjs';
import { ringProvinces, tileHex, wedgeOf } from '../../permutation-server/web/frontier/fgeo.mjs';
import { hostsIn } from '../../permutation-server/web/frontier/fland.mjs';
import { pack, encodePath, commit, ctHash } from '../../permutation-server/web/frontier/seal.mjs';

async function setup(faction) {
  const srv = await startServer(); srv.stage('none');
  const clock = { t: 1_700_000_000_000 };
  const world = srv.live(true, { opening: true, territory: true, paused: true, neighbours: false, landMs: 0, wall: () => clock.t });
  const h = createHerald({ base: srv.url }), s = await h.season();
  assert.ok(s.ok, s.error); assert.equal(s.season.programVersion, 2); assert.equal(s.season.layoutVersion, 1);
  const pin = io.setPin({ programId: s.record.programId, cluster: s.record.cluster, seasonId: s.record.season, seasonAddress: s.record.seasonAddress, rulesetHash: toHex(s.season.rulesetHash) });
  h.pin(s.record.season, pin.addresses); io.setRelay(`${srv.url}/gw`);
  const wallet = await connect(devWallet(await keyFromSeed(W.DEV_SEED)), { chain: 'solana:localnet' });
  // A newly derived session, deliberately different from the fixture's key.
  const session = await keyFromSeed(new Uint8Array(32).fill(0x50 + faction));
  let home;
  for (const p of ringProvinces(2).filter(p => wedgeOf(p.p, p.q) === faction)) {
    const pv = await h.province(p.p, p.q); if (!pv.ok) continue;
    home = homeSites(pv.province, { faction, nowBell: world.turn(), ringsOpen: 3 })[0]; if (home) break;
  }
  assert.ok(home, `free home for nation ${faction}`);
  const context = extra => ({ addresses: pin.addresses, wallet: wallet.address, actor: session.publicKey, faction, holding: home, province: home, ...extra });
  const send = (name, fields = {}, extra = {}, sign = null) => submit({ name, accounts: accountsFor(name, context(extra)), fields, signer: sign ?? (name === 'Join' || name === 'SetSession' ? { wallet } : { session }) });
  const action = async (...args) => { const r = await send(...args); assert.ok(r.ok, `${args[0]} ${JSON.stringify(r)}`); const done = await track(r.signature, { tries: 2, wait: async () => { clock.t += 1500; } }); assert.equal(done.state, 'landed'); return r; };
  const read = () => h.me(wallet.address);
  const join = () => action('Join', { faction, session: session.publicKeyBytes, session_expiry: BigInt(Math.floor(world.now()) + 86400) });
  const place = () => action('PlaceHome', { p: home.p, q: home.q, site: home.site });
  const close = async () => { await disconnect(); await srv.close(); };
  return { srv, world, h, s, pin, session, wallet, home, send, action, read, join, place, close, context };
}

for (let faction = 0; faction < 6; faction++) test(`signed opening preserves nation ${faction}, grants its free site, and a new reader recovers it`, async () => {
  const x = await setup(faction);
  try {
    await x.join(); const joined = await x.read();
    assert.equal(joined.citizen.faction, faction); assert.equal(toHex(joined.citizen.session), toHex(x.session.publicKeyBytes)); assert.equal(joined.holdings.length, 0);
    await x.place(); const me = await x.read(), home = me.holdings[0];
    assert.equal(home.state, 2); assert.equal(home.faction, faction); assert.deepEqual([home.p, home.q, home.site], [x.home.p, x.home.q, x.home.site]);
    assert.equal(me.citizen.holdingsN, 1); assert.ok(me.citizen.flags & 32); assert.ok(home.flags & 2); assert.equal(toHex(me.citizen.session), toHex(x.session.publicKeyBytes));
    const env = await x.h.province(home.p, home.q); assert.equal(env.sampleTerritory.owners[home.tile], faction);
    const fresh = createHerald({ base: x.srv.url }); fresh.pin(x.s.record.season, x.pin.addresses);
    const reloaded = await fresh.me(x.wallet.address);
    assert.deepEqual(reloaded.holdings, me.holdings, 'reloading reads server state');
    const second = await x.send('PlaceHome', { p: x.home.p, q: x.home.q, site: x.home.site });
    assert.equal(second.ok, false); assert.equal(second.code, 'HomeAlreadyGranted');
    assert.deepEqual((await x.read()).holdings, me.holdings, 'rejected grant cannot alter resources or home');
  } finally { await x.close(); }
});

test('wrong session signature, invalid site, and foreign nation sites are refused without mutating land', async () => {
  const x = await setup(4);
  try {
    await x.join(); const before = await x.read();
    const badSession = await keyFromSeed(new Uint8Array(32).fill(99));
    const wrong = await x.send('PlaceHome', x.home, { actor: badSession.publicKey }, { session: badSession });
    assert.equal(wrong.ok, false); assert.equal(wrong.code, 'BadSignature');
    const invalid = await x.send('PlaceHome', { ...x.home, site: 12 }, { holding: { ...x.home, site: 12 } });
    assert.equal(invalid.ok, false);
    const foreign = { p: 2, q: 0, site: 5 };
    const refused = await x.send('PlaceHome', foreign, { holding: foreign, province: foreign });
    assert.equal(refused.ok, false);
    assert.deepEqual((await x.read()).holdings, before.holdings);
    assert.deepEqual((await x.read()).citizen, before.citizen);
    await x.place();
  } finally { await x.close(); }
});

test('first production construction is sixty seconds once, debits its actual cost, then training and marching secures land', async () => {
  const x = await setup(3);
  try {
    await x.join(); await x.place();
    const initial = (await x.read()).holdings[0];
    await x.action('Build', { item: 0 }, { item: 0 });
    const first = (await x.read()).holdings[0], q1 = first.queue.find(q => q.kind);
    assert.equal(Number(q1.doneAt) - Number(first.lastOwnerAction), 60);
    assert.equal(first.flags & 2, 0);
    assert.equal(initial.stores[1].value - first.stores[1].value, 80_000n);
    assert.equal(initial.stores[2].value - first.stores[2].value, 40_000n);
    x.world.advance(); await x.action('Harvest');
    await x.action('Build', { item: 1 }, { item: 1 });
    const second = (await x.read()).holdings[0], q2 = second.queue.find(q => q.kind);
    assert.equal(Number(q2.doneAt) - Number(second.lastOwnerAction), 5400, 'second production building uses the regular duration');
    const beforeTrain = second.reserve[0];
    await x.action('Train', { unit: 0, n: 100 });
    const trained = (await x.read()).holdings[0]; assert.equal(trained.reserve[0], beforeTrain + 100);
    await x.action('Muster', { unit: 0, troops: 100, tile: trained.tile });
    const home = (await x.read()).holdings[0];
    let env, host;
    for (let i = 0; i < 4 && !host; i++) { x.world.advance(); env = await x.h.province(home.p, home.q); host = hostsIn(env.province, home, x.world.turn()).find(h => h.unit === 0 && h.state === 1); }
    assert.ok(host, 'trained military host became a resident');
    const candidates = Array.from({ length: 61 }, (_, i) => i).filter(t => ((env.province.passableMask >> BigInt(t)) & 1n) && !env.province.sites.includes(t) && t !== env.province.camp.tile);
    const routes = candidates.map(tile => ({ tile, r: kernel().call('plan_path', { start: tileHex(home.p, home.q, home.tile), dest: tileHex(home.p, home.q, tile), unit: 0, blocked: [], seeds: x.s.record.rings.map(r => ({ ring: r.d, seed: r.seed })) }) })).filter(x => x.r.ok).sort((a,b) => a.r.value.secs - b.r.value.secs);
    const dest = routes[0], arrive = x.world.turn() + 2;
    const path = encodePath(dest.r.value.dirs), plain = pack({ version: 1, hostId: host.id, arriveBell: arrive, destP: home.p, destQ: home.q, destTile: dest.tile, stance: 1, retreatBps: 0, pathLen: path.pathLen, path: path.path });
    const salt = new Uint8Array(32).fill(4), seal = Uint8Array.from({ length: 165 }, (_, i) => i ? 9 : 0x83);
    await x.action('Depart', { host_id: host.id, commit: commit(plain, salt), seal, arrive_bell: arrive, tip: W.MIN_TIP, transit_slot: 0 });
    assert.equal((await x.h.province(home.p, home.q)).sampleTerritory.owners[dest.tile], 255, 'departure is not a land grant');
    const revealed = await io.reveal({ holding: x.pin.addresses.of('Holding', home), transit_slot: 0, plain_b64: toBase64(plain), salt_b64: toBase64(salt), ct_hash_b64: toBase64(ctHash(seal)) });
    assert.ok(revealed.ok, JSON.stringify(revealed));
    while (x.world.turn() <= arrive + 1) x.world.advance();
    const after = await x.h.province(home.p, home.q), own = after.sampleTerritory;
    assert.equal(own.owners[dest.tile], 3);
    assert.ok(own.history.some(e => e.tile === dest.tile && e.hostId === String(host.id) && e.reason === 'arrival'));
    assert.ok((await x.read()).record.hosts.some(h => h.id === String(host.id) && h.tile === dest.tile && h.state === 1));
  } finally { await x.close(); }
});


test('wallet-authorized session replacement works before home placement and an expired session cannot place a home', async () => {
  const x = await setup(1);
  try {
    await x.action('Join', { faction: 1, session: x.session.publicKeyBytes, session_expiry: BigInt(Math.floor(x.world.now()) + 1) });
    x.world.advance();
    const expired = await x.send('PlaceHome', x.home);
    assert.equal(expired.ok, false); assert.equal(expired.code, 'SessionExpired');
    const replacement = await keyFromSeed(new Uint8Array(32).fill(83));
    await x.action('SetSession', { session: replacement.publicKeyBytes, expiry: BigInt(Math.floor(x.world.now()) + 86400) });
    assert.equal(toHex((await x.read()).citizen.session), toHex(replacement.publicKeyBytes));
    const stale = await x.send('PlaceHome', x.home);
    assert.equal(stale.ok, false); assert.equal(stale.code, 'BadSignature');
    await x.action('PlaceHome', x.home, { actor: replacement.publicKey }, { session: replacement });
    assert.equal((await x.read()).holdings.length, 1);
    const ev = await x.h.events(0); assert.ok(ev.ok, 'session replacement remains readable in the event feed');
  } finally { await x.close(); }
});
