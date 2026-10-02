# W1C-C contract v1.3 and docs: notes (Wave-1 close)

- **Unit:** W1C-C-contract, branch `frontier/cq-w1c-contract`, cut from `frontier/cq-integ` at `f1a5510` (DECISIONS CQ-H recorded). Local commits only.
- **Sources:** `OWNER-OPTIONS-W1.md` and `.ja.md` (PO-1…PO-8, the "contract change" lines, [C] / [P1] tags), DECISIONS CQ-G and CQ-H (CQH1…CQH4), `integ-CQ1-NOTES.md` §2, §4, §6, §7, §9, contract v1.2, the experiment branches (`exp/cq-e1-planner` 18962c7, `exp/cq-e2-floors` 15e0df7, `exp/cq-e3-doctrine` bcd9d60, `exp/cq-p1-combo` 60def25) and their logs under `(session scratch)/scratchpad/cqexp/`.
- **Owned paths touched:** `docs/frontier/conquest/CONQUEST-CONTRACT.md`, `docs/frontier/DECISIONS.md`, `docs/frontier/conquest/SUMMARY.ja.md`, `docs/frontier/DESIGN.md` (§24 only), this file. Not touched: other units' notes, the integration notes, the decision sheet, any code, manifest or lockfile, the design chat's files.
- **Dependency requests:** none.

## 1. What changed

