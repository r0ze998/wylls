# ④ gateway port: HTTP status on `/history` and `/tx`; the gateway_facts run script v3 (2026-11-17)

**Base:** the shared aggregate `claude/aggregate-approved-20261117` at `2ff95beb`. Its `src/gateway.rs` is `23c549d3`'s, which includes the land-on-landed fix.

**Not done:**
- no `cargo`, test, bridge, HTTP or bind;
- the run script has not been run, in any version.

**Provenance:** everything here is **MOCK**: the test bridge and stub, and the agent wallet tests' scripted chain behind them. Not a real chain.

## 1. `result_of` (`/history`) and `land` (`/tx`) discard the HTTP status: reachable? **No, so no code change.**

**What the source does:**
- `result_of` (`gateway.rs:419`): `let (_, v) = http(…"/history"…)`. It uses `v["history"]` whatever the status, and returns `Unavailable` only when there is no array.
- `land` (`gateway.rs:316`): `let (_, t) = http(…"/tx?sig=…")`. It lands when `t["found"] == true`, whatever the status.
- **`fate`** (`:367`), by contrast, treats a non-200 answer as a failed read. So the port's own read-failure rule is not applied evenly.

**What can actually answer** (the port talks only to the bridge's routes, or to the stub that copies them):

| Route | Status | Body | Can a non-200 carry evidence? |
|---|---|---|---|
| bridge `GET /history` (`agent-gateway-bridge.mjs:85-88`) | **always 200** | the gateway's `/f/agent?id=` JSON, passed through. A gateway error gives `{error: …}`, which has no `history` array. | no: an error body has no `history`, so `result_of` already returns `Unavailable` |
| bridge `GET /tx` (`:89`) | **always 200** | `tx(sig)`; a signature the scripted chain does not hold is `found: false` | no |
| bridge, any failure (`:113-117`) | `500` | `{error: <stack>}` | no `history`, no `found` |
| stub in `tests/gateway_facts.rs` | 200 for these routes | its own history or data | — |

**Verdict:**
- No current answer gives a non-200 status together with a `history` array or `found: true`, so **the port never takes a failed read as evidence today.**
- **It is latent:** a future server, or a proxy that answered non-200 with such a body, would be believed. Requiring `200`, as `fate` does, would close it.
- **Not changed:** per the brief (only reachable defects are changed), and because making the rule uniform is a choice of ④'s owner.

**What was also checked:**
- **The bridge masks the gateway's own status on `/history`** (it returns `200` whatever the gateway said). A gateway error still yields no history, so it is not a wrong success.
- **A restart** re-reads `/history`. If it is unreadable, that is `Unavailable` (held), and nothing is re-sent (the same key is the gateway's replay).

## 2. The run script, v3 (prepared, NOT run)

**v3:** scratchpad `scripts/run-ws04-gateway-facts-23c549d3-v3.sh`, **SHA-256 `254a42a66edf504aacb0c4a2958ca47e465759aff012157eaf775722e6127ace`**, 152 lines. It replaces v2 (`85ee423f…`) and v1 (`9358c8a7…`), neither ever run. The diff from v2 is 44 lines added and 16 removed.

**What changed from v2:**

| Point | v3 |
|---|---|
| **Stopping the build as a whole** | `set -m` around the launch, so `cargo` (via `env -i`) gets **a process group of its own**. Its children (`rustc`, build scripts, `clang` and `ar`) inherit that group unless they create their own session, which these tools do not. |
| **Checking the group is cargo's own** | After the launch, the group must equal cargo's pid, and must not equal the script's own group. Otherwise the script stops and nothing else is signalled. |
| **How the group is stopped** | `stop_group`: TERM to the group `-PG`, 5 s, KILL to the group if anything is left, 2 s, then `wait` (reaping cargo). It then confirms with `pgrep -g PG` that **no member is left**; if any is, it is a failure that names them. |
| **Interrupted** | `trap` on INT, TERM and HUP: `stop_group`, then exit 6. |
| **After a normal end** | `pgrep -g PG` must be empty. Anything left is stopped and the run is a failure (exit 7). |
| **Disk** | Measured in **KiB** (`df -k`). An empty, unreadable or non-numeric value **is refused before the start** and **stops the build while running** (fail-closed). Start needs ≥ 23 GiB (floor 21 + 2). The build stops **below 22 GiB** (floor + 1 GiB margin for what is written between two checks). Checked every **2 s**. |
| **Time** | Stop after 1,800 s, through the same group stop. |

**Unchanged from v2:**
- the pinned binaries and the `env -i` environment (rustup bypassed, `--locked --offline`);
- the cargo-configuration checks, both ancestor and in-tree;
- the real-path checks and the hashed archive;
- the whole tracked worktree state before and after (exit 5 on any change).

**Limits stated, not hidden:**
- A process that calls `setsid` would leave the group. `cargo`, `rustc`, `cc` and `ar` do not.
- `pgrep -g` sees only live members. A member that already exited needs no stop.
- The build scripts and proc-macros were not audited line by line.

**Still not one of the refused tests:** only ④'s crate, its two path crates and the toolchain pin, against the test's own loopback stub. Nothing to do with a world, a runner, walls-items, muster, ⑬'s guard tests, group G or H.

**Approval needed:** a `cargo` build with C compilation (`libsqlite3-sys`), offline use of the local crate cache, loopback binds on `127.0.0.1:0`, and the pinned tools.

## Hand-over

- **No code unit this round.** This report is the only file on `claude/ws04-gateway-read-codes-20261117` (on `2ff95beb`).
- **For ④'s owner:** whether `result_of` and `land` should require `200`, as `fate` does (latent; §1).
