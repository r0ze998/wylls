//! **Local-play destination driver**: after the player's ExpeditionReveal
//! landed, drives the wide destination's REAL instructions, at most one
//! transaction per step, each landed on the node's own ticker:
//!
//! 0. **bounded catch-up**: a wide province resolves one bell at a time
//!    (`Resolve` needs `bell == resolved_next`, `OutOfOrder` otherwise), so
//!    the destination's bells from its `resolved_next` up to the arrival
//!    bell are resolved first, oldest first, with the same real
//!    instructions: `PostAnchor` of each ended bell in the destination
//!    region whose anchor is absent (a public Quicknet round verified
//!    against the pinned key; anchors that exist must pass the identity
//!    check), then per bell, once its window closed, `PostSeed` and a quiet
//!    `Resolve` (no ClashInputs and the ArrivalDay bit clear: the program
//!    resolves the residents alone). A bell before the arrival that HAS
//!    arrivals (a ClashInputs or its ArrivalDay bit) is gathered like the
//!    arrival bell; its settlement is not ours. More than
//!    [`MAX_CATCH_UP_BELLS`] bells behind stops the driver (reported, not
//!    driven); no state is written directly;
//! 1. wait for THE anchor of (arrival bell, destination region) — the
//!    keeper's destination anchors — and its reveal window to close;
//! 2. `ExpeditionGather` (version-2 dispatch, `Kind::Gather`) in
//!    packet-sized cursor batches until all 24 positions are scanned;
//! 3. `PostSeed` of (arrival bell, region, nonce 0) with the seed round's
//!    public Quicknet signature, verified against the pinned key;
//! 4. `Resolve` (the wide resolve) of the destination at the arrival bell;
//! 5. once `reveal_close + SETTLE_AFTER_CLOSE_SECS` has passed, the member
//!    settlement (`Kind::SettleMember`) of THIS transit when its resolved
//!    fate is one the program's member settlement accepts for a present
//!    final-set member (`stage_resolved_return`: Stays, Withdrew, Bounced,
//!    Retreated, Destroyed; the plan returns troops only for Bounced and
//!    Retreated, and none for Destroyed). A Stays that won the camp is the
//!    separate camp settlement (SettleCamp), and an absent row or no fate is
//!    not a member: both stop the driver with the fate named. A landed
//!    settlement is never reported here as an arrival success.
//!
//! The arrival is found and verified from public data only: the transit's
//! bridge record (program-owned, Settled or Gathered after SettleOrigin), the
//! LANDED Depart and Reveal transactions naming that transit (their wire
//! decoded through the version-2 dispatch parser), each checked against the
//! bridge's seal root (`seal_root(commit, ct_hash(seal))` and
//! `seal_root(commit(plain, salt), ct_hash)`), the plaintext's arrival bell
//! against the bridge's, the destination Province (program-owned, of this
//! world, at its canonical address) for the region, and the admitted
//! ArrivalSlot (this destination, bell, host and transit slot). Any mismatch
//! is an error and stops the driver; a refusal of the program (simulated
//! first, or landed) or an unknown outcome stops it for good (never resent).
//! Nothing is written directly, no fight or arrival is synthesized.
use fclient::addr::Addresses;
use fclient::ix::{post_seed, BeaconArg};
use fclient::{AccountMeta, Address, Instruction, Keypair, Signer};
use frontier_abi::addr::{day_of, AddrCtx};
use frontier_abi::world_index::{
    arrival::{self as wa, arrival_day_address, arrival_slot_address, clash_inputs_address, WideArrival, WideClashInputsHdr},
    expedition::AccountResolver,
    expedition_dispatch_ix::{self as dx, Kind},
    expedition_settlement_ix::{self, DraftCommand},
    expedition_transport::{ExpeditionArrivalSlot, OwnedBridgeTransit},
    land::{province_address, WideProvince},
    march::{transit_address, MarchState, WideTransit},
    roster::roster_address,
    seal::{self as wseal, WIDE_PLAIN_LEN, WIDE_SEAL_LEN},
    wide_ix as wix, ProvinceKey, WideHostRef,
};
use localnet::server::{lock, Shared};
use localnet::Chain;

use crate::keeper_loop::{submit_and_wait, Sent};
use crate::local_keeper as lk;

/// `transit::SETTLE_AFTER_CLOSE_SECS` (the program's member settlement delay).
pub const SETTLE_AFTER_CLOSE_SECS: i64 = 600;
/// The most destination bells the catch-up resolves before an arrival.
pub const MAX_CATCH_UP_BELLS: u32 = 144;
/// The positions of a wide ClashInputs (6 factions × 4 slots).
pub const POSITIONS: u8 = wix::GATHER_POSITIONS;

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
#[derive(Clone, Debug, Default)]
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
        let Ok(cmd) = dx::Command::decode(&ix.data) else { continue };
        if matches!(cmd.kind(), Kind::Depart | Kind::Reveal) {
            let accounts = ix.accounts.iter().map(|&i| keys.get(i as usize).copied().ok_or("account index")).collect::<Result<Vec<_>, _>>()?;
            let landed = match (cmd.kind(), wix::WideCommand::decode(cmd.inner()).map_err(|e| format!("dispatch inner: {e:?}"))?) {
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
fn role<'k>(groups: &[frontier_abi::prologue::Group], accounts: &'k [Address], name: &str) -> Option<&'k Address> {
    accounts.get(frontier_abi::prologue::position_in(groups, accounts.len(), name, 0)?)
}

/// Whether a landed Depart is THIS transit's: its slot, host and arrival
/// bell, its commit and seal reopening the transit's seal root, and the
/// EXPEDITION_DEPART roles season, holding and transit (by index, from the
/// abi's table) being exactly this Season, holding and transit record.
#[allow(clippy::too_many_arguments)]
pub fn depart_matches(d: &wix::ExpeditionDepart, accounts: &[Address], t: &WideTransit, slot: u8, season: &Address, holding: &Address, external: &Address) -> bool {
    let g = wix::EXPEDITION_DEPART;
    d.transit_slot == slot && d.host == t.host.to_bytes() && d.arrive_bell == t.arrive_bell
        && wseal::seal_root(&d.commit, &wseal::ct_hash(&d.seal)) == t.seal_root
        && role(g, accounts, "season") == Some(season) && role(g, accounts, "holding") == Some(holding) && role(g, accounts, "transit") == Some(external)
}

/// Whether a landed Reveal is THIS transit's: its slot, its plaintext and
/// salt reopening the seal root, and the REVEAL roles season, holding and
/// transit (by index) being this Season, holding and transit record.
#[allow(clippy::too_many_arguments)]
pub fn reveal_matches(r: &wix::ExpeditionReveal, accounts: &[Address], t: &WideTransit, slot: u8, season: &Address, holding: &Address, external: &Address) -> bool {
    let g = wix::REVEAL;
    r.transit_slot == slot && wseal::seal_root(&wseal::commit(&r.plain, &r.salt), &r.ct_hash) == t.seal_root
        && role(g, accounts, "season") == Some(season) && role(g, accounts, "holding") == Some(holding) && role(g, accounts, "transit") == Some(external)
}

