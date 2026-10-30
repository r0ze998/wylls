// The public request board of the test world (MOCK of an off-chain service,
// in the manner of the citizens' social layer: signed records, per-sender
// rate limits, everything public). A request asks for goods and may offer
// goods back; a reply accepts or declines it. The board never trusts a claim
// that goods were sent: whether a request was fulfilled, and whether the
// requester paid back, is read from the world's public caravan events.
import { createHash } from 'node:crypto';
import { decode as base58decode } from '../../../permutation-gateway/client/src/base58.mjs';
import { TALK_PER_BELL, TALK_PER_DAY } from '../../../permutation-gateway/citizens/social/limits.mjs';
import { sanitize } from '../../../permutation-gateway/citizens/mind/sanitize.mjs';
import { verifyRecord } from '../resident/keys.mjs';
import { BELLS_PER_DAY, HAMLET_CAP, MOVABLE } from './rules.mjs';

export const BOARD_DOMAIN = 'Wylls test-world board v0';
/** Open requests one participant may have at once. */
export const OPEN_PER_SENDER = 3;
/** Bells after fulfilment within which the requester's return goods must arrive. */
export const RETURN_BELLS = 24;
export const DECLINE_REASONS = Object.freeze(['goal', 'budget', 'deadline', 'terms', 'trust', 'limit', 'route']);

const id16 = s => createHash('sha256').update(s).digest('hex').slice(0, 16);

export class BoardError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function goodsOk(g, { empty = false } = {}) {
  if (!g || typeof g !== 'object') return false;
  const names = Object.keys(g);
  if (!names.length) return empty;
  return names.every(n => MOVABLE.includes(n) && Number.isInteger(g[n]) && g[n] > 0 && g[n] <= HAMLET_CAP);
}

/** True when `goods` holds at least `want`. */
export const covers = (goods, want) => Object.entries(want).every(([n, v]) => (goods[n] ?? 0) >= v);

export class Board {
  constructor(world, state = null) {
    this.world = world;
    this.s = state ?? { posts: [], counts: {} };
  }

  toJSON() { return this.s; }

  /** Posts a signed record; returns its id or throws BoardError. */
  post({ body, sig }) {
    const citizen = this.world.s.byKey[body.from];
    if (!citizen) throw new BoardError('UnknownCitizen', 'the sender has not joined');
    if (!verifyRecord(BOARD_DOMAIN, body, sig, base58decode(body.from))) throw new BoardError('BadSignature', 'not signed by the sender');
    const bell = this.world.bell;
    const id = id16(JSON.stringify([body, sig]));
    if (this.s.posts.some(p => p.id === id)) return id;
    const c = this.s.counts[citizen] ??= { bell: -1, inBell: 0, day: -1, inDay: 0 };
    if (c.bell !== bell) { c.bell = bell; c.inBell = 0; }
    const day = Math.floor(bell / BELLS_PER_DAY);
    if (c.day !== day) { c.day = day; c.inDay = 0; }
    if (c.inBell >= TALK_PER_BELL || c.inDay >= TALK_PER_DAY) throw new BoardError('RateLimited', 'message limit reached');
    const note = sanitize(body.note ?? '', { untrusted: true, limit: 140 });
    let rec;
    if (body.kind === 'request') {
      if (!goodsOk(body.want)) throw new BoardError('BadRequest', 'want must name movable goods');
      if (!goodsOk(body.offer ?? {}, { empty: true })) throw new BoardError('BadRequest', 'bad offer');
      if (!Number.isInteger(body.deadlineBell) || body.deadlineBell <= bell) throw new BoardError('BadRequest', 'deadline must be after now');
      if (body.to != null && !this.world.s.citizens[body.to]) throw new BoardError('BadRequest', 'no such addressee');
      if (body.to === citizen) throw new BoardError('BadRequest', 'a request to oneself');
      if (this.requests({ status: 'open' }).filter(r => r.from === citizen).length >= OPEN_PER_SENDER) throw new BoardError('TooManyOpen', 'open request limit');
      rec = { id, kind: 'request', from: citizen, to: body.to ?? null, want: body.want, offer: body.offer ?? {}, deadlineBell: body.deadlineBell, openIfDeclined: body.openIfDeclined !== false, note, bell };
    } else if (body.kind === 'reply') {
      const req = this.s.posts.find(p => p.kind === 'request' && p.id === body.re);
      if (!req) throw new BoardError('BadRequest', 'reply to no request');
      if (req.from === citizen) throw new BoardError('BadRequest', 'a reply to one\'s own request');
      if (this.s.posts.some(p => p.kind === 'reply' && p.re === req.id && p.from === citizen)) throw new BoardError('AlreadyReplied', 'one reply per request');
      const st = this.statusOf(req);
      if (body.decision === 'accept') {
        if (st.status !== 'open') throw new BoardError('NotOpen', `request is ${st.status}`);
        if (!st.openTo.includes('*') && !st.openTo.includes(citizen)) throw new BoardError('NotAddressed', 'the request is addressed to another');
      } else if (body.decision === 'decline') {
        // Only the addressee declines; on an open request silence is the answer (no pointless replies).
        if (req.to !== citizen) throw new BoardError('NotAddressed', 'only the addressee declines');
        if (!DECLINE_REASONS.includes(body.reason)) throw new BoardError('BadRequest', 'unknown reason');
      } else throw new BoardError('BadRequest', 'decision must be accept or decline');
      rec = { id, kind: 'reply', from: citizen, re: req.id, decision: body.decision, reason: body.reason ?? null, alternative: body.alternative ?? null, note, bell };
    } else throw new BoardError('BadRequest', 'unknown kind');
    c.inBell += 1; c.inDay += 1;
    this.s.posts.push(rec);
    return id;
  }

