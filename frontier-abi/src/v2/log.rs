//! ABI v2 PS2 log records (MC contract §6): kinds 80–88 (89 reserved)
//! beside M1's, entity kind 8 (MarchState) in the tail, and a decoder and
//! chain table over both. The body encoding, the chain hash and the tail
//! order are M1's ([`crate::log`]); a v1 decoder refuses kinds ≥ 80 and
//! entity kind 8, so a reader of an MC season uses this module (R-22).
//!
//! **Soft size.** Every v2 body is ≤ 128 B except CONQUEST (137 B: 14
//! events, the records digest, the keep and the snapshot), a listed
//! exception like M1's CLASH and DEPART (notes D-4).

use crate::addr::split_host_id;
use crate::bytes::{rd_arr, rd_i32, rd_u64, rd_u8, Cursor, Writer};
use crate::log::{
    self as v1, chains_of as chains_of_v1, field as field_v1, CitizenRef, EntityKind as V1Entity,
    EntityRef, Kind as V1Kind, HEAD_LEN, MAX_LINKS, VERSION,
};
use permutation_rules::hash::sha256;

pub use crate::log::{next_head, LINK_LEN, PREFIX, SOFT_BODY_MAX};

/// Chained entity kinds of a v2 tail: M1's 1–7 and MarchState 8.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[repr(u8)]
pub enum EntityKind {
    Season = 1,
    Frontier = 2,
    JoinShard = 3,
    Citizen = 4,
    Holding = 5,
    Province = 6,
    ClashInputs = 7,
    MarchState = 8,
}

impl EntityKind {
    pub const ALL: [EntityKind; 8] = [
        EntityKind::Season,
        EntityKind::Frontier,
        EntityKind::JoinShard,
        EntityKind::Citizen,
        EntityKind::Holding,
        EntityKind::Province,
        EntityKind::ClashInputs,
        EntityKind::MarchState,
    ];
    pub fn from_u8(v: u8) -> Option<EntityKind> {
        Self::ALL.iter().copied().find(|k| *k as u8 == v)
    }
    pub fn of_v1(e: V1Entity) -> EntityKind {
        Self::from_u8(e as u8).unwrap_or(EntityKind::Season)
    }
    pub const fn account_kind(self) -> crate::v2::layout::AccountKind {
        use crate::v2::layout::AccountKind as A;
        match self {
            EntityKind::Season => A::Season,
            EntityKind::Frontier => A::Frontier,
            EntityKind::JoinShard => A::JoinShard,
            EntityKind::Citizen => A::Citizen,
            EntityKind::Holding => A::Holding,
            EntityKind::Province => A::Province,
            EntityKind::ClashInputs => A::ClashInputs,
            EntityKind::MarchState => A::MarchState,
        }
    }
}

macro_rules! cq_kinds {
    ($( $name:ident = $code:literal; key [$( $kf:literal : $kn:expr ),*]; payload [$( $pf:literal : $pn:expr ),*]; )*) => {
        /// The MC record kinds (§6).
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
        #[allow(non_camel_case_types)]
        #[repr(u8)]
        pub enum CqKind { $( $name = $code, )* }

        /// Key and payload fields of every MC kind.
        pub const CQ_SPECS: &[CqSpec] = &[ $( CqSpec {
            kind: CqKind::$name,
            name: stringify!($name),
            key: &[ $( ($kf, $kn), )* ],
            payload: &[ $( ($pf, $pn), )* ],
        }, )* ];

        impl CqKind {
            pub const fn from_u8(v: u8) -> Option<CqKind> {
                match v { $( $code => Some(CqKind::$name), )* _ => None }
            }
        }
    };
}

/// Field widths of one MC record kind.
#[derive(Clone, Copy, Debug)]
pub struct CqSpec {
    pub kind: CqKind,
    pub name: &'static str,
    pub key: &'static [(&'static str, usize)],
    pub payload: &'static [(&'static str, usize)],
}

/// Most events one CONQUEST record carries (12 sites, the keep, one spare).
pub const CONQUEST_EVENTS_MAX: usize = 14;
/// Bytes of one CONQUEST event `{site, code, faction, progress}`.
pub const EVENT_LEN: usize = 4;

