//! Local wide-economy demo, phase 1: a single-threaded stdio process around a
//! private in-memory sandbox that runs the program's real
//! `permutation_frontier::dispatch` for the wide Harvest, Build and Train.
//!
//! ```text
//! cargo +1.89.0 run --offline --locked -p permutation-frontier \
//!     --example local_economy_demo --features local-economy-demo
//! ```
//!
//! One ASCII command per stdin line, one compact JSON response per stdout
//! line (protocol `wylls-local-economy-v1`, see `protocol.rs` and
//! `docs/frontier/map-growth/WIDE-ECONOMY-LOCAL-DEMO-PROTOCOL-20261108.md`).
//! stdin and stdout are the only I/O: no file, no network, no environment
//! variable, no wall clock, no key, no signature, no RPC. Authentication is
//! **MOCK AUTH NO SIGNATURE**: the signer flags are simulated. Host-only; the
//! `local-economy-demo` feature refuses the Solana target at compile time.
//! End of input exits cleanly; a last line without its newline is dropped.

mod engine;
mod protocol;

use std::io::{self, Write};
use std::process::ExitCode;

use protocol::{read_line, Controller, Line, MAX_LINE};

fn main() -> ExitCode {
    let mut controller = match Controller::new() {
        Ok(c) => c,
        Err(code) => {
            eprintln!("local_economy_demo: the recorded fixtures were refused at start: {code}");
            return ExitCode::from(2);
        }
    };
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let stdout = io::stdout();
    let mut output = stdout.lock();
    let mut line = [0u8; MAX_LINE];
    loop {
        let response = match read_line(&mut input, &mut line) {
            Ok(Line::Eof) => return ExitCode::SUCCESS,
            Ok(Line::Complete(n)) => controller.handle(&line[..n]),
            Ok(Line::TooLong) => controller.refuse_line("LINE_TOO_LONG"),
            Err(e) => {
                eprintln!("local_economy_demo: stdin: {e}");
                return ExitCode::from(1);
            }
        };
        // A closed stdout ends the session quietly.
        if writeln!(output, "{response}")
            .and_then(|()| output.flush())
            .is_err()
        {
            return ExitCode::SUCCESS;
        }
    }
}
