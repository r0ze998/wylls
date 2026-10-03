# PT-B: the tester path (friends' playtest, local chain, behind a Cloudflare quick tunnel)

Unit PT-B of the friends' playtest (branch `frontier/playtest`). Scope: a friend who is **not a developer** receives an invite link and, a few minutes later, is playing. Local test chain only, no money, no devnet, no tunnel started by anything here (every rehearsal uses `127.0.0.1` and a local stand-in for the tunnel). This note is what was found, what was changed, how it was checked, what could not be checked, and the requests for the other sessions.

Contents: 1 the Depart 409, 2 how a friend gets a key, 3 the invite flow and its pages, 4 exposure of the public herald, 5 the activity record and the metric definitions, 6 what is not verified, 7 requests, 8 how to rerun everything.

## 1. The 2026-10-01 Depart refusal (HTTP 409 "This province has not resolved the previous bells yet")

**What the message is.** The relay simulates every Depart before it signs. The program refuses a resident action (Depart, Muster, Garrison, Dissolve, Explore, Build) with `NotResident` (code 26, relay status 409) when the player's own province is not resolved through the bell before the current one (`resolved_next + 1 < now_bell`). The page's string for it is the one in the log.

**Cause, in three parts (none of them is a bug in the program):**

1. *A quiet province lags by design.* The keeper skips quiet provinces in batches of up to 24 bells; a province with a pending change rides a whole batch. Measured on the rehearsal stack at 20x: a player's home province was 6-22 bells behind a few minutes after the player stopped acting.
2. *A catch-up lasts one bell.* `POST /f/nudge` (the page sends one per bell while its province lags) makes the keeper resolve the province in about 3 s, but only through the bell before the current one. One bell later the province lags again (`resolved_next + 1 < bell`). The page decides from a view up to one poll (10 s; 60 s when hidden) old, so an action sent around a bell boundary, or just after a poll, can pass the page's own check and be refused by the relay. Muster, Garrison, Dissolve and Explore have a client retry after a catch-up (`CATCH_UP_RETRY`); **Depart has none** ("the march has its own path"), so the player sees the refusal and must press again.
3. *The recorder misread the next press.* `record-playflow.mjs` (frontier-demo-play, uncommitted, read-only for this unit) pressed Depart, got the refusal, waited 400 ms and pressed again. A march is sealed for 1-2 s before the page shows a "busy" notice, and the old refusal notice stays on screen meanwhile; `notice('Depart')` read the stale refusal as the answer, the recorder retried a second time, found the composer closed (the Depart had landed: the EN run's last screenshot shows "Departed." and a clash report for bell 32 in the player's own province) and waited the 1,200 s for a button that no longer existed. The summary's two `departRefusals` lines are the same stale notice read twice. This explains why the run "stalled" 20 minutes on a march that had already left. It is the recorder's race; the refusal itself was real (the console shows the 409s).

**Reproduced** (before the change) on a fresh rehearsal stack (20x, ports 41100-41139), deterministically: auto catch-up switched off in the page, wait until the chain's province lags 3 bells, make the page believe it is fresh (the stale-poll condition), press Depart:

```
[225.6s] click march-send
[225.9s] HTTP POST /gw/f/relay -> 409 {"error":"the transaction would fail: NotResident (26)","code":"NotResident","programCode":26,...
[226.2s] notice Depart {"cls":"notice error","text":"This province has not resolved the previous bells yet."}
```

**Fix (relay, `permutation-gateway/src/frontier/catchup.mjs`, wired in `routes/relay.mjs`).** When the simulation of a resident shape says `NotResident`, the relay reads the province account (the shape names it), nudges the keeper (`/v1/nudge`, the call the page makes), waits up to 8 s for `resolved_next + 1 >= bell`, and simulates once more. The refused first simulation charges nothing (as for any refusal); the quota is charged once for the one send. At most one catch-up per province at a time (concurrent actions share the wait), never more than once per 1.5 s per province, and nothing happens without a keeper link, for a province that is not behind (then the refusal is something else), or for a shape without a province. This fixes it for every client, Depart included, with no change to the game page.

