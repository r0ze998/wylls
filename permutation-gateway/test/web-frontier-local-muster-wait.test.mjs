// TEST-ONLY local play, round 21: the village's Form a host card opens at any time, and in local play ONE press on its
// confirm sends the muster now or arms ONE waiting send of the exact muster shown (flocalplay-muster-wait.mjs; controller.mjs
// armMusterWait / musterDriver; hud/hand.mjs). Found in a recorded ×30 two-person world (2026-11-14): the bar's button was
// refused about half of each turn, and one muster was refused by the program (NotResident) after being sent as the turn
// changed. Nothing is loosened: the program's own check is the gate; the same single local send; the same key. These tests
// hold the negative cases: never twice, never after an unknown outcome, never after a cancel, a change, its turn limit, or
// a closed gate; never under another world (another runner instance on the same Season, another relay, another key, another
// herald); never for a village other than the one frozen; never outside local play.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLang, L } from '../../permutation-server/web/lang.mjs';
import * as M from '../../permutation-server/web/frontier/flocalplay-muster-wait.mjs';
import * as P from '../../permutation-server/web/frontier/flocalplay-pending.mjs';

afterEach(() => setLang('ja'));
const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);
const src = f => readFileSync(new URL(f, WEB), 'utf8');
const CJK = /[぀-ヿ㐀-鿿]/;
const BANNED_EN = /\bbell \d|\bsecret|beacon|\bsettle[ds]?\b|settlement|\bseed\b|site ticket|keeper|lamport/i;

const H = { p: 1, q: 1, site: 3, gen: 0, tile: 41 };
const base = () => ({ world: 'scope-A|inst-1', wallet: 'Wallet1111', holding: { ...H }, draft: { unit: 0, troops: 500, tile: 41 } });

test('the muster\'s identity covers the world, the key, the village and its generation, and every field sent; anything missing gives none', () => {
  const a = M.musterIntentOf(base());
  assert.equal(typeof a, 'string');
  const mutate = [x => { x.world = 'scope-A|inst-2'; }, x => { x.world = 'scope-B|inst-1'; }, x => { x.wallet = 'Wallet2222'; }, x => { x.holding = { ...x.holding, site: 4 }; },
    x => { x.holding = { ...x.holding, gen: 1 }; }, x => { x.holding = { ...x.holding, p: 2 }; }, x => { x.draft = { ...x.draft, unit: 1 }; }, x => { x.draft = { ...x.draft, troops: 499 }; }, x => { x.draft = { ...x.draft, tile: 42 }; }];
  for (const [i, f] of mutate.entries()) { const b = base(); f(b); assert.notEqual(M.musterIntentOf(b), a, `field ${i}`); }
  // the village's own tile when the card names none
  { const b = base(); b.draft = { ...b.draft, tile: null }; assert.equal(M.musterIntentOf(b), a); }
  for (const f of [x => { x.world = ''; }, x => { x.wallet = null; }, x => { x.holding = null; }, x => { x.draft = null; }, x => { x.draft.unit = null; }, x => { x.draft.troops = 0; }, x => { x.holding.site = undefined; }])
    { const b = base(); f(b); assert.equal(M.musterIntentOf(b), null); }
});

test('the turn\'s last moments: a real-time guard on the chain\'s clock; unknown → treated as the end (never a send on a guess)', () => {
  // ×30: a 600 s turn is 20 real seconds
  const at = into => M.nearTurnEnd({ genesisTs: 1000, nowTs: 1000 + 600 * 7 + into, bellSecs: 600, rate: 30 });
  assert.equal(at(0), false); assert.equal(at(300), false);
  assert.equal(at(600 - 46), false, '1.53 s left'); assert.equal(at(600 - 44), true, '1.47 s left'); assert.equal(at(599), true);
  // natural time: the last 1.5 s of a 10-minute turn
  assert.equal(M.nearTurnEnd({ genesisTs: 0, nowTs: 598, bellSecs: 600, rate: 1 }), false);
  assert.equal(M.nearTurnEnd({ genesisTs: 0, nowTs: 599, bellSecs: 600, rate: 1 }), true);
  for (const bad of [{ genesisTs: NaN, nowTs: 1, bellSecs: 600 }, { genesisTs: 0, nowTs: 1, bellSecs: 0 }, { genesisTs: 5, nowTs: 1, bellSecs: 600 }, { genesisTs: 0, nowTs: 1, bellSecs: 600, rate: 0 }])
    assert.equal(M.nearTurnEnd(bad), true);
  assert.equal(M.TURN_END_GUARD_MS, 1500);
  // (it is said for what it is: fewer refusals, not a promise of the turn the send lands in)
  assert.match(src('flocalplay-muster-wait.mjs'), /it does NOT promise the turn it lands in/);
});

