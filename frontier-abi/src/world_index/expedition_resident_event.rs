//! PRIVATE-CANDIDATE original-origin resident dissolve/return receipts.
//! Provisional PS2/149 and PSW1/26 are decoded only here. No dispatcher,
//! authority, bridge settlement, conquest economics or public gate is added.
//! Ordered manifests commit to all supplied accounts and privileges, not to
//! authorization or provenance. Callers must independently authenticate the
//! wallet, issued current-generation host, source capture state and real
//! resident/Resolve history. A paired receipt alone establishes none of these.

pub use super::expedition_event::AccountSnapshot;
use super::{
    event,
    expedition::{AccountFamily, AccountResolver},
    key::{HOST_REF_LEN, PROVINCE_KEY_LEN},
    march::wide_host_alias,
    roster::{roster_address, WideRoster},
    ProvinceKey, WideHostRef, WideProvince,
};
use crate::{
    addr::AddrCtx,
    bytes::{rd_arr, rd_i16, rd_u16, rd_u32, rd_u64},
    entry::{read_entry, write_entry, Entry, EntryOp},
    layout::{header, province::entry as E},
    log::{self, EntityKind, Link},
    v2::layout::{
        player::{citizen as C, holding as H},
        province::province as P,
        world::season as S,
    },
};
use alloc::vec::Vec;
use permutation_rules::{fixed::MILLI, hash::sha256};

