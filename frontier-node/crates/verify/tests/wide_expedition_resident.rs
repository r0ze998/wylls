#![cfg(feature = "wide-economy-experimental")]
//! Immutable actual native output, not synthetic expected post-state generated
//! by this verifier. No keys, signatures, RPC, process launch or file writes.
use frontier_abi::{
    bytes::*,
    layout::province::entry as E,
    v2::layout::{
        player::{citizen as C, holding as H},
        province::{province as P, site as SM},
    },
    world_index::{expedition_resident_event::Action, WideHostRef},
};
use verify_core::wide_expedition_resident::*;

const DISSOLVE: &[u8] = include_bytes!("fixtures/wide_expedition_resident/dissolve_v1.bin");
const RETURN: &[u8] = include_bytes!("fixtures/wide_expedition_resident/return_v1.bin");
#[derive(Clone)]
struct Fixture {
    context: Context,
    before: Vec<Account>,
    after: Vec<Account>,
    events: Vec<Vec<u8>>,
}
struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}
impl Reader<'_> {
    fn take(&mut self, n: usize) -> &[u8] {
        let end = self.at.checked_add(n).unwrap();
        let b = &self.bytes[self.at..end];
        self.at = end;
        b
    }
    fn array<const N: usize>(&mut self) -> [u8; N] {
        self.take(N).try_into().unwrap()
    }
    fn byte(&mut self) -> u8 {
        self.take(1)[0]
    }
    fn boolean(&mut self) -> bool {
        match self.byte() {
            0 => false,
            1 => true,
            _ => panic!("fixture boolean"),
        }
    }
    fn sized(&mut self) -> Vec<u8> {
        let n = u32::from_le_bytes(self.array()) as usize;
        assert!(n <= 65_536);
        self.take(n).to_vec()
    }
    fn account(&mut self) -> Account {
        Account {
            address: self.array(),
            owner: self.array(),
            present: self.boolean(),
            signer: self.boolean(),
            writable: self.boolean(),
            executable: self.boolean(),
            lamports: u64::from_le_bytes(self.array()),
            data: self.sized(),
        }
    }
}
impl Fixture {
    fn read(bytes: &[u8]) -> Self {
        let mut r = Reader { bytes, at: 0 };
        assert_eq!(r.take(8), b"BRESv001");
        let action = match r.byte() {
            1 => Action::Dissolve,
            2 => Action::Return,
            _ => panic!("action"),
        };
        let program = r.array();
        let season = r.array();
        let host = WideHostRef::from_bytes(&r.array::<56>()).unwrap();
        let now_ts = i64::from_le_bytes(r.array());
        let now_slot = u64::from_le_bytes(r.array());
        let n = r.byte() as usize;
        assert_eq!(n, if action == Action::Dissolve { 8 } else { 6 });
        let before = (0..n).map(|_| r.account()).collect();
        let after = (0..n).map(|_| r.account()).collect();
        assert_eq!(r.byte(), 2);
        let events = (0..2).map(|_| r.sized()).collect();
        assert_eq!(r.at, bytes.len());
        Self {
            context: Context {
                program,
                season,
                host,
                action,
                now_ts,
                now_slot,
            },
            before,
            after,
            events,
        }
    }
    fn verify(&self) -> Result<Verified, Refusal> {
        verify_transition(Evidence {
            context: &self.context,
            before: &self.before,
            after: &self.after,
            events: &self.events,
        })
    }
}

#[test]
fn actual_native_dissolve_and_return_match_independent_effects_and_both_receipts() {
    for bytes in [DISSOLVE, RETURN] {
        let f = Fixture::read(bytes);
        let v = f
            .verify()
            .expect("actual native output must replay independently");
        let staged = stage(&f.context, &f.before).unwrap();
        assert_eq!(staged.after, f.after);
        assert_eq!(staged.events, f.events);
        assert_eq!(v.action, f.context.action);
        assert_eq!(v.identity.host, f.context.host);
        assert!(!v.full_season());
        assert!(!v.not_proven().is_empty());
        if v.action == Action::Return {
            assert_eq!(v.outcomes.credited_units, v.outcomes.troops_milli / 1000);
            assert!(v.outcomes.credited_units > 0);
        } else {
            assert_eq!(v.outcomes.credited_units, 0);
        }
    }
}

