// fix-loop16 (owner 2026-11-25 12:04, inbox 2026-11-25-1204-r0ze-noon-decisions.md item 8): Q-LP16-1 (b) the claim card's
// pinned rows, Q-LP16-2 (b) --ai-near, Q-LP16-3 (a) "Fields", Q-LP16-4 (a) the picker's "AI present" mark, and the plain
// loop-play16 fixes (LP16-2, -5, -6, -7, -8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { claimPins, pinnedRows } from '../../permutation-server/web/frontier/screens/holding.mjs';
import { expeditionHoldsOf } from '../../permutation-server/web/frontier/flocalplay-expedition.mjs';
import { wideStoresShortText } from '../../permutation-server/web/frontier/screens/wideholding.mjs';
import { launcherAiNations } from '../../permutation-server/web/frontier/flocalplay.mjs';
import { launcherLostText } from '../../permutation-server/web/frontier/flocalplay-ended.mjs';
import { renderLandChip } from '../../permutation-server/web/frontier/land.mjs';
import { trainingCost } from '../../permutation-server/web/frontier/fland.mjs';
import { nearChoice, decideNext, createResidentMemory, OPERATOR_NEAR_MODE } from '../src/frontier/local-play-operator-policy.mjs';
import { headingBonus } from '../src/frontier/local-play-operator-expansion.mjs';
import { parseArgs as residentArgs } from '../src/frontier/local-play-operator-residents.mjs';
import { operatorNationsOf } from '../src/frontier/local-play-launcher.mjs';

const src = f => readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');

test('Q-LP16-1 (b): the card keeps 4 + 6 rows, and a province with own tiles or a keep under siege is never cut', () => {
  const near = ['-60,129', '-59,129', '-60,130', '-61,130', '-61,129', '-62,129', '-62,130'].map(k => { const [p, q] = k.split(','); return { p, q }; });
  // (no pin: the first four, as before — loop-play16 LP16-1: (-62,129) fell off while its keep was being taken)
  assert.deepEqual(pinnedRows(near, 4, new Map()).map(t => `${t.p},${t.q}`), ['-60,129', '-59,129', '-60,130', '-61,130']);
  const pins = new Map([['-62,129', 'siege'], ['-62,130', 'tiles']]);
  const rows = pinnedRows(near, 4, pins);
  assert.deepEqual(rows.map(t => `${t.p},${t.q}`), ['-60,129', '-59,129', '-62,129', '-62,130'], 'the count stays 4: two pinned, two others, in the list\'s order');
  assert.deepEqual(rows.map(t => t.pin), [null, null, 'siege', 'tiles']);
  // (more pinned than the cap: all of them stay)
  const many = new Map(near.slice(1).map(t => [`${t.p},${t.q}`, 'tiles']));
  assert.equal(pinnedRows(near, 4, many).length, 6);
  // the pins: own tile claims of this visit, a kept expedition's hold that is not lost, the wide village's march
  const FS = { ui: { ownTiles: { '-62,130,4': true, '-61,129,0': true, 'bad': true }, wideHostSay: { kind: 'wait', wait: 'march', march: { to: { p: '-62', q: '129' }, phase: 'stands' } } } };
  expeditionHoldsOf(FS).set('c1', { to: { p: '-63', q: '129' }, outcome: null });
  expeditionHoldsOf(FS).set('c2', { to: { p: '-64', q: '129' }, outcome: 'lost' });
  expeditionHoldsOf(FS).set('c3', { to: { p: '-65', q: '129' }, outcome: 'taken', keepLostAt: 300 });
  expeditionHoldsOf(FS).set('c4', { to: { p: '-61', q: '129' }, outcome: 'taken' });
  const got = claimPins(FS);
  assert.deepEqual([...got].sort(), [['-61,129', 'keep'], ['-62,129', 'siege'], ['-62,130', 'tiles'], ['-63,129', 'siege']]);
  assert.equal(claimPins({ ui: { wideHostSay: { kind: 'wait', march: { to: { p: '1', q: '129' }, phase: 'gone' } } } }).size, 0, 'a march that is gone pins nothing');
  assert.equal(claimPins({ ui: { wideHostSay: { kind: 'decision', name: 'WideDepart', to: { p: '1', q: '129', holder: 6 } } } }).get('1,129'), 'siege');
  assert.equal(claimPins({}).size, 0);
  const h = src('permutation-server/web/frontier/screens/holding.mjs');
  assert.ok(h.includes('const targets = [...pinnedRows(all.filter(t => !t.reach), 4, pins), ...pinnedRows(all.filter(t => t.reach), 6, pins)];'));
  assert.ok(h.includes('L`あなたの軍勢が砦を奪っている州`') && h.includes('L`あなたのマスがある州`'));
});

