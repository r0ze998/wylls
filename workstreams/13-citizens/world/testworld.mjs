// A local, independent test world for the residents (MOCK: not the Frontier
// program, not a chain). It keeps the game's figures (rules.mjs) and the
// shape of the real paths: every participant joins with its own key and gets
// the starter kit, every action is a signed request with an idempotency key
// that is sent, then lands or fails at the next bell (as a transaction
// lands in a slot), and everything a participant may read comes from one
// `view(viewer)` that is the same function for a person and a resident.
//
// The operator's powers (advance the clock, script a raid) are on
// `world.operator` and are never handed to a participant.
import { createHash } from 'node:crypto';
import { decode as base58decode } from '../../../permutation-gateway/client/src/base58.mjs';
import { verifyRecord } from '../resident/keys.mjs';
import {
  BELLS_PER_DAY, BUCKET, BUILD_BELLS, BUILDINGS, CARAVAN_FEE, HAMLET_CAP, MILLI, MOVABLE, RELAY_PER_DAY, RESOURCES,
  STARTER_KIT, caravanBells, prodPerBellMilli, resIndex,
} from './rules.mjs';

export const ACTION_DOMAIN = 'Wylls test-world action v0';
export const JOIN_DOMAIN = 'Wylls test-world join v0';
/** The only actions a participant can ask for (player actions; nothing an operator can do). */
export const PLAYER_ACTIONS = Object.freeze(['Build', 'SendCaravan']);
/** Lamports the sponsor covers per citizen and game day (a mock of quota.mjs's lamports quota): enough for six caravans. */
export const SPONSOR_LAMPORTS_PER_DAY = 6 * CARAVAN_FEE;

const sha16 = s => createHash('sha256').update(s).digest('hex').slice(0, 16);
const units = milli => Math.floor(milli / MILLI);

