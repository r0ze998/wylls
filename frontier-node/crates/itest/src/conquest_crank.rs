//! **Local keeper conquest crank (stage G)**, feature `localnet-conquest-play`
//! only: the permissionless steps of an initial-Free-City siege that the
//! watched player declared, through the isolated conquest lane's versioned
//! dispatch kinds (13–17; `docs/integration/CLAUDE-CONQUEST-DISPATCH-KINDS-20261111.md`):
//!
//! - **ResolveWithConquest** (13) instead of plain Resolve for every bell of a
//!   destination whose conquest table exists ([`resolve_with_conquest_ix`],
//!   chosen by `resident_bells`);
//! - **SettleCapture** (14) for an entry in CaptureDue (the siege won);
//! - **SettleSiege** (15) for a failed entry (kind None: lost) or an active
//!   siege the program's own model says has lapsed at the season's end;
//! - **CloseConquest** (16) and **CloseCaptureEscrow** (17) once the Season is
//!   Ended and its 72 h grace passed, with no entry left.
//!
//! DeclareSiege (12) is the player's own signed decision and is never sent here.
//! Every step is decided from program-owned state read with identity checks and
//! the program's own pure model (`WideConquest::settle`); anything the state
//! cannot prove (records without a table, an unknown kind, a model refusal
//! other than "too early", a capture whose Holding already exists) is
//! `Blocked`, never sent. Sending keeps the drivers' rules: simulated first, a
//! refusal or unknown outcome stops for good, never resent. No new rule.
use fclient::addr::Addresses;
use fclient::{AccountMeta, Address, Instruction};
use frontier_abi::addr::{day_of, AddrCtx};
use frontier_abi::conquest_model::Record;
use frontier_abi::v2::layout::province::conquest as CR;
use frontier_abi::world_index::{
    arrival::{arrival_day_address, clash_inputs_address},
    conquest::{capture_escrow_address, conquest_address, ConquestError, Reservation, WideCaptureEscrow, WideConquest, WideConquestEntry, RES_NOT_APPLIED},
    expedition::AccountResolver,
    expedition_dispatch_ix::{self as dx, Kind},
    holding::holding_address,
    roster::roster_address,
    wide_ix as wix, ProvinceKey, WorldId,
};
use localnet::Chain;

/// The province record table size (`province::SITES_N`).
pub const SITES: u8 = 12;

fn ctx_of(a: &Addresses) -> AddrCtx {
    AddrCtx { program: a.program.to_bytes(), season: a.season.to_bytes() }
}
fn addr(k: [u8; 32]) -> Address {
    Address::new_from_array(k)
}

/// One conquest entry of the watched player's Citizen, with the model's verdict
/// on settling it now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Own {
    pub site: u8,
    pub kind: u8,
    /// The entry keeps its source host (SettleSiege takes the 8th account).
    pub has_source: bool,
    /// `WideConquest::settle` now: `Ok(true)` due, `Ok(false)` too early,
    /// `Err` any other refusal (not provable).
    pub settle: Result<bool, String>,
    /// SettleCapture's destination Holding position already exists.
    pub capture_holding_present: bool,
}

/// What the chain proves about the destination's conquest (pure input).
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Facts {
    pub table: bool,
    /// Live entries of any Citizen.
    pub entries: usize,
    pub own: Vec<Own>,
    /// Some site record is neither paired with a live table entry nor the
    /// program's own known no-entry residue (`WideConquest::validate_paired`:
    /// kind None, a barred/none/faction marker, any bell, all else zero, which
    /// SettleCapture/SettleSiege leave and CloseConquest never clears).
    pub unknown_records: bool,
    /// The watched Citizen's capture escrow exists (and its retained escrow).
    pub escrow: Option<u64>,
    /// Ended and past `END_GRACE_SECS`: the terminal closes may run.
    pub closes_open: bool,
    /// Siege reservation records of any Citizen (the table cannot close).
    pub reservations: usize,
    /// The watched Citizen's NOT_APPLIED reservations still owing a part of
    /// their full return (seq order). PENDING ones are applied by
    /// ResolveWithConquest and need nothing here.
    pub own_owed: Vec<u32>,
}

/// The crank's next step (pure).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Crank {
    Nothing,
    Blocked(String),
    SettleCapture { site: u8 },
    SettleSiege { site: u8, with_source: bool },
    CloseConquest,
    CloseCaptureEscrow { with_funder: bool },
    /// The full return of a NOT_APPLIED reservation (kind 18). A refusal
    /// (for example no room in the source Holding's store) stops like every
    /// other step; the debt stays recorded on chain.
    SettleReservation { seq: u32 },
}

