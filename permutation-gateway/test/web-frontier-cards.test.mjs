// The drawer's cards (UX design sections 1 and 6): the village, the hosts and
// explore, the marches, the chronicle and "More → details" as short parchment
// cards with the common action first and the rest behind folds; places by
// their names; the words of the machinery (keeper, lamports, frontier.wasm,
// the test beacon, M1, site and tile numbers) off the play screen and under
// "More → details".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decode } from '../../permutation-server/web/frontier/fcodec.mjs';
import { encodeAccount } from '../../permutation-server/web/sdk/frontier/codec.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import * as holdingScreen from '../../permutation-server/web/frontier/screens/holding.mjs';
import * as hostScreen from '../../permutation-server/web/frontier/screens/host.mjs';
import * as exploreScreen from '../../permutation-server/web/frontier/screens/explore.mjs';
import * as chronicleScreen from '../../permutation-server/web/frontier/screens/chronicle.mjs';
import * as bellScreen from '../../permutation-server/web/frontier/screens/bell.mjs';
import * as parts from '../../permutation-server/web/frontier/screens/parts.mjs';
import * as place from '../../permutation-server/web/frontier/hud/place.mjs';
import * as pins from '../../permutation-server/web/frontier/hud/pins.mjs';
import { STANCE_PIC, RETREAT_PIC, sealPic } from '../../permutation-server/web/frontier/hud/pictos.mjs';
import { panelMarkup, detailsMarkup, keepState } from '../../permutation-server/web/frontier/app.mjs';
import { DIRECTIONS, TILE_OFFSETS } from '../../permutation-server/web/frontier/fgeo.mjs';

const FIX = new URL('fixtures/frontier/', import.meta.url);
const SEASON = decode('Season', Buffer.from(JSON.parse(readFileSync(new URL('season.json', FIX), 'utf8')).bytes_b64, 'base64'));
const acct = (kind, values) => decode(kind, encodeAccount(kind, { SEASON_ID: 1n, ...values }), { seasonId: 1 });
const flat = x => [x].flat(Infinity).map(String).join('');
const text = x => flat(x).replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]*>/g, ' ');
const JP = /[぀-ヿ㐀-鿿]/;
/** The machinery's words that leave the play screen (UX design section 6). */
const INTERNAL = /テスト用ビーコン|キーパー|frontier\.wasm|ランポート|区画 ?\d|マス ?\d|M1|keeper|lamports|test beacon/i;
// the words UX design 11.13 takes off the play screen (they may stand under "More → details" and in a report's proof):
// a numbered bell (every number is a turn's), secrecy wording, the beacon, settlement, the seed, the site ticket
const BANNED_JA = /第[\d,]+鐘|秘密|ビーコン|精算|乱数|入植希望|キーパー|ランポート|区画|M1/;
const BANNED_EN = /\bbell \d|\bsecret|beacon|\bsettle[ds]?\b|settlement|\bseed\b|site ticket|keeper|lamport/i;

function world({ reserve = [400, 0, 0, 0, 0, 0, 100, 0], entries = null } = {}) {
  const id = seq => hostId({ p: 2, q: 0, site: 3, gen: 1, seq });
  const holding = acct('Holding', { P: 2, Q: 0, SITE: 3, GEN: 1, TILE: 30, STATE: 2, FACTION: 0, TIER: 1, FINAL_TS: 0, RESERVE: reserve,
    STORES: [1220, 815, 662, 305, 122, 90, 40, 20].map((v, i) => ({ VALUE: BigInt(v * 1000), RATE: BigInt([40, 30, 25, 10, 5, 0, 0, 0][i] * 1000), CAP: BigInt(6_000_000), T0: 0n })) });
  const province = acct('Province', { P: 2, Q: 0, RESOLVED_NEXT: 41, SITE_COUNT: 1, SITES: Uint8Array.of(30, ...new Array(11).fill(0)), PASSABLE_MASK: (1n << 61n) - 1n, SITE_MIRROR: [{ STATE: 1, FACTION: 0, TIER: 1 }, ...Array.from({ length: 11 }, () => ({ STATE: 0 }))],
    ENTRIES: entries ?? [{ ID: id(7), FACTION: 0, UNIT: 0, TILE: 30, STATE: 1, TROOPS: 600_000, STAMINA_VALUE: 112, STAMINA_BELL: 42, READY_BELL: 0 },
      { ID: id(8), FACTION: 0, UNIT: 6, TILE: 30, STATE: 1, TROOPS: 100_000, STAMINA_VALUE: 120, STAMINA_BELL: 42, READY_BELL: 0 }] });
  const FS = { mode: 'play', tab: 'holding', season: SEASON, nowBell: 42, chain: { now: () => 1_000 }, citizen: { faction: 0, vigilStartMin: 0, exploresFloorLeft: 3 }, land: { stage: 'final' },
    holdings: [holding], provinces: new Map([['2,0', { province }]]), view: { fog: true }, ui: { dismissed: ['onboarding'] }, marches: [], chronicle: [], incoming: [], feed: [] };
  return { FS, holding, province };
}

