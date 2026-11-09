//! Closed provisional PS2 kind 146, never a PSW1 or conquest receipt.
//! Original Citizen/Holding/Province chains continue with `log::advance`.
//! The 344-byte pre-tail body exceeds PS2's advisory 128-byte ceiling;
//! departure/settlement records are exactly 468/427 bytes, below the program's
//! 800-byte buffer. Only an explicit bounded emitter may emit them. Existing
//! strict readers reject this unknown kind; decoding here is not enabling them.
//! Manifests commit every ordered wire account, including aliases, absent
//! creation addresses and external bridge bytes. They establish neither
//! authorization, issuance/provenance, completeness of history nor conservation.

use super::{
    event::normalize_chained,
    expedition::{AccountFamily, AccountResolver},
    key::{HOST_REF_LEN, PROVINCE_KEY_LEN},
    march::transit_address,
    ProvinceKey, WideHostRef,
};
use crate::{
    addr::AddrCtx,
    layout::header,
    log::{self, EntityKind, Link},
};
use alloc::vec::Vec;
use permutation_rules::hash::sha256;

pub const KIND: u8 = 146;
pub const VERSION: u8 = 1;
pub const RECEIPT_LEN: usize = 100;
pub const BODY_WITHOUT_TAIL_LEN: usize =
    10 + HOST_REF_LEN + 4 * 32 + PROVINCE_KEY_LEN + RECEIPT_LEN;
