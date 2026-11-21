//! The rim → wide expedition's own steps after the player's ExpeditionDepart
//! (feature `playable-lane`; the 0x4804 version-2 dispatch wrapper): ONE copy
//! of the instructions, the evidence checks and the destination plan, used by
//! keeper A's `expeditions` role ([`crate::expeditions`], devnet runbook gap
//! P13) and by the local TEST runner's drivers (`itest::origin_driver`,
//! `itest::destination_driver` re-export these; before this module the runner
//! had the only copy).
//!
//! Pure: no send, no simulation. Every function that reads takes the
//! caller's account lookup (`read`), so the runner passes its in-process
//! chain and the keeper the accounts it just read through its `ChainPort`.
//!
//! Source of truth: the handlers' account tables (`frontier_abi::world_index::
//! wide_ix::{EXPEDITION_DEPART, REVEAL, GATHER, …}`,
//! `expedition_settlement_ix::AccountLayout::Current`) and the dispatch
//! codec (`expedition_dispatch_ix`). See `itest::destination_driver`'s module
//! doc for the order of the destination's steps.
use fclient::addr::Addresses;
use fclient::ports::Account;
use frontier_abi::addr::{day_of, AddrCtx};
use frontier_abi::world_index::{
    arrival::{
        self as wa, arrival_day_address, arrival_slot_address, clash_inputs_address, WideArrival,
        WideClashInputsHdr,
    },
    expedition::AccountResolver,
    expedition_dispatch_ix::{self as dx, Kind},
    expedition_settlement_ix::DraftCommand,
    expedition_transport::{ExpeditionArrivalSlot, OwnedBridgeTransit},
    land::{province_address, WideProvince},
    march::{transit_address, MarchState, WideTransit},
    roster::roster_address,
    seal::{self as wseal, WIDE_PLAIN_LEN, WIDE_SEAL_LEN},
    wide_ix as wix, ProvinceKey, WideHostRef,
};
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};

/// `transit::SETTLE_AFTER_CLOSE_SECS` (the program's member settlement delay).
pub const SETTLE_AFTER_CLOSE_SECS: i64 = 600;
/// The positions of a wide ClashInputs (6 factions × 4 slots).
pub const POSITIONS: u8 = wix::GATHER_POSITIONS;

/// The address context of `a`.
pub fn ctx_of(a: &Addresses) -> AddrCtx {
    AddrCtx {
        program: a.program.to_bytes(),
        season: a.season.to_bytes(),
    }
}

fn adr(k: [u8; 32]) -> Address {
    Address::new_from_array(k)
}

/// The bridge transit record of `holding`'s transit `slot` (its address).
pub fn external_of(a: &Addresses, holding: &Address, slot: u8) -> Address {
    adr(transit_address(&ctx_of(a), &holding.to_bytes(), slot))
}

/// One revealed arrival of the watched holding, verified (module doc).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Arrival {
    pub transit_slot: u8,
    pub external: Address,
    pub host: WideHostRef,
    pub faction: u8,
    pub arrive: u32,
    pub dest: ProvinceKey,
    pub dest_key: Address,
    pub region: u8,
    /// The admitted position: `faction * 4 + i`.
    pub position: u8,
    pub slot: Address,
    pub commit: [u8; 32],
    pub seal: [u8; WIDE_SEAL_LEN],
}

/// The Depart and Reveal evidence of one transit, decoded from landed wire.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Evidence {
    pub depart: Option<wix::ExpeditionDepart>,
    pub reveal: Option<wix::ExpeditionReveal>,
}

/// An owned copy of a landed Depart or Reveal (nothing borrowed from the
/// decoded transaction).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Landed {
    Depart(wix::ExpeditionDepart),
    Reveal(wix::ExpeditionReveal),
}

/// The expedition Departs and Reveals of the program in one landed
/// transaction's wire (version-2 dispatch only; anything else is ignored),
/// each with the instruction's own account keys in order. A dispatch kind
/// whose inner bytes decode to another command is an error.
pub fn commands_in(wire: &[u8], program: &Address) -> Result<Vec<(Landed, Vec<Address>)>, String> {
    let t = fclient::tx::from_wire(wire)?;
    let keys = &t.message.account_keys;
    let mut out = vec![];
    for ix in &t.message.instructions {
        if keys.get(ix.program_id_index as usize) != Some(program) {
            continue;
        }
        let Ok(cmd) = dx::Command::decode(&ix.data) else {
            continue;
        };
        if matches!(cmd.kind(), Kind::Depart | Kind::Reveal) {
            let accounts = ix
                .accounts
                .iter()
                .map(|&i| keys.get(i as usize).copied().ok_or("account index"))
                .collect::<Result<Vec<_>, _>>()?;
            let landed = match (
                cmd.kind(),
                wix::WideCommand::decode(cmd.inner())
                    .map_err(|e| format!("dispatch inner: {e:?}"))?,
            ) {
                (Kind::Depart, wix::WideCommand::ExpeditionDepart(d)) => Landed::Depart(d),
                (Kind::Reveal, wix::WideCommand::ExpeditionReveal(r)) => Landed::Reveal(r),
                _ => return Err("the dispatch kind and its inner command differ".into()),
            };
            out.push((landed, accounts));
        }
    }
    Ok(out)
}

/// The account at role `name` of a command's role table, for an instruction
/// of `accounts.len()` accounts (the abi's own tables and position rule).
fn role<'k>(
    groups: &[frontier_abi::prologue::Group],
    accounts: &'k [Address],
    name: &str,
) -> Option<&'k Address> {
    accounts.get(frontier_abi::prologue::position_in(
        groups,
        accounts.len(),
        name,
        0,
    )?)
}

