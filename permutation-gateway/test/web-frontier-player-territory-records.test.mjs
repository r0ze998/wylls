// player-territory-records (owner 2026-11-25 18:50, inbox 2026-11-25-1850-r0ze-tunnel-tm2.md):
//   Q-TM2-1 yes  the herald also publishes the per-player territory record ('wu': tiles, upkeep, unpaid) — herald
//                wide_territory.rs player_json, GET /h/world/wide/territory/player/<citizen> — so the village card (#231)
//                and the MCP own summary (#227) no longer depend on the relay. The relay (local) / the gateway's land
//                summary (devnet) is asked only when the herald serves no such route (an older build).
//   Q-TM2-2      keep the last-seen owner as a faded colour at 40 % (map/territorytiles.mjs FADED, the legend swatch).
// FOG: the page asks the herald about its OWN Citizen only, and drops an answer naming anyone else.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as T from '../../permutation-server/web/frontier/flocalplay-territory.mjs';
import { createHerald } from '../../permutation-server/web/frontier/herald.mjs';
import { FADED } from '../../permutation-server/web/frontier/map/territorytiles.mjs';
import { seasonAddresses } from '../../permutation-server/web/frontier/faddr.mjs';

const web = f => readFileSync(new URL(`../../permutation-server/web/${f}`, import.meta.url), 'utf8');
const rust = f => readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');

const PROGRAM = 'Vote111111111111111111111111111111111111111', WALLET = 'SysvarRent111111111111111111111111111111111', OTHER = 'SysvarC1ock11111111111111111111111111111111';
const A = seasonAddresses(PROGRAM, '11');
const ME = A.of('Citizen', { wallet: WALLET }), THEM = A.of('Citizen', { wallet: OTHER });
const ADDRESS = T.territoryPlayerAddress(A.season, PROGRAM, ME);

/** A territory summary record (frontier-abi territory_player: UNPAID @19, CITIZEN_TAG @84, TILES @92, EXCESS_SUM @96, PAID_TO @104, UNPAID_SINCE @120). */
function summaryBytes({ tiles = 0, excess = 0n, unpaidSince = null, tag = BigInt(T.citizenTagOf(ME)), paidTo = 1_794_000_000n } = {}) {
  const b = new Uint8Array(320), v = new DataView(b.buffer);
  b.set([...'PSFXWTU1'].map(c => c.charCodeAt(0))); b[18] = 1; b[19] = unpaidSince === null ? 0 : 1;
  v.setBigUint64(84, tag, true); v.setUint32(92, tiles, true); v.setBigUint64(96, excess, true); v.setBigInt64(104, paidTo, true); v.setUint32(120, unpaidSince ?? 0xffffffff, true);
  return b;
}
/** The herald's answer (wide_territory.rs player_json) for `citizen` holding `bytes` (null: none captured). */
function answer(bytes, { citizen = ME, address = ADDRESS } = {}) {
  const r = bytes ? T.decodeTerritoryPlayer(bytes) : null;
  return {
    v: 1, experimental: true, readOnly: true, verification: 'captured-unverified', completeness: 'captured', season: '11', program: PROGRAM, seasonAddress: A.season,
    citizen, address,
    player: r ? { slot: '9', archiveSequence: '3', rule: 1, citizenTag: r.citizenTag, faction: 0, tiles: r.tiles, excessSum: String(r.excessSum), upkeepMilliPerHour: String(r.upkeepMilliPerHour),
      paidTo: String(r.paidTo), remainder: '0', unpaid: r.unpaid, unpaidSince: r.unpaidSince, decayAfterBells: 24, nextClaimCost: String(T.claimCostV1(r.tiles)), bytes_b64: Buffer.from(bytes).toString('base64') } : null,
  };
}
const OPTS = { citizen: ME, address: ADDRESS, tag: T.citizenTagOf(ME), pins: { seasonAddress: A.season, program: PROGRAM } };

