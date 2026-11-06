//! Host harness for the workshop-stock swap Grant (workstream 02-rights): the
//! real [`crate::dispatch`] — its routing, the player prologue (signers,
//! session, Season PDA, status, ruleset, action bucket), the holding
//! kernel and the account writers — run natively over hand-built accounts,
//! with the System program and the clock of [`crate::host_test`].
//!
//! **Fixture shortcuts (not program paths):** the Season, Citizens,
//! Holdings and Province are written directly (no CreateSeason, Join or
//! Build); a capture is simulated by editing the holding's generation and
//! owner and the Province's site mirror (no siege or SettleCapture). Not
//! covered: SBF, compute units, the 1,232-byte transaction limit, the
//! verifier, keeper and herald. A failed instruction is rolled back by
//! the harness ([`World::run`]), as the runtime would.

extern crate std;

use std::boxed::Box;
use std::collections::BTreeMap;
use std::vec::Vec;

use solana_program::{account_info::AccountInfo, pubkey::Pubkey};

use frontier_abi::addr::AddrCtx;
use frontier_abi::v2::layout::player::{citizen as CI, holding as HO};
use frontier_abi::v2::layout::province::{province as PV, site as SM};
use frontier_abi::v2::layout::world::season as SE;
use frontier_abi::v2::layout::{write_header, AccountKind as K2};
use frontier_abi::v2::rights::{self as rt, layout as G, RightsError as E};
use frontier_abi::v2::CqError;
use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::arms;
use permutation_rules::frontier::holding::{Holding as KHolding, Resource, Tier, RESOURCES};

use crate::error::Error;
use crate::host_test;
use crate::proc::holding as hold;
use crate::{addr, FrontierError};

const T0: i64 = 1_800_000_000;
const NOW: i64 = T0 + 3_600;
const SID: u64 = 1;
const ORE: usize = Resource::Ore as usize;
const WOOD: usize = Resource::Wood as usize;
const ARMS: usize = arms::ARMS as usize;
const LAMPORTS: u64 = 10_000_000_000;

/// A key with the four bytes `AccountInfo::resize` reads before it.
#[repr(C)]
struct KeyBox {
    orig_len: u32,
    key: Pubkey,
}

struct World {
    program: Pubkey,
    season: Pubkey,
    sid: u64,
    accts: BTreeMap<[u8; 32], AccountInfo<'static>>,
    /// The PS2 bodies the last successful instruction logged.
    records: Vec<Vec<u8>>,
}

fn leak<T>(v: T) -> &'static mut T {
    Box::leak(Box::new(v))
}

fn pk(k: [u8; 32]) -> Pubkey {
    Pubkey::new_from_array(k)
}

fn wallet(n: u8) -> [u8; 32] {
    [n; 32]
}

/// One account of an instruction: key, signer, writable.
type Meta = ([u8; 32], bool, bool);
/// An account before an instruction: key, data, lamports, owner.
type Snap = ([u8; 32], Vec<u8>, u64, Pubkey);

impl World {
    fn new(sid: u64) -> World {
        let program = pk([0x77; 32]);
        host_test::PROGRAM.with(|p| p.set(program));
        host_test::set_now(NOW);
        host_test::capture_logs();
        let bump = 254;
        let season = addr::season_pda(sid, bump, &program.to_bytes());
        let mut w = World {
            program,
            season: pk(season),
            sid,
            accts: BTreeMap::new(),
            records: Vec::new(),
        };
        let mut d = std::vec![0u8; SE::SIZE];
        assert!(write_header(&mut d, K2::Season, sid));
        d[SE::STATUS] = SE::STATUS_RUNNING;
        d[SE::BUMP] = bump;
        d[SE::RULESET_HASH..SE::RULESET_HASH + 32].copy_from_slice(&crate::RULESET_HASH);
        d[SE::GENESIS_TS..SE::GENESIS_TS + 8].copy_from_slice(&T0.to_le_bytes());
        d[SE::END_BELL..SE::END_BELL + 4].copy_from_slice(&100_000u32.to_le_bytes());
        d[SE::BUCKET_RATE_PER_H..SE::BUCKET_RATE_PER_H + 2].copy_from_slice(&600u16.to_le_bytes());
        d[SE::BUCKET_BURST..SE::BUCKET_BURST + 2].copy_from_slice(&600u16.to_le_bytes());
        w.put(season, program, LAMPORTS, &d);
        w
    }

    fn ctx(&self) -> AddrCtx {
        addr::ctx(&self.season.to_bytes(), &self.program.to_bytes())
    }

    fn put(&mut self, key: [u8; 32], owner: Pubkey, lamports: u64, data: &[u8]) {
        let kb = leak(KeyBox {
            orig_len: data.len() as u32,
            key: pk(key),
        });
        let buf = host_test::leak_data(data.len());
        buf.copy_from_slice(data);
        let info = AccountInfo::new(
            &kb.key,
            false,
            false,
            leak(lamports),
            buf,
            leak(owner),
            false,
        );
        self.accts.insert(key, info);
    }

    fn wallet_acct(&mut self, k: [u8; 32]) {
        if !self.accts.contains_key(&k) {
            self.put(k, crate::init::SYSTEM, LAMPORTS, &[]);
        }
    }

    fn data(&self, k: &[u8; 32]) -> Vec<u8> {
        self.accts[k].data.borrow().to_vec()
    }

    fn lamports(&self, k: &[u8; 32]) -> u64 {
        self.accts[k].lamports()
    }

    fn exists(&self, k: &[u8; 32]) -> bool {
        let a = &self.accts[k];
        a.owner == &self.program && a.data_len() > 0
    }

    fn edit(&self, k: &[u8; 32], f: impl FnOnce(&mut [u8])) {
        let a = &self.accts[k];
        let mut d = a.data.borrow_mut();
        f(&mut d);
    }

    /// Runs one instruction through the program's entry function; on an
    /// error every account is restored (transaction atomicity).
    fn run(&mut self, data: &[u8], metas: &[Meta]) -> Result<(), Error> {
        for (k, _, _) in metas {
            self.wallet_acct(*k);
        }
        let snap: Vec<Snap> = self
            .accts
            .iter()
            .map(|(k, a)| (*k, a.data.borrow().to_vec(), a.lamports(), *a.owner))
            .collect();
        let infos: Vec<AccountInfo<'static>> = metas
            .iter()
            .map(|(k, s, w)| {
                let mut i = self.accts[k].clone();
                i.is_signer = *s;
                i.is_writable = *w;
                i
            })
            .collect();
        let _ = host_test::take_logs();
        let r = crate::dispatch(&self.program, &infos, data);
        let logs = host_test::take_logs();
        if r.is_ok() {
            self.runtime_rules(&snap, metas);
            // Every `sol_log_data` of the program is `[b"PS2", body]`.
            self.records = logs
                .into_iter()
                .map(|f| {
                    assert_eq!(f.len(), 2, "a PS2 log line has two fields");
                    assert_eq!(f[0], frontier_abi::log::PREFIX, "the PS2 prefix");
                    f[1].clone()
                })
                .collect();
        } else {
            self.records.clear();
        }
        if r.is_err() {
            for (k, d, l, o) in snap {
                let a = &self.accts[&k];
                if a.data_len() != d.len() {
                    *a.data.borrow_mut() = host_test::leak_data(d.len());
                }
                a.data.borrow_mut().copy_from_slice(&d);
                **a.lamports.borrow_mut() = l;
                a.assign(&o);
            }
        }
        r
    }

    /// After a successful instruction, the account rules the Solana runtime
    /// enforces and a native run does not (an approximation, not the
    /// runtime): the lamport total is unchanged; only accounts the message
    /// marks writable change; data changes only on accounts this program
    /// owned on entry, or on an absent account it created (through the
    /// System program); lamports leave only a program-owned account or a
    /// signer.
    fn runtime_rules(&self, snap: &[Snap], metas: &[Meta]) {
        let total = |f: &dyn Fn(&Snap) -> u64| -> u128 { snap.iter().map(|x| f(x) as u128).sum() };
        let before = total(&|x| x.2);
        let after = total(&|x| self.accts[&x.0].lamports());
        assert_eq!(before, after, "the lamport total changed");
        for (k, d, l, o) in snap {
            let a = &self.accts[k];
            let data_changed = a.data.borrow()[..] != d[..];
            let changed = data_changed || a.lamports() != *l || a.owner != o;
            if !changed {
                continue;
            }
            let w = metas.iter().any(|(m, _, w)| m == k && *w);
            let s = metas.iter().any(|(m, sg, _)| m == k && *sg);
            assert!(w, "{:?}: changed but not writable", pk(*k));
            if data_changed {
                let created = *o == crate::init::SYSTEM && d.is_empty() && *a.owner == self.program;
                assert!(
                    *o == self.program || created,
                    "{:?}: data changed on an account the program did not own",
                    pk(*k)
                );
            }
            if a.lamports() < *l {
                assert!(
                    *o == self.program || s,
                    "{:?}: lamports left a foreign account without its signature",
                    pk(*k)
                );
            }
        }
    }

    // -------------------------------------------------------- fixtures

    fn citizen(&mut self, w: [u8; 32], faction: u8) -> [u8; 32] {
        let k = self.ctx().citizen(&w);
        let mut d = std::vec![0u8; CI::SIZE];
        assert!(write_header(&mut d, K2::Citizen, self.sid));
        d[CI::WALLET..CI::WALLET + 32].copy_from_slice(&w);
        d[CI::FACTION] = faction;
        d[CI::BUCKET_MILLI..CI::BUCKET_MILLI + 4].copy_from_slice(&600_000u32.to_le_bytes());
        self.put(k, self.program, LAMPORTS / 10, &d);
        self.wallet_acct(w);
        k
    }

