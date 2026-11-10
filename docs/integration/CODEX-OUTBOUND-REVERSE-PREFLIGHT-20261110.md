# Departure preflight, reverse geography and remaining failures

This local increment follows `637af732`. Public push remains pending and was
not retried. Existing development commits, worktrees and services were retained.

## Unsigned message and RPC observations

`fclient::unsigned_message_preflight::inspect` checks an already assembled
legacy Solana Message using caller-supplied public signer addresses and policy.
It validates the header before indexing, unique account keys, the exact ordered
signer list including the payer, instruction indices, lock/write limits and the
1232-byte packet limit including reserved signature bytes. It does not construct
signatures, convert private proposals into public instructions or grant admission.

Blockhash checks bind the message hash to a nonzero observation, minimum context,
validity, expiry and required remaining block heights. These checks cannot prove
RPC authority or wallet authorization. `Report` always reports admission and
public dispatch unavailable.

`fclient::blockhash_preflight::read` connects this observation to bounded reads
through the existing loopback HTTP transport or the new read-only HTTPS
transport. It requests `getLatestBlockhash`, then
`isBlockhashValid` for that exact hash, then `getBlockHeight`. All three use
confirmed commitment and propagate observed `context.slot` as the next request's
`minContextSlot`. Missing/stale contexts, noncanonical/zero hashes, missing expiry
and wrong field types are errors, never zero-valued defaults. The response cap is
16 KiB and the whole read has a five-second timeout. The three reads are explicitly
not a coherent snapshot; getBlockHeight has no context envelope, so the returned
height floor records only what was requested. Invalid/expired observations are
passed to the pure message inspector for rejection.

The three blockhash integration tests start only ephemeral loopback HTTP servers
with literal public JSON. They exercise the actual RpcClient envelope parser,
wire requests and context propagation, and then the unsigned message inspector.
The first sandbox run could compile but could not bind its temporary listener;
the same selected test target passed with loopback access. No existing service,
external RPC, wallet, transaction or chain was involved in those three tests.

`fclient::readonly_https_rpc` supplies the missing HTTPS POST connection without
changing the generic RpcClient or any send path. Only seven public read methods
are allowlisted. The process receives bounded public JSON through stdin and
requires HTTPS, verified certificates, TLS 1.2 or newer, no redirects, no curlrc,
no netrc and no inherited proxy. Strict URLs reject userinfo/query/escape forms;
authenticated provider URLs are not supported. Error messages omit remote text,
URL and stderr. The request is streamed through a 16 KiB writer rather than
duplicating the parameter tree; responses have a caller-selected cap of at most
1 MiB (16 KiB for blockhash reads). RPC version, exact response ID and exclusive
result/error envelope are required. Existing generic HTTPS send remains closed.

Cancellation signals a worker to kill and reap curl before joining the pipe
workers; both the process and monitor have five-second deadlines. Cancellation
is cooperative at a 10 ms polling interval, with OS scheduling delays possible.
The outer blockhash timeout also covers worker queue time. The host's PATH curl
and configured CA trust store remain trusted. Five process-free tests cover
methods, streamed size boundaries, URL/argument policy, TLS/envelope rejection,
bounded output and cancellation before process creation. A running-process
cancellation/timeout was reviewed but not exercised with a TLS fixture.

An additional explicitly selected ignored test successfully called the real
public `https://api.devnet.solana.com` endpoint over HTTPS. It performed only
getLatestBlockhash/isBlockhashValid/getBlockHeight, with no wallet/account data,
simulation, transaction submission or airdrop. Observed values were latest and
validity context slot **520575588**, block height **507715841**, last valid height
**507715990**, and remaining height margin **149**. These public observations
passed the unsigned-message check with `admitted: false`. This proves the new
read connection worked at that time; it does not prove a deployed WYLLS program,
an atomic snapshot or gameplay execution. The test stays ignored by default.

## Reverse path arithmetic

