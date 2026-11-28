// The walletless demo's single-player goal (owner r0ze 2026-11-28 14:32, Option A "本番の縮小版"): the real flag-keeps
// win condition, compressed. PURE: no world, no clock, no DOM — liveworld.mjs (option `goal`) keeps the state and calls
// these; the tests compare them with the real judge.
//
// The real rule (code wins: permutation-gateway/src/frontier/world-goals.mjs `needOf`, `countsFor`, `progressOf`,
// `achievementOf`; on chain permutation-prize/src/goals.rs `judge_flags`):
//   - flag keeps are drawn per nation from its own keeps; a nation's OWN starting flag keeps never count for it
//     (flag-keeps-v2), even when it lost one and took it back;
//   - need = half of all the flag keeps, rounded up, but never more than the flags a nation could capture (k − most own);
//   - a captured flag counts from max(its holder's since, the bell the round was posted) and is "held long" `holdBells`
//     later (144 bells = 24 h); losing it resets it (a new holder has a new since);
//   - a nation achieves at the bell its need-th captured flag is held long; nations at the same bell tie.
// The demo's compression (each number is DEMO_GOAL below, reported in reports/demo-solo-goal.md):
//   - ONE flag castle per nation (6), each in the nation's ring-1 province (one ring-1 province per wedge, as the
//     local worlds' round 1 draws only ring-1 keeps), so need = 3 — "half of all" and "half of the rivals' 5" agree;
//   - the castle is the tile nearest the province's centre that a host can stand on; its holder is the tile's owner,
//     and castle tiles are the only tiles that change hands by conquest (screens/territory.mjs `arrival: [castle tiles]`:
//     after a resolve, a lone surviving host of one nation takes it); every other tile is claimed one at a time (#306);
//   - holdBells 20 turns (12 s a turn: 4 min of real time, 3 h 20 of the demo clock) instead of 144 (24 h); tuned on
//     human-paced playtests (demo/goal-playtest.mjs 'normal'/'slow', demo-goal-polish-1) to a 15–20 min game;
//   - the round is posted when the player's first village is placed (no AI can start holding before the player plays).
// A player's LOSS is an AI nation reaching the same goal first (Q-DSG-2); a same-bell tie is the player's win.

export const NATIONS = 6;

/** The demo's numbers (a change here changes every save: the world bundle's id changes with it). */
export const DEMO_GOAL = Object.freeze({
  /** Flag castles per nation (the real default is 2; the demo map has one ring-1 province per nation). */
  perNation: 1,
  /** null: half of the flags rounded up, capped at k − most own (world-goals.mjs needOf). */
  need: null,
  /** Turns a captured castle must be held (real: 144 = 24 h). 15 → 20 in demo-goal-polish-1 (human-paced games ~17 min). */
  holdBells: 20,
  /** The troops of a castle's starting guard (a host of the nation's AI village standing on it). */
  guardTroops: 110,
  /** Turns after the player's first village before the AI nations start their waves. */
  graceBells: 28,
  /** Turns between two waves. */
  waveEvery: 10,
  /** A wave host's troops: base × (1 + growth)^wave, capped. */
  waveBase: 100,
  waveGrowthBps: 1_200,
  waveCap: 2_000,
  /** AI nations that march in a wave besides the leader (they take turns). */
  waveActing: 1,
  /** The leader (the rival nation to beat: it marches every wave) gets this much more troops. */
  leaderBonusBps: 2_000,
});

/** The rival leader for a player of nation `player`: two nations along (a neighbour's neighbour), never the player's own. */
export const leaderOf = player => (player + 2) % NATIONS;

const isNation = n => Number.isInteger(n) && n >= 0 && n < NATIONS;

/** world-goals.mjs `needOf`: half of the k flags rounded up (or the override), never more than k − own. */
export const needOf = (k, rules = DEMO_GOAL, own = 0) => Math.max(0, Math.min(Number.isInteger(rules.need) && rules.need > 0 ? rules.need : Math.ceil(k / 2), k - own));

/** The most flags drawn for one nation. */
export const mostOwn = castles => { const c = new Map(); for (const f of castles) c.set(f.nation, (c.get(f.nation) ?? 0) + 1); return Math.max(0, ...c.values()); };

/** world-goals.mjs `countsFor`: a castle counts for nation n only when it was drawn for another nation. */
export const countsFor = (castle, n) => isNation(n) && castle.nation !== n;

/**
 * The castle tile of a province: the passable tile nearest its centre that is not a village site and not the camp
 * (ties: the lower index). `offsets`: fgeo TILE_OFFSETS. → a tile index, or -1.
 */
export function castleTile(pv, offsets) {
  const sites = new Set(pv.sites.slice(0, pv.siteCount));
  let best = -1, bestD = Infinity;
  for (let t = 0; t < offsets.length; t++) {
    if (((BigInt(pv.passableMask) >> BigInt(t)) & 1n) !== 1n || sites.has(t) || (pv.camp?.state === 1 && pv.camp.tile === t)) continue;
    const o = offsets[t], d = (Math.abs(o.q) + Math.abs(o.r) + Math.abs(o.q + o.r)) / 2;
    if (d < bestD) { best = t; bestD = d; }
  }
  return best;
}

/**
 * The progress of every nation at `bell` (world-goals.mjs `progressOf`, over castles instead of keeps):
 * `castles`: `[{nation, p, q, tile, holder, since}]` (holder 255 = nobody). → `[{nation, held, own, captured,
 * capturedLong, need, reachAt, castles: [{p, q, tile, since, from, longAt}]}]`.
 */