test('one press: ready and not at the turn\'s end → sent now; only the province finishing its turn (or the turn\'s end) → wait; anything else → nothing', () => {
  const s = P.SETTLE_CODES;
  assert.equal(M.musterPress({ problems: [], nearEnd: false, settleCodes: s }), 'send');
  assert.equal(M.musterPress({ problems: [], nearEnd: true, settleCodes: s }), 'wait');
  assert.equal(M.musterPress({ problems: ['NotResident'], nearEnd: false, settleCodes: s }), 'wait');
  assert.equal(M.musterPress({ problems: ['NotFinal', 'NotResident'], nearEnd: true, settleCodes: s }), 'wait');
  for (const bad of [['NoReserve'], ['HoldingMismatch'], ['NotResident', 'Insufficient'], ['HostBusy'], null, undefined]) assert.equal(M.musterPress({ problems: bad, nearEnd: false, settleCodes: s }), null, JSON.stringify(bad));
});

// the world and key as frozen, and as they may be later
const herald = { name: 'herald-1' }, lp = { address: 'Wallet1111', programId: 'Prog1111', seasonAddress: 'Season111' }, signer = { handle: 1 };
const id = (over = {}) => ({ scope: JSON.stringify(['Wallet1111', 'Prog1111', 'Season111', 'http://127.0.0.1:41987']), instance: 'inst-1', herald, localPlay: lp, signer, wallet: 'Wallet1111', ...over });
const card = () => ({ intent: 'I', identity: id(), holding: { ...H }, draft: { unit: 0, troops: 500, tile: 41 } });
const now = (over = {}) => ({ identity: id(), open: true, pop: 'muster', intent: 'I', holding: { ...H }, active: { ...H }, ...over });

test('right before the send: the same world, key, card, muster and village, or it is withdrawn — and why', () => {
  assert.equal(M.stillSame(card(), now()), null);
  // another world: a restarted world on the same Season (another runner instance), another relay, another key handle,
  // another wallet, another herald connection, another local-play identity object — all 'closed', never sent
  for (const [name, over] of [['same Season, restarted world', { instance: 'inst-2' }], ['another relay', { scope: JSON.stringify(['Wallet1111', 'Prog1111', 'Season111', 'http://127.0.0.1:41992']) }],
    ['another Season', { scope: JSON.stringify(['Wallet1111', 'Prog1111', 'Season222', 'http://127.0.0.1:41987']) }], ['another key handle', { signer: { handle: 1 } }],
    ['another wallet', { wallet: 'Wallet2222' }], ['another herald', { herald: { name: 'herald-1' } }], ['another local-play identity', { localPlay: { ...lp } }]])
    assert.equal(M.stillSame(card(), now({ identity: id(over) })), 'closed', name);
  assert.equal(M.stillSame(card(), now({ identity: null })), 'closed', 'no world (gate closed)');
  // the card closed / changed
  assert.equal(M.stillSame(card(), now({ open: false, pop: null })), 'cancel');
  assert.equal(M.stillSame(card(), now({ open: false, pop: 'muster' })), 'changed');
  assert.equal(M.stillSame(card(), now({ intent: 'J' })), 'changed', 'troops/unit/tile');
  // the village: the card's (the selection's) and the active one (the one an order is sent for) must both be the frozen one
  assert.equal(M.stillSame(card(), now({ holding: { ...H, site: 4 } })), 'changed', 'another village selected');
  assert.equal(M.stillSame(card(), now({ active: { ...H, site: 4 } })), 'changed', 'the selected and the active village differ');
  assert.equal(M.stillSame(card(), now({ holding: { ...H, gen: 1 }, active: { ...H, gen: 1 } })), 'changed', 'a new generation of the village');
  assert.equal(M.stillSame(null, now()), 'closed');
  // the identity comparators themselves
  assert.equal(M.sameWorld(id(), id()), true); assert.equal(M.sameWorld(id({ signer: null }), id({ signer: null })), false, 'no key, no world');
  assert.equal(M.sameHolding({ ...H }, { ...H, tile: 9 }), true, 'the tile is not the village\'s identity');
});

