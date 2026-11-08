//! Instruction tags and data (M1 contract §5.5–§5.12).
//!
//! The encodings live once, in `frontier_abi::{tags, ix}` (fixed width,
//! little-endian, no borsh; `decode` refuses a wrong tag or length with
//! `BadData`). This module re-exports them for the handlers and adds the
//! one piece of instruction data the ABI leaves to the program: the
//! hash-to-curve hint bundle a beacon carries.

pub use frontier_abi::ix::*;
pub use frontier_abi::tags::{is_reserved, Class, Ix};

/// ABI v2 (MC contract §5.4–§5.6): the v2 tag set the program dispatches
/// on (`v2::Ix`, 73 tags), the new instructions' data and CreateSeason v2.
/// The M1 names above are unchanged; a changed M1 instruction keeps its
/// data and changes only its account list (§5.6).
pub mod v2 {
    pub use frontier_abi::v2::ix::*;
    pub use frontier_abi::v2::tags::{is_reserved, relay_player_shape, relay_settle_shape, Ix};
}

/// A verified-beacon argument as instructions carry it: the round, the
/// 48-B compressed quicknet signature and the two 145-B SSWU hints
/// (`hint(u0) ‖ hint(u1)`, SP-V2 `quick::HINT_LEN`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BeaconArg<'a> {
    pub round: u64,
    pub sig48: &'a [u8; SIG48_LEN],
    pub hints: &'a [u8; HINTS_LEN],
}

/// The regions named by a PostAnchorMulti `mask`, ascending, and their
/// count (bits above region 15 are refused by the caller).
pub fn mask_regions(mask: u16) -> ([u8; 16], usize) {
    let mut out = [0u8; 16];
    let mut n = 0;
    for r in 0..16u8 {
        if mask & (1 << r) != 0 {
            out[n] = r;
            n += 1;
        }
    }
    (out, n)
}

