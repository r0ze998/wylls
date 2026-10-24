//! ABI v2 instruction data (MC contract §5.5, §5.6): the seven new
//! instructions and CreateSeason v2. Every M1 encoding is unchanged
//! ([`crate::ix`]); the changed M1 instructions change their account
//! lists, not their data. Encoding rules are M1's: tag first, fixed
//! width, little-endian, no borsh (CreateSeason's trailing PayoutParams
//! excepted).

use crate::bytes::{Cursor, Writer};
use crate::error::FrontierError;
use crate::ix::{TicketSite, Wire, MAX_PAYOUT_PARAMS, MAX_TICKET_SITES};
use crate::v2::presets::{SeasonParamsV2, SEASON_PARAMS_V2_LEN};
use crate::v2::tags::Ix;

macro_rules! ix_data_v2 {
    ($( $(#[$m:meta])* $name:ident { $( $(#[$fm:meta])* $f:ident : $t:ty ),* $(,)? } )*) => {$(
        $(#[$m])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub struct $name { $( $(#[$fm])* pub $f: $t, )* }

        impl $name {
            pub const IX: Ix = Ix::$name;
            /// Data length with the tag.
            pub const LEN: usize = 1 $( + <$t as Wire>::N )*;
            /// Field names and widths, for the vector writer.
            pub const WIRE: &'static [(&'static str, usize)] = &[ $( (stringify!($f), <$t as Wire>::N), )* ];

            #[allow(unused_mut)]
            pub fn encode(&self, out: &mut [u8]) -> Option<usize> {
                let mut w = Writer::new(out);
                w.u8(Self::IX.tag());
                $( Wire::put(&self.$f, &mut w); )*
                w.finish()
            }

            pub fn to_bytes(&self) -> [u8; Self::LEN] {
                let mut b = [0u8; Self::LEN];
                // `b` has exactly `LEN` bytes, so encoding cannot run out.
                let _ = self.encode(&mut b);
                b
            }

            #[allow(unused_mut, unused_variables)]
            pub fn decode(d: &[u8]) -> Result<Self, FrontierError> {
                if d.len() != Self::LEN || d[0] != Self::IX.tag() {
                    return Err(FrontierError::BadData);
                }
                let mut c = Cursor::new(&d[1..]);
                Ok($name { $( $f: <$t as Wire>::get(&mut c).ok_or(FrontierError::BadData)?, )* })
            }
        }
    )*};
}

ix_data_v2! {
    /// 0xA0 (P): the target `site` of the Province at account 5; `entry`
    /// the declaring host (the hex's lead host); `nearby_site` the first
    /// holding of the attacker's faction that proves Frontier protection
    /// in the Province at account 8 (ignored when not needed).
    DeclareSiege { site: u8, entry: u8, nearby_site: u8 }
    /// 0xA1 (N).
    SettleSiege { site: u8 }
    /// 0xA2 (D).
    SettleCapture { site: u8, beneficiary: [u8; 32] }
    /// 0xA5 (D): `1 ≤ count ≤ 6` hours from `hour` (= `next_hour`).
    FoldMarch { m: i32, n: i32, hour: u32, count: u8, beneficiary: [u8; 32] }
    /// 0xA6 (P during the season, N after `end_bell`).
    RetireHost { entry: u8 }
    /// 0xA7 (N).
    CloseMarch {}
    /// 0xB0 (P, S1): a vault on `tile` of the Province at account 7.
    BuildVault { tile: u8 }
    /// 0xB1 (P, S1): the actor's `seq`-th caravan (= `Citizen.CARAVANS`)
    /// from the source account to the destination place, `steps` packed
    /// steps, `cargo` eight `u32` whole units (resource order), `fee` the
    /// settle fee escrowed (≥ `caravan::CARAVAN_FEE`).
    SendCaravan {
        seq: u32,
        dst_kind: u8,
        dst_p: i16,
        dst_q: i16,
        dst_at: u8,
        dst_gen: u8,
        steps: u8,
        path: [u8; 12],
        cargo: [u8; 32],
        fee: u64,
    }
    /// 0xB2 (D, S1).
    SettleCaravan { beneficiary: [u8; 32] }
    /// 0xB3 (P, S1): the raider settles the raid of the caravan's slot in
    /// Province `(p, q)`: `choice` take (0) or burn (1). A take (decision
    /// J2) makes the caravan the raider's and sends it from the raid tile to
    /// the destination place along `steps` packed steps, over the first
    /// `n_path` path Provinces (the raid's first); a burn destroys the
    /// cargo and the caravan goes on.
    RaidCaravan {
        p: i16,
        q: i16,
        choice: u8,
        n_path: u8,
        dst_kind: u8,
        dst_p: i16,
        dst_q: i16,
        dst_at: u8,
        dst_gen: u8,
        steps: u8,
        path: [u8; 12],
    }
    /// 0xB4 (P, S1): the captor's roster `entry` stands on the vault.
    SeizeVault { entry: u8 }
    /// 0xB5 (P, S1): the owner closes an empty vault.
    CloseVault {}
    /// 0xB6 (D, S1): the raid in Province `(p, q)` after the raider's
    /// window: a take to the raiding host's holding along `steps` over the
    /// first `n_path` path Provinces, or a burn (the holding gone, or no
    /// walk given after the burn delay).
    DefaultRaid {
        p: i16,
        q: i16,
        n_path: u8,
        steps: u8,
        path: [u8; 12],
        beneficiary: [u8; 32],
    }
}

