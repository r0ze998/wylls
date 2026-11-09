//! Detached DE FF01 op5 arithmetic and ordered receipt proof.
//! All snapshots, wire privileges, Clock and Rent are caller-supplied claims.
//! No signature, invocation provenance, freshness or full-season proof is made.
//! Never feed flattened transaction logs/final posts into this API as authenticated
//! evidence: complete invocation-scoped pre/read-only/intermediate state is needed.
use frontier_abi::layout::{
    header as HDR,
    province::{province as PV, site as SM},
    world::season as S,
};
use frontier_abi::v2::{
    layout::{
        player::{citizen as C, holding as H},
        province::{conquest as CR, site as SM2},
    },
    presets::{ConquestParams, RULESET_HASH_V3},
};
use frontier_abi::world_index::{
    conquest::{self as wc, WideCaptureEscrow, WideConquest},
    event::{self, conquest as receipt, WideKind},
    holding::{self as wh, WideHolding},
    land::{self as wl, WideProvince},
    wide_ix::SettleSiege,
    ProvinceKey, WorldId,
};
use frontier_abi::{
    addr::{self, AddrCtx},
    bytes::*,
    conquest_model::Record,
};
use permutation_rules::hash::sha256;

pub const FULL_SEASON_REPLAY_SUPPORTED: bool = false;
pub const NOT_PROVEN: &[&str] = &[
    "signature or signer provenance",
    "snapshot, Clock or Rent provenance",
    "complete authenticated invocation",
    "previous or subsequent transitions",
    "full-season replay",
];
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConditionalProofLimits {
    CallerSuppliedInvocationNoAuthenticationOrSeasonReplay,
}
pub type Refusal = String;
type R<T> = Result<T, Refusal>;
fn need(ok: bool, why: &str) -> R<()> {
    if ok {
        Ok(())
    } else {
        Err(why.into())
    }
}
fn codec<T, E: core::fmt::Debug>(x: Result<T, E>) -> R<T> {
    x.map_err(|e| format!("codec: {e:?}"))
}

/// One supplied role-level account view, including aliases. Flags are caller
/// claims accepted by this detached checker, not authenticated/global effective
/// message privileges. Alias state equality excludes these per-role flags; the
/// signer/funder alias fixture deliberately supplies different signer flags.
/// A real wire adapter must reconstruct/globalize effective privileges across
/// aliases and authenticate their source before relying on these views. Neither
/// this type nor a successful check proves that any signature was verified.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Account {
    pub address: [u8; 32],
    pub owner: [u8; 32],
    pub present: bool,
    pub lamports: u64,
    pub data: Vec<u8>,
    pub signer: bool,
    pub writable: bool,
}
#[derive(Clone, Debug)]
pub struct Context {
    pub program: [u8; 32],
    pub season: [u8; 32],
    pub command: Vec<u8>,
    pub now_ts: i64,
    pub escrow_rent_minimum: u64,
    pub holding_rent_minimum: u64,
}
pub struct Evidence<'a> {
    pub context: &'a Context,
    pub before: &'a [Account],
    pub after: &'a [Account],
    /// Exact ordered event bodies for this invocation only, with tails.
    pub events: &'a [Vec<u8>],
}
#[derive(Clone, Debug)]
pub struct Staged {
    pub limits: ConditionalProofLimits,
    pub after: Vec<Account>,
    pub events: Vec<Vec<u8>>,
    pub receipt: receipt::Receipt,
    pub refund: u64,
    pub added_gold_milli: u64,
    pub burned_gold_milli: u64,
}
fn same_state(a: &Account, b: &Account) -> bool {
    a.owner == b.owner && a.present == b.present && a.lamports == b.lamports && a.data == b.data
}
fn replace(a: &mut [Account], i: usize, s: Account) {
    let key = a[i].address;
    for x in a.iter_mut().filter(|x| x.address == key) {
        x.owner = s.owner;
        x.present = s.present;
        x.lamports = s.lamports;
        x.data = s.data.clone();
    }
}
fn bytes(a: &mut [Account], i: usize, data: Vec<u8>) {
    let mut s = a[i].clone();
    s.data = data;
    replace(a, i, s);
}
fn owned(a: &Account, p: [u8; 32]) -> R<()> {
    need(
        a.present && a.owner == p,
        "program-owned present account required",
    )
}
fn at(a: &Account, key: [u8; 32]) -> R<()> {
    need(a.address == key, "noncanonical address")
}
fn snapshots<'a>(a: &'a [Account], chained: &[[u8; 32]]) -> Vec<receipt::AccountSnapshot<'a>> {
    a.iter()
        .enumerate()
        .map(|(i, x)| receipt::AccountSnapshot {
            role: (i + 1) as u16,
            address: x.address,
            owner: x.owner,
            present: x.present,
            lamports: x.lamports,
            data: &x.data,
            chained: chained.contains(&x.address),
        })
        .collect()
}
fn emit(
    a: &mut [Account],
    i: usize,
    kind: WideKind,
    bell: u32,
    key: &[u8],
    r: &receipt::Receipt,
) -> R<Vec<u8>> {
    let mut body = [0; event::MAX_BODY];
    let n = event::write_body(kind, bell, key, &r.encode(), &mut body).ok_or("event body")?;
    let mut d = a[i].data.clone();
    let seq = rd_u64(&d, HDR::EVENT_SEQ).ok_or("chain seq")?;
    let head = rd_arr::<32>(&d, HDR::EVENT_HEAD).ok_or("chain head")?;
    let link = event::advance(kind.links()[0], seq, &head, &body[..n]).ok_or("chain overflow")?;
    need(
        wr_u64(&mut d, HDR::EVENT_SEQ, link.seq) && wr_arr(&mut d, HDR::EVENT_HEAD, &link.head),
        "chain write",
    )?;
    bytes(a, i, d);
    let m = event::write_tail(kind, &[link], &mut body, n).ok_or("event tail")?;
    Ok(body[..m].to_vec())
}