/// Exact size of a legacy transaction (one signature per signer, the
/// three ComputeBudget instructions every Frontier transaction carries
/// first, then `ix_accounts` account positions and `data_len` bytes of
/// instruction data) over `n_keys` distinct account keys (the program id
/// and the ComputeBudget program included).
pub fn legacy_tx_len(n_sigs: usize, n_keys: usize, ix_accounts: usize, data_len: usize) -> usize {
    fn compact(n: usize) -> usize {
        match n {
            0..=0x7f => 1,
            0x80..=0x3fff => 2,
            _ => 3,
        }
    }
    // SetComputeUnitLimit (5 B), SetComputeUnitPrice (9 B),
    // SetLoadedAccountsDataSizeLimit (5 B): program index, no accounts.
    let budget: usize = [5usize, 9, 5].iter().map(|d| 1 + 1 + 1 + d).sum();
    let ix = 1 + compact(ix_accounts) + ix_accounts + compact(data_len) + data_len;
    compact(n_sigs)
        + 64 * n_sigs
        + 3
        + compact(n_keys)
        + 32 * n_keys
        + 32
        + compact(4)
        + budget
        + ix
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `MULTI_MAX_REGIONS` (7) is the most regions a PostAnchorMulti fits
    /// in the 1,232-B packet (contract v1.2 §5.8): the account list from
    /// the ABI table with `k` anchors and `k` archives, all distinct keys,
    /// plus the program id and the ComputeBudget program. 7 regions are
    /// 1,177 B and 8 are 1,243 B (also measured on the wire by the W2-A
    /// LiteSVM smoke).
    #[test]
    fn multi_max_regions_is_the_largest_that_fits_a_packet() {
        use frontier_abi::budgets::{MULTI_MAX_REGIONS, TX_MAX};
        use frontier_abi::prologue::{resolve, Acc, Spec, Wr};
        let size = |k: usize| {
            let mut out = [Spec {
                name: "",
                acc: Acc::Any,
                signer: false,
                wr: Wr::R,
            }; 64];
            let n = resolve(Ix::PostAnchorMulti, &[1, k as u8, k as u8, 1], &mut out)
                .unwrap_or(2 + 2 * k + 2);
            legacy_tx_len(1, n + 2, n, PostAnchorMulti::LEN)
        };
        assert_eq!(PostAnchorMulti::LEN, 385);
        assert_eq!(size(7), 1_177);
        assert_eq!(size(8), 1_243);
        assert!(size(MULTI_MAX_REGIONS) <= TX_MAX as usize);
        assert!(size(MULTI_MAX_REGIONS + 1) > TX_MAX as usize);
        // PostAnchor itself: 6 accounts, 385 B of data → 780 B (measured).
        assert_eq!(legacy_tx_len(1, 8, 6, PostAnchor::LEN), 780);
    }

    #[test]
    fn mask_regions_are_ascending() {
        let (r, n) = mask_regions(0b1000_0000_0100_0101);
        assert_eq!(&r[..n], &[0, 2, 6, 15]);
        assert_eq!(mask_regions(0).1, 0);
        assert_eq!(mask_regions(u16::MAX).1, 16);
    }

    #[test]
    fn every_tag_decodes_to_its_instruction() {
        for ix in Ix::ALL {
            assert_eq!(Ix::from_tag(ix.tag()), Some(*ix));
            assert!(!is_reserved(ix.tag()));
        }
        for t in [0x00u8, 0x0a, 0x53, 0x80, 0x8f, 0x90, 0x91, 0xff] {
            assert!(tag_of(&[t]).is_err(), "{t:#x}");
        }
    }

    /// The v2 dispatch set (MC §5.4): every M1 tag plus the seven MC tags,
    /// S1's seventeen (0xB0–0xBE, 0xC0, 0xC1) and custody's eleven
    /// (0xC2–0xCC, workstream 10); 0xA4, 0xA8–0xAF and 0xBF stay reserved
    /// (`BadData`).
    #[test]
    fn every_v2_tag_decodes_and_reserved_ones_do_not() {
        assert_eq!(v2::Ix::ALL.len(), 86);
        for ix in v2::Ix::ALL {
            assert_eq!(v2::tag_of(&[ix.tag()]), Ok(*ix));
            assert!(!v2::is_reserved(ix.tag()));
        }
        for v1 in Ix::ALL {
            assert_eq!(v2::Ix::of_v1(*v1).tag(), v1.tag());
        }
        for t in [0xA4u8, 0xA8, 0xAB, 0xAF, 0xBF, 0xCD, 0x53, 0x00, 0xff] {
            assert!(v2::tag_of(&[t]).is_err(), "{t:#x}");
        }
    }

    /// The S1 build refuses every custody tag before reading an account
    /// (`BadData`); only the `custody-preview` build dispatches them.
    #[cfg(all(feature = "program", not(feature = "custody-preview")))]
    #[test]
    fn the_s1_build_refuses_custody_tags() {
        let pid = solana_program::pubkey::Pubkey::new_from_array([7; 32]);
        for ix in v2::Ix::CUSTODY {
            let r = crate::dispatch(&pid, &[], &[ix.tag()]);
            assert!(
                matches!(r, Err(e) if e == crate::FrontierError::BadData.into()),
                "{}",
                ix.name()
            );
        }
        assert_eq!(
            crate::RULESET_HASH,
            frontier_abi::v2::presets::RULESET_HASH_V3
        );
        assert_eq!(
            crate::PROGRAM_VERSION,
            4 | if cfg!(feature = "capacity-preview") {
                0x1000
            } else {
                0
            }
        );
    }

    #[cfg(feature = "custody-preview")]
    #[test]
    fn the_custody_preview_is_another_program() {
        assert_eq!(
            crate::RULESET_HASH,
            frontier_abi::v2::presets::RULESET_HASH_V4
        );
        assert_eq!(
            crate::PROGRAM_VERSION,
            5 | if cfg!(feature = "capacity-preview") {
                0x1000
            } else {
                0
            }
        );
        assert_eq!(crate::RULES_VERSION, 13);
    }

    /// Workstream 10: a lot's room is reserved against the vault's `CAP`
    /// only if every write of a vault's general stock keeps `STORES +
    /// CUSTODY_QUOTA ≤ CAP`. The writers are listed here; a new one (a
    /// workstream crediting a vault) must clamp as SettleCaravan does and be
    /// added, or the reservation is no longer a guarantee.
    #[test]
    fn vault_stock_writers_are_the_listed_ones() {
        fn walk(dir: &std::path::Path, out: &mut Vec<(String, String)>) {
            for e in std::fs::read_dir(dir).unwrap() {
                let p = e.unwrap().path();
                if p.is_dir() {
                    walk(&p, out);
                } else if p.extension().is_some_and(|x| x == "rs")
                    && p.file_name().is_some_and(|n| n != "ix.rs")
                {
                    let name = p.file_name().unwrap().to_string_lossy().to_string();
                    for l in std::fs::read_to_string(&p).unwrap().lines() {
                        let l = l.trim();
                        if l.contains("set_i64(VA::store(") {
                            out.push((name.clone(), l.to_string()));
                        }
                    }
                }
            }
        }
        let mut found = vec![];
        walk(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
            &mut found,
        );
        found.sort();
        let want = [
            // SettleCaravan: clamped to CAP − CUSTODY_QUOTA.
            ("caravan.rs", "Rw(&mut vd).set_i64(VA::store(r), to)?;"),
            // SendCaravan from a vault: a debit.
            (
                "caravan.rs",
                "Rw(&mut vd).set_i64(VA::store(r), have - c)?;",
            ),
            // Custody: the kernel's view written back (forfeiture within the
            // lot's quota, a deposit's debit).
            ("custody.rs", "w.set_i64(VA::store(i), v.stores[i])?;"),
            // Capacity (workstream 09, `capacity-preview`): a deposit's
            // debit, a claim's credit refused past `CAP − CUSTODY_QUOTA`.
            ("capacity.rs", "w.set_i64(VA::store(i), self.stores[i])?;"),
        ];
        let want: Vec<(String, String)> = want
            .iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect();
        let mut want = want;
        want.sort();
        assert_eq!(found, want, "a new writer of a vault's STORES");
    }
}