**Verified after the change**, same deterministic condition, through the tunnel stand-in with a guest key:

```
[223.3s] chain lag {"bell":8,"nowBell":11}
[223.6s] click march-send
[226.2s] notice Depart {"cls":"notice ok","text":"出発しました"}     (relay log: "f/relay Depart: NotResident, province caught up by the keeper; simulating again")
```

Tests: `permutation-gateway/test/frontier-playtest-b.test.mjs` (retry after nudge, one send and one charge; no keeper / keeper refuses / not behind: the 409 stands and nothing is charged; shared nudge; gives up after `waitMs`).

**Not fixed here (other owners):** the recorder's stale-notice read (request R3), and the page's own `CATCH_UP_RETRY` lacking Depart (request R2, now only defence in depth).

## 2. A friend without a Solana wallet

**What the page needs today.** `permutation-server/web/frontier/` joins with a Wallet Standard wallet that supports `solana:signTransaction` (legacy transactions), `solana:signMessage` and the chain `solana:localnet`. The only wallet the page offers by itself is the **dev wallet**, and `controller.mjs` enables it only when the page is on a **loopback host** (`cfg.dev`) and the cluster is localnet. Behind a tunnel the page is on `*.trycloudflare.com`: no dev wallet. Phantom, Backpack and Solflare list mainnet, devnet and testnet and have no `solana:localnet` (and a wallet would be asked to sign for a chain that does not exist outside this Mac); a friend with an extension would still see "this network is not supported". So **without a built-in guest key nobody can play through the tunnel.**

**Mechanism (smallest that is safe; no file of the design session is edited).**

- `permutation-server/web/frontier/playtest/guestkey.mjs`: a Wallet Standard wallet named **"Guest key (test only)"**, chain `solana:localnet` only, Ed25519 key kept in `localStorage` (`ps-guest-key-v1` = seed and public half). It signs messages and transactions without asking, like the dev wallet. It holds nothing, works only on this test world, and is labelled test-only.
- `boot.mjs`: registers that wallet by the Wallet Standard's two events (either order works), sets the remembered wallet so the game reconnects silently (no "connect a wallet" step, no popups), and puts the invitation the friend arrived with into the join form's field (`FS.joinDraft.invite`).
- **How it reaches the game page without editing `index.html`:** the herald serves `frontier/index.html` with `<script type="module" src="/frontier/frontier/playtest/boot.mjs">` placed in front of the `app.mjs` tag (`--inject-script frontier/index.html=/frontier/frontier/playtest/boot.mjs`). The file on disk is untouched; other pages are untouched; a URL with anything but `[A-Za-z0-9/._-]` is refused. The CSP stays `script-src 'self'`.
- Safety: the key signs only what the page asks it to sign for the localnet game; it cannot move anything real (there is nothing real on this chain, and no other chain accepts it); the relay still checks every shape, signer and quota, and a Join still needs an invite. The key is the citizen's identity (the Citizen address is derived from it); the backup text says so.

**What a friend needs:** a current Chrome, Edge, Firefox or Safari 17+ (WebCrypto Ed25519: Chrome/Edge 137+, Firefox 129+, Safari 17+; the start page tests it and says "this browser cannot play"), `https` (the tunnel), site data allowed (no private window), and the same browser each time. No extension, no wallet app, no account.

**Limits to tell friends (the start page says them):**

