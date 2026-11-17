//! Literal synthetic accounts only. No testkit, lifecycle, keys, signatures,
//! native crypto, network, runtime dispatch, simulation or transaction send.
//! Only this integration target is intended for the reviewed focused run.
#![cfg(feature = "wide-world-experimental")]

use base64::Engine as _;
use fclient::ports::{Account, ClockSysvar};
use frontier_abi::addr::{defence_claim_seed, keeper_tag8, AddrCtx};
use frontier_abi::bytes::{wr_arr, wr_u16, wr_u32, wr_u64};
use frontier_abi::layout::beacon::{bell_anchor as BA, defence_claim as DC};
use frontier_abi::layout::world::{defence_pool as DP, season as S};
use frontier_abi::world_index::arrival::{wide_arrival_slot as AS, WideArrivalSlot};
use frontier_abi::world_index::rules::wide_region;
use frontier_abi::world_index::wide_ix::{self as wix, ClaimDefence};
use frontier_abi::world_index::{ProvinceKey, WideCoord, WideHostRef, WorldId};
use keeper_core::wideclaim::{self, Block, Candidate, SlotId, Step};
use keeper_core::wideduty::{Block as DutyBlock, Deployment, Reads, Scope};
use keeper_core::widesnapshot::{parse_snapshot_response, sysvar_owner, RentSysvar, Snapshot};
use serde_json::{json, Value};
use solana_address::Address;

const ID: u64 = 9;
const GENESIS: i64 = 1_700_000_000;
const VERSION: u16 =
    frontier_abi::v2::presets::PROGRAM_VERSION_S1 | wix::WIDE_EXPERIMENTAL_VERSION_BIT;
const RULESET: [u8; 32] = [0x77; 32];

fn address(byte: u8) -> Address {
    Address::new_from_array([byte; 32])
}
fn wallet(lamports: u64) -> Account {
    Account {
        lamports,
        owner: fclient::addr::system_program(),
        data: vec![],
        executable: false,
    }
}
fn account(data: Vec<u8>, lamports: u64) -> Account {
    Account {
        lamports,
        owner: address(23),
        data,
        executable: false,
    }
}
fn short(magic: &[u8; 8], size: usize) -> Vec<u8> {
    let mut data = vec![0; size];
    assert!(wr_arr(&mut data, 0, magic));
    assert!(wr_u64(&mut data, 8, ID));
    data
}
fn done(step: Step) -> Result<Candidate, Block> {
    match step {
        Step::Done(r) => r,
        Step::Need(k) => panic!("unread keys: {k:?}"),
    }
}

struct Fixture {
    scope: Scope,
    keeper: Address,
    selected: Vec<SlotId>,
    reads: Reads,
}