    fn province(&mut self, p: i16, q: i16) -> [u8; 32] {
        let k = self.ctx().province(p as i32, q as i32);
        if self.accts.contains_key(&k) {
            return k;
        }
        let mut d = std::vec![0u8; PV::SIZE];
        assert!(write_header(&mut d, K2::Province, self.sid));
        d[PV::P..PV::P + 2].copy_from_slice(&p.to_le_bytes());
        d[PV::Q..PV::Q + 2].copy_from_slice(&q.to_le_bytes());
        self.put(k, self.program, LAMPORTS / 10, &d);
        k
    }

    /// A final holding of `owner` on `site` of Province (p, q) with
    /// `workshops` workshops and `stock` (whole units) of ore, wood, arms.
    fn holding(
        &mut self,
        owner: &[u8; 32],
        (p, q, site): (i16, i16, u8),
        workshops: i64,
        stock: [i64; 3],
    ) -> [u8; 32] {
        let k = self.ctx().holding(p as i32, q as i32, site);
        let prov = self.province(p, q);
        let mut h = KHolding::found(T0, 0, 1);
        h.production = arms::base_production(Tier::Hamlet, 7_000);
        h.production[ARMS] = workshops * arms::WORKSHOP_DELTA;
        for (r, v) in [
            (Resource::Ore, stock[0]),
            (Resource::Wood, stock[1]),
            (arms::ARMS, stock[2]),
        ] {
            h.credit(T0, r, v * MILLI).unwrap();
        }
        let mut d = std::vec![0u8; HO::SIZE];
        assert!(write_header(&mut d, K2::Holding, self.sid));
        d[HO::P..HO::P + 2].copy_from_slice(&p.to_le_bytes());
        d[HO::Q..HO::Q + 2].copy_from_slice(&q.to_le_bytes());
        d[HO::SITE] = site;
        d[HO::GEN] = 1;
        d[HO::TILE] = site;
        d[HO::STATE] = HO::STATE_FINAL;
        d[HO::OWNER_CITIZEN..HO::OWNER_CITIZEN + 32].copy_from_slice(owner);
        d[HO::TERRAIN_ORE..HO::TERRAIN_ORE + 8].copy_from_slice(&7_000i64.to_le_bytes());
        hold::write_holding(&mut d, &h, T0).unwrap();
        self.put(k, self.program, LAMPORTS / 10, &d);
        self.edit(&prov, |pd| {
            let s = PV::site(site as usize);
            pd[s + SM::STATE] = SM::STATE_HOLDING;
            pd[s + SM::GEN] = 1;
        });
        k
    }

    /// The account closed as the runtime leaves it (System-owned, no
    /// data): CloseHolding after the season, or ReleaseDormant (simulated).
    fn close_account(&self, k: &[u8; 32]) {
        let a = &self.accts[k];
        *a.data.borrow_mut() = host_test::leak_data(0);
        a.assign(&crate::init::SYSTEM);
    }

    /// Sets a store's settled value at `now` (simulates the owner's own
    /// spending or deliveries; whole units).
    fn set_store(&self, k: &[u8; 32], r: usize, now: i64, v: i64) {
        self.edit(k, |d| {
            let mut h = hold::read_holding(d).unwrap();
            hold::settle_tiered(&mut h, now, hold::terrain_ore(d).unwrap()).unwrap();
            h.stores[r].value = v * MILLI;
            hold::write_holding(d, &h, now).unwrap();
        });
    }

    /// The holding's stores at `now`, settled by the kernel (no write).
    fn stock(&self, k: &[u8; 32], now: i64) -> [i64; RESOURCES] {
        let d = self.data(k);
        let mut h = hold::read_holding(&d).unwrap();
        hold::settle_tiered(&mut h, now, hold::terrain_ore(&d).unwrap()).unwrap();
        h.stock_at(now)
    }

    /// A capture of the holding as the program leaves it after
    /// SettleCapture (simulated): next generation, new owner, the mirror
    /// at that generation.
    fn capture(&self, k: &[u8; 32], prov: &[u8; 32], site: u8, captor: &[u8; 32]) {
        self.edit(k, |d| {
            d[HO::GEN] += 1;
            d[HO::OWNER_CITIZEN..HO::OWNER_CITIZEN + 32].copy_from_slice(captor);
        });
        self.edit(prov, |pd| pd[PV::site(site as usize) + SM::GEN] += 1);
    }
}

// ------------------------------------------------------------ scenario

/// Issuer A (faction 1) owns a workshop holding F; grantee B (faction 2:
/// another nation) has station S in the same Province; C (faction 1,
/// A's own nation) has holding X there, and D a holding elsewhere.
struct Sc {
    w: World,
    a: [u8; 32],
    a_c: [u8; 32],
    b: [u8; 32],
    b_c: [u8; 32],
    c: [u8; 32],
    c_c: [u8; 32],
    f: [u8; 32],
    f2: [u8; 32],
    s: [u8; 32],
    x: [u8; 32],
    far: [u8; 32],
    prov: [u8; 32],
    prov2: [u8; 32],
}

const PQ: (i16, i16) = (2, -1);

fn scene() -> Sc {
    let mut w = World::new(SID);
    let (a, b, c) = (wallet(0xA1), wallet(0xB1), wallet(0xC1));
    let a_c = w.citizen(a, 1);
    let b_c = w.citizen(b, 2);
    let c_c = w.citizen(c, 1);
    let f = w.holding(&a_c, (PQ.0, PQ.1, 0), 2, [100, 100, 100]);
    let f2 = w.holding(&a_c, (PQ.0, PQ.1, 3), 0, [100, 100, 100]);
    let s = w.holding(&b_c, (PQ.0, PQ.1, 1), 0, [500, 500, 0]);
    let x = w.holding(&c_c, (PQ.0, PQ.1, 2), 0, [500, 500, 0]);
    let far = w.holding(&b_c, (5, 5, 0), 0, [500, 500, 0]);
    let prov = w.ctx().province(PQ.0 as i32, PQ.1 as i32);
    let prov2 = w.ctx().province(5, 5);
    Sc {
        w,
        a,
        a_c,
        b,
        b_c,
        c,
        c_c,
        f,
        f2,
        s,
        x,
        far,
        prov,
        prov2,
    }
}

fn rerr(e: E) -> Result<(), Error> {
    Err(Error::Rights(e))
}
fn ferr(e: FrontierError) -> Result<(), Error> {
    Err(Error::Frontier(e))
}
fn cqerr(e: CqError) -> Result<(), Error> {
    Err(Error::Cq(e))
}

impl Sc {
    fn grant_key(&self, nonce: u32) -> [u8; 32] {
        let tag = addr::citizen_tag(&self.a_c);
        rt::grant(&self.w.ctx(), tag, nonce)
    }

    #[allow(clippy::too_many_arguments)]
    fn issue_as(
        &mut self,
        actor: [u8; 32],
        issuer_c: [u8; 32],
        facility: [u8; 32],
        grantee_c: [u8; 32],
        station: [u8; 32],
        grant: [u8; 32],
        x: rt::IssueGrant,
    ) -> Result<(), Error> {
        let season = self.w.season.to_bytes();
        let prov = self.prov;
        self.w.run(
            &x.to_bytes(),
            &[
                (actor, true, false),
                (self.a, true, true),
                (season, false, false),
                (issuer_c, false, true),
                (facility, false, false),
                (prov, false, false),
                (grantee_c, false, false),
                (station, false, false),
                (grant, false, true),
                (addr::ids::SYSTEM_PROGRAM, false, false),
            ],
        )
    }

    fn terms(nonce: u32) -> rt::IssueGrant {
        rt::IssueGrant {
            nonce,
            kind: rt::KIND_STOCK_SWAP,
            max_swaps: 3,
            max_units: 30,
            expires_ts: NOW + 86_400,
        }
    }

    /// A issues grant `nonce` to B for F, station S (default terms).
    fn issue(&mut self, nonce: u32) -> [u8; 32] {
        let g = self.grant_key(nonce);
        let (a, a_c, f, b_c, s) = (self.a, self.a_c, self.f, self.b_c, self.s);
        self.issue_as(a, a_c, f, b_c, s, g, Sc::terms(nonce))
            .unwrap();
        g
    }

    /// The owner's real Harvest of F (settle and owner touch).
    fn harvest_f(&mut self) -> Result<(), Error> {
        let season = self.w.season.to_bytes();
        let (a, a_c, f, prov) = (self.a, self.a_c, self.f, self.prov);
        self.w.run(
            &frontier_abi::ix::Harvest {}.to_bytes(),
            &[
                (a, true, false),
                (a, true, true),
                (season, false, false),
                (a_c, false, true),
                (f, false, true),
                (prov, false, false),
            ],
        )
    }

    /// `[actor] [payer] [season] [citizen] [grant] [facility] [station]
    /// [province]` for Reserve, Consume and Revoke.
    fn use_metas(&self, actor: [u8; 32], citizen: [u8; 32], grant: [u8; 32]) -> Vec<Meta> {
        self.use_metas_with(actor, citizen, grant, self.f, self.s, self.prov)
    }

    fn use_metas_with(
        &self,
        actor: [u8; 32],
        citizen: [u8; 32],
        grant: [u8; 32],
        facility: [u8; 32],
        station: [u8; 32],
        prov: [u8; 32],
    ) -> Vec<Meta> {
        std::vec![
            (actor, true, false),
            (actor, true, true),
            (self.w.season.to_bytes(), false, false),
            (citizen, false, true),
            (grant, false, true),
            (facility, false, true),
            (station, false, true),
            (prov, false, false),
        ]
    }

    fn reserve(
        &mut self,
        actor: [u8; 32],
        citizen: [u8; 32],
        g: [u8; 32],
        units: u32,
    ) -> Result<(), Error> {
        let seq = self.seq(&g);
        self.reserve_seq(actor, citizen, g, units, seq)
    }

    /// An honest client's `seq`: the Grant's executed swaps as it reads them
    /// now (0 when there is no Grant to read).
    fn seq(&self, g: &[u8; 32]) -> u16 {
        match self.w.accts.get(g) {
            Some(a) if a.data_len() == G::SIZE => self.g_u16(g, G::SWAPS),
            _ => 0,
        }
    }

