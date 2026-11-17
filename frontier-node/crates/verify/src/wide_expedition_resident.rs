//! Detached, opt-in replay of original-origin resident Dissolve and Return.
//! This is an invocation-scoped conditional proof over caller-supplied accounts,
//! effective privileges and Clock. It is not log attribution, signature checking,
//! snapshot provenance, earlier Resolve replay, public admission or a season PASS.
//! Program handlers are never called. Bucket/holding replay uses the verifier's
//! existing independent implementation; entry/roster/reserve effects are restated.
//! Canonical codecs, transit authority and receipt hashes are shared definitions.
use crate::{holding as hold, wide_economy as economy};
use frontier_abi::{
    addr::{self, AddrCtx},
    bytes::*,
    entry::{find_entry, read_entry, EntryOp},
    layout::{header as HDR, province::entry as E},
    prologue as ap,
    v2::{
        layout::{
            player::{citizen as C, holding as H},
            province::province as P,
            world::season as S,
        },
        presets::RULESET_HASH_V3,
    },
    world_index::{
        expedition::AccountResolver,
        expedition_resident_event as receipt,
        holding::{self as wh, SlotBinding},
        key::HOST_REF_LEN,
        land::WideProvince,
        march::wide_host_alias,
        roster::{self as wro, WideRoster},
        ProvinceKey, WideHostRef,
    },
};
use permutation_rules::hash::sha256;

pub use receipt::Action;
pub const FULL_SEASON_REPLAY_SUPPORTED: bool = false;
pub const NOT_PROVEN: &[&str] = &[
    "signatures, signer privilege or invocation provenance",
    "account, Clock or historical state provenance and freshness",
    "the prior departure, combat, capture or Resolve transitions",
    "public dispatch admission or a complete season replay",
];
pub type Refusal = String;
type R<T> = Result<T, Refusal>;
fn need(ok: bool, why: &str) -> R<()> {
    if ok {
        Ok(())
    } else {
        Err(why.into())
    }
}
fn codec<T, E: core::fmt::Debug>(r: Result<T, E>) -> R<T> {
    r.map_err(|e| format!("codec: {e:?}"))
}

/// Ordered effective role view. Duplicate actor/payer roles must have identical
/// bytes, metadata and globalized privileges; no other alias is accepted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Account {
    pub address: [u8; 32],
    pub owner: [u8; 32],
    pub present: bool,
    pub signer: bool,
    pub writable: bool,
    pub executable: bool,
    pub lamports: u64,
    pub data: Vec<u8>,
}
#[derive(Clone, Debug)]
pub struct Context {
    pub program: [u8; 32],
    pub season: [u8; 32],
    pub host: WideHostRef,
    pub action: Action,
    pub now_ts: i64,
    pub now_slot: u64,
}
pub struct Evidence<'a> {
    pub context: &'a Context,
    pub before: &'a [Account],
    pub after: &'a [Account],
    /// Exactly this invocation's two bodies in emission order: PS2 then PSW1.
    /// Prefixes/framing/commit status must be independently authenticated.
    pub events: &'a [Vec<u8>],
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Staged {
    pub after: Vec<Account>,
    pub events: Vec<Vec<u8>>,
    pub identity: receipt::Identity,
    pub outcomes: receipt::Outcomes,
    pub operation_id: [u8; 32],
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Verified {
    pub action: Action,
    pub identity: receipt::Identity,
    pub outcomes: receipt::Outcomes,
    pub operation_id: [u8; 32],
}
impl Verified {
    pub const fn full_season(&self) -> bool {
        FULL_SEASON_REPLAY_SUPPORTED
    }
    pub const fn not_proven(&self) -> &'static [&'static str] {
        NOT_PROVEN
    }
}
fn snapshots(a: &[Account]) -> Vec<receipt::AccountSnapshot<'_>> {
    a.iter()
        .enumerate()
        .map(|(i, a)| receipt::AccountSnapshot {
            role: (i + 1) as u16,
            address: a.address,
            owner: a.owner,
            present: a.present,
            signer: a.signer,
            writable: a.writable,
            lamports: a.lamports,
            data: &a.data,
        })
        .collect()
}
fn view(a: &Account) -> ap::AccountView<'_> {
    ap::AccountView {
        key: &a.address,
        owner: &a.owner,
        lamports: a.lamports,
        data: &a.data,
        is_signer: a.signer,
        is_writable: a.writable,
    }
}
fn header(a: &Account, c: &Context, magic: [u8; 8], size: usize, sid: u64) -> R<()> {
    need(
        a.present && a.owner == c.program && a.data.len() == size,
        "account ownership/size",
    )?;
    need(
        rd_arr::<8>(&a.data, HDR::MAGIC) == Some(magic)
            && rd_u64(&a.data, HDR::SEASON_ID) == Some(sid)
            && rd_u16(&a.data, HDR::LAYOUT_VERSION) == Some(2)
            && a.data[18..24] == [0; 6],
        "legacy account header",
    )
}
fn chain(d: &mut [u8], seq: u64, head: &[u8; 32]) -> R<()> {
    need(
        wr_u64(d, HDR::EVENT_SEQ, seq) && wr_arr(d, HDR::EVENT_HEAD, head),
        "chain write",
    )
}

