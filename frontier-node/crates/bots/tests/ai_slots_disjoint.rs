//! Contract §2.3: AI indices start at 1000, so they never meet the script
//! bots' indices; the slots file and the AI roster; `--export-seat-key`.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use fclient::Signer;
use frontier_agents::profile::{roster, Arch, Mix};
use frontier_bots::ai::aislots::{self, AiSlots, SlotKind, FIRST_INDEX};
use serde_json::json;

fn slots_json(seed: u64, n: u32) -> String {
    let mut slots: Vec<_> = (0..n)
        .map(|k| json!({"index": 1000 + k, "faction": k % 6, "join_bell": k, "kind": "ai"}))
        .collect();
    slots.push(json!({"index": 1000 + n, "faction": 0, "join_bell": 0, "kind": "seat"}));
    json!({"v": 1, "seed": seed, "first_index": 1000, "slots": slots}).to_string()
}

/// `bots` and `bot_seed` of a stack toml if it exists in this checkout (AC5
/// writes them under `permutation-gateway/citizens/stack/`), else the
/// contract's values (§8.4).
fn toml_or(name: &str, bots: usize, seed: u64) -> (usize, u64, &'static str) {
    let p: PathBuf = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../permutation-gateway/citizens/stack")
        .join(name);
    let Ok(t) = std::fs::read_to_string(&p) else {
        return (
            bots,
            seed,
            "contract value (the toml is AC5's, not in this branch)",
        );
    };
    let get = |k: &str| {
        t.lines()
            .find_map(|l| {
                l.trim()
                    .strip_prefix(k)
                    .and_then(|r| r.trim().strip_prefix('='))
            })
            .and_then(|v| v.trim().parse::<u64>().ok())
    };
    (
        get("bots").map_or(bots, |x| x as usize),
        get("bot_seed").unwrap_or(seed),
        "read from the toml",
    )
}

#[test]
fn ai_slot_wallets_never_meet_the_script_bots_for_the_three_stacks() {
    // (toml, script bots, bot_seed, AI citizens n)
    let stacks = [
        ("ai-citizens.toml", 180usize, 31u64, 18u32),
        ("ai-ab.toml", 120, 33, 12),
        ("ai-ab.toml", 120, 34, 12),
        ("ai-ab.toml", 120, 35, 12),
        ("ai-smoke.toml", 30, 41, 6),
    ];
    for (file, bots, seed, n) in stacks {
        let (bots, seed, src) = if file == "ai-ab.toml" {
            (
                bots,
                seed,
                "contract value: the run script writes the rep's copy",
            )
        } else {
            let (b, s, src) = toml_or(file, bots, seed);
            (b, s, src)
        };
        let slots = AiSlots::parse(&slots_json(seed, n)).unwrap();
        assert_eq!(slots.ai_count(), n as usize);
        let ai_wallets: BTreeSet<String> = slots
            .slots
            .iter()
            .map(|s| {
                frontier_agents::keys::wallet(seed, s.index)
                    .pubkey()
                    .to_string()
            })
            .collect();
        assert_eq!(
            ai_wallets.len(),
            n as usize + 1,
            "AI and seat wallets are distinct"
        );
        let script: BTreeSet<String> = roster(bots, seed, &Mix::for_season_days(3))
            .iter()
            .map(|s| {
                frontier_agents::keys::wallet(seed, s.index)
                    .pubkey()
                    .to_string()
            })
            .collect();
        assert_eq!(script.len(), bots);
        assert!(ai_wallets.is_disjoint(&script), "{file} seed {seed}: {src}");
        // Also the other keys of a bot (session, direct) never collide.
        let ai_sessions: BTreeSet<String> = slots
            .slots
            .iter()
            .map(|s| {
                frontier_agents::keys::session(seed, s.index)
                    .pubkey()
                    .to_string()
            })
            .collect();
        let script_sessions: BTreeSet<String> = (0..bots as u32)
            .map(|i| frontier_agents::keys::session(seed, i).pubkey().to_string())
            .collect();
        assert!(ai_sessions.is_disjoint(&script_sessions));
    }
}

