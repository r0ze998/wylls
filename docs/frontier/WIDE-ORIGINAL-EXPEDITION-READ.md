# Scoped original-expedition observations

The opt-in `decode_transaction_with_expedition`, `WideIndex::open_with_expedition`
and `WideFindex::open_with_expedition` APIs accept the canonical private original
expedition codecs alongside the resident codec. Generic and resident-only APIs
keep their old admission semantics: kinds PS2/145–148 and PSW1/25 are refused.

- PS2/146 preserves Depart and SettleOrigin original address identities and exact
  ordered entity tails. Those original chain heads are retained, not verified.
- PS2/147 preserves Reveal/Gather identities and requires the exact zero-link tail.
- PS2/148 and PSW1/25 require exactly one matching original/wide pair per operation
  in the same committed transaction. Only the actual destination Province wide
  chain advances, in original record order, including subsequent kind26 records.
- PS2/145 pairs with its canonical conquest target. Wide conquest source19/23
  likewise requires one matching target18/21(LAPSE)/22. Declaration18 requires
  its debit source. A lone LAPSE21 or CAPTURE22 is a valid unverified observation:
  canonical absent/stale-source burn paths emit no credit source. Duplicate or
  conflicting operation records still fail. FAILED21, Resolve20, TableClosed24 and PSWC remain
  single observations. Shape and receipt pairing do not prove that a source was
  a member of an authenticated target manifest.
- Failed transactions and failed CPI subtrees contribute no records or pairs.
  Index batch failures roll back and latch a persistent blocker.

The cache schema is now4. Its program, world, season and expedition mode are
pinned. Old caches are never silently migrated or reinterpreted; retain the
archive and explicitly rebuild a separate compatible cache.

Herald preserves raw bodies and original full references with `holding:null`.
`province` is the actual source origin or destination carried in the receipt.
Kind145's source reference may be a sequence-zero holding reference; it is not
converted into an invented resident host. Gather has no host. PSWC has no
Province, Holding, host or event kind: its `kind` is null and `action` is7.
Source/receipt/original-chain verification is explicitly unverified. These APIs
provide no signing, economic replay, keeper authorization or account provenance.

The immutable `original_boundary_v1.bin` native log fixture is14638 bytes,
SHA-256 `48e97269e39672bee2f19b7c692a8dca95b608f050c45e2e932922b4de9e47d5`.
Tests decode the supplied logs and wrap them with asserted frame/archive metadata;
they do not execute transactions or authenticate the log source. The trace covers
146/147/148+25,145+18/22,20 and149+26, not every optional conquest outcome.
