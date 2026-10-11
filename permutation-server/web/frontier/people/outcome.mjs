// What became of a side of a clash, in ONE place (UX design 11.13 and 13.6:
// "one outcome word per result"). The battle on the map (the title across it,
// fx/battle.mjs verdictTitle, and the tag under each side's losses,
// people/battle.mjs), the report (screens/report.mjs summaryOf) and the
// practice result all ask this function, so two of them can never say two
// different things of one result:
//
//   Destroyed   nothing of the side remains           壊滅
//   Stays       some of it holds the field
//   Retreated / Withdrew / Bounced / Routed
//               none of it holds the field and some of it left with troops:
//               the fate of the largest part that left  (撤退 for the side
//               itself; 撃退 for the defender that saw it off)
//   null        not known yet (a record still to be verified)
//
// A side's members are the records' own rows: `{before, after (whole troops,
// or null when not known), fate ('Stays' | 'Withdrew' | 'Bounced' |
// 'Retreated' | 'Destroyed' | 'Routed' | null), kind}`. A garrison or a camp
// has no fate of its own in the record: it stays unless nothing of it is left.
// Pure.

const known = m => m.after !== null && m.after !== undefined;
/** Nothing of this member is left. */
export const memberGone = m => m.fate === 'Destroyed' || (known(m) && m.after === 0);
/** This member holds the field. */
export const memberStays = m => !memberGone(m) && (m.fate === 'Stays' || (!m.fate && known(m)));

/** What became of a side: 'Destroyed' | 'Stays' | the fate of the largest part that left | null (not known yet, or no side). */
export function sideOutcome(members) {
  const list = (members ?? []).filter(Boolean);
  if (!list.length) return null;
  if (list.some(m => !m.fate && !known(m))) return null;
  if (list.every(memberGone)) return 'Destroyed';
  if (list.some(memberStays)) return 'Stays';
  const left = list.filter(m => !memberGone(m)).sort((a, b) => (b.after ?? b.before ?? 0) - (a.after ?? a.before ?? 0))[0];
  return left?.fate ?? null;
}

/**
 * The viewer's result in a clash, from what became of the viewer's side and of the other (`own`, `foe`: sideOutcome
 * values; `foe` undefined when the rows name no other side; `role`: 'attack' | 'defend'; `camp`: the other side was a
 * camp): the key of the word (fi18n.mjs VERDICTS) — 'fell' 壊滅, 'turned' 撤退, 'held' 持ちこたえた, 'won' 勝利,
 * 'repelled' 撃退, 'arrived' 着いた, 'none' 確認待ち.
 */
export function verdictKey({ own, foe, role = 'attack' } = {}) {
  if (own === null || own === undefined) return 'none';
  if (own === 'Destroyed') return 'fell';
  if (own !== 'Stays') return 'turned';
  if (foe === undefined) return role === 'defend' ? 'held' : 'arrived';
  if (foe === null) return 'none';
  if (foe === 'Stays') return 'held';
  if (foe === 'Destroyed') return 'won';
  return role === 'defend' ? 'repelled' : 'won';
}
