// Workstream 07, brief item 4 (and claim 5): the season's times and terms read
// from the season, never written into the words.
//
// A turn is BELL_SECS (600) seconds of the chain's clock (clock.mjs, the
// program's travel.rs); the season ends at its `endBell` and takes joins
// until its `joinCloseBell` (Season account; frontier-abi presets: the
// 14-day S1 preset ends at 2,016 turns and closes joins at 1,512). On a
// local world the chain's clock may run faster (`FS.chain.rate`, the
// stack's --scale): there a turn lasts 600 / rate real seconds. The page
// today writes "10分ごと" in its glossary, its first card and its title,
// and nowhere says when joining closes (the program then answers
// WrongStatus, which the page words as "シーズンがこの操作をできる状態ではありません").
import { BELL_SECS, BELLS_PER_DAY, bellStart } from '../../../permutation-server/web/frontier/clock.mjs';
import { TOWER_WEAR_BPS_PER_MIN, TOWER_WEAR_CAP_BPS, TOWER_RANGE } from './s1walk.mjs';
import { SLOT_TILES } from './caravan-preview.mjs';

/** Seconds in words, at the scale they are long ("約 3 時間", "1 分", "15 秒"). */
export function spanText(secs, lang = 'ja') {
  const s = Math.max(0, Math.round(secs)), ja = lang !== 'en';
  const unit = (n, j, e) => (ja ? `${n.toLocaleString('ja')} ${j}` : `${n.toLocaleString('en')} ${e}${n === 1 ? '' : 's'}`);
  if (s < 90) return unit(s, '秒', 'second');
  if (s < 90 * 60) return unit(Math.round(s / 60), '分', 'minute');
  if (s < 48 * 3600) return unit(Math.round(s / 3600), '時間', 'hour');
  return unit(Math.round(s / 86400), '日', 'day');
}

/**
 * The season's times: `{turn: {gameSecs, realSecs, accelerated}, season:
 * {bells, gameDays}, join: {closeBell, closed, realLeft}, end: {bell,
 * ended, realLeft}, nowBell}`. `season`: the decoded Season (`genesisTs`,
 * `endBell`, `joinCloseBell`); `chain`: `{now(), rate}`.
 */
export function seasonTimes(season, chain) {
  const rate = Math.max(1, Number(chain?.rate) || 1), now = Number(chain?.now?.() ?? 0), g = Number(season.genesisTs);
  const nowBell = Math.max(0, Math.floor((now - g) / BELL_SECS));
  const left = bell => Math.max(0, (bellStart(g, bell) - now) / rate);
  const endBell = Number(season.endBell), closeBell = Number(season.joinCloseBell ?? endBell);
  return {
    turn: { gameSecs: BELL_SECS, realSecs: BELL_SECS / rate, accelerated: rate > 1, rate },
    season: { bells: endBell, gameDays: endBell / BELLS_PER_DAY },
    join: { closeBell, closed: nowBell >= closeBell, realLeft: left(closeBell) },
    end: { bell: endBell, ended: nowBell >= endBell, realLeft: left(endBell) },
    nowBell,
  };
}

/** The turn in words: game time, and the real time when the world runs faster. */
export function turnText(t, lang = 'ja') {
  const game = spanText(t.turn.gameSecs, lang);
  if (!t.turn.accelerated) return lang === 'en' ? `A turn is ${game}.` : `1ターンは${game}です。`;
  return lang === 'en' ? `A turn is ${game} of game time — in this world, ${spanText(t.turn.realSecs, 'en')} of real time (the clock runs ${t.turn.rate}× faster).`
    : `1ターンはゲーム内の${game}です。この世界では時計が ${t.turn.rate} 倍で進むため、実時間では約 ${spanText(t.turn.realSecs)}です。`;
}