impl Fixture {
    fn new() -> Self {
        let program = address(23);
        let (season, bump) = fclient::addr::season_pda(&program, ID);
        let scope = Scope {
            program,
            season,
            deployment: Some(Deployment {
                program_version: VERSION,
                ruleset_hash: RULESET,
            }),
        };
        let world = WorldId::derive_legacy_season(&season.to_bytes(), &program.to_bytes()).unwrap();
        let dest = ProvinceKey::new(world, WideCoord::checked(129, 0).unwrap());
        let keeper = address(91);
        let mut s = short(&S::MAGIC, S::SIZE);
        assert!(wr_u16(&mut s, S::LAYOUT_VERSION, 2));
        s[S::STATUS] = S::STATUS_RUNNING;
        s[S::BUMP] = bump;
        assert!(wr_u16(&mut s, S::PROGRAM_VERSION, VERSION));
        assert!(wr_arr(&mut s, S::RULESET_HASH, &RULESET));
        assert!(wr_arr(&mut s, S::GENESIS_TS, &GENESIS.to_le_bytes()));
        assert!(wr_u32(&mut s, S::BELL_SECS, 600));
        assert!(wr_u32(&mut s, S::END_BELL, 10_000));
        assert!(wr_u32(&mut s, S::REVEAL_WINDOW, 600));
        assert!(wr_u32(&mut s, S::WINDOW_FROM_BELL, u32::MAX));
        assert!(wr_u32(&mut s, S::MIN_REVEAL_PRIORITY_MILLI, 433));
        assert!(wr_u32(&mut s, S::REVEAL_CU_LIMIT, 26_000));
        assert!(wr_u32(&mut s, S::REVEAL_LOADED_LIMIT, 1_048_576));
        assert!(wr_u32(&mut s, S::DEFENCE_CAP_MILLI, 2_000));
        s[S::LATENESS_SLOTS] = 4;
        let mut pool = short(&DP::MAGIC, DP::SIZE);
        assert!(wr_u64(&mut pool, DP::PER_BELL_REGION_CAP, 1_000_000));
        assert!(wr_u64(&mut pool, DP::PER_KEEPER_DAY_CAP, 2_000_000));
        assert!(wr_u64(&mut pool, DP::PAID_TOTAL, 11));
        assert!(wr_u64(&mut pool, DP::CLAIMS, 13));
        let mut reads = Reads::new(80);
        reads.clock = Some(ClockSysvar {
            slot: 900,
            unix_timestamp: GENESIS + 7_200,
            ..ClockSysvar::default()
        });
        reads.rent = Some(RentSysvar {
            lamports_per_byte_year: 1,
            exemption_threshold: 1.0,
            burn_percent: 50,
        });
        reads.accounts.insert(season, Some(account(s, 1_000_000)));
        reads.accounts.insert(keeper, Some(wallet(1_000_000)));
        let mut f = Self {
            scope,
            keeper,
            selected: vec![],
            reads,
        };
        f.reads
            .accounts
            .insert(f.pool(), Some(account(pool, 500_384)));
        f.reads.accounts.insert(f.claim(0), Some(wallet(100)));
        f.add_slot(
            SlotId {
                dest,
                bell: 10,
                faction: 0,
                i: 0,
            },
            false,
        );
        f
    }
    fn ctx(&self) -> AddrCtx {
        AddrCtx {
            program: self.scope.program.to_bytes(),
            season: self.scope.season.to_bytes(),
        }
    }
    fn pool(&self) -> Address {
        Address::new_from_array(self.ctx().defence_pool())
    }
    fn claim(&self, day: u32) -> Address {
        Address::new_from_array(self.ctx().of(&defence_claim_seed(
            &keeper_tag8(&self.keeper.to_bytes()),
            day,
        )))
    }
    fn data(&mut self, key: Address) -> &mut Vec<u8> {
        &mut self
            .reads
            .accounts
            .get_mut(&key)
            .unwrap()
            .as_mut()
            .unwrap()
            .data
    }
    fn balance(&mut self, key: Address, value: u64) {
        self.reads
            .accounts
            .get_mut(&key)
            .unwrap()
            .as_mut()
            .unwrap()
            .lamports = value;
    }
    fn add_slot(&mut self, id: SlotId, created_day: bool) {
        let slot = WideArrivalSlot {
            season_id: ID,
            dest: id.dest,
            bell: id.bell,
            faction: id.faction,
            i: id.i,
            transit_slot: 0,
            host: WideHostRef::new(id.dest, 3, 1, 2).unwrap(),
            citizen: [88; 32],
            unit: 0,
            stance: 0,
            tile: 5,
            retreat_bps: 0,
            dealt_bps: 0,
            dep_mass: 100_000,
            flags: if created_day { AS::FLAG_CREATED_DAY } else { 0 },
            beneficiary: self.keeper.to_bytes(),
            rent_to: [90; 32],
            ev_slot: 110,
            ev_price: 10_000_000,
            ev_limit: 26_000,
            ev_loaded: 1_048_576,
            claimed: false,
        };
        let mut data = vec![0; AS::SIZE];
        slot.write(&mut data).unwrap();
        self.reads
            .accounts
            .insert(id.address(&self.scope), Some(account(data, 416)));
        let mut anchor = short(&BA::MAGIC, BA::SIZE);
        assert!(wr_u32(&mut anchor, BA::BELL, id.bell));
        anchor[BA::REGION] = wide_region(id.dest.coord());
        assert!(wr_arr(&mut anchor, BA::A, &(GENESIS + 6_000).to_le_bytes()));
        assert!(wr_u64(&mut anchor, BA::SLOT, 100));
        self.reads
            .accounts
            .insert(id.anchor(&self.scope), Some(account(anchor, 272)));
        self.selected.push(id);
    }
    fn install_claim(&mut self, claimed: u64, count: u32) {
        let mut data = short(&DC::MAGIC, DC::SIZE);
        assert!(wr_arr(&mut data, DC::BENEFICIARY, &self.keeper.to_bytes()));
        assert!(wr_u32(&mut data, DC::DAY, 0));
        assert!(wr_u64(&mut data, DC::CLAIMED, claimed));
        assert!(wr_u32(&mut data, DC::COUNT, count));
        self.reads
            .accounts
            .insert(self.claim(0), Some(account(data, 256)));
    }
    fn plan(&self) -> Result<Candidate, Block> {
        done(wideclaim::plan_claim_defence(
            &self.scope,
            self.keeper,
            0,
            &self.selected,
            &self.reads,
        ))
    }
    fn snapshot(&self, keys: &[Address], with_rent: bool) -> Snapshot {
        fn encoded(a: &Account) -> Value {
            json!({"lamports": a.lamports, "owner": a.owner.to_string(), "executable": a.executable,
                "data": [base64::engine::general_purpose::STANDARD.encode(&a.data), "base64"]})
        }
        let mut values: Vec<Value> = keys
            .iter()
            .map(|key| {
                self.reads
                    .accounts
                    .get(key)
                    .and_then(Option::as_ref)
                    .map_or(Value::Null, encoded)
            })
            .collect();
        let c = self.reads.clock.unwrap();
        values.push(encoded(&Account {
            lamports: 1,
            owner: sysvar_owner(),
            data: c.encode().to_vec(),
            executable: false,
        }));
        if with_rent {
            values.push(encoded(&Account {
                lamports: 1,
                owner: sysvar_owner(),
                data: self.reads.rent.unwrap().encode().to_vec(),
                executable: false,
            }));
        }
        parse_snapshot_response(
            &json!({"context": {"slot": c.slot}, "value": values}),
            keys,
            with_rent,
            self.reads.min_slot,
        )
        .unwrap()
    }
    fn keys(&self) -> Vec<Address> {
        wideclaim::required_keys(&self.scope, self.keeper, 0, &self.selected).unwrap()
    }
}

