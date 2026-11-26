// loop-play4's confusing / cosmetic BREAKs (fix-loop4, TEST-only local play): B-7 the in-game key card while a local
// world's rim request settles, B-8 the ×60 picker's confirm kept as the same node, B-11 the "no seal copy" hint in a
// local world, B-12 the turn length on a faster TEST clock. Key-free: no page boot, network, chain or key.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLang, L } from '../../permutation-server/web/lang.mjs';
import * as trackerScreen from '../../permutation-server/web/frontier/screens/tracker.mjs';
import { setTermsPace, turnLine } from '../../permutation-server/web/frontier/seasonterms.mjs';

afterEach(() => { setLang('ja'); setTermsPace(null); });
const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);
const src = f => readFileSync(new URL(f, WEB), 'utf8');
const CJK = /[぀-ヿ㐀-鿿]/;
const BANNED_EN = /\bbell \d|\bsecret|beacon|\bsettle[ds]?\b|settlement|\bseed\b|site ticket|keeper|lamport|runner/i;
const live = { state: 1, hostId: 5n, arriveBell: 43 };

test('B-11: a march with no seal copy here: a local world says its own runner opens it; an ordinary page as before; nothing once open', () => {
  const plain = String(trackerScreen.renderMarch({ entry: null, transit: live, facts: { nowBell: 41, pipeline: 'open' } }));
  assert.match(plain, /この端末には封の控えがありません。封は、到着のターンが終わったあと自動で開けられます。/, 'an ordinary page: unchanged');
  const local = String(trackerScreen.renderMarch({ entry: null, transit: live, facts: { nowBell: 41, pipeline: 'open' } }, { localPlay: { address: 'x' } }));
  assert.doesNotMatch(local, /この端末には封の控えがありません/);
  assert.match(local, /このローカルの世界では、到着のターンが終わると世界の進行役が封を開けます（この端末に封の控えがなくても進みます）。/);
  const opened = String(trackerScreen.renderMarch({ entry: null, transit: live, facts: { nowBell: 44, pipeline: 'revealing', slotPresent: true } }, { localPlay: { address: 'x' } }));
  assert.doesNotMatch(opened, /封の控え/, 'the seal is open: nothing about a copy');
  setLang('en');
  const en = L`このローカルの世界では、到着のターンが終わると世界の進行役が封を開けます（この端末に封の控えがなくても進みます）。`;
  assert.doesNotMatch(en, CJK); assert.doesNotMatch(en, BANNED_EN, en);
});