    fn reserve_seq(
        &mut self,
        actor: [u8; 32],
        citizen: [u8; 32],
        g: [u8; 32],
        units: u32,
        seq: u16,
    ) -> Result<(), Error> {
        let m = self.use_metas(actor, citizen, g);
        self.w.run(&rt::ReserveSwap { units, seq }.to_bytes(), &m)
    }

    fn execute(&mut self, actor: [u8; 32], citizen: [u8; 32], g: [u8; 32]) -> Result<(), Error> {
        let seq = self.seq(&g);
        self.execute_seq(actor, citizen, g, seq)
    }

    fn execute_seq(
        &mut self,
        actor: [u8; 32],
        citizen: [u8; 32],
        g: [u8; 32],
        seq: u16,
    ) -> Result<(), Error> {
        let m = self.use_metas(actor, citizen, g);
        self.w.run(&rt::ExecuteSwap { seq }.to_bytes(), &m)
    }

    fn revoke(&mut self, actor: [u8; 32], citizen: [u8; 32], g: [u8; 32]) -> Result<(), Error> {
        let m = self.use_metas(actor, citizen, g);
        self.w.run(&rt::RevokeGrant {}.to_bytes(), &m)
    }

    fn release(&mut self, actor: [u8; 32], g: [u8; 32]) -> Result<(), Error> {
        let m = std::vec![
            (actor, true, false),
            (self.w.season.to_bytes(), false, false),
            (self.b_c, false, false),
            (g, false, true),
            (self.f, false, true),
            (self.s, false, true),
            (self.prov, false, false),
        ];
        self.w.run(&rt::ReleaseSwap {}.to_bytes(), &m)
    }

    fn close(&mut self, actor: [u8; 32], g: [u8; 32], rent_to: [u8; 32]) -> Result<(), Error> {
        let m = std::vec![
            (actor, true, false),
            (self.w.season.to_bytes(), false, false),
            (g, false, true),
            (rent_to, false, true),
        ];
        self.w.run(&rt::CloseGrant {}.to_bytes(), &m)
    }

    fn set_session(
        &mut self,
        w: [u8; 32],
        c: [u8; 32],
        session: [u8; 32],
        expiry: i64,
    ) -> Result<(), Error> {
        let x = frontier_abi::ix::SetSession { session, expiry };
        let season = self.w.season.to_bytes();
        self.w.run(
            &x.to_bytes(),
            &[
                (w, true, false),
                (w, true, true),
                (season, false, false),
                (c, false, true),
            ],
        )
    }

    fn g_u32(&self, g: &[u8; 32], o: usize) -> u32 {
        u32::from_le_bytes(self.w.data(g)[o..o + 4].try_into().unwrap())
    }
    fn g_i64(&self, g: &[u8; 32], o: usize) -> i64 {
        i64::from_le_bytes(self.w.data(g)[o..o + 8].try_into().unwrap())
    }
    fn g_u16(&self, g: &[u8; 32], o: usize) -> u16 {
        u16::from_le_bytes(self.w.data(g)[o..o + 2].try_into().unwrap())
    }
}

fn units(m: i64) -> i64 {
    m * MILLI
}

// ------------------------------------------------------------ the harness itself

#[test]
fn harness_runs_a_real_instruction_set_session() {
    let mut sc = scene();
    let sess = wallet(0xB5);
    sc.set_session(sc.b, sc.b_c, sess, NOW + 3_600).unwrap();
    let d = sc.w.data(&sc.b_c);
    assert_eq!(&d[CI::SESSION..CI::SESSION + 32], &sess);
    // SetSession is wallet-only in the program: the session cannot renew
    // itself.
    assert_eq!(
        sc.set_session(sess, sc.b_c, sess, NOW + 7_200),
        ferr(FrontierError::Auth)
    );
}

// ------------------------------------------------------------ legitimate use

#[test]
fn legitimate_use_moves_exactly_the_terms_and_no_key() {
    let mut sc = scene();
    let g = sc.issue(0);
    assert!(sc.w.exists(&g));
    let (f0, s0) = (sc.w.stock(&sc.f, NOW), sc.w.stock(&sc.s, NOW));
    // B reserves 10 arms' worth with its own wallet: 20 ore, 10 wood from
    // S; 10 arms from F; all held by the Grant.
    sc.reserve(sc.b, sc.b_c, g, 10).unwrap();
    let (f1, s1) = (sc.w.stock(&sc.f, NOW), sc.w.stock(&sc.s, NOW));
    assert_eq!(s0[ORE] - s1[ORE], units(10 * arms::ORE_PER_ARM));
    assert_eq!(s0[WOOD] - s1[WOOD], units(10 * arms::WOOD_PER_ARM));
    assert_eq!(f0[ARMS] - f1[ARMS], units(10));
    assert_eq!((f0[ORE], f0[WOOD]), (f1[ORE], f1[WOOD]));
    assert_eq!(sc.g_u32(&g, G::OPEN_UNITS), 10);
    // Consume: arms to S, inputs to F.
    sc.execute(sc.b, sc.b_c, g).unwrap();
    let (f2, s2) = (sc.w.stock(&sc.f, NOW), sc.w.stock(&sc.s, NOW));
    assert_eq!(s2[ARMS] - s0[ARMS], units(10));
    assert_eq!(f2[ORE] - f0[ORE], units(20));
    assert_eq!(f2[WOOD] - f0[WOOD], units(10));
    assert_eq!(f0[ARMS] - f2[ARMS], units(10));
    // Conservation of every resource over F and S together.
    for r in 0..RESOURCES {
        assert_eq!(f0[r] + s0[r], f2[r] + s2[r], "resource {r}");
    }
    assert_eq!(sc.g_u16(&g, G::SWAPS), 1);
    assert_eq!(sc.g_u32(&g, G::UNITS_SWAPPED), 10);
    assert_eq!(sc.g_u32(&g, G::OPEN_UNITS), 0);
    // A's citizen and keys were never used after IssueGrant; F's owner is
    // still A and its owner activity is untouched.
    let fd = sc.w.data(&sc.f);
    assert_eq!(&fd[HO::OWNER_CITIZEN..HO::OWNER_CITIZEN + 32], &sc.a_c);
    let last = i64::from_le_bytes(
        fd[HO::LAST_OWNER_ACTION..HO::LAST_OWNER_ACTION + 8]
            .try_into()
            .unwrap(),
    );
    assert_eq!(last, T0);
}

#[test]
fn grantee_session_from_any_client_works_within_the_grant() {
    let mut sc = scene();
    let g = sc.issue(0);
    let sess = wallet(0xB5);
    sc.set_session(sc.b, sc.b_c, sess, NOW + 3_600).unwrap();
    sc.reserve(sess, sc.b_c, g, 5).unwrap();
    sc.execute(sess, sc.b_c, g).unwrap();
    // Expired session: refused by the prologue.
    host_test::set_now(NOW + 3_600);
    assert_eq!(
        sc.reserve(sess, sc.b_c, g, 5),
        ferr(FrontierError::SessionExpired)
    );
}

#[test]
fn issuing_needs_the_issuers_wallet_not_its_session() {
    let mut sc = scene();
    let sess = wallet(0xA5);
    sc.set_session(sc.a, sc.a_c, sess, NOW + 3_600).unwrap();
    let g = sc.grant_key(0);
    let (a_c, f, b_c, s) = (sc.a_c, sc.f, sc.b_c, sc.s);
    assert_eq!(
        sc.issue_as(sess, a_c, f, b_c, s, g, Sc::terms(0)),
        cqerr(CqError::WalletRequired)
    );
    assert!(!sc.w.exists(&g));
}

// ------------------------------------------------------------ required refusals

#[test]
fn no_grant_no_use() {
    let mut sc = scene();
    // No Grant at the address: nothing to use.
    let g = sc.grant_key(0);
    assert_eq!(sc.reserve(sc.b, sc.b_c, g, 1), rerr(E::BadGrant));
    // C (A's own nation) has no grant either: nationality grants nothing.
    let g = sc.issue(0);
    let m = sc.use_metas_with(sc.c, sc.c_c, g, sc.f, sc.x, sc.prov);
    assert_eq!(
        sc.w.run(&rt::ReserveSwap { units: 1, seq: 0 }.to_bytes(), &m),
        rerr(E::NotGrantee)
    );
    // Someone who does not own F cannot issue a Grant for it.
    let g2 = rt::grant(&sc.w.ctx(), addr::citizen_tag(&sc.c_c), 0);
    let (c, c_c, f, b_c, s) = (sc.c, sc.c_c, sc.f, sc.b_c, sc.s);
    assert_eq!(
        sc.issue_as(c, c_c, f, b_c, s, g2, Sc::terms(0)),
        ferr(FrontierError::NotOwner)
    );
}

#[test]
fn another_person_cannot_use_it() {
    let mut sc = scene();
    let g = sc.issue(0);
    // C signs as itself with its own Citizen: not the grantee.
    let m = sc.use_metas_with(sc.c, sc.c_c, g, sc.f, sc.s, sc.prov);
    assert_eq!(
        sc.w.run(&rt::ReserveSwap { units: 1, seq: 0 }.to_bytes(), &m),
        rerr(E::NotGrantee)
    );
    // C signs a raw instruction naming B's Citizen (a direct call that
    // skips every client): the prologue refuses C's key.
    assert_eq!(sc.reserve(sc.c, sc.b_c, g, 1), ferr(FrontierError::Auth));
    // The issuer cannot use it on the grantee's behalf either.
    assert_eq!(sc.reserve(sc.a, sc.b_c, g, 1), ferr(FrontierError::Auth));
    // Nobody but the grantee may release B's reservation while it is live.
    sc.reserve(sc.b, sc.b_c, g, 1).unwrap();
    assert_eq!(sc.release(sc.c, g), rerr(E::NotGrantee));
}

