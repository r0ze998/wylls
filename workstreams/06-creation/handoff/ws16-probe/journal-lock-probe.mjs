// The journal lock, probed the way 16 reported it (no keys; run under 04's guard):
//   node --import <04>/scripts/ci/no-keys-guard.mjs journal-lock-probe.mjs <path to a workstreams/06-creation tree>
// Prints, for that tree's fileJournal: a second open in one process, two takeovers of one stale lock,
// and a save by a writer that lost the lock. "BAD" lines are the defects; the fix prints none.
import * as fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const { fileJournal } = await import(pathToFileURL(join(process.argv[2], "src/connect/dispatch.mjs")).href);
const fresh = () => join(mkdtempSync(join(tmpdir(), "probe06-")), "j.json");
const deadLock = (p) => fs.writeFileSync(`${p}.lock`, `${JSON.stringify({ pid: 2147483646, start: "gone", token: "dead" })}\n`);
const line = (bad, what) => console.log(`${bad ? "BAD " : "ok  "} ${what}`);

// 1. a second open in the same process (real pid), no close in between
{ const p = fresh(); fileJournal(p, fs); let second = "opened"; try { fileJournal(p, fs); } catch (e) { second = e.code; } line(second === "opened", `same-process second open: ${second}`); }

// 2. two openers that read the same stale lock: B takes over while A is between reading and taking over
{ const p = fresh(); deadLock(p); let b = null, interleaved = false, a = null;
  const aFs = { ...fs, readFileSync: (f, o) => { const v = fs.readFileSync(f, o); if (!interleaved && String(f).endsWith(".lock")) { interleaved = true; try { b = fileJournal(p, fs); } catch (e) { b = e.code; } } return v; } };
  try { a = fileJournal(p, aFs); } catch (e) { a = e.code; }
  const holds = (j) => { if (!j || typeof j !== "object") return false; try { j.save({ probe: 1 }); return true; } catch { return false; } };
  const ha = holds(a), hb = holds(b);
  line(ha && hb, `stale-lock takeover race: A ${typeof a === "string" ? a : ha ? "writes" : "cannot write"}, B ${typeof b === "string" ? b : hb ? "writes" : "cannot write"}`); }

// 3. a writer whose lock was replaced still saving
{ const p = fresh(); const a = fileJournal(p, fs); a.save({ v: "A" }); deadLock(p); fs.rmSync(`${p}.lock`); fs.writeFileSync(`${p}.lock`, `${JSON.stringify({ pid: process.pid, start: "other", token: "someone-else" })}\n`);
  let r = "saved"; try { a.save({ v: "old writer" }); } catch (e) { r = e.code; }
  line(r === "saved", `writer that lost the lock: ${r}; journal ${fs.readFileSync(p, "utf8").trim()}`); }
