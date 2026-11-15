# Workstreams ①–⑳: ledger (Claude, 2026-11-16)

No secrets. Restricted everywhere, in every lane: NFT transfer verification or equivalent procedures, session guard,
prize, real funds, public issuance. No time estimates: none is backed by a measurement.

## How to read it
- **Self-claim (date)** is the workstream README's own status line, at the date it gives. It is NOT re-verified today
  and is NOT "done now". Most date from 2026-10-30 … 11-08, before the continuous-world and v2 changes.
- **Last commit** = last commit touching `workstreams/<n>/` on canonical `codex/wide-conquest-lifecycle-20261109`
  @bcc63a24 (bcc63a24 itself is the 2026-11-15 migration WIP, unverified).
- **Integration** = only what was checked in this pass: the folder is in canonical (records integrated). Whether a
  workstream's code or patches are in the canonical program/page was NOT determined here unless stated.
- ⑯–⑳ have no folder in canonical; their names and states come from references in canonical docs and preserve branches.

## Ledger
| # | name | self-claim (date) | last commit | integration | restricted parts |
|---|---|---|---|---|---|
| ① | national strategy (a nation plans; people join) | design + local prototype done; real S1 connection and human play not done (10-30) | 42b1f393 (11-08) | records in canonical | — |
| ② | rights (use others' resources with limited authority) | proposal awaiting adoption; host-native check done; SBF/LiteSVM/event replay not done | 626a5cc8 (11-08) | records in canonical; code a proposal | delegation/session-adjacent: ordinary parts only |
| ③ | composability (external programs, MCP) | local MCP client on a local real chain confirmed (per its table) | 1398f44c (11-08) | records in canonical | doc 22 is NFT transfer: excluded |
| ④ | execution (multi-turn runs) | local integration branch ws04/integration-20261030 | cca16cd8 (11-09) | records in canonical | — |
| ⑤ | AI participation | audit + local demo; a proposal, not adopted | 16576826 (11-08) | records in canonical | agent wallet / session keys: excluded |
| ⑥ | creation (residents publish mechanisms) | local prototype done; chain connection not done (11-05) | 695e1d83 (11-08) | records in canonical | — |
| ⑦ | player experience (UI/UX) | screen wiring "implemented, awaiting verification"; latest record INTEGRATION §0o | 4532651d (11-08) | records in canonical; the page lane continued in canonical rounds 33–49 | NFT card parts (⑳): excluded |
| ⑧ | persistence (roles for newcomers, losers, absentees) | continuous-world migration design first (10-31) | cd449f08 (11-08) | records in canonical | — |
| ⑨ | capacity (borrow a workshop's processing) | work of 10-30 recorded | b1157847 (11-08) | records in canonical | — |
| ⑩ | custody (storage/transport keeping ownership) | minimal base in kernel/model/host (10-30); adapter for ⑨ (11-05/06) | 970c50a1 (11-08) | records in canonical | transfer-of-ownership checks: excluded |
| ⑪ | extensions (users/AI add functions) | r13: ABI/coverage contract matched on cf517b55; recommends B (declared effects) | af41e617 (11-08) | records in canonical | — |
| ⑫ | memory (memory/relations change AI's next act) | isolated prototype; limits listed | 64960c1e (11-08) | records in canonical | — |
| ⑬ | citizens (independent AI residents) | minimal implementation; connected to ④/⑤/⑫ in a mock world (11-06) | 5133f3c7 (11-08) | records in canonical | NFT resident ID (⑳): excluded |
| ⑭ | central tower | pushed 11-08; stage value always 0 in production | 45da6d38 (11-08) | records in canonical | — |
| ⑮ | coop outcomes (evaluator) | branch ws/15-coop-outcomes (10-30); long-run.json changed in the WIP | bcc63a24 (11-15, WIP) | records in canonical | — |
| ⑯ | independent verification (verifier re-judging actors) | named in canonical docs; fix candidates referenced | — (no folder) | not determined | SESSION_SETTER/HOLDER parts: excluded |
| ⑰ | settlement / prize (x402, USDC) | — | preserve/ws17-0c80381d | not determined | **restricted as a whole** (prize, funds) |
| ⑱ | drand / sealed march / verification (V0) | local branch claude/brave-bohr-xe4n4p (code 853140ef, docs 90df6a64), "not received" in older docs | preserve/ws18-4fbe0c77 | not determined | — |
| ⑲ | MagicBlock and public RPC | local branch claude/ecstatic-cannon-d0jfc4, "not received"; read-only check 11-07 | preserve/ws19-a91b7a4f (+supp d793ebd4) | not determined | public network: nothing sent |
| ⑳ | NFT resident ID and authorization | — | — | not determined | **restricted as a whole** (NFT) |

## The ordinary game lane (separate from ①–⑳): first playable vs full
- **First playable (ordinary wallets, local test world)** critical path, from
  docs/integration/CLAUDE-FIRST-PLAYABLE-STATUS-20261115.md (canonical): start → join → train → form → march → arrive →
  recover → march again → take a fort. Seen in real TEST-ONLY worlds (live29–34, compressed ×10/×30); live34 on
  binaries from 5c2dc607. Open on that path: (1) the owner's choice of first version (capture demo, compressed, vs
  natural world, where one player cannot expand by the rules); (2) a fresh-clone build on another machine; (3) a
  natural-speed world played through; (4) rounds 44–45 not seen in a world; phone layout deferred (PC first).
- **Land preview** (opt-in, this branch): land5 real chain ×10 showed take + growth; open: fray to its end, retake,
  natural speed, Rust tests not rerun, tags provisional; integration steps in CLAUDE-LAND-PREVIEW-INTEGRATION-20261116.md.
- **Full ①–⑳**: most workstreams are proposals or prototypes by their own last claims; ⑰ and ⑳ cannot be completed
  under the current restrictions, and parts of ②⑤⑩⑬⑯ stay unverified for the same reason. Full ①–⑳ completion is not
  reachable as stated; only the ordinary parts can be advanced.

## Lanes started 2026-11-16 (ordinary only)
See the table at the end of this file, updated as lanes report.

| lane | session | branch (new, local base) | owned paths | next evidence | state |
|---|---|---|---|---|---|
| A first-session fixture | lane-a-first-session | lane-a-first-session-fixture (from 68e8548d) | `permutation-gateway/screens/first-session.screen.mjs`, its doc | the file passes on the keyless fixture, step by step | started |
| B March block reasons | lane-b-block-reasons | lane-b-march-block-reasons (from 68e8548d) | `permutation-gateway/screens/march-block-reasons.screen.mjs`, its doc | each reason once, in sight, EN/JA at 1440 | started |
| C economy display | lane-c-economy-display | lane-c-economy-display (from 68e8548d) | `permutation-gateway/test/web-frontier-economy-display.test.mjs`, its doc | page figures vs Rust tables, mismatches listed | started |
| D English audit | lane-d-english-audit | lane-d-english-glossary (from this branch) | `permutation-gateway/test/web-lang-play-glossary.test.mjs`, its doc | rounds 33–49 + land strings vs glossary | started |
| integration + ledger | this session | claude/continuous-territory-integ-20261115 | docs/integration/CLAUDE-LAND-PREVIEW-INTEGRATION-*, this ledger | trial on bcc63a24, ordinary subset only | running |

Rules for every lane: no Rust build, no world, no fixed 41xxx port (fixture uses an ephemeral port), only its own new
files, findings as proposed patches in its doc, no full-suite rerun, restricted areas excluded and reported as not
verified. Heavy builds and worlds stay serial, in this session, after a report (21 GiB floor, 110 MiB output, TTL).

## Next play version prepared: play2-land (TEST-ONLY, 2026-11-16 07:50 JST) — NOT started
- What: the land-expansion test version (capture demo ×10 + land preview + contest pair, two ordinary memory-only
  wallets). Synthetic clock; NOT natural speed, NOT production. Rules 6 / 72 / 36 unshortened.
- Page + launcher: export `/Users/r0ze/Projects/wylls-play2-land-bf85caec-20261116` of this branch @bf85caec
  (canonical 68e8548d + land preview; canonical WIP bcc63a24 NOT included).
- Binaries: land4 builds, no rebuild — Rust/Cargo inputs identical to land4's build commit 9cf2c42a (`git diff` empty);
  .so f2e64442…, herald cd5a9281…, natural runner f00415a2…; expedition tools from the 5c2dc607 build, read only.
- Ops (not in git): `/Users/r0ze/Projects/wylls-play2-land-ops-20261116/` play2-run.sh (6be18bf1), play2-guard.py
  (232b13ef), play2-watchdog.sh (9e855dc9) — land5's scripts with paths only changed.
- Preflight 07:50: free 25.14 GiB (floor 21), 0 listeners 40000–41999, no world process. Plan: launcher 41960, worlds
  41964–41973, TTL 150 min from Start, guard 110 MiB / 21 GiB, absolute watchdog deadline launch + 4 h, PID-only cleanup.
- Starting the launcher was refused by the tool permission check; it waits for the owner's go. Nothing was started.

## Lanes returned and fixes integrated (2026-11-16, head d3eb9c18)
| lane | finding | fix on this branch | evidence (fixture/unit only) |
|---|---|---|---|
| A first-session | no page defect | — (test brought in, e650402b) | `first-session.screen.mjs` 2/2 (EN/JA 1440): screens and card words up to "Send this order", **nothing pressed or sent** |
| B block reasons | D1 two sentences in sight (5 reasons), D2 forming host silent | b2fdc645 (`map/actions.mjs` tag = marchCheck sentence; `app.mjs` mapTap) | `march-block-reasons.screen.mjs` 16/16 strict, 0 todo; NoTicket / no-host not reachable (not covered) |
| C economy display | E1 S1 promotion ore gain was M1's | 41fb12a8 (`fland.mjs` projectedHolding via `seasonBase`) | `web-frontier-economy-display.test.mjs` 10/10, 0 todo; O1/O2 open (season matrix, unknown terrain) |
| D English | 11 proposals | d3eb9c18 (dictionaries + the sibling siege line; 3 tests' old words updated) | `web-lang-play-glossary.test.mjs` 16/16, 0 todo |
- Regression on the exact tree (scratch copy, file-for-file equal): ordinary-only subset 183 files — 1739 tests, 1736 pass,
  2 fail (web-lang (b)/(c), known, owner's call), 1 skipped, 0 todo; screens alone: local-march-maptap 5/5,
  conquest-press 10/10. Restricted files excluded and NOT verified.
- Not proven by any of this: that the fixes behave in a real world (no world ran since land5); phone width; a natural-speed
  world. The fixture shows words and taps; a send that lands is live-world evidence only (live23–34, land4–5).
- play2 source moved to export `/Users/r0ze/Projects/wylls-play2-land-d3eb9c18-20261116` (previous bf85caec export kept);
  play2-run.sh now sha 85814620 (the bf85caec version saved as play2-run-bf85caec.sh.bak). Rust inputs still identical to
  9cf2c42a, so the land4 binaries stay valid. Launcher still NOT started (permission check refused it earlier).
- Product state: these are display/wording fixes on the ordinary path; the product is not complete (see first-playable
  open items above and the ①–⑳ table).