test('Q-LP16-2 (b): --ai-near — the near resident waits for the player\'s village, then takes the nearest site of another nation and heads toward it', () => {
  // the standard wide map's rim sites (evidence: a local wide world's rim_settlers)
  const homes = [[66, 62, 0], [-66, -62, 0], [-61, 128, 1], [61, -128, 1], [-128, 68, 2], [128, -68, 2], [-63, -65, 3], [63, 65, 3], [64, -128, 4], [-64, 128, 4], [128, -65, 5], [-128, 65, 5]].map(([p, q, nation]) => ({ p, q, nation }));
  assert.deepEqual(nearChoice(homes, { p: 66, q: 62 }, 0), { nation: 3, p: 63, q: 65, distance: 3 }, 'Aster\'s rim site: Dunmar\'s is 3 provinces away');
  assert.deepEqual(nearChoice(homes, { p: -61, q: 128 }, 1), { nation: 4, p: -64, q: 128, distance: 3 });
  assert.equal(nearChoice(homes, { p: 66, q: 62 }, 0).nation !== 0, true, 'never the player\'s own nation');
  assert.equal(nearChoice(homes, null, 0), null);
  assert.equal(nearChoice([{ p: 1, q: 1, nation: 2 }], { p: 5, q: 5 }, 2), null, 'no site of another nation');
  // the chosen province's sites come first in the home order
  const memory = { ...createResidentMemory(0, undefined, { war: false }), near: { wallet: 'x', home: { nation: 3, p: 63, q: 65 } }, faction: 3 };
  const d = decideNext(memory, { joined: true, faction: 3, holding: null }, { homes, nowSecs: 1_700_000_000, wide: { targets: [] } });
  assert.equal(d.name, 'FileTicket');
  assert.deepEqual(d.fields.sites, [{ p: 63, q: 65, site: 0 }]);
  // the heading: a province nearer to the player's village scores higher
  const home = { p: 63, q: 65 }, toward = { toward: { p: '66', q: '62' } };
  assert.ok(headingBonus(home, { p: '65', q: '64' }, toward) > headingBonus(home, { p: '62', q: '67' }, toward));
  assert.equal(headingBonus(home, { p: '62', q: '67' }, toward), 0);
  // the options
  assert.equal(OPERATOR_NEAR_MODE, 'operator-near-v1');
  const base = ['--count', '2', '--relay-ports', '41810,41811', '--herald', 'http://127.0.0.1:41802', '--homes', JSON.stringify(homes)];
  const wide = ['--wide', JSON.stringify([{ p: '66', q: '63' }])];
  const wallet = '9qACBX8bFFs7ZfVeEh7qpfY8nhtjwPsxeQANXEwV7uRL';
  assert.equal(residentArgs([...base, ...wide, '--near', wallet]).near, wallet);
  assert.throws(() => residentArgs([...base, '--near', wallet]), /--near/, 'only in a wide world');
  assert.throws(() => residentArgs([...base, ...wide, '--near', 'not an address']), /--near/);
  assert.throws(() => residentArgs([...base, ...wide, '--nations', '1,4', '--near', wallet]), /--near/, 'never with named nations');
  const l = src('permutation-gateway/src/frontier/local-play-launcher.mjs');
  assert.ok(l.includes("if (out['operator-near'] !== undefined && (out['operator-near'] !== OPERATOR_NEAR_MODE || out['wide-land'] === undefined || out['operator-residents'] === undefined)) throw fault('InvalidOperatorNear');"));
  assert.ok(l.includes("...(near ? ['--near', near] : [])]);"), 'the player\'s PUBLIC address only');
  const sh = src('scripts/play-local.sh');
  assert.ok(sh.includes('--ai-near) AI_NEAR=1; shift ;;') && sh.includes("printf '%s\\n' --operator-near operator-near-v1"));
  assert.match(sh, /AI_NEAR=0/, 'off by default');
});

