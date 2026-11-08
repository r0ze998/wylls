//! Workstream 03: the courier's client side and the shared cast of its
//! tests. The courier (`../courier`) is an external program; these
//! builders are what its author would ship next to it: fclient's own
//! Frontier instruction, wrapped.
//!
//! The cast and the path helpers follow
//! `permutation-frontier/svm-tests/tests/caravan.rs` (A owns a first
//! holding in a ring-4 Province with every tile open, a vault tile `vt`
//! some steps away; R of another faction owns site 1 there).

use std::path::PathBuf;

use fclient::ix::v2::{self as fx, PlaceRef, SendCaravanArgs};
use fclient::ix::Player;
use frontier_abi::v2::layout::province::province as P;
use frontier_abi::v2::layout::s1::caravan as CV;
use frontier_abi::v2::presets::MC_LOCAL_7D;
use frontier_abi::v2::Ix as I2;
use permutation_frontier_svm_tests::chain::{Build, Chain, Fail, Profile, SendResult};
use permutation_frontier_svm_tests::world::holding::{
    i64_at, read_kholding, trace, u32_at, u64_at, Estate,
};
use permutation_frontier_svm_tests::world::land::provinces_of;
use permutation_frontier_svm_tests::world::World;
use permutation_frontier_svm_tests::{sha256, AccountMeta, Address, Instruction, Keypair, Signer};
use permutation_rules::frontier::caravan::{self as kc, CARAVAN_FEE};

pub use permutation_frontier_svm_tests as h;

/// The bell the tests start in (caravan.rs's).
pub const B0: u32 = 20;
pub const MILLI: i64 = 1_000;

// ------------------------------------------------------------ the courier (mirror of courier/src/lib.rs)

pub const IFACE_VERSION: u8 = 1;
pub const OP_SEND_SIGNED: u8 = 0;
pub const OP_REGISTER_MANDATE: u8 = 1;
pub const OP_SEND_DELEGATED: u8 = 2;
pub const OP_REVOKE_MANDATE: u8 = 3;
pub const OP_HOSTILE: u8 = 0xEE;

/// The courier's error codes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum CourierError {
    InterfaceVersion = 9001,
    WrongFrontier = 9002,
    FrontierVersion = 9003,
    BadInstruction = 9004,
    MandateMismatch = 9005,
    MandateExpired = 9006,
    MandateExhausted = 9007,
    CargoOverCap = 9008,
    NotWallet = 9009,
    Accounts = 9010,
}

pub mod mandate {
    pub const USED: usize = 118;
    pub const SIZE: usize = 152;
}

fn workstream() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

/// The courier binary: `COURIER_SO`, else `../courier/target/deploy`.
/// `hostile` picks the test-only build (`COURIER_HOSTILE_SO`,
/// `target/deploy-hostile`).
pub fn courier_so(hostile: bool) -> Vec<u8> {
    let (var, dir) = if hostile {
        (
            "COURIER_HOSTILE_SO",
            "courier/target/deploy-hostile/wylls_courier.so",
        )
    } else {
        ("COURIER_SO", "courier/target/deploy/wylls_courier.so")
    };
    let p = std::env::var_os(var)
        .map(PathBuf::from)
        .unwrap_or_else(|| workstream().join(dir));
    std::fs::read(&p).unwrap_or_else(|e| {
        panic!(
            "{}: {e} (run workstreams/03-composability/run.sh)",
            p.display()
        )
    })
}

/// The courier's id on the test chain (any id works: the courier derives
/// its PDAs from the id it runs under).
pub fn courier_id(hostile: bool) -> Address {
    Address::new_from_array(sha256(&[if hostile {
        b"wylls-courier hostile test id v1".as_slice()
    } else {
        b"wylls-courier test id v1".as_slice()
    }]))
}

/// Deploys the courier next to the Frontier program; returns its id.
pub fn deploy_courier(c: &mut Chain, hostile: bool) -> Address {
    let so = courier_so(hostile);
    let k = courier_id(hostile);
    c.deploy(k, &so, so.len(), None);
    k
}

