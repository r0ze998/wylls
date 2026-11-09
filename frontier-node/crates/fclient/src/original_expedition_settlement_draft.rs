//! Closed resolved-member account/byte proposal, never a transaction builder.
//!
//! Public address derivation does not authenticate a supplied arrival position,
//! historical home, region or payee. The private consumer must read the stored
//! original transport and resolve records and reopen the original seal using
//! the canonical anchor in the same call. No account reads, proof verification,
//! sealing or private-key operations are here.
use frontier_abi::{
    addr::{archive_part_of, AddrCtx},
    prologue::Wr,
    world_index::{
        arrival::{arrival_slot_address, clash_inputs_address},
        expedition::{AccountFamily, AccountResolver},
        expedition_settlement_ix::{AccountLayout, DraftCommand, DRAFT_LEN},
        march::transit_address,
        seal::WIDE_SEAL_LEN,
        ProvinceKey, WideHostRef,
    },
};
use solana_address::Address;

pub const NOT_PROVEN: &[&str] = &[
    "canonical deployed program, Season account, ownership and issuance",
    "resolved final-set membership, arrival position, current or previous ownership",
    "historical home, destination region and supplied payee or rent identities",
    "signatures, authorization, timing, economics and settlement readiness",
    "commitment/seal binding, ciphertext validity and canonical anchor proof",
    "public dispatch or executable instruction admission",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    ContextOrHost,
    Destination,
    Position,
    Region,
    PreviousHome,
    ZeroOrProgramRecipient,
    Alias,
}

/// Unauthenticated public selectors, not observed or verified account state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Selection {
    pub host: WideHostRef,
    pub destination: ProvinceKey,
    pub transit_slot: u8,
    pub arrive_bell: u32,
    pub faction: u8,
    /// The member's index within its faction (0..4), not the final-set index.
    pub arrival_position: u8,
    /// Original-family identity used solely to derive the optional PREV_HOME
    /// Holding address. Presence does not prove capture or history.
    pub previous_home: Option<WideHostRef>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Evidence {
    Anchor { region: u8 },
    Archive { region: u8 },
}
impl Evidence {
    fn address(self, ctx: &AddrCtx, bell: u32) -> Result<Address, Error> {
        let region = match self {
            Self::Anchor { region } | Self::Archive { region } => region,
        };
        if region >= permutation_rules::frontier::geometry::REGIONS {
            return Err(Error::Region);
        }
        Ok(Address::new_from_array(match self {
            Self::Anchor { .. } => ctx.bell_anchor(bell, region),
            Self::Archive { .. } => ctx.anchor_archive(region, archive_part_of(bell)),
        }))
    }
}

/// Exact provided keys, never inferred from a short owner tag or assumed to
/// match current account contents. Repeated payees use unioned privileges.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Recipients {
    pub external_rent_to: Address,
    pub payer: Address,
    pub slot_beneficiary: Address,
    pub resolver: Address,
    pub holding_rent_payer: Address,
    pub settle_beneficiary: Address,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Role {
    pub name: &'static str,
    pub address: Address,
    pub signer: bool,
    pub writable: bool,
}