pub fn crank(f: &Facts) -> Crank {
    if f.unknown_records {
        return Crank::Blocked("a site record is neither a live entry's nor a settled residue: not provable, nothing sent".into());
    }
    for o in &f.own {
        let due = match &o.settle {
            Ok(d) => *d,
            Err(e) => return Crank::Blocked(format!("site {}: the conquest model refuses settlement ({e}): nothing sent", o.site)),
        };
        match o.kind {
            CR::KIND_CAPTURE_DUE if o.capture_holding_present => {
                return Crank::Blocked(format!("site {}: capture due but its Holding position exists: nothing sent", o.site));
            }
            CR::KIND_CAPTURE_DUE if due => return Crank::SettleCapture { site: o.site },
            CR::KIND_NONE if due => return Crank::SettleSiege { site: o.site, with_source: o.has_source },
            CR::KIND_SIEGE if due => return Crank::SettleSiege { site: o.site, with_source: o.has_source },
            CR::KIND_SIEGE => {}
            k @ (CR::KIND_CAPTURE_DUE | CR::KIND_NONE) => {
                return Crank::Blocked(format!("site {}: kind {k} not settleable now by the model: nothing sent", o.site));
            }
            k => return Crank::Blocked(format!("site {}: conquest kind {k} is not driven here", o.site)),
        }
    }
    if let Some(seq) = f.own_owed.first() {
        return Crank::SettleReservation { seq: *seq };
    }
    if f.closes_open && f.own.is_empty() {
        // CloseConquest refuses while any reservation record remains.
        if f.table && f.entries == 0 && f.reservations == 0 {
            return Crank::CloseConquest;
        }
        if !f.table {
            if let Some(escrow) = f.escrow {
                return Crank::CloseCaptureEscrow { with_funder: escrow != 0 };
            }
        }
    }
    Crank::Nothing
}

/// Whether every site record is accounted for (pure): paired with the live
/// table's entry, or, with no table or no entry at that site, exactly the
/// residue the program's own pairing rule accepts for an empty site. The rule
/// is the program's (`WideConquest::validate_paired` over the live table, or
/// over an empty table of the same key), never a copy.
pub fn records_known(table: Option<&WideConquest>, empty: &WideConquest, records: &[Record]) -> bool {
    records.iter().enumerate().all(|(s, r)| match table {
        Some(t) => t.validate_paired(s as u8, *r).is_ok(),
        None => empty.validate_paired(s as u8, *r).is_ok(),
    })
}

/// The watched player's identity for the crank: its Citizen (the Holding's
/// owner), that Citizen's faction and join shard.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Player {
    pub citizen: Address,
    pub faction: u8,
    pub shard: u8,
}

/// A v2 account of `kind` for this Season, exactly as `write_header` writes
/// it: the kind's size and magic, the Season id, and for a chained kind
/// layout version 2. Anything else is refused (never read as that kind).
pub fn v2_header(d: &[u8], kind: frontier_abi::v2::layout::AccountKind, season_id: u64) -> Result<(), String> {
    use frontier_abi::v2::layout::LAYOUT_VERSION_V2;
    if d.len() != kind.size() || d.get(..8) != Some(&kind.magic()[..]) {
        return Err(format!("not a {} account", kind.name()));
    }
    if u64::from_le_bytes(d[8..16].try_into().unwrap()) != season_id {
        return Err(format!("the {} is of another Season", kind.name()));
    }
    if kind.chained() && frontier_abi::v2::layout::layout_version(d) != Some(LAYOUT_VERSION_V2) {
        return Err(format!("the {} is not layout version 2", kind.name()));
    }
    Ok(())
}

/// The watched player from its Holding: program-owned v2 Holding of this
/// Season at the canonical address of its own (P, Q, site), whose owner is a
/// program-owned v2 Citizen of this Season at the canonical address of its
/// own wallet. Nothing is taken from bytes that fail any of these.
pub fn player(c: &Chain, a: &Addresses, holding: &Address) -> Result<Player, String> {
    use frontier_abi::v2::layout::{player::{citizen as C, holding as H}, AccountKind as K2};
    let ctx = ctx_of(a);
    let h = c.account(holding).ok_or("the watched Holding is absent")?;
    if h.owner != a.program || h.executable {
        return Err("the watched Holding is not the program's".into());
    }
    v2_header(&h.data, K2::Holding, a.season_id)?;
    let d = &h.data;
    let (p, q, site) = (i16::from_le_bytes([d[H::P], d[H::P + 1]]), i16::from_le_bytes([d[H::Q], d[H::Q + 1]]), d[H::SITE]);
    if ctx.holding(p as i32, q as i32, site) != holding.to_bytes() {
        return Err("the watched Holding is not at its canonical address".into());
    }
    let citizen = addr(d[H::OWNER_CITIZEN..H::OWNER_CITIZEN + 32].try_into().unwrap());
    let cd = c.account(&citizen).ok_or("the owner Citizen is absent")?;
    if cd.owner != a.program || cd.executable {
        return Err("the owner Citizen is not the program's".into());
    }
    v2_header(&cd.data, K2::Citizen, a.season_id)?;
    let wallet: [u8; 32] = cd.data[C::WALLET..C::WALLET + 32].try_into().unwrap();
    if ctx.citizen(&wallet) != citizen.to_bytes() {
        return Err("the owner Citizen is not at its wallet's canonical address".into());
    }
    Ok(Player { citizen, faction: cd.data[C::FACTION], shard: cd.data[C::JOIN_SHARD] })
}

