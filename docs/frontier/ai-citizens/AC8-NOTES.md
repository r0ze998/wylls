# AC8 audit: verify-minds and the season-end publication

Branch `frontier/ai-ac8` (from `frontier/ai-integ` at `9a5a657`, contract v1.3). 2026-10-04, JST. Local test chain only; no devnet, no paid API,
no push, no download. Contract sections: 5.7, 6.3, 7.1 to 7.3, 8.3, 10.2 (G8, G13, G15), 11.5 (AC8 row), 11.6, rulings R9 and R10, integ-A-NOTES section 17.

## 1. What was built

| File | What |
|---|---|
| `permutation-gateway/citizens/verify-minds.mjs` | the CLI and the checks **M1, M2, M3 (with release openings), M7, M8**; runs M9 and M11 through the two modules below; writes `PUB/verify-minds.json` |
| `citizens/audit/canon.mjs` | canonical JSON and hashes, the redactable Merkle rules, the deterministic sampler, the published-bundle reader (`openPub`), the check accumulator and the verdict |
| `citizens/audit/season_end.mjs` | `createAudit({aiDir}) -> {publishSeasonEnd(), watch(), status()}` and the opening function (`buildOpening`) the release job and season end both call |
| `citizens/audit/replay.mjs` | M9, the bit replay of stored llama request bodies |
| `citizens/audit/episodes.mjs` | M11, the episode replay and the retrieval replay over the public log |
| `test/citizens-audit-{canon,slice4,mini,permission}.test.mjs`, `test/fixtures/ai-audit-{capture,doubles,mini}.mjs`, `test/fixtures/ai-audit-slice4/` | 73 tests, the recorded slice-4 fixture (its README says what is real) and the consistent mini run |

No file outside `citizens/verify-minds.mjs`, `citizens/audit/**`, `test/citizens-audit-*` and `test/fixtures/ai-audit-*` was edited. No manifest, no
hook file, no Rust, no wave-A file. No wave-A module was changed to make a check pass; every place where the audit and a wave-A module disagree is
reported in section 5.

### Usage

```
node permutation-gateway/citizens/verify-minds.mjs --herald URL --ai-dir PUB --rpc URL [--llm URL] [--sample 20]
     [--repo ROOT] [--model GGUF] [--llama-dir DIR] [--stack TOML] [--citizens-config JSON] [--slots JSON] [--seat-script F] [--bot-seed N]
     [--only M1,M3,...] [--strict-onboarding] [--through BELL] [--out FILE | --no-write] [--quiet]
```

`--ai-dir` is PUB (the contract's form) or AI_DIR (it holds `pub/`; then `stack.toml` and `ai-slots.json` of the run are found by themselves). Every URL must
be on 127.0.0.1 or ::1 (`--herald`, `--rpc`, `--llm`; exit 2 otherwise). Exit code 0 PASS, 1 FAIL, 3 INCOMPLETE, 2 usage.
`PUB/verify-minds.json` is `{v, run_id, season, checks:{M1:{pass, n, failures:[{code, ...}]}, ...}, verdict, audit_code_vs_committed, generated_unix}`.
A check is `true`, `false` or `null`. `null` means **not fully verified**: a field the run left `unmeasured` (7.1, R9), an input the verifier was not given
(`unverified`), or no llama-server for M9. Verdict: FAIL if any check is false, INCOMPLETE if none is false and one is null, else PASS. An `unmeasured`
field is printed as `unmeasured` and is never a PASS.

Season end: `createAudit({aiDir}).publishSeasonEnd()` (or `node citizens/audit/season_end.mjs --ai-dir D`) runs when `STATE/season-end.json` exists (the registrar's
`publish` writes it) and writes `PUB/full/`:

- `requests/<decision>.json` the exact llama body; a body that holds the text of a redacted message becomes `{redacted:true, request_hash}` (excluded from M9, counted `m9_excluded_redacted`);
- `decisions/<decision>.json` situation, candidates with the mind's refs, cited-episode texts, intended sends, the signed-ready social output, `focus` when the service stored one (model decisions, sealed records and any record with social items);
- `open/<decision>.json` the opening of every sealed record whose release did not happen (`records.markOpened` was never called);
- `social.json` one row per accepted social record: inner, type, wallet, bell, origin, decision_id, item and the routing fields (channel, target, kind, ref), **never the text**; a redacted record keeps its routing fields so its episode can still be replayed by id;
- `memory/<tag>/ledger.json` and `summaries.json` (the model-written summaries, labelled "shown, never replayed");
- `index.json` the manifest: every file with its sha256, the released and unreleased lists.

It runs inside the citizens service's permission sandbox (test: `citizens-audit-permission.test.mjs`, the flags of `mind/permissions.mjs`, Node 20.19.4: it reads
STATE and writes PUB/full, and a read of KEYS, the stack toml or `registrar.mjs` is `ERR_ACCESS_DENIED`).

