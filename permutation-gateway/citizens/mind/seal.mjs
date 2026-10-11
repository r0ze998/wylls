// The season-end seal (integ-B, "season-end race fix"). The registrar's `publish` closes the season: it writes the signed anchors index
// and STATE/season-end.json. A bell that the closer closes after that point is in no index and, on the paused chain the stack leaves
// behind, can never be anchored: verify-minds M3 then reads an `anchor_gap` for a bell the index does not cover (smoke-r2, bell 109: the
// closer wrote the bell-109 files in the same second the registrar wrote the index).
//
// The rule: THE SEAL ENDS THE CLOSER. `publish` first writes STATE/season-sealing.json; the closer closes no bell once it exists. The two
// processes cannot see each other's memory, so the order is made safe the usual way, one atomic file operation each, flag first and check
// second on BOTH sides:
//   closer   : 1. write STATE/closer-claim.json   2. is the seal there? yes: remove the claim, close nothing   3. close the bell   4. remove the claim
//   registrar: 1. write the seal                  2. wait until the claim is gone (or its holder is dead)      3. scan the closed bells, anchor, index
// If the closer's claim came first, the registrar waits for the bell's files and scans them (the bell is closed and gets an anchor or a
// named gap); if the seal came first, the closer sees it and writes nothing. No interleaving leaves a bell written after the scan.
// No key and no network; plain node:fs under the service's STATE write grant (mind/permissions.mjs).
import fs from 'node:fs';
import path from 'node:path';

export const SEAL_FILE = 'season-sealing.json';
export const CLAIM_FILE = 'closer-claim.json';
export const sealPath = (stateDir) => path.join(stateDir, SEAL_FILE);
export const claimPath = (stateDir) => path.join(stateDir, CLAIM_FILE);
export const isSealed = (stateDir) => fs.existsSync(sealPath(stateDir));

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
const readJsonOrNull = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const aliveDefault = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** Registrar side, step 1: seal the season (idempotent: the first seal stays). Returns the seal record. */
export function sealSeason(stateDir, { by = 'registrar publish', now = Date.now, pid = process.pid } = {}) {
  const file = sealPath(stateDir);
  const have = readJsonOrNull(file);
  if (have) return have;
  const rec = { v: 1, sealed_ms: now(), by, pid };
  writeAtomic(file, `${JSON.stringify(rec)}\n`);
  return rec;
}

/**
 * Closer side: `enter(bell)` writes the claim, then looks for the seal. It returns `null` (the season is sealed: close nothing) or a
 * `leave()` that removes the claim once the bell's files are written.
 */
export function closerGuard(stateDir, { pid = process.pid, now = Date.now } = {}) {
  return {
    enter(bell) {
      const file = claimPath(stateDir);
      writeAtomic(file, `${JSON.stringify({ v: 1, pid, bell, since_ms: now() })}\n`);
      if (isSealed(stateDir)) {
        try { fs.rmSync(file, { force: true }); } catch { /* a stale claim is judged by its pid */ }
        return null;
      }
      return () => { try { fs.rmSync(file, { force: true }); } catch { /* see above */ } };
    },
    sealed: () => isSealed(stateDir),
  };
}

/**
 * Registrar side, step 2: wait (bounded) until no closer is inside a close. A claim whose pid is dead or that is older than `staleMs` is
 * not waited for. Returns `{waited_ms, held}`; `held` is true when the bound ran out with a live claim (the caller logs it and goes on:
 * the closed-bell wait of `publish` covers a half-written bell).
 */
export async function waitForCloserIdle(stateDir, { timeoutMs = 10_000, intervalMs = 25, staleMs = 60_000, isAlive = aliveDefault, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const t0 = now();
  for (;;) {
    const c = readJsonOrNull(claimPath(stateDir));
    if (!c && !fs.existsSync(claimPath(stateDir))) return { waited_ms: now() - t0, held: false };
    if (c && (!isAlive(c.pid) || now() - Number(c.since_ms) > staleMs)) return { waited_ms: now() - t0, held: false };
    if (now() - t0 >= timeoutMs) return { waited_ms: now() - t0, held: true };
    await sleep(intervalMs);
  }
}
