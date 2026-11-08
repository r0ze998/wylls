// ⑯: decode the router's /h/province/4,0 bytes (palisade golden) with the page codec; tile 6 passable / site / keep / camp
import { readFileSync } from 'node:fs';
const root = process.argv[2];
const { decode } = await import(`${root}/permutation-server/web/frontier/fcodec.mjs`);
const { fromBase64 } = await import(`${root}/permutation-server/web/sdk/bytes.mjs`);
const g = JSON.parse(readFileSync(`${root}/frontier-node/crates/herald/tests/golden/ws19-map-growth-s1-palisade.json`, 'utf8'));
for (const st of ['grown', 'palisade']) {
  const b = g.stages[st]['/h/province/4,0/latest'].body;
  const pr = decode('Province', fromBase64(b.bytes), { profile: 2, seasonId: Number(g.season) });
  const keys = Object.keys(pr);
  const pick = k => keys.filter(x => new RegExp(k, 'i').test(x));
  const mask = BigInt(pr.passableMask ?? pr.passable ?? 0);
  console.log(st, JSON.stringify({ fields: [...pick('pass'), ...pick('site'), ...pick('keep'), ...pick('camp'), ...pick('struct')],
    tile6passable: ((mask >> 6n) & 1n) === 1n, siteCount: pr.siteCount, sites: pr.sites, keep: pr.keep ?? null, camp: pr.camp ?? null,
    structureEntries: (pr.structures ?? pr.structureEntries ?? null) }, (k, v) => typeof v === 'bigint' ? v.toString() : v));
}