/// Independently stage one transition, including its complete ordered receipts.
/// Public address hashing and codecs are shared; settlement effects are not.
/// The holding numeric preflight conservatively refuses representability hazards
/// before replay. It adds no gameplay condition and does not claim identical
/// admission to the runtime for every malformed numeric state.
pub fn stage_settle_siege(c: &Context, b: &[Account]) -> R<Staged> {
    need(matches!(b.len(), 7 | 8), "exact seven/eight roles required")?;
    let ix = codec(SettleSiege::decode(&c.command))?;
    need(
        ix.to_bytes().as_slice() == c.command,
        "noncanonical command",
    )?;
    for (i, x) in b.iter().enumerate() {
        need(
            (i < 2 || x.writable) && (i != 1 || !x.writable) && (i != 0 || x.signer),
            "wire privileges",
        )?;
        need(
            x.present != (x.owner == [0; 32] && x.data.is_empty()),
            "absence predicate",
        )?;
        for y in &b[..i] {
            if y.address == x.address {
                need(same_state(x, y), "inconsistent aliases")?;
            }
        }
    }
    at(&b[1], c.season)?;
    owned(&b[1], c.program)?;
    let sd = &b[1].data;
    need(
        sd.len() >= S::SIZE && rd_arr::<8>(sd, 0) == Some(S::MAGIC),
        "Season shape",
    )?;
    let sid = rd_u64(sd, S::SEASON_ID).ok_or("season id")?;
    let bump = rd_u8(sd, S::BUMP).ok_or("season bump")?;
    at(
        &b[1],
        sha256(&[
            S::PDA_PREFIX,
            &sid.to_le_bytes(),
            &[bump],
            &c.program,
            b"ProgramDerivedAddress",
        ]),
    )?;
    need(
        rd_arr::<32>(sd, S::RULESET_HASH) == Some(RULESET_HASH_V3),
        "ruleset",
    )?;
    let ver = rd_u16(sd, S::PROGRAM_VERSION).ok_or("version")?;
    let expected = crate::wide_economy::WIDE_S1_PROGRAM_VERSION;
    need(
        ver == expected || ver == expected | 0x8000,
        "wide S1 version",
    )?;
    let genesis = rd_i64(sd, S::GENESIS_TS).ok_or("genesis")?;
    let stored = sd[S::STATUS];
    let status = if stored == S::STATUS_SEEDED && c.now_ts >= genesis {
        S::STATUS_RUNNING
    } else {
        stored
    };
    need(
        matches!(status, S::STATUS_RUNNING | S::STATUS_ENDED),
        "Running/Ended required",
    )?;
    let now_bell = crate::wide_economy::bell_at(genesis, c.now_ts);
    let bell = now_bell.unwrap_or(frontier_abi::log::NO_BELL);
    let end = rd_u32(sd, S::END_BELL).ok_or("end bell")?;
    let cq = ConquestParams::of_season(sd).ok_or("conquest params")?;
    let ctx = AddrCtx {
        season: c.season,
        program: c.program,
    };
    let world = codec(WorldId::derive_legacy_season(&c.season, &c.program))?;
    for i in 2..=5 {
        owned(&b[i], c.program)?;
    }
    let p = codec(WideProvince::read(&b[2].data))?;
    need(
        p.season_id == sid && p.world == world,
        "Province Season/world",
    )?;
    at(&b[2], wl::province_address(&ctx, p.coord))?;
    let key = ProvinceKey::new(world, p.coord);
    at(&b[3], wc::conquest_address(&ctx, key))?;
    let table = codec(WideConquest::read(&b[3].data, sid, key))?;
    for site in 0..PV::SITES_N {
        codec(table.validate_paired(site as u8, codec(Record::read(&b[2].data, site))?))?;
    }
    let cd = &b[4].data;
    need(
        cd.len() == C::SIZE
            && rd_arr::<8>(cd, 0) == Some(C::MAGIC)
            && rd_u64(cd, 8) == Some(sid)
            && rd_u16(cd, HDR::LAYOUT_VERSION) == Some(2),
        "Citizen shape/Season/version",
    )?;
    let tag = frontier_abi::resident_citizen::record_tag15(cd).ok_or("Citizen identity")?;
    at(&b[4], ctx.citizen_by_tag15(&tag))?;
    need(
        rd_u64(cd, C::CITIZEN_TAG) == Some(addr::citizen_tag(&b[4].address)),
        "Citizen tag",
    )?;
    at(&b[5], wc::capture_escrow_address(&ctx, &b[4].address))?;
    let escrow = codec(WideCaptureEscrow::read(
        &b[5].data,
        sid,
        world,
        b[4].address,
    ))?;
    let floor = c
        .escrow_rent_minimum
        .checked_add(escrow.escrow())
        .ok_or("rent overflow")?;
    need(b[5].lamports >= floor, "escrow rent floor")?;
    let entry = codec(table.entry(ix.site))?.ok_or("already settled")?;
    need(
        matches!(entry.rules.kind, CR::KIND_NONE | CR::KIND_SIEGE),
        "CaptureDue/unsupported kind",
    )?;
    need(
        b.len() == 7 + usize::from(entry.source.is_some()),
        "source manifest",
    )?;
    need(
        (ix.site as usize) < PV::SITES_N && ix.site < b[2].data[PV::SITE_COUNT],
        "target site",
    )?;
    let prefix = codec(Record::read(&b[2].data, ix.site as usize))?;
    codec(escrow.validate_paired(&table, ix.site, prefix, b[4].address, cd))?;
    at(&b[6], escrow.funder())?;
    need(b[5].address != b[6].address, "self refund")?;
    let lapse = entry.rules.kind == CR::KIND_SIEGE;
    if lapse {
        let o = PV::site(ix.site as usize);
        let d = &b[2].data;
        need(
            entry.original_target_gen == 0
                && d[o + SM::STATE] == SM2::STATE_FREE_CITY
                && d[o + SM::GEN] == 0
                && d[o + SM::ORDER] == 0
                && d[o + SM::FACTION] == permutation_rules::frontier::clash::NEUTRAL,
            "initial Free City mirror",
        )?;
        need(
            (status == S::STATUS_ENDED || now_bell.is_some_and(|n| n >= end))
                && rd_u32(d, PV::RESOLVED_NEXT).ok_or("cursor")? >= end,
            "early/unresolved lapse",
        )?;
    }
    let mut a = b.to_vec();
    let mut pd = a[2].data.clone();
    let mut cleared = Record::ZERO;
    cleared.faction = CR::BARRED_NONE;
    codec(cleared.write(&mut pd, ix.site as usize))?;
    bytes(&mut a, 2, pd);
    let mut td = a[3].data.clone();
    let start = 128 + ix.site as usize * 128;
    td[start..start + 128].fill(0);
    bytes(&mut a, 3, td);
    let mut cd = a[4].data.clone();
    cd[C::SLOTS] &=
        !(C::reserved_bit(entry.reserved_slot) | wc::wide_reserved_bit(entry.reserved_slot));
    bytes(&mut a, 4, cd);
    let refund = c.holding_rent_minimum.min(escrow.escrow());
    let mut ed = a[5].data.clone();
    need(
        wr_u64(&mut ed, 160, escrow.escrow() - refund),
        "ledger write",
    )?;
    ed[168] &= !(1 << entry.reserved_slot);
    let start = 176 + (entry.reserved_slot as usize - 2) * 56;
    ed[start..start + 56].fill(0);
    bytes(&mut a, 5, ed);
    let mut from = a[5].clone();
    from.lamports = from
        .lamports
        .checked_sub(refund)
        .ok_or("refund underflow")?;
    let mut to = a[6].clone();
    to.lamports = to.lamports.checked_add(refund).ok_or("refund overflow")?;
    replace(&mut a, 5, from);
    replace(&mut a, 6, to);
    let (mut added, mut burned, mut paid) = (0, 0, false);
    if lapse {
        if let Some(source) = entry.source {
            at(
                &b[7],
                wh::holding_address(&ctx, source.key().coord(), source.site()),
            )?;
            let amount = i64::from(cq.siege_stake_gold)
                .checked_mul(1000)
                .ok_or("stake overflow")?;
            burned = amount as u64;
            if b[7].present {
                owned(&b[7], c.program)?;
                let h = codec(WideHolding::read(&b[7].data))?;
                need(
                    h.season_id == sid
                        && h.world == source.key().world()
                        && h.coord == source.key().coord()
                        && h.site == source.site(),
                    "source identity",
                )?;
                if h.gen == source.gen()
                    && matches!(b[7].data[H::STATE], H::STATE_PROVISIONAL | H::STATE_FINAL)
                {
                    let mut d = a[7].data.clone();
                    let layout = rd_u16(&d, HDR::LAYOUT_VERSION).ok_or("holding layout")?;
                    let mut economic = crate::holding::read(&d)?;
                    let ore = crate::holding::terrain_ore(&d)?;
                    codec(crate::wide_economy::preflight_holding(
                        &economic, ore, c.now_ts,
                    ))?;
                    crate::holding::settle_tiered(&mut economic, c.now_ts, ore)?;
                    let store = &mut economic.stores
                        [permutation_rules::frontier::holding::Resource::Gold as usize];
                    let room = store
                        .cap
                        .checked_sub(store.value)
                        .ok_or("gold room overflow")?
                        .max(0);
                    let credit = amount.min(room).max(0);
                    store.value = store.value.checked_add(credit).ok_or("gold overflow")?;
                    added = credit as u64;
                    burned = (amount - credit) as u64;
                    need(wr_u16(&mut d, HDR::LAYOUT_VERSION, 2), "layout adapter")?;
                    crate::holding::write(&mut d, &economic, c.now_ts)?;
                    need(
                        wr_u16(&mut d, HDR::LAYOUT_VERSION, layout),
                        "layout restore",
                    )?;
                    bytes(&mut a, 7, d);
                    paid = true;
                }
            }
        }
    }
    let mut chained = vec![b[2].address];
    if paid {
        chained.push(b[7].address);
    }
    let rc = receipt::Context {
        command: &c.command,
        now_ts: c.now_ts,
        bell,
        season: sd,
        evidence: &[],
    };
    let outcomes = [refund, added, burned]
        .into_iter()
        .flat_map(u64::to_le_bytes)
        .collect::<Vec<_>>();
    let input = codec(receipt::input_digest(&rc, &snapshots(b, &chained)))?;
    let output = codec(receipt::output_digest(
        &rc,
        &snapshots(&a, &chained),
        &outcomes,
    ))?;
    let r = codec(receipt::Receipt::new(
        if lapse {
            receipt::LAPSE
        } else {
            receipt::FAILED
        },
        0,
        input,
        output,
    ))?;
    let mut events = vec![emit(
        &mut a,
        2,
        WideKind::ConquestSettled,
        bell,
        &key.to_bytes(),
        &r,
    )?];
    if paid {
        events.push(emit(
            &mut a,
            7,
            WideKind::ConquestCredited,
            bell,
            &entry.source.ok_or("source")?.to_bytes(),
            &r,
        )?);
    }
    let mut sums = (0u128, 0u128);
    for i in 0..a.len() {
        need(
            a[i].owner == b[i].owner
                && a[i].present == b[i].present
                && a[i].data.len() == b[i].data.len(),
            "close/reassign/resize forbidden",
        )?;
        if !b[i].writable {
            need(same_state(&a[i], &b[i]), "read-only mutation")?;
        }
        if !b[..i].iter().any(|x| x.address == b[i].address) {
            sums.0 += b[i].lamports as u128;
            sums.1 += a[i].lamports as u128;
        }
    }
    need(sums.0 == sums.1, "lamport conservation")?;
    Ok(Staged {
        limits: ConditionalProofLimits::CallerSuppliedInvocationNoAuthenticationOrSeasonReplay,
        after: a,
        events,
        receipt: r,
        refund,
        added_gold_milli: added,
        burned_gold_milli: burned,
    })
}
pub fn verify_settle_siege(e: &Evidence<'_>) -> R<Staged> {
    // Authenticate no source here: first bind raw supplied bytes to the input
    // commitment, before any economic replay. Chained flags are derived from
    // the selected entry and live source identity, never from caller booleans.
    let b = e.before;
    let c = e.context;
    need(matches!(b.len(), 7 | 8), "manifest length")?;
    let ix = codec(SettleSiege::decode(&c.command))?;
    let p = codec(WideProvince::read(&b[2].data))?;
    let key = ProvinceKey::new(p.world, p.coord);
    let t = codec(WideConquest::read(&b[3].data, p.season_id, key))?;
    let entry = codec(t.entry(ix.site))?.ok_or("already settled")?;
    need(
        b.len() == 7 + usize::from(entry.source.is_some()),
        "source manifest",
    )?;
    let mut chained = vec![b[2].address];
    if entry.rules.kind == CR::KIND_SIEGE {
        if let Some(source) = entry.source {
            let a = &b[7];
            need(
                a.present != (a.owner == [0; 32] && a.data.is_empty()),
                "source absence predicate",
            )?;
            if a.present {
                let h = codec(WideHolding::read(&a.data))?;
                if h.gen == source.gen()
                    && matches!(a.data[H::STATE], H::STATE_PROVISIONAL | H::STATE_FINAL)
                {
                    chained.push(a.address);
                }
            }
        }
    }
    let event = codec(event::WideRecord::decode(
        e.events.first().ok_or("missing settled receipt")?,
    ))?;
    need(
        event.kind == WideKind::ConquestSettled,
        "first event must settle",
    )?;
    let r = codec(receipt::Receipt::decode(event.payload))?;
    let genesis = rd_i64(&b[1].data, S::GENESIS_TS).ok_or("genesis")?;
    let bell =
        crate::wide_economy::bell_at(genesis, c.now_ts).unwrap_or(frontier_abi::log::NO_BELL);
    let rc = receipt::Context {
        command: &c.command,
        now_ts: c.now_ts,
        bell,
        season: &b[1].data,
        evidence: &[],
    };
    need(
        codec(receipt::input_digest(&rc, &snapshots(b, &chained)))? == r.input,
        "raw input commitment mismatch",
    )?;
    let s = stage_settle_siege(e.context, e.before)?;
    need(
        s.events == e.events,
        "missing/extra/reordered/mismatched receipt bundle",
    )?;
    need(s.after == e.after, "complete post-state mismatch")?;
    Ok(s)
}
