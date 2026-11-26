// owner-answers-ui (r0ze 2026-11-26 10:52, page and text only; no rule changed):
//  Q-LP18-1 (a)  a local world whose lane does not carry SendCaravan (every one but --coexist) refused every caravan
//                only after the press: the form now says so first and "Send a caravan" is off, the line named as the
//                button's description for screen readers.
//  item 10       "Claim a tile" is off while land upkeep is unpaid, with its reason line (as #247/#250 do for "no tile
//                left" / "not enough ore").
//  Q-EUA2-4      (= Q-EUA-1 A) on a faster clock a game-time length also says its real length.
//  Q-EUA2-7      one coordinate format for provinces: 「州 x,y」 / "Province x,y".
//  Q-EUA2-1..6   wording (prize lines for a continuous world, Rights (Vault), the P,Q hint, jargon).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as T from '../../permutation-server/web/frontier/flocalplay-territory.mjs';
import { wideClaimModel, tileWhy } from '../../permutation-server/web/frontier/screens/holding.mjs';
import * as SCR from '../../permutation-server/web/frontier/screens/s1.mjs';
import * as FOG from '../../permutation-server/web/frontier/map/fog.mjs';
import * as ST from '../../permutation-server/web/frontier/seasonterms.mjs';
import { chipText, dialMarkup } from '../../permutation-server/web/frontier/app.mjs';
import { COEXIST_LANE, selectLocalLane } from '../../permutation-server/web/frontier/flocalplay-lane.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import EN from '../../permutation-server/web/lang/en-frontier-play.mjs';
import ENF from '../../permutation-server/web/lang/en-frontier.mjs';

const webDir = new URL('../../permutation-server/web/', import.meta.url);
const web = f => readFileSync(new URL(f, webDir), 'utf8');
const text = h => String(h).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------------ the caravan form (Q-LP18-1 (a))
const ALL = (1n << 61n) - 1n;
const bstore = units => ({ value: BigInt(units) * 1000n, rate: 0n, cap: 10n ** 12n, t0: 10n ** 12n, frac: 0n });
const holding = (p, q, site, tile) => ({ p, q, site, tile, gen: 1, state: 2, tier: 1, faction: 1, stores: Array.from({ length: 8 }, () => bstore(1000)), reserve: [300, 0, 0, 0, 0, 0, 0, 0], queue: [],
  ownerCitizen: new Uint8Array([5, 0, 0, 0, 0, 0, 0, 0, ...Array(24).fill(0)]) });
const s1World = (extra = {}) => ({ mode: 'play', nowBell: 100, chain: { now: () => 1000 }, citizen: { faction: 1, vaults: 0, towers: 0, palisades: 0, forts: 0, caravans: 4, voted: [0, 0, 0, 0] },
  holdings: [holding(0, 0, 0, 30), holding(1, 0, 2, 20)], activeHolding: 0, provinces: new Map(), s1: { caravans: { moving: [], vaults: [] }, structures: { structures: [], sightings: [] }, nations: null }, ...extra });
const submit = h => /<button type="submit" class="btn primary"([^>]*)>([^<]*)<\/button>/.exec(String(h));

test('Q-LP18-1 (a): in a plain local world the caravan form says caravans cannot be sent, and its button is off (JA, EN)', () => {
  FOG.resetFogNow();
  try {
    for (const [lang, line, word] of [['ja', 'この世界では隊商を送れません。行き先の一覧は見るだけです。', '隊商を送る'], ['en', 'Caravans cannot be sent in this world. The lists below are for reading only.', 'Send a caravan']]) {
      setLang(lang);
      const fs = s1World({ localPlay: { wideLand: { scale: 60, targets: [] } } });
      assert.equal(SCR.caravansOff(fs), true);
      const h = String(SCR.renderS1Village(fs));
      const b = submit(h);
      assert.ok(b, 'the form is still drawn (its lists stay readable)');
      assert.equal(b[2], word);
      assert.match(b[1], /\bdisabled\b/);
      assert.match(b[1], /aria-describedby="s1-caravan-off"/, 'a screen reader hears why with the button');
      assert.match(h, new RegExp(`<p class="blocked" id="s1-caravan-off" role="status">${line.replace(/[.]/g, '\\.')}</p><form class="vform" data-form="s1-caravan">`), 'the line stands above the form');
      assert.doesNotMatch(text(h), /season|シーズン/i);
    }
    // nothing to send to at all: the same line instead of "no destination yet"
    setLang('ja');
    const lone = s1World({ localPlay: {}, holdings: [holding(0, 0, 0, 30)] });
    const h = String(SCR.renderS1Village(lone));
    assert.equal(submit(h), null);
    assert.match(h, /id="s1-caravan-off"/);
  } finally { setLang('ja'); FOG.resetFogNow(); }
});

