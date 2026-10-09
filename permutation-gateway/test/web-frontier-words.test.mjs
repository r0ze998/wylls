// The words of the play client (UX design 11.13, hud-4): every number is a turn's and the bell is only what tolls;
// the internal words are off the play screen; a place is said by a name before any coordinates; ONE vocabulary for
// what became of a host and of a side, shared by the report, the battle on the map, the marches and the chronicle,
// and a report's headline that agrees with its own numbers; a sealed march names its owner and never a
// destination; the seal in one sentence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setLang } from '../../permutation-server/web/lang.mjs';
import * as fi18n from '../../permutation-server/web/frontier/fi18n.mjs';
import * as place from '../../permutation-server/web/frontier/hud/place.mjs';
import * as rep from '../../permutation-server/web/frontier/screens/report.mjs';
import * as chronicle from '../../permutation-server/web/frontier/screens/chronicle.mjs';
import * as feed from '../../permutation-server/web/frontier/hud/feed.mjs';
import * as inspect from '../../permutation-server/web/frontier/hud/inspect.mjs';
import { sealLine, TERMS } from '../../permutation-server/web/frontier/hud/glossary.mjs';
import { routeLine, routeMinutes } from '../../permutation-server/web/frontier/screens/march.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { placeName } from '../../permutation-server/web/frontier/people/identity.mjs';
import enFrontier from '../../permutation-server/web/lang/en-frontier.mjs';
import enPlay from '../../permutation-server/web/lang/en-frontier-play.mjs';

const WEB = fileURLToPath(new URL('../../permutation-server/web/frontier/', import.meta.url));
const walk = d => readdirSync(d).flatMap(n => { const p = join(d, n); return statSync(p).isDirectory() ? (/[\\/](council|wasm|art)$/.test(p) ? [] : walk(p)) : /\.(mjs|html)$/.test(n) ? [p] : []; });
/** The source lines of the play client that are not comments: `[{file, n, line}]`. */
const lines = () => walk(WEB).flatMap(f => readFileSync(f, 'utf8').split('\n').map((line, i) => ({ file: relative(WEB, f), n: i + 1, line })).filter(x => !/^\s*(\/\/|\*|\/\*)/.test(x.line)));
const hits = (re, allow = []) => lines().filter(x => re.test(x.line) && !allow.some(a => x.file === a)).map(x => `${x.file}:${x.n}  ${x.line.trim().slice(0, 120)}`);

