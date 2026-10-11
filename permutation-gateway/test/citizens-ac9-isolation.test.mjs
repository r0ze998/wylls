// AC9: the tools (injection suite, report, A/B, probe, scenario, G11) stay outside what the citizens service may read, no service module
// imports them, they name no outside address and no paid-API variable (G10 grep, applied to this unit's files), and they bind nothing
// outside 41901-41999 / port 0.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readList } from '../citizens/mind/permissions.mjs';

const REPO = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const CIT = join(REPO, 'permutation-gateway/citizens');
const TOOLS = ['injection', 'ab', 'probe', 'scenario'];
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const mine = [...TOOLS.flatMap((t) => walk(join(CIT, t))), join(CIT, 'report.mjs'), join(CIT, 'persona/g11.mjs'), join(CIT, 'persona/fixture-world.mjs')].filter((f) => /\.mjs$/.test(f));

test('the service\'s read list holds none of the AC9 tool directories or report.mjs (T-K2 stays as AC1a pinned it)', () => {
  const reads = readList({ repoRoot: REPO, aiDir: '/private/tmp/ac9-flags/ai' });
  for (const t of TOOLS) assert.equal(reads.some((r) => relative(CIT, r).split('/')[0] === t), false, t);
  assert.equal(reads.some((r) => r.endsWith('citizens/report.mjs')), false);
  assert.ok(reads.some((r) => r.endsWith('citizens/persona')), 'persona/ is listed: g11.mjs and fixture-world.mjs there may import only listed code');
});

test('no module of the service imports an AC9 tool', () => {
  const service = ['server.mjs', 'serve.mjs', 'mind', 'memory', 'persona', 'social', 'watcher', 'prompts', 'config'].map((p) => join(CIT, p));
  const files = service.flatMap((p) => { try { return statSync(p).isDirectory() ? walk(p) : [p]; } catch { return []; } }).filter((f) => /\.mjs$/.test(f) && !/persona\/(g11|fixture-world)\.mjs$/.test(f));
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    assert.equal(/from\s*['"]\.{1,2}\/(?:\.\.\/)*(?:injection|ab|probe|scenario)\//.test(src) || /from\s*['"]\.{1,2}\/report\.mjs['"]/.test(src), false, relative(CIT, f));
  }
  // g11.mjs and fixture-world.mjs sit in a listed directory: their relative imports stay inside the listed set
  for (const f of ['persona/g11.mjs', 'persona/fixture-world.mjs']) {
    for (const m of readFileSync(join(CIT, f), 'utf8').matchAll(/from\s*['"](\.[^'"]+)['"]/g)) {
      const target = join(CIT, 'persona', m[1]);
      const top = relative(CIT, target).split('/')[0];
      assert.ok(!TOOLS.includes(top) && top !== 'report.mjs' && !top.startsWith('..') || /permutation-server\/web\/frontier\/council\//.test(target), `${f} imports ${m[1]}`);
    }
  }
});

test('G10 grep over this unit\'s files: no outside URL, no paid-API name, no public-network word', () => {
  for (const f of mine) {
    const src = readFileSync(f, 'utf8');
    assert.equal(/anthropic|openai|devnet/i.test(src), false, `${relative(CIT, f)}: a word the G10 grep bans`);
    const urls = [...src.matchAll(/https?:\/\/(?!127\.0\.0\.1|\[::1\]|localhost)[^\s'"`)]+/gi)].map((m) => m[0]);
    assert.deepEqual(urls, [], `${relative(CIT, f)}: a non-loopback URL`);
  }
});

test('the tools hold no key: no seed or secret read except the seat key file the A/B seat script is given, and it never prints it', () => {
  for (const f of mine) {
    const src = readFileSync(f, 'utf8');
    if (/ab\/seat\.mjs$/.test(f)) { assert.ok(/--key-file/.test(src) && /session_keypair_b58/.test(src)); continue; }
    assert.equal(/session_keypair_b58|wallet_keypair_b58|bot_seed|\.local\/frontier\/runs/.test(src.replace(/\/\/.*$/gm, '')), false, `${relative(CIT, f)}: reads key material`);
  }
});
