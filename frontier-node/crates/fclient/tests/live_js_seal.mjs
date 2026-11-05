// The browser's own seal modules (permutation-server/web/frontier) driven
// from node by tests/live_drand.rs: no copy of the sealing code.
//
//   node live_js_seal.mjs seal <genesisTs> <arriveBell> <hostId>
//     → {"ok":true,"seal":hex,"commit":hex,"salt":hex,"round":n,"plain":hex}
//   node live_js_seal.mjs open <sealHex> <sigHex>
//     → {"ok":true,"plain":hex,"commit":hex} | {"ok":false,"code":...}
//
// The beacon is pinned exactly as the page pins it (seal.mjs checkBeacon,
// quicknet, cluster "mainnet-beta" so the test key is refused).
import { checkBeacon, encodePath, pack, sealMarch } from '../../../../permutation-server/web/frontier/seal.mjs';
import { openSeal } from '../../../../permutation-server/web/frontier/seal-worker.mjs';
import { QUICKNET } from '../../../../permutation-server/web/frontier/abi.mjs';

const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const [mode, ...a] = process.argv.slice(2);

if (mode === 'seal') {
  const [genesisTs, arriveBell, hostId] = [Number(a[0]), Number(a[1]), BigInt(a[2])];
  const drand = { publicKey: QUICKNET.publicKey, chainHash: QUICKNET.chainHash, period: QUICKNET.period, genesis: QUICKNET.genesis };
  const pin = checkBeacon({ drand, seasonPkHash: QUICKNET.pkHash, cluster: 'mainnet-beta', seasonNetwork: 2 });
  if (!pin.ok) { console.log(JSON.stringify(pin)); process.exit(1); }
  const { pathLen, path } = encodePath([0, 1, 2]);
  const plain = pack({ version: 1, hostId, arriveBell, destP: 4, destQ: -2, destTile: 17, stance: 1, retreatBps: 2500, pathLen, path });
  const clock = { genesisTs, drand: { genesis: QUICKNET.genesis, period: QUICKNET.period } };
  const r = await sealMarch({ plain, clock, publicKey: pin.publicKey, hostId, arriveBell }, { inline: true });
  if (!r.ok) { console.log(JSON.stringify(r)); process.exit(1); }
  console.log(JSON.stringify({ ok: true, seal: hex(r.seal), commit: hex(r.commit), salt: hex(r.salt), round: r.round, plain: hex(plain) }));
} else if (mode === 'open') {
  try {
    const o = openSeal(a[0], a[1]);
    console.log(JSON.stringify({ ok: true, plain: hex(o.plain), commit: hex(o.commit) }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, code: e.code ?? 'Error', error: String(e.message ?? e) }));
  }
} else {
  console.error('usage: live_js_seal.mjs seal|open …');
  process.exit(2);
}
