// The checks every proposal passes before anything is sent, whoever made it
// (the rule decider or a model). A model's answer is a suggestion: it is
// held to the command contract (③), the owner's grant (②), the nation's
// request it claims to answer, and the village's stores. The relay checks
// again on its side (AgentGateway.submit); this layer exists so that a
// proposal the owner did not allow never reaches the relay at all, and so
// that the owner gets a reason and a decision to make instead of a silent
// drop.
import { CMD } from './adapters.mjs';
import { sanitize } from './deps.mjs';

/** Codes of this layer (on top of the command contract's CMD codes). */
export const G = Object.freeze({
  NO_REQUEST: 'NoSuchRequest',
  REQUEST_EXPIRED: 'RequestExpired',
  WRONG_NATION: 'NotOurNation',
  UNTRUSTED_AUTHOR: 'NotFromFollowedAuthor',
  NOT_ASKED: 'NotWhatWasAsked',
  EXCEEDS_REQUEST: 'ExceedsRequest',
  NOT_IN_MANDATE: 'NotInMandate',
  EXCEEDS_MANDATE: 'ExceedsMandate',
  DAY_LIMIT: 'MandateDayLimit',
  NOT_AFFORDABLE: 'NotAffordable',
  ALREADY_DONE: 'AlreadyContributed',
  GRANT_INVALID: 'GrantInvalid',
});

/** Which codes leave a decision to the owner (the rest are plain refusals: nothing the owner needs to do). */
const OWNER_DECIDES = new Set([CMD.WALLET_REQUIRED, CMD.NO_AGENT_PATH, CMD.DECIDED_NOT_PROXY, CMD.NOT_DELEGABLE, CMD.NOT_IMPLEMENTED, G.NOT_IN_MANDATE, G.EXCEEDS_MANDATE, G.DAY_LIMIT, G.GRANT_INVALID]);

/** The command a request's structured ask maps to (a request without one is free text: any allowed command, bounded by the mandate). */
export const ASK_COMMAND = Object.freeze({ train: 'Train', supply: 'SendCaravan', vote: 'Vote', facility: 'UseFacility', build: 'Build' });

/**
 * A request's structured part, checked as data: numbers in range or nothing.
 * Its free text (title, body) is never parsed for authority.
 */
export function parseAsk(ask) {
  if (!ask || typeof ask !== 'object' || !Object.hasOwn(ASK_COMMAND, ask.kind)) return null;
  const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);
  switch (ask.kind) {
    case 'train': { const unit = int(ask.unit, 0, 5), n = int(ask.n, 1, 1_000_000); return unit === null || n === null ? null : { kind: 'train', unit, n }; }
    case 'build': { const item = int(ask.item, 0, 8); return item === null ? null : { kind: 'build', item }; }
    case 'supply': {
      const amount = int(ask.amount, 1, 1_000_000);
      if (amount === null || typeof ask.resource !== 'string' || !ask.dest || typeof ask.dest !== 'object') return null;
      return { kind: 'supply', resource: ask.resource.slice(0, 16), amount, dest: { p: ask.dest.p, q: ask.dest.q, tile: ask.dest.tile, owner: String(ask.dest.owner ?? '') } };
    }
    case 'vote': return { kind: 'vote', id: int(ask.id, 0, 2 ** 32 - 1), yes: ask.yes === true };
    case 'facility': return { kind: 'facility', facility: String(ask.facility ?? '').slice(0, 32) };
    default: return null;
  }
}

/** Why a request on the board is not one the proxy answers now, or null when it is. */
export function ignoredWhy(req, grant, nowSec) {
  if (grant.nation !== null && req.nation !== grant.nation) return G.WRONG_NATION;
  if (grant.from?.length && !grant.from.includes(req.author)) return G.UNTRUSTED_AUTHOR;
  if (!(req.deadlineSec > nowSec)) return G.REQUEST_EXPIRED;
  return null;
}

const sum = (a, b) => { const o = { ...a }; for (const [k, v] of Object.entries(b ?? {})) o[k] = (o[k] ?? 0) + v; return o; };

/**
 * @param {object} proposal  {requestId, command: {name, fields}, by, reason?}
 * @param {object} ctx       {grant, contract, obs, nowSec, committedToday, committedThisRun, contributedTo: (requestId) => troops already sent}
 * @returns {{verdict: 'execute'|'needs_owner'|'refused', code?, reason, ownerDecision?, command?, cost?}}
 */