#[test]
fn literal_claim_predicts_unsigned_instruction_and_preserves_all_input_bytes() {
    let f = Fixture::new();
    let before = f.reads.clone();
    let c = f.plan().unwrap();
    let x = c.facts();
    assert_eq!(x.predicted_paid, 40_711);
    assert_eq!(x.creation_shortfall, 156);
    assert_eq!(x.predicted_claimed_after, 40_711);
    assert_eq!(x.predicted_count_after, 1);
    assert_eq!(x.predicted_pool_paid_total_after, 40_722);
    assert_eq!(x.predicted_pool_claims_after, 14);
    assert_eq!(x.predicted_balances[0].predicted_after, 1_040_555);
    assert_eq!(x.predicted_balances[1].predicted_after, 459_673);
    assert_eq!(x.predicted_balances[2].predicted_after, 256);
    assert!(!x.predicted_partial && x.slots[0].predicted_claimed);
    assert_eq!(
        ClaimDefence::decode(&c.instruction().data).unwrap(),
        ClaimDefence { day: 0, n: 1 }
    );
    let m = &c.instruction().accounts;
    assert_eq!(m.len(), 7);
    assert_eq!(
        m.iter().map(|m| m.pubkey).collect::<Vec<_>>(),
        vec![
            f.keeper,
            f.scope.season,
            f.pool(),
            f.claim(0),
            fclient::addr::system_program(),
            f.selected[0].address(&f.scope),
            f.selected[0].anchor(&f.scope)
        ]
    );
    assert_eq!(
        m.iter()
            .map(|m| (m.is_signer, m.is_writable))
            .collect::<Vec<_>>(),
        vec![
            (true, true),
            (false, false),
            (false, true),
            (false, true),
            (false, false),
            (false, true),
            (false, false)
        ]
    );
    assert!(!c.signed() && !c.automatic_send() && !c.coherent());
    assert!(c.packet_bytes() <= 1232 && c.snapshot().is_none());
    assert_eq!(c.min_slot(), 80);
    assert_eq!(c.keeper(), f.keeper);
    assert_eq!(c.observed_clock(), f.reads.clock.unwrap());
    assert_eq!(c.unverified(), &wideclaim::UNVERIFIED);
    assert_eq!(f.reads, before);
}

