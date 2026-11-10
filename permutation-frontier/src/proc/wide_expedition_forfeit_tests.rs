//! Reuses only the invalid-public-ciphertext native harness. No new seal or
//! key recovery. Initial roster/fate bytes are declared public-state snapshots.
use super::*;
use frontier_abi::world_index::{expedition_forfeit_event as event2, expedition_forfeit_ix as ix2};

impl Input {
    fn forfeit(fate: u8) -> Self {
        let mut f = Self::fixture();
        let ctx = addr::ctx(&f.accounts[0].0.to_bytes(), &PROGRAM);
        let bridge = OwnedBridgeTransit::from_bytes(&ctx, f.accounts[2].1.data()).unwrap();
        let t = bridge.transit();
        let mut data = f.accounts[5].1.data().to_vec();
        let mut rec = WideArrival::read_at(&data, POSITION).unwrap().unwrap();
        rec.fate = fate;
        rec.troops_after = 12_345;
        rec.write_at(&mut data, POSITION).unwrap();
        f.accounts[5].1.set_data_from_slice(&data);
        let dest = t.dest.unwrap();
        let roster = WideRoster::new(11, dest, [90; 32]);
        let mut rd = vec![0; wro::wide_roster::SIZE];
        roster.write_header(&mut rd).unwrap();
        let alias = roster.claim(&mut rd, 0, &t.host).unwrap();
        let mut pd = f.accounts[4].1.data().to_vec();
        write_entry(
            &mut pd,
            0,
            &Entry {
                id: alias,
                faction: t.faction,
                unit: t.unit,
                tile: rec.tile,
                state: E::STATE_ROSTER,
                troops: rec.troops_after,
                stamina_value: rec.stamina,
                stamina_bell: t.arrive_bell,
                ready_bell: t.arrive_bell,
                from_bell: 1,
                dealt_bps: 250,
                ..Entry::FREE
            },
        )
        .unwrap();
        Rw(&mut pd).set_u8(PV::N_ENTRIES, 1).unwrap();
        f.accounts[4].1.set_data_from_slice(&pd);
        f.roles.push(InstructionAccount::new(
            f.accounts.len() as u16,
            false,
            false,
        ));
        f.accounts.push((
            Pubkey::new_from_array(wro::roster_address(&ctx, dest)),
            literal(Pubkey::new_from_array(PROGRAM), 1_000_000_000, &rd),
        ));
        f
    }
    fn forfeit_wire(&self) -> [u8; ix2::DRAFT_LEN] {
        ix2::DraftCommand::new(SLOT, self.commit, self.seal)
            .unwrap()
            .to_bytes()
    }
    fn settle_forfeit(&self) -> Vec<AccountSharedData> {
        self.run_with_data(&self.forfeit_wire(), |p, a, d| {
            crate::proc::wide::expedition_return::settle_forfeit_draft(p, a, d).map_err(Into::into)
        })
        .unwrap()
    }
}
fn observed_v2(
    f: &Input,
    out: &[AccountSharedData],
    hook: &Hook,
    forfeited: bool,
) -> event2::Receipt {
    let logs = hook.take();
    let log = logs.last().unwrap();
    assert_eq!(log[0], event2::PREFIX);
    let ctx = addr::ctx(&f.accounts[0].0.to_bytes(), &PROGRAM);
    let r = event2::Receipt::decode(&ctx, &log[1]).unwrap();
    assert_eq!(log[1].len(), event2::LEN);
    assert!(event::Receipt::decode(&ctx, &log[1]).is_err());
    r.verify_previous(
        &ctx,
        event2::Chain::from_account(f.accounts[1].1.data()).unwrap(),
        event2::Chain::from_account(f.accounts[4].1.data()).unwrap(),
    )
    .unwrap();
    assert_eq!(
        event2::Chain::from_account(out[1].data()).unwrap(),
        r.holding_chain
    );
    assert_eq!(
        event2::Chain::from_account(out[4].data()).unwrap(),
        r.destination_chain
    );
    let snap = |accounts: &[AccountSharedData]| -> Vec<Snapshot> {
        f.roles
            .iter()
            .map(|role| {
                let index = role.index_in_transaction as usize;
                let a = &accounts[index];
                Snapshot {
                    address: f.accounts[index].0.to_bytes(),
                    owner: a.owner().to_bytes(),
                    present: !(a.owner() == &init::SYSTEM && a.data().is_empty()),
                    signer: role.is_signer(),
                    writable: role.is_writable(),
                    lamports: a.lamports(),
                    data: a.data().to_vec(),
                }
            })
            .collect()
    };
    let before = snap(
        &f.accounts
            .iter()
            .map(|(_, a)| a.clone())
            .collect::<Vec<_>>(),
    );
    let after = snap(out);
    assert_eq!(
        r.input,
        event2::manifest(
            &ctx,
            &f.forfeit_wire(),
            r.now_ts,
            r.now_slot,
            &manifest(&before),
            &[]
        )
        .unwrap()
    );
    assert_eq!(
        r.output,
        event2::manifest(
            &ctx,
            &f.forfeit_wire(),
            r.now_ts,
            r.now_slot,
            &manifest(&after),
            &[before[1].address, before[4].address]
        )
        .unwrap()
    );
    assert_eq!(r.forfeited, forfeited);
    assert_eq!(
        r.fate,
        WideArrival::read_at(f.accounts[5].1.data(), POSITION)
            .unwrap()
            .unwrap()
            .fate
    );
    assert_eq!(r.seal_code, seal_code::BAD_POINT);
    assert_eq!(r.reward, 37);
    assert_eq!(Ro(out[1].data()).u64(H::ESCROW).unwrap(), 0);
    assert!(
        out[1].data()[H::transit(SLOT as usize)..H::transit(SLOT as usize) + MARKER_LEN]
            .iter()
            .all(|b| *b == 0)
    );
    assert_eq!(out[2].owner(), &init::SYSTEM);
    assert_eq!(out[2].lamports(), 0);
    assert!(out[2].data().is_empty());
    assert_eq!(out[3], f.accounts[3].1);
    assert_eq!(out[6], f.accounts[6].1);
    assert_eq!(
        out[f.index(ix2::ROSTER)],
        f.accounts[f.index(ix2::ROSTER)].1
    );
    assert_ne!(
        WideClashInputsHdr::read(out[5].data())
            .unwrap()
            .settled_mask
            & (1 << POSITION),
        0
    );
    let total: u128 = f.accounts.iter().map(|(_, a)| a.lamports() as u128).sum();
    assert_eq!(
        out.iter().map(|a| a.lamports() as u128).sum::<u128>(),
        total + 1
    );
    let mut corrupt = log[1].clone();
    corrupt[306] = wa::wide_arrival::FATE_DESTROYED;
    assert!(event2::Receipt::decode(&ctx, &corrupt).is_err());
    let mut corrupt = log[1].clone();
    corrupt[307] ^= 1;
    assert!(event2::Receipt::decode(&ctx, &corrupt).is_err());
    r
}
fn refused_v2(f: &Input, hook: &Hook) {
    assert!(hook.take().is_empty());
    let out = f
        .run_with_data(&f.forfeit_wire(), |p, a, d| {
            assert!(crate::proc::wide::expedition_return::settle_forfeit_draft(p, a, d).is_err());
            Ok(())
        })
        .unwrap();
    assert_unchanged(f, &out);
    assert!(hook.take().is_empty());
}
#[test]
fn forfeit_wire_stays_and_withdrew_apply_existing_pending_operation_and_reward() {
    let hook = Hook::install();
    for fate in [
        wa::wide_arrival::FATE_STAYS,
        wa::wide_arrival::FATE_WITHDREW,
    ] {
        let mut f = Input::forfeit(fate);
        assert_eq!(
            Ro(f.accounts[0].1.data()).u8(S::STATUS).unwrap(),
            S::STATUS_RUNNING
        );
        let out = f.settle_forfeit();
        let r = observed_v2(&f, &out, &hook, true);
        let e = read_entry(out[4].data(), 0).unwrap();
        assert_eq!(e.op, EntryOp::Forfeit);
        let genesis = Ro(f.accounts[0].1.data()).i64(S::GENESIS_TS).unwrap();
        assert_eq!(e.pend_bell, ap::bell_at(genesis, r.now_ts).unwrap());
        assert_eq!(e.troops, 12_345); // removal is processed by subsequent Resolve
        assert_eq!(
            Ro(out[4].data()).u32(PV::ROSTER_EPOCH).unwrap(),
            Ro(f.accounts[4].1.data())
                .u32(PV::ROSTER_EPOCH)
                .unwrap()
                .wrapping_add(1)
        );
        assert!(!r.diverted);
        assert_eq!(
            out[f.index(13)].lamports(),
            f.accounts[f.index(13)].1.lamports() + 37
        );
        for ((_, a), after) in f.accounts.iter_mut().zip(out) {
            *a = after;
        }
        refused_v2(&f, &hook);
    }
}
#[test]
fn forfeit_wire_preserves_existing_absent_busy_and_diversion_rules() {
    let hook = Hook::install();
    // Missing roster and missing host both preserve the existing no-op.
    for absent in [false, true] {
        let mut f = Input::forfeit(wa::wide_arrival::FATE_STAYS);
        let mut pd = f.accounts[4].1.data().to_vec();
        write_entry(&mut pd, 0, &Entry::FREE).unwrap();
        Rw(&mut pd).set_u8(PV::N_ENTRIES, 0).unwrap();
        f.accounts[4].1.set_data_from_slice(&pd);
        let ri = f.index(ix2::ROSTER);
        if absent {
            f.accounts[ri].1 = literal(init::SYSTEM, 0, &[]);
        } else {
            let mut rd = f.accounts[ri].1.data().to_vec();
            WideRoster::read(&rd).unwrap().release(&mut rd, 0).unwrap();
            f.accounts[ri].1.set_data_from_slice(&rd);
        }
        let out = f.settle_forfeit();
        observed_v2(&f, &out, &hook, false);
        assert_eq!(
            wev::normalize_chained(out[4].data()),
            wev::normalize_chained(f.accounts[4].1.data())
        );
    }
    let mut f = Input::forfeit(wa::wide_arrival::FATE_WITHDREW);
    let mut pd = f.accounts[4].1.data().to_vec();
    let mut e = read_entry(&pd, 0).unwrap();
    e.op = EntryOp::Leave;
    e.pend_bell = 13;
    write_entry(&mut pd, 0, &e).unwrap();
    f.accounts[4].1.set_data_from_slice(&pd);
    let out = f.settle_forfeit();
    observed_v2(&f, &out, &hook, false);
    assert_eq!(
        wev::normalize_chained(out[4].data()),
        wev::normalize_chained(f.accounts[4].1.data())
    );
    let mut f = Input::forfeit(wa::wide_arrival::FATE_STAYS);
    f.roles[13] = InstructionAccount::new(4, false, true); // program-owned destination payee
    let out = f.settle_forfeit();
    let r = observed_v2(&f, &out, &hook, true);
    assert!(r.diverted);
    assert_eq!(Ro(out[1].data()).u64(H::POOL_OWED).unwrap(), 37);
}
#[test]
fn forfeit_wire_scope_roster_proof_and_late_refusals_are_inert() {
    let hook = Hook::install();
    for fate in [
        wa::wide_arrival::FATE_DESTROYED,
        wa::wide_arrival::FATE_BOUNCED,
        wa::wide_arrival::FATE_RETREATED,
    ] {
        refused_v2(&Input::forfeit(fate), &hook);
    }
    let mut f = Input::forfeit(wa::wide_arrival::FATE_STAYS);
    f.commit[0] ^= 1;
    refused_v2(&f, &hook);
    let mut f = Input::forfeit(wa::wide_arrival::FATE_STAYS);
    f.roles.pop();
    refused_v2(&f, &hook);
    let mut f = Input::forfeit(wa::wide_arrival::FATE_STAYS);
    let i = f.index(ix2::ROSTER);
    f.accounts[i].0 = Pubkey::new_from_array([71; 32]);
    refused_v2(&f, &hook);
    let mut f = Input::forfeit(wa::wide_arrival::FATE_STAYS);
    let i = f.index(ix2::ROSTER);
    f.accounts[i].1.set_owner(init::SYSTEM);
    refused_v2(&f, &hook);
    let mut f = Input::forfeit(wa::wide_arrival::FATE_STAYS);
    let i = f.index(ix2::ROSTER);
    let mut rd = f.accounts[i].1.data().to_vec();
    WideRoster::read(&rd).unwrap().release(&mut rd, 0).unwrap();
    f.accounts[i].1.set_data_from_slice(&rd);
    refused_v2(&f, &hook); // unpaired live alias
    let mut f = Input::forfeit(wa::wide_arrival::FATE_STAYS);
    f.roles[14] = InstructionAccount::new(4, false, true);
    refused_v2(&f, &hook);
    let mut f = Input::forfeit(wa::wide_arrival::FATE_STAYS);
    f.account_mut(13).set_lamports(u64::MAX);
    refused_v2(&f, &hook);
    for role in [1, 2, 4, 5] {
        let f = Input::forfeit(wa::wide_arrival::FATE_STAYS);
        let out = f
            .run_with_data(&f.forfeit_wire(), |p, a, d| {
                let _guard = a[role].try_borrow_data()?;
                assert!(
                    crate::proc::wide::expedition_return::settle_forfeit_draft(p, a, d).is_err()
                );
                Ok(())
            })
            .unwrap();
        assert_unchanged(&f, &out);
        assert!(hook.take().is_empty());
    }
    let f = Input::forfeit(wa::wide_arrival::FATE_STAYS);
    for (bytes, v1) in [
        (f.wire().to_vec(), false),
        (f.forfeit_wire().to_vec(), true),
    ] {
        let out = f
            .run_with_data(&bytes, |p, a, d| {
                let result = if v1 {
                    crate::proc::wide::expedition_return::settle_failure_draft(p, &a[..14], d)
                } else {
                    crate::proc::wide::expedition_return::settle_forfeit_draft(p, a, d)
                };
                assert!(result.is_err());
                assert!(crate::dispatch(p, a, d).is_err());
                Ok(())
            })
            .unwrap();
        assert_unchanged(&f, &out);
        assert!(hook.take().is_empty());
    }
}