| File | Change |
|---|---|
| `CONQUEST-CONTRACT.md` | **v1.3**: version line; new **§19 "Amendments v1.2 → v1.3 (owner package, 2026-10-02)", A-8…A-25**, each with its source in the sheet; the normative sections they touch: §0 item 1 (measured expectations), §3.1 and §3.2 (`keep_tile_symmetric`), §3.10 (provisional holdings), §3.13 (v2 versions, `RULESET_HASH_V2` re-pin, thresholds re-derived), §3.14 (four new rows), **new §3.16** (K2's MC train cost and the Knight bound), §5.1 (v1 WASM bytes behaviour-identical), §5.6 (OpenProvince, Train), §7 (`keep_tile_symmetric`, `train_v2`, `TRAIN_PROD_COST_V2`, `validate_table_v2`), §8.5 V22, §8.6 (the E1 planner), §8.7 items 1, 4, 5, 6 (package as the `mc` default, 10e′, 28-day floors with `--controls`, size stress, the 0.995 ceiling, the field-equality test), §11 (integrator's WASM exception, the Wave-1 close units, CQ2-A and CQ2-F briefs), **§12 Gate CQ1** (commands, overnight lines, pass conditions), **§13.4** (P′, the v1.3 floors and an old → new floor table with reasons and [P1] p10s), §15 (PO items settled) |
| `DECISIONS.md` | **part CQ-I** (CQI1…CQI14: each amendment with its source in the sheet, status owner / architect / record); change-log rows for CQ-G/CQ-H (main session) and CQ-I; the part CQ intro points at v1.3 |
| `SUMMARY.ja.md` | a **"v1.3 の更新"** section at the top in plain Japanese (rules, bots and floors, the measured numbers that replace v1.1's estimates, open risks, next steps); title line notes it; the rest unchanged |
| `DESIGN.md` §24 | pointers only: the contract is v1.3; the keep tile is symmetric; §24.3 "what to expect" with measured numbers; PO-7 and PO-2 one-liners in §24.4; §24.8's floors |

## 2. Choices the contract had to make inside the package (status "architect", reversible by amendment)

1. **The Knight bound takes both halves of the sheet's "refuse Knight lines (or keep a Knight cost)"** (A-12, CQI5). Train (0x42) accepts any unit id 0–6 whatever the faction's doctrine (`permutation-frontier/src/proc/holding.rs` Train → `catalog::train(unit, n)`), so a doctrine-table check alone would not stop a direct Knight purchase at a Spearman's price if the Knight also lost its surcharge. K2 was measured only on the Horseman line. The kernels unit (`frontier/cq-w1c-kernels`, `W1C-A-kernels-NOTES.md`) reached the same reading independently: `TRAIN_PROD_COST_V2 = [6, 7, 6, 12, 14, 16, 10]`, `validate_table_v2` → `DoctrineError::RefusedLine`. §3.16 and §7 use its names.
2. **Off-chain Train-cost dispatch** (§3.16): the verifier's Train replay (`frontier-node/crates/verify/src/holding.rs` calls `catalog::train`), `fclient`, the bots and any WASM / SDK cost preview use `train_v2` for an MC season. Not in the sheet; it follows from R-22's version dispatch, and without it V-checks would reject honest MC Train payments. Owners: CQ3-A, CQ2-D, CQ2-F, CQ3-C, CQ3-D.
3. **Which 2:1 rows are gated at 7 days** (A-18): the campaign policy with the human mix and with `--bot-profile cq` (the sheet's "With E1: 10/10 and 9/10" rows). The lone human mix (7/10) and the `m1` profile (1/10) do not pass the 2:1 stress (both measured before E1, `cqexp/E2-floors/Z-s2-hl.log`, `Z-s2-m1.log`); they are not gated and are named as an open risk (CQI14). 28-day lines: campaign, the default 5% simulated bots (the logs `T28-sizes2`, `P1-combo/Q03-S28-3to1`).
4. **10e is reported beside 10e′**, not dropped; the occupations floor stays on the bot row (`--bot-profile cq`), as the sheet says.
5. **v1.1's integrator-alone tuning fallback** in §12 (the §3.12 levers) is withdrawn: CQH3 sends any further regression to the owner, and every lever is a player-visible rule.
6. **Ownership-check line** of Gate CQ1 also walks `refs/heads/frontier/cq-w1c-*`.
7. **`RULESET_HASH_V2`:** the contract and CQI12 name the kernels unit's branch value `b6dd0f3f260d9ef3e9a71c5010b56c42693578f4d8c394623d56deb9fed98274` only as "pinned on that branch"; the integrator confirms it after the merge.

8. **The gate preamble (A-25, CQI15):** `git diff --quiet "$CQ0" -- permutation-server/web/session.mjs permutation-chain/src` already exits 1 at the base `f1a5510`, because the owner-approved Wylls rename on `codex/frontier` (`8c1b5ea`, merged into `frontier/cq-integ` before the close) changed a doc comment in `permutation-chain/src/lib.rs` and the key-backup text in `session.mjs`. The line now compares against `git merge-base HEAD codex/frontier` (exit 0 at `f1a5510`), which keeps its purpose: no MC unit edits these paths.

None of these needs an owner decision beyond CQ-H.

## 3. Facts recorded for the owner (not decided here)

- The [P1] numbers in §13.4 and §19 (the floor margins, the 28-day and size-stress verdicts, the symmetric-keep band) are the combined package run's and are not yet skeptic-verified; the re-run Gate CQ1 replaces them.
- The human-mix campaign row (5% simulated bots) still fails occupations (1/20), liberations (0/20) and 10e′ (0/20) at the v1.3 floors (`cqexp/P1-combo/P10-G-hc.log`); not gated (OD-14).
- At 7 days the 2:1 size stress passes only under the campaign policy (§2 item 3).
- The measured keep re-take within 3 days (2.7–2.8% p50 at 7 days) is far below v1.1's "about 40%"; `integ-CQ1-NOTES.md` §7 notes that campaign defence never breaks a keep contest; CQ2-F should check its planner's defence before porting.

## 4. Gate CQ1 lines for these files

These files are documents; no Gate CQ1 command reads them. The lines that concern them:

| Line | Result |
|---|---|
| `scripts/cq-ownership-check.sh frontier/cq-w1c-contract` | see §5 |
| `scripts/cq-ownership-check.sh --self-test` | see §5 |
| the preamble's "MC never touches `session.mjs` / `permutation-chain/src`" line, v1.2 and v1.3 forms | see §5 |
| `git diff --name-only f1a5510` ⊆ `docs/frontier/**` (owned paths) | see §5 |
| Markdown tables in the four changed files: every row has its table's column count | 0 bad rows (script in the session scratchpad) |

`scripts/cq-regen.sh --check` and every cargo / npm line are unaffected by documents and belong to the kernels and sim units and the integrator.

## 5. Results

Logs: `(session scratch)/scratchpad/cqclose/W1C-C-contract/`.

| Line | Exit | Result |
|---|---|---|
| `scripts/cq-ownership-check.sh frontier/cq-w1c-contract` | 0 | **PASS**: 0 violations; 2 footprint warnings, report-only (A-2): `docs/frontier/DECISIONS.md` and `docs/frontier/DESIGN.md` are also on `frontier/ui-shell`'s footprint since `39ff369`; both are this unit's owned paths (§11: `docs/frontier/**`), as they were CQ1-D's |
| `scripts/cq-ownership-check.sh --self-test` | 0 | **PASS** |
| `git diff --name-only f1a5510 HEAD` | — | only `docs/frontier/{DECISIONS.md,DESIGN.md}` and `docs/frontier/conquest/{CONQUEST-CONTRACT.md,SUMMARY.ja.md,W1C-C-contract-NOTES.md}` |
| v1.2 preamble: `git diff --quiet 39ff369 -- permutation-server/web/session.mjs permutation-chain/src` | **1** | fails at the base `f1a5510` already, from `8c1b5ea` (the rename on `codex/frontier`), not from any MC unit; hence A-25 |
| v1.3 preamble: `git diff --quiet "$(git merge-base HEAD codex/frontier)" -- permutation-server/web/session.mjs permutation-chain/src` | 0 | merge-base `2c0462f` |
| Markdown tables (four changed files) | — | 0 rows with a wrong column count |

**Cross-check with the kernels unit (uncommitted working tree of `frontier/cq-w1c-kernels` read at the time of writing):** its names and choices match §3.16 and §7 (`train_v2`, `TRAIN_PROD_COST_V2 = [6, 7, 6, 12, 14, 16, 10]`, `validate_table_v2` → `RefusedLine`, `keep_tile_symmetric`, `KEEP_VERSION` 2, `CATALOG_VERSION_V2` 2, `DOCTRINE_VERSION_V2` 2, `RULESET_HASH_V2` `b6dd0f3f…8274` on its branch). The sim unit's working tree uses `net_movement_open` for 10e′ with the floors of §13.4. If either lands differently, the integrator reconciles §7 (A-10's note).
