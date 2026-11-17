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
  41964–41973, TTL 150 min from Start, guard 110 MiB / 21 GiB, PID-only cleanup. Window (corrected 2026-11-16): everything ends by
  launch + 150 min — watchdog SIGINT at launch + 145 min, SIGTERM leftovers at + 150; guard monitors ≤ 150 min (was
  200, from land5); the earlier "launch + 4 h" deadline exceeded the owner's 150-min frame and is withdrawn
  (ops START-PLAN.txt).
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

## 2026-11-16 08:15 JST — web-lang (b)/(c) fixed; play2 ops v2 (fail-closed), not started
- 5730d50b: the expedition return card's words are `L`…`` in `hud/hand.mjs` (`returnWords`); `fexpedition-return.mjs`
  holds ids only (round 42's option 1); unused `次に必要な確認` removed. web-lang 22/22 (no known failures left),
  expedition-return 13/13, glossary 16/16. Ordinary-only subset (183 files): 1739 tests, 1738 pass, **0 fail**, 1 skipped,
  0 todo. Not run (restricted mix): `codex-route-preview.screen.mjs` (renders the card beside the boundary editor and a
  prize stub) — the card's on-screen rendering is NOT screen-verified, only unit-tested.
- Ops v2 (not in git; `/Users/r0ze/Projects/wylls-play2-land-ops-20261116/v2/`): play2-start.sh (15623bab), play2_ops.py
  (e7f292d9), tests/test_play2_ops.py (4e159e44); START-PLAN.txt (2f1c92d9); v1 marked SUPERSEDED (kept).
  - fail-closed: guard + watchdog armed against the starter's pid before the launcher exists (exec keeps pid and start
    time); not armed in 20 s → nothing launched. Each one stops the launcher if the other disappears.
  - every signal re-checks pid + start time + exact `--root`/`--data` (or the starter before exec) right before it.
  - total of all worlds + launcher log + ops logs < 110 MiB; free floor 21 GiB checked with or without a world; limits
    can only tighten; watchdog SIGINT T0 + 145 min, SIGTERM leftovers T0 + 150 min.
  - all 7 binaries and the export commit pinned by FULL hash.
  - Tests (dummy `sleep` targets only, no launcher/port/world): 11/11 — arming and clamping, two worlds of 60 MiB
    together over the cap, the floor with no data dir, refusal for another data dir and for a reused pid, re-check before
    signal, deadline SIGINT, deadline clamped to the window, guard gone / watchdog gone, target exit ends both. Starter:
    `--preflight-only` ok on the real files (08:11); a wrong pin stops the preflight; an ops module that cannot arm stops
    before exec (copy with the launcher line neutralised).
  - NOT exercised: the real arm → exec → launcher path (it would start the launcher), the launcher's own children (runner,
    herald, relays) are stopped by the launcher's close path, not by these scripts; a SIGTERM fallback leaves any child
    that outlives its launcher (seen never so far) to be reported, not killed.

## 2026-11-16 08:40 JST — ops saved to GitHub (template); return card display test
- 040fce38: `scripts/play2-land-ops/` — public-safe copy of ops v2: starter reads a KEY=VALUE config (template
  `play2.conf.example`, placeholders always stop; real configs and run output git-ignored), no personal paths, logs or
  credentials (scanned before commit). README: not a permission to start; never run against a real launcher or world.
  Tests: `python3 -I scripts/play2-land-ops/tests/test_play2_ops.py` 17/17 (dummy targets + config refusals). Local
  originals in the ops folder unchanged.
- 57619f15: `hud/returncard.mjs` (card words + markup, split from hand.mjs, no behaviour change); unit test 21/21 EN/JA
  with an import audit (lang + util only); screen test 2/2 at 1440 (real stylesheets, page JS off, 0 requests). The
  return test no longer imports hand.mjs. Ordinary-only subset 184 files: 1761 tests, 1760 pass, 0 fail, 1 skipped;
  screens first-session 2, maptap 5, conquest-press 10, block-reasons 16. Shown from fixture models: the card inside the
  real inspection flow (codex-route-preview, restricted mix) is still not screen-verified.

## 2026-11-16 09:10 JST — canonical candidate; far-land chip (PC)
- c46b6768 (this branch): the strip's land chip adds "Other provinces: N tiles" / 「ほかの州 N マス」 — the nation's claimed
  land in loaded provinces other than home (a far take read 0 or showed no chip). Tests + ordinary subset 1762/1761/0
  fail. Not seen in a real world.
- Candidate `claude/canonical-candidate-20261116` (worktree `wylls-canonical-candidate-20261116`): canonical bcc63a24
  (UNVERIFIED WIP) + this branch; shared paths only herald Cargo.toml (kept both) and fold.rs (auto-merged; Rust not
  compiled). Ordinary subset 1967/1966/0 fail on 800f5d98. Handover: that branch's
  docs/integration/CLAUDE-CANONICAL-CANDIDATE-20261116.md. Canonical branch, tree and index untouched.

