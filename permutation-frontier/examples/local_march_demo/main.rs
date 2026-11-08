//! Keyless local march host. Fixed public fixtures, real in-memory handlers.
//! This process only reads bounded stdin and writes bounded JSON stdout.
mod destination_stage;
mod engine;
mod land_bootstrap;
mod order_material;
mod protocol;
mod runtime;
use std::io::{self, BufRead, Write};
fn main() {
    std::panic::set_hook(Box::new(|_| {
        eprintln!("local_march_demo: isolated execution fault")
    }));
    let mut c = match protocol::Controller::new() {
        Ok(v) => v,
        Err(_) => {
            eprintln!("local_march_demo: initial fixture invalid");
            std::process::exit(1)
        }
    };
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let stdout = io::stdout();
    let mut out = stdout.lock();
    loop {
        let mut line = Vec::new();
        let mut over = false;
        let mut eof = false;
        loop {
            let buf = match input.fill_buf() {
                Ok(v) => v,
                Err(_) => return,
            };
            if buf.is_empty() {
                eof = true;
                break;
            }
            let end = buf.iter().position(|x| *x == b'\n');
            let n = end.map_or(buf.len(), |n| n + 1);
            if !over {
                if line.len() + n > 129 {
                    over = true;
                    line.clear()
                } else {
                    line.extend_from_slice(&buf[..n]);
                }
            }
            input.consume(n);
            if end.is_some() {
                break;
            }
        }
        if eof {
            return;
        }
        let response = if over {
            c.reject("BAD_COMMAND")
        } else {
            line.pop();
            match std::str::from_utf8(&line) {
                Ok(s) => c.exchange(s),
                Err(_) => c.reject("BAD_COMMAND"),
            }
        };
        let response = match response {
            Ok(s) if s.len() <= 1_048_576 => s,
            _ => return,
        };
        if writeln!(out, "{response}")
            .and_then(|_| out.flush())
            .is_err()
        {
            return;
        }
    }
}
