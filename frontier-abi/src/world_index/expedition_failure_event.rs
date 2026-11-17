//! Isolated PSFF/v1 failure observation. Never a member/camp receipt, PS2 kind
//! or PSW1 kind. One bounded record commits both chain advances; only explicit
//! readers understand it. Digests and links are not seal/account provenance.
use super::{
    event, expedition::AccountResolver, expedition_event::AccountSnapshot, ProvinceKey, WideHostRef,
};
use crate::{addr::AddrCtx, log};
use alloc::vec::Vec;
use permutation_rules::hash::sha256;
pub const PREFIX: &[u8; 4] = b"PSFF";
pub const BODY_LEN: usize = 338;
pub const LEN: usize = BODY_LEN + 80;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Shape,
    Identity,
    Digest,
    Chain,
    Manifest,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Chain {
    pub seq: u64,
    pub head: [u8; 32],
}
impl Chain {
    pub fn from_account(data: &[u8]) -> Result<Self, Error> {
        if data.len() < 64 {
            return Err(Error::Chain);
        }
        Ok(Self {
            seq: u64::from_le_bytes(data[24..32].try_into().unwrap()),
            head: data[32..64].try_into().unwrap(),
        })
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Receipt {
    pub slot: u8,
    pub seal_code: u8,
    pub diverted: bool,
    pub now_ts: i64,
    pub now_slot: u64,
    pub host: WideHostRef,
    pub original_owner: [u8; 32],
    pub destination: ProvinceKey,
    pub reward_to: [u8; 32],
    pub reward: u64,
    pub rent_to: [u8; 32],
    pub rent: u64,
    pub input: [u8; 32],
    pub output: [u8; 32],
    pub holding_chain: Chain,
    pub destination_chain: Chain,
}
impl Receipt {
    fn body(&self, ctx: &AddrCtx) -> Result<Vec<u8>, Error> {
        let resolver = AccountResolver::for_season(ctx).map_err(|_| Error::Identity)?;
        resolver
            .legacy_host_id(&self.host)
            .map_err(|_| Error::Identity)?;
        if self.slot >= 4
            || self.original_owner == [0; 32]
            || resolver
                .family(self.destination)
                .map_err(|_| Error::Identity)?
                != super::expedition::AccountFamily::Wide
            || !matches!(self.seal_code, 1 | 2 | 4 | 5)
        {
            return Err(Error::Identity);
        }
        let mut b = Vec::with_capacity(LEN);
        b.extend_from_slice(PREFIX);
        b.extend_from_slice(&[1, self.slot, self.seal_code, self.diverted as u8]);
        b.extend_from_slice(&self.now_ts.to_le_bytes());
        b.extend_from_slice(&self.now_slot.to_le_bytes());
        b.extend_from_slice(&self.host.to_bytes());
        b.extend_from_slice(&self.original_owner);
        b.extend_from_slice(&self.destination.to_bytes());
        b.extend_from_slice(&self.reward_to);
        b.extend_from_slice(&self.reward.to_le_bytes());
        b.extend_from_slice(&self.rent_to);
        b.extend_from_slice(&self.rent.to_le_bytes());
        b.extend_from_slice(&self.input);
        b.extend_from_slice(&self.output);
        let op = sha256(&[b"PSF-FAILURE-OP-v1", &ctx.program, &ctx.season, &b]);
        b.extend_from_slice(&op);
        Ok(b)
    }
    pub fn advance(
        mut self,
        ctx: &AddrCtx,
        holding: Chain,
        destination: Chain,
    ) -> Result<Self, Error> {
        let body = self.body(ctx)?;
        let h = log::advance(log::EntityKind::Holding, holding.seq, &holding.head, &body)
            .ok_or(Error::Chain)?;
        let d = event::advance(
            event::WideEntity::Province,
            destination.seq,
            &destination.head,
            &body,
        )
        .ok_or(Error::Chain)?;
        self.holding_chain = Chain {
            seq: h.seq,
            head: h.head,
        };
        self.destination_chain = Chain {
            seq: d.seq,
            head: d.head,
        };
        Ok(self)
    }
    pub fn verify_previous(
        &self,
        ctx: &AddrCtx,
        holding: Chain,
        destination: Chain,
    ) -> Result<(), Error> {
        if self.advance(ctx, holding, destination)? != *self {
            return Err(Error::Chain);
        }
        Ok(())
    }
    pub fn to_bytes(&self, ctx: &AddrCtx) -> Result<Vec<u8>, Error> {
        let mut b = self.body(ctx)?;
        for c in [self.holding_chain, self.destination_chain] {
            b.extend_from_slice(&c.seq.to_le_bytes());
            b.extend_from_slice(&c.head);
        }
        Ok(b)
    }
    pub fn decode(ctx: &AddrCtx, b: &[u8]) -> Result<Self, Error> {
        if b.len() != LEN || &b[..4] != PREFIX || b[4] != 1 || b[7] > 1 {
            return Err(Error::Shape);
        }
        let r = Self {
            slot: b[5],
            seal_code: b[6],
            diverted: b[7] != 0,
            now_ts: i64::from_le_bytes(b[8..16].try_into().unwrap()),
            now_slot: u64::from_le_bytes(b[16..24].try_into().unwrap()),
            host: WideHostRef::from_bytes(&b[24..80]).map_err(|_| Error::Identity)?,
            original_owner: b[80..112].try_into().unwrap(),
            destination: ProvinceKey::from_bytes(&b[112..162]).map_err(|_| Error::Identity)?,
            reward_to: b[162..194].try_into().unwrap(),
            reward: u64::from_le_bytes(b[194..202].try_into().unwrap()),
            rent_to: b[202..234].try_into().unwrap(),
            rent: u64::from_le_bytes(b[234..242].try_into().unwrap()),
            input: b[242..274].try_into().unwrap(),
            output: b[274..306].try_into().unwrap(),
            holding_chain: Chain {
                seq: u64::from_le_bytes(b[338..346].try_into().unwrap()),
                head: b[346..378].try_into().unwrap(),
            },
            destination_chain: Chain {
                seq: u64::from_le_bytes(b[378..386].try_into().unwrap()),
                head: b[386..418].try_into().unwrap(),
            },
        };
        if r.to_bytes(ctx)?.as_slice() != b {
            return Err(Error::Digest);
        }
        Ok(r)
    }
}
/// Full ordered manifests. Only output Holding/destination chain fields are
/// normalized to avoid the receipt/chain cycle; all input chain bytes remain.
pub fn manifest(
    ctx: &AddrCtx,
    command: &[u8],
    now_ts: i64,
    now_slot: u64,
    accounts: &[AccountSnapshot<'_>],
    normalized: &[[u8; 32]],
) -> Result<[u8; 32], Error> {
    let mut h = sha256(&[
        b"PSF-FAILURE-MANIFEST-v1",
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
            b"PSF-FAILURE-ACCOUNT-v1",
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