`fexpedition-reverse.mjs::evaluateOriginalReverseRoute` calculates a boundary
path from an original host standing in wide territory into original territory.
It keeps the full original issuing identity separate from the current standing
tile. It requires explicit unit/faction/Holding facts and exact original/wide
land bytes; it does not fabricate an outbound source or treat absent terrain as
passable. Existing road, rough terrain, cavalry, faction, watch, palisade and wear
rules determine travel time. Coordinates and timestamps retain integer precision.
Arrival timing is labelled a reference to existing Season lead rules.

Even successful arithmetic returns `status: incomplete`, `calculationComplete:
true` and `complete: false`. Reverse producer, ownership, arrival, snapshot
authority and public dispatch remain unresolved. No plaintext/seal, instruction,
account-role proposal, browser send or new UI claim is produced. The current
resident return UI remains the separately implemented disband/wait/reserve-credit
proposal; it is not reverse sealed travel.

Eight guarded Node tests cover the cross-boundary calculation, both mounted
units, terrain and watch rules, missing/forged land, full identity and standing
separation, unavailable ownership facts, exact large coordinates, arrival bounds
and i64 time precision/overflow. Both no-key guards were active.

## Runtime and Solana boundary

The private failure writer now applies existing Stays/Withdrew bad-seal reward
and pending-forfeiture rules, including absent/busy no-op behavior, escrow and
marker release, settled-bit update and bridge rent return. This has a separate
closed v2 command and receipt, preserving destroyed-member v1 behavior. Six
selected ABI/native tests passed; see the
[failure-v2 record](CODEX-EXPEDITION-FORFEIT-RUNTIME-20261110.md).

The pairing FFI now bounds counts before conversion/multiplication and preserves
the caller's output on failure. Three host boundary tests passed and the single
native verification target compiled without running. This is not Solana execution;
see the [crypto boundary record](CODEX-SOLANA-CRYPTO-BOUNDARY-20261110.md).

## Existing service observations

Read-only process/listener inspection found two older stacks in different
worktrees, labelled `ui-1102b` and `mix-1`. Relay/herald Season GETs and RPC
`getVersion`/`getAccountInfo` reads produced:

| RPC loopback port | Season | Read context slot | Layout | programVersion | Status |
| --- | ---: | ---: | ---: | ---: | --- |
| 41910 | 1103 | 67089 | 2 | 4 | Ended (4) |
| 41510 | 1109 | 15206 | 2 | 4 | Ended (4) |

Both Season account owners matched their observed program IDs and were not
executable. Both version responses reported solana-core 3.1.9 and localnet
0.1.0/LiteSVM 0.16.0. This is public read-only RPC evidence, not authenticated
chain provenance or evidence that the current wide code is running. No process
was started, stopped or repointed and no service state was changed.

## Remaining conditions

The original game still cannot execute wide departure/return. Public instruction
allocation/admission and relay/browser submission are closed. Reverse transit
production and original-destination arrival handling are absent. Nonmember,
retained-slot and previous-generation failure cases, complete producer history
and generic failure-v2 indexing remain incomplete. Program deployment/ProgramData,
funding/rent, transit-slot races and actual runtime transaction constraints still
need end-to-end validation. Wide builds remain host-only; no SBF, chain start,
deployment, key generation/derivation/signing, new valid seal, CI or push was run.

## Selected validation

This increment has **30 distinct selected passing tests**:

| Scope | Passed |
| --- | ---: |
| Reverse geography and reference timing, guarded Node | 8 |
| Forfeit v2 ABI/native plus existing destroyed-v1 regressions | 6 |
| Pairing input boundary, linked host stubs | 3 |
| Unsigned legacy message inspection | 4 |
| Blockhash loopback RPC/inspection integration | 3 |
| Read-only HTTPS pure/worker-boundary tests | 5 |
| Explicit public devnet HTTPS blockhash read | 1 |

Rust checks used installed Rust 1.95, native arm64, offline/locked cached
dependencies, two build jobs and incremental compilation disabled. Only the
named key-free targets/cases were executed; no broad suite or CI was invoked.
The public devnet case was invoked explicitly with `--exact --ignored`;
`--offline` controls Cargo dependency resolution, not that test's public reads.
Independent runtime/transport reviews found no remaining concrete defect.
`git diff --check` passed, and the changed-file credential-pattern scan found no
matches. Unrelated `.rs.txt` work remained untouched and excluded from staging.