/// Whether a landed Depart is THIS transit's: its slot, host and arrival
/// bell, its commit and seal reopening the transit's seal root, and the
/// EXPEDITION_DEPART roles season, holding and transit (by index, from the
/// abi's table) being exactly this Season, holding and transit record.
#[allow(clippy::too_many_arguments)]
pub fn depart_matches(
    d: &wix::ExpeditionDepart,
    accounts: &[Address],
    t: &WideTransit,
    slot: u8,
    season: &Address,
    holding: &Address,
    external: &Address,
) -> bool {
    let g = wix::EXPEDITION_DEPART;
    d.transit_slot == slot
        && d.host == t.host.to_bytes()
        && d.arrive_bell == t.arrive_bell
        && wseal::seal_root(&d.commit, &wseal::ct_hash(&d.seal)) == t.seal_root
        && role(g, accounts, "season") == Some(season)
        && role(g, accounts, "holding") == Some(holding)
        && role(g, accounts, "transit") == Some(external)
}

/// Whether a landed Reveal is THIS transit's: its slot, its plaintext and
/// salt reopening the seal root, and the REVEAL roles season, holding and
/// transit (by index) being this Season, holding and transit record.
#[allow(clippy::too_many_arguments)]
pub fn reveal_matches(
    r: &wix::ExpeditionReveal,
    accounts: &[Address],
    t: &WideTransit,
    slot: u8,
    season: &Address,
    holding: &Address,
    external: &Address,
) -> bool {
    let g = wix::REVEAL;
    r.transit_slot == slot
        && wseal::seal_root(&wseal::commit(&r.plain, &r.salt), &r.ct_hash) == t.seal_root
        && role(g, accounts, "season") == Some(season)
        && role(g, accounts, "holding") == Some(holding)
        && role(g, accounts, "transit") == Some(external)
}

/// The landed Depart and Reveal of THIS transit among landed transactions'
/// wires (`wires`: each a successful transaction naming the transit record):
/// only candidates matching the current transit (seal root, host, arrival,
/// roles) count, so an earlier march of a reused slot is not this one; two
/// DIFFERENT matching candidates of a kind are an error (never guessed
/// between).
#[allow(clippy::too_many_arguments)]
pub fn evidence_of<'w>(
    wires: impl IntoIterator<Item = &'w [u8]>,
    program: &Address,
    season: &Address,
    holding: &Address,
    external: &Address,
    t: &WideTransit,
    slot: u8,
) -> Result<Evidence, String> {
    let mut e = Evidence::default();
    for wire in wires {
        for (cmd, accounts) in commands_in(wire, program)? {
            match cmd {
                Landed::Depart(d)
                    if depart_matches(&d, &accounts, t, slot, season, holding, external) =>
                {
                    if e.depart.is_some_and(|x| x != d) {
                        return Err("two different landed Departs match this transit".into());
                    }
                    e.depart = Some(d);
                }
                Landed::Reveal(r)
                    if reveal_matches(&r, &accounts, t, slot, season, holding, external) =>
                {
                    if e.reveal.is_some_and(|x| x != r) {
                        return Err("two different landed Reveals match this transit".into());
                    }
                    e.reveal = Some(r);
                }
                _ => {}
            }
        }
    }
    Ok(e)
}

/// The arrival a bridge transit and its evidence prove (pure; module doc):
/// the Depart's commit and seal and the Reveal's plaintext and salt must both
/// reopen the bridge's seal root; the plaintext's host and arrival bell are
/// the transit's. Returns `(dest, target position i, commit, seal)`.
pub fn verify_evidence(
    t: &WideTransit,
    e: &Evidence,
) -> Result<(ProvinceKey, u8, [u8; 32], [u8; WIDE_SEAL_LEN]), String> {
    let d = e.depart.ok_or("no landed Depart of this transit")?;
    let r = e.reveal.ok_or("no landed Reveal of this transit")?;
    if wseal::seal_root(&d.commit, &wseal::ct_hash(&d.seal)) != t.seal_root {
        return Err("the Depart's commit and seal do not reopen the transit's seal root".into());
    }
    if wseal::seal_root(&wseal::commit(&r.plain, &r.salt), &r.ct_hash) != t.seal_root
        || r.ct_hash != wseal::ct_hash(&d.seal)
    {
        return Err("the Reveal does not reopen the transit's seal root".into());
    }
    if d.arrive_bell != t.arrive_bell || d.host != t.host.to_bytes() {
        return Err("the Depart is not this transit's".into());
    }
    let plain: [u8; WIDE_PLAIN_LEN] = r.plain;
    let pt = wseal::unpack(&plain).map_err(|e| format!("plaintext: {e:?}"))?;
    wseal::validate(&pt, &t.host, t.arrive_bell).map_err(|e| format!("plaintext: {e:?}"))?;
    if r.target_i > 3 {
        return Err("target slot".into());
    }
    Ok((pt.dest, r.target_i, d.commit, d.seal))
}

/// The bridge transit of `holding`'s transit `slot`, if the slot has a
/// program record: `(record address, transit)`.
pub fn bridge_transit<R: Fn(&Address) -> Option<Account>>(
    read: &R,
    a: &Addresses,
    holding: &Address,
    slot: u8,
) -> Result<Option<(Address, WideTransit)>, String> {
    let ctx = ctx_of(a);
    let external = external_of(a, holding, slot);
    let Some(acc) = read(&external).filter(|x| x.owner == a.program) else {
        return Ok(None);
    };
    let b = OwnedBridgeTransit::from_bytes(&ctx, &acc.data)
        .map_err(|e| format!("transit slot {slot}: {e:?}"))?;
    Ok(Some((external, b.transit())))
}

