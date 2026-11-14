// ⑳ From the game's join screen to the mint page, in a local NFT test world: the relay's `--mint-url`
// (localnet, loopback http only), `GET /f/residents` carrying it, the page keeping only an http(s) link,
// and the join card for a wallet that holds no pass (with "check again", which reads the list anew).
// Pages and pure modules only (no npm dependency, no chain).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as C from '../../permutation-server/web/frontier/controller.mjs';
import * as io from '../../permutation-server/web/frontier/fchainio.mjs';
import { FS } from '../../permutation-server/web/frontier/fstate.mjs';
import { mintLink } from '../../permutation-server/web/frontier/fresident.mjs';
import { renderNfts } from '../../permutation-server/web/frontier/screens/join.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { mintUrlProblem } from '../src/frontier/mint-link.mjs';

const A = 'Wa11et1111111111111111111111111111111111111';
const MINT = 'http://127.0.0.1:41990/web/mint.html';
const text = h => String(h).replace(/<[^>]+>/g, ' ');
const BANNED_EN = /\bbell \d|\bsecret|beacon|\bsettle[ds]?\b|settlement|\bseed\b|site ticket|keeper|lamport/i;
async function withFS(over, fn) {
  const saved = { ...FS }, fetch0 = globalThis.fetch, relay0 = io.relay();
  try { Object.assign(FS, over); await fn(); } finally {
    globalThis.fetch = fetch0; io.setRelay(relay0); setLang('ja');
    for (const k of Object.keys(FS)) if (!(k in saved)) delete FS[k]; Object.assign(FS, saved);
  }
}
const nftSeason = { season: { seasonId: 7n, programVersion: 0x8004, joinGate: [0] }, wallet: { address: A } };
const answer = body => async () => ({ ok: true, status: 200, json: async () => body });

test('the relay\'s --mint-url: unset is fine; only on localnet, only a loopback http page, no credentials', () => {
  assert.equal(mintUrlProblem(null, 'devnet'), null);
  assert.equal(mintUrlProblem(undefined, 'mainnet'), null);
  assert.equal(mintUrlProblem(MINT, 'localnet'), null);
  assert.equal(mintUrlProblem('http://localhost:41990/web/mint.html', 'localnet'), null);
  assert.match(mintUrlProblem(MINT, 'devnet'), /localnet test worlds only/);
  assert.match(mintUrlProblem(MINT, 'mainnet'), /localnet test worlds only/);
  assert.match(mintUrlProblem('https://wylls.example/mint', 'localnet'), /loopback http page only/);
  assert.match(mintUrlProblem('http://10.0.0.2/mint', 'localnet'), /loopback http page only/);
  assert.match(mintUrlProblem('http://u:p@127.0.0.1/mint', 'localnet'), /no credentials/);
  assert.match(mintUrlProblem('not a url', 'localnet'), /not a URL/);
  const cfg = readFileSync(new URL('../src/frontier/config.mjs', import.meta.url), 'utf8');
  assert.match(cfg, /mintUrl: pick\('mint-url', 'FRONTIER_MINT_URL', d\.mintUrl\)/);
  assert.match(cfg, /const p = mintUrlProblem\(cfg\.mintUrl, cfg\.cluster\); if \(p\) out\.push\(p\);/);
  const route = readFileSync(new URL('../src/frontier/routes/residents.mjs', import.meta.url), 'utf8');
  assert.match(route, /mint: ctx\.cfg\?\.mintUrl \?\? null/);
});

test('the page keeps only an http(s) link without credentials', () => {
  assert.equal(mintLink(MINT), MINT);
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'http://u:p@127.0.0.1/', 42, null, undefined, 'nope']) assert.equal(mintLink(bad), null, String(bad));
});

test('no pass in an NFT world with a mint page: the card links to it (ja and en) and "check again" reads the list anew', async () => {
  await withFS(nftSeason, async () => {
    io.setRelay('http://relay.test');
    let calls = 0;
    globalThis.fetch = async (...a) => { calls++; return answer({ ok: true, residents: [], policy: { residentProgram: '11111111111111111111111111111111' }, mint: MINT })(...a); };
    await C.loadNfts();
    assert.equal(FS.nfts.mint, MINT);
    const ja = String(renderNfts(FS));
    assert.match(ja, new RegExp(`href="${MINT.replace(/[.]/g, '\\.')}" target="_blank" rel="noopener noreferrer"`));
    assert.match(text(ja), /住民NFT（参加パス）を持っていません/);
    assert.match(ja, /data-act="nft-reload"/);
    assert.doesNotMatch(ja, /data-act="nft-login"/);
    setLang('en');
    const en = text(renderNfts(FS));
    assert.match(en, /This wallet holds no resident NFT \(entry pass\)\. Get one on the mint page, then join with it here\./);
    assert.match(en, /Open the mint page/);
    assert.match(en, /I got one: check again/);
    assert.doesNotMatch(en, BANNED_EN);
    // "check again" after minting: the relay now lists the pass; the card offers it.
    globalThis.fetch = answer({ ok: true, residents: [{ asset: 'NFTasset11111111111111111111111111111111111', generation: 0, joined: false }], policy: { residentProgram: '11111111111111111111111111111111' }, mint: MINT });
    await C.ACTIONS['nft-reload']();
    assert.equal(FS.nfts.residents.length, 1);
    assert.match(String(renderNfts(FS)), /data-act="nft-login"/);
    assert.ok(calls >= 1);
  });
});

test('no mint page configured, or a bad link: nothing new is shown (the earlier behaviour)', async () => {
  for (const mint of [undefined, null, 'javascript:alert(1)']) {
    await withFS(nftSeason, async () => {
      io.setRelay('http://relay.test');
      globalThis.fetch = answer({ ok: true, residents: [], policy: { residentProgram: '11111111111111111111111111111111' }, mint });
      await C.loadNfts();
      assert.equal(String(renderNfts(FS)), '', String(mint));
    });
  }
});

test('boot: a wallet reconnected silently is adopted without the wallet sync, so the NFT list is read once the season is known', () => {
  const ctl = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
  const boot = ctl.slice(ctl.indexOf('// A silent reconnect of the wallet used last time'));
  const silent = boot.indexOf('adoptConnectedWallet(c);');
  const firstRefresh = boot.indexOf('await refresh();');
  const read = boot.indexOf("if (FS.wallet && !localPlay && FS.nftsRead === null) await loadNfts()");
  const ready = boot.indexOf('walletEventsReady = true;');
  assert.ok(silent > 0 && firstRefresh > silent && read > firstRefresh && ready > read, 'silent adopt → season read → NFT list → wallet events');
  // loadNfts itself still asks nothing outside an NFT season (the 0x8000 gate is unchanged).
  assert.match(ctl, /if \(!FS\.wallet \|\| !io\.relay\(\) \|\| !\(Number\(FS\.season\?\.programVersion \?\? 0\) & 0x8000\)\) return;/);
});
