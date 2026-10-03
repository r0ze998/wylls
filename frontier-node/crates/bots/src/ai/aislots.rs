//! The AI slots file (`AI_DIR/ai-slots.json`, contract §2.3) and the AI
//! fleet's roster.
//!
//! `{v:1, seed, first_index:1000, slots:[{index, faction, join_bell,
//! kind:"ai"|"seat"}]}`. AI slots are indices `1000 .. 1000+n−1`
//! (n = 6, 12 or 18), faction = (index − 1000) mod 6, join_bell = index −
//! 1000; the seat is index `1000+n`, faction 0, `kind:"seat"`. Wallets are
//! `keys::wallet(seed, index)` with `seed` = the stack toml's `bot_seed`.
//! **AI indices start at 1000** so they never meet the script bots' indices
//! `0..bots−1` (test `ai_slots_disjoint.rs`).
//!
//! The roster: an AI slot plays as a `Skilled` agent (the autopilot's
//! archetype, §3.6) with no persona; the seat slot is `Idle` ("pays and
//! founds a holding, then never plays": it joins and files its ticket, then
//! the operator's seat script or the presenter acts with the exported key,
//! `--export-seat-key`). The seat never calls the mind.

use std::collections::BTreeSet;
use std::path::Path;

use frontier_agents::profile::{AgentSpec, Arch, BELLS_PER_DAY};
use serde_json::{json, Value};

/// First index of the AI fleet (contract §2.3).
pub const FIRST_INDEX: u32 = 1000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SlotKind {
    Ai,
    Seat,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Slot {
    pub index: u32,
    pub faction: u8,
    pub join_bell: u32,
    pub kind: SlotKind,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AiSlots {
    pub seed: u64,
    pub first_index: u32,
    pub slots: Vec<Slot>,
}

impl AiSlots {
    pub fn parse(text: &str) -> Result<AiSlots, String> {
        let v: Value = serde_json::from_str(text).map_err(|e| format!("ai-slots: {e}"))?;
        if v.get("v").and_then(Value::as_u64) != Some(1) {
            return Err("ai-slots: v != 1".into());
        }
        let seed = v
            .get("seed")
            .and_then(|x| x.as_u64().or_else(|| x.as_str().and_then(|s| s.parse().ok())))
            .ok_or("ai-slots: seed")?;
        let first_index = v
            .get("first_index")
            .and_then(Value::as_u64)
            .ok_or("ai-slots: first_index")? as u32;
        let mut slots = vec![];
        let mut seen = BTreeSet::new();
        for s in v
            .get("slots")
            .and_then(Value::as_array)
            .ok_or("ai-slots: slots")?
        {
            let index = s.get("index").and_then(Value::as_u64).ok_or("slot index")? as u32;
            let faction = s
                .get("faction")
                .and_then(Value::as_u64)
                .filter(|f| *f < 6)
                .ok_or("slot faction (0..5)")? as u8;
            let join_bell = s
                .get("join_bell")
                .and_then(Value::as_u64)
                .ok_or("slot join_bell")? as u32;
            let kind = match s.get("kind").and_then(Value::as_str) {
                Some("ai") => SlotKind::Ai,
                Some("seat") => SlotKind::Seat,
                _ => return Err("slot kind (ai|seat)".into()),
            };
            if index < first_index {
                return Err(format!("slot {index} below first_index {first_index}"));
            }
            if !seen.insert(index) {
                return Err(format!("slot {index} twice"));
            }
            slots.push(Slot {
                index,
                faction,
                join_bell,
                kind,
            });
        }
        slots.sort_by_key(|s| s.index);
        Ok(AiSlots {
            seed,
            first_index,
            slots,
        })
    }

    pub fn load(path: &Path) -> Result<AiSlots, String> {
        let t = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        AiSlots::parse(&t)
    }

    /// Whether `index` is an AI citizen (never the seat, never a script bot).
    pub fn is_ai(&self, index: u32) -> bool {
        self.slots
            .iter()
            .any(|s| s.index == index && s.kind == SlotKind::Ai)
    }

    pub fn ai_count(&self) -> usize {
        self.slots
            .iter()
            .filter(|s| s.kind == SlotKind::Ai)
            .count()
    }

    pub fn seat(&self) -> Option<&Slot> {
        self.slots.iter().find(|s| s.kind == SlotKind::Seat)
    }

    /// The fleet's roster: AI slots `Skilled`, the seat `Idle`.
    pub fn specs(&self) -> Vec<AgentSpec> {
        self.slots
            .iter()
            .map(|s| AgentSpec {
                index: s.index,
                arch: match s.kind {
                    SlotKind::Ai => Arch::Skilled,
                    SlotKind::Seat => Arch::Idle,
                },
                faction: s.faction,
                join_day: s.join_bell / BELLS_PER_DAY,
                join_bell: s.join_bell,
                persona: None,
            })
            .collect()
    }
}

/// `--export-seat-key FILE`: writes the seat's wallet and session keys
/// (local test keys derived from the public `--seed`, contract §12.1 R9) as
/// one JSON object, mode 0600. Refused under a `pub` or `state` directory
/// (the AI's published and private trees). The file format is not pinned by
/// the contract: `{index, wallet, wallet_keypair_b58, session,
/// session_keypair_b58}`.
pub fn write_seat_key(path: &Path, seed: u64, index: u32) -> Result<(), String> {
    for c in path.components() {
        let s = c.as_os_str().to_string_lossy();
        if s == "pub" || s == "state" {
            return Err(format!(
                "--export-seat-key: {} is under a pub or state directory",
                path.display()
            ));
        }
    }
    use fclient::Signer;
    let w = frontier_agents::keys::wallet(seed, index);
    let s = frontier_agents::keys::session(seed, index);
    let body = json!({
        "index": index,
        "wallet": w.pubkey().to_string(),
        "wallet_keypair_b58": w.to_base58_string(),
        "session": s.pubkey().to_string(),
        "session_keypair_b58": s.to_base58_string(),
    });
    let text = serde_json::to_string_pretty(&body).map_err(|e| e.to_string())?;
    use std::io::Write;
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    o.mode(0o600);
    let mut f = o.open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        f.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    f.write_all(text.as_bytes())
        .map_err(|e| format!("{}: {e}", path.display()))
}
