//! **TEST-ONLY wide → wide marches in a local wide world** (Q-W2, owner t385u 2026-11-19 22:32 JST 「おすすめで」:
//! open wide-land interior marches and wide keep capture in LOCAL TEST only; devnet unchanged until r0ze plays it).
//!
//! The local land `.so` is built with `localnet-wide-depart` (permutation-frontier/Cargo.toml, inside
//! `localnet-land-sbf` only), which opens WideDepart's debit gate (`proc::wide::DEPART_DEBIT_ENABLED`). This module is
//! the world's class-D crank for everything after a player's signed WideMuster / WideDepart, with the program's own
//! permissionless instructions only, at most one transaction per lane per round:
//!
//! * **the wide bells** of every wide province that needs them — one where a host stands (its WideRoster exists),
//!   one with revealed arrivals (a WideArrivalDay), and the origin of a live march: `PostAnchor` of each ended bell in
//!   its region (a public Quicknet round, BLS-verified by the program), once the bell's reveal window closed WideGather
//!   (0xDC op 4) of an arrival bell's 24 positions, `PostSeed`, then WideResolve (0xDC op 1) of `resolved_next`. Every
//!   bell of a wide province is a real resolve (no SkipQuiet), so the keep contest of `keep::advance` runs bell by
//!   bell: a foreign host standing on the keep tile for the Season's `keep_bells` takes the keep (KEEP_TAKEN).
//! * **each wide march** (a wide transit record of a wide holding): WideSettleDeparture (0xDC op 3) once the origin
//!   resolved the departure bell; WideReveal (0xEE) from the PUBLIC round `T(arrive)` (the seal is IBE-sealed to it:
//!   the plaintext and the salt `salt_of(k)` are what anyone holding the round recovers — the same self-reveal as the
//!   expedition's `destination_driver::SELF_REVEAL`) into the first free ArrivalSlot of the host's nation; and
//!   WideSettleTransit (0xDC op 5) once the destination resolved the arrival bell and the settle delay passed — the
//!   on-chain verdict over the seal (`crypto::seal::judge_wide` behind the chain's BLS syscall).
//!
//! A province an EXPEDITION arrival is still pending in (an expedition ArrivalSlot at or after its cursor) is left to
//! the expedition's `destination_driver` (no two resolvers on one cursor). Every send is simulated first; a refusal is
//! logged and the lane backs off (a crank, not a one-shot driver: the next round re-reads the chain). Nothing is
//! written directly; no fight, arrival or verdict is synthesized. Every line printed says `test_only: true`.
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::time::{Duration, Instant};

use fclient::addr::Addresses;
use fclient::ix::{post_seed, BeaconArg};
use fclient::{AccountMeta, Address, Instruction, Keypair, Signer};
use frontier_abi::addr::{archive_part_of, day_of, AddrCtx};
use frontier_abi::world_index::{
    arrival::{
        arrival_day_address, arrival_slot_address, clash_inputs_address, WideArrival,
        WideArrivalDay, WideArrivalSlot, WideClashInputsHdr,
    },
    expedition_transport::ArrivalSlot,
    holding::{holding_address, WideHolding},
    land::{province_address, WideProvince},
    march::{transit_address, MarchState, WideTransit, WIDE_TRANSIT_LEN},
    roster::{roster_address, WideRoster},
    seal::{self as wseal, WIDE_PLAIN_LEN, WIDE_SEAL_LEN},
    tiles::WideTile,
    wide_ix as wix, ProvinceKey,
};
use localnet::server::{lock, Shared};
use localnet::Chain;
use serde_json::{json, Value};

use crate::local_keeper as lk;

pub const WIDE_DEPART_SCHEMA: &str = "frontier-localnet-wide-depart-v1";
/// `transit::SETTLE_AFTER_CLOSE_SECS` (the program's settlement delay after the reveal window's close).
pub const SETTLE_AFTER_CLOSE_SECS: i64 = 600;
/// The most lanes sent in one round (each one transaction).
pub const MAX_BATCH: usize = 24;
/// A refused lane waits this long (wall time) before it is planned again.
pub const BACKOFF: Duration = Duration::from_secs(4);
/// The most rounds fetched in one call (`lk::fetch_rounds`' bound).
const ROUNDS_PER_FETCH: u32 = 16;

fn ctx_of(a: &Addresses) -> AddrCtx {
    AddrCtx {
        program: a.program.to_bytes(),
        season: a.season.to_bytes(),
    }
}
fn addr(b: [u8; 32]) -> Address {
    Address::new_from_array(b)
}
fn u32_at(d: &[u8], o: usize) -> Option<u32> {
    Some(u32::from_le_bytes(d.get(o..o + 4)?.try_into().ok()?))
}

/// A wide province of this Season, read with its identity checked.
#[derive(Clone, Debug)]
pub struct Prov {
    pub key: Address,
    pub pk: ProvinceKey,
    pub region: u8,
    pub rn: u32,
    pub data: Vec<u8>,
}

/// A wide march: the wide transit record of a WIDE holding (a native march, not an expedition bridge).
#[derive(Clone, Debug)]
pub struct March {
    pub holding: Address,
    pub h: WideHolding,
    pub slot: u8,
    pub key: Address,
    pub t: WideTransit,
}

/// What one scan of the program's accounts says.
#[derive(Clone, Debug, Default)]
pub struct Scan {
    pub provs: BTreeMap<ProvinceKey, Prov>,
    /// Provinces whose bells this crank drives.
    pub drive: BTreeSet<ProvinceKey>,
    /// Provinces with a pending expedition arrival (left to the expedition's destination driver).
    pub expedition: BTreeSet<ProvinceKey>,
    pub marches: Vec<March>,
}

