# Pitch claims and evidence

Checked 2026-10-10 against the founder's completed v28 deck and spoken script. The script is preserved in [PITCH.md](../../PITCH.md); these notes identify the scope of its supporting evidence.

| Claim | Evidence and scope |
|---|---|
| People and AI agents fight for one map; six nations; town, army and land | Product direction supplied by the founder. The current main build and its implementation status are described in [README.md](../../README.md). The pitch's territory loop is the target experience; conquest is not merged into main yet. |
| Solana, MagicBlock, x402 and USDC | The first version ran on Solana devnet with MagicBlock and x402 using test USDC. Those integrations are being carried over to the local rebuild. See the [first-version guide](../earlier-prototype/README-V5-game.md). |
| Earlier version: 180 turns, 14 participants, 12 operator-run AI members | The [v8 verification record](../earlier-prototype/devnet-season-1790355636798-verification.txt) confirms 180 ticks, 14 member accounts and a 12-member operator AI roster. The agents were rule-based; this is separate from the rebuild's LLM-citizen work. The deck's remaining two people are founder-reported; the verifier confirms accounts and roster, not the number of human operators. |
| Prizes paid | The [first-version guide](../earlier-prototype/README-V5-game.md) records completed claims and a vault balance of 294 to 0 test USDC. The verification record recomputes payout amounts. No real-money payment or revenue is claimed. |
| 20% entry-fee protocol share; 80% prize pool | First-version rules use 2,000 basis points for the operations share. The verification record checks that share; the same split is the founder's business model for Wylls. |
| Agents join with a single web request | The first-version SDK exposes one join call. The x402 handshake uses an initial HTTP request and a paid retry. The README and detailed fields use “join over HTTP using x402.” |
| More than 75 million x402 payments in 30 days | [x402's official site](https://x402.org/) displays 75.41M transactions under its Last 30 Days metric when checked on 2026-10-10. It does not identify the measurement dates or establish that all transactions were AI-agent payments. The script's “this August” is not verified by this source. |
| More than 90% of blockchain games have died | [ChainPlay's State of GameFi 2024](https://chainplay.gg/blog/state-gamefi-2024/) classifies 93% of 3,279 projects as dead, using data collected in November 2024. Its definition is a token-price decline of over 90% from its peak or fewer than 100 daily active users. This is a project-health classification, not a count of closed games. |
| Mobile strategy games earned more than $20 billion last year | [Sensor Tower, February 2026](https://sensortower.com/ja/blog/state-of-mobile-games-advertising-2026-report-japan), reports more than $20 billion in mobile strategy-game in-app purchase revenue for 2025. “Last year” in the October 2026 script means 2025. |
| Shut down an earlier project after its token economy broke; built 10+ onchain games; full-time founder; blockchain company in Japan; Superteam Japan member | Founder-provided background in the completed script and deck. These statements are not run metrics. |
| Next: public devnet season for strategy fans and agent builders | Founder-provided next milestone; not a claim that the season has already happened. |

The x402 August date remains a source gap. The submission's why-now field explains the same payment thesis without adding an unverified month or identifying all x402 transactions as agent activity.