/// The revealed arrival of `holding`'s transit `slot`, verified against its
/// landed evidence `e`; `None` when the slot has no program record, is not
/// past SettleOrigin (Departed), was destroyed at origin, or has no landed
/// Reveal yet. Checks the destination Province (program-owned, canonical,
/// this world and season) and the admitted ArrivalSlot (this destination,
/// bell, host, transit slot, nation and position).
pub fn arrival_of<R: Fn(&Address) -> Option<Account>>(
    read: &R,
    a: &Addresses,
    holding: &Address,
    slot: u8,
    e: &Evidence,
) -> Result<Option<Arrival>, String> {
    let ctx = ctx_of(a);
    let Some((external, t)) = bridge_transit(read, a, holding, slot)? else {
        return Ok(None);
    };
    if !matches!(t.state, MarchState::Settled | MarchState::Gathered) {
        return Ok(None);
    }
    if e.reveal.is_none() {
        return Ok(None);
    }
    let (dest, target, commit, seal) = verify_evidence(&t, e)?;
    let dest_key = adr(province_address(&ctx, dest.coord()));
    let pacc = read(&dest_key).ok_or("the revealed destination Province does not exist")?;
    if pacc.owner != a.program {
        return Err("the destination Province is not the program's".into());
    }
    let prov =
        WideProvince::read(&pacc.data).map_err(|e| format!("destination Province: {e:?}"))?;
    if prov.world != dest.world() || prov.coord != dest.coord() || prov.season_id != a.season_id {
        return Err("the destination Province is not the revealed one".into());
    }
    let slot_key = adr(arrival_slot_address(
        &ctx,
        dest,
        t.arrive_bell,
        t.faction,
        target,
    ));
    let sacc = read(&slot_key).ok_or("the admitted ArrivalSlot does not exist")?;
    if sacc.owner != a.program {
        return Err("the ArrivalSlot is not the program's".into());
    }
    let s =
        ExpeditionArrivalSlot::read(&ctx, &sacc.data).map_err(|e| format!("ArrivalSlot: {e:?}"))?;
    let sc = s.common();
    if sc.dest != dest
        || sc.bell != t.arrive_bell
        || sc.host != t.host
        || sc.transit_slot != slot
        || sc.faction != t.faction
        || sc.i != target
    {
        return Err("the ArrivalSlot is not this transit's admission".into());
    }
    Ok(Some(Arrival {
        transit_slot: slot,
        external,
        host: t.host,
        faction: t.faction,
        arrive: t.arrive_bell,
        dest,
        dest_key,
        region: prov.region,
        position: t.faction * 4 + target,
        slot: slot_key,
        commit,
        seal,
    }))
}

/// The next ungathered position of a ClashInputs mask (`None`: all scanned).
pub fn next_position(mask: u32) -> Option<u8> {
    (0..POSITIONS).find(|k| mask & (1 << k) == 0)
}

/// The accounts of one Gather position `k` (TABLE: slot r, original
/// holding r, owned bridge w for a present slot; for an empty one the slot
/// and two read-only fillers).
pub fn position_accounts<R: Fn(&Address) -> Option<Account>>(
    read: &R,
    a: &Addresses,
    dest: ProvinceKey,
    bell: u32,
    k: u8,
    filler: &Address,
) -> Result<[AccountMeta; 3], String> {
    let ctx = ctx_of(a);
    let slot = adr(arrival_slot_address(&ctx, dest, bell, k / 4, k % 4));
    let Some(acc) = read(&slot) else {
        return Ok([
            AccountMeta::new_readonly(slot, false),
            AccountMeta::new_readonly(*filler, false),
            AccountMeta::new_readonly(*filler, false),
        ]);
    };
    if acc.owner != a.program {
        return Err(format!(
            "position {k}: the slot account is not the program's"
        ));
    }
    let s =
        ExpeditionArrivalSlot::read(&ctx, &acc.data).map_err(|e| format!("position {k}: {e:?}"))?;
    let sc = s.common();
    if sc.dest != dest || sc.bell != bell || sc.faction != k / 4 || sc.i != k % 4 {
        return Err(format!("position {k}: the slot is not this position's"));
    }
    let r = AccountResolver::for_season(&ctx).map_err(|e| format!("{e:?}"))?;
    let holding = r
        .holding_address(&sc.host)
        .map_err(|e| format!("position {k}: {e:?}"))?;
    let external = transit_address(&ctx, &holding, sc.transit_slot);
    Ok([
        AccountMeta::new_readonly(slot, false),
        AccountMeta::new_readonly(adr(holding), false),
        AccountMeta::new(adr(external), false),
    ])
}

/// The ArrivalSlot addresses of `bell` at `dest` (positions `0..24`), the
/// reads [`position_accounts`] needs.
pub fn position_slots(a: &Addresses, dest: ProvinceKey, bell: u32) -> Vec<Address> {
    let ctx = ctx_of(a);
    (0..POSITIONS)
        .map(|k| adr(arrival_slot_address(&ctx, dest, bell, k / 4, k % 4)))
        .collect()
}