pub const DEPART_LEN: usize = BODY_WITHOUT_TAIL_LEN + 1 + 3 * log::LINK_LEN;
pub const SETTLE_LEN: usize = BODY_WITHOUT_TAIL_LEN + 1 + 2 * log::LINK_LEN;
pub const PREFIX: &[u8; 3] = log::PREFIX;
const _: () = assert!(DEPART_LEN == 468 && SETTLE_LEN == 427 && DEPART_LEN <= 800);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Shape,
    Identity,
    Manifest,
    Receipt,
    Chain,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Action {
    Depart = 1,
    SettleOrigin = 2,
}
impl Action {
    fn decode(v: u8) -> Result<Self, Error> {
        match v {
            1 => Ok(Self::Depart),
            2 => Ok(Self::SettleOrigin),
            _ => Err(Error::Shape),
        }
    }
    pub fn entities(self) -> &'static [EntityKind] {
        match self {
            Self::Depart => &[
                EntityKind::Citizen,
                EntityKind::Holding,
                EntityKind::Province,
            ],
            Self::SettleOrigin => &[EntityKind::Holding, EntityKind::Province],
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Identity {
    pub host: WideHostRef,
    pub slot: u8,
    /// Zero for SettleOrigin, which has no Citizen account or tail.
    pub citizen: [u8; 32],
    pub holding: [u8; 32],
    pub origin: ProvinceKey,
    pub province: [u8; 32],
    pub external: [u8; 32],
}
impl Identity {
    pub fn validate(&self, ctx: &AddrCtx, action: Action) -> Result<(), Error> {
        let r = AccountResolver::for_season(ctx).map_err(|_| Error::Identity)?;
        if self.slot >= 4
            || r.family(self.host.key()).map_err(|_| Error::Identity)? != AccountFamily::Legacy
            || r.family(self.origin).map_err(|_| Error::Identity)? != AccountFamily::Legacy
            || r.holding_address(&self.host).map_err(|_| Error::Identity)? != self.holding
            || r.province_address(self.origin)
                .map_err(|_| Error::Identity)?
                != self.province
            || transit_address(ctx, &self.holding, self.slot) != self.external
            || (action == Action::SettleOrigin && self.citizen != [0; 32])
            || (action == Action::Depart && self.citizen == [0; 32])
        {
            return Err(Error::Identity);
        }
        r.legacy_host_id(&self.host).map_err(|_| Error::Identity)?;
        if self.holding == self.province
            || self.external == self.holding
            || self.external == self.province
            || (action == Action::Depart
                && [self.holding, self.province, self.external].contains(&self.citizen))
        {
            return Err(Error::Identity);
        }
        Ok(())
    }
    fn write(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.host.to_bytes());
        out.extend_from_slice(&self.citizen);
        out.extend_from_slice(&self.holding);
        out.extend_from_slice(&self.origin.to_bytes());
        out.extend_from_slice(&self.province);
        out.extend_from_slice(&self.external);
    }
    fn chained(&self, action: Action, address: &[u8; 32]) -> bool {
        *address == self.holding
            || *address == self.province
            || (action == Action::Depart && *address == self.citizen)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct AccountSnapshot<'a> {
    /// One-based wire position, exactly consecutive; aliases keep all roles.
    pub role: u16,
    pub address: [u8; 32],
    pub owner: [u8; 32],
    pub present: bool,
    pub signer: bool,
    pub writable: bool,
    pub lamports: u64,
    pub data: &'a [u8],
}
#[derive(Clone, Copy, Debug)]
pub struct Context<'a> {
    pub command: &'a [u8],
    pub now_ts: i64,
    pub bell: u32,
    pub season: &'a [u8],
    pub evidence: &'a [u8],
}

/// Fixed version-1 output encoding, no unconstrained outcome byte string.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Outcomes {
    pub escrow: u64,
    pub rent: u64,
    pub dep_mass: u32,
    pub march_stamina: u16,
    pub troops_after: u32,
    pub stamina_after: u16,
    pub ready_bell_off: u16,
    pub destroyed: bool,
    pub finalized: bool,
}
impl Outcomes {
    pub fn encode(self, action: Action) -> Result<Vec<u8>, Error> {
        if (action == Action::Depart
            && (self.troops_after != 0
                || self.stamina_after != 0
                || self.ready_bell_off != 0
                || self.destroyed))
            || (action == Action::SettleOrigin
                && (self.escrow != 0 || self.rent != 0 || self.finalized))
            || (self.destroyed && (self.troops_after != 0 || self.stamina_after != 0))
        {
            return Err(Error::Receipt);
        }
        let mut b = alloc::vec![VERSION, action as u8];
        b.extend_from_slice(&self.escrow.to_le_bytes());
        b.extend_from_slice(&self.rent.to_le_bytes());
        b.extend_from_slice(&self.dep_mass.to_le_bytes());
        b.extend_from_slice(&self.march_stamina.to_le_bytes());
        b.extend_from_slice(&self.troops_after.to_le_bytes());
        b.extend_from_slice(&self.stamina_after.to_le_bytes());
        b.extend_from_slice(&self.ready_bell_off.to_le_bytes());
        b.push(self.destroyed as u8);
        b.push(self.finalized as u8);
        Ok(b)
    }
}
fn bytes(out: &mut Vec<u8>, value: &[u8]) {
    out.extend_from_slice(&(value.len() as u64).to_le_bytes());
    out.extend_from_slice(value);
}
fn digest(
    ctx: &AddrCtx,
    action: Action,
    id: &Identity,
    c: &Context<'_>,
    accounts: &[AccountSnapshot<'_>],
    outcomes: Option<Outcomes>,
) -> Result<[u8; 32], Error> {
    id.validate(ctx, action)?;
    let (count, season, holding, province, external, issuer) = match action {
        Action::Depart => (9, 2, 4, 5, 8, 7),
        Action::SettleOrigin => (6, 1, 3, 2, 5, 4),
    };
    // Share the exact distinct wire codec, never reinterpret an old Depart.
    let command_ok = match action {
        Action::Depart => super::wide_ix::ExpeditionDepart::decode(c.command)
            .map(|command| command.host == id.host.to_bytes() && command.transit_slot == id.slot)
            .unwrap_or(false),
        Action::SettleOrigin => super::wide_ix::ExpeditionSettleOrigin::decode(c.command)
            .map(|command| command.transit_slot == id.slot)
            .unwrap_or(false),
    };
    if !command_ok || c.season.is_empty() || accounts.len() != count {
        return Err(Error::Manifest);
    }
    let r = AccountResolver::for_season(ctx).map_err(|_| Error::Identity)?;
    if accounts[season].address != ctx.season
        || accounts[season].data != c.season
        || accounts[holding].address != id.holding
        || accounts[province].address != id.province
        || accounts[external].address != id.external
        || accounts[issuer].address
            != r.province_address(id.host.key())
                .map_err(|_| Error::Identity)?
        || (action == Action::Depart && accounts[3].address != id.citizen)
    {
        return Err(Error::Manifest);
    }
    let mut out = alloc::vec![VERSION, action as u8, id.slot];
    id.write(&mut out);
    out.extend_from_slice(&ctx.program);
    out.extend_from_slice(&ctx.season);
    bytes(&mut out, c.command);
    out.extend_from_slice(&c.now_ts.to_le_bytes());
    out.extend_from_slice(&c.bell.to_le_bytes());
    bytes(&mut out, c.season);
    bytes(&mut out, c.evidence);
    out.extend_from_slice(&(accounts.len() as u64).to_le_bytes());
    for (i, a) in accounts.iter().enumerate() {
        let chained = id.chained(action, &a.address);
        if a.role as usize != i + 1
            || (!a.present && !a.data.is_empty())
            || (chained && (!a.present || a.data.len() < header::EVENT_HEAD + 32))
        {
            return Err(Error::Manifest);
        }
        for prior in &accounts[..i] {
            if prior.address == a.address
                && (prior.owner != a.owner
                    || prior.present != a.present
                    || prior.lamports != a.lamports
                    || prior.data != a.data)
            {
                return Err(Error::Manifest);
            }
        }
        out.extend_from_slice(&a.role.to_le_bytes());
        out.extend_from_slice(&a.address);
        out.extend_from_slice(&a.owner);
        out.extend_from_slice(&[a.present as u8, a.signer as u8, a.writable as u8]);
        out.extend_from_slice(&a.lamports.to_le_bytes());
        if outcomes.is_some() && chained {
            bytes(&mut out, &normalize_chained(a.data));
        } else {
            bytes(&mut out, a.data);
        }
    }
    let domain: &[u8] = if let Some(outcomes) = outcomes {
        bytes(&mut out, &outcomes.encode(action)?);
        b"PSF-LEGACY-EXPEDITION-OUTPUT-v1"
    } else {
        b"PSF-LEGACY-EXPEDITION-INPUT-v1"
    };
    Ok(sha256(&[domain, &out]))
}
pub fn input_digest(
    ctx: &AddrCtx,
    action: Action,
    id: &Identity,
    c: &Context<'_>,
    accounts: &[AccountSnapshot<'_>],
) -> Result<[u8; 32], Error> {
    digest(ctx, action, id, c, accounts, None)
}
pub fn output_digest(
    ctx: &AddrCtx,
    action: Action,
    id: &Identity,
    c: &Context<'_>,
    accounts: &[AccountSnapshot<'_>],
    outcomes: Outcomes,
) -> Result<[u8; 32], Error> {
    digest(ctx, action, id, c, accounts, Some(outcomes))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Receipt {
    pub action: Action,
    pub operation_id: [u8; 32],
    pub input: [u8; 32],
    pub output: [u8; 32],
}
impl Receipt {
    pub fn new(action: Action, input: [u8; 32], output: [u8; 32]) -> Self {
        Self {
            action,
            operation_id: sha256(&[
                b"PSF-LEGACY-EXPEDITION-OP-v1",
                &[VERSION, action as u8],
                &input,
                &output,
            ]),
            input,
            output,
        }
    }
    pub fn encode(self) -> [u8; RECEIPT_LEN] {
        let mut out = [0; RECEIPT_LEN];
        out[0] = VERSION;
        out[1] = self.action as u8;
        out[4..36].copy_from_slice(&self.operation_id);
        out[36..68].copy_from_slice(&self.input);
        out[68..100].copy_from_slice(&self.output);
        out
    }
    pub fn decode(b: &[u8]) -> Result<Self, Error> {
        if b.len() != RECEIPT_LEN || b[0] != VERSION || b[2..4] != [0, 0] {
            return Err(Error::Receipt);
        }
        let r = Self::new(
            Action::decode(b[1])?,
            b[36..68].try_into().unwrap(),
            b[68..100].try_into().unwrap(),
        );
        if b[4..36] != r.operation_id {
            return Err(Error::Receipt);
        }
        Ok(r)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SourceReceipt {
    pub bell: u32,
    pub identity: Identity,
    pub receipt: Receipt,
}
impl SourceReceipt {
    fn body(self, ctx: &AddrCtx) -> Result<Vec<u8>, Error> {
        self.identity.validate(ctx, self.receipt.action)?;
        Receipt::decode(&self.receipt.encode())?;
        let mut out = alloc::vec![log::VERSION, KIND];
        out.extend_from_slice(&self.bell.to_le_bytes());
        out.extend_from_slice(&[VERSION, self.receipt.action as u8, self.identity.slot, 0]);
        self.identity.write(&mut out);
        out.extend_from_slice(&self.receipt.encode());
        Ok(out)
    }
    /// Previous links must come from authenticated, combined original histories.
    /// These are pure bytes, never writes or authorization. External has no tail.
    pub fn prepare(self, ctx: &AddrCtx, previous: &[Link]) -> Result<(Vec<u8>, Vec<Link>), Error> {
        let mut out = self.body(ctx)?;
        let entities = self.receipt.action.entities();
        if previous.len() != entities.len() {
            return Err(Error::Chain);
        }
        let mut links = Vec::new();
        for (p, entity) in previous.iter().zip(entities) {
            if p.entity != *entity {
                return Err(Error::Chain);
            }
            links.push(log::advance(*entity, p.seq, &p.head, &out).ok_or(Error::Chain)?);
        }
        out.push(links.len() as u8);
        for l in &links {
            out.push(l.entity as u8);
            out.extend_from_slice(&l.seq.to_le_bytes());
            out.extend_from_slice(&l.head);
        }
        Ok((out, links))
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Record {
    pub source: SourceReceipt,
    pub links: Vec<Link>,
}
impl Record {
    pub fn decode(ctx: &AddrCtx, b: &[u8]) -> Result<Self, Error> {
        if b.len() < BODY_WITHOUT_TAIL_LEN + 1
            || b[0] != log::VERSION
            || b[1] != KIND
            || b[6] != VERSION
            || b[9] != 0
        {
            return Err(Error::Shape);
        }
        let action = Action::decode(b[7])?;
        let mut pos = 10;
        let host =
            WideHostRef::from_bytes(&b[pos..pos + HOST_REF_LEN]).map_err(|_| Error::Identity)?;
        pos += HOST_REF_LEN;
        let citizen = b[pos..pos + 32].try_into().unwrap();
        pos += 32;
        let holding = b[pos..pos + 32].try_into().unwrap();
        pos += 32;
        let origin = ProvinceKey::from_bytes(&b[pos..pos + PROVINCE_KEY_LEN])
            .map_err(|_| Error::Identity)?;
        pos += PROVINCE_KEY_LEN;
        let province = b[pos..pos + 32].try_into().unwrap();
        pos += 32;
        let external = b[pos..pos + 32].try_into().unwrap();
        pos += 32;
        let receipt = Receipt::decode(&b[pos..pos + RECEIPT_LEN])?;
        pos += RECEIPT_LEN;
        if receipt.action != action
            || b[pos] as usize != action.entities().len()
            || b.len() != pos + 1 + action.entities().len() * log::LINK_LEN
        {
            return Err(Error::Shape);
        }
        let source = SourceReceipt {
            bell: u32::from_le_bytes(b[2..6].try_into().unwrap()),
            identity: Identity {
                host,
                slot: b[8],
                citizen,
                holding,
                origin,
                province,
                external,
            },
            receipt,
        };
        source.identity.validate(ctx, action)?;
        pos += 1;
        let mut links = Vec::new();
        for entity in action.entities() {
            if b[pos] != *entity as u8 {
                return Err(Error::Chain);
            }
            let seq = u64::from_le_bytes(b[pos + 1..pos + 9].try_into().unwrap());
            if seq == 0 {
                return Err(Error::Chain);
            }
            links.push(Link {
                entity: *entity,
                seq,
                head: b[pos + 9..pos + 41].try_into().unwrap(),
            });
            pos += log::LINK_LEN;
        }
        Ok(Self { source, links })
    }
    pub fn verify_previous(&self, ctx: &AddrCtx, previous: &[Link]) -> Result<(), Error> {
        let (_, links) = self.source.prepare(ctx, previous)?;
        if self.links != links {
            return Err(Error::Chain);
        }
        Ok(())
    }
}
