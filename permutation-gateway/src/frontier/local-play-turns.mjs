// LOCAL PLAY — one action per resident per turn (Q16-2) on the local-play relays: the chain's bell, read from the
// relay's own loopback runner, and the claim of resident-turns.mjs around each one send.
//
// A relay started with `--resident-turns <absolute dir>` (the launcher gives it to the relays of RESIDENTS: the
// operator AI residents, ⑤ A) holds every send route it serves — the economy commands (local-play-act.mjs), the
// ordinary march (local-play-march.mjs) and the prepared Depart / return / conquest flows (local-play-relay.mjs) — to
// one action per bell for its one wallet's Citizen. A Reveal completes a Depart already sent: no turn action. Without
// the flag nothing changes (a person's own page relay: unaffected).
//
// The bell: ONE `getMultipleAccounts` of [the relay's Season, the Clock sysvar] at one slot; the Season's own
// GENESIS_TS (decoded by the game's codec) and the Clock's unix_timestamp (offset 32, i64), then resident-turns.mjs
// `bellAt`. Anything unusable is "the runner did not give a usable answer" (nothing claimed, nothing sent).
import { decodePrefix } from '../../../permutation-server/web/frontier/fcodec.mjs';
import { profileForHash } from '../../../permutation-server/web/sdk/frontier/profile.mjs';
import { bellAt, createResidentTurns, ResidentTurnError } from './resident-turns.mjs';

export const CLOCK_SYSVAR = 'SysvarC1ock11111111111111111111111111111111';
export const RESIDENT_TURNS_FLAG = '--resident-turns';

function bytesOf(row) {
  if (!row || typeof row !== 'object' || !Array.isArray(row.data) || row.data[1] !== 'base64' || typeof row.data[0] !== 'string') return null;
  const b = Buffer.from(row.data[0], 'base64');
  return b.toString('base64') === row.data[0] ? new Uint8Array(b) : null;
}

/**
 * The resident turn gate of one local-play relay: `{bell(ask, unavailable), claim(bell, source, refuse)}`, or null
 * when `turns` is null (no flag). `ask(method, params)` is the module's own RPC (its own refusal on transport errors);
 * `unavailable()` throws the module's own "no usable answer"; `refuse(code, detail)` throws the module's own error.
 */
export function localPlayTurnGate({ turns, cfg, citizen }) {
  if (turns === null || turns === undefined) return null;
  if (typeof turns.claim !== 'function') throw new Error('local-play turns: not a resident turn lease');
  const profile = profileForHash(cfg.rulesetHash);
  return Object.freeze({
    citizen,
    async bell(ask, unavailable) {
      const r = await ask('getMultipleAccounts', [[cfg.season, CLOCK_SYSVAR], { encoding: 'base64', commitment: 'confirmed' }]);
      const rows = r?.result?.value;
      if (!Array.isArray(rows) || rows.length !== 2) unavailable();
      const season = bytesOf(rows[0]), clock = bytesOf(rows[1]);
      if (!season || rows[0].owner !== cfg.program || !clock || clock.length < 40) unavailable();
      let genesis; try { genesis = decodePrefix('Season', season, { profile }).genesisTs; } catch { unavailable(); }
      const unix = Buffer.from(clock).readBigInt64LE(32);
      if (typeof genesis !== 'bigint' || genesis > BigInt(Number.MAX_SAFE_INTEGER) || unix < 0n || unix > BigInt(Number.MAX_SAFE_INTEGER)) unavailable();
      return bellAt(Number(genesis), Number(unix));
    },
    /** Synchronous: the ticket, or the module's refusal. A bell of null (before genesis) takes no lease. */
    claim(bell, source, refuse) {
      if (bell === null) return null;
      try { return turns.claim({ citizen, bell, source }); }
      catch (e) { if (e instanceof ResidentTurnError) refuse(e.code, e.extra); throw e; }
    },
  });
}

/** `--resident-turns <dir>` of a relay's command line → the lease, or null. */
export function residentTurnsFromArgs(dir, { create = createResidentTurns } = {}) {
  return dir === null || dir === undefined ? null : create({ dir });
}
