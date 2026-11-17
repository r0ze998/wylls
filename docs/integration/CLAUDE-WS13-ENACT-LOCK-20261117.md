# ⑬ operator resident: the enact journal's cross-process lock, fail-closed (2026-11-17)

**Branch:** `claude/ws13-enact-lock-20261117`, one commit **on `7e479028`** (the enact-step unit, unchanged).

**Static change, NOT run:**
- no test, syntax check, import, call, lock taken, signature, POST, send, charge, key or runner;
- **nothing was enacted.**

## The gap

- `enact.mjs` `enactRespond` loads the whole `live-enact.json`, changes one line and saves it whole.
- Within one process, calls on the same journal were held per directory real path (`f60dca78`).
- **Two processes** could each load the journal, and the later save would drop the other's line. That could lose a record already signed or posted, and with it the "never posted again" guarantee.

## The existing conventions, checked

- **The gateway's `agent/lock.mjs` `lockStateFile`:** exclusive create of `<state>.lock` holding a PID.
  - When the PID looks dead (`process.kill(pid, 0)`), it **moves the lock aside and takes it over**.
  - That decides ownership from a PID, which can be reused, and it takes over a lock it did not make. **Both are excluded here, so it is not reused.**
- **Workstream 6's `dispatch.mjs` journal lock:** a takeover after a liveness check too (out of ⑬, not reused).
- **Nothing reads the resident directory's listing** (`readResidentState` reads named files only), so a lock file next to the journal changes no other reader.

## The fix (`enact.mjs`)

**Taken:**
- **every call of `enactRespond`** takes `live-enact.json.lock` in the resident directory's real path, **before the journal is read**, and holds it until it returns (after the in-process guard, which is kept);
- **by exclusive create** (`openSync(…, 'wx', 0o600)`): an existing file, or a symbolic link, is never opened or followed;
- **the content:** `{v: 1, by, token, pid, pidNote}`. The token is 16 random bytes; the PID is **informational only**.

**Not taken (the lock is there already):** `held`, `lock: 'not taken'`.
- **Nothing is read or done:** no journal read, no board read, no signature, no POST.
- **It is never taken over, moved or removed**, whoever made it, alive or not: no PID test, no age, no stale rule.
- **A lock left by a call that stopped** (a crash, a kill) keeps every later call held. Then an **operator who knows no writer is running removes it.** That is the only way through, and it is the operator's call, not this code's.
- A lock that **cannot be made** (for example a read-only directory) is `held` too.

**Released:** only the lock this call made, and only when it is still **the same file** (device and inode) **with this call's token**. Then it is removed, and the result says `lock: 'released'`.
- Otherwise it is **left as it is**, and the result says `lock: 'not released: …'`: replaced, unreadable, or not removable (a read-only directory). Later calls are then held until it is removed.
- **A failure while writing the lock:** the file this call just created (the same device and inode) is removed, and the call is held.

**Unchanged:** stop-A (only earlier results read back while stopped); the stop before any new operation and after the signature; an unknown result never posted again; a failed save is `saved: 'unknown'`; one call per journal in a process; `enactSend` unsupported; the one-step entry and the step never enact.

## What it protects, and what not

- **Protected:** `live-enact.json` against **two calls of this module** (`enactRespond`, and `enactStepRespond` through it), in one process or in several, on the same resident directory.
- **Not protected:**
  - **`state.json`**, and the writers that do not take this lock: a `Resident` process, the owner's mode command (`owner-mode.mjs`), the initial writer (`initial.mjs`), any other process;
  - any other file;
  - a person or tool that removes the lock by hand while a call runs.
- **So this is not a lock on the whole resident.** The no-lock limit stated for `state.json` (owner-mode report) stands.

## Limits (stated, not solved)

1. **A lock left by a crash** needs an operator to remove it. There is no automatic recovery, and that is deliberate: no PID or time rule was adopted.
2. **The release is a check, then a removal.** Between them, only someone removing and replacing the lock by hand could be affected (no code here removes another's lock).
3. **A file system without exclusive create** (some network file systems) is not supported. That is not detected.
4. **No run:** nothing here has been run, in one process or two.

## Regression (written, NOT run): `workstreams/13-citizens/test/live-enact.test.mjs` (extended)

- **Released:** a posted call and a call held at the checks both leave no lock, `lock: 'released'`.
- **A lock already there** is never taken over, whatever it holds: another token with this process's own PID, a PID that looks gone, an empty file, a symbolic link. In each case:
  - held, `lock: 'not taken'`;
  - not signed, not posted, nothing read on the board, no journal;
  - the same lock file, unchanged; the link's target untouched.
- **A lock replaced during the call** is left as it is (`not released`), and the next call is held.
- **The read-only directory case:** the call's lock is not released, so the next call is held until the test, as the operator, removes it; then it only reads back, never posts again.
- **As text:**
  - exclusive create;
  - the lock before the journal is loaded;
  - no `process.kill`, rename, `rmSync` or stale rule;
  - one removal, after the same file and token are checked;
  - the protected scope stated.

## Hand-over (Lane D)

**Unit:** `claude/ws13-enact-lock-20261117`, one commit on `7e479028`. Take its own diff `7e479028..<tip>`, all `100644`:
- `workstreams/13-citizens/resident/live/enact.mjs` (M)
- `workstreams/13-citizens/test/live-enact.test.mjs` (M)
- `docs/integration/CLAUDE-WS13-ENACT-LOCK-20261117.md` (A)

`CLAUDE-WS13-ENACT-RESPOND-20261117.md` (fixed at `f60dca78`) says nothing is excluded across processes; this report supersedes that one point for this module's calls.

**Not run:** anything. Nothing was locked, signed, posted or sent.