cq_kinds! {
    SIEGE_DECLARED = 80; key ["p": 4, "q": 4, "site": 1]; payload ["attacker": 1, "owner_faction": 1, "target": 1, "declarer_tag": 8, "required": 1, "vigil_start": 2, "vigil_next": 2, "vigil_from_day": 2, "stake": 4, "src_key": 8, "owner_tag": 8, "lead_host_id": 8];
    SIEGE_SETTLED = 81; key ["p": 4, "q": 4, "site": 1]; payload ["reason": 1, "recipient_key": 8, "amount": 4, "burned": 4, "slot_released": 1];
    CONQUEST = 82; key ["p": 4, "q": 4, "bell": 4]; payload ["n": 1, "events": 56, "records_digest": 32, "keep_holder": 1, "keep_contender": 1, "keep_progress": 1, "keep_troops": 4, "donor_host_id": 8, "snapshot_present": 1, "weight": 14];
    CAPTURE_SETTLED = 83; key ["p": 4, "q": 4, "site": 1]; payload ["outcome": 1, "credited": 1, "captor_tag": 8, "victim_tag": 8, "new_gen": 1, "slot": 1, "rent_moved": 8, "bonds_refunded": 8, "walls_after": 4];
    KEEP = 84; key ["p": 4, "q": 4]; payload ["cause": 1, "holder": 1, "from": 1, "troops": 4, "consolidated_until": 4, "gen": 4];
    MARCH_FOLD = 85; key ["m": 4, "n": 4, "hour": 4]; payload ["weight": 28, "controller": 1, "contested": 1, "credit": 1, "lost": 1, "captures": 12];
    RETIRE = 86; key ["host_id": 8]; payload ["troops": 4, "home_key": 8, "by": 1];
    NEUTRAL = 87; key ["p": 4, "q": 4, "site": 1]; payload ["kind": 1, "garrison": 4, "tier": 1];
    OUTPOST_SETTLED = 88; key ["p": 4, "q": 4, "site": 1]; payload ["citizen_tag": 8, "order": 1, "gen": 1, "shield_until": 8, "anchor_key": 8];
}

/// Reserved record kind (never emitted).
pub const RESERVED_KIND: u8 = 89;

impl CqKind {
    pub fn spec(self) -> &'static CqSpec {
        // Every CqKind has exactly one entry (checked by a test).
        CQ_SPECS
            .iter()
            .find(|s| s.kind == self)
            .unwrap_or(&CQ_SPECS[0])
    }
    pub fn name(self) -> &'static str {
        self.spec().name
    }
}

/// CONQUEST event codes (§6). Bit 7 of a stored `code` is the event's
/// detail bit (notes D-5).
pub mod event {
    /// Detail bit: SIEGE_FAILED broken by the defender; CAPTURE_DUE
    /// credited; LIBERATED without Respite.
    pub const DETAIL: u8 = 0x80;
    pub const SIEGE_FAILED: u8 = 1;
    pub const OCCUPIED: u8 = 2;
    pub const CAPTURE_DUE: u8 = 3;
    pub const LIBERATED: u8 = 4;
    pub const OCCUPATION_EXPIRED: u8 = 5;
    /// Reserved (v1.0 FREE_CITY_EXPIRED).
    pub const RESERVED_6: u8 = 6;
    pub const KEEP_CONTEST: u8 = 7;
    pub const KEEP_BROKEN: u8 = 8;
    pub const KEEP_TAKEN: u8 = 9;
    /// Reserved for M3 (KEEP_PAUSED, unreachable under Rivalry).
    pub const KEEP_PAUSED_M3: u8 = 10;
    /// `site` of a keep event.
    pub const KEEP_SITE: u8 = 0xFE;
}

/// SIEGE_SETTLED reasons.
pub mod settle_reason {
    pub const TO_DEFENDER: u8 = 0;
    pub const TO_ATTACKER: u8 = 1;
    pub const SEASON_END: u8 = 2;
    pub const BURNED: u8 = 3;
}

/// CAPTURE_SETTLED outcomes (1 and 3 reserved: no raze in MC).
pub mod capture_outcome {
    pub const CAPTURE: u8 = 0;
    pub const FREE_CITY: u8 = 2;
}

