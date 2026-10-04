# AC4 social layer: notes (wave A)

Branch `frontier/ai-ac4`, cut from `frontier/ai-integ` 73408a5. Contract v1.2 §6.1–§6.3, §6.5 steps 2–5 and 7, §6.8 item 2, §8.2. Local test chain only; nothing here ran against a chain, a herald stack, the mind, the brain or Gemma (see "Not run").

## What was built

| File | What it is |
|---|---|
| `permutation-server/web/frontier/council/aisocial.mjs` | Single source of the signed bytes (talk, ballot, call read): encode, strict decode, JSON views, motion `ref` and `seq` helpers, self-contained SHA-256, redactable leaves (`inner`, `leaf`, `node`), base58/base64/hex, and the signing guard (`signable`, `signRecord`). The reserved TAG is refused by name. No imports. |
| `permutation-gateway/citizens/social/book.mjs` | The record book: acceptance rules 1–5 of §6.2 (session via `/h/me`, ed25519, origin, provenance, bell skew, seq, text, per-wallet limits), per-bell files and roots, `inbox` and `list`, redaction, an append-only journal for restart. Also `defaultSanitize` (§4.6 steps 1–6, 5b). |
| `.../council.mjs` | The nation council store: `open` (the watcher hands in the options), motion and ballot windows, hidden ballots, tally, human-present rule, `seal` (nonce, `call_commit`), member read data, opening at S + 2, `setResult`, restart. |
| `.../routes.mjs` | `createSocial(...)` and the HTTP routes under `/f/ai/*` and `/gw/f/ai/*`; per-IP limits; `listen()` (loopback only, ports 41901–41999 or 0). |
| `.../merkle.mjs` | The `talk.mjs` tree rules with the redactable leaf. |
| `.../limits.mjs` | Constants of §6.2 rule 6, the IP token buckets (memory only), `clientIp`, the port rule. |
| `.../vectors.mjs` | Producer of `test/fixtures/ai-social-v1.json` (`--write`, `--check`). |
| `permutation-gateway/test/fixtures/ai-social-{v1.json,kit.mjs,perm-run.mjs,me-recorded.json}` | The vectors; the shared test kit; the script run under the permission model; one recorded `/h/me` answer (see "What ran"). |
| `permutation-gateway/test/citizens-social{,-book,-council,-merkle,-routes,-permission}.test.mjs` | The tests. The freshness test is in `citizens-social.test.mjs` (the name §6.1 gives). |

No existing file was edited. No manifest, lockfile, `.gitignore` or `DECISIONS.md` change. No Rust.

## Interface for the integrator (what AC1a, AC6, AC5 and `server.mjs` need)

`createSocial({herald, aiDir, roster, clock, provenance, config, season?, sanitize?, fixCall?, random?, now?}) → {routes, book, council, closeBell(b), memberCall(f, period?), subscribe(fn), tick()}`. It is exported from `citizens/social/routes.mjs` (§11.6 does not name the file; there is no `index.mjs` because that file is not in the AC4 row).

