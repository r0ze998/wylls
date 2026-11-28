// TEST-ONLY local play: "press now, form the host once when ready" for the village's Form a host card (round 21, 2026-11-14).
//
// A recorded ×30 two-person world showed the muster as the weak step of the ordinary path: the bar's button was refused
// about half of each 20 s turn while the province finished the previous turn, and one muster sent while the page said
// "ready" was refused by the program (NotResident, code 26 — the province's resolved turn two or more behind the chain's
// turn), having been sent just as the turn changed. Nothing here loosens a rule: the program's own check is still the gate,
// the order is sent through the same single local-play send (controller.mjs `act` → flocalplay-act.mjs: one attempt, held
// by its signature when the outcome is unknown, never sent again), with the same key.
//
// What changes:
// - the card opens at any time (reading it sends nothing);
// - in local play, ONE press on its confirm arms ONE waiting send of the exact muster shown — the world (local-act scope:
//   wallet, program, Season, relay; and the runner's world instance), village and its generation, unit, troops, tile —
//   frozen as `musterIntentOf`, with the page's herald, local-play identity and signer handle frozen beside it
//   (controller.mjs); all of it is compared at every look and once more right before the send. It is sent once, the first
//   moment the page sees every check pass, and not in the last moments of a turn (`nearTurnEnd`: this lowers the chance
//   that the send lands after the turn changes and is refused; it does NOT promise the turn it lands in — the program's
//   check decides). It is withdrawn (and the player told) when anything of it changes, the card closes, the selected
//   village is not the active one, the local gate closes, the key is gone, the world ends, an earlier muster's outcome is
//   unknown, its turn limit passes, any other reason to refuse appears, or the player cancels. The driver is
//   flocalplay-pending.mjs's (shared with the march's waiting send).
// Memory only: a reload never revives it.

/** Real milliseconds before the next turn in which a waiting send is not sent (it waits for the next turn instead; fewer refusals, no promise). */
export const TURN_END_GUARD_MS = 1500;

/**
 * The muster's identity as one string, or null when anything needed is missing (nothing is armed or sent then).
 * `draft`: the card's `{unit, troops, tile}` (hud/hand.mjs musterDraft, the place defaulting to the village's tile).
 */
export function musterIntentOf({ world, wallet, holding, draft }) {
  if (typeof world !== 'string' || !world || typeof wallet !== 'string' || !wallet || !holding || !draft) return null;
  const int = x => Number.isInteger(x);
  if (!int(holding.p) || !int(holding.q) || !int(holding.site) || !int(draft.unit) || !int(draft.troops) || draft.troops <= 0) return null;
  const tile = int(draft.tile) ? draft.tile : holding.tile;
  if (!int(tile)) return null;
  return JSON.stringify({ kind: 'muster', world, wallet, holding: [holding.p, holding.q, holding.site, holding.gen ?? null], unit: draft.unit, troops: draft.troops, tile });
}

/**
 * Whether the chain's clock is within `guardMs` real milliseconds of the next turn: `nowTs` and `genesisTs` in the chain's
 * seconds, `bellSecs` the length of a turn in those seconds, `rate` the chain's seconds per real second (1 when not
 * accelerated). Unknown input → true (do not send on a guess).
 */
export function nearTurnEnd({ genesisTs, nowTs, bellSecs, rate = 1, guardMs = TURN_END_GUARD_MS }) {
  if (![genesisTs, nowTs, bellSecs, rate].every(Number.isFinite) || bellSecs <= 0 || rate <= 0 || nowTs < genesisTs) return true;
  const into = (nowTs - genesisTs) % bellSecs;
  const leftRealMs = ((bellSecs - into) / rate) * 1000;
  return leftRealMs < guardMs;
}

/** The card's confirm in local play: 'send' (ready now), 'wait' (only the province finishing its turn, or the turn's last moments), or null (refused for another reason: the card says why). */
export function musterPress({ problems, nearEnd, settleCodes }) {
  if (!Array.isArray(problems)) return null;
  if (problems.length === 0) return nearEnd ? 'wait' : 'send';
  return problems.every(p => settleCodes.includes(p)) ? 'wait' : null;
}

/**
 * What the page remembers as "the action sent" (`FS.lastAct`, app.mjs retryLast / hud/status.mjs UNSENT) for a muster sent
 * from the card's confirm — at once or by its waiting send: the muster itself, with the exact unit, troops and tile sent.
 * (fix-loop29, loop-play29 BREAK-1: the confirm's own press `muster-send-wait` is not one of the page's sends, so a muster it
 *  sent AT ONCE and the program refused (NotResident at the turn change) was told as the earlier Train — 「訓練はまだされて
 *  いません」 / "Nothing has been trained yet." — and its "Try again" trained 100 Spearmen. verify-pr98 had fixed this only
 *  for the waiting send.)
 */
export const musterLastAct = draft => ({ kind: 'act', name: 'muster', data: { unit: String(draft.unit), troops: String(draft.troops), tile: String(draft.tile) } });

/**
 * The world and key frozen with a waiting send (controller.mjs musterIdentity): `scope` (flocalplay-act.mjs localActScope:
 * wallet, program, Season, relay), the runner's world `instance`, and the page's `herald`, `localPlay` and `signer` objects
 * (compared by identity: a new connection, a restarted world or a new key makes new ones), and the `wallet` address.
 */
export const sameWorld = (a, b) => !!a && !!b && typeof a.scope === 'string' && a.scope === b.scope && a.instance === b.instance && a.herald === b.herald && a.localPlay === b.localPlay && !!a.signer && a.signer === b.signer && a.wallet === b.wallet;
/** The same village: coordinates, site and generation. */
export const sameHolding = (a, b) => !!a && !!b && a.p === b.p && a.q === b.q && a.site === b.site && (a.gen ?? null) === (b.gen ?? null);

/**
 * Right before the send (and on every look): may the frozen `card` still be sent as it is? → null, or the reason it is
 * withdrawn: 'closed' (another world, relay or key, or none), 'cancel' (the card was closed), 'changed' (the muster, its
 * village, or the active village is not the frozen one). `now`: `{identity, open, pop, intent, holding, active}` as the
 * page is now (`holding`: the card's village; `active`: the village an order is sent for).
 */
export function stillSame(card, now) {
  if (!card || !now || !sameWorld(card.identity, now.identity)) return 'closed';
  if (!now.open) return now.pop === 'muster' ? 'changed' : 'cancel';
  if (now.intent !== card.intent || !sameHolding(card.holding, now.holding) || !sameHolding(card.holding, now.active)) return 'changed';
  return null;
}