test('every number is a turn\'s: no numbered bell in the client\'s strings or in its English', () => {
  // 第N鐘 / 第${n}鐘 / 鐘 N in a template, in any module or page of the play client
  assert.deepEqual(hits(/第(\$\{[^}]*\}|[\d,]+|\{\d\})鐘|鐘 ?\$\{|鐘 \d/), [], 'a numbered bell');
  // the unnumbered event stays: the toll, "the next bell"
  assert.ok(hits(/鐘が鳴りました/).length >= 1 && hits(/次の鐘/).length >= 1);
  // the period is a turn: 到着のターン, このターン, ターンの始まり — never 到着の鐘, この鐘, 鐘の始まり, 鐘ごと
  assert.deepEqual(hits(/到着の鐘|この鐘|鐘の始まり|鐘の終わり|鐘ごと|前の鐘|いまの鐘|最初の鐘/), [], 'a bell as a period');
  for (const [name, dict] of [['en-frontier', enFrontier], ['en-frontier-play', enPlay]]) {
    for (const [key, value] of Object.entries(dict)) {
      const out = typeof value === 'function' ? `${value(1, 1, 1, 1)} ${value(2, 2, 2, 2)}` : value;
      assert.doesNotMatch(out, /\b[Bb]ells? (\{\d\}|\d)|\bbell's (start|beacon|random)|this bell\b|arrival bell/, `${name} ${JSON.stringify(key)}: a numbered bell, or a bell as a period`);
    }
  }
  // the one line that ties the two, in the help
  setLang('ja');
  assert.match(TERMS.bell.text(), /鐘が鳴るたびにターンが進みます。/);
  assert.equal(TERMS.bell.name(), 'ターンと鐘');
  setLang('en');
  assert.match(TERMS.bell.text(), /Each time the bell tolls, the turn advances\./);
  setLang('ja');
});

test('the internal words are off the play screen: where each may still be said', () => {
  // nowhere at all in the play client's strings
  for (const [re, what] of [[/秘密/, '秘密 (say 封印中)'], [/入植希望/, '入植希望 (say 村の申し込み)'], [/精算/, '精算 (say 結果を受け取る)'], [/顔ぶれ/, '顔ぶれ'], [/ヘラルド/, 'ヘラルド'], [/口座/, '口座'], [/\bM1\b/, 'M1']]) {
    assert.deepEqual(hits(re), [], what);
  }
  // only under "More → details" (app.mjs detailsMarkup, the turn sheet) and in a report's proof
  assert.deepEqual(hits(/ビーコン/, ['app.mjs', 'screens/report.mjs']), [], 'ビーコン outside the details and a report\'s proof');
  assert.deepEqual(hits(/キーパー/, ['app.mjs']), [], 'キーパー outside the details');
  assert.deepEqual(hits(/ランポート/, ['app.mjs', 'screens/shell.mjs']), [], 'ランポート outside the details');
  assert.deepEqual(hits(/L`[^`]*frontier\.wasm/, ['app.mjs']), [], 'frontier.wasm in a string outside the details');
  assert.deepEqual(hits(/L`[^`]*乱数/, ['app.mjs', 'screens/report.mjs', 'screens/bell.mjs', 'fi18n.mjs']), [], '乱数 outside the details, a report\'s proof and rare technical refusals');
  assert.deepEqual(hits(/L`[^`]*区画/), [], '区画');
  // the English says none of them either, outside the entries of the details and the proof
  const detail = /lamport|frontier\.wasm|keeper|[Bb]eacon|[Ss]eed|digest|randomness|quicknet|localnet/;
  for (const [name, dict] of [['en-frontier', enFrontier], ['en-frontier-play', enPlay]]) {
    for (const [key, value] of Object.entries(dict)) {
      const out = typeof value === 'function' ? value(2, 2, 2, 2) : value;
      assert.doesNotMatch(out, /site ticket|\bsecret|Village the tile|by itself|\b(is|are|was|be|been|not|until) settled\b|\bsettl(e|ing) (the|it|a)\b|settlement/i, `${name} ${JSON.stringify(key)}`);
      if (detail.test(out)) assert.match(key, /ビーコン|乱数|ランポート|frontier\.wasm|キーパー|要約|quicknet|ローカルネット|公開の乱数/, `${name} ${JSON.stringify(key)}: an internal word in the English of a play-screen text`);
    }
  }
});

test('a unit with its count, a province in words: names before coordinates', () => {
  setLang('ja');
  assert.equal(fi18n.unitCount('Spearman', 600), '槍兵 600');
  assert.equal(fi18n.unitCount('Scout', 1200), '斥候 1,200');
  assert.equal(fi18n.unitCount(null, 300), '300 兵', 'an unknown unit: the troops alone');
  // a province has no name of its own: the viewer's village in it, else the nation on whose side it lies and its ring
  const FS = { holdings: [{ p: 2, q: 0, site: 3, tier: 1 }] };
  const village = `${placeName(2, 0, 3).ja}の町`;
  assert.equal(place.provinceName(FS, 2, 0), `${village}のある州`);
  assert.equal(place.provinceName(FS, 2, 0, { own: false }), 'アステル方面・第2輪の州', 'for a line that already names the village');
  assert.equal(place.provinceName(FS, 0, 0), '大協約');
  assert.equal(place.provinceName(null, 1, 1), 'アステル方面・第2輪の州');
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(f => place.sideOf(...[[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]][f])), [0, 1, 2, 3, 4, 5], 'one wedge per nation');
  assert.equal(place.sideOf(0, 0), null);
  assert.equal(place.provinceCoords(2, 0), '州 2,0', 'the coordinates, for the details');
  assert.equal(routeLine({ hexes: 4, provinces: [{}], secs: 480 }), '4 マス先');
  assert.equal(routeLine({ hexes: 1, provinces: [{}], secs: 60 }), '1 マス先');
  assert.equal(routeMinutes({ secs: 421 }), 8);
  setLang('en');
  assert.equal(fi18n.unitCount('Spearman', 600), '600 Spearmen', 'English counts a plural: "Spearman 600" was not English');
  assert.deepEqual(['Archer', 'Horseman', 'Pikeman', 'Crossbowman', 'Knight', 'Scout', 'Settler'].map(u => fi18n.unitCount(u, 100)), ['100 Archers', '100 Horsemen', '100 Pikemen', '100 Crossbowmen', '100 Knights', '100 Scouts', '100 Settlers']);
  assert.equal(place.provinceName(FS, 2, 0), `Town of ${placeName(2, 0, 3).en}'s province`);
  assert.equal(place.provinceName(null, 1, 1), 'Aster side, ring 2');
  assert.equal(routeLine({ hexes: 4 }), '4 tiles away');
  assert.equal(routeLine({ hexes: 1 }), '1 tile away');
  setLang('ja');
});