/// Reads every program account once (module doc for what counts).
pub fn scan(c: &Chain, a: &Addresses) -> Scan {
    let ctx = ctx_of(a);
    let accounts = c.program_accounts(&a.program);
    let mut s = Scan::default();
    let mut rosters = vec![];
    let mut days = vec![];
    let mut exp_slots = vec![];
    let mut transits = vec![];
    let mut holdings = vec![];
    for (k, acc) in &accounts {
        let d = &acc.data;
        if let Ok(p) = WideProvince::read(d) {
            if p.season_id != a.season_id || *k != addr(province_address(&ctx, p.coord)) {
                continue;
            }
            let pk = ProvinceKey::new(p.world, p.coord);
            let rn = u32_at(
                d,
                frontier_abi::v2::layout::province::province::RESOLVED_NEXT,
            )
            .unwrap_or(0);
            s.provs.insert(
                pk,
                Prov {
                    key: *k,
                    pk,
                    region: p.region,
                    rn,
                    data: d.clone(),
                },
            );
        } else if let Ok(r) = WideRoster::read(d) {
            if r.season_id == a.season_id && *k == addr(roster_address(&ctx, r.province)) {
                rosters.push(r.province);
            }
        } else if let Ok(day) = WideArrivalDay::read(d) {
            if day.season_id == a.season_id {
                days.push(day);
            }
        } else if let Ok(slot) = ArrivalSlot::read(&ctx, d) {
            // (an ArrivalSlot is as long as a wide transit record: read it first, by its own family version)
            if let ArrivalSlot::Expedition(e) = slot {
                exp_slots.push(*e.common());
            }
        } else if d.len() == WIDE_TRANSIT_LEN {
            if let Ok(t) = WideTransit::from_bytes(d) {
                transits.push((*k, t));
            }
        } else if let Ok(h) = WideHolding::read(d) {
            if h.season_id == a.season_id {
                holdings.push(ProvinceKey::new(h.world, h.coord));
            }
        }
    }
    for (k, t) in transits {
        if t.state == MarchState::Free || t.host.key().coord().ring() < 129 {
            continue;
        }
        let holding = addr(holding_address(&ctx, t.host.key().coord(), t.host.site()));
        let Some(slot) =
            (0..4u8).find(|i| addr(transit_address(&ctx, &holding.to_bytes(), *i)) == k)
        else {
            continue;
        };
        let Some(h) = c
            .account(&holding)
            .filter(|x| x.owner == a.program)
            .and_then(|x| WideHolding::read(&x.data).ok())
        else {
            continue;
        };
        s.marches.push(March {
            holding,
            h,
            slot,
            key: k,
            t,
        });
    }
    for e in exp_slots {
        if s.provs.get(&e.dest).is_some_and(|p| e.bell >= p.rn) {
            s.expedition.insert(e.dest);
        }
    }
    // (a wide village's own province: its first muster needs the province resolved to the turn before)
    let mut want: BTreeSet<ProvinceKey> = rosters.into_iter().chain(holdings).collect();
    for d in days {
        if let Some(p) = s.provs.get(&d.dest) {
            let first = d.day.saturating_mul(144);
            if (first..first + 144).any(|b| b >= p.rn && d.has(b)) {
                want.insert(d.dest);
            }
        }
    }
    for m in &s.marches {
        want.insert(m.t.origin.key());
    }
    s.drive = want
        .into_iter()
        .filter(|k| s.provs.contains_key(k) && !s.expedition.contains(k))
        .collect();
    s
}

/// One transaction this crank may send.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Act {
    Anchor {
        bell: u32,
        region: u8,
    },
    Seed {
        bell: u32,
        region: u8,
        anchor_ts: i64,
    },
    Gather {
        dest: ProvinceKey,
        bell: u32,
        start: u8,
    },
    Resolve {
        dest: ProvinceKey,
        bell: u32,
    },
    SettleDeparture {
        march: usize,
    },
    Reveal {
        march: usize,
    },
    SettleTransit {
        march: usize,
    },
}

impl Act {
    /// The lane: two acts of one lane are never sent in one round.
    pub fn lane(&self, s: &Scan) -> String {
        match self {
            Act::Anchor { bell, region } => format!("anchor:{bell}:{region}"),
            Act::Seed { bell, region, .. } => format!("seed:{bell}:{region}"),
            Act::Gather { dest, .. } | Act::Resolve { dest, .. } => {
                format!("prov:{},{}", dest.coord().p(), dest.coord().q())
            }
            Act::SettleDeparture { march }
            | Act::Reveal { march }
            | Act::SettleTransit { march } => {
                let m = &s.marches[*march];
                // a march's settle and its origin's resolve never share a round
                format!(
                    "prov:{},{}",
                    m.t.origin.key().coord().p(),
                    m.t.origin.key().coord().q()
                )
            }
        }
    }
}

/// The clock facts one round reads.
#[derive(Clone, Copy, Debug)]
pub struct Now {
    pub ts: i64,
    pub bell: u32,
    pub end_bell: u32,
}

fn clash_header(
    c: &Chain,
    a: &Addresses,
    dest: ProvinceKey,
    bell: u32,
) -> Result<Option<WideClashInputsHdr>, String> {
    let k = addr(clash_inputs_address(&ctx_of(a), dest, bell));
    match c.account(&k) {
        None => Ok(None),
        Some(x) if x.owner == a.program => {
            let h = WideClashInputsHdr::read(&x.data).map_err(|e| format!("ClashInputs: {e:?}"))?;
            if h.season_id != a.season_id || h.dest != dest || h.bell != bell {
                return Err("the ClashInputs is not this province's bell".into());
            }
            Ok(Some(h))
        }
        Some(_) => Err("the ClashInputs is not the program's".into()),
    }
}

fn arrival_bit(c: &Chain, a: &Addresses, dest: ProvinceKey, bell: u32) -> bool {
    let k = addr(arrival_day_address(&ctx_of(a), dest, day_of(bell)));
    c.account(&k)
        .filter(|x| x.owner == a.program)
        .and_then(|x| WideArrivalDay::read(&x.data).ok())
        .is_some_and(|d| d.season_id == a.season_id && d.dest == dest && d.has(bell))
}

/// The next act of one driven province (pure over the chain): the module doc's order.
pub fn province_act(
    c: &Chain,
    a: &Addresses,
    clock: &fclient::clock::SeasonClock,
    p: &Prov,
    now: Now,
) -> Result<Option<Act>, String> {
    let b = p.rn;
    if b >= now.end_bell || b >= now.bell {
        return Ok(None);
    }
    let Some(a_ts) = lk::anchor_landed(c, a, b, p.region)? else {
        return Ok(Some(Act::Anchor {
            bell: b,
            region: p.region,
        }));
    };
    if now.ts < clock.reveal_close(b, a_ts) {
        return Ok(None);
    }
    let header = clash_header(c, a, p.pk, b)?;
    if header.is_some() || arrival_bit(c, a, p.pk, b) {
        // (an expedition's arrival in this bell: the expedition's destination driver gathers and resolves it)
        let ctx = ctx_of(a);
        for k in 0..wix::GATHER_POSITIONS {
            if let Some(x) = c.account(&addr(arrival_slot_address(&ctx, p.pk, b, k / 4, k % 4))) {
                if matches!(
                    ArrivalSlot::read(&ctx, &x.data),
                    Ok(ArrivalSlot::Expedition(_))
                ) {
                    return Ok(None);
                }
            }
        }
        let mask = header.map_or(0, |h| h.arrivals_mask);
        if let Some(start) = (0..wix::GATHER_POSITIONS).find(|k| mask & (1 << k) == 0) {
            return Ok(Some(Act::Gather {
                dest: p.pk,
                bell: b,
                start,
            }));
        }
    }
    if c.account(&a.seed_cache(b, p.region, 0)).is_none() {
        return Ok(Some(Act::Seed {
            bell: b,
            region: p.region,
            anchor_ts: a_ts,
        }));
    }
    match crate::resident_bells::conquest_of(c, a, p.pk, &p.data)? {
        crate::resident_bells::Conquest::None => Ok(Some(Act::Resolve {
            dest: p.pk,
            bell: b,
        })),
        other => Err(format!(
            "bell {b}: conquest state {other:?}: a plain Resolve is not sent"
        )),
    }
}