// the shared driver, with a muster-shaped look (the controller's look returns these fields)
function rig(state) {
  const sends = [], withdrawn = [], timers = new Map(); let tid = 0, t = 0, hide = null;
  const d = P.createPendingDriver({
    look: () => ({ ...state }),
    refresh: () => Promise.resolve(),
    send: c => { sends.push(c); },
    withdrawn: (c, why) => { withdrawn.push(why); },
    now: () => t, setTimer: f => { timers.set(++tid, f); return tid; }, clearTimer: i => { timers.delete(i); },
    onPageHide: f => { hide = f; return () => { hide = null; }; },
  });
  return { d, sends, withdrawn, tick: () => d.tick(), timers, hidePage: () => hide?.(), advance: ms => { t += ms; } };
}
const ready = (over = {}) => ({ intent: 'I', problems: [], nowBell: 10, open: true, held: false, busy: false, sameCard: true, keyAlive: true, endsAt: 1e12, ...over });

test('driver (muster): waits through the province finishing its turn and the turn\'s last moments, then sends exactly once', () => {
  const s = ready({ problems: ['NotResident'] }), r = rig(s);
  assert.equal(r.d.arm({ c: 1 }, P.armPending({ intent: 'I', nowBell: 10 })), true);
  assert.equal(r.d.arm({ c: 2 }, P.armPending({ intent: 'I', nowBell: 10 })), false, 'a second arming is refused while one waits');
  r.tick(); assert.deepEqual(r.sends, []);
  Object.assign(s, { problems: [], busy: true });   // ready, but within the turn's last moments
  r.tick(); assert.deepEqual(r.sends, [], 'not at the turn\'s end');
  Object.assign(s, { busy: false });
  r.tick(); assert.equal(r.sends.length, 1, 'sent once');
  r.tick(); r.tick(); assert.equal(r.sends.length, 1, 'never twice');
  assert.equal(r.timers.size, 0, 'the timer is released'); assert.deepEqual(r.withdrawn, []);
});

test('driver (muster): an unknown earlier outcome, a cancel, a change, the turn limit, a closed gate, another world, the page hidden — withdrawn, never sent', () => {
  const cases = [
    ['unknown', s => { s.held = true; }], ['changed', s => { s.intent = 'J'; }], ['changed', s => { s.sameCard = false; }], ['expired', s => { s.nowBell = 13; s.problems = ['Cooldown']; s.problems = []; }],
    ['closed', s => { s.open = false; }], ['closed', s => { s.keyAlive = false; }], ['closed', s => { s.endsAt = 0; }], ['problem', s => { s.problems = ['NoReserve']; }],
  ];
  for (const [why, change] of cases) {
    const s = ready({ problems: ['NotResident'] }), r = rig(s);
    r.d.arm({}, P.armPending({ intent: 'I', nowBell: 10 })); change(s); s.problems = s.problems.length ? s.problems : []; r.tick();
    assert.deepEqual(r.withdrawn, [why], why); assert.deepEqual(r.sends, []);
    Object.assign(s, ready()); r.tick(); assert.deepEqual(r.sends, [], `${why}: nothing after the withdrawal`);
  }
  { const s = ready({ problems: ['NotResident'] }), r = rig(s); r.d.arm({}, P.armPending({ intent: 'I', nowBell: 10 })); r.d.cancel('cancel'); Object.assign(s, ready()); r.tick(); assert.deepEqual(r.withdrawn, ['cancel']); assert.deepEqual(r.sends, []); }
  { const s = ready({ problems: ['NotResident'] }), r = rig(s); r.d.arm({}, P.armPending({ intent: 'I', nowBell: 10 })); r.hidePage(); Object.assign(s, ready()); r.tick(); assert.deepEqual(r.withdrawn, ['closed']); assert.deepEqual(r.sends, []); }
});