#[test]
fn created_day_flag_is_evidence_and_settled_flag_does_not_change_refund() {
    let mut f = Fixture::new();
    let id = f.selected[0];
    f.add_slot(SlotId { i: 1, ..id }, true);
    let c = f.plan().unwrap();
    assert_eq!(c.facts().slots[0].nominal_refund, 40_711);
    assert_eq!(c.facts().slots[1].nominal_refund, 41_311);
    assert!(!c.facts().slots[0].evidence.created_day);
    assert!(c.facts().slots[1].evidence.created_day);
    f.data(f.selected[1].address(&f.scope))[AS::FLAGS] |= AS::FLAG_SETTLED;
    assert_eq!(f.plan().unwrap().facts().predicted_paid, 82_022);
}

#[test]
fn caps_are_within_call_per_bell_region_and_shared_day_counts_actual_paid() {
    let mut f = Fixture::new();
    let id = f.selected[0];
    f.add_slot(SlotId { i: 1, ..id }, false);
    f.add_slot(SlotId { bell: 11, ..id }, false);
    assert!(wr_u64(f.data(f.pool()), DP::PER_BELL_REGION_CAP, 50_000));
    assert!(wr_u64(f.data(f.pool()), DP::PER_KEEPER_DAY_CAP, 100_000));
    f.install_claim(80_000, 7); // Includes any prior legacy claim, same account.
    f.balance(f.pool(), 10_384);
    let c = f.plan().unwrap();
    let x = c.facts();
    assert_eq!(
        x.slots
            .iter()
            .map(|s| s.admitted_within_call)
            .collect::<Vec<_>>(),
        vec![40_711, 9_289, 40_711]
    );
    assert_eq!(x.admitted_within_call, 90_711);
    assert_eq!(x.day_capped, 20_000);
    assert_eq!(x.predicted_paid, 10_000);
    assert!(x.predicted_partial);
    assert_eq!(x.predicted_claimed_after, 90_000);
    assert_eq!(x.predicted_count_after, 10);
    assert_eq!(x.creation_shortfall, 0);
    // A separate plan starts the per-call cap anew; no global counter exists.
    assert_eq!(
        f.plan().unwrap().facts().slots[0].admitted_within_call,
        40_711
    );
}

#[test]
fn zero_payment_still_consumes_slots_and_partial_is_only_pool_shortage() {
    let mut f = Fixture::new();
    f.balance(f.pool(), 384);
    let c = f.plan().unwrap();
    assert_eq!(c.facts().predicted_paid, 0);
    assert_eq!(c.facts().predicted_count_after, 1);
    assert!(c.facts().predicted_partial && c.facts().slots[0].predicted_claimed);
    f.install_claim(2_000_000, 4);
    let c = f.plan().unwrap();
    assert_eq!(c.facts().predicted_claimed_after, 2_000_000);
    assert_eq!(c.facts().predicted_count_after, 5);
    assert_eq!(c.facts().day_capped, 0);
    assert!(!c.facts().predicted_partial);
    assert!(wr_u64(f.data(f.pool()), DP::PER_BELL_REGION_CAP, 0));
    assert_eq!(f.plan().unwrap().facts().admitted_within_call, 0);
}

#[test]
fn prefund_shortfall_must_be_available_before_any_refund() {
    let mut f = Fixture::new();
    f.balance(f.keeper, 155);
    assert_eq!(
        f.plan(),
        Err(Block::KeeperShortfall {
            balance: 155,
            needed: 156
        })
    );
    f.balance(f.keeper, 156);
    assert_eq!(
        f.plan().unwrap().facts().predicted_balances[0].predicted_after,
        40_711
    );
    f.balance(f.claim(0), 300);
    f.balance(f.keeper, 0);
    let c = f.plan().unwrap();
    assert_eq!(c.facts().creation_shortfall, 0);
    assert_eq!(c.facts().predicted_balances[2].predicted_after, 300);
    f.reads.accounts.insert(f.claim(0), None);
    assert_eq!(
        f.plan(),
        Err(Block::KeeperShortfall {
            balance: 0,
            needed: 256
        })
    );
}