#[test]
fn another_facility_or_station_is_refused() {
    let mut sc = scene();
    let g = sc.issue(0);
    // A's other holding F2 (same owner, same Province): not the pinned one.
    let m = sc.use_metas_with(sc.b, sc.b_c, g, sc.f2, sc.s, sc.prov);
    assert_eq!(
        sc.w.run(&rt::ReserveSwap { units: 1, seq: 0 }.to_bytes(), &m),
        rerr(E::BadGrant)
    );
    // C's holding as the facility, B's far holding as the station.
    let m = sc.use_metas_with(sc.b, sc.b_c, g, sc.x, sc.s, sc.prov);
    assert_eq!(
        sc.w.run(&rt::ReserveSwap { units: 1, seq: 0 }.to_bytes(), &m),
        rerr(E::BadGrant)
    );
    let m = sc.use_metas_with(sc.b, sc.b_c, g, sc.f, sc.far, sc.prov);
    assert_eq!(
        sc.w.run(&rt::ReserveSwap { units: 1, seq: 0 }.to_bytes(), &m),
        rerr(E::BadGrant)
    );
    // Another Province account.
    let m = sc.use_metas_with(sc.b, sc.b_c, g, sc.f, sc.s, sc.prov2);
    assert_eq!(
        sc.w.run(&rt::ReserveSwap { units: 1, seq: 0 }.to_bytes(), &m),
        ferr(FrontierError::BadAddress)
    );
}

#[test]
fn another_season_is_refused() {
    let mut sc = scene();
    let g = sc.issue(0);
    let bytes = sc.w.data(&g);
    // Season 2 of the same program, the same players and places.
    let mut w2 = World::new(2);
    let a_c = w2.citizen(sc.a, 1);
    let b_c = w2.citizen(sc.b, 2);
    let f = w2.holding(&a_c, (PQ.0, PQ.1, 0), 2, [100, 100, 100]);
    let s = w2.holding(&b_c, (PQ.0, PQ.1, 1), 0, [500, 500, 0]);
    let prov = w2.ctx().province(PQ.0 as i32, PQ.1 as i32);
    let season2 = w2.season.to_bytes();
    let metas = |grant: [u8; 32]| {
        std::vec![
            (sc.b, true, false),
            (sc.b, true, true),
            (season2, false, false),
            (b_c, false, true),
            (grant, false, true),
            (f, false, true),
            (s, false, true),
            (prov, false, false),
        ]
    };
    // (a) Season 1's Grant account itself, offered in season 2.
    w2.put(g, w2.program, LAMPORTS, &bytes);
    assert_eq!(
        w2.run(&rt::ReserveSwap { units: 1, seq: 0 }.to_bytes(), &metas(g)),
        rerr(E::BadGrant)
    );
    // (b) Its bytes copied to season 2's canonical address of the same
    // issuer tag and nonce (an account only the program could write;
    // modelled as if it existed): the season id inside still refuses it.
    let tag = addr::citizen_tag(&a_c);
    let g2 = rt::grant(&w2.ctx(), tag, 0);
    w2.put(g2, w2.program, LAMPORTS, &bytes);
    assert_eq!(
        w2.run(&rt::ReserveSwap { units: 1, seq: 0 }.to_bytes(), &metas(g2)),
        rerr(E::BadGrant)
    );
    // (c) The same, rewritten so every field but the season id names
    // season 2's places: only the season id refuses it.
    let mut b2 = bytes.clone();
    b2[G::ISSUER_TAG..G::ISSUER_TAG + 8].copy_from_slice(&tag.to_le_bytes());
    for (o, k) in [
        (G::ISSUER_CITIZEN, a_c),
        (G::GRANTEE_CITIZEN, b_c),
        (G::FACILITY, f),
        (G::STATION, s),
    ] {
        b2[o..o + 32].copy_from_slice(&k);
    }
    w2.put(g2, w2.program, LAMPORTS, &b2);
    assert_eq!(
        w2.run(&rt::ReserveSwap { units: 1, seq: 0 }.to_bytes(), &metas(g2)),
        rerr(E::BadGrant)
    );
    b2[G::SEASON_ID..G::SEASON_ID + 8].copy_from_slice(&2u64.to_le_bytes());
    w2.put(g2, w2.program, LAMPORTS, &b2);
    w2.run(&rt::ReserveSwap { units: 1, seq: 0 }.to_bytes(), &metas(g2))
        .expect("the control: with season 2's id the same bytes pass");
}

#[test]
fn expired_grant_is_refused_and_its_reservation_can_be_released_by_anyone() {
    let mut sc = scene();
    let g = sc.issue(0);
    sc.reserve(sc.b, sc.b_c, g, 4).unwrap();
    let later = NOW + 86_400;
    host_test::set_now(later);
    let s_before = sc.w.stock(&sc.s, later);
    let f_before = sc.w.stock(&sc.f, later);
    assert_eq!(sc.execute(sc.b, sc.b_c, g), rerr(E::Expired));
    assert_eq!(sc.reserve(sc.b, sc.b_c, g, 1), rerr(E::Expired));
    // A third party (crank) releases it: both sides back, exactly.
    sc.release(sc.c, g).unwrap();
    let s_after = sc.w.stock(&sc.s, later);
    let f_after = sc.w.stock(&sc.f, later);
    assert_eq!(s_after[ORE] - s_before[ORE], units(8));
    assert_eq!(s_after[WOOD] - s_before[WOOD], units(4));
    assert_eq!(f_after[ARMS] - f_before[ARMS], units(4));
    assert_eq!(sc.g_u32(&g, G::OPEN_UNITS), 0);
    assert_eq!(sc.g_u16(&g, G::SWAPS), 0);
    assert_eq!(sc.release(sc.c, g), rerr(E::NoReservation));
}

#[test]
fn revoked_grant_is_refused() {
    let mut sc = scene();
    let g = sc.issue(0);
    sc.revoke(sc.a, sc.a_c, g).unwrap();
    assert_eq!(sc.reserve(sc.b, sc.b_c, g, 1), rerr(E::Revoked));
    assert_eq!(sc.revoke(sc.a, sc.a_c, g), rerr(E::Revoked));
    // Only the issuer revokes.
    let g1 = sc.issue(1);
    assert_eq!(sc.revoke(sc.b, sc.b_c, g1), rerr(E::NotGrantee));
    assert_eq!(sc.revoke(sc.c, sc.a_c, g1), ferr(FrontierError::Auth));
}

#[test]
fn quota_is_enforced() {
    let mut sc = scene();
    let g = sc.issue(0); // 3 uses, 30 units
    assert_eq!(sc.reserve(sc.b, sc.b_c, g, 31), rerr(E::QuotaExceeded));
    assert_eq!(sc.reserve(sc.b, sc.b_c, g, 0), rerr(E::QuotaExceeded));
    for n in [10, 10, 5] {
        sc.reserve(sc.b, sc.b_c, g, n).unwrap();
        sc.execute(sc.b, sc.b_c, g).unwrap();
    }
    // Uses spent (3 of 3) though 5 units are left.
    assert_eq!(sc.reserve(sc.b, sc.b_c, g, 1), rerr(E::QuotaExceeded));
    let g1 = sc.issue(1);
    sc.reserve(sc.b, sc.b_c, g1, 25).unwrap();
    sc.execute(sc.b, sc.b_c, g1).unwrap();
    // Units: 25 swapped, 6 more would pass 30.
    assert_eq!(sc.reserve(sc.b, sc.b_c, g1, 6), rerr(E::QuotaExceeded));
    sc.reserve(sc.b, sc.b_c, g1, 5).unwrap();
}

#[test]
fn double_use_is_refused() {
    let mut sc = scene();
    let g = sc.issue(0);
    sc.reserve(sc.b, sc.b_c, g, 3).unwrap();
    sc.execute(sc.b, sc.b_c, g).unwrap();
    let s1 = sc.w.stock(&sc.s, NOW);
    // The same reservation cannot be executed twice.
    assert_eq!(sc.execute(sc.b, sc.b_c, g), rerr(E::NoReservation));
    assert_eq!(sc.w.stock(&sc.s, NOW), s1);
}

#[test]
fn concurrent_requests_cannot_overcommit() {
    // The runtime serialises transactions that write the same Grant; two
    // requests sent "at once" therefore run one after the other, in either
    // order. Both orders keep within the terms.
    for first in [12u32, 20] {
        let mut sc = scene();
        let g = sc.issue(0); // 30 units
        let second = 32 - first;
        sc.reserve(sc.b, sc.b_c, g, first).unwrap();
        assert_eq!(
            sc.reserve(sc.b, sc.b_c, g, second),
            rerr(E::ReservationOpen)
        );
        sc.execute(sc.b, sc.b_c, g).unwrap();
        assert_eq!(sc.reserve(sc.b, sc.b_c, g, second), rerr(E::QuotaExceeded));
        // A session and the wallet of the same grantee share the Grant.
        let sess = wallet(0xB5);
        sc.set_session(sc.b, sc.b_c, sess, NOW + 3_600).unwrap();
        sc.reserve(sess, sc.b_c, g, 30 - first).unwrap();
        assert_eq!(sc.reserve(sc.b, sc.b_c, g, 1), rerr(E::ReservationOpen));
    }
}

#[test]
fn stale_facility_generation_is_refused_and_its_escrow_follows_the_capture() {
    let mut sc = scene();
    let g = sc.issue(0);
    sc.reserve(sc.b, sc.b_c, g, 6).unwrap();
    // A capture completed in a resolve, not yet settled: the lock waits.
    sc.w.edit(&sc.prov, |pd| pd[PV::site(0) + SM::GEN] = 2);
    assert_eq!(sc.execute(sc.b, sc.b_c, g), cqerr(CqError::CapturePending));
    assert_eq!(sc.release(sc.b, g), cqerr(CqError::CapturePending));
    sc.w.edit(&sc.prov, |pd| pd[PV::site(0) + SM::GEN] = 1);
    // SettleCapture (simulated): F is generation 2, C's.
    let (f, prov, c_c) = (sc.f, sc.prov, sc.c_c);
    sc.w.capture(&f, &prov, 0, &c_c);
    // The Grant is void for its holder: neither use nor a new reservation.
    assert_eq!(sc.execute(sc.b, sc.b_c, g), rerr(E::StaleHolding));
    assert_eq!(sc.reserve(sc.b, sc.b_c, g, 1), rerr(E::StaleHolding));
    let f_before = sc.w.stock(&sc.f, NOW);
    let s_before = sc.w.stock(&sc.s, NOW);
    // Anyone may release: B's inputs come back to S; the escrowed arms go
    // back into F as it stands, now the captor's (redesign 20 §5).
    sc.release(sc.c, g).unwrap();
    let f_after = sc.w.stock(&sc.f, NOW);
    let s_after = sc.w.stock(&sc.s, NOW);
    assert_eq!(f_after[ARMS] - f_before[ARMS], units(6));
    assert_eq!(s_after[ORE] - s_before[ORE], units(12));
    assert_eq!(s_after[WOOD] - s_before[WOOD], units(6));
    assert_eq!(s_after[ARMS], s_before[ARMS]);
    assert_eq!(sc.reserve(sc.b, sc.b_c, g, 1), rerr(E::StaleHolding));
}