const row = (o = {}) => ({ id: '1', kind: 'arrival', faction: 0, unit: 0, before: 100, after: 100, posture: 0, fate: 'Stays', tile: 5, mine: false, ...o });

test('one outcome vocabulary: a host\'s fate, a side\'s verdict; the report\'s headline agrees with its numbers', () => {
  setLang('ja');
  // one word per outcome of the rules, the same table for the report, the marches, the chronicle and the battle on the map
  assert.deepEqual(['Stays', 'Withdrew', 'Bounced', 'Retreated', 'Destroyed', 'Routed'].map(f => fi18n.FATES[f]), ['戦場に残った', '隣へ退いた', '村へ押し戻された', '撤退した', '壊滅した', '敗走した']);
  for (const f of ['Stays', 'Withdrew', 'Bounced', 'Retreated', 'Destroyed']) assert.equal(fi18n.TRANSIT_OUTCOME_TEXT[f], fi18n.FATES[f], `${f}: the marches and the chronicle say the report's word`);
  const battleSrc = readFileSync(join(WEB, 'fx/battle.mjs'), 'utf8'), appSrc = readFileSync(join(WEB, 'app.mjs'), 'utf8'), cardSrc = readFileSync(join(WEB, 'hud/marchcard.mjs'), 'utf8');
  // (the battle on the map reads the table itself, not a copy of its words)
  assert.match(battleSrc, /fateText: f => FATES\[f\] \?\? null/, 'fx/battle.mjs says the report\'s own table');
  assert.doesNotMatch(battleSrc, /L`(戦場に残った|隣へ退いた|村へ押し戻された|撤退した|壊滅した)`/);
  assert.match(appSrc, /fateText: f => FATES\[f\] \?\? null/, 'the page hands the battle the report\'s table');
  // the forecast says the same words in the future tense
  for (const w of ['戦場に残る', '隣へ退く', '村へ押し戻される', '撤退する', '壊滅する']) assert.ok(cardSrc.includes(`L\`${w}\``), w);
  // a side's verdict: the words the battle's title uses (fx/battle.mjs verdictTitle)
  assert.deepEqual(['won', 'repelled', 'held', 'fell', 'turned', 'lost', 'ruin', 'cleared'].map(k => fi18n.VERDICTS[k]), ['勝利', '撃退', '持ちこたえた', '壊滅', '撤退', '敗北', '共倒れ', '野営地を制圧']);
  // (the title's words are the table's, chosen by the function the report's stamp asks too: people/outcome.mjs)
  assert.match(battleSrc, /title: VERDICTS\[key\]/); assert.match(battleSrc, /VERDICTS\.ruin/); assert.match(battleSrc, /VERDICTS\.cleared/);
  assert.doesNotMatch(battleSrc, /L`(勝利|撃退|壊滅|撤退|敗北|共倒れ|野営地を制圧)`/, 'no second copy of an outcome word in the battle\'s staging');
  const repSrc = readFileSync(join(WEB, 'screens/report.mjs'), 'utf8');
  for (const src of [battleSrc, repSrc]) assert.match(src, /import \{ sideOutcome, verdictKey \} from '\.\.\/people\/outcome\.mjs'/);

  // the headline: the word and the line follow what the rows say became of the other side
  const v = rows => { const s = rep.summaryOf(rows); const x = rep.verdictOf(s); return [s.result, s.role, s.foe, fi18n.VERDICTS[x.key], x.text]; };
  // the review's case: the other side arrived 900 strong and has 0 left. It read 「勝利：相手は退いた」.
  assert.deepEqual(v([row({ mine: true, before: 600, after: 520 }), row({ id: '2', faction: 2, before: 900, after: 0, fate: 'Destroyed' })]), ['won', 'attack', 'destroyed', '勝利', '勝利：相手は壊滅した']);
  // a camp with nothing left: the battle's own words
  assert.deepEqual(v([row({ mine: true, after: 80 }), row({ id: 'c', kind: 'camp', faction: 6, before: 250, after: 0, fate: null })]), ['won', 'attack', 'camp', '勝利', '勝利：野営地を制圧した']);
  // the other side left with troops: the viewer arrived → it withdrew; the viewer was there → the attackers were seen off
  assert.deepEqual(v([row({ mine: true, after: 90 }), row({ id: '2', kind: 'resident', faction: 2, before: 80, after: 60, fate: 'Withdrew' })]), ['won', 'attack', 'left', '勝利', '勝利：相手は退いた']);
  assert.deepEqual(v([row({ mine: true, kind: 'garrison', after: 90, fate: null }), row({ id: '2', faction: 2, before: 80, after: 60, fate: 'Bounced' })]), ['won', 'defend', 'left', '撃退', '撃退：攻め手は退いた']);
  // both hold the field; nothing of the viewer's remains; none of the viewer's stayed
  assert.deepEqual(v([row({ mine: true, kind: 'garrison', after: 80, fate: null }), row({ id: '2', faction: 1, after: 60 })]), ['held', 'defend', 'stays', '持ちこたえた', '持ちこたえた：相手も戦場に残っている']);
  assert.deepEqual(v([row({ mine: true, after: 0, fate: 'Destroyed' }), row({ id: '2', faction: 1, after: 60 })]).slice(3), ['壊滅', '壊滅：あなたの兵は残らなかった']);
  assert.deepEqual(v([row({ mine: true, fate: 'Retreated' }), row({ id: '2', faction: 1, after: 60 })]).slice(3), ['撤退', '撤退：戦場には残らなかった']);
  // the rows name no other side (before a clash is verified only the arrivals are known): no claim about one
  assert.deepEqual(v([row({ mine: true, after: 95 })]), ['won', 'attack', 'none', '着いた', '行き先に着き、戦場に残った']);
  assert.deepEqual(v([row({ mine: true, after: null, fate: null })]).slice(3), ['確認待ち', '結果はまだ確かめていません']);
  assert.equal(rep.verdictOf(rep.summaryOf([row()])).key, 'watch', 'a spectator');
  // the stamp says the verdict's word; its colour is the tone's class
  assert.match(String(rep.stamp('repelled', 'won')), /^<p class="stamp stamp-won"><span class="stamp-in">撃退<\/span><\/p>$/);
  setLang('en');
  assert.deepEqual(['Stays', 'Withdrew', 'Bounced', 'Retreated', 'Destroyed', 'Routed'].map(f => fi18n.FATES[f]), ['Held the field', 'Withdrew', 'Bounced home', 'Retreated', 'Destroyed', 'Routed']);
  assert.deepEqual(['won', 'repelled', 'held', 'fell', 'turned', 'lost', 'ruin', 'cleared'].map(k => fi18n.VERDICTS[k]), ['Victory', 'Repelled', 'Held', 'Destroyed', 'Retreat', 'Defeat', 'Both sides fell', 'Camp cleared']);
  assert.equal(v([row({ mine: true, before: 600, after: 520 }), row({ id: '2', faction: 2, before: 900, after: 0, fate: 'Destroyed' })])[4], 'Victory: the enemy was destroyed', 'it read "Victory: the other side is gone"');
  setLang('ja');
});

