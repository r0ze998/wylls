// A read-only client of workstream 4's `runexec observe store|db` (2026-11-17), shaped like `runViewClient`
// (ports/ws04-run.mjs): `execFile` is handed in (no shell), the last stdout line is JSON, an error is runexec's own
// code. It is NOT a resident port: only the composition root (bin/observe-canonical.mjs) uses it, to hand 4's held
// observation page to workstream 12's held report. Workstream 13 still imports nothing of workstream 12: the JSON
// parser is handed in too (the command passes 12's `parseJsonU64`, which keeps the u64 `owner` / `raider` exact).
//
// What the page is (runexec observation.rs, `ws04-observation/0`): basis `unproven`, every hold kept, nothing admitted;
// in store mode, each row's `archive_epoch` (the archive manifest's producer setting, or why none) and the page's
// `store` pairing facts (one directory named by the caller: not proof of one archive, not one snapshot). This client
// passes the page on as runexec printed it and decides nothing.
//
// Errors: `{code}` is runexec's own (`BadRequest`, `ObservationNotRead`), or `Spawn` (no JSON, a timeout, a crash), or
// `BadRequest` from the checks below before anything is started. A failure says nothing about any caravan or run:
// never "no record", never "not sent".

const MAX_ROWS = 256;   // runexec observation.rs MAX_ROWS
const I64_MAX = 9_223_372_036_854_775_807n;

/** A plain decimal (a safe integer or a string of digits), as runexec's `--after` / `--limit` accept it, or null. */
function decimal(v) {
  if (Number.isSafeInteger(v) && v >= 0) return String(v);
  if (typeof v === 'string' && /^\d{1,20}$/.test(v)) return v;
  return null;
}

/**
 * `{store(dir, {after, limit}), db(path, {after, limit})}` → the page, or throws `{code}`.
 * `bin`: the runexec binary; `execFile`: node:child_process execFile; `parse`: the JSON parser for the page.
 */
export function ws04ObserveClient({ bin, execFile, parse, timeoutMs = 15_000 }) {
  if (!bin || typeof execFile !== 'function' || typeof parse !== 'function') throw new TypeError('bin, execFile (node:child_process) and parse are required');
  const bad = m => Object.assign(new Error(m), { code: 'BadRequest' });
  const options = ({ after, limit } = {}) => {
    const out = [];
    if (after !== undefined) {
      const d = decimal(after);
      if (d === null || BigInt(d) > I64_MAX) throw bad('after: a plain decimal up to i64::MAX');
      out.push('--after', d);
    }
    if (limit !== undefined) {
      const d = decimal(limit);
      if (d === null || BigInt(d) < 1n || BigInt(d) > BigInt(MAX_ROWS)) throw bad(`limit: 1..=${MAX_ROWS}`);
      out.push('--limit', d);
    }
    return out;
  };
  const path = p => {
    if (typeof p !== 'string' || !p || p.startsWith('--')) throw bad('a non-empty path that is not an option');
    return p;
  };
  const run = args => new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 1 << 24, shell: false }, (err, stdout) => {
      const line = String(stdout ?? '').trim().split('\n').at(-1) ?? '';
      let v = null;
      try { v = line ? parse(line) : null; } catch { v = null; }
      if (!err && v && typeof v === 'object' && !v.error) return resolve(v);
      if (v && typeof v.error === 'string') return reject(Object.assign(new Error(String(v.message ?? v.error)), { code: v.error }));
      reject(Object.assign(new Error(String(err?.message ?? 'runexec printed no JSON')), { code: 'Spawn' }));
    });
  });
  return Object.freeze({
    // async: a refused argument is a rejection like every other error, and nothing is started for it
    store: async (dir, o) => run(['observe', 'store', '--store', path(dir), ...options(o)]),
    db: async (file, o) => run(['observe', 'db', '--db', path(file), ...options(o)]),
  });
}
