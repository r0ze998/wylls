// Playtest read route (PT-B): what the landing page needs to tell a friend, in plain words, whether
// their invite works, and if not why — without sending a Join to find out.
//
//   POST /f/invite-check {invite}  →  {ok: true, gated, invite: "ok|used|invalid|notNeeded", season: "open|notStarted|joinClosed|ended|unavailable", full}
//
// A POST (the code is in the body, never in a URL or a log line). Nothing is consumed or reserved: the
// check is advice, the Join (POST /f/join) decides. Per-address limited like the other public routes.
import { RouteError } from '../../routes/errors.mjs';

/** The season's phase for a would-be player, from the decoded Season and the chain Clock. */
export function seasonPhase(season, clock) {
  const status = Number(season.STATUS);
  if (status >= 4) return 'ended'; // Ended, Closed, Aborted
  if (status < 2) return 'notStarted'; // Announced, Created: the genesis seed is not in yet
  const now = Number(clock.unixTimestamp);
  const genesis = Number(season.GENESIS_TS);
  if (now < genesis) return 'notStarted';
  const bell = Math.floor((now - genesis) / Number(season.BELL_SECS));
  if (Number(season.END_BELL) > 0 && bell >= Number(season.END_BELL)) return 'ended';
  if (Number(season.JOIN_CLOSE_BELL) > 0 && bell >= Number(season.JOIN_CLOSE_BELL)) return 'joinClosed';
  return 'open';
}

/** Invites already redeemed (the relay's state), for the optional `maxPlayers` cap. */
export const redeemed = ctx => Object.keys(ctx.invites?.store?.state?.invitesUsed ?? {}).length;

/** Whether the playtest's player cap (`--max-players`, 0 = none) is reached. */
export const isFull = ctx => Number(ctx.cfg.maxPlayers ?? 0) > 0 && redeemed(ctx) >= Number(ctx.cfg.maxPlayers);

export const playtestRoutes = {
  'POST /f/invite-check': async (ctx, req) => {
    const b = await req.json();
    let season = 'unavailable';
    let gated = false;
    try {
      const s = await ctx.chain.season();
      gated = s.JOIN_GATE.some(x => x !== 0);
      season = seasonPhase(s, await ctx.chain.clock());
    } catch (e) {
      if (!(e instanceof RouteError)) season = 'unavailable';
    }
    let invite = 'notNeeded';
    if (gated) {
      const nonce = typeof b.invite === 'string' ? ctx.invites?.verify(b.invite.trim()) : null;
      invite = !nonce ? 'invalid' : ctx.invites.used(nonce) ? 'used' : 'ok';
    }
    return { body: { ok: true, gated, invite, season, full: isFull(ctx) } };
  },
};