## 2. What each check does (and what it needs)

- **M1** commitments: signature of the registrar; the file is the canonical JSON of its content; the commit memo (`anchors/commit.json`: the memo on chain has the text `wylls-ai/1 commit <season> <sha256 of the file>`, is signed by the registrar, its block time is before `/h/season` genesisTs); model sha256 against `--model`; `server.tree_sha256` against `--llama-dir`; `flags_sha256`; every code hash against **the committed git tree** (`git rev-parse <git_commit>:<path>` and blobs, so the audit does not depend on what is checked out): `mind_tree`, `memory_tree`, `page_tree`, `candidate_generator_tree`, `episodes_module_sha256`, `episode_kinds_sha256`, `serve_sha256`, `prompt_templates_sha256`, library and deck; the stack toml, citizens config (found among the committed `config/*.json` when not given), slots file (derived from `bot_seed` when not given), seat script and injection corpus; `slots_root`, every slot wallet from the bot seed, and the committed `rules` against the config.
- **M2** roster: signature; `commitments_sha256`, `program_id`, season, deck; the deal recomputed with AC2's `deal()` from the GENESIS_SEED record of `/h/events`, the committed deck and library, compared field by field (persona, creed variant, temperament with jitter, ambition, tag, name, label); the script-bot wallets from `bot_seed`; the seat.
- **M3** roots and openings: for every bell from the first to the last file: talk, minds and anchor files exist (`gap_*`), `inner = sha256(bytes || sig)` of each talk record, the social root and the minds root recomputed (and each record's id), the anchor file's roots, and the **anchor memo on chain** (text, signer, slot). Late files are checked against their bell. Council files: every ballot's bytes hash to an earlier ballot leaf, every `call_commit` opens (and is opened once `strike_bell + 2` has passed). **Sealed records**: the commit recomputed from the opening (`sha256(canonical{situation_hash, candidates_hash, choice, retrieved, public} || nonce16)`), `candidates_hash` against the opened candidates, `release_bell` unchanged, destinations against the public REVEAL, and the **timing**: due = the later of `release_bell` and the real arrival bell of the opened destinations, `release_bell + 6` when unrevealed; opened before it is due is `opened_early`, more than 2 bells after is `opened_late`; an opening found only in `PUB/full/open` (season end) is `opened_late` (the commitment still verifies, and the failure says so).
- **M7** coverage: for each AI the session key from `/h/me`, its whole history by `getSignaturesForAddress`, each transaction read with `getTransaction`; a transaction that the session key **signed** must be listed in exactly one record's `tx` (minds files and late files, one record counted once); every signature listed by a record must exist on chain.
- **M8** speech: every talk record (and every opened ballot) whose wallet is on the AI roster: origin 1, the signature verifies under the citizen's session key, it has a `(decision_id, item)` in `full/social.json`, none used twice, the decision belongs to that AI and is within 1 bell of the record's own bell, and the text, channel, target, kind and ref (a ballot: option and nonce) equal the decision's signed-ready output in `full/decisions`; a sealed decision must not have posted anything. 0 AI records is reported as vacuous.
- **M9** bit replay: 20 sampled model records; offline: the stored body hashes to `request_hash`, its seed is the pinned rule for (season, index, bell, kind, attempt), its sampling fields and alias are the committed ones; with `--llm` the llama-server's `/props` context size and alias are compared with the committed flags, the body is re-sent and `sha256(content)` must equal `output_hash`; the check fails when fewer than ceil(0.9 x compared) are equal (18 of 20) and lists every mismatch.
- **M11** episodes: section 3.

## 3. M11, the episode replay (5.7, R10, integ-A-NOTES 17)

Inputs are public only: `/h/events` (through the same `watcher/feed.mjs` and `owners.mjs` the live pump uses), `/h/province`, `/h/clash`, the talk and council files, `redactions.json`.

1. **Lists.** 3 AIs sampled by `sha256(last minds_root || i)`; `episodes_from_events` over every log bell up to the feed's complete-through bell (or `--through`), two passes so the open grievances exist for the `answered` deltas; the 200 cap by the store's own eviction; every redaction applied; compared with `PUB/memory/<tag>/episodes.json` in a **comparison form** (a redacted episode reduces to id, bell, kind, created_bell). The file's own `sha256` field must equal the hash of its episodes (an edited episode fails there), and the replayed list must equal the published one.
2. **Retrieval.** 20 sampled opened decisions (an unsealed model record, or a sealed one with its opening; kinds session, reaction, motion, ballot): `retrieve()` over the episodes with `created_bell < the decision's bell`, **the 200 cap applied as of that bell** (the 200 the eviction keeps among those episodes, not the cap of the final list: `listAsOf(..., {bellExclusive})`, tested with 205 episodes) and **the redactions replayed in order of their tombstone bell** (a tombstone at or before the decision's bell blanks the episode for that decision, a later one does not; `redactedAt`). The result must equal `retrieved`, or equal it after the budget cut of `renderMemory` (the oldest unprotected ids first; the 3 newest and an open grievance's source are protected; `explainRetrieved`; the cut is counted).
3. **Citations.** Every id in `choice.mem` of every published or opened decision is in its `retrieved` set (G13), not only the sample.

**What the replay cannot know, and what it does.** The focus extras (inbox sender tags, threat nations) are not stored with a record. The replay rebuilds the focus from the opened candidates, the situation, the AI's tag, nation and home, and tries up to four variants: base; base plus the threat nations from the wave-A watcher stub run over the replayed feed in the AI's own decision order; base plus the senders of messages addressed to the AI in the last 12 bells (only when the record's `inbox_root` is not the empty root); both. A record passes if one variant gives its `retrieved`. This is weaker than an exact recomputation and the check says so (`focus_derived` counted, a note). If the service stores `focus` in each private record (`priv.focus`), `season_end.mjs` already publishes it in `full/decisions/<id>.json` and the replay uses it as the only variant (`focus_source: "stored"`). Open grievances are derived from the replay's deltas; the `answered` time is the arrival bell, within a bell or two of the pump's, which matters only when an attacked_own episode exists (none in slice-4).

The check also compares the code it runs with the committed code: `audit_code_vs_committed` lists the audit-relevant files of the working tree that differ from the blobs of `code.git_commit`. On slice-4 three differ (`memory/names.json`, `memory/safe.mjs`, `mind/wiring.mjs`: later fixes) and the replay still matches; a mismatch with differing code would be inconclusive and the report shows it.

## 4. What was run, with real results

Mac load (`uptime`, 1/5/15 min) at the runs: 3.64/4.03/3.53 at 13:56 (first real run), 3.53/4.10/3.95 at 14:15 (final real run); the paused m1-exit stack and the desktop were running. No Gemma was started and no latency was measured (this unit has no model call). Ports used: 41994 (a localnet) and 41996 (a herald) for the real runs, both started from **copies** of the slice-4 data directories under the scratchpad, both stopped at the end (the original `.local/frontier/ai/slice-4` and `frontier-node/.local/frontier/slice-4` were only read; the season-end bundle was generated in a scratch copy).

### 4.1 verify-minds on the whole slice-4 artifact set (real)

Command: `node citizens/verify-minds.mjs --herald http://127.0.0.1:41996 --rpc http://127.0.0.1:41994 --ai-dir <copy of slice-4> --model <the gguf, sha from the registrar's cache>` after `node citizens/audit/season_end.mjs --ai-dir <copy>`. 0.75 s. Verdict **FAIL**, as expected for a run before the release job and before the R9 fixes. Nothing is hidden: each line is what the check printed.

| Check | Result | Why (all of it from the run, none from the check) |
|---|---|---|
| M1 | **FAIL**, 1 failure of 33 comparisons; `server.tree_sha256` null = unmeasured | `episode_kinds_sha256` committed `f136789e...` is the sha256 of the sorted **top-level keys** of `templates.en.json` (`items, kinds, lang, v, words`), the first definition; the registrar now hashes the keys of `kinds` (`6d139006...`). Everything else holds: signature, canonical file, commit memo (block time 1785542412, before genesis 1785630213), model sha256 (the pinned constant equals the gguf's sha256, but the run did not measure it), every code tree and file hash against `4b7a9b9`, stack, `slice.json`, slots, rules. |
| M2 | **PASS**, 12 | the deal recomputed from the GENESIS_SEED record equals the roster for the 6 AIs, the 30 script wallets, the seat, the signature |
| M3 | **FAIL**, 7 failures, all `opened_late` | all 85 bells (0 to 84): social and minds roots, record ids, anchor files and the 85 anchor memos on chain verify (0 gaps, 0 mismatches). The 7 sealed marches were never released (no release job in wave A): their openings exist only in the season-end bundle, every commit verifies against its opening and `candidates_hash`; the failure is that they were not opened when due |
| M7 | **FAIL**, 2 orphans of 146 session-signed transactions | 6 further session-signed transactions are FileTicket (tag 0x33) of onboarding, before each AI's first record, and are exempt (section 5, deviation 1; `--strict-onboarding` counts them: 8). The 2 orphans are a harvest (AI 9a01..., bell 26) and a train (AI 24e5..., bell 31): in the run's journal a later outcome **replaced** the earlier tx list of the record (the journal shows `[harvest]` then `[train, muster, muster]` for one id); the current `records.mjs` adds instead (comment in `attachOutcome`). 138 listed signatures, all on chain |
| M8 | **PASS, vacuous**, 0 records | the social service was a stub: no AI wrote a record. Reported as vacuous in the check |
| M9 | **FAIL** offline, 14 of 14; **not run** against llama (no `--llm`; this unit did not start llama-server) | every stored body hashes to its `request_hash`, but every seed follows the rule with **season 0**, not the committed season 41 (the service ran with the mind's default season: integ-A-NOTES section 2, correction b). All 14 match the rule with season 0, none with 41 (checked) |
| M11 | **PASS**, 404 comparisons | the 3 sampled AIs (f3f2..., daa1..., 9475...) replay to exactly the published lists (10, 8 and 12 episodes; 0 attacked_own, 0 dm); the retrieval of all 14 model decisions recomputes (the focus is derived: the wave-A watcher delivered no W-THREAT wake in this run (integ-A-NOTES section 3) and there was no inbox, so the base focus is the live one); every `mem` id of 387 records is in its retrieved set; replayed through bell 97 |

The same results, from the fixture and without the live herald, are pinned in `test/citizens-audit-slice4.test.mjs` (the herald and the chain answer from recorded files).

### 4.2 Tests

| Command | Result |
|---|---|
| `node --test test/citizens-audit-canon.test.mjs test/citizens-audit-slice4.test.mjs test/citizens-audit-mini.test.mjs test/citizens-audit-permission.test.mjs` | 73 tests, all pass (about 15 s) |
| `node --test test/citizens-*.test.mjs` (`nice -n 5`) | 604 tests, 604 pass, 0 fail (load 5.5/5.3/4.6 before, 7.9/5.9/4.9 after) |
| `cd permutation-gateway && npm test` (`nice -n 5`) | 1178 tests, 1178 pass, 0 fail, 41 s (integ-A part 3 had 1105; +73 are this unit's) |
| `ai-hook-check.sh --blank-ok -q` | PASS (no existing file was edited) |
| the G10 grep (`anthropic\|openai\|devnet\|http(s)://` other than loopback, over `permutation-gateway/citizens` without `bin` and `guards.mjs`) | empty |

Each check passes on a consistent fixture and fails on tampers (names of the tests in the files):

| Check | Passes on | Tampers that make it fail (each a test) |
|---|---|---|
| M1 | the mini run (the registrar's own `prepareCommitments` over a git repo of copies of real files) | forged registrar signature; a model file or llama tree that is not the committed one; a changed stack, citizens config; a memo whose text is not the file's hash; a commit not in the repository; a commit memo after genesis; `unmeasured` fields give null, never PASS |
| M2 | the real slice-4 run and the mini run | a changed deal field; a forged roster signature; a changed script-bot list; a changed genesis seed |
| M3 | the mini run (bells 16 to 72, 7 sealed records opened by a simulated release job at their due bells, REVEALs from the real log; a second build with a council, ballot and Strike Order) | a removed record; a changed anchor; a missing anchor or minds file; an anchor memo not on chain; an edited record; a forged signature or changed bytes of a talk record; an altered commit (choice, text, retrieved, nonce); altered candidates; a changed release bell; a wrong destination; a sealed record never opened, opened early, opened 3 bells late (2 late is allowed); a ballot whose bytes or leaf were changed; a call commit opened with another nonce or option |
| M7 | the mini run | a removed tx; one signature in two records; a listed signature not on chain; strict onboarding |
| M8 | the mini run (2 signed AI records: a world message and a ballot) | a text that is not the mind's output; a forged signature; origin 0; a decision of another AI; a ballot under the wrong decision; a missing provenance table |
| M9 | the mini run against a fake llama-server (15 of 15 equal) | 1 of 15 differing passes and is listed, 3 of 15 fail; an edited stored body; an unreachable llama; a llama with another context size or alias; a redacted body is excluded and counted |
| M11 | the real slice-4 run and the mini run | an edited episode (file hash not updated, and updated); an episode removed; an episode added; a `retrieved` set that is not what `retrieve()` gives; a `mem` id outside `retrieved` (unsealed and in a sealed opening); a DM missing from the memory; a redaction not applied to the memory file |

## 5. Deviations and interpretations (the contract wins; each is also in the report's `deviations`)

1. **M7 exempts onboarding.** Contract 7.3 requires every transaction signed by the AI's session key to be in a record's `tx`, and exempts joins (wallet-signed) and settles (relay-signed). A **FileTicket** (frontier-abi tag 0x33) is session-signed and is sent by the steps before the AI has a home holding, which make no mind call and leave no record (R5). slice-4 has 6 of them. I read "joins and settles" as the onboarding instructions Join 0x30, SetSession 0x31, SetVigil 0x32, FileTicket 0x33 **sent before the AI's first decision record** (reported as `onboarding_exempt` and in a note); `--strict-onboarding` removes the exemption. The architect should confirm this reading or ask the brain to record these transactions.
2. **M9 threshold.** 7.3 says "report n/20" and G8 says "18/20 equal"; the check passes when equal >= ceil(0.9 x compared), which is 18 for 20 and 14 for 15.
3. **M11 is not an exact retrieval replay** where the service stored no `focus`: see section 3 (variants, flagged `focus_derived`).
4. **Sampling encoding** is not pinned by the contract ("sha256(last minds_root || i)"): item j is `pool[u64_le(sha256(seed || u32_le(i))[0..8]) mod |pool|]`, i = 0, 1, ...; the pools are sorted (AIs by tag, decisions by bell, index, kind, id). The seed is the last published minds_root; if that is the empty root the sample is predictable (the contract's rule, not mine).
5. **`PUB/open/<bell>.json` shape** is not pinned by 7.2: the audit reads `{bell, records:[opened]}` (the shape of the minds file) with `destinations:[{host_id, p, q, tile, planned_arrive_bell, arrive_bell, source: "reveal"|"planned"|"unrevealed"}]`. `buildOpening(entry, {reveals})` in `season_end.mjs` produces exactly that from `records.getPrivate(id)`; AC6's release job should call it, then `records.markOpened(id)`, and write one file per bell. "Unrevealed" is read from a destination with `source: "unrevealed"` (or `destination: "unrevealed"`, or a null arrive bell).
6. **A season-end-only opening is `opened_late`**, not "opened". 7.3 PASS needs "0 mismatches, 0 gaps" and the openings are required "when due".
7. **The fixture is partly synthetic by design** (section 7): M1, the release timing of M3, M7, M8 and M9 can pass only on a consistent run, and the only recorded run is a pre-fix one. The mini run builds its commitments, roster, anchors, signatures and ids with the production code on a fake chain from the real decisions; the check that "passes on a recorded fixture" is real for M2 and M11 and built for the others, and the notes of the fixture and the builder say so.
8. `verify-minds` imports `registrar.mjs` (Rpc, signature and memo helpers, walletOf) and web modules (`faddr`, `identity`, `herald`); it runs outside the sandbox, like the registrar. `season_end.mjs` and `canon.mjs` import only node builtins and citizens/web files that are on the sandbox read list.

## 6. Final suites

Section 4.2 has the commands and numbers. One honest note: the **first** `npm test` run at 14:16 had one failure outside this unit, `citizens-mind-guards.test.mjs` "probe.mjs refuses any port outside 41901-41999" (it expects nothing to listen on 41999 and the probe exited 0 instead of 3), and a stray untracked `permutation-gateway/probe-result.json` appeared (written by that probe at 14:16, which means something answered on 41999 at that moment; I did not identify it, it was not a process of this unit (most likely another unit's fake llama-server); my tests bind 127.0.0.1:0 and my two real-run processes were on 41994 to 41996). I deleted the stray file and re-ran: the guards file alone 11 of 11, then `npm test` 1178 of 1178 and the citizens suite 604 of 604. That test is sensitive to other units' listeners on 41999.

## 7. What is real, derived and synthetic in the fixtures

See `test/fixtures/ai-audit-slice4/README.md` (recorded, real) and the header of `test/fixtures/ai-audit-mini.mjs` (consistent run: real decisions, episodes, herald log and prompts; commitments, roster, anchors, ids, commits and signatures re-issued by the production code with a fresh registrar key; fake chain, fake model and llama directory, a tiny git repo of real file copies, a stand-in llama output, 3 synthetic decisions with 2 signed social records and 1 council).

## 8. Open points and pending work

- **Wiring of the season-end publication** (not done, outside my files): `citizens/server.mjs` does not call `createAudit`. The integrator should call `createAudit({aiDir, reveals, sanitize}).watch()` in the service (it polls `STATE/season-end.json` and publishes once), passing the feed's REVEAL reader for the destinations and the mind's sanitiser for the redaction needles; or run `node --experimental-permission <flags> citizens/audit/season_end.mjs --ai-dir D` after the registrar's `publish`. Until then `PUB/full` exists only when run by hand (as in section 4).
- **The release job (AC6)** must call `buildOpening`, `records.markOpened` and write `PUB/open/<bell>.json` once per bell (section 5, item 5); until it exists M3 reports every sealed march as `opened_late`.
- **Persist `focus`** in each private record (`priv.focus`: the exact focus set of the retrieval, an array) so that the M11 retrieval replay is exact. AC1a's `api.mjs` is the place; it is not edited here.
- **Run script / report**: the end of run should run `verify-minds` (M9 needs `--llm` on the pinned llama-server, which this unit did not start) and the report (AC9) may read `PUB/verify-minds.json`. For a non-smoke run `--model` and `--llama-dir` make M1 measured; the slice-4 file has `server.tree_sha256: null`.
- **Redaction does not regenerate summaries and card relationships** that name the author (6.3): the season-end bundle copies the summaries as they are.
- **M7 and rotated sessions**: only the citizen's current session key (from `/h/me`) is read; a run in which an AI's session key rotated would show the earlier key's transactions as missing from the history and the signatures of its earlier records as `bad_signature` (M8). Not seen in slice-4.
- **M3 cannot check the time of a Strike Order's opening** (`S + 2`): the council file carries no publication time; only that it is opened once `S + 2` has passed.
- **Not run**: M9 against a real llama-server (no Gemma started), M1 `--llama-dir` against a real llama tree (slice-4's commitments have none), a run with social records, a council, `attacked_own` episodes or threat/inbox focus extras on a real run (all of those exist only in the synthetic mini run), the hook check and Rust (not touched).