ix_data_v2! {
    /// 0xB7 (P, S1, 1d/1e): a structure of `kind` (`structure::KIND_*`) on
    /// `tile` of the Province at account 7; `notify` who the herald tells
    /// of a tower's sightings (`layout::s1::structure::NOTIFY_*`).
    BuildStructure { kind: u8, tile: u8, notify: u8 }
    /// 0xB8 (P, S1, 1d/1e): the captor's roster `entry` stands on the
    /// structure (a fort: fallen).
    SeizeStructure { entry: u8 }
    /// 0xB9 (P, S1, 1d/1e): the owner closes the structure.
    CloseStructure {}
    /// 0xBA (P, S1, 1e): `troops` whole Spearmen of the holding's reserve
    /// join the fort from the next bell.
    FortGarrison { troops: u32 }
}

ix_data_v2! {
    /// 0xC0 (P, S2, 2a): the citizen issues `amount` units of a receipt
    /// (`kind` 2) or use (`kind` 3) ticket of its source (account 7).
    IssueTickets { kind: u8, resource: u8, amount: u64, per_unit: u64, until_day: u32 }
    /// 0xC1 (P, S2, 2a): `amount` units of the citizen's lot go to the
    /// recipient (a split when the recipient is the citizen).
    GiveLot { amount: u64 }
    /// 0xC2 (P, S2, 2a): closes the citizen's empty or void lot, and with
    /// `close_issue` its own issue once nothing is outstanding or it is void.
    CloseLot { close_issue: u8 }
    /// 0xC3 (P, S2, 2b): the owner opens its vault's shares.
    OpenShares {}
    /// 0xC4 (P, S2, 2b): the citizen burns `amount` units of its share lot
    /// and sends the basket out of the vault as caravan `seq` (otherwise as
    /// SendCaravan).
    WithdrawShares {
        seq: u32,
        amount: u64,
        dst_kind: u8,
        dst_p: i16,
        dst_q: i16,
        dst_at: u8,
        dst_gen: u8,
        steps: u8,
        path: [u8; 12],
        fee: u64,
    }
    /// 0xC5 (D, S2, 2b): SettleCaravan for a caravan into a shared vault.
    SettleDeposit { beneficiary: [u8; 32] }
    /// 0xC6 (P, S2, 2c): the citizen claims its receipt lot's entitlement
    /// for today.
    ClaimReceipt {}
    /// 0xC7 (P, S2, 2c): the citizen sends yesterday's grant out of the
    /// vault as caravan `seq` (otherwise as SendCaravan).
    WithdrawReceipt {
        seq: u32,
        dst_kind: u8,
        dst_p: i16,
        dst_q: i16,
        dst_at: u8,
        dst_gen: u8,
        steps: u8,
        path: [u8; 12],
        fee: u64,
    }
}

ix_data_v2! {
    /// 0xBB (P, S1, 1e): the citizen proposes to its Nation: a stance of
    /// `value` toward `target_faction` (`nation::KIND_STANCE`), or the
    /// expulsion or readmission of the Citizen at account 5.
    Propose { kind: u8, target_faction: u8, value: u8 }
    /// 0xBC (P, S1, 1e): the citizen's vote on proposal `id` in `slot`.
    Vote { slot: u8, id: u32, yes: u8 }
    /// 0xBD (D, S1, 1e): settles proposal `id` in `slot` once closed.
    SettleProposal { slot: u8, id: u32 }
    /// 0xBE (P, S1, 1e): the citizen's roster host `entry` stood on the
    /// tile the caravan (of its own faction) stood on at `bell`; opens the
    /// raid there (decision K4).
    RaidDomestic { bell: u32, entry: u8 }
}