/// `[frontier] ‖ ix.accounts` with data `[op, ver] ‖ ix.data`.
pub fn wrap(courier: Address, op: u8, ver: u8, ix: &Instruction) -> Instruction {
    let mut accounts = vec![AccountMeta::new_readonly(ix.program_id, false)];
    accounts.extend(ix.accounts.iter().cloned());
    let mut data = vec![op, ver];
    data.extend_from_slice(&ix.data);
    Instruction {
        program_id: courier,
        accounts,
        data,
    }
}

/// Op 0 SendSigned around fclient's SendCaravan.
pub fn send_signed(courier: Address, send: &Instruction) -> Instruction {
    wrap(courier, OP_SEND_SIGNED, IFACE_VERSION, send)
}

pub fn pda(seed: &[u8], season: &Address, citizen: &Address, program: &Address) -> Address {
    Address::find_program_address(&[seed, season.as_ref(), citizen.as_ref()], program).0
}

/// The mandate, session and purse PDAs of `(season, citizen)`.
pub struct Pdas {
    pub mandate: Address,
    pub session: Address,
    pub purse: Address,
}

pub fn pdas(courier: &Address, season: &Address, citizen: &Address) -> Pdas {
    Pdas {
        mandate: pda(b"mandate", season, citizen, courier),
        session: pda(b"session", season, citizen, courier),
        purse: pda(b"purse", season, citizen, courier),
    }
}

/// Op 1 RegisterMandate (provisional adapter).
pub fn register_mandate(
    courier: Address,
    wallet: Address,
    season: Address,
    citizen: Address,
    expires: i64,
    max_sends: u16,
    max_cargo: [u32; 8],
) -> Instruction {
    let m = pdas(&courier, &season, &citizen);
    let mut data = vec![OP_REGISTER_MANDATE, IFACE_VERSION];
    data.extend_from_slice(&expires.to_le_bytes());
    data.extend_from_slice(&max_sends.to_le_bytes());
    for u in max_cargo {
        data.extend_from_slice(&u.to_le_bytes());
    }
    Instruction {
        program_id: courier,
        accounts: vec![
            AccountMeta::new(wallet, true),
            AccountMeta::new_readonly(season, false),
            AccountMeta::new_readonly(citizen, false),
            AccountMeta::new(m.mandate, false),
            AccountMeta::new_readonly(Address::default(), false),
        ],
        data,
    }
}

/// Op 2 SendDelegated around fclient's SendCaravan: the SendCaravan's own
/// prologue (actor, payer) is replaced by the session and purse PDAs; the
/// cranker pays only the transaction fee.
pub fn send_delegated(courier: Address, cranker: Address, send: &Instruction) -> Instruction {
    let season = send.accounts[2].pubkey;
    let citizen = send.accounts[3].pubkey;
    let m = pdas(&courier, &season, &citizen);
    let mut accounts = vec![
        AccountMeta::new_readonly(send.program_id, false),
        AccountMeta::new_readonly(cranker, true),
        AccountMeta::new(m.mandate, false),
        AccountMeta::new_readonly(m.session, false),
        AccountMeta::new(m.purse, false),
        AccountMeta::new_readonly(season, false),
        AccountMeta::new(citizen, false),
    ];
    accounts.extend(send.accounts[4..].iter().cloned());
    let mut data = vec![OP_SEND_DELEGATED, IFACE_VERSION];
    data.extend_from_slice(&send.data);
    Instruction {
        program_id: courier,
        accounts,
        data,
    }
}

pub fn revoke_mandate(courier: Address, wallet: Address, mandate: Address) -> Instruction {
    Instruction {
        program_id: courier,
        accounts: vec![
            AccountMeta::new(wallet, true),
            AccountMeta::new(mandate, false),
        ],
        data: vec![OP_REVOKE_MANDATE, IFACE_VERSION],
    }
}

// ------------------------------------------------------------ sending and asserting

/// The compute-budget profile of a courier transaction: the ladder's CU
/// ceiling and a loaded-data limit that covers the actual message (the
/// courier's ProgramData included), never below the Frontier kind's
/// `L(kind)`.
pub fn send_any(c: &mut Chain, kind: I2, ixs: &[Instruction], signers: &[&Keypair]) -> SendResult {
    let p = profile_for(c, kind, ixs, signers);
    c.send_with(&p, ixs, signers)
}

