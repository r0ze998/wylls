// Workstream 07, claim 2 of the brief: can a siege the program will refuse be
// told before it is sent?
//
// screens/s1.mjs siegeOffer already blocks: the target in its owner's
// heartland, the target under its shield, no fighting host on the tile, the
// stake and arms short, the day's two sieges used. The program
// (permutation-frontier proc/conquest.rs declare_siege) refuses more, and
// three of those the page can tell from records it already holds:
//   SourceShielded   step 8: "the declarer's source Holding must not be
//                    shielded unless dormant" — a new player's own village
//                    is shielded for the season's shield time, and the
//                    player acting now is not dormant
//   SiegeBusy        step 5: the site's conquest record is not empty (a
//                    siege, an occupation or a capture under way)
//   StakeUnsettled   step 5: an empty record that still owes a stake
// The rest the page cannot judge from what it holds, and says so instead of
// guessing: the immunity after a capture (`Immune`), the lead host on the
// tile (`NotLead`), the frontier protection of a late village
// (`FrontierProtected`), the free capture slot (`HoldingsFull`) and whether
// the siege can end before the season does (`TooLate`).

/** Province v2 conquest record kinds and flags (frontier-abi layout province conquest_record). */
export const CR = Object.freeze({ KIND_NONE: 0, KIND_SIEGE: 1, KIND_OCCUPATION: 2, KIND_CAPTURE_DUE: 3, OWED_MASK: (1 << 1) | (1 << 2) | (1 << 5) });
/** The program's checks the page cannot make before the send (named in the card). */
export const SIEGE_UNJUDGED = Object.freeze(['Immune', 'NotLead', 'FrontierProtected', 'HoldingsFull', 'TooLate']);

/**
 * The blocks to add to siegeOffer's for `offer` (its `{site, src}`):
 * `[{code, until?}]`. `now` the chain's seconds; the source Holding is the
 * viewer's own (FS.holdings).
 */
export function siegeExtraBlocks(FS, sel, offer, now = Number(FS.chain?.now?.() ?? 0)) {
  if (!offer) return [];
  const out = [];
  const src = offer.src ? (FS.holdings ?? []).find(h => h.p === offer.src.p && h.q === offer.src.q && h.site === offer.src.site) : null;
  if (src && Number(src.shieldUntil ?? 0) > now) out.push({ code: 'SourceShielded', until: Number(src.shieldUntil) });
  const prov = FS.provinces?.get?.(`${sel.p},${sel.q}`)?.province ?? null;
  const rec = prov?.conquest?.[offer.site] ?? null;
  if (rec && Number(rec.kind) !== CR.KIND_NONE) out.push({ code: 'SiegeBusy', kind: Number(rec.kind) });
  else if (rec && (Number(rec.flags) & CR.OWED_MASK) !== 0) out.push({ code: 'StakeUnsettled' });
  return out;
}

/** Japanese and English words for the blocks and for what is left to the program (the connection patch adds them to the dictionary). */
export const SIEGE_WORDS = Object.freeze({
  SourceShielded: { ja: 'あなたの村がまだ保護期間中です。保護が終わるまで、ほかの村を包囲できません', en: 'Your village is still under its shield. You cannot besiege until it ends' },
  SiegeBusy: { ja: 'この村ではすでに包囲か占領が進んでいます', en: 'A siege or occupation of this village is already under way' },
  StakeUnsettled: { ja: '前の包囲の賭け金の行き先がまだ決まっていません', en: 'Where the stake of the last siege here goes is not decided yet' },
  unjudged: { ja: '宣言したあとにプログラムが判定すること：占領後の免除、先頭の軍勢、遅れて置かれた村の保護、奪う枠の空き、シーズン終了までに終わるか', en: 'Judged by the program after you declare: immunity after a capture, the lead host, a late village\'s protection, a free capture slot, and whether it can end before the season does' },
});