test('Q-LP16-4 (a): the launcher says which NATIONS have an AI resident; the picker marks them', () => {
  assert.deepEqual(operatorNationsOf({ operatorResidents: 4 }), [1, 4, 2, 5]);
  assert.deepEqual(operatorNationsOf({ operatorResidents: 2 }), [1, 4]);
  assert.deepEqual(operatorNationsOf({ operatorNations: [3, 0], operatorResidents: 2 }), [3, 0]);
  assert.deepEqual(operatorNationsOf({}), []);
  assert.deepEqual(launcherAiNations([1, 4, 2, 5]), [1, 4, 2, 5]);
  assert.deepEqual(launcherAiNations([]), []);
  for (const bad of [undefined, null, 'x', [6], [1, 1], [1.5], [0, 1, 2, 3, 4, 5, 0], [{ wallet: 'x' }]]) assert.equal(launcherAiNations(bad), null);
  const l = src('permutation-gateway/src/frontier/local-play-launcher.mjs');
  assert.ok(l.includes("...(operators ? { aiNations: operatorNationsOf(c).slice(c.operatorNear ? 1 : 0), ...(c.operatorNear ? { aiNear: true } : {}) } : {}),"), 'nation numbers only: no wallet');
  const j = src('permutation-server/web/frontier/screens/join.mjs');
  assert.ok(j.includes('${c.ai ? html`<span class="bn-ai" data-ai="1">${L`AIあり`}</span>` : \'\'}'));
  assert.ok(j.includes('const ai = Array.isArray(FS.localPlay?.aiNations) ? FS.localPlay.aiNations : [];'));
});

test('Q-LP16-3 (a): the village\'s worked land is "Fields" / 「耕地」, not "Land … tiles" / 「領土」', () => {
  setLang('ja');
  const ja = String(renderLandChip({ claimed: 0, tiles: 8, bonusPct: 0 }));
  assert.match(ja, /耕地 0 マス · \+0%/); assert.match(ja, /この州の耕地 0 マス · 生産 \+0%/); assert.doesNotMatch(ja, /領土 0 マス/);
  setLang('en');
  try {
    const en = String(renderLandChip({ claimed: 0, tiles: 8, bonusPct: 0 }));
    assert.match(en, /Fields 0 tiles · \+0%/); assert.match(en, /Fields in this province: 0 tiles · production \+0%/);
    assert.doesNotMatch(en, /Land 0 tiles/); assert.doesNotMatch(en, /Territory trial/);
    assert.match(String(renderLandChip({ claimed: 1, tiles: 8, bonusPct: 2 })), /Fields 1 tile · \+2%/);
  } finally { setLang('ja'); }
});

