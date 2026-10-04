// The ledger (contract §5.1): the code-held state of one AI citizen: goals,
// trust (a code part and a model part), grievances, standing orders, counters
// and the feed cursor. `STATE/ledger/<tag>.json`, schema v2.
//
//   Ledger.create({tag, goals, bell}) / Ledger.load(path) / ledger.save(path)
//   ledger.apply(delta)                     code deltas from episodes_from_events
//   ledger.applyModelDeltas(list, {bell})   the model's `trust` answers
//   ledger.decay(opts) / advanceDay(day, opts)   once per game day, toward 0 (§2.1)
//   ledger.standing(bell)                   {reserved, declined_calls}, expired entries pruned
//
// Trust = t_code + t_model, clamped -100..100. Model deltas are +-10 per handle
// per decision and at most +-15 per handle per game day (the excess is clipped).
// Grievances exist only by code; `answered` is set only by code (an `answered`
// delta). `commitments` is reserved and always [] (pacts are deferred, App. A).
//
// Additive fields beyond the §5.1 example (documented in AC2-NOTES.md):
// `decay_day`, grievance `nation` and `answered_bell`, `nations[f].model_today`.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MAX_TRUST_EPISODE_IDS, MODEL_DAILY_MAX, MODEL_DELTA_MAX, canonical, dayOf } from './config.mjs';
import { tagHex } from '../persona/names.mjs';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const clampTrust = v => clamp(v, -100, 100);
const toward0 = (v, step) => (v > 0 ? Math.max(0, v - step) : v < 0 ? Math.min(0, v + step) : 0);
const blank = () => ({ t_code: 0, t_model: 0, model_today: 0, last_bell: 0, episodes: [] });

export class Ledger {
  constructor(state) { this.s = state; }