/// `L(kind)` as the relay and the client request it.
pub fn l_kind(c: &Chain, kind: I2) -> u32 {
    let (bytes, n) = frontier_abi::v2::budgets::loaded_accounts(kind);
    permutation_rules::frontier::fees::loaded_limit(c.programdata_len(), bytes, n)
        .max(frontier_abi::budgets::LOADED_LIMIT_WORKING_DEFAULT)
}

/// SIMD-0186 loaded bytes of `msg` under the rule the validator drill
/// measured (`drill/cpi-loaded-drill.sh`, solana-test-validator 3.1.9): the
/// harness's `Chain::loaded_size` plus the ProgramData (64 + data) of every
/// **listed** LoaderV3 program account the harness leaves out (it counts
/// ProgramData only for top-level programs; the drill shows a program only
/// listed, or reached by CPI, has its ProgramData counted too).
pub fn loaded_validator_rule(c: &Chain, msg: &solana_message::Message) -> u64 {
    let mut total = c.loaded_size(msg);
    let top: Vec<Address> = msg
        .instructions
        .iter()
        .map(|ci| msg.account_keys[ci.program_id_index as usize])
        .collect();
    let loader = permutation_frontier_svm_tests::chain::loader_v3();
    let mut seen: Vec<Address> = vec![];
    for k in &msg.account_keys {
        if top.contains(k) {
            continue;
        }
        let Some(a) = c.svm.get_account(k) else {
            continue;
        };
        if a.owner != loader || a.data.len() < 36 || a.data[..4] != 2u32.to_le_bytes() {
            continue;
        }
        let pd = Address::new_from_array(a.data[4..36].try_into().expect("32"));
        if msg.account_keys.contains(&pd) || seen.contains(&pd) {
            continue;
        }
        seen.push(pd);
        if let Some(p) = c.svm.get_account(&pd) {
            total += 64 + p.data.len() as u64;
        }
    }
    total
}

/// The harness's page size for loaded-data limits (32 KiB).
pub const PAGE: u64 = 32 * 1024;

/// The smallest page-multiple loaded-data limit `ixs` need on `c` now, by
/// the validator's rule ([`loaded_validator_rule`]).
pub fn loaded_need(c: &Chain, ixs: &[Instruction], signers: &[&Keypair]) -> u32 {
    let t = c.transaction(&Profile::NONE, ixs, signers);
    (loaded_validator_rule(c, &t.message).div_ceil(PAGE) * PAGE) as u32
}

/// The harness's own figure (top-level ProgramData only).
pub fn loaded_harness(c: &Chain, ixs: &[Instruction], signers: &[&Keypair]) -> u64 {
    let t = c.transaction(&Profile::NONE, ixs, signers);
    c.loaded_size(&t.message)
}

/// The same, by the validator's rule.
pub fn loaded_validator(c: &Chain, ixs: &[Instruction], signers: &[&Keypair]) -> u64 {
    let t = c.transaction(&Profile::NONE, ixs, signers);
    loaded_validator_rule(c, &t.message)
}

pub fn profile_for(c: &Chain, kind: I2, ixs: &[Instruction], signers: &[&Keypair]) -> Profile {
    let need = loaded_need(c, ixs, signers);
    Profile::NONE
        .with_cu(frontier_abi::budgets::CU_LADDER_MAX)
        .with_loaded(l_kind(c, kind).max(need))
}

/// The courier itself refused with `e`.
#[track_caller]
pub fn assert_courier(r: SendResult, courier: &Address, e: CourierError) -> Fail {
    match r {
        Ok(l) => panic!("expected courier {e:?}, landed:\n{}", l.logs.join("\n")),
        Err(f) => {
            assert_eq!(
                f.code,
                Some(e as u32),
                "expected courier {e:?}, got {} / {:?}\n{}",
                f.err,
                f.code,
                f.logs.join("\n")
            );
            let line = format!(
                "Program {courier} failed: custom program error: {:#x}",
                e as u32
            );
            assert!(
                f.logs.iter().any(|l| l == &line),
                "{e:?} not raised by the courier:\n{}",
                f.logs.join("\n")
            );
            f
        }
    }
}