/// SendCaravan's and RaidCaravan's cargo as milli-units (whole units ×
/// 1,000), checked.
pub fn cargo_milli(cargo: &[u8; 32]) -> Option<[i64; 8]> {
    let mut out = [0i64; 8];
    for (r, o) in out.iter_mut().enumerate() {
        let u = u32::from_le_bytes(cargo[4 * r..4 * r + 4].try_into().ok()?);
        *o = (u as i64).checked_mul(1_000)?;
    }
    Some(out)
}

/// Whole units as SendCaravan's cargo bytes.
pub fn cargo_bytes(units: &[u32; 8]) -> [u8; 32] {
    let mut b = [0u8; 32];
    for (r, u) in units.iter().enumerate() {
        b[4 * r..4 * r + 4].copy_from_slice(&u.to_le_bytes());
    }
    b
}

/// Most hours one FoldMarch folds.
pub const FOLD_MAX_HOURS: u8 = 6;

/// 0xA3 FileOutpost: `n u8 (1–3), n × {P i16, Q i16, site u8},
/// anchor_site_key u64` (15–25 B with the tag). `anchor_site_key` is the
/// anchor Holding's key in host-id form (`index<<44 | site<<40 | gen<<32`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileOutpost {
    pub n: u8,
    pub sites: [TicketSite; MAX_TICKET_SITES],
    pub anchor_site_key: u64,
}

impl FileOutpost {
    pub const IX: Ix = Ix::FileOutpost;
    pub const MIN_LEN: usize = 2 + 5 + 8;
    pub const MAX_LEN: usize = 2 + 5 * MAX_TICKET_SITES + 8;

    pub const fn data_len(&self) -> usize {
        2 + 5 * self.n as usize + 8
    }

    pub fn encode(&self, out: &mut [u8]) -> Option<usize> {
        if self.n == 0 || self.n as usize > MAX_TICKET_SITES {
            return None;
        }
        let mut w = Writer::new(out);
        w.u8(Self::IX.tag()).u8(self.n);
        for s in &self.sites[..self.n as usize] {
            w.i16(s.p).i16(s.q).u8(s.site);
        }
        w.u64(self.anchor_site_key);
        w.finish()
    }

    pub fn decode(d: &[u8]) -> Result<Self, FrontierError> {
        let bad = FrontierError::BadData;
        if d.first() != Some(&Self::IX.tag()) {
            return Err(bad);
        }
        let mut c = Cursor::new(&d[1..]);
        let n = c.u8().ok_or(bad)?;
        if n == 0 || n as usize > MAX_TICKET_SITES || d.len() != 2 + 5 * n as usize + 8 {
            return Err(bad);
        }
        let mut sites = [TicketSite::default(); MAX_TICKET_SITES];
        for s in sites.iter_mut().take(n as usize) {
            *s = TicketSite {
                p: c.i16().ok_or(bad)?,
                q: c.i16().ok_or(bad)?,
                site: c.u8().ok_or(bad)?,
            };
        }
        let anchor_site_key = c.u64().ok_or(bad)?;
        Ok(FileOutpost {
            n,
            sites,
            anchor_site_key,
        })
    }
}

/// 0x01 CreateSeason v2: `SeasonParams v2` (352 B) ‖ `PayoutParams`
/// (borsh, ≤ 128 B). `params_hash = sha256("PSF-PARAMS-v2" ‖ data[1..])`
/// ([`crate::v2::presets::params_hash_v2`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CreateSeasonV2<'a> {
    pub params: SeasonParamsV2,
    pub payout: &'a [u8],
}

impl<'a> CreateSeasonV2<'a> {
    pub const IX: Ix = Ix::CreateSeason;
    pub const MIN_LEN: usize = 1 + SEASON_PARAMS_V2_LEN;
    pub const MAX_LEN: usize = 1 + SEASON_PARAMS_V2_LEN + MAX_PAYOUT_PARAMS;

    pub fn encode(&self, out: &mut [u8]) -> Option<usize> {
        if self.payout.len() > MAX_PAYOUT_PARAMS {
            return None;
        }
        let mut w = Writer::new(out);
        w.u8(Self::IX.tag())
            .bytes(&self.params.to_bytes())
            .bytes(self.payout);
        w.finish()
    }

