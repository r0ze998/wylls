// The code offers, the provider chooses, the code checks (the citizens'
// rule, contract §4). Candidates are built from the resident's own view and
// memory only, and every resident runs this same function; a goal changes
// scores, never which actions exist. A request that cannot be accepted is
// listed under `excluded` with its reason, so a refusal can be explained,
// and an addressee may decline it with an alternative that keeps the world
// moving (the request reopens to everyone, another holder is named, or the
// earliest deadline that would work is given).
import { CARAVAN_FEE, caravanBells } from '../world/rules.mjs';
import { assess } from './goals.mjs';
import { trustOf } from './ports/memory.mjs';
import { wouldCloseGiftCycle } from './safety.mjs';

const sum = g => Object.values(g).reduce((s, v) => s + v, 0);
/** Requests are made in tens and never for less than 40 units (no trickle of tiny asks). */
const round10 = n => Math.max(40, Math.ceil(n / 10) * 10);
export const MIN_TRUST = -1;

/** A caravan of mine on the road to `to` was raided recently (twice the request cooldown). */
export const raidedRoad = (memory, me, to, bell, limits) => memory.all().some(e => e.kind === 'raided' && e.entities.includes(`route:${me}>${to}`) && bell - e.bell < 2 * limits.requestCooldownBells);

/**
 * @param ctx {me, bell, world (view), board (view), goal, memory, limits, today (counters), siblings: Set, cooldown: {[key]: bell}, mine: {accepted: Set}}
 * @returns {{candidates, excluded, assessment}}
 */
