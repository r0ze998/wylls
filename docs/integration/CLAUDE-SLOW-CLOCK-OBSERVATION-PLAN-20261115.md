# Observing short UI states on the real screen: a slow test clock plan (2026-11-15, proposal)

## The problem
Some fixes concern states that last only part of one turn. Example (round 24): the forts card's row must stay put when a
host whose muster turn has come **stands while its province is still catching up**. At ×30 a turn is 20 s; the operator's
look-and-press delay was 12–17 s, so in the live check the host had already stood before the card was open, and the exact
transition was not seen live (it is shown on the screens fixture: the old code moves the row 387 → 345 and fails).

## What is allowed and what is not
- Allowed: watching the screen more often or for longer, and a slower synthetic clock, as long as **no press is timed by
  watching hidden state** and every press still follows a look at the screen. Observation that never presses (screenshots,
  reading the page's own text and layout) does not decide when anything is sent.
- Not allowed: changing rules, resources, signing, sends, the guards, or adding a test path that signs or sends anything
  new; presses aimed at coordinates measured the instant before; counting a guessed fixed-position press as evidence.

## Plan A — the existing slow scale (no code change)
- The launcher already accepts `--demo-scale 10` (allowed 10–60; the runner refuses anything else). At ×10 a turn is 60 s:
  the forming-then-catching-up window is about three times longer than at ×30, longer than the look-and-press delay.
- Same export of the published commit, same runner and herald pins, no build; loopback ports, memory-only test keys,
  TTL 30–45 min, the same 110 MiB / free < 21 GiB guards, one world, slot agreed with the other sessions.
- Steps: Train → Form a host (one press) → confirm (one press) → host chip → March on a keep **at once** → screenshots
  while the host is still forming, then at each look until it stands and the province catches up; note the row's top and
  the card's top in each.
- Expected cost: the 72-turn capture would take 72 min at ×10, so this world checks the forts card only (no capture).

## Plan B — observation without pressing (desk addition, test-only)
- A read-only "watch" in the recording desk: every 500 ms, record the row's and the card's top (getBoundingClientRect) and
  the wait line's text into the desk log, for a fixed time after a press, with no input of any kind. It decides nothing
  and sends nothing; it only records what a person would see.
- It would show the exact frame the line changes and whether the row moved, even at ×30.
- Needs a small desk change (scratch, not product code) and its own review of "read-only" (no clicks, no keys).

## Plan C — the fixture (already in place)
- screens/conquest-press.screen.mjs reproduces each state deterministically in the real page (round 24: the short forming
  line, then stood while catching up), with person-like presses and a negative run on the previous code. This remains the
  proof of the fix; Plans A/B only add a live sighting.

## Recommendation
Plan A first (no code, no build, only a slot); add Plan B only if Plan A still misses the window. Label every result
TEST-ONLY, synthetic clock ×10 (or ×30), one operator playing both sides by hand; never as natural time.