#[test]
fn generation_and_owner_are_each_pinned() {
    // Same owner, next generation (A lost F and took the site back): the
    // Grant was for the old F.
    let mut sc = scene();
    let g = sc.issue(0);
    let (f, prov, a_c) = (sc.f, sc.prov, sc.a_c);
    sc.w.capture(&f, &prov, 0, &a_c);
    assert_eq!(sc.reserve(sc.b, sc.b_c, g, 1), rerr(E::StaleHolding));
    // Same generation, another owner (not a path the program has today;
    // defence in depth): refused too.
    let mut sc = scene();
    let g = sc.issue(0);
    let c_c = sc.c_c;
    sc.w.edit(&sc.f, |d| {
        d[HO::OWNER_CITIZEN..HO::OWNER_CITIZEN + 32].copy_from_slice(&c_c)
    });
    assert_eq!(sc.reserve(sc.b, sc.b_c, g, 1), rerr(E::StaleHolding));
    // The station's pin as well.
    let mut sc = scene();
    let g = sc.issue(0);
    let (s, prov, b_c) = (sc.s, sc.prov, sc.b_c);
    sc.w.capture(&s, &prov, 1, &b_c);
    assert_eq!(sc.reserve(sc.b, sc.b_c, g, 1), rerr(E::StaleHolding));
}

#[test]
fn a_station_that_is_gone_keeps_its_escrow_in_the_grant() {
    let mut sc = scene();
    let g = sc.issue(0);
    sc.reserve(sc.b, sc.b_c, g, 5).unwrap();
    // S released (simulated): no live holding at its key any more.
    sc.w.edit(&sc.s, |d| d[HO::STATE] = HO::STATE_RELEASED);
    let s_bytes = sc.w.data(&sc.s);
    let f_before = sc.w.stock(&sc.f, NOW);
    assert_eq!(sc.reserve(sc.b, sc.b_c, g, 1), rerr(E::StaleHolding));
    // The issuer revokes: F's arms come back; S is not written; B's ore
    // and wood stay recorded in the Grant (not burned, not credited
    // elsewhere).
    sc.revoke(sc.a, sc.a_c, g).unwrap();
    assert_eq!(sc.w.stock(&sc.f, NOW)[ARMS] - f_before[ARMS], units(5));
    assert_eq!(sc.w.data(&sc.s), s_bytes);
    assert_eq!(sc.g_u32(&g, G::OPEN_UNITS), 5);
    assert_eq!(sc.g_i64(&g, G::OPEN_ORE), units(10));
    assert_eq!(sc.g_i64(&g, G::OPEN_WOOD), units(5));
    assert_eq!(sc.g_i64(&g, G::OPEN_ARMS), 0);
    // Nothing more can go back: ReleaseSwap is refused and changes
    // nothing; the Grant cannot be closed while it keeps the escrow.
    let gd = sc.w.data(&g);
    assert_eq!(sc.release(sc.c, g), rerr(E::ReturnBlocked));
    assert_eq!(sc.w.data(&g), gd);
    let rent_to = sc.a;
    assert_eq!(sc.close(sc.c, g, rent_to), rerr(E::StillLive));
}

#[test]
fn forged_grant_accounts_are_refused() {
    let mut sc = scene();
    let g = sc.issue(0);
    let bytes = sc.w.data(&g);
    // (a) The same bytes owned by another program at the canonical
    // address of nonce 9.
    let g9 = sc.grant_key(9);
    sc.w.put(g9, pk([0x66; 32]), LAMPORTS, &{
        let mut b = bytes.clone();
        b[G::NONCE..G::NONCE + 4].copy_from_slice(&9u32.to_le_bytes());
        b
    });
    assert_eq!(sc.reserve(sc.b, sc.b_c, g9, 1), rerr(E::BadGrant));
    // (b) Program-owned bytes at an address the fields do not recompute to
    // (modelled; the program never writes such an account).
    let odd = [0x42; 32];
    sc.w.put(odd, sc.w.program, LAMPORTS, &bytes);
    assert_eq!(sc.reserve(sc.b, sc.b_c, odd, 1), rerr(E::BadGrant));
    // (c) The real Grant with a raised quota in a copy at another program.
    let fake = [0x43; 32];
    let mut b = bytes.clone();
    b[G::MAX_UNITS..G::MAX_UNITS + 4].copy_from_slice(&u32::MAX.to_le_bytes());
    sc.w.put(fake, pk([0x66; 32]), LAMPORTS, &b);
    assert_eq!(sc.reserve(sc.b, sc.b_c, fake, 100), rerr(E::BadGrant));
    // (d) Another program account kind (a Holding) as the Grant.
    let f = sc.f;
    assert_eq!(sc.reserve(sc.b, sc.b_c, f, 1), rerr(E::BadGrant));
    // (e) A Grant whose grantee field names C, at another program.
    let mut b = bytes;
    b[G::GRANTEE_CITIZEN..G::GRANTEE_CITIZEN + 32].copy_from_slice(&sc.c_c);
    let fake2 = [0x44; 32];
    sc.w.put(fake2, pk([0x66; 32]), LAMPORTS, &b);
    let m = sc.use_metas_with(sc.c, sc.c_c, fake2, sc.f, sc.x, sc.prov);
    assert_eq!(
        sc.w.run(&rt::ReserveSwap { units: 1, seq: 0 }.to_bytes(), &m),
        rerr(E::BadGrant)
    );
}

#[test]
fn signers_and_flags_are_checked_on_direct_calls() {
    let mut sc = scene();
    let g = sc.issue(0);
    // The grantee's key present but not signing.
    let mut m = sc.use_metas(sc.b, sc.b_c, g);
    m[0].1 = false;
    assert_eq!(
        sc.w.run(&rt::ReserveSwap { units: 1, seq: 0 }.to_bytes(), &m),
        ferr(FrontierError::Auth)
    );
    // The Grant passed read-only.
    let mut m = sc.use_metas(sc.b, sc.b_c, g);
    m[4].2 = false;
    assert_eq!(
        sc.w.run(&rt::ReserveSwap { units: 1, seq: 0 }.to_bytes(), &m),
        ferr(FrontierError::BadAccount)
    );
    // A truncated account list.
    let m = sc.use_metas(sc.b, sc.b_c, g);
    assert_eq!(
        sc.w.run(&rt::ReserveSwap { units: 1, seq: 0 }.to_bytes(), &m[..7]),
        ferr(FrontierError::TooManyAccounts)
    );
    // Malformed data.
    let m = sc.use_metas(sc.b, sc.b_c, g);
    assert_eq!(
        sc.w.run(&[rt::tag::RESERVE_SWAP, 1, 0], &m),
        ferr(FrontierError::BadData)
    );
    // A Release signer that is not the grantee, before expiry: refused.
    sc.reserve(sc.b, sc.b_c, g, 1).unwrap();
    assert_eq!(sc.release(sc.a, g), rerr(E::NotGrantee));
}

// ------------------------------------------------------------ cancellation

#[test]
fn revoking_after_a_reservation_returns_both_sides_and_keeps_what_was_swapped() {
    let mut sc = scene();
    let g = sc.issue(0);
    let (f0, s0) = (sc.w.stock(&sc.f, NOW), sc.w.stock(&sc.s, NOW));
    sc.reserve(sc.b, sc.b_c, g, 5).unwrap();
    sc.execute(sc.b, sc.b_c, g).unwrap();
    let (f1, s1) = (sc.w.stock(&sc.f, NOW), sc.w.stock(&sc.s, NOW));
    sc.reserve(sc.b, sc.b_c, g, 7).unwrap();
    sc.revoke(sc.a, sc.a_c, g).unwrap();
    let (f2, s2) = (sc.w.stock(&sc.f, NOW), sc.w.stock(&sc.s, NOW));
    // The open reservation came back whole on both sides …
    assert_eq!((f2, s2), (f1, s1));
    // … the executed swap did not: S keeps its 5 arms, F its 10 ore, 5 wood.
    assert_eq!(s2[ARMS] - s0[ARMS], units(5));
    assert_eq!(f2[ORE] - f0[ORE], units(10));
    assert_eq!(sc.g_u16(&g, G::SWAPS), 1);
    assert_eq!(sc.w.data(&g)[G::STATE], rt::STATE_REVOKED);
}

#[test]
fn revoking_unused_quota_moves_nothing() {
    let mut sc = scene();
    let g = sc.issue(0);
    let (f0, s0) = (sc.w.data(&sc.f), sc.w.data(&sc.s));
    sc.revoke(sc.a, sc.a_c, g).unwrap();
    assert_eq!((sc.w.data(&sc.f), sc.w.data(&sc.s)), (f0, s0));
    // The issuer's session may revoke (it only takes power away).
    let g1 = sc.issue(1);
    let sess = wallet(0xA5);
    sc.set_session(sc.a, sc.a_c, sess, NOW + 3_600).unwrap();
    sc.revoke(sess, sc.a_c, g1).unwrap();
}

