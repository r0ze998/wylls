#!/usr/bin/env node
// The guided first minutes of the banner prototype (PROTOTYPE-SPEC section 8), played through HTTP alone against the
// fixture server's sample world started with `claims` (liveworld.mjs; the rule is a DESIGN, not in the program):
// the orders of the game go through the page's own send path (fplay.submit, the self-reveal), the orders of the
// prototype to POST /gw/f/proto/land, and everything that is asserted is read back from the records the world
// serves (/h/season, /h/province, /h/me, /h/events, /h/proto/standings, /h/proto/preview).
//
//   node screens/proto-playthrough.mjs                 on a clock the script moves (seconds; the same play, every record asserted)
//   node screens/proto-playthrough.mjs --real          on the wall clock, 20 s a turn: prints when each beat came (the pace)
//   node screens/proto-playthrough.mjs --real --turn 10
//   node screens/proto-playthrough.mjs --dump <dir>    also writes one example of every record and order it met, as JSON
//   node screens/proto-playthrough.mjs --threat pole   the other threat: the neighbours' host on the pole of a banner of the viewer's
//
// The play (a town, stage `holding`), each beat asserted from its record:
//   1   the village's land is a record (HEARTH), 7 tiles in the viewer's name
//   2   three hosts of 100 Spearmen are formed: two where the preview says a banner can rise, one at the village;
//       the raise is refused StandLonger with what is missing
//   3   the count is done about three turns later: the first banner, the second (two a province)
//   4   the third host marches into the next province, to a tile where the preview drew the tail of its route
//   5   a host is formed in the first banner's patch (to walk it)
//   6   the neighbours' host stands on a border tile next door to raise a banner of its own: one threat with a count
//   7   the answer: the town's host of 600 marches onto that tile (sealed)
//   8   the third host has arrived with its trail; it raises: the trail becomes land (a third banner)
//   9   the clash at the border tile is resolved: the tile is won, the count is gone; a fourth banner would cost Works
//   10  the new host walks the first banner: +2 Works; the score adds up
// With --threat pole: the town's host makes the march of 4 and raises (8), is dissolved, the neighbours' host comes to
// stand on the pole (the banner is contested: no strike), and a host of 800 trained and formed at home wins it back.
import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { startServer } from './server.mjs';
import * as W from './world.mjs';
import { kernel } from './kernel.mjs';
import * as io from '../../permutation-server/web/frontier/fchainio.mjs';
import * as fplay from '../../permutation-server/web/frontier/fplay.mjs';
import { createHerald } from '../../permutation-server/web/frontier/herald.mjs';
import { keyFromSeed } from '../../permutation-server/web/session.mjs';
import { toHex, toBase64 } from '../../permutation-server/web/sdk/bytes.mjs';
import { tileHex } from '../../permutation-server/web/frontier/fgeo.mjs';
import { pack, ctHash, commit as commitOf, encodePath } from '../../permutation-server/web/frontier/seal.mjs';
import * as C from './claims.mjs';

const RINGS = W.seasonRecord().rings.map(r => ({ ring: r.d, seed: r.seed }));

