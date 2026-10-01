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