/** The join deadline and the season's end in words. */
export function deadlineText(t, lang = 'ja') {
  const ja = lang !== 'en', n = x => Number(x).toLocaleString(ja ? 'ja' : 'en');
  const join = t.join.closed ? (ja ? `参加の受付は第${n(t.join.closeBell)}ターンで締め切られました。` : `Joining closed at turn ${n(t.join.closeBell)}.`)
    : (ja ? `参加の受付は第${n(t.join.closeBell)}ターンまで（あと約 ${spanText(t.join.realLeft)}）。` : `Joining closes at turn ${n(t.join.closeBell)} (in about ${spanText(t.join.realLeft, 'en')}).`);
  const end = t.end.ended ? (ja ? 'シーズンは終わりました。' : 'The season has ended.')
    : (ja ? `シーズンは第${n(t.end.bell)}ターンで終わります（あと約 ${spanText(t.end.realLeft)}）。` : `The season ends at turn ${n(t.end.bell)} (in about ${spanText(t.end.realLeft, 'en')}).`);
  return `${join}${ja ? '' : ' '}${end}`;
}

/** The program's WrongStatus said with its cause when the cause is the season's clock (join after the deadline, any order after the end). */
export function whyWrongStatus(t, action, lang = 'ja') {
  const ja = lang !== 'en', n = x => Number(x).toLocaleString(ja ? 'ja' : 'en');
  if (t.end.ended) return ja ? `シーズンは第${n(t.end.bell)}ターンで終わったため、この操作はできません。` : `The season ended at turn ${n(t.end.bell)}; this order is no longer taken.`;
  if (action === 'join' && t.join.closed) return ja ? `参加の受付は第${n(t.join.closeBell)}ターンで締め切られました。` : `Joining closed at turn ${n(t.join.closeBell)}.`;
  return null;
}

/**
 * The S1 terms a first card and the glossary teach, each with its number
 * from the rules module this page carries (never typed in the sentence).
 * `[{key, ja, en}]`.
 */
export function s1Terms(t) {
  const turn = spanText(t.turn.gameSecs);
  return [
    { key: 'turn', ja: `ターン：${turn}ごとの区切り。同じターンに着いた進軍は一度に戦います。`, en: `Turn: every ${spanText(t.turn.gameSecs, 'en')} of game time. Marches arriving in one turn fight together.` },
    { key: 'caravan', ja: `隊商：村と貯蔵庫のあいだで物を運びます。道は誰にでも見え、ターンの始めに他国の軍勢と同じマスにいると襲われます（村・要塞・野営地のマスでは戦いに入りません）。同じ国の別の村の軍勢も、国内の略奪として襲えます。一つの州に ${SLOT_TILES} ターンより長く留まる道は送れません。`, en: `Caravan: carries goods between your places on a road anyone can see. At a turn's start, a host of another nation on its tile raids it (not on a village, fort or camp tile); a host of another village of your own nation may raid it too. A road that would stay over ${SLOT_TILES} turns in one province is refused.` },
    { key: 'tower', ja: `物見櫓：まわり ${TOWER_RANGE} マスを見張ります。戦争中の国の進軍と隊商は、そこを歩いた 1 分ごとに ${TOWER_WEAR_BPS_PER_MIN / 100}% 減ります（最大 ${TOWER_WEAR_CAP_BPS / 100}%）。`, en: `Watchtower: watches ${TOWER_RANGE} tiles around it. Marches and caravans of a nation at war lose ${TOWER_WEAR_BPS_PER_MIN / 100}% per minute walked there (at most ${TOWER_WEAR_CAP_BPS / 100}%).` },
    { key: 'palisade', ja: '柵：戦争中の国と、自国が追放した村の進軍と隊商を通しません。柵を通る道で送った進軍は、封が開くときに認められません。', en: 'Palisade: stops marches and caravans of nations at war and of villages your nation expelled. A march sealed along a road through one is refused when its seal opens.' },
    { key: 'fort', ja: '要塞：兵を置くと、そのマスに来たほかの国の軍勢と城壁つきで戦います。', en: 'Fort: once manned, fights every other nation\'s host on its tile, behind walls.' },
    { key: 'arms', ja: '兵器：工房が鉱石と木材から作ります。槍兵・弩兵・騎士の訓練と、包囲の宣言に使います。', en: 'Arms: made by workshops from ore and wood; used to train pikemen, crossbowmen and knights and to declare a siege.' },
    { key: 'stance', ja: '国の方針：村ごとに一票で、ほかの国を戦争・通行・同盟のどれと見るかを決めます。方針は物見櫓と柵が誰を止めるかを決めます。', en: 'Stance: each village has one vote on whether another nation is at war, passage or alliance; it decides whom towers and palisades stop.' },
  ];
}
