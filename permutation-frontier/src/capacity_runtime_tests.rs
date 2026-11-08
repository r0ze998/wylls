//! Key-free runtime harness of workstream 09's capacity preview
//! (`capacity-preview`): the program's real `dispatch` over hand-built
//! accounts, in `map_growth_runtime_tests`'s world (its Season, stubs,
//! clock and serial lock; a child module, as `wide_land` is).
//!
//! A's first home (PlaceHome, the deployed instruction) is the facility;
//! its production is set to three workshop copies (as finished Builds
//! leave it). B is a Citizen with a Vault in the facility's province (the
//! bytes BuildVault leaves). Then OpenCapacityPool, LendCapacity,
//! GrantCapacity, ReserveCapacity, DepositToJob, SettleJob, ClaimJob,
//! RetireJob, and the refusals, the resends and a capture.
//!
//! **No key is generated, derived or signed.** Every address is a literal
//! or the with-seed address the program computes (`sha256`): the Season
//! PDA, the Citizen, the Holding, the Vault, the pool and job accounts.
//! `is_signer` is set by the test, as the runtime would after verifying a
//! signature (the same limit as a LiteSVM run with `sigverify` off). This
//! is the host build: no compute budget, no SBF loader.

use super::*;
use frontier_abi::capacity::{self as fc, CapData};
use frontier_abi::v2::layout::s1::vault as VA;
use permutation_rules::frontier::arms::{ARMS, WORKSHOP_DELTA};
use permutation_rules::frontier::capacity as cap;
use permutation_rules::frontier::holding::Resource;

use crate::layout::holding2 as H2;
use crate::proc::holding::{read_holding, write_holding};

const POOL_SPACE: usize = cap::layout::pool::SIZE + fc::RENT_TO_LEN;
const JOB_SPACE: usize = crate::proc::capacity::JOB_SPACE;
const VAULT_TILE: u8 = 22;

fn err(code: cap::CapError) -> u32 {
    fc::program_error(code.code())
}

struct Cap {
    w: World,
    c: ProvinceCoord,
    a: Member,
    b: Member,
    holding: AccountInfo<'static>,
    pool: AccountInfo<'static>,
    vault: AccountInfo<'static>,
    jobs: HashMap<(u32, u32), AccountInfo<'static>>,
}

/// B's vault on a tile of `c`, holding `ore` and `wood` (milli).
fn vault_bytes(c: ProvinceCoord, owner: &Member, ore: i64, wood: i64) -> Vec<u8> {
    let mut d = vec![0u8; K2::Vault.size()];
    assert!(write_header(&mut d, K2::Vault, SEASON_ID));
    put(&mut d, VA::P, &(c.p as i16).to_le_bytes());
    put(&mut d, VA::Q, &(c.q as i16).to_le_bytes());
    d[VA::TILE] = VAULT_TILE;
    d[VA::STATE] = VA::STATE_LIVE;
    d[VA::GEN] = 1;
    put(&mut d, VA::OWNER_CITIZEN, &owner.key);
    put(
        &mut d,
        VA::OWNER_TAG,
        &citizen_tag(&owner.key).to_le_bytes(),
    );
    put(&mut d, VA::CAP, &(500 * MILLI).to_le_bytes());
    put(
        &mut d,
        VA::store(Resource::Ore as usize),
        &ore.to_le_bytes(),
    );
    put(
        &mut d,
        VA::store(Resource::Wood as usize),
        &wood.to_le_bytes(),
    );
    put(&mut d, VA::RENT_TO, &PAYER);
    d
}

impl Cap {
    /// A's home at an off-wedge province with three workshop copies, B a
    /// citizen with a vault there (120 ore, 60 wood).
    fn new() -> Cap {
        let mut w = World::new();
        let (c, nation) = off_wedge_province();
        let a = w.member(WALLET_A, nation);
        let b = w.member(WALLET_B, nation);
        assert_eq!(w.place_home(&a, c, 0), Ok(()));
        let holding = w.holding(c, 0);
        {
            let now = GENESIS + 600;
            let mut d = holding.try_borrow_mut_data().unwrap();
            let mut h = read_holding(&d).unwrap();
            h.production[ARMS as usize] = 3 * WORKSHOP_DELTA;
            write_holding(&mut d, &h, now).unwrap();
        }
        let gen = w.holding_data(c, 0)[H::GEN];
        let pool_key = fc::pool(&w.ctx, c.p as i16, c.q as i16, 0, gen);
        let pool = info(leak(pool_key, SYSTEM, vec![], POOL_SPACE, 0), false, true);
        let vkey = frontier_abi::v2::addr::vault(&w.ctx, c.p, c.q, VAULT_TILE);
        let vault = info(
            leak(
                vkey,
                PROGRAM,
                vault_bytes(c, &b, 120 * MILLI, 60 * MILLI),
                0,
                BIG,
            ),
            false,
            true,
        );
        Cap {
            w,
            c,
            a,
            b,
            holding,
            pool,
            vault,
            jobs: HashMap::new(),
        }
    }