/// The table, escrow and our entries, read with identity checks. `pd` is the
/// destination Province's bytes (already authenticated by the caller).
#[allow(clippy::too_many_arguments)]
pub fn facts(c: &Chain, a: &Addresses, dest: ProvinceKey, pd: &[u8], p: &Player, resolved_next: u32, ended: bool, end_bell: u32, closes_open: bool)
    -> Result<(Facts, Option<WideConquest>, Option<WideCaptureEscrow>), String> {
    let ctx = ctx_of(a);
    let n = pd.get(frontier_abi::v2::layout::province::province::SITE_COUNT).copied().ok_or("province bytes")?.min(SITES);
    let records = (0..n).map(|s| Record::read(pd, s as usize).map_err(|e| format!("site record {s}: {e:?}"))).collect::<Result<Vec<_>, _>>()?;
    let table = match c.account(&addr(conquest_address(&ctx, dest))) {
        None => None,
        Some(x) if x.owner == a.program => Some(WideConquest::read(&x.data, a.season_id, dest).map_err(|e| format!("conquest table: {e:?}"))?),
        Some(_) => return Err("the conquest table is not the program's".into()),
    };
    let world = WorldId::derive_legacy_season(&ctx.season, &ctx.program).map_err(|e| format!("world: {e:?}"))?;
    let escrow = match c.account(&addr(capture_escrow_address(&ctx, &p.citizen.to_bytes()))) {
        None => None,
        Some(x) if x.owner == a.program => Some(WideCaptureEscrow::read(&x.data, a.season_id, world, p.citizen.to_bytes()).map_err(|e| format!("capture escrow: {e:?}"))?),
        Some(_) => return Err("the capture escrow is not the program's".into()),
    };
    let empty = WideConquest::new(a.season_id, dest, [0; 32]).map_err(|e| format!("{e:?}"))?;
    let unknown_records = !records_known(table.as_ref(), &empty, &records);
    let mut f = Facts { table: table.is_some(), unknown_records, escrow: escrow.as_ref().map(|e| e.escrow()), closes_open, ..Facts::default() };
    if let Some(t) = &table {
        for s in 0..SITES {
            let Some(e) = t.entry(s).map_err(|e| format!("conquest entry {s}: {e:?}"))? else { continue };
            f.entries += 1;
            if e.citizen != p.citizen.to_bytes() {
                continue;
            }
            let prefix = Record::read(pd, s as usize).map_err(|e| format!("site record {s}: {e:?}"))?;
            let settle = match t.settle(s, prefix, e, resolved_next, ended, end_bell, 0) {
                Ok(_) => Ok(true),
                Err(ConquestError::TooEarly) => Ok(false),
                Err(x) => Err(format!("{x:?}")),
            };
            let present = c.account(&addr(holding_address(&ctx, dest.coord(), s))).is_some();
            f.own.push(Own { site: s, kind: e.rules.kind, has_source: e.source.is_some(), settle, capture_holding_present: present });
        }
        let mut owed: Vec<u32> = Vec::new();
        for r in t.reservations().iter().flatten() {
            f.reservations += 1;
            if r.citizen == p.citizen.to_bytes() && r.status == RES_NOT_APPLIED {
                owed.push(r.seq);
            }
        }
        owed.sort_unstable();
        f.own_owed = owed;
    }
    Ok((f, table, escrow))
}

fn wrap(inner: &[u8]) -> Result<Vec<u8>, String> {
    let kind = Kind::of_conquest(inner).ok_or("not a conquest command")?;
    dx::encode(kind, inner).map_err(|e| format!("{e:?}"))
}

/// ResolveWithConquest (kind 13): `wide_ix::RESOLVE_WITH_CONQUEST`, the
/// Resolve accounts plus the destination's conquest table.
pub fn resolve_with_conquest_ix(a: &Addresses, payer: &Address, dest: ProvinceKey, dest_key: &Address, region: u8, bell: u32) -> Result<Instruction, String> {
    let ctx = ctx_of(a);
    let data = wrap(&wix::ResolveWithConquest { bell, beneficiary: payer.to_bytes() }.to_bytes())?;
    Ok(Instruction { program_id: a.program, data, accounts: vec![
        AccountMeta::new(*payer, true),
        AccountMeta::new_readonly(a.season, false),
        AccountMeta::new(*dest_key, false),
        AccountMeta::new(addr(roster_address(&ctx, dest)), false),
        AccountMeta::new_readonly(a.seed_cache(bell, region, 0), false),
        AccountMeta::new_readonly(a.anchor(bell, region), false),
        AccountMeta::new(addr(clash_inputs_address(&ctx, dest, bell)), false),
        AccountMeta::new_readonly(addr(arrival_day_address(&ctx, dest, day_of(bell))), false),
        AccountMeta::new_readonly(fclient::addr::system_program(), false),
        AccountMeta::new(addr(conquest_address(&ctx, dest)), false),
    ] })
}

fn source_holding(a: &Addresses, e: &WideConquestEntry) -> Result<Address, String> {
    let src = e.source.ok_or("the entry has no source host")?;
    let r = AccountResolver::for_season(&ctx_of(a)).map_err(|e| format!("{e:?}"))?;
    Ok(addr(r.holding_address(&src).map_err(|e| format!("source holding: {e:?}"))?))
}

/// SettleSiege (kind 15): `wide_ix::SETTLE_SIEGE`, the source holding
/// position appended exactly when the entry keeps its source.
pub fn settle_siege_ix(a: &Addresses, payer: &Address, dest: ProvinceKey, dest_key: &Address, p: &Player, site: u8, e: &WideConquestEntry, escrow: &WideCaptureEscrow) -> Result<Instruction, String> {
    let ctx = ctx_of(a);
    let mut m = vec![
        AccountMeta::new_readonly(*payer, true),
        AccountMeta::new_readonly(a.season, false),
        AccountMeta::new(*dest_key, false),
        AccountMeta::new(addr(conquest_address(&ctx, dest)), false),
        AccountMeta::new(p.citizen, false),
        AccountMeta::new(addr(capture_escrow_address(&ctx, &p.citizen.to_bytes())), false),
        AccountMeta::new(addr(escrow.funder()), false),
    ];
    if e.source.is_some() {
        m.push(AccountMeta::new(source_holding(a, e)?, false));
    }
    Ok(Instruction { program_id: a.program, data: wrap(&wix::SettleSiege { site }.to_bytes())?, accounts: m })
}

