// Round 25: local play refuses Dissolve when it is sent (flocalplay-act.mjs LOCAL_ACT_NAMES has no Dissolve), but the host
// bar offered it and its card's confirm was refused only after the press ("The host was not dissolved. In local play, this
// order cannot be sent yet (read only)" — seen in a ×30 live world). Now the button says that sentence and is not pressed,
// and the card (however it is reached) refuses its confirm with the same line. Local play sends nothing new; an ordinary
// session is byte-for-byte as before. Pure rendering: no key, no process, no network.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLang, L } from '../../permutation-server/web/lang.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { baseProduction } from '../../permutation-server/web/frontier/fland.mjs';
import { handModel, renderHand, renderPop } from '../../permutation-server/web/frontier/hud/hand.mjs';
import { LOCAL_ACT_NAMES, localOrderRoute } from '../../permutation-server/web/frontier/flocalplay-act.mjs';
import { SCOUT } from '../../permutation-server/web/frontier/fland.mjs';
const UNIT_SCOUT = () => SCOUT;

afterEach(() => setLang('ja'));
const LOCAL = Object.freeze({ address: 'W', programId: 'P', seasonAddress: 'S', cluster: 'localnet' });
const HOME = { p: 2, q: 0, site: 2, gen: 0, tile: 20, faction: 1, state: 2, order: 1, tier: 0, flags: 0, production: baseProduction(0), upkeep: Array(8).fill(0n), stores: [], reserve: Array(8).fill(0), queue: [],
  transit: [{ state: 0 }], explore: { state: 0 }, lastOwnerAction: 1000n, finalTs: 1n, shieldUntil: 0n };
const SEASON = { programVersion: 3, layoutVersion: 2, endBell: 96, bellSecs: 600, dormantAfterSecs: 86400, releaseAfterSecs: 172800, minLead: 2, maxLead: 72, conquestParams: { keepBells: 72 } };
function state({ localPlay, pop, marchOpen, marchFor, unit = 0, holdings = null, activeHolding = 0 } = {}) {
  const e = { id: hostId({ p: 2, q: 0, site: 2, gen: 0, seq: 1 }), unit, state: 1, tile: 20, troops: 300000, staminaValue: 120, staminaBell: 10, readyBell: 10, pendOp: 0, fromBell: 10 };
  return { mode: 'play', season: SEASON, citizen: { faction: 1 }, holdings: holdings ?? [HOME], activeHolding, nowBell: 10, chain: { now: () => 1000 }, land: { stage: 'final' }, inFlight: 0,
    provinces: new Map([['2,0', { province: { p: 2, q: 0, resolvedNext: 10, entries: [e], ticketCohorts: [] } }]]),
    conquest: { status: 'ready', keeps: new Map(), history: new Map(), standings: null, final: null, events: [] },
    selected: { p: 2, q: 0, idx: 20 }, hand: { host: String(e.id), pop }, ...(localPlay !== undefined ? { localPlay } : {}), ...(marchOpen !== undefined ? { localMarch: { open: marchOpen } } : {}), ...(marchFor ? { localMarchFor: marchFor } : {}) };
}
const button = (out, id) => new RegExp(`<button type="button" class="hand-btn hand-${id}[^"]*"[^>]*>`).exec(out)?.[0] ?? '';

test('the premise: local play refuses Dissolve when it is sent, and sends its own few orders only', () => {
  assert.equal(LOCAL_ACT_NAMES.includes('Dissolve'), false);
  assert.equal(localOrderRoute({ localPlay: LOCAL, name: 'Dissolve', v: {}, signer: undefined, requester: null }), 'refuse');
  assert.equal(localOrderRoute({ localPlay: null, name: 'Dissolve', v: {}, signer: undefined, requester: null }), 'general');
});

