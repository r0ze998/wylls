// LOCAL PLAY ONLY — which program LANE a local world runs (2026-11-20, rights-play; TEST-ONLY).
//
//   plain    the playable lane every local world has run so far: program version 0x4804, the S1 ruleset
//            (RULESET_HASH_V3). The default, and the only lane a world is ever taken to be without the launcher's word.
//   coexist  ②+⑨+⑩ in one LOCAL build (#113, workstream 4's allocation rev 8): `scripts/build-frontier-localnet-
//            coexist-sbf.sh`, program version 0x7805 (5 | 0x4000 wide | 0x0800 expedition | 0x2000 rights |
//            0x1000 capacity), the S1-with-custody ruleset (RULESET_HASH_V4, rules version 13). Only with the
//            launcher's `--coexist local-coexist-v1` and the relays' `--coexist`; never on devnet (its profiles refuse
//            the coexist marker) and never in a default world.
//
// The lane is read from the world's RULESET HASH: the hash is what the program writes into its Season (CreateSeason
// stores the program's own `RULESET_HASH`), so a Season cannot carry one lane's hash and be run by the other's program.
// Each lane names exactly one program version; nothing here accepts a version without its hash or the other way round.
//
// The page's rules kernel: `V4 = sha256(V3's input with domain "PSF-RULESET-v4" and the frontier rules version 13,
// then "CUSTODY-TABLES-v1" and the custody tables)` (permutation-rules `ruleset_hash_input_v4`). Every rule the page
// computes (production, training, clashes, caravans) is a V3 table, unchanged; the custody tables are the only
// addition and the page runs no custody rule. So a coexist world's page runs the S1 kernel (`frontier-v3.wasm`, which
// answers V3) under the explicit alias below — the one place a kernel of another hash is accepted, and only for this
// lane. (A `frontier-v4.wasm` answering V4 itself would remove the alias: not built here.)
export const PLAIN_LANE = Object.freeze({
  name: 'plain', programVersion: 0x4804, programVersionText: '18436',
  rulesetHash: 'e9059c9307189f337b00a4b2166b72a46e1cbbf888068ed1057067546d89de70',
  kernelRulesetHash: 'e9059c9307189f337b00a4b2166b72a46e1cbbf888068ed1057067546d89de70',
  rights: false,
});
export const COEXIST_LANE = Object.freeze({
  name: 'coexist', programVersion: 0x7805, programVersionText: '30725',
  rulesetHash: 'a1ddb3590f7a15c166a77d10362dd2a499c97111a6021d1eb2baad0ed36c8b62',
  kernelRulesetHash: 'e9059c9307189f337b00a4b2166b72a46e1cbbf888068ed1057067546d89de70',
  rights: true,
});
/** The launcher's mode word for a coexist world (`--coexist local-coexist-v1`) and the page address's `lane=` value. */
export const COEXIST_MODE = 'local-coexist-v1';
export const COEXIST_LANE_WORD = 'coexist';
export const LOCAL_LANES = Object.freeze([PLAIN_LANE, COEXIST_LANE]);

const hexOf = h => (typeof h === 'string' ? h.toLowerCase() : h instanceof Uint8Array && h.length === 32 ? Array.from(h, b => b.toString(16).padStart(2, '0')).join('') : null);
/** The lane of a ruleset hash (hex string or 32 bytes), or null: a hash of neither lane is no local world's. */
export function laneOfRuleset(hash) {
  const hex = hexOf(hash);
  return LOCAL_LANES.find(l => l.rulesetHash === hex) ?? null;
}
/** The lane of a program version (number or decimal text), or null. */
export function laneOfVersion(v) {
  const n = typeof v === 'string' && /^[0-9]{1,5}$/.test(v) ? Number(v) : v;
  return LOCAL_LANES.find(l => l.programVersion === n) ?? null;
}
/** Whether (version, hash) are ONE lane's pair. */
export function lanePair(version, hash) {
  const a = laneOfVersion(version), b = laneOfRuleset(hash);
  return a !== null && a === b;
}
/**
 * The ruleset hash the page's rules kernel must answer for a Season of `hash`: the hash itself, except a coexist
 * Season's in a process that SELECTED the coexist lane (below), whose kernel is the S1 one (the alias above). Any other
 * hash, or the coexist hash anywhere else (a devnet page, a plain local page): itself — the ordinary check stands.
 */
export function kernelRulesetFor(hash) {
  const hex = hexOf(hash);
  return hex === COEXIST_LANE.rulesetHash && selected === COEXIST_LANE ? COEXIST_LANE.kernelRulesetHash : hex;
}

// ---------------------------------------------------------------------------------------------------------------
// THE PROCESS'S LANE (one-shot, monotonic). A launcher, its relays and its operator residents serve worlds of ONE
// artefact, and a page plays ONE world: so the lane is chosen once per process — by the launcher's and the relay's
// `--coexist` flag at their start, by the page when its launcher says `lane=coexist` AND the Season's hash is the
// coexist one — and never changes again (plain → coexist only, once; asking for plain after coexist is refused).
// The pins of the existing modules (DEPART_PREPARE_PROGRAM_VERSION, LOCAL_PLAY_PROGRAM_VERSION, the relay's ruleset,
// the prepare modules' version) are live bindings that follow it (`onLocalLane`), so every comparison they make stays
// exactly the line it was: in a process that never selects, nothing at all changes.
let selected = PLAIN_LANE;
const listeners = [];
/** The lane this process plays. PLAIN_LANE until `selectLocalLane(COEXIST_LANE)`. */
export const localLane = () => selected;
/** Runs `fn(lane)` now and again if the lane is selected later (a module keeps its pins in step). */
export function onLocalLane(fn) { listeners.push(fn); fn(selected); }
/** Select the lane (once). Selecting the lane already selected is a no-op; any other change throws `LocalLaneFixed`. */
export function selectLocalLane(lane) {
  if (!LOCAL_LANES.includes(lane)) throw Object.assign(new Error('LocalLaneUnknown'), { code: 'LocalLaneUnknown' });
  if (lane === selected) return selected;
  if (selected !== PLAIN_LANE || lane !== COEXIST_LANE) throw Object.assign(new Error('LocalLaneFixed'), { code: 'LocalLaneFixed' });
  selected = lane;
  for (const fn of listeners) fn(selected);
  return selected;
}