test('the chronicle and the notifications: a turn for every number, a name for every place', () => {
  setLang('ja');
  const FS = { holdings: [{ p: 2, q: 0, site: 3, tier: 1 }] };
  const name = placeName(2, 0, 3).ja, host = hostId({ p: 2, q: 0, site: 3, gen: 1, seq: 1 });
  const line = (r, fs = FS) => chronicle.lineOf(r, fs);
  assert.equal(line({ name: 'DEPART', host_id: host, origin_p: 2, origin_q: 0, arrive_bell: 43 }), `${name}の軍勢が出発した（ターン 43 に到着）`, 'a host by its village; no destination, sealed or not');
  assert.equal(line({ name: 'CLASH', p: 2, q: 0, bell: 39 }), `${name}の町のある州で衝突が決着した`, 'the turn is the block\'s stamp: the line does not repeat it');
  assert.equal(line({ name: 'CLASH', p: 1, q: 1, bell: 39 }, null), 'アステル方面・第2輪の州で衝突が決着した');
  assert.equal(line({ name: 'REVEAL', p: 2, q: 0, arrive: 43 }), `${name}の町のある州への到着の封が開けられた（ターン 43）`);
  assert.equal(line({ name: 'SETTLE', p: 2, q: 0, site: 3, outcome: 0 }), `${name}に村ができた`);
  assert.equal(line({ name: 'HOLDING_FINAL', p: 2, q: 0, site: 3 }), `${name}の村が確定した`);
  assert.equal(line({ name: 'TRANSIT_SETTLED', outcome: 4 }), '進軍の結果：壊滅した');
  assert.equal(line({ name: 'JOIN' }), '新しい領主が加わった');
  assert.equal(line({ name: 'CAMP', p: 2, q: 0 }), `${name}の町のある州に蛮族の野営地が現れた`);
  const all = ['RING_OPEN', 'PROVINCE_OPEN', 'JOIN', 'HOLDING_FINAL', 'DEPART', 'REVEAL', 'CLASH', 'TRANSIT_SETTLED', 'EXPLORE_RESULT', 'CAMP']
    .map(n => line({ name: n, d: 2, p: 2, q: 0, site: 3, site_count: 12, host_id: host, origin_p: 2, origin_q: 0, arrive_bell: 43, arrive: 43, bell: 39, outcome: 0, works: 4 })).join(' / ');
  assert.doesNotMatch(all, /第\d+鐘|州 -?\d|精算|入植|市民|開封された/, all);
  // notifications: the same rules (a march's destination by what stands there when the page knows it)
  const snap = (holdings, marches = [], extra = {}) => ({ bell: 42, marches: new Map(marches), builds: new Set(), holdings: new Map(holdings.map(h => [`${h.p},${h.q},${h.site}`, h])), clashes: new Set(), incoming: new Set(), ...extra });
  const h = { p: 2, q: 0, site: 3, state: 1, tier: 0 };
  const m = { pipeline: 'revealing', revealed: false, settle: false, dest: { p: 1, q: 1, tile: 9 }, destName: '蛮族の野営地', bell: 43 };
  const out = feed.diffFeed(snap([h], [['7', m]]), snap([{ ...h, state: 2, tier: 1 }], [['7', { ...m, pipeline: 'resolved', revealed: true, settle: true }]], { clashes: new Set(['2,0,41']), incoming: new Set(['44,2,0']), builds: new Set(['2,0,3,1,100']) }));
  const texts = Object.fromEntries(out.map(x => [x.id.split(':')[0], x.text]));
  assert.equal(texts.rv, '蛮族の野営地への進軍の封が開けられました');
  assert.equal(texts.rs, '蛮族の野営地の衝突が決着しました（ターン 43 の到着）');
  assert.equal(texts.st, '蛮族の野営地への進軍の結果を受け取れます');
  assert.equal(texts.cl, `${name}の町のある州で戦いがありました（ターン 41）`);
  assert.equal(texts.in, `ターン 44 に、${name}の町へ敵が来るかもしれません`);
  assert.equal(texts.bd, `伐採場が完成しました（${name}の町）`);
  assert.equal(texts.hf, `${name}の町が確定しました`);
  assert.equal(feed.diffFeed(snap([]), snap([h]))[0].text, `${name}の集落ができました`);
  assert.equal(feed.diffFeed(snap([h]), snap([{ ...h, tier: 1 }]))[0].text, `${name}の村が町になりました`);
  assert.equal(feed.diffFeed(snap([{ ...h, state: 2 }]), snap([]))[0].text, `${name}の集落を失いました。村の申し込みを自動でもう一度出します。`);
  assert.equal(feed.diffFeed(snap([h]), snap([]))[0].text, `仮の村（${name}の集落）は押し出されました。村の申し込みを自動でもう一度出します。`);
  // a march whose destination this browser does not know: the province in words
  assert.equal(feed.diffFeed(snap([h], [['7', { ...m, destName: null }]]), snap([h], [['7', { ...m, destName: null, revealed: true }]]))[0].text, 'アステル方面・第2輪の州への進軍の封が開けられました');
  for (const x of [...out, ...feed.diffFeed(snap([h]), snap([]))]) assert.doesNotMatch(x.text, /第\d+鐘|州 -?\d|精算|入植希望|開封されました/, x.text);
  setLang('en');
  assert.equal(chronicle.lineOf({ name: 'DEPART', host_id: host, origin_p: 2, origin_q: 0, arrive_bell: 43 }, FS), `A host from ${placeName(2, 0, 3).en} set out (arrives on turn 43)`);
  assert.equal(chronicle.lineOf({ name: 'CLASH', p: 1, q: 1, bell: 39 }, null), 'The clash on the Aster side (ring 2) was resolved');   // (rewritten with wave 3: a place inside a sentence reads as English)
  assert.equal(chronicle.lineOf({ name: 'TRANSIT_SETTLED', outcome: 4 }, null), 'A march ended: Destroyed');
  setLang('ja');
});