export class WorldError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export class TestWorld {
  constructor(state = null) {
    this.s = state ?? { v: 1, bell: 0, seq: 0, citizens: {}, byKey: {}, requests: {}, queue: [], caravans: [], events: [], raids: [], waste: {} };
    this.operator = Object.freeze({
      tick: (n = 1) => { for (let i = 0; i < n; i++) this.#tick(); },
      raidRoute: (fromCitizen, toCitizen, { fromBell = 0, toBell = Infinity } = {}) => this.s.raids.push({ from: fromCitizen, to: toCitizen, fromBell, toBell: toBell === Infinity ? null : toBell }),
      // A TEST FIXTURE, not a model of war periods: a public marker that a boundary passed, with no rule attached.
      // How periods are cut and what they count is undecided and belongs to workstreams 4 and 8; this only lets
      // the tests put a boundary in the middle of running work and show that nothing here depends on it.
      markBoundary: label => this.#event({ kind: 'BoundaryMarker', label: String(label), fixture: true }),
    });
  }

  toJSON() { return this.s; }
  static fromJSON(s) { return new TestWorld(structuredClone(s)); }

  get bell() { return this.s.bell; }

  // ---------------------------------------------------------------- joining

  /**
   * Join with a signed record `{name, pos:{q,r}, key}`: the same rule for a
   * person and a resident (one village, the starter kit, no extra stock).
   * The caller's kind is not asked for and not stored.
   */
  join({ body, sig }) {
    const pub = base58decode(body.key);
    if (!verifyRecord(JOIN_DOMAIN, body, sig, pub)) throw new WorldError('BadSignature', 'join record not signed by its key');
    if (this.s.byKey[body.key]) throw new WorldError('AlreadyJoined', 'this key has a village');
    const id = `c${Object.keys(this.s.citizens).length + 1}`;
    this.s.citizens[id] = {
      id, key: body.key, name: String(body.name).slice(0, 32), pos: { q: body.pos.q | 0, r: body.pos.r | 0 }, joinedBell: this.s.bell,
      stores: STARTER_KIT.map(x => x * MILLI), buildings: [], building: [],
      bucket: { tokens: BUCKET.burst, at: this.s.bell }, relay: { day: this.#day(), used: 0, lamports: 0 },
    };
    this.s.byKey[body.key] = id;
    this.#event({ kind: 'Joined', citizen: id, name: this.s.citizens[id].name, pos: this.s.citizens[id].pos });
    return id;
  }

  // ---------------------------------------------------------------- reading

  /**
   * What `viewerKey` may read: the public part (identical for every viewer:
   * villages, their stores and buildings as chain accounts are readable by
   * anyone, caravans on the road, the public event log) and the viewer's own
   * quota and pending requests. No participant is labelled AI or person.
   */
  view(viewerKey, { since = 0 } = {}) {
    const me = this.s.byKey[viewerKey] ?? null;
    const c = me ? this.s.citizens[me] : null;
    return structuredClone({
      bell: this.s.bell,
      villages: Object.values(this.s.citizens).map(v => ({
        citizen: v.id, owner: v.key, name: v.name, pos: v.pos, tier: 'Hamlet', cap: HAMLET_CAP,
        stores: Object.fromEntries(RESOURCES.map((r, i) => [r, units(v.stores[i])])),
        buildings: [...v.buildings], building: v.building.map(b => ({ item: b.item, doneBell: b.doneBell })),
      })),
      caravans: this.s.caravans.filter(k => k.state === 'road').map(k => ({ id: k.id, owner: k.owner, src: k.src, dst: k.dst, goods: k.goods, departBell: k.departBell, arriveBell: k.arriveBell })),
      // Events are numbered 1, 2, … in order, so `since` is an index: a reader pays for what is new.
      events: this.s.events.slice(Math.max(0, Math.min(since, this.s.events.length))),
      me: c ? {
        citizen: c.id, quota: { bucket: this.#bucketNow(c), relayLeft: this.#relayLeft(c), lamportsLeft: SPONSOR_LAMPORTS_PER_DAY - this.#relayNow(c).lamports },
        pending: this.s.queue.filter(q => q.actor === c.id).map(q => ({ key: q.key.slice(q.key.indexOf(':') + 1), name: q.action.name })),
      } : null,
    });
  }

  // ---------------------------------------------------------------- acting

  /**
   * A signed action request (`body` = {key: idempotency key, actor: the
   * signer's address, action: {name, fields}}). Answers like the agent
   * gateway's ActionResult: `sent` (queued for the next bell; `signature`
   * names it), `refused` (nothing queued) or the recorded answer again with
   * `replayed: true` for the same key and body.
   */
  submit({ body, sig }) {
    const id = this.s.byKey[body.actor];
    if (!id) return { ok: false, status: 'refused', error: { code: 'UnknownCitizen', message: 'the signer has not joined' } };
    if (!verifyRecord(ACTION_DOMAIN, body, sig, base58decode(body.actor))) return { ok: false, status: 'refused', error: { code: 'BadSignature', message: 'not signed by the actor' } };
    // Keys are the actor's own namespace: one participant cannot occupy or read another's key.
    const slot = `${id}:${body.key}`;
    const bodyHash = sha16(JSON.stringify(body));
    const prior = this.s.requests[slot];
    if (prior) {
      if (prior.bodyHash !== bodyHash) return { ok: false, status: 'refused', error: { code: 'IdempotencyConflict', message: 'key used for another request' } };
      return { ...prior.result, replayed: true };
    }
    const refuse = (code, message) => {
      const result = { ok: false, status: 'refused', error: { code, message } };
      this.s.requests[slot] = { bodyHash, result, at: this.s.bell };
      return result;
    };
    const c = this.s.citizens[id];
    const a = body.action ?? {};
    if (!PLAYER_ACTIONS.includes(a.name)) return refuse('ActionNotAllowed', `${a.name} is not a player action`);
    const shape = this.#shape(c, a);
    if (shape) return refuse(shape.code, shape.message);
    if (this.#bucketNow(c) < 1) return refuse('BucketEmpty', 'the 30/h action bucket is empty');
    if (this.#relayLeft(c) < 1) return refuse('QuotaExceeded', 'the relay quota for today is used');
    if (a.name === 'SendCaravan' && this.#relayNow(c).lamports + CARAVAN_FEE > SPONSOR_LAMPORTS_PER_DAY) return refuse('QuotaExceeded', 'the sponsored lamports for today are used');
    c.bucket.tokens -= 1;
    const r = this.#relayNow(c);
    r.used += 1;
    if (a.name === 'SendCaravan') r.lamports += CARAVAN_FEE;
    const signature = `tx-${sha16(JSON.stringify([body, sig]))}`;
    this.s.queue.push({ key: slot, actor: id, action: structuredClone(a), signature, sentBell: this.s.bell });
    const result = { ok: true, status: 'sent', signature };
    this.s.requests[slot] = { bodyHash, result, at: this.s.bell, signature, fate: 'pending' };
    return result;
  }

  /** The recorded answer for one of `actorKey`'s idempotency keys (null: never seen), with the transaction's fate. */
  status(key, actorKey) {
    const r = this.s.requests[`${this.s.byKey[actorKey]}:${key}`];
    if (!r) return null;
    return { ...r.result, fate: r.fate ?? null, fateError: r.fateError ?? null, landedBell: r.landedBell ?? null };
  }

  /** Withdraws a sent request before it lands (the next bell). A landed one is not rolled back. */
  cancel(key, actorKey) {
    const slot = `${this.s.byKey[actorKey]}:${key}`;
    const i = this.s.queue.findIndex(q => q.key === slot);
    if (i < 0) {
      const r = this.s.requests[slot];
      return { cancelled: false, reason: r?.fate === 'landed' ? 'AlreadyLanded' : r ? 'NotPending' : 'Unknown' };
    }
    const [q] = this.s.queue.splice(i, 1);
    const r = this.s.requests[slot];
    r.fate = 'cancelled';
    const c = this.s.citizens[q.actor];
    this.#relayNow(c).used -= 1;
    if (q.action.name === 'SendCaravan') this.#relayNow(c).lamports -= CARAVAN_FEE;
    return { cancelled: true };
  }

  // ---------------------------------------------------------------- inside

  #day() { return Math.floor(this.s.bell / BELLS_PER_DAY); }
  #relayNow(c) { if (c.relay.day !== this.#day()) c.relay = { day: this.#day(), used: 0, lamports: 0 }; return c.relay; }
  #relayLeft(c) { return RELAY_PER_DAY - this.#relayNow(c).used; }
  #bucketNow(c) {
    const gained = Math.floor((this.s.bell - c.bucket.at) * BUCKET.perHour / 6);
    if (gained > 0) { c.bucket.tokens = Math.min(BUCKET.burst, c.bucket.tokens + gained); c.bucket.at = this.s.bell; }
    return c.bucket.tokens;
  }

  #shape(c, a) {
    const f = a.fields ?? {};
    if (a.name === 'Build') {
      if (!BUILDINGS.some(b => b.item === f.item)) return { code: 'BadItem', message: `no building ${f.item}` };
      return null;
    }
    if (!this.s.citizens[f.to]) return { code: 'BadDestination', message: 'no such village' };
    if (f.to === c.id) return { code: 'BadDestination', message: 'a caravan to the sender itself' };
    const goods = f.goods ?? {};
    const names = Object.keys(goods);
    if (!names.length) return { code: 'EmptyCaravan', message: 'nothing to carry' };
    for (const n of names) {
      if (!MOVABLE.includes(n)) return { code: 'NotMovable', message: `${n} cannot be carried` };
      if (!Number.isInteger(goods[n]) || goods[n] <= 0) return { code: 'BadAmount', message: `${n}: ${goods[n]}` };
    }
    return null;
  }

  #event(e) { this.s.events.push({ seq: ++this.s.seq, bell: this.s.bell, ...e }); }

  #fail(q, code) {
    const r = this.s.requests[q.key];
    r.fate = 'failed'; r.fateError = code; r.landedBell = this.s.bell;
    this.#event({ kind: 'Failed', citizen: q.actor, action: q.action.name, code, signature: q.signature });
  }

  #credit(c, i, milli) {
    const room = HAMLET_CAP * MILLI - c.stores[i];
    const add = Math.max(0, Math.min(room, milli));
    c.stores[i] += add;
    if (milli > add) this.s.waste[c.id] = (this.s.waste[c.id] ?? 0) + (milli - add);
  }

  #apply(q) {
    const c = this.s.citizens[q.actor];
    const f = q.action.fields;
    if (q.action.name === 'Build') {
      const b = BUILDINGS.find(x => x.item === f.item);
      for (const [n, v] of Object.entries(b.cost)) if (c.stores[resIndex(n)] < v * MILLI) return this.#fail(q, 'InsufficientStores');
      for (const [n, v] of Object.entries(b.cost)) c.stores[resIndex(n)] -= v * MILLI;
      c.building.push({ item: f.item, doneBell: this.s.bell + BUILD_BELLS });
      this.#event({ kind: 'BuildStarted', citizen: c.id, item: f.item, doneBell: this.s.bell + BUILD_BELLS, signature: q.signature });
    } else {
      for (const [n, v] of Object.entries(f.goods)) if (c.stores[resIndex(n)] < v * MILLI) return this.#fail(q, 'InsufficientStores');
      for (const [n, v] of Object.entries(f.goods)) c.stores[resIndex(n)] -= v * MILLI;
      const dst = this.s.citizens[f.to];
      const k = { id: `k${this.s.caravans.length + 1}`, owner: c.id, src: c.id, dst: dst.id, goods: { ...f.goods }, departBell: this.s.bell, arriveBell: this.s.bell + caravanBells(c.pos, dst.pos), state: 'road', signature: q.signature };
      this.s.caravans.push(k);
      this.#event({ kind: 'CaravanDeparted', caravan: k.id, owner: c.id, src: c.id, dst: dst.id, goods: k.goods, arriveBell: k.arriveBell, signature: q.signature });
    }
    const r = this.s.requests[q.key];
    r.fate = 'landed'; r.landedBell = this.s.bell;
  }

  #tick() {
    this.s.bell += 1;
    const queue = this.s.queue.splice(0);
    for (const q of queue) this.#apply(q);
    for (const c of Object.values(this.s.citizens)) {
      for (let i = 0; i < RESOURCES.length; i++) this.#credit(c, i, prodPerBellMilli(i, c.buildings));
      for (const b of c.building.filter(x => x.doneBell <= this.s.bell)) {
        c.buildings.push(b.item);
        this.#event({ kind: 'BuildDone', citizen: c.id, item: b.item });
      }
      c.building = c.building.filter(x => x.doneBell > this.s.bell);
    }
    for (const k of this.s.caravans.filter(x => x.state === 'road' && x.arriveBell <= this.s.bell)) {
      const raid = this.s.raids.find(r => r.from === k.src && r.to === k.dst && k.departBell >= r.fromBell && (r.toBell === null || k.departBell <= r.toBell));
      if (raid) {
        k.state = 'raided';
        this.#event({ kind: 'CaravanRaided', caravan: k.id, owner: k.owner, src: k.src, dst: k.dst, goods: k.goods });
        continue;
      }
      const dst = this.s.citizens[k.dst];
      for (const [n, v] of Object.entries(k.goods)) this.#credit(dst, resIndex(n), v * MILLI);
      k.state = 'arrived';
      this.#event({ kind: 'CaravanArrived', caravan: k.id, owner: k.owner, src: k.src, dst: k.dst, goods: k.goods });
    }
  }
}
