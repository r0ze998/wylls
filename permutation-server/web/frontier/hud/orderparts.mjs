// Small pieces every order shows the same way (UX design 14.2), shared by
// the hand (hud/hand.mjs) and the village drawer (screens/holding.mjs): a
// cost as resource marks with what is short said in ink, what a unit is
// good at (one sentence per kind, each from the rules), why an order
// cannot be given now in the rule's own numbers, and how long something
// takes. Pure: text and markup from numbers.
import { html } from '../../util.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { RESOURCES, RESOURCE_ORDER, TIERS, errorText } from '../fi18n.mjs';
import { countdown, bellAt } from '../clock.mjs';
import { ticketTimes } from '../fland.mjs';
import { icon, RESOURCE_ICON } from './icons.mjs';
import { UNIT_STATS, QUEUE_SLOTS, TRANSIT_SLOTS, WALLS } from './rulebook.mjs';

/** A length of time in words: "12:30" under an hour, "1時間30分" under a day, else days (hud/hud.mjs `span`, kept here so the drawer's cards need not load the HUD). */
export function took(secs) {
  const s = Math.max(0, Math.ceil(secs));
  if (s < 3600) return countdown(s);
  if (s < 86_400) return s % 3600 < 60 ? L`${Math.floor(s / 3600)}時間` : L`${Math.floor(s / 3600)}時間${Math.floor((s % 3600) / 60)}分`;
  return L`${Math.floor(s / 86_400)}日`;
}

/**
 * The turn in which the result of an exploration is drawn, for an Explore of turn `bell` (M1-CONTRACT 5.10): its
 * tiles are judged with that turn's own seed, which can be read once the turn has ended and its window and margin have
 * passed (the times of a village request: fland.mjs ticketTimes) — a minute into the turn after next, not "after the
 * next bell". Null where the season's clock is not known.
 */
export function exploreResultTurn(FS, bell = FS?.nowBell) {
  try { return FS?.clock && Number.isInteger(bell) ? bellAt(FS.clock.genesisTs, ticketTimes(FS.clock, bell).resultAbout) : null; } catch { return null; }
}
/** When an exploration's result comes, in words: 「結果はターン 44 のはじめに出ます」 (null turn: that it follows that turn). */
export const exploreResultWords = turn => (Number.isInteger(turn) ? L`結果はターン ${fmtNum(turn)} のはじめに出ます` : L`結果は、探索したターンの決着のあとに出ます`);
/** The same as a sentence of its own (a card's line). */
export const exploreResultLine = turn => (Number.isInteger(turn) ? L`結果はターン ${fmtNum(turn)} のはじめに出ます。` : L`結果は、探索したターンの決着のあとに出ます。`);

/** A cost in words: 「木材 80 · 石材 40」 (`cost` by resource, kernel order, whole units). */
export const costWords = cost => (cost ?? []).map((c, i) => (c ? `${RESOURCES[RESOURCE_ORDER[i]]} ${fmtNum(c)}` : null)).filter(Boolean).join(' · ');

/**
 * A cost as marks: each resource's icon and amount; an amount the stores `have` (by resource index) do not hold is
 * marked short (ink and a small mark, never colour alone). The words are the group's name for a screen reader.
 */
export function costChips(cost, have = null) {
  const parts = (cost ?? []).map((c, i) => ({ c, i })).filter(x => x.c > 0);
  if (!parts.length) return html`<span class="cost cost-free">${L`費用なし`}</span>`;
  return html`<span class="cost" role="img" aria-label="${L`費用：${costWords(cost)}`}">${parts.map(({ c, i }) => {
    const short = have !== null && c > (have[i] ?? 0);
    return html`<span class="cost-i${short ? ' cost-short' : ''}" aria-hidden="true">${icon(RESOURCE_ICON[RESOURCE_ORDER[i]] ?? 'crate', `res-c-${RESOURCE_ORDER[i]}`)}<span class="num">${fmtNum(c)}</span></span>`;
  })}</span>`;
}

