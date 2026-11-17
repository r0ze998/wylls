// J6 (16, da89ec50) under truthful liveness: two real interleavings of worker threads on the real file system.
// Liveness comes from a fixed table of the "processes" that exist; no injected alive(), so no live
// holder is ever reported dead. Every schedule is one the OS may produce (preemption between system calls).
//
//   node --import <04>/scripts/ci/no-keys-guard.mjs workstreams/06-creation/handoff/ws16-probe/j6-real-interleaving.mjs <dispatch.mjs>
//
// Prints, per schedule, the journal and the lock's holder. "BAD" = the journal holds the state of a
// writer the lock does not name (a stale write over the holder's).
// No key is generated, derived or used.
import * as fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const mod = pathToFileURL(process.argv[2] ?? new URL("../../src/connect/dispatch.mjs", import.meta.url).pathname).href;
const { actor } = await import(new URL("../../test/lock-steps.mjs", import.meta.url).href);
const table = { 111: "s111", 333: "s333" }; // A=111 and C=333 run; 999 and 998 are gone
const fresh = () => join(mkdtempSync(join(tmpdir(), "ws06-j6-")), "journal.json");
const A_PAUSES = [{ name: "A-lock-rename", op: "rename", end: ".lock" }, { name: "A-save-tmp", op: "open", match: "journal.json.", not: ".lock" }];
const report = (name, path, events) => {
  const journal = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : null;
  const holder = JSON.parse(fs.readFileSync(`${path}.lock`, "utf8")).pid;
  const owner = { A: 111, C: 333 }[journal?.who];
  console.log(`${journal && owner !== holder ? "BAD" : "ok "}  ${name}: journal ${JSON.stringify(journal)}, lock held by ${holder}`);
  console.log(`     ${events.join(" | ")}`);
};
const fmt = (who, seen) => `${who}: ${seen.map((m) => (m.event === "pause" ? m.name : m.event === "step" ? `${m.op}=${m.ok ? "ok" : m.code}` : m.event)).join(",")}`;

async function schedule(name, setup, cPauses) {
  const path = fresh();
  setup(path);
  const C = actor({ mod, path, pid: 333, table, pauses: cPauses, steps: [{ op: "open" }, { op: "save", obj: { who: "C", step: "sent" } }] });
  const A = actor({ mod, path, pid: 111, table, pauses: A_PAUSES, steps: [{ op: "open" }, { op: "save", obj: { who: "A", step: "stale" } }] });
  const ev = [];
  ev.push(fmt("C", await C.until("C-1")));            // C stops inside its takeover
  ev.push(fmt("A", await A.until("A-lock-rename")));  // A takes the takeover mutex, about to replace the lock
  C.release(); ev.push(fmt("C", await C.until("C-lock-rename"))); // C goes on: about to replace the lock too?
  A.release(); ev.push(fmt("A", await A.until("A-save-tmp")));    // A holds the lock, passed save()'s fence check
  C.release(); ev.push(fmt("C", await C.finish()));    // C replaces the lock and saves
  A.release(); ev.push(fmt("A", await A.finish()));    // A's rename lands
  report(name, path, ev);
}

// 1. The takeover mutex is visible empty between its exclusive create and its write; an empty mutex reads as "no taker".
await schedule("empty takeover mutex", (p) => fs.writeFileSync(`${p}.lock`, JSON.stringify({ pid: 999, start: "s999", token: "dead" }) + "\n"),
  [{ name: "C-1", op: "write", match: ".lock.takeover" }, { name: "C-lock-rename", op: "rename", end: ".lock" }]);
// 2. A dead taker's mutex: C judges it dead, then removes (or replaces) "it" after A already put its own there.
await schedule("dead taker's mutex", (p) => {
  fs.writeFileSync(`${p}.lock`, JSON.stringify({ pid: 999, start: "s999", token: "dead" }) + "\n");
  fs.writeFileSync(`${p}.lock.takeover`, JSON.stringify({ pid: 998, start: "s998", token: "dead-taker" }) + "\n");
}, [{ name: "C-1", op: "rm", end: ".lock.takeover" }, { name: "C-1", op: "link", end: ".lock.takeover.takeover" }, { name: "C-lock-rename", op: "rename", end: ".lock" }]);