/// A runtime refusal (no program error code), its message containing
/// `needle`.
#[track_caller]
pub fn assert_runtime(r: SendResult, needle: &str) -> Fail {
    match r {
        Ok(l) => panic!(
            "expected a runtime refusal ({needle}), landed:\n{}",
            l.logs.join("\n")
        ),
        Err(f) => {
            let all = format!("{}\n{}", f.err, f.logs.join("\n"));
            assert!(all.contains(needle), "expected {needle:?}:\n{all}");
            f
        }
    }
}

// ------------------------------------------------------------ the cast

/// A ring-4 Province of wedge `w` (outside every heartland).
pub fn ring4(w: u8, i: usize) -> (i16, i16) {
    provinces_of(4, Some(w))[i]
}

pub struct Cast {
    pub c: Chain,
    pub w: World,
    pub a: Estate,
    pub r: Estate,
    pub vt: u8,
    pub courier: Address,
}

impl Cast {
    /// The cast with the courier deployed (`hostile`: the test-only build).
    pub fn new(hostile: bool) -> Cast {
        let mut c = Chain::new(Build::TestBeacon);
        let w = World::running(&mut c, 1);
        w.cq_set_params(&mut c, &MC_LOCAL_7D.cq);
        w.to_bell(&mut c, B0, 5);
        let t = ring4(0, 0);
        let a = w.cq_estate(&mut c, "a", 0, t, 0);
        let r = w.cq_estate(&mut c, "r", 1, t, 1);
        w.open_tiles(&mut c, t.0, t.1, &(0..61).collect::<Vec<u8>>());
        w.enrich(&mut c, &a, 5_000);
        w.enrich(&mut c, &r, 5_000);
        let vt = far_tile(&c, &a, 4);
        let courier = deploy_courier(&mut c, hostile);
        Cast {
            c,
            w,
            a,
            r,
            vt,
            courier,
        }
    }

    pub fn build_vault(&mut self) -> SendResult {
        let ix = fx::build_vault(
            &self.w.a,
            &self.a.player(),
            self.a.href(),
            (self.a.p, self.a.q),
            self.vt,
        );
        send_any(&mut self.c, I2::BuildVault, &[ix], &[&self.a.wallet])
    }

    pub fn vault(&self) -> Address {
        self.w.a.vault(self.a.p as i32, self.a.q as i32, self.vt)
    }

    pub fn vault_place(&self, gen: u8) -> PlaceRef {
        PlaceRef::Vault {
            p: self.a.p,
            q: self.a.q,
            tile: self.vt,
            gen,
        }
    }

    /// A's holding → A's vault.
    pub fn send_args(&self, seq: u32, cargo: [u32; 8]) -> SendCaravanArgs {
        let (steps, path) = local_path(&self.c, &self.a, self.a.tile, self.vt);
        SendCaravanArgs {
            seq,
            src: PlaceRef::Holding {
                h: self.a.href(),
                gen: self.a.gen,
            },
            dst: self.vault_place(1),
            steps,
            path,
            cargo,
            fee: CARAVAN_FEE,
            provinces: vec![(self.a.p, self.a.q)],
        }
    }

    /// A's holding → R's holding.
    pub fn send_to_r_args(&self, seq: u32, cargo: [u32; 8]) -> SendCaravanArgs {
        let (steps, path) = local_path(&self.c, &self.a, self.a.tile, self.r.tile);
        SendCaravanArgs {
            dst: PlaceRef::Holding {
                h: self.r.href(),
                gen: self.r.gen,
            },
            steps,
            path,
            ..self.send_args(seq, cargo)
        }
    }

    /// fclient's SendCaravan as `p` (A's wallet by default).
    pub fn send_ix(&self, p: &Player, x: &SendCaravanArgs) -> Instruction {
        fx::send_caravan(&self.w.a, p, x)
    }

    pub fn caravan(&self, seq: u32) -> Address {
        self.w.a.caravan(self.a.citizen_tag(), seq)
    }

    pub fn store(&self, r: usize) -> i64 {
        read_kholding(&self.c.data(&self.a.holding)).stores[r].value
    }

