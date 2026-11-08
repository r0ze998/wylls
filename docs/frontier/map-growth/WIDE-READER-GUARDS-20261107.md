# Wide reader safety boundary (2026-11-07)

Base: 559bf553. This is not full wide-world ingestion or gameplay support.

The legacy PS2 log reader now rejects PSW1 emitted by the authenticated program frame as UnsupportedWideRecord instead of treating it as no events. Foreign frames remain ignored. Findex archives the raw transaction but poisons the index on unsupported parsing and will not advance coverage. Reader capability strict_ps2_v2_reject_psw1 refuses reuse of a nonempty v1 index, which might already have silently skipped wide logs. No old archive or index is deleted automatically; rebuilding must use a separate index and still refuses unsupported records.

Herald fixture mode labels /h/season sample=true and refuses both recorded-wide endpoints. The UI rejects fixture/sample/prototype/unknown or absent cluster identity as a real recorded-world source. This does not establish chain finality or trust in arbitrary server labels.

Validation on this tree: the dedicated fclient wide_log_boundary integration test 2/2, findex store_failure 7/7, pure JS web-frontier-wide-world 14/14, fclient/findex/herald library clippy with wide feature and warnings denied. No fclient full library tests, fixture generation, keypair operations or signatures ran. Tests use literal bytes; index tests use no Season/PDA. Rust library dependencies were compiled but their test suites were not run.

Remaining: keeper independent indices and herald Fold still count unsupported parsing alarms rather than implement PSW1. Their cursors/duties need explicit unsupported-state handling before wide dispatch is enabled. Actual WideProvince/Holding capture, dedicated wide ownership views, full-identity event readers and UI detail are separate work. Existing wide endpoint still adapts captured legacy provinces only. Failed raw transaction logs must not become successful receipts.