/// KEEP causes.
pub mod keep_cause {
    pub const PLACED: u8 = 0;
    pub const TAKEN: u8 = 1;
}

/// RETIRE `by`.
pub mod retire_by {
    pub const VICTIM: u8 = 0;
    pub const AFTER_END: u8 = 1;
    pub const KEEP_DONOR: u8 = 2;
}

/// NEUTRAL kinds (1, 2 reserved).
pub mod neutral_kind {
    pub const GENESIS_FREE_CITY: u8 = 0;
}

/// A record kind of an ABI v2 log: M1's or MC's.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum AnyKind {
    V1(V1Kind),
    Cq(CqKind),
}

impl AnyKind {
    pub fn from_u8(v: u8) -> Option<AnyKind> {
        V1Kind::from_u8(v)
            .map(AnyKind::V1)
            .or_else(|| CqKind::from_u8(v).map(AnyKind::Cq))
    }
    pub fn code(self) -> u8 {
        match self {
            AnyKind::V1(k) => k as u8,
            AnyKind::Cq(k) => k as u8,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            AnyKind::V1(k) => k.name(),
            AnyKind::Cq(k) => k.name(),
        }
    }
    pub fn key(self) -> &'static [(&'static str, usize)] {
        match self {
            AnyKind::V1(k) => k.spec().key,
            AnyKind::Cq(k) => k.spec().key,
        }
    }
    pub fn payload(self) -> &'static [(&'static str, usize)] {
        match self {
            AnyKind::V1(k) => k.spec().payload,
            AnyKind::Cq(k) => k.spec().payload,
        }
    }
    pub fn key_len(self) -> usize {
        self.key().iter().map(|f| f.1).sum()
    }
    pub fn payload_len(self) -> usize {
        self.payload().iter().map(|f| f.1).sum()
    }
    pub fn body_len(self) -> usize {
        HEAD_LEN + self.key_len() + self.payload_len()
    }
}

/// Offset and width of a named key or payload field.
pub fn field(kind: AnyKind, name: &str, in_payload: bool) -> Option<(usize, usize)> {
    if let AnyKind::V1(k) = kind {
        return field_v1(k, name, in_payload);
    }
    let list = if in_payload {
        kind.payload()
    } else {
        kind.key()
    };
    let mut off = 0;
    for (n, w) in list {
        if *n == name {
            return Some((off, *w));
        }
        off += w;
    }
    None
}

/// One v2 tail link.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Link {
    pub entity: EntityKind,
    pub seq: u64,
    pub head: [u8; 32],
}

/// Advances one entity's chain (M1's rule).
pub fn advance(entity: EntityKind, seq: u64, head: &[u8; 32], bwt: &[u8]) -> Option<Link> {
    let seq = seq.checked_add(1)?;
    Some(Link {
        entity,
        seq,
        head: next_head(head, seq, bwt),
    })
}

/// Writes `body_without_tail` of any v2 kind.
pub fn write_body(
    kind: AnyKind,
    bell: u32,
    key: &[u8],
    payload: &[u8],
    out: &mut [u8],
) -> Option<usize> {
    if key.len() != kind.key_len() || payload.len() != kind.payload_len() {
        return None;
    }
    let mut w = Writer::new(out);
    w.u8(VERSION)
        .u8(kind.code())
        .u32(bell)
        .bytes(key)
        .bytes(payload);
    w.finish()
}

/// Appends a v2 tail (ascending entity kind).
pub fn write_tail(links: &[Link], out: &mut [u8], at: usize) -> Option<usize> {
    if links.len() > MAX_LINKS || links.windows(2).any(|w| w[0].entity > w[1].entity) {
        return None;
    }
    let mut w = Writer::new(out.get_mut(at..)?);
    w.u8(links.len() as u8);
    for l in links {
        w.u8(l.entity as u8).u64(l.seq).bytes(&l.head);
    }
    Some(at + w.finish()?)
}

/// A decoded v2 record.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Record<'a> {
    pub kind: AnyKind,
    pub bell: u32,
    pub key: &'a [u8],
    pub payload: &'a [u8],
    pub body_without_tail: &'a [u8],
    pub links: [Option<Link>; MAX_LINKS],
    pub n_links: usize,
}