test('B-7: local play has no in-game key to fix — the key card is never its view (its rim request\'s wait view instead)', () => {
  const join = src('screens/join.mjs');
  // (verify-pr172: devnet play is exempt too — web-frontier-own-wait.test.mjs renders it)
  assert.match(join, /if \(!FS\.resident && !FS\.localPlay && !FS\.devnetPlay && \(!FS\.session \|\| FS\.sessionProblem\)\) return renderSessionFix\(FS\);\n  if \(stage === 'ticket'\) return renderTicket\(FS\);/);
  // (the controller asks for no session in local play either)
  assert.match(src('controller.mjs'), /if \(!localPlay && !devnetPlay && !FS\.resident && \(!FS\.session \|\| FS\.sessionProblem\)\) \{/);
});

test('B-8: the picker\'s confirm, its banners and its blurb are data-stable (kept as the same nodes over a ×60 turn\'s re-render)', () => {
  const join = src('screens/join.mjs');
  assert.match(join, /class="btn primary nc-btn" data-stable="join-go" data-act=/);
  assert.match(join, /<ul class="banners" data-stable="join-banners">/);
  assert.match(join, /<div class="nc-what" data-stable="join-says">/);
  const app = src('app.mjs');
  assert.match(app, /for \(const x of el\.querySelectorAll\('\[data-stable\]'\)\) if \(x\.dataset\?\.stable\) stable\.set\(x\.dataset\.stable, \[x, x\.outerHTML\]\);\n  render\(\);/);
});

test('B-12: the title says a faster TEST clock\'s real turn length; the launcher panel no longer claims a two-hour default', () => {
  setTermsPace(() => 60);
  assert.equal(turnLine(), 'ゲーム内の 10 分（この世界では実時間で約 10 秒）');
  setTermsPace(() => 1);
  assert.equal(turnLine(), '10 分');
  const title = readFileSync(new URL('intro/title.mjs', WEB), 'utf8');
  assert.match(title, /L`\$\{turnLine\(\)\}ごとにターンが変わり、/);
  const lp = src('flocalplay.mjs');
  assert.doesNotMatch(lp, /既定は開始から2時間/);
  assert.doesNotMatch(src('flocalplay-session.mjs'), /既定は開始から2時間/);
  assert.match(lp, /demoPage \? L`この試験世界は時計を早めて動きます/);
  setLang('en');
  for (const s of [L`この試験世界は時計を早めて動きます（通常の1ターン10分が、実時間では数秒〜数十秒です。×60 なら約 10 秒）。開始後は、画面の時計が実際の長さを示します。進軍やその結果の受け取りは、ターンの進行を待ちます。`,
    L`通常速度では1ターン10分です（時計を早めた試験世界では、開始後の画面の時計が実際の長さを示します）。世界の開始後も、進軍やその結果の受け取りにはターンの進行を待ちます。`]) { assert.doesNotMatch(s, CJK, s); assert.doesNotMatch(s, BANNED_EN, s); }
});

test('B-7\'s neighbour: local play\'s nation choice says the page\'s test wallet signs by itself (no wallet prompts, no in-game key)', () => {
  // (verify-pr110: the devnet play sentence (#110) sits between the local-play one and the ordinary wallet one)
  const join = src('screens/join.mjs');
  assert.match(join, /: FS\.localPlay \? L`この試験用の世界では、このページのテスト用ウォレットが自分で署名します（ウォレットの確認画面も、ゲーム内の鍵もありません）。` : FS\.devnetPlay \? L`devnet では、あなたのウォレットが命令ごとに1回だけ署名し、手数料と家賃もウォレットから払います（devnet の SOL で、価値はありません。ゲーム内の鍵は作りません）。` : FS\.wallet \?/);
  setLang('en');
  const en = L`この試験用の世界では、このページのテスト用ウォレットが自分で署名します（ウォレットの確認画面も、ゲーム内の鍵もありません）。`;
  assert.doesNotMatch(en, CJK); assert.match(en, /signs on its own/);   // (re-pinned 2026-11-21: "by itself" is off the play screen, web-frontier-words.test.mjs / round 40)
});

// loop-play4 B-9: a finalized wide claim was still offered, and the own wide village's province said nothing of it
import { wideClaimModel } from '../../permutation-server/web/frontier/screens/holding.mjs';
test('B-9: the wide-claim card counts the wide villages and never offers a province where one stands', () => {
  const targets = [{ p: '-66', q: '-63' }, { p: '-67', q: '-62' }];
  const base = { localPlay: { wideLand: { scale: 60, targets } }, holdings: [{ p: -66, q: -62, site: 8, order: 1 }], ui: {} };
  const m = { holding: { p: -66, q: -62, site: 8, order: 1 }, have: [5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000] };
  const before = wideClaimModel(base, m);
  assert.deepEqual(before.targets.map(t => `${t.p},${t.q}`), ['-66,-63', '-67,-62']);
  assert.equal(before.slot, 2);
  const after = wideClaimModel({ ...base, wideStatus: 'ready', wideHoldings: { slots: [{ inventorySlot: 2, status: 'captured-unverified', holding: { p: -66n, q: -63n } }] } }, m);
  assert.deepEqual(after.targets.map(t => `${t.p},${t.q}`), ['-67,-62'], 'the claimed province is no longer offered');
  assert.equal(after.slot, 3, 'the next claim is the third village');
  const inspect = src('hud/inspect.mjs');
  assert.match(inspect, /const ownWide = wideSlots\(FS\)\.find\(e => e\.holding && String\(e\.holding\.p\) === String\(m\.p\) && String\(e\.holding\.q\) === String\(m\.q\)\) \?\? null;/);
  assert.match(inspect, /if \(ownWide\) acts\.unshift\(\{ act: 'wide-select', data: \{ slot: ownWide\.inventorySlot \}, text: L`この村を開く`, primary: true \}\);/);
  setLang('en'); assert.equal(L`あなたの村（広い土地）`, 'Your village (wide land)');
});
