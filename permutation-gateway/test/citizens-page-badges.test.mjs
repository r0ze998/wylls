// Council page (unit AC7), badges (contract §8.3): the badge comes from the signed roster only. A record's `origin`, an
// `ai_written` or `ai_roster` flag and a `kind` hint in a file never create an AI badge; a self-declared origin-1 human
// record gets its own "AI-assisted (self-declared)" style; script bots are found by wallet or by the tag derived from
// the wallet with faddr.mjs (checked here against the citizens service's own derivation).
import './fixtures/ai-page-lang.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRosterIndex, badgeOf, displayNameOf, badgedSegments, deriveScriptTags, tagKey } from '../../permutation-server/web/frontier/council/badges.mjs';
import { withSeed, seedOf, citizenTag } from '../../permutation-server/web/frontier/faddr.mjs';
import { citizenTagOfTag15 } from '../citizens/watcher/owners.mjs';
import { citizenTag15 } from '../../permutation-server/web/frontier/faddr.mjs';
import { roster, T, W } from './fixtures/ai-page-kit.mjs';

const idx = makeRosterIndex(roster(), { scriptTags: [T.s0] });

test('badge: a roster AI is an AI, by tag or by wallet', () => {
  assert.equal(badgeOf(idx, { tag: T.ai0 }).look, 'ai');
  assert.equal(badgeOf(idx, { wallet: W.ai1 }).look, 'ai');
  assert.equal(badgeOf(idx, { tag: T.ai0 }).labelKey, 'badge.ai');
});

test('badge: the seat, a script bot (wallet or derived tag) and an unlisted citizen', () => {
  assert.equal(badgeOf(idx, { wallet: W.seat }).look, 'seat');
  assert.equal(badgeOf(idx, { wallet: W.s0 }).look, 'script');
  assert.equal(badgeOf(idx, { wallet: W.s1 }).look, 'script');
  assert.equal(badgeOf(idx, { tag: T.s0 }).look, 'script', 'a tag derived from a script wallet');
  assert.equal(badgeOf(idx, { tag: T.stranger }).look, 'none', 'not in the roster: no badge, the page does not guess "human"');
  const scripted = makeRosterIndex(roster({ seat: { ...roster().seat, scripted: true } }));
  assert.equal(badgeOf(scripted, { wallet: W.seat }).look, 'seat-scripted');
});

test('badge: origin never makes an AI badge (self-declared origin 1 from an unlisted wallet is its own style)', () => {
  const b = badgeOf(idx, { wallet: W.human }, { origin: 1 });
  assert.equal(b.look, 'assisted');
  assert.equal(b.labelKey, 'badge.assisted');
  assert.notEqual(b.look, 'ai');
  // a roster AI with an origin that says "human" is still an AI
  assert.equal(badgeOf(idx, { wallet: W.ai0 }, { origin: 0 }).look, 'ai');
  // origin 2 is the scripted seat only: from the seat it adds the note, from anyone else it adds nothing
  assert.equal(badgeOf(idx, { wallet: W.seat }, { origin: 2 }).noteKey, 'badge.note_scripted_seat');
  assert.equal(badgeOf(idx, { wallet: W.human }, { origin: 2 }).look, 'none');
});

test('badge: hostile "flags" in a record are not inputs (the function takes only tag, wallet and origin)', () => {
  const hostile = { tag: T.stranger, wallet: W.human, ai_written: true, ai_roster: true, kind: 'ai', ai: true };
  assert.equal(badgeOf(idx, hostile).look, 'none');
  assert.equal(badgeOf(idx, hostile, { origin: 0 }).look, 'none');
});

test('names: roster name for an AI, derived name for the rest, short tag as the last resort; the seat has no name', () => {
  assert.equal(displayNameOf(idx, { tag: T.ai0 }, 'en'), 'Toa Festead');
  assert.equal(displayNameOf(idx, { tag: T.ai0 }, 'ja'), 'トア・フェステッド');
  assert.equal(displayNameOf(idx, { tag: T.human }, 'en', { resolve: (tag, lang) => `derived-${lang}` }), 'derived-en');
  assert.equal(displayNameOf(idx, { tag: T.human }, 'en', { fallback: { en: 'From file', ja: 'ファイル' } }), 'From file');
  assert.equal(displayNameOf(idx, { tag: T.human }, 'en'), '012345');
  assert.equal(displayNameOf(idx, { wallet: W.seat }, 'en'), null);
});

test('episode lines: a roster badge follows every citizen name the line contains (longest name first, no overlaps)', () => {
  const text = 'At bell 388 Elrin Somere (nation Borealis) attacked your army; Toa Festead lost 120 troops.';
  const segs = badgedSegments(text, [T.ai1, T.ai0, 'nation:1', 'pq:-2,3'], idx, 'en');
  const out = segs.map(s => (s.badge ? `[${s.badge}]` : s.text)).join('');
  assert.equal(out, 'At bell 388 Elrin Somere[ai] (nation Borealis) attacked your army; Toa Festead[ai] lost 120 troops.');
  // a derived name and a script bot
  const withDerived = badgedSegments('Kaito attacked.', [T.s0], idx, 'en', { resolve: (tag, lang, full) => (tag === T.s0 && !full ? 'Kaito' : null) });
  assert.deepEqual(withDerived.map(s => s.badge ?? s.text), ['Kaito', 'script', ' attacked.']);
  // a name nobody listed gets no badge; a nation name is not a citizen
  assert.deepEqual(badgedSegments('Ember cleared the camp.', ['nation:4'], idx, 'en').map(s => s.badge ?? s.text), ['Ember cleared the camp.']);
  // the same in Japanese
  const ja = badgedSegments('鐘388で、エルリン・ソメア（国ボレアリス）があなたの軍を攻撃した。', [T.ai1], idx, 'ja');
  assert.ok(ja.some(s => s.badge === 'ai'));
});

test('script tags: the browser derivation (faddr.mjs) equals the citizens service derivation', () => {
  const programId = '7sFcyZJVFYk1JZwkXUFWqgh92xL4Zdf1JRrwwGfnRG2c';
  const seasonAddress = 'GHAw5eAE28B4JLUyRARvT1HiSxTkmyBPS2AtvQc9zHUC';
  const wallet = W.s0;
  const page = tagKey(citizenTag(withSeed(seasonAddress, seedOf('Citizen', { wallet }), programId)));
  const tag15 = Buffer.from(citizenTag15(wallet)).toString('hex');
  const service = citizenTagOfTag15(tag15, { seasonAddress, programId });
  assert.equal(page, service);
  assert.deepEqual(deriveScriptTags([W.s0, 'not a wallet'], w => tagKey(citizenTag(withSeed(seasonAddress, seedOf('Citizen', { wallet: w }), programId)))), [page]);
});

test('roster index tolerates a missing or malformed roster', () => {
  for (const bad of [null, undefined, 'x', 42, { ai: 'no', script: 7, seat: 'no' }, { ai: [{ tag: 'zz' }, null] }]) {
    const i = makeRosterIndex(bad);
    assert.equal(i.ai.length, 0);
    assert.equal(badgeOf(i, { tag: T.ai0 }).look, 'none');
  }
});