export function checkProposal(proposal, ctx) {
  const { grant, contract, obs, nowSec } = ctx;
  const out = (code, reason, ownerDecision = null) => ({ verdict: OWNER_DECIDES.has(code) ? 'needs_owner' : 'refused', code, reason, ownerDecision });
  if (!grant.ok) return out(G.GRANT_INVALID, grant.reasons.map(r => r.code).join(', '), grant.reasons.map(r => r.ownerDecision).join(' / '));
  const req = (obs.requests ?? []).find(r => r.id === proposal?.requestId);
  if (!req) return out(G.NO_REQUEST, `依頼 ${String(proposal?.requestId).slice(0, 40)} は観測した公開の依頼にない`);
  if (grant.nation !== null && req.nation !== grant.nation) return out(G.WRONG_NATION, `依頼は国 ${req.nation} のもの。委任は国 ${grant.nation} の活動だけ`);
  if (grant.from?.length && !grant.from.includes(req.author)) return out(G.UNTRUSTED_AUTHOR, `依頼を書いた ${sanitize(req.author ?? '?', { limit: 40, untrusted: true })} は、本人が従うと決めた相手ではない`);
  if (!(req.deadlineSec > nowSec)) return out(G.REQUEST_EXPIRED, '依頼の期限が過ぎた');

  const ask = parseAsk(req.ask);
  // A request that is only text: whatever a model read into it is the model's, not the request's. Such a proposal
  // is never turned into a question to the owner ("sign SetSession", "raise the limit to 5000"): another player's
  // text, through the model, must not be able to put a signing prompt on the owner's screen. It is refused.
  const fromText = !ask;
  const deny = (code, reason, ownerDecision = null) => (fromText ? { verdict: 'refused', code, reason: `${reason}（文だけの依頼から出た提案なので、本人には回さない）`, ownerDecision: null } : out(code, reason, ownerDecision));
  const name = proposal.command?.name;
  // The request asked for something specific: an answer must be that, no more.
  if (ask && ASK_COMMAND[ask.kind] !== name) return out(G.NOT_ASKED, `依頼は ${ASK_COMMAND[ask.kind]}、提案は ${String(name).slice(0, 32)}`);

  const c = contract.check(proposal.command, { toOtherPlayer: ask?.kind === 'supply' && ask.dest.owner !== obs.view?.owner });
  if (!c.ok) return deny(c.code, c.reason, c.ownerDecision);
  const cmd = c.command;
  if (!grant.allowed.includes(cmd.name)) {
    const byPolicy = grant.deniedByPolicy.includes(cmd.name) ? '（中継の方針が許していない）' : '';
    return deny(G.NOT_IN_MANDATE, `${cmd.name} は委任されていない${byPolicy}`, `本人が ${cmd.name} を委任に加えるか、自分で行う`);
  }
  if (ask?.kind === 'train') {
    if (cmd.fields.unit !== ask.unit) return deny(G.NOT_ASKED, `依頼の兵種は ${ask.unit}、提案は ${cmd.fields.unit}`);
    const left = ask.n - (ctx.contributedTo?.(req.id) ?? 0);
    if (left <= 0) return deny(G.ALREADY_DONE, 'この依頼への協力は記録済み');
    if (cmd.fields.n > left) return deny(G.EXCEEDS_REQUEST, `依頼の残りは ${left}、提案は ${cmd.fields.n}`);
  }
  const lim = grant.limits;
  if (cmd.name === 'Train' && cmd.fields.n > lim.troopsPerRequest) {
    return deny(G.EXCEEDS_MANDATE, `1件あたりの兵の上限は ${lim.troopsPerRequest}、提案は ${cmd.fields.n}`, `本人が上限を ${cmd.fields.n} 以上に上げるか、部分的な協力を許す`);
  }
  const cost = contract.costOf(cmd) ?? {};
  for (const [r, v] of Object.entries(cost)) {
    if (v > (lim.perRequest[r] ?? 0)) return deny(G.EXCEEDS_MANDATE, `1件あたりの ${r} の上限は ${lim.perRequest[r] ?? 0}、必要なのは ${v}`, `本人が ${r} の上限を ${v} 以上に上げるか、部分的な協力を許す`);
  }
  const day = sum(ctx.committedToday ?? {}, ctx.committedThisRun ?? {});
  for (const [r, v] of Object.entries(cost)) {
    if ((day[r] ?? 0) + v > (lim.perDay[r] ?? 0)) return deny(G.DAY_LIMIT, `今日の ${r} は ${day[r] ?? 0} を使った。上限 ${lim.perDay[r] ?? 0} を超える`, `本人が1日の ${r} の上限を上げるか、明日まで待つ`);
  }
  const stores = obs.village?.stores ?? {};
  const spent = ctx.committedThisRun ?? {};
  for (const [r, v] of Object.entries(cost)) {
    if ((stores[r] ?? 0) - (spent[r] ?? 0) < v) return deny(G.NOT_AFFORDABLE, `${r} が ${v} 要るが、村には ${(stores[r] ?? 0) - (spent[r] ?? 0)}`);
  }
  return { verdict: 'execute', reason: 'ok', command: cmd, cost };
}