/// The ExpeditionGather of `bell`'s positions `start..start + n` at the
/// arrival's destination, with THE anchor (or its archive part) `anchor_src`.
#[allow(clippy::too_many_arguments)]
pub fn gather_ix_with<R: Fn(&Address) -> Option<Account>>(
    read: &R,
    a: &Addresses,
    payer: &Address,
    arr: &Arrival,
    bell: u32,
    start: u8,
    n: u8,
    anchor_src: &Address,
) -> Result<Instruction, String> {
    let ctx = ctx_of(a);
    if n == 0 || start as u16 + n as u16 > POSITIONS as u16 {
        return Err("gather cursor".into());
    }
    let mut m = vec![
        AccountMeta::new(*payer, true),
        AccountMeta::new_readonly(a.season, false),
        AccountMeta::new_readonly(arr.dest_key, false),
        AccountMeta::new_readonly(*anchor_src, false),
        AccountMeta::new(adr(clash_inputs_address(&ctx, arr.dest, bell)), false),
        AccountMeta::new_readonly(
            adr(arrival_day_address(&ctx, arr.dest, day_of(bell))),
            false,
        ),
        AccountMeta::new_readonly(fclient::addr::instructions_sysvar(), false),
        AccountMeta::new_readonly(fclient::addr::system_program(), false),
    ];
    let filler = fclient::addr::system_program();
    for k in start..start + n {
        m.extend(position_accounts(read, a, arr.dest, bell, k, &filler)?);
    }
    let data = dx::encode(
        Kind::Gather,
        &wix::ExpeditionGather { bell, start, n }.to_bytes(),
    )
    .map_err(|e| format!("{e:?}"))?;
    Ok(Instruction {
        program_id: a.program,
        accounts: m,
        data,
    })
}

/// [`gather_ix_with`] over THE anchor account of `(bell, region)`.
pub fn gather_ix<R: Fn(&Address) -> Option<Account>>(
    read: &R,
    a: &Addresses,
    payer: &Address,
    arr: &Arrival,
    bell: u32,
    start: u8,
    n: u8,
) -> Result<Instruction, String> {
    gather_ix_with(
        read,
        a,
        payer,
        arr,
        bell,
        start,
        n,
        &a.anchor(bell, arr.region),
    )
}

/// The wide Resolve of the destination at `bell` (its `resolved_next`), with
/// the bell seed's source `seed_src` (a SeedCache of any nonce, or the
/// archive part) and THE anchor's source `anchor_src` (the anchor account or
/// its archive part; `proc/wide.rs resolve`: `[seedcache|archive r]
/// [anchor|archive r]`).
pub fn resolve_ix_with(
    a: &Addresses,
    payer: &Address,
    arr: &Arrival,
    bell: u32,
    seed_src: &Address,
    anchor_src: &Address,
) -> Instruction {
    resolve_ix_at(a, payer, arr.dest, bell, seed_src, anchor_src)
}

/// The wide Resolve of ANY wide province `dest` at `bell` (its
/// `resolved_next`): [`resolve_ix_with`] without an arrival (P9's
/// `wide-resolve` role; the same nine accounts, `proc/wide.rs resolve_inner`).
pub fn resolve_ix_at(
    a: &Addresses,
    payer: &Address,
    dest: ProvinceKey,
    bell: u32,
    seed_src: &Address,
    anchor_src: &Address,
) -> Instruction {
    let ctx = ctx_of(a);
    let dest_key = adr(province_address(&ctx, dest.coord()));
    let data = wix::Resolve {
        bell,
        beneficiary: payer.to_bytes(),
    }
    .to_bytes()
    .to_vec();
    Instruction {
        program_id: a.program,
        data,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(a.season, false),
            AccountMeta::new(dest_key, false),
            AccountMeta::new(adr(roster_address(&ctx, dest)), false),
            AccountMeta::new_readonly(*seed_src, false),
            AccountMeta::new_readonly(*anchor_src, false),
            AccountMeta::new(adr(clash_inputs_address(&ctx, dest, bell)), false),
            AccountMeta::new_readonly(adr(arrival_day_address(&ctx, dest, day_of(bell))), false),
            AccountMeta::new_readonly(fclient::addr::system_program(), false),
        ],
    }
}

/// [`resolve_ix_with`] over the SeedCache of nonce 0 and THE anchor account.
pub fn resolve_ix(a: &Addresses, payer: &Address, arr: &Arrival, bell: u32) -> Instruction {
    resolve_ix_with(
        a,
        payer,
        arr,
        bell,
        &a.seed_cache(bell, arr.region, 0),
        &a.anchor(bell, arr.region),
    )
}

/// The destination's resolve cursor, read with identity checks (pure).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BellView {
    /// The destination's `resolved_next`.
    pub resolved_next: u32,
    /// The bell to work on: `resolved_next` (never past the arrival).
    pub bell: u32,
    /// THE anchor's landing time of (bell, region), if present.
    pub anchor: Option<i64>,
    /// The ClashInputs of the bell (program-owned, this destination's and bell's), if present.
    pub inputs: Option<Vec<u8>>,
    /// The bell's ArrivalDay bit (arrivals were revealed into it).
    pub arrivals: bool,
    pub seed: bool,
    /// The lowest bell of `resolved_next..min(arrival + 1, now_bell)` whose anchor is absent.
    pub missing_anchor: Option<u32>,
}

/// Every bell the driver would touch (the cursor up to the arrival) must be
/// below the Season's `end_bell`: the arrival bell is the highest of them.
pub fn check_end_bell(arrive: u32, end_bell: u32) -> Result<(), String> {
    if arrive >= end_bell {
        return Err(format!("the arrival bell {arrive} is at or past the Season's end bell {end_bell}: not driven (no round fetched, nothing posted)"));
    }
    Ok(())
}

/// The next action for the destination (pure; the runner's module doc order).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Plan {
    /// PostAnchor of this ended bell in the destination region.
    Anchor(u32),
    /// The bell has not ended (no anchor yet).
    WaitEnded(u32),
    /// The bell's reveal window is still open.
    WaitWindow(u32),
    /// Gather these positions of the bell.
    Gather { bell: u32, start: u8 },
    /// PostSeed of the bell.
    Seed(u32),
    /// Resolve the bell; `quiet` = no ClashInputs and no ArrivalDay bit.
    Resolve { bell: u32, quiet: bool },
    /// The arrival bell is resolved: the settlement step.
    Settle,
}

