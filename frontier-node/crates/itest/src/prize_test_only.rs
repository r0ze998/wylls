//! TEST ONLY (⑰, 2026-11-15; option (A), reviewed and agreed with ⑳): the runner-placed fixture of ONE existing NFT
//! pass Entry of the TEST ONLY nft-experimental prize program on the local test candidate world. It stands for an
//! Entry that existed before pass deposits were refused. IT IS NOT A DEPOSIT and is never reported as one: the prize
//! program refuses every PayResident (ResidentDepositsDisabled), and nothing here calls it.
//!
//! Scope (docs/integration/CLAUDE-NFT-PRIZE-RUNNER-OPTION-PROPOSAL-20261115.md, "Option (A)"):
//! - only under `--prize-test-only-so` (itself only with `--lane-candidate`); without it nothing here runs;
//! - ONE exact control line per run, from the launcher (`OneShot`): the first line consumes the channel whatever its
//!   outcome; it names no address to write and no key;
//! - every check is on the runner's own chain, before writing: the run (run id and instance), the pool, the asset
//!   (Core, the policy's collection), its guard, the resident record, the generation, `paid_by` = the current owner,
//!   and nothing at the derived Entry address. A refusal names its check and changes nothing;
//! - the write is that one Entry only, with `Chain::set_account` and synthetic rent-exempt lamports (no user, page or
//!   mint key pays). The localnet's memory-only RPC policy and `allow_tamper = false` are not touched: no RPC writes.
//!
//! The prize program's layouts are carried here as constants (the crate does not depend on permutation-prize; its
//! own tests and the LiteSVM tests pin the program side): `pool` and `entry_resident` of permutation-prize/src/lib.rs.

use fclient::ports::Account;
use fclient::Address;
use frontier_abi::resident_auth::{self, Binding, Refusal as AuthRefusal};
use frontier_abi::resident_policy;
use localnet::chain::Chain;
use serde_json::{json, Value};

/// The TEST ONLY prize program's fixed id: [0x50; 32] (`6QWeT6Fp…`).
pub const PRIZE_TEST_ONLY_PROGRAM: [u8; 32] = [0x50; 32];
const _: () = assert!(
    PRIZE_TEST_ONLY_PROGRAM[0] != 0x45
        && PRIZE_TEST_ONLY_PROGRAM[0] != 0x4c
        && PRIZE_TEST_ONLY_PROGRAM[0] != 0x4e,
    "the TEST ONLY prize id must not collide with the conquest lane, the candidate or 0x4E"
);
/// Metaplex Core (the asset's owner program).
pub const CORE: &str = crate::expedition_play::CORE_PROGRAM;

// permutation-prize `pool` (640 B, magic WYPRPOOL).
const POOL_SIZE: usize = 640;
const POOL_MAGIC: &[u8; 8] = b"WYPRPOOL";
const POOL_STATE: usize = 10;
const POOL_STATE_OPEN: u8 = 0;
const POOL_SEASON_ID: usize = 16;
const POOL_GAME: usize = 24;
const POOL_FEE: usize = 184;
// permutation-prize `entry_resident` (192 B, magic WYPRNFTE).
pub const ENTRY_SIZE: usize = 192;
const ENTRY_MAGIC: &[u8; 8] = b"WYPRNFTE";
const E_BUMP: usize = 8;
const E_PAY_GENERATION: usize = 12;
const E_POOL: usize = 16;
const E_ASSET: usize = 48;
const E_AMOUNT: usize = 80;
const E_PAID_BY: usize = 104;
/// Rent exemption of the 192-byte Entry: (128 + 192) × 3480 × 2 lamports (the standard rent).
pub const ENTRY_LAMPORTS: u64 = (128 + ENTRY_SIZE as u64) * 3480 * 2;

/// Why a fixture line was refused; each names one check.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    Schema,
    OneShot,
    Run,
    Pool,
    Asset,
    Guard,
    Record,
    Generation,
    PaidBy,
    EntryExists,
}

impl Refusal {
    pub fn code(self) -> &'static str {
        match self {
            Refusal::Schema => "schema",
            Refusal::OneShot => "one_shot",
            Refusal::Run => "run",
            Refusal::Pool => "pool",
            Refusal::Asset => "asset",
            Refusal::Guard => "guard",
            Refusal::Record => "record",
            Refusal::Generation => "generation",
            Refusal::PaidBy => "paid_by",
            Refusal::EntryExists => "entry_exists",
        }
    }
}