    pub fn decode(d: &'a [u8]) -> Result<Self, FrontierError> {
        let bad = FrontierError::BadData;
        let p = SEASON_PARAMS_V2_LEN;
        if d.first() != Some(&Self::IX.tag()) || d.len() < 1 + p || d.len() > Self::MAX_LEN {
            return Err(bad);
        }
        let params = SeasonParamsV2::from_bytes(&d[1..1 + p]).ok_or(bad)?;
        Ok(CreateSeasonV2 {
            params,
            payout: &d[1 + p..],
        })
    }
}

/// The tag of v2 instruction data (`BadData` for an unknown or reserved tag).
pub fn tag_of(data: &[u8]) -> Result<Ix, FrontierError> {
    data.first()
        .and_then(|t| Ix::from_tag(*t))
        .ok_or(FrontierError::BadData)
}

/// `(min, max)` data length with the tag.
pub fn data_len_range(ix: Ix) -> (usize, usize) {
    match ix {
        Ix::CreateSeason => (CreateSeasonV2::MIN_LEN, CreateSeasonV2::MAX_LEN),
        Ix::FileOutpost => (FileOutpost::MIN_LEN, FileOutpost::MAX_LEN),
        _ => match fixed_len(ix) {
            Some(n) => (n, n),
            None => ix.to_v1().map(crate::ix::data_len_range).unwrap_or((0, 0)),
        },
    }
}

/// `LEN` of each fixed-size v2 instruction.
pub fn fixed_len(ix: Ix) -> Option<usize> {
    Some(match ix {
        Ix::DeclareSiege => DeclareSiege::LEN,
        Ix::SettleSiege => SettleSiege::LEN,
        Ix::SettleCapture => SettleCapture::LEN,
        Ix::FoldMarch => FoldMarch::LEN,
        Ix::RetireHost => RetireHost::LEN,
        Ix::CloseMarch => CloseMarch::LEN,
        Ix::BuildVault => BuildVault::LEN,
        Ix::SendCaravan => SendCaravan::LEN,
        Ix::SettleCaravan => SettleCaravan::LEN,
        Ix::RaidCaravan => RaidCaravan::LEN,
        Ix::SeizeVault => SeizeVault::LEN,
        Ix::CloseVault => CloseVault::LEN,
        Ix::DefaultRaid => DefaultRaid::LEN,
        Ix::BuildStructure => BuildStructure::LEN,
        Ix::SeizeStructure => SeizeStructure::LEN,
        Ix::CloseStructure => CloseStructure::LEN,
        Ix::FortGarrison => FortGarrison::LEN,
        Ix::IssueTickets => IssueTickets::LEN,
        Ix::GiveLot => GiveLot::LEN,
        Ix::CloseLot => CloseLot::LEN,
        Ix::OpenShares => OpenShares::LEN,
        Ix::WithdrawShares => WithdrawShares::LEN,
        Ix::SettleDeposit => SettleDeposit::LEN,
        Ix::ClaimReceipt => ClaimReceipt::LEN,
        Ix::WithdrawReceipt => WithdrawReceipt::LEN,
        Ix::Propose => Propose::LEN,
        Ix::Vote => Vote::LEN,
        Ix::SettleProposal => SettleProposal::LEN,
        Ix::RaidDomestic => RaidDomestic::LEN,
        Ix::FileOutpost | Ix::CreateSeason => return None,
        other => return crate::ix::fixed_len(other.to_v1()?),
    })
}

