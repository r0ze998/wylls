//! Closed, original-host outbound account/byte proposal. Not an instruction.
//!
//! Public address construction and the current ABI envelope only. The actor is
//! an explicit wallet; its Citizen is derived, never supplied by an owner tag.
//! The host issuer and its current standing original province may differ.
//! Supplied commit/seal bytes are opaque, already-public inputs. No encryption,
//! signatures, account reads, ownership proofs, admission or network are here.
use frontier_abi::{
    addr::AddrCtx,
    prologue::{ids::SYSTEM_PROGRAM, Wr},
    world_index::{
        expedition::{AccountFamily, AccountResolver},
        march::transit_address,
        seal::WIDE_SEAL_LEN,
        wide_ix::{ExpeditionDepart, EXPEDITION_DEPART},
        ProvinceKey, WideHostRef,
    },
};
use solana_address::Address;

pub const NOT_PROVEN: &[&str] = &[
    "canonical deployed program, Season account and account ownership",
    "wallet signatures, authorization, Citizen ownership and host issuance",
    "current residency, capture/transit locks and free embedded transit slot",
    "arrival timing, land availability, economics, Resolve and readiness",
    "commit/seal binding to plaintext, ciphertext validity or decryptability",
    "public dispatch or executable instruction admission",
];
const _: () = assert!(ExpeditionDepart::LEN == 369 && WIDE_SEAL_LEN == 264);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    ContextOrHost,
    StandingFamily,
    TransitSlot,
    ZeroOrProgramRecipient,
    Alias,
}

/// Minimum effective privileges after allowed aliases are unioned. A proposed
/// signer flag is a requirement, never a signature or an authorization proof.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Role {
    pub name: &'static str,
    pub address: Address,
    pub signer: bool,
    pub writable: bool,
}

/// Immutable data proposal with no conversion to a Solana Instruction, Message
/// or Transaction. The ABI decoder recognizes these bytes; closed dispatch
/// still refuses the operation. This type cannot establish live readiness.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Draft {
    program: Address,
    season: Address,
    standing: ProvinceKey,
    command: ExpeditionDepart,
    roles: [Role; 9],
}
impl Draft {
    /// Construct the explicit wallet path, not a session or NFT path.
    ///
    /// Only caller-supplied, already-public commit/seal bytes are accepted.
    /// Their lengths are fixed by the types, but their validity and binding to
    /// any prepared plaintext remain unverified. No secret is accepted.
    #[allow(clippy::too_many_arguments)]
    pub fn for_wallet(
        ctx: &AddrCtx,
        host: WideHostRef,
        standing: ProvinceKey,
        wallet: Address,
        payer: Address,
        transit_slot: u8,
        arrive_bell: u32,
        tip: u64,
        public_commit: [u8; 32],
        public_seal: [u8; WIDE_SEAL_LEN],
    ) -> Result<Self, Error> {
        if ctx.program == [0; 32] || ctx.season == [0; 32] || ctx.program == ctx.season {
            return Err(Error::ContextOrHost);
        }
        if transit_slot >= 4 {
            return Err(Error::TransitSlot);
        }
        let resolver = AccountResolver::for_season(ctx).map_err(|_| Error::ContextOrHost)?;
        // Lossless full identity validation also rejects wide issuers and a
        // wrong world. It cannot prove generation or sequence was issued.
        resolver
            .legacy_host_id(&host)
            .map_err(|_| Error::ContextOrHost)?;
        if resolver
            .family(standing)
            .map_err(|_| Error::StandingFamily)?
            != AccountFamily::Legacy
        {
            return Err(Error::StandingFamily);
        }
        let program = Address::new_from_array(ctx.program);
        let holding = resolver
            .holding_address(&host)
            .map_err(|_| Error::ContextOrHost)?;
        let keys = [
            wallet,
            payer,
            Address::new_from_array(ctx.season),
            Address::new_from_array(ctx.citizen(&wallet.to_bytes())),
            Address::new_from_array(holding),
            Address::new_from_array(
                resolver
                    .province_address(standing)
                    .map_err(|_| Error::StandingFamily)?,
            ),
            Address::new_from_array(SYSTEM_PROGRAM),
            Address::new_from_array(
                resolver
                    .province_address(host.key())
                    .map_err(|_| Error::ContextOrHost)?,
            ),
            Address::new_from_array(transit_address(ctx, &holding, transit_slot)),
        ];
        let mut roles = core::array::from_fn(|i| {
            let spec = &EXPEDITION_DEPART[0].specs[i];
            Role {
                name: spec.name,
                address: keys[i],
                signer: spec.signer,
                writable: spec.wr == Wr::W,
            }
        });
        for i in 0..keys.len() {
            // SystemProgram is intentionally zero. No user/context/derived
            // role may substitute it, the executable program, or another role.
            if i != 6 && (keys[i] == Address::default() || keys[i] == program) {
                return Err(Error::ZeroOrProgramRecipient);
            }
            for j in 0..i {
                if keys[j] == keys[i] {
                    if !matches!((j, i), (0, 1) | (5, 7)) {
                        return Err(Error::Alias);
                    }
                    let signer = roles[j].signer || roles[i].signer;
                    let writable = roles[j].writable || roles[i].writable;
                    roles[j].signer = signer;
                    roles[i].signer = signer;
                    roles[j].writable = writable;
                    roles[i].writable = writable;
                }
            }
        }
        Ok(Self {
            program,
            season: Address::new_from_array(ctx.season),
            standing,
            command: ExpeditionDepart {
                host: host.to_bytes(),
                transit_slot,
                arrive_bell,
                tip,
                commit: public_commit,
                seal: public_seal,
            },
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
    pub fn command(&self) -> ExpeditionDepart {
        self.command
    }
    pub fn proposed_bytes(&self) -> [u8; ExpeditionDepart::LEN] {
        self.command.to_bytes()
    }
    pub fn roles(&self) -> &[Role; 9] {
        &self.roles
    }
    pub const fn public_dispatch_available(&self) -> bool {
        false
    }
    pub const fn admitted(&self) -> bool {
        false
    }
    pub const fn seal_verified(&self) -> bool {
        false
    }
    pub const fn not_proven(&self) -> &'static [&'static str] {
        NOT_PROVEN
    }
}