/// Stage a complete expected post-state, never apply it. A stage is not a proof
/// that the supplied input existed. The candidate deliberately supports only
/// current-generation original sources and voluntary zero-payload Leave.
pub fn stage(c: &Context, b: &[Account]) -> R<Staged> {
    let (n, si, pi, ri, hi, oi, required): (usize, usize, usize, usize, usize, usize, &[usize]) =
        match c.action {
            Action::Dissolve => (8, 2, 5, 6, 4, 7, &[1, 3, 4, 5]),
            Action::Return => (6, 1, 2, 3, 4, 5, &[0, 2, 3, 4]),
        };
    need(b.len() == n, "exact role count")?;
    for (i, a) in b.iter().enumerate() {
        need(
            !a.executable && a.data.len() <= 65_536,
            "executable or oversized account",
        )?;
        need(
            a.present != (a.owner == [0; 32] && a.data.is_empty()),
            "absence predicate",
        )?;
        need(
            !required.contains(&i) || a.writable,
            "writable role required",
        )?;
        for (j, p) in b[..i].iter().enumerate() {
            if p.address == a.address {
                need(
                    c.action == Action::Dissolve && (j, i) == (0, 1) && p == a,
                    "unsupported or inconsistent alias",
                )?;
            }
        }
    }
    need(
        b[0].signer && (c.action != Action::Dissolve || b[1].signer),
        "signer role required",
    )?;
    need(b[si].address == c.season, "season address")?;
    let sd = &b[si].data;
    let sid = rd_u64(sd, HDR::SEASON_ID).ok_or("season id")?;
    header(&b[si], c, S::MAGIC, S::SIZE, sid)?;
    let bump = sd[S::BUMP];
    need(
        c.season
            == sha256(&[
                S::PDA_PREFIX,
                &sid.to_le_bytes(),
                &[bump],
                &c.program,
                b"ProgramDerivedAddress",
            ]),
        "season PDA",
    )?;
    need(
        rd_arr::<32>(sd, S::RULESET_HASH) == Some(RULESET_HASH_V3),
        "ruleset",
    )?;
    // This candidate mirrors the tested non-NFT experimental build only.
    need(
        rd_u16(sd, S::PROGRAM_VERSION) == Some(economy::WIDE_S1_PROGRAM_VERSION),
        "unsupported program version",
    )?;
    let genesis = rd_i64(sd, S::GENESIS_TS).ok_or("genesis")?;
    let bell = economy::bell_at(genesis, c.now_ts).ok_or("clock/bell")?;
    let status = if sd[S::STATUS] == S::STATUS_SEEDED && c.now_ts >= genesis {
        S::STATUS_RUNNING
    } else {
        sd[S::STATUS]
    };
    need(
        status == S::STATUS_RUNNING || (c.action == Action::Return && status == S::STATUS_ENDED),
        "season status",
    )?;
    let ctx = AddrCtx {
        program: c.program,
        season: c.season,
    };
    let resolver = codec(AccountResolver::for_season(&ctx))?;
    let id = codec(resolver.legacy_host_id(&c.host))?;
    need(
        codec(resolver.legacy_host_ref(id))? == c.host,
        "noncanonical original host",
    )?;
    let h = &b[hi].data;
    header(&b[hi], c, H::MAGIC, H::SIZE, sid)?;
    header(&b[oi], c, P::MAGIC, P::SIZE, sid)?;
    need(
        b[hi].address == codec(resolver.holding_address(&c.host))?
            && b[oi].address == codec(resolver.province_address(c.host.key()))?,
        "source address",
    )?;
    let parts = addr::split_host_id(id).ok_or("host id")?;
    for (a, p, q) in [(&b[hi], H::P, H::Q), (&b[oi], P::P, P::Q)] {
        need(
            rd_i16(&a.data, p).map(i32::from) == Some(parts.province.p)
                && rd_i16(&a.data, q).map(i32::from) == Some(parts.province.q),
            "source coordinate",
        )?;
    }
    need(
        h[H::SITE] == parts.site
            && h[H::GEN] == c.host.gen()
            && matches!(h[H::STATE], H::STATE_PROVISIONAL | H::STATE_FINAL),
        "source generation/state",
    )?;
    need(
        c.host.seq() < rd_u32(h, H::HOST_SEQ).ok_or("issuance")?,
        "unissued host",
    )?;
    need(
        frontier_abi::v2::prologue::capture_locked(&b[oi].data, c.host.site(), c.host.gen())
            == Some(false),
        "source capture lock",
    )?;
    need(
        !codec(ap::host_in_transit_with_bridge(&ctx, &b[hi].address, h, id))?,
        "source transit open",
    )?;
    let owner = rd_arr::<32>(h, H::OWNER_CITIZEN).ok_or("source owner")?;
    need(owner != [0; 32], "zero source owner")?;
    let province = codec(WideProvince::read(&b[pi].data))?;
    let standing = ProvinceKey::new(province.world, province.coord);
    let identity = receipt::Identity {
        host: c.host,
        original_owner: owner,
        holding: b[hi].address,
        standing,
        province: b[pi].address,
    };
    codec(identity.validate(&ctx))?;
    need(
        b[pi].present && b[pi].owner == c.program && province.season_id == sid,
        "standing ownership/season",
    )?;
    let roster = codec(WideRoster::read(&b[ri].data))?;
    need(
        b[ri].present
            && b[ri].owner == c.program
            && roster.season_id == sid
            && roster.province == standing
            && b[ri].address == wro::roster_address(&ctx, standing),
        "roster ownership/address",
    )?;
    codec(roster.validate_paired(
        &b[ri].data,
        &codec(frontier_abi::world_index::resolve::live_ids(&b[pi].data))?,
    ))?;
    let index = find_entry(&b[pi].data, wide_host_alias(&c.host)).ok_or("host absent")?;
    let e = codec(read_entry(&b[pi].data, index))?;
    need(
        roster.entry_matches(&b[ri].data, index, e.id, &c.host) && (e.unit as usize) < H::RESERVE_N,
        "full host pairing/unit",
    )?;
    let rn = rd_u32(&b[pi].data, P::RESOLVED_NEXT).ok_or("cursor")?;
    let row = P::entry(index);
    let mut after = b.to_vec();
    let outcomes = match c.action {
        Action::Dissolve => {
            header(&b[3], c, C::MAGIC, C::SIZE, sid)?;
            need(b[3].address == owner, "citizen does not own source")?;
            // Canonical wallet/session prologue checks supplied claims only.
            let _ = codec(ap::player_prologue(
                &b[..4].iter().map(view).collect::<Vec<_>>(),
                &c.program,
                &RULESET_HASH_V3,
                c.now_ts,
                true,
            ))?;
            need(h[H::STATE] == H::STATE_FINAL, "source not final")?;
            let expected = SlotBinding::Legacy(wh::HoldingRef {
                p: parts.province.p as i16,
                q: parts.province.q as i16,
                site: parts.site,
                gen: c.host.gen(),
            });
            need(
                codec(wh::binding_of(&b[3].data, h[H::ORDER]))? == expected,
                "source inventory binding",
            )?;
            need(
                rn as u64 + 1 >= bell as u64 && e.state == E::STATE_ROSTER && e.from_bell <= bell,
                "not resident",
            )?;
            need(
                e.faction == b[3].data[C::FACTION] && !e.busy(),
                "host faction/busy",
            )?;
            need(
                bell < rd_u32(sd, S::END_BELL).ok_or("end bell")?,
                "end bell",
            )?;
            let mut economic = hold::read(h)?;
            let ore = hold::terrain_ore(h)?;
            codec(economy::preflight_holding(&economic, ore, c.now_ts))?;
            hold::touch(&mut economic, c.now_ts, ore)?;
            hold::write(&mut after[hi].data, &economic, c.now_ts)?;
            codec(economy::debit_bucket(
                &mut after[3].data,
                c.now_ts,
                genesis,
                rd_u16(sd, S::BUCKET_RATE_PER_H).ok_or("bucket rate")?,
                rd_u16(sd, S::BUCKET_BURST).ok_or("bucket burst")?,
            ))?;
            need(
                wr_i64(&mut after[3].data, C::LAST_ACTION_TS, c.now_ts),
                "action timestamp",
            )?;
            // Exact generic Leave encoding, preserving every other entry byte.
            after[pi].data[row + E::PEND_OP] = E::OP_LEAVE;
            need(
                wr_u32(&mut after[pi].data, row + E::PEND_BELL, bell),
                "pending bell",
            )?;
            after[pi].data[row + E::OP_A..row + E::SIZE].fill(0);
            receipt::Outcomes {
                entry: index as u8,
                unit: e.unit,
                troops_milli: e.troops,
                pending_bell: bell,
                credited_units: 0,
            }
        }
        Action::Return => {
            need(
                e.state == E::STATE_DEPARTED
                    && e.op == EntryOp::Leave
                    && rn > e.pend_bell
                    && e.pend_bell <= bell,
                "return not resolved",
            )?;
            need(
                b[pi].data[row + E::OP_A..row + E::SIZE]
                    .iter()
                    .all(|x| *x == 0),
                "unsupported retire/redirect payload",
            )?;
            let whole = e.troops / 1_000;
            let o = H::reserve(e.unit as usize);
            let reserve = rd_u32(h, o)
                .ok_or("reserve")?
                .checked_add(whole)
                .ok_or("reserve overflow")?;
            need(wr_u32(&mut after[hi].data, o, reserve), "reserve write")?;
            after[pi].data[row..row + E::SIZE].fill(0);
            after[pi].data[P::N_ENTRIES] = b[pi].data[P::N_ENTRIES]
                .checked_sub(1)
                .ok_or("entry count underflow")?;
            let o = wro::wide_roster::slot(index);
            after[ri].data[o..o + HOST_REF_LEN].fill(0);
            receipt::Outcomes {
                entry: index as u8,
                unit: e.unit,
                troops_milli: e.troops,
                pending_bell: e.pend_bell,
                credited_units: whole,
            }
        }
    };
    let command = c.host.to_bytes();
    let context = receipt::Context {
        command: &command,
        now_ts: c.now_ts,
        now_slot: c.now_slot,
        bell,
        season: sd,
    };
    let prepared = codec(receipt::prepare(
        &ctx,
        identity,
        c.action,
        &context,
        &snapshots(b),
        &snapshots(&after),
        outcomes,
    ))?;
    let original_indices: &[usize] = if c.action == Action::Dissolve {
        &[3, 4]
    } else {
        &[4]
    };
    need(
        prepared.original_links.len() == original_indices.len(),
        "original link count",
    )?;
    for (i, l) in original_indices.iter().zip(&prepared.original_links) {
        chain(&mut after[*i].data, l.seq, &l.head)?;
    }
    chain(
        &mut after[pi].data,
        prepared.wide_link.seq,
        &prepared.wide_link.head,
    )?;
    let operation_id = codec(receipt::Record::decode(&ctx, &prepared.original))?
        .receipt
        .operation_id;
    Ok(Staged {
        after,
        events: vec![prepared.original, prepared.wide],
        identity,
        outcomes,
        operation_id,
    })
}