pub fn plan(arr: &Arrival, v: &BellView, window_closed: bool) -> Result<Plan, String> {
    if let Some(b) = v.missing_anchor {
        return Ok(Plan::Anchor(b));
    }
    if v.resolved_next > arr.arrive {
        return Ok(Plan::Settle);
    }
    let b = v.bell;
    if v.anchor.is_none() {
        return Ok(Plan::WaitEnded(b));
    }
    if !window_closed {
        return Ok(Plan::WaitWindow(b));
    }
    let header = match &v.inputs {
        Some(d) => Some(WideClashInputsHdr::read(d).map_err(|e| format!("ClashInputs: {e:?}"))?),
        None => None,
    };
    let has_arrivals = b == arr.arrive || v.arrivals || header.is_some();
    if has_arrivals {
        if let Some(start) = next_position(header.as_ref().map_or(0, |h| h.arrivals_mask)) {
            return Ok(Plan::Gather { bell: b, start });
        }
    }
    if !v.seed {
        return Ok(Plan::Seed(b));
    }
    Ok(Plan::Resolve {
        bell: b,
        quiet: !has_arrivals,
    })
}

/// The ClashInputs of `bell` at the arrival's destination, if present
/// (program-owned, this destination's, bell's and Season's).
pub fn inputs_at<R: Fn(&Address) -> Option<Account>>(
    read: &R,
    a: &Addresses,
    arr: &Arrival,
    bell: u32,
) -> Result<Option<Vec<u8>>, String> {
    let ctx = ctx_of(a);
    let Some(x) = read(&adr(clash_inputs_address(&ctx, arr.dest, bell))) else {
        return Ok(None);
    };
    if x.owner != a.program {
        return Err("the ClashInputs is not the program's".into());
    }
    let h = WideClashInputsHdr::read(&x.data).map_err(|e| format!("ClashInputs: {e:?}"))?;
    if h.dest != arr.dest || h.bell != bell || h.season_id != a.season_id {
        return Err("the ClashInputs is not this destination's and bell's".into());
    }
    Ok(Some(x.data))
}

/// The ArrivalDay bit of `bell` at the arrival's destination (absent: clear).
pub fn arrival_bit<R: Fn(&Address) -> Option<Account>>(
    read: &R,
    a: &Addresses,
    arr: &Arrival,
    bell: u32,
) -> Result<bool, String> {
    let ctx = ctx_of(a);
    match read(&adr(arrival_day_address(&ctx, arr.dest, day_of(bell)))) {
        None => Ok(false),
        Some(d) if d.owner == a.program => {
            let rec =
                wa::WideArrivalDay::read(&d.data).map_err(|e| format!("ArrivalDay: {e:?}"))?;
            if rec.season_id != a.season_id || rec.dest != arr.dest || rec.day != day_of(bell) {
                return Err("the ArrivalDay is not this destination's day".into());
            }
            Ok(rec.has(bell))
        }
        Some(_) => Err("the ArrivalDay is not the program's".into()),
    }
}

/// The destination Province's `resolved_next` (program-owned).
pub fn resolved_next_at<R: Fn(&Address) -> Option<Account>>(
    read: &R,
    a: &Addresses,
    dest_key: &Address,
) -> Result<u32, String> {
    let pacc = read(dest_key).ok_or("the destination Province is absent")?;
    if pacc.owner != a.program {
        return Err("the destination Province is not the program's".into());
    }
    use frontier_abi::v2::layout::province::province as PV;
    Ok(u32::from_le_bytes(
        pacc.data
            .get(PV::RESOLVED_NEXT..PV::RESOLVED_NEXT + 4)
            .ok_or("province bytes")?
            .try_into()
            .unwrap(),
    ))
}

/// The Season's `end_bell` (program-owned).
pub fn end_bell_of<R: Fn(&Address) -> Option<Account>>(
    read: &R,
    a: &Addresses,
) -> Result<u32, String> {
    use frontier_abi::v2::layout::world::season as S;
    let sacc = read(&a.season).ok_or("no Season")?;
    if sacc.owner != a.program {
        return Err("the Season is not the program's".into());
    }
    Ok(u32::from_le_bytes(
        sacc.data
            .get(S::END_BELL..S::END_BELL + 4)
            .ok_or("season bytes")?
            .try_into()
            .unwrap(),
    ))
}

/// The member settlement of the arrival (`SETTLE_MEMBER`, the current
/// 14-account layout): `home` is the holding's own province; the rent and
/// beneficiary recipients are read from the records (transit `rent_to`,
/// slot `beneficiary`, inputs `resolver`, holding `RENT_PAYER`).
#[allow(clippy::too_many_arguments)]
pub fn settle_member_ix(
    a: &Addresses,
    payer: &Address,
    arr: &Arrival,
    holding: &Address,
    home: &Address,
    rent_to: &Address,
    slot_beneficiary: &Address,
    resolver: &Address,
    holding_rent_payer: &Address,
) -> Result<Instruction, String> {
    let ctx = ctx_of(a);
    let inner = DraftCommand::new(arr.transit_slot, arr.commit, arr.seal)
        .map_err(|e| format!("{e:?}"))?
        .to_bytes();
    let data = dx::encode(Kind::SettleMember, &inner).map_err(|e| format!("{e:?}"))?;
    Ok(Instruction {
        program_id: a.program,
        data,
        accounts: vec![
            AccountMeta::new_readonly(a.season, false),
            AccountMeta::new(*holding, false),
            AccountMeta::new(arr.external, false),
            AccountMeta::new(*home, false),
            AccountMeta::new(arr.dest_key, false),
            AccountMeta::new(adr(clash_inputs_address(&ctx, arr.dest, arr.arrive)), false),
            AccountMeta::new(arr.slot, false),
            AccountMeta::new(*rent_to, false),
            AccountMeta::new_readonly(a.anchor(arr.arrive, arr.region), false),
            AccountMeta::new(*payer, true),
            AccountMeta::new(*slot_beneficiary, false),
            AccountMeta::new(*resolver, false),
            AccountMeta::new(*holding_rent_payer, false),
            AccountMeta::new(*payer, false),
        ],
    })
}