#[test]
fn grantee_may_release_its_own_reservation() {
    let mut sc = scene();
    let g = sc.issue(0);
    let (f0, s0) = (sc.w.stock(&sc.f, NOW), sc.w.stock(&sc.s, NOW));
    sc.reserve(sc.b, sc.b_c, g, 9).unwrap();
    sc.release(sc.b, g).unwrap();
    assert_eq!((sc.w.stock(&sc.f, NOW), sc.w.stock(&sc.s, NOW)), (f0, s0));
    // A release returns the quota: nothing was swapped.
    assert_eq!(sc.g_u16(&g, G::SWAPS), 0);
    sc.reserve(sc.b, sc.b_c, g, 30).unwrap();
}

// ------------------------------------------------------------ all or nothing

#[test]
fn shortfalls_move_nothing() {
    let mut sc = scene();
    let g = sc.issue(0);
    // F holds 3 arms (+8 its workshops made by NOW): 20 is not there.
    let s0 = sc.w.data(&sc.s);
    sc.w.edit(&sc.f, |d| {
        let o = HO::store(ARMS) + crate::layout::player::accrual::VALUE;
        d[o..o + 8].copy_from_slice(&units(3).to_le_bytes());
    });
    let f0 = sc.w.data(&sc.f);
    assert_eq!(
        sc.reserve(sc.b, sc.b_c, g, 20),
        ferr(FrontierError::Insufficient)
    );
    assert_eq!((sc.w.data(&sc.f), sc.w.data(&sc.s)), (f0, s0));
    // S short of ore.
    sc.w.edit(&sc.s, |d| {
        let o = HO::store(ORE) + crate::layout::player::accrual::VALUE;
        d[o..o + 8].copy_from_slice(&units(1).to_le_bytes());
    });
    let (f0, s0) = (sc.w.data(&sc.f), sc.w.data(&sc.s));
    assert_eq!(
        sc.reserve(sc.b, sc.b_c, g, 10),
        ferr(FrontierError::Insufficient)
    );
    assert_eq!((sc.w.data(&sc.f), sc.w.data(&sc.s)), (f0, s0));
}

// ------------------------------------------------------------ issue checks

#[test]
fn issue_terms_and_places_are_checked() {
    let mut sc = scene();
    let (a, a_c, f, f2, b_c, s, x, far) = (sc.a, sc.a_c, sc.f, sc.f2, sc.b_c, sc.s, sc.x, sc.far);
    let g = sc.grant_key(0);
    // No workshop in F2.
    assert_eq!(
        sc.issue_as(a, a_c, f2, b_c, s, g, Sc::terms(0)),
        rerr(E::NoWorkshop)
    );
    // Station not the grantee's, or in another Province.
    assert_eq!(
        sc.issue_as(a, a_c, f, b_c, x, g, Sc::terms(0)),
        rerr(E::BadStation)
    );
    assert_eq!(
        sc.issue_as(a, a_c, f, b_c, far, g, Sc::terms(0)),
        rerr(E::BadStation)
    );
    // Self-grant, zero quota, past or too-far expiry, unknown kind.
    assert_eq!(
        sc.issue_as(a, a_c, f, a_c, f2, g, Sc::terms(0)),
        rerr(E::BadTerms)
    );
    for t in [
        rt::IssueGrant {
            max_swaps: 0,
            ..Sc::terms(0)
        },
        rt::IssueGrant {
            max_units: 0,
            ..Sc::terms(0)
        },
        rt::IssueGrant {
            expires_ts: NOW,
            ..Sc::terms(0)
        },
        rt::IssueGrant {
            expires_ts: NOW + rt::MAX_GRANT_SECS + 1,
            ..Sc::terms(0)
        },
        rt::IssueGrant {
            kind: 2,
            ..Sc::terms(0)
        },
    ] {
        assert_eq!(sc.issue_as(a, a_c, f, b_c, s, g, t), rerr(E::BadTerms));
    }
    // Wrong address for the nonce; then a nonce used twice.
    let g1 = sc.grant_key(1);
    assert_eq!(
        sc.issue_as(a, a_c, f, b_c, s, g1, Sc::terms(0)),
        ferr(FrontierError::BadAddress)
    );
    let f_at_issue = sc.w.stock(&f, NOW);
    sc.issue_as(a, a_c, f, b_c, s, g, Sc::terms(0)).unwrap();
    assert_eq!(
        sc.issue_as(a, a_c, f, b_c, s, g, Sc::terms(0)),
        rerr(E::BadGrant)
    );
    // Issuing reads F: nothing in it moves.
    assert_eq!(sc.w.stock(&f, NOW), f_at_issue);
}

#[test]
fn close_returns_rent_only_when_nothing_is_escrowed_or_usable() {
    let mut sc = scene();
    let g = sc.issue(0);
    let rent_to = sc.a;
    assert_eq!(sc.close(sc.c, g, rent_to), rerr(E::StillLive));
    sc.reserve(sc.b, sc.b_c, g, 2).unwrap();
    sc.revoke(sc.a, sc.a_c, g).unwrap();
    // Rent goes to RENT_TO whoever signs; another recipient is refused.
    assert_eq!(sc.close(sc.c, g, sc.c), rerr(E::BadGrant));
    let before = sc.w.lamports(&rent_to);
    let held = sc.w.lamports(&g);
    sc.close(sc.c, g, rent_to).unwrap();
    assert_eq!(sc.w.lamports(&rent_to), before + held);
    assert!(!sc.w.exists(&g));
    assert_eq!(sc.reserve(sc.b, sc.b_c, g, 1), rerr(E::BadGrant));
}

// ------------------------------------------------------------ round 2: conservation

#[test]
fn parallel_reservations_cannot_take_the_same_stock_twice() {
    let mut sc = scene();
    let (a, a_c, f, b_c, s, c_c, x) = (sc.a, sc.a_c, sc.f, sc.b_c, sc.s, sc.c_c, sc.x);
    let big = |nonce| rt::IssueGrant {
        max_units: 100,
        ..Sc::terms(nonce)
    };
    let (gb, gc) = (sc.grant_key(0), sc.grant_key(1));
    sc.issue_as(a, a_c, f, b_c, s, gb, big(0)).unwrap();
    sc.issue_as(a, a_c, f, c_c, x, gc, big(1)).unwrap();
    let f0 = sc.w.stock(&sc.f, NOW)[ARMS];
    assert_eq!(f0, units(108)); // 100 + 2 workshops × 4 an hour × 1 h
    sc.reserve(sc.b, sc.b_c, gb, 60).unwrap();
    // C's grant on the same F: only 48 arms are left in F's store.
    let m = sc.use_metas_with(sc.c, sc.c_c, gc, sc.f, sc.x, sc.prov);
    assert_eq!(
        sc.w.run(&rt::ReserveSwap { units: 49, seq: 0 }.to_bytes(), &m),
        ferr(FrontierError::Insufficient)
    );
    sc.w.run(&rt::ReserveSwap { units: 48, seq: 0 }.to_bytes(), &m)
        .unwrap();
    // F's store plus both escrows is what F held: nothing counted twice.
    let left = sc.w.stock(&sc.f, NOW)[ARMS];
    let held = sc.g_i64(&gb, G::OPEN_ARMS) + sc.g_i64(&gc, G::OPEN_ARMS);
    assert_eq!(left, 0);
    assert_eq!(left + held, f0);
}

#[test]
fn escrow_is_outside_every_store_during_a_reservation() {
    let mut sc = scene();
    let g = sc.issue(0);
    sc.reserve(sc.b, sc.b_c, g, 10).unwrap();
    // The owner's real Harvest, two hours of F's continuous production
    // (its workshops keep converting F's own ore and wood), and the owner
    // spending every arm left in F (simulated): none reaches the escrow.
    sc.harvest_f().unwrap();
    let t = NOW + 7_200;
    host_test::set_now(t);
    sc.w.set_store(&sc.f, ARMS, t, 0);
    // The grantee's own spending of S's ore (simulated) cannot reach it
    // either.
    sc.w.set_store(&sc.s, ORE, t, 0);
    let (f1, s1) = (sc.w.stock(&sc.f, t), sc.w.stock(&sc.s, t));
    sc.execute(sc.b, sc.b_c, g).unwrap();
    let (f2, s2) = (sc.w.stock(&sc.f, t), sc.w.stock(&sc.s, t));
    assert_eq!(s2[ARMS] - s1[ARMS], units(10));
    assert_eq!(f2[ORE] - f1[ORE], units(20));
    assert_eq!(f2[WOOD] - f1[WOOD], units(10));
    assert_eq!(f2[ARMS], f1[ARMS]);
    assert_eq!(s2[ORE], s1[ORE]);
}

#[test]
fn a_return_into_a_full_store_is_kept_above_the_cap() {
    let mut sc = scene();
    let g = sc.issue(0);
    sc.reserve(sc.b, sc.b_c, g, 10).unwrap();
    let cap = Tier::Hamlet.storage_cap() / MILLI;
    sc.w.set_store(&sc.s, ORE, NOW, cap);
    sc.w.set_store(&sc.s, WOOD, NOW, cap);
    sc.release(sc.b, g).unwrap();
    let s = sc.w.stock(&sc.s, NOW);
    assert_eq!(s[ORE], units(cap + 20));
    assert_eq!(s[WOOD], units(cap + 10));
    // Hours later the store is not cut back to the cap (Accrual: a
    // positive rate never lowers a value above it); only further
    // production into that store stops.
    let later = NOW + 4 * 3_600;
    host_test::set_now(later);
    let s = sc.w.stock(&sc.s, later);
    assert_eq!(s[ORE], units(cap + 20));
    assert_eq!(s[WOOD], units(cap + 10));
}