#[test]
fn selection_is_bounded_full_identity_and_canonical_before_reading() {
    let mut f = Fixture::new();
    let id = f.selected[0];
    assert_eq!(
        wideclaim::required_keys(&f.scope, f.keeper, 0, &[]),
        Err(Block::SelectionCount(0))
    );
    assert_eq!(
        wideclaim::required_keys(&f.scope, f.keeper, 0, &[id; 7]),
        Err(Block::SelectionCount(7))
    );
    assert_eq!(
        wideclaim::required_keys(&f.scope, f.keeper, 0, &[id; 2]),
        Err(Block::DuplicateSlot { index: 1 })
    );
    let bad = SlotId { faction: 6, ..id };
    assert_eq!(
        wideclaim::required_keys(&f.scope, f.keeper, 0, &[bad]),
        Err(Block::SlotPosition {
            index: 0,
            faction: 6,
            i: 0
        })
    );
    let bad = SlotId { i: 4, ..id };
    assert_eq!(
        wideclaim::required_keys(&f.scope, f.keeper, 0, &[bad]),
        Err(Block::SlotPosition {
            index: 0,
            faction: 0,
            i: 4
        })
    );
    let mut foreign_world = *id.dest.world().as_bytes();
    foreign_world[31] ^= 1;
    let bad = SlotId {
        dest: ProvinceKey::new(WorldId::new(foreign_world).unwrap(), id.dest.coord()),
        ..id
    };
    assert_eq!(
        wideclaim::required_keys(&f.scope, f.keeper, 0, &[bad]),
        Err(Block::Common(DutyBlock::World))
    );
    assert!(wr_u32(f.data(id.address(&f.scope)), AS::BELL, 11));
    assert_eq!(f.plan(), Err(Block::SlotIdentity { index: 0 }));
}

#[test]
fn six_slots_bound_read_set_repeat_anchor_metas_and_fit_packet() {
    let mut f = Fixture::new();
    let id = f.selected[0];
    for k in 1..6 {
        f.add_slot(
            SlotId {
                faction: k / 4,
                i: k % 4,
                ..id
            },
            false,
        );
    }
    let keys = f.keys();
    assert_eq!(keys.len(), 11); // Four shared + six slots + one live anchor.
    assert!(keys.len() <= wideclaim::MAX_READ_KEYS);
    let c = f.plan().unwrap();
    assert_eq!(c.instruction().accounts.len(), 17);
    assert!(c.packet_bytes() <= 1232);
    for m in c.instruction().accounts[6..].iter().step_by(2) {
        assert_eq!(m.pubkey, id.anchor(&f.scope));
    }
    let mut empty = Reads::new(80);
    assert_eq!(
        wideclaim::plan_claim_defence(&f.scope, f.keeper, 0, &f.selected, &empty),
        Step::Need(keys.clone())
    );
    empty.accounts.insert(keys[0], None);
    assert_eq!(
        wideclaim::plan_claim_defence(&f.scope, f.keeper, 0, &f.selected, &empty),
        Step::Need(keys[1..].to_vec())
    );
}

#[test]
fn six_distinct_live_anchors_reach_maximum_read_set_and_fit_packet() {
    let mut f = Fixture::new();
    let id = f.selected[0];
    for delta in 1..6 {
        f.add_slot(
            SlotId {
                bell: id.bell + delta,
                ..id
            },
            false,
        );
    }
    assert_eq!(f.keys().len(), wideclaim::MAX_READ_KEYS);
    assert_eq!(wideclaim::MAX_READ_KEYS, 16);
    let snapshot = f.snapshot(&f.keys(), true);
    let c = wideclaim::plan_snapshot(&f.scope, f.keeper, 0, &f.selected, &snapshot).unwrap();
    assert_eq!(c.instruction().accounts.len(), 17);
    let anchors: std::collections::BTreeSet<_> = c.facts().slots.iter().map(|s| s.anchor).collect();
    assert_eq!(anchors.len(), 6);
    assert_eq!(
        c.packet_bytes(),
        807,
        "widest prefix plus the existing 32-byte cushion"
    );
    assert!(c.packet_bytes() <= 1232);
    assert!(c.coherent());
}