pub const ORIGINAL_KIND: u8 = 149;
pub const WIDE_KIND: u8 = 26;
pub const VERSION: u8 = 1;
pub const OUTCOMES_LEN: usize = 14;
pub const BODY_LEN: usize = 10 + HOST_REF_LEN + 3 * 32 + PROVINCE_KEY_LEN + OUTCOMES_LEN + 96;
pub const MAX_RECORD_LEN: usize = BODY_LEN + 1 + 2 * log::LINK_LEN;
const _: () = assert!(BODY_LEN == 322 && MAX_RECORD_LEN <= 800);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Shape,
    Identity,
    Manifest,
    Command,
    Effects,
    Outcome,
    Chain,
    Receipt,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Action {
    Dissolve = 1,
    Return = 2,
}
impl Action {
    fn decode(v: u8) -> Result<Self, Error> {
        match v {
            1 => Ok(Self::Dissolve),
            2 => Ok(Self::Return),
            _ => Err(Error::Shape),
        }
    }
    pub fn entities(self) -> &'static [EntityKind] {
        match self {
            Self::Dissolve => &[EntityKind::Citizen, EntityKind::Holding],
            Self::Return => &[EntityKind::Holding],
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Identity {
    pub host: WideHostRef,
    /// Original Citizen account key, never its wallet key. Retained on Return.
    pub original_owner: [u8; 32],
    pub holding: [u8; 32],
    pub standing: ProvinceKey,
    pub province: [u8; 32],
}
impl Identity {
    pub fn validate(self, ctx: &AddrCtx) -> Result<(), Error> {
        let r = AccountResolver::for_season(ctx).map_err(|_| Error::Identity)?;
        if r.family(self.host.key()).map_err(|_| Error::Identity)? != AccountFamily::Legacy
            || r.family(self.standing).map_err(|_| Error::Identity)? != AccountFamily::Wide
            || r.holding_address(&self.host).map_err(|_| Error::Identity)? != self.holding
            || r.province_address(self.standing)
                .map_err(|_| Error::Identity)?
                != self.province
        {
            return Err(Error::Identity);
        }
        r.legacy_host_id(&self.host).map_err(|_| Error::Identity)?;
        let addresses = [self.original_owner, self.holding, self.province];
        for (i, a) in addresses.iter().enumerate() {
            if *a == [0; 32] || addresses[..i].contains(a) {
                return Err(Error::Identity);
            }
        }
        Ok(())
    }
    pub fn original_targets(self, action: Action) -> Vec<(EntityKind, [u8; 32])> {
        let mut out = Vec::new();
        if action == Action::Dissolve {
            out.push((EntityKind::Citizen, self.original_owner));
        }
        out.push((EntityKind::Holding, self.holding));
        out
    }
    fn write(self, b: &mut Vec<u8>) {
        b.extend_from_slice(&self.host.to_bytes());
        b.extend_from_slice(&self.original_owner);
        b.extend_from_slice(&self.holding);
        b.extend_from_slice(&self.standing.to_bytes());
        b.extend_from_slice(&self.province);
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Context<'a> {
    /// Exactly the full 56-byte host reference; action is separately committed.
    pub command: &'a [u8],
    pub now_ts: i64,
    pub now_slot: u64,
    pub bell: u32,
    pub season: &'a [u8],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Outcomes {
    pub entry: u8,
    pub unit: u8,
    pub troops_milli: u32,
    pub pending_bell: u32,
    /// Whole reserve units, not milli troops. Zero for Dissolve.
    pub credited_units: u32,
}
impl Outcomes {
    fn validate(self, action: Action, bell: u32) -> Result<(), Error> {
        if self.entry as usize >= P::ENTRIES_N
            || crate::entry::unit_from_u8(self.unit).is_none()
            || self.pending_bell == log::NO_BELL
            || (action == Action::Dissolve
                && (self.pending_bell != bell || self.credited_units != 0))
            || (action == Action::Return
                && (self.pending_bell > bell
                    || self.credited_units != self.troops_milli / MILLI as u32))
        {
            return Err(Error::Outcome);
        }
        Ok(())
    }
    fn write(self, b: &mut Vec<u8>) {
        b.extend_from_slice(&[self.entry, self.unit]);
        for x in [self.troops_milli, self.pending_bell, self.credited_units] {
            b.extend_from_slice(&x.to_le_bytes());
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Receipt {
    pub operation_id: [u8; 32],
    pub input: [u8; 32],
    pub output: [u8; 32],
}
impl Receipt {
    pub fn new(input: [u8; 32], output: [u8; 32]) -> Self {
        Self {
            operation_id: sha256(&[b"PSF-BOUNDARY-RESIDENT-OP-v1", &input, &output]),
            input,
            output,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Prepared {
    pub original: Vec<u8>,
    pub original_links: Vec<Link>,
    pub wide: Vec<u8>,
    pub wide_link: event::WideLink,
}

fn same(a: &AccountSnapshot<'_>, b: &AccountSnapshot<'_>) -> bool {
    a.owner == b.owner && a.present == b.present && a.lamports == b.lamports && a.data == b.data
}
fn manifest(accounts: &[AccountSnapshot<'_>], normalized: &[[u8; 32]]) -> Result<[u8; 32], Error> {
    let mut h = sha256(&[
        b"PSF-BOUNDARY-RESIDENT-MANIFEST-v1",
        &(accounts.len() as u64).to_le_bytes(),
    ]);
    for (i, a) in accounts.iter().enumerate() {
        if a.role as usize != i + 1 || (!a.present && !a.data.is_empty()) {
            return Err(Error::Manifest);
        }
        for p in &accounts[..i] {
            if p.address == a.address && !same(p, a) {
                return Err(Error::Manifest);
            }
        }
        let norm;
        let data = if normalized.contains(&a.address) {
            if !a.present || a.data.len() < header::H_SIZE {
                return Err(Error::Manifest);
            }
            norm = event::normalize_chained(a.data);
            &norm[..]
        } else {
            a.data
        };
        let leaf = sha256(&[
            b"PSF-BOUNDARY-RESIDENT-ACCOUNT-v1",
            &a.role.to_le_bytes(),
            &a.address,
            &a.owner,
            &[a.present as u8, a.signer as u8, a.writable as u8],
            &a.lamports.to_le_bytes(),
            &(data.len() as u64).to_le_bytes(),
            data,
        ]);
        h = sha256(&[b"PSF-BOUNDARY-RESIDENT-ORDER-v1", &h, &leaf]);
    }
    Ok(h)
}
fn previous(a: &AccountSnapshot<'_>, ctx: &AddrCtx) -> Result<(u64, [u8; 32]), Error> {
    if !a.present || a.owner != ctx.program || !a.writable {
        return Err(Error::Chain);
    }
    Ok((
        rd_u64(a.data, header::EVENT_SEQ).ok_or(Error::Chain)?,
        rd_arr(a.data, header::EVENT_HEAD).ok_or(Error::Chain)?,
    ))
}
fn legacy(
    a: &AccountSnapshot<'_>,
    ctx: &AddrCtx,
    magic: [u8; 8],
    size: usize,
    season: u64,
) -> Result<(), Error> {
    if !a.present
        || a.owner != ctx.program
        || a.data.len() != size
        || rd_arr(a.data, header::MAGIC) != Some(magic)
        || rd_u64(a.data, header::SEASON_ID) != Some(season)
        || rd_u16(a.data, header::LAYOUT_VERSION) != Some(crate::v2::layout::LAYOUT_VERSION_V2)
        || a.data[18..24] != [0; 6]
    {
        return Err(Error::Identity);
    }
    Ok(())
}
fn same_except(a: &[u8], b: &[u8], ranges: &[core::ops::Range<usize>]) -> bool {
    a.len() == b.len()
        && a.iter()
            .zip(b)
            .enumerate()
            .all(|(i, (x, y))| x == y || ranges.iter().any(|r| r.contains(&i)))
}

fn context_digest(ctx: &AddrCtx, id: Identity, action: Action, c: &Context<'_>) -> [u8; 32] {
    let mut identity = Vec::new();
    id.write(&mut identity);
    sha256(&[
        b"PSF-BOUNDARY-RESIDENT-CONTEXT-v1",
        &ctx.program,
        &ctx.season,
        &[VERSION, action as u8],
        &identity,
        &c.now_ts.to_le_bytes(),
        &c.now_slot.to_le_bytes(),
        &c.bell.to_le_bytes(),
        &(c.command.len() as u64).to_le_bytes(),
        c.command,
        &(c.season.len() as u64).to_le_bytes(),
        c.season,
    ])
}

/// Raw pre-state commitment for detached readers before effect replay. This
/// computes the receipt definition only; it establishes no authentication,
/// canonical state provenance or handler admission. No economic code runs.
pub fn input_digest(
    ctx: &AddrCtx,
    id: Identity,
    action: Action,
    c: &Context<'_>,
    before: &[AccountSnapshot<'_>],
) -> Result<[u8; 32], Error> {
    id.validate(ctx)?;
    if c.command != id.host.to_bytes() {
        return Err(Error::Command);
    }
    Ok(sha256(&[
        b"PSF-BOUNDARY-RESIDENT-INPUT-v1",
        &context_digest(ctx, id, action, c),
        &manifest(before, &[])?,
    ]))
}

/// Exact private account shapes. Dissolve: actor, payer, Season, Citizen,
/// original Holding, wide standing Province, readonly WideRoster, original
/// home Province. Return: payer, Season, wide Province, WideRoster, original
/// Holding, original home Province. The snapshots are staged before chain
/// writes. Account metadata and all balances must remain unchanged.
pub fn prepare(
    ctx: &AddrCtx,
    id: Identity,
    action: Action,
    c: &Context<'_>,
    before: &[AccountSnapshot<'_>],
    after: &[AccountSnapshot<'_>],
    o: Outcomes,
) -> Result<Prepared, Error> {
    id.validate(ctx)?;
    o.validate(action, c.bell)?;
    if c.command != id.host.to_bytes() {
        return Err(Error::Command);
    }
    let (n, si, hi, pi, ri, oi) = match action {
        Action::Dissolve => (8, 2, 4, 5, 6, 7),
        Action::Return => (6, 1, 4, 2, 3, 5),
    };
    if before.len() != n || after.len() != n {
        return Err(Error::Manifest);
    }
    let r = AccountResolver::for_season(ctx).map_err(|_| Error::Identity)?;
    if before[si].address != ctx.season
        || before[si].data != c.season
        || before[hi].address != id.holding
        || before[pi].address != id.province
        || before[ri].address != roster_address(ctx, id.standing)
        || before[oi].address
            != r.province_address(id.host.key())
                .map_err(|_| Error::Identity)?
        || !before[0].signer
        || !before[if action == Action::Dissolve { 1 } else { 0 }].signer
        || !before[if action == Action::Dissolve { 1 } else { 0 }].writable
        || (action == Action::Dissolve && before[3].address != id.original_owner)
        || (action == Action::Return && !before[ri].writable)
    {
        return Err(Error::Manifest);
    }
    let season = rd_u64(c.season, header::SEASON_ID).ok_or(Error::Manifest)?;
    legacy(&before[si], ctx, S::MAGIC, S::SIZE, season)?;
    legacy(&before[hi], ctx, H::MAGIC, H::SIZE, season)?;
    legacy(&before[oi], ctx, P::MAGIC, P::SIZE, season)?;
    let coord = r
        .adapter()
        .coord_of(&id.host.key())
        .map_err(|_| Error::Identity)?;
    for (a, po, qo) in [(&before[hi], H::P, H::Q), (&before[oi], P::P, P::Q)] {
        if rd_i16(a.data, po).map(i32::from) != Some(coord.p)
            || rd_i16(a.data, qo).map(i32::from) != Some(coord.q)
        {
            return Err(Error::Identity);
        }
    }
    let h = before[hi].data;
    if h[H::SITE] != id.host.site()
        || h[H::GEN] != id.host.gen()
        || rd_arr(h, H::OWNER_CITIZEN) != Some(id.original_owner)
        || rd_u32(h, H::HOST_SEQ).is_none_or(|seq| id.host.seq() >= seq)
        || !matches!(h[H::STATE], H::STATE_PROVISIONAL | H::STATE_FINAL)
        || (action == Action::Dissolve && h[H::STATE] != H::STATE_FINAL)
    {
        return Err(Error::Identity);
    }
    if action == Action::Dissolve {
        legacy(&before[3], ctx, C::MAGIC, C::SIZE, season)?;
        let wallet = rd_arr(before[3].data, C::WALLET).ok_or(Error::Identity)?;
        // The canonical Citizen address is identity, not authentication. The
        // actual player prologue decides whether actor wallet/session is valid.
        if ctx.citizen(&wallet) != id.original_owner {
            return Err(Error::Identity);
        }
    }
    let prov = WideProvince::read(before[pi].data).map_err(|_| Error::Identity)?;
    let roster = WideRoster::read(before[ri].data).map_err(|_| Error::Identity)?;
    if !before[pi].present
        || before[pi].owner != ctx.program
        || !before[ri].present
        || before[ri].owner != ctx.program
        || prov.season_id != season
        || ProvinceKey::new(prov.world, prov.coord) != id.standing
        || roster.season_id != season
        || roster.province != id.standing
    {
        return Err(Error::Identity);
    }
    roster
        .validate_paired(
            before[ri].data,
            &super::resolve::live_ids(before[pi].data).map_err(|_| Error::Identity)?,
        )
        .map_err(|_| Error::Identity)?;
    if !roster.entry_matches(
        before[ri].data,
        o.entry as usize,
        wide_host_alias(&id.host),
        &id.host,
    ) {
        return Err(Error::Identity);
    }

    let targets = id.original_targets(action);
    let mut chained: Vec<_> = targets.iter().map(|(_, a)| *a).collect();
    chained.push(id.province);
    for (a, b) in before.iter().zip(after) {
        if a.role != b.role
            || a.address != b.address
            || a.signer != b.signer
            || a.writable != b.writable
            || a.owner != b.owner
            || a.present != b.present
            || a.lamports != b.lamports
            || a.data.len() != b.data.len()
            || (!same(a, b) && !a.writable)
            || (!chained.contains(&a.address)
                && !(action == Action::Return && a.address == before[ri].address)
                && !same(a, b))
        {
            return Err(Error::Effects);
        }
        if chained.contains(&a.address) {
            previous(a, ctx)?;
            previous(b, ctx)?;
            if a.data[header::EVENT_SEQ..header::H_SIZE]
                != b.data[header::EVENT_SEQ..header::H_SIZE]
            {
                return Err(Error::Chain);
            }
        }
    }
    let mut e = read_entry(before[pi].data, o.entry as usize).map_err(|_| Error::Outcome)?;
    if e.id != wide_host_alias(&id.host) || e.unit != o.unit || e.troops != o.troops_milli {
        return Err(Error::Outcome);
    }
    let mut expected_p = before[pi].data.to_vec();
    match action {
        Action::Dissolve => {
            if e.state != E::STATE_ROSTER || e.busy() {
                return Err(Error::Outcome);
            }
            e.op = EntryOp::Leave;
            e.pend_bell = o.pending_bell;
            write_entry(&mut expected_p, o.entry as usize, &e).map_err(|_| Error::Outcome)?;
            if !same_except(
                before[3].data,
                after[3].data,
                &[
                    C::BUCKET_MILLI..C::BUCKET_T + 4,
                    C::LAST_ACTION_TS..C::LAST_ACTION_TS + 8,
                ],
            ) || after[3].data[C::LAST_ACTION_TS..C::LAST_ACTION_TS + 8]
                != c.now_ts.to_le_bytes()
                || !same_except(
                    h,
                    after[hi].data,
                    &[
                        H::TIER..H::FLAGS + 1,
                        H::LAST_OWNER_ACTION..H::LAST_OWNER_ACTION + 8,
                        H::STORES..H::FOOD_SHORTFALL + 8,
                    ],
                )
                || (h[H::FLAGS] ^ after[hi].data[H::FLAGS]) & !H::FLAG_DORMANT_CACHE != 0
            {
                return Err(Error::Effects);
            }
        }
        Action::Return => {
            // Entry::read intentionally ignores Leave's raw payload. This
            // candidate accepts only voluntary Dissolve, not retire/redirect
            // markers hidden in OP_A, OP_B, OP_TROOPS or OP_REF.
            let entry_offset = P::entry(o.entry as usize);
            if e.state != E::STATE_DEPARTED
                || e.op != EntryOp::Leave
                || e.pend_bell != o.pending_bell
                || rd_u32(before[pi].data, P::RESOLVED_NEXT).is_none_or(|b| b <= o.pending_bell)
                || before[pi].data[entry_offset + E::OP_A..entry_offset + E::SIZE]
                    .iter()
                    .any(|b| *b != 0)
            {
                return Err(Error::Outcome);
            }
            write_entry(&mut expected_p, o.entry as usize, &Entry::FREE)
                .map_err(|_| Error::Outcome)?;
            expected_p[P::N_ENTRIES] = expected_p[P::N_ENTRIES]
                .checked_sub(1)
                .ok_or(Error::Effects)?;
            let mut expected_r = before[ri].data.to_vec();
            roster
                .release(&mut expected_r, o.entry as usize)
                .map_err(|_| Error::Effects)?;
            if expected_r != after[ri].data {
                return Err(Error::Effects);
            }
            let mut expected_h = h.to_vec();
            let offset = H::reserve(o.unit as usize);
            let reserve = rd_u32(h, offset)
                .ok_or(Error::Effects)?
                .checked_add(o.credited_units)
                .ok_or(Error::Effects)?;
            expected_h[offset..offset + 4].copy_from_slice(&reserve.to_le_bytes());
            if expected_h != after[hi].data {
                return Err(Error::Effects);
            }
        }
    }
    if expected_p != after[pi].data {
        return Err(Error::Effects);
    }

    let context = context_digest(ctx, id, action, c);
    let mut outcome = Vec::new();
    o.write(&mut outcome);
    let input = input_digest(ctx, id, action, c, before)?;
    let output = sha256(&[
        b"PSF-BOUNDARY-RESIDENT-OUTPUT-v1",
        &context,
        &manifest(after, &chained)?,
        &outcome,
    ]);
    let receipt = Receipt::new(input, output);
    let mut original = body(false, action, c.bell, id, o, receipt);
    let mut original_links = Vec::new();
    for (entity, address) in targets {
        let a = before
            .iter()
            .find(|a| a.address == address)
            .ok_or(Error::Manifest)?;
        let (seq, head) = previous(a, ctx)?;
        original_links.push(log::advance(entity, seq, &head, &original).ok_or(Error::Chain)?);
    }
    original.push(original_links.len() as u8);
    for l in &original_links {
        tail(&mut original, l.entity as u8, l.seq, &l.head);
    }
    let mut wide = body(true, action, c.bell, id, o, receipt);
    let (seq, head) = previous(&before[pi], ctx)?;
    let wide_link =
        event::advance(event::WideEntity::Province, seq, &head, &wide).ok_or(Error::Chain)?;
    wide.push(1);
    tail(
        &mut wide,
        wide_link.entity as u8,
        wide_link.seq,
        &wide_link.head,
    );
    Ok(Prepared {
        original,
        original_links,
        wide,
        wide_link,
    })
}

fn body(wide: bool, action: Action, bell: u32, id: Identity, o: Outcomes, r: Receipt) -> Vec<u8> {
    let mut b = alloc::vec![
        if wide {
            event::WIDE_EVENT_VERSION
        } else {
            log::VERSION
        },
        if wide { WIDE_KIND } else { ORIGINAL_KIND }
    ];
    b.extend_from_slice(&bell.to_le_bytes());
    b.extend_from_slice(&[VERSION, action as u8, 0, 0]);
    id.write(&mut b);
    o.write(&mut b);
    for d in [r.operation_id, r.input, r.output] {
        b.extend_from_slice(&d);
    }
    b
}
fn tail(b: &mut Vec<u8>, entity: u8, seq: u64, head: &[u8; 32]) {
    b.push(entity);
    b.extend_from_slice(&seq.to_le_bytes());
    b.extend_from_slice(head);
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Record {
    pub action: Action,
    pub bell: u32,
    pub identity: Identity,
    pub outcomes: Outcomes,
    pub receipt: Receipt,
    pub original_links: Vec<Link>,
    pub wide_link: Option<event::WideLink>,
}
impl Record {
    pub fn decode(ctx: &AddrCtx, b: &[u8]) -> Result<Self, Error> {
        if b.len() < BODY_LEN + 1
            || b.len() > MAX_RECORD_LEN
            || b[6] != VERSION
            || b[8..10] != [0, 0]
        {
            return Err(Error::Shape);
        }
        let wide = match (b[0], b[1]) {
            (log::VERSION, ORIGINAL_KIND) => false,
            (event::WIDE_EVENT_VERSION, WIDE_KIND) => true,
            _ => return Err(Error::Shape),
        };
        let action = Action::decode(b[7])?;
        let bell = u32::from_le_bytes(b[2..6].try_into().unwrap());
        let mut at = 10;
        fn take<const N: usize>(b: &[u8], at: &mut usize) -> [u8; N] {
            let value = b[*at..*at + N].try_into().unwrap();
            *at += N;
            value
        }
        let identity = Identity {
            host: WideHostRef::from_bytes(&take::<HOST_REF_LEN>(b, &mut at))
                .map_err(|_| Error::Identity)?,
            original_owner: take(b, &mut at),
            holding: take(b, &mut at),
            standing: ProvinceKey::from_bytes(&take::<PROVINCE_KEY_LEN>(b, &mut at))
                .map_err(|_| Error::Identity)?,
            province: take(b, &mut at),
        };
        identity.validate(ctx)?;
        let outcomes = Outcomes {
            entry: take::<1>(b, &mut at)[0],
            unit: take::<1>(b, &mut at)[0],
            troops_milli: u32::from_le_bytes(take(b, &mut at)),
            pending_bell: u32::from_le_bytes(take(b, &mut at)),
            credited_units: u32::from_le_bytes(take(b, &mut at)),
        };
        outcomes.validate(action, bell)?;
        let operation_id = take(b, &mut at);
        let input = take(b, &mut at);
        let output = take(b, &mut at);
        let receipt = Receipt::new(input, output);
        if operation_id != receipt.operation_id {
            return Err(Error::Receipt);
        }
        let count = if wide { 1 } else { action.entities().len() };
        if b[at] as usize != count || b.len() != at + 1 + count * log::LINK_LEN {
            return Err(Error::Shape);
        }
        at += 1;
        let mut original_links = Vec::new();
        let mut wide_link = None;
        for i in 0..count {
            let entity = take::<1>(b, &mut at)[0];
            let seq = u64::from_le_bytes(take(b, &mut at));
            let head = take(b, &mut at);
            if seq == 0 {
                return Err(Error::Chain);
            }
            if wide {
                if entity != event::WideEntity::Province as u8 {
                    return Err(Error::Chain);
                }
                wide_link = Some(event::WideLink {
                    entity: event::WideEntity::Province,
                    seq,
                    head,
                });
            } else {
                let expected = action.entities()[i];
                if entity != expected as u8 {
                    return Err(Error::Chain);
                }
                original_links.push(Link {
                    entity: expected,
                    seq,
                    head,
                });
            }
        }
        Ok(Self {
            action,
            bell,
            identity,
            outcomes,
            receipt,
            original_links,
            wide_link,
        })
    }
    fn shape(&self) -> Result<(), Error> {
        self.outcomes.validate(self.action, self.bell)?;
        if self.receipt != Receipt::new(self.receipt.input, self.receipt.output) {
            return Err(Error::Receipt);
        }
        if let Some(l) = self.wide_link {
            if !self.original_links.is_empty()
                || l.entity != event::WideEntity::Province
                || l.seq == 0
            {
                return Err(Error::Chain);
            }
        } else if self.original_links.len() != self.action.entities().len()
            || self
                .original_links
                .iter()
                .zip(self.action.entities())
                .any(|(l, e)| l.entity != *e || l.seq == 0)
        {
            return Err(Error::Chain);
        }
        Ok(())
    }
    /// Pairing is not history verification; verify both against authenticated
    /// previous headers at the addresses returned by `original_targets` and
    /// `identity.province`. No manifest can substitute for authorization.
    pub fn pair(&self, other: &Self) -> Result<(), Error> {
        self.shape()?;
        other.shape()?;
        if self.wide_link.is_some() == other.wide_link.is_some()
            || self.action != other.action
            || self.bell != other.bell
            || self.identity != other.identity
            || self.outcomes != other.outcomes
            || self.receipt != other.receipt
        {
            return Err(Error::Receipt);
        }
        Ok(())
    }
    pub fn verify_previous(
        &self,
        ctx: &AddrCtx,
        original: &[Link],
        wide: Option<event::WideLink>,
    ) -> Result<(), Error> {
        self.identity.validate(ctx)?;
        self.shape()?;
        let b = body(
            self.wide_link.is_some(),
            self.action,
            self.bell,
            self.identity,
            self.outcomes,
            self.receipt,
        );
        if let Some(actual) = self.wide_link {
            let p = wide.ok_or(Error::Chain)?;
            if !original.is_empty()
                || p.entity != event::WideEntity::Province
                || event::advance(p.entity, p.seq, &p.head, &b) != Some(actual)
            {
                return Err(Error::Chain);
            }
        } else {
            if wide.is_some() || original.len() != self.original_links.len() {
                return Err(Error::Chain);
            }
            for (p, a) in original.iter().zip(&self.original_links) {
                if p.entity != a.entity || log::advance(p.entity, p.seq, &p.head, &b) != Some(*a) {
                    return Err(Error::Chain);
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bytes::{wr_arr, wr_i16, wr_u16, wr_u32, wr_u64};
    use crate::world_index::{land, roster::wide_roster, WideCoord, WorldId};

    struct Fixture {
        ctx: AddrCtx,
        id: Identity,
        action: Action,
        keys: Vec<[u8; 32]>,
        before: Vec<Vec<u8>>,
        after: Vec<Vec<u8>>,
        outcomes: Outcomes,
    }
    fn header_bytes(size: usize, magic: [u8; 8]) -> Vec<u8> {
        let mut d = alloc::vec![0; size];
        assert!(wr_arr(&mut d, header::MAGIC, &magic));
        assert!(wr_u64(&mut d, header::SEASON_ID, 11));
        assert!(wr_u16(&mut d, header::LAYOUT_VERSION, 2));
        d
    }
    impl Fixture {
        fn new(action: Action) -> Self {
            let ctx = AddrCtx {
                program: [4; 32],
                season: [3; 32],
            };
            let r = AccountResolver::for_season(&ctx).unwrap();
            // Sequence zero is the first issued original host, not a phantom.
            let host = r
                .legacy_host_ref(crate::addr::host_id(128, 0, 1, 2, 0).unwrap())
                .unwrap();
            let standing =
                ProvinceKey::new(r.adapter().world(), WideCoord::checked(129, 0).unwrap());
            let wallet = [7; 32];
            let id = Identity {
                host,
                original_owner: ctx.citizen(&wallet),
                holding: r.holding_address(&host).unwrap(),
                standing,
                province: r.province_address(standing).unwrap(),
            };
            let mut citizen = header_bytes(C::SIZE, C::MAGIC);
            assert!(wr_arr(&mut citizen, C::WALLET, &wallet));
            let mut holding = header_bytes(H::SIZE, H::MAGIC);
            assert!(wr_i16(&mut holding, H::P, 128));
            holding[H::SITE] = host.site();
            holding[H::GEN] = host.gen();
            holding[H::STATE] = H::STATE_FINAL;
            assert!(wr_arr(&mut holding, H::OWNER_CITIZEN, &id.original_owner));
            assert!(wr_u32(&mut holding, H::HOST_SEQ, 1));
            assert!(wr_u32(&mut holding, H::reserve(2), 12));
            let mut home = header_bytes(P::SIZE, P::MAGIC);
            assert!(wr_i16(&mut home, P::P, 128));
            let mut province = alloc::vec![0; land::province::SIZE];
            WideProvince {
                season_id: 11,
                world: standing.world(),
                coord: standing.coord(),
                wedge: standing.coord().wedge().unwrap(),
                region: 0,
                opened_bell: 1,
                readiness: land::readiness::REQUIRED,
                seed_round: 100,
                ring_seed: [9; 32],
                funded_lamports: 50,
            }
            .write_identity(&mut province)
            .unwrap();
            let roster = WideRoster::new(11, standing, [8; 32]);
            let mut roster_bytes = alloc::vec![0; wide_roster::SIZE];
            roster.write_header(&mut roster_bytes).unwrap();
            let alias = roster.claim(&mut roster_bytes, 2, &host).unwrap();
            let mut entry = Entry {
                id: alias,
                unit: 2,
                state: E::STATE_ROSTER,
                troops: 12_345,
                ..Entry::FREE
            };
            if action == Action::Return {
                entry.state = E::STATE_DEPARTED;
                entry.op = EntryOp::Leave;
                entry.pend_bell = 9;
            }
            write_entry(&mut province, 2, &entry).unwrap();
            province[P::N_ENTRIES] = 1;
            assert!(wr_u32(&mut province, P::RESOLVED_NEXT, 10));
            let outcomes = Outcomes {
                entry: 2,
                unit: 2,
                troops_milli: 12_345,
                pending_bell: 9,
                credited_units: if action == Action::Return { 12 } else { 0 },
            };
            let keys = alloc::vec![
                wallet,
                [8; 32],
                ctx.season,
                id.original_owner,
                id.holding,
                id.province,
                roster_address(&ctx, standing),
                r.province_address(host.key()).unwrap()
            ];
            let before = alloc::vec![
                Vec::new(),
                Vec::new(),
                header_bytes(S::SIZE, S::MAGIC),
                citizen,
                holding,
                province,
                roster_bytes,
                home
            ];
            let mut after = before.clone();
            match action {
                Action::Dissolve => {
                    entry.op = EntryOp::Leave;
                    entry.pend_bell = 9;
                    write_entry(&mut after[5], 2, &entry).unwrap();
                    after[3][C::LAST_ACTION_TS..C::LAST_ACTION_TS + 8]
                        .copy_from_slice(&99i64.to_le_bytes());
                    assert!(wr_u32(&mut after[3], C::BUCKET_MILLI, 1000));
                    after[4][H::STORES] = 1;
                }
                Action::Return => {
                    write_entry(&mut after[5], 2, &Entry::FREE).unwrap();
                    after[5][P::N_ENTRIES] = 0;
                    roster.release(&mut after[6], 2).unwrap();
                    assert!(wr_u32(&mut after[4], H::reserve(2), 24));
                }
            }
            if action == Action::Return {
                let indices = [1, 2, 5, 6, 4, 7];
                Self {
                    ctx,
                    id,
                    action,
                    keys: indices.iter().map(|i| keys[*i]).collect(),
                    before: indices.iter().map(|i| before[*i].clone()).collect(),
                    after: indices.iter().map(|i| after[*i].clone()).collect(),
                    outcomes,
                }
            } else {
                Self {
                    ctx,
                    id,
                    action,
                    keys,
                    before,
                    after,
                    outcomes,
                }
            }
        }
        fn snapshots<'a>(&self, data: &'a [Vec<u8>]) -> Vec<AccountSnapshot<'a>> {
            let wallets = if self.action == Action::Dissolve {
                2
            } else {
                1
            };
            data.iter()
                .enumerate()
                .map(|(i, d)| AccountSnapshot {
                    role: (i + 1) as u16,
                    address: self.keys[i],
                    owner: if i < wallets {
                        [0; 32]
                    } else {
                        self.ctx.program
                    },
                    present: true,
                    signer: i < wallets,
                    writable: if self.action == Action::Dissolve {
                        [1, 3, 4, 5].contains(&i)
                    } else {
                        [0, 2, 3, 4].contains(&i)
                    },
                    lamports: 100,
                    data: d,
                })
                .collect()
        }
        fn context<'a>(&'a self, command: &'a [u8]) -> Context<'a> {
            Context {
                command,
                now_ts: 99,
                now_slot: 88,
                bell: if self.action == Action::Dissolve {
                    9
                } else {
                    10
                },
                season: &self.before[if self.action == Action::Dissolve {
                    2
                } else {
                    1
                }],
            }
        }
        fn prepare(&self) -> Result<Prepared, Error> {
            prepare(
                &self.ctx,
                self.id,
                self.action,
                &self.context(&self.id.host.to_bytes()),
                &self.snapshots(&self.before),
                &self.snapshots(&self.after),
                self.outcomes,
            )
        }
    }

    #[test]
    fn paired_dissolve_and_return_use_exact_original_and_wide_chains() {
        for action in [Action::Dissolve, Action::Return] {
            let f = Fixture::new(action);
            let p = f.prepare().unwrap();
            assert_eq!(
                p.original.len(),
                BODY_LEN + 1 + action.entities().len() * log::LINK_LEN
            );
            assert_eq!(p.wide.len(), BODY_LEN + 1 + log::LINK_LEN);
            let original = Record::decode(&f.ctx, &p.original).unwrap();
            let wide = Record::decode(&f.ctx, &p.wide).unwrap();
            original.pair(&wide).unwrap();
            wide.pair(&original).unwrap();
            assert_eq!(original.identity, f.id);
            assert_eq!(original.outcomes, f.outcomes);
            let previous: Vec<_> = action
                .entities()
                .iter()
                .map(|e| Link {
                    entity: *e,
                    seq: 0,
                    head: [0; 32],
                })
                .collect();
            original.verify_previous(&f.ctx, &previous, None).unwrap();
            wide.verify_previous(
                &f.ctx,
                &[],
                Some(event::WideLink {
                    entity: event::WideEntity::Province,
                    seq: 0,
                    head: [0; 32],
                }),
            )
            .unwrap();
            assert_ne!(
                original.original_links.last().unwrap().head,
                wide.wide_link.unwrap().head
            );
            assert!(original.pair(&original).is_err());
        }
    }

    #[test]
    fn strict_lengths_versions_domains_reserved_and_tail_order() {
        for action in [Action::Dissolve, Action::Return] {
            let f = Fixture::new(action);
            let p = f.prepare().unwrap();
            for b in [&p.original, &p.wide] {
                for len in 0..b.len() {
                    assert!(Record::decode(&f.ctx, &b[..len]).is_err());
                }
                let mut bad = b.clone();
                bad.push(0);
                assert!(Record::decode(&f.ctx, &bad).is_err());
                for offset in [0, 1, 6, 7, 8, 9, BODY_LEN, BODY_LEN + 1] {
                    let mut bad = b.clone();
                    bad[offset] = 255;
                    assert!(Record::decode(&f.ctx, &bad).is_err(), "offset {offset}");
                }
                let mut bad = b.clone();
                bad[BODY_LEN + 2..BODY_LEN + 10].fill(0);
                assert_eq!(Record::decode(&f.ctx, &bad), Err(Error::Chain));
            }
            if action == Action::Dissolve {
                let mut bad = p.original.clone();
                let first = bad[BODY_LEN + 1..BODY_LEN + 1 + log::LINK_LEN].to_vec();
                bad.copy_within(BODY_LEN + 1 + log::LINK_LEN.., BODY_LEN + 1);
                bad[BODY_LEN + 1 + log::LINK_LEN..].copy_from_slice(&first);
                assert_eq!(Record::decode(&f.ctx, &bad), Err(Error::Chain));
            }
        }
    }

    #[test]
    fn decoder_and_previous_bind_full_world_family_addresses_and_outcomes() {
        let f = Fixture::new(Action::Dissolve);
        let p = f.prepare().unwrap();
        for offset in [10, 11, 98, 130, 131, 180, 212, 213, 218, 222, 226, 258, 290] {
            let mut bad = p.original.clone();
            bad[offset] ^= 128;
            assert!(Record::decode(&f.ctx, &bad).is_err(), "offset {offset}");
        }
        // A nonzero Citizen key cannot be authenticated from the record
        // alone. Full original headers still bind it through the body hash.
        let mut changed_owner = p.original.clone();
        changed_owner[66] ^= 128;
        let changed_owner = Record::decode(&f.ctx, &changed_owner).unwrap();
        let prior: Vec<_> = f
            .action
            .entities()
            .iter()
            .map(|e| Link {
                entity: *e,
                seq: 0,
                head: [0; 32],
            })
            .collect();
        assert_eq!(
            changed_owner.verify_previous(&f.ctx, &prior, None),
            Err(Error::Chain)
        );
        let mut wrong = f.id;
        wrong.standing = wrong.host.key();
        assert_eq!(wrong.validate(&f.ctx), Err(Error::Identity));
        wrong = f.id;
        wrong.standing = ProvinceKey::new(WorldId::new([1; 32]).unwrap(), wrong.standing.coord());
        assert_eq!(wrong.validate(&f.ctx), Err(Error::Identity));
        wrong = f.id;
        wrong.host = WideHostRef::new(f.id.standing, 1, 2, 0).unwrap();
        assert_eq!(wrong.validate(&f.ctx), Err(Error::Identity));
        let record = Record::decode(&f.ctx, &p.wide).unwrap();
        let wrong_ctx = AddrCtx {
            program: [99; 32],
            ..f.ctx
        };
        assert_eq!(
            record.verify_previous(&wrong_ctx, &[], None),
            Err(Error::Identity)
        );
        let mut bad = record.clone();
        bad.outcomes.credited_units = 1;
        assert_eq!(
            bad.pair(&Record::decode(&f.ctx, &p.original).unwrap()),
            Err(Error::Outcome)
        );
        let mut bad = record;
        bad.original_links.push(p.original_links[0]);
        assert_eq!(bad.verify_previous(&f.ctx, &[], None), Err(Error::Chain));
    }

    #[test]
    fn chain_corruption_cross_domain_and_overflow_are_refused() {
        let f = Fixture::new(Action::Return);
        let p = f.prepare().unwrap();
        let mut wide = Record::decode(&f.ctx, &p.wide).unwrap();
        let previous = event::WideLink {
            entity: event::WideEntity::Province,
            seq: 0,
            head: [0; 32],
        };
        wide.wide_link.as_mut().unwrap().head[0] ^= 1;
        assert_eq!(
            wide.verify_previous(&f.ctx, &[], Some(previous)),
            Err(Error::Chain)
        );
        let wrong_hash =
            log::advance(EntityKind::Province, 0, &[0; 32], &p.wide[..BODY_LEN]).unwrap();
        wide.wide_link.as_mut().unwrap().head = wrong_hash.head;
        assert_eq!(
            wide.verify_previous(&f.ctx, &[], Some(previous)),
            Err(Error::Chain)
        );
        let original = Record::decode(&f.ctx, &p.original).unwrap();
        assert_eq!(
            original.verify_previous(
                &f.ctx,
                &[Link {
                    entity: EntityKind::Holding,
                    seq: u64::MAX,
                    head: [0; 32]
                }],
                None
            ),
            Err(Error::Chain)
        );
        let mut f = Fixture::new(Action::Return);
        assert!(wr_u64(&mut f.before[4], header::EVENT_SEQ, u64::MAX));
        assert!(wr_u64(&mut f.after[4], header::EVENT_SEQ, u64::MAX));
        assert_eq!(f.prepare(), Err(Error::Chain));
    }

    #[test]
    fn complete_manifests_bind_order_aliases_presence_privileges_balances_and_raw_headers() {
        let raw = alloc::vec![0; 80];
        let mut changed = raw.clone();
        changed[24] = 1;
        let a = AccountSnapshot {
            role: 1,
            address: [1; 32],
            owner: [2; 32],
            present: true,
            signer: false,
            writable: true,
            lamports: 9,
            data: &raw,
        };
        let b = AccountSnapshot {
            data: &changed,
            ..a
        };
        assert_ne!(manifest(&[a], &[]).unwrap(), manifest(&[b], &[]).unwrap());
        assert_eq!(
            manifest(&[a], &[a.address]).unwrap(),
            manifest(&[b], &[a.address]).unwrap()
        );
        for b in [
            AccountSnapshot { signer: true, ..a },
            AccountSnapshot {
                writable: false,
                ..a
            },
            AccountSnapshot {
                owner: [9; 32],
                ..a
            },
            AccountSnapshot { lamports: 10, ..a },
            AccountSnapshot {
                address: [9; 32],
                ..a
            },
        ] {
            assert_ne!(manifest(&[a], &[]).unwrap(), manifest(&[b], &[]).unwrap());
        }
        assert!(manifest(
            &[AccountSnapshot {
                present: false,
                ..a
            }],
            &[]
        )
        .is_err());
        let empty = AccountSnapshot { data: &[], ..a };
        assert_ne!(
            manifest(&[empty], &[]).unwrap(),
            manifest(
                &[AccountSnapshot {
                    present: false,
                    ..empty
                }],
                &[]
            )
            .unwrap()
        );
        assert!(manifest(&[a, AccountSnapshot { role: 2, ..b }], &[]).is_err());
        assert!(manifest(&[AccountSnapshot { role: 2, ..a }], &[]).is_err());
        let second = AccountSnapshot {
            role: 2,
            address: [3; 32],
            ..a
        };
        assert_ne!(
            manifest(&[a, second], &[]).unwrap(),
            manifest(
                &[
                    AccountSnapshot { role: 1, ..second },
                    AccountSnapshot { role: 2, ..a }
                ],
                &[]
            )
            .unwrap()
        );
    }

    #[test]
    fn context_clock_and_input_headers_change_commitments_but_only_output_chains_normalize() {
        let f = Fixture::new(Action::Dissolve);
        let command = f.id.host.to_bytes();
        let c = f.context(&command);
        let first = Record::decode(&f.ctx, &f.prepare().unwrap().original).unwrap();
        assert_eq!(
            input_digest(&f.ctx, f.id, f.action, &c, &f.snapshots(&f.before)).unwrap(),
            first.receipt.input
        );
        let later = prepare(
            &f.ctx,
            f.id,
            f.action,
            &Context {
                now_slot: c.now_slot + 1,
                ..c
            },
            &f.snapshots(&f.before),
            &f.snapshots(&f.after),
            f.outcomes,
        )
        .unwrap();
        let later = Record::decode(&f.ctx, &later.original).unwrap();
        assert_ne!(first.receipt.input, later.receipt.input);
        assert_ne!(first.receipt.output, later.receipt.output);
        let mut f = f;
        f.before[4][header::EVENT_HEAD] = 7;
        f.after[4][header::EVENT_HEAD] = 7;
        let changed = Record::decode(&f.ctx, &f.prepare().unwrap().original).unwrap();
        assert_ne!(first.receipt.input, changed.receipt.input);
        assert_eq!(first.receipt.output, changed.receipt.output);
        assert_ne!(first.receipt.operation_id, changed.receipt.operation_id);
        f.after[4][header::EVENT_HEAD] = 8;
        assert_eq!(f.prepare(), Err(Error::Chain));
    }

    #[test]
    fn action_effect_bounds_refuse_wrong_credit_removal_and_source_mutations() {
        for (action, index, offset) in [
            (Action::Return, 4, H::reserve(2)),
            (Action::Return, 4, H::reserve(3)),
            (Action::Return, 4, H::HOST_SEQ),
            (Action::Return, 3, wide_roster::RENT_TO),
            (Action::Return, 2, P::ROSTER_EPOCH),
            (Action::Return, 2, P::N_ENTRIES),
            (Action::Dissolve, 3, C::WALLET),
            (Action::Dissolve, 4, H::reserve(2)),
            (Action::Dissolve, 4, H::HOST_SEQ),
            (Action::Dissolve, 5, P::N_ENTRIES),
            (Action::Dissolve, 6, wide_roster::RENT_TO),
            (Action::Dissolve, 7, P::RESOLVED_NEXT),
        ] {
            let mut f = Fixture::new(action);
            f.after[index][offset] ^= 1;
            assert!(f.prepare().is_err(), "{action:?}, {index}, {offset}");
        }
        for offset in [E::OP_A, E::OP_B, E::OP_TROOPS, E::OP_REF] {
            let mut f = Fixture::new(Action::Return);
            f.before[2][P::entry(2) + offset] = 1;
            assert_eq!(f.prepare(), Err(Error::Outcome), "raw Leave field {offset}");
        }
        let mut retired = Fixture::new(Action::Return);
        retired.before[2][P::entry(2) + E::OP_A] = crate::v2::entry::RETIRE_OP_A;
        let home_ref = (crate::addr::host_id(127, 0, 0, 1, 0).unwrap() >> 32) as u32;
        assert!(wr_u32(
            &mut retired.before[2],
            P::entry(2) + E::OP_REF,
            home_ref
        ));
        assert_eq!(retired.prepare(), Err(Error::Outcome));
        let mut f = Fixture::new(Action::Return);
        f.outcomes.credited_units += 1;
        assert_eq!(f.prepare(), Err(Error::Outcome));
        let mut f = Fixture::new(Action::Return);
        f.before[2][P::entry(2) + E::STATE] = E::STATE_ROSTER;
        assert_eq!(f.prepare(), Err(Error::Outcome));
        let mut f = Fixture::new(Action::Return);
        assert!(wr_u32(&mut f.before[2], P::RESOLVED_NEXT, 9));
        assert!(wr_u32(&mut f.after[2], P::RESOLVED_NEXT, 9));
        assert_eq!(f.prepare(), Err(Error::Outcome));
        let mut f = Fixture::new(Action::Return);
        assert!(wr_u32(&mut f.before[4], H::reserve(2), u32::MAX));
        assert_eq!(f.prepare(), Err(Error::Effects));
    }

    #[test]
    fn prepare_refuses_unissued_stale_source_wrong_roster_metadata_and_command() {
        for offset in [H::GEN, H::HOST_SEQ, H::OWNER_CITIZEN, H::P, H::SITE] {
            let mut f = Fixture::new(Action::Return);
            f.before[4][offset] ^= 1;
            f.after[4][offset] ^= 1;
            assert_eq!(f.prepare(), Err(Error::Identity));
        }
        let f = Fixture::new(Action::Dissolve);
        let command = f.id.host.to_bytes();
        let c = f.context(&command);
        let before = f.snapshots(&f.before);
        let after = f.snapshots(&f.after);
        for i in [0, 1, 3, 4, 5] {
            let mut a = before.clone();
            let mut b = after.clone();
            if i < 2 {
                a[i].signer = false;
                b[i].signer = false;
            } else {
                a[i].writable = false;
                b[i].writable = false;
            }
            assert!(prepare(&f.ctx, f.id, f.action, &c, &a, &b, f.outcomes).is_err());
        }
        for i in 0..before.len() {
            let mut after = after.clone();
            after[i].lamports += 1;
            assert_eq!(
                prepare(&f.ctx, f.id, f.action, &c, &before, &after, f.outcomes),
                Err(Error::Effects)
            );
        }
        let mut bad = command;
        bad[55] ^= 1;
        assert_eq!(
            prepare(
                &f.ctx,
                f.id,
                f.action,
                &Context { command: &bad, ..c },
                &before,
                &after,
                f.outcomes
            ),
            Err(Error::Command)
        );
        let mut bad = f;
        bad.keys[6] = [0; 32];
        assert_eq!(bad.prepare(), Err(Error::Manifest));
    }

    #[test]
    fn paired_records_do_not_hide_modified_public_fields_or_other_action() {
        let f = Fixture::new(Action::Return);
        let p = f.prepare().unwrap();
        let a = Record::decode(&f.ctx, &p.original).unwrap();
        let b = Record::decode(&f.ctx, &p.wide).unwrap();
        let mut bad = a.clone();
        bad.receipt.input[0] ^= 1;
        assert_eq!(bad.pair(&b), Err(Error::Receipt));
        let mut bad = a.clone();
        bad.original_links.clear();
        assert_eq!(bad.verify_previous(&f.ctx, &[], None), Err(Error::Chain));
        let mut bad = a.clone();
        bad.original_links[0].entity = EntityKind::Citizen;
        assert_eq!(bad.verify_previous(&f.ctx, &[], None), Err(Error::Chain));
        let mut bad = b;
        bad.bell += 1;
        assert_eq!(a.pair(&bad), Err(Error::Receipt));
        let d = Fixture::new(Action::Dissolve);
        let other = Record::decode(&d.ctx, &d.prepare().unwrap().wide).unwrap();
        assert_eq!(a.pair(&other), Err(Error::Receipt));
    }
}