/// The one control line, parsed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FixtureRequest {
    pub asset: Address,
    pub paid_by: Address,
    pub pay_generation: u32,
    pub run_id: [u8; 16],
    pub instance: [u8; 32],
}

fn key_of(v: &Value) -> Option<Address> {
    v.as_str()?.parse().ok()
}
fn hex_fixed<const N: usize>(v: &Value) -> Option<[u8; N]> {
    let s = v.as_str()?;
    if s.len() != 2 * N
        || !s
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    hex::decode(s).ok()?.try_into().ok()
}

/// `{"prize_test_only_fixture":{"asset","paid_by","pay_generation","run_id","instance"}}`, exactly those keys.
pub fn parse_line(line: &str) -> Result<FixtureRequest, Refusal> {
    let v: Value = serde_json::from_str(line.trim()).map_err(|_| Refusal::Schema)?;
    let top = v.as_object().ok_or(Refusal::Schema)?;
    if top.len() != 1 {
        return Err(Refusal::Schema);
    }
    let o = top
        .get("prize_test_only_fixture")
        .and_then(Value::as_object)
        .ok_or(Refusal::Schema)?;
    let want = ["asset", "paid_by", "pay_generation", "run_id", "instance"];
    if o.len() != want.len() || !want.iter().all(|k| o.contains_key(*k)) {
        return Err(Refusal::Schema);
    }
    let pay_generation = o["pay_generation"]
        .as_u64()
        .filter(|g| *g <= u32::MAX as u64)
        .ok_or(Refusal::Schema)? as u32;
    Ok(FixtureRequest {
        asset: key_of(&o["asset"]).ok_or(Refusal::Schema)?,
        paid_by: key_of(&o["paid_by"]).ok_or(Refusal::Schema)?,
        pay_generation,
        run_id: hex_fixed::<16>(&o["run_id"]).ok_or(Refusal::Schema)?,
        instance: hex_fixed::<32>(&o["instance"]).ok_or(Refusal::Schema)?,
    })
}

/// The one-shot channel: the first line is consumed whatever its outcome; every later line is `OneShot`.
#[derive(Default)]
pub struct OneShot {
    used: bool,
}

impl OneShot {
    /// Take the line: the first call is the only one that may reach `place`.
    pub fn take(&mut self, line: &str) -> Result<FixtureRequest, Refusal> {
        if self.used {
            return Err(Refusal::OneShot);
        }
        self.used = true;
        parse_line(line)
    }
}

/// What was written.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Placed {
    pub entry: Address,
    pub pool: Address,
    pub amount: u64,
}

/// The prize pool's address of `game`'s Season `season_id` (permutation-prize `["pool", game, season_id]`).
pub fn pool_address(game: &Address, season_id: u64) -> Address {
    Address::find_program_address(
        &[b"pool", game.as_ref(), &season_id.to_le_bytes()],
        &Address::new_from_array(PRIZE_TEST_ONLY_PROGRAM),
    )
    .0
}