#[test]
fn live_anchor_is_required_and_its_identity_is_checked() {
    let mut f = Fixture::new();
    let anchor = f.selected[0].anchor(&f.scope);
    let original = f.reads.accounts[&anchor].clone();
    f.reads.accounts.insert(anchor, None);
    assert_eq!(f.plan(), Err(Block::LiveAnchorRequired { index: 0 }));
    f.reads.accounts.insert(anchor, original);
    assert!(wr_u32(f.data(anchor), BA::BELL, 11));
    assert_eq!(f.plan(), Err(Block::AnchorIdentity { index: 0 }));
    assert!(wr_u32(f.data(anchor), BA::BELL, 10));
    f.data(anchor)[BA::REGION] ^= 1;
    assert_eq!(f.plan(), Err(Block::AnchorIdentity { index: 0 }));
    f.data(anchor)[BA::REGION] ^= 1;
    assert!(wr_u64(f.data(anchor), 8, ID + 1));
    assert_eq!(f.plan(), Err(Block::AnchorIdentity { index: 0 }));
}

#[test]
fn beneficiary_claimed_lateness_and_zero_refund_refuse() {
    let mut f = Fixture::new();
    let slot = f.selected[0].address(&f.scope);
    f.data(slot)[AS::BENEFICIARY] ^= 1;
    assert_eq!(f.plan(), Err(Block::WrongBeneficiary { index: 0 }));
    f.data(slot)[AS::BENEFICIARY] ^= 1;
    f.data(slot)[AS::CLAIMED] = 1;
    assert_eq!(f.plan(), Err(Block::AlreadyClaimed { index: 0 }));
    f.data(slot)[AS::CLAIMED] = 0;
    assert!(wr_u64(f.data(slot), AS::EV_SLOT, 99));
    assert_eq!(
        f.plan(),
        Err(Block::NotLate {
            index: 0,
            observed: 0,
            required: 4
        })
    );
    assert!(wr_u64(f.data(slot), AS::EV_SLOT, 103));
    assert_eq!(
        f.plan(),
        Err(Block::NotLate {
            index: 0,
            observed: 3,
            required: 4
        })
    );
    assert!(wr_u64(f.data(slot), AS::EV_SLOT, 104));
    assert!(f.plan().is_ok());
    assert!(wr_u64(f.data(slot), AS::EV_PRICE, 0));
    assert_eq!(f.plan(), Err(Block::NoRefund { index: 0 }));
}

#[test]
fn grace_boundary_and_overflow_are_checked_without_requiring_settlement() {
    let mut f = Fixture::new();
    let end = GENESIS + 10_200;
    f.reads.clock.as_mut().unwrap().unix_timestamp = end - 1;
    assert!(f.plan().is_ok());
    f.reads.clock.as_mut().unwrap().unix_timestamp = end;
    assert_eq!(
        f.plan(),
        Err(Block::WindowClosed {
            index: 0,
            now: end,
            grace_end: end
        })
    );
    let anchor = f.selected[0].anchor(&f.scope);
    assert!(wr_arr(f.data(anchor), BA::A, &i64::MAX.to_le_bytes()));
    assert_eq!(
        f.plan(),
        Err(Block::Common(DutyBlock::Overflow("claim grace")))
    );
}

