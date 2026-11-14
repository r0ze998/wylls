// Ordinary clicks for the march at a fast test clock (×60 recapture world, 2026-11-14): a fort row refused every press while
// its province finished the previous turn (`settling`), the wait line above the rows pushed them up and down under the
// pointer, and the page read the province every 5 s while the chain allowed the seal a median 6.7 s of a 10 s turn.
// Now: a fort may be chosen while a formed host (state 1) only waits for `settling` (choosing sends nothing; the order card holds the seal),
// the wait line stands below the rows, and on local play's test march the province an open order or card waits on is read
// again every half second (read only, one read at a time, a stale answer dropped). No rule and no seal check changes.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { baseProduction } from '../../permutation-server/web/frontier/fland.mjs';
import * as K from '../../permutation-server/web/frontier/hud/keephand.mjs';
import { handModel, renderPop } from '../../permutation-server/web/frontier/hud/hand.mjs';

afterEach(() => setLang('ja'));
const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);
const src = f => readFileSync(new URL(f, WEB), 'utf8');
const NO = 255;
const keep = (p, q, extra = {}) => ({ p, q, tile: 18, holder: 2, troops: 100, heartland: false, consolidatedUntil: 0, contender: NO, progress: 0, requiredBells: 72, asOfBell: 50, ...extra });
const HOME = { p: 2, q: 0, site: 2, gen: 0, tile: 20, faction: 1, state: 2, order: 1, tier: 0, flags: 0, production: baseProduction(0), upkeep: Array(8).fill(0n), stores: [], reserve: Array(8).fill(0), queue: [],
  transit: [{ state: 0 }], explore: { state: 0 }, lastOwnerAction: 1000n, finalTs: 1n, shieldUntil: 0n };
const SEASON = { programVersion: 3, layoutVersion: 2, endBell: 96, bellSecs: 600, dormantAfterSecs: 86400, releaseAfterSecs: 172800, minLead: 2, maxLead: 72, conquestParams: { keepBells: 72 } };
function state({ nowBell = 10, resolvedNext = 10, entry = {} } = {}) {
  const e = { id: hostId({ p: 2, q: 0, site: 2, gen: 0, seq: 1 }), unit: 0, state: 1, tile: 20, troops: 300000, staminaValue: 120, staminaBell: 10, readyBell: 10, pendOp: 0, fromBell: 10, ...entry };
  const s = { mode: 'play', season: SEASON, citizen: { faction: 1 }, holdings: [HOME], nowBell, chain: { now: () => 1000 }, land: { stage: 'final' }, inFlight: 0,
    provinces: new Map([['2,0', { province: { p: 2, q: 0, resolvedNext, entries: [e], ticketCohorts: [] } }]]),
    conquest: { status: 'ready', keeps: new Map([['0,4', keep(0, 4)]]), history: new Map(), standings: null, final: null, events: [] },
    selected: { p: 2, q: 0, idx: 20 }, hand: { host: String(e.id), pop: 'keeps' } };
  s.conquest.hostReach = { key: 'k', host: String(e.id), ok: true, unreachable: [], rows: [{ p: 0, q: 4, tile: 18, holder: 2, troops: 100, route: { hexes: 9, provinces: [0, 1], secs: 900 } }] };
  return s;
}
const rowOf = out => /<button type="button" class="kh-row[^"]*"[^>]*>/.exec(out)?.[0] ?? '';

test('choosableWait: no wait, or only the province finishing its turn for a host already formed', () => {
  const formed = { state: 1 }, forming = { state: 2 };
  assert.equal(K.choosableWait(null, formed), true);
  assert.equal(K.choosableWait({ why: 'settling', turn: 12, nudge: true }, formed), true);
  // a host still forming shows `settling` once its turn has come, but the order card would keep it busy: never chosen
  assert.equal(K.choosableWait({ why: 'settling', turn: 12, nudge: true }, forming), false);
  assert.equal(K.choosableWait({ why: 'settling' }), false, 'no host, no choice');
  for (const why of ['march', 'forming', 'resting', 'stamina', 'blocked']) assert.equal(K.choosableWait({ why }, formed), false, why);
});

test('a fort row may be chosen while the province only finishes its turn; every other wait still refuses it', () => {
  // ready: as before
  { const s = state(); const out = String(renderPop(s, handModel(s))); assert.doesNotMatch(rowOf(out), /\boff\b|aria-disabled/); }
  // settling (the province two turns behind): choosable now, and the wait is still said
  { const s = state({ nowBell: 12, resolvedNext: 10 }); assert.equal(K.waitOf(s, handModel(s).host)?.why, 'settling');
    const out = String(renderPop(s, handModel(s)));
    assert.match(rowOf(out), /data-act="cq-march"/); assert.doesNotMatch(rowOf(out), /\boff\b|aria-disabled/, 'not refused');
    assert.match(out, /kh-wait-line/, 'the wait is still said');
    assert.ok(out.indexOf('kh-rows') < out.indexOf('kh-wait-line'), 'the wait line stands below the rows (they do not move when it comes and goes)'); }
  // resting (ready only at a later turn): still refused
  { const s = state({ entry: { readyBell: 15 } }); const out = String(renderPop(s, handModel(s)));
    assert.match(rowOf(out), /\boff\b/); assert.match(rowOf(out), /aria-disabled="true"/); }
  // a host still forming whose turn has come: shown as settling, and still refused (its order card could not be sealed)
  { const s = state({ nowBell: 12, resolvedNext: 10, entry: { state: 2, fromBell: 11 } });
    assert.equal(K.waitOf(s, handModel(s).host)?.why, 'settling');
    const out = String(renderPop(s, handModel(s))); assert.match(rowOf(out), /\boff\b/); assert.match(rowOf(out), /aria-disabled="true"/); }
  // low stamina: still refused
  { const s = state({ entry: { staminaValue: 10, staminaBell: 10 } }); const out = String(renderPop(s, handModel(s))); assert.match(rowOf(out), /aria-disabled="true"/); }
});