/// Immutable proposal. No Instruction, Message, Transaction, signing, send or
/// admission conversion exists. Only the payer is a required signer role.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Draft {
    program: Address,
    season: Address,
    selection: Selection,
    command: DraftCommand,
    layout: AccountLayout,
    roles: Vec<Role>,
}
impl Draft {
    /// Accept only already-public commitment/ciphertext bytes. This does not
    /// seal, decrypt, validate or change them, nor accept any decoded outcome.
    pub fn for_member(
        ctx: &AddrCtx,
        selection: Selection,
        evidence: Evidence,
        recipients: Recipients,
        public_commit: [u8; 32],
        public_seal: [u8; WIDE_SEAL_LEN],
    ) -> Result<Self, Error> {
        if ctx.program == [0; 32] || ctx.season == [0; 32] || ctx.program == ctx.season {
            return Err(Error::ContextOrHost);
        }
        let command = DraftCommand::new(selection.transit_slot, public_commit, public_seal)
            .map_err(|_| Error::Position)?;
        if selection.faction >= 6 || selection.arrival_position >= 4 {
            return Err(Error::Position);
        }
        let resolver = AccountResolver::for_season(ctx).map_err(|_| Error::ContextOrHost)?;
        resolver
            .legacy_host_id(&selection.host)
            .map_err(|_| Error::ContextOrHost)?;
        if resolver
            .family(selection.destination)
            .map_err(|_| Error::Destination)?
            != AccountFamily::Wide
        {
            return Err(Error::Destination);
        }
        let address = Address::new_from_array;
        let program = address(ctx.program);
        let holding = resolver
            .holding_address(&selection.host)
            .map_err(|_| Error::ContextOrHost)?;
        let mut keys = vec![
            address(ctx.season),
            address(holding),
            address(transit_address(ctx, &holding, selection.transit_slot)),
            address(
                resolver
                    .province_address(selection.host.key())
                    .map_err(|_| Error::ContextOrHost)?,
            ),
            address(
                resolver
                    .province_address(selection.destination)
                    .map_err(|_| Error::Destination)?,
            ),
            address(clash_inputs_address(
                ctx,
                selection.destination,
                selection.arrive_bell,
            )),
            address(arrival_slot_address(
                ctx,
                selection.destination,
                selection.arrive_bell,
                selection.faction,
                selection.arrival_position,
            )),
            recipients.external_rent_to,
        ];
        if let Some(previous) = selection.previous_home {
            resolver
                .legacy_host_id(&previous)
                .map_err(|_| Error::PreviousHome)?;
            keys.push(address(
                resolver
                    .holding_address(&previous)
                    .map_err(|_| Error::PreviousHome)?,
            ));
        }
        keys.extend([
            evidence.address(ctx, selection.arrive_bell)?,
            recipients.payer,
            recipients.slot_beneficiary,
            recipients.resolver,
            recipients.holding_rent_payer,
            recipients.settle_beneficiary,
        ]);
        let layout = AccountLayout::from_count(keys.len()).map_err(|_| Error::PreviousHome)?;
        let mut roles: Vec<_> = keys
            .iter()
            .enumerate()
            .map(|(i, key)| {
                let spec = layout.spec(i).expect("exact member role count");
                Role {
                    name: spec.name,
                    address: *key,
                    signer: spec.signer,
                    writable: spec.wr == Wr::W,
                }
            })
            .collect();
        for (i, key) in keys.iter().enumerate() {
            if *key == Address::default() || *key == program {
                return Err(Error::ZeroOrProgramRecipient);
            }
            for (j, previous) in keys[..i].iter().enumerate() {
                if previous == key && !layout.roles_may_alias(i, j) {
                    return Err(Error::Alias);
                }
            }
        }
        // Solana globalizes privileges over all positions for the same key.
        // Union every matching role, including three-or-more aliases.
        for i in 0..roles.len() {
            let signer = roles.iter().any(|r| r.address == keys[i] && r.signer);
            let writable = roles.iter().any(|r| r.address == keys[i] && r.writable);
            roles[i].signer = signer;
            roles[i].writable = writable;
        }
        Ok(Self {
            program,
            season: address(ctx.season),
            selection,
            command,
            layout,
            roles,
        })
    }
    pub fn program(&self) -> Address {
        self.program
    }
    pub fn season(&self) -> Address {
        self.season
    }
    pub fn selection(&self) -> Selection {
        self.selection
    }
    pub fn command(&self) -> DraftCommand {
        self.command
    }
    pub fn layout(&self) -> AccountLayout {
        self.layout
    }
    pub fn roles(&self) -> &[Role] {
        &self.roles
    }
    pub fn proposed_bytes(&self) -> [u8; DRAFT_LEN] {
        self.command.to_bytes()
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
