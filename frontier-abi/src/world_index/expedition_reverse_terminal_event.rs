//! Standalone PSRT/v1 terminal-cleanup observation, not PS2/PSW1 or an active
//! gameplay-chain transition. No event number is allocated or repurposed.
//! Digests bind all ordered account bytes/roles but do not prove authenticity,
//! season finality, seal validity or the historical source of those accounts.
use super::{expedition::AccountResolver, expedition_event::AccountSnapshot, WideHostRef};
use crate::addr::AddrCtx;
use alloc::vec::Vec;
use permutation_rules::hash::sha256;
pub const PREFIX: &[u8; 4] = b"PSRT";
pub const VERSION: u8 = 1;
pub const LEN: usize = 256;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Shape,
    Identity,
    Digest,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Receipt {
    pub slot: u8,
    pub holding_present: bool,
    pub captured: bool,
    pub escrow_remaining: u64,
    pub now_ts: i64,
    pub now_slot: u64,
    pub host: WideHostRef,
    pub original_owner: [u8; 32],
    pub rent_to: [u8; 32],
    pub rent: u64,
    pub input: [u8; 32],
    pub output: [u8; 32],
}
impl Receipt {
    fn validate(&self, ctx: &AddrCtx) -> Result<(), Error> {
        let r = AccountResolver::for_season(ctx).map_err(|_| Error::Identity)?;
        r.legacy_host_id(&self.host).map_err(|_| Error::Identity)?;
        let holding = r.holding_address(&self.host).map_err(|_| Error::Identity)?;
        let external = super::march::transit_address(ctx, &holding, self.slot);
        if self.slot >= 4
            || self.original_owner == [0; 32]
            || (!self.holding_present && (self.captured || self.escrow_remaining != 0))
            || [ctx.program, ctx.season, holding, external, [0; 32]].contains(&self.rent_to)
        {
            return Err(Error::Identity);
        }
        Ok(())
    }
    pub fn to_bytes(&self, ctx: &AddrCtx) -> Result<[u8; LEN], Error> {
        self.validate(ctx)?;
        let mut b = [0; LEN];
        b[..4].copy_from_slice(PREFIX);
        b[4] = VERSION;
        b[5] = self.slot;
        b[6] = self.holding_present as u8;
        b[7] = self.captured as u8;
        b[8..16].copy_from_slice(&self.now_ts.to_le_bytes());
        b[16..24].copy_from_slice(&self.now_slot.to_le_bytes());
        b[24..80].copy_from_slice(&self.host.to_bytes());
        b[80..112].copy_from_slice(&self.original_owner);
        b[112..144].copy_from_slice(&self.rent_to);
        b[144..152].copy_from_slice(&self.rent.to_le_bytes());
        b[152..184].copy_from_slice(&self.input);
        b[184..216].copy_from_slice(&self.output);
        b[216..224].copy_from_slice(&self.escrow_remaining.to_le_bytes());
        let operation = sha256(&[
            b"PSF-REVERSE-TERMINAL-CLOSE-OP-v1",
            &ctx.program,
            &ctx.season,
            &b[..224],
        ]);
        b[224..].copy_from_slice(&operation);
        Ok(b)
    }
    pub fn decode(ctx: &AddrCtx, b: &[u8]) -> Result<Self, Error> {
        if b.len() != LEN || &b[..4] != PREFIX || b[4] != VERSION || b[6] > 1 || b[7] > 1 {
            return Err(Error::Shape);
        }
        let r = Self {
            slot: b[5],
            holding_present: b[6] != 0,
            captured: b[7] != 0,
            escrow_remaining: u64::from_le_bytes(b[216..224].try_into().unwrap()),
            now_ts: i64::from_le_bytes(b[8..16].try_into().unwrap()),
            now_slot: u64::from_le_bytes(b[16..24].try_into().unwrap()),
            host: WideHostRef::from_bytes(&b[24..80]).map_err(|_| Error::Identity)?,
            original_owner: b[80..112].try_into().unwrap(),
            rent_to: b[112..144].try_into().unwrap(),
            rent: u64::from_le_bytes(b[144..152].try_into().unwrap()),
            input: b[152..184].try_into().unwrap(),
            output: b[184..216].try_into().unwrap(),
        };
        if r.to_bytes(ctx)?.as_slice() != b {
            return Err(Error::Digest);
        }
        Ok(r)
    }
}

/// Full ordered manifests, including absent accounts, privileges and every
/// byte of Season/marker/bridge. Nothing is normalized or omitted as a chain.
pub fn manifest(
    ctx: &AddrCtx,
    command: &[u8],
    now_ts: i64,
    now_slot: u64,
    accounts: &[AccountSnapshot<'_>],
) -> [u8; 32] {
    let mut b = Vec::new();
    b.extend_from_slice(&ctx.program);
    b.extend_from_slice(&ctx.season);
    b.extend_from_slice(&(command.len() as u64).to_le_bytes());
    b.extend_from_slice(command);
    b.extend_from_slice(&now_ts.to_le_bytes());
    b.extend_from_slice(&now_slot.to_le_bytes());
    b.extend_from_slice(&(accounts.len() as u64).to_le_bytes());
    for a in accounts {
        b.extend_from_slice(&a.role.to_le_bytes());
        b.extend_from_slice(&a.address);
        b.extend_from_slice(&a.owner);
        b.extend_from_slice(&[a.present as u8, a.signer as u8, a.writable as u8]);
        b.extend_from_slice(&a.lamports.to_le_bytes());
        b.extend_from_slice(&(a.data.len() as u64).to_le_bytes());
        b.extend_from_slice(a.data);
    }
    sha256(&[b"PSF-REVERSE-TERMINAL-CLOSE-MANIFEST-v1", &b])
}
