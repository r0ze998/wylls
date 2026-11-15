//! Literal public invalid ciphertext only. Native AccountInfo writeback, not
//! a saved proof or a synthetic successful seal. Valid seal remains unexecuted.
use super::*;
use frontier_abi::layout::clash::{arrival as AR, arrival_slot as AS, clash_inputs as CI};
use frontier_abi::world_index::expedition_reverse_transport::{ReverseMarker, ReverseTransit};
use frontier_abi::world_index::{
    expedition_reverse_settlement_event as rev_event, expedition_reverse_settlement_ix as rev_ix,
};

impl Input {
    fn reverse_final(fate: u8, retained: bool, eligible: bool) -> Self {
        let mut f = Self::fixture();
        let ctx = addr::ctx(&f.accounts[0].0.to_bytes(), &PROGRAM);
        let old = OwnedBridgeTransit::from_bytes(&ctx, f.accounts[2].1.data()).unwrap();
        let t = old.transit();
        let origin = TileAddress::new(t.dest.unwrap(), 0).unwrap();
        let destination = t.host.key();
        let reverse = ReverseTransit::new(
            &ctx,
            SLOT,
            WideTransit::depart(
                t.host_identity,
                t.host,
                t.unit,
                t.faction,
                origin,
                t.depart_bell,
                t.arrive_bell,
                t.depart_ts,
                t.dep_mass,
                t.march_stamina,
                t.dealt_bps,
                t.seal_root,
                0,
                0,
                t.rent_to,
            )
            .unwrap(),
            old.original_owner(),
            destination,
        )
        .unwrap()
        .settle_origin(&ctx, false, (80000, 40, 0))
        .unwrap()
        .gather_worn(&ctx, destination, 100)
        .unwrap();
        let marker = ReverseMarker::new(
            &ctx,
            &reverse,
            7,
            T::FLAG_FEE_ESCROWED | T::FLAG_BOND_ESCROWED,
        )
        .unwrap();
        let t = reverse.transit();
        f.accounts[2].1.set_data_from_slice(&reverse.to_bytes());
        let mut hd = f.accounts[1].1.data().to_vec();
        hd[H::transit(SLOT as usize)..H::transit(SLOT as usize) + 96]
            .copy_from_slice(&marker.to_bytes());
        f.accounts[1].1.set_data_from_slice(&hd);
        // Same original province is both home and destination: a genuine
        // duplicate instruction index, never two independent cells.
        f.roles[4] = InstructionAccount::new(3, false, true);
        let resolver = AccountResolver::for_season(&ctx).unwrap();
        let id = resolver.legacy_host_id(&t.host).unwrap();
        let dealt = hold::bps16(
            of_faction_v3(2)
                .unwrap()
                .dealt_bps(Posture::Stance(Stance::Hold), true),
        )
        .unwrap();
        let mut cd = vec![0; CI::SIZE];
        crate::layout::init_header(&mut cd, AccountKind::ClashInputs, 11).unwrap();
        let mut w = Rw(&mut cd);
        w.set_i16(CI::P, 128).unwrap();
        w.set_u32(CI::BELL, 12).unwrap();
        w.set_u8(CI::FLAGS, CI::FLAG_RESOLVED).unwrap();
        w.set_u32(CI::ARRIVALS_MASK, CI::ALL_GATHERED).unwrap();
        w.set_u8(CI::N_PRESENT, 1).unwrap();
        w.set_arr(CI::RESOLVER, &[35; 32]).unwrap();
        let at = CI::arrival(POSITION);
        w.set_u64(at + AR::HOST_ID, id).unwrap();
        w.set_u64(
            at + AR::CITIZEN_TAG,
            addr::citizen_tag(&old.original_owner()),
        )
        .unwrap();
        w.set_u32(at + AR::DEP_MASS, t.dep_mass).unwrap();
        w.set_u32(at + AR::TROOPS, t.troops_after).unwrap();
        w.set_u16(
            at + AR::STAMINA,
            frontier_abi::clash_model::arrival_stamina(
                t.stamina_after,
                t.depart_bell,
                t.arrive_bell,
            ),
        )
        .unwrap();
        w.set_u16(at + AR::DEALT, dealt).unwrap();
        w.set_u8(at + AR::FACTION, 2).unwrap();
        w.set_u8(at + AR::UNIT, 1).unwrap();
        w.set_u8(at + AR::PRESENT, 1).unwrap();
        w.set_u8(at + AR::FATE, fate).unwrap();
        w.set_u32(at + AR::TROOPS_AFTER, if fate == 5 { 0 } else { 12345 })
            .unwrap();
        f.accounts[5] = (
            Pubkey::new_from_array(ctx.clash_inputs(128, 0, 12)),
            literal(Pubkey::new_from_array(PROGRAM), 1_000_000_000, &cd),
        );
        let mut sd = vec![0; AS::SIZE];
        crate::layout::init_header(&mut sd, AccountKind::ArrivalSlot, 11).unwrap();
        let mut w = Rw(&mut sd);
        w.set_i16(AS::P, 128).unwrap();
        w.set_u32(AS::BELL, 12).unwrap();
        w.set_u8(AS::FACTION, 2).unwrap();
        w.set_u8(AS::UNIT, 1).unwrap();
        w.set_u64(AS::HOST_ID, id).unwrap();
        w.set_u64(AS::CITIZEN_TAG, addr::citizen_tag(&old.original_owner()))
            .unwrap();
        w.set_u32(AS::DEP_MASS, t.dep_mass).unwrap();
        w.set_u16(AS::DEALT_BPS, dealt).unwrap();
        w.set_u16(frontier_abi::v2::layout::s1::arrival::WORN_BPS, 100)
            .unwrap();
        w.set_arr(AS::BENEFICIARY, &[36; 32]).unwrap();
        w.set_arr(AS::RENT_TO, &t.rent_to).unwrap();
        if eligible {
            w.set_u64(AS::EV_SLOT, 82).unwrap();
            w.set_u64(AS::EV_PRICE, 1_000_000).unwrap();
            w.set_u32(AS::EV_LIMIT, 100_000).unwrap();
            w.set_u32(AS::EV_LOADED, 100_000).unwrap();
            let mut s = f.accounts[0].1.data().to_vec();
            Rw(&mut s).set_u32(S::DEFENCE_CAP_MILLI, 1000).unwrap();
            Rw(&mut s).set_u8(S::LATENESS_SLOTS, 5).unwrap();
            f.accounts[0].1.set_data_from_slice(&s);
        }
        f.accounts[6] = (
            Pubkey::new_from_array(ctx.arrival_slot(128, 0, 12, 2, 0)),
            if retained {
                literal(Pubkey::new_from_array(PROGRAM), 1_000_000_000, &sd)
            } else {
                literal(init::SYSTEM, 0, &[])
            },
        );
        let region = permutation_rules::frontier::geometry::region_of(
            permutation_rules::frontier::geometry::ProvinceCoord::new(128, 0),
        );
        let mut ad = f.accounts[8].1.data().to_vec();
        Rw(&mut ad).set_u8(BA::REGION, region).unwrap();
        f.accounts[8].1.set_data_from_slice(&ad);
        f.accounts[8].0 = Pubkey::new_from_array(ctx.bell_anchor(12, region));
        f.roles.push(InstructionAccount::new(
            f.accounts.len() as u16,
            false,
            true,
        ));
        f.accounts.push((
            Pubkey::new_from_array(old.original_owner()),
            literal(init::SYSTEM, 0, &[]),
        ));
        if matches!(fate, 1 | 2) {
            let mut pd = f.accounts[3].1.data().to_vec();
            // Existing original entry representation, no wide-handle alias.
            let host = permutation_rules::frontier::host::Host {
                id,
                // (the issuing holding key of a host id, as `Entry::to_host` derives it)
                owner: frontier_abi::addr::holding_key_of_host(id),
                faction: 2,
                unit: unit_from_u8(1).unwrap(),
                troops: 12345,
                stamina: permutation_rules::frontier::host::Stamina {
                    value: 40,
                    bell: 12,
                },
                ready_bell: 12,
                pending: None,
            };
            let entry = Entry::from_host(&host, 0, E::STATE_ROSTER, dealt, 12);
            write_entry(&mut pd, 0, &entry).unwrap();
            Rw(&mut pd).set_u8(PV::N_ENTRIES, 1).unwrap();
            f.accounts[3].1.set_data_from_slice(&pd);
        }
        f
    }
    fn reverse_wire(&self) -> [u8; rev_ix::DRAFT_LEN] {
        rev_ix::DraftCommand::new(SLOT, self.commit, self.seal)
            .unwrap()
            .to_bytes()
    }
    fn reverse_settle(&self) -> Vec<AccountSharedData> {
        self.run_with_data(&self.reverse_wire(), |p, a, d| {
            crate::proc::wide::expedition_return::settle_reverse_draft(p, a, d).map_err(Into::into)
        })
        .unwrap()
    }
}
/// The instruction's ordered account snapshots, from the input (`None`) or
/// from the written-back output; both borrow for the same `'a`.
fn reverse_snapshots<'a>(
    f: &'a Input,
    out: Option<&'a [AccountSharedData]>,
) -> Vec<frontier_abi::world_index::expedition_event::AccountSnapshot<'a>> {
    f.roles
        .iter()
        .enumerate()
        .map(|(role, meta)| {
            let i = meta.index_in_transaction as usize;
            let a = out.map_or(&f.accounts[i].1, |out| &out[i]);
            frontier_abi::world_index::expedition_event::AccountSnapshot {
                role: (role + 1) as u16,
                address: f.accounts[i].0.to_bytes(),
                owner: a.owner().to_bytes(),
                present: !(a.owner() == &init::SYSTEM && a.data().is_empty()),
                signer: meta.is_signer(),
                writable: meta.is_writable(),
                lamports: a.lamports(),
                data: a.data(),
            }
        })
        .collect()
}
fn reverse_observe(f: &Input, out: &[AccountSharedData], hook: &Hook) -> rev_event::Receipt {
    let logs = hook.take();
    let log = logs.last().unwrap();
    assert_eq!(log[0], rev_event::PREFIX);
    let ctx = addr::ctx(&f.accounts[0].0.to_bytes(), &PROGRAM);
    let r = rev_event::Receipt::decode(&ctx, &log[1]).unwrap();
    assert_eq!(
        r.input,
        rev_event::manifest(
            &ctx,
            &f.reverse_wire(),
            r.now_ts,
            r.now_slot,
            &reverse_snapshots(f, None),
            &[]
        )
        .unwrap()
    );
    let normalized: Vec<_> = r.links.iter().map(|l| l.address).collect();
    assert_eq!(
        r.output,
        rev_event::manifest(
            &ctx,
            &f.reverse_wire(),
            r.now_ts,
            r.now_slot,
            &reverse_snapshots(f, Some(out)),
            &normalized
        )
        .unwrap()
    );
    let previous: Vec<_> = r
        .links
        .iter()
        .map(|link| {
            let i = f
                .accounts
                .iter()
                .position(|a| a.0.to_bytes() == link.address)
                .unwrap();
            let (seq, head) = crate::layout::chain_of(f.accounts[i].1.data()).unwrap();
            assert_eq!(
                crate::layout::chain_of(out[i].data()).unwrap(),
                (link.seq, link.head)
            );
            rev_event::Chain { seq, head, ..*link }
        })
        .collect();
    r.verify_previous(&ctx, &previous).unwrap();
    assert_eq!(
        f.accounts
            .iter()
            .map(|a| a.1.lamports() as u128)
            .sum::<u128>(),
        out.iter()
            .take(f.accounts.len())
            .map(|a| a.lamports() as u128)
            .sum::<u128>()
    );
    assert_eq!(r.seal_code, seal_code::BAD_POINT);
    assert_eq!(r.payments[3].amount, 37);
    assert_eq!(r.credited_milli, 0);
    assert_eq!(r.camp_works, 0);
    assert_eq!(Ro(out[1].data()).u64(H::ESCROW).unwrap(), 0);
    assert!(
        out[1].data()[H::transit(SLOT as usize)..H::transit(SLOT as usize) + 96]
            .iter()
            .all(|b| *b == 0)
    );
    assert!(out[2].data().is_empty());
    assert_eq!(out[2].owner(), &init::SYSTEM);
    assert_eq!(out[2].lamports(), 0);
    assert_ne!(
        Ro(out[5].data()).u32(CI::SETTLED_MASK).unwrap() & (1 << POSITION),
        0
    );
    r
}
#[test]
fn reverse_final_bad_seal_original_writeback_and_receipt() {
    let hook = Hook::install();
    for fate in 1..=5 {
        let f = Input::reverse_final(fate, false, false);
        let out = f.reverse_settle();
        let r = reverse_observe(&f, &out, &hook);
        assert_eq!(r.forfeited, matches!(fate, 1 | 2));
        if r.forfeited {
            assert_eq!(read_entry(out[3].data(), 0).unwrap().op, EntryOp::Forfeit);
        }
        assert!(!r.slot_retained);
    }
}
