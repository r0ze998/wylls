// Run by citizens-social-permission.test.mjs under `node --experimental-permission`:
// the social service starts, writes its files, and cannot read or write anything else.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [repo, aiDir] = process.argv.slice(2);
const { createSocial } = await import(`${repo}/permutation-gateway/citizens/social/routes.mjs`);
const clock = { bell: () => 5, unix: () => 1_800_000_000 };
const social = createSocial({ herald: { me: async () => ({ ok: false, code: 'NotFound' }) }, aiDir, roster: { season: 31 }, clock, season: 31, config: { council: { period: 24, offset: 0, strike_lead: 6 } } });
social.council.open({ faction: 0, period: 1, c0: 5, candidates: [{ option: 1, kind: 'camp', p: 1, q: 1, value: 1, own: 2, ratio: 'favourable' }] });
social.closeBell(5);
const r = await social.routes.dispatch({ method: 'GET', path: '/f/ai/talk' });
const denied = fn => { try { fn(); return 'allowed'; } catch (e) { return e.code; } };
console.log(JSON.stringify({
  status: r.status,
  readKeys: denied(() => readFileSync(join(aiDir, 'keys', 'registrar.json'))),
  readCargo: denied(() => readFileSync(`${repo}/Cargo.toml`)),
  writeKeys: denied(() => { mkdirSync(join(aiDir, 'keys'), { recursive: true }); writeFileSync(join(aiDir, 'keys', 'x'), 'x'); }),
  writeOutside: denied(() => writeFileSync(join(aiDir, 'outside.json'), 'x')),
}));