#[test]
fn claim_day_uses_observed_clock_and_pinned_wide_deployment() {
    let mut f = Fixture::new();
    f.reads.clock.as_mut().unwrap().unix_timestamp = GENESIS + 144 * 600;
    assert_eq!(
        f.plan(),
        Err(Block::WrongDay {
            requested: 0,
            observed: 1
        })
    );
    f.reads.clock.as_mut().unwrap().unix_timestamp = GENESIS + 7_200;
    f.data(f.scope.season)[S::STATUS] = S::STATUS_SEEDED;
    assert!(f.plan().unwrap().status_promoted_by_clock());
    f.data(f.scope.season)[S::STATUS] = S::STATUS_ENDED;
    assert!(f.plan().is_ok());
    f.scope.deployment = None;
    assert_eq!(f.plan(), Err(Block::Common(DutyBlock::DeploymentUnpinned)));
    f.scope.deployment = Some(Deployment {
        program_version: VERSION,
        ruleset_hash: [0; 32],
    });
    assert_eq!(f.plan(), Err(Block::Common(DutyBlock::RulesetHash)));
    f.scope.deployment = Some(Deployment {
        program_version: VERSION & !wix::WIDE_EXPERIMENTAL_VERSION_BIT,
        ruleset_hash: RULESET,
    });
    let version = f.scope.deployment.unwrap().program_version;
    assert!(wr_u16(f.data(f.scope.season), S::PROGRAM_VERSION, version));
    assert_eq!(
        f.plan(),
        Err(Block::Common(DutyBlock::Season(
            "pinned version is not a wide build (version bit clear)"
        )))
    );
}

#[test]
fn shared_pool_claim_headers_and_full_identities_are_required() {
    let mut f = Fixture::new();
    let pool = f.pool();
    let good_pool = f.reads.accounts[&pool].clone();
    assert!(wr_u64(f.data(pool), 8, ID + 1));
    assert_eq!(
        f.plan(),
        Err(Block::Common(DutyBlock::NotCanonical("defence pool")))
    );
    f.reads.accounts.insert(pool, good_pool);
    f.data(pool).truncate(DP::SIZE - 1);
    assert_eq!(
        f.plan(),
        Err(Block::Common(DutyBlock::Unreadable("defence pool")))
    );
    let mut f = Fixture::new();
    f.install_claim(1, 2);
    let claim = f.claim(0);
    f.data(claim)[DC::BENEFICIARY + 31] ^= 1;
    assert_eq!(f.plan(), Err(Block::ClaimIdentity));
    f.install_claim(1, 2);
    assert!(wr_u32(f.data(claim), DC::DAY, 1));
    assert_eq!(f.plan(), Err(Block::ClaimIdentity));
    f.install_claim(1, 2);
    assert!(wr_u64(f.data(claim), 8, ID + 1));
    assert_eq!(f.plan(), Err(Block::ClaimIdentity));
    f.install_claim(1, 2);
    f.data(claim).truncate(DC::SIZE - 1);
    assert_eq!(
        f.plan(),
        Err(Block::Common(DutyBlock::Unreadable("defence claim")))
    );
}

#[test]
fn season_requires_full_handler_allocation_but_longer_records_are_allowed() {
    for length in [1_024, S::SIZE - 1] {
        let mut f = Fixture::new();
        f.data(f.scope.season).truncate(length);
        assert_eq!(
            f.plan(),
            Err(Block::Common(DutyBlock::Unreadable("season")))
        );
    }
    let mut f = Fixture::new();
    f.data(f.scope.season).extend_from_slice(&[0; 16]);
    f.data(f.pool()).extend_from_slice(&[0; 16]);
    f.install_claim(0, 0);
    f.data(f.claim(0)).extend_from_slice(&[0; 16]);
    f.data(f.selected[0].anchor(&f.scope))
        .extend_from_slice(&[0; 16]);
    assert!(f.plan().is_ok());
}

#[test]
fn counter_and_balance_overflows_block_before_any_input_change() {
    let mut f = Fixture::new();
    f.install_claim(0, u32::MAX);
    assert_eq!(
        f.plan(),
        Err(Block::Common(DutyBlock::Overflow("claim count")))
    );
    f.install_claim(0, 0);
    assert!(wr_u64(f.data(f.pool()), DP::PAID_TOTAL, u64::MAX));
    assert_eq!(
        f.plan(),
        Err(Block::Common(DutyBlock::Overflow("pool paid total")))
    );
    assert!(wr_u64(f.data(f.pool()), DP::PAID_TOTAL, 0));
    assert!(wr_u64(f.data(f.pool()), DP::CLAIMS, u64::MAX));
    assert_eq!(
        f.plan(),
        Err(Block::Common(DutyBlock::Overflow("pool claims")))
    );
    assert!(wr_u64(f.data(f.pool()), DP::CLAIMS, 0));
    f.balance(f.keeper, u64::MAX);
    let before = f.reads.clone();
    assert_eq!(
        f.plan(),
        Err(Block::Common(DutyBlock::Overflow("keeper balance")))
    );
    assert_eq!(f.reads, before);
}

