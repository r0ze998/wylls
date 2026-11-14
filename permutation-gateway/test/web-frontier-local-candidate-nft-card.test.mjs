// The NFT card in local play on the LOCAL TEST CANDIDATE lane (screens/join.mjs renderLocalCandidateNfts, shown first
// on the village screen): pure render checks over a mock FS. Everywhere else the card is '' and the village screen is
// what it was. No network, no chain, no key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderLocalCandidateNfts } from '../../permutation-server/web/frontier/screens/join.mjs';
import { LOCAL_LANE_PROGRAMS } from '../../permutation-server/web/frontier/flocallanes.mjs';

const CAND = LOCAL_LANE_PROGRAMS.conquestNftCandidate, CONQ = LOCAL_LANE_PROGRAMS.conquest;
const W = 'B7yQBg4KBnypKx7TQRSaZFDD17hfhry5JN51dmz88rX3', ASSET = '68qTstPmwfaDbt1a9hnq7XeyZ4zJBqBKU1esRtQXnKWj';
const POLICY = { coreProgram: W, residentProgram: W, collection: W, guardAuthority: W };
const fsOf = over => ({ localPlay: { programId: CAND, address: W }, wallet: { address: W }, season: { programVersion: 0xc804 }, nfts: null, nftsRead: { ok: true }, resident: null, joinDraft: null, ...over });
const s = x => String(x);

test('outside the candidate lane\'s local play the card is empty (the village screen is unchanged)', () => {
  assert.equal(renderLocalCandidateNfts(fsOf({ localPlay: null })), '');
  assert.equal(renderLocalCandidateNfts(fsOf({ localPlay: { programId: CONQ, address: W } })), '');
  assert.equal(renderLocalCandidateNfts(fsOf({ wallet: null })), '');
  assert.equal(renderLocalCandidateNfts(fsOf({ nfts: null })), '', 'no policy read yet: nothing');
});

test('a wallet without a pass: the card offers the re-read (a pass transferred to it), no login', () => {
  const h = s(renderLocalCandidateNfts(fsOf({ nfts: { residents: [], policy: POLICY, mint: null } })));
  assert.match(h, /data-act="nft-reload"/); assert.doesNotMatch(h, /data-act="nft-login"/);
});

test('a pass not joined yet: the nation choice, and the login only after a nation is chosen', () => {
  const nfts = { residents: [{ asset: ASSET, generation: 0, joined: false }], policy: POLICY, mint: null };
  const before = s(renderLocalCandidateNfts(fsOf({ nfts })));
  assert.match(before, /data-local-nft="nations"/); assert.match(before, /data-act="pick-faction"/);
  assert.match(before, /data-act="nft-login" data-asset="[^"]+" disabled/);
  const after = s(renderLocalCandidateNfts(fsOf({ nfts, joinDraft: { faction: 2 } })));
  assert.match(after, /data-act="nft-login" data-asset="[^"]+" >/); assert.match(after, /aria-pressed="true"/);
});

test('a pass already joined: play it (no nation choice); playing it: the way back to the wallet\'s own Citizen', () => {
  const nfts = { residents: [{ asset: ASSET, generation: 1, joined: true }], policy: POLICY, mint: null };
  const joined = s(renderLocalCandidateNfts(fsOf({ nfts })));
  assert.match(joined, /data-act="nft-login"/); assert.doesNotMatch(joined, /data-local-nft="nations"/);
  const playing = s(renderLocalCandidateNfts(fsOf({ nfts, resident: { asset: ASSET } })));
  assert.match(playing, /data-act="nft-logout"/); assert.doesNotMatch(playing, /data-act="nft-login"/);
});