    pub fn stores(&self, e: &Estate) -> [i64; 8] {
        let k = read_kholding(&self.c.data(&e.holding));
        core::array::from_fn(|r| k.stores[r].value)
    }

    pub fn vault_store(&self, r: usize) -> i64 {
        i64_at(
            &self.c.data(&self.vault()),
            frontier_abi::v2::layout::s1::vault::store(r),
        )
    }

    pub fn caravans(&self) -> u32 {
        u32_at(
            &self.c.data(&self.a.citizen),
            frontier_abi::v2::layout::player::citizen::CARAVANS,
        )
    }

    /// Past the caravan's arrival, its Province resolved past its last
    /// slot bell (crafted resolves, as caravan.rs).
    pub fn arrive(&mut self, caravan: &Address) {
        let d = self.c.data(caravan);
        let arrive = i64_at(&d, CV::ARRIVE_TS);
        let last = u32_at(&d, CV::LAST_BELL);
        if self.c.now <= arrive {
            self.c.set_time(arrive + 1);
        }
        let b = self.w.bell(&self.c).max(last + 1);
        self.w.set_resolved_next(&mut self.c, &self.a.province, b);
    }

    pub fn settle_ix(&self, caravan: Address, dst: Address, by: &Address) -> Instruction {
        let rent_to = Address::new_from_array(
            self.c.data(&caravan)[CV::RENT_TO..CV::RENT_TO + 32]
                .try_into()
                .unwrap(),
        );
        fx::settle_caravan(
            &self.w.a,
            *by,
            caravan,
            dst,
            *by,
            rent_to,
            &[(self.a.p, self.a.q)],
        )
    }

    /// The owner's SetSession (wallet-signed, top level).
    pub fn set_session(&mut self, session: &Address, expiry: i64) -> SendResult {
        let ix = fclient::ix::set_session(&self.w.a, &self.a.player(), session, expiry);
        let signers = [&self.a.wallet];
        let p = Profile::client(h::Ix::SetSession, self.c.programdata_len());
        self.c.send_with(&p, &[ix], &signers)
    }
}

/// A non-site tile of the estate's Province exactly `n` steps away.
pub fn far_tile(c: &Chain, e: &Estate, n: usize) -> u8 {
    let pd = c.data(&e.province);
    let sites = &pd[P::SITES..P::SITES + pd[P::SITE_COUNT] as usize];
    (0..61u8)
        .find(|&t| !sites.contains(&t) && local_dirs(c, e, e.tile, t).is_some_and(|d| d.len() == n))
        .expect("a tile n steps away")
}

/// A shortest path inside the estate's Province (caravan.rs's).
pub fn local_dirs(c: &Chain, e: &Estate, from: u8, to: u8) -> Option<Vec<u8>> {
    use std::collections::{HashMap, VecDeque};
    let pass = u64_at(&c.data(&e.province), P::PASSABLE_MASK);
    let (p, q) = (e.p as i32, e.q as i32);
    let mut prev: HashMap<u8, (u8, u8)> = HashMap::new();
    let mut queue = VecDeque::from([from]);
    prev.insert(from, (from, 9));
    while let Some(t) = queue.pop_front() {
        if t == to {
            let mut dirs = vec![];
            let mut x = t;
            while x != from {
                let (pr, d) = prev[&x];
                dirs.push(d);
                x = pr;
            }
            dirs.reverse();
            return Some(dirs);
        }
        for d in 0..6u8 {
            let s = trace((p, q, t), &[d])[0];
            if (s.p, s.q) != (p, q) || pass & (1u64 << s.tile) == 0 || prev.contains_key(&s.tile) {
                continue;
            }
            prev.insert(s.tile, (t, d));
            queue.push_back(s.tile);
        }
    }
    None
}

pub fn local_path(c: &Chain, e: &Estate, from: u8, to: u8) -> (u8, [u8; 12]) {
    let dirs = local_dirs(c, e, from, to).expect("a path");
    (dirs.len() as u8, kc::pack(&dirs).expect("packs"))
}

/// A Player whose actor and payer are `k`, for A's wallet `wallet`.
pub fn acting(k: &Keypair, wallet: &Address) -> Player {
    Player {
        actor: k.pubkey(),
        payer: k.pubkey(),
        wallet: *wallet,
    }
}
