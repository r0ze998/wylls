// devnet-page-war-2 (§6.5 of devnet-page-war): on a verified devnet season the march card no longer stands disabled while
// the page's own read of the home province (the herald's fold) lags the chain — in real time on devnet. With the connected
// wallet (controller.mjs `marchWaitOn`, `FS.marchWaitOn`), a press while ONLY the province's settling blocks the order arms
// ONE waiting send of that exact order (flocalplay-pending.mjs, the same driver as local play's test march and #117's
// pattern): it re-reads the province (one read at a time, at most every DEVNET_WAIT_REFRESH_MS), sends once when every
// check passes — the wallet signs then —, or withdraws and says why. Nothing is signed or sent while it waits.
// Pure rendering and the pure driver; no key, no process, no network.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLang, L } from '../../permutation-server/web/lang.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { baseProduction } from '../../permutation-server/web/frontier/fland.mjs';
import { KEEP_4_M1, STANDINGS_BEFORE, keepAt, recordAt } from '../../permutation-server/web/frontier/hud/handdemo-data.mjs';
import { render as marchCard } from '../../permutation-server/web/frontier/hud/marchcard.mjs';
import * as P from '../../permutation-server/web/frontier/flocalplay-pending.mjs';
import { tipOptions } from '../../permutation-server/web/frontier/fmarch.mjs';
afterEach(() => setLang('ja'));
const CJK = /[\u3040-\u30ff\u3400-\u9fff]/;
const BANNED_EN = /\bbell \d|\bsecret|beacon|\bsettle[ds]?\b|settlement|\bseed\b|site ticket|keeper|lamport/i;
const HOME = (extra = {}) => ({ p: 2, q: 0, site: 2, gen: 0, tile: 20, faction: 0, state: 2, order: 1, tier: 0, flags: 0, production: baseProduction(0), upkeep: Array(8).fill(0n), stores: [], reserve: Array(8).fill(0), queue: [],
  transit: [{ state: 0 }], explore: { state: 0 }, lastOwnerAction: 1000n, finalTs: 1n, shieldUntil: 0n, ...extra });
const entry = (extra = {}) => ({ id: hostId({ p: 2, q: 0, site: 2, gen: 0, seq: 1 }), unit: 0, state: 1, tile: 20, troops: 500000, staminaValue: 120, staminaBell: 10, readyBell: 10, pendOp: 0, fromBell: 10, ...extra });
const SEASON = { programVersion: 3, layoutVersion: 2, endBell: 96, bellSecs: 600, dormantAfterSecs: 86400, releaseAfterSecs: 172800, minLead: 2, maxLead: 72, conquestParams: { keepBells: 72 },
  minRevealPriorityMilli: 1000, revealCuLimit: 200000, revealLoadedLimit: 64000, marchFee: 0n, sealBond: 0n };
const fs = ({ bell = 10, entries = [entry()], resolvedNext = bell, extra = {} } = {}) => ({ mode: 'play', season: SEASON, citizen: { faction: 0 }, holdings: [HOME()], nowBell: bell, chain: { now: () => 1000 }, land: { stage: 'final' }, inFlight: 0,
  provinces: new Map([['2,0', { province: { p: 2, q: 0, resolvedNext, entries, ticketCohorts: [] } }]]),
  conquest: { status: 'ready', keeps: new Map([['4,-1', keepAt(KEEP_4_M1, bell)]]), history: new Map([['4,-1', recordAt(KEEP_4_M1, bell)]]), standings: STANDINGS_BEFORE, final: null, events: [] }, ...extra });
const route = (hexes, provinces, secs) => ({ hexes, provinces: Array.from({ length: provinces }, (_, i) => i), secs });
const LOCAL = Object.freeze({ address: 'W', programId: 'P', seasonAddress: 'S', cluster: 'localnet' });
// the province is at turn 10 while the world is at turn 12: behind
const LATE = { bell: 12, resolvedNext: 10 };
const withCompose = s => { const k = s.conquest.keeps.get('4,-1');
  s.compose = { holding: s.holdings[0], host: { ...entry(), troops: 500, tile: 20, unit: 0 }, origin: { p: 2, q: 0 }, stance: 1, retreat: 'never', ratio: null, tip: '0', quick: [], dest: { p: 4, q: -1, tile: k.tile }, route: { ...route(13, 3, 1800), dirs: [] }, arriveBell: s.nowBell + 2 }; return s; };
