// Catch-up on refusal (PT-B, the 2026-10-01 Depart 409): a resident action
// (Depart, Muster, Garrison, Dissolve, Explore, Build) is refused
// `NotResident` (409) when the player's province is not resolved through
// the bell before the current one (`resolved_next + 1 < bell`). A quiet
// province lags by design (the keeper skips quiet provinces in batches of
// up to 24 bells; a nudge catches one up in about 3 s and the catch-up
// lasts until the next bell). The page nudges once per bell and decides
// from a view up to one poll old, so an action sent at a bell boundary can
// be refused although the player did nothing wrong, and a Depart had no
// retry at all.
//
// The relay now does what the page's catch-up does, for every client: when
// the simulation says NotResident for a shape that names a province, it
// nudges the keeper (the same /v1/nudge the page uses), waits for the
// province account to show `resolved_next + 1 >= bell` (at most `waitMs`),
// and simulates once more. Nothing is charged for the refused first
// simulation (the quota is held and given back as for any refusal). One
// catch-up per province at a time (concurrent actions share the wait), and
// never more often than `minGapMs` per province, so a script cannot turn
// the relay into a keeper hammer.
import { PublicKey } from '@solana/web3.js';
import { decodeAccount } from '../../client/src/frontier/codec.mjs';

export const RESIDENT_SHAPES = Object.freeze(['Depart', 'Muster', 'Garrison', 'Dissolve', 'Explore', 'Build']);
export const CATCH_UP = Object.freeze({ waitMs: 20_000, pollMs: 400, minGapMs: 1_500 });

const bellOf = (clock, season) => Math.floor((Number(clock.unixTimestamp) - Number(season.GENESIS_TS)) / Number(season.BELL_SECS));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function readProvince(ctx, address) {
  const a = await ctx.connection.getAccountInfo(new PublicKey(address), 'confirmed');
  if (!a) return null;
  try { return decodeAccount('Province', a.data, { seasonId: ctx.addresses.seasonId }); } catch { return null; }
}

/**
 * Nudge the keeper for the province `shape` names and wait for it to be
 * resolved through the previous bell. True when it is (so a second
 * simulation is worth sending); false when there is no keeper, the shape
 * names no province, the keeper refused, or the wait ran out.
 */
export async function catchUpProvince(ctx, shape, opts = {}) {
  const { waitMs, pollMs, minGapMs } = { ...CATCH_UP, ...opts };
  const address = shape.accounts?.province;
  if (!ctx.keeper || !address || !RESIDENT_SHAPES.includes(shape.name)) return false;
  ctx.catchups ??= new Map();
  const inFlight = ctx.catchups.get(address);
  if (inFlight?.promise) return inFlight.promise;
  const now = (ctx.now ?? Date.now)();
  if (inFlight && now - inFlight.at < minGapMs) return inFlight.ok === true;
  const run = (async () => {
    const [season, clock, province] = [await ctx.chain.season(), await ctx.chain.clock(), await readProvince(ctx, address)];
    if (!province) return false;
    const bell = bellOf(clock, season);
    if (Number(province.RESOLVED_NEXT) + 1 >= bell) return false; // not a lag: the refusal is something else
    const r = await ctx.keeper.nudge({ province: [Number(province.P), Number(province.Q)], bell });
    if (r.status >= 300) return false;
    const end = Date.now() + waitMs;
    for (;;) {
      await sleep(pollMs);
      const p = await readProvince(ctx, address);
      const b = bellOf(await ctx.chain.clock(), season);
      if (p && Number(p.RESOLVED_NEXT) + 1 >= b) return true;
      if (Date.now() > end) return false;
    }
  })().catch(() => false);
  const entry = { at: now, promise: run };
  ctx.catchups.set(address, entry);
  const ok = await run;
  ctx.catchups.set(address, { at: (ctx.now ?? Date.now)(), ok });
  return ok;
}
