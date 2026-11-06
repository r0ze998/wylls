# NFT prize candidate: validation and handoff

Base: 6984acfa4c0f9919c8c424a9bd5f2d59193d1639. Local development only. No push, CI, signing, key generation, PDA/address derivation test run, SBF build, deployment, or external publication was performed.

## Implemented

Experimental NFT-specific PayResident / ClaimResident / RecordResidentNation, separate Entry and Merkle domain, current-owner/generation/policy/guard/link checks, and owner-bound token destination. Legacy wallet entries and refunds remain separate. SDK, relay, settlement and the existing selected-NFT prize screen are connected. Points remain exact u64; stale async responses are invalidated by wallet/pass epoch and generation; unknown or expired sends never become proof of failure.

## Checks actually performed

- Final pure page/model tests: 8 passed, 0 skipped, using literal strings/objects/BigInts and the no-keys guard. Covers u64 bounds, account/pass epochs, generation changes, unknown outcomes, claim/refund presentation, and English text.
- Final changed JavaScript and new test files: node --check passed. Build script bash -n passed. git diff --check passed.
- Generated web prize SDK matches the client source byte-for-byte after its generated header.
- Earlier implementation stage: prize Rust lib tests 8 passed; reused resident_auth pure tests 2 passed. These do not derive addresses or keys.
- Earlier stage: prize cargo check and clippy passed; the new NFT host test compiled after its borrow-check errors were fixed. Host test functions were NOT executed.
- Final combined Rust revalidation was rejected before execution because feature-enabled Rust test/check execution was considered potentially to invoke prohibited key/address derivation. It was not bypassed or retried. Consequently the final destination-account check and later Rust fixture additions have not been recompiled or rerun after that change.

## Not verified

The 9 host dispatch scenarios and SDK address/message tests derive public addresses and remain unexecuted. Existing gateway route tests create/sign keys and remain unexecuted. No actual wallet interaction, browser transaction, chain, CPI/runtime limit, SBF, CU measurement or end-to-end integrated game proof has been obtained. Pure page tests are not transaction tests.

## Release blockers and retained limits

- NOT DEPLOYABLE: experimental feature stays off. NFT-paid entries cannot refund while refund ownership is undecided; settling to refund mode would retain these funds without an exit. Do not enable for real payments.
- Current continuous-world pools remain rejected by the existing prize program. No new prize-period economics were invented.
- A closed Citizen without a prior RecordResidentNation still cannot claim. Recorded nation or live Citizen is required. This pre-existing closure limitation is not a complete solution for all accrued rights.
- New owner token account must already exist; the relay does not create it.
- Provisional ABI tags 8/9/10 and errors 0x113–0x11A require integration reconciliation.
- No legacy wallet-to-NFT migration, cross-world asset/history transfer, or NFT refund assignment was decided.
- Controller/relay asynchronous transaction actions are source-reviewed but not executed. Conservative post-POST 4xx failures remain unknown pending state.

## Integration

Review this candidate independently before merging. Map work may also modify controller.mjs; preserve both changes and rerun permitted checks. Do not call this candidate production-ready or the complete 1–20 integration.