/// The most ended bells past a province's cursor whose anchor and seed are posted ahead (their windows then close in
/// parallel and the catch-up resolves about one bell per round).
pub const LEAD_BELLS: u32 = 8;

/// The anchors and seeds of the ended bells `rn + 1 ..= rn + LEAD_BELLS` (below `now.bell` and the end) that are
/// missing: an anchor first, a seed once the bell's window closed (never for a bell with arrivals, whose gather comes
/// first). Pure over the chain.
pub fn lead_acts(
    c: &Chain,
    a: &Addresses,
    clock: &fclient::clock::SeasonClock,
    p: &Prov,
    now: Now,
) -> Result<Vec<Act>, String> {
    let mut out = vec![];
    let last = now
        .bell
        .saturating_sub(1)
        .min(now.end_bell.saturating_sub(1))
        .min(p.rn.saturating_add(LEAD_BELLS));
    for b in p.rn.saturating_add(1)..=last {
        match lk::anchor_landed(c, a, b, p.region)? {
            None => out.push(Act::Anchor {
                bell: b,
                region: p.region,
            }),
            Some(a_ts) => {
                if now.ts >= clock.reveal_close(b, a_ts)
                    && c.account(&a.seed_cache(b, p.region, 0)).is_none()
                    && clash_header(c, a, p.pk, b)?.is_none()
                    && !arrival_bit(c, a, p.pk, b)
                {
                    out.push(Act::Seed {
                        bell: b,
                        region: p.region,
                        anchor_ts: a_ts,
                    });
                }
            }
        }
    }
    Ok(out)
}

/// The landed raw WideDepart (0xDA) of this march, matched by its seal root, host, arrival and slot.
pub fn landed_depart(c: &Chain, a: &Addresses, m: &March) -> Result<Option<wix::Depart>, String> {
    let mut found: Option<wix::Depart> = None;
    for l in c.signatures_for(&m.key, 256, None, None) {
        if l.err.is_some() {
            continue;
        }
        let t = fclient::tx::from_wire(&l.wire)?;
        let keys = &t.message.account_keys;
        for ix in &t.message.instructions {
            if keys.get(ix.program_id_index as usize) != Some(&a.program)
                || ix.data.first() != Some(&wix::Depart::IX.tag())
            {
                continue;
            }
            let Ok(d) = wix::Depart::decode(&ix.data) else {
                continue;
            };
            if d.transit_slot == m.slot
                && d.host == m.t.host.to_bytes()
                && d.arrive_bell == m.t.arrive_bell
                && wseal::seal_root(&d.commit, &wseal::ct_hash(&d.seal)) == m.t.seal_root
            {
                if found.is_some_and(|x| x != d) {
                    return Err("two different landed Departs match this march".into());
                }
                found = Some(d);
            }
        }
    }
    Ok(found)
}

/// A march's seal opened with the public round `T(arrive)`.
#[derive(Clone, Debug)]
pub struct Opened {
    pub plain: [u8; WIDE_PLAIN_LEN],
    pub salt: [u8; 32],
    pub ct_hash: [u8; 32],
    pub dest: ProvinceKey,
    /// The provinces the walk enters other than the destination, first-entered order.
    pub path: Vec<ProvinceKey>,
}

/// Opens `(commit, seal)` with the public signature `sig48` of `T(arrive)` (pure): the stock IBE opener, the ABI's
/// body under the commitment, `unpack` / `validate` against the march, the committed walk from the origin tile.
pub fn open_seal(
    t: &WideTransit,
    commit: &[u8; 32],
    seal: &[u8; WIDE_SEAL_LEN],
    sig48: &[u8; 48],
) -> Result<Opened, String> {
    use permutation_rules::frontier::seal as ks;
    let mut k = fclient::seal::open_ibe(&wseal::ibe_block(seal), sig48)
        .map_err(|e| format!("the seal does not open: {e:?}"))?;
    let plain = wseal::open_body(&k, seal, commit);
    let salt = ks::salt_of(&k);
    k.fill(0);
    let plain = plain.ok_or("the opened body does not match the Depart's commitment")?;
    let pt = wseal::unpack(&plain).map_err(|e| format!("plaintext: {e:?}"))?;
    wseal::validate(&pt, &t.host, t.arrive_bell).map_err(|e| format!("plaintext: {e:?}"))?;
    let mut at = WideTile::of(t.origin);
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
    Ok(Opened {
        plain,
        salt,
        ct_hash: wseal::ct_hash(seal),
        dest: pt.dest,
        path,
    })
}

/// WideSettleDeparture (0xDC op 3, `wide_ix::SETTLE_DEPARTURE`).
pub fn settle_departure_ix(a: &Addresses, payer: &Address, m: &March) -> Instruction {
    let ctx = ctx_of(a);
    let origin = m.t.origin.key();
    Instruction {
        program_id: a.program,
        data: wix::SettleDeparture {
            host: m.t.host.to_bytes(),
            transit_slot: m.slot,
        }
        .to_bytes()
        .to_vec(),
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(a.season, false),
            AccountMeta::new(addr(province_address(&ctx, origin.coord())), false),
            AccountMeta::new(m.holding, false),
            AccountMeta::new(addr(roster_address(&ctx, origin)), false),
            AccountMeta::new(m.key, false),
        ],
    }
}

/// The first free ArrivalSlot position of `faction` at `(dest, bell)` (0–3), `None` when all four are taken.
pub fn free_target(
    c: &Chain,
    a: &Addresses,
    dest: ProvinceKey,
    bell: u32,
    faction: u8,
) -> Option<u8> {
    let ctx = ctx_of(a);
    (0..4u8).find(|i| {
        c.account(&addr(arrival_slot_address(&ctx, dest, bell, faction, *i)))
            .is_none()
    })
}

