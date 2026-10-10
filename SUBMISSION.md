# Wylls: Crypto World's Fair submission draft

Updated 2026-10-10 to match the completed [v28 deck](docs/pitch/Wylls-Pitch-v28.pdf) and [spoken script](PITCH.md). This is a preparation draft; the project has not been finally submitted.

An account read on 2026-10-10 still showed the earlier Brief description and empty detail fields. The revised values below are prepared here and have not been saved to the submission portal.

**Project:** Wylls · **Category:** Gaming · **Chain:** Solana · **Audience:** strategy fans and agent builders

**Repository:** https://github.com/r0ze998/wylls  
**Website:** https://wylls-site.vercel.app/  
**Deadline shown by the submission portal:** October 12, 2026, 11:59 PM PDT (October 13, 2026, 3:59 PM JST).

## Project fields

The field values are also in [submission-fields.json](submission-fields.json). All displayed character limits were checked in the actual project editor.

### Brief description

254 / 500 characters

Wylls is a strategy game on Solana where people and AI agents fight for one map and a USDC prize pool. Pick one of six nations, grow your town, and march your army to take land. An earlier devnet version completed a full season and paid test USDC prizes.

### What are you building, and who is it for?

753 / 1000 characters

Wylls is a strategy game for strategy fans and agent builders. Our central experiment asks what happens when humans and autonomous AI agents run a nation together.

We are designing agents as players with their own goals, relationships and decisions, using the same game rules as people. A nation's strategy should emerge from members cooperating, persuading each other and deciding whom to trust.

For strategy players, the USDC entry fee and prize pool are intended to give decisions economic weight and make cooperation serious. Resource allocation, leadership and collective action shape the nation's performance. For agent builders, Wylls is a shared world in which to test how their agents plan, compete and cooperate with humans and other agents.

### Why did you decide to build this, and why build it now?

591 / 1000 characters

I shut down an earlier project when its token economy broke. That experience shaped Wylls: build a game around strategy, USDC entry fees and prizes, with no token of our own. Agents can now pay in stablecoins over HTTP through x402, which makes it possible for them to enter the same economy as human players. I want to give those agents a place to play, and test what happens when economic stakes meet human-AI cooperation. A blockchain can enforce common game rules and make season outcomes and payments verifiable. I have built more than ten onchain games and am building Wylls full-time.

### What technologies are you using or integrating with to build your product?

458 characters; no counter displayed in the editor

Rust Solana programs and SPL tokens; MagicBlock Ephemeral Rollups; USDC payments over x402; a Rust replay verifier; a JavaScript web client with WebAssembly rule verification; and a JavaScript agent SDK. MagicBlock, x402 and test-USDC payments ran in the earlier devnet version and are being carried over to the local rebuild. AI-citizen development uses Gemma 4 through llama.cpp, with model choices checked against legal actions. Codex assists development.

### How does your product use these chains?

336 / 500 characters

Solana programs enforce game actions and record season outcomes for replay. The earlier devnet version used a MagicBlock Ephemeral Rollup to resolve 180 turns, accepted test-USDC entry payments through x402, and settled prizes on Solana. The rebuild currently runs on a local Solana test chain while these integrations are carried over.

### Please share any important context about your repo

430 / 500 characters

Main contains the local rebuild and historical devnet records. The earlier playable code is on codex/magicblock-playable; it tested MagicBlock, x402, test USDC and 180-turn seasons. Those integrations are being carried over; AI citizens and conquest are in progress on separate branches. Start with README.md for implementation status and docs/RUNNING.md for setup. These are project-run technical tests, not public user traction.

### Is there anything else judges should know?

414 / 500 characters

Our business model keeps 20% of each entry fee and puts 80% into the prize pool, with no Wylls token. An earlier devnet season completed 180 turns with 14 participant accounts, including 12 operator-run rule-based AI agents, and paid test USDC prizes. All participants were project members or project-run agents. LLM-based AI citizens are separate work in the rebuild. Our next milestone is a public devnet season.

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
- Member submission profile: the portal previously reported 0 of 1 complete; the exact missing fields have not been inspected yet.
- Final submission: review the completed materials and the portal's final confirmation after the videos and founder profile are ready.

The project website is a landing-page link; a public playable rebuild is the next milestone, so a separate live-product URL is not supplied here.

## Supporting records

- [Colosseum's official judging criteria](https://colosseum.com/hackathon#h-faq-12), checked alongside the account draft through Copilot on 2026-10-10
- [First-version devnet verification](docs/earlier-prototype/devnet-season-1790355636798-verification.txt)
- [First-version setup and payout record](docs/earlier-prototype/README-V5-game.md)
- [Rebuild M1 verification](docs/frontier/m1/runs/m1-exit/verify.md)
- [Rebuild tamper checks](docs/frontier/m1/runs/m1-exit/tamper.md)
- [Pitch claims and sources](docs/pitch/CLAIMS.md)
- [Implementation status and running instructions](README.md)
- [Historical development submission record](SUBMISSION-2026-10-04.md)
