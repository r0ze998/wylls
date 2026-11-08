/**
 * Real interleavings for the journal lock tests: each "process" is a worker
 * thread that runs fileJournal on the real file system and stops at named
 * points (before a chosen fs call — open, write, rename, link, read, rm — on a
 * file whose path includes `match` and/or ends with `end`) until the test lets
 * it go; each named point stops once, and a worker does nothing before its
 * "start" point is released.
 * Every schedule a test drives is one the OS may produce for real processes,
 * since any process may be preempted between two system calls. Liveness is
 * truthful: `startOf` answers from a fixed table of the "processes" that
 * exist (no injected `alive`), so a running holder is never reported dead.
 *
 * Nothing here generates, derives or uses a key.
 */
import { Worker } from "node:worker_threads";

const WORKER = `
import { workerData, parentPort } from "node:worker_threads";
import * as realfs from "node:fs";
const { mod, path, pid, table, pauses, steps } = workerData;
const gate = new Int32Array(workerData.sab);
const { fileJournal } = await import(mod);
const fds = new Map();
const left = pauses.map((p) => ({ ...p }));
const stop = (op, file) => {
  const f = String(file);
  const i = left.findIndex((p) => p.op === op && (p.match === undefined || f.includes(p.match)) && (p.end === undefined || f.endsWith(p.end)) && !(p.not && f.includes(p.not)));
  if (i < 0) return;
  const [p] = left.splice(i, 1);
  parentPort.postMessage({ event: "pause", name: p.name });
  Atomics.wait(gate, 0, 0);
  Atomics.store(gate, 0, 0);
};
const fs = new Proxy(realfs, { get(t, k) {
  const f = t[k];
  if (k === "openSync") return (p, ...r) => { stop("open", p); const fd = f(p, ...r); fds.set(fd, String(p)); return fd; };
  if (k === "writeSync") return (fd, ...r) => { stop("write", fds.get(fd) ?? ""); return f(fd, ...r); };
  if (k === "renameSync") return (a, b) => { stop("rename", b); return f(a, b); };
  if (k === "linkSync") return (a, b) => { stop("link", b); return f(a, b); };
  if (k === "readFileSync") return (p, ...r) => { stop("read", p); return f(p, ...r); };
  if (k === "rmSync") return (p, ...r) => { stop("rm", p); return f(p, ...r); };
  return f;
} });
const startOf = (p) => (Object.hasOwn(table, p) ? table[p] : null);
let j = null;
parentPort.postMessage({ event: "pause", name: "start" }); // nothing runs until the test lets it
Atomics.wait(gate, 0, 0);
Atomics.store(gate, 0, 0);
for (const [i, s] of steps.entries()) {
  try {
    if (s.op === "open") j = fileJournal(path, fs, { pid, startOf });
    else if (s.op === "save") j.save(s.obj);
    else if (s.op === "close") j.close();
    parentPort.postMessage({ event: "step", i, op: s.op, ok: true });
  } catch (e) {
    parentPort.postMessage({ event: "step", i, op: s.op, ok: false, code: e.code ?? e.message, message: e.message });
    break;
  }
}
parentPort.postMessage({ event: "end" });
`;

/** One stepped "process". `next()` resolves with its next event: {event:"pause",name} | {event:"step",...} | {event:"end"}. */
export function actor({ mod, path, pid, table, pauses = [], steps }) {
  const sab = new SharedArrayBuffer(4);
  const gate = new Int32Array(sab);
  const w = new Worker(WORKER, { eval: true, type: "module", workerData: { mod, path, pid, table, pauses, steps, sab } });
  const queue = [];
  const waiting = [];
  let ended = false;
  const push = (m) => { if (m.event === "end" || m.event === "error") ended = true; return waiting.length ? waiting.shift()(m) : queue.push(m); };
  w.on("message", push);
  w.on("error", (e) => push({ event: "error", message: String(e) }));
  return {
    next: () => (queue.length ? Promise.resolve(queue.shift()) : ended ? Promise.resolve({ event: "end" }) : new Promise((ok) => waiting.push(ok))),
    release() { Atomics.store(gate, 0, 1); Atomics.notify(gate, 0); },
    /** Run until the named pause, or until the worker ends; returns the events seen. */
    async until(name) {
      const seen = [];
      for (;;) {
        const m = await this.next();
        seen.push(m);
        if ((m.event === "pause" && m.name === name) || m.event === "end" || m.event === "error") return seen;
        if (m.event === "pause") this.release(); // a pause not waited for here
      }
    },
    async finish() {
      const seen = [];
      for (;;) {
        const m = await this.next();
        seen.push(m);
        if (m.event === "pause") { this.release(); continue; }
        if (m.event === "end" || m.event === "error") { await w.terminate(); return seen; }
      }
    },
  };
}

export const paused = (seen, name) => seen.at(-1)?.event === "pause" && seen.at(-1).name === name;
export const steps = (seen) => seen.filter((m) => m.event === "step");
