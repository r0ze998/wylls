// ⑯: the kernel's own answers for the palisade case, printed (not pinned): free / blocked route, and the earliest bell
import { readFileSync } from 'node:fs';
const root = process.argv[2], W = `${root}/permutation-server/web`;
const { planRoute, earliestBell, arrivalWindow } = await import(`${W}/frontier/fmarch.mjs`);
const Wasm = await import(`${W}/frontier/wasm.mjs`);
const { kernelFile } = await import(`${W}/frontier/fconquest.mjs`);
const { tileHex } = await import(`${W}/frontier/fgeo.mjs`);
const { PRESETS } = await import(`${W}/sdk/frontier/abi-v2-presets.mjs`);
const file = kernelFile({ layoutVersion: 2, programVersion: 4 });
const bytes = readFileSync(`${W}/frontier/wasm/${file}`);
const sha = readFileSync(`${W}/frontier/wasm/${file}.sha256`, 'utf8').trim().split(/\s+/)[0];
const k = await Wasm.loadKernel({ url: file, sha256Hex: sha, ruleset: PRESETS.ruleset_hash_v3, fetch: async () => ({ ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) }) });
const g = JSON.parse(readFileSync(`${root}/frontier-node/crates/herald/tests/golden/ws19-map-growth-s1-palisade.json`, 'utf8'));
const rec = g.stages.palisade['/h/season'].body, seeds = rec.rings.map(r => ({ ring: r.d, seed: r.seed }));
const from = { p: 4, q: 0, tile: 0 }, to = { p: 5, q: 0, tile: 0 }, hex = tileHex(4, 0, 6);
const sm = r => r.ok ? { dirs: [...r.route.dirs], secs: r.route.secs, hexes: r.route.hexes } : r;
const free = planRoute(k, { from, to, unit: 0, seeds }), blk = planRoute(k, { from, to, unit: 0, seeds, blocked: [hex] });
// every single-hex block on the free route: does the kernel always answer, and with what length
const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
let { q, r } = tileHex(4, 0, 0); const walk = free.route.dirs.map(d => { q += DIRS[d][0]; r += DIRS[d][1]; return { q, r }; });
const alt = walk.slice(0, -1).map(h => { const x = planRoute(k, { from, to, unit: 0, seeds, blocked: [h] }); return `${h.q},${h.r}:${x.ok ? x.route.secs + 's/' + x.route.dirs.length : x.code}`; });
const genesisTs = Number(rec.genesisTs ?? rec.genesis_ts ?? 0);
let early = null; try { early = earliestBell(k, { genesisTs, departTs: genesisTs + 300, secs: blk.route.secs }); } catch (e) { early = 'n/a: ' + e.message; }
console.log(JSON.stringify({ hex, free: sm(free), blocked: sm(blk), altBlocks: alt, earliestBellFromBell0: early, lead: [rec.minLead, rec.maxLead] }));