/// The recipients [`settle_member_ix`] names, read from the records: the
/// transit's `rent_to`, the slot's `beneficiary`, the inputs' `resolver`,
/// the holding's `RENT_PAYER`, and the host's home Province address.
pub fn member_parties<R: Fn(&Address) -> Option<Account>>(
    read: &R,
    a: &Addresses,
    arr: &Arrival,
    holding: &Address,
    inputs: &WideClashInputsHdr,
) -> Result<(Address, Address, Address, Address, Address), String> {
    let ctx = ctx_of(a);
    let t = OwnedBridgeTransit::from_bytes(&ctx, &read(&arr.external).ok_or("no transit")?.data)
        .map_err(|e| format!("{e:?}"))?
        .transit();
    let sd = ExpeditionArrivalSlot::read(&ctx, &read(&arr.slot).ok_or("no slot")?.data)
        .map_err(|e| format!("{e:?}"))?;
    let hd = read(holding).ok_or("no holding")?.data;
    use frontier_abi::v2::layout::player::holding as H;
    let rent_payer: [u8; 32] = hd
        .get(H::RENT_PAYER..H::RENT_PAYER + 32)
        .ok_or("holding bytes")?
        .try_into()
        .unwrap();
    let home = adr(AccountResolver::for_season(&ctx)
        .map_err(|e| format!("{e:?}"))?
        .province_address(arr.host.key())
        .map_err(|e| format!("{e:?}"))?);
    Ok((
        home,
        adr(t.rent_to),
        adr(sd.common().beneficiary),
        adr(inputs.resolver),
        adr(rent_payer),
    ))
}

/// What the resolved inputs allow for this arrival's position (pure).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Settle {
    /// Already settled: nothing to do.
    Done,
    /// Not resolved yet / settlement time not reached.
    Wait(String),
    /// The member settlement may be sent.
    Member,
    /// A fate whose terminal settlement this driver does not drive.
    Unsupported(u8),
}

pub fn settle_decision(
    h: &WideClashInputsHdr,
    row: Option<&WideArrival>,
    position: u8,
    now: i64,
    settle_at: i64,
) -> Settle {
    if h.settled_mask & (1 << position) != 0 {
        return Settle::Done;
    }
    if h.flags & wa::wide_clash_inputs::FLAG_RESOLVED == 0 {
        return Settle::Wait("not resolved".into());
    }
    let Some(row) = row else {
        return Settle::Unsupported(wa::wide_arrival::FATE_NONE);
    };
    if !row.present {
        return Settle::Unsupported(row.fate);
    }
    // the camp's winner (the lowest position of `camp_mask`, staying) is
    // settled by SettleCamp, which the member settlement refuses
    let camp_winner = row.fate == wa::wide_arrival::FATE_STAYS
        && h.camp_mask != 0
        && h.camp_mask.trailing_zeros() == position as u32;
    if camp_winner {
        return Settle::Unsupported(row.fate);
    }
    match row.fate {
        wa::wide_arrival::FATE_STAYS..=wa::wide_arrival::FATE_DESTROYED if now >= settle_at => {
            Settle::Member
        }
        wa::wide_arrival::FATE_STAYS..=wa::wide_arrival::FATE_DESTROYED => {
            Settle::Wait(format!("settlement opens at {settle_at}"))
        }
        f => Settle::Unsupported(f),
    }
}

/// A sealed expedition opened from public data only.
#[derive(Clone, Debug)]
pub struct Opened {
    pub slot: u8,
    pub plain: [u8; WIDE_PLAIN_LEN],
    pub salt: [u8; 32],
    pub ct_hash: [u8; 32],
    pub dest: ProvinceKey,
    pub faction: u8,
    pub arrive: u32,
    /// The provinces the walk enters other than the destination, in first-entered order.
    pub path: Vec<ProvinceKey>,
}

/// Opens a landed Depart's wide seal with the public signature of `T(arrive)` (pure): the stock IBE opener, the
/// ABI's body and commitment check, `unpack` and `validate` against the transit. The salt is the ABI's
/// `salt_of(k)`. Then walks the committed path from the transit's origin: the provinces it enters other than the
/// destination, in first-entered order (as a reveal lists them).
pub fn open_departed(
    t: &WideTransit,
    d: &wix::ExpeditionDepart,
    slot: u8,
    sig48: &[u8; 48],
) -> Result<Opened, String> {
    open_sealed(t.origin, &t.host, t.faction, t.arrive_bell, d, slot, sig48)
}

