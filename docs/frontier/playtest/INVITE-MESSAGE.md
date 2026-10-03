# Wylls friends' test: invitation message (English)

A short message to send with each friend's own link. Fill the placeholders by hand: `{LINK}` is the friend's own line from the invitation CSV (`playtest-invite.sh` writes `invite_code,url`; send the `url`), `{CONTACT}` is how they reach you, `{SURVEY_LINK}` is your survey form. Send the tester guide ([`TESTER-GUIDE.md`](TESTER-GUIDE.md)) too, or paste its link. **One link per person; never send one link to a group.** **Before you send a code, ask the friend what phone or computer they will use: an iPhone needs iOS 17 or newer (the game cannot run on older ones, whatever browser is used), so do not waste a code on one.** Do not send the first links before about 10 minutes after the season opened (see [`OPERATOR-RUNBOOK.md`](OPERATOR-RUNBOOK.md) section 3).

## Invitation

> Hi {NAME},
>
> I am running a small private test of a game I am building, called Wylls: a civilization strategy game that runs in real time. I would be glad if you tried it. It is unfinished, so things may break.
>
> Your personal link (it works for one person, once; please do not forward it):
> {LINK}
>
> What to know:
> - It is a test world: no money, no crypto wallet, no prizes. You just open the link and press Start.
> - Open it in Chrome, Edge, Firefox or Safari (on iPhone: iOS 17 or newer), and not in a private window. If you tap the link inside LINE, the page will ask you to press "Copy link" and open it in Safari or Chrome: please do, because the key cannot be saved reliably inside LINE.
> - **Please save your guest key** (the box above the Start button). It is your village. If you lose it, you lose the village.
> - It runs in real time, from about the night of 6 October to the night of 9 October (Japan time). Your village appears 11 to 21 minutes after you join, and your first village may stay "provisional" for up to about 4 hours: until it is confirmed you can build and train but not march. So play a little, leave, and come back later or tomorrow.
> - Each village has about 40 game actions per game day; the start page shows when the allowance resets.
> - Some of the other players are simple computer-controlled bots. There are no AI characters in this test.
> - I keep only what you do in the game under a random player number (no name, no e-mail). Taking part is voluntary and you can stop any time. Details are in the guide.
> - The host is my own computer, so it may be unreachable now and then. If the link does not open, wait a few minutes and try again.
>
> If something is broken or confusing, tell me: {CONTACT}. After you have played, a short anonymous survey (about 5 minutes; most questions are optional): {SURVEY_LINK}
>
> Thank you!

(`{NAME}` is yours to fill; nothing in the game asks for it.)

## Reminder after a day (optional)

**If you send a reminder, write the time and the wording in your operator notes: returns right after a reminder are prompted, not organic, and the pitch must say so ([`OPERATOR-RUNBOOK.md`](OPERATOR-RUNBOOK.md) section 8). Open the start page again any time to save your key.**

> Your Wylls village is still there. A few minutes today is plenty: look at your village and your marches. The same link and the same browser as before. If the page asks for your key, paste the saved one into "I already have a key".

## The address changed (send to everyone who has joined)

> Wylls: the game's web address changed (the test host restarted its connection). Please open the new address in the **same browser** you used before: {NEW_LINK}
> It will say it needs an invitation: that is expected, and the "I already have a key" box below it is open. Paste your saved guest key there and press "Use this key"; the page will welcome you back. Then press Continue; the game will ask you ONCE to rebuild the in-game key: press that button. Your village is untouched. If the page shows a Cloudflare error instead, I am restarting; wait for my next message. If you did not save your key, message me: {CONTACT}.
