/**
 * Written 2026-11-17 under an execution pause; run since on Node 20 and 22. Its import closure is ports.test.mjs's (src/connect/ports.mjs → caravan.mjs → plan.mjs → keys.mjs,
 * which names a key API it never reaches here): it is cleared by its entry in scripts/ci/node-key-reviewed.txt (ws06-next 2026-11-20), so the key-free job runs it.
 *
 * act3FromMcp.status reads ③'s get_run_status registry rows; a cut list is no answer:
 *   T1 a full list: no act for the requestId → null; one → that receipt; two → Inconsistent (as before)
 *   T2 registry.truncated: not found → RegistryTruncated (never null, which dispatch would take as "not registered");
 *      found once → RegistryTruncated too (a duplicate beyond the cut is not excluded); two visible → Inconsistent
 *   T3 read: false → RegistryUnreadable; an error answer → its failure (as before)
 *   T4 dispatch.mjs's three status readers keep lastError and return on a throw, before prepare or send (source text)
 * Stand-ins only: callTool is a function returning fixed objects. No key is generated, imported, derived or used, and
 * nothing is signed, sent, spawned or fetched.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

for (const k of ["generateKey", "importKey", "exportKey", "deriveKey", "deriveBits", "sign", "verify"]) {
  globalThis.crypto.subtle[k] = () => { throw new Error(`crypto.subtle.${k} called in a no-key test`); };
}

const { act3FromMcp } = await import("../src/connect/ports.mjs");

const act = (key, source = "mcp") => ({ receiptVersion: "p04-acts/0.1", runId: "x", idempotencyKey: key, source, state: "landed" });
const port = (registry) => act3FromMcp({ callTool: async () => ({ runId: "x", registry }) });

test("T1 a full list", async () => {
  assert.equal(await port({ read: true, acts: [act("ws03:L:other")] }).status("x", "ws06.req1"), null);
  assert.equal((await port({ read: true, acts: [act("ws03:L:ws06.req1")] }).status("x", "ws06.req1")).idempotencyKey, "ws03:L:ws06.req1");
  await assert.rejects(port({ read: true, acts: [act("ws03:L:ws06.req1"), act("ws03:M:ws06.req1")] }).status("x", "ws06.req1"), (e) => e.code === "Inconsistent");
});

test("T2 a cut list is no answer", async () => {
  const rows = Array.from({ length: 50 }, (_, i) => act(`ws03:L:ws06.r${i}`));
  await assert.rejects(port({ read: true, acts: rows, truncated: true }).status("x", "ws06.req1"), (e) => e.code === "RegistryTruncated", "not found in a cut list: not null");
  await assert.rejects(port({ read: true, acts: [...rows.slice(1), act("ws03:L:ws06.req1")], truncated: true }).status("x", "ws06.req1"), (e) => e.code === "RegistryTruncated", "found once: still not proven the only one");
  await assert.rejects(port({ read: true, acts: [act("ws03:L:ws06.req1"), act("ws03:M:ws06.req1")], truncated: true }).status("x", "ws06.req1"), (e) => e.code === "Inconsistent", "two visible: Inconsistent, as before");
  assert.equal(await port({ read: true, acts: rows, truncated: false }).status("x", "ws06.none"), null, "truncated: false is a full list");
});

test("T3 an unread registry, an error answer", async () => {
  await assert.rejects(port({ read: false, error: "StoreError" }).status("x", "ws06.req1"), (e) => e.code === "RegistryUnreadable");
  const failing = act3FromMcp({ callTool: async () => ({ ok: false, error: { code: "RateLimited", message: "m" } }) });
  await assert.rejects(failing.status("x", "ws06.req1"));
});

test("T4 dispatch: a status that throws is kept as lastError, before any prepare or send", () => {
  const src = readFileSync(new URL("../src/connect/dispatch.mjs", import.meta.url), "utf8");
  const reads = [...src.matchAll(/try \{ rec = await this\.act\.status\(s\.runId, s\.requestId\); \} catch \(e\) \{ s\.lastError = String\(e\.message \?\? e\); this\.#save\(\); return; \}/g)];
  assert.equal(reads.length, 3, "held, sending and after-send readers");
  const sending = src.indexOf('if (s.state === "sending") {');
  assert.ok(sending > 0 && reads.some((m) => m.index > sending && m.index < src.indexOf("this.act.prepare(", sending)), "the sending reader returns before prepare/send");
});
