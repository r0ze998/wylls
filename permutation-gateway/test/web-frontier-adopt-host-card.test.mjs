// adoptHoldings and a host in hand (2026-11-16). SOURCE ONLY — NOT run: all new test runs are paused.
// The cross-review (4e09c05e) asked whether adoptHoldings' put-away rule — subjectOf finds a held host through the
// envelopes in FS.provinces — could close a host card the player meant to keep. It cannot: every writer of
// FS.hand.host takes the id from rows built on FS.provinces (selectHost, handHost's chips / cycle, goToItem's item
// host), and adoptHoldings never writes FS.provinces and runs before refresh()'s envelope loads. The held host is lost
// to subjectOf only when a newer envelope no longer has it on the tile (moved, dissolved, in transit: the bar shows the
// same without any adoption) or its village is no longer held (lost, another generation, another viewer: hostOfHolding
// matches by identity) — in both, dropping the card is right; another viewer's host can never be kept.
// Pure data (hud/subject.mjs) plus sources read as text; no request, nothing stored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { baseProduction } from '../../permutation-server/web/frontier/fland.mjs';
import { subjectOf } from '../../permutation-server/web/frontier/hud/subject.mjs';

const village = (p, q, site, tile, gen = 0) => ({ p, q, site, gen, tile, faction: 0, state: 2, order: 1, tier: 0, flags: 0, production: baseProduction(0), upkeep: Array(8).fill(0n),
  stores: [], reserve: Array(8).fill(0), queue: [], transit: [{ state: 0 }], explore: { state: 0 }, lastOwnerAction: 1000n, finalTs: 1n, shieldUntil: 0n });
const A = village(2, 0, 2, 20), B = village(2, 0, 4, 33);
const host = (o, seq, tile, state = 1) => ({ id: hostId({ p: o.p, q: o.q, site: o.site, gen: o.gen, seq }), unit: 0, state, tile, troops: 100000, staminaValue: 120, staminaBell: 0, readyBell: 0, pendOp: 0, fromBell: 1 });
const bOnA = host(B, 1, A.tile);   // B's host standing on A's village tile
const world = (holdings, entries) => ({ mode: 'play', holdings, activeHolding: 0, nowBell: 2, chain: { now: () => 1000 }, citizen: { faction: 0 },
  provinces: new Map([['2,0', { province: { p: 2, q: 0, resolvedNext: 1, entries, ticketCohorts: [] } }]]),
  selected: { kind: 'tile', p: 2, q: 0, idx: A.tile }, hand: { host: String(bOnA.id), pop: null } });

test('a reordered list: the held host is still found, at its village\'s new position — a host card, nothing put away', () => {
  const sub = subjectOf(world([B, A], [bOnA]));
  assert.equal(sub.kind, 'host'); assert.equal(sub.host.id, String(bOnA.id)); assert.equal(sub.holdingIndex, 0);
});
test('its village no longer held (lost): not found — the tile\'s village is the subject, as it should be', () => {
  const sub = subjectOf(world([A], [bOnA]));
  assert.equal(sub.kind, 'village'); assert.equal(sub.holding, A);
});
test('its village held at another generation: not found (identity), so not kept as the old host', () => {
  const sub = subjectOf(world([A, village(2, 0, 4, 33, 1)], [bOnA]));
  assert.equal(sub.kind, 'village');
});
test('a newer envelope without it on the tile (moved / in transit): not found — the same as without any adoption', () => {
  assert.equal(subjectOf(world([A, B], [{ ...bOnA, state: 3 }])).kind, 'village');
  assert.equal(subjectOf(world([A, B], [{ ...bOnA, tile: 21 }])).kind, 'village');
});

test('the sources: adoptHoldings does not write the envelopes and runs before refresh() loads them; every hand host comes from rows', () => {
  const c = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
  const at = c.indexOf('function adoptHoldings(list) {'), fn = c.slice(at, c.indexOf('\n}\n', at));
  assert.doesNotMatch(fn, /FS\.provinces/);
  const r = c.slice(c.indexOf('export async function refresh() {'));
  assert.ok(r.indexOf("applyMeResult(me) === 'error'") < r.indexOf('await loadEnvelope(o.p, o.q)'), 'the adoption before the envelope loads');
  const a = readFileSync(new URL('../../permutation-server/web/frontier/app.mjs', import.meta.url), 'utf8');
  const writers = [...a.matchAll(/FS\.hand = \{ host: ([^,]+), pop: null \}/g)].map(m => m[1]);
  assert.deepEqual(writers, ['id ?? null', 'String(row.id)', 'null', 'String(x.host)'], 'handHost (a chip / the cycle), selectHost (a row), selectVillage, goToItem (an item\'s host)');
  const s = readFileSync(new URL('../../permutation-server/web/frontier/hud/subject.mjs', import.meta.url), 'utf8');
  assert.match(s, /export function ownHostsAt\(FS, p, q, idx\) \{\n\s+const prov = FS\.provinces\?\.get\?\.\(`\$\{p\},\$\{q\}`\)\?\.province \?\? null;[\s\S]*?\(FS\.holdings \?\? \[\]\)\.forEach\(\(holding, holdingIndex\) => \{[\s\S]*?rows = hostsIn\(prov, holding, bellOf\(FS\)\);/);
});
