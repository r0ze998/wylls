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
import * as M from '../../permutation-server/web/frontier/flocalplay-march.mjs';
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

// (fix-loop5 L5-8: the march buttons say the march lane's own reason — firststeps.mjs marchClosedReasonText)
const MARCH_CLOSED = 'Marching from this page is not available in this world now.';
const MARCH_HELD = "This host's march was sent and its result is not confirmed yet. The same march will not be sent again.";

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
    // (B6, 2026-11-18: the bar's line names the refused order — it stood under a host whose March was sent normally)
    const named = lang === 'en' ? 'In local play, “Dissolve” cannot be sent yet (read only).' : 'ローカルプレイでは、「解散」はまだ送れません（読み取りのみ）。';
    assert.ok(out.includes(`<p class="hand-note hand-note-why">${named}</p>`), `${lang}: the reason is on the bar's line, in full, naming the order`);
    assert.ok(!out.includes(`<p class="hand-note hand-note-why">${say}</p>`), `${lang}: never the sentence that names no order`);
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
  // (wide-local-playable: the local wide world's rim request and wide claim joined the list; still no Dissolve)
  // (wide -> wide marches, #94: and the wide village's three acts, WIDE_HOST_ACTS = WideTrain / WideMuster / WideDepart)
  assert.match(a, /export const LOCAL_ACT_NAMES = Object\.freeze\(\['Join', 'PlaceHome', 'Harvest', 'Build', 'Train', 'Muster', 'FileTicket', WIDE_CLAIM, TERRITORY_CLAIM, \.\.\.WIDE_HOST_ACTS, \.\.\.RESEARCH_ACTS\]\);/);  // (+ research, world goal ②)
  const wh = readFileSync(new URL('../../permutation-server/web/frontier/flocalplay-wide-host.mjs', import.meta.url), 'utf8');
  assert.match(wh, /export const WIDE_HOST_ACTS = Object\.freeze\(\[WIDE_TRAIN, WIDE_MUSTER, WIDE_DEPART\]\);/);
});

test('round 26: a march (March, its return home, a march on a keep) is refused on the bar while local play\'s march trial is closed, as its send refuses it; open, as before', () => {
  setLang('en');
  const say = 'In local play, this order cannot be sent yet (read only).';
  for (const marchOpen of [undefined, false]) {
    const s = state({ localPlay: LOCAL, marchOpen }), m = handModel(s), out = String(renderHand(m));
    for (const id of ['march', 'dissolve']) assert.match(button(out, id), /\boff\b[^>]*aria-disabled="true"|aria-disabled="true"/, `${id} refused (march open=${marchOpen})`);
    // (fix-loop5 L5-8: a closed march says the march lane's own reason, not "not yet in local play"; Dissolve keeps it)
    assert.equal(m.buttons.find(b => b.id === 'march').why, MARCH_CLOSED);
    // (more than one button refused for one reason: the bar says it once, on its own line, as it does for any shared reason)
    // (B6: named by the refused buttons' own words, in the bar's order)
    const off = m.buttons.filter(b => b.why === say).map(b => `“${b.word}”`);
    assert.ok(off.includes('“Dissolve”') && !off.includes('“March”'), off.join());
    assert.ok(out.includes(`<p class="hand-note hand-note-why">${MARCH_CLOSED} In local play, ${off.join(', ')} cannot be sent yet (read only).</p>`), 'said once on the bar, naming them');
  }
  // (the keeps button follows this host's own march answer, as March does: a march on a keep is now composed from the
  //  host's own village — round 28; it followed the page-wide answer in round 27)
  assert.match(readFileSync(new URL('../../permutation-server/web/frontier/hud/hand.mjs', import.meta.url), 'utf8'), /why: r\.inTransit \? mc\.text : mLocal \? localMarchWhy\(FS, r\) : null, tone: waitOf\(FS, r\)/);
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
  assert.equal(c.buttons.find(b => b.id === 'march').why, MARCH_CLOSED, 'refused as its send would refuse it (fix-loop5 L5-8: by its reason)');
  // without the per-host answer (an older page), the page-wide one, as before
  assert.equal(handModel(state({ localPlay: LOCAL, marchOpen: false })).buttons.find(b => b.id === 'march').why, MARCH_CLOSED);
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
    assert.equal((out.match(/<p class="hand-note hand-note-why">[^<]*In local play, [^<]* cannot be sent yet \(read only\)\.<\/p>/g) ?? []).length, 1, 'said once on the bar');
    assert.equal((out.match(/In local play, this order cannot be sent yet \(read only\)\.<\/p>/g) ?? []).length, 0, 'B6: the bar never says "this order" without naming it');
  }
  // the controller gives the bar the same computation the send reads (localMarchView is localMarchFor of the composed order)
  const c = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
  assert.match(c, /function localMarchView\(\) \{\n  if \(!localPlay\) return null;\n  const h = FS\.compose\?\.holding \? holdingByRef\(FS\.holdings, FS\.compose\.holding\) : activeHolding\(FS\);\n  return localMarchFor\(h, FS\.compose\?\.host\?\.id \?\? null\);\n\}/);
  assert.match(c, /Object\.defineProperty\(FS, 'localMarchFor', \{ configurable: true, enumerable: false, value: \(holding, hostId\) => localMarchFor\(holding \? holdingByRef\(FS\.holdings, holding\) : null, hostId\) \}\);/);
});

