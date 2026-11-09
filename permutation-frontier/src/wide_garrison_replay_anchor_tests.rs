//! Public receipt anchors for the independent verifier. Existing immutable
//! economy fixtures are read as literal pre-state, never regenerated.
//! Direct dispatch, no lifecycle helper, file export, signing or rollback.
use super::*;
mod anchors {
    include!("../../frontier-node/crates/verify/tests/fixtures/wide_garrison_receipts.rs");
}

fn anchor_accounts() -> Vec<AccountInfo<'static>> {
    let sd = include_bytes!(
        "../../frontier-node/crates/verify/tests/fixtures/wide_economy/train/season.bin"
    )
    .to_vec();
    let cd = include_bytes!(
        "../../frontier-node/crates/verify/tests/fixtures/wide_economy/train/citizen_post.bin"
    )
    .to_vec();
    let hd = include_bytes!(
        "../../frontier-node/crates/verify/tests/fixtures/wide_economy/train/holding_post.bin"
    )
    .to_vec();
    let mut pd = include_bytes!(
        "../../frontier-node/crates/verify/tests/fixtures/wide_economy/train/province_post.bin"
    )
    .to_vec();
    put(&mut pd, PV::RESOLVED_NEXT, &723u32.to_le_bytes());
    let h = WideHolding::read(&hd).unwrap();
    let id = Ro(&sd).u64(S::SEASON_ID).unwrap();
    let bump = Ro(&sd).u8(S::BUMP).unwrap();
    let sk = crate::addr::season_pda(id, bump, &PROGRAM);
    let ctx = crate::addr::ctx(&sk, &PROGRAM);
    let actor = Ro(&cd).arr::<32>(C::WALLET).unwrap();
    let account = |key, bytes, writable| info(leak(key, PROGRAM, bytes, 0, BIG), false, writable);
    at_bell(723);
    vec![
        wallet(actor, true, false, 0),
        wallet(PAYER, true, true, BIG),
        account(sk, sd, false),
        account(h.owner_citizen, cd, true),
        account(wh::holding_address(&ctx, h.coord, h.site), hd, true),
        account(wl::province_address(&ctx, h.coord), pd, true),
    ]
}

#[test]
fn actual_dispatch_pins_independent_replay_receipts() {
    let _g = begin();
    for case in [
        "base",
        "merge",
        "settle",
        "finality",
        "surviving_slot",
        "due_clamp",
    ] {
        let a = anchor_accounts();
        let h = WideHolding::read(&a[4].try_borrow_data().unwrap()).unwrap();
        let so = PV::site(h.site as usize);
        if case == "merge" {
            exec(&a, &data(5)).unwrap();
        } else if case == "settle" {
            let mut pd = a[5].try_borrow_mut_data().unwrap();
            put(&mut pd, so + SM::GARRISON, &1000u32.to_le_bytes());
            put(&mut pd, so + SM::PEND0_BELL, &722u32.to_le_bytes());
            put(&mut pd, so + SM::PEND0_DELTA, &2000i64.to_le_bytes());
            put(&mut pd, so + SM::PEND1_BELL, &721u32.to_le_bytes());
            put(&mut pd, so + SM::PEND1_DELTA, &3000i64.to_le_bytes());
        } else if case == "surviving_slot" || case == "due_clamp" {
            let mut pd = a[5].try_borrow_mut_data().unwrap();
            put(&mut pd, so + SM::GARRISON, &1000u32.to_le_bytes());
            put(&mut pd, so + SM::PEND0_BELL, &722u32.to_le_bytes());
            put(
                &mut pd,
                so + SM::PEND0_DELTA,
                &(if case == "due_clamp" {
                    i64::MIN
                } else {
                    2000i64
                })
                .to_le_bytes(),
            );
            put(&mut pd, so + SM::PEND1_BELL, &723u32.to_le_bytes());
            put(&mut pd, so + SM::PEND1_DELTA, &3000i64.to_le_bytes());
        } else if case == "finality" {
            let mut hd = a[4].try_borrow_mut_data().unwrap();
            hd[H::STATE] = H::STATE_PROVISIONAL;
            put(&mut hd, H::FINAL_TS, &(GENESIS + 723 * 600).to_le_bytes());
        }
        exec(&a, &data(if case == "merge" { 2 } else { 5 })).unwrap();
        let logs = WIDE_LOGS.lock().unwrap();
        let record = logs.last().unwrap();
        let hex: String = record.iter().map(|b| format!("{b:02x}")).collect();
        let expected = anchors::RECORDS
            .iter()
            .find(|(name, _)| *name == case)
            .unwrap()
            .1;
        assert_eq!(hex, expected, "public receipt changed for {case}");
    }
}
