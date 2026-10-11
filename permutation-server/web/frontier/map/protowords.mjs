// What the board says of the banner rule's PROTOTYPE (PROTOTYPE-SPEC.md
// section 7; a design, not in the program). Every sentence here is said only
// while the prototype is on (`sample.proto.claims` in the season record) and
// the label of section 1 is on screen; a tip, a plate line or a list entry
// begins with the tag 「試作」.
//
// Counts are said in TURNS (the page's word for a bell's turn; the lead's
// amendment B), with the clock time beside a count that is longer than one
// turn. No number of the rule is written here: a count comes from a record
// (two turns of a banner's record, the preview route's `waitTurns`, the
// viewer's own `perProvince`), a clock time from the season record's
// `sample.turnSecs`.
import { L, fmtNum } from '../../lang.mjs';
import { factionName } from '../fi18n.mjs';

/** The tag every line of the prototype begins with. */
export const protoTag = () => L`試作`;
/** A line with the tag before it. */
export const tagged = text => (text ? `${protoTag()} · ${text}` : '');

/** How long `turns` turns last by the clock, said as it is (a sample world's turn is short): "約9分", or '' without a turn's length. */
export function aboutTime(turns, turnSecs) {
  const s = Number(turns) * Number(turnSecs);
  if (!(s > 0) || !Number.isFinite(s)) return '';
  if (s < 90) return L`約${fmtNum(Math.round(s))}秒`;
  if (s < 5400) return L`約${fmtNum(Math.round(s / 60))}分`;
  const h = Math.floor(s / 3600), m = Math.round((s - h * 3600) / 60);
  return m ? L`約${fmtNum(h)}時間${fmtNum(m)}分` : L`約${fmtNum(h)}時間`;
}
const withTime = (text, turns, turnSecs) => { const t = turns > 1 ? aboutTime(turns, turnSecs) : ''; return t ? L`${text}（${t}）` : text; };
/** A game day in turns (the basic game's clock: a turn is 600 s of the game's day of 86,400 s). */
const TURNS_A_DAY = 86_400 / 600;
/** A count of turns as whole game days, or 0 when it is not a whole number of them (then the sentence names no count). */
const wholeDays = turns => (turns > 0 && Number.isInteger(turns / TURNS_A_DAY) ? turns / TURNS_A_DAY : 0);

