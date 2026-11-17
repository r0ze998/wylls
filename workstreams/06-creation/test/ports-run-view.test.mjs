/**
 * WRITTEN, NOT RUN (2026-11-17, under an execution pause): no part of this file has been executed. Run it only with
 * its own approval. Its import closure is ports.test.mjs's (src/connect/ports.mjs → caravan.mjs → plan.mjs → keys.mjs,
 * which names a key API never reached here): it needs the same kind of review entry before a key-free job may run it.
 *
 * run4FromRunexec.view answers null ("④ has no such run") only for ④'s real NoRecord: `runexec run view` exited by
 * itself with code 3 and its last line says {"error":"NoRecord"} (④ src/main.rs). Everything else is thrown, so
 * Dispatch keeps lastError and never accepts again on it. execFile is a stand-in; no process is started.
 *   V1 a view (exit 0) is returned
 *   V2 NoRecord with exit 3 → null
 *   V3 NoRecord printed but another exit code, a kill, a timeout or a signal → thrown (NoAnswer)
 *   V4 exit 0 with an error answer (NoRecord or another) → thrown, never a view and never null
 *   V5 a missing, cut or non-JSON last line → thrown, whatever the exit
 *   V6 StoreUnavailable (exit 5) → thrown with its code, as before
 *   V7 a spawn failure (no binary) → thrown
 *   V8 Dispatch: both view readers keep lastError and return, before any accept (source text)
 * No key is generated, imported, derived or used; nothing is signed, sent, spawned or fetched.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

for (const k of ["generateKey", "importKey", "exportKey", "deriveKey", "deriveBits", "sign", "verify"]) {
  globalThis.crypto.subtle[k] = () => { throw new Error(`crypto.subtle.${k} called in a no-key test`); };
}

const { run4FromRunexec } = await import("../src/connect/ports.mjs");

const runs = { accept: async () => ({ accept: "Existing" }) };
/** execFile's callback as node:child_process gives it: an Error with code (exit or errno), killed and signal, or null. */
const exec = (err, stdout) => (bin, args, o, cb) => cb(err, stdout);
const exited = (code, extra = {}) => Object.assign(new Error(`Command failed: runexec (exit ${code})`), { code, killed: false, signal: null, ...extra });
const view = (err, stdout) => run4FromRunexec({ runs, bin: "x", db: "y", execFile: exec(err, stdout) }).view("r");
const line = (o) => `${JSON.stringify(o)}\n`;
const NO_RECORD = line({ error: "NoRecord", message: "no run r is accepted in the store at y" });

test("V1 a view", async () => {
  assert.equal((await view(null, line({ view_version: "p04-run/0.1", run_id: "r" }))).run_id, "r");
});

test("V2 a real NoRecord", async () => {
  assert.equal(await view(exited(3), NO_RECORD), null);
});

test("V3 NoRecord printed, but not a plain exit 3", async () => {
  for (const err of [exited(1), exited(5), exited(4), exited(null, { killed: true, signal: "SIGTERM" }), exited(3, { killed: true }), exited(3, { signal: "SIGKILL" })]) {
    await assert.rejects(view(err, NO_RECORD), (e) => e.code === "NoAnswer", JSON.stringify({ code: err.code, killed: err.killed, signal: err.signal }));
  }
});

test("V4 exit 0 with an error answer", async () => {
  await assert.rejects(view(null, NO_RECORD), (e) => e.code === "NoAnswer");
  await assert.rejects(view(null, line({ error: "StoreUnavailable", message: "m" })), (e) => e.code === "StoreUnavailable");
});

test("V5 no usable last line", async () => {
  for (const out of ["", "\n", '{"error":"NoRec', "not json\n", "null\n"]) {
    await assert.rejects(view(exited(3), out), (e) => e.code === "NoAnswer", `exit 3 with ${JSON.stringify(out)}`);
    await assert.rejects(view(null, out), (e) => e.code === "NoAnswer", `exit 0 with ${JSON.stringify(out)}`);
  }
});

test("V6 StoreUnavailable", async () => {
  await assert.rejects(view(exited(5), line({ error: "StoreUnavailable", message: "no store" })), (e) => e.code === "StoreUnavailable");
});

test("V7 a spawn failure", async () => {
  await assert.rejects(view(Object.assign(new Error("spawn x ENOENT"), { code: "ENOENT", errno: -2 }), ""), (e) => e.code === "NoAnswer");
});

test("V8 Dispatch: a view that throws is kept as lastError, before any accept", () => {
  const src = readFileSync(new URL("../src/connect/dispatch.mjs", import.meta.url), "utf8");
  const reads = [...src.matchAll(/try \{ v = await this\.run4\.view\(s\.runId\); \} catch \(e\) \{ s\.lastError = String\(e\.message \?\? e\); this\.#save\(\); return; \}/g)];
  assert.equal(reads.length, 2, "the accepting and the accepted readers");
  const accepting = src.indexOf('if (s.state === "accepting") {');
  const accept = src.indexOf("await this.run4.accept(", accepting);
  assert.ok(reads.some((m) => m.index > accepting && m.index < accept), "the accepting reader returns before accept");
});
