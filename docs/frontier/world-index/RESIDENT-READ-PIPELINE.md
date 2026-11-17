# Provisional resident receipt observations

PS2/149 and PSW1/26 are private-candidate receipts, not activated public instructions.
Use `decode_transaction_with_resident` with the exact public program/season AddrCtx,
`WideIndex::open_with_resident`, or `WideFindex::open_with_resident` explicitly.
The ordinary typed decoder and legacy PS2 reader remain fail-closed for these kinds.
Every committed transaction must contain exactly one original and one matching wide
part per operation ID. Canonical identity, tag/family and payload pairing are checked
only after failed transaction/CPI logs are discarded. Pairing is not authorization,
source authenticity, account capture verification, or proof of gameplay effects.

The index attributes both parts to the full original-origin host and wide standing
Province. It does not invent a wide Holding or original hostcast. Only the wide part
advances the actual Province chain, with normal zero-origin gap/head/terminal checks;
a following normal Resolve must continue that head. Original Citizen/Holding PS2
links are retained raw but are not replayed or verified by this typed index. Earlier
boundary kinds may still be unsupported: this is not a complete lifecycle archive.

Herald emits raw `body_b64`, full `province` and `host`, null `holding`, and the names
`ORIGINAL_RESIDENT_DISSOLVE`, `ORIGINAL_RESIDENT_RETURN`,
`WIDE_ORIGINAL_RESIDENT_DISSOLVE`, `WIDE_ORIGINAL_RESIDENT_RETURN`.
Source coverage stays unknown and captures stay unverified. A page can split a pair;
a displayed part is an observation, not standalone evidence of the complete pair.

Cache schema 3 binds the writer's optional resident season. Schema 2 caches and a
mismatched writer opt-in are refused, never migrated or reset automatically. Retain
the original archive and old cache; explicitly build a separate schema 3 cache with
a compatible scoped reader. No real cache is deleted or rebuilt by these changes.
All tests use synthetic public wire bytes and disposable SQLite data, not signatures,
keypairs, RPC, chain execution, deployment, or public dispatch/send activation.