test('Q-TM2-1: the herald answer gives the card the same numbers as the record the relay reads', () => {
  for (const o of [{}, { tiles: 3, excess: 6n }, { tiles: 100, excess: 0n, unpaidSince: 4321 }, { tiles: 12, excess: 9n, unpaidSince: 10 }]) {
    const bytes = summaryBytes(o);
    const viaRelay = T.decodeTerritoryPlayer(bytes), viaHerald = T.heraldTerritoryPlayer(answer(bytes), OPTS);
    assert.ok(viaHerald, `${o.tiles}|${o.unpaidSince}`);
    assert.deepEqual(viaHerald.player, viaRelay);
    for (const bell of [0, 20, 40, 5000]) assert.deepEqual(T.ownLandView(viaHerald.player, bell), T.ownLandView(viaRelay, bell));
  }
  // none captured: "no record yet" — the card's no-land line, as a relay read of an absent account
  assert.deepEqual(T.heraldTerritoryPlayer(answer(null), OPTS), { player: null });
  assert.deepEqual(T.ownLandView(null, 0), T.ownLandView(T.heraldTerritoryPlayer(answer(null), OPTS).player, 0));
});

test('FOG: an answer about another Citizen, another record address, another world, or bytes of another tag is dropped', () => {
  const good = answer(summaryBytes({ tiles: 2 }));
  assert.ok(T.heraldTerritoryPlayer(good, OPTS));
  assert.equal(T.heraldTerritoryPlayer({ ...good, citizen: THEM }, OPTS), null, 'another Citizen');
  assert.equal(T.heraldTerritoryPlayer({ ...good, address: T.territoryPlayerAddress(A.season, PROGRAM, THEM) }, OPTS), null, 'another address');
  assert.equal(T.heraldTerritoryPlayer({ ...good, seasonAddress: OTHER }, OPTS), null, 'another season');
  assert.equal(T.heraldTerritoryPlayer({ ...good, program: OTHER }, OPTS), null, 'another program');
  assert.equal(T.heraldTerritoryPlayer(answer(summaryBytes({ tiles: 2, tag: 5n })), OPTS), null, 'a record of another tag');
  assert.equal(T.heraldTerritoryPlayer({ ...good, player: { ...good.player, unpaid: true } }, OPTS), null, 'a stated field the bytes do not say');
  assert.equal(T.heraldTerritoryPlayer({ ...good, player: { ...good.player, bytes_b64: 'AAAA' } }, OPTS), null, 'not a summary');
  assert.equal(T.heraldTerritoryPlayer({ ...good, v: 2 }, OPTS), null);
  assert.equal(T.heraldTerritoryPlayer({ v: 1, citizen: ME, address: ADDRESS }, OPTS), null, 'no player field at all');
  assert.equal(T.heraldTerritoryPlayer({ ok: false, code: 'WideWorldUnavailable' }, OPTS), null);
});

test('Q-TM2-1: the herald client asks for ONE Citizen by path, with the caller\'s ETag; 304 is notModified; an older herald says NotFound', async () => {
  const calls = [];
  let status = 200;
  const body = answer(summaryBytes({ tiles: 1 }));
  const fetch = async (url, init = {}) => {
    calls.push({ url, inm: init.headers?.['if-none-match'] ?? null });
    if (status === 404) return new Response(JSON.stringify({ ok: false, code: 'NotFound' }), { status: 404 });
    if (status === 503) return new Response(JSON.stringify({ ok: false, code: 'WideWorldUnavailable' }), { status: 503 });
    if (init.headers?.['if-none-match'] === '"p1"') return new Response(null, { status: 304, headers: { etag: '"p1"' } });
    return new Response(JSON.stringify(body), { status: 200, headers: { etag: '"p1"', 'content-type': 'application/json' } });
  };
  const h = createHerald({ base: 'http://h', fetch });
  const a = await h.wideTerritoryPlayer(ME);
  assert.deepEqual([a.ok, a.etag, calls[0].url, calls[0].inm], [true, '"p1"', `http://h/h/world/wide/territory/player/${ME}`, null]);
  assert.equal(T.heraldTerritoryPlayer(a.json, OPTS).player.tiles, 1);
  const b = await h.wideTerritoryPlayer(ME, { etag: a.etag });
  assert.deepEqual([b.ok, b.notModified, b.json, calls[1].inm], [true, true, undefined, '"p1"']);
  status = 404;
  assert.deepEqual([(await h.wideTerritoryPlayer(ME)).code], ['NotFound']);
  status = 503;
  assert.deepEqual([(await h.wideTerritoryPlayer(ME)).code], ['WideWorldUnavailable']);
  const n = calls.length;
  for (const bad of ['', 'x/../../h/status', '0OIl' + 'a'.repeat(40), null]) assert.equal((await h.wideTerritoryPlayer(bad)).code, 'BadCitizen');
  assert.equal(calls.length, n, 'a malformed Citizen is never put in a URL');
});