  static create({ tag, goals = [], bell = 0 } = {}) {
    return new Ledger({
      v: 2, tag: tagHex(tag), day: dayOf(bell), decay_day: dayOf(bell),
      goals: goals.map(g => ({ id: g.id, progress: 0, status: 'active', since_bell: bell, memory: !!g.memory })),
      trust: { citizens: {}, nations: {} },
      commitments: [],
      grievances: [],
      standing: { reserved: [], declined_calls: [] },
      day_start: { bell, home_troops: 0, march_troops_model: 0 },
      seq: { talk: 0, ballot: 0 },
      cursor: { event_seq: '0', bell: 0 },
      counters: { day: dayOf(bell), sessions: 0, reactions: 0, messages: 0, marches: 0 },
    });
  }
  static load(path) { return new Ledger(JSON.parse(readFileSync(path, 'utf8'))); }
  save(path) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.s, null, 1)}\n`);
    renameSync(tmp, path);
  }
  /** A deep copy of the state (the renderers take this). */
  snapshot() { return JSON.parse(JSON.stringify(this.s)); }
  get tag() { return this.s.tag; }
  canonical() { return canonical(this.s); }

  // ------------------------------------------------------------------ trust
  _entry(who) {
    const t = this.s.trust;
    if (String(who).startsWith('nation:')) {
      const f = String(who).slice(7);
      return (t.nations[f] ??= { t_code: 0, t_model: 0, model_today: 0 });
    }
    return (t.citizens[tagHex(who)] ??= blank());
  }
  /** `{total, t_code, t_model}` of a citizen tag or "nation:<f>"; zeros when unknown. */
  trustOf(who) {
    const w = String(who);
    const e = w.startsWith('nation:') ? this.s.trust.nations[w.slice(7)] : this.s.trust.citizens[tagHex(w)];
    if (!e) return { total: 0, t_code: 0, t_model: 0 };
    return { total: clampTrust(e.t_code + e.t_model), t_code: e.t_code, t_model: e.t_model };
  }

  /**
   * Apply one code delta (from episodes_from_events). Idempotent: a delta whose id was applied before is ignored.
   * @returns {boolean} true when it changed the ledger
   */
  apply(delta) {
    if (delta.kind === 'trust') {
      const e = this._entry(delta.who);
      if (e.episodes) {
        if (e.episodes.includes(delta.id)) return false;
        e.episodes.push(delta.id);
        if (e.episodes.length > MAX_TRUST_EPISODE_IDS) e.episodes.splice(0, e.episodes.length - MAX_TRUST_EPISODE_IDS);
        e.last_bell = Math.max(e.last_bell, delta.bell);
      } else {
        // nation entries carry no id list: dedupe on the delta id kept beside them
        const seen = (this.s.trust.applied ??= []);
        if (seen.includes(delta.id)) return false;
        seen.push(delta.id);
        if (seen.length > 64) seen.shift();
      }
      e.t_code = clampTrust(e.t_code + delta.amount);
      return true;
    }
    if (delta.kind === 'grievance') {
      if (this.s.grievances.some(g => g.id === delta.id)) return false;
      this.s.grievances.push({ id: delta.id, against: delta.against, nation: delta.nation ?? null, event: delta.event, bell: delta.bell, weight: delta.weight, answered: false, answered_bell: null });
      return true;
    }
    if (delta.kind === 'answered') {
      const g = this.s.grievances.find(x => x.id === delta.grievance);
      if (!g || g.answered) return false;
      g.answered = true;
      g.answered_bell = delta.bell;
      return true;
    }
    throw new Error(`ledger: unknown delta kind ${delta.kind}`);
  }
  applyAll(deltas) { let n = 0; for (const d of deltas) if (this.apply(d)) n++; return n; }

  /**
   * The model's trust answers: [{who, delta}], +-10 each, the day's sum per handle limited to +-15.
   * @returns {{who:string, applied:number, clipped:boolean}[]}
   */
  applyModelDeltas(list, { bell = 0 } = {}) {
    const out = [];
    for (const { who, delta } of list ?? []) {
      const raw = Math.trunc(Number(delta) || 0);
      const d = clamp(raw, -MODEL_DELTA_MAX, MODEL_DELTA_MAX);
      const e = this._entry(who);
      const room = clamp((e.model_today ?? 0) + d, -MODEL_DAILY_MAX, MODEL_DAILY_MAX) - (e.model_today ?? 0);
      e.model_today = (e.model_today ?? 0) + room;
      e.t_model = clampTrust(e.t_model + room);
      if (e.last_bell !== undefined) e.last_bell = Math.max(e.last_bell, bell);
      out.push({ who: String(who), applied: room, clipped: room !== raw });
    }
    return out;
  }

  /**
   * One decay step (a game day passed): each trust part moves toward 0 by d = ceil((100 - grudge) / 20);
   * toward citizens of the AI's own nation by max(1, d - floor(loyalty / 34)).
   * @param {{temperament:{grudge:number, loyalty:number}, ownNation:number, nationOf?:(tag:string)=>number|null}} o
   */
  decay({ temperament, ownNation, nationOf = () => null } = {}) {
    const d = Math.ceil((100 - temperament.grudge) / 20);
    const own = Math.max(1, d - Math.floor(temperament.loyalty / 34));
    for (const [tag, e] of Object.entries(this.s.trust.citizens)) {
      const step = nationOf(tag) === ownNation ? own : d;
      e.t_code = toward0(e.t_code, step);
      e.t_model = toward0(e.t_model, step);
    }
    for (const [f, e] of Object.entries(this.s.trust.nations)) {
      const step = Number(f) === ownNation ? own : d;
      e.t_code = toward0(e.t_code, step);
      e.t_model = toward0(e.t_model, step);
    }
  }
  /** Roll to game day `day`: decay once for each missed day (at most 10), reset the day's model deltas and counters. */
  advanceDay(day, opts) {
    if (day <= this.s.decay_day) return false;
    const steps = Math.min(10, day - this.s.decay_day);
    for (let i = 0; i < steps; i++) this.decay(opts);
    this.s.decay_day = day;
    this.s.day = day;
    for (const e of Object.values(this.s.trust.citizens)) e.model_today = 0;
    for (const e of Object.values(this.s.trust.nations)) e.model_today = 0;
    this.s.counters = { day, sessions: 0, reactions: 0, messages: 0, marches: 0 };
    return true;
  }

  // ------------------------------------------------------------------ goals, counters, standing
  /** `null` = not computed (no producer for the goal's facts): kept as null, shown as "not computed", never as 0 %. */
  setGoalProgress(map) { for (const g of this.s.goals) if (g.id in map) g.progress = map[g.id] === null ? null : clamp(Math.round(map[g.id]), 0, 100); }
  /** Goal ops come only from the reflection answer: {op: progress|drop|resume, id}. */
  goalOp({ op, id }) {
    const g = this.s.goals.find(x => x.id === id);
    if (!g) return false;
    if (op === 'drop') g.status = 'dropped';
    else if (op === 'resume') g.status = 'active';
    else if (op !== 'progress') return false;
    return true;
  }
  bump(counter, n = 1) { this.s.counters[counter] = (this.s.counters[counter] ?? 0) + n; }
  setDayStart(bell, homeTroops, marchTroopsModel = 0) { this.s.day_start = { bell, home_troops: homeTroops, march_troops_model: marchTroopsModel }; }
  setCursor({ event_seq, bell }) { this.s.cursor = { event_seq: String(event_seq), bell }; }
  nextSeq(type, bell) { // seq = (bell << 4) | k, k the record's index among this wallet's records of that type in that bell (§6.1)
    const last = this.s.seq[type] ?? 0;
    const base = bell * 16;
    const next = last >= base ? last + 1 : base;
    if (next >= base + 16) throw new Error('ledger: more than 16 records of one type in a bell');
    this.s.seq[type] = next;
    return next;
  }
  reserve(hostId, untilBell) {
    const r = this.s.standing.reserved.filter(x => x.host_id !== hostId);
    r.push({ host_id: hostId, until_bell: untilBell });
    this.s.standing.reserved = r;
  }
  declineCall(period) { if (!this.s.standing.declined_calls.includes(period)) this.s.standing.declined_calls.push(period); }
  /** The standing orders at `bell` (reserved hosts expire by bell). */
  standing(bell = 0) {
    this.s.standing.reserved = this.s.standing.reserved.filter(r => r.until_bell > bell);
    return { reserved: this.s.standing.reserved.map(r => ({ ...r })), declined_calls: [...this.s.standing.declined_calls] };
  }
  grievances({ open = false } = {}) { return this.s.grievances.filter(g => !open || !g.answered).map(g => ({ ...g })); }
}