test('local play: the Dissolve button says why and is not pressed; the card refuses its confirm with the same line', () => {
  for (const lang of ['ja', 'en']) {
    setLang(lang);
    // (the march trial open: Dissolve is the only button refused for this reason, so the reason stands on it)
    const s = state({ localPlay: LOCAL, marchOpen: true }), out = String(renderHand(handModel(s)));
    const b = button(out, 'dissolve');
    assert.match(b, /\boff\b/, `${lang}: refused`); assert.match(b, /aria-disabled="true"/);
    const say = L`ローカルプレイでは、まだ命令を送れません（読み取りのみ）。`;
    // (round 27: said in full on the bar's own line, which wraps — not clipped inside the button; the button stays refused
    //  and keeps the sentence as its title)
    assert.ok(out.includes(`<p class="hand-note hand-note-why">${say}</p>`), `${lang}: the reason is on the bar's line, in full`);
    assert.ok(b.includes(`title="${say}"`), `${lang}: and on the button's title`);
    // the card, however it is reached: its confirm refused, the same line said
    const p = state({ localPlay: LOCAL, marchOpen: true, pop: 'dissolve' }), pop = String(renderPop(p, handModel(p)));
    assert.match(pop, /data-act="dissolve"[^>]*aria-disabled="true"/, `${lang}: the card's confirm is refused`);
    assert.ok(pop.includes(say), `${lang}: and says why`);
  }
  // the English is the sentence the refusal itself says
  setLang('en'); assert.equal(L`ローカルプレイでは、まだ命令を送れません（読み取りのみ）。`, 'In local play, this order cannot be sent yet (read only).');
});

test('an ordinary session is exactly as before: the button and card offer Dissolve', () => {
  for (const localPlay of [undefined, null, false, 0, '']) {
    const s = state({ localPlay }), out = String(renderHand(handModel(s)));
    assert.doesNotMatch(button(out, 'dissolve'), /\boff\b|aria-disabled/, `localPlay=${String(localPlay)}`);
    const p = state({ localPlay, pop: 'dissolve' }), pop = String(renderPop(p, handModel(p)));
    assert.doesNotMatch(pop, /data-act="dissolve"[^>]*aria-disabled/);
  }
  // and with local play's march trial open, March is not refused by any of this
  const s = state({ localPlay: LOCAL, marchOpen: true }), out = String(renderHand(handModel(s)));
  assert.doesNotMatch(button(out, 'march'), /\boff\b|aria-disabled/);
});

test('the source: the bar and the card ask the same rule the send uses; nothing is added to what local play sends', () => {
  const h = readFileSync(new URL('../../permutation-server/web/frontier/hud/hand.mjs', import.meta.url), 'utf8');
  assert.match(h, /const localRefuses = \(FS, name\) => !!FS\?\.localPlay && localOrderRoute\(\{ localPlay: FS\.localPlay, name, v: \{\}, signer: undefined, requester: null \}\) === 'refuse';/);
  assert.match(h, /dLocal = localRefuses\(FS, 'Dissolve'\)/);
  const a = readFileSync(new URL('../../permutation-server/web/frontier/flocalplay-act.mjs', import.meta.url), 'utf8');
  assert.match(a, /export const LOCAL_ACT_NAMES = Object\.freeze\(\['Join', 'PlaceHome', 'Harvest', 'Build', 'Train', 'Muster'\]\);/);
});

test('round 26: a march (March, its return home, a march on a keep) is refused on the bar while local play\'s march trial is closed, as its send refuses it; open, as before', () => {
  setLang('en');
  const say = 'In local play, this order cannot be sent yet (read only).';
  for (const marchOpen of [undefined, false]) {
    const s = state({ localPlay: LOCAL, marchOpen }), m = handModel(s), out = String(renderHand(m));
    for (const id of ['march', 'dissolve']) assert.match(button(out, id), /\boff\b[^>]*aria-disabled="true"|aria-disabled="true"/, `${id} refused (march open=${marchOpen})`);
    assert.equal(m.buttons.find(b => b.id === 'march').why, say);
    // (more than one button refused for one reason: the bar says it once, on its own line, as it does for any shared reason)
    assert.ok(out.includes(`<p class="hand-note hand-note-why">${say}</p>`), 'said once on the bar');
  }
  // (the keeps button follows the page-wide gate: a march on a keep is composed for the active village — round 27)
  assert.match(readFileSync(new URL('../../permutation-server/web/frontier/hud/hand.mjs', import.meta.url), 'utf8'), /why: r\.inTransit \? mc\.text : mLocalPage \? localReadOnlyText\(\) : null, tone: waitOf\(FS, r\)/);
  const open = handModel(state({ localPlay: LOCAL, marchOpen: true }));
  assert.equal(open.buttons.find(b => b.id === 'march').why, null, 'the march trial open: March as before');
  // an ordinary session: no local-play reason anywhere
  for (const localPlay of [undefined, null, false]) { const m = handModel(state({ localPlay })); assert.ok(m.buttons.every(b => b.why !== say), String(localPlay)); }
});