/** Play it. `{real, turn, threat, dump, say}`; returns what it measured: `{beats: [{what, at (wall s), turn}], records, problems}`. */
export async function play({ real = false, turn = 20, threat = 'auto', dump = null, say = () => {}, stage = 'holding' } = {}) {
  const srv = await startServer(), clock = { t: 1_700_000_000_000 }, t0 = real ? Date.now() : clock.t;
  srv.stage(stage);
  const world = srv.live(true, { claims: threat === 'auto' ? true : { threat }, turn, landMs: real ? 1_200 : 400, ...(real ? {} : { wall: () => clock.t }) });
  const relayWas = io.relay(), examples = {}, beats = [];
  const wall = () => ((real ? Date.now() : clock.t) - t0) / 1000;
  // (this device reveals its own sealed orders when their arrival turn has begun, as the page does: checked whenever time passes)
  const sealedOrders = [];
  const sleep = async ms => {
    if (real) await new Promise(r => setTimeout(r, ms)); else clock.t += ms;
    for (const x of sealedOrders.splice(0)) { if (world.turn() >= x.arrive) await x.reveal(); else sealedOrders.push(x); }
  };
  const keep = (name, x) => { examples[name] ??= x; return x; };
  const get = async path => (await fetch(`${srv.url}${path}`)).json();
  const beat = (what, extra = {}) => { const b = { what, at: Math.round(wall() * 10) / 10, turn: world.turn(), ...extra }; beats.push(b); say(`  ${String(b.at).padStart(6)} s  turn ${b.turn}  ${what}${Object.keys(extra).length ? '  ' + JSON.stringify(extra) : ''}`); return b; };
  try {
    io.setRelay(`${srv.url}/gw`);
    const h = createHerald({ base: srv.url }), s = await h.season();
    assert.ok(s.ok, `${s.code}`);
    const pin = io.setPin({ programId: s.record.programId, cluster: s.record.cluster, seasonId: s.record.season, seasonAddress: s.record.seasonAddress, rulesetHash: toHex(s.season.rulesetHash) });
    h.pin(s.record.season, pin.addresses);
    const session = await keyFromSeed(W.SESSION_SEED), wallet = srv.viewer.wallet;
    const v = extra => ({ addresses: pin.addresses, wallet, actor: session.publicKey, faction: 0, holding: { p: W.HOME.p, q: W.HOME.q, site: W.HOME.site }, ...extra });
    /** An order of the game, as the page sends it (signed by the session key, through the relay), tracked until it lands. */
    const send = async (name, fields = {}, extra = {}) => {
      const r = await fplay.submit({ name, accounts: fplay.accountsFor(name, v(extra)), fields, signer: { session } });
      if (r.ok) await fplay.track(r.signature, { wait: () => sleep(300) });
      return r;
    };
    /** An order of the prototype. */
    const land = async body => { const r = await (await fetch(`${srv.url}/gw/f/proto/land`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json(); keep(`order-${body.op}-${r.ok ? 'accepted' : `refused-${r.code}`}`, { request: body, answer: r }); return r; };
    const me = async () => (await get(`/h/me/${wallet}`)).proto.land;
    const prov = async (p, q) => (await get(`/h/province/${p},${q}/latest`)).proto.land;
    let cursor = 0;
    /** The prototype's records logged since the last call. */
    const logged = async () => { const out = []; for (;;) { const e = await get(`/h/events?after=${cursor}`); cursor = Number(e.next); for (const x of e.events) if (x.proto) { out.push(x); keep(`event-${x.op}${x.premise ? '-premise' : ''}${x.op === 'STRIKE' ? `-${x.reason}` : ''}`, x); } if (!e.full) return out; } };
    const until = async (what, test, { every = real ? 500 : 1_000, max = 900_000 } = {}) => { for (let waited = 0; ; waited += every) { const x = await test(); if (x) return x; assert.ok(waited < max, `waited too long for: ${what}`); await sleep(every); } };
    const check = async () => { const st = await get('/h/proto/standings'); assert.equal(st.check.sum, st.check.expected, 'the six totals add up to 61 a province a turn'); return st; };
    /** The program takes no order in a province for about the first minute of a turn (the turn before last is not resolved yet): wait for it. */
    const caughtUp = (p = W.HOME.p, q = W.HOME.q) => until(`province ${p},${q} has caught up`, async () => (await prov(p, q)).resolvedNext >= world.turn() - 1, { every: real ? 300 : 500 });
    /** A sealed march of `host` to `to`, sent as the page sends it; revealed by this device when its arrival turn begins. */
    const march = async (host, from, to, slot, { stance = 1, unit = 0 } = {}) => {
      await caughtUp(from.p, from.q);
      const plan = kernel().call('plan_path', { start: tileHex(from.p, from.q, from.tile), dest: tileHex(to.p, to.q, to.tile), unit, blocked: [], seeds: RINGS }).value;
      assert.ok(plan, 'the kernel finds the way');
      const path = encodePath(plan.dirs), salt = new Uint8Array(32).fill(7 + slot), seal = Uint8Array.from({ length: 165 }, (_, i) => (i === 0 ? 0x83 : (i * 5 + slot) & 0xff));
      for (let arrive = world.turn() + 2; arrive < world.turn() + 8; arrive++) {
        const plain = pack({ version: 1, hostId: BigInt(host), arriveBell: arrive, destP: to.p, destQ: to.q, destTile: to.tile, stance, retreatBps: 0, pathLen: path.pathLen, path: path.path });
        const r = await send('Depart', { host_id: BigInt(host), commit: commitOf(plain, salt), seal, arrive_bell: arrive, tip: 14_668n, transit_slot: slot }, { province: { p: from.p, q: from.q } });
        if (r.ok) { sealedOrders.push({ arrive, reveal: async () => { const x = await io.reveal({ holding: srv.viewer.holding, transit_slot: slot, plain_b64: toBase64(plain), salt_b64: toBase64(salt), ct_hash_b64: toBase64(ctHash(seal)) }); assert.ok(x.ok && x.accepted, 'the keeper takes the reveal'); } }); return { arrive, slot, steps: plan.dirs.length }; }
        assert.equal(r.code, 'ArrivalBell', `the march is refused only for a turn too early (${r.code}: ${r.error})`);
      }
      throw new Error('no arrival turn was accepted');
    };

    // ---- 1: the season says it is a prototype; the village's land is a record
    const season = keep('season', await get('/h/season')), claims = season.sample.proto.claims;
    assert.deepEqual([claims.rule, claims.label.ja, claims.label.en], ['standing-ground', '試作ルール：旗（設計のみ・プログラム未実装）', 'Prototype rule: banners (design only, not in the program)']);
    assert.ok(season.sample.simpler.some(x => x.startsWith('prototype rule "banners" (design only)')));
    beat('the page\'s first /h/season: the clock starts', { turnSecs: season.sample.turnSecs });
    const first = keep('me-first-frame', await get(`/h/me/${wallet}`)).proto.land;
    assert.deepEqual([first.tiles, first.villageTiles, first.bannersHeld, first.cap, first.perProvince, first.nextPrice], [7, 7, 0, 5, 2, 0], 'a town: seven tiles of village land, no banner yet, five allowed, two a province');
    const base = await logged();
    const hearth = base.find(x => x.op === 'HEARTH' && x.holder === first.holder);
    assert.deepEqual([hearth.tiles.length, hearth.nation, hearth.p, hearth.q], [7, 0, W.HOME.p, W.HOME.q], 'the village\'s land is a record');
    keep('province-home-first-frame', await get(`/h/province/${W.HOME.p},${W.HOME.q}/latest`));
    keep('standings-first-frame', await check());
    assert.equal(base.filter(x => x.op === 'RAISE' && x.premise).length, 3, 'each neighbour town holds one banner from the first frame');

    // ---- 2: form two hosts where a banner can rise
    await until('the first toll', () => world.turn() >= 43);
    await caughtUp();
    const all = keep('preview-form-all', await get(`/h/proto/preview?p=${W.HOME.p}&q=${W.HOME.q}&troops=100`));
    const spots = all.all.filter(x => x.ok).sort((a, b) => b.size - a.size || a.tile - b.tile);
    assert.ok(spots.length >= 2, 'the preview lights tiles where a banner can rise');
    const A = spots[0], B = spots.find(x => !x.tiles.some(t => A.tiles.includes(t)));
    assert.ok(B, 'a second spot whose patch shares no tile with the first');
    keep('preview-form-one', await get(`/h/proto/preview?p=${W.HOME.p}&q=${W.HOME.q}&tile=${A.tile}&troops=100`));
    keep('preview-form-refused', await get(`/h/proto/preview?p=${W.HOME.p}&q=${W.HOME.q}&tile=${all.all.find(x => !x.ok && x.code === 'NotSurveyed').tile}`));
    assert.ok((await send('Muster', { unit: 0, troops: 100, tile: A.tile })).ok, 'a host is formed on the first spot');
    assert.ok((await send('Muster', { unit: 0, troops: 100, tile: B.tile })).ok, 'and one on the second');
    assert.ok((await send('Muster', { unit: 0, troops: 100, tile: W.HOME.tile })).ok, 'and a third at the village, for the march');
    const formed = beat('hosts formed where the preview says a banner can rise', { tiles: [A.tile, B.tile], patches: [A.size, B.size] });
    const mine = await until('the hosts are listed', async () => { const m = await me(); return m.hosts.filter(x => [A.tile, B.tile].includes(x.tile) && x.unit === 0).length === 2 ? m : null; });
    const hostA = mine.hosts.find(x => x.tile === A.tile), hostB = mine.hosts.find(x => x.tile === B.tile);
    keep('me-host-waiting', await get(`/h/me/${wallet}`));
    assert.deepEqual([hostA.raise.ok, hostA.raise.code, hostA.raise.size], [false, 'StandLonger', A.size], 'the count: the host has to stand');
    const early = await land({ op: 'raise', host: hostA.host, province: [W.HOME.p, W.HOME.q], minTiles: 3, maxWorks: 0 });
    assert.deepEqual([early.ok, early.code, early.need.tolls >= 1, early.need.atTurn], [false, 'StandLonger', true, hostA.raise.atTurn], 'raising before the count is done is refused with what is missing');
    keep('province-home-rising', await get(`/h/province/${W.HOME.p},${W.HOME.q}/latest`));

    // ---- 3: the count is done: the first banner, the second
    await until('the count is done', async () => (await me()).hosts.find(x => x.host === hostA.host)?.raise.ok);
    keep('me-host-can-raise', await get(`/h/me/${wallet}`));
    const r1 = await land({ op: 'raise', host: hostA.host, province: [W.HOME.p, W.HOME.q], minTiles: A.size, maxWorks: 0 });
    assert.equal(r1.ok, true, `the first banner rises (${r1.code})`);
    beat('the first banner is raised', { sinceFormed: Math.round((wall() - formed.at) * 10) / 10, tiles: A.size });
    let ev = await logged();
    const raise1 = ev.find(x => x.op === 'RAISE');
    assert.deepEqual([raise1.pole, raise1.tiles.length, raise1.nation, raise1.holder, raise1.works, raise1.firm, raise1.trail], [A.tile, A.size, 0, first.holder, 0, true, []], 'the record the page floods the colour from');
    const tx = await until('the order has landed', async () => { const x = await get(`/gw/f/tx/${r1.track}`); return x.state === 'landed' ? x : null; }, { every: 200 });
    keep('order-track-landed', tx);
    let m1 = await me();
    assert.deepEqual([m1.tiles, m1.bannersHeld, m1.banners[0].tiles], [7 + A.size, 1, A.size], 'the plate counts up');
    const r2 = await land({ op: 'raise', host: hostB.host, province: [W.HOME.p, W.HOME.q], minTiles: 3, maxWorks: 0 });
    assert.equal(r2.ok, true, `the second banner rises (${r2.code})`);
    beat('the second banner is raised', { tiles: B.size });
    ev = await logged();
    m1 = await me();
    assert.deepEqual([m1.tiles, m1.bannersHeld], [7 + A.size + ev.find(x => x.op === 'RAISE').tiles.length, 2]);
    const third = await get(`/h/proto/preview?p=${W.HOME.p}&q=${W.HOME.q}&troops=100`);
    assert.ok(third.all.every(x => !x.ok) && third.all.some(x => x.code === 'PerProvince'), 'two banners a province: the next land is where you march');
    keep('preview-form-PerProvince', third.all.find(x => x.code === 'PerProvince'));
    const homeNow = keep('province-home-two-banners', await get(`/h/province/${W.HOME.p},${W.HOME.q}/latest`)).proto.land;
    assert.equal(homeNow.claim.filter(c => c >= 16 && c < 32).length, homeNow.banners.reduce((a, b) => a + b.tiles.length, 0), 'the claim map and the banners agree');
    await check();

    const big = (await me()).hosts.find(x => x.host === String(W.HOSTS.free));
    assert.ok(big, 'the town\'s standing host of 600');
    const hostC = (await me()).hosts.find(x => x.tile === W.HOME.tile && x.unit === 0 && x.host !== big.host);
    assert.ok(hostC, 'the third host of 100, formed at the village for the march');

    // ---- 4: a march into the next province: the preview says where it would bring land, with the tail of its route
    const marcher = threat === 'pole' ? big : hostC;
    await until('the host that will march stands', async () => (await me()).hosts.find(x => x.host === marcher.host)?.stands);
    const far = keep('preview-march-all', await get(`/h/proto/preview?host=${marcher.host}&p=1&q=1`));
    const row = C.BORDER_ROWS.find(r0 => r0.includes(35)), deep = t => Math.min(...row.map(x => C.steps(x, t))) >= 3;
    const spot = far.all.filter(x => x.ok && x.trail.length >= 1 && deep(x.tile)).sort((a, b) => b.size - a.size || b.trail.length - a.trail.length || a.tile - b.tile)[0];
    assert.ok(spot && spot.mode === 'march' && spot.waitTurns === 1, 'a spot three steps in, where the tail of the route comes with the banner; one turn of standing on home ground');
    keep('preview-march-one', await get(`/h/proto/preview?host=${marcher.host}&p=1&q=1&tile=${spot.tile}`));
    const outside = { p: 1, q: 1, tile: spot.tile };
    const mv = await march(marcher.host, { p: marcher.p, q: marcher.q, tile: marcher.tile }, outside, 0, { stance: 0 });
    beat('a march into the next province is sealed', { arrive: mv.arrive, tile: spot.tile, patch: spot.size, trail: spot.trail });

    // ---- 5 (begun now, used at the end): a host is formed beside the first banner, to walk it
    const passMask = BigInt((await h.province(W.HOME.p, W.HOME.q, 'latest')).province.passableMask);
    const bannerA = homeNow.banners.find(b => b.pole === A.tile), slotA = bannerA.slot, beside = bannerA.tiles.find(t => t !== A.tile && (passMask >> BigInt(t)) & 1n);
    assert.equal((await land({ op: 'tend', host: hostA.host, province: [W.HOME.p, W.HOME.q], slot: slotA })).code, 'NotArrivedSince', 'the host that raised it was there already: it cannot walk it');
    assert.ok((await send('Train', { unit: 0, n: 100 })).ok);
    assert.ok((await send('Muster', { unit: 0, troops: 100, tile: beside })).ok, 'a host is formed in the first banner\'s patch');
    beat('a host is formed beside the first banner, to walk it');

    let foe = null, answer = null, dial = null;
    if (threat !== 'pole') {
      // ---- 6: the threat: the neighbours' host stands next door to raise a banner of its own
      foe = await until('the neighbours\' host stands on our ground with its count running', async () => { const x = (await prov(1, 1)).rising.find(y => y.nation !== 0); return x ? { ...x, p: 1, q: 1 } : null; });
      keep('province-next-enemy-rising', await get(`/h/province/${foe.p},${foe.q}/latest`));
      dial = beat('the threat: a banner of another nation is about to rise next door', { province: [foe.p, foe.q], tile: foe.tile, sinceTurn: foe.sinceTurn, canRaiseAtTurn: foe.canRaiseAtTurn, tiles: foe.tiles });
      assert.deepEqual([foe.nation, foe.canRaiseAtTurn - foe.sinceTurn, foe.ready], [2, 12, false], 'twelve turns on ground of another nation\'s keep');
      const left = world.npcLog.find(x => x.proto === 'threat' && x.what === 'left');
      assert.ok(left && !('target' in left) && !('tile' in left), 'its march was sealed like any other: the script\'s own log names no destination either');
      // ---- 7: the answer: the town's host of 600 marches onto the tile
      const pre = keep('preview-march-onto-enemy', await get(`/h/proto/preview?host=${big.host}&p=${foe.p}&q=${foe.q}&tile=${foe.tile}`));
      assert.deepEqual([pre.ok, pre.code, pre.need.why], [false, 'NotOpen', 'enemy'], 'the preview says an enemy holds that tile');
      answer = await march(big.host, { p: big.p, q: big.q, tile: big.tile }, { p: foe.p, q: foe.q, tile: foe.tile }, 1);
      beat('the answer is sealed: a march onto the tile', { arrive: answer.arrive, steps: answer.steps });
    }

    // ---- 8: the host that marched has a trail; it raises: the trail becomes land
    const trailEv = await until('the march is settled and the trail is written', async () => (await logged()).find(x => x.op === 'TRAIL' && x.host === marcher.host));
    assert.deepEqual([trailEv.p, trailEv.q, trailEv.pole, trailEv.tiles.length <= 4, spot.trail.every(t => trailEv.tiles.includes(t))], [outside.p, outside.q, outside.tile, true, true], 'the trail: the host\'s own last steps in that province (four at most); the tail the preview drew is cut from it');
    beat('the march is settled: the host stands there with its trail', { trail: trailEv.tiles });
    const nextNow = keep('province-next-trail', await get(`/h/province/${outside.p},${outside.q}/latest`)).proto.land;
    assert.deepEqual(nextNow.trails.find(x => x.host === marcher.host)?.tiles, trailEv.tiles);
    const ready = await until('its count is done', async () => { const x = (await me()).hosts.find(y => y.host === marcher.host); return x?.raise?.ok ? x : null; });
    const r3 = await land({ op: 'raise', host: marcher.host, province: [outside.p, outside.q], minTiles: ready.raise.size, maxWorks: 0 });
    assert.equal(r3.ok, true, `the banner outside the home province rises (${r3.code})`);
    const raise3 = (await logged()).find(x => x.op === 'RAISE');
    assert.ok(raise3.trail.length >= 1 && raise3.trail.every(t => trailEv.tiles.includes(t)) && raise3.trail.every(t => raise3.tiles.includes(t)), 'the tail of the route is part of the land');
    assert.deepEqual([raise3.p, raise3.q, raise3.pole, raise3.firm, raise3.works, raise3.tiles.length], [outside.p, outside.q, outside.tile, true, 0, ready.raise.size], 'home ground in the viewer\'s own wedge: firm, free (a third banner), the patch the host\'s record promised');
    // (the preview drew the patch on the board as it stood when the march was sealed; an enemy host that has come to stand
    // within two steps of a tail tile since then stops the walk there, so the patch may be smaller than it was drawn)
    assert.ok(raise3.tiles.length <= spot.size && (raise3.tiles.length === spot.size || foe !== null), 'smaller than the preview drew only when an enemy host has come near the tail');
    beat('the banner outside the home province is raised: the trail became land', { sinceSealed: Math.round((wall() - beats.find(b => b.what.startsWith('a march into')).at) * 10) / 10, tiles: raise3.tiles.length, trail: raise3.trail, previewed: spot.size });
    const m3 = keep('me-three-banners', await get(`/h/me/${wallet}`)).proto.land;
    assert.deepEqual([m3.bannersHeld, m3.nextPrice], [3, 4], 'three banners; the fourth costs 4 Works');
    keep('province-next-after-raise', await get(`/h/province/${outside.p},${outside.q}/latest`));
    await check();

    if (threat !== 'pole') {
      // ---- 9: the clash at the tile: the neighbours' host is beaten, its count is gone
      const won = await until('the clash at the tile is resolved', async () => { const x = await prov(foe.p, foe.q); return x.resolvedNext > answer.arrive ? x : null; });
      assert.equal(won.rising.find(y => y.host === foe.host), undefined, 'the neighbours\' host no longer stands there: its count is gone');
      assert.ok(answer.arrive < foe.canRaiseAtTurn, 'the answer came before the count was done');
      beat('the clash is resolved: the tile is won', { sinceDial: Math.round((wall() - dial.at) * 10) / 10, dialWouldEndTurn: foe.canRaiseAtTurn });
      keep('clash-report', await get(`/h/clash/${foe.p},${foe.q}/${answer.arrive}`));
      // the host that won stands on the tile it marched to; a fourth banner costs 4 Works (the town cleared a camp before the world began: 10)
      const stood = await until('the host that won may raise', async () => { const x = (await me()).hosts.find(y => y.host === big.host && y.p === foe.p && y.q === foe.q); return x?.raise?.ok ? x : null; });
      const purse = (await me()).works;
      assert.deepEqual([stood.tile, stood.raise.price, purse >= 4], [foe.tile, 4, true], 'the fourth banner costs 4 Works');
      const r5 = await land({ op: 'raise', host: big.host, province: [foe.p, foe.q], minTiles: 3, maxWorks: 4 });
      assert.equal(r5.ok, true, `a banner rises where the enemy's would have (${r5.code})`);
      const raise5 = (await logged()).find(x => x.op === 'RAISE');
      const m5 = keep('me-four-banners', await get(`/h/me/${wallet}`)).proto.land;
      assert.deepEqual([raise5.works, raise5.pole, m5.works, m5.worksSpent, m5.bannersHeld, m5.nextPrice], [4, foe.tile, purse - 4, 4, 4, 8], 'paid from the prototype\'s purse; the fifth costs 8');
      beat('a banner is raised on the tile that was won', { tiles: raise5.tiles.length, works: 4 });
      const dear = await land({ op: 'raise', host: big.host, province: [foe.p, foe.q] });
      assert.equal(dear.code, 'NotOpen', 'a second banner cannot rise on banner land');
    } else {
      // ---- (--threat pole) the pole is left: the neighbours' host comes to stand on it
      await caughtUp(outside.p, outside.q);
      assert.ok((await send('Dissolve', { host_id: BigInt(big.host) }, { province: { p: outside.p, q: outside.q } })).ok, 'the host is sent home');
      beat('the host on the pole is dissolved');
      const con = await until('the neighbours\' host stands on the pole', async () => (await prov(outside.p, outside.q)).banners.find(b => b.holder === first.holder)?.contested, { max: 2_400_000 });
      keep('province-next-contested', await get(`/h/province/${outside.p},${outside.q}/latest`));
      dial = beat('the threat: an enemy host stands on the pole of the banner', con);
      assert.deepEqual([con.nation, con.canTakeAtTurn - con.sinceTurn, con.hasFloor], [2, con.tolls, true]);
      assert.ok([36, 72].includes(con.tolls), 'a firm banner falls in 72 turns, a border banner in 36 to the neighbour it faces');
      const slot = m3.banners.find(b => b.p === outside.p && b.q === outside.q).slot;
      assert.equal((await land({ op: 'strike', province: [outside.p, outside.q], slot, reason: 'own' })).code, 'Contested', 'while an enemy stands there the banner cannot be struck');
      // the answer: train, form a host at home, march it onto the pole
      await caughtUp();
      assert.ok((await send('Train', { unit: 0, n: 800 })).ok);
      assert.ok((await send('Muster', { unit: 0, troops: 800, tile: W.HOME.tile })).ok);
      const relief = await until('the relief stands', async () => (await me()).hosts.find(x => x.tile === W.HOME.tile && x.unit === 0 && x.stands && x.host !== big.host && x.host !== hostC.host));
      const back = await march(relief.host, { p: relief.p, q: relief.q, tile: relief.tile }, outside, 1);
      beat('the answer is sealed: a march onto the pole', { arrive: back.arrive });
      await until('the pole is won back', async () => { const x = await prov(outside.p, outside.q); return x.resolvedNext > back.arrive && !x.banners.find(b => b.holder === first.holder)?.contested; });
      beat('the clash is resolved: the pole is won back', { sinceDial: Math.round((wall() - dial.at) * 10) / 10 });
    }

    // ---- 10: walking a banner: the host newly formed in its patch
    const walker = await until('the new host may walk the banner', async () => { const x = (await me()).hosts.find(y => y.tile === beside && y.host !== hostA.host); return x?.tend.find(t => t.slot === slotA)?.ok ? x : null; });
    keep('me-host-can-tend', await get(`/h/me/${wallet}`));
    assert.equal(walker.tend.find(t => t.slot === slotA).paysToday, true);
    const worksBefore = (await me()).works;
    const r4 = await land({ op: 'tend', host: walker.host, province: [W.HOME.p, W.HOME.q], slot: slotA });
    assert.equal(r4.ok, true, `the banner is walked (${r4.code})`);
    ev = (await logged()).filter(x => x.op === 'TEND' || x.op === 'WALK');
    assert.deepEqual(ev.map(x => [x.op, x.slot, x.works]), [['TEND', slotA, 0], ['WALK', slotA, 2]], 'the walk and the day\'s first pay');
    const m4 = keep('me-after-walk', await get(`/h/me/${wallet}`)).proto.land;
    assert.deepEqual([m4.works - worksBefore, m4.walkPaidToday], [2, true]);
    beat('the first banner is walked: +2 Works');
    assert.equal((await land({ op: 'tend', host: walker.host, province: [W.HOME.p, W.HOME.q], slot: slotA })).code, 'NotArrivedSince', 'the same host cannot walk it twice');

    // ---- the score: six nations by share of all tile-turns, the viewer's own line, the note
    const st = keep('standings', await check());
    assert.ok(st.nations.length === 6 && Math.abs(st.nations.reduce((a, x) => a + x.share, 0) - 1) < 1e-9 && st.note.ja.includes('試作') && st.check.sum > 0);
    assert.ok(m4.ledger > 0 && m4.shareOfNation > 0 && m4.shareOfNation < 1 && m4.perTurn === m4.paidTiles);
    beat('the end of the guided minutes', { tiles: m4.tiles, banners: m4.bannersHeld, share: Math.round(st.nations[0].share * 1000) / 10 });
    keep('events-page', await get('/h/events?after=0'));
    const refused = world.orders.filter(o => !o.ok).map(o => `${o.name} ${o.code}`);
    if (dump) { mkdirSync(dump, { recursive: true }); for (const [name, x] of Object.entries(examples)) writeFileSync(`${dump}/${name}.json`, JSON.stringify(x, null, 1)); }
    return { beats, examples, refused, turnSecs: turn, orders: world.orders.length };
  } finally {
    io.setRelay(relayWas);
    await srv.close();
  }
}
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const { values: opt } = parseArgs({ options: { real: { type: 'boolean', default: false }, turn: { type: 'string', default: '20' }, threat: { type: 'string', default: 'auto' }, dump: { type: 'string' } } });
  console.log(`the banner prototype's guided minutes, through HTTP (${opt.real ? `the wall clock, ${opt.turn} s a turn` : 'a clock the script moves'}; threat: ${opt.threat})`);
  const r = await play({ real: opt.real, turn: Number(opt.turn), threat: opt.threat, dump: opt.dump ?? null, say: console.log });
  console.log(`every record asserted; ${r.orders} orders answered; refused on purpose: ${r.refused.join(', ')}`);
  if (opt.dump) console.log(`records written to ${opt.dump}`);
}