/// WideReveal (0xEE, `wide_ix::REVEAL`): the sixteen accounts then the path provinces, paid by `payer` (the
/// beneficiary). Writable: the payer, the ArrivalDay, the target slot.
pub fn reveal_ix(
    a: &Addresses,
    payer: &Address,
    m: &March,
    o: &Opened,
    region: u8,
    target: u8,
) -> Result<Instruction, String> {
    let ctx = ctx_of(a);
    let (dest, arrive) = (o.dest, m.t.arrive_bell);
    let data = wix::Reveal {
        transit_slot: m.slot,
        target_i: target,
        plain: o.plain,
        salt: o.salt,
        ct_hash: o.ct_hash,
        beneficiary: payer.to_bytes(),
    }
    .to_bytes()
    .to_vec();
    let mut acc = vec![
        AccountMeta::new(*payer, true),
        AccountMeta::new_readonly(a.season, false),
        AccountMeta::new_readonly(m.holding, false),
        AccountMeta::new_readonly(m.key, false),
        AccountMeta::new_readonly(addr(ctx.bell_anchor(arrive, region)), false),
        AccountMeta::new_readonly(
            addr(ctx.anchor_archive(region, archive_part_of(arrive))),
            false,
        ),
        AccountMeta::new_readonly(addr(ctx.beacon_log(region)), false),
        AccountMeta::new_readonly(addr(clash_inputs_address(&ctx, dest, arrive)), false),
        AccountMeta::new_readonly(addr(province_address(&ctx, dest.coord())), false),
        AccountMeta::new(addr(arrival_day_address(&ctx, dest, day_of(arrive))), false),
    ];
    for i in 0..4u8 {
        let k = addr(arrival_slot_address(&ctx, dest, arrive, m.t.faction, i));
        acc.push(if i == target {
            AccountMeta::new(k, false)
        } else {
            AccountMeta::new_readonly(k, false)
        });
    }
    acc.push(AccountMeta::new_readonly(
        fclient::addr::instructions_sysvar(),
        false,
    ));
    acc.push(AccountMeta::new_readonly(
        fclient::addr::system_program(),
        false,
    ));
    if acc.len() != wix::REVEAL_FIXED {
        return Err("the reveal's fixed accounts".into());
    }
    for k in &o.path {
        acc.push(AccountMeta::new_readonly(
            addr(province_address(&ctx, k.coord())),
            false,
        ));
    }
    Ok(Instruction {
        program_id: a.program,
        accounts: acc,
        data,
    })
}

/// One WideGather position `k` (`wide_ix::GATHER` pairs): the slot, and for a present slot its host's wide transit
/// record (writable), else a read-only filler.
fn gather_pair(
    c: &Chain,
    a: &Addresses,
    dest: ProvinceKey,
    bell: u32,
    k: u8,
) -> Result<[AccountMeta; 2], String> {
    let ctx = ctx_of(a);
    let slot = addr(arrival_slot_address(&ctx, dest, bell, k / 4, k % 4));
    let Some(acc) = c.account(&slot) else {
        return Ok([
            AccountMeta::new_readonly(slot, false),
            AccountMeta::new_readonly(fclient::addr::system_program(), false),
        ]);
    };
    if acc.owner != a.program {
        return Err(format!("position {k}: the slot is not the program's"));
    }
    let s = WideArrivalSlot::read(&acc.data).map_err(|e| format!("position {k}: {e:?}"))?;
    let holding = holding_address(&ctx, s.host.key().coord(), s.host.site());
    Ok([
        AccountMeta::new_readonly(slot, false),
        AccountMeta::new(addr(transit_address(&ctx, &holding, s.transit_slot)), false),
    ])
}

/// WideGather (0xDC op 4) of positions `start..start + n`.
pub fn gather_ix(
    c: &Chain,
    a: &Addresses,
    payer: &Address,
    p: &Prov,
    bell: u32,
    start: u8,
    n: u8,
) -> Result<Instruction, String> {
    let ctx = ctx_of(a);
    let mut acc = vec![
        AccountMeta::new(*payer, true),
        AccountMeta::new_readonly(a.season, false),
        AccountMeta::new_readonly(p.key, false),
        AccountMeta::new_readonly(a.anchor(bell, p.region), false),
        AccountMeta::new(addr(clash_inputs_address(&ctx, p.pk, bell)), false),
        AccountMeta::new_readonly(addr(arrival_day_address(&ctx, p.pk, day_of(bell))), false),
        AccountMeta::new_readonly(fclient::addr::instructions_sysvar(), false),
        AccountMeta::new_readonly(fclient::addr::system_program(), false),
    ];
    for k in start..start + n {
        acc.extend(gather_pair(c, a, p.pk, bell, k)?);
    }
    Ok(Instruction {
        program_id: a.program,
        accounts: acc,
        data: wix::Gather { bell, start, n }.to_bytes().to_vec(),
    })
}

/// The widest WideGather from `start` that fits one packet.
pub fn gather_batch(
    c: &Chain,
    a: &Addresses,
    payer: &Keypair,
    p: &Prov,
    bell: u32,
    start: u8,
) -> Result<Instruction, String> {
    let mut best = None;
    for n in 1..=(wix::GATHER_POSITIONS - start) {
        let ix = gather_ix(c, a, &payer.pubkey(), p, bell, start, n)?;
        if lk::encoded_len(std::slice::from_ref(&ix), payer)? > lk::PACKET_BYTES {
            break;
        }
        best = Some(ix);
    }
    best.ok_or_else(|| format!("no Gather batch from position {start} fits the packet"))
}