test('round 27, end to end with the real gate and the real sender: the bar refuses March for the host whose own march is held, not for another', () => {
  setLang('en');
  const say = 'In local play, this order cannot be sent yet (read only).';
  const WALLET = 'BbPGAbHDvV5U43zQ5E8FmSnEzZ7r2vwWAZWTNAPTTSUT', ORIGIN = 'http://localhost:41926', INST = 'ab'.repeat(32), gate = { ok: true, relay: ORIGIN };
  const sender = M.createLocalMarchSender({ allowed: () => gate, open: () => true, identity: () => null, rulesetHash: () => null, signer: () => null });
  const marchFor = (holding, hostId) => M.localMarchOpen({ capability: { wallet: WALLET, instance: INST, trial: true, relay: ORIGIN }, wallet: WALLET, instance: INST, gate,
    holding: holding ? { p: holding.p, q: holding.q, site: holding.site } : null, held: sender.held(hostId ?? null), trialEntry: true });
  const s0 = state({ localPlay: LOCAL, marchOpen: false, marchFor }), host = s0.hand.host;
  // nothing held: this host's March is open (the page-wide answer, closed here, is not what decides it)
  assert.equal(handModel(s0).buttons.find(b => b.id === 'march').why, null);
  // this host's own sent march is held (outcome unknown): refused, as its send would refuse it
  sender.storage.set(sender.bookKey, JSON.stringify([{ host, state: 'sent', signature: 'sigA' }]));
  assert.equal(handModel(state({ localPlay: LOCAL, marchOpen: false, marchFor })).buttons.find(b => b.id === 'march').why, MARCH_HELD, 'fix-loop5 L5-8: said as held');
  // another host's held march does not refuse this one
  sender.storage.set(sender.bookKey, JSON.stringify([{ host: '999', state: 'sent', signature: 'sigB' }]));
  assert.equal(handModel(state({ localPlay: LOCAL, marchOpen: false, marchFor })).buttons.find(b => b.id === 'march').why, null);
});

test('round 28: the keeps button asks the same per-host answer as March (a march on a keep is composed from the host\'s own village)', () => {
  setLang('en');
  const say = 'In local play, this order cannot be sent yet (read only).';
  const keeps = s => handModel(s).buttons.find(b => b.id === 'keeps');
  // (only where the state offers the button at all; the model's own condition decides that)
  const k0 = keeps(state({ localPlay: LOCAL, marchOpen: false, marchFor: () => ({ open: true }) }));
  assert.ok(k0, 'the keeps button is offered in this state');
  assert.equal(k0.why, null, 'page-wide closed, this host open: not refused');
  assert.equal(keeps(state({ localPlay: LOCAL, marchOpen: true, marchFor: () => ({ open: false }) })).why, MARCH_CLOSED, 'page-wide open, this host closed: refused');
  assert.notEqual(keeps(state({})).why, say, 'an ordinary session: not this reason');
});

test('round 31: "the province has not caught up" said by one button alone goes to the bar\'s line; the button keeps its figure (its width does not follow the catch-up)', () => {
  setLang('en');
  const behind = s => { s.provinces.get('2,0').province.resolvedNext = s.nowBell - 3; return s; };
  const reason = 'This province is still resolving the last turn.';
  // local play, march open: Dissolve's refusal is local play's own, so March alone has the province reason
  const m = handModel(behind(state({ localPlay: LOCAL, marchOpen: true, marchFor: () => ({ open: true }) })));
  const march = m.buttons.find(b => b.id === 'march');
  assert.equal(march.why, reason, 'March is refused for it');
  assert.equal(march.said, true, 'said on the bar, not in the button');
  assert.ok(String(m.note).startsWith(reason), `the bar's line says it: ${m.note}`);
  const out = String(renderHand(m));
  assert.doesNotMatch(button(out, 'march') + out.slice(out.indexOf('hand-march'), out.indexOf('hand-march') + 600), /class="hand-why">This province/, 'not inside the button');
  // in step: no such line, the same button shows its figure as before
  const n = handModel(state({ localPlay: LOCAL, marchOpen: true, marchFor: () => ({ open: true }) }));
  assert.equal(n.buttons.find(b => b.id === 'march').why, null);
  assert.doesNotMatch(String(n.note ?? ''), /still resolving/);
  // an ordinary session is as before (there the reason is already shared by March and Dissolve)
  const o = handModel(behind(state({})));
  assert.ok(String(o.note).startsWith(reason));
});
