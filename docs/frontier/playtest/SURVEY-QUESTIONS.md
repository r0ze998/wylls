# Wylls friends' test: survey questions (for the external form)

For the form the owner creates (Google Forms or any other tool). **This repository holds only the questions; it receives no answers and no personal data.** Japanese and English are both given; build the form in one language (or two forms) and keep the wording.

## Form settings (important for privacy)

- **No personal fields.** No name, e-mail, phone number, handle or invitation code anywhere, not even as an optional field.
- Turn **off** "collect e-mail addresses" and do **not** require sign-in (a sign-in requirement records an identity). The price is that one person can answer twice; that is acceptable here.
- Turn off "send me a copy of the answers" to respondents' addresses (there are none) and any "limit to 1 response" option that needs sign-in.
- Put one sentence at the top (JA and EN below) saying it is anonymous and voluntary.
- Put the form's https link in `permutation-server/web/frontier/playtest/config.json` (`surveyUrl`) before the first invitation, and in `{SURVEY_LINK}` of the tester guide and invitation message.
- Mark only Q0 and Q1 as required; every other question may be skipped. Say "about 5 minutes" in the invitation, not "2 minutes".

**Intro text.**

- JA: このアンケートは匿名です。名前もメールも聞きません。答えるのは任意で、答えたくない質問は飛ばせます。いただいた答えは、このテストの振り返りと、ゲームを説明するときの人数での報告にだけ使います。
- EN: This survey is anonymous. It asks for no name and no e-mail. Answering is voluntary and you can skip any question. The answers are used only to review this test and to report counts when we describe the game.

## Questions

### Q0 (required). Did you get into the game and see your village?

- JA: ゲームに入って、自分の村を見ることができましたか。
- EN: Did you get into the game and see your village?

Single choice: はい / いいえ (Yes / No). If **No**, the form skips Q1 and Q4 (use "go to section based on answer": a short section for Q3 "what stopped you", Q6, Q7, Q5, then submit). The form is anonymous and public, so respondents can include invited people who never got in, people who got stuck at the start page, and forwarded links; Q0 is the only way to tell them apart from people who played, and Q1 and Q4 are asked only of those who did.

### Q1 (required if Q0 is yes). How would you feel if you could no longer play Wylls?

- JA: もし Wylls が遊べなくなったら、どう感じますか。
- EN: How would you feel if you could no longer play Wylls?

Single choice:

| JA | EN |
|---|---|
| とてもがっかりする | Very disappointed |
| 少しがっかりする | Somewhat disappointed |
| がっかりしない | Not disappointed |
| もう遊んでいない | I no longer play it |

(The standard three-way question with a fourth answer for people who stopped; the report counts "very disappointed" as k of r_in respondents, see [`OPERATOR-RUNBOOK.md`](OPERATOR-RUNBOOK.md) section 8. Ask it only after a "Yes" in Q0, so a person who never got in is not forced to pick "not disappointed".)

### Q2. What did you like?

- JA: 気に入ったところは何ですか。(自由記述)
- EN: What did you like? (free text)

### Q3. What confused you?

- JA: わかりにくかった、つまずいたところは何ですか。メッセージが出たなら、その文面もあれば書いてください。(自由記述)
- EN: What confused you or got in your way? If a message appeared, please include its text. (free text)

### Q4. Would you recommend it?

- JA: Wylls を友だちにすすめたいですか。(0 = まったくすすめない、10 = ぜひすすめる)
- EN: How likely are you to recommend Wylls to a friend? (0 = not at all, 10 = definitely)

Linear scale 0 to 10, with the end labels above. Ask it only after a "Yes" in Q0. Report it as the list of answers or a count per answer, not as a single "score".

### Q5. Anything else?

- JA: そのほか、自由にコメントをどうぞ。(自由記述)
- EN: Any other comment? (free text)

## Optional context questions (no personal data; drop them if you want the shortest form)

These help read the answers. They describe the session, not the person.

### Q6. What did you play on?

- JA: 主に何で遊びましたか。 選択肢: スマホ / パソコン / タブレット
- EN: What did you mainly play on? Phone / Computer / Tablet

### Q7. How far did you get?

- JA: どこまで進みましたか(当てはまるものすべて)。 選択肢: 村ができた / 建設した / 斥候を訓練した / 探索した / 進軍を出した / 衝突の報告を読んだ / 参加できなかった
- EN: How far did you get? (all that apply) My village appeared / I built something / I trained scouts / I explored / I sent a march / I read a clash report / I could not join

### Q8. On how many different days did you open the game?

- JA: ゲームを開いた日は何日ありましたか。 選択肢: 1日 / 2日 / 3日 / 4日以上
- EN: On how many different days did you open the game? 1 / 2 / 3 / 4 or more

(This is a self-report. It cannot be matched to the logs and must never be mixed with `N_returned`.)

## Counting the answers

- `r` = the number of **responses received** by the form; `r_in` = the responses that answered **Yes** to Q0; `k` = those among `r_in` who chose "very disappointed" in Q1. Quote exactly: "`r` anonymous survey responses were received; they cannot be matched to the activity logs or checked for duplicates; `k` of the `r_in` respondents who said they got into the game chose 'very disappointed'." Never write "`r` of the `N_joined` players answered", and never use `r / N_joined` as a response rate: the form is anonymous and open, one person can answer twice, and respondents can include people who never joined.
- The form is anonymous and separate from the activity logs: do not claim that people who returned answered differently, or any link between an answer and a player.
- Free-text answers stay with the owner; quote them without any identifying detail, and ask nobody who wrote what.
