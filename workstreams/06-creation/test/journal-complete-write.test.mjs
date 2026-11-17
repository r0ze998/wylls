/**
 * WRITTEN, NOT RUN (2026-11-17, under an execution pause): no part of this file has been executed. Run it only with
 * its own approval. Its import closure is dispatch.test.mjs's (src/connect/dispatch.mjs → caravan.mjs → plan.mjs →
 * keys.mjs, which names a key API never reached here): it needs the same kind of review entry before a key-free job
 * may run it.
 *
 * fileJournal puts a lock or a journal in place only with all of its bytes (dispatch.mjs writeAll, 2026-11-17). The
 * file system is a fake in memory (the `fs` argument fileJournal already takes): no real file, lock or journal.
 *   J1 normal: the lock and the journal are whole JSON lines; load gives the object back
 *   J2 a short write is continued to the end; a write that makes no progress is refused (JournalShortWrite)
 *   J3 non-ASCII (UTF-8 bytes longer than the string) is written whole and read back equal
 *   J4 a lock whose write fails is not linked into place; no temporary file is left; a later open works
 *   J5 a save that fails keeps the journal as it was and leaves no temporary file
 *   J6 a rename that fails keeps the journal as it was and leaves no temporary file
 *   J7 a lock held by a live other process is left as it is (JournalLocked)
 *   J8 Dispatch saves before it sends, outside the send's try: a save that throws sends nothing (source text)
 *   J9 a temporary file already there (not this attempt's) is left as it is: the open ends (JournalTmpExists), no loop
 *   J10 the same for a save: the journal and that temporary file both stay
 *   J11 a sync or close that fails after the create removes this attempt's own temporary file; nothing put in place
 *   J12 an existing lock whose holder is gone is still taken over (the stale takeover is unchanged)
 * No key is generated, imported, derived or used; nothing is signed, sent, spawned or fetched.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

for (const k of ["generateKey", "importKey", "exportKey", "deriveKey", "deriveBits", "sign", "verify"]) {
  globalThis.crypto.subtle[k] = () => { throw new Error(`crypto.subtle.${k} called in a no-key test`); };
}

const { fileJournal } = await import("../src/connect/dispatch.mjs");

/** An in-memory fs with the calls fileJournal makes. `plan.write(file, len) → n` decides each writeSync's count. */
function memFs(plan = {}) {
  const files = new Map();
  const fds = new Map();
  let next = 3;
  const err = (code, file) => Object.assign(new Error(`${code}: ${file}`), { code });
  const fs = {
    files,
    openSync(file, flags) {
      if (flags === "wx" && files.has(file)) throw err("EEXIST", file);
      if (flags === "w" || flags === "wx") files.set(file, Buffer.alloc(0));
      const fd = next++;
      fds.set(fd, file);
      return fd;
    },
    writeSync(fd, buf, off, len) {
      const file = fds.get(fd);
      const n = plan.write ? plan.write(file, len) : len;
      if (n > 0) files.set(file, Buffer.concat([files.get(file), buf.subarray(off, off + n)]));
      return n;
    },
    fsyncSync(fd) { if (plan.fsync?.(fds.get(fd))) throw err("EIO", fds.get(fd)); },
    closeSync(fd) { const file = fds.get(fd); fds.delete(fd); if (plan.close?.(file)) throw err("EIO", file); },
    linkSync(a, b) { if (files.has(b)) throw err("EEXIST", b); files.set(b, files.get(a)); },
    renameSync(a, b) { if (plan.rename?.(a, b)) throw err("EIO", b); files.set(b, files.get(a)); files.delete(a); },
    rmSync(file) { files.delete(file); },
    readFileSync(file) { if (!files.has(file)) throw err("ENOENT", file); return files.get(file).toString("utf8"); },
  };
  return fs;
}
const P = "/j/journal.json";
const opts = { pid: 100, startOf: () => "s100", token: "tok" };
const tmps = (fs) => [...fs.files.keys()].filter((f) => f.endsWith(".tmp"));

test("J1 normal", () => {
  const fs = memFs();
  const j = fileJournal(P, fs, opts);
  assert.deepEqual(JSON.parse(fs.files.get(`${P}.lock`).toString()), { pid: 100, start: "s100", token: "tok" });
  assert.ok(fs.files.get(`${P}.lock`).toString().endsWith("\n"));
  j.save({ v: 1 });
  assert.deepEqual(j.load(), { v: 1 });
  assert.deepEqual(tmps(fs), []);
});

test("J2 a short write is continued; no progress is refused", () => {
  let first = true;
  const fs = memFs({ write: (file, len) => (file.endsWith(".tmp") && first && len > 3 ? ((first = false), 3) : len) });
  const j = fileJournal(P, fs, opts);
  j.save({ v: "continued" });
  assert.deepEqual(j.load(), { v: "continued" });
  const stuck = memFs();
  const k = fileJournal(P, stuck, opts);
  k.save({ v: "before" });
  const write = stuck.writeSync;
  stuck.writeSync = () => 0;
  assert.throws(() => k.save({ v: "after" }), (e) => e.code === "JournalShortWrite");
  stuck.writeSync = write;
  assert.deepEqual(k.load(), { v: "before" });
});

test("J3 non-ASCII", () => {
  const fs = memFs({ write: (file, len) => Math.min(len, 5) }); // every write cuts at 5 bytes: many short writes
  const j = fileJournal(P, fs, opts);
  const obj = { note: "木材 196 以上", nested: ["ñ", "é"] };
  j.save(obj);
  assert.deepEqual(j.load(), obj);
});