/// Check exact independent post-state plus both ordered receipt bodies. Neither
/// records nor post-state can supply the effect chosen by the replay. No default
/// verifier result or feed cursor changes, and no action is queued or sent.
pub fn verify_transition(e: Evidence<'_>) -> R<Verified> {
    need(e.events.len() == 2, "exact PS2/PSW1 pair required")?;
    let ctx = AddrCtx {
        program: e.context.program,
        season: e.context.season,
    };
    let original = codec(receipt::Record::decode(&ctx, &e.events[0]))?;
    let wide = codec(receipt::Record::decode(&ctx, &e.events[1]))?;
    need(
        original.wide_link.is_none() && wide.wide_link.is_some(),
        "receipt emission order",
    )?;
    codec(original.pair(&wide))?;
    need(
        original.action == e.context.action && original.identity.host == e.context.host,
        "command/action mismatch",
    )?;
    let si = if e.context.action == Action::Dissolve {
        2
    } else {
        1
    };
    let expected_roles = if e.context.action == Action::Dissolve {
        8
    } else {
        6
    };
    need(
        e.before.len() == expected_roles && e.before.iter().all(|a| a.data.len() <= 65_536),
        "bounded input roles",
    )?;
    let command = e.context.host.to_bytes();
    let commitment_context = receipt::Context {
        command: &command,
        now_ts: e.context.now_ts,
        now_slot: e.context.now_slot,
        bell: original.bell,
        season: &e.before[si].data,
    };
    need(
        codec(receipt::input_digest(
            &ctx,
            original.identity,
            e.context.action,
            &commitment_context,
            &snapshots(e.before),
        ))? == original.receipt.input,
        "raw input commitment mismatch",
    )?;
    let staged = stage(e.context, e.before)?;
    need(
        staged.events == e.events,
        "receipt, context or chain mismatch",
    )?;
    need(staged.after == e.after, "complete post-state mismatch")?;
    Ok(Verified {
        action: e.context.action,
        identity: staged.identity,
        outcomes: staged.outcomes,
        operation_id: staged.operation_id,
    })
}
