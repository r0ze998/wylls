//! Closed legacy/wide identity foundation. Address selection is a function of
//! the full province key, never of a roster alias, supplied account type or
//! destination. This module does not authorize, issue or move troops.

use super::{holding, land, KeyError, LegacyAdapter, LegacyError, ProvinceKey, WideHostRef};
use crate::addr::AddrCtx;
use permutation_rules::frontier::geometry::R_MAX_HARD;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccountFamily {
    Legacy,
    Wide,
}

/// Public-address resolver for precisely one Season. Construction derives the
/// adapter world rather than accepting a caller-selected namespace.
pub struct AccountResolver {
    ctx: AddrCtx,
    adapter: LegacyAdapter,
}

impl AccountResolver {
    pub fn for_season(ctx: &AddrCtx) -> Result<Self, KeyError> {
        Ok(Self {
            ctx: AddrCtx {
                season: ctx.season,
                program: ctx.program,
            },
            adapter: LegacyAdapter::for_season(ctx)?,
        })
    }

    pub const fn adapter(&self) -> LegacyAdapter {
        self.adapter
    }

    pub fn family(&self, key: ProvinceKey) -> Result<AccountFamily, LegacyError> {
        if key.world() != self.adapter.world() {
            return Err(LegacyError::WorldMismatch {
                expected: self.adapter.world(),
                got: key.world(),
            });
        }
        Ok(if key.coord().ring() <= R_MAX_HARD as u64 {
            AccountFamily::Legacy
        } else {
            AccountFamily::Wide
        })
    }

    /// In-disk keys always resolve to the original Province. There is no
    /// parameter that can request a shadow WideProvince inside that disk.
    pub fn province_address(&self, key: ProvinceKey) -> Result<[u8; 32], LegacyError> {
        match self.family(key)? {
            AccountFamily::Legacy => {
                let c = self.adapter.coord_of(&key)?;
                Ok(self.ctx.province(c.p, c.q))
            }
            AccountFamily::Wide => Ok(land::province_address(&self.ctx, key.coord())),
        }
    }

    /// The issuer's Holding, irrespective of where its host now stands. The
    /// sequence and generation are identity checks, not Holding address seeds.
    pub fn holding_address(&self, host: &WideHostRef) -> Result<[u8; 32], LegacyError> {
        match self.family(host.key())? {
            AccountFamily::Legacy => {
                let id = self.adapter.host_id(host)?;
                self.ctx
                    .holding_of_host(id)
                    .ok_or(LegacyError::InvalidHostId(id))
            }
            AccountFamily::Wide => Ok(holding::holding_address(
                &self.ctx,
                host.key().coord(),
                host.site(),
            )),
        }
    }

    /// Lossless identity conversion, not proof that a Holding issued this ID.
    pub fn legacy_host_ref(&self, id: u64) -> Result<WideHostRef, LegacyError> {
        self.adapter.host_ref(id)
    }

    pub fn legacy_host_id(&self, host: &WideHostRef) -> Result<u64, LegacyError> {
        self.adapter.host_id(host)
    }
}