/// Field names and widths of each fixed-size v2 instruction (vectors).
pub fn wire_of(ix: Ix) -> Option<&'static [(&'static str, usize)]> {
    Some(match ix {
        Ix::DeclareSiege => DeclareSiege::WIRE,
        Ix::SettleSiege => SettleSiege::WIRE,
        Ix::SettleCapture => SettleCapture::WIRE,
        Ix::FoldMarch => FoldMarch::WIRE,
        Ix::RetireHost => RetireHost::WIRE,
        Ix::CloseMarch => CloseMarch::WIRE,
        Ix::BuildVault => BuildVault::WIRE,
        Ix::SendCaravan => SendCaravan::WIRE,
        Ix::SettleCaravan => SettleCaravan::WIRE,
        Ix::RaidCaravan => RaidCaravan::WIRE,
        Ix::SeizeVault => SeizeVault::WIRE,
        Ix::CloseVault => CloseVault::WIRE,
        Ix::DefaultRaid => DefaultRaid::WIRE,
        Ix::BuildStructure => BuildStructure::WIRE,
        Ix::SeizeStructure => SeizeStructure::WIRE,
        Ix::CloseStructure => CloseStructure::WIRE,
        Ix::FortGarrison => FortGarrison::WIRE,
        Ix::IssueTickets => IssueTickets::WIRE,
        Ix::GiveLot => GiveLot::WIRE,
        Ix::CloseLot => CloseLot::WIRE,
        Ix::OpenShares => OpenShares::WIRE,
        Ix::WithdrawShares => WithdrawShares::WIRE,
        Ix::SettleDeposit => SettleDeposit::WIRE,
        Ix::ClaimReceipt => ClaimReceipt::WIRE,
        Ix::WithdrawReceipt => WithdrawReceipt::WIRE,
        Ix::Propose => Propose::WIRE,
        Ix::Vote => Vote::WIRE,
        Ix::SettleProposal => SettleProposal::WIRE,
        Ix::RaidDomestic => RaidDomestic::WIRE,
        Ix::FileOutpost | Ix::CreateSeason => return None,
        other => return crate::ix::wire_of(other.to_v1()?),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::v2::presets::MC_TEST;

    #[test]
    fn lengths_and_round_trips() {
        assert_eq!(DeclareSiege::LEN, 4);
        assert_eq!(SettleSiege::LEN, 2);
        assert_eq!(SettleCapture::LEN, 34);
        assert_eq!(FoldMarch::LEN, 46);
        assert_eq!(RetireHost::LEN, 2);
        assert_eq!(CloseMarch::LEN, 1);
        // S1
        assert_eq!(BuildVault::LEN, 2);
        assert_eq!(
            SendCaravan::LEN,
            1 + 4 + 1 + 2 + 2 + 1 + 1 + 1 + 12 + 32 + 8
        );
        assert_eq!(SettleCaravan::LEN, 33);
        assert_eq!(
            RaidCaravan::LEN,
            1 + 2 + 2 + 1 + 1 + 1 + 2 + 2 + 1 + 1 + 1 + 12
        );
        assert_eq!(DefaultRaid::LEN, 1 + 2 + 2 + 1 + 1 + 12 + 32);
        let units = [0, 120, 0, 40, 9, 0, 0, 0];
        let m = cargo_milli(&cargo_bytes(&units)).unwrap();
        assert_eq!(m[1], 120_000);
        assert_eq!(m[4], 9_000);
        let s = SendCaravan {
            seq: 3,
            dst_kind: 2,
            dst_p: -4,
            dst_q: 7,
            dst_at: 30,
            dst_gen: 1,
            steps: 5,
            path: [1; 12],
            cargo: cargo_bytes(&units),
            fee: 50_000,
        };
        let b = s.to_bytes();
        assert_eq!(b[0], 0xB1);
        assert_eq!(SendCaravan::decode(&b), Ok(s));
        let f = FoldMarch {
            m: -2,
            n: 3,
            hour: 77,
            count: 6,
            beneficiary: [9; 32],
        };
        let b = f.to_bytes();
        assert_eq!(b[0], 0xA5);
        assert_eq!(FoldMarch::decode(&b), Ok(f));
        assert_eq!(tag_of(&b), Ok(Ix::FoldMarch));
        assert_eq!(tag_of(&[0xA4]), Err(FrontierError::BadData));
        let o = FileOutpost {
            n: 2,
            sites: [
                TicketSite {
                    p: 4,
                    q: -1,
                    site: 7,
                },
                TicketSite {
                    p: 5,
                    q: -1,
                    site: 0,
                },
                TicketSite::default(),
            ],
            anchor_site_key: 0x0123_4567_89AB_CDEF,
        };
        let mut buf = [0u8; FileOutpost::MAX_LEN];
        let n = o.encode(&mut buf).unwrap();
        assert_eq!(n, o.data_len());
        assert_eq!(FileOutpost::decode(&buf[..n]), Ok(o));
        assert!(FileOutpost::decode(&buf[..n - 1]).is_err());
        let payout = [1u8, 2, 3];
        let c = CreateSeasonV2 {
            params: MC_TEST,
            payout: &payout,
        };
        let mut buf = [0u8; CreateSeasonV2::MAX_LEN];
        let n = c.encode(&mut buf).unwrap();
        assert_eq!(n, 1 + 352 + 3);
        assert_eq!(CreateSeasonV2::decode(&buf[..n]), Ok(c));
        for ix in Ix::ALL {
            let (lo, hi) = data_len_range(*ix);
            assert!(lo >= 1 && lo <= hi, "{}", ix.name());
        }
    }
}