test('a sealed march names its owner; the seal is one sentence; the inspector keeps coordinates for its details', () => {
  setLang('ja');
  // who a host is, for the line of a march on the road: the viewer's own by unit and troops, another's by its owner's name
  const own = hostId({ p: 2, q: 0, site: 3, gen: 1, seq: 7 }), other = hostId({ p: 3, q: -1, site: 0, gen: 1, seq: 1 });
  const FS = { holdings: [{ p: 2, q: 0, site: 3, gen: 1, tier: 1 }], provinces: new Map([['2,0', { province: { entries: [{ id: own, unit: 0, troops: 400_000 }] } }]]),
    roster: { ownerOf: (p, q, s) => (p === 3 && q === -1 && s === 0 ? { tag: 9n } : null) } };
  const who = inspect.hostInfoOf(FS);
  // (`dest`, `sealHere`: where it goes when this device's march book holds the copy of its seal; here it holds none)
  assert.deepEqual(who(String(own)), { mine: true, unit: 'Spearman', troops: 400, owner: null, dest: null, sealHere: false });
  assert.equal(inspect.hostInfoOf({ ...FS, book: [{ host: String(own), state: 'settled' }] })(String(own)).sealHere, false, 'a march that is over is not on the road');
  assert.deepEqual((x => [x.sealHere, x.dest])(inspect.hostInfoOf({ ...FS, book: [{ host: String(own), state: 'landed', plain_b64: '!' }] })(String(own))), [true, null], 'a copy that cannot be read names no place');
  const o = who(String(other));
  assert.deepEqual([o.mine, o.unit, typeof o.owner], [false, null, 'string'], 'another player\'s: the owner\'s name, nothing of the host');
  assert.equal(inspect.hostInfoOf({ holdings: [], roster: null })(String(other)).owner, null);
  // the seal's one sentence speaks of who can OPEN the seal (the rule locks it to the end of the arrival turn; the
  // sender's own device may reveal from the start of that turn), and the help says so after it
  assert.equal(sealLine(), '行き先と構えは封印され、到着のターンが終わるまで、ほかの人には開けられません。');
  assert.match(TERMS.seal.text(), /到着のターンが始まると、あなたの端末が先に封を開けることがあります。/);
  for (const f of ['hud/marchcard.mjs', 'map/legend.mjs', 'screens/onboarding.mjs']) assert.match(readFileSync(join(WEB, f), 'utf8'), /sealLine\(\)/, `${f} says the one sentence`);
  setLang('en');
  assert.equal(sealLine(), 'The destination and the stance are sealed: nobody else can open the seal until the arrival turn ends.');
  setLang('ja');
});