/// Decodes a PS2 body of an M1 or MC kind (M1's error type).
pub fn decode(body: &[u8]) -> Result<Record<'_>, v1::LogError> {
    use v1::LogError as E;
    let mut c = Cursor::new(body);
    let ver = c.u8().ok_or(E::Short)?;
    if ver != VERSION {
        return Err(E::Version(ver));
    }
    let k = c.u8().ok_or(E::Short)?;
    let kind = AnyKind::from_u8(k).ok_or(E::UnknownKind(k))?;
    let bell = c.u32().ok_or(E::Short)?;
    let key = c.take(kind.key_len()).ok_or(E::Short)?;
    let payload = c.take(kind.payload_len()).ok_or(E::Short)?;
    let bwt = &body[..c.pos()];
    let n = c.u8().ok_or(E::Short)?;
    if n as usize > MAX_LINKS {
        return Err(E::TooManyLinks(n));
    }
    let mut links = [None; MAX_LINKS];
    let mut last = 0u8;
    for slot in links.iter_mut().take(n as usize) {
        let e = c.u8().ok_or(E::Short)?;
        let entity = EntityKind::from_u8(e).ok_or(E::UnknownEntity(e))?;
        if e < last {
            return Err(E::TailOrder);
        }
        last = e;
        let seq = c.u64().ok_or(E::Short)?;
        let head = c.arr::<32>().ok_or(E::Short)?;
        *slot = Some(Link { entity, seq, head });
    }
    if !c.done() {
        return Err(E::Trailing);
    }
    Ok(Record {
        kind,
        bell,
        key,
        payload,
        body_without_tail: bwt,
        links,
        n_links: n as usize,
    })
}

// ------------------------------------------------------------ chains

/// An entity a v2 record chains.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntityRefV2 {
    /// Any M1 entity reference.
    Base(EntityRef),
    /// A MarchState by its coordinates.
    March { m: i32, n: i32 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChainExpect {
    pub entity: EntityKind,
    pub who: EntityRefV2,
    pub optional: bool,
}

/// The expected chain links of one v2 record, in tail order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Chains {
    pub items: [Option<ChainExpect>; MAX_LINKS],
    pub len: usize,
}

impl Chains {
    const fn new() -> Self {
        Chains {
            items: [None; MAX_LINKS],
            len: 0,
        }
    }
    fn push(&mut self, entity: EntityKind, who: EntityRefV2, optional: bool) {
        if self.len < MAX_LINKS {
            self.items[self.len] = Some(ChainExpect {
                entity,
                who,
                optional,
            });
            self.len += 1;
        }
    }
    pub fn iter(&self) -> impl Iterator<Item = &ChainExpect> {
        self.items.iter().take(self.len).flatten()
    }
    pub fn bounds(&self) -> (usize, usize) {
        let min = self.iter().filter(|c| !c.optional).count();
        (min, self.len)
    }
    fn sort(&mut self) {
        for i in 1..self.len {
            let mut j = i;
            while j > 0 {
                match (self.items[j - 1], self.items[j]) {
                    (Some(x), Some(y)) if x.entity > y.entity => {
                        self.items.swap(j - 1, j);
                        j -= 1;
                    }
                    _ => break,
                }
            }
        }
    }
}

