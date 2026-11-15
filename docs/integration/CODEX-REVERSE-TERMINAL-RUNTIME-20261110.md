# Reverse terminal cleanup: native execution evidence, 2026-11-10

The private reverse terminal instruction closes the distinct 386-byte reverse
record under the **existing season-terminal rule**. It does not settle a live
march, judge its seal, pay gameplay rewards, return troops, or introduce a new
per-transit expiration policy. No public dispatcher is enabled.

## Contract and effects

`expedition_reverse_terminal_ix::DraftCommand` is an exact five-byte independent
wire (`ff 52 58 01 slot`, slot 0–3), excluded from ordinary and wide decoders.
Its four roles are Season readonly, original Holding position writable, reverse
record writable, and immutable reverse rent recipient writable. It is
permissionless, requires no caller-supplied outcome/plan, and rejects extra
accounts, executable accounts, incorrect mutability, duplicate keys and
cross-key shared AccountInfo storage.

`wide_expedition_reverse_terminal::execute_draft` re-reads all authoritative
state. The existing `wide::season_end` authorizes only:

- Aborted;
- Ended with current time at least `bell_start(end_bell) + 72 hours`;
- the canonical Closed Season tombstone.

A Running Season is insufficient regardless of how old the march is. Full
Season checks retain this build's ruleset/version requirements; tombstone
authentication uses the existing canonical tombstone checker.

The reverse record must be program-owned, decode strictly, match the requested
embedded slot, and occupy the canonical external address derived from its
strictly converted original host and original Holding. Its explicit original
destination, wide origin, full original owner and immutable rent recipient are
validated by the reverse transport codec. The recipient must match that stored
rent recipient, and arithmetic must not overflow.

For a present original Holding, its stored coordinates/site and the complete
reverse marker pair are checked. Current-generation records additionally require
full current-owner equality and actual host issuance (`seq < HOST_SEQ`). A
captured record instead requires the existing single capture-history flag,
`PREV_GEN` and `PREV_OWNER_TAG` consistency. The short previous-owner tag is never
used to reconstruct the original owner; that authority remains the full owner
retained by the reverse record and marker digest. Capture-cleared bond flags are
accepted through the authenticated current marker, with no second bond payout.

Effects are limited to clearing this one embedded marker, closing the external
record (zero lamports/length and System ownership), and crediting all its actual
lamports to its immutable rent recipient. Every other Holding byte, including
ESCROW, POOL_OWED, owner/capture history and original event chain, is unchanged;
its lamports are unchanged. An absent canonical Holding position is accepted
only after the same season-terminal checks, and is not mutated. A mismatching
present marker or a replay after external closure is refused.

All mutable buffers and balances are borrowed before the first effect. Resize
is performed only after deterministic authentication, receipt construction,
overflow checks and late-borrow checks have passed. The independent `PSRT/v1`
receipt commits the full ordered raw before/after manifests, command, program,
Season, time/slot, full host/owner, rent recipient/amount, captured status and
untouched escrow ledger. It does not advance an original or wide gameplay chain.

## Why Holding escrow is not paid here

The existing authority is `citizen::close_holding`, documented in its source as
closing the Holding **including escrow of unsettled transits** to `H::RENT_PAYER`.
Its `close_holding_sink` first calls `sweep_pool_owed`, then `emit_close`, then
`init::close_to` over the entire remaining Holding balance. It accepts the same
Ended-grace/Aborted/Closed-tombstone states. Consequently reverse cleanup does
not invent an owner refund or reconstruct historical fee/bond rates from a
tombstone: the unchanged Holding balance remains subject to that original rule.

`citizen::release_dormant` treats occupied experimental transit slots as live and
refuses release; the separately implemented reverse occupancy parser extends
that same guard to the distinct reverse marker. Thus a live reverse marker is
not a justification for a new Running-season release or rent-only expiry path.

The native test below executes original `citizen::close_holding` itself both
before and after reverse cleanup, using each call's actual runtime output as
the next input. With POOL_OWED 13 and ESCROW 37, the pool receives 13, the original
Holding rent payer receives all remaining Holding lamports including that 37,
and the separate external rent recipient receives only the external record's
lamports. No account-state replacement occurs between calls. Their combined
balance remains unchanged, and both records are closed at the end.

## Executed tests

Five individually selected `--exact` native tests passed, under prefix
`proc::wide::expedition_reverse_terminal::tests::`:

1. `reverse_terminal_wire_closes_rent_only_with_present_or_closed_original_holding`
2. `reverse_terminal_wire_requires_actual_end_grace_or_canonical_closed_tombstone`
3. `reverse_terminal_wire_refusals_are_inert_after_successful_native_writeback`
4. `reverse_terminal_captured_owner_remains_immutable_and_bad_history_refuses`
5. `actual_original_close_holding_pays_remaining_escrow_before_or_after_reverse_close`

These cover real resize/ownership/balance writeback, exact receipt recomputation
and tamper rejection, immutable recipients and original owner, Running/grace
boundary/tombstone address rejection, malformed wire/roles/markers, alias and
overflow refusals, present/absent Holding, replay, wrong captured history,
same-tag/full-owner mismatch, and early/shared late data/lamport borrow refusal
without partial writes. The captured-state test explicitly starts from a
literal captured prior state; it does not itself execute capture.

Configuration: Rust 1.95 direct binaries; target `aarch64-apple-darwin`;
`CARGO_INCREMENTAL=0`; `-j2 --offline --locked`; runtime-contract-tests manifest;
features `public-proof-tests,system-cpi-tests`; shared runtime target directory;
`--test-threads=1`. The terminal tests use the official native account serializer,
writeback and instruction balance checks, and explicitly reject CPI calls.

No keypair, secret derivation, signature, `recover_key`, valid seal, chain/SBF
execution, deployment, CI or push was used. The native tests do not prove wallet
authentication, historical capture provenance, production compute budgets,
live reverse final settlement, or complete original-screen gameplay.
