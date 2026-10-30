// The cost side of one agent's runs, as ⑤ needs it from ④ — an EXPLICIT MOCK.
// ④'s report (bd415e7) was not received; its summary names four cost classes
// (reserved, settled, undecided, released), which this mock keeps. It is in
// memory only: it is not a ledger, it persists nothing, and it guards one
// process. The real money stays with the relay's ledger (AgentLedger); the
// wiring between the two is a proposal (MODEL-API.ja.md §4).
//
// Rules this mock enforces (and the tests check):
//   - a call is reserved BEFORE it is made, at its quote; no reservation, no call
//   - the quote is checked against the available balance and the inference caps (per call, per day, total)
//   - a game reserve can be set aside so that inference cannot spend what the game action needs
//   - settled ≤ reserved; anything measured above the quote is the operator's overrun record, not the owner's charge
//   - undecided money is never released or made available by this code; only an outside answer moves it
//     (the provider's usage report, or the operator's decision, both with a note)
//   - a restart turns every call that was in flight into undecided
const big = v => BigInt(v ?? 0);
const dayOf = ms => new Date(ms).toISOString().slice(0, 10);

export class RunCostMock {
  constructor({ available, caps = {}, now = () => Date.now() }) {
    this.status = 'MOCK of ④ (bd415e7 not received): in memory, one process';
    this.available = big(available);
    this.caps = { perCall: caps.perCall ?? null, perDay: caps.perDay ?? null, total: caps.total ?? null };
    this.gameReserve = 0n;
    this.now = now;
    /** key → {amount, state: 'reserved'|'calling'|'settled'|'released'|'undecided', day, settled?, reason?} */
    this.items = new Map();
    this.overruns = [];
    this.log = [];
  }

  #spentOrHeld(day = null) {
    let t = 0n;
    for (const it of this.items.values()) {
      if (day && it.day !== day) continue;
      if (it.state === 'settled') t += big(it.settled);
      else if (it.state === 'reserved' || it.state === 'calling' || it.state === 'undecided') t += big(it.amount);
    }
    return t;
  }

  /** Money the game path needs kept apart from inference (e.g. the USDC price of the action the agent may take). */
  setGameReserve(amount) {
    const a = big(amount);
    if (a > this.available + this.gameReserve) throw Object.assign(new Error('the game reserve exceeds the available balance'), { code: 'InsufficientBalance' });
    this.available += this.gameReserve - a;
    this.gameReserve = a;
  }

  /** Synchronous: check and hold in one step. Throws {code}. */
  reserve(key, amount) {
    if (this.items.has(key)) throw Object.assign(new Error(`key ${key} already used: a retry is a new call with a new key`), { code: 'DuplicateKey' });
    const a = big(amount);
    const day = dayOf(this.now());
    if (this.caps.perCall !== null && a > big(this.caps.perCall)) throw Object.assign(new Error(`quote ${a} over the per-call cap ${this.caps.perCall}`), { code: 'PerCallLimit' });
    if (this.caps.perDay !== null && this.#spentOrHeld(day) + a > big(this.caps.perDay)) throw Object.assign(new Error('inference day cap'), { code: 'CategoryDayLimit' });
    if (this.caps.total !== null && this.#spentOrHeld() + a > big(this.caps.total)) throw Object.assign(new Error('inference total cap'), { code: 'CategoryTotalLimit' });
    if (a > this.available) throw Object.assign(new Error(`available ${this.available} < quote ${a} (game reserve ${this.gameReserve} kept apart)`), { code: 'InsufficientBalance' });
    this.available -= a;
    const it = { key, amount: String(a), state: 'reserved', day };
    this.items.set(key, it);
    this.log.push({ op: 'reserve', key, amount: String(a) });
    return { ...it };
  }

  calling(key) { const it = this.items.get(key); if (it && it.state === 'reserved') it.state = 'calling'; }

  /** The call's measured cost: settled at most at its reservation; the rest comes back. */
  settle(key, measured, note = '') {
    const it = this.items.get(key);
    if (!it || (it.state !== 'reserved' && it.state !== 'calling' && it.state !== 'undecided')) return null;
    const m = big(measured);
    const charged = m < big(it.amount) ? m : big(it.amount);
    if (m > big(it.amount)) this.overruns.push({ key, quote: it.amount, measured: String(m), note: 'measured above the quote: the owner pays the quote; the difference is the operator\'s' });
    this.available += big(it.amount) - charged;
    Object.assign(it, { state: 'settled', settled: String(charged), note });
    this.log.push({ op: 'settle', key, settled: String(charged) });
    return { ...it };
  }

  /** Nothing was billed (provably not sent, or a refusal with no usage that the provider does not bill): all back. */
  release(key, reason) {
    const it = this.items.get(key);
    if (!it || (it.state !== 'reserved' && it.state !== 'calling')) return null; // an undecided item is never released here
    this.available += big(it.amount);
    Object.assign(it, { state: 'released', reason });
    this.log.push({ op: 'release', key, reason });
    return { ...it };
  }

  /** The provider may have billed and we cannot know: the money stays held. */
  undecided(key, why) {
    const it = this.items.get(key);
    if (!it || (it.state !== 'reserved' && it.state !== 'calling')) return null;
    Object.assign(it, { state: 'undecided', why });
    this.log.push({ op: 'undecided', key, why });
    return { ...it };
  }

  /** Only an outside answer decides an undecided call: the provider's usage report (amount) or the operator (charge/refund), with a note. */
  decide(key, { by, amount = null, outcome = null, note }) {
    const it = this.items.get(key);
    if (!it || it.state !== 'undecided') throw Object.assign(new Error('no undecided call with this key'), { code: 'NotUndecided' });
    if (!note) throw Object.assign(new Error('a decision needs a note (what evidence)'), { code: 'NoteRequired' });
    if (by === 'provider-report') return this.settle(key, amount, `provider report: ${note}`);
    if (by === 'operator' && outcome === 'charge') return this.settle(key, it.amount, `operator: ${note}`);
    if (by === 'operator' && outcome === 'refund') { it.state = 'reserved'; return this.release(key, `operator refund: ${note}`); }
    throw Object.assign(new Error('by: provider-report (with amount) or operator (charge|refund)'), { code: 'BadDecision' });
  }

  /** A process restart: whatever was calling may have reached the provider. */
  restart() {
    for (const it of this.items.values()) if (it.state === 'calling') Object.assign(it, { state: 'undecided', why: 'restart while calling' });
    for (const it of this.items.values()) if (it.state === 'reserved') { this.available += big(it.amount); Object.assign(it, { state: 'released', reason: 'restart before calling' }); }
  }

  /** The four classes (④'s summary), and what the owner could withdraw (available only). */
  classes() {
    const sum = st => [...this.items.values()].filter(i => i.state === st).reduce((s, i) => s + big(st === 'settled' ? i.settled : i.amount), 0n).toString();
    return { reserved: String(big(sum('reserved')) + big(sum('calling'))), settled: sum('settled'), undecided: sum('undecided'), released: sum('released'),
      available: String(this.available), gameReserve: String(this.gameReserve), withdrawable: String(this.available), overruns: this.overruns.length };
  }
}