test('Q-LP18-1 (a): outside local play nothing changes (the devnet and real pages keep their form)', () => {
  FOG.resetFogNow();
  setLang('ja');
  const fs = s1World();
  assert.equal(SCR.caravansOff(fs), false);
  const h = String(SCR.renderS1Village(fs));
  assert.doesNotMatch(submit(h)[1], /disabled/);
  assert.doesNotMatch(h, /s1-caravan-off/);
});

// ------------------------------------------------------------------ "Claim a tile" while upkeep is unpaid (item 10)
function summaryBytes({ tiles = 0, unpaidSince = null, tag = 77n } = {}) {
  const b = new Uint8Array(320), v = new DataView(b.buffer);
  b.set([...'PSFXWTU1'].map(c => c.charCodeAt(0))); b[18] = 1; b[19] = unpaidSince === null ? 0 : 1;
  v.setBigUint64(84, tag, true); v.setUint32(92, tiles, true); v.setUint32(120, unpaidSince ?? 0, true);
  return b;
}
const cell = (p, q) => ({ key: `${p},${q}`, p: String(p), q: String(q), ring: 129, territory: { siteTiles: [3, 9], keepTile: 59 }, villages: [], keep: null });
const home = { p: -66, q: -62, site: 8, order: 1 };
const world = (extra = {}) => {
  const cells = [cell(-66, -63), cell(-67, -62), cell(-67, -63)];
  return { localPlay: { wideLand: { scale: 60, targets: cells.map(c => ({ p: c.p, q: c.q })) } }, holdings: [home], ui: {}, citizen: { faction: 0 }, nowBell: 110,
    wideLandNow: () => ({ cells, byKey: new Map(cells.map(c => [c.key, c])) }), ...extra };
};
const have = [2000, 2000, 2000, 500, 0, 2000, 0, 0];
const ownLand = o => ({ world: 'w', citizen: 'c', at: 1, player: T.decodeTerritoryPlayer(summaryBytes(o)) });

test('item 10: "Claim a tile" is off while the record says upkeep is unpaid (enough ore), and on again once paid', () => {
  const unpaid = wideClaimModel(world({ ownLand: ownLand({ tiles: 7, unpaidSince: 100 }) }), { holding: home, have });
  assert.deepEqual([unpaid.land.unpaid, unpaid.tilePriceShort, unpaid.tileShort, unpaid.tileOff], [true, false, false, true]);
  const letting = wideClaimModel(world({ ownLand: ownLand({ tiles: 7, unpaidSince: 50 }) }), { holding: home, have });
  assert.deepEqual([letting.land.letting, letting.tileOff], [true, true], 'also while tiles are being let go');
  const paid = wideClaimModel(world({ ownLand: ownLand({ tiles: 7 }) }), { holding: home, have });
  assert.equal(paid.tileOff, false);
  const unread = wideClaimModel(world(), { holding: home, have });
  assert.equal(unread.tileOff, false, 'not read yet: the press decides, as before');
  assert.equal(tileWhy({ territory: true, land: { unpaid: true } }), ' aria-describedby="hp-tile-why-unpaid hp-own-land-unpaid"');
  const src = web('frontier/screens/holding.mjs');
  assert.match(src, /\$\{w\.land\?\.unpaid \? html`<p class="muted"><span class="blocked" id="hp-tile-why-unpaid">\$\{L`土地の維持費が払えていないので、いまは「1マス取る」を押せません。`\}<\/span><\/p>` : ''\}/);
  assert.equal(EN['土地の維持費が払えていないので、いまは「1マス取る」を押せません。'], 'Land upkeep is unpaid, so "Claim a tile" cannot be pressed for now.');
  assert.equal((src.match(/busy \|\| w\.tileOff \|\| t\.noFree \? 'disabled'/g) ?? []).length, 3, 'every "Claim a tile" button reads tileOff');
});