#[test]
fn every_receipt_byte_and_emission_order_are_bound() {
    for bytes in [DISSOLVE, RETURN] {
        let f = Fixture::read(bytes);
        for record in 0..2 {
            for offset in 0..f.events[record].len() {
                let mut bad = f.clone();
                bad.events[record][offset] ^= 1;
                assert!(
                    bad.verify().is_err(),
                    "action {:?}, body {record}, byte {offset}",
                    f.context.action
                );
            }
        }
        let mut bad = f.clone();
        bad.events.swap(0, 1);
        assert!(bad.verify().is_err());
        let mut bad = f.clone();
        bad.events.pop();
        assert!(bad.verify().is_err());
        let mut bad = f.clone();
        bad.events.push(f.events[0].clone());
        assert!(bad.verify().is_err());
        let mut bad = f;
        bad.events[0].push(0);
        assert!(bad.verify().is_err());
    }
}

#[test]
fn complete_post_state_including_unaffected_roles_and_metadata_is_bound() {
    for bytes in [DISSOLVE, RETURN] {
        let f = Fixture::read(bytes);
        for i in 0..f.after.len() {
            for field in 0..8 {
                let mut bad = f.clone();
                let a = &mut bad.after[i];
                match field {
                    0 => a.address[0] ^= 1,
                    1 => a.owner[0] ^= 1,
                    2 => a.present = !a.present,
                    3 => a.signer = !a.signer,
                    4 => a.writable = !a.writable,
                    5 => a.executable = !a.executable,
                    6 => a.lamports += 1,
                    _ => a.data.push(0),
                }
                assert!(bad.verify().is_err(), "role {i}, field {field}");
            }
            for offset in [0, 24, 32, 80, f.after[i].data.len().saturating_sub(1)] {
                if offset < f.after[i].data.len() {
                    let mut bad = f.clone();
                    bad.after[i].data[offset] ^= 1;
                    assert!(bad.verify().is_err());
                }
            }
        }
        let mut bad = f;
        bad.after.pop();
        assert!(bad.verify().is_err());
    }
}

#[test]
fn context_claims_raw_inputs_and_cross_action_pairing_are_bound() {
    for bytes in [DISSOLVE, RETURN] {
        let f = Fixture::read(bytes);
        for field in 0..5 {
            let mut bad = f.clone();
            match field {
                0 => bad.context.now_slot += 1,
                1 => bad.context.now_ts += 1,
                2 => bad.context.program[0] ^= 1,
                3 => bad.context.season[0] ^= 1,
                _ => {
                    bad.context.action = if f.context.action == Action::Return {
                        Action::Dissolve
                    } else {
                        Action::Return
                    }
                }
            };
            assert!(bad.verify().is_err());
        }
        for i in 0..f.before.len() {
            let mut bad = f.clone();
            bad.before[i].lamports += 1;
            assert!(bad.verify().is_err());
        }
        let mut bad = f.clone();
        bad.before[0].signer = false;
        assert!(stage(&bad.context, &bad.before).is_err());
        let mut bad = f.clone();
        bad.before[4].writable = false;
        assert!(stage(&bad.context, &bad.before).is_err());
        let mut bad = f.clone();
        bad.before[4].executable = true;
        assert!(stage(&bad.context, &bad.before).is_err());
        let mut bad = f.clone();
        bad.before[4].owner = [0; 32];
        assert!(stage(&bad.context, &bad.before).is_err());
        let mut bad = f.clone();
        bad.before[4].data[H::GEN] += 1;
        assert!(stage(&bad.context, &bad.before).is_err());
        let mut bad = f.clone();
        wr_u32(&mut bad.before[4].data, H::HOST_SEQ, 0);
        assert!(stage(&bad.context, &bad.before).is_err());
        let mut bad = f.clone();
        bad.before[1].address = bad.before[0].address;
        assert!(stage(&bad.context, &bad.before).is_err());
        let mut bad = f;
        bad.before.pop();
        assert!(stage(&bad.context, &bad.before).is_err());
    }
    let mut bad = Fixture::read(DISSOLVE);
    bad.events[1] = Fixture::read(RETURN).events[1].clone();
    assert!(bad.verify().is_err());
}