test('LP16-2 / LP16-7: a wide village short of stores says the cost and when to press again; a memory-only world that lost its launcher is not said to resume', () => {
  const say = { kind: 'wait', wait: 'stores', n: 100, cost: trainingCost(0, 100, 4) };
  setLang('ja');
  assert.match(wideStoresShortText(say), /槍兵 100 の訓練の費用（食料 60 · 鉱石 20 · 金 10）にまだ足りません。.*10 ターンほど待ってから、もう一度「次の一手（広い土地）」を押してください。/);
  assert.match(launcherLostText({ kept: false }), /この世界は終わりました。保存されない世界なので、続きからは始められません。/);
  assert.match(launcherLostText(), /保存した世界は続きから/);
  setLang('en');
  try {
    assert.match(wideStoresShortText(say), /do not cover training 100 Spearmen yet \(Food 60 · Ore 20 · Gold 10\)\. A new village starts with empty stores.*Wait about 10 turns, then press "Next step \(wide land\)" again\./);
    assert.match(launcherLostText({ kept: false }), /this world has ended: it is not a kept world, so it cannot be continued\./);
    assert.doesNotMatch(launcherLostText({ kept: false }), /a kept world resumes/);
    assert.match(launcherLostText({ kept: true }), /a kept world resumes/);
  } finally { setLang('ja'); }
  const c = src('permutation-server/web/frontier/controller.mjs');
  assert.ok(c.includes("if (d.name === 'WideTrain' && FS.notice !== noticeBefore && FS.notice?.ok === false && (Number(FS.notice.programCode) === 21 || FS.notice.code === 'Insufficient')) {"));
});

test('LP16-5 / LP16-6 / LP16-8: a keep of no nation, the road\'s limit and the kept start page are said as they are', () => {
  const w = src('permutation-server/web/frontier/screens/wideholding.mjs');
  assert.ok(w.includes("if (say.name === 'WideDepart' && say.to?.holder === 6) return L`軍勢（兵 ${fmtNum(Number(say.troops ?? 0))}）が州 ${at(say.to)} の砦へ進軍します（どの国のものでもない砦）。"));
  const hand = src('permutation-server/web/frontier/hud/hand.mjs');
  assert.ok(hand.includes('${s.stepRefused ? html`<p class="pop-line pop-why outbound-step-refused" role="status">${L`道の形は 32 マス・4 州までです。`} ${L`この一歩は足せません。「一歩戻す」で道を変えるか、もっと近い砦を選んでください。`}</p>` : \'\'}'));
  const comp = src('permutation-server/web/frontier/fexpedition-compose.mjs');
  assert.ok(comp.includes("if (s.error === 'PathTooLong' || s.error === 'PathProvinces') s.stepRefused = s.error; return false; }"));
  assert.ok(comp.includes("s.directions = directions; s.stepRefused = null;"), 'a step that lands clears it');
  const f = src('permutation-server/web/frontier/flocalplay.mjs');
  assert.ok(f.includes('title.textContent = launcher && persisted ? L`この端末の世界で遊ぶ` : launcher ? L`新しい世界で遊ぶ` : L`ローカルプレイの準備`;'));
});

test('LP16-6 / LP16-10 / LP15-9(e): another host\'s confirmed departure is not this card\'s; the join card uses the stated clock; the lag sentence is said once', () => {
  const hand = src('permutation-server/web/frontier/hud/hand.mjs');
  assert.ok(hand.includes("const d = d0.status === 'confirmed' && typeof d0.host === 'string' && typeof src === 'string' && d0.host !== src ? { ...d0, status: 'idle' } : d0;"));
  const app = src('permutation-server/web/frontier/app.mjs');
  assert.ok(app.includes("const stated = Number(FS.localPlay?.clockScale ?? FS.localPlay?.wideLand?.scale ?? 0);"));
  assert.ok(app.includes("return stated > 1 && (r === null || Number(r) < stated / 2) ? stated : r;"));
  const w = src('permutation-server/web/frontier/screens/wideholding.mjs');
  assert.ok(w.includes("!(FS.ui.wideHostSay.kind === 'wait' && FS.ui.wideHostSay.wait === 'lag' && FS.ui?.wideHost?.waiting?.reason === 'lag' && !FS.ui.wideHostSay.hold)"));
  const c = src('permutation-server/web/frontier/controller.mjs');
  assert.ok(c.includes('setNotice({ ...FS.notice, text: () => wideStoresShortText(say) });'), 'the toast follows a language switch');
});