test('the parts: a card head, a fold that keeps its key, bars and rings as SVG geometry (no style attribute)', () => {
  const head = String(parts.cardHead({ id: 'x-title', ic: 'home', title: 'T', sub: 'S', side: parts.chip('C', 'ok') }));
  assert.match(head, /<header class="c-head"><span class="c-ic"><svg class="ic"[^>]*><use href="art\/ui\/icons\.svg#home"\/><\/svg><\/span><span class="c-titles"><h3 id="x-title">T<\/h3><span class="c-sub">S<\/span><\/span><span class="c-side"><span class="chip chip-ok">C<\/span><\/span><\/header>/);
  const f = String(parts.fold('k-1', 'more', 'body'));
  assert.match(f, /^<details class="fold" data-fold="k-1" ><summary>/);
  assert.match(String(parts.fold('k', 's', 'b', { open: true })), /data-fold="k" open>/);
  assert.match(String(parts.bar(1, 4)), /<rect class="bar-fg" width="25\.0" height="4"\/>/);
  assert.match(String(parts.bar(9, 4)), /width="100\.0"/, 'a bar never overruns');
  assert.match(String(parts.lossBar(100, 40, 200)), /<rect class="bar-lost" width="50\.0" height="8"\/><rect class="bar-fg" width="20\.0" height="8"\/>/);
  assert.match(String(parts.ring(0.5)), /stroke-dasharray="50\.0 100"/);
  assert.match(String(parts.ring(null)), /class="ring ring-wait"/, 'no share: the waiting ring');
  const st = String(parts.stepper({ prev: { act: 'a', data: { d: -1 }, label: 'p', disabled: true }, next: { act: 'a', data: { d: 1 }, label: 'n' }, value: 'V' }));
  assert.match(st, /data-act="a" data-d="-1" aria-label="p" disabled>/);
  assert.match(st, /<span class="step-value">V<\/span>/);
  for (const m of [head, f, st, String(parts.bar(1, 2)), String(parts.ring(0.3)), ...Object.values(STANCE_PIC).map(p => String(p())), ...Object.values(RETREAT_PIC).map(p => String(p())), String(sealPic())]) assert.doesNotMatch(m, /\sstyle=|<style/);
  assert.deepEqual(Object.keys(STANCE_PIC), ['Hold', 'Assault', 'Flank', 'Brace']);
  assert.deepEqual(Object.keys(RETREAT_PIC), ['never', 'x2', 'x1.5', 'x1', 'x0.5']);
});