/// WideSettleTransit (0xDC op 5, `wide_ix::SETTLE_TRANSIT`) of a march against `dest` (the sealed destination, or a
/// present province for a seal that does not open), `with_citizen` adding the holding's owner Citizen.
pub fn settle_transit_ix(
    c: &Chain,
    a: &Addresses,
    payer: &Address,
    m: &March,
    d: &wix::Depart,
    dest: &Prov,
    with_citizen: bool,
) -> Result<Instruction, String> {
    use frontier_abi::layout::player::holding as H;
    let ctx = ctx_of(a);
    let arrive = m.t.arrive_bell;
    let hd = c.account(&m.holding).ok_or("the holding is absent")?.data;
    let rent_payer = addr(
        hd.get(H::RENT_PAYER..H::RENT_PAYER + 32)
            .ok_or("holding bytes")?
            .try_into()
            .unwrap(),
    );
    let header = clash_header(c, a, dest.pk, arrive)?;
    let resolved = header.filter(|h| {
        h.flags & frontier_abi::world_index::arrival::wide_clash_inputs::FLAG_RESOLVED != 0
    });
    let mut i = 0u8;
    if resolved.is_some() {
        let inputs = c
            .account(&addr(clash_inputs_address(&ctx, dest.pk, arrive)))
            .ok_or("inputs")?
            .data;
        let base = frontier_abi::world_index::arrival::wide_clash_inputs::position(m.t.faction, 0);
        for j in 0..4usize {
            if let Ok(Some(x)) = WideArrival::read_at(&inputs, base + j) {
                if x.present && x.host == m.t.host {
                    i = j as u8;
                }
            }
        }
    }
    let slot = addr(arrival_slot_address(&ctx, dest.pk, arrive, m.t.faction, i));
    let slot_ben = c
        .account(&slot)
        .filter(|x| x.owner == a.program)
        .and_then(|x| WideArrivalSlot::read(&x.data).ok())
        .map_or(*payer, |s| addr(s.beneficiary));
    let resolver = resolved.map_or(*payer, |h| addr(h.resolver));
    let home = ProvinceKey::new(m.h.world, m.h.coord);
    let mut acc = vec![
        AccountMeta::new(*payer, true),
        AccountMeta::new_readonly(a.season, false),
        AccountMeta::new(m.holding, false),
        AccountMeta::new(dest.key, false),
        AccountMeta::new(addr(clash_inputs_address(&ctx, dest.pk, arrive)), false),
        AccountMeta::new(slot, false),
        AccountMeta::new(addr(province_address(&ctx, m.h.coord)), false),
        AccountMeta::new_readonly(a.anchor(arrive, dest.region), false),
        AccountMeta::new(slot_ben, false),
        AccountMeta::new(resolver, false),
        AccountMeta::new(rent_payer, false),
        AccountMeta::new(*payer, false),
        AccountMeta::new(m.key, false),
        AccountMeta::new(addr(roster_address(&ctx, home)), false),
        AccountMeta::new_readonly(fclient::addr::system_program(), false),
        AccountMeta::new(addr(roster_address(&ctx, dest.pk)), false),
        AccountMeta::new(addr(m.t.rent_to), false),
    ];
    if with_citizen {
        acc.push(AccountMeta::new(addr(m.h.owner_citizen), false));
    }
    Ok(Instruction {
        program_id: a.program,
        accounts: acc,
        data: wix::SettleTransit {
            transit_slot: m.slot,
            commit: d.commit,
            seal: d.seal,
            beneficiary: payer.to_bytes(),
        }
        .to_bytes()
        .to_vec(),
    })
}

/// The crank (module doc).
pub struct Crank {
    pub a: Addresses,
    payer: Keypair,
    rounds: HashMap<u32, lk::RoundProvenance>,
    seeds: HashMap<u64, [u8; 48]>,
    backoff: HashMap<String, Instant>,
    /// Marches whose seal does not open with the public round (settled against their origin, never revealed).
    sealed_shut: BTreeSet<[u8; 32]>,
    /// Destinations learned by opening a seal (driven so the settlement's `resolved_next > arrive` can hold).
    learned: BTreeMap<[u8; 32], ProvinceKey>,
    pub landed: u64,
    pub refused: u64,
}

impl Crank {
    pub fn new(a: Addresses, payer: Keypair) -> Crank {
        Crank {
            a,
            payer,
            rounds: HashMap::new(),
            seeds: HashMap::new(),
            backoff: HashMap::new(),
            sealed_shut: BTreeSet::new(),
            learned: BTreeMap::new(),
            landed: 0,
            refused: 0,
        }
    }

    async fn round_of(
        &mut self,
        clock: &fclient::clock::SeasonClock,
        bell: u32,
    ) -> Result<lk::RoundProvenance, String> {
        if let Some(r) = self.rounds.get(&bell) {
            return Ok(r.clone());
        }
        let rs = lk::fetch_rounds(clock, bell..bell + ROUNDS_PER_FETCH).await;
        let rs = match rs {
            Ok(rs) => rs,
            // the later rounds may not be published yet: the one round alone
            Err(_) => lk::fetch_rounds(clock, bell..bell + 1).await?,
        };
        for r in rs {
            if r.round == clock.tlock_round(r.bell) {
                self.rounds.insert(r.bell, r);
            }
        }
        if self.rounds.len() > 4096 {
            let keep: Vec<u32> = self
                .rounds
                .keys()
                .copied()
                .filter(|b| *b + 512 >= bell)
                .collect();
            self.rounds.retain(|b, _| keep.contains(b));
        }
        self.rounds
            .get(&bell)
            .cloned()
            .ok_or_else(|| format!("round of bell {bell} not served"))
    }

    async fn seed_sig(&mut self, round: u64) -> Result<[u8; 48], String> {
        if let Some(s) = self.seeds.get(&round) {
            return Ok(*s);
        }
        let s = lk::fetch_round_at(round).await?;
        self.seeds.insert(round, s);
        Ok(s)
    }

