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
    // Indices over the posts and the world's caravan events, rebuilt from the saved posts on open and kept up
    // incrementally, so reading the board costs what changed, not the whole history.
    this.ix = { byId: new Map(), replies: new Map(), requests: [], seq: 0, departs: new Map(), arrivals: new Map(), final: new Map() };
    for (const p of this.s.posts) this.#index(p);
  }

  toJSON() { return this.s; }

  #index(p) {
    this.ix.byId.set(p.id, p);
    if (p.kind === 'request') this.ix.requests.push(p);
    else { if (!this.ix.replies.has(p.re)) this.ix.replies.set(p.re, []); this.ix.replies.get(p.re).push(p); }
  }

  #syncEvents() {
    const ev = this.world.s.events;
    // Events are appended with increasing seq; read only the new ones.
    let i = ev.length;
    while (i > 0 && ev[i - 1].seq > this.ix.seq) i--;
    for (; i < ev.length; i++) {
      const e = ev[i];
      if (e.kind === 'CaravanDeparted') this.ix.departs.set(e.caravan, e.bell);
      if (e.kind === 'CaravanArrived') { const k = `${e.src}>${e.dst}`; if (!this.ix.arrivals.has(k)) this.ix.arrivals.set(k, []); this.ix.arrivals.get(k).push(e); }
      this.ix.seq = e.seq;
    }
  }

  /** Posts a signed record; returns its id or throws BoardError. */
  post({ body, sig }) {
    const citizen = this.world.s.byKey[body.from];
    if (!citizen) throw new BoardError('UnknownCitizen', 'the sender has not joined');
    if (!verifyRecord(BOARD_DOMAIN, body, sig, base58decode(body.from))) throw new BoardError('BadSignature', 'not signed by the sender');
    const bell = this.world.bell;
    const id = id16(JSON.stringify([body, sig]));
    if (this.ix.byId.has(id)) return id;
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
      const req = this.ix.byId.get(body.re);
      if (!req || req.kind !== 'request') throw new BoardError('BadRequest', 'reply to no request');
      if (req.from === citizen) throw new BoardError('BadRequest', 'a reply to one\'s own request');
      if ((this.ix.replies.get(req.id) ?? []).some(p => p.from === citizen)) throw new BoardError('AlreadyReplied', 'one reply per request');
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
    this.#index(rec);
    return id;
  }

  /**
   * A request's state from the posts and the world's public events:
   * open (openTo: '*' or addressees), claimed (by, bell), fulfilled (the
   * claimant's caravan carrying `want` arrived by the deadline), returned
   * (the offer came back within RETURN_BELLS), lapsed (claimed, not
   * delivered in time), expired (never claimed), declined (addressee said no,
   * not reopened). `changedBell` is the last bell at which the state moved;
   * `final` says it never will again (and the answer is kept).
   */
  statusOf(req) {
    const cached = this.ix.final.get(req.id);
    if (cached) return cached;
    this.#syncEvents();
    const bell = this.world.bell;
    const replies = this.ix.replies.get(req.id) ?? [];
    const lastReply = replies.reduce((b, p) => Math.max(b, p.bell), req.bell);
    const accept = replies.find(p => p.decision === 'accept');
    const decline = req.to != null ? replies.find(p => p.decision === 'decline' && p.from === req.to) : null;
    const arrivals = (from, to, after, until) => (this.ix.arrivals.get(`${from}>${to}`) ?? []).filter(e => e.bell <= until && (this.ix.departs.get(e.caravan) ?? -1) >= after);
    const keep = out => { if (out.final) this.ix.final.set(req.id, out); return out; };
    if (accept) {
      const got = arrivals(accept.from, req.from, accept.bell, req.deadlineBell).find(e => covers(e.goods, req.want));
      if (got) {
        const hasOffer = Object.keys(req.offer).length > 0;
        // A return that comes after the window is still a return ('returned-late'): a debt is never closed by time
        // alone, so 'not-returned' stays open (and visible) until it is paid.
        const back = hasOffer ? arrivals(req.from, accept.from, accept.bell, Infinity).find(e => covers(e.goods, req.offer)) : null;
        const inTime = back && back.bell <= got.bell + RETURN_BELLS;
        const returned = !hasOffer ? 'none-promised' : inTime ? 'returned' : back ? 'returned-late' : bell > got.bell + RETURN_BELLS ? 'not-returned' : 'due';
        const changedBell = back ? back.bell : returned === 'not-returned' ? got.bell + RETURN_BELLS + 1 : got.bell;
        return keep({ status: 'fulfilled', by: accept.from, claimBell: accept.bell, deliveredBell: got.bell, caravan: got.caravan, returned, openTo: [], changedBell, final: ['none-promised', 'returned', 'returned-late'].includes(returned) });
      }
      if (bell > req.deadlineBell) return keep({ status: 'lapsed', by: accept.from, claimBell: accept.bell, openTo: [], changedBell: req.deadlineBell + 1, final: true });
      return { status: 'claimed', by: accept.from, claimBell: accept.bell, openTo: [], changedBell: lastReply, final: false };
    }
    if (bell > req.deadlineBell) return keep({ status: 'expired', openTo: [], changedBell: req.deadlineBell + 1, final: true });
    if (req.to == null) return { status: 'open', openTo: ['*'], changedBell: lastReply, final: false };
    if (!decline) return { status: 'open', openTo: [req.to], changedBell: lastReply, final: false };
    if (req.openIfDeclined) return { status: 'open', openTo: ['*'], reopened: true, changedBell: lastReply, final: false };
    return keep({ status: 'declined', openTo: [], changedBell: decline.bell, final: true });
  }

  /** Every request with its derived state (filter by status), oldest first; public. */
  requests({ status = null } = {}) {
    return this.ix.requests.map(r => ({ ...r, ...this.statusOf(r) })).filter(r => !status || r.status === status);
  }

  replies(reqId) { return [...(this.ix.replies.get(reqId) ?? [])]; }

  /**
   * The board as every participant reads it. With `sinceBell`, only requests still moving or changed since then
   * (and their replies): the same for every reader, and bounded by recent activity, not by the board's age.
   */
  view({ sinceBell = 0 } = {}) {
    const requests = this.requests().filter(r => !r.final || r.changedBell >= sinceBell || r.bell >= sinceBell);
    return structuredClone({ requests, replies: requests.flatMap(r => this.ix.replies.get(r.id) ?? []) });
  }
}
