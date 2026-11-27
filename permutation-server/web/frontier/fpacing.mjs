/**
 * The world's pacing (world4-pacing-impl; frontier-abi `v2::pacing`): the Season's own bytes, read as the program
 * reads them, so that a world created before them (world 3) reads exactly what it always did.
 *
 * | rule                                   | Season field (decoded)          | world 3 |
 * | minimum arrival lead                   | `minLead` (base byte 276)       | 2       |
 * | first village at once on a settled rim | `conquestParams.pacing` (83)    | 0       |
 * | Depart stamina                         | `conquestParams.departStamina`  | 0 → 74  |
 * | starter host at the founding           | `conquestParams.starterHost`    | 0       |
 *
 * `pacing` 0 is the legacy pacing whatever the other bytes hold (the program's `Pacing::from_bytes`). The reveal
 * window (300 s) and the keep hold (36 turns) need nothing here: the page already reads them from the Season.
 * Pure.
 */
export const PACING_LEGACY = 0;
export const PACING_FAST_V1 = 1;
/** The stamina a Depart charges in a world without the byte: the longest path's (travel::march_stamina(32)). */
export const DEPART_STAMINA_LEGACY = 74;
export const LEGACY = Object.freeze({ mode: PACING_LEGACY, minLead: 2, departStamina: DEPART_STAMINA_LEGACY, starterHost: 0, firstHomeAtOnce: false });
const BELL_SECS = 600;

/** `{mode, minLead, departStamina, starterHost, firstHomeAtOnce}` of a decoded Season (null/undefined: legacy). */
export function pacingOf(season) {
  const cq = season?.conquestParams;
  const mode = Number(cq?.pacing ?? 0);
  if (mode !== PACING_FAST_V1) return LEGACY;
  const st = Number(cq?.departStamina ?? 0);
  return Object.freeze({
    mode,
    minLead: Number(season?.minLead) === 1 ? 1 : 2,
    departStamina: Number.isInteger(st) && st > 0 && st <= 120 ? st : DEPART_STAMINA_LEGACY,
    starterHost: Number(cq?.starterHost ?? 0) || 0,
    firstHomeAtOnce: true,
  });
}

/** The minimum arrival lead (turns after the departure turn) of a decoded Season. */
export const minLeadOf = season => pacingOf(season).minLead;

/**
 * `travel::earliest_arrival_bell` with the lead an input (frontier-abi `v2::pacing::earliest_arrival_bell`): the
 * arrival time rounded up to the next bell start, and at least `lead` bells after the departure bell. At lead 2 it
 * is the kernel's answer exactly (the page asks the wasm kernel then, as before).
 */
export function earliestArrivalBell(genesisTs, departTs, secs, lead) {
  const t = Math.floor(departTs) + Number(secs) - Number(genesisTs);
  const up = t <= 0 ? 0 : Math.ceil(t / BELL_SECS);
  const d = Math.floor(departTs) - Number(genesisTs);
  const departBell = d <= 0 ? 0 : Math.floor(d / BELL_SECS);
  return Math.max(up, departBell + Number(lead));
}