const TRIAL = { localPlay: { ...LOCAL, march: { trialEntry: true }, worldEndsAt: 9e15 }, localMarch: { open: true } };
const card = s => String(marchCard(withCompose(s)));
const footer = m => /<footer class="order-foot">[\s\S]*?<\/footer>/.exec(m)?.[0] ?? '';
// the footer's action buttons (after the order's summary line), in order: act and whether it is off
const acts = f => [...(/<div class="actions order-acts">[\s\S]*$/.exec(f)?.[0] ?? '').matchAll(/<button type="button" class="([^"]*)" data-act="([^"]+)"([^>]*)>/g)].map(x => `${x[2]}${/disabled/.test(x[3]) ? ':off' : ''}`);
const shape = f => acts(f).map(a => a.replace(':off', ''));

// (a whole order: a one-step path and the lowest preset tip, so that only the settling can block it)
const valid = s => { withCompose(s); s.compose.route = { ...s.compose.route, dirs: [0], provinces: [{ p: 2, q: 0 }, { p: 4, q: -1 }] }; s.compose.tip = String(tipOptions(SEASON)[0].lamports); return s; };
const vcard = s => String(marchCard(valid(s)));
const DEVNET = { devnetPlay: { relay: 'http://127.0.0.1:41575', seasonId: '1' }, marchWaitOn: true, localPlay: null };
const src = name => readFileSync(new URL(`../../permutation-server/web/frontier/${name}`, import.meta.url), 'utf8');

test('devnet page: the card waits instead of standing disabled while the home read lags — one footer shape, the main button on', () => {
  const ready = footer(vcard(fs({ extra: DEVNET })));
  const lagging = footer(vcard(fs({ ...LATE, extra: DEVNET })));
  const s = valid(fs({ ...LATE, extra: DEVNET })); s.compose.pending = { intent: 'x', armedBell: 12, untilBell: 14 };
  const waiting = footer(String(marchCard(s)));
  for (const f of [ready, lagging, waiting]) {
    assert.deepEqual(shape(f), ['march-send-wait', 'march-wait-cancel', 'compose-close'], 'the same buttons in the same places');
    assert.match(f, /class="order-irrev order-devnet-rule"/, 'the devnet line: the wallet signs only when it sends');
    assert.doesNotMatch(f, /data-act="march-send"[ >]/);
  }
  assert.deepEqual(acts(lagging), ['march-send-wait', 'march-wait-cancel:off', 'compose-close'], 'the home read lags (NotResident): the main button is ON');
  assert.deepEqual(acts(waiting), ['march-send-wait:off', 'march-wait-cancel', 'compose-close'], 'waiting: main off, cancel on (no second press, no spam)');
  // the same card without the devnet lane (an ordinary page): the seal stays disabled while the province lags, as before
  const general = footer(vcard(fs({ ...LATE })));
  assert.deepEqual(acts(ready), ['march-send-wait', 'march-wait-cancel:off', 'compose-close'], 'ready: on');
  assert.deepEqual(acts(general), ['march-send:off', 'compose-close']);
});

test('devnet page: a problem that is not the settling still blocks (the waiting send is only for NotResident / NotFinal)', () => {
  const s = valid(fs({ extra: DEVNET, entries: [entry({ readyBell: 50 })] })); s.compose.host = { ...s.compose.host, readyBell: 50 };
  const f = footer(String(marchCard(s)));
  assert.equal(acts(f)[0], 'march-send-wait:off', 'Cooldown: not pendable, the main button is off');
  assert.equal(P.pendable(['NotResident']), true); assert.equal(P.pendable(['NotResident', 'Cooldown']), false);
});

