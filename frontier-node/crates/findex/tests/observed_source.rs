//! (2026-11-17) Written, not run. What each source says of itself for the archive's `observed` epochs
//! (archive.rs, "Observed sources"): the program as configured and the commitment as requested; never its URL.
use findex::{Enriched, RpcPoll, Source};

#[test]
fn rpc_poll_says_its_configured_program_and_requested_commitment_never_its_url() {
    let program = fclient::Address::new_from_array([7; 32]);
    let url = "https://user:PASSWORD9@token-in-host-abc.example/secret-path-xyz/?api-key=SECRET123";
    let p = RpcPoll::new(url, program);
    let o = p.observed().expect("rpc_poll describes itself");
    assert_eq!(o.source, "rpc_poll");
    assert_eq!(o.program_configured.as_deref(), Some(program.to_string().as_str()));
    assert_eq!(o.commitment_requested.as_deref(), Some("finalized"));
    let text = format!("{o:?}");
    for bit in ["SECRET123", "secret-path-xyz", "token-in-host-abc", "PASSWORD9", "https://"] {
        assert!(!text.contains(bit), "{bit} in {text}");
    }
    let e = Enriched::new(RpcPoll::new(url, program), url, program);
    let eo = e.observed().expect("forwarded");
    assert_eq!(eo.source, "rpc_poll+enriched");
    assert_eq!(eo.commitment_requested.as_deref(), Some("finalized"));
    assert!(!format!("{eo:?}").contains("SECRET123"));
}

#[test]
fn the_ingesters_note_the_source_just_before_each_append() {
    let lib = include_str!("../src/lib.rs");
    let at = lib.find("self.archive.observe_source(src.observed().as_ref());").expect("lib.rs notes the source");
    assert!(lib[at..].find("self.archive.append_feed(&got, src.cursor())").is_some());
    let wide = include_str!("../src/wide_store.rs");
    let at = wide.find("self.archive.observe_source(src.observed().as_ref());").expect("wide_store.rs notes the source");
    assert!(wide[at..].find("self.archive.append(&got, src.cursor())").is_some());
    let ingest = include_str!("../src/ingest.rs");
    let body = &ingest[ingest.find("source: \"rpc_poll\".into(),").unwrap()..][..200];
    assert!(!body.contains("url") && !body.contains("rpc."), "no endpoint in the observation");
}
