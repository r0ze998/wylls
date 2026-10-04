// File locks and claims with an atomic create and a RACE-FREE takeover of a stale holder (AI-CITIZENS contract v1.3, R9;
// section 1.1 "One live stack at a time", section 6.3 "No anchor is sent twice"). Used by bin/run-guards.mjs (the stack lock)
// and registrar.mjs (one claim per anchored bell). Plain `node:fs`, no dependency, no clock, no network.
//
// Why it exists. Wave A's lock was `writeFileSync(file, body, {flag: 'wx'})`; a holder whose pid was gone was replaced by
// `rmSync(file)` followed by a second `wx` create. Two starters that both read the same stale lock could interleave as
//   A: read stale   B: read stale   A: rm   A: create (A holds the lock)   B: rm (removes A's NEW lock)   B: create
// and both believe they hold it (the contract's "exactly one process wins"). Also `wx` writes the content after the file
// exists, so a reader could see an empty file and judge it stale.
//
// The protocol (every step is one atomic filesystem operation):
//   1. create: write the body to a private temp file, then `link(tmp, file)` (fails with EEXIST when the file exists; the
//      file is never visible with partial content). Success = we hold it.
//   2. EEXIST: read the holder. A live holder (isLive) -> refused. Otherwise it is stale.
//   3. takeover of the stale content S: create a CLAIM file named after S's own hash (`<file>.takeover-<hash(S)>`, again
//      by `link`). Only one process can hold the claim for S. The winner re-reads `file`: if it still holds exactly S it
//      removes it (nobody else can replace S meanwhile: replacing S needs claim(S), and creating a lock needs the file to
//      be absent); if it holds anything else (another starter already took over) it removes nothing. The winner then
//      removes its claim and goes back to step 1. A loser of the claim returns "refused" (a takeover is in progress).
//   4. a claim whose own pid is dead (a starter that crashed inside step 3) is removed once; this is the one window that is
//      not atomic and needs a second crash to matter (documented, not hidden).
// The deterministic test interleaves two starters through `hooks.afterJudgedStale` (the second runs inside the first's
// pause) and asserts that exactly one wins, which wave A's code failed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** True while `pid` names a live process (EPERM counts as alive: it exists but is not ours). */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

const rand = () => crypto.randomBytes(6).toString('hex');
const readText = file => { try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const parse = raw => { try { return JSON.parse(raw); } catch { return null; } };

/** Create `file` with `body` atomically and with its content already in place. true = created, false = it exists. */
export function createExclusive(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${rand()}`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Take `file` (see the protocol above). `isLive(parsed|null)` says whether a holder's content is alive (a content that does not
 * parse is passed as null and is the caller's call: both users treat it as dead).
 * Returns `{ok: true, replaced, previous}` (`previous` = the parsed stale content that was replaced, or null) or
 * `{ok: false, holder}` (`holder` = the live holder's parsed content, or null while another starter is taking over a stale one).
 * `hooks.afterJudgedStale(file)` runs after a stale holder was judged and before the claim: tests use it to interleave two starters.
 */
export function acquireFile(file, body, { isLive, hooks = {} } = {}) {
  if (typeof isLive !== 'function') throw new Error('acquireFile: isLive is required');
  let replaced = false;
  let previous = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (createExclusive(file, body)) return { ok: true, replaced, previous };
    const raw = readText(file);
    if (raw === null) continue; // released between our create and our read: try again
    const parsed = parse(raw);
    if (isLive(parsed)) return { ok: false, holder: parsed };
    hooks.afterJudgedStale?.(file);
    const claim = `${file}.takeover-${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16)}`;
    if (!createExclusive(claim, `${JSON.stringify({ pid: process.pid })}\n`)) {
      const c = parse(readText(claim) ?? 'null');
      if (c && pidAlive(c.pid)) return { ok: false, holder: null }; // another starter is taking over this very content
      fs.rmSync(claim, { force: true }); // the taker crashed inside the takeover (rule 4): clear and retry
      continue;
    }
    try {
      if (readText(file) === raw) {
        fs.rmSync(file, { force: true });
        replaced = true;
        previous = parsed;
      }
    } finally {
      fs.rmSync(claim, { force: true });
    }
  }
  return { ok: false, holder: parse(readText(file) ?? 'null') };
}

/** Rewrite the content of a file we hold (atomic rename of a temp file). */
export function rewriteHeld(file, body) {
  const tmp = `${file}.tmp-${process.pid}-${rand()}`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export { readText as readTextOrNull, parse as parseJsonOrNull };