export const PROTO_WORDS = Object.freeze({
  villageLand: n => L`村の土地 ${fmtNum(n)}マス`,
  canRise: () => L`旗を立てられる土地`,
  /** The preview on a candidate tile: 「+7マス・1ターン」. */
  // (no turns left to stand: only what the banner would bring; 「0ターン」 said nothing)
  gain: (n, turns, turnSecs) => (turns > 0 ? withTime(L`+${fmtNum(n)}マス・${fmtNum(turns)}ターン`, turns, turnSecs) : L`+${fmtNum(n)}マス`),
  trail: () => L`歩いた跡（この軍勢が旗を立てると、一緒に土地になります）`,
  trailShort: () => L`歩いた跡：旗と一緒に土地になります`,
  rising: (turns, turnSecs) => withTime(L`あと${fmtNum(turns)}ターンで旗を立てられます`, turns, turnSecs),
  risingReady: n => (n > 0 ? L`旗を立てられます（+${fmtNum(n)}マス）` : L`旗を立てられます`),
  raised: n => L`+${fmtNum(n)}マス あなたの土地になりました`,
  dressed: n => L`+${fmtNum(n)}マス 旗の土地が広がりました`,
  yoursFirm: every => { const d = wholeDays(every); return d > 1 ? L`あなたの旗（しっかり立っています・${fmtNum(d)}日に1回見回り）` : d === 1 ? L`あなたの旗（しっかり立っています・1日1回見回り）` : L`あなたの旗（しっかり立っています）`; },
  yoursLoose: every => { const d = wholeDays(every); return d > 1 ? L`あなたの旗（他国の州：${fmtNum(d)}日に1回の見回りが必要）` : d === 1 ? L`あなたの旗（他国の州：1日1回の見回りが必要）` : L`あなたの旗（他国の州）`; },
  border: turns => (turns > 0 ? L`国境に触れています：向かいの国には${fmtNum(turns)}ターンで取られます` : L`国境に触れています：向かいの国に取られやすい旗です`),
  mate: name => (name ? L`同じ国の${name}の旗` : L`同じ国の仲間の旗`),
  commonsOurs: () => L`国の共有地（まだ誰の旗もありません）`,
  commonsOf: f => L`${factionName(f)}の共有地`,
  bannerOf: f => L`${factionName(f)}の旗`,
  villageOf: f => L`${factionName(f)}の村の土地`,
  // (`pull`: the record says the host on the pole can only pull the banner down there: said as that)
  threat: (turns, turnSecs, pull = false) => withTime(pull ? L`あなたの旗が狙われています。あと${fmtNum(turns)}ターンで倒されます` : L`あなたの旗が狙われています。あと${fmtNum(turns)}ターンで取られます`, turns, turnSecs),
  threatReady: (pull = false) => (pull ? L`あなたの旗が狙われています。いつ倒されてもおかしくありません` : L`あなたの旗が狙われています。いつ取られてもおかしくありません`),
  enemyRising: (f, turns) => (turns > 0 ? L`${factionName(f)}の旗が立ちそうです（あと${fmtNum(turns)}ターン）` : L`${factionName(f)}の旗がいまにも立ちます`),
  walkSoon: turns => L`あと${fmtNum(turns)}ターンのうちに見回ってください（新しく着いた軍勢で）`,
  frayed: turns => (turns > 0 ? L`ほつれています：いまは得点になりません。${fmtNum(turns)}ターンのうちに見回れば戻ります` : L`ほつれています：いまは得点になりません`),
  taking: (turns, turnSecs) => withTime(L`あと${fmtNum(turns)}ターンで、この旗を取るか倒せます`, turns, turnSecs),
  takingReady: () => L`この旗を取るか倒せます`,
  pulled: n => L`あなたの旗が倒されました（−${fmtNum(n)}マス）`,
  taken: f => L`あなたの旗が${factionName(f)}に取られました`,
  // (one sentence for one event, the notice's too — proto/hand-model.mjs newsOf: the board said 朽ちました and the notice 片づけられました)
  lapsed: n => L`見回りがなく、あなたの旗がなくなりました（−${fmtNum(n)}マス）`,
  struck: n => L`旗を取り下げました（−${fmtNum(n)}マス）`,
  tookTheirs: n => L`旗を取りました（+${fmtNum(n)}マス）`,
  pulledTheirs: () => L`旗を倒しました`,
  turnsLeft: (n, turnSecs = null) => withTime(L`あと${fmtNum(n)}ターン`, n, turnSecs),
});

/**
 * Why a banner cannot rise on a tile (the preview route's refusal `{ok: false, code, need, why}`), as the tile says
 * it. `me`: the viewer's own record of the prototype (`perProvince`, `cap`, its banners), for the counts.
 */