/// The landed (no error) Depart and Reveal of THIS transit among the
/// transactions naming its record: only candidates matching the current
/// transit (seal root, host, arrival, roles) count, so an earlier march of a
/// reused slot is not this one; two DIFFERENT matching candidates of a kind
/// are an error (never guessed between).
pub fn evidence(c: &Chain, program: &Address, season: &Address, holding: &Address, external: &Address, t: &WideTransit, slot: u8) -> Result<Evidence, String> {
    let mut e = Evidence::default();
    for l in c.signatures_for(external, 256, None, None) {
        if l.err.is_some() {
            continue;
        }
        for (cmd, accounts) in commands_in(&l.wire, program)? {
            match cmd {
                Landed::Depart(d) if depart_matches(&d, &accounts, t, slot, season, holding, external) => {
                    if e.depart.is_some_and(|x| x != d) {
                        return Err("two different landed Departs match this transit".into());
                    }
                    e.depart = Some(d);
                }
                Landed::Reveal(r) if reveal_matches(&r, &accounts, t, slot, season, holding, external) => {
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
pub fn verify_evidence(t: &WideTransit, e: &Evidence) -> Result<(ProvinceKey, u8, [u8; 32], [u8; WIDE_SEAL_LEN]), String> {
    let d = e.depart.ok_or("no landed Depart of this transit")?;
    let r = e.reveal.ok_or("no landed Reveal of this transit")?;
    if wseal::seal_root(&d.commit, &wseal::ct_hash(&d.seal)) != t.seal_root {
        return Err("the Depart's commit and seal do not reopen the transit's seal root".into());
    }
    if wseal::seal_root(&wseal::commit(&r.plain, &r.salt), &r.ct_hash) != t.seal_root || r.ct_hash != wseal::ct_hash(&d.seal) {
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

fn ctx_of(a: &Addresses) -> AddrCtx {
    AddrCtx { program: a.program.to_bytes(), season: a.season.to_bytes() }
}

/// The revealed arrival of `holding`'s transit `slot`, verified; `None` when
/// the slot has no program record, is not past SettleOrigin (Departed, the
/// origin driver's), was destroyed at origin, or has no landed Reveal yet.
pub fn find_arrival(c: &Chain, a: &Addresses, holding: &Address, slot: u8) -> Result<Option<Arrival>, String> {
    let ctx = ctx_of(a);
    let external = Address::new_from_array(transit_address(&ctx, &holding.to_bytes(), slot));
    let Some(acc) = c.account(&external) else { return Ok(None) };
    if acc.owner != a.program {
        return Ok(None);
    }
    let b = OwnedBridgeTransit::from_bytes(&ctx, &acc.data).map_err(|e| format!("transit slot {slot}: {e:?}"))?;
    let t = b.transit();
    if !matches!(t.state, MarchState::Settled | MarchState::Gathered) {
        return Ok(None);
    }
    let e = evidence(c, &a.program, &a.season, holding, &external, &t, slot)?;
    if e.reveal.is_none() {
        return Ok(None);
    }
    let (dest, target, commit, seal) = verify_evidence(&t, &e)?;
    let dest_key = Address::new_from_array(province_address(&ctx, dest.coord()));
    let pacc = c.account(&dest_key).ok_or("the revealed destination Province does not exist")?;
    if pacc.owner != a.program {
        return Err("the destination Province is not the program's".into());
    }
    let prov = WideProvince::read(&pacc.data).map_err(|e| format!("destination Province: {e:?}"))?;
    if prov.world != dest.world() || prov.coord != dest.coord() || prov.season_id != a.season_id {
        return Err("the destination Province is not the revealed one".into());
    }
    let slot_key = Address::new_from_array(arrival_slot_address(&ctx, dest, t.arrive_bell, t.faction, target));
    let sacc = c.account(&slot_key).ok_or("the admitted ArrivalSlot does not exist")?;
    if sacc.owner != a.program {
        return Err("the ArrivalSlot is not the program's".into());
    }
    let s = ExpeditionArrivalSlot::read(&ctx, &sacc.data).map_err(|e| format!("ArrivalSlot: {e:?}"))?;
    let sc = s.common();
    if sc.dest != dest || sc.bell != t.arrive_bell || sc.host != t.host || sc.transit_slot != slot || sc.faction != t.faction || sc.i != target {
        return Err("the ArrivalSlot is not this transit's admission".into());
    }
    Ok(Some(Arrival { transit_slot: slot, external, host: t.host, faction: t.faction, arrive: t.arrive_bell, dest, dest_key, region: prov.region,
        position: t.faction * 4 + target, slot: slot_key, commit, seal }))
}

/// The next ungathered position of a ClashInputs mask (`None`: all scanned).
pub fn next_position(mask: u32) -> Option<u8> {
    (0..POSITIONS).find(|k| mask & (1 << k) == 0)
}

/// The accounts of one Gather position `k` (TABLE: slot r, original
/// holding r, owned bridge w for a present slot; for an empty one the slot
/// and two read-only fillers).
pub fn position_accounts(c: &Chain, a: &Addresses, dest: ProvinceKey, bell: u32, k: u8, filler: &Address) -> Result<[AccountMeta; 3], String> {
    let ctx = ctx_of(a);
    let slot = Address::new_from_array(arrival_slot_address(&ctx, dest, bell, k / 4, k % 4));
    let Some(acc) = c.account(&slot) else {
        return Ok([AccountMeta::new_readonly(slot, false), AccountMeta::new_readonly(*filler, false), AccountMeta::new_readonly(*filler, false)]);
    };
    if acc.owner != a.program {
        return Err(format!("position {k}: the slot account is not the program's"));
    }
    let s = ExpeditionArrivalSlot::read(&ctx, &acc.data).map_err(|e| format!("position {k}: {e:?}"))?;
    let sc = s.common();
    if sc.dest != dest || sc.bell != bell || sc.faction != k / 4 || sc.i != k % 4 {
        return Err(format!("position {k}: the slot is not this position's"));
    }
    let r = AccountResolver::for_season(&ctx).map_err(|e| format!("{e:?}"))?;
    let holding = r.holding_address(&sc.host).map_err(|e| format!("position {k}: {e:?}"))?;
    let external = transit_address(&ctx, &holding, sc.transit_slot);
    Ok([AccountMeta::new_readonly(slot, false), AccountMeta::new_readonly(Address::new_from_array(holding), false),
        AccountMeta::new(Address::new_from_array(external), false)])
}

/// The ExpeditionGather of `bell`'s positions `start..start + n` at the
/// arrival's destination.
pub fn gather_ix(c: &Chain, a: &Addresses, payer: &Address, arr: &Arrival, bell: u32, start: u8, n: u8) -> Result<Instruction, String> {
    let ctx = ctx_of(a);
    if n == 0 || start as u16 + n as u16 > POSITIONS as u16 {
        return Err("gather cursor".into());
    }
    let mut m = vec![
        AccountMeta::new(*payer, true),
        AccountMeta::new_readonly(a.season, false),
        AccountMeta::new_readonly(arr.dest_key, false),
        AccountMeta::new_readonly(a.anchor(bell, arr.region), false),
        AccountMeta::new(Address::new_from_array(clash_inputs_address(&ctx, arr.dest, bell)), false),
        AccountMeta::new_readonly(Address::new_from_array(arrival_day_address(&ctx, arr.dest, day_of(bell))), false),
        AccountMeta::new_readonly(fclient::addr::instructions_sysvar(), false),
        AccountMeta::new_readonly(fclient::addr::system_program(), false),
    ];
    let filler = fclient::addr::system_program();
    for k in start..start + n {
        m.extend(position_accounts(c, a, arr.dest, bell, k, &filler)?);
    }
    let data = dx::encode(Kind::Gather, &wix::ExpeditionGather { bell, start, n }.to_bytes()).map_err(|e| format!("{e:?}"))?;
    Ok(Instruction { program_id: a.program, accounts: m, data })
}

/// The widest Gather batch from `start` that fits the packet (at least one).
pub fn gather_batch(c: &Chain, a: &Addresses, payer: &Keypair, arr: &Arrival, bell: u32, start: u8) -> Result<Instruction, String> {
    let mut best = None;
    for n in 1..=(POSITIONS - start) {
        let ix = gather_ix(c, a, &payer.pubkey(), arr, bell, start, n)?;
        if lk::encoded_len(std::slice::from_ref(&ix), payer)? > lk::PACKET_BYTES {
            break;
        }
        best = Some(ix);
    }
    best.ok_or_else(|| format!("no Gather batch from position {start} fits the packet"))
}

/// The wide Resolve of the destination at `bell` (its `resolved_next`).
pub fn resolve_ix(a: &Addresses, payer: &Address, arr: &Arrival, bell: u32) -> Instruction {
    let ctx = ctx_of(a);
    let data = wix::Resolve { bell, beneficiary: payer.to_bytes() }.to_bytes().to_vec();
    Instruction { program_id: a.program, data, accounts: vec![
        AccountMeta::new(*payer, true),
        AccountMeta::new_readonly(a.season, false),
        AccountMeta::new(arr.dest_key, false),
        AccountMeta::new(Address::new_from_array(roster_address(&ctx, arr.dest)), false),
        AccountMeta::new_readonly(a.seed_cache(bell, arr.region, 0), false),
        AccountMeta::new_readonly(a.anchor(bell, arr.region), false),
        AccountMeta::new(Address::new_from_array(clash_inputs_address(&ctx, arr.dest, bell)), false),
        AccountMeta::new_readonly(Address::new_from_array(arrival_day_address(&ctx, arr.dest, day_of(bell))), false),
        AccountMeta::new_readonly(fclient::addr::system_program(), false),
    ] }
}

/// Which resolve a destination bell takes, from the destination's conquest
/// state (pure; the same choice as `resident_bells::plan`): no conquest table
/// and no site record → the plain wide Resolve; a live program-owned conquest
/// table → ResolveWithConquest (kind 13), conquest runner only (a plain Resolve
/// cannot pass a live table); site records without a table → not provable.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResolveChoice {
    Plain,
    WithConquest,
    /// Nothing sent: the reason is the caller's `Stopped`.
    Refused(&'static str),
}

pub fn resolve_choice(conquest: crate::resident_bells::Conquest) -> ResolveChoice {
    use crate::resident_bells::Conquest;
    match conquest {
        Conquest::None => ResolveChoice::Plain,
        Conquest::Table if cfg!(feature = "localnet-conquest-play") => ResolveChoice::WithConquest,
        Conquest::Table => ResolveChoice::Refused("a conquest table is live; this runner has no ResolveWithConquest (plain Resolve not sent)"),
        Conquest::Unprovable => ResolveChoice::Refused("site records are set without a conquest table: not provable, nothing sent"),
    }
}

/// The bell's resolve instruction by [`resolve_choice`] over the destination's
/// current state (read under the caller's lock, identity-checked).
pub fn resolve_for(c: &Chain, a: &Addresses, payer: &Address, arr: &Arrival, bell: u32) -> Result<(Instruction, &'static str), String> {
    let pd = c.account(&arr.dest_key).ok_or("the destination Province is absent")?;
    if pd.owner != a.program {
        return Err("the destination Province is not the program's".into());
    }
    match resolve_choice(crate::resident_bells::conquest_of(c, a, arr.dest, &pd.data)?) {
        ResolveChoice::Plain => Ok((resolve_ix(a, payer, arr, bell), "Resolve")),
        #[cfg(feature = "localnet-conquest-play")]
        ResolveChoice::WithConquest => Ok((crate::conquest_crank::resolve_with_conquest_ix(a, payer, arr.dest, &arr.dest_key, arr.region, bell)?, "ResolveWithConquest")),
        #[cfg(not(feature = "localnet-conquest-play"))]
        ResolveChoice::WithConquest => Err("ResolveWithConquest chosen without the conquest runner".into()),
        ResolveChoice::Refused(w) => Err(format!("bell {bell}: {w}")),
    }
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

/// What the destination needs next for `arr` (pure over the chain).
///
/// Identity: `arr` must come from [`find_arrival`] read under the SAME chain
/// lock (the driver does so): that call authenticated the destination
/// Province (program-owned, canonical address, this world, coordinate and
/// season) and the ArrivalSlot; here the Province is re-read only for its
/// owner and `resolved_next`, every anchor through `anchor_landed`'s
/// identity check, the ArrivalDay and ClashInputs by owner, season,
/// destination and day/bell. A caller passing an `Arrival` from elsewhere
/// gets none of the Province checks.
///
/// Season boundary: an arrival at or past the Season's `end_bell` is refused
/// here, before any round is fetched or anchor posted (never left to the
/// program's later `WrongStatus`).
pub fn bell_view(c: &Chain, a: &Addresses, arr: &Arrival, now_bell: u32) -> Result<BellView, String> {
    let ctx = ctx_of(a);
    use frontier_abi::v2::layout::world::season as S;
    let sacc = c.account(&a.season).ok_or("no Season")?;
    if sacc.owner != a.program {
        return Err("the Season is not the program's".into());
    }
    let end_bell = u32::from_le_bytes(sacc.data.get(S::END_BELL..S::END_BELL + 4).ok_or("season bytes")?.try_into().unwrap());
    check_end_bell(arr.arrive, end_bell)?;
    let pacc = c.account(&arr.dest_key).ok_or("the destination Province is absent")?;
    if pacc.owner != a.program {
        return Err("the destination Province is not the program's".into());
    }
    use frontier_abi::v2::layout::province::province as PV;
    let rn = u32::from_le_bytes(pacc.data.get(PV::RESOLVED_NEXT..PV::RESOLVED_NEXT + 4).ok_or("province bytes")?.try_into().unwrap());
    if rn > arr.arrive {
        // already resolved past the arrival: only the settlement remains
        return Ok(BellView { resolved_next: rn, bell: arr.arrive, anchor: lk::anchor_landed(c, a, arr.arrive, arr.region)?, inputs: inputs_of(c, a, arr, arr.arrive)?,
            arrivals: true, seed: true, missing_anchor: None });
    }
    if arr.arrive - rn > MAX_CATCH_UP_BELLS {
        return Err(format!("the destination is {} bells behind the arrival (resolved_next {rn}); a catch-up beyond {MAX_CATCH_UP_BELLS} bells is not driven", arr.arrive - rn));
    }
    let mut missing_anchor = None;
    for b in rn..=arr.arrive.min(now_bell.saturating_sub(1)) {
        if lk::anchor_landed(c, a, b, arr.region)?.is_none() {
            missing_anchor = Some(b);
            break;
        }
    }
    let day_key = Address::new_from_array(arrival_day_address(&ctx, arr.dest, day_of(rn)));
    let arrivals = match c.account(&day_key) {
        None => false,
        Some(d) if d.owner == a.program => {
            let rec = wa::WideArrivalDay::read(&d.data).map_err(|e| format!("ArrivalDay: {e:?}"))?;
            if rec.season_id != a.season_id || rec.dest != arr.dest || rec.day != day_of(rn) {
                return Err("the ArrivalDay is not this destination's day".into());
            }
            rec.has(rn)
        }
        Some(_) => return Err("the ArrivalDay is not the program's".into()),
    };
    Ok(BellView { resolved_next: rn, bell: rn, anchor: lk::anchor_landed(c, a, rn, arr.region)?, inputs: inputs_of(c, a, arr, rn)?, arrivals,
        seed: c.account(&a.seed_cache(rn, arr.region, 0)).is_some(), missing_anchor })
}

/// Every bell the driver would touch (the cursor up to the arrival) must be
/// below the Season's `end_bell`: the arrival bell is the highest of them.
pub fn check_end_bell(arrive: u32, end_bell: u32) -> Result<(), String> {
    if arrive >= end_bell {
        return Err(format!("the arrival bell {arrive} is at or past the Season's end bell {end_bell}: not driven (no round fetched, nothing posted)"));
    }
    Ok(())
}

/// The next action for the destination (pure; module doc order).
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
    Ok(Plan::Resolve { bell: b, quiet: !has_arrivals })
}

fn inputs_of(c: &Chain, a: &Addresses, arr: &Arrival, bell: u32) -> Result<Option<Vec<u8>>, String> {
    let ctx = ctx_of(a);
    let Some(x) = c.account(&Address::new_from_array(clash_inputs_address(&ctx, arr.dest, bell))) else { return Ok(None) };
    if x.owner != a.program {
        return Err("the ClashInputs is not the program's".into());
    }
    let h = WideClashInputsHdr::read(&x.data).map_err(|e| format!("ClashInputs: {e:?}"))?;
    if h.dest != arr.dest || h.bell != bell || h.season_id != a.season_id {
        return Err("the ClashInputs is not this destination's and bell's".into());
    }
    Ok(Some(x.data))
}

/// The member settlement of the arrival (`SETTLE_MEMBER`, the current
/// 14-account layout): `home` is the holding's own province; the rent and
/// beneficiary recipients are read from the records (transit `rent_to`,
/// slot `beneficiary`, inputs `resolver`, holding `RENT_PAYER`).
#[allow(clippy::too_many_arguments)]
pub fn settle_member_ix(a: &Addresses, payer: &Address, arr: &Arrival, holding: &Address, home: &Address, rent_to: &Address, slot_beneficiary: &Address,
    resolver: &Address, holding_rent_payer: &Address) -> Result<Instruction, String> {
    let ctx = ctx_of(a);
    let inner = DraftCommand::new(arr.transit_slot, arr.commit, arr.seal).map_err(|e| format!("{e:?}"))?.to_bytes();
    let data = dx::encode(Kind::SettleMember, &inner).map_err(|e| format!("{e:?}"))?;
    Ok(Instruction { program_id: a.program, data, accounts: vec![
        AccountMeta::new_readonly(a.season, false),
        AccountMeta::new(*holding, false),
        AccountMeta::new(arr.external, false),
        AccountMeta::new(*home, false),
        AccountMeta::new(arr.dest_key, false),
        AccountMeta::new(Address::new_from_array(clash_inputs_address(&ctx, arr.dest, arr.arrive)), false),
        AccountMeta::new(arr.slot, false),
        AccountMeta::new(*rent_to, false),
        AccountMeta::new_readonly(a.anchor(arr.arrive, arr.region), false),
        AccountMeta::new(*payer, true),
        AccountMeta::new(*slot_beneficiary, false),
        AccountMeta::new(*resolver, false),
        AccountMeta::new(*holding_rent_payer, false),
        AccountMeta::new(*payer, false),
    ] })
}

/// The member settlement refuses ANY executable account among its roles
/// (`wide_expedition_settlement::snapshots`: `BadAccount`), e.g. a zero
/// `RENT_PAYER` naming the System Program: named here before anything is
/// simulated or sent (a stop, never a send).
pub fn executable_role(c: &Chain, ix: &Instruction) -> Option<(usize, Address)> {
    ix.accounts.iter().enumerate().find(|(_, m)| c.account(&m.pubkey).is_some_and(|x| x.executable)).map(|(i, m)| (i, m.pubkey))
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

pub fn settle_decision(h: &WideClashInputsHdr, row: Option<&WideArrival>, position: u8, now: i64, settle_at: i64) -> Settle {
    if h.settled_mask & (1 << position) != 0 {
        return Settle::Done;
    }
    if h.flags & wa::wide_clash_inputs::FLAG_RESOLVED == 0 {
        return Settle::Wait("not resolved".into());
    }
    let Some(row) = row else { return Settle::Unsupported(wa::wide_arrival::FATE_NONE) };
    if !row.present {
        return Settle::Unsupported(row.fate);
    }
    // the camp's winner (the lowest position of `camp_mask`, staying) is
    // settled by SettleCamp, which the member settlement refuses
    let camp_winner = row.fate == wa::wide_arrival::FATE_STAYS && h.camp_mask != 0 && h.camp_mask.trailing_zeros() == position as u32;
    if camp_winner {
        return Settle::Unsupported(row.fate);
    }
    match row.fate {
        wa::wide_arrival::FATE_STAYS..=wa::wide_arrival::FATE_DESTROYED if now >= settle_at => Settle::Member,
        wa::wide_arrival::FATE_STAYS..=wa::wide_arrival::FATE_DESTROYED => Settle::Wait(format!("settlement opens at {settle_at}")),
        f => Settle::Unsupported(f),
    }
}

/// One step's outcome.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Step {
    Landed(String, String),
    Wait(String),
    /// This arrival's member settlement has landed (or was already done),
    /// with the arrival's resolved `fate` (the program's row): a completed
    /// settlement is NOT an arrival or occupation success unless the fate is
    /// Stays ([`Step::arrival_stays`]).
    Settled { fate: u8 },
    Unknown { signature: String, why: String },
    Stopped(String),
}

impl Step {
    /// Whether this is a completed settlement of an arrival that STAYS in the
    /// destination (the only fate after which the host is resident there and
    /// a declaration may be considered). Destroyed, Withdrew, Bounced,
    /// Retreated or any other step: false.
    pub fn arrival_stays(&self) -> bool {
        matches!(self, Step::Settled { fate } if *fate == wa::wide_arrival::FATE_STAYS)
    }
}

pub struct DestinationDriver {
    pub a: Addresses,
    holding: Address,
    payer: Keypair,
    stop: tokio::sync::watch::Receiver<bool>,
    pub land_timeout: std::time::Duration,
    terminal: Option<Step>,
    last: Option<Step>,
    pub log: Vec<String>,
}

impl DestinationDriver {
    pub fn new(holding: Address, payer: Keypair, stop: tokio::sync::watch::Receiver<bool>) -> DestinationDriver {
        DestinationDriver { a: Addresses::new(Address::new_from_array(crate::expedition_play::PROGRAM), crate::expedition_play::SEASON_ID),
            holding, payer, stop, land_timeout: crate::keeper_loop::LAND_TIMEOUT, terminal: None, last: None, log: vec![] }
    }

    pub fn terminal(&self) -> Option<&Step> {
        self.terminal.as_ref()
    }

    /// The last step taken (e.g. `Settled { fate }`), for readers that must
    /// tell a staying arrival from a settled defeat.
    pub fn last_step(&self) -> Option<&Step> {
        self.last.as_ref()
    }

    /// At most one transaction. After `Unknown` / `Stopped` every later call
    /// returns it (nothing is resent).
    pub async fn step(&mut self, state: &Shared) -> Step {
        if let Some(t) = &self.terminal {
            return t.clone();
        }
        let s = self.step_inner(state).await;
        if matches!(s, Step::Unknown { .. } | Step::Stopped(_)) {
            self.terminal = Some(s.clone());
        }
        self.last = Some(s.clone());
        s
    }

    async fn send(&mut self, state: &Shared, ix: Instruction, what: String) -> Step {
        if *self.stop.borrow() {
            return Step::Stopped("stopped by request".into());
        }
        let sim = lk::simulate_ix(&lock(state), &self.payer, &ix);
        match sim {
            Ok(s) if s.err.is_none() => {}
            Ok(s) => return Step::Stopped(format!("{what} simulation: {:?} (code {:?})", s.err, s.code)),
            Err(e) => return Step::Stopped(e),
        }
        let step = match submit_and_wait(state, &self.payer, ix, &what, self.land_timeout, &mut self.stop).await {
            Sent::Landed(sig) => Step::Landed(what, sig),
            Sent::Failed(e) => Step::Stopped(e),
            Sent::Unknown { signature, why } => Step::Unknown { signature, why },
        };
        self.log.push(format!("{step:?}"));
        step
    }

    async fn step_inner(&mut self, state: &Shared) -> Step {
        let me = self.payer.pubkey();
        let read = {
            let c = lock(state);
            (|| -> Result<Option<(Arrival, fclient::clock::SeasonClock, i64, BellView)>, String> {
                let mut found = None;
                for slot in 0..4u8 {
                    if let Some(arr) = find_arrival(&c, &self.a, &self.holding, slot)? {
                        found = Some(arr);
                        break;
                    }
                }
                let Some(arr) = found else { return Ok(None) };
                let clock = lk::season_clock(&c, &self.a)?;
                let now = c.unix_timestamp();
                let now_bell = clock.bell_at(now).ok_or("the chain's time is before the season")?;
                let v = bell_view(&c, &self.a, &arr, now_bell)?;
                Ok(Some((arr, clock, now, v)))
            })()
        };
        let (arr, clock, now, v) = match read {
            Ok(Some(x)) => x,
            Ok(None) => return Step::Wait("no revealed arrival of the watched holding".into()),
            Err(e) => return Step::Stopped(e),
        };
        let window_closed = v.anchor.is_some_and(|a_ts| now >= clock.reveal_close(v.bell, a_ts));
        let next = match plan(&arr, &v, window_closed) {
            Ok(p) => p,
            Err(e) => return Step::Stopped(e),
        };
        match next {
            Plan::Anchor(b) => {
                let fetched = tokio::select! {
                    r = lk::fetch_rounds(&clock, b..b + 1) => r,
                    _ = crate::keeper_loop::stopped(&mut self.stop) => return Step::Stopped("stopped by request".into()),
                };
                let r = match fetched {
                    Ok(rs) => match rs.into_iter().find(|r| r.bell == b && r.round == clock.tlock_round(b)) {
                        Some(r) => r,
                        None => return Step::Wait(format!("round of bell {b} not served")),
                    },
                    Err(e) => return Step::Wait(format!("round of bell {b}: {e}")),
                };
                return match lk::post_anchor_ix(&self.a, &me, arr.region, &r) {
                    Ok(ix) => self.send(state, ix, format!("PostAnchor(bell {b}, region {})", arr.region)).await,
                    Err(e) => Step::Stopped(e),
                };
            }
            Plan::WaitEnded(b) => return Step::Wait(format!("bell {b} has not ended")),
            Plan::WaitWindow(b) => return Step::Wait(format!("the reveal window of bell {b} is open")),
            Plan::Gather { bell, start } => {
                let ix = { let c = lock(state); gather_batch(&c, &self.a, &self.payer, &arr, bell, start) };
                return match ix {
                    Ok(ix) => self.send(state, ix, format!("ExpeditionGather(bell {bell}, from {start})")).await,
                    Err(e) => Step::Stopped(e),
                };
            }
            Plan::Seed(b) => {
                let a_ts = v.anchor.expect("planned with an anchor");
                let round = clock.seed_round(b, a_ts);
                if clock.drand.round_time(round) > now {
                    return Step::Wait(format!("the seed round {round} of bell {b} is not due yet"));
                }
                let fetched = tokio::select! {
                    r = lk::fetch_round_at(round) => r,
                    _ = crate::keeper_loop::stopped(&mut self.stop) => return Step::Stopped("stopped by request".into()),
                };
                let sig48 = match fetched {
                    Ok(s) => s,
                    Err(e) => return Step::Wait(format!("seed round {round}: {e}")),
                };
                let arg = BeaconArg { round, sig48, hints: fclient::beacon::hints_bytes(round) };
                let ix = post_seed(&self.a, me, arr.region, b, 0, &arg, &me);
                return self.send(state, ix, format!("PostSeed(bell {b}, region {}, round {round})", arr.region)).await;
            }
            Plan::Resolve { bell, quiet } => {
                // plain Resolve, or ResolveWithConquest under a live conquest table
                // (resolve_choice); anything unprovable stops, nothing sent
                let built = { let c = lock(state); resolve_for(&c, &self.a, &me, &arr, bell) };
                let (ix, name) = match built {
                    Ok(x) => x,
                    Err(e) => return Step::Stopped(e),
                };
                let what = if quiet { format!("{name}(quiet bell {bell})") } else { format!("{name}(bell {bell})") };
                return self.send(state, ix, what).await;
            }
            Plan::Settle => {}
        }
        // 5. the arrival bell is resolved: the member settlement of THIS arrival
        let Some(a_ts) = v.anchor else { return Step::Stopped("the arrival bell resolved without its anchor".into()) };
        let close = clock.reveal_close(arr.arrive, a_ts);
        let Some(inputs) = v.inputs else { return Step::Stopped("the arrival bell resolved without its ClashInputs".into()) };
        let h = match WideClashInputsHdr::read(&inputs) {
            Ok(h) => h,
            Err(e) => return Step::Stopped(format!("ClashInputs: {e:?}")),
        };
        let row = match WideArrival::read_at(&inputs, arr.position as usize) {
            Ok(r) => r,
            Err(e) => return Step::Stopped(format!("arrival row {}: {e:?}", arr.position)),
        };
        if let Some(r) = &row {
            if r.host != arr.host {
                return Step::Stopped("the resolved row is not this arrival's host".into());
            }
        }
        let fate = row.as_ref().map_or(wa::wide_arrival::FATE_NONE, |r| r.fate);
        match settle_decision(&h, row.as_ref(), arr.position, now, close + SETTLE_AFTER_CLOSE_SECS) {
            Settle::Done => Step::Settled { fate },
            Settle::Wait(w) => Step::Wait(w),
            Settle::Unsupported(f) => Step::Stopped(format!("resolved fate {f}: its terminal settlement is not driven here (not settled, not reported as an arrival success)")),
            Settle::Member => {
                let built = {
                    let c = lock(state);
                    (|| -> Result<Instruction, String> {
                        let ctx = ctx_of(&self.a);
                        let t = OwnedBridgeTransit::from_bytes(&ctx, &c.account(&arr.external).ok_or("no transit")?.data).map_err(|e| format!("{e:?}"))?.transit();
                        let sd = ExpeditionArrivalSlot::read(&ctx, &c.account(&arr.slot).ok_or("no slot")?.data).map_err(|e| format!("{e:?}"))?;
                        let hd = c.account(&self.holding).ok_or("no holding")?.data;
                        use frontier_abi::v2::layout::player::holding as H;
                        let rent_payer: [u8; 32] = hd.get(H::RENT_PAYER..H::RENT_PAYER + 32).ok_or("holding bytes")?.try_into().unwrap();
                        let home = Address::new_from_array(AccountResolver::for_season(&ctx).map_err(|e| format!("{e:?}"))?
                            .province_address(arr.host.key()).map_err(|e| format!("{e:?}"))?);
                        let ix = settle_member_ix(&self.a, &me, &arr, &self.holding, &home, &Address::new_from_array(t.rent_to),
                            &Address::new_from_array(sd.common().beneficiary), &Address::new_from_array(h.resolver), &Address::new_from_array(rent_payer))?;
                        if let Some((i, k)) = executable_role(&c, &ix) {
                            let role = expedition_settlement_ix::AccountLayout::Current.spec(i).map_or("?", |s| s.name);
                            return Err(format!("SettleMember role {i} ({role}) is the executable account {k}; the program refuses executable roles (not sent)"));
                        }
                        Ok(ix)
                    })()
                };
                match built {
                    Ok(ix) => match self.send(state, ix, format!("SettleMember(transit {})", arr.transit_slot)).await {
                        Step::Landed(..) => Step::Settled { fate },
                        other => other,
                    },
                    Err(e) => Step::Stopped(e),
                }
            }
        }
    }
}

/// TEST ONLY helper: the 24-position mask with positions `..k` scanned.
#[cfg(test)]
pub(crate) fn mask_through(k: u8) -> u32 {
    if k >= 32 { u32::MAX } else { (1u32 << k) - 1 }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// PURE: the destination driver's resolve (catch-up bells and the arrival
    /// bell, after its Gather) follows the destination's conquest state exactly
    /// as the resident bells do: a live table takes ResolveWithConquest on the
    /// conquest runner and is refused otherwise; unprovable records are refused;
    /// no table keeps the plain Resolve (unchanged).
    #[test]
    fn the_resolve_follows_the_destinations_conquest_state() {
        use crate::resident_bells::Conquest;
        assert_eq!(resolve_choice(Conquest::None), ResolveChoice::Plain);
        #[cfg(feature = "localnet-conquest-play")]
        assert_eq!(resolve_choice(Conquest::Table), ResolveChoice::WithConquest);
        #[cfg(not(feature = "localnet-conquest-play"))]
        assert!(matches!(resolve_choice(Conquest::Table), ResolveChoice::Refused(_)));
        assert!(matches!(resolve_choice(Conquest::Unprovable), ResolveChoice::Refused(_)));
    }
    use crate::expedition_play::{PROGRAM, SEASON_ID};
    use frontier_abi::world_index::{seal::WidePlain, TileAddress, WideCoord, HOST_IDENTITY_FULL_REF_V1};

    fn addrs() -> Addresses {
        Addresses::new(Address::new_from_array(PROGRAM), SEASON_ID)
    }

    /// A real wide seal of a plaintext to (129, 0) and the transit it would
    /// make (the same codecs the program uses; fixed public test values).
    fn sealed_transit() -> (WideTransit, wix::ExpeditionDepart, wix::ExpeditionReveal) {
        use permutation_rules::frontier::{doctrine::of_faction_v3, stance::{Posture, Stance}, travel::{march_stamina, MAX_PATH_STEPS}};
        let a = addrs();
        let ctx = ctx_of(&a);
        let r = AccountResolver::for_season(&ctx).unwrap();
        let host = r.legacy_host_ref(frontier_abi::addr::host_id(128, 0, 1, 2, 0).unwrap()).unwrap();
        let arrive = 20;
        let (path_len, path) = permutation_rules::frontier::seal::encode_path(&[0]).unwrap();
        let plain = WidePlain { version: wseal::WIDE_PLAIN_VERSION, host, arrive_bell: arrive,
            dest: ProvinceKey::new(host.key().world(), WideCoord::checked(129, 0).unwrap()), dest_tile: 30, stance: 0, retreat_bps: 0,
            path_len, path, reserved: [0; wseal::WIDE_RESERVED_BYTES] };
        let qn = fclient::beacon::quicknet_info();
        let s = fclient::wide_seal::seal_wide(&plain, &host, arrive, &qn.public_key, 1_000_000).unwrap();
        let doctrine = of_faction_v3(2).unwrap();
        let t = WideTransit::depart(HOST_IDENTITY_FULL_REF_V1, host, doctrine.unit as u8, 2, TileAddress::new(host.key(), 3).unwrap(),
            arrive - 5, arrive, 600, 100_000, march_stamina(MAX_PATH_STEPS as u32), doctrine.dealt_bps(Posture::Stance(Stance::Hold), true) as u16,
            s.seal_root, 0, 0, [22; 32]).unwrap();
        let d = wix::ExpeditionDepart { host: host.to_bytes(), transit_slot: 0, arrive_bell: arrive, tip: 0, commit: s.commit, seal: s.seal };
        let rv = wix::ExpeditionReveal { transit_slot: 0, target_i: 1, plain: *s.reveal.plain(), salt: *s.reveal.salt(), ct_hash: s.ct_hash, beneficiary: [7; 32] };
        (t, d, rv)
    }

    #[test]
    fn the_arrival_is_proven_by_both_landed_commands_against_the_seal_root() {
        let (t, d, r) = sealed_transit();
        let ok = Evidence { depart: Some(d), reveal: Some(r) };
        let (dest, target, commit, seal) = verify_evidence(&t, &ok).unwrap();
        assert_eq!(((dest.coord().p(), dest.coord().q())), (129, 0));
        assert_eq!((target, commit, seal), (1, d.commit, d.seal));
        assert!(verify_evidence(&t, &Evidence { depart: Some(d), reveal: None }).is_err(), "no Reveal");
        assert!(verify_evidence(&t, &Evidence { depart: None, reveal: Some(r) }).is_err(), "no Depart");
        let bad_salt = wix::ExpeditionReveal { salt: [1; 32], ..r };
        assert!(verify_evidence(&t, &Evidence { depart: Some(d), reveal: Some(bad_salt) }).is_err());
        let mut seal2 = d.seal;
        seal2[0] ^= 1;
        assert!(verify_evidence(&t, &Evidence { depart: Some(wix::ExpeditionDepart { seal: seal2, ..d }), reveal: Some(r) }).is_err());
        assert!(verify_evidence(&t, &Evidence { depart: Some(wix::ExpeditionDepart { arrive_bell: 21, ..d }), reveal: Some(r) }).is_err());
        assert!(verify_evidence(&WideTransit { seal_root: [0; 32], ..t }, &ok).is_err(), "another transit");
        assert!(verify_evidence(&t, &Evidence { depart: Some(d), reveal: Some(wix::ExpeditionReveal { target_i: 4, ..r }) }).is_err());
    }

    #[test]
    fn the_dispatch_wire_of_a_landed_transaction_is_decoded_exactly() {
        let (_, d, r) = sealed_transit();
        let program = Address::new_from_array(PROGRAM);
        let payer = Keypair::new();
        let wire = |data: Vec<u8>, pid: Address| {
            let ix = Instruction { program_id: pid, accounts: vec![AccountMeta::new(payer.pubkey(), true)], data };
            let t = fclient::tx::build(&[ix], &lk::budget(), &[&payer], &fclient::Hash::new_from_array([1; 32])).unwrap();
            fclient::tx::wire(&t)
        };
        let dep = dx::encode(Kind::Depart, &d.to_bytes()).unwrap();
        let rev = dx::encode(Kind::Reveal, &r.to_bytes()).unwrap();
        assert_eq!(commands_in(&wire(dep.clone(), program), &program).unwrap(), vec![(Landed::Depart(d), vec![payer.pubkey()])]);
        assert_eq!(commands_in(&wire(rev, program), &program).unwrap(), vec![(Landed::Reveal(r), vec![payer.pubkey()])]);
        // a Reveal kind wrapping a Depart's bytes is never taken as either
        // (refused by the wrapper or by the kind check)
        if let Ok(bytes) = dx::encode(Kind::Reveal, &d.to_bytes()) {
            let got = commands_in(&wire(bytes, program), &program);
            assert!(!matches!(got, Ok(ref v) if !v.is_empty()), "kind and inner command differ: {got:?}");
        }
        assert!(commands_in(&wire(dep, Address::new_from_array([9; 32])), &program).unwrap().is_empty(), "another program");
        assert!(commands_in(&wire(d.to_bytes().to_vec(), program), &program).unwrap().is_empty(), "not the version-2 dispatch");
    }

    /// An account list of the table's fewest accounts (a filler everywhere)
    /// with `roles` placed at their positions by the abi's `position_in`.
    fn keys_for(g: &[frontier_abi::prologue::Group], roles: &[(&str, Address)]) -> Vec<Address> {
        let n = frontier_abi::prologue::bounds_in(g).0;
        let mut k = vec![Address::new_from_array([0xee; 32]); n];
        for (name, key) in roles {
            k[frontier_abi::prologue::position_in(g, n, name, 0).expect("a role of the table")] = *key;
        }
        k
    }

    #[test]
    fn only_the_current_transits_commands_count_so_a_reused_slot_is_not_ambiguous() {
        let season = addrs().season;
        let holding = Address::new_from_array([5; 32]);
        let external = Address::new_from_array([6; 32]);
        let other = Address::new_from_array([9; 32]);
        let roles = |s: Address, h: Address, x: Address| [("season", s), ("holding", h), ("transit", x)];
        let dep = |s, h, x| keys_for(wix::EXPEDITION_DEPART, &roles(s, h, x));
        let rev = |s, h, x| keys_for(wix::REVEAL, &roles(s, h, x));
        let (dk, rk) = (dep(season, holding, external), rev(season, holding, external));
        // three marches of the same slot (fresh seal randomness each): only the
        // CURRENT transit's Depart and Reveal match it, for the 2nd reuse too
        let marches = [sealed_transit(), sealed_transit(), sealed_transit()];
        for (i, (t, _, _)) in marches.iter().enumerate() {
            for (j, (_, d, r)) in marches.iter().enumerate() {
                assert_eq!(depart_matches(d, &dk, t, 0, &season, &holding, &external), i == j, "Depart of march {j} for transit {i}");
                assert_eq!(reveal_matches(r, &rk, t, 0, &season, &holding, &external), i == j, "Reveal of march {j} for transit {i}");
            }
        }
        let (t, d, r) = &marches[2];
        let ok_d = |k: &[Address]| depart_matches(d, k, t, 0, &season, &holding, &external);
        let ok_r = |k: &[Address]| reveal_matches(r, k, t, 0, &season, &holding, &external);
        // every key present but in ANOTHER role (a `contains` check would pass)
        assert!(!ok_d(&dep(holding, season, external)), "season and holding swapped");
        assert!(!ok_d(&dep(season, external, holding)), "holding and transit swapped");
        assert!(!ok_r(&rev(season, external, holding)), "REVEAL holding and transit swapped");
        assert!(!ok_r(&rev(external, holding, season)), "REVEAL season and transit swapped");
        let mut moved = keys_for(wix::EXPEDITION_DEPART, &[("season", season), ("citizen", holding), ("transit", external)]);
        assert!(moved.contains(&holding) && !ok_d(&moved), "the holding only in the citizen role");
        let holding_at = frontier_abi::prologue::position_in(wix::EXPEDITION_DEPART, moved.len(), "holding", 0).unwrap();
        moved[holding_at] = holding;
        assert!(ok_d(&moved), "the same pubkey also in another role does not hide the right one");
        // another Season, holding or transit record in the role
        assert!(!ok_d(&dep(other, holding, external)) && !ok_r(&rev(other, holding, external)), "another Season");
        assert!(!ok_d(&dep(season, other, external)) && !ok_r(&rev(season, other, external)), "another holding");
        assert!(!ok_d(&dep(season, holding, other)) && !ok_r(&rev(season, holding, other)), "another transit record");
        // a list that fits no table length has no roles
        assert!(!ok_d(&dk[..dk.len() - 1]) && !ok_r(&rk[..3]), "a truncated account list");
        // the command's own fields
        assert!(!reveal_matches(r, &rk, t, 1, &season, &holding, &external), "another slot");
        assert!(!depart_matches(&wix::ExpeditionDepart { arrive_bell: t.arrive_bell + 1, ..*d }, &dk, t, 0, &season, &holding, &external), "another arrival");
    }

    fn view(rn: u32, anchor: bool, inputs: Option<Vec<u8>>, arrivals: bool, seed: bool) -> BellView {
        BellView { resolved_next: rn, bell: rn, anchor: anchor.then_some(1_000), inputs, arrivals, seed, missing_anchor: None }
    }
    fn inputs_with(arr: &Arrival, bell: u32, mask: u32) -> Vec<u8> {
        let mut h = WideClashInputsHdr::new(SEASON_ID, arr.dest, bell, [0; 32]);
        h.arrivals_mask = mask;
        let mut d = vec![0u8; wa::wide_clash_inputs::SIZE];
        h.write(&mut d).unwrap();
        d
    }

    /// PURE planning over hand-made views (no chain): which ONE action comes
    /// next. Not evidence that the program accepts it.
    #[test]
    fn quiet_bells_11_and_12_are_resolved_before_the_arrival_bell_13_is_gathered() {
        let arr = arrival_at(Address::new_from_array([0x29; 32]), 13, 8);
        let all = wa::wide_clash_inputs::ALL_GATHERED;
        // bell 11: anchored, window closed, no inputs, no ArrivalDay bit → seed, then a quiet resolve
        assert_eq!(plan(&arr, &view(11, true, None, false, false), true), Ok(Plan::Seed(11)));
        assert_eq!(plan(&arr, &view(11, true, None, false, true), true), Ok(Plan::Resolve { bell: 11, quiet: true }));
        // bell 12 likewise (the cursor moved by the landed Resolve, never by a write)
        assert_eq!(plan(&arr, &view(12, true, None, false, false), true), Ok(Plan::Seed(12)));
        assert_eq!(plan(&arr, &view(12, true, None, false, true), true), Ok(Plan::Resolve { bell: 12, quiet: true }));
        // bell 13 is the arrival: gathered from position 0 even before a ClashInputs exists
        assert_eq!(plan(&arr, &view(13, true, None, false, false), true), Ok(Plan::Gather { bell: 13, start: 0 }));
        // a partially gathered record continues at its next position
        assert_eq!(plan(&arr, &view(13, true, Some(inputs_with(&arr, 13, mask_through(7))), true, false), true), Ok(Plan::Gather { bell: 13, start: 7 }));
        assert_eq!(plan(&arr, &view(13, true, Some(inputs_with(&arr, 13, all)), true, false), true), Ok(Plan::Seed(13)));
        assert_eq!(plan(&arr, &view(13, true, Some(inputs_with(&arr, 13, all)), true, true), true), Ok(Plan::Resolve { bell: 13, quiet: false }));
        // resolved past the arrival: the settlement step
        assert_eq!(plan(&arr, &BellView { resolved_next: 14, bell: 13, ..view(13, true, None, true, true) }, true), Ok(Plan::Settle));
        // waits: the bell has not ended / its reveal window is open
        assert_eq!(plan(&arr, &view(11, false, None, false, false), false), Ok(Plan::WaitEnded(11)));
        assert_eq!(plan(&arr, &view(11, true, None, false, false), false), Ok(Plan::WaitWindow(11)));
        // a missing anchor comes before everything, the settlement included
        assert_eq!(plan(&arr, &BellView { missing_anchor: Some(12), ..view(11, true, None, false, true) }, true), Ok(Plan::Anchor(12)));
        assert_eq!(plan(&arr, &BellView { missing_anchor: Some(13), resolved_next: 14, ..view(13, true, None, true, true) }, true), Ok(Plan::Anchor(13)));
        // an unreadable ClashInputs stops (never treated as empty)
        assert!(plan(&arr, &view(13, true, Some(vec![0; 8]), true, false), true).is_err());
    }

    #[test]
    fn an_earlier_bell_with_arrivals_is_gathered_and_resolved_as_a_contested_bell() {
        let arr = arrival_at(Address::new_from_array([0x29; 32]), 13, 8);
        let all = wa::wide_clash_inputs::ALL_GATHERED;
        // bell 11 has someone else's ArrivalDay bit but no ClashInputs yet
        assert_eq!(plan(&arr, &view(11, true, None, true, false), true), Ok(Plan::Gather { bell: 11, start: 0 }));
        // or a ClashInputs without the bit being read: still gathered, never quiet
        assert_eq!(plan(&arr, &view(11, true, Some(inputs_with(&arr, 11, mask_through(3))), false, false), true), Ok(Plan::Gather { bell: 11, start: 3 }));
        assert_eq!(plan(&arr, &view(11, true, Some(inputs_with(&arr, 11, all)), true, false), true), Ok(Plan::Seed(11)));
        assert_eq!(plan(&arr, &view(11, true, Some(inputs_with(&arr, 11, all)), true, true), true), Ok(Plan::Resolve { bell: 11, quiet: false }));
        // then the quiet bell 12 and the arrival 13 as before
        assert_eq!(plan(&arr, &view(12, true, None, false, true), true), Ok(Plan::Resolve { bell: 12, quiet: true }));
        assert_eq!(plan(&arr, &view(13, true, None, false, false), true), Ok(Plan::Gather { bell: 13, start: 0 }));
    }

    #[test]
    fn the_seasons_end_bell_bounds_the_arrival_before_any_fetch_or_post() {
        use frontier_abi::v2::layout::world::season as S;
        assert!(check_end_bell(99, 100).is_ok());
        assert!(check_end_bell(100, 100).unwrap_err().contains("end bell"));
        assert!(check_end_bell(101, 100).is_err());
        let a = addrs();
        let (c, key) = chain_with_dest(11);
        let d = c.account(&a.season).unwrap().data;
        let end = u32::from_le_bytes(d[S::END_BELL..S::END_BELL + 4].try_into().unwrap());
        assert!(end > 12, "the installed Season ends after bell 12");
        // no anchor exists, so a view would otherwise ask for one (an Anchor plan → a round fetch)
        let e = bell_view(&c, &a, &arrival_at(key, end, 8), end + 5).unwrap_err();
        assert!(e.contains("end bell") && e.contains("nothing posted"), "{e}");
        assert!(bell_view(&c, &a, &arrival_at(key, end + 40, 8), end + 50).is_err());
        // the last bell before the end is still driven (its missing anchor first)
        let (c2, key2) = chain_with_dest(end - 10);
        assert_eq!(bell_view(&c2, &a, &arrival_at(key2, end - 1, 8), end).unwrap().missing_anchor, Some(end - 10));
        // the end bell is checked before the catch-up cap (11 → end is both)
        assert!(bell_view(&c, &a, &arrival_at(key, end, 8), end).unwrap_err().contains("end bell"));
    }

    fn arrival_at(dest_key: Address, arrive: u32, region: u8) -> Arrival {
        let (t, d, _) = sealed_transit();
        Arrival { transit_slot: 0, external: Address::new_from_array([6; 32]), host: t.host, faction: 2, arrive,
            dest: t.dest.unwrap_or_else(|| ProvinceKey::new(t.host.key().world(), frontier_abi::world_index::WideCoord::checked(129, 0).unwrap())),
            dest_key, region, position: 9, slot: Address::new_from_array([8; 32]), commit: d.commit, seal: d.seal }
    }

    fn chain_with_dest(rn: u32) -> (Chain, Address) {
        use frontier_abi::v2::layout::province::province as PV;
        let mut c = Chain::new(localnet::Config::default());
        c.produce_block();
        crate::expedition_play::Base::new(c.unix_timestamp()).unwrap().install(&mut c).unwrap();
        let key = Address::new_from_array([0x29; 32]);
        let mut d = vec![0u8; PV::RESOLVED_NEXT + 64];
        d[PV::RESOLVED_NEXT..PV::RESOLVED_NEXT + 4].copy_from_slice(&rn.to_le_bytes());
        c.set_account(key, fclient::ports::Account { lamports: 1_000_000, data: d, owner: Address::new_from_array(PROGRAM), executable: false }).unwrap();
        (c, key)
    }
    fn put_anchor(c: &mut Chain, a: &Addresses, bell: u32, region: u8, owner: Address) {
        use frontier_abi::layout::beacon::bell_anchor as BA;
        use frontier_abi::v2::layout::{write_header, AccountKind as K2};
        let mut d = vec![0u8; K2::BellAnchor.size()];
        assert!(write_header(&mut d, K2::BellAnchor, SEASON_ID));
        d[BA::BELL..BA::BELL + 4].copy_from_slice(&bell.to_le_bytes());
        d[BA::REGION] = region;
        c.set_account(a.anchor(bell, region), fclient::ports::Account { lamports: 1_000_000, data: d, owner, executable: false }).unwrap();
    }

    #[test]
    fn the_destination_is_caught_up_bell_by_bell_before_the_arrival() {
        let a = addrs();
        let program = Address::new_from_array(PROGRAM);
        // a newly opened 129 (resolved_next 11), an arrival at bell 20, the chain at bell 21
        let (mut c, key) = chain_with_dest(11);
        let arr = arrival_at(key, 20, 8);
        let v = bell_view(&c, &a, &arr, 21).unwrap();
        assert_eq!((v.resolved_next, v.bell, v.missing_anchor, v.anchor, v.arrivals, v.seed, v.inputs.is_some()), (11, 11, Some(11), None, false, false, false),
            "the oldest unresolved bell first, its anchor posted before anything else");
        // anchors of 11..=20 in region 8 (identity-checked): the cursor stays on 11, a quiet bell
        for b in 11..=20 {
            put_anchor(&mut c, &a, b, 8, program);
        }
        let v = bell_view(&c, &a, &arr, 21).unwrap();
        assert_eq!((v.bell, v.missing_anchor, v.arrivals, v.inputs.is_some()), (11, None, false, false));
        assert!(v.anchor.is_some());
        // only ended bells are anchored: at bell 15, bells 15.. are not asked for
        let (mut c2, key2) = chain_with_dest(11);
        for b in 11..15 {
            put_anchor(&mut c2, &a, b, 8, program);
        }
        assert_eq!(bell_view(&c2, &a, &arrival_at(key2, 20, 8), 15).unwrap().missing_anchor, None);
        // a foreign account at an anchor address stops (never counted as anchored)
        put_anchor(&mut c2, &a, 12, 8, Address::new_from_array([9; 32]));
        assert!(bell_view(&c2, &a, &arrival_at(key2, 20, 8), 15).is_err());
        // too far behind: not driven
        let (c3, key3) = chain_with_dest(11);
        assert!(bell_view(&c3, &a, &arrival_at(key3, 11 + MAX_CATCH_UP_BELLS + 1, 8), 400).unwrap_err().contains("bells behind"));
        // exactly the cap is still driven
        assert!(bell_view(&c3, &a, &arrival_at(key3, 11 + MAX_CATCH_UP_BELLS, 8), 400).is_ok());
        // resolved past the arrival: only the settlement remains
        let (c4, key4) = chain_with_dest(21);
        let v = bell_view(&c4, &a, &arrival_at(key4, 20, 8), 30).unwrap();
        assert_eq!((v.resolved_next, v.bell, v.missing_anchor), (21, 20, None));
        // the resolve of the cursor bell names THAT bell's anchor, seed and inputs
        let ix = resolve_ix(&a, &Address::new_from_array([1; 32]), &arr, 11);
        assert_eq!(ix.accounts[4].pubkey, a.seed_cache(11, 8, 0));
        assert_eq!(ix.accounts[5].pubkey, a.anchor(11, 8));
        assert!(matches!(wix::WideCommand::decode(&ix.data), Ok(wix::WideCommand::Resolve(x)) if x.bell == 11));
    }

    #[test]
    fn gather_cursors_and_settlement_decisions() {
        assert_eq!(next_position(0), Some(0));
        assert_eq!(next_position(mask_through(5)), Some(5));
        assert_eq!(next_position(wa::wide_clash_inputs::ALL_GATHERED), None);
        let ctx = ctx_of(&addrs());
        let dest = ProvinceKey::new(frontier_abi::world_index::WorldId::derive_legacy_season(&ctx.season, &ctx.program).unwrap(), WideCoord::checked(129, 0).unwrap());
        let mut h = WideClashInputsHdr::new(SEASON_ID, dest, 20, [0; 32]);
        let (_, d, _) = sealed_transit();
        let host = WideHostRef::from_bytes(&d.host).unwrap();
        let row = |fate: u8| WideArrival { host, citizen: [1; 32], dep_mass: 1, troops: 10, stamina: 1, retreat_bps: 0, dealt_bps: 0, faction: 2, unit: 2,
            tile: 30, stance: 0, present: true, fate, troops_after: 5 };
        assert!(matches!(settle_decision(&h, Some(&row(1)), 9, 100, 50), Settle::Wait(_)), "not resolved");
        h.flags |= wa::wide_clash_inputs::FLAG_RESOLVED;
        assert_eq!(settle_decision(&h, Some(&row(wa::wide_arrival::FATE_STAYS)), 9, 100, 50), Settle::Member);
        assert_eq!(settle_decision(&h, Some(&row(wa::wide_arrival::FATE_RETREATED)), 9, 100, 50), Settle::Member);
        assert!(matches!(settle_decision(&h, Some(&row(wa::wide_arrival::FATE_STAYS)), 9, 10, 50), Settle::Wait(_)), "too early");
        // every fate the program's member settlement accepts (1..=5), once open
        for f in [wa::wide_arrival::FATE_DESTROYED, wa::wide_arrival::FATE_WITHDREW, wa::wide_arrival::FATE_BOUNCED] {
            assert_eq!(settle_decision(&h, Some(&row(f)), 9, 100, 50), Settle::Member, "fate {f}");
            assert!(matches!(settle_decision(&h, Some(&row(f)), 9, 10, 50), Settle::Wait(_)), "fate {f} too early");
        }
        // not a member path: no fate, a fate past the range, an absent row, the camp's winner
        assert_eq!(settle_decision(&h, Some(&row(wa::wide_arrival::FATE_NONE)), 9, 100, 50), Settle::Unsupported(wa::wide_arrival::FATE_NONE));
        assert_eq!(settle_decision(&h, Some(&row(6)), 9, 100, 50), Settle::Unsupported(6));
        assert_eq!(settle_decision(&h, Some(&WideArrival { present: false, ..row(wa::wide_arrival::FATE_DESTROYED) }), 9, 100, 50),
            Settle::Unsupported(wa::wide_arrival::FATE_DESTROYED));
        let camp = WideClashInputsHdr { camp_mask: 1 << 9, ..h };
        assert_eq!(settle_decision(&camp, Some(&row(wa::wide_arrival::FATE_STAYS)), 9, 100, 50), Settle::Unsupported(wa::wide_arrival::FATE_STAYS),
            "the camp's winner is SettleCamp's");
        assert_eq!(settle_decision(&camp, Some(&row(wa::wide_arrival::FATE_DESTROYED)), 9, 100, 50), Settle::Member, "only a staying winner is the camp's");
        let lower = WideClashInputsHdr { camp_mask: (1 << 3) | (1 << 9), ..h };
        assert_eq!(settle_decision(&lower, Some(&row(wa::wide_arrival::FATE_STAYS)), 9, 100, 50), Settle::Member, "a lower position won the camp");
        assert_eq!(settle_decision(&h, None, 9, 100, 50), Settle::Unsupported(wa::wide_arrival::FATE_NONE));
        h.settled_mask |= 1 << 9;
        assert_eq!(settle_decision(&h, Some(&row(wa::wide_arrival::FATE_STAYS)), 9, 100, 50), Settle::Done);
    }

    /// The member settlement's shape against the abi's SETTLE_MEMBER table
    /// (Current layout, 14): each role's key in order, a signer exactly where
    /// the table has one, writable wherever it says W; an executable role is
    /// named before any simulation (the program's `snapshots` refuses it).
    /// Account shape only: not evidence the program accepts the settlement.
    #[test]
    fn the_member_settlement_has_the_settle_member_tables_shape() {
        use expedition_settlement_ix::AccountLayout;
        let a = addrs();
        let k = |b: u8| Address::new_from_array([b; 32]);
        let arr = arrival_at(k(0x29), 20, 8);
        let (payer, holding, home, rent_to, slot_ben, resolver, rent_payer) = (k(0x51), k(0x52), k(0x53), k(0x54), k(0x55), k(0x56), k(0x57));
        let ix = settle_member_ix(&a, &payer, &arr, &holding, &home, &rent_to, &slot_ben, &resolver, &rent_payer).unwrap();
        let layout = AccountLayout::from_count(ix.accounts.len()).unwrap();
        assert_eq!(layout, AccountLayout::Current);
        let ctx = ctx_of(&a);
        let want: [(&str, Address); 14] = [
            ("season", a.season), ("holding", holding), ("external", arr.external), ("home", home), ("destination", arr.dest_key),
            ("inputs", Address::new_from_array(clash_inputs_address(&ctx, arr.dest, arr.arrive))), ("slot", arr.slot), ("external_rent_to", rent_to),
            ("anchor_or_archive", a.anchor(arr.arrive, arr.region)), ("payer", payer), ("slot_beneficiary", slot_ben), ("resolver", resolver),
            ("holding_rent_payer", rent_payer), ("settle_beneficiary", payer),
        ];
        for (i, (m, (name, key))) in ix.accounts.iter().zip(want).enumerate() {
            let spec = layout.spec(i).unwrap();
            assert_eq!((spec.name, m.pubkey), (name, key), "role {i}");
            assert_eq!(m.is_signer, spec.signer, "role {i} ({name}) signer");
            if spec.wr == frontier_abi::prologue::Wr::W {
                assert!(m.is_writable, "role {i} ({name}) must be writable");
            }
        }
        // the payer aliases only roles the program lets it alias
        assert!(layout.roles_may_alias(9, 13), "payer = settle beneficiary");
        // a zero rent payer is the executable System Program: named, not sent
        let mut c = Chain::new(localnet::Config::default());
        c.produce_block();
        // an executable account the node itself holds (its builtin programs;
        // the node refuses to create a synthetic executable account): the
        // zero key (an unset RENT_PAYER = the System Program) first
        let builtins = ["11111111111111111111111111111111", "BPFLoaderUpgradeab1e11111111111111111111111", "ComputeBudget111111111111111111111111111111",
            "NativeLoader1111111111111111111111111111111"];
        let exe = builtins.iter().map(|s| s.parse::<Address>().unwrap()).find(|k| c.account(k).is_some_and(|x| x.executable))
            .expect("the node holds an executable builtin account");
        let bad = settle_member_ix(&a, &payer, &arr, &holding, &home, &rent_to, &slot_ben, &resolver, &exe).unwrap();
        assert_eq!(executable_role(&c, &bad), Some((12, exe)));
        assert_eq!(layout.spec(12).unwrap().name, "holding_rent_payer");
        assert_eq!(executable_role(&c, &ix), None);
    }

    /// A completed settlement carries the fate; only Stays is an arrival that
    /// stays (a declaration may follow); a destroyed or departed host never is.
    #[test]
    fn a_completed_settlement_is_an_arrival_that_stays_only_for_stays() {
        use wa::wide_arrival as F;
        assert!(Step::Settled { fate: F::FATE_STAYS }.arrival_stays());
        for fate in [F::FATE_DESTROYED, F::FATE_WITHDREW, F::FATE_BOUNCED, F::FATE_RETREATED, F::FATE_NONE, 6] {
            assert!(!Step::Settled { fate }.arrival_stays(), "fate {fate}");
        }
        assert!(!Step::Landed("SettleMember(transit 0)".into(), "s".into()).arrival_stays());
        assert!(!Step::Wait("w".into()).arrival_stays() && !Step::Stopped("x".into()).arrival_stays());
        // the status string names the fate (the Pilot's `destination_step`)
        assert_eq!(format!("{:?}", Step::Settled { fate: F::FATE_DESTROYED }), "Settled { fate: 5 }");
    }

    #[test]
    fn no_transit_means_no_arrival_and_nothing_is_sent() {
        let mut c = Chain::new(localnet::Config::default());
        c.produce_block();
        crate::expedition_play::Base::new(c.unix_timestamp()).unwrap().install(&mut c).unwrap();
        assert_eq!(find_arrival(&c, &addrs(), &Address::new_from_array([5; 32]), 0), Ok(None));
    }
}