test('the village drawer: five short parts, the stores as a ruled ledger, the common action first, the rest behind folds', () => {
  setLang('ja');
  const { FS } = world();
  const cards = holdingScreen.render(FS);
  assert.equal(cards.length, 5, 'village, stores, building, troops, the rest');
  const out = flat(cards);
  // (hud-4, UX design 11.13: names before coordinates. Under the name stand the tier and the nation; the province's
  // coordinates are a row of the village's details, and nowhere else on the card)
  assert.match(out, /<h3 id="holding-title">[^<]+の町<\/h3><span class="c-sub">町 · [^<0-9]+<\/span>/, 'the name first, then its tier and its nation');
  const [upper, facts] = out.split('data-fold="v-facts"');
  assert.doesNotMatch(text(upper), /州 -?\d/, 'no coordinates above the details');
  assert.match(facts, /<dt>場所<\/dt><dd>州 2,0<\/dd>/, 'the coordinates are a row of the details');
  assert.doesNotMatch(text(out), BANNED_JA);
  assert.match(out, /<header class="c-head"><span class="c-pic"><img src="[^"]+town_o_ember\.webp"/, 'the village as the map paints it');
  // (wave 2, UX design 11.12: the stores were eight tokens in boxes; they are lines of a ruled ledger now)
  assert.equal((out.match(/<tr class="ledger-row/g) ?? []).length, 8, 'eight stores as lines of the ledger');
  assert.match(out, /<table class="ledger"><caption class="visually-hidden">資源<\/caption>\s*<thead><tr><th scope="col">品目<\/th><th scope="col">在庫<\/th><th scope="col">上限<\/th><th scope="col">毎時<\/th>/);
  assert.match(out, /<th scope="row"><svg class="ic ledger-ic"[^>]*><use href="art\/ui\/icons\.svg#grain"\/><\/svg><span class="ledger-name">食料<\/span><\/th>\s*<td class="ledger-val">[\d,]+<\/td>/);
  assert.match(out, /<span class="stamp-word stamp-(ok|warn)"><span class="stamp-ink">[^<]+<\/span><\/span>/, 'the village\'s state is a stamped word');
  assert.doesNotMatch(out, /class="store[ "]|stores-grid/);
  assert.match(out, /data-act="harvest"/);
  // building: the queue's size, three buildings in sight (what can go up now first), the rest behind one fold
  const build = String(cards[2]);
  assert.match(build, /建設中 0\/4/);
  const [shown, folded] = build.split('data-fold="v-build"');
  assert.equal((shown.match(/data-act="build"/g) ?? []).length, holdingScreen.BUILD_SHOWN);
  assert.equal((folded.match(/data-act="build"/g) ?? []).length, 7 - holdingScreen.BUILD_SHOWN);
  assert.doesNotMatch(shown, /data-act="build" data-item="\d" aria-label="[^"]*" disabled/, 'what stands in sight can be built');
  // troops: a reserve of 400 → muster is the open form, training waits behind its fold
  const troops = String(cards[3]);
  assert.ok(troops.indexOf('data-form="muster"') < troops.indexOf('data-fold="v-train"'), 'muster first');
  assert.ok(troops.indexOf('data-fold="v-train"') < troops.indexOf('data-form="train"'), 'training behind the fold');
  assert.match(troops, /<input type="radio" name="unit" value="0" checked>\s*<img class="unit-card f0"/, 'units are pictures to choose from');
  const none = String(holdingScreen.render(world({ reserve: [0, 0, 0, 0, 0, 0, 0, 0] }).FS)[3]);
  assert.ok(none.indexOf('data-form="train"') < none.indexOf('data-fold="v-muster"'), 'no reserve: training first');
  // the rest: garrison, vigil hours and the village's details are folds
  for (const k of ['v-garrison', 'v-vigil', 'v-facts']) assert.match(String(cards[4]), new RegExp(`data-fold="${k}"`));
  assert.doesNotMatch(text(out), INTERNAL);
  assert.doesNotMatch(out, /\sstyle=/);
  setLang('en');
  const en = text(holdingScreen.render(FS));
  assert.doesNotMatch(en.replace(/Lamar|Ramar/g, ''), JP, en);
  assert.doesNotMatch(en, INTERNAL);
  setLang('ja');
});

test('the hosts drawer: one entry per host with its state stamped and a stamina bar; the order is written on the map', () => {
  setLang('ja');
  const { FS } = world();
  FS.tab = 'hosts';
  const out = String(hostScreen.render(FS));
  assert.equal((out.match(/<li class="vcard host-card/g) ?? []).length, 2);
  // (wave 2: the state is a stamped word, not a pill)
  assert.match(out, /<strong class="host-name">槍兵 600<\/strong><span class="stamp-word stamp-ok"><span class="stamp-ink">出陣できる<\/span><\/span>/);
  assert.match(out, /<span class="host-v">112\/120<\/span>/);
  assert.match(out, /data-act="compose" data-host="\d+"\s+data-stay="map">/, 'a march is composed on the map');
  assert.equal((out.match(/data-act="explore-open"/g) ?? []).length, 1, 'only the scouts explore');
  assert.deepEqual([hostScreen.hostState({ state: 1, stamina: 120, readyBell: 0 }, 42).id, hostScreen.hostState({ state: 1, stamina: 50, readyBell: 0 }, 42).id,
    hostScreen.hostState({ state: 1, stamina: 120, readyBell: 44 }, 42).id, hostScreen.hostState({ state: 2 }, 42).id, hostScreen.hostState({ state: 1, inTransit: true }, 42).id],
  ['ready', 'tired', 'rest', 'forming', 'march']);
  assert.doesNotMatch(text(out), INTERNAL);
  // explore: the scout's neighbours as they lie on the map, never as tile numbers
  const rows = hostScreen.hostRows(FS);
  const scout = rows.find(r => r.unit === 6);
  const ex = String(exploreScreen.render({ ...FS, explore: { host: scout, tiles: [] } }));
  const dirs = [...ex.matchAll(/class="rose-hex rose-d(\d)" data-act="explore-tile" data-tile="(\d+)" aria-pressed="false">([^<]+)</g)].map(m => [Number(m[1]), Number(m[2]), m[3]]);
  assert.ok(dirs.length >= 3, `targets around the scout: ${dirs.length}`);
  for (const [d, tile] of dirs) {
    const a = TILE_OFFSETS[scout.tile], b = TILE_OFFSETS[tile];
    assert.deepEqual([b.q - a.q, b.r - a.r], DIRECTIONS[d], 'a target stands in its direction');
  }
  assert.equal(exploreScreen.directionOf(scout.tile, scout.tile), -1);
  assert.match(ex, /data-act="explore-send" disabled/);
  assert.doesNotMatch(text(ex), INTERNAL);
  setLang('en');
  assert.doesNotMatch(text(hostScreen.render(FS)).replace(/Lamar|Ramar/g, ''), JP);
  assert.match(text(exploreScreen.render({ ...FS, explore: { host: scout, tiles: [] } })), /North-east|East|South-east/);
  setLang('ja');
});

test('places by name: what stands on a tile, then its terrain; pins and the chronicle never show a number of a tile or a site', () => {
  setLang('ja');
  const { FS } = world();
  FS.provinces.get('2,0').province.camp = { state: 1, tile: 33, troops: 250 };
  FS.terrainOf = () => ({ terrain: Array(61).fill(2), sites: [30], names: ['Grassland', 'Plains', 'Forest'] });
  assert.equal(place.tileWhat(FS, 2, 0, 33).kind, 'camp');
  assert.equal(place.tileName(FS, 2, 0, 33), '蛮族の野営地');
  assert.match(place.tileName(FS, 2, 0, 30), /の町$/, 'a village by its name');
  assert.equal(place.tileName(FS, 2, 0, 5), '森');
  assert.equal(place.tileName(null, 9, 9, 5), '土地', 'nothing known: the land');
  assert.equal(place.tilePlace(FS, 2, 0, 33), '蛮族の野営地（州 2,0）');
  assert.equal(pins.pinName({ p: 2, q: 0, tile: 33 }, FS), '蛮族の野営地（州 2,0）');
  // (hud-4, UX design 11.13: a pinned province is said in words first; its coordinates follow in brackets, since a pin is a bookmark)
  assert.match(pins.pinName({ p: 2, q: 0, tile: null }, FS), /の町のある州（州 2,0）$/);
  assert.equal(pins.pinName({ p: 1, q: 1, tile: null }, FS), 'アステル方面・第2輪の州（州 1,1）');
  // the village as the map paints it, for its card and the inspector: a file of the art for every nation and tier (no 404)
  for (let f = 0; f < 6; f++) for (let tier = 0; tier < 4; tier++) for (const walls of [false, true]) {
    const url = place.villagePic(f, tier, { walls });
    assert.ok(existsSync(fileURLToPath(url)), url);
  }
  assert.match(place.villagePic(0, 3), /stronghold_w_ember\.webp$/, 'a Stronghold is always walled');
  assert.equal(place.villagePic(6, 0), null, 'no picture for a camp or a Free City');
  assert.match(String(parts.cardHead({ id: 'v', pic: place.villagePic(1, 1), title: 'T' })), /<span class="c-pic"><img src="[^"]+town_o_tide\.webp" alt=""/);
  // the chronicle: grouped by turn, the latest turns in sight, the rest behind a fold, a line with a place goes there
  const rec = (name, bell, more = {}) => ({ seq: String(bell), record: { name, bell, ...more } });
  FS.chronicle = [rec('PROVINCE_OPEN', 38, { p: 2, q: 0, site_count: 12 }), rec('SETTLE', 39, { p: 2, q: 0, site: 3, outcome: 0 }), rec('HOLDING_FINAL', 40, { p: 2, q: 0, site: 3 }),
    rec('DEPART', 41, { origin_p: 2, origin_q: 0, arrive_bell: 43, host_id: 1n }), rec('CLASH', 41, { p: 2, q: 0 })];
  const rows = chronicleScreen.chronicleRows(FS.chronicle);
  assert.deepEqual(rows.map(r => [r.bell, r.at, r.clash]), [[41, { p: 2, q: 0 }, true], [41, { p: 2, q: 0 }, false], [40, { p: 2, q: 0 }, false], [39, { p: 2, q: 0 }, false], [38, { p: 2, q: 0 }, false]]);
  assert.deepEqual(chronicleScreen.placeOf({ name: 'DEPART', origin_p: 2, origin_q: 0, dest_p: 9 }), { p: 2, q: 0 }, 'a departure is at its origin: its destination is sealed');
  assert.equal(chronicleScreen.placeOf({ name: 'JOIN' }), null);
  const ch = String(chronicleScreen.render(FS));
  const [open, old] = ch.split('data-fold="chron-old"');
  assert.equal((open.match(/class="chron-turn"/g) ?? []).length, chronicleScreen.TURNS_SHOWN);
  assert.equal((old.match(/class="chron-turn"/g) ?? []).length, 2);
  assert.match(open, /icons\.svg#bell"\/><\/svg>ターン 41<\/h4>/, 'a turn stamp with the bell');
  assert.match(open, /data-act="report-open" data-p="2" data-q="0" data-bell="41">報告</);
  assert.match(open, /data-act="goto" data-p="2" data-q="0">見る</);
  assert.doesNotMatch(text(ch), INTERNAL);
  setLang('en');
  const en = text(chronicleScreen.render(FS));
  assert.doesNotMatch(en.replace(/Lamar|Ramar/g, ''), JP, en);
  assert.match(en, /Turn 41/);
  setLang('ja');
});

test('"More": cards and folds; the machinery\'s words live under its details and nowhere else on the play screen', () => {
  setLang('ja');
  const { FS } = world();
  FS.beacon = { kind: 'test' };
  FS.clock = { genesisTs: 0, endBell: 10_000 };
  FS.bellItems = [];
  for (const tab of ['holding', 'hosts', 'marches']) {
    assert.doesNotMatch(text(panelMarkup({ ...FS, tab })), INTERNAL, tab);
    assert.doesNotMatch(text(panelMarkup({ ...FS, tab })), BANNED_JA, tab);
  }
  const more = flat(panelMarkup({ ...FS, tab: 'more' }));
  for (const id of ['feed-title', 'chronicle-title', 'bell-title', 'more-title']) assert.match(more, new RegExp(`id="${id}"`), id);
  for (const k of ['more-pins', 'more-glossary', 'more-details']) assert.match(more, new RegExp(`data-fold="${k}"`), k);
  const [play, details] = more.split('data-fold="more-details"');
  assert.doesNotMatch(text(play), INTERNAL, 'nothing of the machinery before the details');
  assert.doesNotMatch(text(play), BANNED_JA, 'none of the banned words before the details');
  // (hud-4, UX design 11.13: the turn sheet — each turn's pipeline and the sponsored actions left — was a card of its
  // own on "More"; it stands under the details now, and its numbers are turns)
  assert.doesNotMatch(play, /id="bell-title"/, 'the turn sheet is not a card of the play screen');
  assert.match(details, /id="bell-title"/, 'the turn sheet stands under More → details');
  const d = text(details);
  for (const w of ['テスト用ビーコン', 'キーパー', 'frontier.wasm', 'ランポート']) assert.ok(d.includes(w), `"${w}" stands under More → details`);
  assert.doesNotMatch(more, /M1/, 'the milestone\'s code name is nowhere');
  assert.doesNotMatch(d, /第[\d,]+鐘|入植希望|精算/, 'the details count turns too, and say 村の申し込み and 結果を受け取る');
  assert.match(String(detailsMarkup(FS)), /data-act="forget"/);
  const sheet = String(bellScreen.render({ ...FS, chain: { now: () => 42 * 600 + 5, offset: () => 0 }, quota: { left: 38 }, bellItems: [{ bell: 42, region: 13, why: 'current' }, { bell: 43, region: 13, why: 'arrival' }] }));
  assert.match(sheet, /id="bell-title">ターンの進み具合<\/h3>/);
  assert.match(sheet, /いまはターン 42/);
  assert.match(sheet, /<strong>ターン 42<\/strong><span class="bell-why">いまのターン · 地域 13<\/span>/);
  assert.match(sheet, /<strong>ターン 43<\/strong><span class="bell-why">あなたの到着/);
  assert.match(sheet, /data-quota-line>.*送れる操作 残り 38 回/s, 'the sponsored actions left, as what the player can still send');
  assert.doesNotMatch(text(sheet), /第[\d,]+鐘|中継 残り|シード|ビーコン待ち/);
  setLang('en');
  const en = text(detailsMarkup(FS));
  assert.doesNotMatch(en, JP, en);
  assert.match(en, /Test beacon/);
  assert.match(en, /keepers/);
  const playEn = text(flat(panelMarkup({ ...FS, tab: 'more' })).split('data-fold="more-details"')[0]);
  assert.doesNotMatch(playEn, BANNED_EN, 'the English play screen keeps the same words out');
  for (const tab of ['holding', 'hosts', 'marches']) assert.doesNotMatch(text(panelMarkup({ ...FS, tab })), BANNED_EN, tab);
  setLang('ja');
});

test('keepState: an opened fold, a chosen picture and typed values survive a re-render of the same view; a new view starts fresh', () => {
  const mk = (tag, o = {}) => ({ tagName: tag, dataset: {}, closest: () => null, matches: () => false, ...o });
  const build = () => {
    const fold = mk('DETAILS', { dataset: { fold: 'v-build' }, open: false });
    const radioA = mk('INPUT', { type: 'radio', name: 'unit', value: '0', checked: true, defaultChecked: true });
    const radioB = mk('INPUT', { type: 'radio', name: 'unit', value: '6', checked: false, defaultChecked: false });
    const num = mk('INPUT', { type: 'number', name: 'n', value: '100', defaultValue: '100' });
    const all = { 'input, select, textarea': [radioA, radioB, num], 'details[data-fold]': [fold] };
    return { fold, radioA, radioB, num, el: { scrollTop: 0, contains: () => false, querySelectorAll: sel => all[sel] ?? [] } };
  };
  let cur = build();
  const el = { get scrollTop() { return cur.el.scrollTop; }, set scrollTop(v) { cur.el.scrollTop = v; }, contains: () => false, querySelectorAll: sel => cur.el.querySelectorAll(sel) };
  cur.fold.open = true; cur.radioA.checked = false; cur.radioB.checked = true; cur.num.value = '250';
  keepState(el, () => { cur = build(); }, el);
  assert.deepEqual([cur.fold.open, cur.radioB.checked, cur.num.value], [true, true, '250'], 'the same view keeps what the player did');
  cur.fold.open = true;
  keepState(el, () => { cur = build(); }, null);
  assert.equal(cur.fold.open, false, 'a different view starts from its own markup');
});
