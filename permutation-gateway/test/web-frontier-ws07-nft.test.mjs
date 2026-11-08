// Workstream 07: workstream 20's NFT choice and first join on the page (web part of dc55f159), connected to the page's
// rules: a list of NFTs that could not be read is not "no NFTs"; a wallet change forgets the NFT played and the list
// and reads the list again; playing an NFT is another viewer (what was read for the wallet's own Citizen goes, its
// key session stays); the away summary keeps an NFT's marks apart from its wallet's. FIXTURE data only: a fake relay
// (globalThis.fetch) and a fake herald; no wallet signs, no key is made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as C from '../../permutation-server/web/frontier/controller.mjs';
import * as io from '../../permutation-server/web/frontier/fchainio.mjs';
import { FS } from '../../permutation-server/web/frontier/fstate.mjs';
import { renderNfts } from '../../permutation-server/web/frontier/screens/join.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { rulesetFor } from '../../permutation-server/web/sdk/frontier/profile.mjs';

const A = 'Wa11et1111111111111111111111111111111111111', B = 'Wa11et2222222222222222222222222222222222222';
const NFT = 'NFTasset11111111111111111111111111111111111';
const text = h => String(h).replace(/<[^>]+>/g, ' ');
const herald = new Proxy({}, { get: () => async () => ({ ok: false, code: 'NotFound' }) });
async function withFS(over, fn) {
  const saved = { ...FS }, fetch0 = globalThis.fetch, relay0 = io.relay();
  try { Object.assign(FS, over); await fn(); } finally {
    globalThis.fetch = fetch0; io.setRelay(relay0); C.useHerald(null);
    for (const k of Object.keys(FS)) if (!(k in saved)) delete FS[k]; Object.assign(FS, saved);
  }
}
const nftSeason = { season: { seasonId: 7n, programVersion: 0x8004, joinGate: [0] }, wallet: { address: A } };

test('the NFT list not read: the card says so — not "no NFT" — and offers nothing from it; read with none: no card', async () => {
  for (const [answer, code] of [[() => ({ ok: false, status: 503, json: async () => ({ code: 'Unavailable' }) }), /\(.+\)/], [() => { throw new TypeError('fetch failed'); }, /\(.+\)/]]) {
    await withFS(nftSeason, async () => {
      io.setRelay('http://relay.test'); globalThis.fetch = async () => answer();
      await C.loadNfts();
      assert.equal(FS.nftsRead.ok, false);
      assert.equal(FS.nfts, null);
      setLang('en');
      const t = text(renderNfts(FS));
      assert.match(t, /The resident NFTs of this wallet could not be loaded \(.+\)\. This does not mean it has none/);
      assert.match(t, code);
      assert.doesNotMatch(String(renderNfts(FS)), /data-act="nft-login"/);
      setLang('ja');
    });
  }
  await withFS(nftSeason, async () => {
    io.setRelay('http://relay.test');
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, residents: [], policy: { residentProgram: '11111111111111111111111111111111' } }) });
    await C.loadNfts();
    assert.deepEqual([FS.nftsRead.ok, FS.nfts.residents.length], [true, 0]);
    assert.equal(String(renderNfts(FS)), '', 'read, and none: nothing to offer');
  });
});

test('an answer for a wallet no longer connected is dropped', async () => {
  await withFS(nftSeason, async () => {
    io.setRelay('http://relay.test');
    globalThis.fetch = async () => { FS.wallet = { address: B }; return { ok: true, status: 200, json: async () => ({ ok: true, residents: [{ asset: NFT, generation: 1, joined: true }], policy: {} }) }; };
    await C.loadNfts();
    assert.equal(FS.nfts, null);
    assert.equal(FS.nftsRead, null);
  });
});

test('a wallet change forgets the NFT played and the list; NFT login and logout are another viewer, the key session kept', async () => {
  await withFS({ ...nftSeason, resident: { asset: NFT }, nfts: { residents: [{ asset: NFT }] }, nftsRead: { ok: true }, citizen: { faction: 1 }, holdings: [{ p: 0, q: 0 }], session: { publicKey: 'S' }, marches: [1] }, async () => {
    assert.equal(C.adoptConnectedWallet({ address: B }), true);
    assert.deepEqual([FS.resident, FS.nfts, FS.nftsRead, FS.citizen, FS.session], [null, null, null, null, null]);
  });
  await withFS({ ...nftSeason, mode: 'play', clock: null, resident: { asset: NFT, citizen: 'C' }, citizen: { faction: 1 }, holdings: [{ p: 0, q: 0 }], marches: [1], book: [1], session: { publicKey: 'S' }, prize: { pool: 1 } }, async () => {
    C.useHerald(herald);
    await C.ACTIONS['nft-logout']();
    assert.equal(FS.resident, null);
    assert.deepEqual([FS.citizen, FS.holdings, FS.marches, FS.book], [null, [], [], []], "the NFT's Citizen, villages and marches are not shown as the wallet's");
    assert.deepEqual([FS.session, FS.prize], [{ publicKey: 'S' }, { pool: 1 }], "the wallet's own key session and prize stay");
  });
});

test('the march book of an NFT resident is not its wallet\'s (the sealed marches and their reveal material kept apart)', async () => {
  await withFS({ wallet: { address: A }, resident: null }, async () => {
    const V = JSON.parse(readFileSync(new URL('./fixtures/s1-addresses-v1.json', import.meta.url), 'utf8'));
    io.setPin({ programId: V.program, cluster: 'localnet', seasonId: V.seasonId, rulesetHash: rulesetFor(3) });
    const own = C.bookKey();
    FS.resident = { asset: NFT };
    const nft = C.bookKey();
    assert.ok(own && nft && own !== nft, `${own} / ${nft}`);
    assert.ok(nft.includes(NFT));
  });
});

test('the away summary keeps an NFT\'s marks apart from its wallet\'s (app.mjs awayWho); the words name the NFT too', () => {
  const app = readFileSync(new URL('../../permutation-server/web/frontier/app.mjs', import.meta.url), 'utf8');
  assert.match(app, /const awayWho = \(\) => \(\{[^\n]*FS\.resident\?\.asset \? `\$\{FS\.wallet\.address\}#nft:\$\{FS\.resident\.asset\}`/);
  const words = readFileSync(new URL('../../permutation-server/web/frontier/hud/returnwords.mjs', import.meta.url), 'utf8');
  assert.match(words, /前に使ったウォレット（または住民NFT）とは別です/);
});