    /// Builds the instruction of one act (fetching the public rounds it needs).
    async fn build(
        &mut self,
        state: &Shared,
        s: &Scan,
        clock: &fclient::clock::SeasonClock,
        now: Now,
        act: &Act,
    ) -> Result<Option<(Instruction, String)>, String> {
        let me = self.payer.pubkey();
        match act {
            Act::Anchor { bell, region } => {
                let r = self.round_of(clock, *bell).await?;
                Ok(Some((
                    lk::post_anchor_ix(&self.a, &me, *region, &r)?,
                    format!("PostAnchor(bell {bell}, region {region})"),
                )))
            }
            Act::Seed {
                bell,
                region,
                anchor_ts,
            } => {
                let round = clock.seed_round(*bell, *anchor_ts);
                if clock.drand.round_time(round) > now.ts {
                    return Ok(None);
                }
                let sig48 = self.seed_sig(round).await?;
                let arg = BeaconArg {
                    round,
                    sig48,
                    hints: fclient::beacon::hints_bytes(round),
                };
                Ok(Some((
                    post_seed(&self.a, me, *region, *bell, 0, &arg, &me),
                    format!("PostSeed(bell {bell}, region {region}, round {round})"),
                )))
            }
            Act::Gather { dest, bell, start } => {
                let c = lock(state);
                let p = s.provs.get(dest).ok_or("province")?;
                let ix = gather_batch(&c, &self.a, &self.payer, p, *bell, *start)?;
                Ok(Some((
                    ix,
                    format!(
                        "WideGather({},{} bell {bell} from {start})",
                        dest.coord().p(),
                        dest.coord().q()
                    ),
                )))
            }
            Act::Resolve { dest, bell } => {
                let p = s.provs.get(dest).ok_or("province")?;
                Ok(Some((
                    crate::resident_bells::resolve_ix(&self.a, &me, *dest, &p.key, p.region, *bell),
                    format!(
                        "WideResolve({},{} bell {bell})",
                        dest.coord().p(),
                        dest.coord().q()
                    ),
                )))
            }
            Act::SettleDeparture { march } => {
                let m = &s.marches[*march];
                Ok(Some((
                    settle_departure_ix(&self.a, &me, m),
                    format!(
                        "WideSettleDeparture(slot {} of {},{} site {})",
                        m.slot,
                        m.h.coord.p(),
                        m.h.coord.q(),
                        m.h.site
                    ),
                )))
            }
            Act::Reveal { march } => {
                let m = s.marches[*march].clone();
                let d = { landed_depart(&lock(state), &self.a, &m)? }
                    .ok_or("no landed WideDepart of this march")?;
                let r = self.round_of(clock, m.t.arrive_bell).await?;
                let sig48: [u8; 48] = hex::decode(&r.signature_hex)
                    .map_err(|e| e.to_string())?
                    .try_into()
                    .map_err(|_| "sig")?;
                let o = match open_seal(&m.t, &d.commit, &d.seal, &sig48) {
                    Ok(o) => o,
                    Err(e) => {
                        self.sealed_shut.insert(m.t.seal_root);
                        return Err(format!("not revealed ({e}): the settlement judges it"));
                    }
                };
                self.learned.insert(m.t.seal_root, o.dest);
                let dp = s.provs.get(&o.dest).ok_or_else(|| {
                    format!(
                        "the sealed destination {:?} is not an opened wide province",
                        o.dest.coord()
                    )
                })?;
                let planned = {
                    let c = lock(state);
                    if lk::anchor_landed(&c, &self.a, m.t.arrive_bell, dp.region)?.is_none() {
                        None
                    } else {
                        let target = free_target(&c, &self.a, o.dest, m.t.arrive_bell, m.t.faction)
                            .ok_or("all four arrival slots of the nation are taken")?;
                        Some((reveal_ix(&self.a, &me, &m, &o, dp.region, target)?, target))
                    }
                };
                match planned {
                    Some((ix, target)) => Ok(Some((ix, format!("WideReveal(slot {} of {},{} -> {},{} tile {} bell {}, position {target})", m.slot, m.h.coord.p(), m.h.coord.q(), o.dest.coord().p(), o.dest.coord().q(), wseal::unpack(&o.plain).map(|p| p.dest_tile).unwrap_or(0), m.t.arrive_bell)))),
                    None => Ok(Some((lk::post_anchor_ix(&self.a, &me, dp.region, &r)?, format!("PostAnchor(bell {}, region {}) for a reveal", m.t.arrive_bell, dp.region)))),
                }
            }
            Act::SettleTransit { march } => {
                let m = s.marches[*march].clone();
                let d = { landed_depart(&lock(state), &self.a, &m)? }
                    .ok_or("no landed WideDepart of this march")?;
                let dest_pk = match m
                    .t
                    .dest
                    .or_else(|| self.learned.get(&m.t.seal_root).copied())
                {
                    Some(k) => k,
                    None => {
                        let r = self.round_of(clock, m.t.arrive_bell).await?;
                        let sig48: [u8; 48] = hex::decode(&r.signature_hex)
                            .map_err(|e| e.to_string())?
                            .try_into()
                            .map_err(|_| "sig")?;
                        match open_seal(&m.t, &d.commit, &d.seal, &sig48) {
                            Ok(o) => {
                                self.learned.insert(m.t.seal_root, o.dest);
                                o.dest
                            }
                            // a seal that does not open settles against a present province: its origin
                            Err(_) => m.t.origin.key(),
                        }
                    }
                };
                self.settle_with(state, s, &m, &d, dest_pk, now)
            }
        }
    }

    fn settle_with(
        &mut self,
        state: &Shared,
        s: &Scan,
        m: &March,
        d: &wix::Depart,
        dest_pk: ProvinceKey,
        _now: Now,
    ) -> Result<Option<(Instruction, String)>, String> {
        let me = self.payer.pubkey();
        let c = lock(state);
        let dp = s
            .provs
            .get(&dest_pk)
            .ok_or("the settlement's province is not an opened wide province")?;
        let ix = settle_transit_ix(&c, &self.a, &me, m, d, dp, false)?;
        let what = format!(
            "WideSettleTransit(slot {} of {},{} site {} against {},{})",
            m.slot,
            m.h.coord.p(),
            m.h.coord.q(),
            m.h.site,
            dest_pk.coord().p(),
            dest_pk.coord().q()
        );
        if matches!(lk::simulate_ix(&c, &self.payer, &ix), Ok(r) if r.err.is_none()) {
            return Ok(Some((ix, what)));
        }
        Ok(Some((
            settle_transit_ix(&c, &self.a, &me, m, d, dp, true)?,
            format!("{what} with the owner Citizen"),
        )))
    }

    /// The march's next act (pure over the chain; `None`: nothing due).
    fn march_act(
        &self,
        c: &Chain,
        clock: &fclient::clock::SeasonClock,
        s: &Scan,
        i: usize,
        now: Now,
    ) -> Result<Option<Act>, String> {
        let m = &s.marches[i];
        let t = &m.t;
        match t.state {
            MarchState::Departed => {
                let origin = s
                    .provs
                    .get(&t.origin.key())
                    .ok_or("the origin is not an opened wide province")?;
                return Ok((origin.rn > t.depart_bell).then_some(Act::SettleDeparture { march: i }));
            }
            MarchState::Settled | MarchState::DestroyedAtOrigin | MarchState::Gathered => {}
            MarchState::Free => return Ok(None),
        }
        if now.bell <= t.arrive_bell {
            return Ok(None);
        }
        // revealed? (an ArrivalSlot of this host at its arrival bell in any province names it)
        let revealed = t.dest.is_some()
            || s.provs.values().any(|p| {
                (0..4u8).any(|j| {
                    c.account(&addr(arrival_slot_address(
                        &ctx_of(&self.a),
                        p.pk,
                        t.arrive_bell,
                        t.faction,
                        j,
                    )))
                    .and_then(|x| WideArrivalSlot::read(&x.data).ok())
                    .is_some_and(|x| x.host == t.host && x.transit_slot == m.slot)
                })
            });
        let shut = self.sealed_shut.contains(&t.seal_root);
        // (a reveal is due while THE anchor of the learned destination is absent or its window is open; a window that
        //  closed unrevealed is never forced: the settlement decides, as the program's rule says)
        let window_open = match self.learned.get(&t.seal_root).and_then(|k| s.provs.get(k)) {
            Some(dp) => match lk::anchor_landed(c, &self.a, t.arrive_bell, dp.region)? {
                Some(a_ts) => now.ts < clock.reveal_close(t.arrive_bell, a_ts),
                None => true,
            },
            None => true,
        };
        if !revealed && !shut && window_open && t.state != MarchState::DestroyedAtOrigin {
            return Ok(Some(Act::Reveal { march: i }));
        }
        // settle once the destination (gathered, or learned from the opened seal; the origin for a seal that does not
        // open) resolved the arrival bell, and the settle delay after THE anchor's reveal close passed
        let dest = t
            .dest
            .or_else(|| self.learned.get(&t.seal_root).copied())
            .or(shut.then_some(t.origin.key()));
        let Some(dp) = dest.and_then(|k| s.provs.get(&k)) else {
            return Ok(None);
        };
        let Some(a_ts) = lk::anchor_landed(c, &self.a, t.arrive_bell, dp.region)? else {
            return Ok(None);
        };
        if now.ts < clock.reveal_close(t.arrive_bell, a_ts) + SETTLE_AFTER_CLOSE_SECS
            || dp.rn <= t.arrive_bell
        {
            return Ok(None);
        }
        Ok(Some(Act::SettleTransit { march: i }))
    }