  /**
   * A request's state from the posts and the world's public events:
   * open (openTo: '*' or addressees), claimed (by, bell), fulfilled (the
   * claimant's caravan carrying `want` arrived by the deadline), returned
   * (the offer came back within RETURN_BELLS), lapsed (claimed, not
   * delivered in time), expired (never claimed), declined (addressee said no,
   * not reopened).
   */
  statusOf(req) {
    const bell = this.world.bell;
    const replies = this.s.posts.filter(p => p.kind === 'reply' && p.re === req.id);
    const accept = replies.find(p => p.decision === 'accept');
    const declinedByTo = req.to != null && replies.some(p => p.decision === 'decline' && p.from === req.to);
    const ev = this.world.s.events;
    const departs = new Map(ev.filter(e => e.kind === 'CaravanDeparted').map(e => [e.caravan, e]));
    const arrivals = (from, to, after, until) => ev.filter(e => e.kind === 'CaravanArrived' && e.src === from && e.dst === to && e.bell <= until && (departs.get(e.caravan)?.bell ?? -1) >= after);
    if (accept) {
      const got = arrivals(accept.from, req.from, accept.bell, req.deadlineBell).find(e => covers(e.goods, req.want));
      if (got) {
        const hasOffer = Object.keys(req.offer).length > 0;
        const back = hasOffer ? arrivals(req.from, accept.from, accept.bell, got.bell + RETURN_BELLS).find(e => covers(e.goods, req.offer)) : null;
        const returned = !hasOffer ? 'none-promised' : back ? 'returned' : bell > got.bell + RETURN_BELLS ? 'not-returned' : 'due';
        return { status: 'fulfilled', by: accept.from, claimBell: accept.bell, deliveredBell: got.bell, caravan: got.caravan, returned, openTo: [] };
      }
      if (bell > req.deadlineBell) return { status: 'lapsed', by: accept.from, claimBell: accept.bell, openTo: [] };
      return { status: 'claimed', by: accept.from, claimBell: accept.bell, openTo: [] };
    }
    if (bell > req.deadlineBell) return { status: 'expired', openTo: [] };
    if (req.to == null) return { status: 'open', openTo: ['*'] };
    if (!declinedByTo) return { status: 'open', openTo: [req.to] };
    if (req.openIfDeclined) return { status: 'open', openTo: ['*'], reopened: true };
    return { status: 'declined', openTo: [] };
  }

  /** Every request with its derived state (filter by status), oldest first; public. */
  requests({ status = null } = {}) {
    return this.s.posts.filter(p => p.kind === 'request').map(r => ({ ...r, ...this.statusOf(r) })).filter(r => !status || r.status === status);
  }

  replies(reqId) { return this.s.posts.filter(p => p.kind === 'reply' && p.re === reqId); }

  /** The board as every participant reads it. */
  view() {
    return structuredClone({ requests: this.requests(), replies: this.s.posts.filter(p => p.kind === 'reply') });
  }
}