test('Q-TM2-1: the village card reads its own summary from the herald first; the relay only when that herald has no route', () => {
  const src = web('frontier/controller.mjs');
  const body = src.slice(src.indexOf('let ownLandHeraldOff'), src.indexOf('// ------------------------------------------------------------------ ② rights'));
  // the herald, about the viewer's own Citizen, its answer checked against the own record address and the pinned world
  assert.match(body, /const r = await herald\.wideTerritoryPlayer\(citizen, \{ etag: same \? ownLandEtag : null \}\);/);
  assert.match(body, /heraldTerritoryPlayer\(r\.json, \{ citizen, address: territoryPlayerAddress\(pin\.addresses\.season, pin\.programId, citizen\),\n\s+tag: citizenTagOf\(citizen\), pins: \{ seasonAddress: pin\.addresses\.season, program: pin\.programId \} \}\)/);
  assert.match(body, /const citizen = viewerCitizen\(\), world = providerWorld\(\);/);
  // the fallback: only NotFound / WideWorldUnavailable switch this page to the relay, and only for this page's life
  assert.match(body, /if \(r\?\.code === 'NotFound' \|\| r\?\.code === 'WideWorldUnavailable'\) \{ ownLandHeraldOff = true; return undefined; \}/);
  assert.match(body, /let via = 'herald', got = await ownLandFromHerald\(pin, citizen, world\);\n\s+if \(got === undefined\) \{\n\s+via = 'relay';\n\s+got = await ownLandFromRelay\(pin, citizen, local\);/);
  // a 304 keeps the herald answer of the same Citizen and world only
  assert.match(body, /const same = ownLandEtagFor === key && FS\.ownLand\?\.via === 'herald' && FS\.ownLand\.citizen === citizen && FS\.ownLand\.world === world;/);
  assert.match(body, /if \(r\.notModified\) return same \? \{ player: FS\.ownLand\.player \} : null;/);
  // the herald path needs no relay gate (a page without a relay still shows its land)
  const fromHerald = body.slice(body.indexOf('async function ownLandFromHerald'), body.indexOf('async function ownLandFromRelay'));
  assert.ok(!/localDepartGate|devnetGate|postLocalAct/.test(fromHerald));
});

test('Q-TM2-1: the herald route is the Rust one, served under the territory route\'s cache rules, and its numbers are the record\'s rule', () => {
  const server = rust('frontier-node/crates/herald/src/server.rs'), wt = rust('frontier-node/crates/herald/src/wide_territory.rs');
  assert.match(server, /\.route\(\s*"\/h\/world\/wide\/territory\/player\/\{citizen\}",\s*get\(world_wide_territory_player\),?\s*\)/);
  assert.match(server, /fn etag_answer\(h: &HeaderMap, gz: &\[u8\], body: &\[u8\], etag: &str\) -> Response \{\n\s+let cache = "public, max-age=5";/);
  assert.match(wt, /"upkeepMilliPerHour": r\.upkeep_per_hour\(\)/);
  assert.match(wt, /permutation_rules::frontier::territory::claim_cost\(&k\.cost, r\.tiles\)/);
  assert.match(wt, /\.filter\(\|\(_, r\)\| r\.citizen == \*citizen\)/, 'the answer is the asked Citizen\'s record only');
  // the web path the herald client builds is the Rust route
  assert.match(web('frontier/herald.mjs'), /`\$\{root\}\/h\/world\/wide\/territory\/player\/\$\{citizen\}`/);
});

test('Q-TM2-2: the last-seen owner is drawn at 40 % — the wash and the border, and the legend swatch', () => {
  assert.deepEqual({ ...FADED }, { wash: 0.4, band: 0.4 });
  const css = web('frontier/frontier.css');
  assert.match(css, /\.wide-legend-swatch\[data-key="faded"\] \{ background: rgba\(154, 154, 146, 0\.4\); border-color: rgba\(74, 74, 68, 0\.4\); \}/);
  const tt = web('frontier/map/territorytiles.mjs');
  assert.match(tt, /ctx\.globalAlpha = look\.wash \* \(old \? FADED\.wash : 1\);/);
  assert.match(tt, /ctx\.globalAlpha = old \? FADED\.band : 1;/);
});
