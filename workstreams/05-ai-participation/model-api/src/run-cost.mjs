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
/**
 * What may close an undecided call. 'fixture' is a test record. No production source is listed: which provider report
 * gives per-request usage, and whether it can be matched to our ids, is not verified (an approval item).
 */
const EVIDENCE = new Set(['fixture']);
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

  /** Whether `amount` could be reserved now (no change): null, or {code, message}. reserve() applies the same checks. */
  check(amount) {
    const a = big(amount);
    const day = dayOf(this.now());
    if (this.caps.perCall !== null && a > big(this.caps.perCall)) return { code: 'PerCallLimit', message: `quote ${a} over the per-call cap ${this.caps.perCall}` };
    if (this.caps.perDay !== null && this.#spentOrHeld(day) + a > big(this.caps.perDay)) return { code: 'CategoryDayLimit', message: `inference day cap ${this.caps.perDay}: ${this.#spentOrHeld(day)} used or held + quote ${a}` };
    if (this.caps.total !== null && this.#spentOrHeld() + a > big(this.caps.total)) return { code: 'CategoryTotalLimit', message: `inference total cap ${this.caps.total}: ${this.#spentOrHeld()} used or held + quote ${a}` };
    if (a > this.available) return { code: 'InsufficientBalance', message: `available ${this.available} < quote ${a} (game reserve ${this.gameReserve} kept apart)` };
    return null;
  }

  /** Synchronous: check and hold in one step. Throws {code}. */
  reserve(key, amount) {
    if (this.items.has(key)) throw Object.assign(new Error(`key ${key} already used: a retry is a new call with a new key`), { code: 'DuplicateKey' });
    const a = big(amount);
    const day = dayOf(this.now());
    const no = this.check(a);
    if (no) throw Object.assign(new Error(no.message), { code: no.code });
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

  /**
   * Only an outside answer decides an undecided call, and never the operator's word alone:
   *   by 'provider-report'  settle at the measured amount (≤ the reservation), with `evidence` {source, ref}
   *   by 'operator' 'charge' settle at the reservation (the most the owner agreed to pay for this call), with a note
   *   by 'operator' 'refund' release it, ONLY with `evidence` that the provider did not bill (a provider record)
   * An undecided cost with no such evidence stays undecided: not 0, not refunded, not withdrawable.
   * `evidence.source` 'fixture' marks a test record: the result says productionVerified: false.
   */
  decide(key, { by, amount = null, outcome = null, note, evidence = null }) {
    const it = this.items.get(key);
    if (!it || it.state !== 'undecided') throw Object.assign(new Error('no undecided call with this key'), { code: 'NotUndecided' });
    if (!note) throw Object.assign(new Error('a decision needs a note (what evidence)'), { code: 'NoteRequired' });
    const ev = evidence && EVIDENCE.has(evidence.source) && evidence.ref ? { source: evidence.source, ref: String(evidence.ref), productionVerified: evidence.source !== 'fixture' } : null;
    const needEvidence = by === 'provider-report' || (by === 'operator' && outcome === 'refund');
    if (needEvidence && !ev) throw Object.assign(new Error(`${by === 'provider-report' ? 'a provider report' : 'a refund'} needs evidence {source: ${[...EVIDENCE].join('|')}, ref}: the operator's judgement alone does not make an unknown cost 0`), { code: 'EvidenceRequired' });
    let r;
    if (by === 'provider-report') r = this.settle(key, amount, `provider report: ${note}`);
    else if (by === 'operator' && outcome === 'charge') r = this.settle(key, it.amount, `operator: ${note}`);
    else if (by === 'operator' && outcome === 'refund') { it.state = 'reserved'; r = this.release(key, `refund on a provider record: ${note}`); }
    else throw Object.assign(new Error('by: provider-report (with amount and evidence) or operator (charge | refund with evidence)'), { code: 'BadDecision' });
    it.evidence = ev ?? { source: 'operator-note-only', ref: null, productionVerified: false };
    this.log.push({ op: 'decide', key, by, outcome, evidence: it.evidence });
    return { ...r, evidence: it.evidence };
  }

  /** A process restart: whatever was calling may have reached the provider. */
  restart() {
    for (const it of this.items.values()) if (it.state === 'calling') Object.assign(it, { state: 'undecided', why: 'restart while calling' });
    for (const it of this.items.values()) if (it.state === 'reserved') { this.available += big(it.amount); Object.assign(it, { state: 'released', reason: 'restart before calling' }); }
  }

  /** The four classes (as named in ④'s summary; ④'s contract itself is not received), and what the owner could withdraw (available only). */
  classes() {
    const sum = st => [...this.items.values()].filter(i => i.state === st).reduce((s, i) => s + big(st === 'settled' ? i.settled : i.amount), 0n).toString();
    return { reserved: String(big(sum('reserved')) + big(sum('calling'))), settled: sum('settled'), undecided: sum('undecided'), released: sum('released'),
      available: String(this.available), gameReserve: String(this.gameReserve), withdrawable: String(this.available), overruns: this.overruns.length };
  }

  /**
   * The same money in ④'s four class names (received ④ CONTRACTS §6.2, 2e536b6b): reserved = held before or during a
   * call; charged = settled from a usage report or the operator's charge; unconfirmed = sent, no usage (⑤'s undecided);
   * released = provably not sent, or refunded on a provider record. NAMES ONLY: ④'s classes count relay fees in
   * lamports per signed attempt, these count model inference in test-USDC base units. Two ledgers, never summed.
   */
  fourClasses() {
    const c = this.classes();
    return { unit: 'test-USDC base units (model inference)', reserved: c.reserved, charged: c.settled, unconfirmed: c.undecided, released: c.released };
  }
}