/// The entities a v2 record chains (§6 "Chains"), in tail order. M1
/// kinds keep M1's table ([`crate::log::chains_of`]).
pub fn chains_of(kind: AnyKind, key: &[u8], payload: &[u8]) -> Option<Chains> {
    use EntityKind as E;
    use EntityRefV2::{Base, March};
    let mut c = Chains::new();
    let k = match kind {
        AnyKind::V1(k) => {
            let v = chains_of_v1(k, key, payload)?;
            for x in v.iter() {
                c.push(EntityKind::of_v1(x.entity), Base(x.who), x.optional);
            }
            return Some(c);
        }
        AnyKind::Cq(k) => k,
    };
    let pay = |name: &str| -> Option<&[u8]> {
        let (o, w) = field(kind, name, true)?;
        payload.get(o..o + w)
    };
    let pq = || -> Option<(i32, i32)> { Some((rd_i32(key, 0)?, rd_i32(key, 4)?)) };
    let holding_of_key = |k: u64| -> Option<EntityRef> {
        let h = split_host_id(k)?;
        Some(EntityRef::Holding {
            p: h.province.p,
            q: h.province.q,
            site: h.site,
        })
    };
    match k {
        CqKind::SIEGE_DECLARED => {
            let (p, q) = pq()?;
            let declarer = CitizenRef::Tag8(rd_u64(pay("declarer_tag")?, 0)?);
            c.push(E::Citizen, Base(EntityRef::Citizen(declarer)), false);
            c.push(
                E::Holding,
                Base(holding_of_key(rd_u64(pay("src_key")?, 0)?)?),
                false,
            );
            c.push(E::Province, Base(EntityRef::Province { p, q }), false);
        }
        CqKind::SIEGE_SETTLED => {
            let (p, q) = pq()?;
            let reason = pay("reason")?[0];
            let rk = rd_u64(pay("recipient_key")?, 0)?;
            if reason != settle_reason::BURNED {
                // an absent recipient (or the wrong generation) burns the
                // stake without a chain
                if let Some(h) = holding_of_key(rk) {
                    c.push(E::Holding, Base(h), true);
                }
            }
            c.push(E::Province, Base(EntityRef::Province { p, q }), false);
        }
        CqKind::CONQUEST | CqKind::KEEP | CqKind::NEUTRAL => {
            let (p, q) = pq()?;
            c.push(E::Province, Base(EntityRef::Province { p, q }), false);
        }
        CqKind::CAPTURE_SETTLED => {
            let (p, q) = pq()?;
            let site = rd_u8(key, 8)?;
            let captor = CitizenRef::Tag8(rd_u64(pay("captor_tag")?, 0)?);
            let victim_tag = rd_u64(pay("victim_tag")?, 0)?;
            let free_city = pay("outcome")?[0] == capture_outcome::FREE_CITY;
            c.push(E::JoinShard, Base(EntityRef::JoinShardOf(captor)), false);
            if !free_city {
                // optional: one account when both share a JoinShard
                let v = CitizenRef::Tag8(victim_tag);
                c.push(E::JoinShard, Base(EntityRef::JoinShardOf(v)), true);
            }
            c.push(E::Citizen, Base(EntityRef::Citizen(captor)), false);
            if !free_city {
                let v = CitizenRef::Tag8(victim_tag);
                c.push(E::Citizen, Base(EntityRef::Citizen(v)), false);
            }
            c.push(E::Holding, Base(EntityRef::Holding { p, q, site }), false);
            c.push(E::Province, Base(EntityRef::Province { p, q }), false);
        }
        CqKind::MARCH_FOLD => {
            c.push(
                E::MarchState,
                March {
                    m: rd_i32(key, 0)?,
                    n: rd_i32(key, 4)?,
                },
                false,
            );
        }
        CqKind::RETIRE => {
            // the Province the host stands in (not in the key)
            c.push(E::Province, Base(EntityRef::InTx), false);
        }
        CqKind::OUTPOST_SETTLED => {
            let (p, q) = pq()?;
            let site = rd_u8(key, 8)?;
            let me = CitizenRef::Tag8(rd_u64(pay("citizen_tag")?, 0)?);
            c.push(E::JoinShard, Base(EntityRef::JoinShardOf(me)), false);
            c.push(E::Citizen, Base(EntityRef::Citizen(me)), false);
            c.push(E::Holding, Base(EntityRef::Holding { p, q, site }), false);
            c.push(E::Province, Base(EntityRef::Province { p, q }), false);
        }
    }
    c.sort();
    Some(c)
}

/// The MarchState's address for a `March` chain entry.
pub fn march_address(ctx: &crate::addr::AddrCtx, who: &EntityRefV2) -> Option<[u8; 32]> {
    match who {
        EntityRefV2::March { m, n } => Some(crate::v2::addr::march_state(ctx, *m, *n)),
        EntityRefV2::Base(b) => b.address(ctx),
    }
}

/// CONQUEST's `records digest`: `sha256(province[4,096..4,512])`.
pub fn records_digest(province: &[u8]) -> Option<[u8; 32]> {
    let b = province.get(crate::v2::layout::province::province::RECORDS_AND_KEEP)?;
    Some(sha256(&[b]))
}