test("J4 a lock whose write fails is not put in place", () => {
  const plan = { write: () => 0 };
  const fs = memFs(plan);
  assert.throws(() => fileJournal(P, fs, opts), (e) => e.code === "JournalShortWrite");
  assert.equal(fs.files.has(`${P}.lock`), false, "no lock");
  assert.deepEqual(tmps(fs), [], "no temporary file");
  delete plan.write; // the same files, writes working again, the same token: nothing left blocks the next open
  assert.doesNotThrow(() => fileJournal(P, fs, opts));
  assert.equal(JSON.parse(fs.files.get(`${P}.lock`).toString()).token, "tok");
});

test("J5 a failed save keeps the journal", () => {
  const fs = memFs();
  const j = fileJournal(P, fs, opts);
  j.save({ v: "A" });
  const before = fs.files.get(P);
  const write = fs.writeSync;
  fs.writeSync = () => 0;
  assert.throws(() => j.save({ v: "B" }), (e) => e.code === "JournalShortWrite");
  fs.writeSync = write;
  assert.ok(fs.files.get(P).equals(before));
  assert.deepEqual(tmps(fs), []);
});

test("J6 a failed rename keeps the journal", () => {
  let fail = false;
  const fs = memFs({ rename: (a, b) => fail && b === P });
  const j = fileJournal(P, fs, opts);
  j.save({ v: "A" });
  fail = true;
  assert.throws(() => j.save({ v: "B" }), (e) => e.code === "EIO");
  assert.deepEqual(j.load(), { v: "A" });
  assert.deepEqual(tmps(fs), []);
});

test("J7 a live holder's lock stays", () => {
  const fs = memFs();
  const held = `${JSON.stringify({ pid: 999, start: "s999", token: "other" })}\n`;
  fs.files.set(`${P}.lock`, Buffer.from(held));
  assert.throws(() => fileJournal(P, fs, { ...opts, alive: (pid) => pid === 999, startOf: (pid) => `s${pid}` }), (e) => e.code === "JournalLocked");
  assert.equal(fs.files.get(`${P}.lock`).toString(), held);
});

test("J8 Dispatch saves before it sends, outside the send's try", () => {
  const src = readFileSync(new URL("../src/connect/dispatch.mjs", import.meta.url), "utf8");
  const save = src.indexOf("this.#save(); // before the call: a restart repeats the same send, same planId and requestId");
  const tryAt = src.indexOf("try {", save);
  const send = src.indexOf("await this.act.send(", save);
  assert.ok(save > 0 && save < tryAt && tryAt < send, "save, then the try that sends");
  assert.match(src, /#save\(\) \{\n\s+this\.journal\.save\(clone\(this\.data\)\);\n\s+\}/, "#save does not catch");
});

test("J9 a temporary file that is not this attempt's stays; the open ends", () => {
  const fs = memFs();
  fs.files.set(`${P}.lock.tok.tmp`, Buffer.from("someone's\n"));
  assert.throws(() => fileJournal(P, fs, opts), (e) => e.code === "JournalTmpExists");
  assert.equal(fs.files.get(`${P}.lock.tok.tmp`).toString(), "someone's\n");
  assert.equal(fs.files.has(`${P}.lock`), false);
});

test("J10 a save does not touch a temporary file that is not its own", () => {
  const fs = memFs();
  const j = fileJournal(P, fs, opts);
  j.save({ v: "A" });
  fs.files.set(`${P}.tok.tmp`, Buffer.from("other\n"));
  assert.throws(() => j.save({ v: "B" }), (e) => e.code === "JournalTmpExists");
  assert.deepEqual(j.load(), { v: "A" });
  assert.equal(fs.files.get(`${P}.tok.tmp`).toString(), "other\n");
});

test("J11 a failed sync or close after the create removes this attempt's file", () => {
  for (const step of ["fsync", "close"]) {
    let failLock = true;
    const fs = memFs({ [step]: (file) => file.endsWith(".lock.tok.tmp") && failLock });
    assert.throws(() => fileJournal(P, fs, opts), (e) => e.code === "EIO", step);
    assert.deepEqual([fs.files.has(`${P}.lock`), tmps(fs)], [false, []], step);
    failLock = false;
    const j = fileJournal(P, fs, opts);
    j.save({ v: "A" });
    const bad = memFs();
    const k = fileJournal(P, bad, opts);
    k.save({ v: "A" });
    bad[step === "fsync" ? "fsyncSync" : "closeSync"] = step === "fsync"
      ? (fd) => { throw Object.assign(new Error("EIO"), { code: "EIO" }); }
      : ((close) => (fd) => { close(fd); throw Object.assign(new Error("EIO"), { code: "EIO" }); })(bad.closeSync);
    assert.throws(() => k.save({ v: "B" }), (e) => e.code === "EIO", step);
    assert.deepEqual(JSON.parse(bad.files.get(P).toString()), { v: "A" }, step);
    assert.deepEqual(tmps(bad), [], step);
  }
});

test("J12 a gone holder's lock is still taken over", () => {
  const fs = memFs();
  fs.files.set(`${P}.lock`, Buffer.from(`${JSON.stringify({ pid: 999, start: "s999", token: "old" })}\n`));
  const j = fileJournal(P, fs, { ...opts, alive: () => false });
  assert.equal(JSON.parse(fs.files.get(`${P}.lock`).toString()).token, "tok");
  assert.deepEqual(tmps(fs), []);
  j.save({ v: 1 });
  assert.deepEqual(j.load(), { v: 1 });
});