/// [`open_departed`] over the transit's fields: where the host stood, its identity, nation and arrival bell.
pub fn open_sealed(
    origin: frontier_abi::world_index::TileAddress,
    host: &WideHostRef,
    faction: u8,
    arrive_bell: u32,
    d: &wix::ExpeditionDepart,
    slot: u8,
    sig48: &[u8; 48],
) -> Result<Opened, String> {
    use frontier_abi::world_index::tiles::WideTile;
    use permutation_rules::frontier::seal as ks;
    let mut k = fclient::seal::open_ibe(&wseal::ibe_block(&d.seal), sig48)
        .map_err(|e| format!("the seal does not open: {e:?}"))?;
    let plain = wseal::open_body(&k, &d.seal, &d.commit);
    let salt = ks::salt_of(&k);
    k.fill(0);
    let plain = plain.ok_or("the opened body does not match the Depart's commitment")?;
    let pt = wseal::unpack(&plain).map_err(|e| format!("plaintext: {e:?}"))?;
    wseal::validate(&pt, host, arrive_bell).map_err(|e| format!("plaintext: {e:?}"))?;
    let mut at = WideTile::of(origin);
    let mut path: Vec<ProvinceKey> = vec![];
    for i in 0..pt.path_len as usize {
        let dir = ks::path_step(&pt.path, i) as usize;
        at = at.neighbors()[dir].ok_or("the committed path leaves the map")?;
        let key = at.province();
        if key != pt.dest && !path.contains(&key) {
            path.push(key);
        }
    }
    if at.province() != pt.dest || at.local() != pt.dest_tile {
        return Err("the committed path does not end at the sealed destination tile".into());
    }
    if path.len() + 1 > permutation_rules::frontier::travel::MAX_PATH_PROVINCES {
        return Err("the committed path enters too many provinces".into());
    }
    Ok(Opened {
        slot,
        plain,
        salt,
        ct_hash: wseal::ct_hash(&d.seal),
        dest: pt.dest,
        faction,
        arrive: arrive_bell,
        path,
    })
}

/// The ExpeditionReveal (version-2 dispatch, `Kind::Reveal`) of `holding`'s transit into ArrivalSlot position
/// `target`, paid by `payer` (also the beneficiary): the sixteen accounts of `wide_ix::REVEAL` in order, then the
/// path provinces at their family's canonical address (read-only). Writable: the payer, the day, the target slot.
pub fn self_reveal_ix(
    ctx: &AddrCtx,
    payer: &Address,
    holding: &Address,
    o: &Opened,
    region: u8,
    target: u8,
) -> Result<Instruction, String> {
    use frontier_abi::addr::archive_part_of;
    let inner = wix::ExpeditionReveal {
        transit_slot: o.slot,
        target_i: target,
        plain: o.plain,
        salt: o.salt,
        ct_hash: o.ct_hash,
        beneficiary: payer.to_bytes(),
    };
    let data =
        dx::encode(Kind::Reveal, &inner.to_bytes()).map_err(|e| format!("Reveal wire: {e:?}"))?;
    let (dest, arrive) = (o.dest, o.arrive);
    let mut m = vec![
        AccountMeta::new(*payer, true),
        AccountMeta::new_readonly(adr(ctx.season), false),
        AccountMeta::new_readonly(*holding, false),
        AccountMeta::new_readonly(
            adr(transit_address(ctx, &holding.to_bytes(), o.slot)),
            false,
        ),
        AccountMeta::new_readonly(adr(ctx.bell_anchor(arrive, region)), false),
        AccountMeta::new_readonly(
            adr(ctx.anchor_archive(region, archive_part_of(arrive))),
            false,
        ),
        AccountMeta::new_readonly(adr(ctx.beacon_log(region)), false),
        AccountMeta::new_readonly(adr(clash_inputs_address(ctx, dest, arrive)), false),
        AccountMeta::new_readonly(adr(province_address(ctx, dest.coord())), false),
        AccountMeta::new(adr(arrival_day_address(ctx, dest, day_of(arrive))), false),
    ];
    for i in 0..4u8 {
        let k = adr(arrival_slot_address(ctx, dest, arrive, o.faction, i));
        m.push(if i == target {
            AccountMeta::new(k, false)
        } else {
            AccountMeta::new_readonly(k, false)
        });
    }
    m.push(AccountMeta::new_readonly(
        fclient::addr::instructions_sysvar(),
        false,
    ));
    m.push(AccountMeta::new_readonly(
        fclient::addr::system_program(),
        false,
    ));
    if m.len() != wix::REVEAL_FIXED {
        return Err("the reveal's fixed accounts".into());
    }
    let resolver = AccountResolver::for_season(ctx).map_err(|e| format!("{e:?}"))?;
    for k in &o.path {
        m.push(AccountMeta::new_readonly(
            adr(resolver
                .province_address(*k)
                .map_err(|e| format!("{e:?}"))?),
            false,
        ));
    }
    Ok(Instruction {
        program_id: adr(ctx.program),
        accounts: m,
        data,
    })
}

/// ExpeditionSettleOrigin (version-2 dispatch, `Kind::SettleOrigin`) of
/// `holding`'s transit `slot` at its legacy home province `home`: `[payer
/// s,w] [season r] [home w] [holding w] [home w] [transit w]` (the runner's
/// origin driver's account list).
pub fn settle_origin_ix(
    a: &Addresses,
    payer: &Address,
    home: (i32, i32),
    holding: &Address,
    slot: u8,
) -> Result<Instruction, String> {
    let home = a.province(home.0, home.1);
    let data = dx::encode(
        Kind::SettleOrigin,
        &wix::ExpeditionSettleOrigin { transit_slot: slot }.to_bytes(),
    )
    .map_err(|e| format!("SettleOrigin wire: {e:?}"))?;
    Ok(Instruction {
        program_id: a.program,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(a.season, false),
            AccountMeta::new(home, false),
            AccountMeta::new(*holding, false),
            AccountMeta::new(home, false),
            AccountMeta::new(external_of(a, holding, slot), false),
        ],
        data,
    })
}