/// One CONQUEST event.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Event {
    /// Site index, or [`event::KEEP_SITE`].
    pub site: u8,
    /// Event code, with [`event::DETAIL`] as its detail bit.
    pub code: u8,
    pub faction: u8,
    pub progress: u8,
}

/// The decoded payload of a CONQUEST record.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ConquestPayload {
    pub events: [Event; CONQUEST_EVENTS_MAX],
    pub n: u8,
    pub records_digest: [u8; 32],
    pub keep_holder: u8,
    pub keep_contender: u8,
    pub keep_progress: u8,
    pub keep_troops: u32,
    pub donor_host_id: u64,
    pub snapshot: Option<[u16; 7]>,
}

/// CONQUEST's payload length.
pub const CONQUEST_PAYLOAD_LEN: usize = 1 + 56 + 32 + 3 + 4 + 8 + 1 + 14;

impl ConquestPayload {
    pub fn to_bytes(&self) -> [u8; CONQUEST_PAYLOAD_LEN] {
        let mut d = [0u8; CONQUEST_PAYLOAD_LEN];
        let mut w = Writer::new(&mut d);
        w.u8(self.n);
        for e in &self.events {
            w.u8(e.site).u8(e.code).u8(e.faction).u8(e.progress);
        }
        w.bytes(&self.records_digest)
            .u8(self.keep_holder)
            .u8(self.keep_contender)
            .u8(self.keep_progress)
            .u32(self.keep_troops)
            .u64(self.donor_host_id)
            .u8(self.snapshot.is_some() as u8);
        for x in self.snapshot.unwrap_or([0; 7]) {
            w.u16(x);
        }
        d
    }

    pub fn from_bytes(d: &[u8]) -> Option<ConquestPayload> {
        if d.len() != CONQUEST_PAYLOAD_LEN {
            return None;
        }
        let mut c = Cursor::new(d);
        let n = c.u8()?;
        if n as usize > CONQUEST_EVENTS_MAX {
            return None;
        }
        let mut events = [Event::default(); CONQUEST_EVENTS_MAX];
        for e in events.iter_mut() {
            *e = Event {
                site: c.u8()?,
                code: c.u8()?,
                faction: c.u8()?,
                progress: c.u8()?,
            };
        }
        let records_digest = c.arr()?;
        let keep_holder = c.u8()?;
        let keep_contender = c.u8()?;
        let keep_progress = c.u8()?;
        let keep_troops = c.u32()?;
        let donor_host_id = c.u64()?;
        let present = c.u8()?;
        let mut w = [0u16; 7];
        for x in w.iter_mut() {
            *x = c.u16()?;
        }
        Some(ConquestPayload {
            events,
            n,
            records_digest,
            keep_holder,
            keep_contender,
            keep_progress,
            keep_troops,
            donor_host_id,
            snapshot: (present != 0).then_some(w),
        })
    }
}

/// CONQUEST's key: `p i32, q i32, bell u32`.
pub fn conquest_key(p: i32, q: i32, bell: u32) -> [u8; 12] {
    let mut k = [0u8; 12];
    k[..4].copy_from_slice(&p.to_le_bytes());
    k[4..8].copy_from_slice(&q.to_le_bytes());
    k[8..].copy_from_slice(&bell.to_le_bytes());
    k
}

/// The CLOSE key of a MarchState: account kind 18 ‖ `m, n` (zero-padded).
pub fn close_key_march(m: i32, n: i32) -> [u8; 16] {
    let mut k = [0u8; 16];
    k[0] = crate::v2::layout::AccountKind::MarchState as u8;
    k[1..5].copy_from_slice(&m.to_le_bytes());
    k[5..9].copy_from_slice(&n.to_le_bytes());
    k
}

