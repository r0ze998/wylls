// Explicit protocol profiles. Never infer a layout from programVersion alone:
// the historical first-village v2 program still uses layout 1.
//
//   1  M1 (ABI v1)
//   2  MC, the conquest program (ABI v2)
//   3  S1, the redesign's stage-1 program: ABI v2 (its layouts and
//      instructions, the S1 ones included) with its own loaded limits (the
//      S1 release .so is larger); its ruleset hash is RULESET_HASH_V3
import { PRESETS as V1 } from './abi-presets.mjs';
import { PRESETS as V2 } from './abi-v2-presets.mjs';
export function profileForHash(hash) {
  const hex = typeof hash === 'string' ? hash.toLowerCase() : Array.from(hash ?? [], b => b.toString(16).padStart(2, '0')).join('');
  if (hex === V1.ruleset_hash) return 1;
  if (hex === V2.ruleset_hash) return 2;
  if (V2.ruleset_hash_v3 && hex === V2.ruleset_hash_v3) return 3;
  return null;
}
export function profileForSeason(season) {
  const profile = profileForHash(season?.RULESET_HASH ?? season?.rulesetHash);
  if (profile) return profile;
  const layout = Number(season?.LAYOUT_VERSION ?? season?.layoutVersion ?? 1);
  return layout === 2 ? 2 : 1;
}
export const rulesetFor = (profile = 1) => (profile === 3 ? V2.ruleset_hash_v3 : (profile === 2 ? V2 : V1).ruleset_hash);
/** Whether a profile reads the ABI v2 layouts and instructions (MC and S1). */
export const isV2 = (profile = 1) => profile >= 2;