- The key lives in this browser's site data. Clearing it, a private window, or another device means no village: the start page offers **Save key** (file or clipboard) and **I already have a key** (paste to restore). Restoring on a new origin (see next) is a normal flow.
- **A new tunnel URL is a new browser origin**: `localStorage` does not carry over, and the in-game key (derived from a wallet signature over a text that includes the site) is different. Keep **one** `cloudflared` process (and its URL) alive for the whole test. If the URL ever changes, friends open the new link, restore their guest key from the saved text, and the game asks them to "rebuild the in-game key" once (the game's own `SessionMismatch` flow).
- In-app browsers (LINE, Instagram, some mail apps) can drop site data when closed: say "open the link in Safari or Chrome".

Tests: `permutation-gateway/test/web-frontier-guestkey.test.mjs` (the game's own `wallet.mjs` accepts it for `solana:localnet` and refuses it for mainnet; connect, signMessage, signTransaction verified; both handshake orders; backup round trip), `permutation-gateway/test/web-frontier-session.test.mjs` unchanged and green.

## 3. Invite redemption and the pages a friend reads

**The link:** `https://<tunnel host>/#<invite code>` (also `https://<tunnel host>/frontier/frontier/playtest/#<code>`). The code is in the **fragment**: the browser never sends it to the tunnel or the herald and it is not in any URL log; the start page removes it from the address bar after reading it. The fragment survives the `/` to start-page redirect (checked). `/` and `/frontier/` now lead to the start page (`--landing`).

**The start page** (`permutation-server/web/frontier/playtest/index.html`, `landing.mjs`, `playtest.css`, `config.json`; JA and EN, language from the browser, switchable, remembered in the game's own `ps-lang`; no inline script or style, no cookies, no third-party request): makes or finds the guest key, asks the herald `GET /h/me/<wallet>` (is this key already a citizen?) and the relay `POST /gw/f/invite-check` (new, public, per-address limited, consumes nothing), then shows one card:

| State | JA / EN title | Buttons |
|---|---|---|
| ok | 招待を確認しました / Your invitation works | Start |
| returning (key is already a citizen) | おかえりなさい / Welcome back | Continue |
| none (no invitation, no key) | 招待リンクが必要です / You need an invitation link | - |
| invalid or garbled | この招待は使えません / This invitation does not work | Check again |
| used | この招待はすでに使われています / This invitation was already used | (key restore below) |
| season not open yet | 世界はまだ開いていません / The world has not opened yet | Check again |
| join window closed | 新しい参加は締め切られました / New players are no longer accepted | - |
| season ended | このテストは終わりました / This test has ended | - |
| player cap reached | 定員に達しました / All the places are taken | - |
| host unreachable | いまゲームにつながりません / The game is not reachable right now | Check again |
| not https / old browser / storage blocked | https で開いてください / このブラウザでは遊べません / ブラウザが保存を許していません | - |

Under it: five plain sentences on what this is (a private test; no money or wallet; no name or e-mail, only a random player number and a record of what you did; same browser each time; the host's computer runs it) and the key box (save, copy, restore). `config.json` holds an optional `surveyUrl` (https only) shown in the footer: the survey is the owner's external form.

"Expired" is not a state: invitations have no expiry (an HMAC of a nonce); a late friend meets "join window closed" or "ended". "Season full" is the optional player cap `--max-players N` (relay flag / `FRONTIER_MAX_PLAYERS`, counts invites **redeemed, bots included**, so it must be bots + people; unset in `configs/playtest-1x.toml`): past it a Join is `403 SeasonFull` before any invite is looked at (a text for it is in `fi18n.mjs` and `lang/en-frontier.mjs`, JA and EN).

**Checked** (headless Chromium, 390 px wide, JA and EN, through the tunnel stand-in): `scripts/playtest/landing-states.mjs` (ok, used, invalid, garbled, none: right card, right buttons, fragment removed, no horizontal scroll), `scripts/playtest/returning.mjs` (join through the start page, close the browser, open the same profile the next "day" without an invitation: welcome back, the game knows wallet, in-game key and citizen with no wallet step and no key prompt; an empty profile with the used invitation is told so), `scripts/playtest/play-one.mjs --landing --emulate-tunnel` (the whole path invite to Depart with only the guest key, JA and EN).

## 4. Exposure of the public herald

**What is public:** exactly one origin, the herald (`127.0.0.1:41117` in `configs/playtest-1x.toml`), through the tunnel: `/frontier/*` (static game files), `/h/*` (public reads, `Access-Control-Allow-Origin: *`), `WS /h/ws`, and `/gw/*` which forwards only to the relay's **public** listener. Nothing else listens on a non-loopback address; the tunnel must point at that one port.

**Findings and changes**

| # | Finding | Result |
|---|---|---|
| E1 | Operator and internal surfaces (`/f/operator/*`, keeper `/v1/*`, localnet RPC, files) through `/h`, `/gw`, `/frontier` in every spelling tried (encoded dots, doubled slashes, case, trailing slash, query, 9 KB path, NUL) | 404/400/405 in all 34 probes; no operator or RPC body; the relay's public listener answers only its allow-list (`FRONTIER_PUBLIC_ROUTES`) |
| E2 | `@` in static paths was refused (tile art lives in `@0.5x/@1x/@2x/`): **every painted tile 404ed through the herald** (50+ 404s per page load; the map showed no tile art) | fixed in the herald (`@` allowed; `..`, hidden names, `%`-escapes still refused); tested |
| E3 | A non-RouteError on the public relay listener (RPC refusal, fetch failure) answered with its raw message (internal ports, paths) | public listener now answers `{"error":"internal error","code":"Internal"}` or the program error's name; the log keeps the cause; tested |
| E4 | Client address behind a tunnel | `client_ip`: peer must be loopback; then `CF-Connecting-IP` (Cloudflare sets it, replacing the browser's), else the **last** `X-Forwarded-For` entry (what the proxy nearest to us appended; the browser's own claim is earlier); anything else is the peer. The relay trusts XFF only from the herald's loopback peer and the herald sets it itself (`/gw` forwards only `Content-Type`). Varying the claimed address buys nothing (tested, live and unit) |
| E5 | No per-address limit on the herald (public reads, `/gw`, static) | token bucket per address (IPv6 by /64), default 100 requests/s sustained, bucket 1,500 (a cold page load is about 200 requests; two cold tabs from one address were 406 in 10 s and **429ed at the first bucket size of 300**, hence 1,500), 429 with `Retry-After`; loopback exempt (bots, viewers, operator); flags `--ip-rate --ip-burst` |
| E6 | WebSocket bounds | existing: 8,192 sockets, 64 KiB messages, unmasked or oversized frames close, slow readers dropped, silent sockets closed after 3 heartbeats; **added**: per-address cap (default 6, 429 beyond; slot freed on close), `--ws-per-ip`, `--ws-max`; WebSocket under the page CSP works through the tunnel stand-in |
| E7 | Relay quotas and drain guard under abuse | existing guards hold: junk Joins/relays from one address 400 then 429 (join bucket 10, 0.2/s; relay 40, 2/s; nudge 10, 1/s; invite-check 10, 0.5/s); a citizen hammering 150 Harvests through the page: 25 sent, 11 `429 RateLimited`, 5 `409 Duplicate`, the daily quota fell 40 to 14 (nothing refused is charged); drain guard (fee payer may lose at most fee plus the kind's allowance) unchanged and covered by `frontier-relay.test.mjs`; junk bodies never reach a simulation (`chain.simulated == 0` in the abuse test) |
| E8 | Headers and CORS | every answer: `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, CSP (`script-src 'self'` for pages, `default-src 'none'` elsewhere); no `Server` / `X-Powered-By`; CORS `*` only on `/h/*` (public data); a cross-origin preflight or POST to `/gw` gets no grant |
| E9 | Slow clients | 150 half-written requests open: a normal request still answered in under 2 s; slowloris beyond that is the tunnel's to absorb (not testable here) |
| E10 | The start page and boot script under the CSP | no inline script/style; same-origin modules only |

The scripted check is `scripts/playtest/abuse-check.mjs` (94 checks; it floods a loopback herald only, uses TEST-NET addresses and junk bodies, sends no Join and no relayed transaction). Last run: 94/94 on the rehearsal stack. Rust: `crates/herald/tests/playtest.rs` (injection, landing, `@` art, limits, address rules, sockets). Node: `frontier-playtest-b.test.mjs`.

**Operator checklist (not code):** point the tunnel at the herald port only (`cloudflared tunnel --url http://127.0.0.1:41117`); never at the relay (41115, 41116), the keepers, the localnet or the drand port; keep the herald and relay on loopback; the operator token stays in `relay/operator.token`.

## 5. The per-citizen activity record

PT-A's relay event log (`relay/relay-events.jsonl`, mode 0600, local) gets two more kinds of line, still pseudonymous (a Citizen address, never an IP, a name or an e-mail):

- `action {citizen, kind, signature}`: one per **sponsored transaction the relay sent** (Join excluded, it has its own line), `citizen: null` when the relay charged an address bucket instead of a citizen.
- `seen {citizen}`: the Citizen's page asked for its quota (the herald's `/h/me` does this on every page poll), written at most once per 5 minutes per citizen and only for a Citizen account that exists.
- `join` lines now also carry `citizen` (PT-A wrote `invite`, `wallet`, `signature`).

**Superseded by `scripts/playtest-metrics.mjs` (PT-C, rules of PT-E: a return is a deliberate action after a break of at least 12 hours; only `friends-*` labels count). `activity.mjs` keeps the calendar-day definition below, which a night start inflates and which counts automatic actions: do not quote its "returned".** `scripts/playtest/activity.mjs <relay-events.jsonl> [--exclude-labels bots] [--session-gap-min 30] [--json out.json]` turns the log into the numbers. **Definitions (literal):** *day* = calendar date in Japan (UTC+9) of the line's `t`; *person* = a citizen whose join used an invite from a batch whose label is not excluded (default `bots`; label a friends' batch `friends` when issuing); *joined* = persons with a `join` line; *active day* = a day with at least one `action` line (a signed, sponsored move); *visit day* = a day with an `action` or `seen` line; **returned** = a person with an active day later than the day of their join; *returned (visit)* the same with visit days (weaker: anyone can ask for any citizen's quota, so `seen` is advice, not proof); *session* = a run of that person's lines with no gap above 30 minutes (session starts per day are counted); *invited* = the sum of `count` of the non-excluded `invites_issued` lines (invitations made, not people told). It prints per JST day: joined, persons with an action, persons visiting, actions, session starts; plus median and maximum actions per person and how many never acted. With `--json` the citizen addresses are replaced by numbers. Test: `frontier-playtest-b.test.mjs` (JST boundary, bots excluded, session split, return rules).

What the log cannot show: people who opened the link and never joined; time spent (only that something happened); anything done through a keeper route (`/f/reveal`, `/f/nudge` are not logged); actions by anyone not going through the relay (none exist for players). Do not claim more than "N joined, M had a signed action on a later JST day".

## 6. Not verified (say so in any report)

- **A real Cloudflare quick tunnel was never started** (rule). Its header behaviour (`CF-Connecting-IP` / `X-Forwarded-For` as assumed above), WebSocket support, request-rate and timeout limits and its behaviour when the Mac sleeps or the process restarts are from documentation memory and the stand-in (`scripts/playtest/fake-tunnel.mjs`: https, throw-away certificate, appends the client address, loopback peer), not observed. First thing to do on the day: open the link from a phone on mobile data and look at `/h/status` and the relay log.
- Real phones: only headless Chromium (desktop; the start page at 390 px) was run. Safari, Firefox, in-app browsers, small Android devices: not run. WebCrypto Ed25519 support is checked by the page itself and by browser version numbers, not on devices.
- 1x timing: all rehearsals ran at 20x. The bell-boundary refusal gets rarer at 1x (a bell is 10 minutes against a 10-30 s poll) but is not impossible, and the relay catch-up is correct at any scale; the 8 s wait is wall-clock, not game time.
- The game's own cold-load size (about 2.2 MB of code, 5-10 MB of art per scale, no precompressed siblings) was not measured at the tunnel; Cloudflare compresses text on the fly [assumed].
- 30 concurrent friends: the herald and relay were exercised with 20 bots plus up to 4 scripted browsers, not with 30 people.

## 7. Requests

**Design session (files PT-B must not touch)**

- R1 (optional wording) `frontier/screens/join.mjs` `renderWallets`: when the only wallet offered is the guest key, the heading "Connect a wallet" and the sentence about installing a Solana wallet are confusing; the playtest reconnects the guest key silently so a friend normally never sees it. If it ever shows, a line such as "Press Guest key to play in this test" would help.
- R2 (defence in depth) `controller.mjs`: add `'Depart'` to `CATCH_UP_RETRY` (a Depart refused `NotResident` after the page's own check passed is sent once more after `catchUp()`); the relay now does this server-side, so the request is optional.
- R3 (recorder) `permutation-gateway/screens/demo/record-playflow.mjs` (`frontier-demo-play`, uncommitted): `notice()` must not accept a notice that was on screen before the press (compare with a snapshot taken before the click, or wait for the busy notice or a changed text first), and the Depart retry loop should stop when the composer has closed after a successful press. See section 1, part 3. `scripts/playtest/play-one.mjs` `settled()` shows a working version.
- R4 (information) PT-B added one entry each to `frontier/fi18n.mjs` (`SeasonFull`) and `lang/en-frontier.mjs` (neither is on the do-not-touch list); keep them when merging.
- R5 (information) The herald served none of the tile art (`@` directories) before this unit's fix; any preview that uses another server never showed this. After the fix a cold page load is about 200 requests; if the design session adds many more files per scale, tell PT-B (the per-address bucket is 1,500).

**Main session**

- M1 Add the tester flags to the real stack: `configs/playtest-1x.toml` now has `herald_args = "--inject-script frontier/index.html=/frontier/frontier/playtest/boot.mjs --landing /frontier/frontier/playtest/"` (done in this unit's commit; PT-A's file, one key). Check after `playtest-up.sh`: `curl -s <herald>/frontier/frontier/index.html | grep -c playtest/boot.mjs` prints 1 (if the page ever changes so the `app.mjs` tag is not found, the injection silently does nothing; `abuse-check.mjs` has the check).
- M2 Issue the friends' batch with a label (`scripts/playtest-invite.sh`, `{"count": N, "label": "friends"}`) so `activity.mjs` can tell people from bots; give each friend `https://<tunnel host>/#<code>`.
- M3 Keep one `cloudflared` process and URL for the whole test (section 2); announce the URL once; if it must change, tell friends to restore their key from the saved text.
- M4 Tell friends: open the link in Safari or Chrome (not an in-app browser), do not use a private window, press Start, **save the key** (button on the start page).
- M5 Set `--max-players` only as bots + people (relay flag); unset means the invites are the cap.
- M6 On the day, with the real tunnel: run `node scripts/playtest/abuse-check.mjs --herald http://127.0.0.1:41117` (loopback side) and open the public link from a phone on mobile data; confirm `/h/status` and the relay log show a **public** address as the client (the limits exempt loopback; if the tunnel sent no forwarded address, every friend would be exempt from the per-address limits).
- M7 The survey: `playtest/config.json` `surveyUrl` is empty; put the owner's https form there before inviting (no code change).

## 8. Rerun

```sh
# stack (rehearsal ports 41100-41139; gated, guest-key page, landing, 20 bots, 20x)
frontier-node/target/release/frontier-stack up --config frontier-node/configs/playtest-rehearsal.toml
node scripts/playtest/fake-tunnel.mjs --listen 41131 --herald 127.0.0.1:41110 --cert-dir <dir>   # https://wylls.test:41131 in the browser scripts
node scripts/playtest/landing-states.mjs --herald https://wylls.test:41131 --valid CODE --used CODE
node scripts/playtest/returning.mjs --herald https://wylls.test:41131 --invite CODE
node scripts/playtest/play-one.mjs --herald https://wylls.test:41131 --emulate-tunnel --landing --invite CODE --stale-depart
node scripts/playtest/abuse-check.mjs --herald http://127.0.0.1:41110
node scripts/playtest/page-load.mjs --herald https://wylls.test:41131 --seconds 60 --tabs 2
node scripts/playtest/activity.mjs frontier-node/.local/frontier/pt-rehearsal/relay/relay-events.jsonl
# tests
(cd permutation-gateway && node --test test/frontier-playtest-b.test.mjs test/web-frontier-guestkey.test.mjs test/frontier-relay.test.mjs test/web-frontier-errors.test.mjs)
(cd frontier-node && cargo test --offline --locked -p herald --test playtest --test server && cargo test --offline --locked -p stack --lib config)
```

Browser scripts need `scripts/playtest/node_modules` to be a symlink to a `permutation-gateway/screens/node_modules` that has `playwright-core` (ignored by git; no install is made).
