// ⑯ pure probe (2026-11-09) of ⑧'s growth-route fixture Season/Frontier bytes: sizes, and whether every field of
// the MC_LOCAL_7D preset's conquest block survives `upper()` + the SDK encoder (decoded back with the SDK). No key,
// no network. Usage: node v16-ws08-season-bytes.mjs <worktree>
const root = process.argv[2];
const G = await import(`${root}/permutation-gateway/test/fixtures/frontier/growth-route.mjs`);
const C = await import(`${root}/permutation-server/web/sdk/frontier/codec.mjs`);
const { PRESETS } = await import(`${root}/permutation-server/web/sdk/frontier/abi-v2-presets.mjs`);
const MC7 = PRESETS.presets.find(p => p.name === 'MC_LOCAL_7D').fields;
const s = G.seasonBytes(), f = G.frontierBytes('grown');
const dec = C.decodeAccount('Season', s, { profile: 2 });
const cq = Array.isArray(dec.CONQUEST_PARAMS) ? dec.CONQUEST_PARAMS[0] : dec.CONQUEST_PARAMS;
const want = { ...MC7.conquest, r_max_ceiling: G.CEILING, placement: 0, continuous: 0 };
const norm = v => (typeof v === 'bigint' ? String(v) : Array.isArray(v) || ArrayBuffer.isView(v) ? Array.from(v).map(String).join(',') : String(v));
const missing = [], differ = [];
for (const [k, v] of Object.entries(want)) {
  const K = k.toUpperCase();
  if (!cq || !(K in cq)) { missing.push(K); continue; }
  if (norm(cq[K]) !== norm(v)) differ.push(`${K}: preset ${norm(v)} vs bytes ${norm(cq[K])}`);
}
const extra = cq ? Object.keys(cq).filter(K => !(K.toLowerCase() in want)) : [];
console.log(JSON.stringify({ seasonLen: s.length, frontierLen: f.length, layout: dec.LAYOUT_VERSION, programVersion: dec.PROGRAM_VERSION, genesisRing: dec.GENESIS_RING, rMax: dec.R_MAX,
  conquestFieldsInPreset: Object.keys(want).length, conquestFieldsInLayout: cq ? Object.keys(cq).length : 0, missingInLayout: missing, differing: differ, layoutFieldsNotInPreset: extra }, null, 1));
