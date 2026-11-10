//! Closed original-resident account construction, not an instruction builder.
//!
//! This module derives public addresses and minimum required privileges only.
//! It does not read accounts, prove ownership/issuance/readiness, authorize a
//! wallet, choose a session/NFT flow, or construct/sign/send a transaction.
//! The isolated proposed ABI codec is rejected by every public command parser.
use frontier_abi::addr::AddrCtx;
use frontier_abi::prologue::Wr;
use frontier_abi::world_index::{
    expedition::{AccountFamily, AccountResolver},
    expedition_resident_ix::{Action, DraftCommand, DRAFT_LEN},
    roster::roster_address,
    ProvinceKey, WideHostRef,
};
use solana_address::Address;

/// Content/scope identity only, never a signature or execution/readiness proof.
pub const CONTENT_DIGEST_DOMAIN: &[u8] = b"PSF-ORIGINAL-RESIDENT-DRAFT-v1";

pub const NOT_PROVEN: &[&str] = &[
    "program deployment and canonical Season account",
    "current account ownership, generation, issuance and full roster pairing",
    "signatures, wallet authorization, snapshot and history provenance",
    "capture/transit locks, economic checks, Resolve and execution readiness",
    "public dispatch or executable instruction admission",
];
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    ContextOrHost,
    StandingFamily,
    ZeroOrProgramRecipient,
    Alias,
}

/// Canonical minimum effective flags. Required signers are not verified
/// signatures. The private handler may accept extra flags on Acc::Any roles.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Role {
    pub name: &'static str,
    pub address: Address,
    pub signer: bool,
    pub writable: bool,
}

/// Immutable proposal with no conversion API in this module. The separately
/// enabled experimental_expedition_message adapter wraps it in a distinct
/// host-only execution version; it still provides no signing/send/admission.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Draft {
    program: Address,
    season: Address,
    standing: ProvinceKey,
    command: DraftCommand,
    roles: Vec<Role>,
}
impl Draft {
    /// Explicit wallet path only. Citizen is derived from this wallet, never
    /// from an owner tag or a substituted wide Holding. This cannot establish
    /// that the selected source is owned by that Citizen.
    pub fn for_wallet(
        ctx: &AddrCtx,
        host: WideHostRef,
        standing: ProvinceKey,
        wallet: Address,
        payer: Address,
    ) -> Result<Self, Error> {
        Self::build(ctx, Action::Dissolve, host, standing, Some(wallet), payer)
    }
    /// Permissionless candidate return: the payer is the only proposed signer.
    /// No Citizen role or owner-signature requirement is invented.
    pub fn return_home(
        ctx: &AddrCtx,
        host: WideHostRef,
        standing: ProvinceKey,
        payer: Address,
    ) -> Result<Self, Error> {
        Self::build(ctx, Action::Return, host, standing, None, payer)
    }
    fn build(
        ctx: &AddrCtx,
        action: Action,
        host: WideHostRef,
        standing: ProvinceKey,
        wallet: Option<Address>,
        payer: Address,
    ) -> Result<Self, Error> {
        if ctx.program == ctx.season {
            return Err(Error::ContextOrHost);
        }
        let command = DraftCommand::new(ctx, action, host).map_err(|_| Error::ContextOrHost)?;
        let resolver = AccountResolver::for_season(ctx).map_err(|_| Error::ContextOrHost)?;
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
        let holding = address(
            resolver
                .holding_address(&host)
                .map_err(|_| Error::ContextOrHost)?,
        );
        let home = address(
            resolver
                .province_address(host.key())
                .map_err(|_| Error::ContextOrHost)?,
        );
        let province = address(
            resolver
                .province_address(standing)
                .map_err(|_| Error::StandingFamily)?,
        );
        let roster = address(roster_address(ctx, standing));
        let keys = match action {
            Action::Dissolve => {
                let actor = wallet.ok_or(Error::ContextOrHost)?;
                vec![
                    actor,
                    payer,
                    season,
                    address(ctx.citizen(&actor.to_bytes())),
                    holding,
                    province,
                    roster,
                    home,
                ]
            }
            Action::Return => vec![payer, season, province, roster, holding, home],
        };
        let specs = command.groups()[0].specs;
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
        for (i, key) in keys.iter().enumerate() {
            if *key == Address::default() || *key == program {
                return Err(Error::ZeroOrProgramRecipient);
            }
            for (j, previous) in keys[..i].iter().enumerate() {
                if previous == key {
                    if action != Action::Dissolve || (j, i) != (0, 1) {
                        return Err(Error::Alias);
                    }
                    // Solana privileges are globalized for duplicated keys;
                    // preserve both role positions without inconsistent flags.
                    roles[j].writable = true;
                    roles[i].writable = true;
                }
            }
        }
        Ok(Self {
            program,
            season,
            standing,
            command,
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
    pub fn command(&self) -> DraftCommand {
        self.command
    }
    pub fn proposed_bytes(&self) -> [u8; DRAFT_LEN] {
        self.command.to_bytes()
    }
    pub fn roles(&self) -> &[Role] {
        &self.roles
    }
    /// Bind the full proposal, including standing and payers absent from the
    /// 60-byte command. Encoding: domain, program32, season32, standing50,
    /// LE32 command length + command, LE32 role count, then each ordered role's
    /// LE32 UTF-8 name length + name, address32, signer byte and writable byte.
    /// Required signer flags remain proposals, not verified signatures. Source
    /// observations and their provenance require a separate snapshot binding.
    pub fn content_digest(&self) -> [u8; 32] {
        let command = self.proposed_bytes();
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
