// LOCAL PLAY, TEST-ONLY — external independent AI residents (⑤ option B, owner decision 2026-11-18): the admission
// side, key-free and pure.
//
// An external resident is a program someone else runs, in its own process, with its OWN wallet. The operator of a
// local TEST world admits it by its PUBLIC address on the launcher's command line
// (`--external-residents <address>[,<address>]`); nothing about it is ever asked over HTTP, and no key of it ever
// reaches this launcher. What an admitted address gets in the next world this launcher starts is exactly what the
// second person of a contest pair gets (the TEST world's newcomer path):
//   - the runner's own funding amount for a player (fees and rent only; the same as the player and the operator
//     residents, nothing more);
//   - one ordinary local-play relay pinned to ITS wallet as actor, payer and sole signer (the same
//     local-play-relay-server.mjs, the same arguments as the player's), so the relay can only forward what that
//     wallet signed;
//   - one public world proxy of its own (createWorldProxy: the herald's `/h/*`, the relay's public routes, the page's
//     Origin rules), so it reads and writes exactly as a page does.
// It asks for its world with the page's own `POST /local-play/start {wallet}`; an admitted address never starts a
// world of its own, and cannot stop, extend or read the operator's views of the world it lives in (`/local-play/stop`,
// `/keeper`, `/pair` are the owner's).
// No budget is added here: the limits are the relay's and the program's, as for a person. Y2: nothing reaches the
// page; `externals.json` in the world's directory is the operator's local record of whom it admitted.

import { decode, encode } from '../../../permutation-server/web/sdk/base58.mjs';

export const EXTERNAL_RESIDENTS_MODE = 'external-residents-v1';
export const EXTERNAL_RESIDENTS_SCHEMA = 'frontier-local-play-external-residents-v1';
/** At most this many admitted addresses (each takes two loopback ports per world slot: its proxy and its relay). */
export const EXTERNAL_RESIDENTS_MAX = 2;

const wallet = s => { try { return typeof s === 'string' && s.length <= 44 && decode(s).length === 32 && encode(decode(s)) === s; } catch { return false; } };

/** `--external-residents a[,b]` → the frozen list of distinct public addresses, or null when it is not exactly that. */
export function parseExternalResidents(raw) {
  if (typeof raw !== 'string' || raw.length > 2 * 44 + 1 || !/^[1-9A-HJ-NP-Za-km-z,]+$/.test(raw)) return null;
  const list = raw.split(',');
  if (list.length < 1 || list.length > EXTERNAL_RESIDENTS_MAX || !list.every(wallet) || new Set(list).size !== list.length) return null;
  return Object.freeze(list);
}

/**
 * The loopback ports of one world slot's external residents, after the worlds' own (5 each) and, when the launcher
 * has operator residents, theirs (`operatorMax` per world): resident i of slot s → `{herald: base + 2i, relay: base + 2i + 1}`,
 * base = worldPort + worldLimit·5 + worldLimit·operatorMax + s·EXTERNAL_RESIDENTS_MAX·2.
 */
export function externalPorts(worldPort, slot, n, { worldLimit = 2, operatorMax = 0 } = {}) {
  const base = worldPort + worldLimit * 5 + worldLimit * operatorMax + slot * EXTERNAL_RESIDENTS_MAX * 2;
  return Array.from({ length: n }, (_, i) => Object.freeze({ herald: base + 2 * i, relay: base + 2 * i + 1 }));
}

/** How many ports past `worldPort` a launcher with these options spans. */
export function externalSpan(worldLimit = 2) { return worldLimit * EXTERNAL_RESIDENTS_MAX * 2; }
