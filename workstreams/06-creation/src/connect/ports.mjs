/**
 * Adapters from dispatch.mjs's ports to the delivered interfaces.
 *
 *   run4FromRunexec  ④ cf517b55: `runexec run accept` through ④'s own
 *                    clients/runs.mjs (`createRunsClient`, passed in; 06 does
 *                    not copy it), and `runexec run view` (read only).
 *   act3FromMcp      ③ c95287d5 (from 84f710d5 on): the MCP tools prepare_caravan,
 *                    send_caravan {planId, requestId, runId} and
 *                    get_run_status {runId}, through a `callTool(name, args)`
 *                    the MCP client provides.
 *
 * Nothing here signs, holds a key or authenticates: the requester comes
 * from the caller (the gateway's credential layer) and goes to ④ as it is;
 * ③'s calls carry the connection's own OAuth credential, which the MCP
 * client holds, not 06.
 */

import { execFile as nodeExecFile } from "node:child_process";
import { CORE_RESOURCES } from "./caravan.mjs";

/** ③'s cargo: whole units by S1 resource name (tools.mjs cargoSchema: Food … Influence, Arms in slot 4). */
export function cargoForMcp(cargo) {
  const out = {};
  CORE_RESOURCES.forEach((r, i) => { if (cargo[i]) out[r[0].toUpperCase() + r.slice(1)] = cargo[i]; });
  return out;
}

/**
 * ③'s plan answers that call for a new plan under the same requestId: they come only when ③ holds no
 * operation for the requestId (server.mjs; confirmed by ③ at c95287d5). NOT PlanUsed: another requestId
 * already sent that plan, so a new plan could send a second caravan — held instead.
 */
const PLAN_AGAIN = ["PlanUnknown", "PlanExpired", "PlanStale"];

/** ④'s refusals that are answers (exit codes 2, 4, 5 of run accept): held, never retried with new ids. */
const DEFINITIVE4 = ["BadRequest", "Conflict", "NotAuthorized"];

export function run4FromRunexec({ runs, bin, db, execFile = nodeExecFile, timeoutMs = 15_000 }) {
  if (!runs || !bin || !db) throw new Error("runs (④'s createRunsClient), bin and db are required");
  return {
    async accept(spec, requester) {
      let v;
      try {
        v = await runs.accept(spec, requester);
      } catch (e) {
        if (DEFINITIVE4.includes(e.code)) e.definitive = true;
        throw e;
      }
      if (v?.accept !== "Created" && v?.accept !== "Existing") throw Object.assign(new Error(`run accept answered ${JSON.stringify(v?.accept)}`), { code: "Unexpected" });
      return { result: v.accept, view: v };
    },
    view(runId) {
      return new Promise((resolve, reject) => {
        execFile(bin, ["run", "view", "--db", db, "--run", runId], { timeout: timeoutMs, maxBuffer: 4 << 20, shell: false }, (err, stdout) => {
          const line = String(stdout ?? "").trim().split("\n").at(-1) ?? "";
          let v = null;
          try { v = line ? JSON.parse(line) : null; } catch { v = null; }
          if (!err && v) return resolve(v);
          // NoRecord (exit 3) is said only by a store that was opened and read; StoreUnavailable is no answer
          if (v?.error === "NoRecord") return resolve(null);
          reject(Object.assign(new Error(v?.message ?? String(err?.message ?? "no JSON")), { code: v?.error ?? "Spawn" }));
        });
      });
    },
  };
}

/** ③'s answers that end a send for a person: the same requestId under another plan or run, a refused action. */
const DEFINITIVE3 = ["IdempotencyConflict", "PlanUsed", "RequestIdUsedOnAnotherConnection", "BadRequest", "ActionNotAllowed", "NotYourPlace", "WalletRequired", "AgentStopped", "SessionNotDelegated"];

export function act3FromMcp({ callTool }) {
  if (typeof callTool !== "function") throw new Error("callTool(name, args) is required");
  const fail = (r) => {
    const code = r?.error?.code ?? "Unexpected";
    const e = Object.assign(new Error(r?.error?.message ?? code), { code: PLAN_AGAIN.includes(code) ? "PlanAgain" : code, was: code });
    if (r?.error?.retryable !== true && DEFINITIVE3.includes(code)) e.definitive = true;
    return e;
  };
  return {
    async prepare({ from, to, cargo }) {
      const r = await callTool("prepare_caravan", { from, to, cargo: cargoForMcp(cargo) });
      if (r?.error || !r?.planId) throw fail(r);
      return { planId: r.planId };
    },
    async send({ planId, requestId, runId }) {
      const r = await callTool("send_caravan", { planId, requestId, runId });
      if (r?.error) throw fail(r);
      return { ok: true, operation: r };
    },
    /** ④'s act receipt of this requestId, from the registry rows ③ returns for the run; null if not registered. */
    async status(runId, requestId) {
      const r = await callTool("get_run_status", { runId });
      if (r?.error) throw fail(r);
      if (!r?.registry?.read) throw Object.assign(new Error("③ could not read ④'s registry"), { code: "RegistryUnreadable" });
      const mine = (r.registry.acts ?? []).filter((a) => a.source === "mcp" && typeof a.idempotencyKey === "string" && a.idempotencyKey.endsWith(`:${requestId}`));
      if (mine.length > 1) throw Object.assign(new Error(`${mine.length} acts for one requestId`), { code: "Inconsistent" });
      return mine[0] ?? null;
    },
  };
}
