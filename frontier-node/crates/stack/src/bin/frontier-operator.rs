//! `frontier-operator`: the season setup (AnnounceSeason, CreateSeason,
//! InitBeaconLogs, InitShards) against a devnet RPC, signed by the
//! upgrade authority's key file. See `frontier_stack::operator`.

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = frontier_stack::operator::main_with(&args, &mut |l| println!("{l}"), &mut |l| {
        eprintln!("{l}")
    })
    .await;
    std::process::exit(code);
}