/// Reads an `[u8; N]` key part (helper for readers).
pub fn key_arr<const N: usize>(key: &[u8], off: usize) -> Option<[u8; N]> {
    rd_arr(key, off)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn specs_cover_every_kind_once_and_bodies_fit() {
        for s in CQ_SPECS {
            assert_eq!(CqKind::from_u8(s.kind as u8), Some(s.kind));
            assert_eq!(CQ_SPECS.iter().filter(|t| t.kind == s.kind).count(), 1);
            assert_eq!(V1Kind::from_u8(s.kind as u8), None, "no M1 collision");
            let k = AnyKind::Cq(s.kind);
            assert!(
                s.kind == CqKind::CONQUEST || k.body_len() <= SOFT_BODY_MAX,
                "{} is {} B",
                s.name,
                k.body_len()
            );
        }
        assert_eq!(CQ_SPECS.len(), 9);
        assert_eq!(AnyKind::Cq(CqKind::CONQUEST).body_len(), 137);
        assert_eq!(
            AnyKind::Cq(CqKind::CONQUEST).payload_len(),
            CONQUEST_PAYLOAD_LEN
        );
        assert!(CqKind::from_u8(RESERVED_KIND).is_none());
    }

    #[test]
    fn decode_reads_both_versions_and_march_links() {
        let mut buf = [0u8; 512];
        let kind = AnyKind::Cq(CqKind::MARCH_FOLD);
        let key = [1u8; 12];
        let pl = [2u8; 44];
        let n = write_body(kind, 9, &key, &pl, &mut buf).unwrap();
        let bwt = buf[..n].to_vec();
        let l = advance(EntityKind::MarchState, 0, &[0; 32], &bwt).unwrap();
        let end = write_tail(&[l], &mut buf, n).unwrap();
        let r = decode(&buf[..end]).unwrap();
        assert_eq!(r.kind, kind);
        assert_eq!(r.links[0], Some(l));
        // v1's decoder refuses an MC kind (dispatch on the version, R-22)
        assert!(crate::log::decode(&buf[..end]).is_err());
        // an M1 record decodes through v2
        let n = crate::log::write_body(V1Kind::SKIP, 3, &[0; 8], &[0; 37], &mut buf).unwrap();
        let end = crate::log::write_tail(&[], &mut buf, n).unwrap();
        assert_eq!(decode(&buf[..end]).unwrap().kind, AnyKind::V1(V1Kind::SKIP));
    }

    #[test]
    fn chains_are_sorted_and_cover_every_kind() {
        for s in CQ_SPECS {
            let k = AnyKind::Cq(s.kind);
            let key = std::vec![0u8; k.key_len()];
            let mut pl = std::vec![0u8; k.payload_len()];
            if let Some((o, _)) = field(k, "src_key", true) {
                let id = crate::addr::host_id(2, -1, 3, 1, 0).unwrap();
                pl[o..o + 8].copy_from_slice(&id.to_le_bytes());
            }
            let c = chains_of(k, &key, &pl).unwrap_or_else(|| panic!("{}", s.name));
            let ents: std::vec::Vec<_> = c.iter().map(|x| x.entity).collect();
            let mut sorted = ents.clone();
            sorted.sort();
            assert_eq!(ents, sorted, "{}", s.name);
        }
        let k = AnyKind::Cq(CqKind::CAPTURE_SETTLED);
        let c = chains_of(k, &[0; 9], &[0; 40]).unwrap();
        assert_eq!(c.bounds(), (5, 6));
        let c = chains_of(AnyKind::Cq(CqKind::MARCH_FOLD), &[0; 12], &[0; 44]).unwrap();
        assert_eq!(c.iter().next().unwrap().entity, EntityKind::MarchState);
    }

    #[test]
    fn conquest_payload_round_trips() {
        let mut p = ConquestPayload {
            events: [Event::default(); CONQUEST_EVENTS_MAX],
            n: 2,
            records_digest: [7; 32],
            keep_holder: 3,
            keep_contender: 0xFF,
            keep_progress: 0,
            keep_troops: 15_000,
            donor_host_id: 42,
            snapshot: Some([1, 2, 3, 4, 5, 6, 7]),
        };
        p.events[0] = Event {
            site: 4,
            code: event::CAPTURE_DUE | event::DETAIL,
            faction: 2,
            progress: 40,
        };
        assert_eq!(ConquestPayload::from_bytes(&p.to_bytes()), Some(p));
        p.snapshot = None;
        assert_eq!(ConquestPayload::from_bytes(&p.to_bytes()), Some(p));
    }
}
