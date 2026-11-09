# Original-host expedition keeper review

Status: feature-gated, read-only and non-executable. No public original-host
resident Dissolve/Return instruction exists. This is not end-to-end deployment
or authorization to send transactions.

## Existing keeper integration

`keeper_core::wideexpedition` reuses the keeper's `wideduty::Scope`, `Reads`,
pinned deployment, and `widesnapshot` sealed response. Public entry points:

- `ReadPlan::new(scope, Selection)` derives ten canonical account keys.
- `plan(scope, Selection, reads)` returns observed bridge/resident state and a
  next prerequisite, or a precise refusal. It makes no I/O calls.
- `inspect(snapshot_source, scope, Selection, min_slot)` makes exactly one
  snapshot request for those keys plus Clock, without Rent, retries or repairs.
- `Keeper::review_original_expedition(selection, deployment, min_slot)` uses
  the existing keeper port and reads the engine's public gate/pending facts.
  It does not construct/start a keeper, initialize payers, enqueue a duty or
  modify its tick, status, feed guard or send gates.
- `Report::describe()` emits JSON with null `tag` and `instruction`, and always
  false `dispatch_available`, `admitted`, `signed`, `enqueued`, `automatic_send`
  and `completion_proven`.

`Selection` requires the full original `WideHostRef`, exact wide standing key,
and full departure Citizen account address. The Citizen is not a wallet key,
short owner tag, current captor or proof of provenance. The read set is Season,
original Holding, original home Province, wide standing Province, wide roster,
original Citizen and the four external owned bridge addresses. A public key
derivation never establishes that the underlying state was legitimately issued.

## Account-family and lifecycle checks

The canonical ABI `AccountResolver` chooses the original or wide address family
from the full key and rejects another world's identities. No shadow wide
Holding can receive the original host's reserve credit.

Open bridge observations validate every embedded transit occupancy, require
owned bridge v2, authenticate the selected marker/envelope pair and retain the
immutable full departure owner. A source capture does not redirect that owner.
Original Departure resolution/settlement, Reveal/Gather evidence, destroyed
origin settlement/cleanup evidence, and destination Resolve/settlement evidence
are distinct next prerequisites. If the original departure stood away from its
issuer, the home Province's resolved clock is not substituted for that origin.
This bounded read plan does not infer unobserved arrival or route history.

The resident path requires current source generation, a live original Holding,
issued sequence, exact owner, no open matching transit or retained selected
bridge, and no pending capture in the original home mirror. It verifies the
wide Province/roster pair and exact full host reference. It distinguishes:

1. Resident with no pending operation: owner Dissolve prerequisite, with
   current Citizen binding/faction and resident timing checks. Wallet/player
   authorization, player economic checks and execution remain unverified.
2. Voluntary Leave not yet departed or not resolved past its pending bell:
   Resolve prerequisite.
3. Departed voluntary Leave resolved past its pending bell: original-reserve
   return prerequisite, predicting whole units `troops_milli / 1000` and
   checking reserve overflow and event-chain capacity.

All four raw Leave payload fields must be zero. RetireHost/donor redirects are
not silently converted to voluntary returns. Missing resident/roster state
means history is needed; it never proves that a return already completed.

## Bounded resident receipt observation

`WideObserver::new` and public `observe_tx` remain fail-closed on resident
receipts. `WideObserver::new_with_resident` checks the configured Season/world
and enables dedicated same-transaction pair decoding. The existing explicit
`Keeper::enable_wide_observation` read-only hook selects this scoped constructor.

Only one receipt-only operation is accepted per transaction. Mixed ordinary
events, unpaired records, malformed frames and rollback effects are not
silently skipped. The canonical resident record ceiling is 405 bytes; the
ordinary wide-record ceiling remains 277 bytes. Existing aggregate/count caps,
the 4,096 chain-key cap, transaction fingerprint window and terminal Province
checks remain in force.

The observer advances the receipt's shared wide Province chain atomically, so
an ordinary Resolve between resident Dissolve and Return retains continuity.
It never creates a fake discovery host, wide Holding, march, arrival, return
event or departure proof. Only one latest paired receipt is retained, with
`resident_selection()` exposing its exact identity for a fresh account review.
Original-chain continuity, authenticated execution and completion are not
verified by this observer. A first non-genesis wide head remains an explicitly
unverified anchor, just as in the existing observer.

Status under `resident_receipts` labels the result `paired_only: true` and
`original_history_verified`, `source_authenticated`, `completion_proven`,
`dispatch_available`, `automatic_writes`: all false. The generic discovery
cursor may lag `last_seq_seen` because resident receipts are separate records.

## Remaining blockers

- Private original-host resident Dissolve/Return have no public wire dispatch.
  No fabricated executable tag or instruction is provided.
- Older private expedition receipts PS2/146 (Depart/SettleOrigin), PS2/147
  (producer operations), PS2/148 + PSW1/25 (settlement) remain unsupported by
  this keeper feed reader. A full historical replay containing them still
  blocks before reaching the resident tail. The new account inspector works
  independently from an explicit full selection; the observer is not advertised
  as genesis-to-return completion or a substitute for the dedicated verifier.
- Coherent snapshots establish one response context, not currency, trusted
  account provenance, previous history, wallet authorization or send admission.
- No production game UI/keeper send workflow, SBF execution or CI is certified
  by these focused tests.

## Focused verification

Cached Rust 1.95, locked and offline. Explicit `RUSTC`/`RUSTUP_TOOLCHAIN` pinning
was used because root-path dependencies otherwise selected the root's 1.89
toolchain. No dependency or lockfile changes.

- `keeper --features wide-world-experimental --test wide_expedition`: 16 passed.
  Public-address/storage fixtures only, plus canonical receipt-only log bytes.
  Covers family separation, original reserve prediction, capture/generation/
  issuance/owner refusals, all raw Leave redirect fields, full roster identity,
  owned bridge/v1/orphan behavior, destroyed-origin distinction, copied/edited
  snapshot seals, exact one-response/no-retry reads, same-chain ordinary Resolve,
  generic/mixed/unpaired/rollback refusal, atomic corrupt-head/closed-Province
  refusal, exact replay and the 4,096-key cap.
- Existing `keeper --features wide-world-experimental --test wide_discovery`:
  14 passed, including the unchanged generic guards, replay, source/world,
  rollback, bounds and terminal-evidence behavior.

Only these isolated test binaries were run. Their runtime imports and selected
host build closure were audited before execution. No `Keeper::new`, keypair,
secret generation, private fixture, signing, transaction construction, daemon,
RPC write, SVM/SBF execution, broad suite or CI was run for this change.