#[test]
fn no_stock_means_no_reservation_and_no_waiting_state() {
    let mut sc = scene();
    let g = sc.issue(0);
    // F has no arms, and no ore or wood for its workshops to convert.
    for r in [ARMS, ORE, WOOD] {
        sc.w.set_store(&sc.f, r, NOW, 0);
    }
    let gd = sc.w.data(&g);
    let (f0, s0) = (sc.w.data(&sc.f), sc.w.data(&sc.s));
    assert_eq!(
        sc.reserve(sc.b, sc.b_c, g, 1),
        ferr(FrontierError::Insufficient)
    );
    // Nothing is queued or held: the Grant and both holdings are as they
    // were, and there is nothing to release.
    assert_eq!(sc.w.data(&g), gd);
    assert_eq!((sc.w.data(&sc.f), sc.w.data(&sc.s)), (f0, s0));
    assert_eq!(sc.release(sc.b, g), rerr(E::NoReservation));
    // F's base ore keeps coming in; its workshops convert it as before, so
    // an hour later the same request succeeds (a retry, not a wait).
    sc.w.set_store(&sc.f, WOOD, NOW, 50);
    let t = NOW + 3_600;
    host_test::set_now(t);
    assert!(sc.w.stock(&sc.f, t)[ARMS] >= units(1));
    sc.reserve(sc.b, sc.b_c, g, 1).unwrap();
    sc.release(sc.b, g).unwrap();
    // Past the expiry the Grant is simply unusable; with nothing escrowed
    // it closes.
    let end = NOW + 86_400;
    host_test::set_now(end);
    assert_eq!(sc.reserve(sc.b, sc.b_c, g, 1), rerr(E::Expired));
    let rent_to = sc.a;
    sc.close(sc.c, g, rent_to).unwrap();
}

#[test]
fn rebuilt_retries_do_not_swap_twice() {
    let mut sc = scene();
    let g = sc.issue(0);
    let (b, b_c) = (sc.b, sc.b_c);
    sc.reserve_seq(b, b_c, g, 4, 0).unwrap();
    sc.execute_seq(b, b_c, g, 0).unwrap();
    let s1 = sc.w.stock(&sc.s, NOW);
    // The client did not see the result and rebuilds both steps (a new
    // blockhash, so the runtime does not drop them as duplicates).
    assert_eq!(sc.reserve_seq(b, b_c, g, 4, 0), rerr(E::SeqMismatch));
    assert_eq!(sc.execute_seq(b, b_c, g, 0), rerr(E::NoReservation));
    assert_eq!(sc.w.stock(&sc.s, NOW), s1);
    assert_eq!(sc.g_u16(&g, G::SWAPS), 1);
    // A deliberate second swap names seq 1; a stale Execute of the first
    // cannot execute it.
    sc.reserve_seq(b, b_c, g, 2, 1).unwrap();
    assert_eq!(sc.execute_seq(b, b_c, g, 0), rerr(E::SeqMismatch));
    sc.execute_seq(b, b_c, g, 1).unwrap();
    assert_eq!(sc.g_u16(&g, G::SWAPS), 2);
    // A release sent twice: the second finds nothing.
    sc.reserve_seq(b, b_c, g, 1, 2).unwrap();
    sc.release(b, g).unwrap();
    assert_eq!(sc.release(b, g), rerr(E::NoReservation));
}

// ------------------------------------------------------------ round 2: capture and closure

#[test]
fn station_captured_while_reserved_returns_inputs_to_the_captor_and_arms_to_the_facility() {
    let mut sc = scene();
    let g = sc.issue(0);
    sc.reserve(sc.b, sc.b_c, g, 3).unwrap();
    let (s, prov, c_c) = (sc.s, sc.prov, sc.c_c);
    sc.w.capture(&s, &prov, 1, &c_c);
    assert_eq!(sc.execute(sc.b, sc.b_c, g), rerr(E::StaleHolding));
    let (f0, s0) = (sc.w.stock(&sc.f, NOW), sc.w.stock(&sc.s, NOW));
    // B (still the grantee) releases: its ore and wood go into S as it
    // stands, which is C's now; the arms back into A's F.
    sc.release(sc.b, g).unwrap();
    let (f1, s1) = (sc.w.stock(&sc.f, NOW), sc.w.stock(&sc.s, NOW));
    assert_eq!(s1[ORE] - s0[ORE], units(6));
    assert_eq!(s1[WOOD] - s0[WOOD], units(3));
    assert_eq!(f1[ARMS] - f0[ARMS], units(3));
    let sd = sc.w.data(&sc.s);
    assert_eq!(&sd[HO::OWNER_CITIZEN..HO::OWNER_CITIZEN + 32], &sc.c_c);
}

#[test]
fn both_sides_captured_while_reserved_each_return_goes_to_its_captor() {
    let mut sc = scene();
    let g = sc.issue(0);
    sc.reserve(sc.b, sc.b_c, g, 3).unwrap();
    let (f, s, prov, c_c, b_c) = (sc.f, sc.s, sc.prov, sc.c_c, sc.b_c);
    sc.w.capture(&f, &prov, 0, &b_c); // B takes F
    sc.w.capture(&s, &prov, 1, &c_c); // C takes S
    let (f0, s0) = (sc.w.stock(&sc.f, NOW), sc.w.stock(&sc.s, NOW));
    sc.release(sc.a, g).unwrap(); // anyone, once stale
    let (f1, s1) = (sc.w.stock(&sc.f, NOW), sc.w.stock(&sc.s, NOW));
    assert_eq!(f1[ARMS] - f0[ARMS], units(3)); // into F, B's now
    assert_eq!(s1[ORE] - s0[ORE], units(6)); // into S, C's now
}

#[test]
fn after_an_executed_swap_a_capture_changes_nothing_the_grant_holds() {
    let mut sc = scene();
    let g = sc.issue(0);
    sc.reserve(sc.b, sc.b_c, g, 3).unwrap();
    sc.execute(sc.b, sc.b_c, g).unwrap();
    let gd = sc.w.data(&g);
    let (s, prov, c_c) = (sc.s, sc.prov, sc.c_c);
    sc.w.capture(&s, &prov, 1, &c_c);
    // The 3 arms are in S's store and pass with it under the capture rule;
    // the Grant holds nothing and cannot be used any more.
    assert_eq!(sc.release(sc.c, g), rerr(E::NoReservation));
    assert_eq!(sc.reserve(sc.b, sc.b_c, g, 1), rerr(E::StaleHolding));
    assert_eq!(sc.w.data(&g), gd);
}

#[test]
fn a_closed_facility_keeps_the_arms_in_the_grant_and_returns_the_inputs() {
    let mut sc = scene();
    let g = sc.issue(0);
    sc.reserve(sc.b, sc.b_c, g, 4).unwrap();
    let s0 = sc.w.stock(&sc.s, NOW);
    sc.w.close_account(&sc.f);
    // The grantee releases: its inputs come back; the arms have no holding
    // to go to and stay recorded in the Grant.
    sc.release(sc.b, g).unwrap();
    let s1 = sc.w.stock(&sc.s, NOW);
    assert_eq!(s1[ORE] - s0[ORE], units(8));
    assert_eq!(s1[WOOD] - s0[WOOD], units(4));
    assert_eq!(sc.g_i64(&g, G::OPEN_ARMS), units(4));
    assert_eq!(
        (sc.g_i64(&g, G::OPEN_ORE), sc.g_i64(&g, G::OPEN_WOOD)),
        (0, 0)
    );
    assert_eq!(sc.release(sc.b, g), rerr(E::ReturnBlocked));
}

// ------------------------------------------------------------ round 2: delegation

/// A live session key signs a Vote the agent wallet never offers (not in
/// `AGENT_ACTIONS`; redesign decision E2: a proxy does not vote). The
/// program accepts it: the agent wallet's allow-list binds only requests
/// that go through the operator's server.
#[test]
fn a_live_session_votes_though_the_agent_wallet_never_offers_vote() {
    use frontier_abi::v2::layout::s1::{nation as NA, proposal as PR};
    let mut sc = scene();
    // A day and more after joining (eligibility: 288 bells).
    let t = T0 + 300 * 600;
    host_test::set_now(t);
    let sess = wallet(0xB5);
    sc.set_session(sc.b, sc.b_c, sess, t + 3_600).unwrap();
    // B's nation (faction 2) with proposal 1 open.
    let nk = frontier_abi::v2::addr::nation(&sc.w.ctx(), 2);
    let mut d = std::vec![0u8; NA::SIZE];
    assert!(write_header(&mut d, K2::Nation, SID));
    d[NA::FACTION] = 2;
    let o = NA::at(0);
    d[o + PR::ID..o + PR::ID + 4].copy_from_slice(&1u32.to_le_bytes());
    d[o + PR::STATE] = PR::STATE_OPEN;
    d[o + PR::KIND] = PR::KIND_STANCE;
    d[o + PR::CLOSE_BELL..o + PR::CLOSE_BELL + 4].copy_from_slice(&10_000u32.to_le_bytes());
    let program = sc.w.program;
    sc.w.put(nk, program, LAMPORTS, &d);
    let season = sc.w.season.to_bytes();
    let b_c = sc.b_c;
    let vote = frontier_abi::v2::ix::Vote {
        slot: 0,
        id: 1,
        yes: 1,
    };
    sc.w.run(
        &vote.to_bytes(),
        &[
            (sess, true, false),
            (sess, true, true),
            (season, false, false),
            (b_c, false, true),
            (nk, false, true),
        ],
    )
    .unwrap();
    let nd = sc.w.data(&nk);
    let yes = u16::from_le_bytes(nd[o + PR::YES..o + PR::YES + 2].try_into().unwrap());
    assert_eq!(yes, 1);
}

/// The same session is not limited to the Grant: it acts on the grantee's
/// own holdings with the grantee's full player authority (here a real
/// Harvest of B's far holding, which no Grant names).
#[test]
fn a_grantee_session_also_acts_on_the_grantees_other_assets() {
    let mut sc = scene();
    let sess = wallet(0xB5);
    sc.set_session(sc.b, sc.b_c, sess, NOW + 3_600).unwrap();
    let season = sc.w.season.to_bytes();
    let (b_c, far, prov2) = (sc.b_c, sc.far, sc.prov2);
    sc.w.run(
        &frontier_abi::ix::Harvest {}.to_bytes(),
        &[
            (sess, true, false),
            (sess, true, true),
            (season, false, false),
            (b_c, false, true),
            (far, false, true),
            (prov2, false, false),
        ],
    )
    .unwrap();
    let d = sc.w.data(&far);
    let last = i64::from_le_bytes(
        d[HO::LAST_OWNER_ACTION..HO::LAST_OWNER_ACTION + 8]
            .try_into()
            .unwrap(),
    );
    assert_eq!(last, NOW);
}