/// Every check, then the one Entry. `game` is the candidate program; nothing is written on any refusal.
pub fn place(
    c: &mut Chain,
    game: &Address,
    season_id: u64,
    req: &FixtureRequest,
) -> Result<Placed, Refusal> {
    let prize = Address::new_from_array(PRIZE_TEST_ONLY_PROGRAM);
    // The run: this very chain (a line meant for another world, or a restarted one, is refused).
    if c.run_id() != req.run_id || c.status_instance() != req.instance {
        return Err(Refusal::Run);
    }
    // The pool: the TEST ONLY program's, at its address, Open, of this game and Season.
    let pool = pool_address(game, season_id);
    let pd = c.account(&pool).ok_or(Refusal::Pool)?;
    let d = &pd.data;
    if pd.owner != prize
        || d.len() != POOL_SIZE
        || &d[..8] != POOL_MAGIC
        || d[POOL_STATE] != POOL_STATE_OPEN
        || d[POOL_SEASON_ID..POOL_SEASON_ID + 8] != season_id.to_le_bytes()
        || d[POOL_GAME..POOL_GAME + 32] != game.to_bytes()
    {
        return Err(Refusal::Pool);
    }
    let amount = u64::from_le_bytes(
        d[POOL_FEE..POOL_FEE + 8]
            .try_into()
            .map_err(|_| Refusal::Pool)?,
    );
    // The game's resident policy (Core, the resident program, the collection, the guard authority).
    let policy_key = fclient::addr::resident_policy(game);
    let pa = c.account(&policy_key).ok_or(Refusal::Asset)?;
    if pa.owner != *game {
        return Err(Refusal::Asset);
    }
    let policy = resident_policy::read(&pa.data).ok_or(Refusal::Asset)?;
    // The asset and its resident record, read by the game's own reader: the current owner and generation.
    let resident_program = Address::new_from_array(policy.resident_program);
    let resident = fclient::addr::resident_account(&resident_program, &req.asset);
    let (aa, ra) = (
        c.account(&req.asset).ok_or(Refusal::Asset)?,
        c.account(&resident).ok_or(Refusal::Record)?,
    );
    let binding = Binding {
        asset: req.asset.to_bytes(),
        resident: resident.to_bytes(),
    };
    let holder = resident_auth::holder(
        &binding,
        &policy,
        &resident_auth::Account {
            key: req.asset.to_bytes(),
            owner: aa.owner.to_bytes(),
            data: &aa.data,
        },
        &resident_auth::Account {
            key: resident.to_bytes(),
            owner: ra.owner.to_bytes(),
            data: &ra.data,
        },
    )
    .map_err(|r| match r {
        AuthRefusal::Unguarded => Refusal::Guard,
        AuthRefusal::Resident => Refusal::Record,
        _ => Refusal::Asset,
    })?;
    if holder.generation != req.pay_generation {
        return Err(Refusal::Generation);
    }
    if holder.owner != req.paid_by.to_bytes() {
        return Err(Refusal::PaidBy);
    }
    // The Entry: exactly the prize program's derivation, and nothing there yet.
    let (entry, bump) =
        Address::find_program_address(&[b"entry-nft", pool.as_ref(), req.asset.as_ref()], &prize);
    if c.account(&entry)
        .is_some_and(|a| a.lamports > 0 || !a.data.is_empty())
    {
        return Err(Refusal::EntryExists);
    }
    let mut data = vec![0u8; ENTRY_SIZE];
    data[..8].copy_from_slice(ENTRY_MAGIC);
    data[E_BUMP] = bump;
    data[E_PAY_GENERATION..E_PAY_GENERATION + 4].copy_from_slice(&req.pay_generation.to_le_bytes());
    data[E_POOL..E_POOL + 32].copy_from_slice(pool.as_ref());
    data[E_ASSET..E_ASSET + 32].copy_from_slice(req.asset.as_ref());
    data[E_AMOUNT..E_AMOUNT + 8].copy_from_slice(&amount.to_le_bytes());
    data[E_PAID_BY..E_PAID_BY + 32].copy_from_slice(req.paid_by.as_ref());
    c.set_account(
        entry,
        Account {
            lamports: ENTRY_LAMPORTS,
            data,
            owner: prize,
            executable: false,
        },
    )
    .map_err(|_| Refusal::EntryExists)?;
    Ok(Placed {
        entry,
        pool,
        amount,
    })
}

/// The confirmation line (stdout): TEST ONLY, never a deposit.
pub fn confirmation(req: &FixtureRequest, p: &Placed) -> Value {
    json!({"prize_test_only_fixture_written": {
        "test_only": "fixture: an existing NFT Entry, NOT a deposit",
        "entry": p.entry.to_string(), "asset": req.asset.to_string(), "paid_by": req.paid_by.to_string(),
        "pay_generation": req.pay_generation, "pool": p.pool.to_string(), "amount": p.amount.to_string(),
        "run_id": hex::encode(req.run_id), "instance": hex::encode(req.instance)}})
}

/// The refusal line (stderr): the check that refused it; nothing was written.
pub fn refusal_line(r: Refusal) -> Value {
    json!({"prize_test_only_fixture_refused": {"reason": r.code(), "written": false}})
}

#[cfg(test)]
mod tests {
    use super::*;