export function refusalWords(answer, me = null) {
  // (`need` is the route's own detail: `{why}`, `{troops, have}`, `{cap, held}`, `{perProvince}`, `{works, have, short}`, `{tolls, atTurn}`; a bare number is taken as the count)
  const code = String(answer?.code ?? ''), nd = answer?.need, o = nd && typeof nd === 'object' ? nd : {};
  const n = (...keys) => { for (const k of keys) if (Number.isFinite(Number(o[k])) && o[k] !== null) return Number(o[k]); return typeof nd === 'number' ? nd : NaN; };
  const why = String(answer?.why ?? o.why ?? (typeof nd === 'string' ? nd : '')).toLowerCase();
  switch (code) {
    case 'NotSurveyed': return L`まだ測量していません（進軍して着けば測量は要りません）`;
    case 'Heartland': return L`他国の中核地です`;
    case 'NotHere':
      if (/heart/.test(why)) return L`他国の中核地です`;
      if (/town/.test(why)) return L`町になってから`;
      return L`わたしたちの土地に接していません`;
    case 'PerProvince': { const k = Number.isFinite(n('perProvince')) ? n('perProvince') : me?.perProvince; return Number.isInteger(k) ? L`この州の旗は${fmtNum(k)}本までです：次の旗は別の州へ` : L`この州にはもう旗を立てられません：次の旗は別の州へ`; }
    case 'CapReached': { const cap = Number.isFinite(Number(o.cap)) ? Number(o.cap) : me?.cap, held = Number.isFinite(Number(o.held)) ? Number(o.held) : me?.banners?.length ?? cap; return Number.isInteger(cap) ? L`旗はもう立てられません（${fmtNum(held)}/${fmtNum(cap)}）` : L`旗はもう立てられません`; }
    case 'WorksShort': return n('short') > 0 ? L`Works があと${fmtNum(n('short'))}足りません` : L`Works が足りません`;
    case 'TooFew': return n('troops') > 0 ? L`兵が足りません（${fmtNum(n('troops'))}人から）` : L`兵が足りません`;
    case 'Scouts': return L`斥候は旗を立てられません`;
    case 'NotOpen': return /impass/.test(why) ? L`ここは通れない土地です` : /enemy/.test(why) ? L`敵の軍勢が立っています` : L`すでに誰かの土地です`;
    case 'Denied': return L`敵の軍勢が近すぎます`;
    case 'SiteOrCamp': return L`村の用地や野営地には立てられません`;
    case 'SiteRoom': return L`この村の用地のそばは、もう旗でいっぱいです`;
    case 'PatchTooSmall': return L`土地が狭すぎます`;
    case 'CeilingReached': return L`この州で国が持てる土地の上限です`;
    case 'SlotsFull': return L`この州にはもう旗を立てられません`;
    case 'StandLonger': return n('tolls') > 0 ? L`あと${fmtNum(n('tolls'))}ターン立てば旗を立てられます` : L`もう少し立っていれば旗を立てられます`;
    case 'HostBusy': case 'InTransit': case 'NotResident': return L`この軍勢はいま動けません`;
    default: return L`ここには旗を立てられません`;
  }
}
/** The small glyph of a refusal on its tile (hud/icons.mjs names; the board draws its own shapes for them): what kind of reason it is. */
export function refusalGlyph(answer) {
  const code = String(answer?.code ?? '');
  if (code === 'NotSurveyed') return 'eye';
  if (code === 'WorksShort' || code === 'TooFew') return 'short';
  if (code === 'PerProvince' || code === 'CapReached' || code === 'CeilingReached' || code === 'SlotsFull' || code === 'SiteRoom') return 'full';
  return 'bar';
}

/** The legend's entries for the prototype (map/legend.mjs shows them only while it is on): `[{id, name(), text()}]`. */
export const PROTO_LEGEND = Object.freeze([
  { id: 'yours', name: () => L`あなたの土地`, text: () => L`国の色の帯と金の線で囲んだ内側が、あなたの村の土地と、あなたの旗の土地です。旗を立てるたびに、金の線がひとつにつながります。` },
  { id: 'banner', name: () => L`旗`, text: () => L`軍勢が立っていた場所に立てる旗です。金の飾りがあなたの旗。布がはためく旗は他国の州に立てたもの、動かない旗は自国の州のものです。` },
  { id: 'commons', name: () => L`国の共有地`, text: () => L`まだ誰の旗もない土地です。その州を持つ国の色で、淡い斜線を引いています。` },
  { id: 'rise', name: () => L`旗を立てられる土地`, text: () => L`金の点線で囲んだマスです。軍勢がそこに立ちつづけると、旗を立てられます（何ターン要るかは、そのマスに出ます）。` },
  { id: 'threat', name: () => L`狙われている旗`, text: () => L`赤い輪が1ターンごとに進みます。輪が閉じる前に軍勢を送れば守れます。` },
  { id: 'frayed', name: () => L`ほつれた旗`, text: () => L`見回りが遅れた旗です。土地は斜線になり、見回るまで得点になりません。` },
]);
/** The legend's one line of section 1 (the record's own label is the chip; this is the sentence under the legend's entries). */
export const protoLegendLine = () => L`旗の土地・国の共有地・村の土地の色分けは、設計中の「旗のルール」の試作です。`;