    fn gen(&mut self) -> u8 {
        self.w.holding_data(self.c, 0)[H::GEN]
    }

    fn job(&mut self, grant: u32, job: u32) -> AccountInfo<'static> {
        let c = self.c;
        let gen = self.pool_data().map_or(1, |p| p.facility.gen);
        let key = fc::job(&self.w.ctx, c.p as i16, c.q as i16, 0, gen, grant, job);
        self.jobs
            .entry((grant, job))
            .or_insert_with(|| info(leak(key, SYSTEM, vec![], JOB_SPACE, 0), false, true))
            .clone()
    }

    /// The player prologue of `m`, then `rest`.
    fn as_player(&self, m: &Member, rest: &[AccountInfo<'static>]) -> Vec<AccountInfo<'static>> {
        let mut a = vec![
            wallet(m.wallet, true, false, 0),
            self.w.payer.clone(),
            self.w.season.clone(),
            m.citizen.clone(),
        ];
        a.extend_from_slice(rest);
        a
    }

    /// The keeper prologue (anyone pays), then `rest`.
    fn as_keeper(&self, rest: &[AccountInfo<'static>]) -> Vec<AccountInfo<'static>> {
        let mut a = vec![wallet(ANYONE, true, true, BIG), self.w.season.clone()];
        a.extend_from_slice(rest);
        a
    }

    fn open(&self, m: &Member, policies: [u8; 3]) -> Result<(), u32> {
        let a = self.as_player(
            m,
            &[
                with_writable(&self.holding, false),
                self.pool.clone(),
                self.w.system.clone(),
            ],
        );
        run(&a, &CapData::OpenCapacityPool { policies }.encode())
    }

    fn lend(&self, m: &Member, units: u32, seq: u32, lend: bool) -> Result<(), u32> {
        let a = self.as_player(m, &[self.holding.clone(), self.pool.clone()]);
        let x = if lend {
            CapData::LendCapacity { units, seq }
        } else {
            CapData::ReclaimCapacity { units, seq }
        };
        run(&a, &x.encode())
    }

    fn grant(&self, m: &Member, grant: u32, user: &Member, until: i64) -> Result<(), u32> {
        let a = self.as_player(m, &[with_writable(&self.holding, false), self.pool.clone()]);
        run(
            &a,
            &CapData::GrantCapacity {
                grant,
                user: user.key,
                recipe: cap::RECIPE_ARMS,
                max_units: 2,
                max_output: 100 * MILLI,
                from: GENESIS,
                until,
            }
            .encode(),
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn reserve(
        &mut self,
        m: &Member,
        grant: u32,
        job: u32,
        units: u32,
        start: i64,
        end: i64,
        max_output: i64,
    ) -> Result<(), u32> {
        let j = self.job(grant, job);
        let a = self.as_player(
            m,
            &[
                with_writable(&self.holding, false),
                self.pool.clone(),
                j,
                self.w.system.clone(),
            ],
        );
        run(
            &a,
            &CapData::ReserveCapacity {
                grant,
                job,
                units,
                start,
                end,
                max_output,
            }
            .encode(),
        )
    }

    fn deposit(
        &mut self,
        m: &Member,
        job: (u32, u32),
        deposit: u64,
        r: Resource,
        amount: i64,
        vault: &AccountInfo<'static>,
    ) -> Result<(), u32> {
        let j = self.job(job.0, job.1);
        let a = self.as_player(
            m,
            &[
                with_writable(&self.holding, false),
                self.pool.clone(),
                j,
                vault.clone(),
            ],
        );
        run(
            &a,
            &CapData::DepositToJob {
                grant: job.0,
                job: job.1,
                deposit,
                resource: r as u8,
                amount,
                source: fc::SOURCE_VAULT,
                slot: 0,
                order: 0,
            }
            .encode(),
        )
    }

    fn settle(&mut self, job: (u32, u32)) -> Result<(), u32> {
        let j = self.job(job.0, job.1);
        let a = self.as_keeper(&[with_writable(&self.holding, false), self.pool.clone(), j]);
        run(
            &a,
            &CapData::SettleJob {
                grant: job.0,
                job: job.1,
            }
            .encode(),
        )
    }

    fn claim(&mut self, m: &Member, job: (u32, u32)) -> Result<(), u32> {
        let j = self.job(job.0, job.1);
        let a = self.as_player(
            m,
            &[
                with_writable(&self.holding, false),
                self.pool.clone(),
                j,
                self.vault.clone(),
            ],
        );
        run(
            &a,
            &CapData::ClaimJob {
                grant: job.0,
                job: job.1,
            }
            .encode(),
        )
    }

    fn retire(&mut self, job: (u32, u32)) -> Result<(), u32> {
        let j = self.job(job.0, job.1);
        let a = self.as_keeper(&[self.pool.clone(), j, self.w.payer.clone()]);
        run(
            &a,
            &CapData::RetireJob {
                grant: job.0,
                job: job.1,
            }
            .encode(),
        )
    }

    fn lose(&mut self, jobs: &[(u32, u32)]) -> Result<(), u32> {
        let mut rest = vec![self.holding.clone(), self.pool.clone()];
        for k in jobs {
            rest.push(self.job(k.0, k.1));
        }
        let a = self.as_keeper(&rest);
        run(&a, &CapData::RecordFacilityLoss.encode())
    }

    fn pool_data(&self) -> Option<cap::Pool> {
        cap::Pool::decode(&self.pool.try_borrow_data().ok()?)
    }

    fn job_data(&mut self, job: (u32, u32)) -> Option<cap::Job> {
        let j = self.job(job.0, job.1);
        let d = j.try_borrow_data().ok()?;
        cap::Job::decode(&d)
    }

    fn vault_store(&self, r: Resource) -> i64 {
        rd_i64(
            &self.vault.try_borrow_data().unwrap(),
            VA::store(r as usize),
        )
    }

    fn lent_in_holding(&mut self) -> u32 {
        rd_u32(&self.w.holding_data(self.c, 0), H2::LENT_WORKSHOPS)
    }
}

/// The whole path: A opens a pool, lends two copies and grants them to B;
/// B reserves both for three hours, brings 40 ore and 20 wood from its
/// vault in the province, the copies make 20 arms over real time; B claims
/// them and the unused materials back into its vault; the job is retired
/// and its rent goes back.
#[test]
fn capacity_a_lent_workshop_makes_bs_arms_from_bs_goods() {
    let _g = begin();
    let mut t = Cap::new();
    let (a, b) = (t.a.clone_member(), t.b.clone_member());
    assert_eq!(t.open(&a, [0, 0, 0]), Ok(()));
    let p = t.pool_data().expect("a pool");
    assert_eq!((p.owner, p.lent, p.facility.gen), (a.key, 0, t.gen()));
    assert_eq!(t.lend(&a, 2, 0, true), Ok(()));
    assert_eq!(t.lent_in_holding(), 2, "the Holding runs one copy now");
    assert_eq!(t.pool_data().unwrap().lent, 2);
    let until = GENESIS + 10 * 86_400;
    assert_eq!(t.grant(&a, 1, &b, until), Ok(()));
    let start = GENESIS + 3_600 * 2;
    let job = (1, 1);
    assert_eq!(
        t.reserve(&b, 1, 1, 2, start, start + 3 * 3_600, 20 * MILLI),
        Ok(())
    );
    let vault = t.vault.clone();
    assert_eq!(
        t.deposit(&b, job, 1, Resource::Ore, 40 * MILLI, &vault),
        Ok(())
    );
    assert_eq!(
        t.deposit(&b, job, 2, Resource::Wood, 20 * MILLI, &vault),
        Ok(())
    );
    assert_eq!(t.vault_store(Resource::Ore), 80 * MILLI);
    assert_eq!(t.vault_store(Resource::Wood), 40 * MILLI);
    // A resend of the same deposit changes nothing.
    assert_eq!(
        t.deposit(&b, job, 1, Resource::Ore, 40 * MILLI, &vault),
        Ok(())
    );
    assert_eq!(t.vault_store(Resource::Ore), 80 * MILLI);
    // Half way: 2 copies × 4 arms/h × 1.5 h = 12 arms.
    crate::prologue::set_test_clock(start + 5_400, 2_000);
    assert_eq!(t.settle(job), Ok(()));
    assert_eq!(t.job_data(job).unwrap().settled, 12 * MILLI);
    // After the window: the job made its 20 arms (2.5 h of 3).
    crate::prologue::set_test_clock(start + 4 * 3_600, 3_000);
    assert_eq!(t.claim(&b, job), Ok(()));
    let j = t.job_data(job).unwrap();
    assert_eq!(
        (j.settled, j.claimed, j.refunded),
        (20 * MILLI, 20 * MILLI, true)
    );
    assert!(j.accounts().inputs.iter().all(|x| x.balanced()));
    assert_eq!(t.vault_store(ARMS), 20 * MILLI, "B's arms");
    // 40 ore − 2×20 used, 20 wood − 20 used: nothing left to give back.
    assert_eq!(t.vault_store(Resource::Ore), 80 * MILLI);
    assert_eq!(t.vault_store(Resource::Wood), 40 * MILLI);
    // A resent claim changes nothing.
    assert_eq!(t.claim(&b, job), Ok(()));
    assert_eq!(t.vault_store(ARMS), 20 * MILLI);
    // Retired: the account closes, its rent goes back to the payer.
    let payer_before = t.w.payer.lamports();
    assert_eq!(t.retire(job), Ok(()));
    assert!(t.job_data(job).is_none());
    assert!(t.w.payer.lamports() > payer_before);
    assert!(t.pool_data().unwrap().occ.is_empty());
    // The retired number is spent.
    assert_eq!(
        t.reserve(&b, 1, 1, 1, start + 86_400, start + 86_400 + 3_600, MILLI),
        Err(err(cap::CapError::Retired))
    );
}

/// Refusals: a stranger lending, more copies than lent, someone else's
/// deposit, a vault in another province, a deposit after the start, and a
/// claim that does not fit the vault.
#[test]
fn capacity_refusals_change_nothing() {
    let _g = begin();
    let mut t = Cap::new();
    let (a, b) = (t.a.clone_member(), t.b.clone_member());
    assert_eq!(t.open(&b, [0, 0, 0]), Err(err(cap::CapError::NotOwner)));
    assert_eq!(
        t.open(&a, [3, 0, 0]),
        Err(E::BadData as u32),
        "no such policy"
    );
    assert_eq!(t.open(&a, [0, 0, 0]), Ok(()));
    assert_eq!(t.open(&a, [0, 0, 0]), Ok(()), "a resend");
    assert_eq!(t.open(&a, [1, 0, 0]), Err(err(cap::CapError::Conflict)));
    assert_eq!(t.lend(&b, 1, 0, true), Err(err(cap::CapError::NotOwner)));
    assert_eq!(
        t.lend(&a, 4, 0, true),
        Err(err(cap::CapError::NotEnoughWorkshops))
    );
    assert_eq!(t.lend(&a, 1, 0, true), Ok(()));
    assert_eq!(t.lend(&a, 1, 0, true), Ok(()), "a resend of seq 0");
    assert_eq!(t.pool_data().unwrap().lent, 1);
    assert_eq!(t.grant(&a, 1, &b, GENESIS + 10 * 86_400), Ok(()));
    let start = GENESIS + 7_200;
    assert_eq!(
        t.reserve(&b, 1, 1, 2, start, start + 3_600, 4 * MILLI),
        Err(err(cap::CapError::CapacityExceeded))
    );
    assert_eq!(
        t.reserve(&a, 1, 1, 1, start, start + 3_600, 4 * MILLI),
        Err(err(cap::CapError::NotUser))
    );
    assert_eq!(
        t.reserve(&b, 1, 1, 1, start, start + 3_600, 4 * MILLI),
        Ok(())
    );
    let job = (1, 1);
    let vault = t.vault.clone();
    // A's attempt to deposit into B's job, from B's vault.
    assert_eq!(
        t.deposit(&a, job, 1, Resource::Ore, MILLI, &vault),
        Err(E::NotOwner as u32),
        "the vault is B's"
    );
    // B's vault in another province.
    let far = ProvinceCoord::new(t.c.p + 1, t.c.q);
    let fkey = frontier_abi::v2::addr::vault(&t.w.ctx, far.p, far.q, VAULT_TILE);
    let fv = info(
        leak(fkey, PROGRAM, vault_bytes(far, &b, 50 * MILLI, 0), 0, BIG),
        false,
        true,
    );
    assert_eq!(
        t.deposit(&b, job, 1, Resource::Ore, MILLI, &fv),
        Err(E::BadAddress as u32)
    );
    // More than the vault holds: refused whole.
    assert_eq!(
        t.deposit(&b, job, 1, Resource::Ore, 500 * MILLI, &vault),
        Err(err(cap::CapError::Custody))
    );
    assert_eq!(t.vault_store(Resource::Ore), 120 * MILLI);
    assert!(t.job_data(job).unwrap().deposits.is_empty());
    // Reclaiming the copy the booked job holds is blocked.
    assert_eq!(
        t.lend(&a, 1, 1, false),
        Err(err(cap::CapError::ReclaimBlocked))
    );
    // After the start a deposit is too late; the job, fed nothing, holds no
    // copy any more, so the copy can be taken back.
    crate::prologue::set_test_clock(start + 1, 2_000);
    assert_eq!(
        t.deposit(&b, job, 1, Resource::Ore, MILLI, &vault),
        Err(err(cap::CapError::AlreadyStarted))
    );
    assert_eq!(t.lend(&a, 1, 1, false), Ok(()));
    assert_eq!((t.pool_data().unwrap().lent, t.lent_in_holding()), (0, 0));
}

/// A capture of the facility (the core's SettleCapture leaves the Holding
/// at the next generation, its previous one and the capture bell): the
/// loss is recorded by anyone; the captor takes what is at the facility
/// (the provisional CaptorTakesAll), into the Holding's stores; the user
/// claims nothing; the pool takes no new work.
#[test]
fn capacity_a_captor_takes_what_is_at_the_facility() {
    let _g = begin();
    let mut t = Cap::new();
    let (a, b) = (t.a.clone_member(), t.b.clone_member());
    assert_eq!(t.open(&a, [0, 0, 0]), Ok(()));
    assert_eq!(t.lend(&a, 2, 0, true), Ok(()));
    assert_eq!(t.grant(&a, 1, &b, GENESIS + 10 * 86_400), Ok(()));
    let start = GENESIS + 7_200;
    let job = (1, 1);
    assert_eq!(
        t.reserve(&b, 1, 1, 2, start, start + 3 * 3_600, 20 * MILLI),
        Ok(())
    );
    let vault = t.vault.clone();
    assert_eq!(
        t.deposit(&b, job, 1, Resource::Ore, 40 * MILLI, &vault),
        Ok(())
    );
    assert_eq!(
        t.deposit(&b, job, 2, Resource::Wood, 20 * MILLI, &vault),
        Ok(())
    );
    // Captured one hour in, at the start of a bell, by X's citizen.
    let bell = ((start + 3_600 - GENESIS) / 600) as u32;
    let captor = [0x77u8; 32];
    let gen = t.gen();
    {
        let mut d = t.holding.try_borrow_mut_data().unwrap();
        d[H2::PREV_GEN] = gen;
        d[H::GEN] = gen.wrapping_add(1);
        put(&mut d, H2::CAPTURED_BELL, &bell.to_le_bytes());
        put(&mut d, H::OWNER_CITIZEN, &captor);
        put(&mut d, H2::LENT_WORKSHOPS, &0u32.to_le_bytes());
    }
    let at = GENESIS + 600 * bell as i64;
    crate::prologue::set_test_clock(at + 900, 2_000);
    // The captor's stores as they stand at the loss's own time (its
    // workshops run meanwhile).
    let ore_before = read_holding(&t.w.holding_data(t.c, 0))
        .unwrap()
        .stock_at(at + 900)[Resource::Ore as usize];
    // A user claim before the loss is recorded is refused (the pool is of a
    // past generation).
    assert_eq!(t.claim(&b, job), Err(err(cap::CapError::WrongGeneration)));
    // The loss needs every job of the pool.
    assert_eq!(t.lose(&[]), Err(err(cap::CapError::UnknownJob)));
    assert_eq!(t.lose(&[job]), Ok(()));
    let p = t.pool_data().unwrap();
    assert_eq!((p.lost_at, p.captor), (Some(at), Some(captor)));
    let j = t.job_data(job).unwrap();
    // One hour at 8 arms/h made 8 arms; 16 ore and 8 wood used.
    assert_eq!((j.settled, j.forfeited_out), (8 * MILLI, 8 * MILLI));
    assert_eq!(j.forfeited_in, [24 * MILLI, 12 * MILLI]);
    let h = read_holding(&t.w.holding_data(t.c, 0)).unwrap();
    assert_eq!(
        h.stores[Resource::Ore as usize].value - ore_before,
        24 * MILLI
    );
    // B claims nothing; a resent loss changes nothing.
    assert_eq!(t.claim(&b, job), Ok(()));
    assert_eq!(t.vault_store(ARMS), 0);
    assert_eq!(t.lose(&[job]), Ok(()));
    assert_eq!(
        t.reserve(&b, 1, 2, 1, at + 86_400, at + 90_000, MILLI),
        Err(err(cap::CapError::FacilityGone))
    );
}

/// A default build never sees these bytes: only this preview dispatches
/// them, and a Season of another build is refused.
#[test]
fn capacity_only_this_build_and_its_seasons() {
    let _g = begin();
    assert_eq!(
        crate::PROGRAM_VERSION & fc::CAPACITY_PREVIEW_VERSION_BIT,
        fc::CAPACITY_PREVIEW_VERSION_BIT
    );
    let t = Cap::new();
    let a = t.a.clone_member();
    {
        let mut d = t.w.season.try_borrow_mut_data().unwrap();
        put(
            &mut d,
            S::PROGRAM_VERSION,
            &frontier_abi::v2::presets::PROGRAM_VERSION_S1.to_le_bytes(),
        );
    }
    assert_eq!(t.open(&a, [0, 0, 0]), Err(E::RulesetMismatch as u32));
}

impl Member {
    fn clone_member(&self) -> Member {
        Member {
            wallet: self.wallet,
            faction: self.faction,
            shard_i: self.shard_i,
            key: self.key,
            citizen: self.citizen.clone(),
        }
    }
}

// ------------------------------------------------------------ lots

/// A job fed from another owner's lot (workstream 10's custody): M's ore in
/// A's vault in the facility's province, a use order of 40 for B. B takes
/// 31 ore from the lot (whole units, `LOT_CONSUMED` on the lot's chain) and
/// its own wood; the job makes 15.25 arms, using 30.5 ore; B's arms and
/// wood go to B, the 0.5 ore left goes back to the lot owed (a sub-unit
/// rest), the job cannot retire while it owes; a second lot or B's own ore
/// is two sources, refused (undecided).
#[cfg(feature = "custody-preview")]
#[test]
fn capacity_lot_ore_feeds_a_job_and_what_it_does_not_use_goes_back() {
    use permutation_rules::frontier::custody::{self as kc, Lot, OrderSpec, PlaceRef, VaultView};
    let _g = begin();
    let mut t = Cap::new();
    let (a, b) = (t.a.clone_member(), t.b.clone_member());
    let nation = a.faction;
    let m = t.w.member(WALLET_S, nation);
    assert_eq!(t.open(&a, [0, 0, 0]), Ok(()));
    assert_eq!(t.lend(&a, 2, 0, true), Ok(()));
    assert_eq!(t.grant(&a, 1, &b, GENESIS + 10 * 86_400), Ok(()));
    let start = GENESIS + 7_200;
    let job = (1, 1);
    assert_eq!(
        t.reserve(&b, 1, 1, 2, start, start + 3 * 3_600, 15_250),
        Ok(())
    );
    // A's vault (the custodian) on another tile of the province, M's lot in
    // it: 100 ore, a use order of 40 for B.
    let c = t.c;
    let tile = VAULT_TILE + 1;
    let actor = |mm: &Member| kc::Actor {
        citizen: mm.key,
        tag: citizen_tag(&mm.key),
        by_session: false,
    };
    let mut v = VaultView {
        p: c.p as i16,
        q: c.q as i16,
        tile,
        gen: 1,
        live: true,
        owner: a.key,
        owner_tag: citizen_tag(&a.key),
        stores: [0; 8],
        cap: 500 * MILLI,
        quota: [0; 8],
        lots: 0,
    };
    let bell = 1;
    let mut lot: Lot = kc::open(
        &mut v,
        &actor(&a),
        (m.key, citizen_tag(&m.key)),
        Resource::Ore as u8,
        200 * MILLI,
        bell,
        PAYER,
    )
    .unwrap();
    kc::begin_inbound(&v, &mut lot, (citizen_tag(&m.key), 1), 100 * MILLI).unwrap();
    kc::finish_inbound(Some(&v), &mut lot, (citizen_tag(&m.key), 1), 100 * MILLI).unwrap();
    let spec = OrderSpec {
        kind: kc::ORDER_USE,
        grantee: b.key,
        qty: 40 * MILLI,
        expires_bell: 1_000,
        dst: PlaceRef::default(),
        purpose: fc::PURPOSE_WORKSHOP_ARMS,
    };
    let nonce = lot.nonce;
    let order = kc::set_order(&v, &mut lot, &actor(&m), 0, nonce, &spec, bell).unwrap();
    let mut vd = vault_bytes(c, &a, 0, 0);
    vd[VA::TILE] = tile;
    for i in 0..8 {
        put(&mut vd, VA::custody_quota(i), &v.quota[i].to_le_bytes());
    }
    put(&mut vd, VA::CUSTODY_LOTS, &v.lots.to_le_bytes());
    let vkey = frontier_abi::v2::addr::vault(&t.w.ctx, c.p, c.q, tile);
    let lot_vault = info(leak(vkey, PROGRAM, vd, 0, BIG), false, true);
    let mut ld = vec![0u8; frontier_abi::v2::layout::s1::lot::SIZE];
    assert!(write_header(&mut ld, K2::Lot, SEASON_ID));
    lot.encode(&mut ld).unwrap();
    let lkey = frontier_abi::v2::addr::lot(
        &t.w.ctx,
        lot.p,
        lot.q,
        lot.tile,
        lot.vault_gen,
        lot.owner_tag,
        lot.resource,
    );
    let lot_ai = info(leak(lkey, PROGRAM, ld, 0, BIG), false, true);
    let lot_now = |ai: &AccountInfo| Lot::decode(&ai.try_borrow_data().unwrap()).unwrap();

    let jai = t.job(1, 1);
    let from_lot = |t: &Cap,
                    deposit: u64,
                    amount: i64,
                    lv: &AccountInfo<'static>,
                    la: &AccountInfo<'static>| {
        let a = t.as_player(
            &b,
            &[
                with_writable(&t.holding, false),
                t.pool.clone(),
                jai.clone(),
                lv.clone(),
                la.clone(),
            ],
        );
        run(
            &a,
            &CapData::DepositToJob {
                grant: 1,
                job: 1,
                deposit,
                resource: Resource::Ore as u8,
                amount,
                source: fc::SOURCE_LOT,
                slot: 0,
                order,
            }
            .encode(),
        )
    };
    records();
    // Not whole units: the lot refuses (workstream 10's kernel).
    assert_eq!(
        from_lot(&t, 1, 31_500, &lot_vault, &lot_ai),
        Err(E::BadData as u32)
    );
    assert_eq!(from_lot(&t, 1, 31 * MILLI, &lot_vault, &lot_ai), Ok(()));
    let l = lot_now(&lot_ai);
    assert_eq!((l.held, l.consumed), (69 * MILLI, 31 * MILLI));
    let recs = records();
    assert_eq!(
        kinds_of(&recs),
        vec![AnyKind::Cq(CqKind::LOT_CONSUMED)],
        "the lot's own record"
    );
    // A resend changes nothing (the lot is not consumed twice).
    assert_eq!(from_lot(&t, 1, 31 * MILLI, &lot_vault, &lot_ai), Ok(()));
    assert_eq!(lot_now(&lot_ai).consumed, 31 * MILLI);
    // B's own ore into the same job: two sources, refused.
    let vault = t.vault.clone();
    assert_eq!(
        t.deposit(&b, job, 2, Resource::Ore, MILLI, &vault),
        Err(E::NotImplemented as u32)
    );
    // B's own wood is fine.
    assert_eq!(
        t.deposit(&b, job, 3, Resource::Wood, 20 * MILLI, &vault),
        Ok(())
    );
    // After the window: 15.25 arms made, 30.5 ore and 15.25 wood used.
    crate::prologue::set_test_clock(start + 4 * 3_600, 3_000);
    let claim = |t: &mut Cap, extra: &[AccountInfo<'static>]| {
        let j = t.job(1, 1);
        let mut rest = vec![
            with_writable(&t.holding, false),
            t.pool.clone(),
            j,
            t.vault.clone(),
        ];
        rest.extend_from_slice(extra);
        let a = t.as_player(&b, &rest);
        run(&a, &CapData::ClaimJob { grant: 1, job: 1 }.encode())
    };
    let wood_before = t.vault_store(Resource::Wood);
    assert_eq!(
        claim(&mut t, &[with_writable(&lot_vault, false), lot_ai.clone()]),
        Ok(())
    );
    assert_eq!(t.vault_store(ARMS), 15_250, "B's arms");
    assert_eq!(
        t.vault_store(Resource::Wood) - wood_before,
        4_750,
        "B's wood back"
    );
    assert_eq!(
        t.vault_store(Resource::Ore),
        120 * MILLI,
        "none of the lot's ore to B"
    );
    let link = crate::proc::capacity::link_of(&t.job(1, 1).try_borrow_data().unwrap()).unwrap();
    assert_eq!((link.taken, link.returned, link.owed), (31 * MILLI, 0, 500));
    let l = lot_now(&lot_ai);
    assert_eq!(l.consumed, 31 * MILLI, "a sub-unit rest cannot go back yet");
    assert_eq!(l.in_total, l.held + l.out_total + l.consumed + l.forfeited);
    // The job keeps what it owes: it cannot retire.
    assert_eq!(t.retire(job), Err(err(cap::CapError::NotRetirable)));
}

/// The same with a whole unit to give back: 30 ore taken, 14.5 arms made
/// (29 ore used), the one unit left goes back into the lot un-consumed and
/// the job retires.
#[cfg(feature = "custody-preview")]
#[test]
fn capacity_whole_units_go_back_into_the_lot_unconsumed() {
    use permutation_rules::frontier::custody::{self as kc, Lot, OrderSpec, PlaceRef, VaultView};
    let _g = begin();
    let mut t = Cap::new();
    let (a, b) = (t.a.clone_member(), t.b.clone_member());
    let m = t.w.member(WALLET_S, a.faction);
    assert_eq!(t.open(&a, [0, 0, 0]), Ok(()));
    assert_eq!(t.lend(&a, 2, 0, true), Ok(()));
    assert_eq!(t.grant(&a, 1, &b, GENESIS + 10 * 86_400), Ok(()));
    let start = GENESIS + 7_200;
    assert_eq!(
        t.reserve(&b, 1, 1, 2, start, start + 3 * 3_600, 14_500),
        Ok(())
    );
    let c = t.c;
    let tile = VAULT_TILE + 1;
    let actor = |mm: &Member| kc::Actor {
        citizen: mm.key,
        tag: citizen_tag(&mm.key),
        by_session: false,
    };
    let mut v = VaultView {
        p: c.p as i16,
        q: c.q as i16,
        tile,
        gen: 1,
        live: true,
        owner: a.key,
        owner_tag: citizen_tag(&a.key),
        stores: [0; 8],
        cap: 500 * MILLI,
        quota: [0; 8],
        lots: 0,
    };
    let mut lot: Lot = kc::open(
        &mut v,
        &actor(&a),
        (m.key, citizen_tag(&m.key)),
        Resource::Ore as u8,
        200 * MILLI,
        1,
        PAYER,
    )
    .unwrap();
    kc::begin_inbound(&v, &mut lot, (citizen_tag(&m.key), 1), 100 * MILLI).unwrap();
    kc::finish_inbound(Some(&v), &mut lot, (citizen_tag(&m.key), 1), 100 * MILLI).unwrap();
    let spec = OrderSpec {
        kind: kc::ORDER_USE,
        grantee: b.key,
        qty: 40 * MILLI,
        expires_bell: 1_000,
        dst: PlaceRef::default(),
        purpose: fc::PURPOSE_WORKSHOP_ARMS,
    };
    let nonce = lot.nonce;
    let order = kc::set_order(&v, &mut lot, &actor(&m), 0, nonce, &spec, 1).unwrap();
    let mut vd = vault_bytes(c, &a, 0, 0);
    vd[VA::TILE] = tile;
    for i in 0..8 {
        put(&mut vd, VA::custody_quota(i), &v.quota[i].to_le_bytes());
    }
    put(&mut vd, VA::CUSTODY_LOTS, &v.lots.to_le_bytes());
    let lot_vault = info(
        leak(
            frontier_abi::v2::addr::vault(&t.w.ctx, c.p, c.q, tile),
            PROGRAM,
            vd,
            0,
            BIG,
        ),
        false,
        true,
    );
    let mut ld = vec![0u8; frontier_abi::v2::layout::s1::lot::SIZE];
    assert!(write_header(&mut ld, K2::Lot, SEASON_ID));
    lot.encode(&mut ld).unwrap();
    let lkey = frontier_abi::v2::addr::lot(
        &t.w.ctx,
        lot.p,
        lot.q,
        lot.tile,
        lot.vault_gen,
        lot.owner_tag,
        lot.resource,
    );
    let lot_ai = info(leak(lkey, PROGRAM, ld, 0, BIG), false, true);
    let jai = t.job(1, 1);
    let a1 = t.as_player(
        &b,
        &[
            with_writable(&t.holding, false),
            t.pool.clone(),
            jai.clone(),
            lot_vault.clone(),
            lot_ai.clone(),
        ],
    );
    let dep = CapData::DepositToJob {
        grant: 1,
        job: 1,
        deposit: 1,
        resource: Resource::Ore as u8,
        amount: 30 * MILLI,
        source: fc::SOURCE_LOT,
        slot: 0,
        order,
    };
    assert_eq!(run(&a1, &dep.encode()), Ok(()));
    let vault = t.vault.clone();
    assert_eq!(
        t.deposit(&b, (1, 1), 2, Resource::Wood, 20 * MILLI, &vault),
        Ok(())
    );
    crate::prologue::set_test_clock(start + 4 * 3_600, 3_000);
    let a2 = t.as_player(
        &b,
        &[
            with_writable(&t.holding, false),
            t.pool.clone(),
            jai.clone(),
            t.vault.clone(),
            with_writable(&lot_vault, false),
            lot_ai.clone(),
        ],
    );
    assert_eq!(
        run(&a2, &CapData::ClaimJob { grant: 1, job: 1 }.encode()),
        Ok(())
    );
    let l = Lot::decode(&lot_ai.try_borrow_data().unwrap()).unwrap();
    assert_eq!(
        (l.held, l.consumed, l.in_total),
        (71 * MILLI, 29 * MILLI, 100 * MILLI)
    );
    let link = crate::proc::capacity::link_of(&jai.try_borrow_data().unwrap()).unwrap();
    assert_eq!(
        (link.taken, link.returned, link.owed),
        (30 * MILLI, MILLI, 0)
    );
    assert_eq!(t.vault_store(ARMS), 14_500);
    assert_eq!(t.retire((1, 1)), Ok(()));
}