#[test]
fn return_refuses_early_overflow_capture_and_all_raw_redirect_fields() {
    let f = Fixture::read(RETURN);
    let staged = stage(&f.context, &f.before).unwrap();
    let index = staged.outcomes.entry as usize;
    let row = P::entry(index);
    for offset in [E::OP_A, E::OP_B, E::OP_TROOPS, E::OP_REF] {
        let mut bad = f.clone();
        bad.before[2].data[row + offset] = 1;
        assert!(stage(&bad.context, &bad.before).is_err());
    }
    let mut bad = f.clone();
    bad.before[2].data[row + E::STATE] = E::STATE_ROSTER;
    assert!(stage(&bad.context, &bad.before).is_err());
    let mut bad = f.clone();
    wr_u32(
        &mut bad.before[2].data,
        P::RESOLVED_NEXT,
        staged.outcomes.pending_bell,
    );
    assert!(stage(&bad.context, &bad.before).is_err());
    let mut bad = f.clone();
    wr_u32(
        &mut bad.before[4].data,
        H::reserve(staged.outcomes.unit as usize),
        u32::MAX,
    );
    assert!(stage(&bad.context, &bad.before).is_err());
    let mut bad = f.clone();
    bad.before[5].data[P::site(f.context.host.site() as usize) + SM::STATE] = SM::STATE_HOLDING;
    bad.before[5].data[P::site(f.context.host.site() as usize) + SM::GEN] =
        f.context.host.gen() + 1;
    assert!(stage(&bad.context, &bad.before).is_err());
    let mut bad = f;
    bad.before = bad.after.clone();
    assert!(stage(&bad.context, &bad.before).is_err());
}

#[test]
fn dissolve_refuses_unowned_busy_unfinal_bound_and_exhausted_bucket_states() {
    let f = Fixture::read(DISSOLVE);
    let s = stage(&f.context, &f.before).unwrap();
    let row = P::entry(s.outcomes.entry as usize);
    let mut bad = f.clone();
    bad.before[0].address = [0x13; 32];
    assert!(stage(&bad.context, &bad.before).is_err());
    let mut bad = f.clone();
    bad.before[4].data[H::STATE] = H::STATE_PROVISIONAL;
    assert!(stage(&bad.context, &bad.before).is_err());
    let mut bad = f.clone();
    bad.before[5].data[row + E::PEND_OP] = E::OP_LEAVE;
    assert!(stage(&bad.context, &bad.before).is_err());
    let mut bad = f.clone();
    wr_u32(&mut bad.before[5].data, P::RESOLVED_NEXT, 0);
    assert!(stage(&bad.context, &bad.before).is_err());
    let mut bad = f.clone();
    bad.before[3].data[C::holding_of_slot(1) + 5] = C::EMPTY_GEN;
    assert!(stage(&bad.context, &bad.before).is_err());
    let mut bad = f.clone();
    let season = &mut bad.before[2].data;
    wr_u16(
        season,
        frontier_abi::v2::layout::world::season::BUCKET_BURST,
        0,
    );
    assert!(stage(&bad.context, &bad.before).is_err());
    let mut bad = f;
    bad.before = bad.after.clone();
    assert!(stage(&bad.context, &bad.before).is_err());
}

#[test]
fn raw_input_commitment_is_checked_before_malformed_economics() {
    let mut f = Fixture::read(DISSOLVE);
    let frac = H::store(0) + frontier_abi::layout::player::accrual::FRAC;
    assert!(wr_i64(&mut f.before[4].data, frac, i64::MAX));
    assert_eq!(f.verify(), Err("raw input commitment mismatch".into()));
    assert!(stage(&f.context, &f.before).is_err());
}
