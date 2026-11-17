// Workstream 07 (player experience), connection patch: the season's times in
// words, read from the season and the chain's clock. The glossary, the first
// card and the title wrote 「10分ごと」 into their sentences, which a local
// world at 10× or 40× contradicts; no screen named the join deadline, and a
// join after it failed with the generic WrongStatus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import * as T from '../../permutation-server/web/frontier/seasonterms.mjs';
import { TERMS } from '../../permutation-server/web/frontier/hud/glossary.mjs';
import { renderNations } from '../../permutation-server/web/frontier/screens/join.mjs';

const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);
const season = { genesisTs: 0, endBell: 2016, joinCloseBell: 1512, layoutVersion: 2, programVersion: 4 };
const FSat = (bell, extra = {}) => ({ season, clock: { genesisTs: 0 }, chain: { now: () => bell * 600 + 30 }, ...extra });

test('no sentence of the page types the turn\'s length any more', () => {
  for (const f of ['hud/glossary.mjs', 'screens/onboarding.mjs', 'intro/title.mjs']) assert.doesNotMatch(readFileSync(new URL(f, WEB), 'utf8'), /L`[^`]*(10分|十分)ごと/, f);
});

test('the turn is said from the clock: 10 game minutes, and on a faster clock the real time too', () => {
  setLang('ja');
  try {
    T.setTermsPace(() => 1);
    assert.match(TERMS.bell.text(), /^10 分ごとの区切りがターンです。/);
    T.setTermsPace(() => 10);
    assert.match(TERMS.bell.text(), /^ゲーム内の 10 分（この世界では実時間で約 60 秒）ごとの区切りがターンです。/);
    T.setTermsPace(() => 40);
    assert.match(TERMS.bell.text(), /約 15 秒/);
    setLang('en');
    assert.match(TERMS.bell.text(), /every 10 minutes of game time \(in this world about 15 seconds of real time\)/);
  } finally { T.setTermsPace(() => 1); setLang('ja'); }
});

test('the deadlines are the season\'s; after the join deadline the join is off and says why', () => {
  setLang('ja');
  assert.equal(T.deadlineLine(FSat(100)), '参加の受付は第1,512ターンまで（あと約 10 日）。このプログラム（旧方式のシーズン）が新しい命令を受け付けるのは第2,016ターンまでです（あと約 13 日）。');
  assert.equal(T.wrongStatusWhy(FSat(100), 'join'), null);
  assert.equal(T.wrongStatusWhy(FSat(1600), 'join'), '参加の受付は第1,512ターンで締め切られました。');
  assert.equal(T.wrongStatusWhy(FSat(1600), 'build'), null, 'other orders are still taken');
  assert.match(T.wrongStatusWhy(FSat(2100), 'build'), /このプログラム（旧方式のシーズン）は第2,016ターンで新しい命令の受付を終えたため/);
  const cards = { factions: Array.from({ length: 6 }, (_, f) => ({ faction: f })) };
  const markup = s => String(renderNations({ ...FSat(s), ...cards, wallet: { address: 'W' }, joinDraft: { faction: 1 }, overviews: new Map(), homeChoice: null, inFlight: 0 }));
  assert.match(markup(100), /参加の受付は第1,512ターンまで/);
  const late = markup(1600);
  assert.match(late, /参加の受付は第1,512ターンで締め切られました/);
  assert.match(late, /data-act="home-confirm"[^>]*disabled/);
  assert.equal(T.deadlineLine({}), '', 'no season: nothing said');
});