test('the board\'s own fort clicks follow the same rule', () => {
  const app = src('app.mjs');
  assert.match(app, /if \(hit0\.keep\.reachable && keephand\.choosableWait\(keephand\.waitOf\(FS, sub\.host\), sub\.host\)\) Promise\.resolve\(ACTIONS\['cq-march'\]/);
  assert.match(app, /if \(!row \|\| !keephand\.choosableWait\(keephand\.waitOf\(FS, sub\.host\), sub\.host\)\) return;/);
  assert.doesNotMatch(app, /!keephand\.waitOf\(FS, sub\.host\)/, 'no other fort click is refused for settling');
});

test('the half-second read: local play\'s test march only, only while an order or the muster/forts card is open, one read at a time, stale answers dropped', () => {
  const c = src('controller.mjs');
  assert.match(c, /export const LOCAL_SYNC_MS = 500;/);
  const block = c.slice(c.indexOf('function localSyncTarget()'), c.indexOf('function armMarchWait()'));
  assert.match(block, /if \(!localMarchTrial\(\)\) return null;/, 'local play\'s test march only');
  assert.match(block, /if \(FS\.compose\?\.origin\) return \{ p: FS\.compose\.origin\.p, q: FS\.compose\.origin\.q \};/);
  assert.match(block, /if \(pop === 'muster' \|\| pop === 'keeps'\)/);
  assert.match(block, /if \(!target \|\| localSyncBusy \|\| pendingDriver\.armed \|\| t - localSyncLast < LOCAL_SYNC_MS\) return false;/, 'one at a time; not while the pending send reads on its own');
  assert.match(block, /loadEnvelope\(target\.p, target\.q, 'latest', still\)/, 'the ordinary read-only province read');
  assert.match(block, /const still = \(\) => \{ const n = localSyncTarget\(\); return herald === h0 && localPlay === lp0 && \(FS\.wallet\?\.address \?\? null\) === w0 && !!n && `\$\{n\.p\},\$\{n\.q\}` === key; \};/);
  assert.doesNotMatch(block, /setInterval|setTimeout|sendTheMarch|act\(/, 'no timer of its own; never a send');
  const app = src('app.mjs');
  assert.match(app, /if \(FS\.mode === 'play'\) \{ try \{ localSyncTick\(\); \} catch \(e\) \{ console\.error\('frontier local sync:', e\); \} \}/, 'called from the page\'s quarter-second dial loop');
});

test('round 16: the wait line\'s slot is always there with one least height, so the rows never move when a wait comes or goes', () => {
  const slotAt = out => out.indexOf('class="kh-wait-slot"');
  // no wait: the slot is still there, empty, right after the rows
  { const out = String(renderPop(state(), handModel(state()))); assert.ok(slotAt(out) > out.indexOf('kh-rows'), 'after the rows');
    // (round 19) nothing waits: the slot holds the settling line hidden and inert, without a button
    assert.match(out, /<div class="kh-wait-ghost" aria-hidden="true" inert>/); assert.equal((out.match(/kh-wait-line/g) ?? []).length, 1, 'only the hidden stand-in');
    assert.doesNotMatch(out.slice(out.indexOf('kh-wait-ghost')), /data-act="nudge"/, 'the stand-in offers nothing'); }
  // a wait (settling): the line is inside the same slot
  { const s = state({ nowBell: 12, resolvedNext: 10 }); const out = String(renderPop(s, handModel(s)));
    assert.ok(slotAt(out) > out.indexOf('kh-rows')); assert.ok(out.indexOf('kh-wait-line') > slotAt(out), 'the line is in the slot'); }
  const css = readFileSync(new URL('conquest-hand.css', WEB), 'utf8');
  assert.match(css, /\.kh-wait-slot \{ min-height: 64px; \}/, 'one least height');
  assert.match(css, /\.kh-wait-ghost \{ visibility: hidden; pointer-events: none; \}/, 'the stand-in is not seen and not pressed');
  assert.doesNotMatch(css, /kh-wait-slot[^}]*line-clamp|kh-wait-line[^}]*line-clamp/, 'the text is never cut (a forming host\'s line says when it stands)');
});

test('round 19: with the forts card open, the bar leaves the wait to the card (the card stands on the bar, so the bar\'s line moved its rows)', () => {
  // the province two turns behind, the forts card open: the card's slot says the wait, the bar says nothing more
  { const s = state({ nowBell: 12, resolvedNext: 10 }); const m = handModel(s);
    assert.equal(m.pop, 'keeps'); assert.equal(m.note, null, 'no second line on the bar');
    const out = String(renderPop(s, m)); assert.ok(out.indexOf('kh-wait-line') > out.indexOf('kh-wait-slot'), 'the card says it'); }
  // the same province with no card open: the bar still says why its buttons wait
  { const s = state({ nowBell: 12, resolvedNext: 10 }); s.hand = { host: s.hand.host }; const m = handModel(s);
    assert.equal(m.pop, null); assert.ok(m.note, 'the bar says it'); assert.equal(m.noteTone, 'why'); }
  // nothing waits: nothing changes
  { const s = state(); assert.equal(handModel(s).note, null); }
});
