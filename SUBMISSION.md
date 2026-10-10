# Wylls: Crypto World's Fair submission draft

Updated 2026-10-10 to match the completed [v28 deck](docs/pitch/Wylls-Pitch-v28.pdf) and [spoken script](PITCH.md). This is a preparation draft; the project has not been finally submitted.

The field text below is prepared in this repository. Saving these updated values to the submission portal has not been verified.

**Project:** Wylls · **Category:** Gaming · **Chain:** Solana · **Audience:** strategy fans and agent builders

**Repository:** https://github.com/r0ze998/wylls  
**Website:** https://wylls-site.vercel.app/  
**Deadline shown by the submission portal:** October 12, 2026, 11:59 PM PDT (October 13, 2026, 3:59 PM JST).

## Project fields

The field values are also in [submission-fields.json](submission-fields.json). All displayed character limits were checked in the actual project editor.

### Brief description

477 / 500 characters

Wylls is a strategy game on Solana where people and AI agents fight for one map and a USDC prize pool. Pick one of six nations, grow a town, and march an army to take land. Agents are designed to play by the same rules and join over HTTP using x402. We are building with MagicBlock and USDC, without a custom token. An earlier devnet version completed 180 turns with 14 participants, including 12 operator-run AI agents, and paid test USDC prizes. Next: a public devnet season.

### What are you building, and who is it for?

780 / 1000 characters

Wylls is a strategy game for strategy fans and agent builders, where people and AI agents fight for one map and a USDC prize pool. Players pick one of six nations, grow a town, and march an army to take land. Our central experiment is what happens when humans and autonomous agents run a nation together. Agents are designed to play by the same rules, with HTTP entry through x402. We are building on Solana with MagicBlock and USDC, without a token of our own. Our business model keeps 20% of entry fees and puts 80% into the prize pool, so decisions carry weight and cooperation matters. An earlier devnet version completed a full 180-turn season with 14 participants, including 12 operator-run AI agents, and paid test USDC prizes. Our next milestone is a public devnet season.

### Why did you decide to build this, and why build it now?

696 / 1000 characters

AI agents are becoming participants in the economy, and x402 lets them pay in stablecoins over HTTP. We believe agents that can pay need a place to play, alongside people. A blockchain game can give both the same program-enforced rules and a shared payment system. I previously shut down a project after its token economy broke. That experience shaped Wylls: use USDC for entry fees and prizes, build around strategy and competition, and have no token of our own. I have built more than ten onchain games and am building Wylls full-time. Solana, MagicBlock and x402 give us the building blocks; the next step is a public devnet season to test the experience with strategy fans and agent builders.

### What technologies are you using or integrating with to build your product?

470 characters; no counter displayed in the editor

Solana programs and SPL tokens; MagicBlock Ephemeral Rollups; USDC payments over x402; deterministic Rust game rules, a replay verifier, and a JavaScript/WebAssembly web client and agent SDK. The payment and rollup integrations ran in the earlier devnet version and are being carried over to the current local rebuild. AI-citizen development uses Gemma 4 through llama.cpp, with model choices checked against legal game actions. AI coding assistants support development.

### How does your product use these chains?

341 / 500 characters

Solana programs enforce game rules and record season outcomes. In the earlier devnet version, a MagicBlock Ephemeral Rollup resolved 180 turns; entry fees were paid through x402 in test USDC, and prizes settled on Solana. The current rebuild runs on a local test chain while these integrations are carried over. No other chain is integrated.

### Please share any important context about your repo

492 / 500 characters

The repo contains an earlier devnet version and a local rebuild. The earlier version (branch codex/magicblock-playable) tested MagicBlock, x402, test USDC and 180-turn seasons. Main holds the rebuild and historical run records; x402/MagicBlock/USDC carry-over and AI/conquest work are not yet fully integrated. See README.md for status, PITCH.md for the completed script, and SUBMISSION.md for matching field text. Only test USDC was used; these are technical tests, not public user traction.

### Is there anything else judges should know?

404 / 500 characters

All prize payments so far were test USDC on devnet. The earlier season's AI members were operator-run rule-based agents; LLM-based AI citizens are separate work in the rebuild. The first-version verifier passed 14 of 14 checks, and the rebuild's local verifier replayed 144,300 transactions and caught 30 deliberate tampers. These are technical test results. A public devnet season is our next milestone.

## Shared facts across the materials

| Item | Consistent description |
|---|---|
| Product | People and AI agents compete for one map and a USDC prize pool. Six nations; grow a town; march an army; compete for land. |
| Intended users | Strategy fans and agent builders. |
| Stack | Solana, MagicBlock, USDC and x402. These ran in the first devnet version and are being carried over to the local rebuild. |
| Token | No Wylls token. |
| Business model | 20% of entry fees to operations; 80% to the prize pool. |
| Earlier result | 180 turns, 14 participant accounts including 12 operator-run AI members, and test-USDC prizes paid. These agents were rule-based. |
| Rebuild evidence | A separate local test season with 1,000 script bots; verifier replayed 144,300 transactions and detected 30 deliberate tampers. |
| Next milestone | A public devnet season for strategy fans and agent builders. |

The deck says two people participated in the earlier season. This is founder-provided participant information; the verifier establishes member-account and operator-roster counts. These runs do not establish public user traction or real-money revenue.

## Materials still needed for final submission

- Pitch video: not recorded yet. The completed script and v28 deck are ready for recording; the portal accepts YouTube, Loom or Vimeo, up to two minutes.
- Demo video: recorded candidates exist, but the founder has not chosen the final content. The portal requires a live-product demonstration, up to three minutes, on YouTube, Loom or Vimeo.
- Founder submission profile: the portal currently reports 0 of 1 complete; its remaining answers must be supplied by the founder.
- Final submission: review the completed materials and the portal's final confirmation after the videos and founder profile are ready.

The project website is a landing-page link; a public playable rebuild is the next milestone, so a separate live-product URL is not supplied here.

## Supporting records

- [First-version devnet verification](docs/earlier-prototype/devnet-season-1790355636798-verification.txt)
- [First-version setup and payout record](docs/earlier-prototype/README-V5-game.md)
- [Rebuild M1 verification](docs/frontier/m1/runs/m1-exit/verify.md)
- [Rebuild tamper checks](docs/frontier/m1/runs/m1-exit/tamper.md)
- [Pitch claims and sources](docs/pitch/CLAIMS.md)
- [Implementation status and running instructions](README.md)
- [Historical development submission record](SUBMISSION-2026-10-04.md)