#[test]
fn ordinary_rent_and_keeper_shape_are_explicit_boundaries() {
    let mut f = Fixture::new();
    f.reads.rent = None;
    assert_eq!(
        f.plan(),
        Err(Block::Common(DutyBlock::RentSysvarMissing("defence claim")))
    );
    let mut f = Fixture::new();
    f.reads
        .accounts
        .get_mut(&f.keeper)
        .unwrap()
        .as_mut()
        .unwrap()
        .owner = address(99);
    assert_eq!(f.plan(), Err(Block::KeeperShape));
    assert_eq!(
        wideclaim::required_keys(&f.scope, f.scope.season, 0, &f.selected),
        Err(Block::KeeperAlias)
    );
    assert_eq!(
        wideclaim::required_keys(&f.scope, fclient::addr::system_program(), 0, &f.selected),
        Err(Block::KeeperAlias)
    );
}

#[test]
fn snapshot_candidate_is_immutable_and_edited_reads_lose_coherence() {
    let f = Fixture::new();
    let snap = f.snapshot(&f.keys(), true);
    let c = wideclaim::plan_snapshot(&f.scope, f.keeper, 0, &f.selected, &snap).unwrap();
    assert!(c.coherent());
    assert_eq!(c.snapshot().unwrap().context_slot(), 900);
    assert_eq!(c.snapshot().unwrap().min_slot(), 80);
    assert!(c.snapshot().unwrap().rent_included());
    let mut changed_ix = c.instruction().clone();
    changed_ix.data[0] ^= 1;
    let mut changed_facts = c.facts().clone();
    changed_facts.predicted_paid = 0;
    assert_ne!(changed_ix, *c.instruction());
    assert_ne!(changed_facts, *c.facts());
    for changed in 0..5 {
        let mut reads = snap.reads();
        match changed {
            0 => reads.min_slot += 1,
            1 => reads.clock.as_mut().unwrap().unix_timestamp += 1,
            2 => reads.rent.as_mut().unwrap().burn_percent ^= 1,
            3 => {
                reads
                    .accounts
                    .get_mut(&f.keeper)
                    .unwrap()
                    .as_mut()
                    .unwrap()
                    .lamports += 1
            }
            _ => {
                reads.accounts.insert(address(222), None);
            }
        }
        assert!(reads.coherent_snapshot().is_none());
        let edited = done(wideclaim::plan_claim_defence(
            &f.scope,
            f.keeper,
            0,
            &f.selected,
            &reads,
        ))
        .unwrap();
        assert!(!edited.coherent() && edited.snapshot().is_none());
    }
    // A pure snapshot plan still uses only the original sealed response.
    assert_eq!(
        wideclaim::plan_snapshot(&f.scope, f.keeper, 0, &f.selected, &snap).unwrap(),
        c
    );
}

#[test]
fn snapshot_requires_same_response_rent_all_keys_and_current_claim_day() {
    let mut f = Fixture::new();
    let keys = f.keys();
    let no_rent = f.snapshot(&keys, false);
    assert_eq!(
        wideclaim::plan_snapshot(&f.scope, f.keeper, 0, &f.selected, &no_rent),
        Err(Block::SnapshotRentRequired)
    );
    let incomplete = f.snapshot(&keys[1..], true);
    assert_eq!(
        wideclaim::plan_snapshot(&f.scope, f.keeper, 0, &f.selected, &incomplete),
        Err(Block::SnapshotIncomplete(vec![keys[0]]))
    );
    f.reads.clock.as_mut().unwrap().unix_timestamp = GENESIS + 86_400;
    let moved_day = f.snapshot(&keys, true);
    assert_eq!(
        wideclaim::plan_snapshot(&f.scope, f.keeper, 0, &f.selected, &moved_day),
        Err(Block::WrongDay {
            requested: 0,
            observed: 1
        })
    );
}
