//! Wide keep holders by bell, for the public per-nation province counts
//! (`/h/standings`, the page's 「支配する州」 bar). A wide Province (ring
//! 129+) is not one of `Fold::provinces` — it never gates the control
//! files' completeness, and the dense `PSFCT1` file cannot hold it — so the
//! hour figures would never see a wide capture. This keeps, per captured
//! wide Province, the keep's holder as its captures say it, from the bell
//! each capture speaks for (`resolved_next − 1`: the bytes after resolving
//! every bell before `resolved_next`).
//!
//! **Counts only.** Nothing positional leaves this module: the control
//! fold asks for six numbers per bell ([`KeepHolders::counts_at`]), so the
//! fog of war (#93 §4 item 13: public counts allowed) is unchanged.
//!
//! **Cost.** A capture appends only when the holder changes (a no-op
//! otherwise); the control fold prunes every entry older than the next
//! control bell ([`KeepHolders::prune`]), so each Province keeps one entry
//! plus the changes not yet written. `counts_at` is one pass over the
//! Provinces (the legacy view loop does the same per bell).
//!
//! **Not bell-exact for a lagging wide Province.** A Province resolved only
//! through an earlier bell counts with its latest known holder; one first
//! captured after `b` (e.g. after a restart, which rebuilds from the latest
//! capture only) counts with its earliest known holder.
use std::collections::BTreeMap;

/// No holder (the keep is unheld, or the Province has no keep).
pub const NO_HOLDER: u8 = 0xff;
const NATIONS: usize = 6;

#[derive(Clone, Debug)]
pub struct KeepHolders<K: Ord> {
    hist: BTreeMap<K, Vec<(u32, u8)>>,
}

impl<K: Ord> Default for KeepHolders<K> {
    fn default() -> Self {
        Self {
            hist: BTreeMap::new(),
        }
    }
}

impl<K: Ord + Clone> KeepHolders<K> {
    /// A capture of `key` resolved through `resolved_next − 1` whose keep is
    /// held by `holder` (`None`, or ≥ 6: unheld).
    pub fn observe(&mut self, key: &K, resolved_next: u32, holder: Option<u8>) {
        let h = holder
            .filter(|x| (*x as usize) < NATIONS)
            .unwrap_or(NO_HOLDER);
        let from = resolved_next.saturating_sub(1);
        let v = self.hist.entry(key.clone()).or_default();
        match v.last_mut() {
            Some(last) if last.1 == h => {}
            // (a capture never moves a Province back; a same-or-earlier bell replaces the last word)
            Some(last) if from <= last.0 => {
                last.1 = h;
                let n = v.len();
                if n >= 2 && v[n - 2].1 == h {
                    v.pop();
                }
            }
            _ => v.push((from, h)),
        }
    }

    /// The Province is closed: it no longer counts.
    pub fn remove(&mut self, key: &K) {
        self.hist.remove(key);
    }

    /// Provinces held per nation at bell `b`.
    pub fn counts_at(&self, b: u32) -> [u32; NATIONS] {
        let mut out = [0u32; NATIONS];
        for v in self.hist.values() {
            let h = v
                .iter()
                .rev()
                .find(|(from, _)| *from <= b)
                .or(v.first())
                .map_or(NO_HOLDER, |x| x.1);
            if (h as usize) < NATIONS {
                out[h as usize] = out[h as usize].saturating_add(1);
            }
        }
        out
    }

    /// Forgets what no control bell at or after `next` can ask for.
    pub fn prune(&mut self, next: u32) {
        for v in self.hist.values_mut() {
            let keep_from = v.iter().rposition(|(from, _)| *from <= next).unwrap_or(0);
            if keep_from > 0 {
                v.drain(..keep_from);
            }
        }
    }

    /// Entries held (bounded-memory checks).
    pub fn entries(&self) -> usize {
        self.hist.values().map(Vec::len).sum()
    }

    pub fn len(&self) -> usize {
        self.hist.len()
    }

    pub fn is_empty(&self) -> bool {
        self.hist.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_wide_capture_counts_from_the_bell_it_speaks_for() {
        let mut k = KeepHolders::<u32>::default();
        k.observe(&1, 130, Some(2));
        k.observe(&2, 130, None);
        assert_eq!(k.counts_at(129), [0, 0, 1, 0, 0, 0]);
        // the keep taken while resolving bell 200: counted from 200 on, not before
        k.observe(&2, 201, Some(4));
        assert_eq!(k.counts_at(199), [0, 0, 1, 0, 0, 0]);
        assert_eq!(k.counts_at(200), [0, 0, 1, 0, 1, 0]);
        // an unchanged holder appends nothing
        k.observe(&2, 260, Some(4));
        assert_eq!(k.entries(), 3);
        // a holder ≥ 6 is unheld
        k.observe(&1, 300, Some(9));
        assert_eq!(k.counts_at(300), [0, 0, 0, 0, 1, 0]);
        k.remove(&2);
        assert_eq!(k.counts_at(400), [0; 6]);
    }

    #[test]
    fn pruning_keeps_one_entry_per_province_and_the_answers() {
        let mut k = KeepHolders::<u32>::default();
        for b in 0..1000u32 {
            k.observe(&7, b + 1, Some((b / 10 % 6) as u8));
            if b % 50 == 0 {
                k.prune(b.saturating_sub(5));
            }
        }
        k.prune(995);
        assert_eq!(
            k.entries(),
            1,
            "bounded: one entry once every change is past"
        );
        assert_eq!(k.counts_at(999), [0, 0, 0, 1, 0, 0]);
        // before the earliest kept bell: the earliest known holder (a restart's rebuild)
        let mut r = KeepHolders::<u32>::default();
        r.observe(&1, 500, Some(3));
        assert_eq!(r.counts_at(10), [0, 0, 0, 1, 0, 0]);
    }

    #[test]
    fn a_same_bell_recapture_replaces_the_last_word() {
        let mut k = KeepHolders::<u32>::default();
        k.observe(&1, 100, Some(1));
        k.observe(&1, 150, Some(2));
        k.observe(&1, 150, Some(1));
        assert_eq!(k.entries(), 1);
        assert_eq!(k.counts_at(160), [0, 1, 0, 0, 0, 0]);
    }

    #[test]
    fn five_thousand_provinces_stay_cheap() {
        let mut k = KeepHolders::<u32>::default();
        for i in 0..4_900u32 {
            k.observe(&i, 130, Some((i % 7) as u8));
        }
        let t = std::time::Instant::now();
        let mut total = 0u32;
        for b in 130..230u32 {
            total += k.counts_at(b).iter().sum::<u32>();
        }
        assert_eq!(total, 100 * (4_900 - 4_900 / 7));
        assert!(
            t.elapsed().as_millis() < 2_000,
            "100 bells over 4,900 provinces"
        );
        assert_eq!(k.entries(), 4_900);
    }
}
