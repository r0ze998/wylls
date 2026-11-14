// ⑳ A march (Depart) for an NFT player: the page's march path used the Frontier session key, which an NFT Citizen
// does not have, so an NFT player could not march. fresident.marchSubmitFor sends it as act() sends every other
// player instruction: the owner's wallet signs, inside ResidentAct, for the generation read now; a pass that left the
// wallet is refused before anything is signed. A wallet player's march is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { marchSubmitFor } from '../../permutation-server/web/frontier/fresident.mjs';

const W = { address: 'Wa11et1111111111111111111111111111111111111' };
const proof = { policy: 'P', link: 'L', asset: 'NFTasset11111111111111111111111111111111111', resident: 'R' };
const depart = { name: 'Depart', accounts: { a: 1 }, signer: { session: null }, fields: { host_id: 1n } };

function rig({ resident = null, wallet = W, generation = 3 } = {}) {
  const sent = [], asked = [], adopted = [];
  const submit = async req => { sent.push(req); return { ok: true, signature: 'sig' }; };
  const fn = marchSubmitFor({ submit, resident: () => resident, walletNow: () => wallet, generationOf: async (o, a) => { asked.push([o, a]); return generation; }, adopt: g => adopted.push(g) });
  return { fn, sent, asked, adopted };
}

test('a wallet player: the march goes as before (its session key, no resident proof, no read)', async () => {
  const r = rig();
  assert.deepEqual(await r.fn(depart), { ok: true, signature: 'sig' });
  assert.deepEqual(r.sent, [depart]);
  assert.equal(r.asked.length, 0);
});

test('an NFT player: the owner\'s wallet signs inside ResidentAct, for the generation read now', async () => {
  const r = rig({ resident: { asset: proof.asset, generation: 0, proof }, generation: 3 });
  assert.deepEqual(await r.fn(depart), { ok: true, signature: 'sig' });
  assert.deepEqual(r.asked, [[W.address, proof.asset]]);
  assert.deepEqual(r.adopted, [3]);
  assert.equal(r.sent.length, 1);
  assert.deepEqual(r.sent[0].signer, { wallet: W });
  assert.deepEqual(r.sent[0].resident, { generation: 3, proof });
  assert.equal(r.sent[0].name, 'Depart');
  assert.deepEqual(r.sent[0].fields, depart.fields);
});

test('an NFT player whose pass left the wallet (transfer), or with no wallet: refused, nothing signed', async () => {
  const gone = rig({ resident: { asset: proof.asset, generation: 0, proof }, generation: null });
  assert.deepEqual(await gone.fn(depart), { ok: false, code: 'NftNotHeld' });
  assert.equal(gone.sent.length, 0);
  const none = rig({ resident: { asset: proof.asset, generation: 0, proof }, wallet: null });
  assert.deepEqual(await none.fn(depart), { ok: false, code: 'NoWallet' });
  assert.equal(none.sent.length, 0);
});

test('the controller sends marches through it (the normal-world path)', () => {
  const ctl = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
  assert.match(ctl, /sendMarchRetrying\(m, \{[\s\S]{0,700}submit: fresident\.marchSubmitFor\(\{ submit, resident: \(\) => FS\.resident, walletNow: \(\) => wallet\.connected\(\),/);
  const fplay = readFileSync(new URL('../../permutation-server/web/frontier/fplay.mjs', import.meta.url), 'utf8');
  assert.match(fplay, /\} else if \(resident\) \{\n\s*\/\/ ⑳: the player instruction run for an NFT Citizen \(ResidentAct\)/);
});