#[test]
fn the_slots_file_is_parsed_strictly() {
    let ok = AiSlots::parse(&slots_json(31, 12)).unwrap();
    assert_eq!(ok.first_index, FIRST_INDEX);
    assert_eq!(ok.slots.len(), 13);
    assert!(
        ok.is_ai(1000) && ok.is_ai(1011) && !ok.is_ai(1012),
        "1012 is the seat"
    );
    assert_eq!(ok.seat().unwrap().index, 1012);
    assert!(!ok.is_ai(5), "a script bot is never an AI");
    // Faction = (index − 1000) mod 6; join_bell = index − 1000.
    for s in &ok.slots[..12] {
        assert_eq!(
            (s.faction as u32, s.join_bell),
            ((s.index - 1000) % 6, s.index - 1000)
        );
    }
    let bad = |j: serde_json::Value| AiSlots::parse(&j.to_string()).is_err();
    assert!(bad(
        json!({"v": 2, "seed": 1, "first_index": 1000, "slots": []})
    ));
    assert!(bad(json!({"v": 1, "first_index": 1000, "slots": []})));
    assert!(bad(
        json!({"v": 1, "seed": 1, "first_index": 1000, "slots": [{"index": 999, "faction": 0, "join_bell": 0, "kind": "ai"}]})
    ));
    assert!(bad(
        json!({"v": 1, "seed": 1, "first_index": 1000, "slots": [
        {"index": 1000, "faction": 0, "join_bell": 0, "kind": "ai"},
        {"index": 1000, "faction": 1, "join_bell": 1, "kind": "ai"}]})
    ));
    assert!(bad(
        json!({"v": 1, "seed": 1, "first_index": 1000, "slots": [{"index": 1000, "faction": 6, "join_bell": 0, "kind": "ai"}]})
    ));
    assert!(bad(
        json!({"v": 1, "seed": 1, "first_index": 1000, "slots": [{"index": 1000, "faction": 0, "join_bell": 0, "kind": "human"}]})
    ));
}

#[test]
fn the_roster_plays_ai_slots_skilled_and_the_seat_idle() {
    let slots = AiSlots::parse(&slots_json(31, 6)).unwrap();
    let specs = slots.specs();
    assert_eq!(specs.len(), 7);
    for (s, sp) in slots.slots.iter().zip(&specs) {
        assert_eq!(sp.index, s.index);
        assert_eq!(sp.faction, s.faction);
        assert!(sp.persona.is_none(), "an AI has no adversarial persona");
        assert_eq!(
            sp.arch,
            if s.kind == SlotKind::Ai {
                Arch::Skilled
            } else {
                Arch::Idle
            }
        );
    }
}

#[test]
#[cfg(unix)]
fn the_seat_key_is_written_0600_and_never_under_pub_or_state() {
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!("ai-slots-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("keys")).unwrap();
    for bad in ["pub", "state"] {
        std::fs::create_dir_all(dir.join(bad)).unwrap();
        let f = dir.join(bad).join("seat.txt");
        assert!(aislots::write_seat_key(&f, 31, 1012).is_err(), "{bad}");
        assert!(!f.exists());
    }
    let f = dir.join("keys").join("seat.txt");
    aislots::write_seat_key(&f, 31, 1012).unwrap();
    let mode = std::fs::metadata(&f).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
    let v: serde_json::Value = serde_json::from_slice(&std::fs::read(&f).unwrap()).unwrap();
    assert_eq!(v["index"], 1012);
    assert_eq!(
        v["wallet"].as_str().unwrap(),
        frontier_agents::keys::wallet(31, 1012).pubkey().to_string()
    );
    // The exported keypair is the wallet's.
    let kp = fclient::Keypair::from_base58_string(v["wallet_keypair_b58"].as_str().unwrap());
    assert_eq!(
        kp.pubkey(),
        frontier_agents::keys::wallet(31, 1012).pubkey()
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_cli_options_are_checked() {
    use frontier_bots::ai::AiOpts;
    let o = |brain: Option<&str>, token: bool, slots: bool| AiOpts {
        brain: brain.map(String::from),
        token_file: token.then(|| "t".into()),
        slots: slots.then(|| "s".into()),
        ..AiOpts::default()
    };
    assert!(AiOpts::default().check().is_ok());
    assert!(o(Some("http://127.0.0.1:41980"), true, true)
        .check()
        .is_ok());
    // The mind's port lies in the AI window 41901-41999 (never 41900, 41040, 4190...).
    for bad in [
        "http://127.0.0.1:41900",
        "http://127.0.0.1:41040",
        "http://127.0.0.1:4190",
        "http://127.0.0.1:42000",
        "http://example.com:41980",
        "https://127.0.0.1:41980",
    ] {
        assert!(o(Some(bad), true, true).check().is_err(), "{bad}");
    }
    assert!(
        o(Some("http://127.0.0.1:41980"), false, true)
            .check()
            .is_err(),
        "needs the token file"
    );
    assert!(
        o(Some("http://127.0.0.1:41980"), true, false)
            .check()
            .is_err(),
        "needs the slots"
    );
    assert!(
        o(None, true, false).check().is_err(),
        "a token without a brain"
    );
}
