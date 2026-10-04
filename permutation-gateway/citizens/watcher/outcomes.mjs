// Seat-eligibility fix (2026-10-05, smoke-r3 finding): WHY a nation got no council in a period, persisted.
//
// The council job (council_gen.mjs `tryOpen`) decides, per nation and period, between opening a council and skipping it
// (`skipped:no_members`, `skipped:not_all_final`, `skipped:no_options`, `skipped:open_failed`, `skipped:no_council`). Before this file that
// verdict lived only in the watcher's memory (`attempts`) and in counters of the health route; a finished run's files could not say why
// nation 0 had no council in periods 3 and 4 or why nation 5 never had one. This store writes it down:
//
//   AI_DIR/state/watcher/council-outcomes.json
//   { v: 1, kind: 'council-open-outcomes', periods: { "<k>": { "<f>": { status, reason, c0, bell, first_bell, n, detail, updated_unix } } } }
//
// `status` is `opened` | `skipped` | `waiting`; `reason` is the skip reason (`not_all_final`, `no_options`, `no_members`, `open_failed`,
// `no_council`) or, for `waiting`, why the council had not been decided when the record was last written (`feed_incomplete`,
// `waiting_files`). A `waiting` entry that is never replaced means the period passed with no verdict (the open window of three bells ended
// first): the report shows it as such, it is not a skip the code decided. `detail` carries the facts the verdict rested on (which AI lacked
// a final village, the option counts, whether the seat was in the eligible list). Operator-side file: nothing here is a secret, nothing
// is published.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const OUTCOMES_FILE = 'council-outcomes.json';

export function createOutcomes({ file, nowMs = () => Date.now(), onError = () => {} } = {}) {
  const periods = {};
  if (file && existsSync(file)) {
    try {
      const j = JSON.parse(readFileSync(file, 'utf8'));
      if (j?.periods && typeof j.periods === 'object') Object.assign(periods, j.periods);
    } catch { /* start clean: the next verdict rewrites the file */ }
  }
  const flush = () => {
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify({ v: 1, kind: 'council-open-outcomes', updated_unix: Math.floor(nowMs() / 1000), periods }, null, 1));
      renameSync(tmp, file);
    } catch (e) { onError(e); }
  };
  return {
    /** One verdict of the council job. A repeat of the same (status, reason) only advances `bell` and `n` in memory; the file is written when the verdict changes. */
    record({ faction, period, c0 = null, bell = null, status, reason = null, detail = null }) {
      const row = (periods[period] ??= {});
      const prev = row[faction];
      const same = prev && prev.status === status && prev.reason === reason;
      row[faction] = {
        status, reason, c0, bell, first_bell: same ? prev.first_bell : bell, n: same ? prev.n + 1 : 1,
        detail: detail ?? (same ? prev.detail : null), updated_unix: Math.floor(nowMs() / 1000),
      };
      if (!same || (prev.detail == null) !== (detail == null)) flush();
    },
    get: (faction, period) => periods[period]?.[faction] ?? null,
    all: () => JSON.parse(JSON.stringify(periods)),
    /** Counts by verdict: { opened, skipped: {reason: n}, waiting: {reason: n} } over every recorded (period, nation). */
    summary() {
      const out = { opened: 0, skipped: {}, waiting: {} };
      for (const row of Object.values(periods)) {
        for (const e of Object.values(row)) {
          if (e.status === 'opened') out.opened++;
          else if (e.status === 'skipped' || e.status === 'waiting') { const k = e.reason ?? 'unknown'; out[e.status][k] = (out[e.status][k] ?? 0) + 1; }
        }
      }
      return out;
    },
    flush,
  };
}