// ------------------------------------------------------------ the route (a participant's planning)

use frontier_abi::world_index::{tiles::WideTile, TileAddress};

/// A derived route (pure over the generated province masks): the hex
/// directions, the destination tile, the provinces in `path_tiles` order
/// (destination first, then each first-entered other province) and the
/// stepped tiles.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Route {
    pub dirs: Vec<u8>,
    pub dest_tile: u8,
    pub keys: Vec<ProvinceKey>,
    pub steps: Vec<TileAddress>,
}

/// The program's masks of one province (`PASSABLE`, `ROUGH`, `ROAD`).
#[derive(Clone, Copy, Debug)]
pub struct Masks {
    pub key: ProvinceKey,
    pub passable: u64,
    pub rough: u64,
    pub road: u64,
}

pub fn masks_of(key: ProvinceKey, data: &[u8]) -> Masks {
    use frontier_abi::v2::layout::province::province as PV;
    let u = |o: usize| u64::from_le_bytes(data[o..o + 8].try_into().unwrap());
    Masks {
        key,
        passable: u(PV::PASSABLE_MASK),
        rough: u(PV::ROUGH_MASK),
        road: u(PV::ROAD_MASK),
    }
}

/// The shortest route from `origin` into any passable tile of `dest`, stepping
/// only on passable tiles of the provinces in `lands` (the program's
/// `path_tiles` geometry: `WideTile::neighbors` in `DIRECTIONS` order), at
/// most `MAX_PATH_STEPS` steps and `MAX_PATH_PROVINCES` provinces. Watch
/// blocks of structures are not modelled here (the Reveal checks them).
pub fn derive_route(origin: TileAddress, dest: ProvinceKey, lands: &[Masks]) -> Option<Route> {
    derive_route_to(origin, dest, lands, None)
}

/// As [`derive_route`], ending on `tile` of `dest` when given (e.g. the Free
/// City's tile the program placed), else on any passable tile of `dest`.
pub fn derive_route_to(
    origin: TileAddress,
    dest: ProvinceKey,
    lands: &[Masks],
    tile: Option<u8>,
) -> Option<Route> {
    use permutation_rules::frontier::travel::{MAX_PATH_PROVINCES, MAX_PATH_STEPS};
    let passable = |t: &WideTile| {
        lands
            .iter()
            .any(|l| l.key == t.province() && l.passable & (1u64 << t.local()) != 0)
    };
    let start = WideTile::of(origin);
    let mut prev: std::collections::HashMap<WideTile, (WideTile, u8)> = Default::default();
    let mut frontier = std::collections::VecDeque::from([(start, 0usize)]);
    let mut goal = None;
    while let Some((t, depth)) = frontier.pop_front() {
        if t != start && t.province() == dest && tile.is_none_or(|x| x == t.local()) {
            goal = Some(t);
            break;
        }
        if depth == MAX_PATH_STEPS {
            continue;
        }
        for (dir, n) in t.neighbors().iter().enumerate() {
            let Some(n) = n else { continue };
            if *n == start || prev.contains_key(n) || !passable(n) {
                continue;
            }
            prev.insert(*n, (t, dir as u8));
            frontier.push_back((*n, depth + 1));
        }
    }
    let mut t = goal?;
    let mut dirs = vec![];
    let mut tiles = vec![];
    while t != start {
        let (p, d) = prev[&t];
        dirs.push(d);
        tiles.push(t);
        t = p;
    }
    dirs.reverse();
    tiles.reverse();
    let mut keys = vec![dest];
    for s in &tiles {
        if !keys.contains(&s.province()) {
            keys.push(s.province());
        }
    }
    if keys.len() > MAX_PATH_PROVINCES {
        return None;
    }
    Some(Route {
        dest_tile: tiles.last()?.local(),
        dirs,
        keys,
        steps: tiles.iter().map(|s| s.address()).collect(),
    })
}

/// The program's raw walking seconds of `steps` (`walk`: rough 180 / flat
/// 120, halved for cavalry and again on a road).
pub fn raw_secs(steps: &[TileAddress], lands: &[Masks], cavalry: bool) -> u32 {
    use permutation_rules::frontier::travel::{FLAT_HEX_SECS, ROUGH_HEX_SECS};
    steps
        .iter()
        .map(|s| {
            let l = lands
                .iter()
                .find(|l| l.key == s.key())
                .expect("a stepped province");
            let bit = 1u64 << s.local();
            let base = if l.rough & bit != 0 {
                ROUGH_HEX_SECS
            } else {
                FLAT_HEX_SECS
            };
            base >> (cavalry as u32 + (l.road & bit != 0) as u32)
        })
        .sum()
}

/// An upper bound of the travel seconds for any faction and unit (slowest:
/// no cavalry, no road), so the chosen arrival bell is never too early.
pub fn travel_upper(steps: &[TileAddress], lands: &[Masks]) -> u32 {
    let flat_or_rough: u32 = steps
        .iter()
        .map(|s| {
            let l = lands
                .iter()
                .find(|l| l.key == s.key())
                .expect("a stepped province");
            if l.rough & (1u64 << s.local()) != 0 {
                permutation_rules::frontier::travel::ROUGH_HEX_SECS
            } else {
                permutation_rules::frontier::travel::FLAT_HEX_SECS
            }
        })
        .sum();
    (0..6u8)
        .filter_map(permutation_rules::frontier::doctrine::of_faction_v3)
        .map(|d| d.travel_secs(flat_or_rough as u64) as u32)
        .max()
        .expect("a doctrine")
}
