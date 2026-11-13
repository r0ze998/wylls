// Page binding of the conquest world: from the launcher's start answer, through the REAL local-play gate
// (flocalplay.mjs, the launcher owner's, not edited here), onto the verified identity (`cfg.localPlay.conquestWorld`),
// into the page store as the controller puts it (`FS.localPlay`), to the siege offer and the prepared request
// (flocalplay-conquest.mjs). Nothing may be lost on the way, and a world of another start, Season or province may
// not be taken for this one.
//
// THIS FILE MAKES NO KEY and runs under the no-key guard. The gate's memory-only wallet is a stand-in with a public
// address and nothing else; the launcher, the herald and the relay are stubs; the observation is the repository's
// synthetic one. No page boot, network, chain, runner or world. The page conditions used to reach `prepared` are
// TEST-ONLY and say nothing about the real program: with the module's own conditions the route stays closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as LP from '../../permutation-server/web/frontier/flocalplay.mjs';
import * as LC from '../../permutation-server/web/frontier/flocalplay-conquest.mjs';
import * as hand from '../../permutation-server/web/frontier/hud/hand.mjs';
import { seasonAddresses, hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { decode as fromB58 } from '../../permutation-server/web/sdk/base58.mjs';
import { encodeAccount } from '../../permutation-server/web/sdk/frontier/codec.mjs';
import { decode } from '../../permutation-server/web/frontier/fcodec.mjs';
import { EXPEDITION_POP, clearInspection, inspectExpedition } from '../../permutation-server/web/frontier/fexpedition.mjs';
import { syntheticReturnInspection } from '../screens/codex/return-observation.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const SEASON_ID = '11', ADDRS = seasonAddresses(LP.LOCAL_PLAY_PROGRAM, SEASON_ID), OTHER = seasonAddresses(LP.LOCAL_PLAY_PROGRAM, '12');
const ME = 'BbPGAbHDvV5U43zQ5E8FmSnEzZ7r2vwWAZWTNAPTTSUT', HERALD = 'http://localhost:41926', RELAY = `${HERALD}/gw`;
const CFG = { origin: 'http://127.0.0.1:41920', herald: 'http://127.0.0.1:41920', relay: 'http://127.0.0.1:41920/gw', dev: true, mode: 'play' };
const LOC = (() => { const href = 'http://127.0.0.1:41920/frontier/frontier/index.html?localPlay=1&launcher=1&devWallet=off', u = new URL(href); return { href, hostname: u.hostname, origin: u.origin }; })();
const world = (over = {}) => ({ schema: 'frontier-local-play-conquest-world-v1', program: LP.LOCAL_PLAY_PROGRAM, season: ADDRS.season, world_preset: 'local-conquest-test-v1', free_city: { p: '129', q: '0', site: 3, tile: 43 }, ...over });
const settle = () => new Promise(r => setImmediate(r));

/** One start through the real gate: the launcher answers `conquestWorld` (or nothing), the herald shows this wallet's Season. → the gate's `cfg`. */
async function start(claimed) {
  const stand = { address: ME, destroyed: false, destroy() { stand.destroyed = true; }, announce() {} };
  const makeHerald = () => ({
    season: async () => ({ ok: true, record: { programId: LP.LOCAL_PLAY_PROGRAM, cluster: 'localnet', season: SEASON_ID, seasonAddress: ADDRS.season }, season: { programVersion: 0x4804, seasonId: 11n } }),
    me: async address => ({ ok: true, citizen: { wallet: fromB58(address) }, holdings: [{}] }), pin() {} });
  const request = async () => ({ ok: true, status: 200, json: async () => ({ herald: HERALD, ...(claimed === undefined ? {} : { conquestWorld: claimed }) }) });
  const gate = LP.openLocalPlayGate({ cfg: CFG, loc: LOC, doc: null, win: null, makeHerald, request, makeWallet: async () => stand, now: () => 1_800_000_000_000 });
  for (let i = 0; i < 500 && gate.state().phase === 'creating'; i++) await settle();
  await gate.connect();
  return { cfg: (await gate.ready).cfg, stand };
}
const acct = (kind, values) => decode(kind, encodeAccount(kind, { SEASON_ID: 11n, ...values }));
const SEASON = decode('Season', Buffer.from(JSON.parse(readFileSync(new URL('fixtures/frontier/season.json', import.meta.url), 'utf8')).bytes_b64, 'base64'));
/**
 * The page store as `startPlay` leaves it for this `cfg` (controller.mjs: `localPlay = cfg.localPlay ?? null;
 * FS.localPlay = localPlay;` — the SAME object, pinned by the last test), with the expedition card open on an original
 * host observed staying at (129, 0).
 */
async function page(cfg, standing = { p: '129', q: '0' }) {
  const HOST = hostId({ p: 2, q: 0, site: 3, gen: 1, seq: 0 }).toString(), OWNER = ADDRS.of('Citizen', { wallet: ME });
  const h = acct('Holding', { P: 2, Q: 0, SITE: 3, GEN: 1, TILE: 30, STATE: 2, FACTION: 0, TIER: 1, HOST_SEQ: 1, OWNER_CITIZEN: fromB58(OWNER), RESERVE: [400, 0, 0, 0, 0, 0, 100, 0] });
  const province = acct('Province', { P: 2, Q: 0, RESOLVED_NEXT: 42, SITE_COUNT: 1, SITES: Uint8Array.of(30, ...new Array(11).fill(0)), PASSABLE_MASK: (1n << 61n) - 1n,
    SITE_MIRROR: [{ STATE: 1, GEN: 1, FACTION: 0, TIER: 1 }, ...Array.from({ length: 11 }, () => ({ STATE: 0 }))],
    ENTRIES: [{ ID: BigInt(HOST), FACTION: 0, UNIT: 0, TILE: 30, STATE: 1, TROOPS: 600000, STAMINA_VALUE: 120, STAMINA_BELL: 42 }] });
  const fs = { mode: 'play', sample: null, proto: null, season: { ...SEASON, seasonId: 11n, programVersion: 18436, rulesetHash: new Uint8Array(32).fill(1) },
    wallet: { address: ME }, resident: null, session: null, meStatus: 'ready', meAnswered: true, localPlay: cfg.localPlay ?? null,
    citizen: acct('Citizen', { WALLET: fromB58(ME), FACTION: 0, FLAGS: 5, TICKET_BELL: 0xffffffff, HOLDING: [{ P: 2, Q: 0, SITE: 3, GEN: 1 }, { GEN: 255 }, { GEN: 255 }] }), holdings: [h], activeHolding: 0,
    selected: { kind: 'tile', p: 2, q: 0, idx: 30 }, hand: { host: HOST, pop: EXPEDITION_POP }, nowBell: 42, chain: { now: () => 1000 }, provinces: new Map([['2,0', { province }]]),
    view: { lod: 'tile', fog: true }, land: { stage: 'final' }, marches: [], book: [], orders: [], compose: null };
  clearInspection(fs);
  fs.expeditionPreview.p = standing.p; fs.expeditionPreview.q = standing.q; fs.expeditionPreview.sequence = '';
  const ctx = { pin: { programId: LP.LOCAL_PLAY_PROGRAM, cluster: 'localnet', seasonId: SEASON_ID, addresses: ADDRS }, relay: cfg.relay, source: {} };
  await inspectExpedition(fs, { context: () => ctx, read: async r => syntheticReturnInspection(r, { phase: 'dissolve' }) });
  assert.ok(fs.expeditionPreview.report, 'observed');
  return { fs, ctx };
}
/** The dependencies exactly as controller.mjs builds them (`localConquestDeps`): the world is read from the identity each time it is asked. */
const deps = (p, stand, more = {}) => {
  const posts = [];
  return { posts, options: { allowed: () => ({ ok: true, relay: HERALD }), context: () => p.ctx, signer: () => stand, world: () => p.fs.localPlay?.conquestWorld ?? null, changed: () => {},
    post: async (origin, path, body) => { posts.push({ origin, path, body: JSON.parse(JSON.stringify(body)) }); throw Object.assign(new Error('stand-in relay: closed'), { code: 'NotFound', refused: true }); }, ...more } };
};
const card = p => String(hand.renderPop(p.fs, hand.handModel(p.fs)));

test('a conquest world the launcher states for THIS start reaches the offer and the request unchanged: gate → cfg.localPlay → FS.localPlay → offer → target', async () => {
  const { cfg, stand } = await start(world());
  assert.deepEqual(cfg.localPlay.conquestWorld, world()); assert.equal(cfg.relay, RELAY);
  const p = await page(cfg);
  assert.equal(p.fs.localPlay, cfg.localPlay, 'the page store holds the gate\'s own identity object');
  // the offer: the city of the capability, in the province the host stands in; the roster entry of the observation
  assert.deepEqual(LC.localConquestOffer(p.fs, p.ctx, p.fs.localPlay.conquestWorld), { ok: true, site: 3, entry: 0, tile: 43, standing: { p: '129', q: '0' } });
  // the card offers the first press (and only that)
  setLang('ja');
  let c = card(p); assert.match(c, /data-act="local-conquest-prepare"/); assert.doesNotMatch(c, /data-local-conquest="unavailable"/); assert.doesNotMatch(c, /data-act="local-conquest-send"/);
  // with the module's OWN conditions (what the controller passes: none) the route is closed: nothing is posted
  const closed = deps(p, stand), s = await LC.prepareLocalConquest(p.fs, closed.options);
  assert.deepEqual([s.status, s.error], ['error', 'ConquestRouteClosed']); assert.equal(closed.posts.length, 0);
  // under TEST-ONLY conditions the world reaches the request the relay would be asked: this site, this entry, this identity
  LC.clearLocalConquest(p.fs);
  const open = deps(p, stand, { conditions: { heapConfirmed: true } }), t = await LC.prepareLocalConquest(p.fs, open.options);
  assert.equal(open.posts.length, 1); assert.equal(open.posts[0].origin, HERALD); assert.equal(open.posts[0].path, LC.LOCAL_CONQUEST_PREPARE_PATH);
  const body = open.posts[0].body;
  assert.deepEqual(body.target, { site: 3, entry: 0 }); assert.equal(body.action, 'DeclareSiege');
  assert.equal(body.source_request.program, LP.LOCAL_PLAY_PROGRAM); assert.equal(body.source_request.season, ADDRS.season); assert.deepEqual(body.source_request.standing, { p: '129', q: '0' });
  assert.equal(body.source_request.wallet, ME); assert.equal(body.source_request.payer, ME);
  // (the stand-in relay refuses, as today's relay does: said as an error, nothing signed)
  assert.deepEqual([t.status, t.error, t.sent, t.site, t.entry], ['error', 'NotFound', false, 3, 0]);
  LC.clearLocalConquest(p.fs);
});

test('no statement, or one that is not this start\'s world, never becomes an offer: the identity carries nothing, the card says the world has no city', async () => {
  setLang('ja');
  const cases = [['none', undefined], ['null', null], ['another Season', world({ season: OTHER.season })], ['another program', world({ program: ME })], ['another preset', world({ world_preset: 'S1_LOCAL_7D' })],
    ['an extra key', { ...world(), heapConfirmed: true }], ['the relay\'s capability shape', { ...world(), schema: 'frontier-local-play-conquest-capability-v1' }], ['a bad city', world({ free_city: { p: '129', q: '0', site: 12, tile: 43 } })]];
  for (const [why, claimed] of cases) {
    const { cfg, stand } = await start(claimed);
    assert.equal(Object.hasOwn(cfg.localPlay, 'conquestWorld'), false, why);
    const p = await page(cfg);
    assert.deepEqual(LC.localConquestOffer(p.fs, p.ctx, p.fs.localPlay?.conquestWorld ?? null), { ok: false, code: 'ConquestWorldUnavailable' }, why);
    const c = card(p); assert.match(c, /data-local-conquest="unavailable"/, why); assert.doesNotMatch(c, /data-act="local-conquest-prepare"/, why);
    const d = deps(p, stand, { conditions: { heapConfirmed: true } }), s = await LC.prepareLocalConquest(p.fs, d.options);
    assert.deepEqual([s.status, s.error], ['error', 'ConquestWorldUnavailable'], why); assert.equal(d.posts.length, 0, why);
    LC.clearLocalConquest(p.fs);
  }
});

test('a world is never taken for another: a city in another province, a world put on the identity from another start, a world that changes between presses', async () => {
  // the capability's city is in (129, 0); the host stands in (130, 0): no siege there
  { const { cfg, stand } = await start(world());
    const p = await page(cfg, { p: '130', q: '0' });
    assert.deepEqual(LC.localConquestOffer(p.fs, p.ctx, p.fs.localPlay.conquestWorld), { ok: false, code: 'ConquestNoFreeCityHere' });
    const d = deps(p, stand, { conditions: { heapConfirmed: true } }), s = await LC.prepareLocalConquest(p.fs, d.options);
    assert.deepEqual([s.status, s.error], ['error', 'ConquestNoFreeCityHere']); assert.equal(d.posts.length, 0); LC.clearLocalConquest(p.fs); }
  // a world object of ANOTHER Season or program placed on this identity by hand (past the gate): the offer checks it again against the identity
  for (const stray of [world({ season: OTHER.season }), world({ program: ME })]) {
    const { cfg } = await start(undefined);
    const p = await page({ ...cfg, localPlay: { ...cfg.localPlay, conquestWorld: stray } });
    assert.deepEqual(LC.localConquestOffer(p.fs, p.ctx, p.fs.localPlay.conquestWorld), { ok: false, code: 'ConquestWorldMismatch' });
  }
  // each start carries its own: a second start whose launcher names another site gives another offer, and none carries over
  { const a = await start(world()), b = await start(world({ free_city: { p: '129', q: '0', site: 5, tile: 12 } })), c = await start(undefined);
    assert.notEqual(a.cfg.localPlay, b.cfg.localPlay);
    const pa = await page(a.cfg), pb = await page(b.cfg), pc = await page(c.cfg);
    assert.equal(LC.localConquestOffer(pa.fs, pa.ctx, pa.fs.localPlay.conquestWorld).site, 3); assert.equal(LC.localConquestOffer(pb.fs, pb.ctx, pb.fs.localPlay.conquestWorld).site, 5);
    assert.equal(LC.localConquestOffer(pc.fs, pc.ctx, pc.fs.localPlay?.conquestWorld ?? null).ok, false); }
  // the world is asked again while the relay prepares: if the identity's world is another one by then, nothing is held for the second press
  { const { cfg, stand } = await start(world());
    const p = await page(cfg);
    const d = deps(p, stand, { conditions: { heapConfirmed: true } });
    d.options.post = async () => { p.fs.localPlay = { ...p.fs.localPlay, conquestWorld: world({ free_city: { p: '129', q: '0', site: 7, tile: 9 } }) }; return { report: {}, submit: null }; };
    const s = await LC.prepareLocalConquest(p.fs, d.options);
    assert.equal(s.status, 'error'); assert.equal(s.sent, false); assert.equal(LC.localConquestOf(p.fs).digest, null); LC.clearLocalConquest(p.fs); }
});

test('the wiring that carries it: one assignment of the identity in the controller, the same object in the store, the world read from it, the gate\'s cfg passed on by the page', () => {
  const read = file => readFileSync(new URL(`../../permutation-server/web/frontier/${file}`, import.meta.url), 'utf8');
  const ctl = read('controller.mjs'), app = read('app.mjs');
  // the gate's cfg (with `localPlay` as the gate left it) is what the page starts play with
  assert.match(app, /if \(localPlayRequested\(cfg\)\) cfg = \(await openLocalPlayGate\(\{ cfg, makeHerald: base => createHerald\(\{ base \}\) \}\)\.ready\)\.cfg;/);
  // the controller takes the identity once, and the store holds that same object
  assert.ok(ctl.includes('  localPlay = cfg.localPlay ?? null;\n  FS.localPlay = localPlay;\n'));
  assert.equal([...ctl.matchAll(/(^|[^.\w])localPlay = /g)].length, 2, 'declared once (null) and assigned once (startPlay): never rebuilt from parts');
  assert.equal([...ctl.matchAll(/FS\.localPlay = /g)].length, 1);
  // the siege reads the world from that identity each time it is asked, and passes no opening condition
  assert.ok(ctl.includes("world: () => localPlay?.conquestWorld ?? null, changed: () => invalidate('panel') });"));
  const from = ctl.indexOf('const localConquestDeps'), block = ctl.slice(from, ctl.indexOf('export const reconcileLocalPlayConquest', from) + 120);
  for (const banned of ['conditions', 'heapConfirmed', 'pageBinding']) assert.ok(!block.includes(banned), banned);
  // the two sides use the same words for the page's world statement, and the page's conditions are not established
  assert.equal(LP.LOCAL_PLAY_CONQUEST_WORLD_SCHEMA, LC.LOCAL_CONQUEST_WORLD_SCHEMA); assert.equal(LP.LOCAL_PLAY_CONQUEST_WORLD_PRESET, LC.LOCAL_CONQUEST_WORLD_PRESET);
  assert.deepEqual(LC.LOCAL_CONQUEST_PAGE_CONDITIONS, { heapConfirmed: false });
});
