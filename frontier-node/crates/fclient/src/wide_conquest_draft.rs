//! Closed account construction for the one player-signed conquest step: a wide
//! `DeclareSiege` by an original host that stays in a wide province, on the
//! Free City site of that province. Not an instruction builder.
//!
//! This module derives public addresses and the ABI's own minimum privileges
//! (`wide_ix::DECLARE_SIEGE`) and carries the ABI's own inner command bytes
//! (`wide_ix::DeclareSiege`). It does not read accounts, prove that the site is
//! a Free City, that the host stands there or leads, that the Citizen has a
//! free slot, or anything else the program decides; it authorizes no wallet
//! and constructs, signs or sends no transaction. The outer dispatch kind is
//! not used here: wrapping is a separate, separately enabled step.
//!
//! Account binding, as the program's handler has it
//! (`permutation-frontier/src/proc/wide_conquest_exec.rs`, declare):
//! the target province is the one the host stands in; its roster and its
//! conquest table are of that province's key; the source Holding is the host's
//! own (legacy) village and the source Province that village's; the target
//! holding position is the wide Holding address of (province, site), which must
//! be absent; the capture escrow is the acting Citizen's.
use frontier_abi::addr::AddrCtx;
use frontier_abi::prologue::Wr;
use frontier_abi::world_index::{
    conquest::{capture_escrow_address, conquest_address},
    expedition::{AccountFamily, AccountResolver},
    holding::holding_address,
    roster::roster_address,
    wide_ix::{self, DeclareSiege},
    ProvinceKey, WideHostRef,
};
use solana_address::Address;

/// Content/scope identity only, never a signature or execution/readiness proof.
pub const CONTENT_DIGEST_DOMAIN: &[u8] = b"PSF-ORIGINAL-CONQUEST-DRAFT-v1";
/// Sites of a province (the ABI's site array).
pub const SITES: u8 = 12;
/// Roster entries of a province.
pub const ENTRIES: u8 = 56;

pub const NOT_PROVEN: &[&str] = &[
    "program deployment, the conquest lane and the canonical Season account",
    "that the site is a Free City and the target holding position is absent",
    "that the host stands on the site's tile, is eligible and leads",
    "Citizen ownership of the host, a free slot, stake and arms, the daily cap",
    "signatures, wallet authorization, snapshot and history provenance",
    "public dispatch or executable instruction admission",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    ContextOrHost,
    /// The host is not an original (legacy) host: this path is the original
    /// host's only.
    SourceFamily,
    StandingFamily,
    SiteOrEntry,
    ZeroOrProgramRecipient,
    Alias,
}

/// Canonical minimum effective flags. Required signers are not verified
/// signatures.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Role {
    pub name: &'static str,
    pub address: Address,
    pub signer: bool,
    pub writable: bool,
}

/// Immutable proposal with no conversion API in this module.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Draft {
    program: Address,
    season: Address,
    standing: ProvinceKey,
    command: DeclareSiege,
    roles: Vec<Role>,
}

