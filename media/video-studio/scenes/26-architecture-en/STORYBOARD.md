# 26 architecture-en — How Wylls is built (63 s, 16:9, 30 fps, tech)

One canvas diagram with a moving camera. Gold lines = the kernel compiled in; cyan / gold / parchment particles = runtime data.

| t (s) | Beat |
|---|---|
| 0–5 | Title "HOW WYLLS IS BUILT". |
| 5.5–14 | Close on the rules kernel (Rust, no_std, deterministic); real module names orbit (clash.rs, siege.rs, ...). |
| 15–24 | Pull back: program, simulator, verifier, script bots, web client (WASM) wire to the kernel. |
| 25–32 | Local test chain band (LiteSVM): Solana program = only judge; prize program = test USDC only. Badge: local test chain. |
| 33–42 | drand → keeper → program; tx log → herald (read-only feed). |
| 42.8–52.7 | Relay (can refuse, never change an outcome); web client, bots, AI citizens (mind keyless / brain signs) + local Gemma 4. |
| 53–58.4 | Full view; tx log → replay verifier, check mark; "our own tool, not an independent audit". |
| 58.6–63 | End card. |
