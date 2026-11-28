/**
 * The ⑥ chain-link flag. OFF unless asked for, in exactly one of three ways:
 *   - Node: environment variable WYLLS_CREATION_CHAINLINK=1
 *   - page: URL query `?chainlink=1`
 *   - page: localStorage key `wylls.creation.chainlink` = "1"
 * Any other value (unset, "0", "true", "yes", …) is off, so a typo cannot
 * turn it on. When off, the prototype behaves as before (its saved state, calls and
 * screens are unchanged; only a hidden, empty box is in the page).
 */

export const FLAG_ENV = "WYLLS_CREATION_CHAINLINK";
export const FLAG_QUERY = "chainlink";
export const FLAG_STORAGE = "wylls.creation.chainlink";

export function chainLinkEnabled({ env = null, search = null, storage = null } = {}) {
  if (env && env[FLAG_ENV] === "1") return true;
  if (typeof search === "string" && new URLSearchParams(search).get(FLAG_QUERY) === "1") return true;
  try {
    if (storage && storage.getItem(FLAG_STORAGE) === "1") return true;
  } catch { /* private window: off */ }
  return false;
}