    /// One round: scan, plan one act per lane, simulate, send, wait. Returns the landed/refused lines.
    pub async fn round(
        &mut self,
        state: &Shared,
        stop: &mut tokio::sync::watch::Receiver<bool>,
    ) -> Result<Vec<Value>, String> {
        let (s, clock, now, acts) = {
            let c = lock(state);
            let clock = lk::season_clock(&c, &self.a)?;
            let ts = c.unix_timestamp();
            let Some(bell) = clock.bell_at(ts) else {
                return Ok(vec![]);
            };
            let sd = c.account(&self.a.season).ok_or("no Season")?.data;
            let end_bell = u32_at(&sd, frontier_abi::v2::layout::world::season::END_BELL)
                .ok_or("season bytes")?;
            let now = Now { ts, bell, end_bell };
            let s = scan(&c, &self.a);
            let mut acts: Vec<Act> = vec![];
            let mut out_errs = vec![];
            for i in 0..s.marches.len() {
                match self.march_act(&c, &clock, &s, i, now) {
                    Ok(Some(a)) => acts.push(a),
                    Ok(None) => {}
                    Err(e) => out_errs.push(e),
                }
            }
            let mut drive = s.drive.clone();
            for m in &s.marches {
                if let Some(k) = self.learned.get(&m.t.seal_root) {
                    if s.provs.contains_key(k) && !s.expedition.contains(k) {
                        drive.insert(*k);
                    }
                }
            }
            for k in &drive {
                match province_act(&c, &self.a, &clock, &s.provs[k], now) {
                    Ok(Some(a)) => acts.push(a),
                    Ok(None) => {}
                    Err(e) => out_errs.push(e),
                }
                if let Ok(more) = lead_acts(&c, &self.a, &clock, &s.provs[k], now) {
                    acts.extend(more);
                }
            }
            (s, clock, now, acts)
        };
        let mut lanes = BTreeSet::new();
        let mut sent = vec![];
        let mut out = vec![];
        let t0 = Instant::now();
        for act in acts {
            if sent.len() >= MAX_BATCH || *stop.borrow() {
                break;
            }
            let lane = act.lane(&s);
            if lanes.contains(&lane) || self.backoff.get(&lane).is_some_and(|t| *t > t0) {
                continue;
            }
            lanes.insert(lane.clone());
            let built = self.build(state, &s, &clock, now, &act).await;
            let (ix, what) = match built {
                Ok(Some(x)) => x,
                Ok(None) => continue,
                Err(e) => {
                    self.backoff.insert(lane, Instant::now() + BACKOFF);
                    out.push(json!({"schema": WIDE_DEPART_SCHEMA, "wide_depart_step": "skipped", "test_only": true, "why": e}));
                    continue;
                }
            };
            let mut c = lock(state);
            match lk::simulate_ix(&c, &self.payer, &ix) {
                Ok(r) if r.err.is_none() => {}
                Ok(r) => {
                    self.refused += 1;
                    self.backoff.insert(lane, Instant::now() + BACKOFF);
                    let tail: Vec<String> = r.logs.iter().rev().take(4).rev().cloned().collect();
                    out.push(json!({"schema": WIDE_DEPART_SCHEMA, "wide_depart_step": "refused", "test_only": true, "what": what, "err": format!("{:?}", r.err), "code": r.code, "logs": tail}));
                    continue;
                }
                Err(e) => {
                    self.backoff.insert(lane, Instant::now() + BACKOFF);
                    out.push(json!({"schema": WIDE_DEPART_SCHEMA, "wide_depart_step": "refused", "test_only": true, "what": what, "err": e}));
                    continue;
                }
            }
            let (blockhash, _) = c.latest_blockhash();
            let t = fclient::tx::build(&[ix], &lk::budget(), &[&self.payer], &blockhash)?;
            match c.submit(&fclient::tx::wire(&t)) {
                Ok(sig) => sent.push((lane, what, sig)),
                Err(e) => out.push(json!({"schema": WIDE_DEPART_SCHEMA, "wide_depart_step": "refused", "test_only": true, "what": what, "err": e.to_string()})),
            }
        }
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut pending = sent;
        while !pending.is_empty() && Instant::now() < deadline && !*stop.borrow() {
            tokio::time::sleep(Duration::from_millis(200)).await;
            let c = lock(state);
            pending.retain(|(lane, what, sig)| {
                if let Some(l) = c.transaction(sig) {
                    if let Some(err) = &l.err {
                        self.refused += 1;
                        self.backoff.insert(lane.clone(), Instant::now() + BACKOFF);
                        let tail: Vec<String> = l.logs.iter().rev().take(4).rev().cloned().collect();
                        out.push(json!({"schema": WIDE_DEPART_SCHEMA, "wide_depart_step": "failed", "test_only": true, "what": what, "signature": sig.to_string(), "err": err.to_string(), "code": l.code, "logs": tail}));
                    } else {
                        self.landed += 1;
                        let cu = l.logs.iter().rev().find(|x| x.contains("consumed") && x.contains(&self.a.program.to_string())).cloned();
                        out.push(json!({"schema": WIDE_DEPART_SCHEMA, "wide_depart_step": "landed", "test_only": true, "what": what, "signature": sig.to_string(), "bell": now.bell, "cu": cu}));
                    }
                    return false;
                }
                if c.is_dropped(sig) {
                    out.push(json!({"schema": WIDE_DEPART_SCHEMA, "wide_depart_step": "dropped", "test_only": true, "what": what, "signature": sig.to_string()}));
                    return false;
                }
                true
            });
        }
        for (_, what, sig) in pending {
            out.push(json!({"schema": WIDE_DEPART_SCHEMA, "wide_depart_step": "unknown", "test_only": true, "what": what, "signature": sig.to_string()}));
        }
        Ok(out)
    }
}

