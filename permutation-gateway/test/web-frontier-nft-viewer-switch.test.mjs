// ⑳ Playing an NFT (or its new owner after a transfer) resets the viewer before the NFT Citizen's record answers.
// The drawer must not open the nation choice in between: for a Citizen that has a village it would be a false
// "not joined" (seen on the game screen after a transfer: B saw "Choose a nation" beside its village).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawerOf, viewerState } from '../../permutation-server/web/frontier/hud/drawer.mjs';
import { landState } from '../../permutation-server/web/frontier/fland.mjs';

const base = { mode: 'play', playReady: true, titleUp: false, tab: 'map', wallet: { address: 'Wa11et1111111111111111111111111111111111111' } };
const resident = { asset: 'NFTasset11111111111111111111111111111111111', generation: 1 };

test('switching to an NFT: until its Citizen answers the viewer is pending and no nation choice opens', () => {
  const switching = { ...base, resident, meStatus: 'loading', meAnswered: false, land: landState(null), citizen: null, holdings: [] };
  assert.equal(viewerState(switching), 'pending');
  assert.equal(drawerOf(switching), null);
});

test('once the NFT Citizen answers: a village closes the join flow; no Citizen yet opens the nation choice', () => {
  const answered = { ...base, resident, meStatus: 'ready', meAnswered: true, citizen: {}, holdings: [{}], land: { stage: 'final' } };
  assert.equal(viewerState(answered), 'known');
  assert.equal(drawerOf(answered), null);
  const notJoined = { ...base, resident, meStatus: 'ready', meAnswered: true, citizen: null, holdings: [], land: landState(null) };
  assert.deepEqual(drawerOf(notJoined), { kind: 'nation' });
});

test('a wallet player (no NFT) keeps the earlier rule: a reset viewer with an empty land is known', () => {
  const wallet = { ...base, meStatus: 'loading', meAnswered: false, land: landState(null), citizen: null, holdings: [] };
  assert.equal(viewerState(wallet), 'known');
  assert.deepEqual(drawerOf(wallet), { kind: 'nation' });
});

test('every refusal the old holder can meet has a message in Japanese and English (the page check, the relay gate, the program)', async () => {
  const { failureText } = await import('../../permutation-server/web/frontier/fi18n.mjs');
  const text = code => String(failureText({ code }));
  const { setLang } = await import('../../permutation-server/web/lang.mjs');
  const { RESIDENT_GATE_CODES } = await import('../src/frontier/resident-chain-gate.mjs');
  const codes = ['NftNotHeld', ...Object.values(RESIDENT_GATE_CODES), 'ResidentStaleGeneration', 'ResidentNotCurrentAuthority'];
  const BANNED_EN = /\bbell \d|\bsecret|beacon|\bsettle[ds]?\b|settlement|\bseed\b|site ticket|keeper|lamport/i;
  const CJK = /[぀-ヿ一-鿿]/;
  try {
    for (const code of codes) {
      setLang('ja');
      const ja = text(code);
      assert.doesNotMatch(ja, /不明なエラー/, `${code} has a message`);
      assert.match(ja, CJK, `${code} (ja)`);
      setLang('en');
      const en = text(code);
      assert.doesNotMatch(en, CJK, `${code} has English: ${en}`);
      assert.doesNotMatch(en, BANNED_EN, code);
    }
    setLang('en');
    assert.equal(text('NftNotHeld'), 'This resident NFT is not in this wallet now.');
  } finally { setLang('ja'); }
});
