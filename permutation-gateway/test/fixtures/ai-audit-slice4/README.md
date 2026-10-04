# ai-audit-slice4: a recorded mini-run for the AC8 audit tests

Source: the **slice-4 run** of the wave-A slice gate (`.local/frontier/ai/slice-4/`, git-ignored; local test chain only, 6 AI citizens,
deck-1, 12 game hours at 10x, code commit `4b7a9b9`). It was captured on 2026-10-04 by `../ai-audit-capture.mjs` with **read-only** reads:
the run's herald and localnet were started again from a **copy** of the run's data directories (original untouched) on ports 41994, 41995 and
41996, and stopped afterwards. Nothing here is devnet or mainnet.

| Part | Real or derived |
|---|---|
| `pub/` | **real**, verbatim (`metrics/` left out): commitments, roster, 85 anchors, 85 minds files, 85 talk files (empty: the social service was a stub), 6 episode lists |
| `state/records.jsonl` | **real**, the journal lines of the 14 model decisions (7 of them sealed marches) and their tx updates; the other 373 records are autopilot records and are left out |
| `state/requests/*.json`, `state/ledger/*.json`, `state/season-end.json` | **real**, verbatim (the 14 stored llama request bodies; 6 ledgers) |
| `stack.toml`, `ai-slots.json` | **real**, verbatim copies from the run directory |
| `herald.json` `events` | **real** rows, verbatim (204 of 5,791: the kinds the audit reads); the **paging** (`next`, `full`) is synthetic (`../ai-audit-doubles.mjs`) |
| `herald.json` `gets` | **real** answers of the herald, verbatim (`/h/season`, `/h/me/<wallet>` of the 6 AIs, the province and clash files the replay asks for) |
| `rpc.json` | **real** results of the chain; `getTransaction` keeps slot, blockTime and the message (account keys, header, instructions) and drops `meta` (logs, balances) |
| `PUB/full/**` (the season-end bundle) | **not stored**: the tests generate it from `state/` with `audit/season_end.mjs`, so the publication itself is exercised on real data |

What this run is, and is not: it is a **pre-fix** run. It predates the release job (no `PUB/open/`), its stored llama seeds follow season 0 while its
commitments say season 41, it hashed `episode_kinds` with the first definition, and a later outcome overwrote an earlier tx list in two records.
`../../citizens-audit-slice4.test.mjs` therefore pins the **real** verdict of each check (M2 and M11 pass; M1, M3, M7, M9 fail for the named reasons;
M8 is vacuous) and makes each tamper on a copy. The checks that must pass on a consistent run are exercised by `../ai-audit-mini.mjs`, which
re-issues this run's real decisions, episodes and herald log through the production registrar, records and season-end code on a fake chain (its
header lists what is real, derived and synthetic there).
