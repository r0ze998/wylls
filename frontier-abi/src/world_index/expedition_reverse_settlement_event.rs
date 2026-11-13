//! Independent PSFS/v1 reverse-final observation. No allocated PS2/PSW1 kind.
//! Original Holding, destination, optional distinct home/Citizen links only.
//! Full manifests/links are observations, never seal or producer authority.
use super::{
    event, expedition::AccountResolver, expedition_event::AccountSnapshot, ProvinceKey, WideHostRef,
};
use crate::{
    addr::AddrCtx,
    log::{self, EntityKind},
};
use alloc::vec::Vec;
use permutation_rules::hash::sha256;
pub const PREFIX: &[u8; 4] = b"PSFS";
pub const MAX_LEN: usize = 779;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Shape,
    Identity,
    Outcome,
    Chain,
    Manifest,
    Digest,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Payment {
    pub recipient: [u8; 32],
    pub amount: u64,
    pub diverted: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Chain {
    pub entity: EntityKind,
    pub address: [u8; 32],
    pub seq: u64,
    pub head: [u8; 32],
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Receipt {
    pub slot: u8,
    pub seal_code: u8,
    pub fate: u8,
    pub outcome: u8,
    pub forfeited: bool,
    pub slot_retained: bool,
    pub claim_eligible: bool,
    pub now_ts: i64,
    pub now_slot: u64,
    pub host: WideHostRef,
    pub original_owner: [u8; 32],
    pub destination: ProvinceKey,
    pub credited_milli: u32,
    pub camp_works: u64,
    pub payments: [Payment; 4],
    pub bridge_rent: u64,
    pub slot_rent: u64,
    pub slot_rent_to: [u8; 32],
    pub input: [u8; 32],
    pub output: [u8; 32],
    pub links: Vec<Chain>,
}
impl Receipt {
    fn body(&self, ctx: &AddrCtx) -> Result<Vec<u8>, Error> {
        let r = AccountResolver::for_season(ctx).map_err(|_| Error::Identity)?;
        r.legacy_host_id(&self.host).map_err(|_| Error::Identity)?;
        if self.slot >= 4
            || self.original_owner == [0; 32]
            || r.family(self.destination).map_err(|_| Error::Identity)?
                != super::expedition::AccountFamily::Legacy
        {
            return Err(Error::Identity);
        }
        let valid = self.seal_code == 0;
        if !(1..=5).contains(&self.fate)
            || !matches!(self.seal_code, 0 | 1 | 2 | 4 | 5)
            || self.outcome
                != if valid {
                    self.fate
                } else {
                    log::transit_outcome::BAD_SEAL
                }
            || (self.forfeited && (valid || !matches!(self.fate, 1 | 2)))
            || (self.camp_works != 0 && (!valid || self.fate != 1))
            || (self.credited_milli != 0 && (!valid || !matches!(self.fate, 3 | 4)))
            || (self.slot_retained && self.slot_rent != 0)
            || (self.claim_eligible && !self.slot_retained)
        {
            return Err(Error::Outcome);
        }
        if !(2..=4).contains(&self.links.len()) {
            return Err(Error::Chain);
        }
        let holding = r.holding_address(&self.host).map_err(|_| Error::Identity)?;
        let destination = r
            .province_address(self.destination)
            .map_err(|_| Error::Identity)?;
        let home = r
            .province_address(self.host.key())
            .map_err(|_| Error::Identity)?;
        if (self.links[0].entity, self.links[0].address) != (EntityKind::Holding, holding)
            || (self.links[1].entity, self.links[1].address) != (EntityKind::Province, destination)
        {
            return Err(Error::Chain);
        }
        let mut citizen = false;
        for (i, link) in self.links.iter().enumerate() {
            if self.links[..i].iter().any(|p| p.address == link.address) {
                return Err(Error::Chain);
            }
            if i >= 2 {
                match link.entity {
                    EntityKind::Province
                        if i == 2 && link.address == home && home != destination => {}
                    EntityKind::Citizen
                        if link.address == self.original_owner && i + 1 == self.links.len() =>
                    {
                        citizen = true
                    }
                    _ => return Err(Error::Chain),
                }
            }
        }
        if citizen != (self.camp_works != 0) {
            return Err(Error::Chain);
        }
        let mut b = Vec::with_capacity(MAX_LEN);
        b.extend_from_slice(PREFIX);
        b.extend_from_slice(&[
            1,
            self.slot,
            self.seal_code,
            self.fate,
            self.outcome,
            self.forfeited as u8,
            self.slot_retained as u8,
            self.claim_eligible as u8,
        ]);
        b.extend_from_slice(&self.now_ts.to_le_bytes());
        b.extend_from_slice(&self.now_slot.to_le_bytes());
        b.extend_from_slice(&self.host.to_bytes());
        b.extend_from_slice(&self.original_owner);
        b.extend_from_slice(&self.destination.to_bytes());
        b.extend_from_slice(&self.credited_milli.to_le_bytes());
        b.extend_from_slice(&self.camp_works.to_le_bytes());
        for p in self.payments {
            b.extend_from_slice(&p.recipient);
            b.extend_from_slice(&p.amount.to_le_bytes());
            b.push(p.diverted as u8);
        }
        b.extend_from_slice(&self.bridge_rent.to_le_bytes());
        b.extend_from_slice(&self.slot_rent.to_le_bytes());
        b.extend_from_slice(&self.slot_rent_to);
        b.extend_from_slice(&self.input);
        b.extend_from_slice(&self.output);
        b.push(self.links.len() as u8);
        for l in &self.links {
            b.push(l.entity as u8);
            b.extend_from_slice(&l.address);
        }
        let digest = sha256(&[b"PSF-REVERSE-FINAL-OP-v1", &ctx.program, &ctx.season, &b]);
        b.extend_from_slice(&digest);
        Ok(b)
    }
    pub fn advance(mut self, ctx: &AddrCtx) -> Result<Self, Error> {
        let body = self.body(ctx)?;
        for l in &mut self.links {
            let n = log::advance(l.entity, l.seq, &l.head, &body).ok_or(Error::Chain)?;
            l.seq = n.seq;
            l.head = n.head;
        }
        Ok(self)
    }
    pub fn verify_previous(&self, ctx: &AddrCtx, previous: &[Chain]) -> Result<(), Error> {
        if previous.len() != self.links.len()
            || previous
                .iter()
                .zip(&self.links)
                .any(|(a, b)| (a.entity, a.address) != (b.entity, b.address))
        {
            return Err(Error::Chain);
        }
        let mut copy = self.clone();
        copy.links = previous.to_vec();
        if copy.advance(ctx)? != *self {
            return Err(Error::Chain);
        }
        Ok(())
    }
    pub fn to_bytes(&self, ctx: &AddrCtx) -> Result<Vec<u8>, Error> {
        let mut b = self.body(ctx)?;
        for l in &self.links {
            b.extend_from_slice(&l.seq.to_le_bytes());
            b.extend_from_slice(&l.head);
        }
        Ok(b)
    }
    pub fn decode(ctx: &AddrCtx, b: &[u8]) -> Result<Self, Error> {
        if b.len() < 633
            || b.len() > MAX_LEN
            || &b[..4] != PREFIX
            || b[4] != 1
            || b[9..12].iter().any(|v| *v > 1)
        {
            return Err(Error::Shape);
        }
        let n = b[454] as usize;
        if !(2..=4).contains(&n) || b.len() != 487 + 73 * n {
            return Err(Error::Shape);
        }
        let mut payments = [Payment {
            recipient: [0; 32],
            amount: 0,
            diverted: false,
        }; 4];
        for (i, p) in payments.iter_mut().enumerate() {
            let o = 178 + i * 41;
            if b[o + 40] > 1 {
                return Err(Error::Shape);
            };
            *p = Payment {
                recipient: b[o..o + 32].try_into().unwrap(),
                amount: u64::from_le_bytes(b[o + 32..o + 40].try_into().unwrap()),
                diverted: b[o + 40] != 0,
            };
        }
        let mut links = Vec::new();
        let tail = 487 + 33 * n;
        for i in 0..n {
            let o = 455 + i * 33;
            let t = tail + i * 40;
            links.push(Chain {
                entity: EntityKind::from_u8(b[o]).ok_or(Error::Chain)?,
                address: b[o + 1..o + 33].try_into().unwrap(),
                seq: u64::from_le_bytes(b[t..t + 8].try_into().unwrap()),
                head: b[t + 8..t + 40].try_into().unwrap(),
            });
        }
        let r = Self {
            slot: b[5],
            seal_code: b[6],
            fate: b[7],
            outcome: b[8],
            forfeited: b[9] != 0,
            slot_retained: b[10] != 0,
            claim_eligible: b[11] != 0,
            now_ts: i64::from_le_bytes(b[12..20].try_into().unwrap()),
            now_slot: u64::from_le_bytes(b[20..28].try_into().unwrap()),
            host: WideHostRef::from_bytes(&b[28..84]).map_err(|_| Error::Identity)?,
            original_owner: b[84..116].try_into().unwrap(),
            destination: ProvinceKey::from_bytes(&b[116..166]).map_err(|_| Error::Identity)?,
            credited_milli: u32::from_le_bytes(b[166..170].try_into().unwrap()),
            camp_works: u64::from_le_bytes(b[170..178].try_into().unwrap()),
            payments,
            bridge_rent: u64::from_le_bytes(b[342..350].try_into().unwrap()),
            slot_rent: u64::from_le_bytes(b[350..358].try_into().unwrap()),
            slot_rent_to: b[358..390].try_into().unwrap(),
            input: b[390..422].try_into().unwrap(),
            output: b[422..454].try_into().unwrap(),
            links,
        };
        if r.to_bytes(ctx)?.as_slice() != b {
            return Err(Error::Digest);
        }
        Ok(r)
    }
}
pub fn manifest(
    ctx: &AddrCtx,
    command: &[u8],
    now_ts: i64,
    now_slot: u64,
    accounts: &[AccountSnapshot<'_>],
    normalized: &[[u8; 32]],
) -> Result<[u8; 32], Error> {
    let mut h = sha256(&[
        b"PSF-REVERSE-FINAL-MANIFEST-v1",
        &ctx.program,
        &ctx.season,
        command,
        &now_ts.to_le_bytes(),
        &now_slot.to_le_bytes(),
        &(accounts.len() as u64).to_le_bytes(),
    ]);
    for (i, a) in accounts.iter().enumerate() {
        if a.role as usize != i + 1 || (!a.present && !a.data.is_empty()) {
            return Err(Error::Manifest);
        }
        let data = if normalized.contains(&a.address) {
            if !a.present || a.data.len() < 64 {
                return Err(Error::Manifest);
            }
            event::normalize_chained(a.data)
        } else {
            a.data.to_vec()
        };
        h = sha256(&[
            b"PSF-REVERSE-FINAL-ACCOUNT-v1",
            &h,
            &a.role.to_le_bytes(),
            &a.address,
            &a.owner,
            &[a.present as u8, a.signer as u8, a.writable as u8],
            &a.lamports.to_le_bytes(),
            &(data.len() as u64).to_le_bytes(),
            &data,
        ]);
    }
    Ok(h)
}
