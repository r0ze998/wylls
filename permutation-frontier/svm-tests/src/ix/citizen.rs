//! Builders for Join, SetSession, SetVigil, FileTicket, SettleTicket,
//! ReleaseDormant, CloseHolding and CloseCitizen (§5.9, W3-A). The raw
//! builders are `fclient::ix`'s; this file adds the account positions the
//! forgery tests substitute. **MC (CQ2-A):** [`file_outpost`] (0xA3, MC
//! §5.5), which fclient does not build yet (CQ2-D).

pub use fclient::ix::{
    close_citizen, close_holding, file_ticket, join, release_dormant, seed_pair, set_session,
    set_vigil, settle_ticket, ticket_provinces, Displaced, HoldingRef, Player, SeedSource, Site,
};

/// Positions of Join's accounts.
pub mod join_at {
    pub const WALLET: usize = 0;
    pub const PAYER: usize = 1;
    pub const SEASON: usize = 2;
    pub const FRONTIER: usize = 3;
    pub const CITIZEN: usize = 4;
    pub const JOINSHARD: usize = 5;
    pub const SYSTEM: usize = 6;
    pub const JOIN_GATE: usize = 7;
}

/// Positions of the player prologue (every P instruction).
pub mod player_at {
    pub const ACTOR: usize = 0;
    pub const PAYER: usize = 1;
    pub const SEASON: usize = 2;
    pub const CITIZEN: usize = 3;
    /// FileTicket: the Frontier, then the Provinces.
    pub const FRONTIER: usize = 4;
    pub const PROVINCE0: usize = 5;
}

/// Positions of SettleTicket's accounts.
pub mod settle_at {
    pub const PAYER: usize = 0;
    pub const SEASON: usize = 1;
    pub const CITIZEN: usize = 2;
    pub const HOLDING: usize = 3;
    pub const PROVINCE: usize = 4;
    pub const JOINSHARD: usize = 5;
    pub const SEED: usize = 6;
    pub const ANCHOR: usize = 7;
    pub const OTHER0: usize = 8;
}

/// Positions of ReleaseDormant's accounts.
pub mod release_at {
    pub const ANY: usize = 0;
    pub const SEASON: usize = 1;
    pub const HOLDING: usize = 2;
    pub const PROVINCE: usize = 3;
    pub const CITIZEN: usize = 4;
    pub const JOINSHARD: usize = 5;
    pub const RENT_PAYER: usize = 6;
    pub const DPOOL: usize = 7;
}

/// 0xA3 FileOutpost (MC §5.5): FileTicket's list `[actor s] [payer s,w]
/// [season r] [citizen w] [frontier r] [province × m w] [system]` plus
/// `[anchor_holding w]`; data `n, sites, anchor_site_key` with the anchor
/// in host-id form (`host_id(P, Q, site, gen, 0)`).
pub fn file_outpost(
    a: &fclient::addr::Addresses,
    p: &Player,
    sites: &[Site],
    anchor: HoldingRef,
    anchor_gen: u8,
) -> solana_instruction::Instruction {
    use frontier_abi::ix::TicketSite;
    use frontier_abi::v2::ix::FileOutpost;
    let mut ix = file_ticket(a, p, sites);
    ix.accounts.push(solana_instruction::AccountMeta::new(
        anchor.address(a),
        false,
    ));
    let mut ts = [TicketSite::default(); 3];
    for (t, s) in ts.iter_mut().zip(sites) {
        *t = TicketSite {
            p: s.p,
            q: s.q,
            site: s.site,
        };
    }
    let x = FileOutpost {
        n: sites.len() as u8,
        sites: ts,
        anchor_site_key: anchor_key(anchor, anchor_gen),
    };
    let mut d = vec![0u8; FileOutpost::MAX_LEN];
    let n = x.encode(&mut d).expect("1–3 sites");
    d.truncate(n);
    ix.data = d;
    ix
}

/// A holding's key in host-id form (`index<<44 | site<<40 | gen<<32`).
pub fn anchor_key(h: HoldingRef, gen: u8) -> u64 {
    frontier_abi::addr::host_id(h.p as i32, h.q as i32, h.site, gen, 0).expect("a valid holding")
}

/// Positions of FileOutpost's accounts after the provinces (m of them):
/// `PROVINCE0 + m` is the System program, `PROVINCE0 + m + 1` the anchor.
pub mod outpost_at {
    pub const FRONTIER: usize = 4;
    pub const PROVINCE0: usize = 5;
    pub const fn anchor(m: usize) -> usize {
        PROVINCE0 + m + 1
    }
}