// ------------------------------------------------------------------ real time on a faster clock (Q-EUA2-4)
test('Q-EUA2-4: a game-time length says its real length on a faster clock only; never a guess while the pace is unknown', () => {
  try {
    setLang('ja');
    ST.setTermsPace(() => 1);
    assert.equal(ST.realTail(533), '');
    assert.equal(chipText({ bell: 1034, secondsLeft: 372 }), 'ターン 1,034 · 残り 6:12');
    ST.setTermsPace(() => 60);
    assert.equal(ST.realTail(533), '（実時間で約 9 秒）');
    assert.equal(ST.realTail(0), '');
    assert.equal(ST.realTail(19), '（実時間で 1 秒未満）', 'live: "0:19 left" said "about 0 seconds"');
    assert.equal(ST.realTail(30), '（実時間で約 1 秒）');
    assert.equal(chipText({ bell: 1034, secondsLeft: 372 }), 'ターン 1,034 · 残り 6:12（実時間で約 6 秒）');
    assert.equal(ST.realTail(84647), '（実時間で約 24 分）', '"Shielded for 23:30:47" at ×60');
    setLang('en');
    assert.equal(chipText({ bell: 1034, secondsLeft: 372 }), 'Turn 1,034 · 6:12 left (about 6 seconds in real time)');
    // the round dial: the tail is kept whole for a screen reader, and a few characters show under the time (live: the
    // tail glued to "left" ran over the dial's ring)
    const dial = [].concat(dialMarkup({ bell: 154, secondsLeft: 76 })).join('');
    assert.match(dial, /<span class="visually-hidden"> \(about 1 second in real time\)<\/span><span class="dial-word dial-real" aria-hidden="true">≈1 s real<\/span>$/);
    assert.match(dial, /<span class="dial-word">left<\/span>/);
    assert.equal(dial.replace(/<[^>]+>/g, '').replace('≈1 s real', ''), 'Turn 154 · 1:16 left (about 1 second in real time)', 'the element still reads chipText');
    setLang('ja');
    assert.match([].concat(dialMarkup({ bell: 154, secondsLeft: 36000 })).join(''), /<span class="dial-word dial-real" aria-hidden="true">実時間≈10分<\/span>$/);
    setLang('en');
    ST.setTermsPace(() => null);
    assert.equal(ST.realTail(533), '', 'pace not known yet: nothing (fix-loop8 LP8-10)');
  } finally { ST.setTermsPace(() => 1); setLang('ja'); }
  for (const [f, needle] of [['frontier/map/waitview.mjs', '${realTail(wait.nextTurnAt - wait.now)}'], ['frontier/screens/holding.mjs', '${realTail(f.shieldLeft)}'], ['frontier/screens/shell.mjs', 'html`${Lh`あと${d.about}`}${d.real}`'], ['frontier/screens/shell.mjs', 'real: left > 0 ? realTail(left) : \'\'']]) assert.ok(web(f).includes(needle), `${f}: ${needle}`);
});

// ------------------------------------------------------------------ wording (Q-EUA2-1, -2, -5, -6, -7)
function* mjs(dir) {
  for (const n of readdirSync(dir)) { const p = new URL(n, dir); if (statSync(p).isDirectory()) yield* mjs(new URL(`${n}/`, dir)); else if (n.endsWith('.mjs')) yield [p, n]; }
}
test('Q-EUA2-7: provinces are written one way in the page source — 「州 x,y」, never 「州（x, y）」', () => {
  for (const [p] of mjs(new URL('frontier/', webDir))) assert.doesNotMatch(readFileSync(p, 'utf8'), /州（\$\{/, String(p));
  for (const v of Object.values(EN)) if (typeof v === 'string') assert.doesNotMatch(v, /[Pp]rovince \(\{\d\}, \{\d\}\)/, v);
});

test('Q-EUA2-1/-2/-5/-6: the old player lines are gone and the new ones have English', () => {
  const gone = ['賞金の成果基準は未決定です', 'このテスト用の世界の終わりに', '権利（在庫の交換）', 'この軍勢を P,Q で確認', '結果と賞金を見る', '実時間では数十秒です'];
  for (const [p] of mjs(new URL('frontier/', webDir))) { const s = readFileSync(p, 'utf8'); for (const g of gone) assert.ok(!s.includes(g), `${p}: ${g}`); }
  assert.equal(EN['権利（保管庫）'], 'Rights (Vault)');
  assert.equal(ENF['入力した州（P, Q）でこの軍勢を確認'], 'Check this host at a province you enter (P, Q)');
  for (const v of Object.values(EN)) if (typeof v === 'string') {
    assert.doesNotMatch(v, /when this test world ends|Prize outcome criteria|stock swap|citizen and village|land \{3\} out/, v);
  }
  assert.match(web('frontier/hud/provstrip.mjs'), /m\.source === 'pool' \? L`最後の記録と賞金を見る` : L`最後の記録を見る`/);
  assert.equal(EN['最後の記録を見る'], 'See the final record');
});

test('Q-EUA2-3: the ① board cost line has no "(S1)"', () => {
  const ui = readFileSync(new URL('../../workstreams/01-national-strategy/coop/coop-ui.mjs', import.meta.url), 'utf8');
  const en = readFileSync(new URL('../../workstreams/01-national-strategy/coop/lang/en.mjs', import.meta.url), 'utf8');
  assert.ok(!ui.includes('費用（S1）') && ui.includes('。費用：${esc(needText('));
  assert.ok(!en.includes('Cost (S1)') && en.includes("'{0}。費用：{1}。ほかの人から：{2}［仮］。報酬はない。': '{0^}. Cost: {1}."));
});

// ------------------------------------------------------------------ last: the --coexist lane (process-wide, one-shot)
test('Q-LP18-1 (a): in a --coexist world (the lane that carries SendCaravan) the form is unchanged', () => {
  FOG.resetFogNow();
  setLang('ja');
  selectLocalLane(COEXIST_LANE);
  const fs = s1World({ localPlay: {} });
  assert.equal(SCR.caravansOff(fs), false);
  const h = String(SCR.renderS1Village(fs));
  assert.doesNotMatch(submit(h)[1], /disabled/);
  assert.doesNotMatch(h, /s1-caravan-off/);
});