impl Draft {
    /// The wallet acts AND pays (the local-play shape: one signer). Citizen is
    /// derived from this wallet, never from an owner tag. This cannot
    /// establish that the host is that Citizen's.
    pub fn declare_siege(
        ctx: &AddrCtx,
        host: WideHostRef,
        standing: ProvinceKey,
        site: u8,
        entry: u8,
        wallet: Address,
    ) -> Result<Self, Error> {
        if ctx.program == ctx.season {
            return Err(Error::ContextOrHost);
        }
        if site >= SITES || entry >= ENTRIES {
            return Err(Error::SiteOrEntry);
        }
        let resolver = AccountResolver::for_season(ctx).map_err(|_| Error::ContextOrHost)?;
        if resolver.family(host.key()).map_err(|_| Error::ContextOrHost)? != AccountFamily::Legacy
        {
            return Err(Error::SourceFamily);
        }
        if resolver
            .family(standing)
            .map_err(|_| Error::StandingFamily)?
            != AccountFamily::Wide
        {
            return Err(Error::StandingFamily);
        }
        let address = Address::new_from_array;
        let program = address(ctx.program);
        let season = address(ctx.season);
        let citizen = ctx.citizen(&wallet.to_bytes());
        let keys = [
            wallet,
            wallet,
            season,
            address(citizen),
            address(
                resolver
                    .holding_address(&host)
                    .map_err(|_| Error::ContextOrHost)?,
            ),
            address(
                resolver
                    .province_address(standing)
                    .map_err(|_| Error::StandingFamily)?,
            ),
            address(roster_address(ctx, standing)),
            address(
                resolver
                    .province_address(host.key())
                    .map_err(|_| Error::ContextOrHost)?,
            ),
            address(holding_address(ctx, standing.coord(), site)),
            address(conquest_address(ctx, standing)),
            address(capture_escrow_address(ctx, &citizen)),
            // the System program: the all-zero address
            Address::default(),
        ];
        let specs = wide_ix::DECLARE_SIEGE[0].specs;
        if specs.len() != keys.len() {
            return Err(Error::ContextOrHost);
        }
        let mut roles: Vec<_> = specs
            .iter()
            .zip(keys.iter())
            .map(|(s, k)| Role {
                name: s.name,
                address: *k,
                signer: s.signer,
                writable: s.wr == Wr::W,
            })
            .collect();
        let last = keys.len() - 1;
        for (i, key) in keys.iter().enumerate() {
            if (*key == Address::default()) != (i == last) || *key == program {
                return Err(Error::ZeroOrProgramRecipient);
            }
            for (j, previous) in keys[..i].iter().enumerate() {
                if previous == key {
                    // only the wallet stands twice (actor, payer)
                    if (j, i) != (0, 1) {
                        return Err(Error::Alias);
                    }
                    roles[j].writable = true;
                    roles[i].writable = true;
                }
            }
        }
        Ok(Self {
            program,
            season,
            standing,
            command: DeclareSiege { site, entry },
            roles,
        })
    }
    pub fn program(&self) -> Address {
        self.program
    }
    pub fn season(&self) -> Address {
        self.season
    }
    pub fn standing(&self) -> ProvinceKey {
        self.standing
    }
    pub fn command(&self) -> DeclareSiege {
        self.command
    }
    /// The ABI's own inner command bytes (`DA FF 01 05 site entry`).
    pub fn inner_bytes(&self) -> [u8; DeclareSiege::LEN] {
        self.command.to_bytes()
    }
    pub fn roles(&self) -> &[Role] {
        &self.roles
    }
    /// Bind the full proposal. Encoding: domain, program32, season32,
    /// standing50, LE32 command length + command, LE32 role count, then each
    /// ordered role's LE32 UTF-8 name length + name, address32, signer byte and
    /// writable byte.
    pub fn content_digest(&self) -> [u8; 32] {
        let command = self.inner_bytes();
        let mut b = Vec::new();
        b.extend_from_slice(CONTENT_DIGEST_DOMAIN);
        b.extend_from_slice(&self.program.to_bytes());
        b.extend_from_slice(&self.season.to_bytes());
        b.extend_from_slice(&self.standing.to_bytes());
        b.extend_from_slice(&(command.len() as u32).to_le_bytes());
        b.extend_from_slice(&command);
        b.extend_from_slice(&(self.roles.len() as u32).to_le_bytes());
        for role in &self.roles {
            b.extend_from_slice(&(role.name.len() as u32).to_le_bytes());
            b.extend_from_slice(role.name.as_bytes());
            b.extend_from_slice(&role.address.to_bytes());
            b.extend_from_slice(&[role.signer as u8, role.writable as u8]);
        }
        permutation_rules::hash::sha256(&[&b])
    }
    pub const fn public_dispatch_available(&self) -> bool {
        false
    }
    pub const fn admitted(&self) -> bool {
        false
    }
    pub const fn not_proven(&self) -> &'static [&'static str] {
        NOT_PROVEN
    }
}