/// SettleCapture (kind 14): `wide_ix::SETTLE_CAPTURE`.
pub fn settle_capture_ix(a: &Addresses, payer: &Address, dest: ProvinceKey, dest_key: &Address, p: &Player, site: u8, e: &WideConquestEntry) -> Result<Instruction, String> {
    let ctx = ctx_of(a);
    Ok(Instruction { program_id: a.program, data: wrap(&wix::SettleCapture { site }.to_bytes())?, accounts: vec![
        AccountMeta::new(*payer, true),
        AccountMeta::new_readonly(a.season, false),
        AccountMeta::new(*dest_key, false),
        AccountMeta::new(addr(conquest_address(&ctx, dest)), false),
        AccountMeta::new(p.citizen, false),
        AccountMeta::new(addr(ctx.join_shard(p.faction, p.shard)), false),
        AccountMeta::new(addr(capture_escrow_address(&ctx, &p.citizen.to_bytes())), false),
        AccountMeta::new(addr(holding_address(&ctx, dest.coord(), site)), false),
        AccountMeta::new(source_holding(a, e)?, false),
        AccountMeta::new_readonly(fclient::addr::system_program(), false),
    ] })
}

/// CloseConquest (kind 16): `wide_ix::CLOSE_CONQUEST`.
pub fn close_conquest_ix(a: &Addresses, payer: &Address, dest: ProvinceKey, table: &WideConquest) -> Result<Instruction, String> {
    let ctx = ctx_of(a);
    let (p, q) = (dest.coord().p(), dest.coord().q());
    Ok(Instruction { program_id: a.program, data: wrap(&wix::CloseConquest { p, q }.to_bytes())?, accounts: vec![
        AccountMeta::new_readonly(*payer, true),
        AccountMeta::new_readonly(a.season, false),
        AccountMeta::new(addr(conquest_address(&ctx, dest)), false),
        AccountMeta::new(addr(table.rent_payer()), false),
    ] })
}

/// SettleReservation (kind 18): `wide_ix::SETTLE_RESERVATION`. The escrow
/// funder is the live escrow's; with the escrow closed (terminal), the payer
/// stands in and receives nothing (the program moves no lamports then).
pub fn settle_reservation_ix(a: &Addresses, payer: &Address, dest: ProvinceKey, dest_key: &Address, r: &Reservation, escrow: Option<&WideCaptureEscrow>) -> Result<Instruction, String> {
    let ctx = ctx_of(a);
    let resolver = AccountResolver::for_season(&ctx).map_err(|e| format!("{e:?}"))?;
    let source = addr(resolver.holding_address(&r.source()).map_err(|e| format!("source holding: {e:?}"))?);
    let funder = escrow.map_or(*payer, |e| addr(e.funder()));
    let data = dx::encode(Kind::SettleReservation, &wix::SettleReservation { seq: r.seq }.to_bytes()).map_err(|e| format!("{e:?}"))?;
    Ok(Instruction { program_id: a.program, data, accounts: vec![
        AccountMeta::new_readonly(*payer, true),
        AccountMeta::new_readonly(a.season, false),
        AccountMeta::new(*dest_key, false),
        AccountMeta::new(addr(conquest_address(&ctx, dest)), false),
        AccountMeta::new(addr(r.citizen), false),
        AccountMeta::new(addr(capture_escrow_address(&ctx, &r.citizen)), false),
        AccountMeta::new(funder, false),
        AccountMeta::new(source, false),
    ] })
}