test('round 26: a Scout\'s Explore says local play cannot send it (local play refuses Explore when sent); an ordinary session as before', () => {
  setLang('en');
  const say = 'In local play, this order cannot be sent yet (read only).';
  assert.equal(localOrderRoute({ localPlay: LOCAL, name: 'Explore', v: {}, signer: undefined, requester: null }), 'refuse');
  const scout = UNIT_SCOUT();
  const m = handModel(state({ localPlay: LOCAL, marchOpen: true, unit: scout })), ex = m.buttons.find(b => b.id === 'explore');
  assert.ok(ex, 'a Scout has Explore'); assert.equal(ex.why, say);
  const o = handModel(state({ unit: scout })).buttons.find(b => b.id === 'explore');
  assert.notEqual(o?.why, say, 'an ordinary session: not this reason');
});

test('round 27: the bar asks the march gate for the host it shows (its own village and its own held march), as its send would find it', () => {
  setLang('en');
  const say = 'In local play, this order cannot be sent yet (read only).';
  const asked = [];
  // the page-wide answer is closed (it is computed for another village or a stale order), but this host's own is open
  const open = (holding, hostId) => { asked.push([holding?.site ?? null, hostId]); return { open: true }; };
  const m = handModel(state({ localPlay: LOCAL, marchOpen: false, marchFor: open }));
  assert.equal(m.buttons.find(b => b.id === 'march').why, null, 'this host\'s march would be sent: not refused');
  assert.ok(asked.length > 0 && asked.every(([site]) => site === 2), 'asked for this host\'s own village');
  // and the other way: the page-wide answer open, this host's own closed (its village is not allowed, or its march is held)
  const closed = () => ({ open: false });
  const c = handModel(state({ localPlay: LOCAL, marchOpen: true, marchFor: closed }));
  assert.equal(c.buttons.find(b => b.id === 'march').why, say, 'refused as its send would refuse it');
  // without the per-host answer (an older page), the page-wide one, as before
  assert.equal(handModel(state({ localPlay: LOCAL, marchOpen: false })).buttons.find(b => b.id === 'march').why, say);
  // an ordinary session never asks
  const never = () => { throw new Error('asked'); };
  assert.doesNotThrow(() => handModel(state({ marchFor: never })));
});

test('round 27: no local-play reason is clipped inside a button; the bar says it once, in full', () => {
  setLang('en');
  const say = 'In local play, this order cannot be sent yet (read only).';
  for (const marchOpen of [true, false]) {
    const out = String(renderHand(handModel(state({ localPlay: LOCAL, marchOpen }))));
    assert.equal((out.match(/<span class="hand-why">In local play/g) ?? []).length, 0, `marchOpen=${marchOpen}: none in a button`);
    assert.equal((out.match(/In local play, this order cannot be sent yet \(read only\)\.<\/p>/g) ?? []).length, 1, 'said once on the bar');
  }
  // the controller gives the bar the same computation the send reads (localMarchView is localMarchFor of the composed order)
  const c = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
  assert.match(c, /function localMarchView\(\) \{\n  if \(!localPlay\) return null;\n  const h = FS\.compose\?\.holding \? holdingByRef\(FS\.holdings, FS\.compose\.holding\) : activeHolding\(FS\);\n  return localMarchFor\(h, FS\.compose\?\.host\?\.id \?\? null\);\n\}/);
  assert.match(c, /Object\.defineProperty\(FS, 'localMarchFor', \{ configurable: true, enumerable: false, value: \(holding, hostId\) => localMarchFor\(holding \? holdingByRef\(FS\.holdings, holding\) : null, hostId\) \}\);/);
});
