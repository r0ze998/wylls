// The holder gate the existing gateway calls (`ctx.residents.mayAct`): the
// relay (POST /f/relay, settle requesters), the agent wallet (owner commands,
// capability/MCP actions) and, through the same rule, the page.
//
// One rule, the resident program's own `Op` prologue (program/src/lib.rs
// `op`): an actor may act for a resident only if it is
//   (a) the current holder of the resident's Core asset, or
//   (b) the session key the current holder set, in the current holder
//       generation, and not yet expired.
// A transfer (TransferResident) bumps the generation and clears the session
// on chain, so every key of an earlier holder fails (b) for good, also after
// a buy-back (A→B→A), and with no off-chain memory involved.
//
// Every answer comes from a fresh chain read: nothing is cached, so a
// restart changes nothing. Anything that cannot be verified is refused
// (fail closed): an unreadable account, an account of another program, an
// asset outside the collection, a resident account that is missing or bound
// to another asset. A Citizen with no binding is not a resident: the gate
// answers `true` unless `requireBinding` (whether every Citizen must be a
// resident is not decided).
import { readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { MPL_CORE_PROGRAM, verifyResidentAsset } from './core-asset.mjs';
import { residentIdOf } from './ids.mjs';
import { decodeResidentAccount, pdas } from './resident-ix.mjs';

export const GATE_REFUSALS = Object.freeze({
  UNVERIFIED: 'ResidentUnverified',      // a read failed or an account is not what it must be
  NOT_HOLDER: 'ResidentHolderChanged',   // the actor is neither the holder nor the holder's current session
  SESSION_STALE: 'ResidentSessionStale', // the key is a session of an earlier generation or another setter
  SESSION_EXPIRED: 'ResidentSessionExpired',
});

/**
 * Which resident (Core asset) a Citizen stands for. In-memory, or a JSON file
 * written atomically (survives a restart). A binding is one-way: a Citizen
 * never moves to another asset. Who writes bindings, and when, is an
 * integration decision (the Frontier Citizen is keyed by wallet today).
 */
export class ResidentBindings {
  constructor({ file = null, entries = {} } = {}) {
    this.file = file;
    this.writeFailed = false;
    this.map = new Map(Object.entries(file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : entries));
  }
  assetOf(citizen) {
    if (this.writeFailed) throw new Error('resident bindings unavailable after a failed write');
    return this.map.get(citizen) ?? null;
  }
  bind(citizen, asset) {
    if (this.writeFailed) throw new Error('resident bindings unavailable after a failed write');
    const had = this.map.get(citizen);
    if (had && had !== asset) throw new Error(`citizen ${citizen} is bound to ${had}; a binding never moves`);
    const next = new Map(this.map);
    next.set(citizen, asset);
    if (this.file) {
      try { writeFileSync(`${this.file}.tmp`, JSON.stringify(Object.fromEntries(next), null, 1)); renameSync(`${this.file}.tmp`, this.file); }
      catch (e) { this.writeFailed = true; throw e; }
    }
    this.map = next;
  }
}

export class ResidentGate {
  /**
   * @param {object} o
   * @param {{account(address): Promise<{owner, data}|null>}} o.reader  a chain reader (RpcClient or a fake)
   * @param {ResidentBindings} o.bindings
   * @param {string} o.program     the resident program id
   * @param {string} o.collection  the residents' Core collection
   * @param {() => Promise<number>|number} [o.now]  chain time, unix seconds (session expiry)
   * @param {boolean} [o.requireBinding]  refuse Citizens with no resident (not decided; default false)
   */
  constructor({ reader, bindings, program, collection, now = () => Math.floor(Date.now() / 1000), requireBinding = false, log = () => {} }) {
    Object.assign(this, { reader, bindings, program, collection, now, requireBinding, log });
    this.pdas = pdas(program);
  }

  /** The resident behind `citizen` as the chain has it now; `{bound: false}` if none; throws `{code: ResidentUnverified}`. */
  async state(citizen) {
    const asset = this.bindings.assetOf(citizen);
    if (!asset) return { bound: false };
    const fail = why => Object.assign(new Error(`resident of ${citizen} unverified: ${why}`), { code: GATE_REFUSALS.UNVERIFIED, why });
    let a, r;
    try { [a, r] = await Promise.all([this.reader.account(asset), this.reader.account(this.pdas.resident(asset))]); } catch (e) { throw fail(`read failed (${e.message})`); }
    const v = verifyResidentAsset({ account: a ? { ...a, address: asset, flags: {} } : null, expected: { program: MPL_CORE_PROGRAM, collection: this.collection } });
    if (!v.ok) throw fail(`asset: ${v.code}`);
    if (!r || r.owner !== this.program) throw fail('no resident account of the resident program');
    const res = decodeResidentAccount(r.data);
    if (!res || res.asset !== asset || res.tag15 !== residentIdOf(asset)) throw fail('the resident account is not bound to this asset');
    return { bound: true, asset, holder: v.holder, gen: res.gen, session: res.session, sessionExpiry: Number(res.sessionExpiry), sessionGen: res.sessionGen, sessionSetter: res.sessionSetter };
  }

  /** `{ok, code?, state?}` for `actor` acting for `citizen` now. */
  async check({ citizen, actor }) {
    let s;
    try { s = await this.state(citizen); } catch (e) { this.log(`resident gate: ${e.message}`); return { ok: false, code: e.code ?? GATE_REFUSALS.UNVERIFIED, why: e.why }; }
    if (!s.bound) return this.requireBinding ? { ok: false, code: GATE_REFUSALS.UNVERIFIED, why: 'no resident bound to this Citizen' } : { ok: true, unbound: true };
    if (actor === s.holder) return { ok: true, state: s };
    if (actor !== s.session) return { ok: false, code: GATE_REFUSALS.NOT_HOLDER, state: s };
    if (s.sessionSetter !== s.holder || s.sessionGen !== s.gen) return { ok: false, code: GATE_REFUSALS.SESSION_STALE, state: s };
    if (!(Number(await this.now()) < s.sessionExpiry)) return { ok: false, code: GATE_REFUSALS.SESSION_EXPIRED, state: s };
    return { ok: true, state: s };
  }

  /** The hook the gateway calls. */
  async mayAct({ citizen, actor }) { return (await this.check({ citizen, actor })).ok; }
}
