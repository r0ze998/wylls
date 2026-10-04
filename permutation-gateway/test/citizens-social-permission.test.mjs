// AC4: the social service under Node's permission model (contract §1.3 C1, T-K2
// in spirit): it loads and runs with read access to its own directory, the web
// files it imports and AI_DIR/pub and AI_DIR/state, and write access to AI_DIR/pub and AI_DIR/state
// only; it cannot read KEYS or the repository, nor write outside.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpAiDir } from './fixtures/ai-social-kit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');

test('the social service runs under --experimental-permission with the read list the integrator needs', () => {
  const ai = tmpAiDir('ai-social-perm-');
  mkdirSync(ai.pub, { recursive: true });
  mkdirSync(ai.state, { recursive: true });
  const web = join(repo, 'permutation-server', 'web');
  const script = join(here, 'fixtures', 'ai-social-perm-run.mjs');
  const args = [
    '--experimental-permission',
    `--allow-fs-read=${join(repo, 'permutation-gateway', 'citizens', 'social')}`,
    `--allow-fs-read=${join(web, 'frontier', 'council')}`,
    `--allow-fs-read=${join(web, 'frontier', 'people')}`,
    `--allow-fs-read=${join(web, 'lang.mjs')}`,
    `--allow-fs-read=${join(web, 'util.mjs')}`,
    `--allow-fs-read=${join(web, 'lang')}`,
    `--allow-fs-read=${ai.pub}`,
    `--allow-fs-read=${ai.state}`,
    `--allow-fs-read=${script}`,
    `--allow-fs-write=${ai.pub}`,
    `--allow-fs-write=${ai.state}`,
    script, repo, ai.dir,
  ];
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
  try {
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.equal(out.status, 200);
    assert.equal(out.readKeys, 'ERR_ACCESS_DENIED');
    assert.equal(out.readCargo, 'ERR_ACCESS_DENIED');
    assert.equal(out.writeKeys, 'ERR_ACCESS_DENIED');
    assert.equal(out.writeOutside, 'ERR_ACCESS_DENIED');
    assert.ok(existsSync(join(ai.pub, 'talk', '5.json')));
    assert.ok(existsSync(join(ai.pub, 'council', '1-0.json')));
    assert.ok(existsSync(join(ai.state, 'social', 'council.jsonl')));
  } finally {
    ai.dispose();
  }
});