/// The crank's loop until `stop` (one round every ~0.5 s; a quiet round sleeps 1 s). One JSON line per landed,
/// refused or failed send; a status line every minute.
pub async fn run(
    state: Shared,
    a: Addresses,
    mut stop: tokio::sync::watch::Receiver<bool>,
    out: impl Fn(Value),
) -> Result<(), String> {
    let payer = crate::keeper_loop::fund_fresh(&state, &mut stop).await?;
    out(
        json!({"schema": WIDE_DEPART_SCHEMA, "wide_depart_step": "crank", "test_only": true, "payer": payer.pubkey().to_string(),
        "gate": "localnet-wide-depart (the local land .so only; devnet unchanged)"}),
    );
    let mut crank = Crank::new(a, payer);
    let mut last_status = Instant::now();
    loop {
        if *stop.borrow() {
            return Ok(());
        }
        let lines = match crank.round(&state, &mut stop).await {
            Ok(l) => l,
            Err(e) => vec![
                json!({"schema": WIDE_DEPART_SCHEMA, "wide_depart_step": "round_error", "test_only": true, "why": e}),
            ],
        };
        let quiet = lines.is_empty();
        for l in lines {
            out(l);
        }
        if last_status.elapsed() > Duration::from_secs(60) {
            last_status = Instant::now();
            let s = scan(&lock(&state), &crank.a);
            out(
                json!({"schema": WIDE_DEPART_SCHEMA, "wide_depart_step": "status", "test_only": true, "landed": crank.landed, "refused": crank.refused,
                "driven": s.drive.iter().map(|k| { let p = &s.provs[k]; json!({"p": k.coord().p(), "q": k.coord().q(), "resolved_next": p.rn}) }).collect::<Vec<_>>(),
                "marches": s.marches.iter().map(|m| json!({"holding": [m.h.coord.p(), m.h.coord.q(), m.h.site], "slot": m.slot, "state": format!("{:?}", m.t.state), "depart": m.t.depart_bell, "arrive": m.t.arrive_bell})).collect::<Vec<_>>(),
                "expedition_held": s.expedition.len()}),
            );
        }
        let pause = if quiet { 1000 } else { 300 };
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(pause)) => {}
            _ = crate::keeper_loop::stopped(&mut stop) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_wide_march_commands_decode_as_the_wide_tables_name_them() {
        let g = wix::Gather {
            bell: 7,
            start: 0,
            n: 3,
        }
        .to_bytes();
        assert!(
            matches!(wix::WideCommand::decode(&g), Ok(wix::WideCommand::Gather(x)) if x.bell == 7 && x.start == 0 && x.n == 3)
        );
        let d = wix::SettleDeparture {
            host: [0; 56],
            transit_slot: 2,
        }
        .to_bytes();
        assert!(
            matches!(wix::WideCommand::decode(&d), Ok(wix::WideCommand::SettleDeparture(x)) if x.transit_slot == 2)
        );
        assert_eq!(wix::REVEAL_FIXED, 16, "the reveal's sixteen fixed accounts");
        assert_eq!(
            wix::SETTLE_TRANSIT_FIXED,
            17,
            "the settlement's seventeen fixed accounts"
        );
        assert_eq!(wix::GATHER_POSITIONS, 24);
    }
}

#[cfg(test)]
mod parity {
    use super::*;
    /// The derivations the page's flocalplay-wide-host.mjs pins (gateway test frontier-local-play-wide-host).
    #[test]
    fn the_page_pins_the_same_wide_host_derivations() {
        use frontier_abi::world_index::{march::wide_host_alias, WideCoord, WorldId};
        let a = Addresses::new(
            Address::new_from_array(crate::expedition_play::PROGRAM),
            crate::expedition_play::SEASON_ID,
        );
        let ctx = ctx_of(&a);
        let world = WorldId::derive_legacy_season(&ctx.season, &ctx.program).unwrap();
        let coord = WideCoord::checked(130, -1).unwrap();
        let pk = ProvinceKey::new(world, coord);
        let holding = holding_address(&ctx, coord, 4);
        let host = frontier_abi::world_index::WideHostRef::new(pk, 4, 1, 2).unwrap();
        assert_eq!(
            a.season.to_string(),
            "7pshbHEvHUftsEcrGUPb9FoVXWmV1gEs1R1cZCGXjSCt"
        );
        assert_eq!(
            addr(holding).to_string(),
            "5EtbQ8buHtvvbY15QmwtMnhsxrPtC6ZUZJP38wH7ejJE"
        );
        assert_eq!(
            addr(roster_address(&ctx, pk)).to_string(),
            "DULG5c1eLfCrQLZcULyaaKGnvTRt9t6tcLCKBxA7PfxU"
        );
        assert_eq!(
            addr(transit_address(&ctx, &holding, 2)).to_string(),
            "Fc8aoQKnGFkNSG9L8uyBGzFDLMiXG7mm4qwaLd2WGz3P"
        );
        assert_eq!(
            addr(province_address(&ctx, coord)).to_string(),
            "4cbQ7NUZRW2qG5USCBB6o7Huhw4quWMnkqHPbHSUQsY5"
        );
        assert_eq!(hex::encode(host.to_bytes()), "01c125eafbbe1563c4fde011a2e0a72b7f240480b0d65cf87d0c7a0c1bda24e5f70000000000000082050000000000000081040102000000");
        assert_eq!(wide_host_alias(&host), 13084875854677356326);
    }
}

#[cfg(test)]
mod record_print {
    /// Evidence helper (ignored): decodes the PSW1 wide records of a landed transaction's `Program data:` lines, given
    /// as base64 bodies in `WIDE_RECORDS` (space-separated), and prints kind, key and payload.
    #[test]
    #[ignore]
    fn print_wide_records() {
        use base64::Engine as _;
        use frontier_abi::world_index::event::WideRecord;
        for b in std::env::var("WIDE_RECORDS")
            .unwrap_or_default()
            .split_whitespace()
        {
            let body = base64::engine::general_purpose::STANDARD.decode(b).unwrap();
            match WideRecord::decode(&body) {
                Ok(r) => println!("RECORD {r:?}"),
                Err(e) => println!("RECORD error {e:?}"),
            }
        }
    }
}