- `aiDir` is `AI_DIR`: files go to `pub/talk`, `pub/council`, the journals to `state/social/{records,council}.jsonl`. `aiDir: null` keeps everything in memory.
- `clock = {bell(): number|null, unix(): number}` (game bell and chain time in seconds).
- `herald`: an object with `me(wallet) → {ok, citizen, holdings}` (the `createHerald` client of `web/frontier/herald.mjs` has this shape) or a base URL (then that client is loaded lazily). The Citizen's `session`, `sessionExpiry`, `faction`, `citizenTag` and the Holdings' `state`/`finalTs` are read.
- `roster`: the §8.3 roster object or a function returning it; used fields `ai[].{wallet, tag, faction, name}`, `script.wallets`, `seat.{wallet, tag, faction, scripted}`, `season`.
- **`provenance`** (§6.2 rule 4, §11.6): a function `(decision_id, item, type) → expected|null` (sync or async) or `{provenance, consume}` (AC1a `createRecords`). `type` is `'talk'` (say and motion alike) or `'ballot'`. `expected` is the mind's signed-ready output in the §8.1 field names: talk `{bell, text, [channel, kind, ref, lang, seq, target, wallet, tag]}`, ballot `{bell, option, [period, faction, candidates_hash, nonce]}`; every field present is compared (`text` is required for talk, `option` for a ballot), plus the decision's bell within ±1 of the record's (`decision_bell`, else `bell`). The book also remembers consumed `(decision_id, item)` itself and calls `consume` when it exists. **AC1a must return this shape**; the pinned contract says only "the sanitised say text, the ballot option".
- **`sanitize`**: `(text, {untrusted, limit}) → string`. The built-in `defaultSanitize` follows §4.6; the integrator should pass AC1b's `mind/sanitize.mjs` so there is one sanitiser (its signature is not pinned; adapt in `server.mjs`).
- **Council period = `k`** in every record and route (`C0 = k·P + offset`). The watcher calls `council.open({faction, period: k, c0, candidates, candidates_hash?, options_hash?, eligible?, humans?})` at C0; no candidates means no council (returns null). `council.tick()` closes what is due (called by `GET /f/ai/council`, by `GET …/call`, and in the background by `closeBell`); the closer or the watcher should also call it every bell. When a Call is adopted, either pass `fixCall({faction, period, c0, option, kind, p, q, voters:{1:[wallets],2:[…],3:[…]}}) → {tile, invited}` (the watcher's `closeCall`; the voters are for the invited order of §6.5 step 6) or call `council.seal(f, k, {tile, invited})` yourself after the `council_closed` event. `invited` is at most 6 host ids (strings). At S + 2 `tick` writes `open`; the watcher gives the strike result with `council.setResult(f, k, result)`.
- `council.winner(f, k)` (who voted for which option) is internal for the watcher; never publish it and never hand it to a prompt. `memberCall(f, period?)` is for `memberView(f)`: the sealed Call of that nation only.
- `subscribe(fn)` events: `record`, `closed`, `council_open`, `motion`, `ballot`, `council_closed`, `call_sealed`, `call_opened`. None carries the tile, the nonce or the invited list.
- `closeBell(b) → {bell, root (hex), file (absolute), rel, count}` is synchronous. It also closes every earlier unclosed bell (an empty bell has the zero root and still gets a file, so every bell has an anchorable root).
- `routes.dispatch({method, path, query, headers, body, peer}) → {status, body}` (transport-free), `routes.handle(req, res)` (a `node:http` listener) and `routes.listen({port=41981, host='127.0.0.1'})` (refuses a non-loopback host and any port outside 41901–41999; 0 is for tests).
- **Permission model.** The service runs under `--experimental-permission` with read access to `citizens/social`, `web/frontier/council`, `web/frontier/people`, `web/lang.mjs`, `web/util.mjs`, `web/lang/` and `AI_DIR/{pub,state}`, write access to `AI_DIR/{pub,state}` (test `citizens-social-permission.test.mjs`). With a base-URL herald it also loads `web/frontier/{herald,fcodec,abi}.mjs` and `web/sdk/{bytes,base58}.mjs`; add them to the pinned list if `server.mjs` passes a URL (an injected `createHerald` client needs the same files, imported by `server.mjs`). The Merkle rules are copied into `merkle.mjs` instead of importing `src/talk.mjs`, so `src/` need not be readable; a test asserts equality with `talk.mjs`.

## What ran (real results, Mac load recorded)

All on 2026-10-04 with `nice -n 5`; `uptime` just before the final runs: load averages 2.37 2.69 2.71.

| Command | Result |
|---|---|
| `cd permutation-gateway && node --test test/citizens-*.test.mjs` | 51 tests, 51 pass, 0 fail (the six AC4 files) |
| `cd permutation-gateway && npm test` | 625 tests, 625 pass, 0 fail, 23 s (the existing suites plus the AC4 files) |
| `node permutation-gateway/citizens/social/vectors.mjs --check` | `ai-social-v1.json is fresh` |
| permission-model run (`citizens-social-permission.test.mjs`) | the service starts, writes `pub/talk`, `pub/council` and `state/social`; reading `AI_DIR/keys` or the repository `Cargo.toml` and writing `AI_DIR/keys` or `AI_DIR/outside.json` gave `ERR_ACCESS_DENIED` |

What the tests establish, by the AC4 row: byte vectors with producer and freshness checker (6 talk, 3 ballot, 2 call-read vectors, 7 refused byte strings, Merkle examples n = 0..6, SHA-256 and base58 against `node:crypto` and `bs58`); signatures and the session against a fake `/h/me` (bad signature, expired session at and before the boundary, no session, not joined, herald down is 503, a replaced key after a refetch); seq; the ±1 bell skew and filing under the acceptance bell; limits (3 per bell, 40 per game day, per IP 20/1 s and 40/4 s with `X-Forwarded-For` trusted only from a loopback peer, the last entry, loopback clients exempt); IPs memory-only (no file under `AI_DIR` contains the test address); provenance (origin 1, decision id and item, signed-ready text, ±1 bell, single use, sync and async, `consume` called); ballot leaves only until the open, then bytes hash to the earlier leaf; tally (ties, none, quorum, tie with none), the human-present rule (and its scope: nation 2 with AIs only adopts), the scripted seat ballot counted as scripted; member read refuses non-members, bad signatures, stale stamps, a third read in a bell; the open record at S + 2 with `call_commit` re-derived; restart restores records, ballots, closed periods, the seal and the opening; the Merkle tree equals `talk.mjs` for 0..17 leaves with every proof; `POST /f/ai/pact` (and `pacts`, `/gw/…`, `standings.json`) is 404 for every verb; no published or stored file contains pact wording.

Compatibility with the real herald: the `createHerald` client over HTTP decodes real Citizen and Holding bytes built from the ABI table, and one **recorded** `/h/me` answer (`ai-social-me-recorded.json`, captured by a read-only GET from the paused local run's herald on 2026-10-04: season 7, faction 1, one final Holding, a 32-byte session key; hosts, transits, slots, seals and quota were emptied, the Citizen and Holding bytes are untouched) decodes and gives `state 2` = final and the 16-hex tag. That is the only recorded input. Everything else uses synthetic citizens.

## Deviations and gap-fills (contract silent or ambiguous; flag for the integrator)

1. **Script bots may not POST.** `NotEligible` for any wallet on `roster.script.wallets`. §6.2 does not say; §6.5 says rule bots never vote and none talks. Script bots do make signed Call reads (members).
2. **Ballots have no `seq`** (§6.1 pins none); replay protection is one ballot per period. `seq` applies to talk only.
3. **Motions** must be nation-channel talk (`kind 1`, `target` = the sender's nation, option 1..3 and `≤` the number of options, `ref = k << 8 | option`); they count against the 3-per-bell talk limit like any talk.
4. **`tally_split`** maps `origin 0` to `human`, `1` to `ai`, `2` to `scripted`. A human's self-declared origin-1 ballot is therefore counted under `ai` there, although the badge still comes from the roster only. A separate count would add a key to a pinned shape.
5. **Eligibility default** (when the watcher gives no `eligible` set): citizen of the nation with a Holding whose `state == 2` or (`state == 1` and `finalTs ≤ chain now`). That over-approximates "final by rule" (§policy `final_by_rule` also needs the cohort closed). The watcher can fix the set exactly at C0 through `open({eligible})`.
6. **Eligible non-AI voters** (for the human-present rule) are named as: the roster seat (if it is in the nation and eligible; if the herald cannot be asked it counts as present, fail closed), `open({humans})`, and any non-AI wallet that cast a ballot or motion. A human who is eligible but has never posted and is not named by the watcher is invisible to the rule. In the hackathon runs only the seat is such a human.
7. **Call-read freshness:** `unix` must be within 600 s of chain time (`BellSkew`), a number the contract does not give; ≤ 2 reads per bell per wallet is as specified.
8. **Extra codes/statuses:** `HeraldUnavailable` 503 (the herald could not be asked), `NotFound` 404, `MethodNotAllowed` 405, a 413 `BadBytes` for a body over 8,192 bytes. A `NotSignable` code exists in the signing guard only.
9. **Not adopted:** the council file still gets `open: {adopted:false, tally, ballots:[{inner, bytes_b64, sig_b64}]}` at the close (§6.3: ballots are published at the close when no Call was adopted), plus `reason` (`quorum`, `tie`, `none_wins`, `human_present`).
10. **`current.json`** is `{v:1, nations:[{faction, period, adopted, S, call_commit}]}` (key `S` as §6.5 writes it); `strike_bell` is used everywhere else.
11. The Merkle code is a copy, not an import (permission model), with an equality test: the "reuse read-only" intent is kept by the test, not by the import.
12. **Redaction of the journal:** a tombstone blanks files, API output and memory, but `STATE/social/records.jsonl` still holds the raw record until STATE is purged (§6.8 item 4, 2026-10-31); on restart the tombstone is applied again.

## Open points for the integrator (not fixed here, outside the AC4 files)

- **Cache header conflict (§8.3 against §6.5).** `/h/ai/council/<k>-<f>.json` matches the pattern `<digits>-<digits>.json` that §8.3 serves as `immutable, max-age=31536000`, but the council file is rewritten up to six times per period (open, each motion, close, seal, opening, result). A browser that cached an early version would never refetch it. `serve.mjs` (AC5) should apply `immutable` only under `talk/`, `minds/`, `open/`, `anchors/` and give `council/` `max-age=2`, or the council files need a different name; the live state is also available from `GET /f/ai/council`, which is uncached. I did not change the contract or `serve.mjs`.
- `aisocial.mjs` view of u64: a number when ≤ 2^53−1, else a decimal string; AC7 and AC3b should treat both.
- The page (AC7) and `aisign.rs` (AC3b) read `ai-social-v1.json`; `fields.target` is a faction number (nation), a base58 wallet (direct) or null (world); `ref` and `season` are decimal strings.
- Domain separation in Rust (`ai_sign_domain.rs`) is AC3b's. The JS side asserts the same property with `VersionedMessage.deserialize` from `@solana/web3.js` for every vector (all throw).

## Not run, not claimed

- No live check: no stack, no herald started by this unit, no mind, no brain, no llama-server, no Gemma, no chain. The only network use was one read-only GET to the paused local herald (a recorded `/h/me`), and tests binding `127.0.0.1:0`.
- No Rust was touched, so no `cargo` command was run. `cargo fmt` and `clippy` are not installed in this toolchain and were not needed.
- No latency was measured.
- No claim about indistinguishability, human play, scale or devnet is made by this unit.