## 2026-11-16 09:05 JST — candidate Rust (land scope) all pass; two open items closed by reading
- Candidate 8ac3d4e8: herald (both features on the merged fold.rs, default, land_capture 2, expedition_records 1, lib 65),
  rules land 19 / default 175, abi land 9 / default 115, program check with/without land-preview, map_growth 10, itest
  land_lane 3 — guarded (conquest-guard 94baeb7d + floor 21 GiB, deadline 10:30), APFS-clone target, nothing fired,
  pinned play2 binaries untouched. Not run: program default lib (NFT-resident paths), SBF build, any world.
- Land doc item 5 ("Territory N tiles" = nation over provinces read): already gone — no page file uses `landTotals`
  since db6eef59 (the chip is landSummary, plus the far part of c46b6768).
- Lane C O1: cannot occur for seasons this program creates (CreateSeason takes only this binary's S1 version).

## 2026-11-16 09:15 JST — land SBF reproduced on the candidate; tag audit
- SBF (candidate 6b2c4303 worktree): `cargo build-sbf --manifest-path permutation-frontier/Cargo.toml --tools-version
  v1.52 --arch v2 --features localnet-land-sbf --offline --skip-tools-install -- --locked` (solana-cargo-build-sbf 3.1.9,
  installed platform-tools v1.52), guarded (conquest-guard 94baeb7d + floor21 99dbed44, deadline 10:30), target = APFS
  clone of the land target; rules, abi and program recompiled from the candidate's sources (registry deps cached).
  Output (separate, git-ignored): `<candidate>/permutation-frontier/target/deploy-localnet-land-sbf/permutation_frontier.so`
  sha256 f2e644420dd8dca4a9c985b995ea599040e09b0e69bc561f3069e625e96a5987, 3,648,952 B — byte-identical to the pinned land4
  .so; script checks (PSF_LAND_CHECK_ONLY=1): SBPF v2, overflow checks, both localnet markers, no test marker. Not
  deployed; no world.
- Tag audit: frontier-abi `the_land_tags_collide_with_no_routed_band` — 0xCD/0xCE against v2 (table + Ix::ALL), rights
  0xD0–0xD5, capacity 0xF0–0xFD, wide drafts 0xD6–0xDF + 0xEE (under their features); workstream 20's band 0xE0–0xE7 by
  the existing assertion. Static: no other first-byte use of 0xCD/0xCE in program, abi, rules, frontier-node or the page
  (other hits are 32-byte address/hash literals; expedition instructions reuse wide tags with a 0xff class byte). Pass with
  all features (13) and land-only (10). Tags stay PROVISIONAL until the integrator allocates them.

## 2026-11-16 09:25 JST — WIP inventory, ABI rev 7 (on the candidate branch)
- Candidate `claude/canonical-candidate-20261116`: per-file inventory of bcc63a24 (46 adopt with evidence, 22 records,
  6 hold, 1 not adopted, 4 restricted); two WIP-own test failures fixed; ABI-ALLOCATION rev 7 (0xCD/0xCE land, 0xCF
  reserved, 0x0400 reserved not applied) with a ledger↔code test; ordinary subset 0 fail. Details: that branch's
  CLAUDE-CANONICAL-CANDIDATE-20261116.md and CLAUDE-WIP-BCC63A24-INVENTORY-20261116.md.
- Free space ~21.5 GiB (my scratch exports, ~14 × 210 MB, are kept; deleting them needs the owner's approval).

## 2026-11-16 10:05 JST — scratch cleanup (approved) and the held WIP items
- Owner-approved batch: exactly 13 scratch test copies deleted after a gated re-check (realpath, no process use, file-by-file
  equality with GitHub commits; two safe aborts before the final run); 2,808 MiB freed (21.21 → 23.95 GiB); logs, scripts,
  symlink targets, worktrees and pinned binaries unchanged.
- Candidate: runtime-contract depart_message 5/5 + unsigned_message 4/4; expedition SBF built guarded, its checks pass
  (f2f03328…). WIP inventory: 50 adopt, 22 records, 1 hold, 1 record-only, 1 not adopted, 4 restricted.

## 2026-11-16 10:30 JST — yield per hour on the chip; candidate adoption conditions
- 7e2ecdb9 (here): the land chip adds what the bonus pays in an hour (program's yield_for), EN 342 px; ordinary subset 0 fail.
- Candidate (df80ab90 + docs): `.rs.txt` = future reference (positive close covered by the compiled runtime-contract test
  1/1); ABI rev 7 policy adopted (0x4804 kept, 0x0400 reserved); PC play gap list; exact conditions for canonical to take it.

## 2026-11-16 11:00 JST — the two PC fixture gaps closed (fixture replay, not a world)
- 3524adb0: `land-arrival.screen.mjs` 4/4 (EN/JA @ 1440, three runs): land layer enemy → own (canvas colour at the tile,
  card owner + take count, chip) and away → arrived (the village's tag with the arrival turn). No page change; nothing sent.
  Candidate e9da7611: its page differs only by the WIP's seal-worker.mjs, the unloaded .orig and the route-preview screen;
  correction: the first version of the land check was flaky (1 in 2 EN runs; it sampled under a sprite — the page painted
  the land correctly); fixed in the next commit, then 8/8 runs (4 integration, 4 with the candidate's page files).

## 2026-11-16 11:25 JST — release evidence (candidate), landKeys retraction stated
- Stated plainly: while chasing the land screen's flake a product change to `map/fmap.mjs` + `app.mjs` (`landKeys`) was
  tried and reverted before any commit; the page painted the land correctly, the test sampled under a sprite (274bad0d).
- Candidate 34cf0807+: CLAUDE-RELEASE-EVIDENCE-20261116.md — land5-proven vs fixture-only; land .so byte-identical;
  candidate-built herald/runners/keeper tools (sha256 there; untested in any world); fresh-clone audit (6,696 refs, no
  missing tracked file); `scripts/fresh-clone-audit.py`.

## 2026-11-16 11:50 JST — ①/⑨/⑭ read; one ordinary gap fixed
- ⑭ (tower), ⑨ (capacity preview) and ① (national strategy prototype) are proposals or off-by-default previews: nothing to
  fix without inventing rules. Existing S1 building checks vs the program: all mirrored except CapturePending.
- b44db980: the S1 tile card blocks a storehouse and structures while the village is being captured (the program's capture
  lock); test pins the Rust rule; ordinary subset 0 fail. Candidate b402100b with the selection note
  (CLAUDE-NORMAL-GAP-S1-CAPTURE-LOCK-20261116.md). Next candidate: CapturePending in fland actionBlocks (per action).

## 2026-11-16 12:20 JST — capture lock in every action pre-check
- 7ca998e3: CapturePending pre-checked for Build/Train/Harvest/Muster/Garrison/FortGarrison (own Province, always),
  Explore/Dissolve/Depart (only with the host in the own Province — the page passes the host's), SendCaravan (village
  source only). Muster/Garrison/Dissolve/Depart were found while checking (host.rs lock_own) and covered. One rule
  (fland captureLocked/mirrorLocked; fconquest uses it). Tests 6/6 + related 41/41; ordinary subset 1771/1770/0 fail;
  screens all pass. Candidate 2f5a8298. Unit/fixture only.

## 2026-11-16 12:45 JST — S1 fort form checks
- 647ffc6f: FortGarrison pre-checks (NotFinal after the lazy flip, NotResident, the fort's room, the reserve) before signing;
  tests 4/4, ordinary subset 1775/1774/0 fail. Still to audit: Raid, Seize, Siege, Expel, nation proposals/votes.

## 2026-11-16 13:10 JST — Raid/Seize/Siege audit
- cb88dcea: seize — a fort with only pending troops is manned (fort_troops), as the program counts.
- 6d01289e: siege — NotFinal (source final; lazy flip only in the target Province) and NotResident (target resolved);
  siege fixtures moved to a resolved target, expectations unchanged. Ordinary subset 1781/1780/0 fail.
- Raid: no gap (decision window mirrored). Next: Expel and the nation proposals/votes. Candidate notes on that branch.

## 2026-11-16 13:35 JST — Expel and nation proposals/votes audit
- 8dfbebce: expel — an already expelled village is held back (TargetExpelled from the nation's expelled list; Propose
  KIND_EXPEL requires expelled_since == 0); older heralds without holdings: the program decides. Tests 3/3, related 59/59.
- Proposals, votes, slots, readmission, stance form: audited, no gap. Ordinary subset 1784: 1782 pass, 1 fail — the known
  load flake \"round 29 …\" in web-frontier-marches (alone: 10/10 twice). Candidate 738558b4.
- The S1 operations audit (CapturePending, fort, seize, siege, raid, expel, nation) is complete for what the page holds;
  what needs data the page lacks is recorded as left to the program (candidate gap note).

## 2026-11-16 15:35 JST — village Build / Train / Harvest / Muster / Garrison audit
- ceba1d61: walls — a walls order is held back while both wall items of the village's site mirror wait for their turn
  (build_as → wall_item QueueFull); reason WallsBusy (JA/EN). Test web-frontier-build-walls-items 5/5.
- 3ba74174: muster — ProvinceFull (48 standing/forming, 8 of the nation, no free entry) as muster_as counts it; the
  existing sentence. Test web-frontier-muster-province-full 4/4.
- Buildings, promotion, Train, Harvest: audited, no gap (production cap 1,000/h left to the program: not reachable).
- Ordinary subset 1793: 1792 pass, 0 fail, 1 skipped. Candidate merges d9e12b9d, 228ec445; note cf79d9b5.
- 80c51b92: garrison — the form's number checked as garrison_as does (whole from 1, the Spearman reserve, the room
  30,000 less troops and pending after the resolved ones); not under the wide card. Test 5/5; ordinary subset 1798:
  1797 pass, 0 fail, 1 skipped. Candidate merge edafa56b. A first version broke web-frontier-wide-holding-ui
  (refused before WideReadOnly); narrowed before commit.
- The village actions audit (Build, walls, promotion, Train, Harvest, Muster, Garrison) is complete for what the page
  holds. Not re-audited: the muster troop count's 100–30,000 per form and the muster tile.

## 2026-11-16 — Muster troop count / tile, Explore tiles
- Audited read-only, no refusal gap: the drawer's 100–30,000 is held by the input and the browser's validation before
  the submit handler; the hand clamps; Settlers excluded; the drawer's tile is the village site (passable by
  construction), the hand's tiles are passable; Explore offers passable unexplored neighbours (the program accepts more).
- No code change, no test added, no suite run for this step. Candidate note fb4d457a.
- Open for the owner (not changed): the page is stricter than the program in two places — musterTiles' "six to a
  tile" and exploreTargets leaving out the host's own and impassable tiles.

## 2026-11-16 — march / arrival / return, keyless
- Muster's six-to-a-tile and Explore's targets: kept as they are (owner: design decisions).
- Return audited: a march with the village as destination; hand-return switches to the host's own village first. No
  mismatch, no code change.
- Not done: round 28's open-gate case for a host of another village through the real controller — it needs the
  memory-only test wallet (a key in memory), outside this round; a keyless test would need a controller test seam (not
  made). The pure contract (localMarchOpen) is already tested.
- Unit runs on the candidate: 30/30 and 53/53 (march/arrival/return files). One of them, web-frontier-local-play-return,
  is a key-using test (memory-only WebCrypto key, no network) and was run before its header was read; it is also in the
  ordinary subset. No suite run, no fix. Candidate note 98738ff2.
- World-only items unchanged (landing send, credited land yield, far land, catching-up live, rounds 44–45, natural speed).

## 2026-11-16 — test runs stopped; key-free check of two fix tests
- Stopped by the owner: no ordinary-subset run and no key-using test from here on. The subset (193 files) included 15
  key-using and 78 possibly key-using files (scripts/ci/node-key-tests.txt); it ran today without no-keys-guard.
- Static boundary for web-frontier-build-walls-items and web-frontier-muster-province-full: no key API, network,
  process or restricted call on the tested paths (details: candidate gap note fb569acb).
- `node-keyfree.sh` on those two files from the export: REFUSED, exit 5 — 10 stale entries in
  scripts/ci/node-key-reviewed.txt. Nothing ran; not a success; not retried or bypassed; lists and guard unchanged.
- Key-free status of today's normal-game fixes: none confirmed under the key-free runner (only unguarded runs).

## 2026-11-16 — round 28's open-gate case (owner approved in-memory test keys and synthetic signing)
- bcc17068: web-frontier-local-march-open-other-village.test.mjs — real controller, local play, gate open, host of the
  other village: switches to its village, the order fixes it, the send-time answer is open. 5/5, that file only (first
  run 2/5: the test's instance fixture was not 64 hex; fixed in the test). No product mismatch, no fix.
- Key: one in-memory non-extractable Ed25519 key; signing: none; network: fetch stub only; storage: none.
- Not run: the ordinary subset, the two refused key-free files, any send. Lists, reviews and guard unchanged.
- Candidate merge f2c0f2a1; note in CLAUDE-PC-PLAY-FIXTURE-GAPS-20261116.

### Map tap and host bar, a host of another village (2026-11-16, Claude)
- Static: map tap → march, 「村へ戻す」, 探索, 砦へ進軍, 次の軍勢 all switch to the host's own village first. Correct.
- 解散 did not: after a plain tap on the host's tile, its chip on a shared tile, or a put-away march draft, the order
  named the open village (program refuses: dissolve_as → resident_host). Fixed in 98ea5c52 (controller.mjs dissolve
  switches first, as the others do).
- Test web-frontier-dissolve-other-village.test.mjs: 6/6 with the fix, 2/6 without; that file only, from the export.
- Key: none. Signing: none. Network: fetch stub, no request made. Storage: none.
- Not run: the ordinary subset, the two refused key-free files, node-keyfree.sh. Lists, reviews and guard unchanged.
- Candidate merge 9dd64905, note 5c79530e (CLAUDE-PC-PLAY-FIXTURE-GAPS-20261116). Not fixed (display only): 次の軍勢's
  figure counts the open village's hosts.

### 次の軍勢 for a host of another village (2026-11-16, Claude)
- Mismatch: figure counted the open village's hosts (1/N, host not among them; refused with < 2 there); the press
  jumped to the open village's first host. Fixed in aded7996 (hand.mjs hostModel + app.mjs nextHost read the subject's
  own village).
- Test web-frontier-next-host-other-village.test.mjs: 6/6 with the fix, 3/6 without; that file only, from the export.
- Key: none. Signing: none. Network: fetch stub, no request. Storage: none.
- Not run: the ordinary subset, web-frontier-hand (one-village case, unaffected by reading), the two refused files.
- Next: the bar's other paths for such a host read its own village; no further clear mismatch in this family.
- Candidate merge d9986330, note in CLAUDE-PC-PLAY-FIXTURE-GAPS-20261116.

### Land chip per-hour figure (2026-11-16, Claude)
- Mismatch: the chip's 「毎時 +N」 read the stored production; the strip and ClaimLandYield (after settle_tiered) count a
  finished building or promotion. Fixed in e87faba3: the chip call passes settledHolding(lh, now). map/minimap untouched.
- Test web-frontier-land-chip-settled.test.mjs: 5/5 with the fix, 4/5 without (call pinned as text); that file only.
- Key: none. Signing: none. Network: none. Storage: none. Free space 21.98 GiB before the run.
- Lane C E1 already in (41fb12a8), separate. Untracked in the CANONICAL checkout (bcc63a24), not mine, untouched:
  CLAUDE-CONQUEST-V2-CLI-PREPARED-EVIDENCE-20261112.json, CLAUDE-FIRST-SESSION-UX-C-INTEGRATION-20261113/c-before-files.tar,
  permutation-gateway/screens/node_modules.
- Candidate merge 372f778b, note in CLAUDE-PC-PLAY-FIXTURE-GAPS-20261116.

### Minimap camera frame fix integrated (2026-11-16, Claude)
- codex/minimap-frame-20261116 @ 0a58fa44 (hud/minimap.mjs + web-frontier-minimap-cache test): no overlap with the land
  chip fix; diff --check and node --check pass; web-frontier-minimap-cache.test.mjs alone from the export: 6/6.
- Integration merge 84469802, candidate merge fccaf09e. No key, signing, request or storage. Canonical unchanged.

### Scout muster wording integrated (2026-11-16, Claude)
- codex/sakurai-scout-wait-20261116 @ fc6e8b68 (onboarding.mjs, en-frontier-play.mjs, first-village-ui test, owner doc):
  no overlap; diff --check, node --check and the banned-English read pass. Test NOT run (stale runner; not bypassed).
- Integration merge 5877d468, candidate merge a0b3cf99. No key, signing, request, world. Canonical unchanged.

### Forming scout card (2026-11-16, Claude)
- Mismatch: the card counted down to one estimated total wait (ticketTimes resultAbout), which ran out while the
  scouts still waited for the key or the draw; the shared rule and the conquest guide say the turn's phase instead.
  Fixed in c7533214 (formingLine reused; no new words). first-village-ui assertion updated, NOT run.
- Static only: node --check, diff --check, source trace. No key, signing, request, world. Candidate merge d5800fca.

### First session: display, cancel, repeated presses — static audit (2026-11-16, Claude)
- Home choice, scout train/muster and the draft's 「やめる」 are guarded against repeats and cancel cleanly. No change.
- Candidate (not clear, not fixed): cg-go drops a draft without cancelling an armed waiting send; nothing is sent, the
  notice's reason would read 'changed'; reachability while a draft is open not traced. Local play's test entry only.

### cg-go cancel path (2026-11-16, Claude)
- Reachable on PC: the attention pill carries the conquest guide's cg-go while a draft is open. Fixed in e00ad87b
  (cg-go → compose-close: the waiting send is cancelled and says so). Static only; no test run. Candidate e59e802c.

### Lane D round 2 and Lane C land freshness integrated (2026-11-16, Claude)
- Lane D `claude/lane-d-english-r2-20261116` @ 7fab9055 (eb6cebe9): en-frontier-play.mjs — the far-land chip's tooltip
  no longer says "claimed" twice; the unused 「反映の目安まで（ゲーム内）」 entry dropped (no use left after c7533214);
  web-lang-play-glossary test and the lane doc. Candidate merge 2dd62751; integration cherry-picks 57577fae, a70dd826.
- Lane C `claude/lane-c-land-freshness-20261116` @ 1e4e000f (c14d5d21): web-frontier-land-freshness test and the lane
  doc only; no product change. Candidate merge 2e9c0d41; integration cherry-picks (-x) of c14d5d21 and 1e4e000f.
- Checked here, static only: diff --check, node --check (3 .mjs), no file shared with the candidate's commits since
  aa12ce74 (the cg-go fix, docs), the removed entry unused, the Lane C test names no key/network/storage API; both
  branches hold each lane's files byte-identical to the lane head.
- Lane owners' runs (theirs, not repeated here): Lane D glossary 18/18, web-lang 24/24; Lane C freshness 6/6.
  **Not run after integration** (by instruction). Canonical bcc63a24 and its 3 untracked files untouched.

### Lane C G2, land redraw (2026-11-16, Claude)
- Static: refresh and wantProvince redraw the map; local play's sync reads redraw only the panel; with reduced motion
  the board then kept an old outline until the next poll while the chip was new. Fixed in e84049ed (app.mjs
  renderHudTick: land records compared by content → map redraw). Static only, no test run. Candidate 7ccc0275.
- Browser replay case proposed (reduced motion, panel-only invalidate, sample within 2 s); not started.

### G2 replay: safety re-check and a test file (2026-11-16, Claude; written, NOT run)
- The ws07 harness (nokey-page.mjs) needs `--unsafely-treat-insecure-origin-as-secure` for wylls.test, and its init
  writes localStorage (language, title seen, test wallet name, key-use log). Keyless is not storage-free.
- No security exception needed: the page's own `devWallet=off` opt-out on native secure 127.0.0.1 (as
  codex-route-preview.screen.mjs) — dev-only effects are the dev wallet (off) and `?herald=`/`localPlay=1` (not used).
- land-redraw.screen.mjs (6212bf77): outside traffic blocked before sending (resolver rules MAP * ~NOTFOUND
  except 127.0.0.1; a catch-all route; service/seal workers refused); Playwright's profile and artifacts in a named
  empty folder (removed by Playwright on close and on SIGINT/SIGTERM, not on SIGKILL; no size limit of its own → the
  test caps it at 300 MB and needs ≥ 22 GiB free); the non-persistent context's storage checked absent from the
  profile; --mute-audio; key guard and session unchanged. G2 stays dynamically unverified.

### G2 replay run once (2026-11-16, Claude; owner's go-ahead)
- land-redraw.screen.mjs hardened (c30adcf5): exact-origin gate (protocol/host/port of the fixture, GET/HEAD only)
  registered last so it runs before nokey-page's Node-side session.mjs route; other requests recorded and aborted
  before sending. Monitor every 1 s: free ≤ 22 GiB or profile > 300 MiB → this test's own context/browser/server
  closed once, test fails (per-interval checks, not hard limits). No insecure-origin flag; chromiumSandbox true;
  devWallet=off; --mute-audio; keyless guard unchanged; resolver blocks every host name but 127.0.0.1.
- Export synced (4 files: app.mjs, screens/onboarding.mjs, lang/en-frontier-play.mjs = integration HEAD; the test).
  Run: `LAND_REDRAW_TMP=<new empty scratch folder> node --test land-redraw.screen.mjs` → 2/2, 5.4 s.
- Seen: reduced motion matched; native secure 127.0.0.1; after a panel-only redraw of a changed land record the land
  chip counted the tile and the map's canvas at the tile changed colour within 2 s.
- Traffic: no non-GET, no request outside the fixture's origin. Keys: none (assertKeyless). Storage: the page's keys
  absent from the profile on disk. Disk: profile peak 7.5 MiB, free low 25.16 GiB; Playwright emptied the temp folder;
  no process left; writes = 783-byte log + the 4 synced export files. Older playwright folders in the system temp
  (08:19, ~140 KB) are not this run's; untouched.
- NOT done: the control run on the unchanged app.mjs (so the old page's failure is not yet shown).

### G2 control run: the mismatch was not real (2026-11-16, Claude)
- Control: the same land-redraw.screen.mjs, once, from the export with app.mjs as before the fix (e84049ed^; the only
  app.mjs change since) in a new empty temp folder: **2/2 as well** (5.4 s; monitor not tripped, profile peak 7.5 MiB,
  free low 27.55 GiB; temp folder emptied; no process left; 785-byte log). The export's app.mjs was restored to HEAD.
- Why (static, after the control): `renderHudTick` ends with `publishNoGo()` outside any condition; it calls the map's
  `setNoGo` → `tick()` (`dirty = true`), so the board draws a frame on every HUD tick (each chip redraw) with or
  without reduced motion, and each frame's live pass re-checks the land marks and outlines and re-bakes them. My G2
  claim ("the board kept the old outline until the next poll") missed this call: **retracted**.
- So e84049ed is redundant (harmless: one extra `invalidate()` per changed record). Reverting it is the owner's call;
  not reverted here. The test stays as a regression check that passes with or without it — it does not, by itself,
  tell the two apart.

## 2026-11-18 JST (2026-11-17 UTC) — ①–⑳ task update

This is a progress update, not a new specification or permission to run anything. Earlier dated sections above
remain historical records; their test passes do not verify the later changes below.

### Integration checkpoint and current work

- Adopted source checkpoint: `claude/aggregate-approved-20261117` @
  `0cc3ca309e1e4f8e8ab0d414c6a2c9e3e0480646`. This is an integration branch, not a claim of a merge to
  `main`, deployment, or completion of all twenty workstreams. This update changes this ledger only.
- The previously assigned Claude Code implementation/integration units have returned their results. Do not read the
  old "started"/"running" rows above as their current state.
- **Interrupted; partial source saved, not integrated (2026-11-17 16:42 UTC):** the approved CLI
  coop read adapter was launched; its first attempt timed out, and a second attempt saved
  `workstreams/03-composability/mcp/src/coop-read-adapter.mjs` (356 lines). The second attempt's
  recorded worker and monitor processes were no longer present when checked. Its log had no final result;
  the monitor's old "running" label was stale. Test source and documentation were absent.
- **Official Agent view migration: blocked before launch.** The installed CLI supports background agents,
  but the old print-mode job used no session persistence and did not appear in Agent view. A new Opus
  background launch was attempted and refused because this workspace was not trusted. The interactive
  trust dialog additionally warned of an inherited Bash pre-approval; it was cancelled without accepting.
  The new session was not created. Review that configuration through the normal user-facing flow before
  continuing; do not bypass the trust/permission block.
- The partial adapter is not registered as an MCP tool, has not been executed or tested, and is not part of
  the integration checkpoint. Static review identified response-size bounding and free-form error projection
  for follow-up; these are not fixed or verified.

### Source integrated versus remaining verification

| Workstream / task | Confirmed source progress at the checkpoint | Still open / not established |
|---|---|---|
| ① ordinary cooperation UI | Request selection, sending-source selection, existing preparation/result views, saved request history and progress crosslinks integrated | End-to-end operation in a real world is not established by these integrations; no new cooperation rule adopted |
| ③④⑥ existing MCP / execution / creation paths | Existing read, preparation and result consumers, Run/status correlation, persistence uncertainty handling and narrow NoRecord classification fixes integrated | Real ChatGPT/public-wallet connection not completed; no new public signing authority. Localnet guards remain. ⑥ is not itself the signing sender |
| ⑦ ordinary player consumers | Map/read retries, hosts and march planning, forecast/replay, S1 trade, exploration, incoming/conquest links, first-village guidance, troop-to-host links and home-read/confirmation ownership fixes integrated | Later regression sources and real-screen/world behavior remain unexecuted/unverified. Visitor wallet connect returns without guessing the new identity. Home storage world-generation, signer-await/session boundaries and documented limits remain |
| ⑬ operator-side independent residents | Existing-read adapter/factory, observation-bound proposal context, initially manual state, owner-command mode source, explicit injected respond enactment, journal exclusion and saved-result read/API/CLI sources integrated | No real model charge, signature, POST, send, resident operation or end-to-end verification performed for these units. Default single-step path remains non-enacting; explicit respond source is not proof of a running resident. Caravan enactment and unresolved authority/state-writer contracts remain held |
| Other ①–⑳ items | Earlier individual records retained | Not freshly reverified in this update. Proposals, unadopted rules and restricted items are not promoted to complete |

Integration is not a test pass. The later source regressions above were not executed as part of integration.
Existing unknown results remain unknown; ordinary notice retry behavior must not be described as a general
no-resend guarantee. The enact journal exclusion is limited to its documented module/usage and does not establish
a shared lock for all state or owner-mode writers.

### Provisional random-home work: NOT integrated

- Reported final candidate: `21851edd88ce4dad36cbfa19a0ff43242289c23c`,
  branch `claude/home-draw-provisional-20261118`, based on the checkpoint above; eight new paths.
- **Final independent verification is held; this candidate is not adopted or integrated.** The implementation lane
  reported saving the final correction, but that report is not substituted for the blocked independent check.
  The blocked Git confirmation/integration is not retried through another route.
- Non-production and not enabled. All tests and actual execution of this provisional unit remain unperformed.
- The final reported wording means "no candidate satisfies the provisional density/ring conditions", not "the map
  is physically full". Chain placement is not connected; this is not a completed production placement rule.
  Ring-opening behavior, predictability/multiple-account resistance and remaining map decisions are not resolved
  by this source candidate.

### Remaining tasks

- [x] Resolved the official CLI workspace flow; Opus completed the coop adapter and opt-in MCP wiring.
      Independent fixture verification and source integration are complete (see latest entry below).
      Authenticated live-client/board/world end-to-end verification remains separate and open.
- [ ] Resolve the independent-verification block for the provisional random-home candidate before any adoption.
- [ ] Validate adopted source through separately permitted tests and real-user flows; do not bypass refused tests,
      stale-review guards or equivalent restrictions.
- [ ] Finish the approved public MCP connection/authentication design before claiming real ChatGPT gameplay.
- [ ] Resolve the resident's remaining authority, state-writer and real-operation dependencies before operation;
      an uncertain prior submission must not become an automatic new submission.
- [ ] Keep unadopted ①–⑳ rules and undecided map behavior separate from ordinary implemented consumers.

No new runtime, deployment, funds, signing, transmission, permission expansion or specification adoption is
authorized or recorded by this ledger update. Stop-A continues to exclude new inference/reservations/actions;
only the allowed confirmation of already-submitted work remains within that boundary.

### 2026-11-17 16:48 UTC — official Opus background execution confirmed

- After the owner opened the CLI's normal workspace flow, the new official background session was created.
  The official session list reported `working` / `busy`, and the supervisor reported one live worker.
- The earlier trust block is no longer the current execution blocker. The initial status read from a restricted
  context could not reach the local control socket; a permitted direct read confirmed the session was actually live.
- The task continues from the saved partial coop read adapter using Opus, scoped to the adapter, its test source,
  and documentation. No second implementation was started. Runtime tests, registration as an MCP tool, integration
  and game-world operation are still not established.

### 2026-11-17 UTC — coop read adapter completed and source integrated

- Official Opus background task finished (`done` / `idle` verified). It completed the adapter, fixture test and API documentation.
- Three new files were saved to this integration branch, ending at `46ee1b7606c5e0c7a06a9b638bf1ab77a710cf5f`.
  All three were fetched from GitHub and matched the independently checked local files exactly.
- Independent validation on the final output: both JavaScript files passed `node --check`;
  `node --test workstreams/03-composability/mcp/test/coop-read-adapter.test.mjs` passed **34/34**, zero failures/skips.
  Only injected fake fetch, streamed-body fixtures and fake timers were used; no real network or signing.
- The bounded body read and free-form nation error projection findings were addressed and covered by tests.
- **Scope completed: standalone opt-in read adapter source and fixture tests. Scope not completed: MCP tool
  registration, server wiring, authenticated real-client/board end-to-end checks, main merge or deployment.**
  It remains disabled by default and grants no new action authority. Earlier launch/partial-output entries above
  are history, not the current task state.


### 2026-11-17 UTC — opt-in cooperation MCP wiring completed and source integrated

- Official Opus session completed; no duplicate implementation was started. Six wiring/config/test/doc files were saved to this branch, ending at `0cf47638f0abe64d79252ad4c6177e1ec908864a`; all six were fetched and exactly matched the validated local output.
- `get_cooperation_status` is listed and callable only when explicitly enabled. It uses authenticated owner + existing `wylls.read`, server-owned current world and explicitly configured cluster. Disabled means no board fetch. Caller-supplied owner/world/URL is refused. No grant or send authority was added.
- Review found and fixed archive housekeeping on this read; success/refusal/failure leave local stored operations untouched, while existing tools preserve their prior behavior.
- Independent final verification: **60/60 passed**, zero failures/skips (34 adapter unit + 26 real server/HTTP-handler fixture integration tests); five wiring JavaScript files passed `node --check`, tracked diff passed whitespace check. The initial missing dependency was resolved using existing installed local SDK dependencies, without package/lockfile changes.
- HTTP verification executes the real `createHandler` with fake request/response streams and an auth stub: it is not a socket, real OAuth, external MCP-client, live-board or game-world test. Real funds, signatures, runtime deployment, main merge and the full historical regression suite were not exercised. Source integration is not production deployment; the feature remains off by default.


### 2026-11-17 UTC — official SDK transport follow-up

- Official Opus added five SDK/bridge tests. Independently rerun total: **65/65 passed**, zero fail/skip; integration test syntax check passed. The real pinned MCP SDK Client/StreamableHTTPClientTransport was exercised through injected fetch into the real HTTP handler, with stub authentication. No socket, real OAuth, wallet signature or world startup.
- Test and evidence documentation saved through `87f39dd5438e1d252f09b71ff8f67620dbcfbaf4`; both remote files exactly matched checked output. CI status/PR workflow queries returned no entries, not a CI pass.
- No live MCP/board/world process was found. Actual live connection remains open: prior world-start refusals are unresolved and were not bypassed. The SDK fixture step is independent evidence, not completion of real-world verification.


### 2026-11-17 UTC — actual-board contract mismatch fixed

- Static comparison found the earlier fixture tests had invented string nation names and uppercase resources. The real board emits numeric zero-based faction ids and lowercase resource names; healthy real data would be rejected. Earlier 65/65 fixture success did not establish producer compatibility.
- Official Opus corrected nation to numeric 0..5 (0 is a valid nation), resources to food/wood/stone/ore/arms/gold, and fulfilment to the actual board status object. Unknown nation stays null, not zero. No sending or new authority added.
- Added producer-consumer regression using the real pure `coopView` and record `fold`, without starting a board or world. Final independent tests **74/74 passed** (41 adapter + 33 integration), zero fail/skip; three JavaScript syntax checks passed.
- Four modified files integrated through `97325f4120c0b740706ac2002dee6f31e2d54c71`; all four reread from GitHub and matched validated output. Live-board HTTP, real Citizen account/arrivals, real OAuth and world behavior remain unverified.


### 2026-11-17 UTC — cooperation world-cache boundary corrected

- Real `Game.context()` reused a 15-second cache, so the earlier before/after calls did not necessarily observe a relay world change. Independently reproduced with injected relay and fixed address builder, no network or key derivation.
- Official Opus added opt-in `fresh:true` and uses it at both cooperation read boundaries. Other callers retain normal TTL cache behavior. Settled-read ordering prevents an older overlapping read from publishing over a newer result or falling back to a pin from before the latest failure.
- Independent final validation twice passed **83/83 tests** (41 adapter + 42 integration), zero fail/skip; three JavaScript syntax checks and tracked whitespace check passed. Actual Game regressions cover warm cache, changed world, unavailable relay/address build, overlapping and three-way reads, transport/HTTP failures, and recovery. Fresh observations are not a remote lock.
- Four files integrated through `0deff9bcf5a7a144f7c88f7e68605d75d57e25e6`, all fetched and matched validated output. No actual world/board, socket, OAuth, signature or deployment was exercised.


### 2026-11-17 UTC — approved ordinary 1–20 development progress

- Previous world-start rejection and remaining risks were explicitly disclosed to normal approval review. Review allowed separate non-overwriting v3 guard installation, read-only preflight and TEST launcher start. No trust or permission setting was changed.
- Official Opus guard changes passed **33/33 pure tests** and three Python AST checks independently. Corrections cover incomplete-stop reporting, preserved process identity history, and deadline recheck after process inspection. Original v2 is preserved.
- Preflight verified all seven pinned binaries and adequate free space. Launcher HTTP response and both armed supervisors were observed. This is **launcher availability**, not a two-player world or gameplay success.
- The running export is not the newest integration. Its results cannot verify all current workstreams. OS timing, process identity races and uncaptured descendants remain limitations; absolute shutdown guarantees are not claimed.
- Two-player TEST fixture preparation is underway, using only fresh memory-only test wallets. No user wallet, real funds, public deployment or prize operation. Actual fixture execution is still pending.
- **⑦ clock fix: locally complete, not yet integrated.** Invalid chain-clock observations could leave the clock and turn display permanently NaN. Official Opus now ignores invalid observations before state changes. Independent pure regression **11/11 passed**, plus two JavaScript syntax checks. Valid numeric/string/BigInt samples, zero, older slots, normal/accelerated/declared-rate clocks and recovery are covered. No world or transaction was used.
- **①/⑦ cooperation crosslinks: in progress.** Missing world identifiers incorrectly matched and exposed links despite an unknown world. A narrow fix is under independent review; it is not yet counted complete or integrated.
- Priority remains ordinary approved portions of workstreams 1–20, not additional MCP expansion. Proposal-only, restricted and unverified portions are not relabeled complete.
