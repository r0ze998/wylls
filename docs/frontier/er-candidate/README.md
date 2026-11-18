# ⑲ ER candidate docs: not in main (pointer, 2026-11-18)

Code on main cites files in this folder:
`findex/src/ingest.rs:24`, `findex/src/provenance.rs:2`, `findex/tests/ingest.rs:498`,
`findex/tests/open_items.rs:5,157`, `verify/tests/open_items.rs:6`.
Those files were never merged. They are kept, unchanged, on the archive branch:

- branch `origin/archive/ws19-er-candidate-20261108`, head `0c2214d5`
  (base `4cd901de`; `preserve/ws19-a91b7a4f` and `preserve/ws19-supp-d793ebd4` are prefixes of it)
- read one with `git show 0c2214d5:docs/frontier/er-candidate/<file>`
- the cited ones: `RECOVERY.ja.md`, `OPEN-ITEMS.ja.md`, `results/`

They describe the MagicBlock Ephemeral Rollup (ER) candidate (`frontier-er/`, a separate board program).
**That candidate is not adopted.** Decision O8 (`docs/frontier/DECISIONS.md:22`) says Season 1 runs on the Solana
base layer only, with no ER lane. `permutation-frontier` has no MagicBlock code (`permutation-frontier/src/lib.rs:2`).
The first devnet milestone deploys only `permutation-frontier`, so it does not need ⑲'s ER work.

What of ⑲ is on main:
- the findex history-gap check, provenance and open-item tests ("19 A+D", applied by `6b670edb`;
  patch-id equal per path);
- the later history, ledger and rewind work (`668e9b66`, `7ab2b0b2`, `d0949fd4` and their descendants);
- the archive consistency tests `findex/tests/consistency.rs` and `herald/tests/consistency.rs`
  (ported from `1e577a8a`, 2026-11-18).

The MagicBlock SDK and delegation tests that are on main belong to the older `permutation-chain` program
(`permutation-chain/src/processor/delegation.rs`, `permutation-chain/svm-tests/tests/delegation.rs`), not to Frontier.

Full classification: `~/Projects/wylls-grok-state/reports/ws19-integrate.md` (ws19-integrate run).
