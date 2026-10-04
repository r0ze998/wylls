// Seatfix2 review (smoke-r4): what became of every council call (motion, ballot) the mind decided.
//
// The mind answers a council call with a TALK or BALLOT object that only the BRAIN can sign and post, and the brain posts it with its NEXT
// decide answer (watcher/outbox.mjs). While the brain steps every bell that is about a bell later. When the brain has stopped (the end of
// the play phase: the fleet exits and the stack drains) nothing carries the item: in smoke-r4 AI 1001's ballot for period 4 (bell 99, in the
// drain) was decided, counted as a valid decision and never posted. Before this file only in-memory counters knew (`outbox_pushed`,
// `outbox_attached`, `outbox_expired`); a finished run's files could not say how many decided calls were delivered.
//
//   AI_DIR/state/watcher/council-calls.json
//   { v: 1, kind: 'council-call-delivery', calls: [ { key, tag, kind, period, decision_id, decided_bell, status, status_bell, why } ] }
//
// `status`: `pending` (decided, no decide answer of that AI has carried it yet: at the end of a run this means it was NEVER carried),
// `attached` (handed to the brain with a decide answer: not proof that the brain posted it or that the social service accepted it),
// `expired` (the item's own validity window passed before a decide answer could carry it), `dropped` (taken and lost: `why` says no_record or
// no_provenance). Operator-side file: nothing here is a secret, nothing is published.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const CALLS_FILE = 'council-calls.json';

export function createCallLedger({ file, nowMs = () => Date.now(), onError = () => {} } = {}) {
  const calls = new Map(); // key -> row
  if (file && existsSync(file)) {
    try {
      const j = JSON.parse(readFileSync(file, 'utf8'));
      for (const r of Array.isArray(j?.calls) ? j.calls : []) if (r?.key) calls.set(r.key, r);
    } catch { /* start clean: the next change rewrites the file */ }
  }
  const keyOf = (it) => `${it.kind}:${it.tag}:${it.period}`;
  const flush = () => {
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify({ v: 1, kind: 'council-call-delivery', updated_unix: Math.floor(nowMs() / 1000), calls: [...calls.values()] }, null, 1));
      renameSync(tmp, file);
    } catch (e) { onError(e); }
  };
  const set = (it, status, bell, why = null) => {
    const k = keyOf(it);
    const prev = calls.get(k);
    calls.set(k, { key: k, tag: it.tag, kind: it.kind, period: it.period, decision_id: it.decision_id ?? prev?.decision_id ?? null, decided_bell: prev?.decided_bell ?? it.bell ?? null, status, status_bell: bell ?? null, why });
    flush();
  };
  return {
    pushed: (it) => set(it, 'pending', it.bell),
    attached: (it, bell) => set(it, 'attached', bell),
    expired: (it, bell) => set(it, 'expired', bell),
    dropped: (it, bell, why) => set(it, 'dropped', bell, why),
    all: () => [...calls.values()].map((r) => ({ ...r })),
    /** { motion: {decided, pending, attached, expired, dropped}, ballot: {...} } */
    summary() {
      const out = {};
      for (const r of calls.values()) {
        const o = (out[r.kind] ??= { decided: 0, pending: 0, attached: 0, expired: 0, dropped: 0 });
        o.decided++;
        o[r.status] = (o[r.status] ?? 0) + 1;
      }
      return out;
    },
    flush,
  };
}
