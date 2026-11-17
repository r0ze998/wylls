// The launcher's settings for the opt-in cooperation board read (get_cooperation_status; src/coop-read-adapter.mjs),
// checked before anything is opened (bin/wylls-mcp.mjs). Pure: no I/O, no network; its one import is the adapter's
// dependency-free URL rule. An error names the setting and the rule, never its value (a URL may carry credentials).
// An empty setting counts as unset.
//
//   WYLLS_MCP_COOP_PUBLIC_BOARD=1      the deployment confirms this specific board's /coop/* is meant to be public.
//                                      Unset: off (the default): the tool is not listed and nothing is fetched.
//   WYLLS_MCP_COOP_BOARD=<url>         the board's base: http(s), no user, password, query or fragment; an optional
//                                      plain path prefix. Required when on.
//   WYLLS_MCP_COOP_CLUSTER=<cluster>   the cluster the board must report (e.g. localnet). Required when on; there is
//                                      no default, so a board of another cluster is never assumed to match.
//
// A board or cluster set without the opt-in is refused rather than ignored, so a half-made configuration is seen at
// start-up instead of silently running with the read off.
import { normaliseBoardBase } from '../src/coop-read-adapter.mjs';

export const COOP_CLUSTER = /^[a-z][a-z0-9-]{0,31}$/;
export const COOP_READ_ENV = Object.freeze(['WYLLS_MCP_COOP_PUBLIC_BOARD', 'WYLLS_MCP_COOP_BOARD', 'WYLLS_MCP_COOP_CLUSTER']);

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{error: string} | {enabled: false} | {enabled: true, baseUrl: string, origin: string, cluster: string}}
 */
export function coopReadSettings(env = {}) {
  const given = k => env[k] !== undefined && env[k] !== null && env[k] !== '';
  if (!given('WYLLS_MCP_COOP_PUBLIC_BOARD')) {
    if (given('WYLLS_MCP_COOP_BOARD') || given('WYLLS_MCP_COOP_CLUSTER')) {
      return { error: 'WYLLS_MCP_COOP_BOARD / WYLLS_MCP_COOP_CLUSTER are set without WYLLS_MCP_COOP_PUBLIC_BOARD=1: confirm the board is meant to be public, or unset them (the cooperation read is off by default)' };
    }
    return Object.freeze({ enabled: false });
  }
  if (env.WYLLS_MCP_COOP_PUBLIC_BOARD !== '1') return { error: 'WYLLS_MCP_COOP_PUBLIC_BOARD: 1 (this specific board is meant to be public) or unset (off)' };
  if (!given('WYLLS_MCP_COOP_BOARD')) return { error: 'WYLLS_MCP_COOP_BOARD: the board\'s http(s) base URL is required with WYLLS_MCP_COOP_PUBLIC_BOARD=1' };
  const text = String(env.WYLLS_MCP_COOP_BOARD);
  let base;
  try {
    if (text !== text.trim()) throw new TypeError('spaces');
    base = normaliseBoardBase(text);
  } catch {
    return { error: 'WYLLS_MCP_COOP_BOARD: an http or https URL, with no user, password, query, fragment or surrounding spaces, and only a plain path prefix' };
  }
  if (!given('WYLLS_MCP_COOP_CLUSTER')) return { error: 'WYLLS_MCP_COOP_CLUSTER: the cluster the board serves is required with WYLLS_MCP_COOP_PUBLIC_BOARD=1 (no default)' };
  const cluster = String(env.WYLLS_MCP_COOP_CLUSTER);
  if (!COOP_CLUSTER.test(cluster)) return { error: 'WYLLS_MCP_COOP_CLUSTER: a-z first, then a-z, 0-9 or -, at most 32 characters' };
  return Object.freeze({ enabled: true, baseUrl: base.href, origin: base.origin, cluster });
}