test('the controller: the identity frozen at arming is checked at every look, in each read, and right before the send; the frozen village is sent for', () => {
  const c = src('controller.mjs');
  const block = c.slice(c.indexOf('function musterIdentity()'), c.indexOf('/** (tests) The muster\'s waiting send'));
  // the frozen world and key
  assert.match(block, /const scope = localAct\.localActScope\(\{ identity: localPlay, relay: g\.relay \}\);/);
  assert.match(block, /return Object\.freeze\(\{ scope, instance: localPlay\.march\?\.instance \?\? null, herald, localPlay, signer: currentEphemeralWallet\(\) \?\? null, wallet: FS\.wallet\?\.address \?\? null \}\);/);
  assert.match(block, /musterIntentOf\(\{ world: `\$\{id\.scope\}\|\$\{id\.instance \?\? ''\}`, wallet: id\.wallet, holding: h, draft \}\)/);
  // the look: another world → not open (withdrawn 'closed'); the card's village
  assert.match(block, /const n = musterNow\(\), same = sameMusterIdentity\(card\.identity, n\.identity \?\? null\);/);
  assert.match(block, /open: same && !FS\.resident/);
  assert.match(block, /sameCard: n\.open && sameHolding\(card\.holding, n\.holding\)/);
  // the read: applied only under the frozen identity (not the one current when the read began)
  assert.match(block, /const still = \(\) => sameMusterIdentity\(card\.identity, musterIdentity\(\)\) && FS\.wallet\?\.destroyed !== true && musterDriver\.armed === card;/);
  // right before the send: checked again; the frozen village is passed
  assert.match(block, /send: card => \{\n\s+FS\.musterWait = null;\n\s+const why = musterStillSame\(card\);\n\s+if \(why\) \{ setNotice\(\{ busy: false, text: MUSTER_WITHDRAWN\[why\]\(\), unsent: 'muster', retry: false \}\); return null; \}/);
  assert.match(block, /return musterOrder\(card\.draft\.unit, card\.draft\.troops, card\.draft\.tile, card\.holding\);/);
  // the card's village must be the active one, or nothing is offered
  assert.match(block, /!sameHolding\(h, activeHolding\(FS\)\) \? \['HoldingMismatch'\]/);
  // an ordinary press when ready is sent for the card's own village too; an unknown earlier muster blocks arming
  assert.match(block, /if \(press === 'send'\) \{ FS\.lastAct = musterLastAct\(n\.draft\); return musterOrder\(n\.draft\.unit, n\.draft\.troops, n\.draft\.tile, n\.holding\); \}/);
  assert.match(block, /if \(press !== 'wait' \|\| musterHeld\(\)\) return;/);
  // no timer of its own; the send is the ordinary order (act → the local path, held by its signature when unknown)
  assert.doesNotMatch(block, /setInterval|setTimeout|localAct\.send|sendTransaction/);
  assert.match(c, /function musterOrder\(unit, troops, tile = null, holding = null\) \{\n\s+const h = holding \? holdingByRef\(FS\.holdings, holding\) : activeHolding\(FS\);\n\s+if \(holding && !sameHolding\(h, holding\)\) return failed\(\{ code: 'NotOwner' \}\);\n\s+const at = Number\.isInteger\(tile\) \? tile : h\?\.tile;/);
  assert.match(c, /return act\('Muster', \{ v: \{ holding: h \}/);
  assert.match(c, /'muster-send-wait': \(\) => armMusterWait\(\),\n\s+'muster-wait-cancel': \(\) => musterDriver\.cancel\('cancel'\),/);
});

test('the card and the bar: Form a host always opens its card; local play offers the waiting send only for the province finishing its turn; an ordinary session is as before', () => {
  const h = src('hud/hand.mjs');
  assert.match(h, /const off = !!b\.why && !b\.opens;/);
  assert.match(h, /\{ id: 'muster', icon: 'ranks', word: L`編成`, act: 'hand-pop', data: \{ pop: 'muster' \}, figure: L`最大 \$\{fmtNum\(musterable\)\}人`, opens: true,/);
  assert.match(h, /const waitable = local && d\.unit !== null && d\.max >= HOST_TROOPS\.min && blocks\.length > 0 && blocks\.every\(c => SETTLE_CODES\.includes\(c\)\);/);
  assert.match(h, /data-act="\$\{local \? 'muster-send-wait' : 'muster'\}"/);
  assert.match(h, /\$\{raw\(why && !waitable \? 'aria-disabled="true"' : ''\)\}/);
  assert.match(h, /data-act="muster-wait-cancel">\$\{L`送信待ちを取り消す`\}/);
});

test('English: every new text, no Japanese, no banned word', () => {
  setLang('en');
  const texts = [
    L`送信待ちを取り消しました。編成の内容（兵種・兵数・場所）が変わったためです。命令は送られていません。確かめてから、もう一度押してください。`,
    L`送信待ちを取り消しました。この世界ではいま編成を送れません。命令は送られていません。`,
    L`編成の送信待ちです。州のターンの決着がつき次第、この編成を1回だけ送ります（ターン ${12} まで。取り消せます）。`,
    L`送信待ち：州のターンの決着がつき次第、この編成を1回だけ送ります（ターン ${12} まで）。兵種・兵数・場所が変わったら、送らずに取り消します。`,
    L`${'This province is still resolving the last turn.'} 押すと、整い次第この編成を1回だけ送ります（兵種・兵数・場所が変わったら送らずに取り消します）。`,
  ];
  for (const t of texts) { assert.doesNotMatch(t, CJK, t); assert.doesNotMatch(t, BANNED_EN, t); assert.match(t, /\bhost\b/, t); }
});