export function buildCandidates(ctx) {
  const { me, bell, world, board, goal, memory, limits, today, siblings } = ctx;
  const village = world.villages.find(v => v.citizen === me);
  const a = assess(village, goal);
  const villages = new Map(world.villages.map(v => [v.citizen, v]));
  const candidates = [];
  const excluded = [];
  const quotaOk = world.me.quota.bucket >= 1 && world.me.quota.relayLeft >= 1 && today.actions < limits.actionsPerDay;
  const caravanOk = quotaOk && world.me.quota.lamportsLeft >= CARAVAN_FEE;
  const msgOk = today.messages < limits.messagesPerDay;
  const building = village.building.length > 0;

  // Build the plan's next building when it is affordable (one at a time).
  if (a.affordable && !building && quotaOk) {
    candidates.push({ id: `build:${a.next.item}`, kind: 'build', summary: `build the ${a.next.produces} building (item ${a.next.item})`, score: 10 * goal.growth + 1, act: { item: a.next.item } });
  }

  // Ask for what the next building lacks when production alone is too slow.
  const myOpen = board.requests.filter(r => r.from === me && ['open', 'claimed'].includes(r.status));
  const short = Object.entries(a.planShortfall).sort((x, y) => y[1] - x[1])[0];
  if (short && myOpen.length === 0 && msgOk) {
    const [res, amount] = short;
    const want = { [res]: round10(amount) };
    const offerRes = Object.entries(a.idle).filter(([n]) => n !== res).sort((x, y) => y[1] - x[1])[0];
    const offer = offerRes ? { [offerRes[0]]: Math.min(offerRes[1], want[res]) } : {};
    // Two reasons to ask: production alone is too slow for the plan (growth), or idle stock can buy what the plan lacks (use).
    const growthWhy = a.planWaitBells > goal.patienceBells ? goal.growth * 6 * Math.min(2, a.planWaitBells / goal.patienceBells) : 0;
    const useWhy = offerRes && offerRes[1] >= 200 ? goal.use * Math.min(10, offer[offerRes[0]] / 20) : 0;
    if (growthWhy > 0 || useWhy > 0) {
      // A target: the most trusted holder with the most of it in public stores, not cooling down; else open to all.
      const holders = world.villages
        .filter(v => v.citizen !== me && v.stores[res] >= want[res] * 2 && trustOf(memory, v.citizen) >= 0 && !(ctx.cooldown[`${v.citizen}|${res}`] > bell))
        .sort((x, y) => trustOf(memory, y.citizen) - trustOf(memory, x.citizen) || y.stores[res] - x.stores[res] || (x.citizen < y.citizen ? -1 : 1));
      const to = holders[0]?.citizen ?? null;
      const travel = to ? caravanBells(villages.get(to).pos, village.pos) : 6;
      const deadlineBell = bell + Math.max(18, travel + 8);
      candidates.push({
        id: `request:${res}`, kind: 'request', summary: `ask ${to ?? 'anyone'} for ${want[res]} ${res}${offerRes ? `, offering ${offer[offerRes[0]]} ${offerRes[0]}` : ' (nothing to offer back)'}`,
        score: Math.max(growthWhy, useWhy), act: { to, want, offer, deadlineBell },
      });
    }
  }

  // Requests others posted: accept the ones this resident can and will serve; explain the others.
  const replied = new Set(board.replies.filter(r => r.from === me).map(r => r.re));
  for (const r of board.requests) {
    if (r.from === me || r.status !== 'open' || replied.has(r.id) || ctx.mine.accepted.has(r.id)) continue;
    const addressed = r.to === me;
    if (!r.openTo.includes('*') && !addressed) continue;
    const from = villages.get(r.from);
    const want = sum(r.want);
    const gift = Object.keys(r.offer).length === 0;
    const offerHelps = Object.entries(r.offer).some(([n, v]) => a.shortfall[n] && v > 0);
    const travel = caravanBells(village.pos, from.pos);
    const sibling = siblings.has(r.from);
    let reason = null, why = '';
    if (Object.entries(r.want).some(([n, v]) => (a.idle[n] ?? 0) < v)) { reason = 'goal'; why = 'my own plan needs it'; }
    else if (bell + 1 + travel > r.deadlineBell) { reason = 'deadline'; why = `the road takes ${travel} bells`; }
    else if (trustOf(memory, r.from) < MIN_TRUST) { reason = 'trust'; why = 'an earlier promise was not kept'; }
    else if (raidedRoad(memory, me, r.from, bell, limits)) { reason = 'route'; why = 'my last caravan on this road was raided'; }
    else if (sibling && (gift || sum(r.offer) < want)) { reason = 'terms'; why = 'same owner: only even trades'; }
    else if (sibling && today.sibling + want > limits.siblingPerDay) { reason = 'limit'; why = 'same-owner trade limit for today'; }
    else if (gift && wouldCloseGiftCycle(board.requests, bell, me, r.from)) { reason = 'limit'; why = 'the gift would come back round'; }
    else if (gift && today.gifts + want > limits.giftPerDay) { reason = 'budget'; why = `a gift of ${want} is over what I may give today (${limits.giftPerDay - today.gifts})`; }
    else if (today.giveAway + want > limits.giveAwayPerDay) { reason = 'budget'; why = `${want} is over what I may send today (${limits.giveAwayPerDay - today.giveAway})`; }
    else if (!caravanOk || !msgOk) { reason = 'budget'; why = 'no action, message or caravan allowance left today'; }
    if (!reason) {
      candidates.push({
        id: `accept:${r.id}`, kind: 'accept', summary: `send ${JSON.stringify(r.want)} to ${r.from}${gift ? ' as a gift' : ` for ${JSON.stringify(r.offer)}`}`,
        score: goal.use * Math.min(10, want / 40) + goal.growth * (offerHelps ? 6 : 0) + (gift ? 0 : 1), act: { request: r.id, to: r.from, goods: r.want, gift },
      });
      continue;
    }
    excluded.push({ request: r.id, reason, why });
    if (addressed && msgOk) {
      const res = Object.keys(r.want)[0];
      const other = world.villages.filter(v => v.citizen !== me && v.citizen !== r.from && v.stores[res] >= r.want[res]).sort((x, y) => y.stores[res] - x.stores[res])[0];
      const alternative = {
        reopens: r.openIfDeclined,
        holder: other ? { citizen: other.citizen, has: other.stores[res] } : null,
        ...(reason === 'deadline' ? { earliestDeadlineBell: bell + 1 + travel } : {}),
        ...(reason === 'goal' ? { canSpare: Object.fromEntries(Object.entries(r.want).map(([n]) => [n, a.idle[n] ?? 0])) } : {}),
        ...(reason === 'budget' ? { canSendToday: Math.max(0, Math.min(gift ? limits.giftPerDay - today.gifts : Infinity, limits.giveAwayPerDay - today.giveAway)) } : {}),
      };
      candidates.push({ id: `decline:${r.id}`, kind: 'decline', summary: `decline ${r.from}'s request (${reason}: ${why})`, score: 4, act: { request: r.id, reason, why, alternative } });
    }
  }

  candidates.push({ id: 'wait', kind: 'wait', summary: 'do nothing new this turn', score: 0.5, act: {} });
  return { candidates, excluded, assessment: a };
}