export function progressOf({ castles, bell, postedBell, rules = DEMO_GOAL }) {
  const need = needOf(castles.length, rules, mostOwn(castles));
  const out = [];
  for (let n = 0; n < NATIONS; n++) {
    const mine = castles.filter(c => c.holder === n);
    const captured = mine.filter(c => countsFor(c, n))
      .map(c => { const from = Math.max(c.since, postedBell); return { p: c.p, q: c.q, tile: c.tile, since: c.since, from, longAt: from + rules.holdBells }; })
      .sort((a, b) => a.longAt - b.longAt || a.p - b.p || a.q - b.q);
    const capturedLong = captured.filter(c => c.longAt <= bell).length;
    out.push({ nation: n, held: mine.length, own: mine.length - captured.length, captured: captured.length, capturedLong, need,
      reachAt: need > 0 && captured.length >= need ? captured[need - 1].longAt : null, castles: captured });
  }
  return out;
}

/** world-goals.mjs `achievementOf`: `{bell, nations}` of the earliest reach at or before `bell`, or null. */
export function achievementOf(progress, bell) {
  const done = progress.filter(x => x.reachAt !== null && x.reachAt <= bell);
  if (!done.length) return null;
  const at = Math.min(...done.map(x => x.reachAt));
  return { bell: at, nations: done.filter(x => x.reachAt === at).map(x => x.nation).sort((a, b) => a - b) };
}

/** The game's result for the player's nation: `{state: 'won' | 'lost', bell, nations}` or null while it is played. */
export function resultOf(achievement, playerNation) {
  if (!achievement) return null;
  return { state: achievement.nations.includes(playerNation) ? 'won' : 'lost', bell: achievement.bell, nations: [...achievement.nations] };
}

/** A wave host's troops (whole troops). */
export const waveTroops = (wave, rules = DEMO_GOAL) => Math.min(rules.waveCap, Math.round(rules.waveBase * ((10_000 + rules.waveGrowthBps) / 10_000) ** Math.max(0, wave)));

/** The wave number due at game turn `g` (turns since the posting), or null: waves at grace, grace + every, … */
export function waveAt(g, rules = DEMO_GOAL) {
  if (g < rules.graceBells || (g - rules.graceBells) % rules.waveEvery !== 0) return null;
  return (g - rules.graceBells) / rules.waveEvery;
}

/**
 * Where an AI nation's wave host goes (deterministic; the world passes the facts): `{kind, castles}` — the castles to try
 * in order (the world takes the first a march reaches; none, or none reached, on a raid: a tile of the player's land).
 * Two roles:
 *   the LEADER (the rival in the race):
 *     1. 'retake'      its own castle, when another nation holds it;
 *     2. 'stop-rival'  a castle captured by a nation one castle short of the need (the player's first) — the one whose
 *                      hold ends first;
 *     3. 'reinforce'   with the need in hand (every wave), or one short of it (every other wave): the castle it captured
 *                      with the fewest of its troops standing on it (`strength(castle)`);
 *     4. 'capture'     the castles not held by it, nearest its village first (the player's nation's first on a tie);
 *   the OTHERS (skirmishers: they do not race, they take back what is theirs and press the player):
 *     1. 'retake'      their own castle, when another nation holds it;
 *     2. 'raid'        the player's castles (nearest first), else the player's land (castle null).
 * `progress`: progressOf; `n`: the AI nation; `player`: the player's nation; `dist(castle)`: from the AI's village.
 */
export function waveTarget({ castles, progress, n, player, leader, dist, strength = () => 0, wave = 0 }) {
  const own = castles.find(c => c.nation === n);
  if (own && own.holder !== n) return { kind: 'retake', castles: [own] };
  if (n !== leader) {
    const theirs = castles.filter(c => c.holder === player).sort((a, b) => dist(a) - dist(b));
    return { kind: 'raid', castles: theirs };
  }
  const need = progress[0]?.need ?? 0;
  const close = progress.filter(x => x.nation !== n && need > 0 && x.captured >= need - 1 && x.captured > 0).sort((a, b) => (a.nation === player ? -1 : b.nation === player ? 1 : a.nation - b.nation));
  for (const x of close) {
    const c = [...x.castles].sort((a, b) => a.longAt - b.longAt)[0];
    if (c) return { kind: 'stop-rival', castles: [castles.find(k => k.p === c.p && k.q === c.q && k.tile === c.tile)] };
  }
  // holding the race: with the need in hand every wave strengthens the weakest castle it captured; one short of it,
  // every other wave does (the victims take their castles back one by one otherwise, and nobody ever wins)
  const mine = progress.find(x => x.nation === n);
  if (mine && need > 0 && (mine.captured >= need || (mine.captured === need - 1 && wave % 2 === 1))) {
    const held = castles.filter(c => c.holder === n && c.nation !== n).sort((a, b) => strength(a) - strength(b) || dist(a) - dist(b));
    if (held.length) return { kind: 'reinforce', castles: [held[0]] };
  }
  const open = castles.filter(c => c.holder !== n).sort((a, b) => dist(a) - dist(b) || (a.holder === player ? -1 : b.holder === player ? 1 : 0));
  return { kind: open.length ? 'capture' : 'none', castles: open };
}