/** What the stores lack, in words: 「足りない：木材 40 · 金 10」 (`short`: [{resource | r, need}]). */
export const shortWords = short => L`足りない：${short.map(x => `${RESOURCES[x.resource ?? RESOURCE_ORDER[x.r]]} ${fmtNum(x.need)}`).join(' · ')}`;

/**
 * What a unit is good at, one sentence per kind, each from the rules:
 *   the class and what it beats        permutation-rules/src/units.rs  UNIT_STATS (class), counters(): melee beats mounted,
 *                                      ranged beats melee, mounted beats ranged; ×1.5: combat.rs COUNTER = 15,000 bps
 *   the strength per troop             units.rs UNIT_STATS (strength: 10, 22, 0)
 *   half the marching time             permutation-rules/src/frontier/travel.rs: "Cavalry (mounted units) ×0.5"
 *   a Scout explores, does not fight   M1-CONTRACT 5.10 Explore (a Scout host only); units.rs strength 0
 * `unit` is the kernel's index (0–6).
 */
export function unitGood(unit) {
  switch (UNIT_STATS[unit]?.unit) {
    case 'Spearman': return L`近接。騎兵に強い（1.5倍）。`;
    case 'Archer': return L`射撃。近接に強い（1.5倍）。`;
    case 'Horseman': return L`騎兵。射撃に強い（1.5倍）。進軍の時間が半分。`;
    case 'Pikeman': return L`上位の近接。騎兵に強い（1.5倍）。`;
    case 'Crossbowman': return L`上位の射撃。近接に強い（1.5倍）。`;
    case 'Knight': return L`上位の騎兵。射撃に強い（1.5倍）。進軍の時間が半分。`;
    case 'Scout': return L`戦いません。となりのマスを探索できます。`;
    default: return '';
  }
}
/** A unit's strength per troop as a short mark: 「強さ 10」; a Scout has none. */
export const unitStrength = unit => { const s = UNIT_STATS[unit]?.strength ?? 0; return s > 0 ? L`強さ ${fmtNum(s)}` : L`強さ なし`; };

/**
 * Why an order cannot be given now, as the rule says it (a refusal names the rule: UX design 14.2). `code` is the
 * program's error name (fi18n ERROR_TEXT is the fallback); `x` carries the numbers a sentence needs.
 */
export function whyText(code, x = {}) {
  switch (code) {
    case 'QueueFull': return Number.isInteger(x.tier) ? (x.freeIn > 0 ? L`建設は同時に ${QUEUE_SLOTS[x.tier]} つまで（${TIERS[x.tier]}）。あと ${took(x.freeIn)} で空きます` : L`建設は同時に ${QUEUE_SLOTS[x.tier]} つまで（${TIERS[x.tier]}）`) : errorText(code);
    case 'Promoting': return L`昇格は一度にひとつです`;
    case 'TopTier': return L`いちばん上の段階です`;
    case 'AboveCap': return x.walls ? L`城壁はこれ以上高くできません（${fmtNum(WALLS.max)} まで）` : L`これ以上は増やせません`;
    case 'Insufficient': return x.short?.length ? shortWords(x.short) : errorText(code);
    case 'NotFinal': return L`村が確定してからです`;
    case 'NoReserve': return L`控えの兵がいません：先に訓練しましょう`;
    case 'Forming': return L`編成中です。次のターンから動かせます`;
    case 'Resting': return L`ターン ${fmtNum(x.turn)} まで休息です`;
    case 'Stamina': return L`体力 ${fmtNum(x.stamina)}/${fmtNum(x.need)} — ターン ${fmtNum(x.turn)} から`;
    case 'MarchSlots': return L`進軍は同時に ${TRANSIT_SLOTS} つまでです`;
    case 'AtHome': return L`村にいます`;
    case 'NoTargets': return L`となりに、まだ調べていないマスがありません`;
    case 'Explored': return L`前の探索の結果を待っています`;
    case 'OnlyOne': return L`ほかに軍勢はいません`;
    case 'HostInTransit': return L`進軍の結果を受け取るまで動かせません`;
    default: return errorText(code);
  }
}
