/**
 * Dispatching an adopted caravan plan: run ids fixed from the plan, a
 * journal written before every outside call, and retries that only ever
 * repeat the same call.
 *
 * Two routes, one journal:
 *   run route  06 → ④ accept(RunSpec) / view(run id)       (arrival and amount judged by ④)
 *   act route  06 → ③ send(prepare, requestId, run id)      (④'s act registry knows the send only)
 *
 * The ports (adapters for ④ cf517b55's `runexec run accept|view` and ③
 * 84f710d5's MCP tools are in ports.mjs):
 *
 *   run4 = { accept(spec, requester) -> { result: "Created"|"Existing" }
 *              throws { definitive: true, code } for a refusal (NotAuthorized, Conflict, BadRequest),
 *              anything else for no answer;
 *            view(runId)  -> ④ run view | null (no record)          (throws: could not ask) }
 *   act  = { prepare({ from, to, cargo }) -> { planId }                (③ prepare_caravan; throws: no answer)
 *            send({ planId, requestId, runId }) -> { ok } | throws { code: "PlanAgain" } | throws
 *            status(runId, requestId) -> ④ act receipt (p04-acts/0.1) | null   (throws: could not ask) }
 *   journal = { load() -> object | null, save(object) }   (save is durable before it returns)
 *
 * The requester of a run (who asks, for ④'s intake) is the one the
 * gateway's credential layer authenticated: { actor, generation, citizen,
 * authenticatedBy }. 06 takes it from its caller as it is, keeps it with the
 * run request and hands it to ④ unchanged; 06 never writes authenticatedBy
 * and never authenticates anyone.
 *
 * What never happens here, whatever the outside answers or fails to answer:
 *   - a new run id or requestId for the same plan, request and step;
 *   - a second spec under one run id (an inbound, once bound, stays bound);
 *   - a re-send after an act read `unknown`, or any re-send after `landed`;
 *   - "complete" from a send, from an unverified arrival or from a held run.
 * A new attempt after a proved non-send (`expired`, `not-sent`) is a new 06
 * run request: a new nonce, so new ids. This module never makes one itself.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { contentHash } from "../canonical.mjs";
import { bindInbound, resultOfAct, resultOfRun4, toMcpCaravans, toRunSpecs } from "./caravan.mjs";

export const JOURNAL_FORMAT = "wylls.creation.dispatch/0";

const digest = (spec) => contentHash(spec);
const clone = (v) => JSON.parse(JSON.stringify(v));

export class Dispatch {
  constructor({ journal, run4 = null, act = null }) {
    this.journal = journal;
    this.run4 = run4;
    this.act = act;
    const j = journal.load();
    this.data = j ? clone(j) : { format: JOURNAL_FORMAT, plans: {} };
    if (this.data.format !== JOURNAL_FORMAT) throw new Error(`journal format ${this.data.format}`);
  }

  #save() {
    this.journal.save(clone(this.data));
  }

  /** Key of one run request of one plan: the plan hash and the request's nonce. */
  static key(planHash, nonce) {
    return `${planHash}:${nonce}`;
  }

  /**
   * Fix the run ids (and requestIds) of one run request, in the journal,
   * before anything is sent. The same request again returns what is there;
   * the same key with other content is refused, never replaced.
   */
  plan({ route, plan, planHash, env, nonce, requester, ...rest }) {
    const key = Dispatch.key(planHash, nonce);
    if (route === "run") {
      // nobody authenticated a requester: closed, as workstream 13's port answers (NoAuthenticatedRequester)
      if (requester === undefined || requester === null) return { ok: false, findings: [{ code: "NoAuthenticatedRequester", detail: "a run needs the requester the gateway authenticated; 06 never makes one" }] };
      const bad = requesterProblem(requester);
      if (bad) return { ok: false, findings: [{ code: "REQUESTER", detail: bad }] };
    }
    const made = route === "run"
      ? toRunSpecs({ plan, planHash, env, nonce, ...rest })
      : route === "act" ? toMcpCaravans({ plan, planHash, env, nonce, ...rest }) : { ok: false, findings: [{ code: "SHAPE", detail: "route: run | act" }] };
    if (!made.ok) return made;
    const steps = route === "run"
      ? made.runs.map((r) => ({ step: r.step, runId: r.spec.run_id, awaits: r.awaits, spec: r.spec, specDigest: digest(r.spec), bound: null, state: "planned", pin: r.pin }))
      : made.calls.map((c) => ({ step: c.step, runId: c.runId, requestId: c.requestId, prepare: c.prepare, state: "planned", pin: c.pin }));
    const fresh = { route, key, steps, ...(route === "run" ? { requester: clone(requester) } : {}) };
    const had = this.data.plans[key];
    if (had) {
      const same = contentHash({ route: had.route, requester: had.requester ?? null, steps: had.steps.map(({ step, runId, requestId, specDigest, prepare }) => ({ step, runId, requestId, specDigest, prepare })) })
        === contentHash({ route, requester: fresh.requester ?? null, steps: steps.map(({ step, runId, requestId, specDigest, prepare }) => ({ step, runId, requestId, specDigest, prepare })) });
      return same ? { ok: true, key, already: true, steps: clone(had.steps) } : { ok: false, findings: [{ code: "CONFLICT", key, detail: "this run request was planned with other content" }] };
    }
    this.data.plans[key] = fresh;
    this.#save();
    return { ok: true, key, steps: clone(steps) };
  }

  /**
   * One pass over a planned request: each step does at most one outside
   * call, recorded before it is made. Call it again (after a lost answer,
   * after a restart) to continue: it repeats only the same calls.
   */
  async advance(key) {
    const p = this.data.plans[key];
    if (!p) return { ok: false, code: "NO_RECORD" };
    // one pass per key at a time in this process: a second caller gets the state, not a second call outside
    if (this.#busy.has(key)) return { ...this.status(key), busy: true };
    this.#busy.add(key);
    try {
      for (const s of p.steps) {
        if (p.route === "run") await this.#advanceRun(p, s);
        else await this.#advanceAct(s);
      }
    } finally {
      this.#busy.delete(key);
    }
    return this.status(key);
  }

  #busy = new Set();

  async #advanceRun(p, s) {
    if (s.state === "held" || s.final) return;
    // bind the inbound once, from the earlier run's view, and keep it
    if (s.awaits && !s.bound) {
      const prev = p.steps.find((x) => x.step === s.awaits);
      if (!prev?.view) return;
      const b = bindInbound({ step: s.step, awaits: s.awaits, spec: s.spec }, { step: prev.step, spec: prev.spec }, prev.view);
      if (!b.ok) {
        if (b.code === "INBOUND_STOPPED") { s.state = "held"; s.why = b.why; this.#save(); }
        return;
      }
      s.bound = { spec: b.spec, specDigest: digest(b.spec) };
      this.#save();
    }
    const spec = s.bound ? s.bound.spec : s.spec;
    if (s.awaits && !s.bound) return;
    if (s.state === "accepting") {
      // an earlier accept may have reached ④ and lost its answer: look before asking again
      let v;
      try { v = await this.run4.view(s.runId); } catch (e) { s.lastError = String(e.message ?? e); this.#save(); return; }
      if (v !== null) { s.state = "accepted"; this.#save(); }
    }
    if (s.state === "planned" || s.state === "accepting") {
      s.state = "accepting";
      s.attempts = (s.attempts ?? 0) + 1;
      this.#save(); // before the call: a restart repeats the same accept
      let r;
      try { r = await this.run4.accept(spec, p.requester); } catch (e) {
        s.lastError = `${e.code ?? "Error"}: ${String(e.message ?? e)}`;
        // a refusal is an answer: held for a person (NotAuthorized: the requester is not the pass's holder;
        // Conflict: another spec under this run id; BadRequest), never retried with new ids
        if (e.definitive) { s.state = "held"; s.why = s.lastError; }
        this.#save();
        return;
      }
      if (r?.result !== "Created" && r?.result !== "Existing") { s.lastError = `unexpected accept answer ${JSON.stringify(r)}`; this.#save(); return; }
      s.state = "accepted";
      this.#save();
    }
    if (s.state === "accepted") {
      let v;
      try { v = await this.run4.view(s.runId); } catch (e) { s.lastError = String(e.message ?? e); this.#save(); return; }
      if (v === null) { s.state = "held"; s.why = "④ has no record of an accepted run"; this.#save(); return; }
      const r = resultOfRun4(v);
      if (!r.ok) { s.lastError = r.detail; this.#save(); return; }
      s.view = v;
      s.result = r;
      s.final = r.final;
      this.#save();
    }
  }

  async #advanceAct(s) {
    if (s.final) return;
    if (s.state === "held") {
      // held on a result-unknown send: keep READING ④ (never send); a later final fate ends the hold.
      // Held on a refusal (s.unknown not set): nothing to read.
      if (!s.unknown) return;
      let rec;
      try { rec = await this.act.status(s.runId, s.requestId); } catch (e) { s.lastError = String(e.message ?? e); this.#save(); return; }
      if (rec === null) return;
      const r = resultOfAct(rec);
      if (!r.ok) { s.lastError = r.detail; this.#save(); return; }
      s.result = r;
      if (r.sendFinal) { s.final = true; s.state = "sent-requested"; s.unknown = false; s.why = null; }
      else if (!r.hold) { s.state = "sent-requested"; s.unknown = false; s.why = null; }
      this.#save();
      return;
    }
    if (s.state === "sending") {
      // an earlier send may have reached ③ and lost its answer: if ④ has the act, do not call ③ again
      let rec;
      try { rec = await this.act.status(s.runId, s.requestId); } catch (e) { s.lastError = String(e.message ?? e); this.#save(); return; }
      if (rec !== null) { s.state = "sent-requested"; this.#save(); }
    }
    if (s.state === "planned" || s.state === "sending") {
      if (!s.planId) {
        // ③ plans the road and fixes the fields; a plan is valid for minutes and sends nothing
        let pl;
        try { pl = await this.act.prepare(s.prepare); } catch (e) { s.lastError = String(e.message ?? e); this.#save(); return; }
        if (!pl?.planId) { s.lastError = JSON.stringify(pl); this.#save(); return; }
        s.planId = pl.planId;
        this.#save();
      }
      s.state = "sending";
      s.attempts = (s.attempts ?? 0) + 1;
      this.#save(); // before the call: a restart repeats the same send, same planId and requestId
      try {
        const r = await this.act.send({ planId: s.planId, requestId: s.requestId, runId: s.runId });
        if (!r?.ok) { s.lastError = JSON.stringify(r); this.#save(); return; }
      } catch (e) {
        s.lastError = `${e.code ?? "Error"}: ${String(e.message ?? e)}`;
        // ③ sent nothing under this requestId and the plan is gone (unknown, expired, stale; PlanUsed is held):
        // a new plan, the same requestId and run id (③ answers a requestId it already sent before it looks at the plan)
        if (e.code === "PlanAgain") s.planId = null;
        else if (e.definitive) { s.state = "held"; s.why = s.lastError; }
        this.#save();
        return;
      }
      s.state = "sent-requested";
      this.#save();
    }
    let rec;
    try { rec = await this.act.status(s.runId, s.requestId); } catch (e) { s.lastError = String(e.message ?? e); this.#save(); return; }
    if (rec === null) return; // not registered yet: read again later; never a reason to send again
    const r = resultOfAct(rec);
    if (!r.ok) { s.lastError = r.detail; this.#save(); return; }
    s.result = r;
    if (r.hold) { s.state = "held"; s.why = r.says; s.unknown = true; }
    if (r.sendFinal) s.final = true;
    this.#save();
  }

  /** The request's state. `complete` only when every step's arrival was verified in full by ④. */
  status(key) {
    const p = this.data.plans[key];
    if (!p) return { ok: false, code: "NO_RECORD" };
    const steps = p.steps.map((s) => ({ step: s.step, runId: s.runId, requestId: s.requestId ?? null, state: s.state, final: !!s.final, result: s.result ?? null, why: s.why ?? null, attempts: s.attempts ?? 0 }));
    const complete = p.route === "run" && steps.every((s) => s.final && s.result?.state === "Fulfilled" && s.result.evidence?.usable);
    return { ok: true, key, route: p.route, complete, held: steps.some((s) => s.state === "held"), steps };
  }
}

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Why a requester cannot be handed to ④ as it is (④ clients/runs.mjs requesterFile), or null. */
export function requesterProblem(r) {
  if (!r || typeof r !== "object") return "a run needs the requester the gateway authenticated";
  for (const k of Object.keys(r)) if (!["actor", "generation", "citizen", "authenticatedBy"].includes(k)) return `unknown requester member ${k}`;
  if (typeof r.actor !== "string" || !B58.test(r.actor)) return "requester.actor: the authenticated signer (base58)";
  if (typeof r.citizen !== "string" || !B58.test(r.citizen)) return "requester.citizen: the Citizen acted for (base58)";
  if (!Number.isInteger(r.generation) || r.generation < 0 || r.generation > 0xffffffff) return "requester.generation: the pass generation (u32)";
  if (typeof r.authenticatedBy !== "string" || !r.authenticatedBy.trim()) return "requester.authenticatedBy: named by the layer that authenticated it, not by 06";
  return null;
}

/**
 * A journal in one JSON file, written to a temporary file, fsynced, renamed
 * over the old one, and the directory fsynced (so the rename survives a power
 * loss). One writer at a time, fenced:
 *
 *   - Opening takes `<path>.lock` by exclusive create. The lock names its
 *     holder: pid, the process's start time (/proc/<pid>/stat, so a reused
 *     pid is not mistaken for the holder) and a token of this open. It is
 *     written to a temporary file first and linked in, so no reader ever
 *     sees it empty (an empty file would read as "no holder").
 *   - A lock whose holder still runs is refused (JournalLocked) — the same
 *     process included: a second open in one process is refused, not merged.
 *     A lock left by a previous run (its pid gone, or the same pid with
 *     another start time: a restart) is taken over.
 *   - A takeover holds `<path>.lock.takeover` (taken the same way) while it
 *     re-reads the lock and replaces it (rename) only if it is still the one
 *     judged stale. A takeover mutex left by a dead taker is itself taken
 *     over the same way, under `<path>.lock.takeover.takeover`; no process
 *     ever removes a file that another process holds, so two live openers
 *     can never hold the same mutex, and only one can replace the lock.
 *   - Every save first checks that the lock still carries this open's token;
 *     a writer that lost the lock is refused (JournalFenced) and writes nothing.
 *   - close() removes the lock only if it is still this open's.
 *
 * A holder with this open's pid and start time is this process and is never
 * taken over, even when the process table has no entry for it. `alive(pid)`,
 * when given (tests, probes), answers whether a pid exists in place of the
 * process table; start times still come from `startOf`.
 *
 * Limits: the holder check reads the local process table, so writers on
 * other machines or pid namespaces sharing the file are not told apart.
 */
export function fileJournal(path, fs, { pid = process.pid, alive, startOf = procStart, token = randomToken() } = {}) {
  const lock = `${path}.lock`;
  const mine = { pid, start: startOf(pid), token };
  const body = JSON.stringify(mine);
  const parse = (text) => {
    if (/^\s*\d+\s*$/.test(text ?? "")) return { pid: Number(text) }; // a lock of the earlier format: only a pid
    try { const v = JSON.parse(text); return v && typeof v === "object" ? v : null; } catch { return null; }
  };
  const known = (s) => s !== null && s !== undefined;
  /**
   * Whether the holder a lock names is a running process (the same pid with another start time is not).
   * A holder with this pid and this start time is this process, whatever the process table says.
   * `alive(pid)`, when given, answers whether a pid exists in place of the process table.
   */
  const running = (h) => {
    if (!h || !Number.isSafeInteger(h.pid) || h.pid <= 0) return false;
    if (h.pid === pid && (h.start === mine.start || (!known(h.start) && !known(mine.start)))) return true;
    const now = startOf(h.pid);
    if (alive ? alive(h.pid) !== true : now === null) return false; // no such process
    return !known(h.start) || !known(now) || h.start === now;
  };
  const create = (file, text) => { const fd = fs.openSync(file, "wx"); try { fs.writeSync(fd, `${text}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } };
  const read = (file) => { try { return String(fs.readFileSync(file, "utf8")); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
  /** Puts this open's body at `file` already written: a temporary file, then link (exclusive) or rename (replace). */
  const place = (file, replace) => {
    const tmp = `${file}.${token}.tmp`;
    create(tmp, body);
    try { if (replace) fs.renameSync(tmp, file); else fs.linkSync(tmp, file); } finally { fs.rmSync(tmp, { force: true }); }
  };
  const refuse = (file, h) => Object.assign(new Error(file === lock
    ? `journal ${path} is held by process ${h?.pid ?? "?"}${h?.pid === pid ? " (this process: another open)" : ""}`
    : `journal ${path}: process ${h?.pid ?? "?"} is taking the stale lock over`), { code: "JournalLocked" });
  /**
   * Takes `file` (the lock, or a takeover mutex): an exclusive link when it is absent; when it names a
   * holder that no longer runs, a replace done only while holding `<file>.takeover` (taken the same way)
   * and only if `file` is still the one judged stale. Nobody removes a file another process holds.
   */
  const acquire = (file, depth) => {
    if (depth > 8) throw refuse(file, null);
    for (;;) {
      try { place(file, false); return; } catch (e) { if (e.code !== "EEXIST") throw e; }
      const seen = read(file);
      if (seen === null) continue; // released meanwhile
      const h = parse(seen);
      if (running(h)) throw refuse(file, h);
      const sub = `${file}.takeover`;
      acquire(sub, depth + 1);
      try {
        if (read(file) === seen) { place(file, true); return; }
      } finally {
        fs.rmSync(sub, { force: true });
      }
      // replaced meanwhile: look again
    }
  };
  const open = () => acquire(lock, 0);
  open();
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) || "/" : ".";
  const holds = () => parse(read(lock))?.token === token;
  return {
    load() {
      try { return JSON.parse(fs.readFileSync(path, "utf8")); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
    },
    save(obj) {
      if (!holds()) throw Object.assign(new Error(`journal ${path}: this writer no longer holds the lock; nothing written`), { code: "JournalFenced" });
      const tmp = `${path}.${token}.tmp`;
      const fd = fs.openSync(tmp, "w");
      try { fs.writeSync(fd, `${JSON.stringify(obj)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, path);
      const d = fs.openSync(dir, "r");
      try { fs.fsyncSync(d); } finally { fs.closeSync(d); }
    },
    close() {
      if (holds()) fs.rmSync(lock, { force: true });
    },
  };
}

/** A process's start time from /proc/<pid>/stat (field 22), null if there is no such process, undefined if unknown. */
function procStart(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch (e) {
    if (e.code === "ENOENT") return null;
    try { process.kill(pid, 0); return undefined; } catch (k) { return k.code === "EPERM" ? undefined : null; }
  }
}

function randomToken() {
  return randomUUID();
}