// ------------------------------------------------------------ round 3: PS2 records

/// The single record the last instruction logged, checked against the
/// shared ABI (`frontier_abi::v2::log`): its kind and bell, the key naming
/// grant `nonce` of A, and every link — its entity in `chains_of` order,
/// resolved to the account that entity names, whose chain header now
/// equals the link. Returns the payload and the linked accounts in order.
fn the_record(sc: &Sc, kind: CqKind, nonce: u32, bell: u32) -> (Vec<u8>, Vec<[u8; 32]>) {
    use frontier_abi::log::{CitizenRef, EntityRef};
    use frontier_abi::v2::log::{self as l2, AnyKind, EntityRefV2};
    assert_eq!(sc.w.records.len(), 1, "one record per instruction");
    let body = &sc.w.records[0];
    let r = l2::decode(body).expect("the record decodes with the ABI decoder");
    assert_eq!(r.kind, AnyKind::Cq(kind));
    assert_eq!(r.bell, bell);
    let tag = addr::citizen_tag(&sc.a_c);
    assert_eq!(r.key, &rec::key(tag, nonce)[..]);
    let expect = l2::chains_of(r.kind, r.key, r.payload).expect("an entity table");
    let links: Vec<_> = r.links.iter().take(r.n_links).flatten().copied().collect();
    assert_eq!(
        links.len(),
        expect.iter().count(),
        "one link per expected entity"
    );
    let citizens = [sc.a_c, sc.b_c, sc.c_c];
    let mut linked = vec![];
    for (e, l) in expect.iter().zip(&links) {
        assert_eq!(e.entity, l.entity);
        assert!(!e.optional, "no optional links in a Grant record");
        let k = match e.who {
            EntityRefV2::Base(EntityRef::Citizen(CitizenRef::Tag8(t))) => *citizens
                .iter()
                .find(|c| addr::citizen_tag(c) == t)
                .expect("a citizen of the scene"),
            EntityRefV2::Base(EntityRef::Holding { p, q, site }) => sc.w.ctx().holding(p, q, site),
            ref w => panic!("unexpected entity {w:?}"),
        };
        let d = sc.w.data(&k);
        assert_eq!(
            crate::layout::chain_of(&d).unwrap(),
            (l.seq, l.head),
            "the account's chain header is the link"
        );
        linked.push(k);
    }
    (r.payload.to_vec(), linked)
}

/// The bell of `NOW` (genesis `T0`, 600-second bells).
const BELL: u32 = ((NOW - T0) / 600) as u32;

use frontier_abi::v2::log::CqKind;
use frontier_abi::v2::rights::record as rec;

#[test]
fn every_grant_instruction_logs_its_record() {
    let mut sc = scene();
    let g = sc.issue(0);
    let (pl, linked) = the_record(&sc, rec::ISSUED, 0, BELL);
    let x = rec::Issued::from_bytes(&pl).unwrap();
    assert_eq!(x.grantee_tag, addr::citizen_tag(&sc.b_c));
    assert_eq!((x.p, x.q), (PQ.0 as i32, PQ.1 as i32));
    assert_eq!((x.facility_site, x.station_site), (0, 1));
    assert_eq!((x.facility_gen, x.station_gen), (1, 1));
    assert_eq!((x.max_swaps, x.max_units), (3, 30));
    // The rent-exempt minimum the Grant needs (the harness pre-funds every
    // address it creates, so the account may hold more).
    assert_eq!(x.rent, frontier_abi::layout::rent(G::SIZE));
    assert!(sc.w.lamports(&g) >= x.rent);
    assert_eq!(linked, vec![sc.a_c]);

    let (f0, s0) = (sc.w.stock(&sc.f, NOW), sc.w.stock(&sc.s, NOW));
    sc.reserve(sc.b, sc.b_c, g, 10).unwrap();
    let (pl, linked) = the_record(&sc, rec::RESERVED, 0, BELL);
    let x = rec::Swap::from_bytes(&pl).unwrap();
    let (f1, s1) = (sc.w.stock(&sc.f, NOW), sc.w.stock(&sc.s, NOW));
    assert_eq!((x.seq, x.units), (0, 10));
    assert_eq!(x.grantee_tag, addr::citizen_tag(&sc.b_c));
    // The amounts are exactly what left the holdings.
    assert_eq!(x.ore, s0[ORE] - s1[ORE]);
    assert_eq!(x.wood, s0[WOOD] - s1[WOOD]);
    assert_eq!(x.arms, f0[ARMS] - f1[ARMS]);
    assert_eq!(linked, vec![sc.b_c, sc.s, sc.f]);

    sc.execute(sc.b, sc.b_c, g).unwrap();
    let (pl, linked) = the_record(&sc, rec::EXECUTED, 0, BELL);
    let y = rec::Swap::from_bytes(&pl).unwrap();
    let (f2, s2) = (sc.w.stock(&sc.f, NOW), sc.w.stock(&sc.s, NOW));
    assert_eq!(
        (y.seq, y.units, y.ore, y.wood, y.arms),
        (0, 10, x.ore, x.wood, x.arms)
    );
    assert_eq!(y.arms, s2[ARMS] - s1[ARMS]);
    assert_eq!((y.ore, y.wood), (f2[ORE] - f1[ORE], f2[WOOD] - f1[WOOD]));
    assert_eq!(linked, vec![sc.b_c, sc.s, sc.f]);

    sc.reserve(sc.b, sc.b_c, g, 4).unwrap();
    let (pl, _) = the_record(&sc, rec::RESERVED, 0, BELL);
    assert_eq!(rec::Swap::from_bytes(&pl).unwrap().seq, 1);
    sc.release(sc.b, g).unwrap();
    let (pl, linked) = the_record(&sc, rec::RELEASED, 0, BELL);
    let u = rec::Undo::from_bytes(&pl).unwrap();
    assert_eq!(u.by, rec::by::GRANTEE);
    assert_eq!(u.returned, [units(8), units(4), units(4)]);
    assert_eq!(u.kept, [0; 3]);
    assert_eq!(linked, vec![sc.s, sc.f]);

    // A revoke with nothing escrowed chains the issuer alone.
    sc.revoke(sc.a, sc.a_c, g).unwrap();
    let (pl, linked) = the_record(&sc, rec::REVOKED, 0, BELL);
    let u = rec::Undo::from_bytes(&pl).unwrap();
    assert_eq!(
        (u.by, u.returned, u.kept),
        (rec::by::ISSUER, [0; 3], [0; 3])
    );
    assert_eq!(linked, vec![sc.a_c]);

    let rent = sc.w.lamports(&g);
    let rent_to = sc.a;
    sc.close(sc.c, g, rent_to).unwrap();
    let (pl, linked) = the_record(&sc, rec::CLOSED, 0, BELL);
    let c = rec::Closed::from_bytes(&pl).unwrap();
    assert_eq!((c.rent, c.rent_to8), (rent, rec::tag8(&rent_to)));
    assert!(linked.is_empty());
}

#[test]
fn undo_records_name_only_what_went_back() {
    let mut sc = scene();
    let g = sc.issue(0);
    sc.reserve(sc.b, sc.b_c, g, 5).unwrap();
    // S closed: the revoke returns the arms only and keeps the inputs.
    sc.w.close_account(&sc.s);
    sc.revoke(sc.a, sc.a_c, g).unwrap();
    let (pl, linked) = the_record(&sc, rec::REVOKED, 0, BELL);
    let u = rec::Undo::from_bytes(&pl).unwrap();
    assert_eq!(u.returned, [0, 0, units(5)]);
    assert_eq!(u.kept, [units(10), units(5), 0]);
    assert_eq!(linked, vec![sc.a_c, sc.f]);
    // Nothing more can go back: refused, and no record survives.
    assert_eq!(sc.release(sc.c, g), rerr(E::ReturnBlocked));
    assert!(sc.w.records.is_empty());
}

#[test]
fn releases_say_who_undid_them() {
    // After the expiry, by anyone.
    let mut sc = scene();
    let g = sc.issue(0);
    sc.reserve(sc.b, sc.b_c, g, 2).unwrap();
    let later = NOW + 86_400;
    host_test::set_now(later);
    sc.release(sc.c, g).unwrap();
    let bell = ((later - T0) / 600) as u32;
    let (pl, _) = the_record(&sc, rec::RELEASED, 0, bell);
    assert_eq!(
        rec::Undo::from_bytes(&pl).unwrap().by,
        rec::by::AFTER_EXPIRY
    );
    // After a capture, by anyone: the facility side goes to F as it stands.
    let mut sc = scene();
    let g = sc.issue(0);
    sc.reserve(sc.b, sc.b_c, g, 2).unwrap();
    let (f, prov, c_c) = (sc.f, sc.prov, sc.c_c);
    sc.w.capture(&f, &prov, 0, &c_c);
    sc.release(sc.c, g).unwrap();
    let (pl, linked) = the_record(&sc, rec::RELEASED, 0, BELL);
    let u = rec::Undo::from_bytes(&pl).unwrap();
    assert_eq!(u.by, rec::by::STALE_HOLDING);
    assert_eq!(linked, vec![sc.s, sc.f]);
}

#[test]
fn a_refused_instruction_leaves_no_record() {
    let mut sc = scene();
    let g = sc.issue(0);
    assert_eq!(sc.reserve(sc.b, sc.b_c, g, 31), rerr(E::QuotaExceeded));
    assert!(sc.w.records.is_empty());
    assert_eq!(sc.execute(sc.b, sc.b_c, g), rerr(E::NoReservation));
    assert!(sc.w.records.is_empty());
}