    const RUN: &str = "0123456789abcdef0123456789abcdef";
    fn line(extra: &str) -> String {
        format!(
            r#"{{"prize_test_only_fixture":{{"asset":"{a}","paid_by":"{p}","pay_generation":2,"run_id":"{RUN}","instance":"{i}"{extra}}}}}"#,
            a = Address::new_from_array([0x5a; 32]),
            p = Address::new_from_array([0xa1; 32]),
            i = "ab".repeat(32),
        )
    }

    #[test]
    fn the_line_is_exact() {
        let r = parse_line(&line("")).unwrap();
        assert_eq!(r.pay_generation, 2);
        assert_eq!(hex::encode(r.run_id), RUN);
        assert_eq!(
            parse_line(&line(r#","extra":1"#)),
            Err(Refusal::Schema),
            "an extra key"
        );
        assert_eq!(
            parse_line(&line("").replace(r#""pay_generation":2,"#, "")),
            Err(Refusal::Schema),
            "a missing key"
        );
        assert_eq!(
            parse_line(
                &line("").replace(r#""pay_generation":2"#, r#""pay_generation":4294967296"#)
            ),
            Err(Refusal::Schema),
            "not a u32"
        );
        assert_eq!(
            parse_line(&line("").replace(RUN, &RUN.to_uppercase())),
            Err(Refusal::Schema),
            "hex is lowercase"
        );
        assert_eq!(parse_line("not json"), Err(Refusal::Schema));
        assert_eq!(
            parse_line(&format!(r#"{{"x":1,{}"#, &line("")[1..])),
            Err(Refusal::Schema),
            "another top key"
        );
    }

    #[test]
    fn one_shot_consumes_the_channel_whatever_the_outcome() {
        let mut s = OneShot::default();
        assert_eq!(s.take("garbage"), Err(Refusal::Schema));
        assert_eq!(
            s.take(&line("")),
            Err(Refusal::OneShot),
            "a refusal also closes it"
        );
        let mut t = OneShot::default();
        assert!(t.take(&line("")).is_ok());
        assert_eq!(t.take(&line("")), Err(Refusal::OneShot));
    }

    #[test]
    fn the_test_id_and_layout_constants() {
        assert_eq!(
            Address::new_from_array(PRIZE_TEST_ONLY_PROGRAM).to_string(),
            "6QWeT6FpJrm8AF1btu6WH2k2Xhq6t5vbheKVfQavmeoZ"
        );
        assert_eq!(ENTRY_LAMPORTS, 2_227_200);
        assert_eq!(
            refusal_line(Refusal::EntryExists)["prize_test_only_fixture_refused"]["reason"],
            "entry_exists"
        );
    }

    // ---- place() over a built fixture (in-process chain; fixed bytes; no key, no RPC)

    use frontier_abi::resident_auth::{resident_account as R, Policy};
    use localnet::chain::Config;

    const GAME: [u8; 32] = [0x4c; 32];
    const SEASON: u64 = 11;
    const RESIDENT_PROGRAM: [u8; 32] = [0x33; 32];
    const COLLECTION: [u8; 32] = [0x55; 32];
    const GUARD: [u8; 32] = [0x66; 32];
    const OWNER_A: [u8; 32] = [0xa1; 32];
    const OWNER_B: [u8; 32] = [0xb2; 32];
    const ASSET: [u8; 32] = [0x5a; 32];
    const FEE: u64 = 25_000_000;

    /// The guard registry after an AssetV1 base ending at `base` (frontier-abi resident_auth's own test helper).
    fn guarded_tail(base: usize, guard: &[u8; 32]) -> Vec<u8> {
        let (freeze_at, transfer_at, registry_at) = (base + 9, base + 11, base + 12);
        let mut t = vec![3u8];
        t.extend_from_slice(&(registry_at as u64).to_le_bytes());
        t.extend_from_slice(&[5, 1, 7]);
        t.push(4);
        t.extend_from_slice(&2u32.to_le_bytes());
        for (kind, at) in [(5u8, freeze_at), (7u8, transfer_at)] {
            t.extend_from_slice(&[kind, 3]);
            t.extend_from_slice(guard);
            t.extend_from_slice(&(at as u64).to_le_bytes());
        }
        t.extend_from_slice(&0u32.to_le_bytes());
        t
    }
    fn asset_bytes(owner: [u8; 32], guarded: bool) -> Vec<u8> {
        let mut d = vec![0u8; 75];
        d[0] = 1;
        d[1..33].copy_from_slice(&owner);
        d[33] = 2;
        d[34..66].copy_from_slice(&COLLECTION);
        if guarded {
            d.extend_from_slice(&guarded_tail(75, &GUARD));
        }
        d
    }
    fn acct(owner: [u8; 32], data: Vec<u8>) -> Account {
        Account {
            lamports: 10_000_000,
            data,
            owner: Address::new_from_array(owner),
            executable: false,
        }
    }
    struct W {
        c: Chain,
        game: Address,
        tracked: Vec<Address>,
    }
    fn world(
        state: u8,
        pool_game: [u8; 32],
        asset_owner_program: [u8; 32],
        guarded: bool,
        generation: u32,
        with_record: bool,
    ) -> W {
        let mut c = Chain::new(Config::default());
        let game = Address::new_from_array(GAME);
        let pool = pool_address(&game, SEASON);
        let mut pd = vec![0u8; POOL_SIZE];
        pd[..8].copy_from_slice(POOL_MAGIC);
        pd[POOL_STATE] = state;
        pd[POOL_SEASON_ID..POOL_SEASON_ID + 8].copy_from_slice(&SEASON.to_le_bytes());
        pd[POOL_GAME..POOL_GAME + 32].copy_from_slice(&pool_game);
        pd[POOL_FEE..POOL_FEE + 8].copy_from_slice(&FEE.to_le_bytes());
        c.set_account(pool, acct(PRIZE_TEST_ONLY_PROGRAM, pd))
            .unwrap();
        let mut pol = vec![0u8; resident_policy::LEN];
        assert!(resident_policy::write_once(
            &mut pol,
            &Policy {
                core_program: CORE.parse::<Address>().unwrap().to_bytes(),
                resident_program: RESIDENT_PROGRAM,
                collection: COLLECTION,
                guard_authority: GUARD
            }
        ));
        let policy_key = fclient::addr::resident_policy(&game);
        c.set_account(policy_key, acct(GAME, pol)).unwrap();
        let asset = Address::new_from_array(ASSET);
        c.set_account(
            asset,
            acct(asset_owner_program, asset_bytes(OWNER_A, guarded)),
        )
        .unwrap();
        let record =
            fclient::addr::resident_account(&Address::new_from_array(RESIDENT_PROGRAM), &asset);
        if with_record {
            let mut r = vec![0u8; R::LEN];
            r[0] = R::MAGIC_VALUE;
            r[R::ASSET..R::ASSET + 32].copy_from_slice(&ASSET);
            r[R::GENERATION..R::GENERATION + 4].copy_from_slice(&generation.to_le_bytes());
            c.set_account(record, acct(RESIDENT_PROGRAM, r)).unwrap();
        }
        W {
            c,
            game,
            tracked: vec![pool, policy_key, asset, record],
        }
    }
    fn good() -> W {
        world(
            POOL_STATE_OPEN,
            GAME,
            CORE.parse::<Address>().unwrap().to_bytes(),
            true,
            2,
            true,
        )
    }
    fn req(w: &W, paid_by: [u8; 32], generation: u32) -> FixtureRequest {
        FixtureRequest {
            asset: Address::new_from_array(ASSET),
            paid_by: Address::new_from_array(paid_by),
            pay_generation: generation,
            run_id: w.c.run_id(),
            instance: w.c.status_instance(),
        }
    }
    fn entry_of(w: &W) -> Address {
        let pool = pool_address(&w.game, SEASON);
        Address::find_program_address(
            &[b"entry-nft", pool.as_ref(), &ASSET],
            &Address::new_from_array(PRIZE_TEST_ONLY_PROGRAM),
        )
        .0
    }
    fn snapshot(w: &W) -> Vec<Option<(u64, Vec<u8>, Address)>> {
        let mut keys = w.tracked.clone();
        keys.push(entry_of(w));
        keys.iter()
            .map(|k| w.c.account(k).map(|a| (a.lamports, a.data, a.owner)))
            .collect()
    }
    /// A refusal names its check and leaves every tracked account (and the Entry address) exactly as it was.
    fn refused(mut w: W, r: FixtureRequest, want: Refusal) {
        let before = snapshot(&w);
        let game = w.game;
        assert_eq!(place(&mut w.c, &game, SEASON, &r), Err(want));
        assert_eq!(snapshot(&w), before, "{want:?}: nothing changed");
    }

    #[test]
    fn the_one_entry_is_written_exactly_and_nothing_else_changes() {
        let mut w = good();
        let r = req(&w, OWNER_A, 2);
        let before: Vec<_> = w
            .tracked
            .iter()
            .map(|k| w.c.account(k).map(|a| (a.lamports, a.data, a.owner)))
            .collect();
        let game = w.game;
        let p = place(&mut w.c, &game, SEASON, &r).unwrap();
        assert_eq!(p.entry, entry_of(&w));
        assert_eq!(p.amount, FEE);
        let e = w.c.account(&p.entry).unwrap();
        assert_eq!(
            (e.owner, e.lamports, e.data.len()),
            (
                Address::new_from_array(PRIZE_TEST_ONLY_PROGRAM),
                ENTRY_LAMPORTS,
                ENTRY_SIZE
            )
        );
        assert_eq!(&e.data[..8], ENTRY_MAGIC);
        assert_eq!(e.data[9], 0, "unclaimed");
        assert_eq!(
            e.data[E_PAY_GENERATION..E_PAY_GENERATION + 4],
            2u32.to_le_bytes()
        );
        assert_eq!(
            e.data[E_POOL..E_POOL + 32],
            pool_address(&game, SEASON).to_bytes()
        );
        assert_eq!(e.data[E_ASSET..E_ASSET + 32], ASSET);
        assert_eq!(e.data[E_AMOUNT..E_AMOUNT + 8], FEE.to_le_bytes());
        assert_eq!(e.data[E_PAID_BY..E_PAID_BY + 32], OWNER_A);
        assert!(
            e.data[136..].iter().all(|b| *b == 0),
            "no claimer, no claim generation, reserved zero"
        );
        let after: Vec<_> = w
            .tracked
            .iter()
            .map(|k| w.c.account(k).map(|a| (a.lamports, a.data, a.owner)))
            .collect();
        assert_eq!(after, before, "pool, policy, asset and record unchanged");
        // The same request again: the Entry now exists.
        assert_eq!(
            place(&mut w.c, &game, SEASON, &r),
            Err(Refusal::EntryExists)
        );
    }

    #[test]
    fn every_check_refuses_and_changes_nothing() {
        let core = CORE.parse::<Address>().unwrap().to_bytes();
        let w = good();
        let mut r = req(&w, OWNER_A, 2);
        r.run_id[0] ^= 1;
        refused(w, r, Refusal::Run);
        let w = good();
        let mut r = req(&w, OWNER_A, 2);
        r.instance[0] ^= 1;
        refused(w, r, Refusal::Run);
        let w = world(1, GAME, core, true, 2, true);
        let r = req(&w, OWNER_A, 2);
        refused(w, r, Refusal::Pool);
        let w = world(POOL_STATE_OPEN, [0x45; 32], core, true, 2, true);
        let r = req(&w, OWNER_A, 2);
        refused(w, r, Refusal::Pool);
        let w = world(POOL_STATE_OPEN, GAME, [0x99; 32], true, 2, true);
        let r = req(&w, OWNER_A, 2);
        refused(w, r, Refusal::Asset);
        let w = world(POOL_STATE_OPEN, GAME, core, false, 2, true);
        let r = req(&w, OWNER_A, 2);
        refused(w, r, Refusal::Guard);
        let w = world(POOL_STATE_OPEN, GAME, core, true, 2, false);
        let r = req(&w, OWNER_A, 2);
        refused(w, r, Refusal::Record);
        let w = good();
        let r = req(&w, OWNER_A, 1);
        refused(w, r, Refusal::Generation);
        let w = good();
        let r = req(&w, OWNER_B, 2);
        refused(w, r, Refusal::PaidBy);
        // An Entry already at the address: refused, its bytes untouched.
        let mut w = good();
        let e = entry_of(&w);
        w.c.set_account(e, acct(PRIZE_TEST_ONLY_PROGRAM, vec![7u8; ENTRY_SIZE]))
            .unwrap();
        let r = req(&w, OWNER_A, 2);
        refused(w, r, Refusal::EntryExists);
    }
}
