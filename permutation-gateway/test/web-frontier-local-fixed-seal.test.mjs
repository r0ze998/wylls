// The order card's footer on local play's test march stays one shape (round 12, 2026-11-14). In a ×30 two-person world a
// press aimed at 「決着を待って送る」 landed on the warning line when the turn finished (they swapped places), and a press on
// the seal found it disabled a moment later. Now, on that march only, the footer is always: ONE main button
// 「確認した命令で出発」 (the same handler as before: ready → the ordinary single send; only the province finishing its turn →
// the waiting send of this same order), its cancel (off until a send waits), やめる, and one line that always says what a
// press does. The general wallet's card is unchanged. Pure rendering; no key, no process, no network.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLang, L } from '../../permutation-server/web/lang.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { baseProduction } from '../../permutation-server/web/frontier/fland.mjs';
import { KEEP_4_M1, STANDINGS_BEFORE, keepAt, recordAt } from '../../permutation-server/web/frontier/hud/handdemo-data.mjs';
import { render as marchCard } from '../../permutation-server/web/frontier/hud/marchcard.mjs';
afterEach(() => setLang('ja'));
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

test('local test march: one footer shape whatever the state — main, cancel, やめる — and the line that says what a press does', () => {
  const ready = footer(card(fs({ extra: TRIAL })));
  const settling = footer(card(fs({ ...LATE, extra: TRIAL })));
  const s = fs({ ...LATE, extra: TRIAL }); withCompose(s); s.compose.pending = { intent: 'x', armedBell: 12, untilBell: 14 };
  const waiting = footer(String(marchCard(s)));
  for (const f of [ready, settling, waiting]) {
    assert.deepEqual(shape(f), ['march-send-wait', 'march-wait-cancel', 'compose-close'], 'the same buttons in the same places');
    assert.match(f, /class="order-irrev order-local-rule"/, 'the line is always there');
    assert.doesNotMatch(f, /data-act="march-send"[ >]/, 'no second send button to swap with');
  }
  assert.match(ready, /確認した命令で出発/); assert.match(settling, /確認した命令で出発/);
  assert.deepEqual(acts(waiting), ['march-send-wait:off', 'march-wait-cancel', 'compose-close'], 'waiting: main off (送信待ち), cancel on');
  assert.match(waiting, /送信待ち</);
  assert.equal(acts(settling)[1], 'march-wait-cancel:off', 'nothing waits yet: cancel off');
});

test('the general wallet\'s card is unchanged: the seal and its own rule', () => {
  const f = footer(card(fs()));
  assert.deepEqual(shape(f), ['march-send', 'compose-close']);
  assert.match(f, /封をして出発する/);
  assert.doesNotMatch(f, /order-local-rule|確認した命令で出発|march-send-wait/);
  const src = readFileSync(new URL('../../permutation-server/web/frontier/hud/marchcard.mjs', import.meta.url), 'utf8');
  assert.match(src, /data-act="march-send" \$\{raw\(problems\.length \|\| busy \|\| !c\.route \? 'disabled' : ''\)\}/, 'the seal button\'s own rule is untouched');
});

test('the main button is the same handler as before, which looks again at the press', () => {
  const c = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
  assert.match(c, /'march-send-wait': \(\) => armMarchWait\(\),/);
  const arm = c.slice(c.indexOf('function armMarchWait()'), c.indexOf('async function sendTheMarch()'));
  assert.match(arm, /const \{ problems, intent \} = marchNow\(c\);/, 'the order as it is at the press');
  assert.match(arm, /if \(problems\.length === 0\) return sendTheMarch\(\);/, 'ready: the ordinary single send');
  assert.match(arm, /if \(heldNow\(c\) \|\| !pendable\(problems\)\) return;/, 'anything but settling: nothing');
  const card = readFileSync(new URL('../../permutation-server/web/frontier/hud/marchcard.mjs', import.meta.url), 'utf8');
  assert.match(card, /const mainOk = !busy && !waiting && !!c\.route && \(problems\.length === 0 \|\| pendable\(problems\)\);/);
});

test('English: the new texts, no Japanese, no banned word', () => {
  setLang('en');
  const CJK = /[\u3040-\u30ff\u3400-\u9fff]/, BANNED_EN = /\bbell \d|\bsecret|beacon|\bsettle[ds]?\b|settlement|\bseed\b|site ticket|keeper|lamport/i;
  const texts = [L`確認した命令で出発`, L`送信待ち`, L`押すと、送れる状態ならすぐ送ります。州のターンの決着を待っているときは、この同じ命令のまま整い次第1回だけ送ります（到着ターンなどが変わったら送らずに取り消します）。送った命令は取り消せません。取り消せるのは送信待ちのあいだだけです。`];
  for (const t of texts) { assert.doesNotMatch(t, CJK, t); assert.doesNotMatch(t, BANNED_EN, t); }
  const en = String(card(fs({ extra: TRIAL })));
  assert.match(en, /Send this order/); assert.doesNotMatch(footer(en), CJK, 'the English footer has no Japanese');
});
