# play2-land ops (fail-closed starter, guard, watchdog)

**This is not permission to start a world.** Starting the play2-land launcher needs the owner's explicit go, each time.
These files have **not been run against a real launcher or world**: only against dummy processes (tests below). The
real arm → exec → launcher path is unverified.

What a run would be: a TEST-ONLY local world on a synthetic clock (×10) — the capture demo with the land preview and the
contest pair, two ordinary memory-only test wallets. Not natural speed, not production. No NFT, transfer, session guard,
prize, real funds or public issuance is involved, and nothing here may be used for them.

## Files
- `play2-start.sh --config <file> [--preflight-only]` — the only entry. Fail-closed order:
  1. config: `KEY=VALUE` lines, parsed (never executed); every key required; absolute paths; full sha256 for all seven
     binaries and a full commit id for the page export; unknown keys, spaces and shell characters stop it;
  2. preflight: a new data directory, the export's `EXPORT-SOURCE.txt` naming that commit, ports 41960–41975 free, no
     other launcher, free disk ≥ 21 GiB, each binary's sha256 equal to its pin;
  3. arming: the guard and the watchdog start against the starter's own pid and must both report armed within 20 s,
     or nothing is launched;
  4. only then `exec` of the launcher (same pid and start time as the starter, so the armed checks keep matching).
- `play2_ops.py guard|watchdog` — the outer supervision:
  - guard: every 15 s, free disk (whether or not a world exists) and the total size of everything under the data
    directory (all worlds) plus the launcher log and both ops logs; free < 21 GiB or total ≥ 110 MiB → SIGINT;
  - watchdog: SIGINT at T0 + 145 min, SIGTERM of what is left (launcher, guard) at T0 + 150 min;
  - each stops the launcher if the other disappears; both ignore SIGHUP;
  - every signal re-checks pid + start time + the exact `--root`/`--data` first; nothing else is ever signalled;
    nothing is deleted. Limits only tighten (a looser floor, cap or later deadline given on the command line is clamped).
- `play2.conf.example` — the template. Copy it outside the repository (real values name local folders) and fill it;
  as committed, its placeholders always stop the starter. `.gitignore` keeps real configs and run output out of git.
- `tests/test_play2_ops.py` — 17 single tests (dummy `python3 -c sleep` targets with launcher-shaped arguments; no
  launcher, no port, no world): arming and clamping, two worlds together over the cap, the floor with no data directory,
  refusal for another data directory and for a reused pid, the re-check right before a signal, deadline SIGINT, the
  deadline clamped to the window, guard gone / watchdog gone, target exit ends both, and the starter's config refusals.
  Run: `python3 -I scripts/play2-land-ops/tests/test_play2_ops.py` (optional `OPS_TEST_TMP=<dir>`).

## Not covered
- The real launch path, the launcher's own children (runner, herald, relays: stopped by the launcher's close path, not
  by these scripts) and any child that outlives its launcher (it would be reported, not killed).
- The launcher keeps its own limits as well (5.25 GiB free, 128 MiB per world); the outer ones above are stricter.
