//! Exact-filter-only regression for declaration versus the unresolved cursor.
//! Literal pre-handler fixtures, existing cached native runtime, no signing,
//! private keys, transactions, RPC, new crypto fixtures or public gate changes.
use super::*;
use runtime_contract_support::{
    self as rt, AccountSharedData, InstructionAccount, ReadableAccount, WritableAccount,
};

#[derive(Clone, Copy, PartialEq)]
enum Expect {
    Refuse,
    Declare,
    /// Experimental conquest lane: a lagged declaration is a reservation.
    Reserve,
}

fn run(legacy: bool, cursor: u32, expect: Expect) {
    let accept = expect != Expect::Refuse;
    let mut fixture = if legacy {
        tests::legacy_fixture()
    } else {
        tests::fixture()
    };
    // All fixture changes precede execution. Both aliases share the actual
    // runtime-unioned write privilege, as one transaction account must do.
    if fixture[5].key == fixture[7].key {
        fixture[7].is_writable = fixture[5].is_writable;
    }
    Rw(&mut fixture[5].try_borrow_mut_data().unwrap())
        .set_u32(PV::RESOLVED_NEXT, cursor)
        .unwrap();
    let program = Pubkey::new_from_array([0x12; 32]);
    let ctx = addr::ctx(&key(&fixture[2]), program.as_array());
    let world = world_of(&ctx).unwrap();
    let province_key = ProvinceKey::new(world, WideCoord::checked(129, 0).unwrap());
    let mut accounts: Vec<(Pubkey, AccountSharedData)> = vec![];
    let mut roles = vec![];
    for ai in &fixture {
        let index = accounts
            .iter()
            .position(|(key, _)| key == ai.key)
            .unwrap_or_else(|| {
                let mut data = AccountSharedData::new(ai.lamports(), ai.data_len(), ai.owner);
                data.set_data_from_slice(&ai.try_borrow_data().unwrap());
                accounts.push((*ai.key, data));
                accounts.len() - 1
            });
        roles.push(InstructionAccount::new(
            index as u16,
            ai.is_signer,
            ai.is_writable,
        ));
    }
    let table_index = roles[9].index_in_transaction as usize;
    let province_index = roles[5].index_in_transaction as usize;
    let mut executable = AccountSharedData::new(1, 0, &solana_program::bpf_loader::id());
    executable.set_executable(true);
    let program_index = accounts.len() as u16;
    accounts.push((program, executable));
    let before: Vec<_> = accounts.iter().map(|(_, a)| a.clone()).collect();
    // SAFETY: only the real, reviewed private handler sees official SDK backing;
    // no AccountInfo/borrow escapes. Sidecars/rent are present; no CPI is needed.
    let out = unsafe {
        rt::system_cpi::run(accounts, program_index, roles, vec![], |p, a, _| {
            let result = declare_siege_inner(
                p,
                a,
                &wix::DeclareSiege { site: 1, entry: 0 },
                &Auth::Wallet,
            );
            if accept {
                result.map_err(Into::into)
            } else {
                assert_eq!(result, Err(FrontierError::NotResident.into()));
                // Return success only after checking the expected refusal so
                // official writeback still exposes any unintended live effect.
                Ok(())
            }
        })
    }
    .expect("reviewed declaration and official runtime writeback");
    assert!(out.cpis.is_empty());
    if accept {
        assert_eq!(out.logs.len(), 2);
        let table = WideConquest::read(out.accounts[table_index].data(), 11, province_key).unwrap();
        let prefix = Record::read(out.accounts[province_index].data(), 1).unwrap();
        // The handler never moves the cursor.
        assert_eq!(
            Ro(out.accounts[province_index].data())
                .u32(PV::RESOLVED_NEXT)
                .unwrap(),
            cursor
        );
        if expect == Expect::Declare {
            assert_eq!(table.entry(1).unwrap().unwrap().declaration_bell, 10);
            assert_eq!(prefix.kind, CR::KIND_SIEGE);
        } else {
            // A pending reservation for bell 10: no site entry, the site
            // flagged, everything collected recorded.
            assert!(table.entry(1).unwrap().is_none());
            assert_eq!((prefix.kind, prefix.flags), (CR::KIND_NONE, CR::FLAG_PENDING));
            let pending = table.pending_at(1, 10);
            assert_eq!(pending.len(), 1);
            let r = pending[0].1;
            assert_eq!((r.status, r.seq, r.entry, r.bell), (wc::RES_PENDING, 0, 0, 10));
            assert_eq!(r.arms_milli, permutation_rules::frontier::arms::SIEGE_ARMS as u64 * 1000);
            assert!(r.gold_milli > 0);
        }
    } else {
        assert!(out.logs.is_empty());
        assert_eq!(
            out.accounts, before,
            "refusal must precede account/lamport/chain effects"
        );
    }
    assert!(!super::super::CONQUEST_LIFECYCLE_ENABLED);
}

#[test]
fn lagged_declaration_refuses_before_effects_and_current_cursor_accepts() {
    for legacy in [false, true] {
        assert!(
            ap::resident_ok(9, 10),
            "ordinary resident order allows one old bell"
        );
        // Plain lanes keep the refusal; the experimental conquest lane
        // reserves instead (approved B), with the same effects collected.
        let lagged = if cfg!(feature = "conquest-dispatch-experimental") {
            Expect::Reserve
        } else {
            Expect::Refuse
        };
        run(legacy, 8, lagged);
        run(legacy, 9, lagged);
        run(legacy, 10, Expect::Declare);
    }
}
