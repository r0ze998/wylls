//! ⑳ NFT resident ID: the switches for the items listed in
//! `permutation-nft-resident-spike/docs/UNDECIDED.ja.md`.
//!
//! Owner decision 2026-11-18 18:26 JST (t351u): implement the NFT resident ID
//! for local and devnet builds only (no mainnet issuance, no sale, no price,
//! no royalties). Each item below has the most conservative default; r0ze
//! confirmed these defaults on 2026-11-18 21:44 JST (t353u, "keep current
//! defaults": transfer only through our own method, AI memory not carried,
//! votes, cargo and debt follow the resident, no per-wallet cap, no sale).
//!
//! Only [`Transfer`] is enforced by the Frontier program
//! (`resident_binding::check_actor`). The other items are enforced off-chain
//! or describe what the program already does. They are kept here so that the
//! program, the relay (`permutation-gateway/src/frontier/resident-terms.mjs`,
//! which mirrors this table and is checked against it by a test) and the docs
//! have one list.

/// U7/U18 (the trading method) and the earlier owner record "the resident's
/// game data and control rights can be sold or transferred": can the holder
/// change through the resident program's `TransferResident`?
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Transfer {
    /// Option B (the owner's starting point, local only): a transferred
    /// resident is played by its new holder at the new generation. The
    /// previous holder, its sessions and anything signed before the transfer
    /// are refused.
    Allowed,
    /// Soulbound: only the first holder (generation 0) ever acts. After a
    /// `TransferResident`, every action is refused
    /// (`ResidentNotCurrentAuthority`). Build with the program feature
    /// `nft-resident-no-transfer`.
    Refused,
}

/// U9 (the AI's private memory) and U8 (private talk and council lines).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Private {
    /// Not carried to a new holder: what the previous holder could read
    /// privately stays with that holder's generation (the spike's "分離").
    NotCarried,
    /// Carried with the resident as part of its identity.
    Carried,
}

/// U5: the voting start (`Citizen.JOIN_BELL`, 288 bells before a vote).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Voting {
    /// The Citizen keeps its `JOIN_BELL`: the program does not reset it on
    /// transfer (what the code does today).
    KeptByResident,
    /// Reset on a change of holder (not implemented).
    ResetOnTransfer,
}

/// U17 and DATA-MAP §3: goods held for others and debts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Obligations {
    /// Moved with the resident, never erased (what the code does today: they
    /// live on the Citizen and its Holdings, which do not change on transfer).
    MovedWithResident,
}

/// U10: sealed, not yet public information (a sealed march's target).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sealed {
    /// Nobody sees it before its public time, the new holder included.
    UntilPublicTime,
}

/// U31: how many residents one wallet may hold.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PerWallet {
    /// One link per (Season, asset); a wallet may hold several (the code
    /// today).
    Many,
}

/// U6/U38: binding an existing wallet Citizen to an NFT.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Migration {
    /// Not possible: an NFT resident gets a new Citizen through
    /// `JoinResident`; wallet Citizens stay wallet Citizens (the code today).
    None,
}

/// U1/U20/U24/U30: sale, price, supply, royalties.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sale {
    /// No sale path, no price, no royalties plugin (owner, 2026-11-18).
    None,
}

/// The switches as one value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Terms {
    pub transfer: Transfer,
    pub private: Private,
    pub voting: Voting,
    pub obligations: Obligations,
    pub sealed: Sealed,
    pub per_wallet: PerWallet,
    pub migration: Migration,
    pub sale: Sale,
}

/// The defaults (conservative; confirmed by r0ze 2026-11-18 21:44 JST, t353u).
pub const DEFAULT: Terms = Terms {
    transfer: Transfer::Allowed,
    private: Private::NotCarried,
    voting: Voting::KeptByResident,
    obligations: Obligations::MovedWithResident,
    sealed: Sealed::UntilPublicTime,
    per_wallet: PerWallet::Many,
    migration: Migration::None,
    sale: Sale::None,
};

/// The terms this build enforces: [`DEFAULT`], with transfers refused when
/// built with `resident-transfer-refused` (the program's
/// `nft-resident-no-transfer`).
pub const ACTIVE: Terms = Terms {
    transfer: if cfg!(feature = "resident-transfer-refused") {
        Transfer::Refused
    } else {
        DEFAULT.transfer
    },
    ..DEFAULT
};

impl Terms {
    /// Whether a holder at `generation` may act. Generation 0 is the first
    /// holder; every `TransferResident` adds one.
    pub const fn holder_may_act(&self, generation: u32) -> bool {
        match self.transfer {
            Transfer::Allowed => true,
            Transfer::Refused => generation == 0,
        }
    }

    /// The key under which private, per-resident data (U8/U9) is kept off
    /// chain: the asset and, unless private data is carried, the holder
    /// generation, so a new holder starts with nothing private.
    pub fn private_scope(&self, asset: &[u8; 32], generation: u32) -> ([u8; 32], Option<u32>) {
        match self.private {
            Private::NotCarried => (*asset, Some(generation)),
            Private::Carried => (*asset, None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_the_conservative_ones() {
        assert_eq!(DEFAULT.transfer, Transfer::Allowed);
        assert_eq!(DEFAULT.private, Private::NotCarried);
        assert_eq!(DEFAULT.voting, Voting::KeptByResident);
        assert_eq!(DEFAULT.sale, Sale::None);
        assert_eq!(DEFAULT.migration, Migration::None);
        if cfg!(feature = "resident-transfer-refused") {
            assert_eq!(ACTIVE.transfer, Transfer::Refused);
        } else {
            assert_eq!(ACTIVE, DEFAULT);
        }
    }

    #[test]
    fn the_transfer_switch_decides_who_acts_after_a_transfer() {
        assert!(DEFAULT.holder_may_act(0));
        assert!(DEFAULT.holder_may_act(1));
        assert!(DEFAULT.holder_may_act(7));
        let soulbound = Terms {
            transfer: Transfer::Refused,
            ..DEFAULT
        };
        assert!(soulbound.holder_may_act(0));
        assert!(!soulbound.holder_may_act(1));
        assert!(!soulbound.holder_may_act(u32::MAX));
    }

    #[test]
    fn private_data_is_scoped_to_the_holder_generation_unless_carried() {
        let asset = [7u8; 32];
        assert_eq!(DEFAULT.private_scope(&asset, 0), (asset, Some(0)));
        assert_ne!(
            DEFAULT.private_scope(&asset, 0),
            DEFAULT.private_scope(&asset, 1)
        );
        let carried = Terms {
            private: Private::Carried,
            ..DEFAULT
        };
        assert_eq!(
            carried.private_scope(&asset, 0),
            carried.private_scope(&asset, 3)
        );
    }
}