test('the driver on a devnet look: waits while only the settling blocks, sends ONCE when the read catches up, reads are bounded', async () => {
  let t = 0, timer = null; const sent = [], withdrawn = [];
  let problems = ['NotResident'], reads = 0;
  const intent = P.intentOf({ world: 'devnet:http://127.0.0.1:41575:1', wallet: 'W', holding: { p: 2, q: 0, site: 2, gen: 0 }, host: { id: 7n, troops: 400, unit: 0, tile: 20 }, origin: { p: 2, q: 0 },
    m: { route: { dirs: [1, 2], provinces: [{ p: 2, q: 0 }] }, dest: { p: 2, q: 0, tile: 30 }, arriveBell: 21, stance: 0, retreat: { choice: 'never', ratio: null }, tip: 1000n } });
  assert.ok(intent, 'a devnet world id makes an intent');
  assert.equal(P.intentOf({ world: null, wallet: 'W', holding: {}, host: {}, origin: {}, m: {} }), null, 'no world: nothing can be armed');
  // the controller's devnet refresh: at most one herald read per DEVNET_WAIT_REFRESH_MS (5 s), whatever the driver's tick
  let last = -Infinity;
  const refresh = () => { if (t - last < 5_000) return Promise.resolve(); last = t; reads += 1; return Promise.resolve(); };
  const d = P.createPendingDriver({
    look: () => ({ intent, problems, nowBell: 19, open: true, held: false, busy: false, sameCard: true, keyAlive: true, endsAt: 1e15 }),
    refresh, send: () => sent.push(t), withdrawn: (_c, why) => withdrawn.push(why), now: () => t,
    setTimer: f => { timer = f; return 1; }, clearTimer: () => { timer = null; },
  });
  assert.equal(d.arm({ id: 'card' }, P.armPending({ intent, nowBell: 19 })), true);
  const flush = () => new Promise(r => setImmediate(r));
  for (; t < 120_000; t += 100) { timer?.(); await flush(); }
  assert.equal(sent.length, 0, 'nothing sent while the home read lags');
  assert.ok(reads <= 25 && reads >= 20, `about one read per 5 s over 2 min, not one per tick: ${reads}`);
  problems = [];
  timer?.();
  assert.equal(sent.length, 1, 'sent once the read caught up');
  for (let i = 0; i < 50; i++) timer?.();
  assert.equal(sent.length, 1, 'never twice');
  assert.deepEqual(withdrawn, []);
});

test('the controller: the devnet lane arms through the same driver; the wallet signs only in the ordinary send', () => {
  const c = src('controller.mjs');
  assert.match(c, /const devnetMarchWait = \(\) => !localPlay && !!devnetPlay && devnetGate\(\)\.ok === true;/);
  assert.match(c, /const world = localPlay \? localPlay\.march\?\.instance \?\? null : devnetPlay \? `devnet:\$\{devnetPlay\.relay\}:\$\{devnetPlay\.seasonId\}` : null;/);
  assert.match(c, /Object\.defineProperty\(FS, 'marchWaitOn', \{ configurable: true, enumerable: false, get: marchWaitOn \}\);/);
  assert.match(c, /send: card => \{ card\.pending = null; FS\.lastAct = \{ kind: 'act', name: 'march-send', data: \{\} \}; return sendTheMarch\(\); \},/, 'the send is the ordinary single send (the devnet sender, one wallet signature)');
  const block = c.slice(c.indexOf('const localMarchTrial = '), c.indexOf('async function sendTheMarch()'));
  assert.doesNotMatch(block, /sign[T]ransaction|send[T]ransaction|\/f\/devnet-play/, 'nothing in the wait signs or sends');
});

test('JA/EN: the devnet waiting texts', () => {
  const ja = [L`このページが読む州の決着が遅れていても、押せば待ちます。送るときにだけウォレットが署名を求めます。待っているあいだは何も署名せず、何も送りません。`,
    L`送信待ちです。このページが読む州のターンの決着が追いつき次第、この命令を1回だけ送ります。そのときウォレットが署名を求めます（ターン ${14} まで。取り消せます）。`,
    L`この州の決着の読み取りが ${3} ターン遅れています（世界の進行とこのページの読み取り先が追いつくのを待っています）。送信待ちはそのまま続け、州が追いつき次第${L`この命令`}を1回だけ送ります。そのときウォレットが署名を求めます。押し直す必要はありません（取り消せます）。`];
  for (const x of ja) assert.match(x, CJK);
  setLang('en');
  const en = [L`このページが読む州の決着が遅れていても、押せば待ちます。送るときにだけウォレットが署名を求めます。待っているあいだは何も署名せず、何も送りません。`,
    L`送信待ちです。このページが読む州のターンの決着が追いつき次第、この命令を1回だけ送ります。そのときウォレットが署名を求めます（ターン ${14} まで。取り消せます）。`,
    L`この州の決着の読み取りが ${3} ターン遅れています（世界の進行とこのページの読み取り先が追いつくのを待っています）。送信待ちはそのまま続け、州が追いつき次第${L`この命令`}を1回だけ送ります。そのときウォレットが署名を求めます。押し直す必要はありません（取り消せます）。`];
  for (const x of en) { assert.doesNotMatch(x, CJK, x); assert.doesNotMatch(x, BANNED_EN, x); }
  assert.match(en[1], /until turn 14/); assert.match(en[2], /3 behind/);
});
