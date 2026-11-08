//! Literal log parsing only: no keys, address derivation or signing.
use base64::Engine;
use fclient::{
    log::{bodies_from_logs, body_of_line, LogError},
    Address,
};

fn line(tag: &[u8], body: &[u8]) -> String {
    let b64 = base64::engine::general_purpose::STANDARD;
    format!("Program data: {} {}", b64.encode(tag), b64.encode(body))
}

#[test]
fn wide_program_record_is_unsupported_not_empty_legacy_history() {
    let p = Address::new_from_array([23; 32]);
    for (version, kind) in [0x81, 0x82, 0x83]
        .into_iter()
        .flat_map(|version| [1, 12, 13, 14, 255].map(|kind| (version, kind)))
    {
        let wide = line(b"PSW1", &[version, kind]);
        let logs = vec![
            format!("Program {p} invoke [1]"),
            wide.clone(),
            format!("Program {p} success"),
        ];
        assert_eq!(
            bodies_from_logs(&logs, &p),
            Err(LogError::UnsupportedWideRecord)
        );
        assert_eq!(body_of_line(&wide), Err(LogError::UnsupportedWideRecord));
    }
}

#[test]
fn unrelated_frames_cannot_poison_legacy_program_history() {
    let p = Address::new_from_array([23; 32]);
    let other = Address::new_from_array([24; 32]);
    let wide = line(b"PSW1", &[0x81, 1]);
    let logs = vec![
        wide.clone(),
        format!("Program {p} invoke [1]"),
        format!("Program {other} invoke [2]"),
        wide,
        format!("Program {other} success"),
        line(b"PS2", &[1, 2]),
        format!("Program {p} success"),
    ];
    assert_eq!(bodies_from_logs(&logs, &p), Ok(vec![vec![1, 2]]));
}
