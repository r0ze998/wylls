// Workstream 08: minimal reproductions of two season-end suspicions (11-season-end-suspicions.ja.md).
// Not a test of the shared suite: run.sh appends this block to a COPY of
// permutation-frontier/svm-tests/tests/caravan.rs (for its `Cast` helpers) in a directory outside
// the repository and runs it in LiteSVM against the test-beacon build. These tests PASS while the
// suspected behaviour is present; a fix would turn them red (that is their purpose).

mod repro {
    use super::*;
    use frontier_abi::layout::world::season as S;
    use permutation_frontier_svm_tests::ix::season::end_season;

    /// Sets the Season's stored `end_bell` (as host.rs's ArrivalBell test does).
    fn set_end_bell(k: &mut Cast, end: u32) {
        k.c.edit(&k.w.a.season, |d| {
            d[S::END_BELL..S::END_BELL + 4].copy_from_slice(&end.to_le_bytes())
        });
    }

    /// S1: a caravan sent in bell `end_bell - 1` whose walk crosses the
    /// start of `end_bell` lands; its slot holds bells >= end_bell, which
    /// no resolve may ever pass, so SettleCaravan is CaravanEarly for good
    /// (Running, Ended, and past end + 72 h), and its cargo and rent stay
    /// locked in the Caravan.
    #[test]
    fn repro_s1_caravan_crossing_end_bell_never_settles() {
        let mut k = Cast::new();
        expect_lands(k.build_vault(), "BuildVault");
        let end = B0 + 2;
        set_end_bell(&mut k, end);
        // Late in bell end_bell - 1: 4 steps x 180 s = 720 s cross end_bell's start.
        k.w.to_bell(&mut k.c, end - 1, 500);
        let x = k.send_args(0, [0, 100, 0, 0, 0, 30, 0, 0]);
        expect_lands(k.send(&x), "SendCaravan at end_bell - 1 (no end_bell guard)");
        let cv = k.caravan(0);
        let d = k.c.data(&cv);
        let last = u32_at(&d, CV::LAST_BELL);
        let arrive = i64_at(&d, CV::ARRIVE_TS);
        let id = caravan_id(k.a.citizen_tag(), 0);
        let (_, s) = slot_of(&k.c, &k.a.province, id).expect("a slot");
        eprintln!(
            "REPRO S1: end_bell={end} slot first_bell={} n={} last_bell={last} arrive_ts-end_ts={}",
            s.first_bell,
            s.n,
            arrive - k.w.bell_start(end)
        );
        assert!(last >= end, "the schedule crosses end_bell");
        // Every bell of the season resolved (the most any resolve can reach).
        k.w.set_resolved_next(&mut k.c, &k.a.province, end);
        k.c.set_time(arrive + 1);
        let keeper = k.c.funded(b"s1-keeper", 1);
        assert_cq(k.settle(cv, k.vault(), &keeper), Cq::CaravanEarly);
        // The resolve of bell end_bell is refused (SkipQuiet; GatherClash and
        // ResolveFromInputs share the same in_season guard).
        let dest = (k.a.p as i32, k.a.q as i32);
        let sk = k.w.skip_ix(dest, end, 1);
        let r = k.c.send(&[sk], &[&k.w.keeper]);
        assert_code(r, E::WrongStatus);
        // EndSeason, then SettleCaravan still early.
        let any = k.c.funded(b"w8-any", 1);
        expect_lands(k.c.send(&[end_season(&k.w.a, any.pubkey())], &[&any]), "EndSeason");
        assert_cq(k.settle(cv, k.vault(), &keeper), Cq::CaravanEarly);
        // Past end + 72 h (CloseProvince / CloseSeason time): still early.
        k.c.set_time(k.w.bell_start(end) + 72 * 3_600 + 1);
        assert_cq(k.settle(cv, k.vault(), &keeper), Cq::CaravanEarly);
        assert!(!k.c.is_absent(&cv), "the Caravan (cargo, fee, rent) stays");
        eprintln!(
            "REPRO S1: caravan lamports locked = {} (fee {} + rent)",
            k.c.lamports(&cv),
            CARAVAN_FEE
        );
        // Counterfactual: the only blocker is RESOLVED_NEXT <= last_bell.
        let mut f = k.c.fork();
        k.w.set_resolved_next(&mut f, &k.a.province, last + 1);
        let rent_to = k.a.wallet.pubkey();
        let ix = fx::settle_caravan(
            &k.w.a,
            keeper.pubkey(),
            cv,
            k.vault(),
            keeper.pubkey(),
            rent_to,
            &[(k.a.p, k.a.q)],
        );
        expect_lands(
            s1_send(&mut f, I2::SettleCaravan, ix, &[&keeper]),
            "SettleCaravan with a (crafted, unreachable) resolve past end_bell",
        );
    }

    /// The control: at `end_bell` itself SendCaravan is refused (player
    /// prologue `bell < end_bell`, WrongStatus).
    #[test]
    fn repro_s1_send_at_end_bell_refused() {
        let mut k = Cast::new();
        expect_lands(k.build_vault(), "BuildVault");
        let end = B0 + 2;
        set_end_bell(&mut k, end);
        k.w.to_bell(&mut k.c, end, 1);
        let x = k.send_args(0, [0, 100, 0, 0, 0, 0, 0, 0]);
        assert_code(k.send(&x), E::WrongStatus);
    }

    /// S2: a vault (empty or not) cannot be closed after end_bell: CloseVault
    /// is player-class (WrongStatus), in Running-after-end, Ended and past
    /// end + 72 h; the vault's rent stays with the program.
    #[test]
    fn repro_s2_vault_cannot_close_after_end() {
        let mut k = Cast::new();
        expect_lands(k.build_vault(), "BuildVault");
        let end = B0 + 2;
        set_end_bell(&mut k, end);
        let rent_to = k.a.wallet.pubkey();
        let close = |c: &mut Chain, k: &Cast| {
            let ix = fx::close_vault(&k.w.a, &k.a.player(), (k.a.p, k.a.q, k.vt), rent_to);
            s1_send(c, I2::CloseVault, ix, &[&k.a.wallet])
        };
        // Control: before end_bell the empty vault closes (on a fork).
        let mut f = k.c.fork();
        expect_lands(close(&mut f, &k), "CloseVault before end_bell");
        k.w.to_bell(&mut k.c, end, 1);
        let mut c = k.c.fork();
        assert_code(close(&mut c, &k), E::WrongStatus);
        let any = c.funded(b"w8-any2", 1);
        expect_lands(c.send(&[end_season(&k.w.a, any.pubkey())], &[&any]), "EndSeason");
        assert_code(close(&mut c, &k), E::WrongStatus);
        c.set_time(k.w.bell_start(end) + 72 * 3_600 + 1);
        assert_code(close(&mut c, &k), E::WrongStatus);
        assert!(!c.is_absent(&k.vault()));
        k.c = c;
        eprintln!("REPRO S2: vault lamports locked = {}", k.c.lamports(&k.vault()));
    }
}
