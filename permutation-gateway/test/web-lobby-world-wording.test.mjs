// Owner Q-WW-2 (2026-11-24 23:56): the old lobby pages (permutation-server/web/,
// outside frontier/) say "world"/世界 to players, never "season"/シーズン/季節.
// Code identifiers (seasonId, /season, data-claim-season, SeasonFull, …), comments,
// hash inputs and protocol field names stay. One exception is frozen on purpose:
// permutation-server/web/session.mjs (v9, scripts/check-v9-frozen.sh) keeps its
// SessionMismatch text, so its English entry keeps that Japanese key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLang, L } from '../../permutation-server/web/lang.mjs';
import { errorText } from '../../permutation-server/web/i18n.mjs';

const WEB = new URL('../../permutation-server/web/', import.meta.url);
const read = f => readFileSync(new URL(f, WEB), 'utf8');
const codeLines = src => src.split('\n').map((t, i) => [i + 1, t]).filter(([, t]) => !/^\s*(\/\/|\*|\/\*\*)/.test(t));

const PAGES = ['api.mjs', 'app.mjs', 'chain.mjs', 'chainio.mjs', 'chainplay.mjs', 'claim.mjs', 'connect.mjs', 'i18n.mjs',
  'lobby.mjs', 'next.mjs', 'spectate.mjs', 'util.mjs', 'index.html', 'spectate.html',
  'drawers/chronicle.mjs', 'drawers/era.mjs', 'drawers/market.mjs', 'drawers/talk.mjs'];
const TABLES = ['lang/en-core.mjs', 'lang/en-lobby.mjs', 'lang/en-drawers.mjs', 'lang/en-pages.mjs', 'lang/en-play.mjs'];
const FROZEN_JA = 'この鍵は、このシーズンのどのメンバーの鍵とも一致しません';

test('Q-WW-2: no シーズン / 季節 in the old lobby pages\' Japanese text (session.mjs frozen)', () => {
  const hits = [];
  for (const f of PAGES) for (const [n, t] of codeLines(read(f))) if (/シーズン|季節/.test(t)) hits.push(`${f}:${n}: ${t.trim().slice(0, 120)}`);
  assert.deepEqual(hits, []);
  assert.ok(read('session.mjs').includes(FROZEN_JA), 'the frozen v9 text is still there (check-v9-frozen)');
});

test('Q-WW-2: no "season" in the English of the lobby tables or the error sentences', () => {
  const hits = [];
  for (const f of TABLES) {
    for (const [n, t] of codeLines(read(f))) {
      const english = t.includes(FROZEN_JA) ? t.replace(FROZEN_JA, '') : t;
      if (/season/i.test(english) || (/シーズン|季節/.test(english))) hits.push(`${f}:${n}: ${t.trim().slice(0, 120)}`);
    }
  }
  assert.deepEqual(hits, []);
  // i18n.mjs English error sentences: the codes keep their names (SeasonFull, …), the sentences do not say season.
  setLang('en');
  try {
    for (const code of ['KindHidden', 'SeasonFull', 'WrongStatus', 'AlreadyMember', 'X402Mismatch', 'PinMismatch', 'NotFinalized',
      'SeasonNotOver', 'NoSuchMember', 'UnknownSeason', 'RelayMismatch', 'WorldUnavailable', 'NotAMember']) {
      const s = String(errorText({ code }));
      assert.match(s, /world/i, `${code}: ${s}`);
      assert.doesNotMatch(s, /season/i, `${code}: ${s}`);
    }
    assert.equal(L`この鍵は、このシーズンのどのメンバーの鍵とも一致しません`, "This key doesn't match any member's key in this world");
    assert.equal(L`世界の終了`, 'World ended');
    assert.equal(L`世界`, 'World');
  } finally { setLang('ja'); }
  for (const code of ['SeasonFull', 'SeasonNotOver', 'UnknownSeason', 'AlreadyMember']) {
    const s = String(errorText({ code }));
    assert.match(s, /世界/, `${code}: ${s}`);
    assert.doesNotMatch(s, /シーズン/, `${code}: ${s}`);
  }
});
