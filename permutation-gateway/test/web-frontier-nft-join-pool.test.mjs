// ⑰ (candidate): the join screen's resident NFT card in a season with a prize
// pool. NFT entry fees are refused until the refund right is decided
// (permutation-prize ResidentDepositsDisabled), so an NFT that has not joined
// gets a disabled button and a note; a joined NFT still plays; a pass whose
// earlier entry the relay reported may still join; a season WITHOUT a pool is
// exactly as before (the button is enabled once a nation is picked). The
// English default and the mint link are untouched (web-frontier-nft-mint-link).
//
// PURE: the real renderNfts over literal stores. No key, no signature, no
// address derivation, no relay, no chain.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { renderNfts } from '../../permutation-server/web/frontier/screens/join.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

afterEach(() => setLang('ja'));

const WALLET = 'Wa11et1111111111111111111111111111111111111';
const NEW = 'NFTasset11111111111111111111111111111111111';
const JOINED = 'NFTasset22222222222222222222222222222222222';
const JA = /[぀-ヿ㐀-鿿]/;
const BANNED_EN = /\bbell \d|\bsecret|beacon|\bsettle[ds]?\b|settlement|\bseed\b|site ticket|keeper|lamport/i;
const text = h => String(h).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const nfts = (residents = [{ asset: NEW, generation: 0, joined: false }, { asset: JOINED, generation: 3, joined: true }]) =>
  ({ residents, policy: { residentProgram: '11111111111111111111111111111111' }, mint: null });
const store = (extra = {}) => ({ wallet: { address: WALLET }, resident: null, nftsRead: { ok: true, code: null }, nfts: nfts(), joinDraft: { faction: 2 }, prize: null, ...extra });
const pool = (extra = {}) => ({ decimals: 6, fee: '25000000', opsBps: 2000, prizeBps: 8000, entries: 0, collected: '0', prize: '0', ops: '0', state: 'open', ...extra });
/** The button of `asset`: { present, disabled, label }. */
function button(html, asset) {
  const m = String(html).match(new RegExp(`<button[^>]*data-asset="${asset}"[^>]*>([^<]*)</button>`));
  return m ? { present: true, disabled: /\sdisabled(\s|>|=)/.test(m[0]) || /\sdisabled$/.test(m[0].split('>')[0]), label: m[1] } : { present: false };
}

test('no prize pool: the NFT card is as before — a new NFT joins once a nation is picked, a joined one plays, no note', () => {
  const h = renderNfts(store());
  assert.deepEqual([button(h, NEW).present, button(h, NEW).disabled], [true, false], 'enabled outside prize-pool seasons');
  assert.deepEqual([button(h, JOINED).present, button(h, JOINED).disabled], [true, false]);
  assert.doesNotMatch(String(h), /data-pass-deposit/);
  // Without a nation picked the new NFT waits for one (unchanged rule), never because of a pool.
  const noPick = renderNfts(store({ joinDraft: null }));
  assert.equal(button(noPick, NEW).disabled, true);
  assert.doesNotMatch(String(noPick), /data-pass-deposit/);
});

test('a prize pool: a new NFT\'s join is disabled with the note; a joined NFT still plays', () => {
  const h = renderNfts(store({ prize: pool() }));
  assert.deepEqual([button(h, NEW).present, button(h, NEW).disabled], [true, true], 'disabled in a prize-pool season');
  assert.deepEqual([button(h, JOINED).present, button(h, JOINED).disabled], [true, false], 'a joined NFT plays as before');
  assert.match(String(h), /data-pass-deposit="refused"/);
  // Only joined NFTs: nothing is refused, so no note.
  const onlyJoined = renderNfts(store({ prize: pool(), nfts: nfts([{ asset: JOINED, generation: 3, joined: true }]) }));
  assert.doesNotMatch(String(onlyJoined), /data-pass-deposit/);
  assert.equal(button(onlyJoined, JOINED).disabled, false);
  // A pass whose earlier entry the relay reported keeps its right to join (no new fee).
  const prePaid = renderNfts(store({ prize: pool({ pass: { asset: NEW, citizen: 'C', faction: 2, entry: { paid: '25000000' } } }) }));
  assert.equal(button(prePaid, NEW).disabled, false);
  assert.doesNotMatch(String(prePaid), /data-pass-deposit/);
  // A pass reported WITHOUT an entry stays refused.
  const noEntry = renderNfts(store({ prize: pool({ pass: { asset: NEW, citizen: 'C', faction: 2, entry: null } }) }));
  assert.equal(button(noEntry, NEW).disabled, true);
});

test('the note in English: the same refusal wording as the prize screen, no Japanese, no banned word', () => {
  setLang('en');
  const t = text(renderNfts(store({ prize: pool() })));
  assert.match(t, /This season has a prize pool\. Entry fees from a resident NFT are not taken until its refund right is decided/);
  assert.match(t, /NFTs that already joined can still play/);
  assert.doesNotMatch(t, JA);
  assert.doesNotMatch(t, BANNED_EN);
  // Outside a pool season the English card has no refusal.
  assert.doesNotMatch(text(renderNfts(store())), /refund right/);
});