/// CloseCaptureEscrow (kind 17): `wide_ix::CLOSE_CAPTURE_ESCROW`, the current
/// funder appended exactly when retained escrow is nonzero.
pub fn close_capture_escrow_ix(a: &Addresses, payer: &Address, p: &Player, escrow: &WideCaptureEscrow) -> Result<Instruction, String> {
    let ctx = ctx_of(a);
    let mut m = vec![
        AccountMeta::new_readonly(*payer, true),
        AccountMeta::new_readonly(a.season, false),
        AccountMeta::new(p.citizen, false),
        AccountMeta::new(addr(capture_escrow_address(&ctx, &p.citizen.to_bytes())), false),
        AccountMeta::new(addr(escrow.rent_payer()), false),
    ];
    if escrow.escrow() != 0 {
        m.push(AccountMeta::new(addr(escrow.funder()), false));
    }
    Ok(Instruction { program_id: a.program, data: wrap(&wix::CloseCaptureEscrow.to_bytes())?, accounts: m })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::expedition_play::{PROGRAM, SEASON_ID};
    use frontier_abi::world_index::WideCoord;

    fn own(site: u8, kind: u8, settle: Result<bool, String>) -> Own {
        Own { site, kind, has_source: true, settle, capture_holding_present: false }
    }

    /// PURE: which ONE crank step is due from proven facts. Not evidence the
    /// program accepts it.
    #[test]
    fn the_crank_settles_only_what_the_state_proves() {
        let base = Facts { table: true, entries: 1, ..Facts::default() };
        // an active siege before the season's end: nothing (the bells resolve with conquest)
        assert_eq!(crank(&Facts { own: vec![own(1, CR::KIND_SIEGE, Ok(false))], ..base.clone() }), Crank::Nothing);
        // won: capture; lost (kind None): settle siege; lapsed at the end: settle siege
        assert_eq!(crank(&Facts { own: vec![own(1, CR::KIND_CAPTURE_DUE, Ok(true))], ..base.clone() }), Crank::SettleCapture { site: 1 });
        assert_eq!(crank(&Facts { own: vec![own(2, CR::KIND_NONE, Ok(true))], ..base.clone() }), Crank::SettleSiege { site: 2, with_source: true });
        assert_eq!(crank(&Facts { own: vec![Own { has_source: false, ..own(3, CR::KIND_SIEGE, Ok(true)) }], ..base.clone() }),
            Crank::SettleSiege { site: 3, with_source: false });
        // fail-closed: records without a table, a model refusal, an unknown kind, an existing capture Holding
        assert!(matches!(crank(&Facts { unknown_records: true, table: false, ..Facts::default() }), Crank::Blocked(_)));
        assert!(matches!(crank(&Facts { unknown_records: true, closes_open: true, escrow: Some(0), ..Facts::default() }), Crank::Blocked(_)), "no close past an unknown record");
        assert!(matches!(crank(&Facts { own: vec![own(1, CR::KIND_SIEGE, Err("Stale".into()))], ..base.clone() }), Crank::Blocked(_)));
        assert!(matches!(crank(&Facts { own: vec![own(1, CR::KIND_OCCUPATION, Ok(true))], ..base.clone() }), Crank::Blocked(_)));
        assert!(matches!(crank(&Facts { own: vec![Own { capture_holding_present: true, ..own(1, CR::KIND_CAPTURE_DUE, Ok(true)) }], ..base.clone() }),
            Crank::Blocked(_)));
        assert!(matches!(crank(&Facts { own: vec![own(1, CR::KIND_CAPTURE_DUE, Ok(false))], ..base.clone() }), Crank::Blocked(_)));
        // closes: only open, with no entry of ours; the table first, then the escrow
        let ended = Facts { closes_open: true, table: true, entries: 0, escrow: Some(0), ..Facts::default() };
        assert_eq!(crank(&ended), Crank::CloseConquest);
        assert_eq!(crank(&Facts { table: false, ..ended.clone() }), Crank::CloseCaptureEscrow { with_funder: false });
        assert_eq!(crank(&Facts { table: false, escrow: Some(17), ..ended.clone() }), Crank::CloseCaptureEscrow { with_funder: true });
        assert_eq!(crank(&Facts { closes_open: false, ..ended.clone() }), Crank::Nothing, "not before the grace");
        assert_eq!(crank(&Facts { entries: 1, ..ended.clone() }), Crank::Nothing, "another Citizen's entry keeps the table");
        assert_eq!(crank(&Facts::default()), Crank::Nothing);
    }

    /// PURE: reservations. PENDING ones need nothing (ResolveWithConquest
    /// applies them); an owed NOT_APPLIED return is settled (lowest seq first)
    /// before any close; any reservation record keeps the table open.
    #[test]
    fn the_crank_settles_owed_reservation_returns_and_never_closes_over_them() {
        let pending = Facts { table: true, reservations: 1, ..Facts::default() };
        assert_eq!(crank(&pending), Crank::Nothing);
        assert_eq!(crank(&Facts { closes_open: true, ..pending.clone() }), Crank::Nothing, "no CloseConquest over a reservation");
        let owed = Facts { own_owed: vec![3, 7], reservations: 2, ..pending.clone() };
        assert_eq!(crank(&owed), Crank::SettleReservation { seq: 3 });
        assert_eq!(crank(&Facts { closes_open: true, ..owed.clone() }), Crank::SettleReservation { seq: 3 });
        // another Citizen's owed return keeps the table open but sends nothing of ours
        assert_eq!(crank(&Facts { closes_open: true, entries: 0, escrow: Some(0), ..pending.clone() }), Crank::Nothing);
        // unknown records still block before anything
        assert!(matches!(crank(&Facts { unknown_records: true, ..owed }), Crank::Blocked(_)));
    }

    /// PURE: the SettleReservation instruction: kind 18 wrapper, the eight
    /// `wide_ix::SETTLE_RESERVATION` positions, the record's own Citizen and
    /// source Holding; the payer stands in as funder only with no escrow.
    #[test]
    fn settle_reservation_instruction_matches_the_program_table() {
        use frontier_abi::world_index::conquest::{Reservation, RES_NOT_APPLIED};
        use frontier_abi::world_index::WideHostRef;
        let a = a();
        let ctx = ctx_of(&a);
        let world = WorldId::derive_legacy_season(&ctx.season, &ctx.program).unwrap();
        let d = ProvinceKey::new(world, WideCoord::checked(129, 0).unwrap());
        let home = ProvinceKey::new(world, WideCoord::checked(128, 0).unwrap());
        let citizen = [5u8; 32];
        let r = Reservation {
            status: RES_NOT_APPLIED, site: 1, entry: 0, reserved_slot: 2, faction: 0, done: 0, bell: 20, seq: 4,
            citizen, host: WideHostRef::new(home, 0, 1, 3).unwrap(),
            actor_tag: frontier_abi::addr::citizen_tag(&citizen), gold_milli: 1, arms_milli: 1,
        };
        let payer = Address::new_from_array([9; 32]);
        let dk = addr(ctx.province(129, 0));
        let ix = settle_reservation_ix(&a, &payer, d, &dk, &r, None).unwrap();
        assert_eq!(&ix.data[..4], &[wix::TAG_CLOSE, wix::ENVELOPE_ESCAPE, 2, 18]);
        let c = dx::Command::decode(&ix.data).unwrap();
        assert_eq!(wix::SettleReservation::decode(c.inner()).unwrap().seq, 4);
        assert_eq!(ix.accounts.len(), 8);
        assert!(ix.accounts[0].is_signer && !ix.accounts[0].is_writable);
        assert_eq!(ix.accounts[1].pubkey, a.season);
        assert_eq!(ix.accounts[2].pubkey, dk);
        assert_eq!(ix.accounts[3].pubkey.to_bytes(), conquest_address(&ctx, d));
        assert_eq!(ix.accounts[4].pubkey.to_bytes(), citizen);
        assert_eq!(ix.accounts[5].pubkey.to_bytes(), capture_escrow_address(&ctx, &citizen));
        assert_eq!(ix.accounts[6].pubkey, payer, "no escrow: the payer stands in");
        let src = AccountResolver::for_season(&ctx).unwrap().holding_address(&r.source()).unwrap();
        assert_eq!(ix.accounts[7].pubkey.to_bytes(), src);
        assert!(ix.accounts[2..].iter().all(|m| m.is_writable && !m.is_signer));
    }

    fn a() -> Addresses {
        Addresses::new(Address::new_from_array(PROGRAM), SEASON_ID)
    }
    fn dest() -> ProvinceKey {
        let c = ctx_of(&a());
        ProvinceKey::new(WorldId::derive_legacy_season(&c.season, &c.program).unwrap(), WideCoord::checked(129, 0).unwrap())
    }
    /// Each builder's keys at the abi table's role positions, its signer and
    /// W flags, its exact inner bytes under the right conquest kind.
    fn check(ix: &Instruction, g: &[frontier_abi::prologue::Group], kind: Kind, roles: &[(&str, Address)]) {
        use frontier_abi::prologue::{position_in, Wr};
        let n = ix.accounts.len();
        for (name, key) in roles {
            let i = position_in(g, n, name, 0).unwrap_or_else(|| panic!("{name}"));
            assert_eq!(ix.accounts[i].pubkey, *key, "{name}");
        }
        let mut counts = [0u8; 4];
        let groups = frontier_abi::prologue::counts_in(g, n, &mut counts).expect("a count of the table");
        let mut specs: Vec<&frontier_abi::prologue::Spec> = vec![];
        for (gr, &c) in g.iter().zip(&counts[..groups]) {
            for _ in 0..c {
                specs.extend(gr.specs.iter());
            }
        }
        for (m, s) in ix.accounts.iter().zip(&specs) {
            assert_eq!(m.is_signer, s.signer, "{} signer", s.name);
            if s.wr == Wr::W {
                assert!(m.is_writable, "{} writable", s.name);
            }
        }
        let c = dx::Command::decode(&ix.data).unwrap();
        assert_eq!(c.kind(), kind);
    }

    /// The real model's terminal order on the same key: declare a siege (the
    /// program's `declare`), let it lapse at the season's end (`settle`), then
    /// CloseConquest, then CloseCaptureEscrow while the settled residue stays
    /// in the Province (CloseConquest never clears it). Unknown records block.
    #[test]
    fn settle_then_close_table_then_close_escrow_over_the_real_residue() {
        use frontier_abi::conquest_model::{SiteRecordRules, SiteTransitionMirror};
        use frontier_abi::v2::layout::province::site as SM;
        let (a, d) = (a(), dest());
        let ctx = ctx_of(&a);
        let citizen = [0x61u8; 32];
        let r = AccountResolver::for_season(&ctx).unwrap();
        let src = r.legacy_host_ref(frontier_abi::addr::host_id(128, 0, 1, 2, 0).unwrap()).unwrap();
        // an initial-Free-City siege as the model admits it (held, neutral target, slot 2, progress 0 of 3)
        let rules = SiteRecordRules { kind: CR::KIND_SIEGE, faction: 0, flags: CR::FLAG_HELD | CR::FLAG_NEUTRAL, required: 3,
            target: CR::target(CR::TARGET_FREE_CITY, 2), bell: 20, ..SiteRecordRules::default() };
        let e = WideConquestEntry { rules, citizen, source: Some(src), actor_tag: frontier_abi::addr::citizen_tag(&citizen), reserved_slot: 2,
            original_target_gen: 0, declaration_bell: 20 };
        let empty = WideConquest::new(SEASON_ID, d, [0x81; 32]).unwrap();
        let mirror = SiteTransitionMirror { state: SM::STATE_FREE_CITY, gen: 0, order: 0, held_since_hour: 0, walls_committed: 0 };
        let declared = empty.declare(1, Record::ZERO, mirror, e).expect("the model declares the initial Free City siege");
        let (t1, live) = (declared.conquest, declared.prefix);
        let records = [Record::ZERO, live];
        assert!(records_known(Some(&t1), &empty, &records), "the live entry's prefix is paired");
        assert!(!records_known(None, &empty, &records), "the same live prefix without its table is unknown");
        // before the end the model says too early; at the end it lapses
        assert_eq!(t1.settle(1, live, e, 25, false, 1008, 0).err(), Some(ConquestError::TooEarly));
        let own = |settle| Own { site: 1, kind: CR::KIND_SIEGE, has_source: true, settle, capture_holding_present: false };
        let during = Facts { table: true, entries: 1, own: vec![own(Ok(false))], unknown_records: !records_known(Some(&t1), &empty, &records), ..Facts::default() };
        assert_eq!(crank(&during), Crank::Nothing, "an active siege: the bells resolve with conquest");
        let lapsed = t1.settle(1, live, e, 1008, true, 1008, 0).expect("lapse at the season's end");
        assert_eq!(crank(&Facts { own: vec![own(Ok(true))], ..during.clone() }), Crank::SettleSiege { site: 1, with_source: true });
        // after SettleSiege: an empty table and the settled residue in the Province
        let residue = [Record::ZERO, lapsed.prefix];
        assert_ne!(lapsed.prefix, Record::ZERO, "settle leaves a non-zero residue");
        assert!(lapsed.conquest.entry(1).unwrap().is_none());
        let after = Facts { table: true, entries: 0, unknown_records: !records_known(Some(&lapsed.conquest), &empty, &residue), escrow: Some(0),
            closes_open: true, ..Facts::default() };
        assert!(!after.unknown_records);
        assert_eq!(crank(&after), Crank::CloseConquest);
        // CloseConquest removed the table only: the residue stays, the escrow closes next
        let closed = Facts { table: false, unknown_records: !records_known(None, &empty, &residue), ..after.clone() };
        assert!(!closed.unknown_records, "the known residue without a table is not a contradiction");
        assert_eq!(crank(&closed), Crank::CloseCaptureEscrow { with_funder: false });
        assert_eq!(crank(&Facts { escrow: None, ..closed.clone() }), Crank::Nothing, "everything closed");
        // a capture's residue (barred-all immunity with its bell) is known too
        let capture = Record { faction: CR::BARRED_ALL, bell: 1_100, ..Record::ZERO };
        assert!(records_known(None, &empty, &[Record::ZERO, capture]));
        // negatives without a table: a live prefix, a residue with an actor, a kind other than None
        for bad in [live, Record { actor: 7, ..lapsed.prefix }, Record { kind: CR::KIND_CAPTURE_DUE, ..lapsed.prefix }, Record { flags: 1, ..lapsed.prefix }] {
            let f = Facts { table: false, unknown_records: !records_known(None, &empty, &[Record::ZERO, bad]), escrow: Some(0), closes_open: true, ..Facts::default() };
            assert!(f.unknown_records && matches!(crank(&f), Crank::Blocked(_)), "{bad:?}");
        }
        // and not before the grace
        assert_eq!(crank(&Facts { closes_open: false, ..closed }), Crank::Nothing);
    }

    /// The player reader refuses every unproven identity (synthetic bytes
    /// written with the abi's own header writer, on a test chain).
    #[test]
    fn the_player_is_read_only_from_canonical_v2_accounts_of_this_season() {
        use frontier_abi::v2::layout::{player::{citizen as C, holding as H}, write_header, AccountKind as K2};
        let a = a();
        let ctx = ctx_of(&a);
        let wallet = [0x33u8; 32];
        let cit = addr(ctx.citizen(&wallet));
        let hk = addr(ctx.holding(128, 0, 1));
        let holding = |owner_citizen: Address, sid: u64| {
            let mut h = vec![0u8; K2::Holding.size()];
            assert!(write_header(&mut h, K2::Holding, sid));
            h[H::P..H::P + 2].copy_from_slice(&128i16.to_le_bytes());
            h[H::SITE] = 1;
            h[H::OWNER_CITIZEN..H::OWNER_CITIZEN + 32].copy_from_slice(owner_citizen.as_ref());
            h
        };
        let citizen = |w: [u8; 32], sid: u64, kind: K2| {
            let mut d = vec![0u8; kind.size()];
            assert!(write_header(&mut d, kind, sid));
            if kind == K2::Citizen {
                d[C::WALLET..C::WALLET + 32].copy_from_slice(&w);
                d[C::FACTION] = 2;
                d[C::JOIN_SHARD] = 5;
            }
            d
        };
        let put = |c: &mut Chain, k: Address, data: Vec<u8>, owner: Address| {
            c.set_account(k, fclient::ports::Account { lamports: 1_000_000, data, owner, executable: false }).unwrap();
        };
        let fresh = || {
            let mut c = Chain::new(localnet::Config::default());
            c.produce_block();
            put(&mut c, hk, holding(cit, SEASON_ID), a.program);
            put(&mut c, cit, citizen(wallet, SEASON_ID, K2::Citizen), a.program);
            c
        };
        assert_eq!(player(&fresh(), &a, &hk), Ok(Player { citizen: cit, faction: 2, shard: 5 }));
        // the Holding: another Season, another kind, foreign owner, not canonical
        let mut c = fresh();
        put(&mut c, hk, holding(cit, SEASON_ID + 1), a.program);
        assert!(player(&c, &a, &hk).unwrap_err().contains("another Season"));
        let mut c = fresh();
        put(&mut c, hk, citizen(wallet, SEASON_ID, K2::Citizen), a.program);
        assert!(player(&c, &a, &hk).is_err(), "a Citizen at the Holding address");
        let mut c = fresh();
        put(&mut c, hk, holding(cit, SEASON_ID), Address::new_from_array([9; 32]));
        assert!(player(&c, &a, &hk).is_err(), "foreign owner");
        let mut c = fresh();
        let elsewhere = addr(ctx.holding(128, 0, 2));
        put(&mut c, elsewhere, holding(cit, SEASON_ID), a.program);
        assert!(player(&c, &a, &elsewhere).unwrap_err().contains("canonical"), "site 1 bytes at site 2's address");
        // the Citizen: another Season, a Holding's bytes, a short account, not its wallet's address
        let mut c = fresh();
        put(&mut c, cit, citizen(wallet, SEASON_ID + 1, K2::Citizen), a.program);
        assert!(player(&c, &a, &hk).unwrap_err().contains("another Season"));
        let mut c = fresh();
        put(&mut c, cit, holding(cit, SEASON_ID), a.program);
        assert!(player(&c, &a, &hk).is_err(), "a Holding at the Citizen address");
        let mut c = fresh();
        put(&mut c, cit, citizen(wallet, SEASON_ID, K2::Citizen)[..100].to_vec(), a.program);
        assert!(player(&c, &a, &hk).is_err(), "short");
        let mut c = fresh();
        put(&mut c, cit, citizen([0x44; 32], SEASON_ID, K2::Citizen), a.program);
        assert!(player(&c, &a, &hk).unwrap_err().contains("canonical"), "another wallet's Citizen at this address");
        let mut c = fresh();
        put(&mut c, cit, citizen(wallet, SEASON_ID, K2::Citizen), Address::new_from_array([9; 32]));
        assert!(player(&c, &a, &hk).is_err(), "foreign Citizen owner");
    }

    #[test]
    fn every_crank_instruction_has_its_abi_tables_shape() {
        let (a, d) = (a(), dest());
        let ctx = ctx_of(&a);
        let dk = Address::new_from_array([0x29; 32]);
        let payer = Address::new_from_array([0x51; 32]);
        let p = Player { citizen: Address::new_from_array([0x61; 32]), faction: 0, shard: 3 };
        let r = AccountResolver::for_season(&ctx).unwrap();
        let src = r.legacy_host_ref(frontier_abi::addr::host_id(128, 0, 1, 2, 0).unwrap()).unwrap();
        let rules = frontier_abi::conquest_model::SiteRecordRules { kind: CR::KIND_SIEGE, faction: 0, flags: 0, progress: 0, required: 0, target: 0,
            vigil_start: 0, vigil_next: 0, vigil_from_day: 0, bell: 20 };
        let e = WideConquestEntry { rules, citizen: p.citizen.to_bytes(), source: Some(src), actor_tag: 0, reserved_slot: 2, original_target_gen: 0, declaration_bell: 20 };
        let funder = Address::new_from_array([0x71; 32]);
        let escrow_addr = addr(capture_escrow_address(&ctx, &p.citizen.to_bytes()));
        let table_addr = addr(conquest_address(&ctx, d));
        let src_h = addr(r.holding_address(&src).unwrap());

        let ix = resolve_with_conquest_ix(&a, &payer, d, &dk, 8, 20).unwrap();
        check(&ix, wix::RESOLVE_WITH_CONQUEST, Kind::ResolveWithConquest, &[("fee_payer", payer), ("season", a.season), ("province", dk),
            ("roster", addr(roster_address(&ctx, d))), ("seed", a.seed_cache(20, 8, 0)), ("anchor", a.anchor(20, 8)), ("conquest", table_addr)]);

        let world = WorldId::derive_legacy_season(&ctx.season, &ctx.program).unwrap();
        let esc = WideCaptureEscrow::new(SEASON_ID, world, p.citizen.to_bytes(), funder.to_bytes()).unwrap();
        let ix = settle_siege_ix(&a, &payer, d, &dk, &p, 1, &e, &esc).unwrap();
        assert_eq!(ix.accounts.len(), 8, "the source position appended");
        check(&ix, wix::SETTLE_SIEGE, Kind::SettleSiege, &[("any", payer), ("season", a.season), ("target_province", dk), ("conquest", table_addr),
            ("citizen", p.citizen), ("capture_escrow", escrow_addr), ("escrow_funder", addr(esc.funder())), ("source_holding_position", src_h)]);
        let ix = settle_siege_ix(&a, &payer, d, &dk, &p, 1, &WideConquestEntry { source: None, ..e }, &esc).unwrap();
        assert_eq!(ix.accounts.len(), 7, "a source-less record uses seven positions");

        let ix = settle_capture_ix(&a, &payer, d, &dk, &p, 1, &e).unwrap();
        check(&ix, wix::SETTLE_CAPTURE, Kind::SettleCapture, &[("payer", payer), ("target_province", dk), ("conquest", table_addr), ("citizen", p.citizen),
            ("join_shard", addr(ctx.join_shard(0, 3))), ("capture_escrow", escrow_addr), ("target_holding", addr(holding_address(&ctx, d.coord(), 1))),
            ("source_holding_position", src_h)]);
        assert!(settle_capture_ix(&a, &payer, d, &dk, &p, 1, &WideConquestEntry { source: None, ..e }).is_err(), "no source: not built");

        let t = WideConquest::new(SEASON_ID, d, [0x81; 32]).unwrap();
        let ix = close_conquest_ix(&a, &payer, d, &t).unwrap();
        check(&ix, wix::CLOSE_CONQUEST, Kind::CloseConquest, &[("any", payer), ("conquest", table_addr), ("immutable_rentpayer", addr([0x81; 32]))]);

        let ix = close_capture_escrow_ix(&a, &payer, &p, &esc).unwrap();
        assert_eq!(ix.accounts.len(), 5, "no retained escrow: no funder");
        check(&ix, wix::CLOSE_CAPTURE_ESCROW, Kind::CloseCaptureEscrow, &[("any", payer), ("citizen_position", p.citizen), ("capture_escrow", escrow_addr),
            ("immutable_rentpayer", addr(esc.rent_payer()))]);
    }
}
