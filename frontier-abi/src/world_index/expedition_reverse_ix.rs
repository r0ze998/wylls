//! Closed reverse producer envelope. No public command admits these bytes.
use super::{
    expedition::{AccountFamily, AccountResolver},
    seal::WIDE_SEAL_LEN,
    ProvinceKey, WideHostRef,
};
use crate::{addr::AddrCtx, error::FrontierError};
pub const MAGIC: [u8; 4] = [0xff, b'R', b'D', 1];
pub const LEN: usize = 419;
pub const PUBLIC_DISPATCH_AVAILABLE: bool = false;
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Depart {
    pub host: WideHostRef,
    pub destination: ProvinceKey,
    pub slot: u8,
    pub arrive_bell: u32,
    pub tip: u64,
    pub commit: [u8; 32],
    pub seal: [u8; WIDE_SEAL_LEN],
}
impl Depart {
    pub fn to_bytes(&self) -> [u8; LEN] {
        let mut b = [0; LEN];
        b[..4].copy_from_slice(&MAGIC);
        b[4..60].copy_from_slice(&self.host.to_bytes());
        b[60..110].copy_from_slice(&self.destination.to_bytes());
        b[110] = self.slot;
        b[111..115].copy_from_slice(&self.arrive_bell.to_le_bytes());
        b[115..123].copy_from_slice(&self.tip.to_le_bytes());
        b[123..155].copy_from_slice(&self.commit);
        b[155..].copy_from_slice(&self.seal);
        b
    }
    pub fn decode(ctx: &AddrCtx, b: &[u8]) -> Result<Self, FrontierError> {
        let bad = FrontierError::BadData;
        if b.len() != LEN || b[..4] != MAGIC || b[110] >= 4 {
            return Err(bad);
        }
        let host = WideHostRef::from_bytes(&b[4..60]).map_err(|_| bad)?;
        let destination = ProvinceKey::from_bytes(&b[60..110]).map_err(|_| bad)?;
        let r = AccountResolver::for_season(ctx).map_err(|_| bad)?;
        r.legacy_host_id(&host).map_err(|_| bad)?;
        if r.family(destination).map_err(|_| bad)? != AccountFamily::Legacy {
            return Err(bad);
        }
        Ok(Self {
            host,
            destination,
            slot: b[110],
            arrive_bell: u32::from_le_bytes(b[111..115].try_into().unwrap()),
            tip: u64::from_le_bytes(b[115..123].try_into().unwrap()),
            commit: b[123..155].try_into().unwrap(),
            seal: b[155..].try_into().unwrap(),
        })
    }
}
