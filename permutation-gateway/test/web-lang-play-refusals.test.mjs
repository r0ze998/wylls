// The play screen's refusals in English (fi18n.mjs errorText: every program error the page can show): the words of the
// play screen (GLOSSARY.md, The Frontier) and what the Japanese says. Lane D round 3 of
// docs/integration/CLAUDE-LANE-D-ENGLISH-AUDIT-20261116.md:
//  - no "settle(d/ment)" (精算 / "settle" is never said on the play screen; 決着 is "resolved", 結果を受け取る "collect");
//  - 村 is "village", never the old "holding" (owner decision W11);
//  - straight apostrophes;
//  - the eight entries fixed in round 3, each as the Japanese says it.
// The resident NFT refusals (Resident*) are left out (restricted lane). Pure: it imports fi18n.mjs and lang.mjs only.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { errorText, ERROR_NAMES } from '../../permutation-server/web/frontier/fi18n.mjs';

afterEach(() => setLang('ja'));

const PLAY = () => ERROR_NAMES.filter(n => !/^Resident/.test(n) && n !== 'Reserved14');
const en = name => { setLang('en'); return errorText(name); };
const ja = name => { setLang('ja'); return errorText(name); };

test('every program refusal has English, and the English is not the Japanese', () => {
  const names = PLAY();
  assert.ok(names.length >= 90, `${names.length} refusals`);
  for (const n of names) {
    const e = en(n);
    assert.equal(typeof e, 'string', n);
    assert.ok(e.length > 0, n);
    assert.doesNotMatch(e, /[぀-ヿ㐀-鿿]/, `${n}: Japanese in the English: ${e}`);
    assert.notEqual(e, ja(n), n);
  }
});

test('the refusals never say "settle" on the play screen, nor "holding" for a village, and use straight apostrophes', () => {
  const bad = [];
  for (const n of PLAY()) {
    const e = en(n), j = ja(n);
    if (/\bsettle[ds]?\b|settlement/i.test(e)) bad.push(`${n}: settle — ${e}`);
    if (/村/.test(j) && /\bholdings?\b/i.test(e)) bad.push(`${n}: holding for 村 — ${e}`);
    if (/[‘’]/.test(e)) bad.push(`${n}: curly apostrophe — ${e}`);
  }
  assert.deepEqual(bad, []);
});

test('round 3: the refusals say what the Japanese says', () => {
  const want = {
    CapturePending: 'The capture is being processed. Act once its result is confirmed.',
    RaidState: 'There is no raid on this caravan waiting to be resolved, or it is already resolved.',
    StakeUnsettled: 'The siege\'s result has not been collected yet.',
    SiegeBusy: 'This host is already taking part in a siege.',
    HoldingsFull: 'You already hold as many villages as you can.',
    NotBesiegeable: 'This village cannot be besieged now.',
    FrontierProtected: 'This village is in its frontier protection period.',
    VaultSite: 'A storehouse cannot be built on this tile (impassable, a village, the keep, a camp or a storehouse already).',
    StructureSite: 'This structure cannot be built on this tile (impassable, a village, the keep, a camp or a structure already).',
  };
  for (const [n, e] of Object.entries(want)) {
    assert.ok(ERROR_NAMES.includes(n), n);
    assert.equal(en(n), e, n);
  }
});

// R3-P1 (the audit doc): 進軍の結果を受け取るまで動かせません says the player must collect the march's result; the
// English "until its march is resolved" reads as waiting. Two existing tests pin the current English
// (web-frontier-errors.test.mjs, web-frontier-relay.test.mjs), so the change is the owner's to take with them.
test.todo('R3-P1 (CLAUDE-LANE-D-ENGLISH-AUDIT-20261116.md): HostInTransit says the march\'s result must be collected', () => {
  assert.equal(en('HostInTransit'), 'This host cannot move until its march\'s result is collected.');
});
